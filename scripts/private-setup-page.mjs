// Build private/trip-setup.html for the family (gitignored): the private trip link, where the trip
// file disagrees with the live feed, and the per-day Multi Pass verdicts with booking plans.
//
//   node scripts/private-setup-page.mjs <trip-file.json> <park per trip day, e.g. DL,DCA,choose>
//
// Trip days come from the file's meta.tripDates, in order; nothing trip-specific lives in this script.
// Never commit the output: it carries the family's list and notes.

import fs from 'node:fs';
import { parseTripFile, attachIds, encodeTrip, computeLocks } from '../app/js/trip.js';
import { laneStats, planLaneDay } from '../app/js/lightning.js';
import { parkTime, parkHour, fmtTime, fmtDay, weekdayOf } from '../app/js/time.js';

const t0 = Date.now();
const ROOT = new URL('..', import.meta.url);
const read = (p) => JSON.parse(fs.readFileSync(new URL(p, ROOT), 'utf8'));
const file = process.argv[2];
const parksArg = (process.argv[3] ?? '').split(',').map((x) => x.trim().toUpperCase());
if (!file || !parksArg[0]) {
  console.error('usage: node scripts/private-setup-page.mjs <trip-file.json> <DL|DCA|choose,...>');
  process.exit(2);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const catalog = read('app/data/catalog.json');
const stats = read('app/data/llstats.json');
const live = await (await fetch('https://api.themeparks.wiki/v1/entity/disneylandresort/live')).json();
const liveById = new Map(live.liveData.filter((e) => e.entityType === 'ATTRACTION').map((e) => [e.id, e]));

const trip = attachIds(parseTripFile(JSON.parse(fs.readFileSync(file, 'utf8'))), catalog.rides);
trip.days = trip.days.map((d, i) => ({ date: d.date, park: ['DL', 'DCA'].includes(parksArg[i]) ? parksArg[i] : null }));
if (!trip.days.length) {
  console.error('the trip file has no meta.tripDates');
  process.exit(2);
}
const strip = ({ tpwId, ...rest }) => rest; // ids are re-matched on the phone; keep the link short
const code = await encodeTrip({ ...trip, rides: trip.rides.map(strip), avoid: trip.avoid.map(strip) });
const link = `https://justinwi.github.io/disneyland-next-ride/#trip=${code}`;
fs.writeFileSync(new URL('private/trip-link.txt', ROOT), link + '\n');

// Where the file and the live feed disagree.
const laneOf = (e) => (e?.queue?.RETURN_TIME ? 'multipass' : e?.queue?.PAID_RETURN_TIME ? 'singlepass' : 'none');
const laneWord = { multipass: 'Multi Pass', singlepass: 'Single Pass', none: 'no Lightning Lane' };
const diffs = [];
for (const r of trip.rides) {
  const e = liveById.get(r.tpwId);
  if (!e || e.status === 'REFURBISHMENT') continue; // a ride in refurbishment lists no lanes at all
  const actual = laneOf(e);
  if (r.ll && r.ll !== actual) diffs.push(`<li><b>${esc(r.name)}</b>: your file says ${laneWord[r.ll]}; Disneyland lists ${laneWord[actual]}.</li>`);
}
const statusRows = trip.rides
  .filter((r) => trip.verify.includes(r.key) || liveById.get(r.tpwId)?.status === 'REFURBISHMENT')
  .map((r) => `<li><b>${esc(r.name)}</b>: ${esc(liveById.get(r.tpwId)?.status ?? 'not in the live feed')} right now${trip.verify.includes(r.key) ? ' (on your verify-before-trip list)' : ''}. The app re-checks this live every minute.</li>`);

// Per-day Multi Pass verdicts.
const VERDICT = { buy: 'Worth it', maybe: 'Your call', skip: 'Skip it' };
const hmin = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);
function dayPlan(day, park) {
  const wd = weekdayOf(day);
  const s = laneStats(stats, park, wd);
  // Same rules as the app: ladders (a ride waits on the one before), weekday notes, half value while locked.
  const lk = computeLocks(trip, { ridden: new Set(), weekday: wd });
  const rides = trip.rides
    .filter((r) => r.park === park && r.tpwId && s.get(r.tpwId)?.kind === 'multi')
    .filter((r) => !['skip', 'hint'].includes(lk.info[r.tpwId]?.kind))
    .map((r) => ({ id: r.tpwId, name: r.name, priority: r.priority, typical: r.typical, conditional: Boolean(lk.info[r.tpwId]), after: lk.info[r.tpwId]?.after ?? [] }));
  const h = stats.hours?.[`${day}|${park}`];
  const p = planLaneDay({
    rides,
    stats: s,
    open: h?.open ? Date.parse(h.open) : parkTime(day, '08:00'),
    close: h?.close ? Date.parse(h.close) : parkTime(day, '22:00'),
    priceEach: h?.llmp ?? 37,
    party: trip.partySize ?? 4,
    hourOf: parkHour,
  });
  return { day, park, rides, ...p, hours: h };
}
const PARK = { DL: 'Disneyland', DCA: 'California Adventure' };
const plans = trip.days.flatMap((d) => (d.park ? [dayPlan(d.date, d.park)] : [dayPlan(d.date, 'DL'), dayPlan(d.date, 'DCA')]));
const planHtml = plans
  .map((p) => `<section class="card"><h3>${esc(fmtDay(p.day))} · ${PARK[p.park]} <span class="v v-${p.verdict}">${VERDICT[p.verdict]}</span></h3>
  <p>Saves about <b>${hmin(p.saved)}</b> of standby for <b>$${p.cost}</b>${p.saved ? `, about $${(p.cost / p.saved).toFixed(2)} a minute` : ''}. Multi Pass rides on your list here: ${p.rides.map((r) => esc(r.name) + (r.conditional ? ' (ladder)' : '')).join(', ') || 'none'}.</p>
  ${p.bookings.length ? `<ol>${p.bookings.map((b) => `<li>${fmtTime(b.bookAt)}: book <b>${esc(b.name)}</b>, return about ${fmtTime(b.returnAt)}, skips a ~${Math.round(b.standby)} min line${b.conditional ? ' (if the ladder gets there)' : ''}</li>`).join('')}</ol>` : ''}</section>`)
  .join('');

const days = new Set(Object.values(stats.days).map((d) => d.day));
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trip Setup</title>
<style>
:root { --bg:#fbfaf7; --ink:#1c1c1e; --muted:#66666b; --line:#e2dfd8; --card:#fff; --accent:#0b5cad; --soft:#f2efe8; }
@media (prefers-color-scheme: dark) { :root { --bg:#121316; --ink:#ececec; --muted:#a2a5ab; --line:#2d3036; --card:#1b1d21; --accent:#78adff; --soft:#23262b; } }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width:820px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:28px; margin:0 0 4px; } h2 { font-size:20px; margin:32px 0 8px; padding-bottom:4px; border-bottom:1px solid var(--line); } h3 { margin:0 0 6px; font-size:17px; }
.muted { color:var(--muted); font-size:14px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin:12px 0; }
.btn { display:inline-block; background:var(--accent); color:#fff; padding:12px 18px; border-radius:10px; text-decoration:none; font-weight:600; }
textarea { width:100%; box-sizing:border-box; font:12px ui-monospace,Consolas,monospace; background:var(--soft); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:8px; }
.v { display:inline-block; margin-left:8px; padding:2px 9px; border-radius:10px; font-size:13px; font-weight:700; }
.v-buy { background:#d8f0de; color:#1a6a31; } .v-maybe { background:#fdf0c8; color:#7a5600; } .v-skip { background:#ececec; color:#555; }
li { margin:4px 0; }
</style></head><body><main>
<h1>Your trip, set up</h1>
<p class="muted">Private to you: this page and the link below carry your ride list and notes. Built ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC.</p>

<h2>1. Put the trip on both phones</h2>
<p>Text or email this link to each phone that will use the app. Nothing is uploaded; the list lives in the link and then on the phone.</p>
<ol>
<li><b>iPhone, using it from the Home Screen</b> (recommended): open the app's address in Safari, tap Share, then <b>Add to Home Screen</b>. Open the new Home Screen icon, go to <b>More</b>, paste this link into <b>Or paste a trip link</b>, and tap <b>Load pasted link</b>. (A Home Screen app keeps its own storage, separate from Safari, so opening the link in Safari alone won't reach it.)</li>
<li><b>Android, or in the browser:</b> just open the link and tap <b>Load trip</b>.</li>
</ol>
<p><a class="btn" href="${esc(link)}">Open Next Ride with your trip</a></p>
<textarea rows="4" readonly onclick="this.select()">${esc(link)}</textarea>
<p class="muted">Trip days: ${trip.days.map((d) => `${esc(fmtDay(d.date))} ${d.park ? PARK[d.park] : '(choose that morning)'}`).join(', ')}. You can change these in the app's More tab.</p>

<h2>2. Where your file and Disneyland's live data differ</h2>
<p>The app goes by the live data.</p>
<ul>${diffs.join('') || '<li>No differences in Lightning Lane coverage.</li>'}</ul>
<ul>${statusRows.join('')}</ul>

<h2>3. Should you buy Multi Pass each day?</h2>
<p>The rule: <b>worth it</b> at $1 or less per minute of family standby saved (and at least an hour saved), <b>your call</b> up to $2, <b>skip it</b> above that.</p>
<p class="muted">From real Lightning Lane and wait-time data for the last ${days.size} days (${esc([...days].sort()[0])} to ${esc([...days].sort().slice(-1)[0])}), your list and priorities, $37 a person (Disney hasn't published October prices yet) and ${trip.partySize ?? 4} people. The app refreshes this every morning, and on the day it uses the live forecast. Later days count your whole list here; in the app they only count what you haven't ridden by then.</p>
${planHtml}

<h2>4. Pick more features</h2>
<p><a href="file:///E:/src/disneyland-next-ride/private/feature-menu.html">Open the feature menu</a>, tick what you want, press <b>Copy my picks</b>, and paste the result back to Claude.</p>
</main></body></html>
`;
fs.writeFileSync(new URL('private/trip-setup.html', ROOT), html);
console.log(`wrote private/trip-setup.html and private/trip-link.txt (${link.length} chars) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const p of plans) console.log(p.day, p.park, p.verdict, p.saved, 'min');
