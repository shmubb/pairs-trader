// Lighter broker: talks to src/exec/lighter_bridge.py (official SDK signing)
// over localhost. Same interface as the Hyperliquid and paper brokers.
//
// Lighter settles orders asynchronously, so fills are confirmed by reading
// positions before and after: a leg counts as filled when its position moved
// by (close to) the requested size. A missing leg is retried once with a
// fresh order; if it still won't fill, the filled leg is unwound reduce-only,
// so the account is never left holding one naked leg.

export class LighterBroker {
  constructor({ bridgeUrl = "http://127.0.0.1:8790", maxSlippage = 0.003, symbolMap = {}, confirmMs = 6000, pollMs = 400, log = console.log, fetchImpl } = {}) {
    this.mode = "lighter";
    this.url = bridgeUrl.replace(/\/$/, "");
    this.maxSlippage = maxSlippage;
    this.symbolMap = symbolMap;          // engine coin name → Lighter symbol (default: same name)
    this.confirmMs = confirmMs;
    this.pollMs = pollMs;
    this.log = log;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.mids = {};
  }

  sym(coin) { return this.symbolMap[coin] || coin; }
  coinOf(symbol) { return Object.keys(this.symbolMap).find((c) => this.symbolMap[c] === symbol) || symbol; }

  async call(path, body) {
    const r = await this.fetch(this.url + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(`lighter bridge ${path}: ${j.error || r.status}`);
    return j;
  }

  async init(markets) {
    await this.call("/health");
    this.lmarkets = await this.call("/markets");
    const missing = Object.keys(markets).filter((c) => !this.lmarkets[this.sym(c)]);
    if (missing.length) this.log(`lighter: no market for ${missing.join(", ")} — pairs using them can't trade (set a symbol map)`);
  }

  setMids(m) { this.mids = { ...this.mids, ...m }; }

  async account() { return this.call("/account"); }

  async positions() {
    const a = await this.account();
    const out = {};
    for (const [s, p] of Object.entries(a.positions || {})) out[this.coinOf(s)] = p;
    return out;
  }

  async equity() { return (await this.account()).equity; }

  async waitFor(before, targets) {
    // targets: [{coin, want}] — expected signed change in position.
    const t0 = Date.now();
    let pos = before;
    for (;;) {
      pos = await this.positions();
      const done = targets.every(({ coin, want }) => Math.abs((pos[coin]?.szi || 0) - (before[coin]?.szi || 0) - want) <= Math.abs(want) * 0.02 + 1e-12);
      if (done || Date.now() - t0 > this.confirmMs) return pos;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  async submit(legs) {
    const body = { legs: legs.map((l) => ({ symbol: this.sym(l.coin), size: l.size, reduceOnly: !!l.reduceOnly, maxSlippage: this.maxSlippage })) };
    return (await this.call("/orders", body)).results;
  }

  /** legs: [{coin, usd (signed) | szAbs with usd sign, reduceOnly}] → [{coin, ok, filledSz, avgPx, error}] */
  async executeLegs(legs) {
    const sized = legs.map((l) => ({ ...l, size: Math.sign(l.usd) * (l.szAbs ?? Math.abs(l.usd) / (this.mids[l.coin] || NaN)) })).filter((l) => Number.isFinite(l.size) && l.size !== 0);
    if (!sized.length) return [];
    const before = await this.positions();
    const sub = await this.submit(sized);
    for (const s of sub) if (!s.submitted) this.log(`lighter: ${s.symbol} not submitted — ${s.error}`);
    let after = await this.waitFor(before, sized.map((l, i) => ({ coin: l.coin, want: sub[i]?.submitted ? l.size : 0 })));
    const result = () => sized.map((l, i) => {
      const filled = (after[l.coin]?.szi || 0) - (before[l.coin]?.szi || 0);
      const ok = Math.abs(filled - l.size) <= Math.abs(l.size) * 0.02;
      return { coin: l.coin, ok, filledSz: filled, avgPx: this.mids[l.coin] ?? null, error: ok ? null : sub[i]?.error || "not filled in time" };
    });
    let res = result();
    const missing = res.map((r, i) => ({ r, l: sized[i] })).filter(({ r }) => !r.ok);
    if (missing.length && missing.length < res.length) {
      // Retry the shortfall once.
      const retry = missing.map(({ r, l }) => ({ ...l, size: l.size - r.filledSz }));
      this.log(`lighter: retrying ${retry.map((l) => l.coin).join(", ")}`);
      const mid = await this.positions();
      await this.submit(retry);
      after = await this.waitFor(mid, retry.map((l) => ({ coin: l.coin, want: l.size })));
      res = result();
      const still = res.filter((r) => !r.ok);
      if (still.length && still.length < res.length && sized.some((l) => !l.reduceOnly)) {
        const unwind = res.filter((r) => Math.abs(r.filledSz) > 0).map((r) => ({ coin: r.coin, size: -r.filledSz, reduceOnly: true }));
        this.log(`lighter: legs incomplete — unwinding ${unwind.map((u) => u.coin).join(", ")}`);
        await this.submit(unwind);
        await this.waitFor(after, unwind.map((u) => ({ coin: u.coin, want: u.size })));
        return res.map((r) => ({ ...r, ok: false, unwound: true }));
      }
    }
    return res;
  }
}
