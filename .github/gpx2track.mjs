import { readFile, writeFile, readdir } from 'fs/promises';
import { parseString } from 'xml2js';
import { parse } from 'yaml';
import { resolve, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const parseXml = promisify(parseString);
const __dirname = dirname(fileURLToPath(import.meta.url));
const trackDir = resolve(__dirname, '../tracks');
const logDir = resolve(__dirname, '../_logs');
const timelapse = resolve(__dirname, '../SailloggerTimelapse.gpx');

function getLogMeta(name, previous) {
  return readFile(resolve(logDir, name), 'utf-8')
    .then((content) => {
      const entry = {
        filename: name,
        from: previous.to,
        to: new Date(basename(name, extname(name))),
        trip: false,
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
        if (body.indexOf('Distance today') !== -1) {
          entry.trip = true;
        }
      } else {
        console.log('NO METADATA');
      }
      return entry;
    });
}

function produceTrack(entry, tracks, timelapseData) {
  const trackName = `${entry.to.toISOString().substr(0, 10)}.json`;
  if (tracks.indexOf(trackName) !== -1) {
    // We already have a track for this one
    return Promise.resolve();
  }
  if (!entry.trip) {
    return Promise.resolve();
  }
  const points = timelapseData.gpx.trk[0].trkseg[0].trkpt.filter((point) => {
    const pointTime = new Date(point.time[0]);
    if (pointTime >= entry.from && pointTime <= entry.to) {
      return true;
    }
    return false;
  })
    .map((point) => {
      return [
        parseFloat(point['$'].lon),
        parseFloat(point['$'].lat),
      ];
    });
  if (!points.length) {
    return Promise.resolve();
  }
  const geoJson = {
    type: 'MultiLineString',
    coordinates: [points],
  };
  return writeFile(resolve(trackDir, trackName), JSON.stringify(geoJson, null, 2));
}

readdir(logDir)
  .then((names) => {
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
    readFile(timelapse, 'utf-8')
      .then((content) => parseXml(content))
      .then((timelapseData) => {
        return readdir(trackDir)
          .then((tracks) => {
            return entries.reduce((prev, current) => {
              return prev.then(() => {
                return produceTrack(current, tracks, timelapseData);
              });
            }, Promise.resolve());
          });
      });
  });
