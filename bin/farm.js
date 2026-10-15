#!/usr/bin/env node
// Volume-farming research: which market-neutral pair rules generate the most
// volume at the lowest cost per $1M traded?
//
//   node bin/farm.js --interval 5m  --assets BTC,ETH,SOL,...   [--is 2025-02-01:2026-01-01 --oos 2026-01-01:]
//   node bin/farm.js --interval 1h
//
// Every rule is replayed per pair with a fixed $10k gross position (both legs).
// Output aggregates across pairs: volume-weighted gross edge (bps of volume),
// volume per day, the share of pairs with positive gross edge, and drawdown —
// in-sample and out-of-sample. research/farm-<interval>.json keeps it all.

import { writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "../src/util/args.js";
import { runPool } from "../src/research/pool.js";

const args = parseArgs(process.argv.slice(2), { interval: "5m", top: 25 });
const DEFAULTS = {
  "5m": { assets: "BTC,ETH,SOL,BNB,XRP,DOGE,LINK,AVAX,LTC,BCH,ADA,DOT,SUI,NEAR,ATOM,OP,ARB,AAVE,UNI", is: "2025-02-01:2026-01-01", oos: "2026-01-01:", formationsH: [6, 24, 72, 168] },
  "15m": { assets: "BTC,ETH,SOL,BNB,XRP,DOGE,LTC,BCH,LINK,AVAX,ARB,OP,AAVE,UNI", is: "2024-03-01:2025-04-01", oos: "2025-04-01:", formationsH: [24, 72, 168, 720] },
  "1h": { assets: "BTC,ETH,SOL,BNB,XRP,DOGE,ADA,AVAX,LINK,DOT,LTC,BCH,ETC,ATOM,NEAR,APT,ARB,OP,INJ,AAVE,UNI,LDO,CRV,FIL,TRX,XLM,HBAR,kSHIB,FET", is: "2022-03-01:2025-01-01", oos: "2025-01-01:", formationsH: [72, 168, 720] },
}[args.interval];
const assets = String(args.assets || DEFAULTS.assets).split(",");
const formationsH = args.formations ? String(args.formations).split(",").map(Number) : DEFAULTS.formationsH;
const [isFrom, isTo] = String(args.is || DEFAULTS.is).split(":");
const [oosFrom, oosTo] = String(args.oos || DEFAULTS.oos).split(":");
const periods = [{ name: "is", from: isFrom, to: isTo || undefined }, { name: "oos", from: oosFrom, to: oosTo || undefined }];

// Rule grid.
const rules = [];
for (const zIn of [0.5, 1, 1.5, 2]) {
  for (const exit of ["mean", "early", "flip"]) {
    for (const zStop of [3.5, Infinity]) {
      for (const gateCointP of [1, 0.2]) {
        for (const maxHoldF of [0.5, Infinity]) {
          if (exit === "flip" && zIn < 1) continue;
          rules.push({ zIn, zOut: exit === "early" ? zIn / 2 : 0, flip: exit === "flip", zStop: Math.max(zStop, zIn + 1), gateCointP, maxHoldF, exit });
        }
      }
    }
  }
}
const ruleName = (r) => `zIn ${r.zIn} ${r.exit}${r.zStop < Infinity ? ` stop${r.zStop}` : ""}${r.gateCointP < 1 ? ` p<${r.gateCointP}` : ""}${r.maxHoldF < Infinity ? ` hold≤${r.maxHoldF}W` : ""}`;

const mod = new URL("../src/research/farm-jobs.js", import.meta.url).href;
const jobs = [];
for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) jobs.push({ mod, fn: "farmPair", args: [assets[i], assets[j], { interval: args.interval, formationsH, rules, periods, hedge: args.hedge || "ratio" }] });
console.log(`${jobs.length} pairs × ${formationsH.length} windows × ${rules.length} rules on ${args.interval}`);
const t0 = Date.now();
const res = (await runPool(jobs, { onDone: (d, n) => { if (d % 20 === 0 || d === n) process.stdout.write(`\r${d}/${n} (${((Date.now() - t0) / 1000).toFixed(0)}s)`); } })).filter((r) => r && !r.error && r.results);
console.log();

// Aggregate per (formation, rule, period) across pairs.
const agg = new Map();
for (const pr of res) for (const x of pr.results) {
  const k = `${x.f}|${x.r}|${x.p}`;
  const a = agg.get(k) || { f: x.f, r: x.r, p: x.p, g: 0, v: 0, fu: 0, n: 0, pairs: 0, posPairs: 0, dd: [], days: 0, sh: [] };
  a.g += x.g; a.v += x.v; a.fu += x.fu; a.n += x.n; a.pairs++; if (x.g > 0) a.posPairs++; a.dd.push(x.dd); a.days = Math.max(a.days, x.d); a.sh.push(x.sh);
  agg.set(k, a);
}
const rows = [];
for (const a of agg.values()) {
  if (a.p !== "is") continue;
  const o = agg.get(`${a.f}|${a.r}|oos`);
  if (!o) continue;
  const stat = (x) => ({
    grossBps: x.v ? (x.g / x.v) * 1e4 : 0, fundBps: x.v ? (x.fu / x.v) * 1e4 : 0,
    volPerPairDay: x.v / x.pairs / x.days, posShare: x.posPairs / x.pairs,
    medDD: x.dd.sort((p, q) => p - q)[Math.floor(x.dd.length / 2)], tradesPerPairDay: x.n / x.pairs / x.days,
    medSharpe: x.sh.sort((p, q) => p - q)[Math.floor(x.sh.length / 2)],
  });
  rows.push({ formationH: a.f, rule: rules[a.r], name: ruleName(rules[a.r]), is: stat(a), oos: stat(o) });
}

await mkdir("research", { recursive: true });
await writeFile(`research/farm-${args.interval}.json`, JSON.stringify({ generated: new Date().toISOString(), interval: args.interval, assets, periods, formationsH, rules, rows, ...(args["per-pair"] ? { perPair: res } : {}) }, null, 0));

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const show = (title, list) => {
  console.log(`\n${title}`);
  console.log(`${"window".padEnd(7)} ${"rule".padEnd(30)} | IS: gross bp  vol/pair/day  %pairs+  medDD | OOS: gross bp  vol/pair/day  %pairs+  medDD  trades/pair/day`);
  for (const r of list) console.log(`${(r.formationH + "h").padEnd(7)} ${r.name.padEnd(30)} | ${f(r.is.grossBps).padStart(8)} ${("$" + Math.round(r.is.volPerPairDay).toLocaleString()).padStart(12)} ${f(r.is.posShare * 100, 0).padStart(7)}% ${("$" + Math.round(r.is.medDD)).padStart(6)} | ${f(r.oos.grossBps).padStart(8)} ${("$" + Math.round(r.oos.volPerPairDay).toLocaleString()).padStart(12)} ${f(r.oos.posShare * 100, 0).padStart(7)}% ${("$" + Math.round(r.oos.medDD)).padStart(6)} ${f(r.oos.tradesPerPairDay, 2).padStart(8)}`);
};
// Rank by the worse of IS/OOS gross edge, among rules that actually trade.
const active = rows.filter((r) => r.is.volPerPairDay > 1000 && r.oos.volPerPairDay > 1000);
show("Best gross edge per $ traded (min of IS, OOS):", [...active].sort((a, b) => Math.min(b.is.grossBps, b.oos.grossBps) - Math.min(a.is.grossBps, a.oos.grossBps)).slice(0, args.top));
show("Most volume with gross edge ≥ 0 in both periods:", active.filter((r) => r.is.grossBps >= 0 && r.oos.grossBps >= 0).sort((a, b) => b.oos.volPerPairDay - a.oos.volPerPairDay).slice(0, args.top));
console.log(`\nwrote research/farm-${args.interval}.json`);
