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

    if [ -z "$entry_date" ]; then
        return 0
    fi

    # Compare dates
    if [[ "$entry_date" < "2026-08-01" ]]; then
        return 1 # False (older)
    else
        return 0 # True (recent)
    fi
}

echo "Checking for ready (non-draft) posts..."

VALID_MDS=()

# Gatekeeper: Scan staged logs. Collect recent, non-draft posts.
for md_file in "$SYNC_DIR/_logs/"*.md; do
    [ -e "$md_file" ] || continue

    # Skip entries older than 2026-08-01
    if ! is_recent_entry "$md_file"; then
        continue
    fi

    if grep -q -iE "^draft:[[:space:]]*(\"true\"|'true'|true|\"yes\"|'yes'|yes)" "$md_file"; then
        echo "Draft gate BLOCKED: active draft detected - $(basename "$md_file")"
        echo "Aborting backup to prevent mid-edit sync conflicts."
        exit 1
    fi

    VALID_MDS+=("$md_file")
done

if [ ${#VALID_MDS[@]} -eq 0 ]; then
    echo "No published recent posts found. Exiting to prevent mid-edit sync conflicts."
    exit 0
fi

echo "Draft gate cleared! Extracting image references from ${#VALID_MDS[@]} recent posts..."

# Extract unique image filenames referenced in valid markdown files.
# Matches standard characters, numbers, dashes, underscores followed by .jpg, .jpeg, or .png
UNIQUE_IMAGES=$(grep -hoEi '[a-zA-Z0-9_.-]+\.(jpg|jpeg|png)' "${VALID_MDS[@]}" | sort -u || true)

if [ -n "$UNIQUE_IMAGES" ]; then
    echo "$UNIQUE_IMAGES" | while read -r img_name; do
        [ -z "$img_name" ] && continue

        # Locate the specific referenced image in the sync directory (case-insensitive search)
        find "$SYNC_DIR" -type f -iname "$img_name" | while read -r img_path; do
            [ -e "$img_path" ] || continue

            filename=$(basename -- "$img_path")
            basename_noext="${filename%.*}"
            ext="${filename##*.}"
            target_dir=$(dirname "$img_path")

            echo "Converting image: $filename -> ${basename_noext}.webp"
            # Use 'convert' instead of 'magick' for ImageMagick v6 compatibility
            convert "$img_path" -resize "1024x1024>" -quality 80 "$target_dir/${basename_noext}.webp"

            # Update markdown references across VALID_MDS
            for md in "${VALID_MDS[@]}"; do
                sed -E -i "s/${basename_noext}\.${ext}/${basename_noext}.webp/g" "$md"
            done

            # Remove heavy original raster file
            rm "$img_path"
        done
    done
else
    echo "No raster images referenced in recent posts."
fi

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
# Copy only recent blog entries to prevent overwriting/touching older ones
for md_file in "$SYNC_DIR/_logs/"*.md; do
    [ -e "$md_file" ] || continue
    if is_recent_entry "$md_file"; then
        cp "$md_file" _logs/
    fi
done

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
    # Use || true to prevent set -e from aborting the script if a folder is empty/missing
    git add _data/logbook/ || true
    git add tracks/ || true
    git add _logs/ || true

    # Add year folders dynamically (e.g., 2026/)
    for year_dir in [0-9][0-9][0-9][0-9]; do
        if [ -d "$year_dir" ]; then
            git add "$year_dir/" || true
        fi
    done

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
