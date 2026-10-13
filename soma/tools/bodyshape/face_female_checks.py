"""
女性的脸：前后对比的量度、哪些面肌在厚度表的目标面之外、头部的深层包络、对比渲染。
The female face: measurements before and after, which facial muscles lie outside the depth-table target surface, the deep
envelope of the head, and comparison renders.

    python tools/bodyshape/face_female_checks.py [before 包目录 = female-skin] [after 包目录 = female-skin-face]
    -> <after>/face-report.json / .txt, deep-envelope.obj, compare-front.png, compare-threequarter.png, compare-profile.png, face-pins.png
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enclose_skin as ES  # noqa: E402
import face_female as FFACE  # noqa: E402
import final_female as FF  # noqa: E402
import mhrlib  # noqa: E402
from bodylib import RAW, Body, render_closeup  # noqa: E402
from fit_check import signed_distance  # noqa: E402
from fit_skin import vertex_normals, write_obj  # noqa: E402

FACE_SKIN_FAT = 0.003   # 面部“皮肤 + 皮下脂肪”的厚度，面肌在它下面（假定值）/ thickness of skin + subcutaneous fat on the face, with the facial muscles under it (assumption)


def skin_of(d):
    st = np.load(os.path.join(d, 'fit-state-final.npz'))
    lod = int(st['lod'])
    V, P, _ = mhrlib.run(st['identity'], st['mp'], lod, True)
    return V + st['offsets'], P, lod


def metrics(V, F, lm, wh, lod):
    """皮肤上的面部量度（mm）/ facial measurements on the skin (mm)"""
    import igl
    h = wh > 0.5
    Vh = V[h]
    b = lambda k: lm[k]['bone']
    span = lambda y, z, dy, dz: float(np.ptp(Vh[(np.abs(Vh[:, 1] - y) < dy) & (np.abs(Vh[:, 2] - z) < dz)][:, 0]) * 1000)
    near = lambda k: igl.point_mesh_squared_distance(np.ascontiguousarray(lm[k]['target'][None]), np.ascontiguousarray(V), np.ascontiguousarray(F))[2][0]
    zy = 0.5 * (b('zygion_L') + b('zygion_R'))
    go = 0.5 * (b('gonion_L') + b('gonion_R'))
    n, sn, me, g, pg = near('nasion'), near('subnasale'), near('menton'), near('glabella'), near('pogonion')
    nose = V[ES.face_protect(lod)[1]['nose']]
    # 宽度取左右两个目标点各自最近的皮肤点之间的左右距离（按高度取整个头的宽度会把耳朵量进去）
    # widths are the left-right distance between the skin points nearest the two targets (taking the whole width of the head at that height would measure the ears)
    m = {'bizygomaticWidth': float(abs(near('zygion_L')[0] - near('zygion_R')[0]) * 1000), 'bigonialWidth': float(abs(near('gonion_L')[0] - near('gonion_R')[0]) * 1000),
         'totalFaceHeight_nasionToMenton': float((n[1] - me[1]) * 1000), 'lowerFaceHeight_subnasaleToMenton': float((sn[1] - me[1]) * 1000),
         'nasalHeight_nasionToSubnasale': float((n[1] - sn[1]) * 1000), 'nasalWidth_alar': float(np.ptp(nose[:, 0]) * 1000),
         'glabellaAheadOfNasion': float((g[2] - n[2]) * 1000), 'pogonionBehindSubnasale': float((sn[2] - pg[2]) * 1000)}
    m['bigonialOverBizygomatic'] = m['bigonialWidth'] / m['bizygomaticWidth']
    m['lowerOverTotalFaceHeight'] = m['lowerFaceHeight_subnasaleToMenton'] / m['totalFaceHeight_nasionToMenton']
    return {k: round(v, 3 if 'Over' in k else 1) for k, v in m.items()}


def pins(lm, r=0.0015):
    """每个标志点一根“针”：骨上的点到目标点的一条细棱柱，目标点处一个小八面体 / one pin per landmark: a thin prism from the bone point to the target, with a small octahedron at the target"""
    Vs, Fs, n0 = [], [], 0
    for v in lm.values():
        a, t = v['bone'], v['target']
        d = FFACE._unit(t - a)
        u = FFACE._unit(np.cross(d, [0.3, 0.5, 0.8]))
        w = np.cross(d, u)
        ring = [a + 0.0006 * (np.cos(q) * u + np.sin(q) * w) for q in (0, 2.1, 4.2)] + [t + 0.0006 * (np.cos(q) * u + np.sin(q) * w) for q in (0, 2.1, 4.2)]
        Vs += ring
        Fs += [[n0 + i, n0 + (i + 1) % 3, n0 + 3 + i] for i in range(3)] + [[n0 + (i + 1) % 3, n0 + 3 + (i + 1) % 3, n0 + 3 + i] for i in range(3)]
        n0 += 6
        oc = [t + r * np.array(e) for e in ([1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1])]
        Vs += oc
        Fs += [[n0 + i, n0 + j, n0 + k] for i, j, k in ((0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4), (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5))]
        n0 += 6
    return np.array(Vs), np.array(Fs)


def main():
    a = os.path.join(RAW, 'out', sys.argv[1] if len(sys.argv) > 1 else 'female-skin')
    b = os.path.join(RAW, 'out', sys.argv[2] if len(sys.argv) > 2 else 'female-skin-face')
    fb = Body('female')
    lm = FFACE.landmarks(fb)
    (Va, Pa, lod), (Vb, Pb, _) = skin_of(a), skin_of(b)
    F, jn, wh = mhrlib.faces(lod), mhrlib.joint_names(lod), FF.head_weight(lod)
    rep, lines = {}, []
    L = lambda k: lm[k]['bone']
    bone = {'bizygomaticWidth': abs(L('zygion_L')[0] - L('zygion_R')[0]) * 1000, 'bigonialWidth': abs(L('gonion_L')[0] - L('gonion_R')[0]) * 1000,
            'totalFaceHeight_nasionToMenton': (L('nasion')[1] - L('menton')[1]) * 1000, 'lowerFaceHeight_anteriorNasalSpineToMenton': (L('subnasale')[1] - L('menton')[1]) * 1000}
    bone['bigonialOverBizygomatic'] = bone['bigonialWidth'] / bone['bizygomaticWidth']
    rep['bone'] = {k: round(float(v), 3 if 'Over' in k else 1) for k, v in bone.items()}
    rep['skinBefore'], rep['skinAfter'] = metrics(Va, F, lm, wh, lod), metrics(Vb, F, lm, wh, lod)
    lines.append('measure                                   bone    skin before   skin after')
    for k in rep['skinAfter']:
        lines.append(f'  {k:38s} {str(rep["bone"].get(k, "")):>7s} {rep["skinBefore"][k]:>11} {rep["skinAfter"][k]:>11}')
    ra, rb = FFACE.residuals(lm, Va, F), FFACE.residuals(lm, Vb, F)
    rep['coverAtLandmarksMm'] = {k: {'tableDepth': lm[k]['depthMm'], 'before': round(float(lm[k]['depthMm'] - ra[k]), 1), 'after': round(float(lm[k]['depthMm'] - rb[k]), 1), 'source': lm[k]['source']} for k in lm}
    lines.append('\ncover at the landmarks, mm: table depth / installed skin / new skin (final skins, after the enclosure)')
    for k, v in rep['coverAtLandmarksMm'].items():
        lines.append(f'  {k:20s} {v["tableDepth"]:6.1f} {v["before"]:6.1f} {v["after"]:6.1f}')

    # 面肌相对厚度表目标面（新包里放松之前的体型 target-shape.npz）/ facial muscles against the depth-table target surface (the shape before any relaxation, target-shape.npz of the new package)
    T = np.load(os.path.join(b, 'target-shape.npz'))['V']
    eye = 0.5 * (fb.verts('Left vitreous body').mean(0) + fb.verts('Right vitreous body').mean(0))
    rows = []
    for p in fb.deep_parts():
        if p['tissue'] not in ('muscle', 'tendon'):
            continue
        v = fb.mesh(p)[0]
        if not (v[:, 1].min() > eye[1] - 0.13 and v[:, 2].max() > eye[2] - 0.06):
            continue
        s = signed_distance(v, T, F) * 1000 + FACE_SKIN_FAT * 1000
        if (s > 0).any():
            rows.append({'id': p['id'], 'name': p['name'], 'shareOutsideEnvelope': round(float((s > 0).mean()), 3), 'p95Mm': round(float(np.percentile(s, 95)), 1), 'maxMm': round(float(s.max()), 1)})
    rows.sort(key=lambda r: -r['shareOutsideEnvelope'] * max(r['p95Mm'], 0.1))
    rep['facialMusclesOutsideHeadEnvelope'] = rows
    lines.append(f'\nfacial muscles outside the head envelope (target skin minus {FACE_SKIN_FAT * 1000:.0f} mm): share of the part, p95 / max mm outside')
    for r in rows[:30]:
        lines.append(f'  {100 * r["shareOutsideEnvelope"]:5.1f} %  {r["p95Mm"]:5.1f} {r["maxMm"]:5.1f}  {r["name"]}')

    # 头部的深层包络：目标皮肤向内 3 mm；身体部分沿用 female-target/deep-envelope.obj / deep envelope of the head: the target skin 3 mm inwards; the body keeps female-target/deep-envelope.obj
    n = vertex_normals(T, F)
    Aj = ES.adjacency(len(T), F)
    for _ in range(3):
        n = 0.5 * n + 0.5 * (Aj @ n)
    n /= np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]
    old = os.path.join(RAW, 'out', 'female-target', 'deep-envelope.obj')
    E0 = np.array([[float(x) for x in ln.split()[1:4]] for ln in open(old) if ln.startswith('v ')]) if os.path.exists(old) else T - 0.006 * n
    E = E0 + wh[:, None] * ((T - FACE_SKIN_FAT * n) - E0)
    write_obj(os.path.join(b, 'deep-envelope.obj'), E, F, 'female deep envelope with the head taken from the new face (target skin 3 mm inwards); body as in female-target/deep-envelope.obj')

    json.dump(rep, open(os.path.join(b, 'face-report.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(b, 'face-report.txt'), 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))

    from PIL import Image
    skin = (0.87, 0.72, 0.62)
    top = max(Va[:, 1].max(), Vb[:, 1].max())
    hv = Vb[:, 1] > top - 0.34
    Fh = F[hv[F].all(1)]
    c0 = np.array([eye[0], 0.0, eye[2] - 0.08])
    for tag, ang, view in (('front', 0.0, 'front'), ('threequarter', -35.0, 'front'), ('profile', 0.0, 'side')):
        t = np.radians(ang)
        R = np.array([[np.cos(t), 0, np.sin(t)], [0, 1, 0], [-np.sin(t), 0, np.cos(t)]])
        ims = []
        for V in (Va, Vb):
            pth = os.path.join(b, f'_tmp-{tag}.png')
            lo_, hi_ = ([eye[0] - 0.17, top - 0.30, -1.0], [eye[0] + 0.17, top + 0.01, 1.0]) if view == 'front' else ([-1.0, top - 0.30, eye[2] - 0.20], [1.0, top + 0.01, eye[2] + 0.13])
            render_closeup([((V - c0) @ R.T + c0, Fh, skin)], pth, lo_, hi_, views=(view,), height=900)
            ims.append(Image.open(pth).convert('RGB'))
            os.remove(pth)
        W = Image.new('RGB', (ims[0].width + ims[1].width, max(i.height for i in ims)), 'white')
        W.paste(ims[0], (0, 0))
        W.paste(ims[1], (ims[0].width, 0))
        W.save(os.path.join(b, f'compare-{tag}.png'))     # 左：已安装的；右：新的 / left: installed; right: new
    BV, BF = fb.merged(lambda p: p['tissue'] in ('bone', 'tooth') and p['name'] != 'Hyoid bone')
    PV, PF = pins(lm)
    render_closeup([(Vb, Fh, skin), (BV, BF, (0.92, 0.9, 0.82)), (PV, PF, (0.1, 0.3, 0.9))], os.path.join(b, 'face-pins.png'), [eye[0] - 0.10, eye[1] - 0.13, eye[2] - 0.09], [eye[0] + 0.10, eye[1] + 0.07, eye[2] + 0.12], views=('front', 'side'), height=1000, alpha=0.35)


if __name__ == '__main__':
    main()
