#!/usr/bin/env python3
"""Subcutaneous fat thickness of the donor from the seam-corrected CT.

(The Denver "outer fat" surface would have been the cryosection-based answer for the lower body,
but the 'Final 3D STL Models' archive contains no fat meshes, so this uses the CT for the whole body.)

Per axial slice: body = TotalSegmentator body mask; lean = voxels above -30 HU inside the body
eroded by 3 mm (removes the skin layer itself), opened by 2 voxels and stripped of small islands
(vessels, fibrous septa). Thickness at a skin voxel = in-plane distance to the nearest lean voxel.
Skin voxels within 8 mm of the field-of-view edge, and (in the trunk) outside the anterior and
posterior midline strips, are excluded: the arms lie against the flanks there.

Also integrates body volume, mass (rho = 1 + HU/1000 g/ml) and fat fraction.

Usage: python -I fat_thickness.py WORK_DIR   -> WORK_DIR/fat_report.json
"""
import json
import os
import sys

import nibabel as nib
import numpy as np
from scipy import ndimage as ndi
from totalsegmentator.map_to_binary import class_map


def main():
    work = sys.argv[1]
    ct = np.asarray(nib.load(os.path.join(work, "ct_fixed.nii.gz")).dataobj)
    body = np.asarray(nib.load(os.path.join(work, "seg", "body.nii.gz")).dataobj) > 0
    total = np.asarray(nib.load(os.path.join(work, "seg", "total.nii.gz")).dataobj)
    moose = np.asarray(nib.load(os.path.join(work, "seg", "moose_peripheral_bones.nii.gz")).dataobj)
    cm = {v: k for k, v in class_map["total"].items()}
    zr = lambda vol, i: (lambda z: (int(z.min()), int(z.max())))(np.where((vol == i).any((0, 1)))[0])
    import anchor_spec
    mo = {v: k for k, v in anchor_spec.MOOSE_MAP.items()}
    tib, fem, hipb = zr(moose, mo["tibia_left"]), zr(total, cm["femur_left"]), zr(total, cm["hip_left"])
    t12 = zr(total, cm["vertebrae_T12"])
    ster = zr(total, cm["sternum"])
    spine_x = int(round(ndi.center_of_mass(total == cm["sacrum"])[0]))
    regions = {
        "calf (middle half of the tibia)": (tib[0] + (tib[1] - tib[0]) // 4, tib[1] - (tib[1] - tib[0]) // 4, "legs"),
        "thigh (middle half of the femur)": (fem[0] + (fem[1] - fem[0]) // 4, fem[1] - (fem[1] - fem[0]) // 4, "legs"),
        "hip (femoral head to iliac crest)": (fem[1] - 30, hipb[1], "trunk"),
        "abdomen (iliac crest to T12)": (hipb[1], t12[0], "trunk"),
        "chest (T12 to top of sternum)": (t12[1], ster[1], "trunk"),
    }
    ii, jj = np.mgrid[0:ct.shape[0], 0:ct.shape[1]]
    rr = np.hypot(ii - 239.5, jj - 239.5)
    out = {"regions": {}}
    st = np.ones((3, 3), bool)
    for name, (z0, z1, kind) in regions.items():
        vals = {"all": [], "anterior": [], "posterior": [], "lateral": []}
        for z in range(z0, z1, 3):
            b = ndi.binary_fill_holes(body[:, :, z])
            if b.sum() < 500:
                continue
            lean = (ct[:, :, z] > -30) & ndi.binary_erosion(b, st, iterations=3)
            lean = ndi.binary_opening(lean, st, iterations=2)
            lab, n = ndi.label(lean)
            if n:
                size = ndi.sum(lean, lab, np.arange(1, n + 1))
                lean = np.isin(lab, np.where(size >= 150)[0] + 1)
            if not lean.any():
                continue
            d = ndi.distance_transform_edt(~lean)
            edge = b & ~ndi.binary_erosion(b, st)
            edge &= rr < 232
            # outward direction class from the position relative to the slice's body centroid
            ci, cj = ndi.center_of_mass(b)
            if kind == "trunk":
                strip = np.abs(ii - spine_x) < 90
                ant, post = edge & strip & (jj > cj), edge & strip & (jj < cj)
                vals["anterior"].append(d[ant]); vals["posterior"].append(d[post]); vals["all"].append(d[ant | post])
            else:
                lab2, n2 = ndi.label(b)                      # each leg separately
                for k in range(1, n2 + 1):
                    leg = lab2 == k
                    if leg.sum() < 800:
                        continue
                    li, lj = ndi.center_of_mass(leg)
                    e = edge & leg
                    ang = np.degrees(np.arctan2(jj - lj, ii - li))          # 0 = towards +i (patient right), 90 = anterior
                    a_, p_ = e & (np.abs(ang - 90) < 45), e & (np.abs(ang + 90) < 45)
                    outer = e & ((np.abs(ang) < 45) if li > spine_x else (np.abs(ang) > 135))
                    vals["anterior"].append(d[a_]); vals["posterior"].append(d[p_]); vals["lateral"].append(d[outer])
                    vals["all"].append(d[a_ | p_ | outer])
        res = {}
        for k, v in vals.items():
            v = np.concatenate(v) if v else np.zeros(0)
            if len(v) > 50:
                res[k] = {"median_mm": round(float(np.median(v)), 1), "p90_mm": round(float(np.quantile(v, 0.9)), 1), "samples": int(len(v))}
        out["regions"][name] = {"slices_k": [int(z0), int(z1)], **res}
    hu = ct[body].astype(np.float32)
    vol_l = body.sum() / 1e6
    mass = float((1 + np.clip(hu, -1000, 2000) / 1000).sum() / 1e6)
    fat = (hu > -190) & (hu < -30)
    crown = int(np.where((total == cm["skull"]).any((0, 1)))[0].max())
    heel = int(np.where((moose == mo["tarsal_left"]).any((0, 1)))[0].min())
    out["whole_body"] = {
        "body_volume_l": round(float(vol_l), 1), "mass_from_ct_kg": round(mass, 1),
        "adipose_voxel_fraction_-190_to_-30_HU": round(float(fat.mean()), 3), "adipose_volume_l": round(float(fat.sum() / 1e6), 1),
        "skull_top_to_heel_mm": crown - heel, "note": "the body is clipped laterally by the 480 mm field of view in the trunk, so volume and mass are lower bounds; "
                                                     "skull-top-to-heel is measured along the scanner axis (supine, feet plantar-flexed) and misses the scalp",
        "bmi_from_ct_lower_bound": round(mass / ((crown - heel + 5) / 1000) ** 2, 1)}
    json.dump(out, open(os.path.join(work, "fat_report.json"), "w"), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
