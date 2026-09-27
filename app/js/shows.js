// Shows and fireworks from the live feed: today's times, what kind of show it is, when to leave to
// get a spot, and which rides on your list usually get shorter lines while it's on.

import { parkDayKey } from './time.js';

const MIN = 60e3;

// Order matters: first match wins. Tips stay general and practical.
const KINDS = [
  { re: /fireworks|screams|wondrous|remember|believe/i, kind: 'fireworks', major: true, lead: 40, tip: 'Main Street and the castle hub fill first; the area in front of "it\'s a small world" is calmer.' },
  { re: /fantasmic/i, kind: 'nighttime', major: true, lead: 50, tip: 'Watch from the Rivers of America in New Orleans Square or Frontierland.' },
  { re: /world of color/i, kind: 'nighttime', major: true, lead: 45, tip: 'Viewing is around Paradise Bay.' },
  { re: /parade|cavalcade|magic happens/i, kind: 'parade', major: true, lead: 25, tip: 'Line the route on Main Street or near "it\'s a small world".' },
  { re: /tapestry|projection|skywalker|rising moons/i, kind: 'nighttime', major: false, lead: 15, tip: null },
];

export function classifyShow(name) {
  for (const k of KINDS) if (k.re.test(name ?? '')) return { kind: k.kind, major: k.major, lead: k.lead, tip: k.tip };
  return { kind: 'other', major: false, lead: 10, tip: null };
}

/** Keep what the app needs from SHOW entities (for the stored snapshot). */
export function trimShows(live) {
  return (live?.liveData ?? [])
    .filter((e) => e?.entityType === 'SHOW' && Array.isArray(e.showtimes) && e.showtimes.length)
    .map(({ id, name, parkId, status, showtimes }) => ({ id, name, parkId, status, showtimes }));
}

/**
 * Today's scheduled performances, one entry per show: { id, name, park, times[ms], kind, major, lead, tip }.
 * Only "Performance Time" entries on today's park day; ticketed-event and all-day entries are left out.
 */
export function showsToday(shows, parkOf, now) {
  const today = parkDayKey(now);
  const out = [];
  for (const s of shows ?? []) {
    if (s.status && s.status !== 'OPERATING') continue;
    if (/cardmember/i.test(s.name ?? '')) continue; // needs a Disney Visa card: not a show for everyone
    const times = (s.showtimes ?? [])
      .filter((t) => (t.type ?? 'Performance Time') === 'Performance Time')
      // An all-day "performance" (8 am to 9 pm) is a meet-and-greet area, not a show with a start.
      .filter((t) => !(Date.parse(t.endTime) - Date.parse(t.startTime) > 2 * 3600e3))
      .map((t) => Date.parse(t.startTime))
      .filter((t) => Number.isFinite(t) && parkDayKey(t) === today)
      .sort((a, b) => a - b);
    if (!times.length) continue;
    out.push({ id: s.id, name: s.name, park: parkOf(s.parkId), times, ...classifyShow(s.name) });
  }
  return out.sort((a, b) => Number(b.major) - Number(a.major) || a.times[0] - b.times[0]);
}

/** The next time a show starts (or started within the last 5 minutes), or null. */
export const nextTime = (s, now) => s.times.find((t) => t >= now - 5 * MIN) ?? null;

/**
 * Rides on the list whose standby usually drops while a show runs, from learned hourly waits:
 * at least 10 minutes and 20% below the hour before. Returns [{ id, before, during }].
 */
export function ridesThatEmpty(stats, ids, showHour) {
  const out = [];
  for (const id of ids) {
    const s = stats?.get(id);
    const before = s?.standby?.[showHour - 1];
    const during = s?.standby?.[showHour];
    if (!Number.isFinite(before) || !Number.isFinite(during)) continue;
    if (before - during >= 10 && during <= before * 0.8) out.push({ id, before, during });
  }
  return out.sort((a, b) => b.before - b.during - (a.before - a.during));
}
