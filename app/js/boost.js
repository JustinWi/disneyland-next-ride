// Thrills first, the drop test and "We're hot": adjustments layered on top of the trip file's
// priorities. Pure functions, no DOM. The trip file stays as loaded; these read it.
//
//   feel   thrill | active | calm      how exciting a ride is (thrill = real coaster/drop/speed)
//   cool   indoor | water | shade | sun  how it treats you on a hot afternoon (queue + ride)
//
// Thrills first (default on): thrill rides count as Must-do with an extra head start, active rides
// at least High, calm rides two steps lower (Must-do -> Medium, High -> Low). Nothing is removed.

import { normalizeName } from './names.js';
import { PRIORITY_BIAS } from './trip.js';

// Matched against normalizeName(ride name) with startsWith, so "haunted mansion" covers the
// Holiday overlay and "guardians of" covers both Guardians entities.
const TABLE = [
  // ---- Disneyland ----
  ['big thunder', 'thrill', 'shade'],
  ['matterhorn', 'thrill', 'shade'],
  ['indiana jones', 'thrill', 'indoor'],
  ['space mountain', 'thrill', 'indoor'],
  ['star wars rise of the resistance', 'thrill', 'indoor'],
  ['rise of the resistance', 'thrill', 'indoor'],
  ['tianas bayou', 'thrill', 'water'],
  ['star tours', 'thrill', 'indoor'],
  ['millennium falcon', 'thrill', 'indoor'],
  ['roger rabbit', 'active', 'indoor'],
  ['mad tea party', 'active', 'shade'],
  ['alice in wonderland', 'active', 'sun'],
  ['astro orbitor', 'active', 'sun'],
  ['autopia', 'active', 'sun'],
  ['chip n dales gadgetcoaster', 'active', 'sun'],
  ['gadgets go coaster', 'active', 'sun'],
  ['buzz lightyear', 'active', 'indoor'],
  ['mickey and minnies runaway railway', 'active', 'indoor'],
  ['davy crocketts explorer canoes', 'active', 'sun'],
  ['pirates of the caribbean', 'calm', 'indoor'],
  ['haunted mansion', 'calm', 'shade'],
  ['peter pans flight', 'calm', 'sun'],
  ['mr toads wild ride', 'calm', 'shade'],
  ['snow whites enchanted wish', 'calm', 'shade'],
  ['pinocchios daring journey', 'calm', 'shade'],
  ['its a small world', 'calm', 'indoor'],
  ['many adventures of winnie the pooh', 'calm', 'indoor'],
  ['dumbo', 'calm', 'sun'],
  ['king arthur carrousel', 'calm', 'shade'],
  ['casey jr', 'calm', 'sun'],
  ['storybook land', 'calm', 'shade'],
  ['finding nemo', 'calm', 'sun'],
  ['jungle cruise', 'calm', 'shade'],
  ['disneyland railroad', 'calm', 'shade'],
  ['mark twain', 'calm', 'shade'],
  ['sailing ship columbia', 'calm', 'shade'],
  ['disneyland monorail', 'calm', 'shade'],
  ['main street vehicles', 'calm', 'sun'],
  ['pirates lair', 'calm', 'shade'],
  ['tom sawyer island', 'calm', 'shade'],
  ['main street cinema', 'calm', 'indoor'],
  ['walt disneys enchanted tiki room', 'calm', 'indoor'],
  ['great moments with mr lincoln', 'calm', 'indoor'],
  ['opera house', 'calm', 'indoor'],
  ['disney gallery', 'calm', 'indoor'],
  ['pixar short film spotlight', 'calm', 'indoor'],
  // ---- Disney California Adventure ----
  ['radiator springs racers', 'thrill', 'sun'],
  ['grizzly river run', 'thrill', 'water'],
  ['goofys sky school', 'thrill', 'shade'],
  ['incredicoaster', 'thrill', 'sun'],
  ['guardians of', 'thrill', 'indoor'],
  ['pixar pal a round swinging', 'thrill', 'sun'],
  ['web slingers', 'active', 'indoor'],
  ['toy story midway mania', 'active', 'indoor'],
  ['soarin', 'active', 'indoor'],
  ['maters', 'active', 'shade'],
  ['luigis', 'active', 'shade'],
  ['silly symphony swings', 'active', 'sun'],
  ['inside out emotional whirlwind', 'active', 'shade'],
  ['jumpin jellyfish', 'active', 'sun'],
  ['redwood creek challenge trail', 'active', 'shade'],
  ['golden zephyr', 'calm', 'sun'],
  ['little mermaid', 'calm', 'indoor'],
  ['monsters inc', 'calm', 'indoor'],
  ['jessies critter carousel', 'calm', 'shade'],
  ['pixar pal a round non swinging', 'calm', 'sun'],
  ['animation academy', 'calm', 'indoor'],
  ['sorcerers workshop', 'calm', 'indoor'],
  ['turtle talk', 'calm', 'indoor'],
  ['mickeys philharmagic', 'calm', 'indoor'],
  // ---- Knott's Berry Farm ----
  ['ghostrider', 'thrill', 'sun'],
  ['silver bullet', 'thrill', 'sun'],
  ['xcelerator', 'thrill', 'sun'],
  ['hangtime', 'thrill', 'sun'],
  ['supreme scream', 'thrill', 'sun'],
  ['sol spin', 'thrill', 'sun'],
  ['montezooma', 'thrill', 'sun'],
  ['jaguar', 'thrill', 'shade'],
  ['pony express', 'thrill', 'sun'],
  ['sierra sidewinder', 'thrill', 'sun'],
  ['coast rider', 'thrill', 'sun'],
  ['la revolucion', 'thrill', 'sun'],
  ['wipeout', 'active', 'sun'],
  ['timber mountain log ride', 'active', 'water'],
  ['calico river rapids', 'active', 'water'],
  ['dragon swing', 'active', 'sun'],
  ['pacific scrambler', 'active', 'sun'],
  ['wheeler dealer bumper cars', 'active', 'shade'],
  ['hat dance', 'active', 'sun'],
  ['surfside gliders', 'active', 'sun'],
  ['los voladores', 'active', 'sun'],
  ['knotts bear y tales', 'calm', 'indoor'],
  ['calico mine ride', 'calm', 'indoor'],
  ['sky cabin', 'calm', 'shade'],
  ['calico railroad', 'calm', 'sun'],
  ['butterfield stagecoach', 'calm', 'sun'],
  ['carrusel de california', 'calm', 'shade'],
  ['snoopys tenderpaw twister', 'calm', 'sun'],
  ['linus launcher', 'calm', 'sun'],
  ['charlie browns kite flyer', 'calm', 'sun'],
  ['balloon race', 'calm', 'sun'],
  ['flying ace', 'calm', 'sun'],
  ['camp snoopys off road rally', 'calm', 'sun'],
  ['pig pens mud buggies', 'calm', 'sun'],
  ['rapid river run', 'calm', 'sun'],
  ['beagle express railroad', 'calm', 'sun'],
  ['sallys swing along', 'calm', 'sun'],
];
// Longest prefix first, so "pixar pal a round non swinging" beats "pixar pal a round swinging"... and
// both beat any shorter key.
const SORTED = [...TABLE].sort((a, b) => b[0].length - a[0].length);

function row(name) {
  const n = normalizeName(name);
  return SORTED.find(([k]) => n.startsWith(k)) ?? null;
}
/** 'thrill' | 'active' | 'calm' | null (not in the table). */
export const feelOf = (name) => row(name)?.[1] ?? null;
/** 'indoor' | 'water' | 'shade' | 'sun' | null (not in the table). */
export const coolOf = (name) => row(name)?.[2] ?? null;

const LEVELS = ['low', 'medium', 'high', 'must'];
/** Minutes of extra head start for a thrill ride on top of Must-do, so thrills beat the other must-dos. */
export const THRILL_EXTRA = -10;

/** Minutes of extra handicap for a calm ride: a 5-minute line for a 14-minute boat ride still costs 20 minutes of thrill time. */
export const CALM_EXTRA = 10;

/** { priority, bias } for one ride: the trip file's priority, or with Thrills first the adjusted one. */
export function rideWeight(priority, feel, thrills) {
  if (!thrills) return { priority, bias: PRIORITY_BIAS[priority] ?? 0 };
  const p = thrillPriority(priority, feel);
  // A thrill ride still waiting on its gates ("Maybe") counts as Must-do once it opens.
  const base = PRIORITY_BIAS[p === 'conditional' && feel === 'thrill' ? 'must' : p] ?? 0;
  return { priority: p, bias: base + (feel === 'thrill' ? THRILL_EXTRA : feel === 'calm' ? CALM_EXTRA : 0) };
}

/** The priority a ride counts as with Thrills first on. 'conditional' stays (its gates still apply). */
export function thrillPriority(priority, feel) {
  if (priority === 'conditional' || !feel) return priority;
  const i = LEVELS.indexOf(priority);
  if (i < 0) return priority;
  if (feel === 'thrill') return 'must';
  if (feel === 'active') return LEVELS[Math.max(i, Math.min(i + 1, 2))]; // one step up, not past High
  return LEVELS[Math.max(0, i - 2)]; // calm: two steps down, still on the list
}

// ---- We're hot ----

export const HEAT_MINUTES = 60; // the switch turns itself off after this, so it can't linger all evening
/** Head start (minutes, lower = sooner) per cool tag while "We're hot" is on. */
export const HEAT_BIAS = { indoor: -15, water: -12, shade: 0, sun: 12 };
export const COOL_LABEL = {
  indoor: 'indoors, air-conditioned',
  water: 'you will get wet',
  shade: 'mostly shaded queue',
  sun: 'queue in the sun',
};
export const heatOn = (heat, now) => Boolean(heat?.until && heat.until > now);

/**
 * Cool places near you that aren't rides on your list: air-conditioned shows and walk-ins, plus
 * water rides. catalogRides: [{id, name, park, lat, lng}]. Returns up to `max`, nearest first.
 */
export function coolSpots(catalogRides, { park, pos, walk, skip = new Set(), max = 3 }) {
  return catalogRides
    .filter((r) => (!park || r.park === park) && !skip.has(r.id))
    .map((r) => ({ r, feel: feelOf(r.name), cool: coolOf(r.name) }))
    .filter((x) => x.cool === 'indoor' && x.feel === 'calm' && x.r.type !== 'RIDE')
    .map((x) => ({ ...x, walk: pos && Number.isFinite(x.r.lat) ? walk(pos, x.r) : null }))
    .sort((a, b) => (a.walk ?? 99) - (b.walk ?? 99))
    .slice(0, max);
}

// ---- Drop test ----

const PIRATES = 'pirates of the caribbean';
const RISE = /rise of the resistance/;
const RUNAWAY = 'mickey and minnies runaway railway';

/**
 * The drop test. Pirates of the Caribbean has two short drops in the dark; Rise of the Resistance
 * ends with a bigger one in the dark. When the trip file lists Rise as a *conditional* avoid, Rise
 * moves onto the list (any Disneyland day, any weekday), waiting on Pirates going well (the drop
 * test) and, when the trip lists it, Runaway Railway (screen tolerance, the family's own rule).
 * A firm avoid stays avoided. Returns { trip, dropKey, riseKey, added } (trip unchanged when n/a).
 */
export function withDropTest(trip) {
  const none = { trip, dropKey: null, riseKey: null, added: false };
  if (!trip?.rides?.length) return none;
  const pir = trip.rides.find((r) => r.park === 'DL' && normalizeName(r.name).startsWith(PIRATES));
  if (!pir) return none;
  const riseRide = trip.rides.find((r) => r.park === 'DL' && RISE.test(normalizeName(r.name)));
  const riseAvoid = trip.avoid?.find((a) => a.park === 'DL' && RISE.test(normalizeName(a.name)));
  const runaway = trip.rides.find((r) => r.park === 'DL' && normalizeName(r.name).startsWith(RUNAWAY));
  let rise = riseRide;
  let rides = trip.rides;
  let avoid = trip.avoid ?? [];
  let added = false;
  if (!rise) {
    if (!riseAvoid?.conditional) return { ...none, dropKey: pir.key };
    rise = {
      key: riseAvoid.key,
      name: riseAvoid.name,
      park: 'DL',
      priority: 'high',
      ll: 'singlepass',
      notes: 'Ends with a drop in the dark. On the list once the Pirates drop test goes well.',
      intensity: 3,
      rest: false,
      ropeDrop: false,
      typical: null,
      conditionalOn: pir.key,
      hint: null,
      original1955: false,
      tpwId: riseAvoid.tpwId ?? null,
    };
    rides = [...rides, rise];
    avoid = avoid.filter((a) => a !== riseAvoid);
    added = true;
  }
  const ladders = { ...(trip.ladders ?? {}), dropTest: [pir.key, rise.key] };
  if (runaway) ladders.screenTest = [runaway.key, rise.key];
  return { trip: { ...trip, rides, avoid, ladders }, dropKey: pir.key, riseKey: rise.key, added };
}

/**
 * Rides that still have to go first ("test rides"): a gate that isn't passed yet, for a wanted ride
 * that isn't done or skipped. A test ride gets a head start just ahead of what it unlocks, so the
 * drop test happens early instead of after the calm rides it would otherwise sit among.
 * gates: Map key -> [gateKey]; bias: { tpwId: minutes }; blocked: Set of tpwIds out for the day (skipped,
 * saved for another day, too short), as opposed to merely waiting on a test.
 * Returns { tpwId: minutes } (only the changes).
 */
export function testRideBias(trip, gates, { bias, wanted, ridden, gate, blocked }) {
  const byKey = new Map((trip?.rides ?? []).map((r) => [r.key, r]));
  const out = {};
  const biasOf = (id) => out[id] ?? bias[id] ?? 0;
  // Two passes so a chain (Pirates -> Big Thunder -> Matterhorn) carries the head start down.
  for (let pass = 0; pass < 2; pass++) {
    for (const [k, gs] of gates) {
      const r = byKey.get(k);
      if (!r?.tpwId || !wanted.has(r.tpwId) || ridden.has(r.tpwId)) continue;
      if (blocked.has(r.tpwId)) continue;
      for (const g of gs) {
        const gr = byKey.get(g);
        if (!gr?.tpwId || gate[g] === 'yes' || gate[g] === 'no' || ridden.has(gr.tpwId)) continue;
        const want = biasOf(r.tpwId) - 5;
        if (want < biasOf(gr.tpwId)) out[gr.tpwId] = want;
      }
    }
  }
  return out;
}
