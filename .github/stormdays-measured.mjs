// Find harbour days where the measured wind on board gusted over
// STORM_GUST_KN even though the forecast did not, and record them as
// storm days (the club rule is about Starkwind, however it became
// known). Runs against the local Signal K history API, so this is a
// manual/offline step - the GitHub Actions flow only counts forecast
// based storm days.
//
// The history API stores velocities in SI units (m/s); a day maximum
// over 10s resolution samples approximates the gusts. Multi-path
// queries return one column per path, single path queries put the
// value in row[1].
import { writeFile, readFile, readdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { parse, stringify } from 'yaml';
import {
  harbourDays,
  groupStretch,
  fetchWeather,
  dayMaxima,
  stormDayCount,
  STORM_GUST_KN,
} from './stormdays.mjs';

const signalKUrl = 'http://192.168.2.105';
const MS_TO_KN = 1.9438445;
const GUST_KN = STORM_GUST_KN;
const FIRST_MEASURED_YEAR = '2023'; // Signal K history starts 2022-01-10
const coarseCacheFile = '.analysis/cache-measured-coarse.json';
const fineCacheFile = '.analysis/cache-measured-fine.json';
const forecastCacheFile = '.analysis/cache-measured-forecast.json';

function loadCache(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    return {};
  }
}

// Maximum of a history path over a UTC instant window. resolution in
// seconds; values converted from m/s to knots.
async function measuredMax(path, fromMs, toMs, resolution, cache, cacheFile) {
  const from = new Date(fromMs).toISOString().substr(0, 19);
  const to = new Date(toMs).toISOString().substr(0, 19);
  const key = `${path}|${from}|${to}|${resolution}`;
  if (cache[key] !== undefined) {
    return cache[key];
  }
  const url = `${signalKUrl}/signalk/v2/api/history/values?paths=${path}&from=${from}Z&to=${to}Z&resolution=${resolution}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    const values = (data.data || [])
      .map((row) => row[1])
      .filter((v) => Number.isFinite(v));
    const max = values.length ? Math.max(...values) * MS_TO_KN : null;
    cache[key] = max;
    await writeFile(cacheFile, JSON.stringify(cache));
    return max;
  } catch (err) {
    console.error(`history fetch failed ${from}: ${err.message}`);
    return null;
  }
}

async function main() {
  const [files, yearStatsContent, stormDaysContent] = await Promise.all([
    readdir('_data/logbook'),
    readFile('_data/year_stats.yml', 'utf-8'),
    readFile('_data/storm_days.yml', 'utf-8').catch((err) => {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      return '';
    }),
  ]);
  const journeys = parse(yearStatsContent);
  const existing = parse(stormDaysContent) || {};
  const logs = files.filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.yml$/)).sort();
  const entries = [].concat(...(await Promise.all(logs.map((logFile) => {
    return readFile(`_data/logbook/${logFile}`, 'utf-8').then((c) => parse(c));
  }))));

  const days = harbourDays(entries, journeys, FIRST_MEASURED_YEAR);
  const recorded = new Set();
  Object.keys(existing).forEach((year) => {
    (existing[year] || []).forEach((record) => {
      recorded.add(record.date);
    });
  });
  const candidates = days.filter((day) => day.position && !recorded.has(day.date));
  console.log(`Harbour days ${FIRST_MEASURED_YEAR}+: ${days.length}, without a storm record: ${candidates.length}`);

  // Forecast maxima per stretch (cached)
  const forecastCache = loadCache(forecastCacheFile);
  const stretches = groupStretch(candidates);
  const forecastByDate = new Map();
  for (const stretch of stretches) {
    let first = null;
    let last = null;
    stretch.days.forEach((day) => {
      const offsetMs = (day.position.longitude / 15) * 3600000;
      const start = new Date(`${day.date}T00:00:00Z`).getTime() - offsetMs;
      const end = start + 24 * 3600000;
      const startDate = new Date(start).toISOString().substr(0, 10);
      const endDate = new Date(end).toISOString().substr(0, 10);
      if (!first || startDate < first) {
        first = startDate;
      }
      if (!last || endDate > last) {
        last = endDate;
      }
    });
    const cacheKey = `${stretch.position.latitude.toFixed(3)},${stretch.position.longitude.toFixed(3)},${first},${last}`;
    let rows;
    if (forecastCache[cacheKey]) {
      rows = forecastCache[cacheKey];
    } else {
      try {
        rows = await fetchWeather(stretch.position, first, last);
        forecastCache[cacheKey] = rows;
        await writeFile(forecastCacheFile, JSON.stringify(forecastCache));
      } catch (err) {
        console.error(`Open-Meteo fetch failed ${first}..${last}: ${err.message}`);
        continue;
      }
    }
    stretch.days.forEach((day) => {
      const maxima = dayMaxima(rows, day.date, day.position.longitude);
      if (maxima) {
        forecastByDate.set(day.date, maxima);
      }
    });
  }

  // Measured gusts: 60s resolution for all candidates, 10s resolution
  // for the ones near the threshold
  const coarse = loadCache(coarseCacheFile);
  const fine = loadCache(fineCacheFile);
  const measured = new Map();
  let noData = 0;
  const dayWindows = new Map();
  candidates.forEach((day) => {
    const offsetMs = (day.position.longitude / 15) * 3600000;
    const start = new Date(`${day.date}T00:00:00Z`).getTime() - offsetMs;
    dayWindows.set(day.date, { start, end: start + 24 * 3600000 });
  });
  // Coarse pass with limited concurrency
  const queue = candidates.slice();
  await Promise.all(Array(4).fill(null).map(async () => {
    while (queue.length) {
      const day = queue.shift();
      const window = dayWindows.get(day.date);
      const coarseMax = await measuredMax('environment.wind.speedTrue', window.start, window.end - 1, 60, coarse, coarseCacheFile);
      if (coarseMax === null) {
        measured.set(day.date, { coarse: null, fine: null });
      } else {
        measured.set(day.date, { coarse: coarseMax, fine: null });
      }
    }
  }));
  // Fine pass for days near or over the threshold
  for (const day of candidates) {
    const m = measured.get(day.date);
    if (!m || m.coarse === null) {
      noData += 1;
      continue;
    }
    if (m.coarse > GUST_KN * 0.6) {
      const window = dayWindows.get(day.date);
      const fineMax = await measuredMax('environment.wind.speedTrue', window.start, window.end - 1, 10, fine, fineCacheFile);
      if (fineMax !== null) {
        m.fine = fineMax;
      }
    }
  }
  console.log(`Days without on-board data: ${noData}`);

  // Days measured over the threshold that the forecast missed
  const stormDays = JSON.parse(JSON.stringify(existing));
  const added = [];
  candidates.forEach((day) => {
    const m = measured.get(day.date);
    const forecast = forecastByDate.get(day.date);
    if (!m || m.coarse === null || !forecast) {
      return;
    }
    const gust = m.fine !== null ? m.fine : m.coarse;
    if (gust > GUST_KN && forecast.gust <= GUST_KN) {
      if (!stormDays[day.year]) {
        stormDays[day.year] = [];
      }
      stormDays[day.year].push({
        date: day.date,
        state: day.state || 'unknown',
        basis: 'measured',
        gust_kn: parseFloat(gust.toFixed(1)),
        latitude: parseFloat(day.position.latitude.toFixed(4)),
        longitude: parseFloat(day.position.longitude.toFixed(4)),
      });
      added.push(`${day.date} measured gust ${gust.toFixed(1)} kn (forecast ${forecast.gust.toFixed(1)} kn)`);
    }
  });
  Object.keys(stormDays).forEach((year) => {
    stormDays[year].sort((a, b) => (a.date < b.date ? -1 : 1));
  });
  if (added.length) {
    console.log(`\nMeasured storm days the forecast missed:`);
    added.forEach((line) => console.log(`  ${line}`));
    await writeFile('_data/storm_days.yml', stringify(stormDays));
  } else {
    console.log('\nNo measured storm days the forecast missed.');
  }
  Object.keys(stormDays).forEach((year) => {
    console.log(`${year}: ${stormDayCount(stormDays, year)} storm days`);
  });
}

main()
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
