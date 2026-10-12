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
#   genital   男性外生殖器的皮肤：取自他本人的扫描皮肤（BodyParts3D FJ2810 的外壁）。
#             the skin of the male external genitalia, from his own scanned skin (outer wall of BodyParts3D FJ2810)
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

def graft(pk, DV, DF, seeds, name, differ_mm=2.5, reach_mm=120.0, grow_rings=3, blend_mm=10.0, rigid_joint=None, rigid_from_mm=10.0, rigid_full_mm=30.0, tag_patch='graftScanned'):
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
    dmask &= dused
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
    # 4. 追加顶点，缝合 / append the vertices and zip
    rimA = np.array(loopA)
    Vall = np.vstack([V, P])
    ids = np.arange(nv, nv + len(pv))
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


def step_genital(pk, deep, bp3d_dir):
    import igl
    if (pk.manifest.get('fittedTo') or {}).get('body') != 'male':
        raise SystemExit('step genital is for the male body')
    parts = [p for p in (deep or {}).get('parts', []) if p['group'] == 'genitalMale']
    if not parts:
        raise SystemExit('step genital needs the male genital parts in deep-face.json (tools/skinopen/export-deep.ts)')
    ext = [np.array(p['positions']).reshape(-1, 3) for p in parts if re.search(r'glans|testis|epididymis', p['name'], re.I)]
    seeds = np.concatenate(ext)
    DV, DF, rel, licence_line = bp3d_outer_skin(bp3d_dir)
    V0, F0 = pk.V.copy(), pk.F.copy()
    info, stats, ids, geo = graft(pk, DV, DF, seeds, 'genitalSkin', grow_rings=3, rigid_joint=pk.joint('pelvis'))
    live = np.zeros(len(pk.F), bool)
    for g in pk.groups.values():
        live |= g
    Vn, Fn = np.ascontiguousarray(pk.V), np.ascontiguousarray(pk.F[live])
    cover = {}
    for p in parts:
        P = np.ascontiguousarray(np.array(p['positions']).reshape(-1, 3))
        row = {}
        for label, (Vx, Fx) in (('donor', (np.ascontiguousarray(DV), np.ascontiguousarray(DF))), ('delivered', (np.ascontiguousarray(V0), np.ascontiguousarray(F0))), ('grafted', (Vn, Fn))):
            s = igl.signed_distance(P, Vx, Fx)[0]
            row[label] = {'leastCoverMm': round(float(-s.max()) / MM, 2), 'medianCoverMm': round(float(-np.median(s)) / MM, 2), 'shareOutside': round(float((s > 0).mean()), 4)}
        cover['%s (%s)' % (p['name'], p['id'])] = row
    # 大腿间隙：悬垂部分（离洞口 30 mm 以外的供体顶点）到其余皮肤的最近距离
    # thigh gap: closest approach of the pendulous part (patch vertices further than 30 mm from the rim) to the rest of the skin
    rest = np.ascontiguousarray(pk.F[pk.groups['skin']])
    far = ids[geo > 30 * MM]
    d2, fi, cp = igl.point_mesh_squared_distance(np.ascontiguousarray(pk.V[far]), Vn, rest)
    d = np.sqrt(d2)
    k = int(np.argmin(d))
    s_rest = igl.signed_distance(np.ascontiguousarray(pk.V[ids]), np.ascontiguousarray(V0), np.ascontiguousarray(F0))[0]
    stats['thighGap'] = {
        'what': 'closest approach of patch vertices more than 30 mm from the rim to the remaining skin',
        'leastMm': round(float(d.min()) / MM, 2), 'at': [round(float(v), 4) for v in pk.V[far[k]]], 'nearestSkinPoint': [round(float(v), 4) for v in cp[k]],
        'shareWithin2Mm': round(float((d < 2 * MM).mean()), 4), 'shareWithin5Mm': round(float((d < 5 * MM).mean()), 4),
    }
    stats['patchAgainstDeliveredSkinMm'] = {'what': 'signed distance of the patch vertices from the delivered (mound) skin; positive = outside it', 'min': round(float(s_rest.min()) / MM, 1), 'median': round(float(np.median(s_rest)) / MM, 1), 'max': round(float(s_rest.max()) / MM, 1)}
    stats['coverOverGenitalParts'] = cover
    info.update({
        'provenance': 'scanned',
        'what': {'zh': '男性外生殖器的皮肤（阴茎、阴囊及其周围）：取自他本人的扫描皮肤，BodyParts3D 4.0 的 FJ2810（Skin）外壁，位置未作任何改动（patchVertices）；靠边一圈顶点（blendRingVertices）被移到与拟合皮肤相接，属于构造物。', 'en': 'The skin of the male external genitalia (penis, scrotum and surroundings): from his own scanned skin, the outer wall of FJ2810 (Skin) of BodyParts3D 4.0, positions unchanged (patchVertices); the band of vertices at the rim (blendRingVertices) was moved to meet the fitted skin and is a construction aid.'},
        'source': {'name': 'BodyParts3D 4.0', 'file': rel, 'url': 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html', 'licenceLineInFile': licence_line, 'licenceNote': BP3D_LICENCE_NOTE, 'frame': '(x, z, −y) mm → m'},
        'weights': {'zh': '权重从洞口环上调和延拓；离洞口 10 mm 起逐渐、30 mm 以外完全跟随骨盆（关节 %s）。阴茎和阴囊因此随骨盆刚性运动，不下垂、不摆动、不随大腿让开。' % pk.joints['names'][pk.joint('pelvis')], 'en': 'Weights are a harmonic extension from the rim of the hole; from 10 mm off the rim they turn, and beyond 30 mm they are entirely, the pelvis (joint %s). Penis and scrotum therefore move rigidly with the pelvis: they do not hang, swing or give way to the thighs.' % pk.joints['names'][pk.joint('pelvis')]},
        'fields': {'zh': '体型场（shape-*.f32 等）同样从洞口环调和延拓。', 'en': 'Shape fields (shape-*.f32 and the others) are extended harmonically from the rim likewise.'},
    })
    pk.grafts.append(info)
    pk.report['genital'] = stats


# ── 步骤：女性外阴的皮肤 / step: the female vulvar skin ──────────────────────────────────────────

# Wu 等 2015 的原始文件名（数据集里固定的名字）→ 管线里的部件 id（去掉 WU_ 和左右后缀）
# raw file names of Wu et al. 2015 (fixed names of the dataset) → part id in the pipeline (without WU_ and the side suffix)
WU_FILES = {
    'cavernous_body_of_clitoris': '39_Cavernous_body_of_clitoris', 'vestibular_bulb': '38_Vestibular_bulb', 'vaginal_wall': '21_Vaginal_wall',
    'uterine_and_vaginal_lumen': '19_Uterine_and_vaginal_lumen', 'submucous_layer_of_urethra': '35_Submucous_layer_of_urethra',
    'urethral_sphincter_proper': '31_Urethral_sphincter_proper', 'perineal_body': '24_Perineal_body', 'external_anal_sphincter': '13_External_anal_sphincter',
    'internal_anal_sphincter': '11_Internal_anal_sphincter_', 'bulbospongiosus_muscle': '37_Bulbospongiosus_muscle', 'ischiocavernous_muscle': '36_Ischiocavernous_muscle',
    'bartholin_gland': '22_Bartholin_s_gland', 'superficial_transverse_perineal_muscle': '26_Superficial_transverse_perineal_muscle',
    'deep_perineal_muscle': '25_Deep_perineal_muscle', 'urethro_vaginal_sphincter': '34_Urethro_vaginal_sphincter', 'urethral_compressor_muscle': '33_Urethral_compressor_muscle',
}
WU_SOURCE = {'name': 'Wu et al. 2015, female pelvic floor (PLoS ONE 10(7): e0132226; correction e0140736)', 'url': 'https://doi.org/10.1371/journal.pone.0132226', 'license': 'CC BY 4.0', 'file': '46_Skin.obj'}
KREKLAU = {'source': 'Kreklau et al. 2018, BJOG, doi:10.1111/1471-0528.15387, n = 657; mean ± SD, mm',
           'labiaMajoraLength': [79.7, 15.3], 'labiaMinoraLength': [42.5, 16.3], 'labiaMinoraWidth': [13.8, 7.8], 'clitorisToUrethralOrifice': [22.6, 7.7], 'introitus': [27.9, 10.4], 'perineum': [21.3, 8.5]}


def fit_specimen_map(raw, shipped):
    """
    原始标本坐标 → 本体坐标的映射：先仿射（由各结构的质心起步，再按最近点迭代），再加一个平滑的残差场。
    从发布的 WU_* 部件对原始 OBJ 求得，不重做管线的骨场。
    The map from raw specimen coordinates to the body: an affine map (started from the centroids of the
    structures, refined by closest points) plus a smooth residual field. Derived from the shipped WU_* parts
    against the raw OBJ files; the pipeline's bone field is not re-implemented.
    """
    stems = sorted(set(raw) & set(shipped))
    A = np.c_[np.array([raw[s].mean(0) for s in stems]), np.ones(len(stems))]
    X = np.linalg.lstsq(A, np.array([shipped[s].mean(0) for s in stems]), rcond=None)[0]
    trees = {s: cKDTree(shipped[s]) for s in stems}
    rng = np.random.RandomState(0)
    sub = {s: raw[s][rng.choice(len(raw[s]), min(len(raw[s]), 1500), replace=False)] for s in stems}
    for _ in range(12):
        P, Q = [], []
        for s in stems:
            t = np.c_[sub[s], np.ones(len(sub[s]))] @ X
            d, j = trees[s].query(t)
            keep = d < np.percentile(d, 90)
            P.append(sub[s][keep])
            Q.append(shipped[s][j[keep]])
        P, Q = np.concatenate(P), np.concatenate(Q)
        X = np.linalg.lstsq(np.c_[P, np.ones(len(P))], Q, rcond=None)[0]
    res_affine = {}
    ctr, vec = [], []
    for s in stems:
        t = np.c_[sub[s], np.ones(len(sub[s]))] @ X
        d, j = trees[s].query(t)
        res_affine[s] = round(float(np.median(d)) / MM, 2)
        ctr.append(t)
        vec.append(shipped[s][j] - t)
    ctr, vec = np.concatenate(ctr), np.concatenate(vec)
    sigma = 0.012
    tree = cKDTree(ctr)

    def residual(Y):
        out = np.zeros_like(Y)
        for i, nb in enumerate(tree.query_ball_point(Y, 3 * sigma)):
            if nb:
                w = np.exp(-((ctr[nb] - Y[i]) ** 2).sum(1) / (2 * sigma ** 2))
                # 离锚点远处场衰减到 0，不外推 / the field fades to nothing away from the anchors: no extrapolation
                out[i] = (w[:, None] * vec[nb]).sum(0) / (w.sum() + 5.0)
        return out

    def apply(Y):
        t = np.c_[Y, np.ones(len(Y))] @ X
        return t + residual(t)

    res_final = {}
    for s in stems:
        d = trees[s].query(apply(sub[s]))[0]
        res_final[s] = round(float(np.median(d)) / MM, 2)
    L = X[:3].T
    U_, sv_, _ = np.linalg.svd(L)
    info = {'anchors': stems, 'scale': round(float(abs(np.linalg.det(L)) ** (1 / 3)) * 1000, 4), 'singularValues': [round(float(v) * 1000, 4) for v in sv_],
            'principalScales': [{'scale': round(float(sv_[i]) * 1000, 4), 'directionInBodyFrame': [round(float(v), 3) for v in U_[:, i]]} for i in range(3)],
            'scaleAlongBodyAxes': {'what': 'length of a unit raw vector after the map, measured for the raw directions that land on body X (width), Y (height), Z (depth)', 'x': round(float(1000 / np.linalg.norm(np.linalg.inv(L)[:, 0])), 4), 'y': round(float(1000 / np.linalg.norm(np.linalg.inv(L)[:, 1])), 4), 'z': round(float(1000 / np.linalg.norm(np.linalg.inv(L)[:, 2])), 4)},
            'scaleNote': 'the map is anisotropic because it is the composition of the pipeline\'s enlargement of the specimen (x 1.096) and the standardisation of the skeleton, which narrows the pelvis in width (x 0.886); all dimension checks use the installed size',
            'medianResidualMm': {'affine': res_affine, 'withSmoothField': res_final},
            'overallMedianResidualMm': {'affine': round(float(np.median(list(res_affine.values()))), 2), 'withSmoothField': round(float(np.median(list(res_final.values()))), 2)}}
    return apply, info


def taubin(V, F, fixed, iterations=10, lam=0.5, mu=-0.53):
    """Taubin 平滑：去掉台阶而不整体收缩；fixed 的顶点不动 / Taubin smoothing: removes the stair-steps without overall shrinkage; `fixed` vertices stay"""
    A, _ = vertex_graph(len(V), F)
    deg = np.maximum(np.asarray(A.sum(1)).ravel(), 1)
    P = V.copy()
    for _ in range(iterations):
        for f in (lam, mu):
            d = (A @ P) / deg[:, None] - P
            d[fixed] = 0
            P = P + f * d
    return P


def step_vulva(pk, deep, wu_dir, out_dir, max_rim_mm=5.0):
    import igl
    if (pk.manifest.get('fittedTo') or {}).get('body') != 'female':
        raise SystemExit('step vulva is for the female body')
    parts = [p for p in (deep or {}).get('parts', []) if p['group'] == 'wuAnchor']
    if len(parts) < 6:
        raise SystemExit('step vulva needs the WU_* anchor parts in deep-face.json (tools/skinopen/export-deep.ts)')
    shipped = {}
    for p in parts:
        stem = re.sub(r'^WU_|_[LR]$', '', p['id'])
        shipped.setdefault(stem, []).append(np.array(p['positions']).reshape(-1, 3))
    shipped = {k: np.concatenate(v) for k, v in shipped.items()}
    raw = {}
    for stem, fn in WU_FILES.items():
        f = os.path.join(wu_dir, fn + '.obj')
        if stem in shipped and os.path.exists(f):
            raw[stem] = read_obj(f)[0]
    apply, fit = fit_specimen_map(raw, shipped)
    SV, SF, _ = read_obj(os.path.join(wu_dir, WU_SOURCE['file']))
    # 切面盖：标本的皮肤块被一个平面截断，平面上的三角形不是皮肤 / the cap: the slab of specimen skin ends at a flat cut plane, whose triangles are not skin
    # 皮肤块的两头都可能是平的截面：某个坐标的极值处有 100 个以上三角形共面的，都算截面
    # either end of the slab may be a flat cut: wherever more than 100 triangles lie in the plane of an extreme coordinate, that is a cut plane
    on_cap = np.zeros(len(SV), bool)
    caps = []
    for ax in range(3):
        for end in (SV[:, ax].min(), SV[:, ax].max()):
            m = np.abs(SV[:, ax] - end) < 0.3
            nf = int(m[SF].all(1).sum())
            if nf > 100:
                on_cap |= m
                caps.append({'axis': 'xyz'[ax], 'atRaw': round(float(end), 2), 'triangles': nf})
    cap_faces = on_cap[SF].all(1)
    SFn = SF[~cap_faces]
    DV = apply(SV)
    vol = float(np.einsum('ij,ij->i', DV[SF[:, 0]], np.cross(DV[SF[:, 1]], DV[SF[:, 2]])).sum() / 6)
    if vol < 0:
        SFn = SFn[:, ::-1]
    # 会阴部的一片：离外阴深层结构 35 mm 以内的皮肤 / the perineal patch: skin within 35 mm of the deep structures of the vulva
    ext = np.concatenate([shipped[k] for k in ('cavernous_body_of_clitoris', 'vestibular_bulb', 'bartholin_gland', 'bulbospongiosus_muscle', 'perineal_body', 'external_anal_sphincter') if k in shipped])
    used = np.zeros(len(DV), bool)
    used[SFn] = True
    Ad, _ = vertex_graph(len(DV), SFn)
    sel = used & (cKDTree(ext).query(DV)[0] < 35 * MM)
    idx = np.where(sel)[0]
    ncomp, lab = csgraph.connected_components(Ad[idx][:, idx], directed=False)
    reg = np.zeros(len(DV), bool)
    reg[idx[lab == np.argmax(np.bincount(lab))]] = True
    reg = fill_holes(reg, Ad, used)
    # 这一片可能碰到标本皮肤自己的边（截面把皱襞的顶削掉的地方）：那样它就不是只有一个边界环的圆盘，不能移植，只能量
    # the patch may reach the specimen skin's own edge (where the cut plane sliced the crests of the folds off): it is then not a disc with one boundary loop and can be measured but not grafted
    try:
        reg = single_loop_region(reg, SFn, Ad, 'specimen skin')
        disc = True
    except RuntimeError:
        disc = False
    pf = SFn[reg[SFn].all(1)]
    pv = np.unique(pf)
    local = -np.ones(len(DV), np.int64)
    local[pv] = np.arange(len(pv))
    P0 = DV[pv]
    Fp = local[pf]
    hmp = half_edge_map(Fp)
    bedges = np.array([(a, b) for (a, b) in hmp if (b, a) not in hmp])
    rim = np.unique(bedges)
    on_cut = on_cap[pv]
    cut_edges = int((on_cut[bedges[:, 0]] & on_cut[bedges[:, 1]]).sum())
    fixed = np.zeros(len(pv), bool)
    fixed[rim] = True
    P = taubin(P0, Fp, fixed)
    moved = np.linalg.norm(P - P0, axis=1)
    # 与现有皮肤的差距 / the mismatch against the present skin
    Vc, Fc = np.ascontiguousarray(pk.V), np.ascontiguousarray(pk.F[pk.groups['skin']])
    s = igl.signed_distance(np.ascontiguousarray(P), Vc, Fc)[0]
    near_cap = cKDTree(DV[on_cap]).query(P)[0] if on_cap.any() else np.full(len(P), np.inf)
    edge = np.linalg.norm(P[Fp][:, [0, 1, 2]] - P[Fp][:, [1, 2, 0]], axis=2)
    stats = {
        'specimenMap': fit,
        'cutPlanes': {'what': 'flat cut planes of the specimen slab (not skin), removed', 'planes': caps, 'trianglesRemoved': int(cap_faces.sum())},
        'patch': {'vertices': int(len(pv)), 'triangles': int(len(pf)), 'rimVertices': int(len(rim)), 'boundaryLoops': boundary_loops(Fp, len(pv)), 'isDiscWithOneLoop': disc, 'boundaryEdgesOnACutPlane': cut_edges, 'medianEdgeMm': round(float(np.median(edge)) / MM, 2),
                  'rule': 'specimen skin within 35 mm of clitoral body, vestibular bulbs, greater vestibular glands, bulbospongiosus, perineal body and external anal sphincter (as installed)',
                  'closestToCutPlaneMm': round(float(near_cap.min()) / MM, 2), 'verticesWithin1MmOfCutPlane': int((near_cap < 1 * MM).sum())},
        'smoothing': {'method': 'Taubin, 10 iterations (λ 0.5, μ −0.53), rim fixed', 'movedMm': {'median': round(float(np.median(moved)) / MM, 2), 'p95': round(float(np.percentile(moved, 95)) / MM, 2), 'max': round(float(moved.max()) / MM, 2)}},
        'againstPresentSkinMm': {
            'what': 'signed distance of the fitted patch from the present closed skin; negative = inside the body (above the skin of the crotch)',
            'rim': {'median': round(float(np.median(s[rim])) / MM, 1), 'min': round(float(s[rim].min()) / MM, 1), 'max': round(float(s[rim].max()) / MM, 1), 'medianAbs': round(float(np.median(np.abs(s[rim]))) / MM, 1)},
            'whole': {'median': round(float(np.median(s)) / MM, 1), 'min': round(float(s.min()) / MM, 1), 'max': round(float(s.max()) / MM, 1)},
        },
    }
    # 尺寸（见 measure_vulva）/ dimensions (see measure_vulva)
    stats['dimensions'] = measure_vulva(P, Fp, shipped, fit['scale'])
    rim_abs = float(np.median(np.abs(s[rim]))) / MM
    # 交给皮肤作者的目标：这一片的外缘（有序的环）、各点的位置和向外的法线，以及这一片在各 WU_* 结构上的覆盖厚度
    # the hand-off to the skin's author: the outer rim of the patch (an ordered loop) with positions and outward normals, and the cover the patch gives over each WU_* structure
    nxt_ = {}
    for a_, b_ in bedges:
        nxt_.setdefault(int(a_), []).append(int(b_))
    loops_, seen_ = [], set()
    for st in sorted(nxt_):
        if st in seen_:
            continue
        lp, cur = [st], st
        seen_.add(st)
        while True:
            cand_ = [q for q in nxt_.get(cur, []) if q not in seen_]
            if not cand_:
                break
            cur = cand_[0]
            seen_.add(cur)
            lp.append(cur)
        loops_.append(lp)
    outer = max(loops_, key=len)
    fnp = np.cross(P[Fp[:, 1]] - P[Fp[:, 0]], P[Fp[:, 2]] - P[Fp[:, 0]])
    vn = np.zeros_like(P)
    for k_ in range(3):
        np.add.at(vn, Fp[:, k_], fnp)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-20)
    # 向外 = 背离深层结构 / outward = away from the deep structures
    if np.mean(np.einsum('ij,ij->i', vn, P - ext.mean(0))) < 0:
        vn = -vn
    Pp, Fpp = np.ascontiguousarray(P), np.ascontiguousarray(Fp)
    need = {}
    for p_ in parts:
        Q = np.ascontiguousarray(np.array(p_['positions']).reshape(-1, 3))
        d_ = np.sqrt(igl.point_mesh_squared_distance(Q, Pp, Fpp)[0])
        side_ = np.einsum('ij,ij->i', Q - P[cKDTree(P).query(Q)[1]], vn[cKDTree(P).query(Q)[1]])
        need[p_['id']] = {'closestToPatchMm': round(float(d_.min()) / MM, 2), 'shareOfVerticesOnTheOuterSide': round(float((side_[d_ < 0.01] > 0).mean()) if (d_ < 0.01).any() else 0.0, 3)}
    target = {
        'what': {'zh': '女性会阴皮肤片（Wu 等 2015 标本的皮肤，按已装入的 WU_* 结构定位并平滑）的外缘：皮肤作者把拟合皮肤的会阴抬高时要到达的位置。环是有序的；位置和法线在本体坐标系里（米，Y 向上，+Z 向前，+X 为身体左侧）；法线指向体外。onCutPlane 为 true 的点在标本皮肤块的截面上，不是真实的皮肤边缘，不要当作目标。', 'en': 'The outer rim of the female perineal skin patch (the skin of the specimen of Wu et al. 2015, positioned by the installed WU_* structures and smoothed): where the crotch of the fitted skin has to arrive when its author raises it. The loop is ordered; positions and normals are in the body frame (metres, Y up, +Z anterior, +X the body\'s left); normals point out of the body. Points with onCutPlane true lie on a cut plane of the specimen slab: they are not a real edge of skin and are not targets.'},
        'source': WU_SOURCE, 'toleranceForGraftingMm': max_rim_mm,
        'presentMismatchMm': {'medianAbs': round(rim_abs, 1), 'max': round(float(np.abs(s[rim]).max()) / MM, 1), 'sign': 'the patch lies inside the present skin (the present crotch is too low)'},
        'rimLoop': {'vertices': len(outer), 'positions': [[round(float(v), 5) for v in P[i]] for i in outer], 'outwardNormals': [[round(float(v), 4) for v in vn[i]] for i in outer], 'onCutPlane': [bool(on_cut[i]) for i in outer],
                    'signedDistanceFromPresentSkinMm': [round(float(s[i]) / MM, 1) for i in outer]},
        'coverOverDeepParts': {'what': 'closest approach of each installed WU_* anchor part to the patch (mm): the cover the patch gives, which a skin meeting this rim should not undercut', 'parts': need},
        'patchFile': 'vulva-patch.obj',
    }
    os.makedirs(out_dir, exist_ok=True)
    json.dump(target, open(os.path.join(out_dir, 'vulva-rim-target.json'), 'w'), ensure_ascii=False, indent=1)
    stats['rimTarget'] = {'file': 'vulva-rim-target.json', 'loopVertices': len(outer), 'onCutPlane': int(sum(target['rimLoop']['onCutPlane']))}
    os.makedirs(out_dir, exist_ok=True)
    write_obj(os.path.join(out_dir, 'vulva-patch.obj'), P, [('vulvaSkin', Fp)], ['# perineal skin of the specimen of Wu et al. 2015 (CC BY 4.0), 46_Skin.obj, mapped to the installed WU_* parts and smoothed by tools/skinopen/graft.py; metres, body frame'])
    if rim_abs > max_rim_mm or not disc:
        stats['grafted'] = False
        why = []
        if rim_abs > max_rim_mm:
            why.append('the rim of the patch lies a median %.1f mm from the present skin (limit %.1f mm): the crotch of the fitted skin must first be raised to her perineal structures; a blend across this distance was not attempted' % (rim_abs, max_rim_mm))
        if not disc:
            why.append('the patch is not a disc: %d of its boundary edges lie on a cut plane of the specimen slab, i.e. the specimen skin is truncated inside the patch and would have to be closed by construction first' % cut_edges)
        stats['notGraftedBecause'] = '; '.join(why)
        pk.pending.append({
            'name': 'vulvaSkin', 'status': 'fitted, not grafted', 'file': 'vulva-patch.obj', 'rimTarget': 'vulva-rim-target.json', 'reason': stats['notGraftedBecause'],
            'source': WU_SOURCE,
            'what': {'zh': '女性会阴部皮肤（取自 Wu 等 2015 标本的皮肤面，按已装入的 WU_* 部件定位，去台阶平滑）。目前没有接进皮肤：拟合皮肤的会阴位置比她的会阴结构低得多。文件 vulva-patch.obj 是定位后的这一片。', 'en': 'The female perineal skin (the skin surface of the specimen of Wu et al. 2015, positioned by the installed WU_* parts and smoothed). Not grafted for now: the crotch of the fitted skin lies far below her perineal structures. vulva-patch.obj holds the positioned patch.'},
        })
    else:
        info, gstats, ids, geo = graft(pk, P, Fp, ext, 'vulvaSkin', rigid_joint=None, tag_patch='graftScanned')
        stats['grafted'] = True
        stats['graft'] = gstats
        info.update({'provenance': 'curated', 'source': WU_SOURCE,
                     'what': {'zh': '女性会阴部皮肤：取自另一位女性标本（Wu 等 2015）的皮肤面，经放大、按骨配准并平滑，所以不是 scanned。', 'en': 'The female perineal skin: the skin surface of another woman\'s specimen (Wu et al. 2015), enlarged, fitted by bone and smoothed, hence not scanned.'}})
        pk.grafts.append(info)
    pk.report['vulva'] = stats


def measure_vulva(P, F, shipped, scale, enlarged=1.096):
    """
    能量的量：从下方看（−Y 朝外），沿前后方向（Z）每 2 mm 一片，量中线处裂的深度和两侧隆起的顶。
    标本的皮肤只标为 “Skin”，没有开口，也没有标出唇：这里只报告几何上能定义的量，并说明哪些认不出来。
    What can be measured: seen from below (−Y outward), in slices of 2 mm along the fore-aft direction (Z), the
    depth of the cleft at the midline and the crests of the folds beside it. The specimen's skin is labelled
    only "Skin", has no opening and no labelled labia: only geometrically definable quantities are reported,
    with a statement of what cannot be identified.
    """
    xm = float(np.median(np.concatenate([shipped[k] for k in ('perineal_body', 'external_anal_sphincter', 'cavernous_body_of_clitoris') if k in shipped])[:, 0]))
    rows = []
    for z0 in np.arange(P[:, 2].min(), P[:, 2].max(), 0.002):
        sl = P[(P[:, 2] >= z0) & (P[:, 2] < z0 + 0.002)]
        mid = sl[np.abs(sl[:, 0] - xm) < 0.004]
        L = sl[(sl[:, 0] - xm > 0.004) & (sl[:, 0] - xm < 0.035)]
        R = sl[(xm - sl[:, 0] > 0.004) & (xm - sl[:, 0] < 0.035)]
        if len(mid) and len(L) and len(R):
            iL, iR = np.argmin(L[:, 1]), np.argmin(R[:, 1])
            rows.append((z0 + 0.001, mid[:, 1].max() - (L[iL, 1] + R[iR, 1]) / 2, L[iL, 0] - R[iR, 0]))
    rows = np.array(rows)
    out = {'kreklau2018': KREKLAU, 'scaleOfTheMapFromTheObjFiles': scale,
           'note': {'zh': '数值都是装入后的尺寸，核对也用装入尺寸。映射是各向异性的（总体 %.3f）：管线先把标本放大 %.3f 倍，骨架标准化又把骨盆在宽度上缩到 0.886；所以 specimenScale（除以 %.3f）只是粗略的参考，横向的量不适用。' % (scale, enlarged, enlarged), 'en': 'All figures are at installed size, and the checks use the installed size. The map is anisotropic (%.3f overall): the pipeline enlarges the specimen %.3f times and the standardisation of the skeleton then narrows the pelvis to 0.886 in width; specimenScale (division by %.3f) is therefore only a rough guide and does not hold for transverse quantities.' % (scale, enlarged, enlarged)}}
    scale = enlarged
    if len(rows):
        deep_ = rows[rows[:, 1] > 0.003]
        if len(deep_):
            # 最长的连续一段 / the longest contiguous run
            runs, start = [], 0
            for i in range(1, len(deep_) + 1):
                if i == len(deep_) or deep_[i, 0] - deep_[i - 1, 0] > 0.0045:
                    runs.append((start, i))
                    start = i
            a, b = max(runs, key=lambda r: deep_[r[1] - 1, 0] - deep_[r[0], 0])
            run = deep_[a:b]
            length = float(run[-1, 0] - run[0, 0] + 0.002)
            out['cleft'] = {'what': 'midline cleft at least 3 mm deep between the fold crests on either side (fore-aft extent, crest-to-crest width, depth)',
                            'lengthMm': round(length / MM, 1), 'specimenScaleLengthMm': round(length / MM / scale, 1), 'greatestDepthMm': round(float(run[:, 1].max()) / MM, 1), 'medianCrestSeparationMm': round(float(np.median(run[:, 2])) / MM, 1),
                            'compareWith': 'labia majora length (Kreklau 79.7 ± 15.3): the cleft between the outer folds is the nearest measurable quantity, not the same measurement'}
            anus = shipped.get('external_anal_sphincter')
            if anus is not None:
                lo = anus[anus[:, 1] < np.percentile(anus[:, 1], 10)].mean(0)
                d = float(run[0, 0] - lo[2])
                out['perineum'] = {'what': 'fore-aft distance from the posterior end of the cleft to the lowest part of the external anal sphincter (the anus is not an opening or a marked point on the specimen skin)', 'mm': round(d / MM, 1), 'specimenScaleMm': round(d / MM / scale, 1), 'compareWith': 'perineum (Kreklau 21.3 ± 8.5)', 'reliability': 'low: the posterior end of the cleft is not a defined landmark on this surface, and the figure is far outside the published range; do not use it'}
    cl, ur, vg = shipped.get('cavernous_body_of_clitoris'), shipped.get('submucous_layer_of_urethra'), shipped.get('uterine_and_vaginal_lumen')
    if cl is not None and ur is not None:
        # 阴蒂体的最前下端 → 尿道下端 / the antero-inferior end of the clitoral body → the lower end of the urethra
        mid_c = cl[np.abs(cl[:, 0] - xm) < 0.006]
        tip = mid_c[np.argmax(mid_c[:, 2] - mid_c[:, 1])]
        uend = ur[ur[:, 1] < ur[:, 1].min() + 0.002].mean(0)
        d = float(np.linalg.norm(tip - uend))
        out['clitoralBodyToUrethralEnd'] = {'what': 'from the antero-inferior end of the corpus cavernosum of the clitoris (deep part; the glans is not a separate structure) to the lower end of the submucous layer of the urethra (deep part; no urethral orifice on the skin)', 'mm': round(d / MM, 1), 'specimenScaleMm': round(d / MM / scale, 1), 'compareWith': 'clitoris to urethral orifice (Kreklau 22.6 ± 7.7): deep-structure distance, not the surface measurement'}
    if vg is not None:
        low = vg[vg[:, 1] < vg[:, 1].min() + 0.005]
        out['vaginalLumenLowerEnd'] = {'what': 'transverse and fore-aft extent of the lowest 5 mm of the vaginal lumen (deep part; the introitus is not open on the skin)', 'transverseMm': round(float(np.ptp(low[:, 0])) / MM, 1), 'foreAftMm': round(float(np.ptp(low[:, 2])) / MM, 1), 'compareWith': 'introitus (Kreklau 27.9 ± 10.4): not the same measurement'}
    out['notIdentified'] = {'zh': '小阴唇的长和宽没有量：标本皮肤上中线两侧各有成对的皱襞，但表面是台阶状的、没有标注，无法可靠地把内侧皱襞与外侧皱襞分开；阴蒂头、尿道口、阴道口、肛门在皮肤上都不是开口或标记点。', 'en': 'Length and width of the labia minora were not measured: the specimen skin shows paired folds on either side of the midline, but the surface is stair-stepped and unlabelled and the inner folds cannot be separated reliably from the outer ones; glans of the clitoris, urethral orifice, vaginal orifice and anus are neither openings nor marked points on the skin.'}
    return out


# ── 步骤：足趾 / step: the toes ──────────────────────────────────────────────────────────────────

HBM_SOURCE = {'name': 'Blender Studio "Human Base Meshes" asset bundle v1.4.1, asset "Foot - Realistic"', 'url': 'https://www.blender.org/download/demo-files/', 'license': 'CC0', 'author': 'Dan Ulrich (as stated in the asset)'}
ORDINAL = ['big', 'second', 'third', 'fourth', 'little']


def donor_toes(V, F, t):
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
        big = [r for r in roots if len(members[r]) >= 25]
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


def bone_ends(B, toward):
    """骨的长轴两端（各取最外 6% 顶点的均值）；第二个返回值在 toward 方向上更远 / the two ends of a bone along its long axis (means of the outermost 6% of vertices); the second is the one further along `toward`"""
    c = B.mean(0)
    u = np.linalg.svd(B - c)[2][0]
    if u @ toward < 0:
        u = -u
    t = (B - c) @ u
    lo, hi = B[t <= np.percentile(t, 6)].mean(0), B[t >= np.percentile(t, 94)].mean(0)
    return lo, hi, float(np.percentile(np.linalg.norm((B - c) - np.outer(t, u), axis=1), 90))


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


def step_toes(pk, deep, donor_file, out_dir, cover_mm=1.5, max_girth=1.35, rim_tol_mm=1.0):
    import igl
    if not os.path.exists(donor_file):
        raise SystemExit('step toes needs %s (tools/skinopen/export-foot.py)' % donor_file)
    dn = np.load(donor_file)
    DV0, DF0 = dn['V'], dn['F']
    bones = [p for p in (deep or {}).get('parts', []) if p['group'] == 'toeBone']
    nails = {p['side']: np.array(p['positions']).reshape(-1, 3) for p in (deep or {}).get('parts', []) if p['group'] == 'toeNail'}
    joints = (deep or {}).get('footJoints', {})
    if len(bones) < 20 or len(joints) < 12:
        raise SystemExit('step toes needs the toe bones and the ankle / mtp joints in deep-face.json (tools/skinopen/export-deep.ts)')
    # 供体的坐标架 / the donor's frame
    c = DV0.mean(0)
    ax = np.linalg.svd(DV0 - c)[2]
    long_d = ax[0]
    t = (DV0 - c) @ long_d
    hi_end, lo_end = DV0[t > np.percentile(t, 90)], DV0[t < np.percentile(t, 10)]
    cand = [a for a in ax[1:]]
    spread_hi = [np.ptp((hi_end - c) @ a) for a in cand]
    spread_lo = [np.ptp((lo_end - c) @ a) for a in cand]
    if max(spread_hi) < max(spread_lo):
        long_d = -long_d
        hi_end, spread_hi = lo_end, spread_lo
    up_d = cand[int(np.argmax(spread_hi))]
    if (hi_end.mean(0) - c) @ up_d < 0:
        up_d = -up_d
    fwd_d = -long_d
    along0 = (DV0 - c) @ fwd_d
    toes = donor_toes(DV0, DF0, along0)
    if len(toes) != 5:
        raise RuntimeError('toes: found %d separate toes on the donor, not 5' % len(toes))
    lat_axis = np.cross(fwd_d, up_d)
    toes.sort(key=lambda tv: float((DV0[tv[0]].mean(0) - c) @ lat_axis))
    vol = [len(tv[0]) for tv in toes]
    if vol[-1] > vol[0]:
        toes, lat_axis = toes[::-1], -lat_axis
    tips_d = np.array([DV0[tv[0]][np.argmax((DV0[tv[0]] - c) @ fwd_d)] for tv in toes])
    base_d = np.array([DV0[[v for v in tv[0] if (DV0[v] - c) @ fwd_d < tv[1] + 0.003]].mean(0) for tv in toes])
    frame_d = np.stack([fwd_d, up_d, np.cross(fwd_d, up_d)])
    donor_handed = float(np.sign(frame_d[2] @ lat_axis))
    toe_of = -np.ones(len(DV0), np.int64)
    for i, (tv, _) in enumerate(toes):
        toe_of[tv] = i
    # 每个非趾顶点离哪个趾的基部最近、在趾蹼之后多远 / for every non-toe vertex the nearest toe base and how far behind the webs it lies
    web_level = np.array([lv for _, lv in toes])
    stats = {'donor': {'vertices': int(len(DV0)), 'triangles': int(len(DF0)), 'freeToeLengthMm': [round(float(np.linalg.norm(tips_d[i] - base_d[i])) / MM, 1) for i in range(5)]},
             'method': 'per toe, a chain tip – interphalangeal joints – metatarsophalangeal joint taken from the bones; donor toe mapped onto it by arc length (length scale per toe) with its cross-section scaled (girth per toe) and its dorsal surface set on the nail plate; behind the webs the donor is drawn onto the package skin', 'sides': {}}
    live = pk.groups['skin'].copy()
    accepted = True
    fitted = {}
    for side, word in (('L', 'left'), ('R', 'right')):
        def bone(kind, k):
            name = '%s phalanx of %s %s toe' % (kind, word, ORDINAL[k])
            m = [np.array(p['positions']).reshape(-1, 3) for p in bones if p['name'].lower() == name]
            return m[0] if m else None
        mtp = np.array([joints['mtp%d_%s' % (k + 1, side)] for k in range(5)])
        ankle = np.array(joints['ankle_' + side])
        segs = [[b for b in (bone('proximal', k), bone('middle', k), bone('distal', k)) if b is not None] for k in range(5)]
        if any(len(sg) < 2 for sg in segs):
            raise RuntimeError('toes: a phalanx of the %s foot is missing' % word)
        fwd_b = np.mean([sg[-1].mean(0) for sg in segs], axis=0) - mtp.mean(0)
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
        # 每个趾的骨链 / the bone chain of each toe
        pad = 0.003
        chains, seg_len, bone_notes = [], [], []
        for k in range(5):
            ends = [bone_ends(b, fwd_b) for b in segs[k]]
            tip = ends[-1][1] + pad * (ends[-1][1] - ends[-1][0]) / np.linalg.norm(ends[-1][1] - ends[-1][0])
            pts = [tip]
            for a in range(len(ends) - 1, 0, -1):
                pts.append((ends[a][0] + ends[a - 1][1]) / 2)  # 趾间关节：相邻两骨端点的中点 / interphalangeal joint: midpoint of the facing bone ends
            pts.append(mtp[k])
            chains.append(Chain(pts, up_b))
            seg_len.append([float(np.linalg.norm(e[1] - e[0])) for e in ends])
            # 骨是否像样：相邻骨端的间隙、长度 / is the bone plausible: gap between facing ends, lengths
            gaps = [float(np.linalg.norm(ends[a][0] - ends[a - 1][1])) for a in range(1, len(ends))]
            if max(gaps) > 0.006 or min(seg_len[-1]) < 0.003:
                bone_notes.append({'toe': ORDINAL[k], 'problem': 'gap of %.1f mm between facing bone ends or a phalanx shorter than 3 mm' % (max(gaps) / MM), 'phalanxLengthsMm': [round(v / MM, 1) for v in seg_len[-1]]})
        tgt_tip = np.array([ch.p[0] for ch in chains])
        scale = float(np.median([np.linalg.norm(tgt_tip[i] - tgt_tip[j]) / np.linalg.norm(tips_d[i] - tips_d[j]) for i in range(5) for j in range(i + 1, 5)]))
        tr = tgt_tip.mean(0) - scale * (tips_d.mean(0) @ R.T)
        G = scale * (DV0 @ R.T) + tr
        tips_g, base_g = scale * (tips_d @ R.T) + tr, scale * (base_d @ R.T) + tr
        Fd_ = DF0[:, ::-1] if mirror else DF0
        # 粗细从 0.85 起，只在骨盖不住时加粗；趾心比骨轴偏跖侧 1 mm（趾腹在跖侧）
        # girth starts at 0.85 and grows only while a bone is not covered; the toe's centre lies 1 mm plantar of the bone axis (the pulp is plantar)
        girth = np.full(5, 0.85)
        shift = np.full(5, 0.001)
        nail = nails.get(side)

        def toe_map(k, X):
            """供体（已做整体相似变换）上的点 → 第 k 趾的骨链上 / points of the donor (after the global similarity) → onto the chain of toe k"""
            a = (tips_g[k] - base_g[k])
            la = np.linalg.norm(a)
            a = a / la
            eu = up_b - (up_b @ a) * a
            eu /= np.linalg.norm(eu)
            el = np.cross(-a, eu)  # 与骨链坐标架同向：切向指向近端 / same sense as the chain frame, whose tangent points proximally
            x = (tips_g[k] - X) @ a
            off = (X - tips_g[k]) + x[:, None] * a
            ch = chains[k]
            # 游离趾的长度对应：趾尖到近节趾骨中点 / the free toe corresponds to: tip to the middle of the proximal phalanx
            free = ch.l[-1] - 0.5 * seg_len[k][0]
            sarc = x * (free / la)
            C = ch.point(sarc)
            tt, uu, ll = ch.frame(sarc)
            return C + girth[k] * ((off @ eu)[:, None] * uu + (off @ el)[:, None] * ll) - shift[k] * uu, sarc

        def build():
            disp = np.zeros_like(G)
            wsum = np.zeros(len(G))
            for k, (tv, level) in enumerate(toes):
                Tk, _ = toe_map(k, G)
                w = np.zeros(len(G))
                w[tv] = 1.0
                rest = np.where(toe_of < 0)[0]
                d = np.linalg.norm(DV0[rest] - base_d[k], axis=1) * scale
                w[rest] = np.exp(-(d / 0.010) ** 2)
                disp += w[:, None] * (Tk - G)
                wsum += w
            return G + disp / np.maximum(wsum, 1.0)[:, None]

        # 趾背落到甲板上：甲板顶点高出骨链多少，供体趾背在同一处高出多少
        # the dorsal surface goes onto the nail plate: how far the nail vertices stand above the chain, and the donor's dorsal surface at the same station
        nail_rows = []
        for it in range(16):
            P = build()
            Pc, Fc = np.ascontiguousarray(P), np.ascontiguousarray(Fd_)
            worst = np.zeros(5)
            for k in range(5):
                for bi, bn in enumerate(segs[k]):
                    if bi == 0:
                        q = (bn - mtp[k]) @ fwd_b
                        bn = bn[q > np.median(q)]  # 近节趾骨的远侧一半在游离趾内 / the distal half of the proximal phalanx lies in the free toe
                    worst[k] = max(worst[k], float(igl.signed_distance(np.ascontiguousarray(bn), Pc, Fc)[0].max()) + cover_mm * MM)
            changed = False
            if False:
                for k in range(5):
                    sk, dk = chains[k].project(nail)
                    mine = (dk < 0.012) & (np.argmin(np.stack([chains[j].project(nail)[1] for j in range(5)]), axis=0) == k)
                    if mine.sum() < 5:
                        continue
                    sdn = igl.signed_distance(np.ascontiguousarray(nail[mine]), Pc, Fc)[0]
                    off = float(np.median(sdn))  # 正 = 甲板在趾皮之外 / positive = the nail plate lies outside the toe skin
                    if abs(off) > 0.0002:
                        shift[k] -= off
                        changed = True
            for k in range(5):
                if worst[k] > 0 and girth[k] < max_girth:
                    girth[k] = min(max_girth, girth[k] * 1.04)
                    changed = True
            if not changed:
                break
        P = build()
        Pc, Fc = np.ascontiguousarray(P), np.ascontiguousarray(Fd_)
        # 趾蹼之后：供体表面拉到包里的皮肤上（包里的皮肤说了算），从趾蹼后 3 mm 起、到 11 mm 处完全贴合
        # behind the webs the donor surface is drawn onto the package skin (the package skin is the authority there): from 3 mm behind the webs, fully by 11 mm
        Vs, Fs = np.ascontiguousarray(pk.V), np.ascontiguousarray(pk.F[live])
        nonto = np.where(toe_of < 0)[0]
        kn = np.argmin(np.linalg.norm(DV0[nonto][:, None] - base_d[None], axis=2), axis=1)
        behind = (web_level[kn] - along0[nonto]) * scale
        x = np.clip((behind - 0.003) / 0.008, 0, 1)
        phi = x * x * (3 - 2 * x)
        cp = igl.point_mesh_squared_distance(np.ascontiguousarray(P[nonto]), Vs, Fs)[2]
        before = np.linalg.norm(cp - P[nonto], axis=1)
        P[nonto] += phi[:, None] * (cp - P[nonto])
        # 过渡带里做几遍拉普拉斯平滑（只动过渡带的顶点）/ a few Laplacian passes inside the transition band (only its vertices move)
        band = np.zeros(len(P), bool)
        band[nonto[(phi > 0) & (phi < 1)]] = True
        Ad, _ = vertex_graph(len(P), Fd_)
        deg = np.maximum(np.asarray(Ad.sum(1)).ravel(), 1)
        for _ in range(5):
            Q = (Ad @ P) / deg[:, None]
            P[band] = 0.5 * P[band] + 0.5 * Q[band]
        Pc = np.ascontiguousarray(P)
        # 验收 / acceptance
        cover, fails = {}, []
        for k in range(5):
            for bi, bn in enumerate(segs[k]):
                kind = ['proximal', 'middle', 'distal'][bi] if len(segs[k]) == 3 else ['proximal', 'distal'][bi]
                full = bn
                if bi == 0:
                    q = (bn - mtp[k]) @ fwd_b
                    bn = bn[q > np.median(q)]
                sd = igl.signed_distance(np.ascontiguousarray(bn), Pc, Fc)[0]
                row = {'leastCoverMm': round(float(-sd.max()) / MM, 2), 'lengthMm': round(seg_len[k][bi] / MM, 1), 'radiusMm': round(bone_ends(full, fwd_b)[2] / MM, 1)}
                cover['%s %s' % (ORDINAL[k], kind)] = row
                if -sd.max() < cover_mm * MM - 1e-5:
                    fails.append('%s phalanx of the %s %s toe: least cover %.2f mm (needs %.1f)' % (kind, word, ORDINAL[k], -sd.max() / MM, cover_mm))
        overlap = {}
        for i in range(4):
            A_, B_ = toes[i][0], toes[i + 1][0]
            fa = Fd_[np.isin(Fd_, A_).all(1)]
            wn = igl.winding_number(Pc, np.ascontiguousarray(fa), np.ascontiguousarray(P[B_]))
            dmin = float(cKDTree(P[A_]).query(P[B_])[0].min())
            overlap['%s / %s' % (ORDINAL[i], ORDINAL[i + 1])] = {'verticesOfOneInsideTheOther': int((np.abs(wn) > 0.5).sum()), 'closestApproachMm': round(dmin / MM, 2)}
            if (np.abs(wn) > 0.5).sum() > 0:
                fails.append('%s and %s toe of the %s foot overlap (%d vertices of one inside the other)' % (ORDINAL[i], ORDINAL[i + 1], word, int((np.abs(wn) > 0.5).sum())))
        nail_check = None
        if nail is not None:
            sdn = igl.signed_distance(np.ascontiguousarray(nail), Pc, Fc)[0]
            near = np.abs(sdn) < 0.01
            nail_check = {'what': 'signed distance of the vertices of the nail plate part from the toe skin (positive = outside)', 'medianMm': round(float(np.median(sdn[near])) / MM, 2), 'p5Mm': round(float(np.percentile(sdn[near], 5)) / MM, 2), 'p95Mm': round(float(np.percentile(sdn[near], 95)) / MM, 2),
                          'note': 'the donor mesh has no label for its nails: this says how far the anatomy\'s nail plates lie from the dorsal toe surface, not whether the sculpted nail outlines coincide with them'}
            if np.percentile(np.abs(sdn[near]), 90) > 0.0015:
                nail_check['withinTolerance'] = False
                srow_nail_fail = ('nail plates of the %s foot lie up to %.1f mm (90th percentile) from the toe surface' % (word, np.percentile(np.abs(sdn[near]), 90) / MM))
        full_fit = phi >= 1
        srow = {'mirrored': bool(mirror), 'scale': round(scale, 4), 'lengthScalePerToe': [round(float((chains[k].l[-1] - 0.5 * seg_len[k][0]) / np.linalg.norm(tips_g[k] - base_g[k])), 3) for k in range(5)],
                'girthScalePerToe': [round(float(g), 3) for g in girth], 'plantarShiftMm': [round(float(v) / MM, 2) for v in shift], 'boneCover': cover, 'neighbours': overlap, 'nailPlates': nail_check,
                'ballBeforeConformingMm': {'what': 'distance of the donor surface behind the webs from the package skin before it was drawn onto it', 'median': round(float(np.median(before[phi > 0])) / MM, 1), 'max': round(float(before[phi > 0].max()) / MM, 1)},
                'chainSpacingAtMiddleOfToeMm': [round(float(np.linalg.norm(chains[k].point(np.array([0.5 * chains[k].l[-1]]))[0] - chains[k + 1].point(np.array([0.5 * chains[k + 1].l[-1]]))[0])) / MM, 1) for k in range(4)],
                'implausibleBones': bone_notes, 'failures': fails}
        stats['sides'][side] = srow
        accepted &= not fails
        fitted[side] = (P, Fd_, np.concatenate([sg[-1] for sg in segs]), mtp)
    stats['accepted'] = bool(accepted)
    os.makedirs(out_dir, exist_ok=True)
    for side, (P, Fd_, _, mtp) in fitted.items():
        keep = np.linalg.norm(P - mtp.mean(0), axis=1) < 0.07
        fsel = keep[Fd_].all(1)
        usedv = np.unique(Fd_[fsel])
        loc = -np.ones(len(P), np.int64)
        loc[usedv] = np.arange(len(usedv))
        write_obj(os.path.join(out_dir, 'toes-fit-%s.obj' % side), P[usedv], [('toesFit' + side, loc[Fd_[fsel]])], ['# forefoot of "Foot - Realistic" (Blender Studio Human Base Meshes v1.4.1, CC0, artist-made) fitted to the toe bones of this body by tools/skinopen/graft.py; metres, body frame'])
    if not accepted:
        stats['grafted'] = False
        stats['notGraftedBecause'] = '; '.join(f for v in stats['sides'].values() for f in v['failures'])
        pk.pending.append({'name': 'toes', 'status': 'fitted, not grafted', 'files': ['toes-fit-L.obj', 'toes-fit-R.obj'], 'reason': stats['notGraftedBecause'], 'provenance': 'curated', 'source': HBM_SOURCE})
        pk.report['toes'] = stats
        return
    stats['grafted'] = True
    stats['graft'] = {}
    for side, (P, Fd_, seeds, mtp) in fitted.items():
        ball = pk.joint('mtp2_' + side)
        info, gstats, ids, geo = graft(pk, P, Fd_, seeds, 'toes' + side, differ_mm=0.8, reach_mm=75.0, grow_rings=2, blend_mm=6.0, rigid_joint=ball, rigid_from_mm=5.0, rigid_full_mm=15.0, tag_patch='graftCurated')
        if gstats['rimMismatchMm']['median'] > rim_tol_mm:
            raise RuntimeError('toes: the rim of the %s forefoot lies a median %.2f mm from the package skin (tolerance %.1f)' % (side, gstats['rimMismatchMm']['median'], rim_tol_mm))
        info.update({
            'provenance': 'curated', 'source': HBM_SOURCE,
            'what': {'zh': '分开的脚趾、趾蹼和趾甲：供体是人工建模的 CC0 网格（不是扫描，也不是这个人的脚），每个趾按本体的趾骨链做了长度和粗细的缩放并弯到骨的走向上；趾蹼之后的面贴到包里原来的皮肤上。全部顶点都被这样变形过（标签 graftCurated）；靠边一圈为过渡环（graftBlend，构造物）。', 'en': 'Separate toes, web spaces and nails: the donor is an artist-made CC0 mesh (neither a scan nor this person\'s foot); each toe was scaled in length and girth and bent along this body\'s chain of toe bones, and the surface behind the webs lies on the package skin. Every vertex was deformed in this way (tag graftCurated); the band at the rim is the blend ring (graftBlend, construction).'},
            'weights': {'zh': '权重从洞口环调和延拓；离洞口 5–15 mm 过渡到完全跟随 MHR 的 %s（前足“球”关节）。包里没有趾间关节，也只有这一个趾关节；绑定时由 data/curated/rig 的规则把 %s 的权重按“最近的 mtp1–5”分给各趾。' % (pk.joints['names'][ball], pk.joints['names'][ball]), 'en': 'Weights are a harmonic extension from the rim of the hole, turning between 5 and 15 mm from the rim into MHR\'s %s alone (the ball-of-foot joint). The package has no toe interphalangeal joints and only this one toe joint; at rig time the rule in data/curated/rig hands the weight of %s to the nearest of mtp1–5, toe by toe.' % (pk.joints['names'][ball], pk.joints['names'][ball])},
        })
        pk.grafts.append(info)
        stats['graft'][side] = gstats
    # 接入之后再核对一次：所有趾骨对最终的皮肤 / checked again after grafting: every toe bone against the final skin
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
    pk.report['toes'] = stats


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
            step_genital(pk, deep, args.bp3d)
        elif s == 'vulva':
            step_vulva(pk, deep, args.wu, out)
        elif s == 'toes':
            step_toes(pk, deep, args.foot, out)
        else:
            raise SystemExit('unknown step "%s"' % s)
    pk.write(out, steps)


if __name__ == '__main__':
    main()
