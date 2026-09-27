// Build app/data/catalog.json from ThemeParks.wiki entities + Queue-Times name matching.
//
//   node scripts/build-catalog.mjs                  live API (about 25 s: one request per attraction at 4/s)
//   node scripts/build-catalog.mjs --from-fixtures  test/fixtures only, no network (type = null)
//   --out <path>                                    default app/data/catalog.json
//
// buildCatalog() is pure and exported for tests; the CLI below only fetches and writes.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchQueueTimes, flattenQueueTimes, normalizeName, formatReport } from './lib/match-names.mjs';

export const PARKS = {
  DL: { id: '7340550b-c14d-4def-80bb-acdb51d49a66', qt: 16 },
  DCA: { id: '832fcd51-ea19-4e77-85c7-75d5843b127c', qt: 17 },
};
const PARK_ORDER = ['DL', 'DCA'];
const TPW = 'https://api.themeparks.wiki/v1/entity';
const UA = 'disneyland-next-ride catalog builder (personal, non-commercial)';

// ThemeParks.wiki reports attractionType UNKNOWN for a few real rides. Names are normalized.
export const RIDE_OVERRIDES = new Set(['toy story midway mania', 'disneyland monorail', 'davy crocketts explorer canoes']);

/**
 * @param {object} args
 * @param {object|object[]} args.children  TPW /children payload ({children:[...]}) or its array
 * @param {object} args.qt16  Queue-Times park 16 payload (Disneyland)
 * @param {object} args.qt17  Queue-Times park 17 payload (DCA)
 * @param {Map<string,string>|Record<string,string>} [args.types]  attraction id -> attractionType
 * @param {string} [args.builtAt]
 * @returns {{ catalog: object, report: object, warnings: string[] }}
 */
export function buildCatalog({ children, qt16, qt17, types = {}, builtAt = new Date().toISOString() }) {
  const entities = Array.isArray(children) ? children : children?.children ?? [];
  const typeOf = (id) => (types instanceof Map ? types.get(id) : types[id]) ?? null;
  const warnings = [];

  const parkKeyById = new Map(PARK_ORDER.map((k) => [PARKS[k].id, k]));
  const parks = {};
  for (const k of PARK_ORDER) {
    const e = entities.find((x) => x.id === PARKS[k].id);
    if (!e) throw new Error(`park entity ${k} (${PARKS[k].id}) missing from children payload`);
    parks[k] = { id: e.id, name: e.name, lat: e.location?.latitude ?? null, lng: e.location?.longitude ?? null };
    if (!Number.isFinite(parks[k].lat) || !Number.isFinite(parks[k].lng)) warnings.push(`park ${k} has no location`);
  }

  const attractions = [];
  for (const e of entities) {
    if (e.entityType !== 'ATTRACTION') continue;
    const park = parkKeyById.get(e.parentId) ?? parkKeyById.get(e.parkId);
    if (!park) {
      warnings.push(`skipped ${e.name}: parent ${e.parentId} is not a known park`);
      continue;
    }
    const lat = e.location?.latitude;
    const lng = e.location?.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      // No coordinates means no walk time; the app accepts live entities missing from the catalog.
      warnings.push(`skipped ${e.name}: no location`);
      continue;
    }
    attractions.push({ id: e.id, name: e.name, park, lat, lng });
  }

  const qtRides = [...flattenQueueTimes(qt16, 'DL'), ...flattenQueueTimes(qt17, 'DCA')];
  const { map, report } = matchQueueTimes(attractions, qtRides);

  // Annotate QT leftovers that TPW does know about, but as a SHOW (so they are outside the catalog).
  const shows = new Set(
    entities.filter((e) => e.entityType === 'SHOW').map((e) => `${parkKeyById.get(e.parentId)}: ${normalizeName(e.name)}`),
  );
  report.unmatchedQtShows = report.unmatchedQt.filter((s) => {
    const [park, ...rest] = s.split(': ');
    return shows.has(`${park}: ${normalizeName(rest.join(': '))}`);
  });

  const landByQt = new Map(qtRides.map((q) => [q.id, q.land]));
  const typeFor = (a) => {
    const t = typeOf(a.id);
    return t !== 'RIDE' && RIDE_OVERRIDES.has(normalizeName(a.name)) ? 'RIDE' : t;
  };
  const rides = attractions
    .map((a) => {
      const qtId = map.get(a.id) ?? null;
      return { id: a.id, name: a.name, park: a.park, lat: a.lat, lng: a.lng, type: typeFor(a), qtId, land: (qtId != null && landByQt.get(qtId)) || null };
    })
    .sort(
      (a, b) =>
        PARK_ORDER.indexOf(a.park) - PARK_ORDER.indexOf(b.park) ||
        normalizeName(a.name).localeCompare(normalizeName(b.name)) ||
        a.name.localeCompare(b.name),
    );

  return { catalog: { builtAt, parks, rides }, report, warnings };
}

// ---------------------------------------------------------------- network

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET JSON with a per-attempt timeout and up to `retries` retries (backoff 1 s, 2 s, 4 s; honours Retry-After). */
async function getJson(url, { retries = 3, timeoutMs = 15000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let wait = 1000 * 2 ** attempt;
    let err;
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json', 'user-agent': UA } });
      if (res.ok) return await res.json();
      err = new Error(`HTTP ${res.status} for ${url}`);
      err.fatal = res.status < 500 && res.status !== 429; // other 4xx will not get better
      const retryAfter = Number(res.headers.get('retry-after'));
      if (retryAfter > 0) wait = retryAfter * 1000;
    } catch (e) {
      err = e;
    } finally {
      clearTimeout(timer);
    }
    if (err.fatal || attempt >= retries) throw err;
    await sleep(wait);
  }
}

/** Fetch attractionType for each id, starting at most `perSecond` requests per second. */
async function fetchTypes(ids, perSecond = 4) {
  const types = new Map();
  const gap = 1000 / perSecond;
  const inflight = [];
  let done = 0;
  for (const id of ids) {
    const started = Date.now();
    inflight.push(
      getJson(`${TPW}/${id}`)
        .then((e) => types.set(id, e.attractionType ?? null))
        .catch((err) => {
          console.warn(`  type lookup failed for ${id}: ${err.message}`);
          types.set(id, null);
        })
        .finally(() => {
          if (++done % 20 === 0) console.log(`  types ${done}/${ids.length}`);
        }),
    );
    await sleep(Math.max(0, gap - (Date.now() - started)));
  }
  await Promise.all(inflight);
  return types;
}

async function latestFixture(dir, prefix) {
  const names = (await readdir(dir)).filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort();
  if (!names.length) throw new Error(`no fixture ${prefix}*.json in ${dir}`);
  return JSON.parse(await readFile(join(dir, names.at(-1)), 'utf8'));
}

// ---------------------------------------------------------------- CLI

async function main(argv) {
  const t0 = Date.now();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const fromFixtures = argv.includes('--from-fixtures');
  const outIdx = argv.indexOf('--out');
  const outPath = resolve(outIdx >= 0 ? argv[outIdx + 1] : join(root, 'app', 'data', 'catalog.json'));

  let children, qt16, qt17, types;
  if (fromFixtures) {
    const fx = join(root, 'test', 'fixtures');
    [children, qt16, qt17] = await Promise.all([
      latestFixture(fx, 'tpw-children-'),
      latestFixture(fx, 'qt-16-'),
      latestFixture(fx, 'qt-17-'),
    ]);
    types = new Map();
  } else {
    console.log('fetching children + Queue-Times ...');
    [children, qt16, qt17] = await Promise.all([
      getJson(`${TPW}/disneylandresort/children`),
      getJson('https://queue-times.com/parks/16/queue_times.json'),
      getJson('https://queue-times.com/parks/17/queue_times.json'),
    ]);
    const ids = children.children.filter((e) => e.entityType === 'ATTRACTION').map((e) => e.id);
    console.log(`fetching attractionType for ${ids.length} attractions at 4/s ...`);
    types = await fetchTypes(ids);
  }

  const { catalog, report, warnings } = buildCatalog({ children, qt16, qt17, types });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(catalog, null, 1) + '\n');

  const count = (pred) => catalog.rides.filter(pred).length;
  const typeCounts = {};
  for (const r of catalog.rides) {
    const k = `${r.park}/${r.type ?? 'null'}`;
    typeCounts[k] = (typeCounts[k] ?? 0) + 1;
  }
  console.log(`\nwrote ${outPath}`);
  console.log(`rides: ${catalog.rides.length} (DL ${count((r) => r.park === 'DL')}, DCA ${count((r) => r.park === 'DCA')}); with qtId ${count((r) => r.qtId != null)}`);
  console.log('by park/type:', typeCounts);
  for (const w of warnings) console.warn(`warning: ${w}`);
  console.log('\n' + formatReport(report));
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase();
if (isMain) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
