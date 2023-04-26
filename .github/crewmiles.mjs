import {
  readFile,
  writeFile,
  readdir,
} from 'fs/promises';
import { parse, stringify } from 'yaml';

const crewMiles = {
  nissinen: 0,
};

readdir('_data/logbook')
  .then((files) => {
    const logs = files.filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.yml$/));
    return logs.reduce((prev, logFile) => {
      return prev.then((content) => {
        return readFile(`_data/logbook/${logFile}`, 'utf-8')
          .then((c) => parse(c))
          .then((data) => {
            return content.concat(data);
          });
      });
    }, Promise.resolve([]));
  })
  .then((logEntries) => {
    let previous = null;
    let nissinen = false;
    logEntries.forEach((entry) => {
      if (entry.text.indexOf('Autopilot activated') !== -1) {
        nissinen = true;
      }
      if (!previous) {
        previous = entry;
        return;
      }
      const distance = entry.log - previous.log;
      if (distance <= 0 || Number.isNaN(distance)) {
        if (entry.text.indexOf('Autopilot deactivated') !== -1) {
          nissinen = false;
        }
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
      if (nissinen) {
        crewMiles.nissinen += distance;
      }
      if (entry.text.indexOf('Autopilot deactivated') !== -1) {
        nissinen = false;
      }
      previous = entry;
    });
    return crewMiles;
  })
  .then((crewMiles) => {
    return readFile('_data/crew_miles.yml', 'utf-8')
      .then((c) => parse(c))
      .then((data) => {
        Object.keys(data).forEach((name) => {
          data[name].miles_from_logger = parseFloat(crewMiles[name].toFixed(1)) || 0;
        });
        return data;
      });
  })
  .then((updatedCrew) => {
    return writeFile('_data/crew_miles.yml', stringify(updatedCrew));
  })
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
