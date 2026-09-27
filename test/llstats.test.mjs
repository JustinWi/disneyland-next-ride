import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './helpers.mjs';
import { laneStats, usuallyGoneBy, planLaneDay, patternNotes } from '../app/js/lightning.js';
import { parseTripFile, attachIds, hintWeekday } from '../app/js/trip.js';
import { parkTime, parkHour, weekdayOf } from '../app/js/time.js';
import { summarizeDay } from '../scripts/build-llstats.mjs';

const MIN = 60e3;
const stats = fixture('llstats-2026-09-26.json'); // frozen copy: the live file is refreshed daily
const catalog = JSON.parse(fs.readFileSync(new URL('../app/data/catalog.json', import.meta.url), 'utf8'));
const idOf = (name) => catalog.rides.find((r) => r.name === name).id;

test('stats file has both parks, recent days, and upcoming hours', () => {
  const days = Object.values(stats.days);
  assert.ok(days.some((d) => d.park === 'DL') && days.some((d) => d.park === 'DCA'));
  assert.ok(days.length >= 6);
  assert.ok(stats.hours['2026-10-19|DL']?.open, 'Monday hours known');
});

test('laneStats: Haunted Mansion books up far ahead by late morning; Little Mermaid is easy', () => {
  const dl = laneStats(stats, 'DL', weekdayOf('2026-10-19'));
  const hm = dl.get(idOf('Haunted Mansion Holiday'));
  assert.ok(hm.ahead[11] >= 120, `HM ahead at 11: ${hm.ahead[11]}`);
  const dca = laneStats(stats, 'DCA', weekdayOf('2026-10-21'));
  const lm = dca.get(idOf("The Little Mermaid - Ariel's Undersea Adventure"));
  assert.ok(lm.ahead[11] <= 15, `Little Mermaid ahead at 11: ${lm.ahead[11]}`);
  const gone = usuallyGoneBy(lm, 9);
  assert.ok(gone == null || gone >= 20, `Little Mermaid only goes near closing, got ${gone}`);
});

test('hint weekdays: "Friday, save it for the finale" means Friday only', () => {
  assert.equal(hintWeekday('Friday, save it for the finale'), 5);
  assert.equal(hintWeekday('afternoon, for warmth'), null);
  assert.equal(hintWeekday('Friendly'), null);
});

function planFor(day, park, open, close) {
  const trip = attachIds(parseTripFile(fixture('trip-sample.json')), catalog.rides);
  const live = fixture('tpw-live-2026-09-26.json');
  const mp = new Set(live.liveData.filter((e) => e.queue?.RETURN_TIME).map((e) => e.id));
  const wd = weekdayOf(day);
  const rides = trip.rides
    .filter((r) => r.park === park && r.tpwId && mp.has(r.tpwId))
    .filter((r) => hintWeekday(r.hint) == null || hintWeekday(r.hint) === wd)
    .map((r) => ({ id: r.tpwId, name: r.name, priority: r.priority, typical: r.typical, conditional: Boolean(r.conditionalOn) || r.priority === 'conditional' }));
  return planLaneDay({
    rides,
    stats: laneStats(stats, park, wd),
    open: parkTime(day, open),
    close: parkTime(day, close),
    priceEach: 37,
    party: 4,
    hourOf: parkHour,
  });
}

test("day plan: a ride's once-a-day lane is not spent on a short morning line", () => {
  const p = planFor('2026-10-19', 'DL', '08:00', '23:00');
  for (const b of p.bookings) assert.ok(b.saved >= 10, `${b.name} saves ${b.saved}`);
});

test('day plan: bookings respect the 2-hour rule and park hours', () => {
  const p = planFor('2026-10-19', 'DL', '08:00', '23:00');
  assert.ok(p.bookings.length >= 3);
  let prev = null;
  for (const b of p.bookings) {
    assert.ok(b.returnAt + 60 * MIN <= parkTime('2026-10-19', '23:00'), `${b.name} return after close`);
    // never before the rules allow: tap-in at the previous return, or 2 hours after booking it
    if (prev) assert.ok(b.bookAt >= Math.min(prev.returnAt, prev.bookAt + 120 * MIN) - 1, `${b.name} booked too early`);
    prev = b;
  }
  assert.equal(new Set(p.bookings.map((b) => b.rideId)).size, p.bookings.length, 'each ride once');
});

test('day plan verdicts: a Disneyland list heavy on Multi Pass rides is worth considering; a DCA list light on them is not', () => {
  const mon = planFor('2026-10-19', 'DL', '08:00', '23:00');
  const wed = planFor('2026-10-21', 'DCA', '08:00', '22:00');
  assert.notEqual(mon.verdict, 'skip');
  assert.ok(mon.saved >= 60, `Monday saves ${mon.saved}`);
  assert.ok(mon.saved > 3 * wed.saved);
  assert.equal(wed.verdict, 'skip');
  assert.equal(mon.cost, 148);
  // Space Mountain is marked "Friday" in the trip file: never in Monday's plan
  assert.ok(!mon.bookings.some((b) => b.name === 'Space Mountain'));
});

test('pattern notes: a lane that is usually gone soon is urged, a quick return is a plus', () => {
  const s = { avail: { 10: 1, 11: 0.8, 12: 0.2 }, ahead: {}, standby: {} };
  const now = parkTime('2026-10-19', '10:15');
  const n = patternNotes(s, now, now + 20 * MIN, parkHour);
  assert.ok(n.notes.some((x) => /usually gone by 12 pm/.test(x)));
  assert.ok(n.notes.some((x) => /rebook sooner/.test(x)));
  assert.equal(n.bonus, 20);
});

test('summarizeDay: sell-out needs 90+ minutes of running left; end-of-day closing is not a sell-out', () => {
  const day = '2026-09-21';
  const t = (hh, mm = 0) => new Date(parkTime(day, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`)).toISOString();
  const row = (time, state, status = 'OPERATING', wait = 30) => ({ time, status, queue: { STANDBY: { waitTime: wait }, RETURN_TIME: { state, returnStart: state === 'AVAILABLE' ? t(10) : null } } });
  const env = {
    entities: [
      { id: 'sold', name: 'Sold', entityType: 'ATTRACTION', opening: null, history: [row(t(8), 'AVAILABLE'), row(t(12), 'FINISHED'), row(t(22), 'FINISHED', 'CLOSED')] },
      { id: 'late', name: 'Late', entityType: 'ATTRACTION', opening: null, history: [row(t(8), 'AVAILABLE'), row(t(22, 30), 'FINISHED'), row(t(22, 45), 'FINISHED'), row(t(23), 'FINISHED', 'CLOSED')] },
      { id: 'blip', name: 'Blip', entityType: 'ATTRACTION', opening: null, history: [row(t(8), 'AVAILABLE'), row(t(9), 'FINISHED', 'DOWN'), row(t(10), 'AVAILABLE'), row(t(22), 'AVAILABLE', 'CLOSED')] },
    ],
  };
  const s = summarizeDay(env, day);
  assert.equal(s.sold.sellOut, '12:00');
  assert.equal(s.late.sellOut, null);
  assert.equal(s.blip.sellOut, null);
});
