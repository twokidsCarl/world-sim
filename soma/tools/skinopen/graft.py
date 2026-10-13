#!/usr/bin/env python3
# 把另一张表面上的一片（供体）接到皮肤包的皮肤上：切掉皮肤上对应的那一块，把供体片缝进去。
# 在闭合的皮肤上做，结果仍然闭合；写到 <body>-skin-grafted/，原包一个字节也不动。
# 之后可以再用 open_skin.py 对结果开口裂和睑裂。
# Grafts a patch of another surface (the donor) into the skin of a skin package: the matching piece of
# the skin is cut out and the donor patch is stitched in. It works on the closed skin and leaves it
# closed; the result goes to <body>-skin-grafted/ and the delivered package is not touched.
# open_skin.py can then cut the mouth and eye openings into the result.
#
#   python tools/skinopen/graft.py data/raw/bodyshape/out/male-skin --steps genital
#       [--out DIR] [--deep deep-face.json] [--bp3d DIR]
#
# 步骤 / steps
#   genital   男性外生殖器的皮肤：取自他本人的扫描皮肤（BodyParts3D FJ2810 的外壁）。在 genital.py 里，有自己的做法。
#             the skin of the male external genitalia, from his own scanned skin (outer wall of BodyParts3D FJ2810); in genital.py, with a procedure of its own
#   vulva     女性会阴的皮肤（Wu 等 2015 的标本）：在 vulva.py 里。
#             the female perineal skin (specimen of Wu et al. 2015): in vulva.py
#   toes      分开的脚趾：在 toes.py 里。
#             separate toes: in toes.py
#
# 通用做法 / the generic procedure
#   1. 皮肤上要换掉的区域 = 皮肤与供体相差超过阈值、且在种子点附近连成一片的顶点，向外扩几圈，补掉内部的洞。
#      区域的边缘因此落在两张表面本来就吻合的地方。
#      The region of the skin to replace = the vertices where skin and donor differ by more than a threshold,
#      connected round the seed points, grown by a few rings, with inner holes filled. Its rim therefore lies
#      where the two surfaces agree anyway.
#   2. 供体片 = 最近点落在该区域内的供体顶点（连通、补洞）。
#      The donor patch = the donor vertices whose closest point on the skin lies in that region (connected,
#      holes filled).
#   3. 供体片靠边的一圈顶点向皮肤靠拢（过渡环，属于构造物）；皮肤洞口的环与供体片的环之间用一圈三角形缝合。
#      The outer band of the patch is moved towards the skin (the blend ring, a construction aid); a ring of
#      triangles zips the rim of the hole to the rim of the patch.
#   4. 逐顶点数据（权重、体型场）从洞口环上调和延拓到供体片上。
#      Per-vertex data (weights, shape fields) are extended harmonically from the rim of the hole over the patch.
# 原有顶点的下标不变；被切掉的顶点留在文件里但不再被任何三角形用到（标签 removed）。
# Existing vertex indices do not change; the vertices cut away stay in the file, used by no triangle (tag removed).

import argparse
import json
import os
import re
import shutil
import sys

import numpy as np
import scipy.sparse as sp
import scipy.sparse.csgraph as csgraph
import scipy.sparse.linalg as spla
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from open_skin import MM, TAGS, boundary_loops, face_normals, graph, half_edge_map, read_obj, unique_edges, write_obj  # noqa: E402

BP3D_LICENCE_NOTE = {
    'zh': 'BodyParts3D 4.0 的许可有两种说法，这里照录，不作裁断：OBJ 文件头写的是 “Creative Commons Attribution-Share Alike 2.1 Japan”（"BodyParts3D, (c) The Database Center for Life Science licensed under CC Attribution-Share Alike 2.1 Japan"）；其 README 写的是 CC BY 4.0（"BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International"）。',
    'en': 'BodyParts3D 4.0 states its licence in two ways; both are quoted here and the difference is not resolved: the OBJ file headers say "Creative Commons Attribution-Share Alike 2.1 Japan" ("BodyParts3D, (c) The Database Center for Life Science licensed under CC Attribution-Share Alike 2.1 Japan"); its README says CC BY 4.0 ("BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International").',
}


# ── 小工具 / helpers ────────────────────────────────────────────────────────────────────────────

def vertex_graph(nv, F, V=None):
    E, _ = unique_edges(F, nv)
    w = np.ones(len(E)) if V is None else np.maximum(np.linalg.norm(V[E[:, 0]] - V[E[:, 1]], axis=1), 1e-9)
    return graph(nv, E, w), E


def fill_holes(mask, A, allowed):
    """把 mask 的补集里除最大一块之外的连通块都并进 mask / every component of the complement of mask except the largest joins mask"""
    comp = allowed & ~mask
    idx = np.where(comp)[0]
    n, lab = csgraph.connected_components(A[idx][:, idx], directed=False)
    if n <= 1:
        return mask
    big = np.argmax(np.bincount(lab))
    out = mask.copy()
    out[idx[lab != big]] = True
    return out


def grow(mask, A, rings):
    m = mask.copy()
    for _ in range(rings):
        m = m | (A @ m.astype(np.float64) > 0)
    return m


def ordered_loop(faces):
    """
    一组三角形的边界环，按三角形里的方向排（a → b 在某个三角形里，b → a 不在）。必须恰好是一个简单环。
    The boundary loop of a set of triangles, in the direction the triangles have it (a → b is in a triangle,
    b → a is not). It must be exactly one simple loop.
    """
    hm = half_edge_map(faces)
    nxt = {}
    for (a, b) in hm:
        if (b, a) not in hm:
            if a in nxt:
                raise RuntimeError('graft: the boundary is not a simple loop (a vertex with two outgoing boundary edges)')
            nxt[a] = b
    if not nxt:
        raise RuntimeError('graft: no boundary')
    start = min(nxt)
    loop = [start]
    while nxt[loop[-1]] != start:
        loop.append(nxt[loop[-1]])
        if len(loop) > len(nxt):
            raise RuntimeError('graft: the boundary does not close')
    if len(loop) != len(nxt):
        raise RuntimeError('graft: the boundary is more than one loop')
    return loop


def single_loop_region(mask, F, A, what):
    """让“三个顶点都在 mask 内的三角形”的边界成为一个简单环：反复去掉夹点 / make the triangles with all three vertices in mask have one simple boundary loop by removing pinch vertices"""
    m = mask.copy()
    for _ in range(40):
        fsel = m[F].all(1)
        hm = half_edge_map(F[fsel])
        out_deg = {}
        for (a, b) in hm:
            if (b, a) not in hm:
                out_deg[a] = out_deg.get(a, 0) + 1
        pinch = [v for v, d in out_deg.items() if d > 1]
        if pinch:
            m[pinch] = False
            continue
        # 只留最大的一块三角形 / keep the largest piece of triangles only
        fi = np.where(fsel)[0]
        E, _ = unique_edges(F[fi], len(m))
        n, lab = csgraph.connected_components(graph(len(m), E, np.ones(len(E))), directed=False)
        used = np.unique(F[fi])
        cnt = np.bincount(lab[used], minlength=n)
        keep = lab == np.argmax(cnt)
        if (m & ~keep).any():
            m &= keep
            continue
        if len(boundary_loops(F[fsel], len(m))) == 1:
            return m
        # 还有洞：补上 / holes left: fill them
        used = np.zeros(len(m), bool)
        used[F] = True
        m2 = fill_holes(m, A, used)
        if (m2 == m).all():
            break
        m = m2
    raise RuntimeError('graft: could not make the %s region a disc with one boundary loop' % what)


def fill_small_holes(F, max_edges=40):
    """
    供体网格上的小破洞（边数不超过 max_edges 的边界环）用扇形三角形补上；返回新的三角形数组和补上的各洞的边数。
    Small holes of the donor mesh (boundary loops of at most max_edges edges) are closed with a fan of
    triangles; returns the new triangle array and the edge counts of the holes closed.
    """
    hm = half_edge_map(F)
    nxt = {}
    for (a, b) in hm:
        if (b, a) not in hm:
            nxt.setdefault(b, []).append(a)  # 反向走 / walked against the faces
    seen, add, sizes = set(), [], []
    for start in sorted(nxt):
        if start in seen or len(nxt[start]) != 1:
            continue
        loop, ok = [start], True
        while True:
            c = nxt.get(loop[-1], [])
            if len(c) != 1:
                ok = False
                break
            if c[0] == start:
                break
            loop.append(c[0])
            if len(loop) > max_edges:
                ok = False
                break
        seen.update(loop)
        if ok and len(loop) >= 3:
            sizes.append(len(loop))
            for i in range(1, len(loop) - 1):
                add.append([loop[0], loop[i], loop[i + 1]])
    return (np.vstack([F, np.array(add, dtype=F.dtype)]) if add else F), sizes


def zipper(VA, A, VB, B):
    """
    把两个同向的环缝起来。A 沿剩余皮肤三角形的方向排，B 逆着供体片三角形的方向排；
    生成的三角形与两边的绕向一致。
    Zips two loops that run the same way. A follows the direction of the remaining skin triangles and B runs
    against that of the patch triangles; the triangles made are wound consistently with both.
    """
    A, B = list(A), list(B)
    na, nb = len(A), len(B)
    pa, pb = VA[A], VB[B]
    # 起点：最近的一对 / start at the closest pair
    d = cKDTree(pb).query(pa)
    i0 = int(np.argmin(d[0]))
    j0 = int(d[1][i0])
    A = A[i0:] + A[:i0]
    B = B[j0:] + B[:j0]
    pa, pb = VA[A], VB[B]
    # 每一步在“沿 A 前进”和“沿 B 前进”里选新边较短的那个；任何一边都不许比另一边超前四分之一圈
    # each step advances along A or along B, whichever makes the shorter new edge; neither side may run more than a quarter turn ahead of the other
    tris = []
    i = j = 0
    while i < na or j < nb:
        can_a, can_b = i < na, j < nb
        if can_a and can_b:
            da = np.linalg.norm(pa[(i + 1) % na] - pb[j % nb])
            db = np.linalg.norm(pa[i % na] - pb[(j + 1) % nb])
            lead = i / na - j / nb
            step_a = da <= db
            if lead > 0.25:
                step_a = False
            elif lead < -0.25:
                step_a = True
        else:
            step_a = can_a
        if step_a:
            tris.append([A[(i + 1) % na], A[i % na], B[j % nb]])
            i += 1
        else:
            tris.append([A[i % na], B[j % nb], B[(j + 1) % nb]])
            j += 1
    return np.array(tris)


def zipper_by_parameter(V, A, B):
    """
    把两个同向的环缝起来，按“沿 A 的弧长参数”配对：B 的每个顶点取它在 A 上最近点的弧长（沿 B 理成不减的），
    然后像归并一样，哪一边下一个顶点的参数小就前进哪一边。两条环大致是彼此的等距线时（片缘在洞内留了一圈缝），
    这样得到的是一条不翻折的带；zipper() 按“新边较短”贪心，环参差时会缝出翻过来的三角形。绕向与 zipper() 相同。
    Zips two loops that run the same way, pairing them by arc length along A: each vertex of B takes the arc length of
    its closest point on A (made non-decreasing along B), and then, as in a merge, the side whose next vertex has the
    smaller parameter advances. When the loops are roughly offsets of one another (the patch rim kept a gap inside
    the hole) this gives a band without flips; zipper() is greedy on "the shorter new edge" and makes flipped
    triangles when a rim is ragged. Winding as in zipper().
    """
    A, B = list(A), list(B)
    na, nb = len(A), len(B)
    pa = V[A]
    seg = np.linalg.norm(np.roll(pa, -1, axis=0) - pa, axis=1)
    sA = np.r_[0, np.cumsum(seg)]
    LA = float(sA[-1])
    samp, su = [], []
    for i in range(na):
        n_ = max(2, int(np.ceil(seg[i] / 0.00025)))
        t_ = np.arange(n_) / n_
        samp.append(pa[i] + np.outer(t_, pa[(i + 1) % na] - pa[i]))
        su.append(sA[i] + t_ * seg[i])
    uB = np.concatenate(su)[cKDTree(np.vstack(samp)).query(V[B])[1]]
    wrap = lambda d: (d + LA / 2) % LA - LA / 2
    j0 = int(np.argmin(np.abs(wrap(uB))))
    B = B[j0:] + B[:j0]
    uB = np.r_[uB[j0:], uB[:j0]]
    u = np.zeros(nb)
    u[0] = wrap(uB[0])
    for j in range(1, nb):
        u[j] = u[j - 1] + max(wrap(uB[j] - uB[j - 1]), 0.0)
    u = np.minimum(u, u[0] + LA)
    tris = []
    i = j = 0
    while i < na or j < nb:
        next_a = sA[i + 1] if i < na else np.inf
        next_b = (u[j + 1] if j + 1 < nb else u[0] + LA) if j < nb else np.inf
        if next_a <= next_b:
            tris.append([A[(i + 1) % na], A[i % na], B[j % nb]])
            i += 1
        else:
            tris.append([A[i % na], B[j % nb], B[(j + 1) % nb]])
            j += 1
    return np.array(tris)


def flip_folded_stitch_edges(V, T, limit_deg=100.0, passes=4):
    """
    缝合带内部的边（两侧都是缝合三角形）若折过 limit_deg，而换成四边形的另一条对角线后折得更小，就换。只改缝合三角形的连法，不动顶点、不动两条环。
    An edge inside the stitch band (stitch triangles on both sides) folded over limit_deg is flipped to the other diagonal of its
    quadrilateral when that folds less. Only the connectivity of stitch triangles changes; no vertex and neither loop is touched.
    """
    T = [list(t) for t in T]

    def nrm(t):
        n = np.cross(V[t[1]] - V[t[0]], V[t[2]] - V[t[0]])
        l = np.linalg.norm(n)
        return n / l if l > 1e-14 else None

    flips = 0
    for _ in range(passes):
        he = {}
        for ti, t in enumerate(T):
            for c in range(3):
                he[(t[c], t[(c + 1) % 3])] = (ti, t[(c + 2) % 3])
        edges = {(min(a, b), max(a, b)) for (a, b) in he}
        done = set()
        changed = False
        for (x, y), (t1, p_) in sorted(he.items()):
            if (y, x) not in he or t1 in done:
                continue
            t2, q_ = he[(y, x)]
            if t2 in done or t1 == t2:
                continue
            n1, n2 = nrm(T[t1]), nrm(T[t2])
            if n1 is None or n2 is None or n1 @ n2 > np.cos(np.radians(limit_deg)):
                continue
            a_, b_ = [x, q_, p_], [q_, y, p_]
            m1, m2 = nrm(a_), nrm(b_)
            if m1 is None or m2 is None or (min(p_, q_), max(p_, q_)) in edges or m1 @ m2 <= n1 @ n2:
                continue
            T[t1], T[t2] = a_, b_
            done.update((t1, t2))
            flips += 1
            changed = True
        if not changed:
            break
    return np.array(T), flips


def harmonic_extension(n_total, edges, lengths, known, unknown):
    """
    稀疏矩阵 M（|unknown| × |known|）：未知顶点的值 = M · 已知顶点的值，为图上的调和延拓（边权 1/长度）。
    Sparse M (|unknown| × |known|): value at the unknown vertices = M · value at the known ones, the harmonic
    extension on the graph (edge weight 1 / length).
    """
    A = graph(n_total, edges, 1.0 / np.maximum(lengths, 1e-6))
    L = sp.diags(np.asarray(A.sum(1)).ravel()) - A
    Lff = L[unknown][:, unknown].tocsc()
    Lfk = L[unknown][:, known].tocsc()
    solve = spla.factorized(Lff)
    rhs = -Lfk.toarray()
    return np.column_stack([solve(rhs[:, c]) for c in range(rhs.shape[1])])


# ── 包的状态 / the state of a package ───────────────────────────────────────────────────────────

class Package:
    def __init__(self, pkg):
        self.dir = pkg
        self.manifest = json.load(open(os.path.join(pkg, 'manifest.json')))
        self.joints = json.load(open(os.path.join(pkg, 'joints.json')))
        self.V, self.F, self.head = read_obj(os.path.join(pkg, 'skin.obj'))
        self.n0 = len(self.V)
        E, cnt = unique_edges(self.F, self.n0)
        if not (cnt == 2).all():
            raise SystemExit('skin.obj is not a closed manifold; grafting works on the closed skin')
        nj = len(self.joints['names'])
        rec = np.fromfile(os.path.join(pkg, 'weights.bin'), dtype=[('v', '<u4'), ('j', '<u4'), ('w', '<f4')])
        self.W = sp.coo_matrix((rec['w'].astype(np.float64), (rec['v'], rec['j'])), shape=(self.n0, nj)).tocsr()
        self.fields = {}
        for name in sorted(os.listdir(pkg)):
            if not name.endswith('.f32'):
                continue
            a = np.fromfile(os.path.join(pkg, name), dtype='<f4')
            if a.size == 3 * self.n0:
                a = a.reshape(self.n0, 3).astype(np.float64)
                is_pos = float(np.median(np.linalg.norm(a - self.V, axis=1))) < 0.05 and float(np.median(np.linalg.norm(a, axis=1))) > 0.2
                self.fields[name] = [a - self.V if is_pos else a, is_pos]
            elif a.size == self.n0:
                self.fields[name] = [a.astype(np.float64)[:, None], False]
        tp = os.path.join(pkg, 'vertex-tags.u8')
        self.tags = np.fromfile(tp, dtype=np.uint8) if os.path.exists(tp) else np.zeros(self.n0, np.uint8)
        sp_ = os.path.join(pkg, 'source-vertex.u32')
        self.src = np.fromfile(sp_, dtype='<u4').astype(np.int64) if os.path.exists(sp_) else np.arange(self.n0)
        self.groups = {'skin': np.ones(len(self.F), bool)}
        self.grafts = []
        self.pending = []
        self.collapsed = {}
        self.toe_fit = {}
        self.render_specs = {}  # 名字 → render-scene.ts 的说明 / name → a spec for render-scene.ts
        self.report = {}

    def joint(self, anatomical):
        for i, m in enumerate(self.joints.get('mapping', [])):
            if (m or {}).get('anatomical') == anatomical:
                return i
        return None

    def extend(self, P, M_cols, M, tag_values, nearest_src):
        """追加顶点；它们的逐顶点数据 = M · 列 M_cols 上顶点的数据 / append vertices; their per-vertex data = M · the data of the vertices M_cols"""
        ids = np.arange(len(self.V), len(self.V) + len(P))
        Ms = sp.csr_matrix(M)
        self.W = sp.vstack([self.W, Ms @ self.W[M_cols]]).tocsr()
        for name, (a, is_pos) in self.fields.items():
            self.fields[name][0] = np.vstack([a, M @ a[M_cols]])
        self.V = np.vstack([self.V, P])
        self.tags = np.r_[self.tags, np.asarray(tag_values, np.uint8)]
        self.src = np.r_[self.src, self.src[nearest_src]]
        return ids

    def write(self, out, steps):
        os.makedirs(out, exist_ok=True)
        nn = len(self.V)
        nj = self.W.shape[1]
        groups = [(g, self.F[m]) for g, m in self.groups.items() if m.any()]
        allF = np.concatenate([g[1] for g in groups])
        mod = '# modified by tools/skinopen/graft.py: %s; see manifest.json' % ', '.join(steps)
        write_obj(os.path.join(out, 'skin.obj'), self.V, groups, self.head + [mod])
        shutil.copyfile(os.path.join(self.dir, 'skin.obj'), os.path.join(out, 'skin-delivered.obj'))
        # 权重：每个顶点最多 7 个关节，重新归一 / weights: at most 7 joints a vertex, renormalised
        W = self.W.tocsr()
        rv, rj, rw = [], [], []
        for v in range(nn):
            lo, hi = W.indptr[v], W.indptr[v + 1]
            js, ws = W.indices[lo:hi], W.data[lo:hi]
            if v >= self.n0:
                keep = np.argsort(-ws)[:7]
                keep = keep[ws[keep] > 1e-5]
                js, ws = js[keep], ws[keep] / ws[keep].sum()
                o = np.argsort(js)
                js, ws = js[o], ws[o]
            rv.append(np.full(len(js), v))
            rj.append(js)
            rw.append(ws)
        rec = np.zeros(sum(len(x) for x in rv), dtype=[('v', '<u4'), ('j', '<u4'), ('w', '<f4')])
        rec['v'], rec['j'], rec['w'] = np.concatenate(rv), np.concatenate(rj), np.concatenate(rw)
        rec.tofile(os.path.join(out, 'weights.bin'))
        for name, (a, is_pos) in self.fields.items():
            b = a + self.V if is_pos else a
            (b if b.shape[1] == 3 else b[:, 0]).astype('<f4').tofile(os.path.join(out, name))
        self.tags.tofile(os.path.join(out, 'vertex-tags.u8'))
        self.src.astype('<u4').tofile(os.path.join(out, 'source-vertex.u32'))
        for name in sorted(os.listdir(self.dir)):
            p = os.path.join(self.dir, name)
            if not os.path.isfile(p) or name in ('skin.obj', 'weights.bin', 'manifest.json', 'shape-fields.json', 'vertex-tags.u8', 'source-vertex.u32') or name.endswith(('.f32', '.png', '.npz', '.log')):
                continue
            shutil.copyfile(p, os.path.join(out, name))
        sfp = os.path.join(self.dir, 'shape-fields.json')
        if os.path.exists(sfp):
            sf = json.load(open(sfp))
            if 'vertices' in sf:
                sf['vertices'] = nn
            sf['graftedBy'] = 'tools/skinopen/graft.py: fields extended to %d vertices (harmonic extension over the grafted patches)' % nn
            json.dump(sf, open(os.path.join(out, 'shape-fields.json'), 'w'), ensure_ascii=False, indent=1)
        m = json.loads(json.dumps(self.manifest))
        m['grafted'] = {
            'by': 'tools/skinopen/graft.py', 'steps': steps,
            'note': {
                'zh': '本包由皮肤包 %s 修改而来（Apache-2.0 第 4(b) 条的修改声明）：下列各片皮肤被切掉并换成了别的来源的表面；其来源、许可和顶点下标见 grafts。皮肤仍然闭合。被切掉的顶点仍在 skin.obj 里（下标不变），但不被任何三角形用到，标签为 removed。原皮肤原样保存在 skin-delivered.obj。' % os.path.basename(self.dir),
                'en': 'This package is a modification of the skin package %s (statement of changes under section 4(b) of the Apache License 2.0): the pieces of skin listed were cut out and replaced by surfaces from other sources; source, licence and vertex indices are under grafts. The skin is still closed. The vertices cut away remain in skin.obj (indices unchanged) but no triangle uses them, and they carry the tag removed. The skin as delivered is kept unchanged in skin-delivered.obj.' % os.path.basename(self.dir),
            },
            'sourceVertices': self.n0, 'vertices': nn, 'triangles': int(len(allF)), 'vertexTags': TAGS,
            'grafts': self.grafts,
            'removedVertices': {
                'note': {'zh': '被切掉的原顶点（标签 removed）：不被任何三角形用到。为安全起见，每个都并到了洞口环上最近的顶点（collapsedOnto 给出对应）：位置、权重、各逐顶点场都等于那个顶点。遍历三角形的程序看不到它们；遍历顶点的程序看到的是与一个真实顶点重合的点。', 'en': 'Delivered vertices cut away (tag removed): used by no triangle. To be safe each was collapsed onto the nearest vertex of the rim of its hole (collapsedOnto gives the pairing): position, weights and every per-vertex field equal that vertex. Code that walks triangles never sees them; code that walks vertices sees a point coincident with a real vertex.'},
                'vertices': sorted(self.collapsed), 'collapsedOnto': [self.collapsed[k] for k in sorted(self.collapsed)],
            },
            'fittedButNotGrafted': self.pending,
        }
        files = dict(m.get('files', {}))
        files['skin.obj'] = '%d vertices (0…%d as delivered, the rest appended; %d of them used by no triangle), %d triangles; groups: %s; closed: True' % (nn, self.n0 - 1, int((self.tags == TAGS['removed']).sum()), len(allF), ', '.join('%s %d' % (g[0], len(g[1])) for g in groups))
        files['skin-delivered.obj'] = 'the skin as delivered by tools/bodyshape, byte for byte'
        files['weights.bin'] = '%d records (uint32 vertex, uint32 joint, float32 weight), little endian; all %d vertices' % (len(rec), nn)
        files['vertex-tags.u8'] = 'uint8 [%d]: what each vertex is, see grafted.vertexTags' % nn
        files['source-vertex.u32'] = 'uint32 [%d]: itself for the delivered vertices; for a grafted vertex the nearest vertex on the rim of the hole it was stitched into (its per-vertex data are a harmonic extension from the whole rim, not a copy of that one vertex)' % nn
        files['graft-report.json'] = 'measurements of this run (tools/skinopen/graft.py)'
        m['files'] = files
        json.dump(m, open(os.path.join(out, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)

        # 检查图的说明文件（run.sh 用 render-scene.ts 画）；先清掉上一次留下的 / specs of the check renders (drawn by render-scene.ts from run.sh); those of an earlier run are removed first
        for name in os.listdir(out):
            if name.startswith('render-') and name.endswith('.json'):
                os.remove(os.path.join(out, name))
        for name, spec in sorted(self.render_specs.items()):
            json.dump(spec, open(os.path.join(out, 'render-%s.json' % name), 'w'))
        # 自检 / self-check
        V2, F2, _ = read_obj(os.path.join(out, 'skin.obj'))
        _, cnt = unique_edges(F2, nn)
        used = np.zeros(nn, bool)
        used[F2] = True
        r2 = np.fromfile(os.path.join(out, 'weights.bin'), dtype=[('v', '<u4'), ('j', '<u4'), ('w', '<f4')])
        sums = np.bincount(r2['v'], weights=r2['w'], minlength=nn)
        checks = {
            'objVertices': len(V2) == nn, 'closedManifold': bool((cnt == 2).all()), 'consistentWinding': len(half_edge_map(F2)) == 3 * len(F2),
            'noDegenerateTriangle': bool(((F2[:, 0] != F2[:, 1]) & (F2[:, 1] != F2[:, 2]) & (F2[:, 0] != F2[:, 2])).all()),
            'unusedVerticesAreExactlyTheRemovedOnes': bool(np.array_equal(~used, self.tags == TAGS['removed'])),
            'noTriangleReferencesARemovedVertex': bool(not np.isin(F2, np.where(self.tags == TAGS['removed'])[0]).any()),
            'removedVerticesCoincideWithAKeptVertex': bool(all(np.abs(V2[a] - V2[b]).max() == 0 and used[b] for a, b in self.collapsed.items())),
            'keptDeliveredVerticesUnmoved': bool(np.abs(V2[:self.n0] - read_obj(os.path.join(self.dir, 'skin.obj'))[0])[self.tags[:self.n0] != TAGS['removed']].max() < 2e-6),
            'weightsCoverEveryVertex': bool(np.abs(sums - 1).max() < 1e-4 and r2['j'].max() < nj),
            'weightsAtMost7Joints': bool(np.bincount(r2['v'], minlength=nn).max() <= 7),
            'fieldsLength': all(os.path.getsize(os.path.join(out, k)) in (4 * nn, 12 * nn) for k in self.fields),
            'keptDeliveredFieldsUnchanged': all(np.array_equal(np.fromfile(os.path.join(out, k), dtype='<f4').reshape(nn, -1)[:self.n0][self.tags[:self.n0] != TAGS['removed']], np.fromfile(os.path.join(self.dir, k), dtype='<f4').reshape(self.n0, -1)[self.tags[:self.n0] != TAGS['removed']]) for k in self.fields if not self.fields[k][1]),
            'licenceFilesPresent': any(f.upper().startswith('LICENSE') for f in os.listdir(out)),
        }
        import igl
        vol = lambda V_, F_: float(np.einsum('ij,ij->i', V_[F_[:, 0]], np.cross(V_[F_[:, 1]], V_[F_[:, 2]])).sum() / 6)
        self.report['result'] = {'vertices': nn, 'triangles': int(len(allF)), 'addedVertices': nn - self.n0, 'removedVertices': int((self.tags == TAGS['removed']).sum()),
                                 'enclosedVolumeL': {'delivered': round(vol(*read_obj(os.path.join(self.dir, 'skin.obj'))[:2]) * 1000, 3), 'grafted': round(vol(V2, F2) * 1000, 3)}}
        self.report['checks'] = checks
        json.dump(self.report, open(os.path.join(out, 'graft-report.json'), 'w'), ensure_ascii=False, indent=1)
        print(json.dumps(self.report, ensure_ascii=False, indent=1))
        bad = [k for k, v in checks.items() if v is False]
        if bad:
            print('FAILED checks: ' + ', '.join(bad), file=sys.stderr)
            sys.exit(1)


# ── 通用的移植 / the generic graft ───────────────────────────────────────────────────────────────

def graft(pk, DV, DF, seeds, name, differ_mm=2.5, reach_mm=120.0, grow_rings=3, blend_mm=10.0, rigid_joint=None, rigid_from_mm=10.0, rigid_full_mm=30.0, tag_patch='graftScanned', donor_include=None, skin_region=None, rim_gap_mm=None):
    """
    pk 皮肤包状态；DV、DF 供体（已在我们的坐标系里，法线朝外）；seeds 种子点（要换掉的区域围着它们）。
    rigid_joint：离洞口 rigid_full_mm 以外的供体顶点完全跟随这个关节（悬垂的部分）。
    pk the package state; DV, DF the donor (in our frame, normals outward); seeds the points the region to
    replace lies round. rigid_joint: donor vertices further than rigid_full_mm from the rim follow this joint
    entirely (pendulous parts).
    """
    import igl
    V, F = pk.V, pk.F
    nv = len(V)
    live = pk.groups['skin'].copy()
    Fl = F[live]
    A, E = vertex_graph(nv, Fl)
    DF, holes = fill_small_holes(DF)
    n_donor_faces = len(DF) - sum(k - 2 for k in holes)
    DVc, DFc = np.ascontiguousarray(DV), np.ascontiguousarray(DF)
    used = np.zeros(nv, bool)
    used[Fl] = True
    # 1. 皮肤上的区域 / the region on the skin
    d2 = igl.point_mesh_squared_distance(np.ascontiguousarray(V), DVc, DFc)[0]
    dist = np.sqrt(d2)
    near = cKDTree(seeds).query(V)[0] < reach_mm * MM
    cand = used & near & (dist > differ_mm * MM)
    if skin_region is not None:
        # 调用者直接给出皮肤上要换掉的顶点（按对应关系定，而不是按距离）/ the caller names the skin vertices to replace (by correspondence rather than by distance)
        cand = used & np.r_[skin_region, np.zeros(nv - len(skin_region), bool)]
    idx = np.where(cand)[0]
    ncomp, lab = csgraph.connected_components(A[idx][:, idx], directed=False)
    seed_v = idx[np.argmin(cKDTree(seeds).query(V[idx])[0])]
    region = np.zeros(nv, bool)
    region[idx[lab == lab[np.where(idx == seed_v)[0][0]]]] = True
    region = grow(region, A, grow_rings) & used
    region = fill_holes(region, A, used)
    region = single_loop_region(region, Fl, A, 'skin')
    cut = live & region[F].all(1)  # 要删的三角形 / triangles to remove
    removed_v = region & ~np.isin(np.arange(nv), np.unique(F[live & ~cut]))
    # 洞口的环：沿剩余皮肤三角形的方向 / the rim of the hole, in the direction of the remaining skin triangles
    loopA = ordered_loop(F[cut])[::-1]  # 被删三角形的边界反过来 = 剩余皮肤的方向 / the boundary of the removed triangles reversed = the direction of the remaining skin
    # 2. 供体片 / the donor patch
    nd = len(DV)
    Sv, Sf = np.ascontiguousarray(V), np.ascontiguousarray(Fl)
    _, fi, _ = igl.point_mesh_squared_distance(DVc, Sv, Sf)
    cut_live = cut[live]
    dmask = cut_live[fi]
    dused = np.zeros(nd, bool)
    dused[DF] = True
    if donor_include is not None:
        # 调用者指定必须在供体片里的顶点（如游离趾）/ donor vertices the caller requires in the patch (e.g. the free toes)
        dmask = dmask | donor_include
    dmask &= dused
    if rim_gap_mm is not None:
        # 供体片的边缘要留在洞内、离洞口环至少 rim_gap_mm：否则两条环在同一张曲面上相交或相贴，缝合三角形就会翻过来（折成 180°）。
        # 贴在皮肤上（2 mm 以内）而最近点不在被切掉的三角形上的供体顶点在洞外，同样去掉。
        # The rim of the patch must stay inside the hole, at least rim_gap_mm from the rim of the hole: otherwise the two loops cross or
        # touch on the same surface and stitch triangles come out flipped (folded through 180°). Donor vertices lying on the skin (within
        # 2 mm) whose closest point is not on a removed triangle are outside the hole and are dropped as well.
        rim_pts = []
        for a_, b_ in zip(loopA, loopA[1:] + loopA[:1]):
            n_ = max(2, int(np.ceil(np.linalg.norm(V[a_] - V[b_]) / (0.25 * rim_gap_mm * MM))))
            rim_pts.append(V[a_] + np.outer(np.arange(n_) / n_, V[b_] - V[a_]))
        d_rim = cKDTree(np.vstack(rim_pts)).query(DV)[0]
        d_skin = np.sqrt(igl.point_mesh_squared_distance(DVc, Sv, Sf)[0])
        dmask &= (d_rim > rim_gap_mm * MM) & ~(~cut_live[fi] & (d_skin < 0.002))
    Ad, _ = vertex_graph(nd, DF)
    idx = np.where(dmask)[0]
    ncomp, lab = csgraph.connected_components(Ad[idx][:, idx], directed=False)
    seed_d = idx[np.argmin(cKDTree(seeds).query(DV[idx])[0])]
    dreg = np.zeros(nd, bool)
    dreg[idx[lab == lab[np.where(idx == seed_d)[0][0]]]] = True
    dreg = fill_holes(dreg, Ad, dused)
    dreg = single_loop_region(dreg, DF, Ad, 'donor')
    psel = dreg[DF].all(1)
    pf = DF[psel]
    filled_in_patch = int(psel[n_donor_faces:].sum())
    pv = np.unique(pf)
    # 供体片必须是完好的一片：片内不能有供体自己的边界 / the patch must be whole: no boundary of the donor itself inside it
    loopB_d = ordered_loop(pf)[::-1]
    # 3. 过渡环：靠边的顶点向皮肤靠拢 / the blend ring: vertices near the rim move towards the skin
    local = -np.ones(nd, np.int64)
    local[pv] = np.arange(len(pv))
    P = DV[pv].copy()
    pfl = local[pf]
    Gp, Ep = vertex_graph(len(pv), pfl, P)
    rim_local = local[loopB_d]
    geo = csgraph.dijkstra(Gp, indices=rim_local, min_only=True)
    x = np.clip(1 - geo / (blend_mm * MM), 0, 1)
    wgt = x * x * (3 - 2 * x)
    _, _, cp = igl.point_mesh_squared_distance(np.ascontiguousarray(P), Sv, Sf)
    moved = np.linalg.norm(cp - P, axis=1) * wgt
    P = P + (cp - P) * wgt[:, None]
    blend = wgt > 0
    if rim_gap_mm is not None:
        # 片缘那一圈顶点（过渡环的最外圈，本来就是构造物）沿环理顺：反复取环上前后两点的平均、再落回皮肤的最近点。
        # 片缘参差时，缝合三角形会有翻过来的。
        # The outermost loop of the patch (the outer row of the blend ring, construction in any case) is evened out along itself: repeatedly
        # the mean with its two neighbours on the loop, then back to the closest point of the skin. With a ragged rim some stitch triangles
        # come out flipped.
        rl = np.array(rim_local)
        for _ in range(5):
            Q = 0.5 * P[rl] + 0.25 * (P[np.roll(rl, 1)] + P[np.roll(rl, -1)])
            P[rl] = igl.point_mesh_squared_distance(np.ascontiguousarray(Q), Sv, Sf)[2]
    # 4. 追加顶点，缝合 / append the vertices and zip
    rimA = np.array(loopA)
    Vall = np.vstack([V, P])
    ids = np.arange(nv, nv + len(pv))
    stitch_flips = 0
    if rim_gap_mm is not None:
        zf, stitch_flips = flip_folded_stitch_edges(Vall, zipper_by_parameter(Vall, loopA, list(ids[rim_local])))
    else:
        zf = zipper(Vall, loopA, Vall, list(ids[rim_local]))
    patch_faces = ids[pfl]
    # 调和延拓：已知 = 洞口环上的皮肤顶点，未知 = 供体片的全部顶点；图 = 供体片的边 + 缝合三角形的边
    # harmonic extension: known = the skin vertices on the rim of the hole, unknown = every patch vertex; graph = patch edges + zip edges
    sub = np.concatenate([patch_faces, zf])
    Es, _ = unique_edges(sub, len(Vall))
    Ls = np.linalg.norm(Vall[Es[:, 0]] - Vall[Es[:, 1]], axis=1)
    M = harmonic_extension(len(Vall), Es, Ls, rimA, ids)
    M = np.clip(M, 0, None)
    M /= M.sum(1, keepdims=True)
    nearest_rim = rimA[np.argmax(M, axis=1)]
    tagv = np.where(blend, TAGS['graftBlend'], TAGS[tag_patch])
    new_ids = pk.extend(P, rimA, M, tagv, nearest_rim)
    assert np.array_equal(new_ids, ids)
    # 悬垂部分跟随一个关节 / pendulous parts follow one joint
    rigid = None
    if rigid_joint is not None:
        g = np.clip((geo - rigid_from_mm * MM) / ((rigid_full_mm - rigid_from_mm) * MM), 0, 1)
        g = g * g * (3 - 2 * g)
        W = pk.W.tolil()
        nj = pk.W.shape[1]
        Wp = pk.W[ids].toarray() * (1 - g)[:, None]
        Wp[:, rigid_joint] += g
        pk.W = sp.vstack([pk.W[:nv], sp.csr_matrix(Wp)]).tocsr()
        rigid = {'joint': pk.joints['names'][rigid_joint], 'verticesFullyRigid': int((g >= 1).sum()), 'verticesBlended': int(((g > 0) & (g < 1)).sum())}
    # 更新三角形和分组 / update triangles and groups
    nf_old = len(F)
    pk.F = np.vstack([F, patch_faces, zf])
    for gname in list(pk.groups):
        pk.groups[gname] = np.r_[pk.groups[gname], np.zeros(len(patch_faces) + len(zf), bool)]
    pk.groups['skin'][:nf_old] &= ~cut
    gp = np.zeros(len(pk.F), bool)
    gp[nf_old:nf_old + len(patch_faces)] = True
    gz = np.zeros(len(pk.F), bool)
    gz[nf_old + len(patch_faces):] = True
    pk.groups[name] = gp
    pk.groups[name + 'Stitch'] = gz
    pk.tags[np.where(removed_v)[0]] = TAGS['removed']
    # 被切掉的顶点不再属于任何三角形。为了让按顶点遍历的程序（包围盒、最近顶点、按位置焊接）不出错，把它们并到洞口环上
    # 最近的那个顶点：位置、权重、各场都取那个顶点的值。下标不变。
    # The vertices cut away belong to no triangle any more. So that code walking the vertices (bounding boxes, nearest
    # vertex, welding by position) cannot go wrong, each is collapsed onto the nearest vertex of the rim of the hole:
    # position, weights and every field take that vertex's values. Indices do not change.
    rem = np.where(removed_v)[0]
    if len(rem):
        tgt = rimA[cKDTree(V[rimA]).query(V[rem])[1]]
        pk.V[rem] = pk.V[tgt]
        Wl = pk.W.tolil()
        Wl[rem] = pk.W[tgt]
        pk.W = Wl.tocsr()
        for fname in pk.fields:
            pk.fields[fname][0][rem] = pk.fields[fname][0][tgt]
        pk.src[rem] = pk.src[tgt]
        pk.collapsed.update({int(a): int(b) for a, b in zip(rem, tgt)})
    info = {
        'name': name,
        'patchVertices': [int(v) for v in ids[~blend]], 'blendRingVertices': [int(v) for v in ids[blend]],
        'rimOfHole': [int(v) for v in rimA], 'rimOfPatch': [int(v) for v in ids[rim_local]],
        'removedVertices': [int(v) for v in np.where(removed_v)[0]],
        '_donorIndex': pv,  # 供体片各顶点在供体里的下标（调用者取走，不进 manifest）/ donor indices of the patch vertices (taken by the caller, not written to the manifest)
    }
    zl = np.linalg.norm(Vall[zf][:, [0, 1, 2]] - Vall[zf][:, [1, 2, 0]], axis=2)
    stats = {
        'regionRule': 'skin vertices more than %g mm from the donor, connected round the seeds within %g mm, grown by %d rings, holes filled' % (differ_mm, reach_mm, grow_rings),
        'removedTriangles': int(cut.sum()), 'removedVertices': int(removed_v.sum()),
        'patchVertices': int(len(pv)), 'patchTriangles': int(len(pf)), 'stitchTriangles': int(len(zf)),
        'rimOfHoleVertices': len(loopA), 'rimOfPatchVertices': len(loopB_d),
        'rimMismatchMm': {'what': 'distance of the rim of the patch from the skin before blending', 'median': round(float(np.median(np.linalg.norm(cp - DV[pv], axis=1)[rim_local])) / MM, 2), 'max': round(float(np.linalg.norm(cp - DV[pv], axis=1)[rim_local].max()) / MM, 2)},
        'blendRing': {'widthMm': blend_mm, 'vertices': int(blend.sum()), 'movedMm': {'median': round(float(np.median(moved[blend])) / MM, 2), 'max': round(float(moved.max()) / MM, 2)}},
        'unmovedDonorVertices': int((~blend).sum()),
        'donorHolesFilled': {'what': 'triangles added inside the patch to close small holes of the donor mesh (fans over boundary loops of at most 40 edges; construction)', 'trianglesInPatch': filled_in_patch, 'holesInWholeDonor': len(holes)},
        'stitchEdgeMm': {'median': round(float(np.median(zl)) / MM, 2), 'max': round(float(zl.max()) / MM, 2)},
        'stitchEdgesFlipped': stitch_flips,
        'patchEdgeMm': {'median': round(float(np.median(Ls)) / MM, 2)},
        'rigid': rigid,
    }
    return info, stats, ids, geo


# ── 步骤：男性外生殖器 / step: male external genitalia ───────────────────────────────────────────

def bp3d_outer_skin(bp3d_dir):
    """BodyParts3D FJ2810 的外壁，换到我们的坐标系：(x, z, −y) 毫米 → 米 / the outer wall of BodyParts3D FJ2810 in our frame: (x, z, −y) mm → m"""
    path = None
    for sub in ('isa_BP3D_4.0_obj_99', 'partof_BP3D_4.0_obj_99'):
        p = os.path.join(bp3d_dir, sub, 'FJ2810.obj')
        if os.path.exists(p):
            path = p
            break
    if not path:
        raise SystemExit('BodyParts3D FJ2810.obj not found under %s' % bp3d_dir)
    V, F, head = read_obj(path)
    V = np.c_[V[:, 0], V[:, 2], -V[:, 1]] / 1000.0
    A, _ = vertex_graph(len(V), F)
    n, lab = csgraph.connected_components(A, directed=False)
    fl = lab[F[:, 0]]
    cnt = np.bincount(fl, minlength=n)
    two = np.argsort(cnt)[-2:]
    # 外壁 = 两大块里包围盒更大的那一块 / the outer wall = of the two big pieces the one with the larger bounding box
    outer = max(two, key=lambda c: float(np.ptp(V[lab == c], axis=0).sum()))
    Fo = F[fl == outer]
    vol = float(np.einsum('ij,ij->i', V[Fo[:, 0]], np.cross(V[Fo[:, 1]], V[Fo[:, 2]])).sum() / 6)
    if vol < 0:
        Fo = Fo[:, ::-1]
    licence_line = next((h for h in head if 'license' in h.lower()), '')
    return V, Fo, os.path.relpath(path, bp3d_dir), licence_line.lstrip('# ').strip()


# ── 步骤：足趾 / step: the toes ──────────────────────────────────────────────────────────────────

ORDINAL = ['big', 'second', 'third', 'fourth', 'little']


def donor_toes(V, F, t, min_size=25):
    """
    把供体脚的五个脚趾分出来：沿脚的长轴从趾尖向后扫，新出现的连通块是一个脚趾，两块相连处就是趾蹼。
    Separates the five toes of the donor foot: sweeping back from the tips along the long axis of the foot, a
    new connected piece is a toe and two pieces meeting marks a web.
    """
    order = np.argsort(-t)
    A, _ = vertex_graph(len(V), F)
    A = A.tocsr()
    parent = -np.ones(len(V), np.int64)
    members = {}
    toes = []

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    frozen = set()
    for v in order:
        parent[v] = v
        members[v] = [v]
        roots = set(find(u) for u in A.indices[A.indptr[v]:A.indptr[v + 1]] if parent[u] >= 0)
        roots.discard(v)
        big = [r for r in roots if len(members[r]) >= min_size]
        if len(big) >= 2:
            for r in big:
                if r not in frozen and not any(set(members[r]) & set(tv) for tv, _ in toes):
                    toes.append((list(members[r]), float(t[v])))
        for r in roots:
            members[v] += members.pop(r)
            parent[r] = v
        if len(big) >= 2:
            frozen.add(v)
        if len(toes) >= 5:
            break
    return toes


class Chain:
    """一条折线（趾尖 → 各趾间关节 → 跖趾关节），按弧长取点和坐标架；两端沿切向外推 / a polyline (toe tip → interphalangeal joints → metatarsophalangeal joint) evaluated by arc length with a frame; extrapolated along the tangent at both ends"""

    def __init__(self, pts, up):
        self.p = np.asarray(pts)
        self.l = np.r_[0, np.cumsum(np.linalg.norm(np.diff(self.p, axis=0), axis=1))]
        self.up = up

    def point(self, s):
        s = np.asarray(s, float)
        out = np.stack([np.interp(s, self.l, self.p[:, k]) for k in range(3)], 1)
        d0 = (self.p[0] - self.p[1]) / np.linalg.norm(self.p[0] - self.p[1])
        d1 = (self.p[-1] - self.p[-2]) / np.linalg.norm(self.p[-1] - self.p[-2])
        out += np.minimum(s, 0)[:, None] * -d0 + np.maximum(s - self.l[-1], 0)[:, None] * d1
        return out

    def frame(self, s, h=0.003):
        # 切向在关节处平滑（前后各 3 mm 取差）/ the tangent is smoothed across the joints (difference over 3 mm either way)
        t = self.point(np.asarray(s) + h) - self.point(np.asarray(s) - h)
        t /= np.linalg.norm(t, axis=1, keepdims=True)
        u = self.up[None] - (t @ self.up)[:, None] * t
        u /= np.linalg.norm(u, axis=1, keepdims=True)
        return t, u, np.cross(t, u)

    def project(self, Q):
        """点到折线的最近点：弧长和径向距离 / closest point of the polyline: arc length and radial distance"""
        best_s, best_d = np.zeros(len(Q)), np.full(len(Q), np.inf)
        for i in range(len(self.p) - 1):
            a, b = self.p[i], self.p[i + 1]
            ab = b - a
            t = np.clip(((Q - a) @ ab) / (ab @ ab), 0, 1)
            d = np.linalg.norm(Q - (a + t[:, None] * ab), axis=1)
            m = d < best_d
            best_d[m], best_s[m] = d[m], self.l[i] + t[m] * (self.l[i + 1] - self.l[i])
        return best_s, best_d


def main():
    ap = argparse.ArgumentParser(description='Graft patches of other surfaces into the closed skin of a package (writes <package>-grafted/).')
    ap.add_argument('package')
    ap.add_argument('--steps', required=True, help='comma-separated: genital (male), vulva (female), toes (both)')
    ap.add_argument('--foot', default='data/raw/bodyshape/out/skinopen-donors/hbm-foot-realistic.npz', help='donor foot written by tools/skinopen/export-foot.py')
    ap.add_argument('--wu', default='data/raw/female/pelvic_floor/wu2015_obj', help='directory of the OBJ files of Wu et al. 2015')
    ap.add_argument('--out')
    ap.add_argument('--deep', help='deep-face.json from tools/skinopen/export-deep.ts')
    ap.add_argument('--bp3d', default='data/raw/bodyparts3d', help='directory of BodyParts3D 4.0')
    args = ap.parse_args()
    pkg = os.path.normpath(args.package)
    out = os.path.normpath(args.out) if args.out else pkg + '-grafted'
    deep = json.load(open(args.deep)) if args.deep and os.path.exists(args.deep) else None
    pk = Package(pkg)
    steps = [s for s in args.steps.split(',') if s]
    for s in steps:
        if s == 'genital':
            from genital import step_genital  # 在这里才引入：genital.py 要用本文件里的函数 / imported here because genital.py uses functions of this file
            step_genital(pk, deep, args.bp3d)
        elif s == 'vulva':
            from vulva import step_vulva  # 同上 / likewise
            step_vulva(pk, deep, args.wu, out)
        elif s == 'toes':
            from toes import step_toes  # 在这里才引入：toes.py 要用本文件里的函数 / imported here because toes.py uses functions of this file
            step_toes(pk, deep, args.foot, out)
        else:
            raise SystemExit('unknown step "%s"' % s)
    pk.write(out, steps)


if __name__ == '__main__':
    main()
