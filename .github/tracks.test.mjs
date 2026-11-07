// Smoketest: exercises the antimeridian unwrap used by the map views.
// js/tracks.js is a plain browser script, so it is evaluated here with
// its function declarations scoped to the eval.
import assert from 'assert';
import { readFileSync } from 'fs';

const source = readFileSync(new URL('../js/tracks.js', import.meta.url), 'utf-8');
const { unwrapLongitudes, boatCenter } = eval(`${source}\n({ unwrapLongitudes, boatCenter })`);

// Eastward crossing: Minerva reef at ~179°E, continuing past the line
assert.deepStrictEqual(
  unwrapLongitudes([[179.5, -20], [-179.5, -20.2], [-178.5, -20.4]]),
  [[179.5, -20], [180.5, -20.2], [181.5, -20.4]],
);

// Westward crossing: back towards New Zealand
assert.deepStrictEqual(
  unwrapLongitudes([[-179, -21], [179, -22], [178, -23]]),
  [[-179, -21], [-181, -22], [-182, -23]],
);

// No crossing: nothing shifts
assert.deepStrictEqual(
  unwrapLongitudes([[174.2, -35], [174.5, -35.1], [175, -35.2]]),
  [[174.2, -35], [174.5, -35.1], [175, -35.2]],
);

// Crossing with a sub-degree step unwraps to just past the line
assert.deepStrictEqual(
  unwrapLongitudes([[179.8, 0], [-179.9, 0]]),
  [[179.8, 0], [180.1, 0]],
);

// Sanity: monotonic longitudes across the whole unwrapped track
const unwrapped = unwrapLongitudes([[179.9, 0], [-179.9, 0], [-179.8, 0], [179.9, 0], [179.8, 0]]);
const lons = unwrapped.map((c) => c[0]);
for (let i = 1; i < lons.length; i += 1) {
  assert(Math.abs(lons[i] - lons[i - 1]) < 180, `jump detected at index ${i}: ${lons[i - 1]} -> ${lons[i]}`);
}

// Boat placement: pure function of position, zoom and pixel delta —
// re-running it must not drift (idempotence after resizes)
const zero = boatCenter([0, 0], 7, [0, 0]);
assert.deepStrictEqual(zero, [0, 0]);

// Delta below-left of screen center moves the map center north-east,
// so the boat renders south-west (in the clear corner)
const shifted = boatCenter([174.23, -34.99], 7, [-100, 150]);
assert(shifted[0] > 174.23, 'center should move east');
assert(shifted[1] > -34.99, 'center should move north');
const back = boatCenter(shifted, 7, [100, -150]);
assert(Math.abs(back[0] - 174.23) < 1e-9, 'roundtrip east failed');
assert(Math.abs(back[1] + 34.99) < 1e-9, 'roundtrip north failed');

// Zoom affects how far the center moves for the same pixel delta
const zoomedOut = boatCenter([174.23, -34.99], 4, [-100, 150]);
assert(Math.abs(zoomedOut[0] - 174.23) > Math.abs(shifted[0] - 174.23), 'zoom 4 shift too small');

console.log('tracks.js smoketest passed');
