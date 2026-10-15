// Directional and cross-sectional strategy families for the portfolio backtester.
//
// Each factory takes params and returns `strategy(ctx) → {asset: weight}`,
// called after bar k closes (see runPortfolio). Indicators that need state
// (EMAs, Donchian channels) are precomputed causally over the whole matrix
// once by `prepare(m)`: value at k only uses bars ≤ k.
//
// Weights are fractions of equity. Every family ends with `volTarget`, which
// scales the book to a target annualised portfolio volatility estimated from
// trailing returns, so families are comparable and risk stays stable.

import { ret, realVol, fundSum } from "./matrix.js";

const H = 3600_000;

// ---------------------------------------------------------------- preparation
/** Precompute causal indicators: EMAs of close, rolling highs/lows, trailing quote volume. */
export function prepare(m, { emas = [], donchian = [], volDays = 30 } = {}) {
  if (!m.ind) m.ind = { ema: {}, hi: {}, lo: {}, adv: {} };
  const nb = m.t.length;
  for (const n of emas) {
    if (m.ind.ema[n]) continue;
    m.ind.ema[n] = {};
    const alpha = 2 / (n + 1);
    for (const a of m.ids) {
      const c = m.c[a], e = new Float64Array(nb).fill(NaN);
      let v = NaN, seen = 0;
      for (let k = 0; k < nb; k++) {
        if (!(c[k] > 0)) { e[k] = NaN; continue; }
        v = Number.isNaN(v) ? c[k] : v + alpha * (c[k] - v);
        seen++;
        e[k] = seen >= n ? v : NaN; // not valid until it has seen n bars
      }
      m.ind.ema[n][a] = e;
    }
  }
  for (const n of donchian) {
    if (m.ind.hi[n]) continue;
    m.ind.hi[n] = {}; m.ind.lo[n] = {};
    for (const a of m.ids) {
      const hi = new Float64Array(nb).fill(NaN), lo = new Float64Array(nb).fill(NaN);
      for (let k = n; k < nb; k++) {
        let h = -Infinity, l = Infinity, ok = 0;
        for (let i = k - n; i < k; i++) if (m.c[a][i] > 0) { h = Math.max(h, m.h[a][i]); l = Math.min(l, m.l[a][i]); ok++; }
        if (ok >= n * 0.8) { hi[k] = h; lo[k] = l; } // channel of the n bars BEFORE k
      }
      m.ind.hi[n][a] = hi; m.ind.lo[n][a] = lo;
    }
  }
  const nAdv = Math.max(1, Math.round((volDays * 24) / m.barH));
  if (!m.ind.adv[nAdv]) {
    m.ind.adv[nAdv] = {};
    for (const a of m.ids) {
      const q = m.qv[a], out = new Float64Array(nb).fill(NaN);
      let s = 0, cnt = 0;
      for (let k = 0; k < nb; k++) {
        s += q[k]; cnt += m.c[a][k] > 0 ? 1 : 0;
        if (k >= nAdv) { s -= q[k - nAdv]; cnt -= m.c[a][k - nAdv] > 0 ? 1 : 0; }
        if (k >= nAdv - 1 && cnt >= nAdv * 0.9) out[k] = (s / nAdv) * (24 / m.barH); // $/day
      }
      m.ind.adv[nAdv][a] = out;
    }
  }
  m.ind.nAdv = nAdv;
  return m;
}

/** Tradeable assets at bar k: enough history, priced, top `topN` by trailing $ volume (≥ minAdv). */
export function universeAt(m, k, { topN = Infinity, minAdv = 0, minBars = 100, exclude = [] } = {}) {
  const adv = m.ind.adv[m.ind.nAdv];
  const out = [];
  for (const a of m.ids) {
    if (exclude.includes(a)) continue;
    if (!(m.c[a][k] > 0) || !(m.c[a][k - minBars] > 0)) continue;
    const v = adv[a][k];
    if (!(v >= minAdv)) continue;
    out.push(a);
  }
  if (out.length > topN) out.sort((x, y) => adv[y][k] - adv[x][k]).splice(topN);
  return out;
}

// ---------------------------------------------------------------- risk scaling
/** Annualised vol of a weight vector, from the last n bars of asset returns. */
export function portVol(m, k, w, n) {
  let s = 0, ss = 0, cnt = 0;
  for (let i = k - n + 1; i <= k; i++) {
    let r = 0;
    for (const a in w) {
      const c0 = m.c[a][i - 1], c1 = m.c[a][i];
      if (c0 > 0 && c1 > 0) r += w[a] * (c1 / c0 - 1);
    }
    s += r; ss += r * r; cnt++;
  }
  if (cnt < 2) return NaN;
  return Math.sqrt(Math.max(ss / cnt - (s / cnt) ** 2, 0) * (8760 / m.barH));
}

/** Scale weights so trailing portfolio vol = target (capped by maxLev gross). */
export function volTarget(m, k, w, { targetVol = 0.2, volBars, maxLev = 2 } = {}) {
  const n = volBars || Math.max(20, Math.round((60 * 24) / m.barH));
  const keys = Object.keys(w).filter((a) => w[a]);
  if (!keys.length) return {};
  const pv = portVol(m, k, w, n);
  if (!(pv > 0)) return {};
  let f = targetVol / pv;
  let gross = 0; for (const a of keys) gross += Math.abs(w[a]);
  if (gross * f > maxLev) f = maxLev / gross;
  const out = {};
  for (const a of keys) out[a] = w[a] * f;
  return out;
}

function invVolWeights(m, k, sig, volBars) {
  const w = {};
  for (const a in sig) {
    if (!sig[a]) continue;
    const v = realVol(m, a, k, volBars);
    if (v > 0) w[a] = sig[a] / v;
  }
  return w;
}

const volBarsFor = (m) => Math.max(20, Math.round((30 * 24) / m.barH));
const bars = (m, days) => Math.max(1, Math.round((days * 24) / m.barH));

// ---------------------------------------------------------------- families
/**
 * Time-series momentum: per asset, signal = mean of sign(return over L) for each L
 * in `lookbacksD` (days). longOnly drops shorts. Inverse-vol weights, then vol target.
 */
export function tsmom({ lookbacksD = [7, 14, 28, 56, 112], longOnly = false, uni = {}, risk = {} } = {}) {
  return ({ k, m }) => {
    const sig = {};
    for (const a of universeAt(m, k, { minBars: bars(m, Math.max(...lookbacksD)), ...uni })) {
      let s = 0, n = 0;
      for (const L of lookbacksD) { const r = ret(m, a, k, bars(m, L)); if (Number.isFinite(r)) { s += Math.sign(r); n++; } }
      if (!n) continue;
      s /= n;
      if (longOnly && s < 0) s = 0;
      sig[a] = s;
    }
    return volTarget(m, k, invVolWeights(m, k, sig, volBarsFor(m)), risk);
  };
}

/** EMA-crossover trend: signal = mean of sign(EMA_fast − EMA_slow) over the given pairs (in bars). */
export function emaTrend({ pairs = [[8, 32], [16, 64], [32, 128]], longOnly = false, uni = {}, risk = {} } = {}) {
  return ({ k, m }) => {
    const sig = {};
    for (const a of universeAt(m, k, { minBars: Math.max(...pairs.map((p) => p[1])), ...uni })) {
      let s = 0, n = 0;
      for (const [f, sl] of pairs) {
        const ef = m.ind.ema[f]?.[a]?.[k], es = m.ind.ema[sl]?.[a]?.[k];
        if (ef > 0 && es > 0) { s += Math.sign(ef - es); n++; }
      }
      if (!n) continue;
      s /= n;
      if (longOnly && s < 0) s = 0;
      sig[a] = s;
    }
    return volTarget(m, k, invVolWeights(m, k, sig, volBarsFor(m)), risk);
  };
}

/**
 * Donchian breakout: go long on a close above the prior N-bar high, short below the
 * prior N-bar low; exit when price crosses the opposite N/2 channel. Stateful per asset,
 * but the state only depends on bars ≤ k (computed lazily and cached forward).
 */
export function donchian({ n = 20, exitN, longOnly = false, uni = {}, risk = {} } = {}) {
  const ex = exitN || Math.max(2, Math.round(n / 2));
  let state = null, lastK = -1;
  return ({ k, m }) => {
    if (!state) state = Object.fromEntries(m.ids.map((a) => [a, 0]));
    // Advance state over any bars skipped since the last call (warm-up included).
    for (let j = lastK < 0 ? n + 1 : lastK + 1; j <= k; j++) {
      for (const a of m.ids) {
        const c = m.c[a][j], hi = m.ind.hi[n][a][j], lo = m.ind.lo[n][a][j], xh = m.ind.hi[ex][a][j], xl = m.ind.lo[ex][a][j];
        if (!(c > 0) || Number.isNaN(hi)) { state[a] = 0; continue; }
        if (state[a] === 0) { if (c > hi) state[a] = 1; else if (c < lo && !longOnly) state[a] = -1; }
        else if (state[a] === 1 && c < xl) state[a] = c < lo && !longOnly ? -1 : 0;
        else if (state[a] === -1 && c > xh) state[a] = c > hi ? 1 : 0;
      }
    }
    lastK = k;
    const sig = {};
    for (const a of universeAt(m, k, { minBars: n + 1, ...uni })) if (state[a]) sig[a] = state[a];
    return volTarget(m, k, invVolWeights(m, k, sig, volBarsFor(m)), risk);
  };
}

/**
 * Cross-sectional: rank assets by a score each bar; long the top `q` fraction, short the
 * bottom (dollar-neutral, inverse-vol within each side). Score = return over `lookbackD`
 * days skipping the last `skipD` days (momentum) or minus it (reversal).
 */
export function xsRank({ score, q = 0.3, longShort = true, uni = {}, risk = {} } = {}) {
  return ({ k, m }) => {
    const pool = universeAt(m, k, uni).map((a) => [a, score(m, a, k)]).filter(([, s]) => Number.isFinite(s));
    if (pool.length < 6) return {};
    pool.sort((x, y) => y[1] - x[1]);
    const nq = Math.max(1, Math.floor(pool.length * q));
    const longs = pool.slice(0, nq).map((x) => x[0]), shorts = longShort ? pool.slice(-nq).map((x) => x[0]) : [];
    const w = {};
    const side = (list, sgn) => {
      const iv = list.map((a) => [a, 1 / realVol(m, a, k, volBarsFor(m))]).filter(([, v]) => v > 0);
      const tot = iv.reduce((s, [, v]) => s + v, 0);
      for (const [a, v] of iv) w[a] = (sgn * v) / tot;
    };
    side(longs, 1);
    if (longShort) side(shorts, -1);
    return volTarget(m, k, w, risk);
  };
}

export const scores = {
  momentum: (lookbackD, skipD = 0) => (m, a, k) => {
    const s = bars(m, skipD), L = bars(m, lookbackD);
    const c1 = m.c[a][k - s], c0 = m.c[a][k - s - L];
    return c1 > 0 && c0 > 0 ? Math.log(c1 / c0) / (realVol(m, a, k, volBarsFor(m)) || NaN) : NaN;
  },
  reversal: (lookbackD) => (m, a, k) => {
    const r = ret(m, a, k, bars(m, lookbackD));
    return Number.isFinite(r) ? -r / (realVol(m, a, k, volBarsFor(m)) || NaN) : NaN;
  },
  /** Carry: receive funding. Score = −(trailing funding), so the lowest-funding coins rank long. */
  carry: (lookbackD) => (m, a, k) => {
    const n = bars(m, lookbackD);
    return m.c[a][k - n] > 0 ? -fundSum(m, a, k, n) : NaN;
  },
};

/**
 * Funding contrarian (time series): when an asset's trailing funding is extreme
 * (crowded), fade the crowd. Annualised funding above `hi` → short; below `lo` → long.
 * Holds while the condition lasts.
 */
export function fundingContrarian({ lookbackD = 3, hi = 0.3, lo = -0.1, uni = {}, risk = {} } = {}) {
  return ({ k, m }) => {
    const n = bars(m, lookbackD);
    const sig = {};
    for (const a of universeAt(m, k, uni)) {
      const ann = fundSum(m, a, k, n) * (365 / lookbackD);
      if (ann > hi) sig[a] = -1; else if (ann < lo) sig[a] = 1;
    }
    return volTarget(m, k, invVolWeights(m, k, sig, volBarsFor(m)), risk);
  };
}

/** Regime-filtered long-only basket: hold the basket only while BTC is above its N-day SMA. */
export function regimeLong({ smaD = 100, uni = {}, risk = {}, ref = "BTC" } = {}) {
  return ({ k, m }) => {
    const n = bars(m, smaD);
    let s = 0, cnt = 0;
    for (let i = k - n + 1; i <= k; i++) if (m.c[ref][i] > 0) { s += m.c[ref][i]; cnt++; }
    if (cnt < n * 0.9 || !(m.c[ref][k] > s / cnt)) return {};
    const sig = {};
    for (const a of universeAt(m, k, uni)) sig[a] = 1;
    return volTarget(m, k, invVolWeights(m, k, sig, volBarsFor(m)), risk);
  };
}

/** Blend several strategies with fixed risk weights (each already vol-targeted). */
export function blend(parts) {
  return (ctx) => {
    const out = {};
    for (const [fn, wt] of parts) {
      const w = fn(ctx);
      for (const a in w) out[a] = (out[a] || 0) + wt * w[a];
    }
    return out;
  };
}

/** Always-long benchmark (equal risk basket, vol targeted). */
export function buyHold({ uni = {}, risk = {} } = {}) {
  return ({ k, m }) => {
    const sig = {};
    for (const a of universeAt(m, k, uni)) sig[a] = 1;
    return volTarget(m, k, invVolWeights(m, k, sig, volBarsFor(m)), risk);
  };
}

export { H };

// ---------------------------------------------------------------- the production book
/**
 * Carry + trend: the strategy the research selected (docs/CARRY_TREND.md).
 *  - carry leg: cross-sectional, long the lowest-funding third of the universe,
 *    short the highest-funding third (trailing `carryD` days of funding),
 *    inverse-vol within each side, dollar-neutral;
 *  - trend leg: time-series momentum, sign of 7/14/28/56/112-day returns averaged
 *    per asset, inverse-vol weighted;
 *  - each leg is scaled to `targetVol`, then blended `wCarry` : 1 − `wCarry`.
 * Universe: top `topN` assets by trailing 30-day $ volume above `minAdv`.
 */
export const CARRY_TREND_DEFAULTS = {
  carryD: 7, q: 0.3, lookbacksD: [7, 14, 28, 56, 112], wCarry: 0.5,
  topN: 20, minAdv: 20e6, targetVol: 0.2, maxLev: 3, band: 0.25,
};

export function carryTrend(params = {}) {
  const p = { ...CARRY_TREND_DEFAULTS, ...params };
  const uni = { topN: p.topN, minAdv: p.minAdv }, risk = { targetVol: p.targetVol, maxLev: p.maxLev };
  const carry = xsRank({ score: scores.carry(p.carryD), q: p.q, uni, risk });
  const trend = tsmom({ lookbacksD: p.lookbacksD, uni, risk });
  const fn = (ctx) => {
    const c = carry(ctx), t = trend(ctx), out = {};
    for (const a in c) out[a] = (out[a] || 0) + p.wCarry * c[a];
    for (const a in t) out[a] = (out[a] || 0) + (1 - p.wCarry) * t[a];
    fn.last = { carry: c, trend: t }; // per-leg weights, for display
    return out;
  };
  fn.params = p;
  return fn;
}
