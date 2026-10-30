#!/usr/bin/env bash
# Turns videos/<Section>/<Lesson>.mp4 into hls/<Section>/<Lesson>/index.m3u8 + segments.
# Usage: ./tools/make-hls.sh [source_dir] [output_dir]   (needs ffmpeg)
set -euo pipefail
src="${1:-videos}"; out="${2:-hls}"
find "$src" -type f \( -iname '*.mp4' -o -iname '*.mkv' -o -iname '*.mov' -o -iname '*.webm' \) -print0 |
while IFS= read -r -d '' f; do
  rel="${f#"$src"/}"; dest="$out/${rel%.*}"
  [ -f "$dest/index.m3u8" ] && { echo "skip $rel"; continue; }
  mkdir -p "$dest"; echo "convert $rel"
  ffmpeg -nostdin -loglevel error -y -i "$f" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k \
    -f hls -hls_time 6 -hls_playlist_type vod -hls_segment_filename "$dest/seg_%04d.ts" "$dest/index.m3u8"
done

# PDFs are copied as-is, keeping the same folder structure
find "$src" -type f -iname '*.pdf' -print0 |
while IFS= read -r -d '' f; do
  rel="${f#"$src"/}"; mkdir -p "$out/$(dirname "$rel")"; cp -n "$f" "$out/$rel"; echo "copy $rel"
done
