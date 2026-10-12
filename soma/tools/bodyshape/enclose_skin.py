"""在参数拟合之后：把皮肤局部外推到包住全部深部结构，统计前后对比，并写出管线可装入的皮肤包。
After the parametric fit: push the skin out locally until it encloses every deep part, report
before/after, and write the skin package the pipeline installs.

    python tools/bodyshape/enclose_skin.py male   [--bmi 23.6]
    python tools/bodyshape/enclose_skin.py female
    <- data/raw/bodyshape/out/<body>-skin/fit-state.npz   (fit_skin.py)
    -> data/raw/bodyshape/out/<body>-skin/  manifest.json（含 fittedTo）、skin.obj、weights.bin、joints.json、
       residual-offsets.f32、enclosure.json/.txt、预览与特写图 / previews and close-ups

包格式见 tools/pipeline/skinPackage.ts：manifest.source{name,url,license,attribution}、
manifest.fittedTo{body,key}、skin.obj（单层封闭，米，Y 向上，+Z 向前，+X 为身体左侧）。
fittedTo.key 取自 public/anatomy/<body>/pipeline-report.json 的 skinPackage.internalsKey
（该指纹由管线按未量化的骨网格计算，这里无法从 anatomy.json 复算，所以照抄并检查导出文件不是旧的）。
Package format: see tools/pipeline/skinPackage.ts. fittedTo.key is copied from
skinPackage.internalsKey in public/anatomy/<body>/pipeline-report.json (the pipeline computes that
fingerprint on unquantised bone meshes; it cannot be recomputed from anatomy.json here, so it is
copied and the export is checked not to be stale).

“深部结构”与管线一致：组织类型为 muscle/bone/cartilage/organ/brain/heart/gland/tendon/tooth 且不属皮肤系统。
Deep parts as in the pipeline: tissue muscle/bone/cartilage/organ/brain/heart/gland/tendon/tooth, integumentary system excluded.
"""
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mhrlib  # noqa: E402
from bodylib import RAW, Body, render_bottom, render_closeup, render_overlay, render_views, sample_surface  # noqa: E402
from fit_check import REGIONS, classify, signed_distance  # noqa: E402
import axilla  # noqa: E402
from fit_skin import joint_mapping, self_gap, stale_guard, vertex_normals, write_obj  # noqa: E402
from measure import bone_landmarks, mesh_volume, surface_measures  # noqa: E402

MARGIN = 0.0025   # 深部结构至少在皮肤下 2.5 mm / deep parts end at least 2.5 mm under the skin
GROUPS = {'muscle': ('muscle', 'tendon'), 'bone': ('bone', 'cartilage', 'tooth'), 'organ': ('organ', 'brain', 'heart', 'gland')}


# 眼裂、口裂处保留 MHR 自己的眼睑和唇面：这些部件不进“必须包住”的集合（否则眼睑、唇会被顶到眼球、牙齿外面，成一个棱角分明的包）。
# At the palpebral and oral fissures MHR's own lids and lips are kept: these parts are left out of the set that must be
# enclosed (otherwise lids and lips are pushed out over the globe and the teeth into a faceted lump).
FACE_EXCLUDE = ('eyeball', 'cornea', 'sclera', 'lens', 'vitreous', 'anterior chamber', 'posterior chamber', 'iris', 'retina', 'choroid', 'ciliary', 'conjunctiva',
                'lacrimal', 'tarsal', 'tarsus', 'eyelash', 'eyebrow', 'eyelid', 'lip', 'tongue', 'gingiva', 'lingual',
                'nasal cartilage', 'alar cartilage')   # 鼻软骨：皮肤用 MHR 自己的鼻子，软骨可以露出 / nasal cartilages: the skin keeps MHR's own nose and the cartilages may show


def excluded_face_parts(fb):
    """不参与包住的面部部件的 id。眼轮匝肌的两个环按几何选：每侧离眼球中心近的那个（睑缘处的内环）排除，外环保留
    （数据里两个环的名字是互换的，所以不按名字选）。
    Ids of the facial parts left out of the enclosure. The two rings of orbicularis oculi are chosen by geometry: on each
    side the one nearer the centre of the eyeball (the inner ring at the lid margins) is left out and the outer ring
    stays (their names are swapped in the data, so names are not used)."""
    out = set()
    for p in fb.deep_parts():
        n = p['name'].lower()
        if p['tissue'] == 'tooth' or any(t in n.replace('lipid', '') for t in FACE_EXCLUDE):
            if 'levator labii' in n or 'depressor labii' in n or 'elliptical' in n:
                continue
            out.add(p['id'])
    for side in ('Left', 'Right'):
        try:
            c = fb.verts(f'{side} vitreous body').mean(0)
        except Exception:
            continue
        rings = [p for p in fb.deep_parts() if 'orbicularis oculi' in p['name'].lower() and side.lower() in p['name'].lower()]
        if len(rings) >= 2:
            rings.sort(key=lambda p: float(np.linalg.norm(fb.mesh(p)[0] - c, axis=1).mean()))
            out.add(rings[0]['id'])
    return out


_PROTECT = {}
FACE_PROTECT_ON = True   # 骨的最后一遍会临时关掉 / switched off for the last pass over bone


def face_protect(lod):
    """眼区、口区的保护权重（0–1）和两个区域的顶点下标，在 MHR 的中性网格上定义，与姿势无关。
    眼区：眼关节 22 mm 以内、在其前方的皮肤（眼睑）；口区：唇（口裂上下各约 12 mm、正中两侧各 30 mm）。
    Protection weight (0-1) for the orbital and oral regions and the vertex indices of both, defined on MHR's neutral mesh
    and so independent of pose. Orbital: skin within 22 mm of an eye joint and in front of it (the lids); oral: the lips
    (about 12 mm above and below the oral fissure, 30 mm either side of the midline)."""
    if lod not in _PROTECT:
        V, P, _ = mhrlib.run(np.zeros(45), np.zeros(204), lod, True)
        jn = mhrlib.joint_names(lod)
        F = mhrlib.faces(lod)
        reg = {}
        for S, j in (('L', 'l_eye'), ('R', 'r_eye')):
            e = P[jn.index(j)]
            reg['lids' + S] = np.where((np.linalg.norm(V - e, axis=1) < 0.022) & (V[:, 2] > e[2]))[0]
        e = 0.5 * (P[jn.index('l_eye')] + P[jn.index('r_eye')])
        reg['lips'] = np.where((np.abs(V[:, 0]) < 0.030) & (V[:, 1] < e[1] - 0.057) & (V[:, 1] > e[1] - 0.081) & (V[:, 2] > e[2] + 0.012))[0]
        # 鼻：鼻背到鼻尖、鼻翼、鼻孔缘 / nose: dorsum to tip, alae and nostril rims
        reg['nose'] = np.where((np.abs(V[:, 0]) < 0.021) & (V[:, 1] < e[1] - 0.028) & (V[:, 1] > e[1] - 0.056) & (V[:, 2] > e[2] + 0.026))[0]   # 只含软骨部：鼻骨上的皮肤仍要盖住鼻骨 / the cartilaginous part only: skin over the nasal bones must still cover them
        w = np.zeros(len(V))
        for idx in reg.values():
            w[idx] = 1.0
        A = adjacency(len(V), F)
        core = w >= 1
        for _ in range(6):   # 向外扩六圈 / grow six rings outwards
            w = np.maximum(w, (A @ w > 0).astype(float))
        for _ in range(14):   # 再抹平成缓坡；核心区保持 1 / then smooth into a ramp; the core stays 1
            w = 0.5 * w + 0.5 * (A @ w)
            w[core] = 1.0
        _PROTECT[lod] = (np.clip(w, 0, 1), reg)
    return _PROTECT[lod]


def deep_samples(fb):
    """深部结构的表面采样点（顶点 + 约每 30 mm2 一个面内点），带组别和部件下标。
    Surface samples of the deep parts (vertices plus about one point per 30 mm2), with group and part index."""
    rng = np.random.default_rng(5)
    pts, grp, pid = [], [], []
    skip = excluded_face_parts(fb)
    parts = [p for p in fb.deep_parts() if p['id'] not in skip]
    for k, p in enumerate(parts):
        v, f = fb.mesh(p)
        g = next(i for i, (_, ts) in enumerate(GROUPS.items()) if p['tissue'] in ts)
        area = np.linalg.norm(np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]]), axis=1).sum() / 2
        n = int(area / 30e-6)
        q = [v]
        if n > 0 and len(f):
            q.append(sample_surface(v, f, n, rng)[0])
        q = np.vstack(q)
        pts.append(q)
        grp.append(np.full(len(q), g))
        pid.append(np.full(len(q), k))
    return np.vstack(pts), np.concatenate(grp), np.concatenate(pid), parts


def adjacency(n, F):
    from scipy import sparse
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    A = sparse.coo_matrix((np.ones(len(e) * 2), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    A.data[:] = 1.0
    return sparse.diags(1.0 / np.maximum(np.asarray(A.sum(1)).ravel(), 1)) @ A


def exposed(V, F):
    """露在外面的顶点：沿法线外移 1.5 mm 后在网格之外。腋窝、指缝、两腿之间，皮肤会自相重叠，
    埋在里面的那部分不算体表。
    Exposed vertices: those that are outside the mesh after moving 1.5 mm along the normal. At the
    axilla, between fingers and between the thighs the skin overlaps itself; the buried part is not body surface."""
    import igl
    w = igl.fast_winding_number(np.ascontiguousarray(V), np.ascontiguousarray(F), np.ascontiguousarray(V + 0.0015 * vertex_normals(V, F)))
    return w < 0.5


def enclose(V0, F, P, log, cap, passes=10, step_cap=0.012):
    """把皮肤沿“初始的、平滑过的法线”外推，直到采样点 P 都在皮肤下 MARGIN 以内。
    方向固定不变；每个顶点的总位移不超过 cap[i]；距离只对露在外面的皮肤量、位移也只加在它上面
    （否则在皮肤自相重叠处，埋在里面的那层会被越推越深，永不收敛）。
    Push the skin out along its initial, smoothed normals until every sample in P lies at least MARGIN
    under it. The direction is fixed; the total displacement of vertex i never exceeds cap[i];
    distances are measured to, and displacement applied on, the exposed skin only (where the skin
    overlaps itself the buried sheet would otherwise be pushed ever deeper and never converge)."""
    import igl
    A = adjacency(len(V0), F)
    n0 = vertex_normals(V0, F)
    for _ in range(3):
        n0 = 0.5 * n0 + 0.5 * (A @ n0)
        n0 /= np.maximum(np.linalg.norm(n0, axis=1), 1e-12)[:, None]
    # 眼睑和唇不外推 / lids and lips are not pushed
    lodp = next((k for k, n in mhrlib.LOD_VERTICES.items() if n == len(V0)), None)
    if lodp is not None and FACE_PROTECT_ON:
        cap = np.asarray(cap, float) * (1.0 - face_protect(lodp)[0])
    D = np.zeros(len(V0))
    best = None
    ex = exposed(V0, F)
    Fe = F[ex[F].all(1)]
    log.append(f'  exposed skin: {ex.mean() * 100:.1f} % of vertices ({(~ex).sum()} buried where the skin overlaps itself)')
    w = igl.fast_winding_number(np.ascontiguousarray(V0), np.ascontiguousarray(F), np.ascontiguousarray(P))
    d = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(P), np.ascontiguousarray(V0), np.ascontiguousarray(Fe))[0])
    cand = np.where((w < 0.5) | (d < 0.03))[0]   # 更深的点不会因皮肤外移而露出 / deeper points cannot surface when the skin only moves out
    Pc = np.ascontiguousarray(P[cand])
    for it in range(passes):
        V = np.ascontiguousarray(V0 + D[:, None] * n0)
        w = igl.fast_winding_number(V, np.ascontiguousarray(F), Pc)
        d2, fi, _ = igl.point_mesh_squared_distance(Pc, V, np.ascontiguousarray(Fe))[:3]
        s = np.where(w > 0.5, -1.0, 1.0) * np.sqrt(d2)
        off = s > -MARGIN
        log.append(f'  enclose pass {it}: {off.sum()} samples within {MARGIN * 1000:.1f} mm of or outside the skin; {(s > 0).sum()} outside, furthest {max(s.max(), 0) * 1000:.1f} mm')
        # 记住“在外采样点最少”的那一轮：个别自相重叠处会越推越远，出现这种情况就退回并停止
        # remember the pass with the fewest samples outside: at a few self-overlapping spots the push can run away; when it does, fall back and stop
        score = (int((s > 0).sum()), float(max(s.max(), 0)))
        if best is None or score < best[0]:
            best = (score, D.copy())
        elif it >= 3 and score[1] > best[0][1] + 0.002:
            log.append(f'  enclose: pass {it} is worse than the best pass; falling back to it')
            D = best[1]
            break
        if off.sum() == 0:
            break
        need = np.minimum(s[off] + MARGIN + 0.0005, step_cap)
        req = np.zeros(len(V))
        for k in range(3):
            np.maximum.at(req, Fe[fi[off], k], need)
        for _ in range(4):
            req = np.maximum(req, 0.75 * (A @ req))
        req[~ex] = 0
        D = np.minimum(D + req, cap)
    # 位移场的轻度平滑：只增不减，保持包裹 / light smoothing of the displacement that never decreases it, so enclosure is kept
    for _ in range(6):
        Dn = np.minimum(np.maximum(D, A @ D), cap)
        D = np.where(ex, Dn, D)
    # 再把位移场本身磨平一些（取平滑值与原值的较大者之上的平均），减轻肌肉轮廓印在皮肤上的凹凸
    # then soften the field itself (average of the field and its smoothed version, never below the field), so muscle outlines print through less
    for _ in range(4):
        Dn = np.minimum(np.maximum(D, 0.5 * D + 0.5 * (A @ (A @ D))), cap)
        D = np.where(ex, Dn, D)
    return V0 + D[:, None] * n0


def vertex_area(V, F):
    a = np.linalg.norm(np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]), axis=1) / 6.0
    out = np.zeros(len(V))
    for k in range(3):
        np.add.at(out, F[:, k], a)
    return out


def facing_area(V, F, reg, radius=0.0015):
    """皮肤自相贴近的面积（cm2），按区域和左右：某顶点 1.5 mm 内有法线相对的另一层皮肤，或它本身被埋在另一层之内。
    Area (cm2) of skin lying against another sheet of skin, by region and side: a vertex counts when another sheet
    with an opposing normal lies within 1.5 mm, or when the vertex is buried inside another sheet."""
    from scipy.spatial import cKDTree
    n = vertex_normals(V, F)
    tree = cKDTree(V)
    flag = ~exposed(V, F)
    pairs = tree.query_pairs(radius, output_type='ndarray')
    if len(pairs):
        opp = np.einsum('ij,ij->i', n[pairs[:, 0]], n[pairs[:, 1]]) < -0.3
        flag[pairs[opp, 0]] = True
        flag[pairs[opp, 1]] = True
    A = vertex_area(V, F) * 1e4
    out = {}
    for r in np.unique(reg):
        for S, m in (('L', V[:, 0] > 0), ('R', V[:, 0] <= 0)):
            a = float(A[flag & (reg == r) & m].sum())
            if a > 0.05:
                out[f'{r}_{S}'] = round(a, 1)
    return out


def mhr_groups(lod):
    """按蒙皮权重把皮肤顶点分到左臂、右臂、左腿、右腿、躯干（比按到肢段轴线的距离分可靠：腋下的胸壁皮肤离上臂轴线也很近）。
    Skin vertices grouped by skin weights into left arm, right arm, left leg, right leg and trunk (more reliable than
    distance to a limb axis: the chest-wall skin under the axilla is also close to the upper-arm axis)."""
    vi, ji, w, _ = mhrlib.skin_weights(lod)
    jn = mhrlib.joint_names(lod)
    gid = np.zeros(len(jn), int)   # 0 躯干 / trunk
    for i, name in enumerate(jn):
        side = name[0] if name[1] == '_' else None
        base = name[2:] if side else name
        if side and any(base.startswith(t) for t in ('uparm', 'lowarm', 'wrist', 'thumb', 'index', 'middle', 'ring', 'pinky')):
            gid[i] = 1 if side == 'l' else 2
        elif side and any(base.startswith(t) for t in ('upleg', 'lowleg', 'foot', 'talocrural', 'subtalar', 'transversetarsal', 'ball')):
            gid[i] = 3 if side == 'l' else 4
    acc = np.zeros((int(vi.max()) + 1, 5))
    np.add.at(acc, (vi, gid[ji]), w)
    return acc.argmax(1)


def containment(P, grp, reg, V, F):
    s = signed_distance(P, V, F) * 1000
    out = {}
    for gi, g in enumerate(GROUPS):
        out[g] = {}
        for rid, zh, en in REGIONS + [('all', '全身', 'Whole body')]:
            m = (grp == gi) & ((reg == rid) if rid != 'all' else True)
            if m.sum() < 30:
                continue
            x = s[m]
            out[g][rid] = {'n': int(m.sum()), 'outside': round(float((x > 0).mean()), 4), 'outside5mm': round(float((x > 5).mean()), 4),
                           'p99': round(float(np.percentile(x, 99)), 1), 'max': round(float(x.max()), 1)}
    return out, s


def fat_room(V, F, DV, DF, L):
    """皮肤顶点到最近深部结构表面的距离（毫米）分区域的分布。
    Distribution by region of the distance (mm) from skin vertices to the nearest deep surface."""
    import igl
    d = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(V), np.ascontiguousarray(DV), np.ascontiguousarray(DF))[0]) * 1000
    reg = classify(V, L)
    out = {}
    for rid, zh, en in REGIONS:
        x = d[reg == rid]
        if len(x) > 20:
            out[rid] = {'p10': round(float(np.percentile(x, 10)), 1), 'p50': round(float(np.percentile(x, 50)), 1), 'p90': round(float(np.percentile(x, 90)), 1),
                        'under2mm': round(float((x < 2).mean()), 3)}
    return out


def is_closed(F):
    e = np.sort(np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]), axis=1)
    _, c = np.unique(e, axis=0, return_counts=True)
    return bool((c == 2).all())


def fmt_cont(c):
    lines = [f'{"region":10s} ' + ' | '.join(f'{g:>6s} out% >5mm%  p99   max' for g in GROUPS)]
    for rid, _, _ in REGIONS + [('all', '', '')]:
        s = f'{rid:10s} '
        for g in GROUPS:
            r = c[g].get(rid)
            s += (f'{100 * r["outside"]:10.1f} {100 * r["outside5mm"]:5.1f} {r["p99"]:5.1f} {r["max"]:5.1f} | ' if r else ' ' * 30 + '| ')
        lines.append(s)
    return '\n'.join(lines)


def breast_scaling(fb, V, F, log):
    """HRA 乳腺部件绕胸壁附着点等比缩放多少，才能落在这张皮肤的乳房之内（留 3 mm 覆盖）。
    How much the HRA mammary parts must be scaled uniformly about their chest-wall attachment to lie
    inside this skin's breast with 3 mm of cover."""
    res = {}
    for S in 'LR':
        parts = [p for p in fb.parts if p['id'].startswith('HRA_') and p['id'].endswith('_' + S)]
        if not parts:
            continue
        inner = np.vstack([fb.mesh(p)[0] for p in parts if p['tissue'] != 'skin'])
        nip = np.vstack([fb.mesh(p)[0] for p in parts if 'nipple' in p['id']])
        fat = np.vstack([fb.mesh(p)[0] for p in parts if p['id'].startswith('HRA_fat')])
        A = fat[fat[:, 2] <= np.percentile(fat[:, 2], 15)].mean(0)
        tip = nip[np.argmax(nip[:, 2])]
        rows = []
        for sc in np.arange(1.0, 0.29, -0.02):
            d = signed_distance(A + sc * (inner - A), V, F) * 1000
            dn = float(signed_distance((A + sc * (tip - A))[None], V, F)[0] * 1000)
            rows.append((round(float(sc), 2), float(np.percentile(d, 99)), float((d > -3).mean()), dn))
        fit = next((r for r in rows if r[1] <= -3.0), rows[-1])
        onskin = min(rows, key=lambda r: abs(r[3]))
        d1 = signed_distance(inner, V, F) * 1000
        res[S] = {'attachmentPoint': [round(float(x), 4) for x in A], 'nippleTipNow': [round(float(x), 4) for x in tip],
                  'unscaled': {'outsideFraction': round(float((d1 > 0).mean()), 3), 'p99Mm': round(float(np.percentile(d1, 99)), 1),
                               'nippleTipOutsideMm': round(rows[0][3], 1)},
                  'scaleForThreeMmCover': {'scale': fit[0], 'p99Mm': round(fit[1], 1), 'nippleTipSignedMm': round(fit[3], 1)},
                  'scaleForNippleOnSkin': {'scale': onskin[0], 'glandP99Mm': round(onskin[1], 1), 'shareWithin3mmOfSkinOrOutside': round(onskin[2], 3)}}
        log.append(f'  breast {S}: attachment {np.round(A, 3).tolist()}; unscaled {100 * (d1 > 0).mean():.0f} % of gland/fat/ligament samples outside, nipple tip {rows[0][3]:+.1f} mm; '
                   f'scale {fit[0]:.2f} puts 99 % of them >= 3 mm under the skin (nipple tip then {fit[3]:+.1f} mm); scale {onskin[0]:.2f} puts the nipple tip on the skin '
                   f'(gland p99 {onskin[1]:+.1f} mm, {100 * onskin[2]:.0f} % within 3 mm of the skin or outside)')
    return res


def main():
    name = sys.argv[1]
    arg = lambda k, d: (sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d)
    sex = 'F' if name == 'female' else 'M'
    out = os.path.join(RAW, 'out', arg('--dir', f'{name}-skin'))
    stale_guard(name)
    st = np.load(os.path.join(out, 'fit-state.npz'))
    ident, mp, off0, lod = st['identity'].copy(), st['mp'], st['offsets'], int(st['lod'])
    if os.path.getmtime(os.path.join(out, 'fit-state.npz')) < os.path.getmtime(os.path.join('public/anatomy', name, 'anatomy.json')):
        raise SystemExit('fit-state.npz is older than the body: run fit_skin.py first')
    report = json.load(open(os.path.join('public/anatomy', name, 'pipeline-report.json')))
    key = report['skinPackage']['internalsKey']
    fb = Body(name)
    L = bone_landmarks(fb)
    F = mhrlib.faces(lod)
    jn = mhrlib.joint_names(lod)
    log = [f'body {name}; internals key {key}; LOD {lod}']
    target_bmi = float(arg('--bmi', 23.6 if sex == 'M' else 21.6))

    Vm, P, sk = mhrlib.run(ident, mp, lod, True)
    H = lambda V: V[:, 1].max() - V[:, 1].min()
    bmi = lambda V: mesh_volume(V, F) * 1010.0 / H(V) ** 2
    b_fit = bmi(Vm + off0)
    if sex == 'M':
        # 男性：拟合的是他原来的皮肤（BMI 约 23.9）；沿 MHR 胖瘦分量调到目标 BMI
        # male: the fit matched his own skin (BMI about 23.9); move along MHR's fatness component to the target
        for _ in range(3):
            c = ident.copy()
            c[0] += 0.2
            k = (bmi(mhrlib.run(c, mp, lod, True)[0] + off0) - bmi(Vm + off0)) / 0.2
            ident[0] += (target_bmi - bmi(Vm + off0)) / k
            Vm, P, sk = mhrlib.run(ident, mp, lod, True)
    V0 = Vm + off0
    log.append(f'BMI by volume: parametric fit {b_fit:.2f}; target {target_bmi}; before enclosure {bmi(V0):.2f}; stature {H(V0) * 1000:.0f} mm')

    Pd, grp, pid, parts = deep_samples(fb)
    reg = classify(Pd, L)
    DV, DF = fb.merged(lambda p: p['tissue'] in Body.DEEP and p['system'] != 'integumentary')
    c0, s0 = containment(Pd, grp, reg, V0, F)
    log.append(f'\n== BEFORE local correction: deep-part surface samples outside the skin ({len(Pd)} samples of {len(parts)} parts)\n{fmt_cont(c0)}')
    # 位移上限：一般 45 mm；男性外生殖器所在的腹股沟区 80 mm（见报告：那里是把光滑的皮肤整体外推成一个隆起）
    # displacement cap: 45 mm in general; 80 mm in the male groin, where the smooth skin is pushed out into a mound over the external genitalia
    cap = np.full(len(V0), 0.045 if sex == 'M' else 0.02)   # 女性：按包络拟合后需要的外推不超过 17 mm / female: after the envelope fit no push above 17 mm is needed
    if sex == 'M':
        gen = [p for p in parts if any(t in p['name'].lower() for t in ('penis', 'scrotum', 'testis', 'epididymis'))]
        if gen:
            gv = np.vstack([fb.mesh(p)[0] for p in gen])
            lo_, hi_ = gv.min(0) - 0.05, gv.max(0) + 0.05
            cap[((V0 >= lo_) & (V0 <= hi_)).all(1)] = 0.08
    # 手：有了指节长度缩放后不该再需要大的外推；限制在 10 mm，免得相邻手指的皮肤被推到一起
    # hands: with the finger length scales no large push should be needed; capped at 10 mm so adjacent fingers are not pushed together
    cap[classify(V0, L) == 'hand'] = np.minimum(cap[classify(V0, L) == 'hand'], 0.010)
    V1 = enclose(V0, F, Pd, log, cap)
    # 头面部：把外推的位移场抹平（低通），眼睑、唇区保持为 0；否则鼻软骨、眦角处逐顶点的外推会留下尖刺。
    # Head and face: the push is low-passed there and stays 0 on lids and lips; otherwise the per-vertex push over the nasal cartilages and at the canthi leaves spikes.
    from final_female import head_weight, spread   # 延迟导入，避免循环 / lazy import, avoids a cycle
    whd = head_weight(lod)
    Ah = adjacency(len(V0), F)
    nh = vertex_normals(V0, F)
    for _ in range(3):
        nh = 0.5 * nh + 0.5 * (Ah @ nh)
    nh /= np.maximum(np.linalg.norm(nh, axis=1), 1e-12)[:, None]
    dh = spread(np.einsum('ij,ij->i', V1 - V0, nh).clip(0), Ah, cap, rings=2, smooth=5, final=3) * (1 - face_protect(lod)[0])
    V1 = V1 + whd[:, None] * (V0 + dh[:, None] * nh - V1)
    # 骨不能露在皮肤外，即使在眼睑、鼻、唇的保护区里（例如眶外缘）：对头部仍露出的骨再做一小遍（至多 2.5 mm，低通），这一遍不受保护区限制。
    # Bone may not show outside the skin even inside the protected lid, nose and lip regions (the lateral orbital rim, for
    # one): a short pass over head bone still outside (at most 2.5 mm, low-passed), not limited by the protection.
    hb = (grp == list(GROUPS).index('bone')) & (classify(Pd, L) == 'head')
    sb = signed_distance(Pd[hb], V1, F)
    if (sb > -0.0005).any():
        globals()['FACE_PROTECT_ON'] = False
        keep_b = globals()['MARGIN']
        globals()['MARGIN'] = 0.0008
        Vb_ = enclose(V1, F, Pd[hb][sb > -0.0008], log, np.full(len(V1), 0.0025), passes=4)
        globals()['MARGIN'] = keep_b
        globals()['FACE_PROTECT_ON'] = True
        db = spread(np.einsum('ij,ij->i', Vb_ - V1, nh).clip(0), Ah, np.full(len(V1), 0.0025), rings=2, smooth=4, final=2)
        V1 = V1 + (whd * db)[:, None] * nh
        log.append(f'  head bone pass: {int((db > 0.0002).sum())} vertices moved, max {db.max() * 1000:.1f} mm; head bone samples outside after: {int((signed_distance(Pd[hb], V1, F) > 0).sum())}')
    regV0 = classify(V0, L)
    grpV = mhr_groups(lod)
    np.savez(os.path.join(out, 'enclosed-before-separation.npz'), V=V1, F=F, grp=grpV)
    # 打开腋下（见 axilla.py）：只改皮肤的局部形状，不改姿势；之后再做一小遍包住检查，把被带出皮肤的深部结构收回去。
    # Open the axilla (see axilla.py): local skin shape only, the pose is untouched; a short enclosure pass afterwards takes back any deep part this exposed.
    # 浅层的薄结构（筋膜、浅静脉、皮神经、动脉、韧带）：不在上面的集合里。在腋下整形之前做（之后做会把腋下又顶回去）。离皮肤不足 0.75 mm 或露出不超过 4 mm 的，
    # 把皮肤再外移一点盖住（单点最多 4 mm，低通）；露出更多的不硬盖（会鼓出一个包），列出来。
    # Done before the axilla step (afterwards it pushes the axilla shut again).
    # Thin superficial structures (fasciae, superficial veins, cutaneous nerves, arteries, ligaments) are not in the set
    # above. Where they come within 0.75 mm of the skin or stand out by no more than 4 mm the skin moves out a little
    # more to cover them (at most 4 mm per vertex, low-passed); those that stand out further are not forced (that would
    # raise a bulge) and are listed instead.
    sup_parts = [p for p in fb.parts if p['tissue'] in ('fascia', 'vein', 'nerve', 'artery', 'ligament') and p['system'] != 'integumentary']
    sup_pts = np.vstack([fb.mesh(p)[0] for p in sup_parts])
    sup_pid = np.concatenate([np.full(len(fb.mesh(p)[0]), k) for k, p in enumerate(sup_parts)])
    ss = signed_distance(sup_pts, V1, F)
    sup_before = {'shareOutside': round(float((ss > 0).mean()), 5), 'maxMm': round(float(ss.max() * 1000), 1)}
    sel = (ss > -0.00075) & (ss < 0.004)
    superficial = {'before': sup_before, 'notCovered': []}
    if '--no-superficial' not in sys.argv and sel.any():
        keep_m = globals()['MARGIN']
        globals()['MARGIN'] = 0.00075
        from final_female import spread as _spread
        cap_sup = np.full(len(V1), 0.004)
        cap_sup[classify(V1, L) == 'hand'] = 0.0   # 手不做：指神经、指静脉太多，外移会让相邻手指的皮肤贴到一起 / not on the hands: too many digital nerves and veins, and pushing brings the skins of adjacent fingers together
        Vs = enclose(V1, F, sup_pts[sel], log, cap_sup, passes=4)
        globals()['MARGIN'] = keep_m
        ns = vertex_normals(V1, F)
        As = adjacency(len(V1), F)
        for _ in range(3):
            ns = 0.5 * ns + 0.5 * (As @ ns)
        ns /= np.maximum(np.linalg.norm(ns, axis=1), 1e-12)[:, None]
        dsup = _spread(np.einsum('ij,ij->i', Vs - V1, ns).clip(0), As, cap_sup, rings=1, smooth=3, final=2) * (1 - face_protect(lod)[0])
        V1 = V1 + dsup[:, None] * ns
        s2 = signed_distance(sup_pts, V1, F)
        superficial['after'] = {'shareOutside': round(float((s2 > 0).mean()), 5), 'maxMm': round(float(s2.max() * 1000), 1)}
        superficial['skinMovedMm'] = {'vertices': int((dsup > 0.0002).sum()), 'p95': round(float(np.percentile(dsup[dsup > 0.0002], 95) * 1000), 1) if (dsup > 0.0002).any() else 0.0, 'max': round(float(dsup.max() * 1000), 1)}
        for k, p in enumerate(sup_parts):
            x = s2[sup_pid == k]
            if len(x) and x.max() > 0.0005:
                superficial['notCovered'].append({'id': p['id'], 'name': p['name'], 'tissue': p['tissue'], 'shareOutside': round(float((x > 0).mean()), 3), 'maxMm': round(float(x.max() * 1000), 1)})
        superficial['notCovered'].sort(key=lambda r: -r['maxMm'])
        log.append(f'  superficial structures ({len(sup_parts)} parts: fascia, vein, nerve, artery, ligament): outside the skin before {100 * sup_before["shareOutside"]:.2f} % of their points, up to {sup_before["maxMm"]} mm; '
                   f'after {100 * superficial["after"]["shareOutside"]:.2f} %, up to {superficial["after"]["maxMm"]} mm; skin moved on {superficial["skinMovedMm"]["vertices"]} vertices (p95 {superficial["skinMovedMm"]["p95"]}, max {superficial["skinMovedMm"]["max"]} mm)')
        log.append('  superficial parts left outside (covering them would raise a bulge); max mm outside, share of the part outside:')
        for r in superficial['notCovered'][:30]:
            log.append(f'     {r["maxMm"]:5.1f}  {100 * r["shareOutside"]:5.1f} %  {r["name"]} [{r["tissue"]}]')
    json.dump(superficial, open(os.path.join(out, 'superficial.json'), 'w'), ensure_ascii=False, indent=1)
    axilla_before = axilla.sheet_gap(V1, F, grpV, L, vertex_normals, vertex_area)
    if '--no-separate' not in sys.argv:
        if sex == 'F':
            # 女性：肩、臂、胸侧的皮肤为包住肌肉各自外移后在腋下挤到一起，所以范围向上放到肱骨 26 % 处、单点最多 30 mm、做两轮。
            # Female: skin of shoulder, arm and side of the chest each moved out over muscle and met in the axilla, so the
            # range starts higher (26 % of the humerus), a vertex may move 30 mm, and two rounds are run.
            axilla.T0, axilla.MAX_MOVE, axilla.RAMP = 0.26, 0.030, 0.16   # 起点处用更宽的渐变，免得在腋前襞撕出一道缝 / a wider ramp at the start, so no slit is torn at the anterior axillary fold
        V1, _ = axilla.open_axilla(V1, F, grpV, fb, L, adjacency, log)
        if sex == 'F':
            V1, _ = axilla.open_axilla(V1, F, grpV, fb, L, adjacency, log)
        keep = globals()['MARGIN']
        globals()['MARGIN'] = 0.0008
        V1 = enclose(V1, F, Pd, log, np.full(len(V1), 0.004), passes=3)
        globals()['MARGIN'] = keep
    axilla_after = axilla.sheet_gap(V1, F, grpV, L, vertex_normals, vertex_area)
    log.append('  arm skin against the trunk skin facing it, by share of the humerus (cm2 inside it / within 1 mm / within 6 mm; least and 10th-percentile gap, mm):')
    for S in 'LR':
        for band in axilla_before[S]:
            log.append(f'    {S} {band}: before {json.dumps(axilla_before[S][band])} -> after {json.dumps(axilla_after[S][band])}')
    log.append(f'  skin lying against skin (cm2 by region and side): {facing_area(V1, F, regV0)}')
    c1, s1 = containment(Pd, grp, reg, V1, F)
    log.append(f'\n== AFTER local correction\n{fmt_cont(c1)}')
    disp = np.linalg.norm(V1 - V0, axis=1) * 1000
    regV = classify(V0, L)
    log.append('\nlocal correction of the skin, mm, by region: share of vertices moved > 1 mm / median of those / 95th percentile / max')
    dstat = {}
    for rid, _, _ in REGIONS:
        m = regV == rid
        if m.sum() < 20:
            continue
        mv = disp[m] > 1
        dstat[rid] = {'movedOver1mm': round(float(mv.mean()), 3), 'medianOfMoved': round(float(np.median(disp[m][mv])), 1) if mv.any() else 0.0,
                      'p95': round(float(np.percentile(disp[m], 95)), 1), 'max': round(float(disp[m].max()), 1)}
        log.append(f'  {rid:10s} {100 * dstat[rid]["movedOver1mm"]:5.1f} %  {dstat[rid]["medianOfMoved"]:5.1f}  {dstat[rid]["p95"]:5.1f}  {dstat[rid]["max"]:5.1f}')
    f0, f1 = fat_room(V0, F, DV, DF, L), fat_room(V1, F, DV, DF, L)
    log.append('\nfat room: skin -> nearest deep surface, mm, p10 / p50 / p90 (share of skin under 2 mm); before -> after')
    for rid in f1:
        a, b = f0[rid], f1[rid]
        log.append(f'  {rid:10s} {a["p10"]:5.1f} / {a["p50"]:5.1f} / {a["p90"]:5.1f} ({100 * a["under2mm"]:4.1f} %)  ->  {b["p10"]:5.1f} / {b["p50"]:5.1f} / {b["p90"]:5.1f} ({100 * b["under2mm"]:4.1f} %)')

    # 部件级：修正前最靠外的 / per part: the furthest outside before the correction
    worst = []
    for k, p in enumerate(parts):
        m = pid == k
        if m.sum() < 5:
            continue
        worst.append({'id': p['id'], 'name': p['name'], 'tissue': p['tissue'], 'outsideBefore': round(float((s0[m] > 0).mean()), 3),
                      'p95BeforeMm': round(float(np.percentile(s0[m], 95)), 1), 'maxBeforeMm': round(float(s0[m].max()), 1),
                      'outsideAfter': round(float((s1[m] > 0).mean()), 4), 'maxAfterMm': round(float(s1[m].max()), 1)})
    worst.sort(key=lambda w: -w['p95BeforeMm'])
    log.append('\nparts furthest outside BEFORE the correction (95th percentile mm, max mm, share outside) -> after (max mm):')
    for w in worst[:25]:
        log.append(f'   {w["p95BeforeMm"]:6.1f} {w["maxBeforeMm"]:6.1f} {100 * w["outsideBefore"]:5.0f} %  -> {w["maxAfterMm"]:6.1f}   {w["name"]} [{w["tissue"]}]')
    still = [w for w in worst if w['maxAfterMm'] > 0]
    log.append(f'parts with any sample still outside AFTER: {len(still)}' + ''.join(f'\n   {w["name"]}: max {w["maxAfterMm"]} mm, {100 * w["outsideAfter"]:.2f} %' for w in sorted(still, key=lambda w: -w['maxAfterMm'])[:15]))

    # 围度、BMI、间隙、封闭性 / girths, BMI, gaps, closedness
    J = {f'{a}_{Sd}': P[jn.index(f'{s}_{m}')] for Sd, s in (('L', 'l'), ('R', 'r'))
         for a, m in (('shoulder', 'uparm'), ('elbow', 'lowarm'), ('wrist', 'wrist'), ('hip', 'upleg'), ('knee', 'lowleg'), ('ankle', 'foot'))}
    ilio = 0.5 * (L['iliocristale_L'][1] + L['iliocristale_R'][1]) - L['floor'][1]
    m0 = surface_measures(V0, F, J, levels={'iliocristale': ilio})
    m1 = surface_measures(V1, F, J, levels={'iliocristale': ilio})
    rs = json.load(open(os.path.join('data/curated/bodyshape', 'rig-shape.json')))['sexes'][sex]
    std = {'waistIliacGirth': 'waistIliac', 'buttockGirth': 'hip', 'thighMidGirth': 'thighMid', 'calfMaxGirth': 'calf', 'upperArmMidGirth': 'upperArm',
           'chestGirth': 'chest', 'waistNavelGirth': 'waist', 'thighProximalGirth': 'thighProximal', 'thighLowerGirth': 'thighLower',
           'ankleMinGirth': 'ankle', 'wristMinGirth': 'wrist', 'forearmMaxGirth': 'forearm', 'neckMinGirth': 'neck'}
    gs = {g['id']: g['standardMm'] for g in rs['girths']}
    log.append('\nmeasure                 before  after   standard (rig-shape.json, default population)')
    girths = {}
    for k_ in ['stature', 'bmiFromVolume', 'volumeL'] + list(std):
        girths[k_] = {'before': round(float(m0[k_]), 1), 'after': round(float(m1[k_]), 1), 'standard': gs.get(std.get(k_))}
        log.append(f'  {k_:22s} {m0[k_]:7.1f} {m1[k_]:7.1f}   {gs.get(std.get(k_), "")}')
    gaps = self_gap(V1, F, L)
    closed = is_closed(F)
    log.append(f'gaps after (mm): {json.dumps(gaps)}; skin closed (every edge shared by two triangles): {closed}')
    res = {'body': name, 'internalsKey': key, 'targetBmi': target_bmi, 'bmiBeforeEnclosure': round(bmi(V0), 2), 'bmiAfterEnclosure': round(bmi(V1), 2),
           'marginMm': MARGIN * 1000, 'containmentBefore': c0, 'containmentAfter': c1, 'localCorrectionMm': dstat, 'fatRoomBeforeMm': f0, 'fatRoomAfterMm': f1,
           'partsFurthestOutsideBefore': worst[:60], 'partsStillOutsideAfter': still, 'girthsMm': girths, 'gapsMm': gaps, 'closed': closed}

    if sex == 'F':
        log.append('\nHRA breast parts against the final skin:')
        res['breastScaling'] = breast_scaling(fb, V1, F, log)
        wu = {}
        for k, p in enumerate(parts):
            if p['id'].startswith('WU_'):
                m = pid == k
                wu[p['id']] = {'name': p['name'], 'outsideBeforeMm': round(float(s0[m].max()), 1), 'coverAfterMm': round(float(-s1[m].max()), 1),
                               'lowestPointMm': [round(float(x) * 1000) for x in Pd[m][np.argmin(Pd[m][:, 1])]]}
        res['perineumStructures'] = wu
        log.append('\nWu pelvic-floor structures: most exposed sample before (mm outside, + = outside) -> skin cover after (mm):')
        for k_, v in sorted(wu.items(), key=lambda kv: -kv[1]['outsideBeforeMm']):
            log.append(f'   {v["outsideBeforeMm"]:+6.1f} -> {v["coverAfterMm"]:5.1f}   {k_}')
    else:
        gen = [k for k, p in enumerate(parts) if any(t in p['name'].lower() for t in ('penis', 'scrotum', 'testis', 'epididymis'))]
        g = {}
        for k in gen:
            m = pid == k
            g[parts[k]['id']] = {'name': parts[k]['name'], 'outsideBeforeMm': round(float(s0[m].max()), 1), 'coverAfterMm': round(float(-s1[m].max()), 1)}
        res['externalGenitalia'] = {'parts': g, 'note': 'enclosed by local outward displacement of the smooth MHR groin; no penile or scrotal skin is modelled'}
        gm = (regV == 'pelvis') | (regV == 'thigh')
        log.append(f'\nexternal genital parts ({len(gen)} deep parts matched): furthest sample before {max(v["outsideBeforeMm"] for v in g.values()):.1f} mm outside; '
                   f'least cover after {min(v["coverAfterMm"] for v in g.values()):.1f} mm; largest skin displacement in pelvis/thigh {disp[gm].max():.1f} mm')

    # ---- 写包 / write the package
    write_obj(os.path.join(out, 'skin.obj'), V1, F, f'{name} skin, MHR LOD{lod} topology (Apache-2.0); metres, Y up, +Z anterior, +X left')
    (V1 - Vm).astype(np.float32).tofile(os.path.join(out, 'residual-offsets.f32'))
    (mhrlib.run(ident, mp, lod, False)[0] + (V1 - Vm)).astype(np.float32).tofile(os.path.join(out, 'skin-no-pose-correctives.f32'))
    (V1 - V0).astype(np.float32).tofile(os.path.join(out, 'enclosure-offsets.f32'))
    np.savez(os.path.join(out, 'fit-state-final.npz'), identity=ident, mp=mp, offsets=V1 - Vm, lod=lod)
    vi, ji, w, parents = mhrlib.skin_weights(lod)
    rec = np.zeros(len(vi), dtype=[('v', '<u4'), ('j', '<u4'), ('w', '<f4')])
    rec['v'], rec['j'], rec['w'] = vi, ji, w
    rec.tofile(os.path.join(out, 'weights.bin'))
    json.dump({'note': {'zh': '关节位置为拟合姿势下、我们坐标系中的坐标（米）；rotation 为世界朝向四元数 (x, y, z, w)；parents 为父关节下标（-1 为根）。mapping 给出对应的解剖学关节（rig.json 的 id）。',
                        'en': 'Joint positions in the fitted pose, our frame (metres); rotation is the world orientation quaternion (x, y, z, w); parents index into names (-1 = root). mapping gives the anatomical joint (rig.json id).'},
               'names': jn, 'parents': parents.tolist(), 'positions': np.round(P, 5).tolist(), 'rotation': np.round(sk[:, 3:7], 6).tolist(),
               'mapping': joint_mapping(jn)}, open(os.path.join(out, 'joints.json'), 'w'), ensure_ascii=False)
    fj = os.path.join(out, 'fit.json')
    fit = json.load(open(fj)) if os.path.exists(fj) else {}
    fit['identity'] = [round(float(v), 4) for v in ident]
    json.dump(fit, open(fj, 'w'), ensure_ascii=False, indent=1)
    json.dump(res, open(os.path.join(out, 'enclosure.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(out, 'enclosure.txt'), 'w').write('\n'.join(log))
    shutil.copy(os.path.join(mhrlib.DIR, 'LICENSE.txt'), os.path.join(out, 'LICENSE-MHR.txt'))
    open(os.path.join(out, 'NOTICE-MHR.txt'), 'w').write(
        '本目录中的 skin.obj、weights.bin、joints.json、shape-*.f32 由 Momentum Human Rig (MHR) v1.0.1 派生。\n'
        'skin.obj, weights.bin, joints.json and shape-*.f32 in this directory are derived from Momentum Human Rig (MHR) v1.0.1.\n\n'
        'MHR: Copyright (c) Meta Platforms, Inc. and affiliates. Licensed under the Apache License, Version 2.0 (see LICENSE-MHR.txt).\n'
        'https://github.com/facebookresearch/MHR\n'
        '改动 / changes: identity, skeleton scale and pose fitted to the soma body; per-vertex corrections (towards the BodyParts3D skin for the male; '
        'outwards to enclose the internal parts for both bodies).\n')
    json.dump({
        'schema': 1,
        'what': {'zh': f'{"男" if sex == "M" else "女"}性皮肤（MHR LOD{lod} 拓扑，单层封闭，上臂内侧与胸壁的皮肤自肱骨中段起分开，其上方相贴），已局部外推到包住全部深部结构',
                 'en': f'{"male" if sex == "M" else "female"} skin in MHR LOD{lod} topology (closed single wall, medial arm and chest-wall skin apart from mid-humerus down and against each other above that), pushed out locally to enclose every deep part'},
        'source': {'name': 'Momentum Human Rig (MHR) v1.0.1', 'url': 'https://github.com/facebookresearch/MHR', 'license': 'Apache-2.0',
                   'attribution': 'MHR, Copyright (c) Meta Platforms, Inc. and affiliates, licensed under the Apache License 2.0; fitted to this body by tools/bodyshape'},
        'fittedTo': {'body': name, 'key': key},
        'frame': f'metres, Y up, +Z anterior, +X subject left; same origin as public/anatomy/{name}',
        'face': {
            'topology': {'zh': 'MHR LOD0 是一张封闭的单连通曲面：睑裂和口裂都不是开口，没有单独的眼球、上下睑缘、唇缘或口腔内面；眼睑是盖在眼球位置上的一片连续皮肤，上下唇在口裂处相贴成一道褶。因此没有睑缘、唇缘的顶点环可给；没有剪开网格。',
                         'en': 'MHR LOD0 is one closed, singly connected surface: neither the palpebral nor the oral fissure is an opening, and there is no separate eyeball, upper or lower lid margin, lip margin or mouth interior; the lids are one continuous sheet of skin over the place of the globe, and the lips meet in a crease at the oral fissure. So there are no lid-margin or lip-margin vertex loops to give; the mesh was not cut.'},
            'notEnclosed': {'zh': '眼球各部、结膜、泪器、睑板、睑缘处的眼轮匝肌内环（按几何选）、唇、牙、舌、牙龈、鼻软骨不在“必须包住”的集合里；下面的眼睑区、唇区、鼻区顶点不做任何外推，保留 MHR 自己的面。',
                            'en': 'the parts of the eyeball, conjunctiva, lacrimal parts, tarsal plates, the inner ring of orbicularis oculi at the lid margins (chosen by geometry), lips, teeth, tongue, gingiva and the nasal cartilages are not in the set that must be enclosed; the lid, lip and nose vertices below get no push at all and keep MHR\'s own surface.',
                            'partIds': sorted(excluded_face_parts(fb))},
            'regions': {k: [int(i) for i in v] for k, v in face_protect(lod)[1].items()},
            'regionsNote': {'zh': 'regions 是顶点下标（skin.obj 的顺序）：lidsL / lidsR 为眼关节 22 mm 内、其前方的皮肤（上下睑和睑裂），lips 为口裂上下约 12 mm 的唇区，nose 为鼻背到鼻尖、鼻翼。它们是区域，不是睑缘或唇缘的环。',
                            'en': 'regions are vertex indices (order of skin.obj): lidsL / lidsR are the skin within 22 mm of an eye joint and in front of it (both lids and the fissure), lips the lip region about 12 mm above and below the oral fissure, nose the dorsum, tip and alae. They are regions, not lid-margin or lip-margin loops.'},
        },
        'statureM': round(float(H(V1)), 4), 'bmiByVolume': round(bmi(V1), 2), 'targetBmi': target_bmi,
        'files': {
            'skin.obj': f'{len(V1)} vertices, {len(F)} triangles; vertex order = MHR LOD{lod}; closed: {closed}',
            'residual-offsets.f32': 'float32 [n][3]: skin.obj minus the pure MHR surface (all per-vertex corrections)',
            'enclosure-offsets.f32': 'float32 [n][3]: the part of that correction added to enclose the internals',
            'skin-no-pose-correctives.f32': 'float32 [n][3]: the same skin without MHR pose correctives',
            'weights.bin': f'{len(vi)} records (uint32 vertex, uint32 joint, float32 weight), little endian; up to {int(np.bincount(vi).max())} joints per vertex',
            'joints.json': f'{len(jn)} joints: names, parents, positions and orientations in this pose, mapping to anatomical joints',
            'fit.json, fit.txt': 'parametric fit (fit_skin.py)', 'enclosure.json, enclosure.txt': 'containment before/after, fat room, girths, gaps (this script)',
            'shape-fields.json + shape-*.f32': 'runtime shape fields (shape_fields.py)',
            'LICENSE-MHR.txt, NOTICE-MHR.txt': 'licence text and attribution that must ship with anything derived from these files'},
    }, open(os.path.join(out, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
    print('\n'.join(log))

    # ---- 渲染 / renders
    skin = (0.86, 0.72, 0.62)
    bv, bf = fb.merged(lambda p: p['tissue'] in GROUPS['bone'] and p['system'] != 'integumentary')
    mv, mf = fb.merged(lambda p: p['tissue'] in GROUPS['muscle'] and p['system'] != 'integumentary')
    ov, of = fb.merged(lambda p: p['tissue'] in GROUPS['organ'] and p['system'] != 'integumentary')
    inner = [(mv, mf, (0.75, 0.2, 0.2)), (bv, bf, (0.95, 0.95, 0.85)), (ov, of, (0.35, 0.55, 0.75))]
    hra = [fb.mesh(p) for p in fb.parts if p['id'].startswith('HRA_')]
    if hra:
        n0, hv, hf = 0, [], []
        for v, f in hra:
            hv.append(v)
            hf.append(f + n0)
            n0 += len(v)
        inner.append((np.vstack(hv), np.vstack(hf), (0.95, 0.6, 0.75)))
    render_views([(V1, F, skin)], os.path.join(out, 'preview-skin.png'), height=1100)
    render_overlay((V1, F, skin), inner, os.path.join(out, 'preview-overlay.png'), height=1100)
    render_views([(V1, F, skin)] + inner[:3], os.path.join(out, 'preview-pokes.png'), height=1100,
                 title='final skin with deep parts (muscle red, bone white, organs blue): whatever shows is outside the skin')
    render_views([(V0, F, skin)] + inner[:3], os.path.join(out, 'preview-pokes-before.png'), height=1100,
                 title='skin BEFORE the local correction with deep parts: whatever shows is outside the skin')
    sh, hp = P[jn.index('l_uparm')], 0.5 * (P[jn.index('l_upleg')] + P[jn.index('r_upleg')])
    boxes = {'axilla': ([0.05, sh[1] - 0.24, -0.08], [0.33, sh[1] + 0.07, 0.25]),
             'axilla-right': ([-0.33, sh[1] - 0.24, -0.08], [-0.05, sh[1] + 0.07, 0.25]),
             'chest': ([-0.22, sh[1] - 0.26, -0.10], [0.22, sh[1] + 0.02, 0.30]),
             'groin': ([-0.22, hp[1] - 0.22, -0.12], [0.22, hp[1] + 0.10, 0.28])}
    for tag, (lo, hi) in boxes.items():
        render_closeup([(V1, F, skin)], os.path.join(out, f'closeup-{tag}-skin.png'), lo, hi, views=('front', 'side', 'back'))
        render_closeup([(V1, F, skin)] + inner, os.path.join(out, f'closeup-{tag}-overlay.png'), lo, hi, views=('front', 'side', 'back'), alpha=0.5)
    lo, hi = [-0.20, hp[1] - 0.20, -0.12], [0.20, hp[1] + 0.02, 0.26]
    render_bottom([(V1, F, skin)], os.path.join(out, 'closeup-perineum-below-skin.png'), lo, hi)
    render_bottom(inner, os.path.join(out, 'closeup-perineum-below-internals.png'), lo, hi)


if __name__ == '__main__':
    main()
