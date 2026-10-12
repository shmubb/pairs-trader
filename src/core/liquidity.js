// Liquidation / stop heat — a MODEL, not observed positions.
//
// No exchange publishes where other traders' liquidations and stops sit.
// Commercial heatmaps estimate it the same way this does: assume each candle's
// volume opened leveraged positions near that candle's price (half long, half
// short), spread across common leverage levels, and place their liquidation
// prices at entry × (1 ∓ 1/leverage · maintenance factor). A level is removed
// once price trades through it (those positions are gone), and older
// contributions decay. Clusters that survive are where a move would trigger
// forced selling/buying — the cascades that create the overshoots a pairs
// trade feeds on, and the places you don't want your own leg's stop.
//
// Stop clusters are estimated the same way at round-number and recent swing
// levels (where discretionary stops collect).

export const LIQ_DEFAULTS = {
  leverages: [5, 10, 25, 50, 100],
  weights: [0.25, 0.3, 0.25, 0.12, 0.08],
  maintenance: 0.9,      // liquidation happens a bit before 100% of margin is gone
  halfLifeBars: 72,      // older positions are likely closed already
  bins: 80,
  rangePct: 0.12,        // ±12% around the current price
};

export function liquidationMap(candles, opts = {}) {
  const o = { ...LIQ_DEFAULTS, ...opts };
  if (!candles.length) return null;
  const last = candles[candles.length - 1].c;
  const lo = last * (1 - o.rangePct), hi = last * (1 + o.rangePct);
  const width = (hi - lo) / o.bins;
  const longLiq = new Float64Array(o.bins);   // below price: longs get liquidated on the way down
  const shortLiq = new Float64Array(o.bins);  // above price: shorts get liquidated on the way up
  const decay = Math.pow(0.5, 1 / o.halfLifeBars);
  // Track each level with the running min/max since it was created so levels
  // that price has already swept are dropped.
  const levels = [];
  for (let i = 0; i < candles.length; i++) {
    const k = candles[i];
    const notional = (k.qv ?? k.v * k.c) / 2;
    for (const lv of levels) {
      lv.w *= decay;
      if (!lv.dead && ((lv.side === "long" && k.l <= lv.px) || (lv.side === "short" && k.h >= lv.px))) lv.dead = true;
    }
    for (let j = 0; j < o.leverages.length; j++) {
      const d = o.maintenance / o.leverages[j];
      levels.push({ side: "long", px: k.c * (1 - d), w: notional * o.weights[j] });
      levels.push({ side: "short", px: k.c * (1 + d), w: notional * o.weights[j] });
    }
    // Keep memory bounded: drop dead and negligible levels.
    if (levels.length > 6000) {
      const keep = levels.filter((lv) => !lv.dead && lv.w > 1e-6);
      levels.length = 0;
      levels.push(...keep);
    }
  }
  for (const lv of levels) {
    if (lv.dead || lv.px < lo || lv.px >= hi) continue;
    const b = Math.floor((lv.px - lo) / width);
    if (lv.side === "long") longLiq[b] += lv.w; else shortLiq[b] += lv.w;
  }
  const max = Math.max(...longLiq, ...shortLiq) || 1;
  const bins = [];
  for (let b = 0; b < o.bins; b++) bins.push({ lo: lo + b * width, hi: lo + (b + 1) * width, longLiq: longLiq[b], shortLiq: shortLiq[b], heat: (longLiq[b] + shortLiq[b]) / max });
  // Nearest big clusters on each side.
  const above = bins.filter((x) => x.lo > last).sort((a, b) => b.shortLiq - a.shortLiq)[0];
  const below = bins.filter((x) => x.hi < last).sort((a, b) => b.longLiq - a.longLiq)[0];
  return { price: last, bins, max, clusterAbove: above && { px: (above.lo + above.hi) / 2, usd: above.shortLiq }, clusterBelow: below && { px: (below.lo + below.hi) / 2, usd: below.longLiq } };
}

/** Round-number and swing-point levels where stops typically cluster. */
export function stopLevels(candles, { lookback = 168 } = {}) {
  if (!candles.length) return [];
  const last = candles[candles.length - 1].c;
  const mag = Math.pow(10, Math.floor(Math.log10(last)) - 1);
  const out = [];
  for (const step of [mag * 10, mag * 5, mag]) {
    const below = Math.floor(last / step) * step, above = Math.ceil(last / step) * step;
    out.push({ px: below, kind: "round", side: "below" }, { px: above, kind: "round", side: "above" });
  }
  const recent = candles.slice(-lookback);
  out.push({ px: Math.min(...recent.map((k) => k.l)), kind: `swing low (${lookback} bars)`, side: "below" });
  out.push({ px: Math.max(...recent.map((k) => k.h)), kind: `swing high (${lookback} bars)`, side: "above" });
  const seen = new Set();
  return out.filter((l) => l.px > 0 && !seen.has(l.px.toPrecision(6)) && seen.add(l.px.toPrecision(6))).sort((a, b) => a.px - b.px);
}

/** Summarise an l2Book response into depth within ±pct of mid. */
export function bookDepth(book, pct = 0.01) {
  if (!book || !book.levels) return null;
  const [bids, asks] = book.levels;
  const mid = (+bids[0].px + +asks[0].px) / 2;
  const sum = (side, ok) => side.filter((l) => ok(+l.px)).reduce((s, l) => s + +l.px * +l.sz, 0);
  return {
    mid,
    spreadBps: ((+asks[0].px - +bids[0].px) / mid) * 1e4,
    bidUsd: sum(bids, (p) => p >= mid * (1 - pct)),
    askUsd: sum(asks, (p) => p <= mid * (1 + pct)),
    levels: { bids: bids.map((l) => [+l.px, +l.sz]), asks: asks.map((l) => [+l.px, +l.sz]) },
  };
}
