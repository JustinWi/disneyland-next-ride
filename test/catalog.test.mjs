import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildCatalog, PARKS } from '../scripts/build-catalog.mjs';
import { normalizeName, matchQueueTimes, flattenQueueTimes } from '../scripts/lib/match-names.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const children = fx('tpw-children-2026-09-26.json');
const qt16 = fx('qt-16-2026-09-26.json');
const qt17 = fx('qt-17-2026-09-26.json');

const { catalog, report } = buildCatalog({ children, qt16, qt17, types: {}, builtAt: '2026-09-26T00:00:00.000Z' });

test('catalog has both parks with gate coordinates', () => {
  for (const k of ['DL', 'DCA']) {
    assert.equal(catalog.parks[k].id, PARKS[k].id);
    assert.ok(Number.isFinite(catalog.parks[k].lat) && Number.isFinite(catalog.parks[k].lng), k);
  }
});

test('every ride has finite lat/lng, a park, and the catalog shape', () => {
  assert.ok(catalog.rides.length >= 80, `rides: ${catalog.rides.length}`);
  for (const r of catalog.rides) {
    assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lng), `${r.name} lat/lng`);
    assert.ok(r.park === 'DL' || r.park === 'DCA', `${r.name} park`);
    assert.deepEqual(Object.keys(r), ['id', 'name', 'park', 'lat', 'lng', 'type', 'qtId', 'land']);
    // fixtures build has no entity types, except the rides the feed mislabels
    assert.equal(r.type, ['Toy Story Midway Mania!', 'Disneyland Monorail', "Davy Crockett's Explorer Canoes"].includes(r.name) ? 'RIDE' : null, r.name);
  }
});

test('rides are sorted DL first, then DCA', () => {
  const parks = catalog.rides.map((r) => r.park);
  assert.equal(parks.lastIndexOf('DL') < parks.indexOf('DCA'), true);
});

test('qtIds are unique and at least 50 QT rides are matched', () => {
  const ids = catalog.rides.map((r) => r.qtId).filter((x) => x != null);
  assert.equal(new Set(ids).size, ids.length, 'duplicate qtId');
  console.log(`# matched QT rides: ${ids.length} (report.matched ${report.matched} of ${report.qtTotal})`);
  assert.ok(ids.length >= 50, `matched ${ids.length}`);
  assert.equal(report.matched, ids.length);
});

test('matched QT ride is in the same park as the TPW ride', () => {
  const qtPark = new Map([...flattenQueueTimes(qt16, 'DL'), ...flattenQueueTimes(qt17, 'DCA')].map((q) => [q.id, q.park]));
  for (const r of catalog.rides) if (r.qtId != null) assert.equal(qtPark.get(r.qtId), r.park, r.name);
});

test('normalizeName folds marks, quotes, dashes, punctuation and a leading "the"', () => {
  assert.equal(normalizeName('Indiana Jones™ Adventure'), 'indiana jones adventure');
  assert.equal(normalizeName('Soarin’ Across America'), normalizeName("Soarin' Across America"));
  assert.equal(normalizeName('Pixar Pal-A-Round – Non-Swinging'), 'pixar pal a round non swinging');
  assert.equal(normalizeName('"it\'s a small world"'), 'its a small world');
  assert.equal(normalizeName('The Many Adventures of Winnie the Pooh'), 'many adventures of winnie the pooh');
  assert.equal(normalizeName('Mickey & Minnie’s Runaway Railway'), 'mickey and minnies runaway railway');
  assert.equal(normalizeName('Guardians of the Galaxy — Mission: BREAKOUT!'), 'guardians of the galaxy mission breakout');
});

test('matcher: aliases, fuzzy, park agreement, single rider, one-to-one', () => {
  const tpw = [
    { id: 'a', name: 'Indiana Jones™ Adventure', park: 'DL' },
    { id: 'b', name: "Soarin' Around the World", park: 'DCA' },
    { id: 'c', name: 'Pixar Pal-A-Round – Swinging', park: 'DCA' },
    { id: 'd', name: 'Pixar Pal-A-Round – Non-Swinging', park: 'DCA' },
    { id: 'e', name: 'Radiator Springs Racers', park: 'DCA' },
    { id: 'f', name: 'Space Mountain', park: 'DL' },
    { id: 'g', name: 'Space Mountain Ride', park: 'DL' }, // fuzzy competitor for the same QT id
    { id: 'h', name: 'Jungle Cruise', park: 'DCA' }, // wrong park on purpose
    { id: 'i', name: 'Big Thunder Mountain Railroad', park: 'DL' },
  ];
  const qt = [
    { id: 1, name: 'Indiana Jones Adventure: Temple of the Forbidden Eye', park: 'DL' },
    { id: 2, name: 'Soarin’ Across America', park: 'DCA' },
    { id: 3, name: 'Pixar Pal-A-Round - Swinging Gondolas', park: 'DCA' },
    { id: 4, name: 'Pixar Pal-A-Round - Non-Swinging Gondolas', park: 'DCA' },
    { id: 5, name: 'Radiator Springs Racers', park: 'DCA' },
    { id: 6, name: 'Radiator Springs Racers Single Rider', park: 'DCA' },
    { id: 7, name: 'Space Mountain', park: 'DL' },
    { id: 8, name: 'Jungle Cruise', park: 'DL' },
    { id: 9, name: 'Big Thunder Mountain Railroad Ride', park: 'DL' }, // fuzzy: 4/5 tokens
  ];
  const { map, singleRider, report } = matchQueueTimes(tpw, qt);
  assert.equal(map.get('a'), 1);
  assert.equal(map.get('b'), 2);
  assert.equal(map.get('c'), 3);
  assert.equal(map.get('d'), 4);
  assert.equal(map.get('e'), 5);
  assert.equal(singleRider.get('e'), 6);
  assert.equal(map.get('f'), 7);
  assert.equal(map.has('g'), false, 'QT 7 must not be mapped twice');
  assert.equal(map.has('h'), false, 'park must agree');
  assert.equal(map.get('i'), 9);
  assert.equal(report.viaFuzzy.length, 1);
  assert.deepEqual(report.unmatchedQt, ['DL: Jungle Cruise']);
});

test('matcher: renamed fixture names still map to the same QT ids', () => {
  const qtRides = [...flattenQueueTimes(qt16, 'DL'), ...flattenQueueTimes(qt17, 'DCA')];
  const rename = {
    'Indiana Jones™ Adventure': 'Indiana Jones Adventure',
    'Pixar Pal-A-Round - Swinging': 'Pixar Pal-A-Round – Swinging',
    'Guardians of the Galaxy - Mission: BREAKOUT!': 'Guardians of the Galaxy – Mission: Breakout',
    'Soarin’ Across America': "Soarin' Across America",
  };
  const tpw = catalog.rides.map((r) => ({ id: r.id, name: rename[r.name] ?? r.name, park: r.park }));
  const { map } = matchQueueTimes(tpw, qtRides);
  for (const r of catalog.rides) assert.equal(map.get(r.id) ?? null, r.qtId, r.name);
});
