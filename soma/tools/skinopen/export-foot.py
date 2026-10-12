# 从 Blender Studio 的 Human Base Meshes（CC0）里取出 “Foot - Realistic” 这只脚（分开的脚趾，带趾甲），写成 npz。
# 用带 bpy 的 Python 运行（tools/zanatomy/.venv）；打开 .blend 时不运行其中的脚本。
# Takes the "Foot - Realistic" asset (separate toes, with nails) out of Blender Studio's Human Base Meshes
# (CC0) and writes it as an npz. Run with a Python that has bpy (tools/zanatomy/.venv); the .blend is opened
# with its scripts disabled.
#
#   tools/zanatomy/.venv/bin/python tools/skinopen/export-foot.py <human_base_meshes_bundle.blend> <out.npz>

import sys

import bpy
import numpy as np

src, out = sys.argv[1:3]
bpy.ops.wm.open_mainfile(filepath=src, use_scripts=False)
o = bpy.data.objects.get('Foot - Realistic')
if o is None:
    raise SystemExit('object "Foot - Realistic" not found in %s' % src)
levels = None
for m in o.modifiers:
    if m.type == 'MULTIRES':
        # 多级细分取第 2 级：约 1.5 mm 的边，够表现趾甲 / multires level 2: edges of about 1.5 mm, enough for the nails
        m.levels = min(m.total_levels, 2)
        levels = [m.levels, m.total_levels]
# 再加一级 Catmull-Clark 细分：多级细分只有一级（边长约 4 mm），趾上太粗，盖不住趾骨的弧面
# one more level of Catmull-Clark subdivision: the multires has a single level (edges of about 4 mm), too coarse on the toes to follow the curvature over the phalanges
sub = o.modifiers.new('skinopen_subdivide', 'SUBSURF')
sub.levels = 1
sub.subdivision_type = 'CATMULL_CLARK'
dg = bpy.context.evaluated_depsgraph_get()
dg.update()
ev = o.evaluated_get(dg)
me = ev.to_mesh()
V = np.empty(len(me.vertices) * 3, np.float32)
me.vertices.foreach_get('co', V)
V = V.reshape(-1, 3)
M = np.array(o.matrix_world)
V = V @ M[:3, :3].T + M[:3, 3]
me.calc_loop_triangles()
T = np.empty(len(me.loop_triangles) * 3, np.int32)
me.loop_triangles.foreach_get('vertices', T)
# 雕刻面组（作者给脚的各部分分的组，趾甲各自成组）：每个三角形一个编号
# sculpt face sets (the author's grouping of the foot's parts; each nail is a set of its own): one id per triangle
TP = np.empty(len(me.loop_triangles), np.int32)
me.loop_triangles.foreach_get('polygon_index', TP)
fs_attr = me.attributes.get('.sculpt_face_set')
FS = np.zeros(len(TP), np.int32)
if fs_attr is not None:
    per_poly = np.empty(len(me.polygons), np.int32)
    fs_attr.data.foreach_get('value', per_poly)
    FS = per_poly[TP]
a = o.asset_data
np.savez(out, V=V.astype(np.float64), F=T.reshape(-1, 3).astype(np.int64), faceSet=FS, name=o.name, licence=(a.license if a else ''), author=(a.author if a else ''), description=(a.description if a else ''), multires=np.array(levels if levels else [0, 0]), subdivided=np.array(1))
print(out, len(V), 'vertices', len(T) // 3, 'triangles; licence', a.license if a else None, '; author', a.author if a else None, '; multires level', levels)
