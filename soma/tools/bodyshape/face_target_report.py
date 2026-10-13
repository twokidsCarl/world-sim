"""
女性面部目标（female-face-target/）：头颈的深层包络、冲突清单、量度、清单文件和渲染。
The female face target (female-face-target/): deep envelope of head and neck, conflict list, measurements, manifest and renders.

    python tools/bodyshape/final_female.py --bmi 21.6 [--reuse-pose] --face --target-only --out female-face-target
    python tools/bodyshape/face_target_report.py

包络的规则 / rule for the envelope（假定，不是文献值 / an assumption, not from a source）
  d = 目标皮肤到颅骨、下颌骨的局部距离。包络在皮肤内 t 处：t = clip(d - 2.5 mm, 1.5 mm, 6 mm)。
  即：薄的地方（头皮、额、鼻根，d 约 5–7 mm）在骨面上留 2.5 mm 给薄的肌肉或腱膜，其余算皮肤 + 皮下脂肪；厚的地方（颊、颌下）皮肤 + 脂肪按 6 mm。
  d = local distance from the target skin to skull or mandible. The envelope lies t inside the skin: t = clip(d - 2.5 mm, 1.5 mm, 6 mm).
  So where the cover is thin (scalp, forehead, nasal root, d about 5-7 mm) 2.5 mm is left on the bone for a thin muscle or aponeurosis and
  the rest counts as skin + subcutaneous fat; where it is thick (cheek, under the jaw) skin + fat is taken as 6 mm.
  头以外（按头的蒙皮权重过渡）沿用 female-target/deep-envelope.obj。Outside the head (blended by the head skin weight) female-target/deep-envelope.obj is kept.
"""
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enclose_skin as ES  # noqa: E402
import face_female as FFACE  # noqa: E402
import face_female_checks as FC  # noqa: E402
import final_female as FF  # noqa: E402
import mhrlib  # noqa: E402
from bodylib import RAW, Body, render_closeup  # noqa: E402
from fit_check import signed_distance  # noqa: E402
from fit_skin import vertex_normals, write_obj  # noqa: E402

OUT = os.path.join(RAW, 'out', 'female-face-target')


def extra_measures(V, F, lm, lod, A):
    """皮肤上的另外几个量度 / further measurements on the skin"""
    import igl
    near = lambda q: igl.point_mesh_squared_distance(np.ascontiguousarray(np.asarray(q)[None]), np.ascontiguousarray(V), np.ascontiguousarray(F))[2][0]
    T = lambda k: near(lm[k]['target'])
    ang = lambda a, b: float(np.degrees(np.arccos(np.clip(a @ b / np.linalg.norm(a) / np.linalg.norm(b), -1, 1))))
    out = {}
    go = 0.5 * (T('gonion_L') * [1, 1, 1] + T('gonion_R') * [-1, 1, 1])
    ra = 0.5 * (T('midRamus_L') + T('midRamus_R') * [-1, 1, 1])
    gn = T('gnathion')
    out['gonialAngleSkinDeg_midRamus_gonion_gnathion_sagittal'] = round(ang((ra - go)[1:], (gn - go)[1:]), 1)
    pg = T('pogonion')
    h = V[(np.abs(V[:, 1] - pg[1]) < 0.003) & (V[:, 2] > pg[2] - 0.010) & (np.abs(V[:, 0] - pg[0]) < 0.05)]
    out['chinWidthMm_atPogonionLevel_within10mmOfTheFront'] = round(float(np.ptp(h[:, 0]) * 1000), 1)
    g = T('glabella')
    up = V[(np.abs(V[:, 0] - g[0]) < 0.004) & (np.abs(V[:, 1] - (g[1] + 0.04)) < 0.003) & (V[:, 2] > g[2] - 0.05)]
    f = up[np.argmax(up[:, 2])]
    out['foreheadSlopeDeg_backFromVertical_glabellaTo40mmAbove'] = round(float(np.degrees(np.arctan2(g[2] - f[2], f[1] - g[1]))), 1)
    reg = ES.face_protect(lod)[1]
    n = vertex_normals(V, F)
    ends = {}
    for S in 'LR':
        idx = reg['lids' + S]
        lap = np.einsum('ij,ij->i', (A @ V - V)[idx], n[idx])
        c = V[idx[lap >= np.percentile(lap, 97)]]
        ends[S] = (float(np.abs(c[:, 0]).min()), float(np.abs(c[:, 0]).max()))
    out['intercanthalWidthMm_fissureCreaseMedialEnds'] = round((ends['L'][0] + ends['R'][0]) * 1000, 1)
    out['biocularWidthMm_fissureCreaseLateralEnds'] = round((ends['L'][1] + ends['R'][1]) * 1000, 1)
    sn, lb = T('subnasale'), T('labiomentale')
    w = igl.fast_winding_number(np.ascontiguousarray(V), np.ascontiguousarray(F), np.ascontiguousarray(V + 0.002 * n))
    cr = (w > 0.5) & (np.abs(V[:, 0] - sn[0]) < 0.015) & (V[:, 1] < sn[1] - 0.005) & (V[:, 1] > lb[1]) & (V[:, 2] > sn[2] - 0.03)
    if cr.sum() > 5:
        sto = float(V[cr, 1].mean())
        out['upperLipHeightMm_subnasaleToStomion'] = round((sn[1] - sto) * 1000, 1)
        out['lowerLipHeightMm_stomionToLabiomentale'] = round((sto - lb[1]) * 1000, 1)
    return out


def main():
    inst = os.path.join(RAW, 'out', sys.argv[1] if len(sys.argv) > 1 else 'female-skin')
    fb = Body('female')
    key = json.load(open('public/anatomy/female/pipeline-report.json'))['skinPackage']['internalsKey']
    lm = FFACE.landmarks(fb)
    st = np.load(os.path.join(OUT, 'target-state.npz'))
    lod = int(st['lod'])
    F, wh = mhrlib.faces(lod), FF.head_weight(lod)
    T = np.load(os.path.join(OUT, 'target-shape.npz'))['V']
    Va = FC.skin_of(inst)[0]
    A = ES.adjacency(len(T), F)
    rep, lines = {}, []

    # ---- 量度 / measurements
    L = lambda k: lm[k]['bone']
    bone = {'bizygomaticWidth': abs(L('zygion_L')[0] - L('zygion_R')[0]) * 1000, 'bigonialWidth': abs(L('gonion_L')[0] - L('gonion_R')[0]) * 1000,
            'totalFaceHeight_nasionToMenton': (L('nasion')[1] - L('menton')[1]) * 1000}
    bone['bigonialOverBizygomatic'] = bone['bigonialWidth'] / bone['bizygomaticWidth']
    rep['bone'] = {k: round(float(v), 3 if 'Over' in k else 1) for k, v in bone.items()}
    rep['installedSkin'] = dict(FC.metrics(Va, F, lm, wh, lod), **extra_measures(Va, F, lm, lod, A))
    rep['targetSkin'] = dict(FC.metrics(T, F, lm, wh, lod), **extra_measures(T, F, lm, lod, A))
    lines.append('measure                                                        bone   installed skin   target skin')
    for k in rep['targetSkin']:
        lines.append(f'  {k:58s} {str(rep["bone"].get(k, "")):>7s} {str(rep["installedSkin"].get(k, "")):>12} {str(rep["targetSkin"][k]):>12}')
    ra, rb = FFACE.residuals(lm, Va, F), FFACE.residuals(lm, T, F)
    rep['coverAtLandmarksMm'] = {k: {'tableDepth': lm[k]['depthMm'], 'installedSkin': round(float(lm[k]['depthMm'] - ra[k]), 1), 'targetSkin': round(float(lm[k]['depthMm'] - rb[k]), 1),
                                     'usedByWarp': bool(lm[k]['use']), 'source': lm[k]['source']} for k in lm}
    lines.append('\ncover at the landmarks, mm: table depth / installed skin / target skin (* = not used by the warp)')
    for k, v in rep['coverAtLandmarksMm'].items():
        lines.append(f'  {k:22s} {v["tableDepth"]:6.1f} {v["installedSkin"]:6.1f} {v["targetSkin"]:6.1f} {"" if v["usedByWarp"] else "*"}')

    # ---- 头颈的深层包络 / deep envelope of head and neck
    import igl
    SV, SF = fb.merged(lambda p: p['tissue'] == 'bone' and p['name'] not in ('Hyoid bone',) and 'vertebra' not in p['name'].lower() and p['name'] not in ('Atlas', 'Axis'))
    d = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(T), np.ascontiguousarray(SV), np.ascontiguousarray(SF))[0])
    t = np.clip(d - 0.0025, 0.0015, 0.006)
    for _ in range(4):
        t = 0.5 * t + 0.5 * (A @ t)
    n = vertex_normals(T, F)
    for _ in range(3):
        n = 0.5 * n + 0.5 * (A @ n)
    n /= np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]
    old = os.path.join(RAW, 'out', 'female-target', 'deep-envelope.obj')
    E0 = np.array([[float(x) for x in ln.split()[1:4]] for ln in open(old) if ln.startswith('v ')])
    E = E0 + wh[:, None] * ((T - t[:, None] * n) - E0)
    write_obj(os.path.join(OUT, 'deep-envelope.obj'), E, F, 'female TARGET deep envelope; head from the face target (see manifest for the thickness rule), body as in female-target/deep-envelope.obj; same topology as skin.obj')
    hd = wh > 0.9
    rep['envelope'] = {'rule': 't = clip(d - 2.5 mm, 1.5 mm, 6 mm), d = distance from the target skin to skull or mandible; smoothed; assumption',
                       'thicknessOnHeadMm': {'p10': round(float(np.percentile(t[hd], 10) * 1000), 1), 'p50': round(float(np.median(t[hd]) * 1000), 1), 'p90': round(float(np.percentile(t[hd], 90) * 1000), 1)}}

    # ---- 冲突清单：头颈的深部结构相对包络 / conflict list: deep parts of head and neck against the envelope
    ymin = T[hd][:, 1].min() - 0.07
    rows = []
    for p in fb.deep_parts():
        v = fb.mesh(p)[0]
        if v[:, 1].max() < ymin or (v[:, 1].mean() < ymin):
            continue
        s = signed_distance(v, E, F) * 1000
        ss = signed_distance(v, T, F) * 1000
        if (s > 0).any():
            rows.append({'id': p['id'], 'name': p['name'], 'tissue': p['tissue'], 'shareOutsideEnvelope': round(float((s > 0).mean()), 3), 'p50Mm': round(float(np.median(s[s > 0])), 1),
                         'p95Mm': round(float(np.percentile(s, 95)), 1), 'maxMm': round(float(s.max()), 1), 'shareOutsideTargetSkin': round(float((ss > 0).mean()), 3), 'maxOutsideTargetSkinMm': round(float(ss.max()), 1)})
    rows.sort(key=lambda r: -r['shareOutsideEnvelope'] * max(r['p95Mm'], 0.1))
    rep['conflicts'] = rows
    lines.append(f'\nenvelope thickness on the head, mm (p10 / p50 / p90): {rep["envelope"]["thicknessOnHeadMm"]}')
    lines.append(f'\nCONFLICTS: {len(rows)} deep parts of head and neck have some surface outside the target envelope (share outside the envelope, p95 / max mm; share and max outside the target SKIN)')
    for tis, ttl in ((('bone', 'cartilage', 'tooth'), 'BONE, CARTILAGE, TEETH (hard)'), (('muscle', 'tendon'), 'MUSCLE'), (('organ', 'gland', 'brain', 'heart'), 'ORGANS, GLANDS, NODES')):
        lines.append(f'  -- {ttl}')
        for r in [r for r in rows if r['tissue'] in tis][:45]:
            lines.append(f'  {100 * r["shareOutsideEnvelope"]:5.1f} %  {r["p95Mm"]:5.1f} {r["maxMm"]:5.1f}   skin {100 * r["shareOutsideTargetSkin"]:5.1f} % {r["maxOutsideTargetSkinMm"]:5.1f}   {r["name"]}')

    # ---- 唇：Lip 部件和口轮匝肌要随皮肤向前多少 / lips: how far the part "Lip" and orbicularis oris must come forward with the skin
    rep['lipParts'] = []
    lines.append('\nlip parts against the target skin (the skin lips follow the depth table; these parts must be carried forward with it): median and least cover of the anterior third, mm, and the forward displacement needed')
    for nm, want in (('Lip', 0.5), ('Orbicularis oris', 3.0)):
        ps = [p for p in fb.deep_parts() if p['name'] == nm or (nm == 'Orbicularis oris' and 'orbicularis oris' in p['name'].lower())]
        for p in ps:
            v = fb.mesh(p)[0]
            v = v[v[:, 2] > np.percentile(v[:, 2], 67)]
            c = -signed_distance(v, T, F) * 1000
            need = max(float(np.median(c)) - want, 0.0)
            rep['lipParts'].append({'id': p['id'], 'name': p['name'], 'medianCoverMm': round(float(np.median(c)), 1), 'leastCoverMm': round(float(c.min()), 1), 'coverWantedMm': want, 'forwardDisplacementNeededMm': round(need, 1)})
            lines.append(f'  {p["name"]:28s} median {np.median(c):5.1f}  least {c.min():5.1f}  wanted {want}  -> move forward (+z) by about {need:.1f} mm')
    # ---- 颊是否外凸：颧点、上第二磨牙处、口角三点定一个平面，量三角形形心处皮肤离平面多远（正 = 外凸）
    # ---- is the cheek convex: zygion, supra-M2 and the mouth corner define a plane; how far the skin stands off it at the centroid of the triangle (positive = convex)
    import igl as _igl
    nearp = lambda q: _igl.point_mesh_squared_distance(np.ascontiguousarray(np.asarray(q)[None]), np.ascontiguousarray(T), np.ascontiguousarray(F))[2][0]
    lipsr = T[ES.face_protect(lod)[1]['lips']]
    rep['cheekConvexityMm'] = {}
    for S, sg in (('L', 1), ('R', -1)):
        a, b = nearp(lm['zygion_' + S]['target']), nearp(lm['supraM2_' + S]['target'])
        c = lipsr[np.argmax(sg * lipsr[:, 0])]
        nrm = np.cross(b - a, c - a)
        nrm = nrm / np.linalg.norm(nrm) * (1 if (np.cross(b - a, c - a) @ np.array([sg, 0, 0.5])) > 0 else -1)
        g = (a + b + c) / 3
        rep['cheekConvexityMm'][S] = round(float((nearp(g + 0.02 * nrm) - g) @ nrm * 1000), 1)
    lines.append(f'\ncheek convexity (skin above the plane zygion - supra-M2 - mouth corner at the centroid, mm; positive = convex): {rep["cheekConvexityMm"]}')
    json.dump(rep, open(os.path.join(OUT, 'face-report.json'), 'w'), ensure_ascii=False, indent=1)
    json.dump({'envelope': rep['envelope'], 'lipParts': rep['lipParts'], 'conflicts': rows}, open(os.path.join(OUT, 'conflict-list.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(OUT, 'face-report.txt'), 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))
    fit = json.load(open(os.path.join(OUT, 'final-fit.json')))
    json.dump({
        'schema': 1, 'kind': 'target',
        'what': {'zh': '女性目标皮肤（全身），头面部按她的颅骨和软组织厚度表重做；没有为包住任何深部结构而外推。不是可安装的皮肤包。',
                 'en': 'female target skin (whole body) with head and face rebuilt from her skull and soft-tissue depth tables; nothing was pushed out to enclose any deep part. Not an installable skin package.'},
        'source': {'name': 'Momentum Human Rig (MHR) v1.0.1', 'url': 'https://github.com/facebookresearch/MHR', 'license': 'Apache-2.0',
                   'attribution': 'MHR, Copyright (c) Meta Platforms, Inc. and affiliates, licensed under the Apache License 2.0; shaped for this body by tools/bodyshape'},
        'basedOn': {'body': 'female', 'key': key},
        'frame': 'metres, Y up, +Z anterior, +X subject left; same origin as public/anatomy/female',
        'statureM': fit['statureM'], 'bmiByVolume': fit['bmiByVolume'],
        'faceSources': {'midline': FFACE.SRC_MID, 'bilateralAndCheek': FFACE.SRC_LAT,
                        'notUsedByTheWarp': [k for k, v in lm.items() if not v['use']],
                        'assumptions': ['oral fissure 2.75 mm above the upper incisal edge (audit: published range 2-3.4 mm)', 'envelope thickness rule', 'vault 6 mm for the cranium scale']},
        'envelope': rep['envelope'],
        'files': {'skin.obj': 'target skin, MHR LOD0 topology and vertex order', 'deep-envelope.obj': 'deep envelope, same topology; head from this target, body from female-target/',
                  'conflict-list.json': 'deep parts of head and neck outside the envelope, per part', 'face-landmarks.json': 'landmarks on the skull, depths, sources, targets',
                  'face-report.json, face-report.txt': 'measurements (bone, installed skin, target skin), cover at the landmarks, conflicts',
                  'target-state.npz': 'MHR identity, parameters and per-vertex offsets of skin.obj', 'LICENSE-MHR.txt, NOTICE-MHR.txt': 'licence text and attribution',
                  'compare-*.png, face-pins.png': 'installed skin (left) beside the target (right); target over her skull with the depth pins'},
    }, open(os.path.join(OUT, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
    for f in ('LICENSE-MHR.txt', 'NOTICE-MHR.txt'):
        shutil.copy(os.path.join(inst, f), os.path.join(OUT, f))

    from PIL import Image
    skin = (0.87, 0.72, 0.62)
    eye = 0.5 * (fb.verts('Left vitreous body').mean(0) + fb.verts('Right vitreous body').mean(0))
    top = max(Va[:, 1].max(), T[:, 1].max())
    hv = T[:, 1] > top - 0.34
    Fh = F[hv[F].all(1)]
    c0 = np.array([eye[0], 0.0, eye[2] - 0.08])
    for tag, angd, view in (('front', 0.0, 'front'), ('threequarter', -35.0, 'front'), ('profile', 0.0, 'side')):
        a = np.radians(angd)
        R = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
        ims = []
        for V in (Va, T):
            pth = os.path.join(OUT, f'_tmp-{tag}.png')
            lo_, hi_ = ([eye[0] - 0.17, top - 0.30, -1.0], [eye[0] + 0.17, top + 0.01, 1.0]) if view == 'front' else ([-1.0, top - 0.30, eye[2] - 0.20], [1.0, top + 0.01, eye[2] + 0.13])
            render_closeup([((V - c0) @ R.T + c0, Fh, skin)], pth, lo_, hi_, views=(view,), height=900)
            ims.append(Image.open(pth).convert('RGB'))
            os.remove(pth)
        W = Image.new('RGB', (ims[0].width + ims[1].width, max(i.height for i in ims)), 'white')
        W.paste(ims[0], (0, 0))
        W.paste(ims[1], (ims[0].width, 0))
        W.save(os.path.join(OUT, f'compare-{tag}.png'))
    BV, BF = fb.merged(lambda p: p['tissue'] in ('bone', 'tooth') and p['name'] != 'Hyoid bone')
    PV, PF = FC.pins(lm)
    render_closeup([(T, Fh, skin), (BV, BF, (0.92, 0.9, 0.82)), (PV, PF, (0.1, 0.3, 0.9))], os.path.join(OUT, 'face-pins.png'), [eye[0] - 0.10, eye[1] - 0.13, eye[2] - 0.09], [eye[0] + 0.10, eye[1] + 0.07, eye[2] + 0.12],
                   views=('front', 'side'), height=1000, alpha=0.35)


if __name__ == '__main__':
    main()
