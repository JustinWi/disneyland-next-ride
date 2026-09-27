// Third review (2026-09-27): regression tests for the reproduced findings on reminders, the
// arrival plan, routes, Lightning Lane options and seasonal twins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkRide } from './helpers.mjs';
import { statusAlerts, mergeBanners, laneAlerts } from '../app/js/alerts.js';
import { showsToday } from '../app/js/shows.js';
import { arrivalPlan, plan } from '../app/js/plan.js';
import { multiExpOptions, singlePassAdvice } from '../app/js/lightning.js';
import { twinIds } from '../app/js/trip.js';
import { parkHour } from '../app/js/time.js';

const MIN = 60e3;
const H = 3600e3;
const NOW = Date.parse('2026-10-19T11:00:00-07:00');

test('"back up" has one key per ride, so it shows once per park day', () => {
  const up = [mkRide({ id: 'A', name: 'Alice', status: 'OPERATING', wait: 15 })];
  const w = new Set(['A']);
  const a1 = statusAlerts({ rides: up, prev: { A: 'DOWN' }, wanted: w, done: new Set(), now: NOW }).alerts;
  const a2 = statusAlerts({ rides: up, prev: { A: 'DOWN' }, wanted: w, done: new Set(), now: NOW + 3 * H }).alerts;
  assert.equal(a1.length, 1);
  assert.equal(a1[0].key, a2[0].key);
});

test('no "back up" for rides the plan set aside (locked, too short, snoozed)', () => {
  const r = statusAlerts({ rides: [mkRide({ id: 'S', status: 'OPERATING' })], prev: { S: 'DOWN' }, wanted: new Set(['S']), done: new Set(), skip: new Set(['S']), now: NOW });
  assert.deepEqual(r.alerts, []);
});

test('rides restarting after a scheduled fireworks pause are not "back up" news', () => {
  const windows = [{ open: NOW - 12 * H, close: NOW - 2 * H }, { open: NOW - 10 * MIN, close: NOW + H }];
  const r = statusAlerts({ rides: [mkRide({ id: 'F', status: 'OPERATING', windows })], prev: { F: 'DOWN' }, wanted: new Set(['F']), done: new Set(), now: NOW });
  assert.deepEqual(r.alerts, []);
});

test('going down at a scheduled pause says when it reopens', () => {
  const windows = [{ open: NOW - 12 * H, close: NOW - 5 * MIN }, { open: NOW + 90 * MIN, close: NOW + 3 * H }];
  const r = statusAlerts({ rides: [mkRide({ id: 'T', name: 'Toad', status: 'DOWN', windows })], prev: { T: 'OPERATING' }, wanted: new Set(['T']), done: new Set(), headingTo: 'T', now: NOW });
  assert.match(r.alerts[0].body, /scheduled to reopen at 12:30 pm/);
});

test('status news never pushes a Lightning Lane reminder off the screen', () => {
  const lane = { key: 'lane-open-b1', kind: 'lane', title: 'Lightning Lane soon' };
  const ups = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ key: `up-${id}`, kind: 'up', title: `${id} back up`, short: id }));
  const out = mergeBanners([], [lane, ...ups]);
  assert.ok(out.some((b) => b.key === 'lane-open-b1'));
  assert.equal(out.filter((b) => b.kind === 'up').length, 1, 'several at once become one banner');
  assert.match(out.find((b) => b.kind === 'up').title, /5 rides/);
  const full = mergeBanners([lane, { key: 's1', kind: 'show' }, { key: 's2', kind: 'show' }, { key: 'l1', kind: 'last' }], [{ key: 'd1', kind: 'down' }]);
  assert.equal(full.length, 4);
  assert.ok(full.some((b) => b.key === 'lane-open-b1') && full.some((b) => b.key === 'd1'));
});

test('an already-open return window says so, and a later first look still reminds', () => {
  const b = { id: 'b1', kind: 'multi', rideId: 'X', start: NOW - MIN, end: NOW + 59 * MIN, status: 'held' };
  assert.match(laneAlerts([b], NOW, () => 'Pirates')[0].title, /open: Pirates/);
  assert.equal(laneAlerts([b], NOW + 10 * MIN, () => 'Pirates')[0].key, 'lane-open-b1');
});

test('all-day meet areas and cardmember events are not shows', () => {
  const at = (h, m = 0) => `2026-10-19T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-07:00`;
  const shows = [
    { id: 'avg', name: 'Avengers Headquarters', status: 'OPERATING', showtimes: [{ type: 'Performance Time', startTime: at(8), endTime: at(21) }] },
    { id: 'visa', name: 'Disney Visa Cardmember Heroic Encounter', status: 'OPERATING', showtimes: [{ type: 'Performance Time', startTime: at(15), endTime: at(15, 30) }] },
    { id: 'fw', name: 'Fireworks', status: 'OPERATING', showtimes: [{ type: 'Performance Time', startTime: at(21, 30), endTime: at(21, 45) }] },
  ];
  assert.deepEqual(showsToday(shows, () => 'DL', NOW).map((s) => s.id), ['fw']);
});

const gate = { lat: 33.80955, lng: -117.91895 };
const up = (m) => ({ lat: gate.lat + (m * 72) / 1.3 / 111320, lng: gate.lng });
const base = { pos: null, posPark: null, done: new Set(), speed: 'normal', hopMinutes: 20 };

test('arrival plan sets aside a ride you hold a Lightning Lane for', () => {
  const rides = [mkRide({ id: 'P', wait: 10, ...up(5) }), mkRide({ id: 'B', wait: 20, ...up(9) }), mkRide({ id: 'C', wait: 20, ...up(10) })];
  const lanes = [{ id: 'l1', kind: 'multi', rideId: 'P', start: NOW + 50 * MIN, end: NOW + 110 * MIN, status: 'held' }];
  const p = arrivalPlan(rides, { ...base, now: NOW, wanted: new Set(['P', 'B', 'C']), lanes }, { park: 'DL', gate, eta: NOW + 20 * MIN });
  assert.ok(p && !p.steps.some((e) => e.ride.id === 'P'));
});

test('arriving before opening plans from opening time, with rides closed now', () => {
  const open = NOW + 60 * MIN;
  const close = NOW + 12 * H;
  const rides = ['A', 'B', 'C'].map((id, i) =>
    mkRide({ id, status: 'CLOSED', wait: null, open, close, windows: [{ open, close }], forecast: [{ t: open, wait: 10 + i }, { t: close, wait: 10 + i }], ...up(8 + i) }),
  );
  const p = arrivalPlan(rides, { ...base, now: NOW, wanted: new Set(['A', 'B', 'C']), parks: { DL: { open, close } } }, { park: 'DL', gate, eta: NOW + 30 * MIN });
  assert.ok(p);
  assert.equal(p.at, open);
  assert.equal(p.steps.length, 3);
});

test('with no park hours in the feed yet, the arrival plan gives the rope-drop order', () => {
  const open = NOW + 60 * MIN;
  const rides = ['A', 'B'].map((id, i) => mkRide({ id, status: 'CLOSED', wait: null, open, close: NOW + 12 * H, ...up(8 + i) }));
  const p = arrivalPlan(rides, { ...base, now: NOW, wanted: new Set(['A', 'B']) }, { park: 'DL', gate, eta: NOW + 20 * MIN });
  assert.ok(p?.ropeDrop);
  assert.equal(p.at, open);
});

test('arrival plan leaves out a ride that pauses before you get there', () => {
  const windows = [{ open: NOW - 3 * H, close: NOW + 15 * MIN }, { open: NOW + 3 * H, close: NOW + 5 * H }];
  const rides = [mkRide({ id: 'T', wait: 5, windows, ...up(5) }), mkRide({ id: 'B', wait: 20, ...up(9) })];
  const p = arrivalPlan(rides, { ...base, now: NOW, wanted: new Set(['T', 'B']) }, { park: 'DL', gate, eta: NOW + 45 * MIN });
  assert.deepEqual(p.steps.map((e) => e.ride.id), ['B']);
});

test('a route never lands on a ride during its fireworks pause', () => {
  const windows = [{ open: NOW - 3 * H, close: NOW + 10 * MIN }, { open: NOW + 2 * H, close: NOW + 5 * H }];
  const rides = [mkRide({ id: 'A', wait: 20, ...up(3) }), mkRide({ id: 'P', wait: 5, windows, ...up(4) }), mkRide({ id: 'C', wait: 25, ...up(6) })];
  const r = plan(rides, { ...base, now: NOW, pos: gate, posPark: 'DL', todayPark: 'DL', wanted: new Set(['A', 'P', 'C']) });
  for (const e of r.ranked) for (const s of e.route) if (s.entry.ride.id === 'P') assert.ok(s.arrive <= NOW + 10 * MIN, 'P only before its pause');
});

test('Multiple Experience options leave out locked and too-short rides', () => {
  const ll = { multiState: 'AVAILABLE' };
  const rides = [mkRide({ id: 'X', ll }), mkRide({ id: 'L', ll }), mkRide({ id: 'OK', ll })];
  assert.deepEqual(multiExpOptions(rides, { locked: { L: 'height minimum 42 in.' } }, 'X').map((o) => o.ride.id), ['OK']);
});

test('a sold-out Single Pass is never the advice', () => {
  const close = NOW + 10 * H;
  const flat = [{ t: NOW, wait: 90 }, { t: close, wait: 90 }];
  const a = singlePassAdvice(mkRide({ wait: 90, forecast: flat, ll: { singlePrice: '$25.00', singleState: 'FINISHED' } }), { now: NOW, close, hourOf: parkHour });
  assert.equal(a.kind, 'standby');
  assert.doesNotMatch(a.text, /\$25/);
});

test('avoiding Guardians avoids its Halloween version, and nothing else', () => {
  const cat = [
    { id: 'g1', park: 'DCA', name: 'Guardians of the Galaxy - Mission: BREAKOUT!' },
    { id: 'g2', park: 'DCA', name: 'Guardians of the Galaxy - Monsters After Dark' },
    { id: 'x', park: 'DCA', name: 'Incredicoaster' },
  ];
  assert.deepEqual(twinIds('g1', cat), ['g2']);
  assert.deepEqual(twinIds('g2', cat), ['g1']);
  assert.deepEqual(twinIds('x', cat), []);
});
