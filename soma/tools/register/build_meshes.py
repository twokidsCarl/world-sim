#!/usr/bin/env python3
"""Step 2 of the anchor package: label maps (after fix_volume.py) -> one cleaned, smoothed,
decimated surface per anchor structure.

Per structure: stray components dropped, marching cubes on a lightly blurred mask (sigma 0.6-1.2
voxel), 12 Taubin iterations (lambda 0.5, mu -0.53) to remove the voxel staircase, quadric decimation to an
area-based triangle budget, then a sub-voxel normal offset that restores the voxel volume (thin
structures otherwise shrink by up to ~18 %). Volume is tracked at each stage.

Vertices are cached in scanner RAS millimetres (x = i - 239.5, y = j - 239.5, z = k for voxel
(i, j, k) of the fixed 1 mm volume); build_package.py converts to the soma convention.

Usage: python -I build_meshes.py WORK_DIR      (WORK_DIR = output of fix_volume.py)
Writes WORK_DIR/meshes.npz and WORK_DIR/meshes.json.
"""
import json
import os
import re
import sys

import nibabel as nib
import numpy as np
import trimesh
from scipy import ndimage as ndi
from totalsegmentator.map_to_binary import class_map

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import anchor_spec  # noqa: E402
from anchorlib import clean_mask, decimate, mask_to_mesh, sample_surface, signed_volume, surface_distance  # noqa: E402

BUDGET = {"bone": (2.0, 300, 30000), "bone-group": (1.5, 300, 30000), "cartilage": (2.0, 200, 20000),
          "tooth": (1.0, 200, 6000), "organ": (5.0, 300, 30000), "vessel": (2.0, 200, 12000),
          "muscle": (6.0, 300, 20000), "surface": (25.0, 2000, 80000)}   # mm^2 of surface per triangle, min, max


class Labels:
    def __init__(self, work):
        self.work, self.cache, self.maps = work, {}, {}
        for t in ("total", "body", "abdominal_muscles", "headneck_bones_vessels", "headneck_muscles", "breasts",
                  "craniofacial_structures"):
            self.maps[t] = {v: k for k, v in class_map[t].items()}
        self.maps["moose_peripheral_bones"] = {v: k for k, v in anchor_spec.MOOSE_MAP.items()}

    def vol(self, task):
        if task not in self.cache:
            self.cache[task] = np.asarray(nib.load(os.path.join(self.work, "seg", task + ".nii.gz")).dataobj).astype(np.int16)
        return self.cache[task]

    def box(self, task, name, pad=6):
        """(mask crop, origin) of one label"""
        v = self.vol(task)
        i = name if isinstance(name, int) else self.maps[task][name]
        key = (task, "objs")
        if key not in self.cache:
            self.cache[key] = ndi.find_objects(v, max_label=int(v.max()))
        sl = self.cache[key][i - 1] if i - 1 < len(self.cache[key]) else None
        if sl is None:
            return None, None
        sl = tuple(slice(max(0, s.start - pad), min(n, s.stop + pad)) for s, n in zip(sl, v.shape))
        return v[sl] == i, sl


def full(mask, sl, shape):
    out = np.zeros(shape, dtype=bool)
    out[sl] = mask
    return out


def crop(mask, pad=6):
    sl = ndi.find_objects(mask.astype(np.uint8))[0]
    sl = tuple(slice(max(0, s.start - pad), min(n, s.stop + pad)) for s, n in zip(sl, mask.shape))
    return mask[sl], sl


def derived(L, e):
    key, side = e["labels"][0], {"L": "left", "R": "right", "M": ""}[e["side"]]
    shape = L.vol("total").shape
    if key == "cranium":
        sk, sl = L.box("total", "skull")
        m = full(sk, sl, shape)
        md, sl2 = L.box("craniofacial_structures", "mandible")
        m &= ~full(ndi.binary_dilation(md, iterations=1), sl2, shape)
        return crop(m)
    if key.startswith("iliacus"):
        ip, sl = L.box("total", f"iliopsoas_{side}")
        m = full(ip, sl, shape)
        ps, sl2 = L.box("abdominal_muscles", f"psoas_major_{side}")
        m &= ~full(ndi.binary_dilation(ps, iterations=1), sl2, shape)
        return crop(ndi.binary_opening(m, iterations=1))
    if key.startswith("trapezius"):
        a, sl = L.box("abdominal_muscles", f"trapezius_{side}")
        b, sl2 = L.box("headneck_muscles", f"trapezius_{side}")
        return crop(full(a, sl, shape) | full(b, sl2, shape))
    if key == "body_surface":
        m = L.vol("body") > 0
        m = ndi.binary_closing(m, iterations=2)
        for z in range(m.shape[2]):
            m[:, :, z] = ndi.binary_fill_holes(m[:, :, z])
        return crop(m)
    if key.startswith("breast"):
        m = L.vol("breasts") > 0
        mid = int(round(ndi.center_of_mass(L.vol("total") == L.maps["total"]["sternum"])[0]))
        if side == "right":      # +x (increasing i) is patient right
            m[:mid] = False
        else:
            m[mid:] = False
        return crop(m)
    raise KeyError(key)


def main():
    work = sys.argv[1]
    L = Labels(work)
    spec = anchor_spec.build()
    arrays, stats = {}, {}
    for e in spec:
        lab0 = e["labels"][0]
        key = "vertebrae_L6" if lab0 == anchor_spec.L6_ID else str(lab0)
        iid = "VF_" + key
        if e["task"] == "derived":
            mask, sl = derived(L, e)
        else:
            mask, sl = L.box(e["task"], lab0)
            if mask is not None and e["task"] == "total" and re.match(r"(humerus|femur)_", str(lab0)):
                # TotalSegmentator's humerus / femur overlap MOOSE's ulna / radius / tibia / patella by up to
                # ~2 ml at the joint; MOOSE labels both sides of the joint jointly, so its voxels win.
                distal = [i for i, n in anchor_spec.MOOSE_MAP.items() if re.match(r"(ulna|radius|tibia|fibula|patella)_", n)]
                mask = mask & ~np.isin(L.vol("moose_peripheral_bones")[sl], distal)
        if mask is None or mask.sum() < 1000:
            print(f"skip {iid}: absent or < 1 ml")
            continue
        raw_vox = int(mask.sum())
        mask, removed, ncomp = clean_mask(mask, largest_only=e["kind"] == "surface" and key == "body_surface")
        vox = int(mask.sum())
        # field-of-view clipping: reconstruction circle (r = 240 voxels) or the volume faces
        I, J, K = np.nonzero(mask)
        I, J, K = I + sl[0].start, J + sl[1].start, K + sl[2].start
        r = np.hypot(I - 239.5, J - 239.5)
        edge = int(((r > 237.5) | (I <= 1) | (I >= 478) | (J <= 1) | (J >= 478)).sum())
        top = int((K >= 1732).sum())
        on_edge = (r > 237.5) | (I <= 1) | (I >= 478) | (J <= 1) | (J >= 478)
        edge_z = [int(K[on_edge].min()), int(K[on_edge].max())] if edge else None
        # share of the structure's cross-sections (slices) that touch the field-of-view edge
        edge_slices = round(len(np.unique(K[on_edge])) / len(np.unique(K)), 3) if edge else 0.0
        sigma = 1.2 if key == "body_surface" else 0.6 if e["kind"] in ("vessel", "tooth") else 0.7
        m0 = mask_to_mesh(mask, [s.start for s in sl], sigma=sigma, taubin=0)
        m1 = mask_to_mesh(mask, [s.start for s in sl], sigma=sigma, taubin=12)
        per, lo, hi = BUDGET[e["kind"]]
        m2 = decimate(m1.copy(), int(np.clip(m1.area / per, lo, hi)))
        v = np.asarray(m2.vertices) - np.array([239.5, 239.5, 0.0])        # voxel index -> RAS mm
        f = np.asarray(m2.faces)
        if signed_volume(v, f) < 0:
            f = f[:, ::-1]
        # Blur + Taubin + decimation still lose volume on thin structures (ribs lost ~18 %).
        # Restore it with a uniform offset along the vertex normals, d = (V_voxel - V_mesh) / area,
        # capped at +-0.5 mm: the surface moves back out by a fraction of a voxel, shape unchanged.
        tm = trimesh.Trimesh(v, f, process=False)
        offset = float(np.clip((vox - abs(signed_volume(v, f))) / tm.area, -0.5, 0.5))
        v = v + offset * np.asarray(tm.vertex_normals)
        dd = surface_distance(sample_surface(v + [239.5, 239.5, 0], f, 3000), np.asarray(m1.vertices))
        arrays[iid + "/v"], arrays[iid + "/f"] = v.astype(np.float32), f.astype(np.uint32)
        stats[iid] = {
            "voxels": vox, "volume_voxel_ml": round(vox / 1000, 2),
            "volume_marching_cubes_ml": round(abs(m0.volume) / 1000, 2),
            "volume_smoothed_ml": round(abs(m1.volume) / 1000, 2),
            "volume_final_ml": round(abs(signed_volume(v, f)) / 1000, 2),
            "triangles_before_decimation": int(len(m1.faces)), "triangles": int(len(f)),
            "decimation_error_mm": {"mean": round(float(dd.mean()), 3), "p95": round(float(np.quantile(dd, 0.95)), 3)},
            "normal_offset_mm": round(offset, 3), "components_kept": ncomp, "removed_stray_fraction": round(removed, 4),
            "raw_voxels": raw_vox, "fov_edge_voxels": edge, "fov_edge_z": edge_z, "fov_edge_slice_fraction": edge_slices, "z_range": [int(K.min()), int(K.max())], "top_slice_voxels": top, "watertight": bool(m2.is_watertight),
        }
        s = stats[iid]
        print(f"{iid:38s} {s['volume_voxel_ml']:9.1f} ml  mesh/voxel {s['volume_final_ml'] / max(s['volume_voxel_ml'], 1e-6):.3f}"
              f"  tris {s['triangles']:6d}  dec {s['decimation_error_mm']['mean']:.2f} mm  stray {removed:.3f}  edge {edge}")
    np.savez_compressed(os.path.join(work, "meshes.npz"), **arrays)
    json.dump(stats, open(os.path.join(work, "meshes.json"), "w"), indent=1)
    print("items", len(stats), "triangles", sum(s["triangles"] for s in stats.values()))


if __name__ == "__main__":
    main()
