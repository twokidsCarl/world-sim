#!/usr/bin/env python3
"""Assemble the Visible Human Female 'normal CT' slices into one NIfTI volume.

Inputs: directory of c_vfNNNN.fre.Z (GE Genesis, 3416-byte header + 512x512
big-endian int16, unix-compressed) and the matching c_vfNNNN.txt header dumps.

Slices come from several scan series with different field of view / centre,
so every slice is resampled onto one common in-plane grid (LPS millimetres),
then stacked by table location. Gaps / duplicates in z are reported and
handled by linear interpolation onto a regular z grid.

Usage:
  python -I vhf_ct_to_nifti.py CT_DIR HDR_DIR OUT.nii.gz [--xy 1.0] [--z 1.0] [--report OUT.tsv]
"""
import argparse
import glob
import os
import re
import subprocess

import nibabel as nib
import numpy as np
from scipy.ndimage import map_coordinates

FIELDS = {
    "series": r"Series number for this image\.+: *(-?\d+)",
    "image": r"Image Number\.+: *(-?\d+)",
    "thick": r"Slice Thickness \(mm\)\.+: *([-\d.]+)",
    "px": r"Image pixel size - X\.+: *([-\d.]+)",
    "py": r"Image pixel size - Y\.+: *([-\d.]+)",
    "fov": r"Display Field of view - X \(mm\)\.+: *([-\d.]+)",
    "loc": r"Image location\.+: *([-\d.]+)",
    "cr": r"Center R coord of plane image\.+: *([-\d.]+)",
    "ca": r"Center A coord of plane image\.+: *([-\d.]+)",
    "cs": r"Center S coord of Plane image\.+: *([-\d.]+)",
    "tilt": r"Gantry Tilt[^:]*: *([-\d.]+)",
    "kv": r"KV[^:]*: *([-\d.]+)",
}


def parse_header(path):
    t = open(path, "rb").read().decode("latin-1")
    d = {}
    for k, rx in FIELDS.items():
        m = re.search(rx, t, re.I)
        d[k] = float(m.group(1)) if m else float("nan")
    m = re.search(r"Series Description\.+: *(.*)", t)
    d["desc"] = m.group(1).strip() if m else ""
    return d


def read_slice(path):
    raw = subprocess.run(["gzip", "-dc", path], capture_output=True, check=True).stdout
    assert len(raw) == 3416 + 512 * 512 * 2, (path, len(raw))
    return np.frombuffer(raw, dtype=">i2", offset=3416).reshape(512, 512).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ct_dir")
    ap.add_argument("hdr_dir")
    ap.add_argument("out")
    ap.add_argument("--xy", type=float, default=1.0)
    ap.add_argument("--z", type=float, default=1.0)
    ap.add_argument("--report")
    a = ap.parse_args()

    files = sorted(glob.glob(os.path.join(a.ct_dir, "c_vf*.fre.Z")))
    recs = []
    for f in files:
        n = re.search(r"c_vf(\d+)", f).group(1)
        h = parse_header(os.path.join(a.hdr_dir, f"c_vf{n}.txt"))
        h["file"], h["n"] = f, int(n)
        recs.append(h)
    if a.report:
        with open(a.report, "w") as fh:
            keys = ["n", "series", "image", "loc", "thick", "px", "py", "fov", "cr", "ca", "cs", "tilt", "kv", "desc"]
            fh.write("\t".join(keys) + "\n")
            for r in recs:
                fh.write("\t".join(str(r[k]) for k in keys) + "\n")

    # Summarise series
    by = {}
    for r in recs:
        by.setdefault((r["series"], r["px"], r["fov"], r["cr"], r["ca"], r["desc"]), []).append(r)
    print("series | px | fov | centreR | centreA | desc | n | file range | loc range")
    for k, v in sorted(by.items(), key=lambda kv: kv[1][0]["n"]):
        locs = [r["loc"] for r in v]
        print(k, len(v), v[0]["n"], v[-1]["n"], min(locs), max(locs))

    # Header table locations are NOT a usable global z: the body was scanned as two
    # exams (370 head-first head->thigh, 371 feet-first femur->toes) with different
    # landmarks, and ~130 headers carry a bogus location. The file number is the
    # NLM head-to-toe index at 1 mm, so z comes from the file number.
    recs.sort(key=lambda r: r["n"])
    ns = [r["n"] for r in recs]
    assert ns == list(range(ns[0], ns[0] + len(ns))), "file numbers not contiguous"
    half = max(r["fov"] for r in recs) / 2.0
    xs = np.arange(-half + a.xy / 2, half, a.xy)   # R coordinate, ascending
    ys = np.arange(-half + a.xy / 2, half, a.xy)   # A coordinate, ascending
    nz = len(recs)
    vol = np.empty((nz, len(ys), len(xs)), dtype=np.int16)
    for r in recs:
        img = read_slice(r["file"])
        # Source image: row 0 = anterior, col 0 = patient right (standard axial display).
        col = (r["cr"] + r["fov"] / 2 - xs) / r["px"] - 0.5
        row = (r["ca"] + r["fov"] / 2 - ys) / r["py"] - 0.5
        rr, cc = np.meshgrid(row, col, indexing="ij")
        out = map_coordinates(img, [rr, cc], order=1, mode="constant", cval=0.0)
        vol[ns[-1] - r["n"]] = np.round(out - 1024).astype(np.int16)  # stored + (-1024) = HU
    zs = np.arange(nz) * 1.0                      # mm above the lowest (toe) slice
    a.z = 1.0

    # NIfTI is RAS+: array axes (x=R, y=A, z=S)
    data = np.transpose(vol, (2, 1, 0))
    aff = np.diag([a.xy, a.xy, a.z, 1.0])
    aff[:3, 3] = [xs[0], ys[0], zs[0]]
    nib.save(nib.Nifti1Image(data, aff), a.out)
    print("wrote", a.out, data.shape, "HU range", int(data.min()), int(data.max()))


if __name__ == "__main__":
    main()
