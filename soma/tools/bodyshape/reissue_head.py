"""
新头的皮肤包（female-skin-head/）：读已发布的 female-skin/ 和新头的外形（head_outline.py 写出的目录），头颈换成新头，
再按深部结构补做外推，写到另一个目录；原包一个字节也不动。
The skin package for the new head (female-skin-head/): reads the shipped female-skin/ and the outline of the new head (the directory
head_outline.py writes), takes head and neck from the outline, pushes the skin out again over the deep parts and writes another
directory; not a byte of the source package is touched.

    SOMA_BODIES=<导出目录 export dir> python tools/bodyshape/reissue_head.py --build <构建目录 build dir>
                    [--outline female-head-outline-s1606] [--src female-skin] [--out female-skin-head] [--key <fittedTo.key>]

顺序 / order
  读的是“头已形变、体形重塑已按新目标包做完”的那次构建的导出（SOMA_BODIES；export-parts.ts 的 SOMA_EXPORT_FROM / SOMA_EXPORT_TO），
  fittedTo.key 取该构建报告里的 skinPackage.internalsKey。
  Reads the export of the build in which the head is warped and the body-shape stage has run against the new target package (SOMA_BODIES;
  SOMA_EXPORT_FROM / SOMA_EXPORT_TO of export-parts.ts); fittedTo.key is skinPackage.internalsKey of that build's report.

外推 / the enclosure
  1 头部的骨上至少 2 mm（做法和理由同 reissue_r2.py 的 face_step：位移低通；眼睑、唇、鼻的保护区和眼球周围 22 mm 不动）。
    at least 2 mm over the bone of the head (as face_step of reissue_r2.py, with its reasons: low-passed; the protected lid, lip and
    nose regions and 22 mm round each globe do not move).
  2 混合带下缘以下 30 mm 起往上的全部深部结构（肌、器官、骨，不含 enclose_skin 排除的眼、唇、牙、鼻软骨等）：皮肤下至少 2.5 mm，
    每个顶点最多外推 12 mm。头部的软组织这一次是变形进皮肤里的，所以面部和颅盖也参加（r2 那一版不参加）。
    every deep part from 30 mm below the lower edge of the blend band upwards (muscle, organ, bone; without what enclose_skin leaves
    out: eye, lips, teeth, nasal cartilages ...): at least 2.5 mm under the skin, at most 12 mm of push per vertex. The soft parts of
    the head were warped into the skin this time, so face and vault take part as well (they did not in r2).
  颈部没有另外的“厚度表”可用：2.5 mm 是 enclose_skin 的规则。躯干和四肢不动（与原包逐顶点相同），只报告包住的情况。
  No depth table is available for the neck: 2.5 mm is the rule of enclose_skin. Trunk and limbs are not touched (vertex for vertex the
  source package); their containment is reported only.

参数 / the parametrisation
  fit-state-final.npz 沿用原包的身份和姿势参数，新头全部落在逐顶点偏移里（offsets）；joints.json 里头的关节（c_head、c_jaw、c_teeth、
  c_tongue、l_eye、r_eye）换成新头的位置和朝向，其余关节照旧。
  fit-state-final.npz keeps the identity and pose parameters of the source package and the new head lives entirely in the per-vertex
  offsets; in joints.json the joints of the head (c_head, c_jaw, c_teeth, c_tongue, l_eye, r_eye) take the position and orientation of
  the new head, the others stay.
"""
import hashlib
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enclose_skin as ES  # noqa: E402
import final_female as FF  # noqa: E402
import mhrlib  # noqa: E402
import reissue_r2 as R  # noqa: E402
from bodylib import RAW, Body  # noqa: E402
from fit_check import classify, signed_distance  # noqa: E402
from fit_skin import write_obj  # noqa: E402
from measure import bone_landmarks, mesh_volume, surface_measures  # noqa: E402

KEEP = ('weights.bin', 'fit.json', 'fit.txt', 'LICENSE-MHR.txt', 'NOTICE-MHR.txt', 'target-shape.npz', 'pose-cache.npz', 'superficial.json', 'breast-placement.json', 'breast-placement.txt')


def arg(k, d=None):
    return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d


def main():
    out_name = arg('--out', 'female-skin-head')
    assert out_name.startswith('female-skin-head') and not out_name.endswith(('-open', '-grafted')), 'this tool writes female-skin-head* package directories only'
    out = os.path.join(RAW, 'out', out_name)
    src = os.path.join(RAW, 'out', arg('--src', 'female-skin'))
    od = os.path.join(RAW, 'out', arg('--outline', 'female-head-outline-s1606'))
    build = arg('--build')
    key = arg('--key')
    if key is None:
        assert build, 'give --build <build directory> (its pipeline-report.json names the key) or --key'
        key = json.load(open(os.path.join(build, 'pipeline-report.json')))['skinPackage']['internalsKey']
    assert os.environ.get('SOMA_BODIES'), 'set SOMA_BODIES to the export of the build the skin is to be fitted to'
    man = json.load(open(os.path.join(src, 'manifest.json')))
    st = np.load(os.path.join(src, 'fit-state-final.npz'))
    ident, mp, lod = st['identity'], st['mp'], int(st['lod'])
    Vm, Pm, skm = mhrlib.run(ident, mp, lod, True)
    F = mhrlib.faces(lod)
    V0 = R.load_obj(os.path.join(src, 'skin.obj'))[0]
    T, Ft = R.load_obj(os.path.join(od, 'skin-with-new-head.obj'))
    assert np.array_equal(Ft, F) and len(T) == len(V0), 'the outline differs from the source package in topology'
    so = np.load(os.path.join(od, 'fit-state-outline.npz'))
    b = so['joinWeight'].astype(float)
    fb = Body('female')
    L = bone_landmarks(fb)
    A = ES.adjacency(len(V0), F)
    wh, pw = FF.head_weight(lod), ES.face_protect(lod)[0]
    log = [f'female: skin package for the new head, {os.path.basename(src)} + {os.path.basename(od)} -> {out_name}; fittedTo.key {key}']
    rep = {'body': 'female', 'source': os.path.basename(src), 'outline': os.path.basename(od), 'fittedToKey': key}
    V = T.copy()
    Pd, grp, pid, parts = ES.deep_samples(fb)
    # 保护区（眼睑、唇、鼻）之外的权重向保护区边缘渐收：直接用 1 − pw 时，颏唇沟下方和内眦旁留下一道硬棱（看图发现）。保护区内仍为零。
    # the weight outside the protected regions (lids, lips, nose) tapers towards their edge: with 1 - pw as it is a hard ridge was left under the
    # mentolabial fold and beside the medial canthi (seen in the renders). Inside the protected regions it stays zero.
    ps = pw.copy()
    for _ in range(12):
        ps = np.maximum(ps, 0.5 * ps + 0.5 * (A @ ps))
    for _ in range(6):
        ps = 0.5 * ps + 0.5 * (A @ ps)
    free = np.minimum(1 - pw, 1 - np.clip(ps, 0, 1))

    # ---- 1 头部的骨 / bone of the head
    hb = Pd[(grp == list(ES.GROUPS).index('bone')) & (classify(Pd, L) == 'head')]
    orb = np.ones(len(V))
    for side_ in ('Left', 'Right'):
        u_ = np.clip((np.linalg.norm(V - fb.verts(f'{side_} vitreous body').mean(0), axis=1) - 0.022) / 0.012, 0, 1)
        orb *= u_ * u_ * (3 - 2 * u_)
    sb = signed_distance(hb, V, F)
    log.append(f'  head bone before the floor: {100 * (sb > 0).mean():.2f} % of the samples outside the skin, furthest {sb.max() * 1000:.1f} mm; {100 * (sb > -0.002).mean():.2f} % with under 2 mm of cover')
    raised = np.zeros(len(V))
    for _ in range(3):
        sb = signed_distance(hb, V, F)
        if not (sb > -0.002).any():
            break
        keep = ES.MARGIN
        ES.MARGIN = 0.0022
        Vq = ES.enclose(V, F, hb[sb > -0.0022], [], np.full(len(V), 0.004), passes=8)
        ES.MARGIN = keep
        nq = R.smooth_normals(V, F, A)
        dq = FF.spread(np.einsum('ij,ij->i', Vq - V, nq).clip(0), A, np.full(len(V), 0.004), rings=2, smooth=6, final=3) * np.clip(b, 0, 1) * free * orb
        V = V + dq[:, None] * nq
        raised += dq
    sb = signed_distance(hb, V, F) * 1000
    rep['headBone'] = {'verticesRaised': int((raised > 0.0002).sum()), 'maxRaiseMm': round(float(raised.max() * 1000), 1), 'leastCoverMm': round(float(-sb.max()), 1), 'cover1stPercentileMm': round(float(-np.percentile(sb, 99)), 1)}
    log.append(f'  head bone cover: {json.dumps(rep["headBone"])}')

    # ---- 2 头颈的全部深部结构 / every deep part of head and neck
    y0 = float(V[b > 0.01][:, 1].min()) - 0.03
    zone = np.clip((V[:, 1] - y0) / 0.02, 0, 1)
    pushed = np.zeros(len(V))
    for _ in range(2):
        Ve = ES.enclose(V, F, Pd[Pd[:, 1] > y0], [], np.full(len(V), 0.012), passes=6)
        nq = R.smooth_normals(V, F, A)
        dn = FF.spread(np.einsum('ij,ij->i', Ve - V, nq).clip(0), A, np.full(len(V), 0.012)) * free * zone
        V = V + dn[:, None] * nq
        pushed += dn
    hd = V[:, 1] > y0
    rep['headAndNeck'] = {'fromHeightM': round(y0, 4), 'verticesPushed': int((pushed > 0.0002).sum()), 'maxPushMm': round(float(pushed.max() * 1000), 1),
                          'medianPushWherePushedMm': round(float(np.median(pushed[pushed > 0.0002]) * 1000), 1) if (pushed > 0.0002).any() else 0.0,
                          'pushOnTheNeckBandMm_p50_p95': [round(float(np.percentile(pushed[(b > 0.01) & (b < 0.99)], q) * 1000), 1) for q in (50, 95)]}
    log.append(f'  head and neck: {json.dumps(rep["headAndNeck"])}')
    assert np.abs(V[~hd] - V0[~hd]).max() < 1e-9, 'vertices below the neck moved'

    # ---- 复核 / checks
    reg = classify(Pd, L)
    c0, s0 = ES.containment(Pd, grp, reg, T, F)
    c1, s1 = ES.containment(Pd, grp, reg, V, F)
    log.append('\n== containment of the deep parts: the OUTLINE as it is (source package below the neck)\n' + ES.fmt_cont(c0) + '\n== AFTER the enclosure\n' + ES.fmt_cont(c1))
    outside = []
    for k, p in enumerate(parts):
        m = pid == k
        if m.sum() >= 5 and s1[m].max() > 0:
            outside.append({'id': p['id'], 'name': p['name'], 'tissue': p['tissue'], 'maxOutsideOutlineMm': round(float(s0[m].max()), 1), 'maxOutsideMm': round(float(s1[m].max()), 1), 'shareOutside': round(float((s1[m] > 0).mean()), 4),
                            'headOrNeck': bool(Pd[m][:, 1].max() > y0)})
    outside.sort(key=lambda w: -w['maxOutsideMm'])
    log.append(f'deep parts with a sample outside the skin after the enclosure: {len(outside)} ({sum(w["headOrNeck"] for w in outside)} of head and neck)' +
               ''.join(f'\n   {w["maxOutsideOutlineMm"]:5.1f} -> {w["maxOutsideMm"]:5.1f} mm  {100 * w["shareOutside"]:6.2f} %  {w["name"]} [{w["tissue"]}]{"" if w["headOrNeck"] else "  (below the neck)"}' for w in outside[:60]))
    jn = mhrlib.joint_names(lod)
    J = {f'{a}_{Sd}': Pm[jn.index(f'{s}_{m}')] for Sd, s in (('L', 'l'), ('R', 'r')) for a, m in (('shoulder', 'uparm'), ('elbow', 'lowarm'), ('wrist', 'wrist'), ('hip', 'upleg'), ('knee', 'lowleg'), ('ankle', 'foot'))}
    ilio = 0.5 * (L['iliocristale_L'][1] + L['iliocristale_R'][1]) - L['floor'][1]
    g = [surface_measures(W, F, J, levels={'iliocristale': ilio}) for W in (V0, T, V)]
    rep['anthropometry'] = {k: {'sourcePackage': round(float(g[0][k]), 2), 'outline': round(float(g[1][k]), 2), 'final': round(float(g[2][k]), 2)} for k in R.GIRTHS if k in g[2]}
    log.append('\nmeasure                 source   outline    final')
    for k, v in rep['anthropometry'].items():
        log.append(f'  {k:22s} {v["sourcePackage"]:8.2f} {v["outline"]:8.2f} {v["final"]:8.2f}')
    bmi = lambda W: mesh_volume(W, F) * 1010.0 / np.ptp(W[:, 1]) ** 2
    rep['statureM'] = {'sourcePackage': round(float(np.ptp(V0[:, 1])), 4), 'final': round(float(np.ptp(V[:, 1])), 4)}
    rep['bmiByVolume'] = {'sourcePackage': round(float(bmi(V0)), 2), 'final': round(float(bmi(V)), 2), 'note': 'volume x 1010 kg/m3 over stature squared, as reissue_r2.py'}
    rep['closed'] = ES.is_closed(F)
    rep['containment'] = {'outline': c0, 'final': c1, 'partsOutside': outside}
    log.append(f'stature {rep["statureM"]}, BMI by volume {rep["bmiByVolume"]}, closed {rep["closed"]}')

    # ---- 头的关节 / the joints of the head
    Po, sko = mhrlib.run(so['identity'], so['mp'], lod, False)[1:3]
    s3, shift = so['headScale_xyz'].astype(float), so['headShift'].astype(float)
    piv = Po[jn.index('c_head')]
    jj = json.load(open(os.path.join(src, 'joints.json')))
    P, rot = np.array(jj['positions'], float), np.array(jj['rotation'], float)
    moved = {}
    for i, nme in enumerate(jn):
        if nme.startswith(FF.HEAD_JOINTS):
            q = piv + s3 * (Po[i] - piv) + shift
            moved[nme] = round(float(np.linalg.norm(q - P[i]) * 1000), 1)
            P[i], rot[i] = q, np.asarray(sko)[i, 3:7]
    lmk = json.load(open(os.path.join(od, 'landmarks.json')))
    eye_err = {S_: round(float(np.linalg.norm(P[jn.index(j)] - np.array(lmk['globes'][S_]['targetCentre'])) * 1000), 2) for S_, j in (('L', 'l_eye'), ('R', 'r_eye'))}
    assert max(eye_err.values()) < 0.2, f'eye joints disagree with the outline: {eye_err}'
    rep['joints'] = {'headJointsMovedMm': moved, 'eyeJointAgainstTheOutlineMm': eye_err}
    log.append(f'  joints of the head moved (mm): {moved}; eye joints against the outline {eye_err}')

    # ---- 写包 / write the package
    os.makedirs(out, exist_ok=True)
    for f in KEEP:
        if os.path.exists(os.path.join(src, f)):
            shutil.copy(os.path.join(src, f), os.path.join(out, f))
    write_obj(os.path.join(out, 'skin.obj'), V, F, f'female skin with the new head, MHR LOD{lod} topology (Apache-2.0); metres, Y up, +Z anterior, +X left')
    (V - Vm).astype(np.float32).tofile(os.path.join(out, 'residual-offsets.f32'))
    (mhrlib.run(ident, mp, lod, False)[0] + (V - Vm)).astype(np.float32).tofile(os.path.join(out, 'skin-no-pose-correctives.f32'))
    eo = np.fromfile(os.path.join(src, 'enclosure-offsets.f32'), dtype=np.float32).reshape(-1, 3)
    ((1 - b)[:, None] * eo + (V - T)).astype(np.float32).tofile(os.path.join(out, 'enclosure-offsets.f32'))
    np.savez(os.path.join(out, 'fit-state-final.npz'), identity=ident, mp=mp, offsets=V - Vm, lod=lod)
    jj['positions'], jj['rotation'] = np.round(P, 5).tolist(), np.round(rot, 6).tolist()
    json.dump(jj, open(os.path.join(out, 'joints.json'), 'w'), ensure_ascii=False)
    hbw = FF.head_blend(lod, A, V, fb)
    hm = R.head_muscles_outside(fb, V, F, hbw)
    rep['headPartsOutside'] = hm
    log.append(f'  head: {len(hm)} deep parts of the head partly outside the skin:' + ''.join(f'\n     {r["maxOutsideMm"]:5.1f} mm {100 * r["shareOutside"]:5.1f} %  {r["name"]} [{r["tissue"]}]' for r in hm))
    sha = lambda f: hashlib.sha1(open(f, 'rb').read()).hexdigest()[:16]
    man['fittedTo'] = {'body': 'female', 'key': key}
    man['statureM'], man['bmiByVolume'] = rep['statureM']['final'], rep['bmiByVolume']['final']
    man['what'] = {'zh': '女性皮肤（MHR LOD0 拓扑，单层封闭）：头是参数化头模型自己的女性头（外形不再贴她的颅骨，颅骨和头部软组织由几何管线变形进来），头颈再局部外推到包住深部结构；颈部以下与 female-skin 逐顶点相同',
                   'en': 'female skin in MHR LOD0 topology (closed single wall): the head is the parametric head model\'s own female head (its outer shape no longer follows her skull; skull and soft parts of the head are '
                         'warped into it by the geometry pipeline), head and neck pushed out locally to enclose the deep parts; below the neck vertex for vertex female-skin'}
    man['face']['notEnclosedMuscles'] = hm
    ids = set(ES.excluded_face_parts(fb))
    man['face']['notEnclosed']['partIds'] = sorted(ids | {r['id'] for r in hm})
    man['head'] = {'outline': os.path.basename(od), 'outlineSkinSha1': sha(os.path.join(od, 'skin-with-new-head.obj')), 'source': os.path.basename(src), 'report': 'head-report.json, head-report.txt',
                   'pinnedStatureM': lmk.get('pinnedStature', {}).get('statureM', 1.606), 'enclosure': {'headBone': rep['headBone'], 'headAndNeck': rep['headAndNeck'], 'marginMm': ES.MARGIN * 1000},
                   'parametrisation': 'identity and pose parameters of the source package; the new head lives in the per-vertex offsets; the head joints of joints.json are those of the new head',
                   'assumptions': ['no soft-tissue depth table for the neck: the 2.5 mm margin of enclose_skin is used there', 'eyebrow position: browStandIn of the outline\'s landmarks.json is a stand-in, no table was opened']}
    man['files'] = {k: v for k, v in man['files'].items() if k.split(',')[0].strip() in ('skin.obj', 'residual-offsets.f32', 'enclosure-offsets.f32', 'skin-no-pose-correctives.f32', 'weights.bin', 'joints.json', 'fit.json', 'LICENSE-MHR.txt')}
    man['files']['fit.json, fit.txt'] = 'parametric fit of the SOURCE package (fit_skin.py); the head was replaced afterwards'
    man['files']['head-report.json, head-report.txt'] = 'this re-issue: enclosure, containment, anthropometry, joints (reissue_head.py)'
    json.dump(man, open(os.path.join(out, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
    json.dump(rep, open(os.path.join(out, 'head-report.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(out, 'head-report.txt'), 'w').write('\n'.join(log) + '\n')
    print('\n'.join(log))


if __name__ == '__main__':
    main()
