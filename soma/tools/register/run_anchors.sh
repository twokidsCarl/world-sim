#!/bin/sh
# Builds the female anchor package in data/raw/female/out/anchors/ from the outputs of
# run_inventory.sh (assembled CT, TotalSegmentator and MOOSE label maps, HRA GLB).
# Run from the repository root. About 3 minutes; needs ~8 GB RAM.
#
# Also needs: public/anatomy/male/anatomy.json (male part ids) and data/raw/bodyparts3d (male OBJ
# geometry, used for landmarks, target arm pose and size ratios).
set -eu
T=tools/register
PY=$T/.venv/bin/python
RAW=data/raw/female
D=$RAW/vhf/derived
OUT=$RAW/out/anchors
mkdir -p $OUT/work $T/out

$PY -c "import rtree" 2>/dev/null || uv pip install --python $PY -q rtree

MOOSE=$(ls -d $D/moose_in/VHF/moosez-* | tail -1)/segmentations/clin_CT_peripheral_bones_segmentation_CT_vhf.nii.gz

# 1. seam correction + six-lumbar relabelling -> work/ct_fixed.nii.gz, work/seg/*.nii.gz, work/fix_report.json
$PY -I $T/fix_volume.py $D/vhf_ct_1mm.nii.gz $D/seg "$MOOSE" $OUT/work > $T/out/fix_volume.log
# 2. cleaned, smoothed, decimated meshes -> work/meshes.npz
$PY -I $T/build_meshes.py $OUT/work > $T/out/build_meshes.log
# 3. frame, kinematics, re-posing, male correspondences, HRA organs, manifest + binaries + previews
$PY -I $T/build_package.py $OUT/work $OUT public/anatomy/male data/raw/bodyparts3d $RAW/hra > $T/out/build_package.log
# 4. README.md and SANITY.md
$PY -I $T/write_reports.py $OUT
ls -la $OUT
