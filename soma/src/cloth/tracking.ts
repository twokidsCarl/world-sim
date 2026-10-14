// 运行时的皮肤碰撞体：每个布顶点记住它最近的皮肤三角形，每个子步只在这个三角形三个顶点周围的三角形里找
// （时间连贯性），不必每帧给 10 万个三角形重建哈希。还带两样运行时要的东西：皮肤在子步之间移动时的相对摩擦
// （布被身体带着走），以及按皮肤顶点给的额外距离（叠穿：上衣与皮肤之间隔着下装）。
// The runtime skin collider: every cloth vertex remembers its nearest skin triangle and each substep searches only the
// triangles around that triangle's three corners (temporal coherence), so no hash over 100,000 triangles is rebuilt
// every frame. It also carries two things the runtime needs: friction relative to the skin moving between substeps
// (the body carries the cloth along), and an extra distance per skin vertex (layering: a bottom garment lies between a
// top and the skin).

import type { Collider } from './solver.ts'

/** 三维长度（比 Math.hypot 快得多，热循环里用）/ A 3-D length (much faster than Math.hypot; used in hot loops). */
function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z)
}

/** 一帧（一个子步）里的皮肤：位置、上一子步的位置、法线和顶点 → 三角形表；几件衣服共用 / The skin for a frame (a substep): positions, those of the previous substep, normals and the vertex → triangle table; shared by all garments. */
export class SkinFrame {
  readonly pos: Float64Array
  readonly prevPos: Float64Array
  readonly normal: Float64Array
  /** 顶点 → 相邻三角形（CSR）/ vertex → incident triangles (CSR). */
  readonly vtStart: Int32Array
  readonly vtList: Int32Array
  /** 皮肤顶点的空间哈希（重新找最近三角形用），每帧重建 / A spatial hash of the skin vertices (for re-acquiring the nearest triangle), rebuilt every frame. */
  private readonly cell = 0.02
  private hashSize = 1
  private cellStart = new Int32Array(1)
  private cellList = new Int32Array(0)

  constructor(positions: ArrayLike<number>, readonly index: Uint32Array) {
    this.pos = Float64Array.from(positions)
    this.prevPos = Float64Array.from(positions)
    this.normal = new Float64Array(this.pos.length)
    const nv = this.pos.length / 3, nt = index.length / 3
    const count = new Int32Array(nv + 1)
    for (let k = 0; k < index.length; k++) count[index[k]! + 1]!++
    for (let v = 0; v < nv; v++) count[v + 1] = count[v + 1]! + count[v]!
    this.vtStart = count
    this.vtList = new Int32Array(index.length)
    const fill = count.slice(0, nv)
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) this.vtList[fill[index[t * 3 + k]!]!++] = t
    this.computeNormals()
    this.buildHash()
  }

  private hashOf(xi: number, yi: number, zi: number): number {
    return Math.abs(Math.imul(xi, 92837111) ^ Math.imul(yi, 689287499) ^ Math.imul(zi, 283923481)) % this.hashSize
  }

  /** 按当前位置重建顶点哈希 / Rebuild the vertex hash from the current positions. */
  buildHash(): void {
    const p = this.pos, n = p.length / 3, c = this.cell
    this.hashSize = 2 * n
    if (this.cellStart.length !== this.hashSize + 1) this.cellStart = new Int32Array(this.hashSize + 1)
    if (this.cellList.length !== n) this.cellList = new Int32Array(n)
    const start = this.cellStart
    start.fill(0)
    const key = new Int32Array(n)
    for (let v = 0; v < n; v++) {
      key[v] = this.hashOf(Math.floor(p[v * 3]! / c), Math.floor(p[v * 3 + 1]! / c), Math.floor(p[v * 3 + 2]! / c))
      start[key[v]!]!++
    }
    let acc = 0
    for (let h = 0; h < this.hashSize; h++) {
      acc += start[h]!
      start[h] = acc
    }
    start[this.hashSize] = acc
    for (let v = 0; v < n; v++) this.cellList[--start[key[v]!]!] = v
  }

  /** 离点最近的皮肤顶点（只在周围一格里找；找不到为 −1）/ The skin vertex nearest a point (searched in the surrounding cells only; −1 when none). */
  nearestVertex(px: number, py: number, pz: number): number {
    const c = this.cell, p = this.pos
    const xi = Math.floor(px / c), yi = Math.floor(py / c), zi = Math.floor(pz / c)
    let best = -1, bd = Infinity
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
      const h = this.hashOf(xi + a, yi + b, zi + d)
      for (let j = this.cellStart[h]!; j < this.cellStart[h + 1]!; j++) {
        const v = this.cellList[j]!
        const dx = p[v * 3]! - px, dy = p[v * 3 + 1]! - py, dz = p[v * 3 + 2]! - pz
        const e = dx * dx + dy * dy + dz * dz
        if (e < bd) {
          bd = e
          best = v
        }
      }
    }
    return best
  }

  /** 三个顶点组成的三角形的下标（找不到为 −1）/ The index of the triangle with these three corners (−1 when none). */
  triangleOf(a: number, b: number, c: number): number {
    const i = this.index
    for (let k = this.vtStart[a]!; k < this.vtStart[a + 1]!; k++) {
      const t = this.vtList[k]!
      const s0 = i[t * 3]!, s1 = i[t * 3 + 1]!, s2 = i[t * 3 + 2]!
      if ((s0 === b || s1 === b || s2 === b) && (s0 === c || s1 === c || s2 === c)) return t
    }
    return -1
  }

  /** 皮肤移动了：记下旧位置，换上新位置（法线另算）/ The skin moved: keep the old positions and take the new (normals separately). */
  moveTo(positions: ArrayLike<number>): void {
    this.prevPos.set(this.pos)
    this.pos.set(positions)
  }

  computeNormals(from: ArrayLike<number> = this.pos): void {
    const p = from, I = this.index, N = this.normal
    N.fill(0)
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t]! * 3, b = I[t + 1]! * 3, c = I[t + 2]! * 3
      const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!
      const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      N[a] = N[a]! + nx
      N[a + 1] = N[a + 1]! + ny
      N[a + 2] = N[a + 2]! + nz
      N[b] = N[b]! + nx
      N[b + 1] = N[b + 1]! + ny
      N[b + 2] = N[b + 2]! + nz
      N[c] = N[c]! + nx
      N[c + 1] = N[c + 1]! + ny
      N[c + 2] = N[c + 2]! + nz
    }
    for (let k = 0; k < N.length; k += 3) {
      const l = len3(N[k]!, N[k + 1]!, N[k + 2]!) || 1
      N[k] = N[k]! / l
      N[k + 1] = N[k + 1]! / l
      N[k + 2] = N[k + 2]! / l
    }
  }
}

export class TrackingCollider implements Collider {
  /** 每个布顶点当前跟踪的三角形，−1 为没有 / The triangle each cloth vertex tracks; −1 for none. */
  readonly tri: Int32Array
  /** 上一次解算时每个布顶点到皮肤的有向距离（米）/ Each cloth vertex's signed distance to the skin at the last solve (metres). */
  readonly signed: Float64Array
  /** 每个皮肤顶点额外要保持的距离（米），null = 没有 / Extra distance to keep per skin vertex (metres); null = none. */
  extra: Float64Array | null = null
  /**
   * 设为 true 时，上次离皮肤（含额外距离）超过 1.5 cm 的布顶点这一子步不检查：一帧之内两者靠近不了这么多。
   * 每帧第一个子步由调用者设为 false，全部检查一遍。
   * When true, cloth vertices that were more than 1.5 cm off the skin (extra distance included) at their last check are
   * skipped this substep: they cannot close that much within a frame. The caller sets it false on the first substep of
   * each frame so every vertex is checked once.
   */
  lazy = false
  /** 在这个盒子里（xmin, ymin, zmin, xmax, ymax, zmax）的布顶点每帧第一个子步都重新找最近的三角形 / Cloth vertices inside this box re-acquire their nearest triangle on the first substep of every frame. */
  reacquire: number[] | null = null
  /** 轮流核对用的计数（每帧加一）/ The counter for checks in turn (bumped every frame). */
  round = 0
  /** 每个子步最多推出的距离（米）/ The furthest a vertex is pushed out per substep (metres). */
  maxPush = Infinity

  constructor(
    readonly skin: SkinFrame,
    clothVertices: number,
  ) {
    this.tri = new Int32Array(clothVertices).fill(-1)
    this.signed = new Float64Array(clothVertices)
  }

  // 最近点的重心坐标与距离平方（Ericson 5.1.5）；结果写在 this.q 里 / closest point barycentrics and squared distance (Ericson 5.1.5); written to this.q
  private readonly q = { u: 0, v: 0, d2: 0 }
  private closestOn(t: number, px: number, py: number, pz: number): void {
    const p = this.skin.pos, I = this.skin.index
    const a = I[t * 3]! * 3, b = I[t * 3 + 1]! * 3, c = I[t * 3 + 2]! * 3
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
    const qx = ax + abx * u + acx * v - px, qy = ay + aby * u + acy * v - py, qz = az + abz * u + acz * v - pz
    this.q.u = u
    this.q.v = v
    this.q.d2 = qx * qx + qy * qy + qz * qz
  }

  /**
   * 从当前跟踪的三角形出发，在它三个顶点的相邻三角形里找最近的；walks 次走动。
   * From the tracked triangle, look among the triangles around its three corners for the nearest; `walks` moves.
   */
  track(i: number, px: number, py: number, pz: number, walks = 1): number {
    let best = this.tri[i]!
    if (best < 0) return -1
    this.closestOn(best, px, py, pz)
    let bd = this.q.d2
    const I = this.skin.index, vtStart = this.skin.vtStart, vtList = this.skin.vtList
    for (let w = 0; w < walks; w++) {
      const from = best
      for (let k = 0; k < 3; k++) {
        const v = I[from * 3 + k]!
        for (let j = vtStart[v]!; j < vtStart[v + 1]!; j++) {
          const t = vtList[j]!
          if (t === best) continue
          this.closestOn(t, px, py, pz)
          if (this.q.d2 < bd) {
            bd = this.q.d2
            best = t
          }
        }
      }
      if (best === from) break
    }
    this.tri[i] = best
    return best
  }

  resolve(x: Float64Array, prev: Float64Array, w: Float64Array, margin: number, mu: number): void {
    const p = this.skin.pos, pp = this.skin.prevPos, N = this.skin.normal, I = this.skin.index, extra = this.extra
    for (let i = 0; i < w.length; i++) {
      if (w[i] === 0) continue
      if (this.lazy && this.signed[i]! > 0.015 + margin) continue
      const k = i * 3
      // 每帧第一个子步：上次在皮肤里面的顶点重新找最近的三角形（局部跟踪在细小的突起上可能走到另一面去）
      // first substep of a frame: a vertex that was inside the skin re-acquires its nearest triangle (local tracking can
      // walk to the far side of a small protrusion)
      const box = this.reacquire
      const inBox = !!box && x[k]! > box[0]! && x[k + 1]! > box[1]! && x[k + 2]! > box[2]! && x[k]! < box[3]! && x[k + 1]! < box[4]! && x[k + 2]! < box[5]!
      // 另外每帧轮到四分之一的顶点也核对一次（局部跟踪会在弯起来的膝、肘上停在大腿或小腿那一面）
      // in addition a quarter of the vertices, in turn, are checked every frame (local tracking can stay on the thigh or
      // calf side of a bent knee or elbow)
      const turn = (i + this.round) % 4 === 0
      if (!this.lazy && (this.signed[i]! < 0 || inBox || turn)) {
        const v = this.skin.nearestVertex(x[k]!, x[k + 1]!, x[k + 2]!)
        if (v >= 0 && this.tri[i]! >= 0) {
          // 只在跟踪的三角形明显不是最近的时候才换（差 3 mm 以上），免得在两块相近的皮之间来回跳
          // switch only when the tracked triangle is clearly not the nearest (by more than 3 mm), so the vertex does not
          // flip back and forth between two stretches of skin at similar distances
          this.closestOn(this.tri[i]!, x[k]!, x[k + 1]!, x[k + 2]!)
          const p = this.skin.pos
          const dv = len3(p[v * 3]! - x[k]!, p[v * 3 + 1]! - x[k + 1]!, p[v * 3 + 2]! - x[k + 2]!)
          if (this.signed[i]! < 0 || dv + 0.003 < Math.sqrt(this.q.d2)) {
            this.tri[i] = this.skin.vtList[this.skin.vtStart[v]!]!
            this.track(i, x[k]!, x[k + 1]!, x[k + 2]!, 3)
          }
        }
      }
      // 最近点落在当前三角形内部时它仍是最近的（局部而言）：只有落在边或角上才走到邻居去
      // while the closest point lies inside the tracked triangle it is still the nearest (locally): only when it falls on
      // an edge or corner does the search walk to the neighbours
      let t = this.tri[i]!
      if (t < 0) continue
      this.closestOn(t, x[k]!, x[k + 1]!, x[k + 2]!)
      if (this.q.u <= 0 || this.q.v <= 0 || this.q.u + this.q.v >= 1) {
        t = this.track(i, x[k]!, x[k + 1]!, x[k + 2]!)
        this.closestOn(t, x[k]!, x[k + 1]!, x[k + 2]!)
      }
      const u = this.q.u, v = this.q.v, b0 = 1 - u - v
      const a = I[t * 3]!, b = I[t * 3 + 1]!, c = I[t * 3 + 2]!
      const qx = p[a * 3]! * b0 + p[b * 3]! * u + p[c * 3]! * v
      const qy = p[a * 3 + 1]! * b0 + p[b * 3 + 1]! * u + p[c * 3 + 1]! * v
      const qz = p[a * 3 + 2]! * b0 + p[b * 3 + 2]! * u + p[c * 3 + 2]! * v
      let nx = N[a * 3]! * b0 + N[b * 3]! * u + N[c * 3]! * v
      let ny = N[a * 3 + 1]! * b0 + N[b * 3 + 1]! * u + N[c * 3 + 1]! * v
      let nz = N[a * 3 + 2]! * b0 + N[b * 3 + 2]! * u + N[c * 3 + 2]! * v
      const nl = len3(nx, ny, nz) || 1
      nx /= nl
      ny /= nl
      nz /= nl
      const dx = x[k]! - qx, dy = x[k + 1]! - qy, dz = x[k + 2]! - qz
      const dist = len3(dx, dy, dz)
      const sd = dx * nx + dy * ny + dz * nz >= 0 ? dist : -dist
      const m = extra ? margin + extra[a]! * b0 + extra[b]! * u + extra[c]! * v : margin
      // 记下到“有效表面”（皮肤外加额外距离）的距离 / the distance to the effective surface (skin plus the extra distance) is recorded
      this.signed[i] = sd - (m - margin)
      if (sd >= m) continue
      // 外面时沿“最近点 → 粒子”推，里面时沿插值法线 / outside: along closest point → particle; inside: along the interpolated normal
      if (sd > 1e-6) {
        nx = dx / dist
        ny = dy / dist
        nz = dz / dist
      }
      // 一个子步最多推 maxPush：夹在两块皮之间的顶点满足不了两边，整段推开只会让它来回跳
      // at most maxPush per substep: a vertex caught between two stretches of skin cannot satisfy both, and pushing it
      // all the way would only make it jump back and forth
      if (m - sd > this.maxPush) {
        x[k] = x[k]! + nx * this.maxPush
        x[k + 1] = x[k + 1]! + ny * this.maxPush
        x[k + 2] = x[k + 2]! + nz * this.maxPush
      } else {
        x[k] = qx + nx * m
        x[k + 1] = qy + ny * m
        x[k + 2] = qz + nz * m
      }
      // 相对皮肤的摩擦：减去皮肤上最近点在这个子步里的位移 / friction relative to the skin: the closest skin point's motion this substep is taken off
      if (mu > 0) {
        const sx = (p[a * 3]! - pp[a * 3]!) * b0 + (p[b * 3]! - pp[b * 3]!) * u + (p[c * 3]! - pp[c * 3]!) * v
        const sy = (p[a * 3 + 1]! - pp[a * 3 + 1]!) * b0 + (p[b * 3 + 1]! - pp[b * 3 + 1]!) * u + (p[c * 3 + 1]! - pp[c * 3 + 1]!) * v
        const sz = (p[a * 3 + 2]! - pp[a * 3 + 2]!) * b0 + (p[b * 3 + 2]! - pp[b * 3 + 2]!) * u + (p[c * 3 + 2]! - pp[c * 3 + 2]!) * v
        const rx = x[k]! - prev[k]! - sx, ry = x[k + 1]! - prev[k + 1]! - sy, rz = x[k + 2]! - prev[k + 2]! - sz
        const rn = rx * nx + ry * ny + rz * nz
        const tx = rx - rn * nx, ty = ry - rn * ny, tz = rz - rn * nz
        const tl = len3(tx, ty, tz)
        if (tl > 1e-12) {
          const s = Math.min(1, (mu * Math.max(0, m - sd)) / tl)
          x[k] = x[k]! - tx * s
          x[k + 1] = x[k + 1]! - ty * s
          x[k + 2] = x[k + 2]! - tz * s
        }
      }
    }
  }
}

/**
 * 叠穿：上衣的顶点不能进到下装里面。每帧按下装的顶点建一次哈希；上衣顶点离某个下装顶点不到 reach、
 * 又在它外法线方向上不足 gap 时，沿那个法线推到 gap 处（只动上衣）。只看下装包围盒里的上衣顶点。
 * Layering: a top's vertices must not get inside the bottom. Once a frame the bottom's vertices are hashed; a top vertex
 * within `reach` of a bottom vertex and less than `gap` out along its outward normal is pushed to `gap` along that
 * normal (only the top moves). Only top vertices inside the bottom's bounding box are looked at.
 */
export class LayerCollider implements Collider {
  private pos: Float64Array = new Float64Array(0)
  private nor: Float32Array = new Float32Array(0)
  private size = 1
  private start = new Int32Array(1)
  private list = new Int32Array(0)
  private box = [0, 0, 0, 0, 0, 0]
  active = false

  constructor(readonly gap = 0.004, readonly reach = 0.012) {}

  private h(xi: number, yi: number, zi: number): number {
    return Math.abs(Math.imul(xi, 92837111) ^ Math.imul(yi, 689287499) ^ Math.imul(zi, 283923481)) % this.size
  }

  /** 下装这一帧的顶点和朝外的法线（可以是几件下装拼起来的）/ The bottom's vertices this frame and their outward normals (several bottoms may be concatenated). */
  setBottom(pos: Float64Array, nor: Float32Array): void {
    this.pos = pos
    this.nor = nor
    const n = pos.length / 3, c = this.reach
    this.active = n > 0
    if (!n) return
    this.size = 2 * n
    if (this.start.length !== this.size + 1) this.start = new Int32Array(this.size + 1)
    if (this.list.length !== n) this.list = new Int32Array(n)
    this.start.fill(0)
    const key = new Int32Array(n)
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let v = 0; v < n; v++) {
      key[v] = this.h(Math.floor(pos[v * 3]! / c), Math.floor(pos[v * 3 + 1]! / c), Math.floor(pos[v * 3 + 2]! / c))
      this.start[key[v]!]!++
      for (let k = 0; k < 3; k++) {
        b[k] = Math.min(b[k]!, pos[v * 3 + k]!)
        b[k + 3] = Math.max(b[k + 3]!, pos[v * 3 + k]!)
      }
    }
    let acc = 0
    for (let i = 0; i < this.size; i++) {
      acc += this.start[i]!
      this.start[i] = acc
    }
    this.start[this.size] = acc
    for (let v = 0; v < n; v++) this.list[--this.start[key[v]!]!] = v
    this.box = b.map((v, k) => (k < 3 ? v - c : v + c))
  }

  resolve(x: Float64Array, prev: Float64Array, w: Float64Array): void {
    if (!this.active) return
    const c = this.reach, P = this.pos, N = this.nor, B = this.box, r2 = c * c
    for (let i = 0; i < w.length; i++) {
      if (w[i] === 0) continue
      const k = i * 3
      const px = x[k]!, py = x[k + 1]!, pz = x[k + 2]!
      if (px < B[0]! || py < B[1]! || pz < B[2]! || px > B[3]! || py > B[4]! || pz > B[5]!) continue
      const xi = Math.floor(px / c), yi = Math.floor(py / c), zi = Math.floor(pz / c)
      let push = 0, nx = 0, ny = 0, nz = 0
      for (let a = -1; a <= 1; a++) for (let bb = -1; bb <= 1; bb++) for (let d = -1; d <= 1; d++) {
        const h = this.h(xi + a, yi + bb, zi + d)
        for (let j = this.start[h]!; j < this.start[h + 1]!; j++) {
          const v = this.list[j]!
          const dx = px - P[v * 3]!, dy = py - P[v * 3 + 1]!, dz = pz - P[v * 3 + 2]!
          if (dx * dx + dy * dy + dz * dz > r2) continue
          const mx = N[v * 3]!, my = N[v * 3 + 1]!, mz = N[v * 3 + 2]!
          const s = dx * mx + dy * my + dz * mz
          if (s >= this.gap) continue
          // 最深的那个说了算 / the deepest one decides
          if (this.gap - s > push) {
            push = this.gap - s
            nx = mx
            ny = my
            nz = mz
          }
        }
      }
      if (push > 0) {
        // 推开不带速度（prev 一起移）：两层布在褶里挤着时，否则会被弹得来回飞
        // the push carries no velocity (prev moves too): with two layers squeezed in a fold they would otherwise be flung about
        x[k] = px + nx * push
        x[k + 1] = py + ny * push
        x[k + 2] = pz + nz * push
        prev[k] = prev[k]! + nx * push
        prev[k + 1] = prev[k + 1]! + ny * push
        prev[k + 2] = prev[k + 2]! + nz * push
      }
    }
  }
}
