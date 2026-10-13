# 男性外生殖器的皮肤：把他本人扫描皮肤上的阴茎、阴囊、阴囊颈和会阴缝（BodyParts3D FJ2810 的外壁）接到皮肤包的皮肤上。
# 由 graft.py 的 genital 步骤调用。
# The skin of the male external genitalia: grafts penis, scrotum, scrotal neck and perineal raphe of his own scanned
# skin (outer wall of BodyParts3D FJ2810) into the skin of a skin package. Called by the genital step of graft.py.
#
# 做法（INTEGRATION.txt 第 13 节；第 11 节的做法已被取代）/ the procedure (section 13 of INTEGRATION.txt; that of section 11 is superseded)
#   1. 拟合皮肤上要换掉的区域 = 与扫描皮肤相差超过阈值、或自己与自己相交的顶点，围着深层部件连成一片，向外扩一圈。
#      它的边缘因此落在两张皮肤本来就吻合的地方。
#      The region of the fitted skin to replace = vertices that differ from the scan by more than a threshold or lie on
#      triangles of the fitted skin that intersect each other, connected round the deep parts, grown by one ring. Its
#      rim therefore lies where the two skins agree anyway.
#   2. 扫描片 = 扫描上网格细的那一片（阴茎、阴囊、阴囊颈、会阴缝）连同贴近深层部件的部分；边缘沿一个光滑标量场的
#      等值线切开（只切三角形，不动任何扫描顶点；切出的新顶点在扫描的边上）。
#      The scanned patch = the finely meshed piece of the scan (penis, scrotum, scrotal neck, perineal raphe) together
#      with what lies close to the deep parts; its rim is cut along a level line of a smooth scalar field (triangles
#      are cut, no scanned vertex moves; the new vertices lie on edges of the scan).
#   3. 过渡面（构造物，标签 graftConstruction）：扫描片边缘与拟合皮肤洞缘之间，以扫描在这一带的粗网格面为底稿，
#      重新布成边长渐变的网格（靠扫描片细、靠拟合皮肤粗），再解一次带数据项的双调和方程把它抹光顺，
#      与扫描片和周围的拟合皮肤相切。
#      The blend surface (construction, tag graftConstruction): between the rim of the patch and the rim of the hole
#      in the fitted skin; the coarse scan surface of that zone is the draft, re-meshed with a graded edge length (fine
#      at the patch, coarse at the fitted skin), then faired by a biharmonic solve with a data term, tangent to the
#      patch and to the fitted skin round it.

import os
import re

import numpy as np
import scipy.sparse as sp
import scipy.sparse.csgraph as csgraph
import scipy.sparse.linalg as spla
from scipy.spatial import cKDTree

from open_skin import MM, TAGS, graph, half_edge_map, unique_edges
from graft import BP3D_LICENCE_NOTE, bp3d_outer_skin, fill_holes, fill_small_holes, grow, harmonic_extension, ordered_loop, single_loop_region, vertex_graph, zipper_by_parameter
from remesh import cut_by_level, edge_table, folded_edges, remesh, split_long_edges

# 规则里的数（都写进报告）/ the numbers of the rules (all recorded in the report)
DIFFER_MM = 2.5        # 拟合皮肤与扫描相差多少算“不吻合” / how far fitted skin and scan must differ to count as disagreeing
CREASE_DEG = 60.0      # 拟合皮肤上折过这个角度的边算皱褶 / an edge of the fitted skin folded over this counts as a crumple
GROW_RINGS = 1         # 不吻合的区域向外扩的圈数 / rings by which the disagreeing region is grown
MIN_BAND_MM = 12.0     # 扫描片离洞缘至少这么远，否则再扩一圈 / the patch must stay this far from the rim of the hole, else one more ring
FINE_EDGE_MM = 5.0     # 供体“细”网格：平滑后的邻边平均长度上限 / fine donor mesh: upper limit of the smoothed mean incident edge length
FINE_REACH_MM = 60.0   # 细网格部分离深层部件的最大距离 / greatest distance of the fine part from the deep parts
CORE_DIST_MM = 15.0    # 离深层部件这么近的扫描面也算在片内 / scan surface this close to a deep part belongs to the patch too
REFINE_MM = 3.0        # 切线附近先把扫描三角形的边分到这么短（顶点落在原来的边上）/ near the cut lines scan edges are first halved down to this (new vertices on the old edges)
TRIM_SMOOTH_MM = 3.0   # 片的指示函数在扫描面上扩散的尺度 / length scale over which the indicator of the patch is diffused on the scan
TRIM_LEVEL = 0.25      # 取扩散后的这条等值线为片缘（低于 0.5 = 向外让一点，保住全部细网格）/ the level line taken as rim (below 0.5 = a little outward, keeping all of the fine mesh)
RIM_GAP_MM = 4.0       # 过渡面的底稿在洞内离洞缘留这么宽，由一圈缝合三角形补上 / the draft of the blend surface stays this far inside the rim of the hole; a band of stitch triangles closes it
DATA_WEIGHT = 0.01     # 光顺时拉向扫描面的权重（从片缘到洞缘的前 0.7；到 0.95 处渐减到 0）/ weight of the pull towards the scan in the fairing (the inner 0.7 of the way from patch to hole; fading to 0 at 0.95)
FOLD_LIMIT_DEG = 120.0 # 过渡面及其两条边缘上不许有折过这个角度的边 / no edge of the blend surface or of its two rims may be folded over this
RIGID_FULL_MM = 20.0   # 离扫描片边缘多远起完全跟随骨盆 / distance from the rim of the patch beyond which the pelvis alone is followed


def densify(pts, step):
    """闭合折线加密 / a closed polyline sampled densely"""
    out = []
    for a, b in zip(pts, np.roll(pts, -1, 0)):
        k = max(1, int(np.ceil(np.linalg.norm(b - a) / step)))
        out.append(a + np.outer(np.arange(k) / k, b - a))
    return np.concatenate(out)


def intersecting_pairs(V, F, chunk=400):
    """
    彼此相交、又没有公共顶点的三角形对（用边与三角形求交；共面的重叠查不出）。
    Pairs of triangles that intersect and share no vertex (edge against triangle; coplanar overlaps are not detected).
    """
    T = V[F]
    lo, hi = T.min(1), T.max(1)
    pairs = []
    for s in range(0, len(F), chunk):
        e = min(len(F), s + chunk)
        ov = np.ones((e - s, len(F)), bool)
        for k in range(3):
            ov &= (lo[s:e, k][:, None] <= hi[None, :, k]) & (hi[s:e, k][:, None] >= lo[None, :, k])
        i, j = np.nonzero(ov)
        i = i + s
        m = i < j
        i, j = i[m], j[m]
        share = (F[i][:, :, None] == F[j][:, None, :]).any((1, 2))
        pairs.append(np.stack([i[~share], j[~share]], 1))
    pairs = np.concatenate(pairs)
    hit = np.zeros(len(pairs), bool)
    for a, b in ((0, 1), (1, 0)):
        Ta, Tb = T[pairs[:, a]], T[pairs[:, b]]
        e1, e2 = Tb[:, 1] - Tb[:, 0], Tb[:, 2] - Tb[:, 0]
        for k in range(3):
            o, d = Ta[:, k], Ta[:, (k + 1) % 3] - Ta[:, k]
            h = np.cross(d, e2)
            det = np.einsum('ij,ij->i', e1, h)
            ok = np.abs(det) > 1e-18
            inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
            sv = o - Tb[:, 0]
            u = np.einsum('ij,ij->i', sv, h) * inv
            q = np.cross(sv, e1)
            v = np.einsum('ij,ij->i', d, q) * inv
            t = np.einsum('ij,ij->i', e2, q) * inv
            hit |= ok & (u > 1e-9) & (v > 1e-9) & (u + v < 1 - 1e-9) & (t > 1e-9) & (t < 1 - 1e-9)
    return pairs[hit]




def densify_segments(a, b, step):
    """一组线段加密成点 / a set of segments sampled densely as points"""
    out = []
    for p, q in zip(a, b):
        k = max(1, int(np.ceil(np.linalg.norm(q - p) / step)))
        out.append(p + np.outer(np.arange(k + 1) / k, q - p))
    return np.concatenate(out)


def face_components(F, nv):
    """按公共边连通的三角形块：每个三角形的块号 / pieces of triangles connected through shared edges: the piece of each triangle"""
    _, EF = edge_table(F, nv)
    pr = EF[EF[:, 1] >= 0]
    g = sp.coo_matrix((np.ones(len(pr)), (pr[:, 0], pr[:, 1])), shape=(len(F), len(F)))
    return csgraph.connected_components(g, directed=False)[1]


def directed_loops(faces):
    """一组三角形的全部边界环，各按三角形里的方向排 / every boundary loop of a set of triangles, each in the direction the triangles have it"""
    hm = half_edge_map(faces)
    nxt = {}
    for (a, b) in hm:
        if (b, a) not in hm:
            if a in nxt:
                raise RuntimeError('genital: a boundary is not a simple loop (pinch vertex)')
            nxt[a] = b
    loops, seen = [], set()
    for s in sorted(nxt):
        if s in seen:
            continue
        lp = [s]
        seen.add(s)
        while nxt[lp[-1]] != s:
            lp.append(nxt[lp[-1]])
            seen.add(lp[-1])
        loops.append(lp)
    return loops


def fair(n, tris, P, free, lam, target, rounds=3):
    """
    带数据项的双调和光顺（均匀权），只沿法向挪：free 的顶点 x = P + d·n，取 Σ|L x|² + Σ lam·((target − P)·n − d)² 的最小值；
    其余顶点不动。求和遍及 free 的顶点和它们的邻居，所以在固定的边缘上也是相切地接上。只沿法向挪，是为了不把重新布好的
    网格在切向上拉乱（均匀权会把顶点拉向邻居的重心，边长渐变的网格上小三角形会被翻过去）。target 是一个函数：给出当前位置
    要被拉向的点。反复 rounds 次，每次重新取法线。
    Biharmonic fairing with a data term (uniform weights), moving along the normal only: the `free` vertices are
    x = P + d·n and minimise Σ|L x|² + Σ lam·((target − P)·n − d)²; all others stay. The sum runs over the free vertices
    and their neighbours, so the join is tangential at the fixed rims too. Moving along the normal only keeps the
    re-meshed triangulation from being dragged about tangentially (uniform weights pull every vertex to the centroid
    of its neighbours, which turns small triangles over on a graded mesh). `target` is a function giving the point each
    current position is pulled towards. Repeated `rounds` times, with normals taken anew each time.
    """
    from remesh import vertex_normals
    E, _ = unique_edges(tris, n)
    A = graph(n, E, np.ones(len(E)))
    dg = np.maximum(np.asarray(A.sum(1)).ravel(), 1e-12)
    L = (sp.eye(n) - sp.diags(1.0 / dg) @ A).tocsr()
    used = np.zeros(n, bool)
    used[tris] = True
    isfree = np.zeros(n, bool)
    isfree[free] = True
    rows = np.where(isfree | ((A @ isfree.astype(float) > 0) & used))[0]
    Lr = L[rows]
    Lf = Lr[:, free].tocsr()
    out = P.copy()
    for _ in range(rounds):
        nrm = vertex_normals(out, tris)[free]
        r0 = Lr @ out
        lhs = sp.diags(lam).tocsr()
        rhs = lam * ((target(out[free]) - out[free]) * nrm).sum(1)
        for c in range(3):
            G = Lf @ sp.diags(nrm[:, c])
            lhs = lhs + G.T @ G
            rhs = rhs - G.T @ r0[:, c]
        d = spla.splu((lhs + 1e-12 * sp.eye(len(free))).tocsc()).solve(rhs)
        out[free] = out[free] + d[:, None] * nrm
    return out


def weld_coincident_boundary(V, F):
    """
    供体网格上的“缝”：两排位置完全相同、却没有焊在一起的边界顶点。把位置相同的边界顶点并成一个（不动任何位置）。
    不这样做，按洞去补就会在每条缝上补出一片背靠背、折成 180° 的三角形。返回新的三角形和并掉的顶点数。
    Seams of the donor mesh: two rows of boundary vertices at exactly the same positions that were never welded.
    Boundary vertices at the same position are merged into one (no position changes). Without this, filling them as
    holes puts a fin of back-to-back triangles, folded through 180°, on every seam. Returns the new triangles and the
    number of vertices merged away.
    """
    E, cnt = unique_edges(F, len(V))
    bv = np.unique(E[cnt == 1])
    _, inv = np.unique(V[bv], axis=0, return_inverse=True)
    rep = np.arange(len(V))
    first = {}
    for v, g in zip(bv, np.asarray(inv).ravel()):
        rep[v] = first.setdefault(int(g), int(v))
    Fw = rep[F]
    ok = (Fw[:, 0] != Fw[:, 1]) & (Fw[:, 1] != Fw[:, 2]) & (Fw[:, 0] != Fw[:, 2])
    _, cnt2 = unique_edges(Fw[ok], len(V))
    if cnt2.max() > 2:
        return F, 0  # 焊了反而不是流形：不焊 / welding would break the manifold: leave it
    return Fw[ok], int((rep != np.arange(len(V))).sum())


def tri_area(V, F):
    return 0.5 * np.linalg.norm(np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]), axis=1)


def step_genital(pk, deep, bp3d_dir):
    import igl
    if (pk.manifest.get('fittedTo') or {}).get('body') != 'male':
        raise SystemExit('step genital is for the male body')
    parts = [p for p in (deep or {}).get('parts', []) if p['group'] == 'genitalMale']
    if not parts:
        raise SystemExit('step genital needs the male genital parts in deep-face.json (tools/skinopen/export-deep.ts)')
    part_pts = [np.array(p['positions']).reshape(-1, 3) for p in parts]
    deep_all = np.concatenate(part_pts)
    seeds = np.concatenate([q for p, q in zip(parts, part_pts) if re.search(r'glans|testis|epididymis', p['name'], re.I)])
    seed_tree = cKDTree(seeds)
    DV, DF, rel, licence_line = bp3d_outer_skin(bp3d_dir)
    DF, n_welded = weld_coincident_boundary(DV, DF)
    DF, holes = fill_small_holes(DF)
    n_donor_faces = len(DF) - sum(k - 2 for k in holes)
    nd = len(DV)
    DVc, DFc = np.ascontiguousarray(DV), np.ascontiguousarray(DF)
    V0, F0 = pk.V.copy(), pk.F.copy()
    V, F = pk.V, pk.F
    nv = len(V)
    live = pk.groups['skin'].copy()
    Fl = F[live]
    A, _ = vertex_graph(nv, Fl)
    used = np.zeros(nv, bool)
    used[Fl] = True
    pmsd = lambda P, Vx, Fx: igl.point_mesh_squared_distance(np.ascontiguousarray(P), np.ascontiguousarray(Vx), np.ascontiguousarray(Fx))

    # ── 扫描在生殖器周围的一块（局部网格）和片的“核” / the piece of the scan round the genitalia (a local mesh) and the core of the patch ──
    dused = np.zeros(nd, bool)
    dused[DF] = True
    d_deep_d = cKDTree(deep_all).query(DV)[0]
    Ed, _ = unique_edges(DF, nd)
    Ld = np.linalg.norm(DV[Ed[:, 0]] - DV[Ed[:, 1]], axis=1)
    s_, c_ = np.zeros(nd), np.zeros(nd)
    for k in range(2):
        np.add.at(s_, Ed[:, k], Ld)
        np.add.at(c_, Ed[:, k], 1)
    mean_edge = s_ / np.maximum(c_, 1)
    Ad, _ = vertex_graph(nd, DF)
    ddeg = np.maximum(np.asarray(Ad.sum(1)).ravel(), 1)
    for _ in range(3):
        mean_edge = 0.5 * mean_edge + 0.5 * (Ad @ mean_edge) / ddeg
    loc = dused & (seed_tree.query(DV)[0] < 0.20)
    lf = np.where(loc[DF].all(1))[0]
    # 只留与生殖器连着的那一块（垂在大腿旁的手也在 200 mm 以内，但在这块局部网格里与躯干不相连）
    # only the piece connected to the genitalia is kept (the hands hanging beside the thighs are within 200 mm too, but not connected to the trunk within this local mesh)
    lcomp = face_components(DF[lf], nd)
    lseed = np.argmin(seed_tree.query(DV[DF[lf]].mean(1))[0])
    lf = lf[lcomp == lcomp[lseed]]
    sidx = np.unique(DF[lf])
    smap = -np.ones(nd, np.int64)
    smap[sidx] = np.arange(len(sidx))
    SV, SF = DV[sidx], smap[DF[lf]]
    s_fill = lf >= n_donor_faces
    ns = len(SV)
    As, _ = vertex_graph(ns, SF)
    d_deep_s = d_deep_d[sidx]
    fine_s = (mean_edge[sidx] <= FINE_EDGE_MM * MM) & (d_deep_s < FINE_REACH_MM * MM)
    sel = fine_s | (d_deep_s < CORE_DIST_MM * MM)
    idx = np.where(sel)[0]
    _, lab = csgraph.connected_components(As[idx][:, idx], directed=False)
    seed_s = idx[np.argmin(seed_tree.query(SV[idx])[0])]
    core0 = np.zeros(ns, bool)
    core0[idx[lab == lab[np.where(idx == seed_s)[0][0]]]] = True
    core0 = fill_holes(core0, As, np.ones(ns, bool))

    # ── 1. 拟合皮肤上要换掉的区域 / the region of the fitted skin to replace ──
    dist = np.sqrt(pmsd(V, DV, DF)[0])
    near = used & (seed_tree.query(V)[0] < 0.12)
    near_f = Fl[near[Fl].all(1)]
    sx = intersecting_pairs(V, near_f)
    selfx = np.zeros(nv, bool)
    if len(sx):
        selfx[near_f[sx.ravel()]] = True
    # 拟合皮肤自己折得很厉害的边（两大腿内侧交叉处的皱褶）也算进去，洞缘就不会落在皱褶上
    # edges of the fitted skin that are sharply folded themselves (the crumple where the inner thighs cross) count too, so that the rim of the hole does not land on a crumple
    fe, _, _ = folded_edges(V, near_f, CREASE_DEG)
    creased = np.zeros(nv, bool)
    creased[fe] = True
    cand = near & ((dist > DIFFER_MM * MM) | selfx | creased)
    idx = np.where(cand)[0]
    _, lab = csgraph.connected_components(A[idx][:, idx], directed=False)
    seed_v = idx[np.argmin(seed_tree.query(V[idx])[0])]
    want = set([int(lab[np.where(idx == seed_v)[0][0]])]) | set(int(l) for l in lab[(selfx | creased)[idx]])
    R0 = np.zeros(nv, bool)
    R0[idx[np.isin(lab, sorted(want))]] = True
    R = single_loop_region(fill_holes(grow(R0, A, GROW_RINGS) & used, A, used), Fl, A, 'skin')
    cut = live & R[F].all(1)
    rimA = np.array(ordered_loop(F[cut])[::-1])
    rim_tree = cKDTree(densify(V[rimA], 0.0005))
    cut_live = cut[live]
    inner = R & ~np.isin(np.arange(nv), np.unique(F[live & ~cut]))  # 不再被剩余皮肤用到的顶点 / vertices the remaining skin no longer uses
    # 片的核只取洞内、离洞缘至少 MIN_BAND_MM 的部分：会阴缝的细网格一直伸到拟合皮肤本来就与扫描吻合的地方，
    # 那一段留给拟合皮肤（留下多少、与拟合皮肤相差多少都写进报告）。
    # The core of the patch is limited to what lies inside the hole and at least MIN_BAND_MM from its rim: the fine mesh
    # of the perineal raphe runs on to where the fitted skin agrees with the scan anyway, and that stretch is left to the
    # fitted skin (how much is left, and how far it is from the fitted skin, goes into the report).
    s_d2, s_fi, _ = pmsd(SV, V, Fl)
    core = core0 & cut_live[s_fi] & (rim_tree.query(SV)[0] >= MIN_BAND_MM * MM)
    idx = np.where(core)[0]
    _, lab = csgraph.connected_components(As[idx][:, idx], directed=False)
    core = np.zeros(ns, bool)
    core[idx[lab == lab[np.where(idx == seed_s)[0][0]]]] = True
    core = fill_holes(core, As, np.ones(ns, bool))
    core_f = core[SF].all(1)
    if not core_f.any():
        raise RuntimeError('genital: no finely meshed scan surface found round the deep genital parts inside the region to replace')
    # 只留按公共边连成一片的那一块三角形（只靠一个顶点或一条边挂着的零星三角形不算）
    # only the piece of triangles connected through shared edges is kept (stray triangles hanging by a vertex or an edge do not count)
    cfi = np.where(core_f)[0]
    ccomp = face_components(SF[cfi], ns)
    cseed = np.argmin(seed_tree.query(SV[SF[cfi]].mean(1))[0])
    core_f[cfi[ccomp != ccomp[cseed]]] = False
    core = np.zeros(ns, bool)
    core[SF[core_f]] = True
    left_out = core0 & ~core

    # ── 2. 扫描片：沿光滑的等值线切出来 / the scanned patch, cut out along a smooth level line ──
    Ec, EFc = edge_table(SF[core_f], ns)
    cb = Ec[EFc[:, 1] < 0]
    cb_tree = cKDTree(densify_segments(SV[cb[:, 0]], SV[cb[:, 1]], 0.001))

    def h_refine(P):
        h = np.full(len(P), 1e9)
        h[cb_tree.query(P)[0] < 4 * TRIM_SMOOTH_MM * MM] = REFINE_MM * MM
        h[np.abs(rim_tree.query(P)[0] - RIM_GAP_MM * MM) < 3 * REFINE_MM * MM] = REFINE_MM * MM
        return h

    SV2, SF2, _, par = split_long_edges(SV, SF, h_refine)
    core_f2, fill2 = core_f[par], s_fill[par]
    n2 = len(SV2)
    ar2 = tri_area(SV2, SF2)
    Mv, chi = np.full(n2, 1e-14), np.zeros(n2)
    for k in range(3):
        np.add.at(Mv, SF2[:, k], ar2 / 3)
        np.add.at(chi, SF2[:, k], np.where(core_f2, ar2 / 3, 0.0))
    chi /= Mv
    Lc = igl.cotmatrix(np.ascontiguousarray(SV2), np.ascontiguousarray(SF2)).tocoo()
    off = Lc.row != Lc.col
    wv = np.clip(np.nan_to_num(Lc.data[off], nan=0.0, posinf=20.0, neginf=0.0), 0.02, 20.0)  # 钝角、退化三角形的余切权夹住 / cotangent weights of obtuse and degenerate triangles are clamped
    Wc = sp.coo_matrix((wv, (Lc.row[off], Lc.col[off])), shape=(n2, n2)).tocsr()
    Wc = 0.5 * (Wc + Wc.T)
    Lp = sp.diags(np.asarray(Wc.sum(1)).ravel()) - Wc
    fld = spla.splu((sp.diags(Mv) + (TRIM_SMOOTH_MM * MM) ** 2 * Lp).tocsc()).solve(Mv * chi)
    core2 = np.r_[core, np.zeros(n2 - ns, bool)]
    fld[core2] = np.maximum(fld[core2], TRIM_LEVEL + 0.02)  # 核上的顶点一个不丢 / no vertex of the core is lost
    V3, Fp, Fn, born3, pp, pn = cut_by_level(SV2, SF2, fld - TRIM_LEVEL)
    n3 = len(V3)
    lp_, ln_ = face_components(Fp, n3), face_components(Fn, n3)
    seed3 = int(np.where(core)[0][np.argmin(seed_tree.query(SV[core])[0])])
    main = lp_[np.where((Fp == seed3).any(1))[0][0]]
    isl = islands(Fp[lp_ == main], Fn, ln_, n3)  # 片内被等值线圈出来的小岛并回片里 / islets the level line encloses inside the patch are returned to it
    patch_f = np.vstack([Fp[lp_ == main], Fn[isl]])
    patch_fill = np.r_[fill2[pp][lp_ == main], fill2[pn][isl]]
    rest_f = np.vstack([Fn[~isl], Fp[lp_ != main]])
    LB = ordered_loop(patch_f)  # 片缘，沿片上三角形的方向 / the rim of the patch, in the direction of its triangles
    pvx = np.unique(patch_f)
    in_patch = np.zeros(n3, bool)
    in_patch[pvx] = True
    core_fv = np.zeros(ns, bool)
    core_fv[SF[core_f]] = True  # 核上有三角形的顶点 / core vertices that carry core triangles
    core_lost = int((core_fv & ~in_patch[:ns]).sum())

    # ── 3. 过渡面的底稿：扫描面上从片缘到洞缘以内 RIM_GAP_MM 的一带 / the draft of the blend surface: the scan from the rim of the patch to RIM_GAP_MM inside the rim of the hole ──
    rv = np.unique(rest_f)
    inside = cut_live[pmsd(V3[rv], V, Fl)[1]]
    dr = rim_tree.query(V3[rv])[0]
    sfield = np.full(n3, -1.0)
    sfield[rv] = np.where(inside, dr, -dr) - RIM_GAP_MM * MM
    sfield[LB] = np.maximum(sfield[LB], 1e-6)  # 片缘本身在带内 / the rim of the patch itself is inside the zone
    V4, Ap, An, born4, _, _ = cut_by_level(V3, rest_f, sfield, snap=0.2)
    n4 = len(V4)
    la_, lb_ = face_components(Ap, n4), face_components(An, n4)
    on_rim = np.zeros(n4, bool)
    on_rim[LB] = True
    touching = np.unique(la_[on_rim[Ap].any(1)])
    # 与片缘有公共边的那一块 / the piece that shares edges with the rim of the patch
    rim_edges = set((min(a, b), max(a, b)) for a, b in zip(LB, LB[1:] + LB[:1]))
    edge_piece = set()
    for fi_, t in enumerate(Ap):
        if on_rim[t].sum() >= 2 and any((min(int(t[c]), int(t[(c + 1) % 3])), max(int(t[c]), int(t[(c + 1) % 3]))) in rim_edges for c in range(3)):
            edge_piece.add(int(la_[fi_]))
    if len(edge_piece) != 1:
        raise RuntimeError('genital: the scan between the patch and the rim of the hole is not one piece (%d pieces share edges with the rim of the patch; %d touch it)' % (len(edge_piece), len(touching)))
    piece = edge_piece.pop()
    ann_f = np.vstack([Ap[la_ == piece], An[islands(Ap[la_ == piece], An, lb_, n4)]])
    loops = directed_loops(ann_f)
    setB = set(LB)
    outer = [lp for lp in loops if not (set(lp) <= setB)]
    if len(loops) != 2 or len(outer) != 1:
        raise RuntimeError('genital: the draft of the blend surface is not an annulus (%d boundary loops)' % len(loops))
    LO = outer[0][::-1]  # 逆着底稿三角形的方向 / against the triangles of the draft

    # ── 4. 缝上洞缘，重新布网 / stitched to the rim of the hole and re-meshed ──
    av = np.unique(ann_f)
    nr = len(rimA)
    amap = -np.ones(n4, np.int64)
    amap[av] = nr + np.arange(len(av))
    Wv = np.vstack([V[rimA], V4[av]])
    band_f = zipper_by_parameter(Wv, list(range(nr)), [int(v) for v in amap[LO]])
    Wf = np.vstack([amap[ann_f], band_f])
    fixed_w = np.zeros(len(Wv), bool)
    fixed_w[:nr] = True
    fixed_w[amap[LB]] = True
    pr_tree = cKDTree(densify(V4[LB], 0.0005))
    lb_len = np.linalg.norm(V4[LB] - V4[LB[1:] + LB[:1]], axis=1)
    ra_len = np.linalg.norm(V[rimA] - V[np.roll(rimA, -1)], axis=1)
    h_in = float(np.clip(np.median(lb_len), 2 * MM, 4 * MM))
    h_out = float(np.median(ra_len))

    def u_of(P):
        di, do = pr_tree.query(P)[0], rim_tree.query(P)[0]
        return di / np.maximum(di + do, 1e-9)

    hfun = lambda P: h_in + (h_out - h_in) * u_of(P)
    Wv0, Wf0 = np.ascontiguousarray(Wv), np.ascontiguousarray(Wf)
    Wv2, Wf2, origin = remesh(Wv, Wf, hfun, fixed_w, lambda P: pmsd(P, Wv0, Wf0)[2], rounds=6)

    # 新顶点的编号：过渡面、扫描片 / numbering of the new vertices: blend surface, patch
    pl = -np.ones(n4, np.int64)
    npv = len(pvx)
    is_blend = np.ones(len(Wv2), bool)
    gmap = np.zeros(len(Wv2), np.int64)
    o_fit = (origin >= 0) & (origin < nr)
    gmap[o_fit] = rimA[origin[o_fit]]
    is_blend[o_fit] = False
    o_scan = origin >= nr
    v4_of = np.where(o_scan, av[np.maximum(origin - nr, 0)], -1)
    o_patch = o_scan & in_patch_ext(in_patch, v4_of)
    is_blend[o_patch] = False
    nb = int(is_blend.sum())
    id_b = np.arange(nv, nv + nb)
    id_p = np.arange(nv + nb, nv + nb + npv)
    pl[pvx] = id_p
    gmap[is_blend] = id_b
    gmap[o_patch] = pl[v4_of[o_patch]]
    Vall = np.vstack([V, Wv2[is_blend], V4[pvx]])
    blend_faces = gmap[Wf2]
    patch_faces = pl[patch_f]
    rim_patch = pl[np.array(LB)]

    # ── 5. 光顺：与扫描片和周围皮肤相切，中间松松地跟着扫描面 / fairing: tangent to patch and skin, loosely following the scan in between ──
    around = grow(R, A, 3)
    keep_ring = Fl[around[Fl].all(1) & ~cut_live]
    solve_tris = np.vstack([keep_ring, blend_faces, patch_faces])
    before = Vall[id_b].copy()
    u_b = u_of(before)
    x_ = np.clip((u_b - 0.7) / 0.25, 0, 1)
    lam_b = DATA_WEIGHT * (1 - x_ * x_ * (3 - 2 * x_))
    Vall = fair(len(Vall), solve_tris, Vall, id_b, lam_b, lambda P: pmsd(P, V3, rest_f)[2])
    solved = Vall[id_b].copy()
    # 解出的过渡面若与别的面相交：有关的顶点（及其邻居）朝底稿上的位置退回一半，反复几次。扫描顶点不动。
    # where the faired blend surface cuts anything, the vertices concerned (and their neighbours) are taken halfway back
    # towards their position on the draft, repeatedly. Scanned vertices do not move.
    lam = np.ones(nb)
    slot = -np.ones(len(Vall), np.int64)
    slot[id_b] = np.arange(nb)
    Ef, _ = unique_edges(blend_faces, len(Vall))
    Ef = Ef[(slot[Ef] >= 0).all(1)]
    Af = graph(nb, slot[Ef], np.ones(len(Ef)))
    near_skin = cKDTree(Vall[nv:]).query(V)[0] < 0.04
    nb_f = Fl[near_skin[Fl].any(1) & ~cut_live]
    test_f = np.vstack([patch_faces, blend_faces, nb_f])
    n_scan = len(patch_faces)
    backed_off = 0
    for _ in range(8):
        pr = intersecting_pairs(Vall, test_f)
        pr = pr[(pr >= n_scan).any(1)] if len(pr) else pr
        if not len(pr):
            break
        bad = np.zeros(nb, bool)
        sl = slot[test_f[pr.ravel()]].ravel()
        bad[sl[sl >= 0]] = True
        bad = bad | (Af @ bad.astype(float) > 0)
        if not bad.any():
            break
        lam[bad] *= 0.5
        backed_off = int((lam < 1).sum())
        Vall[id_b] = before + lam[:, None] * (solved - before)
    # ── 6. 写进包里 / into the package ──
    new_ids = np.r_[id_b, id_p]
    sub = np.vstack([blend_faces, patch_faces])
    Es, _ = unique_edges(sub, len(Vall))
    Ls = np.linalg.norm(Vall[Es[:, 0]] - Vall[Es[:, 1]], axis=1)
    M = np.clip(harmonic_extension(len(Vall), Es, Ls, rimA, new_ids), 0, None)
    M /= M.sum(1, keepdims=True)
    scan_vertex = pvx < ns  # 片上原有的扫描顶点；其余是切、分时落在扫描的边上的点 / patch vertices that are scan vertices; the others are points put on edges of the scan by cutting and halving
    tagv = np.r_[np.full(nb, TAGS['graftConstruction']), np.where(scan_vertex, TAGS['graftScanned'], TAGS['graftBlend'])]
    got = pk.extend(Vall[nv:], rimA, M, tagv, rimA[np.argmax(M, axis=1)])
    assert np.array_equal(got, new_ids)
    # 扫描片跟随骨盆：离片缘 RIGID_FULL_MM 起完全跟随 / the patch follows the pelvis, entirely from RIGID_FULL_MM off its rim
    pelvis = pk.joint('pelvis')
    Gp, _ = vertex_graph(len(Vall), patch_faces, Vall)
    geo = csgraph.dijkstra(Gp, indices=rim_patch, min_only=True)[id_p]
    g = np.clip(geo / (RIGID_FULL_MM * MM), 0, 1)
    g = g * g * (3 - 2 * g)
    Wp = pk.W[id_p].toarray() * (1 - g)[:, None]
    Wp[:, pelvis] += g
    pk.W = sp.vstack([pk.W[:id_p[0]], sp.csr_matrix(Wp)]).tocsr()
    nf_old = len(F)
    pk.F = np.vstack([F, patch_faces, blend_faces])
    for gname in list(pk.groups):
        pk.groups[gname] = np.r_[pk.groups[gname], np.zeros(len(pk.F) - nf_old, bool)]
    pk.groups['skin'][:nf_old] &= ~cut
    o = nf_old
    for gname, cnt in (('genitalSkin', len(patch_faces)), ('genitalSkinBase', len(blend_faces))):
        m = np.zeros(len(pk.F), bool)
        m[o:o + cnt] = True
        pk.groups[gname] = m
        o += cnt
    # 被切掉的原顶点并到洞口环上最近的顶点（见 graft.py）/ the delivered vertices cut away are collapsed onto the nearest rim vertex (see graft.py)
    rem = np.where(inner)[0]
    tgt = rimA[cKDTree(V0[rimA]).query(V0[rem])[1]]
    pk.tags[rem] = TAGS['removed']
    pk.V[rem] = pk.V[tgt]
    Wl = pk.W.tolil()
    Wl[rem] = pk.W[tgt]
    pk.W = Wl.tocsr()
    for fname in pk.fields:
        pk.fields[fname][0][rem] = pk.fields[fname][0][tgt]
    pk.src[rem] = pk.src[tgt]
    pk.collapsed.update({int(a_): int(b_) for a_, b_ in zip(rem, tgt)})

    # ── 7. 核对 / checks ──
    r2 = lambda x: round(float(x) / MM, 2)
    stat3 = lambda x: {'median': r2(np.median(x)), 'p95': r2(np.percentile(x, 95)), 'max': r2(np.max(x))}
    allf = np.zeros(len(pk.F), bool)
    for gm in pk.groups.values():
        allf |= gm
    Vn, Fn_ = np.ascontiguousarray(pk.V), np.ascontiguousarray(pk.F[allf])
    skin_f = pk.F[pk.groups['skin']]
    # 自相交：全部新三角形，加上附近 40 mm 以内的原皮肤三角形（含大腿）
    # self-intersection: every new triangle plus the delivered skin triangles within 40 mm of them (thighs included)
    kind = np.r_[np.zeros(len(patch_faces), int), np.ones(len(blend_faces), int), np.full(len(nb_f), 2)]
    pairs = intersecting_pairs(pk.V, test_f)
    kp = np.sort(kind[pairs], axis=1) if len(pairs) else np.zeros((0, 2), int)
    names = ['scanned patch', 'blend surface', 'delivered skin']
    by_kind = {}
    for a_, b_ in kp:
        key = '%s / %s' % (names[a_], names[b_])
        by_kind[key] = by_kind.get(key, 0) + 1
    scan_scan = int(((kp[:, 0] == 0) & (kp[:, 1] == 0)).sum())
    other = int(len(kp) - scan_scan)
    donor_pairs = intersecting_pairs(V4, patch_f)  # 扫描自身的相交，接入之前就有 / intersections of the scan with itself, there before any grafting
    # 折角：过渡面内部、它与扫描片的交界（片缘）、它与拟合皮肤的交界（洞缘）
    # fold angles: inside the blend surface, where it meets the patch (rim of the patch) and where it meets the fitted skin (rim of the hole)
    ff = np.vstack([blend_faces, patch_faces, keep_ring])
    Ee, EFe = edge_table(ff, len(pk.V))
    fn = np.cross(pk.V[ff[:, 1]] - pk.V[ff[:, 0]], pk.V[ff[:, 2]] - pk.V[ff[:, 0]])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-30)
    in_ = EFe[:, 1] >= 0
    ang = np.degrees(np.arccos(np.clip((fn[EFe[in_, 0]] * fn[EFe[in_, 1]]).sum(1), -1, 1)))
    ek = np.sort(np.where(EFe[in_] < len(blend_faces), 0, np.where(EFe[in_] < len(blend_faces) + len(patch_faces), 1, 2)), axis=1)
    folds, worst_fold = {}, 0.0
    for a_, b_, nm in ((0, 0, 'insideTheBlendSurface'), (0, 1, 'atTheRimOfThePatch'), (0, 2, 'atTheRimOfTheHole'), (1, 1, 'insideTheScannedPatch')):
        m = (ek[:, 0] == a_) & (ek[:, 1] == b_)
        folds[nm] = {'edges': int(m.sum()), 'medianDeg': round(float(np.median(ang[m])), 1), 'p95Deg': round(float(np.percentile(ang[m], 95)), 1), 'maxDeg': round(float(ang[m].max()), 1),
                     'over%gDeg' % FOLD_LIMIT_DEG: int((ang[m] > FOLD_LIMIT_DEG).sum()), 'over60Deg': int((ang[m] > 60).sum())}
        if a_ == 0:
            worst_fold = max(worst_fold, float(ang[m].max()))
    # 过渡面的边长与当地的目标边长 / edge lengths of the blend surface against the local target
    Eb_, EFb = edge_table(blend_faces, len(pk.V))
    on_hole = np.isin(Eb_, rimA).all(1) & (EFb[:, 1] < 0)
    bl = np.linalg.norm(pk.V[Eb_[:, 0]] - pk.V[Eb_[:, 1]], axis=1)
    ratio = bl / hfun(0.5 * (pk.V[Eb_[:, 0]] + pk.V[Eb_[:, 1]]))
    touch_hole = np.isin(Eb_, rimA).any(1) & ~on_hole
    # 扫描片离大腿（剩余的原皮肤）有多远 / how far the scanned patch stays from the thighs (remaining delivered skin)
    far = id_p[geo > 0.015]
    d_th = np.sqrt(pmsd(pk.V[far], Vn, skin_f)[0])
    kth = int(np.argmin(d_th))
    cover, worse = {}, []
    for p, Q in zip(parts, part_pts):
        Q = np.ascontiguousarray(Q)
        row = {}
        for label, (Vx, Fx) in (('donor', (DVc, DFc)), ('delivered', (np.ascontiguousarray(V0), np.ascontiguousarray(F0))), ('grafted', (Vn, Fn_))):
            s = igl.signed_distance(Q, Vx, Fx)[0]
            row[label] = {'leastCoverMm': round(float(-s.max()) / MM, 2), 'medianCoverMm': round(float(-np.median(s)) / MM, 2), 'shareOutside': round(float((s > 0).mean()), 4)}
        cover['%s (%s)' % (p['name'], p['id'])] = row
        if row['grafted']['leastCoverMm'] < row['donor']['leastCoverMm'] - 0.005:
            worse.append('%s: %.2f mm under the grafted skin, %.2f mm under the scan' % (p['name'], row['grafted']['leastCoverMm'], row['donor']['leastCoverMm']))
    Ep, _ = unique_edges(patch_f, n4)
    pl_ = np.linalg.norm(V4[Ep[:, 0]] - V4[Ep[:, 1]], axis=1)
    d_scan_b = np.sqrt(pmsd(pk.V[id_b], DV, DF)[0])
    moved_b = np.linalg.norm(pk.V[id_b] - before, axis=1)
    d_edge_pts = np.sqrt(pmsd(V4[pvx][~scan_vertex], DV, DF)[0]) if (~scan_vertex).any() else np.zeros(1)
    a_patch, a_blend = tri_area(V4, patch_f), tri_area(pk.V, blend_faces)
    d_rim_deep = cKDTree(deep_all).query(V[rimA])[0]
    d_rim_patch = pr_tree.query(V[rimA])[0]
    lo_dist = np.sqrt(pmsd(SV[left_out], Vn, Fn_)[0]) if left_out.any() else np.zeros(1)  # 到移植后的皮肤 / to the grafted skin
    fine_in_hole = fine_s & core0 & cut_live[s_fi] & (rim_tree.query(SV)[0] >= MIN_BAND_MM * MM)
    fine_out = fine_in_hole & ~in_patch[:ns]
    fo_dist = np.sqrt(pmsd(SV[fine_out], Vn, Fn_)[0]) if fine_out.any() else np.zeros(1)
    checks = {
        'scannedVerticesExactlyWhereTheScanHasThem': bool(np.abs(pk.V[id_p][scan_vertex] - DV[sidx[pvx[scan_vertex]]]).max() == 0),
        'edgePointsOfThePatchLieOnTheScan': bool(d_edge_pts.max() < 1e-7),
        'everyCoreScanVertexIsInThePatch': core_lost == 0,
        'noEdgeFoldedOver%gDegInTheBlendSurfaceOrAtItsRims' % FOLD_LIMIT_DEG: bool(worst_fold <= FOLD_LIMIT_DEG),
        'blendEdgesAtMostTwiceTheLocalEdge': bool(ratio[~on_hole].max() <= 2.0),
        'noIntersectionInvolvingBlendSurfaceOrDeliveredSkin': other == 0,
        'coverOverEveryGenitalPartNoLessThanUnderTheScan': not worse,
        'patchDoesNotTouchTheThighs': bool(d_th.min() > 2 * MM),
    }
    stats = {
        'rules': {
            'replacedRegion': 'fitted-skin vertices within 120 mm of glans, testes and epididymides that are more than %g mm from the scan, or lie on fitted-skin triangles intersecting each other, or on fitted-skin edges folded over %g degrees; the pieces of these that contain the vertex nearest the deep parts or any self-intersecting or creased vertex; grown by %d ring(s), holes filled' % (DIFFER_MM, CREASE_DEG, GROW_RINGS),
            'scannedPatch': 'core = scan vertices whose smoothed mean incident edge is at most %g mm within %g mm of a deep genital part, together with scan vertices within %g mm of one; the connected piece round glans and testes, holes filled; limited to what lies inside the replaced region and at least %g mm from its rim. Scan edges within %g mm of the border of the core are halved down to %g mm (new points on the old edges); the indicator of the core is diffused over the scan surface (length scale %g mm) and the patch is cut along its level line %g (triangles are cut in their own plane; core vertices are kept inside)' % (FINE_EDGE_MM, FINE_REACH_MM, CORE_DIST_MM, MIN_BAND_MM, 4 * TRIM_SMOOTH_MM, REFINE_MM, TRIM_SMOOTH_MM, TRIM_LEVEL),
            'blendSurface': 'draft = the scan surface between the rim of the patch and the line %g mm inside the rim of the hole (cut along that line), joined to the rim of the hole by a band of triangles; re-meshed (split, collapse, flip, tangential relaxation, 6 rounds) to an edge length rising linearly from %.2f mm at the patch to %.2f mm (the median edge of the rim of the hole) at the fitted skin; then faired: displacement along the normal minimising the uniform-weight bi-Laplacian energy over the blend vertices and their neighbours (scanned patch and three rings of fitted skin fixed), with a pull towards the scan surface of weight %g over the inner 0.7 of the way to the fitted skin, fading to 0 at 0.95' % (RIM_GAP_MM, h_in / MM, h_out / MM, DATA_WEIGHT),
        },
        'replacedRegion': {'removedTriangles': int(cut.sum()), 'removedVertices': int(inner.sum()), 'rimOfHoleVertices': int(len(rimA)),
                           'selfIntersectingTrianglePairsOfTheDeliveredSkinThere': int(len(sx)), 'creasedEdgesOfTheDeliveredSkinThere': int(len(fe)),
                           'extent': {'min': [round(float(v), 3) for v in V0[R].min(0)], 'max': [round(float(v), 3) for v in V0[R].max(0)]},
                           'rimOfHole': {'what': 'where the outer ring cut from the fitted skin lies', 'distanceFromDeepPartsMm': {'min': r2(d_rim_deep.min()), 'median': r2(np.median(d_rim_deep)), 'max': r2(d_rim_deep.max())},
                                         'distanceFromRimOfPatchMm': {'min': r2(d_rim_patch.min()), 'median': r2(np.median(d_rim_patch)), 'max': r2(d_rim_patch.max())},
                                         'fittedSkinFromScanThereMm': stat3(dist[rimA]), 'edgeMm': stat3(ra_len)}},
        'scannedPatch': {'scanVertices': int(scan_vertex.sum()), 'pointsOnScanEdges': int((~scan_vertex).sum()), 'triangles': int(len(patch_f)), 'areaMm2': round(float(a_patch.sum()) / MM ** 2, 1),
                         'rimVertices': int(len(LB)), 'rimEdgeMm': stat3(lb_len), 'edgeMm': stat3(pl_),
                         'seamVerticesOfTheDonorWelded': n_welded, 'donorHoleFillTriangles': int(patch_fill.sum()), 'donorHoleFillAreaMm2': round(float(a_patch[patch_fill].sum()) / MM ** 2, 2),
                         'coreScanVerticesNotInThePatch': core_lost, 'fineScanVerticesInsideTheReplacedRegion': int(fine_in_hole.sum()), 'ofThoseNotInThePatch': {'vertices': int(fine_out.sum()), 'what': 'stray fine triangles not connected to the patch through shared edges; their distance from the grafted skin', 'distanceFromGraftedSkinMm': stat3(fo_dist)},
                         'coreLeftOut': {'what': 'scan vertices of the core lying outside the replaced region or within %g mm of its rim (the perineal raphe running back towards the anus, and scan surface close to deep parts elsewhere): there the fitted skin or the blend surface stands; their distance from the grafted skin. The largest distances are behind the replaced region, in the cleft between the buttocks, where the fitted skin lies below the scan; that is outside this step' % MIN_BAND_MM,
                                         'vertices': int(left_out.sum()), 'fineAmongThem': int((left_out & fine_s).sum()), 'distanceFromGraftedSkinMm': stat3(lo_dist), 'within2MmOfTheGraftedSkin': int((lo_dist < 2 * MM).sum())}},
        'blendSurface': {'vertices': int(nb), 'triangles': int(len(blend_faces)), 'areaMm2': round(float(a_blend.sum()) / MM ** 2, 1), 'draftTriangles': int(len(ann_f)), 'bandTriangles': int(len(band_f)),
                         'edgeMm': stat3(bl[~on_hole]), 'targetEdgeMm': {'atThePatch': r2(h_in), 'atTheFittedSkin': r2(h_out)},
                         'edgeOverLocalTarget': {'median': round(float(np.median(ratio[~on_hole])), 2), 'max': round(float(ratio[~on_hole].max()), 2), 'limit': 2.0},
                         'edgesToTheRimOfTheHoleMm': stat3(bl[touch_hole]),
                         'distanceFromTheScanMm': dict(stat3(d_scan_b), innerHalf=stat3(d_scan_b[u_b < 0.5]) if (u_b < 0.5).any() else None),
                         'movedByTheFairingMm': stat3(moved_b), 'verticesTakenBackTowardsTheDraftToClearIntersections': backed_off},
        'areas': {'what': 'what is real scanned skin and what is construction, by area', 'scannedSkinMm2': round(float(a_patch[~patch_fill].sum()) / MM ** 2, 1),
                  'constructionMm2': round(float(a_blend.sum() + a_patch[patch_fill].sum()) / MM ** 2, 1), 'deliveredSkinRemovedMm2': round(float(tri_area(V0, F0[cut]).sum()) / MM ** 2, 1)},
        'foldAngles': folds,
        'selfIntersection': {'what': 'pairs of intersecting triangles without a common vertex among the new triangles and the delivered skin within 40 mm of them (thighs included)', 'trianglesTested': int(len(test_f)), 'pairsByKind': by_kind,
                             'scanAgainstScan': scan_scan, 'scanAgainstScanInTheDonorAsItIs': int(len(donor_pairs)), 'involvingBlendSurfaceOrDeliveredSkin': other,
                             'note': 'pairs of the scan with itself are in the scanned data (penis lying against the scrotum) and are not repaired: scanned vertices do not move'},
        'thighGap': {'what': 'closest approach of scanned patch vertices more than 15 mm from the rim of the patch to the remaining delivered skin', 'leastMm': r2(d_th.min()), 'at': [round(float(v), 4) for v in pk.V[far[kth]]],
                     'shareWithin5Mm': round(float((d_th < 5 * MM).mean()), 4)},
        'rigid': {'joint': pk.joints['names'][pelvis], 'verticesFullyRigid': int((g >= 1).sum()), 'verticesBlended': int(((g > 0) & (g < 1)).sum())},
        'coverOverGenitalParts': cover,
        'checks': checks,
    }
    pk.report['genital'] = stats
    if os.environ.get('SKINOPEN_DEBUG'):
        # 调试用（平时不设这个环境变量）/ for debugging (leave the variable unset otherwise)
        np.savez(os.path.join(os.environ['SKINOPEN_DEBUG'], 'genital-debug.npz'), Vall=pk.V, blend_faces=blend_faces, patch_faces=patch_faces, keep_ring=keep_ring, rimA=rimA, rim_patch=rim_patch,
                 V=V0, Fl=Fl, cut_live=cut_live, deep_all=deep_all, before=before, id_b=id_b, draft_v=Wv0, draft_f=Wf0, left_out=SV[left_out], left_out_dist=lo_dist)
    bad = [k for k, v in checks.items() if not v]
    if bad:
        raise RuntimeError('genital: failed checks: %s%s; intersecting pairs by kind: %s; worst fold %.1f deg; edge over target max %.2f; core vertices lost %d' % (', '.join(bad), ('; ' + '; '.join(worse)) if worse else '', by_kind, worst_fold, ratio[~on_hole].max(), core_lost))
    jn = pk.joints['names'][pelvis]
    edge_pts = [int(v) for v in id_p[~scan_vertex]]
    pk.grafts.append({
        'name': 'genitalSkin', 'provenance': 'scanned',
        'patchVertices': [int(v) for v in id_p[scan_vertex]], 'blendRingVertices': edge_pts, 'constructionVertices': [int(v) for v in id_b],
        'rimOfHole': [int(v) for v in rimA], 'rimOfPatch': [int(v) for v in rim_patch], 'removedVertices': [int(v) for v in rem],
        'what': {'zh': '男性外生殖器的皮肤。patchVertices：阴茎、阴囊、阴囊颈和会阴缝，取自他本人的扫描皮肤（BodyParts3D 4.0 的 FJ2810 外壁），位置一个也没有动（标签 graftScanned）。blendRingVertices：把扫描片沿一条光滑的线切出来、以及切之前把扫描的长边对半分时，落在扫描三角形的边上的点（标签 graftBlend）；它们在扫描面上，但不是扫描的顶点。constructionVertices：扫描片边缘与拟合皮肤之间的过渡面（耻区、腹股沟、会阴和两大腿内侧上部），是构造物，不是扫描数据，也不是解剖（标签 graftConstruction）：以扫描在这一带的粗网格面为底稿，重新布网后光顺而成，与扫描片和周围的拟合皮肤相切。',
                 'en': 'The skin of the male external genitalia. patchVertices: penis, scrotum, scrotal neck and perineal raphe from his own scanned skin (outer wall of FJ2810 of BodyParts3D 4.0), not one position changed (tag graftScanned). blendRingVertices: points put on edges of scan triangles when the patch was cut out along a smooth line and when long scan edges were halved before that (tag graftBlend); they lie on the scanned surface but are not vertices of the scan. constructionVertices: the blend surface between the rim of the patch and the fitted skin (pubic region, groins, perineum and the upper inner thighs); it is construction, neither scanned data nor anatomy (tag graftConstruction): the coarse scan surface of that zone served as a draft, which was re-meshed and faired, tangent to the patch and to the fitted skin round it.'},
        'source': {'name': 'BodyParts3D 4.0', 'file': rel, 'url': 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html', 'licenceLineInFile': licence_line, 'licenceNote': BP3D_LICENCE_NOTE, 'frame': '(x, z, −y) mm → m'},
        'weights': {'zh': '权重从洞口环（rimOfHole）调和延拓到全部新顶点；扫描片再从它的边缘起逐渐、%g mm 以外完全跟随骨盆（关节 %s）。阴茎和阴囊因此随骨盆刚性运动，不下垂、不摆动、不随大腿让开。' % (RIGID_FULL_MM, jn),
                    'en': 'Weights are a harmonic extension from the rim of the hole (rimOfHole) over every new vertex; the scanned patch then turns, from its rim and entirely beyond %g mm, to the pelvis (joint %s). Penis and scrotum therefore move rigidly with the pelvis: they do not hang, swing or give way to the thighs.' % (RIGID_FULL_MM, jn)},
        'fields': {'zh': '体型场（shape-*.f32 等）同样从洞口环调和延拓。', 'en': 'Shape fields (shape-*.f32 and the others) are extended harmonically from the rim likewise.'},
    })
    # 检查图。genitalSkin.png：正面、下面、两张斜向、前下方近景；上排按分组着色，中排单一肤色，下排原皮肤。
    # genitalPerineum.png：只画移植的部分（扫描片和过渡面），从后下方、后方、两侧和正下方看会阴；下排是同样的视角、单一肤色。
    # Check renders. genitalSkin.png: front, below, two oblique views, a close-up from front and below; grafted coloured by
    # group above, in one colour in the middle, the delivered skin below. genitalPerineum.png: the graft alone (patch and
    # blend surface), the perineum seen from behind and below, from behind, from both sides and from straight below;
    # the lower row has the same views in one colour.
    c = [round(float(v), 4) for v in (0.5 * (DV[sidx[pvx[scan_vertex]]].min(0) + DV[sidx[pvx[scan_vertex]]].max(0)))]
    skin_c, patch_c, blend_c = [226, 178, 156], [200, 140, 125], [150, 200, 150]
    items = [{'obj': 'skin.obj', 'color': skin_c, 'groups': ['skin']}, {'obj': 'skin.obj', 'color': patch_c, 'groups': ['genitalSkin']}, {'obj': 'skin.obj', 'color': blend_c, 'groups': ['genitalSkinBase']},
             {'obj': 'skin.obj', 'color': skin_c}, {'obj': 'skin-delivered.obj', 'color': skin_c}, {'obj': 'skin.obj', 'color': skin_c, 'groups': ['genitalSkin', 'genitalSkinBase']}]
    cams = [(0, 0, 0.11), (0, -80, 0.11), (35, -25, 0.085), (-35, -25, 0.085), (0, -45, 0.07)]
    views = [{'yaw': y, 'pitch': p, 'center': c, 'halfHeight': hh, 'width': 520, 'height': 520, 'items': row} for row in ([0, 1, 2], [3], [4]) for y, p, hh in cams]
    pk.render_specs['genitalSkin'] = {'out': 'renders/genitalSkin.png', 'columns': len(cams), 'items': items, 'views': views,
                                      'note': 'rows: grafted coloured by group (scanned patch darker, blend surface green) / grafted in one colour / delivered skin; columns: front, below, two oblique views, close-up from front and below'}
    cams2 = [(180, -50, 0.09), (180, -15, 0.09), (150, -35, 0.09), (-150, -35, 0.09), (90, -15, 0.09), (0, -89, 0.09)]
    views2 = [{'yaw': y, 'pitch': p, 'center': c, 'halfHeight': hh, 'width': 520, 'height': 520, 'items': row} for row in ([1, 2], [5]) for y, p, hh in cams2]
    pk.render_specs['genitalPerineum'] = {'out': 'renders/genitalPerineum.png', 'columns': len(cams2), 'items': items, 'views': views2,
                                          'note': 'the graft alone (scanned patch and blend surface; the rest of the skin is left out because thighs and buttocks would hide it); rows: coloured by group / one colour; columns: from behind and below, from behind, from behind-left and behind-right and below, from the left, from straight below'}


def islands(piece_f, other_f, other_lab, nv):
    """
    other_f 里与 piece_f 有公共顶点、又不是最大一块的那些连通块（被 piece_f 围住的小岛）：返回 other_f 上的布尔数组。
    The pieces of other_f that share a vertex with piece_f and are not the largest piece (islets enclosed by piece_f):
    a boolean array over other_f.
    """
    if not len(other_f):
        return np.zeros(0, bool)
    touch = np.zeros(nv, bool)
    touch[piece_f] = True
    big = np.argmax(np.bincount(other_lab))
    labs = np.unique(other_lab[touch[other_f].any(1)])
    return np.isin(other_lab, labs[labs != big])


def in_patch_ext(in_patch, v4):
    """v4 里的下标是否是片上的顶点（−1 和切带时新生的顶点都不是）/ whether the indices in v4 are patch vertices (−1 and vertices born when the zone was cut are not)"""
    ok = (v4 >= 0) & (v4 < len(in_patch))
    out = np.zeros(len(v4), bool)
    out[ok] = in_patch[v4[ok]]
    return out
