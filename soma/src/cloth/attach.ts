// 把布料顶点绑到皮肤三角形上（重心坐标 + 沿面法线的距离），以及长程附着的测地距离。
// 用途：腰头贴在腰上跟着皮肤走（运动学约束），其余顶点到最近的腰头顶点不超过裁片上的测地距离
// （Kim 等 2012，“Long Range Attachments”）；运行时的回退蒙皮也用同样的绑定。
// Binding cloth vertices to skin triangles (barycentrics + distance along the face normal), and the
// geodesic distances of long-range attachments. Uses: a waistband held on the waist follows the skin
// (a kinematic constraint) and every other vertex stays within its pattern geodesic distance of the
// nearest waistband vertex (Kim et al. 2012, "Long Range Attachments"); the runtime's fallback
// skinning uses the same binding.

/** 投影到三角形平面的重心坐标 (b1, b2) 与沿单位面法线的距离 h / Barycentrics (b1, b2) of the projection onto the triangle plane and the distance h along the unit face normal. */
export function planeBinding(P: ArrayLike<number>, I: ArrayLike<number>, tri: number, x: number, y: number, z: number): [number, number, number] {
  const a = I[tri * 3]! * 3, b = I[tri * 3 + 1]! * 3, c = I[tri * 3 + 2]! * 3
  const e1x = P[b]! - P[a]!, e1y = P[b + 1]! - P[a + 1]!, e1z = P[b + 2]! - P[a + 2]!
  const e2x = P[c]! - P[a]!, e2y = P[c + 1]! - P[a + 1]!, e2z = P[c + 2]! - P[a + 2]!
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
  const nl = Math.hypot(nx, ny, nz) || 1
  nx /= nl
  ny /= nl
  nz /= nl
  const rx = x - P[a]!, ry = y - P[a + 1]!, rz = z - P[a + 2]!
  const h = rx * nx + ry * ny + rz * nz
  const qx = rx - h * nx, qy = ry - h * ny, qz = rz - h * nz
  const d00 = e1x * e1x + e1y * e1y + e1z * e1z, d01 = e1x * e2x + e1y * e2y + e1z * e2z, d11 = e2x * e2x + e2y * e2y + e2z * e2z
  const d20 = qx * e1x + qy * e1y + qz * e1z, d21 = qx * e2x + qy * e2y + qz * e2z
  const den = d00 * d11 - d01 * d01
  return [(d11 * d20 - d01 * d21) / den, (d00 * d21 - d01 * d20) / den, h]
}

/** 由绑定算位置：p = Σ b_i·v_i + h·n̂ / The position from a binding: p = Σ b_i·v_i + h·n̂. */
export function bindingPosition(P: ArrayLike<number>, I: ArrayLike<number>, tri: number, b1: number, b2: number, h: number, out: Float64Array | Float32Array, o: number): void {
  const a = I[tri * 3]! * 3, b = I[tri * 3 + 1]! * 3, c = I[tri * 3 + 2]! * 3
  const e1x = P[b]! - P[a]!, e1y = P[b + 1]! - P[a + 1]!, e1z = P[b + 2]! - P[a + 2]!
  const e2x = P[c]! - P[a]!, e2y = P[c + 1]! - P[a + 1]!, e2z = P[c + 2]! - P[a + 2]!
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
  const nl = Math.hypot(nx, ny, nz) || 1
  nx /= nl
  ny /= nl
  nz /= nl
  out[o] = P[a]! + b1 * e1x + b2 * e2x + h * nx
  out[o + 1] = P[a + 1]! + b1 * e1y + b2 * e2y + h * ny
  out[o + 2] = P[a + 2]! + b1 * e1z + b2 * e2z + h * nz
}

/** 一组绑在皮肤上的顶点 / A set of vertices bound to the skin. */
export class SkinAttachment {
  constructor(
    readonly vertices: Uint32Array,
    readonly tri: Uint32Array,
    readonly bary: Float64Array,
    readonly offset: Float64Array,
  ) {}

  /** 按当前皮肤把这些顶点放到绑定位置 / Put the vertices at their bound positions on the current skin. */
  apply(skin: ArrayLike<number>, index: ArrayLike<number>, x: Float64Array): void {
    for (let k = 0; k < this.vertices.length; k++) {
      bindingPosition(skin, index, this.tri[k]!, this.bary[k * 2]!, this.bary[k * 2 + 1]!, this.offset[k]!, x, this.vertices[k]! * 3)
    }
  }
}

/**
 * 多源 Dijkstra：每个顶点到最近锚点的测地距离（沿网格边，缝合对之间距离为 0）和那个锚点。
 * Multi-source Dijkstra: each vertex's geodesic distance to the nearest anchor (over mesh edges, stitched pairs at
 * distance 0) and which anchor that is.
 */
export function geodesicToAnchors(n: number, triangles: ArrayLike<number>, uv: ArrayLike<number>, stitches: ArrayLike<number>, anchors: ArrayLike<number>, dim: 2 | 3 = 2): { dist: Float64Array; anchor: Int32Array } {
  // dim = 3 时 uv 是三维位置（焊好缝线的网格没有统一的裁片坐标）/ with dim = 3, `uv` holds 3-D positions (a mesh with welded seams has no single set of pattern coordinates)
  const len = (a: number, b: number): number => {
    let s = 0
    for (let k = 0; k < dim; k++) s += (uv[a * dim + k]! - uv[b * dim + k]!) ** 2
    return Math.sqrt(s)
  }
  const adj: number[][] = Array.from({ length: n }, () => [])
  const w: number[][] = Array.from({ length: n }, () => [])
  const link = (a: number, b: number, d: number): void => {
    adj[a]!.push(b)
    w[a]!.push(d)
    adj[b]!.push(a)
    w[b]!.push(d)
  }
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k]!, b = triangles[t + ((k + 1) % 3)]!
      link(a, b, len(a, b))
    }
  }
  for (let s = 0; s < stitches.length; s += 2) link(stitches[s]!, stitches[s + 1]!, 0)
  const dist = new Float64Array(n).fill(Infinity)
  const anchor = new Int32Array(n).fill(-1)
  // 二叉堆 / a binary heap
  const heap: [number, number][] = []
  const push = (d: number, v: number): void => {
    heap.push([d, v])
    let i = heap.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heap[p]![0] <= heap[i]![0]) break
      ;[heap[p], heap[i]] = [heap[i]!, heap[p]!]
      i = p
    }
  }
  const pop = (): [number, number] => {
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i]!, heap[m]!]
        i = m
      }
    }
    return top
  }
  for (let k = 0; k < anchors.length; k++) {
    const a = anchors[k]!
    dist[a] = 0
    anchor[a] = a
    push(0, a)
  }
  while (heap.length) {
    const [d, v] = pop()
    if (d > dist[v]!) continue
    const av = adj[v]!, wv = w[v]!
    for (let j = 0; j < av.length; j++) {
      const u = av[j]!, nd = d + wv[j]!
      if (nd < dist[u]!) {
        dist[u] = nd
        anchor[u] = anchor[v]!
        push(nd, u)
      }
    }
  }
  return { dist, anchor }
}
