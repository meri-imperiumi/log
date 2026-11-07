// Unit tests for storm day counting in stormdays.mjs.
// Offline and deterministic; run with `npm test` or `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  harbourDays,
  groupStretch,
  computeStormDays,
  stormDayCount,
} from './stormdays.mjs';

const journeys = {
  '2024': { start: '2024-04-06T00:00:00.000Z', end: '2024-12-01T00:00:00.000Z' },
  '2025': { start: '2025-07-01T00:00:00.000Z', end: '2025-07-10T00:00:00.000Z' },
};

function entry(datetime, category, position, extra = {}) {
  const e = {
    datetime,
    text: '',
    log: 100,
    category,
    ...extra,
  };
  if (position) {
    e.position = {
      longitude: position[0],
      latitude: position[1],
      source: 'GPS',
    };
  }
  return e;
}

test('harbour days: no navigation entries, entry-less days inherit position and harbour type', () => {
  const entries = [
    entry('2024-07-05T10:00:00Z', 'navigation', [24.9, 59.8]),
    // 2025-07-01: travelled 6 nm, a Reisetag
    entry('2025-07-01T10:00:00Z', 'navigation', [24.95, 59.85], { log: 100 }),
    entry('2025-07-01T18:00:00Z', 'navigation', [24.95, 59.85], { log: 106 }),
    entry('2025-07-03T10:00:00Z', 'engine', [24.95, 59.85], { log: 106 }),
    entry('2025-07-03T18:00:00Z', 'navigation', [24.96, 59.86], { text: 'Anchored', end: true, log: 106 }),
    // 2025-07-04..10 have no entries at all
  ];
  const days = harbourDays(entries, journeys);
  assert.strictEqual(days.filter((d) => d.year === '2024').length, 0, 'manual years should be skipped');
  const byDate = new Map(days.map((d) => [d.date, d]));
  assert.strictEqual(byDate.get('2025-07-01'), undefined, 'Reisetag (6 nm) is not a harbour day');
  assert(byDate.get('2025-07-02'), 'entry-less day should be a harbour day');
  assert(byDate.get('2025-07-03'), 'engine category day is a harbour day');
  assert.deepStrictEqual(byDate.get('2025-07-02').position, { latitude: 59.85, longitude: 24.95 }, 'position should carry forward');
  assert.strictEqual(byDate.get('2025-07-04').state, 'anchored', 'state should carry from the Anchored trip end');
  assert.strictEqual(days.length, 8, '2025-07-02..09');
});

test('days with navigation entries but under 5 nm movement are harbour days', () => {
  // Re-anchoring in the same anchorage is not leaving
  const entries = [
    entry('2025-07-01T10:00:00Z', 'navigation', [24.95, 59.85], { log: 100 }),
    entry('2025-07-01T18:00:00Z', 'navigation', [24.95, 59.85], { text: 'Anchored', end: true, log: 105 }),
    entry('2025-07-02T10:00:00Z', 'navigation', [24.95, 59.85], { text: 'Started main engine', log: 105 }),
    entry('2025-07-02T10:30:00Z', 'navigation', [24.95, 59.85], { text: 'Stopped main engine', log: 105.1 }),
    entry('2025-07-04T10:00:00Z', 'navigation', [24.95, 59.85], { log: 110.1 }),
    entry('2025-07-04T18:00:00Z', 'navigation', [24.95, 59.85], { log: 115.1 }),
  ];
  const days = harbourDays(entries, journeys);
  const byDate = new Map(days.map((d) => [d.date, d]));
  assert.strictEqual(byDate.get('2025-07-01'), undefined, '5 nm travel day is not a harbour day');
  assert(byDate.get('2025-07-02'), '0.1 nm shuffle day is a harbour day');
  assert(byDate.get('2025-07-03'), 'entry-less day is a harbour day');
  assert.strictEqual(byDate.get('2025-07-04'), undefined, '5 nm departure day is not a harbour day');
});

test('a "Stopped" trip end marks the following harbour days as moored', () => {
  const entries = [
    entry('2025-07-01T10:00:00Z', 'navigation', [19.9, 60.1], { log: 100 }),
    entry('2025-07-01T16:00:00Z', 'navigation', [19.9, 60.1], { text: 'Stopped', end: true, log: 106 }),
  ];
  const days = harbourDays(entries, journeys);
  const byDate = new Map(days.map((d) => [d.date, d]));
  assert.strictEqual(byDate.get('2025-07-03').state, 'moored');
});

test('days are local solar days at the boat position', () => {
  // At longitude -90° the local solar day is shifted six hours from
  // UTC, so the cruise can start on the local date before the journey
  // start instant
  const entries = [
    // 2025-06-30 local: a 6 nm Reisetag
    entry('2025-06-30T18:00:00Z', 'navigation', [-90, 0.5], { log: 100 }),
    entry('2025-06-30T22:00:00Z', 'navigation', [-90, 0.5], { log: 106 }),
    // 2025-07-01 local: arrival after midnight local, anchored
    entry('2025-07-01T08:00:00Z', 'navigation', [-90, 0.5], { log: 106.2 }),
    entry('2025-07-01T20:00:00Z', 'navigation', [-90, 0.5], { text: 'Anchored', end: true, log: 106.2 }),
  ];
  const days = harbourDays(entries, journeys);
  const byDate = new Map(days.map((d) => [d.date, d]));
  assert.strictEqual(byDate.get('2025-06-30'), undefined, 'Reisetag in local time is not a harbour day');
  assert(byDate.get('2025-07-01'), 'arrival day with sub-5 nm movement is a harbour day');
  assert.strictEqual(byDate.get('2025-07-01').state, 'anchored');
  assert.deepStrictEqual(byDate.get('2025-07-02').position, { latitude: 0.5, longitude: -90 });
});

test('consecutive harbour days at the same spot group into one stretch', () => {
  const days = [
    { year: '2025', date: '2025-07-02', position: { latitude: 59.851, longitude: 24.952 } },
    { year: '2025', date: '2025-07-03', position: { latitude: 59.852, longitude: 24.951 } },
    { year: '2025', date: '2025-07-04', position: { latitude: 60.10, longitude: 24.95 } },
    { year: '2025', date: '2025-07-05', position: { latitude: 60.10, longitude: 24.95 } },
    { year: '2026', date: '2026-02-01', position: { latitude: 59.851, longitude: 24.952 } },
  ];
  const stretches = groupStretch(days);
  assert.strictEqual(stretches.length, 3, 'same-spot, moved, and new year should give three stretches');
  assert.strictEqual(stretches[0].days.length, 2);
  assert.strictEqual(stretches[1].days.length, 2);
});

test('computeStormDays: threshold, missing forecasts, recorded days and manual entries', async () => {
  const entries = [
    // 2025-07-01 local: 6 nm Reisetag ending moored
    entry('2025-07-01T10:00:00Z', 'navigation', [24.95, 59.85], { log: 100 }),
    entry('2025-07-01T16:00:00Z', 'navigation', [24.95, 59.85], { text: 'Stopped', end: true, log: 106 }),
  ];
  const existing = {
    '2025': [
      { date: '2025-07-02', state: 'moored', wind_kn: 22, gust_kn: 41, cape: 5, latitude: 59.85, longitude: 24.95 },
      // A remembered storm on a day the data does not support, and on a
      // day the automatic pass would otherwise classify as a Reisetag
      { date: '2025-07-01', state: 'sailing', basis: 'manual', note: 'squall on the nose, sat it out in the lee of the island' },
    ],
  };
  const fetchCalls = [];
  const fakeFetch = (position, startDate, endDate) => {
    fetchCalls.push({ position, startDate, endDate });
    // Hourly rows over the widened UTC range; the local solar day is
    // offset by longitude 24.95° (about +1h40m)
    const peaks = {
      '2025-07-03': { wind: 18.2, gust: 29.9, cape: 0 }, // below threshold
      '2025-07-04': { wind: 19.0, gust: 30.0, cape: 10 }, // exactly at threshold, not a storm
      '2025-07-05': { wind: 21.4, gust: 33.4, cape: 250 },
    };
    const rows = [];
    for (let day = new Date(`${startDate}T00:00:00Z`); day <= new Date(`${endDate}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
      for (let hour = 0; hour < 24; hour += 1) {
        const time = new Date(day.getTime() + hour * 3600000);
        const date = time.toISOString().substr(0, 10);
        const peak = peaks[date] && hour === 12 ? peaks[date] : { wind: 8, gust: 12, cape: 0 };
        rows.push({
          time: time.getTime(),
          wind: peak.wind,
          gust: peak.gust,
          cape: peak.cape,
        });
      }
    }
    return Promise.resolve(rows);
  };
  const stormDays = await computeStormDays(entries, journeys, existing, fakeFetch);
  assert.strictEqual(fetchCalls.length, 1, 'whole harbour stretch should be one request');
  assert.strictEqual(fetchCalls[0].startDate, '2025-07-02', 'fetch should cover the widened UTC window start');
  assert.strictEqual(fetchCalls[0].endDate, '2025-07-09', 'fetch should cover the widened UTC window end');
  assert.strictEqual(stormDayCount(stormDays, '2025'), 3, 'manual, existing and one new storm day');
  const manualRecord = stormDays['2025'].find((r) => r.date === '2025-07-01');
  assert.strictEqual(manualRecord.basis, 'manual', 'manual entries survive regeneration');
  assert.strictEqual(manualRecord.note, 'squall on the nose, sat it out in the lee of the island');
  const newRecord = stormDays['2025'].find((r) => r.date === '2025-07-05');
  assert.strictEqual(newRecord.state, 'moored');
  assert.strictEqual(newRecord.wind_kn, 21.4);
  assert.strictEqual(newRecord.gust_kn, 33.4);
  assert.strictEqual(newRecord.cape, 250);
  assert(stormDays['2025'][0].date < stormDays['2025'][1].date, 'records sorted by date');
});
