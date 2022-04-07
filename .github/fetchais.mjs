import fetch from 'node-fetch';
import { writeFile } from 'fs/promises';
const apiKey = process.env.AISHUB_TOKEN;
const mmsi = '211692440';
fetch(`https://data.aishub.net/ws.php?username=${apiKey}&format=1&output=json&compress=0&mmsi=${mmsi}`)
  .then(r => r.json())
  .then((data) => {
    if (data[0] && data[0].ERROR) {
      throw new Error(data[0].ERROR_MESSAGE);
    }
    if (data.length < 2) {
      throw new Error('Invalid data received');
    }
    if (data[1].length < 1) {
      throw new Error('Invalid data received');
    }
    return data[1][0];
  })
  .then((data) => {
    console.log(`At ${data.TIME}, ${data.NAME} was at ${data.LATITUDE},${data.LONGITUDE}`);
    const currentTime = new Date();
    const aisTime = new Date(data.TIME);
    const timeSince = (currentTime - aisTime) / 1000;
    console.log(`Update is from ${timeSince}s ago`);
    if (timeSince > 60 * 60 * 6) {
      throw new Error('Stale AIS data');
    }
    return writeFile('_data/aishub.json', JSON.stringify(data, null, 2));
  })
  .then(() => {
    console.log('Done');
    process.exit(0);
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
