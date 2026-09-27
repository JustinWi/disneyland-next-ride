// In-app reminders. Delivery is a banner plus vibration while the app is open (the delivery the
// family chose). Each generator returns candidates { key, kind, title, body, action? }; the app
// shows each key once per park day and remembers what it has shown.

import { fmtTime } from './time.js';

const MIN = 60e3;
export const LEAD = { laneOpen: 15, laneEnd: 15, lastChance: 45, showExtra: 15 };

/**
 * R1: a held return window opening within 15 minutes (or already open and not ending soon), and
 * 15 minutes before it ends unused. One reminder each per booking.
 */
export function laneAlerts(bookings, now, nameOf) {
  const out = [];
  for (const b of bookings ?? []) {
    if (b.status !== 'held' || b.multiExp) continue;
    const name = nameOf(b.rideId);
    if (now >= b.start - LEAD.laneOpen * MIN && now < b.end - LEAD.laneEnd * MIN) {
      const open = now >= b.start;
      out.push({
        key: `lane-open-${b.id}`,
        kind: 'lane',
        title: open ? `Lightning Lane open: ${name}` : `Lightning Lane soon: ${name}`,
        body: open ? `Your return window is open until ${fmtTime(b.end)}.` : `Your return window opens at ${fmtTime(b.start)}.`,
        action: 'next',
      });
    }
    if (now >= b.end - LEAD.laneEnd * MIN && now < b.end) {
      out.push({ key: `lane-end-${b.id}`, kind: 'lane', title: `Lightning Lane ending: ${name}`, body: `Tap in by ${fmtTime(b.end)} or it's gone.`, action: 'next' });
    }
  }
  return out;
}

/** R2: the moment the next Multi Pass booking is allowed (scan-in, tap-in or the 2-hour timer). */
export function bookNextAlert({ llOn, next, recs }) {
  if (llOn !== 'on' || !next || next.why !== 'now' || !recs?.length) return [];
  const r = recs[0];
  return [{ key: `book-${next.last?.id ?? 'first'}`, kind: 'book', title: 'You can book your next Lightning Lane', body: `Suggested: ${r.ride.name} (${r.reason}).`, action: 'lanes' }];
}

const windowsOf = (ride) => (ride.windows?.length ? ride.windows : [{ open: ride.open, close: ride.close }]);

/** The last time today a ride can be joined, or null. */
export function finalClose(ride, now) {
  const wins = windowsOf(ride).filter((w) => w.close != null && w.close > now);
  return wins.length ? Math.max(...wins.map((w) => w.close)) : null;
}

/** R4: a must-do on the list that isn't done yet closes for the day within 45 minutes. */
export function lastChanceAlerts({ rides, wanted, done, priority, locked, now }) {
  const out = [];
  for (const r of rides ?? []) {
    if (!wanted?.has(r.id) || done?.has(r.id) || locked?.has?.(r.id)) continue;
    if (priority?.[r.id] !== 'must' || r.status !== 'OPERATING') continue;
    const close = finalClose(r, now);
    if (close == null || close - now > LEAD.lastChance * MIN) continue;
    const wait = Number.isFinite(r.wait) ? ` It's a ${r.wait} min wait now.` : '';
    out.push({ key: `last-${r.id}`, kind: 'last', title: `Last chance: ${r.name}`, body: `It closes at ${fmtTime(close)} and it's a must-do.${wait}`, action: 'next' });
  }
  return out;
}

// A ride restarting within 30 minutes of a scheduled reopening (after fireworks, say) isn't news.
const scheduledRestart = (r, now) => (r.windows ?? []).some((w, i) => i > 0 && w.open <= now && now - w.open < 30 * MIN);
// Outside every window with a later one today: a scheduled pause, not a breakdown.
const scheduledReopen = (r, now) => {
  const wins = r.windows ?? [];
  if (!wins.length || wins.some((w) => w.open <= now && now < w.close)) return null;
  return wins.find((w) => w.open > now)?.open ?? null;
};

/**
 * C1 and C2: status changes since the last look. A ride on your list coming back up, and the ride
 * you're heading to going down (with the next best pick). Returns { alerts, status } where status is
 * the map to remember for next time. The first look at a ride never alerts, and each ride alerts at
 * most once per park day for each kind (the app resets its shown keys every park day).
 * `wanted` should hold only rides that can alert now (today's park); `skip` holds rides the plan
 * has set aside (locked, too short, snoozed), which never get a "back up".
 */
export function statusAlerts({ rides, prev = {}, wanted, done, skip, headingTo = null, nextBest = null, now }) {
  const alerts = [];
  const status = {};
  for (const r of rides ?? []) {
    status[r.id] = r.status;
    const was = prev[r.id];
    if (!was || was === r.status || !wanted?.has(r.id) || done?.has(r.id)) continue;
    if (was === 'DOWN' && r.status === 'OPERATING' && !skip?.has?.(r.id) && !scheduledRestart(r, now)) {
      const wait = Number.isFinite(r.wait) ? `, ${r.wait} min wait` : '';
      alerts.push({ key: `up-${r.id}`, kind: 'up', title: `${r.name} is back up${wait}`, short: `${r.name}${Number.isFinite(r.wait) ? ` (${r.wait} min)` : ''}`, body: 'It was down earlier. It is on your list again.', action: 'next' });
    }
    if (r.id === headingTo && was === 'OPERATING' && r.status === 'DOWN') {
      const alt = nextBest && nextBest.id !== r.id ? ` Next best from here: ${nextBest.name}.` : '';
      const back = scheduledReopen(r, now);
      const body = back ? `It's scheduled to reopen at ${fmtTime(back)}.${alt}` : `Rides often reopen within the hour; you'll get a note when it's back.${alt}`;
      alerts.push({ key: `down-${r.id}`, kind: 'down', title: `${r.name} just went down`, body, action: 'next' });
    }
  }
  return { alerts, status };
}

/**
 * R5: a show you want reminding about, early enough to get a spot: `lead` minutes before it starts
 * is when to leave, and the reminder comes 15 minutes before that.
 */
export function showAlerts(shows, now, wantsReminder) {
  const out = [];
  for (const s of shows ?? []) {
    if (!wantsReminder(s)) continue;
    for (const t of s.times) {
      if (now >= t - (s.lead + LEAD.showExtra) * MIN && now < t) {
        const leaveAt = t - s.lead * MIN;
        const spot = leaveAt > now ? `Leave by ${fmtTime(leaveAt)} for a good spot.` : 'Head there now for a good spot.';
        const body = s.lead >= 25 ? `${spot}${s.tip ? ' ' + s.tip : ''}` : `Starts in about ${Math.round((t - now) / MIN)} min.`;
        out.push({ key: `show-${s.id}-${t}`, kind: 'show', title: `${s.name} at ${fmtTime(t)}`, body, action: 'next' });
      }
    }
  }
  return out;
}

/** Banner order when space runs out: the least urgent go first, so status news never pushes out a return window. */
export const URGENCY = { lane: 0, last: 1, book: 2, down: 3, show: 4, up: 5, info: 6 };

/**
 * Merge fresh alerts into the banners on screen, at most `max`. Several "back up" alerts at once
 * become one banner. Returns the new banner list.
 */
export function mergeBanners(banners, fresh, max = 4) {
  const ups = fresh.filter((a) => a.kind === 'up');
  const shown = fresh.filter((a) => a.kind !== 'up');
  if (ups.length === 1) shown.push(ups[0]);
  else if (ups.length > 1) {
    shown.push({ key: `up-group-${ups.map((a) => a.key).join('+')}`, kind: 'up', title: `${ups.length} rides on your list are back up`, body: `${ups.map((a) => a.short ?? a.title).join(', ')}.`, action: 'next' });
  }
  const out = [...banners.filter((b) => !shown.some((a) => a.key === b.key)), ...shown];
  while (out.length > max) {
    let worst = 0;
    for (let i = 1; i < out.length; i++) if ((URGENCY[out[i].kind] ?? 9) > (URGENCY[out[worst].kind] ?? 9)) worst = i;
    out.splice(worst, 1);
  }
  return out;
}
