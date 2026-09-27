// Forecast helpers. A forecast is an ascending array of { t: ms, wait: minutes }.
// We never trust the forecast's absolute value; we anchor its *delta* to the posted wait.

const STEP = 15 * 60e3;

/** Linear interpolation of the forecast at time t, clamped to the ends. null when no forecast. */
export function forecastAt(forecast, t) {
  if (!forecast || forecast.length === 0) return null;
  if (t <= forecast[0].t) return forecast[0].wait;
  const last = forecast[forecast.length - 1];
  if (t >= last.t) return last.wait;
  for (let i = 1; i < forecast.length; i++) {
    const b = forecast[i];
    if (t <= b.t) {
      const a = forecast[i - 1];
      const f = (t - a.t) / (b.t - a.t);
      return a.wait + (b.wait - a.wait) * f;
    }
  }
  return last.wait;
}

/**
 * Expected wait at time t given the posted wait now: the forecast's change from now to t, scaled by
 * how busy this ride is versus its forecast (posted / forecast-now, clamped 0.5–1.5), added to the
 * posted wait. Floored at 0. Equals the posted wait at t = now.
 * Scaling matters on real data: Rise of the Resistance posted 45 against a forecast of 65 at 7:20 pm;
 * the raw delta to the 9:30 pm forecast (20) claimed it would "drop to 5".
 */
export function anchoredWait(forecast, waitNow, tNow, t) {
  const fNow = forecastAt(forecast, tNow);
  const fT = forecastAt(forecast, t);
  if (fNow == null || fT == null) return Math.max(0, waitNow);
  const k = Math.min(1.5, Math.max(0.5, waitNow / Math.max(fNow, 1)));
  return Math.max(0, waitNow + (fT - fNow) * k);
}

/**
 * Cheapest future slot in [from, to] sampled every 15 minutes, floored at 5 minutes.
 * Without a forecast the curve is flat, so the earliest slot wins. null when the window is empty.
 */
export function bestLater(forecast, waitNow, tNow, from, to, floor = 5) {
  if (!(from <= to)) return null;
  let best = null;
  for (let t = from; t <= to; t += STEP) {
    const w = Math.max(floor, anchoredWait(forecast, waitNow, tNow, t));
    if (!best || w < best.wait) best = { t, wait: w };
  }
  return best;
}

/** Highest raw forecast point strictly after tNow and no later than `to`. null when none. */
export function peakAfter(forecast, tNow, to) {
  if (!forecast || forecast.length === 0) return null;
  let peak = null;
  for (const p of forecast) {
    if (p.t <= tNow || p.t > to) continue;
    if (!peak || p.wait > peak.wait) peak = { t: p.t, wait: p.wait };
  }
  return peak;
}
