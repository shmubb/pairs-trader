// Volume-farming research: high-turnover, market-neutral pair trading.
//
// Points programs reward traded volume. The question is not "how much does a
// trade make" but "how much does $1M of volume cost". Fees and spread are
// linear in volume, so we measure the strategy's GROSS edge per dollar traded
// (bps, at mid prices, fills at the next bar's open — no look-ahead) and then
// price it under each venue's fee schedule:
//
//   net bps = gross bps − fee bps − half-spread bps (+ funding bps)
//
// A configuration with gross edge ≥ venue cost farms volume for free (or better).
//
// computeZ() runs the same PairModel the live system uses; simulate() replays
// entry/exit rules on the resulting arrays quickly, so a grid of rules costs
// one model pass per (pair, interval, formation window).

import { PairModel } from "../core/model.js";

/** One model pass → per-bar arrays (z, cointP, halfLife, beta, gates) aligned with bars. */
export function computeZ(bars, modelCfg) {
  const m = new PairModel(modelCfg);
  const n = bars.length;
  const z = new Float64Array(n).fill(NaN), coint = new Float64Array(n).fill(NaN), hl = new Float64Array(n).fill(NaN);
  const beta = new Float64Array(n).fill(NaN), vol = new Float64Array(n).fill(NaN), corr = new Float64Array(n).fill(NaN), sigma = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const s = m.update(bars[i]);
    if (!s.ready) continue;
    z[i] = s.z; coint[i] = s.cointP; hl[i] = s.halfLife; beta[i] = s.beta; vol[i] = s.volRatio; corr[i] = s.corrShort; sigma[i] = s.sigmaEq;
  }
  return { z, coint, hl, beta, vol, corr, sigma };
}

/**
 * Replay rules on precomputed z. Position sizing is a fixed gross notional
 * (both legs together = `gross` dollars; leg A = gross/(1+β), leg B = β·that).
 *
 * rules: {
 *   zIn: entry |z|, zOut: exit level toward/through the mean (0 = mean,
 *   negative = overshoot), flip: on reaching the opposite entry level, reverse
 *   instead of going flat, zStop: stop |z| (Infinity = none), maxHold: bars,
 *   gateCointP: only enter when cointegration p ≤ this (1 = no gate),
 *   maxVolRatio: skip entries when spread vol is blowing out,
 * }
 * Returns gross PnL (mid prices), volume, funding, and per-bar cumulative gross PnL for drawdown.
 */
export function simulate(bars, zs, rules, { startT = 0, gross = 10_000, delay = 1, daily: opts_daily = null } = {}) {
  const { zIn, zOut = 0, flip = false, zStop = Infinity, maxHold = Infinity, gateCointP = 1, maxVolRatio = Infinity, minCorr = -1, minMoveBps = 0 } = rules;
  const n = bars.length;
  let pos = 0, qA = 0, qB = 0, entryBar = 0, pending = null;
  const queue = []; // [execIndex, target] — decisions made on bar i execute at the open of bar i + delay
  let pnl = 0, volume = 0, funding = 0, trades = 0, wins = 0, stops = 0, entryPnl = 0, barsIn = 0;
  let peak = 0, maxDD = 0, started = false, startIdx = 0;
  const daily = new Map();

  const trade = (target, i) => {
    // Move from current legs to `target` direction at bar i's open.
    const b = bars[i];
    const beta = Math.abs(zs.beta[i - 1]) || 1;
    const nA = gross / (1 + beta);
    const tA = (target * nA) / b.oa, tB = (-target * nA * beta) / b.ob;
    volume += Math.abs(tA - qA) * b.oa + Math.abs(tB - qB) * b.ob;
    qA = tA; qB = tB;
  };

  for (let i = 1; i < n; i++) {
    const b = bars[i], p = bars[i - 1];
    // Mark-to-market from previous close to this open, then execute, then open→close.
    if (qA || qB) pnl += qA * (b.oa - p.pa) + qB * (b.ob - p.pb);
    while (queue.length && queue[0][0] <= i) { pending = queue.shift()[1]; }
    if (pending !== null && b.t >= startT) {
      if (pending !== pos) {
        if (pos !== 0) { trades++; if (pnl - entryPnl > 0) wins++; }
        trade(pending, i);
        if (pending !== 0) { entryBar = i; entryPnl = pnl; }
        pos = pending;
      }
    }
    pending = null;
    if (qA || qB) {
      pnl += qA * (b.pa - b.oa) + qB * (b.pb - b.ob);
      funding += -(qA * b.pa * (b.fa || 0) + qB * b.pb * (b.fb || 0));
      barsIn++;
    }
    if (b.t < startT) continue;
    if (!started) { started = true; startIdx = i; peak = pnl; }
    peak = Math.max(peak, pnl);
    maxDD = Math.max(maxDD, peak - pnl);
    const day = Math.floor(b.t / 86_400_000);
    daily.set(day, pnl);
    if (opts_daily) opts_daily.set(day, { g: pnl + funding, v: volume });

    const z = zs.z[i];
    if (!Number.isFinite(z) || queue.length) continue; // one decision in flight at a time
    // Expected reversion move (entry → exit level) in bps of the spread must clear minMoveBps.
    const okGate = zs.coint[i] <= gateCointP && !(zs.vol[i] > maxVolRatio) && !(zs.corr[i] < minCorr) && (!minMoveBps || (Math.abs(z) - zOut) * zs.sigma[i] * 1e4 >= minMoveBps);
    if (pos === 0) {
      if (okGate && Math.abs(z) >= zIn) pending = z < 0 ? 1 : -1;
    } else {
      const toward = -pos * z; // >0 still on entry side
      if (toward >= zStop) { pending = 0; stops++; }
      else if (flip && toward <= -zIn) pending = okGate ? -pos : 0;
      else if (!flip && toward <= zOut) pending = 0;
      else if (i - entryBar >= maxHold) pending = 0;
    }
    if (pending !== null) { queue.push([i + delay, pending]); pending = null; }
  }
  // Daily PnL series for Sharpe-like stability measures.
  const days = [...daily.values()];
  const dpnl = days.map((v, k) => (k ? v - days[k - 1] : 0)).slice(1);
  const mean = dpnl.reduce((a, c) => a + c, 0) / (dpnl.length || 1);
  const sd = Math.sqrt(dpnl.reduce((a, c) => a + (c - mean) ** 2, 0) / Math.max(1, dpnl.length - 1));
  const nDays = dpnl.length || 1;
  return {
    gross: pnl, volume, funding, trades, wins, stops, maxDD, days: nDays,
    grossBps: volume ? (pnl / volume) * 1e4 : 0,
    fundingBps: volume ? (funding / volume) * 1e4 : 0,
    volumePerDay: volume / nDays,
    dailySharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    exposure: barsIn / Math.max(1, n - startIdx),
  };
}

/** Venue cost per $ traded (bps), given maker/taker usage and the half-spread you pay on taker fills. */
export function venueCostBps(venue, { style = "taker", halfSpreadBps = 1 } = {}) {
  if (style === "maker") return venue.maker;
  if (style === "hybrid") return (venue.maker + venue.taker + halfSpreadBps) / 2;
  return venue.taker + halfSpreadBps;
}

/**
 * Same rules, executed with POST-ONLY limit orders (the way you'd farm on a
 * zero-maker-fee venue). A decision on bar i's close posts each leg at that
 * close price. On bar i+1 a leg fills only if price trades THROUGH the limit
 * (low < buy limit, high > sell limit) — conservative about queue position,
 * and it bakes in adverse selection (you get filled when price moves against
 * your order). If one leg fills and the other doesn't, the other is hedged as
 * a taker at bar i+1's close. If neither fills, the orders are cancelled and
 * the signal is re-evaluated. Stops are always taker.
 *
 * Returns maker/taker volume separately so each venue's fees can be applied:
 *   net = gross − makerVol·makerFee − takerVol·(takerFee + halfSpread)
 * where `gross` is PnL at the actual fill prices (limit price for maker fills,
 * bar close for taker fills).
 */
export function simulateMaker(bars, zs, rules, { startT = 0, gross = 10_000, entryStyle = "maker", exitStyle = "maker" } = {}) {
  const { zIn, zOut = 0, zStop = Infinity, maxHold = Infinity, gateCointP = 1, maxVolRatio = Infinity } = rules;
  const n = bars.length;
  let pos = 0, qA = 0, qB = 0, entryBar = 0;
  let pnl = 0, makerVol = 0, takerVol = 0, funding = 0, trades = 0, fills = 0, posts = 0, legHedges = 0;
  let peak = 0, maxDD = 0, started = false, startIdx = 0;
  let order = null; // {target, pxA, pxB, needA, needB, taker}
  const daily = new Map();

  for (let i = 1; i < n; i++) {
    const b = bars[i], p = bars[i - 1];
    if (qA || qB) pnl += qA * (b.pa - p.pa) + qB * (b.pb - p.pb), funding += -(qA * b.pa * (b.fa || 0) + qB * b.pb * (b.fb || 0));
    if (order && b.t >= startT) {
      // Work the order on this bar.
      const { dA, dB } = order;
      let fillA = false, fillB = false;
      if (order.taker) { fillA = fillB = true; }
      else {
        fillA = dA === 0 || (dA > 0 ? b.la < order.pxA : b.ha > order.pxA);
        fillB = dB === 0 || (dB > 0 ? b.lb < order.pxB : b.hb > order.pxB);
      }
      if (fillA || fillB) {
        // Maker fills at the limit price; the leg that didn't fill (or a taker order) executes at the close.
        // Taker orders fill at this bar's open; a maker leg that didn't fill is hedged at the close.
        const pxA = order.taker ? b.oa : !fillA ? b.pa : order.pxA, pxB = order.taker ? b.ob : !fillB ? b.pb : order.pxB;
        const takerA = order.taker || !fillA, takerB = order.taker || !fillB;
        if (!order.taker && (!fillA || !fillB)) legHedges++;
        // PnL vs close: buying below the close is a gain, etc.
        pnl += dA * (b.pa - pxA) + dB * (b.pb - pxB);
        if (dA) { if (takerA) takerVol += Math.abs(dA) * pxA; else makerVol += Math.abs(dA) * pxA; }
        if (dB) { if (takerB) takerVol += Math.abs(dB) * pxB; else makerVol += Math.abs(dB) * pxB; }
        qA += dA; qB += dB;
        if (pos !== 0 && order.target !== pos) trades++;
        pos = order.target;
        if (pos !== 0) entryBar = i;
        fills++;
      }
      order = null;
    }
    if (b.t < startT) continue;
    if (!started) { started = true; startIdx = i; peak = pnl; }
    peak = Math.max(peak, pnl); maxDD = Math.max(maxDD, peak - pnl);
    daily.set(Math.floor(b.t / 86_400_000), pnl);

    const z = zs.z[i];
    if (!Number.isFinite(z)) continue;
    let target = null, taker = false;
    if (pos === 0) {
      if (zs.coint[i] <= gateCointP && !(zs.vol[i] > maxVolRatio) && Math.abs(z) >= zIn) target = z < 0 ? 1 : -1;
    } else {
      const toward = -pos * z;
      if (toward >= zStop) { target = 0; taker = true; }
      else if (toward <= zOut) target = 0;
      else if (i - entryBar >= maxHold) { target = 0; taker = true; }
    }
    if (target !== null && target !== pos) {
      if (!taker) taker = target === 0 ? exitStyle === "taker" : entryStyle === "taker";
      const beta = Math.abs(zs.beta[i]) || 1;
      const nA = gross / (1 + beta);
      const tA = target === 0 ? 0 : (target * nA) / b.pa, tB = target === 0 ? 0 : (-target * nA * beta) / b.pb;
      order = { target, dA: tA - qA, dB: tB - qB, pxA: b.pa, pxB: b.pb, taker };
      posts++;
    }
  }
  const days = [...daily.values()];
  const dp = days.map((v, k) => (k ? v - days[k - 1] : 0)).slice(1);
  const mean = dp.reduce((a, c) => a + c, 0) / (dp.length || 1);
  const sd = Math.sqrt(dp.reduce((a, c) => a + (c - mean) ** 2, 0) / Math.max(1, dp.length - 1));
  const volume = makerVol + takerVol;
  return {
    gross: pnl, funding, makerVol, takerVol, volume, trades, fills, posts, legHedges, maxDD, days: dp.length || 1,
    grossBps: volume ? (pnl / volume) * 1e4 : 0, makerShare: volume ? makerVol / volume : 0,
    volumePerDay: volume / (dp.length || 1), dailySharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    /** Net $ per $1M traded on a venue: maker/taker fees in bps, halfSpread paid on taker fills. */
    netPerMillion(venue, halfSpreadBps) {
      const cost = makerVol * venue.maker / 1e4 + takerVol * (venue.taker + halfSpreadBps) / 1e4;
      return volume ? ((pnl + funding - cost) / volume) * 1e6 : 0;
    },
  };
}
