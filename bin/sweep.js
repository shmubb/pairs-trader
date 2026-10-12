#!/usr/bin/env node
// Strategy-level research: run config variants across a fixed basket of pairs
// and compare the *average* pair, in-sample and out-of-sample. Averaging over
// many pairs measures the rules, not luck in picking a pair.
//
//   node bin/sweep.js                         # built-in variant list, liquid crypto basket
//   node bin/sweep.js --variants research/variants.json --interval 15m --assets BTC,ETH,...
//
// A variant is {name, set: {"dotted.key": value, ...}}.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadConfig, setPath } from "../src/util/config.js";
import { parseArgs } from "../src/util/args.js";
import { runPool } from "../src/research/pool.js";
import { loadUniverse } from "../src/data/history.js";

const args = parseArgs(process.argv.slice(2), { interval: "1h", is: "2022-03-01:2025-01-01", oos: "2025-01-01:", out: "" });
const BASKET_1H = "BTC,ETH,SOL,BNB,XRP,DOGE,ADA,AVAX,LINK,DOT,LTC,BCH,ETC,ATOM,NEAR,APT,ARB,OP,INJ,AAVE,UNI,LDO,CRV,FIL,TRX,XLM,HBAR,kSHIB,FET,OP";
const assets = [...new Set(String(args.assets || BASKET_1H).split(","))];
const uni = await loadUniverse();
for (const a of assets) if (!uni.find((u) => u.id === a)) throw new Error(`unknown asset ${a}`);

const DEFAULT_VARIANTS = [
  { name: "default", set: {} },
  { name: "maker fees, no slippage", set: { "costs.useMaker": true, "costs.slippage": 0 } },
  { name: "formation 7d", set: { "model.formationBars": 168, "model.longFormationBars": 504 } },
  { name: "formation 14d", set: { "model.formationBars": 336, "model.longFormationBars": 1008 } },
  { name: "formation 60d", set: { "model.formationBars": 1440, "model.longFormationBars": 4320 } },
  { name: "entry z 1.5", set: { "entry.z": 1.5 } },
  { name: "entry z 2.5", set: { "entry.z": 2.5, "entry.maxEntryZ": 3.6 } },
  { name: "no stall confirm", set: { "entry.confirm": "none" } },
  { name: "exit z 0.5", set: { "exit.z": 0.5 } },
  { name: "no ladder", set: { "ladder.enabled": false } },
  { name: "stop z 3", set: { "exit.stopZ": 3.2, "entry.maxEntryZ": 2.8 } },
  { name: "stop z 5", set: { "exit.stopZ": 5 } },
  { name: "loose stat gates", set: { "gates.maxCointP": 1, "gates.maxHurst": 9, "gates.maxHalfLifeBars": 1e9, "gates.minCorr": 0, "gates.minCorrShort": 0 } },
  { name: "strict coint p<.05", set: { "gates.maxCointP": 0.05 } },
  { name: "hedge kalman", set: { "model.hedge": "kalman" } },
  { name: "hedge ratio (β=1)", set: { "model.hedge": "ratio" } },
  { name: "edge/cost ≥ 1.5", set: { "entry.minEdgeCostRatio": 1.5 } },
  { name: "time stop 2 HL", set: { "exit.timeStopHalfLives": 2 } },
];
const variants = args.variants ? JSON.parse(await readFile(args.variants, "utf8")) : DEFAULT_VARIANTS;
const only = args.only ? new Set(String(args.only).split("|")) : null;

const [isFrom, isTo] = String(args.is).split(":");
const [oosFrom, oosTo] = String(args.oos).split(":");
const periods = [{ name: "is", from: isFrom, to: isTo || undefined }, { name: "oos", from: oosFrom, to: oosTo || undefined }];
const base = await loadConfig(args.config);
const mod = new URL("../src/research/jobs.js", import.meta.url).href;
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

const summary = [];
console.log(`${assets.length} assets → ${(assets.length * (assets.length - 1)) / 2} pairs, ${args.interval}`);
console.log(`${"variant".padEnd(26)} |  IS: mean ret  %pos  Sharpe  trades/pair  maxDD | OOS: mean ret  %pos  Sharpe  trades/pair  maxDD`);
for (const v of variants) {
  if (only && !only.has(v.name)) continue;
  const cfg = structuredClone(base);
  for (const [k, val] of Object.entries(v.set)) setPath(cfg, k, val);
  const jobs = [];
  for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) {
    jobs.push({ mod, fn: "scanPair", args: [assets[i], assets[j], cfg, periods, { interval: args.interval, legacy: !!v.legacy, minBars: args.interval === "15m" ? 4000 : 1500 }] });
  }
  const res = (await runPool(jobs)).filter((r) => r && !r.error);
  const row = { name: v.name, set: v.set };
  const parts = [];
  for (const p of ["is", "oos"]) {
    const rs = res.filter((r) => r[p]).map((r) => r[p]);
    row[p] = { n: rs.length, meanRet: avg(rs.map((r) => r.ret)), pctPos: rs.filter((r) => r.ret > 0).length / (rs.length || 1), meanSharpe: avg(rs.map((r) => r.sharpe)), trades: avg(rs.map((r) => r.trades)), meanDD: avg(rs.map((r) => r.maxDD)), worstRet: Math.min(...rs.map((r) => r.ret)) };
    const s = row[p];
    parts.push(`${(s.meanRet * 100).toFixed(2).padStart(8)}% ${(s.pctPos * 100).toFixed(0).padStart(4)}% ${s.meanSharpe.toFixed(2).padStart(7)} ${s.trades.toFixed(1).padStart(9)}  ${(s.meanDD * 100).toFixed(1).padStart(6)}%`);
  }
  console.log(`${v.name.padEnd(26)} | ${parts[0]}  | ${parts[1]}`);
  summary.push(row);
}
await mkdir("research", { recursive: true });
const out = args.out || `research/sweep-${args.interval}.json`;
await writeFile(out, JSON.stringify({ generated: new Date().toISOString(), interval: args.interval, assets, periods, summary }, null, 1));
console.log(`wrote ${out}`);
