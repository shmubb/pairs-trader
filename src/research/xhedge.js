// Same-coin, two-venue (or two-contract) hedge: long the contract with lower
// funding, short the one with higher funding. Price exposure cancels; what's
// left is the funding gap (income), the basis between the two prices (noise),
// and trading costs. Volume comes from (a) flipping when the funding gap
// changes sign and (b) optional periodic rotation (close + reopen) to farm.
//
// Inputs are aligned hourly arrays for one coin on two contracts X and Y:
//   px, py: close prices; fx, fy: funding settled in that hour (fraction, longs pay +)

export function runXHedge(h, { lookbackH = 24, minGapBps8h = 0, rotateH = Infinity, notional = 10_000, startT = 0, endT = Infinity, costBps = { x: 0, y: 0 } } = {}) {
  const n = h.t.length;
  let side = 0; // +1: long X / short Y ; -1: short X / long Y
  let qx = 0, qy = 0, lastRotate = 0;
  let pricePnl = 0, funding = 0, volume = 0, cost = 0, flips = 0, rotations = 0, peak = 0, maxDD = 0, heldH = 0;
  const gapQ = [];
  let gapSum = 0, days = 0, lastDay = null;
  const trade = (target, i) => {
    const nx = target ? (target * notional) / 2 / h.px[i] : 0, ny = target ? (-target * notional) / 2 / h.py[i] : 0;
    const vx = Math.abs(nx - qx) * h.px[i], vy = Math.abs(ny - qy) * h.py[i];
    volume += vx + vy;
    cost += (vx * costBps.x + vy * costBps.y) / 1e4;
    qx = nx; qy = ny;
  };
  for (let i = 1; i < n; i++) {
    if (!(h.px[i] > 0 && h.py[i] > 0 && h.px[i - 1] > 0 && h.py[i - 1] > 0)) continue;
    pricePnl += qx * (h.px[i] - h.px[i - 1]) + qy * (h.py[i] - h.py[i - 1]);
    funding += -(qx * h.px[i] * h.fx[i] + qy * h.py[i] * h.fy[i]);
    if (qx) heldH++;
    // Trailing funding gap (Y − X): positive → shorting Y and longing X earns it.
    const g = h.fy[i] - h.fx[i];
    gapQ.push(g); gapSum += g;
    if (gapQ.length > lookbackH) gapSum -= gapQ.shift();
    const t = h.t[i];
    if (t < startT) continue;
    if (t >= endT) break;
    const day = Math.floor(t / 86_400_000);
    if (day !== lastDay) { days++; lastDay = day; }
    const pnl = pricePnl + funding - cost;
    peak = Math.max(peak, pnl); maxDD = Math.max(maxDD, peak - pnl);
    if (gapQ.length < lookbackH) continue;
    const gap8h = (gapSum / lookbackH) * 8 * 1e4; // bps per 8h
    let want = side;
    if (side === 0 && Math.abs(gap8h) >= minGapBps8h) want = gap8h > 0 ? 1 : -1;
    else if (side !== 0 && Math.sign(gap8h) === -side && Math.abs(gap8h) >= minGapBps8h) want = -side;
    if (want !== side) { trade(want, i); if (side !== 0) flips++; side = want; lastRotate = i; }
    else if (side !== 0 && i - lastRotate >= rotateH) { trade(0, i); trade(side, i); rotations++; lastRotate = i; }
  }
  const net = pricePnl + funding - cost;
  return {
    net, pricePnl, funding, cost, volume, flips, rotations, maxDD, days,
    volumePerDay: volume / (days || 1),
    netPerMillion: volume ? (net / volume) * 1e6 : 0,
    fundingPerMillion: volume ? (funding / volume) * 1e6 : 0,
    apr: (net / notional) * (365 / (days || 1)),
    fundingApr: (funding / notional) * (365 / (days || 1)),
    exposure: heldH / Math.max(1, days * 24),
  };
}
