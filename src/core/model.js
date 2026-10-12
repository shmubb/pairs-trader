// Streaming model of one pair. Feed it bars in time order; after each bar it
// reports the spread's z-score plus every diagnostic the strategy gates on.
//
// The spread is s = ln(A) - β·ln(B). β, the OU equilibrium (μ, σ) and the
// tests are re-estimated every `recalEvery` bars on the trailing
// `formationBars` window, using only data up to the current bar. Between
// recalibrations the parameters are held fixed, so z moves only because prices
// move — not because the mean is chasing the price. That was failure #1 of the
// old system (24h rolling mean/std that collapsed z back toward 0 in trends).

import { ols, fitOU, adf, hurst, correlation, std, mean } from "./stats.js";
import { KalmanHedge } from "./kalman.js";

export const MODEL_DEFAULTS = {
  hedge: "ols",            // "ols" | "kalman" | "ratio" (β ≡ 1, the old log-ratio)
  zMethod: "ou",           // "ou" (OU equilibrium) | "rolling" (window mean/std — the old app's method, kept for comparison)
  formationBars: 720,
  longFormationBars: 2160,
  recalEvery: 24,
  kalmanDelta: 1e-5,
  adfLags: 1,
  volShortBars: 24,
  corrShortBars: 72,
  zVelocityBars: 3,
  zExtremeBars: 12,
  volumeAvgBars: 720,
  legMoveBars: 24,
};

export class PairModel {
  constructor(cfg = {}) {
    this.cfg = { ...MODEL_DEFAULTS, ...cfg };
    const keep = Math.max(this.cfg.formationBars, this.cfg.longFormationBars) + 64;
    this.keep = keep;
    this.t = []; this.la = []; this.lb = []; this.ra = []; this.rb = []; this.qa = []; this.qb = []; this.oiA = []; this.oiB = [];
    this.zHist = [];
    this.params = null;
    this.long = null;
    this.sinceRecal = Infinity;
    this.kalman = this.cfg.hedge === "kalman" ? new KalmanHedge({ delta: this.cfg.kalmanDelta }) : null;
    this.kBeta = null;
    this.volEwmaA = null; this.volEwmaB = null;
    this.breakStreak = 0;
  }

  /** bar: {t, pa, pb, qa?, qb?} — close prices of both legs and (optional) quote volumes. */
  update(bar) {
    const c = this.cfg;
    const la = Math.log(bar.pa), lb = Math.log(bar.pb);
    const n0 = this.la.length;
    this.t.push(bar.t); this.la.push(la); this.lb.push(lb);
    this.ra.push(n0 ? la - this.la[n0 - 1] : 0);
    this.rb.push(n0 ? lb - this.lb[n0 - 1] : 0);
    this.qa.push(bar.qa ?? 0); this.qb.push(bar.qb ?? 0);
    this.oiA.push(bar.oiA ?? NaN); this.oiB.push(bar.oiB ?? NaN);

    // Volume EWMAs (prior to this bar) for relative-volume readings.
    const vDecay = 2 / (c.volumeAvgBars + 1);
    const rvA = this.volEwmaA ? (bar.qa ?? 0) / this.volEwmaA : 1;
    const rvB = this.volEwmaB ? (bar.qb ?? 0) / this.volEwmaB : 1;
    this.volEwmaA = this.volEwmaA == null ? (bar.qa ?? 0) : this.volEwmaA + vDecay * ((bar.qa ?? 0) - this.volEwmaA);
    this.volEwmaB = this.volEwmaB == null ? (bar.qb ?? 0) : this.volEwmaB + vDecay * ((bar.qb ?? 0) - this.volEwmaB);

    if (this.kalman) {
      if (this.kalman.x == null && this.la.length >= 50) {
        const f = ols(this.lb, this.la);
        this.kalman.seed(f.a, f.b, f.residStd ** 2);
      }
      if (this.kalman.x) this.kBeta = this.kalman.step(la, lb);
    }

    if (this.la.length > this.keep + 512) this.trim();

    const n = this.la.length;
    this.sinceRecal++;
    if (n >= c.formationBars && this.sinceRecal >= c.recalEvery) this.recalibrate();

    if (!this.params) {
      this.zHist.push(NaN);
      return { t: bar.t, ready: false, bars: n };
    }

    const p = this.params;
    const s = la - p.beta * lb;
    const z = (s - p.mu) / p.sigmaEq;
    this.zHist.push(z);
    const zl = this.long ? (s - this.long.mu) / this.long.sigmaEq : NaN;

    // z velocity (toward/away from mean) and the recent extreme, for "stall" entries.
    const zh = this.zHist;
    const back = zh[zh.length - 1 - c.zVelocityBars];
    const zVel = Number.isFinite(back) ? z - back : 0;
    let zExtreme = z;
    for (let i = Math.max(0, zh.length - c.zExtremeBars); i < zh.length; i++) {
      if (Number.isFinite(zh[i]) && Math.abs(zh[i]) > Math.abs(zExtreme) && Math.sign(zh[i]) === Math.sign(z)) zExtreme = zh[i];
    }

    // Short-horizon spread volatility vs the formation-window innovation σ.
    const vs = c.volShortBars;
    let ss = 0;
    for (let i = n - vs; i < n; i++) {
      const d = (this.la[i] - this.la[i - 1]) - p.beta * (this.lb[i] - this.lb[i - 1]);
      ss += d * d;
    }
    const volRatio = Math.sqrt(ss / vs) / p.sigmaEps;

    // How violently has each leg moved over legMoveBars, in units of its own σ?
    const lm = c.legMoveBars;
    const legMoveA = (la - this.la[n - 1 - lm]) / (p.volA * Math.sqrt(lm));
    const legMoveB = (lb - this.lb[n - 1 - lm]) / (p.volB * Math.sqrt(lm));
    // Open-interest change over the same window: rising OI behind a move = new
    // positioning (often informed); falling OI = forced closing (liquidations).
    const oiChgA = this.oiA[n - 1] / this.oiA[n - 1 - lm] - 1;
    const oiChgB = this.oiB[n - 1] / this.oiB[n - 1 - lm] - 1;

    return {
      t: bar.t, ready: true, bars: n,
      pa: bar.pa, pb: bar.pb,
      spread: s, z, zLong: zl, zVel, zExtreme,
      beta: p.beta, mu: p.mu, sigmaEq: p.sigmaEq, sigmaEps: p.sigmaEps,
      halfLife: p.halfLife, cointP: p.cointP, adfStat: p.adfStat, hurst: p.hurst,
      corr: p.corr, corrShort: p.corrShort, betaDrift: p.betaDrift,
      volRatio, rvA, rvB, legMoveA, legMoveB, oiChgA, oiChgB,
      kalmanBeta: this.kBeta ? this.kBeta.beta : null,
      recalAt: p.t,
    };
  }

  recalibrate() {
    const c = this.cfg;
    const n = this.la.length;
    const from = n - c.formationBars;
    let beta, alpha;
    if (c.hedge === "ratio") { beta = 1; alpha = 0; }
    else if (c.hedge === "kalman" && this.kBeta) { beta = this.kalman.x[1]; alpha = this.kalman.x[0]; }
    else { const f = ols(this.lb, this.la, from, n); beta = f.b; alpha = f.a; }

    const s = new Float64Array(c.formationBars);
    for (let i = from; i < n; i++) s[i - from] = this.la[i] - beta * this.lb[i];
    const ou = fitOU(s);
    // Engle-Granger: when β is estimated, residual-based critical values (N=2) apply.
    const test = adf(s, { lags: c.adfLags, N: c.hedge === "ratio" ? 1 : 2 });
    const H = hurst(s);
    const corr = correlation(this.ra, this.rb, from + 1, n);
    const corrShort = correlation(this.ra, this.rb, n - c.corrShortBars, n);
    const volA = std(this.ra, from + 1, n);
    const volB = std(this.rb, from + 1, n);

    const prevBeta = this.params ? this.params.beta : beta;
    const rolling = c.zMethod === "rolling";
    const sigmaEq = rolling ? std(s, 0, s.length, 0) : Number.isFinite(ou.halfLife) ? ou.sigmaEq : std(s);
    this.params = {
      t: this.t[n - 1], beta, alpha,
      mu: rolling ? mean(s) : ou.mu, sigmaEq, sigmaEps: ou.sigmaEps, halfLife: ou.halfLife,
      cointP: test.pValue, adfStat: test.stat, hurst: H, corr, corrShort, volA, volB,
      betaDrift: prevBeta ? Math.abs(beta - prevBeta) / Math.abs(prevBeta) : 0,
    };

    if (n >= c.longFormationBars) {
      const lf = n - c.longFormationBars;
      const sl = new Float64Array(c.longFormationBars);
      for (let i = lf; i < n; i++) sl[i - lf] = this.la[i] - beta * this.lb[i];
      const oul = fitOU(sl);
      this.long = { mu: oul.mu, sigmaEq: Number.isFinite(oul.halfLife) ? oul.sigmaEq : std(sl), halfLife: oul.halfLife };
    }
    this.sinceRecal = 0;
  }

  trim() {
    const cut = this.la.length - this.keep;
    for (const k of ["t", "la", "lb", "ra", "rb", "qa", "qb", "oiA", "oiB", "zHist"]) this[k] = this[k].slice(cut);
  }
}
