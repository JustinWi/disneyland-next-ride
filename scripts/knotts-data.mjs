// Knott's Berry Farm daytime rides: hand-checked facts the live feed doesn't carry.
// Heights and thrill levels: sixflags.com/knotts/attractions/<ride> pages, read 2026-10-07.
// heightIn is the least height that may ride at all (with a companion if the page allows one);
// heightNote says what it takes to ride alone. null = no minimum given with an adult (ask at the ride).
// Lands are grouping labels only (from the park map, approximate).
// fastLane: rides the all-day Fast Lane wristband covers, from the "Rides Included" list on
// sixflags.com/knotts/fast-lane (read 2026-10-07; 16 rides). The ride pages don't say.
// Night-only Scary Farm mazes and Soak City slides are left out on purpose.

const YT = (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q + ' POV Knotts Berry Farm')}`;

// [name, land, heightIn, heightNote, intensity 1-5, fastLane, expect, tags]
export const KNOTTS = [
  ['GhostRider', 'Ghost Town', 48, '', 5, true, 'Giant wooden coaster: 118 ft first drop, 14 hills, rough and fast, about 3 minutes.', ['coaster', 'drop', 'outdoor', 'fast']],
  ['Silver Bullet', 'Ghost Town', 54, '', 5, true, 'Inverted coaster, feet dangling: 6 upside-downs including a 105 ft loop.', ['coaster', 'inversions', 'outdoor', 'fast']],
  ['Xcelerator The Ride®', 'The Boardwalk', 52, '', 5, true, 'Launch from 0 to 82 mph in 2.3 seconds, straight up 205 ft and a 90-degree drop. Very short.', ['coaster', 'launch', 'drop', 'outdoor', 'fast']],
  ['HangTime', 'The Boardwalk', 48, 'Maximum height 77 in.', 5, true, 'Dive coaster: a 96-degree beyond-vertical drop, then 5 upside-downs.', ['coaster', 'drop', 'inversions', 'outdoor', 'fast']],
  ['Supreme Scream', 'The Boardwalk', 52, '', 5, true, 'Drop tower: up 252 ft, then down in about 3 seconds.', ['drop', 'tower', 'outdoor']],
  ['Sol Spin', 'Fiesta Village', 54, '', 5, true, 'Six arms swing you six stories up and spin you head over heels.', ['spin', 'inversions', 'outdoor']],
  ['MonteZOOMa: The Forbidden Fortress', 'Fiesta Village', 48, 'Reopened 2026: check the sign at the ride.', 5, false, 'Launch coaster (the old Montezooma): 0 to 55 mph, a loop, then up a vertical spike, forward and backward.', ['coaster', 'launch', 'inversions', 'outdoor', 'fast']],
  ['Jaguar!', 'Fiesta Village', 48, '', 4, true, 'Long steel coaster through a Mayan temple: drops and curves, no upside-downs.', ['coaster', 'outdoor']],
  ['Pony Express', 'Ghost Town', 48, '', 4, true, 'Ride a horse-saddle seat: launch to 38 mph in under 3 seconds, no upside-downs.', ['coaster', 'launch', 'outdoor']],
  ['Sierra Sidewinder', 'Camp Snoopy', 42, '48 in. to ride alone; 42-47 in. with a companion', 4, true, 'Spinning coaster: the cars rotate as they dive and turn, 37 mph.', ['coaster', 'spin', 'outdoor']],
  ['Coast Rider', 'The Boardwalk', 44, '54 in. to ride alone; 44-53 in. with a companion', 4, true, 'Mouse-style coaster: 52 ft climb, tight hairpin turns and little drops.', ['coaster', 'outdoor']],
  ['La Revolucion', 'Fiesta Village', 48, '', 4, true, 'Giant swinging, spinning pendulum 64 ft up, 120 degrees each way.', ['swing', 'spin', 'outdoor']],
  ['Wipeout', 'The Boardwalk', 48, '', 4, false, 'Spinner that tilts up off the ground while it whirls.', ['spin', 'outdoor']],
  ['Timber Mountain Log Ride', 'Ghost Town', 36, '46 in. to ride alone; 36-45 in. with a companion', 3, true, 'Log flume past lumber-camp scenes, ends with a big splash drop. You will get wet.', ['water', 'drop', 'outdoor']],
  ['Calico River Rapids', 'Ghost Town', 46, '', 3, true, 'Round rafts on rapids through the woods. Expect to get soaked.', ['water', 'outdoor']],
  ['Dragon Swing', 'Fiesta Village', 48, '', 3, false, 'Pirate-ship swing that rises nearly straight up at each end.', ['swing', 'outdoor']],
  ['Pacific Scrambler', 'The Boardwalk', 36, '48 in. to ride alone; 36-47 in. with a companion', 3, false, 'Classic Scrambler: whips you around in spinning arcs.', ['spin', 'outdoor']],
  ['Wheeler Dealer Bumper Cars', 'The Boardwalk', 42, '48 in. to drive alone; 42-47 in. with a companion', 3, false, 'Bumper cars, under a roof.', ['drive', 'outdoor']],
  ['Hat Dance', 'Fiesta Village', 36, '42 in. to ride alone; 36-41 in. with a companion', 2, false, 'Spinning sombrero teacups; you control the spin.', ['spin', 'outdoor']],
  ['Surfside Gliders', 'The Boardwalk', 36, '44 in. to ride alone; 36-43 in. with a companion', 2, false, 'Two-seat planes you tilt yourself, 28 ft up over the Boardwalk.', ['outdoor']],
  ['Los Voladores', 'Fiesta Village', 48, '', 2, true, 'Swing ride 40 ft up, round and round; mellow.', ['swing', 'outdoor']],
  ['Knott\'s Bear-y Tales: Return to the Fair', 'The Boardwalk', null, '46 in. to ride alone; shorter riders with an adult', 2, true, 'Indoor 4-D dark ride: shoot jelly blasters at targets. No drops. Air-conditioned.', ['dark', 'shooter', 'indoor', 'slow']],
  ['Calico Mine Ride', 'Ghost Town', null, '46 in. to ride alone; shorter riders with an adult', 2, true, 'Gentle ore-car ride through a mine full of animated miners. Indoors.', ['dark', 'train', 'indoor', 'slow']],
  ['Sky Cabin', 'The Boardwalk', null, '46 in. to ride alone; shorter riders with an adult', 1, false, 'Slow rotating cabin up a 180 ft tower: views of the whole park.', ['views', 'slow']],
  ['Calico Railroad', 'Ghost Town', null, '46 in. to ride alone; shorter riders with an adult', 1, false, 'Real narrow-gauge steam train around the park; bandits may hold it up.', ['train', 'outdoor', 'slow']],
  ['Butterfield Stagecoach', 'Ghost Town', null, '46 in. to ride alone; shorter riders with an adult', 1, false, 'Horse-drawn stagecoach around the park.', ['outdoor', 'slow']],
  ['Carrusel de California', 'Fiesta Village', null, '46 in. to ride alone; shorter riders with an adult', 1, false, 'Antique 1902 carousel with carved animals, shaded.', ['carousel', 'slow']],
  ['Snoopy’s Tenderpaw Twister Coaster', 'Camp Snoopy', 36, '42 in. to ride alone; 36-41 in. with a companion', 2, false, 'Small family coaster with a gentle launch through the trees.', ['coaster', 'outdoor', 'kids']],
  ['Linus Launcher', 'Camp Snoopy', 36, '42 in. to ride alone; 36-41 in. with an adult', 2, false, 'Lie face-down on a "blanket" and swing up through the air.', ['swing', 'outdoor', 'kids']],
  ['Charlie Brown\'s Kite Flyer', 'Camp Snoopy', 36, '', 2, false, 'Kids\' swing ride above the trees.', ['swing', 'outdoor', 'kids']],
  ['Balloon Race', 'Camp Snoopy', 36, '', 1, false, 'Kids\' hot-air-balloon ride that spins gently.', ['spin', 'outdoor', 'kids']],
  ['Flying Ace', 'Camp Snoopy', 32, '', 1, false, 'Kids\' Snoopy plane ride that swoops up and down.', ['outdoor', 'kids']],
  ['Camp Snoopy\'s Off-Road Rally', 'Camp Snoopy', 36, '', 1, false, 'Kids drive Peanuts trucks on a little track.', ['drive', 'outdoor', 'kids']],
  ['Pig-Pen\'s Mud Buggies', 'Camp Snoopy', 36, '', 1, false, 'Kids\' bouncing buggies (no real mud).', ['outdoor', 'kids']],
  ['Rapid River Run', 'Camp Snoopy', 42, '', 1, false, 'Kids\' tugboat ride on winding water.', ['water', 'outdoor', 'kids']],
  ['Beagle Express Railroad', 'Camp Snoopy', null, '46 in. to ride alone', 1, false, 'Little Peanuts train around Camp Snoopy.', ['train', 'outdoor', 'kids', 'slow']],
  ['Sally\'s Swing Along', 'Camp Snoopy', null, '', 1, false, 'Kids\' swing ride.', ['swing', 'outdoor', 'kids']],
].map(([name, land, heightIn, heightNote, intensity, fastLane, expect, tags]) => ({ name, land, heightIn, heightNote, intensity, fastLane, expect, tags, video: YT(name.replace(/®/g, '')) }));

// Knott's Fast Lane (paid, per person, all day). https://www.sixflags.com/knotts/fast-lane
export const FAST_LANE = {
  from: 75, // "starting from $75" a day online; the price changes by date
  how: 'Buy in the Six Flags app, on sixflags.com/knotts, or at the ticket booth. Everyone in the group needs their own wristband.',
};
