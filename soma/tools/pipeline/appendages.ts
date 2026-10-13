// 体表附属物贴合到装入的皮肤上。男女两个人体通用。
// 头发、眉、睫毛、阴毛、甲、耳廓这些体表部件是为原来的（扫描的）皮肤做的；换上按内部结构拟合的参数化皮肤之后，
// 它们有的浮在皮肤外，有的陷在皮肤里。这里对每个部件做一次平滑形变，把它朝向皮肤的那一面放到新皮肤上：
//   毛发壳（头发、眉、睫毛、阴毛）：朝向皮肤的一面（内面）落到皮肤下 embed 处，外面按原来的厚度跟着走；
//   甲（甲板、甲周）：位移只沿皮肤法向，不沿手指滑动，所以仍在远节指骨上；每个甲的外面落到皮肤外 proud 处，
//     内面按原厚度跟着走——即随指尖皮肤抬起或落下；
//   耳廓：皮肤包自带耳朵，皮肤不透明时显示的是皮肤的耳。解剖耳廓是扫描得到的真实解剖，几何上原样保留、不做任何形变；
//     它列在报告的 hideWithOpaqueSkin 里：查看器在皮肤不透明时把它隐藏，皮肤隐去时再显示，这样两个耳不会同时露在外面。
// 位移方向一律取该处皮肤的外法向（顶点到皮肤最近点的连线），大小在部件自身的邻域内取高斯平均，所以是平滑的；
// 最后一遍只把“该落在皮肤上的那一面”的顶点精确放到目标深度。
//
// Conforming the appendages of the skin to an installed skin. Generic: both bodies use it.
// Hair of the head, eyebrows, eyelashes, pubic hair, nails and auricles are surface parts made for
// the original (scanned) skin; on a parametric skin fitted to the internals some float above the
// skin and some sink into it. Each part gets one smooth deformation that puts its skin-side surface
// onto the new skin:
//   hair shells (hair of head, eyebrow, eyelash, pubic hair): the side facing the skin (the inner
//     face) goes to `embed` under the skin and the outer face follows at the original thickness;
//   nails (nail plates, perionyx): displaced along the skin normal only, never along the finger, so
//     they stay on the distal phalanges; the outer face of each nail goes to `proud` above the skin
//     and the inner face follows at the original thickness — lifted or lowered with the fingertip skin;
//   auricle: a skin package has its own ears, and with the skin opaque the ear shown is the skin's.
//     The anatomical auricle is real scanned anatomy and is left geometrically as it is, with no
//     deformation at all; it is listed under hideWithOpaqueSkin in the report: a viewer hides it while
//     the skin is opaque and shows it when the skin is hidden, so the two ears never both stick out.
// The direction is always the outward normal of the skin there (the line from the nearest skin point
// to the vertex) and the amount is a Gaussian average over the part's own neighbourhood, so the
// deformation is smooth; a last pass puts just the vertices of the face that belongs on the skin
// exactly at the target depth.

import { computeNormals, measure, type Mesh } from './geometry.ts'
import { InsideTester, PointIndex, surfacePoints, thinPoints } from './register.ts'

export type AppendageKind = 'shell' | 'nail' | 'auricle'

/**
 * 按名称判断一个体表部件属于哪一类附属物；不是附属物返回 null。
 * Which kind of appendage a surface part is, by its name; null when it is none.
 */
export function appendageKind(name: string): AppendageKind | null {
  if (/\b(external ear|auricle|pinna)\b/i.test(name)) return 'auricle'
  if (/\b(nail|perionyx|eponychium|hyponychium|lunula)/i.test(name)) return 'nail'
  if (/\b(hair|eyebrows?|eyelash(es)?|cilia)\b/i.test(name)) return 'shell'
  return null
}

export interface AppendageOptions {
  /** 毛发壳的内面放到皮肤下这么深（米） / the inner face of a hair shell is put this far under the skin (m) */
  embed: number
  /** 甲的外面放到皮肤外这么高（米） / the outer face of a nail is put this far above the skin (m) */
  proud: number
  /** 位移取平均的邻域半径（米），按类别 / radius of the neighbourhood over which the displacement is averaged (m), per kind */
  radius: Record<'shell' | 'nail', number>
  /** 平滑的遍数（每遍重新量到皮肤的距离） / smoothing passes (the distance to the skin is measured again in each) */
  passes: number
  /** 顶点法向与皮肤外法向的点积超过此值才算朝外，低于其相反数才算朝内 / a vertex faces outwards when its normal · the skin's outward normal exceeds this, inwards below its negative */
  facing: number
  /** 离皮肤超过此距离的顶点不动（米） / vertices further than this from the skin are left alone (m) */
  maxDistance: number
}

export const APPENDAGE_DEFAULTS: AppendageOptions = {
  embed: 0.0005,
  proud: 0.0002,
  radius: { shell: 0.012, nail: 0.004 },
  passes: 3,
  facing: 0.2,
  maxDistance: 0.05,
}

export interface AppendagePart {
  id: string
  name: string
  mesh: Mesh
}

export interface DistanceStats {
  /** 表面采样点在皮肤外的比例 / share of the surface samples outside the skin */
  outside: number
  /** 到皮肤的有符号距离（毫米；正 = 在皮肤外） / signed distance to the skin (mm; positive = outside) */
  minMm: number
  medianMm: number
  p99Mm: number
  maxMm: number
}

export interface AppendageRow {
  id: string
  name: string
  kind: AppendageKind
  /** 整个表面到皮肤的距离，贴合前后 / the whole surface against the skin, before and after */
  before: DistanceStats
  after: DistanceStats
  /** 该落在皮肤上的那一面（毛发壳的内面、甲的外面；耳廓为整个表面）到皮肤的距离，贴合前后 / the face that belongs on the skin (inner face of a hair shell, outer face of a nail; the whole surface for an auricle) against the skin, before and after */
  skinSide: { face: 'inner' | 'outer' | 'all'; targetMm: number | null; vertices: number; before: DistanceStats; after: DistanceStats }
  /** 耳廓：被皮肤的耳取代，几何未动 / auricle: superseded by the skin's ear, geometry untouched */
  supersededBySkin?: boolean
  volumeMl: [number, number]
  displacementMm: { median: number; max: number }
  /** 离皮肤太远而没有动的顶点数 / vertices left alone for being too far from the skin */
  verticesOutOfReach: number
  components: number
}

export interface AppendageResult {
  /** 发生变化的部件：id → 新网格 / the parts that changed: id → new mesh */
  moved: Map<string, Mesh>
  report: {
    auricle: { shown: 'skin'; note: string }
    /**
     * 被皮肤自带的同一结构取代的部件（耳廓）的 id：几何未动；皮肤不透明时应隐藏，皮肤隐去时显示。
     * Ids of the parts superseded by the skin's own version of the same structure (the auricles): geometry
     * untouched; to be hidden while the skin is opaque and shown when the skin is hidden.
     */
    hideWithOpaqueSkin: string[]
    options: AppendageOptions
    parts: AppendageRow[]
    /** 传进来但不属于任何一类附属物的部件 / parts passed in that are no appendage of any kind */
    notHandled: string[]
  }
}

/**
 * 三角网格上的最近点查询（三角形装在均匀网格里）。
 * Closest point on a triangle mesh (triangles binned in a uniform grid).
 */
class ClosestPoint {
  private readonly cells = new Map<number, number[]>()
  private readonly o: [number, number, number]
  private readonly n: [number, number, number]
  /** 最近一次查询的结果：最近点和所在三角形 / result of the last query: the closest point and its triangle */
  readonly q: [number, number, number] = [0, 0, 0]
  tri = -1
  constructor(private readonly mesh: Mesh, private readonly cell = 0.006) {
    const p = mesh.positions
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k]!, p[i + k]!)
      b[k + 3] = Math.max(b[k + 3]!, p[i + k]!)
    }
    this.o = [b[0]!, b[1]!, b[2]!]
    this.n = [0, 1, 2].map((k) => Math.floor((b[k + 3]! - b[k]!) / cell) + 1) as [number, number, number]
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const lo = [Infinity, Infinity, Infinity]
      const hi = [-Infinity, -Infinity, -Infinity]
      for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) {
        const v = p[3 * mesh.indices[t + c]! + k]!
        lo[k] = Math.min(lo[k]!, v)
        hi[k] = Math.max(hi[k]!, v)
      }
      const r = [0, 1, 2].map((k) => [this.ix(lo[k]!, k), this.ix(hi[k]!, k)])
      for (let k = r[2]![0]!; k <= r[2]![1]!; k++) for (let j = r[1]![0]!; j <= r[1]![1]!; j++) for (let i = r[0]![0]!; i <= r[0]![1]!; i++) {
        const key = i + this.n[0] * (j + this.n[1] * k)
        let list = this.cells.get(key)
        if (!list) this.cells.set(key, (list = []))
        list.push(t)
      }
    }
  }
  private ix(v: number, k: number): number {
    return Math.max(0, Math.min(this.n[k]! - 1, Math.floor((v - this.o[k]!) / this.cell)))
  }
  /** 到表面的距离，最近点写入 `q`、三角形写入 `tri`；`max` 以内没有表面时返回 Infinity / distance to the surface, with the closest point in `q` and its triangle in `tri`; Infinity when there is no surface within `max` */
  distance(x: number, y: number, z: number, max: number): number {
    const ci = Math.floor((x - this.o[0]) / this.cell)
    const cj = Math.floor((y - this.o[1]) / this.cell)
    const ck = Math.floor((z - this.o[2]) / this.cell)
    let best = max
    this.tri = -1
    const rings = Math.ceil(max / this.cell) + 1
    for (let r = 0; r <= rings; r++) {
      if ((r - 1) * this.cell > best) break
      for (let k = ck - r; k <= ck + r; k++) {
        if (k < 0 || k >= this.n[2]) continue
        for (let j = cj - r; j <= cj + r; j++) {
          if (j < 0 || j >= this.n[1]) continue
          for (let i = ci - r; i <= ci + r; i++) {
            if (i < 0 || i >= this.n[0]) continue
            if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue
            const list = this.cells.get(i + this.n[0] * (j + this.n[1] * k))
            if (!list) continue
            for (const t of list) {
              const d = this.toTriangle(x, y, z, t)
              if (d < best) {
                best = d
                this.tri = t
                this.q[0] = this.c[0]
                this.q[1] = this.c[1]
                this.q[2] = this.c[2]
              }
            }
          }
        }
      }
    }
    return this.tri < 0 ? Infinity : best
  }
  private readonly c: [number, number, number] = [0, 0, 0]
  /** 点到三角形的距离，最近点写入 `c`（Ericson, Real-Time Collision Detection 5.1.5） / distance from a point to a triangle, the closest point going to `c` (Ericson, Real-Time Collision Detection 5.1.5) */
  private toTriangle(px: number, py: number, pz: number, t: number): number {
    const v = this.mesh.positions
    const a = 3 * this.mesh.indices[t]!
    const b = 3 * this.mesh.indices[t + 1]!
    const c = 3 * this.mesh.indices[t + 2]!
    const ax = v[a]!, ay = v[a + 1]!, az = v[a + 2]!
    const abx = v[b]! - ax, aby = v[b + 1]! - ay, abz = v[b + 2]! - az
    const acx = v[c]! - ax, acy = v[c + 1]! - ay, acz = v[c + 2]! - az
    const apx = px - ax, apy = py - ay, apz = pz - az
    const d1 = abx * apx + aby * apy + abz * apz
    const d2 = acx * apx + acy * apy + acz * apz
    let qx: number, qy: number, qz: number
    if (d1 <= 0 && d2 <= 0) {
      qx = ax; qy = ay; qz = az
    } else {
      const bpx = px - v[b]!, bpy = py - v[b + 1]!, bpz = pz - v[b + 2]!
      const d3 = abx * bpx + aby * bpy + abz * bpz
      const d4 = acx * bpx + acy * bpy + acz * bpz
      const cpx = px - v[c]!, cpy = py - v[c + 1]!, cpz = pz - v[c + 2]!
      const d5 = abx * cpx + aby * cpy + abz * cpz
      const d6 = acx * cpx + acy * cpy + acz * cpz
      const vc = d1 * d4 - d3 * d2
      const vb = d5 * d2 - d1 * d6
      const va = d3 * d6 - d5 * d4
      if (d3 >= 0 && d4 <= d3) {
        qx = v[b]!; qy = v[b + 1]!; qz = v[b + 2]!
      } else if (d6 >= 0 && d5 <= d6) {
        qx = v[c]!; qy = v[c + 1]!; qz = v[c + 2]!
      } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const s = d1 / (d1 - d3)
        qx = ax + s * abx; qy = ay + s * aby; qz = az + s * abz
      } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const s = d2 / (d2 - d6)
        qx = ax + s * acx; qy = ay + s * acy; qz = az + s * acz
      } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const s = (d4 - d3) / (d4 - d3 + (d5 - d6))
        qx = v[b]! + s * (v[c]! - v[b]!); qy = v[b + 1]! + s * (v[c + 1]! - v[b + 1]!); qz = v[b + 2]! + s * (v[c + 2]! - v[b + 2]!)
      } else {
        const den = 1 / (va + vb + vc)
        const s = vb * den
        const u = vc * den
        qx = ax + abx * s + acx * u; qy = ay + aby * s + acy * u; qz = az + abz * s + acz * u
      }
    }
    this.c[0] = qx
    this.c[1] = qy
    this.c[2] = qz
    return Math.hypot(px - qx, py - qy, pz - qz)
  }
}

/** 连通分量：每个顶点的分量编号 / connected components: a component number per vertex */
function componentsOf(mesh: Mesh): { of: Int32Array; count: number } {
  const nv = mesh.positions.length / 3
  const parent = Int32Array.from({ length: nv }, (_, i) => i)
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!
      a = parent[a]!
    }
    return a
  }
  const idx = mesh.indices
  for (let t = 0; t < idx.length; t += 3) for (const [a, b] of [[idx[t]!, idx[t + 1]!], [idx[t + 1]!, idx[t + 2]!]] as const) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  const id = new Map<number, number>()
  const of = new Int32Array(nv)
  for (let i = 0; i < nv; i++) {
    const r = find(i)
    if (!id.has(r)) id.set(r, id.size)
    of[i] = id.get(r)!
  }
  return { of, count: id.size }
}

/**
 * 把附属物贴合到皮肤上。`skin` 是装入的皮肤（单层封闭曲面）；`parts` 里不属于附属物的部件原样跳过并在报告里列出。
 * 女性构建的调用方式与男性相同：`conformAppendages(skinMesh, integumentaryParts.map(p => ({ id, name, mesh })))`，
 * 然后把 `moved` 里的网格换回去，被形变的部件标为 warped。
 * Conforms appendages to the skin. `skin` is the installed skin (a closed single-walled surface);
 * parts that are no appendage are skipped as they are and listed in the report. The female build
 * calls it exactly as the male one does: `conformAppendages(skinMesh, integumentaryParts.map(p =>
 * ({ id, name, mesh })))`, then puts the meshes of `moved` back and labels the deformed parts warped.
 */
export function conformAppendages(skin: Mesh, parts: AppendagePart[], opts: AppendageOptions = APPENDAGE_DEFAULTS): AppendageResult {
  const tester = new InsideTester(skin, 256)
  const closest = new ClosestPoint(skin)
  // 皮肤三角形的外法向：按所围体积的符号定向 / outward normals of the skin's triangles, oriented by the sign of the enclosed volume
  const outward = Math.sign(measure(skin).signedVolume) || 1
  const faceNormal = (t: number): [number, number, number] => {
    const p = skin.positions
    const a = 3 * skin.indices[t]!
    const b = 3 * skin.indices[t + 1]!
    const c = 3 * skin.indices[t + 2]!
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
    const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
    const l = (Math.hypot(n[0], n[1], n[2]) || 1) * outward
    return [n[0] / l, n[1] / l, n[2] / l]
  }
  /** 各点到皮肤的有符号距离（米；正 = 在皮肤外；够不着为 NaN）和该处皮肤的外法向 / signed distance of each point to the skin (m; positive = outside; NaN when out of reach) and the skin's outward direction there */
  const against = (pts: Float32Array): { s: Float32Array; n: Float32Array } => {
    const s = new Float32Array(pts.length / 3)
    const n = new Float32Array(pts.length)
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i]!, y = pts[i + 1]!, z = pts[i + 2]!
      const d = closest.distance(x, y, z, opts.maxDistance)
      if (!Number.isFinite(d)) {
        s[i / 3] = NaN
        continue
      }
      const inside = tester.contains(x, y, z)
      s[i / 3] = inside ? -d : d
      if (d > 0.0003) {
        const k = (inside ? -1 : 1) / d
        n[i] = (x - closest.q[0]) * k
        n[i + 1] = (y - closest.q[1]) * k
        n[i + 2] = (z - closest.q[2]) * k
      } else {
        const f = faceNormal(closest.tri)
        n[i] = f[0]
        n[i + 1] = f[1]
        n[i + 2] = f[2]
      }
    }
    return { s, n }
  }
  const stats = (pts: Float32Array): DistanceStats => {
    const { s } = against(pts)
    const d = Array.from(s).filter((v) => Number.isFinite(v)).map((v) => v * 1000).sort((a, b) => a - b)
    const r1 = (v: number) => Math.round(v * 10) / 10
    const m = d.length
    return m ? { outside: Math.round((d.filter((v) => v > 0).length / m) * 1e4) / 1e4, minMm: r1(d[0]!), medianMm: r1(d[m >> 1]!), p99Mm: r1(d[Math.floor(0.99 * (m - 1))]!), maxMm: r1(d[m - 1]!) } : { outside: 0, minMm: 0, medianMm: 0, p99Mm: 0, maxMm: 0 }
  }
  const pick = (v: Float32Array, sel: number[]): Float32Array => {
    const out = new Float32Array(sel.length * 3)
    sel.forEach((i, j) => out.set(v.subarray(3 * i, 3 * i + 3), 3 * j))
    return out
  }

  const moved = new Map<string, Mesh>()
  const rows: AppendageRow[] = []
  const notHandled: string[] = []
  const hideWithOpaqueSkin: string[] = []
  for (const part of parts) {
    const kind = appendageKind(part.name)
    if (!kind) {
      notHandled.push(part.name)
      continue
    }
    const src = part.mesh.positions
    const nv = src.length / 3
    const comp = componentsOf(part.mesh)
    if (kind === 'auricle') {
      // 不动：只量它相对皮肤的位置，并登记为“皮肤不透明时隐藏” / untouched: only measured against the skin and listed as "hide while the skin is opaque"
      const st = stats(thinPoints(surfacePoints(part.mesh, 0.002), 0.002))
      const vol = Math.round(Math.abs(measure(part.mesh).signedVolume) * 1e8) / 100
      hideWithOpaqueSkin.push(part.id)
      rows.push({ id: part.id, name: part.name, kind, before: st, after: st, skinSide: { face: 'all', targetMm: null, vertices: nv, before: st, after: st }, supersededBySkin: true, volumeMl: [vol, vol], displacementMm: { median: 0, max: 0 }, verticesOutOfReach: 0, components: comp.count })
      continue
    }
    // 毛发壳按整个部件取邻域（眉由几百根互不相连的小毛组成，逐根处理会让零星的几根飞出去）；甲按每个甲各自取
    // hair shells take their neighbourhood over the whole part (an eyebrow is hundreds of unconnected tufts, and handled one by one a few of them fly off); nails each over their own nail
    const same = (a: number, b: number) => kind !== 'nail' || comp.of[a] === comp.of[b]
    // 部件自身的外法向（按所围体积的符号定向；镜像得到的一侧绕向相反）
    // the part's own outward normals (oriented by the sign of the enclosed volume: a mirrored side has the opposite winding)
    const partSign = Math.sign(measure(part.mesh).signedVolume) || 1
    const vn = computeNormals(part.mesh)
    const first = against(src)
    // 该落在皮肤上的那一面：毛发壳的内面，甲的外面 / the face that belongs on the skin: the inner face of a hair shell, the outer face of a nail
    const face: 'inner' | 'outer' = kind === 'shell' ? 'inner' : 'outer'
    const target = kind === 'shell' ? -opts.embed : opts.proud
    const anchor: number[] = []
    for (let i = 0; i < nv; i++) {
      if (Number.isNaN(first.s[i]!)) continue
      const dot = (vn[3 * i]! * first.n[3 * i]! + vn[3 * i + 1]! * first.n[3 * i + 1]! + vn[3 * i + 2]! * first.n[3 * i + 2]!) * partSign
      if (face === 'inner' ? dot < -opts.facing : dot > opts.facing) anchor.push(i)
    }
    const outOfReach = Array.from(first.s).filter((v) => Number.isNaN(v)).length
    const samplesBefore = thinPoints(surfacePoints(part.mesh, 0.002), 0.002)
    const sideBefore = stats(pick(src, anchor))
    if (anchor.length < 3) {
      notHandled.push(`${part.name} (no ${face} face found)`)
      continue
    }
    const R = opts.radius[kind]
    const cur = Float32Array.from(src)
    // 邻域：半径 R 以内的锚点（甲：限同一个甲）；一个也没有时取最近的锚点
    // neighbourhood: the anchor vertices within R (nails: of the same nail); the nearest one when there is none
    const K = 64
    const I = new Int32Array(K)
    const D = new Float64Array(K)
    for (let pass = 0; pass < opts.passes; pass++) {
      const a = against(cur)
      const ap = pick(cur, anchor)
      const index = new PointIndex(ap, R)
      // 每个锚点想要的法向位移：到目标深度 / the normal displacement each anchor vertex asks for: to the target depth
      const want = new Float32Array(anchor.length)
      anchor.forEach((i, j) => {
        const s = a.s[i]!
        want[j] = Number.isNaN(s) ? 0 : target - s
      })
      const next = Float32Array.from(cur)
      const sigma2 = (R / 2) ** 2
      for (let i = 0; i < nv; i++) {
        if (Number.isNaN(a.s[i]!)) continue
        const x = cur[3 * i]!, y = cur[3 * i + 1]!, z = cur[3 * i + 2]!
        let n = index.nearest(x, y, z, K, I, D, R)
        if (!n) n = index.nearest(x, y, z, 1, I, D)
        let w = 0
        let ux = 0
        let uy = 0
        let uz = 0
        for (let j = 0; j < n; j++) {
          const v = anchor[I[j]!]!
          if (!same(v, i)) continue
          const g = n === 1 ? 1 : Math.exp(-D[j]! / (2 * sigma2))
          w += g
          ux += g * want[I[j]!]! * a.n[3 * v]!
          uy += g * want[I[j]!]! * a.n[3 * v + 1]!
          uz += g * want[I[j]!]! * a.n[3 * v + 2]!
        }
        if (!w) continue
        next[3 * i] = x + ux / w
        next[3 * i + 1] = y + uy / w
        next[3 * i + 2] = z + uz / w
      }
      cur.set(next)
    }
    // 最后一遍：锚点精确到位；其余顶点取小邻域（R/2）内锚点修正量的平均，
    // 这样薄壳（甲板、眉）的另一面跟着同一处的锚点走，厚度不被这一遍改掉。
    // The last pass: the anchor vertices exactly in place; the other vertices take the mean of the anchors' corrections within a small neighbourhood
    // (R/2), so that the other face of a thin shell (nail plate, eyebrow) goes with the anchors at the same
    // place and this pass does not change the thickness.
    {
      const a = against(cur)
      const ap = pick(cur, anchor)
      const index = new PointIndex(ap, R / 2)
      const fix = new Float32Array(anchor.length * 3)
      const isAnchor = new Uint8Array(nv)
      anchor.forEach((i, j) => {
        isAnchor[i] = 1
        const s = a.s[i]!
        if (Number.isNaN(s)) return
        const d = target - s
        for (let k = 0; k < 3; k++) fix[3 * j + k] = d * a.n[3 * i + k]!
      })
      const sigma2 = (R / 4) ** 2
      for (let i = 0; i < nv; i++) {
        if (isAnchor[i] || Number.isNaN(a.s[i]!)) continue
        const x = cur[3 * i]!, y = cur[3 * i + 1]!, z = cur[3 * i + 2]!
        let n = index.nearest(x, y, z, K, I, D, R / 2)
        if (!n) n = index.nearest(x, y, z, 1, I, D)
        let w = 0
        const u = [0, 0, 0]
        for (let j = 0; j < n; j++) {
          if (!same(anchor[I[j]!]!, i)) continue
          const g = n === 1 ? 1 : Math.exp(-D[j]! / (2 * sigma2))
          w += g
          for (let k = 0; k < 3; k++) u[k] = u[k]! + g * fix[3 * I[j]! + k]!
        }
        if (w) for (let k = 0; k < 3; k++) cur[3 * i + k] = cur[3 * i + k]! + u[k]! / w
      }
      anchor.forEach((i, j) => {
        for (let k = 0; k < 3; k++) cur[3 * i + k] = cur[3 * i + k]! + fix[3 * j + k]!
      })
    }
    const mesh: Mesh = { positions: cur, indices: part.mesh.indices }
    const disp: number[] = []
    for (let i = 0; i < nv; i++) disp.push(Math.hypot(cur[3 * i]! - src[3 * i]!, cur[3 * i + 1]! - src[3 * i + 1]!, cur[3 * i + 2]! - src[3 * i + 2]!) * 1000)
    disp.sort((x, y) => x - y)
    const r2 = (v: number) => Math.round(v * 100) / 100
    rows.push({
      id: part.id, name: part.name, kind,
      before: stats(samplesBefore), after: stats(thinPoints(surfacePoints(mesh, 0.002), 0.002)),
      skinSide: { face, targetMm: target * 1000, vertices: anchor.length, before: sideBefore, after: stats(pick(cur, anchor)) },
      volumeMl: [r2(Math.abs(measure(part.mesh).signedVolume) * 1e6), r2(Math.abs(measure(mesh).signedVolume) * 1e6)],
      displacementMm: { median: r2(disp[nv >> 1] ?? 0), max: r2(disp[nv - 1] ?? 0) },
      verticesOutOfReach: outOfReach, components: comp.count,
    })
    if ((disp[nv - 1] ?? 0) > 0.001) moved.set(part.id, mesh)
  }
  return {
    moved,
    report: {
      auricle: { shown: 'skin', note: 'superseded by the skin\'s ear when the skin is opaque: the anatomical auricle is left geometrically as scanned and listed in hideWithOpaqueSkin, to be hidden while the skin is opaque and shown when the skin is hidden' },
      hideWithOpaqueSkin, options: opts, parts: rows, notHandled,
    },
  }
}
