# 男性外生殖器的皮肤：把他本人扫描皮肤上的阴茎和阴囊（BodyParts3D FJ2810 的外壁）接到皮肤包的皮肤上。
# 由 graft.py 的 genital 步骤调用。
# The skin of the male external genitalia: grafts the penis and scrotum of his own scanned skin (outer wall of
# BodyParts3D FJ2810) into the skin of a skin package. Called by the genital step of graft.py.
#
# 做法（INTEGRATION.txt 第 11 节）/ the procedure (section 11 of INTEGRATION.txt)
#   1. 皮肤上的“隆起”区域 = 皮肤与扫描皮肤相差超过阈值、围着生殖器深层部件连成一片的顶点，向外扩几圈。
#      The "mound" region of the skin = vertices where the skin and the scan differ by more than a threshold, connected
#      round the deep genital parts, grown by a few rings.
#   2. 把这个区域抹平：用周围没有被动过的皮肤解双调和方程，得到一张光顺的耻区、会阴面（构造物，标签 graftConstruction）。
#      That region is flattened: the biharmonic equation with the undisturbed skin round it as boundary gives a fair pubic
#      and perineal surface (construction, tag graftConstruction).
#   3. 扫描片只取生殖器本身：供体网格细、且贴近深层部件的部分（阴茎、阴囊下部），加上高出构造面的相连部分。
#      The scanned patch is the genitalia proper only: where the donor mesh is fine and close to the deep parts (penis,
#      lower scrotum), plus the connected surface standing proud of the constructed surface.
#   4. 在构造面上、扫描片的开口之下挖洞；洞缘与扫描片的边缘之间重新布一圈过渡环（一圈新顶点，标签 graftBlend）。
#      A hole is cut in the constructed surface under the opening of the patch; between its rim and the rim of the patch a
#      blend ring is meshed anew (one loop of new vertices, tag graftBlend).
#   5. 构造面和过渡环的顶点再解一次双调和方程，与两侧相切地接上。扫描顶点一个也不动（标签 graftScanned）。
#      The vertices of the constructed surface and of the ring are solved once more (biharmonic), joining both sides
#      tangentially. No scanned vertex moves (tag graftScanned).

import re

import numpy as np
import scipy.sparse as sp
import scipy.sparse.csgraph as csgraph
import scipy.sparse.linalg as spla
from scipy.spatial import cKDTree

from open_skin import MM, TAGS, graph, half_edge_map, unique_edges
from graft import BP3D_LICENCE_NOTE, bp3d_outer_skin, fill_holes, fill_small_holes, grow, harmonic_extension, ordered_loop, single_loop_region, vertex_graph, zipper

# 规则里的数（都写进报告）/ the numbers of the rules (all recorded in the report)
DIFFER_MM = 2.5        # 皮肤与扫描相差多少算“隆起”/ how far skin and scan must differ to count as mound
GROW_RINGS = 3         # 隆起区域向外扩的圈数 / rings by which the mound region is grown
FINE_EDGE_MM = 5.0     # 供体“细”网格：平滑后的邻边平均长度上限 / fine donor mesh: upper limit of the smoothed mean incident edge length
CORE_DIST_MM = 12.0    # 细网格部分离深层部件的最大距离 / greatest distance of the fine part from the deep parts
PROUD_MM = 4.0         # 高出构造面多少算生殖器本身 / how far above the constructed surface counts as genitalia proper
REACH_MM = 30.0        # 高出部分离深层部件的最大距离 / greatest distance of the proud part from the deep parts
RIM_MARGIN_MM = 3.0    # 构造面上离扫描片边缘这么近的顶点也挖掉 / constructed vertices this close to the rim of the patch are cut away too
RIGID_FULL_MM = 20.0   # 离扫描片边缘多远起完全跟随骨盆 / distance from the rim of the patch beyond which the pelvis alone is followed


def biharmonic_fill(n, tris, P, free):
    """
    tris 上的均匀权双调和填补：free 的顶点位置由其余顶点决定（L·L = 0），两头相切地接上。
    The biharmonic fill with uniform weights on `tris`: the positions of the `free` vertices follow from the others
    (L·L = 0), joining tangentially.
    """
    E, _ = unique_edges(tris, n)
    A = graph(n, E, np.ones(len(E)))
    dg = np.maximum(np.asarray(A.sum(1)).ravel(), 1e-12)
    L = sp.eye(n) - sp.diags(1.0 / dg) @ A
    B = (L @ L).tocsr()
    used = np.zeros(n, bool)
    used[tris] = True
    isfree = np.zeros(n, bool)
    isfree[free] = True
    fixed = np.where(used & ~isfree)[0]
    out = P.copy()
    out[free] = spla.spsolve(B[free][:, free].tocsc(), -(B[free][:, fixed] @ P[fixed]))
    return out


def densify(pts, step):
    """闭合折线加密 / a closed polyline sampled densely"""
    out = []
    for a, b in zip(pts, np.roll(pts, -1, 0)):
        k = max(1, int(np.ceil(np.linalg.norm(b - a) / step)))
        out.append(a + np.outer(np.arange(k) / k, b - a))
    return np.concatenate(out)


def resample_closed(pts, n):
    """闭合折线按弧长重采样成 n 个点 / a closed polyline resampled to n points by arc length"""
    q = np.vstack([pts, pts[:1]])
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(q, axis=0), axis=1))]
    t = np.arange(n) / n * s[-1]
    return np.stack([np.interp(t, s, q[:, k]) for k in range(3)], 1)


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
    DV, DF, rel, licence_line = bp3d_outer_skin(bp3d_dir)
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

    # ── 1. 隆起区域 / the mound region ──
    dist = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(V), DVc, DFc)[0])
    cand = used & (cKDTree(seeds).query(V)[0] < 0.12) & (dist > DIFFER_MM * MM)
    idx = np.where(cand)[0]
    _, lab = csgraph.connected_components(A[idx][:, idx], directed=False)
    seed_v = idx[np.argmin(cKDTree(seeds).query(V[idx])[0])]
    R = np.zeros(nv, bool)
    R[idx[lab == lab[np.where(idx == seed_v)[0][0]]]] = True
    R = single_loop_region(fill_holes(grow(R, A, GROW_RINGS) & used, A, used), Fl, A, 'skin')
    cut = live & R[F].all(1)
    Fc = F[cut]
    inner = R & ~np.isin(np.arange(nv), np.unique(F[live & ~cut]))  # 不再被剩余皮肤用到的顶点 / vertices the remaining skin no longer uses
    rimA = np.array(ordered_loop(Fc)[::-1])

    # ── 2. 抹平：构造的耻区、会阴面 / flattening: the constructed pubic and perineal surface ──
    around = grow(R, A, 3)
    ring_tris = Fl[around[Fl].all(1)]
    Pb = biharmonic_fill(nv, ring_tris, V, np.where(inner)[0])
    Pbc = np.ascontiguousarray(Pb)
    flat_moved = np.linalg.norm(Pb - V, axis=1)[inner]

    # ── 3. 扫描片：生殖器本身 / the scanned patch: the genitalia proper ──
    dused = np.zeros(nd, bool)
    dused[DF] = True
    d_deep = cKDTree(deep_all).query(DV)[0]
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
    near = np.where(dused & (d_deep < 0.08))[0]
    sd = np.full(nd, -1.0)
    sd[near] = igl.signed_distance(np.ascontiguousarray(DV[near]), Pbc, np.ascontiguousarray(Fl))[0]  # 正 = 在构造面之外 / positive = outside the constructed surface
    core = dused & (d_deep < CORE_DIST_MM * MM) & (mean_edge <= FINE_EDGE_MM * MM)
    proud = dused & (sd > PROUD_MM * MM) & (d_deep < REACH_MM * MM)
    sel = core | proud
    idx = np.where(sel)[0]
    ncomp, lab = csgraph.connected_components(Ad[idx][:, idx], directed=False)
    core_comp = [int(n_) for n_ in sorted(np.bincount(csgraph.connected_components(Ad[np.where(core)[0]][:, np.where(core)[0]], directed=False)[1]))[::-1][:4]]
    seed_d = idx[np.argmin(cKDTree(seeds).query(DV[idx])[0])]
    reg = np.zeros(nd, bool)
    reg[idx[lab == lab[np.where(idx == seed_d)[0][0]]]] = True
    reg = fill_holes(reg, Ad, dused)
    # 去掉边上的尖角（只属于一两个片内三角形的边缘顶点）/ ears at the rim (rim vertices of only one or two patch triangles) are trimmed
    for _ in range(6):
        ft = DF[reg[DF].all(1)]
        cnt = np.bincount(ft.ravel(), minlength=nd)
        ear = reg & (cnt <= 2)
        if not ear.any():
            break
        reg &= ~ear
    reg = single_loop_region(reg, DF, Ad, 'donor')
    psel = reg[DF].all(1)
    pf = DF[psel]
    pv = np.unique(pf)
    LBr = np.array(ordered_loop(pf)[::-1])  # 扫描片的边缘，逆着片上三角形的方向 / the rim of the patch, against its triangles
    rim_gap = np.abs(sd[LBr])

    # ── 4. 构造面上的洞 / the hole in the constructed surface ──
    Ac, _ = vertex_graph(nv, Fc)
    iv = np.where(inner)[0]
    wn = np.zeros(nv)
    wn[iv] = igl.winding_number(DVc, np.ascontiguousarray(pf), np.ascontiguousarray(Pb[iv]))
    rim_dense = cKDTree(densify(DV[LBr], 0.001))
    under = np.zeros(nv, bool)
    under[iv] = (np.abs(wn[iv]) > 0.25) | (rim_dense.query(Pb[iv])[0] < RIM_MARGIN_MM * MM)
    cused = np.zeros(nv, bool)
    cused[Fc] = True
    hole = single_loop_region(fill_holes(grow(under, Ac, 1) & cused, Ac, cused), Fc, Ac, 'constructed surface')
    hsel = hole[Fc].all(1)
    LC = np.array(ordered_loop(Fc[hsel])[::-1])
    base_f = Fc[~hsel]
    if not (inner[base_f]).any():
        raise RuntimeError('genital: nothing is left of the constructed surface')
    Eb, _ = unique_edges(base_f, nv)
    h_loc = float(np.median(np.linalg.norm(Pb[Eb[:, 0]] - Pb[Eb[:, 1]], axis=1)))  # 包里皮肤在这里的边长 / the package skin's local edge length
    keep_ring = ring_tris[~R[ring_tris].all(1)]
    b = DV[LBr]
    base_f0, LC0, Pb0 = base_f, LC, Pb
    splits = []  # 构造面洞缘上要对半分的边（按先后）/ edges of the rim of the hole to be halved (in order)
    for attempt in range(6):
        # 洞缘上太长的边对半分：加一个构造顶点，把它所在的那个构造三角形一分为二
        # edges of the rim that are too long are halved: one constructed vertex is added and the constructed triangle on the edge is split in two
        base_f, LC, Pb = [list(t) for t in base_f0], list(LC0), Pb0
        for (ea, eb) in splits:
            k = [i for i, t in enumerate(base_f) if ea in t and eb in t]
            if len(k) != 1:
                continue
            t = base_f[k[0]]
            m_id = len(Pb)
            Pb = np.vstack([Pb, 0.5 * (Pb[ea] + Pb[eb])])
            ec = [v for v in t if v != ea and v != eb][0]
            i0 = t.index(ea)
            if t[(i0 + 1) % 3] == eb:
                base_f[k[0]] = [ea, m_id, ec]
                base_f.append([m_id, eb, ec])
            else:
                base_f[k[0]] = [eb, m_id, ec]
                base_f.append([m_id, ea, ec])
            j = LC.index(ea)
            if LC[(j + 1) % len(LC)] == eb:
                LC.insert(j + 1, m_id)
            else:
                LC.insert(LC.index(eb) + 1, m_id)
        base_f, LC = np.array(base_f), np.array(LC)
        nx = len(Pb)
        is_new = np.r_[inner, np.ones(nx - nv, bool)]
        base_v = np.where(is_new & np.isin(np.arange(nx), np.unique(base_f)))[0]

        # ── 5. 过渡环 / the blend ring ──
        lc_dense = densify(Pb[LC], 0.001)
        mid = 0.5 * (b + lc_dense[cKDTree(lc_dense).query(b)[1]])
        for _ in range(3):
            mid = 0.25 * np.roll(mid, 1, 0) + 0.5 * mid + 0.25 * np.roll(mid, -1, 0)
        mlen = float(np.linalg.norm(mid - np.roll(mid, -1, 0), axis=1).sum())
        n_m = max(8, int(round(mlen / (0.7 * h_loc))))
        Mp = resample_closed(mid, n_m)

        # 新顶点的编号：构造面、过渡环、扫描片 / numbering of the new vertices: constructed surface, ring, patch
        nb, npv = len(base_v), len(pv)
        id_base = np.arange(nv, nv + nb)
        id_m = np.arange(nv + nb, nv + nb + n_m)
        id_p = np.arange(nv + nb + n_m, nv + nb + n_m + npv)
        remap = np.arange(nx)
        remap[base_v] = id_base
        dl = -np.ones(nd, np.int64)
        dl[pv] = id_p
        Vall = np.vstack([V, Pb[base_v], Mp, DV[pv]])
        base_faces = remap[base_f]
        patch_faces = dl[pf]
        z1 = zipper(Vall, list(remap[LC]), Vall, list(id_m))
        z2 = zipper(Vall, list(id_m), Vall, list(dl[LBr]))
        stitch = np.vstack([z1, z2])

        # ── 6. 构造面和过渡环再解一次，与扫描片和周围皮肤相切 / constructed surface and ring solved once more, tangent to patch and skin ──
        solve_tris = np.vstack([keep_ring, base_faces, stitch, patch_faces])
        free = np.r_[id_base, id_m]
        before = Vall[free].copy()
        Vall = biharmonic_fill(len(Vall), solve_tris, Vall, free)
        # 解出的过渡面若与扫描片或别的面相交：把有关的构造顶点（及其邻居）朝解之前的位置退回一半，反复几次。扫描顶点不动。
        # where the solved transition cuts the scanned patch or anything else, the constructed vertices concerned (and their
        # neighbours) are taken halfway back towards their position before the solve, repeatedly. Scanned vertices do not move.
        solved = Vall[free].copy()
        lam = np.ones(len(free))
        slot = -np.ones(len(Vall), np.int64)
        slot[free] = np.arange(len(free))
        Ef, _ = unique_edges(np.vstack([base_faces, stitch]), len(Vall))
        Ef = Ef[(slot[Ef] >= 0).all(1)]
        Af = graph(len(free), slot[Ef], np.ones(len(Ef)))
        near_skin = cKDTree(Vall[nv:]).query(V)[0] < 0.04
        nb_f = Fl[near_skin[Fl].any(1) & ~cut[live]]
        test_f = np.vstack([patch_faces, stitch, base_faces, nb_f])
        n_scan = len(patch_faces)
        backed_off = 0
        for _ in range(8):
            pr = intersecting_pairs(Vall, test_f)
            pr = pr[(pr >= n_scan).any(1)] if len(pr) else pr
            if not len(pr):
                break
            bad = np.zeros(len(free), bool)
            sl = slot[test_f[pr.ravel()]].ravel()
            bad[sl[sl >= 0]] = True
            bad = bad | (Af @ bad.astype(float) > 0)
            if not bad.any():
                break
            lam[bad] *= 0.5
            backed_off = int((lam < 1).sum())
            Vall[free] = before + lam[:, None] * (solved - before)
        resolve_moved = np.linalg.norm(Vall[free] - before, axis=1)
        lcl = np.linalg.norm(Vall[remap[LC]] - Vall[remap[np.roll(LC, -1)]], axis=1)
        long_ = [(int(LC[i]), int(LC[(i + 1) % len(LC)])) for i in np.where(lcl > 1.5 * h_loc)[0]]
        if not long_:
            break
        splits += long_
    LC = remap[LC]

    # ── 7. 写进包里 / into the package ──
    new_ids = np.r_[id_base, id_m, id_p]
    sub = np.vstack([base_faces, stitch, patch_faces])
    Es, _ = unique_edges(sub, len(Vall))
    Ls = np.linalg.norm(Vall[Es[:, 0]] - Vall[Es[:, 1]], axis=1)
    M = np.clip(harmonic_extension(len(Vall), Es, Ls, rimA, new_ids), 0, None)
    M /= M.sum(1, keepdims=True)
    tagv = np.r_[np.full(nb, TAGS['graftConstruction']), np.full(n_m, TAGS['graftBlend']), np.full(npv, TAGS['graftScanned'])]
    got = pk.extend(Vall[nv:], rimA, M, tagv, rimA[np.argmax(M, axis=1)])
    assert np.array_equal(got, new_ids)
    # 扫描片跟随骨盆：离片缘 RIGID_FULL_MM 起完全跟随 / the patch follows the pelvis, entirely from RIGID_FULL_MM off its rim
    pelvis = pk.joint('pelvis')
    Gp, _ = vertex_graph(len(Vall), patch_faces, Vall)
    geo = csgraph.dijkstra(Gp, indices=dl[LBr], min_only=True)[id_p]
    g = np.clip(geo / (RIGID_FULL_MM * MM), 0, 1)
    g = g * g * (3 - 2 * g)
    Wp = pk.W[id_p].toarray() * (1 - g)[:, None]
    Wp[:, pelvis] += g
    pk.W = sp.vstack([pk.W[:id_p[0]], sp.csr_matrix(Wp)]).tocsr()
    nf_old = len(F)
    pk.F = np.vstack([F, patch_faces, stitch, base_faces])
    for gname in list(pk.groups):
        pk.groups[gname] = np.r_[pk.groups[gname], np.zeros(len(pk.F) - nf_old, bool)]
    pk.groups['skin'][:nf_old] &= ~cut
    o = nf_old
    for gname, cnt in (('genitalSkin', len(patch_faces)), ('genitalSkinStitch', len(stitch)), ('genitalSkinBase', len(base_faces))):
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

    # ── 8. 核对 / checks ──
    allf = np.zeros(len(pk.F), bool)
    for gm in pk.groups.values():
        allf |= gm
    Vn, Fn = np.ascontiguousarray(pk.V), np.ascontiguousarray(pk.F[allf])
    # 自相交：全部新三角形，加上附近 40 mm 以内的原皮肤三角形（含大腿）
    # self-intersection: every new triangle plus the delivered skin triangles within 40 mm of them (thighs included)
    newv = np.zeros(len(pk.V), bool)
    newv[new_ids] = True
    skin_f = pk.F[pk.groups['skin']]
    kind = np.r_[np.zeros(len(patch_faces), int), np.ones(len(stitch), int), np.full(len(base_faces), 2), np.full(len(nb_f), 3)]
    pairs = intersecting_pairs(pk.V, test_f)
    kp = np.sort(kind[pairs], axis=1) if len(pairs) else np.zeros((0, 2), int)
    names = ['scanned patch', 'blend ring', 'constructed surface', 'delivered skin']
    by_kind = {}
    for a_, b_ in kp:
        key = '%s / %s' % (names[a_], names[b_])
        by_kind[key] = by_kind.get(key, 0) + 1
    scan_scan = int(((kp[:, 0] == 0) & (kp[:, 1] == 0)).sum())
    other = int(len(kp) - scan_scan)
    # 扫描自身的相交：在原始供体上（接入之前）同样存在的 / intersections of the scan with itself: present in the donor as it is, before any grafting
    donor_pairs = intersecting_pairs(DV, pf)
    # 扫描片离大腿（剩余的原皮肤）和构造面有多远 / how far the scanned patch stays from the thighs (remaining delivered skin) and from the constructed surface
    far = id_p[geo > 0.015]
    d_th = np.sqrt(igl.point_mesh_squared_distance(np.ascontiguousarray(pk.V[far]), Vn, np.ascontiguousarray(skin_f))[0])
    d2b, _, cpb = igl.point_mesh_squared_distance(np.ascontiguousarray(pk.V[far]), Vn, np.ascontiguousarray(np.vstack([base_faces, z1])))
    kth = int(np.argmin(d_th))
    cover, worse = {}, []
    for p, Q in zip(parts, part_pts):
        Q = np.ascontiguousarray(Q)
        row = {}
        for label, (Vx, Fx) in (('donor', (DVc, DFc)), ('delivered', (np.ascontiguousarray(V0), np.ascontiguousarray(F0))), ('grafted', (Vn, Fn))):
            s = igl.signed_distance(Q, Vx, Fx)[0]
            row[label] = {'leastCoverMm': round(float(-s.max()) / MM, 2), 'medianCoverMm': round(float(-np.median(s)) / MM, 2), 'shareOutside': round(float((s > 0).mean()), 4)}
        cover['%s (%s)' % (p['name'], p['id'])] = row
        if row['grafted']['leastCoverMm'] < row['donor']['leastCoverMm'] - 0.005:
            worse.append('%s: %.2f mm under the grafted skin, %.2f mm under the scan' % (p['name'], row['grafted']['leastCoverMm'], row['donor']['leastCoverMm']))
    zl = np.linalg.norm(pk.V[stitch][:, [0, 1, 2]] - pk.V[stitch][:, [1, 2, 0]], axis=2)
    bl = np.linalg.norm(pk.V[base_faces][:, [0, 1, 2]] - pk.V[base_faces][:, [1, 2, 0]], axis=2)
    Ep, _ = unique_edges(pf, nd)
    pl = np.linalg.norm(DV[Ep[:, 0]] - DV[Ep[:, 1]], axis=1)
    buried = dused & (d_deep < REACH_MM * MM) & (mean_edge <= FINE_EDGE_MM * MM) & ~reg
    r2 = lambda x: round(float(x) / MM, 2)
    checks = {
        'scannedVerticesExactlyWhereTheScanHasThem': bool(np.abs(pk.V[id_p] - DV[pv]).max() == 0),
        'noIntersectionInvolvingConstructionRingOrDeliveredSkin': other == 0,
        'stitchEdgesAtMostTwiceTheLocalEdge': bool(zl.max() <= 2 * h_loc),
        'coverOverEveryGenitalPartNoLessThanUnderTheScan': not worse,
        'patchDoesNotTouchTheThighs': bool(d_th.min() > 2 * MM),
    }
    stats = {
        'rules': {
            'moundRegion': 'skin vertices more than %g mm from the scan, connected round the deep genital parts within 120 mm, grown by %d rings, holes filled' % (DIFFER_MM, GROW_RINGS),
            'constructedSurface': 'the mound region flattened: positions of its interior vertices from the biharmonic equation (uniform weights) on the package mesh, with three rings of undisturbed skin round it fixed; then solved once more together with the ring, with the scanned patch fixed',
            'scannedPatch': 'donor vertices whose smoothed mean incident edge is at most %g mm and which lie within %g mm of a deep genital part (corpora, glans, testes, epididymides), together with donor vertices standing more than %g mm proud of the constructed surface within %g mm of a deep part; the connected piece round glans and testes, holes filled, ears trimmed. The edge-and-distance rule alone gives separate pieces (see fineCorePieces: penis, lower scrotum, a strip of perineal raphe): the upper scrotum is more than %g mm from the testes and the surfaces where penis and scrotum touch are coarse in the scan, so the second term joins them' % (FINE_EDGE_MM, CORE_DIST_MM, PROUD_MM, REACH_MM, CORE_DIST_MM),
            'hole': 'constructed vertices under the opening of the patch (generalised winding number of the open patch above 0.25) or within %g mm of its rim, grown by one ring' % RIM_MARGIN_MM,
            'blendRing': 'one loop of new vertices midway between the rim of the patch and the rim of the hole, resampled to 0.7 x the local edge length of the package skin; two strips of triangles; the scanned rim vertices are kept as they are (they cannot be resampled without moving scanned data)',
        },
        'fineCorePieces': core_comp,
        'moundRegion': {'removedTriangles': int(cut.sum()), 'removedVertices': int(inner.sum()), 'rimOfHoleVertices': int(len(rimA)), 'flattenedByMm': {'median': r2(np.median(flat_moved)), 'max': r2(flat_moved.max())},
                        'extent': {'min': [round(float(v), 3) for v in V0[R].min(0)], 'max': [round(float(v), 3) for v in V0[R].max(0)]}},
        'constructedSurface': {'vertices': int(nb), 'triangles': int(len(base_faces)), 'edgeMm': {'median': r2(np.median(bl)), 'max': r2(bl.max())}, 'localEdgeOfThePackageSkinMm': r2(h_loc),
                               'movedByTheSecondSolveMm': {'median': r2(np.median(resolve_moved[:nb])), 'max': r2(resolve_moved[:nb].max())},
                               'verticesTakenBackTowardsTheirPositionBeforeTheSolveToClearIntersections': backed_off},
        'scannedPatch': {'vertices': int(npv), 'triangles': int(len(pf)), 'rimVertices': int(len(LBr)), 'edgeMm': {'median': r2(np.median(pl)), 'p95': r2(np.percentile(pl, 95)), 'max': r2(pl.max())},
                         'donorHoleFillTriangles': int(psel[n_donor_faces:].sum()), 'distanceOfRimFromDeepPartsMm': {'median': r2(np.median(d_deep[LBr])), 'max': r2(d_deep[LBr].max())},
                         'fineScanLeftUnderTheConstructedSurface': {'what': 'fine donor vertices within %g mm of a deep part that are not in the patch: the neck of the scrotum and the perineal raphe, which lie inside (above) the constructed surface because the crotch of the fitted skin is lower than the scanned one' % REACH_MM, 'vertices': int(buried.sum()), 'deepestBelowTheConstructedSurfaceMm': r2(-sd[buried].min()) if buried.any() else 0.0}},
        'rimMismatchMm': {'what': 'distance of the rim of the scanned patch from the constructed surface before the ring is built and solved', 'median': r2(np.median(rim_gap)), 'max': r2(rim_gap.max())},
        'blendRing': {'vertices': int(n_m), 'stitchTriangles': int(len(stitch)), 'rimOfConstructedSurfaceVertices': int(len(LC)), 'rimEdgesOfTheConstructedSurfaceHalved': len(splits)},
        'stitchEdgeMm': {'median': r2(np.median(zl)), 'p95': r2(np.percentile(zl, 95)), 'max': r2(zl.max()), 'limit': r2(2 * h_loc), 'longestEdgePerTriangle': {'median': r2(np.median(zl.max(1))), 'max': r2(zl.max(1).max())}},
        'selfIntersection': {'what': 'pairs of intersecting triangles without a common vertex among the new triangles and the delivered skin within 40 mm of them (thighs included)', 'trianglesTested': int(len(test_f)), 'pairsByKind': by_kind,
                             'scanAgainstScan': scan_scan, 'scanAgainstScanInTheDonorAsItIs': int(len(donor_pairs)), 'involvingRingConstructionOrDeliveredSkin': other,
                             'note': 'pairs of the scan with itself are in the scanned data (penis lying against the scrotum) and are not repaired: scanned vertices do not move'},
        'thighGap': {'what': 'closest approach of scanned patch vertices more than 15 mm from the rim of the patch to the remaining delivered skin', 'leastMm': r2(d_th.min()), 'at': [round(float(v), 4) for v in pk.V[far[kth]]],
                     'shareWithin5Mm': round(float((d_th < 5 * MM).mean()), 4), 'leastToTheConstructedSurfaceMm': r2(np.sqrt(d2b.min()))},
        'rigid': {'joint': pk.joints['names'][pelvis], 'verticesFullyRigid': int((g >= 1).sum()), 'verticesBlended': int(((g > 0) & (g < 1)).sum())},
        'coverOverGenitalParts': cover,
        'checks': checks,
    }
    pk.report['genital'] = stats
    bad = [k for k, v in checks.items() if not v]
    hard = [k for k in bad if k != 'stitchEdgesAtMostTwiceTheLocalEdge']
    if hard:
        raise RuntimeError('genital: failed checks: %s%s; intersecting pairs by kind: %s; stitch edge max %.1f mm, rim edges halved %d' % (', '.join(hard), ('; ' + '; '.join(worse)) if worse else '', by_kind, zl.max() / MM, len(splits)))
    jn = pk.joints['names'][pelvis]
    pk.grafts.append({
        'name': 'genitalSkin', 'provenance': 'scanned',
        'patchVertices': [int(v) for v in id_p], 'blendRingVertices': [int(v) for v in id_m], 'constructionVertices': [int(v) for v in id_base],
        'rimOfHole': [int(v) for v in rimA], 'rimOfPatch': [int(v) for v in dl[LBr]], 'rimOfConstructedSurface': [int(v) for v in LC], 'removedVertices': [int(v) for v in rem],
        'what': {'zh': '男性外生殖器的皮肤。patchVertices：阴茎和阴囊，取自他本人的扫描皮肤（BodyParts3D 4.0 的 FJ2810 外壁），位置一个也没有动（标签 graftScanned）。constructionVertices：拟合皮肤上原来盖着生殖器的隆起被抹平后得到的耻区、会阴和大腿内侧上部的面，是由周围皮肤解双调和方程构造出来的，不是扫描数据，也不是解剖（标签 graftConstruction）；它比扫描的会阴低，阴囊颈部和会阴缝的扫描面因此被它盖在下面，没有用上。blendRingVertices：两者之间新布的一圈过渡顶点（标签 graftBlend，构造物）。',
                 'en': 'The skin of the male external genitalia. patchVertices: penis and scrotum from his own scanned skin (outer wall of FJ2810 of BodyParts3D 4.0), not one position changed (tag graftScanned). constructionVertices: the pubic, perineal and upper inner-thigh surface obtained by flattening the mound the fitted skin had over the genitalia; it is constructed from the surrounding skin by the biharmonic equation and is neither scanned data nor anatomy (tag graftConstruction); it lies lower than the scanned perineum, so the scanned neck of the scrotum and perineal raphe are under it and are not used. blendRingVertices: the loop of new vertices meshed between the two (tag graftBlend, construction).'},
        'source': {'name': 'BodyParts3D 4.0', 'file': rel, 'url': 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html', 'licenceLineInFile': licence_line, 'licenceNote': BP3D_LICENCE_NOTE, 'frame': '(x, z, −y) mm → m'},
        'weights': {'zh': '权重从洞口环（rimOfHole）调和延拓到全部新顶点；扫描片再从它的边缘起逐渐、%g mm 以外完全跟随骨盆（关节 %s）。阴茎和阴囊因此随骨盆刚性运动，不下垂、不摆动、不随大腿让开。' % (RIGID_FULL_MM, jn),
                    'en': 'Weights are a harmonic extension from the rim of the hole (rimOfHole) over every new vertex; the scanned patch then turns, from its rim and entirely beyond %g mm, to the pelvis (joint %s). Penis and scrotum therefore move rigidly with the pelvis: they do not hang, swing or give way to the thighs.' % (RIGID_FULL_MM, jn)},
        'fields': {'zh': '体型场（shape-*.f32 等）同样从洞口环调和延拓。', 'en': 'Shape fields (shape-*.f32 and the others) are extended harmonically from the rim likewise.'},
    })
    # 检查图：正面、下面、两侧和两张斜向近景；上排按分组着色，中排单一肤色，下排原皮肤
    # check renders: front, below, both sides and two oblique close-ups; grafted coloured by group above, in one colour in the middle, the delivered skin below
    c = [round(float(v), 4) for v in (0.5 * (DV[pv].min(0) + DV[pv].max(0)))]
    items = [{'obj': 'skin.obj', 'color': [226, 178, 156], 'groups': ['skin']}, {'obj': 'skin.obj', 'color': [200, 140, 125], 'groups': ['genitalSkin']}, {'obj': 'skin.obj', 'color': [120, 160, 220], 'groups': ['genitalSkinStitch']},
             {'obj': 'skin.obj', 'color': [150, 200, 150], 'groups': ['genitalSkinBase']}, {'obj': 'skin.obj', 'color': [226, 178, 156]}, {'obj': 'skin-delivered.obj', 'color': [226, 178, 156]}]
    # 侧面两张只画中线两侧 45 mm 以内的一片（否则被手和大腿挡住）/ the two side views draw only the slab within 45 mm of the midline (hands and thighs would hide it otherwise)
    cams = [(0, 0, 0.11, None), (0, -80, 0.11, None), (90, 0, 0.09, [-0.045, 0.045]), (-90, 0, 0.09, [-0.045, 0.045]), (35, -25, 0.07, None), (-35, -25, 0.07, None), (0, -45, 0.06, None)]
    views = [dict({'yaw': y, 'pitch': p, 'center': c, 'halfHeight': hh, 'width': 440, 'height': 440, 'items': row}, **({'slab': sl} if sl else {})) for row in ([0, 1, 2, 3], [4], [5]) for y, p, hh, sl in cams]
    pk.render_specs['genitalSkin'] = {'out': 'renders/genitalSkin.png', 'columns': len(cams), 'items': items, 'views': views,
                                      'note': 'rows: grafted coloured by group (scanned patch darker, ring blue, constructed surface green) / grafted in one colour / delivered skin; columns: front, below, from the body\'s left and right (slab within 45 mm of the midline), two oblique close-ups, close-up from front and below'}
