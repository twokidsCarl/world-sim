"""女性皮肤的合成：位置和粗细取“按深部结构包络拟合”的皮肤，乳房取女性体型的 MHR，头取 MHR 的平均头。
Composition of the female skin: placement and girth from the skin fitted to the deep envelope,
breasts from the female-shaped MHR, head from MHR's mean head.

    python tools/bodyshape/compose_female.py [--bmi 21.6]
    <- data/raw/bodyshape/out/female-skin/fit-state.npz   (fit_skin.py female --mode envelope)
    -> 同一文件改写（原文件另存为 fit-state-envelope.npz）/ the same file rewritten (the original kept as fit-state-envelope.npz)

为什么 / why
  只按围度目标拟合（女性体型的 MHR）：关节都对上了（肩肘腕髋踝 1–4 mm），但皮肤截面相对她的深部结构偏 10–19 mm
  （前臂偏内前，躯干中段偏前 12–19 mm、背侧缺 26–28 mm）：她的肌肉是形变的男性肌肉，质量分布与女性体表不一致。
  只按包络拟合：全部包得住、围度在标准值、BMI 21.6，但那是“深部结构 + 均匀一层”，没有乳房，脸上印出表情肌。
  所以：身体用包络拟合的结果；乳房区加上“女性体型 MHR 减去包络拟合 MHR”的差；头部不用逐顶点修正、头的身份系数取 0。
  Fitting girth targets alone (a female-shaped MHR): the joints match (shoulder, elbow, wrist, hip, ankle within 1-4 mm) but
  the skin cross-sections sit 10-19 mm off her deep parts (forearm medial-anterior; mid trunk 12-19 mm forward, 26-28 mm
  short at the back): her muscles are warped male muscles, distributed unlike a female surface. Fitting the envelope alone:
  everything is enclosed, girths at the standard, BMI 21.6, but it is "deep parts plus a uniform layer": no breasts, and
  the facial muscles print through. Hence: the body from the envelope fit; over the breasts the difference "female-shaped
  MHR minus envelope-fit MHR" is added; the head gets no per-vertex correction and zero head identity.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mhrlib  # noqa: E402
from bodylib import CUR, RAW, Body  # noqa: E402
from fit_skin import NCOMP, TARGETS, solve_identity, stale_guard, surrogate, targets_for  # noqa: E402
from measure import bone_landmarks, surface_measures  # noqa: E402


def main():
    bmi = float(sys.argv[sys.argv.index('--bmi') + 1]) if '--bmi' in sys.argv else 21.6
    d = os.path.join(RAW, 'out', 'female-skin')
    stale_guard('female')
    # fit_skin.py（envelope 方式）写出 fit-state-envelope.npz；本脚本只读它，改写的是 fit-state.npz
    # fit_skin.py (envelope mode) writes fit-state-envelope.npz; this script only reads it and rewrites fit-state.npz
    env_state = os.path.join(d, 'fit-state-envelope.npz')
    if os.path.getmtime(env_state) < os.path.getmtime(os.path.join('public/anatomy', 'female', 'anatomy.json')):
        raise SystemExit('fit-state-envelope.npz is older than the body: run fit_skin.py female --mode envelope first')
    st = np.load(env_state)
    mp, lod = st['mp'], int(st['lod'])
    fb = Body('female')
    L = bone_landmarks(fb)
    model = json.load(open(os.path.join(CUR, 'anthro-model.json')))
    S = (L['vertex'][1] - L['floor'][1]) * 1000
    tg = targets_for(model, 'F', S, bmi)
    sur = surrogate()
    F1, jn = mhrlib.faces(1), mhrlib.joint_names(1)
    ilio = 0.5 * (L['iliocristale_L'][1] + L['iliocristale_R'][1]) - L['floor'][1]
    idc, offset, lines = solve_identity(sur, tg, 'F'), {}, []
    for it in range(5):
        V1, P1, _ = mhrlib.run(np.r_[idc, np.zeros(45 - NCOMP)], mp, 1, True)
        J1 = {f'{a}_{Sd}': P1[jn.index(f'{s}_{m}')] for Sd, s in (('L', 'l'), ('R', 'r'))
              for a, m in (('shoulder', 'uparm'), ('elbow', 'lowarm'), ('wrist', 'wrist'), ('hip', 'upleg'), ('knee', 'lowleg'), ('ankle', 'foot'))}
        meas = surface_measures(V1, F1, J1, levels={'iliocristale': ilio})
        lines.append(f'identity round {it}: {np.round(idc, 2).tolist()}  ' + ', '.join(f'{k} {meas[k]:.0f} ({(meas[k] - v[0]) / v[2]:+.1f}sd)' for k, v in tg.items()))
        if it == 4:
            break
        for k in tg:
            offset[k] = offset.get(k, 0.0) + 0.7 * (meas[k] - (sur[k][0] + sur[k][1:] @ idc + offset.get(k, 0.0)))
        idc = solve_identity(sur, tg, 'F', offset)
    ident_f = np.r_[idc, np.zeros(45 - NCOMP)]
    # ---- 合成 / compose
    from scipy import sparse
    from fit_check import classify
    F = mhrlib.faces(lod)
    ident = st['identity'].copy()
    ident[20:40] = 0.0   # 头的身份系数取 0：MHR 的平均头 / zero head identity: MHR's mean head
    Vb = mhrlib.run(ident, mp, lod, True)[0]
    Venv = mhrlib.run(st['identity'], mp, lod, True)[0] + st['offsets']
    Vf = mhrlib.run(ident_f, mp, lod, True)[0]
    n = len(Vb)
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    A = sparse.coo_matrix((np.ones(len(e) * 2), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])), shape=(n, n)).tocsr()
    A.data[:] = 1.0
    A = sparse.diags(1.0 / np.maximum(np.asarray(A.sum(1)).ravel(), 1)) @ A
    reg = classify(Vb, L)
    w_head = (reg == 'head').astype(float)
    for _ in range(12):
        w_head = np.maximum(w_head * 0.0 + (A @ w_head), (reg == 'head') * 1.0)
    zc = 0.25 * (L['hip_L'][2] + L['hip_R'][2] + L['shoulder_L'][2] + L['shoulder_R'][2])
    w_br = np.zeros(n)
    apex = {}
    for S, sg in (('L', 1), ('R', -1)):
        shy = 0.5 * (L['shoulder_L'][1] + L['shoulder_R'][1])
        m = (sg * Vf[:, 0] > 0.03) & (sg * Vf[:, 0] < 0.16) & (Vf[:, 2] > zc) & (Vf[:, 1] < shy - 0.07) & (Vf[:, 1] > shy - 0.26)
        ap = Vf[m][np.argmax(Vf[m][:, 2])]
        apex[S] = ap
        dxy = np.linalg.norm(Vf[:, :2] - ap[:2], axis=1)
        w_br = np.maximum(w_br, np.clip((0.085 - dxy) / 0.03, 0, 1) * (Vf[:, 2] > zc) * (np.abs(Vf[:, 1] - ap[1]) < 0.12))
    for _ in range(4):
        w_br = A @ w_br
    # 包络拟合的逐顶点修正先做低通（12 次邻域平均）：皮下脂肪会抹平肌肉的起伏，不该把每条肌束都印在皮肤上；
    # 抹平后个别地方深部结构会贴近或略出皮肤，由 enclose_skin.py 再局部外推
    # low-pass the envelope fit's per-vertex correction (12 neighbour averages): subcutaneous fat evens out muscle relief
    # and single bundles should not print through; where deep parts then touch or cross the skin, enclose_skin.py pushes it out locally
    off_env = Venv - mhrlib.run(st['identity'], mp, lod, True)[0]
    for _ in range(12):
        off_env = A @ off_env
    Venv = mhrlib.run(st['identity'], mp, lod, True)[0] + off_env
    V = Vb + (1 - w_head)[:, None] * (Venv - Vb) + w_br[:, None] * (Vf - Vb)
    # 乳房区：用女性体型 MHR 的形状，但保持与包络皮肤在乳房边缘处连续（上式在 w_br=1 处为 Venv + (Vf - Vb)）
    # breast zone: the female MHR's shape, kept continuous with the envelope skin at the rim (where w_br = 1 the result is Venv + (Vf - Vb))
    lines.append(f'breast apex of the female-shaped MHR (m): L {np.round(apex["L"], 3).tolist()}, R {np.round(apex["R"], 3).tolist()}; '
                 f'vertices blended: head {int((w_head > 0.5).sum())}, breast {int((w_br > 0.5).sum())}')
    np.savez(os.path.join(d, 'fit-state.npz'), identity=ident, mp=mp, offsets=V - Vb, lod=lod)
    fj = os.path.join(d, 'fit.json')
    fit = json.load(open(fj))
    fit['identity'] = [round(float(v), 4) for v in ident]
    fit['mode'] = 'envelope fit + female MHR breasts + MHR mean head (compose_female.py)'
    json.dump(fit, open(fj, 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(d, 'compose.txt'), 'w').write('\n'.join(lines))
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
