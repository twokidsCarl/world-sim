// 皮肤外壁上的测地工具：沿网格边的多源 Dijkstra（各标签按距离竞争，可设屏障），以及顶点间的最短路径。
// Geodesic tools on the outer skin wall: multi-source Dijkstra over mesh edges (labels compete
// by distance, optionally through barriers), shortest paths between vertices.

import type { Skin } from './mesh.ts'

class Heap {
  private readonly key: number[] = []
  private readonly val: number[] = []
  get size() { return this.key.length }
  push(k: number, v: number) {
    const key = this.key, val = this.val
    let i = key.length
    key.push(k); val.push(v)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (key[p]! < k || (key[p] === k && val[p]! <= v)) break
      key[i] = key[p]!; val[i] = val[p]!
      i = p
    }
    key[i] = k; val[i] = v
  }
  pop(): [number, number] {
    const key = this.key, val = this.val
    const rk = key[0]!, rv = val[0]!
    const k = key.pop()!, v = val.pop()!
    const n = key.length
    if (n > 0) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && (key[c + 1]! < key[c]! || (key[c + 1] === key[c] && val[c + 1]! < val[c]!))) c++
        if (k < key[c]! || (k === key[c] && v <= val[c]!)) break
        key[i] = key[c]!; val[i] = val[c]!
        i = c
      }
      key[i] = k; val[i] = v
    }
    return [rk, rv]
  }
}

export interface Seed { vertex: number; label: number; d0: number; speed?: number }

export interface Field { dist: Float32Array; label: Int16Array }

/**
 * 自种子在外壁上扩散标签。blocked 顶点不可进入；edgeOk 返回 false 的边被跳过；speed（按标签）用于缩短该标签的边长。
 * Grows labels from seeds over the outer wall. `blocked` vertices are never entered; an edge is
 * skipped when `edgeOk` returns false. `speed` (per label) divides edge lengths for that label.
 */
export function grow(skin: Skin, seeds: Seed[], blocked?: Uint8Array, edgeOk?: (a: number, b: number) => boolean, speed?: Float32Array, init?: Field): Field {
  const dist = init?.dist ?? new Float32Array(skin.n).fill(Infinity)
  const label = init?.label ?? new Int16Array(skin.n).fill(-1)
  const heap = new Heap()
  const sorted = [...seeds].sort((a, b) => a.d0 - b.d0 || a.vertex - b.vertex || a.label - b.label)
  for (const s of sorted) {
    if (!skin.outer[s.vertex] || (blocked && blocked[s.vertex])) continue
    if (s.d0 < dist[s.vertex]!) {
      dist[s.vertex] = s.d0
      label[s.vertex] = s.label
      heap.push(s.d0, s.vertex)
    }
  }
  if (init) for (let i = 0; i < skin.n; i++) if (label[i]! >= 0 && isFinite(dist[i]!)) heap.push(dist[i]!, i)
  while (heap.size) {
    const [d, v] = heap.pop()
    if (d > dist[v]!) continue
    const l = label[v]!
    const sp = speed ? speed[l]! : 1
    for (let k = skin.geoStart[v]!; k < skin.geoStart[v + 1]!; k++) {
      const u = skin.geo[k]!
      if (!skin.outer[u] || (blocked && blocked[u])) continue
      if (edgeOk && !edgeOk(v, u)) continue
      const nd = Math.fround(d + skin.geoLen[k]! / sp)
      if (nd < dist[u]!) {
        dist[u] = nd
        label[u] = l
        heap.push(nd, u)
      }
    }
  }
  return { dist, label }
}

/**
 * 两外壁顶点间沿网格边的路径（含端点）。给定 guide（路径应遵循的三维直线段）时，每一步按其偏离该线段的距离加罚，使链贴近预定的线，而不在三角网中来回折行。
 * Path along mesh edges between two outer-wall vertices (inclusive). With `guide` (the straight
 * 3D segment the path should follow) every step is penalised by its distance from that segment,
 * so the chain hugs the intended line instead of zig-zagging through the triangulation.
 * 进入 avoid 标记的顶点要加 3 cm 的代价。 / Entering a vertex marked in `avoid` costs an extra 3 cm.
 */
export function path(skin: Skin, from: number, to: number, edgeOk?: (a: number, b: number) => boolean, guide?: [number[], number[]], avoid?: Uint8Array): number[] {
  if (from === to) return [from]
  const dist = new Float32Array(skin.n).fill(Infinity)
  const prev = new Int32Array(skin.n).fill(-1)
  const heap = new Heap()
  const dev = (u: number): number => {
    if (!guide) return 0
    const [a, b] = guide
    const px = skin.positions[u * 3]!, py = skin.positions[u * 3 + 1]!, pz = skin.positions[u * 3 + 2]!
    const abx = b[0]! - a[0]!, aby = b[1]! - a[1]!, abz = b[2]! - a[2]!
    const l2 = abx * abx + aby * aby + abz * abz
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - a[0]!) * abx + (py - a[1]!) * aby + (pz - a[2]!) * abz) / l2)) : 0
    return Math.hypot(px - a[0]! - abx * t, py - a[1]! - aby * t, pz - a[2]! - abz * t)
  }
  dist[from] = 0
  heap.push(0, from)
  while (heap.size) {
    const [d, v] = heap.pop()
    if (v === to) break
    if (d > dist[v]!) continue
    for (let k = skin.adjStart[v]!; k < skin.adjStart[v + 1]!; k++) {
      const u = skin.adj[k]!
      if (!skin.outer[u]) continue
      if (edgeOk && !edgeOk(v, u)) continue
      const nd = Math.fround(d + skin.adjLen[k]! + 3 * dev(u) + (avoid && avoid[u] && u !== to ? 0.03 : 0))
      if (nd < dist[u]!) { dist[u] = nd; prev[u] = v; heap.push(nd, u) }
    }
  }
  if (prev[to]! < 0) return [from, to]
  const out = [to]
  for (let v = to; v !== from; ) { v = prev[v]!; out.push(v) }
  return out.reverse()
}

/**
 * 到一组顶点的测地距离，上限 max 米。
 * Geodesic distance from a set of vertices, up to `max` metres.
 */
export function distanceFrom(skin: Skin, sources: number[], max = Infinity): Float32Array {
  const f = grow(skin, sources.map((v) => ({ vertex: v, label: 0, d0: 0 })))
  if (max < Infinity) for (let i = 0; i < f.dist.length; i++) if (f.dist[i]! > max) f.dist[i] = Infinity
  return f.dist
}
