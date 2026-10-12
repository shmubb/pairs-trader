// Load aligned two-leg history from the local cache (Node only).

import { readFile } from "node:fs/promises";
import { loadKlines, loadFunding, loadMetrics } from "./binance-archive.js";

let universeCache = null;
export async function loadUniverse() {
  if (!universeCache) universeCache = JSON.parse(await readFile(new URL("../../config/universe.json", import.meta.url), "utf8")).assets;
  return universeCache;
}

export async function assetById(id) {
  const a = (await loadUniverse()).find((x) => x.id === id);
  if (!a) throw new Error(`unknown asset ${id} (see config/universe.json)`);
  return a;
}

const seriesCache = new Map();
/** Candles for one asset, keyed by time, with funding rate attached at funding timestamps. */
export async function loadAsset(id, interval = "1h", cacheDir = "data/cache") {
  const key = `${id}|${interval}`;
  if (seriesCache.has(key)) return seriesCache.get(key);
  const a = await assetById(id);
  const k = await loadKlines(a.binance, interval, cacheDir);
  if (!k) throw new Error(`no cached ${interval} data for ${id} — run: node bin/fetch-data.js --assets ${id}`);
  const f = (await loadFunding(a.binance, cacheDir)) || [];
  const m = await loadMetrics(a.binance, cacheDir);
  const oi = m ? new Map(m.map((r) => [r.t, r.oi])) : null;
  const out = { id, interval, k, funding: f, oi };
  seriesCache.set(key, out);
  return out;
}

/**
 * Align two assets on timestamp. Each bar:
 * {t, oa, ob, pa, pb, qa, qb, fa, fb} — opens, closes, quote volumes, and the
 * funding rate (per 8h on Binance) that settled during the bar, else 0.
 * `fundA`/`fundB` carry the most recent known funding rate (for carry estimates).
 * `oiA`/`oiB` are open interest (USD) at the hour, when downloaded (--metrics).
 */
export async function loadPair(idA, idB, { interval = "1h", from, to, cacheDir = "data/cache" } = {}) {
  const [A, B] = await Promise.all([loadAsset(idA, interval, cacheDir), loadAsset(idB, interval, cacheDir)]);
  const bMap = new Map(B.k.map((r) => [r.t, r]));
  const step = A.k.length > 1 ? A.k[1].t - A.k[0].t : 3600_000;
  const fIdx = { a: 0, b: 0 };
  let lastFa = 0, lastFb = 0;
  const bars = [];
  for (const ra of A.k) {
    if (from && ra.t < from) continue;
    if (to && ra.t >= to) break;
    const rb = bMap.get(ra.t);
    if (!rb) continue;
    const end = ra.t + step;
    let fa = 0, fb = 0;
    while (fIdx.a < A.funding.length && A.funding[fIdx.a].t < end) { if (A.funding[fIdx.a].t >= ra.t) { fa += A.funding[fIdx.a].rate; } lastFa = A.funding[fIdx.a].rate; fIdx.a++; }
    while (fIdx.b < B.funding.length && B.funding[fIdx.b].t < end) { if (B.funding[fIdx.b].t >= ra.t) { fb += B.funding[fIdx.b].rate; } lastFb = B.funding[fIdx.b].rate; fIdx.b++; }
    const hour = ra.t - (ra.t % 3600_000);
    bars.push({ t: ra.t, oa: ra.o, ob: rb.o, pa: ra.c, pb: rb.c, qa: ra.qv, qb: rb.qv, fa, fb, fundA: lastFa, fundB: lastFb, oiA: A.oi?.get(hour), oiB: B.oi?.get(hour) });
  }
  return bars;
}
