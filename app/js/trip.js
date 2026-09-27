// Trip file: the family's ride list, per park, with priorities and rules. Only ride-level fields are
// kept (per-person notes and suitability fields are ignored). Loaded on the phone only
// (from a file or a private link whose data lives in the URL fragment, which is never sent to any
// server). Personal notes about the party are dropped at import; nothing here is ever uploaded.

import { normalizeName, canonical, tokens, jaccard, SEASONAL_TWINS } from './names.js';

const PRIORITIES = new Set(['must', 'high', 'medium', 'low', 'conditional']);
const PARKS = new Set(['DL', 'DCA']);

/** Minutes of head start in the ranking per priority (lower score = sooner). */
export const PRIORITY_BIAS = { must: -15, high: -6, medium: 0, low: 8, conditional: 0 };

const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v) => (Number.isFinite(v) ? v : null);
const bool = (v) => v === true;

/**
 * Validate and slim a trip file. Throws Error with a readable message when it isn't one.
 * Accepts the hand-written format ({meta, ride[], avoid[], rules}) and our own export ({v:1, ...}).
 */
export function parseTripFile(json) {
  if (!json || typeof json !== 'object') throw new Error('Not a trip file.');
  if (json.v === 1) return validateSlim(json); // our own link format, still checked field by field
  const list = Array.isArray(json.ride) ? json.ride : Array.isArray(json.rides) ? json.rides : null;
  if (!list) throw new Error('No "ride" list in this file.');
  const rides = [];
  for (const r of list) {
    if (!r || typeof r !== 'object' || !str(r.name) || !PARKS.has(r.park)) continue;
    rides.push({
      key: str(r.id, 80) ?? normalizeName(r.name),
      name: str(r.name, 120),
      park: r.park,
      priority: PRIORITIES.has(r.priority) ? r.priority : 'medium',
      ll: ['multipass', 'singlepass', 'none'].includes(r.lightningLane) ? r.lightningLane : null,
      notes: str(r.notes),
      intensity: num(r.intensity),
      rest: bool(r.restStop),
      ropeDrop: bool(r.ropeDropTarget),
      typical: num(r.typicalWaitMins),
      conditionalOn: str(r.conditionalOn, 80),
      hint: str(r.scheduleHint, 120),
      original1955: bool(r.original1955),
    });
  }
  if (!rides.length) throw new Error('The ride list is empty or unreadable.');
  const avoid = (Array.isArray(json.avoid) ? json.avoid : [])
    .filter((a) => a && str(a.name) && PARKS.has(a.park))
    .map((a) => ({ key: str(a.id, 80) ?? normalizeName(a.name), name: str(a.name, 120), park: a.park, reason: str(a.reason), conditional: bool(a.conditional) }));
  const rules = json.rules ?? {};
  const dates = Array.isArray(json.meta?.tripDates) ? json.meta.tripDates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
  const given = Array.isArray(json.meta?.days) ? json.meta.days : [];
  const days = (given.length ? given.map((d) => d?.date) : dates)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? ''))
    .map((date) => {
      const g = given.find((d) => d?.date === date);
      return { date, park: PARKS.has(g?.park) ? g.park : null };
    });
  const partySize = Array.isArray(json.meta?.party) && json.meta.party.length ? json.meta.party.length : null; // a count only
  return {
    v: 1,
    days,
    partySize,
    llRule: str(rules.lightningLaneBooking),
    rides,
    avoid,
    ladders: {
      drop: Array.isArray(rules.dropTestLadder) ? rules.dropTestLadder.map((k) => str(k, 80)).filter(Boolean) : [],
      coaster: Array.isArray(rules.coasterLadder) ? rules.coasterLadder.map((k) => str(k, 80)).filter(Boolean) : [],
    },
    verify: Array.isArray(rules.verifyBeforeTrip) ? rules.verifyBeforeTrip.map((k) => str(k, 80)).filter(Boolean) : [],
  };
}

/** Our own slim format (from a link or storage), re-checked field by field: never trusted as-is. */
function validateSlim(j) {
  const bad = (m) => {
    throw new Error(`The trip data is damaged (${m}).`);
  };
  if (!Array.isArray(j.rides) || !j.rides.length) bad('no rides');
  const rides = j.rides
    .filter((r) => r && typeof r === 'object' && str(r.name) && PARKS.has(r.park))
    .map((r) => ({
      key: str(r.key, 80) ?? normalizeName(r.name),
      name: str(r.name, 120),
      park: r.park,
      priority: PRIORITIES.has(r.priority) ? r.priority : 'medium',
      ll: ['multipass', 'singlepass', 'none'].includes(r.ll) ? r.ll : null,
      notes: str(r.notes),
      intensity: num(r.intensity),
      rest: bool(r.rest),
      ropeDrop: bool(r.ropeDrop),
      typical: num(r.typical),
      conditionalOn: str(r.conditionalOn, 80),
      hint: str(r.hint, 120),
      original1955: bool(r.original1955),
    }));
  if (!rides.length) bad('no readable rides');
  const avoid = (Array.isArray(j.avoid) ? j.avoid : [])
    .filter((a) => a && typeof a === 'object' && str(a.name) && PARKS.has(a.park))
    .map((a) => ({ key: str(a.key, 80) ?? normalizeName(a.name), name: str(a.name, 120), park: a.park, reason: str(a.reason), conditional: bool(a.conditional) }));
  const days = (Array.isArray(j.days) ? j.days : [])
    .filter((d) => d && typeof d === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(d.date ?? ''))
    .map((d) => ({ date: d.date, park: PARKS.has(d.park) ? d.park : null }));
  const keys = (a) => (Array.isArray(a) ? a.map((k) => str(k, 80)).filter(Boolean) : []);
  const party = Number.isInteger(j.partySize) && j.partySize > 0 && j.partySize < 20 ? j.partySize : null;
  return { v: 1, days, partySize: party, llRule: str(j.llRule), rides, avoid, ladders: { drop: keys(j.ladders?.drop), coaster: keys(j.ladders?.coaster) }, verify: keys(j.verify) };
}

/**
 * Gates per ride key: the rides that must go well first. From a ride's own "conditionalOn" and from
 * each ladder in the file (every rung waits on the rung before it). Returns Map key -> [gateKey].
 */
export function ladderGates(trip) {
  const gates = new Map();
  const add = (k, g) => {
    if (!k || !g || k === g) return;
    const list = gates.get(k) ?? [];
    if (!list.includes(g)) list.push(g);
    gates.set(k, list);
  };
  for (const r of trip?.rides ?? []) add(r.key, r.conditionalOn);
  for (const ladder of Object.values(trip?.ladders ?? {})) {
    if (!Array.isArray(ladder)) continue;
    for (let i = 1; i < ladder.length; i++) add(ladder[i], ladder[i - 1]);
  }
  return gates;
}

const stripParens = (s) => String(s).replace(/\([^)]*\)/g, ' ');

/** Find the catalog ride for a trip ride name in a park: exact, alias, without "(…)", then fuzzy. */
export function matchRide(name, park, catalogRides) {
  const inPark = catalogRides.filter((r) => r.park === park);
  const keyed = inPark.map((r) => ({ r, norm: normalizeName(r.name) }));
  for (const n of [normalizeName(name), normalizeName(stripParens(name))]) {
    const exact = keyed.filter((k) => k.norm === n);
    if (exact.length === 1) return exact[0].r;
    const alias = keyed.filter((k) => canonical(k.norm) === canonical(n));
    if (alias.length === 1) return alias[0].r;
  }
  const t = tokens(canonical(normalizeName(stripParens(name))));
  let best = null;
  let bestS = 0;
  for (const k of keyed) {
    const s = jaccard(t, tokens(canonical(k.norm)));
    if (s > bestS) [best, bestS] = [k.r, s];
  }
  return bestS >= 0.6 ? best : null;
}

/** Catalog ids of the same ride's seasonal twin in the same park (see SEASONAL_TWINS). */
export function twinIds(id, catalogRides) {
  const base = catalogRides.find((r) => r.id === id);
  if (!base) return [];
  const me = canonical(normalizeName(base.name));
  const group = SEASONAL_TWINS.find((g) => g.includes(me));
  if (!group) return [];
  return catalogRides.filter((r) => r.id !== id && r.park === base.park && group.includes(canonical(normalizeName(r.name)))).map((r) => r.id);
}

/** Attach catalog ids (tpwId) to every ride and avoid entry. */
export function attachIds(trip, catalogRides) {
  const withId = (x) => ({ ...x, tpwId: matchRide(x.name, x.park, catalogRides)?.id ?? null });
  return { ...trip, rides: trip.rides.map(withId), avoid: trip.avoid.map(withId) };
}

/** The trip day for a park-day key, or null. */
export const tripDay = (trip, dayKey) => trip?.days?.find((d) => d.date === dayKey) ?? null;

// ---- Private link: gzip + base64url in the URL fragment ----

const b64url = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

async function pipe(bytes, stream) {
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

export async function encodeTrip(trip) {
  const bytes = new TextEncoder().encode(JSON.stringify(trip));
  return 'z' + b64url(await pipe(bytes, new CompressionStream('gzip')));
}

export async function decodeTrip(s) {
  if (!s) throw new Error('Empty trip link.');
  const bytes = s[0] === 'z' ? await pipe(unb64url(s.slice(1)), new DecompressionStream('gzip')) : unb64url(s);
  return parseTripFile(JSON.parse(new TextDecoder().decode(bytes)));
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** A weekday named in a ride's schedule hint ("Friday, save it for the finale") limits it to that day; null = any day. */
export function hintWeekday(hint) {
  const m = /\b(sun|mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?)(?:day)?\b/i.exec(hint ?? '');
  return m ? WEEKDAYS.indexOf(m[1].slice(0, 3).toLowerCase()) : null;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Locks from the trip file for one park day, given what has been ridden (trip-wide, ride ids).
 * A ride waits on its gates: its own "after" ride plus the rung before it in each ladder. It opens
 * once every gate has been ridden and you said it went well (gate[key] = 'yes'); a thumbs down on a
 * gate skips every rung above it. A weekday in a ride's note ("Friday, last ride") keeps it for that
 * day. A manual unlock[key] = 'yes' beats all of these; 'no' skips the ride.
 * Returns { locked: { rideId: detail }, info: { rideId: { kind, after: [gateRideId] } }, prompts: [{ gate, unlocks }] }.
 */
export function computeLocks(trip, { ridden, gate = {}, unlock = {}, weekday }) {
  const byKey = new Map((trip?.rides ?? []).map((r) => [r.key, r]));
  const gates = ladderGates(trip);
  const wd = weekday;
  const locked = {};
  const info = {};
  const prompts = new Map();
  const isRidden = (k) => {
    const id = byKey.get(k)?.tpwId;
    return Boolean(id && ridden.has(id));
  };
  const blocked = (k, seen = new Set()) => {
    if (seen.has(k)) return null;
    seen.add(k);
    if (gate[k] === 'no' || unlock[k] === 'no') return k;
    for (const g of gates.get(k) ?? []) {
      const b = blocked(g, seen);
      if (b) return b;
    }
    return null;
  };
  for (const r of trip?.rides ?? []) {
    if (!r.tpwId || ridden.has(r.tpwId)) continue;
    if (unlock[r.key] === 'yes') continue;
    const set = (kind, detail, after = []) => {
      locked[r.tpwId] = detail;
      info[r.tpwId] = { kind, after };
    };
    if (unlock[r.key] === 'no') {
      set('skip', 'skipped');
      continue;
    }
    const hw = hintWeekday(r.hint);
    if (hw != null && hw !== wd) {
      set('hint', `saved for ${WEEKDAY_NAMES[hw]}${r.hint ? ` (${r.hint})` : ''}`);
      continue;
    }
    const gs = (gates.get(r.key) ?? []).filter((g) => byKey.has(g));
    const bad = gs.map((g) => blocked(g)).find(Boolean);
    if (bad) {
      set('skip', `skipped: ${byKey.get(bad)?.name ?? 'an earlier ride'} didn't go well`);
      continue;
    }
    const pending = gs.filter((g) => !(isRidden(g) && gate[g] === 'yes'));
    if (pending.length) {
      const g = byKey.get(pending[0]);
      const after = pending.map((k) => byKey.get(k)?.tpwId).filter(Boolean);
      if (isRidden(pending[0])) {
        set('wait', `ready once you say ${g.name} went well`, after);
        const p = prompts.get(g.key) ?? { gate: g, unlocks: [] };
        p.unlocks.push(r);
        prompts.set(g.key, p);
      } else {
        set('wait', `after ${g.name} goes well${r.hint ? ` (${r.hint})` : ''}`, after);
      }
      continue;
    }
    if (!gs.length && r.priority === 'conditional') set('manual', `your call on the day${r.hint ? ` (${r.hint})` : ''}`);
  }
  return { locked, info, prompts: [...prompts.values()] };
}
