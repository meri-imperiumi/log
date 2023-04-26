import {
  readFile,
  writeFile,
  readdir,
} from 'fs/promises';
import { parse, stringify } from 'yaml';

const crewMiles = {
  nissinen: 0,
  starbuck: 0,
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
    let previousNissinen = false;
    let starbuck = false;
    let previousStarbuck = false;
    logEntries.forEach((entry) => {
      let countThisStill = false;
      if (entry.text.indexOf('Autopilot activated') !== -1) {
        // If we activate autopilot, we definitely deactivate windvane
        previousNissinen = nissinen;
        nissinen = true;
        previousStarbuck = starbuck;
        starbuck = false;
      }
      if (entry.text.toLowerCase().indexOf('windvane') !== -1) {
        // We assume that windvane mentions mean activation
        previousStarbuck = starbuck;
        starbuck = true;
      }
      if (entry.text.toLowerCase().indexOf('hand steering') !== -1) {
        // Hand steering means no windvane
        previousStarbuck = starbuck;
        starbuck = false;
      }
      if (entry.text.indexOf('Autopilot deactivated') !== -1) {
        // Autopilot deactivation doesn't automatically imply windvane activation
        previousNissinen = nissinen;
        nissinen = false;
      }
      if (entry.text.toLowerCase().indexOf('motoring') !== -1) {
        // Windvane can't be used while motoring
        previousStarbuck = starbuck;
        starbuck = false;
      }
      if (entry.end) {
        // When trip ends we don't use either any longer
        previousNissinen = nissinen;
        nissinen = false;
        previousStarbuck = starbuck;
        starbuck = false;
      }

      if (!previous) {
        previous = entry;
        return;
      }
      const distance = entry.log - previous.log;
      if (distance <= 0 || Number.isNaN(distance)) {
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
      if (nissinen || previousNissinen) {
        crewMiles.nissinen += distance;
        previousNissinen = nissinen;
      }
      if (starbuck || previousStarbuck) {
        crewMiles.starbuck += distance;
        previousStarbuck = starbuck;
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
