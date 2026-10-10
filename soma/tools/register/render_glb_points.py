#!/usr/bin/env python3
"""Cheap front/side point-splat render of selected GLB nodes (no GL needed).

Usage: python -I render_glb_points.py [--zup] FILE.glb[,FILE2.glb] OUT.png REGEX_GREY [REGEX_COLOUR ...]
--zup: input is RAS millimetres (x=right, y=anterior, z=up), e.g. meshes from labels_to_meshes.py.
The first regex is drawn in grey (e.g. skin); each further regex gets a colour.
Front view (x right = patient left for a +Z-facing body, y up) and side view (z, y).
"""
import re
import sys

import numpy as np
import trimesh
from PIL import Image

COLS = [(120, 120, 120), (255, 230, 150), (255, 90, 90), (90, 170, 255), (120, 255, 140), (255, 120, 255)]


def main():
    argv = [x for x in sys.argv[1:] if x != "--zup"]
    zup = "--zup" in sys.argv
    paths, out, pats = argv[0].split(","), argv[1], [re.compile(p) for p in argv[2:]]
    groups = [[] for _ in pats]
    for path in paths:
        sc = trimesh.load(path, force="scene", process=False)
        for node in sc.graph.nodes_geometry:
            tf, gname = sc.graph[node]
            for i, p in enumerate(pats):
                if p.search(node) or p.search(gname):
                    v = trimesh.transformations.transform_points(sc.geometry[gname].vertices, tf)
                    if zup:  # RAS -> (x = patient left, y = up, z = anterior)
                        v = np.column_stack([-v[:, 0], v[:, 2], v[:, 1]])
                    groups[i].append(v)
                    break
    allv = np.vstack([np.vstack(g) for g in groups if g])
    lo, hi = allv.min(0), allv.max(0)
    scale = 1400 / (hi[1] - lo[1])
    w1 = int((hi[0] - lo[0]) * scale) + 20
    w2 = int((hi[2] - lo[2]) * scale) + 20
    img = np.zeros((1420, w1 + w2, 3), dtype=np.uint8)
    for i, g in enumerate(groups):
        if not g:
            print("no match for", pats[i].pattern)
            continue
        v = np.vstack(g)
        print(pats[i].pattern, "verts", len(v), "bbox", v.min(0).round(3), v.max(0).round(3))
        y = (1410 - (v[:, 1] - lo[1]) * scale).astype(int)
        x = (10 + (v[:, 0] - lo[0]) * scale).astype(int)
        z = (w1 + 10 + (v[:, 2] - lo[2]) * scale).astype(int)
        c = np.array(COLS[i % len(COLS)], dtype=np.uint8)
        if i == 0:
            img[y, x] = np.maximum(img[y, x], c // 2)
            img[y, z] = np.maximum(img[y, z], c // 2)
        else:
            img[y, x] = c
            img[y, z] = c
    Image.fromarray(img).save(out)


if __name__ == "__main__":
    main()
