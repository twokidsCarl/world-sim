"""Meta MHR（Momentum Human Rig）封装：按身份系数生成我们坐标系下、手臂下垂的皮肤网格和关节。
Wrapper around Meta's MHR (Momentum Human Rig, Apache-2.0): skin mesh and joints for a set of
identity coefficients, in our frame (MHR is already Y up, +Z anterior, +X left; centimetres),
posed with the arms hanging.

LOD1（18439 顶点）只用 TorchScript 模型 assets/mhr_model.pt；LOD0（73639 顶点）等用 mhr 包。
LOD 1 (18 439 vertices) uses only the TorchScript model assets/mhr_model.pt; LOD 0 (73 639) and others use the mhr package.
参数名取自 assets/compact_v6_1.model 中首次出现的顺序（共 204 个，已用摆臂验证）。
Parameter names are taken in order of first appearance in assets/compact_v6_1.model (204; checked
by posing the arms).
"""
import os
import re

import numpy as np
import torch

DIR = 'data/raw/bodyshape/models/mhr/assets'
_M = {}
_NAMES = None

# 各 LOD 的顶点数（MHR 自带 7 级；身份形变和蒙皮权重每一级都有）
# vertex counts of the 7 LODs MHR ships (identity blendshapes and skin weights exist at every level)
LOD_VERTICES = {0: 73639, 1: 18439, 2: 10661, 3: 4899, 4: 2461, 5: 971, 6: 595}


def model(lod=1):
    """lod=1：只用 TorchScript 文件 mhr_model.pt（不需要 pymomentum）；其他 LOD 用 mhr 包
    （pip install mhr pymomentum-cpu）读 lod<k>.fbx 和 corrective_blendshapes_lod<k>.npz。
    lod=1 uses the TorchScript file alone; any other LOD goes through the mhr package and reads
    lod<k>.fbx and corrective_blendshapes_lod<k>.npz."""
    global _NAMES
    if lod not in _M:
        import warnings
        warnings.simplefilter('ignore')
        if lod == 1 and os.path.exists(os.path.join(DIR, 'mhr_model.pt')):
            _M[lod] = torch.jit.load(os.path.join(DIR, 'mhr_model.pt'), map_location='cpu')
        else:
            import pathlib
            from mhr.mhr import MHR
            _M[lod] = MHR.from_files(folder=pathlib.Path(DIR), device=torch.device('cpu'), lod=lod)
    if _NAMES is None:
        names = []
        for line in open(os.path.join(DIR, 'compact_v6_1.model')).read().splitlines():
            if '=' in line and not line.startswith('#') and not line.startswith('limit'):
                for tok in re.findall(r'\*\s*([A-Za-z_][A-Za-z0-9_]*)', line.split('=', 1)[1]):
                    if tok not in names:
                        names.append(tok)
        _NAMES = names
    return _M[lod]


def param_names():
    model()
    return _NAMES


def joint_names(lod=1):
    return list(model(lod).character_torch.skeleton.joint_names)


def faces(lod=1):
    return model(lod).character_torch.mesh.faces.numpy().astype(np.int64)


def run(identity, mp, lod=1, correctives=True):
    """直接调用：identity (45,)、mp (204,) -> 顶点（米）、关节位置（米）、关节状态。
    Raw call: identity (45,), model parameters (204,) -> vertices (m), joint positions (m), skeleton state."""
    m = model(lod)
    idc = torch.zeros(1, 45)
    idc[0, :len(identity)] = torch.as_tensor(np.asarray(identity, dtype=np.float32))
    with torch.no_grad():
        v, sk = m(idc, torch.as_tensor(np.asarray(mp, dtype=np.float32))[None], torch.zeros(1, 72), correctives)
    sk = sk[0].numpy().astype(np.float64)
    return v[0].numpy().astype(np.float64) / 100.0, sk[:, :3] / 100.0, sk


def body(identity=None, params=None, arms_down=True, correctives=True, floor_to_zero=True, lod=1):
    """identity: 至多 45 个系数（前 20 个为身体）/ up to 45 coefficients (first 20 = body).
    params: {参数名: 值} / {parameter name: value}.  Returns dict V (m), F, joints, skel."""
    model(lod)
    mp = np.zeros(204)
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
        mp[_NAMES.index(k)] = v
    V, pos, sk = run(np.zeros(45) if identity is None else identity, mp, lod, correctives)
    floor = V[:, 1].min() if floor_to_zero else 0.0
    V[:, 1] -= floor
    pos[:, 1] -= floor
    jn = joint_names(lod)
    J = {}
    for side, s in (('L', 'l'), ('R', 'r')):
        for ours, b in (('shoulder', 'uparm'), ('elbow', 'lowarm'), ('wrist', 'wrist'), ('hip', 'upleg'), ('knee', 'lowleg'), ('ankle', 'foot')):
            J[ours + '_' + side] = pos[jn.index(f'{s}_{b}')]
    return {'V': V, 'F': faces(lod), 'joints': J, 'jointPos': pos, 'jointNames': jn, 'skel': sk}


def skin_weights(lod=1):
    """蒙皮权重（稀疏三元组）：顶点号、关节号、权重；以及父关节下标。
    Skinning weights as sparse triples (vertex index, joint index, weight), plus joint parents."""
    m = model(lod)
    par = m.character_torch.skeleton.joint_parents.numpy().astype(np.int32)
    if hasattr(m, 'character'):
        w, ix = np.asarray(m.character.skin_weights.weight), np.asarray(m.character.skin_weights.index)
        vi, k = np.nonzero(w > 0)
        return vi.astype(np.uint32), ix[vi, k].astype(np.uint32), w[vi, k].astype(np.float32), par
    lb = m.character_torch.linear_blend_skinning
    return (lb.vert_indices_flattened.numpy().astype(np.uint32), lb.skin_indices_flattened.numpy().astype(np.uint32),
            lb.skin_weights_flattened.numpy().astype(np.float32), par)
