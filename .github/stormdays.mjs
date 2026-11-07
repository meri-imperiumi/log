// Count storm days for the club cruising competition automatically.
//
// Club rule: "Sturmtage sind Tage, an denen die Yacht den jeweiligen
// Hafen oder Ankerplatz aufgrund von Starkwind(-warnungen) nicht
// verlässt." Approximated as: a harbour day (no navigation category
// entries in the logbook for that day, mirroring traveldays.mjs, i.e.
// the boat stayed put) where wind was forecast to gust over
// STORM_GUST_KN.
//
// Days are local solar days at the boat's position (UTC offset =
// longitude / 15), not UTC days: the boat cruises across many
// timezones and the club counts the days as experienced locally.
//
// Forecast wind, gusts and CAPE come from the Open-Meteo historical
// forecast API, which serves the forecast data as it was actually
// published at the time
// (https://open-meteo.com/en/docs/historical-forecast-api).
// The decision to stay is made on forecasts, so the archived forecast
// is the authoritative signal, not the (usually much lower) measured
// wind in a sheltered anchorage. CAPE is recorded for context, but
// archived model CAPE does not reliably capture the Baltic
// thunderstorms, so it does not influence the count.
//
// The storm days are listed in _data/storm_days.yml, from where
// traveldays.mjs reads the per-year counts (for years from
// FIRST_AUTOMATED_YEAR onwards). Days already listed are never
// re-fetched, so a daily run only queries the harbour days since the
// previous run. Days whose forecast is not published yet are simply
// picked up on a later run.
//
// Manual entries are welcome in the same file, for storms remembered
// but not visible in the data. Give them basis: 'manual' and an
// optional note; automatic runs never modify or remove them, only
// append their own records, and traveldays.mjs counts every record in
// the year's list. Example:
//
// - date: 2026-08-21
//   state: moored
//   basis: manual
//   note: sat out trade-wind surge at Aitutaki
import {
  readFile,
  writeFile,
  readdir,
} from 'fs/promises';
import { parse, stringify } from 'yaml';

const OPEN_METEO_URL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
export const STORM_GUST_KN = 30;
export const FIRST_AUTOMATED_YEAR = '2025';

function dayString(date) {
  return date.toISOString().substr(0, 10);
}

// Local solar day at the given longitude: the boat logs in UTC, but
// the day it experienced is shifted by longitude/15 hours.
export function solarDate(datetime, longitude) {
  const offsetMs = ((longitude || 0) / 15) * 3600000;
  return new Date(new Date(datetime).getTime() + offsetMs).toISOString().substr(0, 10);
}

function getLongitude(position) {
  if (!position) {
    return null;
  }
  const longitude = Number.isFinite(position.longitude) ? position.longitude : position.lon;
  return Number.isFinite(longitude) ? longitude : null;
}

function getPosition(entry) {
  const p = entry.position;
  if (!p) {
    return null;
  }
  const latitude = Number.isFinite(p.latitude) ? p.latitude : p.lat;
  const longitude = getLongitude(p);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return { latitude, longitude };
}

// Which kind of harbour the trip ended in, from the auto-generated
// trip end entries: "Anchored" (navigation.state -> anchored) vs
// "Stopped" (navigation.state -> moored). Carried forward across the
// days the boat stays put.
function harbourType(entry) {
  if (entry.end !== true) {
    return null;
  }
  const text = String(entry.text || '').toLowerCase();
  if (text.indexOf('anchor') !== -1) {
    return 'anchored';
  }
  if (text.indexOf('stopped') !== -1 || text.indexOf('moored') !== -1) {
    return 'moored';
  }
  return null;
}

// Carries values from log entries forward in time: for each entry
// datetime where something changes, remember the latest known values.
// Later dates inherit everything from earlier ones. The lookup is
// stateless (binary search over the change dates).
function carryChain(sorted, valueFor) {
  const dates = [];
  const values = [];
  sorted.forEach((entry) => {
    const value = valueFor(entry);
    const change = value.position !== undefined || value.type !== undefined;
    if (!change) {
      return;
    }
    const previous = values.length ? values[values.length - 1] : null;
    const merged = {
      position: value.position !== undefined ? value.position : previous && previous.position,
      type: value.type !== undefined ? value.type : previous && previous.type,
    };
    const date = dayString(new Date(entry.datetime));
    const sameDay = dates.length && dates[dates.length - 1] === date;
    if (sameDay) {
      values[values.length - 1] = merged;
    } else {
      dates.push(date);
      values.push(merged);
    }
  });
  const dateTimes = dates.map((date) => new Date(`${date}T00:00:00Z`).getTime());
  return (datetime) => {
    const t = new Date(datetime).getTime();
    let lo = 0;
    let hi = dates.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dateTimes[mid] <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found === -1 ? null : values[found];
  };
}

// The local solar days lived between two instants, based on the
// longitude at each moment. Sampled in 12h steps; around the
// antimeridian a calendar date can be skipped entirely, which simply
// never comes out of the sampling.
export function localDays(start, end, longitudeAt) {
  const dates = [];
  const step = 12 * 3600000;
  const last = new Date(end).getTime() - 1;
  for (let t = new Date(start).getTime(); t <= last; t += step) {
    const date = solarDate(t, longitudeAt(t));
    if (!dates.length || dates[dates.length - 1] !== date) {
      dates.push(date);
    }
  }
  return dates;
}

// Walks the logbook entries chronologically and produces the harbour
// days (days without any navigation category entries, mirroring
// traveldays.mjs) within the given journeys. Most harbour days have no
// log entries at all, so the last known boat position and the harbour
// type are carried forward from the entries preceding each day. Only
// journeys from fromYear (defaults to FIRST_AUTOMATED_YEAR) are
// classified; earlier years can be passed in for retropective
// analysis.
export function harbourDays(entries, journeys, fromYear = FIRST_AUTOMATED_YEAR) {
  const years = Object.keys(journeys).filter((year) => year >= fromYear).sort();
  const sorted = entries.slice().sort((a, b) => {
    return new Date(a.datetime) - new Date(b.datetime);
  });
  const carry = carryChain(sorted, (entry) => {
    const value = {};
    const position = getPosition(entry);
    if (position) {
      value.position = position;
    }
    const type = harbourType(entry);
    if (type) {
      value.type = type;
    }
    return value;
  });
  const longitudeAt = (datetime) => {
    const carried = carry(datetime);
    return carried && carried.position ? carried.position.longitude : 0;
  };
  const entriesByDay = new Map();
  sorted.forEach((entry) => {
    const date = solarDate(entry.datetime, longitudeAt(entry.datetime));
    if (!entriesByDay.has(date)) {
      entriesByDay.set(date, []);
    }
    entriesByDay.get(date).push(entry);
  });
  const days = [];
  years.forEach((year) => {
    const journey = journeys[year];
    if (!journey || !journey.start || !journey.end) {
      return;
    }
    localDays(journey.start, journey.end, longitudeAt).forEach((date) => {
      const dayEntries = entriesByDay.get(date) || [];
      const hasNavigation = dayEntries.some((e) => e.category === 'navigation');
      // Mirror traveldays.mjs: a day is a harbour day when the boat
      // did not leave (no navigation entries), or moved less than the
      // 5 nm a Reisetag requires — re-anchoring in the same spot does
      // not mean the boat left
      let dayDistance = 0;
      for (let i = 1; i < dayEntries.length; i += 1) {
        const distance = dayEntries[i].log - dayEntries[i - 1].log;
        if (distance > 0 && Number.isFinite(distance)) {
          dayDistance += distance;
        }
      }
      const isHarbour = !hasNavigation || dayDistance < 5;
      if (!isHarbour) {
        return;
      }
      // Position and harbour type as of the end of this local day:
      // where the boat slept that night (captures same-day arrivals)
      const dayEnd = new Date(`${date}T00:00:00Z`).getTime() + 24 * 3600000;
      const carried = carry(new Date(dayEnd - 1));
      days.push({
        year,
        date,
        position: carried && carried.position,
        state: carried && carried.type,
      });
    });
  });
  return days;
}

// Groups consecutive harbour days parked at the same spot so that a
// single Open-Meteo request covers the whole stretch.
export function groupStretch(days) {
  const stretches = [];
  days.forEach((day) => {
    if (!day.position) {
      return;
    }
    const key = `${day.year}-${day.position.latitude.toFixed(2)}-${day.position.longitude.toFixed(2)}`;
    const last = stretches[stretches.length - 1];
    if (last && last.key === key) {
      last.days.push(day);
    } else {
      stretches.push({
        key,
        position: day.position,
        days: [day],
      });
    }
  });
  return stretches;
}

// Fetches hourly forecast wind (kn), gusts (kn) and CAPE (J/kg) for a
// position over a date range (UTC). Returns an array of
// { time, wind, gust, cape } rows. Retries on transient failures.
export async function fetchWeather(position, startDate, endDate) {
  const url = `${OPEN_METEO_URL}?latitude=${position.latitude}&longitude=${position.longitude}&start_date=${startDate}&end_date=${endDate}&hourly=wind_speed_10m,wind_gusts_10m,cape&wind_speed_unit=kn&timezone=UTC`;
  const delays = [0, 3000, 8000, 15000];
  let data;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) {
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      data = await res.json();
      break;
    } catch (err) {
      if (attempt === delays.length - 1) {
        throw err;
      }
    }
  }
  const times = data.hourly && data.hourly.time;
  const winds = data.hourly && data.hourly.wind_speed_10m;
  const gusts = data.hourly && data.hourly.wind_gusts_10m;
  const capes = data.hourly && data.hourly.cape;
  const rows = [];
  if (!Array.isArray(times) || !Array.isArray(gusts)) {
    return rows;
  }
  times.forEach((time, i) => {
    rows.push({
      time: new Date(`${time}Z`).getTime(),
      wind: Number.isFinite(winds && winds[i]) ? winds[i] : 0,
      gust: Number.isFinite(gusts && gusts[i]) ? gusts[i] : 0,
      cape: Number.isFinite(capes && capes[i]) ? capes[i] : 0,
    });
  });
  return rows;
}

// Maxima over the local solar day, from hourly rows covering the
// window in UTC.
export function dayMaxima(rows, date, longitude) {
  const offsetMs = (longitude / 15) * 3600000;
  const start = new Date(`${date}T00:00:00Z`).getTime() - offsetMs;
  const end = start + 24 * 3600000;
  const inDay = rows.filter((row) => row.time >= start && row.time < end);
  if (!inDay.length) {
    return null;
  }
  return {
    wind: Math.max(...inDay.map((r) => r.wind)),
    gust: Math.max(...inDay.map((r) => r.gust)),
    cape: Math.max(...inDay.map((r) => r.cape)),
  };
}

// Main computation: given the logbook entries, journey year boundaries,
// already recorded storm days and a weather fetcher, returns the new
// complete storm day listing. fromYear can classify earlier years for
// retrospective reference data (their counts stay manual in
// traveldays.mjs).
export async function computeStormDays(entries, journeys, existing, fetchWeatherFor, fromYear = FIRST_AUTOMATED_YEAR) {
  const days = harbourDays(entries, journeys, fromYear);
  const recorded = new Set();
  Object.keys(existing).forEach((year) => {
    (existing[year] || []).forEach((record) => {
      recorded.add(record.date);
    });
  });
  const unchecked = days.filter((day) => !recorded.has(day.date));
  const stormDays = JSON.parse(JSON.stringify(existing));
  const stretches = groupStretch(unchecked);
  for (const stretch of stretches) {
    // Widen the UTC date range so every local solar day window is
    // covered
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
    let rows;
    try {
      rows = await fetchWeatherFor(stretch.position, first, last);
    } catch (err) {
      console.error(`Open-Meteo fetch failed for ${first}..${last}: ${err.message}`);
      continue;
    }
    stretch.days.forEach((day) => {
      const maxima = dayMaxima(rows, day.date, day.position.longitude);
      if (!maxima || !Number.isFinite(maxima.gust)) {
        // Forecast not published yet for this day, try again on a
        // later run
        return;
      }
      if (maxima.gust > STORM_GUST_KN) {
        if (!stormDays[day.year]) {
          stormDays[day.year] = [];
        }
        stormDays[day.year].push({
          date: day.date,
          state: day.state || 'unknown',
          wind_kn: parseFloat(maxima.wind.toFixed(1)),
          gust_kn: parseFloat(maxima.gust.toFixed(1)),
          cape: Math.round(maxima.cape),
          latitude: parseFloat(day.position.latitude.toFixed(4)),
          longitude: parseFloat(day.position.longitude.toFixed(4)),
        });
      }
    });
  }
  Object.keys(stormDays).forEach((year) => {
    stormDays[year].sort((a, b) => (a.date < b.date ? -1 : 1));
  });
  return stormDays;
}

export function stormDayCount(stormDays, year) {
  return (stormDays[year] || []).length;
}

function main() {
  return Promise.all([
    readdir('_data/logbook'),
    readFile('_data/year_stats.yml', 'utf-8'),
    readFile('_data/storm_days.yml', 'utf-8').catch((err) => {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      return '';
    }),
  ])
    .then(async ([files, yearStatsContent, stormDaysContent]) => {
      const journeys = parse(yearStatsContent);
      const existing = parse(stormDaysContent) || {};
      const logs = files.filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.yml$/)).sort();
      const entries = [].concat(...(await Promise.all(logs.map((logFile) => {
        return readFile(`_data/logbook/${logFile}`, 'utf-8').then((c) => parse(c));
      }))));
      const stormDays = await computeStormDays(entries, journeys, existing, fetchWeather);
      Object.keys(stormDays).forEach((year) => {
        console.log(`${year}: ${stormDayCount(stormDays, year)} storm days`);
      });
      return writeFile('_data/storm_days.yml', stringify(stormDays));
    });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
    .then(() => {
      console.log('Done');
      process.exit(0);
    })
    .catch((err) => {
      console.log(err);
      process.exit(1);
    });
}
