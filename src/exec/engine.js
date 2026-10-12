// The live/paper trading engine.
//
// Loop (every pollSeconds):
//   1. pull mids → mark positions, update the account guard (daily loss / drawdown)
//   2. kill switch (state/KILL file) or guard breach → flatten everything
//   3. intrabar: for open pairs, re-check the stop on live mids (needs two polls
//      in a row so a single wick can't stop us out)
//   4. on each new closed candle: update the model, run the strategy, execute intents
//   5. hourly: refresh funding / volume; paper mode charges funding
//   6. persist state, publish status for the dashboard
//
// The model and strategy are the same objects the backtester uses.

import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { PairModel } from "../core/model.js";
import { PairStrategy } from "../core/strategy.js";
import { planPosition, AccountGuard } from "../core/risk.js";
import { sessionCheck, nextEvents } from "../core/sessions.js";
import { HyperliquidInfo, marketsFor, loadPairHL, dexOf, MAINNET, TESTNET } from "../data/hyperliquid.js";
import { PaperBroker } from "./paper-broker.js";
import { HyperliquidBroker } from "./hl-broker.js";

const STEP = { "5m": 3e5, "15m": 9e5, "1h": 36e5, "4h": 144e5 };
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export class Engine {
  constructor({ cfg, pairs, mode = "paper", interval = "1h", equity = 10_000, pollSeconds = 20, stateDir = "state", port = 8787, testnet = false, env = process.env, log, info, autoLoop = true, resetHalt = false }) {
    this.resetHalt = resetHalt;
    this.injectedInfo = info;
    this.autoLoop = autoLoop;
    this.cfg = cfg;
    this.mode = mode;
    this.interval = interval;
    this.step = STEP[interval];
    if (!this.step) throw new Error(`interval ${interval} not supported`);
    this.pollMs = pollSeconds * 1000;
    this.stateDir = stateDir;
    this.port = port;
    this.testnet = testnet;
    this.env = env;
    this.paperEquity = equity;
    this.pairs = pairs.map((p) => ({ ...p, id: `${p.a}/${p.b}` }));
    this.logLines = [];
    this.log = log || ((m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); this.logLines.push(line); if (this.logLines.length > 300) this.logLines.shift(); appendFile(join(this.stateDir, "engine.log"), line + "\n").catch(() => {}); });
    this.trades = [];
    this.running = false;
  }

  // ---------------------------------------------------------------- startup
  async start() {
    await mkdir(this.stateDir, { recursive: true });
    this.info = this.injectedInfo || new HyperliquidInfo({ baseUrl: this.testnet ? TESTNET : MAINNET });
    const coins = this.pairs.flatMap((p) => [p.hlA, p.hlB]);
    this.markets = await marketsFor(this.info, coins);
    for (const c of coins) if (!this.markets[c]) throw new Error(`Hyperliquid has no perp named "${c}" — check config/universe.json`);

    const saved = await this.loadState();
    if (this.mode === "paper") this.broker = new PaperBroker({ equity: this.paperEquity, fee: this.cfg.costs.takerFee, makerFee: this.cfg.costs.makerFee, slippage: this.cfg.costs.slippage, state: saved?.paper });
    else this.broker = new HyperliquidBroker({ info: this.info, account: this.env.HL_ACCOUNT, agentKey: this.env.HL_AGENT_KEY, testnet: this.testnet, leverage: this.cfg.exchange?.leverage ?? 5, slippage: this.cfg.exchange?.slippage ?? 0.005, maxSlippage: this.cfg.exchange?.maxSlippage ?? 0.015, log: this.log });
    await this.broker.init(this.markets);
    await this.refreshMids();

    this.guard = new AccountGuard(this.cfg.risk);
    if (saved?.guard) Object.assign(this.guard, saved.guard);
    if (this.resetHalt) { this.guard.reset(); this.log("drawdown halt reset by operator (--reset-halt)"); }
    this.trades = saved?.trades || [];

    for (const p of this.pairs) await this.warm(p, saved?.pairs?.[p.id]);
    await this.reconcile();
    this.log(`engine started: ${this.mode}${this.testnet ? " (testnet)" : ""}, ${this.interval} bars, pairs ${this.pairs.map((p) => p.id).join(", ")}`);
    this.startServer();
    this.running = true;
    if (this.autoLoop) this.loop();
  }

  async warm(p, saved) {
    const mc = { ...this.cfg.model, ...(p.set?.model || {}) };
    p.model = new PairModel(mc);
    p.strategy = new PairStrategy({ ...this.cfg, ...(p.set || {}) });
    const need = Math.max(mc.formationBars, mc.longFormationBars) + 120;
    const now = Date.now();
    const bars = await loadPairHL(this.info, p.hlA, p.hlB, this.interval, now - need * this.step, now);
    const closed = bars.filter((b) => b.t + this.step <= now);
    for (const b of closed) p.snap = p.model.update(b);
    p.lastBarT = closed.length ? closed[closed.length - 1].t : now - this.step;
    p.barIndex = closed.length;
    if (closed.length < mc.formationBars) this.log(`${p.id}: only ${closed.length} bars of history on Hyperliquid (need ${mc.formationBars}) — will wait`);
    if (saved?.pos) {
      p.strategy.pos = saved.pos;
      p.strategy.cooldown = saved.cooldown || p.strategy.cooldown;
      p.plan = saved.plan;
      p.fundingPaid = saved.fundingPaid || 0;
      // Saved bar indices are relative to the old process; shift them to the new one.
      const shift = p.barIndex - (saved.barIndex ?? p.barIndex);
      p.strategy.pos.openedBar += shift;
      p.strategy.pos.lastAddBar += shift;
      this.log(`${p.id}: restored open position (dir ${saved.pos.dir > 0 ? "long" : "short"} spread, ${(saved.pos.filledWeight * 100).toFixed(0)}% of plan)`);
    }
    p.strategy.bar = p.barIndex;
  }

  /** Compare what the exchange holds with what the engine thinks it holds. */
  async reconcile() {
    const pos = await this.broker.positions();
    const owned = new Set();
    for (const p of this.pairs) {
      const has = pos[p.hlA]?.szi || pos[p.hlB]?.szi;
      if (p.strategy.pos && !has) { this.log(`${p.id}: engine thought a position was open but the exchange shows none — clearing`); p.strategy.pos = null; p.plan = null; }
      if (!p.strategy.pos && has) this.log(`${p.id}: exchange holds ${p.hlA}/${p.hlB} positions the engine didn't open — leaving them alone and blocking new entries on this pair`);
      p.foreign = !p.strategy.pos && !!has;
      owned.add(p.hlA); owned.add(p.hlB);
    }
    for (const c of Object.keys(pos)) if (!owned.has(c)) this.log(`note: unmanaged position in ${c} (counted in equity, ignored by the engine)`);
    this.positions = pos;
  }

  // ---------------------------------------------------------------- loop
  async loop() {
    while (this.running) {
      const t0 = Date.now();
      try { await this.tick(); } catch (e) { this.log(`tick error: ${e.stack || e.message}`); }
      await new Promise((r) => setTimeout(r, Math.max(1000, this.pollMs - (Date.now() - t0))));
    }
  }

  async refreshMids() {
    const mids = {};
    const dexes = [...new Set(this.pairs.flatMap((p) => [dexOf(p.hlA), dexOf(p.hlB)]))];
    for (const dex of dexes) {
      const m = await this.info.allMids(dex);
      for (const [k, v] of Object.entries(m)) mids[k] = +v;
    }
    this.mids = mids;
    this.broker.setMids(mids);
  }

  async tick() {
    const now = Date.now();
    await this.refreshMids();
    this.positions = await this.broker.positions();
    const equity = await this.broker.equity();
    this.equity = equity;
    const openCount = this.pairs.filter((p) => p.strategy.pos).length;
    this.guard.openPairs = openCount;
    const g = this.guard.update(now, equity, this.pairs[0]?.barIndex ?? 0);

    // Hourly upkeep: funding/volume refresh; paper funding.
    const hour = Math.floor(now / 3600_000);
    if (hour !== this.lastHour) {
      if (this.lastHour != null) {
        this.markets = { ...this.markets, ...(await marketsFor(this.info, this.pairs.flatMap((p) => [p.hlA, p.hlB]))) };
        if (this.broker.applyFunding) {
          const rates = Object.fromEntries(Object.entries(this.markets).map(([c, m]) => [c, m.funding]));
          const paid = this.broker.applyFunding(rates);
          for (const p of this.pairs) if (p.strategy.pos) p.fundingPaid = (p.fundingPaid || 0) + this.pairFunding(p, rates);
          if (paid) this.log(`paper funding settled: ${paid >= 0 ? "+" : ""}${paid.toFixed(2)}`);
        }
      }
      this.lastHour = hour;
    }

    if (await this.killed()) return this.flattenAll("KILL file present");
    if (g.flattenAll && openCount) return this.flattenAll(this.guard.halted ? this.guard.haltReason : "daily loss limit hit");

    for (const p of this.pairs) {
      if (p.closing) { await this.closePair(p, p.closing); continue; }
      if (p.strategy.pos) await this.intrabarCheck(p);
      if (now >= p.lastBarT + 2 * this.step + 5000) await this.onNewBars(p, now);
    }
    await this.saveState();
  }

  pairFunding(p, rates) {
    let f = 0;
    for (const coin of [p.hlA, p.hlB]) { const pos = this.positions[coin]; if (pos) f -= pos.szi * this.mids[coin] * (rates[coin] || 0); }
    return f / (p.plan?.notionalA || 1);
  }

  pairPnl(p) {
    let u = 0;
    for (const coin of [p.hlA, p.hlB]) { const pos = this.positions[coin]; if (pos) u += pos.szi * ((this.mids[coin] ?? pos.entryPx) - pos.entryPx); }
    return u;
  }

  async intrabarCheck(p) {
    const pa = this.mids[p.hlA], pb = this.mids[p.hlB];
    if (!pa || !pb) return;
    const zF = p.strategy.frozenZ({ pa, pb });
    const toward = -p.strategy.pos.dir * zF;
    const stopZ = p.strategy.cfg.exit.stopZ;
    const pnlFrac = p.plan ? this.pairPnl(p) / p.plan.maxLoss : 0;
    const breach = toward >= stopZ || pnlFrac <= -p.strategy.cfg.exit.dollarStopR;
    p.breachCount = breach ? (p.breachCount || 0) + 1 : 0;
    p.live = { zFrozen: zF, pnl: this.pairPnl(p), pnlFrac };
    if (p.breachCount >= 2) {
      this.log(`${p.id}: intrabar stop (frozen z ${zF.toFixed(2)}, PnL ${(pnlFrac).toFixed(2)}R)`);
      p.strategy.cooldown[p.strategy.pos.dir] = p.barIndex + p.strategy.cfg.entry.cooldownBarsAfterStop;
      await this.closePair(p, `intrabar stop: frozen z ${zF.toFixed(2)}`);
    }
  }

  async onNewBars(p, now) {
    const bars = await loadPairHL(this.info, p.hlA, p.hlB, this.interval, p.lastBarT + this.step, now, { funding: false });
    const closed = bars.filter((b) => b.t > p.lastBarT && b.t + this.step <= now);
    if (!closed.length) return;
    // Latest hourly funding (per hour) for carry estimates.
    const fA = this.markets[p.hlA]?.funding || 0, fB = this.markets[p.hlB]?.funding || 0;
    for (let i = 0; i < closed.length; i++) {
      const b = { ...closed[i], fundA: fA, fundB: fB, fundPeriodH: 1 };
      p.snap = p.model.update(b);
      p.lastBarT = b.t;
      p.barIndex++;
      if (i < closed.length - 1) continue; // only act on the newest bar after a gap
      await this.decide(p, b);
    }
  }

  async decide(p, bar) {
    const snap = p.snap;
    const st = p.strategy;
    const hasPos = !!st.pos;
    const barHours = this.step / 3600_000;
    const otherCoins = new Set(this.pairs.filter((q) => q !== p && (q.strategy.pos || q.closing)).flatMap((q) => [q.hlA, q.hlB]));
    let canOpen = this.guard.canOpen(hasPos);
    if (canOpen.ok && !hasPos && (otherCoins.has(p.hlA) || otherCoins.has(p.hlB))) canOpen = { ok: false, reason: "a leg is already used by another open pair" };
    if (canOpen.ok && p.foreign) canOpen = { ok: false, reason: "unmanaged position in one of the legs" };
    const ctx = {
      bar: p.barIndex,
      session: sessionCheck(bar.t + this.step, this.cfg.sessions),
      canOpen,
      carryPerBar: (-(bar.fundA) + Math.abs(snap.beta ?? 1) * bar.fundB) * barHours,
      pnlFrac: hasPos && p.plan ? this.pairPnl(p) / p.plan.maxLoss : null,
      fundingPaid: hasPos ? p.fundingPaid || 0 : null,
    };
    const d = st.onBar(snap, ctx);
    p.diag = d;
    if (d.action !== "WAIT" && d.action !== "HOLD") this.log(`${p.id}: ${d.action} — ${d.reasons.join("; ")}`);
    for (const it of d.intents) await this.execute(p, it, snap);
  }

  // ---------------------------------------------------------------- execution
  accountForPlan(p) {
    const exposure = {};
    let gross = 0;
    for (const [coin, pos] of Object.entries(this.positions)) {
      const usd = Math.abs(pos.szi * (this.mids[coin] ?? pos.entryPx));
      exposure[coin] = (exposure[coin] || 0) + usd;
      gross += usd;
    }
    return { equity: this.equity, grossOpen: gross, assetExposure: exposure, assetA: p.hlA, assetB: p.hlB };
  }

  async execute(p, it, snap) {
    const st = p.strategy;
    if (it.type === "open") {
      const plan = planPosition(snap, st.cfg, this.cfg.risk, this.accountForPlan(p), { volA24h: this.markets[p.hlA].dayNtlVlm, volB24h: this.markets[p.hlB].dayNtlVlm });
      if (!plan.ok) { this.log(`${p.id}: entry skipped — ${plan.reason}`); st.pos = null; return; }
      p.plan = plan;
      p.fundingPaid = 0;
      this.log(`${p.id}: plan A $${plan.notionalA.toFixed(0)} / B $${plan.notionalB.toFixed(0)} (all tranches), max loss $${plan.maxLoss.toFixed(0)}${plan.limits.length ? ` [capped: ${plan.limits.join(", ")}]` : ""}`);
    }
    if (it.type === "open" || it.type === "add") {
      const w = it.weight, dir = st.pos.dir, beta = Math.abs(st.pos.entry.beta);
      const legs = [
        { coin: p.hlA, usd: dir * w * p.plan.notionalA },
        { coin: p.hlB, usd: -dir * w * p.plan.notionalA * beta },
      ];
      const res = await this.broker.executeLegs(legs, { style: this.cfg.exchange?.entryStyle || "taker" });
      this.logFills(p, it.type, res);
      if (res.some((r) => !r.ok)) {
        if (it.type === "open") { st.pos = null; p.plan = null; st.cooldown[dir] = p.barIndex + 6; }
        else { const l = st.pos.ladder.find((x) => x.filled && x.weight === w && st.pos.lastAddBar === p.barIndex); if (l) { l.filled = false; st.pos.filledWeight -= w; } }
      }
      return;
    }
    if (it.type === "reduce") {
      const legs = [p.hlA, p.hlB].map((coin) => { const pos = this.positions[coin]; return pos ? { coin, usd: -Math.sign(pos.szi), szAbs: Math.abs(pos.szi) * it.fraction, reduceOnly: true } : null; }).filter(Boolean);
      this.logFills(p, "reduce", await this.broker.executeLegs(legs));
      return;
    }
    if (it.type === "rebalance") {
      const a = this.positions[p.hlA], b = this.positions[p.hlB];
      if (!a || !b) return;
      const targetUsd = -Math.sign(a.szi) * Math.abs(it.beta) * Math.abs(a.szi * this.mids[p.hlA]);
      const delta = targetUsd - b.szi * this.mids[p.hlB];
      if (Math.abs(delta) < (this.cfg.risk.minOrderUsd ?? 11)) return;
      this.logFills(p, "rebalance", await this.broker.executeLegs([{ coin: p.hlB, usd: delta }]));
      return;
    }
    if (it.type === "close") await this.closePair(p, it.reason);
  }

  async closePair(p, reason) {
    const pos = await this.broker.positions();
    const legs = [p.hlA, p.hlB].map((coin) => pos[coin] && pos[coin].szi ? { coin, usd: -Math.sign(pos[coin].szi), szAbs: Math.abs(pos[coin].szi), reduceOnly: true } : null).filter(Boolean);
    const eqBefore = this.equity;
    const pnlEst = this.pairPnl(p);
    const res = legs.length ? await this.broker.executeLegs(legs) : [];
    this.logFills(p, "close", res);
    if (res.some((r) => !r.ok)) { p.closing = reason; this.log(`${p.id}: close incomplete, retrying next tick`); return; }
    const rec = { pair: p.id, closedAt: new Date().toISOString(), reason, pnl: pnlEst, r: p.plan ? pnlEst / p.plan.maxLoss : null, dir: p.strategy.pos?.dir, equityBefore: eqBefore };
    this.trades.push(rec);
    await appendFile(join(this.stateDir, "trades.jsonl"), JSON.stringify(rec) + "\n");
    this.guard.recordTrade(pnlEst);
    p.strategy.pos = null;
    p.plan = null;
    p.closing = null;
    p.breachCount = 0;
    this.log(`${p.id}: closed (${reason}), PnL ≈ ${pnlEst >= 0 ? "+" : ""}${pnlEst.toFixed(2)}`);
  }

  async flattenAll(reason) {
    const open = this.pairs.filter((p) => p.strategy.pos || p.closing);
    if (!open.length) return;
    this.log(`FLATTEN ALL: ${reason}`);
    for (const p of open) await this.closePair(p, reason);
  }

  logFills(p, what, res) {
    for (const r of res) this.log(`${p.id} ${what}: ${r.coin} ${r.ok ? `filled ${r.filledSz} @ ${r.avgPx?.toFixed?.(4) ?? r.avgPx}` : `FAILED ${r.error || ""}`}${r.unwound ? " (unwound)" : ""}`);
  }

  async killed() {
    try { await stat(join(this.stateDir, "KILL")); return true; } catch { return false; }
  }

  // ---------------------------------------------------------------- state & status
  async loadState() {
    try { return JSON.parse(await readFile(join(this.stateDir, `engine-${this.mode}.json`), "utf8")); } catch { return null; }
  }

  async saveState() {
    const s = {
      savedAt: new Date().toISOString(), mode: this.mode,
      guard: { peak: this.guard.peak, halted: this.guard.halted, haltReason: this.guard.haltReason, lossStreak: this.guard.lossStreak, cooldownUntil: this.guard.cooldownUntil, dayKey: this.guard.dayKey, dayStart: this.guard.dayStart, dayHalted: this.guard.dayHalted },
      paper: this.broker.snapshot ? this.broker.snapshot() : undefined,
      trades: this.trades.slice(-200),
      pairs: Object.fromEntries(this.pairs.map((p) => [p.id, { pos: p.strategy.pos, cooldown: p.strategy.cooldown, plan: p.plan, fundingPaid: p.fundingPaid, barIndex: p.barIndex }])),
    };
    await writeFile(join(this.stateDir, `engine-${this.mode}.json`), JSON.stringify(s, null, 1));
  }

  status() {
    return {
      now: Date.now(), mode: this.mode, testnet: this.testnet, interval: this.interval, equity: this.equity,
      guard: { halted: this.guard.halted, haltReason: this.guard.haltReason, dayHalted: this.guard.dayHalted, peak: this.guard.peak, dayStart: this.guard.dayStart, canOpen: this.guard.canOpen() },
      positions: this.positions,
      events: nextEvents(Date.now(), 5),
      pairs: this.pairs.map((p) => ({ id: p.id, hlA: p.hlA, hlB: p.hlB, snap: p.snap, diag: p.diag && { action: p.diag.action, reasons: p.diag.reasons, gates: p.diag.gates, edge: p.diag.edge, position: p.diag.position }, pos: p.strategy.pos, plan: p.plan, live: p.live, closing: p.closing || null })),
      trades: this.trades.slice(-50),
      log: this.logLines.slice(-150),
    };
  }

  startServer() {
    if (!this.port) return;
    const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".svg": "image/svg+xml" };
    createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/state") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(this.status())); return; }
      // Static: the dashboard and the modules it imports. Only files under the project root.
      let path = url.pathname === "/" ? "/index.html" : url.pathname;
      const full = normalize(join(ROOT, path));
      if (!full.startsWith(ROOT) || /\/(state|data|node_modules|\.git)\//.test(full) || full.includes(".env")) { res.statusCode = 403; res.end(); return; }
      try { res.setHeader("Content-Type", types[extname(full)] || "application/octet-stream"); res.end(await readFile(full)); }
      catch { res.statusCode = 404; res.end("not found"); }
    }).listen(this.port, "127.0.0.1", () => this.log(`status + dashboard: http://localhost:${this.port}`));
  }
}
