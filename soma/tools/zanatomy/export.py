"""Export evaluated (modifiers applied, curves bevelled) world-space geometry from a
Z-Anatomy .blend using the pip `bpy` module (no Blender app).

Usage: .venv/bin/python -I export.py <Startup.blend> <outdir> [--systems 1,7,...]

Writes <outdir>/meshes.npz  (per object i: v{i} float32 (n,3) metres, f{i} int32 (m,3))
       <outdir>/index.json  (name, system, type, counts, bbox, curve centrelines)

Everything is linked into a scratch scene first so that objects in excluded/hidden
collections are still evaluated by the depsgraph. Embedded scripts are not run.
"""
import json
import re
import sys

import bpy
import numpy as np

src, outdir = sys.argv[1], sys.argv[2]
want = None
if "--systems" in sys.argv:
    want = set(sys.argv[sys.argv.index("--systems") + 1].split(","))

bpy.ops.wm.open_mainfile(filepath=src, use_scripts=False)
main = bpy.context.scene

LABEL = re.compile(r"\.(j|i|t|s|g|st)$")  # label lines / text / group empties

system_of = {}
for col in main.collection.children:
    m = re.match(r"(\d): ", col.name)
    if not m:
        continue
    for ob in col.objects:
        system_of.setdefault(ob.name, col.name)

targets = [o for o in bpy.data.objects
           if o.type in ("MESH", "CURVE") and o.name in system_of
           and not LABEL.search(o.name)
           and (want is None or system_of[o.name][0] in want)]
print("targets", len(targets), flush=True)

scratch = bpy.data.scenes.new("zz_export")
for o in targets:
    scratch.collection.objects.link(o)
    o.hide_viewport = False
vl = scratch.view_layers[0]
vl.update()
dg = vl.depsgraph

arrays, index = {}, []
for i, o in enumerate(targets):
    rec = {"i": i, "name": o.name, "system": system_of[o.name], "type": o.type,
           "modifiers": [m.type for m in o.modifiers],
           "parent": o.parent.name if o.parent else None}
    ev = o.evaluated_get(dg)
    try:
        me = ev.to_mesh()
    except RuntimeError as e:
        rec["error"] = str(e)
        index.append(rec)
        continue
    M = np.array(ev.matrix_world, dtype=np.float64)
    if me is not None and len(me.vertices):
        co = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get("co", co)
        v = (co.reshape(-1, 3).astype(np.float64) @ M[:3, :3].T + M[:3, 3]).astype(np.float32)
        me.calc_loop_triangles()
        tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int32)
        me.loop_triangles.foreach_get("vertices", tri)
        arrays[f"v{i}"] = v
        arrays[f"f{i}"] = tri.reshape(-1, 3)
        if o.type == "CURVE":  # true (untriangulated) edges, used to recover ring structure / centrelines
            ed = np.empty(len(me.edges) * 2, dtype=np.int32)
            me.edges.foreach_get("vertices", ed)
            arrays[f"e{i}"] = ed.reshape(-1, 2)
        rec.update(nv=len(v), nf=len(tri) // 3, bbox_min=v.min(0).tolist(), bbox_max=v.max(0).tolist())
    else:
        rec.update(nv=0, nf=0)
    ev.to_mesh_clear()
    if o.type == "CURVE":
        cu = o.data
        Mo = np.array(o.matrix_world, dtype=np.float64)
        splines = []
        for sp in cu.splines:
            if sp.type == "BEZIER":
                pts = [(list(p.co), p.radius) for p in sp.bezier_points]
            else:
                pts = [(list(p.co)[:3], p.radius) for p in sp.points]
            P = np.array([p for p, _ in pts], dtype=np.float64).reshape(-1, 3)
            P = P @ Mo[:3, :3].T + Mo[:3, 3]
            splines.append({"type": sp.type, "cyclic": bool(sp.use_cyclic_u),
                            "points": np.round(P, 5).tolist(),
                            "radius": [round(float(r), 4) for _, r in pts]})
        rec.update(bevel_depth=cu.bevel_depth, splines=splines)
    index.append(rec)
    if i % 500 == 0:
        print(i, o.name, flush=True)

np.savez_compressed(f"{outdir}/meshes.npz", **arrays)
json.dump(index, open(f"{outdir}/index.json", "w"))
print("exported", sum(1 for r in index if r.get("nv")), "non-empty of", len(index),
      "verts", sum(r.get("nv", 0) for r in index), "tris", sum(r.get("nf", 0) for r in index))
