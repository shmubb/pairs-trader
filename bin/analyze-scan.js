#!/usr/bin/env node
// Does anything we can measure in-sample predict out-of-sample profit?
//
//   node bin/analyze-scan.js research/scan-1h.json
//
// Ranks pairs several ways using only in-sample (IS) information, then reports
// how each ranking's top picks did out-of-sample (OOS). A selection rule is
// only worth using if its picks beat the average pair OOS.

import { readFile } from "node:fs/promises";
import { loadUniverse } from "../src/data/history.js";

const path = process.argv[2] || "research/scan-1h.json";
const scan = JSON.parse(await readFile(path, "utf8"));
const uni = Object.fromEntries((await loadUniverse()).map((a) => [a.id, a]));
const rows = scan.results.filter((r) => r.is && r.oos);

function spearman(x, y) {
  const rank = (v) => { const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); idx.forEach(([, i], k) => (r[i] = k)); return r; };
  const rx = rank(x), ry = rank(y), n = x.length;
  const mx = (n - 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - mx); dx += (rx[i] - mx) ** 2; dy += (ry[i] - mx) ** 2; }
  return num / Math.sqrt(dx * dy);
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const pctPos = (xs) => xs.filter((x) => x > 0).length / (xs.length || 1);

console.log(`${rows.length} pairs with both IS and OOS data (${scan.periods.map((p) => `${p.name}: ${p.from}→${p.to || "now"}`).join(", ")})\n`);
const oosRet = rows.map((r) => r.oos.ret);
console.log(`ALL PAIRS   IS: mean ret ${(avg(rows.map((r) => r.is.ret)) * 100).toFixed(2)}%  profitable ${(pctPos(rows.map((r) => r.is.ret)) * 100).toFixed(0)}%   OOS: mean ret ${(avg(oosRet) * 100).toFixed(2)}%  profitable ${(pctPos(oosRet) * 100).toFixed(0)}%  mean Sharpe ${avg(rows.map((r) => r.oos.sharpe)).toFixed(2)}`);

const rules = {
  "IS Sharpe": (r) => r.is.trades >= 8 ? r.is.sharpe : -9,
  "IS return": (r) => r.is.ret,
  "IS profit factor": (r) => r.is.trades >= 8 ? Math.min(r.is.pf, 5) : -9,
  "cointegrated % of time": (r) => r.is.cointFrac05,
  "cointegrated % (p<.10)": (r) => r.is.cointFrac10,
  "median correlation": (r) => r.is.medCorr,
  "fast half-life": (r) => -r.is.medHalfLife,
  "low Hurst": (r) => -r.is.medHurst,
  "stable β (low IQR)": (r) => -r.is.betaIQR,
  "composite (coint+corr+HL)": (r) => r.is.cointFrac10 * 2 + r.is.medCorr - r.is.medHalfLife / 100,
};
console.log(`\n${"selection rule (IS only)".padEnd(28)} ρ(IS score, OOS ret)   top 10: OOS mean ret / %profitable    top 25: OOS mean ret / %profitable`);
for (const [name, fn] of Object.entries(rules)) {
  const scored = rows.map((r) => ({ r, s: fn(r) })).filter((x) => Number.isFinite(x.s));
  const rho = spearman(scored.map((x) => x.s), scored.map((x) => x.r.oos.ret));
  const sorted = scored.sort((a, b) => b.s - a.s);
  const t10 = sorted.slice(0, 10).map((x) => x.r.oos.ret), t25 = sorted.slice(0, 25).map((x) => x.r.oos.ret);
  console.log(`${name.padEnd(28)} ${rho.toFixed(3).padStart(8)}               ${(avg(t10) * 100).toFixed(2).padStart(6)}% / ${(pctPos(t10) * 100).toFixed(0).padStart(3)}%                 ${(avg(t25) * 100).toFixed(2).padStart(6)}% / ${(pctPos(t25) * 100).toFixed(0).padStart(3)}%`);
}

// Sector structure.
const group = (r) => {
  const a = uni[r.A], b = uni[r.B];
  if (a.tradfi || b.tradfi) return "involves TradFi";
  if (a.sector === b.sector) return `same sector`;
  if (a.sector === "major" || b.sector === "major") return "vs BTC/ETH";
  return "cross sector";
};
const groups = {};
for (const r of rows) (groups[group(r)] ||= []).push(r);
console.log(`\n${"group".padEnd(18)} n     IS ret   IS %pos   OOS ret   OOS %pos   coint% (IS)`);
for (const [g, rs] of Object.entries(groups)) {
  console.log(`${g.padEnd(18)} ${String(rs.length).padStart(4)}  ${(avg(rs.map((r) => r.is.ret)) * 100).toFixed(2).padStart(6)}%  ${(pctPos(rs.map((r) => r.is.ret)) * 100).toFixed(0).padStart(5)}%   ${(avg(rs.map((r) => r.oos.ret)) * 100).toFixed(2).padStart(6)}%  ${(pctPos(rs.map((r) => r.oos.ret)) * 100).toFixed(0).padStart(6)}%   ${(avg(rs.map((r) => r.is.cointFrac05)) * 100).toFixed(0).padStart(5)}%`);
}

// Pairs that were good in BOTH halves — the only ones worth trusting.
const both = rows.filter((r) => r.is.ret > 0 && r.oos.ret > 0 && r.is.trades >= 8 && r.oos.trades >= 5).sort((a, b) => (b.is.sharpe + b.oos.sharpe) - (a.is.sharpe + a.oos.sharpe));
console.log(`\nProfitable in both IS and OOS (≥8 IS trades, ≥5 OOS trades): ${both.length} of ${rows.length} (${(both.length / rows.length * 100).toFixed(1)}%; ~${(pctPos(rows.map((r) => r.is.ret)) * pctPos(oosRet) * 100).toFixed(0)}% expected if independent)`);
console.log(`${"pair".padEnd(14)} IS: Sharpe  ret%   DD%  n  | OOS: Sharpe  ret%   DD%  n  | coint%  HL   corr`);
for (const r of both.slice(0, 30)) {
  console.log(`${r.pair.padEnd(14)} ${r.is.sharpe.toFixed(2).padStart(10)} ${(r.is.ret * 100).toFixed(1).padStart(5)} ${(r.is.maxDD * 100).toFixed(1).padStart(5)} ${String(r.is.trades).padStart(3)}  | ${r.oos.sharpe.toFixed(2).padStart(10)} ${(r.oos.ret * 100).toFixed(1).padStart(5)} ${(r.oos.maxDD * 100).toFixed(1).padStart(5)} ${String(r.oos.trades).padStart(3)}  | ${(r.is.cointFrac05 * 100).toFixed(0).padStart(5)} ${r.is.medHalfLife.toFixed(0).padStart(4)} ${r.is.medCorr.toFixed(2).padStart(6)}`);
}

// TradFi-only pairs have no IS period; report their single window separately.
const tf = scan.results.filter((r) => !r.is && r.oos && (uni[r.A].tradfi || uni[r.B].tradfi)).sort((a, b) => b.oos.sharpe - a.oos.sharpe);
if (tf.length) {
  console.log(`\nTradFi pairs (only ~6-10 months of history, OOS window only — treat as anecdotes):`);
  for (const r of tf.slice(0, 15)) console.log(`${r.pair.padEnd(14)} Sharpe ${r.oos.sharpe.toFixed(2).padStart(6)}  ret ${(r.oos.ret * 100).toFixed(1).padStart(5)}%  DD ${(r.oos.maxDD * 100).toFixed(1)}%  trades ${r.oos.trades}  coint% ${(r.oos.cointFrac05 * 100).toFixed(0)}  HL ${r.oos.medHalfLife?.toFixed(0)}  corr ${r.oos.medCorr?.toFixed(2)}`);
}
