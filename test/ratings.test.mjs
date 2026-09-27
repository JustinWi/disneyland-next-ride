import test from 'node:test';
import assert from 'node:assert/strict';
import { mkRide } from './helpers.mjs';
import { clampStars, effectiveDone, favorites, againBias, starText } from '../app/js/ratings.js';
import { plan } from '../app/js/plan.js';

test('stars are whole numbers from 1 to 5', () => {
  assert.equal(clampStars(0), 1);
  assert.equal(clampStars(7), 5);
  assert.equal(clampStars('4'), 4);
  assert.equal(starText(3), '★★★☆☆');
});

test('ride again: a ridden ride put back on today\'s list is not done for planning', () => {
  const done = effectiveDone(new Set(['A', 'B']), ['B']);
  assert.deepEqual([...done], ['A']);
});

test('favorites: 4 and 5 stars, ridden, in today\'s park, best first then shortest wait', () => {
  const ridesById = new Map([
    ['A', mkRide({ id: 'A', wait: 40 })],
    ['B', mkRide({ id: 'B', wait: 10 })],
    ['C', mkRide({ id: 'C', wait: 5 })],
    ['D', mkRide({ id: 'D', park: 'DCA', wait: 5 })],
    ['E', mkRide({ id: 'E', wait: 5 })],
  ]);
  const ratings = { A: { stars: 5 }, B: { stars: 4 }, C: { stars: 3 }, D: { stars: 5 }, E: { stars: 4 } };
  const ridden = new Set(['A', 'B', 'C', 'D', 'E']);
  const f = favorites({ ratings, ridden, ridesById, park: 'DL', again: ['E'] });
  assert.deepEqual(f.map((x) => x.id), ['A', 'B']);
  assert.deepEqual(favorites({ ratings, ridden, ridesById }).map((x) => x.id), ['D', 'A', 'E', 'B']);
});

test('a loved re-ride gets a head start in the plan', () => {
  assert.equal(againBias(5), -10);
  assert.equal(againBias(3), 0);
  const HERE = { lat: 33.8121, lng: -117.919 };
  const rides = [mkRide({ id: 'A', wait: 20 }), mkRide({ id: 'B', wait: 25 })];
  const ctx = { now: Date.now(), pos: HERE, posPark: 'DL', wanted: new Set(['A', 'B']), done: new Set(), snoozed: {}, speed: 'normal', hopMinutes: 20 };
  assert.equal(plan(rides, ctx).ranked[0].ride.id, 'A');
  assert.equal(plan(rides, { ...ctx, bias: { B: againBias(5) } }).ranked[0].ride.id, 'B');
});
