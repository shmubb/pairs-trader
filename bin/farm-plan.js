#!/usr/bin/env node
// How much volume can I farm, and what will it cost? Uses the research numbers
// (research/farm-*.json; docs/FARMING.md) and config/venues.json.
//
//   node bin/farm-plan.js --equity 5000 --gross-per-pair 3000 --pairs 3
//   node bin/farm-plan.js --equity 5000 --target-volume 20000000     # $ per month

import { readFile } from "node:fs/promises";
import { parseArgs } from "../src/util/args.js";

const a = parseArgs(process.argv.slice(2), { equity: 10000, "gross-per-pair": 3000, pairs: 3, "half-spread": 0.3 });
const venues = JSON.parse(await readFile(new URL("../config/venues.json", import.meta.url), "utf8")).venues;
// From the research (majors, 5m, 6h window, zIn 1 / zOut 0.5, taker): turnover and gross edge.
const TURNOVER_PER_DAY = 36.7;          // $ traded per day per $1 of gross position (≈ $367k/day per $10k)
const EDGE_BPS = { pessimistic: -0.05, central: 0.12, optimistic: 0.28 }; // gross edge per $ traded (2025 delayed fill / 2025-26 average / 2026)
// Measured on the recommended 3-pair set (BTC/BNB, ETH/DOGE, SOL/XRP), Feb 2025 → Oct 2026, at 0.3 bp/side:
const WORST_DAY_PER_GROSS = 0.032;      // worst day −$288 on $9k gross
const MAX_DD_PER_GROSS = 0.20;          // largest peak-to-trough swing ≈ $1.8k on $9k gross

let gpp = +a["gross-per-pair"];
if (a["target-volume"]) gpp = +a["target-volume"] / 30 / TURNOVER_PER_DAY / +a.pairs;
const gross = gpp * a.pairs;
const volDay = gross * TURNOVER_PER_DAY, volMonth = volDay * 30;
console.log(`${a.pairs} pairs × $${Math.round(gpp).toLocaleString()} gross = $${Math.round(gross).toLocaleString()} gross (${(gross / a.equity).toFixed(2)}× a $${(+a.equity).toLocaleString()} account)`);
console.log(`expected volume ≈ $${Math.round(volDay).toLocaleString()}/day, $${(volMonth / 1e6).toFixed(1)}M/month (both legs, entries + exits)`);
console.log(`backtest risk at this size: worst day ≈ −$${Math.round(WORST_DAY_PER_GROSS * gross).toLocaleString()} (${((WORST_DAY_PER_GROSS * gross / a.equity) * 100).toFixed(1)}% of the account), largest drawdown ≈ −$${Math.round(MAX_DD_PER_GROSS * gross).toLocaleString()} (${((MAX_DD_PER_GROSS * gross / a.equity) * 100).toFixed(0)}%)\n`);
console.log(`${"venue".padEnd(22)} taker  | $ per $1M (pess / central / opt) | $ per month at that volume (central)`);
for (const v of venues) {
  const cost = v.taker + +a["half-spread"];
  const per = Object.fromEntries(Object.entries(EDGE_BPS).map(([k, e]) => [k, (e - cost) * 100]));
  console.log(`${v.name.padEnd(22)} ${String(v.taker).padStart(4)}bp | ${per.pessimistic.toFixed(0).padStart(6)} / ${per.central.toFixed(0).padStart(5)} / ${per.optimistic.toFixed(0).padStart(5)}        | ${(per.central * volMonth / 1e6).toFixed(0).padStart(8)}`);
}
console.log(`\nAssumes a ${a["half-spread"]}bp half-spread on majors and taker execution. Zero-fee venues are the only ones where this farms cheaply;`);
console.log(`on venues charging ≥2bp taker, cost is dominated by fees whatever the strategy. Paper-trade first: node bin/engine.js --engine config/farm.example.json`);
