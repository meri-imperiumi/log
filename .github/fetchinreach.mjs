import fetch from 'node-fetch';
import { Point } from 'where';
import { readFile, writeFile } from 'fs/promises';
import { parseString } from 'xml2js';

const kmlUrl = process.env.INREACH_URL;

fetch(kmlUrl)
  .then(r => r.text())
  .then((xml) => new Promise((resolve, reject) => {
    parseString(xml, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(res);
    });
  }))
  .then((data) => {
    const marks = data.kml.Document[0].Folder[0].Placemark;
    if (!marks || !marks.length) {
      return Promise.resolve([]);
    }
    return marks.filter((mark) => {
      if (!mark.TimeStamp || !mark.TimeStamp.length) {
        return false;
      }
      // For the moment we're only interested in position updates
      // TODO: Have a place to stick textual updates to
      if (!mark.Point || !mark.Point.length) {
        return false;
      }
      return true;
    })
      .map((mark) => {
        const [lon, lat] = mark.Point[0].coordinates[0].split(',');
        return {
          timestamp: new Date(mark.TimeStamp[0].when[0]),
          position: new Point(parseFloat(lat), parseFloat(lon)),
        };
      });
  })
  .then((checkins) => {
    return checkins.reduce((latest, current) => {
      if (!latest.timestamp) {
        return current;
      }
      if (current.timestamp > latest.timestamp) {
        return current;
      }
      return latest;
    }, {});
  })
  .then((latest) => {
    if (!latest.timestamp) {
      return;
    }
    return readFile('_data/inreach.json', 'utf-8')
      .then((content) => JSON.parse(content))
      .then((oldData) => {
        if (new Date(oldData.timestamp) >= latest.timestamp) {
          return Promise.resolve();
        }
        return writeFile('_data/inreach.json', JSON.stringify(latest, null, 2));
      });
  })
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
