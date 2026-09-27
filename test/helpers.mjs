import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));

export const DL_ID = '7340550b-c14d-4def-80bb-acdb51d49a66';
export const DCA_ID = '832fcd51-ea19-4e77-85c7-75d5843b127c';

/** Build a catalog in the app/data/catalog.json shape from the children fixture (types unknown). */
export function catalogFromChildren(children) {
  const parks = {};
  for (const e of children.children) {
    if (e.entityType !== 'PARK') continue;
    const key = e.id === DL_ID ? 'DL' : 'DCA';
    parks[key] = { id: e.id, name: e.name, lat: e.location.latitude, lng: e.location.longitude };
  }
  const rides = children.children
    .filter((e) => e.entityType === 'ATTRACTION')
    .map((e) => ({
      id: e.id,
      name: e.name,
      park: e.parentId === DL_ID ? 'DL' : 'DCA',
      lat: e.location.latitude,
      lng: e.location.longitude,
      type: null,
      qtId: null,
    }));
  return { builtAt: '2026-09-26T00:00:00Z', parks, rides };
}

/** A synthetic ride in the normalized shape with sensible defaults. */
export function mkRide(over = {}) {
  return {
    id: over.id ?? over.name ?? 'r',
    name: 'Ride',
    park: 'DL',
    lat: 33.8121,
    lng: -117.919,
    type: 'RIDE',
    status: 'OPERATING',
    wait: 20,
    waitUpdated: null,
    forecast: null,
    open: null,
    close: null,
    ll: { multi: null, single: null, singleRider: null },
    source: 'tpw',
    ...over,
  };
}
