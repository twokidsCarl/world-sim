"""可复用的人体测量程序：由皮肤网格加关节中心量围度/宽厚/高度，由骨骼量标志点高度和肢段长度。
Reusable body measurer.

Two layers:

  surface_measures(V, F, joints)   girths / breadths / depths / heights from a skin mesh plus six
                                   pairs of joint centres. Works on any body in our frame (ours,
                                   MakeHuman/Anny, MHR), so all are measured with one definition.
  bone_landmarks(body), skeletal_measures(...)   landmark heights and segment lengths from the
                                   bones of one of our bodies (ANSUR II landmark definitions).

CLI:  python -I tools/bodyshape/measure.py male female
      -> data/raw/bodyshape/out/measure-<body>.json  (all values in mm) and a slice preview PNG.

Frame: metres, Y up, +Z anterior, +X subject's left, standing, arms hanging slightly abducted.
Girths are convex-hull perimeters of the cut contour (what a tape does), in horizontal planes for
the trunk and legs and in planes perpendicular to the segment axis for the arms.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bodylib import RAW, Body, hull_perimeter, plane_basis, render_views, slice_segments  # noqa: E402

# 全身平均密度，用来把网格体积换算成体重 / whole-body average density, turns mesh volume into mass
DENSITY = 1010.0  # kg/m3


# ------------------------------------------------------------------ 切片的连通分量
# ------------------------------------------------------------------ slice components

def components(segs, tol=2e-4):
    """把三维线段按共用端点分成连通分量。
    Group 3D segments into connected components (shared end points)."""
    if len(segs) == 0:
        return []
    pts = segs.reshape(-1, 3)
    key = np.round(pts / tol).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1, 2)
    parent = np.arange(inv.max() + 1)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in inv:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    root = np.array([find(a) for a in inv[:, 0]])
    return [segs[root == r] for r in np.unique(root)]


class Cut:
    """皮肤的平面截面；取包围参考点的那一圈轮廓。
    Planar cut of the skin; picks the connected contour around a reference point."""

    def __init__(self, V, F, origin, normal, keep=None):
        self.o = np.asarray(origin, float)
        self.n = np.asarray(normal, float) / np.linalg.norm(normal)
        self.u, self.w = plane_basis(self.n)
        segs = slice_segments(V, F, self.o, self.n)
        if keep is not None and len(segs):
            segs = segs[keep(segs.mean(1))]
        self.segs = segs

    def to2(self, p):
        r = np.asarray(p) - self.o
        return np.stack([r @ self.u, r @ self.w], -1)

    def around(self, ref, merge=False):
        """包住 `ref` 的那个连通分量的点；没有则取最近的。merge=True 时合并所有包住参考点的分量。
        Points (n,3) of the component whose hull contains `ref`; the nearest one otherwise.
        merge=True unions every component whose hull contains the reference point."""
        from matplotlib.path import Path
        comps = components(self.segs)
        if not comps:
            return None
        r2 = self.to2(ref)
        best, bestd, inside = None, 1e9, []
        for c in comps:
            p = c.reshape(-1, 3)
            if len(p) < 6:
                continue
            p2 = self.to2(p)
            _, hp = hull_perimeter(p2)
            if len(hp) >= 3 and Path(hp).contains_point(r2):
                inside.append(p)
            d = np.min(np.linalg.norm(p2 - r2, axis=1))
            if d < bestd:
                best, bestd = p, d
        if inside:
            if merge:
                return np.vstack(inside)
            return max(inside, key=lambda p: hull_perimeter(self.to2(p))[0])
        return best

    def girth(self, pts):
        return hull_perimeter(self.to2(pts))[0] if pts is not None and len(pts) > 5 else float('nan')


def hcut(V, F, y, keep=None):
    return Cut(V, F, [0, y, 0], [0, 1, 0], keep)


# ------------------------------------------------------------------ 体表测量
# ------------------------------------------------------------------ surface measures

def mesh_volume(V, F, step=0.005, cell=0.002):
    """外表面所围体积：逐层水平切片、在栅格上填充求面积。（我们的皮肤是带内表面的闭合薄壳，
    网格的有符号体积只是壳本身的体积。）
    Volume enclosed by the OUTER surface, by filling horizontal slices on a grid. (Our skin is
    a thin closed shell with an inner face, so the signed mesh volume is only the shell's.)"""
    from scipy import ndimage
    lo, hi = V.min(0), V.max(0)
    nx = int((hi[0] - lo[0]) / cell) + 5
    nz = int((hi[2] - lo[2]) / cell) + 5
    vol = 0.0
    for y in np.arange(lo[1] + step / 2, hi[1], step):
        segs = slice_segments(V, F, np.array([0, y, 0.0]), np.array([0, 1.0, 0]))
        if len(segs) == 0:
            continue
        ln = np.linalg.norm(segs[:, 1] - segs[:, 0], axis=1)
        k = int(np.ceil(ln.max() / (cell * 0.5))) + 1
        t = np.linspace(0, 1, k)[None, :, None]
        pts = (segs[:, None, 0] * (1 - t) + segs[:, None, 1] * t).reshape(-1, 3)
        g = np.zeros((nx, nz), bool)
        g[((pts[:, 0] - lo[0]) / cell).astype(int) + 2, ((pts[:, 2] - lo[2]) / cell).astype(int) + 2] = True
        filled = ndimage.binary_fill_holes(g)
        # 边界格跨在表面上：最外一圈按一半计
        # boundary cells straddle the surface: count the outermost ring as half
        ring = filled & ~ndimage.binary_erosion(filled)
        vol += (filled.sum() - 0.5 * ring.sum()) * cell * cell * step
    return float(vol)


def surface_measures(V, F, J, levels=None, want_slices=False):
    """V 顶点（米），F 三角形；J 为关节中心字典（肩、肘、腕、髋、膝、踝，左右各一）。
    levels 可指定髂嵴高度（NHANES 腰围水平）。返回毫米值字典。
    V (n,3) metres, F (m,3); J: dict of joint centres with keys shoulder_L/R, elbow_L/R,
    wrist_L/R, hip_L/R, knee_L/R, ankle_L/R. `levels` may fix heights (m above floor) for
    'iliocristale' (NHANES waist level). Returns dict of mm values (+ slice polylines)."""
    V = np.asarray(V, float).copy()
    floor = V[:, 1].min()
    V[:, 1] -= floor
    J = {k: np.asarray(v, float) - [0, floor, 0] for k, v in J.items()}
    H = V[:, 1].max()
    out, slices = {}, {}
    xc = 0.5 * (J['hip_L'][0] + J['hip_R'][0])
    hipc = 0.5 * (J['hip_L'] + J['hip_R'])
    shc = 0.5 * (J['shoulder_L'] + J['shoulder_R'])

    def torso_ref(y):
        t = np.clip((y - hipc[1]) / (shc[1] - hipc[1]), -0.3, 1.3)
        p = hipc + t * (shc - hipc)
        return np.array([p[0], y, p[2]])

    def arm_x(side, y):
        """高度 y 处手臂轴线到正中面的距离（肩以上、腕以下返回 None）。
        |x - xc| of the arm axis at height y (None above the shoulder / below the wrist)."""
        s, e, w = J['shoulder_' + side], J['elbow_' + side], J['wrist_' + side]
        for a, b in ((s, e), (e, w)):
            if min(a[1], b[1]) <= y <= max(a[1], b[1]) and abs(a[1] - b[1]) > 1e-6:
                t = (y - a[1]) / (b[1] - a[1])
                return abs(a[0] + t * (b[0] - a[0]) - xc)
        return None

    out['stature'] = H * 1000
    vol = mesh_volume(V, F)
    out['volumeL'] = vol * 1000
    out['massKgFromVolume'] = vol * DENSITY
    out['bmiFromVolume'] = vol * DENSITY / H ** 2

    # ---- 先量上肢（分离手臂与躯干时要用到手臂半径）
    # ---- arms first (their radius is needed to separate arm from trunk)
    arm_r = {}
    for side in 'LR':
        s, e, w = J['shoulder_' + side], J['elbow_' + side], J['wrist_' + side]
        ax = (e - s) / np.linalg.norm(e - s)
        L = np.linalg.norm(e - s)
        # 腋窝较低时上臂仍与躯干相连：只取闭合、独立的轮廓；“中部”取最接近肩肘连线 55 % 处的一圈
        # The arm may still be joined to the trunk below a low axilla; only closed, free contours
        # count. "Mid" is the free contour nearest 55 % of the way from shoulder to elbow.
        free = []
        for t in np.linspace(0.35, 0.9, 23):
            o = s + t * (e - s)
            c = Cut(V, F, o, ax, keep=lambda m, o=o: np.linalg.norm(m - o, axis=1) < 0.5 * L)
            p = c.around(o)
            if p is None or len(p) < 12:
                continue
            r = np.linalg.norm(p - p.mean(0), axis=1)
            if r.max() < 1.6 * np.median(r):
                free.append((t, c.girth(p), p))
        if free:
            m = min(free, key=lambda g: abs(g[0] - 0.55))
            out['upperArmMidGirth_' + side] = m[1] * 1000
            out['upperArmMidGirthAt_' + side] = m[0]
            slices['upperArmMid_' + side] = m[2]
            out['upperArmMaxGirth_' + side] = max(g[1] for g in free) * 1000
        else:
            out['upperArmMidGirth_' + side] = out['upperArmMaxGirth_' + side] = float('nan')
        arm_r[side] = (np.nan_to_num(out['upperArmMidGirth_' + side], nan=300.0) / 1000) / (2 * np.pi)
        ax2 = (w - e) / np.linalg.norm(w - e)
        L2 = np.linalg.norm(w - e)
        gs = []
        for t in np.linspace(0.05, 1.0, 20):
            o = e + t * (w - e)
            c = Cut(V, F, o, ax2, keep=lambda m, o=o: np.linalg.norm(m - o, axis=1) < 0.4 * L2)
            p = c.around(o)
            gs.append((t, c.girth(p), p))
        fore = [g for g in gs if g[0] <= 0.5 and not np.isnan(g[1])]
        wr = [g for g in gs if g[0] >= 0.7 and not np.isnan(g[1])]
        if fore:
            m = max(fore, key=lambda g: g[1])
            out['forearmMaxGirth_' + side] = m[1] * 1000
            slices['forearmMax_' + side] = m[2]
        if wr:
            m = min(wr, key=lambda g: g[1])
            out['wristMinGirth_' + side] = m[1] * 1000
            slices['wrist_' + side] = m[2]

    def trunk(y, merge=True):
        """高度 y 处去掉手臂后的躯干轮廓。
        Trunk contour at height y with the arms removed."""
        c = hcut(V, F, y)
        ref = torso_ref(y)
        p = c.around(ref, merge=merge)
        if p is None:
            return c, None
        # 与躯干相连的手臂在腋前后襞处切开：即躯干中心与手臂轴线之间、轮廓前后最薄的位置
        # An arm still joined to the trunk (low axilla) is cut off at the axillary folds: the
        # place between trunk centre and arm axis where the contour is thinnest front-to-back.
        for side, sgn in (('L', 1), ('R', -1)):
            a = arm_x(side, y)
            if a is None:
                continue
            d = sgn * (p[:, 0] - xc)
            if d.max() < a - 0.3 * arm_r[side]:
                continue  # contour does not reach the arm: nothing attached
            edges = np.arange(0.45 * a, a + 1e-9, 0.003)
            zc = np.median(p[d > 0.45 * a, 2])
            depth = []
            for x0 in edges:
                m = (d >= x0 - 0.006) & (d < x0 + 0.006)
                fr, bk = p[m & (p[:, 2] > zc), 2], p[m & (p[:, 2] <= zc), 2]
                depth.append(fr.min() - bk.max() if len(fr) and len(bk) else np.inf)
            depth = np.array(depth)
            if np.isfinite(depth).any():
                cutx = edges[int(np.argmin(depth))]
                q = p[d < cutx]
                if len(q) > 10:
                    p = q
        return c, p

    # ---- 会阴高：正中矢状面上、髋关节轴之后的躯干最低点（避开前方外生殖器）
    # ---- crotch: lowest trunk point on the midsagittal plane at or behind the hip-joint axis
    #      (the perineum; external genitalia in front are excluded). Touching thighs do not matter.
    c = Cut(V, F, [xc, 0, 0], [1, 0, 0], keep=lambda m: (m[:, 1] > J['knee_L'][1]) & (m[:, 1] < hipc[1] + 0.05 * H))
    mp = c.segs.reshape(-1, 3)
    mp = mp[(mp[:, 2] < hipc[2] + 0.02) & (mp[:, 2] > hipc[2] - 0.06)] if len(mp) else mp
    crotch = float(mp[:, 1].min()) if len(mp) > 3 else hipc[1] - 0.06 * H
    out['crotchHeight'] = crotch * 1000

    # ---- 胸围：0.68 H 至 0.76 H 之间最向前突出的水平
    # ---- chest: level of greatest anterior protrusion between 0.68 H and 0.76 H
    best = None
    for y in np.arange(0.68 * H, 0.762 * H, 0.004):
        c, p = trunk(y)
        if p is None:
            continue
        z = p[:, 2].max()
        if best is None or z > best[0]:
            best = (z, y, c, p)
    if best:
        _, y, c, p = best
        out['chestHeight'] = y * 1000
        out['chestGirth'] = c.girth(p) * 1000
        out['chestBreadth'] = (p[:, 0].max() - p[:, 0].min()) * 1000
        out['chestDepth'] = (p[:, 2].max() - p[:, 2].min()) * 1000
        slices['chest'] = p
        # 下胸围：胸围水平稍下方的最小围度
        # under-bust girth: 6 % of stature... reported as the smallest girth just below the chest level
        ub = []
        for yy in np.arange(y - 0.075 * H, y - 0.02 * H, 0.004):
            c2, p2 = trunk(yy)
            if p2 is not None:
                ub.append((c2.girth(p2), yy, p2))
        if ub:
            m = min(ub, key=lambda g: g[0])
            out['underbustGirth'] = m[0] * 1000

    # ---- 腰围：脐水平按 ANSUR 比例取 0.601 H（男女相同）；自然腰围取最小值
    # ---- waist: navel level by the ANSUR ratio (0.601 H in both sexes), natural waist = minimum
    def waist_at(y, tag):
        c, p = trunk(y)
        if p is None:
            return
        out[tag + 'Girth'] = c.girth(p) * 1000
        out[tag + 'Breadth'] = (p[:, 0].max() - p[:, 0].min()) * 1000
        out[tag + 'Depth'] = (p[:, 2].max() - p[:, 2].min()) * 1000
        out[tag + 'Height'] = y * 1000
        slices[tag] = p

    waist_at(0.601 * H, 'waistNavel')
    # NHANES 腰围在髂嵴上缘；没有骨骼时取 ANSUR 的平均比例 0.608 x 身高
    # NHANES waist is taken just above the iliac crest; without bones use the ANSUR mean ratio
    # (iliocristale height = 0.611 H in women, 0.605 H in men)
    waist_at((levels['iliocristale'] if levels and 'iliocristale' in levels else 0.608 * H) + 0.005, 'waistIliac')
    out['waistIliacFromBone'] = 1.0 if levels and 'iliocristale' in levels else 0.0
    cand = []
    for y in np.arange(0.585 * H, 0.70 * H, 0.004):
        c, p = trunk(y)
        if p is not None:
            cand.append((c.girth(p), y, p))
    if cand:
        m = min(cand, key=lambda g: g[0])
        out['waistMinGirth'] = m[0] * 1000
        out['waistMinHeight'] = m[1] * 1000
        slices['waistMin'] = m[2]

    # ---- 臀围：会阴至会阴以上 0.14 H 之间最向后突出的水平
    # ---- buttock / hip: greatest posterior protrusion between crotch and crotch + 0.14 H
    best, widest = None, None
    for y in np.arange(crotch - 0.02 * H, crotch + 0.16 * H, 0.004):
        c, p = trunk(y)
        if p is None:
            continue
        if y >= crotch:
            z = p[:, 2].min()
            if best is None or z < best[0]:
                best = (z, y, c, p)
        # 臀宽只在会阴以上 2 % 身高处起算：两腿分开站立时大腿上段会向外移
        # hip breadth only from 2 % of stature above the crotch: with the feet apart the upper
        # thighs move outwards and would inflate it
        b = p[:, 0].max() - p[:, 0].min()
        if y >= crotch + 0.02 * H and (widest is None or b > widest[0]):
            widest = (b, y)
    if best:
        _, y, c, p = best
        out['buttockHeight'] = y * 1000
        out['buttockGirth'] = c.girth(p) * 1000
        out['buttockDepth'] = (p[:, 2].max() - p[:, 2].min()) * 1000
        slices['buttock'] = p
    if widest:
        out['hipBreadth'] = widest[0] * 1000
        out['hipBreadthHeight'] = widest[1] * 1000
    # ---- 下肢
    # ---- legs
    for side, sgn in (('L', 1), ('R', -1)):
        hp, kn, an = J['hip_' + side], J['knee_' + side], J['ankle_' + side]

        def leg(y, hp=hp, kn=kn, an=an, sgn=sgn):
            c = hcut(V, F, y, keep=lambda m: sgn * (m[:, 0] - xc) > 0)
            if y >= kn[1]:
                t = (y - kn[1]) / (hp[1] - kn[1])
                ref = kn + t * (hp - kn)
            else:
                t = (y - an[1]) / (kn[1] - an[1])
                ref = an + t * (kn - an)
            p = c.around(np.array([ref[0], y, ref[2]]))
            return c.girth(p), p

        g, p = leg(crotch - 0.015 * H)
        out['thighProximalGirth_' + side] = g * 1000
        slices['thighProximal_' + side] = p
        g, p = leg(0.5 * (hp[1] + kn[1]) + 0.012 * H)
        out['thighMidGirth_' + side] = g * 1000
        slices['thighMid_' + side] = p
        g, p = leg(kn[1] + 0.03 * H)
        out['thighLowerGirth_' + side] = g * 1000
        gs = [(leg(y), y) for y in np.arange(an[1] + 0.02 * H, kn[1] - 0.02 * H, 0.005)]
        gs = [((g, p), y) for (g, p), y in gs if not np.isnan(g)]
        if gs:
            (g, p), y = max(gs, key=lambda k: k[0][0])
            out['calfMaxGirth_' + side] = g * 1000
            out['calfHeight_' + side] = y * 1000
            slices['calf_' + side] = p
            low = [k for k in gs if k[1] < an[1] + 0.09 * H]
            if low:
                (g, p), y = min(low, key=lambda k: k[0][0])
                out['ankleMinGirth_' + side] = g * 1000
                slices['ankle_' + side] = p
        foot = V[(sgn * (V[:, 0] - xc) > 0) & (V[:, 1] < an[1] * 0.9)]
        if len(foot) > 20:
            h2 = foot[:, [0, 2]] - foot[:, [0, 2]].mean(0)
            _, _, vt = np.linalg.svd(h2, full_matrices=False)
            a = h2 @ vt[0]
            b = h2 @ vt[1]
            out['footLength_' + side] = (a.max() - a.min()) * 1000
            out['footBreadth_' + side] = (b.max() - b.min()) * 1000

    # ---- 颈围：肩关节中心以上 2.5 %–9 % 身高范围内最小的水平围度
    # ---- neck: smallest horizontal girth 2.5 %-9 % of stature above the shoulder-joint centres
    cand = []
    ncx = shc.copy()
    for y in np.arange(shc[1] + 0.025 * H, shc[1] + 0.09 * H, 0.003):
        c = hcut(V, F, y)
        allp = c.segs.reshape(-1, 3)
        if len(allp) < 10:
            continue
        ref = np.array([xc, y, np.median(allp[np.abs(allp[:, 0] - xc) < 0.03][:, 2]) if (np.abs(allp[:, 0] - xc) < 0.03).any() else ncx[2]])
        p = c.around(ref)
        g = c.girth(p)
        if not np.isnan(g) and (p[:, 0].max() - p[:, 0].min()) < 0.2:
            cand.append((g, y, p))
    if cand:
        m = min(cand, key=lambda g: g[0])
        out['neckMinGirth'] = m[0] * 1000
        out['neckHeight'] = m[1] * 1000
        slices['neck'] = m[2]

    # ---- 最大肩宽（受上臂外展影响而偏大，仅供参考）
    # ---- shoulders (inflated by arm abduction; reported for completeness)
    ys = np.arange(shc[1] - 0.09 * H, shc[1] + 0.02 * H, 0.004)
    bd = 0
    for y in ys:
        c = hcut(V, F, y)
        p = c.segs.reshape(-1, 3)
        if len(p):
            bd = max(bd, p[:, 0].max() - p[:, 0].min())
    out['bideltoidBreadthAsPosed'] = bd * 1000

    for k in list(out):
        if k.endswith('_L') and k[:-2] + '_R' in out:
            out[k[:-2]] = 0.5 * (out[k] + out[k[:-2] + '_R'])
    if want_slices:
        return out, {k: (v + [0, floor, 0]) for k, v in slices.items() if v is not None}
    return out


# ------------------------------------------------------------------ 骨性标志（我们的人体）
# ------------------------------------------------------------------ bone landmarks (our bodies)

def _axis_param(v):
    c = v.mean(0)
    _, _, vt = np.linalg.svd(v - c, full_matrices=False)
    ax = vt[0]
    if ax[1] < 0:
        ax = -ax
    t = (v - c) @ ax
    return c, ax, (t - t.min()) / (t.max() - t.min())


def bone_landmarks(b):
    """由我们某一个人体的骨骼得到的标志点（米，人体坐标系）。
    Landmarks (metres, body frame) from the bones of one of our bodies."""
    L = {}
    skin = b.skin()[0]
    floor = skin[:, 1].min()
    L['floor'] = np.array([0, floor, 0])
    L['vertex'] = skin[np.argmax(skin[:, 1])]
    c7 = b.verts('Seventh cervical vertebra')
    L['cervicale'] = c7[np.argmin(c7[:, 2])]
    man = b.verts('Manubrium')
    mid = man[np.abs(man[:, 0] - man[:, 0].mean()) < 0.006]
    L['suprasternale'] = mid[np.argmax(mid[:, 1])]
    sac = b.verts('Sacrum')
    xmid = sac[:, 0].mean()
    for side, sgn in (('L', 1), ('R', -1)):
        nm = 'Left ' if side == 'L' else 'Right '
        sc = b.verts(nm + 'scapula')
        L['acromion_' + side] = sc[np.argmax(sgn * sc[:, 0])]
        hip = b.verts(nm + 'hip bone')
        L['iliocristale_' + side] = hip[np.argmax(hip[:, 1])]
        L['iliacLateral_' + side] = hip[np.argmax(sgn * hip[:, 0])]
        L['ischialTuberosity_' + side] = hip[np.argmin(hip[:, 1])]
        top = hip[hip[:, 1] > hip[:, 1].max() - 0.06]
        L['asisApprox_' + side] = top[np.argmax(top[:, 2])]
        fe = b.verts(nm + 'femur')
        c, ax, t = _axis_param(fe)
        prox = fe[t > 0.80]
        L['trochanterLateral_' + side] = prox[np.argmax(sgn * prox[:, 0])]
        lat = prox[sgn * (prox[:, 0] - L['trochanterLateral_' + side][0]) > -0.025]
        L['trochanterion_' + side] = lat[np.argmax(lat[:, 1])]
        med = prox[sgn * (prox[:, 0] - L['trochanterLateral_' + side][0]) < -0.045]
        if len(med) < 5:
            med = prox
        # 股骨头中心：对近端内侧部分做球拟合
        # femoral head centre: sphere fit to the medial proximal part
        A = np.c_[2 * med, np.ones(len(med))]
        sol, *_ = np.linalg.lstsq(A, (med ** 2).sum(1), rcond=None)
        L['hip_' + side] = sol[:3]
        L['femoralHeadRadius_' + side] = np.array([np.sqrt(max(sol[3] + sol[:3] @ sol[:3], 0)), 0, 0])
        dist = fe[t < 0.10]
        L['femoralEpicondyleLateral_' + side] = dist[np.argmax(sgn * dist[:, 0])]
        L['femoralEpicondyleMedial_' + side] = dist[np.argmin(sgn * dist[:, 0])]
        L['knee_' + side] = 0.5 * (L['femoralEpicondyleLateral_' + side] + L['femoralEpicondyleMedial_' + side])
        L['femurTop_' + side] = fe[np.argmax(fe[:, 1])]
        L['femurBottom_' + side] = fe[np.argmin(fe[:, 1])]
        ti = b.verts(nm + 'tibia')
        c, ax, t = _axis_param(ti)
        pt = ti[t > 0.9]
        medp = pt[sgn * (pt[:, 0] - pt[:, 0].mean()) < 0]
        L['tibiale_' + side] = medp[np.argmax(medp[:, 1])]
        L['tibiaTop_' + side] = ti[np.argmax(ti[:, 1])]
        L['medialMalleolus_' + side] = ti[np.argmin(ti[:, 1])]
        fi = b.verts(nm + 'fibula')
        c, ax, t = _axis_param(fi)
        dl = fi[t < 0.12]
        L['lateralMalleolus_' + side] = dl[np.argmax(sgn * dl[:, 0])]
        L['fibulaTip_' + side] = fi[np.argmin(fi[:, 1])]
        L['ankle_' + side] = 0.5 * (L['lateralMalleolus_' + side] + L['medialMalleolus_' + side])
        pa = b.verts(nm + 'patella')
        L['patella_' + side] = pa.mean(0)
        hu = b.verts(nm + 'humerus')
        c, ax, t = _axis_param(hu)
        ph = hu[t > 0.86]
        A = np.c_[2 * ph, np.ones(len(ph))]
        sol, *_ = np.linalg.lstsq(A, (ph ** 2).sum(1), rcond=None)
        ctr = sol[:3]
        if np.linalg.norm(ctr - ph.mean(0)) > 0.03:
            ctr = ph.mean(0)
        L['shoulder_' + side] = ctr
        dh = hu[t < 0.08]
        # 内外上髁：远端最宽方向上的两个极点
        # epicondyles: extremes across the widest horizontal direction of the distal end
        d2 = dh - dh.mean(0)
        _, _, vt = np.linalg.svd(d2 - np.outer(d2 @ ax, ax), full_matrices=False)
        w = d2 @ vt[0]
        L['elbow_' + side] = 0.5 * (dh[np.argmax(w)] + dh[np.argmin(w)])
        L['humerusTop_' + side] = hu[np.argmax(t)]
        L['humerusBottom_' + side] = hu[np.argmin(t)]
        ra = b.verts(nm + 'radius')
        c, ax, t = _axis_param(ra)
        head = ra[t > 0.93]
        # 桡骨点：桡骨头外侧（远离尺骨一侧）的最高点
        # radiale: highest point of the radial head on its lateral (away from the ulna) side
        ul = b.verts(nm + 'ulna')
        away = head.mean(0) - ul[np.argsort(np.linalg.norm(ul - head.mean(0), axis=1))[:20]].mean(0)
        away /= np.linalg.norm(away)
        sc_ = (head - head.mean(0)) @ away
        cand = head[sc_ > np.percentile(sc_, 50)]
        L['radiale_' + side] = cand[np.argmax((cand - c) @ ax)]
        L['stylion_' + side] = ra[np.argmin(t)]
        cu, axu, tu = _axis_param(ul)
        L['ulnarStyloid_' + side] = ul[np.argmin(tu)]
        L['olecranon_' + side] = ul[np.argmax(tu)]
        L['wrist_' + side] = 0.5 * (L['stylion_' + side] + L['ulnarStyloid_' + side])
        try:
            dp = b.verts('Distal phalanx of ' + nm.lower() + 'middle finger')
            hand_ax = dp.mean(0) - L['wrist_' + side]
            hand_ax /= np.linalg.norm(hand_ax)
            L['dactylionBone_' + side] = dp[np.argmax((dp - L['wrist_' + side]) @ hand_ax)]
            near = skin[np.linalg.norm(skin - dp.mean(0), axis=1) < 0.03]
            L['dactylionSkin_' + side] = near[np.argmax((near - L['wrist_' + side]) @ hand_ax)]
        except KeyError:
            pass
    return L


def skeletal_measures(L):
    """按 ANSUR 定义、由骨性标志点算出的高度和长度（毫米）。骨面上的点比皮肤上的标记点深 3–10 mm。
    ANSUR-style heights and lengths (mm) from bone_landmarks. Bony points, so 3-10 mm inside
    the skin marks ANSUR measures to; see REPORT.md."""
    f = L['floor'][1]
    mm = lambda x: float(x) * 1000
    h = lambda k: mm(L[k][1] - f)
    avg = lambda k, fn=None: 0.5 * ((fn or h)(k + '_L') + (fn or h)(k + '_R'))
    d = lambda a, b: mm(np.linalg.norm(L[a] - L[b]))
    o = {}
    o['stature'] = h('vertex')
    o['cervicaleheight'] = h('cervicale')
    o['suprasternaleheight'] = h('suprasternale')
    o['acromialheight'] = avg('acromion')
    o['iliocristaleheight'] = avg('iliocristale')
    o['trochanterionheight'] = avg('trochanterion')
    o['tibialheight'] = avg('tibiale')
    o['lateralfemoralepicondyleheight'] = avg('femoralEpicondyleLateral')
    o['kneeheightmidpatella'] = avg('patella')
    o['lateralmalleolusheight'] = avg('lateralMalleolus')
    o['acromionradialelength'] = 0.5 * (d('acromion_L', 'radiale_L') + d('acromion_R', 'radiale_R'))
    o['radialestylionlength'] = 0.5 * (d('radiale_L', 'stylion_L') + d('radiale_R', 'stylion_R'))
    o['wristheight'] = avg('stylion')
    o['biacromialbreadth'] = d('acromion_L', 'acromion_R')
    o['bicristalbreadth'] = mm(L['iliacLateral_L'][0] - L['iliacLateral_R'][0])
    o['bitrochantericBreadthBone'] = mm(L['trochanterLateral_L'][0] - L['trochanterLateral_R'][0])
    o['hipJointSeparation'] = d('hip_L', 'hip_R')
    o['vertexToIschium'] = mm(L['vertex'][1] - 0.5 * (L['ischialTuberosity_L'][1] + L['ischialTuberosity_R'][1]))
    if 'dactylionSkin_L' in L:
        o['handlength'] = 0.5 * (d('wrist_L', 'dactylionSkin_L') + d('wrist_R', 'dactylionSkin_R'))
    o['femurLength'] = 0.5 * (d('femurTop_L', 'femurBottom_L') + d('femurTop_R', 'femurBottom_R'))
    o['tibiaLength'] = 0.5 * (d('tibiaTop_L', 'medialMalleolus_L') + d('tibiaTop_R', 'medialMalleolus_R'))
    o['humerusLength'] = 0.5 * (d('humerusTop_L', 'humerusBottom_L') + d('humerusTop_R', 'humerusBottom_R'))
    o['radiusLength'] = o['radialestylionlength']
    # 上臂外展角：肩->肘方向与竖直向下的夹角（冠状面内）
    # arm abduction: angle of shoulder->elbow from the downward vertical, in the frontal plane
    ang = []
    for s, sg in (('L', 1), ('R', -1)):
        v = L['elbow_' + s] - L['shoulder_' + s]
        ang.append(np.degrees(np.arctan2(sg * v[0], -v[1])))
        v2 = L['wrist_' + s] - L['elbow_' + s]
        o['forearmAbductionDeg_' + s] = float(np.degrees(np.arctan2(sg * v2[0], -v2[1])))
        o['upperArmFlexionDeg_' + s] = float(np.degrees(np.arctan2(v[2], -v[1])))
        o['forearmFlexionDeg_' + s] = float(np.degrees(np.arctan2(v2[2], -v2[1])))
    o['upperArmAbductionDeg_L'], o['upperArmAbductionDeg_R'] = float(ang[0]), float(ang[1])
    return o


JOINT_KEYS = [a + '_' + s for a in ('shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle') for s in 'LR']


def measure_body(name, preview=True):
    b = Body(name)
    L = bone_landmarks(b)
    V, F = b.skin()
    J = {k: L[k] for k in JOINT_KEYS}
    ilio = 0.5 * (L['iliocristale_L'][1] + L['iliocristale_R'][1]) - L['floor'][1]
    surf, sl = surface_measures(V, F, J, levels={'iliocristale': ilio}, want_slices=True)
    sk = skeletal_measures(L)
    res = {'body': name, 'surface': surf, 'skeletal': sk,
           'landmarks': {k: [round(float(x), 5) for x in v] for k, v in L.items()}}
    os.makedirs(os.path.join(RAW, 'out'), exist_ok=True)
    json.dump(res, open(os.path.join(RAW, 'out', f'measure-{name}.json'), 'w'), indent=1)
    if preview:
        preview_slices(V, F, sl, os.path.join(RAW, 'out', 'preview', f'{name}-slices.png'), L)
    return res


def preview_slices(V, F, sl, path, L=None):
    """浅色皮肤轮廓上叠画测量截面（和标志点）。
    Skin as a pale silhouette with the measured contours (and landmarks) drawn over it."""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, axs = plt.subplots(1, 2, figsize=(9, 11))
    for ax, (i, j, ttl) in zip(axs, ((0, 1, 'front (x, y)'), (2, 1, 'left side (z, y)'))):
        ax.plot(V[::3, i], V[::3, j], '.', ms=0.4, color='#d9c3b0')
        for k, p in sl.items():
            ax.plot(p[:, i], p[:, j], '.', ms=0.8, color='#1f6fb4')
        if L:
            for k, p in L.items():
                if k in ('floor',) or k.startswith('femoralHeadRadius'):
                    continue
                ax.plot(p[i], p[j], '+', ms=5, color='#c0392b')
        ax.set_aspect('equal')
        ax.set_title(ttl)
    fig.tight_layout()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fig.savefig(path, dpi=90)
    plt.close(fig)


if __name__ == '__main__':
    for n in sys.argv[1:]:
        r = measure_body(n)
        print('==', n)
        for grp in ('skeletal', 'surface'):
            for k, v in r[grp].items():
                if not k.endswith(('_L', '_R')) or 'Deg' in k:
                    print(f'  {grp[:4]} {k:34s} {v:8.1f}')
