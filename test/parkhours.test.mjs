import test from 'node:test';
import assert from 'node:assert/strict';
import { parkHoursFrom, withParkHours, normalizeTpw } from '../app/js/normalize.js';
import { buildSnapshot } from '../app/js/sources.js';

const T = (s) => Date.parse(s);
const sched = (rows) => ({ schedule: rows.map(([date, type, o, c]) => ({ date, type, openingTime: o, closingTime: c })) });

const schedules = {
  DCA: sched([
    ['2026-03-09', 'OPERATING', '2026-03-09T08:00:00-07:00', '2026-03-09T22:00:00-07:00'],
    ['2026-03-10', 'OPERATING', '2026-03-10T08:00:00-07:00', '2026-03-10T18:00:00-07:00'],
    ['2026-03-10', 'TICKETED_EVENT', '2026-03-10T18:00:00-07:00', '2026-03-10T23:00:00-07:00'],
    ['2026-03-08', 'OPERATING', '2026-03-08T08:00:00-07:00', '2026-03-08T18:00:00-07:00'],
  ]),
  DL: sched([['2026-03-09', 'OPERATING', '2026-03-09T08:00:00-07:00', '2026-03-10T00:00:00-07:00']]),
};

test('park hours: regular session only, past days dropped', () => {
  const days = parkHoursFrom(schedules, { from: '2026-03-09' });
  assert.deepEqual(Object.keys(days), ['2026-03-09', '2026-03-10']);
  assert.equal(days['2026-03-09'].DCA.close, T('2026-03-09T22:00:00-07:00'));
  assert.equal(days['2026-03-10'].DCA.close, T('2026-03-10T18:00:00-07:00'), 'a party night closes at 6 pm for day guests');
  assert.equal(days['2026-03-09'].DL.close, T('2026-03-10T00:00:00-07:00'));
});

test('official park hours beat a close guessed from one ride with hours today', () => {
  const now = T('2026-03-09T08:05:00-07:00');
  const at = (d, h) => `${d}T${h}:00-07:00`;
  const live = {
    liveData: [
      // Most rides still carry yesterday's party-night hours; one walkthrough has today's 6 pm close.
      { id: 'a', name: 'Coaster', entityType: 'ATTRACTION', parkId: 'dca', status: 'OPERATING', queue: { STANDBY: { waitTime: 10 } }, operatingHours: [{ type: 'Operating', startTime: at('2026-03-08', '08:00'), endTime: at('2026-03-08', '18:00') }] },
      { id: 'b', name: 'Bakery', entityType: 'ATTRACTION', parkId: 'dca', status: 'OPERATING', queue: {}, operatingHours: [{ type: 'Operating', startTime: at('2026-03-09', '08:00'), endTime: at('2026-03-09', '18:00') }] },
    ],
  };
  const catalog = { parks: { DCA: { id: 'dca' } }, rides: [{ id: 'a', park: 'DCA' }, { id: 'b', park: 'DCA' }] };
  const guessed = normalizeTpw(live, catalog, { now });
  assert.equal(guessed.parks.DCA.close, T(at('2026-03-09', '18:00')), 'the old guess: 6 pm');
  const hours = { at: now, days: parkHoursFrom(schedules, { from: '2026-03-09' }) };
  const snap = buildSnapshot({ tpw: { at: now, data: live }, hours }, catalog, now);
  assert.equal(snap.parks.DCA.close, T('2026-03-09T22:00:00-07:00'));
  assert.equal(snap.parks.DL.close, T('2026-03-10T00:00:00-07:00'));
  // No schedule for today: keep the guess rather than nothing.
  assert.equal(withParkHours(guessed, hours, '2026-04-01').parks.DCA.close, T(at('2026-03-09', '18:00')));
  assert.equal(withParkHours(guessed, null, '2026-03-09'), guessed);
});
