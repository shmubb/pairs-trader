#!/usr/bin/env node
// Funding-financed farming: same coin long on one contract/venue, short on
// the other. Proxy data: Binance USDT-margined vs USDC-margined perps.
//
//   node bin/xhedge.js                    # all coins, grid of lookback / gap threshold / rotation
//
// Answers: how much does the funding gap pay, how volatile is the basis, and
// how much volume can that income pay for at a given cost per side?

import { writeFile } from "node:fs/promises";
import { loadKlines, loadFunding } from "../src/data/binance-archive.js";
import { runXHedge } from "../src/research/xhedge.js";
import { parseArgs } from "../src/util/args.js";

const args = parseArgs(process.argv.slice(2), { is: "2024-02-01:2025-04-01", oos: "2025-04-01:", cost: 0.5 });
const coins = String(args.coins || "BTC,ETH,SOL,XRP,DOGE,BNB,LINK,AVAX,ADA,LTC,BCH,SUI,NEAR,ARB,AAVE,UNI,FIL,HBAR,CRV,TIA,WLD,ENA,WIF,1000PEPE,1000SHIB,1000BONK").split(",");

async function hourly(sym) {
  const k = await loadKlines(sym, "1h", "data/cache");
  const f = (await loadFunding(sym, "data/cache")) || [];
  if (!k) return null;
  const c = new Map(k.map((r) => [r.t, r.c]));
  const fm = new Map();
  for (const x of f) { const h = x.t - (x.t % 3600_000); fm.set(h, (fm.get(h) || 0) + x.rate); }
  return { c, fm, t0: k[0].t, t1: k[k.length - 1].t };
}

const [isFrom, isTo] = String(args.is).split(":"), [oosFrom, oosTo] = String(args.oos).split(":");
const P = { is: [Date.parse(isFrom), isTo ? Date.parse(isTo) : Infinity], oos: [Date.parse(oosFrom), oosTo ? Date.parse(oosTo) : Infinity] };
const series = {};
console.log("coin       | gap mean bp/8h  |gap| bp/8h  gap>2bp %time | basis std bp  basis |max| bp");
for (const coin of coins) {
  const x = await hourly(coin + "USDT"), y = await hourly(coin + "USDC");
  if (!x || !y) continue;
  const t = [];
  for (let s = Math.max(x.t0, y.t0); s <= Math.min(x.t1, y.t1); s += 3600_000) if (x.c.has(s) && y.c.has(s)) t.push(s);
  const h = { t, px: t.map((s) => x.c.get(s)), py: t.map((s) => y.c.get(s)), fx: t.map((s) => x.fm.get(s) || 0), fy: t.map((s) => y.fm.get(s) || 0) };
  series[coin] = h;
  // Descriptive stats on 8h-normalised gap (trailing 8h sums) and basis.
  let gs = 0, ga = 0, gbig = 0, m = 0, bs = 0, bss = 0, bmax = 0;
  for (let i = 8; i < t.length; i++) {
    let g = 0; for (let j = i - 7; j <= i; j++) g += h.fy[j] - h.fx[j];
    g *= 1e4; gs += g; ga += Math.abs(g); if (Math.abs(g) > 2) gbig++; m++;
    const b = (h.py[i] / h.px[i] - 1) * 1e4; bs += b; bss += b * b; bmax = Math.max(bmax, Math.abs(b));
  }
  const bmean = bs / m;
  console.log(`${coin.padEnd(10)} | ${(gs / m).toFixed(2).padStart(14)} ${(ga / m).toFixed(2).padStart(12)} ${((gbig / m) * 100).toFixed(0).padStart(12)}% | ${Math.sqrt(bss / m - bmean * bmean).toFixed(1).padStart(12)} ${bmax.toFixed(0).padStart(12)}`);
}

const rows = [];
for (const lookbackH of [8, 24, 72]) for (const minGap of [0, 1, 3]) for (const rotateH of [Infinity, 24, 8]) {
  const r = { cfg: { lookbackH, minGap, rotateH } };
  for (const [p, [s, e]] of Object.entries(P)) {
    let net = 0, fund = 0, price = 0, cost = 0, vol = 0, dd = 0, days = 1, pos = 0, nCoins = 0;
    for (const coin of Object.keys(series)) {
      const o = runXHedge(series[coin], { lookbackH, minGapBps8h: minGap, rotateH, startT: s, endT: e, costBps: { x: +args.cost, y: +args.cost } });
      net += o.net; fund += o.funding; price += o.pricePnl; cost += o.cost; vol += o.volume; dd = Math.max(dd, o.maxDD); days = Math.max(days, o.days); nCoins++; if (o.net > 0) pos++;
    }
    r[p] = { net, fund, price, cost, vol, perM: vol ? (net / vol) * 1e6 : 0, fundPerM: vol ? (fund / vol) * 1e6 : 0, volPerCoinDay: vol / nCoins / days, apr: (net / (nCoins * 10_000)) * (365 / days), fundApr: (fund / (nCoins * 10_000)) * (365 / days), worstDD: dd, posShare: pos / nCoins };
  }
  rows.push(r);
}
await writeFile("research/xhedge-1h.json", JSON.stringify({ generated: new Date().toISOString(), costPerSideBps: +args.cost, rows }, null, 1));
console.log(`\nPer $10k hedge per coin; cost ${args.cost} bp per side per leg (fees + half-spread)`);
console.log("lookback minGap rotate | IS: $/1M  fund $/1M  vol/coin/day  net APR  fund APR  %coins+ | OOS: $/1M  fund $/1M  vol/coin/day  net APR  fund APR  %coins+");
for (const r of rows) {
  const s = (x) => `${Math.round(x.perM).toString().padStart(6)} ${Math.round(x.fundPerM).toString().padStart(9)} ${("$" + Math.round(x.volPerCoinDay)).padStart(12)} ${(x.apr * 100).toFixed(1).padStart(7)}% ${(x.fundApr * 100).toFixed(1).padStart(7)}% ${(x.posShare * 100).toFixed(0).padStart(7)}%`;
  console.log(`${String(r.cfg.lookbackH).padStart(8)} ${String(r.cfg.minGap).padStart(6)} ${String(r.cfg.rotateH).padStart(6)} | ${s(r.is)} | ${s(r.oos)}`);
}
