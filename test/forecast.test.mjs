import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastAt, anchoredWait, bestLater, peakAfter } from '../app/js/forecast.js';

const H = 3600e3;
const T0 = Date.parse('2026-09-26T08:00:00-07:00');
// hourly curve: 8am 20, 9am 30, 10am 50, 11am 60, 12pm 60, 1pm 40, 2pm 20
const fc = [20, 30, 50, 60, 60, 40, 20].map((wait, i) => ({ t: T0 + i * H, wait }));

test('forecastAt interpolates linearly between hours and clamps at the ends', () => {
  assert.equal(forecastAt(fc, T0), 20);
  assert.equal(forecastAt(fc, T0 + 0.5 * H), 25);
  assert.equal(forecastAt(fc, T0 + 2 * H), 50);
  assert.equal(forecastAt(fc, T0 - 5 * H), 20);
  assert.equal(forecastAt(fc, T0 + 20 * H), 20);
  assert.equal(forecastAt(null, T0), null);
  assert.equal(forecastAt([], T0), null);
});

test('anchoredWait scales the forecast change by posted / forecast-now (clamped 0.5–1.5)', () => {
  // posted 20 = forecast 20 at 8am; forecast +30 by 10am -> 50
  assert.equal(anchoredWait(fc, 20, T0, T0 + 2 * H), 50);
  // posted 35 vs forecast 20: running busy, change scaled by 1.5 (clamped from 1.75) -> 80
  assert.equal(anchoredWait(fc, 35, T0, T0 + 2 * H), 80);
  // equals the posted wait at t = now
  assert.equal(anchoredWait(fc, 35, T0, T0), 35);
  // never negative
  assert.equal(anchoredWait(fc, 5, T0 + 4 * H, T0 + 6 * H), 0);
  // no forecast -> posted wait unchanged
  assert.equal(anchoredWait(null, 35, T0, T0 + 2 * H), 35);
});

test('anchoredWait on the real Rise of the Resistance case does not invent a drop to 5', () => {
  // 7:20 pm: posted 45, forecast 65 now and 20 at 9:30 pm. Raw delta said 45 - 45 = 0 -> floored 5.
  const t0 = Date.parse('2026-09-26T19:20:00-07:00');
  const rotr = [{ t: t0, wait: 65 }, { t: t0 + 2.17 * H, wait: 20 }];
  const later = anchoredWait(rotr, 45, t0, t0 + 2.17 * H);
  assert.ok(later > 10 && later < 20, `later ${later}`);
});

test('bestLater finds the cheapest future slot in the window', () => {
  const now = T0 + 1 * H; // 9am, posted 30 (matches forecast)
  const best = bestLater(fc, 30, now, now + 1 * H, T0 + 6 * H);
  assert.ok(best);
  assert.equal(best.wait, 20);
  assert.equal(best.t, T0 + 6 * H);
  // window closed -> null
  assert.equal(bestLater(fc, 30, now, now + 3 * H, now + 2 * H), null);
  // no forecast -> flat: same posted wait at window start
  const flat = bestLater(null, 30, now, now + 1 * H, now + 5 * H);
  assert.equal(flat.wait, 30);
  assert.equal(flat.t, now + 1 * H);
});

test('bestLater floors the estimate at 5 minutes', () => {
  const now = T0 + 4 * H; // posted 5 while forecast says 60 -> later deltas are big negatives
  const best = bestLater(fc, 5, now, now + 1 * H, T0 + 6 * H);
  assert.equal(best.wait, 5);
});

test('peakAfter reports the highest forecast value after now', () => {
  const p = peakAfter(fc, T0 + 0.5 * H, T0 + 6 * H);
  assert.equal(p.wait, 60);
  assert.equal(p.t, T0 + 3 * H);
  assert.equal(peakAfter(fc, T0 + 6.5 * H, T0 + 7 * H), null);
  assert.equal(peakAfter(null, T0, T0 + 6 * H), null);
});
