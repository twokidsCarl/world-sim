#!/usr/bin/env python3
"""Inventory a GLB without loading geometry into a scene library.

Parses the glTF JSON chunk + accessors directly, walks the node tree with
world transforms, and writes one TSV row per mesh-bearing node:
  path, node name, mesh name, triangles, vertices, world bbox min/max (xyz).

Usage: python -I inspect_glb.py FILE.glb OUT.tsv
"""
import json
import struct
import sys

import numpy as np


def load(path):
    with open(path, "rb") as f:
        magic, ver, length = struct.unpack("<4sII", f.read(12))
        assert magic == b"glTF", magic
        clen, ctype = struct.unpack("<II", f.read(8))
        assert ctype == 0x4E4F534A
        gltf = json.loads(f.read(clen))
        rest = f.read(8)
        binlen = struct.unpack("<II", rest)[0] if rest else 0
    return gltf, ver, length, binlen


def node_matrix(n):
    if "matrix" in n:
        return np.array(n["matrix"], dtype=float).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in n:
        m = np.diag(list(n["scale"]) + [1.0]) @ m
    if "rotation" in n:
        x, y, z, w = n["rotation"]
        r = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
            [0, 0, 0, 1]])
        m = r @ m
    if "translation" in n:
        t = np.eye(4)
        t[:3, 3] = n["translation"]
        m = t @ m
    return m


def main():
    path, out = sys.argv[1], sys.argv[2]
    g, ver, length, binlen = load(path)
    acc, meshes, nodes = g.get("accessors", []), g.get("meshes", []), g.get("nodes", [])
    print(f"glTF v{ver} bytes={length} bin={binlen}")
    print("asset:", g.get("asset"))
    print("extensionsUsed:", g.get("extensionsUsed"), "required:", g.get("extensionsRequired"))
    print(f"scenes={len(g.get('scenes', []))} nodes={len(nodes)} meshes={len(meshes)} "
          f"materials={len(g.get('materials', []))} textures={len(g.get('textures', []))} "
          f"skins={len(g.get('skins', []))} animations={len(g.get('animations', []))}")
    rows, tot_t, tot_v = [], 0, 0
    gmin, gmax = np.full(3, np.inf), np.full(3, -np.inf)

    def walk(i, parent, pathnames):
        nonlocal tot_t, tot_v, gmin, gmax
        n = nodes[i]
        m = parent @ node_matrix(n)
        names = pathnames + [n.get("name", f"node{i}")]
        if "mesh" in n:
            me = meshes[n["mesh"]]
            tris = verts = 0
            lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
            for p in me["primitives"]:
                pa = acc[p["attributes"]["POSITION"]]
                verts += pa["count"]
                cnt = acc[p["indices"]]["count"] if "indices" in p else pa["count"]
                if p.get("mode", 4) == 4:
                    tris += cnt // 3
                if "min" in pa:
                    a, b = pa["min"], pa["max"]
                    corners = np.array([[x, y, z, 1] for x in (a[0], b[0])
                                        for y in (a[1], b[1]) for z in (a[2], b[2])])
                    w = (m @ corners.T).T[:, :3]
                    lo, hi = np.minimum(lo, w.min(0)), np.maximum(hi, w.max(0))
            tot_t += tris
            tot_v += verts
            gmin, gmax = np.minimum(gmin, lo), np.maximum(gmax, hi)
            rows.append(("/".join(names[:-1]), names[-1], me.get("name", ""), tris, verts,
                         *[f"{v:.5f}" for v in lo], *[f"{v:.5f}" for v in hi]))
        for c in n.get("children", []):
            walk(c, m, names)

    sc = g["scenes"][g.get("scene", 0)]
    for r in sc["nodes"]:
        walk(r, np.eye(4), [])
    with open(out, "w") as f:
        f.write("path\tnode\tmesh\ttris\tverts\tminx\tminy\tminz\tmaxx\tmaxy\tmaxz\n")
        for r in rows:
            f.write("\t".join(map(str, r)) + "\n")
    print(f"mesh nodes={len(rows)} triangles={tot_t} vertices={tot_v}")
    print("world bbox min", gmin.round(4), "max", gmax.round(4), "extent", (gmax - gmin).round(4))
    print("root nodes:", [nodes[r].get("name") for r in sc["nodes"]])
    for r in sc["nodes"]:
        kids = nodes[r].get("children", [])
        print(f"  {nodes[r].get('name')}: {len(kids)} children; TRS keys",
              [k for k in nodes[r] if k in ("matrix", "translation", "rotation", "scale")])


if __name__ == "__main__":
    main()
