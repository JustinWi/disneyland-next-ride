// Turn raw API payloads into one uniform snapshot shape:
// { at, source: 'tpw'|'qt', rides: Ride[], parks: { DL: {open, close}, DCA: {open, close} } }
// Ride: { id, name, park, lat, lng, type, status, wait, waitUpdated, forecast, open, close, windows, ll, source }

import { todayKey } from './time.js';

export const PARK_IDS = {
  DL: '7340550b-c14d-4def-80bb-acdb51d49a66',
  DCA: '832fcd51-ea19-4e77-85c7-75d5843b127c',
  KBF: '0a6123bb-1e8c-4b18-a2d3-2696cf2451f5', // Knott's Berry Farm: its own trip, a drive from Disneyland
};
export const PARK_KEYS = Object.keys(PARK_IDS);
const emptyParks = () => Object.fromEntries(PARK_KEYS.map((k) => [k, { open: null, close: null }]));
export const QT_PARK_IDS = { 16: 'DL', 17: 'DCA' };

const STATUSES = new Set(['OPERATING', 'DOWN', 'CLOSED', 'REFURBISHMENT']);
const parseT = (s) => (s ? Date.parse(s) : NaN);
const orNull = (n) => (Number.isFinite(n) ? n : null);

function parkKeyFor(parkId, catalog) {
  for (const [key, p] of Object.entries(catalog?.parks ?? {})) if (p?.id === parkId) return key;
  for (const [key, id] of Object.entries(PARK_IDS)) if (id === parkId) return key;
  return null;
}

function window(q) {
  if (!q || q.state !== 'AVAILABLE') return null;
  const start = parseT(q.returnStart);
  const end = parseT(q.returnEnd);
  if (!Number.isFinite(start)) return null;
  return { start, end: orNull(end) };
}

/**
 * Today's Operating windows for an attraction from its operatingHours, by park day.
 * Rides can pause (fireworks) and reopen, so there may be several. Windows from other days
 * (the feed keeps some stale ones, months old) are dropped.
 * Returns { open, close } of the window containing now (else the next to start, else the last),
 * plus every window today as `windows`, sorted.
 */
function hoursFor(list, now) {
  if (!Array.isArray(list)) return { open: null, close: null, windows: [] };
  const today = todayKey(now);
  const windows = [];
  for (const h of list) {
    if (!h || (h.type && h.type !== 'Operating')) continue;
    const open = parseT(h.startTime);
    const close = parseT(h.endTime);
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
    if (todayKey(open) !== today && !(open <= now && now <= close)) continue;
    windows.push({ open, close });
  }
  windows.sort((a, b) => a.open - b.open);
  let best = null;
  for (const { open, close } of windows) {
    // prefer the window that contains now, else the next one to start, else the last one
    const contains = open <= now && now <= close;
    if (!best || (contains && !best.contains) || (!best.contains && close > now && (best.close <= now || open < best.open))) {
      best = { open, close, contains };
    }
  }
  return best ? { open: best.open, close: best.close, windows } : { open: null, close: null, windows };
}

export function normalizeTpw(live, catalog, { now = Date.now() } = {}) {
  const byId = new Map((catalog?.rides ?? []).map((r) => [r.id, r]));
  const rides = [];
  const parks = emptyParks();
  for (const e of live?.liveData ?? []) {
    if (!e || e.entityType !== 'ATTRACTION' || !e.id) continue;
    const cat = byId.get(e.id);
    const park = cat?.park ?? parkKeyFor(e.parkId, catalog);
    // Knott's feed also carries Soak City slides and night-only Scary Farm mazes: only catalog rides count.
    if (park === 'KBF' && !cat) continue;
    const q = e.queue ?? null;
    const standby = q?.STANDBY?.waitTime;
    const forecast = Array.isArray(e.forecast) && e.forecast.length
      ? e.forecast
          .filter(Boolean)
          .map((f) => ({ t: parseT(f.time), wait: f.waitTime == null ? NaN : Number(f.waitTime) }))
          .filter((f) => Number.isFinite(f.t) && Number.isFinite(f.wait))
          .sort((a, b) => a.t - b.t)
      : null;
    const { open, close, windows } = hoursFor(e.operatingHours, now);
    const single = window(q?.PAID_RETURN_TIME);
    const singleRider = q?.SINGLE_RIDER?.waitTime;
    rides.push({
      id: e.id,
      name: e.name,
      park,
      lat: orNull(cat?.lat),
      lng: orNull(cat?.lng),
      type: cat?.type ?? null,
      status: STATUSES.has(e.status) ? e.status : 'UNKNOWN',
      wait: Number.isFinite(standby) ? standby : null,
      waitUpdated: orNull(parseT(e.lastUpdated)),
      forecast: forecast && forecast.length ? forecast : null,
      open,
      close,
      windows,
      ll: {
        multi: window(q?.RETURN_TIME),
        single: single ? { ...single, price: q?.PAID_RETURN_TIME?.price?.formatted ?? null } : null,
        singleRider: Number.isFinite(singleRider) ? singleRider : null,
        // 'AVAILABLE' | 'FINISHED' (sold out for today) | other; null = this ride has no such lane
        multiState: q?.RETURN_TIME ? String(q.RETURN_TIME.state ?? 'UNKNOWN') : null,
        singleState: q?.PAID_RETURN_TIME ? String(q.PAID_RETURN_TIME.state ?? 'UNKNOWN') : null,
        singlePrice: q?.PAID_RETURN_TIME?.price?.formatted ?? null,
      },
      source: 'tpw',
    });
    if (park && parks[park]) {
      const p = parks[park];
      if (open != null && (p.open == null || open < p.open)) p.open = open;
      if (close != null && (p.close == null || close > p.close)) p.close = close;
    }
  }
  return { at: now, source: 'tpw', rides, parks };
}

/** Queue-Times payloads (array of park payloads, parks 16 and 17) mapped onto catalog rides via qtId. */
export function normalizeQt(payloads, catalog, { now = Date.now() } = {}) {
  const byQt = new Map((catalog?.rides ?? []).filter((r) => r.qtId != null).map((r) => [String(r.qtId), r]));
  const rides = [];
  for (const p of payloads ?? []) {
    const all = [...(p?.rides ?? []), ...(p?.lands ?? []).flatMap((l) => l.rides ?? [])];
    for (const q of all) {
      const cat = byQt.get(String(q.id));
      if (!cat) continue;
      const openNow = q.is_open === true;
      rides.push({
        id: cat.id,
        name: cat.name,
        park: cat.park,
        lat: orNull(cat.lat),
        lng: orNull(cat.lng),
        type: cat.type ?? null,
        status: openNow ? 'OPERATING' : 'CLOSED',
        wait: openNow && Number.isFinite(q.wait_time) ? q.wait_time : null,
        waitUpdated: orNull(parseT(q.last_updated)),
        forecast: null,
        open: null,
        close: null,
        windows: [],
        ll: { multi: null, single: null, singleRider: null },
        source: 'qt',
      });
    }
  }
  return { at: now, source: 'qt', rides, parks: emptyParks() };
}

/** Carry forecasts, hours and Lightning Lane info from an older (richer) snapshot onto a newer one, by id. */
export function withForecastsFrom(snapshot, previous) {
  if (!previous?.rides?.length) return snapshot;
  const prev = new Map(previous.rides.map((r) => [r.id, r]));
  const at = snapshot.at ?? Date.now();
  const rides = snapshot.rides.map((r) => {
    const p = prev.get(r.id);
    if (!p) return r;
    // Queue-Times only says open or not. A ride "not open" during its operating hours is down,
    // and one ThemeParks.wiki had on refurbishment still is (review finding R6).
    let status = r.status;
    if (r.source === 'qt' && status === 'CLOSED') {
      const wins = p.windows?.length ? p.windows : p.open != null && p.close != null ? [{ open: p.open, close: p.close }] : [];
      if (p.status === 'REFURBISHMENT') status = 'REFURBISHMENT';
      else if (wins.some((w) => w.open <= at && at <= w.close)) status = 'DOWN';
    }
    return {
      ...r,
      status,
      forecast: r.forecast ?? p.forecast ?? null,
      open: r.open ?? p.open ?? null,
      close: r.close ?? p.close ?? null,
      windows: r.windows?.length ? r.windows : p.windows ?? [],
    };
  });
  const parks = {};
  for (const k of PARK_KEYS) {
    parks[k] = {
      open: snapshot.parks?.[k]?.open ?? previous.parks?.[k]?.open ?? null,
      close: snapshot.parks?.[k]?.close ?? previous.parks?.[k]?.close ?? null,
    };
  }
  return { ...snapshot, rides, parks };
}

/**
 * Park hours by day from the two /schedule payloads: { 'YYYY-MM-DD': { DL: {open, close}, DCA } }.
 * Only the regular OPERATING session counts. A party night's TICKETED_EVENT after 6 pm isn't open
 * to day guests.
 */
export function parkHoursFrom(schedules, { from = todayKey(), days = 4 } = {}) {
  const out = {};
  for (const [k, sch] of Object.entries(schedules ?? {})) {
    for (const e of sch?.schedule ?? []) {
      if (e?.type !== 'OPERATING' || typeof e.date !== 'string' || e.date < from) continue;
      const open = parseT(e.openingTime);
      const close = parseT(e.closingTime);
      if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
      const day = (out[e.date] ??= {});
      const p = day[k];
      day[k] = p ? { open: Math.min(p.open, open), close: Math.max(p.close, close) } : { open, close };
    }
  }
  const keep = Object.keys(out).sort().slice(0, days);
  return Object.fromEntries(keep.map((d) => [d, out[d]]));
}

/**
 * Put the official park hours on a snapshot. Without them the park's hours are guessed from ride
 * hours, which the live feed sometimes leaves on yesterday's (2026-10-07: California Adventure
 * showed "open until 6 pm" from one walkthrough's hours on a 10 pm day).
 */
export function withParkHours(snapshot, hours, dayKey) {
  const today = hours?.days?.[dayKey];
  if (!snapshot || !today) return snapshot;
  const parks = { ...snapshot.parks };
  for (const k of PARK_KEYS) if (today[k]) parks[k] = { open: today[k].open, close: today[k].close };
  // Knott's rides carry no hours of their own: they run park hours (rope drop, closing, last call).
  const k = today.KBF;
  const rides = k
    ? snapshot.rides.map((r) => (r.park === 'KBF' && r.open == null && !r.windows?.length ? { ...r, open: k.open, close: k.close, windows: [{ open: k.open, close: k.close }] } : r))
    : snapshot.rides;
  return { ...snapshot, parks, rides };
}

/** Mean coordinates of the catalog's rides per park; used to decide which park we're standing in. */
export function parkCenters(catalog) {
  const acc = {};
  for (const r of catalog?.rides ?? []) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue;
    const a = (acc[r.park] ??= { lat: 0, lng: 0, n: 0 });
    a.lat += r.lat;
    a.lng += r.lng;
    a.n++;
  }
  const out = {};
  for (const [k, a] of Object.entries(acc)) out[k] = { lat: a.lat / a.n, lng: a.lng / a.n };
  return out;
}
