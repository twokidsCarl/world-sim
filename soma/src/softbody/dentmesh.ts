// 凹陷的细分显示网格：皮肤网格太粗（前臂、胸部边长约 12–17 mm，个别三角形几厘米），半径几毫米的压头压出的凹陷落在
// 一两个顶点上，看不出形状。这里把压入点周围的皮肤三角形细分到约 1.5 mm，凹陷在细分顶点上取（嵌入细笼子），画在皮肤之上；
// 被它盖住的原三角形的内部顶点向里收（只在显示时），免得挡住凹陷。纯函数，worker 和测试都用。
// A subdivided display mesh for the dent: the skin mesh is coarse (edges of about 12–17 mm on the forearm and chest,
// some triangles several cm), so a dent from a probe a few mm across falls on one or two vertices and shows no shape.
// Here the skin triangles round the site are subdivided to about 1.5 mm, the dent is taken at the subdivided vertices
// (embedded in the fine cage) and drawn over the skin; the inner vertices of the original triangles it covers are drawn
// back inward (for display only) so that they do not hide the dent. Pure functions, used by the worker and the tests.

export interface DentMesh {
  /** 细分顶点的静止位置，米 / rest positions of the subdivided vertices, metres */
  position: Float32Array
  index: Uint32Array
  /** 每个细分顶点所在原三角形的三个皮肤顶点，以及它在其中的重心坐标（插值蒙皮权重和体位位移用）/ the three skin vertices of the original triangle holding each subdivided vertex, and its barycentric coordinates there (to interpolate skinning weights and the posture displacement) */
  corners: Uint32Array
  weights: Float32Array
  /** 被盖住、要向里收的皮肤顶点（原三角形的内部顶点）/ skin vertices covered and drawn back inward (the inner vertices of the original triangles) */
  hidden: Uint32Array
}

/**
 * 以 `centre` 为心、半径 `radius` 之内的皮肤顶点为"内部顶点"；用到它们的三角形都细分（每条边等分 k 段，k 对所有三角形相同，
 * 所以共用的边上细分点重合，没有裂缝）。内部顶点只被这些三角形用到，向里收不会扯动别的三角形。
 * Skin vertices within `radius` of `centre` are the "inner vertices"; every triangle using one of them is subdivided
 * (each edge cut into k equal parts, k the same for all, so subdivision points on shared edges coincide and there are no
 * cracks). Inner vertices are used by these triangles only, so drawing them inward pulls on no other triangle.
 */
export function dentMesh(positions: ArrayLike<number>, indices: ArrayLike<number>, centre: [number, number, number], radius: number, spacing = 0.0015, maxTriangles = 40000): DentMesh | null {
  const p = positions
  const n = p.length / 3
  const inner = new Uint8Array(n)
  let any = false
  for (let v = 0; v < n; v++) if (Math.hypot(p[v * 3]! - centre[0], p[v * 3 + 1]! - centre[1], p[v * 3 + 2]! - centre[2]) <= radius) (inner[v] = 1), (any = true)
  const tris: number[] = []
  // 没有顶点落在半径内（压头落在一个大三角形中间）：取包含最近点的那些三角形的角 / no vertex within the radius (the probe sits inside one large triangle): take the corners of the triangles nearest the centre
  if (!any) {
    let best = -1, bd = Infinity
    for (let t = 0; t < indices.length; t += 3) {
      let cx = 0, cy = 0, cz = 0
      for (let k = 0; k < 3; k++) (cx += p[indices[t + k]! * 3]! / 3), (cy += p[indices[t + k]! * 3 + 1]! / 3), (cz += p[indices[t + k]! * 3 + 2]! / 3)
      const d = Math.hypot(cx - centre[0], cy - centre[1], cz - centre[2])
      if (d < bd) (bd = d), (best = t)
    }
    if (best < 0) return null
    for (let k = 0; k < 3; k++) inner[indices[best + k]!] = 1
  }
  let longest = 0
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!
    if (!inner[a] && !inner[b] && !inner[c]) continue
    tris.push(a, b, c)
    for (const [u, w] of [[a, b], [b, c], [c, a]] as [number, number][]) longest = Math.max(longest, Math.hypot(p[u * 3]! - p[w * 3]!, p[u * 3 + 1]! - p[w * 3 + 1]!, p[u * 3 + 2]! - p[w * 3 + 2]!))
  }
  const T = tris.length / 3
  if (!T) return null
  let k = Math.max(1, Math.ceil(longest / spacing))
  while (k > 1 && T * k * k > maxTriangles) k--
  const key = new Map<string, number>()
  const pos: number[] = [], cor: number[] = [], wts: number[] = [], idx: number[] = []
  // 顶点按 (原三角形的角, 整数重心) 去重：共用边上的点在两个三角形里得到同一个键 / vertices deduplicated by (corners, integer barycentrics): a point on a shared edge gets the same key from both triangles
  const vertex = (a: number, b: number, c: number, i: number, j: number): number => {
    const l = k - i - j
    const parts = ([[a, l], [b, i], [c, j]] as [number, number][]).filter((q) => q[1] > 0).sort((x, y) => x[0] - y[0])
    const id = parts.map(([v, w]) => `${v}:${w}`).join(',')
    let q = key.get(id)
    if (q !== undefined) return q
    q = pos.length / 3
    key.set(id, q)
    const wa = l / k, wb = i / k, wc = j / k
    for (let r = 0; r < 3; r++) pos.push(wa * p[a * 3 + r]! + wb * p[b * 3 + r]! + wc * p[c * 3 + r]!)
    cor.push(a, b, c)
    wts.push(wa, wb, wc)
    return q
  }
  for (let t = 0; t < T; t++) {
    const a = tris[t * 3]!, b = tris[t * 3 + 1]!, c = tris[t * 3 + 2]!
    for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) {
      const v0 = vertex(a, b, c, i, j), v1 = vertex(a, b, c, i + 1, j), v2 = vertex(a, b, c, i, j + 1)
      idx.push(v0, v1, v2)
      if (i + j < k - 1) idx.push(v1, vertex(a, b, c, i + 1, j + 1), v2)
    }
  }
  const hidden: number[] = []
  for (let v = 0; v < n; v++) if (inner[v]) hidden.push(v)
  return { position: Float32Array.from(pos), index: Uint32Array.from(idx), corners: Uint32Array.from(cor), weights: Float32Array.from(wts), hidden: Uint32Array.from(hidden) }
}

/** 由原三角形的角插值一份逐皮肤顶点的量（体位位移）到细分顶点上 / interpolates a per-skin-vertex quantity (the posture displacement) to the subdivided vertices */
export function interpolateToDent(m: Pick<DentMesh, 'corners' | 'weights'>, perSkin: ArrayLike<number>, out: Float32Array, scale = 1): Float32Array {
  const nv = m.weights.length / 3
  for (let i = 0; i < nv; i++) for (let r = 0; r < 3; r++) {
    let s = 0
    for (let c = 0; c < 3; c++) s += m.weights[i * 3 + c]! * (perSkin[m.corners[i * 3 + c]! * 3 + r] ?? 0)
    out[i * 3 + r] = scale * s
  }
  return out
}
