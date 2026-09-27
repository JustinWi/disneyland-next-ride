import test from 'node:test';
import assert from 'node:assert/strict';
import { mkRide } from './helpers.mjs';
import { plan } from '../app/js/plan.js';

const MIN = 60e3;
const NOW = Date.parse('2026-10-19T11:00:00-07:00');
const CLOSE = Date.parse('2026-10-19T23:00:00-07:00');
const HERE = { lat: 33.8121, lng: -117.919 };
// place a ride `m` walking minutes north (+) or south (-) of HERE
const at = (m) => ({ lat: HERE.lat + (m * 72 / 1.3) / 111320, lng: HERE.lng });
const ctx = (over = {}) => ({ now: NOW, pos: HERE, posPark: 'DL', done: new Set(), snoozed: {}, speed: 'normal', hopMinutes: 20, ...over });

test('look-ahead: heads for a cluster of three rides rather than a slightly better single ride the other way', () => {
  const rides = [
    mkRide({ id: 'B', name: 'Lone ride south', wait: 15, ...at(-5), close: CLOSE }),
    mkRide({ id: 'A1', name: 'North 1', wait: 16, ...at(6), close: CLOSE }),
    mkRide({ id: 'A2', name: 'North 2', wait: 16, ...at(7), close: CLOSE }),
    mkRide({ id: 'A3', name: 'North 3', wait: 16, ...at(8), close: CLOSE }),
  ];
  const wanted = new Set(rides.map((r) => r.id));
  const alone = plan(rides, ctx({ wanted, lookahead: false }));
  assert.equal(alone.ranked[0].ride.id, 'B', 'one ride at a time picks the lone ride');
  const r = plan(rides, ctx({ wanted }));
  assert.equal(r.ranked[0].ride.id, 'A1');
  assert.deepEqual(r.ranked[0].route.map((s) => s.entry.ride.id), ['A2', 'A3']);
});

test('look-ahead: a route never repeats a ride and has at most two follow-ups', () => {
  const rides = Array.from({ length: 8 }, (_, i) => mkRide({ id: `R${i}`, wait: 10 + i * 3, ...at(i - 4), close: CLOSE }));
  const r = plan(rides, ctx({ wanted: new Set(rides.map((x) => x.id)) }));
  for (const e of r.ranked.slice(0, 3)) {
    const ids = [e.ride.id, ...e.route.map((s) => s.entry.ride.id)];
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(e.route.length <= 2);
  }
});

test('look-ahead: a route that would make you miss a booked Lightning Lane is not taken', () => {
  const rides = [
    mkRide({ id: 'A', wait: 5, ...at(1), close: CLOSE }),
    mkRide({ id: 'LONG', wait: 60, ...at(2), close: CLOSE }),
    mkRide({ id: 'C', wait: 5, ...at(2), close: CLOSE }),
    mkRide({ id: 'L', wait: 60, ...at(3), close: CLOSE }),
  ];
  const lanes = [{ id: 'b1', kind: 'multi', rideId: 'L', bookedAt: NOW - 60 * MIN, start: NOW + 20 * MIN, end: NOW + 80 * MIN, status: 'held' }];
  const r = plan(rides, ctx({ wanted: new Set(['A', 'LONG', 'C', 'L']), lanes }));
  const top = r.ranked[0];
  const steps = [top.ride.id, ...top.route.map((s) => s.entry.ride.id)];
  // A (5 min) then LONG (60 min) would run past the lane's 12:20 end
  assert.ok(!(steps[0] === 'A' && steps[1] === 'LONG'), steps.join(' > '));
});

test('look-ahead: a ride closing before you could get to it later is not put late in the route', () => {
  const rides = [
    mkRide({ id: 'A', wait: 10, ...at(2), close: CLOSE }),
    mkRide({ id: 'X', wait: 10, ...at(3), close: NOW + 25 * MIN }),
    mkRide({ id: 'B', wait: 10, ...at(4), close: CLOSE }),
  ];
  const r = plan(rides, ctx({ wanted: new Set(['A', 'X', 'B']) }));
  for (const e of r.ranked) for (const s of e.route) if (s.entry.ride.id === 'X') assert.ok(s.arrive <= NOW + 25 * MIN);
});
