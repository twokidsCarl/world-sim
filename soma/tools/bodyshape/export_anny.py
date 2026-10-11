"""把 Anny / MakeHuman 的女性基础网格、骨架、蒙皮权重和几个宏观形变导出为中性格式。
Export the Anny / MakeHuman young-adult female mesh, rig, skin weights and a few macro shape
deltas to a neutral format.

    python tools/bodyshape/export_anny.py  -> data/raw/bodyshape/out/anny-female/
      rest.obj        静止姿态（MakeHuman 的 A 字站姿）/ rest pose (MakeHuman A-pose), our frame, metres
      posed.obj       上肢下垂、掌心向前 / arms hanging, palms forward (like our bodies)
      joints.json     163 根骨：名称、父骨、头尾坐标（静止与摆姿后）/ bones: names, parents, heads, tails
      weights.bin     (uint32 顶点, uint32 骨, float32 权重) 记录 / records, little endian
      macro-deltas.f32  各宏观参数从中间值变到两端时的顶点位移（静止姿态）
                        vertex displacements (rest pose) when one macro parameter goes to either end
      manifest.json

数据许可：MakeHuman/MPFB2 资产 CC0；Anny 代码 Apache-2.0。
Licences: MakeHuman / MPFB2 assets CC0; Anny code Apache-2.0.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import annylib  # noqa: E402
from bodylib import RAW, render_views  # noqa: E402

OUT = os.path.join(RAW, 'out', 'anny-female')
BASE = dict(gender=1.0, age=2 / 3, muscle=0.5, weight=0.5, height=0.5, proportions=0.5, cupsize=0.5, firmness=0.5)


def write_obj(path, V, F, note):
    with open(path, 'w') as f:
        f.write(f'# {note}\n')
        for v in V:
            f.write(f'v {v[0]:.5f} {v[1]:.5f} {v[2]:.5f}\n')
        for t in F:
            f.write(f'f {t[0] + 1} {t[1] + 1} {t[2] + 1}\n')


def main():
    os.makedirs(OUT, exist_ok=True)
    b = annylib.body(BASE)
    r = b['rest']
    write_obj(os.path.join(OUT, 'rest.obj'), r['V'], r['F'], 'Anny/MakeHuman young adult female, rest pose; metres, Y up, +Z anterior, +X left')
    write_obj(os.path.join(OUT, 'posed.obj'), b['V'], b['F'], 'Anny/MakeHuman young adult female, arms hanging; metres, Y up, +Z anterior, +X left')
    idx, val = r['wIdx'], r['wVal']
    vi, k = np.nonzero(val > 0)
    rec = np.zeros(len(vi), dtype=[('v', '<u4'), ('j', '<u4'), ('w', '<f4')])
    rec['v'], rec['j'], rec['w'] = vi, idx[vi, k], val[vi, k]
    rec.tofile(os.path.join(OUT, 'weights.bin'))
    json.dump({'names': r['labels'], 'parents': r['parents'], 'restHeads': np.round(r['heads'], 5).tolist(), 'restTails': np.round(r['tails'], 5).tolist(),
               'posedHeads': np.round(b['heads'], 5).tolist(), 'posedTails': np.round(b['tails'], 5).tolist()}, open(os.path.join(OUT, 'joints.json'), 'w'))
    deltas, names = [], []
    for p in ('weight', 'muscle', 'height', 'proportions', 'cupsize', 'age'):
        for end in (0.0, 1.0):
            ph = dict(BASE)
            ph[p] = end
            v = annylib.rest(ph)['V']
            deltas.append((v - r['V']).astype(np.float32))
            names.append(f'{p}={end:g}')
    np.stack(deltas).tofile(os.path.join(OUT, 'macro-deltas.f32'))
    json.dump({
        'schema': 1,
        'what': {'zh': 'Anny（MakeHuman 派生）青年女性：网格、骨架、蒙皮权重、宏观形变位移', 'en': 'Anny (MakeHuman-derived) young adult female: mesh, rig, skin weights, macro shape deltas'},
        'source': {'name': 'Anny 0.6.1 with MakeHuman / MPFB2 data', 'url': 'https://github.com/naver/anny', 'license': 'code Apache-2.0; MakeHuman assets CC0 1.0'},
        'frame': 'metres, Y up, +Z anterior, +X subject left, soles at y = 0',
        'basePhenotype': BASE,
        'files': {'rest.obj': f'{len(r["V"])} vertices, {len(r["F"])} triangles', 'posed.obj': 'same topology, arms hanging',
                  'weights.bin': f'{len(rec)} records (uint32 vertex, uint32 bone, float32 weight)', 'joints.json': f'{len(r["labels"])} bones',
                  'macro-deltas.f32': f'float32 [{len(names)}][{len(r["V"])}][3], order: {names}'},
        'note': {'zh': '宏观形变不是线性混合：系数是各参数分段线性插值权重的乘积（多线性）。这里给的是单参数到两端的位移，仅供查看；完整的 1132 个形变在 anny 包的 data/cached/anny.pth。',
                 'en': 'Macro shape changes are not plain linear blendshapes: coefficients are products of piecewise-linear interpolation weights (multilinear). '
                       'These are single-parameter end-point displacements for inspection; all 1132 blendshapes are in data/cached/anny.pth of the anny package.'},
    }, open(os.path.join(OUT, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
    render_views([(b['V'], b['F'], (0.86, 0.72, 0.62))], os.path.join(OUT, 'preview-posed.png'), height=900)
    e = r['F'][:, [0, 1, 1, 2, 2, 0]].reshape(-1, 2)
    el = np.linalg.norm(r['V'][e[:, 0]] - r['V'][e[:, 1]], axis=1)
    print('vertices', len(r['V']), 'triangles', len(r['F']), 'median edge mm', round(float(np.median(el)) * 1000, 1), 'weights/vertex max', int((val > 0).sum(1).max()))


if __name__ == '__main__':
    main()
