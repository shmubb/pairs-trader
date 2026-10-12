// Live Hyperliquid broker. Node only; needs `npm install` (@nktkas/hyperliquid, viem).
//
// Security model: the engine signs with an *API / agent wallet* (HL_AGENT_KEY)
// approved by your main account. An agent can place and cancel orders but
// cannot withdraw or transfer funds, so a leaked key can't drain the account.
// Account state is always read from the MAIN address (HL_ACCOUNT).
//
// Two-leg execution (the "couldn't open the second leg in time" problem):
//  1. Pre-check margin for BOTH legs before sending anything.
//  2. Send both legs in ONE signed order action (IOC limits with a slippage
//     cap), so they hit the book within the same request.
//  3. Reconcile each leg from the per-leg statuses — even when the SDK throws
//     because one leg errored.
//  4. If one leg filled and the other didn't: retry the missing leg with a
//     fresh mid and wider cushion; if it still fails, unwind the filled leg
//     reduce-only. Never sit on a naked leg.

import { randomBytes } from "node:crypto";
import { formatSize, formatPrice, marketablePrice } from "./precision.js";

export class HyperliquidBroker {
  constructor({ info, account, agentKey, testnet = false, slippage = 0.005, maxSlippage = 0.015, leverage = 5, log = console.log } = {}) {
    if (!account || !agentKey) throw new Error("live mode needs HL_ACCOUNT (main address) and HL_AGENT_KEY (API wallet private key)");
    this.mode = testnet ? "testnet" : "live";
    this.info = info;
    this.account = account;
    this.agentKey = agentKey;
    this.testnet = testnet;
    this.slippage = slippage;
    this.maxSlippage = maxSlippage;
    this.leverage = leverage;
    this.log = log;
    this.mids = {};
  }

  async init(markets) {
    this.markets = markets;
    let sdk, accounts;
    try {
      sdk = await import("@nktkas/hyperliquid");
      accounts = await import("viem/accounts");
    } catch {
      throw new Error("live trading needs the SDK: run `npm install` in the project folder");
    }
    this.sdk = sdk;
    const transport = new sdk.HttpTransport({ isTestnet: this.testnet, timeout: 10_000 });
    this.exchange = new sdk.ExchangeClient({ transport, wallet: accounts.privateKeyToAccount(this.agentKey) });
    this.leverageSet = new Set();
  }

  setMids(mids) { this.mids = { ...this.mids, ...mids }; }

  async state() { return this.info.clearinghouseState(this.account); }

  async positions() {
    const st = await this.state();
    const out = {};
    for (const ap of st.assetPositions || []) {
      const p = ap.position;
      out[p.coin] = { szi: +p.szi, entryPx: +p.entryPx, unrealizedPnl: +p.unrealizedPnl, liquidationPx: p.liquidationPx == null ? null : +p.liquidationPx, marginUsed: +p.marginUsed, cumFunding: +p.cumFunding?.sinceOpen };
    }
    return out;
  }

  async equity() {
    const st = await this.state();
    return +st.marginSummary.accountValue;
  }

  async ensureLeverage(coin) {
    if (this.leverageSet.has(coin)) return;
    const m = this.markets[coin];
    const lev = Math.min(this.leverage, m.maxLeverage);
    await this.exchange.updateLeverage({ asset: m.asset, isCross: !m.onlyIsolated, leverage: lev });
    this.leverageSet.add(coin);
  }

  /** Margin pre-check for opening/increasing legs (reduce-only legs free margin). */
  async marginCheck(legs) {
    const st = await this.state();
    const withdrawable = +st.withdrawable;
    let need = 0;
    for (const l of legs) if (!l.reduceOnly) need += Math.abs(l.usd) / Math.min(this.leverage, this.markets[l.coin].maxLeverage);
    return { ok: withdrawable >= need * 1.5, need, withdrawable };
  }

  buildOrder(leg, slip) {
    const m = this.markets[leg.coin];
    const mid = this.mids[leg.coin];
    const isBuy = leg.usd > 0;
    const sz = leg.szAbs ?? Math.abs(leg.usd) / mid;
    return {
      a: m.asset, b: isBuy, p: marketablePrice(mid, isBuy, slip, m.szDecimals), s: formatSize(sz, m.szDecimals),
      r: !!leg.reduceOnly, t: { limit: { tif: "Ioc" } }, c: "0x" + randomBytes(16).toString("hex"),
    };
  }

  async send(orders) {
    let res;
    try {
      res = await this.exchange.order({ orders, grouping: "na" });
    } catch (e) {
      const statuses = e?.response?.response?.data?.statuses;
      if (statuses) return statuses;
      // Unknown outcome (timeout etc.): look each order up by its client id.
      this.log(`order request failed (${e.message}); reconciling by cloid`);
      return Promise.all(orders.map(async (o) => {
        try {
          const st = await this.info.orderStatus(this.account, o.c);
          const ord = st?.order;
          if (ord && ord.status === "filled") return { filled: { totalSz: ord.order.origSz, avgPx: ord.order.limitPx } };
          return { error: `status ${ord?.status || st?.status || "unknown"}` };
        } catch (e2) { return { error: e2.message }; }
      }));
    }
    return res.response.data.statuses;
  }

  parse(statuses, orders) {
    return statuses.map((st, i) => {
      const o = orders[i];
      const filled = st && st.filled ? +st.filled.totalSz : 0;
      return { coin: o._coin, ok: !!(st && st.filled) && filled > 0, filledSz: (o.b ? 1 : -1) * filled, avgPx: st && st.filled ? +st.filled.avgPx : null, error: st && st.error ? st.error : null, requested: +o.s };
    });
  }

  /**
   * Hybrid entry: rest a post-only (ALO) order on the less liquid leg at the
   * touch; as soon as any of it fills, hedge the filled fraction on the other
   * leg with an IOC. Unfilled remainder is cancelled after makerTimeoutSec.
   * Saves roughly half the taker cost on entries; never used for stops.
   */
  async executeHybrid(legs, { makerTimeoutSec = 20 } = {}) {
    const [x, y] = legs;
    const vol = (c) => this.markets[c]?.dayNtlVlm ?? 0;
    const [maker, taker] = vol(x.coin) <= vol(y.coin) ? [x, y] : [y, x];
    for (const l of legs) await this.ensureLeverage(l.coin);
    const mc = await this.marginCheck(legs);
    if (!mc.ok) return legs.map((l) => ({ coin: l.coin, ok: false, filledSz: 0, error: `margin pre-check: need ~$${mc.need.toFixed(0)}×1.5` }));
    const m = this.markets[maker.coin];
    const book = await this.info.l2Book(maker.coin);
    const isBuy = maker.usd > 0;
    const touch = isBuy ? +book.levels[0][0].px : +book.levels[1][0].px;
    const sz = formatSize(Math.abs(maker.usd) / touch, m.szDecimals);
    const cloid = "0x" + randomBytes(16).toString("hex");
    const order = { a: m.asset, b: isBuy, p: formatPrice(touch, m.szDecimals, !isBuy), s: sz, r: false, t: { limit: { tif: "Alo" } }, c: cloid };
    const st = (await this.send([order]))[0];
    if (st?.error) return legs.map((l) => ({ coin: l.coin, ok: false, filledSz: 0, error: `maker leg rejected: ${st.error}` }));
    let filled = st?.filled ? +st.filled.totalSz : 0;
    let avgPx = st?.filled ? +st.filled.avgPx : touch;
    const deadline = Date.now() + makerTimeoutSec * 1000;
    while (filled < +sz * 0.999 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const os = await this.info.orderStatus(this.account, cloid).catch(() => null);
      const o = os?.order;
      if (o) {
        filled = +o.order.origSz - +o.order.sz;
        if (o.status === "filled") filled = +o.order.origSz;
        if (o.status !== "open") break; // filled, canceled, rejected… — nothing more will fill
      }
    }
    if (filled < +sz * 0.999) {
      await this.exchange.cancelByCloid({ cancels: [{ asset: m.asset, cloid }] }).catch(() => {});
      const os = await this.info.orderStatus(this.account, cloid).catch(() => null);
      if (os?.order) filled = +os.order.order.origSz - +os.order.order.sz;
    }
    if (filled <= 0) return legs.map((l) => ({ coin: l.coin, ok: false, filledSz: 0, error: "maker leg not filled in time (no position taken)" }));
    // Hedge exactly the filled fraction on the other leg.
    const frac = filled / +sz;
    const [hedge] = await this.executeLegs([{ ...taker, usd: taker.usd * frac }]);
    const makerRes = { coin: maker.coin, ok: true, filledSz: (isBuy ? 1 : -1) * filled, avgPx, maker: true };
    if (!hedge.ok) {
      this.log(`hybrid: hedge leg failed — unwinding maker fill on ${maker.coin}`);
      await this.executeLegs([{ coin: maker.coin, usd: isBuy ? -1 : 1, szAbs: filled, reduceOnly: true }]);
      return legs.map((l) => ({ coin: l.coin, ok: false, filledSz: 0, unwound: true, error: "hedge leg failed" }));
    }
    const out = [makerRes, hedge];
    return legs.map((l) => out.find((r) => r.coin === l.coin));
  }

  /** legs: [{coin, usd (signed), reduceOnly}] → per-leg results. */
  async executeLegs(legs, { style = "taker" } = {}) {
    if (style === "hybrid" && legs.length === 2 && legs.every((l) => !l.reduceOnly)) return this.executeHybrid(legs);
    const active = legs.filter((l) => Math.abs(l.usd) > 0 || l.szAbs);
    if (!active.length) return [];
    for (const l of active) if (!l.reduceOnly) await this.ensureLeverage(l.coin);
    if (active.some((l) => !l.reduceOnly)) {
      const mc = await this.marginCheck(active);
      if (!mc.ok) return active.map((l) => ({ coin: l.coin, ok: false, filledSz: 0, error: `margin pre-check: need ~$${mc.need.toFixed(0)}×1.5, withdrawable $${mc.withdrawable.toFixed(0)}` }));
    }
    const orders = active.map((l) => ({ ...this.buildOrder(l, this.slippage), _coin: l.coin }));
    const wire = (os) => os.map(({ _coin, ...o }) => o);
    let results = this.parse(await this.send(wire(orders)), orders);

    // Leg mismatch handling.
    const missing = results.map((r, i) => ({ r, leg: active[i] })).filter(({ r }) => Math.abs(r.filledSz) < 0.98 * r.requested);
    if (missing.length && missing.length < results.length) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const still = missing.filter(({ r }) => Math.abs(r.filledSz) < 0.98 * r.requested);
        if (!still.length) break;
        const slip = Math.min(this.maxSlippage, this.slippage * (1 + attempt));
        this.log(`leg retry ${attempt} (slippage ${(slip * 100).toFixed(2)}%): ${still.map(({ leg }) => leg.coin).join(", ")}`);
        const retryOrders = still.map(({ r, leg }) => ({ ...this.buildOrder({ ...leg, szAbs: r.requested - Math.abs(r.filledSz) }, slip), _coin: leg.coin }));
        const rr = this.parse(await this.send(wire(retryOrders)), retryOrders);
        rr.forEach((x, k) => {
          const target = still[k].r;
          const prevNotional = (target.avgPx || 0) * Math.abs(target.filledSz);
          target.filledSz += x.filledSz;
          target.avgPx = Math.abs(target.filledSz) > 0 ? (prevNotional + (x.avgPx || 0) * Math.abs(x.filledSz)) / Math.abs(target.filledSz) : null;
          target.ok = Math.abs(target.filledSz) >= 0.98 * target.requested;
          target.error = x.error;
        });
      }
      const unfixed = results.filter((r) => !r.ok);
      if (unfixed.length && unfixed.length < results.length && active.some((l) => !l.reduceOnly)) {
        // Unwind whatever filled so we are never left holding one naked leg.
        const unwind = results.filter((r) => Math.abs(r.filledSz) > 0).map((r) => ({ coin: r.coin, usd: -Math.sign(r.filledSz), szAbs: Math.abs(r.filledSz), reduceOnly: true }));
        this.log(`could not complete both legs — unwinding ${unwind.map((u) => u.coin).join(", ")}`);
        const uo = unwind.map((l) => ({ ...this.buildOrder(l, this.maxSlippage), _coin: l.coin }));
        const ur = this.parse(await this.send(wire(uo)), uo);
        return results.map((r) => ({ ...r, ok: false, unwound: true, unwindResult: ur.find((u) => u.coin === r.coin) || null }));
      }
    }
    return results;
  }
}
