// Read-only Hyperliquid client (the public /info endpoint). Works in the
// browser and in Node 18+ — plain fetch, no dependencies, no keys.
// Trading lives in src/exec/ and is Node-only.
//
// Gotchas baked in (see docs/HYPERLIQUID_API.md):
//  - candleSnapshot returns at most 5,000 candles per call: we page.
//  - Time-range endpoints (fundingHistory) return at most 500 rows: we page.
//  - All numbers arrive as strings.
//  - Builder-dex (HIP-3) markets are namespaced, e.g. "xyz:GOLD".
//  - IP budget is ~1200 weight/min; most info calls weigh 20, a few weigh 2.

export const MAINNET = "https://api.hyperliquid.xyz";
export const TESTNET = "https://api.hyperliquid-testnet.xyz";

const LIGHT = new Set(["l2Book", "allMids", "clearinghouseState", "orderStatus", "spotClearinghouseState", "exchangeStatus"]);
const INTERVAL_MS = { "1m": 6e4, "3m": 18e4, "5m": 3e5, "15m": 9e5, "30m": 18e5, "1h": 36e5, "2h": 72e5, "4h": 144e5, "8h": 288e5, "12h": 432e5, "1d": 864e5 };

export class HyperliquidInfo {
  constructor({ baseUrl = MAINNET, weightPerMinute = 1000, fetchImpl } = {}) {
    this.url = baseUrl.replace(/\/$/, "") + "/info";
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.budget = weightPerMinute;
    this.tokens = weightPerMinute;
    this.last = Date.now();
  }

  async throttle(weight) {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.budget, this.tokens + ((now - this.last) / 60_000) * this.budget);
      this.last = now;
      if (this.tokens >= weight) { this.tokens -= weight; return; }
      await new Promise((r) => setTimeout(r, Math.ceil(((weight - this.tokens) / this.budget) * 60_000)));
    }
  }

  async post(body) {
    await this.throttle(LIGHT.has(body.type) ? 2 : 20);
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await this.fetch(this.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (r.status === 429) throw new Error("rate limited (429)");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 400 * 2 ** attempt));
      }
    }
    throw new Error(`Hyperliquid ${body.type}: ${lastErr.message}`);
  }

  meta(dex) { return this.post(dex ? { type: "meta", dex } : { type: "meta" }); }
  perpDexs() { return this.post({ type: "perpDexs" }); }
  allMids(dex) { return this.post(dex ? { type: "allMids", dex } : { type: "allMids" }); }
  l2Book(coin) { return this.post({ type: "l2Book", coin }); }
  predictedFundings() { return this.post({ type: "predictedFundings" }); }
  clearinghouseState(user, dex) { return this.post(dex ? { type: "clearinghouseState", user, dex } : { type: "clearinghouseState", user }); }
  openOrders(user) { return this.post({ type: "openOrders", user }); }
  userFills(user) { return this.post({ type: "userFills", user, aggregateByTime: true }); }
  orderStatus(user, oid) { return this.post({ type: "orderStatus", user, oid }); }
  userFees(user) { return this.post({ type: "userFees", user }); }

  /** {coin: {asset, szDecimals, maxLeverage, funding, markPx, midPx, oraclePx, openInterest, dayNtlVlm, premium}} */
  async markets(dex) {
    const [meta, ctxs] = await this.post(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" });
    const out = {};
    meta.universe.forEach((u, i) => {
      const c = ctxs[i] || {};
      out[u.name] = {
        coin: u.name, asset: i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, delisted: !!u.isDelisted,
        onlyIsolated: !!u.onlyIsolated, marginMode: u.marginMode || null,
        funding: +c.funding, markPx: +c.markPx, midPx: c.midPx == null ? null : +c.midPx, oraclePx: +c.oraclePx,
        openInterest: +c.openInterest, dayNtlVlm: +c.dayNtlVlm, premium: c.premium == null ? null : +c.premium, prevDayPx: +c.prevDayPx,
      };
    });
    return out;
  }

  /** Candles between start and end (ms), paging past the 5,000-per-call cap. Returns bars {t,o,h,l,c,v,n,qv}. */
  async candles(coin, interval, startTime, endTime = Date.now()) {
    const step = INTERVAL_MS[interval];
    if (!step) throw new Error(`unsupported interval ${interval}`);
    const out = [];
    let from = startTime;
    while (from < endTime) {
      const to = Math.min(endTime, from + step * 4999);
      const rows = await this.post({ type: "candleSnapshot", req: { coin, interval, startTime: from, endTime: to } });
      if (!Array.isArray(rows) || rows.length === 0) { from = to + 1; continue; }
      for (const r of rows) {
        if (out.length && r.t <= out[out.length - 1].t) continue;
        const c = +r.c;
        out.push({ t: r.t, o: +r.o, h: +r.h, l: +r.l, c, v: +r.v, n: r.n, qv: +r.v * c });
      }
      from = rows[rows.length - 1].t + step;
      if (rows.length < 2) break;
    }
    return out;
  }

  /** Hourly funding history (rate per hour), paging past the 500-row cap. */
  async fundingHistory(coin, startTime, endTime = Date.now()) {
    const out = [];
    let from = startTime;
    for (let guard = 0; guard < 200 && from < endTime; guard++) {
      const rows = await this.post({ type: "fundingHistory", coin, startTime: from, endTime });
      if (!rows.length) break;
      for (const r of rows) out.push({ t: r.time, rate: +r.fundingRate, premium: +r.premium });
      from = rows[rows.length - 1].time + 1;
      if (rows.length < 500) break;
    }
    return out;
  }
}

/**
 * Markets for the main dex plus any builder dexes the coins need, with the
 * global asset id used by /exchange (main: index; builder dex k (0-based in
 * perpDexs()[1:]): 110000 + k*10000 + index). Mirrors the official Python SDK.
 */
export async function marketsFor(info, coins) {
  const out = await info.markets();
  const dexes = [...new Set(coins.map(dexOf).filter(Boolean))];
  if (dexes.length) {
    const list = (await info.perpDexs()).slice(1).map((d) => d && d.name);
    for (const dex of dexes) {
      const k = list.indexOf(dex);
      if (k < 0) throw new Error(`builder dex "${dex}" not found`);
      const m = await info.markets(dex);
      for (const [coin, v] of Object.entries(m)) out[coin] = { ...v, asset: 110000 + k * 10000 + v.asset, dex };
    }
  }
  return out;
}

/** Builder-dex prefix of a coin name ("xyz:GOLD" → "xyz"), or undefined for the main dex. */
export function dexOf(coin) {
  const i = coin.indexOf(":");
  return i > 0 ? coin.slice(0, i) : undefined;
}

/**
 * Pull aligned two-leg bars for the model straight from Hyperliquid.
 * Funding here is Hyperliquid's hourly rate (fa/fb = rate settled in the bar,
 * fundA/fundB = latest hourly rate), so `fundingPeriodBars` is 1 per hour.
 */
export async function loadPairHL(info, coinA, coinB, interval, startTime, endTime = Date.now(), { funding = true } = {}) {
  const [a, b, fA, fB] = await Promise.all([
    info.candles(coinA, interval, startTime, endTime),
    info.candles(coinB, interval, startTime, endTime),
    funding ? info.fundingHistory(coinA, startTime, endTime).catch(() => []) : [],
    funding ? info.fundingHistory(coinB, startTime, endTime).catch(() => []) : [],
  ]);
  const bMap = new Map(b.map((r) => [r.t, r]));
  const step = INTERVAL_MS[interval];
  const bars = [];
  let ia = 0, ib = 0, lastA = 0, lastB = 0;
  for (const ra of a) {
    const rb = bMap.get(ra.t);
    if (!rb) continue;
    const end = ra.t + step;
    let fa = 0, fb = 0;
    while (ia < fA.length && fA[ia].t < end) { if (fA[ia].t >= ra.t) fa += fA[ia].rate; lastA = fA[ia].rate; ia++; }
    while (ib < fB.length && fB[ib].t < end) { if (fB[ib].t >= ra.t) fb += fB[ib].rate; lastB = fB[ib].rate; ib++; }
    bars.push({ t: ra.t, oa: ra.o, ob: rb.o, pa: ra.c, pb: rb.c, qa: ra.qv, qb: rb.qv, fa, fb, fundA: lastA, fundB: lastB, fundPeriodH: 1 });
  }
  return bars;
}
