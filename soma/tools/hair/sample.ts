// 在皮肤上按密度撒点（泊松圆盘：随机投点，太近就不要），每个点记下所在三角形的三个顶点和重心坐标——运行时根部就靠它跟着皮肤走。
// Scattering points over the skin by density (Poisson disk: random darts, rejected when too close). Each point records
// the three vertices of its triangle and its barycentric coordinates — at run time the root follows the skin by them.

import { type V3, add, at, cross, len, norm, rng, scale, sub } from './geom.ts'

export interface Root {
  /** 皮肤三角形的三个顶点（发布皮肤的顶点下标）/ the skin triangle's three vertices (shipped skin vertex indices) */
  verts: [number, number, number]
  bary: V3
  p: V3
  /** 插值的皮肤法线 / interpolated skin normal */
  n: V3
}

export function rootAt(positions: Float32Array, normals: Float32Array, verts: [number, number, number], bary: V3): Root {
  let p: V3 = [0, 0, 0], n: V3 = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    p = add(p, scale(at(positions, verts[k]!), bary[k]!))
    n = add(n, scale(at(normals, verts[k]!), bary[k]!))
  }
  return { verts, bary, p, n: norm(n) }
}

/**
 * 泊松圆盘撒点。`density(p)` 给出每平方米的目标点数；按面积和密度投候选点，再按随机顺序接受（与已接受的点至少隔
 * `spacing(ρ)`），接受够了目标数就停。
 * Poisson-disk scattering. `density(p)` gives the target points per square metre; candidates are thrown by area and
 * density, then accepted in random order (at least `spacing(ρ)` from every accepted point), stopping once the target
 * count is reached.
 */
export function scatter(
  positions: Float32Array,
  normals: Float32Array,
  triangles: [number, number, number][],
  density: (p: V3) => number,
  seed: number,
  oversample = 6,
): Root[] {
  const r = rng(seed)
  // 每个三角形的面积 × 密度上界（三个角和中心的最大值）/ area × a density bound per triangle (the largest of the corners and the centre)
  const bound = new Float64Array(triangles.length)
  const cdf = new Float64Array(triangles.length)
  let acc = 0, peak = 0
  for (let t = 0; t < triangles.length; t++) {
    const [a, b, c] = triangles[t]!
    const pa = at(positions, a), pb = at(positions, b), pc = at(positions, c)
    const area = len(cross(sub(pb, pa), sub(pc, pa))) / 2
    const centre = scale(add(add(pa, pb), pc), 1 / 3)
    const m = Math.max(density(pa), density(pb), density(pc), density(centre)) * 1.25
    bound[t] = m
    peak = Math.max(peak, m)
    cdf[t] = acc += area * m
  }
  if (acc <= 0) return []
  // 候选点：按上界的累积分布抽三角形，三角形内均匀，再以 ρ/上界 的概率留下；留下的个数 / oversample 就是目标数
  // candidates: triangles by the bound's cumulative distribution, uniform inside, kept with probability ρ/bound; the kept count / oversample is the target
  const cand: { root: Root; rho: number }[] = []
  const throws = Math.round(acc * oversample)
  for (let k = 0; k < throws; k++) {
    const x = r() * acc
    let lo = 0, hi = triangles.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cdf[mid]! < x) lo = mid + 1
      else hi = mid
    }
    let u = r(), v = r()
    if (u + v > 1) (u = 1 - u), (v = 1 - v)
    const root = rootAt(positions, normals, triangles[lo]!, [1 - u - v, u, v])
    const rho = density(root.p)
    if (rho <= 0 || r() * bound[lo]! > rho) continue
    cand.push({ root, rho })
  }
  const target = Math.round(cand.length / oversample)
  // 最小间距：随机顺序吸附的饱和密度约 0.7/r²，取稍小的间距让目标数先到 / minimum spacing: random sequential adsorption saturates near 0.7/r², so a slightly smaller spacing lets the target arrive first
  const spacing = (rho: number): number => Math.sqrt(0.55 / rho)
  const cell = spacing(peak)
  const grid = new Map<string, V3[]>()
  const key = (p: V3): [number, number, number] => [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)]
  const out: Root[] = []
  for (let i = cand.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    const t = cand[i]!
    cand[i] = cand[j]!
    cand[j] = t
  }
  for (const { root, rho } of cand) {
    if (out.length >= target) break
    const s = spacing(rho)
    const reach = Math.ceil(s / cell)
    const [gx, gy, gz] = key(root.p)
    let ok = true
    for (let dx = -reach; dx <= reach && ok; dx++) {
      for (let dy = -reach; dy <= reach && ok; dy++) {
        for (let dz = -reach; dz <= reach && ok; dz++) {
          const list = grid.get(`${gx + dx},${gy + dy},${gz + dz}`)
          if (!list) continue
          for (const q of list) {
            if (len(sub(q, root.p)) < s) {
              ok = false
              break
            }
          }
        }
      }
    }
    if (!ok) continue
    out.push(root)
    const k = `${gx},${gy},${gz}`
    const list = grid.get(k)
    if (list) list.push(root.p)
    else grid.set(k, [root.p])
  }
  return out
}

/** 三角形面积的总和（只算 `keep` 为真的三角形，用三个顶点的平均）/ total triangle area (only triangles `keep` accepts, by the mean of the three vertices) */
export function areaWhere(positions: Float32Array, triangles: [number, number, number][], weight: (p: V3) => number): number {
  let s = 0
  for (const [a, b, c] of triangles) {
    const pa = at(positions, a), pb = at(positions, b), pc = at(positions, c)
    const area = len(cross(sub(pb, pa), sub(pc, pa))) / 2
    s += area * weight(scale(add(add(pa, pb), pc), 1 / 3))
  }
  return s
}
