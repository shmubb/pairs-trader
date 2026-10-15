#!/usr/bin/env node
// Research for the OI-backed momentum strategy (docs/OI_MOMENTUM.md).
//
//   node bin/fetch-data.js --interval 5m --from 2022-01 --funding false --assets BTC,ETH,...   # 5-minute candles
//   node bin/fetch-data.js --metrics --assets BTC,ETH,...                                      # open interest (5-minute snapshots)
//   node --max-old-space-size=8000 bin/oi-momentum.js [--interval 5m|1h] [--cost 6]
//
// Replays the trigger (src/core/oi-momentum.js) with real sizing, compounding,
// costs and funding, in-sample (2022–2024) and out-of-sample (2025 →), plus a
// neighbourhood of every parameter. Writes research/oi-momentum-<interval>.json.

import { writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "../src/util/args.js";
import { loadBars, simulateTrades, curveStats } from "../src/research/intraday.js";
import { oimTrigger, OIM_DEFAULTS } from "../src/core/oi-momentum.js";

const args = parseArgs(process.argv.slice(2), { interval: "5m", cost: 6, from: "2022-01-01", split: "2025-01-01", assets: "BTC,ETH,SOL,BNB,XRP,DOGE,ADA,AVAX,LINK,DOT,LTC,BCH,NEAR,ATOM,OP,ARB,AAVE,UNI,ETC,FIL" });
const ids = String(args.assets).split(",");
const t0 = Date.now();
const m = await loadBars(ids, { from: new Date(Date.parse(args.from) - 30 * 864e5).toISOString().slice(0, 10), interval: args.interval });
console.log(`${m.ids.length} assets, ${m.t.length} ${args.interval} bars, loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
const from = Date.parse(args.from), split = Date.parse(args.split);
const pc = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + "%" : "—");

function run(p, sim = {}, s = from, e = Infinity) {
  const P = { ...OIM_DEFAULTS, ...p };
  const r = simulateTrades(m, (a, k) => { const t = oimTrigger(m, a, k, P); return t ? t.dir : 0; }, {
    startT: s, endT: e, uni: { topN: P.topN, minAdv: P.minAdv }, holdH: P.holdH, riskPerTrade: P.riskPerTrade, maxGross: P.maxGross, costBps: args.cost, ...sim,
  });
  const st = curveStats(r.curve, r.times, m.bph);
  const tr = r.trades;
  return { ...st, trades: tr.length, perDay: tr.length / ((r.times.at(-1) - r.times[0]) / 864e5), win: tr.filter((t) => t.ret > 0).length / tr.length, avgBp: (tr.reduce((q, t) => q + t.ret, 0) / tr.length) * 1e4, curve: r.curve, times: r.times, list: tr };
}

const variants = [["default", {}]];
for (const zMin of [2, 3]) variants.push([`zMin ${zMin}`, { zMin }]);
for (const oiMin of [0.02, 0.04]) variants.push([`oiMin ${oiMin * 100}%`, { oiMin }]);
for (const holdH of [6, 12]) variants.push([`hold ${holdH}h`, { holdH }]);
variants.push(["no 15-min lookback", { lookbacksH: [1, 4, 12] }], ["no 12-h lookback", { lookbacksH: [0.25, 1, 4] }]);
variants.push(["US hours only (12–20 UTC)", { hoursUTC: [12, 20] }], ["longs and shorts", { sides: [1, -1] }], ["top 10 coins", { topN: 10 }]);
variants.push(["risk 0.5%/trade, gross ≤ 1.5×", { riskPerTrade: 0.005, maxGross: 1.5 }]);

const rows = [];
for (const [name, p] of variants) {
  const is = run(p, {}, from, split), oos = run(p, {}, split);
  rows.push({ name, p, is: strip(is), oos: strip(oos) });
  console.log(`${name.padEnd(32)} IS CAGR ${pc(is.cagr).padStart(6)} Sh ${is.sharpe.toFixed(2).padStart(5)} DD ${pc(is.maxDD).padStart(5)} ${is.perDay.toFixed(1)}/d avg ${is.avgBp.toFixed(0)}bp | OOS CAGR ${pc(oos.cagr).padStart(6)} Sh ${oos.sharpe.toFixed(2).padStart(5)} DD ${pc(oos.maxDD).padStart(5)} ${oos.perDay.toFixed(1)}/d avg ${oos.avgBp.toFixed(0)}bp`);
}
const full = run({});
const months = new Map(); full.times.forEach((t, i) => months.set(new Date(t).toISOString().slice(0, 7), full.curve[i]));
let prev = 1; const monthly = {}; for (const [k, v] of months) { monthly[k] = v / prev - 1; prev = v; }
console.log(`\nfull period: CAGR ${pc(full.cagr)}, Sharpe ${full.sharpe.toFixed(2)}, max DD ${pc(full.maxDD)}, positive months ${pc(full.posMonths, 0)}, positive weeks ${pc(full.posWeeks, 0)}, worst week ${pc(full.worstWeek)}, worst month ${pc(full.worstMonth)}`);
console.log(`by year: ${Object.entries(full.byYear).map(([y, r]) => `${y} ${pc(r, 0)}`).join(", ")}`);
const wins = full.list.filter((t) => t.ret > 0), losses = full.list.filter((t) => t.ret <= 0);
console.log(`trades ${full.trades} (${full.perDay.toFixed(1)}/day), win ${pc(full.win, 0)}, avg win ${pc(wins.reduce((q, t) => q + t.ret, 0) / wins.length, 2)}, avg loss ${pc(losses.reduce((q, t) => q + t.ret, 0) / losses.length, 2)}`);

await mkdir("research", { recursive: true });
await writeFile(`research/oi-momentum-${args.interval}${args.cost !== 6 ? `-c${args.cost}` : ""}.json`, JSON.stringify({ generated: new Date().toISOString(), args, defaults: OIM_DEFAULTS, rows, full: strip(full), monthly }));

function strip(r) { const { curve, times, list, ...rest } = r; return rest; }
