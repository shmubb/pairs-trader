// Read-only Binance USD-M futures client for live signals (public endpoints, no key).
// Used by the OI-momentum engine when `signalSource: "binance"`: the same data the
// research was run on (5-minute candles + 5-minute open-interest history).
// Note: Binance blocks some regions (including the US); use the Hyperliquid source there.

export const BINANCE_FAPI = "https://fapi.binance.com";

export class BinanceFutures {
  constructor({ baseUrl = BINANCE_FAPI, fetchImpl } = {}) {
    this.base = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  async get(path, params) {
    const url = `${this.base}${path}?${new URLSearchParams(params)}`;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.fetch(url);
        if (r.status === 429 || r.status === 418) throw new Error(`rate limited (${r.status})`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
      }
    }
    throw new Error(`Binance ${path}: ${lastErr.message}`);
  }

  /** Candles from startTime (ms), paging. Rows {t,o,h,l,c,v,qv,n,tbv}. */
  async klines(symbol, interval, startTime, endTime = Date.now()) {
    const out = [];
    let from = startTime;
    for (let guard = 0; guard < 50 && from < endTime; guard++) {
      const rows = await this.get("/fapi/v1/klines", { symbol, interval, startTime: from, endTime, limit: 1500 });
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) out.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], qv: +r[7], n: r[8], tbv: +r[9] });
      from = rows[rows.length - 1][0] + 1;
      if (rows.length < 1500) break;
    }
    return out;
  }

  /** 5-minute open-interest snapshots since startTime (Binance keeps 30 days). Map(timestamp → OI in coins). */
  async openInterestHist(symbol, startTime, endTime = Date.now(), period = "5m") {
    const out = new Map();
    let from = startTime;
    for (let guard = 0; guard < 20 && from < endTime; guard++) {
      const rows = await this.get("/futures/data/openInterestHist", { symbol, period, startTime: from, endTime, limit: 500 });
      if (!Array.isArray(rows) || !rows.length) break;
      for (const r of rows) out.set(+r.timestamp, +r.sumOpenInterest);
      from = +rows[rows.length - 1].timestamp + 1;
      if (rows.length < 500) break;
    }
    return out;
  }
}
