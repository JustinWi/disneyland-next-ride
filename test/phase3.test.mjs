// Justin's picks from the feature menu (2026-09-27): reminders, shows, Single Pass advice, arrival plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkRide, fixture } from './helpers.mjs';
import { laneAlerts, bookNextAlert, lastChanceAlerts, statusAlerts, showAlerts, finalClose } from '../app/js/alerts.js';
import { classifyShow, showsToday, ridesThatEmpty, nextTime } from '../app/js/shows.js';
import { singlePassAdvice } from '../app/js/lightning.js';
import { arrivalPlan } from '../app/js/plan.js';
import { trimTpw } from '../app/js/sources.js';
import { parkHour } from '../app/js/time.js';

const MIN = 60e3;
const NOW = Date.parse('2026-10-19T11:00:00-07:00');
const name = (id) => `Ride ${id}`;

test('R1: lane reminders 15 min before the window opens and 15 min before it ends, not for used ones', () => {
  const b = { id: 'b1', kind: 'multi', rideId: 'X', start: NOW + 10 * MIN, end: NOW + 70 * MIN, status: 'held' };
  assert.deepEqual(laneAlerts([b], NOW, name).map((a) => a.key), ['lane-open-b1']);
  assert.deepEqual(laneAlerts([b], NOW - 10 * MIN, name), []);
  assert.deepEqual(laneAlerts([b], NOW + 60 * MIN, name).map((a) => a.key), ['lane-end-b1']);
  assert.deepEqual(laneAlerts([{ ...b, status: 'used' }], NOW, name), []);
});

test('R2: "book your next" fires once per booking cycle, only with Lightning Lane on', () => {
  const recs = [{ ride: { name: 'Haunted Mansion' }, reason: 'return ~11:20 am' }];
  assert.deepEqual(bookNextAlert({ llOn: 'on', next: { why: 'now' }, recs }).map((a) => a.key), ['book-first']);
  assert.deepEqual(bookNextAlert({ llOn: 'on', next: { why: 'now', last: { id: 'b7' } }, recs }).map((a) => a.key), ['book-b7']);
  assert.deepEqual(bookNextAlert({ llOn: 'off', next: { why: 'now' }, recs }), []);
  assert.deepEqual(bookNextAlert({ llOn: 'on', next: { why: 'wait' }, recs }), []);
  assert.deepEqual(bookNextAlert({ llOn: 'on', next: { why: 'scan' }, recs }), []);
});

test('R4: last-chance only for must-dos not yet ridden, within 45 minutes of the final close', () => {
  const windows = [{ open: NOW - 3 * 3600e3, close: NOW + 30 * MIN }, { open: NOW + 2 * 3600e3, close: NOW + 3 * 3600e3 }];
  const rides = [
    mkRide({ id: 'M', name: 'Dumbo', close: NOW + 30 * MIN }),
    mkRide({ id: 'P', name: 'Pause', close: NOW + 30 * MIN, windows }),
    mkRide({ id: 'H', name: 'High', close: NOW + 30 * MIN }),
  ];
  const base = { rides, wanted: new Set(['M', 'P', 'H']), done: new Set(), priority: { M: 'must', P: 'must', H: 'high' }, now: NOW };
  assert.deepEqual(lastChanceAlerts(base).map((a) => a.key), ['last-M'], 'a ride that reopens later is not "last chance"');
  assert.deepEqual(lastChanceAlerts({ ...base, done: new Set(['M']) }), []);
  assert.equal(finalClose(rides[1], NOW), NOW + 3 * 3600e3);
});

test('C1 and C2: back-up and just-went-down alerts fire on the change, never on the first look', () => {
  const r1 = [mkRide({ id: 'A', name: 'Peter Pan', status: 'DOWN' }), mkRide({ id: 'B', name: 'Space', status: 'OPERATING' })];
  const first = statusAlerts({ rides: r1, prev: {}, wanted: new Set(['A', 'B']), done: new Set(), headingTo: 'B', now: NOW });
  assert.deepEqual(first.alerts, []);
  const r2 = [mkRide({ id: 'A', name: 'Peter Pan', status: 'OPERATING', wait: 20 }), mkRide({ id: 'B', name: 'Space', status: 'DOWN' })];
  const second = statusAlerts({ rides: r2, prev: first.status, wanted: new Set(['A', 'B']), done: new Set(), headingTo: 'B', nextBest: { id: 'A', name: 'Peter Pan' }, now: NOW });
  assert.deepEqual(second.alerts.map((a) => a.kind).sort(), ['down', 'up']);
  assert.match(second.alerts.find((a) => a.kind === 'up').title, /back up, 20 min wait/);
  assert.match(second.alerts.find((a) => a.kind === 'down').body, /Next best from here: Peter Pan/);
  // not on the list: silent
  assert.deepEqual(statusAlerts({ rides: r2, prev: first.status, wanted: new Set(), done: new Set(), now: NOW }).alerts, []);
});

test('R5 and P3: shows from the real feed, with kinds, lead times and reminders', () => {
  const live = fixture('tpw-live-2026-09-26.json');
  const trimmed = trimTpw(live);
  assert.ok(trimmed.liveData.some((e) => e.entityType === 'SHOW'), 'the stored snapshot keeps show times');
  const parkOf = (pid) => (pid === '7340550b-c14d-4def-80bb-acdb51d49a66' ? 'DL' : 'DCA');
  const shows = showsToday(trimmed.liveData.filter((e) => e.entityType === 'SHOW'), parkOf, Date.parse('2026-09-26T19:20:00-07:00'));
  assert.ok(shows.length > 0);
  assert.ok(shows.every((s) => s.times.length && s.times.every((t) => Number.isFinite(t))));
  assert.equal(classifyShow('Halloween Screams with Fireworks').kind, 'fireworks');
  assert.equal(classifyShow('Fantasmic!').lead, 50);
  assert.equal(classifyShow('Mickey and Friends Halloween Cavalcade').kind, 'parade');
  const fw = { id: 'fw', name: 'Fireworks', times: [NOW + 50 * MIN], lead: 40, tip: null };
  assert.deepEqual(showAlerts([fw], NOW, () => true).map((a) => a.key), [`show-fw-${NOW + 50 * MIN}`]);
  assert.match(showAlerts([fw], NOW, () => true)[0].body, /Leave by 11:10 am/, 'the reminder comes before the leave-by time');
  assert.deepEqual(showAlerts([fw], NOW - 10 * MIN, () => true), [], 'not more than 15 minutes before leave-by');
  assert.match(showAlerts([fw], NOW + 20 * MIN, () => true)[0].body, /Head there now/, 'never a leave-by time in the past');
  assert.deepEqual(showAlerts([fw], NOW, () => false), []);
  assert.equal(nextTime({ times: [NOW - 60 * MIN, NOW + 10 * MIN] }, NOW), NOW + 10 * MIN);
});

test('P3: rides that usually empty out during a show', () => {
  const stats = new Map([
    ['A', { standby: { 20: 60, 21: 35 } }],
    ['B', { standby: { 20: 20, 21: 15 } }],
    ['C', { standby: { 20: 40, 21: 45 } }],
  ]);
  assert.deepEqual(ridesThatEmpty(stats, ['A', 'B', 'C'], 21).map((x) => x.id), ['A']);
});

test('L2: Single Pass advice: ride now when short, wait for a real low point, otherwise buy', () => {
  const close = NOW + 10 * 3600e3;
  const flat = (w) => [{ t: NOW, wait: w }, { t: close, wait: w }];
  const short = singlePassAdvice(mkRide({ wait: 25, forecast: flat(25) }), { now: NOW, close, hourOf: parkHour });
  assert.equal(short.kind, 'now');
  const dropping = singlePassAdvice(mkRide({ wait: 90, forecast: [{ t: NOW, wait: 90 }, { t: NOW + 8 * 3600e3, wait: 40 }], ll: { singlePrice: '$25.00' } }), { now: NOW, close, hourOf: parkHour });
  assert.equal(dropping.kind, 'wait');
  assert.match(dropping.text, /usually drops to about/);
  const long = singlePassAdvice(mkRide({ wait: 90, forecast: flat(90), ll: { singlePrice: '$25.00' } }), { now: NOW, close, hourOf: parkHour });
  assert.equal(long.kind, 'buy');
  assert.match(long.text, /Single Pass \(\$25\.00\) saves about 80 min/);
});

test('E17: arrival plan starts from the gate at your arrival time and names a route', () => {
  const gate = { lat: 33.80955, lng: -117.91895 };
  const up = (m) => ({ lat: gate.lat + (m * 72 / 1.3) / 111320, lng: gate.lng });
  const rides = [
    mkRide({ id: 'A', wait: 20, ...up(8) }),
    mkRide({ id: 'B', wait: 20, ...up(9) }),
    mkRide({ id: 'C', wait: 20, ...up(10) }),
    mkRide({ id: 'X', park: 'DCA', wait: 5, ...up(3) }),
  ];
  const p = arrivalPlan(rides, { now: NOW, pos: null, posPark: null, wanted: new Set(['A', 'B', 'C', 'X']), done: new Set(), speed: 'normal', hopMinutes: 20 }, { park: 'DL', gate, eta: NOW + 20 * MIN });
  assert.ok(p);
  assert.equal(p.eta, NOW + 20 * MIN);
  assert.deepEqual(p.steps.map((e) => e.ride.id), ['A', 'B', 'C'], 'nearest first, other park left out');
});

import { similarRides, tooShortFor } from '../app/js/similar.js';

test('C4: substitutes are running rides in the same park that feel alike, not avoided or ridden', () => {
  const info = {
    TEA: { tags: ['spin', 'outdoor'], intensity: 2 },
    ORB: { tags: ['spin', 'outdoor'], intensity: 2 },
    RR: { tags: ['spin', 'dark', 'indoor'], intensity: 2 },
    SM: { tags: ['coaster', 'dark'], intensity: 4 },
    DCA1: { tags: ['spin'], intensity: 2 },
    AV: { tags: ['spin'], intensity: 2 },
  };
  const rides = [
    { id: 'TEA', park: 'DL', status: 'REFURBISHMENT' },
    { id: 'ORB', park: 'DL', status: 'OPERATING', wait: 20 },
    { id: 'RR', park: 'DL', status: 'OPERATING', wait: 10 },
    { id: 'SM', park: 'DL', status: 'OPERATING', wait: 5 },
    { id: 'DCA1', park: 'DCA', status: 'OPERATING', wait: 5 },
    { id: 'AV', park: 'DL', status: 'OPERATING', wait: 5 },
  ];
  assert.deepEqual(similarRides('TEA', { info, rides, exclude: new Set(['AV']) }).map((x) => x.ride.id), ['ORB', 'RR']);
  assert.deepEqual(similarRides('TEA', { info: null, rides }), []);
});

test('F5: height check flags only rides with a minimum above the entered height', () => {
  const info = { A: { heightIn: 40 }, B: { heightIn: 48 }, C: { heightIn: null } };
  assert.deepEqual(tooShortFor(info, 46), { B: 48 });
  assert.deepEqual(tooShortFor(info, null), {});
});

import fs from 'node:fs';

test('ride facts: every catalog ride has an entry; key height minimums are right', () => {
  const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
  const catalog = read('../app/data/catalog.json');
  const facts = read('../app/data/rideinfo.json').rides;
  for (const r of catalog.rides) {
    assert.ok(facts[r.id], `${r.name} missing`);
    assert.ok(facts[r.id].heightIn === null || Number.isFinite(facts[r.id].heightIn), r.name);
    assert.ok((facts[r.id].expect ?? '').length <= 110, r.name);
  }
  const h = (name) => facts[catalog.rides.find((r) => r.name === name).id].heightIn;
  assert.equal(h('Big Thunder Mountain Railroad'), 40);
  assert.equal(h('Matterhorn Bobsleds'), 42);
  assert.equal(h('Space Mountain'), 40);
  assert.equal(h('Incredicoaster'), 48);
  assert.equal(h('Radiator Springs Racers'), 40);
  assert.equal(h('Pirates of the Caribbean'), null);
});
