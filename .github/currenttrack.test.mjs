// Unit tests for the minimum-movement gate on tracks/current.json in
// updatetracks.mjs. Offline and deterministic; run with `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRewriteCurrentTrack } from './updatetracks.mjs';

const WINDOW = '2026-11-01T10:00:00.000Z';

function track(from, coords) {
  return {
    type: 'MultiLineString',
    from,
    coordinates: [coords],
  };
}

test('jitter below the threshold keeps the existing track', () => {
  // 0.02 NM (~37 m) of anchor sway between the recorded end and the new one
  const existing = track(WINDOW, [[174.0, -35.0], [174.0004, -35.0]]);
  const fresh = track(WINDOW, [[174.0, -35.0], [174.0004, -35.0], [174.00073, -35.0]]);
  assert.strictEqual(shouldRewriteCurrentTrack(existing, fresh), false);
});

test('movement beyond the threshold rewrites the track', () => {
  // 0.1 NM (~185 m): under way, or at least real movement
  const existing = track(WINDOW, [[174.0, -35.0], [174.001, -35.0]]);
  const fresh = track(WINDOW, [[174.0, -35.0], [174.001, -35.0], [174.00265, -35.0]]);
  assert.strictEqual(shouldRewriteCurrentTrack(existing, fresh), true);
});

test('a changed track window rebases even without movement', () => {
  // New blog post moved the window start; the stale live track must be
  // rewritten to cover the new window
  const existing = track(WINDOW, [[174.0, -35.0], [174.0004, -35.0]]);
  const fresh = track('2026-11-05T08:00:00.000Z', [[174.0004, -35.0], [174.00041, -35.0]]);
  assert.strictEqual(shouldRewriteCurrentTrack(existing, fresh), true);
});

test('a missing from marker on the existing track forces a rewrite', () => {
  // First run after the gate was introduced: old file format
  const existing = {
    type: 'MultiLineString',
    coordinates: [[[174.0, -35.0], [174.0004, -35.0]]],
  };
  const fresh = track(WINDOW, [[174.0004, -35.0], [174.00041, -35.0]]);
  assert.strictEqual(shouldRewriteCurrentTrack(existing, fresh), true);
});

test('unusable track geometry falls back to rewriting', () => {
  const existing = track(WINDOW, [[174.0, -35.0], [174.0004, -35.0]]);
  const empty = track(WINDOW, []);
  assert.strictEqual(shouldRewriteCurrentTrack(existing, empty), true);
  assert.strictEqual(shouldRewriteCurrentTrack(null, track(WINDOW, [[174.0, -35.0]])), true);
  assert.strictEqual(shouldRewriteCurrentTrack({ type: 'MultiLineString' }, track(WINDOW, [[174.0, -35.0]])), true);
});
