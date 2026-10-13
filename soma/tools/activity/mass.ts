// 节段质量：皮肤围出的体积按关节切成段，每段再乘以所在身体区域的平均密度。
// Segment masses: the volume enclosed by the skin is cut into segments by joint, and each is multiplied by the
// mean density of its body region.
//
// 切法 / How the skin is cut
//   皮肤的每个三角形归给权重最大的那个"质量关节"（肋并入胸椎等，见 params.json 的 massMerge）。相邻两段之间的边界是
//   皮肤网格上的一圈边；用这一圈的中心做扇形封口，两段各用一次、方向相反。这样每一段都是封闭的，体积和质心由
//   四面体求和（散度定理）得到，而且各段体积之和严格等于皮肤的总体积：封口的误差只会在相邻两段之间挪动体积。
//   Every skin triangle goes to the "mass joint" with the largest weight (ribs merged into their vertebra and so
//   on, see `massMerge` in params.json). The border between two neighbouring segments is a loop of mesh edges; a
//   fan from the loop's centre caps it, used once by each segment with opposite orientation. Every segment is then
//   closed, its volume and centroid follow from a sum of tetrahedra (divergence theorem), and the segment volumes
//   add up exactly to the skin's volume: an imperfect cap only moves volume between two neighbours.

export interface SkinSegments {
  /** 每个质量关节的体积（m³）和质心 / Volume (m³) and centroid per mass joint. */
  volume: Float64Array
  centroid: Float64Array
  total: number
}

/**
 * @param positions 皮肤顶点 / skin vertices
 * @param indices   三角形 / triangles
 * @param seg       每个顶点的质量关节下标 / the mass joint of every vertex
 * @param nSeg      关节数 / number of joints
 */
export function skinSegments(positions: Float32Array, indices: Uint32Array, seg: Int32Array, nSeg: number): SkinSegments {
  const nT = indices.length / 3
  // 三角形的段：三个顶点里出现次数最多的；都不同时取第一个 / a triangle's segment: the most frequent of its vertices', the first when all differ
  const triSeg = new Int32Array(nT)
  for (let t = 0; t < nT; t++) {
    const a = seg[indices[t * 3]!]!, b = seg[indices[t * 3 + 1]!]!, c = seg[indices[t * 3 + 2]!]!
    triSeg[t] = b === c ? b : a
  }
  // 以网格中心为原点，减小四面体求和的舍入误差 / origin at the mesh centre, to keep rounding in the tetrahedron sums small
  const O = [0, 0, 0]
  for (let i = 0; i < positions.length; i += 3) {
    O[0] = O[0]! + positions[i]!
    O[1] = O[1]! + positions[i + 1]!
    O[2] = O[2]! + positions[i + 2]!
  }
  const nV = positions.length / 3
  O[0] = O[0]! / nV
  O[1] = O[1]! / nV
  O[2] = O[2]! / nV
  const volume = new Float64Array(nSeg)
  const moment = new Float64Array(nSeg * 3)
  const tet = (s: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void => {
    const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    volume[s] = volume[s]! + v
    // 四面体 (O, a, b, c) 的质心 = (a + b + c) / 4（相对 O）/ centroid of the tetrahedron (O, a, b, c) = (a + b + c) / 4 relative to O
    moment[s * 3] = moment[s * 3]! + (v * (ax + bx + cx)) / 4
    moment[s * 3 + 1] = moment[s * 3 + 1]! + (v * (ay + by + cy)) / 4
    moment[s * 3 + 2] = moment[s * 3 + 2]! + (v * (az + bz + cz)) / 4
  }
  const P = (v: number, c: number): number => positions[v * 3 + c]! - O[c]!
  // 位置相同的顶点（GLB 在法线接缝处会拆点）算作同一个，否则接缝上的边找不到对面的三角形
  // vertices at the same position (a GLB splits vertices along normal seams) count as one; otherwise an edge on a seam finds no opposite triangle
  const weld = new Int32Array(nV)
  const seen = new Map<string, number>()
  for (let v = 0; v < nV; v++) {
    const key = `${Math.round(positions[v * 3]! * 1e5)},${Math.round(positions[v * 3 + 1]! * 1e5)},${Math.round(positions[v * 3 + 2]! * 1e5)}`
    const w = seen.get(key)
    if (w === undefined) seen.set(key, (weld[v] = v))
    else weld[v] = w
  }
  // 边 → 用到它的三角形（有向）/ edge → the triangles using it (directed)
  const edges = new Map<number, number[]>()
  for (let t = 0; t < nT; t++) {
    const i = indices[t * 3]!, j = indices[t * 3 + 1]!, k = indices[t * 3 + 2]!
    tet(triSeg[t]!, P(i, 0), P(i, 1), P(i, 2), P(j, 0), P(j, 1), P(j, 2), P(k, 0), P(k, 1), P(k, 2))
    for (const [p, q] of [[i, j], [j, k], [k, i]] as const) {
      const wp = weld[p]!, wq = weld[q]!
      if (wp === wq) continue
      const key = wp < wq ? wp * nV + wq : wq * nV + wp
      let e = edges.get(key)
      if (!e) edges.set(key, (e = []))
      // 记下：三角形的段，以及这条边在它里面的方向（p → q）/ record the triangle's segment and the edge's direction in it (p → q)
      e.push(triSeg[t]!, wp, wq)
    }
  }
  // 两段之间的边界边，按"段对"分组，再按连通性分成一圈一圈 / border edges between two segments, grouped by pair and then split into loops by connectivity
  const borders = new Map<string, { s: number; p: number; q: number }[]>()
  for (const e of edges.values()) {
    if (e.length !== 6) continue // 边界边或非流形边：不封口 / an open or non-manifold edge: not capped
    const s1 = e[0]!, s2 = e[3]!
    if (s1 === s2) continue
    const key = s1 < s2 ? `${s1}:${s2}` : `${s2}:${s1}`
    let list = borders.get(key)
    if (!list) borders.set(key, (list = []))
    list.push({ s: s1, p: e[1]!, q: e[2]! }, { s: s2, p: e[4]!, q: e[5]! })
  }
  for (const list of borders.values()) {
    // 并查集：共用顶点的边属于同一圈 / union-find: edges sharing a vertex belong to the same loop
    const parent = new Map<number, number>()
    const find = (x: number): number => {
      let r = x
      while (parent.get(r) !== r) r = parent.get(r)!
      let y = x
      while (parent.get(y) !== r) {
        const n = parent.get(y)!
        parent.set(y, r)
        y = n
      }
      return r
    }
    for (const e of list) {
      if (!parent.has(e.p)) parent.set(e.p, e.p)
      if (!parent.has(e.q)) parent.set(e.q, e.q)
      parent.set(find(e.p), find(e.q))
    }
    const loops = new Map<number, { sum: [number, number, number]; n: number; edges: typeof list }>()
    for (const e of list) {
      const r = find(e.p)
      let l = loops.get(r)
      if (!l) loops.set(r, (l = { sum: [0, 0, 0], n: 0, edges: [] }))
      l.edges.push(e)
      for (let c = 0; c < 3; c++) l.sum[c] = l.sum[c]! + P(e.p, c) + P(e.q, c)
      l.n += 2
    }
    for (const l of loops.values()) {
      const cx = l.sum[0] / l.n, cy = l.sum[1] / l.n, cz = l.sum[2] / l.n
      // 封口三角形 (q, p, 中心)：与该段里那条边的方向相反，法线朝外 / cap triangle (q, p, centre): against the edge's direction in the segment, so it faces outwards
      for (const e of l.edges) tet(e.s, P(e.q, 0), P(e.q, 1), P(e.q, 2), P(e.p, 0), P(e.p, 1), P(e.p, 2), cx, cy, cz)
    }
  }
  const centroid = new Float64Array(nSeg * 3)
  let total = 0
  for (let s = 0; s < nSeg; s++) {
    total += volume[s]!
    for (let c = 0; c < 3; c++) centroid[s * 3 + c] = Math.abs(volume[s]!) > 1e-12 ? moment[s * 3 + c]! / volume[s]! + O[c]! : 0
  }
  return { volume, centroid, total }
}
