import {
  readFile,
  writeFile,
  readdir,
} from 'fs/promises';
import { parse } from 'yaml';

readdir('_data/logbook')
  .then((files) => {
    const latest = files.filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.yml$/)).pop();
    if (!latest) {
      return null;
    }
    return readFile(`_data/logbook/${latest}`, 'utf-8')
      .then((c) => parse(c))
      .then((data) => {
        if (!data.length) {
          return null;
        }
        const lastEntry = data.pop();
        if (!lastEntry.position) {
          return null;
        }
        return {
          time: new Date(lastEntry.datetime),
          position: lastEntry.position,
          source: 'Logbook',
        };
      });
  })
  .then((logPosition) => {
    return readFile('_data/aishub.json')
      .then((c) => JSON.parse(c))
      .then((data) => {
        const aisDate = new Date(data.TIME);
        if (aisDate > logPosition.time) {
          // AIS is newer, use that. We're likely offshore and without internet
          return {
            time: aisDate,
            position: {
              latitude: data.LATITUDE,
              longitude: data.LONGITUDE,
            },
            source: 'AISHub',
          };
        }
        // Logbook is newer
        return logPosition;
      });
  })
  .then((latestPosition) => {
    console.log(`Latest is ${latestPosition.source} from ${latestPosition.time}`);
    return writeFile('_data/position.json', JSON.stringify(latestPosition, null, 2));
  })
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
