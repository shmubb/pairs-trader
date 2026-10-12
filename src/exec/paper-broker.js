// Paper broker: simulated fills at the live mid ± slippage, Hyperliquid fees,
// hourly funding at the live rate. Same interface as the live broker, so the
// engine's code path is identical in paper and live mode.

import { formatSize } from "./precision.js";

export class PaperBroker {
  constructor({ equity = 10_000, fee = 0.00045, slippage = 0.0003, state } = {}) {
    this.mode = "paper";
    this.fee = fee;
    this.slippage = slippage;
    this.cash = state?.cash ?? equity;
    this.pos = state?.pos ?? {}; // coin -> {sz, entryPx}
    this.mids = {};
  }

  async init(markets) { this.markets = markets; }

  setMids(mids) { this.mids = { ...this.mids, ...mids }; }

  async positions() {
    const out = {};
    for (const [coin, p] of Object.entries(this.pos)) if (p.sz !== 0) out[coin] = { szi: p.sz, entryPx: p.entryPx, unrealizedPnl: p.sz * ((this.mids[coin] ?? p.entryPx) - p.entryPx), liquidationPx: null };
    return out;
  }

  async equity() {
    let e = this.cash;
    for (const [coin, p] of Object.entries(this.pos)) e += p.sz * (this.mids[coin] ?? p.entryPx);
    return e;
  }

  /** Charge one hour of funding at the given hourly rates (longs pay positive). */
  applyFunding(rates) {
    let paid = 0;
    for (const [coin, p] of Object.entries(this.pos)) {
      const r = rates[coin];
      if (!r || !p.sz) continue;
      const amt = -p.sz * (this.mids[coin] ?? p.entryPx) * r;
      this.cash += amt;
      paid += amt;
    }
    return paid;
  }

  /**
   * legs: [{coin, usd (signed: + buy, - sell), reduceOnly}]
   * Returns [{coin, ok, filledSz (signed), avgPx, error}]
   */
  async executeLegs(legs) {
    const out = [];
    for (const leg of legs) {
      const m = this.markets[leg.coin];
      const mid = this.mids[leg.coin];
      if (!m || !mid) { out.push({ coin: leg.coin, ok: false, filledSz: 0, error: "no market/mid" }); continue; }
      // szAbs (exact size in coins) wins over usd; usd's sign gives the side.
      let sz = Number(formatSize(leg.szAbs ?? Math.abs(leg.usd) / mid, m.szDecimals)) * Math.sign(leg.usd);
      const cur = this.pos[leg.coin]?.sz ?? 0;
      if (leg.reduceOnly) {
        if (Math.sign(sz) === Math.sign(cur) || cur === 0) sz = 0;
        else if (Math.abs(sz) > Math.abs(cur)) sz = -cur;
      }
      if (sz === 0) { out.push({ coin: leg.coin, ok: true, filledSz: 0, avgPx: mid }); continue; }
      const px = mid * (sz > 0 ? 1 + this.slippage : 1 - this.slippage);
      this.cash -= sz * px + Math.abs(sz) * px * this.fee;
      const p = this.pos[leg.coin] || { sz: 0, entryPx: px };
      const nsz = p.sz + sz;
      if (Math.sign(p.sz) === Math.sign(sz) || p.sz === 0) p.entryPx = (p.entryPx * Math.abs(p.sz) + px * Math.abs(sz)) / Math.abs(nsz);
      else if (Math.sign(nsz) !== Math.sign(p.sz) && nsz !== 0) p.entryPx = px;
      p.sz = Math.abs(nsz) < 1e-12 ? 0 : nsz;
      this.pos[leg.coin] = p;
      out.push({ coin: leg.coin, ok: true, filledSz: sz, avgPx: px, fee: Math.abs(sz) * px * this.fee });
    }
    return out;
  }

  snapshot() { return { cash: this.cash, pos: this.pos }; }
}
