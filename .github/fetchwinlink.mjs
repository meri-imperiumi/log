import Parser from 'rss-parser';
import { Point } from 'where';
import { readFile, writeFile } from 'fs/promises';
import { stringify } from 'yaml';

let feedUrl = 'https://cms.winlink.org:444/rss/rsspositionreports.aspx?callsign=DF4HB';
const parser = new Parser();
parser.parseURL(feedUrl)
  .then((feed) => {
    if (!feed.items || !feed.items.length) {
      throw new Error('No items found');
    }
    return feed.items
      .map((item) => {
        const itemDate = new Date(item.isoDate);
        const coords = item.title.match(/for DF4HB is ([0-9\.\-]+) \/ ([0-9\.\-]+)/);
        if (!coords) {
          return null;
        }
        const lat = parseFloat(coords[1]);
        const lon = parseFloat(coords[2]);
        const point = new Point(lat, lon);
        return {
          timestamp: itemDate,
          position: point,
          text: item.content,
        };
      })
      .filter((i) => i);
  })
  .then((entries) => {
    const texts = entries.filter((t) => t.text);
    return texts.reduce((prev, current) => {
      return prev.then(() => {
        const data = {
          ...current,
          source: 'winlink',
        };
        const text = data.text;
        delete data.text;
        const iso = current.timestamp.toISOString();
        const path = `_texts/${iso.substr(0, 10)}_${iso.substr(11, 2)}_${iso.substr(14, 2)}.md`;
        const content = `---\n${stringify(data)}---\n${text}`;
        return writeFile(path, content);
      });
    }, Promise.resolve())
      .then(() => entries);
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
    return readFile('_data/winlink.json', 'utf-8')
      .then((content) => JSON.parse(content))
      .then((oldData) => {
        if (new Date(oldData.timestamp) >= latest.timestamp) {
          return Promise.resolve();
        }
        return writeFile('_data/winlink.json', JSON.stringify(latest, null, 2));
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
