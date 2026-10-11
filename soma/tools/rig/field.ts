// 体内“到各关节骨骼的距离”场：软组织跟随哪些骨、各占多少，都由它决定。
// The in-body field of distances to the bones of every joint: it decides which bones a piece of
// soft tissue follows, and by how much.
//
// 为什么不用欧氏最近骨：手臂贴着躯干、手指彼此靠近、两腿并拢时，欧氏最近的骨可能隔着空气。
// 这里把皮肤以内的空间体素化，只允许在体内传播，求每个体素到最近 K 个关节骨骼的测地距离
// （多标号 Dijkstra，桶队列）。查询时：测地距离与欧氏距离相近（中间没有空气阻隔）就用精确的
// 欧氏距离；否则用测地距离，于是隔着空气的骨自然变“远”。
// Why not the Euclidean nearest bone: with the arms beside the trunk, the fingers close together
// and the legs together, the nearest bone in a straight line may lie across air. The space inside
// the skin is voxelised and distances may only propagate through the body; every voxel gets its
// geodesic distance to the bones of the K nearest joints (multi-label Dijkstra with a bucket
// queue). A query uses the exact Euclidean distance wherever the geodesic one agrees with it
// (nothing but tissue in between) and the geodesic distance otherwise, so that a bone across an
// air gap is far away, as it should be.

import { type MeshLike, Surface, mergeMeshes } from './geom.ts'
import type { V3 } from './math.ts'

export interface FieldSource {
  /** 关节下标。 Joint index. */
  joint: number
  /** 该关节所带全部骨骼合并成的表面。 All bones of the joint merged into one surface. */
  surface: Surface
}

export interface FieldStats {
  /** 堵住皮肤开口所需的壁加厚体素数。 Voxels of wall thickening needed to plug the openings of the skin. */
  plug: number
  /** 中心落在体外空气里而被剔除的壁体素数；因跨到另一片皮肤而被关闭的体素间通路数。 Wall voxels removed because their centre lies in the air outside; steps between voxels closed because they cross onto another sheet of skin. */
  airVoxelsRemoved: number
  stepsClosed: number
  voxel: number
  dims: [number, number, number]
  insideVoxels: number
  labelledVoxels: number
  meanLabels: number
  /** 皮肤有破洞、外部洪泛漏进体内时为 true（此时退化为欧氏距离）。 True when the outside flood leaked into the body through a hole in the skin (the field then degrades to Euclidean distances). */
  leaked: boolean
  buildMs: number
}

export interface Candidates {
  joints: number[]
  /** 有效距离（米）。 Effective distance, metres. */
  dist: number[]
}

export class BodyField {
  readonly h: number
  readonly K: number
  readonly min: V3
  readonly dims: [number, number, number]
  readonly inside: Uint8Array
  /** 体素中心的类别：0 = 体外，1 = 皮肤两层壁之间，2 = 肉。 Class of the voxel centre: 0 = outside, 1 = between the two walls of the skin, 2 = flesh. */
  private readonly cls: Uint8Array
  private readonly nearWall: Uint8Array
  private readonly count: Uint8Array
  private readonly labJoint: Int16Array
  private readonly labDist: Float32Array
  readonly stats: FieldStats
  private readonly byJoint = new Map<number, Surface>()
  /** 皮肤表面：判断点与骨之间是否隔着空气。 The skin surface: used to tell whether air lies between a point and a bone. */
  private readonly skinSurface: Surface | null
  /** 查询统计：直接采用欧氏距离 / 经射线检验 / 判为被空气隔开的次数。 Query statistics: Euclidean taken outright / ray-tested / judged to be across air. */
  readonly queryStats = { direct: 0, tested: 0, obstructed: 0 }

  constructor(skin: MeshLike[], readonly sources: FieldSource[], voxel = 0.005, K = 8) {
    const t0 = performance.now()
    this.h = voxel
    this.K = K
    for (const s of sources) this.byJoint.set(s.joint, s.surface)
    this.skinSurface = skin.length ? new Surface(skin.length === 1 ? skin[0]! : mergeMeshes(skin)) : null
    const h = voxel
    // 包围盒：皮肤与骨骼 / bounds: skin and bones
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity]
    const grow = (p: Float32Array): void => {
      for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (p[i + k]! < lo[k]!) lo[k] = p[i + k]!
          if (p[i + k]! > hi[k]!) hi[k] = p[i + k]!
        }
      }
    }
    for (const m of skin) grow(m.positions)
    for (const s of sources) grow(s.surface.positions)
    this.min = [lo[0] - 3 * h, lo[1] - 3 * h, lo[2] - 3 * h]
    const nx = Math.ceil((hi[0] - this.min[0]) / h) + 3, ny = Math.ceil((hi[1] - this.min[1]) / h) + 3, nz = Math.ceil((hi[2] - this.min[2]) / h) + 3
    this.dims = [nx, ny, nz]
    const N = nx * ny * nz
    const vox = (x: number, y: number, z: number): number => {
      const ix = Math.floor((x - this.min[0]) / h), iy = Math.floor((y - this.min[1]) / h), iz = Math.floor((z - this.min[2]) / h)
      return ix + nx * (iy + ny * iz)
    }

    // 1. 皮肤壁体素 / wall voxels of the skin
    const wall = new Uint8Array(N)
    // 保守的三角形体素化：按最长边细分重心格点（含边和顶点），细长三角形也不会漏
    // conservative triangle voxelisation: a barycentric lattice sized by the longest edge (edges and corners included), so slivers do not leak
    for (const m of skin) {
      const P = m.positions, I = m.indices
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t]! * 3, b = I[t + 1]! * 3, c = I[t + 2]! * 3
        const longest = Math.max(
          Math.hypot(P[a]! - P[b]!, P[a + 1]! - P[b + 1]!, P[a + 2]! - P[b + 2]!),
          Math.hypot(P[a]! - P[c]!, P[a + 1]! - P[c + 1]!, P[a + 2]! - P[c + 2]!),
          Math.hypot(P[b]! - P[c]!, P[b + 1]! - P[c + 1]!, P[b + 2]! - P[c + 2]!),
        )
        const k = Math.max(1, Math.ceil(longest / (h / 2.5)))
        for (let i = 0; i <= k; i++) {
          for (let j = 0; j <= k - i; j++) {
            const u = i / k, v = j / k, w = 1 - u - v
            wall[vox(w * P[a]! + u * P[b]! + v * P[c]!, w * P[a + 1]! + u * P[b + 1]! + v * P[c + 1]!, w * P[a + 2]! + u * P[b + 2]! + v * P[c + 2]!)] = 1
          }
        }
      }
    }

    if (process.env.RIG_DEBUG) console.error('field wall', Math.round(performance.now() - t0), 'ms')
    // 2. 从角上向内洪泛（6 邻域），洪泛不到的就是体内。皮肤是在眼、口、鼻等处翻进去的双层壳，
    //    内腔与外界相通；所以先把壁加厚 r 个体素把开口堵上再洪泛，然后把加厚出来的外层剥掉。
    // 2. flood from a corner (6-neighbourhood); what it cannot reach is inside. The skin is a
    //    double-walled shell turned in at the eyes, mouth and nostrils, so its cavity is open to
    //    the outside: the wall is first thickened by r voxels to plug the openings, the flood is
    //    run, and the added outer layer is peeled off again.
    const outside = new Uint8Array(N)
    const stack = new Int32Array(N)
    const step6 = [1, -1, nx, -nx, nx * ny, -nx * ny]
    const flood = (blocked: Uint8Array, seeds: number[], pass: (u: number) => boolean): void => {
      let sp = 0
      for (const sd of seeds) stack[sp++] = sd
      while (sp > 0) {
        const v = stack[--sp]!
        const x = v % nx, y = Math.floor(v / nx) % ny, z = Math.floor(v / (nx * ny))
        for (let k = 0; k < 6; k++) {
          if ((k === 0 && x === nx - 1) || (k === 1 && x === 0) || (k === 2 && y === ny - 1) || (k === 3 && y === 0) || (k === 4 && z === nz - 1) || (k === 5 && z === 0)) continue
          const u = v + step6[k]!
          if (outside[u] || blocked[u] || !pass(u)) continue
          outside[u] = 1
          stack[sp++] = u
        }
      }
    }
    let nWall = 0
    for (let i = 0; i < N; i++) if (wall[i]) nWall++
    const inside = (this.inside = new Uint8Array(N))
    let nIn = 0, leaked = true, plug = 0
    let thick = wall
    for (plug = 0; plug <= 4 && leaked && skin.length > 0; plug++) {
      if (plug > 0) {
        // 加厚一层 / thicken by one voxel
        const next = Uint8Array.from(thick)
        for (let v = 0; v < N; v++) {
          if (!thick[v]) continue
          const x = v % nx, y = Math.floor(v / nx) % ny, z = Math.floor(v / (nx * ny))
          if (x > 0) next[v - 1] = 1
          if (x < nx - 1) next[v + 1] = 1
          if (y > 0) next[v - nx] = 1
          if (y < ny - 1) next[v + nx] = 1
          if (z > 0) next[v - nx * ny] = 1
          if (z < nz - 1) next[v + nx * ny] = 1
        }
        thick = next
      }
      outside.fill(0)
      outside[0] = 1
      flood(thick, [0], () => true)
      nIn = 0
      for (let i = 0; i < N; i++) if (!outside[i]) nIn++
      // 体内体素数应远多于壁体素数；否则说明洪泛漏进了体腔
      // the inside must hold far more voxels than the wall; otherwise the flood got into the cavity
      let nThick = 0
      for (let i = 0; i < N; i++) if (thick[i]) nThick++
      leaked = nIn < 2 * nThick
    }
    plug--
    if (!leaked && plug > 0) {
      // 剥掉加厚层：只穿过“加厚出来而非原壁”的体素继续洪泛
      // peel the added layer: continue the flood through voxels that are thickening but not original wall
      const seeds: number[] = []
      for (let i = 0; i < N; i++) if (outside[i]) seeds.push(i)
      const none = new Uint8Array(N)
      flood(none, seeds, (u) => thick[u] === 1 && wall[u] === 0)
    }
    nIn = 0
    for (let i = 0; i < N; i++) if (!outside[i]) (inside[i] = 1), nIn++
    if (leaked) inside.fill(1)

    // 2b. 皮肤是双层壳。壁体素的中心可能在肉里、在两层壁之间、或在体外的空气里（手臂与躯干、
    //     手指之间的缝隙）。从中心向远处引射线数与皮肤的交点：每穿过一处皮肤是两层壁，所以
    //     交点数模 4 为 0 → 空气，2 → 肉，奇数 → 两层壁之间。空气里的体素剔出体内；相邻体素
    //     中心连线穿过两层以上的壁时（跨到了另一片皮肤），这条边不许传播。
    // 2b. The skin is a double-walled shell. The centre of a wall voxel may lie in flesh, between
    //     the two walls, or in the air outside (the gaps between arm and trunk, between fingers).
    //     Rays from the centre count their crossings with the skin: every pass through skin is two
    //     walls, so the count modulo 4 is 0 in air, 2 in flesh and odd between the walls. Voxels
    //     in air are removed from the body, and a step between two voxel centres that crosses two
    //     or more walls (onto another sheet of skin) is closed to propagation.
    const cls = (this.cls = new Uint8Array(N))
    const nearWall = (this.nearWall = new Uint8Array(N))
    const blocked = new Uint32Array(N)
    for (let i = 0; i < N; i++) if (inside[i]) cls[i] = 2
    const centre = (v: number): V3 => [this.min[0] + ((v % nx) + 0.5) * h, this.min[1] + ((Math.floor(v / nx) % ny) + 0.5) * h, this.min[2] + (Math.floor(v / (nx * ny)) + 0.5) * h]
    const skinS = this.skinSurface
    let removed = 0, closed = 0
    if (!leaked && skinS) {
      const dirs: V3[] = [[0.8165, 0.4082, 0.4082], [-0.5774, 0.5774, -0.5774], [0.2673, -0.5345, 0.8018]]
      for (let v = 0; v < N; v++) {
        if (!wall[v] || !inside[v]) continue
        const c = centre(v)
        const votes = [0, 0, 0]
        for (const d of dirs) {
          const n = skinS.crossings(c, [c[0] + d[0] * 3, c[1] + d[1] * 3, c[2] + d[2] * 3]) % 4
          votes[n === 0 ? 0 : n === 2 ? 2 : 1] = votes[n === 0 ? 0 : n === 2 ? 2 : 1]! + 1
        }
        const k = votes[2]! >= votes[1]! && votes[2]! >= votes[0]! ? 2 : votes[1]! >= votes[0]! ? 1 : 0
        cls[v] = k
        if (k === 0) (inside[v] = 0), removed++
      }
      for (let v = 0; v < N; v++) {
        if (!wall[v]) continue
        const x = v % nx, y = Math.floor(v / nx) % ny, z = Math.floor(v / (nx * ny))
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx, Y = y + dy, Z = z + dz
          if (X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz) nearWall[X + nx * (Y + ny * Z)] = 1
        }
      }
      // 26 个邻居的次序与下面 Dijkstra 用的相同 / the 26 neighbours in the order the Dijkstra below uses
      for (let v = 0; v < N; v++) {
        if (!nearWall[v] || !inside[v]) continue
        const x = v % nx, y = Math.floor(v / nx) % ny, z = Math.floor(v / (nx * ny))
        const cv = centre(v)
        let n = -1
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy && !dz) continue
          n++
          const X = x + dx, Y = y + dy, Z = z + dz
          if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
          const u = X + nx * (Y + ny * Z)
          if (u < v || !inside[u] || !nearWall[u]) continue
          if (skinS.crossings(cv, centre(u)) >= 2) {
            blocked[v] = blocked[v]! | (1 << n)
            blocked[u] = blocked[u]! | (1 << (25 - n))
            closed++
          }
        }
      }
    }
    nIn = 0
    for (let i = 0; i < N; i++) if (inside[i]) nIn++
    if (process.env.RIG_DEBUG) console.error('field flood', Math.round(performance.now() - t0), 'ms')
    // 3. 多标号 Dijkstra / multi-label Dijkstra
    const count = (this.count = new Uint8Array(N))
    const labJoint = (this.labJoint = new Int16Array(N * K).fill(-1))
    const labDist = (this.labDist = new Float32Array(N * K))
    const q = h / 4
    const nBuckets = Math.ceil(3 / q)
    const head = new Int32Array(nBuckets).fill(-1)
    let cap = 1 << 22
    let eNext = new Int32Array(cap), eVox = new Int32Array(cap), eLab = new Int16Array(cap), eDist = new Float32Array(cap)
    let used = 0, free = -1
    const push = (v: number, j: number, d: number): void => {
      const b = Math.floor(d / q)
      if (b >= nBuckets) return
      let e: number
      if (free >= 0) {
        e = free
        free = eNext[e]!
      } else {
        if (used === cap) {
          cap *= 2
          const a = new Int32Array(cap), b2 = new Int32Array(cap), c = new Int16Array(cap), d2 = new Float32Array(cap)
          a.set(eNext), b2.set(eVox), c.set(eLab), d2.set(eDist)
          eNext = a, eVox = b2, eLab = c, eDist = d2
        }
        e = used++
      }
      eVox[e] = v
      eLab[e] = j
      eDist[e] = d
      eNext[e] = head[b]!
      head[b] = e
    }
    // 种子：骨表面采样点所在体素 / seeds: voxels holding bone surface samples
    for (const s of sources) {
      const seen = new Map<number, number>()
      for (const sm of s.surface.samples(h / 2)) {
        const v = vox(sm.p[0], sm.p[1], sm.p[2])
        const x = v % nx, y = Math.floor(v / nx) % ny, z = Math.floor(v / (nx * ny))
        const d = Math.hypot(this.min[0] + (x + 0.5) * h - sm.p[0], this.min[1] + (y + 0.5) * h - sm.p[1], this.min[2] + (z + 0.5) * h - sm.p[2])
        const old = seen.get(v)
        if (old === undefined || d < old) seen.set(v, d)
      }
      for (const [v, d] of seen) {
        inside[v] = 1
        if (!cls[v]) cls[v] = 2
        push(v, s.joint, d)
      }
    }
    if (process.env.RIG_DEBUG) console.error('field seeds', Math.round(performance.now() - t0), 'ms')
    const offs: number[] = [], lens: number[] = [], dxs: number[] = [], dys: number[] = [], dzs: number[] = []
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy && !dz) continue
          offs.push(dx + nx * (dy + ny * dz))
          lens.push(h * Math.hypot(dx, dy, dz))
          dxs.push(dx), dys.push(dy), dzs.push(dz)
        }
      }
    }
    let labelled = 0, total = 0
    for (let b = 0; b < nBuckets; b++) {
      // 桶内新加入的项也在本轮处理 / entries added to this bucket meanwhile are handled in the same round
      while (head[b]! >= 0) {
        const e = head[b]!
        head[b] = eNext[e]!
        const v = eVox[e]!, j = eLab[e]!, d = eDist[e]!
        eNext[e] = free
        free = e
        const c = count[v]!
        if (c >= K) continue
        let dup = false
        for (let k = 0; k < c; k++) if (labJoint[v * K + k] === j) dup = true
        if (dup) continue
        labJoint[v * K + c] = j
        labDist[v * K + c] = d
        count[v] = c + 1
        if (c === 0) labelled++
        total++
        const x = v % nx, y = Math.floor(v / nx) % ny, z = Math.floor(v / (nx * ny))
        for (let n = 0; n < 26; n++) {
          const X = x + dxs[n]!, Y = y + dys[n]!, Z = z + dzs[n]!
          if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
          const u = v + offs[n]!
          const cu = count[u]!
          if (!inside[u] || cu >= K || (blocked[v]! >>> n) & 1) continue
          let has = false
          for (let k = 0; k < cu; k++) if (labJoint[u * K + k] === j) has = true
          if (!has) push(u, j, d + lens[n]!)
        }
      }
    }
    if (process.env.RIG_DEBUG) console.error('field dijkstra', Math.round(performance.now() - t0), 'ms')
    this.stats = { airVoxelsRemoved: removed, stepsClosed: closed, plug, voxel: h, dims: [nx, ny, nz], insideVoxels: nIn, labelledVoxels: labelled, meanLabels: labelled ? total / labelled : 0, leaked, buildMs: Math.round(performance.now() - t0) }
  }

  /** 网格上的测地距离候选（上界）：周围体素的标号各加上到该体素中心的距离，取最小。 Grid geodesic candidates (upper bounds): labels of the surrounding voxels plus the distance to each voxel centre, minimised. */
  private gridCandidates(p: V3, out: Map<number, number>): void {
    const h = this.h, [nx, ny, nz] = this.dims, K = this.K
    const fx = (p[0] - this.min[0]) / h - 0.5, fy = (p[1] - this.min[1]) / h - 0.5, fz = (p[2] - this.min[2]) / h - 0.5
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz)
    // want：只接受该类别的体素；maxCross：p 到体素中心允许穿过的皮肤壁数（防止隔着缝隙取到另一片皮肤下的体素）
    // want: accept voxels of this class only; maxCross: skin walls allowed between p and the voxel centre (so that a voxel under another sheet of skin across a gap is not used)
    const visit = (X: number, Y: number, Z: number, want: number, maxCross: number): boolean => {
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) return false
      const v = X + nx * (Y + ny * Z)
      const c = this.count[v]!
      if (!c || (want >= 0 && this.cls[v] !== want)) return false
      if (maxCross >= 0 && this.nearWall[v] && this.skinSurface) {
        const cv: V3 = [this.min[0] + (X + 0.5) * h, this.min[1] + (Y + 0.5) * h, this.min[2] + (Z + 0.5) * h]
        if (this.skinSurface.crossings(p, cv, 0.0004) > maxCross) return false
      }
      const dd = h * Math.hypot(fx - X, fy - Y, fz - Z)
      for (let k = 0; k < c; k++) {
        const j = this.labJoint[v * K + k]!, d = this.labDist[v * K + k]! + dd
        const old = out.get(j)
        if (old === undefined || d < old) out.set(j, d)
      }
      return true
    }
    let any = false
    // 先取“肉”里的体素（中间至多隔一层壁：p 自己所在皮肤的内壁）；没有则取两层壁之间、且中间不隔壁的体素
    // flesh voxels first (at most one wall in between: the inner wall of p's own skin); failing that, voxels between the walls with no wall in between
    for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) if (visit(x0 + dx, y0 + dy, z0 + dz, 2, 1)) any = true
    if (!any) for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) if (visit(x0 + dx, y0 + dy, z0 + dz, 1, 0)) any = true
    for (let r = 2; !any && r <= 3; r++) {
      for (let dz = -r + 1; dz <= r; dz++) for (let dy = -r + 1; dy <= r; dy++) for (let dx = -r + 1; dx <= r; dx++) if (visit(x0 + dx, y0 + dy, z0 + dz, 2, 1)) any = true
    }
    // 点在皮肤之外（头发、突出皮肤的结构）：向外扩大搜索，不再检查隔壁
    // point outside the skin (hair, parts poking through): widen the search without the wall test
    for (let r = 1; !any && r <= 5; r++) {
      for (let dz = -r + 1; dz <= r; dz++) for (let dy = -r + 1; dy <= r; dy++) for (let dx = -r + 1; dx <= r; dx++) if (visit(x0 + dx, y0 + dy, z0 + dz, -1, -1)) any = true
    }
  }

  /**
   * 点 p 附近各关节的有效距离。`allow` 可限制候选关节。
   * Effective distance from p to the bones of the joints around it. `allow` restricts the candidates.
   *   e = 到骨面的精确欧氏距离 / exact Euclidean distance to the bone surface
   *   g = 网格测地距离（只在体内传播） / grid geodesic distance (propagated inside the body only)
   * g 与 e 相近时两者之间只有组织，取 e。g 明显更大时，从 p 向骨面最近点连一条线段：若它穿出
   * 皮肤再穿入（与皮肤表面相交两次以上，皮肤是双层壳），说明中间隔着空气，取 g；否则取 e。
   * Where g agrees with e there is only tissue in between and e is used. Where g is clearly larger,
   * the segment from p to the closest point of the bone is tested against the skin: leaving the
   * body and entering it again (two or more crossings; the skin is a double-walled shell) means
   * air in between and g is used, otherwise e.
   */
  query(p: V3, allow?: (joint: number) => boolean): Candidates {
    const grid = new Map<number, number>()
    this.gridCandidates(p, grid)
    const joints: number[] = [], dist: number[] = []
    const h = this.h
    for (const [j, g] of grid) {
      if (allow && !allow(j)) continue
      const c = this.byJoint.get(j)!.closest(p, g + h)
      joints.push(j)
      if (!c) {
        dist.push(g)
        continue
      }
      const e = c.distance
      if (g <= 1.1 * e + h || !this.skinSurface) {
        this.queryStats.direct++
        dist.push(e)
        continue
      }
      this.queryStats.tested++
      if (this.skinSurface.crossings(p, c.point, 0.0025) >= 2) {
        this.queryStats.obstructed++
        dist.push(Math.max(e, g - h))
      } else dist.push(e)
    }
    return { joints, dist }
  }

  /** 到指定关节骨面的精确欧氏距离（不经过体素场）。 Exact Euclidean distance to the bones of the given joints (bypassing the voxel field). */
  euclid(p: V3, jointList: number[], max = Infinity): Candidates {
    const joints: number[] = [], dist: number[] = []
    let best = max
    for (const j of jointList) {
      const s = this.byJoint.get(j)
      if (!s) continue
      // 只关心不比当前最近者远太多的骨 / only bones not much farther than the nearest so far matter
      const d = s.distance(p[0], p[1], p[2], best === Infinity ? Infinity : best * 3 + 0.05)
      if (!Number.isFinite(d)) continue
      joints.push(j)
      dist.push(d)
      if (d < best) best = d
    }
    return { joints, dist }
  }
}

/**
 * 由距离得到权重（紧支撑）：w_j = max(0, 1 − (d_j − d_min) / (β·(d_min + r_j)))²，再归一化。
 * 离最近的骨越深，过渡带越宽；紧贴骨面时过渡带宽度为 β·r_j（r_j 是该骨的混合半径）。
 * Weights from distances (compact support): w_j = max(0, 1 − (d_j − d_min) / (β·(d_min + r_j)))²,
 * normalised. The deeper the tissue lies from its nearest bone the wider the blend; right on a
 * bone the blend zone is β·r_j wide (r_j = blend radius of that bone).
 */
export function weightsFromDistances(c: Candidates, beta: number, radius: (joint: number) => number, out: Map<number, number>): void {
  out.clear()
  let dmin = Infinity
  for (const d of c.dist) if (d < dmin) dmin = d
  if (!Number.isFinite(dmin)) return
  let sum = 0
  for (let k = 0; k < c.joints.length; k++) {
    const j = c.joints[k]!
    const t = 1 - (c.dist[k]! - dmin) / (beta * (dmin + radius(j)))
    if (t <= 0) continue
    const w = t * t
    out.set(j, w)
    sum += w
  }
  for (const [j, w] of out) out.set(j, w / sum)
}
