// 布料的碰撞体：三角网格（人体皮肤）、平面、圆盘（垂坠测试的托盘）。
// 都实现 solver.ts 的 Collider：把进入表面 margin 以内的粒子沿外法线推出，再按库仑定律做位置上的摩擦
// （Macklin 等 2014，“Unified Particle Physics for Real-Time Applications”，第 6.1 节）。
// Colliders for the cloth: a triangle mesh (the body's skin), a plane and a disc (the drape tester's
// pedestal). All implement solver.ts's Collider: particles within `margin` of the surface are pushed
// out along the outward normal, then Coulomb friction is applied on positions (Macklin et al. 2014,
// "Unified Particle Physics for Real-Time Applications", section 6.1).

import type { Collider } from './solver.ts'

/** 位置上的摩擦：depth 是本次法向修正量 / Positional friction; `depth` is this normal correction. */
function friction(x: Float64Array, prev: Float64Array, k: number, nx: number, ny: number, nz: number, depth: number, mu: number): void {
  if (mu <= 0 || depth <= 0) return
  const dx = x[k]! - prev[k]!, dy = x[k + 1]! - prev[k + 1]!, dz = x[k + 2]! - prev[k + 2]!
  const dn = dx * nx + dy * ny + dz * nz
  const tx = dx - dn * nx, ty = dy - dn * ny, tz = dz - dn * nz
  const t = Math.hypot(tx, ty, tz)
  if (t < 1e-12) return
  const s = Math.min(1, (mu * depth) / t)
  x[k] = x[k]! - tx * s
  x[k + 1] = x[k + 1]! - ty * s
  x[k + 2] = x[k + 2]! - tz * s
}

/** 平面 n·x = d，法线指向外侧 / The plane n·x = d, normal pointing outside. */
export class PlaneCollider implements Collider {
  constructor(readonly n: [number, number, number], readonly d: number) {}
  resolve(x: Float64Array, prev: Float64Array, w: Float64Array, margin: number, mu: number): void {
    const [nx, ny, nz] = this.n
    for (let i = 0; i < w.length; i++) {
      if (w[i] === 0) continue
      const k = i * 3
      const s = x[k]! * nx + x[k + 1]! * ny + x[k + 2]! * nz - this.d
      if (s >= margin) continue
      const depth = margin - s
      x[k] = x[k]! + nx * depth
      x[k + 1] = x[k + 1]! + ny * depth
      x[k + 2] = x[k + 2]! + nz * depth
      friction(x, prev, k, nx, ny, nz, depth, mu)
    }
  }
}

/** 水平圆盘（竖直轴圆柱，顶面在 top，边缘倒圆 edge）/ A horizontal disc: a vertical-axis cylinder, top face at `top`, edge rounded by `edge`. */
export class DiscCollider implements Collider {
  constructor(readonly cx: number, readonly cz: number, readonly radius: number, readonly top: number, readonly height = 0.05, readonly edge = 0.002) {}
  resolve(x: Float64Array, prev: Float64Array, w: Float64Array, margin: number, mu: number): void {
    const { cx, cz, radius, top, height, edge } = this
    for (let i = 0; i < w.length; i++) {
      if (w[i] === 0) continue
      const k = i * 3
      const px = x[k]! - cx, py = x[k + 1]! - (top - height / 2), pz = x[k + 2]! - cz
      // 圆角圆柱的有向距离 / signed distance of a rounded cylinder
      const r = Math.hypot(px, pz)
      const qx = r - (radius - edge), qy = Math.abs(py) - (height / 2 - edge)
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0)
      const sd = Math.min(Math.max(qx, qy), 0) + Math.hypot(ox, oy) - edge
      if (sd >= margin) continue
      // 法线：对 (r, |y|) 的梯度 / normal: the gradient over (r, |y|)
      let gr: number, gy: number
      if (qx > 0 && qy > 0) {
        const l = Math.hypot(ox, oy)
        gr = ox / l
        gy = oy / l
      } else if (qx > qy) {
        gr = 1
        gy = 0
      } else {
        gr = 0
        gy = 1
      }
      const sy = py >= 0 ? 1 : -1
      const nx = r > 1e-9 ? (gr * px) / r : 0, nz = r > 1e-9 ? (gr * pz) / r : 0, ny = gy * sy
      const depth = margin - sd
      x[k] = x[k]! + nx * depth
      x[k + 1] = x[k + 1]! + ny * depth
      x[k + 2] = x[k + 2]! + nz * depth
      friction(x, prev, k, nx, ny, nz, depth, mu)
    }
  }
}

/** 最近点查询的结果 / Result of a closest-point query. */
export interface Closest {
  tri: number
  /** 最近点的重心坐标（对三角形的三个顶点）/ Barycentrics of the closest point (over the triangle's corners). */
  b0: number
  b1: number
  b2: number
  /** 沿插值法线的有向距离（外正内负）/ Signed distance along the interpolated normal (outside positive). */
  signed: number
  qx: number
  qy: number
  qz: number
  nx: number
  ny: number
  nz: number
}

/**
 * 三角网格碰撞体：三角形按包围盒（外扩 reach）放进均匀网格的哈希表，查询只看点所在的一格。
 * 有向距离取最近点处插值顶点法线的方向，网格须封闭、法线朝外（我们的皮肤是）。
 * A triangle-mesh collider: triangles go into a hashed uniform grid by their bounding box widened by
 * `reach`, so a query looks at the point's own cell only. The sign comes from the vertex normal
 * interpolated at the closest point; the mesh must be closed with outward normals (our skin is).
 */
export class MeshCollider implements Collider {
  pos: Float64Array
  readonly index: Uint32Array
  readonly normal: Float64Array
  readonly cell: number
  readonly reach: number
  private tableSize = 1
  private cellStart = new Int32Array(1)
  private entries = new Int32Array(0)
  /** 只让这些粒子参与（null = 全部）/ Only these particles take part (null = all). */
  mask: Uint8Array | null = null
  /** 最近一次 resolve 中被推出的粒子数 / Particles pushed out in the latest resolve. */
  contacts = 0

  constructor(positions: ArrayLike<number>, index: ArrayLike<number>, cell = 0.02, reach = 0.02) {
    this.pos = Float64Array.from(positions)
    this.index = Uint32Array.from(index)
    this.normal = new Float64Array(this.pos.length)
    this.cell = cell
    this.reach = reach
    this.update(positions)
  }

  /** 皮肤移动了：更新顶点、法线和哈希 / The skin moved: update vertices, normals and the hash. */
  update(positions: ArrayLike<number>): void {
    if (positions !== this.pos) this.pos.set(positions)
    this.computeNormals()
    this.build()
  }

  private computeNormals(): void {
    const { pos: p, index: I, normal: N } = this
    N.fill(0)
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t]! * 3, b = I[t + 1]! * 3, c = I[t + 2]! * 3
      const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!
      const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      for (const k of [a, b, c]) {
        N[k] = N[k]! + nx
        N[k + 1] = N[k + 1]! + ny
        N[k + 2] = N[k + 2]! + nz
      }
    }
    for (let k = 0; k < N.length; k += 3) {
      const l = Math.hypot(N[k]!, N[k + 1]!, N[k + 2]!) || 1
      N[k] = N[k]! / l
      N[k + 1] = N[k + 1]! / l
      N[k + 2] = N[k + 2]! / l
    }
  }

  private hash(xi: number, yi: number, zi: number): number {
    const h = Math.imul(xi, 92837111) ^ Math.imul(yi, 689287499) ^ Math.imul(zi, 283923481)
    return Math.abs(h) % this.tableSize
  }

  private forCells(t: number, f: (h: number) => void): void {
    const { pos: p, index: I, cell, reach } = this
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity
    for (let q = 0; q < 3; q++) {
      const k = I[t * 3 + q]! * 3
      lx = Math.min(lx, p[k]!)
      ly = Math.min(ly, p[k + 1]!)
      lz = Math.min(lz, p[k + 2]!)
      hx = Math.max(hx, p[k]!)
      hy = Math.max(hy, p[k + 1]!)
      hz = Math.max(hz, p[k + 2]!)
    }
    const x0 = Math.floor((lx - reach) / cell), x1 = Math.floor((hx + reach) / cell)
    const y0 = Math.floor((ly - reach) / cell), y1 = Math.floor((hy + reach) / cell)
    const z0 = Math.floor((lz - reach) / cell), z1 = Math.floor((hz + reach) / cell)
    for (let xi = x0; xi <= x1; xi++) for (let yi = y0; yi <= y1; yi++) for (let zi = z0; zi <= z1; zi++) f(this.hash(xi, yi, zi))
  }

  private build(): void {
    const nt = this.index.length / 3
    this.tableSize = Math.max(1024, nt * 8)
    if (this.cellStart.length !== this.tableSize + 1) this.cellStart = new Int32Array(this.tableSize + 1)
    const start = this.cellStart
    start.fill(0)
    let total = 0
    for (let t = 0; t < nt; t++) this.forCells(t, (h) => {
      start[h]!++
      total++
    })
    let acc = 0
    for (let i = 0; i < this.tableSize; i++) {
      acc += start[i]!
      start[i] = acc
    }
    start[this.tableSize] = acc
    if (this.entries.length < total) this.entries = new Int32Array(total)
    const e = this.entries
    for (let t = 0; t < nt; t++) this.forCells(t, (h) => {
      start[h]!--
      e[start[h]!] = t
    })
  }

  /**
   * 离点最近的三角形（只在 reach 以内找）；找不到返回 false。
   * The triangle closest to a point (searched within `reach` only); false when none is found.
   */
  closest(px: number, py: number, pz: number, out: Closest): boolean {
    const h = this.hash(Math.floor(px / this.cell), Math.floor(py / this.cell), Math.floor(pz / this.cell))
    const { pos: p, index: I, entries } = this
    let best = Infinity
    let found = false
    for (let j = this.cellStart[h]!; j < this.cellStart[h + 1]!; j++) {
      const t = entries[j]!
      const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3
      // Ericson，《Real-Time Collision Detection》5.1.5 / Ericson, Real-Time Collision Detection 5.1.5
      const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!
      const abx = p[b]! - ax, aby = p[b + 1]! - ay, abz = p[b + 2]! - az
      const acx = p[c]! - ax, acy = p[c + 1]! - ay, acz = p[c + 2]! - az
      const apx = px - ax, apy = py - ay, apz = pz - az
      const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz
      let u: number, v: number
      if (d1 <= 0 && d2 <= 0) {
        u = 0
        v = 0
      } else {
        const bpx = px - p[b]!, bpy = py - p[b + 1]!, bpz = pz - p[b + 2]!
        const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz
        if (d3 >= 0 && d4 <= d3) {
          u = 1
          v = 0
        } else {
          const vc = d1 * d4 - d3 * d2
          if (vc <= 0 && d1 >= 0 && d3 <= 0) {
            u = d1 / (d1 - d3)
            v = 0
          } else {
            const cpx = px - p[c]!, cpy = py - p[c + 1]!, cpz = pz - p[c + 2]!
            const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz
            if (d6 >= 0 && d5 <= d6) {
              u = 0
              v = 1
            } else {
              const vb = d5 * d2 - d1 * d6
              if (vb <= 0 && d2 >= 0 && d6 <= 0) {
                u = 0
                v = d2 / (d2 - d6)
              } else {
                const va = d3 * d6 - d5 * d4
                if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                  const s = (d4 - d3) / (d4 - d3 + (d5 - d6))
                  u = 1 - s
                  v = s
                } else {
                  const den = 1 / (va + vb + vc)
                  u = vb * den
                  v = vc * den
                }
              }
            }
          }
        }
      }
      const qx = ax + abx * u + acx * v, qy = ay + aby * u + acy * v, qz = az + abz * u + acz * v
      const d = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2
      if (d < best) {
        best = d
        found = true
        out.tri = t
        out.b0 = 1 - u - v
        out.b1 = u
        out.b2 = v
        out.qx = qx
        out.qy = qy
        out.qz = qz
      }
    }
    if (!found || best > this.reach * this.reach) return false
    const N = this.normal
    const a = I[out.tri * 3]! * 3, b = I[out.tri * 3 + 1]! * 3, c = I[out.tri * 3 + 2]! * 3
    let nx = N[a]! * out.b0 + N[b]! * out.b1 + N[c]! * out.b2
    let ny = N[a + 1]! * out.b0 + N[b + 1]! * out.b1 + N[c + 1]! * out.b2
    let nz = N[a + 2]! * out.b0 + N[b + 2]! * out.b1 + N[c + 2]! * out.b2
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l
    ny /= l
    nz /= l
    out.nx = nx
    out.ny = ny
    out.nz = nz
    const dist = Math.sqrt(best)
    const side = (px - out.qx) * nx + (py - out.qy) * ny + (pz - out.qz) * nz
    out.signed = side >= 0 ? dist : -dist
    return true
  }

  resolve(x: Float64Array, prev: Float64Array, w: Float64Array, margin: number, mu: number): void {
    const c: Closest = { tri: 0, b0: 0, b1: 0, b2: 0, signed: 0, qx: 0, qy: 0, qz: 0, nx: 0, ny: 0, nz: 0 }
    let contacts = 0
    for (let i = 0; i < w.length; i++) {
      if (w[i] === 0 || (this.mask && !this.mask[i])) continue
      const k = i * 3
      if (!this.closest(x[k]!, x[k + 1]!, x[k + 2]!, c)) continue
      if (c.signed >= margin) continue
      // 推到最近点外侧 margin 处：在外面时沿“最近点 → 粒子”方向，在里面时沿插值法线
      // pushed to `margin` outside the closest point: along closest point → particle when outside, along the interpolated normal when inside
      let nx = c.nx, ny = c.ny, nz = c.nz
      if (c.signed > 1e-6) {
        const d = c.signed
        nx = (x[k]! - c.qx) / d
        ny = (x[k + 1]! - c.qy) / d
        nz = (x[k + 2]! - c.qz) / d
      }
      const depth = margin - c.signed
      x[k] = c.qx + nx * margin
      x[k + 1] = c.qy + ny * margin
      x[k + 2] = c.qz + nz * margin
      friction(x, prev, k, nx, ny, nz, depth, mu)
      contacts++
    }
    this.contacts = contacts
  }
}

/**
 * 反过来的检查：皮肤顶点不能从布的三角形中间穿出来。顶点碰撞只管布的顶点，细小的突起（外生殖器、乳头、
 * 骨突）可以从布的两个顶点之间钻出来；这里把被穿过的三角形连同三个顶点按重心坐标往外推。
 * 布的外侧由每个三角形创建时的朝向记下（三个顶点到最近皮肤点的方向）。
 * The reverse check: skin vertices must not come out through the middle of a cloth triangle. Vertex collisions
 * only look after the cloth's vertices, and small protrusions (external genitalia, nipples, bony points) can slip
 * out between two of them; a triangle that is poked through is pushed outward, its three corners weighted by the
 * barycentrics. The cloth's outer side is recorded per triangle when this is created (the direction from the
 * nearest skin point to its three corners).
 */
export class SkinVertexCollider implements Collider {
  private readonly sign: Int8Array
  private tableSize = 1
  private cellStart = new Int32Array(1)
  private entries = new Int32Array(0)
  constructor(
    readonly triangles: Uint32Array,
    readonly skin: MeshCollider,
    x: Float64Array,
    readonly cell = 0.02,
    readonly reach = 0.015,
  ) {
    const nt = triangles.length / 3
    this.sign = new Int8Array(nt)
    const out = new Float64Array(x.length)
    const c: Closest = { tri: 0, b0: 0, b1: 0, b2: 0, signed: 0, qx: 0, qy: 0, qz: 0, nx: 0, ny: 0, nz: 0 }
    for (let i = 0; i < x.length / 3; i++) {
      if (skin.closest(x[i * 3]!, x[i * 3 + 1]!, x[i * 3 + 2]!, c)) out.set([c.nx, c.ny, c.nz], i * 3)
    }
    for (let t = 0; t < nt; t++) {
      const [nx, ny, nz] = this.normal(x, t)
      let s = 0
      for (let k = 0; k < 3; k++) {
        const v = triangles[t * 3 + k]! * 3
        s += nx * out[v]! + ny * out[v + 1]! + nz * out[v + 2]!
      }
      this.sign[t] = s >= 0 ? 1 : -1
    }
  }

  private normal(x: Float64Array, t: number): [number, number, number] {
    const a = this.triangles[t * 3]! * 3, b = this.triangles[t * 3 + 1]! * 3, c = this.triangles[t * 3 + 2]! * 3
    const ux = x[b]! - x[a]!, uy = x[b + 1]! - x[a + 1]!, uz = x[b + 2]! - x[a + 2]!
    const vx = x[c]! - x[a]!, vy = x[c + 1]! - x[a + 1]!, vz = x[c + 2]! - x[a + 2]!
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    return [nx / l, ny / l, nz / l]
  }

  private hash(xi: number, yi: number, zi: number): number {
    const h = Math.imul(xi, 92837111) ^ Math.imul(yi, 689287499) ^ Math.imul(zi, 283923481)
    return Math.abs(h) % this.tableSize
  }

  private build(x: Float64Array): void {
    const T = this.triangles, nt = T.length / 3, cell = this.cell, r = this.reach
    this.tableSize = Math.max(1024, nt * 8)
    if (this.cellStart.length !== this.tableSize + 1) this.cellStart = new Int32Array(this.tableSize + 1)
    const start = this.cellStart
    start.fill(0)
    const each = (t: number, f: (h: number) => void): void => {
      let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity
      for (let k = 0; k < 3; k++) {
        const v = T[t * 3 + k]! * 3
        lx = Math.min(lx, x[v]!)
        ly = Math.min(ly, x[v + 1]!)
        lz = Math.min(lz, x[v + 2]!)
        hx = Math.max(hx, x[v]!)
        hy = Math.max(hy, x[v + 1]!)
        hz = Math.max(hz, x[v + 2]!)
      }
      for (let xi = Math.floor((lx - r) / cell); xi <= Math.floor((hx + r) / cell); xi++)
        for (let yi = Math.floor((ly - r) / cell); yi <= Math.floor((hy + r) / cell); yi++)
          for (let zi = Math.floor((lz - r) / cell); zi <= Math.floor((hz + r) / cell); zi++) f(this.hash(xi, yi, zi))
    }
    let total = 0
    for (let t = 0; t < nt; t++) each(t, (h) => {
      start[h]!++
      total++
    })
    let acc = 0
    for (let i = 0; i < this.tableSize; i++) {
      acc += start[i]!
      start[i] = acc
    }
    start[this.tableSize] = acc
    if (this.entries.length < total) this.entries = new Int32Array(total)
    for (let t = 0; t < nt; t++) each(t, (h) => {
      start[h]!--
      this.entries[start[h]!] = t
    })
  }

  /** 每几次调用才真正做一次（它比顶点碰撞贵得多）/ Only every this many calls does real work (it costs far more than vertex collisions). */
  every = 10
  private calls = 0
  private near: Int32Array | null = null

  resolve(x: Float64Array, _prev: Float64Array, w: Float64Array, margin: number): void {
    if (this.calls++ % this.every !== 0) return
    this.scan(x, margin, (t, b0, b1, b2, nx, ny, nz, depth) => {
      const T = this.triangles
      const wsum = b0 * b0 * w[T[t * 3]!]! + b1 * b1 * w[T[t * 3 + 1]!]! + b2 * b2 * w[T[t * 3 + 2]!]!
      if (wsum <= 0) return
      const bs = [b0, b1, b2]
      for (let k = 0; k < 3; k++) {
        const v = T[t * 3 + k]!
        const m = (depth * bs[k]! * w[v]!) / wsum
        x[v * 3] = x[v * 3]! + m * nx
        x[v * 3 + 1] = x[v * 3 + 1]! + m * ny
        x[v * 3 + 2] = x[v * 3 + 2]! + m * nz
      }
    })
  }

  /**
   * 检查用：皮肤顶点钻出布的最大深度（米，钻出 0 以上才算）和钻出超过 1 mm 的皮肤顶点数。不改动位置。
   * For checks: the deepest poke-through of a skin vertex (metres, counted above 0) and how many skin vertices come
   * out by more than 1 mm. Positions are not changed.
   */
  measure(x: Float64Array): { maxDepth: number; over1mm: number } {
    this.near = null
    let maxDepth = 0
    const over = new Set<number>()
    this.scan(x, 0, (_t, _b0, _b1, _b2, _nx, _ny, _nz, depth, s) => {
      maxDepth = Math.max(maxDepth, depth)
      if (depth > 0.001) over.add(s)
    })
    return { maxDepth, over1mm: over.size }
  }

  private scan(x: Float64Array, margin: number, visit: (t: number, b0: number, b1: number, b2: number, nx: number, ny: number, nz: number, depth: number, s: number) => void): void {
    this.build(x)
    const P = this.skin.pos, T = this.triangles, cell = this.cell
    // 只看布的包围盒附近的皮肤顶点（每 20 次重算）/ only skin vertices near the cloth's bounding box (recomputed every 20 rounds)
    if (!this.near || this.calls % (20 * this.every) === 1) {
      let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity
      for (let i = 0; i < x.length; i += 3) {
        lx = Math.min(lx, x[i]!)
        ly = Math.min(ly, x[i + 1]!)
        lz = Math.min(lz, x[i + 2]!)
        hx = Math.max(hx, x[i]!)
        hy = Math.max(hy, x[i + 1]!)
        hz = Math.max(hz, x[i + 2]!)
      }
      const r = 0.03, list: number[] = []
      for (let s = 0; s < P.length; s += 3) {
        if (P[s]! > lx - r && P[s]! < hx + r && P[s + 1]! > ly - r && P[s + 1]! < hy + r && P[s + 2]! > lz - r && P[s + 2]! < hz + r) list.push(s)
      }
      this.near = Int32Array.from(list)
    }
    for (const s of this.near) {
      const px = P[s]!, py = P[s + 1]!, pz = P[s + 2]!
      const h = this.hash(Math.floor(px / cell), Math.floor(py / cell), Math.floor(pz / cell))
      for (let j = this.cellStart[h]!; j < this.cellStart[h + 1]!; j++) {
        const t = this.entries[j]!
        const a = T[t * 3]! * 3, b = T[t * 3 + 1]! * 3, c = T[t * 3 + 2]! * 3
        let [nx, ny, nz] = this.normal(x, t)
        const sg = this.sign[t]!
        nx *= sg
        ny *= sg
        nz *= sg
        // 只管朝向与布外侧一致的皮肤（钻出来的突起）；迎面而来的另一块皮肤（并拢的大腿、手）是夹住，不是钻出
        // only skin facing the same way as the cloth's outside (a protrusion coming through); another piece of skin facing
        // it (thighs together, a hand) is a pinch, not a poke-through
        const N = this.skin.normal
        if (N[s]! * nx + N[s + 1]! * ny + N[s + 2]! * nz < 0.3) continue
        const d = (px - x[a]!) * nx + (py - x[a + 1]!) * ny + (pz - x[a + 2]!) * nz
        // 皮肤点在布外侧（或离布不足 margin）、又没远到不相干 / the skin point is outside the cloth (or within margin of it) but not far off
        if (d <= (margin > 0 ? -0.5 * margin : 0) || d > this.reach) continue
        // 投影点的重心坐标 / barycentrics of the projection
        const qx = px - d * nx - x[a]!, qy = py - d * ny - x[a + 1]!, qz = pz - d * nz - x[a + 2]!
        const e1x = x[b]! - x[a]!, e1y = x[b + 1]! - x[a + 1]!, e1z = x[b + 2]! - x[a + 2]!
        const e2x = x[c]! - x[a]!, e2y = x[c + 1]! - x[a + 1]!, e2z = x[c + 2]! - x[a + 2]!
        const d00 = e1x * e1x + e1y * e1y + e1z * e1z, d01 = e1x * e2x + e1y * e2y + e1z * e2z, d11 = e2x * e2x + e2y * e2y + e2z * e2z
        const d20 = qx * e1x + qy * e1y + qz * e1z, d21 = qx * e2x + qy * e2y + qz * e2z
        const den = d00 * d11 - d01 * d01
        if (den <= 0) continue
        const b1 = (d11 * d20 - d01 * d21) / den, b2 = (d00 * d21 - d01 * d20) / den, b0 = 1 - b1 - b2
        if (b0 < 0 || b1 < 0 || b2 < 0) continue
        visit(t, b0, b1, b2, nx, ny, nz, d + margin, s / 3)
      }
    }
  }
}
