import fetch from 'node-fetch';
import { Point } from 'where';
import { readFile, writeFile } from 'fs/promises';
import { parseString } from 'xml2js';
import { stringify } from 'yaml';

const kmlUrl = process.env.INREACH_URL;

const texts = [];

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
      if (!mark.Point || !mark.Point.length) {
        return false;
      }
      return true;
    })
      .map((mark) => {
        const [lon, lat] = mark.Point[0].coordinates[0].split(',');
        const checkin = {
          timestamp: new Date(mark.TimeStamp[0].when[0]),
          position: new Point(parseFloat(lat), parseFloat(lon)),
        };
        if (mark.ExtendedData && mark.ExtendedData.length && mark.ExtendedData[0].Data) {
          mark.ExtendedData[0].Data.forEach((entry) => {
            if (!entry['$'] || !entry['$'].name || !entry['value'] || !entry['value'].length) {
              return;
            }
            switch (entry['$'].name) {
              case 'Text': {
                checkin['text'] = entry['value'][0];
                break;
              }
              case 'Event': {
                checkin['event'] = entry['value'][0];
                break;
              }
              case 'In Emergency': {
                checkin['emergency'] = (entry['value'][0] === 'True');
                break;
              }
            }
          });
        }
        return checkin;
      });
  })
  .then((checkins) => {
    const texts = checkins.filter((t) => t.text);
    return texts.reduce((prev, current) => {
      return prev.then(() => {
        if (current['event'] === 'Quick Text to MapShare received') {
          // These are just to update map position
          return Promise.resolve();
        }
        const data = {
          ...current,
          source: 'inreach',
        };
        const text = data.text;
        delete data.text;
        const iso = current.timestamp.toISOString();
        const path = `_texts/${iso.substr(0, 10)}_${iso.substr(11, 2)}${iso.substr(14, 2)}.md`;
        const content = `---\n${stringify(data)}---\n${text}`;
        return writeFile(path, content);
      });
    }, Promise.resolve())
      .then(() => checkins);
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
