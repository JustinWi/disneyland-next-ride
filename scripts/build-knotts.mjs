// Add Knott's Berry Farm to app/data/catalog.json and app/data/rideinfo.json.
//
//   node scripts/build-knotts.mjs      one ThemeParks.wiki request (/children for the park), about 2 s
//
// Re-runnable: Knott's entries are replaced, Disney entries are left alone. Run it after
// build-catalog.mjs, which rewrites catalog.json for the Disney parks only.

import { readFile, writeFile } from 'node:fs/promises';
import { normalizeName } from '../app/js/names.js';
import { PARK_IDS } from '../app/js/normalize.js';
import { KNOTTS, FAST_LANE } from './knotts-data.mjs';

const t0 = Date.now();
const ROOT = new URL('../', import.meta.url);
const CATALOG = new URL('app/data/catalog.json', ROOT);
const RIDEINFO = new URL('app/data/rideinfo.json', ROOT);

const res = await fetch(`https://api.themeparks.wiki/v1/entity/${PARK_IDS.KBF}/children`, { signal: AbortSignal.timeout(20000) });
if (!res.ok) throw new Error(`children HTTP ${res.status}`);
const ch = await res.json();
const byName = new Map(ch.children.filter((e) => e.entityType === 'ATTRACTION').map((e) => [normalizeName(e.name), e]));

const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
const rideinfo = JSON.parse(await readFile(RIDEINFO, 'utf8'));
const kbfIds = new Set(catalog.rides.filter((r) => r.park === 'KBF').map((r) => r.id));
catalog.rides = catalog.rides.filter((r) => r.park !== 'KBF');
for (const id of kbfIds) delete rideinfo.rides[id];

catalog.parks.KBF = {
  id: PARK_IDS.KBF,
  name: "Knott's Berry Farm",
  lat: ch.location?.latitude ?? 33.8442,
  lng: ch.location?.longitude ?? -117.9989,
  fastLane: { ...FAST_LANE, rides: [] },
};

const missing = [];
for (const k of KNOTTS) {
  const e = byName.get(normalizeName(k.name));
  if (!e || !Number.isFinite(e.location?.latitude)) {
    missing.push(k.name);
    continue;
  }
  catalog.rides.push({ id: e.id, name: e.name, park: 'KBF', lat: e.location.latitude, lng: e.location.longitude, type: 'RIDE', qtId: null, land: k.land });
  rideinfo.rides[e.id] = {
    name: e.name,
    heightIn: k.heightIn,
    ...(k.heightNote ? { heightNote: k.heightNote } : {}),
    expect: k.expect,
    tags: k.tags,
    intensity: k.intensity,
    video: k.video,
    ...(k.fastLane ? { fastLane: true } : {}),
  };
  if (k.fastLane) catalog.parks.KBF.fastLane.rides.push(e.id);
}
if (!rideinfo.sources.includes('https://www.sixflags.com/knotts/attractions')) rideinfo.sources.push('https://www.sixflags.com/knotts/attractions', 'https://www.sixflags.com/knotts/fast-lane');

await writeFile(CATALOG, JSON.stringify(catalog, null, 1) + '\n');
await writeFile(RIDEINFO, JSON.stringify(rideinfo, null, 1) + '\n');
console.log(`Knott's: ${KNOTTS.length - missing.length} rides added${missing.length ? `, not in the feed: ${missing.join(', ')}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (missing.length) process.exitCode = 1;
