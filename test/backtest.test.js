import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "../src/core/backtest.js";
import { planPosition } from "../src/core/risk.js";
import { STRATEGY_DEFAULTS, mergeConfig } from "../src/core/strategy.js";

function rng(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/** Synthetic cointegrated pair: ln A = 0.3 + 1.2 ln B + OU(half-life hl). */
function synthPair(n, { hl = 12, sigma = 0.004, seed = 1, breakAt = null } = {}) {
  const g = rng(seed);
  const phi = Math.pow(0.5, 1 / hl);
  let lb = Math.log(100), e = 0;
  const bars = [];
  for (let i = 0; i < n; i++) {
    lb += 0.006 * g();
    e = (breakAt != null && i >= breakAt) ? e + 0.003 + sigma * g() : phi * e + sigma * g();
    const la = 0.3 + 1.2 * lb + e;
    const pa = Math.exp(la), pb = Math.exp(lb);
    const prev = bars[i - 1];
    bars.push({ t: Date.UTC(2024, 0, 1) + i * 3600_000, oa: prev ? prev.pa : pa, ob: prev ? prev.pb : pb, pa, pb, qa: 1e9, qb: 1e9, fa: 0, fb: 0, fundA: 0, fundB: 0 });
  }
  return bars;
}

const cfg = { sessions: null, risk: { dailyLossLimit: 1, maxDrawdownHalt: 1 } };

test("profits on a genuinely mean-reverting pair", () => {
  const bars = synthPair(6000, { seed: 11 });
  const r = runBacktest(bars, cfg, { startT: bars[800].t });
  assert.ok(r.metrics.trades > 20, `trades ${r.metrics.trades}`);
  assert.ok(r.metrics.totalReturn > 0, `return ${r.metrics.totalReturn}`);
  assert.ok(r.metrics.profitFactor > 1.2, `PF ${r.metrics.profitFactor}`);
});

test("accounting: trade PnLs sum to the change in equity", () => {
  const bars = synthPair(5000, { seed: 5 });
  const r = runBacktest(bars, cfg, { startT: bars[800].t });
  const sum = r.trades.reduce((s, t) => s + t.pnl, 0);
  const change = r.equity[r.equity.length - 1] - 10_000;
  assert.ok(Math.abs(sum - change) < 1e-6 * 10_000, `sum ${sum} vs change ${change}`);
});

test("no look-ahead: decisions before bar k don't depend on bars after k", () => {
  const bars = synthPair(5000, { seed: 9 });
  const full = runBacktest(bars, cfg, { startT: bars[800].t });
  const cut = 3500;
  const part = runBacktest(bars.slice(0, cut), cfg, { startT: bars[800].t });
  const closedBefore = (rs) => rs.trades.filter((t) => t.closeT < bars[cut - 2].t && t.kind !== "OPEN").map((t) => `${t.openT}|${t.closeT}|${t.pnl.toFixed(6)}`);
  assert.deepEqual(closedBefore(part), closedBefore(full));
});

test("a broken relationship: gates keep us out, and with gates off the stop caps the loss near 1R", () => {
  const bars = synthPair(4000, { seed: 3, breakAt: 2500 });
  const r = runBacktest(bars, cfg, { startT: bars[800].t });
  for (const t of r.trades.filter((t) => t.openT >= bars[2400].t)) assert.ok(t.ret > -0.02, `trade lost ${(t.ret * 100).toFixed(2)}%`);
  assert.ok(r.metrics.maxDrawdown < 0.05, `maxDD ${r.metrics.maxDrawdown}`);

  const noGates = { ...cfg, gates: { maxCointP: 1, maxHurst: 9, minCorr: -1, minCorrShort: -1, maxVolRatio: 99, maxHalfLifeBars: 1e9, maxLegMoveSigma: 99, maxOpposingLongZ: 99 }, entry: { confirm: "none", minEdgeCostRatio: 0 } };
  const r2 = runBacktest(bars, noGates, { startT: bars[800].t });
  const stops = r2.trades.filter((t) => t.openT >= bars[2400].t && t.kind === "STOP");
  assert.ok(stops.length >= 1, "expected at least one stop after the break");
  for (const t of stops) assert.ok(t.r > -1.6, `stop lost ${t.r.toFixed(2)}R`);
});

test("sizing: full ladder + stop costs ≈ riskPerTrade of equity", () => {
  const strat = mergeConfig(STRATEGY_DEFAULTS, {});
  const snap = { z: -2.1, beta: 1.2, sigmaEq: 0.01 };
  const plan = planPosition(snap, strat, { riskPerTrade: 0.01, maxGrossLeverage: 100 }, { equity: 10_000 });
  assert.ok(plan.ok);
  assert.ok(Math.abs(plan.maxLoss - 100) < 1e-6, `max loss ${plan.maxLoss}`);
  // Leg B is β times leg A.
  assert.ok(Math.abs(plan.notionalB / plan.notionalA - 1.2) < 1e-9);
  // Tranches add up to the plan.
  const sumA = plan.tranches.reduce((s, t) => s + t.notionalA, 0);
  assert.ok(Math.abs(sumA - plan.notionalA) < 1e-6);
});

test("sizing respects the gross leverage cap", () => {
  const strat = mergeConfig(STRATEGY_DEFAULTS, {});
  const plan = planPosition({ z: 2.2, beta: 1, sigmaEq: 0.0005 }, strat, { riskPerTrade: 0.01, maxGrossLeverage: 2 }, { equity: 10_000 });
  assert.ok(plan.gross <= 20_000 + 1e-6, `gross ${plan.gross}`);
  assert.ok(plan.limits.includes("gross leverage cap"));
});
