#!/usr/bin/env python3
"""Convert a multi-label NIfTI segmentation into one surface mesh per label.

Marching cubes on a lightly Gaussian-smoothed binary mask (keeps sub-voxel
smooth surfaces without shrinking much), vertices in NIfTI world mm (RAS+).
Writes per-label OBJ files, one combined GLB (node name = class name) and a
TSV with voxel volume, triangle count, bbox, connected-component count and
whether the mask touches the volume border (= structure truncated by FOV).

Usage:
  python -I labels_to_meshes.py LABELS.nii.gz OUT_DIR --task total [--sigma 0.8] [--decimate 0.25]
  python -I labels_to_meshes.py MASK.nii.gz OUT_DIR --names 1=body 2=extremities
"""
import argparse
import os

import nibabel as nib
import numpy as np
import trimesh
from scipy import ndimage as ndi
from skimage import measure


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("labels")
    ap.add_argument("out")
    ap.add_argument("--task")
    ap.add_argument("--names", nargs="*")
    ap.add_argument("--sigma", type=float, default=0.8, help="Gaussian sigma in voxels")
    ap.add_argument("--decimate", type=float, default=0.0, help="keep fraction of faces (needs fast-simplification)")
    ap.add_argument("--no-obj", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    img = nib.as_closest_canonical(nib.load(a.labels))
    lab = np.asarray(img.dataobj).astype(np.int16)
    aff = img.affine
    vox = np.abs(np.diag(aff)[:3])
    if a.task:
        from totalsegmentator.map_to_binary import class_map
        names = dict(class_map[a.task])
    else:
        names = {int(k): v for k, v in (s.split("=") for s in (a.names or []))}
    objs = ndi.find_objects(lab, max_label=int(lab.max()))
    scene = trimesh.Scene()
    rows = []
    for i, sl in enumerate(objs, 1):
        name = names.get(i, f"label_{i}")
        if sl is None:
            rows.append((i, name, 0, 0, 0, "", "", "", "", "", "", 0, ""))
            continue
        pad = 4
        sl2 = tuple(slice(max(0, s.start - pad), min(n, s.stop + pad)) for s, n in zip(sl, lab.shape))
        m = lab[sl2] == i
        nvox = int(m.sum())
        ncc = ndi.label(m)[1]
        touches = [ax for ax, (s, n) in enumerate(zip(sl, lab.shape)) if s.start == 0 or s.stop == n]
        f = ndi.gaussian_filter(np.pad(m, 1).astype(np.float32), a.sigma)
        try:
            v, faces, _, _ = measure.marching_cubes(f, 0.5)
        except (ValueError, RuntimeError):
            rows.append((i, name, nvox, 0, 0, "", "", "", "", "", "", ncc, "nomesh"))
            continue
        v = v - 1 + np.array([s.start for s in sl2])
        v = nib.affines.apply_affine(aff, v)
        mesh = trimesh.Trimesh(v, faces[:, ::-1] if np.linalg.det(aff[:3, :3]) < 0 else faces, process=False)
        if a.decimate and len(mesh.faces) > 2000:
            mesh = mesh.simplify_quadric_decimation(face_count=int(len(mesh.faces) * a.decimate))
        if not a.no_obj:
            mesh.export(os.path.join(a.out, f"{i:03d}_{name}.obj"))
        scene.add_geometry(mesh, node_name=name, geom_name=name)
        lo, hi = mesh.bounds
        rows.append((i, name, nvox, round(nvox * float(np.prod(vox)) / 1000, 1), len(mesh.faces),
                     *lo.round(1), *hi.round(1), ncc, "xyz"[touches[0]] + "-border" if touches else ""))
    scene.export(os.path.join(a.out, "all.glb"))
    with open(os.path.join(a.out, "meshes.tsv"), "w") as fh:
        fh.write("label\tname\tvoxels\tvolume_ml\ttris\tminx\tminy\tminz\tmaxx\tmaxy\tmaxz\tcomponents\tnote\n")
        for r in rows:
            fh.write("\t".join(map(str, r)) + "\n")
    present = [r for r in rows if r[2]]
    print(f"labels defined {len(names)} | present {len(present)} | missing:",
          [r[1] for r in rows if not r[2]] + [n for k, n in names.items() if k > len(objs)])
    print("triangles total", sum(r[4] for r in rows))


if __name__ == "__main__":
    main()
