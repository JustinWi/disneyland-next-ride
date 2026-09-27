// Lightning Lane Multi Pass at Disneyland Resort. Rules as published for 2026 (checked 2026-09-26,
// mickeyvisit.com/disneyland-lightning-lane and allears.net 2025-12-16, matching the family's file):
//  - the first booking of the day opens only after you scan into a park;
//  - one booking at a time: the next opens when you tap in to the current one, or 2 hours after
//    booking it, whichever comes first;
//  - each attraction once per day;
//  - if the ride is down during your return window, the booking becomes a Multiple Experience pass,
//    good at any other Multi Pass ride in that park, not limited to once per ride.
// The Disney app is the authority: this module only advises and keeps the family's own record.
// Pure functions; state is { day, scannedAt, bookings: [...] } kept by the app in localStorage.

import { forecastAt, anchoredWait } from './forecast.js';
import { walkMinutes } from './geo.js';
import { fmtTime } from './time.js';

const MIN = 60e3;
export const LL = { rebookMin: 120, windowMin: 60, laneWaitMin: 10, soonMin: 20 };
const PRIORITY_WEIGHT = { must: 1.5, high: 1.2, medium: 1, low: 0.7, conditional: 0.8 };
const round5 = (n) => Math.round(n / 5) * 5;

export const freshDay = (day) => ({ day, scannedAt: null, bookings: [] });
export const forDay = (st, day) => (st && st.day === day && Array.isArray(st.bookings) ? st : freshDay(day));

const live = (b) => b.status !== 'cancelled';
const multi = (st) => st.bookings.filter((b) => b.kind === 'multi' && live(b)).sort((a, b) => a.bookedAt - b.bookedAt);

/** When the next Multi Pass booking is allowed: { at, why: 'scan'|'now'|'wait', last? }. */
export function nextBooking(st, now) {
  if (!st.scannedAt) return { at: null, why: 'scan' };
  const list = multi(st);
  const last = list[list.length - 1];
  if (!last) return { at: st.scannedAt, why: 'now' };
  const byTimer = last.bookedAt + LL.rebookMin * MIN;
  const at = last.status === 'used' && last.usedAt != null ? Math.min(byTimer, last.usedAt) : byTimer;
  return { at, why: at <= now ? 'now' : 'wait', last };
}

/**
 * Rides already booked or used with Multi Pass today (each attraction once per day). A booking that
 * turned into a Multiple Experience pass still counts for its ride: the pass is good there anyway.
 */
export const takenIds = (st) => new Set(multi(st).map((b) => b.rideId));

/** Bookings not yet used, soonest first. */
export const heldBookings = (st) => st.bookings.filter((b) => b.status === 'held').sort((a, b) => a.start - b.start);

/**
 * A held Multi Pass booking whose ride is DOWN during its window becomes a Multiple Experience pass.
 * Returns { st, converted: [booking] } without mutating the input.
 */
export function convertDown(st, ridesById, now) {
  const converted = [];
  const bookings = st.bookings.map((b) => {
    if (b.kind !== 'multi' || b.status !== 'held' || b.multiExp) return b;
    if (!(now >= b.start && now <= b.end)) return b;
    if (ridesById.get(b.rideId)?.status !== 'DOWN') return b;
    const nb = { ...b, multiExp: true, convertedAt: now };
    converted.push(nb);
    return nb;
  });
  return { st: converted.length ? { ...st, bookings } : st, converted };
}

/** Bookings to show on the Next screen: window open or opening within LL.soonMin, and every Multiple Experience pass. */
export function dueBookings(st, now) {
  return heldBookings(st).filter((b) => b.multiExp || (now >= b.start - LL.soonMin * MIN && now <= b.end));
}

function waitNowOf(r, now, typical) {
  if (Number.isFinite(r.wait)) return r.wait;
  const f = forecastAt(r.forecast, now);
  if (f != null) return f;
  return typical ?? 20;
}

/**
 * What to book next with Multi Pass. Value = standby minutes saved at the return time (× priority),
 * plus a little for returns already far out (in demand, likely to sell out first).
 * ctx: { now, todayPark, wanted:Set, done:Set, priority:{id:'must'|…}, locked:Set, typical:{id:min},
 *        stats?: laneStats(), hourOf?: ms -> park hour }
 * Returns { recs, soldOut, skipped } where skipped carries a reason ('locked' | 'late').
 */
export function adviseMulti(rides, ctx, st) {
  const now = ctx.now;
  const taken = takenIds(st);
  const recs = [];
  const soldOut = [];
  const skipped = [];
  for (const r of rides) {
    if (!ctx.wanted?.has(r.id) || ctx.done?.has(r.id)) continue;
    if (ctx.todayPark && r.park !== ctx.todayPark) continue;
    if (r.ll?.multiState == null) continue; // no Multi Pass on this ride
    if (taken.has(r.id)) continue;
    if (r.status === 'REFURBISHMENT') continue;
    if (ctx.locked?.has(r.id)) {
      skipped.push({ ride: r, why: 'locked' });
      continue;
    }
    if (r.ll.multiState !== 'AVAILABLE' || !r.ll.multi) {
      soldOut.push({ ride: r });
      continue;
    }
    const start = r.ll.multi.start;
    const end = r.ll.multi.end ?? start + LL.windowMin * MIN;
    const lastClose = r.windows?.length ? r.windows[r.windows.length - 1].close : r.close;
    if (lastClose != null && start > lastClose) {
      skipped.push({ ride: r, why: 'late', start });
      continue;
    }
    const w = waitNowOf(r, now, ctx.typical?.[r.id]);
    const mid = start + (LL.windowMin / 2) * MIN;
    const standbyAt = r.forecast ? anchoredWait(r.forecast, w, now, mid) : w;
    const saved = Math.max(0, standbyAt - LL.laneWaitMin);
    const prio = ctx.priority?.[r.id] ?? null;
    const aheadMin = Math.max(0, (start - now) / MIN);
    let value = saved * (PRIORITY_WEIGHT[prio] ?? 1) + Math.min(20, aheadMin * 0.1);
    const bits = [`return ~${fmtTime(start)}`, saved >= 5 ? `saves ~${Math.max(5, round5(saved))} min of standby` : 'saves little right now'];
    if (aheadMin >= 150) bits.push('books up fast');
    if (ctx.stats && ctx.hourOf) {
      const pn = patternNotes(ctx.stats.get(r.id), now, start, ctx.hourOf);
      value += pn.bonus;
      bits.push(...pn.notes);
    }
    if (r.status === 'DOWN') {
      // It may be back by the return time, but don't lead with a ride that isn't running.
      bits.push('down right now');
      value *= 0.5;
    }
    recs.push({ ride: r, start, end, standbyAt, saved, value, priority: prio, reason: bits.join(', ') });
  }
  recs.sort((a, b) => b.value - a.value);
  return { recs, soldOut, skipped };
}

/**
 * Where to use a Multiple Experience pass: other Multi Pass rides in the park that are running,
 * rides on your list first, then by longest standby (the most time saved).
 */
export function multiExpOptions(rides, ctx, exceptId = null) {
  return rides
    .filter((r) => r.ll?.multiState != null && r.status === 'OPERATING' && r.id !== exceptId && (!ctx.todayPark || r.park === ctx.todayPark))
    // Not ridden, not avoided, and not set aside by the plan (a ladder lock, or too short to ride).
    .filter((r) => !ctx.done?.has(r.id) && !ctx.avoid?.has(r.id) && !ctx.locked?.[r.id])
    .map((r) => ({ ride: r, wait: Number.isFinite(r.wait) ? r.wait : 0, onList: Boolean(ctx.wanted?.has(r.id)) }))
    .sort((a, b) => Number(b.onList) - Number(a.onList) || b.wait - a.wait);
}

/**
 * Would doing entry `e` (a scored standby ride) make you miss a held Lightning Lane window?
 * Finish = arrival + predicted wait + ride; then the walk to the lane ride must land before its end.
 */
export function laneConflict(e, lanes, ridesById, { speed = 'normal', rideMin = 7 } = {}) {
  const finish = e.arrive + (e.waitArr + rideMin) * MIN;
  for (const b of lanes) {
    if (b.multiExp || b.rideId === e.ride.id) continue;
    const lr = ridesById.get(b.rideId);
    const walk = lr && Number.isFinite(lr.lat) && Number.isFinite(e.ride.lat) ? walkMinutes(e.ride, lr, { speed }) : 10;
    if (finish + walk * MIN > b.end) return b;
  }
  return null;
}

// ---- Learned patterns (app/data/llstats.json, from ThemeParks.wiki history) ----

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Per-ride patterns for one park, preferring days with the same weekday.
 * Returns Map rideId -> { name, kind, days, sameWeekday, avail:{h:0..1}, ahead:{h:min}, standby:{h:min} }.
 * avail[h] = share of sampled days the lane could still be booked at quarter past h (while running).
 */
export function laneStats(llstats, park, weekday) {
  const all = Object.values(llstats?.days ?? {}).filter((d) => d.park === park);
  const same = all.filter((d) => d.weekday === weekday);
  const use = same.length >= 3 ? same : all; // one Monday is an anecdote; blend days until there are three
  const out = new Map();
  const ids = new Set(use.flatMap((d) => Object.keys(d.rides)));
  for (const id of ids) {
    const days = use.map((d) => d.rides[id]).filter(Boolean);
    const avail = {};
    const ahead = {};
    const standby = {};
    for (let h = 8; h <= 23; h++) {
      const seen = days.filter((r) => r.ahead[h] != null || r.standby[h] != null);
      if (seen.length) avail[h] = seen.filter((r) => r.ahead[h] != null).length / seen.length;
      const a = days.map((r) => r.ahead[h]).filter((x) => x != null);
      if (a.length) ahead[h] = median(a);
      const w = days.map((r) => r.standby[h]).filter((x) => x != null);
      if (w.length) standby[h] = median(w);
    }
    out.set(id, { name: days[0].name, kind: days[0].kind, days: days.length, sameWeekday: use === same, avail, ahead, standby });
  }
  return out;
}

/** First hour at or after `fromHour` when the lane is usually gone (available on under half the days). */
export function usuallyGoneBy(s, fromHour) {
  for (let h = fromHour; h <= 23; h++) if (s.avail[h] != null && s.avail[h] < 0.5) return h;
  return null;
}

const hourLabel = (h) => (h === 12 ? '12 pm' : h > 12 ? `${h - 12} pm` : `${h} am`);

/**
 * Simulate a whole day of Multi Pass booking to decide whether buying it is worth it, and to give a
 * booking plan. From scan-in, repeatedly book the best lane still usually available (value = standby
 * you'd skip at that return time, × priority, × 1.3 if it's usually gone before you could book again),
 * never past close; the next booking is at the return time (you tap in) or 2 hours later.
 * `realism` discounts the saving because without Lightning Lane the app would still steer you to
 * shorter standby times.
 */
/** Worth it at ≤ $1 per minute of family standby saved (and an hour or more saved); your call up to $2. */
export const VERDICT_RULE = { buyPerMin: 1, buyMinSaved: 60, maybePerMin: 2, maybeMinSaved: 45 };
const RIDE_MIN = 7;
const WALK_MIN = 8;

export function planLaneDay({ rides, stats, open, close, priceEach = 37, party = 4, laneWait = LL.laneWaitMin, realism = 0.85, hourOf, dayOpen = open }) {
  const bookings = [];
  const booked = new Map(); // rideId -> booking
  const inPlan = new Set(rides.map((r) => r.id));
  let free = open; // when you're next free to walk to a lane (after the last lane ride)
  // A ladder rung waits on the ones before it: a gate in this plan must have come back first;
  // a gate outside it (no Multi Pass, e.g. Pirates) is assumed ridden standby in the first 90 minutes.
  const gatesOk = (r, R) =>
    (r.after ?? []).every((g) => (inPlan.has(g) ? booked.has(g) && booked.get(g).returnAt + 30 * MIN <= R : R >= dayOpen + 90 * MIN));
  const openH = hourOf(open);
  const closeH = hourOf(close - MIN);
  // What riding it standby would usually cost you today: its median wait over your park hours.
  const typicalOf = (s, r) => {
    const hs = Object.keys(s.standby).map(Number).filter((h) => h >= openH && h <= closeH);
    return median(hs.map((h) => s.standby[h])) ?? r.typical ?? 20;
  };
  let t = Math.max(open, dayOpen + 5 * MIN);
  const last = close - 60 * MIN;
  for (let guard = 0; t < last && guard < 48; guard++) {
    const h = hourOf(t);
    let best = null;
    for (const r of rides) {
      if (booked.has(r.id)) continue;
      const s = stats.get(r.id);
      if (!s || !(s.avail[h] >= 0.5) || s.ahead[h] == null) continue;
      const R = t + s.ahead[h] * MIN;
      const E = R + LL.windowMin * MIN;
      if (E > close) continue;
      if (!gatesOk(r, R)) continue;
      // Saved = the smaller of the line at your return time and its usual line: a lane used when
      // the line is short anyway saves little, and you'd otherwise ride it at about its usual wait.
      const atReturn = s.standby[hourOf(R + 30 * MIN)] ?? r.typical ?? 20;
      const usual = typicalOf(s, r);
      const saved = Math.max(0, Math.min(atReturn, usual) - laneWait);
      const potential = Math.max(0, usual - laneWait);
      // Each ride's lane can be used once a day: spend it when it saves most of what it can, unless
      // it's usually sold out within two hours, in which case take it while it's there.
      const soonGone = [h + 1, h + 2].some((x) => s.avail[x] != null && s.avail[x] < 0.5);
      if (saved < 10 || !(saved >= 0.7 * potential || soonGone)) continue;
      const growth = (s.ahead[h + 2] ?? s.ahead[h + 1] ?? s.ahead[h]) - s.ahead[h];
      const value = saved * (PRIORITY_WEIGHT[r.priority] ?? 1) * (r.conditional ? 0.5 : 1) * (soonGone ? 1.3 : 1);
      if (!best || value > best.value) best = { r, R, sb: atReturn, usual, saved, value, soonGone, growth };
    }
    if (!best) {
      t += 30 * MIN;
      continue;
    }
    // You tap in when you get there: at the return time, or once you've finished the last lane ride
    // and walked over. Tapping in opens the next booking (or the 2-hour timer does, if sooner).
    const tapIn = Math.max(best.R, free + WALK_MIN * MIN);
    const b = {
      rideId: best.r.id, name: best.r.name, bookAt: t, returnAt: best.R, tapIn, standby: best.sb, usual: best.usual,
      saved: best.saved, conditional: Boolean(best.r.conditional), soonGone: best.soonGone, climbing: best.growth >= 60,
    };
    booked.set(best.r.id, b);
    bookings.push(b);
    free = tapIn + (laneWait + RIDE_MIN) * MIN;
    t = Math.min(t + LL.rebookMin * MIN, Math.max(tapIn, t + 5 * MIN));
  }
  const saved = Math.round(bookings.reduce((sum, b) => sum + b.saved * (b.conditional ? 0.5 : 1), 0) * realism);
  const cost = priceEach * party;
  const per = saved ? cost / saved : Infinity;
  const R_ = VERDICT_RULE;
  const verdict = saved >= R_.buyMinSaved && per <= R_.buyPerMin ? 'buy' : saved >= R_.maybeMinSaved && per <= R_.maybePerMin ? 'maybe' : 'skip';
  const missing = rides.filter((r) => !stats.get(r.id)).map((r) => r.name);
  return { bookings, saved, cost, perMin: saved ? cost / saved : null, verdict, missing };
}

/** Extra advice from learned patterns for a live recommendation: scarcity and a short return. */
export function patternNotes(s, now, start, hourOf) {
  const notes = [];
  let bonus = 0;
  if (s) {
    const gone = usuallyGoneBy(s, hourOf(now) + 1);
    if (gone != null && gone <= hourOf(now) + 3) {
      notes.push(`usually gone by ${hourLabel(gone)}`);
      bonus += 15;
    }
  }
  if (start - now <= 45 * MIN) {
    notes.push('quick to use, so you can rebook sooner');
    bonus += 5;
  }
  return { notes, bonus };
}

/**
 * L2: for a paid Single Pass ride (Radiator Springs Racers, Rise of the Resistance), ride standby now,
 * wait for its usual low point, or buy. Uses the live wait moved along today's forecast, or the
 * learned hourly standby when there's no forecast.
 * Returns { kind: 'now' | 'wait' | 'buy' | 'unknown', text, low? }.
 */
export function singlePassAdvice(ride, { now, stats, hourOf, close }) {
  const wait = Number.isFinite(ride.wait) ? ride.wait : null;
  if (wait == null) return { kind: 'unknown', text: 'No posted standby wait right now.' };
  // Sold out for the day: the only choice left is when to ride standby.
  const soldOut = ride.ll?.singleState === 'FINISHED';
  const price = soldOut ? null : ride.ll?.singlePrice ?? null;
  let low = null;
  const end = close ?? now + 6 * 3600e3;
  for (let t = now + 60 * MIN; t <= end - 30 * MIN; t += 30 * MIN) {
    const w = ride.forecast ? anchoredWait(ride.forecast, wait, now, t) : stats?.standby?.[hourOf(t)];
    if (Number.isFinite(w) && (!low || w < low.wait)) low = { t, wait: w };
  }
  if (wait <= 30) return { kind: 'now', low, text: `Standby is short now (${wait} min): ride it and skip the Single Pass.` };
  if (low && low.wait <= wait - 20) {
    return {
      kind: 'wait',
      low,
      text: `Standby is ${wait} min now and usually drops to about ${Math.max(5, round5(low.wait))} around ${fmtTime(low.t)}. Worth waiting if you can come back then${price ? `; otherwise a Single Pass (${price}) skips it` : ''}.`,
    };
  }
  const best = low ? `, about ${Math.max(5, round5(low.wait))} at best later` : '';
  if (soldOut) return { kind: 'standby', low, text: `The Single Pass is sold out today. Standby stays long (${wait} min now${best}), so ride it when the line is shortest or skip it.` };
  return { kind: 'buy', low, text: `Standby stays long today (${wait} min now${best}). ${price ? `A Single Pass (${price}) saves about ${round5(wait - LL.laneWaitMin)} min.` : 'A Single Pass would save most of it.'}` };
}
