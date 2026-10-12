// Trading sessions and scheduled macro events.
//
// Crypto trades 24/7 but liquidity and volatility don't: the US cash session
// and the London/NY overlap carry most of the volume, and US data releases
// (CPI, NFP, FOMC) move every asset at once — the kind of move that breaks a
// pair's relationship for a few hours. The research script measures how
// spread reversion actually behaves by hour of day so these filters are set
// from data rather than lore.

export const SESSIONS = [
  { name: "Asia", utcOpen: 0, utcClose: 8 },
  { name: "London", utcOpen: 7, utcClose: 16 },
  { name: "New York", utcOpen: 13, utcClose: 21 },
];

export function sessionsAt(t) {
  const h = new Date(t).getUTCHours();
  return SESSIONS.filter((s) => h >= s.utcOpen && h < s.utcClose).map((s) => s.name);
}

/** US Eastern offset from UTC in hours for a date (DST: 2nd Sunday Mar → 1st Sunday Nov). */
export function easternOffset(t) {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(y, month, 1));
    return 1 + ((7 - first.getUTCDay()) % 7) + 7 * (n - 1);
  };
  const dstStart = Date.UTC(y, 2, nthSunday(2, 2), 7); // 2am ET = 7 UTC
  const dstEnd = Date.UTC(y, 10, nthSunday(10, 1), 6);  // 2am EDT = 6 UTC
  return t >= dstStart && t < dstEnd ? -4 : -5;
}

/** UTC timestamp for a wall-clock time in New York on a given date string (YYYY-MM-DD). */
export function nyTime(dateStr, hour, minute = 0) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour + 5, minute);
  return guess + (easternOffset(guess) === -4 ? -3600_000 : 0);
}

// 2026 US macro calendar (official BLS / BEA / Federal Reserve schedules,
// carried over from the previous app). Add next year's dates once published.
const RELEASE_830 = ["CPI", "NFP", "PPI", "GDP", "RETAIL"];
const EVENTS_2026 = [
  ["2026-01-28", "FOMC"], ["2026-03-18", "FOMC"], ["2026-05-06", "FOMC"], ["2026-06-17", "FOMC"],
  ["2026-07-29", "FOMC"], ["2026-09-16", "FOMC"], ["2026-11-04", "FOMC"], ["2026-12-16", "FOMC"],
  ["2026-01-13", "CPI"], ["2026-02-11", "CPI"], ["2026-03-11", "CPI"], ["2026-04-10", "CPI"], ["2026-05-12", "CPI"],
  ["2026-06-10", "CPI"], ["2026-07-14", "CPI"], ["2026-08-12", "CPI"], ["2026-09-11", "CPI"], ["2026-10-14", "CPI"],
  ["2026-11-10", "CPI"], ["2026-12-10", "CPI"],
  ["2026-01-09", "NFP"], ["2026-02-06", "NFP"], ["2026-03-06", "NFP"], ["2026-04-03", "NFP"], ["2026-05-08", "NFP"],
  ["2026-06-05", "NFP"], ["2026-07-02", "NFP"], ["2026-08-07", "NFP"], ["2026-09-04", "NFP"], ["2026-10-02", "NFP"],
  ["2026-11-06", "NFP"], ["2026-12-04", "NFP"],
  ["2026-01-14", "PPI"], ["2026-02-12", "PPI"], ["2026-03-12", "PPI"], ["2026-04-14", "PPI"], ["2026-05-13", "PPI"],
  ["2026-06-11", "PPI"], ["2026-07-15", "PPI"], ["2026-08-13", "PPI"], ["2026-09-10", "PPI"], ["2026-10-15", "PPI"],
  ["2026-11-13", "PPI"], ["2026-12-15", "PPI"],
  ["2026-01-29", "GDP"], ["2026-04-30", "GDP"], ["2026-07-30", "GDP"], ["2026-10-29", "GDP"],
];

export const EVENTS = EVENTS_2026.map(([date, type]) => ({
  date, type,
  impact: type === "PPI" ? 2 : 3,
  t: type === "FOMC" ? nyTime(date, 14, 0) : RELEASE_830.includes(type) ? nyTime(date, 8, 30) : nyTime(date, 8, 30),
}));

/** Is `t` inside the blackout window around a high-impact event? */
export function eventBlackout(t, { before = 2, after = 1, minImpact = 3, events = EVENTS } = {}) {
  for (const e of events) {
    if (e.impact < minImpact) continue;
    if (t >= e.t - before * 3600_000 && t <= e.t + after * 3600_000) return e;
  }
  return null;
}

export function nextEvents(t, n = 5, events = EVENTS) {
  return events.filter((e) => e.t > t - 3600_000).sort((a, b) => a.t - b.t).slice(0, n);
}

/** Session gate used by the strategy ctx. */
export function sessionCheck(t, cfg = {}) {
  const h = new Date(t).getUTCHours();
  const dow = new Date(t).getUTCDay();
  if (cfg.allowedHoursUtc && !cfg.allowedHoursUtc.includes(h)) return { ok: false, reason: `hour ${h} UTC not in allowed entry hours` };
  if (cfg.avoidWeekendEntries && (dow === 0 || dow === 6)) return { ok: false, reason: "weekend: thin liquidity" };
  const ev = eventBlackout(t, { before: cfg.eventBlackoutHoursBefore ?? 2, after: cfg.eventBlackoutHoursAfter ?? 1 });
  if (ev) return { ok: false, reason: `${ev.type} release ${new Date(ev.t).toISOString().slice(11, 16)} UTC` };
  return { ok: true, sessions: sessionsAt(t) };
}
