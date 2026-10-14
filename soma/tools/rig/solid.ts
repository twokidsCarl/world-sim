// 三角网格的几何查询：封闭网格（骨）是否封闭、点在里面还是外面、表面上的最近点；任意网格（皮肤，可有开口）上的最近点和带符号的距离。
// via-check.ts 的门槛和 viapush.ts 的烘焙共用。
// Geometric queries on triangle meshes: for a closed mesh (a bone), whether it is closed, whether a point is inside, and the
// nearest point of the surface; for any mesh (the skin, which may have openings), the nearest point and a signed distance.
// Shared by the gate in via-check.ts and the bake in viapush.ts.

import { BufferAttribute, BufferGeometry, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { type V3, cross } from './math.ts'

/**
 * 三角网格是否封闭：每条无向边恰好属于两个三角形，并且两次的走向相反（法线方向一致）。返回问题描述，封闭时为 null。
 * Whether a triangle mesh is closed: every undirected edge belongs to exactly two triangles, run in opposite directions
 * (consistent normals). Returns a description of the problem, null when closed.
 */
export function closedProblem(indices: ArrayLike<number>): string | null {
  const directed = new Map<string, number>()
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e]!, b = indices[t + ((e + 1) % 3)]!
      if (a === b) return `degenerate triangle ${t / 3}`
      const k = `${a},${b}`
      directed.set(k, (directed.get(k) ?? 0) + 1)
    }
  }
  for (const [k, n] of directed) {
    const [a, b] = k.split(',')
    if (n !== 1) return `edge ${k} used ${n} times in the same direction`
    if (directed.get(`${b},${a}`) !== 1) return `edge ${k} has no opposite (open boundary)`
  }
  return null
}

/**
 * 封闭网格：内外判断和最近点。内外：沿 +x、+y、+z 三条射线数穿过的三角形个数，奇数为里面，三票取多数
 * （单条射线恰好擦过边或顶点时不至于判错）；每个方向用一张投影网格加速。
 * A closed mesh: inside test and nearest point. Inside: count the triangles crossed by rays along +x, +y and +z; odd
 * means inside, and the majority of the three votes decides (so a single ray that happens to graze an edge or a vertex
 * cannot decide alone). Each direction is sped up by a grid over the projection.
 */
export class Solid {
  readonly box: [number, number, number, number, number, number]
  private readonly grids: { u: number; v: number; n: number; lo: [number, number]; step: [number, number]; cells: number[][] }[] = []

  /** `p`：顶点坐标（扁平 xyz），`idx`：三角形下标；网格须封闭（见 closedProblem）/ `p`: vertex coordinates (flat xyz), `idx`: triangle indices; the mesh must be closed (see closedProblem). */
  constructor(readonly p: Float64Array, readonly idx: ArrayLike<number>) {
    const box: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) (box[c] = Math.min(box[c]!, p[i + c]!)), (box[c + 3] = Math.max(box[c + 3]!, p[i + c]!))
    this.box = box
    const n = 24
    for (let a = 0; a < 3; a++) {
      const u = (a + 1) % 3, v = (a + 2) % 3
      const lo: [number, number] = [box[u]!, box[v]!]
      const step: [number, number] = [Math.max(1e-9, (box[u + 3]! - box[u]!) / n), Math.max(1e-9, (box[v + 3]! - box[v]!) / n)]
      const cells: number[][] = Array.from({ length: n * n }, () => [])
      const cell = (x: number, s: 0 | 1): number => Math.min(n - 1, Math.max(0, Math.floor((x - lo[s]) / step[s])))
      for (let t = 0; t < idx.length; t += 3) {
        const us = [0, 1, 2].map((k) => p[idx[t + k]! * 3 + u]!), vs = [0, 1, 2].map((k) => p[idx[t + k]! * 3 + v]!)
        const u0 = cell(Math.min(...us), 0), u1 = cell(Math.max(...us), 0), v0 = cell(Math.min(...vs), 1), v1 = cell(Math.max(...vs), 1)
        for (let i = u0; i <= u1; i++) for (let j = v0; j <= v1; j++) cells[i * n + j]!.push(t)
      }
      this.grids.push({ u, v, n, lo, step, cells })
    }
  }

  /** 点是否在网格里面 / Whether the point is inside the mesh. */
  contains(x: number, y: number, z: number): boolean {
    const b = this.box
    if (x < b[0] || y < b[1] || z < b[2] || x > b[3] || y > b[4] || z > b[5]) return false
    const q = [x, y, z]
    const p = this.p, idx = this.idx
    let votes = 0
    for (let a = 0; a < 3; a++) {
      const g = this.grids[a]!
      const pu = q[g.u]!, pv = q[g.v]!, pa = q[a]!
      const i = Math.min(g.n - 1, Math.max(0, Math.floor((pu - g.lo[0]) / g.step[0]))), j = Math.min(g.n - 1, Math.max(0, Math.floor((pv - g.lo[1]) / g.step[1])))
      let crossings = 0
      for (const t of g.cells[i * g.n + j]!) {
        const A = idx[t]! * 3, B = idx[t + 1]! * 3, C = idx[t + 2]! * 3
        const au = p[A + g.u]!, av = p[A + g.v]!, bu = p[B + g.u]!, bv = p[B + g.v]!, cu = p[C + g.u]!, cv = p[C + g.v]!
        const d = (bu - au) * (cv - av) - (bv - av) * (cu - au)
        if (Math.abs(d) < 1e-18) continue
        const w1 = ((bu - pu) * (cv - pv) - (bv - pv) * (cu - pu)) / d
        const w2 = ((cu - pu) * (av - pv) - (cv - pv) * (au - pu)) / d
        const w3 = 1 - w1 - w2
        if (w1 < 0 || w2 < 0 || w3 < 0) continue
        if (w1 * p[A + a]! + w2 * p[B + a]! + w3 * p[C + a]! > pa) crossings++
      }
      if (crossings & 1) votes++
    }
    return votes >= 2
  }

  /** 表面上离 q 最近的点（逐个三角形）/ The point of the surface nearest to q (triangle by triangle). */
  closest(q: V3): V3 {
    const p = this.p, idx = this.idx
    let best = Infinity, at: V3 = q
    for (let t = 0; t < idx.length; t += 3) {
      const A = idx[t]! * 3, B = idx[t + 1]! * 3, C = idx[t + 2]! * 3
      const c = closestOnTriangle(q, [p[A]!, p[A + 1]!, p[A + 2]!], [p[B]!, p[B + 1]!, p[B + 2]!], [p[C]!, p[C + 1]!, p[C + 2]!])
      const d = (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2
      if (d < best) (best = d), (at = c)
    }
    return at
  }
}

/** 三角形上离 p 最近的点（Ericson《实时碰撞检测》5.1.5）/ The point of a triangle nearest to p (Ericson, Real-Time Collision Detection, 5.1.5). */
export function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const dot = (x: V3, y: V3): number => x[0] * y[0] + x[1] * y[1] + x[2] * y[2]
  const ap: V3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp: V3 = [p[0] - b[0], p[1] - b[1], p[2] - b[2]]
  const d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]
  }
  const cp: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]
  const d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6))
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]
}

/** 一组三角网格上的最近点查询 / Nearest-point queries on a set of triangle meshes. */
export class Surface {
  private readonly bvh: MeshBVH
  private readonly n: Float64Array
  private readonly idx: Uint32Array
  private readonly hit: { point: Vector3; distance: number; faceIndex: number } = { point: new Vector3(), distance: 0, faceIndex: 0 }
  private readonly q = new Vector3()
  constructor(meshes: { positions: ArrayLike<number>; indices: ArrayLike<number> }[]) {
    const nv = meshes.reduce((t, m) => t + m.positions.length, 0), ni = meshes.reduce((t, m) => t + m.indices.length, 0)
    const pos = new Float32Array(nv), idx = new Uint32Array(ni)
    let pv = 0, pi = 0
    for (const m of meshes) {
      pos.set(m.positions, pv)
      for (let i = 0; i < m.indices.length; i++) idx[pi + i] = m.indices[i]! + pv / 3
      pv += m.positions.length
      pi += m.indices.length
    }
    // 面积加权的顶点法线（用来定皮肤的内外）/ area-weighted vertex normals (to tell the sides of the skin)
    const n = new Float64Array(nv)
    for (let t = 0; t < ni; t += 3) {
      const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3
      const f = cross([pos[b]! - pos[a]!, pos[b + 1]! - pos[a + 1]!, pos[b + 2]! - pos[a + 2]!], [pos[c]! - pos[a]!, pos[c + 1]! - pos[a + 1]!, pos[c + 2]! - pos[a + 2]!])
      for (const i of [a, b, c]) for (let k = 0; k < 3; k++) n[i + k] = n[i + k]! + f[k]!
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setIndex(new BufferAttribute(idx, 1))
    this.bvh = new MeshBVH(g)
    this.n = n
    this.idx = idx
  }
  /** 到表面的距离（米）/ Distance to the surface (m). */
  distance(x: number, y: number, z: number): number {
    return this.bvh.closestPointToPoint(this.q.set(x, y, z), this.hit as never)!.distance
  }
  /** 最近点（米）/ The nearest point (m). */
  nearest(x: number, y: number, z: number): V3 {
    const h = this.bvh.closestPointToPoint(this.q.set(x, y, z), this.hit as never)!
    return [h.point.x, h.point.y, h.point.z]
  }
  /** 带符号的距离：在法线一侧（外面）为正 / Signed distance: positive on the side of the normals (outside). */
  signed(x: number, y: number, z: number): number {
    const h = this.bvh.closestPointToPoint(this.q.set(x, y, z), this.hit as never)!
    const t = h.faceIndex * 3, n = this.n
    let s = 0
    for (const i of [this.idx[t]!, this.idx[t + 1]!, this.idx[t + 2]!]) s += (x - h.point.x) * n[i * 3]! + (y - h.point.y) * n[i * 3 + 1]! + (z - h.point.z) * n[i * 3 + 2]!
    return s > 0 ? h.distance : -h.distance
  }
}
