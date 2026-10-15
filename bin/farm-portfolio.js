#!/usr/bin/env node
// Portfolio view of the farming strategy: every majors pair at once, a fixed
// gross per pair, taker execution at `--cost` bps per side (fee + half-spread).
//
//   node bin/farm-portfolio.js --equity 10000 --gross-per-pair 2000 --cost 0.3
import { writeFile } from "node:fs/promises";
import { parseArgs } from "../src/util/args.js";
import { runPool } from "../src/research/pool.js";

const args = parseArgs(process.argv.slice(2), { interval: "5m", formation: 6, zIn: 1, from: "2025-02-01", equity: 10000, "gross-per-pair": 2000, cost: 0.3 });
const assets = String(args.assets || "BTC,ETH,SOL,BNB,XRP,DOGE").split(",");
const rule = { zIn: +args.zIn, zOut: +args.zIn / 2, zStop: 3.5, gateCointP: 1, maxHoldF: 0.5 };
const mod = new URL("../src/research/farm-jobs.js", import.meta.url).href;
const jobs = [];
const pairList = args.pairs ? String(args.pairs).split(",").map((x) => x.split("/")) : null;
if (pairList) for (const [A, B] of pairList) jobs.push({ mod, fn: "farmDaily", args: [A, B, { interval: args.interval, formationH: +args.formation, rule, from: args.from, gross: +args["gross-per-pair"], costBps: +args.cost }] });
else for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) jobs.push({ mod, fn: "farmDaily", args: [assets[i], assets[j], { interval: args.interval, formationH: +args.formation, rule, from: args.from, gross: +args["gross-per-pair"], costBps: +args.cost }] });
const res = (await runPool(jobs)).filter((r) => r && r.days);
const byDay = new Map();
for (const r of res) for (const [d, pnl, vol] of r.days) { const x = byDay.get(d) || { pnl: 0, vol: 0 }; x.pnl += pnl; x.vol += vol; byDay.set(d, x); }
const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
let eq = +args.equity, peak = eq, maxDD = 0, worst = 0, best = 0, vol = 0, pnl = 0;
const curve = [];
const monthly = new Map();
for (const [d, x] of days) {
  eq += x.pnl; pnl += x.pnl; vol += x.vol;
  peak = Math.max(peak, eq); maxDD = Math.max(maxDD, 1 - eq / peak);
  worst = Math.min(worst, x.pnl); best = Math.max(best, x.pnl);
  curve.push([d * 864e5, Math.round(eq * 100) / 100]);
  const m = new Date(d * 864e5).toISOString().slice(0, 7);
  const mm = monthly.get(m) || { pnl: 0, vol: 0 }; mm.pnl += x.pnl; mm.vol += x.vol; monthly.set(m, mm);
}
const daily = days.map(([, x]) => x.pnl);
const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / (daily.length - 1));
console.log(`${res.length} pairs (${pairList ? res.map((r) => r.pair).join(", ") : assets.join(", ")}), ${args.interval}, ${args.formation}h window, zIn ${args.zIn}, $${args["gross-per-pair"]} gross per pair (${(res.length * args["gross-per-pair"] / args.equity).toFixed(1)}× equity), cost ${args.cost} bp/side`);
console.log(`days ${days.length}  volume $${(vol / 1e6).toFixed(1)}M ($${Math.round(vol / days.length).toLocaleString()}/day)  net PnL $${pnl.toFixed(0)}  = $${((pnl / vol) * 1e6).toFixed(1)} per $1M`);
console.log(`max drawdown ${(maxDD * 100).toFixed(2)}% of equity  worst day $${worst.toFixed(0)}  best day $${best.toFixed(0)}  daily Sharpe(ann.) ${((mean / sd) * Math.sqrt(365)).toFixed(2)}`);
console.log("month    net PnL   volume     $/1M");
for (const [m, x] of monthly) console.log(`${m}  ${x.pnl.toFixed(0).padStart(8)}  $${(x.vol / 1e6).toFixed(1).padStart(6)}M  ${((x.pnl / x.vol) * 1e6).toFixed(1).padStart(7)}`);
await writeFile(`research/farm-portfolio-${args.interval}-${args.formation}h-z${args.zIn}-c${args.cost}.json`, JSON.stringify({ args, pairs: res.map((r) => r.pair), curve, monthly: [...monthly] }, null, 0));
