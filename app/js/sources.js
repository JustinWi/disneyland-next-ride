// Where waits come from, in order:
//   1. ThemeParks.wiki live (CORS *), straight from the phone.
//   2. The GitHub Actions cache on branch `data` (raw.githubusercontent.com, CORS *):
//      a ThemeParks.wiki snapshot plus Queue-Times, refreshed every ~5 min by .github/workflows/cache.yml.
//   3. The last snapshot we stored on this phone.
// Raw payloads are stored (trimmed) and re-normalized at render time, so operating windows and
// "opens at" logic always use the current clock.

import { normalizeTpw, normalizeQt, withForecastsFrom, withParkHours, parkHoursFrom, PARK_IDS } from './normalize.js';
import { parkDayKey } from './time.js';

export const TPW_LIVE = 'https://api.themeparks.wiki/v1/entity/disneylandresort/live';
export const KBF_LIVE = `https://api.themeparks.wiki/v1/entity/${PARK_IDS.KBF}/live`;
export const CACHE_BASE = 'https://raw.githubusercontent.com/JustinWi/disneyland-next-ride/data/';
const TIMEOUT_MS = 8000;

async function getJson(url, ms = TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    // 'no-cache' revalidates with the ETag (a 304 when nothing changed), as the API docs ask.
    const res = await fetch(url, { signal: ac.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Keep only what the app reads, to keep localStorage small. */
export function trimTpw(live) {
  return {
    liveData: (live?.liveData ?? [])
      .filter((e) => e?.entityType === 'ATTRACTION' || (e?.entityType === 'SHOW' && Array.isArray(e.showtimes) && e.showtimes.length))
      .map((e) =>
        e.entityType === 'SHOW'
          ? { id: e.id, name: e.name, entityType: e.entityType, parkId: e.parkId, status: e.status, showtimes: e.showtimes }
          : { id: e.id, name: e.name, entityType: e.entityType, parkId: e.parkId, status: e.status, queue: e.queue, forecast: e.forecast, operatingHours: e.operatingHours, lastUpdated: e.lastUpdated },
      ),
  };
}

const validTpw = (j) => Array.isArray(j?.liveData) && j.liveData.some((e) => e.entityType === 'ATTRACTION');
const validQt = (j) => Array.isArray(j?.lands) && j.lands.length > 0;

/**
 * Try every source. Resolves to { tpw?: {at, data}, qt?: {at, data}, via, error? }.
 * `via` is 'live' | 'cache' | null (nothing new).
 */
export async function fetchFresh() {
  try {
    const live = await getJson(TPW_LIVE);
    if (!validTpw(live)) throw new Error('unexpected payload');
    return { tpw: { at: Date.now(), data: trimTpw(live) }, via: 'live' };
  } catch (primaryErr) {
    try {
      const meta = await getJson(CACHE_BASE + 'meta.json', 6000);
      const at = Date.parse(meta?.fetchedAt);
      if (!Number.isFinite(at)) throw new Error('bad meta');
      const out = { via: 'cache', error: String(primaryErr?.message ?? primaryErr) };
      if (meta.ok?.live) {
        const live = await getJson(CACHE_BASE + 'live.json', 8000).catch(() => null);
        if (validTpw(live)) out.tpw = { at, data: trimTpw(live) };
      }
      if (!out.tpw && (meta.ok?.qt16 || meta.ok?.qt17)) {
        const [a, b] = await Promise.all([
          getJson(CACHE_BASE + 'qt16.json', 6000).catch(() => null),
          getJson(CACHE_BASE + 'qt17.json', 6000).catch(() => null),
        ]);
        const payloads = [a, b].filter(validQt);
        if (payloads.length) out.qt = { at, data: payloads };
      }
      if (!out.tpw && !out.qt) throw new Error('cache empty');
      return out;
    } catch {
      return { via: null, error: String(primaryErr?.message ?? primaryErr) };
    }
  }
}

/**
 * Official park hours for the next few days, from each park's schedule. Resolves to
 * { at, days } or null when neither schedule loads (the app then guesses from ride hours).
 */
export async function fetchHours(now = Date.now()) {
  const entries = await Promise.all(
    Object.entries(PARK_IDS).map(async ([k, id]) => [k, await getJson(`https://api.themeparks.wiki/v1/entity/${id}/schedule`).catch(() => null)]),
  );
  const ok = Object.fromEntries(entries.filter(([, j]) => Array.isArray(j?.schedule)));
  if (!Object.keys(ok).length) return null;
  const days = parkHoursFrom(ok, { from: parkDayKey(now) });
  return Object.keys(days).length ? { at: now, days } : null;
}

/** Knott's Berry Farm live waits, kept apart from Disney's so each has its own age. Null on failure. */
export async function fetchKnotts() {
  try {
    const live = await getJson(KBF_LIVE);
    return validTpw(live) ? { at: Date.now(), data: trimTpw(live) } : null;
  } catch {
    return null;
  }
}

/**
 * Build the snapshot to plan from: the newest of the stored ThemeParks.wiki and Queue-Times data.
 * Queue-Times has no forecasts, hours or Lightning Lane, so those are carried over from the
 * last ThemeParks.wiki snapshot when QT is newer.
 */
export function buildSnapshot({ tpw, qt, hours, kbf }, catalog, now = Date.now()) {
  const disney = tpw || qt ? rideSnapshot({ tpw, qt }, catalog, now) : null;
  const k = kbf ? normalizeTpw(kbf.data, catalog, { now }) : null;
  let snap = disney;
  if (k) {
    const kRides = k.rides.filter((r) => r.park === 'KBF');
    snap = disney
      ? { ...disney, rides: [...disney.rides.filter((r) => r.park !== 'KBF'), ...kRides], parks: { ...disney.parks, KBF: k.parks.KBF } }
      : { ...k, rides: kRides, at: kbf.at };
    snap.atKBF = kbf.at; // Knott's waits have their own age
  }
  return withParkHours(snap, hours, parkDayKey(now));
}

function rideSnapshot({ tpw, qt }, catalog, now) {
  const tpwSnap = tpw ? { ...normalizeTpw(tpw.data, catalog, { now }), at: tpw.at } : null;
  if (qt && (!tpw || qt.at > tpw.at + 60e3)) {
    const qtSnap = { ...normalizeQt(qt.data, catalog, { now }), at: qt.at };
    return withForecastsFrom(qtSnap, tpwSnap);
  }
  return tpwSnap;
}
