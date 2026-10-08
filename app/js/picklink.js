// Pick links: one tap sets up a park day on a phone.
//   #pick=pony,ghostrider,xcelerator&warm=2&park=KBF&date=2026-10-08&height=52
// pick: rides by name (any unique start of the name, spaces and punctuation ignored), in order.
// warm: how many of the first picks are warm-ups, ridden in that order before the rest.
// park + date: that day's park. height: the shortest rider, in inches.
// Pure ES module, no DOM.

import { normalizeName } from './names.js';

const PARKS = new Set(['DL', 'DCA', 'KBF']);
const compact = (s) => normalizeName(s).replace(/ /g, '');

/** Returns null when the hash isn't a pick link. */
export function parsePickLink(hash, rides) {
  const m = /^#pick=(.*)$/.exec(hash ?? '');
  if (!m) return null;
  const q = new URLSearchParams('pick=' + m[1]);
  const park = PARKS.has(q.get('park')) ? q.get('park') : null;
  const pool = (rides ?? []).filter((r) => !park || r.park === park);
  const ids = [];
  const unknown = [];
  for (const raw of (q.get('pick') ?? '').split(',')) {
    const t = compact(raw);
    if (!t) continue;
    const exact = pool.filter((r) => compact(r.name) === t);
    const hits = exact.length ? exact : pool.filter((r) => compact(r.name).startsWith(t));
    if (hits.length === 1) {
      if (!ids.includes(hits[0].id)) ids.push(hits[0].id);
    } else unknown.push(raw);
  }
  const warmN = Math.max(0, Math.min(ids.length, parseInt(q.get('warm') ?? '0', 10) || 0));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') ?? '') ? q.get('date') : null;
  const h = Number(q.get('height'));
  return { ids, warm: ids.slice(0, warmN), park, date, heightIn: Number.isFinite(h) && h >= 30 && h <= 90 ? h : null, unknown };
}

/**
 * Warm-ups go first, in order: each one not yet ridden gets a head start (minutes off its score),
 * the first the most, so a short wait elsewhere doesn't jump the line ahead of them.
 */
export function warmupBias(warm, { wanted, ridden }) {
  const out = {};
  let i = 0;
  for (const id of warm ?? []) {
    if (!wanted.has(id) || ridden.has(id)) continue;
    out[id] = -(90 - 15 * i);
    i++;
  }
  return out;
}
