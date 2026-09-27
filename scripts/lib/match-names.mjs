// Match ThemeParks.wiki attraction names to Queue-Times ride names.
//
// Passes, in order, each one only over what is still unmatched and always within one park:
//   1. exact on normalizeName()
//   2. explicit alias table (renames, seasonal overlays, punctuation variants)
//   3. conservative fuzzy: Jaccard >= 0.8 on tokens of length >= 3, best pair first
// A QT id is never assigned to two TPW ids, and vice versa.
// QT "<ride> Single Rider" entries are a separate queue for an existing ride; they are reported
// in `singleRider` (tpwId -> qtId) and are not counted as unmatched.

import { normalizeName, ALIAS_GROUPS, canonical, tokens, jaccard } from '../../app/js/names.js';

export { normalizeName, ALIAS_GROUPS };

const SINGLE_RIDER = / single rider$/;

/** Flatten a Queue-Times park payload into [{id, name, park, isOpen, wait, lastUpdated, land}]. */
export function flattenQueueTimes(payload, park) {
  const out = [];
  const push = (r, land) =>
    out.push({ id: r.id, name: r.name, park, isOpen: r.is_open, wait: r.wait_time, lastUpdated: r.last_updated, land });
  for (const land of payload?.lands ?? []) for (const r of land.rides ?? []) push(r, land.name);
  for (const r of payload?.rides ?? []) push(r, null);
  return out;
}

/**
 * @param {{id:string,name:string,park:string}[]} tpwAttractions
 * @param {{id:number,name:string,park:string}[]} qtRides
 * @returns {{ map: Map<string, number>, singleRider: Map<string, number>, report: object }}
 */
export function matchQueueTimes(tpwAttractions, qtRides) {
  const map = new Map(); // tpwId -> qtId
  const singleRider = new Map(); // tpwId -> qtId of the single-rider queue
  const how = new Map(); // tpwId -> 'exact' | 'alias' | 'fuzzy'
  const usedQt = new Set();

  const tpw = tpwAttractions.map((a) => ({ ...a, norm: normalizeName(a.name) }));
  const qtAll = qtRides.map((r) => ({ ...r, norm: normalizeName(r.name) }));
  const qtSr = qtAll.filter((r) => SINGLE_RIDER.test(r.norm));
  const qt = qtAll.filter((r) => !SINGLE_RIDER.test(r.norm));

  const assign = (t, q, kind) => {
    map.set(t.id, q.id);
    usedQt.add(q.id);
    how.set(t.id, kind);
  };

  // Pass 1 and 2: keyed lookups. A key that maps to more than one candidate is ambiguous and skipped.
  for (const [kind, keyOf] of [
    ['exact', (x) => x.norm],
    ['alias', (x) => canonical(x.norm)],
  ]) {
    const index = new Map();
    for (const q of qt) {
      if (usedQt.has(q.id)) continue;
      const k = `${q.park}|${keyOf(q)}`;
      index.set(k, index.has(k) ? null : q); // null marks a collision
    }
    const claims = new Map();
    for (const t of tpw) {
      if (map.has(t.id)) continue;
      const k = `${t.park}|${keyOf(t)}`;
      const q = index.get(k);
      if (!q) continue;
      claims.set(q.id, claims.has(q.id) ? null : [t, q]);
    }
    for (const c of claims.values()) if (c) assign(c[0], c[1], kind);
  }

  // Pass 3: fuzzy, best pairs first, one-to-one.
  const pairs = [];
  for (const t of tpw) {
    if (map.has(t.id)) continue;
    const tt = tokens(canonical(t.norm));
    for (const q of qt) {
      if (usedQt.has(q.id) || q.park !== t.park) continue;
      const s = jaccard(tt, tokens(canonical(q.norm)));
      if (s >= 0.8) pairs.push([s, t, q]);
    }
  }
  pairs.sort((a, b) => b[0] - a[0]);
  for (const [, t, q] of pairs) if (!map.has(t.id) && !usedQt.has(q.id)) assign(t, q, 'fuzzy');

  // Single-rider queues: attach to the base ride in the same park.
  const srUnmatched = [];
  for (const q of qtSr) {
    const base = canonical(q.norm.replace(SINGLE_RIDER, ''));
    const hits = tpw.filter((t) => t.park === q.park && canonical(t.norm) === base && !singleRider.has(t.id));
    if (hits.length === 1) singleRider.set(hits[0].id, q.id);
    else srUnmatched.push(q);
  }

  const qtById = new Map(qtAll.map((q) => [q.id, q]));
  const tpwById = new Map(tpw.map((t) => [t.id, t]));
  const byKind = (k) =>
    [...how].filter(([, v]) => v === k).map(([id]) => `${tpwById.get(id).name} = ${qtById.get(map.get(id)).name}`);

  const report = {
    matched: map.size,
    qtTotal: qt.length,
    exact: [...how.values()].filter((v) => v === 'exact').length,
    viaAlias: byKind('alias'),
    viaFuzzy: byKind('fuzzy'),
    singleRider: [...singleRider].map(([id, qid]) => `${tpwById.get(id).name} -> ${qtById.get(qid).name}`),
    unmatchedTpw: tpw.filter((t) => !map.has(t.id)).map((t) => `${t.park}: ${t.name}`),
    unmatchedQt: [...qt.filter((q) => !usedQt.has(q.id)), ...srUnmatched].map((q) => `${q.park}: ${q.name}`),
  };
  return { map, singleRider, report };
}

export function formatReport(report) {
  const lines = [
    `matched ${report.matched} of ${report.qtTotal} QT rides (${report.exact} exact, ${report.viaAlias.length} alias, ${report.viaFuzzy.length} fuzzy); ${report.singleRider.length} single-rider queues attached`,
  ];
  const list = (title, arr) => {
    lines.push(`${title} (${arr.length})${arr.length ? ':' : ''}`);
    for (const x of arr) lines.push(`  - ${x}`);
  };
  if (report.viaAlias.length) list('matched via alias', report.viaAlias);
  if (report.viaFuzzy.length) list('matched via fuzzy', report.viaFuzzy);
  list('unmatched QT', report.unmatchedQt);
  list('unmatched TPW', report.unmatchedTpw);
  if (report.unmatchedQtShows?.length) list('unmatched QT that TPW lists as SHOW (outside catalog)', report.unmatchedQtShows);
  return lines.join('\n');
}
