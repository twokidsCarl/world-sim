"""
皮肤包的再发布（r2）：读一个已有的皮肤包，只改三处，写到另一个目录；原包一个字节也不动。
Re-issue of a skin package (r2): reads an existing package, changes three things only and writes another directory; not a
byte of the source package is touched.

    python tools/bodyshape/reissue_r2.py female [--src female-skin] [--out female-skin-r2] [--steps face,folds,perineum]
                                               [--face-target female-face-target-r2] [--key <fittedTo.key>] [--strength 2.0]
    python tools/bodyshape/reissue_r2.py male   [--src male-skin]   [--out male-skin-r2]   [--steps folds,perineum]
    python tools/bodyshape/reissue_r2.py female --restamp <key> [--out female-skin-r2]     只改 manifest 里的 fittedTo.key / only rewrites fittedTo.key in the manifest

  face      （女）头重做：干净的 MHR 头 + 性别形状差，用一个光滑的空间变形放到她的颅骨上（face_r2.py）；同时写面部目标包（深层包络）。
            (female) the head is rebuilt: the clean MHR head plus a sex difference in shape, placed on her skull by one smooth space warp
            (face_r2.py); the face target package (deep envelope) is written as well.
  folds     腋窝和两大腿之间：按中面把两片皮肤分开（fold_r2.py）。axillae and between the thighs: the sheets are parted at the mid-surface (fold_r2.py).
  perineum  （男）睾丸后方、离外生殖器深部结构 10–40 mm 的一圈：把拟合的会阴面带到他的扫描皮肤上（移植片的过渡环在那里）。
            (male) the ring behind the testes, 10-40 mm from the deep genital parts: the fitted perineal surface is brought onto his scanned
            skin (the transition ring of the graft lies there).

fittedTo.key 默认照抄原包。注意（女）：管线的内部结构指纹含面部目标包深层包络的散列，所以管线一旦改用 female-face-target-r2，
指纹就会变；届时用 --restamp 把管线报出的新指纹写进来（皮肤本身不必重做：头部只保证骨上的覆盖，骨没有动）。
fittedTo.key is copied from the source package by default. Note (female): the pipeline's internals fingerprint includes a hash of the
face target's deep envelope, so it changes as soon as the pipeline is pointed at female-face-target-r2; --restamp then writes the new
fingerprint the pipeline reports (the skin itself need not be redone: on the head it guarantees cover over bone only, and no bone moves).
"""
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enclose_skin as ES  # noqa: E402
import mhrlib  # noqa: E402
from bodylib import RAW, Body, render_closeup  # noqa: E402
from fit_check import classify, signed_distance  # noqa: E402
from fit_skin import vertex_normals, write_obj  # noqa: E402
from measure import bone_landmarks, mesh_volume, surface_measures  # noqa: E402

SKIN = (0.87, 0.72, 0.62)
GIRTHS = ['stature', 'bmiFromVolume', 'volumeL', 'neckMinGirth', 'chestGirth', 'waistNavelGirth', 'waistIliacGirth', 'buttockGirth', 'thighProximalGirth', 'thighMidGirth',
          'thighLowerGirth', 'calfMaxGirth', 'ankleMinGirth', 'upperArmMidGirth', 'forearmMaxGirth', 'wristMinGirth']


def arg(k, d=None):
    return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d


def smooth_normals(V, F, A, n=3):
    nr = vertex_normals(V, F)
    for _ in range(n):
        nr = 0.5 * nr + 0.5 * (A @ nr)
    return nr / np.maximum(np.linalg.norm(nr, axis=1), 1e-12)[:, None]


# ---------------------------------------------------------------- 女性的脸 / the female face
def face_step(V0, F, ident, mp, lod, fb, L, A, log, strength):
    import face_female as FFACE
    import face_r2 as R2
    import final_female as FF
    Vm, P, _ = mhrlib.run(ident, mp, lod, True)
    jn = mhrlib.joint_names(lod)
    wh = FF.head_weight(lod)
    table = R2.depth_table()
    lm = R2.apply_table(R2.fix_landmarks(FFACE.landmarks(fb), fb), table)
    em = 0.5 * (P[jn.index('l_eye')] + P[jn.index('r_eye')])
    D = R2.dimorphism_field(Vm, F, wh, em, log)
    for _ in range(2):
        D = 0.5 * D + 0.5 * (A @ D)
    marks = FF.face_landmarks(ident, lod)
    V, Pj = R2.rebuild_head(Vm, P, jn, F, V0, wh, fb, lm, table, marks, R2.mhr_midline(ident, lod, *marks), D, strength, A, log)
    V, eye_info = R2.cornea_cover(V, F, Pj, jn, wh, fb, log)
    # 眼睑保持原包里的形状，只作刚体移动：开口工具按睑裂那条三角形带的折角和边长找它，光滑变形把这些量改了以后它找不到（试过：open_skin 报错）。
    # 每侧：把原包的眼睑区用刚体变换（无缩放）对到新位置上，核心区完全取它，向外按权重过渡。
    # The lids keep the shape they have in the source package and move rigidly only: the opening tool finds the strip of triangles across
    # the fissure by its bends and edge lengths, and after a smooth warp changed those it no longer could (tried: open_skin failed).
    # Per side: the lid region of the source package is laid on the new position by a rigid transform (no scale), taken in full in the core and blended outwards.
    keep = R2.lid_ramp(lod, A)
    reg = ES.face_protect(lod)[1]
    for S_ in 'LR':
        core = reg['lids' + S_]
        _, Rr, _ = R2._procrustes(V0[core], V[core])
        tr = V[core].mean(0) - V0[core].mean(0) @ Rr.T
        nearer_left = np.abs(V0[:, 0] - V0[reg['lidsL']][:, 0].mean()) < np.abs(V0[:, 0] - V0[reg['lidsR']][:, 0].mean())
        side = np.where((keep > 0) & (nearer_left if S_ == 'L' else ~nearer_left))[0]
        V[side] = V[side] + keep[side, None] * (V0[side] @ Rr.T + tr - V[side])
        eye_info[S_]['lidsRigidFromSourcePackage'] = True
    # 骨上的覆盖：头部的骨上至少 2 mm（位移低通；只对骨；眼睑、唇、鼻的保护区不动）。厚度表在鼻骨下端只有 2.8 mm，所以这里不能要求更多：
    # 第一次要求 3.5 mm，鼻根和眶缘被顶出一个方块（最多 11 mm）。
    # Cover over bone: at least 2 mm over head bone (low-passed; bone only; the protected lid, lip and nose regions do not move). The depth table
    # has only 2.8 mm at rhinion, so no more can be asked here: the first attempt asked 3.5 mm and raised a block at the nasal root and the orbital rims (up to 11 mm).
    Pd, grp, _, _ = ES.deep_samples(fb)
    hb = Pd[(grp == list(ES.GROUPS).index('bone')) & (classify(Pd, L) == 'head')]
    pw = ES.face_protect(lod)[0]
    raised = np.zeros(len(V))
    # 眼球中心 22 mm 以内不抬（那里是眼睑和眦，眶缘的骨本来就在睑面之后或与之齐平），到 34 mm 处升到全量
    # nothing is raised within 22 mm of a globe centre (lids and canthi; the orbital rims lie behind or level with the lid surface anyway), rising to full at 34 mm
    orb = np.ones(len(V))
    for side_ in ('Left', 'Right'):
        u_ = np.clip((np.linalg.norm(V - fb.verts(f'{side_} vitreous body').mean(0), axis=1) - 0.022) / 0.012, 0, 1)
        orb *= u_ * u_ * (3 - 2 * u_)
    sb = signed_distance(hb, V, F)
    log.append(f'  head bone before the floor: {100 * (sb > 0).mean():.2f} % of the samples outside the skin, furthest {sb.max() * 1000:.1f} mm; {100 * (sb > -0.002).mean():.2f} % with under 2 mm of cover')
    for _ in range(3):
        sb = signed_distance(hb, V, F)
        if not (sb > -0.002).any():
            break
        keep = ES.MARGIN
        ES.MARGIN = 0.0022
        Vq = ES.enclose(V, F, hb[sb > -0.0022], [], np.full(len(V), 0.004), passes=8)
        ES.MARGIN = keep
        nq = smooth_normals(V, F, A)
        dq = FF.spread(np.einsum('ij,ij->i', Vq - V, nq).clip(0), A, np.full(len(V), 0.004), rings=2, smooth=6, final=3) * wh * (1 - pw) * orb
        V = V + dq[:, None] * nq
        raised += dq
    sb = signed_distance(hb, V, F) * 1000
    log.append(f'  head bone cover: skin raised on {int((raised > 0.0002).sum())} vertices, max {raised.max() * 1000:.1f} mm; least cover over head bone {-sb.max():.1f} mm, 1st percentile {-np.percentile(sb, 99):.1f} mm')
    # 头颈交界以下的软组织仍须包住（头的权重小于 1 的那一带混进了新的头）：按原脚本的规则，只在“面和颅盖”以外补推
    # Soft tissue below the junction must still be enclosed (the band where the head weight is under 1 now carries some of the new head):
    # pushed again by the rule of the original script, outside "face and vault" only
    hbw = FF.head_blend(lod, A, V, fb)
    Ve = ES.enclose(V, F, Pd[Pd[:, 1] > V[wh > 0.02][:, 1].min() - 0.03], [], np.full(len(V), 0.012), passes=6)
    nq = smooth_normals(V, F, A)
    dn = FF.spread(np.einsum('ij,ij->i', Ve - V, nq).clip(0), A, np.full(len(V), 0.012)) * (1 - hbw) * (1 - pw) * (wh > 0.02)
    V = V + dn[:, None] * nq
    log.append(f'  neck junction: skin pushed out again over soft tissue on {int((dn > 0.0002).sum())} vertices, max {dn.max() * 1000:.1f} mm (outside face and vault only)')
    return V, {'lm': lm, 'table': table, 'wh': wh, 'eyes': eye_info, 'hbw': hbw, 'Pj': Pj, 'jn': jn}


def head_muscles_outside(fb, V, F, hbw):
    """头部略在皮肤外的深部部件（与 enclose_skin 写 manifest.face.notEnclosedMuscles 的规则相同）
    Deep parts of the head lying partly outside the skin (the rule by which enclose_skin writes manifest.face.notEnclosedMuscles)"""
    rows, skipped = [], ES.excluded_face_parts(fb)
    ymin = V[hbw > 0.5][:, 1].min()
    for p in fb.deep_parts():
        if p['id'] in skipped:
            continue
        v = fb.mesh(p)[0]
        if v[:, 1].min() < ymin:
            continue
        s = signed_distance(v, V, F) * 1000
        if (s > 0).any():
            rows.append({'id': p['id'], 'name': p['name'], 'tissue': p['tissue'], 'shareOutside': round(float((s > 0).mean()), 3), 'maxOutsideMm': round(float(s.max()), 1)})
    return sorted(rows, key=lambda r: -r['maxOutsideMm'])


def face_measures(V, F, lm, wh, lod, A, fb):
    import face_female as FFACE
    import face_female_checks as FC
    import face_target_report as FT
    m = dict(FC.metrics(V, F, lm, wh, lod), **FT.extra_measures(V, F, lm, lod, A))
    near = lambda q: __import__('igl').point_mesh_squared_distance(np.ascontiguousarray(np.asarray(q)[None]), np.ascontiguousarray(V), np.ascontiguousarray(F))[2][0]
    m['midRamusWidth'] = round(float(abs(near(lm['midRamus_L']['target'])[0] - near(lm['midRamus_R']['target'])[0]) * 1000), 1)
    # 口宽：唇区里口裂那道褶（埋在两唇之间的顶点）的左右跨度；瞳距取两眼球中心的距离
    # mouth width: left-right span of the crease of the oral fissure (the vertices buried between the lips) inside the lip region; interpupillary distance = between the globe centres
    reg = ES.face_protect(lod)[1]
    n = vertex_normals(V, F)
    import igl
    w = igl.fast_winding_number(np.ascontiguousarray(V), np.ascontiguousarray(F), np.ascontiguousarray(V + 0.0015 * n))
    lips = reg['lips']
    cr = lips[w[lips] > 0.5]
    if len(cr) > 5:
        m['mouthWidth_creaseSpan'] = round(float(np.ptp(V[cr, 0]) * 1000), 1)
        sto = float(np.median(V[cr, 1]))
        # 唇红高度的替代量：正中矢状轮廓上，口裂到上、下唇最突点的高度差（单色网格上没有唇红缘）
        # a stand-in for vermilion height: on the midsagittal profile, the height from the fissure to the most prominent point of the upper and of the lower lip (a mesh of one colour has no vermilion border)
        xc = float(lm['rhinion']['bone'][0])
        mid = np.where((np.abs(V[:, 0] - xc) < 0.002) & (np.abs(V[:, 1] - sto) < 0.016) & (V[:, 2] > V[cr, 2].max() - 0.004))[0]
        up, lo = mid[V[mid, 1] > sto + 0.001], mid[V[mid, 1] < sto - 0.001]
        if len(up) and len(lo):
            pu, pl = V[up[np.argmax(V[up, 2])]], V[lo[np.argmax(V[lo, 2])]]
            m['upperLipProminenceAboveFissure'] = round(float((pu[1] - sto) * 1000), 1)
            m['lowerLipProminenceBelowFissure'] = round(float((sto - pl[1]) * 1000), 1)
            m['upperLipAheadOfLower'] = round(float((pu[2] - pl[2]) * 1000), 1)
    m['interpupillary_globeCentres'] = round(float(np.linalg.norm(fb.verts('Left vitreous body').mean(0) - fb.verts('Right vitreous body').mean(0)) * 1000), 1)
    ca = [fb.verts(f'{s} upper canine secondary tooth') for s in ('Left', 'Right')] if fb.by_name.get('left upper canine secondary tooth') else None
    if ca:
        m['intercanineWidth_teeth'] = round(float(abs(ca[0][:, 0].mean() - ca[1][:, 0].mean()) * 1000), 1)
    # 眉弓：眶上缘中点处皮肤比眼球中心靠前多少；鼻尖突度：鼻区最前点比鼻下点靠前多少
    # brow: how far the skin at the mid-supraorbital point stands in front of the globe centre; nasal tip projection: most anterior point of the nose region ahead of subnasale
    for S, side in (('L', 'Left'), ('R', 'Right')):
        m['browAheadOfGlobeCentre_' + S] = round(float((near(lm['midSupraorbital_' + S]['target'])[2] - fb.verts(f'{side} vitreous body').mean(0)[2]) * 1000), 1)
    nose = V[reg['nose']]
    m['nasalTipProjection_aheadOfSubnasale'] = round(float((nose[:, 2].max() - near(lm['subnasale']['target'])[2]) * 1000), 1)
    res = FFACE.residuals(lm, V, F)
    cover = {k: round(float(lm[k]['depthMm'] - res[k]), 1) for k in lm}
    return m, cover


def write_face_target(tdir, V, F, fb, key_before, info, measures, cover, log, src_pkg):
    """面部目标包：格式与 female-face-target/ 相同（skin.obj、deep-envelope.obj、manifest.json、conflict-list.json、face-landmarks.json）。
    The face target package, in the format of female-face-target/ (skin.obj, deep-envelope.obj, manifest.json, conflict-list.json, face-landmarks.json)."""
    import igl

    import face_female as FFACE
    import face_r2 as R2
    os.makedirs(tdir, exist_ok=True)
    wh, lm, A = info['wh'], info['lm'], ES.adjacency(len(V), F)
    SV, SF = fb.merged(lambda p: p['tissue'] == 'bone' and p['name'] not in ('Hyoid bone', 'Atlas', 'Axis') and 'vertebra' not in p['name'].lower())
    d = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(V), np.ascontiguousarray(SV), np.ascontiguousarray(SF))[0])
    t = np.clip(d - 0.0025, 0.0015, 0.006)
    for _ in range(4):
        t = 0.5 * t + 0.5 * (A @ t)
    n = smooth_normals(V, F, A)
    E0 = np.array([[float(x) for x in ln.split()[1:4]] for ln in open(os.path.join(RAW, 'out', 'female-target', 'deep-envelope.obj')) if ln.startswith('v ')])
    E = E0 + wh[:, None] * ((V - t[:, None] * n) - E0)
    write_obj(os.path.join(tdir, 'skin.obj'), V, F, 'female TARGET skin r2 (the re-issued skin; head rebuilt from her skull); MHR LOD0 topology (Apache-2.0); metres, Y up, +Z anterior, +X left')
    write_obj(os.path.join(tdir, 'deep-envelope.obj'), E, F, 'female TARGET deep envelope r2; head from the r2 face (thickness rule in the manifest), body as in female-target/deep-envelope.obj; same topology as skin.obj')
    hd = wh > 0.9
    env = {'rule': 't = clip(d - 2.5 mm, 1.5 mm, 6 mm), d = distance from the target skin to skull or mandible; smoothed; assumption (unchanged from female-face-target)',
           'thicknessOnHeadMm': {'p10': round(float(np.percentile(t[hd], 10) * 1000), 1), 'p50': round(float(np.median(t[hd]) * 1000), 1), 'p90': round(float(np.percentile(t[hd], 90) * 1000), 1)},
           'bodyBelowTheHead': 'vertex for vertex female-target/deep-envelope.obj where the head skin weight is 0'}
    ymin = V[hd][:, 1].min() - 0.07
    rows = []
    for p in fb.deep_parts():
        v = fb.mesh(p)[0]
        if v[:, 1].max() < ymin or v[:, 1].mean() < ymin:
            continue
        s, ss = signed_distance(v, E, F) * 1000, signed_distance(v, V, F) * 1000
        if (s > 0).any():
            rows.append({'id': p['id'], 'name': p['name'], 'tissue': p['tissue'], 'shareOutsideEnvelope': round(float((s > 0).mean()), 3), 'p50Mm': round(float(np.median(s[s > 0])), 1),
                         'p95Mm': round(float(np.percentile(s, 95)), 1), 'maxMm': round(float(s.max()), 1), 'shareOutsideTargetSkin': round(float((ss > 0).mean()), 3), 'maxOutsideTargetSkinMm': round(float(ss.max()), 1)})
    rows.sort(key=lambda r: -r['shareOutsideEnvelope'] * max(r['p95Mm'], 0.1))
    lips = []
    for nm, want in (('Lip', 0.5), ('Orbicularis oris', 3.0)):
        # 唇：一个部件（Lip）或两个（Upper lip、Lower lip）都接受 / the lip: one part (Lip) or two (Upper lip, Lower lip) are both accepted
        for p in [p for p in fb.deep_parts() if p['name'] == nm or (nm == 'Lip' and p['name'] in ('Upper lip', 'Lower lip')) or (nm == 'Orbicularis oris' and 'orbicularis oris' in p['name'].lower())]:
            v = fb.mesh(p)[0]
            v = v[v[:, 2] > np.percentile(v[:, 2], 67)]
            c = -signed_distance(v, V, F) * 1000
            lips.append({'id': p['id'], 'name': p['name'], 'medianCoverMm': round(float(np.median(c)), 1), 'leastCoverMm': round(float(c.min()), 1), 'coverWantedMm': want,
                         'forwardDisplacementNeededMm': round(max(float(np.median(c)) - want, 0.0), 1)})
    json.dump({'envelope': env, 'lipParts': lips, 'conflicts': rows}, open(os.path.join(tdir, 'conflict-list.json'), 'w'), ensure_ascii=False, indent=1)
    FFACE.save(lm, os.path.join(tdir, 'face-landmarks.json'), {'depthTable': info['table'], 'coverOnTargetSkinMm': cover})
    bu = [r for r in rows if 'buccinator' in r['name'].lower()]
    json.dump({'targetSkin': measures, 'coverAtLandmarksMm': cover, 'envelope': env, 'buccinatorAgainstEnvelope': bu, 'conflicts': len(rows)}, open(os.path.join(tdir, 'face-report.json'), 'w'), ensure_ascii=False, indent=1)
    json.dump({
        'schema': 1, 'kind': 'target',
        'what': {'zh': '女性目标皮肤 r2（全身；就是再发布的皮肤），头面部从干净的 MHR 头加性别形状差、用光滑变形放到她的颅骨上。深层包络只在头部与 female-face-target 不同。不是可安装的皮肤包。',
                 'en': 'female target skin r2 (whole body; it is the re-issued skin), head and face from the clean MHR head plus a sex difference in shape, placed on her skull by a smooth warp. The deep envelope differs from female-face-target on the head only. Not an installable skin package.'},
        'source': {'name': 'Momentum Human Rig (MHR) v1.0.1', 'url': 'https://github.com/facebookresearch/MHR', 'license': 'Apache-2.0',
                   'attribution': 'MHR, Copyright (c) Meta Platforms, Inc. and affiliates, licensed under the Apache License 2.0; shaped for this body by tools/bodyshape'},
        'alsoUsed': {'name': 'MakeHuman / MPFB2 gender macro targets through Anny', 'license': 'assets CC0, Anny code Apache-2.0',
                     'how': 'only a displacement field (female minus neutral head) was taken and carried to MHR vertices; artist-made, not measured data'},
        'basedOn': {'body': 'female', 'key': key_before},
        'basedOnNote': 'key = internalsKeyBeforeShape of public/anatomy/female/pipeline-report.json (the skeleton fingerprint of the present build), rule 1 of femaleShape.matchTarget',
        'frame': 'metres, Y up, +Z anterior, +X subject left; same origin as public/anatomy/female',
        'statureM': round(float(np.ptp(V[:, 1])), 4), 'bmiByVolume': round(float(mesh_volume(V, F) * 1010.0 / np.ptp(V[:, 1]) ** 2), 2),
        'faceSources': {'midline': [R2.SRC_PARK, R2.SRC_SONITA], 'bilateralAndCheek': R2.SRC_TT, 'thinInsideTheTable_assumption': R2.GONIAL, 'notConstrained': list(R2.FREE),
                        'assumptions': ['oral fissure 2.75 mm above the upper incisal edge (audit: published range 2-3.4 mm)', 'scalp 5.5 mm over the vault', 'lip depths measured 6 mm above and below the fissure',
                                        'envelope thickness rule', 'strength of the sex difference in shape']},
        'envelope': env,
        'files': {'skin.obj': 'target skin, MHR LOD0 topology and vertex order', 'deep-envelope.obj': 'deep envelope, same topology; head from this target, body from female-target/',
                  'conflict-list.json': 'deep parts of head and neck outside the envelope, per part; lipParts as before (one Lip part or Upper lip + Lower lip)',
                  'face-landmarks.json': 'landmarks on the skull, depths, sources, targets, cover on the target skin', 'face-report.json': 'measurements and cover at the landmarks',
                  'LICENSE-MHR.txt, NOTICE-MHR.txt': 'licence text and attribution'},
    }, open(os.path.join(tdir, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
    for f in ('LICENSE-MHR.txt', 'NOTICE-MHR.txt'):
        shutil.copy(os.path.join(src_pkg, f), os.path.join(tdir, f))
    log.append(f'  face target written to {os.path.basename(tdir)}: envelope thickness on the head {env["thicknessOnHeadMm"]}; {len(rows)} deep parts of head and neck outside the envelope; buccinator: {bu}')
    return env, rows, lips


# ---------------------------------------------------------------- 男性会阴 / the male perineum
def perineum_step(V, F, fb, L, A, log):
    """睾丸后方、中线两侧 30 mm 内、离外生殖器深部结构 10–40 mm 的那一圈：把皮肤贴到扫描皮肤上。
    原来的 scan_details.fit_perineum 在离外生殖器的包围盒 6–26 mm 内把权重降到 0，所以这一圈仍是一个隆起（协调方量到中位数 9.1 mm）。
    这里按到深部结构表面的真实距离定权重：8 mm 以内不动（那里由开口工具换成扫描的皮肤），14 mm 以外全量。
    The ring behind the testes, within 30 mm of the midline and 10-40 mm from the deep genital parts: the skin is laid onto the scanned skin.
    scan_details.fit_perineum faded its weight to 0 within 6-26 mm of the bounding box of the genitalia, so this ring was still a mound
    (median 9.1 mm by the coordinator's measurement). Here the weight follows the true distance to the deep surfaces: nothing moves
    within 8 mm (the opening tool grafts the scanned skin there), everything beyond 14 mm."""
    import igl
    from fit_skin import reference_skin
    SV, SF = reference_skin(fb)
    SV, SF = np.ascontiguousarray(SV), np.ascontiguousarray(SF)
    gen = [p for p in fb.deep_parts() if any(t in p['name'].lower() for t in ('penis', 'scrotum', 'testis', 'epididymis', 'corpus cavernosum', 'corpus spongiosum', 'glans'))]
    GV, GF = fb.merged(lambda p: p in gen)
    GV, GF = np.ascontiguousarray(GV), np.ascontiguousarray(GF)
    tes = np.vstack([fb.mesh(p)[0] for p in gen if 'testis' in p['name'].lower()])
    hip = 0.5 * (L['hip_L'] + L['hip_R'])
    sm = lambda u: np.clip(u, 0, 1) ** 2 * (3 - 2 * np.clip(u, 0, 1))
    V = V.copy()
    V0 = V.copy()
    dg = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(V), GV, GF)[0])
    w = sm((0.045 - np.abs(V[:, 0] - hip[0])) / 0.015) * sm((dg - 0.008) / 0.006) * sm((0.075 - dg) / 0.025) * sm((tes[:, 2].mean() + 0.005 - V[:, 2]) / 0.012) * sm((hip[1] - 0.02 - V[:, 1]) / 0.03)
    sel = np.where(w > 0.01)[0]
    core = sel[(w[sel] > 0.9) & (np.abs(V[sel, 0] - hip[0]) < 0.03) & (dg[sel] > 0.010) & (dg[sel] < 0.040)]
    dist = lambda X: np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(X), SV, SF)[0])
    before = dist(V[core])
    for _ in range(4):
        c = igl.point_mesh_squared_distance(np.ascontiguousarray(V[sel]), SV, SF)[2]
        U = np.zeros_like(V)
        dv = c - V[sel]
        ln = np.linalg.norm(dv, axis=1)
        U[sel] = dv * np.minimum(1.0, 0.02 / np.maximum(ln, 1e-9))[:, None] * w[sel, None]
        U = 0.5 * U + 0.5 * (A @ U)
        V = V + U
    after = dist(V[core])
    q = lambda x: {'median': round(float(np.median(x) * 1000), 2), 'p90': round(float(np.percentile(x, 90) * 1000), 2), 'max': round(float(x.max() * 1000), 2)}
    # 扫描上睾丸后方的细网格顶点里，有多少离拟合皮肤不到 2 mm / of the fine scan vertices behind the testes, how many lie within 2 mm of the fitted skin
    ds = np.sqrt(igl.point_mesh_squared_distance(SV, GV, GF)[0])
    fine = np.where((ds > 0.010) & (ds < 0.040) & (np.abs(SV[:, 0] - hip[0]) < 0.03) & (SV[:, 2] < tes[:, 2].mean()))[0]
    near = lambda W: int((np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(SV[fine]), np.ascontiguousarray(W), np.ascontiguousarray(F))[0]) < 0.002).sum())
    info = {'zone': 'behind the testes, within 30 mm of the midline, 10-40 mm from the deep genital parts', 'vertices': int(len(sel)), 'coreVertices': int(len(core)),
            'skinToScanBeforeMm': q(before) if len(core) else None, 'skinToScanAfterMm': q(after) if len(core) else None, 'largestMoveMm': round(float(np.linalg.norm(V - V0, axis=1).max() * 1000), 1),
            'scanVerticesInZone': int(len(fine)), 'scanVerticesWithin2mmOfSkin': {'before': near(V0), 'after': near(V)}}
    log.append('  perineum ring: ' + json.dumps(info))
    return V, info


def vulva_rim_step(V, F, rim, A, log):
    """（女）把会阴的皮肤带到会阴皮肤片的外缘上（vulva-rim-target.json 的 rimLoop；kind 为 groove 和 edgeOfSelection 的点是目标，
    cutAboveThePlane 的点不强求）。做法：目标点各自最近的皮肤点移到目标点上，高斯径向基内插（σ 18 mm），做五遍；离环 25 mm 以内全量，到 60 mm 处收到零。
    (female) The perineal skin is brought onto the rim of the perineal skin patch (rimLoop of vulva-rim-target.json; points of kind groove
    and edgeOfSelection are targets, cutAboveThePlane points are not forced). The skin point closest to each target moves onto it, interpolated
    by Gaussian radial basis (sigma 18 mm), five passes; in full within 25 mm of the loop, fading to nothing at 60 mm."""
    import igl
    from scipy.spatial import cKDTree

    import face_r2 as R2
    P = np.array(rim['rimLoop']['positions'], float)
    kind = np.array(rim['rimLoop']['kind'])
    tgt = np.isin(kind, ['groove', 'edgeOfSelection'])
    dist = lambda W: np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(P), np.ascontiguousarray(W), np.ascontiguousarray(F))[0]) * 1000
    stat = lambda d: {'all': {'medianAbs': round(float(np.median(d)), 2), 'max': round(float(d.max()), 2)},
                      **{k: {'n': int((kind == k).sum()), 'medianAbs': round(float(np.median(d[kind == k])), 2), 'max': round(float(d[kind == k].max()), 2)} for k in np.unique(kind)}}
    before = stat(dist(V))
    V0 = V.copy()
    V = V.copy()
    dz = cKDTree(P).query(V)[0]
    u_ = np.clip((0.060 - dz) / 0.035, 0, 1)
    w = u_ * u_ * (3 - 2 * u_)
    sel = np.where(w > 0)[0]
    T = P[tgt][::2]
    for _ in range(5):
        c = igl.point_mesh_squared_distance(np.ascontiguousarray(T), np.ascontiguousarray(V), np.ascontiguousarray(F))[2]
        u = R2._rbf_fit(c, T, 0.018, 5e-3)
        V[sel] += w[sel, None] * u(V[sel])
    after = stat(dist(V))
    info = {'done': True, 'targets': int(tgt.sum()), 'rimToSkinBeforeMm': before, 'rimToSkinAfterMm': after, 'largestSkinMoveMm': round(float(np.linalg.norm(V - V0, axis=1).max() * 1000), 1),
            'verticesMoved': int((np.linalg.norm(V - V0, axis=1) > 0.0002).sum()),
            'source': 'rimLoop of female-skin-grafted-next/vulva-rim-target.json (Wu et al. 2015, PLoS ONE 10(7): e0132226, CC BY 4.0), points of kind groove and edgeOfSelection'}
    log.append('  vulvar rim: ' + json.dumps(info))
    return V, info


# ---------------------------------------------------------------- 折缝 / folds
def folds_step(V, F, lod, fb, L, A, log, apply=True):
    import fold_r2 as FR
    SC = FR.sheet_coordinate(lod)
    rep, V1 = {}, V.copy()
    jobs = [('axilla' + s, SC['arm' + s], FR.axilla_sides(fb, L, V, s)[:3]) for s in 'LR'] + [('thighs', SC['legs'], FR.thigh_sides(fb, L, V))]
    # 只处理朝着另一侧深部结构的皮肤（见 fold_r2.facing_weight）/ only skin that faces the deep parts of the other side is treated (see fold_r2.facing_weight)
    jobs = [(tag, sc, (Ma, Mb, w * FR.facing_weight(V, F, A, Ma, Mb, sc))) for tag, sc, (Ma, Mb, w) in jobs]
    for tag, sc, (Ma, Mb, w) in jobs:
        rep[tag] = {'before': FR.metrics(V, F, sc, Ma, Mb, w)}
        if apply:
            V1, rep[tag]['moved'] = FR.part(V1, F, sc, Ma, Mb, w, A, log, tag)
    if apply:
        for tag, sc, (Ma, Mb, w) in jobs:
            rep[tag]['after'] = FR.metrics(V1, F, sc, Ma, Mb, w)
            log.append(f'  fold {tag}: before {json.dumps(rep[tag]["before"])}')
            log.append(f'  fold {tag}: after  {json.dumps(rep[tag]["after"])}')
    return V1, rep, SC


def abduct(V, sc_arm, c, deg, sign):
    """用包里的蒙皮权重把一侧上肢绕肩关节外展 deg 度（绕前后轴；单关节的线性混合蒙皮）。
    Abduct one upper limb by deg degrees about the shoulder joint with the package's skin weights (about the antero-posterior axis; linear blend skinning of a single joint)."""
    a = np.radians(deg) * sign
    R = np.array([[np.cos(a), -np.sin(a), 0], [np.sin(a), np.cos(a), 0], [0, 0, 1]])
    wa = np.clip((sc_arm + 1) / 2, 0, 1)
    return V + wa[:, None] * ((V - c) @ R.T + c - V)


def abduction_check(Vold, Vnew, F, SC, L, rest_deg, out, log):
    """后腋襞在外展 90° 时的拉伸：区域内各边的长度比（摆姿后 / 静止）。before = 原包，after = 新包。
    Stretch of the posterior axillary fold at 90 degrees of abduction: ratio posed / rest of the edge lengths in the region. before = source package, after = new."""
    rep = {}
    E = np.unique(np.sort(np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1), axis=0)
    for S, sg in (('L', 1), ('R', -1)):
        c = L['shoulder_' + S]
        rep[S] = {}
        for tag, V in (('before', Vold), ('after', Vnew)):
            Vp = abduct(V, SC['arm' + S], c, 90 - rest_deg, sg)
            m = (np.linalg.norm(V[E[:, 0]] - c, axis=1) < 0.11) & (V[E[:, 0], 2] < c[2]) & (V[E[:, 0], 1] < c[1] + 0.02)
            r = np.linalg.norm(Vp[E[m, 0]] - Vp[E[m, 1]], axis=1) / np.maximum(np.linalg.norm(V[E[m, 0]] - V[E[m, 1]], axis=1), 1e-9)
            rep[S][tag] = {'edges': int(m.sum()), 'stretchP5': round(float(np.percentile(r, 5)), 2), 'stretchMedian': round(float(np.median(r)), 2), 'stretchP95': round(float(np.percentile(r, 95)), 2),
                           'stretchMax': round(float(r.max()), 2), 'shareCompressedBelow0.5': round(float((r < 0.5).mean()), 3)}
            if S == 'L':
                lo, hi = [c[0] - 0.10, c[1] - 0.24, -1.0], [c[0] + 0.26, c[1] + 0.10, 1.0]
                render_closeup([(Vp, F, SKIN)], os.path.join(out, f'r2-abduction90-L-{tag}.png'), lo, hi, views=('back', 'front'), height=700)
    log.append('  90 degrees of abduction, posterior fold, edge stretch: ' + json.dumps(rep))
    return rep


def axilla_renders(Vold, Vnew, F, L, out):
    from PIL import Image
    for S in 'LR':
        c = L['shoulder_' + S]
        lo, hi = [c[0] - 0.13, c[1] - 0.26, -1.0], [c[0] + 0.13, c[1] + 0.06, 1.0]
        ims = []
        for tag, V in (('before', Vold), ('after', Vnew)):
            p = os.path.join(out, f'_tmp-{tag}.png')
            render_closeup([(V, F, SKIN)], p, lo, hi, views=('front', 'back'), height=800)
            ims.append(Image.open(p).convert('RGB'))
            os.remove(p)
        W = Image.new('RGB', (sum(i.width for i in ims), ims[0].height), 'white')
        x = 0
        for i in ims:
            W.paste(i, (x, 0))
            x += i.width
        W.save(os.path.join(out, f'r2-axilla-{S}-front-back_before-after.png'))


def head_renders(layers_by_name, body_of, out_png):
    """并排：每个头的正面、四分之三侧面、侧面，带眉毛部件和眼球 / side by side: front, three-quarter and profile of each head, with the eyebrow part and the globes"""
    from PIL import Image
    rows = []
    for name, (V, F) in layers_by_name.items():
        fb = Body(body_of[name])
        eye = 0.5 * (fb.verts('Left vitreous body').mean(0) + fb.verts('Right vitreous body').mean(0))
        top = V[:, 1].max()
        layers = [(V, F, SKIN)]
        p = fb.find('Eyebrow')[0]
        v, f = fb.mesh(p)
        layers.append((v, f, (0.25, 0.18, 0.12)))
        for p in fb.parts:
            nm = p['name'].lower()
            if 'sclera' in nm or 'cornea' in nm:
                v, f = fb.mesh(p)
                layers.append((v, f, (0.95, 0.95, 0.95) if 'sclera' in nm else (0.2, 0.2, 0.3)))
        c0 = np.array([eye[0], 0, eye[2] - 0.08])
        ims = []
        for ang in (0, -35, -90):
            a = np.radians(ang)
            R = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
            Lr = [((v - c0) @ R.T + c0, f[(v[:, 1] > top - 0.30)[f].all(1)], c) for v, f, c in layers]
            tmp = out_png + '.tmp.png'
            render_closeup(Lr, tmp, [eye[0] - 0.14, top - 0.27, -1], [eye[0] + 0.14, top + 0.01, 1], views=('front',), height=1000, title=name if ang == 0 else None)
            ims.append(Image.open(tmp).convert('RGB'))
            os.remove(tmp)
        W = Image.new('RGB', (sum(i.width for i in ims), max(i.height for i in ims)), 'white')
        x = 0
        for i in ims:
            W.paste(i, (x, 0))
            x += i.width
        rows.append(W)
    W = Image.new('RGB', (max(r.width for r in rows), sum(r.height for r in rows)), 'white')
    y = 0
    for r in rows:
        W.paste(r, (0, y))
        y += r.height
    W.save(out_png)


def load_obj(p):
    V, F = [], []
    for ln in open(p):
        if ln.startswith('v '):
            V.append(ln.split()[1:4])
        elif ln.startswith('f '):
            F.append([int(t.split('/')[0]) - 1 for t in ln.split()[1:4]])
    return np.array(V, float), np.array(F, int)


def main():
    name = sys.argv[1]
    out = os.path.join(RAW, 'out', arg('--out', f'{name}-skin-r2'))
    if '--restamp' in sys.argv:
        mf = os.path.join(out, 'manifest.json')
        m = json.load(open(mf))
        m['fittedTo']['key'] = arg('--restamp')
        json.dump(m, open(mf, 'w'), ensure_ascii=False, indent=1)
        print('fittedTo.key ->', m['fittedTo']['key'])
        return
    src = os.path.join(RAW, 'out', arg('--src', f'{name}-skin'))
    assert os.path.abspath(src) != os.path.abspath(out), 'the output directory must differ from the source package'
    assert os.path.basename(out) not in (f'{name}-skin', f'{name}-skin-grafted', f'{name}-skin-open'), 'refusing to write into a shipped package directory'
    sex = 'F' if name == 'female' else 'M'
    steps = arg('--steps', 'face,folds,perineum' if sex == 'F' else 'folds,perineum').split(',')
    report = json.load(open(os.path.join('public/anatomy', name, 'pipeline-report.json')))
    man = json.load(open(os.path.join(src, 'manifest.json')))
    key = arg('--key', man['fittedTo']['key'])
    st = np.load(os.path.join(src, 'fit-state-final.npz'))
    ident, mp, lod = st['identity'], st['mp'], int(st['lod'])
    Vm = mhrlib.run(ident, mp, lod, True)[0]
    F = mhrlib.faces(lod)
    V0 = Vm + st['offsets']
    Vobj = load_obj(os.path.join(src, 'skin.obj'))[0]
    assert np.abs(Vobj - V0).max() < 2e-5, 'skin.obj and fit-state-final.npz of the source package disagree'
    V0 = Vobj
    fb = Body(name)
    L = bone_landmarks(fb)
    A = ES.adjacency(len(V0), F)
    log = [f'{name}: re-issue r2 of {os.path.basename(src)} -> {os.path.basename(out)}; steps {steps}; fittedTo.key {key}; pipeline internalsKey now {report["skinPackage"]["internalsKey"]}']
    os.makedirs(out, exist_ok=True)
    rep = {'body': name, 'source': os.path.basename(src), 'steps': steps, 'fittedToKey': key}
    V = V0.copy()
    face = None
    if 'face' in steps and sex == 'F':
        import face_female as FFACE
        import face_r2 as R2
        import final_female as FF
        wh0 = FF.head_weight(lod)
        lm0 = R2.apply_table(R2.fix_landmarks(FFACE.landmarks(fb), fb), R2.depth_table())
        m_before, c_before = face_measures(V0, F, lm0, wh0, lod, A, fb)
        hm_before = head_muscles_outside(fb, V0, F, FF.head_blend(lod, A, V0, fb))
        V, face = face_step(V0, F, ident, mp, lod, fb, L, A, log, float(arg('--strength', '2.0')))
        m_after, c_after = face_measures(V, F, face['lm'], face['wh'], lod, A, fb)
        b = lambda k: face['lm'][k]['bone']
        bone = {'bizygomaticWidth': abs(b('zygion_L')[0] - b('zygion_R')[0]) * 1000, 'bigonialWidth': abs(b('gonion_L')[0] - b('gonion_R')[0]) * 1000,
                'midRamusWidth': abs(b('midRamus_L')[0] - b('midRamus_R')[0]) * 1000, 'totalFaceHeight_nasionToMenton': (b('nasion')[1] - b('menton')[1]) * 1000}
        bone['bigonialOverBizygomatic'] = bone['bigonialWidth'] / bone['bizygomaticWidth']
        ap = np.vstack([fb.verts('Left maxilla'), fb.verts('Right maxilla')])
        rep['face'] = {'bone': {k: round(float(v), 3 if 'Over' in k else 1) for k, v in bone.items()}, 'measuresBefore': m_before, 'measuresAfter': m_after,
                       'coverAtLandmarksMm': {k: {'tableMean': face['table'].get(k.split('_')[0], {}).get('mean'), 'tableLow': face['table'].get(k.split('_')[0], {}).get('low'),
                                                  'target': face['lm'][k]['depthMm'], 'before': c_before[k], 'after': c_after[k]} for k in c_after},
                       'eyes': face['eyes'], 'headPartsOutsideBefore': hm_before}
        log.append('  face measures (mm): bone / before / after')
        for k in m_after:
            log.append(f'     {k:58s} {str(rep["face"]["bone"].get(k, "")):>8s} {str(m_before.get(k, "")):>8s} {str(m_after[k]):>8s}')
        log.append('  cover at the landmarks (mm): table mean / table low (mean - SD) / target / before / after')
        for k, v in rep['face']['coverAtLandmarksMm'].items():
            flag = '' if v['tableLow'] is None or v['after'] >= v['tableLow'] - 0.05 else '   << under the lower bound'
            log.append(f'     {k:24s} {str(v["tableMean"]):>6s} {str(v["tableLow"]):>6s} {v["target"]:6.1f} {v["before"]:6.1f} {v["after"]:6.1f}{flag}')
    if 'perineum' in steps and sex == 'F':
        # 会阴在折缝之前做：抬高会阴会带动大腿根，两大腿之间的折缝随后再分 / the perineum comes before the folds: raising it carries the root of the thighs along, and the fold between the thighs is parted afterwards
        rimf = arg('--vulva-rim', os.path.join(RAW, 'out', 'female-skin-grafted-next', 'vulva-rim-target.json'))
        rim = json.load(open(rimf)) if os.path.exists(rimf) else None
        if rim and 'kind' in rim.get('rimLoop', {}):
            V, rep['perineum'] = vulva_rim_step(V, F, rim, A, log)
            rep['perineum']['file'] = {'name': os.path.basename(rimf), 'modified': __import__('time').strftime('%Y-%m-%d %H:%M', __import__('time').localtime(os.path.getmtime(rimf)))}
        else:
            rep['perineum'] = {'done': False, 'why': 'no vulva-rim-target.json with rimLoop.kind was found; the perineum of the source package is kept as it is'}
            log.append('  perineum (female): ' + rep['perineum']['why'])
    folds = None
    if 'folds' in steps:
        V_pre = V.copy()
        V, folds, SC = folds_step(V, F, lod, fb, L, A, log)
        rep['folds'] = folds
        rest = {'male': 6.5, 'female': 7.5}[name]
        rep['abduction90'] = abduction_check(V_pre, V, F, SC, L, rest, out, log)
        axilla_renders(V_pre, V, F, L, out)
    if 'perineum' in steps:
        if sex == 'M':
            V, rep['perineum'] = perineum_step(V, F, fb, L, A, log)

    # ---- 复核：包住、体格、封闭性 / checks: enclosure, anthropometry, closedness
    Pd, grp, pid, parts = ES.deep_samples(fb)
    reg = classify(Pd, L)
    c0, s0 = ES.containment(Pd, grp, reg, V0, F)
    c1, s1 = ES.containment(Pd, grp, reg, V, F)
    log.append('\n== containment of the deep parts: BEFORE (source package)\n' + ES.fmt_cont(c0) + '\n== AFTER (r2)\n' + ES.fmt_cont(c1))
    worse = []
    for k, p in enumerate(parts):
        m = pid == k
        if m.sum() >= 5 and s1[m].max() > 0 and (s1[m].max() > s0[m].max() + 0.2 or s0[m].max() <= 0):
            worse.append({'id': p['id'], 'name': p['name'], 'tissue': p['tissue'], 'maxBeforeMm': round(float(s0[m].max()), 1), 'maxAfterMm': round(float(s1[m].max()), 1), 'shareOutsideAfter': round(float((s1[m] > 0).mean()), 4)})
    worse.sort(key=lambda w: -w['maxAfterMm'])
    log.append(f'parts further outside the skin than before: {len(worse)}' + ''.join(f'\n   {w["name"]} [{w["tissue"]}]: {w["maxBeforeMm"]} -> {w["maxAfterMm"]} mm, {100 * w["shareOutsideAfter"]:.2f} %' for w in worse[:30]))
    jn = mhrlib.joint_names(lod)
    P = mhrlib.run(ident, mp, lod, True)[1]
    J = {f'{a}_{Sd}': P[jn.index(f'{s}_{m}')] for Sd, s in (('L', 'l'), ('R', 'r')) for a, m in (('shoulder', 'uparm'), ('elbow', 'lowarm'), ('wrist', 'wrist'), ('hip', 'upleg'), ('knee', 'lowleg'), ('ankle', 'foot'))}
    ilio = 0.5 * (L['iliocristale_L'][1] + L['iliocristale_R'][1]) - L['floor'][1]
    g0, g1 = surface_measures(V0, F, J, levels={'iliocristale': ilio}), surface_measures(V, F, J, levels={'iliocristale': ilio})
    rep['anthropometry'] = {k: {'before': round(float(g0[k]), 2), 'after': round(float(g1[k]), 2)} for k in GIRTHS if k in g1}
    log.append('\nmeasure                 before   after')
    for k, v in rep['anthropometry'].items():
        log.append(f'  {k:22s} {v["before"]:8.2f} {v["after"]:8.2f}')
    bmi = lambda W: mesh_volume(W, F) * 1010.0 / np.ptp(W[:, 1]) ** 2
    rep['statureM'] = {'before': round(float(np.ptp(V0[:, 1])), 4), 'after': round(float(np.ptp(V[:, 1])), 4)}
    rep['bmiByVolume'] = {'before': round(float(bmi(V0)), 2), 'after': round(float(bmi(V)), 2)}
    rep['closed'] = ES.is_closed(F)
    rep['containment'] = {'before': c0, 'after': c1, 'partsFurtherOutside': worse}
    mv = np.linalg.norm(V - V0, axis=1) * 1000
    rep['movedMm'] = {'vertices': int((mv > 0.05).sum()), 'median': round(float(np.median(mv[mv > 0.05])), 2) if (mv > 0.05).any() else 0, 'max': round(float(mv.max()), 1)}
    log.append(f'stature {rep["statureM"]}, BMI by volume {rep["bmiByVolume"]}, closed {rep["closed"]}, vertices moved {rep["movedMm"]}')

    # ---- 写包：先照抄原包里不是图片的文件，再改写与位置有关的 / write the package: copy everything of the source that is not a picture, then rewrite what depends on positions
    for f in os.listdir(src):
        p = os.path.join(src, f)
        if os.path.isfile(p) and not f.endswith('.png') and not f.endswith('.unused.json'):
            shutil.copy(p, os.path.join(out, f))
    write_obj(os.path.join(out, 'skin.obj'), V, F, f'{name} skin r2, MHR LOD{lod} topology (Apache-2.0); metres, Y up, +Z anterior, +X left')
    (V - Vm).astype(np.float32).tofile(os.path.join(out, 'residual-offsets.f32'))
    (mhrlib.run(ident, mp, lod, False)[0] + (V - Vm)).astype(np.float32).tofile(os.path.join(out, 'skin-no-pose-correctives.f32'))
    eo = np.fromfile(os.path.join(src, 'enclosure-offsets.f32'), dtype=np.float32).reshape(-1, 3)
    (eo + (V - V0)).astype(np.float32).tofile(os.path.join(out, 'enclosure-offsets.f32'))
    np.savez(os.path.join(out, 'fit-state-final.npz'), identity=ident, mp=mp, offsets=V - Vm, lod=lod)
    man['fittedTo'] = {'body': name, 'key': key}
    man['statureM'] = rep['statureM']['after']
    man['bmiByVolume'] = rep['bmiByVolume']['after']
    man['what'] = {'zh': man['what']['zh'] + '；r2：' + ('头按她的颅骨重做，' if face else '') + '腋窝和两大腿之间的两片皮肤按中面分开' + ('，睾丸后方的会阴面贴到扫描皮肤上' if sex == 'M' and 'perineum' in steps else ''),
                   'en': man['what']['en'] + '; r2: ' + ('head rebuilt on her skull, ' if face else '') + 'the facing sheets of the axillae and between the thighs parted at the mid-surface' + (', the perineal surface behind the testes laid onto the scanned skin' if sex == 'M' and 'perineum' in steps else '')}
    man['r2'] = {'source': os.path.basename(src), 'steps': steps, 'report': 'r2-report.json, r2-report.txt',
                 'folds': {'minimumGapMm': 1.5, 'method': 'mid-surface between the deep parts of the two sides (fold_r2.py)'}}
    if face:
        import face_r2 as R2
        hm = head_muscles_outside(fb, V, F, face['hbw'])
        rep['face']['headPartsOutsideAfter'] = hm
        man['face']['notEnclosedMuscles'] = hm
        ids = set(man['face']['notEnclosed'].get('partIds', [])) - {r['id'] for r in rep['face']['headPartsOutsideBefore']}
        man['face']['notEnclosed']['partIds'] = sorted(ids | {r['id'] for r in hm})
        man['face']['r2'] = {'method': 'clean MHR head + MakeHuman female-minus-neutral shape difference (strength %s), one smooth space warp onto her skull; see face_r2.py' % arg('--strength', '2.0'),
                             'sources': {'midline': [R2.SRC_PARK, R2.SRC_SONITA], 'bilateral': R2.SRC_TT, 'dimorphism': 'MakeHuman / MPFB2 gender targets through Anny (assets CC0, code Apache-2.0); artist-made'}}
        log.append(f'  head: {len(hm)} deep parts of the head partly outside the skin (before: {len(rep["face"]["headPartsOutsideBefore"])}):' + ''.join(f'\n     {r["maxOutsideMm"]:5.1f} mm {100 * r["shareOutside"]:5.1f} %  {r["name"]} [{r["tissue"]}]' for r in hm))
        tdir = os.path.join(RAW, 'out', arg('--face-target', 'female-face-target-r2'))
        env, rows, lips = write_face_target(tdir, V, F, fb, report['skinPackage'].get('internalsKeyBeforeShape', key), face, rep['face']['measuresAfter'], {k: v['after'] for k, v in rep['face']['coverAtLandmarksMm'].items()}, log, src)
        rep['faceTarget'] = {'dir': os.path.basename(tdir), 'envelope': env, 'conflicts': len(rows), 'lipParts': lips}
        old = load_obj(os.path.join(RAW, 'out', 'male-skin', 'skin.obj'))
        head_renders({'female, source package': (V0, F), 'female, r2': (V, F), 'male (for comparison)': old}, {'female, source package': 'female', 'female, r2': 'female', 'male (for comparison)': 'male'},
                     os.path.join(out, 'r2-heads_old-new-male.png'))
    json.dump(man, open(os.path.join(out, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
    json.dump(rep, open(os.path.join(out, 'r2-report.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(out, 'r2-report.txt'), 'w').write('\n'.join(log) + '\n')
    print('\n'.join(log))


if __name__ == '__main__':
    main()
