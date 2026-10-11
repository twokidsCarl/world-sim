// 对骨表面（的局部）做简单形状的最小二乘拟合：这是关节中心和关节轴的几何基础。
// 所有拟合都是确定性的，并报告各自的残差。
// Least-squares fits of simple shapes to (parts of) bone surfaces: the geometric basis of the
// joint centres and axes. All fits are deterministic and report their residual.

import { type V3, add, cross, dot, eigSym, len, mul, norm, solve, sub } from './math.ts'

export interface Sample {
  p: V3
  /** 单位表面法线。 Unit surface normal. */
  n: V3
  /** 权重（该采样点所代表的表面积）。 Weight (surface area the sample stands for). */
  w: number
}

export interface SphereFit {
  center: V3
  radius: number
  /** |p − c| − r 的加权均方根，单位为米。 Weighted RMS of |p − c| − r, metres. */
  rms: number
  count: number
}

/** 代数最小二乘球面拟合：|p|² = 2c·p + (r² − |c|²)。 Algebraic least-squares sphere: |p|² = 2c·p + (r² − |c|²). */
export function fitSphere(samples: Sample[]): SphereFit | null {
  if (samples.length < 4) return null
  // 将数据中心化以改善条件数 / centre the data for conditioning
  let W = 0
  const m: V3 = [0, 0, 0]
  for (const s of samples) (W += s.w), (m[0] += s.w * s.p[0]), (m[1] += s.w * s.p[1]), (m[2] += s.w * s.p[2])
  m[0] /= W, m[1] /= W, m[2] /= W
  const A = new Float64Array(16), b = new Float64Array(4)
  for (const s of samples) {
    const q = sub(s.p, m)
    const row = [2 * q[0], 2 * q[1], 2 * q[2], 1]
    const rhs = dot(q, q)
    for (let i = 0; i < 4; i++) {
      b[i] = b[i]! + s.w * row[i]! * rhs
      for (let j = 0; j < 4; j++) A[i * 4 + j] = A[i * 4 + j]! + s.w * row[i]! * row[j]!
    }
  }
  const x = solve(A, b, 4)
  if (!x) return null
  const c: V3 = [x[0]!, x[1]!, x[2]!]
  const r2 = x[3]! + dot(c, c)
  if (!(r2 > 0)) return null
  const radius = Math.sqrt(r2)
  const center = add(c, m)
  let e = 0
  for (const s of samples) e += s.w * (len(sub(s.p, center)) - radius) ** 2
  return { center, radius, rms: Math.sqrt(e / W), count: samples.length }
}

/**
 * 能容忍偏离关节面的采样点的球面拟合：在残差不超过 `keep` ×（残差绝对值的中位数）的采样点上
 * 重新拟合若干次。返回拟合结果和内点子集。
 * Sphere fit that tolerates samples off the articular surface: refit on the samples within
 * `keep` × (median absolute residual) a few times. Returns the fit and the inlier subset.
 */
export function fitSphereRobust(samples: Sample[], iterations = 14, keep = 2.5, floor = 0.0004): { fit: SphereFit; inliers: Sample[] } | null {
  let cur = samples
  let fit = fitSphere(cur)
  if (!fit) return null
  for (let it = 0; it < iterations; it++) {
    const res = samples.map((s) => Math.abs(len(sub(s.p, fit!.center)) - fit!.radius))
    const sorted = [...res].sort((a, b) => a - b)
    const tol = Math.max(floor, keep * sorted[Math.floor(sorted.length / 2)]!)
    const next = samples.filter((_, i) => res[i]! <= tol)
    if (next.length < 8 || next.length === cur.length) break
    const f = fitSphere(next)
    if (!f) break
    cur = next
    fit = f
  }
  return { fit, inliers: cur }
}

export interface AxisFit {
  /** 轴上的一点（离采样点质心最近的那一点）及其单位方向。 A point on the axis (the one closest to the samples' centroid) and its unit direction. */
  point: V3
  dir: V3
  /** 每个采样点的法线与轴之间距离的加权均方根，单位为米。 Weighted RMS distance between each sample's normal line and the axis, metres. */
  rms: number
  /** 采样点绕轴的平均半径及其均方根偏差（反映该表面有多接近圆柱面）。 Mean radius of the samples about the axis and its RMS deviation (how cylindrical the surface is). */
  radius: number
  radiusRms: number
  count: number
}

/**
 * 最能解释这些采样点的回转面的轴：回转面的每条法线都与其轴相交，因此用轴的 Plücker 坐标 (d, m)
 * 和法线的 Plücker 坐标 (n, p×n)，在 |d| = 1 的约束下最小化 Σ w·(n·m + (p×n)·d)²（Pottmann & Randrup 1998）。
 * 这个 6×6 问题可化为关于 d 的 3×3 特征值问题。
 * Axis of the surface of revolution that best explains the samples: every normal of a surface of
 * revolution meets its axis, so with Plücker coordinates (d, m) of the axis and (n, p×n) of a
 * normal line we minimise Σ w·(n·m + (p×n)·d)² subject to |d| = 1 (Pottmann & Randrup 1998). The 6×6
 * problem reduces to a 3×3 eigenproblem for d.
 */
export function fitRevolutionAxis(samples: Sample[]): AxisFit | null {
  if (samples.length < 6) return null
  let W = 0
  const c: V3 = [0, 0, 0]
  for (const s of samples) (W += s.w), (c[0] += s.w * s.p[0]), (c[1] += s.w * s.p[1]), (c[2] += s.w * s.p[2])
  c[0] /= W, c[1] /= W, c[2] /= W
  // x = (d, m)；行 = (p×n, n)，其中 p 相对于质心，并经缩放使两半都是 O(1) 量级
  // x = (d, m); row = (p×n, n) with p relative to the centroid, scaled so both halves are O(1)
  let scale = 0
  for (const s of samples) scale += s.w * len(sub(s.p, c))
  scale = scale / W || 1
  const M = new Float64Array(36)
  for (const s of samples) {
    const q = mul(sub(s.p, c), 1 / scale)
    const pn = cross(q, s.n)
    const row = [pn[0], pn[1], pn[2], s.n[0], s.n[1], s.n[2]]
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) M[i * 6 + j] = M[i * 6 + j]! + s.w * row[i]! * row[j]!
  }
  const blk = (r0: number, c0: number): number[] => {
    const o: number[] = []
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o.push(M[(r0 + i) * 6 + c0 + j]!)
    return o
  }
  const A = blk(0, 0), B = blk(0, 3), C = blk(3, 3)
  // S = A − B·C⁻¹·Bᵀ
  const S = [...A]
  // C 的伪逆：圆柱面的法线都垂直于轴，C 是奇异的（沿轴平移也是它的对称），所以丢掉很小的特征值
  // pseudo-inverse of C: on a cylinder every normal is perpendicular to the axis and C is singular (sliding along the axis is a symmetry too), so tiny eigenvalues are dropped
  const ce = eigSym(C, 3)
  const cmax = Math.max(...ce.values)
  if (!(cmax > 0)) return null
  const Cinv: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let e = 0; e < 3; e++) {
    if (ce.values[e]! < 1e-4 * cmax) continue
    const v = ce.vectors[e]!
    for (let k = 0; k < 3; k++) for (let i = 0; i < 3; i++) Cinv[k]![i] = Cinv[k]![i]! + (v[k]! * v[i]!) / ce.values[e]!
  }
  const CiBt = new Float64Array(9) // C⁻¹·Bᵀ
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) CiBt[i * 3 + j] = CiBt[i * 3 + j]! + Cinv[k]![i]! * B[j * 3 + k]!
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) S[i * 3 + j] = S[i * 3 + j]! - B[i * 3 + k]! * CiBt[k * 3 + j]!
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) S[i * 3 + j] = S[j * 3 + i] = (S[i * 3 + j]! + S[j * 3 + i]!) / 2
  const eig = eigSym(S, 3)
  const d = norm(eig.vectors[0] as V3)
  const mom: V3 = [0, 0, 0]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) mom[i] = mom[i]! - CiBt[i * 3 + j]! * d[j]!
  // 轴上离质心最近的点：p0 = d × m（在缩放并中心化后的坐标中）
  // point on the axis closest to the centroid: p0 = d × m (in scaled, centred coordinates)
  const p0 = add(c, mul(cross(d, mom), scale))
  let e = 0, rs = 0
  const radii: number[] = []
  for (const s of samples) {
    // 法线 (p, n) 与轴 (p0, d) 之间的距离
    // distance between the normal line (p, n) and the axis (p0, d)
    const cr = cross(s.n, d)
    const l = len(cr)
    const rel = sub(s.p, p0)
    const dd = l > 1e-6 ? Math.abs(dot(rel, cr)) / l : len(cross(rel, d))
    e += s.w * dd * dd
    const r = len(cross(rel, d))
    radii.push(r)
    rs += s.w * r
  }
  const radius = rs / W
  let rv = 0
  samples.forEach((s, i) => (rv += s.w * (radii[i]! - radius) ** 2))
  return { point: p0, dir: d, rms: Math.sqrt(e / W), radius, radiusRms: Math.sqrt(rv / W), count: samples.length }
}

export interface Pca {
  center: V3
  /** 单位轴，方差最大的在前。 Unit axes, largest variance first. */
  axes: [V3, V3, V3]
  /** 沿各轴的标准差。 Standard deviations along the axes. */
  sigma: [number, number, number]
}

export function pca(points: V3[], weights?: number[]): Pca {
  let W = 0
  const c: V3 = [0, 0, 0]
  points.forEach((p, i) => {
    const w = weights ? weights[i]! : 1
    W += w
    c[0] += w * p[0], c[1] += w * p[1], c[2] += w * p[2]
  })
  c[0] /= W, c[1] /= W, c[2] /= W
  const C = new Float64Array(9)
  points.forEach((p, i) => {
    const w = weights ? weights[i]! : 1
    const q = sub(p, c)
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a * 3 + b] = C[a * 3 + b]! + w * q[a]! * q[b]!
  })
  const e = eigSym(C, 3)
  const ax = [2, 1, 0].map((k) => norm(e.vectors[k] as V3)) as [V3, V3, V3]
  const sg = [2, 1, 0].map((k) => Math.sqrt(Math.max(0, e.values[k]!) / W)) as [number, number, number]
  return { center: c, axes: ax, sigma: sg }
}

/** 过加权点的最小二乘平面：质心和单位法线（方差最小的方向）。 Least-squares plane through weighted points: centroid and unit normal (smallest-variance direction). */
export function fitPlane(points: V3[], weights?: number[]): { center: V3; normal: V3; rms: number } {
  const p = pca(points, weights)
  return { center: p.center, normal: p.axes[2], rms: p.sigma[2] }
}
