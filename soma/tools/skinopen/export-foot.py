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
a = o.asset_data
np.savez(out, V=V.astype(np.float64), F=T.reshape(-1, 3).astype(np.int64), name=o.name, licence=(a.license if a else ''), author=(a.author if a else ''), description=(a.description if a else ''), multires=np.array(levels if levels else [0, 0]))
print(out, len(V), 'vertices', len(T) // 3, 'triangles; licence', a.license if a else None, '; author', a.author if a else None, '; multires level', levels)
