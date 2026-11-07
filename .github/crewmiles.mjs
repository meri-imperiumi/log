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

export function milesFromEntries(entries) {
  const crewMiles = {
    nissinen: 0,
    starbuck: 0,
  };
  const yearMiles = {};
  let previous = null;
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
    const motoringText = isMotoringText(entry.text);
    if (motoringText !== null) {
      motoring = motoringText;
    }
    if (entry.end) {
      // When trip ends we don't use either any longer
      previousNissinen = nissinen;
      nissinen = false;
      previousStarbuck = starbuck;
      starbuck = false;
      motoring = false;
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
    previous = entry;
  });
  return {
    crewMiles,
    yearMiles,
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
    .then(({ crewMiles, yearMiles }) => {
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
            .then(() => yearMiles);
        });
    })
    .then((yearMiles) => readFile('_data/year_miles.yml', 'utf-8').then((c) => parse(c)).then((storedYearMiles) => ({ yearMiles, storedYearMiles })))
    .then(({ yearMiles, storedYearMiles }) => {
      Object.keys(yearMiles).forEach((year) => {
        storedYearMiles[year] = {};
        storedYearMiles[year].total = parseFloat(yearMiles[year].total.toFixed(1)) || 0;
        storedYearMiles[year].motoring = parseFloat(yearMiles[year].motoring.toFixed(1)) || 0;
        storedYearMiles[year].sailing = parseFloat(yearMiles[year].sailing.toFixed(1)) || 0;
      });
      return writeFile('_data/year_miles.yml', stringify(storedYearMiles));
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
