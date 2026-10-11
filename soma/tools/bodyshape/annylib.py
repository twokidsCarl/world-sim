"""Anny / MakeHuman 参数化人体的封装：按表型参数生成我们坐标系下、手臂下垂的皮肤网格和关节。
Wrapper around the Anny (MakeHuman-based) parametric body: skin mesh and joints for a set of
phenotype parameters, in our frame, posed with the arms hanging like our bodies.

Anny 坐标：Z 向上、面朝 -Y、左侧 +X；我们：Y 向上、前 +Z、左 +X。
Anny frame: Z up, facing -Y, left +X.  Ours: Y up, anterior +Z, left +X:  (x, y, z) = (x_a, z_a, -y_a).

依赖 / needs: pip install anny (Apache-2.0 code, CC0 MakeHuman data), torch.
"""
import numpy as np
import torch

_MODEL = None


def model():
    global _MODEL
    if _MODEL is None:
        import anny
        _MODEL = anny.create_fullbody_model(rig='default', topology='default', triangulate_faces=True,
                                            all_phenotypes=True, local_changes='default')
        _MODEL = _MODEL.to(dtype=torch.float64)
    return _MODEL


def to_ours(p):
    p = np.asarray(p)
    return np.stack([p[..., 0], p[..., 2], -p[..., 1]], -1)


def _rot(axis, deg):
    a = np.radians(deg)
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    R = np.eye(3) + np.sin(a) * K + (1 - np.cos(a)) * K @ K
    T = np.eye(4)
    T[:3, :3] = R
    return T


def _rot_between(a, b):
    """把单位向量 a 转到 b 的最小旋转 / minimal rotation taking direction a to b (3x3)."""
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v, c = np.cross(a, b), float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K / (1 + c)


def rest(phenotype, local_changes=None):
    """静止姿态（MakeHuman 的 A 字站姿），我们的坐标系，脚底在 y=0。
    Rest pose (MakeHuman A-pose) in our frame, soles at y = 0: V, F, bone heads/tails, weights."""
    m = model()
    ph = {k: torch.tensor([float(v)], dtype=torch.float64) for k, v in phenotype.items()}
    kw = {}
    if local_changes:
        kw['local_changes_kwargs'] = {k: torch.tensor([float(v)], dtype=torch.float64) for k, v in local_changes.items()}
    eye = torch.eye(4, dtype=torch.float64)[None, None].repeat(1, len(m.bone_labels), 1, 1)
    o = m(pose_parameters=eye, phenotype_kwargs=ph, return_bone_ends=True, **kw)
    V = to_ours(o['rest_vertices'][0].numpy())
    H, T = to_ours(o['rest_bone_heads'][0].numpy()), to_ours(o['rest_bone_tails'][0].numpy())
    floor = V[:, 1].min()
    for a in (V, H, T):
        a[:, 1] -= floor
    return {'V': V, 'F': m.faces.numpy().astype(np.int64), 'heads': H, 'tails': T, 'labels': list(m.bone_labels),
            'parents': [int(x) for x in m.bone_parents],
            'wIdx': m.vertex_bone_indices.numpy().astype(np.int64), 'wVal': m.vertex_bone_weights.numpy()}


def lbs(r, rotations):
    """线性混合蒙皮。rotations: {骨名: 3x3 世界轴旋转（绕该骨头部，相对父骨骼）}。
    Linear blend skinning. rotations: {bone label: 3x3 rotation in world axes about the bone head,
    applied on top of the parent's motion}. Returns posed V, heads, tails."""
    n = len(r['labels'])
    G = np.zeros((n, 4, 4))
    for i in range(n):  # 父骨骼排在前面 / parents precede children
        L = np.eye(4)
        R = rotations.get(r['labels'][i])
        if R is not None:
            L[:3, :3] = R
            L[:3, 3] = r['heads'][i] - R @ r['heads'][i]
        p = r['parents'][i]
        G[i] = L if p < 0 else G[p] @ L
    Vh = np.c_[r['V'], np.ones(len(r['V']))]
    out = np.zeros((len(Vh), 3))
    for k in range(r['wIdx'].shape[1]):
        w = r['wVal'][:, k]
        if not w.any():
            continue
        out += w[:, None] * np.einsum('nij,nj->ni', G[r['wIdx'][:, k]], Vh)[:, :3]
    ap = lambda P: np.einsum('nij,nj->ni', G, np.c_[P, np.ones(n)])[:, :3]
    return out, ap(r['heads']), ap(r['tails']), G


# 我们男性模型的上肢方向（measure.py）/ arm directions of our male body (measure.py)
UPPER_ARM = dict(abduction=9.6, flexion=-2.5)
FOREARM = dict(abduction=11.0, flexion=12.0)


def _dir(sgn, abduction, flexion):
    a, f = np.radians(abduction), np.radians(flexion)
    d = np.array([sgn * np.tan(a), -1.0, np.tan(f)])
    return d / np.linalg.norm(d)


def body(phenotype, posed=True, supinate=True, local_changes=None, upper_arm=UPPER_ARM, forearm=FOREARM, legs=None):
    """phenotype: gender (0 男 male, 1 女 female), age (2/3 = 青年 young adult, 1 = 老年 old), muscle, weight,
    height, proportions, cupsize, firmness, african/asian/caucasian，均为 0..1 / each 0..1.
    legs: 可选，{'L': 大腿方向, 'R': ...} 世界方向 / optional thigh directions.
    Returns dict V, F, joints, heads, tails, labels, rest (the rest-pose dict)."""
    r = rest(phenotype, local_changes)
    lab = r['labels']
    rot = {}
    if posed:
        for side, sgn in (('L', 1), ('R', -1)):
            ix = lambda b: lab.index(b + '.' + side)
            s, e, w = r['heads'][ix('upperarm01')], r['heads'][ix('lowerarm01')], r['heads'][ix('wrist')]
            R1 = _rot_between(e - s, _dir(sgn, **upper_arm))
            rot['upperarm01.' + side] = R1
            R2 = _rot_between(R1 @ (w - e), _dir(sgn, **forearm))
            rot['lowerarm01.' + side] = R2
            if supinate:
                # 旋后使掌心向前：按当前掌面法线求所需扭转角
                # supinate so the palm faces forward: twist angle from the current palm normal
                fa = R2 @ R1 @ (w - e)
                fa /= np.linalg.norm(fa)
                i2, i5 = r['heads'][ix('finger2-1')], r['heads'][ix('finger5-1')]
                across = R2 @ R1 @ (i2 - i5)           # 小指->食指 / little -> index finger
                along = R2 @ R1 @ (r['heads'][ix('finger3-1')] - w)
                nrm = np.cross(along, across) * sgn     # 掌面法线（指向掌侧）/ palm normal (palmar)
                nrm -= (nrm @ fa) * fa
                tgt = np.array([0, 0, 1.0]) - fa[2] * fa
                ang = np.arctan2(np.cross(nrm, tgt) @ fa, nrm @ tgt)
                for b, share in (('lowerarm01', 0.2), ('lowerarm02', 0.4), ('wrist', 0.4)):
                    K = _rot(fa, np.degrees(ang) * share)[:3, :3]
                    # 各骨的旋转都是在父骨骼运动之上、以世界轴表达的增量
                    # every bone's rotation is an increment on top of its parent's motion, in world axes
                    rot[b + '.' + side] = K @ R2 if b == 'lowerarm01' else K
        if legs:
            for side in 'LR':
                h, k = r['heads'][lab.index('upperleg01.' + side)], r['heads'][lab.index('lowerleg01.' + side)]
                rot['upperleg01.' + side] = _rot_between(k - h, legs[side])
    V, H, T, G = lbs(r, rot)
    floor = V[:, 1].min()
    for a in (V, H, T):
        a[:, 1] -= floor
    J = {}
    for side in 'LR':
        for ours, b in (('shoulder', 'upperarm01'), ('elbow', 'lowerarm01'), ('wrist', 'wrist'), ('hip', 'upperleg01'),
                        ('knee', 'lowerleg01'), ('ankle', 'foot')):
            J[ours + '_' + side] = H[lab.index(b + '.' + side)]
    return {'V': V, 'F': r['F'], 'joints': J, 'heads': H, 'tails': T, 'labels': lab, 'rest': r, 'G': G}
