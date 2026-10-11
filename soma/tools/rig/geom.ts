// 带空间查询（最近点、包含判断）和按面积加权采样的三角形曲面。
// Triangle surfaces with spatial queries (closest point, containment) and area-weighted sampling.

import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { Sample } from './fits.ts'
import { type V3, cross, len, mul, sub } from './math.ts'

export interface MeshLike {
  positions: Float32Array
  indices: Uint32Array
}

export class Surface {
  readonly positions: Float32Array
  readonly indices: Uint32Array
  readonly bbox: [number, number, number, number, number, number]
  private _bvh: MeshBVH | null = null
  private readonly v = new Vector3()
  private readonly ray = new Ray()
  private readonly target = { point: new Vector3(), distance: 0, faceIndex: 0 }

  constructor(mesh: MeshLike) {
    this.positions = mesh.positions
    this.indices = mesh.indices
    const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    const p = mesh.positions
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k]! < b[k]!) b[k] = p[i + k]!
        if (p[i + k]! > b[k + 3]!) b[k + 3] = p[i + k]!
      }
    }
    this.bbox = b
  }

  get bvh(): MeshBVH {
    if (!this._bvh) {
      const g = new BufferGeometry()
      // 使用副本：MeshBVH 会就地重排索引缓冲 / copies: MeshBVH reorders the index buffer in place
      g.setAttribute('position', new BufferAttribute(Float32Array.from(this.positions), 3))
      g.setIndex(new BufferAttribute(Uint32Array.from(this.indices), 1))
      this._bvh = new MeshBVH(g)
    }
    return this._bvh
  }

  /** 到包围盒的距离，是到表面距离的一个廉价下界。 Distance from the box, a cheap lower bound of the surface distance. */
  boxDistance(x: number, y: number, z: number): number {
    const b = this.bbox
    const dx = Math.max(b[0] - x, 0, x - b[3]), dy = Math.max(b[1] - y, 0, y - b[4]), dz = Math.max(b[2] - z, 0, z - b[5])
    return Math.hypot(dx, dy, dz)
  }

  /** 到表面的无符号距离；`max` 可让查询提前终止（超出时返回 Infinity）。 Unsigned distance to the surface; `max` lets the query stop early (returns Infinity beyond it). */
  distance(x: number, y: number, z: number, max = Infinity): number {
    if (this.boxDistance(x, y, z) > max) return Infinity
    const r = this.bvh.closestPointToPoint(this.v.set(x, y, z), this.target, 0, max)
    return r ? r.distance : Infinity
  }

  closest(p: V3, max = Infinity): { point: V3; distance: number } | null {
    if (this.boxDistance(p[0], p[1], p[2]) > max) return null
    const r = this.bvh.closestPointToPoint(this.v.set(p[0], p[1], p[2]), this.target, 0, max)
    return r ? { point: [r.point.x, r.point.y, r.point.z], distance: r.distance } : null
  }

  /**
   * 表面上离 p 最近的点，以及它所在三角形的三个顶点下标和重心坐标。
   * The point of the surface closest to p, with the three vertex indices of its triangle and the barycentric coordinates.
   */
  closestFace(p: V3): { point: V3; distance: number; verts: [number, number, number]; bary: [number, number, number] } | null {
    const r = this.bvh.closestPointToPoint(this.v.set(p[0], p[1], p[2]), this.target)
    if (!r) return null
    const idx = this.bvh.geometry.index!.array, P = this.positions
    const a = idx[r.faceIndex * 3]!, b = idx[r.faceIndex * 3 + 1]!, c = idx[r.faceIndex * 3 + 2]!
    const q: V3 = [r.point.x, r.point.y, r.point.z]
    const A: V3 = [P[a * 3]!, P[a * 3 + 1]!, P[a * 3 + 2]!], B: V3 = [P[b * 3]!, P[b * 3 + 1]!, P[b * 3 + 2]!], C: V3 = [P[c * 3]!, P[c * 3 + 1]!, P[c * 3 + 2]!]
    const v0 = sub(B, A), v1 = sub(C, A), v2 = sub(q, A)
    const d00 = v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2], d01 = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2], d11 = v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2]
    const d20 = v2[0] * v0[0] + v2[1] * v0[1] + v2[2] * v0[2], d21 = v2[0] * v1[0] + v2[1] * v1[1] + v2[2] * v1[2]
    const den = d00 * d11 - d01 * d01
    let v = den > 1e-20 ? (d11 * d20 - d01 * d21) / den : 0, w = den > 1e-20 ? (d00 * d21 - d01 * d20) / den : 0
    v = Math.min(1, Math.max(0, v))
    w = Math.min(1 - v, Math.max(0, w))
    return { point: q, distance: r.distance, verts: [a, b, c], bary: [1 - v - w, v, w] }
  }

  /** 射线奇偶性包含判断（对闭合曲面才有意义）。两条射线结果必须一致，否则由第三条裁决。 Ray-parity containment (meaningful for closed surfaces). Two rays must agree, else a third decides. */
  contains(x: number, y: number, z: number): boolean {
    const b = this.bbox
    if (x < b[0] || x > b[3] || y < b[1] || y > b[4] || z < b[2] || z > b[5]) return false
    const odd = (dx: number, dy: number, dz: number): boolean => {
      this.ray.origin.set(x, y, z)
      this.ray.direction.set(dx, dy, dz).normalize()
      return (this.bvh.raycast(this.ray, DoubleSide).length & 1) === 1
    }
    const a = odd(0.5377, 0.8121, 0.2254), c = odd(-0.3113, 0.2247, -0.9234)
    return a === c ? a : odd(0.7071, -0.6124, 0.3536)
  }

  /** 开线段 a→b 上穿过表面的次数，忽略距任一端点 `skip` 以内的交点。 Number of surface crossings on the open segment a→b, ignoring hits within `skip` of either end. */
  crossings(a: V3, b: V3, skip = 0): number {
    const d = sub(b, a)
    const l = len(d)
    if (l < 1e-9) return 0
    this.ray.origin.set(a[0], a[1], a[2])
    this.ray.direction.set(d[0] / l, d[1] / l, d[2] / l)
    let n = 0
    for (const h of this.bvh.raycast(this.ray, DoubleSide, skip, l - skip)) if (h.distance > skip && h.distance < l - skip) n++
    return n
  }

  /**
   * 线段 a→b 上的第一个交点，以及击中的是否为背面（射线方向与面法线同向）。
   * First hit on the segment a→b and whether it is a back face (the ray runs along the face normal).
   */
  firstHit(a: V3, b: V3): { distance: number; backFace: boolean } | null {
    const d = sub(b, a)
    const l = len(d)
    if (l < 1e-9) return null
    this.ray.origin.set(a[0], a[1], a[2])
    this.ray.direction.set(d[0] / l, d[1] / l, d[2] / l)
    const h = this.bvh.raycastFirst(this.ray, DoubleSide, 0, l)
    if (!h || h.faceIndex == null) return null
    const idx = this.bvh.geometry.index!.array, p = this.bvh.geometry.attributes.position!.array
    const i = idx[h.faceIndex * 3]! * 3, j = idx[h.faceIndex * 3 + 1]! * 3, k = idx[h.faceIndex * 3 + 2]! * 3
    const n = cross([p[j]! - p[i]!, p[j + 1]! - p[i + 1]!, p[j + 2]! - p[i + 2]!], [p[k]! - p[i]!, p[k + 1]! - p[i + 1]!, p[k + 2]! - p[i + 2]!])
    return { distance: h.distance, backFace: n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0 }
  }

  /**
   * 按面积加权的采样点：每个三角形按重心坐标格点细分，使采样点间距约为 `spacing`；
   * 每个采样点带有面法线及其分得的面积。
   * Area-weighted samples: every triangle is split on a barycentric lattice so that samples are
   * about `spacing` apart; each carries the face normal and its share of the area.
   */
  samples(spacing: number): Sample[] {
    const out: Sample[] = []
    const p = this.positions, idx = this.indices
    for (let t = 0; t < idx.length; t += 3) {
      const a: V3 = [p[idx[t]! * 3]!, p[idx[t]! * 3 + 1]!, p[idx[t]! * 3 + 2]!]
      const b: V3 = [p[idx[t + 1]! * 3]!, p[idx[t + 1]! * 3 + 1]!, p[idx[t + 1]! * 3 + 2]!]
      const c: V3 = [p[idx[t + 2]! * 3]!, p[idx[t + 2]! * 3 + 1]!, p[idx[t + 2]! * 3 + 2]!]
      const ab = sub(b, a), ac = sub(c, a)
      const cr = cross(ab, ac)
      const area2 = len(cr)
      if (area2 < 1e-14) continue
      const n = mul(cr, 1 / area2)
      const k = Math.max(1, Math.ceil(Math.sqrt(area2 / 2) / spacing))
      const w = area2 / 2 / (k * k)
      // k² 个子三角形：格点中正立和倒立单元的质心
      // k² sub-triangles: centroids of the upright and inverted cells of the lattice
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k - i; j++) {
          const u = (i + 1 / 3) / k, v = (j + 1 / 3) / k
          out.push({ p: [a[0] + ab[0] * u + ac[0] * v, a[1] + ab[1] * u + ac[1] * v, a[2] + ab[2] * u + ac[2] * v], n, w })
          if (j < k - i - 1) {
            const u2 = (i + 2 / 3) / k, v2 = (j + 2 / 3) / k
            out.push({ p: [a[0] + ab[0] * u2 + ac[0] * v2, a[1] + ab[1] * u2 + ac[1] * v2, a[2] + ab[2] * u2 + ac[2] * v2], n, w })
          }
        }
      }
    }
    return out
  }
}

/** 把多个网格拼接成一个。 Concatenates meshes into one. */
export function mergeMeshes(meshes: MeshLike[]): MeshLike {
  const nv = meshes.reduce((s, m) => s + m.positions.length, 0), ni = meshes.reduce((s, m) => s + m.indices.length, 0)
  const positions = new Float32Array(nv), indices = new Uint32Array(ni)
  let vo = 0, io = 0
  for (const m of meshes) {
    positions.set(m.positions, vo)
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i]! + vo / 3
    vo += m.positions.length
    io += m.indices.length
  }
  return { positions, indices }
}

/** 闭合网格所围的体积（符号取决于其绕向），单位为 m³。 Enclosed volume of a closed mesh (signed by its winding), m³. */
export function meshVolume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let v = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3
    v +=
      positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!) -
      positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!) +
      positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!)
  }
  return v / 6
}
