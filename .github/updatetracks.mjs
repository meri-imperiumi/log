import { readFile, writeFile, readdir } from 'fs/promises';
import { resolve, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { parse, stringify } from 'yaml';
import { Point } from 'where';
// import fetch from 'node-fetch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logDir = resolve(__dirname, '../_logs');
const trackDir = resolve(__dirname, '../tracks');
const startOfHistory = new Date('2022-01-10');

function parseHead(head) {
  try {
    return parse(head);
  } catch (e) {
    if (head.indexOf('position:') !== -1) {
      // Likely a position object GitJournal messed up
      const withoutPos = head.split('position:')[0];
      return parse(withoutPos);
    }
    throw e;
  }
}

function getLogMeta(name, previous) {
  return readFile(resolve(logDir, name), 'utf-8')
    .then((content) => {
      const entry = {
        filename: name,
        trackname: name.replace('.md', '.json'),
        from: previous.to,
        to: new Date(basename(name, extname(name))),
        trip: false,
        intermission: false,
        position: null,
      };
      entry.title = entry.to.toLocaleDateString();
      if (content.indexOf('---') === 0) {
        const [front, head, body] = content.split('---');
        const metadata = parseHead(head);
        if (metadata && metadata.created) {
          entry.to = new Date(metadata.created);
        }
        if (metadata && metadata.title) {
          entry.title = metadata.title;
        }
        if (metadata && metadata.position) {
          if (Number.isFinite(metadata.position.lat)) {
            entry.position = metadata.position;
          } else {
            delete metadata.position;
          }
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

function ensurePositionMeta(entry, trackName) {
  if (trackName === 'current.json') {
    return Promise.resolve();
  }
  return readFile(resolve(trackDir, trackName), 'utf-8')
    .then((trackData) => JSON.parse(trackData))
    .catch((e) => {
      // Missing or corrupt track file, nothing to update
      console.error(`Cannot read track ${trackName}: ${e.message}`);
      return Promise.resolve();
    })
    .then((track) => {
      if (!track || !track.coordinates) {
        // No track for this entry
        return Promise.resolve();
      }
      const lastSegment = track.coordinates[track.coordinates.length - 1];
      if (!lastSegment) {
        return Promise.resolve();
      }
      const [lon, lat] = lastSegment[lastSegment.length - 1];
      if (entry.position
        && entry.position.lat === lat && entry.position.lon === lon) {
        // Unchanged last position
        return Promise.resolve();
      }
      entry.position = {
        lon,
        lat,
      };
      return readFile(resolve(logDir, entry.filename), 'utf-8')
        .then((content) => {
          if (content.indexOf('---') !== 0) {
            // No front matter, skip
            return Promise.resolve();
          }
          const [front, head, body] = content.split('---');
          const metadata = parseHead(head);
          metadata.position = {
            ...entry.position,
          };
          const updatedHead = stringify(metadata);
          if (updatedHead.indexOf('position: \'{') !== -1) {
            // For some reason we weren't able to encode position correctly, skip
            return Promise.resolve();
          }
          const updatedContent = `---\n${updatedHead}---${body}`;
          return writeFile(resolve(logDir, entry.filename), updatedContent);
        });
    });
}

const signalKUrl = 'http://192.168.2.105';
const historyResolutionSeconds = 180;

// Reads the vessel track for an exact time window from the Signal K
// History API (no auth needed) and shapes it like the old tracks plugin
// response, so the cleanup and position update steps work the same as
// before. Sampled per resolution tick to keep responses sane; the
// distance filter below then removes anchor sway and jumps.
function fetchHistoryTrack(from, to) {
  const url = `${signalKUrl}/signalk/v2/api/history/values?paths=navigation.position&from=${from.toISOString()}&to=${to.toISOString()}&resolution=${historyResolutionSeconds}`;
  return fetch(url)
    .then((r) => {
      if (!r.ok) {
        throw new Error(`${r.status} ${r.statusText}`);
      }
      return r.json();
    })
    .then((history) => {
      const points = (history.data || [])
        .map((row) => row[1])
        .filter((point) => Array.isArray(point)
          && Number.isFinite(point[0])
          && Number.isFinite(point[1]));
      if (points.length === 0) {
        console.error('History API returned no position samples');
        return null;
      }
      console.log(`History API gave ${points.length} position samples`);
      return {
        type: 'MultiLineString',
        coordinates: [points],
      };
    });
}

function ensureTrack(entry, tracks) {
  const trackName = entry.trackname;
  if (tracks.indexOf(trackName) !== -1) {
    // We already have a track for this one
    return ensurePositionMeta(entry, trackName);
  }
  if (entry.to < startOfHistory) {
    // We don't have a Signal K track reaching this far back
    return Promise.resolve();
  }
  if (!entry.trip) {
    // This entry isn't for a trip
    return Promise.resolve();
  }
  if (entry.intermission) {
    // Here we don't look for "intermission" posts since they're not in SK history
    return Promise.resolve();
  }
  return fetchHistoryTrack(entry.from, entry.to)
    .catch((e) => {
      console.error(`History API fetch failed: ${e.message}`);
      return null;
    })
    .then((geoJson) => {
      if (!geoJson || !geoJson.coordinates) {
        console.error(`No track data returned for ${trackName}, not writing`);
        return null;
      }
      // Clean up the track to remove 'anchor sway' etc
      if (!geoJson.coordinates[0]) {
        return geoJson;
      }
      const newData = {...geoJson};
      newData.coordinates = [newData.coordinates.reduce((points, curr) => {
        return points.concat(curr);
      }, [])];
      let prevPoint = null;
      newData.coordinates[0] = newData.coordinates[0].filter((coord) => {
        if (!coord) {
          return false;
        }
        const point = new Point(coord[1], coord[0]);
        if (!prevPoint) {
          prevPoint = point;
          return true;
        }
        const distance = prevPoint.distanceTo(point);
        if (distance < 0.005) {
          // console.log('SHORT', distance, prevPoint, point);
          return false;
        }
        if (distance > 200) {
          // console.log('LONG', distance, prevPoint, point);
          return false;
        }
        prevPoint = point;
        return true;
      });
      return newData;
    })
    .then((geoJson) => {
      if (!geoJson || !geoJson.coordinates[0] || geoJson.coordinates[0].length === 0) {
        // No usable data; leave the track absent so it is retried on
        // the next run
        return Promise.resolve();
      }
      return writeFile(resolve(trackDir, trackName), JSON.stringify(geoJson, null, 2))
        .then(() => {
          return ensurePositionMeta(entry, trackName);
        });
    });
}

function main() {
  return readdir(logDir)
  .then((names) => {
    // For each [b]log entry we need to find out:
    // - Is it an entry with distance (aka. a trip blog)
    // - The exact publication time
    // We need to do this in order to know the previous timestamp
    // so we have a time window
    const entries = [];
    return names.reduce((prev, current) => {
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
  .then((entries) => {
    return readdir(trackDir)
      .then((tracks) => {
        return entries.reduce((prev, current) => {
          return prev.then(() => {
            return ensureTrack(current, tracks);
          });
        }, Promise.resolve())
          .then(() => {
            // Produce also a "current" for tracks since latest blog post.
            // Take current.json off the "already have it" list so it is
            // re-fetched and overwritten on every run.
            return ensureTrack({
              from: entries[entries.length - 1].to,
              to: new Date(),
              trackname: 'current.json',
              trip: true,
            }, tracks.filter((name) => name !== 'current.json'));
          });
      })
      .then(() => {
        // We read the tracks again to produce yearly tracks
        return readdir(trackDir)
          .then((tracks) => {
            return tracks.reduce((prev, current) => {
              return prev.then((years) => {
                const match = current.match(/^(\d{4})-0?(\d+)-0?(\d+)/);
                if (!match) {
                  // Not a blog entry record
                  return Promise.resolve(years);
                }
                const entry = entries.find((e) => e.trackname === current);
                if (!entry) {
                  // Not a blog entry record
                  return Promise.resolve(years);
                }
                if (entry.intermission) {
                  return Promise.resolve(years);
                }
                const year = match[1];
                if (!years[year]) {
                  years[year] = [];
                }
                return readFile(resolve(trackDir, current), 'utf-8')
                  .then((data) => JSON.parse(data))
                  .catch((e) => {
                    console.error(`Skipping unreadable track ${current}: ${e.message}`);
                    return null;
                  })
                  .then((geoJSON) => {
                    // TODO: Separate intermissions?
                    if (!geoJSON || !geoJSON.coordinates || !geoJSON.coordinates[0]) {
                      // Not usable track data
                      return years;
                    }
                    years[year] = years[year].concat(geoJSON.coordinates[0]);
                    return years;
                  });
              });
            }, Promise.resolve({}))
              .then((years) => {
                return Object.keys(years).reduce((prev, current) => {
                  return prev.then(() => {
                    const geoJson = {
                      type: 'MultiLineString',
                      coordinates: [
                        years[current],
                      ],
                    };
                    return writeFile(resolve(trackDir, `${current}.json`), JSON.stringify(geoJson, null, 2));
                  });
                }, Promise.resolve());
              });
          });
      });
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}

export { fetchHistoryTrack };
