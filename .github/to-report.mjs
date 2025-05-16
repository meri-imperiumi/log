import { readFile, readdir } from 'fs/promises';
import { resolve, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { parse, stringify } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logDir = resolve(__dirname, '../_logs');

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatDate(date) {
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth()+1)}.${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function formatCoordinate(coord) {
  return coord.toFixed(4).replace('.', ',');
}

function formatUrl(entry) {
  return `lille-oe.de/${entry.date.toISOString().substr(0, 10)}/`;
}

readdir(logDir)
  .then((names) => {
    const entries = [];
    return names.reduce((prev, current) => {
      return prev.then((previous) => {
        return readFile(resolve(logDir, current), 'utf-8')
          .then((content) => {
            const [front, head, body] = content.split('---');
            if (body.indexOf('Distance today') === -1) {
              return;
            }
            const metadata = parse(head);
            if (metadata.title.indexOf('Intermission') !== -1) {
              return;
            }
            const entry = {
              date: new Date(metadata.created),
              position: metadata.position,
            };
            entries.push(entry);
          });
    })
    }, Promise.resolve({}))
      .then(() => entries);
  })
  .then((entries) => {
    entries.forEach((entry) => {
      console.log(`${formatDate(entry.date)} ${formatCoordinate(entry.position.lat)} ${formatCoordinate(entry.position.lon)} ${formatUrl(entry)}`);
    });
  });
