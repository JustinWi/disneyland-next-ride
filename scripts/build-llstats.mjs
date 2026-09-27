// Learn Lightning Lane patterns from ThemeParks.wiki history and write app/data/llstats.json.
//
//   node scripts/build-llstats.mjs [--days 7]
//
// For each park-day (keyless access reaches back 7 days; one call covers a whole park-day) and each
// Multi Pass or Single Pass ride it records:
//   sellOut      park-local "HH:MM" when the lane first sold out that day, or null if it never did
//   ahead        { "8": minutes, … } how far out the return time was if you booked at quarter past
//   standby      { "8": minutes, … } posted standby wait at half past each hour
// Days already in the file are kept (up to 28), so running this again before a trip adds the newest
// week to what was learned before. Hard deadline 100 s; prints elapsed time.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const t0 = Date.now();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'app', 'data', 'llstats.json');
const PARKS = { DL: '7340550b-c14d-4def-80bb-acdb51d49a66', DCA: '832fcd51-ea19-4e77-85c7-75d5843b127c' };
const TZ = 'America/Los_Angeles';
const KEEP_DAYS = 28;
const HOURS = Array.from({ length: 16 }, (_, i) => i + 8); // 8 am .. 11 pm

function finish(code) {
  console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s, exit ${code}`);
  process.exit(code);
}
setTimeout(() => {
  console.error('hard deadline (100 s) reached');
  finish(1);
}, 100_000).unref();

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const offFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const offsetMin = (ms) => {
  const p = Object.fromEntries(offFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60e3);
};
const parkTime = (day, hh, mm = 0) => {
  const guess = Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  return guess - offsetMin(guess - offsetMin(guess) * 60e3) * 60e3;
};

async function getJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'disneyland-next-ride llstats (personal)' } });
    const body = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${body?.error?.message ?? ''}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** State of an entity at instant t: the last row at or before t, on top of the opening state. */
function stateAt(entity, t) {
  let s = entity.opening ?? null;
  for (const row of entity.history ?? []) {
    if (Date.parse(row.time) > t) break;
    s = row;
  }
  return s;
}

export function summarizeDay(envelope, day) {
  const out = {};
  for (const e of envelope.entities ?? []) {
    if (e.entityType !== 'ATTRACTION') continue;
    const rows = e.history ?? [];
    const lane = (s) => s?.queue?.RETURN_TIME ?? s?.queue?.PAID_RETURN_TIME ?? null;
    if (!lane(e.opening) && !rows.some((r) => lane(r))) continue; // no Lightning Lane on this ride
    const kind = rows.some((r) => r.queue?.RETURN_TIME) || e.opening?.queue?.RETURN_TIME ? 'multi' : 'single';
    // Sold out = the last switch to FINISHED with no AVAILABLE after it, at least 90 minutes before the
    // ride's last operating reading. A lane that only closes near park close, or that blinks FINISHED
    // while the ride is briefly down, did not sell out.
    let seenAvailable = false;
    let lastFinishedAt = null;
    let closedAt = null; // the ride's final closing: last switch from OPERATING to anything else
    let prevStatus = e.opening?.status ?? null;
    for (const r of rows) {
      const st = lane(r)?.state;
      if (st === 'AVAILABLE') {
        seenAvailable = true;
        lastFinishedAt = null;
      } else if (st === 'FINISHED' && seenAvailable && lastFinishedAt == null) lastFinishedAt = Date.parse(r.time);
      if (r.status === 'OPERATING') closedAt = null;
      else if (prevStatus === 'OPERATING') closedAt = Date.parse(r.time);
      prevStatus = r.status ?? prevStatus;
    }
    // Rows only appear on changes, so a ride still OPERATING at the last row ran until the day ended.
    const runUntil = closedAt ?? parkTime(day, 23, 59);
    const sellOut = lastFinishedAt != null && runUntil - lastFinishedAt >= 90 * 60e3
      ? hmFmt.format(new Date(lastFinishedAt))
      : null;
    if (!seenAvailable) continue; // lane never opened that day (ride closed)
    const ahead = {};
    const standby = {};
    for (const h of HOURS) {
      const at = parkTime(day, h, 15); // quarter past: when you would actually be booking
      const s = stateAt(e, at);
      const l = lane(s);
      if (l?.state === 'AVAILABLE' && l.returnStart) ahead[h] = Math.max(0, Math.round((Date.parse(l.returnStart) - at) / 60e3));
      const sb = stateAt(e, parkTime(day, h, 30));
      if (sb?.status === 'OPERATING' && Number.isFinite(sb?.queue?.STANDBY?.waitTime)) standby[h] = sb.queue.STANDBY.waitTime;
    }
    out[e.id] = { name: e.name, kind, sellOut, ahead, standby };
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const n = Math.min(7, Number(argv[argv.indexOf('--days') + 1]) || 7);
  let prev = { days: {} };
  try {
    prev = JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    /* first run */
  }
  const days = { ...(prev.days ?? {}) };
  const today = dayFmt.format(new Date());
  const wanted = [];
  for (let i = 1; i <= n; i++) wanted.push(dayFmt.format(new Date(Date.now() - i * 86400e3)));
  let calls = 0;
  for (const day of wanted) {
    if (day === today) continue;
    for (const [park, id] of Object.entries(PARKS)) {
      const key = `${day}|${park}`;
      if (days[key] && !argv.includes('--refetch')) continue;
      try {
        const env = await getJson(`https://api.themeparks.wiki/v1/entity/${id}/history?date=${day}`);
        calls++;
        days[key] = { day, park, weekday: new Date(`${day}T12:00:00Z`).getUTCDay(), rides: summarizeDay(env, day) };
        console.log(`${key}: ${Object.keys(days[key].rides).length} lanes`);
      } catch (err) {
        console.error(`${key}: ${err.message}`);
      }
    }
  }
  const keys = Object.keys(days).sort().slice(-KEEP_DAYS * 2);
  const kept = Object.fromEntries(keys.map((k) => [k, days[k]]));
  // Upcoming park hours and any published Multi Pass price, for planning future days.
  const hours = {};
  for (const [park, id] of Object.entries(PARKS)) {
    try {
      const sch = await getJson(`https://api.themeparks.wiki/v1/entity/${id}/schedule`);
      for (const d of sch.schedule ?? []) {
        if (d.date < today) continue;
        const h = (hours[`${d.date}|${park}`] ??= { date: d.date, park, open: null, close: null, llmp: null, events: [] });
        if (d.type === 'OPERATING') {
          h.open = d.openingTime;
          h.close = d.closingTime;
        } else if (d.type) h.events.push({ type: d.type, name: d.description ?? null, from: d.openingTime, to: d.closingTime });
        const mp = (d.purchases ?? []).find((x) => /multi pass/i.test(x.name ?? '') && x.price?.amount);
        if (mp) h.llmp = mp.price.amount / 100;
      }
    } catch (err) {
      console.error(`schedule ${park}: ${err.message}`);
    }
  }
  await writeFile(OUT, JSON.stringify({ builtAt: new Date().toISOString(), source: 'ThemeParks.wiki history and schedule', days: kept, hours }) + '\n');
  console.log(`wrote ${OUT}: ${keys.length} park-days (${calls} new calls)`);
  return 0;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('build-llstats.mjs')) {
  main().then(finish, (err) => {
    console.error(err);
    finish(1);
  });
}
