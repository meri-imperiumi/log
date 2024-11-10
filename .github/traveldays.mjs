import {
  readFile,
  writeFile,
  readdir,
} from 'fs/promises';
import { resolve, dirname, basename, extname } from 'path';
import { parse, stringify } from 'yaml';

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
    const logs = files.filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.yml$/));
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
        // Start iterating through the days of this trip
        Object
          .keys(journeys)
          .forEach((year) => {
            const journey = journeys[year];
            let day = new Date(journey.start.toISOString());
            while (day < journey.end) {
              const dayString = day.toISOString().substr(0, 10);
              journey.total_days += 1;
              // Filter log entries to just this day
              const dayEntries = tripEntries
                .filter((entry) => {
                  const entryDayString = entry.datetime.substr(0, 10);
                  if (entryDayString !== dayString) {
                    return false;
                  }
                  return true;
                });
              // Now we can use the entries to figure out if this was a sailing day
              const navEntries = dayEntries
                .filter((e) => e.category === 'navigation');
              if (navEntries.length > 0) {
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

              // Go to next day
              day.setDate(day.getDate() + 1);
            }
          });
        return journeys;
      });
  })
  .then((journeys) => {
    return readFile('_data/year_stats.yml', 'utf-8')
      .then((c) => parse(c));
  })
      .then((storedYearStats) => {
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
                  // These are entered manually
                  storedYearStats[year][key] = storedYearStats[year][key] || 0;
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
