// Look two or three rides ahead so the pick leads into a sensible route instead of zigzagging
// across the park. Re-planned after every ride, so it only commits to the first step.
//
// For each candidate first ride, find its best continuation of up to `depth` rides from the top
// candidates, walking from ride to ride and predicting each wait at its arrival time. A step costs
// what the scorer charges for one ride (walk + wait, plus the same urgency and priority terms),
// with later steps discounted. Candidates are then ranked by their best route.

import { anchoredWait } from './forecast.js';
import { walkMinutes } from './geo.js';

const MIN = 60e3;
export const ROUTE = { depth: 3, pool: 10, weights: [1, 0.7, 0.5], rideMin: 7, laterOverhead: 8, urgencyClamp: 45, urgencyWeight: 1 };

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Walk between two rides; adds the hop when the parks differ. */
function walkBetween(a, b, ctx) {
  if (!Number.isFinite(a?.lat) || !Number.isFinite(b?.lat)) return 10;
  const w = walkMinutes(a, b, { speed: ctx.speed });
  return a.park && b.park && a.park !== b.park ? w + (ctx.hopMinutes ?? 20) : w;
}

/** The scorer's cost for riding entry `e` after walking `walk` minutes and finding `wait`. */
function stepCost(e, walk, wait, cfg) {
  const later = Number.isFinite(e.laterCost) ? e.laterCost - cfg.laterOverhead : null;
  const trend = later == null ? -cfg.urgencyClamp : clamp(walk - cfg.laterOverhead + (wait - later), -cfg.urgencyClamp, cfg.urgencyClamp);
  return walk + wait + cfg.urgencyWeight * trend + (e.bias ?? 0);
}

/**
 * Can entry `e` be joined at time `t`? It has to be inside one of its operating windows: a ride that
 * pauses for fireworks can't be the next step during the pause. Same rules as the scorer: windows
 * already over are ignored (all over while running means stale hours), and running ahead of the
 * first listed opening counts as open.
 */
function openAt(e, t, now) {
  const listed = (e.ride?.windows ?? []).map((w) => ({ open: w.open ?? -Infinity, close: w.close ?? null }));
  const wins = listed.filter((w) => w.close == null || w.close > now);
  if (!wins.length) {
    const close = e.finalClose ?? e.close ?? null;
    return close == null || t <= close;
  }
  if (wins[0] === listed[0] && wins[0].open > now) wins[0] = { ...wins[0], open: -Infinity };
  return wins.some((w) => w.open <= t && (w.close == null || t <= w.close));
}

/**
 * Rank scored entries (from scoreRides/plan) by their best short route.
 * lanes: held Lightning Lane bookings; a route that would make you miss one is not allowed.
 * ridesById: Map for lane rides' locations.
 * Returns the entries re-ordered, each with `routeScore` and `route` (the following steps).
 */
export function rankByRoute(entries, ctx, { lanes = [], ridesById = new Map() } = {}, over = {}) {
  const cfg = { ...ROUTE, ...over };
  if (entries.length < 2) return entries.map((e) => ({ ...e, routeScore: e.score, route: [] }));
  const pool = entries.slice(0, cfg.pool);
  const heldLanes = lanes.filter((b) => b.status === 'held' && !b.multiExp && b.end > ctx.now);

  const laneOk = (ride, finish) =>
    heldLanes.every((b) => {
      if (b.rideId === ride.id) return true;
      const lr = ridesById.get(b.rideId);
      const walk = lr ? walkBetween(ride, lr, ctx) : 10;
      return finish + walk * MIN <= b.end;
    });

  // Best continuation from (ride, time) over the remaining pool, depth-limited.
  const best = (from, t, used, stepIdx) => {
    if (stepIdx >= cfg.depth) return { cost: 0, steps: [] };
    let out = { cost: 0, steps: [] }; // stopping early is allowed (nothing good left)
    let found = false;
    for (const e of pool) {
      if (used.has(e.ride.id)) continue;
      const walk = walkBetween(from, e.ride, ctx);
      const arrive = t + walk * MIN;
      if (!openAt(e, arrive, ctx.now)) continue;
      const wait = anchoredWait(e.ride.forecast, e.waitNow, ctx.now, arrive);
      const finish = arrive + (wait + cfg.rideMin) * MIN;
      if (!laneOk(e.ride, finish)) continue;
      const here = cfg.weights[stepIdx] * stepCost(e, walk, wait, cfg);
      used.add(e.ride.id);
      const rest = best(e.ride, finish, used, stepIdx + 1);
      used.delete(e.ride.id);
      const total = here + rest.cost;
      if (!found || total < out.cost) {
        out = { cost: total, steps: [{ entry: e, walk, wait, arrive }, ...rest.steps] };
        found = true;
      }
    }
    return out;
  };

  const ranked = entries.map((e) => {
    if (!pool.includes(e)) return { ...e, routeScore: Infinity, route: [] };
    const used = new Set([e.ride.id]);
    const finish = e.arrive + (e.waitArr + cfg.rideMin) * MIN;
    const rest = best(e.ride, finish, used, 1);
    return { ...e, routeScore: cfg.weights[0] * e.score + rest.cost, route: rest.steps };
  });
  ranked.sort((a, b) => a.routeScore - b.routeScore || a.score - b.score);
  return ranked;
}
