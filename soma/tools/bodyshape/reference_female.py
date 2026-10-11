"""生成“标准女性体表”：MHR 网格，体型取 BMI 22 的女性人体测量目标，骨架比例和姿势拟合到我们的女性骨骼。
Build the reference female surface: an MHR mesh whose shape is fitted to the anthropometric
targets of a BMI-22 woman and whose skeleton proportions and pose are fitted to our female's bones.

    python tools/bodyshape/reference_female.py [--bmi 22]
    <- data/raw/bodyshape/out/mhr-sweep.json (calibrate_mhr.py), measure-female.json (measure.py)
    -> data/raw/bodyshape/out/reference-female/  skin.obj, manifest.json, weights.bin, joints.json,
       fit.json（拟合与相容性统计 / fit and containment statistics）, preview PNGs

步骤 / steps
 1 身份系数：用扫掠样本建立“系数 -> 围度”的线性代理，求使围度最接近目标（女性、她的身高、目标 BMI）
   的前 10 个系数，带正则。Identity: a linear surrogate "coefficients -> girths" from the sweep;
   solve the first 10 coefficients for the female targets at her stature and the chosen BMI (ridge).
 2 骨架与姿势：调 MHR 的肢段缩放参数和关节角，使 12 个关节中心、头顶和足底对上我们的女性骨骼。
   Skeleton and pose: MHR's segment-scale parameters and joint angles are adjusted until the 12
   joint centres, the vertex and the soles match our female skeleton.
 3 复测并迭代一次；输出网格、蒙皮权重、与内部结构的有符号距离统计。
   Re-measure, iterate once; write the mesh, skin weights and signed-distance statistics.
"""
import json
import os
import sys

import numpy as np
from scipy.optimize import least_squares

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mhrlib  # noqa: E402
from bodylib import CUR, RAW, Body, render_views  # noqa: E402
from compare import pred  # noqa: E402
from fit_check import classify, fmt, internal_points, signed_distance, summarise  # noqa: E402
from measure import JOINT_KEYS, bone_landmarks, surface_measures  # noqa: E402

OUT = os.path.join(RAW, 'out', 'reference-female')
NCOMP = 6

# 目标围度：我们的测量名 -> (数据集, 变量, 权重)
# target girths: our measure -> (dataset, variable, weight)
TARGETS = [
    ('bmiFromVolume', 'bmi', None, 3.0),
    ('waistIliacGirth', 'nhanes', 'waist', 1.0),
    ('buttockGirth', 'nhanes', 'hip', 1.0),
    ('thighMidGirth', 'nhanes', 'thigh', 1.0),
    ('calfMaxGirth', 'nhanes', 'calf', 1.0),
    ('upperArmMidGirth', 'nhanes', 'armcirc', 1.0),
    ('chestGirth', 'ansur', 'chestcircumference', 1.0),
    ('waistNavelGirth', 'ansur', 'waistcircumference', 0.5),
    ('thighProximalGirth', 'ansur', 'thighcircumference', 0.5),
    ('thighLowerGirth', 'ansur', 'lowerthighcircumference', 0.5),
    ('ankleMinGirth', 'ansur', 'anklecircumference', 0.5),
    ('wristMinGirth', 'ansur', 'wristcircumference', 0.5),
]

SCALES = ['scale_spine_length', 'scale_neck_length', 'scale_shoulder_width', 'scale_uparms', 'scale_lowarms', 'scale_hip_width',
          'scale_hip_height', 'scale_uplegs', 'scale_lowlegs', 'scale_ankle_height', 'scale_foot_length']
POSE_SIDE = ['clavicle_ry', 'clavicle_rz', 'uparm_twist', 'uparm_ry', 'uparm_rz', 'elbow_bend', 'lowarm_twist', 'upleg_ry', 'upleg_rz',
             'upleg_twist', 'knee_bend', 'foot_bend']
ROOT = ['root_tx', 'root_ty', 'root_tz']


def targets_for(model, S, bmi):
    t = {}
    for ours, ds, var, w in TARGETS:
        if ds == 'bmi':
            t[ours] = (bmi, w, 0.5)
        elif ds == 'nhanes':
            m = model['nhanes']['sexes']['F']['outputs'][var]
            t[ours] = (pred(m, S, bmi), w, pred(m, S, bmi) * m['residualSdLog'])
        else:
            m = model['sexes']['F']['outputs'][var]
            sd = np.sqrt(m['residualSdLog'] ** 2 + sum(l * l for l in m['factorLoadings']))
            t[ours] = (pred(m, S, bmi), w, pred(m, S, bmi) * sd)
    return t


def surrogate():
    rows = json.load(open(os.path.join(RAW, 'out', 'mhr-sweep.json')))
    X = np.array([r['identity'][:NCOMP] for r in rows])
    Xd = np.c_[np.ones(len(X)), X]
    fit = {}
    for ours, _, _, _ in TARGETS:
        y = np.array([r['measures'].get(ours, np.nan) for r in rows], float)
        ok = ~np.isnan(y)
        c, *_ = np.linalg.lstsq(Xd[ok], y[ok], rcond=None)
        fit[ours] = c
    return fit


def solve_identity(fit, tg, offset=None, ridge=0.6, c2_min=1.5):
    """加权岭回归求身份系数；第 2 系数（性别方向）不低于 c2_min。
    Weighted ridge solve for the identity coefficients; component 2 (sex) is kept >= c2_min."""
    A, b = [], []
    for k, (val, w, sd) in tg.items():
        c = fit[k]
        off = 0.0 if offset is None else offset.get(k, 0.0)
        A.append(w * c[1:] / sd)
        b.append(w * (val - c[0] - off) / sd)
    A, b = np.array(A), np.array(b)
    lo = np.full(NCOMP, -2.0)
    hi = np.full(NCOMP, 2.0)
    lo[0], hi[0] = -3.0, 3.0
    lo[1] = c2_min
    r = least_squares(lambda x: np.r_[A @ x - b, ridge * x], np.r_[0, max(c2_min, 1.5), np.zeros(NCOMP - 2)], bounds=(lo, hi))
    return r.x


SPINE = ['spine_lean0', 'spine_lean1', 'spine_bend0', 'spine_bend1', 'neck_lean', 'neck_bend', 'head_lean', 'head_bend', 'scale_hip_depth']
POSE_SIDE = POSE_SIDE + ['wrist_ry', 'wrist_rz']
# 额外的对应点：我们的骨 -> MHR 关节 / extra correspondences: our bone point -> MHR joint
EXTRA = [('toe', 'ball', 1.0), ('middlePip', 'middle2', 0.5), ('thumbIp', 'thumb3', 0.5)]


def extra_landmarks(fb, L):
    """足尖与手指的对应点，用来定足和手的朝向。Toe and finger points that fix foot and hand orientation."""
    E = {}
    for side, nm in (('L', 'left'), ('R', 'right')):
        t = [fb.verts(f'Proximal phalanx of {nm} {k} toe') for k in ('second', 'third')]
        # 跖趾关节处：近节趾骨靠近踝的一端 / at the MTP joints: the end of the proximal phalanx nearest the ankle
        E['toe_' + side] = np.mean([v[np.argsort(np.linalg.norm(v - L['ankle_' + side], axis=1))[:15]].mean(0) for v in t], axis=0)
        for key, bone in (('middlePip', f'Proximal phalanx of {nm} middle finger'), ('thumbIp', f'Proximal phalanx of {nm} thumb')):
            v = fb.verts(bone)
            E[key + '_' + side] = v[np.argsort(-np.linalg.norm(v - L['wrist_' + side], axis=1))[:15]].mean(0)
    return E


def fit_skeleton(identity, L, E, Pb, x0=None):
    """L: 我们女性的骨性标志；E: extra_landmarks；Pb: 用于“骨不得穿出皮肤”惩罚的骨表面采样点。
    L: bone landmarks of our female (raw frame); E: extra_landmarks; Pb: bone surface samples for
    the bones-must-stay-inside penalty. Returns the MHR parameter dict and residuals."""
    warm = x0
    names = ROOT + SCALES + SPINE + [s + '_' + p for s in 'lr' for p in POSE_SIDE]
    tgt = np.array([L[k] for k in JOINT_KEYS])
    top, floor = L['vertex'][1], L['floor'][1]
    jn = mhrlib.joint_names()
    ex = [(E[a + '_' + S], jn.index(s + '_' + j), w) for a, j, w in EXTRA for S, s in (('L', 'l'), ('R', 'r'))]
    F = mhrlib.body(identity, arms_down=False, correctives=False)['F']

    def unpack(x):
        return {n: float(v) for n, v in zip(names, x)}

    def run(x, correctives=False):
        return mhrlib.body(identity, params=unpack(x), arms_down=False, correctives=correctives, floor_to_zero=False)

    def resid(x):
        b = run(x)
        J = np.array([b['joints'][k] for k in JOINT_KEYS])
        V = b['V']
        r = [(J - tgt).ravel()]
        r += [w * (b['jointPos'][j] - p) for p, j, w in ex]
        d = signed_distance(Pb, V, F)
        # 骨点应在皮肤下至少 3 mm / bone points should lie at least 3 mm under the skin
        r.append(0.12 * np.maximum(d + 0.003, 0))
        r.append([2.0 * (V[:, 1].max() - top), 2.0 * (V[:, 1].min() - floor)])
        r.append(0.004 * np.asarray(x[3:]))
        return np.concatenate([np.ravel(v) for v in r])

    if x0 is None:
        x0 = np.zeros(len(names))
        b0 = mhrlib.body(identity, arms_down=False, correctives=False, floor_to_zero=False)
        hip0 = 0.5 * (b0['joints']['hip_L'] + b0['joints']['hip_R'])
        hipT = 0.5 * (L['hip_L'] + L['hip_R'])
        x0[:3] = (hipT - hip0) * 100 / 10.0  # root_t* 以 10 cm 为单位 / root translations are in units of 10 cm
        for s in 'lr':
            for p, v in (('uparm_ry', -0.4576), ('uparm_rz', -0.3632), ('elbow_bend', -0.353), ('uparm_twist', 0.3883)):
                x0[names.index(s + '_' + p)] = v

    def jac(x):
        # 自己做差分：MHR 是 float32，SciPy 在 x=0 处的默认步长（1.5e-8）只会得到噪声
        # own finite differences: MHR is float32 and SciPy's default step at x = 0 (1.5e-8) is noise
        r0 = resid(x)
        Jm = np.zeros((len(r0), len(x)))
        for i in range(len(x)):
            xi = np.array(x, float)
            xi[i] += 5e-3
            Jm[:, i] = (resid(xi) - r0) / 5e-3
        return Jm

    # 大腿扭转只由足尖方向约束，容易与其他量相互抵消而把皮肤拧坏，故限幅
    # thigh twist is constrained only by the toe direction and can wring the skin: keep it small
    lo = np.full(len(names), -4.0)
    hi = np.full(len(names), 4.0)
    for i, n in enumerate(names):
        if n.endswith('upleg_twist'):
            lo[i], hi[i] = -0.35, 0.35
        if n.endswith('uparm_twist'):
            lo[i], hi[i] = -0.8, 0.8
    x0 = np.clip(x0, lo + 1e-6, hi - 1e-6)
    r = least_squares(resid, x0, jac=jac, bounds=(lo, hi), max_nfev=30 if warm is None else 10)
    b = run(r.x, correctives=True)
    J = np.array([b['joints'][k] for k in JOINT_KEYS])
    err = {k: round(float(np.linalg.norm(J[i] - tgt[i]) * 1000), 1) for i, k in enumerate(JOINT_KEYS)}
    for (p, j, w), (a, _, _) in zip(ex, [e for e in EXTRA for _ in 'LR']):
        err[a + '->' + jn[j]] = round(float(np.linalg.norm(b['jointPos'][j] - p) * 1000), 1)
    return unpack(r.x), r.x, b, err


def skin_thickness(V, P_int, F_int, L):
    """皮肤顶点到内部结构表面的距离（毫米），按区域。Distance from skin vertices to the nearest
    internal surface (mm), by region."""
    import igl
    d = igl.signed_distance(np.ascontiguousarray(V), np.ascontiguousarray(P_int), np.ascontiguousarray(F_int), igl.SIGNED_DISTANCE_TYPE_UNSIGNED)[0]
    reg = classify(V, L)
    out = {}
    for rid in np.unique(reg):
        x = d[reg == rid] * 1000
        if len(x) > 20:
            out[rid] = {'n': int(len(x)), 'p10': round(float(np.percentile(x, 10)), 1), 'p50': round(float(np.percentile(x, 50)), 1),
                        'p90': round(float(np.percentile(x, 90)), 1)}
    return out


def main():
    bmi = float(sys.argv[sys.argv.index('--bmi') + 1]) if '--bmi' in sys.argv else 22.0
    tag = '' if bmi == 22.0 else f'-bmi{bmi:g}'
    out = OUT + tag
    os.makedirs(out, exist_ok=True)
    model = json.load(open(os.path.join(CUR, 'anthro-model.json')))
    fb = Body('female')
    L = bone_landmarks(fb)
    S = (L['vertex'][1] - L['floor'][1]) * 1000
    tg = targets_for(model, S, bmi)
    fit = surrogate()
    ident = solve_identity(fit, tg)
    log = [f'target: female, stature {S:.0f} mm, BMI {bmi}']
    offset, x = {}, None
    E = extra_landmarks(fb, L)
    # 惩罚用的骨点：不含手、足（它们靠对应点定向）/ bone samples for the penalty: hands and feet excluded
    Pb = fb.merged(lambda p: p['system'] == 'skeletal' and p['tissue'] == 'bone')[0]
    regb = classify(Pb, L)
    Pb = Pb[~np.isin(regb, ['hand', 'foot'])]
    Pb = Pb[np.random.default_rng(3).choice(len(Pb), 2500, replace=False)]
    NIT = 5
    for it in range(NIT):
        params, x, b, err = fit_skeleton(ident, L, E, Pb, x)
        b = mhrlib.body(ident, params=params, arms_down=False, correctives=True, floor_to_zero=False)
        ilio = 0.5 * (L['iliocristale_L'][1] + L['iliocristale_R'][1]) - L['floor'][1]
        meas = surface_measures(b['V'], b['F'], b['joints'], levels={'iliocristale': ilio})
        log.append(f'iteration {it}: identity {np.round(ident, 2).tolist()}')
        for k, (val, w, sd) in tg.items():
            log.append(f'   {k:20s} target {val:7.1f}  got {meas[k]:7.1f}  ({(meas[k] - val) / sd:+.2f} sd)')
        if it == NIT - 1:
            break
        # 代理模型在本体架上的偏差，作为下一轮的修正 / surrogate error on this skeleton, fed back
        for k in tg:
            offset[k] = offset.get(k, 0.0) + 0.7 * (meas[k] - (fit[k][0] + fit[k][1:] @ ident + offset.get(k, 0.0)))
        ident = solve_identity(fit, tg, offset)
    V, F = b['V'], b['F']
    log.append('joint fit residuals (mm): ' + json.dumps(err))

    # ---- 与内部结构的相容性 / containment of the internal model
    res = {'target': {'sex': 'F', 'statureMm': round(S, 1), 'bmi': bmi}, 'identity': [round(float(v), 4) for v in ident],
           'mhrParameters': {k: round(v, 5) for k, v in params.items()}, 'jointResidualMm': err,
           'measuresMm': {k: round(float(v), 1) for k, v in meas.items() if not k.endswith(('_L', '_R'))},
           'targets': {k: {'target': round(v[0], 1), 'got': round(float(meas[k]), 1), 'sd': round(v[2], 1)} for k, v in tg.items()}}
    for kind in ('muscle', 'bone'):
        P = internal_points(fb, kind)
        d = signed_distance(P, V, F)
        st = summarise(d, classify(P, L))
        res['containment:' + kind] = st
        log.append(f'\n== our female {kind} vertices vs the reference skin: signed distance, mm (+ = outside)\n{fmt(st)}')
    # 逐块肌肉：穿出最多的 / per muscle: worst offenders
    worst = []
    for p in fb.parts:
        if p['system'] == 'muscular' and p['tissue'] == 'muscle':
            v, _ = fb.mesh(p)
            d = signed_distance(v, V, F) * 1000
            worst.append({'id': p['id'], 'name': p['name'], 'outsideFraction': round(float((d > 0).mean()), 3), 'p95Mm': round(float(np.percentile(d, 95)), 1),
                          'maxMm': round(float(d.max()), 1)})
    worst.sort(key=lambda w: -w['p95Mm'])
    res['musclesMostOutside'] = worst[:40]
    log.append('\nmuscles poking out most (95th percentile of signed distance, mm):')
    for w in worst[:25]:
        log.append(f'   {w["p95Mm"]:6.1f}  max {w["maxMm"]:6.1f}  out {100 * w["outsideFraction"]:5.1f}%  {w["name"]}')
    Pi, Fi = fb.merged(lambda p: (p['system'] == 'muscular' and p['tissue'] in ('muscle', 'tendon')) or (p['system'] == 'skeletal' and p['tissue'] in ('bone', 'cartilage')))
    res['softTissueOverEnvelopeMm'] = {'referenceSkinOverFemaleInternals': skin_thickness(V, Pi, Fi, L)}
    sv, _ = fb.skin()
    res['softTissueOverEnvelopeMm']['currentFemaleSkinOverFemaleInternals'] = skin_thickness(sv, Pi, Fi, L)
    mb = Body('male')
    Lm = bone_landmarks(mb)
    Pm, Fm = mb.merged(lambda p: (p['system'] == 'muscular' and p['tissue'] in ('muscle', 'tendon')) or (p['system'] == 'skeletal' and p['tissue'] in ('bone', 'cartilage')))
    res['softTissueOverEnvelopeMm']['maleSkinOverMaleInternals'] = skin_thickness(mb.skin()[0], Pm, Fm, Lm)
    log.append('\nskin -> nearest muscle/bone surface, median (p10-p90) mm by region:')
    log.append(f'{"region":10s} {"reference/female":>22s} {"current female skin":>22s} {"male skin/male":>22s}')
    T = res['softTissueOverEnvelopeMm']
    for rid in T['referenceSkinOverFemaleInternals']:
        s = f'{rid:10s}'
        for key in ('referenceSkinOverFemaleInternals', 'currentFemaleSkinOverFemaleInternals', 'maleSkinOverMaleInternals'):
            t = T[key].get(rid)
            s += f'{t["p50"]:8.1f} ({t["p10"]:4.1f}-{t["p90"]:5.1f})' if t else ' ' * 22
        log.append(s)

    # ---- 输出 / outputs
    with open(os.path.join(out, 'skin.obj'), 'w') as f:
        f.write('# reference female surface; MHR LOD1 topology (Apache-2.0); metres, Y up, +Z anterior, +X left\n')
        for v in V:
            f.write(f'v {v[0]:.5f} {v[1]:.5f} {v[2]:.5f}\n')
        for t in F:
            f.write(f'f {t[0] + 1} {t[1] + 1} {t[2] + 1}\n')
    vi, ji, w, parents = mhrlib.skin_weights()
    rec = np.zeros(len(vi), dtype=[('v', '<u4'), ('j', '<u4'), ('w', '<f4')])
    rec['v'], rec['j'], rec['w'] = vi, ji, w
    rec.tofile(os.path.join(out, 'weights.bin'))
    json.dump({'names': b['jointNames'], 'parents': parents.tolist(), 'positions': np.round(b['jointPos'], 5).tolist(),
               'note': {'zh': '拟合姿势下的关节位置（米，我们的坐标系）；parents 为父关节下标', 'en': 'joint positions in the fitted pose (metres, our frame); parents index into names'}},
              open(os.path.join(out, 'joints.json'), 'w'), ensure_ascii=False)
    json.dump({
        'schema': 1,
        'what': {'zh': f'标准女性体表（参考用）：女性，身高 {S / 1000:.3f} m（与我们的女性骨骼一致），BMI {bmi:g}；围度目标来自 NHANES/ANSUR II 回归',
                 'en': f'Reference female surface: female, stature {S / 1000:.3f} m (that of our female skeleton), BMI {bmi:g}; girth targets from the NHANES / ANSUR II regressions'},
        'source': {'name': 'Momentum Human Rig (MHR) v1.0.1, LOD 1', 'url': 'https://github.com/facebookresearch/MHR', 'license': 'Apache-2.0',
                   'attribution': 'MHR, Copyright (c) Meta Platforms, Inc. and affiliates, Apache License 2.0'},
        'frame': 'metres, Y up, +Z anterior, +X subject left; same origin as public/anatomy/female',
        'files': {'skin.obj': f'{len(V)} vertices, {len(F)} triangles, vertex order = MHR LOD1',
                  'weights.bin': f'{len(vi)} records of (uint32 vertex, uint32 joint, float32 weight), little endian; linear blend skinning',
                  'joints.json': '127 joints: names, parents, positions in this pose',
                  'fit.json': 'identity coefficients, MHR parameters, measurements, containment statistics'},
        'pose': {'zh': '站立，上肢下垂，关节中心拟合到我们的女性骨骼', 'en': 'standing, arms hanging; joint centres fitted to our female skeleton'},
    }, open(os.path.join(out, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
    json.dump(res, open(os.path.join(out, 'fit.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(out, 'fit.txt'), 'w').write('\n'.join(log))
    print('\n'.join(log))

    # ---- 预览 / previews
    skin = (0.86, 0.72, 0.62)
    render_views([(V, F, skin)], os.path.join(out, 'preview-skin.png'), height=1000)
    bv, bf = fb.merged(lambda p: p['system'] == 'skeletal' and p['tissue'] == 'bone')
    mv, mf = fb.merged(lambda p: p['system'] == 'muscular' and p['tissue'] == 'muscle')
    render_views([(V, F, skin), (mv, mf, (0.75, 0.15, 0.15)), (bv, bf, (0.95, 0.95, 0.85))], os.path.join(out, 'preview-pokes.png'), height=1000,
                 title='reference skin with our female muscles (red) and bones (white): whatever shows is outside the skin')
    render_views([(mv, mf, (0.66, 0.27, 0.25)), (bv, bf, (0.92, 0.9, 0.8))], os.path.join(out, 'preview-internals.png'), height=1000)
    sv, sf = fb.skin()
    render_views([(sv, sf, skin)], os.path.join(out, 'preview-current-skin.png'), height=1000)


if __name__ == '__main__':
    main()
