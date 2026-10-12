"""运行时体型场：胖瘦位移场、性别差异场和凹处的位移上限（MHR 拓扑，我们的静止姿势和坐标系）。
Runtime shape fields in MHR topology, in our rest pose and frame: the fatness displacement field,
the sex-difference field and the displacement limit at concavities.

    python tools/bodyshape/shape_fields.py male [--dir male-skin]
    <- data/raw/bodyshape/out/<dir>/fit.json  (fit_skin.py)
    -> shape-fat.f32     float32 [n][3]  每个 BMI 点的位移（米）/ displacement per BMI point (m)
       shape-sex.f32     float32 [n][3]  MHR 第 2 身份系数每单位的位移（正 = 女性化）
                                         displacement per unit of MHR identity coefficient 2 (+ = female)
       shape-limit.f32   float32 [n]     沿胖瘦场方向的最大位移（米）；到对面皮肤距离的一半
                                         largest displacement along the fat field (m): half the distance
                                         to the facing skin
       shape-fields.json 说明、线性检验 / description and linearity checks

MHR 的蒙皮是线性的，身份形变也是线性的，所以固定姿势下顶点对身份系数严格线性：
位移场就是 dV/dc，与当前体型无关。
MHR skinning is linear and so are its identity blendshapes: at a fixed pose vertices are exactly
linear in the identity coefficients, so the fields are dV/dc and do not depend on the current shape.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mhrlib  # noqa: E402
from bodylib import CUR, RAW, render_views  # noqa: E402
from compare import pred  # noqa: E402
from fit_skin import NCOMP, surrogate, targets_for  # noqa: E402
from measure import mesh_volume, surface_measures  # noqa: E402

GIRTHS = [('waistIliacGirth', 'nhanes', 'waist'), ('buttockGirth', 'nhanes', 'hip'), ('thighMidGirth', 'nhanes', 'thigh'),
          ('calfMaxGirth', 'nhanes', 'calf'), ('upperArmMidGirth', 'nhanes', 'armcirc'), ('chestGirth', 'ansur', 'chestcircumference')]


def joints_of(P, jn):
    return {f'{a}_{Sd}': P[jn.index(f'{s}_{m}')] for Sd, s in (('L', 'l'), ('R', 'r'))
            for a, m in (('shoulder', 'uparm'), ('elbow', 'lowarm'), ('wrist', 'wrist'), ('hip', 'upleg'), ('knee', 'lowleg'), ('ankle', 'foot'))}


def survey_girth(model, sex, ds, var, S, B):
    if ds == 'nhanes':
        return pred(model['nhanes']['sexes'][sex]['outputs'][var], S, B)
    return pred(model['sexes'][sex]['outputs'][var], S, B)


def main():
    name = sys.argv[1]
    d = os.path.join(RAW, 'out', sys.argv[sys.argv.index('--dir') + 1] if '--dir' in sys.argv else f'{name}-skin')
    sex = 'F' if name == 'female' else 'M'
    # 身份系数、参数取自包里的最终状态（包住、头部重拟合之后的），不取 fit.json：后者是最初拟合时的值。
    # Identity and parameters come from the final state in the package (after the enclosure and the head refit), not from fit.json, which holds the values of the first fit.
    stf = np.load(os.path.join(d, 'fit-state-final.npz'))
    lod, ident, mp = int(stf['lod']), stf['identity'].astype(float), stf['mp'].astype(float)
    names = mhrlib.param_names()
    off = np.fromfile(os.path.join(d, 'residual-offsets.f32'), dtype=np.float32).reshape(-1, 3).astype(float)
    model = json.load(open(os.path.join(CUR, 'anthro-model.json')))
    lines = []

    def body(dc, lod_=lod):
        c = ident.copy()
        c[:len(dc)] += dc
        return mhrlib.run(c, mp, lod_, True)

    V0, P0, _ = body([0])
    V0 = V0 + off
    F = mhrlib.faces(lod)
    jn = mhrlib.joint_names(lod)
    H = V0[:, 1].max() - V0[:, 1].min()
    d1 = (body([1.0])[0] - body([-1.0])[0]) / 2.0
    d2 = (body([0, 1.0])[0] - body([0, -1.0])[0]) / 2.0
    # 本体上每单位 c1 对应多少 BMI：用体积求 / BMI per unit of c1 on this body, from volumes
    bmi = lambda V: mesh_volume(V, F) * 1010.0 / H ** 2
    b0 = bmi(V0)
    k = (bmi(V0 + d1) - bmi(V0 - d1)) / 2.0
    fat = d1 / k  # 先用第 1 分量；下面若校准方向更好则替换 / component 1 for now; replaced below by the calibrated direction
    lines.append(f'{name}: rest BMI (volume) {b0:.2f}; dBMI/dc1 = {k:.2f}; stature {H * 1000:.0f} mm; LOD {lod}, {len(V0)} vertices')
    mag = np.linalg.norm(fat, axis=1) * 1000
    lines.append(f'fat field magnitude per BMI point: median {np.median(mag):.2f} mm, 95th percentile {np.percentile(mag, 95):.2f} mm, max {mag.max():.2f} mm')

    # ---- 线性检验 2：在身份空间里，一条直线、两段折线与逐点最优相比（用扫掠样本的线性代理）
    # ---- linearity check 2: in identity space, one line vs two segments vs the per-BMI optimum (sweep surrogate)
    sur = surrogate()
    Bs = np.array([17, 18.5, 20, 22, 25, 27.5, 30, 35, 40.0])
    keys = [t for t in sur]

    def solve_at(B):
        tg = targets_for(model, sex, H * 1000, B)
        A = np.array([tg[q][1] * np.delete(sur[q][1:], 1) / tg[q][2] for q in keys])
        b = np.array([tg[q][1] * (tg[q][0] - sur[q][0] - sur[q][2] * ident[1]) / tg[q][2] for q in keys])
        return np.linalg.lstsq(np.vstack([A, 0.3 * np.eye(NCOMP - 1)]), np.r_[b, np.zeros(NCOMP - 1)], rcond=None)[0]

    def err(B, c):
        tg = targets_for(model, sex, H * 1000, B)
        cc = np.insert(c, 1, ident[1])
        return np.array([(sur[q][0] + sur[q][1:] @ cc - tg[q][0]) for q in keys if q != 'bmiFromVolume'])

    C = np.array([solve_at(B) for B in Bs])
    X1 = np.c_[np.ones(len(Bs)), Bs]
    line = X1 @ np.linalg.lstsq(X1, C, rcond=None)[0]
    res = {}
    for knee in (25.0, 27.5, 30.0):
        X2 = np.c_[np.ones(len(Bs)), Bs, np.maximum(Bs - knee, 0)]
        two = X2 @ np.linalg.lstsq(X2, C, rcond=None)[0]
        res[knee] = two
    only1 = C.copy()
    only1[:, 1:] = C[np.argmin(abs(Bs - 22)), 1:]
    a1 = np.polyfit(Bs, C[:, 0], 1)
    only1[:, 0] = np.polyval(a1, Bs)
    rms = lambda M: float(np.sqrt(np.mean([np.mean(err(B, c) ** 2) for B, c in zip(Bs, M)])))
    worst = lambda M: float(max(np.abs(err(B, c)).max() for B, c in zip(Bs, M)))
    tab = {'perBmiOptimum': (rms(C), worst(C)), 'oneLineSixComponents': (rms(line), worst(line)), 'componentOneOnly': (rms(only1), worst(only1))}
    for knee, two in res.items():
        tab[f'twoSegmentsKneeAt{knee:g}'] = (rms(two), worst(two))
    lines.append('\ngirth error against survey targets over BMI 17-40 (11 girths; RMS mm / worst mm), identity path models:')
    for q, v in tab.items():
        lines.append(f'  {q:28s} {v[0]:6.1f} / {v[1]:6.1f}')
    lines.append('  coefficient path c1,c3..c6 at BMI ' + ', '.join(f'{B:g}: {np.round(c, 2).tolist()}' for B, c in zip(Bs[[0, 3, 6, 8]], C[[0, 3, 6, 8]])))

    # 调查数据校准的方向：身份空间里那条直线的斜率（每个 BMI 点各系数的变化；第 2 系数不动）
    # survey-calibrated direction: slope of that line in identity space (coefficient change per BMI point; coefficient 2 fixed)
    slope6 = np.insert(np.linalg.lstsq(X1, C, rcond=None)[0][1], 1, 0.0)
    dV = [(body(np.eye(NCOMP)[j])[0] - body(-np.eye(NCOMP)[j])[0]) / 2.0 for j in range(NCOMP)]
    cal = sum(sj * dj for sj, dj in zip(slope6, dV))
    kc = (bmi(V0 + cal) - bmi(V0 - cal)) / 2.0
    cal, slope6 = cal / kc, slope6 / kc
    lines.append(f'calibrated direction per BMI point (c1..c6): {np.round(slope6, 4).tolist()}  (component 1 alone would be {1 / k:.4f})')

    # ---- 线性检验 1：沿单一场走，BMI 与围度；与调查数据（NHANES / ANSUR）比较
    # ---- linearity check 1: walk along the single field; BMI and girths against the surveys
    F1 = mhrlib.faces(1)
    jn1 = mhrlib.joint_names(1)
    checks = {}
    for label, dirn in (('componentOne', np.eye(NCOMP)[0] / k), ('calibrated', slope6)):
      rows = []
      lines.append(f'\n#### field: {label}')
      lines.append('\nsingle linear field: requested BMI -> BMI from volume; girth of the mesh (survey value in brackets), mm')
      lines.append('  req   vol   ' + '  '.join(f'{g[0][:-5]:>16s}' for g in GIRTHS))
      for B in (17, 18.5, 20, 22, 25, 27.5, 30, 35, 40):
          V1, P1, _ = body((B - b0) * dirn, 1)
          m = surface_measures(V1, F1, joints_of(P1, jn1))
          row = {'bmiRequested': B, 'bmiFromVolume': round(float(m['bmiFromVolume']), 2), 'girthsMm': {}}
          s = f'  {B:4.1f} {m["bmiFromVolume"]:5.1f}  '
          for g, ds, var in GIRTHS:
              sv = survey_girth(model, sex, ds, var, H * 1000, B)
              row['girthsMm'][g] = {'mesh': round(float(m[g]), 1), 'survey': round(sv, 1)}
              s += f'{m[g]:7.0f} ({sv:5.0f})  '
          rows.append(row)
          lines.append(s)
      # 把网格围度相对静止点的变化与调查数据的变化相比（消去体型本身的偏差）
      # compare the CHANGE from the rest point with the survey's change (removes the body's own offset)
      ref = min(rows, key=lambda r: abs(r['bmiRequested'] - round(b0)))
      lines.append(f'\nchange relative to BMI {ref["bmiRequested"]}: mesh minus survey, mm (0 = the field reproduces how real people change)')
      lines.append('  req  ' + '  '.join(f'{g[0][:-5]:>12s}' for g in GIRTHS) + '   BMI(vol)-req')
      dev = {}
      for r in rows:
          s = f'  {r["bmiRequested"]:4.1f} '
          for g, _, _ in GIRTHS:
              e = (r['girthsMm'][g]['mesh'] - ref['girthsMm'][g]['mesh']) - (r['girthsMm'][g]['survey'] - ref['girthsMm'][g]['survey'])
              dev.setdefault(g, []).append(round(e, 1))
              s += f'{e:+12.0f}  '
          lines.append(s + f'   {r["bmiFromVolume"] - r["bmiRequested"]:+.1f}')
      checks[label] = {'rows': rows, 'changeVsSurveyMm': dev}

    # ---- 位移上限：沿胖瘦场方向前进，第一次进入网格内部的距离的一半
    # ---- displacement limit: half the distance along the fat-field direction to the first re-entry into the mesh
    import igl
    fat = cal
    mag = np.linalg.norm(fat, axis=1)
    u = fat / np.maximum(mag, 1e-12)[:, None]
    nrm = np.cross(V0[F[:, 1]] - V0[F[:, 0]], V0[F[:, 2]] - V0[F[:, 0]])
    vn = np.zeros_like(V0)
    for q in range(3):
        np.add.at(vn, F[:, q], nrm)
    vn /= np.maximum(np.linalg.norm(vn, axis=1), 1e-12)[:, None]
    limit = np.full(len(V0), 1.0, dtype=np.float32)
    ts = np.arange(0.002, 0.1001, 0.002)
    # 只对“向外、且位移不可忽略”的顶点求上限；其余（面部细节、手、口腔和眼球等）不限
    # only vertices that move outwards by a non-negligible amount get a limit; the rest (facial detail, hands, mouth and eyes) are unlimited
    undecided = (mag > 5e-5) & (np.einsum('ij,ij->i', u, vn) > 0.3)
    considered = undecided.copy()
    Vc, Fc = np.ascontiguousarray(V0), np.ascontiguousarray(F)
    for t in ts:
        idx = np.where(undecided)[0]
        if not len(idx):
            break
        w = igl.fast_winding_number(Vc, Fc, np.ascontiguousarray(V0[idx] + t * u[idx]))
        hit = w > 0.5
        limit[idx[hit]] = max(t - 0.002, 0.0) / 2.0
        undecided[idx[hit]] = False
    lim_mm = limit * 1000
    capped = limit < 0.9
    lines.append(f'\ndisplacement limit ({considered.mean() * 100:.0f} % of vertices move outwards and were tested): {capped.mean() * 100:.1f} % of vertices have a facing surface within 100 mm along the field; '
                 f'{(lim_mm < 5).mean() * 100:.1f} % are limited to < 5 mm, {(lim_mm < 1).mean() * 100:.1f} % to < 1 mm')
    with np.errstate(divide='ignore'):
        dB = np.where(capped, limit / np.maximum(np.linalg.norm(fat, axis=1), 1e-9), np.inf)
    for b in (2, 5, 10, 15):
        lines.append(f'   vertices that would cross the facing skin before +{b} BMI points: {(dB < b).mean() * 100:.2f} %')

    # 线性位移使体积按二次增长：给出“目标 BMI -> 场的倍数”的查找表，使体积 BMI 与目标一致
    # a linear displacement makes volume grow quadratically: a lookup "target BMI -> field multiplier" keeps the volume BMI on target
    cr = checks['calibrated']['rows']
    units = np.array([r['bmiRequested'] - b0 for r in cr])
    vol = np.array([r['bmiFromVolume'] for r in cr])
    # 这些行是在不带逐顶点偏移的纯 MHR 曲面（LOD1）上量的，它比交付的皮肤瘦；表要以交付的皮肤为零点：
    # 把体积 BMI 整体平移，使倍数 0 对应交付皮肤的体积 BMI（restBmi）。
    # These rows are measured on the pure MHR surface (LOD 1) without the per-vertex offsets, which is leaner than the
    # delivered skin; the table has to have its zero at the delivered skin, so the volume BMI is shifted as a whole
    # until multiplier 0 corresponds to the volume BMI of the delivered skin (restBmi).
    vol = vol + (b0 - float(np.interp(0.0, units, vol)))
    tgt = [16, 17, 18.5, 20, 22, 24, 26, 28, 30, 32, 35, 38, 40]
    table = [[float(t), round(float(np.interp(t, vol, units)), 2)] for t in tgt if vol.min() <= t <= vol.max()]
    lines.append('target BMI -> field multiplier (BMI points of field): ' + ', '.join(f'{a:g}: {b:+.2f}' for a, b in table))

    # 中心型体型场：BMI 不变时，中心型因子（anthro-model 的第二个因子）每 +1 SD 的皮肤位移。
    # 只有 ANSUR 的围度带因子载荷，所以由这些围度的变化解身份系数的变化（第 2 分量和体积 BMI 不动）。
    # Central-build field: skin displacement per +1 SD of the central-build factor (the second factor of the anthro
    # model) at constant BMI. Only the ANSUR girths carry factor loadings, so the change of identity is solved from the
    # change of those girths (component 2 and the volume BMI held).
    from fit_skin import TARGETS
    rowsA, rhsA = [], []
    for ours, ds, var, wgt in TARGETS:
        if ds == 'ansur':
            mdl = model['sexes'][sex]['outputs'][var]
            g0 = float(sur[ours][0] + sur[ours][1:] @ ident[:NCOMP])
            rowsA.append(sur[ours][1:] / max(g0, 1e-9))
            rhsA.append(np.exp(mdl['factorLoadings'][1]) - 1.0)
    Ac = np.array(rowsA)
    hold = np.vstack([10.0 * sur['bmiFromVolume'][1:] / 22.0, 10.0 * np.eye(NCOMP)[1]])
    dc_central = np.linalg.lstsq(np.vstack([Ac, hold, 0.02 * np.eye(NCOMP)]), np.r_[rhsA, np.zeros(2 + NCOMP)], rcond=None)[0]
    central = body(dc_central)[0] - body(np.zeros(NCOMP))[0]
    central.astype(np.float32).tofile(os.path.join(d, 'shape-central.f32'))
    lines.append(f'central-build field: identity change per +1 SD {np.round(dc_central, 3).tolist()}; displacement p50 {np.median(np.linalg.norm(central, axis=1)) * 1000:.1f} mm, max {np.linalg.norm(central, axis=1).max() * 1000:.1f} mm; '
                 f'girth change wanted (ANSUR loadings) {np.round(np.array(rhsA) * 100, 1).tolist()} %, obtained by the linear model {np.round(Ac @ dc_central * 100, 1).tolist()} %')
    fat.astype(np.float32).tofile(os.path.join(d, 'shape-fat.f32'))
    d2.astype(np.float32).tofile(os.path.join(d, 'shape-sex.f32'))
    limit.tofile(os.path.join(d, 'shape-limit.f32'))
    json.dump({
        'schema': 1,
        'what': {'zh': '运行时体型场（MHR 拓扑，顶点顺序同 skin.obj）', 'en': 'runtime shape fields (MHR topology, vertex order of skin.obj)'},
        'restBmi': round(b0, 2), 'bmiPerMhrComponent1': round(k, 3), 'vertices': int(len(V0)),
        'bmiToFieldUnits': {'note': {'zh': '目标 BMI -> 场的倍数（线性插值）；倍数 = 0 即静止', 'en': 'target BMI -> multiplier of the fat field (interpolate linearly); 0 = rest'}, 'table': table},
        'fields': {
            'shape-fat.f32': {'type': 'float32[n][3]', 'unit': 'm per BMI point', 'use': 'skin += m(bmi) * fat with m from bmiToFieldUnits, each vertex clamped so that |displacement| <= limit'},
            'shape-sex.f32': {'type': 'float32[n][3]', 'unit': 'm per unit of MHR identity coefficient 2 (+ = female build)', 'use': 'optional second control; not needed for the default bodies'},
            'shape-central.f32': {'type': 'float32[n][3]', 'unit': 'm per +1 SD of the central-build control (centralBuild) at constant BMI', 'use': 'skin += centralBuild * central; from the ANSUR factor loadings of the anthro model, solved in MHR identity components 1-6 with component 2 and the volume BMI held'},
            'shape-limit.f32': {'type': 'float32[n]', 'unit': 'm', 'use': 'largest outward displacement along the fat field before the facing skin is reached (1.0 = no facing surface within 100 mm)'}},
        'fatFieldDirectionPerBmiPoint': {'mhrIdentityCoefficients1to6': [round(float(v), 5) for v in slope6]},
        'singleFieldChecks': checks,
        'identityPathModelsRmsWorstMm': {q: [round(v[0], 1), round(v[1], 1)] for q, v in tab.items()},
        'note': {'zh': '胖瘦场 = MHR 前 6 个身份分量（第 2 个除外）按 fatFieldDirectionPerBmiPoint 组合后在本姿势下的顶点位移；该方向由 NHANES/ANSUR 围度随 BMI 的变化校准，并归一到每单位 = 1 个 BMI 点（按体积）。固定姿势下对系数严格线性。',
                 'en': 'fat field = vertex displacement at this pose of MHR identity components 1-6 (2 excluded) combined as fatFieldDirectionPerBmiPoint; the direction is calibrated on how NHANES/ANSUR girths change with BMI and normalised to one BMI point (by volume) per unit. Exactly linear in the coefficients at a fixed pose.'},
    }, open(os.path.join(d, 'shape-fields.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(d, 'shape-fields.txt'), 'w').write('\n'.join(lines))
    print('\n'.join(lines))

    # 预览：静止、+8、限幅后的 +8，以及 -4 / preview: rest, +8 BMI raw and clamped, -4
    skin = (0.86, 0.72, 0.62)
    for tag, db, clamp in (('plus8', 8.0, True), ('plus8-unclamped', 8.0, False), ('minus4', -4.0, True), ('plus15', 15.0, True)):
        disp = db * fat
        if clamp and db > 0:
            ln = np.linalg.norm(disp, axis=1)
            disp = disp * np.minimum(1.0, limit / np.maximum(ln, 1e-9))[:, None]
        render_views([(V0 + disp, F, skin)], os.path.join(d, f'preview-bmi-{tag}.png'), height=900)


if __name__ == '__main__':
    main()
