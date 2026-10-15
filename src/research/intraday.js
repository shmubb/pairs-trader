// Fast short-horizon (minutes → ~2 days) backtester on hourly or 5-minute bars.
//
// A strategy is `step(k) → {asset: s}` (s in [−1, 1]) or null (keep positions),
// called after bar k closes. Positions are risk-scaled (s / trailing hourly vol,
// divided by the number of eligible assets) and held over bar k+1, so there is
// no look-ahead. One pass records gross PnL and turnover separately, so net
// results for any cost level come out of the same run.
//
// `event(fn, holdH)` turns a trigger function into a strategy that holds each
// triggered position for holdH bars.

import { loadAsset, assetById } from "../data/history.js";
import { loadKlines, loadFunding, loadMetrics5m } from "../data/binance-archive.js";
import { buildMatrix } from "../core/matrix.js";
import { barStats } from "../core/oi-momentum.js";

const H = 3600_000;
const BAR_MIN = { "1h": 60, "15m": 15, "5m": 5 };

/**
 * Bars for many assets on one clock, plus per-bar log returns (r), trailing 7-day
 * per-bar vol (sig), trailing 30-day $ volume per day (adv) and open interest at
 * each bar's close (oi). `m.bph` = bars per hour. 1h bars carry funding; 5m/15m
 * bars use the raw 5-minute OI snapshots.
 */
export async function loadBars(ids, { from = "2021-01-01", to, interval = "1h", cacheDir = "data/cache" } = {}) {
  const series = {}, oiMaps = {};
  const bph = 60 / BAR_MIN[interval];
  for (const a of ids) {
    try {
      if (interval === "1h") { const s = await loadAsset(a, "1h"); series[a] = s; oiMaps[a] = s.oi; continue; }
      const info = await assetById(a);
      const k = await loadKlines(info.binance, interval, cacheDir);
      if (!k) continue;
      const fromMs = Date.parse(from);
      series[a] = { k: k.filter((r) => r.t >= fromMs - 864e5), funding: (await loadFunding(info.binance, cacheDir)) || [] };
      const oi5 = await loadMetrics5m(info.binance, cacheDir, { fromDay: new Date(fromMs - 864e5).toISOString().slice(0, 10) });
      if (oi5) { const mp = new Map(); for (const [t, v] of oi5) mp.set(t - BAR_MIN[interval] * 60_000, v); oiMaps[a] = mp; } // keyed by bar start
    } catch { /* not downloaded */ }
  }
  const m = buildMatrix(series, { barH: 1 / bph, from, to });
  m.bph = bph;
  barStats(m);
  // OI at the close of bar k. For 1h, the cached hourly row stamped with the bar start holds the snapshot at the bar's close.
  m.oi = {};
  for (const a of m.ids) {
    const oi = new Float64Array(m.t.length).fill(NaN);
    if (oiMaps[a]) for (let k = 0; k < m.t.length; k++) { const v = oiMaps[a].get(m.t[k]); if (v > 0) oi[k] = v; }
    m.oi[a] = oi;
  }
  return m;
}

export const loadHourly = (ids, opts = {}) => loadBars(ids, { ...opts, interval: "1h" });

/** Eligible assets at k: priced, vol known, top `topN` by 30-day $ volume ≥ minAdv. Cached per day. */
export function eligible(m, k, { topN = 20, minAdv = 50e6 } = {}) {
  const perDay = 24 * (m.bph || 1);
  const day = Math.floor(k / perDay);
  m._elig ||= new Map();
  const key = `${day}|${topN}|${minAdv}`;
  let list = m._elig.get(key);
  if (!list) {
    const k0 = day * perDay;
    list = m.ids.filter((a) => m.adv[a][k0] >= minAdv).sort((x, y) => m.adv[y][k0] - m.adv[x][k0]).slice(0, topN);
    m._elig.set(key, list);
  }
  return list.filter((a) => m.c[a][k] > 0 && m.sig[a][k] > 0);
}

export function backtest(m, step, { startT, endT = Infinity, uni = {}, fundOn = true } = {}) {
  const nb = m.t.length;
  const k0 = Math.max(1, m.t.findIndex((t) => t >= startT));
  const gross = [], turn = [], times = [];
  let w = {};
  let trades = 0, held = 0, gxSum = 0;
  for (let k = k0; k < nb - 1 && m.t[k] < endT; k++) {
    const el = eligible(m, k, uni);
    const tgt = step(k, el);
    let to = 0;
    if (tgt) {
      const nw = {};
      const N = Math.max(el.length, 1);
      for (const a in tgt) {
        const s = tgt[a];
        if (!s || !(m.sig[a][k] > 0)) continue;
        nw[a] = (s * 0.01) / (m.sig[a][k] * N); // 1% hourly-vol units per eligible asset
      }
      for (const a of new Set([...Object.keys(w), ...Object.keys(nw)])) {
        const d = Math.abs((nw[a] || 0) - (w[a] || 0));
        to += d;
        if (!w[a] && nw[a]) trades++;
      }
      w = nw;
    }
    let g = 0, gx = 0;
    for (const a in w) {
      const c0 = m.c[a][k], c1 = m.c[a][k + 1];
      if (c0 > 0 && c1 > 0) g += w[a] * (c1 / c0 - 1);
      if (fundOn) g -= w[a] * m.fund[a][k + 1];
      gx += Math.abs(w[a]);
    }
    if (gx > 0) held++;
    gxSum += gx;
    gross.push(g); turn.push(to); times.push(m.t[k + 1]);
  }
  return { gross, turn, times, trades, held, gxSum, bars: gross.length, bph: m.bph || 1 };
}

/** Summary at a given cost (bp per side), optionally over [from, to): Sharpe, edge per $ traded, by-year Sharpe. */
export function summarize(bt, costBps, { from = -Infinity, to = Infinity } = {}) {
  const c = costBps / 1e4;
  let s = 0, ss = 0, G = 0, T = 0, n = 0;
  const yrs = {};
  for (let i = 0; i < bt.gross.length; i++) {
    const t = bt.times[i];
    if (t < from || t >= to) continue;
    const x = bt.gross[i] - c * bt.turn[i];
    s += x; ss += x * x; G += bt.gross[i]; T += bt.turn[i]; n++;
    const y = new Date(t).getUTCFullYear();
    const Y = (yrs[y] ||= { s: 0, ss: 0, n: 0 });
    Y.s += x; Y.ss += x * x; Y.n++;
  }
  if (!n) return null;
  const bpy = 8760 * (bt.bph || 1), bpd = 24 * (bt.bph || 1);
  const sh = (s, ss, n) => { const mu = s / n, sd = Math.sqrt(Math.max(ss / n - mu * mu, 1e-30)); return (mu / sd) * Math.sqrt(bpy); };
  return {
    sharpe: sh(s, ss, n),
    edgeBp: T > 0 ? (G / T) * 1e4 : 0,          // gross PnL per $ traded, bp: must beat the cost per side
    annRet: (s / n) * bpy,                      // at the backtest's risk scale (≈ 1%/h-vol units)
    bookTurnsPerDay: bt.gxSum > 0 ? (T / (bt.gxSum / bt.gross.length)) / n * bpd : 0,
    tradesPerDay: (bt.trades / bt.gross.length) * bpd,
    exposure: bt.held / bt.gross.length,
    byYear: Object.fromEntries(Object.entries(yrs).map(([y, Y]) => [y, sh(Y.s, Y.ss, Y.n)])),
  };
}

/** Hold each triggered position for holdH bars. trigger(a, k) → +1 / −1 / 0. */
export function event(trigger, holdH) {
  const until = {}, dir = {};
  return (k, el) => {
    for (const a of el) {
      const d = trigger(a, k);
      if (d) { dir[a] = d; until[a] = k + holdH; }
    }
    const out = {};
    for (const a in until) if (until[a] > k && el.includes(a)) out[a] = dir[a];
    return out;
  };
}

/** Re-evaluate a continuous signal every `every` bars, hold in between. sig(a, k) → s. */
export function every(sig, n) {
  return (k, el) => {
    if (k % n) return null;
    const out = {};
    for (const a of el) { const s = sig(a, k); if (s) out[a] = s; }
    return out;
  };
}

export { H };

/**
 * Trade-level simulation with real sizing and compounding (hourly bars).
 * trigger(a, k) → +1/−1/0 at the close of bar k; entry at that close (≈ next open),
 * exit after `holdH` hours, or on a stop `stopSig` × σ × √(hold bars) below entry.
 * Notional = equity × riskPerTrade / (σ_bar × √(hold bars)): a 1σ move over the hold
 * costs `riskPerTrade` of equity. Total gross capped at `maxGross` × equity.
 * Costs: `costBps` per side on notional; funding charged hourly.
 */
export function simulateTrades(m, trigger, { startT, endT = Infinity, holdH = 12, riskPerTrade = 0.01, maxGross = 3, costBps = 6, stopSig = Infinity, uni = {}, maxPerAsset = 1 } = {}) {
  const nb = m.t.length;
  const k0 = Math.max(1, m.t.findIndex((t) => t >= startT));
  const holdBars = Math.round(holdH * (m.bph || 1));
  let eq = 1;
  const open = []; // {a, dir, notional, entry, k, until, stop}
  const trades = [], curve = [], times = [];
  const c = costBps / 1e4;
  for (let k = k0; k < nb - 1 && m.t[k] < endT; k++) {
    // 1) mark open positions over bar k (entered at an earlier close)
    // (done below after entries, for bar k+1)
    // 2) exits due at this close
    for (let i = open.length - 1; i >= 0; i--) {
      const p = open[i], px = m.c[p.a][k];
      const stopHit = p.dir > 0 ? m.l[p.a][k] <= p.stop : m.h[p.a][k] >= p.stop;
      if (k >= p.until || !(px > 0) || stopHit) {
        const exitPx = stopHit ? p.stop : px > 0 ? px : p.last;
        const pnl = p.dir * p.notional * (exitPx / p.last - 1) - p.notional * (exitPx / p.last) * c;
        eq += pnl;
        trades.push({ a: p.a, dir: p.dir, tIn: m.t[p.k], tOut: m.t[k], ret: p.dir * (exitPx / p.entry - 1), pnlEq: (p.pnlAcc + pnl) / p.eqIn, stop: stopHit });
        open.splice(i, 1);
      }
    }
    // 3) new entries at this close
    const el = eligible(m, k, uni);
    let gross = open.reduce((s, p) => s + p.notional, 0);
    for (const a of el) {
      const d = trigger(a, k);
      if (!d) continue;
      const held = open.filter((p) => p.a === a);
      if (held.length >= maxPerAsset) { for (const p of held) if (p.dir === d) p.until = k + holdBars; continue; } // re-trigger extends
      const sH = m.sig[a][k] * Math.sqrt(holdBars);
      let notional = (eq * riskPerTrade) / sH;
      if (gross + notional > maxGross * eq) notional = Math.max(0, maxGross * eq - gross);
      if (notional < eq * 0.001) continue;
      const px = m.c[a][k];
      eq -= notional * c;
      gross += notional;
      open.push({ a, dir: d, notional, entry: px, last: px, k, until: k + holdBars, eqIn: eq, pnlAcc: -notional * c, stop: d > 0 ? px * Math.exp(-stopSig * sH) : px * Math.exp(stopSig * sH) });
    }
    // 4) mark to market over bar k+1 + funding
    for (const p of open) {
      const px = m.c[p.a][k + 1];
      if (!(px > 0)) continue;
      const pnl = p.dir * p.notional * (px / p.last - 1) - p.dir * p.notional * m.fund[p.a][k + 1];
      eq += pnl; p.pnlAcc += pnl;
      p.notional *= px / p.last; p.last = px;
    }
    curve.push(eq); times.push(m.t[k + 1]);
    if (eq <= 0) break;
  }
  return { curve, times, trades };
}

/** Equity-curve stats for hourly curves: CAGR, vol, Sharpe, max DD, share of positive weeks/months, worst week. */
export function curveStats(curve, times, bph = 1) {
  const n = curve.length;
  if (n < 2) return null;
  let s = 0, ss = 0, peak = curve[0], dd = 0;
  for (let i = 1; i < n; i++) { const r = curve[i] / curve[i - 1] - 1; s += r; ss += r * r; peak = Math.max(peak, curve[i]); dd = Math.max(dd, 1 - curve[i] / peak); }
  const mu = s / (n - 1), sd = Math.sqrt(Math.max(ss / (n - 1) - mu * mu, 1e-30));
  const years = (times[n - 1] - times[0]) / (365.25 * 864e5);
  const bucket = (ms) => { const o = new Map(); for (let i = 0; i < n; i++) o.set(Math.floor(times[i] / ms), curve[i]); return [...o.values()]; };
  const per = (vals) => { const r = []; for (let i = 1; i < vals.length; i++) r.push(vals[i] / vals[i - 1] - 1); return r; };
  const wk = per(bucket(7 * 864e5)), mo = [];
  const byMonth = new Map(); for (let i = 0; i < n; i++) byMonth.set(new Date(times[i]).toISOString().slice(0, 7), curve[i]);
  const mv = [...byMonth.values()]; for (let i = 1; i < mv.length; i++) mo.push(mv[i] / mv[i - 1] - 1);
  const byYear = {}; let yStart = curve[0], yKey = new Date(times[0]).getUTCFullYear();
  for (let i = 1; i < n; i++) { const y = new Date(times[i]).getUTCFullYear(); if (y !== yKey) { byYear[yKey] = curve[i - 1] / yStart - 1; yStart = curve[i - 1]; yKey = y; } }
  byYear[yKey] = curve[n - 1] / yStart - 1;
  return {
    cagr: Math.pow(curve[n - 1] / curve[0], 1 / years) - 1, vol: sd * Math.sqrt(8760 * bph), sharpe: (mu / sd) * Math.sqrt(8760 * bph), maxDD: dd,
    posWeeks: wk.filter((x) => x > 0).length / wk.length, posMonths: mo.filter((x) => x > 0).length / mo.length,
    worstWeek: Math.min(...wk), worstMonth: Math.min(...mo), bestMonth: Math.max(...mo), byYear, total: curve[n - 1] / curve[0] - 1,
  };
}
