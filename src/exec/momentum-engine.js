// OI-momentum engine: runs the short-horizon strategy (src/core/oi-momentum.js)
// on Hyperliquid, paper or live. See docs/OI_MOMENTUM.md.
//
// Every 5-minute bar close:
//   1. refresh 5-minute candles + open interest for the universe (incremental)
//   2. build the same matrix the backtester uses and evaluate the same trigger
//   3. close trades whose hold time is up; open new longs that triggered
//      (size from vol, total notional capped), extend trades that re-trigger
// Every poll: mark equity, kill switch, daily loss pause, drawdown halt; paper
// mode charges hourly funding at Hyperliquid's live rates.
//
// Signal data: "hyperliquid" (HL candles; OI recorded by the engine every bar,
// so lookbacks need that much history — 12 h for the longest) or "binance"
// (Binance candles + OI history: identical to the research data, no warm-up).

import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildMatrix } from "../core/matrix.js";
import { OIM_DEFAULTS, barStats, oimTrigger, oimNotional } from "../core/oi-momentum.js";
import { HyperliquidInfo, MAINNET, TESTNET } from "../data/hyperliquid.js";
import { BinanceFutures } from "../data/binance-live.js";
import { PaperBroker } from "./paper-broker.js";
import { HyperliquidBroker } from "./hl-broker.js";

const MIN = 60_000, BAR = 5 * MIN, H = 3600_000, DAY = 24 * H;
const HISTORY = 7.5 * DAY; // 7 days for the vol estimate, plus margin

export const MOMENTUM_DEFAULTS = {
  strategy: { ...OIM_DEFAULTS },
  signalSource: "hyperliquid",
  minAdv: { hyperliquid: 10e6, binance: 50e6 }, // $ volume per day, 7-day average, on the signal venue
  minOrderUsd: 12,        // Hyperliquid minimum is $10
  maxDrawdown: 0.25,      // flatten and halt below peak × (1 − this)
  dailyLossLimit: 0.06,   // flatten and pause until 00:00 UTC after losing this much in a day
  pollSeconds: 15,
  maxDataWaitSec: 180,    // wait up to this long after a bar closes for its OI snapshot
  exchange: { leverage: 5, slippage: 0.004, maxSlippage: 0.01 },
};

// ---------------------------------------------------------------- data feeds
/** Hyperliquid candles + OI recorded by the engine at each bar close. */
export class HyperliquidFeed {
  constructor(info) { this.info = info; this.k = {}; this.oi = {}; }
  exportOi() { return Object.fromEntries(Object.entries(this.oi).map(([a, mp]) => [a, [...mp]])); }
  importOi(o) { for (const [a, rows] of Object.entries(o || {})) this.oi[a] = new Map(rows); }

  async refresh(assets, now, markets) {
    const bar = Math.floor(now / BAR) * BAR;
    for (const { id, hl } of assets) {
      const have = this.k[id] || [];
      const start = have.length ? have[have.length - 1].t : now - HISTORY;
      const rows = await this.info.candles(hl, "5m", start, now);
      this.k[id] = [...have.filter((r) => r.t < start), ...rows].filter((r) => r.t >= now - HISTORY);
      // OI snapshot for the bar that just closed (recorded once, as soon after the close as we poll).
      const oi = markets[hl]?.openInterest;
      const mp = (this.oi[id] ||= new Map());
      if (oi > 0 && !mp.has(bar - BAR) && now - bar < 2 * MIN) mp.set(bar - BAR, oi);
      for (const t of mp.keys()) if (t < now - DAY) mp.delete(t);
    }
    return { series: Object.fromEntries(assets.map(({ id }) => [id, { k: this.k[id] || [], funding: [] }])), oi: this.oi };
  }
}

/** Binance candles + Binance 5-minute OI history (the research data). */
export class BinanceFeed {
  constructor(client) { this.bn = client; this.k = {}; this.oi = {}; }
  exportOi() { return {}; }
  importOi() {}

  async refresh(assets, now) {
    for (const { id, binance } of assets) {
      const have = this.k[id] || [];
      const start = have.length ? have[have.length - 1].t : now - HISTORY;
      const rows = await this.bn.klines(binance, "5m", start, now);
      this.k[id] = [...have.filter((r) => r.t < start), ...rows].filter((r) => r.t >= now - HISTORY);
      const mp = (this.oi[id] ||= new Map());
      const last = Math.max(now - 13 * H, ...[...mp.keys()].map((t) => t + BAR));
      const snaps = await this.bn.openInterestHist(binance, last, now);
      for (const [stamp, v] of snaps) mp.set(stamp - BAR, v); // a snapshot at T is the close of the bar starting at T − 5 min
      for (const t of mp.keys()) if (t < now - DAY) mp.delete(t);
    }
    return { series: Object.fromEntries(assets.map(({ id }) => [id, { k: this.k[id] || [], funding: [] }])), oi: this.oi };
  }
}

// ---------------------------------------------------------------- engine
export class MomentumEngine {
  constructor({ cfg = {}, assets, mode = "paper", testnet = false, equity = 10_000, stateDir = "state/momentum", env = process.env, info, binance, log, now = () => Date.now(), resetHalt = false }) {
    const src = cfg.signalSource || MOMENTUM_DEFAULTS.signalSource;
    this.cfg = {
      ...MOMENTUM_DEFAULTS, ...cfg,
      strategy: { ...MOMENTUM_DEFAULTS.strategy, minAdv: MOMENTUM_DEFAULTS.minAdv[src], ...(cfg.strategy || {}) },
      exchange: { ...MOMENTUM_DEFAULTS.exchange, ...(cfg.exchange || {}) },
      signalSource: src,
    };
    this.assets = assets; // [{id, hl, binance}]
    this.mode = mode;
    this.testnet = testnet;
    this.paperEquity = equity;
    this.stateDir = stateDir;
    this.env = env;
    this.injectedInfo = info;
    this.injectedBinance = binance;
    this.now = now;
    this.resetHalt = resetHalt;
    this.log = log || ((msg) => { const line = `${new Date(this.now()).toISOString()} ${msg}`; console.log(line); appendFile(join(this.stateDir, "momentum.log"), line + "\n").catch(() => {}); });
    this.state = { trades: [], lastBar: null, barSeen: null, peak: null, halted: false, pausedDay: null, dayKey: null, dayStartEq: null, lastFundingHour: null, paper: null, oiHist: {} };
  }

  async start() {
    await mkdir(this.stateDir, { recursive: true });
    this.info = this.injectedInfo || new HyperliquidInfo({ baseUrl: this.testnet ? TESTNET : MAINNET });
    await this.loadState();
    if (this.resetHalt && this.state.halted) { this.state.halted = false; this.state.peak = null; this.log("halt reset by operator"); }
    this.markets = await this.info.markets();
    const missing = this.assets.filter((a) => !this.markets[a.hl] || this.markets[a.hl].delisted);
    if (missing.length) this.log(`not tradeable on Hyperliquid, skipped: ${missing.map((a) => a.id).join(", ")}`);
    this.assets = this.assets.filter((a) => this.markets[a.hl] && !this.markets[a.hl].delisted && (this.cfg.signalSource !== "binance" || a.binance));
    this.feed = this.cfg.signalSource === "binance" ? new BinanceFeed(this.injectedBinance || new BinanceFutures()) : new HyperliquidFeed(this.info);
    this.feed.importOi(this.state.oiHist);
    const x = this.cfg.exchange;
    this.broker = this.mode === "paper"
      ? new PaperBroker({ equity: this.paperEquity, state: this.state.paper })
      : new HyperliquidBroker({ info: this.info, account: this.env.HL_ACCOUNT, agentKey: this.env.HL_AGENT_KEY, testnet: this.testnet, slippage: x.slippage, maxSlippage: x.maxSlippage, leverage: x.leverage, log: this.log });
    await this.broker.init(this.markets);
    this.refreshMids();
    this.log(`OI-momentum engine (${this.mode}${this.testnet ? ", testnet" : ""}, signals from ${this.cfg.signalSource}): ${this.assets.length} coins, equity $${(await this.broker.equity()).toFixed(2)}, ${this.state.trades.length} open trades`);
  }

  refreshMids() {
    const mids = {};
    for (const [c, m] of Object.entries(this.markets)) { const px = m.midPx ?? m.markPx; if (px > 0) mids[c] = px; }
    this.mids = mids;
    this.broker.setMids(mids);
  }

  /** Matrix of completed 5-minute bars (same structure as the backtester's), with OI at each bar's close. */
  async loadMatrix(now = this.now()) {
    const { series, oi } = await this.feed.refresh(this.assets, now, this.markets);
    const bar = Math.floor(now / BAR) * BAR;
    const m = buildMatrix(series, { barH: 1 / 12, from: now - HISTORY, now: bar });
    m.bph = 12;
    barStats(m);
    m.oi = {};
    for (const a of m.ids) {
      const arr = new Float64Array(m.t.length).fill(NaN);
      const mp = oi[a];
      if (mp) for (let k = 0; k < m.t.length; k++) { const v = mp.get(m.t[k]); if (v > 0) arr[k] = v; }
      m.oi[a] = arr;
    }
    return m;
  }

  /** Top coins by 7-day average $ volume on the signal venue, above minAdv. */
  eligible(m, k) {
    const bars7 = 7 * 24 * 12, p = this.cfg.strategy;
    const adv = (a) => { let s = 0; for (let i = Math.max(0, k - bars7 + 1); i <= k; i++) s += m.qv[a][i] || 0; return s / 7; };
    return m.ids.map((a) => [a, adv(a)]).filter(([a, v]) => v >= p.minAdv && m.c[a][k] > 0 && m.sig[a][k] > 0).sort((x, y) => y[1] - x[1]).slice(0, p.topN).map(([a]) => a);
  }

  // ---------------------------------------------------------------- one bar
  async onBar(m, { dryRun = false } = {}) {
    const k = m.t.length - 1, now = this.now(), p = this.cfg.strategy;
    const hlOf = Object.fromEntries(this.assets.map((a) => [a.id, a.hl]));
    const pos = await this.broker.positions();
    // Drop trades whose position is gone (closed by hand or liquidated).
    this.state.trades = this.state.trades.filter((t) => { const ok = Math.sign(pos[t.coin]?.szi || 0) === t.dir; if (!ok) this.log(`trade ${t.id} ${t.coin}: position no longer open, forgetting it`); return ok; });

    // Exits whose hold time is up.
    for (const t of [...this.state.trades]) if (now >= t.until) await this.close(t, "hold time up", dryRun);

    // Entries.
    const fired = [];
    const equity = await this.broker.equity();
    let gross = 0;
    for (const [c, x] of Object.entries(await this.broker.positions())) gross += Math.abs(x.szi) * (this.mids[c] || 0);
    for (const a of this.eligible(m, k)) {
      const tr = oimTrigger(m, a, k, p);
      if (!tr) continue;
      fired.push({ a, ...tr });
      const coin = hlOf[a];
      const open = this.state.trades.find((t) => t.coin === coin);
      if (open) {
        if (open.dir === tr.dir) { open.until = now + p.holdH * H; this.log(`${a}: re-triggered (${tr.L}h z ${tr.z.toFixed(1)}, OI +${(tr.dOi * 100).toFixed(1)}%), hold extended`); }
        continue;
      }
      let usd = oimNotional(m, a, k, equity, p);
      usd = Math.min(usd, Math.max(0, p.maxGross * equity - gross));
      if (usd < this.cfg.minOrderUsd) { this.log(`${a}: triggered but no room under the ${p.maxGross}× gross cap`); continue; }
      this.log(`${a}: ${tr.dir > 0 ? "LONG" : "SHORT"} trigger — ${tr.L}h move ${tr.z.toFixed(1)}σ with OI +${(tr.dOi * 100).toFixed(1)}%; $${usd.toFixed(0)} for ${p.holdH}h${dryRun ? " (dry run)" : ""}`);
      if (dryRun) continue;
      const [r] = await this.broker.executeLegs([{ coin, usd: tr.dir * usd }]).catch((e) => [{ ok: false, error: e.message }]);
      if (!r?.ok || !r.filledSz) { this.log(`${a}: entry failed: ${r?.error || "no fill"}`); continue; }
      const t = { id: `${coin}-${m.t[k]}`, coin, asset: a, dir: tr.dir, sz: Math.abs(r.filledSz), entryPx: r.avgPx, tIn: now, until: now + p.holdH * H, trigger: { L: tr.L, z: tr.z, dOi: tr.dOi } };
      this.state.trades.push(t);
      gross += Math.abs(r.filledSz) * (r.avgPx || this.mids[coin]);
      await this.journal({ type: "open", ...t });
    }
    return { barTime: m.t[k], eligible: this.eligible(m, k).length, fired };
  }

  async close(t, reason, dryRun = false) {
    if (dryRun) return;
    const [r] = await this.broker.executeLegs([{ coin: t.coin, usd: -t.dir, szAbs: t.sz, reduceOnly: true }]).catch((e) => [{ ok: false, error: e.message }]);
    if (!r?.ok) { this.log(`${t.coin}: close failed (${r?.error}); will retry next bar`); return; }
    const exitPx = r.avgPx || this.mids[t.coin];
    const pnl = t.dir * t.sz * (exitPx - t.entryPx);
    this.state.trades = this.state.trades.filter((x) => x !== t);
    this.log(`${t.coin}: closed (${reason}) ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${((t.dir * (exitPx / t.entryPx - 1)) * 100).toFixed(2)}%)`);
    await this.journal({ type: "close", id: t.id, coin: t.coin, reason, exitPx, pnl, tOut: this.now() });
  }

  async flatten(reason) {
    this.log(`flattening: ${reason}`);
    for (const t of [...this.state.trades]) await this.close(t, reason);
  }

  // ---------------------------------------------------------------- loop
  async tick() {
    const now = this.now();
    this.markets = await this.info.markets();
    this.refreshMids();
    const hour = Math.floor(now / H);
    if (this.mode === "paper" && this.state.lastFundingHour != null && hour > this.state.lastFundingHour) {
      const rates = Object.fromEntries(Object.entries(this.markets).map(([c, m]) => [c, m.funding]));
      for (let h = this.state.lastFundingHour; h < hour; h++) this.broker.applyFunding(rates);
    }
    this.state.lastFundingHour = hour;

    const equity = await this.broker.equity();
    this.state.peak = Math.max(this.state.peak ?? equity, equity);
    const day = Math.floor(now / DAY);
    if (this.state.dayKey !== day) { this.state.dayKey = day; this.state.dayStartEq = equity; }
    if (await exists(join(this.stateDir, "KILL"))) {
      if (!this.state.halted) { await this.flatten("kill switch (state file KILL)"); this.state.halted = true; }
    } else if (!this.state.halted && equity < this.state.peak * (1 - this.cfg.maxDrawdown)) {
      await this.flatten(`drawdown halt: equity $${equity.toFixed(0)} is ${((1 - equity / this.state.peak) * 100).toFixed(1)}% below peak`);
      this.state.halted = true;
    } else if (this.state.pausedDay !== day && equity < this.state.dayStartEq * (1 - this.cfg.dailyLossLimit)) {
      await this.flatten(`daily loss limit: down ${((1 - equity / this.state.dayStartEq) * 100).toFixed(1)}% today; paused until 00:00 UTC`);
      this.state.pausedDay = day;
    }

    const lastClosed = Math.floor(now / BAR) * BAR - BAR;
    if (!this.state.halted && lastClosed !== this.state.lastBar) {
      const m = await this.loadMatrix(now);
      const k = m.t.length - 1;
      const elig = k >= 0 ? this.eligible(m, k) : [];
      const haveOi = elig.filter((a) => m.oi[a][k] > 0).length;
      const waited = (now - lastClosed - BAR) / 1000;
      if (k >= 0 && m.t[k] === lastClosed && (haveOi >= elig.length * 0.8 || waited > this.cfg.maxDataWaitSec)) {
        if (this.state.pausedDay === day) {
          for (const t of [...this.state.trades]) if (now >= t.until) await this.close(t, "hold time up");
        } else await this.onBar(m);
        this.state.lastBar = lastClosed;
      }
    }
    await this.saveState(equity);
  }

  async run() {
    this.running = true;
    while (this.running) {
      try { await this.tick(); } catch (e) { this.log(`tick error: ${e.message}`); }
      await new Promise((r) => setTimeout(r, this.cfg.pollSeconds * 1000));
    }
  }

  // ---------------------------------------------------------------- state
  async journal(rec) { await appendFile(join(this.stateDir, "trades.jsonl"), JSON.stringify({ t: this.now(), mode: this.mode, ...rec }) + "\n").catch(() => {}); }

  async loadState() {
    try { this.state = { ...this.state, ...JSON.parse(await readFile(join(this.stateDir, `state-${this.mode}.json`), "utf8")) }; } catch { /* fresh */ }
  }

  async saveState(equity) {
    if (this.broker.snapshot) this.state.paper = this.broker.snapshot();
    this.state.oiHist = this.feed.exportOi();
    await writeFile(join(this.stateDir, `state-${this.mode}.json`), JSON.stringify(this.state));
    const st = { t: this.now(), mode: this.mode, equity, peak: this.state.peak, halted: this.state.halted, pausedToday: this.state.pausedDay === Math.floor(this.now() / DAY), trades: this.state.trades };
    await writeFile(join(this.stateDir, "status.json"), JSON.stringify(st, null, 1)).catch(() => {});
  }
}

async function exists(path) { try { await stat(path); return true; } catch { return false; } }
