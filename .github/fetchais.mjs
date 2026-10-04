import { Point } from 'where';
import { readFile, writeFile } from 'fs/promises';
const vesselUrl = 'https://ais.openwaters.io/v1/vessels/211692440';
fetch(vesselUrl)
  .then((res) => {
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} received`);
    }
    return res.json();
  })
  .then((vessel) => {
    if (vessel.type !== 'Feature' || vessel.geometry?.type !== 'Point') {
      throw new Error('Invalid data received');
    }
    const data = {
      timestamp: vessel.properties.seen,
      position: {
        lat: vessel.geometry.coordinates[1],
        lon: vessel.geometry.coordinates[0],
      },
      sog: vessel.properties.sog,
      heading: vessel.properties.heading,
      name: vessel.properties.name,
      callsign: vessel.properties.callsign,
      mmsi: vessel.properties.mmsi,
    };
    if (Number.isNaN(new Date(data.timestamp).getTime())) {
      throw new Error('Invalid position timestamp received');
    }
    const newPoint = new Point(data.position.lat, data.position.lon);
    console.log(`At ${data.timestamp}, ${data.name} was at ${newPoint}`);
    const timeSince = (Date.now() - new Date(data.timestamp).getTime()) / 1000;
    console.log(`Update is from ${timeSince}s ago`);
    if (timeSince > 60 * 60 * 6) {
      throw new Error('Stale AIS data');
    }
    const writeData = () => writeFile('_data/openwaters.json', JSON.stringify(data, null, 2));
    return readFile('_data/openwaters.json', 'utf-8')
      .then((content) => JSON.parse(content))
      .catch((err) => {
        if (err.code !== 'ENOENT') {
          throw err;
        }
        // No previous data stored, accept anything
        return null;
      })
      .then((oldData) => {
        if (!oldData) {
          console.log('No previous position stored');
          return writeData();
        }
        const oldPoint = new Point(oldData.position.lat, oldData.position.lon);
        const distance = oldPoint.distanceTo(newPoint);
        console.log(`New position is ${distance}km away from stored position ${oldPoint}`);
        if (distance < 0.1) {
          console.log('Ignoring new position since boat hasn\'t moved much');
          return Promise.resolve();
        }
        return writeData();
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
