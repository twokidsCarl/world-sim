// 盆腔韧带的两端重配：HRA 的韧带是为 HRA 自己的子宫画的；子宫换成 Wu 的之后，韧带在骨或盆壁一端
// 仍然到位，在器官一端落空。这里把一条韧带当作“沿一根轴排列的一串截面”：截面的形状保留，轴换成
// 从固定端到器官上附着点的一条绷紧的路径（必要时绕开直肠等器官），于是韧带变短（或变长）而不折叠。
// Two-end re-fit of pelvic ligaments. The HRA ligaments were drawn for HRA's own uterus; with the Wu
// uterus in its place they still meet bone or the pelvic wall at one end and miss the organ at the
// other. A ligament is taken here as a row of cross-sections strung on an axis: the cross-sections keep
// their shape, the axis is replaced by a taut path from the fixed end to the attachment point on the
// organ (round the rectum and other organs where they are in the way), so the ligament becomes shorter
// (or longer) without folding.

import type { Mesh } from './geometry.ts'
import { InsideTester, PointIndex, surfacePoints, thinPoints } from './register.ts'
import { axisParam } from './standard.ts'

export type Vec3 = [number, number, number]

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])
const unit = (a: Vec3): Vec3 => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const dist = (a: Vec3, b: Vec3) => len(sub(a, b))

/** 折线的总长 / length of a polyline */
export function pathLength(points: Vec3[]): number {
  let s = 0
  for (let i = 1; i < points.length; i++) s += dist(points[i]!, points[i - 1]!)
  return s
}

/** 按弧长把折线重采样成 n 个等距点 / a polyline resampled to n points equally spaced by arc length */
export function resamplePath(points: Vec3[], n: number): Vec3[] {
  const total = pathLength(points)
  if (points.length < 2 || total < 1e-9) return Array.from({ length: n }, () => [...points[0]!] as Vec3)
  const out: Vec3[] = []
  let seg = 1
  let done = 0
  for (let k = 0; k < n; k++) {
    const want = (total * k) / (n - 1)
    while (seg < points.length - 1 && done + dist(points[seg]!, points[seg - 1]!) < want) done += dist(points[seg]!, points[seg - 1]!), seg++
    const l = dist(points[seg]!, points[seg - 1]!) || 1e-12
    const f = Math.min(1, Math.max(0, (want - done) / l))
    out.push(add(points[seg - 1]!, mul(sub(points[seg]!, points[seg - 1]!), f)))
  }
  return out
}

/** 把向量 a 转到向量 b 的最小旋转（行主序 3×3）；a、b 为单位向量 / the minimal rotation taking unit vector a to unit vector b (row-major 3×3) */
export function rotationBetween(a: Vec3, b: Vec3): number[] {
  const v = cross(a, b)
  const c = dot(a, b)
  if (c < -0.999999) {
    // 反向：绕任一垂直轴转 180° / opposite: half a turn about any perpendicular axis
    const p = unit(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
    return [2 * p[0] * p[0] - 1, 2 * p[0] * p[1], 2 * p[0] * p[2], 2 * p[1] * p[0], 2 * p[1] * p[1] - 1, 2 * p[1] * p[2], 2 * p[2] * p[0], 2 * p[2] * p[1], 2 * p[2] * p[2] - 1]
  }
  const k = 1 / (1 + c)
  return [
    1 - k * (v[1] * v[1] + v[2] * v[2]), k * v[0] * v[1] - v[2], k * v[0] * v[2] + v[1],
    k * v[0] * v[1] + v[2], 1 - k * (v[0] * v[0] + v[2] * v[2]), k * v[1] * v[2] - v[0],
    k * v[0] * v[2] - v[1], k * v[1] * v[2] + v[0], 1 - k * (v[0] * v[0] + v[1] * v[1]),
  ]
}

/** 路径要绕开的实体 / a body the path must stay out of */
export interface Obstacle {
  contains(x: number, y: number, z: number): boolean
  surface: PointIndex
}

export function obstacleOf(mesh: Mesh, extraFill: Mesh[] = []): Obstacle {
  const testers = [mesh, ...extraFill].map((m) => new InsideTester(m, 96))
  return { contains: (x, y, z) => testers.some((t) => t.contains(x, y, z)), surface: new PointIndex(thinPoints(surfacePoints(mesh, 0.001), 0.0008), 0.004) }
}

/**
 * 绷紧的路径：从 `from` 到 `to` 的一根“橡皮筋”。各节点反复向相邻两点的中点收缩；落进障碍（按向外膨胀
 * `clearance` 计）的节点沿 `escape` 方向一直移到障碍之外。所有节点都朝同一个方向让开，所以路径不会
 * 来回折，并且绕在障碍的指定一侧（骶子宫韧带绕在直肠的外侧）。两端各有一段（`freeEnd`）间隙逐渐减到
 * 零：韧带的端点本来就在器官或骨的表面上。
 * A taut path: a rubber band from `from` to `to`. Its nodes are drawn again and again towards the
 * midpoint of their neighbours; a node that falls into an obstacle (taken as dilated by `clearance`)
 * moves along `escape` until it is out. Every node gives way in the same direction, so the path does not
 * zigzag and it passes on the chosen side of the obstacle (a uterosacral ligament lateral to the
 * rectum). Over a stretch at either end (`freeEnd`) the clearance tapers to zero: a ligament's ends lie
 * on the surface of an organ or a bone by nature.
 */
export function tautPath(from: Vec3, to: Vec3, obstacles: Obstacle[], opts: { clearance: number; escape: Vec3; spacing?: number; freeEnd?: number; iterations?: number; maxEscape?: number }): { points: Vec3[]; length: number; straight: number; nodesInside: number } {
  const spacing = opts.spacing ?? 0.0015
  const freeEnd = opts.freeEnd ?? 0.006
  const maxEscape = opts.maxEscape ?? 0.06
  const esc = unit(opts.escape)
  const blocked = (p: Vec3, c: number) => obstacles.some((o) => o.contains(p[0], p[1], p[2]) || (c > 0 && o.surface.distance(p[0], p[1], p[2], c) < c))
  const clear = (p: Vec3, c: number): Vec3 => {
    if (!blocked(p, c)) return p
    for (let t = 0.0005; t <= maxEscape; t += 0.0005) {
      const q = add(p, mul(esc, t))
      if (!blocked(q, c)) return q
    }
    return p
  }
  const n = Math.max(8, Math.ceil(dist(from, to) / spacing) + 1)
  let pts = resamplePath([from, to], n)
  const iterations = opts.iterations ?? 200
  for (let it = 0; it < iterations; it++) {
    const total = pathLength(pts)
    const next = pts.map((p) => [...p] as Vec3)
    let run = 0
    for (let i = 1; i < pts.length - 1; i++) {
      run += dist(pts[i]!, pts[i - 1]!)
      const mid = mul(add(pts[i - 1]!, pts[i + 1]!), 0.5)
      const c = opts.clearance * Math.min(1, run / freeEnd, (total - run) / freeEnd)
      next[i] = clear(add(pts[i]!, mul(sub(mid, pts[i]!), 0.5)), c)
    }
    pts = it % 10 === 9 ? resamplePath(next, Math.max(8, Math.ceil(pathLength(next) / spacing) + 1)) : next
  }
  // 最后只做几轮不进入障碍（留一半间隙）的平滑：去掉逐节点让开留下的小台阶 / a few last rounds of smoothing that never come nearer an obstacle than half the clearance: they remove the small steps left by node-wise giving way
  for (let it = 0; it < 30; it++) {
    const total = pathLength(pts)
    const next = pts.map((p) => [...p] as Vec3)
    let run = 0
    for (let i = 1; i < pts.length - 1; i++) {
      run += dist(pts[i]!, pts[i - 1]!)
      const q = add(pts[i]!, mul(sub(mul(add(pts[i - 1]!, pts[i + 1]!), 0.5), pts[i]!), 0.5))
      if (!blocked(q, 0.5 * opts.clearance * Math.min(1, run / freeEnd, (total - run) / freeEnd))) next[i] = q
    }
    pts = next
  }
  pts = resamplePath(pts, Math.max(8, Math.ceil(pathLength(pts) / spacing) + 1))
  return { points: pts, length: pathLength(pts), straight: dist(from, to), nodesInside: pts.slice(1, -1).filter((p) => blocked(p, 0)).length }
}

export interface LigamentAxis {
  /** 主轴上的原点和方向（方向从 `lo` 端指向 `hi` 端） / origin and direction of the principal axis (pointing from the `lo` end to the `hi` end) */
  c: Vec3
  axis: Vec3
  /** 两端沿主轴的坐标（米） / axial coordinates of the two ends (m) */
  lo: number
  hi: number
  /** 中心线：K 个站点，沿主轴等距，各为该处一薄层表面采样点的质心 / centreline: K stations equally spaced along the axis, each the centroid of the surface samples in a thin slab there */
  stations: Vec3[]
  /** 中心线的弧长（米） / arc length of the centreline (m) */
  length: number
}

/** 一条带状或索状韧带的主轴和中心线。 / Principal axis and centreline of a band- or cord-like ligament. */
export function ligamentAxis(mesh: Mesh, K = 24): LigamentAxis {
  const s = thinPoints(surfacePoints(mesh, 0.0008), 0.0006)
  const ap = axisParam(s)
  const c = ap.c as Vec3
  const axis = ap.axis as Vec3
  let lo = Infinity
  let hi = -Infinity
  const a = new Float64Array(s.length / 3)
  for (let i = 0; i < a.length; i++) {
    a[i] = (s[3 * i]! - c[0]) * axis[0] + (s[3 * i + 1]! - c[1]) * axis[1] + (s[3 * i + 2]! - c[2]) * axis[2]
    lo = Math.min(lo, a[i]!)
    hi = Math.max(hi, a[i]!)
  }
  const sum = Array.from({ length: K }, () => [0, 0, 0, 0])
  const half = (hi - lo) / (K - 1)
  for (let i = 0; i < a.length; i++) {
    const f = ((a[i]! - lo) / (hi - lo)) * (K - 1)
    for (const k of [Math.floor(f), Math.ceil(f)]) {
      if (k < 0 || k >= K) continue
      const w = Math.max(0, 1 - Math.abs(f - k))
      const e = sum[k]!
      e[0] = e[0]! + w * s[3 * i]!
      e[1] = e[1]! + w * s[3 * i + 1]!
      e[2] = e[2]! + w * s[3 * i + 2]!
      e[3] = e[3]! + w
    }
  }
  const stations: Vec3[] = []
  for (let k = 0; k < K; k++) {
    const e = sum[k]!
    const at = lo + k * half
    const onAxis = add(c, mul(axis, at))
    if (e[3]! < 1e-9) {
      stations.push(onAxis)
      continue
    }
    // 站点只保留质心的横向偏移：它在主轴上的坐标恰好是该站的坐标，于是每个顶点相对中心线的偏移都垂直于主轴
    // only the lateral offset of the centroid is kept: the station's axial coordinate is exactly its own, so that every vertex's offset from the centreline is perpendicular to the axis
    const m: Vec3 = [e[0]! / e[3]!, e[1]! / e[3]!, e[2]! / e[3]!]
    const lateral = sub(sub(m, c), mul(axis, dot(sub(m, c), axis)))
    stations.push(add(onAxis, lateral))
  }
  return { c, axis, lo, hi, stations, length: pathLength(stations) }
}

export interface RefitResult {
  mesh: Mesh
  nativeLength: number
  newLength: number
  /** 新长度 / 原长度 / new length over native length */
  lengthRatio: number
  /** 法向相对于“原法向随截面一起转过去”翻转了的三角形所占的面积比例：折叠的标志 / share of the area in triangles whose normal is reversed against the native normal carried along with the cross-section: the sign of a fold */
  foldedAreaShare: number
  /** 路径上相邻切向之间的最大夹角（度） / largest angle between successive tangents of the path (degrees) */
  maxBendDeg: number
}

/**
 * 把韧带沿新路径重排：顶点 p 在主轴上的归一化位置为 u，相对中心线的偏移 o = p − C(u) 垂直于主轴；
 * 新位置为 C′(u) + R(u)·o，C′ 是 `path` 上弧长比例为 u 的点，R(u) 是把主轴方向转到该处切向的最小旋转。
 * `path` 从韧带的 `startEnd` 一端（`lo` 或 `hi`）走向另一端。
 * Re-lays a ligament along a new path: a vertex p at normalised axial position u has the offset
 * o = p − C(u) from the centreline, perpendicular to the axis; it goes to C′(u) + R(u)·o, where C′ is the
 * point of `path` at arc-length fraction u and R(u) the minimal rotation taking the axis direction to the
 * tangent there. `path` runs from the ligament's `startEnd` (`lo` or `hi`) to the other end.
 */
export function relayAlongPath(mesh: Mesh, ax: LigamentAxis, startEnd: 'lo' | 'hi', path: Vec3[]): RefitResult {
  const K = ax.stations.length
  const dir: Vec3 = startEnd === 'lo' ? ax.axis : mul(ax.axis, -1)
  const N = Math.max(16, path.length)
  const line = resamplePath(path, N)
  // 切向先平滑一遍，免得截面随折线的小拐角抖动 / tangents are smoothed once so that cross-sections do not jitter with small kinks of the polyline
  const raw = line.map((_, i) => unit(sub(line[Math.min(N - 1, i + 1)]!, line[Math.max(0, i - 1)]!)))
  const tan = raw.map((_, i) => unit(add(add(raw[Math.max(0, i - 1)]!, raw[i]!), raw[Math.min(N - 1, i + 1)]!)))
  const rot = tan.map((t) => rotationBetween(dir, t))
  let maxBend = 0
  for (let i = 1; i < N; i++) maxBend = Math.max(maxBend, Math.acos(Math.min(1, Math.max(-1, dot(raw[i]!, raw[i - 1]!)))))
  const src = mesh.positions
  const out = new Float32Array(src.length)
  const lerp = (arr: Vec3[], f: number): Vec3 => {
    const g = Math.min(arr.length - 1, Math.max(0, f))
    const i = Math.min(arr.length - 2, Math.floor(g))
    return add(arr[i]!, mul(sub(arr[i + 1]!, arr[i]!), g - i))
  }
  const carry = (p: Vec3, u: number, vector = false): Vec3 => {
    const f = u * (N - 1)
    const i = Math.min(N - 2, Math.max(0, Math.floor(f)))
    const w = Math.min(1, Math.max(0, f - i))
    const R = rot[i]!.map((v, k) => v * (1 - w) + rot[i + 1]![k]! * w)
    const q: Vec3 = [R[0]! * p[0] + R[1]! * p[1] + R[2]! * p[2], R[3]! * p[0] + R[4]! * p[1] + R[5]! * p[2], R[6]! * p[0] + R[7]! * p[1] + R[8]! * p[2]]
    return vector ? q : add(lerp(line, f), q)
  }
  const uOf = new Float32Array(src.length / 3)
  for (let v = 0; v < uOf.length; v++) {
    const p: Vec3 = [src[3 * v]!, src[3 * v + 1]!, src[3 * v + 2]!]
    const a = dot(sub(p, ax.c), ax.axis)
    const f = Math.min(1, Math.max(0, (a - ax.lo) / (ax.hi - ax.lo)))
    const o = sub(p, lerp(ax.stations, f * (K - 1)))
    const u = startEnd === 'lo' ? f : 1 - f
    uOf[v] = u
    const q = carry(o, u)
    out[3 * v] = q[0]
    out[3 * v + 1] = q[1]
    out[3 * v + 2] = q[2]
  }
  // 折叠：三角形的新法向与“原法向按同一旋转带过去”的方向相反
  // folds: a triangle's new normal opposite to its native normal carried by the same rotation
  let folded = 0
  let area = 0
  const idx = mesh.indices
  const normal = (p: Float32Array, t: number): Vec3 => {
    const a = 3 * idx[t]!
    const b = 3 * idx[t + 1]!
    const c = 3 * idx[t + 2]!
    return cross([p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!], [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!])
  }
  // 轴向被压缩，所以法向的轴向分量相对放大：比较前按同一比例换算
  // the axis is compressed, so the axial component of a normal grows in proportion: converted before the comparison
  const k = pathLength(line) / Math.max(1e-9, ax.hi - ax.lo)
  for (let t = 0; t < idx.length; t += 3) {
    const n0 = normal(src, t)
    const n1 = normal(out, t)
    area += len(n1) / 2
    if (len(n0) < 1e-14) continue
    const u = (uOf[idx[t]!]! + uOf[idx[t + 1]!]! + uOf[idx[t + 2]!]!) / 3
    const axial = dot(n0, dir)
    const n0s = add(mul(sub(n0, mul(dir, axial)), k), mul(dir, axial))
    if (dot(carry(n0s, u, true), n1) < 0) folded += len(n1) / 2
  }
  const newLength = pathLength(line)
  return { mesh: { positions: out, indices: mesh.indices }, nativeLength: ax.length, newLength, lengthRatio: newLength / Math.max(1e-9, ax.length), foldedAreaShare: folded / Math.max(1e-12, area), maxBendDeg: (maxBend * 180) / Math.PI }
}

/** 网格上沿主轴某一端（占全长 `share`）的顶点（展平的 xyz）。 / Vertices of a mesh within `share` of the length from one end of its axis (flat xyz). */
export function endVertices(mesh: Mesh, ax: LigamentAxis, end: 'lo' | 'hi', share = 0.08): Float32Array {
  const out: number[] = []
  const p = mesh.positions
  for (let i = 0; i < p.length; i += 3) {
    const f = ((p[i]! - ax.c[0]) * ax.axis[0] + (p[i + 1]! - ax.c[1]) * ax.axis[1] + (p[i + 2]! - ax.c[2]) * ax.axis[2] - ax.lo) / (ax.hi - ax.lo)
    if (end === 'lo' ? f <= share : f >= 1 - share) out.push(p[i]!, p[i + 1]!, p[i + 2]!)
  }
  return Float32Array.from(out)
}
