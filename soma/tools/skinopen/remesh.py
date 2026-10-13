# 三角网格上的几样小手术：按一个标量场的等值线切开；把过长的边对半分；把过短的边收掉；翻边；切向松弛。
# genital.py 和 vulva.py 用它们把一片面重新布成边长渐变的网格。都是确定的：同样的输入得到同样的输出。
# A few small operations on triangle meshes: cutting along a level line of a scalar field; halving edges that are
# too long; collapsing edges that are too short; flipping edges; tangential relaxation. genital.py and vulva.py use
# them to re-mesh a piece of surface with a graded edge length. All are deterministic: the same input gives the
# same output.

import numpy as np


def edge_table(F, nv):
    """
    无向边、每条边两侧的三角形（没有则 −1）。要求每条边至多属于两个三角形。
    Undirected edges and the triangles on either side of each (−1 where there is none). Every edge must belong to at
    most two triangles.
    """
    a = F[:, [0, 1, 2]].ravel()
    b = F[:, [1, 2, 0]].ravel()
    key = np.minimum(a, b).astype(np.int64) * nv + np.maximum(a, b)
    order = np.argsort(key, kind='stable')
    ks = key[order]
    first = np.r_[True, ks[1:] != ks[:-1]]
    start = np.where(first)[0]
    count = np.diff(np.r_[start, len(ks)])
    if count.max() > 2:
        raise RuntimeError('remesh: an edge belongs to more than two triangles')
    E = np.stack([ks[start] // nv, ks[start] % nv], 1)
    EF = -np.ones((len(E), 2), np.int64)
    EF[:, 0] = order[start] // 3
    two = count == 2
    EF[two, 1] = order[start[two] + 1] // 3
    return E, EF


def cut_by_level(V, F, f, snap=0.2):
    """
    沿 f = 0 把网格切开。返回 (V2, F_pos, F_neg, born, parent_pos, parent_neg)：V2 = 原顶点 + 落在边上的新顶点；
    born[k] = (a, b, t) 说明第 len(V)+k 个顶点在边 a–b 上、离 a 的比例是 t；parent_* 是每个新三角形原来所在的三角形。
    新三角形都在原三角形的平面内，所以曲面本身一点没有变。过线很靠近某个顶点（比例小于 snap）时，把线挪到那个顶点上，
    免得切出细长的三角形。
    Cuts the mesh along f = 0. Returns (V2, F_pos, F_neg, born, parent_pos, parent_neg): V2 = the vertices as they
    were + new vertices on edges; born[k] = (a, b, t) says that vertex len(V)+k lies on edge a–b at the fraction t
    from a; parent_* names the triangle each new triangle was part of. Every new triangle lies in the plane of its
    parent, so the surface itself is unchanged. Where the line passes very close to a vertex (fraction below snap)
    it is moved onto that vertex, so that no sliver is cut.
    """
    f = np.array(f, np.float64)
    for _ in range(2):
        a = F[:, [0, 1, 2]].ravel()
        b = F[:, [1, 2, 0]].ravel()
        cross = f[a] * f[b] < 0
        t = np.where(cross, f[a] / np.where(cross, f[a] - f[b], 1.0), 0.5)
        f[a[cross & (t < snap)]] = 0.0
        f[b[cross & (t > 1 - snap)]] = 0.0
    s = np.sign(f).astype(np.int64)
    S = s[F]
    has_p, has_n = (S > 0).any(1), (S < 0).any(1)
    whole_pos = ~has_n
    whole_neg = has_n & ~has_p
    mixed = np.where(has_p & has_n)[0]
    Vn = [np.asarray(V)]
    born, new_id = [], {}
    n0 = len(V)

    def crossing(a_, b_):
        k = (a_, b_) if a_ < b_ else (b_, a_)
        if k not in new_id:
            t_ = f[k[0]] / (f[k[0]] - f[k[1]])
            new_id[k] = n0 + len(born)
            born.append((k[0], k[1], float(t_)))
        return new_id[k]

    pos, neg, ppos, pneg = [], [], [], []
    for ti in mixed:
        tri = F[ti]
        poly_p, poly_n = [], []
        for c in range(3):
            a_, b_ = int(tri[c]), int(tri[(c + 1) % 3])
            if s[a_] >= 0:
                poly_p.append(a_)
            if s[a_] <= 0:
                poly_n.append(a_)
            if s[a_] * s[b_] < 0:
                m_ = crossing(a_, b_)
                poly_p.append(m_)
                poly_n.append(m_)
        for poly, out, par in ((poly_p, pos, ppos), (poly_n, neg, pneg)):
            if len(poly) == 3:
                out.append(poly)
                par.append(ti)
            elif len(poly) == 4:
                # 四边形按较短的对角线分 / the quadrilateral is split along its shorter diagonal
                P = [(_pos(V, born, n0, v)) for v in poly]
                if np.linalg.norm(P[0] - P[2]) <= np.linalg.norm(P[1] - P[3]):
                    out += [[poly[0], poly[1], poly[2]], [poly[0], poly[2], poly[3]]]
                else:
                    out += [[poly[0], poly[1], poly[3]], [poly[1], poly[2], poly[3]]]
                par += [ti, ti]
    V2 = np.vstack([np.asarray(V)] + ([np.array([_pos(V, born, n0, n0 + k) for k in range(len(born))])] if born else []))
    wp, wn = np.where(whole_pos)[0], np.where(whole_neg)[0]
    Fp = np.vstack([F[wp], np.array(pos, np.int64).reshape(-1, 3)])
    Fn = np.vstack([F[wn], np.array(neg, np.int64).reshape(-1, 3)])
    return V2, Fp, Fn, born, np.r_[wp, np.array(ppos, np.int64)], np.r_[wn, np.array(pneg, np.int64)]


def _pos(V, born, n0, v):
    if v < n0:
        return np.asarray(V[v], np.float64)
    a, b, t = born[v - n0]
    return (1 - t) * np.asarray(V[a], np.float64) + t * np.asarray(V[b], np.float64)


def split_long_edges(V, F, hfun, ratio=4.0 / 3.0, lock_boundary=True, locked=None, max_pass=40):
    """
    把比 ratio × 目标边长（hfun 在边中点的值）长的边对半分，最长的先分，直到没有。lock_boundary 时不分边界边；
    locked 是不许分的边的集合（成对的顶点下标，小的在前）。返回 (V, F, born, parent)：born[k] = (a, b) 是新顶点所在的边，
    parent 是每个三角形原来所在的三角形。新顶点在原来的边上，曲面不变。
    Halves every edge longer than ratio × the target length (hfun at the midpoint), longest first, until none is
    left. With lock_boundary, boundary edges are not split; `locked` is a set of edges that must not be split
    (pairs of vertex indices, smaller first). Returns (V, F, born, parent): born[k] = (a, b) is the edge a new
    vertex lies on, parent the triangle each triangle was part of. New vertices lie on the old edges, so the
    surface is unchanged.
    """
    V = np.array(V, np.float64)
    F = np.array(F, np.int64)
    parent = np.arange(len(F))
    born = []
    n0 = len(V)
    for _ in range(max_pass):
        E, EF = edge_table(F, len(V))
        mid = 0.5 * (V[E[:, 0]] + V[E[:, 1]])
        L = np.linalg.norm(V[E[:, 0]] - V[E[:, 1]], axis=1)
        cand = L > ratio * hfun(mid)
        if lock_boundary:
            cand &= EF[:, 1] >= 0
        if locked:
            cand &= ~np.array([(int(a), int(b)) in locked for a, b in E], bool)
        idx = np.where(cand)[0]
        if not len(idx):
            break
        idx = idx[np.argsort(-L[idx], kind='stable')]
        busy = np.zeros(len(F), bool)
        newV, newF, newP = [], [], []
        Fl = F.copy()
        for e in idx:
            fs = [int(x) for x in EF[e] if x >= 0]
            if any(busy[x] for x in fs):
                continue
            for x in fs:
                busy[x] = True
            a, b = int(E[e, 0]), int(E[e, 1])
            m = len(V) + len(newV)
            newV.append(mid[e])
            born.append((a, b))
            for x in fs:
                tri = [int(v) for v in Fl[x]]
                i = tri.index(a)
                if tri[(i + 1) % 3] == b:
                    c = tri[(i + 2) % 3]
                    Fl[x] = [a, m, c]
                    newF.append([m, b, c])
                else:
                    c = tri[(i + 1) % 3]
                    Fl[x] = [a, c, m]
                    newF.append([m, c, b])
                newP.append(parent[x])
        V = np.vstack([V, np.array(newV)])
        F = np.vstack([Fl, np.array(newF, np.int64)])
        parent = np.r_[parent, np.array(newP, np.int64)]
    return V, F, born, parent


def _normal(P):
    n = np.cross(P[1] - P[0], P[2] - P[0])
    l = np.linalg.norm(n)
    return n / l if l > 1e-18 else np.zeros(3)


def collapse_short_edges(V, F, hfun, fixed, ratio=0.8, high=4.0 / 3.0):
    """
    把比 ratio × 目标边长短的边收成一个点。fixed 的顶点不动也不消失（两端都 fixed 的边不收）；收了会翻面、
    会造出过长的边、或会破坏流形（环条件）的不收。返回 (V, F, 保留的顶点原来的下标)。
    Collapses every edge shorter than ratio × the target length to a point. `fixed` vertices neither move nor
    disappear (an edge with both ends fixed is left); a collapse that would flip a triangle, make an edge too long
    or break the manifold (link condition) is not made. Returns (V, F, old indices of the vertices kept).
    """
    V = np.array(V, np.float64)
    faces = [list(map(int, t)) for t in F]
    alive = [True] * len(faces)
    vf = [set() for _ in range(len(V))]
    for i, t in enumerate(faces):
        for v in t:
            vf[v].add(i)
    dead = np.zeros(len(V), bool)
    E, _ = edge_table(np.asarray(F), len(V))
    L = np.linalg.norm(V[E[:, 0]] - V[E[:, 1]], axis=1)
    hmid = hfun(0.5 * (V[E[:, 0]] + V[E[:, 1]]))
    idx = np.where(L < ratio * hmid)[0]
    idx = idx[np.argsort(L[idx] / hmid[idx], kind='stable')]
    for e in idx:
        a, b = int(E[e, 0]), int(E[e, 1])
        if dead[a] or dead[b] or (fixed[a] and fixed[b]):
            continue
        if fixed[b]:
            a, b = b, a  # b 消失，a 留下 / b goes, a stays
        na = set(v for i in vf[a] for v in faces[i]) - {a}
        nb_ = set(v for i in vf[b] for v in faces[i]) - {b}
        if b not in na:
            continue
        shared = vf[a] & vf[b]
        opp = set(v for i in shared for v in faces[i]) - {a, b}
        if (na & nb_) != opp or len(shared) != 2:
            continue
        target = V[a] if fixed[a] else 0.5 * (V[a] + V[b])
        if np.linalg.norm(V[a] - V[b]) >= ratio * float(hfun(target[None])[0]):
            continue
        ok = True
        lim = high * float(hfun(target[None])[0])
        for who, keep_pos in ((b, target), (a, target)):
            for i in vf[who] - shared:
                t = faces[i]
                P0 = V[t]
                P1 = P0.copy()
                P1[t.index(who)] = keep_pos
                n0_, n1_ = _normal(P0), _normal(P1)
                if n0_ @ n1_ < 0.3 or np.linalg.norm(np.cross(P1[1] - P1[0], P1[2] - P1[0])) < 1e-14:
                    ok = False
                    break
                if max(np.linalg.norm(P1[k] - P1[(k + 1) % 3]) for k in range(3)) > lim and who == b:
                    ok = False
                    break
            if not ok:
                break
        if not ok:
            continue
        V[a] = target
        for i in shared:
            alive[i] = False
            for v in faces[i]:
                vf[v].discard(i)
        for i in list(vf[b]):
            t = faces[i]
            t[t.index(b)] = a
            vf[a].add(i)
        vf[b] = set()
        dead[b] = True
    Fk = np.array([t for t, al in zip(faces, alive) if al], np.int64).reshape(-1, 3)
    keep = np.where(~dead)[0]
    remap = -np.ones(len(V), np.int64)
    remap[keep] = np.arange(len(keep))
    return V[keep], remap[Fk], keep


def flip_edges(V, F, max_pass=6, flat_cos=0.5):
    """
    德劳内翻边：一条内部边两侧的对角之和超过 180°、两侧的三角形大致共面（法线夹角余弦大于 flat_cos）、
    翻过去不折叠、新边也还不存在时，换成另一条对角线。不动顶点。
    Delaunay flips: an interior edge is replaced by the other diagonal when the two angles opposite it add up to
    more than 180°, the triangles on its two sides are roughly coplanar (cosine between normals above flat_cos), the
    flip folds nothing and the new edge does not exist yet. No vertex moves.
    """
    F = np.array(F, np.int64)
    for _ in range(max_pass):
        E, EF = edge_table(F, len(V))
        have = set(map(tuple, E.tolist()))
        busy = np.zeros(len(F), bool)
        changed = 0
        inner = np.where(EF[:, 1] >= 0)[0]
        for e in inner:
            f1, f2 = int(EF[e, 0]), int(EF[e, 1])
            if busy[f1] or busy[f2]:
                continue
            a, b = int(E[e, 0]), int(E[e, 1])
            t1, t2 = [int(v) for v in F[f1]], [int(v) for v in F[f2]]
            i = t1.index(a)
            if t1[(i + 1) % 3] != b:
                a, b = b, a
                i = t1.index(a)
            c = t1[(i + 2) % 3]
            d = [v for v in t2 if v != a and v != b][0]
            if (min(c, d), max(c, d)) in have:
                continue

            def ang(p, q, r):
                u, w = V[q] - V[p], V[r] - V[p]
                return np.arccos(np.clip(u @ w / max(np.linalg.norm(u) * np.linalg.norm(w), 1e-30), -1, 1))

            if ang(c, a, b) + ang(d, a, b) <= np.pi + 1e-6:
                continue
            n1, n2 = _normal(V[[a, b, c]]), _normal(V[[b, a, d]])
            if n1 @ n2 < flat_cos:
                continue
            m1, m2 = _normal(V[[a, d, c]]), _normal(V[[d, b, c]])
            if m1 @ m2 < flat_cos or m1 @ n1 < flat_cos or m2 @ n1 < flat_cos:
                continue
            F[f1] = [a, d, c]
            F[f2] = [d, b, c]
            busy[f1] = busy[f2] = True
            have.add((min(c, d), max(c, d)))
            changed += 1
        if not changed:
            break
    return F


def vertex_normals(V, F):
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    out = np.zeros_like(V)
    for k in range(3):
        np.add.at(out, F[:, k], n)
    return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-30)


def relax(V, F, fixed, project, rounds=3, step=0.5):
    """
    切向松弛：非 fixed 的顶点朝邻居的面积加权重心沿切面挪一步，再用 project 落回参考曲面。
    Tangential relaxation: every vertex that is not fixed moves a step in its tangent plane towards the
    area-weighted centroid of its neighbours and is then put back onto the reference surface by `project`.
    """
    V = np.array(V, np.float64)
    free = np.where(~fixed)[0]
    for _ in range(rounds):
        tri = V[F]
        ar = 0.5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
        cen = tri.mean(1)
        acc = np.zeros_like(V)
        w = np.zeros(len(V))
        for k in range(3):
            np.add.at(acc, F[:, k], cen * ar[:, None])
            np.add.at(w, F[:, k], ar)
        g = acc / np.maximum(w, 1e-30)[:, None]
        n = vertex_normals(V, F)
        dlt = g - V
        dlt -= (dlt * n).sum(1, keepdims=True) * n
        V[free] = project(V[free] + step * dlt[free])
    return V


def remesh(V, F, hfun, fixed, project, rounds=5):
    """
    各向同性重新布网（分长边、收短边、翻边、切向松弛，反复 rounds 次），目标边长由 hfun 给出。fixed 的顶点和边界边不动。
    返回 (V, F, origin)：origin[i] 是顶点 i 原来的下标，新生的顶点为 −1。
    Isotropic re-meshing (split long edges, collapse short ones, flip, relax tangentially; `rounds` times) to the
    target edge length given by hfun. `fixed` vertices and boundary edges are left alone. Returns (V, F, origin):
    origin[i] is the old index of vertex i, −1 for a vertex made here.
    """
    V = np.array(V, np.float64)
    F = np.array(F, np.int64)
    fixed = np.array(fixed, bool)
    origin = np.arange(len(V))
    for _ in range(rounds):
        n_before = len(V)
        V, F, born, _ = split_long_edges(V, F, hfun)
        fixed = np.r_[fixed, np.zeros(len(V) - n_before, bool)]
        origin = np.r_[origin, -np.ones(len(V) - n_before, np.int64)]
        V, F, keep = collapse_short_edges(V, F, hfun, fixed)
        fixed, origin = fixed[keep], origin[keep]
        F = flip_edges(V, F)
        V = relax(V, F, fixed, project)
    # 收尾：翻边和松弛又弄长了的边再分一次 / to finish: edges made long again by flips and relaxation are split once more
    n_before = len(V)
    V, F, _, _ = split_long_edges(V, F, hfun)
    origin = np.r_[origin, -np.ones(len(V) - n_before, np.int64)]
    return V, F, origin


def folded_edges(V, F, limit_deg=120.0):
    """折过 limit_deg 的内部边（两侧法线的夹角）及全部夹角 / interior edges folded over limit_deg (angle between the normals of the two sides), and every angle"""
    E, EF = edge_table(F, len(V))
    inner = EF[:, 1] >= 0
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-30)
    ang = np.degrees(np.arccos(np.clip((n[EF[inner, 0]] * n[EF[inner, 1]]).sum(1), -1, 1)))
    return E[inner][ang > limit_deg], ang, E[inner]
