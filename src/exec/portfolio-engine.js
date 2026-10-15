// Portfolio engine: runs the carry + trend book (src/core/xs-strategies.js) on
// Hyperliquid, paper or live.
//
// Once a day, shortly after the 00:00 UTC daily candle closes:
//   1. pull ~260 daily candles + the last weeks of hourly funding per coin
//   2. build the same matrix the backtester uses, run the same strategy function
//   3. turn target weights × account equity into per-coin orders
//      (no-trade band, minimum order size, reductions before additions)
//   4. execute each coin independently (IOC with slippage cap), log fills
// Every poll: mark equity, check the kill switch and the drawdown halt;
// in paper mode, charge hourly funding at the live rates.

import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildMatrix } from "../core/matrix.js";
import { carryTrend, prepare, CARRY_TREND_DEFAULTS } from "../core/xs-strategies.js";
import { HyperliquidInfo, MAINNET, TESTNET } from "../data/hyperliquid.js";
import { PaperBroker } from "./paper-broker.js";
import { HyperliquidBroker } from "./hl-broker.js";

const H = 3600_000, DAY = 24 * H;

export const PORTFOLIO_DEFAULTS = {
  book: { ...CARRY_TREND_DEFAULTS, minAdv: 5e6 }, // Hyperliquid volumes are lower than Binance's
  historyDays: 260,
  rebalanceDelayMin: 5,     // minutes after 00:00 UTC
  minOrderUsd: 15,          // Hyperliquid minimum is $10
  maxDrawdown: 0.25,        // flatten and halt below peak × (1 − this)
  minAssets: 8,             // skip a rebalance if fewer coins have data
  pollSeconds: 60,
  exchange: { leverage: 5, slippage: 0.004, maxSlippage: 0.01 },
};

export class PortfolioEngine {
  constructor({ cfg = {}, coins, mode = "paper", testnet = false, equity = 10_000, stateDir = "state/portfolio", env = process.env, info, log, now = () => Date.now(), resetHalt = false }) {
    this.cfg = { ...PORTFOLIO_DEFAULTS, ...cfg, book: { ...PORTFOLIO_DEFAULTS.book, ...(cfg.book || {}) }, exchange: { ...PORTFOLIO_DEFAULTS.exchange, ...(cfg.exchange || {}) } };
    this.coins = coins;
    this.mode = mode;
    this.testnet = testnet;
    this.paperEquity = equity;
    this.stateDir = stateDir;
    this.env = env;
    this.injectedInfo = info;
    this.now = now;
    this.resetHalt = resetHalt;
    this.log = log || ((msg) => { const line = `${new Date(this.now()).toISOString()} ${msg}`; console.log(line); appendFile(join(this.stateDir, "portfolio.log"), line + "\n").catch(() => {}); });
    this.state = { lastRebalanceDay: null, peak: null, halted: false, lastFundingHour: null, paper: null };
  }

  async start() {
    await mkdir(this.stateDir, { recursive: true });
    this.info = this.injectedInfo || new HyperliquidInfo({ baseUrl: this.testnet ? TESTNET : MAINNET });
    await this.loadState();
    if (this.resetHalt && this.state.halted) { this.state.halted = false; this.state.peak = null; this.log("halt reset by operator"); }
    this.markets = await this.info.markets();
    const missing = this.coins.filter((c) => !this.markets[c] || this.markets[c].delisted);
    if (missing.length) this.log(`not tradeable on Hyperliquid, skipped: ${missing.join(", ")}`);
    this.coins = this.coins.filter((c) => this.markets[c] && !this.markets[c].delisted);
    const x = this.cfg.exchange;
    this.broker = this.mode === "paper"
      ? new PaperBroker({ equity: this.paperEquity, state: this.state.paper })
      : new HyperliquidBroker({ info: this.info, account: this.env.HL_ACCOUNT, agentKey: this.env.HL_AGENT_KEY, testnet: this.testnet, slippage: x.slippage, maxSlippage: x.maxSlippage, leverage: x.leverage, log: this.log });
    await this.broker.init(this.markets);
    this.refreshMids();
    this.log(`portfolio engine (${this.mode}${this.testnet ? ", testnet" : ""}): ${this.coins.length} coins, equity $${(await this.broker.equity()).toFixed(2)}`);
  }

  refreshMids() {
    const mids = {};
    for (const [c, m] of Object.entries(this.markets)) { const px = m.midPx ?? m.markPx; if (px > 0) mids[c] = px; }
    this.mids = mids;
    this.broker.setMids(mids);
  }

  // ---------------------------------------------------------------- data + plan
  /** Daily candles + hourly funding for every coin → the backtester's matrix. */
  async loadMatrix() {
    const now = this.now();
    const start = Math.floor(now / DAY) * DAY - this.cfg.historyDays * DAY;
    const fundStart = Math.floor(now / DAY) * DAY - (this.cfg.book.carryD + 2) * DAY;
    const series = {};
    for (const coin of this.coins) {
      try {
        const k = await this.info.candles(coin, "1d", start, now);
        const funding = await this.info.fundingHistory(coin, fundStart, now);
        if (k.length) series[coin] = { k, funding };
      } catch (e) { this.log(`data ${coin}: ${e.message}`); }
    }
    const m = buildMatrix(series, { barH: 24, now });
    prepare(m, {});
    return m;
  }

  /** Target book at the last closed daily bar, and the orders that move the account there. */
  async plan(m) {
    m = m || (await this.loadMatrix());
    const k = m.t.length - 1;
    const book = carryTrend(this.cfg.book);
    const weights = k > 0 ? book({ k, m, ids: m.ids }) : {};
    const legs = book.last || { carry: {}, trend: {} };
    const equity = await this.broker.equity();
    const pos = await this.broker.positions();
    const orders = planOrders({ weights, equity, positions: pos, mids: this.mids, coins: this.coins, band: this.cfg.book.band, minOrderUsd: this.cfg.minOrderUsd });
    const gross = Object.values(weights).reduce((s, w) => s + Math.abs(w), 0);
    return { barTime: m.t[k], assetsWithData: m.ids.filter((a) => m.c[a][k] > 0).length, weights, legs, equity, gross, orders };
  }

  // ---------------------------------------------------------------- execution
  async execute(orders) {
    const fills = [];
    // Reductions (and closes) first: they free margin for the additions.
    const sorted = [...orders].sort((a, b) => Number(b.reduceOnly) - Number(a.reduceOnly));
    for (const o of sorted) {
      const leg = { coin: o.coin, usd: o.deltaUsd, reduceOnly: o.reduceOnly, ...(o.szAbs ? { szAbs: o.szAbs } : {}) };
      let r;
      try { [r] = await this.broker.executeLegs([leg]); } catch (e) { r = { coin: o.coin, ok: false, error: e.message }; }
      if (!r) continue;
      fills.push({ ...r, intent: o });
      const line = { t: this.now(), mode: this.mode, coin: o.coin, deltaUsd: o.deltaUsd, reduceOnly: o.reduceOnly, ok: r.ok, filledSz: r.filledSz, avgPx: r.avgPx, error: r.error || null };
      await appendFile(join(this.stateDir, "trades.jsonl"), JSON.stringify(line) + "\n").catch(() => {});
      if (!r.ok) this.log(`order ${o.coin} ${o.deltaUsd > 0 ? "buy" : "sell"} $${Math.abs(o.deltaUsd).toFixed(0)} failed: ${r.error}`);
    }
    return fills;
  }

  async rebalance({ dryRun = false } = {}) {
    const p = await this.plan();
    if (p.assetsWithData < this.cfg.minAssets) {
      this.log(`rebalance skipped: only ${p.assetsWithData} coins with data (need ${this.cfg.minAssets})`);
      return { ...p, skipped: true };
    }
    this.log(`book for ${new Date(p.barTime).toISOString().slice(0, 10)} close: gross ${p.gross.toFixed(2)}× of $${p.equity.toFixed(0)}, ${Object.keys(p.weights).length} coins, ${p.orders.length} orders${dryRun ? " (dry run)" : ""}`);
    if (dryRun) return p;
    const fills = await this.execute(p.orders);
    await this.writeStatus({ lastPlan: summarise(p), lastFills: fills.length });
    return { ...p, fills };
  }

  async flatten(reason) {
    const pos = await this.broker.positions();
    const orders = Object.entries(pos).filter(([, x]) => x.szi).map(([coin, x]) => ({ coin, deltaUsd: -Math.sign(x.szi), szAbs: Math.abs(x.szi), reduceOnly: true }));
    if (orders.length) this.log(`flattening ${orders.length} positions: ${reason}`);
    return this.execute(orders);
  }

  // ---------------------------------------------------------------- loop
  async tick() {
    const now = this.now();
    this.markets = await this.info.markets();
    this.refreshMids();
    // Paper: charge funding once per hour at the live hourly rates.
    const hour = Math.floor(now / H);
    if (this.mode === "paper" && this.state.lastFundingHour != null && hour > this.state.lastFundingHour) {
      const rates = Object.fromEntries(Object.entries(this.markets).map(([c, m]) => [c, m.funding]));
      for (let h = this.state.lastFundingHour; h < hour; h++) this.broker.applyFunding(rates);
    }
    this.state.lastFundingHour = hour;

    const equity = await this.broker.equity();
    this.state.peak = Math.max(this.state.peak ?? equity, equity);
    if (await exists(join(this.stateDir, "KILL"))) {
      if (!this.state.halted) { await this.flatten("kill switch (state file KILL)"); this.state.halted = true; }
    } else if (!this.state.halted && equity < this.state.peak * (1 - this.cfg.maxDrawdown)) {
      await this.flatten(`drawdown halt: equity $${equity.toFixed(0)} < ${((1 - this.cfg.maxDrawdown) * 100).toFixed(0)}% of peak $${this.state.peak.toFixed(0)}`);
      this.state.halted = true;
    }

    const day = Math.floor((now - this.cfg.rebalanceDelayMin * 60_000) / DAY);
    if (!this.state.halted && day !== this.state.lastRebalanceDay) {
      const r = await this.rebalance();
      if (!r.skipped) this.state.lastRebalanceDay = day;
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
  async loadState() {
    try { this.state = { ...this.state, ...JSON.parse(await readFile(join(this.stateDir, `state-${this.mode}.json`), "utf8")) }; } catch { /* fresh */ }
  }

  async saveState(equity) {
    if (this.broker.snapshot) this.state.paper = this.broker.snapshot();
    await writeFile(join(this.stateDir, `state-${this.mode}.json`), JSON.stringify(this.state, null, 1));
    if (equity != null) {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      if (day !== this.lastEquityDay) { this.lastEquityDay = day; await appendFile(join(this.stateDir, "equity.jsonl"), JSON.stringify({ t: this.now(), equity }) + "\n").catch(() => {}); }
    }
  }

  async writeStatus(extra) {
    const st = { t: this.now(), mode: this.mode, equity: await this.broker.equity(), peak: this.state.peak, halted: this.state.halted, positions: await this.broker.positions(), ...extra };
    await writeFile(join(this.stateDir, "status.json"), JSON.stringify(st, null, 1));
  }
}

/**
 * Orders that move current positions to `weights × equity`.
 * - close a coin that is no longer in the book (exact size, reduce-only)
 * - on a sign flip, close first, then open the new side
 * - skip resizes smaller than `band` × target (same rule as the backtest) or below minOrderUsd
 */
export function planOrders({ weights, equity, positions, mids, coins, band = 0.25, minOrderUsd = 15 }) {
  const out = [];
  const all = new Set([...Object.keys(weights), ...Object.keys(positions).filter((c) => coins.includes(c))]);
  for (const coin of all) {
    const px = mids[coin];
    if (!(px > 0)) continue;
    const szi = positions[coin]?.szi || 0;
    const cur = szi * px;
    const tgt = (weights[coin] || 0) * equity;
    if (Math.abs(tgt) < minOrderUsd) {
      if (szi) out.push({ coin, curUsd: cur, tgtUsd: 0, deltaUsd: -cur, szAbs: Math.abs(szi), reduceOnly: true });
      continue;
    }
    if (szi && Math.sign(tgt) !== Math.sign(cur)) {
      out.push({ coin, curUsd: cur, tgtUsd: 0, deltaUsd: -cur, szAbs: Math.abs(szi), reduceOnly: true });
      out.push({ coin, curUsd: 0, tgtUsd: tgt, deltaUsd: tgt, reduceOnly: false });
      continue;
    }
    const delta = tgt - cur;
    if (szi && Math.abs(delta) < band * Math.abs(tgt)) continue;
    if (Math.abs(delta) < minOrderUsd) continue;
    out.push({ coin, curUsd: cur, tgtUsd: tgt, deltaUsd: delta, reduceOnly: Math.abs(tgt) < Math.abs(cur) });
  }
  return out;
}

function summarise(p) {
  return { barTime: p.barTime, equity: p.equity, gross: p.gross, weights: p.weights, carry: p.legs.carry, trend: p.legs.trend, orders: p.orders };
}

async function exists(path) { try { await stat(path); return true; } catch { return false; } }
