"""Export every mesh object of an AnatomyTool Open3DModel .blend (world space, modifiers
applied) with the pip `bpy` module.

Usage: <venv python> -I export_o3d.py <model.blend> <outdir>
Writes <outdir>/meshes.npz (v{i}, f{i}; Blender frame: metres, Z up) and index.json
(name, group = parent empty, counts, bbox).  upper-limb/hand need bpy 4.2+, lower-limb
(saved with Blender 5.2) needs bpy 5.2.
"""
import json
import os
import sys

import bpy
import numpy as np

src, outdir = sys.argv[1], sys.argv[2]
os.makedirs(outdir, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=src, use_scripts=False)
dg = bpy.context.evaluated_depsgraph_get()
arrays, index = {}, []
for i, o in enumerate(o for o in bpy.data.objects if o.type == "MESH"):
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    M = np.array(o.matrix_world, dtype=np.float64)
    rec = {"i": i, "name": o.name, "group": o.parent.name if o.parent else None,
           "modifiers": [m.type for m in o.modifiers], "nv": 0, "nf": 0}
    if me is not None and len(me.vertices):
        co = np.empty(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get("co", co)
        v = (co.reshape(-1, 3).astype(np.float64) @ M[:3, :3].T + M[:3, 3]).astype(np.float32)
        me.calc_loop_triangles()
        tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int32)
        me.loop_triangles.foreach_get("vertices", tri)
        ed = np.empty(len(me.edges) * 2, dtype=np.int32)
        me.edges.foreach_get("vertices", ed)
        arrays[f"v{i}"], arrays[f"f{i}"], arrays[f"e{i}"] = v, tri.reshape(-1, 3), ed.reshape(-1, 2)
        rec.update(nv=len(v), nf=len(tri) // 3, bbox_min=v.min(0).tolist(), bbox_max=v.max(0).tolist())
    ev.to_mesh_clear()
    index.append(rec)
np.savez_compressed(f"{outdir}/meshes.npz", **arrays)
json.dump(index, open(f"{outdir}/index.json", "w"))
print("exported", len(index), "meshes", sum(r["nv"] for r in index), "verts", sum(r["nf"] for r in index), "tris")
