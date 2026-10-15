#!/usr/bin/env node
// Is the high-frequency pair edge real, or bid-ask bounce? Re-run chosen rules
// with 1, 2 and 3 bars of execution delay, split by pair liquidity.
import { parseArgs } from "../src/util/args.js";
import { runPool } from "../src/research/pool.js";

const args = parseArgs(process.argv.slice(2), { interval: "5m", formation: 6, is: "2025-02-01:2026-01-01", oos: "2026-01-01:" });
const assets = String(args.assets || "BTC,ETH,SOL,BNB,XRP,DOGE,LINK,AVAX,LTC,BCH,ADA,DOT,SUI,NEAR,ATOM,OP,ARB,AAVE,UNI").split(",");
const MAJORS = new Set(["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"]);
const [isFrom, isTo] = String(args.is).split(":"), [oosFrom, oosTo] = String(args.oos).split(":");
const periods = [{ name: "is", from: isFrom, to: isTo || undefined }, { name: "oos", from: oosFrom, to: oosTo || undefined }];
const rules = [
  { name: "zIn 0.5 early stop3.5", zIn: 0.5, zOut: 0.25, zStop: 3.5, gateCointP: 1, maxHoldF: 0.5 },
  { name: "zIn 1 early stop3.5", zIn: 1, zOut: 0.5, zStop: 3.5, gateCointP: 1, maxHoldF: 0.5 },
  { name: "zIn 1.5 mean stop3.5", zIn: 1.5, zOut: 0, zStop: 3.5, gateCointP: 1, maxHoldF: 0.5 },
  { name: "zIn 2 mean stop3.5", zIn: 2, zOut: 0, zStop: 3.5, gateCointP: 1, maxHoldF: 0.5 },
];
const delays = [1, 2, 3];
const mod = new URL("../src/research/farm-jobs.js", import.meta.url).href;
const jobs = [];
for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) jobs.push({ mod, fn: "farmDelay", args: [assets[i], assets[j], { interval: args.interval, formationH: +args.formation, rules, periods, delays }] });
const res = (await runPool(jobs)).filter((r) => r && r.results);
for (const group of ["all", "majors×majors", "involves an alt"]) {
  console.log(`\n${args.interval}, ${args.formation}h window — ${group}`);
  console.log(`${"rule".padEnd(24)} delay |  IS gross bp  %pairs+ |  OOS gross bp  %pairs+ | OOS vol/pair/day`);
  const inGroup = (r) => group === "all" || (group === "majors×majors" ? MAJORS.has(r.A) && MAJORS.has(r.B) : !(MAJORS.has(r.A) && MAJORS.has(r.B)));
  rules.forEach((rule, ri) => delays.forEach((d) => {
    const row = {};
    for (const p of ["is", "oos"]) {
      let g = 0, v = 0, pos = 0, n = 0, days = 1;
      for (const pr of res.filter(inGroup)) for (const x of pr.results) if (x.r === ri && x.d === d && x.p === p) { g += x.g; v += x.v; n++; if (x.g > 0) pos++; days = Math.max(days, x.days); }
      row[p] = { bp: v ? (g / v) * 1e4 : 0, pos: n ? pos / n : 0, vpd: n ? v / n / days : 0 };
    }
    console.log(`${rule.name.padEnd(24)} ${String(d).padStart(5)} | ${row.is.bp.toFixed(2).padStart(12)} ${(row.is.pos * 100).toFixed(0).padStart(7)}% | ${row.oos.bp.toFixed(2).padStart(13)} ${(row.oos.pos * 100).toFixed(0).padStart(7)}% | $${Math.round(row.oos.vpd).toLocaleString()}`);
  }));
}
