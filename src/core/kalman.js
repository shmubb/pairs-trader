// Kalman filter for a time-varying hedge ratio:
//   a_t = α_t + β_t · b_t + ε_t       (a, b are log prices)
//   [α, β]_t = [α, β]_{t-1} + w_t     (random walk, covariance δ/(1-δ) · I)
// `delta` sets how quickly β may drift: smaller = steadier. The observation
// noise is estimated online from the innovations, so it adapts to the
// spread's volatility instead of needing hand tuning.
//
// step() returns the *prior* estimate (what was known before seeing bar t),
// so using it to build a spread at bar t carries no look-ahead.

export class KalmanHedge {
  constructor({ delta = 1e-5, obsVarInit = 1e-4, obsVarHalfLife = 500 } = {}) {
    this.wq = delta / (1 - delta);
    this.x = null; // [alpha, beta]
    this.P = [[1, 0], [0, 1]];
    this.R = obsVarInit;
    this.rDecay = Math.pow(0.5, 1 / obsVarHalfLife);
    this.n = 0;
  }

  /** Seed state from an OLS fit so the filter doesn't spend its first weeks converging. */
  seed(alpha, beta, residVar) {
    this.x = [alpha, beta];
    this.P = [[residVar * 10, 0], [0, residVar * 10]];
    this.R = residVar;
  }

  step(a, b) {
    if (!this.x) this.seed(a - b, 1, this.R);
    // Predict
    const P = [[this.P[0][0] + this.wq, this.P[0][1]], [this.P[1][0], this.P[1][1] + this.wq]];
    const prior = { alpha: this.x[0], beta: this.x[1] };
    const yhat = this.x[0] + this.x[1] * b;
    const e = a - yhat;
    // H = [1, b]; S = H P H' + R
    const Ph0 = P[0][0] + P[0][1] * b;
    const Ph1 = P[1][0] + P[1][1] * b;
    const S = Ph0 + Ph1 * b + this.R;
    const K0 = Ph0 / S, K1 = Ph1 / S;
    this.x = [this.x[0] + K0 * e, this.x[1] + K1 * e];
    this.P = [
      [P[0][0] - K0 * Ph0, P[0][1] - K0 * Ph1],
      [P[1][0] - K1 * Ph0, P[1][1] - K1 * Ph1],
    ];
    // Online observation-noise estimate (EWMA of e² minus the state part).
    const stateVar = Ph0 + Ph1 * b;
    this.R = Math.max(1e-12, this.rDecay * this.R + (1 - this.rDecay) * Math.max(e * e - stateVar, 1e-12));
    this.n++;
    return { ...prior, innovation: e, innovationVar: S };
  }
}
