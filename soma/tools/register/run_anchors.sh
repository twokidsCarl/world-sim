#!/bin/sh
# Builds the female anchor package in data/raw/female/out/anchors/ from the outputs of
# run_inventory.sh (assembled CT, TotalSegmentator and MOOSE label maps, HRA GLB).
# Run from the repository root. About 5 minutes; needs ~8 GB RAM.
# Optional input: data/raw/female/denver/Final 3D STL Models-stl/{Left,Right}/*.stl (manual browser download,
# https://digitalcommons.du.edu/visiblehuman/1, CC BY 4.0); without it the package has no VD_* items.
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

$PY -c "import rtree, shapely, networkx" 2>/dev/null || uv pip install --python $PY -q rtree shapely networkx

MOOSE=$(ls -d $D/moose_in/VHF/moosez-* | tail -1)/segmentations/clin_CT_peripheral_bones_segmentation_CT_vhf.nii.gz

# 1. seam correction + six-lumbar relabelling -> work/ct_fixed.nii.gz, work/seg/*.nii.gz, work/fix_report.json
$PY -I $T/fix_volume.py $D/vhf_ct_1mm.nii.gz $D/seg "$MOOSE" $OUT/work > $T/out/fix_volume.log
# 2. cleaned, smoothed, decimated meshes -> work/meshes.npz
$PY -I $T/build_meshes.py $OUT/work > $T/out/build_meshes.log
# 0. 盆底参考模型：下载 PLoS ONE 的 3D-PDF 并取出 U3D 流（需要联网；失败则数据包不含 WU_ 条目）
# 0. pelvic floor reference: fetch the PLoS ONE 3D-PDF and extract its U3D stream (needs network;
#    if it fails the package is built without WU_ items)
$PY -c "import pypdf" 2>/dev/null || uv pip install --python $PY -q pypdf
[ -s $RAW/pelvic_floor/wu2015_corr_pone.0140736.s004.u3d ] || $PY -I $T/pelvic_floor_refs.py $RAW/pelvic_floor > $T/out/pelvic_floor_refs.log 2>&1 || true
# 2b. subcutaneous fat thickness and body composition from the fixed CT -> work/fat_report.json
$PY -I $T/fat_thickness.py $OUT/work > $T/out/fat_thickness.log
# 3. frame, kinematics, re-posing, male correspondences, HRA organs + skin, Denver import (if
#    data/raw/female/denver/ exists), manifest + binaries + previews
$PY -I $T/build_package.py $OUT/work $OUT public/anatomy/male data/raw/bodyparts3d $RAW/hra $D/seg > $T/out/build_package.log
# 4. README.md and SANITY.md
$PY -I $T/write_reports.py $OUT
ls -la $OUT
