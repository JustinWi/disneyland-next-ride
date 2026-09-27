// Geometry helpers: distances, walking time, which park we're in.
// All positions are { lat, lng } in degrees.

export const EARTH_R = 6371000; // metres
export const PATH_FACTOR = 1.3; // straight line -> real path through a crowded park
export const SPEEDS = { slow: 55, normal: 72, fast: 85 }; // metres per minute
export const RESORT_RADIUS_M = 2500;

const toRad = (d) => (d * Math.PI) / 180;

export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Minutes to walk from `from` to `to` at the given speed key (slow | normal | fast). */
export function walkMinutes(from, to, { speed = 'normal' } = {}) {
  const mpm = SPEEDS[speed] ?? SPEEDS.normal;
  return (haversineMeters(from, to) * PATH_FACTOR) / mpm;
}

/** 'DL' | 'DCA' by distance to each park's centre, or null without a position. */
export function nearestPark(pos, centers) {
  if (!pos || !centers) return null;
  let best = null;
  let bestD = Infinity;
  for (const [key, c] of Object.entries(centers)) {
    if (!c) continue;
    const d = haversineMeters(pos, c);
    if (d < bestD) {
      bestD = d;
      best = key;
    }
  }
  return best;
}

/** True when the position is within the resort (default 2.5 km of the reference gate). */
export function atResort(pos, gate, maxMeters = RESORT_RADIUS_M) {
  if (!pos || !gate) return false;
  return haversineMeters(pos, gate) <= maxMeters;
}

// ---- Park footprints: which park (if any) a position is inside ----
// A park is the convex hull of its attractions plus a margin. Outside every footprint means outside
// the gates (esplanade, Downtown Disney, hotels, parking): no park, so no hop penalty to either.

const M_PER_DEG_LAT = 111320;
const project = (p, lat0) => ({ x: p.lng * M_PER_DEG_LAT * Math.cos(toRad(lat0)), y: p.lat * M_PER_DEG_LAT });

function hull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of pts.slice().reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1)); // counter-clockwise
}

function segDist(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** { DL: {lat0, poly}, DCA: {...} } from catalog rides. */
export function parkFootprints(catalog) {
  const byPark = {};
  for (const r of catalog?.rides ?? []) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng) || !r.park) continue;
    (byPark[r.park] ??= []).push(r);
  }
  const out = {};
  for (const [park, rides] of Object.entries(byPark)) {
    const lat0 = rides.reduce((s, r) => s + r.lat, 0) / rides.length;
    out[park] = { lat0, poly: hull(rides.map((r) => project(r, lat0))) };
  }
  return out;
}

/** 'DL' | 'DCA' when inside that park's footprint (hull + margin), else null. */
export function parkAt(pos, footprints, marginM = 60) {
  if (!pos || !footprints) return null;
  let best = null;
  let bestD = Infinity;
  for (const [park, { lat0, poly }] of Object.entries(footprints)) {
    if (!poly.length) continue;
    const p = project(pos, lat0);
    let inside = poly.length >= 3;
    for (let i = 0; i < poly.length && inside; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < 0) inside = false;
    }
    let d = 0;
    if (!inside) {
      d = Infinity;
      for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(p, poly[i], poly[(i + 1) % poly.length]));
    }
    if (d <= marginM && d < bestD) {
      best = park;
      bestD = d;
    }
  }
  return best;
}
