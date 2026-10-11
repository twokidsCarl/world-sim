"""女性“目标体表”：女性体型的 MHR（给定身高和 BMI 的标准围度），关节在她的骨架关节上，
以及深部结构应当留在其内的“深层包络”。这是给管线重塑软组织用的目标，不是可装入的皮肤包。
The female target surface: a female-shaped MHR (standard girths for the given stature and BMI) with
its joints on her rig joints, and the "deep envelope" her deep parts should stay inside. It is the
target the pipeline reshapes her soft tissue towards, not an installable skin package.

    python tools/bodyshape/build_target.py [--bmi 21.6]
    <- data/raw/bodyshape/out/female-skin-envelope-v2/fit-state-envelope.npz（姿势和骨架参数 / pose and skeleton parameters）
    -> data/raw/bodyshape/out/female-target/  skin.obj, deep-envelope.obj, manifest.json, conflict-map.json/.txt, 预览图 / previews

步骤 / steps
 1 身份系数（身体 6 个）由围度目标求出；姿势、骨架缩放、指节长度取包络拟合的结果（关节已对上 rig.json）。
   Body identity (6 coefficients) from the girth targets; pose, skeleton scales and finger lengths from the envelope fit (joints already on rig.json).
 2 头：颈、头的姿势和头的 20 个身份系数拟合到她的颅盖骨（额、顶、枕、颞骨）外 6 mm。
   Head: neck and head pose and the 20 head identity coefficients fitted to 6 mm outside her cranial vault (frontal, parietal, occipital, temporal bones).
 3 乳房：把乳房相对胸壁基面的隆起按比例放大到文献的单侧体积。
   Breasts: the bulge above the chest-wall base surface is scaled to the per-breast volume from the literature.
 4 体积 BMI 调到目标（沿 MHR 胖瘦分量）。Volume BMI brought to the target along MHR's fatness component.
 5 骨的可行性：皮肤在骨性突起处局部外移，使全部骨和软骨至少在皮肤下 3 mm。
   Feasibility for bone: the skin is moved out locally over bony prominences until all bone and cartilage is at least 3 mm under it.
 6 深层包络 = 皮肤沿法线内收“该处皮下脂肪标准厚度 + 2 mm 皮肤”；薄的部位（手指、鼻、耳）内收量不超过局部厚度的 40 %；
   骨离皮肤更近的地方内收量减到骨面外 0.5 mm。
   Deep envelope = skin moved in along its normals by the standard subcutaneous fat of the region + 2 mm of skin; in thin
   parts (fingers, nose, ears) by no more than 40 % of the local thickness; where bone is closer, reduced to 0.5 mm outside the bone.
 7 冲突图：现有深部结构在深层包络之外的部分，按区域和部件，骨与软组织分开。
   Conflict map: what of the present deep parts lies outside the deep envelope, by region and by part, bone and soft tissue apart.
"""
import json
import os
import shutil
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enclose_skin as ES  # noqa: E402
import fit_skin as FS  # noqa: E402
import mhrlib  # noqa: E402
from bodylib import CUR, RAW, Body, render_closeup, render_views  # noqa: E402
from fit_check import REGIONS, classify, signed_distance  # noqa: E402
from fit_skin import (NCOMP, Envelope, Fit, joint_mapping, joint_targets, solve_identity, stale_guard, subcutaneous_points, surrogate,  # noqa: E402
                      targets_for, vertex_normals, write_obj)
from measure import bone_landmarks, mesh_volume, surface_measures  # noqa: E402

OUT = os.path.join(RAW, 'out', 'female-target')
VAULT = ['Frontal bone', 'Occipital bone', 'Left parietal bone', 'Right parietal bone', 'Left temporal bone', 'Right temporal bone']
SCALP = 0.006          # 颅盖外的头皮厚度 / scalp over the vault
BONE_COVER = 0.003     # 骨上最少的皮肤覆盖 / least cover of skin over bone
BREAST_ML = 370.0      # 单侧乳房体积，BMI 18.5–25（Steele 2020，见 fat-literature.json；由子任务摘录，未复核）
                       # per-breast volume at BMI 18.5-25 (Steele 2020, see fat-literature.json; extracted by a sub-task, not re-verified)
HEAD_PARAMS = ['neck_twist', 'neck_lean', 'neck_bend', 'head_twist', 'head_lean', 'head_bend', 'scale_neck_length', 'scale_eye_width', 'scale_eye_height', 'scale_eye_depth']
EYE_WEIGHT = 30.0      # 眼球中心对应点的权重（颅盖近似球面，单靠它定不住头的俯仰）/ weight of the eyeball centres (the vault is nearly a sphere and cannot fix the pitch of the head alone)


def joints_of(P, jn):
    return {f'{a}_{Sd}': P[jn.index(f'{s}_{m}')] for Sd, s in (('L', 'l'), ('R', 'r'))
            for a, m in (('shoulder', 'uparm'), ('elbow', 'lowarm'), ('wrist', 'wrist'), ('hip', 'upleg'), ('knee', 'lowleg'), ('ankle', 'foot'))}


def fit_head(ident, mp, fb, L, log):
    """颈、头姿势和头的身份系数对颅盖骨做高斯–牛顿拟合（LOD1）。
    Gauss-Newton fit of neck and head pose and the head identity to the cranial vault (LOD 1)."""
    import igl
    names = mhrlib.param_names()
    pidx = [names.index(n) for n in HEAD_PARAMS]
    BV, BF = fb.merged(lambda p: p['name'] in VAULT)
    BV, BF = np.ascontiguousarray(BV), np.ascontiguousarray(BF)
    F1 = mhrlib.faces(1)
    ear = min(fb.verts('Left temporal bone')[:, 1].min(), fb.verts('Right temporal bone')[:, 1].min())

    def unpack(x):
        m = mp.copy()
        m[pidx] = x[:len(pidx)]
        c = ident.copy()
        c[20:40] = x[len(pidx):]
        return c, m

    def corr(x):
        V = mhrlib.run(*unpack(x), 1, True)[0]
        d2, _, c = igl.point_mesh_squared_distance(np.ascontiguousarray(V), BV, BF)[:3]
        d = np.sqrt(d2)
        e = (V - c) / np.maximum(d, 1e-9)[:, None]
        ok = (d < 0.03) & (np.einsum('ij,ij->i', vertex_normals(V, F1), e) > 0.5) & (V[:, 1] > ear + 0.03)
        return np.where(ok)[0], (c + SCALP * e)[ok], e[ok]

    sub = subcutaneous_points(fb)[:7]   # 额、枕、两顶、颏、两颧的皮下点 / subcutaneous points of forehead, occiput, parietals, chin, zygomata
    # 眼球中心：她的玻璃体的中心 对 MHR 的眼关节。第一次只用颅盖时头后仰了约 25 度，眼高出 41 mm。
    # Eyeball centres: the centroid of her vitreous bodies against MHR's eye joints. With the vault alone the head came out pitched back about 25 degrees and the eyes 41 mm high.
    jn1 = mhrlib.joint_names(1)
    eyes = [(jn1.index(j), fb.verts(n).mean(0)) for j, n in (('l_eye', 'Left vitreous body'), ('r_eye', 'Right vitreous body'))]
    x = np.r_[mp[pidx], ident[20:40]]
    lam = 1e-2
    for it in range(8):
        idx, cp, e = corr(x)

        def resid(y):
            Vall, Pall, _ = mhrlib.run(*unpack(y), 1, True)
            return np.r_[np.einsum('ij,ij->i', e, Vall[idx] - cp), 3.0 * signed_distance(sub, Vall, F1), np.concatenate([EYE_WEIGHT * (Pall[j] - q) for j, q in eyes]),
                         0.0006 * y[len(pidx):], 0.01 * (y[:len(pidx)] - mp[pidx])]

        r0 = resid(x)
        J = np.zeros((len(r0), len(x)))
        for i in range(len(x)):
            xi = x.copy()
            h = 5e-3 if i < len(pidx) else 2e-2
            xi[i] += h
            J[:, i] = (resid(xi) - r0) / h
        A, g = J.T @ J, J.T @ r0
        for _ in range(6):
            xn = x + np.linalg.solve(A + lam * (np.diag(np.diag(A)) + 1e-9 * np.eye(len(x))), -g)
            xn[len(pidx):] = np.clip(xn[len(pidx):], -3, 3)
            rn = resid(xn)
            if rn @ rn < r0 @ r0:
                x, lam = xn, max(lam * 0.3, 1e-6)
                break
            lam *= 10
        log.append(f'  head fit iteration {it}: {len(idx)} vertices over the vault, RMS distance to "vault + 6 mm" {np.sqrt(np.mean(r0[:len(idx)] ** 2)) * 1000:.2f} mm')
    Pall = mhrlib.run(*unpack(x), 1, True)[1]
    log.append('  head fit: eye joints to her eyeball centres (mm) ' + ', '.join(f'{np.linalg.norm(Pall[j] - q) * 1000:.1f}' for j, q in eyes)
               + '; head and neck parameters ' + json.dumps({n: round(float(v), 3) for n, v in zip(HEAD_PARAMS, x)}))
    return unpack(x)


def head_scale(V, F, P, jn, lod, fb, log):
    """头的大小：MHR 没有头的缩放参数，身份系数也撑不到她的颅骨那么大（只对齐眼球时两侧顶骨有 65 % 露在皮肤外，最远 22 mm）。
    这里对头部顶点（按头、下颌、眼的蒙皮权重混合）绕两眼中点做三个轴向的缩放，使颅盖外的皮肤落在“颅盖 + 6 mm”上。
    返回一个把这一缩放施加到顶点上的函数。
    Head size: MHR has no head scale and its identity cannot reach the size of her skull (with only the eyeballs aligned,
    65 % of each parietal bone lay outside the skin, by up to 22 mm). The head vertices (blended by the skin weights of
    head, jaw and eyes) are scaled along three axes about the midpoint of the eyes so that the skin over the vault lands
    on "vault + 6 mm". Returns a function that applies this scaling to vertices."""
    import igl
    vi, ji, w, _ = mhrlib.skin_weights(lod)
    hj = np.array([n.startswith(('c_head', 'c_jaw', 'c_teeth', 'c_tongue', 'l_eye', 'r_eye')) for n in jn])
    wh = np.zeros(len(V))
    np.add.at(wh, vi, w * hj[ji])
    wh = np.clip(wh, 0, 1)
    pivot = 0.5 * (P[jn.index('l_eye')] + P[jn.index('r_eye')])
    # 只缩放眼以上的颅部，面部不动（整头缩放会把脸拉长）/ only the cranium above the eyes is scaled; the face stays (scaling the whole head stretches the face)
    ramp = np.clip((V[:, 1] - pivot[1] + 0.02) / 0.07, 0, 1)   # 7 cm 宽的平滑过渡，免得后脑出现一道棱 / a smooth 7 cm transition, so no ridge shows on the back of the head
    wh = wh * ramp * ramp * (3 - 2 * ramp)
    BV, BF = fb.merged(lambda p: p['name'] in VAULT)
    BV, BF = np.ascontiguousarray(BV), np.ascontiguousarray(BF)
    ear = min(fb.verts('Left temporal bone')[:, 1].min(), fb.verts('Right temporal bone')[:, 1].min())
    sc = np.ones(3)
    for _ in range(6):
        W = V + wh[:, None] * (sc - 1) * (V - pivot)
        d2, _, c = igl.point_mesh_squared_distance(np.ascontiguousarray(W), BV, BF)[:3]
        d = np.sqrt(d2)
        e = (W - c) / np.maximum(d, 1e-9)[:, None]
        ok = (d < 0.04) & (np.einsum('ij,ij->i', vertex_normals(W, F), e) > 0.5) & (W[:, 1] > ear + 0.03) & (wh > 0.9)
        # e.(V + wh (s-1)(V-pivot) - cp) = 0，对 s 线性 / linear in s
        M = e[ok] * (wh[ok, None] * (V[ok] - pivot))
        rhs = np.einsum('ij,ij->i', e[ok], (c + SCALP * e)[ok] - V[ok]) + M.sum(1)
        sc = np.clip(np.linalg.lstsq(M, rhs, rcond=None)[0], 0.9, 1.2)
    log.append(f'  head scale about the midpoint of the eyes (x, y, z): {np.round(sc, 3).tolist()}, from {int(ok.sum())} vertices over the vault')
    return lambda X: X + wh[:, None] * (sc - 1) * (X - pivot)


def breast_base(V, F, L, A):
    """乳房区的胸壁基面：把区内顶点松弛成以区边界为边的“膜”。返回 (区内顶点掩码, 基面顶点, 各侧最前点)。
    Chest-wall base surface under the breasts: the vertices of the zone are relaxed into a membrane spanning the zone's
    rim. Returns (zone mask, base vertices, apex per side)."""
    zc = 0.25 * (L['hip_L'][2] + L['hip_R'][2] + L['shoulder_L'][2] + L['shoulder_R'][2])
    shy = 0.5 * (L['shoulder_L'][1] + L['shoulder_R'][1])
    mask = np.zeros(len(V), bool)
    apex = {}
    for S, sg in (('L', 1), ('R', -1)):
        m = (sg * V[:, 0] > 0.03) & (sg * V[:, 0] < 0.16) & (V[:, 2] > zc) & (V[:, 1] < shy - 0.07) & (V[:, 1] > shy - 0.26)
        ap = V[m][np.argmax(V[m][:, 2])]
        apex[S] = ap
        mask |= (np.linalg.norm(V[:, :2] - ap[:2], axis=1) < 0.075) & (V[:, 2] > zc) & (sg * V[:, 0] > 0.005)
    B = V.copy()
    for _ in range(600):
        B[mask] = (A @ B)[mask]
    return mask, B, apex


def patch_volume(V, B, F, mask, side):
    f = F[mask[F].any(1) & ((V[F][:, :, 0].mean(1) > 0) == (side == 'L'))]
    tet = lambda W: np.einsum('ij,ij->i', np.cross(W[f[:, 0]], W[f[:, 1]]), W[f[:, 2]]).sum() / 6.0
    return float(tet(V) - tet(B))


def main():
    bmi_t = float(sys.argv[sys.argv.index('--bmi') + 1]) if '--bmi' in sys.argv else 21.6
    stale_guard('female')
    os.makedirs(OUT, exist_ok=True)
    key = json.load(open('public/anatomy/female/pipeline-report.json'))['skinPackage']['internalsKey']
    src = next(p for p in (os.path.join(RAW, 'out', d, 'fit-state-envelope.npz') for d in ('female-skin-envelope-v2', 'female-skin')) if os.path.exists(p))
    # 起始姿势来自旧的包络拟合，之后会按她的关节和骨骼重新拟合；只要骨骼的键没变（骨骼相同），旧的起点就仍然可用。
    # The starting pose comes from the earlier envelope fit and is refitted to her joints and bones below; it stays usable as long as the bone key is unchanged.
    man = os.path.join(os.path.dirname(src), 'manifest.json')
    was = (json.load(open(man)).get('wasFittedTo') or json.load(open(man)).get('fittedTo') or {}).get('key') if os.path.exists(man) else None
    if was != key and os.path.getmtime(src) < os.path.getmtime('public/anatomy/female/anatomy.json'):
        raise SystemExit('the envelope fit is for other bones: run fit_skin.py female --mode envelope first')
    st = np.load(src)
    mp, lod = st['mp'].copy(), int(st['lod'])
    fb = Body('female')
    L = bone_landmarks(fb)
    model = json.load(open(os.path.join(CUR, 'anthro-model.json')))
    log = [f'female target; internals key {key}; pose and skeleton from {os.path.basename(os.path.dirname(src))}; target BMI {bmi_t}']
    S_bone = (L['vertex'][1] - L['floor'][1]) * 1000

    # ---- 1 身份系数 / identity
    tg = targets_for(model, 'F', 1606.0, bmi_t)
    sur = surrogate()
    F1, jn1 = mhrlib.faces(1), mhrlib.joint_names(1)
    ilio = 0.5 * (L['iliocristale_L'][1] + L['iliocristale_R'][1]) - L['floor'][1]
    def identity_for(mp):
        """在给定姿势和骨架缩放下解身份系数，使各围度达到目标 / identity that meets the girth targets under the given pose and skeleton scales"""
        idc, offset = solve_identity(sur, tg, 'F'), {}
        for it in range(5):
            V1, P1, _ = mhrlib.run(np.r_[idc, np.zeros(45 - NCOMP)], mp, 1, True)
            meas = surface_measures(V1, F1, joints_of(P1, jn1), levels={'iliocristale': ilio})
            if it == 4:
                break
            for k in tg:
                offset[k] = offset.get(k, 0.0) + 0.7 * (meas[k] - (sur[k][0] + sur[k][1:] @ idc + offset.get(k, 0.0)))
            idc = solve_identity(sur, tg, 'F', offset)
        log.append(f'body identity {np.round(idc, 2).tolist()}: ' + ', '.join(f'{k} {meas[k]:.0f} (target {v[0]:.0f}, {(meas[k] - v[0]) / v[2]:+.1f} sd)' for k, v in tg.items()))
        return np.r_[idc, np.zeros(45 - NCOMP)]

    # ---- 1b 姿势：身份系数固定为女性体型，重新解姿势和骨架缩放。关节对到 rig.json 的中心（权重为蒙皮拟合时的一半，
    #         膝仍用小权重），同时要求骨在皮肤下 3 mm 以上。骨盆高度和脊柱长度两个缩放限幅：上一版里它们一起跑到 1.5，
    #         把会阴拉低了约 7 cm、大腿根变细。姿势定了以后再解一次身份系数（骨架缩放会改变围度），如此交替两轮。
    # ---- 1b pose: with the identity fixed at the female shape, pose and skeleton scales are solved again. Joints go to the
    #         rig.json centres (half the weight of the skin fit; the knee keeps its small weight) while bone must stay 3 mm
    #         under the skin. The hip-height and spine-length scales are bounded: in the previous version they ran off
    #         together to 1.5, which pulled the perineum about 7 cm down and thinned the top of the thigh. The identity is
    #         solved again after the pose (skeleton scales change the girths), two rounds in all.
    # --reuse-pose：复用上一次算出的姿势和头（只改后面几步时省去约十分钟）
    # --reuse-pose: reuse the pose and head of the previous run (saves about ten minutes when only the later steps change)
    cache = os.path.join(OUT, 'pose-cache.npz')
    if '--reuse-pose' in sys.argv and os.path.exists(cache):
        cz = np.load(cache)
        ident, mp = cz['identity'].copy(), cz['mp'].copy()
        log.append('  pose and head reused from pose-cache.npz')
    else:
        FS.BOUNDS.update({'scale_hip_height': 0.6, 'scale_spine_length': 0.6, 'scale_hip_depth': 0.6})
        jt, jsrc = joint_targets('female', fb, L)
        main = {'uparm': 4.0, 'lowarm': 4.0, 'wrist': 4.0, 'upleg': 4.0, 'lowleg': FS.KW, 'foot': 4.0}
        jt = [(j, p, main.get(j[2:], w)) for j, p, w in jt]
        Pb_ = fb.merged(lambda p: p['tissue'] == 'bone')[0]
        Pb_ = Pb_[~np.isin(classify(Pb_, L), ['hand', 'foot'])]
        Pb_ = Pb_[np.random.default_rng(3).choice(len(Pb_), 4000, replace=False)]
        mp = mp.copy()
        mp[[mhrlib.param_names().index(n) for n in ('scale_hip_height', 'scale_spine_length', 'scale_hip_depth')]] = np.clip(mp[[mhrlib.param_names().index(n) for n in ('scale_hip_height', 'scale_spine_length', 'scale_hip_depth')]], -0.6, 0.6)
        ident = identity_for(mp)
        for rnd, iters in enumerate((10, 5)):
            fit = Fit('female', 'targets', fb, L, jt, bone_pts=Pb_, top_floor=(L['vertex'][1], L['floor'][1]), subcut=subcutaneous_points(fb))
            fit.identity = ident.copy()
            fit.bone_weight = 1.0
            x = fit.solve(iters, log, mp[fit.pidx].copy())
            mp[fit.pidx] = x
            log.append(f'  round {rnd}: joint residuals after the pose fit (mm): ' + json.dumps(fit.joint_residuals(x)))
            ident = identity_for(mp)
        log.append('  skeleton scales: ' + json.dumps({n: round(float(mp[mhrlib.param_names().index(n)]), 3) for n in FS.SCALES}))

        # ---- 2 头 / head
        ident, mp = fit_head(ident, mp, fb, L, log)
        np.savez(cache, identity=ident, mp=mp)

    F = mhrlib.faces(lod)
    jn = mhrlib.joint_names(lod)
    A = ES.adjacency(mhrlib.LOD_VERTICES[lod], F)
    H = lambda W: W[:, 1].max() - W[:, 1].min()
    bmi_of = lambda W: mesh_volume(W, F) * 1010.0 / H(W) ** 2

    # ---- 3, 4 乳房体积与 BMI / breast volume and BMI
    head_s = None
    for it in range(3):
        Vm0, P, sk = mhrlib.run(ident, mp, lod, True)
        if head_s is None:
            head_s = head_scale(Vm0, F, P, jn, lod, fb, log)
        Vm = head_s(Vm0)
        mask, B, apex = breast_base(Vm, F, L, A)
        vols = {S: patch_volume(Vm, B, F, mask, S) * 1e6 for S in 'LR'}
        fac = {S: float(np.clip(BREAST_ML / max(vols[S], 1.0), 0.5, 2.5)) for S in 'LR'}
        V = Vm.copy()
        for S in 'LR':
            ms = mask & ((Vm[:, 0] > 0) == (S == 'L'))
            V[ms] = B[ms] + fac[S] * (Vm[ms] - B[ms])
        b = bmi_of(V)
        log.append(f'  round {it}: breast volume of the MHR shape L {vols["L"]:.0f} / R {vols["R"]:.0f} mL -> scaled by L {fac["L"]:.2f} / R {fac["R"]:.2f} to {BREAST_ML:.0f} mL each; volume BMI {b:.2f}')
        if it < 2:
            ident[0] += (bmi_t - b) / 5.3
    Bb = B.copy()   # 乳房下的胸壁基面 / chest-wall base under the breasts
    V_raw = V.copy()

    # ---- 5 骨的可行性 / feasibility for bone
    Pd, grp, pid, parts = ES.deep_samples(fb)
    reg = classify(Pd, L)
    bone = grp == list(ES.GROUPS).index('bone')
    s_b = signed_distance(Pd[bone], V_raw, F) * 1000
    hard = []
    for k, p in enumerate(parts):
        m = pid[bone] == k
        if m.sum() >= 5 and (s_b[m] > -BONE_COVER * 1000).any():
            x = s_b[m]
            hard.append({'id': p['id'], 'name': p['name'], 'tissue': p['tissue'], 'shareOutsideSkin': round(float((x > 0).mean()), 3),
                         'shareUnder3mm': round(float((x > -BONE_COVER * 1000).mean()), 3), 'p95Mm': round(float(np.percentile(x, 95)), 1), 'maxMm': round(float(x.max()), 1)})
    hard.sort(key=lambda h: -h['maxMm'])
    log.append(f'\nBONE against the unrelaxed target skin: {len(hard)} bones or cartilages come within {BONE_COVER * 1000:.0f} mm of it or cross it; worst (max mm outside the skin, share outside):')
    for h in hard[:25]:
        log.append(f'   {h["maxMm"]:+6.1f}  {100 * h["shareOutsideSkin"]:5.1f} %  {h["name"]} [{h["tissue"]}]')
    ES.MARGIN = BONE_COVER
    # 放松的上限按区域给：手 6 mm，头、前臂、足 12 mm，其余 15 mm。超出上限仍露在外面的骨是姿势或比例的问题，
    # 如实列在冲突表里，不靠把皮肤顶成一个包来掩盖。
    # The relaxation is capped by region: hand 6 mm; head, forearm and foot 12 mm; elsewhere 15 mm. Bone that still
    # shows beyond the cap is a matter of pose or proportion and is listed as it is, not hidden under a lump of skin.
    regV = classify(V_raw, L)
    capv = np.full(len(V_raw), 0.015)
    capv[np.isin(regV, ['head', 'forearm', 'foot'])] = 0.012
    capv[regV == 'hand'] = 0.006
    V = ES.enclose(V_raw, F, Pd[bone], log, capv)
    ES.MARGIN = 0.0025
    # 把放松量铺开：先向四周扩 3 圈，再抹平 8 遍，取与原放松量的较大者，这样骨上的皮肤是一个缓坡而不是一个尖包。
    # Spread the relaxation: dilate it by 3 rings, smooth it 8 times and keep the larger of that and the original, so the skin over a bone rises as a gentle mound instead of a sharp lump.
    dv = V - V_raw
    d0 = np.linalg.norm(dv, axis=1)
    nrm = vertex_normals(V_raw, F)
    for _ in range(3):
        nrm = 0.5 * nrm + 0.5 * (A @ nrm)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1), 1e-12)[:, None]
    ds = d0.copy()
    for _ in range(3):
        ds = np.maximum(ds, 0.8 * (A @ ds))
    for _ in range(8):
        ds = 0.5 * ds + 0.5 * (A @ ds)
    ds = np.maximum(d0, ds)
    for _ in range(3):   # 最后再抹三遍，去掉逐顶点的毛刺 / three final passes to take off the per-vertex roughness
        ds = 0.5 * ds + 0.5 * (A @ ds)
    ds = np.minimum(ds, capv)
    dirv = np.where((d0 > 1e-5)[:, None], dv / np.maximum(d0, 1e-9)[:, None], nrm)
    V = V_raw + ds[:, None] * dirv
    relax = np.linalg.norm(V - V_raw, axis=1) * 1000
    relax_by = {}
    for rid, _, _ in REGIONS:
        m = regV == rid
        if m.sum() > 20 and (relax[m] > 0.5).any():
            relax_by[rid] = {'verticesMoved': round(float((relax[m] > 0.5).mean()), 3), 'medianOfMovedMm': round(float(np.median(relax[m][relax[m] > 0.5])), 1), 'maxMm': round(float(relax[m].max()), 1)}
    log.append('skin relaxation for bone (share of vertices moved > 0.5 mm, their median, max mm): ' + json.dumps(relax_by))
    Bb = Bb + (V - V_raw)

    # ---- 6 深层包络 / the deep envelope
    import igl
    env = Envelope(fb, L, 'F')
    env.breast = []
    t = env.thickness(V)
    n = vertex_normals(V, F)
    for _ in range(3):
        n = 0.5 * n + 0.5 * (A @ n)
        n /= np.maximum(np.linalg.norm(n, axis=1), 1e-12)[:, None]
    # 局部厚度：沿内法线走到穿出为止 / local thickness: march along the inward normal until outside
    exit_d = np.full(len(V), 0.12)
    und = np.ones(len(V), bool)
    Vc, Fc = np.ascontiguousarray(V), np.ascontiguousarray(F)
    for s_ in np.arange(0.002, 0.12, 0.002):
        i = np.where(und)[0]
        w = igl.fast_winding_number(Vc, Fc, np.ascontiguousarray(V[i] - s_ * n[i]))
        out_ = w < 0.5
        exit_d[i[out_]] = s_
        und[i[out_]] = False
    BVb, BFb = fb.merged(lambda p: p['tissue'] in ES.GROUPS['bone'] and p['system'] != 'integumentary')
    d_bone = np.sqrt(igl.point_mesh_squared_distance(Vc, np.ascontiguousarray(BVb), np.ascontiguousarray(BFb))[0])
    t = np.minimum(t, 0.4 * exit_d)
    for _ in range(5):
        t = 0.5 * t + 0.5 * (A @ t)
    t = np.maximum(np.minimum(t, d_bone - 0.0005), 0.0015)
    base = V.copy()
    base[mask] = Bb[mask]
    E = base - t[:, None] * n
    ES.MARGIN = 0.0005
    E = ES.enclose(E, F, Pd[bone], log, np.maximum(t - 0.0012, 0.0))
    ES.MARGIN = 0.0025
    t_eff = np.linalg.norm(V - E, axis=1) * 1000
    thick = {}
    for rid, zh, en in REGIONS:
        m = (regV == rid) & ~mask
        if m.sum() > 20:
            thick[rid] = {'name': {'zh': zh, 'en': en}, 'p10': round(float(np.percentile(t_eff[m], 10)), 1), 'p50': round(float(np.percentile(t_eff[m], 50)), 1), 'p90': round(float(np.percentile(t_eff[m], 90)), 1)}
    nominal = {k: round(v * 1000, 1) for k, v in env.cover.items()}

    # ---- 7 冲突图 / the conflict map
    sE = signed_distance(Pd, E, F) * 1000
    sS = signed_distance(Pd, V, F) * 1000
    soft = ~bone
    conflict = {'byRegion': {}, 'softParts': [], 'boneParts': []}
    log.append('\nCONFLICT MAP: present deep parts against the deep envelope. Share of surface samples outside; of those outside: p50 / p95 / max mm')
    log.append(f'{"region":10s} {"SOFT share":>10s} {"p50":>6s} {"p95":>6s} {"max":>6s} | {"BONE share":>10s} {"max":>6s}')
    for rid, zh, en in REGIONS + [('all', '全身', 'Whole body')]:
        row = {}
        for gname, gm in (('soft', soft), ('bone', bone)):
            m = gm & ((reg == rid) if rid != 'all' else True)
            if m.sum() < 30:
                continue
            x = sE[m]
            o = x[x > 0]
            row[gname] = {'samples': int(m.sum()), 'shareOutside': round(float((x > 0).mean()), 4), 'p50Mm': round(float(np.median(o)), 1) if len(o) else 0.0,
                          'p95Mm': round(float(np.percentile(o, 95)), 1) if len(o) else 0.0, 'maxMm': round(float(x.max()), 1)}
        conflict['byRegion'][rid] = row
        if 'soft' in row:
            b_ = row.get('bone', {'shareOutside': 0, 'maxMm': 0})
            log.append(f'{rid:10s} {100 * row["soft"]["shareOutside"]:9.1f}% {row["soft"]["p50Mm"]:6.1f} {row["soft"]["p95Mm"]:6.1f} {row["soft"]["maxMm"]:6.1f} | {100 * b_["shareOutside"]:9.2f}% {b_["maxMm"]:6.1f}')
    for k, p in enumerate(parts):
        m = pid == k
        if m.sum() < 5:
            continue
        x = sE[m]
        o = x[x > 0]
        if not len(o):
            continue
        rec = {'id': p['id'], 'name': p['name'], 'tissue': p['tissue'], 'shareOutside': round(float(len(o) / len(x)), 3), 'p50Mm': round(float(np.median(o)), 1),
               'p95Mm': round(float(np.percentile(o, 95)), 1), 'maxMm': round(float(o.max()), 1), 'shareOutsideSkinToo': round(float((sS[m] > 0).mean()), 3)}
        conflict['boneParts' if p['tissue'] in ES.GROUPS['bone'] else 'softParts'].append(rec)
    key_ = lambda r: -r['shareOutside'] * r['p95Mm']
    conflict['softParts'].sort(key=key_)
    conflict['boneParts'].sort(key=key_)
    n_soft = len(conflict['softParts'])
    log.append(f'\nSOFT parts outside the deep envelope: {n_soft} of {sum(1 for p in parts if p["tissue"] not in ES.GROUPS["bone"])}; top 40 by share x p95 (share outside, p50 / p95 / max mm, share also outside the SKIN):')
    for r in conflict['softParts'][:40]:
        log.append(f'   {100 * r["shareOutside"]:5.1f} %  {r["p50Mm"]:5.1f} / {r["p95Mm"]:5.1f} / {r["maxMm"]:5.1f}   skin {100 * r["shareOutsideSkinToo"]:5.1f} %   {r["name"]} [{r["tissue"]}]')
    log.append(f'BONE parts outside the deep envelope after relaxation: {len(conflict["boneParts"])}' + ''.join(
        f'\n   {100 * r["shareOutside"]:5.1f} %  max {r["maxMm"]:5.1f} mm  {r["name"]}' for r in conflict['boneParts'][:15]))
    conflict['softParts'] = conflict['softParts'][:120]
    conflict['boneBeforeRelaxation'] = hard

    # ---- 报告量 / reported quantities
    J = joints_of(P, jn)
    m_ = surface_measures(V, F, J, levels={'iliocristale': ilio})
    VB, FB_ = fb.merged(lambda p: p['name'] in VAULT)
    hv = np.where((regV == 'head') & (V[:, 1] > min(fb.verts('Left temporal bone')[:, 1].min(), fb.verts('Right temporal bone')[:, 1].min()) + 0.03))[0]
    dv = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(V[hv]), np.ascontiguousarray(VB), np.ascontiguousarray(FB_))[0]) * 1000
    skull = [k for k, p in enumerate(parts) if p['tissue'] == 'bone' and classify(fb.mesh(p)[0].mean(0)[None], L)[0] == 'head']
    sk_m = np.isin(pid, skull)
    R = {j['id']: np.array(j['center'], float) for j in json.load(open('public/anatomy/female/rig.json'))['joints']}
    jd = {a: round(float(np.linalg.norm(P[jn.index(mj)] - R[a]) * 1000), 1) for mj, a in (('l_uparm', 'gh_L'), ('r_uparm', 'gh_R'), ('l_lowarm', 'elbow_L'), ('r_lowarm', 'elbow_R'),
          ('l_wrist', 'wrist_L'), ('r_wrist', 'wrist_R'), ('l_upleg', 'hip_L'), ('r_upleg', 'hip_R'), ('l_lowleg', 'knee_L'), ('r_lowleg', 'knee_R'), ('l_foot', 'ankle_L'), ('r_foot', 'ankle_R'))}
    proj = {S: round(float((V[np.argmin(np.linalg.norm(V - (apex[S] + (V - V_raw)[np.argmin(np.linalg.norm(V_raw - apex[S], axis=1))]), axis=1))][2]
                           - Bb[np.argmin(np.linalg.norm(V_raw - apex[S], axis=1))][2]) * 1000), 1) for S in 'LR'}
    vol_after = {S: round(patch_volume(V, Bb, F, mask, S) * 1e6) for S in 'LR'}
    head = {'scalpOverVaultMm': {'p5': round(float(np.percentile(dv, 5)), 1), 'p50': round(float(np.percentile(dv, 50)), 1), 'p95': round(float(np.percentile(dv, 95)), 1)},
            'skullSamplesOutsideSkin': round(float((sS[sk_m] > 0).mean()), 4), 'skullSamplesWithin3mmOfSkin': round(float((sS[sk_m] > -3).mean()), 4),
            'headParameters': {k_: round(float(mp[mhrlib.param_names().index(k_)]), 3) for k_ in HEAD_PARAMS}}
    stat = {'statureMm': round(float(H(V) * 1000), 1), 'skeletonStatureByMeasureMm': round(S_bone, 1), 'bmiByVolume': round(bmi_of(V), 2), 'volumeL': round(mesh_volume(V, F) * 1000, 1),
            'girthsMm': {k: {'target': round(v[0], 1), 'got': round(float(m_[k]), 1)} for k, v in tg.items() if k != 'bmiFromVolume'},
            'otherGirthsMm': {k: round(float(m_[k]), 1) for k in ('forearmMaxGirth', 'underbustGirth', 'hipBreadth') if k in m_},
            'breast': {'volumeMl': vol_after, 'projectionFromBaseMm': proj, 'bustGirthMm': round(float(m_['chestGirth']), 1), 'underbustGirthMm': round(float(m_.get('underbustGirth', np.nan)), 1),
                       'volumeTargetMl': BREAST_ML, 'source': 'Steele et al. 2020 class mean for BMI 18.5-25 (fat-literature.json; extracted by a sub-task, not re-verified here)'},
            'head': head, 'jointDistanceToRigMm': jd}
    log.insert(1, f'target skin: stature {stat["statureMm"]:.0f} mm (skeleton by my measure {S_bone:.0f}), volume BMI {stat["bmiByVolume"]}, bust {stat["breast"]["bustGirthMm"]:.0f} / underbust {stat["breast"]["underbustGirthMm"]:.0f} mm, '
                  f'breast volume {vol_after} mL, projection {proj} mm; scalp over the vault p5/p50/p95 {head["scalpOverVaultMm"]}; skull samples outside the skin {100 * head["skullSamplesOutsideSkin"]:.2f} %; '
                  f'joints to rig (mm): {jd}')
    log.insert(2, 'girths (target -> got): ' + ', '.join(f'{k} {v["target"]:.0f} -> {v["got"]:.0f}' for k, v in stat['girthsMm'].items()))
    closed = ES.is_closed(F)

    # ---- 输出 / outputs
    write_obj(os.path.join(OUT, 'skin.obj'), V, F, 'female TARGET skin (not an installable skin package); MHR LOD0 topology (Apache-2.0); metres, Y up, +Z anterior, +X left')
    write_obj(os.path.join(OUT, 'deep-envelope.obj'), E, F, 'female TARGET deep envelope: deep parts should lie inside; same topology and vertex order as skin.obj')
    np.savez(os.path.join(OUT, 'target-state.npz'), identity=ident, mp=mp, offsets=V - Vm0, lod=lod)
    vi, ji, w, parents = mhrlib.skin_weights(lod)
    rec = np.zeros(len(vi), dtype=[('v', '<u4'), ('j', '<u4'), ('w', '<f4')])
    rec['v'], rec['j'], rec['w'] = vi, ji, w
    rec.tofile(os.path.join(OUT, 'weights.bin'))
    json.dump({'names': jn, 'parents': parents.tolist(), 'positions': np.round(P, 5).tolist(), 'rotation': np.round(sk[:, 3:7], 6).tolist(), 'mapping': joint_mapping(jn)},
              open(os.path.join(OUT, 'joints.json'), 'w'), ensure_ascii=False)
    json.dump(conflict, open(os.path.join(OUT, 'conflict-map.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(OUT, 'conflict-map.txt'), 'w').write('\n'.join(log))
    shutil.copy(os.path.join(mhrlib.DIR, 'LICENSE.txt'), os.path.join(OUT, 'LICENSE-MHR.txt'))
    open(os.path.join(OUT, 'NOTICE-MHR.txt'), 'w').write(
        '本目录中的 skin.obj、deep-envelope.obj、weights.bin、joints.json 由 Momentum Human Rig (MHR) v1.0.1 派生。\n'
        'skin.obj, deep-envelope.obj, weights.bin and joints.json in this directory are derived from Momentum Human Rig (MHR) v1.0.1.\n\n'
        'MHR: Copyright (c) Meta Platforms, Inc. and affiliates. Licensed under the Apache License, Version 2.0 (see LICENSE-MHR.txt).\n'
        'https://github.com/facebookresearch/MHR\n'
        '改动 / changes: identity, skeleton scale and pose fitted to the soma female; breasts scaled; local outward relaxation over bone; inward offset for the deep envelope.\n')
    json.dump({
        'schema': 1,
        'kind': 'target',
        'what': {'zh': '女性目标体表和深层包络：供管线把她的软组织重塑到其内。不是可装入的皮肤包（没有 fittedTo）。',
                 'en': 'Female target skin and deep envelope, for the pipeline to reshape her soft tissue into. Not an installable skin package (no fittedTo).'},
        'source': {'name': 'Momentum Human Rig (MHR) v1.0.1', 'url': 'https://github.com/facebookresearch/MHR', 'license': 'Apache-2.0',
                   'attribution': 'MHR, Copyright (c) Meta Platforms, Inc. and affiliates, licensed under the Apache License 2.0; shaped for this body by tools/bodyshape'},
        'basedOn': {'body': 'female', 'key': key},
        'frame': 'metres, Y up, +Z anterior, +X subject left; same origin as public/anatomy/female',
        'controls': {'sex': 'F', 'statureM': 1.606, 'bmi': bmi_t, 'legLength': -1.0, 'centralBuild': 0.0,
                     'note': {'zh': '身高是骨架决定的；MHR 的身份系数由该身高、BMI 下的女性围度目标求出', 'en': 'stature is set by her skeleton; MHR identity is solved from the female girth targets at that stature and BMI'}},
        'achieved': stat,
        'mhr': {'identity': [round(float(v), 4) for v in ident], 'lod': lod},
        'subcutaneousThicknessMm': {
            'nominalByRegion': nominal,
            'note': {'zh': '名义值 = 皮下脂肪标准厚度（rig-shape.json 的 fat，来自 fat-literature.json 的回归，取 BMI 21.6）+ 2 mm 皮肤；头、颈、膝、手、足的值是假定的，不是文献值。'
                           '胸、腹按前后在两值之间过渡。乳房下方包络贴着胸壁基面。薄的部位不超过局部厚度的 40 %；骨更近处减到骨面外 0.5 mm。',
                     'en': 'nominal = standard subcutaneous fat (fat in rig-shape.json, from the regressions in fat-literature.json at BMI 21.6) + 2 mm of skin; the values for head, neck, knee, hand and foot are '
                           'assumed, not from the literature. Chest and abdomen blend between their front and back values. Under the breasts the envelope follows the chest-wall base. In thin parts at most '
                           '40 % of the local thickness; where bone is closer, reduced to 0.5 mm outside the bone.'},
            'effectiveByRegion': thick},
        'boneFeasibility': {'minimumSkinCoverOverBoneMm': BONE_COVER * 1000, 'envelopeClearanceOverBoneMm': 0.5, 'skinRelaxationByRegion': relax_by,
                            'bonesOutsideEnvelopeAfter': len(conflict['boneParts'])},
        'files': {'skin.obj': f'{len(V)} vertices, {len(F)} triangles, closed: {closed}', 'deep-envelope.obj': 'same topology and vertex order as skin.obj',
                  'conflict-map.json, conflict-map.txt': 'present deep parts against the envelope, by region and by part; bone conflicts before the relaxation',
                  'joints.json, weights.bin': 'MHR joints in this pose (with the mapping to rig joints) and skin weights',
                  'target-state.npz': 'MHR identity, parameters and per-vertex offsets of skin.obj, for the later final fit',
                  'LICENSE-MHR.txt, NOTICE-MHR.txt': 'licence text and attribution'},
    }, open(os.path.join(OUT, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
    print('\n'.join(log))

    # ---- 渲染 / renders
    skin = (0.86, 0.72, 0.62)
    bv, bf = fb.merged(lambda p: p['tissue'] in ES.GROUPS['bone'] and p['system'] != 'integumentary')
    mv, mf = fb.merged(lambda p: p['tissue'] in ES.GROUPS['muscle'] and p['system'] != 'integumentary')
    ov, of = fb.merged(lambda p: p['tissue'] in ES.GROUPS['organ'] and p['system'] != 'integumentary')
    inner = [(mv, mf, (0.78, 0.15, 0.15)), (bv, bf, (0.97, 0.97, 0.88)), (ov, of, (0.25, 0.45, 0.8))]
    render_views([(V, F, skin)], os.path.join(OUT, 'preview-skin.png'), height=1100)
    render_views([(V, F, skin)] + inner, os.path.join(OUT, 'preview-skin-conflicts.png'), height=1100,
                 title='target skin; present deep parts that show are OUTSIDE it (muscle red, bone white, organs blue)')
    render_views([(E, F, (0.7, 0.75, 0.8))] + inner, os.path.join(OUT, 'preview-envelope-conflicts.png'), height=1100,
                 title='deep envelope (grey-blue); present deep parts that show are outside it')
    shy = 0.5 * (L['shoulder_L'][1] + L['shoulder_R'][1])
    render_closeup([(V, F, skin)], os.path.join(OUT, 'closeup-head-chest.png'), [-0.25, shy - 0.30, -0.12], [0.25, V[:, 1].max() + 0.01, 0.30], views=('front', 'side'))


if __name__ == '__main__':
    main()
