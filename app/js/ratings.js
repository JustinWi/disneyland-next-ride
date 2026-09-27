// Ride ratings (1 to 5 stars) and "ride again". Pure functions; the app keeps
//   ratings: { rideId: { stars, at } }         for the whole trip
//   again:   { 'YYYY-MM-DD': [rideId, …] }      rides put back on that day's list
//   counts:  { rideId: timesRidden }

export const clampStars = (n) => Math.max(1, Math.min(5, Math.round(Number(n) || 0)));

/** Rides that count as done for planning: everything ridden, minus rides put back on today's list. */
export function effectiveDone(ridden, againToday) {
  const out = new Set(ridden);
  for (const id of againToday ?? []) out.delete(id);
  return out;
}

/**
 * Favorites to ride again: rated 4 or 5 stars, already ridden, not already put back, in today's park
 * (or either park when park is null). Best rated first, then shortest current wait.
 */
export function favorites({ ratings, ridden, ridesById, park = null, again = [] }) {
  const back = new Set(again);
  return [...ridden]
    .filter((id) => (ratings?.[id]?.stars ?? 0) >= 4 && !back.has(id))
    .map((id) => ({ id, ride: ridesById.get(id), stars: ratings[id].stars }))
    .filter((x) => x.ride && (!park || x.ride.park === park))
    .sort((a, b) => b.stars - a.stars || (a.ride.wait ?? 999) - (b.ride.wait ?? 999));
}

/** Head start in the ranking for a ride you're riding again: 5 stars −10 min, 4 stars −5. */
export const againBias = (stars) => (stars >= 5 ? -10 : stars >= 4 ? -5 : 0);

/** "★★★★☆" for display. */
export const starText = (stars) => '★'.repeat(stars) + '☆'.repeat(5 - stars);
