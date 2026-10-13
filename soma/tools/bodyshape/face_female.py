"""
女性的脸：按法医面部复原的做法，从她自己的颅骨和下颌骨出发。
The female face, built from her own skull and mandible the way forensic facial approximation does it.

供 final_female.py --face 调用（可重复运行，内部结构重建后照样能用）：
Called by final_female.py --face (re-runnable; it carries over when the internals are rebuilt):

  1 landmarks(fb)      在颅骨上按几何找颅面测量标志点，配上女性的软组织厚度，得到“皮肤应该经过的点”。
                       craniometric landmarks found on the skull by geometry, with female soft-tissue depths: the points the skin should pass through.
  2 fit_identity(...)  MHR 头部身份系数（20–39）对这些点做带先验的岭回归（限幅 1.5），不是放开拟合。
                       MHR head identity (20-39) fitted to those points by ridge regression with a prior (bounded at 1.5), not set free.
  3 warp(...)          拟合之后的平滑变形（高斯径向基，σ 32 mm，位移场再抹平），把皮肤带到这些点上；眼睑区不动。
                       a smooth deformation after the fit (Gaussian radial basis, sigma 32 mm, the displacement field smoothed again) that brings the skin onto the points; the lid regions do not move.

厚度的来源 / sources of the depths
  正中 11 点：Sonita 等 2025，Front. Dent. Med. 6:1714360（柬埔寨 18–25 岁成人，女 150 人，头颅侧位片；已打开，表为文字）。不是中国人群；未报告 BMI。
  Midline, 11 points: Sonita et al. 2025, Front. Dent. Med. 6:1714360 (Cambodian adults aged 18-25, 150 women, lateral cephalograms; opened, the
  table is printed as text). Not a Chinese sample; BMI not reported.
  两侧 5 点（眶上缘中点、眶下缘中点、颧点、下颌角点、下颌支中点）：凭记忆取自 Stephan 的 T-Table（成人、不分性别的汇总均值），未能打开原文核对，标为未核实。
  Bilateral, 5 points (mid-supraorbital, mid-infraorbital, zygion, gonion, mid-ramus): from memory of Stephan's T-Table (adult, sex-pooled grand
  means); the paper could not be opened, so these are marked unverified.
  我打开过的另一篇（Cha 2013，韩国成人）的表是图片，读不到数字，没有用。
  One more paper I opened (Cha 2013, South Korean adults) prints its table as an image; no number could be read and none is used.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enclose_skin as ES  # noqa: E402
import mhrlib  # noqa: E402
from fit_check import signed_distance  # noqa: E402
from fit_skin import vertex_normals  # noqa: E402

SRC_MID = 'Sonita et al. 2025, Front. Dent. Med. 6:1714360, females (n = 150, Cambodian, 18-25 y), opened'
SRC_LAT = ('Hona & Stephan 2024, Int J Legal Med 138:519-535, adult 2023 T-Table (pooled over sexes and populations, rounded to 0.5 mm), '
           'as opened and recorded by the knowledge audit (data/curated/knowledge/citation-audit.json, entry on facial soft-tissue depths); not opened again here')
# 标志点: (厚度 mm, 来源, 是否进入变形)。正中用女性样本（Sonita 2025）；两侧和颊部用 2023 T-Table（不分性别；综述说男性均值比女性大不到 1 mm）。
# 鼻骨下端不进入变形（鼻子用 MHR 自己的，放在梨状孔上），只报告。唇按厚度表（协调方的决定：现有的 Lip 部件来自男性、贴在牙上，不作依据）。
# landmark: (depth mm, source, used by the warp). Midline from the female sample (Sonita 2025); bilateral and cheek points from the 2023
# T-Table (sex-pooled; the review says male means exceed female ones by under 1 mm). Rhinion is not used by the warp (the nose is
# MHR's own, placed on the aperture) and is reported only. The lips follow the depth table (the coordinator's decision: the present part "Lip" is male-derived and lies on the teeth, so it is no guide).
DEPTH = {'glabella': (5.22, SRC_MID, True), 'nasion': (5.87, SRC_MID, True), 'rhinion': (2.56, SRC_MID, False), 'subnasale': (13.58, SRC_MID, True),
         'labraleSuperius': (13.40, SRC_MID, True), 'labraleInferius': (14.09, SRC_MID, True), 'labiomentale': (12.11, SRC_MID, True), 'pogonion': (11.46, SRC_MID, True),
         'gnathion': (8.45, SRC_MID, True), 'menton': (7.36, SRC_MID, True),
         'midSupraorbital': (7.0, SRC_LAT, True), 'midInfraorbital': (6.5, SRC_LAT, True), 'zygion': (7.5, SRC_LAT, True), 'gonion': (12.5, SRC_LAT, True),
         'midRamus': (19.5, SRC_LAT, True), 'supraM2': (26.0, SRC_LAT, True), 'infraM2': (22.0, SRC_LAT, True), 'midMandibularBorder': (11.0, SRC_LAT, True)}
SIGMA = 0.045    # 诊断渲染表明沟纹来自变形而不是身份系数：σ 加大、正则加强，宁可在标志点上差 1–3 mm / the diagnostic renders show the furrows come from the warp, not the identity: a larger sigma and stronger regularisation, at the price of 1-3 mm at the landmarks


def _unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def landmarks(fb):
    """返回 {名字: {'bone': 骨上的点, 'dir': 量厚度的方向, 'depthMm', 'target': 皮肤应经过的点, 'source'}}。
    Returns {name: {'bone': point on bone, 'dir': direction of the depth, 'depthMm', 'target': the point the skin should pass through, 'source'}}."""
    fr = fb.verts('Frontal bone')
    na = np.vstack([fb.verts('Left nasal bone'), fb.verts('Right nasal bone')])
    mx = np.vstack([fb.verts('Left maxilla'), fb.verts('Right maxilla')])
    md = fb.verts('Mandible')
    zy = {'L': fb.verts('Left zygomatic bone'), 'R': fb.verts('Right zygomatic bone')}
    ui = np.vstack([fb.verts(n) for n in ('Left upper central secondary incisor tooth', 'Right upper central secondary incisor tooth')])
    li = np.vstack([fb.verts(n) for n in ('Left lower central secondary incisor tooth', 'Right lower central secondary incisor tooth')])
    eye = {'L': fb.verts('Left vitreous body').mean(0), 'R': fb.verts('Right vitreous body').mean(0)}
    xc = float(np.median(na[:, 0]))
    mid = lambda V, w=0.004: V[np.abs(V[:, 0] - xc) < w]
    P = {}
    n_ = mid(na)
    P['nasion'] = (n_[np.argmax(n_[:, 1])], [0, 0, 1])
    f_ = mid(fr)
    f_ = f_[(f_[:, 1] > P['nasion'][0][1]) & (f_[:, 1] < P['nasion'][0][1] + 0.025)]
    P['glabella'] = (f_[np.argmax(f_[:, 2])], [0, 0, 1])
    low = na[na[:, 1] < np.percentile(na[:, 1], 12)]
    P['rhinion'] = (low[np.argmax(low[:, 2])] * [0, 1, 1] + [xc, 0, 0], [0, 0.3, 1])
    m_ = mid(mx, 0.006)
    ans = m_[np.argmax(m_[:, 2])]
    P['subnasale'] = (ans, [0, -0.2, 1])
    P['labraleSuperius'] = (ui[np.argmax(ui[:, 2])] * [0, 1, 1] + [xc, 0, 0], [0, 0, 1])
    P['labraleInferius'] = (li[np.argmax(li[:, 2])] * [0, 1, 1] + [xc, 0, 0], [0, 0, 1])
    d_ = mid(md, 0.006)
    ys = np.linspace(d_[:, 1].min() + 0.002, li[:, 1].min(), 40)
    prof = np.array([[y, d_[np.abs(d_[:, 1] - y) < 0.0015][:, 2].max()] for y in ys if (np.abs(d_[:, 1] - y) < 0.0015).any()])
    ip = int(np.argmax(prof[:len(prof) * 6 // 10, 1]))
    P['pogonion'] = (np.array([xc, prof[ip, 0], prof[ip, 1]]), [0, 0, 1])
    ib = ip + int(np.argmin(prof[ip:, 1]))
    if ib - ip < 3:   # 骨面上没有颏唇沟的凹陷：取颏前点到下切牙牙槽之间 45 % 高度处 / no concavity on the bone: taken at 45 % of the height from pogonion to the lower incisor alveolus
        ib = ip + int(0.45 * (len(prof) - 1 - ip))
    P['labiomentale'] = (np.array([xc, prof[ib, 0], prof[ib, 1]]), [0, 0, 1])
    me = d_[np.argmin(d_[:, 1])]
    P['menton'] = (me, [0, -1, 0])
    gn = d_[np.argmin(d_[:, 1] - d_[:, 2])]
    P['gnathion'] = (gn, [0, -1, 1])
    for S, sg in (('L', 1), ('R', -1)):
        e = eye[S]
        a = fr[(np.abs(fr[:, 0] - e[0]) < 0.003) & (fr[:, 1] < e[1] + 0.030) & (fr[:, 1] > e[1] + 0.008)]
        P['midSupraorbital_' + S] = (a[np.argmax(a[:, 2] - a[:, 1])], [0, 0.3, 1])
        b = np.vstack([mx, zy[S]])
        b = b[(np.abs(b[:, 0] - e[0]) < 0.003) & (b[:, 1] < e[1] - 0.008) & (b[:, 1] > e[1] - 0.028)]
        P['midInfraorbital_' + S] = (b[np.argmax(b[:, 2] + b[:, 1])], [0, -0.2, 1])
        z = zy[S]
        P['zygion_' + S] = (z[np.argmax(sg * z[:, 0])], [sg, 0, 0.2])
        s_ = md[sg * (md[:, 0] - xc) > 0.030]
        go = s_[np.argmin(s_[:, 1] + s_[:, 2])]
        P['gonion_' + S] = (go, [sg * 0.8, -0.5, -0.3])
        top = s_[:, 1].max()
        r_ = s_[(np.abs(s_[:, 1] - 0.5 * (go[1] + top)) < 0.004) & (s_[:, 2] < go[2] + 0.03)]
        P['midRamus_' + S] = (r_[np.argmax(sg * r_[:, 0])], [sg, 0, 0])
        # 颊部没有骨：厚度表在上、下第二磨牙处给值（supra-M2 / infra-M2）。骨上的点取该牙颊面最外侧点所在的牙槽缘高度，方向向外。
        # There is no bone under the cheek: the tables give depths at the upper and lower second molars (supra-M2 / infra-M2). The point is
        # taken at the alveolar margin over the most buccal point of that tooth, direction lateral.
        side = 'Left' if S == 'L' else 'Right'
        for nm, tooth, up in (('supraM2', f'{side} upper second secondary molar tooth', True), ('infraM2', f'{side} lower second secondary molar tooth', False)):
            t_ = fb.verts(tooth)
            q = t_[np.argmax(sg * t_[:, 0])].copy()
            q[1] = t_[:, 1].max() - 0.004 if up else t_[:, 1].min() + 0.004
            P[nm + '_' + S] = (q, [sg, 0, 0.15])
        m1 = fb.verts(f'{side} lower first secondary molar tooth')
        bd = s_[np.abs(s_[:, 2] - m1[:, 2].mean()) < 0.004] if (np.abs(s_[:, 2] - m1[:, 2].mean()) < 0.004).any() else s_
        P['midMandibularBorder_' + S] = (bd[np.argmin(bd[:, 1] - sg * 0.3 * bd[:, 0])], [sg * 0.5, -1, 0])
    out = {}
    for k, (b, d) in P.items():
        dep, src, use = DEPTH[k.split('_')[0]]
        d = _unit(d)
        out[k] = {'bone': np.asarray(b, float), 'dir': d, 'depthMm': dep, 'target': np.asarray(b, float) + dep / 1000.0 * d, 'source': src, 'use': use}
    return out


def residuals(lm, V, F):
    """各目标点到皮肤的有符号距离（mm；正 = 目标点在皮肤外，即那里皮肤太薄）/ signed distance of each target to the skin (mm; positive = the target is outside the skin, the cover is too thin there)"""
    T = np.array([v['target'] for v in lm.values()])
    return dict(zip(lm, signed_distance(T, V, F) * 1000))


def fit_identity(ident, mp, lod, lm, V, F, wh, log, ridge=0.004, bound=1.5):
    """头部身份系数的一步带先验的线性解：身份分量对顶点是线性的，所以只要每个分量跑一次 MHR。V 是当前（已做颅顶、眼、下半脸变形的）皮肤。
    One linear, prior-weighted step for the head identity: identity components act linearly on the vertices, so one MHR run per
    component suffices. V is the present skin (with crown, eye and lower-face deformations applied)."""
    import igl
    T = np.array([v['target'] for v in lm.values() if v['use']])
    d2, fi, c = igl.point_mesh_squared_distance(np.ascontiguousarray(T), np.ascontiguousarray(V), np.ascontiguousarray(F))[:3]
    n = vertex_normals(V, F)
    tri = F[fi]
    nn = n[tri].mean(1)
    nn /= np.linalg.norm(nn, axis=1)[:, None]
    r = signed_distance(T, V, F)
    V0 = mhrlib.run(ident, mp, lod, True)[0]
    J = np.zeros((len(T), 20))
    for j in range(20):
        c2 = ident.copy()
        c2[20 + j] += 1.0
        dV = mhrlib.run(c2, mp, lod, True)[0] - V0
        J[:, j] = np.einsum('ij,ij->i', nn, dV[tri].mean(1))
    from scipy.optimize import lsq_linear
    a = lsq_linear(np.vstack([J, ridge * np.eye(20)]), np.r_[r, -ridge * ident[20:40]], bounds=(-bound - ident[20:40], bound - ident[20:40])).x
    out = ident.copy()
    out[20:40] += a
    log.append(f'  face identity (20-39) from {len(T)} landmark targets, ridge {ridge}, bound {bound}: {np.round(out[20:40], 2).tolist()}; '
               f'RMS distance of the targets to the skin {np.sqrt(np.mean(r ** 2)) * 1000:.1f} -> predicted {np.sqrt(np.mean((r - J @ a) ** 2)) * 1000:.1f} mm')
    return out


def warp(V, F, lm, wh, lod, log, cap=0.015):
    """把皮肤带到目标点上的平滑变形：每个目标点处的位移 = 目标点 - 皮肤上离它最近的点，用高斯径向基内插（带一点正则），单点不超过 12 mm。
    Smooth deformation that brings the skin onto the targets: the displacement at each target is target minus the closest point of
    the skin, interpolated by Gaussian radial basis functions (lightly regularised), at most 12 mm at a landmark."""
    import igl
    T = np.array([v['target'] for v in lm.values() if v['use']])
    c = igl.point_mesh_squared_distance(np.ascontiguousarray(T), np.ascontiguousarray(V), np.ascontiguousarray(F))[2]
    D = T - c
    ln = np.linalg.norm(D, axis=1)
    D = D * np.minimum(1.0, cap / np.maximum(ln, 1e-9))[:, None]
    K = np.exp(-((c[:, None, :] - c[None, :, :]) ** 2).sum(-1) / (2 * SIGMA ** 2))
    W = np.linalg.solve(K + 0.35 * np.eye(len(c)), D)
    head = np.where(wh > 0.02)[0]
    Kx = np.exp(-((V[head][:, None, :] - c[None, :, :]) ** 2).sum(-1) / (2 * SIGMA ** 2))
    pw, reg = ES.face_protect(lod)
    lids = np.zeros(len(V))
    lids[reg['lidsL']] = lids[reg['lidsR']] = 1.0
    A = ES.adjacency(len(V), F)
    core = lids > 0
    for _ in range(9):       # 眼睑区向外扩九圈，再抹平成宽的缓坡（窄了会在颞部和眶外侧留折痕）/ the lid regions grown by nine rings, then smoothed into a wide ramp (a narrow one leaves creases on the temple and beside the orbit)
        lids = np.maximum(lids, (A @ lids > 0).astype(float))
    for _ in range(30):
        lids = 0.5 * lids + 0.5 * (A @ lids)
        lids[core] = 1.0
    U = np.zeros_like(V)
    U[head] = (wh[head] * (1.0 - lids[head]))[:, None] * (Kx @ W)
    for _ in range(6):       # 位移场本身抹平，避免在颌下、眶外侧留下折痕 / the displacement field itself is smoothed, so no crease is left under the jaw or beside the orbit
        U = 0.5 * U + 0.5 * (A @ U)
    out = V + U
    log.append(f'  face warp: displacement asked at the landmarks median {np.median(ln) * 1000:.1f}, max {ln.max() * 1000:.1f} mm (capped at {cap * 1000:.0f})')
    return out


def save(lm, path, extra=None):
    json.dump({'note': {'zh': '颅骨上的标志点（米，我们的坐标系）、厚度方向、厚度和来源、皮肤应经过的目标点', 'en': 'landmarks on the skull (metres, our frame), direction of the depth, depth with its source, and the target the skin should pass through'},
               'landmarks': {k: {'bone': np.round(v['bone'], 4).tolist(), 'direction': np.round(v['dir'], 3).tolist(), 'depthMm': v['depthMm'], 'target': np.round(v['target'], 4).tolist(), 'source': v['source'], 'usedByWarp': bool(v['use'])} for k, v in lm.items()},
               **(extra or {})}, open(path, 'w'), ensure_ascii=False, indent=1)
