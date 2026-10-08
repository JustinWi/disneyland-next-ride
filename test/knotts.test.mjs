import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTpw, PARK_IDS, withParkHours } from '../app/js/normalize.js';
import { buildSnapshot } from '../app/js/sources.js';
import { plan } from '../app/js/plan.js';
import { feelOf, thrillPriority } from '../app/js/boost.js';
import { tooShortFor } from '../app/js/similar.js';

const T = (s) => Date.parse(s);
const catalog = {
  parks: {
    DL: { id: PARK_IDS.DL, lat: 33.8121, lng: -117.919 },
    DCA: { id: PARK_IDS.DCA, lat: 33.8067, lng: -117.919 },
    KBF: { id: PARK_IDS.KBF, lat: 33.8442, lng: -117.9989 },
  },
  rides: [
    { id: 'dl1', name: 'Space Mountain', park: 'DL', lat: 33.8113, lng: -117.9174, type: 'RIDE' },
    { id: 'k1', name: 'GhostRider', park: 'KBF', lat: 33.8437, lng: -117.9993, type: 'RIDE' },
    { id: 'k2', name: 'Calico Railroad', park: 'KBF', lat: 33.8443, lng: -118.0004, type: 'RIDE' },
  ],
};
const att = (id, name, parkId, status, wait) => ({ id, name, entityType: 'ATTRACTION', parkId, status, queue: { STANDBY: { waitTime: wait } } });
const disneyLive = { liveData: [att('dl1', 'Space Mountain', PARK_IDS.DL, 'OPERATING', 40)] };
const knottsLive = {
  liveData: [
    att('k1', 'GhostRider', PARK_IDS.KBF, 'OPERATING', 25),
    att('k2', 'Calico Railroad', PARK_IDS.KBF, 'OPERATING', 5),
    att('maze', 'Some Night Maze', PARK_IDS.KBF, 'CLOSED', null), // Scary Farm maze: not in the catalog
  ],
};
const now = T('2026-03-12T11:00:00-07:00');
const hours = {
  at: now,
  days: { '2026-03-12': { KBF: { open: T('2026-03-12T10:00:00-07:00'), close: T('2026-03-12T17:30:00-07:00') } } },
};

test("Knott's: only catalog rides count, and they run park hours", () => {
  const k = normalizeTpw(knottsLive, catalog, { now });
  assert.deepEqual(k.rides.map((r) => r.id), ['k1', 'k2']);
  const withHours = withParkHours(k, hours, '2026-03-12');
  const gr = withHours.rides.find((r) => r.id === 'k1');
  assert.equal(gr.close, T('2026-03-12T17:30:00-07:00'), 'a 5:30 pm Scary Farm close reaches every ride');
  assert.equal(withHours.parks.KBF.open, T('2026-03-12T10:00:00-07:00'));
});

test("Knott's waits merge with Disney's but keep their own age", () => {
  const snap = buildSnapshot({ tpw: { at: now - 60e3, data: disneyLive }, kbf: { at: now - 5 * 60e3, data: knottsLive }, hours }, catalog, now);
  assert.deepEqual(snap.rides.map((r) => r.id).sort(), ['dl1', 'k1', 'k2']);
  assert.equal(snap.at, now - 60e3);
  assert.equal(snap.atKBF, now - 5 * 60e3);
  const onlyKnotts = buildSnapshot({ kbf: { at: now, data: knottsLive }, hours }, catalog, now);
  assert.deepEqual(onlyKnotts.rides.map((r) => r.id), ['k1', 'k2'], 'works with no Disney data at all');
});

test("Knott's is never mixed into a Disney day, and a Knott's day is only Knott's", () => {
  const snap = buildSnapshot({ tpw: { at: now, data: disneyLive }, kbf: { at: now, data: knottsLive }, hours }, catalog, now);
  const wanted = new Set(['dl1', 'k1', 'k2']);
  const base = { now, pos: { lat: 33.8121, lng: -117.919 }, posPark: null, gates: catalog.parks, wanted, done: new Set(), snoozed: {}, speed: 'normal', parks: snap.parks, lookahead: false };
  const hop = plan(snap.rides, { ...base, todayPark: null });
  assert.deepEqual(hop.ranked.map((e) => e.ride.id), ['dl1']);
  const kbf = plan(snap.rides, { ...base, todayPark: 'KBF', pos: { lat: 33.8442, lng: -117.9989 }, posPark: 'KBF' });
  assert.deepEqual(kbf.ranked.map((e) => e.ride.id).sort(), ['k1', 'k2']);
});

test("Knott's: nothing is suggested after the park closes, even while the feed still says OPERATING", () => {
  const snap = buildSnapshot({ kbf: { at: now, data: knottsLive }, hours }, catalog, now);
  const ctx = (t) => ({ now: t, pos: { lat: 33.8442, lng: -117.9989 }, posPark: 'KBF', gates: catalog.parks, wanted: new Set(['k1', 'k2']), done: new Set(), snoozed: {}, speed: 'normal', parks: snap.parks, lookahead: false, todayPark: 'KBF' });
  assert.equal(plan(snap.rides, ctx(T('2026-03-12T17:00:00-07:00'))).ranked.length, 2, 'open at 5 pm');
  const late = plan(snap.rides, ctx(T('2026-03-12T17:40:00-07:00')));
  assert.equal(late.ranked.length, 0, '5:40 pm: closed at 5:30, a lagging feed must not reopen it');
  assert.ok(late.excluded.some((x) => x.ride?.id === 'k1' && x.why === 'closes'));
});

test("Knott's thrills and heights", () => {
  assert.equal(feelOf('GhostRider'), 'thrill');
  assert.equal(feelOf('Xcelerator The Ride®'), 'thrill');
  assert.equal(feelOf('MonteZOOMa: The Forbidden Fortress'), 'thrill');
  assert.equal(feelOf("Knott's Bear-y Tales: Return to the Fair"), 'calm');
  assert.equal(feelOf('Timber Mountain Log Ride'), 'active');
  assert.equal(thrillPriority('medium', feelOf('Silver Bullet')), 'must');
  const info = { sb: { heightIn: 54 }, cr: { heightIn: 44 }, mine: { heightIn: null } };
  assert.deepEqual(tooShortFor(info, 53), { sb: 54 }, '53 in.: Silver Bullet out, Coast Rider with a companion in');
});
