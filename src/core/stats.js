// Statistics used by the signal: regression, unit-root / cointegration tests,
// Ornstein-Uhlenbeck fitting, Hurst exponent. Plain functions over arrays of
// numbers; no dependencies, so the same file runs in the browser and Node.

export function mean(xs, from = 0, to = xs.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += xs[i];
  return s / (to - from);
}

export function variance(xs, from = 0, to = xs.length, ddof = 1) {
  const m = mean(xs, from, to);
  let s = 0;
  for (let i = from; i < to; i++) s += (xs[i] - m) ** 2;
  return s / (to - from - ddof);
}

export function std(xs, from = 0, to = xs.length, ddof = 1) {
  return Math.sqrt(variance(xs, from, to, ddof));
}

/** Simple OLS y = a + b x over [from, to). Returns {a, b, residStd, r2}. */
export function ols(x, y, from = 0, to = x.length) {
  const n = to - from;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = from; i < to; i++) {
    sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; syy += y[i] * y[i];
  }
  const vx = sxx - (sx * sx) / n;
  const cxy = sxy - (sx * sy) / n;
  const vy = syy - (sy * sy) / n;
  const b = vx === 0 ? 0 : cxy / vx;
  const a = (sy - b * sx) / n;
  const sse = Math.max(0, vy - b * cxy);
  return { a, b, residStd: Math.sqrt(sse / Math.max(1, n - 2)), r2: vy === 0 ? 0 : 1 - sse / vy };
}

/** Pearson correlation of x and y over [from, to). */
export function correlation(x, y, from = 0, to = x.length) {
  const n = to - from;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = from; i < to; i++) {
    sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; sxy += x[i] * y[i];
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  return den === 0 ? 0 : num / den;
}

/**
 * Least squares for small dense systems via normal equations and Gaussian
 * elimination. X is an array of rows. Returns {beta, se, sigma2, n, k}.
 */
export function lstsq(X, y) {
  const n = X.length, k = X[0].length;
  const xtx = Array.from({ length: k }, () => new Float64Array(k));
  const xty = new Float64Array(k);
  for (let r = 0; r < n; r++) {
    const row = X[r];
    for (let i = 0; i < k; i++) {
      xty[i] += row[i] * y[r];
      for (let j = i; j < k; j++) xtx[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < k; i++) for (let j = 0; j < i; j++) xtx[i][j] = xtx[j][i];
  const inv = invert(xtx);
  if (!inv) return null;
  const beta = new Float64Array(k);
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) beta[i] += inv[i][j] * xty[j];
  let sse = 0;
  for (let r = 0; r < n; r++) {
    let f = 0;
    for (let i = 0; i < k; i++) f += X[r][i] * beta[i];
    sse += (y[r] - f) ** 2;
  }
  const sigma2 = sse / (n - k);
  const se = new Float64Array(k);
  for (let i = 0; i < k; i++) se[i] = Math.sqrt(Math.max(0, inv[i][i] * sigma2));
  return { beta, se, sigma2, sse, n, k };
}

function invert(m) {
  const k = m.length;
  const a = m.map((row, i) => {
    const r = new Float64Array(2 * k);
    r.set(row);
    r[k + i] = 1;
    return r;
  });
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-14) return null;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * k; j++) a[c][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * k; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((r) => r.slice(k));
}

// ---------------------------------------------------------------------------
// Normal CDF (Abramowitz & Stegun 7.1.26 via erf; |error| < 1.5e-7)
export function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// MacKinnon (1994) p-value surface, regression with constant ("c"),
// index N-1 where N is the number of I(1) series: N=1 for a plain ADF test,
// N=2 for an Engle-Granger test on a two-asset regression residual.
// Tables as published and as used by statsmodels.tsa.adfvalues.
const TAU_STAR_C = [-1.61, -2.62, -3.13, -3.47, -3.78, -3.93];
const TAU_MIN_C = [-18.83, -18.86, -23.48, -28.07, -25.96, -23.27];
const TAU_MAX_C = [2.74, 0.92, 0.55, 0.61, 0.79, 1];
const TAU_C_SMALLP = [
  [2.1659, 1.4412, 3.8269], [2.92, 1.5012, 3.9796], [3.4699, 1.4856, 3.164],
  [3.9673, 1.4777, 2.6315], [4.5509, 1.5338, 2.9545], [5.1399, 1.6036, 3.4445],
].map(([a, b, c]) => [a, b, c * 1e-2]);
const TAU_C_LARGEP = [
  [1.7339, 9.3202, -1.2745, -1.0368], [2.1945, 6.4695, -2.9198, -4.2377],
  [2.5893, 4.5168, -3.6529, -5.0074], [3.0387, 4.5452, -3.3666, -4.1921],
  [3.5049, 5.2098, -2.9158, -3.3468], [3.9489, 5.8933, -2.5359, -2.721],
].map(([a, b, c, d]) => [a, b * 1e-1, c * 1e-1, d * 1e-2]);

/** MacKinnon approximate p-value for a tau statistic (constant-only regression). */
export function mackinnonP(tau, N = 1) {
  const i = N - 1;
  if (tau > TAU_MAX_C[i]) return 1;
  if (tau < TAU_MIN_C[i]) return 0;
  const coef = tau <= TAU_STAR_C[i] ? TAU_C_SMALLP[i] : TAU_C_LARGEP[i];
  let v = 0;
  for (let j = coef.length - 1; j >= 0; j--) v = v * tau + coef[j];
  return normCdf(v);
}

// MacKinnon (2010) finite-sample critical values, constant-only.
const CRIT_C_2010 = {
  1: { "1%": [-3.43035, -6.5393, -16.786, -79.433], "5%": [-2.86154, -2.8903, -4.234, -40.04], "10%": [-2.56677, -1.5384, -2.809, 0] },
  2: { "1%": [-3.89644, -10.9519, -22.527, 0], "5%": [-3.33613, -6.1101, -6.823, 0], "10%": [-3.04445, -4.2412, -2.72, 0] },
};
export function mackinnonCrit(N, nobs) {
  const out = {};
  for (const [k, c] of Object.entries(CRIT_C_2010[N])) out[k] = c[0] + c[1] / nobs + c[2] / nobs ** 2 + c[3] / nobs ** 3;
  return out;
}

/**
 * Augmented Dickey-Fuller test with a constant:
 *   Δy_t = α + γ y_{t-1} + Σ φ_i Δy_{t-i} + ε
 * `N` picks the p-value table (1 = plain ADF, 2 = Engle-Granger residual).
 * `lags` is fixed (fast, used in rolling scans) or "aic" for automatic choice.
 */
export function adf(y, { lags = 1, N = 1, maxLag } = {}) {
  const n = y.length;
  if (lags === "aic") {
    const ml = maxLag ?? Math.floor(12 * (n / 100) ** 0.25);
    let best = null;
    for (let p = 0; p <= ml; p++) {
      // Same sample for every candidate so AIC is comparable.
      const r = adfFit(y, p, ml);
      if (!r) continue;
      const aic = r.nobs * Math.log(r.sse / r.nobs) + 2 * (p + 2);
      if (!best || aic < best.aic) best = { p, aic };
    }
    lags = best ? best.p : 1;
  }
  const r = adfFit(y, lags, lags);
  if (!r) return { stat: NaN, pValue: 1, lags, nobs: 0 };
  return { stat: r.stat, pValue: mackinnonP(r.stat, N), lags, nobs: r.nobs, crit: mackinnonCrit(N, r.nobs), gamma: r.gamma };
}

function adfFit(y, p, start) {
  const X = [], dy = [];
  for (let t = start + 1; t < y.length; t++) {
    const row = [1, y[t - 1]];
    for (let i = 1; i <= p; i++) row.push(y[t - i] - y[t - i - 1]);
    X.push(row);
    dy.push(y[t] - y[t - 1]);
  }
  if (X.length < p + 10) return null;
  const fit = lstsq(X, dy);
  if (!fit) return null;
  return { stat: fit.beta[1] / fit.se[1], gamma: fit.beta[1], sse: fit.sse, nobs: X.length };
}

/**
 * Fit a discretised Ornstein-Uhlenbeck process to a series via AR(1):
 *   s_{t+1} = c + φ s_t + ε
 * θ = -ln φ (per bar), μ = c / (1 - φ), equilibrium σ = σ_ε / sqrt(1 - φ²),
 * half-life = ln 2 / θ bars. φ ≥ 1 means no mean reversion (half-life ∞).
 */
export function fitOU(s, from = 0, to = s.length) {
  const n = to - from - 1;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = from; i < to - 1; i++) {
    const x = s[i], y = s[i + 1];
    sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
  }
  const vx = sxx - (sx * sx) / n;
  const phi = vx === 0 ? 1 : (sxy - (sx * sy) / n) / vx;
  const c = (sy - phi * sx) / n;
  const sse = Math.max(0, syy - (sy * sy) / n - phi * (sxy - (sx * sy) / n));
  const sigmaEps = Math.sqrt(sse / Math.max(1, n - 2));
  if (!(phi > 0 && phi < 1)) {
    return { phi, theta: 0, mu: mean(s, from, to), sigmaEq: std(s, from, to), sigmaEps, halfLife: Infinity };
  }
  const theta = -Math.log(phi);
  return {
    phi, theta,
    mu: c / (1 - phi),
    sigmaEq: sigmaEps / Math.sqrt(1 - phi * phi),
    sigmaEps,
    halfLife: Math.LN2 / theta,
  };
}

/**
 * Hurst exponent from how the dispersion of τ-step changes scales with τ:
 * std(x_{t+τ} - x_t) ∝ τ^H. H < 0.5 mean-reverting, 0.5 random walk,
 * > 0.5 trending. Lags spaced geometrically.
 */
export function hurst(x, from = 0, to = x.length, { minLag = 2, maxLag } = {}) {
  const n = to - from;
  const hi = Math.min(maxLag ?? Math.floor(n / 8), n - 2);
  const lags = [];
  for (let l = minLag; l <= hi; l = Math.max(l + 1, Math.round(l * 1.5))) lags.push(l);
  if (lags.length < 3) return NaN;
  const lx = [], ly = [];
  for (const lag of lags) {
    let s = 0, ss = 0, m = 0;
    for (let i = from + lag; i < to; i++) {
      const d = x[i] - x[i - lag];
      s += d; ss += d * d; m++;
    }
    const v = ss / m - (s / m) ** 2;
    if (v <= 0) continue;
    lx.push(Math.log(lag));
    ly.push(0.5 * Math.log(v));
  }
  if (lx.length < 3) return NaN;
  return ols(lx, ly).b;
}

/** Variance ratio VR(q) = Var(q-step change) / (q · Var(1-step change)). < 1 → mean reversion. */
export function varianceRatio(x, q, from = 0, to = x.length) {
  let s1 = 0, ss1 = 0, n1 = 0, sq = 0, ssq = 0, nq = 0;
  for (let i = from + 1; i < to; i++) { const d = x[i] - x[i - 1]; s1 += d; ss1 += d * d; n1++; }
  for (let i = from + q; i < to; i++) { const d = x[i] - x[i - q]; sq += d; ssq += d * d; nq++; }
  const v1 = ss1 / n1 - (s1 / n1) ** 2;
  const vq = ssq / nq - (sq / nq) ** 2;
  return v1 > 0 ? vq / (q * v1) : NaN;
}

/** Log returns of a price array. Output[i] is the return into bar i (output[0] = 0). */
export function logReturns(prices) {
  const r = new Float64Array(prices.length);
  for (let i = 1; i < prices.length; i++) r[i] = Math.log(prices[i] / prices[i - 1]);
  return r;
}

export function quantile(xs, q) {
  const a = Array.from(xs).filter(Number.isFinite).sort((p, r) => p - r);
  if (!a.length) return NaN;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export function median(xs) { return quantile(xs, 0.5); }
