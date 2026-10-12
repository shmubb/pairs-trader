// Research jobs, run inside worker threads by bin/scan.js and bin/research.js.

import { loadPair } from "../data/history.js";
import { runBacktest, legacyConfig } from "../core/backtest.js";
import { mergeConfig } from "../core/strategy.js";
import { median, quantile } from "../core/stats.js";
import { scaleConfig } from "../core/timeframe.js";

const DAY = 86_400_000;

function summarize(res) {
  const m = res.metrics;
  if (!m) return null;
  const r = res.recals;
  return {
    ret: m.totalReturn, cagr: m.cagr, sharpe: m.sharpe, maxDD: m.maxDrawdown, trades: m.trades,
    win: m.winRate, pf: Number.isFinite(m.profitFactor) ? m.profitFactor : 99, avgR: m.avgR, worst: m.worstTrade,
    hold: m.avgBarsHeld, exposure: m.exposure, fees: m.fees, funding: m.funding,
    exits: Object.fromEntries(Object.entries(m.byExit).map(([k, v]) => [k, v.n])),
    cointFrac05: r.length ? r.filter((x) => x.cointP < 0.05).length / r.length : null,
    cointFrac10: r.length ? r.filter((x) => x.cointP < 0.10).length / r.length : null,
    medHalfLife: r.length ? median(r.map((x) => x.halfLife)) : null,
    medCorr: r.length ? median(r.map((x) => x.corr)) : null,
    medBeta: r.length ? median(r.map((x) => x.beta)) : null,
    betaIQR: r.length ? quantile(r.map((x) => x.beta), 0.75) - quantile(r.map((x) => x.beta), 0.25) : null,
    medHurst: r.length ? median(r.map((x) => x.hurst)) : null,
    medSigma: r.length ? median(r.map((x) => x.sigmaEq)) : null,
    years: m.years,
  };
}

/**
 * Backtest one pair over each period. periods: [{name, from, to}] (ISO dates).
 * Each period gets its own warm-up so no information crosses period boundaries
 * except through the model's formation window (which only looks back).
 */
export async function scanPair(A, B, cfg, periods, { interval = "1h", legacy = false, minBars = 2000, keepTrades = false } = {}) {
  let c = scaleConfig(cfg, interval);
  if (legacy) c = mergeConfig(cfg, legacyConfig(interval === "15m" ? 96 : 24));
  const step = interval === "15m" ? 900_000 : 3600_000;
  const warm = (c.model.longFormationBars + 50) * step;
  const out = { pair: `${A}/${B}`, A, B };
  for (const p of periods) {
    const from = Date.parse(p.from), to = p.to ? Date.parse(p.to) : undefined;
    const bars = await loadPair(A, B, { interval, from: from - warm, to });
    const tradable = bars.filter((b) => b.t >= from).length;
    if (bars.length < c.model.longFormationBars + minBars || tradable < minBars) { out[p.name] = null; continue; }
    const startT = Math.max(from, bars[0].t + warm);
    const res = runBacktest(bars, c, { startT, equity: 10_000, fixedNotional: legacy ? 20_000 : null, collectRecal: true, liquidity: true });
    out[p.name] = summarize(res);
    if (out[p.name]) out[p.name].start = new Date(startT).toISOString().slice(0, 10);
    if (keepTrades) out[p.name + "Trades"] = res.trades.map((t) => ({ openT: t.openT, closeT: t.closeT, dir: t.dir, z: t.entryZ, pnl: t.pnl, r: t.r, ret: t.ret, kind: t.kind, bars: t.bars, adds: t.adds, hourUtc: t.hourUtc, dow: t.dow, rvA: t.rvA, rvB: t.rvB, legMove: t.legMove, legMoveA: t.legMoveA, legMoveB: t.legMoveB, signalT: t.signalT, volRatio: t.volRatio, zLong: t.zLong, halfLife: t.halfLife, cointP: t.cointP }));
    if (keepTrades) out[p.name + "Equity"] = downsample(res.equity.slice(bars.findIndex((b) => b.t >= startT)), res.times.slice(bars.findIndex((b) => b.t >= startT)), 400);
  }
  return out;
}

function downsample(eq, times, n) {
  const step = Math.max(1, Math.floor(eq.length / n));
  const out = [];
  for (let i = 0; i < eq.length; i += step) out.push([times[i], Math.round(eq[i] * 100) / 100]);
  if (eq.length) out.push([times[eq.length - 1], Math.round(eq[eq.length - 1] * 100) / 100]);
  return out;
}

export { DAY };
