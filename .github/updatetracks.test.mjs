// Smoketest: exercises the History API track fetch against the live
// Signal K server. Run with `npm test`.
import assert from 'assert';
import { fetchHistoryTrack } from './updatetracks.mjs';

// 2026-10-30 00:00-06:00 UTC, a period the boat was under way
const from = new Date('2026-10-30T00:00:00Z');
const to = new Date('2026-10-30T06:00:00Z');

const track = await fetchHistoryTrack(from, to);
assert(track, 'History API returned no track');
assert.strictEqual(track.type, 'MultiLineString');
assert(Array.isArray(track.coordinates), 'coordinates missing');
assert(Array.isArray(track.coordinates[0]), 'no track segment');
assert(track.coordinates[0].length > 1, 'track segment has too few points');
for (const point of track.coordinates[0]) {
  assert(Number.isFinite(point[0]) && Number.isFinite(point[1]), 'invalid coordinate pair');
}

console.log(`updatetracks smoketest passed (${track.coordinates[0].length} points)`);
