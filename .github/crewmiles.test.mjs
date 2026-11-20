// Unit tests for the engine miles classifier in crewmiles.mjs.
// Offline and deterministic; run with `npm test` or `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { milesFromEntries } from './crewmiles.mjs';

function entry(datetime, text, log, extra = {}) {
  return {
    datetime,
    text,
    log,
    ...extra,
  };
}

// Auto-generated entries timestamp the exact navigation.state transition,
// so the interval ending at "Motor stopped, sailing with X" belongs to
// the motoring state that preceded it, and the following intervals to
// sailing.
test('transition timing buckets the interval before a state change by the old state', () => {
  const { yearMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Anchor up, motoring', 100),
    entry('2026-06-01T09:00:00Z', '', 105),
    entry('2026-06-01T10:00:00Z', 'Motor stopped, sailing with Main, Genoa 1', 110),
    entry('2026-06-01T11:00:00Z', '', 115),
    entry('2026-06-01T12:00:00Z', 'Anchored', 115, { end: true }),
  ]);
  assert.strictEqual(yearMiles['2026'].total, 15);
  assert.strictEqual(yearMiles['2026'].motoring, 10);
  assert.strictEqual(yearMiles['2026'].sailing, 5);
});

test('motorsailing counts as motoring mileage-wise', () => {
  const { yearMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Anchor up, motoring', 0),
    entry('2026-06-01T09:00:00Z', 'Motorsailing with 1st reef as wind died', 5),
    entry('2026-06-01T10:00:00Z', '', 10),
  ]);
  assert.strictEqual(yearMiles['2026'].motoring, 10);
  assert.strictEqual(yearMiles['2026'].sailing, 0);
});

test('"Sails set: X" resets to sailing', () => {
  // The logbook plugin only emits this while navigation.state is sailing
  const { yearMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Sails down, motoring', 0),
    entry('2026-06-01T09:00:00Z', 'Sails set: Genoa 1', 5),
    entry('2026-06-01T10:00:00Z', '', 10),
  ]);
  assert.strictEqual(yearMiles['2026'].motoring, 5);
  assert.strictEqual(yearMiles['2026'].sailing, 5);
});

test('engine.hours not advancing overrides stale keyword state', () => {
  // Hand-edited entries can leave motoring=true although the engine
  // demonstrably was off
  const { yearMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Sails down, motoring', 200, { engine: { hours: 10.0 } }),
    entry('2026-06-01T09:00:00Z', '', 205, { engine: { hours: 10.0 } }),
    entry('2026-06-01T10:00:00Z', '', 210, { engine: { hours: 11.0 } }),
  ]);
  assert.strictEqual(yearMiles['2026'].motoring, 5);
  assert.strictEqual(yearMiles['2026'].sailing, 5);
});

test('trip end resets the state and negative log deltas are skipped', () => {
  const { yearMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Motoring', 50),
    entry('2026-06-01T09:00:00Z', 'Anchored', 55, { end: true }),
    entry('2026-06-01T10:00:00Z', '', 54),
    entry('2026-06-01T11:00:00Z', '', 60),
  ]);
  assert.strictEqual(yearMiles['2026'].total, 11);
  assert.strictEqual(yearMiles['2026'].motoring, 5);
  assert.strictEqual(yearMiles['2026'].sailing, 6);
});

test('crew attribution (autopilot/windvane, crew rename) is unchanged', () => {
  const { crewMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Autopilot activated', 0, { crewNames: ['ihmis-suski', 'bergie'] }),
    entry('2026-06-01T09:00:00Z', '', 10, { crewNames: ['ihmis-suski', 'bergie'] }),
    entry('2026-06-01T10:00:00Z', 'Autopilot deactivated', 20),
    entry('2026-06-01T11:00:00Z', 'Windvane steering', 30),
  ]);
  assert.strictEqual(crewMiles.suski, 10);
  assert.strictEqual(crewMiles.bergie, 10);
  assert.strictEqual(crewMiles.nissinen, 20);
  assert.strictEqual(crewMiles.starbuck, 10);
});

// Sail miles: intervals are credited to the sail set carried INTO them,
// mirroring the motoring bucketing, and only while sailing.
test('sail miles start at the motor-stop entry, not before it', () => {
  const { sailMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Anchor up, motoring', 0),
    entry('2026-06-01T09:00:00Z', '', 10),
    entry('2026-06-01T10:00:00Z', 'Motor stopped, sailing with Main, Genoa 1', 20),
    entry('2026-06-01T11:00:00Z', '', 30),
  ]);
  assert.deepStrictEqual(sailMiles.sails, {
    Main: { miles: 10, hours: 1 },
    'Genoa 1': { miles: 10, hours: 1 },
  });
  assert.deepStrictEqual(sailMiles.years['2026'], {
    Main: { miles: 10, hours: 1 },
    'Genoa 1': { miles: 10, hours: 1 },
  });
});

test('"Sails set:" switches the credited set mid-passage', () => {
  const { sailMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Motor stopped, sailing with Main, Genoa 1', 0),
    entry('2026-06-01T10:00:00Z', 'Sails set: Main (1st reef)', 20),
    entry('2026-06-01T11:00:00Z', '', 30),
  ]);
  // First interval (2h, 20NM) sailed with Main + Genoa 1; after
  // re-reefing only Main stays credited (1h, 10NM)
  assert.strictEqual(sailMiles.sails.Main.miles, 30);
  assert.strictEqual(sailMiles.sails.Main.hours, 3);
  assert.strictEqual(sailMiles.sails['Genoa 1'].miles, 20);
  assert.strictEqual(sailMiles.sails['Genoa 1'].hours, 2);
});

test('"Sails down, motoring" ends sail attribution', () => {
  const { sailMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Motor stopped, sailing with Staysail', 0),
    entry('2026-06-01T09:00:00Z', 'Sails down, motoring', 10),
    entry('2026-06-01T10:00:00Z', '', 20),
  ]);
  assert.strictEqual(sailMiles.sails.Staysail.miles, 10);
  assert.strictEqual(sailMiles.sails.Staysail.hours, 1);
});

test('motorsailing miles are credited to the known set, cone means main up', () => {
  const { sailMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Anchor up, motoring', 0),
    entry('2026-06-01T09:00:00Z', 'Motorsailing with the cone', 10),
    entry('2026-06-01T10:00:00Z', 'Motor stopped, sailing', 20),
    entry('2026-06-01T11:00:00Z', '', 30),
  ]);
  // The first motoring interval had no known set; from the cone entry
  // on the mainsail is up, motorsailing miles included
  assert.deepStrictEqual(sailMiles.sails, {
    Main: { miles: 20, hours: 2 },
  });
});

test('cone day marker under plain motoring still sets the mainsail', () => {
  const { sailMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Motor stopped, sailing with Genoa 1', 0),
    entry('2026-06-01T09:00:00Z', 'Sails down, motoring', 10),
    entry('2026-06-01T10:00:00Z', 'Motoring with the cone up, Gulf of Finland TSS', 20),
    entry('2026-06-01T11:00:00Z', '', 30),
  ]);
  // Genoa came down at the sails-down entry; the cone then means the
  // main went up and it takes the motoring miles from there
  assert.deepStrictEqual(sailMiles.sails, {
    'Genoa 1': { miles: 10, hours: 1 },
    Main: { miles: 10, hours: 1 },
  });
});

test('hand-edited lists: prose suffixes, multiline text, reef annotations', () => {
  const { sailMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Motor stopped, sailing with Staysail, Genoa 1 (10% furled). Main was slatting too much', 0),
    entry('2026-06-01T10:00:00Z', 'Sails set: Main (1st reef)\nWindvane steering. Suski on watch', 20),
    entry('2026-06-01T11:00:00Z', '', 30),
  ]);
  // First two hours: Staysail + Genoa 1 (Main mentioned only in prose)
  assert.strictEqual(sailMiles.sails.Staysail.miles, 20);
  assert.strictEqual(sailMiles.sails['Genoa 1'].miles, 20);
  assert.strictEqual(sailMiles.sails.Main.miles, 10);
  assert.strictEqual(sailMiles.sails.Main.hours, 1);
});

test('trip end clears the sail set', () => {
  const { sailMiles } = milesFromEntries([
    entry('2026-06-01T08:00:00Z', 'Motor stopped, sailing with Main', 0),
    entry('2026-06-01T09:00:00Z', 'Anchored', 10, { end: true }),
    entry('2026-06-01T10:00:00Z', '', 20),
  ]);
  // The interval into the anchoring entry was still sailed with Main;
  // everything after the trip end is unattributed
  assert.deepStrictEqual(sailMiles.sails, {
    Main: { miles: 10, hours: 1 },
  });
});
