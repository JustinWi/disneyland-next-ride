// Ride-name normalization and aliases, shared by the app (trip import) and scripts/ (catalog build).
// Pure ES module, no Node APIs.

const DASHES = /[‐-―−]/g; // hyphen variants, figure/en/em dash, horizontal bar, minus
const QUOTES = /['"`‘’‚‛“”„‟′″´]/g;
const MARKS = /[™®©℠]/g; // TM, (R), (C), SM

export function normalizeName(s) {
  if (s == null) return '';
  let t = String(s).toLowerCase().replace(MARKS, '');
  t = t.normalize('NFKD').replace(/[̀-ͯ]/g, ''); // fold accents
  t = t.replace(QUOTES, ''); // "soarin'" -> "soarin", "it's" -> "its"
  t = t.replace(DASHES, ' '); // en/em dash and " - " become a space
  t = t.replace(/&/g, ' and ');
  t = t.replace(/[^a-z0-9]+/g, ' '); // everything else is a separator
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^the /, '');
  return t;
}

// Each group lists names (already in normalizeName form) that refer to the same physical queue.
// Keep groups narrow: a group must never contain two rides that both run on the same day as
// separate entities in either source (e.g. Guardians BREAKOUT vs Monsters After Dark are listed
// separately by both sources during Halloween, so they are NOT grouped).
export const ALIAS_GROUPS = [
  // names used in hand-written trip files
  ['pirates lair on tom sawyer island', 'tom sawyer island', 'pirates lair'],
  ['star wars rise of the resistance', 'rise of the resistance'],
  ['its a small world', 'its a small world holiday', 'its a small world halloween overlay'],
  // punctuation / film swaps on Soarin'
  ['soarin across america', 'soarin around world', 'soarin around the world', 'soarin over california', 'soarin'],
  // Indiana Jones full title
  ['indiana jones adventure', 'indiana jones adventure temple of forbidden eye', 'indiana jones adventure temple of the forbidden eye'],
  // Pixar Pal-A-Round: QT has used "Swinging" / "Non-Swinging" with and without "Gondolas"
  ['pixar pal a round swinging', 'pixar pal a round swinging gondolas', 'pixar palaround swinging'],
  ['pixar pal a round non swinging', 'pixar pal a round non swinging gondolas', 'pixar palaround non swinging'],
  // Guardians base name vs full title (the Halloween overlay stays separate, see above)
  ['guardians of galaxy mission breakout', 'guardians of the galaxy mission breakout'],
  // seasonal overlays that replace (not run alongside) the base ride
  ['haunted mansion', 'haunted mansion holiday'],
  ['jungle cruise', 'jingle cruise'],
  ['luigis rollickin roadsters', 'luigis honkin haul o ween'],
  ['maters junkyard jamboree', 'maters graveyard jamboree', 'maters graveyard jambooree'],
  // renames and short forms
  ['star tours adventures continue', 'star tours the adventures continue', 'star tours'],
  ['snow whites enchanted wish', 'snow whites scary adventures'],
  ['chip n dales gadgetcoaster', 'gadgets go coaster'],
  ['walt disneys enchanted tiki room', 'enchanted tiki room'],
  ['monsters inc mike and sulley to rescue', 'monsters inc mike and sulley to the rescue'],
  ['little mermaid ariels undersea adventure', 'ariels undersea adventure'],
  ['mickey and minnies runaway railway', 'mickey minnies runaway railway'],
  ['millennium falcon smugglers run', 'millenium falcon smugglers run'],
  ['web slingers a spider man adventure', 'web slingers spider man adventure', 'webslingers a spider man adventure'],
];

// The same physical ride listed as a second, separate entity for a season (both listed, never both
// running). Avoiding a ride avoids its seasonal version too. Names in canonical form.
export const SEASONAL_TWINS = [['guardians of galaxy mission breakout', 'guardians of the galaxy monsters after dark']];

const ALIAS = new Map();
for (const group of ALIAS_GROUPS) for (const n of group) ALIAS.set(n, group[0]);
export const canonical = (norm) => ALIAS.get(norm) ?? norm;


export function tokens(norm) {
  return new Set(norm.split(' ').filter((w) => w.length >= 3));
}

// A token present on only one side that flips meaning: "Swinging" vs "Non-Swinging" scores 0.8.
const DISCRIMINATORS = new Set(['non', 'single', 'rider', 'holiday']);

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  for (const d of DISCRIMINATORS) if (a.has(d) !== b.has(d)) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

