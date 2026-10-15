// A multi-asset price matrix on one clock, plus causal helpers.
// Pure (no I/O): research builds it from the Binance cache, the live engine
// from Hyperliquid candles, so both feed identical inputs to the strategy.

const H = 3600_000;

/**
 * series: {asset: {k: [{t,o,h,l,c,qv}], funding: [{t, rate}]}} at any interval ≤ barH.
 * Returns m = {ids, barH, t, o, c, h, l, qv, fund} with Float64Arrays per asset,
 * resampled to `barH`-hour bars (NaN where an asset has no data). `fund[a][k]` is
 * the sum of funding rates settled during bar k. Only complete bars are kept
 * when `now` is given.
 */
export function buildMatrix(series, { barH = 24, from, to, offsetH = 0, now } = {}) {
  const ids = Object.keys(series).filter((a) => series[a]?.k?.length);
  const step = barH * H;
  let t0 = Math.min(...ids.map((a) => series[a].k[0].t));
  let t1 = Math.max(...ids.map((a) => { const k = series[a].k; return k[k.length - 1].t + (k.length > 1 ? k[1].t - k[0].t : H); }));
  if (from) t0 = Math.max(t0, typeof from === "number" ? from : Date.parse(from));
  if (to) t1 = Math.min(t1, typeof to === "number" ? to : Date.parse(to));
  if (now) t1 = Math.min(t1, now);
  t0 = Math.ceil((t0 - offsetH * H) / step) * step + offsetH * H; // offsetH shifts bar boundaries (daily bars closing at 08:00 UTC, ...)
  const nb = Math.max(0, Math.floor((t1 - t0) / step));
  const m = { ids, barH, t: new Float64Array(nb), o: {}, c: {}, h: {}, l: {}, qv: {}, fund: {} };
  for (let k = 0; k < nb; k++) m.t[k] = t0 + k * step;
  for (const a of ids) {
    const o = new Float64Array(nb).fill(NaN), c = new Float64Array(nb).fill(NaN), hi = new Float64Array(nb).fill(NaN), lo = new Float64Array(nb).fill(NaN), qv = new Float64Array(nb), f = new Float64Array(nb);
    for (const r of series[a].k) {
      if (r.t < t0) continue;
      const k = Math.floor((r.t - t0) / step);
      if (k >= nb) break;
      if (Number.isNaN(o[k])) o[k] = r.o;
      c[k] = r.c;
      hi[k] = Number.isNaN(hi[k]) ? r.h : Math.max(hi[k], r.h);
      lo[k] = Number.isNaN(lo[k]) ? r.l : Math.min(lo[k], r.l);
      qv[k] += r.qv;
    }
    for (const x of series[a].funding || []) {
      if (x.t < t0) continue;
      const k = Math.floor((x.t - t0) / step);
      if (k < nb) f[k] += x.rate;
    }
    for (let k = 0; k < nb; k++) if (!(o[k] > 0 && c[k] > 0)) { o[k] = NaN; c[k] = NaN; } // a bar needs open and close
    m.o[a] = o; m.c[a] = c; m.h[a] = hi; m.l[a] = lo; m.qv[a] = qv; m.fund[a] = f;
  }
  return m;
}

/** Trailing return over L bars ending at k (NaN if missing). */
export function ret(m, a, k, L) {
  const c1 = m.c[a][k], c0 = m.c[a][k - L];
  return c1 > 0 && c0 > 0 ? c1 / c0 - 1 : NaN;
}

/** Realised volatility of bar returns over the last n bars, annualised (NaN if < 80% of bars exist). */
export function realVol(m, a, k, n) {
  let s = 0, ss = 0, cnt = 0;
  for (let i = k - n + 1; i <= k; i++) {
    const c0 = m.c[a][i - 1], c1 = m.c[a][i];
    if (!(c0 > 0 && c1 > 0)) continue;
    const r = Math.log(c1 / c0); s += r; ss += r * r; cnt++;
  }
  if (cnt < n * 0.8) return NaN;
  const v = ss / cnt - (s / cnt) ** 2;
  return Math.sqrt(Math.max(v, 0) * (8760 / m.barH));
}

/** Trailing sum of funding over n bars (per-settlement rates summed). */
export function fundSum(m, a, k, n) {
  let s = 0;
  for (let i = Math.max(0, k - n + 1); i <= k; i++) s += m.fund[a][i];
  return s;
}
