import test from 'node:test';
import assert from 'node:assert/strict';
import { mkRide } from './helpers.mjs';
import { scoreRides, DEFAULTS } from '../app/js/score.js';
import { fmtTime, todayKey } from '../app/js/time.js';

const MIN = 60e3;
const NOW = Date.parse('2026-09-26T10:00:00-07:00');
const CLOSE = Date.parse('2026-09-26T23:00:00-07:00');
// ~1 km/h per 0.009 deg lat; 72 m/min * 5 min / 1.3 = 277 m ≈ 0.0025 deg
const HERE = { lat: 33.8121, lng: -117.919 };
const near = (minutes) => ({ lat: HERE.lat + (minutes * 72 / 1.3) / 111320, lng: HERE.lng });
const rising = (from, to, hours) => {
  const out = [];
  for (let i = 0; i <= 12; i++) {
    const t = NOW - 2 * 3600e3 + i * 3600e3;
    const frac = Math.min(1, Math.max(0, (t - NOW) / (hours * 3600e3)));
    out.push({ t, wait: from + (to - from) * frac });
  }
  return out;
};
const ctx = (over = {}) => ({
  now: NOW,
  pos: HERE,
  posPark: 'DL',
  wanted: new Set(over.wantedIds ?? ['A', 'B', 'C', 'D', 'E']),
  done: new Set(),
  snoozed: {},
  speed: 'normal',
  hopMinutes: 20,
  ...over,
});

test('ranked ascending by score; top entry exposes the numbers the UI needs', () => {
  const rides = [
    mkRide({ id: 'A', name: 'A', wait: 30, ...near(5), close: CLOSE }),
    mkRide({ id: 'B', name: 'B', wait: 10, ...near(2), close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx());
  assert.equal(r.ranked.length, 2);
  assert.equal(r.ranked[0].ride.id, 'B');
  assert.ok(r.ranked[0].score <= r.ranked[1].score);
  const top = r.ranked[0];
  for (const k of ['walk', 'waitNow', 'waitArr', 'nowCost', 'laterCost', 'urgency', 'score', 'reason', 'flags']) {
    assert.ok(k in top, `missing ${k}`);
  }
  assert.ok(Math.abs(top.walk - 2) < 0.05, `walk ${top.walk}`);
  assert.equal(top.waitNow, 10);
  assert.match(top.reason, /10 min wait/);
  assert.match(top.reason, /2 min walk/);
});

test('a steeply rising ride is pulled ahead of a nearer flat ride', () => {
  const rides = [
    mkRide({ id: 'A', name: 'Rising', wait: 20, ...near(5), close: CLOSE, forecast: rising(20, 80, 1) }),
    mkRide({ id: 'B', name: 'Flat', wait: 10, ...near(2), close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx());
  assert.equal(r.ranked[0].ride.id, 'A');
  assert.ok(r.ranked[0].urgency < 0);
  assert.match(r.ranked[0].reason, /forecast \d+\+? by \d/);
});

test('a mildly rising ride does not beat a much shorter nearby ride', () => {
  const rides = [
    mkRide({ id: 'A', name: 'Mild', wait: 40, ...near(5), close: CLOSE, forecast: rising(40, 50, 4) }),
    mkRide({ id: 'B', name: 'Flat', wait: 10, ...near(2), close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx());
  assert.equal(r.ranked[0].ride.id, 'B');
});

test('a ride that will be much cheaper later says so and ranks lower', () => {
  const falling = rising(60, 10, 3); // 60 now, 10 in 3 h
  const rides = [
    mkRide({ id: 'A', name: 'Falling', wait: 60, ...near(3), close: CLOSE, forecast: falling }),
    mkRide({ id: 'B', name: 'Flat', wait: 45, ...near(6), close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx());
  assert.equal(r.ranked[0].ride.id, 'B');
  const a = r.ranked[1];
  assert.ok(a.urgency > 0);
  assert.match(a.reason, /drops to \d+ .*after/);
});

test('DOWN, REFURBISHMENT and not-yet-open rides are excluded with a reason', () => {
  const rides = [
    mkRide({ id: 'A', name: 'A', status: 'DOWN', close: CLOSE }),
    mkRide({ id: 'B', name: 'B', status: 'REFURBISHMENT' }),
    mkRide({ id: 'C', name: 'C', status: 'CLOSED', open: NOW + 60 * MIN, close: CLOSE }),
    mkRide({ id: 'D', name: 'D', wait: 15, close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx());
  assert.deepEqual(r.ranked.map((e) => e.ride.id), ['D']);
  const why = Object.fromEntries(r.excluded.map((e) => [e.ride.id, e.why]));
  assert.deepEqual(why, { A: 'down', B: 'refurb', C: 'closed' });
  const c = r.excluded.find((e) => e.ride.id === 'C');
  assert.match(c.detail, /opens 11/);
});

test('cannot reach the queue before close -> excluded', () => {
  const rides = [
    mkRide({ id: 'A', name: 'A', wait: 40, ...near(5), close: NOW + 3 * MIN }),
    mkRide({ id: 'B', name: 'B', wait: 10, close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx());
  assert.deepEqual(r.ranked.map((e) => e.ride.id), ['B']);
  assert.equal(r.excluded[0].why, 'closes');
  assert.match(r.excluded[0].detail, /closes before you/);
});

test('in the queue by closing time still counts, even if you board after close', () => {
  // Disney lets you ride if you're in line when the ride closes.
  const rides = [mkRide({ id: 'A', name: 'A', wait: 40, ...near(5), close: NOW + 20 * MIN })];
  const r = scoreRides(rides, ctx());
  assert.deepEqual(r.ranked.map((e) => e.ride.id), ['A']);
  assert.ok(r.ranked[0].flags.includes('last-chance'));
});

test('an OPERATING ride whose listed window already ended is not excluded as closed', () => {
  const rides = [mkRide({ id: 'A', name: 'A', wait: 15, close: NOW - 60 * MIN })];
  const r = scoreRides(rides, ctx());
  assert.deepEqual(r.ranked.map((e) => e.ride.id), ['A']);
});

test('last chance: closing before anything else could be done first boosts the ride to the top', () => {
  const rides = [
    mkRide({ id: 'A', name: 'Closing soon', wait: 20, ...near(5), close: NOW + 15 * MIN }),
    mkRide({ id: 'B', name: 'Flat', wait: 10, ...near(2), close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx());
  assert.equal(r.ranked[0].ride.id, 'A');
  assert.ok(r.ranked[0].flags.includes('last-chance'));
  assert.match(r.ranked[0].reason, /last chance/);
  assert.match(r.ranked[0].reason, /10:15 am/);
});

test('not last chance when it can still be done after the other ride (closes in an hour)', () => {
  const rides = [
    mkRide({ id: 'A', name: 'Closing in an hour', wait: 20, ...near(5), close: NOW + 60 * MIN }),
    mkRide({ id: 'B', name: 'Flat', wait: 10, ...near(2), close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx());
  assert.ok(!r.ranked.find((e) => e.ride.id === 'A').flags.includes('last-chance'));
});

test('other park adds the hop penalty and says so', () => {
  const rides = [
    mkRide({ id: 'A', name: 'DL ride', wait: 20, ...near(4), close: CLOSE }),
    mkRide({ id: 'B', name: 'DCA ride', park: 'DCA', wait: 20, ...near(4), close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx());
  assert.equal(r.ranked[0].ride.id, 'A');
  const b = r.ranked[1];
  assert.ok(b.walk > 23.9, `walk ${b.walk}`);
  assert.ok(b.flags.includes('hop'));
  assert.match(b.reason, /other park/);
});

test('no forecast, walk of 8 -> urgency 0', () => {
  const rides = [mkRide({ id: 'A', name: 'A', wait: 20, ...near(8), close: CLOSE })];
  const r = scoreRides(rides, ctx());
  assert.ok(Math.abs(r.ranked[0].urgency) < 0.1, `urgency ${r.ranked[0].urgency}`);
});

test('an old lastUpdated is not flagged stale (it means "last changed"); unknown wait is flagged', () => {
  const rides = [
    mkRide({ id: 'A', name: 'A', wait: 5, waitUpdated: NOW - 6 * 60 * MIN, close: CLOSE }),
    mkRide({ id: 'B', name: 'B', wait: null, close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx());
  const a = r.ranked.find((e) => e.ride.id === 'A');
  const b = r.ranked.find((e) => e.ride.id === 'B');
  assert.ok(!a.flags.includes('stale'));
  assert.doesNotMatch(a.reason, /stale/);
  assert.ok(b.flags.includes('wait-unknown'));
  assert.equal(b.waitNow, DEFAULTS.unknownWait);
  assert.match(b.reason, /wait unknown/);
});

test('split windows: a ride that pauses for fireworks and reopens is not "last chance"', () => {
  const pauseAt = NOW + 25 * MIN; // pauses before any later visit could happen
  const windows = [
    { open: NOW - 2 * 60 * MIN, close: pauseAt },
    { open: NOW + 3 * 60 * MIN, close: NOW + 4 * 60 * MIN },
  ];
  const rides = [mkRide({ id: 'A', name: 'A', wait: 20, ...near(5), open: windows[0].open, close: pauseAt, windows })];
  const r = scoreRides(rides, ctx());
  const a = r.ranked[0];
  assert.ok(a, 'ranked');
  assert.ok(!a.flags.includes('last-chance'), a.reason);
  assert.ok(a.later.t >= windows[1].open, 'later slot is in the reopening window');
});

test('split windows: missing the current window points at the reopening', () => {
  const windows = [
    { open: NOW - 2 * 60 * MIN, close: NOW + 2 * MIN },
    { open: NOW + 3 * 60 * MIN, close: NOW + 4 * 60 * MIN },
  ];
  const rides = [mkRide({ id: 'A', name: 'A', wait: 20, ...near(5), close: windows[0].close, windows })];
  const r = scoreRides(rides, ctx());
  assert.equal(r.ranked.length, 0);
  assert.equal(r.excluded[0].why, 'closes');
  assert.match(r.excluded[0].detail, /reopens 1 pm/);
});

test('split windows: the final close is what "last chance" names', () => {
  const windows = [
    { open: NOW - 2 * 60 * MIN, close: NOW + 10 * MIN },
    { open: NOW + 15 * MIN, close: NOW + 25 * MIN },
  ];
  const rides = [mkRide({ id: 'A', name: 'A', wait: 10, ...near(2), close: windows[0].close, windows })];
  const r = scoreRides(rides, ctx());
  assert.ok(r.ranked[0].flags.includes('last-chance'));
  assert.match(r.ranked[0].reason, /closes 10:25 am/);
});

test('unknown wait falls back to the forecast value for now', () => {
  const rides = [mkRide({ id: 'A', name: 'A', wait: null, close: CLOSE, forecast: rising(35, 35, 1) })];
  const r = scoreRides(rides, ctx());
  assert.equal(r.ranked[0].waitNow, 35);
});

test('done, snoozed and unwanted rides are partitioned', () => {
  const rides = [
    mkRide({ id: 'A', name: 'A', close: CLOSE }),
    mkRide({ id: 'B', name: 'B', close: CLOSE }),
    mkRide({ id: 'C', name: 'C', close: CLOSE }),
    mkRide({ id: 'Z', name: 'Z', close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx({
    wantedIds: ['A', 'B', 'C'],
    done: new Set(['B']),
    snoozed: { C: NOW + 10 * MIN, A: NOW - 1 }, // A's snooze expired
  }));
  assert.deepEqual(r.ranked.map((e) => e.ride.id), ['A']);
  assert.deepEqual(r.done.map((e) => e.ride.id), ['B']);
  assert.deepEqual(r.snoozed.map((e) => e.ride.id), ['C']);
  assert.ok(!JSON.stringify(r).includes('"Z"'));
});

test('no coordinates or no position -> default walk with a flag', () => {
  const rides = [mkRide({ id: 'A', name: 'A', lat: null, lng: null, close: CLOSE })];
  const r1 = scoreRides(rides, ctx());
  assert.equal(r1.ranked[0].walk, DEFAULTS.noCoordWalk);
  assert.ok(r1.ranked[0].flags.includes('no-coords'));
  const r2 = scoreRides([mkRide({ id: 'A', name: 'A', close: CLOSE })], ctx({ pos: null, posPark: null }));
  assert.equal(r2.ranked[0].walk, DEFAULTS.noCoordWalk);
  assert.ok(r2.ranked[0].flags.includes('no-position'));
  assert.ok(!r2.ranked[0].flags.includes('hop'));
});

test('time helpers format in park time', () => {
  assert.equal(fmtTime(Date.parse('2026-09-26T14:00:00-07:00')), '2 pm');
  assert.equal(fmtTime(Date.parse('2026-09-26T14:30:00-07:00')), '2:30 pm');
  assert.equal(fmtTime(Date.parse('2026-09-26T11:05:00-07:00')), '11:05 am');
  assert.equal(todayKey(Date.parse('2026-09-27T02:19:00Z')), '2026-09-26'); // still the 26th in Anaheim
});

test('why: cards get just the reason, without repeating wait and walk', () => {
  const rides = [
    mkRide({ id: 'A', name: 'Rising', wait: 20, ...near(5), close: CLOSE, forecast: rising(20, 80, 1) }),
    mkRide({ id: 'B', name: 'Flat', wait: 10, ...near(2), close: CLOSE }),
    mkRide({ id: 'C', name: 'Other', park: 'DCA', wait: 10, ...near(2), close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx({ wantedIds: ['A', 'B', 'C'] }));
  const by = Object.fromEntries(r.ranked.map((e) => [e.ride.id, e]));
  assert.match(by.A.why, /^Forecast 80 by 11 am$/);
  assert.equal(by.B.why, null);
  assert.match(by.C.why, /^Other park \(\+20 min hop\)/);
  assert.doesNotMatch(by.A.why, /min wait|min walk/);
});

// ---- Review findings (2026-09-26) ----

test('R1: a longer wait, walk or hop never makes a ride score better', () => {
  const close = NOW + 100 * MIN; // the evening window where the cliff lived
  const others = [
    mkRide({ id: 'B', name: 'B', wait: 5, ...near(6), close: CLOSE }),
    mkRide({ id: 'C', name: 'C', wait: 25, ...near(4), close: CLOSE }),
  ];
  const scoreOf = (over, c = {}) =>
    scoreRides([mkRide({ id: 'A', name: 'A', close, ...over }), ...others], ctx({ wantedIds: ['A', 'B', 'C'], ...c })).ranked.find((e) => e.ride.id === 'A')?.score;
  for (const fc of [null, rising(30, 90, 2), rising(60, 10, 2)]) {
    let prev = -Infinity;
    for (let w = 0; w <= 120; w += 5) {
      const s = scoreOf({ wait: w, ...near(5), forecast: fc });
      assert.ok(s >= prev - 1e-9, `wait ${w}: ${s} < ${prev}`);
      prev = s;
    }
    prev = -Infinity;
    for (let m = 1; m <= 40; m += 3) {
      const s = scoreOf({ wait: 30, ...near(m), forecast: fc });
      assert.ok(s >= prev - 1e-9, `walk ${m}: ${s} < ${prev}`);
      prev = s;
    }
    prev = -Infinity;
    for (const hop of [0, 10, 20, 30, 40]) {
      const s = scoreOf({ wait: 30, park: 'DCA', ...near(5), forecast: fc }, { hopMinutes: hop });
      assert.ok(s >= prev - 1e-9, `hop ${hop}: ${s} < ${prev}`);
      prev = s;
    }
  }
});

test('R2: outside both parks, both parks are reached via their gates with no hop penalty', () => {
  const gates = { DL: { lat: 33.80955, lng: -117.91895 }, DCA: { lat: 33.80878, lng: -117.91894 } };
  const esplanade = { lat: 33.80917, lng: -117.91894 };
  const rides = [
    mkRide({ id: 'A', name: 'DL ride', park: 'DL', wait: 20, lat: 33.8115, lng: -117.9171, close: CLOSE }),
    mkRide({ id: 'B', name: 'DCA ride', park: 'DCA', wait: 20, lat: 33.8067, lng: -117.9212, close: CLOSE }),
  ];
  const r = scoreRides(rides, ctx({ pos: esplanade, posPark: null, gates, wantedIds: ['A', 'B'] }));
  for (const e of r.ranked) {
    assert.ok(!e.flags.includes('hop'), e.ride.name);
    assert.ok(e.flags.includes('outside'), e.ride.name);
    assert.ok(e.walk > 5 && e.walk < 15, `${e.ride.name} walk ${e.walk}`);
  }
  // a step north or south across the esplanade changes nothing much (was a 20 min swing)
  const r2 = scoreRides(rides, ctx({ pos: { lat: 33.8093, lng: -117.91893 }, posPark: null, gates, wantedIds: ['A', 'B'] }));
  const r3 = scoreRides(rides, ctx({ pos: { lat: 33.8096, lng: -117.91893 }, posPark: null, gates, wantedIds: ['A', 'B'] }));
  for (const id of ['A', 'B']) {
    const a = r2.ranked.find((e) => e.ride.id === id).walk;
    const b = r3.ranked.find((e) => e.ride.id === id).walk;
    assert.ok(Math.abs(a - b) < 2, `${id}: ${a} vs ${b}`);
  }
});

test('R3: an OPERATING ride before its listed opening (soft open / early entry) is ranked now', () => {
  const open = NOW + 20 * MIN;
  const rides = [mkRide({ id: 'A', name: 'A', wait: 15, open, close: CLOSE, windows: [{ open, close: CLOSE }] })];
  const r = scoreRides(rides, ctx());
  assert.deepEqual(r.ranked.map((e) => e.ride.id), ['A']);
});

test('R5: no "drops to" claim unless it is at least 10 minutes below the wait now', () => {
  const rides = [
    mkRide({ id: 'A', name: 'A', wait: 5, ...near(6), close: CLOSE, forecast: rising(20, 5, 2) }),
  ];
  const r = scoreRides(rides, ctx({ wantedIds: ['A'] }));
  assert.doesNotMatch(r.ranked[0].reason, /drops to/);
});
