"""
打开腋下：上臂内侧皮肤与胸壁皮肤之间的局部整形（不改姿势）。
Opening the axilla: local reshaping of the medial upper-arm skin and the chest-wall skin (the pose is not changed).

骨骼决定姿势，所以不能靠外展皮肤的手臂。做法是：在上臂段内，对每个皮肤顶点算
    f = 到躯干深部结构的距离 - 到上臂深部结构的距离
上臂的皮肤应满足 f >= g，躯干的皮肤应满足 f <= -g；这样两片皮肤之间至少隔 g。不满足的顶点各自朝自己一侧的
深部结构收进去，直到满足，或者它下面只剩最小覆盖为止。上臂与躯干的肌肉本身贴在一起的地方（男性从肩到肱骨
约 40 % 处）没有可行解：那里两片皮肤只能贴在一起，本文件把这个范围如实报出来。

Bones define the pose, so the arm of the skin cannot be abducted. Instead, for every skin vertex along the upper arm
    f = distance to the deep parts of the trunk - distance to the deep parts of the arm
is computed; arm skin should have f >= g and trunk skin f <= -g, which leaves at least g between the two sheets.
Vertices that fail are drawn towards the deep parts of their own side until they pass, or until only the least cover
is left under them. Where the muscles of arm and trunk themselves touch (in the male from the shoulder to about 40 %
down the humerus) there is no feasible answer: the two sheets can only lie against each other there, and this file
reports that range as it is.
"""
import numpy as np

ARM = ('biceps brachii', 'triceps brachii', 'brachialis', 'coracobrachialis', 'humerus', 'deltoid', 'anconeus', 'brachioradialis',
       'extensor carpi', 'pronator teres', 'flexor carpi', 'palmaris', 'radius', 'ulna')
GAP = 0.006         # 希望留出的间隙 / gap asked for
COVER = 0.0015      # 深部结构上最少留的覆盖 / least cover left over the deep parts
MAX_MOVE = 0.022    # 单个顶点最多移动；移动后由调用方复核深部结构仍在皮肤内 / most a single vertex may move; the caller checks afterwards that the deep parts are still inside the skin
T0, T1 = 0.36, 0.90   # 沿肱骨（肩 0，肘 1）起作用的范围 / range along the humerus (shoulder 0, elbow 1) in which this acts


def _dist(P, M):
    import igl
    d2, _, c = igl.point_mesh_squared_distance(np.ascontiguousarray(P), M[0], M[1])[:3]
    return np.sqrt(d2), c


def deep_sides(fb, side):
    """(上臂一侧的深部网格, 其余深部网格) / (deep mesh of the arm on one side, deep mesh of everything else)"""
    from bodylib import Body
    word = {'L': 'left', 'R': 'right'}[side]
    deep = lambda p: p['tissue'] in Body.DEEP and p['system'] != 'integumentary'
    arm = lambda p: deep(p) and word in p['name'].lower() and any(t in p['name'].lower() for t in ARM)
    a = fb.merged(arm)
    t = fb.merged(lambda p: deep(p) and not arm(p))
    return tuple(np.ascontiguousarray(x) for x in a), tuple(np.ascontiguousarray(x) for x in t)


def zone(V, L, side):
    """沿肱骨的位置 t 和权重（范围两端渐变到 0）/ position t along the humerus and a weight that fades to 0 at both ends of the range"""
    sh, el = L['shoulder_' + side], L['elbow_' + side]
    ax = el - sh
    t = (V - sh) @ ax / (ax @ ax)
    w = np.clip((t - T0) / 0.08, 0, 1) * np.clip((T1 - t) / 0.06, 0, 1)
    return t, w


def sheet_gap(V, F, grp, L, vertex_normals, vertex_area):
    """量：上臂皮肤到对面躯干皮肤的有符号间隙（负 = 在躯干皮肤之内），只看肱骨 25–85 % 的范围、法线相对的顶点对。
    Measure: signed gap from arm skin to the trunk skin facing it (negative = inside the trunk skin), over 25-85 % of the humerus and for vertex pairs with opposing normals."""
    from scipy.spatial import cKDTree
    n = vertex_normals(V, F)
    A = vertex_area(V, F) * 1e4
    out = {}
    it = np.where(grp == 0)[0]
    tree = cKDTree(V[it])
    for side, g in (('L', 1), ('R', 2)):
        t, _ = zone(V, L, side)
        ia = np.where((grp == g) & (t > 0.25) & (t < 0.85))[0]
        gap = np.full(len(ia), np.inf)
        for k in range(4):
            d, j = tree.query(V[ia], k=4)
            u = it[j[:, k]]
            facing = np.einsum('ij,ij->i', n[ia], n[u]) < -0.3
            s = np.einsum('ij,ij->i', V[ia] - V[u], n[u])
            gk = np.where(s < 0, -d[:, k], d[:, k])
            gap = np.where(facing & (d[:, k] < 0.03), np.minimum(gap, gk), gap)
        bands = {}
        for lo, hi in ((0.25, 0.4), (0.4, 0.5), (0.5, 0.6), (0.6, 0.85)):
            m = (t[ia] >= lo) & (t[ia] < hi)
            near = m & (gap < 0.02)
            bands[f'{lo:.2f}-{hi:.2f}'] = {'insideCm2': round(float(A[ia][m & (gap < 0)].sum()), 1), 'under1mmCm2': round(float(A[ia][m & (gap < 0.001)].sum()), 1),
                                           'under6mmCm2': round(float(A[ia][m & (gap < 0.006)].sum()), 1),
                                           'minMm': round(float(gap[near].min() * 1000), 1) if near.any() else None,
                                           'p10Mm': round(float(np.percentile(gap[near], 10) * 1000), 1) if near.any() else None}
        out[side] = bands
    return out


def open_axilla(V, F, grp, fb, L, adjacency, log, rounds=8):
    """返回整形后的顶点。grp：0 躯干，1 左臂，2 右臂（见 enclose_skin.mhr_groups）。
    Returns the reshaped vertices. grp: 0 trunk, 1 left arm, 2 right arm (see enclose_skin.mhr_groups)."""
    V = V.copy()
    A = adjacency(len(V), F)
    total = np.zeros(len(V))
    for side, g in (('L', 1), ('R', 2)):
        Ma, Mt = deep_sides(fb, side)
        t, w = zone(V, L, side)
        sel = np.where((w > 0) & np.isin(grp, [0, g]))[0]
        da, _ = _dist(V[sel], Ma)
        dt, _ = _dist(V[sel], Mt)
        sel = sel[(da < 0.06) & (dt < 0.06)]
        own_arm = grp[sel] == g
        V0 = V[sel].copy()
        da, _ = _dist(V0, Ma)
        dt, _ = _dist(V0, Mt)
        # 两侧深部结构之间只有 D 的地方，覆盖最多只能留 D/2 / where only D lies between the two deep sides the cover cannot exceed D/2
        cover = np.clip((da + dt) / 2 - 0.0005, 0.0003, COVER)
        for _ in range(rounds):
            da, ca = _dist(V[sel], Ma)
            dt, ct = _dist(V[sel], Mt)
            f = np.where(own_arm, dt - da, da - dt)        # 应 >= g / should be >= g
            down, c = np.where(own_arm, da, dt), np.where(own_arm[:, None], ca, ct)
            need = np.clip((GAP * w[sel] - f) / 2, 0, None)
            room = np.clip(MAX_MOVE - np.linalg.norm(V[sel] - V0, axis=1), 0, None)
            step = np.minimum(np.minimum(need, room), np.clip(down - cover, 0, None))
            d = np.zeros(len(V))
            d[sel] = step
            for _ in range(2):   # 把位移抹平一点，避免折痕 / smooth the displacement a little to avoid creases
                d = np.maximum(d, 0.5 * (A @ d)) * (d > 0) + 0.5 * (A @ d) * (d == 0)
            step = np.minimum(np.minimum(d[sel], room), np.clip(down - cover, 0, None))
            V[sel] += step[:, None] * (c - V[sel]) / np.maximum(down, 1e-9)[:, None]
        # 把位移场本身抹平两遍（范围以上肌肉相贴、无解，硬收会在腋窝顶撕出锯齿）
        # smooth the displacement field itself twice (above the range the muscles touch and nothing can be done; a hard edge there tears a jagged notch at the top of the armpit)
        dv = np.zeros_like(V)
        dv[sel] = V[sel] - V0
        for _ in range(2):
            dv = 0.5 * dv + 0.5 * (A @ dv)
        V[sel] = V0 + dv[sel]
        mv = np.linalg.norm(V[sel] - V0, axis=1)
        total[sel] = mv
        da, _ = _dist(V[sel], Ma)
        dt, _ = _dist(V[sel], Mt)
        f = np.where(own_arm, dt - da, da - dt)
        D = (da + dt)
        for lo, hi in ((0.25, 0.4), (0.4, 0.5), (0.5, 0.6), (0.6, 0.85)):
            m = (t[sel] >= lo) & (t[sel] < hi) & (D < 0.04)
            if m.any():
                log.append(f'  axilla {side} {lo:.2f}-{hi:.2f} of the humerus: {int((m & (mv > 0.0005)).sum())} vertices moved (median {np.median(mv[m & (mv > 0.0005)]) * 1000 if (m & (mv > 0.0005)).any() else 0:.1f}, max {mv[m].max() * 1000:.1f} mm); '
                           f'deep parts of arm and trunk lie {np.percentile(D[m], 5) * 1000:.1f} mm apart at the 5th percentile; skin still short of the {GAP * 1000:.0f} mm rule on {100 * (f[m] < GAP * w[sel][m] - 0.0005).mean():.0f} % of these vertices; '
                           f'least cover {np.where(own_arm, da, dt)[m].min() * 1000:.1f} mm')
    return V, total
