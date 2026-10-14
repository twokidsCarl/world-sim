// 裁片三角化：边界点（按给定间距在边上取样）+ 内部六边形格点，Bowyer–Watson 德劳内三角化，
// 再用翻边找回缺失的边界段（约束德劳内，Sloan 1993），最后去掉多边形外的三角形。
// Panel triangulation: boundary points (sampled along the edges at a given spacing) plus interior
// hexagonal lattice points, a Bowyer–Watson Delaunay triangulation, missing boundary segments
// recovered by edge flips (constrained Delaunay, Sloan 1993), and the triangles outside the polygon dropped.

export interface Triangulation {
  /** 二维点：先是边界点（原顺序），后是内部点 / 2-D points: the boundary points first (in order), then interior ones. */
  points: Float64Array
  triangles: Uint32Array
  /** 没能找回的边界段数（应为 0）/ Boundary segments that could not be recovered (should be 0). */
  missing: number
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

function inCircle(P: Float64Array, a: number, b: number, c: number, px: number, py: number): boolean {
  const ax = P[a * 2]! - px, ay = P[a * 2 + 1]! - py
  const bx = P[b * 2]! - px, by = P[b * 2 + 1]! - py
  const cx = P[c * 2]! - px, cy = P[c * 2 + 1]! - py
  const det = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay)
  return det > 0
}

/** 点是否在多边形内（奇偶规则）/ Point in polygon (even–odd rule). */
export function insidePolygon(poly: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false
  const n = poly.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2]!, yi = poly[i * 2 + 1]!, xj = poly[j * 2]!, yj = poly[j * 2 + 1]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** 点到多边形边界的距离 / Distance from a point to the polygon boundary. */
function boundaryDistance(poly: ArrayLike<number>, x: number, y: number): number {
  let best = Infinity
  const n = poly.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const ax = poly[i * 2]!, ay = poly[i * 2 + 1]!, bx = poly[j * 2]!, by = poly[j * 2 + 1]!
    const dx = bx - ax, dy = by - ay
    const l2 = dx * dx + dy * dy
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0
    best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y))
  }
  return best
}

/**
 * 三角化一个简单多边形（边界点已按目标间距取好）。`spacing`：内部格点间距。
 * Triangulate a simple polygon whose boundary is already sampled at the target spacing. `spacing`:
 * the interior lattice spacing.
 */
export function triangulatePolygon(boundary: ArrayLike<number>, spacing: number): Triangulation {
  const nb = boundary.length / 2
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < nb; i++) {
    minX = Math.min(minX, boundary[i * 2]!)
    maxX = Math.max(maxX, boundary[i * 2]!)
    minY = Math.min(minY, boundary[i * 2 + 1]!)
    maxY = Math.max(maxY, boundary[i * 2 + 1]!)
  }
  // 内部六边形格点，离边界至少 0.6 个间距 / interior hexagonal lattice, at least 0.6 spacing from the boundary
  const pts: number[] = Array.from(boundary)
  const dy = (spacing * Math.sqrt(3)) / 2
  let row = 0
  for (let y = minY + dy / 2; y < maxY; y += dy, row++) {
    for (let x = minX + (row % 2 ? spacing / 2 : 0); x < maxX; x += spacing) {
      if (!insidePolygon(boundary, x, y)) continue
      if (boundaryDistance(boundary, x, y) < 0.6 * spacing) continue
      // 极小的确定性抖动：规则格点四点共圆，会让 Bowyer–Watson 的空腔判断不稳
      // a tiny deterministic jitter: a regular lattice has many cocircular quadruples, which makes Bowyer–Watson's cavity test unstable
      const j = Math.sin(pts.length * 12.9898) * 43758.5453
      const jx = (j - Math.floor(j) - 0.5) * 1e-3 * spacing
      const k = Math.sin(pts.length * 78.233) * 12543.1234
      const jy = (k - Math.floor(k) - 0.5) * 1e-3 * spacing
      pts.push(x + jx, y + jy)
    }
  }
  const P = new Float64Array(pts.length + 6)
  P.set(pts)
  const n = pts.length / 2
  // 超级三角形 / the super-triangle
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, r = Math.max(maxX - minX, maxY - minY) * 10 + 1
  P[n * 2] = cx - 2 * r
  P[n * 2 + 1] = cy - r
  P[n * 2 + 2] = cx + 2 * r
  P[n * 2 + 3] = cy - r
  P[n * 2 + 4] = cx
  P[n * 2 + 5] = cy + 2 * r
  // 打乱插入顺序（确定性），走查定位更快、也避开成串共线点 / a shuffled (deterministic) insertion order: faster walks, no runs of collinear points
  const order = Array.from({ length: n }, (_, i) => i)
  let seed = 12345
  for (let i = n - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    const j = seed % (i + 1)
    const t = order[i]!
    order[i] = order[j]!
    order[j] = t
  }
  // Bowyer–Watson，空腔从包含新点的三角形沿邻接扩张（保证空腔连通、呈星形）
  // Bowyer–Watson with the cavity grown from the triangle containing the new point through adjacency
  // (keeps the cavity connected and star-shaped)
  const cap = 2 * (n + 3) + 8
  const TV = new Int32Array(cap * 3), TN = new Int32Array(cap * 3).fill(-1), alive = new Uint8Array(cap)
  const mark = new Int32Array(cap).fill(-1)
  let nt = 1
  TV[0] = n
  TV[1] = n + 1
  TV[2] = n + 2
  alive[0] = 1
  const free: number[] = []
  const startAt = new Int32Array(n + 3).fill(-1), endAt = new Int32Array(n + 3).fill(-1)
  let last = 0
  const contains = (t: number, px: number, py: number): boolean => {
    for (let k = 0; k < 3; k++) {
      const a = TV[t * 3 + k]!, b = TV[t * 3 + ((k + 1) % 3)]!
      if (orient(P[a * 2]!, P[a * 2 + 1]!, P[b * 2]!, P[b * 2 + 1]!, px, py) < 0) return false
    }
    return true
  }
  for (const p of order) {
    const px = P[p * 2]!, py = P[p * 2 + 1]!
    // 定位：从上一个新三角形出发直线行走，失败时整体扫描 / locate: walk from the last new triangle, scan everything if that fails
    let t0 = -1
    let t = alive[last] ? last : 0
    for (let steps = 0; steps < 4 * cap && t >= 0; steps++) {
      let moved = false
      for (let k = 0; k < 3; k++) {
        const a = TV[t * 3 + k]!, b = TV[t * 3 + ((k + 1) % 3)]!
        if (orient(P[a * 2]!, P[a * 2 + 1]!, P[b * 2]!, P[b * 2 + 1]!, px, py) < 0) {
          t = TN[t * 3 + k]!
          moved = true
          break
        }
      }
      if (!moved) {
        t0 = t
        break
      }
    }
    if (t0 < 0) for (let q = 0; q < nt; q++) if (alive[q] && contains(q, px, py)) { t0 = q; break }
    if (t0 < 0) throw new Error('cloth: Delaunay point location failed')
    const cavity = [t0]
    mark[t0] = p
    for (let c = 0; c < cavity.length; c++) {
      const q = cavity[c]!
      for (let k = 0; k < 3; k++) {
        const nb = TN[q * 3 + k]!
        if (nb < 0 || mark[nb] === p) continue
        if (inCircle(P, TV[nb * 3]!, TV[nb * 3 + 1]!, TV[nb * 3 + 2]!, px, py)) {
          mark[nb] = p
          cavity.push(nb)
        }
      }
    }
    // 空腔边界上的边 → 新三角形 / cavity boundary edges → new triangles
    const made: number[] = []
    for (const q of cavity) {
      for (let k = 0; k < 3; k++) {
        const nb = TN[q * 3 + k]!
        if (nb >= 0 && mark[nb] === p) continue
        const a = TV[q * 3 + k]!, b = TV[q * 3 + ((k + 1) % 3)]!
        const nn = free.length ? free.pop()! : nt++
        TV[nn * 3] = a
        TV[nn * 3 + 1] = b
        TV[nn * 3 + 2] = p
        TN[nn * 3] = nb
        alive[nn] = 1
        mark[nn] = -1
        if (nb >= 0) for (let j = 0; j < 3; j++) if (TV[nb * 3 + j] === b && TV[nb * 3 + ((j + 1) % 3)] === a) TN[nb * 3 + j] = nn
        startAt[a] = nn
        endAt[b] = nn
        made.push(nn)
      }
    }
    for (const q of cavity) {
      alive[q] = 0
      free.push(q)
    }
    for (const nn of made) {
      const a = TV[nn * 3]!, b = TV[nn * 3 + 1]!
      TN[nn * 3 + 1] = startAt[b]! // 边 (b, p) / edge (b, p)
      TN[nn * 3 + 2] = endAt[a]! // 边 (p, a) / edge (p, a)
    }
    last = made[0]!
  }
  let tris: number[] = []
  for (let q = 0; q < nt; q++) if (alive[q]) tris.push(TV[q * 3]!, TV[q * 3 + 1]!, TV[q * 3 + 2]!)
  if (tris.length / 3 !== 2 * n + 1) throw new Error(`cloth: Delaunay triangulation of ${n} points gave ${tris.length / 3} triangles, expected ${2 * n + 1}`)
  // 统一为逆时针 / make every triangle counter-clockwise
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!, b = tris[t + 1]!, c = tris[t + 2]!
    if (orient(P[a * 2]!, P[a * 2 + 1]!, P[b * 2]!, P[b * 2 + 1]!, P[c * 2]!, P[c * 2 + 1]!) < 0) {
      tris[t + 1] = c
      tris[t + 2] = b
    }
  }
  const missing = recoverSegments(P, tris, nb)
  // 去掉超级三角形和多边形外的三角形 / drop the super-triangle and triangles outside the polygon
  const out: number[] = []
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t]!, b = tris[t + 1]!, c = tris[t + 2]!
    if (a >= n || b >= n || c >= n) continue
    const mx = (P[a * 2]! + P[b * 2]! + P[c * 2]!) / 3, my = (P[a * 2 + 1]! + P[b * 2 + 1]! + P[c * 2 + 1]!) / 3
    if (!insidePolygon(boundary, mx, my)) continue
    // 退化的三角形不要 / no degenerate triangles
    if (Math.abs(orient(P[a * 2]!, P[a * 2 + 1]!, P[b * 2]!, P[b * 2 + 1]!, P[c * 2]!, P[c * 2 + 1]!)) < 1e-14) continue
    out.push(a, b, c)
  }
  return { points: P.slice(0, n * 2), triangles: Uint32Array.from(out), missing }
}

/** 线段 ab 与 cd 是否严格相交 / Whether segments ab and cd properly intersect. */
function crosses(P: Float64Array, a: number, b: number, c: number, d: number): boolean {
  if (a === c || a === d || b === c || b === d) return false
  const o1 = orient(P[a * 2]!, P[a * 2 + 1]!, P[b * 2]!, P[b * 2 + 1]!, P[c * 2]!, P[c * 2 + 1]!)
  const o2 = orient(P[a * 2]!, P[a * 2 + 1]!, P[b * 2]!, P[b * 2 + 1]!, P[d * 2]!, P[d * 2 + 1]!)
  const o3 = orient(P[c * 2]!, P[c * 2 + 1]!, P[d * 2]!, P[d * 2 + 1]!, P[a * 2]!, P[a * 2 + 1]!)
  const o4 = orient(P[c * 2]!, P[c * 2 + 1]!, P[d * 2]!, P[d * 2 + 1]!, P[b * 2]!, P[b * 2 + 1]!)
  return o1 * o2 < 0 && o3 * o4 < 0
}

/**
 * 翻边找回边界段 (i, i+1)（Sloan 1993 的做法）；返回仍缺的段数。
 * Recover the boundary segments (i, i+1) by edge flips (Sloan 1993); returns how many are still missing.
 */
function recoverSegments(P: Float64Array, tris: number[], nb: number): number {
  const key = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`)
  const build = (): Map<string, number[]> => {
    const m = new Map<string, number[]>()
    for (let t = 0; t < tris.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const kk = key(tris[t + k]!, tris[t + ((k + 1) % 3)]!)
        const l = m.get(kk)
        if (l) l.push(t)
        else m.set(kk, [t])
      }
    }
    return m
  }
  let edges = build()
  let missing = 0
  for (let i = 0; i < nb; i++) {
    const a = i, b = (i + 1) % nb
    let guard = 0
    while (!edges.has(key(a, b)) && guard++ < 500) {
      // 找一条与 ab 相交、两侧三角形构成凸四边形的边，翻转它 / find an edge crossing ab whose quad is convex and flip it
      let flipped = false
      for (const [k, ts] of edges) {
        if (ts.length !== 2) continue
        const [c, d] = k.split(',').map(Number) as [number, number]
        if (!crosses(P, a, b, c, d)) continue
        const t1 = ts[0]!, t2 = ts[1]!
        const e = [tris[t1]!, tris[t1 + 1]!, tris[t1 + 2]!].find((v) => v !== c && v !== d)!
        const f = [tris[t2]!, tris[t2 + 1]!, tris[t2 + 2]!].find((v) => v !== c && v !== d)!
        // 凸：e、f 在 cd 两侧，c、d 在 ef 两侧 / convex: e, f on either side of cd and c, d on either side of ef
        const s1 = orient(P[e * 2]!, P[e * 2 + 1]!, P[f * 2]!, P[f * 2 + 1]!, P[c * 2]!, P[c * 2 + 1]!)
        const s2 = orient(P[e * 2]!, P[e * 2 + 1]!, P[f * 2]!, P[f * 2 + 1]!, P[d * 2]!, P[d * 2 + 1]!)
        if (s1 * s2 >= 0) continue
        // 新三角形 (e, f, c)、(f, e, d)，保持逆时针 / new triangles (e, f, c) and (f, e, d), kept counter-clockwise
        const put = (t: number, p: number, q: number, r: number): void => {
          if (orient(P[p * 2]!, P[p * 2 + 1]!, P[q * 2]!, P[q * 2 + 1]!, P[r * 2]!, P[r * 2 + 1]!) < 0) [q, r] = [r, q]
          tris[t] = p
          tris[t + 1] = q
          tris[t + 2] = r
        }
        put(t1, e, f, c)
        put(t2, f, e, d)
        flipped = true
        break
      }
      if (!flipped) break
      edges = build()
    }
    if (!edges.has(key(a, b))) missing++
  }
  return missing
}
