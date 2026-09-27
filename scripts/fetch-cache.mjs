// Fetch ThemeParks.wiki live + Queue-Times parks 16/17 for the GitHub Actions cache (branch `data`).
//
//   node scripts/fetch-cache.mjs [--out <dir>]      default .cache/out
//
// Writes live.json, qt16.json, qt17.json (only those that succeeded) and meta.json
// {fetchedAt, ok:{live,qt16,qt17}, errors:{...}}. Exit 0 if at least one source succeeded, else 1.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const t0 = Date.now();
const TIMEOUT_MS = 10_000;
const UA = 'disneyland-next-ride cache (personal, non-commercial)';

const SOURCES = {
  live: { url: 'https://api.themeparks.wiki/v1/entity/disneylandresort/live', valid: (j) => Array.isArray(j?.liveData) && j.liveData.length > 0 },
  qt16: { url: 'https://queue-times.com/parks/16/queue_times.json', valid: (j) => Array.isArray(j?.lands) && j.lands.length > 0 },
  qt17: { url: 'https://queue-times.com/parks/17/queue_times.json', valid: (j) => Array.isArray(j?.lands) && j.lands.length > 0 },
};

function finish(code) {
  console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s, exit ${code}`);
  process.exit(code);
}

// Hard deadline: every fetch has its own 10 s timeout, so anything past 30 s is a hang.
setTimeout(() => {
  console.error('hard deadline (30 s) reached');
  finish(1);
}, 30_000).unref();

async function fetchJson(name, { url, valid }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json', 'user-agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text(); // body read stays under the same timeout
    const json = JSON.parse(text);
    if (!valid(json)) throw new Error('unexpected payload shape');
    return text;
  } catch (err) {
    throw new Error(`${name}: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const outDir = resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : join('.cache', 'out'));
  await mkdir(outDir, { recursive: true });

  const names = Object.keys(SOURCES);
  const results = await Promise.allSettled(names.map((n) => fetchJson(n, SOURCES[n])));

  const ok = {};
  const errors = {};
  for (const [idx, name] of names.entries()) {
    const r = results[idx];
    ok[name] = r.status === 'fulfilled';
    if (ok[name]) {
      await writeFile(join(outDir, `${name}.json`), r.value);
      console.log(`${name}: ok (${(r.value.length / 1024).toFixed(0)} KB)`);
    } else {
      errors[name] = r.reason.message;
      console.error(`${name}: FAILED ${r.reason.message}`);
    }
  }
  const meta = { fetchedAt: new Date().toISOString(), ok, errors };
  await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');
  console.log(`wrote ${outDir}`);
  return Object.values(ok).some(Boolean) ? 0 : 1;
}

main().then(finish, (err) => {
  console.error(err);
  finish(1);
});
