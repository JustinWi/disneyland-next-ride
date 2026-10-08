// Next Ride: UI, state, timers, geolocation, storage. The engine lives in js/ (pure, tested).

import { plan, arrivalPlan } from './js/plan.js';
import { fetchFresh, fetchHours, fetchKnotts, buildSnapshot } from './js/sources.js';
import { load, save, remove } from './js/store.js';
import { atResort, haversineMeters, parkFootprints, parkAt, walkMinutes } from './js/geo.js';
import { fmtTime, fmtAge, parkDayKey, parkTime, hhmm, fmtDay, parkHour, weekdayOf } from './js/time.js';
import { forecastAt } from './js/forecast.js';
import { parseTripFile, attachIds, tripDay, encodeTrip, decodeTrip, PRIORITY_BIAS, hintWeekday, computeLocks, twinIds, ladderGates } from './js/trip.js';
import { clampStars, effectiveDone, favorites, againBias, starText } from './js/ratings.js';
import { forDay, nextBooking, adviseMulti, convertDown, dueBookings, heldBookings, multiExpOptions, LL, laneStats, planLaneDay, singlePassAdvice, usuallyGoneBy } from './js/lightning.js';
import { laneAlerts, bookNextAlert, lastChanceAlerts, statusAlerts, showAlerts, finalClose, mergeBanners } from './js/alerts.js';
import { showsToday, nextTime, ridesThatEmpty, classifyShow } from './js/shows.js';
import { similarRides, tooShortFor } from './js/similar.js';
import { PARK_IDS } from './js/normalize.js';
import { feelOf, coolOf, rideWeight, HEAT_MINUTES, HEAT_BIAS, COOL_LABEL, heatOn, coolSpots, withDropTest, testRideBias } from './js/boost.js';

const SNOOZE_MIN = 45;
const REFRESH_MS = 60e3;
const TICK_MS = 30e3;
const MIN = 60e3;
const PARK = { DL: 'Disneyland', DCA: 'California Adventure', KBF: "Knott's Berry Farm" };
const PARK_SHORT = { DL: 'Disneyland', DCA: 'DCA', KBF: "Knott's" };
const KBF_RADIUS_M = 1200; // Knott's and its parking lots, measured from the park's center
const PRIO_LABEL = { must: 'Must-do', high: 'High', medium: 'Medium', low: 'Low', conditional: 'Maybe' };
const COARSE_M = 250; // a GPS fix rougher than this can't tell which park you're in

// ---------- state ----------

const flag = (name) => {
  try {
    return new URLSearchParams(location.search).has(name);
  } catch {
    return false;
  }
};
// ?offline simulates no signal (for testing what the app shows with only last-known waits).
const SIMULATE_OFFLINE = flag('offline');

function parseAt() {
  try {
    const at = new URLSearchParams(location.search).get('at');
    if (!at) return null;
    const [lat, lng] = at.split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}

function loadDoneAndHistory() {
  const today = parkDayKey();
  const history = load('history', {}) ?? {};
  const d = load('done', null);
  if (d && d.date && d.date !== today && Array.isArray(d.ids) && d.ids.length) {
    history[d.date] = [...new Set([...(history[d.date] ?? []), ...d.ids])];
    save('history', history);
  }
  const done = d && d.date === today ? { date: today, ids: new Set(d.ids) } : { date: today, ids: new Set() };
  return { done, history };
}

const initial = loadDoneAndHistory();
const S = {
  catalog: null,
  footprints: null,
  data: { tpw: load('tpw', null), qt: load('qt', null), hours: load('hours', null), kbf: load('kbf', null) }, // hours: official park hours by day; kbf: Knott's waits
  fetching: false,
  lastAttempt: null,
  offline: false,
  wanted: new Set(load('wanted', [])),
  done: initial.done,
  history: initial.history,
  snoozed: load('snoozed', {}),
  settings: { speed: 'normal', hopMinutes: 20, start: 'DL', showAll: false, llPrice: null, party: null, battery: false, heightIn: null, thrills: true, ...load('settings', {}) },
  heat: load('heat', null), // { until } while "We're hot" is on
  folded: load('folded', {}) ?? {}, // { DL: true } park sections collapsed on the Rides tab
  tests: {}, // { rideId: 'Drop test' | 'Screen test' | 'Warm-up' } rides that unlock others, this render
  llstats: null,
  llDays: load('llDays', {}) ?? {}, // { 'YYYY-MM-DD': 'on' | 'off' }
  ratings: load('ratings', {}) ?? {}, // { rideId: { stars, at } } for the whole trip
  again: load('again', {}) ?? {}, // { 'YYYY-MM-DD': [rideId] } rides put back on that day's list
  counts: load('counts', {}) ?? {}, // { rideId: times ridden }
  rateNext: null, // ride just marked done, waiting for stars
  rideinfo: null, // app/data/rideinfo.json: heights, what to expect, similarity tags
  fired: load('fired', null), // { day, keys: { alertKey: 1 } } reminders already shown today
  banners: [], // reminders on screen now
  // { day, status: { rideId: status } } last seen status per ride today, for back-up / went-down alerts
  prevStatus: ((p) => (p?.day && p.status ? p : { day: null, status: {} }))(load('prevStatus', null)),
  showPrefs: load('showPrefs', {}) ?? {}, // { showName: true|false } remind me
  arrival: load('arrival', null), // { day, at, travel } after "We're on our way"
  briefDone: load('briefDone', {}) ?? {}, // { day: true } morning briefing dismissed
  tab: ['next', 'lanes', 'rides', 'more'].includes(load('tab', 'next')) ? load('tab', 'next') : 'next',
  geo: { status: 'pending', pos: null, acc: null },
  override: parseAt(),
  // The ride we're heading to (the top pick), kept across a reload so "just went down" still works.
  stickyId: ((s) => (s?.id && Date.now() - s.at < 20 * 60e3 ? s.id : null))(load('sticky', null)),
  query: '',
  confirm: null,
  trip: load('trip', null),
  dayPark: load('dayPark', {}) ?? {},
  unlock: load('unlock', {}) ?? {}, // { rideKey: 'yes' | 'no' } manual override per ride
  gate: load('gate', {}) ?? {}, // { rideKey: 'yes' | 'no' } how a ladder ride went
  ll: forDay(load('ll', null), parkDayKey()),
  pendingTrip: null,
  bookForm: null,
  note: null, // one-line message shown on the current tab (import results, link copied)
  shareText: null,
};

const saveWanted = () => save('wanted', [...S.wanted]);
const saveDone = () => save('done', { date: S.done.date, ids: [...S.done.ids] });
const saveSnoozed = () => save('snoozed', S.snoozed);
const saveSettings = () => save('settings', S.settings);
const saveLL = () => save('ll', S.ll);

function ensureToday(now) {
  const today = parkDayKey(now);
  if (S.done.date !== today) {
    if (S.done.ids.size) {
      S.history[S.done.date] = [...new Set([...(S.history[S.done.date] ?? []), ...S.done.ids])];
      save('history', S.history);
    }
    S.done = { date: today, ids: new Set() };
    saveDone();
  }
  if (S.ll.day !== today) {
    S.ll = forDay(null, today);
    saveLL();
  }
  if (S.fired?.day !== today) {
    S.fired = { day: today, keys: {} };
    save('fired', S.fired);
    S.banners = [];
  }
  if (S.prevStatus.day !== today) {
    // Yesterday's (or last trip day's) statuses say nothing about today: the first look is silent.
    S.prevStatus = { day: today, status: {} };
    save('prevStatus', S.prevStatus);
  }
  if (S.arrival && S.arrival.day !== today) {
    S.arrival = null;
    save('arrival', null);
  }
  let changed = false;
  for (const [id, until] of Object.entries(S.snoozed)) {
    if (!(until > now)) {
      delete S.snoozed[id];
      changed = true;
    }
  }
  if (changed) saveSnoozed();
}

// ---------- trip ----------

// The trip as planned with: the drop test (Rise of the Resistance on the list behind Pirates' drops,
// when the trip file had it as a conditional avoid). See boost.js.
let tripXm = null;
function tripX() {
  if (tripXm && tripXm.src === S.trip) return tripXm;
  tripXm = { src: S.trip, ...withDropTest(S.trip) };
  // Rise joins the picked list once, when it first moves on; unticking it later sticks.
  const rise = tripXm.added ? tripXm.trip.rides.find((r) => r.key === tripXm.riseKey) : null;
  if (rise?.tpwId && !load('dropTestAdded', false)) {
    S.wanted.add(rise.tpwId);
    saveWanted();
    save('dropTestAdded', true);
  }
  return tripXm;
}

const feelOfId = (id, fallback) => feelOf(catalogRide(id)?.name ?? fallback);

let tripIx = null;
function tripIndex() {
  const tx = tripX();
  if (tripIx && tripIx.trip === tx.trip && tripIx.catalog === S.catalog && tripIx.thrills === S.settings.thrills) return tripIx;
  const t = tx.trip;
  const ix = { trip: t, catalog: S.catalog, thrills: S.settings.thrills, byTpw: new Map(), byKey: new Map(), prio: {}, filePrio: {}, bias: {}, feel: {}, typical: {}, avoid: new Map() };
  for (const r of t?.rides ?? []) {
    ix.byKey.set(r.key, r);
    if (!r.tpwId) continue;
    ix.byTpw.set(r.tpwId, r);
    const feel = feelOfId(r.tpwId, r.name);
    ix.feel[r.tpwId] = feel;
    // Thrills first: thrill rides count as Must-do and go ahead of the other must-dos; calm rides two steps lower.
    const wt = rideWeight(r.priority, feel, S.settings.thrills);
    ix.prio[r.tpwId] = wt.priority;
    ix.filePrio[r.tpwId] = r.priority; // safety alerts (last chance, try instead) keep the trip file's must-dos
    ix.bias[r.tpwId] = wt.bias;
    if (Number.isFinite(r.typical)) ix.typical[r.tpwId] = r.typical;
  }
  // Knott's rides aren't in the trip file: Thrills first orders them by how wild they are.
  for (const r of S.catalog?.rides ?? []) {
    if (r.park !== 'KBF' || ix.byTpw.has(r.id)) continue;
    const feel = feelOf(r.name);
    const wt = rideWeight('medium', feel, S.settings.thrills);
    ix.feel[r.id] = feel;
    ix.prio[r.id] = wt.priority;
    ix.bias[r.id] = wt.bias;
  }
  for (const a of t?.avoid ?? []) {
    if (!a.tpwId) continue;
    ix.avoid.set(a.tpwId, a);
    // Avoiding Guardians avoids its Halloween version too: a separate entity in the feed, same drop.
    for (const id of twinIds(a.tpwId, S.catalog?.rides ?? [])) if (!ix.avoid.has(id)) ix.avoid.set(id, a);
  }
  tripIx = ix;
  return ix;
}

/** Everything ridden this trip (previous trip days) plus today. */
function riddenSet(today) {
  const out = new Set(S.done.ids);
  const days = S.trip?.days ?? [];
  if (days.some((d) => d.date === today)) {
    for (const d of days) for (const id of S.history[d.date] ?? []) out.add(id);
  }
  return out;
}

/** What counts as done for planning: ridden, minus rides put back on today's list with "Ride again". */
const doneSet = (today) => effectiveDone(riddenSet(today), S.again[today]);

/** Is the phone at Knott's (or set to a test location there)? */
function atKnotts() {
  const p = S.override ?? S.geo.pos;
  const k = S.catalog?.parks?.KBF;
  return Boolean(p && k && atResort(p, k, KBF_RADIUS_M));
}

/** { park: 'DL'|'DCA'|'KBF'|null (both Disney parks), needsChoice, tripDay } for today. */
function todayPark(today) {
  const td = tripDay(S.trip, today);
  const chosen = S.dayPark[today];
  if (chosen === 'DL' || chosen === 'DCA' || chosen === 'KBF') return { park: chosen, needsChoice: false, td };
  if (chosen === 'both') return { park: null, needsChoice: false, td };
  // A trip day's own park wins (a hotel near Knott's mustn't turn a Disneyland day into Knott's).
  if (td?.park) return { park: td.park, needsChoice: false, td };
  // Standing at Knott's settles it, and is remembered for the day: lunch off-site, a lost GPS fix
  // or location turned off mustn't turn a Knott's day back into a Disney one.
  if (atKnotts()) {
    if (!S.override && S.geo.acc != null && S.geo.acc <= 500) {
      S.dayPark[today] = 'KBF';
      save('dayPark', S.dayPark);
    }
    return { park: 'KBF', needsChoice: false, td, auto: true };
  }
  if (td) return { park: null, needsChoice: true, td };
  return { park: null, needsChoice: false, td: null };
}

/** Trip priorities, plus a head start for loved rides you put back on today's list. */
function rideBias(today, { locked = {}, info = {}, ridden = new Set(), now = Date.now(), short = {} } = {}) {
  const ix = tripIndex();
  const bias = { ...ix.bias };
  for (const id of S.again[today] ?? []) bias[id] = (bias[id] ?? 0) + againBias(S.ratings[id]?.stars ?? 0);
  // Test rides (Pirates' drops, Runaway Railway's screens) go just ahead of the ride they unlock.
  const blocked = new Set([...Object.keys(locked).filter((id) => info[id]?.kind !== 'wait'), ...Object.keys(short)]);
  const boost = testRideBias(ix.trip, ladderGates(ix.trip), { bias, wanted: S.wanted, ridden, gate: S.gate, blocked });
  Object.assign(bias, boost);
  S.tests = testLabels(Object.keys(boost));
  // We're hot: indoor and water rides first, long sunny queues later.
  if (heatOn(S.heat, now)) {
    for (const id of S.wanted) {
      const cool = coolOf(catalogRide(id)?.name);
      if (cool) bias[id] = (bias[id] ?? 0) + HEAT_BIAS[cool];
    }
  }
  return bias;
}

/** 'Drop test' for the drop test ride, 'Screen test' for Runaway Railway, else 'Warm-up'. */
function testLabels(ids) {
  const tx = tripX();
  const ix = tripIndex();
  const out = {};
  const screenKey = tx.trip?.ladders?.screenTest?.[0];
  for (const id of ids) {
    const key = ix.byTpw.get(id)?.key;
    out[id] = key && key === tx.dropKey ? 'Drop test' : key && key === screenKey ? 'Screen test' : 'Warm-up';
  }
  return out;
}

/** Trip locks for a park day (see computeLocks in trip.js). */
function locks(day, ridden) {
  return computeLocks(tripX().trip, { ridden, gate: S.gate, unlock: S.unlock, weekday: weekdayOf(day) });
}


// ---------- Lightning Lane, per day ----------

/** 'on' | 'off' | null (a trip day not decided yet). Days outside the trip default to on. */
function llOn(day) {
  const v = S.llDays[day];
  if (v === 'on' || v === 'off') return v;
  return tripDay(S.trip, day) ? null : 'on';
}

const priceEach = (day, park) => S.settings.llPrice ?? S.llstats?.hours?.[`${day}|${park}`]?.llmp ?? 37;
const partySize = () => S.settings.party ?? S.trip?.partySize ?? 4;

/** Rides ridden on trip days before `day` (so Friday's plan skips what Monday and Wednesday covered). */
function doneBefore(day) {
  const out = new Set();
  const today = parkDayKey();
  for (const d of S.trip?.days ?? []) {
    if (d.date >= day) continue;
    for (const id of S.history[d.date] ?? []) out.add(id);
    if (d.date === today) for (const id of S.done.ids) out.add(id);
  }
  if (day === today) for (const id of S.done.ids) out.add(id);
  return out;
}

/** Learned patterns for one park, or both merged. */
function statsFor(park, day) {
  if (!S.llstats) return null;
  const wd = weekdayOf(day);
  if (park) return laneStats(S.llstats, park, wd);
  return new Map([...laneStats(S.llstats, 'DL', wd), ...laneStats(S.llstats, 'DCA', wd)]);
}

/** A simulated Multi Pass day for one park: verdict, minutes saved, cost and a booking plan. */
function lanePlan(day, park, snap) {
  if (!S.llstats || !park) return null;
  const wd = weekdayOf(day);
  const stats = laneStats(S.llstats, park, wd);
  const isToday = Boolean(snap) && day === parkDayKey();
  if (isToday) {
    // On the day itself, today's live forecast beats last week's standby.
    for (const r of snap.rides) {
      const st = stats.get(r.id);
      if (!st || !r.forecast) continue;
      const standby = {};
      for (let h = 8; h <= 23; h++) {
        const f = forecastAt(r.forecast, parkTime(day, `${String(h).padStart(2, '0')}:30`));
        if (f != null) standby[h] = f;
      }
      stats.set(r.id, { ...st, standby });
    }
  }
  const ix = tripIndex();
  const done = doneBefore(day);
  const lk = locks(day, done);
  const tooShort = tooShortFor(S.rideinfo?.rides, S.settings.heightIn);
  const src = S.trip
    ? ix.trip.rides.filter((r) => r.tpwId)
    : [...S.wanted].map((id) => catalogRide(id)).filter(Boolean).map((c) => ({ key: c.id, tpwId: c.id, name: c.name, park: c.park, priority: 'medium' }));
  const rides = src
    .filter((r) => r.park === park && S.wanted.has(r.tpwId) && !done.has(r.tpwId) && stats.get(r.tpwId)?.kind === 'multi' && !ix.avoid.has(r.tpwId))
    .filter((r) => !['skip', 'hint'].includes(lk.info[r.tpwId]?.kind))
    .filter((r) => !tooShort[r.tpwId]) // F5: nobody books a lane for a ride the shortest rider can't go on
    .map((r) => {
      const l = lk.info[r.tpwId];
      // A ride still waiting on its ladder counts half, and only after its gates in the plan.
      return { id: r.tpwId, name: r.name, priority: ix.prio[r.tpwId] ?? r.priority, typical: r.typical, conditional: Boolean(l), after: l?.after ?? [] };
    });
  const h = S.llstats.hours?.[`${day}|${park}`];
  const dayOpen = h?.open ? Date.parse(h.open) : parkTime(day, '08:00');
  const close = h?.close ? Date.parse(h.close) : parkTime(day, '22:00');
  // Today only the rest of the day counts (review M9).
  const open = isToday ? Math.max(dayOpen, Date.now()) : dayOpen;
  const plan = planLaneDay({ rides, stats, open, dayOpen, close, priceEach: priceEach(day, park), party: partySize(), hourOf: parkHour });
  const sample = [...new Set(Object.values(S.llstats.days).filter((d) => d.park === park).map((d) => d.day))].sort();
  return { day, park, rides, ...plan, price: priceEach(day, park), party: partySize(), sample, isToday, close, lateToday: isToday && Date.now() > close - 3 * 3600e3 };
}

const VERDICT = { buy: 'Worth it', maybe: 'Your call', skip: 'Skip it' };
const hmin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

function planBlock(p, { toggle = true } = {}) {
  if (!p) return '';
  const head = `<div class="planhead"><b>${esc(fmtDay(p.day))} · ${esc(PARK[p.park])}</b><span class="verdict v-${p.verdict}">${VERDICT[p.verdict]}</span></div>`;
  const body = !p.rides.length
    ? '<p class="small">None of the rides left on your list here are on Multi Pass, so skip it.</p>'
    : `<p class="small">Saves about <b>${esc(hmin(p.saved))}</b> of standby for <b>$${esc(p.cost)}</b> (${esc(p.party)} × $${esc(p.price)})${p.saved ? `, about $${(p.cost / p.saved).toFixed(2)} a minute` : ''}.</p>`;
  const why = p.rides.length && p.verdict === 'skip' ? '<p class="muted small">Your rides here usually have short lines, so a lane saves little. Rope-drop and use the app’s standby picks.</p>' : '';
  const list = p.bookings.length
    ? `<details><summary>Booking plan (${p.bookings.length})</summary><ol class="planlist">${p.bookings
        .map((b) => `<li>${esc(fmtTime(b.bookAt))}: book <b>${esc(b.name)}</b>, return ~${esc(fmtTime(b.returnAt))}, skips a ~${Math.round(b.standby)} min line${b.conditional ? ' (if unlocked)' : ''}${b.soonGone ? ' (usually sells out soon after)' : ''}</li>`)
        .join('')}</ol></details>`
    : '';
  const tg = toggle ? seg('llday', llOn(p.day) ?? '', [['on', 'We have it'], ['off', 'Not this day']], `data-date="${esc(p.day)}"`) : '';
  return `<div class="planblock">${head}${body}${why}${list}${tg}</div>`;
}

// ---------- helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fold = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

function where(tpPark = null) {
  const cat = S.catalog;
  const gates = cat?.parks?.DL && cat?.parks?.DCA ? { DL: cat.parks.DL, DCA: cat.parks.DCA, ...(cat.parks.KBF ? { KBF: cat.parks.KBF } : {}) } : null;
  const p = S.override ?? S.geo.pos;
  const kbf = gates?.KBF;
  if (kbf && (atKnotts() || tpPark === 'KBF')) {
    const gate = { lat: kbf.lat, lng: kbf.lng };
    if (p && atKnotts()) {
      const coarse = !S.override && S.geo.acc != null && S.geo.acc > COARSE_M;
      // In the lot or at the gate (outside the rides' footprint): walks from the gate.
      const inside = !coarse && parkAt(p, S.footprints) === 'KBF';
      return { pos: inside ? p : gate, posPark: inside ? 'KBF' : null, gates, mode: S.override ? 'override' : coarse ? 'coarse' : 'gps' };
    }
    // A Knott's day away from Knott's (on the way, or no location): plan from its gate.
    return { pos: gate, posPark: p ? null : 'KBF', gates, mode: p ? 'far' : 'nogps' };
  }
  if (p && gates && atResort(p, cat.parks.DL)) {
    const coarse = !S.override && S.geo.acc != null && S.geo.acc > COARSE_M;
    // posPark null = outside both parks (esplanade, Downtown Disney, hotels): walks go via each gate.
    const posPark = coarse ? null : parkAt(p, S.footprints);
    return { pos: p, posPark, gates, mode: S.override ? 'override' : coarse ? 'coarse' : 'gps' };
  }
  if (p && gates) {
    // Away from the resort: plan as if arriving on the esplanade, between the two gates.
    const esplanade = { lat: (gates.DL.lat + gates.DCA.lat) / 2, lng: (gates.DL.lng + gates.DCA.lng) / 2 };
    return { pos: esplanade, posPark: null, gates, mode: 'far' };
  }
  // No location at all: assume we're just inside the chosen park's gate.
  const gate = cat?.parks?.[S.settings.start] ?? cat?.parks?.DL ?? null;
  return { pos: gate ? { lat: gate.lat, lng: gate.lng } : null, posPark: gate ? S.settings.start : null, gates, mode: 'nogps' };
}

const catalogRide = (id) => S.catalog?.rides.find((r) => r.id === id) ?? null;
const landOf = (ride) => catalogRide(ride.id)?.land ?? null;

function mapsUrl(ride) {
  if (!Number.isFinite(ride?.lat) || !Number.isFinite(ride?.lng)) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${ride.lat},${ride.lng}&travelmode=walking`;
}

function llLines(ll) {
  const out = [];
  if (ll?.multi) out.push(`<b>Lightning Lane</b> return ${esc(fmtTime(ll.multi.start))}`);
  else if (ll?.multiState === 'FINISHED') out.push('<b>Lightning Lane</b> sold out');
  if (ll?.single) out.push(`<b>Single Pass</b>${ll.single.price ? ' ' + esc(ll.single.price) : ''} return ${esc(fmtTime(ll.single.start))}`);
  if (Number.isFinite(ll?.singleRider)) out.push(`<b>Single rider</b> ${ll.singleRider} min`);
  return out;
}

const waitBig = (e) => (e.flags.includes('wait-unknown') ? '?' : String(Math.round(e.waitNow)));
const prioChip = (id) => {
  const ix = tripIndex();
  const p = ix.prio[id];
  const bolt = ix.thrills && ix.feel[id] === 'thrill' ? '⚡ ' : '';
  const test = S.tests[id] ? `<span class="prio prio-test">${esc(S.tests[id])}</span>` : '';
  return (p ? `<span class="prio prio-${esc(p)}">${bolt}${esc(PRIO_LABEL[p] ?? p)}</span>` : '') + test;
};
/** One line under a pick: why a test ride goes early, and how the queue treats you when it's hot. */
function boostLine(id) {
  const tx = tripX();
  const parts = [];
  if (S.tests[id] === 'Drop test') {
    const rr = tx.riseKey ? tripIndex().byKey.get(tx.riseKey) : null;
    const rise = rr?.tpwId && S.wanted.has(rr.tpwId) && !(S.unlock[rr.key] === 'no') ? rr.name : null;
    parts.push(`<b>Drop test:</b> two short drops in the dark.${rise ? ` If they go well, ${esc(rise)} (a bigger drop in the dark) is next on the list.` : ''}`);
  } else if (S.tests[id] === 'Screen test') {
    parts.push('<b>Screen test:</b> screens with gentle motion. Say how it went afterwards.');
  } else if (S.tests[id]) {
    parts.push('<b>Warm-up:</b> unlocks a bigger ride once it goes well.');
  }
  if (heatOn(S.heat, Date.now())) {
    const cool = coolOf(catalogRide(id)?.name);
    if (cool) parts.push(`${cool === 'sun' ? '☀️' : cool === 'water' ? '💦' : cool === 'indoor' ? '❄️' : '⛱️'} ${esc(COOL_LABEL[cool])}`);
  }
  return parts.length ? `<p class="expect">${parts.join(' ')}</p>` : '';
}
const tripNote = (id) => {
  const r = tripIndex().byTpw.get(id);
  const parts = [r?.hint ? `Best: ${r.hint}.` : '', r?.notes ?? ''].filter(Boolean);
  return parts.length ? `<p class="tripnote">${esc(parts.join(' '))}</p>` : '';
};
function routeLine(e) {
  if (!e.route?.length) return '';
  const parts = e.route.map((s) => `${s.entry.ride.name} (${Math.max(1, Math.round(s.walk))} min walk, ~${Math.max(0, Math.round(s.wait))} min wait)`);
  const lands = [...new Set([e.ride, ...e.route.map((s) => s.entry.ride)].map((r) => landOf(r)).filter(Boolean))];
  const area = lands.length === 1 ? ` All in ${lands[0]}.` : '';
  return `<p class="routeline"><b>Then:</b> ${esc(parts.join(', then '))}.${esc(area)}</p>`;
}

function expectLine(id) {
  const i = info(id);
  if (!i?.expect) return '';
  // The note matters when it changes who can ride (Autopia's driver, Silly Symphony's tandem swing).
  const note = i.heightNote && !/overlay/i.test(i.heightNote) ? ` ${i.heightNote}.` : '';
  const h = `${Number.isFinite(i.heightIn) ? ` Height minimum ${i.heightIn} in.` : ''}${note}`;
  return `<p class="expect"><b>What to expect:</b> ${esc(i.expect)}${esc(h)} ${i.video ? `<a href="${esc(i.video)}" target="_blank" rel="noopener">Preview ↗</a>` : ''}</p>`;
}

const nameOf = (id, snap) => snap?.rides.find((r) => r.id === id)?.name ?? catalogRide(id)?.name ?? 'ride';

// ---------- reminders (in-app banner + vibration) ----------

function fireAlerts(list) {
  const fresh = list.filter((a) => !S.fired.keys[a.key]);
  if (!fresh.length) return;
  for (const a of fresh) S.fired.keys[a.key] = 1;
  S.banners = mergeBanners(S.banners, fresh);
  save('fired', S.fired);
  // "Back up" is good news, not a call to act: it shows quietly.
  if (fresh.every((a) => a.kind === 'up')) return;
  try {
    navigator.vibrate?.([160, 80, 160]);
  } catch {
    /* not supported (iPhone): the banner is enough */
  }
}

function renderAlerts() {
  const el = document.getElementById('alerts');
  if (!el) return;
  el.innerHTML = S.banners
    .map(
      (a) => `<div class="alert alert-${esc(a.kind)}" role="status"><div class="grow"><b>${esc(a.title)}</b><div class="sub">${esc(a.body)}</div></div>
      ${a.reload ? '<button type="button" class="primary" data-act="app-reload">Reload</button>' : ''}
      ${a.action && a.action !== S.tab ? `<button type="button" data-act="alert-go" data-key="${esc(a.key)}" data-tab="${esc(a.action)}">Show</button>` : ''}
      <button type="button" data-act="alert-ok" data-key="${esc(a.key)}" aria-label="Dismiss">OK</button></div>`,
    )
    .join('');
}

const parkOfId = (pid) => (pid === PARK_IDS.DL ? 'DL' : pid === PARK_IDS.DCA ? 'DCA' : null);
const wantsShow = (s) => S.showPrefs[s.name] ?? s.major;
const info = (id) => S.rideinfo?.rides?.[id] ?? null;

// ---------- compute ----------

function compute(now) {
  ensureToday(now);
  const today = parkDayKey(now);
  const tp = todayPark(today);
  const snap = S.catalog ? buildSnapshot(S.data, S.catalog, now) : null;
  const w = where(tp.park);
  const base = { snap, w, res: null, missing: [], today, tp, advice: null, next: null, due: [], prompts: [] };
  if (!snap) return base;
  // At Knott's, its own feed's age is what counts; no Knott's data yet means no waits yet.
  if (tp.park === 'KBF' && snap.atKBF == null) return { ...base, snap: null };
  // Waits from a previous park day say nothing about today (review finding R4).
  if (parkDayKey(snapAt({ snap, tp })) !== parkDayKey(now)) return { ...base, oldDay: true };

  const ix = tripIndex();
  const done = doneSet(today);
  const ridden = riddenSet(today);
  const { locked, info: lockInfo, prompts } = locks(today, ridden);
  // F5: rides the height check rules out are set aside like a locked ride.
  const short = tooShortFor(S.rideinfo?.rides, S.settings.heightIn);
  for (const [id, h] of Object.entries(short)) {
    locked[id] = `height minimum ${h} in.`;
    delete lockInfo[id]; // too short beats "waiting on a test": nothing to wait for
  }
  const ridesById = new Map(snap.rides.map((r) => [r.id, r]));
  const headingTo = S.stickyId;

  // You can only be in the park if you scanned in: seeing the phone inside today's park counts.
  if (!S.ll.scannedAt && tp.park && w.mode === 'gps' && w.posPark === tp.park) {
    S.ll = { ...S.ll, scannedAt: now };
    saveLL();
  }
  const conv = convertDown(S.ll, ridesById, now);
  if (conv.converted.length) {
    S.ll = conv.st;
    saveLL();
  }

  const ctx = {
    now,
    pos: w.pos,
    posPark: w.posPark,
    gates: w.gates,
    wanted: S.wanted,
    done,
    snoozed: S.snoozed,
    speed: S.settings.speed,
    hopMinutes: S.settings.hopMinutes,
    parks: snap.parks,
    todayPark: tp.park,
    bias: rideBias(today, { locked, info: lockInfo, ridden, now, short }),
    typical: ix.typical,
    locked,
    lanes: heldBookings(S.ll),
  };
  const res = plan(snap.rides, ctx, { stickyId: S.stickyId });
  S.stickyId = res.ranked[0]?.ride.id ?? null;
  save('sticky', { id: S.stickyId, at: now });
  const live = new Set(snap.rides.map((r) => r.id));
  const missing = [...S.wanted]
    .filter((id) => !live.has(id) && !done.has(id))
    .map((id) => catalogRide(id))
    .filter((r) => r && inToday(r, tp.park));
  // A ride only waiting on a test ride (Big Thunder after the Pirates drop test) can still be booked:
  // the test comes first anyway, and a booking you don't use can be cancelled.
  // Only when every test ride in its chain can be ridden today, in today's park.
  const chain = (id, seen = new Set()) => {
    for (const g of lockInfo[id]?.after ?? []) if (!seen.has(g)) chain(g, seen.add(g));
    return seen;
  };
  const waiting = (id) =>
    lockInfo[id]?.kind === 'wait' &&
    !short[id] &&
    [...chain(id)].every((g) => (!tp.park || catalogRide(g)?.park === tp.park) && (!locked[g] || lockInfo[g]?.kind === 'wait'));
  const advice = adviseMulti(snap.rides, { ...ctx, priority: ix.prio, locked: new Set(Object.keys(locked).filter((id) => !waiting(id))), stats: statsFor(tp.park, today), hourOf: parkHour }, S.ll);
  for (const rec of advice.recs) {
    if (!waiting(rec.ride.id)) continue;
    const gates = [...chain(rec.ride.id)].reverse().map((id) => nameOf(id, snap));
    rec.cond = `only if ${gates.join(' and ')} ${gates.length > 1 ? 'go' : 'goes'} well first`;
    rec.reason += `, ${rec.cond}`;
    rec.value *= 0.5; // a 👎 on the test would waste the booking, as in the day plan
  }
  advice.recs.sort((a, b) => b.value - a.value);
  const next = nextBooking(S.ll, now);

  // Shows today, both parks (the Friday chooser compares them); the rest of the app uses today's park.
  const showsAll = showsToday((S.data.tpw?.data?.liveData ?? []).filter((e) => e?.entityType === 'SHOW'), parkOfId, now);
  const shows = showsAll.filter((x) => !tp.park || x.park === tp.park);

  // Arrived: the phone is inside today's park, so the arrival plan has done its job.
  if (S.arrival && w.mode === 'gps' && tp.park && w.posPark === tp.park) {
    S.arrival = null;
    save('arrival', null);
  }

  // Reminders.
  const inPark = snap.rides.filter((r) => inToday(r, tp.park));
  // Track every ride's status (both parks, so switching today's park doesn't compare against a
  // look from hours ago), but only rides on the list in today's park can alert, and never rides
  // the plan has set aside.
  const inParkIds = new Set(inPark.map((r) => r.id));
  const st = statusAlerts({
    rides: snap.rides,
    prev: S.prevStatus.status,
    wanted: new Set([...S.wanted].filter((id) => inParkIds.has(id))),
    done,
    skip: new Set([...Object.keys(locked), ...Object.keys(S.snoozed)]),
    headingTo,
    nextBest: res.ranked[0]?.ride ?? null,
    now,
  });
  S.prevStatus = { day: today, status: { ...S.prevStatus.status, ...st.status } };
  save('prevStatus', S.prevStatus);
  // Rides near the castle pause for fireworks and restart one by one over the next hour: that's
  // not news, so "back up" stays quiet for 75 minutes after a fireworks start in today's park.
  const afterFireworks = shows.some((x) => x.kind === 'fireworks' && x.times.some((t) => t <= now && now - t < 75 * MIN));
  const statusNews = afterFireworks ? st.alerts.filter((a) => a.kind !== 'up') : st.alerts;
  const today_ll = llOn(today);
  fireAlerts([
    ...laneAlerts(S.ll.bookings, now, (id) => nameOf(id, snap)),
    ...bookNextAlert({ llOn: today_ll, next, recs: advice.recs }),
    ...lastChanceAlerts({ rides: inPark, wanted: S.wanted, done, priority: { ...ix.filePrio, ...Object.fromEntries(Object.entries(ix.prio).filter(([, p]) => p === 'must')) }, locked: new Set(Object.keys(locked)), now }),
    ...showAlerts(shows, now, wantsShow),
    ...statusNews,
  ]);
  return { ...base, res, missing, advice, next, due: dueBookings(S.ll, now), prompts, ctx, ridesById, done, llOn: today_ll, shows, showsAll, short, lockInfo };
}

// ---------- render: chips ----------

/** When the waits being shown were fetched: Knott's has its own feed. */
function snapAt(c) {
  return c.tp?.park === 'KBF' && c.snap?.atKBF != null ? c.snap.atKBF : c.snap?.at;
}
/** Today's rides: today's park, or both Disney parks when hopping (Knott's is a separate day). */
function inToday(r, park) {
  return park ? r.park === park : r.park !== 'KBF';
}

function renderChips(now, c) {
  const { snap, w } = c;
  const el = document.getElementById('chips');
  let dataChip;
  if (!snap) {
    dataChip = S.fetching ? `<span class="dot"></span>Getting wait times…` : `<span class="dot bad"></span>No wait times yet. Tap to retry`;
  } else {
    const age = now - snapAt(c);
    const cls = age > 30 * MIN ? 'bad' : age > 10 * MIN ? 'warn' : 'good';
    const ageText = age < MIN ? 'just now' : `${fmtAge(age)} old`;
    const label = S.offline ? 'Offline, waits' : snap.source === 'qt' ? 'Backup waits' : 'Waits';
    dataChip = `<span class="dot ${cls}"></span>${label} ${ageText}${S.fetching ? ' · updating' : ''}`;
  }
  const placeText = w.posPark ? `In ${PARK[w.posPark]}` : 'Outside the parks';
  let locChip;
  if (w.mode === 'gps') {
    const acc = S.geo.acc != null ? ` ±${Math.round(S.geo.acc)} m` : '';
    locChip = `<span class="dot good"></span>${esc(placeText)}${acc}`;
  } else if (w.mode === 'coarse') {
    locChip = `<span class="dot warn"></span>Rough location ±${Math.round(S.geo.acc)} m`;
  } else if (w.mode === 'override') {
    locChip = `<span class="dot warn"></span>Test location · ${esc(w.posPark ? PARK[w.posPark] : 'outside the parks')}`;
  } else if (w.mode === 'far') {
    locChip = `<span class="dot warn"></span>Not at the resort · walks from the entrance`;
  } else {
    const gate = `${PARK_SHORT[S.settings.start] ?? 'Disneyland'} gate`;
    locChip = S.geo.status === 'pending' ? `<span class="dot"></span>Finding you…` : `<span class="dot bad"></span>${S.geo.status === 'denied' ? 'Location blocked' : 'No location'} · walks from ${esc(gate)}`;
  }
  const parkChip = c.tp?.park ? `<button type="button" class="chip" data-act="tab" data-tab="more">Today: ${esc(PARK[c.tp.park])}</button>` : '';
  el.innerHTML =
    `<button type="button" class="chip" data-act="refresh" aria-label="Refresh wait times">${dataChip}</button>` +
    `<button type="button" class="chip" data-act="locate" aria-label="Update location">${locChip}</button>` +
    parkChip;
  // The chips can wrap; keep the Rides search box stuck just below them.
  document.documentElement.style.setProperty('--chips-h', `${el.offsetHeight}px`);
}

// ---------- render: Next ----------

function noteBar() {
  return S.note ? `<p class="notebar" role="status">${esc(S.note)}</p>` : '';
}

function pendingTripCard() {
  const t = S.pendingTrip;
  if (!t) return '';
  const days = t.days.map((d) => `${fmtDay(d.date)} ${d.park ? PARK[d.park] : '(choose)'}`).join(', ');
  return `<section class="card accent"><div class="eyebrow">Trip link</div><h2>Load this trip on this phone?</h2>
    <p>${t.rides.length} rides, ${t.avoid.length} to avoid. ${esc(days)}.</p>
    <p class="muted small">It replaces the ride list on this phone. Nothing is uploaded.</p>
    <div class="actions"><button type="button" class="primary" data-act="trip-accept">Load trip</button><button type="button" data-act="trip-reject">Not now</button></div></section>`;
}

function parkChoiceCard(c) {
  if (!c.tp.needsChoice) return '';
  const ix = tripIndex();
  const weight = { must: 3, high: 2, medium: 1, low: 0.5, conditional: 1 };
  const score = { DL: 0, DCA: 0 };
  const left = { DL: [], DCA: [] };
  for (const r of ix.trip?.rides ?? []) {
    if (!r.tpwId || c.done?.has(r.tpwId) || !S.wanted.has(r.tpwId) || c.short?.[r.tpwId]) continue;
    score[r.park] += weight[ix.prio[r.tpwId] ?? r.priority] ?? 1;
    left[r.park].push(r);
  }
  const favs = favorites({ ratings: S.ratings, ridden: riddenSet(c.today), ridesById: c.ridesById ?? new Map((c.snap?.rides ?? []).map((r) => [r.id, r])) });
  for (const x of favs) score[x.ride.park] += x.stars >= 5 ? 1 : 0.5;
  const line = (p) => {
    const must = left[p].filter((r) => ix.prio[r.tpwId] === 'must').map((r) => r.name);
    const f = favs.filter((x) => x.ride.park === p).map((x) => `${x.ride.name} ${x.stars}★`);
    return `${left[p].length} rides left${must.length ? `, must-dos: ${must.slice(0, 4).join(', ')}${must.length > 4 ? '…' : ''}` : ''}${f.length ? `; favorites to ride again: ${f.slice(0, 3).join(', ')}` : ''}`;
  };
  const hours = (p) => {
    const close = c.snap?.parks?.[p]?.close ?? (S.llstats?.hours?.[`${c.today}|${p}`]?.close ? Date.parse(S.llstats.hours[`${c.today}|${p}`].close) : null);
    return close ? ` Open until ${fmtTime(close)}.` : '';
  };
  // Usual midday waits on this weekday for the rides left, from learned history.
  const usual = (p) => {
    const st = S.llstats ? laneStats(S.llstats, p, weekdayOf(c.today)) : null;
    // History only covers Lightning Lane rides, and blends all days until a weekday has three.
    const hits = left[p].map((r) => st?.get(r.tpwId)).filter(Boolean);
    const vals = hits.map((x) => [12, 13, 14, 15, 16].map((h) => x.standby[h]).filter(Number.isFinite)).filter((a) => a.length).map((a) => a.reduce((s, v) => s + v, 0) / a.length);
    return vals.length ? { avg: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length), sameDay: hits.some((x) => x.sameWeekday) } : null;
  };
  // Evening shows only (a 2:45 pm parade isn't "tonight").
  const tonight = (p) =>
    (c.showsAll ?? [])
      .filter((x) => x.park === p && x.major)
      .map((x) => ({ name: x.name, t: x.times.filter((t) => parkHour(t) >= 17) }))
      .filter((o) => o.t.length)
      .map((o) => `${o.name} ${fmtTime(o.t[o.t.length - 1])}`);
  for (const p of ['DL', 'DCA']) {
    const u = usual(p);
    if (u != null) score[p] -= u.avg / 30; // busier lines for what's left count against a park
    const close = c.snap?.parks?.[p]?.close;
    if (close) score[p] += Math.max(0, (close - parkTime(c.today, '20:00')) / 3600e3) * 0.5; // later close = more time
  }
  const extra = (p) => {
    const u = usual(p);
    const t = tonight(p);
    return `${u != null ? ` Lines for the Lightning Lane rides left usually average about ${u.avg} min at midday${u.sameDay ? ' on this weekday' : ' (the past week)'}.` : ''}${t.length ? ` Tonight: ${t.join('; ')}.` : ''}`;
  };
  const pick = score.DL >= score.DCA ? 'DL' : 'DCA';
  void ix;
  return `<section class="card accent"><div class="eyebrow">${esc(fmtDay(c.today))}</div><h2>Which park today?</h2>
    <p><b>Disneyland:</b> ${esc(line('DL'))}.${esc(hours('DL'))}${esc(extra('DL'))}</p>
    <p><b>California Adventure:</b> ${esc(line('DCA'))}.${esc(hours('DCA'))}${esc(extra('DCA'))}</p>
    <p class="muted small">Suggested: ${esc(PARK[pick])}. It weighs what's left on your list (must-dos count most), your favorites, the usual lines for this weekday and how late each park is open.</p>
    <div class="actions"><button type="button" class="${pick === 'DL' ? 'primary' : ''}" data-act="daypark" data-v="DL">Disneyland</button>
    <button type="button" class="${pick === 'DCA' ? 'primary' : ''}" data-act="daypark" data-v="DCA">California Adventure</button></div></section>`;
}

function dueCards(c) {
  return c.due
    .map((b) => {
      const ride = c.ridesById.get(b.rideId) ?? catalogRide(b.rideId);
      const name = ride?.name ?? 'your ride';
      if (b.multiExp) {
        const opts = multiExpOptions(c.snap.rides, { ...c.ctx, avoid: new Set(tripIndex().avoid.keys()) }, b.rideId).slice(0, 4);
        return `<section class="card lane"><div class="eyebrow">⚡ Lightning Lane changed</div>
        <h2>${esc(name)} broke down</h2>
        <p>Disney turns your booking into a <b>Multiple Experience</b> pass. Use it once at any other Multi Pass ride here today, or at ${esc(name)} if it reopens.</p>
        <ul class="list">${opts
          .map(
            (o) => `<li><div class="grow"><div class="name">${esc(o.ride.name)}</div><div class="sub">${o.wait} min standby now${o.onList ? ' · on your list' : ''}</div></div>
            <button type="button" data-act="lane-used-at" data-id="${esc(b.id)}" data-ride="${esc(o.ride.id)}">Used here</button></li>`,
          )
          .join('')}</ul>
        <div class="actions"><button type="button" data-act="lane-used" data-id="${esc(b.id)}">Used it at ${esc(name)}</button><button type="button" data-act="lane-remove" data-id="${esc(b.id)}">Remove</button></div></section>`;
      }
      const open = c.ctx.now >= b.start;
      const walk = ride && Number.isFinite(ride.lat) && c.w.pos ? Math.max(1, Math.round(walkMinutes(c.w.pos, ride, { speed: S.settings.speed }))) : null;
      const down = ride?.status === 'DOWN';
      const url = mapsUrl(ride);
      return `<section class="card lane"><div class="eyebrow">⚡ ${b.kind === 'single' ? 'Single Pass' : 'Lightning Lane'} ${open ? 'open now' : `opens ${esc(fmtTime(b.start))}`}</div>
        <h2>${esc(name)}</h2>
        <p>Return ${esc(fmtTime(b.start))} to ${esc(fmtTime(b.end))}${walk ? ` · ${walk} min walk` : ''}.${down ? ' <b>Down right now.</b> If it stays down in your window, this becomes a Multiple Experience pass.' : ''}</p>
        <div class="actions"><button type="button" class="primary" data-act="lane-used" data-id="${esc(b.id)}">✓ We tapped in</button>
        ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Walk there ↗</a>` : ''}</div></section>`;
    })
    .join('');
}

function llDecisionBanner(c) {
  if (c.llOn !== null || !c.tp.park || c.tp.park === 'KBF') return '';
  const p = lanePlan(c.today, c.tp.park, c.snap);
  if (p && (p.lateToday || (p.rides.length && !p.bookings.length))) return '';
  const take = p ? ` Our take: <b>${VERDICT[p.verdict]}</b>${p.rides.length ? `, saves about ${esc(hmin(p.saved))} for $${esc(p.cost)}` : ''}.` : '';
  return `<section class="card book"><div class="eyebrow">⚡ Lightning Lane Multi Pass</div><p>Using Multi Pass today?${take}</p>
    <div class="actions"><button type="button" data-act="llday" data-date="${esc(c.today)}" data-v="on">We have it</button>
    <button type="button" data-act="llday" data-date="${esc(c.today)}" data-v="off">Not today</button>
    <button type="button" data-act="tab" data-tab="lanes">Why</button></div></section>`;
}

function bookBanner(c) {
  if (!c.advice || !c.next || c.llOn !== 'on') return '';
  const top = c.advice.recs[0];
  if (c.next.why === 'scan') {
    if (!top || !(S.trip || S.ll.bookings.length)) return '';
    return `<p class="banner">⚡ After you scan in, book <b>${esc(top.ride.name)}</b> first${top.cond ? ` (${esc(top.cond)})` : ''}. <button type="button" class="linkish" data-act="scan-in">We're in the park</button></p>`;
  }
  if (c.next.why === 'wait') {
    const last = c.next.last ? nameOf(c.next.last.rideId, c.snap) : '';
    return `<p class="banner muted">⚡ Next Lightning Lane booking at ${esc(fmtTime(c.next.at))}${last ? `, or as soon as you tap in at ${esc(last)}` : ''}.</p>`;
  }
  if (!top) return '';
  return `<section class="card book"><div class="eyebrow">⚡ Book your next Lightning Lane now</div>
    <h3>${esc(top.ride.name)} ${prioChip(top.ride.id)}</h3><p class="reason">${esc(top.reason)}</p>
    <div class="actions"><button type="button" data-act="tab" data-tab="lanes">See options and log it</button></div></section>`;
}

function starButtons(id, current, size = '') {
  return `<div class="stars ${size}" role="group" aria-label="Rate out of 5">${[1, 2, 3, 4, 5]
    .map((n) => `<button type="button" class="star ${current >= n ? 'on' : ''}" data-act="rate" data-id="${esc(id)}" data-v="${n}" aria-label="${n} star${n > 1 ? 's' : ''}" aria-pressed="${current === n}">★</button>`)
    .join('')}</div>`;
}

function rateCard(c) {
  const id = S.rateNext;
  if (!id) return '';
  const name = nameOf(id, c.snap);
  const cur = S.ratings[id]?.stars ?? 0;
  return `<section class="card accent"><div class="eyebrow">Rate it</div><h3>How was ${esc(name)}?</h3>
    ${starButtons(id, cur, 'big')}
    <p class="muted small">4 or 5 stars puts it on your "ride again" list, today or another day.</p>
    <div class="actions"><button type="button" data-act="rate-skip">Skip</button></div></section>`;
}

function favoritesList(c) {
  const fav = favorites({ ratings: S.ratings, ridden: riddenSet(c.today), ridesById: c.ridesById, park: c.tp.park, again: S.again[c.today] ?? [] }).slice(0, 6);
  return rowList(
    'Loved it? Ride again',
    fav.map((x) => {
      const w = x.ride.status === 'OPERATING' ? (Number.isFinite(x.ride.wait) ? `${x.ride.wait} min wait now` : 'open') : x.ride.status === 'DOWN' ? 'down right now' : 'closed now';
      const n = S.counts[x.id] ?? 1;
      return `<li><div class="grow"><div class="name">${esc(x.ride.name)} <span class="starline">${starText(x.stars)}</span></div><div class="sub">${esc(w)} · ridden ${n}×</div></div>
        <button type="button" data-act="again" data-id="${esc(x.id)}">Ride again</button></li>`;
    }),
  );
}

function briefCard(c) {
  const td = tripDay(S.trip, c.today);
  if (!td || S.briefDone[c.today] || c.ctx.now >= parkTime(c.today, '12:00')) return '';
  const park = c.tp.park;
  const hours = park && c.snap?.parks?.[park]?.close ? `Open until ${fmtTime(c.snap.parks[park].close)}.` : '';
  // Before the park opens (or with no hours yet) every ride reads CLOSED: only refurbishments count then.
  const parkOpen = park ? c.snap?.parks?.[park]?.open : null;
  const opened = parkOpen != null && c.ctx.now >= parkOpen;
  const closed = (c.res?.excluded ?? [])
    .filter((x) => x.why === 'refurb' || (opened && x.why === 'closed' && !/^opens/.test(x.detail ?? '')))
    .map((x) => x.ride.name);
  const majors = (c.shows ?? []).filter((x) => x.major).map((x) => `${x.name} ${x.times.map((t) => fmtTime(t)).join(' and ')}`);
  const lp = park ? lanePlan(c.today, park, c.snap) : null;
  const ll = c.llOn === 'on' ? 'You have Multi Pass today.' : c.llOn === 'off' ? 'No Multi Pass today.' : lp ? `Multi Pass today: ${VERDICT[lp.verdict]}${lp.rides.length ? `, saves about ${hmin(lp.saved)} for $${lp.cost}` : ''}.` : '';
  const lines = [
    park ? `<b>${esc(PARK[park])}</b> today. ${esc(hours)}` : '<b>Pick today\'s park</b> above.',
    closed.length ? `Closed on your list: ${esc(closed.join(', '))}.` : 'Everything on your list is scheduled to run.',
    majors.length ? `Shows: ${esc(majors.join('; '))}.` : '',
    esc(ll),
  ].filter(Boolean);
  return `<section class="card accent brief"><div class="eyebrow">Good morning · ${esc(fmtDay(c.today))}</div>
    ${lines.map((l) => `<p>${l}</p>`).join('')}
    <div class="actions"><button type="button" class="primary" data-act="arrive-start">We're on our way</button><button type="button" data-act="brief-ok">Got it</button></div></section>`;
}

function arrivalActive(c) {
  return Boolean(S.arrival && S.arrival.day === c.today && c.tp.park);
}

function arrivalCard(c) {
  if (!arrivalActive(c)) return '';
  const park = c.tp.park;
  const gate = c.w.gates?.[park];
  const eta = Math.max(c.ctx.now, S.arrival.at + (S.arrival.travel ?? 20) * MIN);
  const ap = gate ? arrivalPlan(c.snap.rides, c.ctx, { park, gate, eta }) : null;
  const lands = ap ? [...new Set(ap.steps.map((e) => landOf(e.ride)).filter(Boolean))] : [];
  const steps = ap
    ? `<ol class="list">${ap.steps
        .map((e) => `<li><div class="grow"><div class="name">${esc(e.ride.name)} ${prioChip(e.ride.id)}</div><div class="sub">${esc(landOf(e.ride) ?? '')}${landOf(e.ride) ? ' · ' : ''}~${Math.round(e.waitArr ?? e.wait ?? 0)} min wait when you get there</div></div></li>`)
        .join('')}</ol>`
    : `<p class="muted">Nothing on your list is expected to be running when you get there${c.snap.parks?.[park]?.close && eta >= c.snap.parks[park].close ? `: the park closes at ${esc(fmtTime(c.snap.parks[park].close))}` : ''}.</p>`;
  const recs = c.advice?.recs ?? [];
  let ll = '';
  // Multi Pass rules: the first booking comes with scan-in; after that, the next one is allowed at
  // tap-in or 2 hours after booking. Don't suggest booking before that.
  const nextAt = c.next?.why === 'wait' ? c.next.at : null;
  if (c.llOn !== 'off' && recs.length && nextAt != null && nextAt > eta) {
    ll = `<p class="ll"><b>Next Lightning Lane booking:</b> allowed from ${esc(fmtTime(nextAt))}. Then ${esc(recs[0].ride.name)} looks best.</p>`;
  } else if (c.llOn !== 'off' && recs.length) {
    const lead = c.llOn === 'on' ? 'As you walk in, book with Lightning Lane:' : 'If you buy Multi Pass today, book this first as you walk in:';
    // Today's return time is from now; booked on arrival, an early window is simply open.
    const why = (r) => (r.start <= eta ? r.reason.replace(/^return ~[^,]+/, 'usable as soon as you book') : r.reason);
    ll = `<p class="ll"><b>${esc(lead)}</b> ${esc(recs[0].ride.name)} (${esc(why(recs[0]))})${recs[1] ? `, or ${esc(recs[1].ride.name)}` : ''}.</p>`;
  }
  return `<section class="card top arrival"><div class="eyebrow">On our way · arriving about ${esc(fmtTime(eta))}</div>
    <h2>${lands.length ? `Start in ${esc(lands[0])}` : `Head for ${esc(PARK[park])}`}</h2>
    ${lands.length > 1 ? `<p class="muted">Then ${esc(lands.slice(1).join(', then '))}.</p>` : ''}
    ${ap && ap.at > eta ? `<p class="muted">The park opens at ${esc(fmtTime(ap.at))}${ap.ropeDrop ? '. This is the order to take rides as they open' : ', so this starts from then'}.</p>` : ''}
    ${steps}${ll}
    <p class="muted small">A sense of direction, not a fixed plan: once you're inside, the app re-plans after every ride. Travel time from here:</p>
    ${seg('arrive-travel', S.arrival.travel ?? 20, [[10, '10 min'], [20, '20 min'], [30, '30 min'], [45, '45 min']])}
    <div class="actions"><button type="button" class="primary" data-act="arrive-done">We're here</button><button type="button" data-act="arrive-cancel">Cancel</button></div></section>`;
}

function onOurWayBanner(c) {
  if (arrivalActive(c) || !c.tp.park || (['gps', 'override'].includes(c.w.mode) && c.w.posPark === c.tp.park)) return '';
  if (tripDay(S.trip, c.today) && !S.briefDone[c.today] && c.ctx.now < parkTime(c.today, '12:00')) return ''; // the briefing has the button
  return `<p class="banner">Heading to ${esc(PARK[c.tp.park])}? <button type="button" class="linkish" data-act="arrive-start">We're on our way</button></p>`;
}

function showsSection(c) {
  const list = (c.shows ?? []).filter((x) => nextTime(x, c.ctx.now) != null).slice(0, 10);
  if (!list.length) return '';
  const statsToday = statsFor(c.tp.park, c.today);
  // Rides you can actually go on now: not done, not locked (ladder or height), in today's park.
  const wantedHere = [...S.wanted].filter((id) => !c.done.has(id) && !c.ctx.locked?.[id] && (!c.tp.park || c.ridesById.get(id)?.park === c.tp.park));
  const rows = list.map((x) => {
    const t = nextTime(x, c.ctx.now);
    const later = x.times.filter((y) => y > t).map((y) => fmtTime(y));
    const on = wantsShow(x);
    const leaveAt = t - x.lead * MIN;
    const leave = x.lead < 25 ? '' : t <= c.ctx.now ? ' Starting now.' : leaveAt > c.ctx.now ? ` Leave by ${fmtTime(leaveAt)} for a spot.` : ' Head there now for a spot.';
    let empties = '';
    if (x.kind === 'fireworks' || x.kind === 'nighttime') {
      const e = ridesThatEmpty(statsToday, wantedHere, parkHour(t)).slice(0, 3);
      if (e.length) empties = `<div class="sub">Lines usually drop during it at: ${e.map((y) => `${esc(nameOf(y.id, c.snap))} (${Math.round(y.before)} to ${Math.round(y.during)} min)`).join(', ')}.</div>`;
    }
    return `<li><div class="grow"><div class="name">${esc(x.name)}</div><div class="sub">${esc(fmtTime(t))}${later.length ? `, again ${esc(later.join(', '))}` : ''}.${esc(leave)}${x.tip ? ' ' + esc(x.tip) : ''}</div>${empties}</div>
      <button type="button" data-act="show-remind" data-name="${esc(x.name)}" aria-pressed="${on}" aria-label="Remind me">${on ? '🔔' : '🔕'}</button></li>`;
  });
  return `<details class="shows"><summary>Shows today (${list.length})</summary><ul class="list">${rows.join('')}</ul>
    <p class="muted small">🔔 means you'll get a reminder in time to find a spot.</p></details>`;
}

/** Every ride a 👎 on this gate would skip: anything whose ladder runs through it, still picked and not ridden. */
function skippedBy(gateKey, c) {
  const ix = tripIndex();
  const gates = ladderGates(ix.trip);
  const out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [k, gs] of gates) if (!out.has(k) && gs.some((g) => g === gateKey || out.has(g))) out.add(k), (grew = true);
  }
  return [...out].map((k) => ix.byKey.get(k)).filter((r) => r?.tpwId && S.wanted.has(r.tpwId) && !c.done?.has(r.tpwId));
}

function gatePromptCards(c) {
  const dropKey = tripX().dropKey;
  return c.prompts
    .map(({ gate, unlocks }) =>
      gate.key === dropKey
        ? `<section class="card accent"><div class="eyebrow">Drop test</div><h3>Did the drops in the dark on ${esc(gate.name)} go well?</h3>
      <p class="muted small">👍 opens the next step for ${esc(unlocks.map((r) => r.name).join(' and '))}. 👎 skips ${esc(skippedBy(gate.key, c).map((r) => r.name).join(', ') || 'them')}, the rides your trip file put after it (you can still unlock any of them on the Rides tab).</p>
      ${unlocks.map((u) => c.ridesById?.get(u.tpwId)).filter((r) => r?.ll?.singleState != null).map((r) => `<p class="small">${esc(r.name)} right now: ${r.ll.single ? `Single Pass ${esc(r.ll.singlePrice ?? '')}, return ~${esc(fmtTime(r.ll.single.start))}` : r.ll.singleState === 'FINISHED' ? 'Single Pass sold out today' : 'Single Pass not on sale'}${Number.isFinite(r.wait) ? `, standby ${r.wait} min` : ''}.</p>`).join('')}
      <div class="actions"><button type="button" data-act="gate" data-key="${esc(gate.key)}" data-v="yes">👍 Liked the drops</button>
      <button type="button" data-act="gate" data-key="${esc(gate.key)}" data-v="no">👎 Not the drops</button></div></section>`
        : `<section class="card accent"><div class="eyebrow">Ladder</div><h3>How did ${esc(gate.name)} go?</h3>
      <p class="muted small">Next on the ladder: ${esc(unlocks.map((r) => r.name).join(', '))}.</p>
      <div class="actions"><button type="button" data-act="gate" data-key="${esc(gate.key)}" data-v="yes">👍 Went well</button>
      <button type="button" data-act="gate" data-key="${esc(gate.key)}" data-v="no">👎 Not for us</button></div></section>`,
    )
    .join('');
}

/**
 * Single Pass or standby for one ride, in words: today's advice, when the pass usually sells out, and,
 * for a ride still waiting on its test ride, what to do until then.
 */
function singleAdvice(r, c, now) {
  const stats = statsFor(r.park, c.today)?.get(r.id);
  const adv = singlePassAdvice(r, { now, stats, hourOf: parkHour, close: finalClose(r, now) });
  const goneH = stats && r.ll?.singleState !== 'FINISHED' ? usuallyGoneBy(stats, parkHour(now) + 1) : null;
  const gone = goneH != null ? ` It usually sells out by about ${goneH === 12 ? '12 pm' : goneH > 12 ? `${goneH - 12} pm` : `${goneH} am`}.` : '';
  const wait = c.lockInfo?.[r.id]?.kind === 'wait' ? c.ctx.locked[r.id] : null;
  if (wait) {
    const text = `Not yet: ${wait}. Do the test first, then decide; buying before you know risks paying for a ride you skip.${gone}`;
    return { kind: 'wait', text };
  }
  return { ...adv, text: adv.text + (adv.kind === 'buy' ? gone : '') };
}

/** Rise of the Resistance just came off the drop test: pass or line, right on the Next screen. */
function unlockedSingleCard(c) {
  const tx = tripX();
  const rise = tx.riseKey ? tripIndex().byKey.get(tx.riseKey) : null;
  if (!rise?.tpwId || S.gate[tx.dropKey] !== 'yes') return '';
  const r = c.ridesById?.get(rise.tpwId);
  if (!r || !S.wanted.has(r.id) || c.done.has(r.id) || c.ctx.locked?.[r.id] || r.ll?.singleState == null) return '';
  if ((c.tp.park && r.park !== c.tp.park) || S.ll.bookings.some((b) => b.rideId === r.id && b.status !== 'cancelled')) return '';
  const now = c.ctx.now;
  const adv = singleAdvice(r, c, now);
  const avail = r.ll.single ? `Single Pass ${r.ll.singlePrice ?? ''}, return ~${fmtTime(r.ll.single.start)}` : r.ll.singleState === 'FINISHED' ? 'Single Pass sold out today' : 'Single Pass not on sale right now';
  const standby = Number.isFinite(r.wait) ? ` · standby ${r.wait} min` : '';
  const btn = r.ll.single ? `<button type="button" data-act="book-open" data-id="${esc(r.id)}" data-kind="single" data-t="${esc(hhmm(r.ll.single.start))}">I bought it</button>` : '';
  const form = S.bookForm?.rideId === r.id && S.bookForm.kind === 'single' ? bookForm(c, { ride: r, kind: 'single' }) : '';
  return `<section class="card book"><div class="eyebrow">⚡ ${esc(r.name)}: pass or line?</div>
    <p>${esc(avail)}${esc(standby)}</p><p class="advice advice-${esc(adv.kind)}">${esc(adv.text)}</p>
    <p class="muted small">A Single Pass is its own purchase in the Disneyland app (Multi Pass doesn't cover this ride). It breaks down often: if it's down during your return window, ask a cast member at the Lightning Lane entrance what your pass is good for.</p>
    ${form || `<div class="actions">${btn}</div>`}</section>`;
}

/** "We're hot": one tap favors indoor and water rides for an hour and lists air-conditioned spots nearby. */
function heatCard(c) {
  const now = c.ctx?.now ?? Date.now();
  if (!heatOn(S.heat, now)) {
    return `<div class="heat-row"><button type="button" data-act="heat" aria-pressed="false">🥵 We're hot</button>
      <span class="muted small">Indoor and water rides first for an hour</span></div>`;
  }
  const spots = coolSpots(S.catalog?.rides ?? [], {
    park: c.tp.park,
    pos: c.w?.pos,
    walk: (pos, r) => Math.max(1, Math.round(walkMinutes(pos, r, { speed: S.settings.speed }))),
    skip: new Set([...tripIndex().avoid.keys(), ...S.wanted]),
  });
  const live = (id) => c.ridesById?.get(id);
  const rows = spots
    .filter((x) => !['CLOSED', 'REFURBISHMENT', 'DOWN'].includes(live(x.r.id)?.status))
    .map((x) => `<li>${esc(x.r.name)}${x.walk != null ? ` · ${x.walk} min walk` : ''}</li>`)
    .join('');
  return `<section class="card heat" aria-label="Cooling off">
    <div class="eyebrow">Cooling off until ${esc(fmtTime(S.heat.until))}</div>
    <p>Picks favor indoor, air-conditioned rides and water rides; long queues in the sun drop back.</p>
    ${rows ? `<p class="small"><b>Air-conditioned spots nearby, no ride needed:</b></p><ul class="small">${rows}</ul>` : ''}
    <p class="muted small">Free cups of ice water at any quick-service counter. Hottest stretch is about 1 to 5 pm: indoor rides then, outdoor queues in the morning and evening.</p>
    <div class="actions"><button type="button" data-act="heat" aria-pressed="true">+1 hour</button><button type="button" data-act="heat-off">We've cooled off</button></div>
  </section>`;
}

function topCard(e) {
  const r = e.ride;
  const land = landOf(r);
  const url = mapsUrl(r);
  const ll = llLines(r.ll);
  return `<section class="card top" aria-label="Top pick">
  <div class="eyebrow">Ride next · ${esc(PARK_SHORT[r.park] ?? '')}${land ? ' · ' + esc(land) : ''}</div>
  <h2>${esc(r.name)} ${prioChip(r.id)}</h2>
  <div class="stats">
    <div><b>${waitBig(e)}</b><span>min wait</span></div>
    <div><b>${Math.max(1, Math.round(e.walk))}</b><span>min walk</span></div>
  </div>
  <p class="reason">${esc(e.why ?? 'Best mix of wait and walk right now')}</p>
  ${ll.length ? `<p class="ll">${ll.join(' · ')}</p>` : ''}
  ${routeLine(e)}
  ${boostLine(r.id)}
  ${expectLine(r.id)}
  ${tripNote(r.id)}
  <div class="actions">
    <button type="button" class="primary" data-act="done" data-id="${esc(r.id)}">✓ We rode it</button>
    <button type="button" data-act="snooze" data-id="${esc(r.id)}">Not now</button>
    ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Walk there ↗</a>` : ''}
  </div>
</section>`;
}

function altCard(e) {
  const r = e.ride;
  const url = mapsUrl(r);
  const ll = llLines(r.ll);
  const wait = e.flags.includes('wait-unknown') ? 'wait ?' : `${Math.round(e.waitNow)} min wait`;
  return `<section class="card alt">
  <div class="eyebrow">${esc(PARK_SHORT[r.park] ?? '')}${landOf(r) ? ' · ' + esc(landOf(r)) : ''}</div>
  <h3>${esc(r.name)} ${prioChip(r.id)}</h3>
  <div class="meta">${wait} · ${Math.max(1, Math.round(e.walk))} min walk</div>
  ${e.why ? `<p class="reason">${esc(e.why)}</p>` : ''}
  ${ll.length ? `<p class="ll">${ll.join(' · ')}</p>` : ''}
  ${routeLine(e)}
  ${boostLine(r.id)}
  ${expectLine(r.id)}
  <div class="actions">
    <button type="button" data-act="done" data-id="${esc(r.id)}">✓ Rode it</button>
    <button type="button" data-act="snooze" data-id="${esc(r.id)}">Not now</button>
    ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Walk ↗</a>` : ''}
  </div>
</section>`;
}

function rowList(title, rows) {
  if (!rows.length) return '';
  return `<h3 class="section-title">${esc(title)}</h3><ul class="list">${rows.join('')}</ul>`;
}

const doneBtn = (id, name) => `<button type="button" data-act="done" data-id="${esc(id)}" aria-label="Mark ${esc(name)} done">✓</button>`;

function restList(entries) {
  return rowList(
    'Also on your list',
    entries.map((e) => `<li><div class="grow"><div class="name">${esc(e.ride.name)} ${prioChip(e.ride.id)}</div><div class="sub">${esc(e.reason)}</div></div>${doneBtn(e.ride.id, e.ride.name)}</li>`),
  );
}

function clashList(res) {
  return rowList(
    'Would clash',
    (res.clash ?? []).map((x) => `<li><div class="grow"><div class="name">${esc(x.ride.name)} ${prioChip(x.ride.id)}</div><div class="sub">${esc(x.entry.reason)}: ${esc(x.detail)}</div></div>${doneBtn(x.ride.id, x.ride.name)}</li>`),
  );
}

function unavailableList(res, missing, c) {
  const ix = tripIndex();
  const rideList = c?.snap?.rides ?? [];
  // Never suggest a ride you've done, avoid, can't ride (height) or haven't unlocked on the ladder.
  const skipForSubs = new Set([...(c?.done ?? []), ...ix.avoid.keys(), ...Object.keys(c?.short ?? {}), ...Object.keys(c?.ctx?.locked ?? {})]);
  const rows = [
    ...res.excluded.filter((x) => x.ride).map((x) => {
      const key = ix.byTpw.get(x.ride.id)?.key;
      // A height limit can't be unlocked (the button only overrides the ladder).
      const btn = x.why === 'locked' && c?.short?.[x.ride.id]
        ? ''
        : x.why === 'locked' && key
          ? `<button type="button" data-act="unlock" data-key="${esc(key)}" data-v="yes">Unlock</button>`
          : x.why === 'lane' ? '' : doneBtn(x.ride.id, x.ride.name);
      const prio = ['must', 'high'].includes(ix.filePrio[x.ride.id]) ? ix.filePrio[x.ride.id] : ix.prio[x.ride.id];
      let alt = '';
      // Only for rides that are out (not ones that simply open later today).
      if (['down', 'closed', 'refurb', 'closes', 'unknown'].includes(x.why) && !/^opens|reopens/.test(x.detail ?? '') && (prio === 'must' || prio === 'high')) {
        const subs = similarRides(x.ride.id, { info: S.rideinfo?.rides, rides: rideList, exclude: skipForSubs, now: c.ctx?.now ?? Date.now() });
        if (subs.length) alt = `<div class="sub subs"><b>Try instead:</b> ${subs.map((y) => `${esc(y.ride.name)}${Number.isFinite(y.ride.wait) ? ` (${y.ride.wait} min)` : ''}`).join(', ')}</div>`;
      }
      return `<li><div class="grow"><div class="name">${esc(x.ride.name)} ${prioChip(x.ride.id)}</div><div class="sub">${esc(x.detail)}</div>${alt}</div>${btn}</li>`;
    }),
    ...missing.map((r) => `<li><div class="grow"><div class="name">${esc(r.name)}</div><div class="sub">no live data today</div></div>${doneBtn(r.id, r.name)}</li>`),
  ];
  return rowList('Not available now', rows);
}

function snoozedList(res) {
  return rowList(
    'Not now',
    res.snoozed.map((x) => `<li><div class="grow"><div class="name">${esc(x.ride.name)}</div><div class="sub">back on the list at ${esc(fmtTime(x.until))}</div></div><button type="button" data-act="unsnooze" data-id="${esc(x.ride.id)}">Undo</button></li>`),
  );
}

function doneList(c) {
  const ids = [...riddenSet(c.today ?? parkDayKey())].filter((id) => S.wanted.has(id));
  if (!ids.length) return '';
  const today = new Set(S.done.ids);
  const rows = ids
    .map((id) => catalogRide(id) ?? { id, name: id })
    .map((r) => `<li class="stack"><div class="row"><div class="grow"><div class="name done-name">${esc(r.name)}</div><div class="sub">${today.has(r.id) ? 'today' : 'earlier this trip'} · ridden ${S.counts[r.id] ?? 1}×</div></div><button type="button" data-act="undone" data-id="${esc(r.id)}">Undo</button></div>${starButtons(r.id, S.ratings[r.id]?.stars ?? 0)}</li>`)
    .join('');
  return `<details><summary>Done (${ids.length})</summary><ul class="list">${rows}</ul></details>`;
}

function credits(snap) {
  const qt = snap?.source === 'qt';
  return `<footer class="credits">Waits: <a href="https://themeparks.wiki" target="_blank" rel="noopener">ThemeParks.wiki</a>.
  ${qt ? '<strong>Backup waits</strong> ' : 'Land names '}<a href="https://queue-times.com/" target="_blank" rel="noopener">Powered by Queue-Times.com</a>.</footer>`;
}

/** Rides the one-tap Knott's pick adds: coasters, drops, spinners and water rides this party can ride. */
function knottsPicks() {
  const short = tooShortFor(S.rideinfo?.rides, S.settings.heightIn);
  const rides = (S.catalog?.rides ?? []).filter((r) => r.park === 'KBF' && ['thrill', 'active'].includes(feelOf(r.name)));
  return { ids: rides.filter((r) => !short[r.id]).map((r) => r.id), short: rides.filter((r) => short[r.id]) };
}

/** A Knott's day with nothing picked there yet: offer the thrill rides in one tap. */
function knottsPickCard(c) {
  if (c.tp?.park !== 'KBF' || [...S.wanted].some((id) => catalogRide(id)?.park === 'KBF')) return '';
  const { ids, short } = knottsPicks();
  const h = S.settings.heightIn;
  const heightLine = h
    ? ` Rides taller than ${h} in. are left out${short.length ? ` (${esc(short.map((r) => r.name).join(', '))})` : ''}.`
    : " Set the shortest rider's height in More to leave out rides they can't go on.";
  return `<section class="card accent"><div class="eyebrow">Knott's Berry Farm</div><h2>Pick the thrill rides?</h2>
    <p>One tap picks ${ids.length} rides: every coaster and drop first, then the spinners, swings and water rides.${heightLine}</p>
    <div class="actions"><button type="button" class="primary" data-act="kbf-pick">Pick thrill rides</button><button type="button" data-act="tab" data-tab="rides">Choose myself</button></div></section>`;
}

function renderNext(now, c) {
  const { snap, res, missing, oldDay } = c;
  const head = noteBar() + pendingTripCard();
  if (!S.catalog) return `<p class="muted">Loading the ride list…</p>`;
  const kbf = knottsPickCard(c);
  if (kbf) return head + kbf + credits(snap);
  if (S.wanted.size === 0) {
    return `${head}<div class="card empty"><h2>What do you want to ride today?</h2>
      <p class="muted">Pick your rides, or load your trip file in More. Then this screen tells you which one to do next.</p>
      <button type="button" class="primary" data-act="tab" data-tab="rides">Pick rides</button></div>${credits(snap)}`;
  }
  if (!snap) {
    return `${head}<div class="card empty"><h2>No wait times yet</h2>
      <p class="muted">The phone hasn't reached the wait-time service yet. It keeps trying every minute.</p>
      <button type="button" data-act="refresh">Try now</button></div>${credits(snap)}`;
  }
  if (oldDay) {
    return `${head}<div class="card empty"><h2>No waits for today yet</h2>
      <p class="muted">The last wait times on this phone are from ${esc(fmtAge(now - snapAt(c)))} ago, a previous park day, so nothing is ranked from them. It keeps trying every minute.</p>
      <button type="button" data-act="refresh">Try now</button></div>${credits(snap)}`;
  }
  let html = head + parkChoiceCard(c);
  if (c.tp.needsChoice) return html + credits(snap);
  html += briefCard(c) + rateCard(c) + dueCards(c) + gatePromptCards(c) + unlockedSingleCard(c) + llDecisionBanner(c) + bookBanner(c) + onOurWayBanner(c);
  html += heatCard(c);
  const [top, ...others] = res.ranked;
  if (arrivalActive(c)) {
    html += arrivalCard(c);
  } else if (top) {
    html += (c.due.length ? '<p class="or">Or ride standby</p>' : '') + topCard(top);
    const alts = others.slice(0, 2);
    if (alts.length) html += `<p class="or">Or</p>` + alts.map(altCard).join('');
    html += restList(others.slice(2));
  } else if (res.ropeDrop) {
    const rd = res.ropeDrop;
    html += `<div class="card"><div class="eyebrow">Before opening</div>
      <h2>Rides open at ${esc(fmtTime(rd.at))}</h2>
      <p class="muted">Start with these, in this order. Waits are the usual ones for opening time.</p>
      <ol class="list">${rd.ranked.slice(0, 3).map((e) => `<li><div class="grow"><div class="name">${esc(e.ride.name)} ${prioChip(e.ride.id)}</div><div class="sub">${esc(e.reason)}</div></div></li>`).join('')}</ol></div>`;
  } else {
    const left = [...S.wanted].filter((id) => !c.done.has(id) && (!catalogRide(id) || inToday(catalogRide(id), c.tp.park))).length;
    html += left === 0
      ? `<div class="card empty"><h2>🎉 That's everything on your list</h2><p class="muted">Add more on the Rides tab, or call it a day.</p>
         <button type="button" data-act="tab" data-tab="rides">Add rides</button></div>`
      : res.snoozed.length && !res.excluded.length && !missing.length
          ? `<div class="card empty"><h2>Everything left is on "Not now"</h2><p class="muted">Undo one below to bring it back.</p></div>`
          : `<div class="card empty"><h2>Nothing on your list is open right now</h2><p class="muted">See why below. The list updates every minute.</p></div>`;
  }
  html += showsSection(c) + favoritesList(c) + clashList(res) + snoozedList(res) + unavailableList(res, missing, c) + doneList(c) + credits(snap);
  return html;
}

// ---------- render: Lightning ----------

function bookForm(c, rec) {
  const f = S.bookForm;
  const isThis = f && (rec ? f.rideId === rec.ride.id && f.kind === (rec.kind ?? 'multi') : f.manual);
  if (!isThis) return '';
  const options = rec
    ? ''
    : `<label class="field">Ride <select id="bk-ride">${c.snap.rides
        .filter((r) => r.ll?.multiState != null && (!c.tp.park || r.park === c.tp.park))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => `<option value="${esc(r.id)}" ${r.id === f.rideId ? 'selected' : ''}>${esc(r.name)}</option>`)
        .join('')}</select></label>`;
  return `<div class="form">${options}
    <label class="field">Return time it gave you <input type="time" id="bk-time" value="${esc(f.time)}" required></label>
    <p class="muted small">The window is an hour from that time.</p>
    <div class="actions"><button type="button" class="primary" data-act="book-save">Save booking</button><button type="button" data-act="book-cancel">Cancel</button></div></div>`;
}

/** Knott's Fast Lane: a paid all-day wristband. Is it worth it for what's left on the list? */
function fastLaneCard(c) {
  const fl = S.catalog?.parks?.KBF?.fastLane;
  const now = c.ctx?.now ?? Date.now();
  const close = c.snap?.parks?.KBF?.close ?? null;
  const left = (c.snap?.rides ?? []).filter((r) => r.park === 'KBF' && S.wanted.has(r.id) && !c.done?.has(r.id));
  const covered = left.filter((r) => info(r.id)?.fastLane);
  const FL_WAIT = 10; // Knott's doesn't publish Fast Lane waits; about 10 minutes is typical
  const open = covered.filter((r) => r.status === 'OPERATING' && Number.isFinite(r.wait));
  const standby = open.reduce((a, r) => a + r.wait, 0);
  const saved = open.reduce((a, r) => a + Math.max(0, r.wait - FL_WAIT), 0);
  const hoursLeft = close ? Math.max(0, (close - now) / 3600e3) : null;
  const party = partySize();
  const price = fl?.from ?? 75;
  let verdict;
  if (![...S.wanted].some((id) => catalogRide(id)?.park === 'KBF')) verdict = 'Pick your Knott\'s rides first (Next tab), then this says whether Fast Lane pays off.';
  else if (!covered.length) verdict = '<b>Skip it.</b> Nothing left on your list is a Fast Lane ride.';
  else if (!open.length) verdict = 'No live waits for your Fast Lane rides yet. Check again once the park is open.';
  else if (hoursLeft != null && hoursLeft < 1.5) verdict = `<b>Probably not now.</b> The park closes at ${esc(fmtTime(close))}, too soon to get your money's worth.`;
  else if (saved >= 60) verdict = `<b>Probably worth it.</b> It would save about ${saved} minutes of standby right now.`;
  else if (saved >= 30) verdict = `<b>Borderline.</b> It would save about ${saved} minutes right now. Worth it if the lines grow.`;
  else verdict = `<b>Skip it for now.</b> It would save only about ${saved} minutes at today's waits.`;
  const rows = covered
    .map((r) => {
      const st = r.status === 'OPERATING' && Number.isFinite(r.wait) ? `${r.wait} min standby now` : r.status === 'DOWN' ? 'down right now' : 'not open now';
      return `<li><div class="grow"><div class="name">${esc(r.name)}</div><div class="sub">${esc(st)}</div></div></li>`;
    })
    .join('');
  return `<section class="card"><div class="eyebrow">⚡ Knott's Fast Lane</div><h2>Is Fast Lane worth it today?</h2>
    <p>${verdict}</p>
    <p class="muted small">Fast Lane is a paid all-day wristband, per person: from about $${price} each (about $${price * party} for ${party}), more on busy days. Buy it only for the riders who'll use it. A limited number sell each day. Single-Use Fast Lane (one ride, select rides and times) is in the Six Flags app if you only want to skip one or two lines. This assumes Fast Lane lines of about ${FL_WAIT} minutes; Knott's doesn't publish them.${open.length ? ` Your ${open.length} open Fast Lane rides add up to ${standby} minutes of standby right now.` : ''}</p>
    ${rows ? `<h3 class="section-title">Your Fast Lane rides</h3><ul class="list">${rows}</ul>` : ''}
    <p class="muted small">${esc(fl?.how ?? '')} Not covered: MonteZOOMa and the kids' rides. Look for the Fast Lane entrance sign at each ride.</p></section>`;
}

function renderLightning(now, c) {
  if (!c.snap) return `${noteBar()}<div class="card empty"><h2>No wait times yet</h2><p class="muted">Lightning Lane advice needs live data. It keeps trying every minute.</p></div>`;
  if (c.oldDay) return `${noteBar()}<div class="card empty"><h2>No data for today yet</h2><p class="muted">It keeps trying every minute.</p></div>`;
  if (c.tp.needsChoice) return `${noteBar()}${parkChoiceCard(c)}<p class="muted small">Lightning Lane advice starts once today's park is set.</p>`;
  if (c.tp.park === 'KBF') return `${noteBar()}${fastLaneCard(c)}`;
  const onToday = c.llOn;
  const todayPlan = c.tp.park ? lanePlan(c.today, c.tp.park, c.snap) : null;
  const decision = `<section class="card"><div class="eyebrow">⚡ Today${c.tp.park ? ' · ' + esc(PARK[c.tp.park]) : ''}</div>
    <h2>Using Multi Pass today?</h2>
    ${seg('llday', onToday ?? '', [['on', 'We have it'], ['off', 'Not today']], `data-date="${esc(c.today)}"`)}
    ${todayPlan ? planBlock(todayPlan, { toggle: false }) : '<p class="muted small">Pick today’s park (More tab) to see whether it’s worth it.</p>'}
    ${todayPlan?.isToday ? '<p class="muted small">Uses today’s live wait forecast.</p>' : ''}</section>`;
  const tripDays = (S.trip?.days ?? []).filter((d) => d.date !== c.today);
  const tripHtml = tripDays.length && S.llstats
    ? `<h3 class="section-title">Should we buy it? Your trip days</h3>${tripDays
        .map((d) => {
          const park = S.dayPark[d.date] === 'DL' || S.dayPark[d.date] === 'DCA' ? S.dayPark[d.date] : d.park;
          if (park) return `<section class="card">${planBlock(lanePlan(d.date, park, c.snap))}</section>`;
          return `<section class="card"><p class="small"><b>${esc(fmtDay(d.date))}</b>: park not chosen yet. Here’s each:</p>${planBlock(lanePlan(d.date, 'DL', c.snap))}${planBlock(lanePlan(d.date, 'DCA', c.snap), { toggle: false })}</section>`;
        })
        .join('')}
      <p class="muted small">Estimated from real Lightning Lane and wait data for the last ${esc(new Set(Object.values(S.llstats.days).map((x) => x.day)).size)} days (ThemeParks.wiki). It assumes you book as soon as the rules allow, save each ride’s lane for when it saves the most, and would otherwise ride at about the usual wait. Friday counts only rides you haven’t done by then. Price $${esc(priceEach(c.today, c.tp.park ?? 'DL'))} a person unless you change it in More.</p>`
    : '';
  if (onToday === 'off') {
    return `${noteBar()}${decision}${tripHtml}${credits(c.snap)}`;
  }
  const n = c.next;
  let status;
  if (n.why === 'scan') {
    status = `<p>Your first booking opens once you <b>scan into the park</b>. The app notices when your phone is inside ${c.tp.park ? esc(PARK[c.tp.park]) : 'the park'}.</p>
      <div class="actions"><button type="button" class="primary" data-act="scan-in">We're in the park</button></div>`;
  } else if (n.why === 'now') {
    status = `<p class="okline">✓ You can book your next Lightning Lane now.</p>`;
  } else {
    const last = n.last ? nameOf(n.last.rideId, c.snap) : null;
    status = `<p>Next booking at <b>${esc(fmtTime(n.at))}</b>${last ? `, or as soon as you tap in at ${esc(last)}` : ''}.</p>`;
  }
  const held = S.ll.bookings.filter((b) => b.status !== 'cancelled').sort((a, b) => a.start - b.start);
  const bookings = held.length
    ? `<h3 class="section-title">Your bookings today</h3><ul class="list">${held
        .map((b) => {
          const name = nameOf(b.rideId, c.snap);
          const label = b.kind === 'single' ? 'Single Pass' : b.multiExp ? 'Multiple Experience' : 'Multi Pass';
          const state = b.status === 'used' ? `✓ used ${fmtTime(b.usedAt)}${b.usedOn && b.usedOn !== b.rideId ? ` at ${nameOf(b.usedOn, c.snap)}` : ''}` : `${fmtTime(b.start)} to ${fmtTime(b.end)}`;
          const btns = b.status === 'held'
            ? `<button type="button" data-act="lane-used" data-id="${esc(b.id)}">Tapped in</button><button type="button" data-act="lane-remove" data-id="${esc(b.id)}" aria-label="Remove booking">✕</button>`
            : '';
          return `<li><div class="grow"><div class="name">${esc(name)}</div><div class="sub">${esc(label)} · ${esc(state)}</div></div>${btns}</li>`;
        })
        .join('')}</ul>`
    : '';
  const recs = c.advice.recs.slice(0, 5);
  const recList = recs.length
    ? `<h3 class="section-title">${n.why === 'wait' ? 'Book next, when you can' : 'Book next'}</h3>${recs
        .map(
          (r, i) => `<section class="card ${i === 0 ? 'book' : 'alt'}"><h3>${esc(r.ride.name)} ${prioChip(r.ride.id)}</h3><p class="reason">${esc(r.reason)}</p>
          ${tripNote(r.ride.id)}
          ${S.bookForm?.rideId === r.ride.id && !S.bookForm?.manual ? bookForm(c, r) : `<div class="actions"><button type="button" data-act="book-open" data-id="${esc(r.ride.id)}" data-t="${esc(hhmm(r.start))}">I booked this</button></div>`}</section>`,
        )
        .join('')}`
    : `<p class="muted">Nothing on your list can be booked right now.</p>`;
  const soldOut = c.advice.soldOut.length ? `<p class="muted small"><b>Sold out today:</b> ${c.advice.soldOut.map((x) => esc(x.ride.name)).join(', ')}.</p>` : '';
  const singles = c.snap.rides.filter((r) => S.wanted.has(r.id) && r.ll?.singleState != null && (!c.tp.park || r.park === c.tp.park) && !c.done.has(r.id) && !c.short?.[r.id] && (!c.ctx.locked?.[r.id] || c.lockInfo?.[r.id]?.kind === 'wait'));
  const singleHtml = singles.length
    ? `<h3 class="section-title">Single Pass (paid per ride)</h3><ul class="list">${singles
        .map((r) => {
          const avail = r.ll.single ? `${r.ll.singlePrice ?? ''} · return ~${fmtTime(r.ll.single.start)}` : r.ll.singleState === 'FINISHED' ? 'sold out today' : 'not on sale now';
          const standby = Number.isFinite(r.wait) ? ` · standby ${r.wait} min` : '';
          const adv = singleAdvice(r, c, now);
          const btn = r.ll.single ? `<button type="button" data-act="book-open" data-id="${esc(r.id)}" data-kind="single" data-t="${esc(hhmm(r.ll.single.start))}">I bought it</button>` : '';
          const form = S.bookForm?.rideId === r.id && S.bookForm.kind === 'single' ? bookForm(c, { ride: r, kind: 'single' }) : '';
          return `<li class="stack"><div class="row"><div class="grow"><div class="name">${esc(r.name)}</div><div class="sub">${esc(avail)}${esc(standby)}</div><div class="sub advice advice-${esc(adv.kind)}">${esc(adv.text)}</div></div>${form || c.ctx.locked?.[r.id] ? '' : btn}</div>${form}</li>`;
        })
        .join('')}</ul>`
    : '';
  const manual = S.bookForm?.manual
    ? `<section class="card">${bookForm(c, null)}</section>`
    : `<div class="actions"><button type="button" data-act="book-manual">Add a booking made another way</button></div>`;
  return `${noteBar()}${decision}<section class="card"><div class="eyebrow">⚡ Booking${c.tp.park ? ' · ' + esc(PARK[c.tp.park]) : ''}</div>${status}</section>
    ${bookings}${recList}${soldOut}${singleHtml}${manual}${tripHtml}
    <details class="shows"><summary>How Lightning Lane works (stacking, modify, timing)</summary><ul class="small">
      <li><b>Arrive at opening.</b> You can't book anything until you've scanned into the park, so the first booking happens at the gate. Buy the Multi Pass the night before so you only have to pick rides.</li>
      <li><b>Stacking.</b> Book the next ride the moment you're allowed: when you tap in, or 2 hours after your last booking. Popular rides give return times hours away, so by midday you're holding two or three and walk past the standby lines all afternoon. This tab tells you when the next booking opens.</li>
      <li><b>Return window.</b> One hour, shown on the booking. Be there inside it; don't count on a grace period. Cancel one you can't make in the Disneyland app rather than letting it lapse.</li>
      <li><b>Modify.</b> In the Disneyland app, open a booking and tap Modify to look for an earlier time or another ride. Your current booking stays until you confirm the swap, so it costs nothing to check after a good ride. Disney picks from the times it has open; you can't type one in.</li>
      <li><b>Thrills first.</b> With Thrills first on (Rides tab), the picks below favour the big rides. A ride still waiting on its test ride can be booked; it says which test comes first.</li>
    </ul></details>
    <p class="muted small rules">Rules used: book your first one after you scan in; the next opens when you tap in or 2 hours after booking, whichever is first; each ride once a day; a ride that breaks down during your window turns the booking into a Multiple Experience pass for any other Multi Pass ride in the park. The Disneyland app is the authority; this is your own record and advice.</p>
    ${credits(c.snap)}`;
}

// ---------- render: Rides ----------

function rideStatus(r) {
  if (!r) return '';
  if (r.status === 'OPERATING') return Number.isFinite(r.wait) ? `${r.wait} min` : 'open';
  if (r.status === 'DOWN') return '<span class="status down">down</span>';
  if (r.status === 'REFURBISHMENT') return 'refurb';
  if (r.status === 'CLOSED') return r.open && r.open > Date.now() ? `opens ${esc(fmtTime(r.open))}` : 'closed';
  return '';
}

function renderRideList(snap, done) {
  const el = document.getElementById('ride-list');
  if (!el || !S.catalog) return;
  const ix = tripIndex();
  const tooShort = tooShortFor(S.rideinfo?.rides, S.settings.heightIn);
  const liveById = new Map((snap?.rides ?? []).map((r) => [r.id, r]));
  const extra = (snap?.rides ?? []).filter((r) => !catalogRide(r.id) && r.park).map((r) => ({ id: r.id, name: r.name, park: r.park, type: null, land: null }));
  const q = fold(S.query.trim());
  const rows = [...S.catalog.rides, ...extra].filter(
    (r) => (S.settings.showAll || r.type === 'RIDE' || S.wanted.has(r.id) || ix.byTpw.has(r.id) || ix.avoid.has(r.id)) && (!q || fold(r.name).includes(q)),
  );
  if (!rows.length) {
    el.innerHTML = `<p class="muted">No rides match “${esc(S.query)}”.</p>`;
    return;
  }
  let html = '';
  const first = todayPark(parkDayKey()).park;
  for (const park of ['DL', 'DCA', 'KBF'].sort((a, b) => (b === first) - (a === first))) {
    const inPark = rows.filter((r) => r.park === park);
    if (!inPark.length) continue;
    // A collapsed park stays collapsed across visits, but opens while searching so matches show.
    const folded = !!S.folded[park] && !q;
    const picks = inPark.filter((r) => S.wanted.has(r.id)).length;
    html += `<h2 class="park-h"><button type="button" class="park-fold" data-act="fold" data-park="${park}" aria-expanded="${!folded}">
      <span class="chev" aria-hidden="true">${folded ? '▸' : '▾'}</span>${PARK[park]}<span class="muted small">${picks} picked</span></button></h2>`;
    if (folded) continue;
    const lands = new Map();
    for (const r of inPark) {
      const k = r.land ?? 'Other';
      if (!lands.has(k)) lands.set(k, []);
      lands.get(k).push(r);
    }
    const order = [...lands.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
    for (const land of order) {
      html += `<h3 class="land-h">${esc(land)}</h3><ul class="list">`;
      for (const r of lands.get(land)) {
        const picked = S.wanted.has(r.id);
        const isDone = done.has(r.id);
        const av = ix.avoid.get(r.id);
        html += `<li class="${picked ? 'picked' : ''} stack">
          <div class="row"><button type="button" class="pick" data-act="want" data-id="${esc(r.id)}" aria-pressed="${picked}">
            <span class="box" aria-hidden="true">${picked ? '✓' : ''}</span>
            <span class="name ${isDone ? 'done-name' : ''}">${esc(r.name)} ${prioChip(r.id)}${av ? '<span class="prio prio-avoid">Avoid</span>' : ''}${S.ratings[r.id] ? ` <span class="starline">${starText(S.ratings[r.id].stars)}</span>` : ''}${tooShort[r.id] ? `<span class="prio prio-avoid">Needs ${tooShort[r.id]} in.</span>` : ''}</span>
            <span class="status">${rideStatus(liveById.get(r.id))}</span>
          </button>
          ${picked ? `<button type="button" data-act="${isDone ? 'undone' : 'done'}" data-id="${esc(r.id)}">${isDone ? 'Undo' : 'Done'}</button>` : ''}</div>
          ${av?.reason ? `<div class="sub avoid-why">${esc(av.reason)}</div>` : ''}
          ${ridePreview(r.id, picked)}
        </li>`;
      }
      html += `</ul>`;
    }
  }
  el.innerHTML = html;
}

// Rides tab: a preview link for every ride, after its "what to expect" line once it's picked.
// It sits outside the row's pick button, so tapping it never ticks or unticks the ride.
function ridePreview(id, picked) {
  const i = info(id);
  if (!i?.video) return '';
  const link = `<a class="preview" href="${esc(i.video)}" target="_blank" rel="noopener" aria-label="Preview ${esc(catalogRide(id)?.name ?? 'this ride')} on YouTube">Preview ↗</a>`;
  return `<div class="sub avoid-why">${picked && i.expect ? `${esc(i.expect)} ` : ''}${link}</div>`;
}

function renderRidesShell(done) {
  const left = [...S.wanted].filter((id) => !done.has(id)).length;
  return `<div class="search">
    <input type="search" id="q" placeholder="Search rides" value="${esc(S.query)}" autocomplete="off" aria-label="Search rides">
    <label class="toggle"><input type="checkbox" data-act="showall" ${S.settings.showAll ? 'checked' : ''}> Shows too</label>
    <label class="toggle"><input type="checkbox" data-act="thrills" ${S.settings.thrills ? 'checked' : ''}> ⚡ Thrills first</label>
  </div>
  <p class="muted small" id="pick-count">${S.wanted.size} picked · ${left} still to do</p>
  <div id="ride-list"></div>`;
}

// ---------- render: More ----------

function seg(act, current, options, extra = '') {
  return `<div class="seg" role="group">${options
    .map(([v, label]) => `<button type="button" data-act="${act}" data-v="${esc(v)}" ${extra} aria-pressed="${String(current) === String(v)}">${esc(label)}</button>`)
    .join('')}</div>`;
}

function tripCard(c) {
  if (!S.trip) {
    return `<section class="card"><h2>Your trip</h2>
      <p>Load your trip file to get your ride list, priorities, avoid list and ladders on this phone.</p>
      <label class="btn filebtn">Load trip file<input type="file" id="trip-file" accept=".json,application/json" hidden></label>
      <div class="form"><label class="field">Or paste a trip link (for a Home Screen app on iPhone)
        <input id="trip-paste" type="url" inputmode="url" autocomplete="off" placeholder="https://justinwi.github.io/disneyland-next-ride/#trip=..."></label>
        <button type="button" data-act="trip-paste">Load pasted link</button></div>
      <p class="muted small">It stays on this phone. Nothing is uploaded.</p></section>`;
  }
  const t = S.trip;
  const unmatched = [...t.rides, ...t.avoid].filter((r) => !r.tpwId).map((r) => r.name);
  const dayRows = t.days
    .map((d, i) => {
      const p = d.park && S.llstats ? lanePlan(d.date, d.park, null) : null;
      const verdict = p ? `<span class="verdict v-${p.verdict}">Multi Pass: ${VERDICT[p.verdict]}</span>` : '';
      return `<div class="dayrow"><b>${esc(fmtDay(d.date))}</b> ${verdict}${seg('tripday', d.park ?? 'choose', [['DL', 'Disneyland'], ['DCA', 'DCA'], ['choose', 'Decide']], `data-i="${i}"`)}
        ${seg('llday', llOn(d.date) ?? '', [['on', 'Lightning Lane'], ['off', 'No Lightning Lane']], `data-date="${esc(d.date)}"`)}</div>`;
    })
    .join('');
  const confirmRemove = S.confirm === 'trip-remove';
  return `<section class="card"><h2>Your trip</h2>
    <p>${t.rides.length} rides, ${t.avoid.length} to avoid.${unmatched.length ? ` Not found in the park data: ${esc(unmatched.join(', '))}.` : ''}</p>
    ${dayRows}
    <div class="actions"><button type="button" data-act="trip-share">Copy a private link for another phone</button>
    <label class="btn filebtn">Load a new file<input type="file" id="trip-file" accept=".json,application/json" hidden></label>
    <button type="button" class="danger" data-act="trip-remove">${confirmRemove ? 'Tap again to remove' : 'Remove trip'}</button></div>
    ${S.shareText ? `<textarea class="share" readonly rows="3">${esc(S.shareText)}</textarea><p class="muted small">Anyone with this link sees your list. It isn't stored anywhere online.</p>` : ''}
    </section>`;
}

function heightSummary() {
  if (!S.rideinfo) return 'Ride height data is loading.';
  if (!Number.isFinite(S.settings.heightIn)) return 'Enter a height to hide rides that are too tall a minimum. It stays on this phone.';
  const short = tooShortFor(S.rideinfo.rides, S.settings.heightIn);
  const names = Object.keys(short).map((id) => catalogRide(id)?.name).filter(Boolean);
  return names.length ? `At ${S.settings.heightIn} in., too short for: ${names.join(', ')}. These are left out of picks.` : `At ${S.settings.heightIn} in., tall enough for every ride.`;
}

function renderMore(c) {
  const confirmList = S.confirm === 'clear-list';
  const confirmDone = S.confirm === 'clear-done';
  const tpVal = S.dayPark[c.today] ?? (c.tp.auto ? c.tp.park : c.tp.td?.park ?? (c.tp.needsChoice ? '' : 'both'));
  return `${noteBar()}${tripCard(c)}
  <section class="card"><h2>Today's park</h2>
    ${seg('daypark', tpVal, [['DL', 'Disneyland'], ['DCA', 'DCA'], ['both', 'Both (hopper)'], ['KBF', "Knott's"]])}
    <p class="muted small">Only rides in today's park are suggested. Trip days set this for you, and at Knott's it switches by itself.</p></section>
  <section class="card"><h2>Multi Pass cost</h2>
    ${seg('llprice', S.settings.llPrice ?? '', [[32, '$32'], [37, '$37'], [42, '$42'], [49, '$49']])}
    ${seg('party', partySize(), [[2, '2 people'], [3, '3'], [4, '4'], [5, '5']])}
    <p class="muted small">Per person per day, used for the worth-it advice. Disney changes the price by date; ${S.settings.llPrice ? 'you set it' : 'default $37, the current Disneyland price'}.</p></section>
  <section class="card"><h2>Height check</h2>
    <div class="form"><label class="field">Shortest rider's height, in inches
      <input id="height-in" type="number" inputmode="decimal" min="30" max="80" step="0.5" value="${esc(S.settings.heightIn ?? '')}" placeholder="e.g. 50"></label>
      <div class="actions"><button type="button" data-act="height-save">Save</button><button type="button" data-act="height-clear">Clear</button></div></div>
    <p class="muted small">${heightSummary()}</p></section>
  <section class="card"><h2>Battery saver</h2>
    <label class="toggle big"><input type="checkbox" data-act="battery" ${S.settings.battery ? 'checked' : ''}> Use less battery</label>
    <p class="muted small">Checks your location less precisely and refreshes wait times every 3 minutes instead of every minute.</p></section>
  <section class="card"><h2>Walking pace</h2>
    ${seg('speed', S.settings.speed, [['slow', 'Stroller'], ['normal', 'Normal'], ['fast', 'Brisk']])}
    <p class="muted small">Used for walk times. Paths are assumed 30% longer than a straight line.</p></section>
  <section class="card"><h2>Park hop</h2>
    ${seg('hop', S.settings.hopMinutes, [[10, '+10 min'], [20, '+20 min'], [30, '+30 min']])}
    <p class="muted small">Only matters on a hopper day: extra time to reach a ride in the other park.</p></section>
  <section class="card"><h2>When location is off</h2>
    ${seg('start', S.settings.start, [['DL', 'Disneyland gate'], ['DCA', 'DCA gate']])}
    <p class="muted small">Walks are measured from here when the phone can't find you.</p></section>
  <section class="card"><h2>Reset</h2>
    <div class="actions">
      <button type="button" data-act="clear-done">${confirmDone ? 'Tap again to clear' : "Clear today's done marks"}</button>
      <button type="button" class="danger" data-act="clear-list">${confirmList ? 'Tap again to clear' : 'Clear my list'}</button>
    </div>
    <p class="muted small">Done marks carry over between your trip days, so Friday knows what you've ridden.</p></section>
  <section class="card"><h2>How it picks</h2>
    <p>For each ride left on your list it adds the walk to the wait you'll likely find when you get there. Must-dos get a head start. If a ride's line will be much longer later, it moves up; if it will be shorter later, it moves down; if it closes before you could come back, it moves up.</p>
    <p class="muted small">Rides that are down, closed, locked by your ladder, booked with Lightning Lane, or that would clash with a Lightning Lane window are listed separately with the reason.</p></section>
  ${credits(c.snap)}`;
}

// ---------- render: all ----------

function safeCompute(now) {
  try {
    return compute(now);
  } catch (err) {
    console.error('[next-ride] compute failed', err);
    // Find what's bad. Stored waits are dropped only if they themselves won't build (review R7, M12);
    // otherwise it's the trip data: switch it off rather than lose the waits.
    let waitsOk = true;
    try {
      if (S.catalog) buildSnapshot(S.data, S.catalog, now);
    } catch {
      waitsOk = false;
    }
    if (!waitsOk) {
      S.data = { tpw: null, qt: null, hours: S.data.hours, kbf: null };
      remove('kbf');
      remove('tpw');
      remove('qt');
    } else if (S.trip) {
      save('tripBroken', S.trip);
      S.trip = null;
      remove('trip');
      tripIx = null;
      S.note = "Your trip data couldn't be read, so it's switched off. Load the trip file or link again in More.";
    }
    try {
      return compute(now);
    } catch {
      let w = { pos: null, posPark: null, gates: null, mode: 'nogps' };
      try {
        w = where();
      } catch {
        /* keep the fallback */
      }
      return { snap: null, w, res: null, missing: [], today: parkDayKey(now), tp: { park: null, needsChoice: false, td: null }, due: [], prompts: [] };
    }
  }
}

function render(force = false) {
  const now = Date.now();
  const c = safeCompute(now);
  try {
    renderChips(now, c);
  } catch (err) {
    console.error('[next-ride] chips', err);
  }
  for (const b of document.querySelectorAll('.tabs button')) {
    if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  try {
    renderAlerts();
  } catch (err) {
    console.error('[next-ride] alerts', err);
  }
  const view = document.getElementById('view');
  const done = c.done ?? doneSet(parkDayKey(now));
  try {
    if (S.tab === 'rides') {
      if (!document.getElementById('ride-list')) view.innerHTML = renderRidesShell(done);
      const count = document.getElementById('pick-count');
      if (count) count.textContent = `${S.wanted.size} picked · ${[...S.wanted].filter((id) => !done.has(id)).length} still to do`;
      renderRideList(c.oldDay ? null : c.snap, done);
    } else if (S.tab === 'more') {
      view.innerHTML = renderMore(c);
    } else if (S.tab === 'lanes') {
      // A background redraw never rebuilds an open booking form (review H4); taps do.
      if (force || !S.bookForm) view.innerHTML = renderLightning(now, c);
    } else {
      view.innerHTML = renderNext(now, c);
    }
  } catch (err) {
    console.error('[next-ride] render', err);
    view.innerHTML = '<div class="card empty"><h2>Something went wrong showing this</h2><p class="muted">It will try again in a moment.</p></div>';
  }
}

function setTab(tab) {
  S.tab = tab;
  S.note = null;
  save('tab', tab);
  document.getElementById('view').innerHTML = '';
  render(true);
  window.scrollTo(0, 0);
}

// ---------- actions ----------

function markDone(id) {
  const today = parkDayKey();
  S.counts[id] = (S.counts[id] ?? 0) + 1;
  save('counts', S.counts);
  if (S.again[today]?.includes(id)) {
    S.again[today] = S.again[today].filter((x) => x !== id);
    save('again', S.again);
  }
  S.rateNext = id;
  S.done.ids.add(id);
  if (!S.wanted.has(id)) {
    S.wanted.add(id);
    saveWanted();
  }
  delete S.snoozed[id];
  saveSnoozed();
  saveDone();
  if (S.stickyId === id) S.stickyId = null;
}

function unmarkDone(id) {
  S.done.ids.delete(id);
  saveDone();
  let changed = false;
  for (const [day, ids] of Object.entries(S.history)) {
    if (ids.includes(id)) {
      S.history[day] = ids.filter((x) => x !== id);
      changed = true;
    }
  }
  if (changed) save('history', S.history);
}

function useBooking(id, onRide = null) {
  const b = S.ll.bookings.find((x) => x.id === id);
  if (!b) return;
  const now = Date.now();
  const rideId = onRide ?? b.rideId;
  S.ll = { ...S.ll, bookings: S.ll.bookings.map((x) => (x.id === id ? { ...x, status: 'used', usedAt: now, usedOn: rideId } : x)) };
  saveLL();
  markDone(rideId);
  S.note = b.kind === 'multi' ? 'Tapped in. You can book your next Lightning Lane now.' : 'Tapped in.';
}

async function importTrip(obj, how) {
  const parsed = parseTripFile(obj);
  const trip = attachIds(parsed, S.catalog.rides);
  S.trip = trip;
  save('trip', trip);
  save('dropTestAdded', false); // a fresh trip gets Rise added again by the drop test
  tripXm = null;
  const ids = trip.rides.map((r) => r.tpwId).filter(Boolean);
  S.wanted = new Set(ids);
  saveWanted();
  S.unlock = {};
  save('unlock', S.unlock);
  const miss = trip.rides.filter((r) => !r.tpwId).length;
  S.note = `Trip loaded from ${how}: ${ids.length} rides on your list${miss ? `, ${miss} not found` : ''}.`;
  S.shareText = null;
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT' && el.type === 'file') return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  if (!['clear-list', 'clear-done', 'trip-remove'].includes(act)) S.confirm = null;
  const today = parkDayKey();
  switch (act) {
    case 'tab':
      setTab(el.dataset.tab);
      return;
    case 'refresh':
      refresh();
      return;
    case 'locate':
      startGeo(true);
      return;
    case 'done':
      markDone(id);
      break;
    case 'undone':
      unmarkDone(id);
      break;
    case 'snooze':
      S.snoozed[id] = Date.now() + SNOOZE_MIN * MIN;
      saveSnoozed();
      if (S.stickyId === id) S.stickyId = null;
      break;
    case 'unsnooze':
      delete S.snoozed[id];
      saveSnoozed();
      break;
    case 'want':
      if (S.wanted.has(id)) S.wanted.delete(id);
      else S.wanted.add(id);
      saveWanted();
      break;
    case 'kbf-pick': {
      const { ids, short } = knottsPicks();
      for (const id of ids) S.wanted.add(id);
      saveWanted();
      S.note = `Picked ${ids.length} Knott's rides. Thrills first puts the coasters and drops at the top.${short.length ? ` Left out for height: ${short.map((r) => r.name).join(', ')}.` : ''}`;
      break;
    }
    case 'fold':
      S.folded[el.dataset.park] = !S.folded[el.dataset.park];
      save('folded', S.folded);
      break;
    case 'showall':
      S.settings.showAll = el.checked;
      saveSettings();
      break;
    case 'thrills':
      S.settings.thrills = el.checked;
      saveSettings();
      S.note = el.checked ? 'Thrills first: coasters and big rides move up, slow calm rides move down.' : 'Thrills first is off: back to the trip file’s priorities.';
      break;
    case 'heat':
      S.heat = { until: Math.max(Date.now(), S.heat?.until ?? 0) + HEAT_MINUTES * 60e3 };
      save('heat', S.heat);
      break;
    case 'heat-off':
      S.heat = null;
      save('heat', null);
      break;
    case 'speed':
      S.settings.speed = el.dataset.v;
      saveSettings();
      break;
    case 'hop':
      S.settings.hopMinutes = Number(el.dataset.v);
      saveSettings();
      break;
    case 'start':
      S.settings.start = el.dataset.v;
      saveSettings();
      break;
    case 'daypark':
      S.dayPark[today] = el.dataset.v;
      save('dayPark', S.dayPark);
      S.stickyId = null;
      break;
    case 'tripday': {
      const i = Number(el.dataset.i);
      if (S.trip?.days?.[i]) {
        S.trip = { ...S.trip, days: S.trip.days.map((d, j) => (j === i ? { ...d, park: el.dataset.v === 'choose' ? null : el.dataset.v } : d)) };
        save('trip', S.trip);
        if (S.trip.days[i].date === today) delete S.dayPark[today];
        save('dayPark', S.dayPark);
        S.shareText = null;
      }
      break;
    }
    case 'llday':
      if (el.dataset.date) {
        S.llDays[el.dataset.date] = el.dataset.v;
        save('llDays', S.llDays);
      }
      break;
    case 'llprice':
      S.settings.llPrice = Number(el.dataset.v);
      saveSettings();
      break;
    case 'party':
      S.settings.party = Number(el.dataset.v);
      saveSettings();
      break;
    case 'app-reload':
      location.reload();
      return;
    case 'alert-ok':
      S.banners = S.banners.filter((b) => b.key !== el.dataset.key);
      break;
    case 'alert-go':
      S.banners = S.banners.filter((b) => b.key !== el.dataset.key);
      setTab(el.dataset.tab);
      return;
    case 'brief-ok':
      S.briefDone[today] = true;
      save('briefDone', S.briefDone);
      break;
    case 'arrive-start':
      S.arrival = { day: today, at: Date.now(), travel: S.arrival?.travel ?? 20 };
      save('arrival', S.arrival);
      S.briefDone[today] = true;
      save('briefDone', S.briefDone);
      if (S.tab !== 'next') {
        setTab('next');
        return;
      }
      break;
    case 'arrive-travel':
      if (S.arrival) {
        S.arrival = { ...S.arrival, travel: Number(el.dataset.v) };
        save('arrival', S.arrival);
      }
      break;
    case 'arrive-done':
    case 'arrive-cancel':
      if (act === 'arrive-done') {
        S.ll = { ...S.ll, scannedAt: S.ll.scannedAt ?? Date.now() };
        saveLL();
      }
      S.arrival = null;
      save('arrival', null);
      break;
    case 'show-remind': {
      const name = el.dataset.name;
      S.showPrefs[name] = !(S.showPrefs[name] ?? classifyShow(name).major);
      save('showPrefs', S.showPrefs);
      break;
    }
    case 'height-save': {
      const v = Number(document.getElementById('height-in')?.value);
      S.settings.heightIn = Number.isFinite(v) && v >= 30 && v <= 80 ? Math.round(v * 2) / 2 : null;
      saveSettings();
      S.note = S.settings.heightIn ? `Height saved: ${S.settings.heightIn} in.` : 'Enter a height between 30 and 80 inches.';
      break;
    }
    case 'height-clear':
      S.settings.heightIn = null;
      saveSettings();
      break;
    case 'battery':
      S.settings.battery = el.checked;
      saveSettings();
      startGeo(true);
      break;
    case 'rate':
      S.ratings[id] = { stars: clampStars(el.dataset.v), at: Date.now() };
      save('ratings', S.ratings);
      if (S.rateNext === id) S.rateNext = null;
      break;
    case 'rate-skip':
      S.rateNext = null;
      break;
    case 'again': {
      const list = S.again[today] ?? [];
      if (!list.includes(id)) S.again[today] = [...list, id];
      save('again', S.again);
      if (!S.wanted.has(id)) {
        S.wanted.add(id);
        saveWanted();
      }
      delete S.snoozed[id];
      saveSnoozed();
      S.note = `${nameOf(id, null)} is back on today's list.`;
      break;
    }
    case 'gate':
      S.gate[el.dataset.key] = el.dataset.v === 'no' ? 'no' : 'yes';
      save('gate', S.gate);
      break;
    case 'unlock':
      S.unlock[el.dataset.key] = el.dataset.v;
      save('unlock', S.unlock);
      break;
    case 'scan-in':
      S.ll = { ...S.ll, scannedAt: Date.now() };
      saveLL();
      break;
    case 'book-open':
      S.bookForm = { rideId: id, kind: el.dataset.kind === 'single' ? 'single' : 'multi', time: el.dataset.t || hhmm(Date.now()), manual: false };
      break;
    case 'book-manual':
      S.bookForm = { rideId: null, kind: 'multi', time: hhmm(Date.now() + 60 * MIN), manual: true };
      break;
    case 'book-cancel':
      S.bookForm = null;
      break;
    case 'book-save': {
      const f = S.bookForm;
      const t = document.getElementById('bk-time')?.value;
      const rideId = f?.manual ? document.getElementById('bk-ride')?.value : f?.rideId;
      const start = t ? parkTime(today, t) : NaN;
      if (!f || !rideId || !Number.isFinite(start)) {
        S.note = 'Pick a return time first.';
        break;
      }
      const now = Date.now();
      S.ll = {
        ...S.ll,
        scannedAt: S.ll.scannedAt ?? now,
        bookings: [...S.ll.bookings, { id: `${rideId}-${now}`, kind: f.kind, rideId, bookedAt: now, start, end: start + LL.windowMin * MIN, status: 'held' }],
      };
      saveLL();
      S.bookForm = null;
      S.note = `Saved: ${fmtTime(start)} to ${fmtTime(start + LL.windowMin * MIN)}.`;
      break;
    }
    case 'lane-used':
      useBooking(id);
      break;
    case 'lane-used-at':
      useBooking(id, el.dataset.ride);
      break;
    case 'lane-remove':
      S.ll = { ...S.ll, bookings: S.ll.bookings.map((x) => (x.id === id ? { ...x, status: 'cancelled' } : x)) };
      saveLL();
      break;
    case 'trip-accept':
      if (S.pendingTrip) {
        importTrip(S.pendingTrip, 'the link').catch((e) => (S.note = `Couldn't load the trip: ${e.message}`)).finally(render);
        S.pendingTrip = null;
      }
      return;
    case 'trip-reject':
      S.pendingTrip = null;
      break;
    case 'trip-paste': {
      const m = /#trip=([A-Za-z0-9_-]+)/.exec(document.getElementById('trip-paste')?.value ?? '');
      if (!m) {
        S.note = 'That doesn\u2019t look like a trip link. Copy the whole link, including #trip=.';
        break;
      }
      decodeTrip(m[1])
        .then((t) => importTrip(t, 'the pasted link'))
        .catch((e) => (S.note = `That trip link didn't work: ${e.message}`))
        .finally(() => render(true));
      return;
    }
    case 'trip-share':
      if (S.trip) {
        encodeTrip(S.trip)
          .then((code) => {
            const url = `${location.origin}${location.pathname}#trip=${code}`;
            S.shareText = url;
            return navigator.clipboard?.writeText(url).then(
              () => (S.note = 'Link copied. Send it to the other phone and open it there.'),
              () => (S.note = 'Copy the link below and send it to the other phone.'),
            );
          })
          .catch(() => (S.note = "Couldn't make a link on this browser."))
          .finally(render);
      }
      return;
    case 'trip-remove':
    case 'clear-done':
    case 'clear-list':
      if (S.confirm !== act) {
        S.confirm = act;
        setTimeout(() => {
          if (S.confirm === act) {
            S.confirm = null;
            render();
          }
        }, 4000);
        break;
      }
      S.confirm = null;
      if (act === 'trip-remove') {
        S.trip = null;
        remove('trip');
        S.shareText = null;
        break;
      }
      S.done.ids.clear();
      saveDone();
      S.snoozed = {};
      saveSnoozed();
      if (act === 'clear-list') {
        S.wanted.clear();
        saveWanted();
      }
      break;
    default:
      return;
  }
  render(true);
});

document.addEventListener('input', (ev) => {
  if (ev.target.id === 'q') {
    S.query = ev.target.value;
    render();
  }
  if (S.bookForm && ev.target.id === 'bk-time') S.bookForm.time = ev.target.value;
  if (S.bookForm && ev.target.id === 'bk-ride') S.bookForm.rideId = ev.target.value;
});

document.addEventListener('change', (ev) => {
  if (S.bookForm && ev.target.id === 'bk-time') S.bookForm.time = ev.target.value;
  if (S.bookForm && ev.target.id === 'bk-ride') S.bookForm.rideId = ev.target.value;
  if (ev.target.id !== 'trip-file') return;
  const file = ev.target.files?.[0];
  if (!file) return;
  file
    .text()
    .then((text) => importTrip(JSON.parse(text), 'your file'))
    .catch((e) => (S.note = `Couldn't load that file: ${e.message}`))
    .finally(render);
});

// ---------- data ----------

async function refresh() {
  if (S.fetching) return;
  S.fetching = true;
  render();
  let r;
  try {
    // Knott's missing from today's hours (its schedule fetch failed) is stale too, at most every 5 minutes.
    const hToday = S.data.hours?.days?.[parkDayKey()];
    const hAge = Date.now() - (S.data.hours?.at ?? 0);
    const hoursStale = !hToday || hAge > 3600e3 || (!hToday.KBF && todayPark(parkDayKey()).park === 'KBF' && hAge > 5 * MIN);
    const [fresh, hours, kbf] = await Promise.all([
      SIMULATE_OFFLINE ? { via: null, error: 'simulated offline' } : fetchFresh(),
      hoursStale && !SIMULATE_OFFLINE ? fetchHours().catch(() => null) : null,
      SIMULATE_OFFLINE ? null : fetchKnotts(),
    ]);
    r = fresh;
    if (kbf && (!S.data.kbf || kbf.at >= S.data.kbf.at)) {
      S.data.kbf = kbf;
      save('kbf', kbf);
    }
    if (hours) {
      S.data.hours = hours;
      save('hours', hours);
    }
  } catch (err) {
    r = { via: null, error: String(err) };
  }
  S.fetching = false;
  S.lastAttempt = Date.now();
  if (r.tpw && (!S.data.tpw || r.tpw.at >= S.data.tpw.at)) {
    S.data.tpw = r.tpw;
    save('tpw', r.tpw);
  }
  if (r.qt && (!S.data.qt || r.qt.at >= S.data.qt.at)) {
    S.data.qt = r.qt;
    save('qt', r.qt);
  }
  // At Knott's, its own feed decides whether we're offline.
  S.offline = todayPark(parkDayKey()).park === 'KBF' ? !(S.data.kbf && Date.now() - S.data.kbf.at < 2 * MIN) : r.via === null;
  render();
}

// ---------- location ----------

let watchId = null;

function startGeo(userAsked = false) {
  if (!('geolocation' in navigator)) {
    S.geo.status = 'unavailable';
    render();
    return;
  }
  if (watchId != null && !userAsked) return;
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  if (S.geo.status !== 'ok') S.geo.status = 'pending';
  render();
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
      // Keep a good fix rather than replace it with a rough one (a first fix can be ±500 m).
      if (p.coords.accuracy > COARSE_M && S.geo.pos && S.geo.acc != null && S.geo.acc <= COARSE_M) return;
      const moved = !S.geo.pos || haversineMeters(S.geo.pos, pos) > 15;
      const wasOk = S.geo.status === 'ok';
      S.geo = { status: 'ok', pos, acc: p.coords.accuracy };
      if (moved || !wasOk) render();
    },
    (err) => {
      S.geo.status = err.code === 1 ? 'denied' : S.geo.pos ? 'ok' : 'unavailable';
      render();
    },
    S.settings.battery ? { enableHighAccuracy: false, maximumAge: 120000, timeout: 60000 } : { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 },
  );
}

// ---------- boot ----------

async function readTripLink() {
  const m = /^#trip=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!m) return;
  try {
    history.replaceState(null, '', location.pathname + location.search); // don't leave it in the address bar
  } catch {
    /* ignore */
  }
  try {
    S.pendingTrip = await decodeTrip(m[1]);
    S.tab = 'next';
  } catch (e) {
    S.note = `That trip link didn't work: ${e.message}`;
  }
}

async function boot() {
  render();
  try {
    const res = await fetch('data/catalog.json');
    S.catalog = await res.json();
    S.footprints = parkFootprints(S.catalog);
    S.llstats = await fetch('data/llstats.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    S.rideinfo = await fetch('data/rideinfo.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  } catch {
    document.getElementById('view').innerHTML =
      '<div class="card empty"><h2>Couldn’t load the ride list</h2><p class="muted">Open the app once with signal so it can save itself for offline use.</p></div>';
    return;
  }
  await readTripLink();
  render();
  if (!S.override) startGeo();
  refresh();
  // Timers re-read the battery-saver setting each round.
  const every = (ms, fn) => {
    const loop = () =>
      setTimeout(() => {
        if (!document.hidden) fn();
        loop();
      }, ms());
    loop();
  };
  every(() => (S.settings.battery ? 180e3 : REFRESH_MS), refresh);
  every(() => (S.settings.battery ? 60e3 : TICK_MS), () => render());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      render();
      if (!S.lastAttempt || Date.now() - S.lastAttempt > 20e3) refresh();
    }
  });
  window.addEventListener('online', () => refresh());
}

if ('serviceWorker' in navigator) {
  // A new deploy's service worker takes over a few seconds after the page opened on the old
  // files. Reload straight away if that happens right after opening (nothing lost); later on,
  // offer a Reload button instead of yanking the page out from under someone.
  const hadController = !!navigator.serviceWorker.controller;
  const openedAt = Date.now();
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install: this page already runs the newest files
    const busy = S.pendingTrip || document.activeElement?.matches?.('input, textarea, select');
    if (!busy && Date.now() - openedAt < 20000) {
      location.reload();
      return;
    }
    S.banners = [...S.banners.filter((b) => b.key !== 'app-update'), { key: 'app-update', kind: 'info', title: 'A newer version of the app is ready', body: 'Reload to use it. Your list and progress are saved on this phone.', reload: true }];
    renderAlerts();
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
