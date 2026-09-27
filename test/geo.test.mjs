import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, walkMinutes, nearestPark, atResort, SPEEDS, PATH_FACTOR } from '../app/js/geo.js';

const DL_GATE = { lat: 33.8095545068, lng: -117.9189529669 };
const SPACE_MTN = { lat: 33.811548, lng: -117.917056 };
const DCA_GATE = { lat: 33.8087804896, lng: -117.9189353206 };

test('haversine: gate to Space Mountain is a few hundred metres', () => {
  const m = haversineMeters(DL_GATE, SPACE_MTN);
  assert.ok(m > 250 && m < 350, `got ${m}`);
});

test('haversine: zero distance to self', () => {
  assert.equal(haversineMeters(DL_GATE, DL_GATE), 0);
});

test('walkMinutes applies path factor and speed', () => {
  const m = haversineMeters(DL_GATE, SPACE_MTN);
  const expected = (m * PATH_FACTOR) / SPEEDS.normal;
  assert.ok(Math.abs(walkMinutes(DL_GATE, SPACE_MTN) - expected) < 1e-9);
  assert.ok(walkMinutes(DL_GATE, SPACE_MTN, { speed: 'slow' }) > walkMinutes(DL_GATE, SPACE_MTN, { speed: 'fast' }));
  assert.equal(walkMinutes(DL_GATE, SPACE_MTN, { speed: 'bogus' }), walkMinutes(DL_GATE, SPACE_MTN));
});

test('nearestPark picks by distance to centre', () => {
  const centers = { DL: { lat: 33.8121, lng: -117.9190 }, DCA: { lat: 33.8065, lng: -117.9200 } };
  assert.equal(nearestPark(SPACE_MTN, centers), 'DL');
  assert.equal(nearestPark({ lat: 33.8060, lng: -117.9205 }, centers), 'DCA');
  assert.equal(nearestPark(null, centers), null);
});

test('atResort: within 2.5 km of the Disneyland gate', () => {
  assert.equal(atResort(SPACE_MTN, DL_GATE), true);
  assert.equal(atResort(DCA_GATE, DL_GATE), true);
  assert.equal(atResort({ lat: 34.05, lng: -118.25 }, DL_GATE), false); // downtown LA
  assert.equal(atResort(null, DL_GATE), false);
});
