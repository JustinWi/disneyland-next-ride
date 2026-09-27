// C4: when a ride you care about is closed or down, suggest the closest match that's running:
// same park, similar physical experience (shared tags from app/data/rideinfo.json), similar
// intensity, not avoided, not already ridden, not too tall a height minimum.

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

// Tags that describe where a ride is or how slow it is say little about how it feels.
const WEAK = new Set(['indoor', 'outdoor', 'slow', 'loud', 'vehicle']);

/**
 * @param {string} id the ride that's unavailable
 * @param {object} o { info: rideinfo.rides, rides: live rides[], exclude: Set, maxResults }
 * Returns [{ ride, score }] best first; empty without ride facts.
 */
export function similarRides(id, { info, rides, exclude = new Set(), maxResults = 2 }) {
  const me = info?.[id];
  const self = rides.find((r) => r.id === id);
  if (!me || !self) return [];
  const myTags = new Set((me.tags ?? []).filter((t) => !WEAK.has(t)));
  const out = [];
  for (const r of rides) {
    if (r.id === id || r.park !== self.park || r.status !== 'OPERATING' || exclude.has(r.id)) continue;
    const other = info[r.id];
    if (!other) continue;
    const sim = jaccard(myTags, new Set((other.tags ?? []).filter((t) => !WEAK.has(t))));
    if (sim < 0.25) continue;
    const gap = Math.abs((other.intensity ?? 3) - (me.intensity ?? 3));
    if (gap > 1) continue;
    out.push({ ride: r, score: sim - 0.15 * gap });
  }
  return out.sort((a, b) => b.score - a.score || (a.ride.wait ?? 99) - (b.ride.wait ?? 99)).slice(0, maxResults);
}

/** Rides the person is too short for: { id: minimumInches } given their height in inches. */
export function tooShortFor(info, heightIn) {
  const out = {};
  if (!Number.isFinite(heightIn) || !info) return out;
  for (const [id, r] of Object.entries(info)) if (Number.isFinite(r.heightIn) && r.heightIn > heightIn) out[id] = r.heightIn;
  return out;
}
