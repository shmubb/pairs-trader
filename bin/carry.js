#!/usr/bin/env node
// Funding-carry basket research (see src/research/carry.js).
//
//   node bin/carry.js                      # grid over rebalance/lookback/k, IS 2022-24, OOS 2025-26
//
// Reports, per configuration: price PnL, funding earned, volume, edge per $
// traded (bps), annual return on gross notional, Sharpe and drawdown.

import { writeFile } from "node:fs/promises";
import { loadAsset, loadUniverse } from "../src/data/history.js";
import { runCarry } from "../src/research/carry.js";
import { parseArgs } from "../src/util/args.js";

const args = parseArgs(process.argv.slice(2), { is: "2022-03-01:2025-01-01", oos: "2025-01-01:", top: 25 });
const uni = (await loadUniverse()).filter((a) => !a.tradfi && (!args.assets || String(args.assets).split(",").includes(a.id)));

// Align every asset on one hourly clock; missing hours = 0 price (skipped).
const data = {};
for (const a of uni) { try { data[a.id] = await loadAsset(a.id, "1h"); } catch { /* not downloaded */ } }
const assets = Object.keys(data);
const t0 = Math.min(...assets.map((a) => data[a].k[0].t)), t1 = Math.max(...assets.map((a) => data[a].k[data[a].k.length - 1].t));
const times = [];
for (let t = t0; t <= t1; t += 3600_000) times.push(t);
const idx = new Map(times.map((t, i) => [t, i]));
const series = {};
for (const a of assets) {
  const c = new Float64Array(times.length), fund = new Float64Array(times.length);
  for (const r of data[a].k) { const i = idx.get(r.t); if (i != null) c[i] = r.c; }
  for (const f of data[a].funding) { const h = f.t - (f.t % 3600_000); const i = idx.get(h); if (i != null) fund[i] += f.rate; }
  series[a] = { c, fund };
}
console.log(`${assets.length} assets, ${times.length} hours`);

const [isFrom, isTo] = String(args.is).split(":"), [oosFrom, oosTo] = String(args.oos).split(":");
const periods = { is: [Date.parse(isFrom), isTo ? Date.parse(isTo) : Infinity], oos: [Date.parse(oosFrom), oosTo ? Date.parse(oosTo) : Infinity] };
const rows = [];
for (const rebalanceH of [8, 24, 72, 168]) for (const lookbackH of [24, 72, 168]) for (const k of [2, 4, 6]) for (const hysteresis of [0, 3]) for (const minSpreadBps of [0, 2]) {
  const cfg = { rebalanceH, lookbackH, k, hysteresis, minSpreadBps, gross: 10_000 };
  const r = {};
  for (const [p, [s, e]] of Object.entries(periods)) r[p] = runCarry(times, series, assets, { ...cfg, startT: s, endT: e });
  rows.push({ cfg, ...r });
}
await writeFile("research/carry-1h.json", JSON.stringify({ generated: new Date().toISOString(), assets, rows }, null, 0));

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const line = (r) => {
  const c = r.cfg, s = (x) => `${f(x.grossBps, 1).padStart(6)} ${f(x.fundingBps, 1).padStart(6)} ${("$" + Math.round(x.volumePerDay)).padStart(7)} ${f(x.annualReturnOnGross * 100, 1).padStart(6)}% ${f(x.dailySharpe).padStart(6)} ${("$" + Math.round(x.maxDD)).padStart(6)}`;
  return `reb ${String(c.rebalanceH).padStart(3)}h look ${String(c.lookbackH).padStart(3)}h k${c.k} hys${c.hysteresis} min${c.minSpreadBps} | ${s(r.is)} | ${s(r.oos)}`;
};
console.log(`${"config".padEnd(35)} | IS: net bp  fund bp  vol/day  ann%   Sharpe  maxDD | OOS: net bp  fund bp  vol/day  ann%   Sharpe  maxDD   (per $10k gross, before trading fees)`);
console.log("— best by min(IS, OOS) Sharpe —");
for (const r of [...rows].sort((a, b) => Math.min(b.is.dailySharpe, b.oos.dailySharpe) - Math.min(a.is.dailySharpe, a.oos.dailySharpe)).slice(0, args.top)) console.log(line(r));
console.log("— most volume with positive edge both periods —");
for (const r of rows.filter((r) => r.is.grossBps > 0 && r.oos.grossBps > 0).sort((a, b) => b.oos.volumePerDay - a.oos.volumePerDay).slice(0, 10)) console.log(line(r));
