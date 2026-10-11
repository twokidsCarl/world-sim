// 派生几何：由相邻结构推导、而非取自数据源的结构。
// 一组实体的封闭包络（并集体素化 → 膨胀 → 提取光滑曲面），用于没有图谱能贴合本体的薄壳
// （包在本模型肺外的胸膜、心脏外的心包）。这里生成的一切都由调用方标注为“推导”。
// Structures derived from neighbouring geometry rather than taken from a source: closed
// envelopes of a set of solids (voxelise the union, dilate, extract a smooth surface).
// Used for thin shells that no atlas fits to this body (pleura round our lungs, pericardium
// round our heart). Everything made here is labelled as derived by the caller.

import type { Mesh } from './geometry.ts'
import { InsideTester } from './register.ts'

export interface EnvelopeOptions {
  /** 体素边长 / voxel size */
  voxel: number
  /** 包络面位于实体并集之外这么远 / the envelope lies this far outside the union of the solids */
  offset: number
  /** 对提取曲面做拉普拉斯平滑的次数 / Laplacian smoothing passes on the extracted surface */
  smooth?: number
}

/**
 * 在约 `offset` 距离处包住若干封闭网格并集的封闭曲面。
 * 占据网格 → 膨胀 → 盒式模糊 → surface nets 提取等值面 → 轻度平滑。精度约一个体素。
 * Closed surface enclosing the union of closed meshes at a distance of about `offset`.
 * Occupancy grid → dilation → box blur → iso-surface by surface nets → light smoothing.
 * Accurate to about one voxel.
 */
export function envelopeOf(meshes: Mesh[], opts: EnvelopeOptions): Mesh {
  const { voxel, offset } = opts
  const pad = offset + 4 * voxel
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const m of meshes) for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    b[k] = Math.min(b[k]!, m.positions[i + k]!)
    b[k + 3] = Math.max(b[k + 3]!, m.positions[i + k]!)
  }
  const o = [b[0]! - pad, b[1]! - pad, b[2]! - pad]
  const n = [0, 1, 2].map((k) => Math.ceil((b[k + 3]! + pad - o[k]!) / voxel) + 1) as [number, number, number]
  const [nx, ny, nz] = n
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k)
  let occ = new Float32Array(nx * ny * nz)
  for (const m of meshes) {
    const t = new InsideTester(m, 96)
    const tb = t.bbox
    const i0 = Math.max(0, Math.floor((tb[0] - o[0]!) / voxel))
    const i1 = Math.min(nx - 1, Math.ceil((tb[3] - o[0]!) / voxel))
    const j0 = Math.max(0, Math.floor((tb[1] - o[1]!) / voxel))
    const j1 = Math.min(ny - 1, Math.ceil((tb[4] - o[1]!) / voxel))
    const k0 = Math.max(0, Math.floor((tb[2] - o[2]!) / voxel))
    const k1 = Math.min(nz - 1, Math.ceil((tb[5] - o[2]!) / voxel))
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (occ[at(i, j, k)]) continue
      if (t.contains(o[0]! + i * voxel, o[1]! + j * voxel, o[2]! + k * voxel)) occ[at(i, j, k)] = 1
    }
  }
  // 按 `offset` 膨胀，每次一个体素（6 邻域与 26 邻域交替，近似球形）
  // dilation by `offset`, one voxel at a time (6-neighbourhood, then 26 alternately ≈ spherical)
  const steps = Math.max(0, Math.round(offset / voxel))
  for (let s = 0; s < steps; s++) {
    const next = Float32Array.from(occ)
    const diag = s % 2 === 1
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      if (occ[at(i, j, k)]) continue
      let hit = occ[at(i - 1, j, k)]! + occ[at(i + 1, j, k)]! + occ[at(i, j - 1, k)]! + occ[at(i, j + 1, k)]! + occ[at(i, j, k - 1)]! + occ[at(i, j, k + 1)]! > 0
      if (!hit && diag) {
        for (let dk = -1; dk <= 1 && !hit; dk++) for (let dj = -1; dj <= 1 && !hit; dj++) for (let di = -1; di <= 1 && !hit; di++) if (occ[at(i + di, j + dj, k + dk)]) hit = true
      }
      if (hit) next[at(i, j, k)] = 1
    }
    occ = next
  }
  // 可分离的三点盒式模糊两遍：得到光滑标量场，曲面取在 0.5
  // separable 3-tap box blur, twice: a smooth scalar field with the surface at 0.5
  for (let pass = 0; pass < 2; pass++) {
    for (const [di, dj, dk] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
      const next = new Float32Array(occ.length)
      for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
        next[at(i, j, k)] = (occ[at(i - di, j - dj, k - dk)]! + occ[at(i, j, k)]! + occ[at(i + di, j + dj, k + dk)]!) / 3
      }
      occ = next
    }
  }
  const mesh = surfaceNets(occ, n, 0.5)
  for (let i = 0; i < mesh.positions.length; i += 3) for (let k = 0; k < 3; k++) mesh.positions[i + k] = o[k]! + mesh.positions[i + k]! * voxel
  smoothMesh(mesh, opts.smooth ?? 3)
  return mesh
}

/**
 * 用朴素 surface nets 提取标量网格的等值面：曲面穿过的每个单元一个顶点（其各边交点的平均），
 * 每条跨越曲面的网格边一个四边形。坐标以网格为单位；三角形由内（值 > iso）朝外。
 * Iso-surface of a scalar grid by naive surface nets: one vertex per cell the surface passes
 * through (the mean of its edge crossings), one quad per grid edge that crosses the surface.
 * Positions are in grid units. Triangles face from inside (value > iso) to outside.
 */
export function surfaceNets(values: Float32Array, dims: [number, number, number], iso: number): Mesh {
  const [nx, ny, nz] = dims
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k)
  const cellAt = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k)
  const vertexOf = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1)
  const positions: number[] = []
  const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]] as const
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]] as const
  const v = new Float32Array(8)
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0
    for (let c = 0; c < 8; c++) {
      v[c] = values[at(i + CORNERS[c]![0], j + CORNERS[c]![1], k + CORNERS[c]![2])]!
      if (v[c]! > iso) mask |= 1 << c
    }
    if (mask === 0 || mask === 255) continue
    let x = 0
    let y = 0
    let z = 0
    let count = 0
    for (const [a, b] of EDGES) {
      if (v[a]! > iso === v[b]! > iso) continue
      const t = (iso - v[a]!) / (v[b]! - v[a]!)
      x += CORNERS[a]![0] + t * (CORNERS[b]![0] - CORNERS[a]![0])
      y += CORNERS[a]![1] + t * (CORNERS[b]![1] - CORNERS[a]![1])
      z += CORNERS[a]![2] + t * (CORNERS[b]![2] - CORNERS[a]![2])
      count++
    }
    vertexOf[cellAt(i, j, k)] = positions.length / 3
    positions.push(i + x / count, j + y / count, k + z / count)
  }
  const indices: number[] = []
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    if (flip) indices.push(a, c, b, a, d, c)
    else indices.push(a, b, c, a, c, d)
  }
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const inside = values[at(i, j, k)]! > iso
    // 沿 +x 的边由单元 (i, j-1..j, k-1..k) 共用 / edge along +x: shared by cells (i, j-1..j, k-1..k)
    if (inside !== values[at(i + 1, j, k)]! > iso) quad(vertexOf[cellAt(i, j - 1, k - 1)]!, vertexOf[cellAt(i, j, k - 1)]!, vertexOf[cellAt(i, j, k)]!, vertexOf[cellAt(i, j - 1, k)]!, !inside)
    if (inside !== values[at(i, j + 1, k)]! > iso) quad(vertexOf[cellAt(i - 1, j, k - 1)]!, vertexOf[cellAt(i - 1, j, k)]!, vertexOf[cellAt(i, j, k)]!, vertexOf[cellAt(i, j, k - 1)]!, !inside)
    if (inside !== values[at(i, j, k + 1)]! > iso) quad(vertexOf[cellAt(i - 1, j - 1, k)]!, vertexOf[cellAt(i, j - 1, k)]!, vertexOf[cellAt(i, j, k)]!, vertexOf[cellAt(i - 1, j, k)]!, !inside)
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

/** 原地拉普拉斯平滑（每个顶点向邻点均值移动一半） / In-place Laplacian smoothing (each vertex moves half-way to the mean of its neighbours). */
export function smoothMesh(mesh: Mesh, iterations: number): void {
  const nv = mesh.positions.length / 3
  const nb: Set<number>[] = Array.from({ length: nv }, () => new Set())
  for (let t = 0; t < mesh.indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = mesh.indices[t + k]!
    const b = mesh.indices[t + ((k + 1) % 3)]!
    nb[a]!.add(b)
    nb[b]!.add(a)
  }
  for (let it = 0; it < iterations; it++) {
    const next = Float32Array.from(mesh.positions)
    for (let v = 0; v < nv; v++) {
      const n = nb[v]!
      if (!n.size) continue
      let x = 0
      let y = 0
      let z = 0
      for (const j of n) {
        x += mesh.positions[3 * j]!
        y += mesh.positions[3 * j + 1]!
        z += mesh.positions[3 * j + 2]!
      }
      next[3 * v] = 0.5 * mesh.positions[3 * v]! + (0.5 * x) / n.size
      next[3 * v + 1] = 0.5 * mesh.positions[3 * v + 1]! + (0.5 * y) / n.size
      next[3 * v + 2] = 0.5 * mesh.positions[3 * v + 2]! + (0.5 * z) / n.size
    }
    mesh.positions.set(next)
  }
}

/**
 * 封住网格上的开口：每个边界环用一个位于环中心的顶点做扇形三角化，朝向与相邻面一致。
 * 输入必须已焊接（共用顶点）。返回新网格和封住的开口数。
 * Closes the openings of a mesh: every boundary loop gets a fan of triangles round a vertex at the
 * loop's centre, wound consistently with the faces next to it. The input must be welded (shared
 * vertices). Returns the new mesh and the number of openings closed.
 */
export function capHoles(mesh: Mesh): { mesh: Mesh; holes: number } {
  const nv = mesh.positions.length / 3
  // 有向边 a→b 若没有反向边 b→a 即为边界边 / a directed edge a→b without its opposite b→a is a boundary edge
  const directed = new Set<number>()
  for (let t = 0; t < mesh.indices.length; t += 3) for (let k = 0; k < 3; k++) directed.add(mesh.indices[t + k]! * nv + mesh.indices[t + ((k + 1) % 3)]!)
  const next = new Map<number, number>()
  for (const e of directed) {
    const a = Math.floor(e / nv)
    const b = e % nv
    if (!directed.has(b * nv + a)) next.set(a, b)
  }
  const positions = Array.from(mesh.positions)
  const indices = Array.from(mesh.indices)
  const seen = new Set<number>()
  let holes = 0
  for (const start of [...next.keys()].sort((a, b) => a - b)) {
    if (seen.has(start)) continue
    const loop: number[] = []
    let v = start
    while (!seen.has(v) && next.has(v)) {
      seen.add(v)
      loop.push(v)
      v = next.get(v)!
    }
    if (v !== start || loop.length < 3) continue
    let x = 0
    let y = 0
    let z = 0
    for (const i of loop) {
      x += mesh.positions[3 * i]!
      y += mesh.positions[3 * i + 1]!
      z += mesh.positions[3 * i + 2]!
    }
    const c = positions.length / 3
    positions.push(x / loop.length, y / loop.length, z / loop.length)
    for (let i = 0; i < loop.length; i++) indices.push(loop[(i + 1) % loop.length]!, loop[i]!, c)
    holes++
  }
  return { mesh: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }, holes }
}
