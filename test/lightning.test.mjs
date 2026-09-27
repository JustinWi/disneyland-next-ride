import test from 'node:test';
import assert from 'node:assert/strict';
import { mkRide, fixture } from './helpers.mjs';
import { freshDay, forDay, nextBooking, takenIds, convertDown, dueBookings, adviseMulti, multiExpOptions, LL } from '../app/js/lightning.js';
import { plan } from '../app/js/plan.js';
import { normalizeTpw } from '../app/js/normalize.js';

const MIN = 60e3;
const NOW = Date.parse('2026-10-19T09:00:00-07:00');
const HERE = { lat: 33.8121, lng: -117.919 };
const near = (minutes) => ({ lat: HERE.lat + (minutes * 72 / 1.3) / 111320, lng: HERE.lng });
const lane = (start, over = {}) => ({ state: 'AVAILABLE', ...over, multi: { start, end: start + 60 * MIN } });
const mp = (over) => mkRide({ ll: { multi: null, single: null, singleRider: null, multiState: 'AVAILABLE', ...over.llx }, ...over });
const book = (rideId, bookedAt, start, over = {}) => ({ id: `${rideId}-${bookedAt}`, kind: 'multi', rideId, bookedAt, start, end: start + 60 * MIN, status: 'held', ...over });

test('next booking: after scan-in; then tap-in or 2 hours after booking, whichever first', () => {
  let st = freshDay('2026-10-19');
  assert.equal(nextBooking(st, NOW).why, 'scan');
  st = { ...st, scannedAt: NOW - 10 * MIN };
  assert.equal(nextBooking(st, NOW).why, 'now');
  st.bookings = [book('A', NOW, NOW + 90 * MIN)];
  const n = nextBooking(st, NOW + 5 * MIN);
  assert.equal(n.why, 'wait');
  assert.equal(n.at, NOW + LL.rebookMin * MIN);
  st.bookings = [book('A', NOW, NOW + 30 * MIN, { status: 'used', usedAt: NOW + 40 * MIN })];
  assert.equal(nextBooking(st, NOW + 41 * MIN).at, NOW + 40 * MIN);
  assert.equal(nextBooking(st, NOW + 41 * MIN).why, 'now');
  // a new park day starts fresh
  assert.equal(forDay(st, '2026-10-21').bookings.length, 0);
});

test('each attraction once per day; a booking turned Multiple Experience still counts for its ride', () => {
  const st = { ...freshDay('d'), scannedAt: NOW, bookings: [book('A', NOW, NOW), book('B', NOW, NOW, { multiExp: true }), book('C', NOW, NOW, { status: 'cancelled' })] };
  assert.deepEqual([...takenIds(st)].sort(), ['A', 'B']);
});

test('a ride that is down right now is not the lead booking pick (review M6)', () => {
  const rides = [
    mp({ id: 'X', wait: 60, status: 'DOWN', llx: { multi: { start: NOW + 30 * MIN, end: NOW + 90 * MIN } } }),
    mp({ id: 'Y', wait: 45, llx: { multi: { start: NOW + 30 * MIN, end: NOW + 90 * MIN } } }),
  ];
  const a = adviseMulti(rides, { now: NOW, todayPark: 'DL', wanted: new Set(['X', 'Y']), done: new Set() }, { ...freshDay('d'), scannedAt: NOW });
  assert.equal(a.recs[0].ride.id, 'Y');
  assert.match(a.recs[1].reason, /down right now/);
});

test('a held booking whose ride is DOWN during its window becomes a Multiple Experience pass', () => {
  const st = { ...freshDay('d'), scannedAt: NOW, bookings: [book('A', NOW - 60 * MIN, NOW - 10 * MIN), book('B', NOW - 60 * MIN, NOW + 60 * MIN)] };
  const rides = new Map([['A', mkRide({ id: 'A', status: 'DOWN' })], ['B', mkRide({ id: 'B', status: 'DOWN' })]]);
  const { st: out, converted } = convertDown(st, rides, NOW);
  assert.deepEqual(converted.map((b) => b.rideId), ['A']); // B's window hasn't started
  assert.ok(out.bookings[0].multiExp);
  assert.ok(!st.bookings[0].multiExp, 'input not mutated');
  assert.deepEqual(dueBookings(out, NOW).map((b) => b.rideId), ['A']);
});

test('advice: the big standby saving wins; sold-out and other-park rides are set aside', () => {
  const rides = [
    mp({ id: 'HM', name: 'Haunted Mansion', wait: 75, llx: { multi: { start: NOW + 60 * MIN, end: NOW + 120 * MIN } } }),
    mp({ id: 'SW', name: 'Small World', wait: 10, llx: { multi: { start: NOW + 20 * MIN, end: NOW + 80 * MIN } } }),
    mp({ id: 'SM', name: 'Space Mountain', wait: 60, llx: { multiState: 'FINISHED' } }),
    mp({ id: 'BT', name: 'Big Thunder', wait: 50, llx: { multi: { start: Date.parse('2026-10-19T13:30:00-07:00'), end: Date.parse('2026-10-19T14:30:00-07:00') } } }),
    mp({ id: 'GR', name: 'Grizzly', park: 'DCA', wait: 60, llx: { multi: { start: NOW + 30 * MIN, end: NOW + 90 * MIN } } }),
    mkRide({ id: 'PP', name: 'Peter Pan', wait: 50 }), // no Lightning Lane at all
  ];
  const st = { ...freshDay('d'), scannedAt: NOW };
  const a = adviseMulti(rides, { now: NOW, todayPark: 'DL', wanted: new Set(rides.map((r) => r.id)), done: new Set(), priority: { SW: 'must' } }, st);
  assert.deepEqual(a.recs.map((x) => x.ride.id), ['HM', 'BT', 'SW']);
  assert.match(a.recs[0].reason, /return ~10 am, saves ~65 min of standby/);
  assert.deepEqual(a.soldOut.map((x) => x.ride.id), ['SM']);
  assert.deepEqual(a.skipped, []);
  // once booked, not offered again today
  const st2 = { ...st, bookings: [book('HM', NOW, NOW + 60 * MIN)] };
  assert.deepEqual(adviseMulti(rides, { now: NOW, todayPark: 'DL', wanted: new Set(rides.map((r) => r.id)), done: new Set() }, st2).recs.map((x) => x.ride.id), ['BT', 'SW']);
});

test('advice on the real 7:20 pm snapshot: only live Multi Pass rides, sold out reported', () => {
  const snap = normalizeTpw(fixture('tpw-live-2026-09-26.json'), { parks: {}, rides: [] }, { now: Date.parse('2026-09-26T19:20:00-07:00') });
  const wanted = new Set(snap.rides.map((r) => r.id));
  const a = adviseMulti(snap.rides, { now: snap.at, todayPark: 'DL', wanted, done: new Set() }, { ...freshDay('d'), scannedAt: snap.at });
  const names = a.recs.map((x) => x.ride.name);
  assert.ok(names.includes('Big Thunder Mountain Railroad'));
  assert.ok(!names.includes("Peter Pan's Flight"), 'Peter Pan has no Lightning Lane');
  assert.ok(a.soldOut.some((x) => x.ride.name === 'Space Mountain'));
  for (const x of a.recs) assert.ok(x.start >= snap.at - 5 * MIN && x.saved >= 0);
});

test('Multiple Experience options: running Multi Pass rides in the park, your list first, longest wait first', () => {
  const rides = [
    mp({ id: 'A', wait: 30, status: 'DOWN' }),
    mp({ id: 'B', wait: 20 }),
    mp({ id: 'C', wait: 60 }),
    mp({ id: 'D', wait: 90 }),
    mkRide({ id: 'E', wait: 100 }),
  ];
  const o = multiExpOptions(rides, { todayPark: 'DL', wanted: new Set(['B', 'C']), done: new Set() }, 'A');
  assert.deepEqual(o.map((x) => x.ride.id), ['C', 'B', 'D']);
});

// ---- planner rules for the trip ----

const ctx = (over = {}) => ({ now: NOW, pos: HERE, posPark: 'DL', wanted: new Set(['A', 'B', 'C']), done: new Set(), snoozed: {}, speed: 'normal', hopMinutes: 20, ...over });

test('today\'s park: rides in the other park are not considered at all', () => {
  const rides = [mkRide({ id: 'A', wait: 10 }), mkRide({ id: 'B', park: 'DCA', wait: 5 })];
  const r = plan(rides, ctx({ todayPark: 'DL' }));
  assert.deepEqual(r.ranked.map((e) => e.ride.id), ['A']);
  assert.ok(!JSON.stringify(r.excluded).includes('"B"'));
});

test('locked rides and rides you hold a Lightning Lane for are set aside with a reason', () => {
  const rides = [mkRide({ id: 'A', wait: 10 }), mkRide({ id: 'B', wait: 10 }), mkRide({ id: 'C', wait: 10 })];
  const lanes = [book('B', NOW - 30 * MIN, NOW + 30 * MIN)];
  const r = plan(rides, ctx({ locked: { C: 'unlocks after Big Thunder goes well' }, lanes }));
  assert.deepEqual(r.ranked.map((e) => e.ride.id), ['A']);
  const why = Object.fromEntries(r.excluded.map((x) => [x.ride.id, x.why]));
  assert.deepEqual(why, { C: 'locked', B: 'lane' });
});

test('a long standby that would make you miss your Lightning Lane window is moved to clash', () => {
  const rides = [
    mkRide({ id: 'A', wait: 50, ...near(3) }), // done at ~10:00, the window ends 9:40
    mkRide({ id: 'B', wait: 5, ...near(3) }),
    mkRide({ id: 'L', wait: 60, ...near(4) }),
  ];
  const lanes = [book('L', NOW - 30 * MIN, NOW - 20 * MIN)]; // 8:40 to 9:40
  const r = plan(rides, ctx({ wanted: new Set(['A', 'B', 'L']), lanes }));
  assert.deepEqual(r.ranked.map((e) => e.ride.id), ['B']);
  assert.match(r.clash[0].detail, /miss your Lightning Lane/);
});

test('priority: a must-do gets a head start over an otherwise equal ride', () => {
  const rides = [mkRide({ id: 'A', wait: 20, ...near(3) }), mkRide({ id: 'B', wait: 25, ...near(3) })];
  const r = plan(rides, ctx({ wanted: new Set(['A', 'B']), bias: { B: -15 } }));
  assert.equal(r.ranked[0].ride.id, 'B');
});
