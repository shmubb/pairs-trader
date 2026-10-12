import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adf, fitOU, hurst, ols, mackinnonP, normCdf, varianceRatio } from "../src/core/stats.js";
import { KalmanHedge } from "../src/core/kalman.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/statsmodels_adf.json", import.meta.url)));

// Deterministic PRNG + normals for synthetic series.
function rng(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

test("normal CDF matches known values", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.9750021) < 1e-6);
  assert.ok(Math.abs(normCdf(-2.326) - 0.0100) < 1e-4);
});

test("ADF statistic and p-value match statsmodels (constant, fixed lags)", () => {
  for (const c of fixtures) {
    for (const [key, lags] of [["adf1", 1], ["adf0", 0]]) {
      const r = adf(c.y, { lags, N: 1 });
      assert.ok(Math.abs(r.stat - c[key].stat) < 1e-6, `${c.kind} ${key} stat ${r.stat} vs ${c[key].stat}`);
      assert.ok(Math.abs(r.pValue - c[key].p) < 1e-4, `${c.kind} ${key} p ${r.pValue} vs ${c[key].p}`);
    }
  }
});

test("Engle-Granger test separates cointegrated from independent random walks", () => {
  for (const c of fixtures.filter((f) => f.x)) {
    const f = ols(c.x, c.y);
    const resid = c.y.map((y, i) => y - f.a - f.b * c.x[i]);
    const r = adf(resid, { lags: 1, N: 2 });
    // statsmodels runs the residual ADF without a constant; ours keeps one, so allow a small gap.
    assert.ok(Math.abs(r.stat - c.coint1.stat) < 0.05, `${c.kind} stat ${r.stat} vs ${c.coint1.stat}`);
    if (c.kind === "coint") assert.ok(r.pValue < 0.01);
    if (c.kind === "nocoint") assert.ok(r.pValue > 0.05);
  }
});

test("MacKinnon p-value is monotone and bounded", () => {
  let prev = 0;
  for (let t = -6; t <= 1; t += 0.1) {
    const p = mackinnonP(t, 2);
    assert.ok(p >= prev - 1e-12 && p <= 1);
    prev = p;
  }
});

test("OU fit recovers a known half-life", () => {
  const g = rng(1);
  const phi = Math.pow(0.5, 1 / 20); // half-life 20 bars
  const s = [0];
  for (let i = 1; i < 20000; i++) s.push(5 + phi * (s[i - 1] - 5) + 0.01 * g());
  const ou = fitOU(s);
  assert.ok(Math.abs(ou.halfLife - 20) < 2, `half-life ${ou.halfLife}`);
  assert.ok(Math.abs(ou.mu - 5) < 0.01, `mu ${ou.mu}`);
  const expectedSigma = 0.01 / Math.sqrt(1 - phi * phi);
  assert.ok(Math.abs(ou.sigmaEq / expectedSigma - 1) < 0.1);
});

test("OU fit reports no reversion for a random walk", () => {
  const g = rng(2);
  const s = [0];
  for (let i = 1; i < 3000; i++) s.push(s[i - 1] + g());
  const ou = fitOU(s);
  assert.ok(ou.halfLife > 200, `half-life ${ou.halfLife}`);
});

test("Hurst and variance ratio separate mean reversion, random walk and trend", () => {
  const g = rng(3);
  const rw = [0], mr = [0], tr = [0];
  let m = 0;
  for (let i = 1; i < 5000; i++) {
    rw.push(rw[i - 1] + g());
    mr.push(0.7 * mr[i - 1] + g());
    m = 0.6 * m + g();
    tr.push(tr[i - 1] + m);
  }
  assert.ok(hurst(mr) < 0.3, `mr ${hurst(mr)}`);
  assert.ok(Math.abs(hurst(rw) - 0.5) < 0.1, `rw ${hurst(rw)}`);
  assert.ok(hurst(tr) > 0.55, `trend ${hurst(tr)}`);
  assert.ok(varianceRatio(mr, 10) < 0.5);
  assert.ok(varianceRatio(tr, 10) > 1.5);
});

test("Kalman hedge converges to the true β and tracks a change", () => {
  const g = rng(4);
  const k = new KalmanHedge({ delta: 1e-4 });
  let b = 0, last;
  for (let i = 0; i < 6000; i++) {
    b += 0.01 * g();
    const beta = i < 3000 ? 1.5 : 0.8;
    last = k.step(0.2 + beta * b + 0.002 * g(), b);
    if (i === 2999) assert.ok(Math.abs(last.beta - 1.5) < 0.1, `beta ${last.beta}`);
  }
  assert.ok(Math.abs(last.beta - 0.8) < 0.1, `beta after change ${last.beta}`);
});
