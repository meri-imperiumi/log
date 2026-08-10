#!/bin/bash
set -e

SYNC_DIR="/home/pi/log-sync"
GIT_DIR="/home/pi/log"

echo "Checking for ready (non-draft) posts..."

# Gatekeeper: Scan staged logs for active drafts. If everything is a draft,
# exit early to prevent mid-edit sync conflicts or partial processing.
READY_TO_PROCESS=0
for md_file in "$SYNC_DIR/_logs/"*.md; do
    [ -e "$md_file" ] || continue

    if grep -q -i "^draft:[[:space:]]*true" "$md_file" || grep -q -i "^draft:[[:space:]]*yes" "$md_file"; then
        echo "Skipping active draft: $(basename "$md_file")"
        continue
    fi

    READY_TO_PROCESS=1
    break
done

if [ "$READY_TO_PROCESS" -eq 0 ]; then
    echo "No published posts found. Exiting to prevent mid-edit sync conflicts."
    exit 0
fi

echo "Draft gate cleared! Processing assets and logs..."

# 1. Process legacy or new raster images sitting anywhere in per-year folders or sync assets
find "$SYNC_DIR" -type f \( -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" \) ! -name "*.webp" | while read -r img; do
    [ -e "$img" ] || continue
    filename=$(basename -- "$img")
    basename_noext="${filename%.*}"
    ext="${filename##*.}"
    target_dir=$(dirname "$img")

    echo "Converting image: $filename -> ${basename_noext}.webp"
    magick "$img" -resize "1024x1024>" -quality 80 "$target_dir/${basename_noext}.webp"

    # Update markdown references across all staged logs pointing to this specific image
    find "$SYNC_DIR/_logs" -name "*.md" -type f -exec sed -E -i "s/${basename_noext}\.${ext}/${basename_noext}.webp/g" {} +

    # Remove heavy original raster file
    rm "$img"
done

echo "Updating [b]log repository locally..."
cd "$GIT_DIR"

# Attempt to pull remote updates if online, using -X ours so local hi-fi
# assets explicitly override any incoming lo-fi satellite placeholders.
if git remote get-url origin > /dev/null 2>&1; then
    echo "Checking remote connectivity for pull..."
    if git ls-remote --exit-code origin HEAD > /dev/null 2>&1; then
        git pull origin main -X ours
    else
        echo "Remote repository unreachable. Skipping pull; working offline."
    fi
fi

echo "Backing up digital logbook..."
cp /home/pi/.signalk/plugin-config-data/signalk-logbook/* _data/logbook/

echo "Backing up processed blog entries and WebP assets..."
cp "$SYNC_DIR/_logs/"*.md _logs/
if [ -d "$SYNC_DIR/_assets" ]; then
    mkdir -p assets/hi-fi/
    cp -r "$SYNC_DIR/_assets/"* assets/hi-fi/
fi

# Copy per-year folders dynamically (e.g., 2024, 2025, 2026)
for year_dir in "$SYNC_DIR"/[0-9][0-9][0-9][0-9]; do
    if [ -d "$year_dir" ]; then
        year_name=$(basename "$year_dir")
        mkdir -p "$year_name"
        cp -r "$year_dir/"* "$year_name/"
    fi
done

echo "Producing GeoJson track files..."
node .github/updatetracks.mjs

# Commit changes locally regardless of network state
if [ -n "$(git status --porcelain)" ]; then
    git add _data/logbook/*.yml
    git add tracks/*.json
    git add _logs/*.md
    git add assets/hi-fi/*
    git add [0-9][0-9][0-9][0-9]/*

    git config --local user.email boat@lille-oe.de
    git config --local user.name "Lille Oe"
    git commit -m "Local backup: logbook, tracks, and optimized WebP blog assets"
    echo "Changes committed locally."
else
    echo "No local changes to commit."
    exit 0
fi

# Attempt to push to remote, failing gracefully if offline
if git remote get-url origin > /dev/null 2>&1; then
    echo "Attempting to push to remote repository..."
    if git push origin main > /dev/null 2>&1; then
        echo "Successfully pushed changes to remote!"
    else
        echo "Push failed (offline or network timeout). Commits are safely queued locally."
    fi
fi
