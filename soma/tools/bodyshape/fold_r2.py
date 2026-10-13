"""
皮肤的折缝（腋窝、两大腿之间）：按“中面”把相对的两片皮肤分开。取代 axilla.py 的做法（那边按间隙各让一半，只管肱骨 26 % 以下）。
Skin folds (axilla, between the thighs): the two facing sheets are parted at a mid-surface. It replaces the treatment in
axilla.py (which made each sheet give half the gap, and only below 26 % of the humerus).

中面 / the mid-surface
    a、b 两侧各有自己的深部结构（上臂的 / 躯干的；左下肢的 / 右下肢的）。对空间里一点 x，
        m(x) = ( 到 b 侧深部结构的距离 - 到 a 侧深部结构的距离 ) / 2
    m = 0 的面离两侧深部结构一样远，就是两者之间的中面；两侧的深部结构各在它的一边（它们互不相穿时）。
    a 片皮肤应满足 m >= g/2，b 片应满足 m <= -g/2：两片之间至少隔 g（MIN_GAP，1.5 mm），并且各在中面的自己一边，所以互不相穿。
    两侧深部结构本身相贴的地方（腋窝顶以上、大腿根），两片皮肤就贴着中面、相隔 g，汇成一条折缝；那里皮肤下的覆盖不足，如实报告。
    Each side a, b has deep parts of its own (of the arm / of the trunk; of the left / of the right lower limb). For a point x
        m(x) = ( distance to the deep parts of b - distance to the deep parts of a ) / 2 .
    The surface m = 0 is equidistant from both: the mid-surface, with the deep parts of each side on its own side of it (as long
    as they do not interpenetrate). Sheet a must have m >= g/2 and sheet b m <= -g/2: the sheets are then at least g apart
    (MIN_GAP, 1.5 mm) and each on its own side of the mid-surface, so they cannot cross. Where the deep parts themselves touch
    (above the apex of the axilla, at the root of the thighs) the two sheets lie along the mid-surface g apart and meet in one
    fold; the cover under the skin is short there, and that is reported as it is.

一个顶点属于哪一片 / which sheet a vertex belongs to
    按 MHR 的蒙皮权重分组（上臂 / 躯干；左腿 / 右腿）。只有一种例外：它在“另一侧”深入超过 FLIP（8 mm）而且法线朝外，
    说明它其实是盖在另一侧深部结构上的皮肤（腋后襞、三角肌后部常这样），就算作另一侧，不去拉它。
    By MHR skin-weight group (arm / trunk; left / right leg), with one exception: a vertex more than FLIP (8 mm) deep on the other
    side really is skin over the other side's deep parts (common at the posterior axillary fold and the back of the deltoid); it
    is counted with that side and not pulled.
"""
import numpy as np

MIN_GAP = 0.0015   # 两片皮肤之间的最小间隙 / least gap between the two sheets
FLIP = 0.008
MAX_MOVE = 0.035   # 单个顶点最多移动 / most a single vertex may move
NEAR = 0.05        # 只处理离两侧深部结构都不到 50 mm 的皮肤 / only skin within 50 mm of both deep sides is treated


def _dist(P, M):
    import igl
    d2, _, c = igl.point_mesh_squared_distance(np.ascontiguousarray(P), M[0], M[1])[:3]
    return np.sqrt(d2), c


def _field(P, Ma, Mb):
    """m 和它的梯度方向（单位向量；朝 a 侧为正）及梯度的模 / m, the unit direction of its gradient (positive towards side a) and the gradient's norm"""
    da, ca = _dist(P, Ma)
    db, cb = _dist(P, Mb)
    g = (P - cb) / np.maximum(db, 1e-9)[:, None] - (P - ca) / np.maximum(da, 1e-9)[:, None]
    gn = np.linalg.norm(g, axis=1)
    return (db - da) / 2, g / np.maximum(gn, 1e-9)[:, None], gn / 2, da, db


def sheet_coordinate(lod):
    """每个顶点的“片坐标”，取自 MHR 的蒙皮权重，连续：{'armL', 'armR'}: 上臂各关节的权重和 × 2 - 1（+1 = 完全随上臂，-1 = 完全不随）；
    'legs': 左下肢的权重和减右下肢的权重和。绝对值小于 S0 的顶点在两片的交界上（折线、肩外侧），不受约束。
    The "sheet coordinate" of every vertex, from MHR's skin weights and continuous: {'armL', 'armR'}: twice the summed weight of the
    arm joints minus 1 (+1 = moves wholly with the arm, -1 = not at all); 'legs': summed weight of the left lower limb minus that of
    the right. Vertices with an absolute value under S0 lie on the junction of the sheets (the fold line, the outside of the shoulder) and are not constrained."""
    import mhrlib
    vi, ji, w, _ = mhrlib.skin_weights(lod)
    jn = mhrlib.joint_names(lod)
    n = int(vi.max()) + 1
    arm = ('uparm', 'lowarm', 'wrist', 'thumb', 'index', 'middle', 'ring', 'pinky')
    leg = ('upleg', 'lowleg', 'foot', 'talocrural', 'subtalar', 'transversetarsal', 'ball')
    is_ = lambda side, names: np.array([nm[:2] == side + '_' and nm[2:].startswith(names) for nm in jn])
    acc = lambda m: np.bincount(vi, weights=w * m[ji], minlength=n)
    return {'armL': 2 * acc(is_('l', arm)) - 1, 'armR': 2 * acc(is_('r', arm)) - 1, 'legs': acc(is_('l', leg)) - acc(is_('r', leg))}


S0, S1 = 0.2, 0.6   # 片坐标的绝对值从 S0 到 S1，约束从 0 升到全量 / the constraint rises from nothing to full as |sheet coordinate| goes from S0 to S1


def sheets(V, sc, Ma, Mb, zone):
    """折缝区内的顶点、各自属于哪一片（True = a）和约束的权重 / the vertices of the fold zone, the sheet of each (True = a) and the weight of the constraint"""
    sel = np.where((zone > 0) & (np.abs(sc) > S0))[0]
    m, _, _, da, db = _field(V[sel], Ma, Mb)
    k = (da < NEAR) & (db < NEAR)
    sel, m = sel[k], m[k]
    own_a = sc[sel] > 0
    own_a = np.where(own_a & (m < -FLIP), False, np.where(~own_a & (m > FLIP), True, own_a))
    wt = np.clip((np.abs(sc[sel]) - S0) / (S1 - S0), 0, 1) * np.clip(zone[sel] * 4, 0, 1)
    return sel, own_a, wt


def part(V, F, sc, Ma, Mb, zone, A, log, tag, gap=MIN_GAP, rounds=8):
    """把两片皮肤分到中面两边。返回 (新顶点, 信息)。zone 是 0–1 的权重（区外为 0）。
    Part the two sheets to either side of the mid-surface. Returns (new vertices, info). zone is a 0-1 weight (0 outside)."""
    V = V.copy()
    V0 = V.copy()
    sel, own_a, wt = sheets(V, sc, Ma, Mb, zone)
    sg = np.where(own_a, 1.0, -1.0)
    half = 0.5 * gap * wt

    def project(damp):
        m, n, gn, da, db = _field(V[sel], Ma, Mb)
        need = np.clip(half - sg * m, 0, None)
        step = damp * need / np.maximum(gn, 0.35)
        room = np.clip(MAX_MOVE - np.linalg.norm(V[sel] - V0[sel], axis=1), 0, None)
        step = np.minimum(step, room)
        V[sel] += (sg * step)[:, None] * n
        return need

    for _ in range(rounds):
        project(0.9)
    # 位移场抹平四遍，再投影回去，保证约束成立 / the displacement is smoothed four times, then projected again so the constraint holds
    U = V - V0
    msk = np.zeros(len(V), bool)
    msk[sel] = True
    for _ in range(4):
        U = 0.5 * U + 0.5 * (A @ U)
    V = V0 + U
    for _ in range(4):
        need = project(1.0)
    mv = np.linalg.norm(V[sel] - V0[sel], axis=1)
    m, _, _, da, db = _field(V[sel], Ma, Mb)
    own = np.where(own_a, da, db)
    info = {'vertices': int(len(sel)), 'moved': int((mv > 0.0002).sum()), 'movedMedianMm': round(float(np.median(mv[mv > 0.0002]) * 1000), 2) if (mv > 0.0002).any() else 0.0,
            'movedMaxMm': round(float(mv.max() * 1000), 1), 'stillShortOfGap': int((need > 1e-5).sum()),
            'deepSidesLeastDistanceMm': round(float((da + db).min() * 1000), 2),
            'verticesWhereDeepSidesUnder5mmApart': int(((da + db) < 0.005).sum()),
            'coverOverOwnDeepMm': {'min': round(float(own.min() * 1000), 2), 'p5': round(float(np.percentile(own, 5) * 1000), 2), 'median': round(float(np.median(own) * 1000), 2)}}
    log.append(f'  fold {tag}: ' + str(info))
    return V, info


def metrics(V, F, sc, Ma, Mb, zone):
    """折缝的量度：在中面错误一侧的顶点和面积、两片的三角形相交对数、两片之间的最小间隔、折线的平滑度。
    Measurements of a fold: vertices and area on the wrong side of the mid-surface, intersecting triangle pairs between the sheets,
    least separation of the sheets, smoothness of the fold line."""
    import igl
    sel, own_a, wt = sheets(V, sc, Ma, Mb, zone)
    m, _, _, da, db = _field(V[sel], Ma, Mb)
    sg = np.where(own_a, 1.0, -1.0)
    cls = np.zeros(len(V), int)
    cls[sel] = np.where(own_a, 1, 2)
    fa, fb_ = F[(cls[F] == 1).all(1)], F[(cls[F] == 2).all(1)]
    va = np.zeros(len(V))
    tri = V[F]
    ar = 0.5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
    np.add.at(va, F.ravel(), np.repeat(ar / 3, 3))
    wrong = (sg * m < 0) & (wt >= 1)
    out = {'zoneVertices': int(len(sel)), 'wrongSideVertices': int(wrong.sum()), 'wrongSideAreaCm2': round(float(va[sel][wrong].sum() * 1e4), 2),
           'deepestOnWrongSideMm': round(float(max(0.0, (-sg * m).max()) * 1000), 2)}
    # 相交：a 片每条边对 b 片的三角形求交（边与三角形相交 = 一对相交的三角形的证据）；反过来再做一遍
    # intersections: every edge of sheet a against the triangles of sheet b (an edge crossing a triangle is evidence of an intersecting pair), and the other way round
    pairs = set()
    for f1, f2 in ((fa, fb_), (fb_, fa)):
        if not len(f1) or not len(f2):
            continue
        e = np.unique(np.sort(np.vstack([f1[:, [0, 1]], f1[:, [1, 2]], f1[:, [2, 0]]]), axis=1), axis=0)
        Vc, Fc = np.ascontiguousarray(V), np.ascontiguousarray(f2)
        # 先用距离筛掉远的边 / edges far from the other sheet are dropped first
        mid = 0.5 * (V[e[:, 0]] + V[e[:, 1]])
        ln = np.linalg.norm(V[e[:, 1]] - V[e[:, 0]], axis=1)
        d = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(mid), Vc, Fc)[0])
        for i in np.where(d < 0.5 * ln + 1e-6)[0]:
            o, dr = V[e[i, 0]], V[e[i, 1]] - V[e[i, 0]]
            for h in igl.ray_mesh_intersect(np.ascontiguousarray(o), np.ascontiguousarray(dr), Vc, Fc) or []:
                if 1e-9 < h[1] < 1 - 1e-9:
                    pairs.add((tuple(e[i]), int(h[0]), f1 is fa))
    out['edgeTriangleCrossings'] = len(pairs)
    # 两片之间的间隔：a 片顶点到 b 片曲面的距离，在中面错误一侧的记为负 / separation: distance from the vertices of sheet a to the surface of sheet b, negative on the wrong side
    ia = sel[own_a & ((da + db) < 0.04)]
    if len(ia) and len(fb_):
        d = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(V[ia]), np.ascontiguousarray(V), np.ascontiguousarray(fb_))[0])
        mm = m[own_a & ((da + db) < 0.04)]
        d = np.where(mm < 0, -d, d)
        k = np.abs(d) < 0.02
        out['sheetSeparationMm'] = {'min': round(float(d.min() * 1000), 2), 'p5': round(float(np.percentile(d[k], 5) * 1000), 2) if k.any() else None,
                                    'under1mmCm2': round(float(va[ia][d < 0.001].sum() * 1e4), 2), 'negativeCm2': round(float(va[ia][d < 0].sum() * 1e4), 2)}
    # 折线：两片之间不受约束的那一带（|片坐标| < S0）里、离两侧深部结构都近的顶点；平滑度 = 各点到其网格邻点平均位置的距离（法向起伏）的均方根
    # the fold line: the vertices of the unconstrained band between the sheets (|sheet coordinate| < S0) that are near both deep sides;
    # smoothness = RMS distance of each from the mean of its mesh neighbours (the relief along the normal)
    E2 = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    nz = np.zeros(len(V), bool)
    for _ in range(4):   # 区域向外扩四圈 / the zone grown by four rings
        nz[np.where(zone > 0.3)[0]] = True
        hit = nz[E2[:, 0]] | nz[E2[:, 1]]
        nz[E2[hit].ravel()] = True
    band = np.where(nz & (np.abs(sc) <= S0))[0]
    if len(band) > 4:
        _, _, _, da2, db2 = _field(V[band], Ma, Mb)
        band = band[(da2 < 0.03) & (db2 < 0.03)]
    if len(band) > 4:
        E = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]], F[:, [1, 0]], F[:, [2, 1]], F[:, [0, 2]]])
        acc, cnt = np.zeros((len(V), 3)), np.zeros(len(V))
        np.add.at(acc, E[:, 0], V[E[:, 1]])
        np.add.at(cnt, E[:, 0], 1)
        r = np.linalg.norm(V[band] - acc[band] / cnt[band][:, None], axis=1)
        out['foldLine'] = {'vertices': int(len(band)), 'roughnessRmsMm': round(float(np.sqrt((r ** 2).mean()) * 1000), 2), 'roughnessMaxMm': round(float(r.max() * 1000), 2)}
    return out


def axilla_sides(fb, L, V, side):
    """(a 侧深部网格, b 侧深部网格, 区域权重)：上臂 / 其余；区域沿肱骨从肩关节下方（6 %）到肘上方；肩顶不在内。
    (deep mesh of a, deep mesh of b, zone weight): the arm / everything else; the zone runs along the humerus from just below the shoulder joint (6 %) to above the elbow; the top of the shoulder is outside it."""
    import axilla
    Ma, Mt = axilla.deep_sides(fb, side)
    sh, el = L['shoulder_' + side], L['elbow_' + side]
    t = (V - sh) @ (el - sh) / ((el - sh) @ (el - sh))
    w = np.clip((t - 0.06) / 0.10, 0, 1) * np.clip((0.92 - t) / 0.08, 0, 1)
    return Ma, Mt, w, t


def thigh_sides(fb, L, V):
    """左、右下肢的深部结构（肌、腱、骨；中线上的外生殖器等不算）和区域权重（膝上到髋下）。
    Deep parts of the left and of the right lower limb (muscle, tendon, bone; midline parts such as the genitalia excluded) and the zone weight (above the knee to below the hip)."""
    from bodylib import Body
    hipy = 0.5 * (L['hip_L'][1] + L['hip_R'][1])
    legp = lambda sg: (lambda p: p['tissue'] in Body.DEEP and p['system'] != 'integumentary' and p['tissue'] in ('muscle', 'tendon', 'bone')
                       and sg * float(fb.mesh(p)[0][:, 0].mean()) > 0.03 and float(fb.mesh(p)[0][:, 1].mean()) < hipy - 0.02 and float(fb.mesh(p)[0][:, 1].max()) < hipy + 0.12)
    Ml = tuple(np.ascontiguousarray(x) for x in fb.merged(legp(1)))
    Mr = tuple(np.ascontiguousarray(x) for x in fb.merged(legp(-1)))
    kn = 0.5 * (L['knee_L'][1] + L['knee_R'][1])
    w = np.clip((V[:, 1] - kn) / 0.06, 0, 1) * np.clip((hipy + 0.03 - V[:, 1]) / 0.04, 0, 1)
    return Ml, Mr, w


def facing_weight(V, F, A, Ma, Mb, sc):
    """0–1：这个顶点的皮肤是否朝着另一侧的深部结构（腋窝里相对的两片才是；肩顶、上臂外侧、胸前不是）。抹平三遍。
    第一次没有这个权重：中面从肩顶穿过，三角肌上的皮肤被拉出一道口子。
    0-1: whether the skin at this vertex faces the deep parts of the other side (true of the two facing sheets inside the axilla; not of the
    top of the shoulder, the outside of the arm or the front of the chest). Smoothed three times. The first attempt had no such weight: the
    mid-surface runs through the top of the shoulder, and the skin over the deltoid was pulled into a gash."""
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    vn = np.zeros_like(V)
    for k in range(3):
        np.add.at(vn, F[:, k], n)
    vn /= np.maximum(np.linalg.norm(vn, axis=1), 1e-12)[:, None]
    idx = np.where(np.abs(sc) > S0)[0]
    da, ca = _dist(V[idx], Ma)
    db, cb = _dist(V[idx], Mb)
    other = np.where((sc[idx] > 0)[:, None], cb, ca) - V[idx]
    od = np.linalg.norm(other, axis=1)
    cosang = np.einsum('ij,ij->i', vn[idx], other) / np.maximum(od, 1e-9)
    f = np.zeros(len(V))
    f[idx] = np.clip((cosang - 0.1) / 0.3, 0, 1) * (od < NEAR)
    for _ in range(3):
        f = 0.5 * f + 0.5 * (A @ f)
    return f
