import { readFile, writeFile, readdir } from 'fs/promises';
import { resolve, dirname, basename, extname } from 'path';
import { Point } from 'where';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const trackDir = resolve(__dirname, '../tracks');

readdir(trackDir)
  .then((names) => {
    return names.reduce((prev, current) => {
      return prev.then((previous) => {
        return readFile(resolve(trackDir, current), 'utf-8')
          .then((content) => JSON.parse(content))
          .then((data) => {
            if (!data.coordinates) {
              return;
            }
            const newData = { ...data };
            data.coordinates = [data.coordinates.reduce((p, c) => {
              return [...p, ...c];
            }, [])];
            newData.coordinates = [];
            let prevPoint = null;
            newData.coordinates[0] = data.coordinates[0].filter((coord) => {
              const point = new Point(coord[1], coord[0]);
              if (!prevPoint) {
                prevPoint = point;
                return true;
              }
              const distance = prevPoint.distanceTo(point);
              if (distance < 0.004) {
                // console.log('SHORT', distance, prevPoint, point);
                return false;
              }
              if (distance > 200) {
                // console.log('LONG', distance, prevPoint, point);
                return false;
              }
              prevPoint = point;
              return true;
            });
            console.log(current, data.coordinates[0].length, newData.coordinates[0].length);
            return writeFile(resolve(trackDir, current), JSON.stringify(newData, null, 2));
          });
      });
    }, Promise.resolve());
  });
