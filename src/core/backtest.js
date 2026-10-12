// Event-driven backtest of one pair. Bar-by-bar, no look-ahead:
//   signal on the close of bar i  →  fill at the open of bar i+1 (plus slippage)
// Fees on every leg, funding charged when it settles, stops evaluated on
// closes. Runs the exact PairModel / PairStrategy / risk code the live engine
// uses.

import { PairModel } from "./model.js";
import { PairStrategy, mergeConfig, STRATEGY_DEFAULTS } from "./strategy.js";
import { planPosition, AccountGuard, RISK_DEFAULTS } from "./risk.js";
import { sessionCheck } from "./sessions.js";

const HOURS_PER_YEAR = 8760;

export function runBacktest(bars, cfg = {}, opts = {}) {
  const strat = new PairStrategy(cfg);
  const sc = strat.cfg;
  const model = new PairModel(cfg.model);
  const risk = { ...RISK_DEFAULTS, ...(cfg.risk || {}) };
  const guard = new AccountGuard(risk);
  const equity0 = opts.equity ?? 10_000;
  const startT = opts.startT ?? 0; // trading starts here; earlier bars only warm the model
  const fixedNotional = opts.fixedNotional ?? null; // legacy mode: no risk sizing
  const useSessions = opts.sessions !== false && cfg.sessions;
  const step = bars.length > 1 ? bars[1].t - bars[0].t : 3600_000;
  const barsPerYear = (HOURS_PER_YEAR * 3600_000) / step;
  const fundingPeriodBars = (8 * 3600_000) / step;
  const fee = sc.costs.useMaker ? sc.costs.makerFee : sc.costs.takerFee;
  const slip = sc.costs.slippage;

  let cash = equity0, qA = 0, qB = 0;
  let pending = [];
  let trade = null;
  const trades = [];
  const equity = [];
  let exposureBars = 0;
  let lastDiag = null;
  const recals = [];
  let lastRecalT = null;

  const fill = (qty, px, isA) => {
    if (qty === 0) return;
    const p = px * (qty > 0 ? 1 + slip : 1 - slip);
    cash -= qty * p + Math.abs(qty) * p * fee;
    if (isA) qA += qty; else qB += qty;
    if (trade) trade.fees += Math.abs(qty) * p * fee + Math.abs(qty) * px * slip;
  };

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const trading = b.t >= startT;

    // 1) Execute last bar's intents at this bar's open.
    for (const it of pending) {
      if (it.type === "open" || it.type === "add") {
        if (it.type === "open") {
          const eqNow = cash + qA * b.oa + qB * b.ob;
          let plan;
          if (fixedNotional) plan = { ok: true, notionalA: fixedNotional / (1 + Math.abs(it.snap.beta)), maxLoss: fixedNotional * 0.05 };
          else plan = planPosition(it.snap, sc, risk, { equity: eqNow, grossOpen: 0 }, { volA24h: it.volA24h, volB24h: it.volB24h });
          if (!plan.ok) { strat.pos = null; continue; }
          trade = { openT: b.t, openBar: i, dir: it.dir, equityBefore: eqNow, plan, fees: 0, funding: 0, adds: 0, entryZ: it.snap.z, beta: it.snap.beta, halfLife: it.snap.halfLife, cointP: it.snap.cointP, rvA: it.snap.rvA, rvB: it.snap.rvB, hourUtc: new Date(it.snap.t).getUTCHours(), dow: new Date(it.snap.t).getUTCDay(), legMove: Math.max(Math.abs(it.snap.legMoveA), Math.abs(it.snap.legMoveB)), legMoveA: it.snap.legMoveA, legMoveB: it.snap.legMoveB, signalT: it.snap.t, volRatio: it.snap.volRatio, zLong: it.snap.zLong };
          guard.openPairs = 1;
        }
        if (!trade) continue;
        if (it.type === "add") trade.adds++;
        const nA = trade.plan.notionalA * it.weight;
        const beta = strat.pos ? strat.pos.entry.beta : trade.beta;
        fill((trade.dir * nA) / b.oa, b.oa, true);
        fill((-trade.dir * nA * Math.abs(beta)) / b.ob, b.ob, false);
      } else if (it.type === "reduce" && trade) {
        fill(-qA * it.fraction, b.oa, true);
        fill(-qB * it.fraction, b.ob, false);
      } else if (it.type === "rebalance" && trade && qA !== 0) {
        const targetB = (-Math.sign(qA) * Math.abs(it.beta) * Math.abs(qA) * b.oa) / b.ob;
        fill(targetB - qB, b.ob, false);
      } else if (it.type === "close" && trade) {
        fill(-qA, b.oa, true);
        fill(-qB, b.ob, false);
        const eqAfter = cash;
        const pnl = eqAfter - trade.equityBefore;
        trades.push({ ...trade, closeT: b.t, bars: i - trade.openBar, pnl, r: pnl / trade.plan.maxLoss, ret: pnl / trade.equityBefore, reason: it.reason, kind: it.kind, plan: undefined, notionalA: trade.plan.notionalA, maxLoss: trade.plan.maxLoss });
        guard.recordTrade(pnl);
        guard.openPairs = 0;
        trade = null;
        qA = 0; qB = 0;
      }
    }
    pending = [];

    // 2) Funding settling during this bar (Binance rate per 8h; longs pay positive).
    if (qA !== 0 || qB !== 0) {
      const fpay = -(qA * b.pa * b.fa + qB * b.pb * b.fb);
      cash += fpay;
      if (trade) trade.funding += fpay;
      exposureBars++;
    }

    // 3) Mark to market + account guard.
    const eq = cash + qA * b.pa + qB * b.pb;
    equity.push(eq);
    const g = guard.update(b.t, eq, i);

    // 4) Model + strategy on this bar's close.
    const snap = model.update(b);
    if (opts.collectRecal && snap.ready && snap.recalAt !== lastRecalT && b.t >= startT) {
      lastRecalT = snap.recalAt;
      recals.push({ t: b.t, cointP: snap.cointP, halfLife: snap.halfLife, corr: snap.corr, beta: snap.beta, hurst: snap.hurst, sigmaEq: snap.sigmaEq });
    }
    if (!trading) continue;
    const forAdd = !!strat.pos;
    const periodBars = b.fundPeriodH ? (b.fundPeriodH * 3600_000) / step : fundingPeriodBars;
    const carryLong = (-b.fundA + Math.abs(snap.beta ?? 1) * b.fundB) / periodBars;
    const ctx = {
      bar: i,
      session: useSessions ? sessionCheck(b.t, cfg.sessions) : { ok: true },
      canOpen: guard.canOpen(forAdd),
      carryPerBar: carryLong,
      pnlFrac: trade ? (eq - trade.equityBefore) / trade.plan.maxLoss : null,
      fundingPaid: trade ? trade.funding / trade.plan.notionalA : null,
    };
    if (g.flattenAll && strat.pos) {
      strat.pos = null;
      pending.push({ type: "close", reason: guard.halted ? guard.haltReason : "daily loss limit", kind: "RISK" });
      continue;
    }
    const d = strat.onBar(snap, ctx);
    lastDiag = d;
    for (const it of d.intents) {
      pending.push({ ...it, kind: d.action, snap, volA24h: opts.liquidity ? avgVol(bars, i, "qa") : undefined, volB24h: opts.liquidity ? avgVol(bars, i, "qb") : undefined });
    }
  }
  // Close anything still open at the last close (marked, not filled).
  if (trade) {
    const last = bars[bars.length - 1];
    const eq = cash + qA * last.pa + qB * last.pb;
    trades.push({ ...trade, closeT: last.t, bars: bars.length - 1 - trade.openBar, pnl: eq - trade.equityBefore, r: (eq - trade.equityBefore) / trade.plan.maxLoss, ret: (eq - trade.equityBefore) / trade.equityBefore, reason: "open at end of data", kind: "OPEN", plan: undefined, notionalA: trade.plan.notionalA, maxLoss: trade.plan.maxLoss });
  }

  const startIdx = Math.max(0, bars.findIndex((b) => b.t >= startT));
  return { trades, equity, times: bars.map((b) => b.t), metrics: metrics(equity.slice(startIdx), trades, barsPerYear, exposureBars), lastDiag, strategy: strat, model, recals };
}

function avgVol(bars, i, key) {
  let s = 0, n = 0;
  for (let k = Math.max(0, i - 23); k <= i; k++) { s += bars[k][key]; n++; }
  return n ? (s / n) * 24 : undefined;
}

export function metrics(equity, trades, barsPerYear = HOURS_PER_YEAR, exposureBars = 0) {
  if (equity.length < 2) return null;
  const rets = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i] / equity[i - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
  let peak = equity[0], maxDD = 0;
  for (const e of equity) { peak = Math.max(peak, e); maxDD = Math.max(maxDD, 1 - e / peak); }
  const total = equity[equity.length - 1] / equity[0] - 1;
  const years = equity.length / barsPerYear;
  const closed = trades.filter((t) => t.kind !== "OPEN");
  const wins = closed.filter((t) => t.pnl > 0);
  const grossW = wins.reduce((s, t) => s + t.pnl, 0);
  const grossL = -closed.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const byKind = {};
  for (const t of closed) {
    const k = (byKind[t.kind] ||= { n: 0, pnl: 0 });
    k.n++; k.pnl += t.pnl;
  }
  return {
    totalReturn: total,
    cagr: years > 0 ? Math.pow(1 + total, 1 / years) - 1 : 0,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(barsPerYear) : 0,
    maxDrawdown: maxDD,
    calmar: maxDD > 0 ? (years > 0 ? Math.pow(1 + total, 1 / years) - 1 : 0) / maxDD : 0,
    trades: closed.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    profitFactor: grossL > 0 ? grossW / grossL : grossW > 0 ? Infinity : 0,
    avgR: closed.length ? closed.reduce((s, t) => s + t.r, 0) / closed.length : 0,
    worstTrade: closed.length ? Math.min(...closed.map((t) => t.ret)) : 0,
    avgBarsHeld: closed.length ? closed.reduce((s, t) => s + t.bars, 0) / closed.length : 0,
    exposure: exposureBars / equity.length,
    fees: closed.reduce((s, t) => s + t.fees, 0),
    funding: closed.reduce((s, t) => s + t.funding, 0),
    byExit: byKind,
    years,
  };
}

/**
 * The previous app's rules, for an honest before/after comparison:
 * log-ratio (β = 1), z from a rolling window mean/std, enter |z| ≥ 1.5,
 * exit only at |z| < 0.1 — no stop, no time limit, no gates, fixed notional.
 */
export function legacyConfig(windowBars) {
  return {
    model: { hedge: "ratio", zMethod: "rolling", formationBars: windowBars, longFormationBars: windowBars, recalEvery: 1 },
    gates: { maxCointP: 1, minHalfLifeBars: 0, maxHalfLifeBars: Infinity, maxHurst: Infinity, minCorr: -1, minCorrShort: -1, maxVolRatio: Infinity, minBeta: 0, maxBeta: Infinity, maxLegMoveSigma: Infinity, maxOpposingLongZ: Infinity },
    entry: { z: 1.5, confirm: "none", minEdgeCostRatio: 0, maxEntryZ: Infinity, cooldownBarsAfterStop: 0 },
    ladder: { enabled: false },
    exit: { z: 0.1, stopZ: Infinity, dollarStopR: Infinity, liveExitRequiresProfit: false, timeStopHalfLives: Infinity, minTimeStopBars: Infinity, maxHoldBars: Infinity, breakCointP: 2, breakConsecutive: Infinity, maxFundingDrainOfEdge: Infinity, rebalanceBetaDrift: 0 },
    risk: { dailyLossLimit: 1, maxDrawdownHalt: 1, consecutiveLossCooldown: Infinity },
  };
}

export { mergeConfig, STRATEGY_DEFAULTS };
