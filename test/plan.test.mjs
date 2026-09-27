import test from 'node:test';
import assert from 'node:assert/strict';
import { mkRide, fixture } from './helpers.mjs';
import { plan, STICKY_MIN } from '../app/js/plan.js';
import { buildSnapshot, trimTpw } from '../app/js/sources.js';

const MIN = 60e3;
const NOW = Date.parse('2026-09-26T10:00:00-07:00');
const CLOSE = Date.parse('2026-09-26T23:00:00-07:00');
const HERE = { lat: 33.8121, lng: -117.919 };
const near = (minutes) => ({ lat: HERE.lat + (minutes * 72 / 1.3) / 111320, lng: HERE.lng });
const ctx = (over = {}) => ({
  now: NOW, pos: HERE, posPark: 'DL', wanted: new Set(['A', 'B', 'C']), done: new Set(), snoozed: {},
  speed: 'normal', hopMinutes: 20, ...over,
});

test('hysteresis: the previous pick stays on top when it is within a few minutes of the best', () => {
  const rides = [
    mkRide({ id: 'A', wait: 10, ...near(2), close: CLOSE }),
    mkRide({ id: 'B', wait: 10, ...near(3), close: CLOSE }),
  ];
  assert.equal(plan(rides, ctx()).ranked[0].ride.id, 'A');
  assert.equal(plan(rides, ctx(), { stickyId: 'B' }).ranked[0].ride.id, 'B');
});

test('hysteresis: a clearly better ride still takes over', () => {
  const rides = [
    mkRide({ id: 'A', wait: 10, ...near(2), close: CLOSE }),
    mkRide({ id: 'B', wait: 10 + 4 * STICKY_MIN, ...near(3), close: CLOSE }),
  ];
  assert.equal(plan(rides, ctx(), { stickyId: 'B' }).ranked[0].ride.id, 'A');
});

test('rope drop: before opening, rank rides as of opening time from the forecast', () => {
  const open = Date.parse('2026-09-26T08:00:00-07:00');
  const early = open - 45 * MIN;
  const fc = (w8, w9) => [{ t: open, wait: w8 }, { t: open + 60 * MIN, wait: w9 }];
  const rides = [
    mkRide({ id: 'A', status: 'CLOSED', wait: null, open, close: CLOSE, ...near(3), forecast: fc(45, 70) }),
    mkRide({ id: 'B', status: 'CLOSED', wait: null, open, close: CLOSE, ...near(3), forecast: fc(10, 10) }),
  ];
  const r = plan(rides, ctx({ now: early }));
  assert.equal(r.ranked.length, 0);
  assert.ok(r.ropeDrop);
  assert.equal(r.ropeDrop.at, open);
  assert.equal(r.ropeDrop.ranked.length, 2);
  assert.match(r.ropeDrop.ranked[0].reason, /forecast/);
});

test('no rope drop preview after closing', () => {
  const rides = [mkRide({ id: 'A', status: 'CLOSED', wait: null, open: NOW - 5 * 60 * MIN, close: NOW - 60 * MIN })];
  const r = plan(rides, ctx());
  assert.equal(r.ropeDrop, null);
});

test('buildSnapshot: trimmed ThemeParks.wiki payload normalizes the same as the full one', () => {
  const live = fixture('tpw-live-2026-09-26.json');
  const catalog = { parks: {}, rides: [] };
  const now = Date.parse('2026-09-26T19:20:00-07:00');
  const a = buildSnapshot({ tpw: { at: now, data: live } }, catalog, now);
  const b = buildSnapshot({ tpw: { at: now, data: trimTpw(live) } }, catalog, now);
  assert.deepEqual(b.rides, a.rides);
  assert.equal(b.at, now);
  assert.ok(JSON.stringify(trimTpw(live)).length < JSON.stringify(live).length);
});

test('buildSnapshot: newer Queue-Times data wins but keeps forecasts from the older snapshot', () => {
  const live = fixture('tpw-live-2026-09-26.json');
  const qt16 = fixture('qt-16-2026-09-26.json');
  const qt17 = fixture('qt-17-2026-09-26.json');
  const sm = live.liveData.find((e) => e.name === 'Space Mountain');
  const qtSm = qt16.lands.flatMap((l) => l.rides).find((r) => r.name === 'Space Mountain');
  const catalog = { parks: {}, rides: [{ id: sm.id, name: sm.name, park: 'DL', lat: 33.81, lng: -117.91, type: 'RIDE', qtId: qtSm.id }] };
  const now = Date.parse('2026-09-26T19:20:00-07:00');
  const snap = buildSnapshot({ tpw: { at: now - 20 * MIN, data: live }, qt: { at: now, data: [qt16, qt17] } }, catalog, now);
  assert.equal(snap.source, 'qt');
  assert.equal(snap.at, now);
  const r = snap.rides.find((x) => x.id === sm.id);
  assert.equal(r.wait, qtSm.is_open ? qtSm.wait_time : null);
  assert.ok(r.forecast && r.forecast.length > 0);
});
