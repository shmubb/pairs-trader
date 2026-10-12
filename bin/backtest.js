#!/usr/bin/env node
// Backtest one pair on cached history.
//
//   node bin/backtest.js ETH BTC
//   node bin/backtest.js ETH BTC --from 2024-01-01 --interval 1h --set entry.z=2.5 --set ladder.enabled=false
//   node bin/backtest.js ETH BTC --legacy          # the old app's rules, for comparison
//   node bin/backtest.js ETH BTC --trades          # list every trade
//
// Trading starts at --from; the model warms up on the bars before it.

import { loadPair } from "../src/data/history.js";
import { runBacktest, legacyConfig } from "../src/core/backtest.js";
import { mergeConfig } from "../src/core/strategy.js";
import { loadConfig, setPath } from "../src/util/config.js";
import { parseArgs } from "../src/util/args.js";
import { fmtMetrics } from "../src/util/format.js";

const args = parseArgs(process.argv.slice(2), { interval: "1h", from: "2022-03-01", equity: 10000 });
const [A, B] = args._;
if (!A || !B) { console.error("usage: node bin/backtest.js <ASSET_A> <ASSET_B> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--legacy] [--set key=value]"); process.exit(1); }

let cfg = await loadConfig(args.config);
for (const s of [].concat(args.set || [])) {
  const [k, v] = String(s).split("=");
  setPath(cfg, k, v === "true" ? true : v === "false" ? false : v === "null" ? null : isNaN(Number(v)) ? v : Number(v));
}
const legacyWindow = args.interval === "15m" ? 96 : args.interval === "5m" ? 288 : 24;
if (args.legacy) cfg = mergeConfig(cfg, legacyConfig(legacyWindow));

const startT = Date.parse(args.from);
const warm = (cfg.model.longFormationBars + 50) * (args.interval === "15m" ? 900_000 : 3600_000);
const bars = await loadPair(A, B, { interval: args.interval, from: startT - warm, to: args.to ? Date.parse(args.to) : undefined });
const res = runBacktest(bars, cfg, { startT, equity: args.equity, fixedNotional: args.legacy ? args.equity * 2 : null, sessions: true, liquidity: true });

console.log(`${A}/${B} ${args.interval} ${new Date(startT).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)}${args.legacy ? "  [LEGACY RULES]" : ""}`);
console.log(fmtMetrics(res.metrics));
if (args.trades) {
  for (const t of res.trades) {
    console.log(`${new Date(t.openT).toISOString().slice(0, 16)} ${t.dir > 0 ? "LONG " : "SHORT"} z=${t.entryZ.toFixed(2)} adds=${t.adds} bars=${String(t.bars).padStart(4)} ${t.kind.padEnd(11)} pnl=${t.pnl.toFixed(2).padStart(9)} R=${t.r.toFixed(2).padStart(6)}  ${t.reason}`);
  }
}
