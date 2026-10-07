# Next Ride

Phone web app for Disneyland Resort: pick the rides you want today, and it tells you which one to
ride next from live waits, the wait forecast, your location and closing times.

**App:** https://justinwi.github.io/disneyland-next-ride/

- `app/` is the whole site (static, no build step). `app/js/` is the engine: pure ES modules.
- `docs/design.html` is the design. `docs/report.html` is the build report.
- `npm test` runs the Node test suite (fixtures are real payloads captured 2026-09-26).
- `npm run serve` serves `app/` on http://127.0.0.1:8787 for local testing. Add `?at=LAT,LNG` to
  any app URL to fake your location, for example `?at=33.8115,-117.9171` (Space Mountain).
- `npm run catalog` rebuilds `app/data/catalog.json` (ride coordinates, types, lands).
- `.github/workflows/pages.yml` deploys `app/` on every push to `main`.
- `.github/workflows/cache.yml` refreshes the backup wait-time cache on branch `data` every ~5 min.

Data: [ThemeParks.wiki](https://themeparks.wiki). Land names and backup waits:
[Powered by Queue-Times.com](https://queue-times.com/).

## Using it or making your own

- **Just use it:** open the app link on your phone and pick your rides on the Rides tab. Your list,
  ratings and location stay on your phone; nothing is uploaded. Add it to your Home Screen for one-tap use.
- **Fork it:** in your fork, turn on Actions, set Settings → Pages → Source to "GitHub Actions", and
  push to `main`. Point `CACHE_BASE` in `app/js/sources.js` at your own repo's `data` branch.
- Unofficial: not affiliated with Disney. MIT licensed (see `LICENSE`).
