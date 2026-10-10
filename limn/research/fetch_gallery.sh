#!/bin/sh
# Download the Goodsell reference images (CC-BY-4.0, RCSB PDB-101) used for
# the style study. Files land in research/gallery/, which is not committed.
set -e
cd "$(dirname "$0")/gallery"
G=https://cdn.rcsb.org/pdb101/goodsell/tif
M=https://cdn.rcsb.org/pdb101/motm
for u in \
  $G/excitatory-and-inhibitory-synapses.tif \
  $G/insulin-action.tif \
  $G/coronavirus.tif \
  $G/sars-cov-2-mrna-vaccine.tif \
  $G/escherichia-coli-bacterium.tif \
  $G/autophagy.tif \
  $G/mycoplasma-mycoides.tif \
  $G/ebola-virus.tif \
  $G/hiv-in-blood-plasma.tif \
  $G/escherichia-coli.tif \
  $M/250/250-Capsaicin_Receptor_TRPV1-5is0_composite.tif \
  $M/250/250-Capsaicin_Receptor_TRPV1-6dmw.tif
do
  f=$(basename "$u")
  [ -s "$f" ] || curl -fsSL --retry 3 -o "$f" "$u"
  echo "$f $(wc -c < "$f")"
done
