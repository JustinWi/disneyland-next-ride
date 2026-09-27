// Scoring: which ride on the list should we go to next?
// Pure functions, no DOM. See docs/design.html section 4.
//
//   walk      = dist × 1.3 / speed, + hop if the ride is in the other park,
//               or via the park's gate + entry time when we're outside both parks
//   waitArr   = posted wait, moved along the forecast to our arrival time
//   nowCost   = walk + waitArr
//   detour    = what doing something else first would take: median nowCost of the OTHER rides
//               (20–60 min). Independent of this ride's own cost, so a longer wait or walk can
//               never make a ride look better (review finding R1).
//   later     = cheapest predicted wait for this ride in [now + detour, close − 5 min], any window
//   urgency   = clamp((walk w/o hop − 8) + (waitArr − laterWait), ±45); no later slot ⇒ −45
//   score     = nowCost + 1.0 × urgency                lower is better

import { walkMinutes, haversineMeters, PATH_FACTOR, SPEEDS } from './geo.js';
import { forecastAt, anchoredWait, bestLater, peakAfter } from './forecast.js';
import { fmtTime } from './time.js';

const MIN = 60e3;

export const DEFAULTS = {
  unknownWait: 10, // minutes assumed when there's no posted wait and no forecast
  noCoordWalk: 10, // minutes assumed when we can't measure the walk
  laterOverhead: 8, // coming back later costs a typical walk
  detourMin: 20, // bounds on "do something else first"
  detourMax: 60,
  detourDefault: 30, // when there's nothing else on the list
  closeBuffer: 5, // a later visit must reach the queue this long before it closes
  urgencyClamp: 45, // last chance sits at the clamp too, not beyond it
  // 1.0: a ride must save twice its extra cost now before a later slot pulls it ahead. 0.75 needed
  // 2.33x and only passed its own tests because of the R1 bug that made 'later' look too late.
  urgencyWeight: 1,
  entryMinutes: 5, // tapstiles when walking in from outside the parks
  trendThreshold: 8, // |urgency| at which the trend becomes the reason
  horizonHours: 8, // look-ahead when a ride has no known close
};

const round5 = (n) => Math.round(n / 5) * 5;
const ceilTo = (t, step) => Math.ceil(t / step) * step;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function waitText(e) {
  if (e.flags.includes('wait-unknown')) return 'wait unknown';
  const w = Math.round(e.waitNow);
  const s = w <= 0 ? 'no wait' : `${w} min wait`;
  return e.flags.includes('wait-forecast') ? `~${s} (forecast)` : s;
}

function walkText(e, hopMinutes) {
  const w = Math.max(1, Math.round(e.walk));
  if (e.flags.includes('hop')) return `${w} min walk, other park (+${hopMinutes} hop)`;
  if (e.flags.includes('no-coords') || e.flags.includes('no-position')) return `~${w} min walk`;
  return `${w} min walk`;
}

function trendText(e, cfg) {
  if (e.flags.includes('last-chance')) return e.finalClose != null ? `last chance: closes ${fmtTime(e.finalClose)}` : 'last chance today';
  if (e.urgency <= -cfg.trendThreshold && e.peak && e.peak.wait >= e.waitArr + 10) {
    return `forecast ${round5(e.peak.wait)} by ${fmtTime(e.peak.t)}`;
  }
  // Only claim a drop that is one: at least 10 minutes below the wait we'd find now.
  if (e.urgency >= cfg.trendThreshold && e.best && e.ride.forecast && e.best.wait <= e.waitArr - 10) {
    return `drops to ${Math.max(5, round5(e.best.wait))} after ${fmtTime(e.best.t)}, could wait`;
  }
  return null;
}

function reasonFor(e, cfg, hopMinutes) {
  const parts = [waitText(e), walkText(e, hopMinutes)];
  const trend = trendText(e, cfg);
  if (trend) parts.push(trend);
  return parts.join(', ');
}

/** Just the "why", for cards that already show wait and walk as numbers. null when it's simply the best mix. */
function whyFor(e, cfg, hopMinutes) {
  const parts = [];
  if (e.flags.includes('hop')) parts.push(`other park (+${hopMinutes} min hop)`);
  const trend = trendText(e, cfg);
  if (trend) parts.push(trend);
  if (e.flags.includes('wait-unknown')) parts.push('no posted wait');
  else if (e.flags.includes('wait-forecast')) parts.push('no posted wait, using the forecast');
  else if (e.flags.includes('wait-typical')) parts.push('no posted wait, using your usual-wait note');
  if (e.flags.includes('no-position')) parts.push('walk is a guess, no location');
  else if (e.flags.includes('no-coords')) parts.push('walk is a guess');
  if (!parts.length) return null;
  const s = parts.join(', ');
  return s[0].toUpperCase() + s.slice(1);
}

/** Why a ride on the list can't be ranked right now, or null when it can. */
function exclusion(ride, now) {
  switch (ride.status) {
    case 'DOWN':
      return { why: 'down', detail: 'down right now, check back' };
    case 'REFURBISHMENT':
      return { why: 'refurb', detail: 'closed for refurbishment' };
    case 'CLOSED':
      if (ride.open != null && ride.open > now) return { why: 'closed', detail: `opens ${fmtTime(ride.open)}` };
      return { why: 'closed', detail: 'closed for today' };
    case 'OPERATING':
      return null;
    default:
      return { why: 'unknown', detail: 'no live status' };
  }
}

/** Walk minutes (and hop / entry flags) from where we are to the ride. */
function walkTo(ride, ctx, cfg, hopMinutes) {
  const hasCoords = Number.isFinite(ride.lat) && Number.isFinite(ride.lng);
  if (!ctx.pos) return { walk: cfg.noCoordWalk, walkNoHop: cfg.noCoordWalk, flags: ['no-position'] };
  const otherPark = Boolean(ctx.posPark && ride.park && ride.park !== ctx.posPark);
  if (!hasCoords) {
    return otherPark
      ? { walk: cfg.noCoordWalk + hopMinutes, walkNoHop: cfg.noCoordWalk, flags: ['no-coords', 'hop'] }
      : { walk: cfg.noCoordWalk, walkNoHop: cfg.noCoordWalk, flags: ['no-coords'] };
  }
  const gate = !ctx.posPark ? ctx.gates?.[ride.park] : null;
  if (gate) {
    // Outside both parks: walk to that park's gate, tap in, walk to the ride. Same rule for both parks (R2).
    const mpm = SPEEDS[ctx.speed] ?? SPEEDS.normal;
    const m = haversineMeters(ctx.pos, gate) + haversineMeters(gate, ride);
    const w = (m * PATH_FACTOR) / mpm + cfg.entryMinutes;
    return { walk: w, walkNoHop: w, flags: ['outside'] };
  }
  const base = walkMinutes(ctx.pos, ride, { speed: ctx.speed });
  return otherPark ? { walk: base + hopMinutes, walkNoHop: base, flags: ['hop'] } : { walk: base, walkNoHop: base, flags: [] };
}

/**
 * Rank the wanted rides.
 * @param {object[]} rides normalized rides (see normalize.js)
 * @param {object} ctx { now, pos, posPark ('DL'|'DCA'|null = outside the parks), gates?: {DL,DCA},
 *   wanted:Set, done:Set, snoozed:{id:untilMs}, speed, hopMinutes, parks? }
 * @returns {{ ranked: object[], excluded: object[], done: object[], snoozed: object[] }}
 */
export function scoreRides(rides, ctx, overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const now = ctx.now ?? Date.now();
  const hopMinutes = ctx.hopMinutes ?? 20;
  const out = { ranked: [], excluded: [], done: [], snoozed: [] };
  const cands = [];

  // Pass 1: who's on the list, and what it costs to go now.
  for (const ride of rides) {
    if (!ctx.wanted?.has(ride.id)) continue;
    if (ctx.done?.has(ride.id)) {
      out.done.push({ ride });
      continue;
    }
    const until = ctx.snoozed?.[ride.id];
    if (until && until > now) {
      out.snoozed.push({ ride, until });
      continue;
    }
    const ex = exclusion(ride, now);
    if (ex) {
      out.excluded.push({ ride, ...ex });
      continue;
    }

    const { walk, walkNoHop, flags } = walkTo(ride, ctx, cfg, hopMinutes);
    const arrive = now + walk * MIN;

    // Operating windows still ahead of us today. A ride can pause (fireworks) and reopen later.
    // An OPERATING ride whose listed window already ended has stale hours: treat it as open.
    const listed = (ride.windows?.length ? ride.windows : [{ open: ride.open ?? -Infinity, close: ride.close ?? ctx.parks?.[ride.park]?.close ?? null }]).map((w) => ({
      open: w.open ?? -Infinity,
      close: w.close ?? null,
    }));
    let windows = listed.filter((w) => w.close == null || w.close > now);
    if (!windows.length) windows = [{ open: -Infinity, close: null }];
    // OPERATING before its listed opening (soft opening, early entry): the live status wins (R3).
    // Only before the day's first window: once a fireworks pause has started, a feed that still
    // says OPERATING is lagging, and the ride isn't open until its next window.
    if (windows[0] === listed[0] && windows[0].open > now) windows[0] = { open: -Infinity, close: windows[0].close };
    // Disney lets you ride if you're in the queue by closing time, so only arrival matters.
    const current = windows.find((w) => w.open <= arrive && (w.close == null || arrive <= w.close));
    if (!current) {
      const next = windows.find((w) => w.open > arrive);
      const shut = windows.find((w) => w.close != null && w.close < arrive);
      const detail = next
        ? `closes before you get there, reopens ${fmtTime(next.open)}`
        : `closes before you get there (${fmtTime(shut?.close ?? ride.close)})`;
      out.excluded.push({ ride, why: 'closes', detail, reopens: next?.open ?? null });
      continue;
    }

    const fNow = forecastAt(ride.forecast, now);
    let waitNow;
    if (Number.isFinite(ride.wait)) waitNow = ride.wait;
    else if (fNow != null) {
      waitNow = Math.round(fNow);
      flags.push('wait-forecast');
    } else if (Number.isFinite(ctx.typical?.[ride.id])) {
      waitNow = ctx.typical[ride.id]; // the family's own "usual wait" from the trip file
      flags.push('wait-typical');
    } else {
      waitNow = cfg.unknownWait;
      flags.push('wait-unknown');
    }
    // No per-ride "stale" flag: the feed's lastUpdated is when the wait last CHANGED, so a ride
    // holding at 5 min all afternoon looks hours old. Snapshot age is shown in the header instead.

    const waitArr = anchoredWait(ride.forecast, waitNow, now, arrive);
    cands.push({
      ride, walk, walkNoHop, flags, arrive, windows, fNow, waitNow, waitArr,
      close: current.close,
      finalClose: windows[windows.length - 1].close,
      nowCost: walk + waitArr,
    });
  }

  // Pass 2: compare going now with the best later slot, after doing something else first.
  for (const c of cands) {
    const { ride, flags, windows, finalClose, fNow, waitNow, waitArr, nowCost } = c;
    const others = cands.filter((o) => o !== c).map((o) => o.nowCost);
    const detour = others.length ? clamp(median(others), cfg.detourMin, cfg.detourMax) : cfg.detourDefault;
    const horizonEnd = finalClose ?? now + cfg.horizonHours * 3600e3;
    const from = ceilTo(now + detour * MIN, 15 * MIN);
    let best = null;
    for (const w of windows) {
      const wEnd = w.close != null ? w.close - cfg.closeBuffer * MIN : horizonEnd;
      const wFrom = Math.max(from, ceilTo(w.open, 15 * MIN));
      if (!(wFrom <= wEnd)) continue;
      const b = ride.forecast
        ? bestLater(ride.forecast, waitNow, now, wFrom, wEnd)
        : { t: wFrom, wait: waitNow }; // flat curve: the earliest slot is as good as any
      if (b && (!best || b.wait < best.wait)) best = b;
    }
    let urgency;
    let laterCost;
    if (best) {
      laterCost = cfg.laterOverhead + best.wait;
      urgency = clamp(c.walkNoHop - cfg.laterOverhead + (waitArr - best.wait), -cfg.urgencyClamp, cfg.urgencyClamp);
    } else {
      laterCost = Infinity;
      urgency = -cfg.urgencyClamp;
      flags.push('last-chance');
    }

    // Peak later today, on the same scaled forecast (for the "forecast 60 by 2 pm" reason).
    let peak = null;
    const rawPeak = peakAfter(ride.forecast, c.arrive, horizonEnd);
    if (rawPeak && fNow != null) peak = { t: rawPeak.t, wait: anchoredWait(ride.forecast, waitNow, now, rawPeak.t) };

    const { windows: _w, fNow: _f, ...rest } = c;
    // Priority head start from the trip file (must-dos sooner), constant per ride so it can't break monotonicity.
    const bias = ctx.bias?.[ride.id] ?? 0;
    const entry = { ...rest, laterCost, urgency, bias, score: nowCost + cfg.urgencyWeight * urgency + bias, detour, peak, best, later: best };
    entry.reason = reasonFor(entry, cfg, hopMinutes);
    entry.why = whyFor(entry, cfg, hopMinutes);
    out.ranked.push(entry);
  }

  out.ranked.sort((a, b) => a.score - b.score || a.nowCost - b.nowCost);
  return out;
}
