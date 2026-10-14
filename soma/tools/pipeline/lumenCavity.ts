// 口腔和咽的腔：不是器官的壁内缩出来的，而是周围真实部件之间剩下的空间。
// 在一个小体素网格上取样：一个格点算“空”，如果它不在任何定界部件里、离它们的表面不少于余量、在引导线的可及范围内、
// 在各截面（口裂、食管入口）的这一侧、不在构造的封闭面（腭帆）里，并且从最近的引导点看得见它（连线上都是空的）。
// 然后做一次形态学开运算（去掉从部件缝隙里漏出去的薄片），取含引导线的连通块，模糊一遍，用行进四面体取 0.5 等值面——
// 一张封闭、不自交的面。每个顶点记下它贴着的是真实部件，还是哪一种构造的边界。
//
// The cavities of mouth and pharynx: not a wall offset inward but the space left between the real
// parts around them. Sampled on a small voxel grid: a node is free when it lies in no bounding part,
// no closer to their surfaces than a clearance, within reach of the guide line, on the near side of
// every cut plane (oral fissure, oesophageal inlet), outside the constructed closures (the velum) and
// visible from the nearest guide point (the segment between them is free). One morphological opening
// follows (it removes the thin sheets that leak through gaps between parts), the component holding
// the guide is kept, the field is blurred once and the 0.5 isosurface is taken by marching tetrahedra:
// one closed surface that cannot intersect itself. Every vertex records whether it lies against a real
// part or against which kind of constructed boundary.

import type { Mesh } from './geometry.ts'
import type { V3 } from './lumen.ts'

export interface CavityGuide { key: string; pts: ArrayLike<number>; maxR: number }
export interface CavityInput {
  guides: CavityGuide[]
  bounds: { id: string; mesh: Mesh; solid: { contains: (x: number, y: number, z: number) => boolean } }[]
  /** 截面：只在 (x − p)·n < 0 的一侧有腔 / cut planes: the cavity exists only where (x − p)·n < 0 */
  planes: { name: string; p: V3; n: V3 }[]
  /** 构造的封闭面：离它不足 half 的格点算实心 / constructed closures: a node closer than `half` to one is solid */
  sheets: { name: string; mesh: Mesh; half: number }[]
  /** 标出的开口：离 p 不足 r 的构造顶点记为这个开口 / marked openings: a constructed vertex within r of p is recorded as this opening */
  marks: { name: string; p: V3; r: number }[]
  /** 体素边长和到部件的余量（米） / voxel size and clearance to the parts (metres) */
  h: number
  clearance: number
}

export interface CavityPart {
  key: string
  mesh: Mesh
  /** 每个顶点：2 贴着真实部件，1 构造 / per vertex: 2 against a real part, 1 construction */
  origin: Uint8Array
  /** 每个顶点最近的引导点 / the nearest guide point of every vertex */
  centres: Float32Array
  volumeCm3: number
}
export interface CavityResult { parts: CavityPart[]; whole: Mesh; report: Record<string, unknown> }

/** 点到三角形的最近距离 / the distance from a point to a triangle */
function pointTriangle(px: number, py: number, pz: number, a: ArrayLike<number>, ia: number, ib: number, ic: number): number {
  const ax = a[ia]!, ay = a[ia + 1]!, az = a[ia + 2]!
  const abx = a[ib]! - ax, aby = a[ib + 1]! - ay, abz = a[ib + 2]! - az
  const acx = a[ic]! - ax, acy = a[ic + 1]! - ay, acz = a[ic + 2]! - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz
  let u = 0, v = 0
  if (d1 <= 0 && d2 <= 0) (u = 0), (v = 0)
  else {
    const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz
    if (d3 >= 0 && d4 <= d3) (u = 1), (v = 0)
    else {
      const vc = d1 * d4 - d3 * d2
      if (vc <= 0 && d1 >= 0 && d3 <= 0) (u = d1 / (d1 - d3)), (v = 0)
      else {
        const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz
        if (d6 >= 0 && d5 <= d6) (u = 0), (v = 1)
        else {
          const vb = d5 * d2 - d1 * d6
          if (vb <= 0 && d2 >= 0 && d6 <= 0) (u = 0), (v = d2 / (d2 - d6))
          else {
            const va = d3 * d6 - d5 * d4
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
              ;(u = 1 - w), (v = w)
            } else {
              const den = 1 / (va + vb + vc)
              ;(u = vb * den), (v = vc * den)
            }
          }
        }
      }
    }
  }
  return Math.hypot(apx - u * abx - v * acx, apy - u * aby - v * acy, apz - u * abz - v * acz)
}

export function buildCavity(input: CavityInput): CavityResult | null {
  const { h, clearance } = input
  // 引导点（每 2 mm 一个）/ guide samples (one every 2 mm)
  const seedsAll: { p: V3; g: number }[] = []
  input.guides.forEach((g, gi) => {
    const n = g.pts.length / 3
    for (let i = 0; i < n; i++) {
      const a: V3 = [g.pts[3 * i]!, g.pts[3 * i + 1]!, g.pts[3 * i + 2]!]
      seedsAll.push({ p: a, g: gi })
      if (i + 1 < n) {
        const b: V3 = [g.pts[3 * i + 3]!, g.pts[3 * i + 4]!, g.pts[3 * i + 5]!]
        const m = Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.002)
        for (let q = 1; q <= m; q++) seedsAll.push({ p: [a[0] + ((b[0] - a[0]) * q) / (m + 1), a[1] + ((b[1] - a[1]) * q) / (m + 1), a[2] + ((b[2] - a[2]) * q) / (m + 1)], g: gi })
      }
    }
  })
  if (!seedsAll.length) return null
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (const s of seedsAll) for (let q = 0; q < 3; q++) {
    const R = input.guides[s.g]!.maxR + 3 * h
    lo[q] = Math.min(lo[q]!, s.p[q]! - R)
    hi[q] = Math.max(hi[q]!, s.p[q]! + R)
  }
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1
  const N = nx * ny * nz
  const at = (i: number, j: number, k: number): number => (k * ny + j) * nx + i
  const X = (i: number): number => lo[0] + i * h, Y = (j: number): number => lo[1] + j * h, Z = (k: number): number => lo[2] + k * h
  const T = 3 * h
  /** 把一张网格的距离写进场里（只在表面附近 T 之内） / splat the distance to a mesh into a field (only within T of its surface) */
  const splat = (mesh: Mesh, field: Float32Array): void => {
    const p = mesh.positions, idx = mesh.indices
    for (let t = 0; t < idx.length; t += 3) {
      const a = 3 * idx[t]!, b = 3 * idx[t + 1]!, c = 3 * idx[t + 2]!
      const r = (q: number, f: (...v: number[]) => number): number => f(p[a + q]!, p[b + q]!, p[c + q]!)
      const i0 = Math.max(0, Math.floor((r(0, Math.min) - T - lo[0]) / h)), i1 = Math.min(nx - 1, Math.ceil((r(0, Math.max) + T - lo[0]) / h))
      const j0 = Math.max(0, Math.floor((r(1, Math.min) - T - lo[1]) / h)), j1 = Math.min(ny - 1, Math.ceil((r(1, Math.max) + T - lo[1]) / h))
      const k0 = Math.max(0, Math.floor((r(2, Math.min) - T - lo[2]) / h)), k1 = Math.min(nz - 1, Math.ceil((r(2, Math.max) + T - lo[2]) / h))
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const d = pointTriangle(X(i), Y(j), Z(k), p, a, b, c)
        const q = at(i, j, k)
        if (d < field[q]!) field[q] = d
      }
    }
  }
  const dPart = new Float32Array(N).fill(T)
  const inside = new Uint8Array(N)
  for (const b of input.bounds) {
    splat(b.mesh, dPart)
    const p = b.mesh.positions
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let v = 0; v < p.length; v += 3) for (let q = 0; q < 3; q++) (bb[q] = Math.min(bb[q]!, p[v + q]!)), (bb[q + 3] = Math.max(bb[q + 3]!, p[v + q]!))
    const i0 = Math.max(0, Math.ceil((bb[0]! - lo[0]) / h)), i1 = Math.min(nx - 1, Math.floor((bb[3]! - lo[0]) / h))
    const j0 = Math.max(0, Math.ceil((bb[1]! - lo[1]) / h)), j1 = Math.min(ny - 1, Math.floor((bb[4]! - lo[1]) / h))
    const k0 = Math.max(0, Math.ceil((bb[2]! - lo[2]) / h)), k1 = Math.min(nz - 1, Math.floor((bb[5]! - lo[2]) / h))
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!inside[at(i, j, k)] && b.solid.contains(X(i), Y(j), Z(k))) inside[at(i, j, k)] = 1
  }
  const dSheet = input.sheets.map((s) => {
    const f = new Float32Array(N).fill(T)
    splat(s.mesh, f)
    return f
  })
  // 可用的引导点：自己是空的 / usable guide samples: those that are themselves free
  const freeAt = (x: number, y: number, z: number): boolean => {
    const i = Math.round((x - lo[0]) / h), j = Math.round((y - lo[1]) / h), k = Math.round((z - lo[2]) / h)
    if (i < 1 || j < 1 || k < 1 || i > nx - 2 || j > ny - 2 || k > nz - 2) return false
    return cand[at(i, j, k)] === 1
  }
  const need = clearance + h / 2
  const cand = new Uint8Array(N)
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const q = at(i, j, k)
    if (inside[q] || dPart[q]! < need) continue
    let ok = true
    for (let s = 0; s < dSheet.length && ok; s++) if (dSheet[s]![q]! < input.sheets[s]!.half) ok = false
    for (const pl of input.planes) if ((X(i) - pl.p[0]) * pl.n[0] + (Y(j) - pl.p[1]) * pl.n[1] + (Z(k) - pl.p[2]) * pl.n[2] >= 0) ok = false
    if (ok) cand[q] = 1
  }
  const seeds = seedsAll.filter((s) => freeAt(s.p[0], s.p[1], s.p[2]))
  if (seeds.length < 3) return null
  // 每个格点最近的可用引导点；在可及范围内且看得见才算 / the nearest usable guide sample of every node; it counts when within reach and visible
  const seedOf = new Int32Array(N).fill(-1)
  const vis = new Uint8Array(N)
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const q = at(i, j, k)
    const x = X(i), y = Y(j), z = Z(k)
    let best = -1, bd = Infinity
    for (let s = 0; s < seeds.length; s++) {
      const p = seeds[s]!.p
      const d = (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y) + (p[2] - z) * (p[2] - z)
      if (d < bd) (bd = d), (best = s)
    }
    seedOf[q] = best
    if (!cand[q]) continue
    const dist = Math.sqrt(bd)
    if (dist > input.guides[seeds[best]!.g]!.maxR) continue
    const p = seeds[best]!.p
    const steps = Math.ceil(dist / (h / 2))
    let ok = true
    for (let s = 1; s < steps && ok; s++) if (!freeAt(x + ((p[0] - x) * s) / steps, y + ((p[1] - y) * s) / steps, z + ((p[2] - z) * s) / steps)) ok = false
    if (ok) vis[q] = 1
  }
  // 开运算：腐蚀一格，取含引导点的连通块，再在看得见的范围内膨胀一格
  // the opening: erode by one node, keep the component holding the guide, dilate by one node within the visible set
  const nb6 = [1, -1, nx, -nx, nx * ny, -nx * ny]
  const er = new Uint8Array(N)
  for (let q = 0; q < N; q++) if (vis[q]) {
    let all = true
    for (const d of nb6) if (!vis[q + d]) all = false
    if (all) er[q] = 1
  }
  const comp = new Uint8Array(N)
  const stack: number[] = []
  for (const s of seeds) {
    const q = at(Math.round((s.p[0] - lo[0]) / h), Math.round((s.p[1] - lo[1]) / h), Math.round((s.p[2] - lo[2]) / h))
    if (er[q] && !comp[q]) (comp[q] = 1), stack.push(q)
  }
  while (stack.length) {
    const q = stack.pop()!
    for (const d of nb6) if (er[q + d] && !comp[q + d]) (comp[q + d] = 1), stack.push(q + d)
  }
  const F = new Float32Array(N)
  let voxels = 0
  for (let q = 0; q < N; q++) {
    if (!vis[q]) continue
    let on = comp[q] === 1
    if (!on) for (const d of nb6) if (comp[q + d]) on = true
    if (on) (F[q] = 1), voxels++
  }
  // 引导线周围 3 mm 之内的空格点也算腔（不经开运算）：部件之间的缝比网格能分辨的还窄的地方（喉后面的下咽），腔不至于断开。
  // 这些格点仍然必须是空的；部件贴在一起、连一个空格点都没有的地方，腔在那里断开，报告里写明。
  // Free nodes within 3 mm of the guide line also belong to the cavity (bypassing the opening): where the
  // gap between parts is narrower than the grid resolves (the hypopharynx behind the larynx) the cavity
  // does not break. Such nodes must still be free; where parts touch and no free node is left the
  // cavity is interrupted there, and the report says so.
  let tubeVoxels = 0
  const guideBlocked: number[] = []
  for (const s of seedsAll) {
    const ci = Math.round((s.p[0] - lo[0]) / h), cj = Math.round((s.p[1] - lo[1]) / h), ck = Math.round((s.p[2] - lo[2]) / h)
    let any = false
    for (let k = ck - 2; k <= ck + 2; k++) for (let j = cj - 2; j <= cj + 2; j++) for (let i = ci - 2; i <= ci + 2; i++) {
      if (i < 1 || j < 1 || k < 1 || i > nx - 2 || j > ny - 2 || k > nz - 2) continue
      const q = at(i, j, k)
      if (!cand[q] || Math.hypot(X(i) - s.p[0], Y(j) - s.p[1], Z(k) - s.p[2]) > 0.003) continue
      any = true
      if (!F[q]) (F[q] = 1), tubeVoxels++, voxels++
    }
    if (!any) guideBlocked.push(Math.round(s.p[1] * 1e4) / 10)
  }
  if (voxels < 20) return null
  // 模糊一遍（三个方向各 1-2-1） / one blur (1-2-1 along each axis)
  for (const d of [1, nx, nx * ny]) {
    const src = F.slice()
    for (let q = d; q < N - d; q++) F[q] = 0.5 * src[q]! + 0.25 * (src[q - d]! + src[q + d]!)
  }
  // 行进四面体 / marching tetrahedra
  const cornerOff = [0, 1, 1 + nx, nx, nx * ny, 1 + nx * ny, 1 + nx + nx * ny, nx + nx * ny]
  const tets = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]]
  const pos: number[] = []
  const tri: number[] = []
  const edgeVertex = new Map<number, number>()
  const nodePos = (q: number): V3 => [X(q % nx), Y(Math.floor(q / nx) % ny), Z(Math.floor(q / (nx * ny)))]
  const vertexOn = (a: number, b: number): number => {
    const key = a < b ? a * N + b : b * N + a
    let v = edgeVertex.get(key)
    if (v === undefined) {
      const fa = F[a]!, fb = F[b]!
      const u = (0.5 - fa) / (fb - fa)
      const pa = nodePos(a), pb = nodePos(b)
      v = pos.length / 3
      pos.push(pa[0] + u * (pb[0] - pa[0]), pa[1] + u * (pb[1] - pa[1]), pa[2] + u * (pb[2] - pa[2]))
      edgeVertex.set(key, v)
    }
    return v
  }
  const emit = (a: number, b: number, c: number, from: number, to: number): void => {
    // 法线朝外：从腔内的格点指向腔外的格点 / normal outward: from an inside node toward an outside node
    const A = [pos[3 * a]!, pos[3 * a + 1]!, pos[3 * a + 2]!], B = [pos[3 * b]!, pos[3 * b + 1]!, pos[3 * b + 2]!], C = [pos[3 * c]!, pos[3 * c + 1]!, pos[3 * c + 2]!]
    const nxx = (B[1]! - A[1]!) * (C[2]! - A[2]!) - (B[2]! - A[2]!) * (C[1]! - A[1]!), nyy = (B[2]! - A[2]!) * (C[0]! - A[0]!) - (B[0]! - A[0]!) * (C[2]! - A[2]!), nzz = (B[0]! - A[0]!) * (C[1]! - A[1]!) - (B[1]! - A[1]!) * (C[0]! - A[0]!)
    const pf = nodePos(from), pt = nodePos(to)
    if (nxx * (pt[0] - pf[0]) + nyy * (pt[1] - pf[1]) + nzz * (pt[2] - pf[2]) >= 0) tri.push(a, b, c)
    else tri.push(a, c, b)
  }
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const base = at(i, j, k)
    let any = false, all = true
    for (const o of cornerOff) F[base + o]! > 0.5 ? (any = true) : (all = false)
    if (!any || all) continue
    for (const t of tets) {
      const n = t.map((c) => base + cornerOff[c]!)
      const inn = n.filter((q) => F[q]! > 0.5), out = n.filter((q) => !(F[q]! > 0.5))
      if (inn.length === 1) emit(vertexOn(inn[0]!, out[0]!), vertexOn(inn[0]!, out[1]!), vertexOn(inn[0]!, out[2]!), inn[0]!, out[0]!)
      else if (inn.length === 3) emit(vertexOn(out[0]!, inn[0]!), vertexOn(out[0]!, inn[1]!), vertexOn(out[0]!, inn[2]!), inn[0]!, out[0]!)
      else if (inn.length === 2) {
        const a = vertexOn(inn[0]!, out[0]!), b = vertexOn(inn[0]!, out[1]!), c = vertexOn(inn[1]!, out[1]!), d = vertexOn(inn[1]!, out[0]!)
        emit(a, b, c, inn[0]!, out[0]!)
        emit(a, c, d, inn[0]!, out[0]!)
      }
    }
  }
  const nv = pos.length / 3
  // 每个顶点的归属 / what every vertex lies against
  const origin = new Uint8Array(nv).fill(1)
  const reason = new Uint8Array(nv)
  const REASONS = ['against a real part', 'beyond the reach of the guide line', 'cut plane', 'constructed closure', 'not visible from the guide line or removed as a thin sheet', 'marked opening']
  const reasonName: string[] = new Array(nv).fill('')
  const centres = new Float32Array(nv * 3)
  const regionOf = new Int32Array(nv)
  for (let v = 0; v < nv; v++) {
    const x = pos[3 * v]!, y = pos[3 * v + 1]!, z = pos[3 * v + 2]!
    const q = at(Math.round((x - lo[0]) / h), Math.round((y - lo[1]) / h), Math.round((z - lo[2]) / h))
    const s = seeds[Math.max(0, seedOf[q]!)]!
    centres.set(s.p, 3 * v)
    regionOf[v] = s.g
    let near = dPart[q]!
    for (const d of nb6) near = Math.min(near, dPart[q + d] ?? T)
    if (near < need + h || inside[q]) {
      origin[v] = 2
      reasonName[v] = REASONS[0]!
      continue
    }
    let r = 4, name = REASONS[4]!
    const dist = Math.hypot(x - s.p[0], y - s.p[1], z - s.p[2])
    if (dist > input.guides[s.g]!.maxR - 1.5 * h) (r = 1), (name = REASONS[1]!)
    for (let si = 0; si < dSheet.length; si++) if (dSheet[si]![q]! < input.sheets[si]!.half + 1.5 * h) (r = 3), (name = `${REASONS[3]}: ${input.sheets[si]!.name}`)
    for (const pl of input.planes) if (Math.abs((x - pl.p[0]) * pl.n[0] + (y - pl.p[1]) * pl.n[1] + (z - pl.p[2]) * pl.n[2]) < 1.5 * h) (r = 2), (name = `${REASONS[2]}: ${pl.name}`)
    for (const m of input.marks) if (Math.hypot(x - m.p[0], y - m.p[1], z - m.p[2]) < m.r) (r = 5), (name = `${REASONS[5]}: ${m.name}`)
    reason[v] = r
    reasonName[v] = name
  }
  const whole: Mesh = { positions: Float32Array.from(pos), indices: Uint32Array.from(tri) }
  // 面积按归属，体积，按引导线分成几个部件 / area by what it lies against, the volume, and the split by guide into parts
  const areaBy: Record<string, number> = {}
  let volume = 0
  const triRegion = new Int32Array(tri.length / 3)
  const volBy = new Float64Array(input.guides.length)
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t]!, b = tri[t + 1]!, c = tri[t + 2]!
    const A = [pos[3 * a]!, pos[3 * a + 1]!, pos[3 * a + 2]!], B = [pos[3 * b]!, pos[3 * b + 1]!, pos[3 * b + 2]!], C = [pos[3 * c]!, pos[3 * c + 1]!, pos[3 * c + 2]!]
    const cx = (B[1]! - A[1]!) * (C[2]! - A[2]!) - (B[2]! - A[2]!) * (C[1]! - A[1]!), cy = (B[2]! - A[2]!) * (C[0]! - A[0]!) - (B[0]! - A[0]!) * (C[2]! - A[2]!), cz = (B[0]! - A[0]!) * (C[1]! - A[1]!) - (B[1]! - A[1]!) * (C[0]! - A[0]!)
    const area = 0.5 * Math.hypot(cx, cy, cz)
    const names = [reasonName[a]!, reasonName[b]!, reasonName[c]!]
    const name = names.find((n) => n !== REASONS[0]) ?? REASONS[0]!
    areaBy[name] = (areaBy[name] ?? 0) + area
    volume += (A[0]! * cx + A[1]! * cy + A[2]! * cz) / 6
    triRegion[t / 3] = regionOf[a]!
  }
  for (let q = 0; q < N; q++) if (F[q]! > 0.5 && seedOf[q]! >= 0) volBy[seeds[seedOf[q]!]!.g] = volBy[seeds[seedOf[q]!]!.g]! + h * h * h
  const parts: CavityPart[] = input.guides.map((g, gi) => {
    const map = new Map<number, number>()
    const pp: number[] = [], ii: number[] = [], oo: number[] = [], cc: number[] = []
    for (let t = 0; t < tri.length; t += 3) {
      if (triRegion[t / 3] !== gi) continue
      for (let e = 0; e < 3; e++) {
        const v = tri[t + e]!
        let w = map.get(v)
        if (w === undefined) {
          w = pp.length / 3
          map.set(v, w)
          pp.push(pos[3 * v]!, pos[3 * v + 1]!, pos[3 * v + 2]!)
          oo.push(origin[v]!)
          cc.push(centres[3 * v]!, centres[3 * v + 1]!, centres[3 * v + 2]!)
        }
        ii.push(w)
      }
    }
    return { key: g.key, mesh: { positions: Float32Array.from(pp), indices: Uint32Array.from(ii) }, origin: Uint8Array.from(oo), centres: Float32Array.from(cc), volumeCm3: volBy[gi]! * 1e6 }
  })
  let insideParts = 0
  for (let v = 0; v < nv; v++) if (input.bounds.some((b) => b.solid.contains(pos[3 * v]!, pos[3 * v + 1]!, pos[3 * v + 2]!))) insideParts++
  const r1 = (x: number): number => Math.round(x * 10) / 10
  return {
    parts, whole,
    report: {
      method: 'free space between the real parts sampled on a voxel grid, limited to what is within reach of and visible from the guide line, opened by one voxel, blurred once and extracted as the 0.5 isosurface by marching tetrahedra',
      voxelMm: h * 1000, clearanceMm: r1((clearance + h / 2) * 1000), clearanceNote: 'a node is free when at least the stated clearance plus half a voxel from every part surface',
      grid: [nx, ny, nz], guideSamples: seedsAll.length, guideSamplesFree: seeds.length, voxels, volumeCm3: r1(volume * 1e6), vertices: nv, triangles: tri.length / 3,
      closedSurface: true, verticesInsideABoundingPart: insideParts, voxelsAddedAlongTheGuide: tubeVoxels, guideSamplesWithNoFreeNodeWithin3mm: { count: guideBlocked.length, heightsMm: guideBlocked.slice(0, 40) },
      surfaceAreaCm2: Object.fromEntries(Object.entries(areaBy).map(([k, v]) => [k, r1(v * 1e4)])),
      thinSpacesLost: `spaces thinner than about ${r1(3 * h * 1000)} mm are removed by the opening and are not part of the surface`,
    },
  }
}
