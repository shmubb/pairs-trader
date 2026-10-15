import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMatrix, realVol } from "../src/core/matrix.js";
import { runPortfolio } from "../src/research/portfolio.js";
import { carryTrend, prepare, portVol } from "../src/core/xs-strategies.js";
import { PortfolioEngine, planOrders } from "../src/exec/portfolio-engine.js";
import { HyperliquidInfo } from "../src/data/hyperliquid.js";

const H = 3600_000, DAY = 24 * H;

function rng(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/** n daily bars for `count` coins: coin i drifts by drift[i]/day, funding fund[i] per hour. */
function synth({ count = 12, n = 300, end = Math.floor(Date.now() / DAY) * DAY, seed = 7 } = {}) {
  const g = rng(seed);
  const series = {};
  for (let i = 0; i < count; i++) {
    const coin = `C${i}`;
    const drift = (i - count / 2) * 0.002; // C0 falls, C11 rises
    const hourly = (i % 4 - 1.5) * 2e-5;   // funding levels differ by coin
    let p = 100;
    const k = [], funding = [];
    for (let d = 0; d < n; d++) {
      const t = end - (n - d) * DAY;
      const o = p;
      p *= Math.exp(drift + 0.03 * g());
      k.push({ t, o, h: Math.max(o, p) * 1.01, l: Math.min(o, p) * 0.99, c: p, v: 1e6, qv: 1e6 * p });
      for (let h = 0; h < 24; h++) funding.push({ t: t + h * H, rate: hourly });
    }
    series[coin] = { k, funding, hourly, drift };
  }
  return series;
}

test("matrix: resamples hourly bars to daily, sums funding, drops the incomplete bar", () => {
  const t0 = Date.UTC(2025, 0, 1);
  const k = [], funding = [];
  for (let h = 0; h < 24 * 3 + 5; h++) { const px = 100 + h; k.push({ t: t0 + h * H, o: px, h: px + 1, l: px - 1, c: px + 0.5, qv: 10 }); }
  for (let h = 0; h < 24 * 3 + 5; h += 8) funding.push({ t: t0 + h * H, rate: 0.0001 });
  const m = buildMatrix({ X: { k, funding } }, { barH: 24 });
  assert.equal(m.t.length, 3, "the 5-hour partial day is not a bar");
  assert.equal(m.o.X[0], 100);
  assert.equal(m.c.X[0], 123.5);
  assert.equal(m.h.X[1], 24 + 23 + 100 + 1);
  assert.equal(m.qv.X[2], 240);
  assert.ok(Math.abs(m.fund.X[0] - 0.0003) < 1e-12);
  const m2 = buildMatrix({ X: { k, funding } }, { barH: 24, now: t0 + 2 * DAY + 3 * H });
  assert.equal(m2.t.length, 2, "`now` cuts the day still in progress");
});

test("portfolio backtest: trades at the next open, charges costs and funding", () => {
  const t0 = Date.UTC(2025, 0, 1);
  // Close→open gaps: +10% overnight jumps the strategy must not capture on the first day.
  const px = [[100, 100], [110, 121], [121, 121], [121, 133.1]]; // [open, close]
  const k = px.map(([o, c], i) => ({ t: t0 + i * DAY, o, h: Math.max(o, c), l: Math.min(o, c), c, qv: 1 }));
  const funding = [{ t: t0 + 2 * DAY + H, rate: 0.001 }];
  const m = buildMatrix({ X: { k, funding } }, { barH: 24 });
  const r = runPortfolio(m, () => ({ X: 1 }), { costBps: 10 });
  // Decided at close of bar 0 → enters at the open of bar 1 (110), pays 10 bp.
  // bar1: 110→121 (+10%); bar2: 121→121, funding −0.1%; bar3: 121→133.1 (+10%).
  const expected = (1 - 0.001) * 1.1 * (1 - 0.001) * 1.1;
  assert.ok(Math.abs(r.curve.at(-1) - expected) < 1e-9, `${r.curve.at(-1)} vs ${expected}`);
  assert.ok(Math.abs(r.fundingTotal + 0.001) < 1e-12);
});

test("carry + trend: shorts high funding, follows trend, hits the vol target", () => {
  const s = synth();
  const m = buildMatrix(s, { barH: 24 });
  prepare(m, {});
  const book = carryTrend({ minAdv: 0, topN: 20 });
  const k = m.t.length - 1;
  const w = book({ k, m, ids: m.ids });
  const { carry, trend } = book.last;
  // Carry: highest funding coins (i%4 == 3) short, lowest (i%4 == 0) long.
  for (const a of Object.keys(carry)) {
    const f = s[a].hourly;
    if (f > 0.00002) assert.ok(carry[a] < 0, `${a} funding ${f} should be short in carry, got ${carry[a]}`);
    if (f < -0.00002) assert.ok(carry[a] > 0, `${a} funding ${f} should be long in carry`);
  }
  assert.ok(Math.abs(Object.values(carry).reduce((x, y) => x + y, 0)) < 0.02, "carry leg ≈ dollar-neutral");
  assert.ok(trend.C11 > 0 && trend.C0 < 0, "trend leg is long the riser, short the faller");
  const pv = portVol(m, k, trend, 60);
  assert.ok(Math.abs(pv - 0.2) < 1e-6, `trend leg vol ${pv}`);
  assert.ok(Object.keys(w).length > 0);
  assert.ok(Number.isFinite(realVol(m, "C0", k, 30)));
});

test("planOrders: band, minimum size, closes and sign flips", () => {
  const mids = { A: 10, B: 20, C: 5, D: 1 };
  const positions = { A: { szi: 100 }, B: { szi: -10 }, C: { szi: 40 }, D: { szi: 0 } };
  // A: $1000 → $1100 (inside 25% band, skip). B: -$200 → +$300 (flip). C: $200 → 0 (close). D: 0 → $8 (below min, skip).
  const orders = planOrders({ weights: { A: 0.11, B: 0.03, D: 0.0008 }, equity: 10_000, positions, mids, coins: ["A", "B", "C", "D"], band: 0.25, minOrderUsd: 15 });
  const by = (c) => orders.filter((o) => o.coin === c);
  assert.equal(by("A").length, 0);
  assert.equal(by("B").length, 2);
  assert.ok(by("B")[0].reduceOnly && by("B")[0].szAbs === 10 && by("B")[0].deltaUsd > 0);
  assert.ok(!by("B")[1].reduceOnly && Math.abs(by("B")[1].deltaUsd - 300) < 1e-9);
  assert.equal(by("C").length, 1);
  assert.ok(by("C")[0].reduceOnly && by("C")[0].szAbs === 40 && by("C")[0].deltaUsd < 0);
  assert.equal(by("D").length, 0);
});

/** Fake Hyperliquid /info serving the synthetic daily series. */
function fakeHL(series, now) {
  const coins = Object.keys(series);
  const last = (c) => series[c].k.at(-1).c;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const ok = (x) => ({ ok: true, status: 200, json: async () => x });
    switch (body.type) {
      case "metaAndAssetCtxs": return ok([{ universe: coins.map((c) => ({ name: c, szDecimals: 3, maxLeverage: 20 })) }, coins.map((c) => ({ funding: String(series[c].hourly), markPx: String(last(c)), midPx: String(last(c)), oraclePx: String(last(c)), openInterest: "1", dayNtlVlm: "1e8", premium: "0", prevDayPx: "1" }))]);
      case "candleSnapshot": {
        const { coin, startTime, endTime } = body.req;
        // Include an in-progress candle for today, like the real endpoint.
        const rows = [...series[coin].k, { t: Math.floor(now / DAY) * DAY, o: last(coin), h: last(coin), l: last(coin), c: last(coin) * 1.5, v: 1 }];
        return ok(rows.filter((r) => r.t >= startTime && r.t <= endTime).map((r) => ({ t: r.t, o: String(r.o), h: String(r.h), l: String(r.l), c: String(r.c), v: String(r.v), n: 1 })));
      }
      case "fundingHistory": return ok(series[body.coin].funding.filter((f) => f.t >= body.startTime && f.t <= body.endTime).slice(0, 500).map((f) => ({ coin: body.coin, time: f.t, fundingRate: String(f.rate), premium: "0" })));
      default: throw new Error("unexpected " + body.type);
    }
  };
  return new HyperliquidInfo({ fetchImpl, weightPerMinute: 1e9 });
}

test("portfolio engine (paper): same book as the backtest, rebalances once a day, kill switch flattens", async () => {
  const now = Math.floor(Date.now() / DAY) * DAY + 2 * H; // 02:00 UTC: today's rebalance is due
  const series = synth({ end: Math.floor(now / DAY) * DAY });
  const dir = await mkdtemp(join(tmpdir(), "pf-"));
  const logs = [];
  const cfg = { book: { minAdv: 0 }, minAssets: 4 };
  const eng = new PortfolioEngine({ cfg, coins: Object.keys(series), mode: "paper", equity: 10_000, stateDir: dir, info: fakeHL(series, now), log: (m) => logs.push(m), now: () => now });
  await eng.start();

  // Same weights as the strategy run directly on the matrix (from daily candles, today's partial bar dropped).
  const m = await eng.loadMatrix();
  assert.equal(m.t.at(-1), Math.floor(now / DAY) * DAY - DAY, "last bar is yesterday's completed candle");
  const direct = carryTrend({ ...eng.cfg.book })({ k: m.t.length - 1, m, ids: m.ids });
  const plan = await eng.plan(m);
  assert.deepEqual(plan.weights, direct);

  await eng.tick();
  const pos = await eng.broker.positions();
  const eq = await eng.broker.equity();
  for (const [c, w] of Object.entries(plan.weights)) {
    if (Math.abs(w * eq) < 15) continue;
    const held = (pos[c]?.szi || 0) * eng.mids[c];
    assert.ok(Math.abs(held - w * 10_000) < 0.01 * 10_000, `${c}: held ${held.toFixed(0)} vs target ${(w * 10_000).toFixed(0)}`);
  }
  assert.ok(logs.some((l) => l.startsWith("book for")), logs.join("\n"));

  // Second tick the same day: no new rebalance.
  const n = logs.filter((l) => l.startsWith("book for")).length;
  await eng.tick();
  assert.equal(logs.filter((l) => l.startsWith("book for")).length, n);

  // Kill switch.
  await writeFile(join(dir, "KILL"), "");
  await eng.tick();
  const after = await eng.broker.positions();
  assert.equal(Object.values(after).filter((p) => p.szi).length, 0, "flat after KILL");
  assert.ok(eng.state.halted);
});
