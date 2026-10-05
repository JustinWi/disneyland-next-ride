import test from 'node:test';
import assert from 'node:assert/strict';
import { feelOf, coolOf, thrillPriority, withDropTest, testRideBias, coolSpots, heatOn } from '../app/js/boost.js';
import { ladderGates, computeLocks } from '../app/js/trip.js';

const ride = (key, name, priority = 'medium', extra = {}) => ({ key, name, park: 'DL', priority, tpwId: `id-${key}`, ...extra });

test('feel and cool: thrills, calm rides and seasonal names', () => {
  assert.equal(feelOf('Big Thunder Mountain Railroad'), 'thrill');
  assert.equal(feelOf('Indiana Jones™ Adventure'), 'thrill');
  assert.equal(feelOf("Mr. Toad's Wild Ride"), 'calm');
  assert.equal(feelOf('Disneyland Railroad'), 'calm');
  assert.equal(feelOf('Haunted Mansion Holiday'), 'calm');
  assert.equal(feelOf("It's a Small World (Halloween overlay)"), 'calm');
  assert.equal(feelOf('Pixar Pal-A-Round – Non-Swinging'), 'calm');
  assert.equal(feelOf('Pixar Pal-A-Round - Swinging'), 'thrill');
  assert.equal(coolOf('Grizzly River Run'), 'water');
  assert.equal(coolOf('Pirates of the Caribbean'), 'indoor');
  assert.equal(feelOf('Some New Ride'), null);
});

test('thrillPriority: thrills to Must-do, active one step up, calm two steps down, never removed', () => {
  assert.equal(thrillPriority('medium', 'thrill'), 'must');
  assert.equal(thrillPriority('medium', 'active'), 'high');
  assert.equal(thrillPriority('low', 'active'), 'medium'); // one step up, a kiddie ride doesn't leap past must-dos
  assert.equal(thrillPriority('must', 'active'), 'must');
  assert.equal(thrillPriority('must', 'calm'), 'medium');
  assert.equal(thrillPriority('high', 'calm'), 'low');
  assert.equal(thrillPriority('low', 'calm'), 'low');
  assert.equal(thrillPriority('conditional', 'thrill'), 'conditional'); // gates still apply
  assert.equal(thrillPriority('high', null), 'high');
});

const trip = () => ({
  v: 1,
  days: [],
  rides: [
    ride('pir', 'Pirates of the Caribbean', 'must'),
    ride('bt', 'Big Thunder Mountain Railroad', 'must'),
    ride('rr', "Mickey & Minnie's Runaway Railway", 'high'),
    ride('toad', "Mr. Toad's Wild Ride", 'must'),
  ],
  avoid: [
    { key: 'rise', name: 'Rise of the Resistance', park: 'DL', reason: 'drop in the dark', conditional: true, tpwId: 'id-rise' },
    { key: 'st', name: 'Star Tours', park: 'DL', reason: 'screens', conditional: false, tpwId: 'id-st' },
  ],
  ladders: { drop: ['pir', 'bt'], coaster: [] },
});

test('drop test: a conditional Rise moves onto the list behind Pirates and Runaway Railway', () => {
  const x = withDropTest(trip());
  assert.equal(x.added, true);
  assert.equal(x.dropKey, 'pir');
  assert.ok(x.trip.rides.some((r) => r.key === 'rise' && r.tpwId === 'id-rise'));
  assert.ok(!x.trip.avoid.some((a) => a.key === 'rise'));
  assert.ok(x.trip.avoid.some((a) => a.key === 'st'), 'a firm avoid stays avoided');
  const g = ladderGates(x.trip).get('rise');
  assert.deepEqual(g.sort(), ['pir', 'rr']);
  // Locked until both tests went well; a thumbs down on the drops skips it.
  let lk = computeLocks(x.trip, { ridden: new Set(), gate: {}, weekday: 1 });
  assert.ok(lk.locked['id-rise']);
  lk = computeLocks(x.trip, { ridden: new Set(['id-pir', 'id-rr']), gate: { pir: 'yes', rr: 'yes' }, weekday: 1 });
  assert.equal(lk.locked['id-rise'], undefined, 'any weekday, not just Friday');
  lk = computeLocks(x.trip, { ridden: new Set(['id-pir']), gate: { pir: 'no' }, weekday: 1 });
  assert.match(lk.locked['id-rise'], /skipped/);
});

test('drop test: a firm Rise avoid is left alone; no Pirates means no drop test', () => {
  const t = trip();
  t.avoid[0].conditional = false;
  assert.equal(withDropTest(t).added, false);
  assert.ok(withDropTest(t).trip.avoid.some((a) => a.key === 'rise'));
  const u = trip();
  u.rides = u.rides.filter((r) => r.key !== 'pir');
  assert.equal(withDropTest(u).dropKey, null);
});

test('test rides go just ahead of what they unlock, and stop once answered', () => {
  const x = withDropTest(trip()).trip;
  const bias = { 'id-pir': 0, 'id-bt': -25, 'id-rr': -6, 'id-toad': 0, 'id-rise': -25 };
  const wanted = new Set(Object.keys(bias));
  const b = testRideBias(x, ladderGates(x), { bias, wanted, ridden: new Set(), gate: {}, blocked: new Set() });
  assert.equal(b['id-pir'], -30);
  assert.equal(b['id-rr'], -30);
  assert.equal(b['id-toad'], undefined);
  const after = testRideBias(x, ladderGates(x), { bias, wanted, ridden: new Set(['id-pir']), gate: { pir: 'yes' }, blocked: new Set() });
  assert.equal(after['id-pir'], undefined);
  // A ride not wanted or out for the day pulls nothing forward.
  const none = testRideBias(x, ladderGates(x), { bias, wanted: new Set(['id-pir']), ridden: new Set(), gate: {}, blocked: new Set() });
  assert.deepEqual(none, {});
});

test('heat: on until its time, cool spots are air-conditioned non-rides, nearest first', () => {
  assert.equal(heatOn({ until: 2000 }, 1000), true);
  assert.equal(heatOn({ until: 1000 }, 2000), false);
  assert.equal(heatOn(null, 0), false);
  const rides = [
    { id: 'a', name: "Walt Disney's Enchanted Tiki Room", park: 'DL', type: 'UNKNOWN', lat: 1, lng: 1 },
    { id: 'b', name: 'Main Street Cinema', park: 'DL', type: 'UNKNOWN', lat: 2, lng: 2 },
    { id: 'c', name: 'Pirates of the Caribbean', park: 'DL', type: 'RIDE', lat: 0, lng: 0 },
    { id: 'd', name: 'Animation Academy', park: 'DCA', type: 'UNKNOWN', lat: 0, lng: 0 },
  ];
  const s = coolSpots(rides, { park: 'DL', pos: { lat: 0, lng: 0 }, walk: (p, r) => r.lat * 3 });
  assert.deepEqual(s.map((x) => x.r.id), ['a', 'b']);
});
