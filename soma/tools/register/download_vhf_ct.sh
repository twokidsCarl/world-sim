#!/bin/sh
# Download the Visible Human Female "normal CT" slices (GE 16-bit, unix-compressed)
# from the NLM public server. 1734 files, ~370 MB compressed.
# Usage: download_vhf_ct.sh DEST_DIR
set -eu
DEST="$1"
BASE="https://data.lhncbc.nlm.nih.gov/public/Visible-Human/Female-Images/radiological/normalCT"
mkdir -p "$DEST"
seq 1001 2734 | xargs -P 16 -I{} sh -c \
  '[ -s "$0/c_vf{}.fre.Z" ] || curl -sfL --retry 3 -o "$0/c_vf{}.fre.Z" "$1/c_vf{}.fre.Z" || echo "FAIL {}"' \
  "$DEST" "$BASE"
ls "$DEST" | wc -l
du -sh "$DEST"
