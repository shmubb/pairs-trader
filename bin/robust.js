#!/usr/bin/env node
// Robustness grid for the carry + trend book: perturb every parameter and check
// that in-sample and out-of-sample performance survive (no knife-edge optimum).
//
//   node bin/robust.js [--bar 24] [--cost 6]

import { writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "../src/util/args.js";
import { loadUniverse } from "../src/data/history.js";
import { loadMatrix, runPortfolio } from "../src/research/portfolio.js";
import * as S from "../src/core/xs-strategies.js";

const args = parseArgs(process.argv.slice(2), { bar: 24, cost: 6, is: "2020-06-01:2024-01-01", oos: "2024-01-01:" });
const NON_CRYPTO = new Set(["gold", "silver", "equity", "btc-equity", "index"]);
const ids = (await loadUniverse()).filter((a) => !NON_CRYPTO.has(a.sector)).map((a) => a.id);
const m = await loadMatrix(ids, { barH: args.bar, from: "2020-01-01" });
S.prepare(m, {});
const [isFrom, isTo] = String(args.is).split(":"), [oosFrom, oosTo] = String(args.oos).split(":");
const span = (from, to) => ({ startT: Date.parse(from), endT: to ? Date.parse(to) : Infinity });

const base = { carryD: 7, q: 0.3, lbs: [7, 14, 28, 56, 112], topN: 20, minAdv: 20e6, vol: 0.2, band: 0.25, wCarry: 0.5, cost: args.cost, rebalEvery: 1 };
const make = (p) => {
  const uni = { topN: p.topN, minAdv: p.minAdv }, risk = { targetVol: p.vol, maxLev: 3 };
  const carry = S.xsRank({ score: S.scores.carry(p.carryD), q: p.q, uni, risk });
  const trend = S.tsmom({ lookbacksD: p.lbs, uni, risk });
  let fn = p.wCarry >= 1 ? carry : p.wCarry <= 0 ? trend : S.blend([[carry, p.wCarry], [trend, 1 - p.wCarry]]);
  if (p.rebalEvery > 1) { const inner = fn; fn = (ctx) => (ctx.k % p.rebalEvery === 0 ? inner(ctx) : null); }
  return fn;
};
const variants = [["base", {}]];
for (const carryD of [1, 3, 5, 10, 14, 21, 30]) variants.push([`carryD ${carryD}`, { carryD }]);
for (const q of [0.2, 0.25, 0.4, 0.5]) variants.push([`q ${q}`, { q }]);
for (const lbs of [[14, 28, 56], [28, 56, 112], [7, 14, 28], [3, 7, 14, 28, 56, 112, 224], [56, 112, 224]]) variants.push([`tsmom ${lbs.join("/")}`, { lbs }]);
for (const topN of [10, 15, 30, 45]) variants.push([`topN ${topN}`, { topN }]);
for (const minAdv of [5e6, 50e6, 100e6]) variants.push([`minAdv ${minAdv / 1e6}M`, { minAdv }]);
for (const band of [0, 0.1, 0.5]) variants.push([`band ${band}`, { band }]);
for (const wCarry of [0, 0.3, 0.7, 1]) variants.push([`wCarry ${wCarry}`, { wCarry }]);
for (const rebalEvery of [3, 7]) variants.push([`rebal every ${rebalEvery} bars`, { rebalEvery }]);
for (const cost of [3, 10, 15]) variants.push([`cost ${cost}bp`, { cost }]);
for (const vol of [0.1, 0.3, 0.4]) variants.push([`vol ${vol}`, { vol }]);

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const pc = (x) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");
const rows = [];
for (const [name, ov] of variants) {
  const p = { ...base, ...ov };
  const run = (sp) => runPortfolio(m, make(p), { costBps: p.cost, band: p.band, maxGross: 3, ...sp });
  const is = run(span(isFrom, isTo)), oos = run(span(oosFrom, oosTo)), full = run(span(isFrom, oosTo));
  rows.push({ name, p, is: { sharpe: is.sharpe, cagr: is.cagr, maxDD: is.maxDD }, oos: { sharpe: oos.sharpe, cagr: oos.cagr, maxDD: oos.maxDD }, byYear: full.byYear, turnover: full.turnoverPerYear });
  console.log(`${name.padEnd(28)} IS ${f(is.sharpe).padStart(5)} ${pc(is.cagr).padStart(5)} dd${pc(is.maxDD).padStart(4)} | OOS ${f(oos.sharpe).padStart(5)} ${pc(oos.cagr).padStart(5)} dd${pc(oos.maxDD).padStart(4)} | turn ${f(full.turnoverPerYear, 0).padStart(4)}x | ${Object.entries(full.byYear).map(([y, r]) => `${String(y).slice(2)}:${pc(r)}`).join(" ")}`);
}
await mkdir("research", { recursive: true });
await writeFile(`research/robust-${args.bar}h.json`, JSON.stringify({ generated: new Date().toISOString(), base, rows }));
