#!/usr/bin/env python3
"""Step 1 of the anchor package: repair the assembled VHF CT and its label maps.

A. Lumbar relabelling. The donor has six lumbar vertebrae; TotalSegmentator's
   five-lumbar scheme merges two bodies into "L1" and scatters "L2". The discs
   between T12 and the sacrum are located on an oblique density profile along
   the vertebral-body centreline, and every voxel TotalSegmentator called
   L1..L5 / S1 / sacrum is reassigned by a seeded watershed (seeds = vertebral
   bodies between consecutive disc planes, flooding the bone mask from thick to
   thin so borders fall on the facet joints). T12 and above are left untouched.
   Output labels: L1..L5 keep their TotalSegmentator ids, L6 gets id 118, and
   TotalSegmentator's S1 is merged into the sacrum.

B. Mid-thigh seam. Exam 370 (head-first, files <= 1985) and exam 371
   (feet-first, files >= 1986) are offset in-plane. The rigid 2-D transform
   lower -> upper is estimated from the two femoral shafts (cortex centroids,
   linearly extrapolated to the seam from 8 slices on each side) and applied to
   every slice of the lower exam: CT with linear, labels with nearest-neighbour
   interpolation. Residuals are measured on bone and on the skin outline.

Usage:
  python -I fix_volume.py CT.nii.gz SEG_DIR MOOSE_SEG.nii.gz OUT_DIR [DISC_Z,DISC_Z,...]
The optional list forces the seven disc slice indices (T12/L1 ... L6/S1) if detection fails.
SEG_DIR holds total.nii.gz, body.nii.gz, ... from TotalSegmentator.
Writes OUT_DIR/ct_fixed.nii.gz, OUT_DIR/seg/<task>.nii.gz, OUT_DIR/fix_report.json.
"""
import glob
import json
import os
import sys

import nibabel as nib
import numpy as np
from scipy import ndimage as ndi
from scipy import signal
from skimage.segmentation import watershed
from totalsegmentator.map_to_binary import class_map

SEAM_Z = 748          # highest slice index of the lower exam (file c_vf1986); z index = 2734 - file number
L6_ID = 118


def relabel_lumbar(ct, lab, rep, forced=None):
    cm = {v: k for k, v in class_map["total"].items()}
    cord = lab == cm["spinal_cord"]
    z0, z1 = 940, 1245
    zs = np.arange(z0, z1)
    canal = np.array([ndi.center_of_mass(cord[:, :, z]) if cord[:, :, z].any() else (np.nan, np.nan) for z in zs])
    ok = ~np.isnan(canal[:, 0])
    for k in range(2):  # extend the canal track below the end of the cord label
        canal[:, k] = np.interp(zs, zs[ok], canal[ok, k])
    ids = [cm[f"vertebrae_{n}"] for n in ("T11", "T12", "L1", "L2", "L3", "L4", "L5", "S1")] + [cm["sacrum"]]
    union = np.isin(lab[:, :, z0:z1], ids)
    # vertebral-body track: union voxels anterior to the canal, near the midline
    track = np.full((len(zs), 2), np.nan)
    ii, jj = np.mgrid[0:lab.shape[0], 0:lab.shape[1]]
    for n in range(len(zs)):
        m = union[:, :, n] & (jj > canal[n, 1] + 7) & (np.abs(ii - canal[n, 0]) < 24)
        if m.sum() > 150:
            track[n] = ndi.center_of_mass(m)
    ok = ~np.isnan(track[:, 0])
    for k in range(2):
        track[:, k] = ndi.gaussian_filter1d(np.interp(zs, zs[ok], track[ok, k]), 7)
    tang = np.c_[np.gradient(track[:, 0]), np.gradient(track[:, 1]), np.ones(len(zs))]
    tang /= np.linalg.norm(tang, axis=1)[:, None]
    # The donor's trabecular bone is as radiolucent as her discs (~90 HU), so discs are not density
    # minima. The cortical endplates are the signal: on an oblique profile (90th-percentile HU on a
    # 12 mm disc perpendicular to the track) each disc is a dark centre between two endplate peaks.
    ang = np.linspace(0, 2 * np.pi, 32, endpoint=False)
    prof = np.empty(len(zs))
    for n in range(len(zs)):
        t = tang[n]
        u = np.cross(t, [0, 0, 1.0])
        u = u / np.linalg.norm(u) if np.linalg.norm(u) > 1e-6 else np.array([1.0, 0, 0])
        v = np.cross(t, u)
        pts = [np.array([track[n, 0], track[n, 1], zs[n]])]
        for r in (2, 4, 6, 8, 10, 12):
            pts += [pts[0] + r * (np.cos(a) * u + np.sin(a) * v) for a in ang]
        prof[n] = np.percentile(ndi.map_coordinates(ct, np.array(pts).T, order=1), 90)
    prof = ndi.gaussian_filter1d(prof, 1.0)
    t12 = lab[:, :, z0:z1] == cm["vertebrae_T12"]
    t12_z = zs[np.where(t12.any((0, 1)))[0]]
    t12_mid = int(np.round(ndi.center_of_mass(t12)[2])) + z0
    sac_top = int(np.where((lab == cm["sacrum"]).any((0, 1)))[0].max())
    # disc score: a bright endplate 3-8 mm above AND below a darker centre
    score = np.zeros(len(zs))
    for n in range(9, len(zs) - 9):
        score[n] = min(prof[n + 3:n + 9].max(), prof[n - 8:n - 2].max()) - prof[n]
    peaks, _ = signal.find_peaks(score, distance=24, height=40)
    pz = sorted((int(zs[k]) for k in peaks), reverse=True)
    discs = forced or [d for d in pz if sac_top - 25 < d < t12_mid]
    rep["lumbar"] = {"t12_body_centre_z": t12_mid, "disc_candidates_z": pz, "disc_z_below_T12_centre": discs,
                     "detection": "forced" if forced else "endplate-pair score on oblique profile",
                     "body_heights_mm": [a - b for a, b in zip(discs[:-1], discs[1:])]}
    if len(discs) != 7:
        raise SystemExit(f"expected 7 discs between T12 and the sacrum, found {len(discs)}: {discs}; peaks {pz}")

    def signed(di):  # signed distance field to the disc plane (positive = superior side)
        n = di - z0
        p = np.array([track[n, 0], track[n, 1], di], dtype=float)
        t = tang[n]
        return lambda I, J, K: (I - p[0]) * t[0] + (J - p[1]) * t[1] + (K - p[2]) * t[2]

    relab = [cm[f"vertebrae_L{i}"] for i in range(1, 6)] + [cm["vertebrae_S1"], cm["sacrum"]]
    dom = np.isin(lab[:, :, z0:z1], relab)
    I, J, K = np.nonzero(dom)
    Kz = K + z0
    sd = np.array([signed(d)(I, J, Kz) for d in discs])       # 7 x N
    # radial distance to the body track at the voxel's own z
    rad = np.hypot(I - track[K, 0], J - track[K, 1])
    markers = np.zeros(dom.shape, dtype=np.int16)
    new_ids = [cm[f"vertebrae_L{i}"] for i in range(1, 6)] + [L6_ID]
    for seg in range(6):
        s = (sd[seg] < -3) & (sd[seg + 1] > 3) & (rad < 15)
        markers[I[s], J[s], K[s]] = new_ids[seg]
    s = (sd[6] < -4) & (rad < 16) | (sd[6] < -30)
    markers[I[s], J[s], K[s]] = cm["sacrum"]
    edt = ndi.distance_transform_edt(dom)
    out = watershed(-edt, markers, mask=dom)
    block = lab[:, :, z0:z1].copy()
    block[dom] = out[dom]
    lab[:, :, z0:z1] = block
    names = [f"L{i}" for i in range(1, 7)] + ["sacrum"]
    rep["lumbar"]["volumes_ml"] = {n: round(float((lab == i).sum()) / 1000, 1) for n, i in zip(names, new_ids + [cm["sacrum"]])}
    rep["lumbar"]["z_ranges"] = {}
    for n, i in zip(names, new_ids + [cm["sacrum"]]):
        z = np.where((lab[:, :, 850:1260] == i).any((0, 1)))[0] + 850
        rep["lumbar"]["z_ranges"][n] = [int(z.min()), int(z.max())]
    rep["lumbar"]["t12_z_range"] = [int(t12_z.min()), int(t12_z.max())]
    return lab


def cortex_centroids(ct, lab, ids, zs):
    out = {}
    for side, i in ids.items():
        pts = []
        for z in zs:
            m = (lab[:, :, z] == i) & (ct[:, :, z] > 250)
            pts.append(ndi.center_of_mass(m) if m.sum() > 50 else (np.nan, np.nan))
        out[side] = np.array(pts)
    return out


def extrapolate(zs, pts, z_at):
    return np.array([np.polyval(np.polyfit(zs, pts[:, k], 1), z_at) for k in range(2)])


def body_outline(ct_slice, body_slice):
    """skin outline from the CT itself (the `body` label map is upsampled from 1.5 mm, so adjacent
    slices are often identical); the label only serves to exclude the scanner table"""
    m = (ct_slice > -300) & ndi.binary_dilation(body_slice > 0, iterations=4)
    m = ndi.binary_fill_holes(ndi.binary_opening(m, iterations=2))
    return m & ~ndi.binary_erosion(m)


def outline_distance(a, b):
    """mean symmetric distance (voxels = mm) between two binary outlines"""
    da = ndi.distance_transform_edt(~a)
    db = ndi.distance_transform_edt(~b)
    return float((db[a].mean() + da[b].mean()) / 2)


def seam_transform(ct, lab, body, rep):
    cm = {v: k for k, v in class_map["total"].items()}
    ids = {"left": cm["femur_left"], "right": cm["femur_right"]}
    n = 8
    zl = np.arange(SEAM_Z - n + 1, SEAM_Z + 1)
    zu = np.arange(SEAM_Z + 1, SEAM_Z + 1 + n)
    cl, cu = cortex_centroids(ct, lab, ids, zl), cortex_centroids(ct, lab, ids, zu)
    zmid = SEAM_Z + 0.5
    pl = np.array([extrapolate(zl, cl[s], zmid) for s in ("left", "right")])
    pu = np.array([extrapolate(zu, cu[s], zmid) for s in ("left", "right")])
    dl, du = pl[1] - pl[0], pu[1] - pu[0]
    theta = np.arctan2(du[1], du[0]) - np.arctan2(dl[1], dl[0])
    R = np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]])
    t = pu.mean(0) - R @ pl.mean(0)          # x_upper = R x_lower + t   (voxel = mm units)
    res = pu - (pl @ R.T + t)
    rep["seam"] = {
        "seam_between_slices": [SEAM_Z, SEAM_Z + 1], "files": ["c_vf1986 (exam 371)", "c_vf1985 (exam 370)"],
        "femur_centres_lower_vox": pl.round(2).tolist(), "femur_centres_upper_vox": pu.round(2).tolist(),
        "per_femur_jump_mm_before": (pu - pl).round(2).tolist(),
        "rotation_deg": round(float(np.degrees(theta)), 3), "translation_vox_mm": t.round(2).tolist(),
        "shift_at_volume_centre_mm": (R @ np.array([239.5, 239.5]) + t - 239.5).round(2).tolist(),
        "femur_separation_mm": [round(float(np.linalg.norm(dl)), 2), round(float(np.linalg.norm(du)), 2)],
        "per_femur_residual_mm_after": res.round(2).tolist(),
    }
    return R, t


def apply_lower(vol, R, t, order):
    """resample slices 0..SEAM_Z so that output(x_upper) = input(R^-1 (x_upper - t))"""
    Rinv = R.T
    off = -Rinv @ t
    for z in range(SEAM_Z + 1):
        vol[:, :, z] = ndi.affine_transform(vol[:, :, z], Rinv, offset=off, order=order, mode="constant",
                                            cval=-1024 if order else 0)
    return vol


def main():
    ct_path, seg_dir, moose_path, out = sys.argv[1:5]
    os.makedirs(os.path.join(out, "seg"), exist_ok=True)
    rep = {}
    img = nib.load(ct_path)
    ct = np.asarray(img.dataobj).astype(np.int16)
    total = np.asarray(nib.load(os.path.join(seg_dir, "total.nii.gz")).dataobj).astype(np.int16)
    body = np.asarray(nib.load(os.path.join(seg_dir, "body.nii.gz")).dataobj).astype(np.uint8)

    forced = [int(x) for x in sys.argv[5].split(',')] if len(sys.argv) > 5 else None
    total = relabel_lumbar(ct, total, rep, forced)
    R, t = seam_transform(ct, total, body, rep)

    # skin residuals: outline distance across the seam before / after, and the within-exam baseline
    o = lambda z, b=body: body_outline(ct[:, :, z], b[:, :, z])
    base = [outline_distance(o(z), o(z + 1)) for z in list(range(SEAM_Z - 6, SEAM_Z)) + list(range(SEAM_Z + 1, SEAM_Z + 7))]
    before = outline_distance(o(SEAM_Z), o(SEAM_Z + 1))
    bone = lambda z, v=ct: v[:, :, z] > 250
    bone_base = [outline_distance(bone(z), bone(z + 1)) for z in list(range(SEAM_Z - 6, SEAM_Z)) + list(range(SEAM_Z + 1, SEAM_Z + 7))]
    bone_before = outline_distance(bone(SEAM_Z), bone(SEAM_Z + 1))

    ct = apply_lower(ct, R, t, 1)
    body = apply_lower(body, R, t, 0)
    total = apply_lower(total, R, t, 0)
    rep["seam"].update({
        "skin_outline_mean_distance_mm": {"across_seam_before": round(before, 2),
                                          "across_seam_after": round(outline_distance(o(SEAM_Z), o(SEAM_Z + 1)), 2),
                                          "adjacent_slices_baseline": round(float(np.mean(base)), 2)},
        "bone_mask_mean_distance_mm": {"across_seam_before": round(bone_before, 2),
                                       "across_seam_after": round(outline_distance(bone(SEAM_Z), bone(SEAM_Z + 1)), 2),
                                       "adjacent_slices_baseline": round(float(np.mean(bone_base)), 2)},
    })
    nib.save(nib.Nifti1Image(ct, img.affine), os.path.join(out, "ct_fixed.nii.gz"))
    nib.save(nib.Nifti1Image(total, img.affine), os.path.join(out, "seg", "total.nii.gz"))
    nib.save(nib.Nifti1Image(body, img.affine), os.path.join(out, "seg", "body.nii.gz"))
    # every other label map: only the seam transform applies
    others = [p for p in glob.glob(os.path.join(seg_dir, "*.nii.gz"))
              if os.path.basename(p) not in ("total.nii.gz", "body.nii.gz", "limb_bones_threshold.nii.gz")]
    for p, name in [(q, os.path.basename(q)) for q in others] + [(moose_path, "moose_peripheral_bones.nii.gz")]:
        v = np.asarray(nib.as_closest_canonical(nib.load(p)).dataobj).astype(np.int16)
        assert v.shape == ct.shape, (p, v.shape)
        nib.save(nib.Nifti1Image(apply_lower(v, R, t, 0), img.affine), os.path.join(out, "seg", name))
    json.dump(rep, open(os.path.join(out, "fix_report.json"), "w"), indent=1)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
