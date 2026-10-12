#!/usr/bin/env node
// Which conditions at entry separate winning trades from losing ones?
//
//   node bin/trade-study.js                     # default config, liquid basket, 1h
//   node bin/trade-study.js --set entry.minEdgeCostRatio=0 --set gates.maxCointP=1
//
// Pools every trade across the basket and buckets them by entry features:
// hour of day, weekday/weekend, day of month (incl. the old 13th-15th
// blackout), macro-event proximity, relative volume, leg impulse, and the
// open-interest change of the leg that moved (flush = OI fell, build = OI
// rose). Reports mean R per bucket separately in-sample and out-of-sample: a
// feature is only useful if the effect has the same sign in both.

import { writeFile } from "node:fs/promises";
import { loadConfig, setPath } from "../src/util/config.js";
import { parseArgs } from "../src/util/args.js";
import { runPool } from "../src/research/pool.js";
import { assetById } from "../src/data/history.js";
import { loadMetrics } from "../src/data/binance-archive.js";
import { eventBlackout } from "../src/core/sessions.js";

const args = parseArgs(process.argv.slice(2), { interval: "1h", is: "2022-03-01:2025-01-01", oos: "2025-01-01:" });
const BASKET = "BTC,ETH,SOL,BNB,XRP,DOGE,ADA,AVAX,LINK,DOT,LTC,BCH,ETC,ATOM,NEAR,APT,ARB,OP,INJ,AAVE,UNI,LDO,CRV,FIL,TRX,XLM,HBAR,kSHIB,FET";
const assets = String(args.assets || BASKET).split(",");
const cfg = await loadConfig(args.config);
for (const s of [].concat(args.set || [])) {
  const [k, v] = String(s).split("=");
  setPath(cfg, k, v === "true" ? true : v === "false" ? false : v === "null" ? null : isNaN(Number(v)) ? v : Number(v));
}
const [isFrom, isTo] = String(args.is).split(":");
const [oosFrom, oosTo] = String(args.oos).split(":");
const periods = [{ name: "is", from: isFrom, to: isTo || undefined }, { name: "oos", from: oosFrom, to: oosTo || undefined }];
const mod = new URL("../src/research/jobs.js", import.meta.url).href;
const jobs = [];
for (let i = 0; i < assets.length; i++) for (let j = i + 1; j < assets.length; j++) jobs.push({ mod, fn: "scanPair", args: [assets[i], assets[j], cfg, periods, { interval: args.interval, keepTrades: true }] });
console.log(`running ${jobs.length} pairs…`);
const res = (await runPool(jobs)).filter((r) => r && !r.error);

// Open interest per asset (hourly), if downloaded.
const oi = {};
for (const a of assets) {
  const m = await loadMetrics((await assetById(a)).binance, "data/cache");
  if (m) oi[a] = new Map(m.map((r) => [r.t, r.oi]));
}
const oiChange = (asset, t, hours) => {
  const m = oi[asset];
  if (!m) return NaN;
  const now = m.get(t), before = m.get(t - hours * 3600_000);
  return now && before ? now / before - 1 : NaN;
};

const trades = [];
for (const r of res) for (const period of ["is", "oos"]) for (const t of r[period + "Trades"] || []) {
  if (t.kind === "OPEN") continue;
  const moverIsA = Math.abs(t.legMoveA) >= Math.abs(t.legMoveB);
  const mover = moverIsA ? r.A : r.B;
  const oiMover = oiChange(mover, t.signalT, 24);
  const date = new Date(t.signalT + 3600_000);
  trades.push({ ...t, period, pair: r.pair, mover, oiMover, dom: date.getUTCDate(), dowU: date.getUTCDay(), hour: date.getUTCHours(), event: !!eventBlackout(t.signalT + 3600_000, { before: 6, after: 6, minImpact: 2 }), rv: Math.max(t.rvA, t.rvB) });
}
console.log(`${trades.length} closed trades (${trades.filter((t) => t.period === "is").length} IS, ${trades.filter((t) => t.period === "oos").length} OOS); OI data for ${Object.keys(oi).length}/${assets.length} assets\n`);

function table(title, keyFn, order) {
  const groups = {};
  for (const t of trades) {
    const k = keyFn(t);
    if (k == null) continue;
    const g = (groups[k] ||= { is: [], oos: [] });
    g[t.period].push(t.r);
  }
  const keys = order || Object.keys(groups).sort();
  console.log(`${title}\n  ${"bucket".padEnd(22)}  IS: n    mean R   win%  |  OOS: n    mean R   win%`);
  const rows = [];
  for (const k of keys) {
    const g = groups[k];
    if (!g) continue;
    const st = (xs) => [xs.length, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN, xs.length ? xs.filter((x) => x > 0).length / xs.length : NaN];
    const [ni, mi, wi] = st(g.is), [no, mo, wo] = st(g.oos);
    rows.push({ bucket: k, is: { n: ni, meanR: mi, win: wi }, oos: { n: no, meanR: mo, win: wo } });
    console.log(`  ${String(k).padEnd(22)} ${String(ni).padStart(6)} ${mi.toFixed(3).padStart(8)} ${(wi * 100).toFixed(0).padStart(5)}%  | ${String(no).padStart(6)} ${mo.toFixed(3).padStart(8)} ${(wo * 100).toFixed(0).padStart(5)}%`);
  }
  console.log();
  return { title, rows };
}

const out = [];
out.push(table("All trades", () => "all"));
out.push(table("Exit type", (t) => t.kind));
out.push(table("Entry hour (UTC, 4h blocks)", (t) => `${String(Math.floor(t.hour / 4) * 4).padStart(2, "0")}-${String(Math.floor(t.hour / 4) * 4 + 4).padStart(2, "0")}h`));
out.push(table("Weekend vs weekday", (t) => (t.dowU === 0 || t.dowU === 6 ? "weekend" : "weekday")));
out.push(table("Day of month", (t) => (t.dom >= 13 && t.dom <= 15 ? "13th-15th" : "other days")));
out.push(table("Within ±6h of CPI/NFP/FOMC/PPI/GDP", (t) => (t.event ? "near event" : "no event")));
out.push(table("Relative volume at entry (max of legs)", (t) => (t.rv < 0.7 ? "a <0.7x" : t.rv < 1.5 ? "b 0.7-1.5x" : t.rv < 3 ? "c 1.5-3x" : "d >3x")));
out.push(table("Leg impulse (σ over 24h)", (t) => (t.legMove < 1 ? "a <1σ" : t.legMove < 2 ? "b 1-2σ" : t.legMove < 3 ? "c 2-3σ" : "d >3σ")));
out.push(table("Entry |z|", (t) => (Math.abs(t.z) < 2.25 ? "a 2.0-2.25" : Math.abs(t.z) < 2.5 ? "b 2.25-2.5" : Math.abs(t.z) < 3 ? "c 2.5-3" : "d >3")));
out.push(table("Scale-in adds used", (t) => `${t.adds} adds`));
out.push(table("OI of the leg that moved, 24h change", (t) => (!Number.isFinite(t.oiMover) ? null : t.oiMover < -0.05 ? "a flush (< -5%)" : t.oiMover < 0 ? "b mild drop" : t.oiMover < 0.05 ? "c mild build" : "d build (> +5%)")));
out.push(table("Long-window z agrees?", (t) => (!Number.isFinite(t.zLong) ? null : Math.sign(t.zLong) === Math.sign(t.z) ? (Math.abs(t.zLong) > Math.abs(t.z) ? "long more stretched" : "long same side, less") : "long opposite side")));
await writeFile(args.out || `research/trade-study-${args.interval}.json`, JSON.stringify({ generated: new Date().toISOString(), config: cfg, tables: out }, null, 1));
