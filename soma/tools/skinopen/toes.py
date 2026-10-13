# 足趾：把供体脚（Blender Studio Human Base Meshes 的 “Foot - Realistic”，CC0）的五个游离趾接到皮肤包的皮肤上。
# 由 graft.py 的 toes 步骤调用。
# The toes: grafts the five free toes of the donor foot ("Foot - Realistic" of Blender Studio's Human Base Meshes,
# CC0) into the skin of a skin package. Called by the toes step of graft.py.
#
# 概念（INTEGRATION.txt 第 10 节）；做法以第 12 节为准 / the concept (section 10 of INTEGRATION.txt); the method is that of section 12
#   · 游离趾从趾蹼开始，不从跖趾关节开始。供体的趾蹼 → 本体近节趾骨上的一个位置（蹼位，按近节趾骨长度的比例），
#     供体的趾尖 → 本体远节趾骨末端加软组织垫。趾蹼之后是包里皮肤的前脚掌。
#     A free toe begins at the web, not at the metatarsophalangeal joint. The donor's web goes to a station on this
#     body's proximal phalanx (a fraction of its length), the donor's tip to the end of the distal phalanx plus a
#     soft-tissue pad. Behind the webs the surface is the package skin's ball of the foot.
#   · 骨说了算：趾的轴线和长度取自趾骨。甲板部件不作依据（它们是按旧皮肤摆的）。
#     The bones are the authority for the axis and length of a toe. The nail plate parts are not (they were placed
#     for an older skin).
#   · 长度分段：远段（趾尖到甲根后 1.5 mm：趾腹和甲）按该趾的粗细比例等比缩放，拉伸全部落在趾干上，趾蹼两侧各 3 mm 内缓到 1。
#     Length by segment: the distal part (tip to 1.5 mm behind the nail root: pad and nail) is scaled isotropically by the
#     girth scale of the toe, all stretch goes to the shaft, and over 3 mm either side of the web the rate eases to 1.
#   · 粗细：供体的截面按每趾一个比例缩放。骨上覆盖不足处向外推，推的量是网格上一个取平滑上包络的标量场（不逐顶点推）；
#     趾尖帽（远段的全部顶点）作为刚体跟着走，最后每片甲放回供体甲的相似变换上，所以甲上的顶点彼此不动。
#     Girth: the donor's cross-section is scaled by one factor per toe. Where bone cover would be short the surface is
#     pushed out by a scalar field taken as a smooth upper envelope over the mesh (not vertex by vertex); the tip cap
#     (every vertex of the distal part) follows as a rigid body, and at the end each nail is put back onto a similarity
#     transform of the donor nail, so nail vertices never move relative to each other.
#   · 已知的缺点（第 12、13 节）：第 2–5 趾上刚性的趾尖帽与趾干相接处有一圈不到 0.8 mm 的浅台阶，验收查不出来。
#     A known fault (sections 12 and 13): on toes 2–5 a shallow ring step of under 0.8 mm where the rigid tip cap meets
#     the shaft; the acceptance does not catch it.

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
COVER_SADDLE_MM = 0.5   # 接入后每节趾骨（含趾蹼之后、鞍部旁的骨端）至少的覆盖：相邻近节趾骨相距只有 2.5–4 mm，鞍部两边不可能各有 1 mm 以上 / least cover of every phalanx after grafting (including the bone ends beside the saddles behind the webs): neighbouring proximal phalanges are only 2.5–4 mm apart, so a saddle cannot have much more than 1 mm on either side
PUSH_MM = 2.6           # 局部外推的目标覆盖（留出网格弦高的余量）/ target of the local push (leaves room for the chord error of the mesh)
WEB_FRACTION = (0.50, 0.85)  # 蹼位在近节趾骨上的范围（自基底起的比例）/ range of the web station along the proximal phalanx (fraction from its base)
TOE_GAP_MM = 0.6        # 相邻两趾之间留的缝 / gap kept between neighbouring toes
SEP_FLOOR_MM = 0.4      # 分开邻趾时，自己骨上的覆盖不得低于 COVER_MM 加这么多 / when parting toes, the cover over a toe's own bone may not fall below COVER_MM plus this
WEB_GAP_MM = 2.6        # 趾根处趾缝的宽度 / width of the cleft between two toes at their bases
WEB_GAP_OVER_MM = 6.0   # 趾缝从趾根处的宽度收到 TOE_GAP_MM 的距离 / distance over which the cleft narrows from its width at the base to TOE_GAP_MM
LAST_RESORT_ROUNDS = 8  # 保底（直接顶出 + 只松弛折边）最多几轮 / most rounds of the last resort (straight push + relaxing folded edges only)
LAST_RESORT_FOLDS = 4   # 保底顶出的顶点上容许的折边数（每只脚）/ folded edges allowed at vertices pushed as a last resort (per foot)
FINISH_ROUNDS = 16       # 收尾（局部顶起、退出邻趾）最多几轮 / most rounds of finishing (local tenting, retreat out of the neighbour)
TENT_PASSES = 24        # 收尾时顶起量的包络平滑次数 / envelope passes of the tenting in the finishing
RIM_GAP_MM = 1.5        # 供体片的边缘离洞口环至少这么远（缝合带的宽度）/ the rim of the donor patch stays at least this far inside the rim of the hole (the width of the stitch band)
BLEND_MM = 22.0         # 趾蹼之后过渡到包里皮肤的距离 / distance behind the webs over which the surface passes into the package skin
NAIL_MARGIN_MM = 1.5    # 甲根之后仍算远段的长度 / length behind the nail root still counted as the distal part
AXIS_SMOOTH_MM = 6.0    # 骨链的轴线和坐标架取平均的半宽 / half-width over which the axis and frame of the bone chain are averaged
BASE_FREE_MM = 3.0      # 趾根处并入过渡面一起求解的宽度 / width at the toe base solved together with the transition surface
WEB_EASE_MM = 3.0       # 趾蹼前后各这么长的一段里，长度比例缓变到 1 / the length rate eases to 1 over this much either side of the web
STRETCH_EASE_MM = 4.0   # 远段与趾干的长度比例之间的过渡长度 / length over which the length rate eases from the distal part to the shaft
TIP_DEFICIT_WEIGHT = 9.0  # 趾尖帽的刚体拟合里，覆盖不足的顶点多出的权重 / extra weight of vertices short of cover in the rigid fit of a tip cap
NAIL_RING_MM = 4.0      # 趾甲周围跟随甲的刚性修正的宽度 / width round a nail over which its rigid correction is followed
ENVELOPE_PASSES = 30    # 外推量取平滑上包络时的平滑次数（约 5 圈顶点）/ smoothing passes of the upper envelope of the push (about five rings of vertices)
DIRECTION_PASSES = 8    # 外推方向场的低通次数 / low-pass passes over the direction field of the push
COVER_ROUNDS = 0        # 最后只外推、不松弛的轮数 / last rounds of push without relaxation
FINAL_ROUNDS = 10       # 之后只外推和松弛的轮数 / rounds of push and relaxation alone that follow
PUSH_ITERATIONS = 10    # “外推 + 分开”的轮数（之后再做几轮只外推的）/ rounds of push and parting (followed by a few of push alone)
FOLD_DEG = 120          # 供体片上不允许有折过这个角度的边 / no edge of the donor patch may be folded over this angle
FRAGMENT_MM = 1.0       # 细节层偏离供体超过这么多的一小块算碎片 / a small group whose detail layer is this far off the donor's counts as a fragment
SEAM_STEP_MM = 0.5      # 缝合处允许的台阶 / step allowed at the seam
UNFOLD_DEG = 108         # 配准过程中折过这个角度的边就地松弛 / during the fit, edges folded over this angle are relaxed where they are
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


def fold_angles(P, F):
    """每条内部边两侧面法线的夹角（度）：0 = 平，180 = 完全折回。返回边（n × 2）和角
    the angle between the normals of the two faces at every interior edge (degrees): 0 = flat, 180 = folded right back. Returns the edges (n × 2) and the angles"""
    n = np.cross(P[F[:, 1]] - P[F[:, 0]], P[F[:, 2]] - P[F[:, 0]])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-18)
    he = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    fid = np.tile(np.arange(len(F)), 3)
    big = int(he.max()) + 1
    key, rkey = he[:, 0] * big + he[:, 1], he[:, 1] * big + he[:, 0]
    order = np.argsort(key, kind='stable')
    pos = np.minimum(np.searchsorted(key[order], rkey), len(key) - 1)
    m = (key[order][pos] == rkey) & (he[:, 0] < he[:, 1])
    ang = np.degrees(np.arccos(np.clip(np.einsum('ij,ij->i', n[fid[m]], n[fid[order[pos[m]]]]), -1, 1)))
    return he[m], ang


def detail_height(P, F, Ad, deg, passes=10):
    """“细节层”的高度：顶点高出自己低通后的曲面多少（沿低通后的法线）/ height of the "detail layer": how far a vertex stands above its own low-passed surface (along the low-passed normal)"""
    Q = P.copy()
    for _ in range(passes):
        Q = 0.5 * Q + 0.5 * (Ad @ Q) / deg[:, None]
    fn = np.cross(Q[F[:, 1]] - Q[F[:, 0]], Q[F[:, 2]] - Q[F[:, 0]])
    vn = np.zeros_like(P)
    for c in range(3):
        np.add.at(vn, F[:, c], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-18)
    return np.einsum('ij,ij->i', P - Q, vn)


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
    donor_axis, donor_cl, nail_end_x = [], [], []
    for k, (tv, level) in enumerate(toes):
        a = tips_d[k] - base_d[k]
        a /= np.linalg.norm(a)
        X = DV0[tv]
        x = (tips_d[k] - X) @ a
        x_web = float(np.median(x[along0[tv] < level + 0.003]))
        # 最后一站正好在趾蹼处。以前各站每 2 mm 一个、到不了趾蹼：最后一站与趾蹼之间（至多 2 mm）的一片顶点被映到同一个弧长上，
        # 趾根因此被压出一圈折痕（第 12 节）。
        # The last station is exactly at the web. Before, the stations came every 2 mm and stopped short of it, so the slab of vertices
        # between the last station and the web (up to 2 mm) was mapped to one and the same arc length, which pressed a ring of creases
        # into the toe base (section 12).
        xs = np.r_[np.arange(0.0, x_web - 0.0005, 0.002), x_web]
        q = np.array([(X[np.abs(x - s) < 0.003] - tips_d[k] + s * a).mean(0) if (np.abs(x - s) < 0.003).any() else np.zeros(3) for s in xs])
        q[0] = 0
        for _ in range(3):
            q[1:-1] = 0.25 * q[:-2] + 0.5 * q[1:-1] + 0.25 * q[2:]
        pts = tips_d[k] - np.outer(xs, a) + q
        arc = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
        # 趾甲在趾轴上伸到多远（自趾尖起）/ how far the nail reaches along the toe axis (from the tip)
        nx = x[nail_v[tv]]
        if not len(nx):
            raise RuntimeError('toes: no nail faces (sculpt face set %d) on donor toe %d' % (NAIL_FACE_SET, k))
        nail_end_x.append(float(nx.max()))
        donor_axis.append(a)
        donor_cl.append((xs, q, arc, x_web))
    stats = {
        'donor': {'vertices': int(nd), 'triangles': int(len(DF0)), 'hasSkeleton': False,
                  'freeToeMm': {'what': 'tip to web of each donor toe (big … little): straight along the toe axis, and along the centreline', 'straight': [round(cl[3] / MM, 1) for cl in donor_cl], 'alongCentreline': [round(float(cl[2][-1]) / MM, 1) for cl in donor_cl]},
                  'nailVertices': int(nail_v.sum()), 'nailRule': 'sculpt face set %d of the asset' % NAIL_FACE_SET},
        'assumptions': {'softTissuePadBeyondTheDistalPhalanxMm': PAD_MM, 'leastCoverOverAPhalanxMm': COVER_MM, 'leastCoverAtBoneEndsMm': COVER_JOINT_MM, 'localPushTargetMm': PUSH_MM,
                        'webStationAlongTheProximalPhalanx': {'range': list(WEB_FRACTION), 'rule': 'the station (fraction of the proximal phalanx from its base) at which the donor toe, at the scale of the whole foot, needs no stretch; limited to this range. No published figure for the toes was opened: for the fingers hand-surgery texts put the web at about the midpoint of the proximal phalanx, which is the lower limit used here; the upper limit keeps the web proximal to the proximal interphalangeal joint.'},
                        'gapBetweenNeighbouringToesMm': TOE_GAP_MM, 'blendBehindTheWebsMm': BLEND_MM},
        'method': 'per toe: chain = end of distal phalanx + pad → interphalangeal joints → base of proximal phalanx, from the bones; donor toe (tip → web, by arc length of its centreline) mapped onto the chain from the tip to the web station; length by segment (the distal part, tip to 1.5 mm behind the nail root, scaled isotropically by the girth scale of the toe; all stretch on the shaft; easing to 1 over 3 mm either side of the web); cross-section scaled per toe; where bone cover would be short the surface is pushed out by a scalar field taken as a smooth upper envelope over the mesh, the tip cap (every vertex of the distal part) following as a rigid body and each nail put back onto a similarity transform of the donor nail; neighbouring toes parted at the surface equidistant from their phalanges; folded edges and vertices proud of the donor detail layer relaxed; behind the webs the donor is drawn onto the package skin and the transition solved for the displacement (biharmonic); see section 12 of INTEGRATION.txt',
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
        # 相邻两趾近节趾骨之间表面到表面的最小距离：趾根之间的鞍部要从这里穿过，两边各能有的覆盖至多是它的一半
        # least surface-to-surface distance between the proximal phalanges of neighbouring toes: the saddle between two toe bases has to pass through here, and the cover on either side can be half of it at most
        inter_gap = [round(float(cKDTree(segs[k][0][0]).query(segs[k + 1][0][0])[0].min()) / MM, 2) for k in range(4)]
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
        # 每趾的长度比例不再是一个数：远段（趾尖到甲根后 NAIL_MARGIN_MM，含趾腹和趾甲）按粗细比例等比缩放——甲因此不变形；
        # 余下的拉长全放在趾干上（没有特征的一段），两段之间的比例在 STRETCH_EASE_MM 内平滑过渡。
        # The length scale of a toe is no longer one number: the distal part (tip to NAIL_MARGIN_MM behind the nail root, i.e. pad and
        # nail) is scaled by the girth scale, isotropically, so the nail keeps its shape; the rest of the stretch goes to the shaft (the
        # featureless part), the rate easing from one to the other over STRETCH_EASE_MM.
        seg_rows, seg_par, tip_idx = [], [], []

        def segments():
            del seg_rows[:], seg_par[:], tip_idx[:]
            for k in range(5):
                xs, q, arc, x_web = donor_cl[k]
                s_web = arc[-1] * scale
                a_ = min(float(np.interp(nail_end_x[k], xs, arc)) + NAIL_MARGIN_MM * MM, 0.8 * arc[-1]) * scale
                w_ = min(STRETCH_EASE_MM * MM, 0.6 * (s_web - a_))
                # 远段不超出远节趾骨加软组织垫 1 mm / the distal part does not reach more than 1 mm beyond the distal phalanx plus pad
                lam_d = min(girth[k], (chains[k].l[1] + 0.001) / a_)
                # 趾蹼处：比例从趾干的值在 2 × w2 内缓变到 1（以前在蹼位突变，趾根背面因此起折痕）
                # at the web the rate eases from the shaft's value to 1 over 2 × w2 (it used to jump at the web station, which creased the dorsum of the toe base)
                w2_ = min(WEB_EASE_MM * MM, 0.4 * (s_web - a_ - w_))
                A_, B_ = s_web - a_ - w_ / 2, 0.1875 * w2_
                lam_s = (free[k] - lam_d * (s_web - A_) - B_) / (A_ - B_)
                uniform = lam_s < 0.8
                if uniform:
                    # 趾干会被压短到 0.8 以下：退回整趾一个比例 / the shaft would be shortened below 0.8: fall back to one scale for the whole toe
                    lam_d = lam_s = (free[k] - B_) / (s_web - B_)
                seg_par.append((a_, w_, lam_d, lam_s, s_web, w2_))
                # 远段的顶点（趾尖帽：趾腹、趾甲和甲周），按供体中心线的弧长划 / the vertices of the distal part (the tip cap: pad, nail and nail folds), by arc length along the donor centreline
                tvk = np.array(toes[k][0])
                tip_idx.append(tvk[np.interp((tips_d[k] - DV0[tvk]) @ donor_axis[k], xs, arc) * scale <= a_])
                seg_rows.append({'toe': ORDINAL[k], 'distalPartMm': round(a_ / MM, 1), 'distalScale': round(lam_d, 3), 'shaftScale': round(lam_s, 3), 'nailLengthOverWidthDistortion': round(lam_d / girth[k], 3), 'oneScaleForTheWholeToe': bool(uniform)})

        segments()

        def stretch_map(k, s):
            a_, w_, lam_d, lam_s, s_web, w2_ = seg_par[k]
            t = np.clip((s - a_) / max(w_, 1e-9), 0, 1)
            u = np.clip((s - (s_web - w2_)) / max(2 * w2_, 1e-9), 0, 1)
            return lam_d * s + (lam_s - lam_d) * (w_ * (t ** 3 - t ** 4 / 2) + np.maximum(s - a_ - w_, 0)) + (1 - lam_s) * (2 * w2_ * (u ** 3 - u ** 4 / 2) + np.maximum(s - s_web - w2_, 0))

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
            # 趾蹼之前按分段的比例（甲和趾腹不拉长，拉长都放在趾干上，见 stretch_map）；之后按 1:1
            # up to the web by the per-segment rates (nail and pad are not stretched, the shaft takes all of it; see stretch_map); 1:1 behind it
            sarc = stretch_map(k, s_d)
            # 骨链是折线：轴线和坐标架都在 ±AXIS_SMOOTH_MM 内取平均，关节处的转折因此摊开。趾根背面离轴线有十来毫米，
            # 转折只摊在 ±3 mm 内时，折线凹的一侧会被压到一半甚至折回（上一轮折痕的来源之一）。
            # The bone chain is a polyline: axis and frame are averaged over ±AXIS_SMOOTH_MM, which spreads the turn at a joint. The dorsum of
            # a toe base lies some ten millimetres off the axis; with the turn spread over only ±3 mm the concave side was compressed to half
            # its length or folded back (one source of the creases of the last round).
            taps = np.linspace(-1.0, 1.0, 13) * AXIS_SMOOTH_MM * MM
            C = np.mean([chains[k].point(sarc + t_) for t_ in taps], axis=0)
            tt = np.mean([chains[k].point(sarc + t_ + 0.001) - chains[k].point(sarc + t_ - 0.001) for t_ in taps], axis=0)
            tt /= np.linalg.norm(tt, axis=1, keepdims=True)
            uu = up_b[None] - (tt @ up_b)[:, None] * tt
            uu /= np.linalg.norm(uu, axis=1, keepdims=True)
            ll = np.cross(tt, uu)
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
        P_toemap = P.copy()
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
        toe_bone = []
        for k in range(5):
            o_ = np.cumsum([0] + [len(b_[0]) for b_ in segs[k]])[:-1]
            toe_bone.append((np.ascontiguousarray(np.concatenate([b_[0] for b_ in segs[k]])), np.ascontiguousarray(np.concatenate([b_[1] + oo for b_, oo in zip(segs[k], o_)]))))

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
        # 趾根最后 BASE_FREE_MM 的趾顶点也一并解出：趾与过渡面的接合处因此没有折痕
        # the last BASE_FREE_MM of each toe at its base is solved together with the transition, so that no crease is left where toe and transition join
        free_c = np.where(local & (phi < 1) & ((toe_of < 0) | (geo_rest < BASE_FREE_MM * MM)))[0]
        lv = np.where(local)[0]
        E0, _ = unique_edges(Fd_[local[Fd_].all(1)], nd)
        w0 = 1.0 / np.maximum(np.linalg.norm(DV0[E0[:, 0]] - DV0[E0[:, 1]], axis=1), 1e-6)
        A0 = graph(nd, E0, w0)
        dg0 = np.maximum(np.asarray(A0.sum(1)).ravel(), 1e-12)
        L0 = sp.eye(nd) - sp.diags(1.0 / dg0) @ A0
        B0 = (L0 @ L0).tocsr()
        fixed_c = np.setdiff1d(lv, free_c)
        # 解的是位移（P − G）而不是位置：位移在两头（趾、贴在皮肤上的一圈）都是平滑的场，供体前脚掌自己的形状（趾蹼、趾根的起伏）得以保留；
        # 以前直接解位置，被拉长的趾根与均匀权的解在接合处对不上，起折痕甚至折回。
        # The unknown is the displacement (P − G), not the position: the displacement is a smooth field at both ends (the toes, the ring on the
        # skin), and the donor forefoot's own shape (webs, the relief at the toe bases) is kept. Solving for positions, as before, did not
        # match the stretched toe bases to a uniform-weight solution and left creases, even folds, where they join.
        U_ = P - G
        U_[free_c] = spla.spsolve(B0[free_c][:, free_c].tocsc(), -(B0[free_c][:, fixed_c] @ U_[fixed_c]))
        P[free_c] = G[free_c] + U_[free_c]
        # ── 骨上的覆盖、趾间的分开、趾甲 ─ 第 12 节 / cover over the bones, parting of the toes, the nails (section 12) ──
        # 以前：每个顶点各自沿“离最近骨点”的方向外推，再对覆盖不足的骨顶点把最近三角形的三个顶点各推一次（不平滑）——
        # 趾尖因此被推成皱起的小块，趾甲被推皱。现在：外推量是一个标量场，在网格上取“平滑的上包络”（不小于所需，并向四周缓降）；
        # 方向场也在网格上低通；趾甲整片按同一个向量移动，最后再整片对回供体趾甲的相似变换（甲的顶点彼此不相对移动）。
        # Before: each vertex was pushed on its own away from its closest bone point, and then the three vertices of the triangle nearest to
        # a bone vertex short of cover were pushed once more, unsmoothed — which crumpled the toe tips into small fragments and wrinkled the
        # nails. Now the push is a scalar field replaced by a smooth upper envelope over the mesh (never less than what is needed, falling
        # away gently), its direction field is low-passed over the mesh as well, every nail moves by one vector, and at the end each nail is
        # put back onto a similarity transform of the donor nail (nail vertices never move relative to each other).
        mv_mask = (phi < 1) & local
        pushed = np.zeros(nd)
        fade = np.clip((1 - phi) / 0.5, 0, 1) * mv_mask
        ramp = np.clip(geo_rest / 0.004, 0, 1)
        band = (phi > 0) & (phi < 1)
        toe_idx = [np.array(tv) for tv, _ in toes]
        nail_idx = [vi[nail_v[vi]] for vi in toe_idx]
        rest_mv = np.where(mv_mask & (toe_of < 0))[0]
        Fl_ = np.ascontiguousarray(Fd_[(geo_toe < 0.09)[Fd_].all(1)])
        # 每个趾甲周围 NAIL_RING_MM 内的顶点：甲的刚性修正在这一圈里平滑退到 0 / vertices within NAIL_RING_MM of each nail: the rigid correction of the nail fades to 0 over this ring
        nail_ring = []
        for k in range(5):
            dn_ = csgraph.dijkstra(Gd, indices=nail_idx[k], min_only=True)[toe_idx[k]]
            xx = np.clip(1 - dn_ / (NAIL_RING_MM * MM), 0, 1)
            nail_ring.append(xx * xx * (3 - 2 * xx))

        def envelope(need, n=ENVELOPE_PASSES):
            g = need.copy()
            for _ in range(n):
                g = np.maximum(need, 0.5 * g + 0.5 * (Ad @ g) / deg)
            return g

        def cover_fields(P):
            # 趾上的顶点只对自己这个趾的趾骨量覆盖（邻趾的骨由“分开”一步管）；其余顶点对这只脚的全部趾骨和跖骨
            # toe vertices are measured against the phalanges of their own toe only (the neighbour's bones are the business of the parting step); the others against every phalanx and metatarsal of this foot
            S = np.full(nd, np.inf)
            D = np.zeros((nd, 3))
            for vi, (bv_, bf_) in [(toe_idx[k], toe_bone[k]) for k in range(5)] + [(rest_mv, (BVc, BFc))]:
                if not len(vi):
                    continue
                Q = np.ascontiguousarray(P[vi])
                d2, _, C = igl.point_mesh_squared_distance(Q, bv_, bf_)
                sg_ = np.where(np.abs(igl.winding_number(bv_, bf_, Q)) > 0.5, -1.0, 1.0)
                S[vi] = np.sqrt(d2) * sg_
                D[vi] = (Q - C) * sg_[:, None]
            D0 = D / np.maximum(np.linalg.norm(D, axis=1, keepdims=True), 1e-18)
            for _ in range(DIRECTION_PASSES):
                D = 0.5 * D + 0.5 * (Ad @ D) / deg[:, None]
            return S, D / np.maximum(np.linalg.norm(D, axis=1, keepdims=True), 1e-12), D0

        def rigid_nails(P):
            """每个趾甲 = 供体趾甲的一个相似变换（最小二乘）；周围一圈平滑跟随。返回每趾的比例和修正量
            each nail = one similarity transform of the donor nail (least squares); the ring round it follows smoothly. Returns per toe the scale and the correction applied"""
            rows = []
            for k in range(5):
                nv_, vi = nail_idx[k], toe_idx[k]
                a0, b0 = G[nv_].mean(0), P[nv_].mean(0)
                A_, B_ = G[nv_] - a0, P[nv_] - b0
                U, sv, Vt = np.linalg.svd(A_.T @ B_)
                dd = np.sign(np.linalg.det(U @ Vt))
                Rk = (U * np.array([1, 1, dd])) @ Vt
                ck = float((sv * np.array([1, 1, dd])).sum() / (A_ ** 2).sum())
                Tq = ck * ((G[vi] - a0) @ Rk) + b0
                corr = nail_ring[k][:, None] * (Tq - P[vi])
                rows.append((ck, float(np.linalg.norm(corr[nail_v[vi]], axis=1).max())))
                P[vi] += corr
            return rows

        fzone = Fd_[((geo_toe < (BLEND_MM + 6) * MM) & local)[Fd_].all(1)]
        relaxable = mv_mask & ~nail_v
        for k in range(5):
            relaxable[tip_idx[k]] = False

        def unfold(P, rounds=8, widen=False):
            """折过 UNFOLD_DEG 的边：它的顶点连同外扩几圈在网格上取邻点平均几次（趾尖帽不动）。widen：一轮比一轮扩得宽、平均得多——
            趾缝底的折边要把缝底填浅才消得掉。返回动过的顶点
            edges folded over UNFOLD_DEG: their vertices and a few rings round them are averaged over their mesh neighbours a few times (tip caps
            stay). widen: each round reaches further and averages more — a fold at the bottom of the cleft between two toes only goes when the
            bottom of the cleft is filled in. Returns the vertices moved"""
            moved_ = np.zeros(nd, bool)
            for r_ in range(rounds):
                fe_, fa_ = fold_angles(P, fzone)
                if not (fa_ > UNFOLD_DEG).any():
                    break
                m = np.zeros(nd, bool)
                m[fe_[fa_ > UNFOLD_DEG].ravel()] = True
                for _ in range(2 + (r_ // 3 if widen else 0)):
                    m |= (Ad @ m.astype(float)) > 0
                m &= relaxable
                moved_ |= m
                for _ in range(4 + (2 * r_ if widen else 0)):
                    Q = (Ad @ P) / deg[:, None]
                    P[m] = 0.5 * P[m] + 0.5 * Q[m]
            return moved_

        # 趾缝在趾根处留宽些（WEB_GAP_MM），向远侧 WEB_GAP_OVER_MM 内收到 TOE_GAP_MM：缝底要有两三条边的宽度才不折成一条折边，
        # 鞍部也才有地方盖住它后面的骨端
        # the cleft between two toes is kept wider at the base (WEB_GAP_MM), narrowing to TOE_GAP_MM over WEB_GAP_OVER_MM distally: the bottom of a cleft needs the width of two or three edges not to be one folded edge, and the saddle needs the room to cover the bone ends behind it
        gap_v = (TOE_GAP_MM + (WEB_GAP_MM - TOE_GAP_MM) * np.clip(1 - geo_rest / (WEB_GAP_OVER_MM * MM), 0, 1)) * MM
        unfolded = np.zeros(nd, bool)
        deprouded = np.zeros(nd, bool)
        hG0 = detail_height(G, Fd_, Ad, deg)
        girth_v = np.ones(nd)
        for k in range(5):
            girth_v[toe_idx[k]] = girth[k]
        n_iter = PUSH_ITERATIONS
        P_mapped = P.copy()
        for it in range(n_iter + FINAL_ROUNDS + COVER_ROUNDS):
            last = it >= n_iter + FINAL_ROUNDS   # 最后几轮只外推，不再松弛：覆盖说了算，折边由验收再查 / the last rounds push only and relax nothing: cover has the last word, and the acceptance checks the folds again
            S, D, D0 = cover_fields(P)
            # 趾蹼之后的顶点（趾根之间的鞍部）夹在相邻两趾的近节趾骨之间，两边都要 PUSH_MM 办不到：那里只要 COVER_MM
            # vertices behind the webs (the saddles between the toe bases) lie between the proximal phalanges of two toes, where PUSH_MM on both sides cannot be had: COVER_MM is asked there
            need = np.where(mv_mask, np.clip(np.where(toe_of >= 0, PUSH_MM, COVER_MM) * MM - S, 0, None), 0.0)
            # 趾蹼之后、最近骨点在侧面的顶点（两根近节趾骨之间的鞍部和它的两壁）不按顶点到骨的距离外推：往侧面推只会撞上另一根骨。
            # 那里的覆盖只由下面“骨顶点到皮肤”的量来管（它只在骨真的离皮肤太近处起作用）。
            # Vertices behind the webs whose closest bone point lies to the side (the saddle between two proximal phalanges and its walls) are
            # not pushed by their own distance from bone: a sideways push only runs into the other bone. Cover there is looked after by the
            # bone-to-skin measure below alone (which acts only where a bone really is too close to the skin).
            side_ = np.zeros(nd, bool)
            side_[rest_mv] = np.abs(D0[rest_mv] @ frame_b[2]) > 0.6
            need[side_] = 0
            # 顶点都离骨够远之后，三角形的弦仍可能切近骨面：对覆盖仍不足的骨顶点，它最近的那个三角形的三个顶点记上所需的量（同样进入包络）
            # with every vertex far enough from the bones a triangle's chord can still cut close: for bone vertices still short of cover the three vertices of the nearest triangle are given the amount needed (it enters the same envelope)
            Pc_ = np.ascontiguousarray(P)
            d2, fi, _ = igl.point_mesh_squared_distance(BVc, Pc_, Fl_)
            dist = np.sqrt(d2)
            inside = np.abs(igl.winding_number(Pc_, Fl_, BVc)) > 0.5
            short = (cKDTree(P[mv_mask]).query(BV)[0] < 0.006) & (np.where(inside, dist, -dist) < (COVER_MM + 0.6) * MM)
            if short.any():
                val = np.minimum((COVER_MM + 0.9) * MM - np.where(inside, dist, -dist)[short], 0.004)
                tv_ = Fl_[fi[short]]
                np.maximum.at(need, tv_.ravel(), np.repeat(val, 3) * mv_mask[tv_.ravel()])
            # 相邻两趾以“到两趾趾骨等距的面”为界，各自退到自己一侧（留 TOE_GAP_MM 的缝），但不退到自己的骨上覆盖不足
            # neighbouring toes are parted at the surface equidistant from their two sets of phalanges, each held on its own side (leaving TOE_GAP_MM), but never so far that its own bone cover would run short
            sep = np.zeros(nd)
            if True:
                for i in range(5):
                    vi = toe_idx[i]
                    Q = np.ascontiguousarray(P[vi])
                    for j in (i - 1, i + 1):
                        if 0 <= j < 5:
                            dj = np.sqrt(igl.point_mesh_squared_distance(Q, *toe_bone[j])[0])
                            sep[vi] = np.maximum(sep[vi], (S[vi] - dj + gap_v[vi]) / 2)
                sep = np.minimum(np.clip(sep, 0, None), np.clip(S - (COVER_MM + SEP_FLOOR_MM) * MM, 0, None)) * ramp
                sep[~np.isfinite(sep)] = 0
            # 趾尖帽（远段：趾腹、趾甲、甲周）整个作刚体运动，不逐顶点外推：对“各顶点各自外推（或让开邻趾）后的位置”求加权最小二乘的
            # 刚体变换（覆盖不足的顶点权重大）。帽不放大也不变形，所以趾甲的顶点彼此不相对移动；帽与趾干之间经包络平滑地跟上。
            # 刚体运动补不齐的覆盖不硬补：由下面的验收照实判定。
            # The tip cap (the distal part: pad, nail, nail folds) moves as one rigid body instead of vertex by vertex: the weighted least-squares
            # rigid transform onto "each vertex pushed on its own (or parted from the neighbour)", the vertices short of cover weighing most. The
            # cap is neither enlarged nor deformed, so nail vertices never move relative to each other; between cap and shaft the skin follows
            # through the envelope. Cover that a rigid motion cannot supply is not forced: the acceptance below judges it as it is.
            tip_move = []
            for k in range(5):
                tv_ = tip_idx[k]
                X0_, Dt = P[tv_], D[tv_]
                want_ = need[tv_] - sep[tv_]
                if not (np.abs(want_) > 1e-6).any():
                    tip_move.append(np.zeros((len(tv_), 3)))
                    need[tv_] = sep[tv_] = 0
                    continue
                Y_ = X0_ + Dt * want_[:, None]
                wt = 1.0 + TIP_DEFICIT_WEIGHT * (need[tv_] > 1e-6)
                a0, b0 = (wt[:, None] * X0_).sum(0) / wt.sum(), (wt[:, None] * Y_).sum(0) / wt.sum()
                U, sv, Vt = np.linalg.svd(((X0_ - a0) * wt[:, None]).T @ (Y_ - b0))
                Rk = (U * np.array([1, 1, np.sign(np.linalg.det(U @ Vt))])) @ Vt
                mvec = (X0_ - a0) @ Rk + b0 - X0_
                tip_move.append(mvec)
                along = np.einsum('ij,ij->i', mvec, Dt)
                need[tv_], sep[tv_] = np.clip(along, 0, None), np.clip(-along, 0, None)
            g = (envelope(need) - envelope(sep)) * fade
            # 向内的移动（分开）逐顶点不得超过它自己的余量：包络会把分开量带到余量小的邻点上
            # the inward movement (parting) is limited vertex by vertex to its own allowance: the envelope carries it to neighbours with less to spare
            g = np.maximum(g, -np.clip(np.where(np.isfinite(S), S, 0) - (COVER_MM + SEP_FLOOR_MM) * MM, 0, None))
            # 包络把移动量带到周围的顶点上；被带动的顶点（自己没有所需量的）方向取“（所需量 × 方向）这个向量场低通后的方向”，即跟着带动
            # 它们的顶点走：鞍部向远侧退时，两侧的趾壁若各沿自己的径向走，就会挤进趾缝里。
            # The envelope carries movement to the vertices round about; a vertex that is carried (with no need of its own) takes the direction
            # of the low-passed vector field (amount needed × direction), i.e. goes with the vertices that carry it: when a saddle retreats
            # distally, toe walls each moving along their own radial direction would crowd into the cleft.
            Vd = D * (need - sep)[:, None]
            for _ in range(ENVELOPE_PASSES):
                Vd = 0.5 * Vd + 0.5 * (Ad @ Vd) / deg[:, None]
            vl = np.linalg.norm(Vd, axis=1)
            own = (need > 1e-6) | (sep > 1e-6) | (vl < 1e-9)
            Dg = np.where(own[:, None], D, np.sign(g)[:, None] * Vd / np.maximum(vl, 1e-18)[:, None])
            step_ = Dg * g[:, None]
            for k in range(5):
                step_[tip_idx[k]] = tip_move[k]
            P = P + step_
            pushed += np.linalg.norm(step_, axis=1)
            if not last:
                # 末几轮不再分开邻趾，松弛改用越扩越宽的那种（趾缝底的折边），外推与松弛交替直到两者都不再动
                # in the final rounds the toes are no longer parted and the relaxation is the widening kind (folds at the bottom of the clefts); push and relaxation alternate until neither moves anything
                unfolded |= unfold(P) if it < n_iter else unfold(P, rounds=24, widen=True)
                if it >= n_iter:
                    # 高出供体自己的细节层超过 0.8 × FRAGMENT_MM 的顶点（碎片的苗头）连同一圈邻点就地松弛
                    # vertices standing more than 0.8 × FRAGMENT_MM above the donor's own detail layer (fragments in the making) are relaxed where they are, with one ring round them
                    m = (detail_height(P, Fd_, Ad, deg) - girth_v * hG0 > 0.8 * FRAGMENT_MM * MM) & (toe_of >= 0)
                    m = (m | ((Ad @ m.astype(float)) > 0)) & relaxable
                    deprouded |= m
                    for _ in range(3):
                        Q = (Ad @ P) / deg[:, None]
                        P[m] = 0.5 * P[m] + 0.5 * Q[m]
            if it == 2:
                for _ in range(3):
                    Q = (Ad @ P) / deg[:, None]
                    P[band] = 0.5 * P[band] + 0.5 * Q[band]
        # 收尾（不再松弛）：只修两种局部的残留，每次都是小而平滑的移动——
        #   · 趾骨顶点离皮肤不到 COVER_JOINT_MM + 0.3 mm 的地方（多在趾蹼之后的鞍部，骨端朝前顶着鞍部）：把最近的那个三角形周围的皮肤
        #     沿“骨 → 皮肤”方向顶起来（包络只取 TENT_PASSES 次，范围约两三圈）；
        #   · 落进邻趾里的个别顶点：连同一圈邻点朝自己的骨退 0.4 mm。
        # 趾尖帽不参与。之后折边、碎片、覆盖、互穿都由验收重新判定。
        # Finishing (no more relaxation): only two kinds of local leftovers are mended, each time by a small smooth movement —
        #   · where a phalanx vertex is less than COVER_JOINT_MM + 0.3 mm from the skin (mostly in the saddles behind the webs, a bone end
        #     pressing forwards into the saddle): the skin round the nearest triangle is tented along bone → skin (the envelope takes only
        #     TENT_PASSES passes, two or three rings);
        #   · the odd vertex lying inside the neighbouring toe: it and one ring round it retreat 0.4 mm towards their own bone.
        # Tip caps take no part. Folds, fragments, cover and interpenetration are then judged afresh by the acceptance.
        PBV = np.ascontiguousarray(np.concatenate([tb_[0] for tb_ in toe_bone]))
        # 每个趾骨顶点收尾时要的覆盖：游离趾里 COVER_MM + 0.25，趾蹼之后（近节趾骨蹼位以近）COVER_JOINT_MM + 0.3
        # the cover each phalanx vertex is finished to: COVER_MM + 0.25 within the free toe, COVER_JOINT_MM + 0.3 behind the web (the proximal phalanx proximal to the web station)
        fin_tgt, fin_req = [], []
        for k in range(5):
            for bi, (bv_, _bf) in enumerate(segs[k]):
                e_ = ends_all[k][bi]
                ax_ = e_[1] - e_[0]
                in_free = ((bv_ - e_[0]) @ ax_) / (ax_ @ ax_) > web_frac[k] if bi == 0 else np.ones(len(bv_), bool)
                fin_tgt.append(np.where(in_free, COVER_MM + 0.25, COVER_JOINT_MM + 0.3) * MM)
                fin_req.append(np.where(in_free, COVER_MM, COVER_SADDLE_MM) * MM)
        fin_tgt, fin_req = np.concatenate(fin_tgt), np.concatenate(fin_req)
        # 顶起与松弛互相牵制，一轮一轮并不单调变好：每轮开头给当前状态打分（先看有没有折过 FOLD_DEG 的边、有没有顶点在邻趾里，
        # 再看趾骨覆盖相对要求的最小余量），最后取分数最高的那一轮的状态。所以收尾不会比不收尾差。
        # Tenting and relaxation work against each other and the rounds do not improve monotonically: at the start of each round the current
        # state is scored (first: no edge folded over FOLD_DEG and no vertex inside the neighbouring toe; then: the least margin of bone cover
        # over what is required), and the state of the best round is taken in the end. Finishing therefore never leaves things worse.
        best = None
        finishing = {'rounds': 0, 'verticesTented': 0, 'largestTentMm': 0.0, 'verticesTakenOutOfTheNeighbour': 0}
        tented = np.zeros(nd, bool)
        for rnd in range(FINISH_ROUNDS + 1):
            Pc_ = np.ascontiguousarray(P)
            d2, fi, Cn = igl.point_mesh_squared_distance(PBV, Pc_, Fl_)
            dist = np.sqrt(d2)
            cov_ = np.where(np.abs(igl.winding_number(Pc_, Fl_, PBV)) > 0.5, dist, -dist)
            short = cov_ < fin_tgt
            needv = np.zeros(nd)
            Vn_ = np.zeros((nd, 3))
            if short.any():
                val = np.minimum(fin_tgt[short] + 0.0003 - cov_[short], 0.002)
                dn_ = (Cn[short] - PBV[short]) * np.sign(cov_[short])[:, None]
                dn_ /= np.maximum(np.linalg.norm(dn_, axis=1, keepdims=True), 1e-12)
                for c_ in range(3):
                    vv_ = Fl_[fi[short]][:, c_]
                    np.maximum.at(needv, vv_, val)
                    np.add.at(Vn_, vv_, dn_ * val[:, None])
                needv[~relaxable] = 0
            inside_ = np.zeros(nd, bool)
            for i in range(5):
                f_, loops_ = capped(Fd_, toes[i][0], nd)
                ev_, ef_ = [], []
                for lp in loops_:
                    ci_ = nd + len(ev_)
                    ev_.append(P[lp].mean(0))
                    ef_ += [[lp[j], lp[(j + 1) % len(lp)], ci_] for j in range(len(lp))]
                Vk_ = np.ascontiguousarray(np.vstack([P] + ([np.array(ev_)] if ev_ else [])))
                Fk_ = np.ascontiguousarray(np.vstack([f_] + ([np.array(ef_)] if ef_ else [])))
                for j in (i - 1, i + 1):
                    if 0 <= j < 5:
                        inside_[toe_idx[j][np.abs(igl.winding_number(Vk_, Fk_, np.ascontiguousarray(P[toe_idx[j]]))) > 0.5]] = True
            score = (bool(not inside_.any() and not (fold_angles(P, fzone)[1] > FOLD_DEG).any()), float((cov_ - fin_req).min()))
            if best is None or score > best[0]:
                best = (score, P.copy(), rnd)
            if (not short.any() and not inside_.any()) or rnd == FINISH_ROUNDS:
                break
            finishing['rounds'] += 1
            if (needv > 0).any():
                g_ = needv.copy()
                for _p in range(TENT_PASSES):
                    g_ = np.maximum(needv, 0.5 * g_ + 0.5 * (Ad @ g_) / deg)
                g_[~relaxable] = 0
                # 每一块（相连的被顶起的顶点）只用一个方向：块内各“骨 → 皮肤”方向按所需量加权的和。方向处处相同、幅度平滑的移动不会把面折起来；
                # 鞍部两侧的骨方向相反，和就指向它们共同的那个分量（朝远侧、出趾缝）。幅度按方向的一致程度放大（至多 1 / 0.35）。
                # Each patch (connected tented vertices) moves in one direction only: the sum of its bone → skin directions weighted by the amount
                # needed. A movement of one direction and smooth amplitude cannot fold the surface; the two bones of a saddle push in opposite
                # directions and their sum is the component they share (distally, out of the cleft). The amplitude is raised by how little the
                # directions agree (at most 1 / 0.35).
                act = np.where(g_ > 1e-6)[0]
                ncp_, lab_ = csgraph.connected_components(Ad[act][:, act], directed=False)
                for c_ in range(ncp_):
                    vv_ = act[lab_ == c_]
                    sv_ = Vn_[vv_].sum(0)
                    tot_ = np.linalg.norm(Vn_[vv_], axis=1).sum()
                    if tot_ < 1e-12 or np.linalg.norm(sv_) < 1e-12:
                        continue
                    coh = max(np.linalg.norm(sv_) / tot_, 0.35)
                    P[vv_] += np.outer(g_[vv_] / coh, sv_ / np.linalg.norm(sv_))
                    tented[vv_] = True
                    finishing['largestTentMm'] = max(finishing['largestTentMm'], round(float(g_[vv_].max() / coh) / MM, 2))
            if inside_.any():
                finishing['verticesTakenOutOfTheNeighbour'] += int(inside_.sum())
                m_ = (inside_ | ((Ad @ inside_.astype(float)) > 0)) & relaxable
                _, D_, _ = cover_fields(P)
                P[m_] -= D_[m_] * 0.0004
            unfolded |= unfold(P, rounds=16, widen=True)
            m = (detail_height(P, Fd_, Ad, deg) - girth_v * hG0 > 0.8 * FRAGMENT_MM * MM) & (toe_of >= 0)
            m = (m | ((Ad @ m.astype(float)) > 0)) & relaxable
            deprouded |= m
            for _p in range(3):
                Q = (Ad @ P) / deg[:, None]
                P[m] = 0.5 * P[m] + 0.5 * Q[m]
        P = best[1]
        finishing['roundTaken'] = int(best[2])
        finishing['leastMarginOfBoneCoverMm'] = round(best[0][1] / MM, 2)
        # 最后的保底：仍有趾骨顶点的覆盖不到 COVER_SADDLE_MM + 0.2 的（趾根鞍部或小趾外侧的沟里，个别骨端），把最近的那个三角形的顶点
        # 直接沿“骨 → 皮肤”顶出去（包络只取 4 次），之后不再松弛。这是上一轮的做法，只用在这几个顶点上；它会不会留下折边由验收来查。
        # The last resort: where a phalanx vertex still has less than COVER_SADDLE_MM + 0.2 (single bone ends in a saddle between toe bases or in
        # the groove lateral to the little toe), the vertices of the nearest triangle are pushed straight out along bone → skin (an envelope
        # of 4 passes only), with no relaxation afterwards. This is last round's method, used on these few vertices alone; whether it leaves
        # a fold is for the acceptance to find.
        hard = np.zeros(nd, bool)
        best2 = None
        for rnd in range(LAST_RESORT_ROUNDS + 1):
            # 上一轮顶出去之后折过 FOLD_DEG − 8° 的边：只动这些边自己的顶点（不外扩），取邻点平均 3 次；然后打分，最后取最好的一轮
            # edges folded over FOLD_DEG − 8° by the push of the round before: only their own vertices (no rings) are averaged over their neighbours, 3 times; the state is then scored and the best round taken in the end
            if rnd:
                fe_, fa_ = fold_angles(P, fzone)
                m = np.zeros(nd, bool)
                m[fe_[fa_ > FOLD_DEG - 8].ravel()] = True
                m &= relaxable
                for _p in range(3):
                    Q = (Ad @ P) / deg[:, None]
                    P[m] = 0.5 * P[m] + 0.5 * Q[m]
            Pc_ = np.ascontiguousarray(P)
            d2, fi, Cn = igl.point_mesh_squared_distance(PBV, Pc_, Fl_)
            dist = np.sqrt(d2)
            cov_ = np.where(np.abs(igl.winding_number(Pc_, Fl_, PBV)) > 0.5, dist, -dist)
            short = cov_ < (COVER_SADDLE_MM + 0.2) * MM
            # 打分：先看每个趾骨顶点是否都在皮内至少 COVER_SADDLE_MM（骨不能露在皮外），再看折边越少越好
            # the score: first whether every phalanx vertex lies at least COVER_SADDLE_MM inside the skin (bone may not show through), then the fewer folded edges the better
            score = (bool((cov_ - fin_req).min() >= -1e-6), -int((fold_angles(P, fzone)[1] > FOLD_DEG).sum()))
            if best2 is None or score > best2[0]:
                best2 = (score, P.copy(), rnd, hard.copy())
            if not short.any() or rnd == LAST_RESORT_ROUNDS:
                break
            val = np.minimum((COVER_SADDLE_MM + 0.5) * MM - cov_[short], 0.002)
            dn_ = (Cn[short] - PBV[short]) * np.sign(cov_[short])[:, None]
            dn_ /= np.maximum(np.linalg.norm(dn_, axis=1, keepdims=True), 1e-12)
            needv, Vn_ = np.zeros(nd), np.zeros((nd, 3))
            for c_ in range(3):
                vv_ = Fl_[fi[short]][:, c_]
                np.maximum.at(needv, vv_, val)
                np.add.at(Vn_, vv_, dn_ * val[:, None])
            g_ = needv.copy()
            for _p in range(4):
                g_ = np.maximum(needv, 0.5 * g_ + 0.5 * (Ad @ g_) / deg)
                Vn_ = 0.5 * Vn_ + 0.5 * (Ad @ Vn_) / deg[:, None]
            g_[~relaxable] = 0
            P = P + Vn_ / np.maximum(np.linalg.norm(Vn_, axis=1, keepdims=True), 1e-18) * g_[:, None]
            hard |= g_ > 1e-6
        P, hard = best2[1], best2[3]
        finishing['verticesPushedAsALastResort'] = int(hard.sum())
        finishing['lastResortRoundTaken'] = int(best2[2])
        finishing['verticesTented'] = int(tented.sum())
        nail_corr = [r_[1] for r_ in rigid_nails(P)]   # 这一次修正掉的量（配准本身留下的非刚性）/ what this call corrects (the non-rigid part left by the fit itself)
        nail_rigid = rigid_nails(P)   # 第二次的修正量就是残差（应为 0）/ the correction of the second call is the residual (should be 0)
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
            np.savez(os.path.join(os.environ['SKINOPEN_DEBUG'], 'toes-debug-%s.npz' % side), S=S_, G=G, si=si, org=org, hit=hit, ctr_s=ctr_s, ctr_d=ctr_d, stations=stations, footv=pk.V[foot_v], frame=frame_b, mtpc=mtp.mean(0), P=P, F=Fd_, geo=geo_toe, phi=phi, toe_of=toe_of, pushed=pushed, BV=BV, BF=BF, free=np.array(free), P_mapped=P_mapped, P_toemap=P_toemap, need=need, Sfield=S, nailw=np.concatenate(nail_ring), toecat=np.concatenate(toe_idx), chains=np.array([np.r_[c_.p.ravel(), np.zeros(12)][:12] for c_ in chains]))
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
        # 趾甲是刚性片：每个甲是供体甲的相似变换，残差应为 0 / the nails are rigid patches: each is a similarity transform of the donor nail, residual 0
        for k in range(5):
            if ORDINAL[k] in nails:
                nails[ORDINAL[k]]['rigidPatch'] = {'scaleAgainstTheDonorAtFootScale': round(nail_rigid[k][0], 3), 'residualMm': round(nail_rigid[k][1] / MM, 4), 'correctedByMm': round(nail_corr[k] / MM, 3)}
            if nail_rigid[k][1] > 1e-6:
                fails.append('nail of the %s %s toe is not a rigid copy of the donor nail (residual %.3f mm)' % (word, ORDINAL[k], nail_rigid[k][1] / MM))
        # 折叠的边：改动过的那部分供体面上，两侧面法线夹角超过 FOLD_DEG 的边一条也不许有（供体原样时最大的角记在报告里）
        # folded edges: on the part of the donor surface that was changed no edge may have its two face normals more than FOLD_DEG apart (the largest angle of the donor as it is, is in the report)
        fe, fa = fold_angles(P, fzone)
        _, fa0 = fold_angles(G, fzone)
        per_toe = [int(((fa > FOLD_DEG) & (toe_of[fe[:, 0]] == k)).sum()) for k in range(5)]
        folds = {'limitDeg': FOLD_DEG, 'edges': int(len(fa)), 'over90': int((fa > 90).sum()), 'over120': int((fa > FOLD_DEG).sum()), 'over150': int((fa > 150).sum()), 'largestDeg': round(float(fa.max()), 1),
                 'over120PerToe': per_toe, 'over120BehindTheToes': int((fa > FOLD_DEG).sum() - sum(per_toe)), 'verticesRelaxedToUnfold': int(unfolded.sum()), 'relaxedAboveDeg': UNFOLD_DEG, 'donorAsItIs': {'over90': int((fa0 > 90).sum()), 'largestDeg': round(float(fa0.max()), 1)}}
        # 保底顶出的那几个顶点（趾根鞍部、小趾外侧沟里的骨端）上的折边单独计数：那里“骨不露出皮外”与“没有折边”在这张网格上不能两全，
        # 取前者，至多容许 LAST_RESORT_FOLDS 条，照实写进报告。其余地方一条也不许有。
        # Folded edges at the vertices pushed as a last resort (bone ends in a saddle between toe bases or in the groove lateral to the little
        # toe) are counted apart: there "no bone outside the skin" and "no folded edge" cannot both be had on this mesh; the former is kept and
        # at most LAST_RESORT_FOLDS such edges are allowed, stated plainly in the report. Anywhere else none is allowed.
        at_hard = hard[fe].any(1) & (fa > FOLD_DEG)
        folds['over120AtLastResortVertices'] = int(at_hard.sum())
        folds['over120Elsewhere'] = int((fa > FOLD_DEG).sum() - at_hard.sum())
        folds['allowedAtLastResortVertices'] = LAST_RESORT_FOLDS
        if folds['over120Elsewhere'] or at_hard.sum() > LAST_RESORT_FOLDS:
            fails.append('%d edges of the %s forefoot patch are folded over %d° (largest %.0f°; per toe %s; %d of them at vertices pushed as a last resort, where %d are allowed)' % ((fa > FOLD_DEG).sum(), word, FOLD_DEG, fa.max(), per_toe, at_hard.sum(), LAST_RESORT_FOLDS))
        # 碎片：游离趾上，“细节层”比供体自己的细节层高出或低下超过 FRAGMENT_MM 的顶点连成的块（供体的细节按该趾的粗细比例放大后比较）
        # fragments: on the free toes, connected groups of vertices whose detail layer stands more than FRAGMENT_MM above or below the donor's own (the donor's detail scaled by the girth scale of the toe)
        resid = detail_height(P, Fd_, Ad, deg) - girth_v * hG0
        tv_all = toe_of >= 0
        frag_rows, hollow_rows = [], []
        for sign_, rows_ in ((1.0, frag_rows), (-1.0, hollow_rows)):
            fragv = np.where((sign_ * resid > FRAGMENT_MM * MM) & tv_all)[0]
            if len(fragv):
                ncp, labf = csgraph.connected_components(Ad[fragv][:, fragv], directed=False)
                for c_ in range(ncp):
                    vv = fragv[labf == c_]
                    rows_.append({'toe': ORDINAL[int(np.bincount(toe_of[vv]).argmax())], 'vertices': int(len(vv)), 'mm': round(float(np.abs(resid[vv]).max()) / MM, 2), 'onTheNail': int(nail_v[vv].sum())})
        if frag_rows:
            fails.append('%d fragments on the toes of the %s foot (groups of vertices standing more than %.1f mm proud of the donor\'s own surface detail; largest %.2f mm)' % (len(frag_rows), word, FRAGMENT_MM, max(r_['mm'] for r_ in frag_rows)))
        fragments = {'limitMm': FRAGMENT_MM, 'rule': 'detail layer = a vertex\'s height above its own low-passed surface (10 passes over the mesh); compared with the donor\'s detail layer at the girth scale of the toe. A fragment is a connected group of free-toe vertices standing more than the limit proud of that; hollows (the same, below) are reported and do not fail the step: relaxation removes donor creases legitimately',
                     'groups': frag_rows, 'hollows': hollow_rows, 'verticesRelaxedForStandingProud': int(deprouded.sum()),
                     'detailAgainstTheDonorMm': {'p50': round(float(np.median(np.abs(resid[tv_all]))) / MM, 3), 'p99': round(float(np.percentile(np.abs(resid[tv_all]), 99)) / MM, 3), 'mostProud': round(float(resid[tv_all].max()) / MM, 3), 'deepestHollow': round(float(-resid[tv_all].min()) / MM, 3)}}
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
                'forefootOntoSkin': {'rule': 'by direction within the cross-section (ray from the centre of the cross-section)', 'vertices': int(len(si)), 'raysWithoutAHit': ray_missed}, 'lengthBySegment': seg_rows, 'finishing': finishing, 'foldedEdges': folds, 'fragments': fragments, 'bones': bone_rows, 'gapBetweenTheProximalPhalangesOfNeighbouringToesMm': inter_gap, 'boneCover': cover, 'neighbours': overlap, 'nails': nails, 'nailPlateParts': plate, 'failures': fails}
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
    Vdel, Fdel = np.ascontiguousarray(pk.V.copy()), np.ascontiguousarray(pk.F[pk.groups['skin']].copy())
    post_fail = []
    for side, (P, Fd_, seeds, mtp, include, region) in fitted.items():
        ball = pk.joint('mtp2_' + side)
        if ball is None:
            raise RuntimeError('toes: joints.json maps no joint to mtp2_%s (MHR ball joint)' % side)
        info, gstats, ids, geo = graft(pk, P, Fd_, seeds, 'toes' + side, differ_mm=0.8, reach_mm=75.0, grow_rings=1, blend_mm=6.0, rigid_joint=ball, rigid_from_mm=5.0, rigid_full_mm=15.0, tag_patch='graftCurated', donor_include=include, skin_region=region, rim_gap_mm=RIM_GAP_MM)
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
        # 缝合处的台阶：缝合三角形的顶点和重心离原皮肤曲面的最大距离（两条环都应当在原皮肤上）；以及接入后这一片（含缝合带）上折过 FOLD_DEG 的边
        # the step at the seam: the largest distance of the stitch triangles' vertices and centroids from the delivered skin surface (both rims should lie on it); and the edges folded over FOLD_DEG on the patch as grafted (stitch included)
        zf_ = pk.F[pk.groups['toes' + side + 'Stitch']]
        # 台阶 = 缝合带两条环上的顶点离原皮肤曲面的最大距离（两侧的面在这里相接）。缝合三角形的重心另记为“弦高”：原皮肤在洞口处的边长有
        # 5–7 mm，缝合三角形跨过它的棱时重心会离开那张带棱的曲面，那不是台阶，不作为条件。
        # The step = the largest distance of the vertices of the two loops of the stitch band from the delivered skin surface (where the two
        # sides meet). The centroids of the stitch triangles are recorded apart as "sag": the delivered skin has edges of 5–7 mm at the rim
        # of the hole, and a stitch triangle spanning one of its ridges has its centroid off that faceted surface; that is not a step and is
        # not a criterion.
        step_mm = float(np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(pk.V[np.unique(zf_)]), Vdel, Fdel)[0]).max()) / MM
        sag_mm = float(np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(pk.V[zf_].mean(1)), Vdel, Fdel)[0]).max()) / MM
        gf_ = pk.F[pk.groups['toes' + side] | pk.groups['toes' + side + 'Stitch']]
        ge_, ga_ = fold_angles(pk.V, gf_)
        zv_ = np.zeros(len(pk.V), bool)
        zv_[np.unique(zf_)] = True
        at_seam = zv_[ge_].any(1)
        gstats['seam'] = {'stepMm': round(step_mm, 3), 'limitMm': SEAM_STEP_MM, 'sagOfStitchTrianglesMm': round(sag_mm, 3), 'largestAngleAtTheStitchDeg': round(float(ga_[at_seam].max()), 1)}
        gstats['foldedEdgesAfterGrafting'] = {'over120': int((ga_ > FOLD_DEG).sum()), 'ofThemAtTheStitch': int(((ga_ > FOLD_DEG) & at_seam).sum()), 'largestDeg': round(float(ga_.max()), 1), 'allowed': stats['sides'][side]['foldedEdges']['over120AtLastResortVertices']}
        if step_mm > SEAM_STEP_MM:
            post_fail.append('the seam of the %s forefoot stands %.2f mm off the delivered skin (limit %.1f)' % (side, step_mm, SEAM_STEP_MM))
        if (ga_ > FOLD_DEG).sum() > stats['sides'][side]['foldedEdges']['over120AtLastResortVertices']:
            post_fail.append('%d edges of the grafted %s forefoot (stitch included) are folded over %d° (largest %.0f°; %d were allowed at last-resort vertices)' % ((ga_ > FOLD_DEG).sum(), side, FOLD_DEG, ga_.max(), stats['sides'][side]['foldedEdges']['over120AtLastResortVertices']))
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
    stats['leastOfAllNeedsMm'] = COVER_SADDLE_MM
    if stats['leastOfAllMm'] < COVER_SADDLE_MM - 1e-6:
        post_fail.insert(0, 'after grafting, the least cover over a phalanx was %.2f mm (needs %.1f): %s' % (stats['leastOfAllMm'], COVER_SADDLE_MM, min(final, key=final.get)))
    if post_fail:
        # 撤回：趾骨在接入后的皮肤上覆盖不足 / undone: a phalanx is not covered enough by the grafted skin
        # 调试：设了 SKINOPEN_DEBUG 时，把被撤回的那张皮肤另存一份 / debugging: with SKINOPEN_DEBUG set, the skin that is being undone is saved as well
        if os.environ.get('SKINOPEN_DEBUG'):
            write_obj(os.path.join(os.environ['SKINOPEN_DEBUG'], 'toes-failed-graft.obj'), pk.V, [(g_, pk.F[m_]) for g_, m_ in pk.groups.items() if m_.any()], [])
        for k, v in saved.items():
            setattr(pk, k, v)
        stats['grafted'] = False
        stats['accepted'] = False
        stats['notGraftedBecause'] = '; '.join(post_fail)
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
    if stats['grafted']:
        # 近景：两只脚各从上、前、下三个方向，单一肤色（第 12 节要求逐张看）/ close-ups: each foot from above, the front and below, in one skin colour (section 12 asks that every one be looked at)
        views = []
        for side, (P, Fd_, seeds, mtp, _inc, _reg) in fitted.items():
            c = [round(float(v), 4) for v in (0.35 * mtp.mean(0) + 0.65 * seeds.mean(0))]
            for yaw, pitch in ((0, 89), (0, 10), (0, -89)):
                views.append({'yaw': yaw, 'pitch': pitch, 'center': c, 'halfHeight': 0.042, 'width': 760, 'height': 640, 'items': [0]})
        pk.render_specs['toesClose'] = {'out': 'renders/toes-close.png', 'columns': 3, 'items': [{'obj': 'skin.obj', 'color': [226, 178, 156]}], 'views': views, 'note': 'rows: left foot, right foot; columns: from above, from the front, from below'}
    pk.report['toes'] = stats
