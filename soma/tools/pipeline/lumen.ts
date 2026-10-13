// 空腔器官的腔：由器官外表面和文献里的壁厚推出内表面，把消化道接成一条从口到肛门的连续的管。
// 这里只有纯函数（中心线、段的排序、截面取样、内缩、括约肌收窄、充盈位移场、自交检查）和一个命令行入口；
// 读哪副人体、哪些部件、怎么拼，在 lumenBuild.ts 里。
//
// 方法（都在函数的注释里重复一遍）：
//   1. 中心线：在封闭的管状壳上取相距最远的两个顶点作两端（沿网格边的最短路，两次扫描），
//      以 t = (gA − gB + L) / 2 作标量场（gA、gB 是到两端的沿面距离），按等值线切片，
//      每条等值线的长度加权质心就是中心线上的一点。这是“水平集骨架”，不是严格的中轴。
//   2. 截面：在中心线每一站，垂直于切线的平面里向 K 个方向投射线，取最近的交点，得到外表面的极半径。
//   3. 内表面：极半径减去壁厚（沿射线，按射线与壁面法线的夹角折算）；外径不足两倍壁厚处收成一条缝
//      （潜在腔隙）并记下来。每一站是一圈 K 个点，圈与圈按同一组方向相连，所以内表面是一张结构化的管面，
//      只要相邻两圈不互相越过就不会自交（另有显式的自交检查）。器官的外表面不动。
//   4. 充盈：每个顶点一个位移向量 D，位置(f) = 静止位置 + (f − f静止)·D，f 从 0（塌陷）到 1（充盈）；不烘进几何。
//
// Lumina of hollow organs: an inner surface derived from an organ's outer surface and wall thickness
// from the literature, with the alimentary canal joined into one continuous tube from mouth to anus.
// This file holds pure functions only (centreline, ordering of pieces, cross-section sampling, inward
// offset, sphincter narrowing, the filling displacement field, a self-intersection check) and the
// command-line entry; which body, which parts and how they are assembled is in lumenBuild.ts.
//
// Method (repeated in the comments of the functions):
//   1. Centreline: on a closed tube-like shell the two mutually farthest vertices (shortest paths
//      along mesh edges, double sweep) are the ends; t = (gA − gB + L) / 2 is a scalar field (gA, gB
//      the along-surface distances to the ends), the shell is sliced by its level sets and the
//      length-weighted centroid of each level set is one centreline point. A level-set skeleton, not
//      a strict medial axis.
//   2. Cross-section: at every centreline station rays are cast in K directions in the plane normal
//      to the tangent; the nearest hit gives the polar radius of the outer surface.
//   3. Inner surface: polar radius minus wall thickness (along the ray, corrected for the angle
//      between ray and wall normal); where the organ is narrower than twice the wall the section
//      collapses to a slit (a potential space) and that is recorded. Each station is a ring of K
//      points and rings are joined direction by direction, so the inner surface is a structured tube
//      that cannot self-intersect as long as neighbouring rings do not pass each other (there is an
//      explicit self-intersection check as well). The outer surface of the organ is not touched.
//   4. Filling: one displacement vector D per vertex, position(f) = rest + (f − fRest)·D with f from
//      0 (collapsed) to 1 (distended); never baked into the geometry.

import type { Mesh } from './geometry.ts'

export type V3 = [number, number, number]

const sub = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]
const add = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!]
const mul = (a: ArrayLike<number>, k: number): V3 => [a[0]! * k, a[1]! * k, a[2]! * k]
const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]
const len = (a: ArrayLike<number>): number => Math.hypot(a[0]!, a[1]!, a[2]!)
const unit = (a: ArrayLike<number>): V3 => {
  const l = len(a) || 1
  return [a[0]! / l, a[1]! / l, a[2]! / l]
}
const dist = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)
export const vec = { sub, add, mul, dot, cross, len, unit, dist }

// ── 沿面距离 / along-surface distance ────────────────────────────────────────────────────────────────

export interface SurfaceGraph {
  /** 顶点 → 按位置合并后的结点 / vertex → node after merging coincident positions */
  node: Uint32Array
  nodes: number
  /** 结点坐标 / node positions (flat xyz) */
  pos: Float64Array
  start: Uint32Array
  nbr: Uint32Array
  w: Float64Array
}

/**
 * 网格的边图。位置重合的顶点并成一个结点（GLB 不按位置合并顶点，硬边处一个点会有几份）。
 * The edge graph of a mesh. Vertices with the same position become one node (a GLB never merges
 * vertices by position, so a point may exist several times along a crease).
 */
export function surfaceGraph(mesh: Mesh, eps = 1e-6): SurfaceGraph {
  const p = mesh.positions
  const nv = p.length / 3
  const node = new Uint32Array(nv)
  const map = new Map<string, number>()
  const posArr: number[] = []
  for (let v = 0; v < nv; v++) {
    const key = `${Math.round(p[3 * v]! / eps)},${Math.round(p[3 * v + 1]! / eps)},${Math.round(p[3 * v + 2]! / eps)}`
    let id = map.get(key)
    if (id === undefined) {
      id = map.size
      map.set(key, id)
      posArr.push(p[3 * v]!, p[3 * v + 1]!, p[3 * v + 2]!)
    }
    node[v] = id
  }
  const nodes = map.size
  const sets: Set<number>[] = Array.from({ length: nodes }, () => new Set<number>())
  const idx = mesh.indices
  for (let t = 0; t < idx.length; t += 3) {
    const a = node[idx[t]!]!, b = node[idx[t + 1]!]!, c = node[idx[t + 2]!]!
    if (a !== b) sets[a]!.add(b), sets[b]!.add(a)
    if (b !== c) sets[b]!.add(c), sets[c]!.add(b)
    if (a !== c) sets[a]!.add(c), sets[c]!.add(a)
  }
  const start = new Uint32Array(nodes + 1)
  for (let i = 0; i < nodes; i++) start[i + 1] = start[i]! + sets[i]!.size
  const nbr = new Uint32Array(start[nodes]!)
  const w = new Float64Array(start[nodes]!)
  const pos = Float64Array.from(posArr)
  for (let i = 0; i < nodes; i++) {
    let k = start[i]!
    for (const j of sets[i]!) {
      nbr[k] = j
      w[k++] = Math.hypot(pos[3 * i]! - pos[3 * j]!, pos[3 * i + 1]! - pos[3 * j + 1]!, pos[3 * i + 2]! - pos[3 * j + 2]!)
    }
  }
  return { node, nodes, pos, start, nbr, w }
}

/** 从若干结点出发沿边的最短距离（Dijkstra）。 / Shortest distance along edges from some nodes (Dijkstra). */
export function graphDistance(g: SurfaceGraph, sources: number[]): Float64Array {
  const d = new Float64Array(g.nodes).fill(Infinity)
  // 二叉堆 / binary heap of (distance, node)
  const hd: number[] = []
  const hn: number[] = []
  const push = (dd: number, n: number) => {
    let i = hd.length
    hd.push(dd)
    hn.push(n)
    while (i > 0) {
      const q = (i - 1) >> 1
      if (hd[q]! <= hd[i]!) break
      ;[hd[q], hd[i]] = [hd[i]!, hd[q]!]
      ;[hn[q], hn[i]] = [hn[i]!, hn[q]!]
      i = q
    }
  }
  const pop = (): [number, number] => {
    const top: [number, number] = [hd[0]!, hn[0]!]
    const ld = hd.pop()!
    const ln = hn.pop()!
    if (hd.length) {
      hd[0] = ld
      hn[0] = ln
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < hd.length && hd[l]! < hd[m]!) m = l
        if (r < hd.length && hd[r]! < hd[m]!) m = r
        if (m === i) break
        ;[hd[m], hd[i]] = [hd[i]!, hd[m]!]
        ;[hn[m], hn[i]] = [hn[i]!, hn[m]!]
        i = m
      }
    }
    return top
  }
  for (const s of sources) {
    d[s] = 0
    push(0, s)
  }
  while (hd.length) {
    const [dd, n] = pop()
    if (dd > d[n]!) continue
    for (let k = g.start[n]!; k < g.start[n + 1]!; k++) {
      const m = g.nbr[k]!
      const nd = dd + g.w[k]!
      if (nd < d[m]!) {
        d[m] = nd
        push(nd, m)
      }
    }
  }
  return d
}

/** 离给定点最近的结点 / the node nearest to a point */
export function nearestNode(g: SurfaceGraph, q: ArrayLike<number>): number {
  let best = 0
  let bd = Infinity
  for (let i = 0; i < g.nodes; i++) {
    const d = Math.hypot(g.pos[3 * i]! - q[0]!, g.pos[3 * i + 1]! - q[1]!, g.pos[3 * i + 2]! - q[2]!)
    if (d < bd) (bd = d), (best = i)
  }
  return best
}

// ── 中心线 / centreline ──────────────────────────────────────────────────────────────────────────────

export interface Axis {
  /** 中心线上的点，从 A 端到 B 端（flat xyz，米）；首尾两点就是两端 / centreline points from end A to end B (flat xyz, metres); the first and last are the ends themselves */
  points: Float64Array
  /** 各点处外表面到中心线的平均距离（等值线上按长度加权）；两端为 0 / mean distance of the outer surface from the centreline at each point (length-weighted over the level set); 0 at the two ends */
  radius: Float64Array
  /** 各点处的最小、最大距离 / smallest and largest distance at each point */
  rmin: Float64Array
  rmax: Float64Array
  /** 沿面距离意义下的壳长（两端之间） / length of the shell between its ends, along the surface */
  surfaceLength: number
  /** 各点对应的标量场值 t（两端为 0 和 surfaceLength） / the scalar field value t of every point (0 and surfaceLength at the ends) */
  stationT: Float64Array
  /** 网格每个顶点的 t / t at every vertex of the mesh */
  vertexT: Float64Array
}

export const axisPoint = (a: Axis, i: number): V3 => [a.points[3 * i]!, a.points[3 * i + 1]!, a.points[3 * i + 2]!]
export const axisCount = (a: Axis): number => a.points.length / 3
export const axisEnds = (a: Axis): [V3, V3] => [axisPoint(a, 0), axisPoint(a, axisCount(a) - 1)]
export function axisLength(a: Axis): number {
  let l = 0
  for (let i = 1; i < axisCount(a); i++) l += dist(axisPoint(a, i), axisPoint(a, i - 1))
  return l
}
/** 把中心线反过来 / the same axis run the other way */
export function reverseAxis(a: Axis): Axis {
  const n = axisCount(a)
  const points = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) points.set(axisPoint(a, n - 1 - i), 3 * i)
  return {
    points,
    radius: Float64Array.from(a.radius).reverse(),
    rmin: Float64Array.from(a.rmin).reverse(),
    rmax: Float64Array.from(a.rmax).reverse(),
    surfaceLength: a.surfaceLength,
    stationT: Float64Array.from(a.stationT, (t) => a.surfaceLength - t).reverse(),
    vertexT: Float64Array.from(a.vertexT, (t) => a.surfaceLength - t),
  }
}

export interface AxisOptions {
  /** 等值线的间距（米） / spacing of the level sets (metres) */
  step: number
  /** 给定两端（取最近的顶点）；缺省时用相距最远的一对顶点 / the two ends (snapped to the nearest vertices); the farthest pair of vertices when absent */
  ends?: [ArrayLike<number>, ArrayLike<number>]
  /** 质心折线的平滑次数 / smoothing passes over the centroid polyline */
  smooth?: number
}

/**
 * 管状封闭壳的中心线（水平集骨架）。两端 A、B：沿网格边相距最远的一对顶点（从任一点出发找最远点，
 * 再从它出发找最远点）。标量场 t = (gA − gB + L) / 2，其等值线是绕管一周的闭合曲线；每隔 step 取一条，
 * 其长度加权的质心是中心线上的一点，等值线上各点到质心的距离给出该处的半径。
 * 壳若分成几块（不连通），只用含 A 的那一块。
 * Centreline of a closed tube-like shell (a level-set skeleton). Ends A and B: the pair of vertices
 * farthest apart along mesh edges (farthest from any vertex, then farthest from that). The scalar
 * field t = (gA − gB + L) / 2 has level sets that are closed curves round the tube; one is taken every
 * `step`, its length-weighted centroid is a centreline point and the distances of the level set from
 * that centroid give the radius there. If the shell is in several pieces only the one holding A is used.
 */
export function shellAxis(mesh: Mesh, opts: AxisOptions): Axis {
  const g = surfaceGraph(mesh)
  let a: number, b: number
  if (opts.ends) {
    a = nearestNode(g, opts.ends[0])
    b = nearestNode(g, opts.ends[1])
  } else {
    const d0 = graphDistance(g, [0])
    a = 0
    for (let i = 0; i < g.nodes; i++) if (Number.isFinite(d0[i]!) && d0[i]! > d0[a]!) a = i
    const d1 = graphDistance(g, [a])
    b = a
    for (let i = 0; i < g.nodes; i++) if (Number.isFinite(d1[i]!) && d1[i]! > d1[b]!) b = i
    // 再扫一次，让 A 也是离 B 最远的 / one more sweep so that A is the farthest from B as well
    const d2 = graphDistance(g, [b])
    for (let i = 0; i < g.nodes; i++) if (Number.isFinite(d2[i]!) && d2[i]! > d2[a]!) a = i
  }
  const gA = graphDistance(g, [a])
  const gB = graphDistance(g, [b])
  const L = gA[b]!
  if (!Number.isFinite(L) || L <= 0) throw new Error('shellAxis: the two ends are not connected')
  const t = new Float64Array(g.nodes)
  for (let i = 0; i < g.nodes; i++) t[i] = Number.isFinite(gA[i]!) && Number.isFinite(gB[i]!) ? (gA[i]! - gB[i]! + L) / 2 : NaN
  const n = Math.max(2, Math.round(L / opts.step))
  const pts: V3[] = []
  const rad: number[] = []
  const rmin: number[] = []
  const rmax: number[] = []
  const isoT: number[] = []
  const idx = mesh.indices
  for (let k = 0; k < n; k++) {
    const iso = (L * (k + 0.5)) / n
    // 等值线：逐三角形求线段 / the level set as one segment per crossed triangle
    const segs: number[] = []
    for (let tr = 0; tr < idx.length; tr += 3) {
      const v = [g.node[idx[tr]!]!, g.node[idx[tr + 1]!]!, g.node[idx[tr + 2]!]!]
      const tv = [t[v[0]!]!, t[v[1]!]!, t[v[2]!]!]
      if (Number.isNaN(tv[0]!) || Number.isNaN(tv[1]!) || Number.isNaN(tv[2]!)) continue
      const hit: number[] = []
      for (let e = 0; e < 3; e++) {
        const i0 = e, i1 = (e + 1) % 3
        const t0 = tv[i0]! - iso, t1 = tv[i1]! - iso
        if ((t0 < 0 && t1 >= 0) || (t0 >= 0 && t1 < 0)) {
          const u = t0 / (t0 - t1)
          const p0 = 3 * v[i0]!, p1 = 3 * v[i1]!
          hit.push(g.pos[p0]! + u * (g.pos[p1]! - g.pos[p0]!), g.pos[p0 + 1]! + u * (g.pos[p1 + 1]! - g.pos[p0 + 1]!), g.pos[p0 + 2]! + u * (g.pos[p1 + 2]! - g.pos[p0 + 2]!))
        }
      }
      if (hit.length === 6) segs.push(...hit)
    }
    if (!segs.length) continue
    let w = 0
    const c: V3 = [0, 0, 0]
    for (let s = 0; s < segs.length; s += 6) {
      const l = Math.hypot(segs[s + 3]! - segs[s]!, segs[s + 4]! - segs[s + 1]!, segs[s + 5]! - segs[s + 2]!)
      w += l
      for (let q = 0; q < 3; q++) c[q] = c[q]! + (l * (segs[s + q]! + segs[s + 3 + q]!)) / 2
    }
    if (w <= 0) continue
    c[0] /= w
    c[1] /= w
    c[2] /= w
    let rm = 0, lo = Infinity, hi = 0
    for (let s = 0; s < segs.length; s += 6) {
      const l = Math.hypot(segs[s + 3]! - segs[s]!, segs[s + 4]! - segs[s + 1]!, segs[s + 5]! - segs[s + 2]!)
      const d0 = Math.hypot(segs[s]! - c[0], segs[s + 1]! - c[1], segs[s + 2]! - c[2])
      const d1 = Math.hypot(segs[s + 3]! - c[0], segs[s + 4]! - c[1], segs[s + 5]! - c[2])
      rm += (l * (d0 + d1)) / 2
      lo = Math.min(lo, d0, d1)
      hi = Math.max(hi, d0, d1)
    }
    pts.push(c)
    isoT.push(iso)
    rad.push(rm / w)
    rmin.push(lo)
    rmax.push(hi)
  }
  // 平滑质心（两端的端点不动） / smooth the centroids (the end points stay)
  const A: V3 = [g.pos[3 * a]!, g.pos[3 * a + 1]!, g.pos[3 * a + 2]!]
  const B: V3 = [g.pos[3 * b]!, g.pos[3 * b + 1]!, g.pos[3 * b + 2]!]
  let line: V3[] = [A, ...pts, B]
  for (let it = 0; it < (opts.smooth ?? 2); it++) {
    const next = line.map((q) => [...q] as V3)
    for (let i = 1; i < line.length - 1; i++) for (let q = 0; q < 3; q++) next[i]![q] = 0.5 * line[i]![q]! + 0.25 * (line[i - 1]![q]! + line[i + 1]![q]!)
    line = next
  }
  return {
    points: Float64Array.from(line.flat()),
    radius: Float64Array.from([0, ...rad, 0]),
    rmin: Float64Array.from([0, ...rmin, 0]),
    rmax: Float64Array.from([0, ...rmax, 0]),
    surfaceLength: L,
    stationT: Float64Array.from([0, ...isoT, L]),
    vertexT: Float64Array.from(g.node, (nd) => t[nd]!),
  }
}

// ── 折线 / polylines ─────────────────────────────────────────────────────────────────────────────────

/** 折线各点的累计弧长 / cumulative arc length at each point of a polyline */
export function arcLengths(points: ArrayLike<number>): Float64Array {
  const n = points.length / 3
  const s = new Float64Array(n)
  for (let i = 1; i < n; i++) s[i] = s[i - 1]! + Math.hypot(points[3 * i]! - points[3 * i - 3]!, points[3 * i + 1]! - points[3 * i - 2]!, points[3 * i + 2]! - points[3 * i - 1]!)
  return s
}

/** 按等弧长重新取样，首尾保留 / resample at equal arc length, keeping both ends */
export function resamplePolyline(points: ArrayLike<number>, step: number): Float64Array {
  const s = arcLengths(points)
  const n = s.length
  const total = s[n - 1]!
  const m = Math.max(1, Math.round(total / step))
  const out = new Float64Array(3 * (m + 1))
  let j = 0
  for (let i = 0; i <= m; i++) {
    const target = (total * i) / m
    while (j < n - 2 && s[j + 1]! < target) j++
    const span = s[j + 1]! - s[j]!
    const u = span > 0 ? Math.min(1, Math.max(0, (target - s[j]!) / span)) : 0
    for (let q = 0; q < 3; q++) out[3 * i + q] = points[3 * j + q]! + u * (points[3 * j + 3 + q]! - points[3 * j + q]!)
  }
  return out
}

/** 沿折线线性插值一个逐点的量 / a per-point quantity interpolated along a polyline at arc length `at` */
export function sampleAlong(s: ArrayLike<number>, values: ArrayLike<number>, at: number): number {
  const n = s.length
  if (at <= s[0]!) return values[0]!
  if (at >= s[n - 1]!) return values[n - 1]!
  let j = 0
  while (j < n - 2 && s[j + 1]! < at) j++
  const span = s[j + 1]! - s[j]!
  const u = span > 0 ? (at - s[j]!) / span : 0
  return values[j]! + u * (values[j + 1]! - values[j]!)
}

/**
 * 两条线段之间的最短距离 / the shortest distance between two segments
 */
export function segmentDistance(p1: ArrayLike<number>, q1: ArrayLike<number>, p2: ArrayLike<number>, q2: ArrayLike<number>): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2)
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r)
  let s: number, t: number
  if (a <= 1e-18 && e <= 1e-18) return len(r)
  if (a <= 1e-18) {
    s = 0
    t = Math.min(1, Math.max(0, f / e))
  } else {
    const c = dot(d1, r)
    if (e <= 1e-18) {
      t = 0
      s = Math.min(1, Math.max(0, -c / a))
    } else {
      const b = dot(d1, d2)
      const den = a * e - b * b
      s = den > 1e-18 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = Math.min(1, Math.max(0, -c / a))
      } else if (t > 1) {
        t = 1
        s = Math.min(1, Math.max(0, (b - c) / a))
      }
    }
  }
  return dist(add(p1, mul(d1, s)), add(p2, mul(d2, t)))
}

/**
 * 一条带半径的中心线是否自相碰：弧长相隔超过 `skip`（缺省为两处半径之和的 3 倍）的两段，
 * 若相距小于两处半径之和，就算一处碰撞。返回碰撞的段对数和最差的一处。
 * Whether a centreline with radii runs into itself: two segments more than `skip` apart in arc length
 * (three times the sum of their radii by default) that come closer than the sum of their radii count
 * as one clash. Returns the number of clashing pairs and the worst one.
 */
export function centrelineClashes(points: ArrayLike<number>, radius: ArrayLike<number>, skipFactor = 3): { pairs: number; worst: { i: number; j: number; distance: number; need: number } | null } {
  const n = points.length / 3
  const s = arcLengths(points)
  const P = (i: number): V3 => [points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!]
  let pairs = 0
  let worst: { i: number; j: number; distance: number; need: number } | null = null
  for (let i = 0; i + 1 < n; i++) {
    const ri = Math.max(radius[i]!, radius[i + 1]!)
    for (let j = i + 2; j + 1 < n; j++) {
      const rj = Math.max(radius[j]!, radius[j + 1]!)
      const need = ri + rj
      if (s[j]! - s[i + 1]! < skipFactor * need) continue
      const d = segmentDistance(P(i), P(i + 1), P(j), P(j + 1))
      if (d < need) {
        pairs++
        if (!worst || d - need < worst.distance - worst.need) worst = { i, j, distance: d, need }
      }
    }
  }
  return { pairs, worst }
}

// ── 段的排序 / ordering pieces into a chain ──────────────────────────────────────────────────────────

export interface ChainPiece {
  id: string
  ends: [V3, V3]
}

export interface ChainLink {
  id: string
  /** true：从 ends[1] 进、ends[0] 出 / true: entered at ends[1] and left at ends[0] */
  reversed: boolean
  /** 上一段的出口到这一段入口的距离（第一段：到起点的距离） / distance from the previous exit to this entry (first piece: from the start point) */
  gap: number
}

/**
 * 把若干两端已知的管段排成一条链：从 `start` 出发，使相邻两段端到端的空隙之和最小。
 * 先贪心（每次接最近的空闲端），再用 2-opt（把中间一截倒过来，段的方向随之翻转）和单段挪位改进，
 * 直到不再变好。给了 `end` 时把最后一段出口到它的距离也算进去。不保证全局最优。
 * Order tube pieces with known ends into one chain: starting at `start`, minimise the sum of
 * end-to-end gaps between consecutive pieces. Greedy first (always the nearest free end), then
 * improved by 2-opt (reversing a run, which flips its pieces) and by moving single pieces, until
 * nothing improves. With `end`, the distance from the last exit to it is counted too. Not guaranteed
 * to be the global optimum.
 */
export function orderChain(pieces: ChainPiece[], start: ArrayLike<number>, end?: ArrayLike<number>): ChainLink[] {
  const n = pieces.length
  if (!n) return []
  type Item = { k: number; rev: boolean }
  const entry = (it: Item): V3 => pieces[it.k]!.ends[it.rev ? 1 : 0]
  const exit = (it: Item): V3 => pieces[it.k]!.ends[it.rev ? 0 : 1]
  const used = new Uint8Array(n)
  let order: Item[] = []
  let cur: ArrayLike<number> = start
  for (let step = 0; step < n; step++) {
    let best: Item | null = null
    let bd = Infinity
    for (let k = 0; k < n; k++) {
      if (used[k]) continue
      for (const rev of [false, true]) {
        const d = dist(cur, pieces[k]!.ends[rev ? 1 : 0])
        if (d < bd) (bd = d), (best = { k, rev })
      }
    }
    used[best!.k] = 1
    order.push(best!)
    cur = exit(best!)
  }
  const cost = (o: Item[]): number => {
    let c = dist(start, entry(o[0]!))
    for (let i = 1; i < o.length; i++) c += dist(exit(o[i - 1]!), entry(o[i]!))
    if (end) c += dist(exit(o[o.length - 1]!), end)
    return c
  }
  let bestCost = cost(order)
  for (let round = 0; round < 50; round++) {
    let improved = false
    // 2-opt：倒转 [i, j] / reverse the run [i, j]
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) {
      const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse().map((it) => ({ k: it.k, rev: !it.rev })), ...order.slice(j + 1)]
      const c = cost(cand)
      if (c < bestCost - 1e-9) (order = cand), (bestCost = c), (improved = true)
    }
    // 单段挪位 / move one piece elsewhere, either way round
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue
      for (const flip of [false, true]) {
        const cand = order.slice()
        const [it] = cand.splice(i, 1)
        cand.splice(j, 0, { k: it!.k, rev: flip ? !it!.rev : it!.rev })
        const c = cost(cand)
        if (c < bestCost - 1e-9) (order = cand), (bestCost = c), (improved = true)
      }
    }
    if (!improved) break
  }
  const out: ChainLink[] = []
  let prev: ArrayLike<number> = start
  for (const it of order) {
    out.push({ id: pieces[it.k]!.id, reversed: it.rev, gap: dist(prev, entry(it)) })
    prev = exit(it)
  }
  return out
}

/**
 * 次序已知时只定每一段的方向：动态规划，使相邻两段端到端的空隙之和最小（全局最优）。
 * With the order known, choose only the direction of every piece: dynamic programming that minimises
 * the sum of end-to-end gaps between consecutive pieces (a global optimum).
 */
export function orientChain(pieces: ChainPiece[], start?: ArrayLike<number>, end?: ArrayLike<number>): ChainLink[] {
  const n = pieces.length
  if (!n) return []
  const entry = (k: number, rev: number): V3 => pieces[k]!.ends[rev ? 1 : 0]
  const exit = (k: number, rev: number): V3 => pieces[k]!.ends[rev ? 0 : 1]
  const cost = new Float64Array(2 * n)
  const from = new Int8Array(2 * n)
  for (const r of [0, 1]) cost[r] = start ? dist(start, entry(0, r)) : 0
  for (let k = 1; k < n; k++) for (const r of [0, 1]) {
    let best = Infinity
    for (const q of [0, 1]) {
      const c = cost[2 * (k - 1) + q]! + dist(exit(k - 1, q), entry(k, r))
      if (c < best) (best = c), (from[2 * k + r] = q)
    }
    cost[2 * k + r] = best
  }
  let r = 0
  const last = (q: number): number => cost[2 * (n - 1) + q]! + (end ? dist(exit(n - 1, q), end) : 0)
  if (last(1) < last(0)) r = 1
  const revs = new Int8Array(n)
  for (let k = n - 1; k >= 0; k--) {
    revs[k] = r
    r = from[2 * k + r]!
  }
  const out: ChainLink[] = []
  for (let k = 0; k < n; k++) {
    const gap = k === 0 ? (start ? dist(start, entry(0, revs[0]!)) : 0) : dist(exit(k - 1, revs[k - 1]!), entry(k, revs[k]!))
    out.push({ id: pieces[k]!.id, reversed: revs[k] === 1, gap })
  }
  return out
}

// ── 截面与内缩 / cross-sections and the inward offset ────────────────────────────────────────────────

/**
 * 沿折线的旋转最小标架：每点的切线 t 和两条横向单位向量 u、v（u × v 沿 t）。
 * Rotation-minimising frames along a polyline: at every point the tangent t and two transverse unit
 * vectors u and v (u × v along t).
 */
export function transportFrames(points: ArrayLike<number>, seed?: { index: number; u: ArrayLike<number> }): { t: Float64Array; u: Float64Array; v: Float64Array } {
  const n = points.length / 3
  const T = new Float64Array(3 * n), U = new Float64Array(3 * n), V = new Float64Array(3 * n)
  const P = (i: number): V3 => [points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!]
  let u: V3 = [0, 0, 0]
  // 给了种子时从种子所在的点向两头传；否则从第一个点开始 / with a seed, transport both ways from the seeded point; otherwise start at the first point
  const first = seed ? seed.index : 0
  const order: number[] = []
  for (let i = first; i < n; i++) order.push(i)
  for (let i = first - 1; i >= 0; i--) order.push(i)
  for (const i of order) {
    const t = unit(sub(P(Math.min(n - 1, i + 1)), P(Math.max(0, i - 1))))
    if (i === first - 1) u = [U[3 * first]!, U[3 * first + 1]!, U[3 * first + 2]!]
    if (i === first && !seed) {
      const a: V3 = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
      u = unit(cross(t, a))
    } else {
      if (i === first && seed) u = [seed.u[0]!, seed.u[1]!, seed.u[2]!]
      u = sub(u, mul(t, dot(u, t)))
      if (len(u) < 1e-6) {
        const a: V3 = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
        u = cross(t, a)
      }
      u = unit(u)
    }
    const v = cross(t, u)
    T.set(t, 3 * i)
    U.set(u, 3 * i)
    V.set(v, 3 * i)
  }
  return { t: T, u: U, v: V }
}

/**
 * 射线与网格的最近交点：返回距离（没有交点为 Infinity）和交点处射线与三角形法线夹角的余弦的绝对值。
 * Nearest hit of a ray with a mesh: the distance (Infinity when none) and the absolute cosine of the
 * angle between the ray and the normal of the triangle hit.
 */
export function rayNearest(mesh: Mesh, o: ArrayLike<number>, d: ArrayLike<number>, tris?: ArrayLike<number>): { distance: number; cos: number } {
  const p = mesh.positions
  const idx = mesh.indices
  let best = Infinity
  let bc = 1
  const nt = tris ? tris.length : idx.length / 3
  for (let q = 0; q < nt; q++) {
    const tr = 3 * (tris ? tris[q]! : q)
    const a = 3 * idx[tr]!, b = 3 * idx[tr + 1]!, c = 3 * idx[tr + 2]!
    const e1x = p[b]! - p[a]!, e1y = p[b + 1]! - p[a + 1]!, e1z = p[b + 2]! - p[a + 2]!
    const e2x = p[c]! - p[a]!, e2y = p[c + 1]! - p[a + 1]!, e2z = p[c + 2]! - p[a + 2]!
    const px = d[1]! * e2z - d[2]! * e2y, py = d[2]! * e2x - d[0]! * e2z, pz = d[0]! * e2y - d[1]! * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-20) continue
    const inv = 1 / det
    const tx = o[0]! - p[a]!, ty = o[1]! - p[a + 1]!, tz = o[2]! - p[a + 2]!
    const uu = (tx * px + ty * py + tz * pz) * inv
    if (uu < -1e-9 || uu > 1 + 1e-9) continue
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
    const vv = (d[0]! * qx + d[1]! * qy + d[2]! * qz) * inv
    if (vv < -1e-9 || uu + vv > 1 + 1e-9) continue
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv
    if (tt <= 1e-9 || tt >= best) continue
    best = tt
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
    bc = Math.abs(nx * d[0]! + ny * d[1]! + nz * d[2]!) / (Math.hypot(nx, ny, nz) || 1)
  }
  return { distance: best, cos: bc }
}

export interface Rings {
  /** 站数 / number of stations */
  stations: number
  /** 每圈的方向数 / directions per ring */
  sides: number
  /** 中心线各站的位置（flat xyz） / the centreline stations (flat xyz) */
  centre: Float64Array
  /** 各站各方向的单位向量（stations × sides × 3） / unit direction of every ray (stations × sides × 3) */
  dir: Float64Array
  /** 外表面的极半径（stations × sides）；没有交点为 NaN / polar radius of the outer surface (stations × sides); NaN where a ray hit nothing */
  outer: Float64Array
  /** 射线与壁面法线夹角的余弦 / cosine between ray and wall normal */
  cos: Float64Array
}

/**
 * 在中心线各站的横截面里向 `sides` 个方向投射线，取最近交点，得到外表面的极半径。
 * Cast `sides` rays in the cross-section plane at every centreline station and take the nearest hit:
 * the polar radius of the outer surface.
 */
export function sampleRings(mesh: Mesh | null, centre: ArrayLike<number>, sides: number): Rings {
  const n = centre.length / 3
  const f = transportFrames(centre)
  const dir = new Float64Array(n * sides * 3)
  const outer = new Float64Array(n * sides).fill(NaN)
  const cs = new Float64Array(n * sides).fill(1)
  for (let i = 0; i < n; i++) {
    const o: V3 = [centre[3 * i]!, centre[3 * i + 1]!, centre[3 * i + 2]!]
    for (let k = 0; k < sides; k++) {
      const a = (2 * Math.PI * k) / sides
      const d: V3 = [0, 0, 0]
      for (let q = 0; q < 3; q++) d[q] = Math.cos(a) * f.u[3 * i + q]! + Math.sin(a) * f.v[3 * i + q]!
      dir.set(d, 3 * (i * sides + k))
      if (!mesh) continue
      const h = rayNearest(mesh, o, d)
      if (Number.isFinite(h.distance)) {
        outer[i * sides + k] = h.distance
        cs[i * sides + k] = h.cos
      }
    }
  }
  return { stations: n, sides, centre: Float64Array.from(centre), dir, outer, cos: cs }
}

export interface OffsetOptions {
  /** 壁厚（米） / wall thickness (metres) */
  wall: number
  /** 收成缝时的半径（米）：潜在腔隙的半宽 / radius of a collapsed section (metres): half-width of the potential space */
  slit: number
  /** 夹角折算的下限：沿射线的内缩量不超过 wall / minCos / floor of the obliquity correction: the offset along a ray never exceeds wall / minCos */
  minCos?: number
}

export interface OffsetResult {
  /** 内表面的极半径（stations × sides） / polar radius of the inner surface (stations × sides) */
  inner: Float64Array
  /** 每站是否收成了缝（该站有方向的外半径不足 wall + slit） / per station: collapsed to a slit (some direction had less than wall + slit of outer radius) */
  collapsed: Uint8Array
  collapsedStations: number
}

/**
 * 内缩：内半径 = 外半径 − 壁厚 / max(cos, minCos)。外半径不足以容下壁和一条缝的方向，内半径取 `slit`，
 * 该站记为塌陷（潜在腔隙）。内半径永远在 (0, 外半径) 之内，所以内表面不会穿出外表面，
 * 每圈对它的中心是星形的，不会自交。
 * Inward offset: inner radius = outer radius − wall / max(cos, minCos). In a direction where the
 * outer radius cannot hold the wall plus a slit the inner radius is `slit` and the station is
 * recorded as collapsed (a potential space). The inner radius always lies in (0, outer), so the inner
 * surface never leaves the outer one, and every ring is star-shaped about its centre and cannot cross itself.
 */
export function offsetInward(outer: ArrayLike<number>, cos: ArrayLike<number>, stations: number, sides: number, opts: OffsetOptions): OffsetResult {
  const minCos = opts.minCos ?? 0.5
  const inner = new Float64Array(stations * sides)
  const collapsed = new Uint8Array(stations)
  let count = 0
  for (let i = 0; i < stations; i++) {
    for (let k = 0; k < sides; k++) {
      const o = outer[i * sides + k]!
      if (!Number.isFinite(o)) {
        inner[i * sides + k] = NaN
        continue
      }
      const r = o - opts.wall / Math.max(minCos, cos[i * sides + k]!)
      if (r < opts.slit) {
        inner[i * sides + k] = Math.min(opts.slit, o * 0.5)
        collapsed[i] = 1
      } else inner[i * sides + k] = r
    }
    count += collapsed[i]!
  }
  return { inner, collapsed, collapsedStations: count }
}

/**
 * 沿管的收窄（括约肌）：以弧长 `centre` 为中心、全长 `length` 的升余弦窗内，把半径乘以
 * 1 − (1 − ratio)·w，w 在中心为 1、两端为 0。ratio 是收窄处半径与原半径之比（0 = 关闭到 `floor`）。
 * 返回新的半径和每站的权重。
 * A narrowing along the tube (a sphincter): inside a raised-cosine window of full length `length`
 * centred at arc length `centre` the radius is multiplied by 1 − (1 − ratio)·w, with w = 1 at the
 * centre and 0 at the two ends. `ratio` is the narrowed radius over the original (0 = closed down to
 * `floor`). Returns the new radii and the weight at every station.
 */
export function sphincterNarrowing(radius: ArrayLike<number>, s: ArrayLike<number>, sides: number, centre: number, length: number, ratio: number, floor = 0): { radius: Float64Array; weight: Float64Array } {
  const out = Float64Array.from(radius)
  const weight = new Float64Array(s.length)
  for (let i = 0; i < s.length; i++) {
    const x = Math.abs(s[i]! - centre) / (length / 2)
    if (x >= 1) continue
    const w = 0.5 * (1 + Math.cos(Math.PI * x))
    weight[i] = w
    for (let k = 0; k < sides; k++) {
      const r = out[i * sides + k]!
      if (Number.isFinite(r)) out[i * sides + k] = Math.max(Math.min(r, floor), r * (1 - (1 - ratio) * w))
    }
  }
  return { radius: out, weight }
}

/**
 * 弯处的限制：一圈的半径不超过该处中心线曲率半径的 `share`，这样相邻两圈在弯的内侧不会互相越过。
 * 返回被限制的站数。
 * The limit at bends: the radius of a ring does not exceed `share` of the centreline's radius of
 * curvature there, so that neighbouring rings do not pass each other on the inside of the bend.
 * Returns the number of stations limited.
 */
export function limitByCurvature(radius: Float64Array, centre: ArrayLike<number>, sides: number, share = 0.9): number {
  const n = centre.length / 3
  const P = (i: number): V3 => [centre[3 * i]!, centre[3 * i + 1]!, centre[3 * i + 2]!]
  let limited = 0
  for (let i = 1; i < n - 1; i++) {
    // 取跨 1、2、3 站的三点外接圆半径中最小的：只看相邻三点会漏掉稍长一点的急弯
    // the smallest circumradius over spans of 1, 2 and 3 stations: three consecutive points alone miss a slightly longer tight bend
    let R = Infinity
    for (let span = 1; span <= 3; span++) {
      if (i - span < 0 || i + span > n - 1) break
      const a = P(i - span), b = P(i), c = P(i + span)
      const ab = dist(a, b), bc = dist(b, c), ca = dist(c, a)
      const area2 = len(cross(sub(b, a), sub(c, a)))
      if (area2 < 1e-15) continue
      R = Math.min(R, (ab * bc * ca) / (2 * area2))
    }
    if (!Number.isFinite(R)) continue
    let hit = false
    for (let k = 0; k < sides; k++) {
      const r = radius[i * sides + k]!
      if (Number.isFinite(r) && r > share * R) (radius[i * sides + k] = share * R), (hit = true)
    }
    if (hit) limited++
  }
  return limited
}

/**
 * 把一条管上互相靠近的不同段分开：两站之间的弧长超过它们直线距离的 `bend` 倍（管在两站之间折回了大半圈）时，
 * 两圈的最大半径之和不得超过直线距离减 `margin`；超过就把两圈按同一比例缩小（不小于 `floor`）。反复几遍直到不再有违反。
 * 返回被缩小的站数、每站的缩小比例（1 = 没动）。源数据里相邻的肠袢外壁互相重叠时，用它把腔留在各自壁内不重叠的部分。
 * Separate stretches of one tube that come close to each other: when the arc length between two
 * stations exceeds `bend` times their straight distance (the tube has doubled back between them), the
 * largest radii of the two rings may not add up to more than that distance minus `margin`; otherwise
 * both rings are scaled down by the same factor (not below `floor`). Repeated until nothing is violated.
 * Returns the number of stations shrunk and the factor of every station (1 = untouched). Where
 * neighbouring loops overlap in the source this keeps each lumen in the part of its own wall that
 * the other does not reach.
 */
export function separateStretches(radius: Float64Array, centre: ArrayLike<number>, sides: number, opts: { bend?: number; margin?: number; floor?: number; passes?: number } = {}): { shrunk: number; factor: Float64Array; remaining: number } {
  const bend = opts.bend ?? 1.5, margin = opts.margin ?? 0.0005, floor = opts.floor ?? 0.0003, passes = opts.passes ?? 6
  const n = centre.length / 3
  const s = arcLengths(centre)
  const factor = new Float64Array(n).fill(1)
  const rmax = new Float64Array(n)
  const refresh = (i: number): void => {
    let m = 0
    for (let k = 0; k < sides; k++) if (Number.isFinite(radius[i * sides + k]!)) m = Math.max(m, radius[i * sides + k]!)
    rmax[i] = m
  }
  for (let i = 0; i < n; i++) refresh(i)
  const scale = (i: number, f: number): void => {
    const g = Math.max(f, floor / Math.max(rmax[i]!, 1e-12))
    if (g >= 1) return
    for (let k = 0; k < sides; k++) radius[i * sides + k] = radius[i * sides + k]! * g
    factor[i] = factor[i]! * g
    refresh(i)
  }
  let remaining = 0
  for (let pass = 0; pass < passes; pass++) {
    remaining = 0
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      const d = Math.hypot(centre[3 * i]! - centre[3 * j]!, centre[3 * i + 1]! - centre[3 * j + 1]!, centre[3 * i + 2]! - centre[3 * j + 2]!)
      const sum = rmax[i]! + rmax[j]!
      if (sum <= d - margin || s[j]! - s[i]! <= bend * d) continue
      if (rmax[i]! <= floor * 1.001 && rmax[j]! <= floor * 1.001) continue
      remaining++
      const f = Math.max(0, d - margin) / sum
      scale(i, f)
      scale(j, f)
    }
    if (!remaining) break
  }
  let shrunk = 0
  for (let i = 0; i < n; i++) if (factor[i]! < 0.999) shrunk++
  return { shrunk, factor, remaining }
}

/** 折线各点的单位切线（前后两点之差；首尾用单侧差） / unit tangent at every point of a polyline (difference of its two neighbours; one-sided at the ends) */
export function polylineTangents(points: ArrayLike<number>): Float64Array {
  const n = points.length / 3
  const T = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1)
    T.set(unit([points[3 * b]! - points[3 * a]!, points[3 * b + 1]! - points[3 * a + 1]!, points[3 * b + 2]! - points[3 * a + 2]!]), 3 * i)
  }
  return T
}

/**
 * 两点之间的弯：三次 Hermite 曲线，切线长度取成使它近似一段圆弧（转角 θ、弦长 g 时为 2g·tan(θ/4)/sin(θ/2)：
 * θ→0 时是 g，θ=180° 时是 2g）。这样急转弯处曲线向外鼓出去，曲率半径约为 g/(2 sin(θ/2))，而不是抄近路留下一个折角。
 * A bend between two points: a cubic Hermite curve whose tangent length makes it close to a circular
 * arc (2g·tan(θ/4)/sin(θ/2) for a turn θ over a chord g: g as θ→0, 2g at 180°). At a sharp turn the
 * curve therefore bulges outward with a radius of curvature near g/(2 sin(θ/2)) instead of cutting
 * the corner and leaving a kink.
 */
export function arcBridge(p0: ArrayLike<number>, t0: ArrayLike<number>, p1: ArrayLike<number>, t1: ArrayLike<number>, step: number): Float64Array {
  const g = dist(p0, p1)
  if (g < 1e-9) return Float64Array.from([p0[0]!, p0[1]!, p0[2]!, p1[0]!, p1[1]!, p1[2]!])
  const a = unit(t0), b = unit(t1)
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(a, b))))
  const m = theta < 1e-3 ? g : Math.min(2 * g, (2 * g * Math.tan(theta / 4)) / Math.sin(theta / 2))
  const n = Math.max(8, Math.ceil((3 * g) / step))
  const out = new Float64Array(3 * (n + 1))
  for (let i = 0; i <= n; i++) {
    const u = i / n, u2 = u * u, u3 = u2 * u
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2
    for (let q = 0; q < 3; q++) out[3 * i + q] = h00 * p0[q]! + h10 * m * a[q]! + h01 * p1[q]! + h11 * m * b[q]!
  }
  return resamplePolyline(out, step)
}

/**
 * 掉头的弯：两段几乎并排、方向相反（发夹），两个端点之间放不下像样的圆弧时用。在两个端点的正前方放一个半径为 R 的圆
 * （圆心在两点中点前方 3R 处），路径是：从 A 沿切线到圆上、绕圆的远侧、再沿切线回到 B——一个水滴形的环。
 * 环上曲率半径处处不小于 R；两个端点处各有一个不大的转角（约 20° 加上两段不平行的那一半）。
 * A turn-back bend, for two stretches lying almost side by side in opposite directions (a hairpin)
 * where no decent arc fits between the end points. A circle of radius R is placed straight ahead of
 * the two points (its centre 3R ahead of their midpoint) and the path runs from A along a tangent to
 * the circle, round its far side and back along a tangent to B — a teardrop loop. The radius of
 * curvature on the loop is nowhere below R; at each end point there is a modest corner (about 20°
 * plus half of what the two stretches lack of being parallel).
 */
export function teardropBridge(pA: ArrayLike<number>, tA: ArrayLike<number>, pB: ArrayLike<number>, tB: ArrayLike<number>, R: number, step: number): Float64Array {
  let f = sub(unit(tA), unit(tB))
  if (len(f) < 1e-6) f = unit(tA)
  f = unit(f)
  const e = sub(pB, pA)
  let lat = sub(e, mul(f, dot(e, f)))
  if (len(lat) < 1e-7) lat = cross(f, Math.abs(f[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])
  const l = unit(lat)
  const M = mul(add(pA, pB), 0.5)
  const A2: [number, number] = [-dot(e, l) / 2, -dot(e, f) / 2], B2: [number, number] = [dot(e, l) / 2, dot(e, f) / 2]
  const O: [number, number] = [0, Math.max(A2[1], B2[1]) + 3 * R]
  // 从圆外一点到圆的切点，取靠外侧（side = −1 左，+1 右）的那个 / the tangent point from an outside point, the one on the outer side (side = −1 left, +1 right)
  const tangent = (P: [number, number], side: number): number => {
    const d = Math.hypot(P[0] - O[0], P[1] - O[1])
    const beta = Math.acos(Math.min(1, R / d)), gamma = Math.atan2(P[1] - O[1], P[0] - O[0])
    const a1 = gamma + beta, a2 = gamma - beta
    return side * Math.cos(a1) > side * Math.cos(a2) ? a1 : a2
  }
  const phiA = tangent(A2, -1), phiB = tangent(B2, 1)
  // 从 φA 经过正前方（π/2）转到 φB：角度递减 / from φA through straight ahead (π/2) to φB: the angle decreases
  let sweep = (phiA - phiB) % (2 * Math.PI)
  if (sweep <= 0) sweep += 2 * Math.PI
  const pts2: [number, number][] = [A2]
  const nArc = Math.max(8, Math.ceil((sweep * R) / (step / 2)))
  for (let i = 0; i <= nArc; i++) {
    const a = phiA - (sweep * i) / nArc
    pts2.push([O[0] + R * Math.cos(a), O[1] + R * Math.sin(a)])
  }
  pts2.push(B2)
  const out: number[] = []
  for (const [x, y] of pts2) out.push(M[0] + x * l[0] + y * f[0], M[1] + x * l[1] + y * f[1], M[2] + x * l[2] + y * f[2])
  return resamplePolyline(out, step)
}

/**
 * 抹掉折线上的折角：某一点处前后两段的夹角超过 maxTurn 时，把它和左右各 `reach` 个点向邻点的中点靠（拉普拉斯平滑），
 * 反复到没有这样的点或到了次数。首尾两点不动。返回动过的点数。
 * Take the kinks out of a polyline: where the two segments at a point turn by more than maxTurn, that
 * point and `reach` points on either side are moved toward the midpoint of their neighbours (Laplacian
 * smoothing), repeated until no such point is left or the passes run out. The two end points stay.
 * Returns the number of points moved.
 */
export function relaxKinks(points: Float64Array, maxTurnDeg = 45, reach = 2, passes = 60): number {
  const n = points.length / 3
  const minCos = Math.cos((maxTurnDeg * Math.PI) / 180)
  const moved = new Uint8Array(n)
  for (let pass = 0; pass < passes; pass++) {
    const mark = new Uint8Array(n)
    let any = false
    for (let i = 1; i < n - 1; i++) {
      const u = unit([points[3 * i]! - points[3 * i - 3]!, points[3 * i + 1]! - points[3 * i - 2]!, points[3 * i + 2]! - points[3 * i - 1]!])
      const v = unit([points[3 * i + 3]! - points[3 * i]!, points[3 * i + 4]! - points[3 * i + 1]!, points[3 * i + 5]! - points[3 * i + 2]!])
      if (dot(u, v) >= minCos) continue
      any = true
      for (let j = Math.max(1, i - reach); j <= Math.min(n - 2, i + reach); j++) mark[j] = 1
    }
    if (!any) break
    const next = Float64Array.from(points)
    for (let i = 1; i < n - 1; i++) if (mark[i]) {
      moved[i] = 1
      for (let q = 0; q < 3; q++) next[3 * i + q] = 0.5 * points[3 * i + q]! + 0.25 * (points[3 * i - 3 + q]! + points[3 * i + 3 + q]!)
    }
    points.set(next)
  }
  return moved.reduce((s, x) => s + x, 0)
}

/** 折线各点处的曲率半径（相邻三点的外接圆；首尾为 Infinity） / radius of curvature at every point of a polyline (circumcircle of three consecutive points; Infinity at the ends) */
export function curvatureRadius(points: ArrayLike<number>): Float64Array {
  const n = points.length / 3
  const R = new Float64Array(n).fill(Infinity)
  const P = (i: number): V3 => [points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!]
  for (let i = 1; i < n - 1; i++) {
    const a = P(i - 1), b = P(i), c = P(i + 1)
    const area2 = len(cross(sub(b, a), sub(c, a)))
    if (area2 > 1e-15) R[i] = (dist(a, b) * dist(b, c) * dist(c, a)) / (2 * area2)
  }
  return R
}

/**
 * 弯处逐条射线的限制，保证相邻的圈不互相越过。第 i 圈在过第 i 站、垂直于切线 t_i 的平面里。对窗口内的每个 j > i
 * （切线夹角不超过 maxTurn），第 i 圈的每个点都必须留在第 j 站平面的后侧：r·(d·t_j) ≤ share·(c_j − c_i)·t_j；
 * 对 j < i 对称。只有指向弯内侧的射线会被限制，弯外侧不动。在半径为 R 的圆弧上这就是 r·cos(与曲率中心的夹角) ≤ share·R，
 * 也就是“半径不超过当地曲率半径减去余量”，但逐条射线、逐对平面地算，对不是圆弧的折线同样成立。
 * 满足之后：相隔不超过 2·window − 1 的两条带子（相邻两圈之间的那圈三角形）被其间某一站的平面隔开，不可能相交。
 * 返回被限制的站数和每站被削掉的最大量（米）。
 * The per-ray limit at bends that keeps neighbouring rings from passing each other. Ring i lies in the
 * plane through station i normal to the tangent t_i. For every j > i in the window (tangents no more
 * than maxTurn apart) every point of ring i must stay behind the plane of station j:
 * r·(d·t_j) ≤ share·(c_j − c_i)·t_j; symmetrically for j < i. Only rays pointing to the inside of the
 * bend are limited; the outside is untouched. On a circular arc of radius R this is
 * r·cos(angle to the centre of curvature) ≤ share·R, i.e. "no more than the local radius of curvature
 * minus a margin", but evaluated ray by ray and plane by plane, so it holds for any polyline.
 * Once satisfied, two bands (the triangles between consecutive rings) up to 2·window − 1 apart are
 * separated by the plane of a station between them and cannot intersect.
 * Returns the number of stations limited and the largest amount cut at every station (metres).
 */
export function limitByPlanes(radius: Float64Array, centre: ArrayLike<number>, dir: ArrayLike<number>, sides: number, opts: { share?: number; window?: number; maxTurnDeg?: number; floor?: number } = {}): { limited: number; cut: Float64Array; lo: Int32Array; hi: Int32Array } {
  const share = opts.share ?? 0.85, window = opts.window ?? 12, floor = opts.floor ?? 0.0003
  const minCos = Math.cos(((opts.maxTurnDeg ?? 100) * Math.PI) / 180)
  const n = centre.length / 3
  const T = polylineTangents(centre)
  const cut = new Float64Array(n)
  // 每一站被平面限制覆盖到的站的范围 [lo, hi] / the range of stations [lo, hi] the plane limit covered for every station
  const lo = new Int32Array(n), hi = new Int32Array(n)
  let limited = 0
  for (let i = 0; i < n; i++) {
    lo[i] = hi[i] = i
    for (const sgn of [1, -1]) {
      for (let w = 1; w <= window; w++) {
        const j = i + sgn * w
        if (j < 0 || j >= n) break
        const tj: V3 = [T[3 * j]!, T[3 * j + 1]!, T[3 * j + 2]!]
        if (T[3 * i]! * tj[0] + T[3 * i + 1]! * tj[1] + T[3 * i + 2]! * tj[2] < minCos) break
        if (sgn > 0) hi[i] = j
        else lo[i] = j
        // 第 i 站到第 j 站平面的距离（沿 t_j，朝 j 的方向为正） / distance from station i to the plane of station j (along t_j, positive toward j)
        const X = sgn * ((centre[3 * j]! - centre[3 * i]!) * tj[0] + (centre[3 * j + 1]! - centre[3 * i + 1]!) * tj[1] + (centre[3 * j + 2]! - centre[3 * i + 2]!) * tj[2])
        for (let k = 0; k < sides; k++) {
          const o = 3 * (i * sides + k)
          const a = sgn * (dir[o]! * tj[0] + dir[o + 1]! * tj[1] + dir[o + 2]! * tj[2])
          if (a < 0.02) continue
          const cap = Math.max(floor, (share * X) / a)
          const r = radius[i * sides + k]!
          if (Number.isFinite(r) && r > cap) {
            cut[i] = Math.max(cut[i]!, r - cap)
            radius[i * sides + k] = cap
          }
        }
      }
    }
    if (cut[i]! > 0) limited++
  }
  return { limited, cut, lo, hi }
}

/**
 * 把互相伸进对方的两段腔分开（壳对壳，逐站逐条射线）。对每一站 i 的每个圈上的点 p，看它是否落在另一站 j 的圆盘里：
 * p 到 j 站平面的距离不超过 `thick`，且 p 到 j 站中心的横向距离小于 j 圈在那个方向上的半径加 `sep`。是的话两边各让一半
 * 重叠深度（一边已经到底就由另一边全让）。只处理平面限制没有覆盖的站对（`covered(i, j)` 为假的）。反复到没有重叠为止。
 * 返回每站让出的总量（米，取各射线的最大值）、让给了谁、用了几遍、还剩几处。
 * Separate two stretches of lumen that reach into each other (shell against shell, station by station
 * and ray by ray). For every ring point p of a station i it is asked whether p lies in the disc of
 * another station j: within `thick` of the plane of j and closer to j's centre, across the tube, than
 * the radius of ring j in that direction plus `sep`. If so each side gives half of the overlap depth
 * (all of it when the other is already at the floor). Only pairs the plane limit did not cover
 * (`covered(i, j)` false) are treated. Repeated until nothing overlaps. Returns what every station
 * gave in all (metres, the largest over its rays), to which station, the passes used and what is left.
 */
export function separateRings(radius: Float64Array, centre: ArrayLike<number>, dir: ArrayLike<number>, sides: number, opts: { covered: (i: number, j: number) => boolean; sep?: number; thick?: number; floor?: number; passes?: number }): { gave: Float64Array; partner: Int32Array; passes: number; remaining: number } {
  const sep = opts.sep ?? 0.001, thick = opts.thick ?? 0.002, floor = opts.floor ?? 0.0003, maxPasses = opts.passes ?? 40
  const n = centre.length / 3
  const quarter = sides >> 2
  const before = Float64Array.from(radius)
  const partner = new Int32Array(n).fill(-1)
  const best = new Float64Array(n)
  const rmax = new Float64Array(n)
  const T = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    const u: V3 = [dir[3 * i * sides]!, dir[3 * i * sides + 1]!, dir[3 * i * sides + 2]!]
    const v: V3 = [dir[3 * (i * sides + quarter)]!, dir[3 * (i * sides + quarter) + 1]!, dir[3 * (i * sides + quarter) + 2]!]
    T.set(cross(u, v), 3 * i)
  }
  // 可能相碰的站对只找一次（半径只会变小） / candidate pairs are found once (radii only shrink)
  for (let i = 0; i < n; i++) for (let k = 0; k < sides; k++) rmax[i] = Math.max(rmax[i]!, radius[i * sides + k]!)
  const cand: number[] = []
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j || opts.covered(i, j)) continue
    const d = Math.hypot(centre[3 * i]! - centre[3 * j]!, centre[3 * i + 1]! - centre[3 * j + 1]!, centre[3 * i + 2]! - centre[3 * j + 2]!)
    if (d < rmax[i]! + rmax[j]! + sep) cand.push(i, j)
  }
  let passes = 0, remaining = 0
  for (; passes < maxPasses; passes++) {
    remaining = 0
    for (let c = 0; c < cand.length; c += 2) {
      const i = cand[c]!, j = cand[c + 1]!
      for (let k = 0; k < sides; k++) {
        const o = 3 * (i * sides + k), r = radius[i * sides + k]!
        const q: V3 = [centre[3 * i]! + r * dir[o]! - centre[3 * j]!, centre[3 * i + 1]! + r * dir[o + 1]! - centre[3 * j + 1]!, centre[3 * i + 2]! + r * dir[o + 2]! - centre[3 * j + 2]!]
        const h = q[0] * T[3 * j]! + q[1] * T[3 * j + 1]! + q[2] * T[3 * j + 2]!
        if (Math.abs(h) > thick) continue
        const ju = 3 * j * sides, jv = 3 * (j * sides + quarter)
        const x = q[0] * dir[ju]! + q[1] * dir[ju + 1]! + q[2] * dir[ju + 2]!
        const y = q[0] * dir[jv]! + q[1] * dir[jv + 1]! + q[2] * dir[jv + 2]!
        const rho = Math.hypot(x, y)
        const a = ((Math.atan2(y, x) / (2 * Math.PI)) * sides + sides) % sides
        const k1 = Math.floor(a) % sides, k2 = (k1 + 1) % sides
        const rj = Math.max(radius[j * sides + k1]!, radius[j * sides + k2]!)
        const depth = rj + sep - rho
        if (depth <= 1e-7) continue
        // j 已经到底而 i 也到底：两条缝，无可再让 / both already at the floor: two slits, nothing left to give
        if (r <= floor * 1.0001 && rj <= floor * 1.0001) continue
        remaining++
        let giveI = Math.min(depth / 2 + 1e-5, r - floor)
        let giveJ = Math.min(depth - giveI + 1e-5, rj - floor)
        giveI = Math.min(r - floor, depth - giveJ + 1e-5)
        radius[i * sides + k] = r - Math.max(0, giveI)
        for (const kk of [k1, k2]) radius[j * sides + kk] = Math.max(floor, Math.min(radius[j * sides + kk]!, rj - Math.max(0, giveJ)))
        if (giveI > best[i]!) (best[i] = giveI), (partner[i] = j)
        if (giveJ > best[j]!) (best[j] = giveJ), (partner[j] = i)
      }
    }
    if (!remaining) break
  }
  const gave = new Float64Array(n)
  for (let i = 0; i < n; i++) for (let k = 0; k < sides; k++) gave[i] = Math.max(gave[i]!, before[i * sides + k]! - radius[i * sides + k]!)
  return { gave, partner, passes, remaining }
}

/**
 * 检查：相邻两圈是否互相越过（一圈的平面切到了另一圈）。返回越过的相邻对数。
 * The check: do consecutive rings pass each other (the plane of one cutting the other)? Returns the
 * number of consecutive pairs that do.
 */
export function ringPlaneCrossings(centre: ArrayLike<number>, dir: ArrayLike<number>, radius: ArrayLike<number>, sides: number): number {
  const n = centre.length / 3
  const T = polylineTangents(centre)
  let bad = 0
  for (let i = 0; i + 1 < n; i++) {
    let crossed = false
    for (let k = 0; k < sides && !crossed; k++) {
      for (const [a, b, sgn] of [[i, i + 1, 1], [i + 1, i, -1]] as const) {
        // 圈 a 上的点相对于站 b 的平面 / a point of ring a against the plane of station b
        const o = 3 * (a * sides + k), r = radius[a * sides + k]!
        let h = 0
        for (let q = 0; q < 3; q++) h += (centre[3 * a + q]! + r * dir[o + q]! - centre[3 * b + q]!) * T[3 * b + q]!
        if (sgn * h >= 0) crossed = true
      }
    }
    if (crossed) bad++
  }
  return bad
}

/** 把一组圈拼成一张两端开口的管面（顶点 = stations × sides，法线朝外）。 / Join rings into a tube open at both ends (vertices = stations × sides, outward winding). */
export function ringsToMesh(centre: ArrayLike<number>, dir: ArrayLike<number>, radius: ArrayLike<number>, stations: number, sides: number): Mesh {
  const positions = new Float32Array(stations * sides * 3)
  for (let i = 0; i < stations; i++) for (let k = 0; k < sides; k++) {
    const o = 3 * (i * sides + k)
    const r = radius[i * sides + k]!
    for (let q = 0; q < 3; q++) positions[o + q] = centre[3 * i + q]! + r * dir[o + q]!
  }
  const indices: number[] = []
  for (let i = 1; i < stations; i++) {
    const r0 = (i - 1) * sides, r1 = i * sides
    for (let k = 0; k < sides; k++) {
      const k1 = (k + 1) % sides
      indices.push(r0 + k, r0 + k1, r1 + k1, r0 + k, r1 + k1, r1 + k)
    }
  }
  return { positions, indices: Uint32Array.from(indices) }
}

/**
 * 给管面的一端或两端加扇形盖（盖的顶点在该端的中心线点上），成为封闭的囊。
 * Close one or both ends of a ring tube with a fan whose apex is the centreline point of that end.
 */
export function capRings(mesh: Mesh, centre: ArrayLike<number>, stations: number, sides: number, first: boolean, last: boolean): Mesh {
  const pos = Array.from(mesh.positions)
  const idx = Array.from(mesh.indices)
  if (first) {
    const c = pos.length / 3
    pos.push(centre[0]!, centre[1]!, centre[2]!)
    for (let k = 0; k < sides; k++) idx.push(c, (k + 1) % sides, k)
  }
  if (last) {
    const c = pos.length / 3
    const o = 3 * (stations - 1)
    pos.push(centre[o]!, centre[o + 1]!, centre[o + 2]!)
    const r = (stations - 1) * sides
    for (let k = 0; k < sides; k++) idx.push(c, r + k, r + ((k + 1) % sides))
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

/** 管面的体积（两端按平面盖住来算），m³ / volume of a ring tube with both ends closed by flat caps, m³ */
export function ringVolume(centre: ArrayLike<number>, dir: ArrayLike<number>, radius: ArrayLike<number>, stations: number, sides: number): number {
  // 每站截面积（极坐标多边形），沿中心线用梯形积分 / cross-section area of each station (a polar polygon), integrated along the centreline by the trapezoid rule
  const area = new Float64Array(stations)
  const sin = Math.sin((2 * Math.PI) / sides)
  for (let i = 0; i < stations; i++) {
    let a = 0
    for (let k = 0; k < sides; k++) a += 0.5 * radius[i * sides + k]! * radius[i * sides + ((k + 1) % sides)]! * sin
    area[i] = a
  }
  const s = arcLengths(centre)
  let vol = 0
  for (let i = 1; i < stations; i++) vol += 0.5 * (area[i]! + area[i - 1]!) * (s[i]! - s[i - 1]!)
  void dir
  return vol
}

/** 每站的等效直径（按截面积），米 / area-equivalent diameter of every station, metres */
export function ringCalibre(radius: ArrayLike<number>, stations: number, sides: number): Float64Array {
  const out = new Float64Array(stations)
  const sin = Math.sin((2 * Math.PI) / sides)
  for (let i = 0; i < stations; i++) {
    let a = 0
    for (let k = 0; k < sides; k++) a += 0.5 * radius[i * sides + k]! * radius[i * sides + ((k + 1) % sides)]! * sin
    out[i] = 2 * Math.sqrt(a / Math.PI)
  }
  return out
}

// ── 充盈 / filling ───────────────────────────────────────────────────────────────────────────────────

export interface FillingField {
  /** 存下来的几何对应的充盈度 / the filling at which the stored geometry stands */
  rest: number
  /** 每顶点的位移向量（flat xyz，米）：位置(f) = 静止位置 + (f − rest)·D / displacement per vertex (flat xyz, metres): position(f) = rest position + (f − rest)·D */
  displacement: Float32Array
}

/**
 * 充盈位移场。一段腔在 f = 0 时的等效口径是 `collapsed`，在 f = 1 时是 `distended`（都来自壁厚口径表），
 * 存下来的几何的平均口径是 `restCalibre`，所以它对应 rest = (restCalibre − collapsed) / (distended − collapsed)，
 * 截到 [0, 1]。每个顶点沿它到自己中心的方向移动：D = (顶点 − 中心)·(distended − collapsed) / restCalibre。
 * 位置对 f 是线性的；f = rest 时就是存下来的几何。
 * The filling displacement field. A lumen segment has the equivalent calibre `collapsed` at f = 0 and
 * `distended` at f = 1 (both from the wall and calibre table); the stored geometry has the mean
 * calibre `restCalibre` and therefore stands at rest = (restCalibre − collapsed) / (distended −
 * collapsed), clamped to [0, 1]. Each vertex moves along the line from its centre:
 * D = (vertex − centre)·(distended − collapsed) / restCalibre. Position is linear in f and equals the
 * stored geometry at f = rest.
 */
export function fillingField(positions: ArrayLike<number>, centres: ArrayLike<number>, restCalibre: number, collapsed: number, distended: number): FillingField {
  const n = positions.length / 3
  const D = new Float32Array(3 * n)
  const k = restCalibre > 0 ? (distended - collapsed) / restCalibre : 0
  for (let i = 0; i < 3 * n; i++) D[i] = (positions[i]! - centres[i]!) * k
  const rest = distended > collapsed ? Math.min(1, Math.max(0, (restCalibre - collapsed) / (distended - collapsed))) : 0
  return { rest, displacement: D }
}

/** 按充盈度 f 求位置（不改输入） / positions at filling f (the input is not changed) */
export function applyFilling(positions: ArrayLike<number>, field: FillingField, f: number): Float32Array {
  const out = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i++) out[i] = positions[i]! + (f - field.rest) * field.displacement[i]!
  return out
}

// ── 自交检查 / self-intersection check ───────────────────────────────────────────────────────────────

function triTriIntersect(p: ArrayLike<number>, a0: number, a1: number, a2: number, b0: number, b1: number, b2: number): boolean {
  // 线段对三角形，两个方向都试 / segment against triangle, both ways
  const V = (i: number): V3 => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!]
  const segTri = (s0: V3, s1: V3, t0: V3, t1: V3, t2: V3): boolean => {
    const d = sub(s1, s0)
    const e1 = sub(t1, t0), e2 = sub(t2, t0)
    const h = cross(d, e2)
    const det = dot(e1, h)
    if (Math.abs(det) < 1e-24) return false
    const inv = 1 / det
    const s = sub(s0, t0)
    const u = dot(s, h) * inv
    if (u < 1e-9 || u > 1 - 1e-9) return false
    const q = cross(s, e1)
    const v = dot(d, q) * inv
    if (v < 1e-9 || u + v > 1 - 1e-9) return false
    const t = dot(e2, q) * inv
    return t > 1e-9 && t < 1 - 1e-9
  }
  const A = [V(a0), V(a1), V(a2)] as const
  const B = [V(b0), V(b1), V(b2)] as const
  for (let e = 0; e < 3; e++) {
    if (segTri(A[e]!, A[(e + 1) % 3]!, B[0], B[1], B[2])) return true
    if (segTri(B[e]!, B[(e + 1) % 3]!, A[0], A[1], A[2])) return true
  }
  return false
}

/**
 * 网格里互相穿过的三角形对数（不共用顶点的两个三角形，一个的边穿过另一个的内部）。用均匀网格加速。
 * The number of triangle pairs that pass through each other (two triangles with no shared vertex,
 * an edge of one crossing the interior of the other). Accelerated by a uniform grid.
 */
export function selfIntersections(mesh: Mesh, limit = 1000, collect?: number[]): number {
  const p = mesh.positions
  const idx = mesh.indices
  const nt = idx.length / 3
  if (!nt) return 0
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let q = 0; q < 3; q++) {
    lo[q] = Math.min(lo[q]!, p[i + q]!)
    hi[q] = Math.max(hi[q]!, p[i + q]!)
  }
  const cell = Math.max(1e-6, Math.cbrt(((hi[0] - lo[0] + 1e-6) * (hi[1] - lo[1] + 1e-6) * (hi[2] - lo[2] + 1e-6)) / Math.max(1, nt / 2)))
  const dims = [0, 1, 2].map((q) => Math.max(1, Math.ceil((hi[q]! - lo[q]!) / cell)))
  const grid = new Map<number, number[]>()
  const box = (t: number): number[] => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let k = 0; k < 3; k++) for (let q = 0; q < 3; q++) {
      const x = p[3 * idx[3 * t + k]! + q]!
      b[q] = Math.min(b[q]!, x)
      b[q + 3] = Math.max(b[q + 3]!, x)
    }
    return b
  }
  const boxes: number[][] = []
  for (let t = 0; t < nt; t++) {
    const b = box(t)
    boxes.push(b)
    const c = [0, 1, 2].map((q) => [Math.min(dims[q]! - 1, Math.floor((b[q]! - lo[q]!) / cell)), Math.min(dims[q]! - 1, Math.floor((b[q + 3]! - lo[q]!) / cell))])
    for (let x = c[0]![0]!; x <= c[0]![1]!; x++) for (let y = c[1]![0]!; y <= c[1]![1]!; y++) for (let z = c[2]![0]!; z <= c[2]![1]!; z++) {
      const key = x + dims[0]! * (y + dims[1]! * z)
      const l = grid.get(key)
      if (l) l.push(t)
      else grid.set(key, [t])
    }
  }
  const seen = new Set<number>()
  let count = 0
  for (const l of grid.values()) {
    for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
      const a = l[i]!, b = l[j]!
      const key = a * nt + b
      if (seen.has(key)) continue
      seen.add(key)
      const A = boxes[a]!, B = boxes[b]!
      if (A[0]! > B[3]! || B[0]! > A[3]! || A[1]! > B[4]! || B[1]! > A[4]! || A[2]! > B[5]! || B[2]! > A[5]!) continue
      const ia = [idx[3 * a]!, idx[3 * a + 1]!, idx[3 * a + 2]!], ib = [idx[3 * b]!, idx[3 * b + 1]!, idx[3 * b + 2]!]
      // 共用顶点（按下标或按位置）的不算 / pairs sharing a vertex (by index or by position) do not count
      let shared = false
      for (const u of ia) for (const v of ib) if (u === v || (p[3 * u] === p[3 * v] && p[3 * u + 1] === p[3 * v + 1] && p[3 * u + 2] === p[3 * v + 2])) shared = true
      if (shared) continue
      if (triTriIntersect(p, ia[0]!, ia[1]!, ia[2]!, ib[0]!, ib[1]!, ib[2]!)) {
        count++
        // 要的话把相交的三角形对记下来（a, b 交替） / on request the intersecting triangle pairs are recorded (a, b alternating)
        if (collect) collect.push(a, b)
        if (count >= limit) return count
      }
    }
  }
  return count
}

/** 点到网格表面的最近距离（穷举，网格不大时用） / distance from a point to a mesh surface (brute force, for small meshes) */
export function distanceToMesh(mesh: Mesh, q: ArrayLike<number>): number {
  const p = mesh.positions
  const idx = mesh.indices
  let best = Infinity
  for (let t = 0; t < idx.length; t += 3) {
    const a: V3 = [p[3 * idx[t]!]!, p[3 * idx[t]! + 1]!, p[3 * idx[t]! + 2]!]
    const b: V3 = [p[3 * idx[t + 1]!]!, p[3 * idx[t + 1]! + 1]!, p[3 * idx[t + 1]! + 2]!]
    const c: V3 = [p[3 * idx[t + 2]!]!, p[3 * idx[t + 2]! + 1]!, p[3 * idx[t + 2]! + 2]!]
    // Ericson, Real-Time Collision Detection 5.1.5
    const ab = sub(b, a), ac = sub(c, a), ap = sub(q, a)
    const d1 = dot(ab, ap), d2 = dot(ac, ap)
    let cp: V3
    if (d1 <= 0 && d2 <= 0) cp = a
    else {
      const bp = sub(q, b)
      const d3 = dot(ab, bp), d4 = dot(ac, bp)
      if (d3 >= 0 && d4 <= d3) cp = b
      else {
        const vc = d1 * d4 - d3 * d2
        if (vc <= 0 && d1 >= 0 && d3 <= 0) cp = add(a, mul(ab, d1 / (d1 - d3)))
        else {
          const cq = sub(q, c)
          const d5 = dot(ab, cq), d6 = dot(ac, cq)
          if (d6 >= 0 && d5 <= d6) cp = c
          else {
            const vb = d5 * d2 - d1 * d6
            if (vb <= 0 && d2 >= 0 && d6 <= 0) cp = add(a, mul(ac, d2 / (d2 - d6)))
            else {
              const va = d3 * d6 - d5 * d4
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) cp = add(b, mul(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))))
              else {
                const den = 1 / (va + vb + vc)
                cp = add(a, add(mul(ab, vb * den), mul(ac, vc * den)))
              }
            }
          }
        }
      }
    }
    const d = dist(q, cp)
    if (d < best) best = d
  }
  return best
}

// ── 命令行 / command line ────────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  // bun tools/pipeline/lumen.ts <male|female> --out <dir> [--survey]
  const { runLumenCli } = await import('./lumenBuild.ts')
  await runLumenCli(process.argv.slice(2))
}
