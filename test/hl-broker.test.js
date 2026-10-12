import { test } from "node:test";
import assert from "node:assert/strict";
import { HyperliquidBroker } from "../src/exec/hl-broker.js";
import { formatPrice, formatSize } from "../src/exec/precision.js";

test("precision: sizes truncate, prices keep 5 significant figures and the decimal cap", () => {
  assert.equal(formatSize(1.23456789, 3), "1.234");
  assert.equal(formatSize(0.0009, 3), "0");
  assert.equal(formatPrice(97123.456, 5, true), "97124");
  assert.equal(formatPrice(97123.456, 5, false), "97123");
  assert.equal(formatPrice(3456.789, 4, true), "3456.8");
  assert.equal(formatPrice(1.234567, 0, false), "1.2345");
  assert.equal(formatPrice(0.000123456, 0, true), "0.000124");
  assert.equal(formatPrice(123456.7, 0, true), "123457"); // integers may exceed 5 sig figs
});

/** SDK-like stub: throws when any leg errors, with per-leg statuses on e.response. */
function stubExchange(script) {
  const calls = [];
  return {
    calls,
    async updateLeverage() { return { status: "ok" }; },
    async order({ orders }) {
      calls.push(orders);
      const statuses = script(orders, calls.length);
      const body = { status: "ok", response: { type: "order", data: { statuses } } };
      if (statuses.some((s) => s.error)) { const e = new Error("leg error"); e.response = body; throw e; }
      return body;
    },
  };
}

function broker(script) {
  const info = { async clearinghouseState() { return { withdrawable: "100000", marginSummary: { accountValue: "100000" }, assetPositions: [] }; } };
  const b = new HyperliquidBroker({ info, account: "0x" + "1".repeat(40), agentKey: "0x" + "2".repeat(64), log: () => {} });
  b.markets = { ETH: { asset: 1, szDecimals: 4, maxLeverage: 25 }, BTC: { asset: 0, szDecimals: 5, maxLeverage: 40 } };
  b.exchange = stubExchange(script);
  b.leverageSet = new Set();
  b.setMids({ ETH: 3000, BTC: 100000 });
  return b;
}

const fill = (o) => ({ filled: { totalSz: o.s, avgPx: o.p, oid: 1 } });

test("both legs fill in one action", async () => {
  const b = broker((orders) => orders.map(fill));
  const r = await b.executeLegs([{ coin: "ETH", usd: 3000 }, { coin: "BTC", usd: -3000 }]);
  assert.equal(b.exchange.calls.length, 1, "one signed action for both legs");
  assert.equal(b.exchange.calls[0].length, 2);
  assert.ok(r.every((x) => x.ok));
  assert.ok(r[0].filledSz > 0 && r[1].filledSz < 0);
});

test("second leg fails once, retry completes it", async () => {
  const b = broker((orders, n) => (n === 1 ? [fill(orders[0]), { error: "Order could not immediately match" }] : orders.map(fill)));
  const r = await b.executeLegs([{ coin: "ETH", usd: 3000 }, { coin: "BTC", usd: -3000 }]);
  assert.equal(b.exchange.calls.length, 2);
  assert.equal(b.exchange.calls[1][0].a, 0, "retry only the BTC leg");
  assert.ok(r.every((x) => x.ok));
});

test("second leg keeps failing → first leg is unwound reduce-only", async () => {
  const b = broker((orders, n) => (n === 1 ? [fill(orders[0]), { error: "no liquidity" }] : n <= 3 ? orders.map(() => ({ error: "no liquidity" })) : orders.map(fill)));
  const r = await b.executeLegs([{ coin: "ETH", usd: 3000 }, { coin: "BTC", usd: -3000 }]);
  const last = b.exchange.calls[b.exchange.calls.length - 1];
  assert.equal(last.length, 1);
  assert.equal(last[0].a, 1, "unwinds ETH");
  assert.equal(last[0].r, true, "reduce-only");
  assert.equal(last[0].b, false, "sells back what was bought");
  assert.ok(r.every((x) => !x.ok && x.unwound));
});

test("margin pre-check blocks the trade before any order is sent", async () => {
  const b = broker((orders) => orders.map(fill));
  b.info.clearinghouseState = async () => ({ withdrawable: "100", marginSummary: { accountValue: "100" }, assetPositions: [] });
  const r = await b.executeLegs([{ coin: "ETH", usd: 3000 }, { coin: "BTC", usd: -3000 }]);
  assert.equal(b.exchange.calls.length, 0);
  assert.ok(r.every((x) => !x.ok && /margin/.test(x.error)));
});

test("hybrid entry: post-only on the thinner leg, then hedge the filled fraction with IOC", async () => {
  const b = broker((orders) => orders.map((o) => (o.t.limit.tif === "Alo" ? { resting: { oid: 7 } } : fill(o))));
  b.markets.ETH.dayNtlVlm = 1e9; b.markets.BTC.dayNtlVlm = 5e9; // ETH is the thinner leg → maker
  b.info.l2Book = async () => ({ levels: [[{ px: "2999.5", sz: "10" }], [{ px: "3000.5", sz: "10" }]] });
  let polls = 0;
  b.info.orderStatus = async () => { polls++; return { order: { status: polls >= 2 ? "canceled" : "open", order: { origSz: "1", sz: "0.4" } } }; };
  b.exchange.cancelByCloid = async () => ({ status: "ok" });
  const r = await b.executeLegs([{ coin: "ETH", usd: 3000 }, { coin: "BTC", usd: -3000 }], { style: "hybrid" });
  const [first, second] = b.exchange.calls;
  assert.equal(first[0].t.limit.tif, "Alo", "maker leg is post-only");
  assert.equal(first[0].a, 1);
  assert.equal(second[0].t.limit.tif, "Ioc", "hedge is IOC");
  assert.equal(second[0].a, 0);
  // 0.6 of the maker order filled → hedge 60% of the BTC leg.
  assert.ok(Math.abs(+second[0].s - 0.018) < 0.0002, `hedge size ${second[0].s}`);
  assert.ok(r.every((x) => x.ok));
});
