// Worker job for bin/farm.js: one pair → every (formation window × rule) result, IS and OOS.
import { loadPair } from "../data/history.js";
import { computeZ, simulate } from "./farm.js";

const STEP = { "5m": 3e5, "15m": 9e5, "1h": 36e5 };

export async function farmPair(A, B, { interval, formationsH, rules, periods, hedge = "ratio" }) {
  const step = STEP[interval];
  const maxForm = Math.max(...formationsH) * 3600_000;
  const from = Date.parse(periods[0].from) - maxForm - 50 * step;
  const lastTo = periods[periods.length - 1].to ? Date.parse(periods[periods.length - 1].to) : undefined;
  const bars = await loadPair(A, B, { interval, from, to: lastTo });
  if (bars.length < 1000) return { pair: `${A}/${B}`, skipped: "too little data" };
  const out = { pair: `${A}/${B}`, A, B, results: [] };
  for (const fh of formationsH) {
    const fb = Math.round((fh * 3600_000) / step);
    const zs = computeZ(bars, { hedge, formationBars: fb, longFormationBars: fb, recalEvery: Math.max(12, Math.round(fb / 48)), volShortBars: Math.max(12, Math.round(fb / 30)), corrShortBars: Math.max(24, Math.round(fb / 10)), legMoveBars: Math.max(12, Math.round(fb / 30)), volumeAvgBars: fb });
    for (const p of periods) {
      const startT = Date.parse(p.from);
      const endT = p.to ? Date.parse(p.to) : Infinity;
      let endIdx = bars.findIndex((b) => b.t >= endT);
      if (endIdx < 0) endIdx = bars.length;
      if (bars[0].t + fb * step > startT + 30 * 86_400_000) continue; // not enough warm-up inside this period
      const sub = bars.slice(0, endIdx);
      const zsub = Object.fromEntries(Object.entries(zs).map(([k, v]) => [k, v.subarray(0, endIdx)]));
      rules.forEach((r, ri) => {
        const s = simulate(sub, zsub, { ...r, maxHold: Number.isFinite(r.maxHoldF) ? Math.round(r.maxHoldF * fb) : Infinity }, { startT, gross: 10_000 });
        out.results.push({ f: fh, r: ri, p: p.name, g: s.gross, v: s.volume, fu: s.funding, n: s.trades, w: s.wins, st: s.stops, dd: s.maxDD, d: s.days, sh: s.dailySharpe, ex: s.exposure });
      });
    }
  }
  return out;
}

/** Robustness: the same rules at several execution delays (bars between signal and fill). */
export async function farmDelay(A, B, { interval, formationH, rules, periods, delays, hedge = "ratio" }) {
  const step = STEP[interval];
  const fb = Math.round((formationH * 3600_000) / step);
  const from = Date.parse(periods[0].from) - fb * step - 50 * step;
  const bars = await loadPair(A, B, { interval, from });
  if (bars.length < 1000) return { pair: `${A}/${B}`, skipped: true };
  const zs = computeZ(bars, { hedge, formationBars: fb, longFormationBars: fb, recalEvery: Math.max(12, Math.round(fb / 48)), volShortBars: Math.max(12, Math.round(fb / 30)), corrShortBars: Math.max(24, Math.round(fb / 10)), legMoveBars: Math.max(12, Math.round(fb / 30)), volumeAvgBars: fb });
  const out = { pair: `${A}/${B}`, A, B, results: [] };
  for (const p of periods) {
    const startT = Date.parse(p.from), endT = p.to ? Date.parse(p.to) : Infinity;
    let endIdx = bars.findIndex((b) => b.t >= endT); if (endIdx < 0) endIdx = bars.length;
    const sub = bars.slice(0, endIdx);
    const zsub = Object.fromEntries(Object.entries(zs).map(([k, v]) => [k, v.subarray(0, endIdx)]));
    rules.forEach((r, ri) => delays.forEach((d) => {
      const s = simulate(sub, zsub, { ...r, maxHold: Number.isFinite(r.maxHoldF) ? Math.round(r.maxHoldF * fb) : Infinity }, { startT, gross: 10_000, delay: d });
      out.results.push({ r: ri, d, p: p.name, g: s.gross, v: s.volume, dd: s.maxDD, days: s.days, n: s.trades });
    }));
  }
  return out;
}

import { simulateMaker } from "./farm.js";

/** Maker-execution replay: per (formation, rule, period) gross PnL with maker/taker volume split. */
export async function farmMaker(A, B, { interval, formationsH, rules, periods, hedge = "ratio", styles = [["maker", "maker"]] }) {
  const step = STEP[interval];
  const maxForm = Math.max(...formationsH) * 3600_000;
  const from = Date.parse(periods[0].from) - maxForm - 50 * step;
  const bars = await loadPair(A, B, { interval, from });
  if (bars.length < 1000) return { pair: `${A}/${B}`, skipped: true };
  const out = { pair: `${A}/${B}`, A, B, results: [] };
  for (const fh of formationsH) {
    const fb = Math.round((fh * 3600_000) / step);
    const zs = computeZ(bars, { hedge, formationBars: fb, longFormationBars: fb, recalEvery: Math.max(12, Math.round(fb / 48)), volShortBars: Math.max(12, Math.round(fb / 30)), corrShortBars: Math.max(24, Math.round(fb / 10)), legMoveBars: Math.max(12, Math.round(fb / 30)), volumeAvgBars: fb });
    for (const p of periods) {
      const startT = Date.parse(p.from), endT = p.to ? Date.parse(p.to) : Infinity;
      let endIdx = bars.findIndex((b) => b.t >= endT); if (endIdx < 0) endIdx = bars.length;
      const sub = bars.slice(0, endIdx);
      const zsub = Object.fromEntries(Object.entries(zs).map(([k, v]) => [k, v.subarray(0, endIdx)]));
      rules.forEach((r, ri) => styles.forEach(([entryStyle, exitStyle], si) => {
        const s = simulateMaker(sub, zsub, { ...r, maxHold: Number.isFinite(r.maxHoldF) ? Math.round(r.maxHoldF * fb) : Infinity }, { startT, gross: 10_000, entryStyle, exitStyle });
        out.results.push({ f: fh, r: ri, s: si, p: p.name, g: s.gross, fu: s.funding, mv: s.makerVol, tv: s.takerVol, dd: s.maxDD, days: s.days, n: s.trades, lh: s.legHedges, fills: s.fills, posts: s.posts, sh: s.dailySharpe });
      }));
    }
  }
  return out;
}

/** Daily net PnL series for one pair under a taker cost model (for portfolio aggregation). */
export async function farmDaily(A, B, { interval, formationH, rule, from, gross, costBps, hedge = "ratio" }) {
  const step = STEP[interval];
  const fb = Math.round((formationH * 3600_000) / step);
  const bars = await loadPair(A, B, { interval, from: Date.parse(from) - fb * step - 50 * step });
  const zs = computeZ(bars, { hedge, formationBars: fb, longFormationBars: fb, recalEvery: Math.max(12, Math.round(fb / 48)), volShortBars: Math.max(12, Math.round(fb / 30)), corrShortBars: Math.max(24, Math.round(fb / 10)), legMoveBars: Math.max(12, Math.round(fb / 30)), volumeAvgBars: fb });
  const daily = new Map();
  simulate(bars, zs, { ...rule, maxHold: Number.isFinite(rule.maxHoldF) ? Math.round(rule.maxHoldF * fb) : Infinity }, { startT: Date.parse(from), gross, daily });
  const out = [];
  let lg = 0, lv = 0;
  for (const [day, { g, v }] of [...daily.entries()].sort((a, b) => a[0] - b[0])) { out.push([day, g - lg - ((v - lv) * costBps) / 1e4, v - lv]); lg = g; lv = v; }
  return { pair: `${A}/${B}`, days: out };
}
