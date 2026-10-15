#!/usr/bin/env node
// Short-horizon strategy search on hourly bars (holds of 1 hour → 2 days).
//
//   node bin/short-term.js [--from 2022-01-01] [--split 2025-01-01] [--only flow]
//
// For every candidate it reports the gross edge per $ traded (bp) — the number
// that has to beat the cost per side (≈ 6 bp taker on Hyperliquid, ≈ 2 bp maker) —
// and the net Sharpe at both costs, in-sample (from → split) and out-of-sample (split →).
// A negative edge on a symmetric signal means the opposite trade (fade instead of follow) earns it.

import { writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "../src/util/args.js";
import { loadUniverse } from "../src/data/history.js";
import { loadHourly, backtest, summarize, event, every } from "../src/research/intraday.js";

const args = parseArgs(process.argv.slice(2), { from: "2022-01-01", split: "2025-01-01", topN: 20, minAdv: 50e6 });
const NON_CRYPTO = new Set(["gold", "silver", "equity", "btc-equity", "index"]);
const ids = (await loadUniverse()).filter((a) => !NON_CRYPTO.has(a.sector)).map((a) => a.id);
const t0 = Date.now();
const m = await loadHourly(ids, { from: "2021-11-01" });
console.log(`${m.ids.length} assets, ${m.t.length} hourly bars, loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ---- helpers (all causal: use bars ≤ k)
const lr = (a, k, L) => { const c1 = m.c[a][k], c0 = m.c[a][k - L]; return c1 > 0 && c0 > 0 ? Math.log(c1 / c0) : NaN; };
const z = (a, k, L) => lr(a, k, L) / (m.sig[a][k] * Math.sqrt(L));
// taker-buy share of volume over L bars, minus its own trailing 7-day mean
const flowMean = {};
for (const a of m.ids) {
  const n = m.t.length, out = new Float64Array(n).fill(NaN);
  let s = 0, cnt = 0;
  for (let k = 0; k < n; k++) {
    const x = m.v[a][k] > 0 ? m.tbv[a][k] / m.v[a][k] : NaN;
    if (Number.isFinite(x)) { s += x; cnt++; }
    if (k >= 168) { const y = m.v[a][k - 168] > 0 ? m.tbv[a][k - 168] / m.v[a][k - 168] : NaN; if (Number.isFinite(y)) { s -= y; cnt--; } }
    if (cnt > 100) out[k] = s / cnt;
  }
  flowMean[a] = out;
}
const flow = (a, k, L) => { let b = 0, v = 0; for (let i = k - L + 1; i <= k; i++) { b += m.tbv[a][i]; v += m.v[a][i]; } return v > 0 ? b / v - flowMean[a][k] : NaN; };
const doi = (a, k, L) => { const o1 = m.oi[a][k], o0 = m.oi[a][k - L]; return o1 > 0 && o0 > 0 ? o1 / o0 - 1 : NaN; };
const sgn = (x) => (Number.isFinite(x) ? Math.sign(x) : 0);

// ---- candidates
const C = [];
for (const L of [1, 4, 12, 24, 48]) for (const Hh of [1, 4, 12, 24]) C.push([`tsmom L${L} H${Hh}`, () => every((a, k) => sgn(lr(a, k, L)), Hh)]);
for (const L of [1, 4, 12, 24]) for (const Hh of [1, 4, 12, 24]) C.push([`xs-mom L${L} H${Hh}`, () => (k, el) => {
  if (k % Hh) return null;
  const sc = el.map((a) => [a, z(a, k, L)]).filter(([, x]) => Number.isFinite(x)).sort((p, q) => q[1] - p[1]);
  const nq = Math.floor(sc.length * 0.3); if (nq < 1) return {};
  const out = {}; sc.slice(0, nq).forEach(([a]) => (out[a] = 1)); sc.slice(-nq).forEach(([a]) => (out[a] = -1)); return out;
}]);
for (const L of [1, 4]) for (const zz of [2, 3, 4]) for (const Hh of [1, 4, 12, 24]) C.push([`shock L${L} z${zz} H${Hh}`, () => event((a, k) => { const x = z(a, k, L); return Math.abs(x) >= zz ? Math.sign(x) : 0; }, Hh)]);
for (const L of [1, 4, 12, 24]) for (const Hh of [1, 4, 12]) C.push([`flow L${L} H${Hh}`, () => every((a, k) => sgn(flow(a, k, L)), Hh)]);
for (const L of [1, 4, 12]) for (const x of [0.02, 0.05]) for (const Hh of [4, 12, 24]) {
  C.push([`oi-flush L${L} drop${x * 100}% H${Hh} (dir=price)`, () => event((a, k) => (doi(a, k, L) <= -x && Math.abs(z(a, k, L)) >= 1 ? sgn(lr(a, k, L)) : 0), Hh)]);
  C.push([`oi-build L${L} rise${x * 100}% H${Hh} (dir=price)`, () => event((a, k) => (doi(a, k, L) >= x && Math.abs(z(a, k, L)) >= 1 ? sgn(lr(a, k, L)) : 0), Hh)]);
}
for (const L of [1, 4]) for (const Hh of [1, 4]) C.push([`lead-lag BTC→alts L${L} H${Hh}`, () => every((a, k) => (a === "BTC" ? 0 : sgn(lr("BTC", k, L) - lr(a, k, L))), Hh)]);

const only = args.only ? new RegExp(String(args.only), "i") : null;
const from = Date.parse(args.from), split = Date.parse(args.split);
const rows = [];
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
console.log(`${"candidate".padEnd(42)} | IS: edge bp  Sh@0  Sh@2  Sh@6 | OOS: edge bp  Sh@0  Sh@2  Sh@6 | trades/d  book turns/d`);
for (const [name, mk] of C) {
  if (only && !only.test(name)) continue;
  const bt = backtest(m, mk(), { startT: from, uni: { topN: args.topN, minAdv: args.minAdv } });
  const r = (c, p) => summarize(bt, c, p);
  const IS = { from, to: split }, OOS = { from: split };
  const row = { name, is: { g: r(0, IS), c2: r(2, IS), c6: r(6, IS) }, oos: { g: r(0, OOS), c2: r(2, OOS), c6: r(6, OOS) } };
  rows.push(row);
  console.log(`${name.padEnd(42)} | ${f(row.is.g.edgeBp).padStart(8)} ${f(row.is.g.sharpe).padStart(5)} ${f(row.is.c2.sharpe).padStart(5)} ${f(row.is.c6.sharpe).padStart(5)} | ${f(row.oos.g.edgeBp).padStart(8)} ${f(row.oos.g.sharpe).padStart(5)} ${f(row.oos.c2.sharpe).padStart(5)} ${f(row.oos.c6.sharpe).padStart(5)} | ${f(row.oos.g.tradesPerDay, 1).padStart(7)} ${f(row.oos.g.bookTurnsPerDay, 2).padStart(8)}`);
}
await mkdir("research", { recursive: true });
await writeFile("research/short-term-1h.json", JSON.stringify({ generated: new Date().toISOString(), args, rows }));
console.log(`wrote research/short-term-1h.json (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
