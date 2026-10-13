// 体心立方（BCC）四面体格：笼子的拓扑。纯算术，没有依赖。
// The body-centred cubic (BCC) tetrahedral lattice: the topology of the cage. Pure arithmetic, no dependencies.
//
// 为什么用它 / Why this lattice
//   · 每个四面体都全等、形状好（二面角 60° / 90°），不需要网格生成器，也就没有许可问题。
//     every tetrahedron is congruent and well shaped (dihedral angles 60° / 90°); no mesher, so no licence question.
//   · 任意一点落在哪个四面体里可以直接算出来，所以渲染顶点的嵌入不必逐个存盘。
//     the tetrahedron containing any point follows by arithmetic, so the embedding of render vertices need not be stored one by one.
//
// 定义 / Definition
//   格子有 nx × ny × nz 个边长为 `cell` 的立方单元。结点有两类：单元的角点和单元的中心。
//   每一对共面的相邻单元（"内面"）给出 4 个四面体：两个中心 + 这个面的一条边的两个角点。
//   最外一圈单元的外侧面没有四面体，所以建格时要比身体多留一圈单元。
//   The lattice has nx × ny × nz cubic cells of edge `cell`. Nodes are of two kinds: cell corners and cell centres.
//   Each pair of face-sharing cells (an "inner face") gives 4 tetrahedra: the two centres plus the two corners of one
//   edge of that face. Outer faces of the outermost cells carry none, so a lattice is built one cell larger than the body.
//
//   编号 / Numbering
//     角点 corner (i,j,k), 0 ≤ i ≤ nx …      id = i + (nx+1)·(j + (ny+1)·k)
//     中心 centre (i,j,k), 0 ≤ i < nx …      id = NC + i + nx·(j + ny·k),  NC = (nx+1)(ny+1)(nz+1)
//     槽位 slot = ((单元下标 cell index)·3 + axis)·4 + edge；面在单元 (i,j,k) 与 (i,j,k)+e_axis 之间
//                 the face lies between cell (i,j,k) and (i,j,k)+e_axis; edge 0..3 = a−, a+, b−, b+ with
//                 a = (axis+1) mod 3, b = (axis+2) mod 3.

export interface Lattice {
  /** 角点 (0,0,0) 的位置，米 / position of corner (0,0,0), metres */
  origin: [number, number, number]
  /** 单元边长，米 / cell edge, metres */
  cell: number
  dims: [number, number, number]
}

export const cornerCount = (l: Lattice): number => (l.dims[0] + 1) * (l.dims[1] + 1) * (l.dims[2] + 1)
export const latticeNodeCount = (l: Lattice): number => cornerCount(l) + l.dims[0] * l.dims[1] * l.dims[2]
export const slotCount = (l: Lattice): number => l.dims[0] * l.dims[1] * l.dims[2] * 12

/** 格点位置写入 out[o..o+2] / writes the position of a lattice node to out[o..o+2] */
export function latticeNodePosition(l: Lattice, id: number, out: Float32Array | Float64Array | number[], o = 0): void {
  const [nx, ny] = l.dims
  const nc = cornerCount(l)
  let i: number, j: number, k: number, h = 0
  if (id < nc) {
    i = id % (nx + 1)
    j = Math.floor(id / (nx + 1)) % (ny + 1)
    k = Math.floor(id / ((nx + 1) * (ny + 1)))
  } else {
    const c = id - nc
    i = c % nx
    j = Math.floor(c / nx) % ny
    k = Math.floor(c / (nx * ny))
    h = 0.5
  }
  out[o] = l.origin[0] + (i + h) * l.cell
  out[o + 1] = l.origin[1] + (j + h) * l.cell
  out[o + 2] = l.origin[2] + (k + h) * l.cell
}

/**
 * 槽位的四个格点（体积为正的顺序）；槽位不存在（面在格子之外）时返回 null。
 * The four lattice nodes of a slot, ordered for positive volume; null when the slot does not exist (its face is outside the lattice).
 */
export function slotNodes(l: Lattice, slot: number): [number, number, number, number] | null {
  const [nx, ny, nz] = l.dims
  const edge = slot & 3
  const fa = slot >> 2
  const axis = fa % 3
  const cell = (fa - axis) / 3
  const c = [cell % nx, Math.floor(cell / nx) % ny, Math.floor(cell / (nx * ny))]
  if (c[axis]! + 1 >= l.dims[axis]! || cell >= nx * ny * nz) return null
  const a = (axis + 1) % 3, b = (axis + 2) % 3
  const corner = (da: number, db: number): number => {
    const q = [c[0]!, c[1]!, c[2]!]
    q[axis] = q[axis]! + 1
    q[a] = q[a]! + da
    q[b] = q[b]! + db
    return q[0]! + (nx + 1) * (q[1]! + (ny + 1) * q[2]!)
  }
  const nc = cornerCount(l)
  const c0 = nc + cell
  const step = axis === 0 ? 1 : axis === 1 ? nx : nx * ny
  const c1 = c0 + step
  // 绕 c0→c1 轴的四条边；这样排的两个角点使体积为正
  // the four edges round the axis c0→c1; the corner order below gives a positive volume
  switch (edge) {
    case 0: return [c0, c1, corner(0, 1), corner(0, 0)]
    case 1: return [c0, c1, corner(1, 0), corner(1, 1)]
    case 2: return [c0, c1, corner(0, 0), corner(1, 0)]
    default: return [c0, c1, corner(1, 1), corner(0, 1)]
  }
}

/** 包含点 (x,y,z) 的槽位；点在格子的内面之外时为 −1。 The slot containing (x,y,z); −1 when the point is outside the inner faces of the lattice. */
export function locateSlot(l: Lattice, x: number, y: number, z: number): number {
  const [nx, ny, nz] = l.dims
  const u = [(x - l.origin[0]) / l.cell, (y - l.origin[1]) / l.cell, (z - l.origin[2]) / l.cell]
  const c = [Math.floor(u[0]!), Math.floor(u[1]!), Math.floor(u[2]!)]
  for (let k = 0; k < 3; k++) if (c[k]! < 0 || c[k]! >= l.dims[k]!) return -1
  const d = [u[0]! - c[0]! - 0.5, u[1]! - c[1]! - 0.5, u[2]! - c[2]! - 0.5]
  let axis = 0
  if (Math.abs(d[1]!) > Math.abs(d[axis]!)) axis = 1
  if (Math.abs(d[2]!) > Math.abs(d[axis]!)) axis = 2
  // 面属于下标较小的那个单元 / the face belongs to the cell with the smaller index
  if (d[axis]! < 0) c[axis] = c[axis]! - 1
  if (c[axis]! < 0 || c[axis]! + 1 >= l.dims[axis]!) return -1
  const a = (axis + 1) % 3, b = (axis + 2) % 3
  const edge = Math.abs(d[a]!) > Math.abs(d[b]!) ? (d[a]! < 0 ? 0 : 1) : d[b]! < 0 ? 2 : 3
  const cell = c[0]! + nx * (c[1]! + ny * c[2]!)
  void nz
  return ((cell * 3 + axis) << 2) | edge
}

/**
 * 点 p 相对四面体 (n0..n3) 的重心坐标，写入 out[0..3]。`pos` 是扁平 xyz。
 * Barycentric coordinates of p in the tetrahedron (n0..n3), written to out[0..3]. `pos` is flat xyz.
 */
export function barycentric(pos: ArrayLike<number>, n0: number, n1: number, n2: number, n3: number, x: number, y: number, z: number, out: Float32Array | Float64Array | number[]): void {
  const ax = pos[n0 * 3]!, ay = pos[n0 * 3 + 1]!, az = pos[n0 * 3 + 2]!
  const e1x = pos[n1 * 3]! - ax, e1y = pos[n1 * 3 + 1]! - ay, e1z = pos[n1 * 3 + 2]! - az
  const e2x = pos[n2 * 3]! - ax, e2y = pos[n2 * 3 + 1]! - ay, e2z = pos[n2 * 3 + 2]! - az
  const e3x = pos[n3 * 3]! - ax, e3y = pos[n3 * 3 + 1]! - ay, e3z = pos[n3 * 3 + 2]! - az
  const px = x - ax, py = y - ay, pz = z - az
  const det = e1x * (e2y * e3z - e2z * e3y) - e2x * (e1y * e3z - e1z * e3y) + e3x * (e1y * e2z - e1z * e2y)
  const inv = 1 / det
  const b1 = (px * (e2y * e3z - e2z * e3y) - e2x * (py * e3z - pz * e3y) + e3x * (py * e2z - pz * e2y)) * inv
  const b2 = (e1x * (py * e3z - pz * e3y) - px * (e1y * e3z - e1z * e3y) + e3x * (e1y * pz - e1z * py)) * inv
  const b3 = (e1x * (e2y * pz - e2z * py) - e2x * (e1y * pz - e1z * py) + px * (e1y * e2z - e1z * e2y)) * inv
  out[0] = 1 - b1 - b2 - b3
  out[1] = b1
  out[2] = b2
  out[3] = b3
}

export interface LatticeMesh {
  /** 扁平 xyz / flat xyz */
  nodes: Float32Array
  tets: Uint32Array
  /** 每个四面体的槽位 / the slot of every tetrahedron */
  slots: Uint32Array
  /** 每个结点的格点编号（结点分裂后，几个结点可以有同一个格点编号）/ the lattice id of every node (after node splitting several nodes may share one) */
  latticeId: Uint32Array
}

/**
 * 由选中的槽位建网格：只保留用到的格点并重新编号（按格点编号升序，结果确定）。
 * Builds a mesh from chosen slots: only the lattice nodes in use are kept and renumbered (ascending lattice id, so the result is deterministic).
 */
export function meshFromSlots(l: Lattice, slots: ArrayLike<number>): LatticeMesh {
  const used = new Set<number>()
  const quads: [number, number, number, number][] = []
  for (let s = 0; s < slots.length; s++) {
    const q = slotNodes(l, slots[s]!)
    if (!q) throw new Error(`softbody: slot ${slots[s]} is outside the lattice`)
    quads.push(q)
    for (const n of q) used.add(n)
  }
  const ids = Uint32Array.from([...used].sort((a, b) => a - b))
  const index = new Map<number, number>()
  ids.forEach((id, i) => index.set(id, i))
  const nodes = new Float32Array(ids.length * 3)
  ids.forEach((id, i) => latticeNodePosition(l, id, nodes, i * 3))
  const tets = new Uint32Array(quads.length * 4)
  quads.forEach((q, t) => q.forEach((n, k) => (tets[t * 4 + k] = index.get(n)!)))
  return { nodes, tets, slots: Uint32Array.from(slots), latticeId: ids }
}

/** 一个长方体范围内的 BCC 网格（测试和小算例用）。 The BCC mesh within a box (for tests and small examples). */
export function boxLattice(size: [number, number, number], cell: number, origin: [number, number, number] = [0, 0, 0]): { lattice: Lattice; mesh: LatticeMesh } {
  // BCC 四面体铺不出平的轴向面：这里取重心落在盒内的四面体，表面是锯齿状的。要精确的盒子用 boxKuhn。
  // BCC tetrahedra cannot form a flat axis-aligned face: tetrahedra whose centroid is inside the box are taken, so the surface is ragged. For an exact box use boxKuhn.
  const dims: [number, number, number] = [Math.round(size[0] / cell) + 2, Math.round(size[1] / cell) + 2, Math.round(size[2] / cell) + 2]
  const lattice: Lattice = { origin: [origin[0] - cell, origin[1] - cell, origin[2] - cell], cell, dims }
  const slots: number[] = []
  const p = [0, 0, 0]
  const n = slotCount(lattice)
  for (let s = 0; s < n; s++) {
    const q = slotNodes(lattice, s)
    if (!q) continue
    let cx = 0, cy = 0, cz = 0
    for (const id of q) {
      latticeNodePosition(lattice, id, p)
      cx += p[0]! / 4
      cy += p[1]! / 4
      cz += p[2]! / 4
    }
    const e = cell * 1e-6
    if (cx > origin[0] + e && cx < origin[0] + size[0] - e && cy > origin[1] + e && cy < origin[1] + size[1] - e && cz > origin[2] + e && cz < origin[2] + size[2] - e) slots.push(s)
  }
  return { lattice, mesh: meshFromSlots(lattice, slots) }
}

/**
 * 精确的长方体：nx × ny × nz 个立方体，每个按 Kuhn 剖分成 6 个四面体（相邻立方体的面剖分一致）。解析算例用。
 * An exact box: nx × ny × nz cubes, each cut into 6 tetrahedra by the Kuhn subdivision (face diagonals of neighbours agree). For analytic cases.
 */
export function boxKuhn(n: [number, number, number], cell: number, origin: [number, number, number] = [0, 0, 0]): { nodes: Float32Array; tets: Uint32Array } {
  const [nx, ny, nz] = n
  const id = (i: number, j: number, k: number): number => i + (nx + 1) * (j + (ny + 1) * k)
  const nodes = new Float32Array((nx + 1) * (ny + 1) * (nz + 1) * 3)
  for (let k = 0; k <= nz; k++) for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) nodes.set([origin[0] + i * cell, origin[1] + j * cell, origin[2] + k * cell], id(i, j, k) * 3)
  // 六种轴的排列；奇排列交换后两个顶点使体积为正 / the six axis permutations; odd ones swap the last two vertices for a positive volume
  const perms: [number, number, number, boolean][] = [[0, 1, 2, true], [1, 2, 0, true], [2, 0, 1, true], [0, 2, 1, false], [2, 1, 0, false], [1, 0, 2, false]]
  const tets: number[] = []
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    for (const [a, b, , even] of perms) {
      const c = [i, j, k]
      const v0 = id(c[0]!, c[1]!, c[2]!)
      c[a] = c[a]! + 1
      const v1 = id(c[0]!, c[1]!, c[2]!)
      c[b] = c[b]! + 1
      const v2 = id(c[0]!, c[1]!, c[2]!)
      const v3 = id(i + 1, j + 1, k + 1)
      if (even) tets.push(v0, v1, v2, v3)
      else tets.push(v0, v1, v3, v2)
    }
  }
  return { nodes, tets: Uint32Array.from(tets) }
}
