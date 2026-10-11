"""把 MHR 拟合到我们的一个人体，得到单层、手臂与躯干分开的新皮肤（MHR 拓扑）及其骨架、蒙皮权重。
Fit MHR to one of our bodies: a single-walled skin in MHR topology with the arms separated from
the trunk, plus its joints and skin weights.

    python tools/bodyshape/fit_skin.py male                    # 贴合现有皮肤 / match the existing skin
    python tools/bodyshape/fit_skin.py female --mode targets --bmi 21.6   # 按人体测量目标 / anthropometric targets
    -> data/raw/bodyshape/out/<body>-skin/   (见 manifest.json / see manifest.json)

两种方式 / two modes
  skin     身份系数（45 个）、骨架缩放和姿势一起拟合：关节中心对上骨骼（有 rig.json 就用它的关节），
           皮肤表面贴合现有皮肤的可信部分（法线一致、距离近的对应点；腋下、上臂内侧、大腿内侧
           相连处自动被排除）。最后在 LOD0 上做一次平滑的逐顶点修正。
           identity (45), skeleton scales and pose are fitted together: joint centres to the bones
           (rig.json joints when present), surface to the trustworthy part of the existing skin
           (correspondences with agreeing normals and small distance, which drops the fused
           axilla / medial arm / medial thigh zones). A smooth per-vertex correction at LOD 0 follows.
  targets  身份系数由围度目标求出（女性、给定 BMI），骨架和姿势拟合到骨骼，并要求骨骼留在皮肤内。
           identity from girth targets (given sex and BMI); skeleton and pose fitted to the bones,
           with bones required to stay under the skin.

拟合在 LOD1（18439 顶点）上做，结果在 --lod（默认 0，73639 顶点）上输出：各 LOD 共用同一组参数。
The fit runs at LOD 1 (18 439 vertices); output is at --lod (default 0, 73 639 vertices): all LODs
share the same parameters.
"""
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mhrlib  # noqa: E402
from bodylib import CUR, RAW, Body, render_overlay, render_views  # noqa: E402
from compare import pred  # noqa: E402
from fit_check import REGIONS, classify, fmt, internal_points, signed_distance, summarise  # noqa: E402
from measure import JOINT_KEYS, bone_landmarks, surface_measures  # noqa: E402

FINGERS = (('index', 2), ('middle', 3), ('ring', 4), ('pinky', 5))

# MHR 关节 -> 解剖学关节（rig.json 的 id，去掉 _L/_R）/ MHR joint -> anatomical joint (rig.json id without side)
JOINT_MAP = {
    'uparm': ('gh', '盂肱关节（肩）', 'glenohumeral (shoulder)'), 'lowarm': ('elbow', '肘关节', 'elbow'), 'wrist': ('wrist', '腕关节', 'wrist'),
    'upleg': ('hip', '髋关节', 'hip'), 'lowleg': ('knee', '膝关节', 'knee'), 'foot': ('ankle', '踝关节（距小腿）', 'ankle (talocrural)'),
    'subtalar': ('subtalar', '距下关节', 'subtalar'), 'ball': ('mtp2', '跖趾关节：MHR 只有一个，位于第 2、3 跖趾关节（mtp2、mtp3）之间', 'metatarsophalangeal: MHR has a single one, lying between mtp2 and mtp3'),
    'clavicle': ('sc', '胸锁关节', 'sternoclavicular'),
    'thumb1': ('cmc1', '拇指腕掌关节', 'thumb carpometacarpal'), 'thumb2': ('mcp1', '拇指掌指关节', 'thumb metacarpophalangeal'),
    'thumb3': ('ip1', '拇指指间关节', 'thumb interphalangeal'),
}
for _f, _n in FINGERS:
    JOINT_MAP[_f + '1'] = (f'mcp{_n}', f'第 {_n} 指掌指关节', f'metacarpophalangeal {_n}')
    JOINT_MAP[_f + '2'] = (f'pip{_n}', f'第 {_n} 指近侧指间关节', f'proximal interphalangeal {_n}')
    JOINT_MAP[_f + '3'] = (f'dip{_n}', f'第 {_n} 指远侧指间关节', f'distal interphalangeal {_n}')
AXIAL_MAP = {'c_head': ('skull', '寰枕关节', 'atlanto-occipital'), 'c_neck': ('C7', '颈根（C7–T1）', 'neck base (C7-T1)'),
             'root': ('pelvis', '骨盆', 'pelvis'), 'c_spine0': (None, '腰椎下段（MHR 脊柱第 1 节，无一一对应的椎间关节）', 'lower lumbar (MHR spine joint 1; no one-to-one vertebral level)'),
             'c_spine1': (None, '腰椎上段', 'upper lumbar'), 'c_spine2': (None, '胸椎下段', 'lower thoracic'), 'c_spine3': (None, '胸椎上段', 'upper thoracic'),
             'c_jaw': ('tmj', '颞下颌关节', 'temporomandibular')}

SCALES = ['scale_spine_length', 'scale_neck_length', 'scale_shoulder_width', 'scale_uparms', 'scale_lowarms', 'scale_hip_width',
          'scale_hip_height', 'scale_hip_depth', 'scale_uplegs', 'scale_lowlegs', 'scale_ankle_height', 'scale_foot_length',
          'scale_l_hands', 'scale_r_hands']
AXIAL = ['root_tx', 'root_ty', 'root_tz', 'root_rx', 'root_ry', 'root_rz', 'spine_twist0', 'spine_lean0', 'spine_bend0', 'spine_twist1',
         'spine_lean1', 'spine_bend1', 'neck_twist', 'neck_lean', 'neck_bend', 'head_twist', 'head_lean', 'head_bend']
SIDE = ['clavicle_ry', 'clavicle_rz', 'uparm_twist', 'uparm_ry', 'uparm_rz', 'elbow_bend', 'lowarm_twist', 'wrist_ry', 'wrist_rz',
        'upleg_twist', 'upleg_ry', 'upleg_rz', 'knee_bend', 'foot_bend', 'foot_lean0', 'foot_lean1', 'ball_bend',
        'thumb0_ry', 'thumb0_rz', 'thumb1_rx', 'thumb1_ry', 'thumb1_rz', 'thumb2_rz', 'thumb3_rz'] + \
       [f'{f}{k}' for f, _ in FINGERS for k in ('1_ry', '1_rz', '2_rz', '3_rz')]
# 手指各节长度的缩放和指尖节点的位置：让 MHR 的手指与指骨一样长（否则指骨末节会顶出指尖 2 cm）
# finger segment length scales and fingertip node offsets: make MHR's fingers as long as the phalanges
# (otherwise the distal phalanges stick 2 cm out of the fingertips)
FINGER_SCALES = [f'scale_{s}_{f}{k}' for s in 'lr' for f in ('index', 'middle', 'ring', 'pinky', 'thumb') for k in ('1_length', '2_length', '3_length', '_null_tx')]
# 只由少数对应点约束、容易把皮肤拧坏的扭转量：限幅 / twists that few correspondences constrain: bounded
BOUNDS = {'upleg_twist': 0.35, 'uparm_twist': 0.9, 'spine_twist0': 0.2, 'spine_twist1': 0.2, 'neck_twist': 0.3, 'head_twist': 0.3,
          'root_rx': 0.3, 'root_ry': 0.3, 'root_rz': 0.3, 'foot_lean0': 0.5, 'foot_lean1': 0.5}

TARGETS = [('bmiFromVolume', 'bmi', None, 3.0), ('waistIliacGirth', 'nhanes', 'waist', 1.0), ('buttockGirth', 'nhanes', 'hip', 1.0),
           ('thighMidGirth', 'nhanes', 'thigh', 1.0), ('calfMaxGirth', 'nhanes', 'calf', 1.0), ('upperArmMidGirth', 'nhanes', 'armcirc', 1.0),
           ('chestGirth', 'ansur', 'chestcircumference', 1.0), ('waistNavelGirth', 'ansur', 'waistcircumference', 0.5),
           ('thighProximalGirth', 'ansur', 'thighcircumference', 0.5), ('thighLowerGirth', 'ansur', 'lowerthighcircumference', 0.5),
           ('ankleMinGirth', 'ansur', 'anklecircumference', 0.5), ('wristMinGirth', 'ansur', 'wristcircumference', 0.5)]
NCOMP = 6
# 主要关节（肩、肘、腕、髋、膝、踝）对应点的权重 / weight of the main joint correspondences
JW = float(os.environ.get('SOMA_JOINT_WEIGHT', 8))
# 膝关节单独用小权重：MHR 的膝关节点离解剖学屈伸轴中心约 13 mm，硬对上会把膝部皮肤顶离原位
# the knee gets a small weight of its own: MHR's knee joint lies about 13 mm from the anatomical
# flexion-axis centre, and pinning it there pushes the knee skin off the real surface
KW = 2.0


# ------------------------------------------------------------------ 目标点 / correspondences to the skeleton

def joint_targets(name, fb, L):
    """返回 [(MHR 关节名, 目标坐标, 权重)] 和来源说明。有 rig.json 时用骨架组拟合的关节中心。
    Returns [(MHR joint, target position, weight)] and where they came from; rig.json joints when present."""
    out = []
    path = os.path.join('public/anatomy', name, 'rig.json')
    if os.path.exists(path):
        R = {j['id']: np.array(j['center'], float) for j in json.load(open(path))['joints']}
        for S, s in (('L', 'l'), ('R', 'r')):
            for m, a, w in (('uparm', 'gh', JW), ('lowarm', 'elbow', JW), ('wrist', 'wrist', JW), ('upleg', 'hip', JW), ('lowleg', 'knee', KW), ('foot', 'ankle', JW),
                            ('thumb1', 'cmc1', 1), ('thumb2', 'mcp1', 1), ('thumb3', 'ip1', 1)):
                if f'{a}_{S}' in R:
                    out.append((f'{s}_{m}', R[f'{a}_{S}'], w))
            for f, n in FINGERS:
                for k, a in ((1, 'mcp'), (2, 'pip'), (3, 'dip')):
                    if f'{a}{n}_{S}' in R:
                        out.append((f'{s}_{f}{k}', R[f'{a}{n}_{S}'], 2))
            if f'mtp2_{S}' in R and f'mtp3_{S}' in R:
                out.append((f'{s}_ball', 0.5 * (R[f'mtp2_{S}'] + R[f'mtp3_{S}']), 1))
            # 指尖：末节指骨的远端再向外 3 mm（指腹）-> MHR 的指尖节点
            # fingertips: far end of the distal phalanx plus 3 mm of pulp -> MHR's fingertip node
            nm = 'left' if S == 'L' else 'right'
            for f, bone, prox in (('index', 'index finger', f'dip2_{S}'), ('middle', 'middle finger', f'dip3_{S}'), ('ring', 'ring finger', f'dip4_{S}'),
                                  ('pinky', 'little finger', f'dip5_{S}'), ('thumb', 'thumb', f'ip1_{S}')):
                try:
                    v = fb.verts(f'Distal phalanx of {nm} {bone}')
                except KeyError:
                    continue
                if prox in R:
                    far = v[np.argsort(-np.linalg.norm(v - R[prox], axis=1))[:8]].mean(0)
                    dirn = (far - R[prox]) / np.linalg.norm(far - R[prox])
                    out.append((f'{s}_{f}_null', far + 0.003 * dirn, 2))
        return out, 'rig.json'
    for S, s in (('L', 'l'), ('R', 'r')):
        for m, a in (('uparm', 'shoulder'), ('lowarm', 'elbow'), ('wrist', 'wrist'), ('upleg', 'hip'), ('lowleg', 'knee'), ('foot', 'ankle')):
            out.append((f'{s}_{m}', L[f'{a}_{S}'], KW if a == 'knee' else JW))
        nm = 'left' if S == 'L' else 'right'
        try:
            t = [fb.verts(f'Proximal phalanx of {nm} {k} toe') for k in ('second', 'third')]
            out.append((f'{s}_ball', np.mean([v[np.argsort(np.linalg.norm(v - L['ankle_' + S], axis=1))[:15]].mean(0) for v in t], axis=0), 1))
            # 没有 rig.json 时手只用两个点定向：中指近节远端 -> 中指 PIP，拇指近节远端 -> 拇指 IP
            # without rig.json the hand is oriented by two points only: far end of the middle proximal
            # phalanx -> middle PIP, far end of the thumb proximal phalanx -> thumb IP
            for mj, bone in (('middle2', f'Proximal phalanx of {nm} middle finger'), ('thumb3', f'Proximal phalanx of {nm} thumb')):
                v = fb.verts(bone)
                out.append((f'{s}_{mj}', v[np.argsort(-np.linalg.norm(v - L['wrist_' + S], axis=1))[:15]].mean(0), 0.5))
        except KeyError:
            pass
    return out, 'bone landmarks (tools/bodyshape/measure.py)'


# 皮下骨性点：骨面沿给定方向外移“典型软组织厚度”后应落在皮肤上（按目标生成时用来定头、膝、踝、肘）
# subcutaneous bony points: the bone surface moved outwards by a typical soft-tissue thickness should
# lie on the skin (used in targets mode to place head, knee, ankle and elbow)
SUBCUT = [  # bone name, direction, thickness mm, optional vertical band (fraction of the bone's height)
    ('Frontal bone', (0, 0, 1), 5, None), ('Occipital bone', (0, 0, -1), 6, None), ('Left parietal bone', (1, 0, 0), 6, None),
    ('Right parietal bone', (-1, 0, 0), 6, None), ('Mandible', (0, 0, 1), 9, (0.0, 0.25)), ('Left zygomatic bone', (1, 0, 0), 7, None),
    ('Right zygomatic bone', (-1, 0, 0), 7, None), ('Left patella', (0, 0, 1), 4, None), ('Right patella', (0, 0, 1), 4, None),
    ('Left tibia', (0, 0, 1), 3, (0.45, 0.55)), ('Right tibia', (0, 0, 1), 3, (0.45, 0.55)),
    ('Left tibia', (-1, 0, 0), 3, (0.0, 0.08)), ('Right tibia', (1, 0, 0), 3, (0.0, 0.08)),
    ('Left fibula', (1, 0, 0), 3, (0.0, 0.1)), ('Right fibula', (-1, 0, 0), 3, (0.0, 0.1)),
    ('Left ulna', (0, 0, -1), 3, (0.9, 1.0)), ('Right ulna', (0, 0, -1), 3, (0.9, 1.0)),
]


def subcutaneous_points(fb):
    pts = []
    for bone, n, t, band in SUBCUT:
        try:
            v = fb.verts(bone)
        except KeyError:
            continue
        if band:
            y0, y1 = v[:, 1].min(), v[:, 1].max()
            v = v[(v[:, 1] >= y0 + band[0] * (y1 - y0)) & (v[:, 1] <= y0 + band[1] * (y1 - y0))]
        n = np.array(n, float)
        pts.append(v[np.argmax(v @ n)] + n * t / 1000.0)
    return np.array(pts)


# ------------------------------------------------------------------ 以深部结构包络为准的目标面 / target surface from the deep envelope

def fat_cover(sex):
    """各区域皮肤到深部结构的应有距离（米）= 皮下脂肪标准厚度（rig-shape.json）+ 2 mm 皮肤。
    Intended skin-to-deep distance per region (m) = standard subcutaneous fat (rig-shape.json) + 2 mm of skin."""
    f = {g['id']: g['standardMm'] for g in json.load(open(os.path.join(CUR, 'rig-shape.json')))['sexes'][sex]['fat']}
    mm = {'head': 4.0, 'neck': 4.0, 'shoulder': f['deltoid'], 'chestFront': f['chestAnterior'], 'chestBack': f['back'], 'abdomenFront': f['abdomen'],
          'abdomenBack': f['back'], 'pelvis': f['buttock'], 'thigh': f['thighAnterior'], 'knee': 4.0, 'calf': f['calf'], 'foot': 3.0,
          'upperArm': 0.5 * (f['upperArmPosterior'] + f['deltoid']), 'forearm': f['forearm'], 'hand': 2.5}
    return {k: (v + 2.0) / 1000.0 for k, v in mm.items()}


class Envelope:
    """给出每个皮肤顶点在“深部结构包络 + 应有软组织厚度”这张目标面上的对应点。
    Gives every skin vertex its correspondence on the target surface "deep envelope + intended soft-tissue cover"."""

    def __init__(self, fb, L, sex):
        self.DV, self.DF = fb.merged(lambda p: p['tissue'] in Body.DEEP and p['system'] != 'integumentary')
        self.DV, self.DF = np.ascontiguousarray(self.DV), np.ascontiguousarray(self.DF)
        self.L, self.cover, self.factor = L, fat_cover(sex), 1.0
        self.zc = 0.25 * (L['hip_L'][2] + L['hip_R'][2] + L['shoulder_L'][2] + L['shoulder_R'][2])
        # 乳房区不约束（那里没有深部结构，乳房由体型模型给出）/ no constraint over the breasts (no deep parts there; the shape model supplies them)
        self.breast = []
        for S in 'LR':
            fat = [fb.mesh(p)[0] for p in fb.parts if p['id'] == f'HRA_fat_{S}']
            if fat:
                self.breast.append(fat[0][fat[0][:, 2] <= np.percentile(fat[0][:, 2], 15)].mean(0))

    def thickness(self, V):
        reg = classify(V, self.L)
        front = np.clip((V[:, 2] - self.zc) / 0.08 * 0.5 + 0.5, 0, 1)
        t = np.zeros(len(V))
        for r in np.unique(reg):
            m = reg == r
            if r in ('chest', 'abdomen'):
                t[m] = self.cover[r + 'Back'] + front[m] * (self.cover[r + 'Front'] - self.cover[r + 'Back'])
            else:
                t[m] = self.cover.get(r, 0.006)
        # 皮肤 2 mm 不随脂肪系数变 / the 2 mm of skin does not scale with the fat factor
        return 0.002 + self.factor * (t - 0.002)

    def __call__(self, V, Fm, max_dist, min_dot=0.4):
        import igl
        V = np.ascontiguousarray(V)
        d2, _, c = igl.point_mesh_squared_distance(V, self.DV, self.DF)[:3]
        d = np.sqrt(d2)
        inside = igl.fast_winding_number(self.DV, self.DF, V) > 0.5
        e = (V - c) / np.maximum(d, 1e-9)[:, None]
        e[inside] *= -1
        s = np.where(inside, -d, d)
        t = self.thickness(V)
        ok = (np.einsum('ij,ij->i', vertex_normals(V, Fm), e) > min_dot) & (np.abs(s - t) < max_dist)
        for A in self.breast:
            ok &= ~((np.linalg.norm(V[:, :2] - A[:2], axis=1) < 0.085) & (V[:, 2] > self.zc))
        return c + t[:, None] * e, e, ok


def outer_skin(b):
    """现有皮肤的外表面：法线背离最近内部结构的那些三角形（我们的皮肤是带内壁的薄壳）。
    Outer wall of the existing skin: triangles whose normal points away from the nearest internal
    structure (our skin is a thin shell with an inner wall)."""
    from scipy.spatial import cKDTree
    V, F = b.skin()
    P = np.vstack([internal_points(b, 'muscle'), internal_points(b, 'bone')])
    c = V[F].mean(1)
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    n /= np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]
    _, i = cKDTree(P).query(c)
    keep = np.einsum('ij,ij->i', n, c - P[i]) > 0
    return V, F[keep], n[keep]


def vertex_normals(V, F):
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    vn = np.zeros_like(V)
    for k in range(3):
        np.add.at(vn, F[:, k], n)
    return vn / np.maximum(np.linalg.norm(vn, axis=1), 1e-12)[:, None]


def correspond(V, Fm, SV, SF, SN, max_dist, min_dot=0.4):
    """MHR 顶点 -> 现有皮肤外表面上的最近点；返回最近点、该处法线、是否可信。
    MHR vertex -> closest point on the existing outer skin; closest point, its normal, trust flag."""
    import igl
    d2, fi, cp = igl.point_mesh_squared_distance(np.ascontiguousarray(V), np.ascontiguousarray(SV), np.ascontiguousarray(SF))[:3]
    nt = SN[fi]
    ok = (np.sqrt(d2) < max_dist) & (np.einsum('ij,ij->i', vertex_normals(V, Fm), nt) > min_dot)
    return cp, nt, ok


# ------------------------------------------------------------------ 身份系数：围度目标 / identity from girth targets

def targets_for(model, sex, S, bmi):
    t = {}
    for ours, ds, var, w in TARGETS:
        if ds == 'bmi':
            t[ours] = (bmi, w, 0.5)
        elif ds == 'nhanes':
            m = model['nhanes']['sexes'][sex]['outputs'][var]
            t[ours] = (pred(m, S, bmi), w, pred(m, S, bmi) * m['residualSdLog'])
        else:
            m = model['sexes'][sex]['outputs'][var]
            sd = np.sqrt(m['residualSdLog'] ** 2 + sum(l * l for l in m['factorLoadings']))
            t[ours] = (pred(m, S, bmi), w, pred(m, S, bmi) * sd)
    return t


def surrogate():
    rows = json.load(open(os.path.join(RAW, 'out', 'mhr-sweep.json')))
    X = np.c_[np.ones(len(rows)), np.array([r['identity'][:NCOMP] for r in rows])]
    fit = {}
    for ours, _, _, _ in TARGETS:
        y = np.array([r['measures'].get(ours, np.nan) for r in rows], float)
        ok = ~np.isnan(y)
        fit[ours] = np.linalg.lstsq(X[ok], y[ok], rcond=None)[0]
    return fit


def solve_identity(fit, tg, sex, offset=None, ridge=0.6):
    """加权岭回归；第 2 系数（性别方向）女性 >= 1.5、男性 <= -1.0。
    Weighted ridge solve; component 2 (sex) is kept >= 1.5 for women, <= -1.0 for men."""
    from scipy.optimize import least_squares
    A, b = [], []
    for k, (val, w, sd) in tg.items():
        c = fit[k]
        A.append(w * c[1:] / sd)
        b.append(w * (val - c[0] - (0.0 if offset is None else offset.get(k, 0.0))) / sd)
    A, b = np.array(A), np.array(b)
    lo, hi = np.full(NCOMP, -2.0), np.full(NCOMP, 2.0)
    lo[0], hi[0] = -3.0, 3.0
    if sex == 'F':
        lo[1] = 1.5
    else:
        hi[1] = -1.0
    x0 = np.clip(np.zeros(NCOMP), lo + 1e-6, hi - 1e-6)
    return least_squares(lambda x: np.r_[A @ x - b, ridge * x], x0, bounds=(lo, hi)).x


# ------------------------------------------------------------------ 拟合 / the fit

class Fit:
    def __init__(self, name, mode, fb, L, jt, skin=None, bone_pts=None, top_floor=None, subcut=None, env=None):
        self.name, self.mode, self.fb, self.L = name, mode, fb, L
        names = mhrlib.param_names()
        self.pnames = [n for n in AXIAL + SCALES + FINGER_SCALES + [s + '_' + p for s in 'lr' for p in SIDE] if n in names]
        self.pidx = np.array([names.index(n) for n in self.pnames])
        self.nid = 45 if mode in ('skin', 'envelope') else 0
        self.env = env
        self.jn = mhrlib.joint_names(1)
        self.jt = [(self.jn.index(j), np.asarray(p, float), w) for j, p, w in jt if j in self.jn]
        self.skin, self.bone_pts, self.top_floor, self.subcut = skin, bone_pts, top_floor, subcut
        self.F = mhrlib.faces(1)
        self.identity = np.zeros(45)
        n = self.nid + len(self.pnames)
        self.lo, self.hi = np.full(n, -4.0), np.full(n, 4.0)
        self.lo[:self.nid], self.hi[:self.nid] = -3.5, 3.5
        for i, pn in enumerate(self.pnames):
            for k, v in BOUNDS.items():
                if pn.endswith(k):
                    self.lo[self.nid + i], self.hi[self.nid + i] = -v, v
        self.step = np.full(n, 5e-3)
        self.step[:self.nid] = 2e-2
        self.corr = None

    def unpack(self, x):
        ident = np.array(x[:self.nid]) if self.nid else self.identity
        mp = np.zeros(204)
        mp[self.pidx] = x[self.nid:]
        return ident, mp

    def run(self, x, lod=1, correctives=True):
        ident, mp = self.unpack(x)
        return mhrlib.run(ident, mp, lod, correctives)

    def x0(self):
        x = np.zeros(self.nid + len(self.pnames))
        for s in 'lr':
            for p, v in (('uparm_ry', -0.4576), ('uparm_rz', -0.3632), ('elbow_bend', -0.353), ('uparm_twist', 0.3883)):
                x[self.nid + self.pnames.index(s + '_' + p)] = v
        V, P, _ = self.run(x)
        hip = 0.5 * (P[self.jn.index('l_upleg')] + P[self.jn.index('r_upleg')])
        tg = {j: p for j, p, _ in self.jt}
        hipT = 0.5 * (tg[self.jn.index('l_upleg')] + tg[self.jn.index('r_upleg')])
        for k, a in enumerate(('root_tx', 'root_ty', 'root_tz')):
            x[self.nid + self.pnames.index(a)] = (hipT - hip)[k] * 10.0  # 单位 10 cm / units of 10 cm
        return x

    def resid(self, x):
        V, P, _ = self.run(x)
        r = [np.concatenate([w * (P[j] - p) for j, p, w in self.jt])]
        if self.corr is not None:
            cp, nt, wgt = self.corr
            r.append(wgt * np.einsum('ij,ij->i', nt, V - cp))
        if self.bone_pts is not None:
            # 骨点应在皮肤下至少 3 mm / bone points should lie at least 3 mm under the skin
            r.append(0.6 * np.maximum(signed_distance(self.bone_pts, V, self.F) + 0.003, 0))
        if self.subcut is not None:
            r.append(1.5 * signed_distance(self.subcut, V, self.F))
        if self.top_floor is not None:
            r.append([2.0 * (V[:, 1].max() - self.top_floor[0]), 2.0 * (V[:, 1].min() - self.top_floor[1])])
        r.append(0.004 * np.asarray(x[self.nid + 6:]))
        if self.nid:
            r.append(0.003 * np.asarray(x[:self.nid]))
        return np.concatenate([np.ravel(v) for v in r])

    def lm_step(self, x, lam):
        r0 = self.resid(x)
        J = np.zeros((len(r0), len(x)))
        for i in range(len(x)):
            # 自己做差分：MHR 是 float32，过小的步长只会得到噪声
            # own finite differences: MHR is float32, tiny steps only give noise
            xi = x.copy()
            h = self.step[i] if x[i] + self.step[i] <= self.hi[i] else -self.step[i]
            xi[i] += h
            J[:, i] = (self.resid(xi) - r0) / h
        A, g = J.T @ J, J.T @ r0
        c0 = r0 @ r0
        for _ in range(8):
            dx = np.linalg.solve(A + lam * (np.diag(np.diag(A)) + 1e-9 * np.eye(len(x))), -g)
            xn = np.clip(x + dx, self.lo, self.hi)
            rn = self.resid(xn)
            if rn @ rn < c0:
                return xn, max(lam * 0.3, 1e-6), float(rn @ rn)
            lam *= 10
        return x, lam, float(c0)

    def solve(self, iters, log, x=None):
        x = self.x0() if x is None else x
        lam = 1e-2
        for it in range(iters):
            if self.skin is not None or self.env is not None:
                V, _, _ = self.run(x)
                md = 0.06 if it < 3 else (0.04 if it < 8 else 0.025)
                cp, nt, ok = correspond(V, self.F, *self.skin, max_dist=md) if self.skin is not None else self.env(V, self.F, md)
                self.corr = (cp, nt, 0.35 * ok.astype(float))
            x, lam, c = self.lm_step(x, lam)
            jr = self.joint_residuals(x)
            log.append(f'  iteration {it}: cost {c:.5f}  joint residual median {np.median(list(jr.values())):.1f} mm, max {max(jr.values()):.1f} mm'
                       + (f'  trusted {self.corr[2].astype(bool).mean() * 100:.0f} %' if self.corr else ''))
        return x

    def joint_residuals(self, x):
        _, P, _ = self.run(x)
        return {self.jn[j]: round(float(np.linalg.norm(P[j] - p) * 1000), 1) for j, p, _ in self.jt}


def refine(V, F, skinmesh, rounds=4, cap=0.02, provider=None):
    """平滑的逐顶点修正：可信处朝现有皮肤移动，不可信处由邻域调和插值。
    Smooth per-vertex correction: move towards the existing skin where the correspondence is
    trusted, harmonic fill elsewhere."""
    from scipy import sparse
    n = len(V)
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    A = sparse.coo_matrix((np.ones(len(e) * 2), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    A.data[:] = 1.0
    A = sparse.diags(1.0 / np.maximum(np.asarray(A.sum(1)).ravel(), 1)) @ A
    off = np.zeros_like(V)
    trusted = np.zeros(n, bool)
    for _ in range(rounds):
        cp, nt, ok = correspond(V + off, F, *skinmesh, max_dist=0.012, min_dot=0.6) if provider is None else provider(V + off, F, 0.03, 0.6)
        raw = off + np.einsum('ij,ij->i', nt, cp - (V + off))[:, None] * nt
        raw[~ok] = 0
        o = np.where(ok[:, None], raw, off)
        for _ in range(40):
            avg = A @ o
            o = np.where(ok[:, None], 0.6 * raw + 0.4 * avg, avg)
        for _ in range(3):
            o = 0.5 * o + 0.5 * (A @ o)
        ln = np.linalg.norm(o, axis=1)
        off = o * np.minimum(1.0, cap / np.maximum(ln, 1e-9))[:, None]
        trusted = ok
    return off, trusted


# ------------------------------------------------------------------ 报告 / reporting

def region_distance(V, F, skinmesh, L):
    """新皮肤顶点到旧皮肤外表面的距离（毫米），分区域；trusted = 法线一致且 < 25 mm。
    Distance from new-skin vertices to the old outer skin (mm) by region."""
    import igl
    SV, SF, SN = skinmesh
    d2, fi, cp = igl.point_mesh_squared_distance(np.ascontiguousarray(V), np.ascontiguousarray(SV), np.ascontiguousarray(SF))[:3]
    d = np.sqrt(d2) * 1000
    sgn = np.einsum('ij,ij->i', SN[fi], V - cp) * 1000
    ok = (d < 25) & (np.einsum('ij,ij->i', vertex_normals(V, F), SN[fi]) > 0.4)
    reg = classify(V, L)
    out = {}
    for rid, zh, en in REGIONS:
        m = reg == rid
        if m.sum() < 20:
            continue
        t = m & ok
        out[rid] = {'name': {'zh': zh, 'en': en}, 'n': int(m.sum()), 'trustedFraction': round(float(t.sum() / m.sum()), 3),
                    'trustedAbsP50': round(float(np.median(d[t])), 2) if t.any() else None,
                    'trustedAbsP90': round(float(np.percentile(d[t], 90)), 2) if t.any() else None,
                    'trustedSignedMean': round(float(sgn[t].mean()), 2) if t.any() else None,
                    'allAbsP90': round(float(np.percentile(d[m], 90)), 1), 'allAbsMax': round(float(d[m].max()), 1)}
    return out


def self_gap(V, F, L):
    """上臂内侧到躯干、两大腿内侧之间的最小间隙（毫米）；负值表示相互穿入。
    Smallest gap (mm) between medial upper arm and trunk, and between the thighs; negative = interpenetration."""
    from scipy.spatial import cKDTree
    reg = classify(V, L)
    out = {}
    trunk = V[np.isin(reg, ['chest', 'abdomen', 'pelvis'])]
    tt = cKDTree(trunk)
    for S, sg in (('L', 1), ('R', -1)):
        arm = V[(reg == 'upperArm') & (sg * V[:, 0] > 0)]
        fore = V[(reg == 'forearm') & (sg * V[:, 0] > 0)]
        for key, pts in (('upperArmToTrunk_' + S, arm), ('forearmToTrunk_' + S, fore)):
            if len(pts):
                d, _ = tt.query(pts)
                out[key] = round(float(np.percentile(d, 1) * 1000), 1)
    th = (reg == 'thigh')
    l, r = V[th & (V[:, 0] > 0)], V[th & (V[:, 0] < 0)]
    if len(l) and len(r):
        out['thighToThighMinX'] = round(float((l[:, 0].min() - r[:, 0].max()) * 1000), 1)
    return out


def write_obj(path, V, F, note):
    with open(path, 'w') as f:
        f.write(f'# {note}\n')
        for v in V:
            f.write(f'v {v[0]:.5f} {v[1]:.5f} {v[2]:.5f}\n')
        for t in F:
            f.write(f'f {t[0] + 1} {t[1] + 1} {t[2] + 1}\n')


def joint_mapping(jn):
    rows = []
    for j in jn:
        side = {'l': 'L', 'r': 'R'}.get(j[0]) if j[1] == '_' else None
        base = j[2:] if side else j
        if side and base in JOINT_MAP:
            a, zh, en = JOINT_MAP[base]
            rows.append({'mhr': j, 'anatomical': f'{a}_{side}', 'name': {'zh': zh, 'en': en}})
        elif j in AXIAL_MAP:
            a, zh, en = AXIAL_MAP[j]
            rows.append({'mhr': j, 'anatomical': a, 'name': {'zh': zh, 'en': en}})
        else:
            kind = ('扭转辅助关节（沿肢段分摊扭转）', 'twist helper (spreads twist along the segment)') if 'twist' in j else \
                   ('末端/辅助节点', 'end or helper node')
            rows.append({'mhr': j, 'anatomical': None, 'name': {'zh': kind[0], 'en': kind[1]}})
    return rows


def stale_guard(name):
    """导出的网格必须比 public/anatomy/<body>/anatomy.json 新，否则拒绝运行（曾因用旧网格拟合而出错）。
    The exported meshes must be newer than public/anatomy/<body>/anatomy.json; refuse to run otherwise."""
    exp = os.path.join(RAW, 'bodies', name, 'index.json')
    src = os.path.join('public/anatomy', name, 'anatomy.json')
    if os.path.getmtime(exp) < os.path.getmtime(src):
        raise SystemExit(f'stale export for {name}: run  bun tools/bodyshape/export-parts.ts {name}  first')


def main():
    name = sys.argv[1]
    arg = lambda k, d: (sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d)
    mode = arg('--mode', 'skin' if name == 'male' else 'envelope')
    lod = int(arg('--lod', 0))
    sex = 'F' if name == 'female' else 'M'
    out = os.path.join(RAW, 'out', arg('--out', f'{name}-skin'))
    os.makedirs(out, exist_ok=True)
    model = json.load(open(os.path.join(CUR, 'anthro-model.json')))
    stale_guard(name)
    fb = Body(name)
    L = bone_landmarks(fb)
    jt, jsrc = joint_targets(name, fb, L)
    S = (L['vertex'][1] - L['floor'][1]) * 1000
    log = [f'body {name}, mode {mode}, output LOD {lod}, joint targets from {jsrc} ({len(jt)} joints), stature {S:.0f} mm']
    oskin = outer_skin(fb)
    ilio = 0.5 * (L['iliocristale_L'][1] + L['iliocristale_R'][1]) - L['floor'][1]
    Jm = {k: L[k] for k in JOINT_KEYS}
    old_meas = surface_measures(*fb.skin(), Jm, levels={'iliocristale': ilio})

    env = None
    if mode == 'skin':
        fit = Fit(name, mode, fb, L, jt, skin=oskin)
        x = fit.solve(16, log)
        ident, mp = fit.unpack(x)
    elif mode == 'envelope':
        # 目标面 = 她的深部结构包络 + 各部位应有的皮下脂肪和皮肤；关节对 rig.json。这样皮肤居中包在内部结构外面，
        # 围度 = 包络围度 + 标准脂肪。之后调一个统一的脂肪系数，使体积 BMI 等于目标。
        # target surface = her deep envelope + the intended fat and skin of each region; joints to rig.json. The skin is
        # then centred on the internals and girths = envelope girth + standard fat. A single fat factor is tuned afterwards
        # so that the volume BMI meets the target.
        env = Envelope(fb, L, sex)
        fit = Fit(name, mode, fb, L, jt, env=env)
        x = fit.solve(18, log)
        ident, mp = fit.unpack(x)
    else:
        bmi = float(arg('--bmi', 22.0))
        tg = targets_for(model, sex, S, bmi)
        sur = surrogate()
        Pb = fb.merged(lambda p: p['system'] == 'skeletal' and p['tissue'] == 'bone')[0]
        Pb = Pb[~np.isin(classify(Pb, L), ['hand', 'foot'])]
        Pb = Pb[np.random.default_rng(3).choice(len(Pb), 2500, replace=False)]
        fit = Fit(name, mode, fb, L, jt, bone_pts=Pb, top_floor=(L['vertex'][1], L['floor'][1]), subcut=subcutaneous_points(fb))
        idc = solve_identity(sur, tg, sex)
        offset = {}
        log.append(f'target: {sex}, stature {S:.0f} mm, BMI {bmi}')
        x = None
        for it in range(4):
            fit.identity = np.r_[idc, np.zeros(45 - NCOMP)]
            if it == 0:
                # 先只对关节，再加上“骨在皮肤内”的约束 / joints alone first, then with the bones-inside constraint
                bp, fit.bone_pts = fit.bone_pts, None
                x = fit.solve(14, log)
                fit.bone_pts = bp
            x = fit.solve(4, log, x)
            V1, P1, _ = fit.run(x)
            J1 = {f'{a}_{Sd}': P1[fit.jn.index(f'{s}_{m}')] for Sd, s in (('L', 'l'), ('R', 'r'))
                  for a, m in (('shoulder', 'uparm'), ('elbow', 'lowarm'), ('wrist', 'wrist'), ('hip', 'upleg'), ('knee', 'lowleg'), ('ankle', 'foot'))}
            meas = surface_measures(V1, fit.F, J1, levels={'iliocristale': ilio})
            log.append(f' identity round {it}: {np.round(idc, 2).tolist()}  ' + ', '.join(f'{k} {(meas[k] - v[0]) / v[2]:+.1f}sd' for k, v in tg.items()))
            if it == 3:
                break
            for k in tg:
                offset[k] = offset.get(k, 0.0) + 0.7 * (meas[k] - (sur[k][0] + sur[k][1:] @ idc + offset.get(k, 0.0)))
            idc = solve_identity(sur, tg, sex, offset)
        ident, mp = fit.unpack(x)
    jres = fit.joint_residuals(x)
    log.append('joint residuals (mm): ' + json.dumps(jres))

    # ---- 输出 LOD 上的网格 / the mesh at the output LOD
    V, P, sk = mhrlib.run(ident, mp, lod, True)
    F = mhrlib.faces(lod)
    jn = mhrlib.joint_names(lod)
    Vmhr = V.copy()
    off = np.zeros_like(V)
    if mode == 'envelope':
        from measure import mesh_volume
        tb = float(arg('--bmi', 21.6))
        Hh = lambda W: W[:, 1].max() - W[:, 1].min()
        bmi_of = lambda W: mesh_volume(W, F) * 1010.0 / Hh(W) ** 2
        tried = []
        for fac in (1.0, 1.4):
            env.factor = fac
            off, trusted = refine(Vmhr, F, None, provider=env)
            tried.append((fac, bmi_of(Vmhr + off)))
        k_ = (tried[1][1] - tried[0][1]) / 0.4
        fac = float(np.clip(1.0 + (tb - tried[0][1]) / k_, 0.3, 2.5)) if abs(k_) > 1e-6 else 1.0
        env.factor = fac
        off, trusted = refine(Vmhr, F, None, provider=env)
        V = Vmhr + off
        log.append(f'fat factor: volume BMI {tried[0][1]:.2f} at standard fat thickness, {tried[1][1]:.2f} at 1.4 x; factor {fac:.2f} gives {bmi_of(V):.2f} (target {tb})')
        log.append(f'per-vertex correction: median {np.median(np.linalg.norm(off, axis=1)) * 1000:.1f} mm, 95th percentile '
                   f'{np.percentile(np.linalg.norm(off, axis=1), 95) * 1000:.1f} mm, vertices with a usable correspondence {trusted.mean() * 100:.0f} %')
    if mode == 'skin':
        off, trusted = refine(V, F, oskin)
        V = V + off
        log.append(f'per-vertex correction: median {np.median(np.linalg.norm(off, axis=1)) * 1000:.1f} mm, 95th percentile '
                   f'{np.percentile(np.linalg.norm(off, axis=1), 95) * 1000:.1f} mm, trusted vertices {trusted.mean() * 100:.0f} %')
    J = {f'{a}_{Sd}': P[jn.index(f'{s}_{m}')] for Sd, s in (('L', 'l'), ('R', 'r'))
         for a, m in (('shoulder', 'uparm'), ('elbow', 'lowarm'), ('wrist', 'wrist'), ('hip', 'upleg'), ('knee', 'lowleg'), ('ankle', 'foot'))}
    new_meas = surface_measures(V, F, J, levels={'iliocristale': ilio})
    res = {'body': name, 'mode': mode, 'lod': lod, 'vertices': int(len(V)), 'triangles': int(len(F)), 'jointTargetsFrom': jsrc,
           'identity': [round(float(v), 4) for v in ident], 'mhrParameters': {n: round(float(mp[mhrlib.param_names().index(n)]), 5) for n in fit.pnames},
           'jointResidualMm': jres,
           'girthsMm': {k: {'oldSkin': round(float(old_meas[k]), 1), 'newSkin': round(float(new_meas[k]), 1)} for k in new_meas
                        if k in old_meas and not k.endswith(('_L', '_R'))}}
    log.append('\nmeasure                 old skin   new skin   diff')
    for k, v in res['girthsMm'].items():
        if 'Girth' in k or k in ('stature', 'bmiFromVolume', 'volumeL', 'hipBreadth', 'chestDepth', 'crotchHeight'):
            log.append(f'  {k:22s} {v["oldSkin"]:8.1f} {v["newSkin"]:9.1f} {v["newSkin"] - v["oldSkin"]:+7.1f}')
    rd_mhr = region_distance(Vmhr, F, oskin, L)
    rd = region_distance(V, F, oskin, L)
    res['distanceToOldSkinMm'] = {'afterCorrection': rd, 'mhrOnly': rd_mhr}
    log.append('\nnew skin -> old outer skin, mm: trusted fraction, |d| median / p90 (trusted), signed mean; before correction in brackets')
    for rid, s in rd.items():
        b0 = rd_mhr[rid]
        log.append(f'  {rid:10s} {100 * s["trustedFraction"]:5.0f}%  {s["trustedAbsP50"]} / {s["trustedAbsP90"]}  mean {s["trustedSignedMean"]}   '
                   f'[{b0["trustedAbsP50"]} / {b0["trustedAbsP90"]}]  all p90 {s["allAbsP90"]} max {s["allAbsMax"]}')
    res['selfGapMm'] = self_gap(V, F, L)
    log.append('gaps (mm): ' + json.dumps(res['selfGapMm']))
    for kind in ('muscle', 'bone'):
        Pk = internal_points(fb, kind)
        st = summarise(signed_distance(Pk, V, F), classify(Pk, L))
        res['containment:' + kind] = st
        log.append(f'\n== {name} {kind} vertices vs the new skin: signed distance, mm (+ = outside)\n{fmt(st)}')
    worst = []
    for p in fb.parts:
        if p['system'] == 'muscular' and p['tissue'] == 'muscle':
            d = signed_distance(fb.mesh(p)[0], V, F) * 1000
            worst.append({'id': p['id'], 'name': p['name'], 'outsideFraction': round(float((d > 0).mean()), 3),
                          'p95Mm': round(float(np.percentile(d, 95)), 1), 'maxMm': round(float(d.max()), 1)})
    worst.sort(key=lambda w: -w['p95Mm'])
    res['musclesMostOutside'] = worst[:40]
    log.append('\nmuscles furthest outside (95th percentile of signed distance, mm):')
    for w in worst[:15]:
        log.append(f'   {w["p95Mm"]:6.1f}  max {w["maxMm"]:6.1f}  out {100 * w["outsideFraction"]:5.1f}%  {w["name"]}')
    if sex == 'F':
        # 乳腺（HRA 部件）是否在新皮肤内 / do the HRA mammary parts fit inside the new skin?
        br = {}
        for p in fb.parts:
            if p['id'].startswith('HRA_') and p['system'] == 'integumentary':
                d = signed_distance(fb.mesh(p)[0], V, F) * 1000
                br[p['id']] = {'name': p['name'], 'outsideFraction': round(float((d > 0).mean()), 3), 'p50Mm': round(float(np.median(d)), 1),
                               'maxMm': round(float(d.max()), 1)}
        res['breastPartsVsSkin'] = br
        log.append('\nHRA breast parts vs the new skin (signed mm, + outside): ' + json.dumps({k: (v['outsideFraction'], v['p50Mm'], v['maxMm']) for k, v in br.items()}))

    # 参数拟合的结果存盘，供 enclose_skin.py 做包裹修正和打包 / state of the parametric fit, for enclose_skin.py
    np.savez(os.path.join(out, 'fit-state.npz'), identity=ident, mp=mp, offsets=off, lod=lod)
    if mode == 'envelope':  # compose_female.py 读这一份 / compose_female.py reads this copy
        np.savez(os.path.join(out, 'fit-state-envelope.npz'), identity=ident, mp=mp, offsets=off, lod=lod)
    write_obj(os.path.join(out, 'skin.obj'), V, F, f'{name} skin, MHR LOD{lod} topology (Apache-2.0); metres, Y up, +Z anterior, +X left')
    Vr, Pr, _ = mhrlib.run(ident, mp, lod, False)
    np.asarray(Vr + off, np.float32).tofile(os.path.join(out, 'skin-no-pose-correctives.f32'))
    off.astype(np.float32).tofile(os.path.join(out, 'residual-offsets.f32'))
    vi, ji, w, parents = mhrlib.skin_weights(lod)
    rec = np.zeros(len(vi), dtype=[('v', '<u4'), ('j', '<u4'), ('w', '<f4')])
    rec['v'], rec['j'], rec['w'] = vi, ji, w
    rec.tofile(os.path.join(out, 'weights.bin'))
    quat = sk[:, 3:7]
    json.dump({'note': {'zh': '关节位置为拟合姿势下、我们坐标系中的坐标（米）；rotation 为该姿势下关节的世界朝向四元数 (x, y, z, w)；parents 为父关节下标（-1 为根）。'
                              'mapping 给出 MHR 关节对应的解剖学关节（rig.json 的 id）。',
                        'en': 'Joint positions are in the fitted pose, in our frame (metres); rotation is the joint world orientation quaternion (x, y, z, w) in that pose; '
                              'parents index into names (-1 = root). mapping gives the anatomical joint (rig.json id) each MHR joint stands for.'},
               'names': jn, 'parents': parents.tolist(), 'positions': np.round(P, 5).tolist(), 'rotation': np.round(quat, 6).tolist(),
               'mapping': joint_mapping(jn)}, open(os.path.join(out, 'joints.json'), 'w'), ensure_ascii=False)
    json.dump(res, open(os.path.join(out, 'fit.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(out, 'fit.txt'), 'w').write('\n'.join(log))
    shutil.copy(os.path.join(mhrlib.DIR, 'LICENSE.txt'), os.path.join(out, 'LICENSE-MHR.txt'))
    open(os.path.join(out, 'NOTICE-MHR.txt'), 'w').write(
        '本目录中的 skin.obj、weights.bin、joints.json、shape-*.f32 由 Momentum Human Rig (MHR) v1.0.1 派生。\n'
        'skin.obj, weights.bin, joints.json and shape-*.f32 in this directory are derived from Momentum Human Rig (MHR) v1.0.1.\n\n'
        'MHR: Copyright (c) Meta Platforms, Inc. and affiliates. Licensed under the Apache License, Version 2.0 (see LICENSE-MHR.txt).\n'
        'https://github.com/facebookresearch/MHR\n'
        '改动 / changes: identity, skeleton scale and pose fitted to the soma body; for the male, a smooth per-vertex correction towards the BodyParts3D skin.\n')
    json.dump({
        'schema': 1,
        'what': {'zh': f'{"男" if sex == "M" else "女"}性皮肤（MHR LOD{lod} 拓扑，单层、手臂与躯干分开），' + ('贴合原 BodyParts3D 皮肤' if mode == 'skin' else '按人体测量目标生成'),
                 'en': f'{"male" if sex == "M" else "female"} skin in MHR LOD{lod} topology (single wall, arms separate from the trunk), ' + ('matched to the BodyParts3D skin' if mode == 'skin' else 'generated from anthropometric targets')},
        'source': {'name': 'Momentum Human Rig (MHR) v1.0.1', 'url': 'https://github.com/facebookresearch/MHR', 'license': 'Apache-2.0',
                   'attribution': 'MHR, Copyright (c) Meta Platforms, Inc. and affiliates, licensed under the Apache License 2.0'},
        'frame': f'metres, Y up, +Z anterior, +X subject left; same origin as public/anatomy/{name}',
        'files': {
            'skin.obj': f'{len(V)} vertices, {len(F)} triangles; vertex order = MHR LOD{lod}',
            'skin-no-pose-correctives.f32': 'float32 [n][3]: the same skin without MHR pose correctives = what linear blend skinning of weights.bin reproduces at this pose',
            'residual-offsets.f32': 'float32 [n][3]: per-vertex correction added on top of MHR (zero in targets mode)',
            'weights.bin': f'{len(vi)} records (uint32 vertex, uint32 joint, float32 weight), little endian; up to {int(np.bincount(vi).max())} joints per vertex',
            'joints.json': f'{len(jn)} joints: names, parents, positions and orientations in this pose, mapping to anatomical joints',
            'fit.json / fit.txt': 'identity coefficients, MHR parameters, joint residuals, girths old vs new, distance to the old skin, containment of muscles and bones',
            'shape-fields.json + shape-*.f32': 'runtime shape fields (written by shape_fields.py)',
            'LICENSE-MHR.txt, NOTICE-MHR.txt': 'licence text and attribution that must ship with anything derived from these files'},
    }, open(os.path.join(out, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
    print('\n'.join(log))

    skin = (0.86, 0.72, 0.62)
    bv, bf = fb.merged(lambda p: p['system'] == 'skeletal' and p['tissue'] == 'bone')
    mv, mf = fb.merged(lambda p: p['system'] == 'muscular' and p['tissue'] == 'muscle')
    inner = [(mv, mf, (0.75, 0.2, 0.2)), (bv, bf, (0.95, 0.95, 0.85))]
    render_views([(V, F, skin)], os.path.join(out, 'preview-skin.png'), height=1100)
    render_overlay((V, F, skin), inner, os.path.join(out, 'preview-overlay.png'), height=1100)
    render_views([(V, F, skin)] + inner, os.path.join(out, 'preview-pokes.png'), height=1100,
                 title='new skin with muscles (red) and bones (white): whatever shows is outside the skin')
    sv, sf = fb.skin()
    render_views([(sv, sf, skin)], os.path.join(out, 'preview-old-skin.png'), height=1100)


if __name__ == '__main__':
    main()
