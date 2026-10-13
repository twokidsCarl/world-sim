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
  2 头：头颈姿势 + 整个头的等比缩放，对“颅骨 + 软组织厚度”的面和两个眼球中心拟合；头部身份系数固定为 0；眼以上再做颅顶缩放。
    head: head and neck pose + one isotropic scale of the whole head are fitted to the surface "skull + soft-tissue
    thickness" and to the two eyeball centres; the head identity is held at 0; the cranium above the eyes is then scaled.
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


def head_blend(lod, A, V=None, fb=None):
    """头部“不受软组织外推”的权重：只含面部和颅盖，按颅骨的轮廓定。乳突以下、耳后、下颌下缘以下（整个颈部）为 0，照常包住。
    面部：在乳突前方 20 mm 以前、且在下颌下缘（颏下点到下颌角点的连线）以上；颅盖：乳突尖以上 20 mm 以上。边界处抹平 8 遍。
    Weight of "no push from soft tissue" on the head: face and vault only, following the outline of the skull. Below the mastoid, behind
    the ear and below the mandibular border (the whole neck) it is 0 and the normal enclosure applies. Face: more than 20 mm in front of
    the mastoid and above the mandibular border (the line from menton to gonion); vault: more than 20 mm above the mastoid tip.
    Smoothed 8 times at the boundary."""
    vi, ji, w, _ = mhrlib.skin_weights(lod)
    jn = mhrlib.joint_names(lod)
    hj = np.array([n.startswith(HEAD_JOINTS) for n in jn]) * 1.0
    hb = np.zeros(mhrlib.LOD_VERTICES[lod])
    np.add.at(hb, vi, w * hj[ji])
    hb = np.clip(hb, 0, 1)
    if V is not None and fb is not None:
        import face_female as _F
        lm = _F.landmarks(fb)
        tl, tr = fb.verts('Left temporal bone'), fb.verts('Right temporal bone')
        mast = 0.5 * (tl[np.argmin(tl[:, 1])] + tr[np.argmin(tr[:, 1])])
        me, go = lm['menton']['bone'], 0.5 * (lm['gonion_L']['bone'] + lm['gonion_R']['bone'])
        t = np.clip((V[:, 2] - go[2]) / max(me[2] - go[2], 1e-6), 0, 1)
        border = go[1] + t * (me[1] - go[1])
        vault = V[:, 1] > mast[1] + 0.020
        face = (V[:, 2] > mast[2] + 0.020) & (V[:, 1] > border + 0.004)
        hb = hb * (vault | face)
    for _ in range(8):
        hb = 0.5 * hb + 0.5 * (A @ hb)
    return hb


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
        c[20:40] = ident[20:40] + x[npose:npose + 20]   # 在传入的头部身份系数上加（女性传入的是 0）/ added to the incoming head identity (0 for the female)
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
            # 头部身份系数固定为 0：放开它们（即使限幅 2.5）拟合会把多数系数顶到边界，脸被拉长到眼–颏 148 mm（她的颅骨是 93 + 软组织）。
            # 目标那一版“脸长”就是这么来的。MHR 的平均脸在水平方向与她的颅骨相配，差的只是眼以上的高度（见下面的颅顶缩放）。
            # The head identity is held at 0: set free (even bounded at 2.5) the fit drives most coefficients to their bounds
            # and stretches the face to 148 mm from eye to chin (her skull has 93 + soft tissue). That is where the long
            # face of the target came from. MHR's average face matches her skull horizontally; only the height above
            # the eyes is short (see the cranium scale below).
            xn[npose:npose + 20] = 0.0
            # 整头等比缩放固定为 1：MHR 平均头的宽、长（158 / 187 mm）与她的颅骨加软组织（约 151 / 189）相配；放开它会缩到 0.97，
            # 颅顶就更不够高。差的是眼以上的高度：MHR 眼到头顶 101 mm，她的颅骨 109 mm 加头皮。
            # The isotropic scale of the whole head is held at 1: breadth and length of MHR's average head (158 / 187 mm)
            # match her skull plus soft tissue (about 151 / 189); set free it shrinks to 0.97 and the crown is shorter
            # still. What is missing is height above the eyes: 101 mm from eye to top in MHR, 109 mm of skull plus scalp in her.
            xn[-1] = 1.0
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


def face_landmarks(ident, lod):
    """MHR 网格正中矢状轮廓上两个标志点的顶点下标（拓扑固定，所以可以在任何姿势的网格上读它们的位置）：
    口裂 = 上下唇相贴处那道褶里被埋住的顶点；颏下点 = 正中轮廓上、比颏前点后退不超过 12 mm 的最低顶点。在给定身份系数的中性网格上找。
    Vertex indices of two landmarks on the midsagittal profile of the MHR mesh (the topology is fixed, so their position
    can be read on the mesh in any pose): stomion = the vertices buried in the crease where the lips meet; menton = the
    lowest vertex of the midline profile no more than 12 mm behind the pogonion. Found on the neutral mesh of the given identity."""
    import igl
    V, P, _ = mhrlib.run(ident, np.zeros(204), lod, True)
    jn, F = mhrlib.joint_names(lod), mhrlib.faces(lod)
    e = 0.5 * (P[jn.index('l_eye')] + P[jn.index('r_eye')])
    n = vertex_normals(V, F)
    w = igl.fast_winding_number(np.ascontiguousarray(V), np.ascontiguousarray(F), np.ascontiguousarray(V + 0.002 * n))
    lips = np.where((w > 0.5) & (np.abs(V[:, 0]) < 0.02) & (V[:, 1] < e[1] - 0.04) & (V[:, 1] > e[1] - 0.10) & (V[:, 2] > e[2]))[0]
    sto = float(e[1] - V[lips, 1].mean())
    mid = np.where((np.abs(V[:, 0]) < 0.003) & (V[:, 2] > e[2] - 0.02) & (V[:, 1] < e[1] - sto - 0.02) & (V[:, 1] > e[1] - 0.16))[0]
    pog = V[mid, 2].max()
    cand = mid[V[mid, 2] > pog - 0.012]
    return lips, int(cand[np.argmin(V[cand, 1])])


def lip_verts(fb):
    """深层的唇部件的顶点：一个部件（Lip）或两个（Upper lip、Lower lip）都接受。
    Vertices of the deep lip part: one part (Lip) or two (Upper lip, Lower lip) are both accepted."""
    vs = [fb.mesh(p)[0] for p in fb.parts if p['name'] in ('Lip', 'Upper lip', 'Lower lip')]
    if not vs:
        raise KeyError('no part named Lip, Upper lip or Lower lip')
    return np.vstack(vs)


LIPS_BY_TABLE = False
CHIN_SOFT = 0.007     # 颏下点处的软组织厚度（假定值）/ soft tissue under the menton (assumption)
INCISOR_SHOW = 0.002  # 静止时口裂在上中切牙切缘上方 2 mm（临床上常说静止露齿 1–3 mm；假定值，没有核对文献）
#                       at rest the oral fissure lies 2 mm above the edge of the upper central incisors (a resting incisor
#                       display of 1-3 mm is the usual clinical statement; an assumption, not checked against a source)


def face_scale(V, F, pivot, wh, fb, log, marks):
    """下半张脸对到她/他的牙和下颌骨上。标志点的位置直接在当前姿势的网格上读（上一版用中性姿势的数值，头有俯仰时口裂偏了约 1 cm）。
    高度：口裂对到上中切牙切缘上方 2 mm，颏下点对到下颌骨最低点下方 7 mm，用单调三次插值（PCHIP）过渡，没有折线的拐点
    （上一版分段线性，在鼻、口、颏的高度留下了横向的台阶）。前后：口裂处移到“唇在皮下 1 mm”，颏处移到“颏前骨面上 10 mm”。
    The lower face is brought onto her or his teeth and mandible. The landmarks are read on the mesh in its present pose
    (the previous version used neutral-pose numbers and put the oral fissure about 1 cm off when the head is pitched).
    Height: stomion goes 2 mm above the edge of the upper central incisors and menton 7 mm below the lowest point of the
    mandible, blended by a monotone cubic (PCHIP) with no corners (the previous piecewise-linear map left horizontal steps
    at the level of nose, mouth and chin). Front to back: at the mouth as far as leaves the lips 1 mm under the skin, at
    the chin as far as leaves 10 mm over the front of the bony chin."""
    from scipy.interpolate import PchipInterpolator
    crease, menton = marks
    s0, m0 = float(pivot[1] - V[crease, 1].mean()), float(pivot[1] - V[menton, 1])
    inc = np.vstack([fb.verts(n) for n in ('Left upper central secondary incisor tooth', 'Right upper central secondary incisor tooth')])
    sto = float(pivot[1] - (inc[:, 1].min() + INCISOR_SHOW))
    men = float(pivot[1] - (fb.verts('Mandible')[:, 1].min() - CHIN_SOFT))
    fy = PchipInterpolator([-0.06, -0.03, 0.0, s0, m0, m0 + 0.25], [-0.06, -0.03, 0.0, sto, men, men + 0.25])
    log.append(f'  lower face, height: stomion {s0 * 1000:.1f} -> {sto * 1000:.1f} mm below the eyes, menton {m0 * 1000:.1f} -> {men * 1000:.1f} mm')

    def remap(X, zk=None):
        d = np.clip(pivot[1] - X[:, 1], -0.06, m0 + 0.25)
        Y = X.copy()
        Y[:, 1] = X[:, 1] + wh * (d - fy(d))
        if zk is not None:
            Y[:, 2] = X[:, 2] + wh * PchipInterpolator([-0.06, 0.0, 0.03, s0, m0, m0 + 0.25], [0.0, 0.0, 0.0, zk[0], zk[1], zk[1]])(d)
        return Y

    Y0 = remap(V)
    lipv = lip_verts(fb)
    lipv = lipv[lipv[:, 2] > np.percentile(lipv[:, 2], 70)]
    lip_cover = float(np.percentile(-signed_distance(lipv, Y0, F), 10))
    man = fb.verts('Mandible')
    chin = man[(np.abs(man[:, 0] - np.median(man[:, 0])) < 0.015) & (man[:, 2] > man[:, 2].max() - 0.006)]
    chin_cover = float(np.min(-signed_distance(chin, Y0, F)))
    zk = [float(np.clip(-(lip_cover - 0.001), -0.014, 0.006)), float(np.clip(-(chin_cover - 0.010), -0.012, 0.004))]
    if LIPS_BY_TABLE:   # 唇的前后位置交给厚度表的变形（face_female.warp），这里不动 / the front-to-back position of the lips is left to the depth-table warp (face_female.warp)
        zk[0] = 0.0
    log.append(f'  lower face, front to back: the lips (part "Lip") lay {lip_cover * 1000:.1f} mm under the skin and the front of the bony chin had {chin_cover * 1000:.1f} mm of cover; '
               f'skin moved {zk[0] * 1000:+.1f} mm at the mouth and {zk[1] * 1000:+.1f} mm at the chin (+ = forwards)')
    return lambda X: remap(X, zk)


def eye_warp(V, F, P, jn, wh, fb, lod, log):
    """把每侧的睑裂移到眼球上：眶周皮肤的一个平滑的局部平移（半径 40 mm，按 smoothstep 衰减），在拟合之后施加。
    睑裂中点取眼关节外侧 2.7 mm 处；目标是玻璃体的形心（左右、上下方向）。
    然后前后方向把眼睑移到角膜最前点在皮下 0.8 mm 处（半径 25 mm）。眼睑面本身不变形，所以仍是光滑的。
    Move each palpebral fissure onto its globe: a smooth local translation of the periorbital skin (radius 40 mm, smoothstep
    falloff), applied after the fit. The middle of the fissure is taken 2.7 mm lateral of the eye joint; the target is the centroid of the vitreous body
    (left-right and up-down). Then, front to back, the lids move until the front of the cornea is 0.8 mm under the skin
    (radius 25 mm). The lid surface itself is not deformed, so it stays smooth."""
    reg = ES.face_protect(lod)[1]
    A = ES.adjacency(len(V), F)
    V = V.copy()
    info = {}
    for S, j, side in (('L', 'l_eye', 'Left'), ('R', 'r_eye', 'Right')):
        idx = reg['lids' + S]
        # 睑裂中点：MHR 的内、外眦中点在眼关节外侧约 2.7 mm（我按顶点最密的睑缘量到 2.2 mm，表情层在装好的皮肤上量到约 3.2 mm，取中间）；高度取眼关节。
        # Middle of the fissure: in MHR the midpoint of the canthi lies about 2.7 mm lateral of the eye joint (2.2 mm by my
        # measure on the densest lid-margin vertices, about 3.2 mm by the expression layer on the installed skin; the
        # middle is used); its height is that of the eye joint.
        cf = P[jn.index(j)] + np.array([0.0027 if S == 'L' else -0.0027, 0.0, 0.0])
        c = fb.verts(f'{side} vitreous body').mean(0)
        t = np.array([c[0] - cf[0], c[1] - cf[1], 0.0])
        r = np.linalg.norm((V - cf)[:, :2], axis=1)
        u = np.clip(1 - r / 0.040, 0, 1)
        w = wh * u * u * (3 - 2 * u) * (V[:, 2] > cf[2] - 0.03)
        # 同时把眶周这一片在左右方向绕睑裂中点缩小一点（1 - |平移| / 45 mm）：MHR 的睑裂长约 34 mm，整片内移会把内眦和鼻根之间的皮肤挤出褶子。
        # The patch is also narrowed a little left to right about the middle of the fissure (1 - |shift| / 45 mm): MHR's
        # fissure is about 34 mm long, and moving the whole patch medially crumples the skin between inner canthus and nasal root.
        k = 1.0 - abs(t[0]) / 0.045
        V = V + w[:, None] * (t + np.stack([(k - 1.0) * (V[:, 0] - cf[0]), np.zeros(len(V)), np.zeros(len(V))], 1))
        cor = np.vstack([fb.verts(p['name']) for p in fb.parts if 'cornea' in p['name'].lower() and side.lower() in p['name'].lower()])
        cover = float(np.min(-signed_distance(cor, V, F)))
        dz = float(np.clip(-(cover - 0.0008), -0.006, 0.006))
        u2 = np.clip(1 - np.linalg.norm((V - (cf + t))[:, :2], axis=1) / 0.025, 0, 1)
        V[:, 2] += wh * u2 * u2 * (3 - 2 * u2) * (V[:, 2] > cf[2] - 0.03) * dz
        info[S] = {'fissureMiddleToGlobeCentreBeforeMm': [round(float(-t[0] * 1000), 1), round(float(-t[1] * 1000), 1)], 'corneaCoverBeforeMm': round(cover * 1000, 1), 'movedZMm': round(dz * 1000, 1)}
        log.append(f'  eye {S}: middle of the fissure lay (x, y) {info[S]["fissureMiddleToGlobeCentreBeforeMm"]} mm from the centre of the globe; periorbital skin moved by that; cornea cover was {cover * 1000:.1f} mm, lids moved {dz * 1000:+.1f} mm front to back')
    return V, info


# 乳头位置的来源：Al-Qattan 等 2019（Plast Reconstr Surg Glob Open，PMC6756646）：54 名未生育的年轻女性（22.1 ± 1.2 岁，BMI 21.8 ± 3.1），
# 胸骨上切迹到乳头 19.8 ± 2.5 cm，两乳头间距 20.3 ± 2.3 cm。人群是沙特女性，不是中国女性；BMI 与我们的默认值相近。
# Source for the nipple position: Al-Qattan et al. 2019 (Plast Reconstr Surg Glob Open, PMC6756646): 54 young nulliparous
# women (22.1 +/- 1.2 years, BMI 21.8 +/- 3.1), sternal notch to nipple 19.8 +/- 2.5 cm, internipple distance
# 20.3 +/- 2.3 cm. The population is Saudi, not Chinese; the BMI is close to our default.
NOTCH_TO_NIPPLE, INTERNIPPLE = 0.198, 0.203
# 中国女性的数值（知识库审计 data/curated/knowledge/citation-audit.json；本处没有再打开原文）：体积 325–340 mL，切迹到乳头约 19.05 cm，两乳头间距约 20.0 cm。
# Chinese figures (knowledge audit, data/curated/knowledge/citation-audit.json; the papers were not opened again here): volume 325-340 mL,
# notch to nipple about 19.05 cm, internipple about 20.0 cm.
NOTCH_TO_NIPPLE, INTERNIPPLE, BREAST_ML_CN = 0.1905, 0.200, 332.5


def place_breasts(Vm, F, L, A, fb, log, volume_ml):
    """把 MHR 的乳房移到有来源的位置上，并使左右相同。做法：先取下 MHR 自己的乳房（见下），左侧的隆起作为模板，
    加到新的乳头位置上，右侧用它的镜像；再整体缩放到每侧 volume_ml。
    乳头位置：到胸骨上切迹的直线距离 19.8 cm，离正中 10.15 cm。
    Move MHR's breasts to a sourced position and make left and right the same. MHR's own breasts are taken off first (below); the mound of the left side is the template, added back at the
    new nipple position, and the right side gets its mirror image; both are then scaled to volume_ml each. Nipple position: 19.8 cm in a straight line from the sternal notch, 10.15 cm from the midline."""
    from scipy.interpolate import LinearNDInterpolator
    man = fb.verts('Manubrium')
    xc = float(np.median(man[:, 0]))
    top = man[np.abs(man[:, 0] - xc) < 0.006]
    notch = np.array([xc, top[:, 1].max(), top[top[:, 1] > top[:, 1].max() - 0.004][:, 2].max()])
    zc = 0.25 * (L['hip_L'][2] + L['hip_R'][2] + L['shoulder_L'][2] + L['shoulder_R'][2])
    shy = 0.5 * (L['shoulder_L'][1] + L['shoulder_R'][1])
    # 先把 MHR 自己的乳房“取下来”：用原来的小区域（最前点周围 75 mm）的胸壁基面 B0，隆起 h = V - B0；
    # 皮肤在该区换成 B0（平胸），再把左侧的隆起（右侧用其镜像）加到新的位置上。
    # First MHR's own breasts are taken off: with the chest-wall base B0 of the original small zone (75 mm round the most
    # anterior point) the mound is h = V - B0; the skin of that zone becomes B0 (a flat chest), and the mound of the left
    # side (its mirror image on the right) is added back at the new place.
    mask0, B0, _ = BT.breast_base(Vm, F, L, A)
    flat = Vm.copy()
    flat[mask0] = B0[mask0]
    grow = mask0.copy()
    for _ in range(4):
        grow = grow | (A @ grow.astype(float) > 0)
    for _ in range(25):      # 把取下乳房后留在区域边上的折线抹平 / smooth the crease left along the rim of the zone
        flat[grow] = (0.5 * flat + 0.5 * (A @ flat))[grow]
    mL = np.where(mask0 & (Vm[:, 0] > xc))[0]
    hL = Vm[mL] - B0[mL]
    apexL = B0[mL[np.argmax(hL[:, 2])]]
    g = LinearNDInterpolator(np.stack([B0[mL, 0] - apexL[0], B0[mL, 1] - apexL[1]], 1), hL, fill_value=0.0)
    V = flat.copy()
    mask = mask0.copy()
    fac, vols, new_masks = {}, {}, {}
    for S, sg in (('L', 1), ('R', -1)):
        x_t = xc + sg * INTERNIPPLE / 2
        zs = flat[(np.linalg.norm(flat[:, :2] - np.array([x_t, notch[1] - 0.14]), axis=1) < 0.02) & (flat[:, 2] > zc)][:, 2]
        z_ap = (zs.max() if len(zs) else notch[2] + 0.04) + float(hL[:, 2].max())
        drop = np.sqrt(max(NOTCH_TO_NIPPLE ** 2 - (INTERNIPPLE / 2) ** 2 - (z_ap - notch[2]) ** 2, 1e-6))
        tgt = np.array([x_t, notch[1] - drop])
        # 放上去以后量实际的隆起顶点，按它与要求位置（离正中 10.15 cm、到切迹 19.8 cm）之差修正模板中心，做三遍。
        # After placing, the actual apex of the mound is measured and the template centre corrected by its difference from
        # the required position (10.15 cm from the midline, 19.8 cm from the notch); three passes.
        for _ in range(3):
            ms = (np.linalg.norm(flat[:, :2] - tgt, axis=1) < 0.085) & (flat[:, 2] > zc) & (sg * (flat[:, 0] - xc) > 0.002)
            h = g(np.stack([sg * (flat[ms, 0] - tgt[0]), flat[ms, 1] - tgt[1]], 1))
            h[:, 0] *= sg
            rr = np.clip((0.082 - np.linalg.norm(flat[ms, :2] - tgt, axis=1)) / 0.03, 0, 1)
            hf = np.zeros_like(flat)
            hf[ms] = h * (rr * rr * (3 - 2 * rr))[:, None]     # 边缘渐变到 0 / fades to 0 at the rim
            for _ in range(4):                                  # 再把隆起本身抹平几遍 / and the mound itself is smoothed a few times
                hf = 0.5 * hf + 0.5 * (A @ hf)
            h = hf[ms]
            W = flat.copy()
            W[ms] = flat[ms] + h
            v1 = BT.patch_volume(W, flat, F, ms, S) * 1e6
            fac[S] = float(np.clip(volume_ml / max(v1, 1.0), 0.5, 2.0))
            Vt = flat.copy()
            Vt[ms] = flat[ms] + fac[S] * h
            ap = Vt[ms][np.argmax(Vt[ms][:, 2] - flat[ms][:, 2])]
            want_y = notch[1] - np.sqrt(max(NOTCH_TO_NIPPLE ** 2 - (ap[0] - notch[0]) ** 2 - (ap[2] - notch[2]) ** 2, 1e-6))
            tgt = tgt + np.array([x_t - ap[0], want_y - ap[1]])
        V[ms] = Vt[ms]
        vols[S] = BT.patch_volume(V, flat, F, ms, S) * 1e6
        new_masks[S] = ms
        mask |= ms
    B = flat
    apex0 = {'L': apexL, 'R': apexL * np.array([-1, 1, 1]) + np.array([2 * xc, 0, 0])}
    info = {'source': f'Chinese figures recorded by the knowledge audit (citation-audit.json; not opened again here): notch to nipple {NOTCH_TO_NIPPLE * 100:.2f} cm, internipple {INTERNIPPLE * 100:.1f} cm, volume {volume_ml:.1f} mL per breast (middle of 325-340)',
            'sternalNotch': np.round(notch, 4).tolist(), 'sides': {}}
    for S, sg in (('L', 1), ('R', -1)):
        ms = new_masks[S]
        ap = V[ms][np.argmax(V[ms][:, 2] - B[ms][:, 2])]
        info['sides'][S] = {'apexBefore': np.round(apex0[S], 4).tolist(), 'apex': np.round(ap, 4).tolist(), 'notchToApexMm': round(float(np.linalg.norm(ap - notch) * 1000), 1),
                            'apexFromMidlineMm': round(float(abs(ap[0] - xc) * 1000), 1), 'projectionMm': round(float((V[ms][:, 2] - B[ms][:, 2]).max() * 1000), 1),
                            'volumeMl': round(vols[S]), 'templateScale': round(fac[S], 3)}
    log.append('  breasts: ' + json.dumps(info['sides']))
    return V, B, mask, info


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
    # --out <目录>：写到另一个包目录；--face：按她的颅骨和女性软组织厚度做脸（face_female.py）
    # --out <dir>: write to another package directory; --face: build the face from her skull and female soft-tissue depths (face_female.py)
    OUT = os.path.join(RAW, 'out', sys.argv[sys.argv.index('--out') + 1]) if '--out' in sys.argv else globals()['OUT']
    face_on = '--face' in sys.argv
    os.makedirs(OUT, exist_ok=True)
    if not os.path.exists(os.path.join(OUT, 'pose-cache.npz')) and os.path.exists(os.path.join(globals()['OUT'], 'pose-cache.npz')):
        import shutil
        shutil.copy(os.path.join(globals()['OUT'], 'pose-cache.npz'), os.path.join(OUT, 'pose-cache.npz'))
    key = json.load(open('public/anatomy/female/pipeline-report.json'))['skinPackage']['internalsKey']
    fb = Body('female')
    L = bone_landmarks(fb)
    log = [f'female final fit; internals key {key}; target BMI {bmi_t}']
    lod = 0
    cache = os.path.join(OUT, 'pose-cache.npz')
    if '--reuse-pose' in sys.argv and os.path.exists(cache):
        cz = np.load(cache)
        ident, mp = cz['identity'].copy(), cz['mp'].copy()
        ident[20:40] = 0.0
        log.append('  body pose reused from pose-cache.npz; head fitted again')
        ident, mp, hs, head_info = fit_head(ident, mp, fb, log)
    else:
        # 起点：上一次女性拟合的姿势（female-skin-prev2/pose-cache.npz）；没有时退回目标的姿势。
        # 分三段解，其余参数固定：(1) 上臂、肘、前臂、腕；(2) 再放开手指（含各节长度缩放），手指的转动先归零（她的手指已被摆直）；
        # (3) 下肢和足。一次全部放开、只解 8 步时没有收敛：指尖差 25–57 mm，手和足的骨大片露在皮肤外。
        # Start: the pose of the previous female fit (female-skin-prev2/pose-cache.npz), or the target's when that is missing.
        # Solved in three stages with everything else held: (1) upper arm, elbow, forearm, wrist; (2) fingers too (with segment length
        # scales), finger rotations first set to zero (her fingers were straightened); (3) lower limbs and feet. With everything free and
        # only 8 steps it did not converge: fingertips 25-57 mm off and the bones of hands and feet largely outside the skin.
        prev = os.path.join(RAW, 'out', 'female-skin-prev2', 'pose-cache.npz')
        tz = np.load(prev if os.path.exists(prev) else os.path.join(TARGET, 'pose-cache.npz'))
        ident, mp = tz['identity'].copy(), tz['mp'].copy()
        ident[20:40] = 0.0
        FS.BOUNDS.update({'scale_hip_height': 0.6, 'scale_spine_length': 0.6, 'scale_hip_depth': 0.6})
        jt, _ = joint_targets('female', fb, L)
        main_w = {'uparm': 8.0, 'lowarm': 8.0, 'wrist': 8.0, 'upleg': 4.0, 'lowleg': FS.KW, 'foot': 6.0}
        jt = [(j, p, main_w.get(j[2:], w)) for j, p, w in jt]
        Pb = fb.merged(lambda p: p['tissue'] == 'bone')[0]
        Pb = Pb[~np.isin(classify(Pb, L), ['hand', 'foot'])]
        Pb = Pb[np.random.default_rng(3).choice(len(Pb), 4000, replace=False)]
        fit = Fit('female', 'targets', fb, L, jt, bone_pts=Pb, top_floor=(L['vertex'][1], L['floor'][1]), subcut=subcutaneous_points(fb))
        fit.identity = ident.copy()
        fit.bone_weight = 1.0
        fingers = ('thumb', 'index', 'middle', 'ring', 'pinky')
        x = mp[fit.pidx].copy()
        for i, n_ in enumerate(fit.pnames):
            if any(t in n_ for t in fingers) and not n_.startswith('scale'):
                x[i] = 0.0
        lo0, hi0 = fit.lo.copy(), fit.hi.copy()
        arm = lambda n_: any(t in n_ for t in ('uparm', 'elbow', 'lowarm', 'wrist')) and not n_.startswith('scale')
        fing = lambda n_: any(t in n_ for t in fingers)
        leg = lambda n_: any(t in n_ for t in ('upleg', 'knee', 'lowleg', 'foot', 'ball', 'ankle'))
        for tag, rule, iters in (('arms', arm, 10), ('arms and fingers', lambda n_: arm(n_) or fing(n_), 16), ('legs and feet', leg, 10)):
            free = np.array([rule(n_) for n_ in fit.pnames])
            fit.lo, fit.hi = lo0.copy(), hi0.copy()
            fit.lo[~free], fit.hi[~free] = x[~free] - 1e-9, x[~free] + 1e-9
            log.append(f'  pose stage "{tag}": {int(free.sum())} free parameters')
            x = fit.solve(iters, log, x)
        mp[fit.pidx] = x
        log.append('  joint residuals after the pose fit (mm): ' + json.dumps(fit.joint_residuals(x)))
        ident, mp, hs, head_info = fit_head(ident, mp, fb, log)
        np.savez(cache, identity=ident, mp=mp, head_scale=hs, head_info=json.dumps(head_info))

    F, jn = mhrlib.faces(lod), mhrlib.joint_names(lod)
    A = ES.adjacency(mhrlib.LOD_VERTICES[lod], F)
    wh = head_weight(lod)
    H = lambda W: W[:, 1].max() - W[:, 1].min()
    bmi_of = lambda W: mesh_volume(W, F) * 1010.0 / H(W) ** 2

    # ---- 3 头、眼、下半张脸；乳房；BMI / head, eyes, lower face; breasts; BMI
    crown = None
    marks = face_landmarks(ident, lod)
    lm, hb_pts = None, None
    if face_on:
        import face_female as FFACE
        lm = FFACE.landmarks(fb)
        # 唇按厚度表；口裂在上切牙切缘上方 2.75 mm（知识库审计：文献范围 2–3.4 mm，年轻女性 2.5–3 mm）
        # lips by the depth table; oral fissure 2.75 mm above the upper incisal edge (knowledge audit: published range 2-3.4 mm, 2.5-3 mm for a young woman)
        globals()['LIPS_BY_TABLE'] = True
        globals()['INCISOR_SHOW'] = 0.00275
        # 先按身份系数为 0 的头做一遍全部变形，量目标点的偏差，再解头部身份系数；之后各变形按新的头重算。
        # One pass of all deformations with the head identity at 0, to measure how far the targets are off; then the head
        # identity is solved, and every deformation is computed again for the new head.
        Vp, Pp, _ = mhrlib.run(ident, mp, lod, True)
        Vp = BT.head_scale(Vp, F, Pp, jn, lod, fb, [])(Vp)
        Vp, _ = eye_warp(Vp, F, Pp, jn, wh, fb, lod, [])
        pv = 0.5 * (fb.verts('Left vitreous body').mean(0) + fb.verts('Right vitreous body').mean(0))
        Vp = face_scale(Vp, F, pv, wh, fb, [], marks)(Vp)
        res_before = FFACE.residuals(lm, Vp, F)
        np.save(os.path.join(OUT, 'face-before.npy'), Vp)
        if '--no-face-identity' not in sys.argv:   # 诊断用：身份系数留在先验均值 / diagnostic: identity left at the prior mean
            ident = FFACE.fit_identity(ident, mp, lod, lm, Vp, F, wh, log)
        marks = face_landmarks(ident, lod)
    for it in range(3):
        Vm0, P, _ = mhrlib.run(ident, mp, lod, True)
        Vm = scale_head(Vm0, P, jn, wh, hs)
        if crown is None:
            crown = BT.head_scale(Vm, F, P, jn, lod, fb, log)
        Vm = crown(Vm)
        Vm, eye_info = eye_warp(Vm, F, P, jn, wh, fb, lod, log if it == 2 else [])
        pivot = 0.5 * (fb.verts('Left vitreous body').mean(0) + fb.verts('Right vitreous body').mean(0))
        Vm = face_scale(Vm, F, pivot, wh, fb, log if it == 2 else [], marks)(Vm)
        if face_on:
            Vi = Vm.copy()
            for _ in range(0 if '--no-face-warp' in sys.argv else 2):   # --no-face-warp：诊断用 / diagnostic
                Vm = FFACE.warp(Vm, F, lm, wh, lod, log if it == 2 else [])
            # 骨不能在皮肤外：头部的骨上至少留 2.5 mm（只对骨，位移低通，至多 10 mm：拟合出的头部身份系数使颅部变小，顶骨曾露出 6 mm）。眉间处皮肤原来薄了 1.6 mm、额骨露出 1.7 mm。
            # Bone may never be outside the skin: at least 2.5 mm is kept over head bone (bone only, low-passed, at most 10 mm: the fitted head identity makes the cranium smaller, and the parietal bones then showed by 6 mm). The skin was 1.6 mm thin at glabella and the frontal bone showed by 1.7 mm.
            if hb_pts is None:
                _Pd, _grp, _, _ = ES.deep_samples(fb)
                hb_pts = _Pd[(_grp == list(ES.GROUPS).index('bone')) & (classify(_Pd, L) == 'head')]
            for _rep in range(3):   # 抹平会把抬起的量削掉一些，所以做三遍 / the smoothing takes some of the raise back, hence three passes
              sb = signed_distance(hb_pts, Vm, F)
              if (sb > -0.0025).any():
                  keep_m = ES.MARGIN
                  ES.MARGIN = 0.0032
                  Vq = ES.enclose(Vm, F, hb_pts[sb > -0.004], [], np.full(len(Vm), 0.022), passes=8)
                  ES.MARGIN = keep_m
                  nq = vertex_normals(Vm, F)
                  for _ in range(3):
                      nq = 0.5 * nq + 0.5 * (A @ nq)
                  nq /= np.maximum(np.linalg.norm(nq, axis=1), 1e-12)[:, None]
                  dq = spread(np.einsum('ij,ij->i', Vq - Vm, nq).clip(0), A, np.full(len(Vm), 0.022), rings=4, smooth=10, final=5)
                  Vm = Vm + (wh * dq)[:, None] * nq
            if True:
                if it == 2 and 'dq' in dir():
                    log.append(f'  head bone cover: skin raised on {int((dq > 0.0002).sum())} vertices, max {dq.max() * 1000:.1f} mm; least cover over head bone now {-signed_distance(hb_pts, Vm, F).max() * 1000:.1f} mm')
            if it == 2:
                res_id, res_after = FFACE.residuals(lm, Vi, F), FFACE.residuals(lm, Vm, F)
                FFACE.save(lm, os.path.join(OUT, 'face-landmarks.json'), {'targetToSkinMm': {k: {'meanHead': round(float(res_before[k]), 1), 'afterIdentity': round(float(res_id[k]), 1), 'afterWarp': round(float(res_after[k]), 1)} for k in lm},
                                                                         'headIdentity20to39': np.round(ident[20:40], 3).tolist()})
                log.append('  face: target-to-skin distance at the landmarks, mm (+ = skin too thin there): mean head / after identity / after warp')
                for k in lm:
                    log.append(f'     {k:20s} {res_before[k]:+6.1f} {res_id[k]:+6.1f} {res_after[k]:+6.1f}')
        V, B, mask, breast_info = place_breasts(Vm, F, L, A, fb, log if it == 2 else [], BREAST_ML_CN)
        b = bmi_of(V)
        log.append(f'  round {it}: volume BMI {b:.2f}')
        if it < 2:
            ident[0] += (bmi_t - b) / 5.3
    head_info = dict(head_info, eyes=eye_info, breasts=breast_info)
    V_shape = V.copy()     # 目标体型（未放松）/ the target shape before any relaxation
    if '--target-only' in sys.argv:
        # 只交付干净的目标：不做任何放松或外推（骨、肌肉都不让皮肤让路），写 skin.obj 就结束。
        # Deliver the clean target only: no relaxation and no push of any kind (the skin gives way to neither bone nor muscle); write skin.obj and stop.
        from fit_skin import write_obj
        write_obj(os.path.join(OUT, 'skin.obj'), V_shape, F, 'female TARGET skin with the face built from her skull (not an installable package); MHR LOD0 topology (Apache-2.0); metres, Y up, +Z anterior, +X left')
        np.savez(os.path.join(OUT, 'target-shape.npz'), V=V_shape, chestBase=B)
        np.savez(os.path.join(OUT, 'target-state.npz'), identity=ident, mp=mp, offsets=V_shape - Vm0, lod=lod)
        json.dump({'internalsKey': key, 'head': head_info, 'bmiByVolume': round(bmi_of(V_shape), 2), 'statureM': round(float(H(V_shape)), 4)}, open(os.path.join(OUT, 'final-fit.json'), 'w'), ensure_ascii=False, indent=1)
        open(os.path.join(OUT, 'final-fit.txt'), 'w').write('\n'.join(log) + '\n')
        print('\n'.join(log))
        return
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
    pw = ES.face_protect(lod)[0]     # 眼睑和唇保留 MHR 自己的面 / lids and lips keep MHR's own surface
    d_bone = d_bone * (1 - pw)
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
    fat_f = float(sys.argv[sys.argv.index('--fat-cover') + 1]) if '--fat-cover' in sys.argv else 1.0
    bmi_enclose_only = bmi_of(Vb + spread(d0, A, cap_s)[:, None] * nrm)
    d_soft = spread(d0 + fat_f * extra, A, cap_s)
    d_soft = d_soft * (1 - pw)
    if face_on:   # 头上不做软组织的外推（协调方的决定）/ no push from soft tissue on the head (the coordinator's decision)
        d_soft = d_soft * (1 - head_blend(lod, A, Vb, fb))
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
    log.append('BMI by volume: target shape %.2f, after bone relaxation %.2f, after soft relaxation %.2f (%.2f if the skin only enclosed the muscle, without the standard fat over it; fat-cover factor %.2f)' % (bmi_of(V_shape), bmi_of(Vb), bmi_of(V), bmi_enclose_only, fat_f))
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
