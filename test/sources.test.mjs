import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { fetchFresh, TPW_LIVE, CACHE_BASE } from '../app/js/sources.js';

const live = fixture('tpw-live-2026-09-26.json');
const qt16 = fixture('qt-16-2026-09-26.json');
const qt17 = fixture('qt-17-2026-09-26.json');
const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const fail = () => Promise.reject(new TypeError('Failed to fetch'));

async function withFetch(routes, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = (url) => (routes[url] ? routes[url]() : fail());
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('fetchFresh: live ThemeParks.wiki first', async () => {
  const r = await withFetch({ [TPW_LIVE]: () => ok(live) }, fetchFresh);
  assert.equal(r.via, 'live');
  assert.ok(r.tpw.data.liveData.length > 50);
  assert.ok(Math.abs(r.tpw.at - Date.now()) < 5000);
});

test('fetchFresh: backup cache when live fails, stamped with the cache time, not now', async () => {
  const fetchedAt = '2026-09-27T02:40:00.000Z';
  const r = await withFetch(
    {
      [CACHE_BASE + 'meta.json']: () => ok({ fetchedAt, ok: { live: true, qt16: true, qt17: true } }),
      [CACHE_BASE + 'live.json']: () => ok(live),
    },
    fetchFresh,
  );
  assert.equal(r.via, 'cache');
  assert.equal(r.tpw.at, Date.parse(fetchedAt));
});

test('fetchFresh: Queue-Times from the cache when its ThemeParks.wiki copy is missing', async () => {
  const fetchedAt = '2026-09-27T02:40:00.000Z';
  const r = await withFetch(
    {
      [CACHE_BASE + 'meta.json']: () => ok({ fetchedAt, ok: { live: false, qt16: true, qt17: true } }),
      [CACHE_BASE + 'qt16.json']: () => ok(qt16),
      [CACHE_BASE + 'qt17.json']: () => ok(qt17),
    },
    fetchFresh,
  );
  assert.equal(r.via, 'cache');
  assert.equal(r.tpw, undefined);
  assert.equal(r.qt.data.length, 2);
  assert.equal(r.qt.at, Date.parse(fetchedAt));
});

test('fetchFresh: everything down -> via null, nothing thrown', async () => {
  const r = await withFetch({}, fetchFresh);
  assert.equal(r.via, null);
  assert.ok(r.error);
});
