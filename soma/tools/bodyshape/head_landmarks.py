"""
头部皮肤上的标志点、量度和并排渲染（head_outline.py 用）。
Skin landmarks on the head, measurements and side-by-side renders (used by head_outline.py).

标志点都在 MHR 的静止（直立）头上按几何找，返回顶点下标；拓扑固定，所以在任何姿势的网格上都能读到位置。
Every landmark is found by geometry on MHR's rest (upright) head and returned as a vertex index; the topology is fixed, so
its position can be read on the mesh in any pose.
"""
import os

import igl
import numpy as np

import enclose_skin as ES
from fit_skin import vertex_normals
C = np.ascontiguousarray

def profile_extreme(Vp, idx, lo, hi, d):
    m = idx[(Vp[idx, 1] >= lo) & (Vp[idx, 1] <= hi)]
    return int(m[np.argmax(Vp[m] @ np.array(d, float))])

def head_landmarks(V, F, P, jn, wh, lips, menton_i):
    """静止（直立）头上的皮肤标志点：返回 {名字: 顶点下标}，以及口裂的顶点列。
    Skin landmarks on the rest (upright) head: {name: vertex index}, and the vertices of the oral fissure."""
    n = vertex_normals(V, F)
    e = 0.5 * (P[jn.index('l_eye')] + P[jn.index('r_eye')])
    eL, eR = P[jn.index('l_eye')], P[jn.index('r_eye')]
    hd = np.where(wh > 0.5)[0]
    w = igl.fast_winding_number(C(V), C(F), C(V[hd] + 0.002 * n[hd]))
    ext = np.zeros(len(V), bool); ext[hd[w < 0.5]] = True
    mid = np.where(ext & (np.abs(V[:, 0]) < 0.0007) & (wh > 0.5))[0]
    front = mid[V[mid, 2] > e[2] - 0.03]
    L = {}
    sto_y = float(V[lips, 1].mean())
    L['pronasale'] = profile_extreme(V, front, sto_y + 0.008, e[1], [0, 0, 1])
    prn = V[L['pronasale']]
    L['sellion'] = profile_extreme(V, front, prn[1] + 0.015, e[1] + 0.015, [0, 0, -1])
    se = V[L['sellion']]
    L['glabella'] = profile_extreme(V, front, se[1] + 0.006, se[1] + 0.03, [0, -0.15, 1])
    # 鼻下点：鼻小柱与上唇之间折角最大处 / subnasale: the sharpest concave bend between columella and upper lip
    seg = front[(V[front, 1] < prn[1] - 0.002) & (V[front, 1] > max(sto_y + 0.006, prn[1] - 0.016))]
    seg = seg[np.argsort(-V[seg, 1])]
    best, bi = -9, seg[0]
    for k in range(2, len(seg) - 2):
        a, b = V[seg[k - 2]] - V[seg[k]], V[seg[k + 2]] - V[seg[k]]
        ang = np.arccos(np.clip(a @ b / np.linalg.norm(a) / np.linalg.norm(b), -1, 1))
        conc = ((V[seg[k - 2]] + V[seg[k + 2]]) / 2 - V[seg[k]])[2] > 0
        if conc and np.pi - ang > best:
            best, bi = np.pi - ang, seg[k]
    L['subnasale'] = int(bi)
    sn = V[L['subnasale']]
    L['labraleSuperius'] = profile_extreme(V, front, sto_y + 0.001, sn[1] - 0.004, [0, 0, 1])
    L['labraleInferius'] = profile_extreme(V, front, sto_y - 0.012, sto_y - 0.001, [0, 0, 1])
    L['menton'] = int(menton_i)
    me = V[menton_i]
    L['pogonion'] = profile_extreme(V, front, me[1] + 0.004, sto_y - 0.022, [0, 0, 1])
    pg = V[L['pogonion']]
    L['labiomentale'] = profile_extreme(V, front, pg[1] + 0.003, V[L['labraleInferius'], 1] - 0.003, [0, 0, -1])
    L['gnathion'] = profile_extreme(V, front, me[1] - 0.002, pg[1], [0, -1, 1])
    L['vertex'] = int(hd[np.argmax(V[hd, 1])])
    L['opisthocranion'] = profile_extreme(V, mid, e[1] - 0.03, e[1] + 0.06, [0, 0, -1])
    L['stomion'] = int(lips[np.argmin(np.abs(V[lips, 0]) + np.abs(V[lips, 1] - sto_y))])
    # 耳：头侧面上法线朝内的顶点（耳背、耳甲壁）所占的范围 / the ear: the extent of the vertices on the side of the head whose normals face medially (back of the auricle, walls of the concha)
    thin = np.zeros(len(V), bool)
    xmax = float(np.abs(V[hd, 0]).max())
    for sg in (1, -1):
        for thr in (0.15, 0.3, 0.45, 0.6):   # 耳廓浅的头上放宽 / relaxed on heads with a shallow auricle
            M = hd[(V[hd, 0] * sg > 0.6 * xmax) & (n[hd, 0] * sg < thr) & (V[hd, 1] > e[1] - 0.05) & (V[hd, 1] < e[1] + 0.03) & (V[hd, 2] < e[2] - 0.05) & (V[hd, 2] > e[2] - 0.13)]
            if len(M) >= 30:
                break
        lo, hi = V[M][:, 1:].min(0) - 0.004, V[M][:, 1:].max(0) + 0.004
        thin |= (wh > 0.5) & (V[:, 0] * sg > 0.55 * xmax) & (V[:, 1] > lo[0]) & (V[:, 1] < hi[0]) & (V[:, 2] > lo[1]) & (V[:, 2] < hi[1])
    fiss = lips[np.argsort(V[lips, 0])]
    for S, sg, ej in (('L', 1, eL), ('R', -1, eR)):
        X = V * [sg, 1, 1]
        ej = ej * [sg, 1, 1]
        earv = np.where(thin & (X[:, 0] > 0))[0]
        ec = X[earv].mean(0)
        # 外耳道：从外侧向内看，比周围一圈最凹的地方 / ear canal: seen from lateral, the point deepest relative to a ring round it
        side = hd[(X[hd, 0] > 0.04) & (np.linalg.norm(X[hd][:, 1:] - ec[1:], axis=1) < 0.03) & (n[hd, 0] * sg > 0.2)]
        g = np.array([[y, z] for y in np.arange(ec[1] - 0.02, ec[1] + 0.02, 0.0015) for z in np.arange(ec[2] - 0.008, ec[2] + 0.025, 0.0015)])
        def hitx(q):
            d = np.linalg.norm(X[side][:, None, 1:] - q[None], axis=2)
            xs = np.where(d < 0.0025, X[side][:, None, 0], -1)
            return xs.max(0), side[np.argmax(xs, 0)]
        hx, hi_ = hitx(g)
        ring = np.array([hitx(g + 0.011 * np.array([np.cos(a), np.sin(a)]))[0] for a in np.linspace(0, 2 * np.pi, 8, endpoint=False)])
        score = ring.mean(0) - hx
        score[(hx < 0) | (ring < 0).any(0)] = -1
        L['earCanal_' + S] = int(hi_[np.argmax(score)])
        ca = X[L['earCanal_' + S]]
        plain = (wh > 0.5) & ext & ~thin & (X[:, 0] > 0)
        cand = np.where(plain & (X[:, 1] > ej[1] + 0.03))[0]
        L['euryon_' + S] = int(cand[np.argmax(X[cand, 0])])
        cand = np.where(plain & (X[:, 2] > ca[2] + 0.012) & (X[:, 1] < ej[1] - 0.002) & (X[:, 1] > ej[1] - 0.035))[0]
        L['zygion_' + S] = int(cand[np.argmax(X[cand, 0])])
        # 下颌角：正面轮廓上（耳道以前）转折最大的地方 / gonion: the sharpest turn of the frontal outline of the face (in front of the ear canal)
        ys = np.arange(me[1] + 0.006, sto_y - 0.004, 0.002)
        out = []
        for y in ys:
            c2 = np.where(plain & (np.abs(X[:, 1] - y) < 0.002) & (X[:, 2] > ca[2] - 0.002))[0]
            out.append(c2[np.argmax(X[c2, 0])] if len(c2) else -1)
        out = np.array(out); ok = out >= 0; out = out[ok]
        best, bi = -9, out[len(out) // 2]
        for k in range(4, len(out) - 5):
            a, b = (X[out[k - 4]] - X[out[k]])[:2], (X[out[k + 4]] - X[out[k]])[:2]
            t = np.pi - np.arccos(np.clip(a @ b / np.linalg.norm(a) / np.linalg.norm(b), -1, 1))
            if t > best:
                best, bi = t, out[k]
        L['gonion_' + S] = int(bi)
        go = X[bi]
        near = lambda q, mask=plain: int(np.where(mask)[0][np.argmin(np.linalg.norm(X[mask] - q, axis=1))])
        def onskin(q):   # 沿 x 方向落到皮肤上 / dropped onto the skin along x
            c2 = np.where(plain & (np.linalg.norm(X[:, 1:] - q[1:], axis=1) < 0.004))[0]
            return int(c2[np.argmax(X[c2, 0])])
        L['midRamus_' + S] = onskin(0.5 * (go + ca + [0, 0, 0.008]))
        q = ca + [0, -0.012, -0.024]
        c2 = np.where((wh > 0.5) & ext & (X[:, 0] > 0.03) & (n[:, 0] * sg > 0.3) & (np.linalg.norm(X[:, 1:] - q[1:], axis=1) < 0.004))[0]
        L['mastoid_' + S] = int(c2[np.argmin(X[c2, 0])])
        def onskin_z(x, y):
            c2 = np.where(plain & (np.abs(X[:, 0] - x) < 0.003) & (np.abs(X[:, 1] - y) < 0.003) & (X[:, 2] > ej[2] - 0.01))[0]
            return int(c2[np.argmax(X[c2, 2])])
        par = np.where(plain & (np.abs(X[:, 0] - ej[0]) < 0.0025) & (X[:, 2] > ej[2]))[0]
        L['superciliare_' + S] = profile_extreme(X, par, ej[1] + 0.012, ej[1] + 0.03, [0, -0.3, 1])
        L['infraorbitalSkin_' + S] = onskin_z(ej[0], ej[1] - 0.017)
        L['frontalEminence_' + S] = onskin_z(0.028, V[L['glabella'], 1] + 0.038)
        L['cheilion_' + S] = int(fiss[-1] if sg > 0 else fiss[0])
        nose = np.where(plain | thin)[0]
        nose = nose[(X[nose, 0] > 0) & (X[nose, 0] < 0.024) & (X[nose, 1] < prn[1] + 0.008) & (X[nose, 1] > sn[1] - 0.002) & (X[nose, 2] > sn[2] - 0.006)]
        L['alare_' + S] = int(nose[np.argmax(X[nose, 0])])
    return L, fiss, thin

def measures(V, L, thin, wh):
    p = lambda k: V[L[k]]
    d = lambda a, b: float(np.linalg.norm(p(a) - p(b)) * 1000)
    w = lambda k: float(abs(p(k + '_L')[0] - p(k + '_R')[0]) * 1000)
    tr = 0.5 * (p('earCanal_L') + p('earCanal_R'))
    m = {'headBreadth': w('euryon'), 'headLength_glabellaOpisthocranion': d('glabella', 'opisthocranion'), 'earCanalToTopOfHead': float((p('vertex')[1] - tr[1]) * 1000),
         'bizygomaticBreadth': w('zygion'), 'bigonialBreadth': w('gonion'), 'mentonSellionLength': d('menton', 'sellion'),
         'mentonToTopOfHead': float((p('vertex')[1] - p('menton')[1]) * 1000),
         'lowerFaceHeight_subnasaleMenton': d('subnasale', 'menton'), 'noseHeight_sellionSubnasale': d('sellion', 'subnasale'), 'mouthWidth': w('cheilion'), 'nasalWidth_alar': w('alare'),
         'nasalTipProjection_aheadOfSubnasale': float((p('pronasale')[2] - p('subnasale')[2]) * 1000),
         'upperLipHeight_subnasaleStomion': float((p('subnasale')[1] - p('stomion')[1]) * 1000), 'lowerLipHeight_stomionLabiomentale': float((p('stomion')[1] - p('labiomentale')[1]) * 1000),
         'upperVermilionHeight_labraleSuperiusStomion': float((p('labraleSuperius')[1] - p('stomion')[1]) * 1000), 'lowerVermilionHeight_stomionLabraleInferius': float((p('stomion')[1] - p('labraleInferius')[1]) * 1000)}
    m['bigonialOverBizygomatic'] = m['bigonialBreadth'] / m['bizygomaticBreadth']
    m['frankfortTiltDeg_earCanalToInfraorbital'] = float(np.degrees(np.arctan2(0.5 * (p('infraorbitalSkin_L') + p('infraorbitalSkin_R'))[1] - tr[1], 0.5 * (p('infraorbitalSkin_L') + p('infraorbitalSkin_R'))[2] - tr[2])))
    return {k: round(v, 3 if 'Over' in k else 1) for k, v in m.items()}


# ---------------------------------------------------------------- 渲染 / renders
from bodylib import render_closeup  # noqa: E402

SKIN = (0.87, 0.72, 0.62)

def sphere(c, r, n=24):
    th, ph = np.meshgrid(np.linspace(0, np.pi, n), np.linspace(0, 2 * np.pi, 2 * n, endpoint=False), indexing='ij')
    V = c + r * np.c_[(np.sin(th) * np.cos(ph)).ravel(), np.cos(th).ravel(), (np.sin(th) * np.sin(ph)).ravel()]
    F = []
    m = 2 * n
    for i in range(n - 1):
        for j in range(m):
            a, b, c2, d = i * m + j, i * m + (j + 1) % m, (i + 1) * m + j, (i + 1) * m + (j + 1) % m
            F += [[a, c2, b], [b, c2, d]]
    return V, np.array(F)

def sheet(rows, out, height=1000, angles=(0, -35, -90), cols=None):
    """rows: [(title, layers, centre_xz(eye mid), top_y)]"""
    from PIL import Image
    R_ = []
    for name, layers, eye, top in rows:
        c0 = np.array([eye[0], 0, eye[2] - 0.08])
        ims = []
        for ang in angles:
            a = np.radians(ang)
            R = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
            Lr = [((v - c0) @ R.T + c0, f[(v[:, 1] > top - 0.30)[f].all(1)], c) for v, f, c in layers]
            tmp = out + '.tmp.png'
            render_closeup(Lr, tmp, [eye[0] - 0.14, top - 0.27, -1], [eye[0] + 0.14, top + 0.01, 1], views=('front',), height=height, title=name if ang == angles[0] else None)
            ims.append(Image.open(tmp).convert('RGB')); os.remove(tmp)
        W = Image.new('RGB', (sum(i.width for i in ims), max(i.height for i in ims)), 'white')
        x = 0
        for i in ims:
            W.paste(i, (x, 0)); x += i.width
        R_.append(W)
    if cols:
        n = (len(R_) + cols - 1) // cols
        W = Image.new('RGB', (cols * R_[0].width, n * R_[0].height), 'white')
        for k, r in enumerate(R_):
            W.paste(r, ((k % cols) * r.width, (k // cols) * r.height))
    else:
        W = Image.new('RGB', (max(r.width for r in R_), sum(r.height for r in R_)), 'white')
        y = 0
        for r in R_:
            W.paste(r, (0, y)); y += r.height
    W.save(out)
