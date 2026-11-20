import {
  readFile,
  writeFile,
  readdir,
} from 'fs/promises';
import { parse, stringify } from 'yaml';

// Engine miles classification, tuned against Signal K navigation.state
// ground truth. Key points:
// - The logbook plugin timestamps auto-generated entries at the exact
//   state transition, so an interval is bucketed by the state carried
//   INTO it (state after the previous entry), not by the state
//   announced at its end.
// - "Motorsailing" counts as motoring mileage-wise. The word contains
//   "sailing", so it is checked first.
// - "Sails set: X" is only emitted by the logbook plugin while
//   navigation.state is sailing, so it resets to sailing.
// - When engine.hours is known at both ends of an interval and did not
//   advance, the engine was demonstrably off: bucket as sailing even
//   when the keyword state says motoring. This protects against
//   hand-edited entries leaving stale state behind. Engine hours
//   advancing without keyword support (weekly engine warm-up runs
//   while hove to, charging while sailing) is NOT bucketed as
//   motoring, matching navigation.state for those periods.
function isMotoringText(text) {
  const t = String(text || '').toLowerCase();
  if (t.indexOf('motorsailing') !== -1
    || t.indexOf('motor sailing') !== -1
    || t.indexOf('motor-sailing') !== -1) {
    return true;
  }
  if (t.indexOf('sailing') !== -1) {
    return false;
  }
  if (t.indexOf('sails set') !== -1) {
    return false;
  }
  if (t.indexOf('motoring') !== -1) {
    return true;
  }
  return null;
}

// Sail-change parsing, adapted from the signalk-passage-briefing
// backfill tooling (plugin/logbook-source.js). The logbook plugin
// announces sail states in the entry text as:
// - `Sails set: Main (1st reef), Genoa 1 (20% furled)` — change while sailing;
// - `Sailing with Main, Genoa 1` / `Motorsailing with Main` — session start;
// - `Motor stopped, sailing with Main` — motor-stop snapshot, not an action;
// - `Sails down, motoring` (also `… motor on`, `… and motor on`) — bare poles.
// Hand-edited entries put these mid-line or multiline and append free
// text after the sail list, so matching runs per line and the list is
// cut at the first period. Only sail identity matters here, so
// parenthetical reef/furl annotations are dropped and components are
// matched against the boat's inventory instead of trusting fragments.
// A displayed `cone` day marker is not a sail: it signals motorsailing,
// which in turn means the mainsail is up.
const SAIL_CHANGE_RE = /^(?:sails set:|sailing with|motorsailing with)\s+(.*)$/i;
const SAIL_STATE_RE = /^motor stopped, sailing with\s+(.*)$/i;
const SAILS_DOWN_RE = /\bsails down\b/i;
const CONE_DAYMARK_RE = /\bcone\b/i;

// The boat's sail inventory, keyed by lowercased name variants.
const SAIL_ALIASES = {
  main: 'Main',
  'genoa 1': 'Genoa 1',
  staysail: 'Staysail',
  parasailor: 'Parasailor',
};

/**
 * Parses the canonical sail names out of a sail list, ignoring
 * parenthetical reef/furl annotations and trailing free text. Unknown
 * words (manual prose) are skipped; a known name may be followed by
 * prose within the same comma component.
 */
function parseSailNames(list) {
  // Cut at the first period — manually appended notes follow as sentences.
  const dot = list.indexOf('.');
  const trimmed = dot !== -1 ? list.slice(0, dot) : list;
  const names = [];
  const seen = {};
  trimmed
    .replace(/\([^)]*\)/g, ' ')
    .split(',')
    .forEach((part) => {
      const words = part.trim().toLowerCase().split(/\s+/);
      for (let i = 0; i < words.length; i++) {
        const phrase = words[i + 1] ? `${words[i]} ${words[i + 1]}` : words[i];
        const name = SAIL_ALIASES[phrase] || SAIL_ALIASES[words[i]];
        if (!name) {
          continue;
        }
        if (!seen[name]) {
          seen[name] = true;
          names.push(name);
        }
        if (name === SAIL_ALIASES[phrase]) {
          i += 1;
        }
      }
    });
  return names;
}

/**
 * Extracts the sail state announced by an entry: an array of canonical
 * sail names (empty for bare poles), or null when the entry announces
 * nothing sail-related so the previous state carries over.
 */
function parseSailState(text) {
  const lines = String(text || '').split(/\r?\n/);
  let state = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (SAILS_DOWN_RE.test(line)) {
      state = [];
    }
    const change = SAIL_CHANGE_RE.exec(line) || SAIL_STATE_RE.exec(line);
    if (change) {
      const names = parseSailNames(change[1]);
      if (names.length) {
        state = names;
        continue;
      }
    }
    if (CONE_DAYMARK_RE.test(line)) {
      // Cone day marker up: motorsailing, mainsail is up
      state = [SAIL_ALIASES.main];
    }
  }
  return state;
}

export function milesFromEntries(entries) {
  const crewMiles = {
    nissinen: 0,
    starbuck: 0,
  };
  const yearMiles = {};
  const sailMiles = {
    sails: {},
    years: {},
  };
  let previous = null;
  let sails = [];
  let nissinen = false;
  let previousNissinen = false;
  let starbuck = false;
  let previousStarbuck = false;
  let motoring = false;
  entries.forEach((entry) => {
    if (entry.text.indexOf('Autopilot activated') !== -1) {
      // If we activate autopilot, we definitely deactivate windvane
      previousNissinen = nissinen;
      nissinen = true;
      previousStarbuck = starbuck;
      starbuck = false;
    }
    if (entry.text.toLowerCase().indexOf('windvane') !== -1) {
      // We assume that windvane mentions mean activation
      previousStarbuck = starbuck;
      starbuck = true;
    }
    if (entry.text.toLowerCase().indexOf('hand steering') !== -1) {
      // Hand steering means no windvane
      previousStarbuck = starbuck;
      starbuck = false;
    }
    if (entry.text.indexOf('Autopilot deactivated') !== -1) {
      // Autopilot deactivation doesn't automatically imply windvane activation
      previousNissinen = nissinen;
      nissinen = false;
    }
    if (entry.text.toLowerCase().indexOf('motoring') !== -1) {
      // Windvane can't be used while motoring
      previousStarbuck = starbuck;
      starbuck = false;
    }
    const motoringAtIntervalStart = motoring;
    const sailsAtIntervalStart = sails;
    const motoringText = isMotoringText(entry.text);
    if (motoringText !== null) {
      motoring = motoringText;
    }
    const announcedSails = parseSailState(entry.text);
    if (announcedSails !== null) {
      sails = announcedSails;
    } else {
      // Motoring without a sail announcement means bare poles. Pure
      // motorsailing keeps whatever is set, matching isMotoringText.
      const t = String(entry.text || '').toLowerCase();
      const motorsailing = t.indexOf('motorsailing') !== -1
        || t.indexOf('motor sailing') !== -1
        || t.indexOf('motor-sailing') !== -1;
      if (motoringText === true && !motorsailing) {
        sails = [];
      }
    }
    if (entry.end) {
      // When trip ends we don't use either any longer
      previousNissinen = nissinen;
      nissinen = false;
      previousStarbuck = starbuck;
      starbuck = false;
      motoring = false;
      sails = [];
    }

    if (!previous) {
      previous = entry;
      return;
    }
    const distance = entry.log - previous.log;
    if (distance <= 0 || Number.isNaN(distance)) {
      previous = entry;
      return;
    }
    if (entry.crewNames && entry.crewNames.length) {
      entry.crewNames.forEach((name) => {
        let nameToUse = name;
        if (name === 'ihmis-suski') {
          nameToUse = 'suski';
        }
        if (!crewMiles[nameToUse]) {
          crewMiles[nameToUse] = 0;
        }
        crewMiles[nameToUse] += distance;
      });
    }
    if (nissinen || previousNissinen) {
      crewMiles.nissinen += distance;
      previousNissinen = nissinen;
    }
    if (starbuck || previousStarbuck) {
      crewMiles.starbuck += distance;
      previousStarbuck = starbuck;
    }
    const prevHours = previous.engine && previous.engine.hours;
    const hours = entry.engine && entry.engine.hours;
    const engineOff = Number.isFinite(prevHours)
      && Number.isFinite(hours)
      && hours - prevHours <= 0.05;
    const bucket = engineOff || !motoringAtIntervalStart ? 'sailing' : 'motoring';
    const year = String(entry.datetime).substr(0, 4);
    if (year) {
      if (!yearMiles[year]) {
        yearMiles[year] = {
          motoring: 0,
          sailing: 0,
          total: 0,
        };
      }
      yearMiles[year].total += distance;
      yearMiles[year][bucket] += distance;
    }
    // Sail miles are credited to the sail set carried INTO an interval
    // (the state after the previous entry) whenever that set is known,
    // regardless of the motoring bucket: motorsailing still wears the
    // sails it has up, and so does the stretch before the motor-stop
    // entry is logged. Plain motoring clears the set (bare poles), so
    // engine-only mileage credits nothing.
    if (sailsAtIntervalStart.length) {
      const hours = (new Date(entry.datetime).getTime()
        - new Date(previous.datetime).getTime()) / 3600000;
      sailsAtIntervalStart.forEach((sail) => {
        if (!sailMiles.sails[sail]) {
          sailMiles.sails[sail] = {
            miles: 0,
            hours: 0,
          };
        }
        sailMiles.sails[sail].miles += distance;
        if (Number.isFinite(hours)) {
          sailMiles.sails[sail].hours += hours;
        }
        if (year) {
          if (!sailMiles.years[year]) {
            sailMiles.years[year] = {};
          }
          if (!sailMiles.years[year][sail]) {
            sailMiles.years[year][sail] = {
              miles: 0,
              hours: 0,
            };
          }
          sailMiles.years[year][sail].miles += distance;
          if (Number.isFinite(hours)) {
            sailMiles.years[year][sail].hours += hours;
          }
        }
      });
    }
    previous = entry;
  });
  return {
    crewMiles,
    yearMiles,
    sailMiles,
  };
}

function main() {
  return readdir('_data/logbook')
    .then((files) => {
      const logs = files.filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.yml$/)).sort();
      return Promise.all(logs.map((logFile) => {
        return readFile(`_data/logbook/${logFile}`, 'utf-8')
          .then((c) => parse(c));
      }));
    })
    .then((logEntries) => milesFromEntries([].concat(...logEntries)))
    .then(({ crewMiles, yearMiles, sailMiles }) => {
      return readFile('_data/crew_miles.yml', 'utf-8')
        .then((c) => parse(c))
        .then((data) => {
          Object.keys(data).forEach((name) => {
            if (!crewMiles[name]) {
              data[name].miles_from_logger = 0;
              return;
            }
            data[name].miles_from_logger = parseFloat(crewMiles[name].toFixed(1)) || 0;
          });
          return data;
        })
        .then((updatedCrew) => {
          return writeFile('_data/crew_miles.yml', stringify(updatedCrew))
            .then(() => ({ yearMiles, sailMiles }));
        });
    })
    .then(({ yearMiles, sailMiles }) => readFile('_data/year_miles.yml', 'utf-8').then((c) => parse(c)).then((storedYearMiles) => ({ yearMiles, storedYearMiles, sailMiles })))
    .then(({ yearMiles, storedYearMiles, sailMiles }) => {
      Object.keys(yearMiles).forEach((year) => {
        storedYearMiles[year] = {};
        storedYearMiles[year].total = parseFloat(yearMiles[year].total.toFixed(1)) || 0;
        storedYearMiles[year].motoring = parseFloat(yearMiles[year].motoring.toFixed(1)) || 0;
        storedYearMiles[year].sailing = parseFloat(yearMiles[year].sailing.toFixed(1)) || 0;
      });
      return writeFile('_data/year_miles.yml', stringify(storedYearMiles))
        .then(() => ({ sailMiles }));
    })
    .then(({ sailMiles }) => {
      const sailData = {};
      Object.keys(sailMiles.sails).sort().forEach((sail) => {
        const total = sailMiles.sails[sail];
        const years = {};
        Object.keys(sailMiles.years).sort().forEach((yearKey) => {
          const yearly = sailMiles.years[yearKey][sail];
          if (!yearly) {
            return;
          }
          years[yearKey] = {
            miles: parseFloat(yearly.miles.toFixed(1)) || 0,
            hours: parseFloat(yearly.hours.toFixed(1)) || 0,
          };
        });
        sailData[sail] = {
          miles: parseFloat(total.miles.toFixed(1)) || 0,
          hours: parseFloat(total.hours.toFixed(1)) || 0,
          years,
        };
      });
      return writeFile('_data/sail_miles.yml', stringify(sailData));
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
