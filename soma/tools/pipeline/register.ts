// Registration between two body spaces: anchors in → deformation → apply to meshes.
//
// The pieces are deliberately generic (nothing here knows about BodyParts3D):
//   fitRigid / icp        rigid fit of one structure onto its counterpart
//   buildDeformation      smooth displacement field from scattered anchor pairs (from → to)
//   Deformation.apply     warp any point set / mesh through the field
//   PointIndex            uniform-grid nearest-neighbour index used by all of the above
//   surfaceDistance       one-sided surface distance statistics
//   InsideTester          point-in-closed-mesh test (containment / interpenetration checks)
//
// The displacement field is Gaussian kernel regression over the k nearest anchors with an
// adaptive bandwidth: d(x) = Σ wᵢ·dᵢ / Σ wᵢ, wᵢ = exp(−|x−pᵢ|² / 2σ²), σ = max(σmin, distance to
// the k-th nearest anchor · bandwidthScale). It is smooth, local, needs no linear solve and cannot
// overshoot (the result is always a convex combination of anchor displacements), at the price of
// not interpolating the anchors exactly — the residual is measured and reported by the caller.

import { PointBuffer, sampleSurface } from './adjacency.ts'
import type { Mesh } from './geometry.ts'

// ── Nearest-neighbour index ───────────────────────────────────────────────────────────────────

export class PointIndex {
  readonly points: Float32Array
  readonly count: number
  private readonly min: [number, number, number]
  private readonly dims: [number, number, number]
  private readonly inv: number
  private readonly start: Uint32Array
  private readonly order: Uint32Array
  readonly cell: number

  /** @param points xyz triples @param cell grid cell size; pick about the typical query radius */
  constructor(points: Float32Array, cell: number, count = points.length / 3) {
    this.points = points
    this.count = count
    this.cell = cell
    const min: [number, number, number] = [Infinity, Infinity, Infinity]
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = points[3 * i + k]!
        if (v < min[k]!) min[k] = v
        if (v > max[k]!) max[k] = v
      }
    }
    if (count === 0) min.fill(0), max.fill(0)
    // keep the grid bounded: grow the cell when the extent would need too many cells
    let c = cell
    for (;;) {
      const n = [0, 1, 2].map((k) => Math.floor((max[k]! - min[k]!) / c) + 1)
      if (n[0]! * n[1]! * n[2]! <= 1 << 26) break
      c *= 1.5
    }
    this.cell = c
    this.inv = 1 / c
    this.min = min
    this.dims = [0, 1, 2].map((k) => Math.floor((max[k]! - min[k]!) * this.inv) + 1) as [number, number, number]
    const cells = this.dims[0] * this.dims[1] * this.dims[2]
    this.start = new Uint32Array(cells + 1)
    const key = new Uint32Array(count)
    for (let i = 0; i < count; i++) {
      const k = this.cellOf(points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!)
      key[i] = k
      this.start[k + 1] = this.start[k + 1]! + 1
    }
    for (let k = 0; k < cells; k++) this.start[k + 1] = this.start[k + 1]! + this.start[k]!
    const fill = this.start.slice(0, cells)
    this.order = new Uint32Array(count)
    for (let i = 0; i < count; i++) {
      const k = key[i]!
      this.order[fill[k]!] = i
      fill[k] = fill[k]! + 1
    }
  }

  private clampIdx(v: number, axis: 0 | 1 | 2): number {
    const i = Math.floor((v - this.min[axis]) * this.inv)
    return i < 0 ? 0 : i >= this.dims[axis] ? this.dims[axis] - 1 : i
  }

  private cellOf(x: number, y: number, z: number): number {
    return this.clampIdx(x, 0) + this.dims[0] * (this.clampIdx(y, 1) + this.dims[1] * this.clampIdx(z, 2))
  }

  /**
   * The k nearest points to (x,y,z). Writes indices and squared distances (ascending) into the
   * given arrays and returns how many were found (< k only when the index holds fewer points).
   */
  nearest(x: number, y: number, z: number, k: number, outIdx: Int32Array, outD2: Float64Array, maxDistance = Infinity): number {
    let found = 0
    const [nx, ny, nz] = this.dims
    const cx = this.clampIdx(x, 0)
    const cy = this.clampIdx(y, 1)
    const cz = this.clampIdx(z, 2)
    // distance from the query to the grid box, for queries outside it
    const maxRing = Math.max(nx, ny, nz)
    const limit2 = maxDistance * maxDistance
    for (let ring = 0; ring <= maxRing; ring++) {
      // once k are found, a further ring can only help if it may contain something closer
      if (found === k || ring > 0) {
        const reach = (ring - 1) * this.cell
        if (found === k && reach > 0 && outD2[k - 1]! <= reach * reach) break
        if (reach > 0 && reach * reach > limit2) break
      }
      const z0 = cz - ring
      const z1 = cz + ring
      const y0 = cy - ring
      const y1 = cy + ring
      const x0 = cx - ring
      const x1 = cx + ring
      for (let iz = Math.max(0, z0); iz <= Math.min(nz - 1, z1); iz++) {
        const zEdge = iz === z0 || iz === z1
        for (let iy = Math.max(0, y0); iy <= Math.min(ny - 1, y1); iy++) {
          const yEdge = iy === y0 || iy === y1
          const stepX = zEdge || yEdge ? 1 : Math.max(1, x1 - x0)
          for (let ix = x0; ix <= x1; ix += stepX) {
            if (ix < 0 || ix >= nx) continue
            const c = ix + nx * (iy + ny * iz)
            for (let s = this.start[c]!; s < this.start[c + 1]!; s++) {
              const i = this.order[s]!
              const dx = this.points[3 * i]! - x
              const dy = this.points[3 * i + 1]! - y
              const dz = this.points[3 * i + 2]! - z
              const d2 = dx * dx + dy * dy + dz * dz
              if (d2 > limit2) continue
              if (found < k || d2 < outD2[found - 1]!) {
                let j = found < k ? found++ : k - 1
                while (j > 0 && outD2[j - 1]! > d2) {
                  outD2[j] = outD2[j - 1]!
                  outIdx[j] = outIdx[j - 1]!
                  j--
                }
                outD2[j] = d2
                outIdx[j] = i
              }
            }
          }
        }
      }
    }
    return found
  }

  /** Distance to the nearest point (Infinity when there is none within maxDistance). */
  distance(x: number, y: number, z: number, maxDistance = Infinity): number {
    const n = this.nearest(x, y, z, 1, this.i1, this.d1, maxDistance)
    return n ? Math.sqrt(this.d1[0]!) : Infinity
  }
  private readonly i1 = new Int32Array(1)
  private readonly d1 = new Float64Array(1)
}

/** Surface samples of a mesh (see adjacency.sampleSurface) as a tight Float32Array. */
export function surfacePoints(mesh: Mesh, spacing: number): Float32Array {
  const buf = new PointBuffer(Math.max(64, mesh.indices.length / 3))
  sampleSurface(mesh, spacing, buf)
  return buf.data.slice(0, buf.length * 3)
}

export interface DistanceStats {
  mean: number
  median: number
  p95: number
  max: number
}

/** One-sided distance statistics from `points` to the point set behind `index`. */
export function surfaceDistance(points: Float32Array, index: PointIndex): DistanceStats {
  const n = points.length / 3
  const d = new Float64Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    d[i] = index.distance(points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!)
    sum += d[i]!
  }
  d.sort()
  const q = (p: number) => (n ? d[Math.min(n - 1, Math.floor(p * (n - 1)))]! : 0)
  return { mean: n ? sum / n : 0, median: q(0.5), p95: q(0.95), max: q(1) }
}

// ── Rigid fits ────────────────────────────────────────────────────────────────────────────────

/** x' = R·x + t, R row-major 3×3. */
export interface Rigid {
  r: number[]
  t: [number, number, number]
}

export const IDENTITY: Rigid = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }

export function applyRigid(m: Rigid, points: Float32Array): Float32Array {
  const out = new Float32Array(points.length)
  const { r, t } = m
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i]!
    const y = points[i + 1]!
    const z = points[i + 2]!
    out[i] = r[0]! * x + r[1]! * y + r[2]! * z + t[0]
    out[i + 1] = r[3]! * x + r[4]! * y + r[5]! * z + t[1]
    out[i + 2] = r[6]! * x + r[7]! * y + r[8]! * z + t[2]
  }
  return out
}

/** Rotation angle of a rigid transform, radians. */
export function rotationAngle(m: Rigid): number {
  const tr = m.r[0]! + m.r[4]! + m.r[8]!
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)))
}

/** Largest eigenvector of a symmetric 4×4 matrix (cyclic Jacobi). */
function dominantEigenvector4(a: number[][]): number[] {
  const n = 4
  const v: number[][] = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 1 : 0)))
  const m = a.map((row) => [...row])
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += m[p]![q]! ** 2
    if (off < 1e-22) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(m[p]![q]!) < 1e-300) continue
        const theta = (m[q]![q]! - m[p]![p]!) / (2 * m[p]![q]!)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const kp = m[k]![p]!
          const kq = m[k]![q]!
          m[k]![p] = c * kp - s * kq
          m[k]![q] = s * kp + c * kq
        }
        for (let k = 0; k < n; k++) {
          const pk = m[p]![k]!
          const qk = m[q]![k]!
          m[p]![k] = c * pk - s * qk
          m[q]![k] = s * pk + c * qk
        }
        for (let k = 0; k < n; k++) {
          const kp = v[k]![p]!
          const kq = v[k]![q]!
          v[k]![p] = c * kp - s * kq
          v[k]![q] = s * kp + c * kq
        }
      }
    }
  }
  let best = 0
  for (let i = 1; i < n; i++) if (m[i]![i]! > m[best]![best]!) best = i
  return [0, 1, 2, 3].map((k) => v[k]![best]!)
}

/**
 * Least-squares rigid transform mapping `from` onto `to` (paired xyz triples), Horn's
 * quaternion method. Optional per-pair weights.
 */
export function fitRigid(from: Float32Array, to: Float32Array, weights?: Float32Array): Rigid {
  const n = Math.min(from.length, to.length) / 3
  if (n === 0) return IDENTITY
  let wSum = 0
  const cf = [0, 0, 0]
  const ct = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i]! : 1
    wSum += w
    for (let k = 0; k < 3; k++) {
      cf[k] = cf[k]! + w * from[3 * i + k]!
      ct[k] = ct[k]! + w * to[3 * i + k]!
    }
  }
  if (wSum <= 0) return IDENTITY
  for (let k = 0; k < 3; k++) {
    cf[k] = cf[k]! / wSum
    ct[k] = ct[k]! / wSum
  }
  if (n < 3) return { r: [...IDENTITY.r], t: [ct[0]! - cf[0]!, ct[1]! - cf[1]!, ct[2]! - cf[2]!] }
  // cross-covariance S[a][b] = Σ w · from_a · to_b
  const S = [0, 0, 0].map(() => [0, 0, 0])
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i]! : 1
    for (let a = 0; a < 3; a++) {
      const fa = from[3 * i + a]! - cf[a]!
      for (let b = 0; b < 3; b++) S[a]![b] = S[a]![b]! + w * fa * (to[3 * i + b]! - ct[b]!)
    }
  }
  const [Sxx, Sxy, Sxz] = S[0] as [number, number, number]
  const [Syx, Syy, Syz] = S[1] as [number, number, number]
  const [Szx, Szy, Szz] = S[2] as [number, number, number]
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ]
  let [qw, qx, qy, qz] = dominantEigenvector4(N) as [number, number, number, number]
  const ql = Math.hypot(qw, qx, qy, qz) || 1
  qw /= ql
  qx /= ql
  qy /= ql
  qz /= ql
  const r = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
    2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
    2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
  ]
  const t: [number, number, number] = [
    ct[0]! - (r[0]! * cf[0]! + r[1]! * cf[1]! + r[2]! * cf[2]!),
    ct[1]! - (r[3]! * cf[0]! + r[4]! * cf[1]! + r[5]! * cf[2]!),
    ct[2]! - (r[6]! * cf[0]! + r[7]! * cf[1]! + r[8]! * cf[2]!),
  ]
  return { r, t }
}

export interface IcpResult {
  transform: Rigid
  /** RMS distance from the moved source points to their nearest target point. */
  rms: number
  iterations: number
}

export interface IcpOptions {
  maxIterations?: number
  /** Pairs further apart than this multiple of the current 90th-percentile distance are ignored. */
  trim?: number
  /** Stop when the RMS improves by less than this fraction. */
  tolerance?: number
  /** Starting transform; default is the translation that aligns the centroids. */
  initial?: Rigid
}

/** Point-to-point ICP of `source` onto the point set behind `target`. */
export function icp(source: Float32Array, target: PointIndex, opts: IcpOptions = {}): IcpResult {
  const { maxIterations = 80, trim = 1.5, tolerance = 1e-6 } = opts
  const n = source.length / 3
  let transform = opts.initial
  if (!transform) {
    const cs = [0, 0, 0]
    const ctg = [0, 0, 0]
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) cs[k] = cs[k]! + source[3 * i + k]! / n
    for (let i = 0; i < target.count; i++) for (let k = 0; k < 3; k++) ctg[k] = ctg[k]! + target.points[3 * i + k]! / target.count
    transform = { r: [...IDENTITY.r], t: [ctg[0]! - cs[0]!, ctg[1]! - cs[1]!, ctg[2]! - cs[2]!] }
  }
  const idx = new Int32Array(1)
  const d2 = new Float64Array(1)
  const matched = new Float32Array(n * 3)
  const dist = new Float64Array(n)
  const weights = new Float32Array(n)
  let rms = Infinity
  let it = 0
  for (; it < maxIterations; it++) {
    const moved = applyRigid(transform, source)
    for (let i = 0; i < n; i++) {
      target.nearest(moved[3 * i]!, moved[3 * i + 1]!, moved[3 * i + 2]!, 1, idx, d2)
      const j = idx[0]!
      matched[3 * i] = target.points[3 * j]!
      matched[3 * i + 1] = target.points[3 * j + 1]!
      matched[3 * i + 2] = target.points[3 * j + 2]!
      dist[i] = Math.sqrt(d2[0]!)
    }
    const sorted = Float64Array.from(dist).sort()
    const cut = Math.max(sorted[Math.floor(0.9 * (n - 1))]! * trim, 1e-9)
    let sum = 0
    let used = 0
    for (let i = 0; i < n; i++) {
      const keep = dist[i]! <= cut
      weights[i] = keep ? 1 : 0
      if (keep) {
        sum += dist[i]! ** 2
        used++
      }
    }
    const now = Math.sqrt(sum / Math.max(1, used))
    if (rms - now < tolerance * rms) {
      rms = Math.min(rms, now)
      break
    }
    rms = now
    transform = fitRigid(source, matched, weights)
  }
  return { transform, rms, iterations: it }
}

// ── Smooth deformation from scattered anchors ─────────────────────────────────────────────────

export interface DeformationOptions {
  /** Number of nearest anchors blended at each point. */
  k?: number
  /** Lower bound of the kernel bandwidth, in space units. */
  minSigma?: number
  /** Bandwidth = max(minSigma, bandwidthScale × distance to the k-th nearest anchor). */
  bandwidthScale?: number
  /** Grid cell of the anchor index; default 2·minSigma. */
  cell?: number
  /** Per-anchor confidence in (0, 1]; multiplies the kernel weight. */
  weights?: Float32Array
}

export interface Deformation {
  /** Displacement at a point. */
  displacementAt(x: number, y: number, z: number): [number, number, number]
  /** Warp xyz triples; returns a new array. */
  apply(points: Float32Array): Float32Array
  readonly anchors: number
}

/**
 * Displacement field from anchor pairs: `from` are positions in the source space, `to` the
 * corresponding positions in the target space (same length).
 */
export function buildDeformation(from: Float32Array, to: Float32Array, opts: DeformationOptions = {}): Deformation {
  const n = from.length / 3
  if (to.length !== from.length) throw new Error('anchor arrays differ in length')
  if (n === 0) throw new Error('no anchors')
  const k = Math.min(opts.k ?? 24, n)
  const minSigma = opts.minSigma ?? 0.01
  const scale = opts.bandwidthScale ?? 0.5
  const index = new PointIndex(from, opts.cell ?? 2 * minSigma)
  const disp = new Float32Array(from.length)
  for (let i = 0; i < from.length; i++) disp[i] = to[i]! - from[i]!
  const conf = opts.weights
  if (conf && conf.length !== n) throw new Error('anchor weights differ in length')
  const idx = new Int32Array(k)
  const d2 = new Float64Array(k)
  const displacementAt = (x: number, y: number, z: number): [number, number, number] => {
    const found = index.nearest(x, y, z, k, idx, d2)
    const sigma = Math.max(minSigma, scale * Math.sqrt(d2[found - 1]!))
    const inv = 1 / (2 * sigma * sigma)
    const d0 = d2[0]!
    let w = 0
    let dx = 0
    let dy = 0
    let dz = 0
    for (let j = 0; j < found; j++) {
      // subtract the nearest distance so the weights never all underflow far from the anchors
      const wj = Math.exp(-(d2[j]! - d0) * inv) * (conf ? conf[idx[j]!]! : 1)
      const a = 3 * idx[j]!
      w += wj
      dx += wj * disp[a]!
      dy += wj * disp[a + 1]!
      dz += wj * disp[a + 2]!
    }
    return [dx / w, dy / w, dz / w]
  }
  return {
    anchors: n,
    displacementAt,
    apply(points) {
      const out = new Float32Array(points.length)
      for (let i = 0; i < points.length; i += 3) {
        const d = displacementAt(points[i]!, points[i + 1]!, points[i + 2]!)
        out[i] = points[i]! + d[0]
        out[i + 1] = points[i + 1]! + d[1]
        out[i + 2] = points[i + 2]! + d[2]
      }
      return out
    },
  }
}

/** Thin a point set to at most one point per `cell`-sized voxel; returns kept indices. */
export function voxelSubsample(points: Float32Array, cell: number): Uint32Array {
  const n = points.length / 3
  const min = [Infinity, Infinity, Infinity]
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) if (points[3 * i + k]! < min[k]!) min[k] = points[3 * i + k]!
  const seen = new Set<number>()
  const keep: number[] = []
  const inv = 1 / cell
  for (let i = 0; i < n; i++) {
    const ix = Math.floor((points[3 * i]! - min[0]!) * inv)
    const iy = Math.floor((points[3 * i + 1]! - min[1]!) * inv)
    const iz = Math.floor((points[3 * i + 2]! - min[2]!) * inv)
    // exact for up to 2^17 cells per axis
    const key = ix + 131072 * (iy + 131072 * iz)
    if (seen.has(key)) continue
    seen.add(key)
    keep.push(i)
  }
  return Uint32Array.from(keep)
}

/** The points selected by `voxelSubsample`, as a new array. */
export function thinPoints(points: Float32Array, cell: number): Float32Array {
  const keep = voxelSubsample(points, cell)
  const out = new Float32Array(keep.length * 3)
  for (let j = 0; j < keep.length; j++) {
    const i = keep[j]!
    out[3 * j] = points[3 * i]!
    out[3 * j + 1] = points[3 * i + 1]!
    out[3 * j + 2] = points[3 * i + 2]!
  }
  return out
}

// ── Point-in-mesh ─────────────────────────────────────────────────────────────────────────────

/**
 * Inside/outside test for a (nearly) closed triangle mesh by ray parity along +Y. Triangles are
 * binned on an XZ grid so a query only visits the triangles above its column. For meshes with
 * small holes the answer is wrong only for rays that pass through a hole.
 */
export class InsideTester {
  readonly bbox: [number, number, number, number, number, number]
  private readonly p: Float32Array
  private readonly idx: Uint32Array
  private readonly nx: number
  private readonly nz: number
  private readonly inv: number
  private readonly start: Uint32Array
  private readonly tris: Uint32Array

  constructor(mesh: Mesh, resolution = 48) {
    const p = (this.p = mesh.positions)
    const idx = (this.idx = mesh.indices)
    const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (p[i + k]! < b[k]!) b[k] = p[i + k]!
        if (p[i + k]! > b[k + 3]!) b[k + 3] = p[i + k]!
      }
    }
    this.bbox = b
    const size = Math.max(b[3] - b[0], b[5] - b[2], 1e-9) / resolution
    this.inv = 1 / size
    this.nx = Math.floor((b[3] - b[0]) * this.inv) + 1
    this.nz = Math.floor((b[5] - b[2]) * this.inv) + 1
    const counts = new Uint32Array(this.nx * this.nz + 1)
    const span = (t: number): [number, number, number, number] => {
      const a = 3 * idx[t]!
      const bb = 3 * idx[t + 1]!
      const c = 3 * idx[t + 2]!
      const x0 = Math.floor((Math.min(p[a]!, p[bb]!, p[c]!) - b[0]) * this.inv)
      const x1 = Math.floor((Math.max(p[a]!, p[bb]!, p[c]!) - b[0]) * this.inv)
      const z0 = Math.floor((Math.min(p[a + 2]!, p[bb + 2]!, p[c + 2]!) - b[2]) * this.inv)
      const z1 = Math.floor((Math.max(p[a + 2]!, p[bb + 2]!, p[c + 2]!) - b[2]) * this.inv)
      return [x0, Math.min(x1, this.nx - 1), z0, Math.min(z1, this.nz - 1)]
    }
    for (let t = 0; t < idx.length; t += 3) {
      const [x0, x1, z0, z1] = span(t)
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) counts[x + this.nx * z + 1] = counts[x + this.nx * z + 1]! + 1
    }
    for (let c = 0; c < this.nx * this.nz; c++) counts[c + 1] = counts[c + 1]! + counts[c]!
    this.start = counts
    this.tris = new Uint32Array(counts[this.nx * this.nz]!)
    const fill = counts.slice(0, this.nx * this.nz)
    for (let t = 0; t < idx.length; t += 3) {
      const [x0, x1, z0, z1] = span(t)
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const c = x + this.nx * z
          this.tris[fill[c]!] = t
          fill[c] = fill[c]! + 1
        }
      }
    }
  }

  contains(x: number, y: number, z: number): boolean {
    const b = this.bbox
    if (x < b[0] || x > b[3] || y < b[1] || y > b[4] || z < b[2] || z > b[5]) return false
    // nudge off exact vertex/edge alignments (grid-aligned queries on axis-aligned geometry)
    const eps = 1e-6 / this.inv
    x += 0.7231 * eps
    z += 0.3117 * eps
    const cx = Math.min(this.nx - 1, Math.floor((x - b[0]) * this.inv))
    const cz = Math.min(this.nz - 1, Math.floor((z - b[2]) * this.inv))
    const c = cx + this.nx * cz
    const p = this.p
    let crossings = 0
    for (let s = this.start[c]!; s < this.start[c + 1]!; s++) {
      const t = this.tris[s]!
      const a = 3 * this.idx[t]!
      const bb = 3 * this.idx[t + 1]!
      const cc = 3 * this.idx[t + 2]!
      // 2D point-in-triangle in XZ with a consistent tie-break, then the height of the hit
      const ax = p[a]! - x
      const az = p[a + 2]! - z
      const bx = p[bb]! - x
      const bz = p[bb + 2]! - z
      const ccx = p[cc]! - x
      const ccz = p[cc + 2]! - z
      const w0 = bx * ccz - bz * ccx
      const w1 = ccx * az - ccz * ax
      const w2 = ax * bz - az * bx
      const pos = w0 > 0 && w1 > 0 && w2 > 0
      const neg = w0 < 0 && w1 < 0 && w2 < 0
      if (!pos && !neg) continue
      const sum = w0 + w1 + w2
      const hitY = (w0 * p[a + 1]! + w1 * p[bb + 1]! + w2 * p[cc + 1]!) / sum
      if (hitY > y) crossings++
    }
    return (crossings & 1) === 1
  }

  /** Fraction of the given points that lie inside. */
  fractionInside(points: Float32Array): number {
    const n = points.length / 3
    if (n === 0) return 0
    let inside = 0
    for (let i = 0; i < n; i++) if (this.contains(points[3 * i]!, points[3 * i + 1]!, points[3 * i + 2]!)) inside++
    return inside / n
  }
}
