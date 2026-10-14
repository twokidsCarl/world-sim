"""
女性最终皮肤的复核：头部特写、相对目标体型的位移、上臂与肩的围度、前臂截面形心、头面部覆盖。
Checks on the final female skin: head close-ups, displacement from the target shape, girths of shoulder and upper arm,
forearm section centroids, cover over head and face.

    python tools/bodyshape/final_checks.py    -> female-skin/final-checks.json / .txt, closeup-head-*.png, preview-vs-target.png
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mhrlib  # noqa: E402
from bodylib import RAW, Body, hull_perimeter, render_closeup, render_views, slice_segments  # noqa: E402
from fit_check import REGIONS, classify, signed_distance  # noqa: E402
from measure import bone_landmarks  # noqa: E402

# --dir <包目录名>：复核另一个包（缺省 female-skin）/ --dir <package directory name>: checks another package (female-skin by default)
OUT = os.path.join(RAW, 'out', sys.argv[sys.argv.index('--dir') + 1] if '--dir' in sys.argv else 'female-skin')


def section(V, F, origin, axis, radius):
    """过 origin、法向为 axis 的截面上，离 origin 不超过 radius 的轮廓点 / contour points of the section through origin with normal axis, within radius of origin"""
    import trimesh
    segs = trimesh.intersections.mesh_plane(trimesh.Trimesh(V, F, process=False), axis, origin)
    if len(segs) == 0:
        return np.zeros((0, 3))
    P = segs.reshape(-1, 3)
    return P[np.linalg.norm(P - origin, axis=1) < radius]


def girth(P, axis):
    if len(P) < 8:
        return float('nan')
    a = np.cross(axis, [0, 0, 1.0])
    a /= np.linalg.norm(a)
    b = np.cross(axis, a)
    from scipy.spatial import ConvexHull
    Q = np.stack([P @ a, P @ b], 1)
    h = Q[ConvexHull(Q).vertices]
    return float(np.linalg.norm(h - np.roll(h, 1, 0), axis=1).sum())


def main():
    st = np.load(os.path.join(OUT, 'fit-state-final.npz'))
    lod = int(st['lod'])
    F = mhrlib.faces(lod)
    V = mhrlib.run(st['identity'], st['mp'], lod, True)[0] + st['offsets']
    T = np.load(os.path.join(OUT, 'target-shape.npz'))['V']
    fb = Body('female')
    L = bone_landmarks(fb)
    regV = classify(T, L)
    lines, rep = [], {}
    mm = np.linalg.norm(V - T, axis=1) * 1000
    rep['movedFromTargetShapeMm'] = {}
    lines.append('final skin against the target shape (same pose and head), by region: median / p95 / max mm')
    for rid, _, _ in REGIONS:
        m = regV == rid
        if m.sum() > 20:
            rep['movedFromTargetShapeMm'][rid] = {'median': round(float(np.median(mm[m])), 1), 'p95': round(float(np.percentile(mm[m], 95)), 1), 'max': round(float(mm[m].max()), 1)}
            lines.append(f'   {rid:10s} {np.median(mm[m]):5.1f} {np.percentile(mm[m], 95):5.1f} {mm[m].max():5.1f}')

    # 肩宽、上臂与前臂围度：目标体型 对 最终皮肤 / shoulder breadth, upper-arm and forearm girths: target shape against final skin
    rep['arm'] = {}
    for S in 'LR':
        sh, el, wr = L['shoulder_' + S], L['elbow_' + S], L['wrist_' + S]
        for tag, a, b, fr in (('upperArm', sh, el, (0.3, 0.5, 0.7)), ('forearm', el, wr, (0.2, 0.3, 0.4, 0.5, 0.7, 0.8))):
            ax = (b - a) / np.linalg.norm(b - a)
            for f in fr:
                o = a + f * (b - a)
                rad = 0.09 if tag == 'upperArm' else 0.055   # 前臂靠近髋部，半径取小，免得截到躯干 / the forearm lies near the hip: a small radius keeps the trunk out
                gT, gV = girth(section(T, F, o, ax, rad), ax), girth(section(V, F, o, ax, rad), ax)
                rec = {'targetGirthMm': round(gT * 1000, 1), 'finalGirthMm': round(gV * 1000, 1)}
                if tag == 'forearm':
                    # 截面形心相对桡骨 + 尺骨形心：内外（负 = 朝正中）、前后（正 = 向前）
                    # section centroid relative to the centroid of radius + ulna: mediolateral (negative = toward the midline), anteroposterior (positive = anterior)
                    side = {'L': 'left', 'R': 'right'}[S]
                    BV, BF = fb.merged(lambda p: p['name'].lower() in (f'{side} radius', f'{side} ulna'))
                    bc = section(BV, BF, o, ax, 0.09).mean(0)
                    lat = np.array([1.0 if S == 'L' else -1.0, 0, 0])
                    lat = lat - (lat @ ax) * ax
                    lat /= np.linalg.norm(lat)
                    ant = np.cross(ax, lat) * (1.0 if S == 'L' else -1.0)
                    ant = ant if ant[2] > 0 else -ant
                    for nm, W in (('target', T), ('final', V)):
                        c = section(W, F, o, ax, rad).mean(0) - bc
                        rec[nm + 'CentroidMm'] = {'lateral': round(float(c @ lat) * 1000, 1), 'anterior': round(float(c @ ant) * 1000, 1)}
                rep['arm'][f'{tag}_{S}_{f}'] = rec
                lines.append(f'{tag} {S} at {f}: girth target {gT * 1000:.0f} -> final {gV * 1000:.0f} mm' + (f'; skin centroid relative to radius+ulna (lateral, anterior mm): target {rec["targetCentroidMm"]}, final {rec["finalCentroidMm"]}' if tag == 'forearm' else ''))
    yT = 0.5 * (L['shoulder_L'][1] + L['shoulder_R'][1])
    for nm, W in (('target', T), ('final', V)):
        band = W[(np.abs(W[:, 1] - yT) < 0.03)]
        rep.setdefault('bideltoidBreadthMm', {})[nm] = round(float(np.ptp(band[:, 0])) * 1000, 1)
    lines.append(f'bideltoid breadth (widest skin within 3 cm of the shoulder-joint level): {rep["bideltoidBreadthMm"]}')

    # 头面部：各深部结构到皮肤的覆盖 / head and face: cover of the deep parts under the skin
    rep['face'] = {}
    lines.append('head and face: cover under the skin (mm; p5 = thinnest 5 %, median), negative numbers would be outside')
    groups = {'vault': ['Frontal bone', 'Left parietal bone', 'Right parietal bone', 'Occipital bone'], 'zygomatic bones': ['Left zygomatic bone', 'Right zygomatic bone'],
              'nasal bones': ['Left nasal bone', 'Right nasal bone'], 'mandible': ['Mandible']}
    for p in fb.parts:
        n = p['name'].lower()
        for key in ('orbicularis oculi', 'orbicularis oris', 'zygomaticus major', 'zygomaticus minor', 'frontal', 'masseter', 'buccinator', 'mentalis', 'levator labii', 'depressor anguli', 'nasalis', 'anterior chamber', 'risorius', 'procerus', 'corrugator'):
            if key in n and p['tissue'] in ('muscle', 'organ'):
                groups.setdefault(key, []).append(p['name'])
    for key, names in groups.items():
        pts = np.vstack([fb.verts(n) for n in names])
        s = -signed_distance(pts, V, F) * 1000
        if key in ('vault', 'mandible', 'zygomatic bones', 'nasal bones'):   # 只看朝外的一面：取覆盖最薄的 30 % / outward face only: the thinnest 30 %
            s = np.sort(s)[:max(10, int(0.3 * len(s)))]
        rep['face'][key] = {'p5': round(float(np.percentile(s, 5)), 1), 'median': round(float(np.median(s)), 1), 'min': round(float(s.min()), 1)}
        lines.append(f'   {key:20s} min {s.min():5.1f}  p5 {np.percentile(s, 5):5.1f}  median {np.median(s):5.1f}')

    json.dump(rep, open(os.path.join(OUT, 'final-checks.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(OUT, 'final-checks.txt'), 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))

    skin = (0.87, 0.72, 0.62)
    top = V[:, 1].max()
    lo, hi = [-0.14, top - 0.30, -0.05], [0.14, top + 0.01, 0.30]
    col = {'muscle': (0.75, 0.2, 0.2), 'bone': (0.92, 0.9, 0.82), 'organ': (0.3, 0.45, 0.8)}
    inner = []
    for k, tis in (('bone', ('bone', 'cartilage', 'tooth')), ('muscle', ('muscle', 'tendon')), ('organ', ('organ', 'gland'))):
        MV, MF = fb.merged(lambda p: p['tissue'] in tis and p['system'] != 'integumentary')
        inner.append((MV, MF, col[k]))
    render_closeup([(V, F, skin)], os.path.join(OUT, 'closeup-head-skin.png'), lo, hi, views=('front', 'side'), height=900)
    render_closeup([(V, F, skin)] + inner, os.path.join(OUT, 'closeup-head-overlay.png'), lo, hi, views=('front', 'side'), height=900, alpha=0.5)
    render_views([(T, F, (0.6, 0.7, 0.85))], os.path.join(OUT, 'preview-target-shape.png'), height=1100, bounds=(V.min(0) - 0.03, V.max(0) + 0.03))


if __name__ == '__main__':
    main()
