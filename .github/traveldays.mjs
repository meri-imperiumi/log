import {
  readFile,
  writeFile,
  readdir,
} from 'fs/promises';
import { resolve, dirname, basename, extname } from 'path';
import { parse, stringify } from 'yaml';
import { FIRST_AUTOMATED_YEAR, solarDate, localDays } from './stormdays.mjs';

const blogDir = '_logs';
const logDir = '_data/logbook';

const journeys = {};

function getLogMeta(name, previous) {
  return readFile(resolve(blogDir, name), 'utf-8')
    .then((content) => {
      const entry = {
        filename: name,
        trackname: name.replace('.md', '.json'),
        from: previous.to,
        to: new Date(basename(name, extname(name))),
        trip: false,
        intermission: false,
      };
      entry.title = entry.to.toLocaleDateString();
      if (content.indexOf('---') === 0) {
        const [front, head, body] = content.split('---');
        const metadata = parse(head);
        if (metadata && metadata.created) {
          entry.to = new Date(metadata.created);
        }
        if (metadata && metadata.title) {
          entry.title = metadata.title;
        }
        if (entry.title.indexOf('Intermission') !== -1) {
          entry.intermission = true;
        }
        if (body.indexOf('Distance today') !== -1) {
          entry.trip = true;
        }
      } else {
        console.log('NO METADATA', name);
      }
      return entry;
    });
}

readdir(logDir)
  .then((files) => {
    const logs = files.filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.yml$/)).sort();
    return logs.reduce((prev, logFile) => {
      return prev.then((content) => {
        return readFile(resolve(logDir, logFile), 'utf-8')
          .then((c) => parse(c))
          .then((data) => {
            return content.concat(data);
          });
      });
    }, Promise.resolve([]));
  })
  .then((logEntries) => {
    // Here we have an array of all log entries since the beginning of time
    // Days are local solar days at the boat's position (UTC offset =
    // longitude / 15), so carry the longitude forward and stamp every
    // entry with the local date it was experienced on
    const lonDates = [];
    const lonValues = [];
    logEntries.slice().sort((a, b) => new Date(a.datetime) - new Date(b.datetime)).forEach((entry) => {
      const p = entry.position;
      const lon = p && (Number.isFinite(p.longitude) ? p.longitude : p.lon);
      if (!Number.isFinite(lon)) {
        return;
      }
      if (lonValues.length && lonValues[lonValues.length - 1] === lon) {
        return;
      }
      lonDates.push(new Date(entry.datetime).getTime());
      lonValues.push(lon);
    });
    const longitudeAt = (instant) => {
      const t = new Date(instant).getTime();
      let lon = 0;
      for (let i = 0; i < lonDates.length; i += 1) {
        if (lonDates[i] <= t) {
          lon = lonValues[i];
        } else {
          break;
        }
      }
      return lon;
    };
    logEntries.forEach((entry) => {
      entry.localDate = solarDate(entry.datetime, longitudeAt(entry.datetime));
    });
    return readdir(blogDir)
      .then((files) => {
        const entries = [];
        return files.reduce((prev, current) => {
          return prev.then((previous) => {
            return getLogMeta(current, previous)
              .then((entry) => {
                entries.push(entry);
                return Promise.resolve(entry);
              });
          });
        }, Promise.resolve({
          to: new Date('2021-08-12T18:48:08+02:00'),
        }))
          .then(() => entries);
      })
      .then((blogEntries) => {
        // From the blog entries we can figure out the start and end dates of each year's cruise
        blogEntries
          .filter((e) => e.trip)
          .forEach((entry) => {
            const year = entry.from.toISOString().substr(0, 4);
            if (!journeys[year]) {
              journeys[year] = {
                start: null,
                end: null,
                travel_days: 0,   // Actual days sailing on the trip
                harbour_days: 0,  // Days spent in harbour not due to storm
                storm_days: 0,    // Days spent in harbout due to storm
                total_days: 0,
              };
            }
            if (!journeys[year].start || entry.from < journeys[year].start) {
              // Should not be earlier than first entry date
              if (!journeys[year].start) {
                journeys[year].start = new Date(entry.to.toISOString().substr(0, 10));
              } else {
                journeys[year].start = entry.from;
              }
            }
            if (entry.to > journeys[year].end) {
              journeys[year].end = entry.to;
            }
          });
        const tripEntries = logEntries
          .filter((entry) => {
            const year = entry.datetime.substr(0, 4);
            if (!journeys[year]) {
              return false;
            }
            const date = new Date(entry.datetime);
            if (date < journeys[year].start) {
              return false;
            }
            if (date > journeys[year].end) {
              return false;
            }
            return true;
          });
        // Start iterating through the days of this trip. Days are
        // local solar days at the boat's position.
        Object
          .keys(journeys)
          .forEach((year) => {
            const journey = journeys[year];
            localDays(journey.start, journey.end, longitudeAt).forEach((dayString) => {
              journey.total_days += 1;
              // Filter log entries to just this local day
              const dayEntries = tripEntries
                .filter((entry) => entry.localDate === dayString)
                .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
              // Distance covered during the local day, from log reading
              // deltas (club rule: a Reisetag requires leaving the
              // harbour and covering at least 5 nm)
              let dayDistance = 0;
              for (let i = 1; i < dayEntries.length; i += 1) {
                const distance = dayEntries[i].log - dayEntries[i - 1].log;
                if (distance > 0 && !Number.isNaN(distance)) {
                  dayDistance += distance;
                }
              }
              // Now we can use the entries to figure out if this was a sailing day
              const navEntries = dayEntries
                .filter((e) => e.category === 'navigation');
              if (navEntries.length > 0 && dayDistance >= 5) {
                journey.travel_days += 1;
              } else {
                // For the legacy trips pre-2023, we should also check if there is a trip log entry for the day as the logbook data is not 100%
                const dayTripBlog = blogEntries
                  .filter((e) => {
                    if (!e.trip) {
                      return false;
                    }
                    if (e.to.toISOString().substr(0, 10) !== dayString) {
                      return false;
                    }
                    return true;
                  });
                if (dayTripBlog.length > 0) {
                  journey.travel_days += 1;
                } else {
                  journey.harbour_days += 1;
                }
              }
            });
          });
        return journeys;
      });
  })
  .then((journeys) => {
  return Promise.all([
    readFile('_data/year_stats.yml', 'utf-8'),
    readFile('_data/storm_days.yml', 'utf-8').catch((err) => {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      return '';
    }),
  ]);
})
    .then(([yearStatsContent, stormDaysContent]) => {
      const storedYearStats = parse(yearStatsContent);
      const automatedStormDays = parse(stormDaysContent) || {};
        Object
          .keys(journeys)
          .forEach((year) => {
            if (!storedYearStats[year]) {
              storedYearStats[year] = {};
            }
            Object
              .keys(journeys[year])
              .forEach((key) => {
                if (key === 'storm_days') {
                  // From FIRST_AUTOMATED_YEAR onwards the storm days
                  // are counted automatically from _data/storm_days.yml,
                  // before that they were entered manually
                  if (year >= FIRST_AUTOMATED_YEAR) {
                    storedYearStats[year][key] = (automatedStormDays[year] || []).length;
                  } else {
                    storedYearStats[year][key] = storedYearStats[year][key] || 0;
                  }
                  return;
                }
                storedYearStats[year][key] = journeys[year][key];
              });
            if (storedYearStats[year].storm_days) {
              storedYearStats[year].harbour_days -= storedYearStats[year].storm_days;
            }
          });
        return writeFile('_data/year_stats.yml', stringify(storedYearStats));
      })
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
