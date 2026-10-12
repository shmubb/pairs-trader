#!/usr/bin/env node
// Scan every pair in the universe, in-sample vs out-of-sample.
//
//   node bin/scan.js                         # all pairs, default config
//   node bin/scan.js --assets BTC,ETH,SOL    # restrict the universe
//   node bin/scan.js --is 2022-03-01:2025-01-01 --oos 2025-01-01:
//
// Writes research/scan-<interval>.json and prints the top pairs ranked on
// in-sample results, with their out-of-sample results alongside — the honest
// test of whether a pair's past behaviour predicts its future.

import { writeFile, mkdir } from "node:fs/promises";
import { loadUniverse } from "../src/data/history.js";
import { loadConfig, setPath } from "../src/util/config.js";
import { parseArgs } from "../src/util/args.js";
import { runPool } from "../src/research/pool.js";

const args = parseArgs(process.argv.slice(2), { interval: "1h", is: "2022-03-01:2025-01-01", oos: "2025-01-01:", top: 40, out: "", tradfi: true });
const cfg = await loadConfig(args.config);
for (const s of [].concat(args.set || [])) {
  const [k, v] = String(s).split("=");
  setPath(cfg, k, v === "true" ? true : v === "false" ? false : isNaN(Number(v)) ? v : Number(v));
}
const universe = await loadUniverse();
const wanted = args.assets ? new Set(String(args.assets).split(",")) : null;
const assets = universe.filter((a) => (!wanted || wanted.has(a.id)) && (args.tradfi || !a.tradfi));
const [isFrom, isTo] = String(args.is).split(":");
const [oosFrom, oosTo] = String(args.oos).split(":");
const periods = [{ name: "is", from: isFrom, to: isTo || undefined }, { name: "oos", from: oosFrom, to: oosTo || undefined }];

const jobs = [];
for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) {
  jobs.push({ mod: new URL("../src/research/jobs.js", import.meta.url).href, fn: "scanPair", args: [assets[i].id, assets[j].id, cfg, periods, { interval: args.interval, legacy: !!args.legacy, minBars: args.interval === "15m" ? 4000 : 1500 }] });
}
console.log(`scanning ${jobs.length} pairs on ${args.interval}…`);
const t0 = Date.now();
const results = await runPool(jobs, { onDone: (d, n) => { if (d % 100 === 0 || d === n) process.stdout.write(`\r${d}/${n} (${((Date.now() - t0) / 1000).toFixed(0)}s)`); } });
console.log();

const errors = results.filter((r) => r && r.error);
if (errors.length) console.error(`${errors.length} errors, first: ${errors[0].error.slice(0, 300)}`);
const ok = results.filter((r) => r && !r.error);
await mkdir("research", { recursive: true });
const outPath = args.out || `research/scan-${args.interval}${args.legacy ? "-legacy" : ""}.json`;
await writeFile(outPath, JSON.stringify({ generated: new Date().toISOString(), interval: args.interval, periods, config: cfg, results: ok }, null, 1));
console.log(`wrote ${outPath}`);

const f = (x, d = 2) => (x == null || !Number.isFinite(x) ? "  —  " : x.toFixed(d).padStart(6));
const ranked = ok.filter((r) => r.is && r.is.trades >= 10).sort((a, b) => b.is.sharpe - a.is.sharpe);
console.log(`\n${"pair".padEnd(14)} | IS: sharpe  ret%  maxDD%  trades  coint%  HL   | OOS: sharpe  ret%  maxDD%  trades`);
for (const r of ranked.slice(0, args.top)) {
  const o = r.oos;
  console.log(`${r.pair.padEnd(14)} | ${f(r.is.sharpe)} ${f(r.is.ret * 100, 1)} ${f(r.is.maxDD * 100, 1)} ${String(r.is.trades).padStart(6)} ${f(r.is.cointFrac05 * 100, 0)} ${f(r.is.medHalfLife, 0)} | ${o ? `${f(o.sharpe)} ${f(o.ret * 100, 1)} ${f(o.maxDD * 100, 1)} ${String(o.trades).padStart(6)}` : "  (no OOS data)"}`);
}
