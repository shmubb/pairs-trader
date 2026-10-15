import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oimTrigger, oimNotional, barStats, OIM_DEFAULTS } from "../src/core/oi-momentum.js";
import { MomentumEngine } from "../src/exec/momentum-engine.js";
import { HyperliquidInfo } from "../src/data/hyperliquid.js";
import { BinanceFutures } from "../src/data/binance-live.js";

const MIN = 60_000, BAR = 5 * MIN, H = 3600_000, DAY = 24 * H;

function rng(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/**
 * 8 days of 5-minute bars ending at `end`. During the last hour before `pumpEnd`,
 * AAA and BBB rise 0.25% per bar (+3%/h); AAA's OI rises 5% in that hour, BBB's stays flat.
 */
function world(end, pumpEnd) {
  const g = rng(3), n = 8 * 288;
  const coins = ["AAA", "BBB", "CCC"];
  const bars = {}, oiAt = {};
  for (const c of coins) {
    let p = 100;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const t = end - (n - i) * BAR;
      const o = p;
      const pumping = (c === "AAA" || c === "BBB") && t >= pumpEnd - H && t < pumpEnd;
      p *= Math.exp(pumping ? 0.0025 : 0.001 * g());
      rows.push({ t, o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 1000 });
    }
    bars[c] = rows;
    oiAt[c] = (t) => (c === "AAA" ? 1e6 * (1 + 0.05 * Math.min(1, Math.max(0, (t - (pumpEnd - H)) / H))) : 1e6);
  }
  return { coins, bars, oiAt };
}

function fakeHL(w, clock) {
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const now = clock();
    const ok = (x) => ({ ok: true, status: 200, json: async () => x });
    const last = (c) => w.bars[c].filter((r) => r.t <= now).at(-1).c;
    switch (body.type) {
      case "metaAndAssetCtxs": return ok([{ universe: w.coins.map((c) => ({ name: c, szDecimals: 3, maxLeverage: 20 })) }, w.coins.map((c) => ({ funding: "0.0000125", markPx: String(last(c)), midPx: String(last(c)), oraclePx: String(last(c)), openInterest: String(w.oiAt[c](now)), dayNtlVlm: "3e7", premium: "0", prevDayPx: "1" }))]);
      case "candleSnapshot": {
        const { coin, startTime, endTime } = body.req;
        return ok(w.bars[coin].filter((r) => r.t >= startTime && r.t <= Math.min(endTime, now)).slice(0, 5000).map((r) => ({ t: r.t, o: String(r.o), h: String(r.h), l: String(r.l), c: String(r.c), v: String(r.v), n: 1 })));
      }
      default: throw new Error("unexpected " + body.type);
    }
  };
  return new HyperliquidInfo({ fetchImpl, weightPerMinute: 1e9 });
}

function fakeBinance(w, clock) {
  const fetchImpl = async (url) => {
    const u = new URL(url), q = Object.fromEntries(u.searchParams), now = clock();
    const sym = q.symbol.replace("USDT", "");
    const ok = (x) => ({ ok: true, status: 200, json: async () => x });
    if (u.pathname === "/fapi/v1/klines") return ok(w.bars[sym].filter((r) => r.t >= +q.startTime && r.t <= Math.min(+q.endTime, now)).slice(0, 1500).map((r) => [r.t, String(r.o), String(r.h), String(r.l), String(r.c), String(r.v), r.t + BAR - 1, String(r.v * r.c), 1, "0"]));
    if (u.pathname === "/futures/data/openInterestHist") {
      const out = [];
      for (let t = Math.ceil(+q.startTime / BAR) * BAR; t <= Math.min(+q.endTime, now) && out.length < 500; t += BAR) out.push({ symbol: q.symbol, sumOpenInterest: String(w.oiAt[sym](t)), timestamp: t });
      return ok(out);
    }
    throw new Error("unexpected " + u.pathname);
  };
  return new BinanceFutures({ fetchImpl });
}

test("oimTrigger: fires on a big up-move with OI build-up, not without it", () => {
  const n = 2200, t0 = Date.UTC(2025, 0, 1);
  const m = { ids: ["X"], bph: 12, t: new Float64Array(n), c: { X: new Float64Array(n) }, qv: { X: new Float64Array(n).fill(1) }, oi: { X: new Float64Array(n).fill(100) } };
  const g = rng(5);
  let p = 100;
  for (let k = 0; k < n; k++) { m.t[k] = t0 + k * BAR; p *= Math.exp(k >= n - 12 ? 0.003 : 0.001 * g()); m.c.X[k] = p; }
  barStats(m);
  const k = n - 1;
  assert.equal(oimTrigger(m, "X", k, OIM_DEFAULTS), 0, "price move alone is not enough");
  for (let i = n - 12; i < n; i++) m.oi.X[i] = 100 * (1 + 0.004 * (i - (n - 13)));
  const t = oimTrigger(m, "X", k, OIM_DEFAULTS);
  assert.equal(t.dir, 1);
  assert.ok(t.z >= 2.5 && t.dOi >= 0.03, JSON.stringify(t));
  assert.equal(oimTrigger(m, "X", k, { ...OIM_DEFAULTS, hoursUTC: [25, 26] }), 0, "outside trading hours");
  const usd = oimNotional(m, "X", k, 10_000, OIM_DEFAULTS);
  assert.ok(Math.abs(usd - (10_000 * 0.0025) / (m.sig.X[k] * Math.sqrt(96))) < 1e-6);
});

async function runEngine(source) {
  const end = Math.floor(Date.UTC(2026, 5, 1) / BAR) * BAR;
  const pumpEnd = end - 26 * H;
  const w = world(end, pumpEnd);
  let now = pumpEnd - 13 * H + 30_000;
  const clock = () => now;
  const dir = await mkdtemp(join(tmpdir(), "mom-"));
  const logs = [];
  const eng = new MomentumEngine({ cfg: { signalSource: source, strategy: { minAdv: 1e6 } }, assets: w.coins.map((c) => ({ id: c, hl: c, binance: c + "USDT" })), mode: "paper", equity: 10_000, stateDir: dir, info: fakeHL(w, clock), binance: fakeBinance(w, clock), log: (m) => logs.push(m), now: clock });
  await eng.start();
  // Tick every 5 minutes (30 s after each close) through the pump and beyond: the move keeps
  // re-triggering on the 4-h and 12-h windows (extending the hold) for ~12 h, then 8 h to exit.
  while (now < pumpEnd + 24 * H) { await eng.tick(); now += BAR; }
  return { eng, logs, dir, pumpEnd, setNow: (t) => (now = t), clock };
}

test("momentum engine (paper, Hyperliquid OI recorded live): longs the OI-backed pump only, exits after the hold", async () => {
  const { eng, logs } = await runEngine("hyperliquid");
  const opens = logs.filter((l) => / LONG trigger/.test(l));
  assert.ok(opens.length >= 1 && opens.every((l) => l.startsWith("AAA")), logs.join("\n"));
  assert.ok(!logs.some((l) => l.startsWith("BBB: LONG")), "BBB pumped without OI build-up: no trade");
  assert.ok(logs.some((l) => /AAA: closed \(hold time up\)/.test(l)), logs.join("\n"));
  assert.equal(eng.state.trades.length, 0);
  const pos = await eng.broker.positions();
  assert.equal(Object.values(pos).filter((p) => p.szi).length, 0);
});

test("momentum engine (paper, Binance signals): same decision from the research data source", async () => {
  const { logs } = await runEngine("binance");
  const opens = logs.filter((l) => / LONG trigger/.test(l));
  assert.ok(opens.length >= 1 && opens.every((l) => l.startsWith("AAA")), logs.join("\n"));
  assert.ok(logs.some((l) => /AAA: closed \(hold time up\)/.test(l)));
});

test("momentum engine: kill switch flattens open trades", async () => {
  const end = Math.floor(Date.UTC(2026, 5, 1) / BAR) * BAR;
  const pumpEnd = end - 20 * H;
  const w = world(end, pumpEnd);
  let now = pumpEnd - 13 * H + 30_000;
  const clock = () => now;
  const dir = await mkdtemp(join(tmpdir(), "mom-"));
  const logs = [];
  const eng = new MomentumEngine({ cfg: { strategy: { minAdv: 1e6 } }, assets: w.coins.map((c) => ({ id: c, hl: c, binance: c + "USDT" })), mode: "paper", equity: 10_000, stateDir: dir, info: fakeHL(w, clock), log: (m) => logs.push(m), now: clock });
  await eng.start();
  while (now < pumpEnd + H && !eng.state.trades.length) { await eng.tick(); now += BAR; }
  assert.equal(eng.state.trades.length, 1, logs.join("\n"));
  await writeFile(join(dir, "KILL"), "");
  await eng.tick();
  assert.equal(eng.state.trades.length, 0);
  assert.ok(eng.state.halted);
  assert.equal(Object.values(await eng.broker.positions()).filter((p) => p.szi).length, 0);
});
