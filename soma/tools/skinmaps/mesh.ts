// 作为绘制对象的皮肤表面：连通关系、顶点法线与面积、BodyParts3D 双层皮肤壳的外壁，以及射线与最近点查询。
// The skin as a surface to paint on: welded connectivity, vertex normals and areas, the outer
// wall of BodyParts3D's double-walled skin shell, and ray / closest-point queries.

import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import type { RawMesh } from './io.ts'

export type V3 = [number, number, number]

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])
export const norm = (a: V3): V3 => {
  const l = len(a)
  return l > 0 ? mul(a, 1 / l) : [0, 0, 0]
}
export const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const dist = (a: V3, b: V3): number => len(sub(a, b))

export class Bvh {
  readonly bvh: MeshBVH
  /**
   * 按 BVH 自身（重排后）面序排列的三角形顶点索引。
   * Triangle vertex indices in the BVH's own (reordered) face order.
   */
  readonly index: Uint32Array
  private readonly ray = new Ray()
  private readonly v = new Vector3()

  constructor(positions: Float32Array, indices: Uint32Array) {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(positions, 3))
    g.setIndex(new BufferAttribute(Uint32Array.from(indices), 1))
    this.bvh = new MeshBVH(g)
    this.index = g.index!.array as Uint32Array
  }

  /**
   * 射线上的全部交点，由近及远。
   * All intersections along a ray, nearest first.
   */
  hits(origin: V3, dir: V3): { t: number; face: number; point: V3 }[] {
    this.ray.origin.set(origin[0], origin[1], origin[2])
    this.ray.direction.set(dir[0], dir[1], dir[2]).normalize()
    return this.bvh
      .raycast(this.ray, DoubleSide)
      .map((h) => ({ t: h.distance, face: h.faceIndex!, point: [h.point.x, h.point.y, h.point.z] as V3 }))
      .sort((a, b) => a.t - b.t || a.face - b.face)
  }

  closest(p: V3): { point: V3; distance: number; face: number } {
    const r = this.bvh.closestPointToPoint(this.v.set(p[0], p[1], p[2]))!
    return { point: [r.point.x, r.point.y, r.point.z], distance: r.distance, face: r.faceIndex }
  }

  faceVerts(face: number): [number, number, number] {
    return [this.index[face * 3]!, this.index[face * 3 + 1]!, this.index[face * 3 + 2]!]
  }
}

export interface Skin {
  n: number
  positions: Float32Array
  indices: Uint32Array
  normals: Float32Array
  /**
   * 1 = 顶点在外壁（可触及的体表），0 = 在皮肤壳的内壁。
   * 1 = vertex on the outer wall (the surface one can touch), 0 = inner wall of the shell.
   */
  outer: Uint8Array
  /**
   * 分摊到每个顶点的面积（m²，取其相邻三角形面积的三分之一）。
   * Area in m² attributed to each vertex (a third of its triangles).
   */
  area: Float32Array
  /**
   * 网格边的 CSR 邻接表。
   * CSR adjacency over mesh edges.
   */
  adjStart: Uint32Array
  adj: Uint32Array
  adjLen: Float32Array
  /**
   * 用于距离传播的 CSR 邻接表：网格边加上到二环邻点的直连，可消除在这种粗网格上只沿边走造成的大部分锯齿误差。
   * CSR adjacency for distance propagation: mesh edges plus straight links to the second ring of
   * neighbours, which removes most of the zig-zag error of edge-only paths on this coarse mesh.
   */
  geoStart: Uint32Array
  geo: Uint32Array
  geoLen: Float32Array
  /**
   * 每个顶点取其标签的外壁顶点（外壁顶点即自身）。
   * For every vertex the outer-wall vertex whose label it takes (itself when outer).
   */
  outerOf: Uint32Array
  /**
   * 仅含外壁的 BVH；outerBvh.faceVerts 返回皮肤顶点索引。
   * BVH over the outer wall only; `outerBvh.faceVerts` gives skin vertex indices.
   */
  outerBvh: Bvh
  /**
   * 正中矢状面的 X 坐标。
   * X of the median plane.
   */
  midX: number
}

export const pos = (s: { positions: Float32Array }, i: number): V3 => [s.positions[i * 3]!, s.positions[i * 3 + 1]!, s.positions[i * 3 + 2]!]
export const nrm = (s: Skin, i: number): V3 => [s.normals[i * 3]!, s.normals[i * 3 + 1]!, s.normals[i * 3 + 2]!]

export function buildSkin(raw: RawMesh, midX = 0): Skin {
  const { positions, indices } = raw
  const n = positions.length / 3
  const normals = new Float32Array(n * 3)
  const area = new Float32Array(n)
  const P = (i: number): V3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]
  const edges = new Map<number, number>()
  const deg = new Uint32Array(n)
  const addEdge = (a: number, b: number) => {
    const k = a < b ? a * n + b : b * n + a
    if (!edges.has(k)) {
      edges.set(k, 1)
      deg[a]!++
      deg[b]!++
    }
  }
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!
    const cr = cross(sub(P(b), P(a)), sub(P(c), P(a)))
    const ar = len(cr) / 2
    for (const v of [a, b, c]) {
      normals[v * 3]! += cr[0]
      normals[v * 3 + 1]! += cr[1]
      normals[v * 3 + 2]! += cr[2]
      area[v]! += ar / 3
    }
    addEdge(a, b); addEdge(b, c); addEdge(c, a)
  }
  for (let i = 0; i < n; i++) {
    const v = norm([normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!])
    normals.set(v, i * 3)
  }
  const adjStart = new Uint32Array(n + 1)
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i]! + deg[i]!
  const fill = adjStart.slice(0, n)
  const adj = new Uint32Array(adjStart[n]!)
  const adjLen = new Float32Array(adjStart[n]!)
  for (const k of edges.keys()) {
    const a = Math.floor(k / n), b = k % n
    const l = dist(P(a), P(b))
    adj[fill[a]!] = b; adjLen[fill[a]!++] = l
    adj[fill[b]!] = a; adjLen[fill[b]!++] = l
  }
  // 邻接表排序后，所有遍历都与 Map 的迭代细节无关（保证结果确定）。
  // Sorted neighbour lists make every traversal independent of Map iteration details.
  for (let i = 0; i < n; i++) {
    const s = adjStart[i]!, e = adjStart[i + 1]!
    const order = Array.from({ length: e - s }, (_, k) => s + k).sort((x, y) => adj[x]! - adj[y]!)
    const na = order.map((x) => adj[x]!), nl = order.map((x) => adjLen[x]!)
    for (let k = 0; k < na.length; k++) { adj[s + k] = na[k]!; adjLen[s + k] = nl[k]! }
  }

  // 外壁判定：沿法线稍离表面的一点，若向无穷远的射线穿过的壁数为 4 的倍数，则位于体外空气中（每穿过一段肢体或躯干依次经过外、内、内、外四层壁）；若除以 4 余 2，则位于体内空腔。
  // Outer wall: a point just off the surface on the normal side is in the air outside the body
  // when a ray from it to infinity crosses a multiple of four walls (each limb or the trunk it
  // passes adds outer+inner+inner+outer); it is in the hollow inside when the count is 2 mod 4.
  const all = new Bvh(positions, indices)
  const dirs: V3[] = [norm([0.31, 0.11, 0.94]), norm([-0.87, 0.23, -0.43]), norm([0.42, 0.9, 0.11]), norm([0.2, -0.95, 0.24]), norm([-0.5, -0.3, 0.81])]
  const vote = new Int8Array(n)
  for (let i = 0; i < n; i++) {
    const o = add(P(i), mul([normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!], 2e-4))
    let s = 0
    for (const d of dirs) {
      const c = all.hits(o, d).length % 4
      if (c === 0) s++
      else if (c === 2) s--
    }
    vote[i] = s
  }
  const outer = new Uint8Array(n)
  for (let i = 0; i < n; i++) outer[i] = vote[i]! > 0 ? 1 : 0
  // 清除个别误判（射线擦边所致）：两轮邻点多数表决。
  // Clean isolated misclassifications (grazing rays): two rounds of neighbour majority.
  for (let round = 0; round < 2; round++) {
    const next = outer.slice()
    for (let i = 0; i < n; i++) {
      let o = 0, c = 0
      for (let k = adjStart[i]!; k < adjStart[i + 1]!; k++) { o += outer[adj[k]!]!; c++ }
      if (c && o * 2 > c + 1) next[i] = 1
      else if (c && o * 2 < c - 1) next[i] = 0
    }
    outer.set(next)
  }

  // 把被另一类包围的小岛翻转（残余的擦边误差）。
  // Flip small islands of one class enclosed in the other (leftover grazing-ray errors).
  {
    const seen = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (seen[i]) continue
      const comp = [i]
      seen[i] = 1
      for (let h = 0; h < comp.length; h++) {
        const v = comp[h]!
        for (let k = adjStart[v]!; k < adjStart[v + 1]!; k++) {
          const u = adj[k]!
          if (!seen[u] && outer[u] === outer[i]) { seen[u] = 1; comp.push(u) }
        }
      }
      if (comp.length < 40) for (const v of comp) outer[v] = outer[v] ? 0 : 1
    }
  }

  const outerTris: number[] = []
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!
    if (outer[a] && outer[b] && outer[c]) outerTris.push(a, b, c)
  }
  const outerBvh = new Bvh(positions, Uint32Array.from(outerTris))
  const outerOf = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    if (outer[i]) { outerOf[i] = i; continue }
    const p = P(i)
    const c = outerBvh.closest(p)
    let best = -1, bd = Infinity
    for (const v of outerBvh.faceVerts(c.face)) {
      const d = dist(P(v), p)
      if (d < bd) { bd = d; best = v }
    }
    outerOf[i] = best
  }
  const geoStart = new Uint32Array(n + 1)
  const lists: number[][] = []
  for (let i = 0; i < n; i++) {
    const set = new Set<number>()
    if (outer[i]) {
      for (let k = adjStart[i]!; k < adjStart[i + 1]!; k++) {
        const u = adj[k]!
        if (!outer[u]) continue
        set.add(u)
        for (let q = adjStart[u]!; q < adjStart[u + 1]!; q++) if (outer[adj[q]!] && adj[q] !== i) set.add(adj[q]!)
      }
    }
    const l = [...set].sort((a, b) => a - b)
    lists.push(l)
    geoStart[i + 1] = geoStart[i]! + l.length
  }
  const geo = new Uint32Array(geoStart[n]!)
  const geoLen = new Float32Array(geoStart[n]!)
  for (let i = 0; i < n; i++) {
    const l = lists[i]!
    for (let k = 0; k < l.length; k++) {
      geo[geoStart[i]! + k] = l[k]!
      geoLen[geoStart[i]! + k] = dist(P(i), P(l[k]!))
    }
  }
  return { n, positions, indices, normals, outer, area, adjStart, adj, adjLen, geoStart, geo, geoLen, outerOf, outerBvh, midX }
}

export const sideOf = (s: Skin, i: number): 'L' | 'R' => (s.positions[i * 3]! >= s.midX ? 'L' : 'R')
