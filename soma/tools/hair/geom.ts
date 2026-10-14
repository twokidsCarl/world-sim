// 毛发生成用的几何工具：小向量运算、皮肤的 BVH（最近点、射线）、随机数。
// Geometry helpers for the groom generator: small vector maths, the skin's BVH (closest point, rays), random numbers.

import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, Ray, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'

export type V3 = [number, number, number]

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])
export const norm = (a: V3): V3 => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
export const mix = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const at = (p: ArrayLike<number>, i: number): V3 => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!]
/** 把 v 投到垂直于 n 的平面上 / project v onto the plane normal to n */
export const tangential = (v: V3, n: V3): V3 => sub(v, scale(n, dot(v, n)))
/** 绕单位轴 k 转 a 弧度（罗德里格斯）/ rotate about unit axis k by a radians (Rodrigues) */
export function rotate(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a)
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)))
}

/** 可复现的随机数（mulberry32）/ reproducible random numbers (mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 正态随机数（Box–Muller）/ a normal deviate (Box–Muller) */
export function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r())
}

/** 整数哈希成 [0,1) / hash an integer to [0,1) */
export function hash01(i: number, seed = 0): number {
  let h = (i * 374761393 + seed * 668265263) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export interface Closest {
  point: V3
  /** 三角形的单位法线（向外）/ the triangle's unit normal (outward) */
  normal: V3
  face: number
  distance: number
  /** 重心坐标 (w0, w1, w2) / barycentric coordinates (w0, w1, w2) */
  bary: V3
}

/** 皮肤表面：最近点和射线查询 / the skin surface: closest-point and ray queries */
export class Surface {
  readonly bvh: MeshBVH
  private readonly mesh: Mesh
  private readonly tmp = new Vector3()
  private readonly hit = { point: new Vector3(), distance: 0, faceIndex: 0 }

  constructor(
    readonly positions: Float32Array,
    readonly indices: Uint32Array,
  ) {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(positions, 3))
    g.setIndex(new BufferAttribute(indices.slice(), 1))
    // MeshBVH 会重排索引；三角形编号按重排后的，故另存原来的 / MeshBVH reorders the index; triangle numbers refer to the reordered one, so keep it
    this.bvh = new MeshBVH(g)
    this.mesh = new Mesh(g, new MeshBasicMaterial({ side: DoubleSide }))
    ;(this.mesh.geometry as unknown as { boundsTree: MeshBVH }).boundsTree = this.bvh
  }

  /** BVH 重排后的索引 / the index after the BVH reordered it */
  get index(): ArrayLike<number> {
    return this.mesh.geometry.index!.array
  }

  triangle(face: number): [number, number, number] {
    const ix = this.index
    return [ix[face * 3]!, ix[face * 3 + 1]!, ix[face * 3 + 2]!]
  }

  faceNormal(face: number): V3 {
    const [a, b, c] = this.triangle(face)
    const p = this.positions
    return norm(cross(sub(at(p, b), at(p, a)), sub(at(p, c), at(p, a))))
  }

  /** 最近点；maxDistance 之外返回 null / closest point; null beyond maxDistance */
  closest(p: V3, maxDistance = Infinity): Closest | null {
    this.tmp.set(p[0], p[1], p[2])
    const r = this.bvh.closestPointToPoint(this.tmp, this.hit, 0, maxDistance)
    if (!r) return null
    const q: V3 = [r.point.x, r.point.y, r.point.z]
    const [a, b, c] = this.triangle(r.faceIndex)
    return { point: q, normal: this.faceNormal(r.faceIndex), face: r.faceIndex, distance: r.distance, bary: barycentric(q, at(this.positions, a), at(this.positions, b), at(this.positions, c)) }
  }

  /** 射线第一次碰到皮肤的距离；没碰到为 Infinity / distance to the first skin hit along a ray; Infinity when none */
  ray(origin: V3, dir: V3, far = Infinity): number {
    const ray = new Ray(new Vector3(...origin), new Vector3(...dir))
    const h = this.bvh.raycastFirst(ray, DoubleSide, 0, far)
    return h ? h.distance : Infinity
  }
}

/** 三角形内点的重心坐标（夹到三角形内）/ barycentric coordinates of a point in a triangle (clamped inside) */
export function barycentric(p: V3, a: V3, b: V3, c: V3): V3 {
  const v0 = sub(b, a), v1 = sub(c, a), v2 = sub(p, a)
  const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1)
  const den = d00 * d11 - d01 * d01 || 1e-30
  let v = (d11 * d20 - d01 * d21) / den
  let w = (d00 * d21 - d01 * d20) / den
  v = Math.max(0, v)
  w = Math.max(0, w)
  const s = v + w
  if (s > 1) {
    v /= s
    w /= s
  }
  return [1 - v - w, v, w]
}
