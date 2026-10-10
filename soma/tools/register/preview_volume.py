#!/usr/bin/env python3
"""Write quick-look PNGs of a CT NIfTI (and optional label map): coronal and
sagittal bone MIPs plus a few axial slices. Assumes RAS+ array orientation.

Usage: python -I preview_volume.py CT.nii.gz OUT_PREFIX [LABELS.nii.gz]
"""
import sys

import nibabel as nib
import numpy as np
from PIL import Image


def norm(a, lo, hi):
    return (np.clip((a - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)


def main():
    ct = nib.as_closest_canonical(nib.load(sys.argv[1]))
    d = np.asarray(ct.dataobj)
    zoom = ct.header.get_zooms()[:3]
    pre = sys.argv[2]

    def save(img2d, name, sx, sy):
        im = Image.fromarray(img2d)
        w, h = im.size
        im = im.resize((max(1, int(w * sx)), max(1, int(h * sy))))
        im.save(f"{pre}_{name}.png")

    # coronal MIP: axes (x, z) -> image rows = z (superior at top)
    save(norm(d.max(axis=1).T[::-1], -200, 1500), "mip_coronal", zoom[0], zoom[2])
    save(norm(d.max(axis=0).T[::-1], -200, 1500), "mip_sagittal", zoom[1], zoom[2])
    save(norm(d[:, d.shape[1] // 2, :].T[::-1], -300, 500), "mid_coronal", zoom[0], zoom[2])
    for f in (0.1, 0.3, 0.45, 0.6, 0.75, 0.93):
        k = int(d.shape[2] * f)
        save(norm(d[:, :, k].T[::-1], -300, 500), f"axial_{k:04d}", zoom[0], zoom[1])
    if len(sys.argv) > 3:
        lab = np.asarray(nib.as_closest_canonical(nib.load(sys.argv[3])).dataobj)
        rng = np.random.default_rng(0)
        lut = rng.integers(40, 255, size=(int(lab.max()) + 1, 3), dtype=np.uint8)
        lut[0] = 0
        # coronal projection: front-most (max y) non-zero label along A-P
        for name, axis in (("coronal", 1), ("sagittal", 0)):
            nz = lab > 0
            idx = nz.shape[axis] - 1 - np.argmax(np.flip(nz, axis=axis), axis=axis)
            proj = np.take_along_axis(lab, np.expand_dims(idx, axis), axis=axis).squeeze(axis)
            proj[~nz.any(axis=axis)] = 0
            rgb = lut[proj.T[::-1]]
            im = Image.fromarray(rgb)
            w, h = im.size
            sx = zoom[0] if axis == 1 else zoom[1]
            im.resize((int(w * sx), int(h * zoom[2])), Image.NEAREST).save(f"{pre}_labels_{name}.png")


if __name__ == "__main__":
    main()
