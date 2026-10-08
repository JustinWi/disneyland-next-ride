import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePickLink, warmupBias } from '../app/js/picklink.js';

const catalog = JSON.parse(readFileSync(new URL('../app/data/catalog.json', import.meta.url), 'utf8'));
const nameOf = (id) => catalog.rides.find((r) => r.id === id)?.name;

test('a Knott\'s pick link resolves every ride by a short name, in order, with warm-ups first', () => {
  const hash = '#pick=pony-express,ghostrider,xcelerator,supreme-scream,hangtime,montezooma,sierra-sidewinder,la-revolucion,jaguar,coast-rider&warm=2&park=KBF&date=2026-03-12&height=50';
  const p = parsePickLink(hash, catalog.rides);
  assert.deepEqual(p.unknown, []);
  assert.deepEqual(p.ids.map(nameOf), [
    'Pony Express', 'GhostRider', 'Xcelerator The Ride®', 'Supreme Scream', 'HangTime',
    'MonteZOOMa: The Forbidden Fortress', 'Sierra Sidewinder', 'La Revolucion', 'Jaguar!', 'Coast Rider',
  ]);
  assert.deepEqual(p.warm.map(nameOf), ['Pony Express', 'GhostRider']);
  assert.equal(p.park, 'KBF');
  assert.equal(p.date, '2026-03-12');
  assert.equal(p.heightIn, 50);
});

test('pick links: not a pick link, unknown or ambiguous names, bad values', () => {
  assert.equal(parsePickLink('#trip=abc', catalog.rides), null);
  assert.equal(parsePickLink('', catalog.rides), null);
  const p = parsePickLink('#pick=ghostrider,nosuchride,s&park=KBF&height=500&date=tomorrow&warm=9', catalog.rides);
  assert.deepEqual(p.ids.map(nameOf), ['GhostRider']);
  assert.deepEqual(p.unknown, ['nosuchride', 's'], "'s' matches several rides, so it's not guessed");
  assert.equal(p.heightIn, null);
  assert.equal(p.date, null);
  assert.equal(p.warm.length, 1, 'warm never exceeds the rides found');
});

test('warm-ups: the first unridden one gets the biggest head start; ridden ones drop out', () => {
  const wanted = new Set(['a', 'b', 'c']);
  assert.deepEqual(warmupBias(['a', 'b'], { wanted, ridden: new Set() }), { a: -90, b: -75 });
  assert.deepEqual(warmupBias(['a', 'b'], { wanted, ridden: new Set(['a']) }), { b: -90 });
  assert.deepEqual(warmupBias(['a', 'x'], { wanted, ridden: new Set() }), { a: -90 }, 'not on the list: no head start');
});
