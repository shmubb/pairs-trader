// OI-backed momentum: the short-horizon strategy (docs/OI_MOMENTUM.md).
//
// When a coin makes an unusually large move UP (≥ zMin standard deviations over
// 1, 4 or 12 hours) while open interest rises ≥ oiMin over the same window —
// i.e. new positions are piling in, not shorts covering — the move tends to
// continue for the next several hours. Checked every 5 minutes; go long at the close that confirms it,
// hold `holdH` hours, size so a 1σ move over the hold costs `riskPerTrade`.
//
// Pure functions on the shared matrix (src/core/matrix.js) + barStats(), so the
// backtester and the live engine evaluate exactly the same trigger.

export const OIM_DEFAULTS = {
  lookbacksH: [0.25, 1, 4, 12], // windows checked for the move and the OI build-up (15 min … 12 h)
  zMin: 2.5,              // move size, in σ of the window (σ from 7 days of bars)
  oiMin: 0.03,            // OI growth over the same window (+3%)
  holdH: 8,               // hold time
  riskPerTrade: 0.0025,   // equity lost on a 1σ adverse move over the hold
  maxGross: 1,            // total notional ≤ 1× equity
  topN: 20,               // most-traded coins only
  minAdv: 50e6,           // $ volume per day (30-day average)
  hoursUTC: null,         // e.g. [12, 20] to trade only 12:00–20:59 UTC triggers (optional)
  sides: [1],             // longs only: OI-backed down-moves did not hold up out of sample
};

/** Per-bar log returns, trailing 7-day per-bar vol (sig) and 30-day $ volume/day (adv). m.bph = bars per hour. */
export function barStats(m) {
  const bph = m.bph || 1, nb = m.t.length;
  m.r ||= {}; m.sig ||= {}; m.adv ||= {};
  for (const a of m.ids) {
    const c = m.c[a];
    const r = new Float64Array(nb).fill(NaN);
    for (let k = 1; k < nb; k++) if (c[k] > 0 && c[k - 1] > 0) r[k] = Math.log(c[k] / c[k - 1]);
    const sig = new Float64Array(nb).fill(NaN), W = 168 * bph;
    let s = 0, ss = 0, n = 0;
    for (let k = 0; k < nb; k++) {
      if (Number.isFinite(r[k])) { s += r[k]; ss += r[k] * r[k]; n++; }
      if (k >= W && Number.isFinite(r[k - W])) { s -= r[k - W]; ss -= r[k - W] ** 2; n--; }
      if (n >= W * 0.8) sig[k] = Math.sqrt(Math.max(ss / n - (s / n) ** 2, 1e-12));
    }
    const adv = new Float64Array(nb).fill(NaN), A = 720 * bph;
    let q = 0;
    for (let k = 0; k < nb; k++) { q += m.qv[a][k]; if (k >= A) q -= m.qv[a][k - A]; if (k >= A) adv[k] = q / 30; }
    m.r[a] = r; m.sig[a] = sig; m.adv[a] = adv;
  }
  return m;
}

/**
 * Trigger for asset a at the close of bar k: +1 (long), −1 (short) or 0.
 * Needs m.c, m.sig, m.oi (OI at each bar's close), m.bph, m.t.
 * Returns {dir, L, z, dOi} when it fires (for logging), else 0.
 */
export function oimTrigger(m, a, k, p = OIM_DEFAULTS) {
  if (p.hoursUTC) {
    const h = new Date(m.t[k] + 3600_000 / (m.bph || 1)).getUTCHours(); // hour of the bar's close
    if (h < p.hoursUTC[0] || h > p.hoursUTC[1]) return 0;
  }
  const bph = m.bph || 1, sig = m.sig[a][k], c1 = m.c[a][k], o1 = m.oi[a]?.[k];
  if (!(sig > 0 && c1 > 0 && o1 > 0)) return 0;
  for (const LH of p.lookbacksH) {
    const L = Math.round(LH * bph);
    if (L < 1) continue; // window shorter than one bar (e.g. 15 min on hourly bars)
    const c0 = m.c[a][k - L], o0 = m.oi[a][k - L];
    if (!(c0 > 0 && o0 > 0)) continue;
    const z = Math.log(c1 / c0) / (sig * Math.sqrt(L));
    const dOi = o1 / o0 - 1;
    if (dOi >= p.oiMin && Math.abs(z) >= p.zMin) {
      const dir = Math.sign(z);
      if (p.sides.includes(dir)) return { dir, L: LH, z, dOi };
    }
  }
  return 0;
}

/** Position size (notional $) for a new trade. */
export function oimNotional(m, a, k, equity, p = OIM_DEFAULTS) {
  const holdBars = Math.round(p.holdH * (m.bph || 1));
  return (equity * p.riskPerTrade) / (m.sig[a][k] * Math.sqrt(holdBars));
}
