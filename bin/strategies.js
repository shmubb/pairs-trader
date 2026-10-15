#!/usr/bin/env node
// Strategy-family research: directional and cross-sectional crypto strategies
// on a liquid perp universe, in-sample vs out-of-sample, with real funding and costs.
//
//   node bin/strategies.js                       # daily bars, all families
//   node bin/strategies.js --bar 4 --only trend  # 4h bars, names matching "trend"
//   node bin/strategies.js --cost 10             # cost sensitivity (bp per side)
//
// Writes research/strategies-<bar>h.json (summary + equity curves, downsampled).

import { writeFile, mkdir } from "node:fs/promises";
import { parseArgs } from "../src/util/args.js";
import { loadUniverse } from "../src/data/history.js";
import { loadMatrix, runPortfolio } from "../src/research/portfolio.js";
import * as S from "../src/core/xs-strategies.js";

const args = parseArgs(process.argv.slice(2), { bar: 24, cost: 6, is: "2020-06-01:2024-01-01", oos: "2024-01-01:", topN: 20, minAdv: 20e6, vol: 0.2, band: 0.25 });
const NON_CRYPTO = new Set(["gold", "silver", "equity", "btc-equity", "index"]);
const ids = args.assets ? String(args.assets).split(",") : (await loadUniverse()).filter((a) => !NON_CRYPTO.has(a.sector)).map((a) => a.id);
const [isFrom, isTo] = String(args.is).split(":"), [oosFrom, oosTo] = String(args.oos).split(":");

const t0 = Date.now();
const m = await loadMatrix(ids, { barH: args.bar, from: "2020-01-01" });
const D = (d) => Math.round((d * 24) / args.bar); // days → bars
S.prepare(m, { emas: [D(4), D(8), D(16), D(32), D(64), D(128), D(200)].filter((x, i, a) => a.indexOf(x) === i), donchian: [D(10), D(20), D(40), D(55), D(5), D(28)].filter((x, i, a) => a.indexOf(x) === i) });
console.log(`${m.ids.length} assets, ${m.t.length} bars of ${args.bar}h, loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const uni = { topN: args.topN, minAdv: args.minAdv };
const risk = { targetVol: args.vol, maxLev: 3 };
const o = { uni, risk };
const configs = {
  "bench: buy&hold basket": S.buyHold(o),
  "bench: BTC only": S.buyHold({ uni: { ...uni, topN: 1 }, risk }),
  "regime: long basket if BTC>SMA100": S.regimeLong({ smaD: 100, ...o }),
  "regime: long basket if BTC>SMA50": S.regimeLong({ smaD: 50, ...o }),
  "trend: TSMOM 7-112d L/S": S.tsmom({ lookbacksD: [7, 14, 28, 56, 112], ...o }),
  "trend: TSMOM 7-112d long-only": S.tsmom({ lookbacksD: [7, 14, 28, 56, 112], longOnly: true, ...o }),
  "trend: TSMOM 28-112d L/S": S.tsmom({ lookbacksD: [28, 56, 112], ...o }),
  "trend: TSMOM 3-28d L/S": S.tsmom({ lookbacksD: [3, 7, 14, 28], ...o }),
  "trend: EMA 4/16,8/32,16/64d L/S": S.emaTrend({ pairs: [[D(4), D(16)], [D(8), D(32)], [D(16), D(64)]], ...o }),
  "trend: EMA 4/16,8/32,16/64d long-only": S.emaTrend({ pairs: [[D(4), D(16)], [D(8), D(32)], [D(16), D(64)]], longOnly: true, ...o }),
  "trend: EMA 16/64,32/128,64/200d L/S": S.emaTrend({ pairs: [[D(16), D(64)], [D(32), D(128)], [D(64), D(200)]], ...o }),
  "trend: Donchian 20/10d L/S": S.donchian({ n: D(20), exitN: D(10), ...o }),
  "trend: Donchian 20/10d long-only": S.donchian({ n: D(20), exitN: D(10), longOnly: true, ...o }),
  "trend: Donchian 55/28d L/S": S.donchian({ n: D(55), exitN: D(28), ...o }),
  "trend: Donchian 10/5d L/S": S.donchian({ n: D(10), exitN: D(5), ...o }),
  "xs: momentum 28d skip1": S.xsRank({ score: S.scores.momentum(28, 1), ...o }),
  "xs: momentum 56d skip7": S.xsRank({ score: S.scores.momentum(56, 7), ...o }),
  "xs: momentum 7d": S.xsRank({ score: S.scores.momentum(7, 0), ...o }),
  "xs: reversal 1d": S.xsRank({ score: S.scores.reversal(1), ...o }),
  "xs: reversal 3d": S.xsRank({ score: S.scores.reversal(3), ...o }),
  "carry: XS funding 7d": S.xsRank({ score: S.scores.carry(7), ...o }),
  "carry: XS funding 30d": S.xsRank({ score: S.scores.carry(30), ...o }),
  "carry: XS funding 3d": S.xsRank({ score: S.scores.carry(3), ...o }),
  "funding contrarian: >30%/<-10% APR": S.fundingContrarian({ lookbackD: 3, hi: 0.3, lo: -0.1, ...o }),
  "funding contrarian: >50%/<-20% APR": S.fundingContrarian({ lookbackD: 3, hi: 0.5, lo: -0.2, ...o }),
};
configs["blend: TSMOM + XS carry 7d"] = S.blend([[configs["trend: TSMOM 7-112d L/S"], 0.5], [configs["carry: XS funding 7d"], 0.5]]);
configs["blend: TSMOM + EMA + Donchian"] = S.blend([[configs["trend: TSMOM 7-112d L/S"], 1 / 3], [configs["trend: EMA 4/16,8/32,16/64d L/S"], 1 / 3], [configs["trend: Donchian 20/10d L/S"], 1 / 3]]);

const only = args.only ? new RegExp(String(args.only), "i") : null;
const span = (from, to) => ({ startT: Date.parse(from), endT: to ? Date.parse(to) : Infinity });
const opts = { costBps: args.cost, band: args.band, maxGross: 3 };
const rows = [];
for (const [name, fn] of Object.entries(configs)) {
  if (only && !only.test(name)) continue;
  const is = runPortfolio(m, fn, { ...opts, ...span(isFrom, isTo) });
  const oos = runPortfolio(m, fn, { ...opts, ...span(oosFrom, oosTo) });
  const full = runPortfolio(m, fn, { ...opts, ...span(isFrom, oosTo) });
  const strip = (r) => ({ sharpe: r.sharpe, cagr: r.cagr, vol: r.vol, maxDD: r.maxDD, calmar: r.calmar, turnoverPerYear: r.turnoverPerYear, costsTotal: r.costsTotal, fundingTotal: r.fundingTotal, avgGross: r.avgGross, years: r.years, byYear: r.byYear });
  const curve = full.curve.filter((_, i) => i % Math.max(1, Math.round(24 / args.bar)) === 0);
  const times = full.times.filter((_, i) => i % Math.max(1, Math.round(24 / args.bar)) === 0);
  rows.push({ name, is: strip(is), oos: strip(oos), full: strip(full), curve, times });
  const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
  const pc = (x) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");
  const yrs = Object.entries(full.byYear).map(([y, r]) => `${String(y).slice(2)}:${pc(r)}`).join(" ");
  console.log(`${name.padEnd(40)} IS ${f(is.sharpe).padStart(5)} ${pc(is.cagr).padStart(5)} dd${pc(is.maxDD).padStart(4)} | OOS ${f(oos.sharpe).padStart(5)} ${pc(oos.cagr).padStart(5)} dd${pc(oos.maxDD).padStart(4)} | turn ${f(full.turnoverPerYear, 0).padStart(4)}x fund ${pc(full.fundingTotal).padStart(4)} gross ${f(full.avgGross)} | ${yrs}`);
}

await mkdir("research", { recursive: true });
const file = `research/strategies-${args.bar}h${args.cost !== 6 ? `-c${args.cost}` : ""}.json`;
await writeFile(file, JSON.stringify({ generated: new Date().toISOString(), args, assets: m.ids, rows }));
console.log(`wrote ${file} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
