import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/exec/engine.js";
import { HyperliquidInfo } from "../src/data/hyperliquid.js";
import { loadConfig } from "../src/util/config.js";

function rng(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/** A fake Hyperliquid /info endpoint serving a synthetic cointegrated pair AAA/BBB. */
function fakeHL() {
  const g = rng(42), H = 3600_000;
  const end = Math.floor(Date.now() / H) * H; // current (open) hour
  const n = 2600, phi = Math.pow(0.5, 1 / 12);
  let lb = Math.log(50), e = 0;
  const A = [], B = [];
  for (let i = 0; i < n; i++) {
    lb += 0.006 * g(); e = phi * e + 0.004 * g();
    const t = end - (n - 1 - i) * H;
    const pa = Math.exp(0.3 + 1.2 * lb + e), pb = Math.exp(lb);
    A.push({ t, o: pa, h: pa, l: pa, c: pa, v: 1e6, n: 10 });
    B.push({ t, o: pb, h: pb, l: pb, c: pb, v: 1e6, n: 10 });
  }
  const series = { AAA: A, BBB: B };
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const ok = (x) => ({ ok: true, status: 200, json: async () => x });
    switch (body.type) {
      case "metaAndAssetCtxs": return ok([{ universe: [{ name: "AAA", szDecimals: 3, maxLeverage: 20 }, { name: "BBB", szDecimals: 2, maxLeverage: 20 }] }, [
        { funding: "0.0000125", markPx: String(A.at(-1).c), midPx: String(A.at(-1).c), oraclePx: String(A.at(-1).c), openInterest: "1000", dayNtlVlm: "500000000", premium: "0", prevDayPx: "1" },
        { funding: "0.0000125", markPx: String(B.at(-1).c), midPx: String(B.at(-1).c), oraclePx: String(B.at(-1).c), openInterest: "1000", dayNtlVlm: "500000000", premium: "0", prevDayPx: "1" }]]);
      case "allMids": return ok({ AAA: String(A.at(-1).c), BBB: String(B.at(-1).c) });
      case "candleSnapshot": {
        const { coin, startTime, endTime } = body.req;
        return ok(series[coin].filter((r) => r.t >= startTime && r.t <= endTime).slice(0, 5000).map((r) => ({ ...r, o: String(r.o), h: String(r.h), l: String(r.l), c: String(r.c), v: String(r.v) })));
      }
      case "fundingHistory": return ok([]);
      default: throw new Error("unexpected " + body.type);
    }
  };
  return new HyperliquidInfo({ fetchImpl, weightPerMinute: 1e9 });
}

test("engine: warms up, opens a β-weighted pair, closes it, and honours the kill switch (paper)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pt-"));
  const cfg = await loadConfig(undefined, { model: { hedge: "ols" } }); // mechanics test: regression β so leg sizing is non-trivial
  const logs = [];
  const eng = new Engine({ cfg, pairs: [{ a: "AAA", b: "BBB", hlA: "AAA", hlB: "BBB" }], mode: "paper", equity: 10_000, stateDir: dir, port: 0, info: fakeHL(), autoLoop: false, log: (m) => logs.push(m) });
  await eng.start();
  const p = eng.pairs[0];
  assert.ok(p.snap.ready, "model should be warm");
  assert.ok(Math.abs(p.snap.beta - 1.2) < 0.15, `beta ${p.snap.beta}`);

  await eng.tick();
  // Force an entry at the current snapshot.
  const snap = { ...p.snap, z: -2.2 };
  p.strategy.pos = { dir: 1, openedBar: p.barIndex, entry: { beta: snap.beta, mu: snap.mu, sigmaEq: snap.sigmaEq, halfLife: snap.halfLife }, ladder: [{ z: 0, weight: 0.5, filled: true }], filledWeight: 0.5, lastAddBar: p.barIndex, breakStreak: 0, timeStopBars: 36 };
  await eng.execute(p, { type: "open", weight: 0.5 }, snap);
  const pos = await eng.broker.positions();
  assert.ok(pos.AAA.szi > 0 && pos.BBB.szi < 0, "long A / short B");
  const usdA = pos.AAA.szi * eng.mids.AAA, usdB = -pos.BBB.szi * eng.mids.BBB;
  assert.ok(Math.abs(usdB / usdA - Math.abs(snap.beta)) < 0.05, `B/A ${usdB / usdA} vs β ${snap.beta}`);
  assert.ok(Math.abs(usdA - 0.5 * p.plan.notionalA) / usdA < 0.02);

  await eng.closePair(p, "test close");
  const after = await eng.broker.positions();
  assert.equal(Object.keys(after).length, 0, "flat after close");
  assert.equal(eng.trades.length, 1);

  // Kill switch flattens an open position on the next tick.
  p.strategy.pos = { dir: -1, openedBar: p.barIndex, entry: { beta: snap.beta, mu: snap.mu, sigmaEq: snap.sigmaEq, halfLife: snap.halfLife }, ladder: [{ z: 0, weight: 1, filled: true }], filledWeight: 1, lastAddBar: p.barIndex, breakStreak: 0, timeStopBars: 36 };
  await eng.execute(p, { type: "open", weight: 1 }, { ...snap, z: 2.2 });
  assert.ok((await eng.broker.positions()).AAA.szi < 0);
  await writeFile(join(dir, "KILL"), "");
  await eng.tick();
  assert.equal(Object.keys(await eng.broker.positions()).length, 0, "kill switch flattened");
  const saved = JSON.parse(await readFile(join(dir, "engine-paper.json"), "utf8").catch(() => "{}"));
  assert.ok(saved.mode === "paper" || saved.mode === undefined);
  eng.running = false;
});
