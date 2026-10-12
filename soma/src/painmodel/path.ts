// 外周通路的几何：从皮肤刺激点沿神经中心线（nerves.json）到神经根的路径和长度。
// Geometry of the peripheral pathway: the path and its length from the stimulated point on the
// skin along the nerve centrelines (nerves.json) to the spinal root.
//
// 做法：把相关部件（皮神经、上级神经链、神经根）的中心线当作一张图——同一分支内相邻点相连，
// 不同分支之间在最近点处相连（3 mm 以内的都连；更大的空隙只在为了连通时才用直线跨越，
// 例如模型里没有单独建出的臂丛干、束）。然后求最短路径，并报告其中直线跨越的长度。
// How: the centrelines of the relevant parts (cutaneous nerve, parent chain, roots) form a
// graph - consecutive points of a branch are joined, and branches are joined at their closest
// points (always within 3 mm; a larger gap is bridged by a straight line only when needed for
// connectivity, e.g. the trunks and cords of the brachial plexus, which the model does not have
// as separate centrelines). The shortest path is taken and the bridged length is reported.

import type { NervePath, Vec3 } from '../anatomy/types.ts'
import type { NervePathResult } from './types.ts'

/** 小于这个间距的两条分支视为相接，米 / Branches closer than this are taken as joined, metres. */
const JOIN_M = 0.003

export interface NerveIndex {
  /** 部件 id → 各分支的点（展平 xyz）/ Part id → points of each branch (flat xyz). */
  branches: Map<string, ArrayLike<number>[]>
  /** 部件 id → 质心（没有中心线的部件，如神经节，用它代替）/ Part id → centroid (stands in for parts without a centreline, e.g. ganglia). */
  centroids: Map<string, Vec3>
}

export function buildNerveIndex(nerves: readonly NervePath[], parts: readonly { id: string; centroid: Vec3 }[]): NerveIndex {
  const branches = new Map<string, ArrayLike<number>[]>()
  for (const n of nerves) {
    const list = n.branches.map((b) => b.points).filter((p) => p.length >= 3)
    if (list.length) branches.set(n.part, list)
  }
  return { branches, centroids: new Map(parts.map((p) => [p.id, p.centroid])) }
}

interface Branch {
  part: string
  pts: ArrayLike<number>
  role: 0 | 1 | 2
  offset: number
  count: number
}

function dist(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): number {
  const dx = a[i * 3]! - b[j * 3]!
  const dy = a[i * 3 + 1]! - b[j * 3 + 1]!
  const dz = a[i * 3 + 2]! - b[j * 3 + 2]!
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** 最小堆上的 Dijkstra / Dijkstra on a binary heap. */
function shortest(n: number, adj: { to: number; w: number; bridge: boolean }[][], from: number): { d: Float64Array; prev: Int32Array } {
  const d = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const heap: number[] = []
  const key: number[] = []
  const push = (v: number, k: number) => {
    let i = heap.length
    heap.push(v)
    key.push(k)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (key[p]! <= k) break
      heap[i] = heap[p]!
      key[i] = key[p]!
      i = p
    }
    heap[i] = v
    key[i] = k
  }
  const pop = (): [number, number] => {
    const v = heap[0]!
    const k = key[0]!
    const lv = heap.pop()!
    const lk = key.pop()!
    const m = heap.length
    if (m > 0) {
      let i = 0
      for (;;) {
        let c = i * 2 + 1
        if (c >= m) break
        if (c + 1 < m && key[c + 1]! < key[c]!) c++
        if (key[c]! >= lk) break
        heap[i] = heap[c]!
        key[i] = key[c]!
        i = c
      }
      heap[i] = lv
      key[i] = lk
    }
    return [v, k]
  }
  d[from] = 0
  push(from, 0)
  while (heap.length) {
    const [v, k] = pop()
    if (k > d[v]!) continue
    for (const e of adj[v]!) {
      const nd = k + e.w
      if (nd < d[e.to]!) {
        d[e.to] = nd
        prev[e.to] = v
        push(e.to, nd)
      }
    }
  }
  return { d, prev }
}

/**
 * 从刺激点到神经根的路径。terminal：该分布区的皮神经部件；chain：上级神经链的部件；roots：
 * 该皮节的神经根、神经节部件。没有任何皮神经或神经链的中心线时，退回到直线距离（下限）。
 * The path from the stimulated point to the root. `terminal`: the territory's cutaneous nerve
 * parts; `chain`: the parts of its parent chain; `roots`: the root and ganglion parts of the
 * dermatome. Falls back to the straight-line distance (a lower bound) when no centreline of a
 * cutaneous nerve or chain part exists.
 */
export function nervePath(index: NerveIndex, stimulus: Vec3, terminal: readonly string[], chain: readonly string[], roots: readonly string[]): NervePathResult {
  const branches: Branch[] = []
  let offset = 0
  const add = (ids: readonly string[], role: 0 | 1 | 2) => {
    for (const part of ids) {
      if (branches.some((b) => b.part === part)) continue
      let list = index.branches.get(part)
      if (!list) {
        const c = index.centroids.get(part)
        // 只有神经根一级用质心代替；外周神经没有中心线就不算进路径
        // a centroid stands in at root level only; a peripheral nerve without a centreline is left out
        if (!c || role !== 2) continue
        list = [c]
      }
      for (const pts of list) {
        const count = Math.floor(pts.length / 3)
        branches.push({ part, pts, role, offset, count })
        offset += count
      }
    }
  }
  // 先加神经根：同一部件既在神经链里又是终点时，按终点算
  // roots first: a part that is both in the chain and the end counts as the end
  add(roots, 2)
  add(terminal, 0)
  add(chain, 1)

  const stim = [stimulus[0], stimulus[1], stimulus[2]]
  const rootBranches = branches.filter((b) => b.role === 2)
  if (rootBranches.length === 0) {
    // 没有神经根几何：终点取同一高度的正中线 / no root geometry: end on the midline at the same height
    const end: Vec3 = [0, stimulus[1], stimulus[2]]
    const len = Math.abs(stimulus[0])
    return { lengthM: len, method: 'straight', bridgedM: len, skinGapM: 0, parts: [], polyline: [...stim, ...end], end }
  }

  // 终点：神经根上最靠近正中矢状面的一点 / end: the root point closest to the midsagittal plane
  let endNode = -1
  let endAbsX = Infinity
  for (const b of rootBranches) {
    for (let i = 0; i < b.count; i++) {
      const ax = Math.abs(b.pts[i * 3]!)
      if (ax < endAbsX) {
        endAbsX = ax
        endNode = b.offset + i
      }
    }
  }

  // 起点：皮神经（没有则神经链，再没有则神经根）上离刺激点最近的一点
  // start: the point nearest the stimulus on the cutaneous nerve (else the chain, else the root)
  const peripheral = branches.filter((b) => b.role !== 2)
  const startPool = branches.some((b) => b.role === 0) ? branches.filter((b) => b.role === 0) : peripheral.length ? peripheral : rootBranches
  let startNode = -1
  let skinGap = Infinity
  for (const b of startPool) {
    for (let i = 0; i < b.count; i++) {
      const g = dist(b.pts, i, stim, 0)
      if (g < skinGap) {
        skinGap = g
        startNode = b.offset + i
      }
    }
  }

  const n = offset
  const adj: { to: number; w: number; bridge: boolean }[][] = Array.from({ length: n }, () => [])
  const link = (a: number, b: number, w: number, bridge: boolean) => {
    adj[a]!.push({ to: b, w, bridge })
    adj[b]!.push({ to: a, w, bridge })
  }
  for (const b of branches) for (let i = 0; i + 1 < b.count; i++) link(b.offset + i, b.offset + i + 1, dist(b.pts, i, b.pts, i + 1), false)

  // 分支之间的最近点对 / closest point pairs between branches
  const pairs: { a: number; b: number; i: number; j: number; gap: number }[] = []
  for (let a = 0; a < branches.length; a++) {
    for (let b = a + 1; b < branches.length; b++) {
      const A = branches[a]!
      const B = branches[b]!
      let best = Infinity
      let bi = 0
      let bj = 0
      for (let i = 0; i < A.count; i++) {
        for (let j = 0; j < B.count; j++) {
          const g = dist(A.pts, i, B.pts, j)
          if (g < best) {
            best = g
            bi = i
            bj = j
          }
        }
      }
      pairs.push({ a, b, i: bi, j: bj, gap: best })
    }
  }
  pairs.sort((x, y) => x.gap - y.gap || x.a - y.a || x.b - y.b)
  const parent = branches.map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!
      x = parent[x]!
    }
    return x
  }
  for (const p of pairs) {
    const ra = find(p.a)
    const rb = find(p.b)
    if (p.gap > JOIN_M && ra === rb) continue
    parent[ra] = rb
    link(branches[p.a]!.offset + p.i, branches[p.b]!.offset + p.j, p.gap, p.gap > JOIN_M)
  }

  const { d, prev } = shortest(n, adj, startNode)
  const nodes: number[] = []
  for (let v = endNode; v !== -1; v = prev[v]!) nodes.push(v)
  nodes.reverse()
  const branchOf = (v: number): Branch => {
    for (const b of branches) if (v >= b.offset && v < b.offset + b.count) return b
    throw new Error('painmodel: 节点不属于任何分支 / node outside every branch')
  }
  const point = (v: number): Vec3 => {
    const b = branchOf(v)
    const i = v - b.offset
    return [b.pts[i * 3]!, b.pts[i * 3 + 1]!, b.pts[i * 3 + 2]!]
  }
  let bridged = 0
  const partsOnPath: string[] = []
  const polyline: number[] = [...stim]
  for (let k = 0; k < nodes.length; k++) {
    const v = nodes[k]!
    const p = point(v)
    polyline.push(p[0], p[1], p[2])
    const part = branchOf(v).part
    if (partsOnPath[partsOnPath.length - 1] !== part) partsOnPath.push(part)
    if (k > 0) {
      const e = adj[nodes[k - 1]!]!.find((x) => x.to === v && x.bridge)
      const direct = adj[nodes[k - 1]!]!.find((x) => x.to === v && !x.bridge)
      if (e && (!direct || e.w <= direct.w)) bridged += e.w
    }
  }
  const along = d[endNode]!
  return {
    lengthM: skinGap + along,
    method: peripheral.length ? 'centreline' : 'straight',
    bridgedM: bridged,
    skinGapM: skinGap,
    parts: partsOnPath,
    polyline,
    end: point(endNode),
  }
}
