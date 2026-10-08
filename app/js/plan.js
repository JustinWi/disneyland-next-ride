// What the Next screen shows, built on scoreRides:
//  - today's park only (one park per day; no hopping unless todayPark is null);
//  - rides locked by the trip file ("after Big Thunder goes well") and rides you hold a Lightning
//    Lane for are set aside with a reason, not ranked for standby;
//  - rides that would make you miss a held Lightning Lane window are moved to `clash` with a reason;
//  - look-ahead: candidates are ranked by their best 2-3 ride route (route.js), not alone;
//  - hysteresis: the previous top pick stays unless something beats it by STICKY_MIN;
//  - rope-drop preview before opening.

import { scoreRides } from './score.js';
import { laneConflict } from './lightning.js';
import { fmtTime } from './time.js';
import { rankByRoute } from './route.js';
import { anchoredWait, forecastAt } from './forecast.js';

export const STICKY_MIN = 3;
const MIN = 60e3;
const ROPE_DROP_HORIZON = 4 * 3600e3;
const RIDE_MIN = 7;

export function plan(rides, ctx, { stickyId = null } = {}) {
  const now = ctx.now;
  // No park set = hopping between the two Disney parks; Knott's is a drive away, never mixed in.
  const pool = ctx.todayPark ? rides.filter((r) => r.park === ctx.todayPark) : rides.filter((r) => r.park !== 'KBF');
  const byId = new Map(rides.map((r) => [r.id, r]));
  const wanted = new Set([...(ctx.wanted ?? [])].filter((id) => byId.get(id) && pool.includes(byId.get(id))));
  const done = ctx.done ?? new Set();
  const aside = [];

  for (const [id, detail] of Object.entries(ctx.locked ?? {})) {
    if (wanted.has(id) && !done.has(id)) {
      wanted.delete(id);
      aside.push({ ride: byId.get(id), why: 'locked', detail });
    }
  }
  const lanes = (ctx.lanes ?? []).filter((b) => b.status === 'held' && b.end > now);
  for (const b of lanes) {
    if (!b.multiExp && wanted.has(b.rideId) && !done.has(b.rideId)) {
      wanted.delete(b.rideId);
      aside.push({ ride: byId.get(b.rideId), why: 'lane', detail: `Lightning Lane ${fmtTime(b.start)} to ${fmtTime(b.end)}` });
    }
  }

  const res = scoreRides(pool, { ...ctx, wanted });
  res.excluded = [...aside, ...res.excluded];

  // Clashes with a held Lightning Lane window.
  res.clash = [];
  const keep = [];
  for (const e of res.ranked) {
    const lane = laneConflict(e, lanes, byId, { speed: ctx.speed, rideMin: RIDE_MIN });
    if (lane) {
      res.clash.push({ ride: e.ride, entry: e, detail: `would make you miss your Lightning Lane (${byId.get(lane.rideId)?.name ?? 'booked ride'}, until ${fmtTime(lane.end)})` });
      continue;
    }
    keep.push(e);
  }
  // Look two or three rides ahead: rank by the best short route, not the next ride alone.
  res.ranked = ctx.lookahead === false ? keep.map((e) => ({ ...e, routeScore: e.score, route: [] })) : rankByRoute(keep, ctx, { lanes, ridesById: byId });

  if (stickyId && res.ranked.length > 1 && res.ranked[0].ride.id !== stickyId) {
    const i = res.ranked.findIndex((e) => e.ride.id === stickyId);
    if (i > 0 && res.ranked[i].routeScore - res.ranked[0].routeScore < STICKY_MIN) {
      const [kept] = res.ranked.splice(i, 1);
      res.ranked.unshift(kept);
    }
  }

  res.ropeDrop = null;
  if (res.ranked.length === 0) {
    const opening = res.excluded.filter(
      (e) => e.why === 'closed' && e.ride.open != null && e.ride.open > now && e.ride.open - now <= ROPE_DROP_HORIZON,
    );
    if (opening.length) {
      const at = Math.min(...opening.map((e) => e.ride.open));
      const asOpen = opening.map((e) => ({ ...e.ride, status: 'OPERATING', wait: null }));
      const pre = scoreRides(asOpen, { ...ctx, wanted, now: at, snoozed: {} });
      if (pre.ranked.length) res.ropeDrop = { at, ranked: pre.ranked };
    }
  }
  return res;
}

/**
 * E17 "We're on our way": where to start. The best short route from the park's gate at your
 * arrival time (waits moved along today's forecast), for today's park. A sense of direction, not
 * a fixed plan: it's recomputed once you're inside.
 */
export function arrivalPlan(rides, ctx, { park, gate, eta, lanes = ctx.lanes ?? [] }) {
  // Arriving before the gates open: plan from opening time.
  const parkOpen = ctx.parks?.[park]?.open ?? null;
  const at = parkOpen != null && eta < parkOpen ? parkOpen : eta;
  const ahead = rides.map((r) => rideAt(r, at, ctx.now));
  // Held Lightning Lanes count: that ride is set aside, and the route has to leave time for it.
  const r = plan(ahead, { ...ctx, now: at, pos: gate, posPark: park, todayPark: park, lanes, snoozed: {} });
  const top = r.ranked[0];
  if (top) return { eta, at, park, first: top, steps: [top, ...top.route.map((s) => s.entry)], alternatives: r.ranked.slice(1, 3) };
  // Nothing expected to be running yet (no hours in the feed before opening): the rope-drop order.
  const rd = r.ropeDrop?.ranked ?? [];
  if (rd.length) return { eta, at: r.ropeDrop.at, park, first: rd[0], steps: rd.slice(0, 3), alternatives: [], ropeDrop: true };
  return null;
}

/**
 * A ride as it will likely be at time `t`, planning ahead from `now`. Closed now but inside one of
 * its windows at `t`: expected running, at its forecast wait. Running now but outside every window
 * at `t` (a fireworks pause, or closed by then): expected closed. Waits move along today's
 * forecast. DOWN and refurbishment stay as they are, since nobody knows when a breakdown ends.
 */
export function rideAt(r, t, now) {
  if (r.status !== 'OPERATING' && r.status !== 'CLOSED') return r;
  const wins = (r.windows?.length ? r.windows : r.open != null || r.close != null ? [{ open: r.open, close: r.close }] : []).map((w) => ({
    open: w.open ?? -Infinity,
    close: w.close ?? Infinity,
  }));
  if (!wins.length) return r;
  const inside = wins.some((w) => w.open <= t && t < w.close);
  if (r.status === 'OPERATING') {
    const staleHours = !r.parkHours && !wins.some((w) => w.close > now); // every listed window is over, yet it's running
    const early = t < wins[0].open; // running ahead of its listed opening: still running then
    if (!inside && !staleHours && !early) return { ...r, status: 'CLOSED', wait: null };
    return Number.isFinite(r.wait) ? { ...r, wait: Math.round(anchoredWait(r.forecast, r.wait, now, t)) } : r;
  }
  if (!inside) return r;
  const f = forecastAt(r.forecast, t);
  return { ...r, status: 'OPERATING', wait: f != null ? Math.round(f) : null };
}
