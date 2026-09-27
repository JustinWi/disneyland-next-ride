// Service worker: keeps the app shell available with no signal.
// Same-origin files only, stale-while-revalidate: open instantly from cache, refresh in the
// background so the next open gets any update. Wait-time APIs are never cached here; the app
// keeps the last snapshot itself so it always knows its age.

const VERSION = 'nr-v1';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'js/plan.js',
  'js/score.js',
  'js/geo.js',
  'js/forecast.js',
  'js/time.js',
  'js/normalize.js',
  'js/sources.js',
  'js/store.js',
  'js/names.js',
  'js/trip.js',
  'js/lightning.js',
  'js/ratings.js',
  'js/route.js',
  'js/alerts.js',
  'js/shows.js',
  'js/similar.js',
  'data/catalog.json',
  'data/llstats.json',
  'data/rideinfo.json',
  'manifest.webmanifest',
  'icon.svg',
  'icon-180.png',
  'icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // cache: 'reload' skips the HTTP cache (Pages serves max-age=600), so a new version never
    // precaches the previous deploy's files.
    caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // APIs go straight to the network
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const key = req.mode === 'navigate' ? 'index.html' : req;
      const cached = await cache.match(key, { ignoreSearch: true });
      // Revalidate with the server, not the HTTP cache. A navigate-mode Request can't take init
      // options, so navigations are fetched by URL.
      const network = fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return (await network) ?? new Response('Offline', { status: 503, statusText: 'Offline' });
    }),
  );
});
