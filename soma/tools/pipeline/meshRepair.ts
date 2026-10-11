// 网格修复与切分：把由切片重建、再经作者平滑的表面整理成封闭、绕向一致的流形网格，
// 并能沿一个平面把网格切成两半、给切口加盖。用于 Wu 等（2015）的盆底结构（见 pelvis.ts）。
// Mesh repair and cutting: surfaces reconstructed from sections and smoothed by their authors are
// turned into closed, consistently wound manifold meshes, and a mesh can be cut in two along a plane
// with the cuts capped. Used for the pelvic-floor structures of Wu et al. 2015 (see pelvis.ts).

import { weld, type Mesh } from './geometry.ts'

export interface Topology {
  triangles: number
  /** 只属于一个三角形的边 / edges that belong to one triangle only */
  boundaryEdges: number
  /** 属于三个以上三角形的边 / edges shared by more than two triangles */
  nonManifoldEdges: number
  /** 两个三角形以相同方向经过的边（绕向不一致） / edges that both triangles run through in the same direction (inconsistent winding) */
  inconsistentEdges: number
  /** 封闭、流形且绕向一致 / closed, manifold and consistently wound */
  watertight: boolean
}

/** 按索引统计网格的拓扑（不合并重合的顶点）。 / Topology of a mesh by index (coincident vertices are not merged). */
export function topology(mesh: Mesh): Topology {
  const nv = mesh.positions.length / 3
  const edge = new Map<number, number>()
  const idx = mesh.indices
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const u = idx[t + k]!
      const v = idx[t + ((k + 1) % 3)]!
      const key = u < v ? u * nv + v : v * nv + u
      // 低 16 位：正向次数；高位：反向次数 / low 16 bits: forward count; high bits: backward count
      edge.set(key, (edge.get(key) ?? 0) + (u < v ? 1 : 65536))
    }
  }
  let boundaryEdges = 0
  let nonManifoldEdges = 0
  let inconsistentEdges = 0
  for (const c of edge.values()) {
    const f = c & 65535
    const b = c >>> 16
    if (f + b === 1) boundaryEdges++
    else if (f + b > 2) nonManifoldEdges++
    else if (f !== 1) inconsistentEdges++
  }
  return { triangles: idx.length / 3, boundaryEdges, nonManifoldEdges, inconsistentEdges, watertight: idx.length > 0 && boundaryEdges === 0 && nonManifoldEdges === 0 && inconsistentEdges === 0 }
}

/** 带符号体积（m³，外向绕向为正）。 / Signed volume (m³, positive for outward winding). */
export function signedVolume(mesh: Mesh): number {
  const p = mesh.positions
  const idx = mesh.indices
  let v = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t]!
    const b = 3 * idx[t + 1]!
    const c = 3 * idx[t + 2]!
    v += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)
  }
  return v / 6
}

/** 去掉未被引用的顶点。 / Drops unreferenced vertices. */
function compactMesh(positions: Float32Array, indices: Uint32Array): Mesh {
  const map = new Int32Array(positions.length / 3).fill(-1)
  const out: number[] = []
  const idx = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]!
    if (map[v] === -1) {
      map[v] = out.length / 3
      out.push(positions[3 * v]!, positions[3 * v + 1]!, positions[3 * v + 2]!)
    }
    idx[i] = map[v]!
  }
  return { positions: Float32Array.from(out), indices: idx }
}

/**
 * 连通分量（经由共享顶点），按三角形数从多到少排列。
 * Connected components (through shared vertices), largest first.
 */
export function components(mesh: Mesh): Mesh[] {
  const nv = mesh.positions.length / 3
  const parent = Int32Array.from({ length: nv }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!
      i = parent[i]!
    }
    return i
  }
  const idx = mesh.indices
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(idx[t]!)
    parent[find(idx[t + 1]!)] = a
    parent[find(idx[t + 2]!)] = a
  }
  const groups = new Map<number, number[]>()
  for (let t = 0; t < idx.length; t += 3) {
    const r = find(idx[t]!)
    let g = groups.get(r)
    if (!g) groups.set(r, (g = []))
    g.push(idx[t]!, idx[t + 1]!, idx[t + 2]!)
  }
  return [...groups.values()].sort((a, b) => b.length - a.length).map((g) => compactMesh(mesh.positions, Uint32Array.from(g)))
}

export function mergeMeshes(meshes: Mesh[]): Mesh {
  const positions = new Float32Array(meshes.reduce((s, m) => s + m.positions.length, 0))
  const indices = new Uint32Array(meshes.reduce((s, m) => s + m.indices.length, 0))
  let vo = 0
  let io = 0
  for (const m of meshes) {
    positions.set(m.positions, 3 * vo)
    for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k]! + vo
    vo += m.positions.length / 3
    io += m.indices.length
  }
  return { positions, indices }
}

export interface RepairReport {
  trianglesIn: number
  trianglesOut: number
  /** 被去掉的小碎片数及其三角形数 / small fragments removed, and their triangles */
  fragmentsRemoved: number
  fragmentTriangles: number
  /** 修复前属于三个以上三角形的边 / edges shared by more than two triangles before the repair */
  nonManifoldEdgesBefore: number
  /** 为拆开相切处而复制的顶点数 / vertices duplicated to separate touching sheets */
  verticesSplit: number
  /** 第二遍中被去掉并重新补上的三角形数 / triangles removed and re-filled in the second pass */
  trianglesPatched: number
  flipped: boolean
  after: Topology
}

/**
 * 把一个表面整理成封闭流形：合并重合顶点，去掉退化和重复的三角形；沿一条边相切的两片表面
 * （该边属于四个三角形）按绕边的角度次序配对，使围住同一块实体的两个三角形相连，再把在该处
 * 相切的各片分开（复制顶点，位置不变）；去掉小碎片（三角形数少于最大分量的 `minShare`）；
 * 总体积为负时整体翻转绕向。几何位置不变。
 * Turns a surface into a closed manifold: coincident vertices are merged, degenerate and duplicate
 * triangles dropped; where two sheets touch along an edge (an edge with four triangles) the triangles
 * are paired by angular order round the edge so that the two bounding one piece of solid are joined,
 * and the sheets touching there are separated (vertices duplicated, positions unchanged); small
 * fragments (fewer triangles than `minShare` of the largest component) are removed; the winding is
 * flipped as a whole when the total volume is negative. No position changes.
 */
export function repairClosed(input: Mesh, minShare = 0.15): { mesh: Mesh; report: RepairReport } {
  const w = weld(input.positions, input.indices)
  const p = w.positions
  const nv = p.length / 3
  // 去掉退化的和重复的三角形；同一组顶点、绕向相反的一对（零厚度薄片）两个都去掉
  // drop degenerate and duplicate triangles; a pair on the same vertices with opposite winding (a zero-thickness flap) goes altogether
  const seen = new Map<string, number[]>()
  const tris: number[] = []
  for (let t = 0; t < w.indices.length; t += 3) {
    const a = w.indices[t]!
    const b = w.indices[t + 1]!
    const c = w.indices[t + 2]!
    if (a === b || b === c || a === c) continue
    const m = Math.min(a, b, c)
    const rot = m === a ? [a, b, c] : m === b ? [b, c, a] : [c, a, b]
    const key = [...rot].sort((x, y) => x - y).join(',')
    const list = seen.get(key) ?? []
    list.push(rot[0]!, rot[1]!, rot[2]!)
    seen.set(key, list)
  }
  for (const list of seen.values()) {
    let fwd = 0
    let bwd = 0
    const first = [list[0]!, list[1]!, list[2]!]
    for (let k = 0; k < list.length; k += 3) {
      if (list[k + 1] === first[1]) fwd++
      else bwd++
    }
    if (fwd > bwd) tris.push(first[0]!, first[1]!, first[2]!)
    else if (bwd > fwd) tris.push(first[0]!, first[2]!, first[1]!)
  }
  const nt = tris.length / 3
  // 边 → 经过它的三角形角 / edge → the triangle corners running through it
  const edges = new Map<number, number[]>()
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const u = tris[3 * t + k]!
      const v = tris[3 * t + ((k + 1) % 3)]!
      const key = u < v ? u * nv + v : v * nv + u
      let e = edges.get(key)
      if (!e) edges.set(key, (e = []))
      e.push(3 * t + k)
    }
  }
  // 角的并查集：跨一条边相连的两个三角形，在该边两端的角各自合并
  // union-find over corners: two triangles joined across an edge have their corners at both ends of it merged
  const parent = Int32Array.from({ length: 3 * nt }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!
      i = parent[i]!
    }
    return i
  }
  const cornerAt = (t: number, v: number) => (tris[3 * t] === v ? 3 * t : tris[3 * t + 1] === v ? 3 * t + 1 : 3 * t + 2)
  const link = (ca: number, cb: number) => {
    const ta = Math.floor(ca / 3)
    const tb = Math.floor(cb / 3)
    const u = tris[ca]!
    const v = tris[3 * ta + ((ca % 3) + 1) % 3]!
    parent[find(cornerAt(ta, u))] = find(cornerAt(tb, u))
    parent[find(cornerAt(ta, v))] = find(cornerAt(tb, v))
  }
  let nonManifoldEdgesBefore = 0
  for (const [key, e] of edges) {
    if (e.length === 2) {
      link(e[0]!, e[1]!)
      continue
    }
    if (e.length < 2) continue
    nonManifoldEdgesBefore++
    if (e.length % 2) continue
    const u = Math.floor(key / nv)
    const v = key % nv
    const ax = [p[3 * v]! - p[3 * u]!, p[3 * v + 1]! - p[3 * u + 1]!, p[3 * v + 2]! - p[3 * u + 2]!]
    const al = Math.hypot(ax[0]!, ax[1]!, ax[2]!) || 1
    const a = ax.map((x) => x / al)
    // 垂直于边的一组基 / a basis across the edge
    const h = Math.abs(a[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const d0 = h[0]! * a[0]! + h[1]! * a[1]! + h[2]! * a[2]!
    let e1 = [h[0]! - d0 * a[0]!, h[1]! - d0 * a[1]!, h[2]! - d0 * a[2]!]
    const l1 = Math.hypot(e1[0]!, e1[1]!, e1[2]!)
    e1 = e1.map((x) => x / l1)
    const e2 = [a[1]! * e1[2]! - a[2]! * e1[1]!, a[2]! * e1[0]! - a[0]! * e1[2]!, a[0]! * e1[1]! - a[1]! * e1[0]!]
    const fan = e.map((c) => {
      const t = Math.floor(c / 3)
      const o = tris[3 * t + ((c % 3) + 2) % 3]!
      const r = [p[3 * o]! - p[3 * u]!, p[3 * o + 1]! - p[3 * u + 1]!, p[3 * o + 2]! - p[3 * u + 2]!]
      const ang = Math.atan2(r[0]! * e2[0]! + r[1]! * e2[1]! + r[2]! * e2[2]!, r[0]! * e1[0]! + r[1]! * e1[1]! + r[2]! * e1[2]!)
      // 三角形沿 u→v 经过这条边时法向指向角度增大的一侧，实体在另一侧；沿 v→u 时实体在角度增大的一侧
      // a triangle running through the edge as u→v has its normal towards increasing angle and the solid behind; as v→u the solid is ahead
      return { c, ang, solidAhead: tris[c] !== u }
    }).sort((x, y) => x.ang - y.ang)
    for (let i = 0; i < fan.length; i++) {
      const cur = fan[i]!
      const next = fan[(i + 1) % fan.length]!
      if (cur.solidAhead && !next.solidAhead) link(cur.c, next.c)
    }
  }
  // 每个角类一个顶点 / one vertex per class of corners
  const vertexOf = new Map<number, number>()
  const pos: number[] = []
  const idx = new Uint32Array(3 * nt)
  for (let c = 0; c < 3 * nt; c++) {
    const r = find(c)
    let v = vertexOf.get(r)
    if (v === undefined) {
      v = pos.length / 3
      vertexOf.set(r, v)
      const s = tris[c]!
      pos.push(p[3 * s]!, p[3 * s + 1]!, p[3 * s + 2]!)
    }
    idx[c] = v
  }
  const used = new Set(tris)
  const split: Mesh = { positions: Float32Array.from(pos), indices: idx }
  // 小碎片 / small fragments
  const comps = components(split)
  const largest = comps[0] ? comps[0].indices.length : 0
  const kept = comps.filter((c) => c.indices.length >= minShare * largest)
  let mesh = kept.length === 1 ? kept[0]! : mergeMeshes(kept)
  // 第二遍：仍有问题的边（配对失败、奇数个三角形）——去掉其两端顶点周围的三角形，再把留下的小孔补上
  // second pass: edges still wrong (pairing failed, odd triangle count) — the triangles round their end vertices are removed and the small holes left are filled
  let patched = 0
  for (let round = 0; round < 4 && !topology(mesh).watertight; round++) {
    const res = patchBadEdges(mesh)
    if (!res.removed) break
    patched += res.removed
    mesh = res.mesh
  }
  const flipped = signedVolume(mesh) < 0
  if (flipped) {
    const f = Uint32Array.from(mesh.indices)
    for (let t = 0; t < f.length; t += 3) [f[t + 1], f[t + 2]] = [f[t + 2]!, f[t + 1]!]
    mesh = { positions: mesh.positions, indices: f }
  }
  return {
    mesh,
    report: {
      trianglesIn: input.indices.length / 3,
      trianglesOut: mesh.indices.length / 3,
      fragmentsRemoved: comps.length - kept.length,
      fragmentTriangles: comps.slice(kept.length).reduce((s, c) => s + c.indices.length / 3, 0),
      nonManifoldEdgesBefore,
      verticesSplit: pos.length / 3 - used.size,
      trianglesPatched: patched,
      flipped,
      after: topology(mesh),
    },
  }
}

/** 简单多边形的耳切三角化（二维坐标 xy，返回顶点下标三元组，绕向与输入一致）。 / Ear clipping of a simple polygon (2-D xy; index triples, wound like the input). */
function earClip(xy: number[]): number[] {
  const n = xy.length / 2
  if (n < 3) return []
  let area = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    area += xy[2 * i]! * xy[2 * j + 1]! - xy[2 * j]! * xy[2 * i + 1]!
  }
  const sign = area >= 0 ? 1 : -1
  const ring = Array.from({ length: n }, (_, i) => i)
  const out: number[] = []
  const cross = (a: number, b: number, c: number) => (xy[2 * b]! - xy[2 * a]!) * (xy[2 * c + 1]! - xy[2 * a + 1]!) - (xy[2 * b + 1]! - xy[2 * a + 1]!) * (xy[2 * c]! - xy[2 * a]!)
  let guard = 0
  while (ring.length > 3 && guard++ < 4 * n * n) {
    let best = -1
    let bestScore = -Infinity
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length]!
      const b = ring[i]!
      const c = ring[(i + 1) % ring.length]!
      const cr = cross(a, b, c) * sign
      if (cr <= 0) continue
      let empty = true
      for (const q of ring) {
        if (q === a || q === b || q === c) continue
        if (cross(a, b, q) * sign >= 0 && cross(b, c, q) * sign >= 0 && cross(c, a, q) * sign >= 0) {
          empty = false
          break
        }
      }
      if (!empty) continue
      // 取最“胖”的耳，避免细长三角形 / the fattest ear, to avoid slivers
      const la = Math.hypot(xy[2 * b]! - xy[2 * a]!, xy[2 * b + 1]! - xy[2 * a + 1]!)
      const lb = Math.hypot(xy[2 * c]! - xy[2 * b]!, xy[2 * c + 1]! - xy[2 * b + 1]!)
      const lc = Math.hypot(xy[2 * a]! - xy[2 * c]!, xy[2 * a + 1]! - xy[2 * c + 1]!)
      const score = cr / (la * la + lb * lb + lc * lc + 1e-30)
      if (score > bestScore) {
        bestScore = score
        best = i
      }
    }
    // 找不到合格的耳（数值退化）：切掉任意一个凸角 / no valid ear (numerically degenerate): clip any convex corner
    if (best < 0) best = 0
    const a = ring[(best + ring.length - 1) % ring.length]!
    const b = ring[best]!
    const c = ring[(best + 1) % ring.length]!
    out.push(a, b, c)
    ring.splice(best, 1)
  }
  if (ring.length === 3) out.push(ring[0]!, ring[1]!, ring[2]!)
  return out
}

/**
 * 去掉有问题的边（边界、非流形、绕向不一致）两端顶点周围的全部三角形，再把由此产生的孔逐个补上
 * （投影到最佳拟合平面做耳切）。顶点位置不变。
 * Removes every triangle round the end vertices of bad edges (boundary, non-manifold, inconsistent)
 * and fills the holes this leaves one by one (ear clipping in the best-fit plane). Positions stay.
 */
function patchBadEdges(mesh: Mesh): { mesh: Mesh; removed: number } {
  const nv = mesh.positions.length / 3
  const idx = mesh.indices
  const p = mesh.positions
  const count = new Map<number, number>()
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
    const u = idx[t + k]!
    const v = idx[t + ((k + 1) % 3)]!
    const key = u < v ? u * nv + v : v * nv + u
    count.set(key, (count.get(key) ?? 0) + (u < v ? 1 : 65536))
  }
  const bad = new Uint8Array(nv)
  for (const [key, c] of count) {
    if ((c & 65535) === 1 && c >>> 16 === 1) continue
    bad[Math.floor(key / nv)] = 1
    bad[key % nv] = 1
  }
  const keep: number[] = []
  let removed = 0
  for (let t = 0; t < idx.length; t += 3) {
    if (bad[idx[t]!] || bad[idx[t + 1]!] || bad[idx[t + 2]!]) removed++
    else keep.push(idx[t]!, idx[t + 1]!, idx[t + 2]!)
  }
  if (!removed) return { mesh, removed: 0 }
  // 剩余网格的边界边（有向） / directed boundary edges of what is left
  const dir = new Map<number, number>()
  for (let t = 0; t < keep.length; t += 3) for (let k = 0; k < 3; k++) {
    const u = keep[t + k]!
    const v = keep[t + ((k + 1) % 3)]!
    dir.set(u * nv + v, (dir.get(u * nv + v) ?? 0) + 1)
  }
  const next = new Map<number, number[]>()
  for (const key of dir.keys()) {
    const u = Math.floor(key / nv)
    const v = key % nv
    if (dir.has(v * nv + u)) continue
    // 补片要用反向边 v→u / the patch needs the reversed edge v→u
    next.set(v, [...(next.get(v) ?? []), u])
  }
  for (const start of [...next.keys()]) {
    while (next.get(start)?.length) {
      const loop: number[] = []
      let cur = start
      let closed = false
      for (let guard = 0; guard < 4096; guard++) {
        const outs = next.get(cur)
        if (!outs?.length) break
        loop.push(cur)
        cur = outs.pop()!
        if (cur === start) {
          closed = true
          break
        }
      }
      if (!closed || loop.length < 3) continue
      // 最佳拟合平面：Newell 法向 / best-fit plane: Newell normal
      const n = [0, 0, 0]
      for (let i = 0; i < loop.length; i++) {
        const a = 3 * loop[i]!
        const b = 3 * loop[(i + 1) % loop.length]!
        n[0] = n[0]! + (p[a + 1]! - p[b + 1]!) * (p[a + 2]! + p[b + 2]!)
        n[1] = n[1]! + (p[a + 2]! - p[b + 2]!) * (p[a]! + p[b]!)
        n[2] = n[2]! + (p[a]! - p[b]!) * (p[a + 1]! + p[b + 1]!)
      }
      const nl = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
      const nn = n.map((x) => x / nl)
      const h = Math.abs(nn[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0]
      const d0 = h[0]! * nn[0]! + h[1]! * nn[1]! + h[2]! * nn[2]!
      let e1 = [h[0]! - d0 * nn[0]!, h[1]! - d0 * nn[1]!, h[2]! - d0 * nn[2]!]
      const l1 = Math.hypot(e1[0]!, e1[1]!, e1[2]!)
      e1 = e1.map((x) => x / l1)
      const e2 = [nn[1]! * e1[2]! - nn[2]! * e1[1]!, nn[2]! * e1[0]! - nn[0]! * e1[2]!, nn[0]! * e1[1]! - nn[1]! * e1[0]!]
      const xy: number[] = []
      for (const v of loop) xy.push(p[3 * v]! * e1[0]! + p[3 * v + 1]! * e1[1]! + p[3 * v + 2]! * e1[2]!, p[3 * v]! * e2[0]! + p[3 * v + 1]! * e2[1]! + p[3 * v + 2]! * e2[2]!)
      const tri = earClip(xy)
      for (let k = 0; k < tri.length; k += 3) keep.push(loop[tri[k]!]!, loop[tri[k + 1]!]!, loop[tri[k + 2]!]!)
    }
  }
  return { mesh: compactMesh(p, Uint32Array.from(keep)), removed }
}

export interface CutResult {
  /** 平面法向一侧（n·x > d）和另一侧 / the side the normal points to (n·x > d) and the other side */
  positive: Mesh
  negative: Mesh
  /** 切口的环数；`holes` 为嵌套在其他环里的环（按孔桥接到外环） / cut loops; `holes` are loops nested in another (bridged to the outer loop as holes) */
  loops: number
  holes: number
}

/**
 * 沿平面 n·x = d 把封闭网格切成两半并给切口加盖，两半各自封闭。输入必须封闭且绕向一致。
 * Cuts a closed mesh in two along the plane n·x = d and caps the cuts, so that each half is closed.
 * The input must be closed and consistently wound.
 */
export function cutByPlane(mesh: Mesh, n: readonly [number, number, number], d: number): CutResult {
  const p = mesh.positions
  const nv = p.length / 3
  const s = new Float64Array(nv)
  for (let i = 0; i < nv; i++) {
    const v = n[0] * p[3 * i]! + n[1] * p[3 * i + 1]! + n[2] * p[3 * i + 2]! - d
    s[i] = Math.abs(v) < 1e-9 ? 1e-9 : v
  }
  const pos: number[] = Array.from(p)
  const cutVertex = new Map<number, number>()
  const cut = (a: number, b: number): number => {
    const key = a < b ? a * nv + b : b * nv + a
    let v = cutVertex.get(key)
    if (v === undefined) {
      const t = s[a]! / (s[a]! - s[b]!)
      v = pos.length / 3
      pos.push(p[3 * a]! + t * (p[3 * b]! - p[3 * a]!), p[3 * a + 1]! + t * (p[3 * b + 1]! - p[3 * a + 1]!), p[3 * a + 2]! + t * (p[3 * b + 2]! - p[3 * a + 2]!))
      cutVertex.set(key, v)
    }
    return v
  }
  const sides: [number[], number[]] = [[], []]
  // 正侧一半的切口边（有向，沿该半边界的反方向，即盖子的边） / cut edges of the positive half (directed against its boundary, i.e. as edges of the cap)
  const capEdges: [number, number][] = []
  const idx = mesh.indices
  for (let t = 0; t < idx.length; t += 3) {
    const v = [idx[t]!, idx[t + 1]!, idx[t + 2]!]
    const pos3 = v.map((i) => s[i]! > 0)
    const count = pos3.filter(Boolean).length
    if (count === 3) sides[0].push(...v)
    else if (count === 0) sides[1].push(...v)
    else {
      // 把单独在一侧的顶点转到第一位 / rotate the lone vertex to the front
      const lone = count === 1 ? pos3.indexOf(true) : pos3.indexOf(false)
      const a = v[lone]!
      const b = v[(lone + 1) % 3]!
      const c = v[(lone + 2) % 3]!
      const ab = cut(a, b)
      const ac = cut(a, c)
      const loneSide = count === 1 ? 0 : 1
      sides[loneSide]!.push(a, ab, ac)
      sides[1 - loneSide]!.push(ab, b, c, ab, c, ac)
      // 含单独顶点的一半的边界边是 ab→ac，它的盖子用 ac→ab
      // the half with the lone vertex has boundary edge ab→ac; its cap uses ac→ab
      if (loneSide === 0) capEdges.push([ac, ab])
      else capEdges.push([ab, ac])
    }
  }
  // 把切口边连成环 / chain the cut edges into loops
  const next = new Map<number, number[]>()
  for (const [a, b] of capEdges) next.set(a, [...(next.get(a) ?? []), b])
  const loops: number[][] = []
  for (const [start] of capEdges) {
    if (!next.get(start)?.length) continue
    const loop: number[] = []
    let cur = start
    for (let guard = 0; guard < capEdges.length + 1; guard++) {
      const outs = next.get(cur)
      if (!outs?.length) break
      loop.push(cur)
      cur = outs.pop()!
      if (cur === start) break
    }
    if (loop.length >= 3 && cur === start) loops.push(loop)
  }
  // 平面内的二维坐标，取向使正侧一半的盖子（法向 −n）在该坐标系中为逆时针
  // 2-D coordinates in the plane, oriented so that the cap of the positive half (normal −n) is counter-clockwise in them
  const h = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const d0 = h[0]! * n[0] + h[1]! * n[1] + h[2]! * n[2]
  let e1 = [h[0]! - d0 * n[0], h[1]! - d0 * n[1], h[2]! - d0 * n[2]]
  const l1 = Math.hypot(e1[0]!, e1[1]!, e1[2]!)
  e1 = e1.map((x) => x / l1)
  const e2 = [-(n[1] * e1[2]! - n[2] * e1[1]!), -(n[2] * e1[0]! - n[0] * e1[2]!), -(n[0] * e1[1]! - n[1] * e1[0]!)]
  const uv = (v: number): [number, number] => [pos[3 * v]! * e1[0]! + pos[3 * v + 1]! * e1[1]! + pos[3 * v + 2]! * e1[2]!, pos[3 * v]! * e2[0]! + pos[3 * v + 1]! * e2[1]! + pos[3 * v + 2]! * e2[2]!]
  const areaOf = (loop: number[]) => {
    let a = 0
    for (let i = 0; i < loop.length; i++) {
      const [x0, y0] = uv(loop[i]!)
      const [x1, y1] = uv(loop[(i + 1) % loop.length]!)
      a += x0 * y1 - x1 * y0
    }
    return a / 2
  }
  const inside = (loop: number[], q: [number, number]) => {
    let c = false
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [xi, yi] = uv(loop[i]!)
      const [xj, yj] = uv(loop[j]!)
      if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) c = !c
    }
    return c
  }
  const outer = loops.filter((l) => areaOf(l) > 0)
  const holeLoops = loops.filter((l) => areaOf(l) <= 0)
  // 孔：桥接到包含它的外环上距离最近的一对顶点 / holes: bridged to the containing outer loop at the closest pair of vertices
  for (const hole of holeLoops) {
    const o = outer.find((l) => inside(l, uv(hole[0]!)))
    if (!o) continue
    let bi = 0
    let bj = 0
    let bd = Infinity
    for (let i = 0; i < o.length; i++) for (let j = 0; j < hole.length; j++) {
      const [x0, y0] = uv(o[i]!)
      const [x1, y1] = uv(hole[j]!)
      const dd = (x0 - x1) ** 2 + (y0 - y1) ** 2
      if (dd < bd) {
        bd = dd
        bi = i
        bj = j
      }
    }
    o.splice(bi + 1, 0, ...hole.slice(bj), ...hole.slice(0, bj), hole[bj]!, o[bi]!)
  }
  for (const loop of outer) {
    const xy: number[] = []
    for (const v of loop) xy.push(...uv(v))
    const tri = earClip(xy)
    for (let k = 0; k < tri.length; k += 3) {
      const a = loop[tri[k]!]!
      const b = loop[tri[k + 1]!]!
      const c = loop[tri[k + 2]!]!
      if (a === b || b === c || a === c) continue
      sides[0].push(a, b, c)
      sides[1].push(a, c, b)
    }
  }
  const all = Float32Array.from(pos)
  return { positive: compactMesh(all, Uint32Array.from(sides[0])), negative: compactMesh(all, Uint32Array.from(sides[1])), loops: loops.length, holes: holeLoops.length }
}
