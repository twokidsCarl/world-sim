// 在某一人体上求值的小型“体表标志语言”：由具名骨骼导出的点、肢体坐标架，以及这些点向皮肤外壁的投影。
// 整理好的定义文件（data/curated/skinmaps/*.json）即用这种语言写成，审校者移动种子或边界时无需改代码。语法见 data/curated/skinmaps/README.md。
// A small landmark language evaluated on one body: points derived from named bones, limb frames,
// and projections of those points onto the outer skin. The curated definitions
// (data/curated/skinmaps/*.json) are written in this language so that a reviewer can move a
// seed or a boundary without touching code. See data/curated/skinmaps/README.md for the grammar.

import type { Body, RawMesh } from './io.ts'
import { add, cross, dist, dot, lerp, mul, norm, nrm, pos, sub, type Skin, type V3 } from './mesh.ts'

export type SideLR = 'L' | 'R'
export type Dir = string | [number, number, number]

export type PointExpr =
  | string
  | { part: string; pick?: 'centroid' | { extreme: Dir; within?: { axis: Dir; frac: [number, number] }; half?: boolean } | { slice: { axis: Dir; frac: [number, number] }; half?: boolean } }
  | { lerp: [PointExpr, PointExpr, number] }
  | { xyz: [PointExpr, PointExpr, PointExpr] }
  | { offset: [PointExpr, [number, number, number]] }
  /**
   * 把点 A 平移 (to − from)：用于把一处量得的位移照搬到另一处。
   * Point A moved by (to − from): carries a displacement measured in one place over to another.
   */
  | { shift: [PointExpr, PointExpr, PointExpr] }
  | { frame: string; t: number }
  /**
   * 神经中心线与过 x 的矢状面相交处的点（躯干前面或后面）。
   * The point of a nerve's centreline where it crosses the sagittal plane through `x` (front or back of the trunk).
   */
  | { nervePoint: string; x: PointExpr; back?: boolean }

export type SkinExpr =
  | string
  | { at: PointExpr; to?: 'nearest' | 'nearestAny' | 'trunkRadial' | Dir | { awayFrom: PointExpr } }
  | { at: PointExpr; frame: string; deg: number }
  | { frame: string; t: number; deg: number }
  | { dimple: { between: [PointExpr, PointExpr] } }
  /**
   * 神经的体表投影（自躯干轴线向外的径向投影）与过某点的矢状面在躯干前面相交处。
   * Where a nerve's skin projection (radially out of the trunk) crosses the sagittal plane through a point, on the front of the trunk.
   */
  | { nerveCross: string; x: PointExpr; back?: boolean }
  | { skinExtreme: { dir: Dir; near: PointExpr; radiusMm: number } }

export interface FrameDef {
  origin: PointExpr
  end: PointExpr
  /**
   * 起点处的内侧→外侧参考方向；可另给终点处的（用于有扭转的坐标架，如前臂）。
   * Medial→lateral reference at the origin, and optionally at the end (frames that twist, e.g. the forearm).
   */
  lat0: [PointExpr, PointExpr]
  lat1?: [PointExpr, PointExpr]
  /**
   * 仅用于躯干坐标架：此点以外侧的皮肤属于上肢而非躯干。
   * Trunk frame only: skin lateral to this point belongs to the arm, not the trunk.
   */
  armLimit?: PointExpr
}

export interface LandmarkFile {
  frames: Record<string, FrameDef>
  points: Record<string, PointExpr | SkinExpr>
}

export interface Frame {
  origin: V3
  end: V3
  axis: V3
  lat0: V3
  lat1: V3
  armLimit?: PointExpr
}

const TOKENS: Record<string, [number, number, number]> = {
  lat: [1, 0, 0], med: [-1, 0, 0], sup: [0, 1, 0], inf: [0, -1, 0], ant: [0, 0, 1], post: [0, 0, -1],
}

export class Landmarks {
  private readonly partByName = new Map<string, string>()
  private readonly pointCache = new Map<string, V3>()
  private readonly skinCache = new Map<string, number>()
  private readonly surfaceCache = new Map<string, V3>()
  private readonly frameCache = new Map<string, Frame>()
  private readonly outerList: number[] = []

  constructor(
    readonly body: Body,
    readonly bones: Map<string, RawMesh>,
    readonly skin: Skin,
    readonly file: LandmarkFile,
  ) {
    for (const p of body.data.parts) {
      const k = p.name.toLowerCase()
      // 所用部件的名称唯一；遇重名（如籽骨）取第一个。
      // Names are unique for the parts we use; keep the first on duplicates (e.g. sesamoids).
      if (!this.partByName.has(k)) this.partByName.set(k, p.id)
    }
    for (let i = 0; i < skin.n; i++) if (skin.outer[i]) this.outerList.push(i)
  }

  partName(pattern: string, side: SideLR): string {
    return pattern.replaceAll('{side}', side === 'L' ? 'left' : 'right')
  }

  partId(pattern: string, side: SideLR): string {
    const id = this.partByName.get(this.partName(pattern, side).toLowerCase())
    if (!id) throw new Error(`no part named "${this.partName(pattern, side)}"`)
    return id
  }

  hasPart(pattern: string, side: SideLR): boolean {
    return this.partByName.has(this.partName(pattern, side).toLowerCase())
  }

  dir(d: Dir, side: SideLR): V3 {
    let v: V3 = [0, 0, 0]
    if (typeof d === 'string') {
      for (const tok of d.split('+')) {
        const m = /^(-?[\d.]+\*)?(\w+)$/.exec(tok.trim())
        const base = m && TOKENS[m[2]!]
        if (!base) throw new Error(`bad direction "${d}"`)
        v = add(v, mul(base, m![1] ? parseFloat(m![1]) : 1))
      }
    } else v = [d[0], d[1], d[2]]
    // “lat” 在身体左侧为 +X，在右侧为 -X。
    // "lat" is +X on the body's left and -X on its right.
    return norm([side === 'L' ? v[0] : -v[0], v[1], v[2]])
  }

  private mesh(pattern: string, side: SideLR): RawMesh {
    const m = this.bones.get(this.partId(pattern, side))
    if (!m) throw new Error(`part "${this.partName(pattern, side)}" has no mesh in the loaded GLBs`)
    return m
  }

  point(e: PointExpr, side: SideLR): V3 {
    if (typeof e === 'string') {
      const key = `${e}|${side}`
      const hit = this.pointCache.get(key)
      if (hit) return hit
      const def = this.file.points[e]
      if (def === undefined) throw new Error(`unknown landmark "${e}"`)
      const p = isSkinExpr(def) ? pos(this.skin, this.vertex(def, side)) : this.point(def as PointExpr, side)
      this.pointCache.set(key, p)
      return p
    }
    if ('part' in e) {
      const m = this.mesh(e.part, side)
      const n = m.positions.length / 3
      const pick = e.pick ?? 'centroid'
      const P = (i: number): V3 => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!]
      const halfOk = (p: V3, half?: boolean) => !half || (side === 'L' ? p[0] > this.skin.midX + 0.004 : p[0] < this.skin.midX - 0.004)
      const window = (w: { axis: Dir; frac: [number, number] } | undefined, half?: boolean) => {
        const idx: number[] = []
        if (!w) {
          for (let i = 0; i < n; i++) if (halfOk(P(i), half)) idx.push(i)
          return idx
        }
        const a = this.dir(w.axis, side)
        let lo = Infinity, hi = -Infinity
        for (let i = 0; i < n; i++) {
          const s = dot(P(i), a)
          if (s < lo) lo = s
          if (s > hi) hi = s
        }
        // frac 0 为沿轴方向的最远端（如 axis 为 inf、frac [0, 0.1] 即最低的十分之一）。
        // frac 0 is the far end along the axis direction (e.g. axis "inf", frac [0, 0.1] = lowest tenth).
        for (let i = 0; i < n; i++) {
          const f = (hi - dot(P(i), a)) / (hi - lo || 1)
          if (f >= w.frac[0] && f <= w.frac[1] && halfOk(P(i), half)) idx.push(i)
        }
        return idx
      }
      if (pick === 'centroid') {
        let c: V3 = [0, 0, 0]
        for (let i = 0; i < n; i++) c = add(c, P(i))
        return mul(c, 1 / n)
      }
      if ('slice' in pick) {
        const idx = window(pick.slice, pick.half)
        if (!idx.length) throw new Error(`empty slice on ${e.part}`)
        let c: V3 = [0, 0, 0]
        for (const i of idx) c = add(c, P(i))
        return mul(c, 1 / idx.length)
      }
      const idx = window(pick.within, pick.half)
      if (!idx.length) throw new Error(`empty window on ${e.part}`)
      const d = this.dir(pick.extreme, side)
      let best = idx[0]!, bs = -Infinity
      for (const i of idx) {
        const s = dot(P(i), d)
        if (s > bs) { bs = s; best = i }
      }
      return P(best)
    }
    if ('nervePoint' in e) {
      const x = Math.abs(this.point(e.x, side)[0] - this.skin.midX)
      const frontZ = this.frame('trunk', side).origin[2]
      const path = this.body.nerves.find((n) => n.part === this.partId(e.nervePoint, side))
      if (!path) throw new Error(`no centreline for "${e.nervePoint}"`)
      let best: V3 | null = null, bd = Infinity
      for (const b of path.branches)
        for (let i = 0; i + 3 < b.points.length; i += 3) {
          const p: V3 = [b.points[i]!, b.points[i + 1]!, b.points[i + 2]!], q: V3 = [b.points[i + 3]!, b.points[i + 4]!, b.points[i + 5]!]
          const xp = Math.abs(p[0] - this.skin.midX), xq = Math.abs(q[0] - this.skin.midX)
          const onBack = (p[2] + q[2]) / 2 < frontZ
          if (onBack !== !!e.back) continue
          if ((xp - x) * (xq - x) <= 0 && xp !== xq) return lerp(p, q, (x - xp) / (xq - xp))
          const d = Math.min(Math.abs(xp - x), Math.abs(xq - x))
          if (d < bd) { bd = d; best = Math.abs(xp - x) < Math.abs(xq - x) ? p : q }
        }
      if (!best) throw new Error(`nervePoint found nothing for "${e.nervePoint}"`)
      return best
    }
    if ('lerp' in e) return lerp(this.point(e.lerp[0], side), this.point(e.lerp[1], side), e.lerp[2])
    if ('xyz' in e) return [this.point(e.xyz[0], side)[0], this.point(e.xyz[1], side)[1], this.point(e.xyz[2], side)[2]]
    if ('shift' in e) return add(this.point(e.shift[0], side), sub(this.point(e.shift[2], side), this.point(e.shift[1], side)))
    if ('offset' in e) {
      const p = this.point(e.offset[0], side), o = e.offset[1]
      return [p[0] + (side === 'L' ? o[0] : -o[0]), p[1] + o[1], p[2] + o[2]]
    }
    const f = this.frame(e.frame, side)
    return lerp(f.origin, f.end, e.t)
  }

  frame(name: string, side: SideLR): Frame {
    const key = `${name}|${side}`
    const hit = this.frameCache.get(key)
    if (hit) return hit
    const def = this.file.frames[name]
    if (!def) throw new Error(`unknown frame "${name}"`)
    const origin = this.point(def.origin, side), end = this.point(def.end, side)
    const axis = norm(sub(end, origin))
    const orth = (pair: [PointExpr, PointExpr]): V3 => {
      const v = sub(this.point(pair[1], side), this.point(pair[0], side))
      return norm(sub(v, mul(axis, dot(v, axis))))
    }
    const lat0 = orth(def.lat0)
    const f: Frame = { origin, end, axis, lat0, lat1: def.lat1 ? orth(def.lat1) : lat0, armLimit: def.armLimit }
    this.frameCache.set(key, f)
    return f
  }

  /**
   * 坐标架轴线上参数 t 处、绕轴 deg 度的方向：0 = 解剖学前方（屈侧；手为掌侧，足的坐标架自足跟指向足趾，故为足背），90 = 外侧（桡侧、腓侧），180 = 后方，270 = 内侧。
   * Direction at `deg` around a frame's axis at parameter t: 0 = anatomical anterior (flexor side;
   * palmar on the hand, dorsal on the foot whose frame runs heel→toes), 90 = lateral (radial,
   * fibular), 180 = posterior, 270 = medial.
   */
  frameDir(name: string, t: number, deg: number, side: SideLR): V3 {
    const f = this.frame(name, side)
    const tt = Math.min(1, Math.max(0, t))
    const l = norm(lerp(f.lat0, f.lat1, tt))
    const lat = norm(sub(l, mul(f.axis, dot(l, f.axis))))
    const ant = side === 'R' ? cross(lat, f.axis) : cross(f.axis, lat)
    const a = (deg * Math.PI) / 180
    return norm(add(mul(ant, Math.cos(a)), mul(lat, Math.sin(a))))
  }

  /**
   * 某点沿坐标架轴线的参数（0 = 起点，1 = 终点）。
   * Parameter of a point along a frame's axis (0 = origin, 1 = end).
   */
  frameT(name: string, p: V3, side: SideLR): number {
    const f = this.frame(name, side)
    return dot(sub(p, f.origin), f.axis) / dist(f.origin, f.end)
  }

  /**
   * 自躯干轴线经躯干内某点水平向外的射线所击中的皮肤顶点。
   * Skin vertex hit by the horizontal ray from the trunk's axis through a point inside the trunk.
   */
  trunkRadial(p: V3, side: SideLR): number {
    const f = this.frame('trunk', side)
    const t = (p[1] - f.origin[1]) / (f.end[1] - f.origin[1])
    const c: V3 = [f.origin[0] + (f.end[0] - f.origin[0]) * t, p[1], f.origin[2] + (f.end[2] - f.origin[2]) * t]
    // 上臂与胸壁在皮肤网格中粘连之处，射线会从上臂穿出：击中点在肩关节外侧（留 12 mm 余量）或距离超过 12 cm 时，不算躯干皮肤（返回 -1）。
    // Where the upper arm is fused to the chest wall in the skin mesh the ray comes out on the
    // arm instead: a hit lateral to the shoulder joint (less a 12 mm margin) or more than 12 cm
    // away is not trunk skin (-1).
    const d = norm([p[0] - c[0], 0, p[2] - c[2]])
    const v = this.rayVertex(p, d, 0.12)
    if (v < 0 || !this.lastHit) return -1
    if (f.armLimit) {
      const limit = Math.abs(this.point(f.armLimit, side)[0] - this.skin.midX) - 0.012
      if (Math.abs(this.lastHit[0] - this.skin.midX) > limit) return -1
    }
    return v
  }

  /**
   * 最近一次 rayVertex 成功击中的精确表面点（用于比网格更细的种子）。
   * Exact surface point of the last successful `rayVertex` hit (for seeds finer than the mesh).
   */
  lastHit: V3 | null = null

  /**
   * 射线与外壁的第一个交点；未击中时退回到最近的外壁顶点。
   * First outer-wall hit of a ray; falls back to the nearest outer vertex when it misses.
   */
  rayVertex(origin: V3, d: V3, maxDist = Infinity): number {
    const hits = this.skin.outerBvh.hits(origin, d)
    const h = hits.find((x) => x.t > 1e-5)
    this.lastHit = null
    if (h && h.t > maxDist) return -1
    if (!h) return maxDist < Infinity ? -1 : this.nearestVertex(origin, false)
    this.lastHit = h.point
    let best = -1, bd = Infinity
    for (const v of this.skin.outerBvh.faceVerts(h.face)) {
      const dd = dist(pos(this.skin, v), h.point)
      if (dd < bd) { bd = dd; best = v }
    }
    return best
  }

  /**
   * 最近的外壁顶点。beneath 为真时，只计该点位于其下方的皮肤（皮肤法线背离该点），这样上臂内的神经不会落到胸壁上。
   * Nearest outer-wall vertex. With `beneath`, only skin that the point lies under counts (the
   * skin normal points away from the point), so a nerve in the arm never lands on the chest wall.
   */
  nearestVertex(p: V3, beneath = true, maxDist = Infinity): number {
    let best = -1, bd = maxDist
    for (const v of this.outerList) {
      const dx = this.skin.positions[v * 3]! - p[0], dy = this.skin.positions[v * 3 + 1]! - p[1], dz = this.skin.positions[v * 3 + 2]! - p[2]
      const d = Math.hypot(dx, dy, dz)
      if (d >= bd) continue
      if (beneath && d > 1e-4) {
        const nn = nrm(this.skin, v)
        if (dx * nn[0] + dy * nn[1] + dz * nn[2] < 0.2 * d) continue
      }
      bd = d
      best = v
    }
    if (best < 0 && beneath && maxDist === Infinity) return this.nearestVertex(p, false)
    return best
  }

  vertex(e: SkinExpr | PointExpr, side: SideLR): number {
    const key = `${typeof e === 'string' ? e : JSON.stringify(e)}|${side}`
    const hit = this.skinCache.get(key)
    if (hit !== undefined) return hit
    this.lastHit = null
    const v = this.vertexUncached(e, side)
    const h = this.lastHit as V3 | null
    this.skinCache.set(key, v)
    this.surfaceCache.set(key, h && dist(h, pos(this.skin, v)) < 0.09 ? h : pos(this.skin, v))
    return v
  }

  /**
   * 体表标志在皮肤上的精确位置（有射线击中点时取之，否则取其顶点）。
   * Exact point on the skin for a landmark (the ray hit when there is one, else its vertex).
   */
  surfacePoint(e: SkinExpr | PointExpr, side: SideLR): V3 {
    this.vertex(e, side)
    return this.surfaceCache.get(`${typeof e === 'string' ? e : JSON.stringify(e)}|${side}`)!
  }

  private vertexUncached(e: SkinExpr | PointExpr, side: SideLR): number {
    if (typeof e === 'string') {
      const def = this.file.points[e]
      if (def === undefined) throw new Error(`unknown landmark "${e}"`)
      return this.vertex(def, side)
    }
    if (!isSkinExpr(e)) return this.nearestVertex(this.point(e, side))
    if ('dimple' in e) {
      const a = this.point(e.dimple.between[0], side), b = this.point(e.dimple.between[1], side)
      const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1])
      // 前正中线轮廓；凹点即低于局部轮廓最深的顶点。
      // Anterior midline profile; the dimple is the vertex lying deepest below the local profile.
      const strip = this.outerList.filter((v) => {
        const p = pos(this.skin, v)
        return Math.abs(p[0] - this.skin.midX) < 0.012 && p[1] > y0 - 0.04 && p[1] < y1 + 0.04 && nrm(this.skin, v)[2] > 0.3
      })
      let best = -1, bs = Infinity
      for (const v of strip) {
        const p = pos(this.skin, v)
        if (p[1] < y0 || p[1] > y1) continue
        const zs = strip.map((u) => pos(this.skin, u)).filter((q) => Math.abs(q[1] - p[1]) < 0.035 && Math.abs(q[1] - p[1]) > 0.012).map((q) => q[2])
        if (zs.length < 4) continue
        const s = p[2] - zs.reduce((x, y) => x + y, 0) / zs.length
        if (s < bs) { bs = s; best = v }
      }
      if (best < 0) throw new Error('no dimple found')
      return best
    }
    if ('nerveCross' in e) {
      const x = this.point(e.x, side)[0]
      const frontZ = this.frame('trunk', side).origin[2]
      const path = this.body.nerves.find((n) => n.part === this.partId(e.nerveCross, side))
      if (!path) throw new Error(`no centreline for "${e.nerveCross}"`)
      let best = -1, bd = Infinity
      for (const b of path.branches)
        for (let i = 0; i < b.points.length; i += 3) {
          const p: V3 = [b.points[i]!, b.points[i + 1]!, b.points[i + 2]!]
          if (e.back ? p[2] >= frontZ : p[2] < frontZ) continue
          const v = this.trunkRadial(p, side)
          if (v < 0) continue
          const d = Math.abs(this.skin.positions[v * 3]! - x)
          if (d < bd) { bd = d; best = v }
        }
      if (best < 0) throw new Error(`nerveCross found nothing for "${e.nerveCross}"`)
      return best
    }
    if ('skinExtreme' in e) {
      const c = this.point(e.skinExtreme.near, side), d = this.dir(e.skinExtreme.dir, side)
      let best = -1, bs = -Infinity
      for (const v of this.outerList) {
        const p = pos(this.skin, v)
        if (dist(p, c) > e.skinExtreme.radiusMm / 1000) continue
        if ((side === 'L') !== p[0] >= this.skin.midX) continue
        const s = dot(p, d)
        if (s > bs) { bs = s; best = v }
      }
      if (best < 0) throw new Error(`skinExtreme found nothing: ${JSON.stringify(e)}`)
      return best
    }
    if ('frame' in e && 'deg' in e) {
      const origin = 'at' in e ? this.point(e.at, side) : this.point({ frame: e.frame, t: e.t }, side)
      const t = 'at' in e ? this.frameT(e.frame, origin, side) : e.t
      // 肢体内发出的射线若 15 cm 内未穿出皮肤（如上臂内侧与胸壁的皮肤网格粘连处），
      // 则取沿该方向 5 cm 处最近的皮肤顶点。
      // A ray from inside a limb that does not leave the skin within 15 cm (e.g. where the
      // medial arm is fused to the chest wall in the skin mesh) falls back to the skin vertex
      // nearest to the point 5 cm out along it.
      const d = this.frameDir(e.frame, t, e.deg, side)
      const v = this.rayVertex(origin, d, 0.15)
      return v >= 0 ? v : this.nearestVertex(add(origin, mul(d, 0.05)), false)
    }
    const p = this.point(e.at, side)
    const to = e.to ?? 'nearest'
    if (to === 'nearest') return this.nearestVertex(p)
    if (to === 'nearestAny') return this.nearestVertex(p, false)
    if (to === 'trunkRadial') {
      const v = this.trunkRadial(p, side)
      if (v < 0) throw new Error(`trunkRadial projection missed: ${JSON.stringify(e)}`)
      return v
    }
    if (typeof to === 'object' && !Array.isArray(to)) return this.rayVertex(p, norm(sub(p, this.point(to.awayFrom, side))))
    return this.rayVertex(p, this.dir(to, side))
  }
}

export function isSkinExpr(e: unknown): e is Exclude<SkinExpr, string> {
  return typeof e === 'object' && e !== null && ('at' in e || 'deg' in e || 'dimple' in e || 'skinExtreme' in e || 'nerveCross' in e)
}
