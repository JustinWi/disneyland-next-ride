import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './helpers.mjs';
import { parseTripFile, attachIds, matchRide, encodeTrip, decodeTrip, tripDay } from '../app/js/trip.js';

const catalog = JSON.parse(fs.readFileSync(new URL('../app/data/catalog.json', import.meta.url), 'utf8'));
const sample = fixture('trip-sample.json');

test('every ride and avoid entry in the real trip list matches a catalog ride in its park', () => {
  const t = attachIds(parseTripFile(sample), catalog.rides);
  const missing = [...t.rides, ...t.avoid].filter((r) => !r.tpwId).map((r) => r.name);
  assert.deepEqual(missing, []);
  for (const r of [...t.rides, ...t.avoid]) {
    assert.equal(catalog.rides.find((c) => c.id === r.tpwId).park, r.park, r.name);
  }
});

test('renamed and seasonal names map to the live entity', () => {
  const name = (n, p) => matchRide(n, p, catalog.rides)?.name;
  assert.equal(name("Gadget's Go Coaster", 'DL'), "Chip 'n' Dale's GADGETcoaster");
  assert.equal(name("It's a Small World (Halloween overlay)", 'DL'), '"it\'s a small world"');
  assert.equal(name("Mater's Junkyard Jamboree", 'DCA'), "Mater's Graveyard JamBOOree");
  assert.equal(name('Tom Sawyer Island', 'DL'), "Pirate's Lair on Tom Sawyer Island");
  assert.equal(name('Pixar Pal-A-Round (non-swinging)', 'DCA'), 'Pixar Pal-A-Round – Non-Swinging');
  assert.equal(name('Pixar Pal-A-Round (swinging)', 'DCA'), 'Pixar Pal-A-Round - Swinging');
  assert.equal(name('Space Mountain', 'DCA'), undefined, 'never matches across parks');
});

test('parse keeps rules and drops anything personal', () => {
  const withParty = { ...sample, meta: { ...sample.meta, party: [{ id: 'x', notes: 'private' }] } };
  const t = parseTripFile(withParty);
  assert.equal('break' in t, false, 'no fixed midday break');
  assert.deepEqual(t.days.map((d) => d.date), ['2026-10-19', '2026-10-21', '2026-10-23']);
  assert.equal(t.rides.find((r) => r.key === 'dl-matterhorn').conditionalOn, 'dl-big-thunder');
  assert.equal(t.rides.find((r) => r.key === 'dl-space-mountain').priority, 'conditional');
  assert.ok(!JSON.stringify(t).includes('private'));
  assert.throws(() => parseTripFile({ nope: 1 }), /ride/);
});

test('private link round-trips through gzip + base64url and stays short', async () => {
  const t = parseTripFile(sample);
  t.days = [{ date: '2026-10-19', park: 'DL' }, { date: '2026-10-21', park: 'DCA' }, { date: '2026-10-23', park: null }];
  const s = await encodeTrip(t);
  assert.match(s, /^z[A-Za-z0-9_-]+$/);
  assert.ok(s.length < 6000, `link payload ${s.length}`);
  const back = await decodeTrip(s);
  assert.deepEqual(back, t);
  assert.deepEqual(tripDay(back, '2026-10-21'), { date: '2026-10-21', park: 'DCA' });
  assert.equal(tripDay(back, '2026-10-20'), null);
});
