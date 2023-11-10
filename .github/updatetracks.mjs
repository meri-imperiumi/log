import { readFile, writeFile, readdir } from 'fs/promises';
import { resolve, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';
// import fetch from 'node-fetch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logDir = resolve(__dirname, '../_logs');
const trackDir = resolve(__dirname, '../tracks');
const startOfHistory = new Date('2022-01-10');

function getLogMeta(name, previous) {
  return readFile(resolve(logDir, name), 'utf-8')
    .then((content) => {
      const entry = {
        filename: name,
        trackname: name.replace('.md', '.json'),
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

function ensureTrack(entry, tracks) {
  const trackName = entry.trackname;
  if (tracks.indexOf(trackName) !== -1) {
    // We already have a track for this one
    return Promise.resolve();
  }
  if (entry.to < startOfHistory) {
    // We don't have a Signal K track reaching this far back
    return Promise.resolve();
  }
  const timespan = parseInt((entry.to - entry.from) / 1000 / 60);
  const offset = parseInt((new Date() - entry.to) / 1000 / 60);
  const url = `http://192.168.1.105/signalk/v1/api/self/track?timespan=${timespan}m&resolution=3m&timespanOffset=${offset}`;
  return fetch(url)
    .then((r) => r.json())
    .then((geoJson) => {
      return writeFile(resolve(trackDir, trackName), JSON.stringify(geoJson, null, 2));
    });
}

readdir(logDir)
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
            // Produce also a "current" for tracks since latest blog post
            ensureTrack({
              from: entries[entries.length - 1].to,
              to: new Date(),
              trackname: 'current.json',
            }, tracks);
          });
      });
  });
