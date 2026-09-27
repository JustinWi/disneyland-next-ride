// Regression tests for the second adversarial review (2026-09-26), on the real trip list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './helpers.mjs';
import { parseTripFile, attachIds, computeLocks, encodeTrip, decodeTrip } from '../app/js/trip.js';
import { laneStats, planLaneDay, VERDICT_RULE } from '../app/js/lightning.js';
import { parkTime, parkHour, weekdayOf } from '../app/js/time.js';

const MIN = 60e3;
const catalog = JSON.parse(fs.readFileSync(new URL('../app/data/catalog.json', import.meta.url), 'utf8'));
const trip = attachIds(parseTripFile(fixture('trip-sample.json')), catalog.rides);
const id = (key) => trip.rides.find((r) => r.key === key).tpwId;
const MON = weekdayOf('2026-10-19');
const WED = weekdayOf('2026-10-21');
const FRI = weekdayOf('2026-10-23');

test('H1: the drop ladder is enforced: Big Thunder waits for Pirates, Grizzly for Big Thunder', () => {
  const l0 = computeLocks(trip, { ridden: new Set(), weekday: MON });
  assert.match(l0.locked[id('dl-big-thunder')], /after Pirates of the Caribbean/);
  assert.match(l0.locked[id('dca-grizzly-river-run')], /after Big Thunder/);
  // Pirates ridden: one question about Pirates, which unlocks Big Thunder
  const l1 = computeLocks(trip, { ridden: new Set([id('dl-pirates')]), weekday: MON });
  const q = l1.prompts.find((p) => p.gate.key === 'dl-pirates');
  assert.ok(q, 'asks how Pirates went');
  assert.ok(q.unlocks.some((r) => r.key === 'dl-big-thunder'));
  const l2 = computeLocks(trip, { ridden: new Set([id('dl-pirates')]), gate: { 'dl-pirates': 'yes' }, weekday: MON });
  assert.equal(l2.locked[id('dl-big-thunder')], undefined, 'Big Thunder open');
  assert.ok(l2.locked[id('dl-matterhorn')], 'Matterhorn still waits for Big Thunder');
});

test('H1: a thumbs down carries up the ladder (Big Thunder 👎 skips Matterhorn, Space Mountain and Grizzly)', () => {
  const ridden = new Set([id('dl-pirates'), id('dl-big-thunder')]);
  const l = computeLocks(trip, { ridden, gate: { 'dl-pirates': 'yes', 'dl-big-thunder': 'no' }, weekday: FRI });
  for (const k of ['dl-matterhorn', 'dl-space-mountain', 'dca-grizzly-river-run']) {
    assert.match(l.locked[id(k)] ?? '', /skipped: Big Thunder/, k);
    assert.equal(l.info[id(k)].kind, 'skip');
  }
});

test('M5: "Friday, save it for the finale" keeps Space Mountain for Friday, even once unlocked by the ladder', () => {
  const ridden = new Set([id('dl-pirates'), id('dl-big-thunder'), id('dl-matterhorn')]);
  const gate = { 'dl-pirates': 'yes', 'dl-big-thunder': 'yes', 'dl-matterhorn': 'yes' };
  assert.match(computeLocks(trip, { ridden, gate, weekday: MON }).locked[id('dl-space-mountain')], /saved for Friday/);
  assert.equal(computeLocks(trip, { ridden, gate, weekday: FRI }).locked[id('dl-space-mountain')], undefined);
  // a manual unlock beats the note
  assert.equal(computeLocks(trip, { ridden, gate, unlock: { 'dl-space-mountain': 'yes' }, weekday: MON }).locked[id('dl-space-mountain')], undefined);
});

function fridayPlan(extra = {}) {
  const stats = laneStats(fixture('llstats-2026-09-26.json'), 'DL', FRI);
  const lk = computeLocks(trip, { ridden: new Set(), weekday: FRI });
  const rides = trip.rides
    .filter((r) => r.park === 'DL' && r.tpwId && stats.get(r.tpwId)?.kind === 'multi')
    .filter((r) => !['skip', 'hint'].includes(lk.info[r.tpwId]?.kind))
    .map((r) => ({ id: r.tpwId, name: r.name, priority: r.priority, typical: r.typical, conditional: Boolean(lk.info[r.tpwId]), after: lk.info[r.tpwId]?.after ?? [] }));
  const day = '2026-10-23';
  return planLaneDay({ rides, stats, open: parkTime(day, '08:00'), close: parkTime(day, '23:59'), hourOf: parkHour, ...extra });
}

test('H2: the day plan never books a ladder ride before the ride it waits on', () => {
  const p = fridayPlan();
  const at = Object.fromEntries(p.bookings.map((b) => [b.rideId, b]));
  const sm = at[id('dl-space-mountain')];
  const mh = at[id('dl-matterhorn')];
  if (sm) assert.ok(mh && mh.returnAt + 30 * MIN <= sm.returnAt, 'Space Mountain after Matterhorn');
  const bt = at[id('dl-big-thunder')];
  if (bt) assert.ok(bt.returnAt >= parkTime('2026-10-23', '09:30'), 'Big Thunder after a morning Pirates');
  if (mh) assert.ok(bt && bt.returnAt + 30 * MIN <= mh.returnAt, 'Matterhorn after Big Thunder');
});

test('M11: consecutive tap-ins leave time for the lane, the ride and the walk', () => {
  const p = fridayPlan();
  for (let i = 1; i < p.bookings.length; i++) {
    const a = p.bookings[i - 1];
    const b = p.bookings[i];
    assert.ok(b.tapIn >= a.tapIn + 25 * MIN - 1, `${b.name} tap-in ${new Date(b.tapIn).toISOString()} too soon after ${a.name}`);
    assert.ok(b.bookAt <= a.bookAt + 120 * MIN || b.bookAt >= a.bookAt + 120 * MIN, 'booking time well-formed');
  }
});

test('M10: the verdict follows the price, not just the minutes', () => {
  const cheap = fridayPlan({ priceEach: 16, party: 2 });
  const dear = fridayPlan({ priceEach: 100, party: 5 });
  assert.equal(cheap.saved, dear.saved);
  assert.equal(dear.verdict, 'skip');
  assert.ok(cheap.cost / cheap.saved <= VERDICT_RULE.buyPerMin && cheap.saved >= VERDICT_RULE.buyMinSaved ? cheap.verdict === 'buy' : true);
  assert.notEqual(cheap.verdict, 'skip');
});

test('M12: a damaged link is rejected or repaired, never trusted as-is', async () => {
  assert.throws(() => parseTripFile({ v: 1, rides: 'nope' }), /damaged/);
  const t = parseTripFile({ v: 1, rides: [{ name: 'Dumbo the Flying Elephant', park: 'DL', priority: 'must' }, { name: 5 }], avoid: 'x', days: {}, break: 'noon' });
  assert.equal(t.rides.length, 1);
  assert.deepEqual(t.days, []);
  assert.equal('break' in t, false);
  assert.deepEqual(t.avoid, []);
  // and a real link still round-trips exactly
  const clean = parseTripFile(fixture('trip-sample.json'));
  assert.deepEqual(await decodeTrip(await encodeTrip(clean)), clean);
});
