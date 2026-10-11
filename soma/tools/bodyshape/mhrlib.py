"""Meta MHR（Momentum Human Rig）封装：按身份系数生成我们坐标系下、手臂下垂的皮肤网格和关节。
Wrapper around Meta's MHR (Momentum Human Rig, Apache-2.0): skin mesh and joints for a set of
identity coefficients, in our frame (MHR is already Y up, +Z anterior, +X left; centimetres),
posed with the arms hanging.

只用 TorchScript 模型 assets/mhr_model.pt（LOD1，18439 顶点），不需要 pymomentum。
Uses only the TorchScript model assets/mhr_model.pt (LOD 1, 18 439 vertices); no pymomentum.
参数名取自 assets/compact_v6_1.model 中首次出现的顺序（共 204 个，已用摆臂验证）。
Parameter names are taken in order of first appearance in assets/compact_v6_1.model (204; checked
by posing the arms).
"""
import os
import re

import numpy as np
import torch

DIR = 'data/raw/bodyshape/models/mhr/assets'
_M = None
_NAMES = None


def model():
    global _M, _NAMES
    if _M is None:
        import warnings
        warnings.simplefilter('ignore')
        _M = torch.jit.load(os.path.join(DIR, 'mhr_model.pt'), map_location='cpu')
        names = []
        for line in open(os.path.join(DIR, 'compact_v6_1.model')).read().splitlines():
            if '=' in line and not line.startswith('#') and not line.startswith('limit'):
                for tok in re.findall(r'\*\s*([A-Za-z_][A-Za-z0-9_]*)', line.split('=', 1)[1]):
                    if tok not in names:
                        names.append(tok)
        _NAMES = names
    return _M


def param_names():
    model()
    return _NAMES


def joint_names():
    return list(model().character_torch.skeleton.joint_names)


def body(identity=None, params=None, arms_down=True, correctives=True, floor_to_zero=True):
    """identity: 至多 45 个系数（前 20 个为身体）/ up to 45 coefficients (first 20 = body).
    params: {参数名: 值} / {parameter name: value}.  Returns dict V (m), F, joints, skel."""
    m = model()
    idc = torch.zeros(1, 45)
    if identity is not None:
        idc[0, :len(identity)] = torch.tensor(np.asarray(identity, dtype=np.float32))
    mp = torch.zeros(1, 204)
    P = dict(params or {})
    if arms_down:
        # 静止为 A 字姿势；下列四个参数把上臂摆到外展 9.6 度、前臂前屈 12 度（与我们的男性模型一致，
        # 由 Nelder-Mead 对关节方向拟合得到）
        # Rest is an A-pose; these four values put the upper arm at 9.6 deg abduction and the forearm
        # 12 deg forward, like our male body (fitted to the joint directions with Nelder-Mead).
        for sd in 'lr':
            P.setdefault(sd + '_uparm_ry', -0.4576)
            P.setdefault(sd + '_uparm_rz', -0.3632)
            P.setdefault(sd + '_elbow_bend', -0.353)
            P.setdefault(sd + '_uparm_twist', 0.3883)
    for k, v in P.items():
        mp[0, _NAMES.index(k)] = v
    with torch.no_grad():
        v, sk = m(idc, mp, torch.zeros(1, 72), correctives)
    V = v[0].numpy().astype(np.float64) / 100.0
    sk = sk[0].numpy().astype(np.float64)
    floor = V[:, 1].min() if floor_to_zero else 0.0
    V[:, 1] -= floor
    jn = joint_names()
    pos = sk[:, :3] / 100.0
    pos[:, 1] -= floor
    J = {}
    for side, s in (('L', 'l'), ('R', 'r')):
        for ours, b in (('shoulder', 'uparm'), ('elbow', 'lowarm'), ('wrist', 'wrist'), ('hip', 'upleg'), ('knee', 'lowleg'), ('ankle', 'foot')):
            J[ours + '_' + side] = pos[jn.index(f'{s}_{b}')]
    F = m.character_torch.mesh.faces.numpy().astype(np.int64)
    return {'V': V, 'F': F, 'joints': J, 'jointPos': pos, 'jointNames': jn, 'skel': sk}


def skin_weights():
    """蒙皮权重（稀疏三元组）：顶点号、关节号、权重。Skinning weights as sparse triples
    (vertex index, joint index, weight); joint parents alongside."""
    m = model()
    lb = m.character_torch.linear_blend_skinning
    return (lb.vert_indices_flattened.numpy().astype(np.uint32), lb.skin_indices_flattened.numpy().astype(np.uint32),
            lb.skin_weights_flattened.numpy().astype(np.float32), m.character_torch.skeleton.joint_parents.numpy().astype(np.int32))
