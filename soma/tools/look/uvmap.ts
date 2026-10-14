// 把 MHR 的 UV 布局搬到发布的皮肤上（纯计算，不读写文件；入口在 uv.ts）。
// Carry MHR's UV layout over to the shipped skin (pure computation, no file access; the entry point is uv.ts).
//
// 做法 / How
//   · 发布的皮肤是皮肤包简化后的结果；包的前 nMhr 个顶点就是 MHR LOD0 的顶点（下标不变），后面是移植片
//     和开口构造追加的顶点。皮肤顶点经 skin-source.u32 指回包里的顶点。
//     The shipped skin is a simplification of the skin package; the package's first nMhr vertices are
//     MHR LOD0's (same indices), the rest were appended by grafts and the construction of the openings.
//     A skin vertex points back to its package vertex through skin-source.u32.
//   · MHR 的 UV 按面角给出；同一顶点在接缝两侧有不同的 UV 点。UV 点按三角形连通分成岛。
//     MHR gives UVs per face corner; one vertex has different UV points on either side of a seam.
//     UV points are grouped into islands by triangle connectivity.
//   · 对每个皮肤三角形选一个岛：三个角各自能落在哪些岛（MHR 顶点：它的面角所在的岛；追加的顶点：离它最近的
//     MHR 面所在的岛），取票数最多的。角在这个岛里有自己的 UV 就用它；没有（简化把三角形拉过了接缝，或追加的
//     顶点）就把这个角的包内位置投到这个岛最近的 MHR 面上，按重心坐标插值 UV。
//     Each skin triangle gets one island: every corner votes for the islands it can lie in (an MHR
//     vertex: the islands of its face corners; an appended vertex: the island of the nearest MHR face),
//     the most votes win. A corner with its own UV in that island uses it; otherwise (simplification
//     pulled the triangle across a seam, or the vertex was appended) its package position is projected
//     onto the nearest MHR face of that island and the UV interpolated barycentrically.
//   · 覆盖网格的顶点是 (皮肤顶点, 岛, UV) 的不同组合；三角形次序与皮肤相同。
//     The overlay's vertices are the distinct (skin vertex, island, UV) combinations; the triangles keep
//     the skin's order.

export interface MhrUv {
  nV: number
  faces: Uint32Array
  uvFaces: Uint32Array
  uv: Float32Array
}

export interface UvMapInput {
  mhr: MhrUv
  /** 皮肤包的顶点位置（米，扁平 xyz）；前 mhr.nV 个是 MHR 顶点 / package vertex positions (m, flat xyz); the first mhr.nV are MHR's */
  packagePositions: Float32Array
  /** 发布皮肤：顶点 → 包内顶点 / shipped skin: vertex → package vertex */
  skinSource: Uint32Array
  /** 发布皮肤的三角形 / triangles of the shipped skin */
  skinIndex: Uint32Array
}

export interface UvMapResult {
  skinVertex: Uint32Array
  uv: Float32Array
  index: Uint32Array
  islands: number
  stats: {
    /** 有 MHR 来源的皮肤顶点 / skin vertices with an MHR origin */
    mhrVertices: number
    /** 追加的皮肤顶点（投影取 UV）/ appended skin vertices (UV by projection) */
    appendedVertices: number
    /** 至少有一个角要投影到所选岛上的三角形 / triangles with at least one corner projected into the chosen island */
    seamTriangles: number
    /** 被拉过岛自己接缝、按锚角重新投影的三角形 / triangles pulled across their island's own seam and re-projected about an anchor corner */
    rewrappedTriangles: number
    /** 在 UV 上翻面（与所在岛的多数朝向相反）的三角形：全由 MHR 顶点构成的、含追加顶点的
     * triangles flipped in UV (against their island's majority orientation): made only of MHR vertices, with appended vertices */
    flippedMhrTriangles: number
    flippedAppendedTriangles: number
    /** 追加顶点到最近 MHR 面的距离（毫米）：中位数、95% 分位、最大 / distance of appended vertices to the nearest MHR face (mm): median, 95th percentile, maximum */
    appendedMedianMm: number
    appended95Mm: number
    appendedMaxMm: number
    /** 拉过接缝的角投到所选岛上的距离（毫米）：中位数、最大 / distance of corners pulled across a seam to the chosen island (mm): median, maximum */
    seamMedianMm: number
    seamMaxMm: number
  }
}

/** UV 点按三角形连通分岛 / Group UV points into islands by triangle connectivity. */
export function uvIslands(m: MhrUv): { island: Int32Array; count: number } {
  const nT = m.uv.length / 2
  const parent = Int32Array.from({ length: nT }, (_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!
      x = parent[x]!
    }
    return x
  }
  for (let f = 0; f < m.uvFaces.length; f += 3) {
    const a = find(m.uvFaces[f]!), b = find(m.uvFaces[f + 1]!), c = find(m.uvFaces[f + 2]!)
    parent[b] = a
    parent[find(c)] = a
  }
  const island = new Int32Array(nT).fill(-1)
  const ids = new Map<number, number>()
  for (let t = 0; t < nT; t++) {
    const r = find(t)
    let id = ids.get(r)
    if (id === undefined) ids.set(r, (id = ids.size))
    island[t] = id
  }
  return { island, count: ids.size }
}

/** 点到三角形的最近点（Ericson，《实时碰撞检测》5.1.5）；返回重心坐标和距离平方。
 * Closest point on a triangle (Ericson, Real-Time Collision Detection 5.1.5); returns barycentrics and squared distance. */
export function closestOnTriangle(p: ArrayLike<number>, a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>): { u: number; v: number; w: number; d2: number } {
  const ab = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
  const ac = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!]
  const ap = [p[0]! - a[0]!, p[1]! - a[1]!, p[2]! - a[2]!]
  const dot = (x: number[], y: number[]): number => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!
  const at = (u: number, v: number, w: number) => {
    const q0 = a[0]! * u + b[0]! * v + c[0]! * w, q1 = a[1]! * u + b[1]! * v + c[1]! * w, q2 = a[2]! * u + b[2]! * v + c[2]! * w
    return { u, v, w, d2: (p[0]! - q0) ** 2 + (p[1]! - q1) ** 2 + (p[2]! - q2) ** 2 }
  }
  // 退化的边或面会让上面的除法得到 NaN：退回到最近的角 / a degenerate edge or face makes the divisions NaN: fall back to the nearest corner
  const out = (u: number, v: number, w: number) => {
    const r = at(u, v, w)
    if (Number.isFinite(r.d2)) return r
    const ra = at(1, 0, 0), rb = at(0, 1, 0), rc = at(0, 0, 1)
    return ra.d2 <= rb.d2 && ra.d2 <= rc.d2 ? ra : rb.d2 <= rc.d2 ? rb : rc
  }
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return out(1, 0, 0)
  const bp = [p[0]! - b[0]!, p[1]! - b[1]!, p[2]! - b[2]!]
  const d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return out(0, 1, 0)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return out(1 - v, v, 0)
  }
  const cp = [p[0]! - c[0]!, p[1]! - c[1]!, p[2]! - c[2]!]
  const d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return out(0, 0, 1)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return out(1 - w, 0, w)
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return out(0, 1 - w, w)
  }
  const sum = va + vb + vc
  // 退化三角形（面积为零）：取最近的顶点 / degenerate triangle (zero area): take the nearest corner
  if (!(Math.abs(sum) > 1e-30)) {
    const da = ap[0]! ** 2 + ap[1]! ** 2 + ap[2]! ** 2, db = bp[0]! ** 2 + bp[1]! ** 2 + bp[2]! ** 2, dc = cp[0]! ** 2 + cp[1]! ** 2 + cp[2]! ** 2
    return da <= db && da <= dc ? out(1, 0, 0) : db <= dc ? out(0, 1, 0) : out(0, 0, 1)
  }
  const v = vb / sum, w = vc / sum
  return out(1 - v - w, v, w)
}

/** 三角形的均匀网格，查最近的三角形（可限定一个岛）/ A uniform grid of triangles for nearest-triangle queries (optionally within one island). */
class TriangleGrid {
  private readonly cells = new Map<number, number[]>()
  private readonly min: [number, number, number]
  private readonly dims: [number, number, number]

  /** `subset`：只收这些三角形（默认全部）/ `subset`: only these triangles (all by default) */
  constructor(
    private readonly pos: Float32Array,
    private readonly faces: Uint32Array,
    private readonly cell: number,
    subset: ArrayLike<number> | null = null,
  ) {
    const list = subset ?? Array.from({ length: faces.length / 3 }, (_, f) => f)
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < list.length; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
      const x = pos[faces[list[i]! * 3 + j]! * 3 + k]!
      lo[k] = Math.min(lo[k]!, x)
      hi[k] = Math.max(hi[k]!, x)
    }
    this.min = [lo[0]!, lo[1]!, lo[2]!]
    this.dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((hi[k]! - lo[k]!) / cell) + 1)) as [number, number, number]
    for (let i = 0; i < list.length; i++) {
      const f = list[i]!
      const b0 = [Infinity, Infinity, Infinity], b1 = [-Infinity, -Infinity, -Infinity]
      for (let j = 0; j < 3; j++) {
        const v = faces[f * 3 + j]!
        for (let k = 0; k < 3; k++) {
          b0[k] = Math.min(b0[k]!, pos[v * 3 + k]!)
          b1[k] = Math.max(b1[k]!, pos[v * 3 + k]!)
        }
      }
      const c0 = b0.map((x, k) => this.coord(x, k)), c1 = b1.map((x, k) => this.coord(x, k))
      for (let x = c0[0]!; x <= c1[0]!; x++) for (let y = c0[1]!; y <= c1[1]!; y++) for (let z = c0[2]!; z <= c1[2]!; z++) {
        const key = (x * this.dims[1] + y) * this.dims[2] + z
        let list = this.cells.get(key)
        if (!list) this.cells.set(key, (list = []))
        list.push(f)
      }
    }
  }

  private coord(x: number, k: number): number {
    return Math.min(this.dims[k]! - 1, Math.max(0, Math.floor((x - this.min[k]!) / this.cell)))
  }

  /** 最近的三角形；`accept` 过滤 / The nearest triangle; `accept` filters. */
  nearest(p: ArrayLike<number>, accept: (f: number) => boolean): { f: number; u: number; v: number; w: number; d2: number } | null {
    const c = [0, 1, 2].map((k) => this.coord(p[k]!, k))
    let best: { f: number; u: number; v: number; w: number; d2: number } | null = null
    const a = [0, 0, 0], b = [0, 0, 0], d = [0, 0, 0]
    const maxR = Math.max(...this.dims)
    for (let r = 0; r <= maxR; r++) {
      // 外圈之外的点至少相距 (r-1)·cell：找到的比这个近就停 / points beyond ring r are at least (r-1)·cell away: stop once closer
      if (best && Math.sqrt(best.d2) < (r - 1) * this.cell) break
      // 只走第 r 圈的外壳，并裁到网格范围内 / visit only the shell of ring r, clipped to the grid
      const x0 = Math.max(0, c[0]! - r), x1 = Math.min(this.dims[0] - 1, c[0]! + r)
      const y0 = Math.max(0, c[1]! - r), y1 = Math.min(this.dims[1] - 1, c[1]! + r)
      const z0 = Math.max(0, c[2]! - r), z1 = Math.min(this.dims[2] - 1, c[2]! + r)
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const onShell = Math.abs(x - c[0]!) === r || Math.abs(y - c[1]!) === r
        const zStep = onShell ? 1 : Math.max(1, 2 * r)
        for (let z = onShell ? z0 : c[2]! - r; z <= z1; z += zStep) {
          if (z < z0) continue
          const list = this.cells.get((x * this.dims[1] + y) * this.dims[2] + z)
          if (!list) continue
          for (const f of list) {
            if (!accept(f)) continue
            for (let k = 0; k < 3; k++) {
              a[k] = this.pos[this.faces[f * 3]! * 3 + k]!
              b[k] = this.pos[this.faces[f * 3 + 1]! * 3 + k]!
              d[k] = this.pos[this.faces[f * 3 + 2]! * 3 + k]!
            }
            const q = closestOnTriangle(p, a, b, d)
            if (!best || q.d2 < best.d2) best = { f, ...q }
          }
        }
      }
    }
    return best
  }
}

export function mapUv(input: UvMapInput): UvMapResult {
  const { mhr, packagePositions, skinSource, skinIndex } = input
  const { island, count } = uvIslands(mhr)
  const faceIsland = new Int32Array(mhr.faces.length / 3)
  for (let f = 0; f < faceIsland.length; f++) faceIsland[f] = island[mhr.uvFaces[f * 3]!]!

  // MHR 顶点在各岛里的 UV 点；一个岛绕成筒（躯干、四肢）时，接缝上的顶点在同一个岛里有两个 UV 点
  // the UV points of each MHR vertex in each island; where an island wraps into a tube (trunk, limbs), a vertex on its seam has two UV points in the same island
  const own = new Map<number, number[]>() // key v * count + island → UV points
  for (let f = 0; f < mhr.faces.length; f++) {
    const key = mhr.faces[f]! * count + island[mhr.uvFaces[f]!]!
    const list = own.get(key)
    if (!list) own.set(key, [mhr.uvFaces[f]!])
    else if (!list.includes(mhr.uvFaces[f]!)) list.push(mhr.uvFaces[f]!)
  }

  const mhrPos = packagePositions.subarray(0, mhr.nV * 3)
  const grid = new TriangleGrid(mhrPos, mhr.faces, 0.01)
  // 每个岛一张网格，限定岛的查找只在岛自己的范围里走 / one grid per island, so a search within an island stays inside its extent
  const byIsland: number[][] = Array.from({ length: count }, () => [])
  for (let f = 0; f < faceIsland.length; f++) byIsland[faceIsland[f]!]!.push(f)
  const islandGrid = new Map<number, TriangleGrid>()
  const gridOf = (k: number): TriangleGrid => {
    let g = islandGrid.get(k)
    if (!g) islandGrid.set(k, (g = new TriangleGrid(mhrPos, mhr.faces, 0.01, byIsland[k]!)))
    return g
  }
  const nSkin = skinSource.length
  const pkgPos = (s: number): Float32Array => packagePositions.subarray(skinSource[s]! * 3, skinSource[s]! * 3 + 3)
  const appendedDist: number[] = []
  const seamDist: number[] = []

  // 追加顶点：最近的 MHR 面 / appended vertices: the nearest MHR face
  const nearestAny = new Map<number, { f: number; u: number; v: number; w: number }>()
  let appended = 0
  for (let s = 0; s < nSkin; s++) {
    if (skinSource[s]! < mhr.nV) continue
    appended++
    const q = grid.nearest(pkgPos(s), () => true)!
    nearestAny.set(s, q)
    appendedDist.push(Math.sqrt(q.d2) * 1000)
  }

  const interp = (f: number, u: number, v: number, w: number): [number, number] => {
    const t0 = mhr.uvFaces[f * 3]!, t1 = mhr.uvFaces[f * 3 + 1]!, t2 = mhr.uvFaces[f * 3 + 2]!
    return [mhr.uv[t0 * 2]! * u + mhr.uv[t1 * 2]! * v + mhr.uv[t2 * 2]! * w, mhr.uv[t0 * 2 + 1]! * u + mhr.uv[t1 * 2 + 1]! * v + mhr.uv[t2 * 2 + 1]! * w]
  }

  type Cand = { u: number; v: number; key: string; proj: boolean }
  const projected = (s: number, q: { f: number; u: number; v: number; w: number }): Cand => {
    const [u, v] = interp(q.f, q.u, q.v, q.w)
    return { u, v, key: `${s}:${Math.round(u * 65535)},${Math.round(v * 65535)}`, proj: true }
  }
  /** 皮肤顶点 s 在岛 k 里可用的 UV / The UVs skin vertex s can take in island k. */
  const candsIn = (s: number, k: number): Cand[] => {
    const pv = skinSource[s]!
    if (pv < mhr.nV) {
      const pts = own.get(pv * count + k)
      if (pts) return pts.map((t) => ({ u: mhr.uv[t * 2]!, v: mhr.uv[t * 2 + 1]!, key: `${s}:${t}`, proj: false }))
    } else {
      const q = nearestAny.get(s)!
      if (faceIsland[q.f] === k) return [projected(s, q)]
    }
    const q = gridOf(k).nearest(pkgPos(s), () => true)!
    seamDist.push(Math.sqrt(q.d2) * 1000)
    return [projected(s, q)]
  }

  const islandsOf = (s: number): number[] => {
    const pv = skinSource[s]!
    if (pv >= mhr.nV) return [faceIsland[nearestAny.get(s)!.f]!]
    const out: number[] = []
    for (let k = 0; k < count; k++) if (own.has(pv * count + k)) out.push(k)
    return out
  }

  // 每个岛的 UV 密度（UV 周长 / 3D 周长 的中位数），用来认出被拉过接缝的三角形
  // UV density of each island (median of UV perimeter / 3D perimeter), to recognise triangles pulled across a seam
  const dist3 = (i: number, j: number): number => Math.hypot(packagePositions[i * 3]! - packagePositions[j * 3]!, packagePositions[i * 3 + 1]! - packagePositions[j * 3 + 1]!, packagePositions[i * 3 + 2]! - packagePositions[j * 3 + 2]!)
  const distUv = (a: { u: number; v: number }, b: { u: number; v: number }): number => Math.hypot(a.u - b.u, a.v - b.v)
  const density = new Float64Array(count)
  {
    const per: number[][] = Array.from({ length: count }, () => [])
    for (let f = 0; f < mhr.faces.length / 3; f += 7) {
      const [v0, v1, v2] = [mhr.faces[f * 3]!, mhr.faces[f * 3 + 1]!, mhr.faces[f * 3 + 2]!]
      const [t0, t1, t2] = [mhr.uvFaces[f * 3]!, mhr.uvFaces[f * 3 + 1]!, mhr.uvFaces[f * 3 + 2]!]
      const p3 = dist3(v0, v1) + dist3(v1, v2) + dist3(v2, v0)
      const pu = Math.hypot(mhr.uv[t0 * 2]! - mhr.uv[t1 * 2]!, mhr.uv[t0 * 2 + 1]! - mhr.uv[t1 * 2 + 1]!) + Math.hypot(mhr.uv[t1 * 2]! - mhr.uv[t2 * 2]!, mhr.uv[t1 * 2 + 1]! - mhr.uv[t2 * 2 + 1]!) + Math.hypot(mhr.uv[t2 * 2]! - mhr.uv[t0 * 2]!, mhr.uv[t2 * 2 + 1]! - mhr.uv[t0 * 2 + 1]!)
      if (p3 > 1e-6) per[faceIsland[f]!]!.push(pu / p3)
    }
    per.forEach((l, k) => (density[k] = l.length ? l.sort((x, y) => x - y)[l.length >> 1]! : 0))
  }
  // 一个三角形的 UV 周长超过 3D 周长 × 该岛密度的这么多倍，就当作被拉过了接缝
  // a triangle whose UV perimeter exceeds its 3D perimeter × the island density by this factor counts as pulled across a seam
  const SEAM_FACTOR = 4

  const vertexOf = new Map<string, number>()
  const skinVertex: number[] = []
  const uvOut: number[] = []
  const index = new Uint32Array(skinIndex.length)
  const triIsland = new Int32Array(skinIndex.length / 3)
  let seamTriangles = 0
  let rewrapped = 0
  const votes = new Map<number, number>()
  for (let t = 0; t < skinIndex.length; t += 3) {
    votes.clear()
    const corners = [skinIndex[t]!, skinIndex[t + 1]!, skinIndex[t + 2]!]
    for (const s of corners) for (const k of islandsOf(s)) votes.set(k, (votes.get(k) ?? 0) + 1)
    let k = -1, best = -1
    for (const [isl, n] of votes) if (n > best || (n === best && isl < k)) [k, best] = [isl, n]
    triIsland[t / 3] = k
    // 各角的候选 UV 里取周长最短的组合 / of the corners' candidate UVs take the combination with the shortest perimeter
    const cands = corners.map((s) => candsIn(s, k))
    let pick: Cand[] = [cands[0]![0]!, cands[1]![0]!, cands[2]![0]!]
    let bestPer = Infinity
    for (const a of cands[0]!) for (const b of cands[1]!) for (const c of cands[2]!) {
      const per = distUv(a, b) + distUv(b, c) + distUv(c, a)
      if (per < bestPer) [bestPer, pick] = [per, [a, b, c]]
    }
    // 仍然太长：简化把三角形拉过了岛自己的接缝。以一个有自己 UV 的角为锚，把离它远的角投到锚附近的面上
    // still too long: simplification pulled the triangle across the island's own seam. Anchor on a corner with its own UV and project the far corners onto faces near the anchor
    const pv = corners.map((s) => skinSource[s]!)
    const per3 = dist3(pv[0]!, pv[1]!) + dist3(pv[1]!, pv[2]!) + dist3(pv[2]!, pv[0]!)
    if (bestPer > SEAM_FACTOR * density[k]! * per3 + 1e-4) {
      const anchor = pick.findIndex((c) => !c.proj)
      if (anchor >= 0) {
        const au = pick[anchor]!
        const reach = 2 * density[k]! * per3 + 0.005
        for (let j = 0; j < 3; j++) {
          if (j === anchor || distUv(pick[j]!, au) <= reach) continue
          const q = gridOf(k).nearest(pkgPos(corners[j]!), (f) => {
            const t0 = mhr.uvFaces[f * 3]!
            return Math.hypot(mhr.uv[t0 * 2]! - au.u, mhr.uv[t0 * 2 + 1]! - au.v) <= reach + 0.02
          })
          if (q) pick[j] = projected(corners[j]!, q)
        }
        rewrapped++
      }
    }
    let proj = false
    for (let j = 0; j < 3; j++) {
      const s = corners[j]!
      const c = pick[j]!
      if (c.proj && skinSource[s]! < mhr.nV) proj = true
      let o = vertexOf.get(c.key)
      if (o === undefined) {
        vertexOf.set(c.key, (o = skinVertex.length))
        skinVertex.push(s)
        uvOut.push(c.u, c.v)
      }
      index[t + j] = o
    }
    if (proj) seamTriangles++
  }

  // UV 朝向：MHR 的每个岛朝向一致（左右镜像的岛彼此相反）。按岛取全由 MHR 顶点构成的三角形的多数朝向，
  // 再分别数与之相反的 MHR 三角形和含追加顶点的三角形（移植片投影到形状不同的 MHR 面上，会折叠）
  // UV orientation: every MHR island is consistently oriented (mirrored left/right islands are opposite). Take each
  // island's majority over the triangles made only of MHR vertices, then count, separately, MHR triangles and
  // triangles with appended vertices against it (grafts projected onto MHR faces of a different shape fold over)
  const sign = new Int8Array(index.length / 3)
  const pos = new Int32Array(count), neg = new Int32Array(count)
  const allMhr = (t: number): boolean => skinSource[skinIndex[t]!]! < mhr.nV && skinSource[skinIndex[t + 1]!]! < mhr.nV && skinSource[skinIndex[t + 2]!]! < mhr.nV
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t]! * 2, b = index[t + 1]! * 2, c = index[t + 2]! * 2
    const area = (uvOut[b]! - uvOut[a]!) * (uvOut[c + 1]! - uvOut[a + 1]!) - (uvOut[c]! - uvOut[a]!) * (uvOut[b + 1]! - uvOut[a + 1]!)
    sign[t / 3] = area > 0 ? 1 : area < 0 ? -1 : 0
    if (!allMhr(t)) continue
    if (area > 0) pos[triIsland[t / 3]!]!++
    else if (area < 0) neg[triIsland[t / 3]!]!++
  }
  let flippedMhr = 0, flippedAppended = 0
  for (let t = 0; t < index.length; t += 3) {
    const k = triIsland[t / 3]!
    const major = pos[k]! >= neg[k]! ? 1 : -1
    if (sign[t / 3] !== -major) continue
    if (allMhr(t)) flippedMhr++
    else flippedAppended++
  }
  const pct = (a: number[], f: number): number => (a.length ? a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))]! : 0)
  return {
    skinVertex: Uint32Array.from(skinVertex),
    uv: Float32Array.from(uvOut),
    index,
    islands: count,
    stats: {
      mhrVertices: nSkin - appended,
      appendedVertices: appended,
      seamTriangles,
      rewrappedTriangles: rewrapped,
      flippedMhrTriangles: flippedMhr,
      flippedAppendedTriangles: flippedAppended,
      appendedMedianMm: pct(appendedDist, 0.5),
      appended95Mm: pct(appendedDist, 0.95),
      appendedMaxMm: pct(appendedDist, 1),
      seamMedianMm: pct(seamDist, 0.5),
      seamMaxMm: pct(seamDist, 1),
    },
  }
}
