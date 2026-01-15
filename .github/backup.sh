#!/bin/bash
echo "Updating [b]log repository"
cd /home/pi/log
git pull origin main
echo "Backing up digital logbook"
cp /home/pi/.signalk/plugin-config-data/signalk-logbook/* _data/logbook/
echo "Backing up blog entries"
cp /home/pi/log-sync/_logs/*.md _logs/
cp -r "/home/pi/log-sync/$(date +%Y)/" .
echo "Producing GeoJson track files"
node .github/updatetracks.mjs
echo "Committing changes as needed"
if [ -z "$(git status --porcelain)" ]; then exit 0;fi
git add _data/logbook/*.yml
git add tracks/*.json
git add _logs/*.md
git add "$(date +%Y)/*"
git config --local user.email boat@lille-oe.de
git config --local user.name Lille Oe
git commit -m "Backup logbook entries"
git push
