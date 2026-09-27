import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fixture, catalogFromChildren } from './helpers.mjs';
import { normalizeTpw, normalizeQt, withForecastsFrom, parkCenters } from '../app/js/normalize.js';

const live = fixture('tpw-live-2026-09-26.json');
const children = fixture('tpw-children-2026-09-26.json');
const qt16 = fixture('qt-16-2026-09-26.json');
const qt17 = fixture('qt-17-2026-09-26.json');
const catalog = catalogFromChildren(children);
const NOW = Date.parse('2026-09-26T19:20:00-07:00');

test('normalizeTpw: every live attraction becomes a ride with catalog coordinates', () => {
  const snap = normalizeTpw(live, catalog, { now: NOW });
  assert.equal(snap.source, 'tpw');
  assert.equal(snap.at, NOW);
  assert.equal(snap.rides.length, 79);
  const noCoords = snap.rides.filter((r) => !Number.isFinite(r.lat));
  assert.deepEqual(noCoords.map((r) => r.name), []);
  const byPark = snap.rides.reduce((m, r) => ((m[r.park] = (m[r.park] || 0) + 1), m), {});
  assert.equal(byPark.DL + byPark.DCA, 79);
});

test('normalizeTpw: Space Mountain fields', () => {
  const snap = normalizeTpw(live, catalog, { now: NOW });
  const sm = snap.rides.find((r) => r.name === 'Space Mountain');
  assert.equal(sm.status, 'OPERATING');
  assert.equal(sm.wait, 65);
  assert.equal(sm.park, 'DL');
  assert.equal(sm.forecast.length, 15);
  assert.equal(sm.forecast[0].t, Date.parse('2026-09-26T08:00:00-07:00'));
  assert.equal(sm.forecast[0].wait, 45);
  assert.equal(sm.open, Date.parse('2026-09-26T08:00:00-07:00'));
  assert.equal(sm.close, Date.parse('2026-09-26T23:00:00-07:00'));
  assert.equal(sm.waitUpdated, Date.parse('2026-09-27T01:52:57.302Z'));
  assert.equal(sm.ll.multi, null); // RETURN_TIME state FINISHED -> no window
  assert.equal(sm.ll.single, null);
});

test('normalizeTpw: Lightning Lane windows and prices', () => {
  const snap = normalizeTpw(live, catalog, { now: NOW });
  const rsr = snap.rides.find((r) => r.name === 'Radiator Springs Racers');
  assert.equal(rsr.park, 'DCA');
  assert.equal(rsr.wait, 120);
  assert.deepEqual(rsr.ll.single, {
    start: Date.parse('2026-09-26T19:40:00-07:00'),
    end: Date.parse('2026-09-26T20:40:00-07:00'),
    price: '$23.00',
  });
  assert.equal(rsr.ll.singleRider, null); // waitTime null
  const buzz = snap.rides.find((r) => r.name === 'Buzz Lightyear Astro Blasters');
  assert.deepEqual(buzz.ll.multi, {
    start: Date.parse('2026-09-26T19:50:00-07:00'),
    end: Date.parse('2026-09-26T20:50:00-07:00'),
  });
});

test('normalizeTpw: statuses and null waits survive', () => {
  const snap = normalizeTpw(live, catalog, { now: NOW });
  const st = snap.rides.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  assert.deepEqual(st, { OPERATING: 62, CLOSED: 12, DOWN: 3, REFURBISHMENT: 2 });
  const pan = snap.rides.find((r) => r.name === "Peter Pan's Flight");
  assert.equal(pan.status, 'DOWN');
  const walt = snap.rides.find((r) => r.name === 'Walt Disney - A Magical Life');
  assert.equal(walt.status, 'OPERATING');
  assert.equal(walt.wait, null);
  const gallery = snap.rides.find((r) => r.name === 'The Disney Gallery');
  assert.equal(gallery.wait, null); // no queue object at all
  assert.equal(gallery.forecast, null);
});

test('normalizeTpw: park hours derived from attractions', () => {
  const snap = normalizeTpw(live, catalog, { now: NOW });
  assert.equal(snap.parks.DL.close, Date.parse('2026-09-26T23:00:00-07:00'));
  assert.ok(snap.parks.DCA.close > NOW);
});

test('normalizeTpw: a live entity missing from the catalog is kept without coordinates', () => {
  const small = { ...catalog, rides: catalog.rides.filter((r) => r.name !== 'Space Mountain') };
  const snap = normalizeTpw(live, small, { now: NOW });
  const sm = snap.rides.find((r) => r.name === 'Space Mountain');
  assert.ok(sm);
  assert.equal(sm.lat, null);
  assert.equal(sm.park, 'DL'); // from parkId
});

test('normalizeQt: maps by qtId, statuses from is_open, no forecast', () => {
  // give the catalog qtIds by exact name match for this test
  const qtByName = new Map();
  for (const p of [qt16, qt17]) for (const l of p.lands) for (const r of l.rides) qtByName.set(r.name, r.id);
  const cat = { ...catalog, rides: catalog.rides.map((r) => ({ ...r, qtId: qtByName.get(r.name) ?? null })) };
  const snap = normalizeQt([qt16, qt17], cat, { now: NOW });
  assert.equal(snap.source, 'qt');
  assert.ok(snap.rides.length >= 40, `got ${snap.rides.length}`);
  const sm = snap.rides.find((r) => r.name === 'Space Mountain');
  assert.ok(sm, 'Space Mountain matched by name');
  assert.equal(sm.id, catalog.rides.find((r) => r.name === 'Space Mountain').id); // TPW id kept
  assert.equal(typeof sm.wait, 'number');
  assert.equal(sm.forecast, null);
  assert.ok(['OPERATING', 'CLOSED'].includes(sm.status));
  const closed = snap.rides.find((r) => r.status === 'CLOSED');
  assert.ok(closed);
  assert.equal(closed.wait, null); // QT reports 0 for closed rides; we do not trust it
});

test('withForecastsFrom copies forecasts and hours from a previous snapshot by id', () => {
  const tpw = normalizeTpw(live, catalog, { now: NOW });
  const qtByName = new Map();
  for (const p of [qt16, qt17]) for (const l of p.lands) for (const r of l.rides) qtByName.set(r.name, r.id);
  const cat = { ...catalog, rides: catalog.rides.map((r) => ({ ...r, qtId: qtByName.get(r.name) ?? null })) };
  const qt = normalizeQt([qt16, qt17], cat, { now: NOW });
  const merged = withForecastsFrom(qt, tpw);
  const sm = merged.rides.find((r) => r.name === 'Space Mountain');
  assert.equal(sm.forecast.length, 15);
  assert.equal(sm.close, Date.parse('2026-09-26T23:00:00-07:00'));
  assert.equal(merged.source, 'qt');
});

test('parkCenters averages ride coordinates per park', () => {
  const c = parkCenters(catalog);
  assert.ok(c.DL.lat > c.DCA.lat); // Disneyland is north of DCA
  assert.ok(Math.abs(c.DL.lng - -117.919) < 0.01);
});

test('normalizeTpw: split operating windows are kept, stale windows from other days dropped', () => {
  const snap = normalizeTpw(live, catalog, { now: NOW });
  const cd = snap.rides.find((r) => r.name === "Chip 'n' Dale's GADGETcoaster");
  assert.equal(cd.windows.length, 2);
  assert.equal(cd.windows[1].open, Date.parse('2026-09-26T22:15:00-07:00'));
  // Park open must not come from a months-old window left in the feed.
  assert.equal(snap.parks.DL.open, Date.parse('2026-09-26T08:00:00-07:00'));
});

test('normalizeTpw: null forecast points and null hours entries are skipped, not thrown (R7)', () => {
  const bad = JSON.parse(JSON.stringify(live));
  const sm = bad.liveData.find((e) => e.name === 'Space Mountain');
  sm.forecast[2] = null;
  sm.operatingHours = [null, ...sm.operatingHours];
  bad.liveData.push(null);
  const snap = normalizeTpw(bad, catalog, { now: NOW });
  const r = snap.rides.find((x) => x.name === 'Space Mountain');
  assert.ok(r.forecast.length > 5);
  assert.ok(r.close > NOW);
});

const qtCatalog = () => JSON.parse(fs.readFileSync(new URL('../app/data/catalog.json', import.meta.url), 'utf8'));

test('withForecastsFrom: Queue-Times "closed" becomes DOWN inside operating hours and keeps REFURBISHMENT (R6)', () => {
  const qt = [fixture('qt-16-2026-09-26.json'), fixture('qt-17-2026-09-26.json')];
  const tpw = normalizeTpw(live, qtCatalog(), { now: NOW });
  const merged = withForecastsFrom({ ...normalizeQt(qt, qtCatalog(), { now: NOW }), at: NOW }, tpw);
  const by = (n) => merged.rides.find((r) => r.name === n);
  assert.equal(by('Silly Symphony Swings').status, 'DOWN');
  assert.equal(by('Indiana Jones™ Adventure').status, 'REFURBISHMENT');
  assert.equal(by('Sailing Ship Columbia').status, 'CLOSED'); // its hours ended at 3:30 pm
});
