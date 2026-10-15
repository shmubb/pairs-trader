#!/usr/bin/env node
// Maker-execution farming study: cost per $1M volume on each venue.
//
//   node bin/farm-maker.js --interval 5m
//   node bin/farm-maker.js --interval 15m --formations 6,24
//
// Prices every (window, rule) under venue fee schedules (config/venues.json)
// with a half-spread paid on taker fills (majors vs alts).

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "../src/util/args.js";
import { runPool } from "../src/research/pool.js";

const args = parseArgs(process.argv.slice(2), { interval: "5m", top: 15 });
const D = {
  "5m": { assets: "BTC,ETH,SOL,BNB,XRP,DOGE,LINK,AVAX,LTC,BCH,ADA,DOT,SUI,NEAR,ATOM,OP,ARB,AAVE,UNI", is: "2025-02-01:2026-01-01", oos: "2026-01-01:", formationsH: [3, 6, 24, 72] },
  "15m": { assets: "BTC,ETH,SOL,BNB,XRP,DOGE,LTC,BCH,LINK,AVAX,ARB,OP,AAVE,UNI", is: "2024-03-01:2025-04-01", oos: "2025-04-01:", formationsH: [6, 24, 72] },
  "1h": { assets: "BTC,ETH,SOL,BNB,XRP,DOGE,ADA,AVAX,LINK,DOT,LTC,BCH,ATOM,NEAR,ARB,OP,AAVE,UNI", is: "2022-03-01:2025-01-01", oos: "2025-01-01:", formationsH: [24, 72] },
}[args.interval];
const assets = String(args.assets || D.assets).split(",");
const formationsH = args.formations ? String(args.formations).split(",").map(Number) : D.formationsH;
const [isFrom, isTo] = String(args.is || D.is).split(":"), [oosFrom, oosTo] = String(args.oos || D.oos).split(":");
const periods = [{ name: "is", from: isFrom, to: isTo || undefined }, { name: "oos", from: oosFrom, to: oosTo || undefined }];
const venues = JSON.parse(await readFile(new URL("../config/venues.json", import.meta.url), "utf8")).venues;
const MAJORS = new Set(["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"]);
const halfSpread = (r) => (MAJORS.has(r.A) && MAJORS.has(r.B) ? 0.3 : 1.5);

const rules = [];
for (const zIn of [0.5, 1, 1.5, 2]) for (const exit of ["mean", "early"]) for (const zStop of [3.5, Infinity]) for (const maxHoldF of [0.5, Infinity]) {
  rules.push({ zIn, zOut: exit === "early" ? zIn / 2 : 0, zStop: Math.max(zStop, zIn + 1), gateCointP: 1, maxHoldF, exit, name: `zIn ${zIn} ${exit}${zStop < Infinity ? " stop3.5" : ""}${maxHoldF < Infinity ? " hold≤½W" : ""}` });
}
const mod = new URL("../src/research/farm-jobs.js", import.meta.url).href;
const jobs = [];
for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) jobs.push({ mod, fn: "farmMaker", args: [assets[i], assets[j], { interval: args.interval, formationsH, rules, periods }] });
console.log(`${jobs.length} pairs × ${formationsH.length} windows × ${rules.length} rules, maker execution, ${args.interval}`);
const t0 = Date.now();
const res = (await runPool(jobs, { onDone: (d, n) => { if (d % 20 === 0 || d === n) process.stdout.write(`\r${d}/${n} (${((Date.now() - t0) / 1000).toFixed(0)}s)`); } })).filter((r) => r && r.results);
console.log();

// Aggregate: $ per $1M on each venue, volume per pair-day, maker share, DD.
const agg = new Map();
for (const pr of res) for (const x of pr.results) {
  const k = `${x.f}|${x.r}|${x.p}`;
  const a = agg.get(k) || { f: x.f, r: x.r, p: x.p, g: 0, fu: 0, mv: 0, tv: 0, spreadCost: 0, n: 0, pairs: 0, pos: 0, dd: [], days: 1, lh: 0, fills: 0 };
  a.g += x.g; a.fu += x.fu; a.mv += x.mv; a.tv += x.tv; a.spreadCost += (x.tv * halfSpread(pr)) / 1e4; a.n += x.n; a.pairs++; a.dd.push(x.dd); a.days = Math.max(a.days, x.days); a.lh += x.lh; a.fills += x.fills;
  if (x.g + x.fu - (x.tv * halfSpread(pr)) / 1e4 > 0) a.pos++;
  agg.set(k, a);
}
const per = (a, v) => { const vol = a.mv + a.tv; return vol ? ((a.g + a.fu - a.spreadCost - (a.mv * v.maker + a.tv * v.taker) / 1e4) / vol) * 1e6 : 0; };
const rows = [];
for (const a of agg.values()) {
  if (a.p !== "is") continue;
  const o = agg.get(`${a.f}|${a.r}|oos`);
  if (!o) continue;
  const s = (x) => ({ vol: (x.mv + x.tv) / x.pairs / x.days, maker: x.mv / (x.mv + x.tv || 1), grossBps: ((x.g + x.fu) / (x.mv + x.tv || 1)) * 1e4, medDD: x.dd.sort((p, q) => p - q)[Math.floor(x.dd.length / 2)], posShare: x.pos / x.pairs, venues: Object.fromEntries(venues.map((v) => [v.id, per(x, v)])) });
  rows.push({ formationH: a.f, rule: rules[a.r], is: s(a), oos: s(o) });
}
await writeFile(`research/farm-maker-${args.interval}.json`, JSON.stringify({ generated: new Date().toISOString(), interval: args.interval, assets, periods, venues, rows }, null, 0));

const vShow = venues.filter((v) => v.show);
const hdr = vShow.map((v) => v.short.padStart(8)).join("");
const line = (r) => `${(r.formationH + "h").padEnd(5)} ${r.rule.name.padEnd(28)} | IS ${vShow.map((v) => Math.round(r.is.venues[v.id]).toString().padStart(8)).join("")} | OOS ${vShow.map((v) => Math.round(r.oos.venues[v.id]).toString().padStart(8)).join("")} | ${("$" + Math.round(r.oos.vol / 1000) + "k").padStart(6)}/pair/day maker ${(r.oos.maker * 100).toFixed(0)}% ddMed $${Math.round(r.oos.medDD)}`;
console.log(`\n$ per $1M traded (positive = profit), maker execution; half-spread on taker fills: majors 0.3bp, alts 1.5bp`);
console.log(`${"win".padEnd(5)} ${"rule".padEnd(28)} | IS ${hdr} | OOS ${hdr}`);
const key = args.venue || "lighter_std";
console.log(`— best on ${key} (min of IS/OOS), at least $20k/pair/day —`);
for (const r of rows.filter((r) => r.oos.vol > 20_000).sort((a, b) => Math.min(b.is.venues[key], b.oos.venues[key]) - Math.min(a.is.venues[key], a.oos.venues[key])).slice(0, args.top)) console.log(line(r));
const k2 = "paradex_api";
console.log(`— best on ${k2} —`);
for (const r of rows.filter((r) => r.oos.vol > 20_000).sort((a, b) => Math.min(b.is.venues[k2], b.oos.venues[k2]) - Math.min(a.is.venues[k2], a.oos.venues[k2])).slice(0, 8)) console.log(line(r));
console.log(`— most volume costing ≤ $30/1M on ${key} in both periods —`);
for (const r of rows.filter((r) => r.is.venues[key] >= -30 && r.oos.venues[key] >= -30).sort((a, b) => b.oos.vol - a.oos.vol).slice(0, 10)) console.log(line(r));
