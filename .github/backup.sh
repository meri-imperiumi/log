#!/bin/bash
set -e

SYNC_DIR="/home/pi/log-sync"
GIT_DIR="/home/pi/log"

# Helper function to check if a blog entry is from 2026-08-01 or newer
is_recent_entry() {
    local file="$1"
    local base=$(basename "$file")
    local entry_date

    # 1. Try extracting date from filename (e.g., 2026-08-02-title.md)
    if [[ "$base" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}) ]]; then
        entry_date="${BASH_REMATCH[1]}"
    else
        # 2. Try extracting from frontmatter (date: YYYY-MM-DD)
        entry_date=$(grep -m 1 -i '^date:' "$file" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -n 1 || true)
    fi

    # If no date could be parsed, default to processing it
    if [ -z "$entry_date" ]; then
        return 0
    fi

    # Compare dates (Bash string comparison works securely for YYYY-MM-DD)
    if [[ "$entry_date" < "2026-08-01" ]]; then
        return 1 # False (older)
    else
        return 0 # True (recent)
    fi
}

echo "Checking for ready (non-draft) posts..."

# Gatekeeper: Scan staged logs for active drafts. If everything is a draft,
# exit early to prevent mid-edit sync conflicts or partial processing.
READY_TO_PROCESS=0
for md_file in "$SYNC_DIR/_logs/"*.md; do
    [ -e "$md_file" ] || continue

    # Skip entries older than 2026-08-01
    if ! is_recent_entry "$md_file"; then
        continue
    fi

    if grep -q -i "^draft:[[:space:]]*true" "$md_file" || grep -q -i "^draft:[[:space:]]*yes" "$md_file"; then
        echo "Skipping active draft: $(basename "$md_file")"
        continue
    fi

    READY_TO_PROCESS=1
    break
done

if [ "$READY_TO_PROCESS" -eq 0 ]; then
    echo "No published recent posts found. Exiting to prevent mid-edit sync conflicts."
    exit 0
fi

echo "Draft gate cleared! Processing assets and logs..."

# 1. Process ONLY raster images that are referenced in recent blog entries
find "$SYNC_DIR" -type f \( -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" \) ! -name "*.webp" | while read -r img; do
    [ -e "$img" ] || continue
    filename=$(basename -- "$img")
    
    # Check if this specific image filename is mentioned in any recent markdown file
    is_referenced=0
    for md_file in "$SYNC_DIR/_logs/"*.md; do
        [ -e "$md_file" ] || continue
        if is_recent_entry "$md_file"; then
            if grep -q -F "$filename" "$md_file"; then
                is_referenced=1
                break
            fi
        fi
    done

    # If the image isn't referenced in any recent post, skip it entirely
    if [ "$is_referenced" -eq 0 ]; then
        continue
    fi

    basename_noext="${filename%.*}"
    ext="${filename##*.}"
    target_dir=$(dirname "$img")

    echo "Converting image: $filename -> ${basename_noext}.webp"
    # Use 'convert' instead of 'magick' for ImageMagick v6 compatibility
    convert "$img" -resize "1024x1024>" -quality 80 "$target_dir/${basename_noext}.webp"

    # Update markdown references across recent staged logs pointing to this specific image
    for md_file in "$SYNC_DIR/_logs/"*.md; do
        [ -e "$md_file" ] || continue
        if is_recent_entry "$md_file"; then
            sed -E -i "s/${basename_noext}\.${ext}/${basename_noext}.webp/g" "$md_file"
        fi
    done

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
cp "$SYNC_DIR/_logs/*.md" _logs/

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

# Attempt to push to rngit, failing gracefully if offline
if git remote get-url rngit > /dev/null 2>&1; then
    echo "Attempting to push to rngit repository..."
    if git push rngit main > /dev/null 2>&1; then
        echo "Successfully pushed changes to rngit!"
    else
        echo "rngit Push failed (offline or network timeout). Commits are safely queued locally."
    fi
fi
