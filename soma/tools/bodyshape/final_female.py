"""
女性最终皮肤的拟合状态：从目标体型出发，对到她改形后的内部结构上。
The fit state of the final female skin: the target shape, brought onto her reshaped internals.

    python tools/bodyshape/final_female.py [--bmi 21.6] [--reuse-pose]
    python tools/bodyshape/enclose_skin.py female        # 之后：小幅包住、写皮肤包 / then: the small enclosure and the package

写 data/raw/bodyshape/out/female-skin/fit-state.npz（MHR 身份系数、参数、逐顶点偏移）和 final-fit.json / .txt。
Writes data/raw/bodyshape/out/female-skin/fit-state.npz (MHR identity, parameters, per-vertex offsets) and final-fit.json / .txt.

步骤 / steps
  1 姿势：取目标的姿势，把肘、腕的权重提到与其余大关节相同的两倍（肘落到 rig.json 的中心上），再解几步。
    pose: the pose of the target, solved a few more steps with elbow and wrist at twice the weight of the other large
    joints, so the elbow lands on its rig.json centre.
  2 头：不再只缩放颅顶。头颈姿势 + 头部身份系数（20–39）+ 整个头的等比缩放，对“颅骨 + 软组织厚度”的面和两个眼球中心拟合。
    head: no cranium-only scaling any more. Head and neck pose + the head identity (20-39) + one isotropic scale of the
    whole head are fitted to the surface "skull + soft-tissue thickness" and to the two eyeball centres.
  3 乳房体积、BMI（与目标相同的做法）。breast volume and BMI, as for the target.
  4 骨上的放松（与目标相同）。relaxation over bone, as for the target.
  5 软组织：肌肉仍在皮肤外或贴着皮肤的地方，把皮肤外移到盖住它并留出标准脂肪厚度；位移场铺开、抹平（低通），不是逐顶点顶出去。
    soft tissue: where muscle is still outside or against the skin, the skin moves out to cover it with the standard fat
    thickness; the displacement field is spread and smoothed (low-pass), not a per-vertex push.
  6 两大腿内侧：皮肤不越过正中面两侧各 1.5 mm 的界限（两片皮肤不互穿）；股薄肌因此仍露出的部分如实报告。
    medial thighs: the skin of each thigh stays 1.5 mm on its own side of the midplane (the two skins cannot
    interpenetrate); what that leaves of gracilis outside is reported as it is.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_target as BT  # noqa: E402
import enclose_skin as ES  # noqa: E402
import fit_skin as FS  # noqa: E402
import mhrlib  # noqa: E402
from bodylib import RAW, Body  # noqa: E402
from fit_check import REGIONS, classify, signed_distance  # noqa: E402
from fit_skin import Envelope, Fit, joint_targets, stale_guard, subcutaneous_points, vertex_normals  # noqa: E402
from measure import bone_landmarks, mesh_volume  # noqa: E402

OUT = os.path.join(RAW, 'out', 'female-skin')
TARGET = os.path.join(RAW, 'out', 'female-target')
# 头面部软组织厚度（mm）。颅盖 6、颧 7、鼻骨 4、颏 10：取法医面部复原常用厚度表的量级，是假定值，没有逐点核对文献。
# Soft-tissue thickness of head and face (mm). Vault 6, zygoma 7, nasal bones 4, chin 10: the order of magnitude of the
# tables used in forensic facial approximation; assumptions, not checked point by point against a source.
HEAD_BONES = [(BT.VAULT, 0.006, 'vault'), (['Left zygomatic bone', 'Right zygomatic bone'], 0.007, 'zygoma'),
              (['Left nasal bone', 'Right nasal bone'], 0.004, 'nasal'), (['Mandible'], 0.010, 'chin')]
HEAD_POSE = ['neck_twist', 'neck_lean', 'neck_bend', 'head_twist', 'head_lean', 'head_bend', 'scale_neck_length']
HEAD_JOINTS = ('c_head', 'c_jaw', 'c_teeth', 'c_tongue', 'l_eye', 'r_eye')


def head_weight(lod):
    vi, ji, w, _ = mhrlib.skin_weights(lod)
    jn = mhrlib.joint_names(lod)
    hj = np.array([n.startswith(HEAD_JOINTS) for n in jn])
    wh = np.zeros(mhrlib.LOD_VERTICES[lod])
    np.add.at(wh, vi, w * hj[ji])
    return np.clip(wh, 0, 1)


def scale_head(V, P, jn, wh, s):
    """整个头绕头关节等比缩放，按头的蒙皮权重过渡到颈 / isotropic scale of the whole head about the head joint, blended into the neck by the head skin weight"""
    pivot = P[jn.index('c_head')]
    return V + wh[:, None] * (s - 1.0) * (V - pivot)


def fit_head(ident, mp, fb, log):
    import igl
    names = mhrlib.param_names()
    pidx = [names.index(n) for n in HEAD_POSE]
    F1, jn1, wh = mhrlib.faces(1), mhrlib.joint_names(1), head_weight(1)
    ear = min(fb.verts('Left temporal bone')[:, 1].min(), fb.verts('Right temporal bone')[:, 1].min())
    man = fb.verts('Mandible')
    groups = []
    for bones, t, tag in HEAD_BONES:
        BV, BF = fb.merged(lambda p: p['name'] in bones)
        groups.append((np.ascontiguousarray(BV), np.ascontiguousarray(BF), t, tag))
    eyes = [(jn1.index(j), fb.verts(n).mean(0)) for j, n in (('l_eye', 'Left vitreous body'), ('r_eye', 'Right vitreous body'))]
    npose = len(pidx)

    def shape(x):
        m = mp.copy()
        m[pidx] = x[:npose]
        c = ident.copy()
        c[20:40] = x[npose:npose + 20]
        V, P, _ = mhrlib.run(c, m, 1, True)
        return scale_head(V, P, jn1, wh, x[-1]), P, c, m

    def corr(V):
        n = vertex_normals(V, F1)
        best = np.full(len(V), np.inf)
        cp = np.zeros_like(V)
        ee = np.zeros_like(V)
        for BV, BF, t, tag in groups:
            d2, _, c = igl.point_mesh_squared_distance(np.ascontiguousarray(V), BV, BF)[:3]
            d = np.sqrt(d2)
            e = (V - c) / np.maximum(d, 1e-9)[:, None]
            ok = (d < 0.035) & (np.einsum('ij,ij->i', n, e) > 0.4) & (wh > 0.6)
            if tag == 'vault':
                ok &= V[:, 1] > ear + 0.03
            if tag == 'chin':   # 只用颏部：下颌支外面是咬肌和腮腺 / the chin only: masseter and parotid cover the ramus
                ok &= (np.abs(c[:, 0]) < 0.022) & (c[:, 2] > man[:, 2].max() - 0.02)
            take = ok & (d < best)
            best[take], cp[take], ee[take] = d[take], (c + t * e)[take], e[take]
        idx = np.where(np.isfinite(best))[0]
        return idx, cp[idx], ee[idx]

    x = np.r_[mp[pidx], np.zeros(20), 1.0]
    lam = 1e-2
    for it in range(10):
        idx, cp, e = corr(shape(x)[0])

        def resid(y):
            V, P, _, _ = shape(y)
            r = np.einsum('ij,ij->i', e, V[idx] - cp)
            r = np.where(np.abs(r) < 0.008, r, np.sign(r) * np.sqrt(0.008 * (2 * np.abs(r) - 0.008)))   # Huber 8 mm
            return np.r_[r, np.concatenate([BT.EYE_WEIGHT * (P[j] - q) for j, q in eyes]), 0.0015 * y[npose:npose + 20], 0.01 * (y[:npose] - mp[pidx]), 0.05 * (y[-1] - 1.0)]

        r0 = resid(x)
        J = np.zeros((len(r0), len(x)))
        for i in range(len(x)):
            xi = x.copy()
            h = 5e-3 if (i < npose or i == len(x) - 1) else 2e-2
            xi[i] += h
            J[:, i] = (resid(xi) - r0) / h
        A, g = J.T @ J, J.T @ r0
        for _ in range(6):
            xn = x + np.linalg.solve(A + lam * (np.diag(np.diag(A)) + 1e-9 * np.eye(len(x))), -g)
            xn[npose:npose + 20] = np.clip(xn[npose:npose + 20], -2.5, 2.5)
            xn[-1] = np.clip(xn[-1], 0.85, 1.12)
            rn = resid(xn)
            if rn @ rn < r0 @ r0:
                x, lam = xn, max(lam * 0.3, 1e-6)
                break
            lam *= 10
        log.append(f'  head fit {it}: {len(idx)} vertices over skull bones, RMS to "bone + thickness" {np.sqrt(np.mean(r0[:len(idx)] ** 2)) * 1000:.2f} mm, head scale {x[-1]:.3f}')
    V, P, c, m = shape(x)
    info = {'eyeJointToEyeballCentreMm': [round(float(np.linalg.norm(P[j] - q) * 1000), 1) for j, q in eyes], 'headScale': round(float(x[-1]), 3),
            'headIdentity20to39': np.round(x[npose:npose + 20], 2).tolist(), 'pose': {n: round(float(v), 3) for n, v in zip(HEAD_POSE, x[:npose])}}
    log.append('  head: ' + json.dumps(info))
    return c, m, float(x[-1]), info


def spread(d, A, cap, rings=3, smooth=8, final=3):
    """位移场的低通：扩、抹平、与原值取大、再抹平 / low-pass of a displacement field: dilate, smooth, keep the larger, smooth again"""
    ds = d.copy()
    for _ in range(rings):
        ds = np.maximum(ds, 0.8 * (A @ ds))
    for _ in range(smooth):
        ds = 0.5 * ds + 0.5 * (A @ ds)
    ds = np.maximum(d, ds)
    for _ in range(final):
        ds = 0.5 * ds + 0.5 * (A @ ds)
    return np.minimum(ds, cap)


def by_region(mm, regV, moved=0.5):
    out = {}
    for rid, _, _ in REGIONS:
        m = regV == rid
        if m.sum() > 20:
            out[rid] = {'shareMoved': round(float((mm[m] > moved).mean()), 3), 'medianMm': round(float(np.median(mm[m])), 1),
                        'p95Mm': round(float(np.percentile(mm[m], 95)), 1), 'maxMm': round(float(mm[m].max()), 1)}
    return out


def main():
    bmi_t = float(sys.argv[sys.argv.index('--bmi') + 1]) if '--bmi' in sys.argv else 21.6
    stale_guard('female')
    os.makedirs(OUT, exist_ok=True)
    key = json.load(open('public/anatomy/female/pipeline-report.json'))['skinPackage']['internalsKey']
    fb = Body('female')
    L = bone_landmarks(fb)
    log = [f'female final fit; internals key {key}; target BMI {bmi_t}']
    lod = 0
    cache = os.path.join(OUT, 'pose-cache.npz')
    if '--reuse-pose' in sys.argv and os.path.exists(cache):
        cz = np.load(cache)
        ident, mp, hs, head_info = cz['identity'].copy(), cz['mp'].copy(), float(cz['head_scale']), json.loads(str(cz['head_info']))
        log.append('  pose and head reused from pose-cache.npz')
    else:
        tz = np.load(os.path.join(TARGET, 'pose-cache.npz'))
        ident, mp = tz['identity'].copy(), tz['mp'].copy()
        ident[20:40] = 0.0
        FS.BOUNDS.update({'scale_hip_height': 0.6, 'scale_spine_length': 0.6, 'scale_hip_depth': 0.6})
        jt, _ = joint_targets('female', fb, L)
        main_w = {'uparm': 4.0, 'lowarm': 8.0, 'wrist': 8.0, 'upleg': 4.0, 'lowleg': FS.KW, 'foot': 4.0}
        jt = [(j, p, main_w.get(j[2:], w)) for j, p, w in jt]
        Pb = fb.merged(lambda p: p['tissue'] == 'bone')[0]
        Pb = Pb[~np.isin(classify(Pb, L), ['hand', 'foot'])]
        Pb = Pb[np.random.default_rng(3).choice(len(Pb), 4000, replace=False)]
        fit = Fit('female', 'targets', fb, L, jt, bone_pts=Pb, top_floor=(L['vertex'][1], L['floor'][1]), subcut=subcutaneous_points(fb))
        fit.identity = ident.copy()
        fit.bone_weight = 1.0
        x = fit.solve(6, log, mp[fit.pidx].copy())
        mp[fit.pidx] = x
        log.append('  joint residuals after the pose fit (mm): ' + json.dumps(fit.joint_residuals(x)))
        ident, mp, hs, head_info = fit_head(ident, mp, fb, log)
        np.savez(cache, identity=ident, mp=mp, head_scale=hs, head_info=json.dumps(head_info))

    F, jn = mhrlib.faces(lod), mhrlib.joint_names(lod)
    A = ES.adjacency(mhrlib.LOD_VERTICES[lod], F)
    wh = head_weight(lod)
    H = lambda W: W[:, 1].max() - W[:, 1].min()
    bmi_of = lambda W: mesh_volume(W, F) * 1010.0 / H(W) ** 2

    # ---- 3 乳房体积与 BMI / breast volume and BMI
    for it in range(3):
        Vm0, P, _ = mhrlib.run(ident, mp, lod, True)
        Vm = scale_head(Vm0, P, jn, wh, hs)
        mask, B, apex = BT.breast_base(Vm, F, L, A)
        vols = {S: BT.patch_volume(Vm, B, F, mask, S) * 1e6 for S in 'LR'}
        fac = {S: float(np.clip(BT.BREAST_ML / max(vols[S], 1.0), 0.5, 2.5)) for S in 'LR'}
        V = Vm.copy()
        for S in 'LR':
            ms = mask & ((Vm[:, 0] > 0) == (S == 'L'))
            V[ms] = B[ms] + fac[S] * (Vm[ms] - B[ms])
        b = bmi_of(V)
        log.append(f'  round {it}: breast volume of the MHR shape L {vols["L"]:.0f} / R {vols["R"]:.0f} mL -> scaled by L {fac["L"]:.2f} / R {fac["R"]:.2f}; volume BMI {b:.2f}')
        if it < 2:
            ident[0] += (bmi_t - b) / 5.3
    V_shape = V.copy()     # 目标体型（未放松）/ the target shape before any relaxation
    regV = classify(V_shape, L)

    # ---- 4 骨 / bone
    Pd, grp, pid, parts = ES.deep_samples(fb)
    bone = grp == list(ES.GROUPS).index('bone')
    capv = np.full(len(V), 0.015)
    capv[np.isin(regV, ['head', 'forearm', 'foot'])] = 0.012
    capv[regV == 'hand'] = 0.006
    keep = ES.MARGIN
    ES.MARGIN = BT.BONE_COVER
    Vb = ES.enclose(V_shape, F, Pd[bone], log, capv)
    ES.MARGIN = keep
    nrm = vertex_normals(V_shape, F)
    for _ in range(3):
        nrm = 0.5 * nrm + 0.5 * (A @ nrm)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1), 1e-12)[:, None]
    d_bone = spread(np.einsum('ij,ij->i', Vb - V_shape, nrm).clip(0), A, capv)
    Vb = V_shape + d_bone[:, None] * nrm

    # ---- 5 软组织：盖住仍在外面的肌肉，并留出标准脂肪厚度 / soft tissue: cover the muscle still outside, with standard fat over it
    import igl
    cap_s = np.full(len(V), 0.025)
    cap_s[regV == 'hand'] = 0.006
    cap_s[np.isin(regV, ['head', 'foot'])] = 0.010
    Ve = ES.enclose(Vb, F, Pd, log, cap_s)
    d0 = np.einsum('ij,ij->i', Ve - Vb, nrm).clip(0)
    DV, DF = fb.merged(lambda p: p['tissue'] in Body.DEEP and p['system'] != 'integumentary')
    DV, DF = np.ascontiguousarray(DV), np.ascontiguousarray(DF)
    env = Envelope(fb, L, 'F')
    env.breast = []
    t_fat = env.thickness(Vb)
    room = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(Vb + d0[:, None] * nrm), DV, DF)[0])
    m = (d0 > 0.0005).astype(float)     # 只在皮肤需要外移的地方补脂肪厚度 / fat cover is added only where the skin had to move out
    for _ in range(3):
        m = np.maximum(m, 0.8 * (A @ m))
    for _ in range(4):
        m = 0.5 * m + 0.5 * (A @ m)
    extra = np.clip(t_fat - room, 0, 0.012) * np.clip(m, 0, 1)
    extra[np.isin(regV, ['head', 'hand', 'foot'])] = 0     # 头、手、足只包住，不另加厚度 / head, hand and foot are only enclosed
    d_soft = spread(d0 + extra, A, cap_s)
    V = Vb + d_soft[:, None] * nrm

    # ---- 6 两大腿内侧不互穿 / the medial thighs do not interpenetrate
    g = ES.mhr_groups(lod)
    lim = 0.0015
    thigh = np.isin(regV, ['thigh', 'knee', 'pelvis'])
    cl = thigh & (g == 3) & (V[:, 0] < lim) & (V_shape[:, 0] > -0.02)
    cr = thigh & (g == 4) & (V[:, 0] > -lim) & (V_shape[:, 0] < 0.02)
    moved_back = float(max((lim - V[cl, 0]).max() if cl.any() else 0, (V[cr, 0] + lim).max() if cr.any() else 0))
    V[cl, 0], V[cr, 0] = lim, -lim
    log.append(f'  medial thighs: {int(cl.sum() + cr.sum())} vertices held at {lim * 1000:.1f} mm from the midplane (pulled back by up to {moved_back * 1000:.1f} mm)')
    s = signed_distance(Pd, V, F) * 1000
    for k, p in enumerate(parts):
        if 'gracilis' in p['name'].lower():
            x = s[pid == k]
            log.append(f'    {p["name"]}: {100 * (x > 0).mean():.1f} % of its surface outside the skin before the final enclosure, furthest {x.max():.1f} mm; nearest to the midplane {np.abs(Pd[pid == k][:, 0]).min() * 1000:.1f} mm')

    mm = np.linalg.norm(V - V_shape, axis=1) * 1000
    rep = {'internalsKey': key, 'head': head_info, 'bmiByVolume': {'shape': round(bmi_of(V_shape), 2), 'afterBone': round(bmi_of(Vb), 2), 'afterSoft': round(bmi_of(V), 2)},
           'movedFromTargetShapeMm': by_region(mm, regV), 'boneRelaxationMm': by_region(d_bone * 1000, regV), 'softRelaxationMm': by_region(d_soft * 1000, regV)}
    log.append('BMI by volume: target shape %.2f, after bone relaxation %.2f, after soft relaxation %.2f' % (bmi_of(V_shape), bmi_of(Vb), bmi_of(V)))
    log.append('skin moved from the target shape, by region (share moved > 0.5 mm, median / p95 / max mm):')
    for rid, v in rep['movedFromTargetShapeMm'].items():
        log.append(f'   {rid:10s} {100 * v["shareMoved"]:5.1f} %  {v["medianMm"]:5.1f} {v["p95Mm"]:5.1f} {v["maxMm"]:5.1f}')
    np.savez(os.path.join(OUT, 'fit-state.npz'), identity=ident, mp=mp, offsets=V - Vm0, lod=lod)
    np.savez(os.path.join(OUT, 'target-shape.npz'), V=V_shape, chestBase=B)
    json.dump(rep, open(os.path.join(OUT, 'final-fit.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(OUT, 'final-fit.txt'), 'w').write('\n'.join(log) + '\n')
    print('\n'.join(log))


if __name__ == '__main__':
    main()
