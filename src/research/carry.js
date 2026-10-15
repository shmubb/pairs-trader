// Market-neutral funding carry: long the perps whose funding is lowest
// (longs get paid when funding is negative), short the ones whose funding is
// highest (shorts get paid when it's positive), dollar-neutral, rebalanced on
// a schedule. Earns funding while generating volume on every rebalance — the
// opposite of a strategy that pays to farm.
//
// Uses hourly bars + Binance 8-hourly funding (a proxy for Hyperliquid's hourly
// funding, which is usually similar in sign and size for the same coin).

/**
 * series: { [asset]: { t: Int array (aligned hourly), c: closes, fund: funding settled at that hour (0 if none) } }
 * opts: {
 *   rebalanceH: hours between rebalances, lookbackH: trailing funding window for ranking,
 *   k: names per side, gross: total gross notional ($), minSpreadBps: only hold when
 *   (avg short funding − avg long funding) per 8h ≥ this, startT, endT, hysteresis: keep a
 *   name until it falls out of the top/bottom k + h ranks (cuts churn),
 * }
 */
export function runCarry(times, series, assets, opts) {
  const { rebalanceH = 24, lookbackH = 72, k = 3, gross = 10_000, minSpreadBps = 0, startT = 0, endT = Infinity, hysteresis = 0, betaNeutral = false } = opts;
  const n = times.length;
  const pos = Object.fromEntries(assets.map((a) => [a, 0])); // units
  let pnl = 0, funding = 0, volume = 0, peak = 0, maxDD = 0, rebalances = 0, heldBars = 0;
  const daily = [];
  let lastDay = null, dayStartPnl = 0;
  const fundSum = Object.fromEntries(assets.map((a) => [a, 0]));
  const fundQ = Object.fromEntries(assets.map((a) => [a, []]));
  let longSet = new Set(), shortSet = new Set();

  for (let i = 1; i < n; i++) {
    const t = times[i];
    // Price PnL over the bar and funding settled in it.
    let any = false;
    for (const a of assets) {
      const s = series[a];
      const c0 = s.c[i - 1], c1 = s.c[i];
      if (!(c0 > 0 && c1 > 0)) continue;
      if (pos[a]) { pnl += pos[a] * (c1 - c0); const f = -pos[a] * c1 * s.fund[i]; funding += f; pnl += f; any = true; }
      // Trailing funding (sum over lookback hours) for ranking.
      fundQ[a].push(s.fund[i]); fundSum[a] += s.fund[i];
      if (fundQ[a].length > lookbackH) fundSum[a] -= fundQ[a].shift();
    }
    if (any) heldBars++;
    if (t < startT || t >= endT) { if (t >= endT) break; continue; }
    peak = Math.max(peak, pnl); maxDD = Math.max(maxDD, peak - pnl);
    const day = Math.floor(t / 86_400_000);
    if (day !== lastDay) { if (lastDay !== null) daily.push(pnl - dayStartPnl); dayStartPnl = pnl; lastDay = day; }

    if (i % rebalanceH !== 0) continue;
    // Rank by trailing funding per 8h equivalent.
    const live = assets.filter((a) => series[a].c[i] > 0 && fundQ[a].length >= Math.min(lookbackH, 24));
    if (live.length < 2 * k + 1) continue;
    const per8h = (a) => (fundSum[a] / fundQ[a].length) * 8;
    const ranked = live.slice().sort((p, q) => per8h(p) - per8h(q));
    const keepL = new Set(ranked.slice(0, k + hysteresis)), keepS = new Set(ranked.slice(-(k + hysteresis)));
    const nextL = new Set([...longSet].filter((a) => keepL.has(a)));
    const nextS = new Set([...shortSet].filter((a) => keepS.has(a)));
    for (const a of ranked) { if (nextL.size >= k) break; if (!nextS.has(a)) nextL.add(a); }
    for (const a of ranked.slice().reverse()) { if (nextS.size >= k) break; if (!nextL.has(a)) nextS.add(a); }
    const spread8h = ([...nextS].reduce((s, a) => s + per8h(a), 0) / nextS.size - [...nextL].reduce((s, a) => s + per8h(a), 0) / nextL.size) * 1e4;
    const target = Object.fromEntries(assets.map((a) => [a, 0]));
    if (spread8h >= minSpreadBps) {
      for (const a of nextL) target[a] = gross / 2 / nextL.size / series[a].c[i];
      for (const a of nextS) target[a] = -gross / 2 / nextS.size / series[a].c[i];
      longSet = nextL; shortSet = nextS;
    } else { longSet = new Set(); shortSet = new Set(); }
    for (const a of assets) {
      const d = target[a] - pos[a];
      if (Math.abs(d * series[a].c[i]) < 1) continue;
      volume += Math.abs(d) * series[a].c[i];
      pos[a] = target[a];
    }
    rebalances++;
  }
  const m = daily.reduce((s, x) => s + x, 0) / (daily.length || 1);
  const sd = Math.sqrt(daily.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, daily.length - 1));
  return {
    gross: pnl, funding, pricePnl: pnl - funding, volume, maxDD, days: daily.length, rebalances,
    grossBps: volume ? (pnl / volume) * 1e4 : 0, fundingBps: volume ? (funding / volume) * 1e4 : 0,
    volumePerDay: volume / (daily.length || 1), dailySharpe: sd > 0 ? (m / sd) * Math.sqrt(365) : 0,
    annualReturnOnGross: (pnl / gross) * (365 / (daily.length || 1)),
  };
}
