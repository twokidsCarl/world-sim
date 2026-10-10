#!/bin/sh
# Reproduces every download / inspection / segmentation step behind INVENTORY.md.
# Run from the repository root. Everything lands in data/raw/female/ (gitignored)
# and tools/register/out/ (small TSVs + preview PNGs).
#
# Needs: uv, curl, gzip. ~7 GB disk, ~30 GB peak RAM for TotalSegmentator on the
# full 480x480x1734 volume, ~25 min of compute on an M4 Max (MPS).
set -eu
RAW=data/raw/female
OUT=tools/register/out
T=tools/register
PY=$T/.venv/bin/python
mkdir -p $RAW/hra $RAW/vhf/derived/seg $OUT/preview

# --- environments -----------------------------------------------------------
# Python 3.12 on purpose (system default 3.14 was not tried for torch/nnU-Net).
[ -x $PY ] || uv venv --python 3.12 $T/.venv
uv pip install --python $PY -q numpy scipy scikit-image nibabel trimesh pygltflib pillow \
  fast-simplification remotezip TotalSegmentator
# MOOSE pins its own nnU-Net stack -> separate venv (kept under data/raw so it is gitignored)
[ -x $RAW/venv-moose/bin/moosez ] || { uv venv --python 3.12 $RAW/venv-moose; uv pip install --python $RAW/venv-moose/bin/python -q moosez; }

# --- 1. HRA reference organs (CC BY 4.0) -------------------------------------
CDN=https://cdn.humanatlas.io/digital-objects/ref-organ
for s in female:f male:m; do
  n=${s%%:*}; k=${s##*:}
  [ -s $RAW/hra/3d-vh-$k-united.glb ] || curl -sfL -o $RAW/hra/3d-vh-$k-united.glb $CDN/united-$n/latest/assets/3d-vh-$k-united.glb
  $PY -I $T/inspect_glb.py $RAW/hra/3d-vh-$k-united.glb $OUT/hra_united_$k.tsv
done
curl -sfL -o $RAW/hra/crosswalk.united-female.csv $CDN/united-female/latest/assets/crosswalk.csv
curl -sfL -o $RAW/hra/united-female.graph.json $CDN/united-female/latest/graph.json
curl -sfL -o $RAW/hra/reference-organs.json https://apps.humanatlas.io/api/v1/reference-organs
[ -s $RAW/hra/uberon-simple.obo ] || curl -sfL -o $RAW/hra/uberon-simple.obo http://purl.obolibrary.org/obo/uberon/uberon-simple.obo
$PY -I $T/correspond_hra_bp3d.py data/raw/bodyparts3d $RAW/hra/crosswalk.united-female.csv \
  $RAW/hra/uberon-simple.obo $OUT/hra_united_f.tsv $OUT/hra_f_to_bp3d.tsv
$PY -I $T/render_glb_points.py $RAW/hra/3d-vh-f-united.glb $OUT/preview/hra_f_overview.png 'VH_F_skin$' \
  'vertebra_|sacrum|coccyx|ilium|sternum|manubrium|femur_[LR]$|tibia_[LR]$|fibula_[LR]$|patella_[LR]$' \
  'uterus|ovary|vagina|uterine_tube|fallopian|cervix|mammary_lobes' 'aorta|vena_cava|iliac' 'liver|kidney|lung|heart|spleen'

# --- 2. Visible Human Female CT (NLM) ----------------------------------------
sh $T/download_vhf_ct.sh $RAW/vhf/normalCT
mkdir -p $RAW/vhf/normalCTHeaders
seq 1001 2734 | xargs -P 6 -I{} sh -c '[ -s "$0/c_vf{}.txt" ] || curl -sfL --retry 5 -o "$0/c_vf{}.txt" \
  https://data.lhncbc.nlm.nih.gov/public/Visible-Human/Female-Images/radiological/normalCTHeaders/c_vf{}.txt' $RAW/vhf/normalCTHeaders
CT=$RAW/vhf/derived/vhf_ct_1mm.nii.gz
$PY -I $T/vhf_ct_to_nifti.py $RAW/vhf/normalCT $RAW/vhf/normalCTHeaders $CT --report $OUT/vhf_ct_slices.tsv

# --- 3. Segmentation: TotalSegmentator free tasks + MOOSE peripheral bones ----
export TOTALSEG_HOME_DIR=$PWD/$RAW/totalseg_home     # keep weights out of ~/.totalsegmentator
for t in total body abdominal_muscles headneck_bones_vessels headneck_muscles breasts craniofacial_structures; do
  [ -s $RAW/vhf/derived/seg/$t.nii.gz ] || $T/.venv/bin/TotalSegmentator -i $CT -o $RAW/vhf/derived/seg/$t.nii.gz --ml -ta $t -d mps
  $PY -I $T/labels_to_meshes.py $RAW/vhf/derived/seg/$t.nii.gz $RAW/vhf/derived/mesh_$t --task $t --no-obj
  cp $RAW/vhf/derived/mesh_$t/meshes.tsv $OUT/vhf_${t}_meshes.tsv
done
mkdir -p $RAW/vhf/derived/moose_in/VHF
ln -f $CT $RAW/vhf/derived/moose_in/VHF/CT_vhf.nii.gz
ls -d $RAW/vhf/derived/moose_in/VHF/moosez-* >/dev/null 2>&1 || \
  (cd $RAW/vhf/derived && PYTORCH_ENABLE_MPS_FALLBACK=1 ../../venv-moose/bin/moosez -d moose_in -m clin_ct_peripheral_bones)
M=$(ls -d $RAW/vhf/derived/moose_in/VHF/moosez-* | tail -1)
# shellcheck disable=SC2046
$PY -I $T/labels_to_meshes.py $M/segmentations/clin_CT_peripheral_bones_segmentation_CT_vhf.nii.gz \
  $RAW/vhf/derived/mesh_moose_peripheral_bones --no-obj --names $(awk -F, 'NR>1{printf "%s=%s ",$1,$2}' $M/stats/*volume.csv)
cp $RAW/vhf/derived/mesh_moose_peripheral_bones/meshes.tsv $OUT/vhf_moose_peripheral_bones_meshes.tsv

# --- 4. Previews, baseline experiment, correspondences ------------------------
D=$RAW/vhf/derived
$PY -I $T/preview_volume.py $CT $OUT/preview/vhf $D/seg/total.nii.gz
$PY -I $T/render_glb_points.py --zup $D/mesh_body/all.glb,$D/mesh_moose_peripheral_bones/all.glb,$D/mesh_total/all.glb \
  $OUT/preview/vhf_skeleton_ts_plus_moose.png 'body_' 'vertebrae|sacrum|rib_|sternum|hip_|costal' \
  'tibia|radius|carpal|tarsal|patella' 'fibula|ulna|metacarpal|metatarsal|skull' 'fingers|toes|humerus|femur|scapula|clavic'
$PY -I $T/limb_bones_threshold.py $CT $D/seg/total.nii.gz $D/seg/limb_bones_threshold.nii.gz   # negative result, see INVENTORY
$PY -I $T/correspond_ts_bp3d.py data/raw/bodyparts3d $OUT/ts_to_bp3d.tsv total body abdominal_muscles \
  headneck_bones_vessels headneck_muscles breasts craniofacial_structures appendicular_bones

# --- 5. TotalSegmentator training set: female coverage survey (range requests, no 23 GB download)
$PY -I $T/ts_dataset_female_candidates.py $RAW/totalseg_dataset
