// Historical data from Binance's public archive (data.binance.vision), read
// straight from its S3 bucket. Used for research and backtests: USD-M perp
// candles track Hyperliquid perps on the same asset closely, and the archive
// goes back years, which Hyperliquid's own candle API does not (5,000 candles
// per request, intraday history pruned).
//
// Node only (uses zlib and the filesystem).

import { inflateRawSync } from "node:zlib";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const BUCKET = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";

async function fetchRetry(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 500 * 2 ** i));
    }
  }
  throw lastErr;
}

/** List object keys under a prefix (handles S3 pagination). */
export async function listKeys(prefix) {
  const keys = [];
  let marker = "";
  for (;;) {
    const url = `${BUCKET}?prefix=${encodeURIComponent(prefix)}${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`;
    const buf = await fetchRetry(url);
    if (!buf) break;
    const xml = buf.toString("utf8");
    const found = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    keys.push(...found);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || found.length === 0) break;
    marker = found[found.length - 1];
  }
  return keys;
}

/** Extract the single file from a one-entry zip archive. */
export function unzipSingle(buf) {
  // Local file header: signature 0x04034b50
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("not a zip");
  const method = buf.readUInt16LE(8);
  let compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  const flags = buf.readUInt16LE(6);
  if (flags & 0x08 || compSize === 0) {
    // Sizes live in the central directory; find it via the end record.
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cdOffset = buf.readUInt32LE(eocd + 16);
    compSize = buf.readUInt32LE(cdOffset + 20);
  }
  const data = buf.subarray(start, start + compSize);
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`unsupported zip method ${method}`);
}

function parseKlineCsv(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line || line.charCodeAt(0) > 57) continue; // skip header / blank
    const f = line.split(",");
    let t = Number(f[0]);
    if (t > 1e14) t = Math.floor(t / 1000); // some newer files use microseconds
    rows.push({ t, o: +f[1], h: +f[2], l: +f[3], c: +f[4], v: +f[5], qv: +f[7], n: +f[8], tbv: +f[9] });
  }
  return rows;
}

function parseFundingCsv(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line || line.charCodeAt(0) > 57) continue;
    const f = line.split(",");
    let t = Number(f[0]);
    if (t > 1e14) t = Math.floor(t / 1000);
    rows.push({ t, rate: +f[2] });
  }
  return rows;
}

const KLINE_COLS = "t,o,h,l,c,v,qv,n,tbv";

export function klinesToCsv(rows) {
  return KLINE_COLS + "\n" + rows.map((r) => `${r.t},${r.o},${r.h},${r.l},${r.c},${r.v},${r.qv},${r.n},${r.tbv}`).join("\n") + "\n";
}

export function csvToKlines(text) {
  const lines = text.trim().split("\n");
  const out = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    out[i - 1] = { t: +f[0], o: +f[1], h: +f[2], l: +f[3], c: +f[4], v: +f[5], qv: +f[6], n: +f[7], tbv: +f[8] };
  }
  return out;
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Download and merge all monthly + daily kline files for a USD-M perp into
 * one cached CSV. Monthly archives are immutable, so a refresh only re-reads
 * the current month's daily files.
 */
export async function syncKlines(symbol, interval, { cacheDir, fromMonth = "2021-01", concurrency = 8, log = () => {} } = {}) {
  const outPath = join(cacheDir, "binance-um", interval, `${symbol}.csv`);
  const monthDir = join(cacheDir, "binance-um", "_months", interval, symbol);
  await mkdir(monthDir, { recursive: true });

  const monthly = (await listKeys(`data/futures/um/monthly/klines/${symbol}/${interval}/`))
    .filter((k) => k.endsWith(".zip"))
    .filter((k) => (k.match(/(\d{4}-\d{2})\.zip$/) || [])[1] >= fromMonth);
  const lastMonth = monthly.length ? monthly[monthly.length - 1].match(/(\d{4}-\d{2})\.zip$/)[1] : fromMonth;
  const daily = (await listKeys(`data/futures/um/daily/klines/${symbol}/${interval}/`))
    .filter((k) => k.endsWith(".zip"))
    .filter((k) => (k.match(/(\d{4}-\d{2})-\d{2}\.zip$/) || [])[1] > lastMonth);

  const all = [];
  await pool(monthly, concurrency, async (key) => {
    const ym = key.match(/(\d{4}-\d{2})\.zip$/)[1];
    const cached = join(monthDir, `${ym}.csv`);
    if (await exists(cached)) {
      all.push(...csvToKlines(await readFile(cached, "utf8")));
      return;
    }
    const buf = await fetchRetry(`${BUCKET}/${key}`);
    if (!buf) return;
    const rows = parseKlineCsv(unzipSingle(buf).toString("utf8"));
    await writeFile(cached, klinesToCsv(rows));
    all.push(...rows);
  });
  await pool(daily, concurrency, async (key) => {
    const buf = await fetchRetry(`${BUCKET}/${key}`);
    if (buf) all.push(...parseKlineCsv(unzipSingle(buf).toString("utf8")));
  });

  all.sort((a, b) => a.t - b.t);
  const dedup = [];
  for (const r of all) if (!dedup.length || dedup[dedup.length - 1].t !== r.t) dedup.push(r);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, klinesToCsv(dedup));
  log(`${symbol} ${interval}: ${dedup.length} bars (${monthly.length} months + ${daily.length} days)`);
  return dedup.length;
}

/** Funding history (8-hourly on Binance) for a USD-M perp. */
export async function syncFunding(symbol, { cacheDir, fromMonth = "2021-01", concurrency = 8 } = {}) {
  const keys = (await listKeys(`data/futures/um/monthly/fundingRate/${symbol}/`))
    .filter((k) => k.endsWith(".zip"))
    .filter((k) => (k.match(/(\d{4}-\d{2})\.zip$/) || [])[1] >= fromMonth);
  const all = [];
  await pool(keys, concurrency, async (key) => {
    const buf = await fetchRetry(`${BUCKET}/${key}`);
    if (buf) all.push(...parseFundingCsv(unzipSingle(buf).toString("utf8")));
  });
  all.sort((a, b) => a.t - b.t);
  const outPath = join(cacheDir, "binance-um", "funding", `${symbol}.csv`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, "t,rate\n" + all.map((r) => `${r.t},${r.rate}`).join("\n") + "\n");
  return all.length;
}

export async function loadKlines(symbol, interval, cacheDir) {
  const p = join(cacheDir, "binance-um", interval, `${symbol}.csv`);
  if (!(await exists(p))) return null;
  return csvToKlines(await readFile(p, "utf8"));
}

export async function loadFunding(symbol, cacheDir) {
  const p = join(cacheDir, "binance-um", "funding", `${symbol}.csv`);
  if (!(await exists(p))) return null;
  const lines = (await readFile(p, "utf8")).trim().split("\n").slice(1);
  return lines.map((l) => { const [t, rate] = l.split(","); return { t: +t, rate: +rate }; });
}

/**
 * Open interest and positioning (5-minute files, one per day), aggregated to
 * hourly: oi = OI value (USD) at the hour's last sample, taker = mean taker
 * buy/sell volume ratio, topLS = top-trader long/short account ratio.
 * Used to study liquidation flushes: a sharp OI drop alongside a price spike
 * is forced closing (liquidations / stops), not new positioning.
 */
export async function syncMetrics(symbol, { cacheDir, fromDay = "2022-01-01", concurrency = 24, log = () => {} } = {}) {
  const dayDir = join(cacheDir, "binance-um", "_metrics", symbol);
  await mkdir(dayDir, { recursive: true });
  const keys = (await listKeys(`data/futures/um/daily/metrics/${symbol}/`))
    .filter((k) => k.endsWith(".zip"))
    .filter((k) => (k.match(/(\d{4}-\d{2}-\d{2})\.zip$/) || [])[1] >= fromDay);
  const hours = new Map();
  await pool(keys, concurrency, async (key) => {
    const day = key.match(/(\d{4}-\d{2}-\d{2})\.zip$/)[1];
    const cached = join(dayDir, `${day}.csv`);
    let text;
    if (await exists(cached)) text = await readFile(cached, "utf8");
    else {
      const buf = await fetchRetry(`${BUCKET}/${key}`);
      if (!buf) return;
      text = unzipSingle(buf).toString("utf8");
      await writeFile(cached, text);
    }
    for (const line of text.split("\n")) {
      if (!line || !/^\d/.test(line)) continue;
      const f = line.split(",");
      const t = Date.parse(f[0].replace(" ", "T") + "Z");
      if (!Number.isFinite(t)) continue;
      const h = t - (t % 3600_000) - (t % 3600_000 === 0 ? 3600_000 : 0); // 5-min stamps mark period ends
      const rec = hours.get(h) || { t: h, oi: 0, oiT: 0, takerSum: 0, takerN: 0, topLS: NaN };
      if (t >= rec.oiT) { rec.oi = +f[3]; rec.oiT = t; rec.topLS = +f[5]; }
      const tk = +f[7];
      if (Number.isFinite(tk)) { rec.takerSum += tk; rec.takerN++; }
      hours.set(h, rec);
    }
  });
  const rows = [...hours.values()].sort((a, b) => a.t - b.t);
  const outPath = join(cacheDir, "binance-um", "metrics", `${symbol}.csv`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, "t,oi,taker,topLS\n" + rows.map((r) => `${r.t},${r.oi},${r.takerN ? (r.takerSum / r.takerN).toFixed(4) : ""},${Number.isFinite(r.topLS) ? r.topLS : ""}`).join("\n") + "\n");
  log(`${symbol} metrics: ${rows.length} hours from ${keys.length} days`);
  return rows.length;
}

export async function loadMetrics(symbol, cacheDir) {
  const p = join(cacheDir, "binance-um", "metrics", `${symbol}.csv`);
  if (!(await exists(p))) return null;
  return (await readFile(p, "utf8")).trim().split("\n").slice(1).map((l) => {
    const [t, oi, taker, topLS] = l.split(",");
    return { t: +t, oi: +oi, taker: taker === "" ? NaN : +taker, topLS: topLS === "" ? NaN : +topLS };
  });
}

/**
 * 5-minute open-interest snapshots from the raw daily metrics files cached by
 * syncMetrics. Returns Map(stamp ms → OI in coins); a stamp marks the moment of
 * the snapshot (the close of the 5-minute bar that starts 5 minutes earlier).
 */
export async function loadMetrics5m(symbol, cacheDir, { fromDay = "2000-01-01" } = {}) {
  const dir = join(cacheDir, "binance-um", "_metrics", symbol);
  if (!(await exists(dir))) return null;
  const { readdir } = await import("node:fs/promises");
  const out = new Map();
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".csv") && x >= fromDay).sort()) {
    for (const line of (await readFile(join(dir, f), "utf8")).split("\n")) {
      if (!line || !/^\d/.test(line)) continue;
      const c = line.split(",");
      const t = Date.parse(c[0].replace(" ", "T") + "Z");
      const oi = +c[2];
      if (Number.isFinite(t) && oi > 0) out.set(t, oi);
    }
  }
  return out;
}

