#!/usr/bin/env node
// Which execution style makes high-turnover pair trading cheapest to farm with?
// taker/taker, taker entry + maker exit, maker/taker, maker/maker — priced on each venue.
//
//   node bin/farm-exec.js [--interval 5m] [--formations 6,24,72]

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "../src/util/args.js";
import { runPool } from "../src/research/pool.js";

const args = parseArgs(process.argv.slice(2), { interval: "5m", is: "2025-02-01:2026-01-01", oos: "2026-01-01:" });
const assets = String(args.assets || "BTC,ETH,SOL,BNB,XRP,DOGE,LINK,AVAX,LTC,BCH,ADA,DOT,SUI,NEAR,ATOM,OP,ARB,AAVE,UNI").split(",");
const formationsH = String(args.formations || "6,24,72").split(",").map(Number);
const [isFrom, isTo] = String(args.is).split(":"), [oosFrom, oosTo] = String(args.oos).split(":");
const periods = [{ name: "is", from: isFrom, to: isTo || undefined }, { name: "oos", from: oosFrom, to: oosTo || undefined }];
const venues = JSON.parse(await readFile(new URL("../config/venues.json", import.meta.url), "utf8")).venues.filter((v) => v.show);
const MAJORS = new Set(["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"]);
const halfSpread = (A, B) => (MAJORS.has(A) && MAJORS.has(B) ? 0.3 : 1.5);
const styles = [["taker", "taker"], ["taker", "maker"], ["maker", "taker"], ["maker", "maker"]];
const rules = [
  { name: "zIn 0.5 early", zIn: 0.5, zOut: 0.25, zStop: 3.5, gateCointP: 1, maxHoldF: 0.5 },
  { name: "zIn 1 early", zIn: 1, zOut: 0.5, zStop: 3.5, gateCointP: 1, maxHoldF: 0.5 },
  { name: "zIn 1.5 mean", zIn: 1.5, zOut: 0, zStop: 3.5, gateCointP: 1, maxHoldF: 0.5 },
  { name: "zIn 2 mean", zIn: 2, zOut: 0, zStop: 3.5, gateCointP: 1, maxHoldF: 0.5 },
];
const mod = new URL("../src/research/farm-jobs.js", import.meta.url).href;
const jobs = [];
for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) jobs.push({ mod, fn: "farmMaker", args: [assets[i], assets[j], { interval: args.interval, formationsH, rules, periods, styles }] });
const res = (await runPool(jobs)).filter((r) => r && r.results);
const out = [];
for (const universe of ["majors", "all"]) {
  console.log(`\n=== ${universe === "majors" ? "majors × majors (half-spread 0.3bp)" : "all pairs (alts: half-spread 1.5bp)"} — $ per $1M traded, positive = profit ===`);
  console.log(`${"win".padEnd(4)} ${"rule".padEnd(15)} ${"entry/exit".padEnd(12)} | ${"IS".padEnd(4)} ${venues.map((v) => v.short.padStart(9)).join("")} | ${"OOS".padEnd(4)} ${venues.map((v) => v.short.padStart(9)).join("")} | vol/pair/day  maker%  medDD`);
  for (const fh of formationsH) rules.forEach((rule, ri) => styles.forEach((st, si) => {
    const row = { universe, formationH: fh, rule: rule.name, style: st.join("/") };
    const cell = {};
    for (const p of ["is", "oos"]) {
      let g = 0, fu = 0, mv = 0, tv = 0, spread = 0, n = 0, days = 1; const dd = [];
      for (const pr of res) {
        if (universe === "majors" && !(MAJORS.has(pr.A) && MAJORS.has(pr.B))) continue;
        for (const x of pr.results) if (x.f === fh && x.r === ri && x.s === si && x.p === p) { g += x.g; fu += x.fu; mv += x.mv; tv += x.tv; spread += (x.tv * halfSpread(pr.A, pr.B)) / 1e4; n++; days = Math.max(days, x.days); dd.push(x.dd); }
      }
      const vol = mv + tv;
      cell[p] = { venues: Object.fromEntries(venues.map((v) => [v.id, vol ? ((g + fu - spread - (mv * v.maker + tv * v.taker) / 1e4) / vol) * 1e6 : 0])), vol: vol / (n || 1) / days, maker: vol ? mv / vol : 0, medDD: dd.sort((a, b) => a - b)[Math.floor(dd.length / 2)] || 0, grossPerM: vol ? ((g + fu) / vol) * 1e6 : 0 };
    }
    row.is = cell.is; row.oos = cell.oos; out.push(row);
    const v = (c) => venues.map((x) => Math.round(c.venues[x.id]).toString().padStart(9)).join("");
    console.log(`${(fh + "h").padEnd(4)} ${rule.name.padEnd(15)} ${st.join("/").padEnd(12)} | ${"".padEnd(4)} ${v(cell.is)} | ${"".padEnd(4)} ${v(cell.oos)} | ${("$" + Math.round(cell.oos.vol / 1000) + "k").padStart(10)} ${(cell.oos.maker * 100).toFixed(0).padStart(6)}% ${("$" + Math.round(cell.oos.medDD)).padStart(6)}`);
  }));
}
await writeFile(`research/farm-exec-${args.interval}.json`, JSON.stringify({ generated: new Date().toISOString(), venues, rows: out }, null, 0));
