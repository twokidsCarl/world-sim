"""诊断：皮肤截面相对深部结构截面和骨轴偏了多少（判断是姿势/位置问题还是粗细问题）。
Diagnostic: how far the skin cross-section is off the deep-part cross-section and the bone axis
(tells a pose/position misfit from a girth misfit).

    python tools/bodyshape/diag_offsets.py female [--state fit-state.npz]
    -> data/raw/bodyshape/out/<body>-skin/diag-offsets.json / .txt

四肢：垂直于骨轴（rig.json 的关节中心连线）切片；躯干：水平切片。每个切片给出
皮肤与深部结构凸包的形心之差（毫米，世界坐标：x 左、z 前）、两者的围度，以及四个方向上的余量
（皮肤边界减深部边界；负值 = 深部结构在该方向伸出皮肤）。另给出皮肤关节与骨架关节的距离。
Limbs: slices perpendicular to the bone axis (line between rig.json joint centres); trunk: horizontal
slices. Per slice: difference of the hull centroids of skin and deep parts (mm, world axes: x left,
z anterior), both girths, and the margin in four directions (skin boundary minus deep boundary;
negative = deep parts stick out that way). Also the distance between skin joints and rig joints.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mhrlib  # noqa: E402
from bodylib import RAW, Body, hull_perimeter, plane_basis, slice_segments  # noqa: E402
from fit_skin import JOINT_MAP, AXIAL_MAP  # noqa: E402


def hull_stats(p2):
    from scipy.spatial import ConvexHull
    if len(p2) < 3:
        return None
    h = p2[ConvexHull(p2).vertices]
    x, y = h[:, 0], h[:, 1]
    a = x * np.roll(y, -1) - np.roll(x, -1) * y
    A = a.sum() / 2
    c = np.array([((x + np.roll(x, -1)) * a).sum(), ((y + np.roll(y, -1)) * a).sum()]) / (6 * A)
    return c, hull_perimeter(p2)[0]


def section(V, F, o, n, radius, u, w):
    segs = slice_segments(V, F, o, n)
    if not len(segs):
        return None
    p = segs.reshape(-1, 3)
    p = p[np.linalg.norm(p - o, axis=1) < radius]
    if len(p) < 6:
        return None
    return np.stack([(p - o) @ u, (p - o) @ w], -1)


def main():
    name = sys.argv[1]
    d = os.path.join(RAW, 'out', f'{name}-skin')
    st = np.load(os.path.join(d, sys.argv[sys.argv.index('--state') + 1] if '--state' in sys.argv else 'fit-state.npz'))
    lod = int(st['lod'])
    Vm, P, _ = mhrlib.run(st['identity'], st['mp'], lod, True)
    V = Vm + st['offsets']
    F = mhrlib.faces(lod)
    jn = mhrlib.joint_names(lod)
    fb = Body(name)
    DV, DF = fb.merged(lambda p: p['tissue'] in Body.DEEP and p['system'] != 'integumentary')
    R = {j['id']: np.array(j['center'], float) for j in json.load(open(os.path.join('public/anatomy', name, 'rig.json')))['joints']}
    lines, out = [], {'joints': {}, 'limbs': [], 'trunk': []}

    # ---- 关节：皮肤骨架（MHR）对骨架组的关节中心 / joints: skin skeleton (MHR) against the rig's centres
    lines.append('joint: skin (MHR) joint minus rig joint, mm [dx left, dy up, dz anterior] and distance')
    for j in jn:
        side = {'l': 'L', 'r': 'R'}.get(j[0]) if j[1] == '_' else None
        base = j[2:] if side else j
        a = (JOINT_MAP[base][0] + '_' + side) if side and base in JOINT_MAP else (AXIAL_MAP[j][0] if j in AXIAL_MAP else None)
        if a and a in R:
            dv = (P[jn.index(j)] - R[a]) * 1000
            out['joints'][a] = {'mhr': j, 'offsetMm': [round(float(x), 1) for x in dv], 'distanceMm': round(float(np.linalg.norm(dv)), 1)}
            if not any(t in j for t in ('index', 'middle', 'ring', 'pinky', 'thumb')):
                lines.append(f'  {a:12s} <- {j:12s} {dv[0]:+6.1f} {dv[1]:+6.1f} {dv[2]:+6.1f}   {np.linalg.norm(dv):5.1f}')
    fing = [v['distanceMm'] for k, v in out['joints'].items() if any(t in v['mhr'] for t in ('index', 'middle', 'ring', 'pinky', 'thumb'))]
    if fing:
        lines.append(f'  finger joints (30): median {np.median(fing):.1f} mm, max {max(fing):.1f} mm')

    # ---- 四肢 / limbs
    lines.append('\nlimb slices perpendicular to the bone axis: skin centroid minus deep centroid [x left, z anterior] mm; deep centroid minus bone axis; girth skin / deep, mm;'
                 ' margins skin-deep: lateral, medial, anterior, posterior (negative = deep parts stick out)')
    for seg, a, b, rad in (('upperArm', 'gh', 'elbow', 0.085), ('forearm', 'elbow', 'wrist', 0.075), ('thigh', 'hip', 'knee', 0.13), ('shank', 'knee', 'ankle', 0.10)):
        for S, sg in (('L', 1), ('R', -1)):
            pa, pb = R[f'{a}_{S}'], R[f'{b}_{S}']
            n = (pb - pa) / np.linalg.norm(pb - pa)
            # 截面内的两个轴：尽量对齐世界的 x（左）和 z（前）/ in-plane axes aligned with world x (left) and z (anterior)
            u = np.array([1.0, 0, 0]) - n[0] * n
            u /= np.linalg.norm(u)
            w = np.cross(u, n)
            if w[2] < 0:
                w = -w
            for t in (0.3, 0.5, 0.7):
                o = pa + t * (pb - pa)
                s2, d2 = section(V, F, o, n, rad, u, w), section(DV, DF, o, n, rad, u, w)
                if s2 is None or d2 is None:
                    continue
                (cs, gs), (cd, gd) = hull_stats(s2), hull_stats(d2)
                m = {'lateral': sg * (s2[:, 0].max() if sg > 0 else s2[:, 0].min()) - sg * (d2[:, 0].max() if sg > 0 else d2[:, 0].min()),
                     'medial': -sg * (s2[:, 0].min() if sg > 0 else s2[:, 0].max()) + sg * (d2[:, 0].min() if sg > 0 else d2[:, 0].max()),
                     'anterior': s2[:, 1].max() - d2[:, 1].max(), 'posterior': d2[:, 1].min() - s2[:, 1].min()}
                row = {'segment': seg, 'side': S, 't': t, 'skinMinusDeepMm': [round(float(x) * 1000, 1) for x in cs - cd],
                       'deepMinusAxisMm': [round(float(x) * 1000, 1) for x in cd], 'skinMinusAxisMm': [round(float(x) * 1000, 1) for x in cs],
                       'girthSkinMm': round(gs * 1000), 'girthDeepMm': round(gd * 1000), 'marginMm': {k: round(float(v) * 1000, 1) for k, v in m.items()}}
                out['limbs'].append(row)
                lines.append(f'  {seg:9s} {S} t={t}: skin-deep [{row["skinMinusDeepMm"][0]:+6.1f} {row["skinMinusDeepMm"][1]:+6.1f}]  deep-axis [{row["deepMinusAxisMm"][0]:+6.1f} {row["deepMinusAxisMm"][1]:+6.1f}]'
                             f'  girth {row["girthSkinMm"]:4d} / {row["girthDeepMm"]:4d}   margins lat {m["lateral"] * 1000:+6.1f} med {m["medial"] * 1000:+6.1f} ant {m["anterior"] * 1000:+6.1f} post {m["posterior"] * 1000:+6.1f}')

    # ---- 躯干：水平切片 / trunk: horizontal slices
    lines.append('\ntrunk, horizontal slices (arms excluded by |x| < shoulder joint x - 20 mm): skin centroid minus deep centroid [x, z] mm; girth skin / deep; margins left, right, anterior, posterior')
    hip = 0.5 * (R['hip_L'] + R['hip_R'])
    sh = 0.5 * (R['gh_L'] + R['gh_R'])
    xlim = abs(R['gh_L'][0]) - 0.02
    for t in (0.1, 0.25, 0.4, 0.55, 0.7, 0.85):
        y = hip[1] + t * (sh[1] - hip[1])
        o = np.array([0.0, y, 0.0])
        ps = slice_segments(V, F, o, np.array([0, 1.0, 0])).reshape(-1, 3)
        pd = slice_segments(DV, DF, o, np.array([0, 1.0, 0])).reshape(-1, 3)
        ps, pd = ps[np.abs(ps[:, 0]) < xlim], pd[np.abs(pd[:, 0]) < xlim]
        if len(ps) < 6 or len(pd) < 6:
            continue
        (cs, gs), (cd, gd) = hull_stats(ps[:, [0, 2]]), hull_stats(pd[:, [0, 2]])
        m = {'left': ps[:, 0].max() - pd[:, 0].max(), 'right': pd[:, 0].min() - ps[:, 0].min(), 'anterior': ps[:, 2].max() - pd[:, 2].max(), 'posterior': pd[:, 2].min() - ps[:, 2].min()}
        row = {'levelFractionHipToShoulder': t, 'heightM': round(float(y), 3), 'skinMinusDeepMm': [round(float(x) * 1000, 1) for x in cs - cd],
               'girthSkinMm': round(gs * 1000), 'girthDeepMm': round(gd * 1000), 'marginMm': {k: round(float(v) * 1000, 1) for k, v in m.items()}}
        out['trunk'].append(row)
        lines.append(f'  t={t:4.2f} y={y:5.3f}: skin-deep [{row["skinMinusDeepMm"][0]:+6.1f} {row["skinMinusDeepMm"][1]:+6.1f}]  girth {row["girthSkinMm"]:4d} / {row["girthDeepMm"]:4d}'
                     f'   margins L {m["left"] * 1000:+6.1f} R {m["right"] * 1000:+6.1f} ant {m["anterior"] * 1000:+6.1f} post {m["posterior"] * 1000:+6.1f}')
    if '--no-write' not in sys.argv:  # 只打印、不往包目录里写 / print only, write nothing into the package directory
        json.dump(out, open(os.path.join(d, 'diag-offsets.json'), 'w'), ensure_ascii=False, indent=1)
        open(os.path.join(d, 'diag-offsets.txt'), 'w').write('\n'.join(lines))
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
