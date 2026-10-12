#!/usr/bin/env python3
# 给皮肤包开出真正的口裂和睑裂。读一个皮肤包目录（tools/bodyshape 写出的 <body>-skin/），
# 把开口后的包写到旁边的 <body>-skin-open/；原包一个字节也不动。
# Cuts real mouth and eye openings into a skin package. Reads one package directory (<body>-skin/
# as written by tools/bodyshape) and writes the opened package next to it, in <body>-skin-open/;
# the original package is not touched.
#
#   python tools/skinopen/open_skin.py data/raw/bodyshape/out/male-skin
#       [--out DIR] [--deep deep-face.json] [--corner-taper-mm 0] [--keep-eye-membrane] [--no-pouch]
#
# 做了什么 / What it does
#   口 / mouth   MHR 的两唇之间是一个向内折的小口袋（深约 3 mm，两壁相贴），袋底是一排顶点。
#                沿袋底从一侧口角到另一侧口角剪开：袋底顶点复制一份，上壁留原编号，下壁用新编号。
#                袋的两壁就成了上、下唇的内面。再在两条唇缘后面接一个口腔袋（构造物，不是解剖）。
#                Between the lips MHR has a small pocket folded inwards (about 3 mm deep, its walls
#                against each other) with one row of vertices at the bottom. The cut runs along that
#                row from one mouth corner to the other: the row is duplicated, the upper wall keeps
#                the original indices and the lower wall gets the new ones. The pocket's walls thereby
#                become the inner faces of the lips. An oral pouch (a construction aid, not anatomy)
#                is attached behind the two margins.
#   眼 / eyes    MHR 的眼是睁着的：上下睑缘之间由一条之字形的三角形带（“膜”）封住。删掉这条带，
#                睑裂就是一个真的洞；沿洞口加一圈朝向眼球的短边（构造物）。
#                MHR models the eyes open: a zigzag strip of triangles (a membrane) closes the space
#                between the lid margins. Removing the strip leaves a real hole; a short rim turned
#                towards the globe (a construction aid) is added round it.
#   权重 / weights  口裂处精确分开：上唇缘跟颅，下唇缘跟下颌；其间在剪开后的网格上做调和插值，
#                过渡只发生在口角外侧。
#                An exact split at the fissure: upper margin with the skull, lower margin with the jaw;
#                in between, harmonic interpolation on the cut mesh, so that the blend lies lateral to
#                the mouth corners only.
#   其余逐顶点文件按“来源顶点”扩展；原有顶点的编号不变，新顶点接在后面。
#   Every other per-vertex file is extended through a source-vertex map; existing vertex indices are
#   unchanged and new vertices are appended.
#
# 不依赖某一次拟合：所有的线都从几何和 manifest 的 face.regions 里找，没有写死的坐标或下标。
# Independent of a particular fit: every line is found from geometry and face.regions of the
# manifest; no coordinate or index is hard-coded.

import argparse
import json
import os
import shutil
import sys

import numpy as np
import scipy.sparse as sp
import scipy.sparse.csgraph as csgraph
import scipy.sparse.linalg as spla

MM = 1e-3

# 逐顶点标签（vertex-tags.u8）/ per-vertex tags (vertex-tags.u8)
TAGS = {
    'skin': 0,
    'upperLip': 1, 'lowerLip': 2, 'mouthCorner': 3,
    'upperLidL': 4, 'lowerLidL': 5, 'upperLidR': 6, 'lowerLidR': 7, 'canthus': 13,
    'lidRimL': 8, 'lidRimR': 9,
    'oralPouchUpper': 10, 'oralPouchLower': 11, 'oralPouchSeam': 12,
}


# ── 读写 / input and output ─────────────────────────────────────────────────────────────────────

def read_obj(path):
    """读 OBJ 的顶点和三角形（保留文件里的顺序）/ vertices and triangles of an OBJ, in file order"""
    V, F, head = [], [], []
    with open(path) as fh:
        for line in fh:
            if line.startswith('v '):
                V.append(line.split()[1:4])
            elif line.startswith('f '):
                t = [int(s.split('/')[0]) for s in line.split()[1:]]
                for k in range(1, len(t) - 1):
                    F.append([t[0], t[k], t[k + 1]])
            elif line.startswith('#') and not V:
                head.append(line.rstrip('\n'))
    V = np.array(V, dtype=np.float64)
    F = np.array(F, dtype=np.int64)
    F = np.where(F < 0, len(V) + F, F - 1)
    return V, F, head


def write_obj(path, V, groups, head):
    """groups: [(名称, 三角形数组)] / [(name, triangle array)]"""
    with open(path, 'w') as fh:
        for h in head:
            fh.write(h + '\n')
        # 六位小数 = 1 µm：重合的唇缘顶点写出来仍然逐位相同
        # six decimals = 1 µm: coincident margin vertices stay identical digit for digit
        fh.write(''.join('v %.6f %.6f %.6f\n' % (p[0], p[1], p[2]) for p in V))
        for name, tris in groups:
            fh.write('g %s\n' % name)
            fh.write(''.join('f %d %d %d\n' % (t[0] + 1, t[1] + 1, t[2] + 1) for t in tris))


# ── 拓扑 / topology ─────────────────────────────────────────────────────────────────────────────

def face_normals(V, F):
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-20)


def unique_edges(F, nv):
    """无向边、每条边的使用次数 / undirected edges and how many triangles use each"""
    he = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    key = np.minimum(he[:, 0], he[:, 1]) * nv + np.maximum(he[:, 0], he[:, 1])
    uk, cnt = np.unique(key, return_counts=True)
    return np.stack([uk // nv, uk % nv], 1), cnt


def half_edge_map(F):
    """有向边 (a, b) → 三角形下标 / directed edge (a, b) → triangle index"""
    m = {}
    for f, (a, b, c) in enumerate(F):
        m[(a, b)] = f
        m[(b, c)] = f
        m[(c, a)] = f
    return m


def graph(nv, E, w):
    return sp.coo_matrix((np.r_[w, w], (np.r_[E[:, 0], E[:, 1]], np.r_[E[:, 1], E[:, 0]])), shape=(nv, nv)).tocsr()


def boundary_loops(F, nv):
    """边界环的个数和各环的边数 / number of boundary loops and their edge counts"""
    hm = half_edge_map(F)
    nxt = {}
    for (a, b) in hm:
        if (b, a) not in hm:
            nxt.setdefault(b, []).append(a)  # 沿边界反向走 / walk the boundary against the faces
    loops, seen = [], set()
    for start in list(nxt):
        for first in nxt[start]:
            if (start, first) in seen:
                continue
            n, a, b = 0, start, first
            while (a, b) not in seen:
                seen.add((a, b))
                n += 1
                cand = [c for c in nxt.get(b, []) if (b, c) not in seen]
                if not cand:
                    break
                a, b = b, cand[0]
            loops.append(n)
    return sorted(loops)


# ── 口裂 / the oral fissure ─────────────────────────────────────────────────────────────────────

def find_oral_fissure(V, F, lips):
    """
    口裂 = 两唇之间那个口袋的袋底。袋底顶点周围的面法线几乎相对（上壁朝下、下壁朝上），
    所以“相邻面法线的最大夹角”在袋底远大于别处。取夹角 > 90° 的顶点里沿主轴最远的两个作口角，
    两口角之间走一条偏向尖锐顶点的最短路。
    The fissure is the bottom of the pocket between the lips. Round a bottom vertex the face normals
    are almost opposite (upper wall facing down, lower wall facing up), so the largest angle between
    the normals of its faces is far greater there than anywhere else. The two vertices with such an
    angle above 90° that lie furthest apart along the principal axis are the mouth corners; between
    them runs a shortest path that prefers sharp vertices.
    """
    nv = len(V)
    mask = np.zeros(nv, bool)
    mask[lips] = True
    fn = face_normals(V, F)
    near = np.where(mask[F].any(1))[0]
    vf = {}
    for f in near:
        for v in F[f]:
            vf.setdefault(int(v), []).append(f)
    sharp = np.zeros(nv)
    for v in lips:
        n = fn[vf[int(v)]]
        sharp[v] = np.degrees(np.arccos(np.clip((n @ n.T).min(), -1, 1)))
    s = lips[sharp[lips] > 90]
    if len(s) < 8:
        raise RuntimeError('oral fissure: fewer than 8 sharp vertices in face.regions.lips — no pocket between the lips found')
    # 只留最大的一簇（5 mm 内相连），免得别处的尖角当了口角；口角附近袋底有一小段不那么尖，所以容许 5 mm 的间断
    # keep the largest cluster (linked within 5 mm) so that a sharp vertex elsewhere cannot become a corner; near a corner a short stretch of the bottom is less sharp, hence the 5 mm allowance
    d = np.linalg.norm(V[s][:, None] - V[s][None], axis=2)
    ncomp, lab = csgraph.connected_components(sp.csr_matrix(d < 5 * MM))
    ext = [np.ptp(V[s[lab == c]], axis=0).max() for c in range(ncomp)]
    s = s[lab == int(np.argmax(ext))]
    axis = np.linalg.svd(V[s] - V[s].mean(0))[2][0]
    t = (V[s] - V[s].mean(0)) @ axis
    c0, c1 = int(s[np.argmin(t)]), int(s[np.argmax(t)])
    # 约定：路径从身体右侧（−X）口角走到左侧（+X）口角 / convention: the path runs from the right (−X) corner to the left (+X) one
    if V[c0, 0] > V[c1, 0]:
        c0, c1 = c1, c0
    E, _ = unique_edges(F[mask[F].all(1)], nv)
    L = np.linalg.norm(V[E[:, 0]] - V[E[:, 1]], axis=1)
    pen = 1 + 20 * np.maximum(0, 1 - sharp / 120)
    G = graph(nv, E, L * (pen[E[:, 0]] + pen[E[:, 1]]) / 2)
    _, pred = csgraph.dijkstra(G, indices=c0, return_predecessors=True)
    path = [c1]
    while path[-1] != c0:
        if pred[path[-1]] < 0:
            raise RuntimeError('oral fissure: the mouth corners are not connected inside face.regions.lips')
        path.append(int(pred[path[-1]]))
    return np.array(path[::-1]), sharp


def split_sides(V, F, path):
    """
    路径两侧的面。只看与路径内部顶点相邻的面；两个面若共用一条不在路径上、且有一端是路径内部顶点的边，
    就在同一侧。应当恰好分成两组。哪一组是上唇：从各自的顶点向外走 12 圈（不穿过路径），看哪边更高。
    The faces on either side of the path. Only faces touching an interior path vertex count; two of
    them are on the same side when they share an edge that is not on the path and has an interior path
    vertex at one end. Exactly two groups must result. Which one is the upper lip: grow each group's
    vertices by 12 rings without crossing the path and compare heights.
    """
    nv = len(V)
    interior = set(int(v) for v in path[1:-1])
    pedges = set()
    for a, b in zip(path[:-1], path[1:]):
        pedges.add((int(a), int(b)))
        pedges.add((int(b), int(a)))
    ring = [f for f in range(len(F)) if any(int(v) in interior for v in F[f])]
    pos = {f: i for i, f in enumerate(ring)}
    owner = {}
    rows, cols = [], []
    for f in ring:
        t = F[f]
        for k in range(3):
            a, b = int(t[k]), int(t[(k + 1) % 3])
            if (a, b) in pedges or not (a in interior or b in interior):
                continue
            key = (min(a, b), max(a, b))
            if key in owner:
                rows.append(pos[f])
                cols.append(pos[owner[key]])
            else:
                owner[key] = f
    ncomp, lab = csgraph.connected_components(sp.coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(len(ring), len(ring))), directed=False)
    if ncomp != 2:
        raise RuntimeError('oral fissure: the path does not separate its neighbourhood into two sides (%d groups)' % ncomp)
    ring = np.array(ring)
    sides = [ring[lab == 0], ring[lab == 1]]
    E, _ = unique_edges(F, nv)
    onpath = np.zeros(nv, bool)
    onpath[path] = True
    keep = ~(onpath[E[:, 0]] | onpath[E[:, 1]])
    A = graph(nv, E[keep], np.ones(keep.sum()))
    height = []
    for s in sides:
        seed = np.setdiff1d(np.unique(F[s]), path)
        hop = csgraph.dijkstra(A, indices=seed, unweighted=True, min_only=True, limit=12)
        height.append(V[np.isfinite(hop), 1].mean())
    return (sides[0], sides[1]) if height[0] > height[1] else (sides[1], sides[0])


# ── 睑裂 / the palpebral fissures ───────────────────────────────────────────────────────────────

def find_eye_membrane(V, F, lids, hm, w_min=0.6 * MM):
    """
    封住睑裂的那条三角形带。种子是眼睑区里边最长的那个三角形（带上的横边长达 9 mm，别处不到 2 mm）。
    从种子向两眦走：每进一个三角形，另外两条边里二面角小的那条是下一条横边（膜是平的），大的那条在睑缘上
    （睑缘是一道凹棱）。横边短于 w_min 就到了眦。
    The strip of triangles that closes the fissure. The seed is the triangle with the longest edge in
    the lid region (the strip's cross edges reach 9 mm; no other edge reaches 2 mm). From the seed
    the strip is walked towards both canthi: of the two other edges of each triangle entered, the one
    with the smaller dihedral angle is the next cross edge (the membrane is flat) and the other lies
    on a lid margin (a concave crease). A cross edge shorter than w_min is the canthus.
    """
    nv = len(V)
    mask = np.zeros(nv, bool)
    mask[lids] = True
    fn = face_normals(V, F)
    cand = np.where(mask[F].all(1))[0]
    T = V[F[cand]]
    longest = np.max(np.linalg.norm(T - T[:, [1, 2, 0]], axis=2), axis=1)
    seed = int(cand[np.argmax(longest)])

    def bend(a, b):
        return np.degrees(np.arccos(np.clip(fn[hm[(a, b)]] @ fn[hm[(b, a)]], -1, 1)))

    def elen(a, b):
        return np.linalg.norm(V[a] - V[b])

    strip = [seed]
    ends = []
    t = [int(v) for v in F[seed]]
    edges = sorted([(t[k], t[(k + 1) % 3]) for k in range(3)], key=lambda e: bend(*e))
    for (a, b) in edges[:2]:  # 种子的两条横边 / the two cross edges of the seed
        guard = 0
        while True:
            guard += 1
            if guard > 400:
                raise RuntimeError('eye membrane: the strip does not end')
            if elen(a, b) < w_min:
                break
            g = hm[(b, a)]
            if g in strip or not mask[F[g]].all():
                break
            strip.append(g)
            c = int([v for v in F[g] if v != a and v != b][0])
            # g 的另外两条有向边：(a, c) 和 (c, b) / the two other directed edges of g: (a, c) and (c, b)
            if bend(a, c) <= bend(c, b):
                b = c
            else:
                a = c
        ends.append((a, b))
    strip = np.array(strip)
    # 带的边界：只被带内一个三角形用到的有向边 / boundary of the strip: directed edges used by one strip triangle only
    inside = set()
    for f in strip:
        a, b, c = (int(v) for v in F[f])
        inside.update([(a, b), (b, c), (c, a)])
    bnd = [(a, b) for (a, b) in inside if (b, a) not in inside]
    nxt = {a: b for a, b in bnd}
    if len(nxt) != len(bnd):
        raise RuntimeError('eye membrane: the strip boundary is not a simple loop')
    loop = [bnd[0][0]]
    while nxt[loop[-1]] != loop[0]:
        loop.append(nxt[loop[-1]])
    if len(loop) != len(bnd):
        raise RuntimeError('eye membrane: the strip boundary is not one loop')
    return strip, np.array(loop), ends


def split_lid_margins(V, loop, ends, mid_x):
    """把洞口的环在两眦处分成上、下睑缘；都从内眦排到外眦 / splits the loop at the canthi into upper and lower margin, each ordered from the medial to the lateral canthus"""
    n = len(loop)
    where = {int(v): i for i, v in enumerate(loop)}
    cuts = []
    for a, b in ends:
        i, j = where[a], where[b]
        # 眦处的短边是环上相邻的两个顶点 / the short edge at a canthus joins two neighbours on the loop
        if (i + 1) % n == j:
            cuts.append(i)
        elif (j + 1) % n == i:
            cuts.append(j)
        else:
            raise RuntimeError('eye membrane: a canthus edge is not on the boundary loop')
    c0, c1 = sorted(cuts)
    chain_a = [int(loop[k % n]) for k in range(c0 + 1, c1 + 1)]
    chain_b = [int(loop[k % n]) for k in range(c1 + 1, c0 + 1 + n)]
    upper, lower = (chain_a, chain_b) if V[chain_a, 1].mean() > V[chain_b, 1].mean() else (chain_b, chain_a)
    out = []
    for ch in (upper, lower):
        if abs(V[ch[0], 0] - mid_x) > abs(V[ch[-1], 0] - mid_x):
            ch = ch[::-1]
        out.append(ch)
    return out[0], out[1]


def fit_sphere(P):
    A = np.c_[2 * P, np.ones(len(P))]
    x = np.linalg.lstsq(A, (P ** 2).sum(1), rcond=None)[0]
    c = x[:3]
    return c, float(np.sqrt(max(x[3] + c @ c, 0)))


# ── 口腔袋 / the oral pouch ─────────────────────────────────────────────────────────────────────

def resample(poly, n):
    """按弧长把折线重采样成 n 个点 / resamples a polyline to n points by arc length"""
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(poly, axis=0), axis=1))]
    u = np.linspace(0, s[-1], n)
    return np.stack([np.interp(u, s, poly[:, k]) for k in range(3)], 1)


def pouch_seam(c0, c1, half_width, depth, slope, n):
    """
    上下两半口腔袋相接的那条缝：从左口角向后绕过牙弓和舌，回到右口角，位于咬合平面上。
    The seam where the upper and lower half of the pouch meet: from the left mouth corner back round
    the dental arch and the tongue to the right corner, in the occlusal plane.
    """
    xm = (c0[0] + c1[0]) / 2
    s = np.linspace(0, 1, 60)
    pts = []
    for c in (c0, c1):
        sign = 1.0 if c[0] >= xm else -1.0
        hw = abs(c[0] - xm)
        # 半宽：出口角后很快放到 half_width，后一半按椭圆收拢 / half-width: widens quickly behind the corner, closes as an ellipse over the rear half
        w = np.where(s < 0.5, hw + (half_width - hw) * np.minimum(1, s / 0.3) ** 0.6, half_width * np.sqrt(np.maximum(0, 1 - ((s - 0.5) / 0.5) ** 2)))
        side = np.stack([xm + sign * w, c[1] + slope * (-s * depth), c[2] - s * depth], 1)
        pts.append(side)
    poly = np.concatenate([pts[0], pts[1][::-1][1:]])
    return resample(poly, n)


def build_pouch(V_upper, V_lower, seam, h_up, h_down, K):
    """
    两半袋壁的顶点。列 i 对应唇缘上的第 i 个顶点，行 k 从唇缘（k = 0）到缝（k = K）。
    近唇缘处先陡直上（下）行，贴着唇的内面，再向后去；行距在唇缘附近密。
    Vertices of the two half walls. Column i belongs to margin vertex i; row k runs from the margin
    (k = 0) to the seam (k = K). Near the margin the wall first rises (falls) steeply behind the lip
    and then turns back; rows are denser near the margin.
    """
    n = len(V_upper)
    u = np.linspace(0, 1, n)
    wu = np.sin(np.pi * u) ** 0.4
    t = (np.arange(K + 1) / K) ** 1.5
    tau = t ** 1.6
    g = np.sin(np.pi * t) ** 0.35
    up = np.zeros((K + 1, n, 3))
    lo = np.zeros((K + 1, n, 3))
    for k in range(K + 1):
        up[k] = (1 - tau[k]) * V_upper + tau[k] * seam
        up[k][:, 1] += h_up * wu * g[k]
        lo[k] = (1 - tau[k]) * V_lower + tau[k] * seam
        lo[k][:, 1] -= h_down * wu * g[k]
    return up, lo, t


# ── 主流程 / main ───────────────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description='Cut mouth and eye openings into a skin package (writes <package>-open/).')
    ap.add_argument('package')
    ap.add_argument('--out')
    ap.add_argument('--deep', help='deep-face.json from tools/skinopen/export-deep.ts (default: <out>/deep-face.json when present)')
    ap.add_argument('--corner-taper-mm', type=float, default=0.0, help='arc length from each mouth corner over which the split of the jaw weight at the margins eases in (0 = exact up to the corner)')
    ap.add_argument('--alt-corner-taper-mm', type=float, default=6.0, help='corner taper of the second weights file weights-corner-taper.bin (0 = do not write it)')
    ap.add_argument('--weight-zone-mm', type=float, default=16.0, help='geodesic radius round the fissure inside which the jaw weight is recomputed')
    ap.add_argument('--weight-inner-mm', type=float, default=5.0, help='geodesic radius round the fissure inside which the jaw weight follows the side field strictly')
    ap.add_argument('--lid-rim-mm', type=float, default=5.0, help='greatest length of the rim turned in at the lid margins')
    ap.add_argument('--keep-eye-membrane', action='store_true', help='leave the eyes closed by the membrane (no eye opening, no lid rim)')
    ap.add_argument('--no-pouch', action='store_true')
    args = ap.parse_args()

    pkg = os.path.normpath(args.package)
    out = os.path.normpath(args.out) if args.out else pkg + '-open'
    os.makedirs(out, exist_ok=True)
    manifest = json.load(open(os.path.join(pkg, 'manifest.json')))
    joints = json.load(open(os.path.join(pkg, 'joints.json')))
    regions = manifest.get('face', {}).get('regions', {})
    for r in ('lips', 'lidsL', 'lidsR'):
        if r not in regions:
            raise SystemExit('manifest.face.regions.%s is missing: this tool needs the lip and lid regions' % r)
    V0, F0, head = read_obj(os.path.join(pkg, 'skin.obj'))
    n0 = len(V0)
    E0, cnt0 = unique_edges(F0, n0)
    if not (cnt0 == 2).all():
        raise SystemExit('skin.obj is not a closed manifold (%d edges not shared by exactly two triangles); this tool expects the closed skin of tools/bodyshape' % int((cnt0 != 2).sum()))
    deep_file = args.deep or os.path.join(out, 'deep-face.json')
    deep = json.load(open(deep_file)) if os.path.exists(deep_file) else None
    body = (manifest.get('fittedTo') or {}).get('body')
    if deep and body and deep.get('body') != body:
        raise SystemExit('%s is for body "%s" but the package was fitted to "%s"' % (deep_file, deep.get('body'), body))

    def dgroup(g, side=None):
        if not deep:
            return []
        return [np.array(p['positions']).reshape(-1, 3) for p in deep['parts'] if p['group'] == g and (side is None or p['side'] == side)]

    report = {'package': os.path.basename(pkg), 'deepGuides': bool(deep), 'source': {'vertices': n0, 'triangles': int(len(F0))}}
    jn = joints['names']
    jpos = np.array(joints['positions'], dtype=float)
    mid_x = float(jpos[jn.index('c_head'), 0]) if 'c_head' in jn else float(V0[regions['lips'], 0].mean())
    hm0 = half_edge_map(F0)

    # ── 1. 找线 / find the lines ────────────────────────────────────────────────────────────────
    lips = np.array(regions['lips'])
    path, sharp = find_oral_fissure(V0, F0, lips)
    upper_faces, lower_faces = split_sides(V0, F0, path)
    seg = np.linalg.norm(np.diff(V0[path], axis=0), axis=1)
    arc = np.r_[0, np.cumsum(seg)]
    report['oralFissure'] = {
        'vertices': int(len(path)), 'lengthMm': round(arc[-1] / MM, 2), 'longestEdgeMm': round(seg.max() / MM, 2),
        'sharpnessDeg': {'min': round(float(sharp[path].min()), 1), 'median': round(float(np.median(sharp[path])), 1)},
        'cornerRight': [round(float(v), 5) for v in V0[path[0]]], 'cornerLeft': [round(float(v), 5) for v in V0[path[-1]]],
        'stomion': [round(float(v), 5) for v in V0[path[len(path) // 2]]],
    }

    eyes = {}
    membrane_faces = []
    for side, reg, jname in (('L', 'lidsL', 'l_eye'), ('R', 'lidsR', 'r_eye')):
        strip, loop, ends = find_eye_membrane(V0, F0, np.array(regions[reg]), hm0)
        up, lo = split_lid_margins(V0, loop, ends, mid_x)
        eyes[side] = {'strip': strip, 'loop': loop, 'upper': up, 'lower': lo, 'joint': jpos[jn.index(jname)] if jname in jn else None}
        membrane_faces.append(strip)
    membrane_faces = np.concatenate(membrane_faces)

    # ── 2. 剪开口裂 / cut the oral fissure ──────────────────────────────────────────────────────
    V = [V0]
    src = [np.arange(n0)]  # 每个顶点的“来源顶点”/ the source vertex of every vertex
    tags = np.zeros(n0, np.uint8)
    count = n0

    def append(P, source, tag):
        nonlocal count, tags
        ids = np.arange(count, count + len(P))
        V.append(np.asarray(P, float))
        src.append(np.asarray(source))
        tags = np.r_[tags, np.full(len(P), TAGS[tag], np.uint8)]
        count += len(P)
        return ids

    interior = path[1:-1]
    dup = append(V0[interior], interior, 'lowerLip')
    remap = {int(a): int(b) for a, b in zip(interior, dup)}
    F = F0.copy()
    for f in lower_faces:
        F[f] = [remap.get(int(v), int(v)) for v in F0[f]]
    tags[interior] = TAGS['upperLip']
    tags[path[[0, -1]]] = TAGS['mouthCorner']
    upper_margin = [int(v) for v in path]
    lower_margin = [int(path[0])] + [int(v) for v in dup] + [int(path[-1])]

    # ── 3. 睑裂：删膜、加缘 / the palpebral fissures: remove the membrane, add the rim ───────────
    keep_face = np.ones(len(F), bool)
    rim_groups = []
    eye_manifest = {}
    eye_report = {}
    for side in ('L', 'R'):
        e = eyes[side]
        sc = dgroup('sclera', side)
        co = dgroup('cornea', side)
        if sc:
            # 巩膜上那粒远离主体的碎屑不算 / a speck far from the body of the sclera is ignored
            P = sc[0]
            P = P[np.linalg.norm(P - np.median(P, axis=0), axis=1) < 0.03]
            centre, radius = fit_sphere(P)
            centre_from = 'sphere fitted to the sclera part'
        else:
            centre, radius = (e['joint'] if e['joint'] is not None else V0[e['loop']].mean(0) - np.array([0, 0, 0.014])), 0.012
            centre_from = 'eye joint of joints.json, radius assumed 12 mm'
        loop = e['loop']
        rep = {
            'membraneTriangles': int(len(e['strip'])), 'loopVertices': int(len(loop)),
            'upperMarginVertices': len(e['upper']), 'lowerMarginVertices': len(e['lower']),
            'widthMm': round(float(np.linalg.norm(V0[e['upper'][0]] - V0[e['upper'][-1]])) / MM, 2),
            'apertureMm': round(float(V0[e['upper'], 1].max() - V0[e['lower'], 1].min()) / MM, 2),
            'canthusGapMm': {'medial': round(float(np.linalg.norm(V0[e['upper'][0]] - V0[e['lower'][0]])) / MM, 2), 'lateral': round(float(np.linalg.norm(V0[e['upper'][-1]] - V0[e['lower'][-1]])) / MM, 2)},
            'globeCentreFrom': centre_from, 'globeRadiusMm': round(radius / MM, 2),
        }
        if not args.keep_eye_membrane:
            keep_face[e['strip']] = False
            d = centre[None] - V0[loop]
            dist = np.linalg.norm(d, axis=1)
            length = np.clip(dist - (radius + 0.2 * MM), 0.5 * MM, args.lid_rim_mm * MM)
            rim = append(V0[loop] + d / dist[:, None] * length[:, None], loop, 'lidRim' + side)
            n = len(loop)
            tris = []
            for i in range(n):
                a, b, ra, rb = int(loop[i]), int(loop[(i + 1) % n]), int(rim[i]), int(rim[(i + 1) % n])
                # 与被删掉的膜三角形同向：(a → b) / wound like the membrane triangle it replaces: (a → b)
                tris += [[a, b, rb], [a, rb, ra]]
            rim_groups.append(('lidRim' + side, np.array(tris)))
            rep['rim'] = {'vertices': n, 'triangles': len(tris), 'lengthMm': {'min': round(float(length.min()) / MM, 2), 'mean': round(float(length.mean()) / MM, 2), 'max': round(float(length.max()) / MM, 2)},
                          'marginToGlobeSurfaceMm': {'min': round(float((dist - radius).min()) / MM, 2), 'median': round(float(np.median(dist - radius)) / MM, 2), 'max': round(float((dist - radius).max()) / MM, 2)}}
            eye_manifest['lidRim' + side] = {'vertices': [int(v) for v in rim], 'of': [int(v) for v in loop]}
        # 眦取下睑缘链的两个端点；上睑缘的环两端也接到这两个顶点上（它们之间本来就有一条边），两环在眦处共用一个顶点
        # each canthus is an end vertex of the lower chain; the upper loop is extended to those two vertices (an edge joins them anyway), so the loops share one vertex at each canthus
        tags[e['upper']] = TAGS['upperLid' + side]
        tags[e['lower']] = TAGS['lowerLid' + side]
        tags[[e['lower'][0], e['lower'][-1]]] = TAGS['canthus']
        e['upperLoop'] = ([e['lower'][0]] if e['upper'][0] != e['lower'][0] else []) + list(e['upper']) + ([e['lower'][-1]] if e['upper'][-1] != e['lower'][-1] else [])
        e['lowerLoop'] = list(e['lower'])
        # 与深层结构对比 / against the deep parts
        mid = V0[loop].mean(0)
        cmp = {'apertureCentre': [round(float(v), 5) for v in mid]}
        if sc:
            lateral = (mid[0] - centre[0]) * (1 if side == 'L' else -1)
            cmp['apertureCentreVsGlobeCentreMm'] = {'lateral': round(float(lateral) / MM, 2), 'up': round(float(mid[1] - centre[1]) / MM, 2), 'forward': round(float(mid[2] - centre[2]) / MM, 2)}
        if co:
            apex = co[0][np.argmax(co[0][:, 2])]
            near = loop[np.argsort(np.abs(V0[loop, 0] - apex[0]))[:6]]
            cmp['corneaApexMm'] = [round(float(v) / MM, 2) for v in apex]
            cmp['marginsAheadOfCorneaApexMm'] = round(float(V0[near, 2].mean() - apex[2]) / MM, 2)
        tu, tl = dgroup('tarsalUpper', side), dgroup('tarsalLower', side)
        if tu and tl:
            # 睑板的游离缘：上睑板的下缘、下睑板的上缘（中间三分之一）/ free margins of the tarsal plates: lower edge of the upper one, upper edge of the lower one (middle third)
            def free(P, upper):
                x0, x1 = np.percentile(P[:, 0], [33, 67])
                m = P[(P[:, 0] >= x0) & (P[:, 0] <= x1)]
                return float(np.percentile(m[:, 1], 5 if upper else 95)), float((x0 + x1) / 2)
            yu, xu = free(tu[0], True)
            yl, xl = free(tl[0], False)
            su = float(V0[e['upper']][np.argsort(np.abs(V0[e['upper'], 0] - xu))[:3], 1].mean())
            sl = float(V0[e['lower']][np.argsort(np.abs(V0[e['lower'], 0] - xl))[:3], 1].mean())
            cmp['skinMarginAboveTarsalFreeMarginMm'] = {'upper': round((su - yu) / MM, 2), 'lower': round((sl - yl) / MM, 2)}
            cmp['tarsalApertureMm'] = round((yu - yl) / MM, 2)
        rep['againstDeep'] = cmp
        eye_report[side] = rep
    report['palpebralFissures'] = eye_report

    # ── 4. 权重 / weights ───────────────────────────────────────────────────────────────────────
    wrec = np.fromfile(os.path.join(pkg, 'weights.bin'), dtype=[('v', '<u4'), ('j', '<u4'), ('w', '<f4')])
    nj = len(jn)
    W = sp.coo_matrix((wrec['w'].astype(np.float64), (wrec['v'], wrec['j'])), shape=(n0, nj)).tocsr()
    mapping = joints.get('mapping', [])
    jaw = next((i for i, m in enumerate(mapping) if (m or {}).get('anatomical') == 'tmj'), None)
    if jaw is None:
        jaw = next((i for i, nme in enumerate(jn) if nme.endswith('jaw')), None)
    if jaw is None:
        raise SystemExit('joints.json: no joint mapped to "tmj" and none named *jaw')
    parents = joints['parents']
    head_joint = parents[jaw]
    jaw_group = np.zeros(nj, bool)
    for i in range(nj):
        k = i
        while k >= 0:
            if k == jaw:
                jaw_group[i] = True
                break
            k = parents[k]
    Vc = np.concatenate(V)  # 目前：原顶点 + 下唇缘 + 睑缘内卷 / so far: source vertices + lower lip margin + lid rims
    srcc = np.concatenate(src)
    nc = len(Vc)
    skinF = F[keep_face]
    J0 = np.asarray(W[:, jaw_group].sum(1)).ravel()  # 原来的下颌份额 / the jaw share as delivered
    Jc = J0[srcc].copy()
    # 剪开后的皮肤图（不含内卷和口腔袋）/ graph of the cut skin (without rims and pouch)
    Ec, _ = unique_edges(skinF, nc)
    Lc = np.linalg.norm(Vc[Ec[:, 0]] - Vc[Ec[:, 1]], axis=1)
    Gc = graph(nc, Ec, Lc)
    um, lm = np.array(upper_margin[1:-1]), np.array(lower_margin[1:-1])
    geo = csgraph.dijkstra(Gc, indices=np.r_[um, lm], min_only=True, limit=args.weight_zone_mm * MM)
    zone = np.isfinite(geo)
    # 侧别场 s：在剪开后的网格上解调和方程，上唇缘 +1、下唇缘 −1（可选在口角处渐入），区域外缘不设条件。
    # 上唇一侧 s 接近 +1，下唇一侧接近 −1，口角及其外侧在 0 附近。
    # The side field s: harmonic on the cut mesh with +1 on the upper lip margin and −1 on the lower one
    # (optionally eased in at the corners) and no condition on the outer edge of the zone. s is close to +1
    # over the upper lip, close to −1 over the lower lip and near 0 at the corners and lateral to them.
    def jaw_share(taper_mm):
        """侧别场和新的下颌份额；taper_mm 是口角处渐入的弧长 / side field and new jaw share; taper_mm is the arc length of the ease-in at the corners"""
        taper = taper_mm * MM
        a_in = np.minimum(arc, arc[-1] - arc)[1:-1]
        x = np.ones(len(a_in)) if taper <= 0 else np.clip(a_in / taper, 0, 1)
        ease = x * x * (3 - 2 * x)
        st = np.full(nc, np.nan)
        st[um], st[lm] = ease, -ease
        wgt = 1.0 / np.maximum(Lc, 1e-6)
        inz = zone[Ec[:, 0]] & zone[Ec[:, 1]]
        A = graph(nc, Ec[inz], wgt[inz])
        Lap = sp.diags(np.asarray(A.sum(1)).ravel()) - A
        sk = np.where(zone & ~np.isnan(st))[0]
        fi = np.where(zone & np.isnan(st))[0]
        side_field = np.zeros(nc)
        side_field[sk] = st[sk]
        side_field[fi] = spla.spsolve((Lap[fi][:, fi] + 1e-9 * sp.eye(len(fi))).tocsc(), -Lap[fi][:, sk] @ st[sk])
        # 目标下颌份额 T：|s| ≥ 0.8 处取整（上唇 0、下唇 1），其间线性；新份额 = 原份额与 T 按 β 混合，
        # β 在口裂周围 inner_mm 内为 1（唇缘、唇的内面和唇红都严格按 T），再平滑降到区域外缘的 0。
        # Target jaw share T: saturated where |s| ≥ 0.8 (0 on the upper lip, 1 on the lower) and linear in between;
        # the new share blends the delivered one with T by β, which is 1 within inner_mm of the fissure (margins,
        # inner faces of the lips and vermilion follow T strictly) and falls smoothly to 0 at the edge of the zone.
        T = 0.5 - 0.5 * np.clip(1.25 * side_field, -1, 1)
        inner = min(args.weight_inner_mm, args.weight_zone_mm * 0.6) * MM
        x = np.clip((args.weight_zone_mm * MM - np.where(zone, geo, np.inf)) / (args.weight_zone_mm * MM - inner), 0, 1)
        beta = x * x * (3 - 2 * x)
        Jn = np.where(zone, (1 - beta) * Jc + beta * T, Jc)
        return side_field, Jn

    side_field, Jn = jaw_share(args.corner_taper_mm)
    alt_taper = args.alt_corner_taper_mm
    Jalt = jaw_share(alt_taper)[1] if alt_taper > 0 and alt_taper != args.corner_taper_mm else None

    def band_stats(J):
        # 到口裂线的欧氏距离分带 / bands of Euclidean distance from the fissure line
        from scipy.spatial import cKDTree
        dense = np.concatenate([np.linspace(V0[a], V0[b], 8) for a, b in zip(path[:-1], path[1:])])
        d = cKDTree(dense).query(Vc[:len(J)])[0]
        rows = {}
        for name, sgn in (('upper', 1), ('lower', -1)):
            for lo_, hi_ in ((0, 3), (3, 6), (6, 10)):
                m = zone[:len(J)] & (sgn * side_field[:len(J)] > 0.25) & (d >= lo_ * MM) & (d < hi_ * MM)
                rows['%s %d-%d mm' % (name, lo_, hi_)] = {'vertices': int(m.sum()), 'meanJaw': round(float(J[m].mean()), 3) if m.any() else None, 'minJaw': round(float(J[m].min()), 3) if m.any() else None, 'maxJaw': round(float(J[m].max()), 3) if m.any() else None}
        return rows

    report['weights'] = {
        'jawJoint': jn[jaw], 'skullSideJoint': jn[head_joint], 'jawGroup': [jn[i] for i in np.where(jaw_group)[0]],
        'zoneMm': args.weight_zone_mm, 'cornerTaperMm': args.corner_taper_mm, 'innerMm': args.weight_inner_mm, 'zoneVertices': int(zone.sum()),
        'acrossTheCut': {
            'before': {'upperMargin': {'meanJaw': round(float(J0[path[1:-1]].mean()), 3), 'minJaw': round(float(J0[path[1:-1]].min()), 3), 'maxJaw': round(float(J0[path[1:-1]].max()), 3)}, 'lowerMargin': 'the same vertices (not yet cut)', 'corners': [round(float(J0[path[0]]), 3), round(float(J0[path[-1]]), 3)]},
            'after': {'upperMargin': {'meanJaw': round(float(Jn[um].mean()), 3), 'maxJaw': round(float(Jn[um].max()), 3)}, 'lowerMargin': {'meanJaw': round(float(Jn[lm].mean()), 3), 'minJaw': round(float(Jn[lm].min()), 3)}, 'corners': [round(float(Jn[path[0]]), 3), round(float(Jn[path[-1]]), 3)]},
        },
        'bandsBefore': band_stats(Jc), 'bandsAfter': band_stats(Jn),
        'changedVertices': int((np.abs(Jn - Jc) > 1e-4).sum()), 'largestChange': round(float(np.abs(Jn - Jc).max()), 3),
    }

    # ── 5. 口腔袋 / the oral pouch ──────────────────────────────────────────────────────────────
    pouch_groups = []
    pouch_manifest = None
    pouch_J = {}
    if not args.no_pouch:
        K = 12
        c0, c1 = V0[path[0]], V0[path[-1]]
        zf = float(V0[path, 2].max())
        teeth = dgroup('upperTeeth') + dgroup('lowerTeeth')
        if teeth:
            oral = np.concatenate(teeth + dgroup('upperGingiva') + dgroup('lowerGingiva') + dgroup('tongue'))
            T = np.concatenate(teeth)
            slope = float(np.polyfit(T[:, 2], T[:, 1], 1)[0])  # 咬合平面的前后倾斜 / the fore-aft tilt of the occlusal plane
            pad = 3 * MM
            half_width = float(np.abs(oral[:, 0] - (c0[0] + c1[0]) / 2).max() + pad)
            depth = float(min(c0[2], c1[2]) - (oral[:, 2].min() - pad))
            yc = (c0[1] + c1[1]) / 2
            # 高度相对于缝：缝随咬合平面向后升高，取中段的缝高作参考 / heights relative to the seam, which rises backwards with the occlusal plane; the seam height half way back is the reference
            y_ref = yc - slope * depth * 0.5
            h_up = float(oral[:, 1].max() + pad - y_ref)
            h_down = float(y_ref - (oral[:, 1].min() - pad))
            sized = 'bounding box of teeth, gingiva and tongue (deep-face.json) plus 3 mm'
        else:
            slope, half_width, depth, h_up, h_down = 0.0, 0.040, 0.070, 0.030, 0.028
            sized = 'default dimensions (no deep-face.json given)'
        seam = pouch_seam(c0, c1, half_width, depth, slope, len(path))
        up, lo, tk = build_pouch(V0[path], V0[path], seam, h_up, h_down, K)
        # 不许碰到外面的皮肤：离闭合皮肤不到 3 mm（或在其外）的袋顶点沿最近点方向推回去
        # the pouch may not touch the skin: vertices within 3 mm of the closed skin (or outside it) are pushed back along the direction of the nearest point
        import igl
        clear = 3 * MM
        pushed = 0
        Vf, Ff = np.ascontiguousarray(V0), np.ascontiguousarray(F0)
        for arr in (up, lo):
            P = arr[1:, 1:-1].reshape(-1, 3).copy()
            for _ in range(6):
                S, _, C = igl.signed_distance(P, Vf, Ff)[:3]
                bad = S > -clear
                if not bad.any():
                    break
                pushed = max(pushed, int(bad.sum()))
                g = P[bad] - C[bad]
                g /= np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-9)
                g *= np.where(S[bad] > 0, -1.0, 1.0)[:, None]  # 指向体内 / pointing into the body
                P[bad] += g * (S[bad] + clear)[:, None] * 1.05
            arr[1:, 1:-1] = P.reshape(arr[1:, 1:-1].shape)
        seam_pts = (up[K, 1:-1] + lo[K, 1:-1]) / 2
        n = len(path)
        col_src = path[1:-1]
        up_ids = np.zeros((K + 1, n), np.int64)
        lo_ids = np.zeros((K + 1, n), np.int64)
        up_ids[0], lo_ids[0] = upper_margin, lower_margin
        up_ids[:, 0] = lo_ids[:, 0] = path[0]
        up_ids[:, -1] = lo_ids[:, -1] = path[-1]
        for k in range(1, K):
            up_ids[k, 1:-1] = append(up[k, 1:-1], col_src, 'oralPouchUpper')
        for k in range(1, K):
            lo_ids[k, 1:-1] = append(lo[k, 1:-1], col_src, 'oralPouchLower')
        seam_ids = append(seam_pts, col_src, 'oralPouchSeam')
        up_ids[K, 1:-1] = lo_ids[K, 1:-1] = seam_ids
        # 袋壁的下颌份额：上半 0、下半 1，最后 40% 的行向缝上的 0.5 过渡
        # jaw share of the walls: 0 above and 1 below, easing to 0.5 at the seam over the last 40% of the rows
        for k in range(1, K + 1):
            x = np.clip((tk[k] - 0.6) / 0.4, 0, 1)
            e = 0.5 * x * x * (3 - 2 * x)
            for v in up_ids[k, 1:-1]:
                pouch_J[int(v)] = e
            if k < K:
                for v in lo_ids[k, 1:-1]:
                    pouch_J[int(v)] = 1 - e

        def shell(ids, flip):
            tris = []
            for k in range(K):
                for i in range(n - 1):
                    a, b, c, d = int(ids[k, i]), int(ids[k, i + 1]), int(ids[k + 1, i + 1]), int(ids[k + 1, i])
                    for t in ([a, b, c], [a, c, d]):
                        if len(set(t)) == 3:
                            tris.append(t[::-1] if flip else t)
            return np.array(tris)
        # 绕向：袋的可见面（腔内一侧）与皮肤的外面连续，即在唇缘上与相邻皮肤三角形的边方向相反
        # winding: the visible (cavity) side of the pouch continues the outside of the skin, i.e. on the margin its edges run against those of the skin triangle next to it
        hm_skin = half_edge_map(skinF)
        a, b = upper_margin[1], upper_margin[2]
        up_flip = (a, b) in hm_skin  # 皮肤已占用 (a → b)，袋就得用 (b → a) / the skin holds (a → b), so the pouch takes (b → a)
        a, b = lower_margin[1], lower_margin[2]
        lo_flip = (a, b) in hm_skin
        pouch_groups = [('oralPouchUpper', shell(up_ids, up_flip)), ('oralPouchLower', shell(lo_ids, lo_flip))]
        pouch_manifest = {
            'upper': [int(v) for v in up_ids[1:K, 1:-1].ravel()], 'lower': [int(v) for v in lo_ids[1:K, 1:-1].ravel()], 'seam': [int(v) for v in seam_ids],
            'rows': K - 1, 'columns': n - 2,
            'layout': {'zh': 'upper / lower 各按行排列：第 r 行第 c 列 = 下标 r × columns + c；行从唇缘向缝，列与 upperLip / lowerLip 去掉两端口角后的顶点一一对应。seam 的第 c 个顶点同理。', 'en': 'upper / lower are stored row by row: row r, column c = index r × columns + c; rows run from the margin to the seam, and column c belongs to vertex c of upperLip / lowerLip without the two corners. Likewise vertex c of seam.'},
        }
        allp = np.concatenate([up[1:, 1:-1].reshape(-1, 3), lo[1:K, 1:-1].reshape(-1, 3)])
        S = igl.signed_distance(allp, Vf, Ff)[0]
        report['oralPouch'] = {
            'sizedFrom': sized, 'halfWidthMm': round(half_width / MM, 1), 'depthMm': round(depth / MM, 1), 'heightAboveSeamMm': round(h_up / MM, 1), 'heightBelowSeamMm': round(h_down / MM, 1), 'occlusalSlope': round(slope, 3),
            'vertices': int(2 * (K - 1) * (n - 2) + (n - 2)), 'triangles': int(len(pouch_groups[0][1]) + len(pouch_groups[1][1])),
            'verticesPushedInward': pushed, 'clearanceToClosedSkinMm': {'least': round(float(-S.max()) / MM, 2), 'median': round(float(-np.median(S)) / MM, 2)},
        }
        if deep:
            # 牙、舌有多少在袋内（袋 + 闭合口裂线构成的近似封闭体；用绕数判断）
            # how much of teeth and tongue lies inside the pouch (the two walls form a closed bag once the slit is zipped; generalised winding number)
            bagV = np.concatenate(V)
            bagF = np.concatenate([g[1] for g in pouch_groups])
            zip_map = {int(b_): int(a_) for a_, b_ in zip(upper_margin, lower_margin)}
            bagF = np.vectorize(lambda v: zip_map.get(int(v), int(v)))(bagF)
            inside = {}
            for gname in ('upperTeeth', 'lowerTeeth', 'upperGingiva', 'lowerGingiva', 'tongue'):
                P = np.concatenate(dgroup(gname))
                wn = igl.winding_number(np.ascontiguousarray(bagV), np.ascontiguousarray(bagF), np.ascontiguousarray(P))
                inside[gname] = round(float((np.abs(wn) > 0.5).mean()), 3)
            report['oralPouch']['shareOfDeepVerticesInside'] = inside

    Vn = np.concatenate(V)
    srcn = np.concatenate(src)
    nn = len(Vn)

    # ── 6. 与深层结构对比（口）/ against the deep parts (mouth) ──────────────────────────────────
    if deep:
        ut, lt, lipp = dgroup('upperTeeth'), dgroup('lowerTeeth'), dgroup('lip')
        xm = float(V0[path, 0].mean())
        pm = V0[path][np.abs(V0[path, 0] - xm) < 9 * MM]
        cmp = {}
        if ut and lt:
            ci = np.concatenate(ut)
            ci = ci[np.abs(ci[:, 0] - xm) < 9 * MM]
            li = np.concatenate(lt)
            li = li[np.abs(li[:, 0] - xm) < 9 * MM]
            cmp['cutLineAboveUpperIncisalEdgeMm'] = round(float(pm[:, 1].mean() - ci[:, 1].min()) / MM, 2)
            cmp['cutLineAheadOfUpperIncisorsMm'] = round(float(pm[:, 2].mean() - ci[:, 2].max()) / MM, 2)
            cmp['cutLineAboveLowerIncisalEdgeMm'] = round(float(pm[:, 1].mean() - li[:, 1].max()) / MM, 2)
            cmp['incisorOverlapMm'] = round(float(li[:, 1].max() - ci[:, 1].min()) / MM, 2)
        if lipp:
            P = lipp[0]
            cmp['deepLipPart'] = {'widthMm': round(float(np.ptp(P[:, 0])) / MM, 1), 'skinMouthWidthMm': round(float(abs(V0[path[0], 0] - V0[path[-1], 0])) / MM, 1),
                                  'centreXMm': round(float((P[:, 0].max() + P[:, 0].min()) / 2) / MM, 1), 'skinStomionXMm': round(xm / MM, 1)}
        if deep.get('tmj'):
            cmp['tmj'] = deep['tmj']
        report['oralFissure']['againstDeep'] = cmp

    # ── 7. 写文件 / write the files ─────────────────────────────────────────────────────────────
    groups = [('skin', skinF)] + rim_groups + pouch_groups
    allF = np.concatenate([g[1] for g in groups])
    mod = '# modified by tools/skinopen: oral fissure cut, eye membranes removed, lid rims and oral pouch added (construction aids); see manifest.json'
    write_obj(os.path.join(out, 'skin.obj'), Vn, groups, head + [mod])
    shutil.copyfile(os.path.join(pkg, 'skin.obj'), os.path.join(out, 'skin-closed.obj'))

    # 权重：原记录照抄，区域内的顶点按新的下颌份额重写，新顶点补上
    # weights: source records are copied, vertices of the zone are rewritten with the new jaw share, new vertices are added
    def weight_records(Jn):
        rows_v, rows_j, rows_w = [], [], []
        Wc = W.tocsr()
        Jfinal = np.zeros(nn)
        Jfinal[:nc] = Jn
        changed = np.zeros(nn, bool)
        changed[:nc] = np.abs(Jn - Jc) > 1e-6
        for v, j_ in pouch_J.items():
            Jfinal[v] = j_
            changed[v] = True
        for v in range(nn):
            s = int(srcn[v])
            lo_, hi_ = Wc.indptr[s], Wc.indptr[s + 1]
            js, ws = Wc.indices[lo_:hi_], Wc.data[lo_:hi_].copy()
            if changed[v]:
                inj = jaw_group[js]
                a = ws[inj].sum()
                J = Jfinal[v]
                acc = {}
                if a > 1e-9:
                    for j_, w_ in zip(js[inj], ws[inj]):
                        acc[int(j_)] = w_ * J / a
                elif J > 0:
                    acc[jaw] = J
                if 1 - a > 1e-9:
                    for j_, w_ in zip(js[~inj], ws[~inj]):
                        acc[int(j_)] = acc.get(int(j_), 0) + w_ * (1 - J) / (1 - a)
                elif J < 1:
                    acc[head_joint] = acc.get(head_joint, 0) + (1 - J)
                js = np.array([k for k, w_ in acc.items() if w_ > 1e-7], dtype=np.int64)
                ws = np.array([acc[int(k)] for k in js])
                ws /= ws.sum()
            rows_v.append(np.full(len(js), v))
            rows_j.append(js)
            rows_w.append(ws)
        rec = np.zeros(sum(len(x) for x in rows_v), dtype=[('v', '<u4'), ('j', '<u4'), ('w', '<f4')])
        rec['v'], rec['j'], rec['w'] = np.concatenate(rows_v), np.concatenate(rows_j), np.concatenate(rows_w)
        return rec, changed

    rec, changed = weight_records(Jn)
    rec.tofile(os.path.join(out, 'weights.bin'))
    alt_name = None
    if Jalt is not None:
        alt_name = 'weights-corner-taper.bin'
        rec_alt, _ = weight_records(Jalt)
        rec_alt.tofile(os.path.join(out, alt_name))

    # 其余逐顶点的 float32 文件：长度是 n 或 3n 的都按来源顶点扩展。存绝对位置的文件（与 skin.obj 相差很小）
    # 加上新顶点相对其来源顶点的偏移，存位移或标量的直接取来源顶点的值。
    # Other per-vertex float32 files: any of length n or 3n is extended through the source vertices. A file
    # holding absolute positions (close to skin.obj) gets the offset of the new vertex from its source added;
    # one holding displacements or scalars takes the source vertex's value.
    carried = {}
    for name in sorted(os.listdir(pkg)):
        p = os.path.join(pkg, name)
        if not name.endswith('.f32'):
            continue
        a = np.fromfile(p, dtype='<f4')
        if a.size == 3 * n0:
            a = a.reshape(n0, 3)
            is_pos = float(np.median(np.linalg.norm(a - V0, axis=1))) < 0.05 and float(np.median(np.linalg.norm(a, axis=1))) > 0.2
            b = a[srcn].astype(np.float64)
            if is_pos:
                b += Vn - V0[srcn]
            b.astype('<f4').tofile(os.path.join(out, name))
            carried[name] = 'float32 [%d][3], %s' % (nn, 'absolute positions: new vertex = its position in skin.obj + (file − skin.obj) at its source vertex' if is_pos else 'per-vertex vectors: new vertices take the value of their source vertex')
        elif a.size == n0:
            a[srcn].astype('<f4').tofile(os.path.join(out, name))
            carried[name] = 'float32 [%d]: new vertices take the value of their source vertex' % nn
        else:
            carried[name] = 'NOT per-vertex (size %d): not copied' % a.size
    tags.tofile(os.path.join(out, 'vertex-tags.u8'))
    srcn.astype('<u4').tofile(os.path.join(out, 'source-vertex.u32'))

    # 其余小文件照抄（图片、拟合状态等大文件不抄）/ other small files are copied (not images or fit states)
    for name in sorted(os.listdir(pkg)):
        p = os.path.join(pkg, name)
        if not os.path.isfile(p) or name in ('skin.obj', 'weights.bin', 'manifest.json', 'shape-fields.json') or name.endswith(('.f32', '.png', '.npz', '.log')):
            continue
        shutil.copyfile(p, os.path.join(out, name))
    sfp = os.path.join(pkg, 'shape-fields.json')
    if os.path.exists(sfp):
        sf_ = json.load(open(sfp))
        if 'vertices' in sf_:
            sf_['vertices'] = nn
        sf_['openedBy'] = 'tools/skinopen: fields extended to %d vertices through source-vertex.u32' % nn
        json.dump(sf_, open(os.path.join(out, 'shape-fields.json'), 'w'), ensure_ascii=False, indent=1)

    # manifest
    m = json.loads(json.dumps(manifest))
    face = m.setdefault('face', {})
    face['topologyAsDelivered'] = face.pop('topology', None)
    face['topology'] = {
        'zh': '已由 tools/skinopen 开口：口裂沿 MHR 两唇之间口袋的袋底剪开（上、下唇缘是两条重合的顶点链，只在口角共用顶点）；两眼封住睑裂的三角形带已删除，睑裂是洞。皮肤不再是闭合曲面：有 3 个开口，口裂后面接着口腔袋，所以边界环只剩两眼内卷的内缘。需要闭合曲面的程序请用 skin-closed.obj。',
        'en': 'Opened by tools/skinopen: the oral fissure is cut along the bottom of the pocket MHR has between the lips (upper and lower lip margin are two coincident vertex chains that share only the corner vertices); the strip of triangles that closed each palpebral fissure is removed, so the fissures are holes. The skin is no longer a closed surface: it has 3 openings; the oral one is closed off behind by the oral pouch, so the only boundary loops left are the inner edges of the two lid rims. Programs that need a closed surface use skin-closed.obj.',
    }
    margins = {
        'upperLip': upper_margin, 'lowerLip': lower_margin,
        'mouthCornerR': int(path[0]), 'mouthCornerL': int(path[-1]),
    }
    for side in ('L', 'R'):
        e = eyes[side]
        margins['upperLid' + side] = [int(v) for v in e['upperLoop']]
        margins['lowerLid' + side] = [int(v) for v in e['lowerLoop']]
        margins['medialCanthus' + side] = int(e['lowerLoop'][0])
        margins['lateralCanthus' + side] = int(e['lowerLoop'][-1])
    face['margins'] = margins
    face['marginsNote'] = {
        'zh': '顶点下标（skin.obj 的顺序；0…%d 与原皮肤相同，其后是新增的）。六条链都从内向外排：upperLip / lowerLip 从身体右侧口角（mouthCornerR，−X）到左侧口角（mouthCornerL，+X），首尾是两条链共用的口角顶点，其余顶点两两重合（同一位置、不同下标：upperLip 用原下标，lowerLip 用新下标）；唇缘在 MHR 唇间口袋的袋底，比从正面看到的唇线靠后约 3 mm，袋的两壁即上、下唇的内面。upperLid* / lowerLid* 从内眦（medialCanthus*）到外眦（lateralCanthus*），两条链在两眦各共用一个顶点；睑缘之间没有重合顶点（原皮肤的眼是睁开的，两睑缘之间的封膜已删去）。' % (n0 - 1),
        'en': 'Vertex indices (order of skin.obj; 0…%d are those of the delivered skin, new ones follow). All six chains are ordered from medial to lateral in the sense asked for: upperLip / lowerLip run from the body\'s right mouth corner (mouthCornerR, −X) to the left one (mouthCornerL, +X); first and last are the corner vertices shared by both chains, the others coincide in pairs (same position, different index: upperLip keeps the original indices, lowerLip has the new ones). The lip margins lie at the bottom of MHR\'s pocket between the lips, about 3 mm behind the lip line seen from the front; the walls of the pocket are the inner faces of the lips. upperLid* / lowerLid* run from the medial canthus (medialCanthus*) to the lateral canthus (lateralCanthus*) and share one vertex at each canthus; no lid vertices coincide (the delivered skin has open eyes, and the membrane between the margins is removed).' % (n0 - 1),
    }
    # 剪口附近每个顶点在哪一片上 / which sheet every vertex near a cut lies on
    sheets = {
        'note': {
            'zh': '剪口附近的顶点属于哪一片（下标列表）。口：口裂周围 %g mm（沿表面）内的皮肤顶点，按调和侧别场分为 upper（上唇，含 upperLip 的内部顶点）和 lower（下唇，含 lowerLip 的内部顶点）；口角及其外侧分不出上下的顶点列在 lateral。眼：洞口周围 6 mm 内的皮肤顶点按较近的睑缘分为 upper / lower，两眦在 canthi。rim / pouch 是构造物的全部顶点。重合的顶点对总是一个在 upper、一个在 lower。' % args.weight_zone_mm,
            'en': 'The sheet of every vertex near a cut (index lists). Mouth: skin vertices within %g mm of the fissure (along the surface), split by a harmonic side field into upper (upper lip, with the interior vertices of upperLip) and lower (lower lip, with the interior vertices of lowerLip); the corners and the vertices lateral to them that are neither are under lateral. Eyes: skin vertices within 6 mm of the opening go to the nearer margin, upper / lower, and the canthi are under canthi. rim / pouch hold every vertex of the construction geometry. Of a coincident pair one vertex is always in upper and the other in lower.' % args.weight_zone_mm,
        },
        'mouth': {
            'upper': [int(v) for v in np.where(zone & (side_field > 0.25))[0] if v < n0 + len(dup)],
            'lower': [int(v) for v in np.where(zone & (side_field < -0.25))[0] if v < n0 + len(dup)],
            'lateral': [int(v) for v in np.where(zone & (np.abs(side_field) <= 0.25))[0] if v < n0 + len(dup)],
        },
    }
    for side in ('L', 'R'):
        e = eyes[side]
        up_i, lo_i = np.array(e['upper']), np.array(e['lower'])
        can = [int(e['lowerLoop'][0]), int(e['lowerLoop'][-1])]
        du = csgraph.dijkstra(Gc, indices=up_i, min_only=True, limit=6 * MM)
        dl = csgraph.dijkstra(Gc, indices=lo_i, min_only=True, limit=6 * MM)
        near_eye = (np.isfinite(du) | np.isfinite(dl)) & (np.arange(nc) < n0)
        near_eye[can] = False
        sheets['eye' + side] = {'upper': [int(v) for v in np.where(near_eye & (du <= dl))[0]], 'lower': [int(v) for v in np.where(near_eye & (du > dl))[0]], 'canthi': can}
    sheets['rim'] = sorted(int(v) for k in ('lidRimL', 'lidRimR') for v in eye_manifest.get(k, {}).get('vertices', []))
    sheets['pouch'] = sorted((pouch_manifest['upper'] + pouch_manifest['lower'] + pouch_manifest['seam']) if pouch_manifest else [])
    face['sheets'] = sheets
    face['added'] = {
        'zh': '加了东西，都仍是皮肤网格的一部分，不是新的解剖部件：口裂后面有口腔袋（constructionAids.oralPouch，sheets.pouch），两眼洞口有朝向眼球的内卷（constructionAids.lidRimL / lidRimR，sheets.rim）。睑裂后面没有别的东西：洞里看到的是解剖数据里真正的眼球。',
        'en': 'Geometry was added, all of it still part of the skin mesh and not a new anatomy part: an oral pouch behind the oral fissure (constructionAids.oralPouch, sheets.pouch) and a rim turned towards the globe round each eye opening (constructionAids.lidRimL / lidRimR, sheets.rim). Nothing else lies behind the lids: what shows through the openings is the real eyeball of the anatomy data.',
    }
    aids = {
        'note': {
            'zh': '以下顶点是构造物，不是解剖：它们只是为了开口时不露出身体内部的空腔。lidRim：沿睑裂洞口朝眼球方向内卷的一圈（of 给出每个顶点所属的睑缘顶点）。oralPouch：接在两条唇缘后面的口腔袋，包住牙、牙龈和舌，上半随颅、下半随下颌，在 seam 处相接；显示时应当用深色、不透明、不参与体表图和触诊。',
            'en': 'The vertices below are construction aids, not anatomy: they only keep the hollow inside of the body from showing through the openings. lidRim: a collar turned in towards the globe round each palpebral opening (`of` gives the margin vertex each rim vertex belongs to). oralPouch: a bag attached behind the two lip margins that encloses teeth, gingiva and tongue; its upper half follows the skull and its lower half the jaw, and they meet at `seam`. It should be drawn dark and opaque and take no part in skin maps or palpation.',
        },
    }
    aids.update(eye_manifest)
    if pouch_manifest:
        aids['oralPouch'] = pouch_manifest
    face['constructionAids'] = aids
    if not args.keep_eye_membrane:
        face['removedEyeMembrane'] = {
            'note': {'zh': '从 skin.obj 删去的三角形（顶点下标三元组），在 skin-closed.obj 里仍在。', 'en': 'Triangles removed from skin.obj (vertex index triples); still present in skin-closed.obj.'},
            'L': [[int(v) for v in F0[f]] for f in eyes['L']['strip']], 'R': [[int(v) for v in F0[f]] for f in eyes['R']['strip']],
        }
    m['opened'] = {
        'by': 'tools/skinopen/open_skin.py',
        'modification': {
            'zh': '本包由原皮肤包（%s）修改而来（Apache-2.0 第 4(b) 条的修改声明）：剪开口裂、删除两眼的封膜、添加睑缘内卷和口腔袋、重算口裂两侧的下颌权重、把逐顶点文件扩展到新顶点。原皮肤原样保存在 skin-closed.obj。' % os.path.basename(pkg),
            'en': 'This package is a modification of the skin package %s (statement of changes under section 4(b) of the Apache License 2.0): oral fissure cut, the membranes over both eyes removed, lid rims and an oral pouch added, the jaw weight recomputed on both sides of the fissure, per-vertex files extended to the new vertices. The skin as delivered is kept unchanged in skin-closed.obj.' % os.path.basename(pkg),
        },
        'options': {'cornerTaperMm': args.corner_taper_mm, 'altCornerTaperMm': alt_taper if alt_name else None, 'weightZoneMm': args.weight_zone_mm, 'weightInnerMm': args.weight_inner_mm, 'lidRimMm': args.lid_rim_mm, 'keepEyeMembrane': args.keep_eye_membrane, 'pouch': not args.no_pouch, 'deepGuides': bool(deep)},
        'sourceVertices': n0, 'vertices': nn, 'sourceTriangles': int(len(F0)), 'triangles': int(len(allF)),
        'vertexTags': TAGS,
    }
    loops = boundary_loops(allF, nn)
    files = dict(m.get('files', {}))
    files['skin.obj'] = '%d vertices, %d triangles; vertices 0…%d are those of the delivered skin in the same order (MHR LOD0), the rest are appended; groups: %s; closed: False (%d boundary loops)' % (nn, len(allF), n0 - 1, ', '.join('%s %d' % (g[0], len(g[1])) for g in groups), len(loops))
    files['skin-closed.obj'] = 'the skin as delivered, byte for byte: %d vertices, %d triangles, closed; for every consumer that needs a closed surface' % (n0, len(F0))
    files['weights.bin'] = '%d records (uint32 vertex, uint32 joint, float32 weight), little endian; all %d vertices' % (len(rec), nn)
    if alt_name:
        files[alt_name] = 'the same records as weights.bin but with the split of the jaw share eased in over %g mm of arc length from each mouth corner (upper margin 0.5 → 0, lower margin 0.5 → 1); %d records, all %d vertices. An alternative to weights.bin, not an addition: use one or the other' % (alt_taper, len(rec_alt), nn)
        m['opened']['cornerTaper'] = {
            'zh': 'weights.bin 是默认的：口裂处精确分开，直到口角（上唇缘下颌份额 0，下唇缘 1）；张口时口角处是方的。%s 是另一种选择：从每个口角起 %g mm 弧长内渐入，张口呈杏仁形，但这一段唇缘不再是精确分开的。两个文件的记录格式、顶点编号都相同，二选一。' % (alt_name, alt_taper),
            'en': 'weights.bin is the default: an exact split at the fissure right up to the corners (jaw share 0 on the upper margin, 1 on the lower); the opened mouth has square corners. %s is the alternative: the split eases in over %g mm of arc length from each corner, which gives an almond-shaped opening, but the margins are not split exactly over that stretch. Both files have the same record format and vertex numbering; use one or the other.' % (alt_name, alt_taper),
        }
    files['vertex-tags.u8'] = 'uint8 [%d]: what each vertex is, see opened.vertexTags' % nn
    files['source-vertex.u32'] = 'uint32 [%d]: for each vertex the vertex of skin-closed.obj it derives its per-vertex data from (itself for the first %d)' % (nn, n0)
    for k, v in carried.items():
        base = files.get(k, '')
        files[k] = (base + ' — ' if base else '') + 'opened: ' + v
    files['open-report.json'] = 'measurements of this run (tools/skinopen)'
    m['files'] = files
    json.dump(m, open(os.path.join(out, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)

    report['result'] = {
        'vertices': nn, 'triangles': int(len(allF)), 'addedVertices': nn - n0,
        'added': {'lowerLip': int(len(dup)), 'lidRimL': len(eye_manifest.get('lidRimL', {}).get('vertices', [])), 'lidRimR': len(eye_manifest.get('lidRimR', {}).get('vertices', [])),
                  'oralPouch': int(report.get('oralPouch', {}).get('vertices', 0))},
        'removedTriangles': int((~keep_face).sum()), 'groups': {g[0]: int(len(g[1])) for g in groups}, 'boundaryLoops': loops,
    }

    # ── 8. 自检：重新读回写出的文件 / self-check: read the written files back ────────────────────
    V2, F2, _ = read_obj(os.path.join(out, 'skin.obj'))
    checks = {}
    checks['objVertices'] = len(V2) == nn
    checks['objTriangles'] = len(F2) == len(allF)
    checks['indicesInRange'] = bool(F2.min() >= 0 and F2.max() < nn)
    checks['everyVertexUsed'] = bool(len(np.unique(F2)) == nn)
    checks['noDegenerateTriangle'] = bool(((F2[:, 0] != F2[:, 1]) & (F2[:, 1] != F2[:, 2]) & (F2[:, 0] != F2[:, 2])).all())
    _, cnt = unique_edges(F2, nn)
    checks['noEdgeSharedByMoreThanTwo'] = bool((cnt <= 2).all())
    hm2 = half_edge_map(F2)
    checks['consistentWinding'] = len(hm2) == 3 * len(F2)
    checks['sourceVerticesUnmoved'] = bool(np.abs(V2[:n0] - V0).max() < 2e-6)
    Vc2, Fc2, _ = read_obj(os.path.join(out, 'skin-closed.obj'))
    checks['closedCompanionIdentical'] = bool(len(Vc2) == n0 and np.array_equal(Fc2, F0))
    r2 = np.fromfile(os.path.join(out, 'weights.bin'), dtype=[('v', '<u4'), ('j', '<u4'), ('w', '<f4')])
    sums = np.bincount(r2['v'], weights=r2['w'], minlength=nn)
    checks['weightsCoverEveryVertex'] = bool(len(sums) == nn and np.abs(sums - 1).max() < 1e-4)
    if alt_name:
        r3 = np.fromfile(os.path.join(out, alt_name), dtype=[('v', '<u4'), ('j', '<u4'), ('w', '<f4')])
        s3 = np.bincount(r3['v'], weights=r3['w'], minlength=nn)
        checks['altWeightsCoverEveryVertex'] = bool(len(s3) == nn and np.abs(s3 - 1).max() < 1e-4 and r3['j'].max() < nj)
        report['weights']['cornerTaperFile'] = {'file': alt_name, 'taperMm': alt_taper, 'upperMarginJaw': {'mean': round(float(Jalt[um].mean()), 3), 'max': round(float(Jalt[um].max()), 3)}, 'lowerMarginJaw': {'mean': round(float(Jalt[lm].mean()), 3), 'min': round(float(Jalt[lm].min()), 3)},
                                             'marginVerticesNotExact': int(((Jalt[um] > 1e-6) | (Jalt[lm] < 1 - 1e-6)).sum()), 'verticesDifferingFromDefault': int((np.abs(Jalt - Jn) > 1e-4).sum())}
    checks['weightsJointsInRange'] = bool(r2['j'].max() < nj)
    checks['weightsAtMost7Joints'] = bool(np.bincount(r2['v'], minlength=nn).max() <= 7)
    untouched = ~changed[:n0]
    w_old = sp.coo_matrix((wrec['w'], (wrec['v'], wrec['j'])), shape=(n0, nj)).tocsr()
    keep_rows = r2['v'] < n0
    w_new = sp.coo_matrix((r2['w'][keep_rows], (r2['v'][keep_rows], r2['j'][keep_rows])), shape=(n0, nj)).tocsr()
    checks['weightsOutsideZoneUnchanged'] = bool(abs(w_old[untouched] - w_new[untouched]).max() < 1e-7)
    for name, what in carried.items():
        if what.startswith('NOT'):
            continue
        a = np.fromfile(os.path.join(out, name), dtype='<f4')
        o_ = np.fromfile(os.path.join(pkg, name), dtype='<f4')
        per = a.size // nn
        checks['field ' + name] = bool(a.size in (nn, 3 * nn) and np.array_equal(a[:n0 * per], o_))
    checks['tagsLength'] = os.path.getsize(os.path.join(out, 'vertex-tags.u8')) == nn
    checks['licenceFilesPresent'] = all(os.path.exists(os.path.join(out, f)) for f in os.listdir(pkg) if f.upper().startswith(('LICENSE', 'NOTICE'))) and any(f.upper().startswith('LICENSE') for f in os.listdir(out))
    checks['marginsCoincide'] = bool(np.abs(V2[upper_margin] - V2[lower_margin]).max() == 0)
    checks['boundaryLoops'] = loops
    report['checks'] = checks
    json.dump(report, open(os.path.join(out, 'open-report.json'), 'w'), ensure_ascii=False, indent=1)
    print(json.dumps(report, ensure_ascii=False, indent=1))
    bad = [k for k, v in checks.items() if v is False]
    if bad:
        print('FAILED checks: ' + ', '.join(bad), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
