import {
  readFile,
  writeFile,
  readdir,
} from 'fs/promises';
import { parse, stringify } from 'yaml';

const currentSetup = {};
const sailSetups = [];
const sailStats = {};
const yearStats = {};

function extractSails(text, sailChange = false) {
  let sails;
  if (sailChange) {
    sails = text.match(/sails set\: ([a-z0-9\(\)\%\ ,]+)/);
  } else {
    sails = text.match(/sailing with ([a-z0-9\(\)\%\ ,]+)/);
  }
  if (!sails || !sails.length) {
    return [];
  }
  const setup = sails[1].split(', ');
  // There might be some extraneous stuff in hand-edited entries like 'full main'
  return setup.map((s) => {
    let sailName = s;
    if (sailName.indexOf('the ') !== -1) {
      sailName = sailName.replace('the ', '');
    }
    if (sailName.indexOf(' poled out') !== -1) {
      sailName = sailName.replace(' poled out', '');
    }
    if (sailName.indexOf('genoa 1') !== -1 && sailName.indexOf('%') !== -1) {
      const percentage = sailName.match(/\(([0-9]+)\%\ furled\)/);
      sailName = 'genoa 1 (reefed)';
      if (percentage && percentage.length > 1) {
        if (Number(percentage[1]) < 20) {
          sailName = 'genoa 1 (full)';
        }
      }
    }
    if (sailName === 'main') {
      sailName = 'main (full)';
    }
    if (sailName === 'genoa 1') {
      sailName = 'genoa 1 (full)';
    }
    if (sailName === 'staysail') {
      sailName = 'staysail (full)';
    }
    return sailName.trim();
  });
}

function recordEnd(entry) {
  const fullEntry = { 
    ...currentSetup,
    end: new Date(entry.datetime),
    endLog: entry.log,
  };
  fullEntry.distance = fullEntry.endLog - fullEntry.startLog;
  if (Number.isNaN(fullEntry.distance)) {
    fullEntry.distance = 0;
  }
  fullEntry.time = (fullEntry.end - fullEntry.start) / 1000 / 60 / 60;
  if (Number.isNaN(fullEntry.time)) {
    fullEntry.time = 0;
  }
  sailSetups.push(fullEntry);
}

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
    let sailing = false;
    logEntries.forEach((entry) => {
      const text = entry.text.toLowerCase();
      if (text.indexOf('motoring') !== -1
        || entry.end) {
        if (sailing) {
          recordEnd(entry);
        }
        sailing = false;
        return;
      }
      if (text.indexOf('sailing with') !== -1
        && text.indexOf('motorsailing') === -1) {
        sailing = true;
        // Started sailing
        currentSetup.sails = extractSails(text);
        currentSetup.start = new Date(entry.datetime);
        currentSetup.startLog = entry.log;
      }
      if (text.indexOf('sails set') !== -1) {
        // Sail change
        recordEnd(entry);
        currentSetup.sails = extractSails(text, true);
        currentSetup.start = new Date(entry.datetime);
        currentSetup.startLog = entry.log;
      }
    });
    return logEntries;
  })
  .then(() => {
    sailSetups.forEach((setup) => {
      setup.sails.forEach((sail) => {
        if (!sailStats[sail]) {
          sailStats[sail] = {
            hours: 0,
            distance: 0,
            timesUsed: 0,
          };
        }
        const year = setup.start.getFullYear();
        if (!yearStats[year]) {
          yearStats[year] = {};
        }
        if (!yearStats[year][sail]) {
          yearStats[year][sail] = {
            hours: 0,
            distance: 0,
            timesUsed: 0,
          };
        }
        sailStats[sail].timesUsed += 1;
        yearStats[year][sail].timesUsed += 1;
        sailStats[sail].distance += setup.distance;
        yearStats[year][sail].distance += setup.distance;
        sailStats[sail].hours += setup.time;
        yearStats[year][sail].hours += setup.time;
      });
    });
  })
  .then(() => {
    return readFile('_data/year_miles.yml', 'utf-8')
      .then((c) => parse(c));
  })
  .then((yearMiles) => {
    Object.keys(yearStats).forEach((year) => {
      console.log(`Year ${year}`);
      console.log('---------');
      const sailNames = Object.keys(yearStats[year]);
      sailNames.sort();
      sailNames.forEach((sail) => {
        let percentage = 0;
        if (yearMiles[year]) {
          percentage = yearStats[year][sail].distance / yearMiles[year].sailing * 100;
        }
        console.log(`${sail} hoisted ${yearStats[year][sail].timesUsed} times`);
        console.log(`  sailed ${String(Math.round(yearStats[year][sail].distance)).padStart(4, ' ')}NM (${String(Math.round(percentage)).padStart(2, ' ')}%)`);
      });
      console.log('');
    });
    process.exit(0);
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });

