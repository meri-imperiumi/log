import {
  readFile,
  writeFile,
  readdir,
} from 'fs/promises';
import { parse, stringify } from 'yaml';

const watermaker = [];
const ppms = [];
const months = {};

function endRun(entry, run) {
  run.end = new Date(entry.datetime);
  run.duration = Math.round((run.end.getTime() - run.start.getTime()) / (1000 * 3600) * 10) / 10;
  if (!run.timeToProduction && run.ppm.max < 100) {
    // We were in brackish water and probably started production after 10min
    run.timeToProduction = 0.08;
  }
  if (!run.timeToProduction && run.ppm.max < 250) {
    // We were in brackish water and probably started production after 10min
    run.timeToProduction = 0.5;
  }
  // Estimate produced water
  if (run.timeToProduction) {
    run.produced = Math.floor((run.duration - run.timeToProduction) * 6);
  }
  watermaker.push(run);
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
    let watermakerRunning = false;
    let previous = null;
    let currentRun = null;
    let previousRun = null;
    let pickled = true;
    logEntries.forEach((entry) => {
      const text = entry.text.toLowerCase();
      if (text.indexOf('watermaker') !== -1
        && text.indexOf('start') !== -1) {
        if (!watermakerRunning) {
          watermakerRunning = true;
          currentRun = {
            start: new Date(entry.datetime),
            end: null,
            daysSince: 0,
            ppm: {
              min: null,
              max: null,
            },
            duration: null,
            timeToProduction: null,
            produced: null,
            wasPickled: pickled,
          };
          pickled = false;
          if (previousRun) {
            currentRun.daysSince = Math.round((currentRun.start.getTime() - previousRun.end.getTime()) / (1000 * 3600 * 24));
          }
        }
      }
      if (watermakerRunning) {
        if (text.indexOf('jug') !== -1
          && text.indexOf('full') !== -1
          && !currentRun.timeToProduction) {
          // Sometimes we haven't kept a good record of PPM
          let productionStarted = new Date(entry.datetime);
          productionStarted.setHours(productionStarted.getHours() - 1.4);
          if (productionStarted < currentRun.start) {
            productionStarted = currentRun.start; // TODO: +10min
          }
          currentRun.timeToProduction = Math.round((productionStarted.getTime() - currentRun.start.getTime()) / (1000 * 3600) * 10) / 10;
        }
        let ppmData = text.match(/([0-9]+)[ ]{0,1}ppm/)
        if (ppmData) {
          const ppm = Number(ppmData[1]);
          ppms.push({
            datetime: new Date(entry.datetime),
            ppm,
          });
          if (!currentRun.ppm.min
            || ppm < currentRun.ppm.min) {
            currentRun.ppm.min = ppm;
          }
          if (!currentRun.ppm.max
            || ppm > currentRun.ppm.max) {
            currentRun.ppm.max = ppm;
          }
          if (ppm < 400 && !currentRun.timeToProduction && text.indexOf('stop') === -1) {
            // Production quality
            const now = new Date(entry.datetime);
            currentRun.timeToProduction = Math.round((now.getTime() - currentRun.start.getTime()) / (1000 * 3600) * 10) / 10;
            if (currentRun.timeToProduction === 0) {
              currentRun.timeToProduction = 0.08;
            }

          }
        }
      }
      if ((text.indexOf('watermaker') !== -1
        && text.indexOf('stop') !== -1)
        || (text.indexOf('watermaker') !== -1
          && text.indexOf('off') !== -1)
        || entry.end) {
        if (!watermakerRunning) {
          return;
        }
        endRun(entry, currentRun);
        previousRun = currentRun;
        watermakerRunning = false;
      }
      if (text.indexOf('watermaker') !== -1
        && text.indexOf('pickl') !== -1) {
        pickled = true;
        watermakerRunning = false;
      }
    });
    return logEntries;
  })
  .then((logEntries) => {
    watermaker.forEach((run) => {
      const month = run.end.toISOString().substr(0, 7);
      if (!months[month]) {
        months[month] = {
          runs: 0,
          produced: 0,
          runtime: 0,
          wastedRuntime: 0,
          failed: 0,
          ppm: {
            max: null,
            avg: null,
            min: null,
          },
        };
      }
      months[month].runs++;
      months[month].runtime += run.duration;
      if (run.produced) {
        months[month].produced += run.produced;
      } else {
        months[month].failed++;
      }
      if (!months[month].ppm.min || run.ppm.min < months[month].ppm.min) {
        months[month].ppm.min = run.ppm.min;
      }
      if (!months[month].ppm.max || run.ppm.max > months[month].ppm.max) {
        months[month].ppm.max = run.ppm.max;
      }
      if (run.timeToProduction) {
        months[month].wastedRuntime += run.timeToProduction;
      } else {
        months[month].wastedRuntime += run.duration;
      }
    });
    return logEntries;
  })
  .then((logEntries) => {
    const ppmMonths = {};
    ppms.forEach((ppm) => {
      const month = ppm.datetime.toISOString().substr(0, 7);
      if (!ppmMonths[month]) {
        ppmMonths[month] = [];
      }
      ppmMonths[month].push(ppm.ppm);
    });
    Object.keys(ppmMonths).forEach((month) => {
      months[month].ppm.avg = Math.round(ppmMonths[month].reduce((a, b) => a + b, 0) / ppmMonths[month].length);
    });
  })
  .then(() => {
    const producedWater = Math.round(watermaker.reduce((a, run) => a + run.produced, 0));
    const runTime = Math.round(watermaker.reduce((a, run) => a + run.duration, 0));
    const wastedRunTime = Math.round(watermaker.reduce((a, run) => {
      if (!run.timeToProduction) {
        return a + run.duration;
      }
      return a + run.timeToProduction;
    }, 0));
    const wastedPercentage = Math.round(wastedRunTime / runTime * 100);
    const failed = watermaker.filter((r) => !r.produced);
    console.log(`Watermaker has been run ${watermaker.length} times, producing ${producedWater}l of fresh water`);
    console.log(`Total runtime is ${runTime}h, of which ${wastedRunTime}h (${wastedPercentage}%) was not producing quality water`);

    Object.keys(months).forEach((monthName) => {
      const month = months[monthName];
      const wasted = Math.round(month.wastedRuntime / month.runtime * 100);
      console.log(`* ${monthName}: ${String(month.runs).padStart(2, ' ')} runs produced ${String(month.produced).padStart(3, ' ')}l fresh water. Runtime ${String(Math.round(month.runtime)).padStart(3, ' ')}h (${String(wasted).padStart(2, ' ')}% wasted). ${month.failed} failed runs. PPM max ${String(month.ppm.max).padStart(4, ' ')} min ${String(month.ppm.min).padStart(3, ' ')}, average ${String(month.ppm.avg).padStart(3, ' ')}`);
    });

    process.exit(0);
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
