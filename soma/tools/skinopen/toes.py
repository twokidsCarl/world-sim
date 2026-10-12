# 足趾：把供体脚（Blender Studio Human Base Meshes 的 “Foot - Realistic”，CC0）的五个游离趾接到皮肤包的皮肤上。
# 由 graft.py 的 toes 步骤调用。
# The toes: grafts the five free toes of the donor foot ("Foot - Realistic" of Blender Studio's Human Base Meshes,
# CC0) into the skin of a skin package. Called by the toes step of graft.py.
#
# 概念（第 10 节）/ the concept (section 10 of INTEGRATION.txt)
#   · 游离趾从趾蹼开始，不从跖趾关节开始。供体的趾蹼 → 本体近节趾骨上的一个位置（蹼位，按近节趾骨长度的比例），
#     供体的趾尖 → 本体远节趾骨末端加软组织垫。趾蹼之后是包里皮肤的前脚掌。
#     A free toe begins at the web, not at the metatarsophalangeal joint. The donor's web goes to a station on this
#     body's proximal phalanx (a fraction of its length), the donor's tip to the end of the distal phalanx plus a
#     soft-tissue pad. Behind the webs the surface is the package skin's ball of the foot.
#   · 骨说了算：趾的轴线和长度取自趾骨。甲板部件不作依据（它们是按旧皮肤摆的）。
#     The bones are the authority for the axis and length of a toe. The nail plate parts are not (they were placed
#     for an older skin).
#   · 粗细：供体的截面按每趾一个比例缩放，再在骨上覆盖不足处局部向外推到“骨面 + 软组织厚度”。
#     Girth: the donor's cross-section is scaled by one factor per toe, and then pushed out locally to "bone surface +
#     soft-tissue cover" wherever the cover would be less.

import copy
import json
import os

import numpy as np
import scipy.sparse.csgraph as csgraph
from scipy.spatial import cKDTree

import scipy.sparse as sp
import scipy.sparse.linalg as spla

from open_skin import MM, TAGS, graph, half_edge_map, unique_edges, write_obj
from graft import Chain, ORDINAL, donor_toes, graft, vertex_graph

HBM_SOURCE = {'name': 'Blender Studio "Human Base Meshes" asset bundle v1.4.1, asset "Foot - Realistic"', 'url': 'https://www.blender.org/download/demo-files/', 'license': 'CC0', 'author': 'Dan Ulrich (as stated in the asset)',
              'note': 'the asset describes itself as "Realistic scan data model with multiresolution details"; it is a retopologised base mesh, has no skeleton, and is not this person\'s foot'}

# 假设（都写进报告）/ assumptions (all recorded in the report)
PAD_MM = 3.0            # 远节趾骨末端之外的软组织垫 / soft-tissue pad beyond the end of the distal phalanx
COVER_MM = 1.5          # 趾骨上最少的软组织覆盖 / least soft-tissue cover over a phalanx
COVER_JOINT_MM = 1.0    # 骨端（关节处）可接受的覆盖 / cover accepted at the bone ends (joints)
PUSH_MM = 2.6           # 局部外推的目标覆盖（留出网格弦高的余量）/ target of the local push (leaves room for the chord error of the mesh)
WEB_FRACTION = (0.50, 0.85)  # 蹼位在近节趾骨上的范围（自基底起的比例）/ range of the web station along the proximal phalanx (fraction from its base)
TOE_GAP_MM = 0.6        # 相邻两趾之间留的缝 / gap kept between neighbouring toes
BLEND_MM = 22.0         # 趾蹼之后过渡到包里皮肤的距离 / distance behind the webs over which the surface passes into the package skin
NAIL_FACE_SET = 2       # 供体作者的雕刻面组里趾甲的编号 / the nails in the donor author's sculpt face sets


def axis_ends(B, u):
    """骨沿方向 u 的两端（轴上的点）和 90% 径向半径 / the two ends of a bone along direction u (points on the axis) and its 90% radial radius"""
    c = B.mean(0)
    t = (B - c) @ u
    r = np.linalg.norm((B - c) - np.outer(t, u), axis=1)
    return c + t.min() * u, c + t.max() * u, float(np.percentile(r, 90))


def capped(F, sel_vertices, n):
    """顶点集 sel 上的三角形，加上把它的各边界环用扇形封住的三角形（新顶点下标从 n 起；返回三角形和各环的顶点表）
    the triangles on the vertex set, plus fans closing each of its boundary loops (new vertex indices start at n; returns the triangles and the loops' vertex lists)"""
    m = np.zeros(n, bool)
    m[sel_vertices] = True
    f = F[m[F].all(1)]
    hm = half_edge_map(f)
    nxt = {}
    for (a, b) in hm:
        if (b, a) not in hm:
            nxt[b] = a  # 反向：封口面朝外 / reversed, so the cap faces outwards
    loops, seen = [], set()
    for s in sorted(nxt):
        if s in seen:
            continue
        lp, cur = [s], nxt[s]
        seen.add(s)
        while cur != s and cur not in seen:
            lp.append(cur)
            seen.add(cur)
            cur = nxt.get(cur, s)
        loops.append(lp)
    return f, loops


def step_toes(pk, deep, donor_file, out_dir, rim_tol_mm=1.0):
    import igl
    if not os.path.exists(donor_file):
        raise SystemExit('step toes needs %s (tools/skinopen/export-foot.py)' % donor_file)
    dn = np.load(donor_file)
    if 'faceSet' not in dn:
        raise SystemExit('step toes: %s has no faceSet array; export it again with tools/skinopen/export-foot.py' % donor_file)
    DV0, DF0, FS0 = dn['V'], dn['F'], dn['faceSet']
    parts = (deep or {}).get('parts', [])
    bones = [p for p in parts if p['group'] == 'toeBone']
    nail_parts = {p['side']: np.array(p['positions']).reshape(-1, 3) for p in parts if p['group'] == 'toeNail'}
    joints = (deep or {}).get('footJoints', {})
    if len(bones) < 20 or len(joints) < 12:
        raise SystemExit('step toes needs the toe bones and the ankle / mtp joints in deep-face.json (tools/skinopen/export-deep.ts)')
    # 供体的坐标架：这个资产是按坐标轴摆的——趾朝 −Y，向上是 +Z（Blender 的习惯）。不用主成分：供体带着一截小腿，
    # 主成分的长轴会朝踝关节翘起二三十度，整只前脚掌就对歪了。趾若不在 −Y 一端，下面找不到五个趾，会报错。
    # The donor's frame: the asset is axis-aligned, toes towards −Y and up +Z (Blender's convention). Principal axes are not used: the
    # donor includes a stub of the leg, which tilts the principal long axis up towards the ankle by twenty or thirty degrees and misplaces
    # the whole forefoot. If the toes were not at the −Y end, the search for five toes below would fail with an error.
    c = DV0.mean(0)
    fwd_d = np.array([0.0, -1.0, 0.0])
    up_d = np.array([0.0, 0.0, 1.0])
    along0 = (DV0 - c) @ fwd_d
    toes = donor_toes(DV0, DF0, along0, min_size=max(25, len(DV0) // 240))
    if len(toes) != 5:
        raise RuntimeError('toes: found %d separate toes on the donor, not 5' % len(toes))
    lat_axis = np.cross(fwd_d, up_d)
    toes.sort(key=lambda tv: float((DV0[tv[0]].mean(0) - c) @ lat_axis))
    if len(toes[-1][0]) > len(toes[0][0]):
        toes, lat_axis = toes[::-1], -lat_axis
    tips_d = np.array([DV0[tv[0]][np.argmax((DV0[tv[0]] - c) @ fwd_d)] for tv in toes])
    base_d = np.array([DV0[[v for v in tv[0] if (DV0[v] - c) @ fwd_d < tv[1] + 0.003]].mean(0) for tv in toes])
    frame_d = np.stack([fwd_d, up_d, np.cross(fwd_d, up_d)])
    donor_handed = float(np.sign(frame_d[2] @ lat_axis))
    toe_of = -np.ones(len(DV0), np.int64)
    for i, (tv, _) in enumerate(toes):
        toe_of[tv] = i
    web_level = np.array([lv for _, lv in toes])
    nail_v = np.zeros(len(DV0), bool)
    nail_v[np.unique(DF0[FS0 == NAIL_FACE_SET])] = True
    nd = len(DV0)
    # 供体每个趾的中心线（沿趾轴每 2 mm 一站的截面质心）和它的弧长：供体的趾是弯的，长度按弧长算
    # the centreline of each donor toe (centroids of sections every 2 mm along the toe axis) and its arc length: the donor's toes are curled, so lengths are arc lengths
    donor_axis, donor_cl = [], []
    for k, (tv, level) in enumerate(toes):
        a = tips_d[k] - base_d[k]
        a /= np.linalg.norm(a)
        X = DV0[tv]
        x = (tips_d[k] - X) @ a
        x_web = float(np.median(x[along0[tv] < level + 0.003]))
        xs = np.arange(0.0, x_web + 1e-9, 0.002)
        q = np.array([(X[np.abs(x - s) < 0.003] - tips_d[k] + s * a).mean(0) if (np.abs(x - s) < 0.003).any() else np.zeros(3) for s in xs])
        q[0] = 0
        for _ in range(3):
            q[1:-1] = 0.25 * q[:-2] + 0.5 * q[1:-1] + 0.25 * q[2:]
        pts = tips_d[k] - np.outer(xs, a) + q
        arc = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
        donor_axis.append(a)
        donor_cl.append((xs, q, arc, x_web))
    stats = {
        'donor': {'vertices': int(nd), 'triangles': int(len(DF0)), 'hasSkeleton': False,
                  'freeToeMm': {'what': 'tip to web of each donor toe (big … little): straight along the toe axis, and along the centreline', 'straight': [round(cl[3] / MM, 1) for cl in donor_cl], 'alongCentreline': [round(float(cl[2][-1]) / MM, 1) for cl in donor_cl]},
                  'nailVertices': int(nail_v.sum()), 'nailRule': 'sculpt face set %d of the asset' % NAIL_FACE_SET},
        'assumptions': {'softTissuePadBeyondTheDistalPhalanxMm': PAD_MM, 'leastCoverOverAPhalanxMm': COVER_MM, 'leastCoverAtBoneEndsMm': COVER_JOINT_MM, 'localPushTargetMm': PUSH_MM,
                        'webStationAlongTheProximalPhalanx': {'range': list(WEB_FRACTION), 'rule': 'the station (fraction of the proximal phalanx from its base) at which the donor toe, at the scale of the whole foot, needs no stretch; limited to this range. No published figure for the toes was opened: for the fingers hand-surgery texts put the web at about the midpoint of the proximal phalanx, which is the lower limit used here; the upper limit keeps the web proximal to the proximal interphalangeal joint.'},
                        'gapBetweenNeighbouringToesMm': TOE_GAP_MM, 'blendBehindTheWebsMm': BLEND_MM},
        'method': 'per toe: chain = end of distal phalanx + pad → interphalangeal joints → base of proximal phalanx, from the bones; donor toe (tip → web, by arc length of its centreline) mapped onto the chain from the tip to the web station; cross-section scaled per toe, pushed out locally where bone cover would be short, and held off the neighbouring toe at the bisecting plane; behind the webs the donor is drawn onto the package skin',
        'sides': {}}
    live = pk.groups['skin'].copy()
    accepted = True
    fitted = {}
    for side, word in (('L', 'left'), ('R', 'right')):
        def bone(kind, k):
            name = '%s phalanx of %s %s toe' % (kind, word, ORDINAL[k])
            m = [(np.array(p['positions']).reshape(-1, 3), np.array(p['indices']).reshape(-1, 3)) for p in bones if p['name'].lower() == name]
            return m[0] if m else None
        mtp = np.array([joints['mtp%d_%s' % (k + 1, side)] for k in range(5)])
        ankle = np.array(joints['ankle_' + side])
        segs = [[b for b in (bone('proximal', k), bone('middle', k), bone('distal', k)) if b is not None] for k in range(5)]
        if any(len(sg) < 2 for sg in segs):
            raise RuntimeError('toes: a phalanx of the %s foot is missing' % word)
        fwd_b = np.mean([sg[-1][0].mean(0) for sg in segs], axis=0) - mtp.mean(0)
        fwd_b /= np.linalg.norm(fwd_b)
        up_b = (ankle - mtp.mean(0)) - ((ankle - mtp.mean(0)) @ fwd_b) * fwd_b
        up_b /= np.linalg.norm(up_b)
        body_handed = float(np.sign(np.cross(fwd_b, up_b) @ (mtp[4] - mtp[0])))
        frame_b = np.stack([fwd_b, up_b, np.cross(fwd_b, up_b)])
        mirror = body_handed != donor_handed
        Fdm = frame_d.copy()
        if mirror:
            Fdm[2] = -Fdm[2]
        R = frame_b.T @ Fdm
        # 整只脚的相似变换：按趾尖之间的距离定比例（横向的尺度）/ the similarity of the whole foot: scale from the distances between the toe tips (the transverse scale)
        # 每个趾的骨链 / the bone chain of each toe
        chains, ends_all, bone_rows = [], [], []
        for k in range(5):
            cents = [mtp[k]] + [b[0].mean(0) for b in segs[k]]
            ends = []
            for a in range(len(segs[k])):
                u = (cents[min(a + 2, len(cents) - 1)] - cents[a]) if a + 2 < len(cents) else (cents[a + 1] - cents[a])
                u = u / np.linalg.norm(u)
                ends.append(axis_ends(segs[k][a][0], u))
            tip_dir = (ends[-1][1] - ends[-1][0]) / np.linalg.norm(ends[-1][1] - ends[-1][0])
            pts = [ends[-1][1] + PAD_MM * MM * tip_dir]
            for a in range(len(ends) - 1, 0, -1):
                pts.append((ends[a][0] + ends[a - 1][1]) / 2)
            pts.append(ends[0][0])
            chains.append(Chain(pts, up_b))
            ends_all.append(ends)
            # 相邻骨之间表面到表面的最小距离（关节间隙）/ least surface-to-surface distance between consecutive bones (the joint space)
            gaps = [float(cKDTree(segs[k][a - 1][0]).query(segs[k][a][0])[0].min()) for a in range(1, len(segs[k]))]
            bone_rows.append({'toe': ORDINAL[k], 'phalanxLengthMm': [round(float(np.linalg.norm(e[1] - e[0])) / MM, 1) for e in ends], 'radius90Mm': [round(e[2] / MM, 1) for e in ends], 'jointSpaceMm': [round(g / MM, 2) for g in gaps],
                              'elevationOfProximalPhalanxDeg': round(float(np.degrees(np.arcsin(np.clip(((ends[0][1] - ends[0][0]) / np.linalg.norm(ends[0][1] - ends[0][0]))[1], -1, 1)))), 1)})
        tgt_tip = np.array([ch.p[0] for ch in chains])
        scale = float(np.median([np.linalg.norm(tgt_tip[i] - tgt_tip[j]) / np.linalg.norm(tips_d[i] - tips_d[j]) for i in range(5) for j in range(i + 1, 5)]))
        tr = tgt_tip.mean(0) - scale * (tips_d.mean(0) @ R.T)
        G = scale * (DV0 @ R.T) + tr
        Fd_ = DF0[:, ::-1] if mirror else DF0
        # 蹼位和长度比例 / the web station and the length scale
        free, web_frac, len_scale, girth = [], [], [], []
        for k in range(5):
            ch = chains[k]
            l_prox = ch.l[-1] - ch.l[-2]
            want = scale * donor_cl[k][2][-1]            # 不拉伸时供体游离趾的长度 / length of the donor's free toe without stretch
            f = 1 - (want - ch.l[-2]) / l_prox           # 自近节趾骨基底起的比例 / fraction from the base of the proximal phalanx
            f = float(np.clip(f, *WEB_FRACTION))
            web_frac.append(f)
            free.append(ch.l[-2] + (1 - f) * l_prox)
            len_scale.append(free[-1] / want)
            # 粗细：趾骨半径 + 软组织 2.5 mm，对供体趾在趾中部的半径 / girth: phalanx radius + 2.5 mm of soft tissue, against the donor toe's radius at mid-toe
            xs, q, arc, x_web = donor_cl[k]
            X = DV0[toes[k][0]]
            x = (tips_d[k] - X) @ donor_axis[k]
            mid = (x > 0.35 * x_web) & (x < 0.8 * x_web)
            off = (X[mid] - tips_d[k]) + np.outer(x[mid], donor_axis[k]) - np.stack([np.interp(x[mid], xs, q[:, j]) for j in range(3)], 1)
            r_donor = scale * float(np.median(np.linalg.norm(off, axis=1)))
            r_bone = float(np.mean([e[2] for e in ends_all[k][1:]]))
            girth.append(float(np.clip((r_bone + 0.0025) / r_donor, 0.9, 1.5)))
        shift = 0.001

        def toe_map(k, X):
            """供体（已做整体相似变换）上的点 → 第 k 趾的骨链上 / points of the donor (after the global similarity) → onto the chain of toe k"""
            a = donor_axis[k] @ R.T
            eu = up_b - (up_b @ a) * a
            eu /= np.linalg.norm(eu)
            el = np.cross(-a, eu)
            tip = scale * (tips_d[k] @ R.T) + tr
            xs, q, arc, x_web = donor_cl[k]
            x = (tip - X) @ a
            xd = x / scale
            qg = scale * (np.stack([np.interp(xd, xs, q[:, j]) for j in range(3)], 1) @ R.T)
            off = (X - tip) + x[:, None] * a - qg
            s_d = np.where(xd <= x_web, np.interp(xd, xs, arc), arc[-1] + (xd - x_web)) * scale
            s_web = arc[-1] * scale
            # 趾蹼之前按长度比例；之后按 1:1 / stretched by the length scale up to the web, 1:1 behind it
            sarc = np.where(s_d <= s_web, s_d * (free[k] / s_web), free[k] + (s_d - s_web))
            C = chains[k].point(sarc)
            tt, uu, ll = chains[k].frame(sarc)
            return C + girth[k] * ((off @ eu)[:, None] * uu + (off @ el)[:, None] * ll) - shift * uu

        G0, _ = vertex_graph(nd, DF0, DV0)
        disp = np.zeros_like(G)
        wsum = np.zeros(len(G))
        owner_w = np.zeros((5, len(G)))
        rest = np.where(toe_of < 0)[0]
        for k, (tv, level) in enumerate(toes):
            Tk = toe_map(k, G)
            w = np.zeros(len(G))
            w[tv] = 1.0
            # 趾根之后的顶点按网格上离这个趾的距离跟随它（趾根的一圈权重为 1，免得趾与趾根之间被扯开）
            # vertices behind a toe follow it by their distance over the mesh from that toe (weight 1 at its base ring, so that toe and base are not torn apart)
            d = csgraph.dijkstra(G0, indices=np.array(tv), min_only=True)[rest] * scale
            w[rest] = np.exp(-(d / 0.030) ** 2)
            disp += w[:, None] * (Tk - G)
            wsum += w
            owner_w[k] = w
        P = G + disp / np.maximum(wsum, 1.0)[:, None]
        near_toe = owner_w.max(0) > 0.05
        owner = np.argmax(owner_w, axis=0)
        # 骨上覆盖不足处局部外推（只动趾和趾根附近的顶点）/ the local push where bone cover would be short (only toe vertices and those near the toe bases move)
        # 外推所针对的骨：这只脚的全部趾骨和跖骨 / the bones the push keeps cover over: every phalanx and metatarsal of this foot
        fb = [(np.array(p['positions']).reshape(-1, 3), np.array(p['indices']).reshape(-1, 3)) for p in bones if (' %s ' % word) in (' ' + p['name'].lower() + ' ')]
        offs = np.cumsum([0] + [len(b[0]) for b in fb])[:-1]
        BV = np.concatenate([b[0] for b in fb])
        BF = np.concatenate([b[1] + o for b, o in zip(fb, offs)])
        BVc, BFc = np.ascontiguousarray(BV), np.ascontiguousarray(BF)
        Ad, _ = vertex_graph(nd, Fd_)
        deg = np.maximum(np.asarray(Ad.sum(1)).ravel(), 1)
        mv = np.where(near_toe)[0]
        pushed = np.zeros(nd)

        def push(P):
            # 内外用绕数判断：骨的网格顶点没有焊接，伪法线的符号不可靠
            # inside / outside by winding number: the bone meshes are not welded, so the pseudo-normal sign is unreliable
            Q = np.ascontiguousarray(P[mv])
            d2, _, C = igl.point_mesh_squared_distance(Q, BVc, BFc)
            S = np.sqrt(d2) * np.where(np.abs(igl.winding_number(BVc, BFc, Q)) > 0.5, -1.0, 1.0)
            need = np.clip(PUSH_MM * MM - S, 0, None)
            dirn = (P[mv] - C) * np.sign(S)[:, None]
            nrm = np.linalg.norm(dirn, axis=1)
            ok = nrm > 1e-7
            dvec = np.zeros_like(dirn)
            dvec[ok] = dirn[ok] / nrm[ok][:, None] * need[ok][:, None]
            out = np.zeros_like(P)
            out[mv] = dvec
            return out

        toe_bone = []
        for k in range(5):
            o_ = np.cumsum([0] + [len(b_[0]) for b_ in segs[k]])[:-1]
            toe_bone.append((np.ascontiguousarray(np.concatenate([b_[0] for b_ in segs[k]])), np.ascontiguousarray(np.concatenate([b_[1] + oo for b_, oo in zip(segs[k], o_)]))))

        def separate(P, ramp):
            # 相邻两趾以“到两趾趾骨等距的面”为界，各自退到自己一侧（留 TOE_GAP_MM 的缝）：两趾骨之间的空隙因此对半分
            # neighbouring toes are parted at the surface equidistant from their two sets of phalanges, each held on its own side (leaving
            # TOE_GAP_MM between them): the space between the bones is thus shared equally
            for _ in range(4):
                for i in range(5):
                    vi = np.array(toes[i][0])
                    Q = np.ascontiguousarray(P[vi])
                    d2, _, C = igl.point_mesh_squared_distance(Q, *toe_bone[i])
                    di = np.sqrt(d2)
                    move = np.zeros(len(vi))
                    for j in (i - 1, i + 1):
                        if 0 <= j < 5:
                            dj = np.sqrt(igl.point_mesh_squared_distance(Q, *toe_bone[j])[0])
                            move = np.maximum(move, (di - dj + TOE_GAP_MM * MM) / 2)
                    move = np.minimum(move, np.maximum(di - 0.0003, 0)) * ramp[vi]
                    P[vi] += (C - Q) / np.maximum(di, 1e-9)[:, None] * move[:, None]
            return P

        # 趾蹼之后：供体表面拉到包里的皮肤上。按网格上离游离趾的距离过渡：3 mm 以内不动，BLEND_MM 以外完全贴合。
        # 位移场先在网格上平滑再施加（反复几次），免得最近点投影把面折起来。
        # behind the webs the donor surface is drawn onto the package skin, by distance over the mesh from the free toes: untouched within
        # 3 mm, fully on the skin beyond BLEND_MM. The displacement is smoothed over the mesh before it is applied (repeatedly), so that
        # the closest-point projection does not fold the surface.
        Vs, Fs = np.ascontiguousarray(pk.V), np.ascontiguousarray(pk.F[live])
        Gd, _ = vertex_graph(nd, Fd_, P)
        geo_toe = csgraph.dijkstra(Gd, indices=np.where(toe_of >= 0)[0], min_only=True)
        geo_rest = csgraph.dijkstra(Gd, indices=rest, min_only=True)
        x = np.clip((geo_toe - 0.003) / (BLEND_MM * MM - 0.003), 0, 1)
        phi = x * x * (3 - 2 * x)
        local = geo_toe < 0.11
        # S：整片都贴到皮肤上的版本（平滑地移过去）；最后 P = P0 + phi · (S − P0)
        # S: the version lying on the skin everywhere (moved there smoothly); in the end P = P0 + phi · (S − P0)
        # 供体的前脚掌怎样落到包里的皮肤上：不用最近点（供体的脚掌与这只脚宽窄不同，最近点投影会把外侧缘折到脚背或脚底上），
        # 而是在横截面里按方位角对应——供体顶点在自己的截面里相对截面中心的方位角 θ 和沿脚长轴的位置 z，
        # 对到这只脚在 z 处的截面中心沿 θ 方向射出、与皮肤相交的那一点。脚的截面对其中心是星形的，所以这个对应不会折叠。
        # How the donor forefoot lands on the package skin: not by closest points (the donor's ball differs in width from this foot, and the
        # closest-point projection folds the lateral border onto the dorsum or the sole) but by direction within the cross-section — a donor
        # vertex has an angle θ about the centre of its own cross-section and a station z along the foot; it goes to the point where the ray
        # from the centre of this foot's cross-section at z, in direction θ, meets the skin. A cross-section of the foot is star-shaped about
        # its centre, so the correspondence cannot fold.
        zc = (G - mtp.mean(0)) @ fwd_b
        # 只取这一侧的脚（身体中线的这一边）：两脚跟靠得近，不限制的话另一只脚会进到截面里 / this side's foot only (this side of the body's midline): the heels are close together, and the other foot would otherwise enter the cross-sections
        foot_v = np.where((pk.V[:, 0] * np.sign(mtp[:, 0].mean()) > 0.005) & (np.abs((pk.V - mtp.mean(0)) @ frame_b[2]) < 0.075) & (np.abs((pk.V - mtp.mean(0)) @ fwd_b) < 0.14) & (np.abs((pk.V - mtp.mean(0)) @ up_b) < 0.07))[0]
        fm = np.zeros(len(pk.V), bool)
        fm[foot_v] = True
        Ff = pk.F[live][fm[pk.F[live]].all(1)]
        sz = (pk.V[foot_v] - mtp.mean(0)) @ fwd_b
        stations = np.arange(-0.10, 0.06, 0.004)
        def section_centre(X, zz, z_):
            # 截面中心 = 这一片顶点在“上下、内外”两个方向上包围盒的中心（不用均值：顶点疏密不匀会把均值拉偏）
            # centre of a cross-section = centre of the bounding box of the slab's vertices in the up and lateral directions (not the mean, which uneven vertex density would bias)
            m = np.abs(zz - z_) < 0.006
            if m.sum() <= 8:
                return np.full(3, np.nan)
            q = (X[m] - mtp.mean(0)) @ frame_b.T
            return mtp.mean(0) + np.array([z_, (q[:, 1].min() + q[:, 1].max()) / 2, (q[:, 2].min() + q[:, 2].max()) / 2]) @ frame_b
        dsel = local & (toe_of < 0)
        # 这只脚的截面中心取自骨（这一片里趾骨、跖骨顶点的包围盒中心）：骨一定在皮内，射线从它出发先碰到的就是这只脚的皮肤
        # the centre of this foot's cross-section is taken from the bones (bounding-box centre of the phalanx and metatarsal vertices in the slab): bone is certainly inside the skin, so a ray from it meets this foot's skin first
        bz = (BV - mtp.mean(0)) @ fwd_b
        ctr_s = np.array([section_centre(BV, bz, z_) for z_ in stations])
        ctr_d = np.array([section_centre(G[dsel], zc[dsel], z_) for z_ in stations])
        ok_s, ok_d = ~np.isnan(ctr_s[:, 0]), ~np.isnan(ctr_d[:, 0])
        sel = local & (toe_of < 0) & (geo_toe >= 0.5 * BLEND_MM * MM)
        si = np.where(sel)[0]
        cs = np.stack([np.interp(zc[si], stations[ok_s], ctr_s[ok_s, j]) for j in range(3)], 1)
        cd = np.stack([np.interp(zc[si], stations[ok_d], ctr_d[ok_d, j]) for j in range(3)], 1)
        dirn = G[si] - cd
        dirn -= np.outer(dirn @ fwd_b, fwd_b)
        dirn /= np.maximum(np.linalg.norm(dirn, axis=1, keepdims=True), 1e-9)
        org = cs + np.outer(zc[si] - (cs - mtp.mean(0)) @ fwd_b, fwd_b)
        # 射线与三角形求交（Möller–Trumbore），取最近的交点（中心在皮内）/ ray–triangle intersection (Möller–Trumbore), the first hit (the centre is inside the skin)
        T0, E1, E2 = pk.V[Ff[:, 0]], pk.V[Ff[:, 1]] - pk.V[Ff[:, 0]], pk.V[Ff[:, 2]] - pk.V[Ff[:, 0]]
        hit = np.full(len(si), np.nan)
        for lo in range(0, len(si), 400):
            o_, d_ = org[lo:lo + 400, None, :], dirn[lo:lo + 400, None, :]
            pv_ = np.cross(d_, E2[None])
            det = np.einsum('ijk,jk->ij', pv_, E1)
            inv = 1.0 / np.where(np.abs(det) < 1e-14, np.nan, det)
            tv_ = o_ - T0[None]
            u_ = np.einsum('ijk,ijk->ij', tv_, pv_) * inv
            qv_ = np.cross(tv_, E1[None])
            v_ = np.einsum('ijk,ijk->ij', np.broadcast_to(d_, qv_.shape), qv_) * inv
            t_ = np.einsum('ijk,jk->ij', qv_, E2) * inv
            good = (u_ >= -1e-9) & (v_ >= -1e-9) & (u_ + v_ <= 1 + 1e-9) & (t_ > 0)
            t_ = np.where(good, t_, np.inf)
            best = t_.min(1)
            hit[lo:lo + 400] = np.where(np.isfinite(best), best, np.nan)
        S_ = P.copy()
        got = ~np.isnan(hit)
        S_[si[got]] = org[got] + hit[got, None] * dirn[got]
        # 没有交点的（极少）退回最近点 / the few without a hit fall back to the closest point
        if (~got).any():
            S_[si[~got]] = igl.point_mesh_squared_distance(np.ascontiguousarray(G[si[~got]]), Vs, Fs)[2]
        ray_missed = int((~got).sum())
        # 在皮肤上把对应关系理顺：反复“在网格上取邻点平均 → 落回皮肤的最近点”，消掉射线对应里个别跳开的点（被拉长的三角形）
        # the correspondence is relaxed on the skin: repeatedly "average over mesh neighbours → back to the closest point of the skin", which
        # removes the occasional jump of the ray correspondence (stretched triangles)
        inner = np.zeros(nd, bool)
        inner[si] = True
        inner &= (Ad @ inner.astype(float)) >= deg - 0.5   # 邻点都在 sel 里的才动 / only vertices all of whose neighbours are in sel move
        ii = np.where(inner)[0]
        for it in range(20):
            Qm = ((Ad @ S_) / deg[:, None])[ii]
            S_[ii] = igl.point_mesh_squared_distance(np.ascontiguousarray(0.5 * S_[ii] + 0.5 * Qm), Vs, Fs)[2]
        # 过渡带（趾根的一圈与 BLEND_MM 处贴在皮肤上的一圈之间）：解双调和方程得到一张光顺的面，两头都与邻面相切地接上
        # the transition (between the toe base rings and the ring lying on the skin at BLEND_MM): a fair surface from the biharmonic equation, joining both sides tangentially
        P = np.where((phi >= 1)[:, None], S_, P)
        free_c = np.where(local & (toe_of < 0) & (phi < 1))[0]
        lv = np.where(local)[0]
        E0, _ = unique_edges(Fd_[local[Fd_].all(1)], nd)
        w0 = 1.0 / np.maximum(np.linalg.norm(DV0[E0[:, 0]] - DV0[E0[:, 1]], axis=1), 1e-6)
        A0 = graph(nd, E0, w0)
        dg0 = np.maximum(np.asarray(A0.sum(1)).ravel(), 1e-12)
        L0 = sp.eye(nd) - sp.diags(1.0 / dg0) @ A0
        B0 = (L0 @ L0).tocsr()
        fixed_c = np.setdiff1d(lv, free_c)
        P[free_c] = spla.spsolve(B0[free_c][:, free_c].tocsc(), -(B0[free_c][:, fixed_c] @ P[fixed_c]))
        mv = np.where((phi < 1) & local)[0]
        ramp = np.clip(geo_rest / 0.004, 0, 1)
        band = (phi > 0) & (phi < 1)
        for it in range(5):
            dv = push(P)
            if it < 3:
                # 把外推量平滑开，免得出现尖 / the push is spread smoothly so that no spike appears
                for _ in range(2):
                    dv2 = (Ad @ dv) / deg[:, None]
                    dv = np.where((np.linalg.norm(dv2, axis=1) > np.linalg.norm(dv, axis=1))[:, None] & (phi < 1)[:, None] & local[:, None], dv2, dv)
            P = P + dv
            pushed += np.linalg.norm(dv, axis=1)
            P = separate(P, ramp)
            if it == 2:
                for _ in range(3):
                    Q = (Ad @ P) / deg[:, None]
                    P[band] = 0.5 * P[band] + 0.5 * Q[band]
        # 顶点都离骨够远之后，三角形的弦仍可能切近骨面：对覆盖仍不足的骨顶点，把它最近的那个三角形的三个顶点再向外推
        # with every vertex far enough from the bones a triangle's chord can still cut close: for bone vertices still short of cover, the three vertices of the nearest triangle are pushed out further
        Fl_ = np.ascontiguousarray(Fd_[(geo_toe < 0.09)[Fd_].all(1)])
        movable = (phi < 1) & local
        chord_total = np.zeros(nd)
        for it in range(10):
            Pc_ = np.ascontiguousarray(P)
            d2, fi, C = igl.point_mesh_squared_distance(BVc, Pc_, Fl_)
            dist = np.sqrt(d2)
            inside = np.abs(igl.winding_number(Pc_, Fl_, BVc)) > 0.5
            near_ = cKDTree(P[movable]).query(BV)[0] < 0.006
            short = near_ & inside & (dist < (COVER_MM + 0.6) * MM)
            if not short.any():
                break
            add = np.zeros(nd)
            dirs = np.zeros((nd, 3))
            for q in np.where(short)[0]:
                # 骨顶点在皮内：沿“骨 → 皮”方向再推；在皮外：把皮推到骨顶点之外
                # bone vertex inside the skin: push on along bone → skin; outside it: push the skin beyond the bone vertex
                sgn = 1.0 if inside[q] else -1.0
                n = sgn * (C[q] - BV[q]) / max(dist[q], 1e-9)
                need = min((COVER_MM + 0.9) * MM - sgn * dist[q], 0.004)
                for v in Fl_[fi[q]]:
                    if movable[v] and need > add[v] and chord_total[v] < 0.004:
                        add[v], dirs[v] = need, n
            P = P + dirs * add[:, None]
            pushed += add
            chord_total += add
        # 核对只用趾附近的那部分供体面（离游离趾 90 mm 以内）：更远处的供体面没有配准到这只脚上，也不会被接入
        # the checks use only the donor surface near the toes (within 90 mm of the free toes): beyond that the donor is not registered to this foot and is never grafted
        Pc, Fc = np.ascontiguousarray(P), np.ascontiguousarray(Fd_[(geo_toe < 0.09)[Fd_].all(1)])

        def cover_of(Q):
            """骨上各点到趾皮的有符号距离：在内为负 / signed distance of bone points from the toe skin: negative inside"""
            d = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(Q), Pc, Fc)[0])
            inside = np.abs(igl.winding_number(Pc, Fc, np.ascontiguousarray(Q))) > 0.5
            return np.where(inside, -d, d)
        # 调试：设了环境变量 SKINOPEN_DEBUG=<目录> 时，把这只脚配准的中间量写成 npz（平时不要设，输出不进包）
        # debugging: with the environment variable SKINOPEN_DEBUG=<directory> set, the intermediate quantities of this foot's fit are written
        # to an npz file (leave it unset normally; nothing of it goes into the package)
        if os.environ.get('SKINOPEN_DEBUG'):
            np.savez(os.path.join(os.environ['SKINOPEN_DEBUG'], 'toes-debug-%s.npz' % side), S=S_, G=G, si=si, org=org, hit=hit, ctr_s=ctr_s, ctr_d=ctr_d, stations=stations, footv=pk.V[foot_v], frame=frame_b, mtpc=mtp.mean(0), P=P, F=Fd_, geo=geo_toe, phi=phi, toe_of=toe_of, pushed=pushed, BV=BV, BF=BF, free=np.array(free), chains=np.array([np.r_[c_.p.ravel(), np.zeros(12)][:12] for c_ in chains]))
        # ── 验收 / acceptance ──
        fails, cover = [], {}
        for k in range(5):
            for bi, (bv, bf) in enumerate(segs[k]):
                kind = ['proximal', 'middle', 'distal'][bi] if len(segs[k]) == 3 else ['proximal', 'distal'][bi]
                e = ends_all[k][bi]
                u = (e[1] - e[0]) / np.linalg.norm(e[1] - e[0])
                tt = ((bv - e[0]) @ u) / np.linalg.norm(e[1] - e[0])
                sd = cover_of(bv)
                shaft = (tt > 0.15) & (tt < 0.85)
                row = {'shaftMm': round(float(-sd[shaft].max()) / MM, 2), 'endsMm': round(float(-sd[~shaft].max()) / MM, 2)}
                if bi == 0:
                    # 近节趾骨在蹼位之后的部分由包里的皮肤覆盖，本工具不能改它；分开报告
                    # the part of the proximal phalanx behind the web station is covered by the package skin, which this tool may not change; reported separately
                    fr = tt > web_frac[k]
                    row = {'inTheFreeToeMm': round(float(-sd[fr].max()) / MM, 2) if fr.any() else None, 'behindTheWebUnderPackageSkinMm': round(float(-sd[~fr].max()) / MM, 2), 'endsMm': row['endsMm']}
                    worst_shaft = -sd[fr & shaft].max() if (fr & shaft).any() else np.inf
                    worst_end = -sd[fr & ~shaft].max() if (fr & ~shaft).any() else np.inf
                else:
                    worst_shaft, worst_end = -sd[shaft].max(), -sd[~shaft].max()
                cover['%s %s' % (ORDINAL[k], kind)] = row
                if worst_shaft < COVER_MM * MM - 1e-5:
                    fails.append('%s phalanx of the %s %s toe: least cover over the shaft %.2f mm (needs %.1f)' % (kind, word, ORDINAL[k], worst_shaft / MM, COVER_MM))
                if worst_end < COVER_JOINT_MM * MM - 1e-5:
                    fails.append('%s phalanx of the %s %s toe: least cover at the bone ends %.2f mm (needs %.1f)' % (kind, word, ORDINAL[k], worst_end / MM, COVER_JOINT_MM))
        # 相邻趾互不穿入：把每个趾在趾根处封口后算绕数（没有封口的网格绕数不是 0 / 1，以前的检查因此误报）
        # neighbouring toes do not interpenetrate: winding numbers of each toe closed at its base (an open mesh has winding numbers other than 0 / 1, which made the earlier test report false overlaps)
        overlap = {}
        closed = []
        for k in range(5):
            f, loops = capped(Fd_, toes[k][0], nd)
            extra_v, extra_f = [], []
            for lp in loops:
                cidx = nd + len(extra_v)
                extra_v.append(P[lp].mean(0))
                extra_f += [[lp[j], lp[(j + 1) % len(lp)], cidx] for j in range(len(lp))]
            Vk = np.vstack([P] + ([np.array(extra_v)] if extra_v else []))
            Fk = np.vstack([f] + ([np.array(extra_f)] if extra_f else []))
            vol = float(np.einsum('ij,ij->i', Vk[Fk[:, 0]], np.cross(Vk[Fk[:, 1]], Vk[Fk[:, 2]])).sum() / 6)
            closed.append((np.ascontiguousarray(Vk), np.ascontiguousarray(Fk), vol))
        for i in range(4):
            cnt = 0
            for a, b in ((i, i + 1), (i + 1, i)):
                wn = igl.winding_number(closed[a][0], closed[a][1], np.ascontiguousarray(P[toes[b][0]]))
                cnt += int((np.abs(wn) > 0.5).sum())
            dmin = float(cKDTree(P[toes[i][0]]).query(P[toes[i + 1][0]])[0].min())
            overlap['%s / %s' % (ORDINAL[i], ORDINAL[i + 1])] = {'verticesOfOneInsideTheOther': cnt, 'closestVerticesMm': round(dmin / MM, 2)}
            if cnt:
                fails.append('%s and %s toe of the %s foot interpenetrate (%d vertices of one inside the other)' % (ORDINAL[i], ORDINAL[i + 1], word, cnt))
        # 趾甲在远节趾骨的背侧 / the nail lies on the dorsum of the distal phalanx
        nails = {}
        for k in range(5):
            nv_ = np.array([v for v in toes[k][0] if nail_v[v]])
            if not len(nv_):
                fails.append('no nail vertices on the %s %s toe' % (word, ORDINAL[k]))
                continue
            s_, _ = chains[k].project(P[nv_])
            tt, uu, ll = chains[k].frame(s_)
            dors = np.einsum('ij,ij->i', P[nv_] - chains[k].point(s_), uu)
            dist_b = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(P[nv_]), np.ascontiguousarray(segs[k][-1][0]), np.ascontiguousarray(segs[k][-1][1]))[0])
            l_dist = chains[k].l[1]
            # 背侧：高于骨链的轴，或不低于它 1 mm（甲的游离缘在趾端，与轴同高）/ dorsal: above the axis of the chain, or no more than 1 mm below it (the free edge of the nail, at the tip, is level with the axis)
            on = (s_ <= l_dist + 0.001) & (dors > -0.001)
            nails[ORDINAL[k]] = {'vertices': int(len(nv_)), 'shareOverTheDistalPhalanxAndDorsal': round(float(on.mean()), 3), 'heightAboveTheAxisMm': [round(float(dors.min()) / MM, 1), round(float(np.median(dors)) / MM, 1), round(float(dors.max()) / MM, 1)], 'stationFromTipMm': [round(float(s_.min()) / MM, 1), round(float(s_.max()) / MM, 1)], 'distalPhalanxWithPadMm': round(float(l_dist) / MM, 1),
                                 'heightAboveTheDistalPhalanxMm': {'median': round(float(np.median(dist_b)) / MM, 2), 'min': round(float(dist_b.min()) / MM, 2), 'max': round(float(dist_b.max()) / MM, 2)}}
            if on.mean() < 0.9:
                fails.append('nail of the %s %s toe: only %.0f %% of its vertices lie dorsal to the distal phalanx' % (word, ORDINAL[k], 100 * on.mean()))
        plate = None
        if side in nail_parts or word in nail_parts:
            npv = nail_parts.get(side, nail_parts.get(word))
            dist_p = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(npv), np.ascontiguousarray(np.concatenate([sg[-1][0] for sg in segs])), np.ascontiguousarray(np.concatenate([sg[-1][1] + o for sg, o in zip(segs, np.cumsum([0] + [len(sg[-1][0]) for sg in segs])[:-1])])))[0])
            sdn = cover_of(npv)
            plate = {'what': 'the nail plate parts of the anatomy data (not a criterion: they were placed for an older skin)', 'distanceFromTheDistalPhalangesMm': {'median': round(float(np.median(dist_p)) / MM, 1), 'p5': round(float(np.percentile(dist_p, 5)) / MM, 1), 'p95': round(float(np.percentile(dist_p, 95)) / MM, 1)},
                     'signedDistanceFromTheFittedToeSkinMm': {'median': round(float(np.median(sdn)) / MM, 1), 'p5': round(float(np.percentile(sdn, 5)) / MM, 1), 'p95': round(float(np.percentile(sdn, 95)) / MM, 1), 'sign': 'positive = outside the toe'}}
        mvt = np.array([v for tv, _ in toes for v in tv])
        srow = {'mirrored': bool(mirror), 'scaleOfTheWholeFoot': round(scale, 4), 'webStationFractionPerToe': [round(f, 3) for f in web_frac], 'freeToeLengthMm': [round(f / MM, 1) for f in free],
                'lengthScalePerToe': [round(v, 3) for v in len_scale], 'girthScalePerToe': [round(g, 3) for g in girth],
                'localPushMm': {'what': 'how far toe vertices were pushed out to keep the cover over the bones', 'verticesPushed': int((pushed[mvt] > 1e-5).sum()), 'ofToeVertices': int(len(mvt)), 'median': round(float(np.median(pushed[mvt][pushed[mvt] > 1e-5])) / MM, 2) if (pushed[mvt] > 1e-5).any() else 0.0, 'max': round(float(pushed[mvt].max()) / MM, 2)},
                'forefootOntoSkin': {'rule': 'by direction within the cross-section (ray from the centre of the cross-section)', 'vertices': int(len(si)), 'raysWithoutAHit': ray_missed}, 'bones': bone_rows, 'boneCover': cover, 'neighbours': overlap, 'nails': nails, 'nailPlateParts': plate, 'failures': fails}
        stats['sides'][side] = srow
        accepted &= not fails
        # 皮肤上要换掉的区域：最近的供体点落在“还没有完全贴到皮肤上”的供体面上的皮肤顶点（趾前的整块连指套，和过渡带下面的皮肤）
        # the region of the skin to replace: skin vertices whose closest donor point lies on donor surface not yet fully on the skin (the whole mitten ahead of the toes, and the skin under the transition)
        nearf = np.where(np.linalg.norm(pk.V - mtp.mean(0), axis=1) < 0.12)[0]
        _, fi_, cp_ = igl.point_mesh_squared_distance(np.ascontiguousarray(pk.V[nearf]), Pc, Fc)
        region = np.zeros(len(pk.V), bool)
        region[nearf] = phi[Fc[fi_]].min(1) < 0.98
        fitted[side] = (P, Fd_, np.concatenate([sg[-1][0] for sg in segs]), mtp, (phi < 0.98) & local, region)
    stats['accepted'] = bool(accepted)
    os.makedirs(out_dir, exist_ok=True)
    nail_f = FS0 == NAIL_FACE_SET
    for side, (P, Fd_, _, mtp, _inc, _reg) in fitted.items():
        keep = np.linalg.norm(P - mtp.mean(0), axis=1) < 0.075
        fsel = keep[Fd_].all(1)
        usedv = np.unique(Fd_[fsel])
        loc = -np.ones(len(P), np.int64)
        loc[usedv] = np.arange(len(usedv))
        write_obj(os.path.join(out_dir, 'toes-fit-%s.obj' % side), P[usedv], [('toesFit' + side, loc[Fd_[fsel & ~nail_f]]), ('toesFitNail' + side, loc[Fd_[fsel & nail_f]])],
                  ['# forefoot of "Foot - Realistic" (Blender Studio Human Base Meshes v1.4.1, CC0) fitted to the toe bones of this body by tools/skinopen/toes.py, before grafting; metres, body frame'])
    if not accepted:
        stats['grafted'] = False
        stats['notGraftedBecause'] = '; '.join(f for v in stats['sides'].values() for f in v['failures'])
        pk.pending.append({'name': 'toes', 'status': 'fitted, not grafted', 'files': ['toes-fit-L.obj', 'toes-fit-R.obj'], 'reason': stats['notGraftedBecause'], 'provenance': 'curated', 'source': HBM_SOURCE})
        pk.report['toes'] = stats
        return
    stats['grafted'] = True
    stats['graft'] = {}
    # 接入可能还要撤回（接入后的核对不通过时）：先记下包的状态 / the graft may have to be undone (when the check after grafting fails): keep the state of the package
    saved = {k: copy.deepcopy(getattr(pk, k)) for k in ('V', 'F', 'W', 'fields', 'tags', 'src', 'groups', 'grafts', 'collapsed')}
    for side, (P, Fd_, seeds, mtp, include, region) in fitted.items():
        ball = pk.joint('mtp2_' + side)
        if ball is None:
            raise RuntimeError('toes: joints.json maps no joint to mtp2_%s (MHR ball joint)' % side)
        info, gstats, ids, geo = graft(pk, P, Fd_, seeds, 'toes' + side, differ_mm=0.8, reach_mm=75.0, grow_rings=1, blend_mm=6.0, rigid_joint=ball, rigid_from_mm=5.0, rigid_full_mm=15.0, tag_patch='graftCurated', donor_include=include, skin_region=region)
        if gstats['rimMismatchMm']['median'] > rim_tol_mm:
            raise RuntimeError('toes: the rim of the %s forefoot lies a median %.2f mm from the package skin (tolerance %.1f)' % (side, gstats['rimMismatchMm']['median'], rim_tol_mm))
        pv = info.pop('_donorIndex')
        gid = -np.ones(nd, np.int64)
        gid[pv] = ids
        jn = pk.joints['names'][ball]
        info.update({
            'provenance': 'curated', 'source': HBM_SOURCE,
            'what': {'zh': '分开的脚趾、趾蹼和趾甲：供体是 CC0 的基础网格（不是这个人的脚，也没有骨骼）。每个趾按本体的趾骨链定位：供体趾尖对到远节趾骨末端加 %.0f mm 软组织垫，供体趾蹼对到近节趾骨上的蹼位；截面按趾缩放，并在骨上覆盖不足处局部外推。趾蹼之后的面贴在包里原来的皮肤上。全部顶点都被这样变形过（标签 graftCurated）；靠边一圈为过渡环（graftBlend，构造物）。' % PAD_MM,
                     'en': 'Separate toes, web spaces and nails: the donor is a CC0 base mesh (not this person\'s foot, and without a skeleton). Each toe is placed by this body\'s chain of toe bones: the donor tip on the end of the distal phalanx plus a %.0f mm soft-tissue pad, the donor web on the web station of the proximal phalanx; the cross-section is scaled per toe and pushed out locally where bone cover would be short. Behind the webs the surface lies on the package skin. Every vertex was deformed in this way (tag graftCurated); the band at the rim is the blend ring (graftBlend, construction).' % PAD_MM},
            'weights': {'zh': '权重从洞口环调和延拓；离洞口 5–15 mm 过渡到完全跟随 MHR 的 %s（前足“球”关节，对应 mtp2）。包里没有趾间关节，也只有这一个趾关节：五个趾在包里都跟这一个关节；绑定时由 data/curated/rig 的规则把 %s 的权重按“最近的 mtp1–5”分给各趾。toeVertices 给出每个趾的顶点，可直接用来分。' % (jn, jn),
                        'en': 'Weights are a harmonic extension from the rim of the hole, turning between 5 and 15 mm from the rim into MHR\'s %s alone (the ball-of-foot joint, mapped to mtp2). The package has no toe interphalangeal joints and only this one toe joint: in the package all five toes follow it; at rig time the rule in data/curated/rig hands the weight of %s to the nearest of mtp1–5. toeVertices lists the vertices of each toe and can be used for that directly.' % (jn, jn)},
            'toeVertices': {ORDINAL[k]: [int(v) for v in gid[toes[k][0]] if v >= 0] for k in range(5)},
            'nailVertices': {ORDINAL[k]: [int(gid[v]) for v in toes[k][0] if nail_v[v] and gid[v] >= 0] for k in range(5)},
            'nailNote': {'zh': 'nailVertices 是供体作者划为趾甲的面上的顶点：趾甲是皮肤网格上雕出来的形状，不是单独的甲板部件。', 'en': 'nailVertices are the vertices of the faces the donor\'s author set apart as nails: the nails are shapes sculpted into the skin mesh, not separate nail plate parts.'},
        })
        pk.grafts.append(info)
        stats['graft'][side] = gstats
        missing = [ORDINAL[k] for k in range(5) if (gid[toes[k][0]] < 0).any()]
        if missing:
            raise RuntimeError('toes: the grafted patch of the %s foot does not contain all vertices of these toes: %s' % (side, ', '.join(missing)))
    # 接入之后再核对一次：所有趾骨对最终的闭合皮肤 / checked again after grafting: every phalanx against the final closed skin
    livef = np.zeros(len(pk.F), bool)
    for g_ in pk.groups.values():
        livef |= g_
    Vn, Fn = np.ascontiguousarray(pk.V), np.ascontiguousarray(pk.F[livef])
    final = {}
    for p in bones:
        if 'phalanx' not in p['name'].lower():
            continue
        sd = igl.signed_distance(np.ascontiguousarray(np.array(p['positions']).reshape(-1, 3)), Vn, Fn)[0]
        final['%s (%s)' % (p['name'], p['id'])] = round(float(-sd.max()) / MM, 2)
    stats['leastCoverOfEveryPhalanxInTheGraftedSkinMm'] = final
    stats['leastOfAllMm'] = min(final.values())
    if stats['leastOfAllMm'] < COVER_JOINT_MM - 1e-6:
        # 撤回：趾骨在接入后的皮肤上覆盖不足 / undone: a phalanx is not covered enough by the grafted skin
        # 调试：设了 SKINOPEN_DEBUG 时，把被撤回的那张皮肤另存一份 / debugging: with SKINOPEN_DEBUG set, the skin that is being undone is saved as well
        if os.environ.get('SKINOPEN_DEBUG'):
            write_obj(os.path.join(os.environ['SKINOPEN_DEBUG'], 'toes-failed-graft.obj'), pk.V, [(g_, pk.F[m_]) for g_, m_ in pk.groups.items() if m_.any()], [])
        for k, v in saved.items():
            setattr(pk, k, v)
        stats['grafted'] = False
        stats['accepted'] = False
        stats['notGraftedBecause'] = 'after grafting, the least cover over a phalanx was %.2f mm (needs %.1f): %s' % (stats['leastOfAllMm'], COVER_JOINT_MM, min(final, key=final.get))
        pk.pending.append({'name': 'toes', 'status': 'fitted, not grafted', 'files': ['toes-fit-L.obj', 'toes-fit-R.obj'], 'reason': stats['notGraftedBecause'], 'provenance': 'curated', 'source': HBM_SOURCE})
    if stats['grafted']:
        # 检查图：每只脚从上、下、内侧、外侧各一张，外加趾蹼的近景；上排按分组着色并画出趾骨，下排单一肤色
        # check renders: each foot from above, below, medial, lateral, plus a close-up of the webs; upper row coloured by group with the phalanges drawn, lower row in one skin colour
        bone_items = [{'positions': p['positions'], 'indices': p['indices'], 'color': [250, 240, 150]} for p in bones]
        for side, (P, Fd_, _, mtp, _inc, _reg) in fitted.items():
            sg = 1 if side == 'L' else -1
            g = 'toes' + side
            items = [{'obj': 'skin.obj', 'color': [226, 178, 156], 'notGroups': [g, g + 'Stitch']}, {'obj': 'skin.obj', 'color': [205, 150, 132], 'groups': [g]}, {'obj': 'skin.obj', 'color': [120, 160, 220], 'groups': [g + 'Stitch']},
                     {'obj': 'skin.obj', 'color': [226, 178, 156]}, {'obj': 'skin-delivered.obj', 'color': [226, 178, 156]}] + bone_items
            c = [round(float(v), 4) for v in (mtp.mean(0) + np.array([0, -0.004, 0.032]))]
            cw = [round(float(v), 4) for v in (mtp[1:4].mean(0) + np.array([0, 0.0, 0.03]))]
            cams = [(0, 89, c, 0.062, None), (0, -89, c, 0.062, None), (-90 * sg, 8, c, 0.062, None), (90 * sg, 8, c, 0.062, None), (0, 40, cw, 0.03, None), (0, 89, c, 0.062, [-0.011, 0.0])]
            views = []
            for row in ([0, 1, 2], [3], [4]):
                for yaw, pitch, cc, hh, slab in cams:
                    v = {'yaw': yaw, 'pitch': pitch, 'center': cc, 'halfHeight': hh, 'width': 440, 'height': 440, 'items': list(row)}
                    if slab is not None:
                        v['slab'] = slab
                        v['items'] = list(row) + list(range(5, 5 + len(bone_items)))
                    views.append(v)
            pk.render_specs[g] = {'out': 'renders/%s.png' % g, 'columns': len(cams), 'items': items, 'views': views,
                                  'note': 'rows: grafted coloured by group (patch darker, stitch blue) / grafted in one colour / delivered skin; columns: above, below, medial, lateral, web close-up, horizontal slab through the toes with the bones'}
    pk.report['toes'] = stats
