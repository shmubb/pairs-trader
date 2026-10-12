#!/usr/bin/env node
// Download historical perp candles (and funding) for the research universe.
//
//   node bin/fetch-data.js                       # 1h candles + funding, every asset, since 2022-01
//   node bin/fetch-data.js --interval 15m --assets BTC,ETH,SOL --from 2025-01
//   node bin/fetch-data.js --metrics --assets BTC,ETH        # open interest + long/short ratios (hourly)
//
// Files land in data/cache/ (git-ignored). Re-running only fetches what's new.

import { readFile } from "node:fs/promises";
import { syncKlines, syncFunding, syncMetrics } from "../src/data/binance-archive.js";
import { parseArgs } from "../src/util/args.js";

const args = parseArgs(process.argv.slice(2), { interval: "1h", from: "2022-01", assets: "", funding: true, cache: "data/cache" });
const universe = JSON.parse(await readFile(new URL("../config/universe.json", import.meta.url), "utf8")).assets;
const wanted = args.assets ? new Set(String(args.assets).split(",")) : null;
const assets = universe.filter((a) => !wanted || wanted.has(a.id));

let ok = 0;
for (const a of assets) {
  try {
    if (args.metrics) { await syncMetrics(a.binance, { cacheDir: args.cache, fromDay: `${args.from}-01`, log: (m) => console.log(m) }); ok++; continue; }
    const n = await syncKlines(a.binance, args.interval, { cacheDir: args.cache, fromMonth: args.from, log: (m) => console.log(m) });
    if (args.funding && args.funding !== "false") await syncFunding(a.binance, { cacheDir: args.cache, fromMonth: args.from });
    if (n > 0) ok++;
  } catch (e) {
    console.error(`${a.id}: ${e.message}`);
  }
}
console.log(`done: ${ok}/${assets.length} assets`);
