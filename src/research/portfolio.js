// Multi-asset portfolio backtester for directional / cross-sectional strategies.
//
// A strategy is a function called on each bar close that returns target
// weights (fraction of equity per asset, signed). The backtester:
//   - moves to those weights at the NEXT bar's open (no look-ahead),
//   - charges `costBps` per side on every $ traded (fee + slippage),
//   - pays/receives real funding each hour it settles (longs pay positive),
//   - marks to market on closes.
// Bars are resampled from the hourly cache (1h, 4h, 1d...).

import { loadAsset } from "../data/history.js";
import { buildMatrix, ret, realVol, fundSum } from "../core/matrix.js";

export { ret, realVol, fundSum };
const H = 3600_000;

/** Load hourly candles + funding for many assets from the cache onto one clock, resampled to `barH` hours. */
export async function loadMatrix(assets, { barH = 24, from, to, offsetH = 0 } = {}) {
  const series = {};
  for (const a of assets) { try { series[a] = await loadAsset(a, "1h"); } catch { /* not downloaded */ } }
  return buildMatrix(series, { barH, from, to, offsetH });
}

/**
 * strategy(ctx) → {asset: weight}. ctx = {k, m, ids, history helpers}. Called after bar k closes.
 * opts: {costBps, startT, endT, maxGross, band}. `band` skips resizing a position
 * when the change is smaller than that fraction of the target.
 */
export function runPortfolio(m, strategy, { costBps = 6, startT = 0, endT = Infinity, maxGross = 3, equity0 = 1, band = 0 } = {}) {
  const { ids } = m;
  const nb = m.t.length;
  let eq = equity0;
  let w = Object.fromEntries(ids.map((a) => [a, 0])); // current weights (at last mark)
  let target = null;
  let turnover = 0, costs = 0, funding = 0, grossSum = 0, bars = 0;
  const curve = [], times = [];
  if (nb && m.t[0] >= startT - m.barH * H && m.t[0] <= endT) target = strategy({ k: 0, m, ids, w });
  for (let k = 1; k < nb; k++) {
    const t = m.t[k];
    if (t > endT) break;
    const active = t >= startT;
    // 1) previous close → this open with old weights
    let r1 = 0;
    for (const a of ids) {
      if (!w[a]) continue;
      const c0 = m.c[a][k - 1], o1 = m.o[a][k];
      if (c0 > 0 && o1 > 0) r1 += w[a] * (o1 / c0 - 1);
    }
    eq *= 1 + r1;
    for (const a of ids) { // drift weights
      const c0 = m.c[a][k - 1], o1 = m.o[a][k];
      if (w[a] && c0 > 0 && o1 > 0) w[a] *= (o1 / c0) / (1 + r1);
    }
    // 2) rebalance at the open
    if (target && active) {
      let gross = 0;
      for (const a of ids) gross += Math.abs(target[a] || 0);
      const scale = gross > maxGross ? maxGross / gross : 1;
      let traded = 0;
      for (const a of ids) {
        let tw = m.o[a][k] > 0 ? (target[a] || 0) * scale : 0;
        // No-trade band: skip small resizes of an open position (cuts turnover).
        if (band > 0 && tw !== 0 && Math.sign(tw) === Math.sign(w[a]) && Math.abs(tw - w[a]) < band * Math.abs(tw)) tw = w[a];
        traded += Math.abs(tw - w[a]);
        w[a] = tw;
      }
      const cost = traded * costBps / 1e4;
      eq *= 1 - cost;
      turnover += traded; costs += cost;
    }
    target = null;
    // 3) open → close, plus funding settled in this bar
    let r2 = 0, fr = 0;
    for (const a of ids) {
      if (!w[a]) continue;
      const o1 = m.o[a][k], c1 = m.c[a][k];
      if (o1 > 0 && c1 > 0) r2 += w[a] * (c1 / o1 - 1);
      else { w[a] = 0; continue; } // asset missing: flat
      fr += -w[a] * m.fund[a][k];
    }
    eq *= 1 + r2 + fr;
    funding += fr;
    for (const a of ids) {
      const o1 = m.o[a][k], c1 = m.c[a][k];
      if (w[a] && o1 > 0 && c1 > 0) w[a] *= (c1 / o1) / (1 + r2);
    }
    if (active) {
      curve.push(eq); times.push(t);
      let g = 0; for (const a of ids) g += Math.abs(w[a]); grossSum += g; bars++;
    }
    // 4) strategy decides on this close
    if (active || t >= startT - m.barH * H) target = strategy({ k, m, ids, w });
    if (eq <= 0) break;
  }
  return { ...stats(curve, times, m.barH), turnoverPerYear: turnover / (bars || 1) * (8760 / m.barH), costsTotal: costs, fundingTotal: funding, avgGross: grossSum / (bars || 1), curve, times };
}

export function stats(curve, times, barH) {
  if (curve.length < 2) return { sharpe: 0, cagr: 0, maxDD: 0, total: 0, years: 0, byYear: {} };
  const rets = [];
  for (let i = 1; i < curve.length; i++) rets.push(curve[i] / curve[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
  const perYear = 8760 / barH;
  let peak = curve[0], maxDD = 0;
  for (const v of curve) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, 1 - v / peak); }
  const years = curve.length / perYear;
  const total = curve[curve.length - 1] / curve[0] - 1;
  const byYear = {};
  let yStart = curve[0], yKey = new Date(times[0]).getUTCFullYear();
  for (let i = 1; i < curve.length; i++) {
    const y = new Date(times[i]).getUTCFullYear();
    if (y !== yKey) { byYear[yKey] = curve[i - 1] / yStart - 1; yStart = curve[i - 1]; yKey = y; }
  }
  byYear[yKey] = curve[curve.length - 1] / yStart - 1;
  return {
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(perYear) : 0,
    vol: sd * Math.sqrt(perYear),
    cagr: years > 0 ? Math.pow(Math.max(1e-9, 1 + total), 1 / years) - 1 : 0,
    maxDD, total, years, byYear,
    calmar: maxDD > 0 ? (Math.pow(Math.max(1e-9, 1 + total), 1 / Math.max(years, 1e-9)) - 1) / maxDD : 0,
  };
}
