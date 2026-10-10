#!/usr/bin/env python3
"""Feasibility experiment: recover the bones TotalSegmentator's free `total`
task does not label (patella, tibia, fibula, foot, radius, ulna, hand) from
the VHF CT by plain HU thresholding + connected components.

bone = HU > THRESH, minus everything within 2 voxels of a TS-labelled
structure, opened to break thin bridges; components above MIN_ML are kept and
auto-named by position only as a hint (side + rough region), NOT anatomically.

Usage: python -I limb_bones_threshold.py CT.nii.gz TOTAL_LABELS.nii.gz OUT_LABELS.nii.gz [--thresh 220] [--min-ml 0.3]
"""
import argparse

import nibabel as nib
import numpy as np
from scipy import ndimage as ndi


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ct")
    ap.add_argument("total")
    ap.add_argument("out")
    ap.add_argument("--thresh", type=float, default=220)
    ap.add_argument("--min-ml", type=float, default=0.3)
    a = ap.parse_args()
    ct = nib.as_closest_canonical(nib.load(a.ct))
    d = np.asarray(ct.dataobj)
    lab = np.asarray(nib.as_closest_canonical(nib.load(a.total)).dataobj)
    known = ndi.binary_dilation(lab > 0, iterations=2)
    bone = (d > a.thresh) & ~known
    bone = ndi.binary_opening(bone, iterations=1)
    cc, n = ndi.label(bone)
    vol = ndi.sum(bone, cc, np.arange(1, n + 1)) / 1000.0
    keep = np.where(vol >= a.min_ml)[0] + 1
    print(f"components {n}, kept {len(keep)} (>= {a.min_ml} ml)")
    out = np.zeros(d.shape, dtype=np.int16)
    objs = ndi.find_objects(cc)
    rows = []
    for new, k in enumerate(sorted(keep, key=lambda k: -vol[k - 1]), 1):
        sl = objs[k - 1]
        out[sl][cc[sl] == k] = new
        lo = nib.affines.apply_affine(ct.affine, [s.start for s in sl])
        hi = nib.affines.apply_affine(ct.affine, [s.stop for s in sl])
        rows.append((new, round(float(vol[k - 1]), 1), lo.round(0), hi.round(0)))
    for r in rows[:60]:
        side = "R" if (r[2][0] + r[3][0]) / 2 > 0 else "L"
        print(f"  {r[0]:3d} {r[1]:8.1f} ml  {side}  x[{r[2][0]:.0f},{r[3][0]:.0f}] y[{r[2][1]:.0f},{r[3][1]:.0f}] z[{r[2][2]:.0f},{r[3][2]:.0f}]")
    nib.save(nib.Nifti1Image(out, ct.affine), a.out)


if __name__ == "__main__":
    main()
