"""Inventory a Z-Anatomy .blend with the pip `bpy` module (no Blender app).

Usage: .venv/bin/python -I inventory.py <Startup.blend> <out.json>
Scripts embedded in the .blend are NOT executed (use_scripts=False).
"""
import json
import sys
from collections import Counter

import bpy

src, out = sys.argv[1], sys.argv[2]
bpy.ops.wm.open_mainfile(filepath=src, use_scripts=False)

print("blender", bpy.app.version_string, "file saved with", bpy.data.version)
scene = bpy.context.scene
us = scene.unit_settings
print("units", us.system, us.scale_length, us.length_unit)
print("scenes", [s.name for s in bpy.data.scenes])
print("counts", {k: len(getattr(bpy.data, k)) for k in
                 ("objects", "meshes", "curves", "collections", "materials", "texts", "armatures", "fonts")})

# collection paths
parent_of = {}
for c in bpy.data.collections:
    for ch in c.children:
        parent_of[ch.name] = c.name
for ch in scene.collection.children:
    parent_of.setdefault(ch.name, None)


def cpath(name):
    p = []
    while name is not None:
        p.append(name)
        name = parent_of.get(name)
    return "/".join(reversed(p))


objs = []
for o in bpy.data.objects:
    cols = [cpath(c.name) for c in o.users_collection]
    rec = {
        "name": o.name,
        "type": o.type,
        "data": o.data.name if o.data else None,
        "parent": o.parent.name if o.parent else None,
        "collections": cols,
        "matrix_world": [list(r) for r in o.matrix_world],
        "modifiers": [m.type for m in o.modifiers],
        "props": {k: (v if isinstance(v, (int, float, str)) else str(v)) for k, v in o.items()},
        "hide_viewport": o.hide_viewport,
        "materials": [s.material.name for s in o.material_slots if s.material],
    }
    if o.type == "MESH":
        me = o.data
        rec["nverts"] = len(me.vertices)
        rec["npolys"] = len(me.polygons)
        rec["data_users"] = me.users
        if len(me.vertices):
            import numpy as np
            co = np.empty(len(me.vertices) * 3, dtype=np.float32)
            me.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            M = np.array(o.matrix_world)
            w = co @ M[:3, :3].T + M[:3, 3]
            rec["bbox_min"] = w.min(0).tolist()
            rec["bbox_max"] = w.max(0).tolist()
            rec["centroid"] = w.mean(0).tolist()
    elif o.type == "CURVE":
        cu = o.data
        rec["splines"] = len(cu.splines)
        rec["bevel_depth"] = cu.bevel_depth
        rec["bevel_object"] = cu.bevel_object.name if cu.bevel_object else None
        rec["extrude"] = cu.extrude
    elif o.type == "FONT":
        pass  # o.data.body segfaults in bpy 4.2.23 on this file; label text == object name
    objs.append(rec)

texts = {t.name: len(t.as_string()) for t in bpy.data.texts}
json.dump({
    "blender": bpy.app.version_string,
    "file_version": list(bpy.data.version),
    "unit_scale": us.scale_length,
    "collections": sorted(cpath(c.name) for c in bpy.data.collections),
    # a collection can be linked under several parents (the "Bonus collection" re-groups
    # the same collections by region), so also dump the raw graph
    "scene_children": [c.name for c in scene.collection.children],
    "collection_children": {c.name: [ch.name for ch in c.children] for c in bpy.data.collections},
    "collection_objects": {c.name: [ob.name for ob in c.objects] for c in bpy.data.collections},
    "objects": objs,
    "texts": texts,
}, open(out, "w"))
print("types", Counter(o["type"] for o in objs))
print("modifier types", Counter(m for o in objs for m in o["modifiers"]))
print("wrote", out)
