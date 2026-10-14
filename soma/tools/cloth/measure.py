"""由皮肤网格量出 GarmentCode 需要的人体尺寸（厘米、度），写到 data/curated/cloth/bodies/<body>.json。
Measures the body dimensions GarmentCode needs (cm, degrees) from the skin mesh and writes them to
data/curated/cloth/bodies/<body>.json.

围度、身高、胸 / 腰 / 臀水平沿用 tools/bodyshape/measure.py 的 surface_measures（同一套定义，
和 data/curated/bodyshape 的表可以直接比较）；GarmentCode 特有的几项（背宽、乳点距、袖窿深、
肩斜、臂长、胸高线……）按它的文档 docs/Body Measurements GarmentCode.pdf 的定义在这里补量。
Girths, stature and the chest / waist / hip levels come from surface_measures in
tools/bodyshape/measure.py (one set of definitions, directly comparable with the tables in
data/curated/bodyshape); the measurements particular to GarmentCode (back widths, bust-point
distance, armscye depth, shoulder slope, arm length, bust lines…) are added here by the definitions
of its documentation, docs/Body Measurements GarmentCode.pdf.

先运行 / first run:  bun tools/cloth/export-skin.ts
然后 / then:         <venv>/bin/python -I tools/cloth/measure.py male female
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SOMA = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(SOMA, 'tools', 'bodyshape'))
from bodylib import hull_perimeter, slice_segments  # noqa: E402
from measure import hcut, surface_measures  # noqa: E402

WORK = os.path.join(SOMA, 'data', 'raw', 'cloth', 'work')
OUT = os.path.join(SOMA, 'data', 'curated', 'cloth', 'bodies')


def hull2(p):
    """二维点的凸包（逆时针顶点）/ Convex hull of 2-D points (counter-clockwise vertices)."""
    from scipy.spatial import ConvexHull
    return p[ConvexHull(p).vertices]


def arc_between(h, i, j, through):
    """凸包上从顶点 i 走到 j、经过谓词 through 为真的一侧的弧长。
    Arc length on a hull from vertex i to j along the side where `through` holds."""
    n = len(h)
    best = None
    for step in (1, -1):
        k, length, ok = i, 0.0, False
        while k != j:
            k2 = (k + step) % n
            length += float(np.linalg.norm(h[k2] - h[k]))
            if k2 != j and through(h[k2]):
                ok = True
            k = k2
        if ok:
            best = length
    return best


def back_arc(contour, zc):
    """“平衡线”之间的后半围：横截面凸包上最左、最右两点之间经过身后的弧长。
    The back section between the balance lines: arc on the cross-section hull from the leftmost to the
    rightmost point, through the back."""
    h = hull2(contour[:, [0, 2]])
    i, j = int(np.argmin(h[:, 0])), int(np.argmax(h[:, 0]))
    return arc_between(h, i, j, lambda q: q[1] < zc)


def front_path(V, F, x, y_top, y_bottom, z_mid):
    """矢状面（x = 常数）截面在 y_top 与 y_bottom 之间的前侧凸包长度：像软尺一样跨过凹处。
    Length of the front side of a sagittal (x = const) section between y_top and y_bottom, on its
    convex hull: a tape bridging the hollows."""
    segs = slice_segments(V, F, np.array([x, 0, 0]), np.array([1.0, 0, 0]))
    p = segs.reshape(-1, 3)
    p = p[(p[:, 1] <= y_top) & (p[:, 1] >= y_bottom) & (p[:, 2] > z_mid)]
    if len(p) < 3:
        return None
    # 每个高度取最前的点，再取上包络的凸包 / the most anterior point per height, then the hull of that profile
    ys = np.arange(y_bottom, y_top + 1e-9, 0.002)
    prof = []
    for y in ys:
        m = np.abs(p[:, 1] - y) < 0.003
        if m.any():
            prof.append([p[m, 2].max(), y])
    prof = np.array(prof)
    # 前侧上凸包（z 方向）/ the upper hull on the anterior side (in z)
    hull = []
    for q in prof:
        while len(hull) >= 2:
            a, b = np.array(hull[-2]), np.array(hull[-1])
            if (b[1] - a[1]) * (q[0] - a[0]) - (b[0] - a[0]) * (q[1] - a[1]) >= 0:
                hull.pop()
            else:
                break
        hull.append(list(q))
    hull = np.array(hull)
    return float(np.linalg.norm(np.diff(hull, axis=0), axis=1).sum())


def trunk_contour(V, F, J, xc, y):
    """高度 y 处的躯干轮廓，贴着躯干的手臂在腋前后襞处切掉（做法同 tools/bodyshape/measure.py 的 trunk）。
    The trunk contour at height y, an arm lying against the trunk cut off at the axillary folds (as trunk()
    in tools/bodyshape/measure.py does)."""
    c = hcut(V, F, y)
    hipc = 0.5 * (J['hip_L'] + J['hip_R'])
    shc = 0.5 * (J['shoulder_L'] + J['shoulder_R'])
    t = np.clip((y - hipc[1]) / (shc[1] - hipc[1]), -0.3, 1.3)
    ref = hipc + t * (shc - hipc)
    p = c.around(np.array([ref[0], y, ref[2]]), merge=True)
    if p is None:
        return c, None
    for side, sgn in (('L', 1), ('R', -1)):
        s_, e_ = J['shoulder_' + side], J['elbow_' + side]
        if not (e_[1] <= y <= s_[1]):
            continue
        a = abs(s_[0] + (y - s_[1]) / (e_[1] - s_[1]) * (e_[0] - s_[0]) - xc)
        d = sgn * (p[:, 0] - xc)
        if d.max() < 0.8 * a:
            continue
        edges = np.arange(0.45 * a, a + 1e-9, 0.003)
        zc = np.median(p[d > 0.45 * a, 2])
        depth = []
        for x0 in edges:
            m = (d >= x0 - 0.006) & (d < x0 + 0.006)
            fr, bk = p[m & (p[:, 2] > zc), 2], p[m & (p[:, 2] <= zc), 2]
            depth.append(fr.min() - bk.max() if len(fr) and len(bk) else np.inf)
        depth = np.array(depth)
        if np.isfinite(depth).any():
            q = p[d < edges[int(np.argmin(depth))]]
            if len(q) > 10:
                p = q
    return c, p


def measure(name):
    d = os.path.join(WORK, name)
    V = np.fromfile(os.path.join(d, 'skin.f32'), dtype=np.float32).reshape(-1, 3).astype(np.float64)
    F = np.fromfile(os.path.join(d, 'skin.u32'), dtype=np.uint32).reshape(-1, 3).astype(np.int64)
    J0 = {k: np.array(v, float) for k, v in json.load(open(os.path.join(d, 'joints.json'))).items()}
    s, sl = surface_measures(V, F, J0, want_slices=True)
    floor = V[:, 1].min()
    V = V.copy()
    V[:, 1] -= floor
    J = {k: v - [0, floor, 0] for k, v in J0.items()}
    H = s['stature'] / 1000
    xc = 0.5 * (J['hip_L'][0] + J['hip_R'][0])
    for k in sl:
        if isinstance(sl[k], np.ndarray) and sl[k].ndim == 2 and sl[k].shape[1] == 3:
            sl[k] = sl[k] - [0, floor, 0]

    waist, butt = sl['waistMin'], sl['buttock']
    waist_y, butt_y = s['waistMinHeight'] / 1000, s['buttockHeight'] / 1000
    cervicale = J['C7'][1]

    # 乳点：胸围截面上中线两侧最向前的点 / bust points: the most anterior chest-contour point on either side of the midline
    def peak(p, side, sign):
        q = p[(p[:, 0] - xc) * side > 0.02]
        return q[np.argmax(sign * q[:, 2])]
    bum_L, bum_R = peak(butt, 1, -1), peak(butt, -1, -1)

    # 腋窝：从盂肱关节往下，手臂与躯干在水平截面里分开的最高处
    # armpit: going down from the glenohumeral joint, the highest level where arm and trunk come apart in a horizontal cut
    def separated(y, side):
        segs = slice_segments(V, F, np.array([0, y, 0]), np.array([0, 1.0, 0]))
        if not len(segs):
            return False
        # 躯干分量：从正中线向外，沿 x 方向轮廓是否连续到手臂 / is the contour continuous in x from the midline out to the arm
        sh, el = J['shoulder_' + side], J['elbow_' + side]
        t = (y - sh[1]) / (el[1] - sh[1])
        ax = sh[0] + t * (el[0] - sh[0]) - xc
        sgn = 1 if side == 'L' else -1
        m = segs.mean(1)
        dx = sgn * (m[:, 0] - xc)
        # 在躯干和手臂轴线之间，找一条没有轮廓穿过的竖带 / a gap strip between trunk and arm axis with no contour
        xs = np.sort(dx[(dx > 0.3 * ax) & (dx < ax)])
        return len(xs) > 1 and np.diff(xs).max() > 0.004
    armpit = {}
    for side in 'LR':
        y = J['shoulder_' + side][1]
        while y > J['elbow_' + side][1] and not separated(y, side):
            y -= 0.002
        armpit[side] = y
    armpit_y = 0.5 * (armpit['L'] + armpit['R'])

    # 肩端：肩峰上方的皮肤最高点 / shoulder end: the highest skin point above the acromion
    def skin_top(x, z, r=0.012):
        m = (np.abs(V[:, 0] - x) < r) & (np.abs(V[:, 2] - z) < 0.05)
        return V[m, 1].max() if m.any() else None
    sh_half = 0.5 * abs(J['shoulder_L'][0] - J['shoulder_R'][0]) + 0.02
    acro_y = 0.5 * (skin_top(xc + sh_half - 0.01, J['ac_L'][2]) + skin_top(xc - sh_half + 0.01, J['ac_R'][2]))

    # 颈根：颈最细截面往下、横截面迅速变宽之前 / neck base: below the slimmest neck cut, before the cross-section widens fast
    neck = sl['neck']
    neck_half = 0.5 * (neck[:, 0].max() - neck[:, 0].min())
    neck_zc = 0.5 * (neck[:, 2].max() + neck[:, 2].min())

    # 肩斜：斜方肌上缘从颈侧到肩端的斜率 / shoulder slope: the upper trapezius edge from the side of the neck to the shoulder end
    xs = np.linspace(neck_half + 0.015, sh_half - 0.015, 9)
    prof = []
    for side in (1, -1):
        for x in xs:
            m = (np.abs(V[:, 0] - (xc + side * x)) < 0.006) & (np.abs(V[:, 2] - neck_zc) < 0.06) & (V[:, 1] < cervicale + 0.03) & (V[:, 1] > armpit_y)
            if m.any():
                prof.append([x, V[m, 1].max()])
    prof = np.array(prof)
    slope = -np.polyfit(prof[:, 0], prof[:, 1], 1)[0]
    shoulder_incl = math.degrees(math.atan(slope))
    snp_y = float(np.polyval(np.polyfit(prof[:, 0], prof[:, 1], 1), neck_half))

    # 手臂姿势：上臂（盂肱 → 肘）与水平面的夹角 / arm pose: upper arm (glenohumeral → elbow) against the horizontal
    def arm_angle(side):
        a = J['elbow_' + side] - J['shoulder_' + side]
        return math.degrees(math.atan2(-a[1], abs(a[0])))
    arm_pose = 0.5 * (arm_angle('L') + arm_angle('R'))
    arm_len = np.mean([np.linalg.norm(J['wrist_' + s_] - (J['ac_' + s_] + [0, acro_y - J['ac_' + s_][1], 0])) for s_ in 'LR'])

    # 胸围水平：肩端下 8–20 cm 内躯干最向前突出处（surface_measures 的 0.68–0.76 H 窗口在男体上会落到上腹）；
    # 下胸围：其下 3–12 cm 内的最小围度
    # bust level: the most anterior trunk point 8–20 cm below the shoulder end (surface_measures' 0.68–0.76 H window
    # lands on the upper belly of the male body); underbust: the smallest girth 3–12 cm below it
    best = None
    for y in np.arange(acro_y - 0.20, acro_y - 0.08, 0.003):
        c, p = trunk_contour(V, F, J, xc, y)
        if p is not None and (best is None or p[:, 2].max() > best[0]):
            best = (p[:, 2].max(), y, c.girth(p), p)
    _, chest_y, bust_girth, chest = best
    ub = min(((c.girth(p), y, p) for y in np.arange(chest_y - 0.12, chest_y - 0.03, 0.003)
              for c, p in [trunk_contour(V, F, J, xc, y)] if p is not None), key=lambda g: g[0])
    # 胸围水平上手臂贴着躯干，“平衡线”不好定：后半围的比例取下胸围截面（手臂已分开）的
    # at the bust level the arms lie against the trunk and the balance lines are ill-defined: the back share is
    # taken from the underbust section, where the arms are free
    back_share = back_arc(ub[2], 0.5 * (ub[2][:, 2].max() + ub[2][:, 2].min())) / ub[0]
    bpL, bpR = peak(chest, 1, 1), peak(chest, -1, 1)

    zc_chest = 0.5 * (chest[:, 2].max() + chest[:, 2].min())
    zc_waist = 0.5 * (waist[:, 2].max() + waist[:, 2].min())
    zc_butt = 0.5 * (butt[:, 2].max() + butt[:, 2].min())
    bp_x = 0.5 * (abs(bpL[0] - xc) + abs(bpR[0] - xc))
    wob = np.mean([front_path(V, F, xc + sg * bp_x, snp_y, waist_y, zc_waist) for sg in (1, -1)])
    bl = np.mean([front_path(V, F, xc + sg * bp_x, snp_y, chest_y, zc_chest) for sg in (1, -1)])

    cm = 100.0
    gc = {
        'height': H * cm,
        'head_l': (H - cervicale) * cm,
        'neck_w': back_arc(neck, neck_zc) * cm,
        'shoulder_w': 2 * sh_half * cm,
        'shoulder_incl': shoulder_incl,
        'armscye_depth': (acro_y - armpit_y) * cm,
        'arm_length': arm_len * cm,
        'arm_pose_angle': arm_pose,
        'wrist': s['wristMinGirth'] / 10,
        'bust': bust_girth * cm,
        'underbust': ub[0] * cm,
        # 男体胸廓前面没有明显的两个峰：取胸围的 0.18（假定值，约为 GarmentCode 平均男体的比例）
        # the male chest has no two distinct peaks in front: 0.18 of the bust girth (assumed, about the ratio of GarmentCode's mean male)
        'bust_points': (abs(bpL[0] - bpR[0]) if name == 'female' else 0.18 * bust_girth) * cm,
        'bust_line': bl * cm,
        'vert_bust_line': (cervicale - chest_y) * cm,
        'back_width': back_share * bust_girth * cm,
        'waist': s['waistMinGirth'] / 10,
        'waist_back_width': back_arc(waist, zc_waist) * cm,
        'waist_line': (cervicale - waist_y) * cm,
        'waist_over_bust_line': wob * cm,
        'hips': s['buttockGirth'] / 10,
        'hip_back_width': back_arc(butt, zc_butt) * cm,
        'hips_line': (waist_y - butt_y) * cm,
        'bum_points': abs(bum_L[0] - bum_R[0]) * cm,
        'hip_inclination': math.degrees(math.atan2(0.5 * (np.ptp(butt[:, 0]) - np.ptp(waist[:, 0])), waist_y - butt_y)),
        'crotch_hip_diff': (butt_y - s['crotchHeight'] / 1000) * cm,
        'leg_circ': s['thighProximalGirth'] / 10,
    }
    gc = {k: round(float(v), 2) for k, v in gc.items()}
    levels = {
        'floorY': round(float(floor), 4),
        'armpitY': round(float(armpit_y + floor), 4),
        'acromionTopY': round(float(acro_y + floor), 4),
        'sideNeckY': round(float(snp_y + floor), 4),
        'chestY': round(float(chest_y + floor), 4),
        'waistY': round(float(waist_y + floor), 4),
        'hipY': round(float(butt_y + floor), 4),
        'crotchY': round(float(s['crotchHeight'] / 1000 + floor), 4),
    }
    return gc, levels, s


def compare(name, gc):
    """和 data/curated/bodyshape/our-bodies.json（tools/bodyshape 量的）对照。
    Comparison with data/curated/bodyshape/our-bodies.json (measured by tools/bodyshape)."""
    ref = json.load(open(os.path.join(SOMA, 'data', 'curated', 'bodyshape', 'our-bodies.json')))['bodies'][name]
    surf = {m['measure']: m['valueMm'] for m in ref['surface']}
    pairs = [('height', ref['statureMm']), ('bust', surf.get('chestGirth')), ('hips', surf.get('buttockGirth')),
             ('leg_circ', surf.get('thighProximalGirth')), ('wrist', surf.get('wristMinGirth'))]
    return [{'measure': k, 'oursCm': gc[k], 'curatedCm': round(v / 10, 2) if v else None,
             'diffCm': round(gc[k] - v / 10, 2) if v else None} for k, v in pairs]


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name in sys.argv[1:]:
        gc, levels, s = measure(name)
        doc = {
            'schema': 1,
            'body': name,
            'description': {
                'zh': '由皮肤网格量出的 GarmentCode 人体尺寸（厘米、度），tools/cloth/measure.py 生成；定义见 GarmentCode 的 docs/Body Measurements GarmentCode.pdf。',
                'en': 'GarmentCode body measurements (cm, degrees) taken from the skin mesh by tools/cloth/measure.py; definitions as in GarmentCode docs/Body Measurements GarmentCode.pdf.',
            },
            'garmentcode': gc,
            'levelsY': levels,
            'compareWithCurated': compare(name, gc),
        }
        json.dump(doc, open(os.path.join(OUT, name + '.json'), 'w'), indent=1, ensure_ascii=False)
        print(name, json.dumps(gc))
        print('  levels', levels)
        print('  compare', doc['compareWithCurated'])
