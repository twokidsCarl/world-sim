// Tubes along polylines (nerves): polyline simplification and tube meshing.

import type { Mesh } from './geometry.ts'

export interface Polyline {
  /** flat xyz */
  points: Float32Array
  /** one per point */
  radius: Float32Array
}

/** Total length of a polyline. */
export function polylineLength(points: ArrayLike<number>): number {
  let len = 0
  for (let i = 3; i < points.length; i += 3) len += Math.hypot(points[i]! - points[i - 3]!, points[i + 1]! - points[i - 2]!, points[i + 2]! - points[i - 1]!)
  return len
}

/**
 * Douglas–Peucker simplification that also keeps points where the radius changes: a point is
 * dropped only if it lies within `tolerance` of the simplified line and its radius is within
 * `radiusTolerance` (relative) of the value interpolated between its kept neighbours. Additionally
 * no kept segment is longer than `maxSegment`, so later per-point operations (warping, collision
 * clean-up) still have something to act on.
 */
export function simplifyPolyline(line: Polyline, tolerance: number, radiusTolerance = 0.15, maxSegment = Infinity): Polyline {
  const n = line.points.length / 3
  if (n <= 2) return { points: Float32Array.from(line.points), radius: Float32Array.from(line.radius) }
  const p = line.points
  const r = line.radius
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    if (b - a < 2) continue
    const ax = p[3 * a]!
    const ay = p[3 * a + 1]!
    const az = p[3 * a + 2]!
    const dx = p[3 * b]! - ax
    const dy = p[3 * b + 1]! - ay
    const dz = p[3 * b + 2]! - az
    const len2 = dx * dx + dy * dy + dz * dz
    const len = Math.sqrt(len2)
    let worst = -1
    let worstScore = 0
    for (let i = a + 1; i < b; i++) {
      const px = p[3 * i]! - ax
      const py = p[3 * i + 1]! - ay
      const pz = p[3 * i + 2]! - az
      let t = len2 > 0 ? (px * dx + py * dy + pz * dz) / len2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const d = Math.hypot(px - t * dx, py - t * dy, pz - t * dz)
      const ri = r[a]! + (r[b]! - r[a]!) * t
      const dr = Math.abs(r[i]! - ri) / Math.max(1e-9, Math.max(r[i]!, ri))
      // normalised so that 1 = at tolerance on either criterion
      const score = Math.max(d / tolerance, dr / radiusTolerance)
      if (score > worstScore) {
        worstScore = score
        worst = i
      }
    }
    if (worstScore > 1 && worst > 0) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    } else if (len > maxSegment) {
      const mid = (a + b) >> 1
      keep[mid] = 1
      stack.push([a, mid], [mid, b])
    }
  }
  let m = 0
  for (let i = 0; i < n; i++) m += keep[i]!
  const points = new Float32Array(m * 3)
  const radius = new Float32Array(m)
  let j = 0
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue
    points[3 * j] = p[3 * i]!
    points[3 * j + 1] = p[3 * i + 1]!
    points[3 * j + 2] = p[3 * i + 2]!
    radius[j++] = r[i]!
  }
  return { points, radius }
}

/** Drop consecutive duplicate points (zero-length segments break the frame transport). */
export function dedupePolyline(line: Polyline, eps = 1e-7): Polyline {
  const n = line.points.length / 3
  const pts: number[] = []
  const rad: number[] = []
  for (let i = 0; i < n; i++) {
    const x = line.points[3 * i]!
    const y = line.points[3 * i + 1]!
    const z = line.points[3 * i + 2]!
    const k = pts.length
    if (k && Math.hypot(x - pts[k - 3]!, y - pts[k - 2]!, z - pts[k - 1]!) <= eps) continue
    pts.push(x, y, z)
    rad.push(line.radius[i]!)
  }
  return { points: Float32Array.from(pts), radius: Float32Array.from(rad) }
}

/**
 * Closed tube around a polyline: one ring of `sides` vertices per point (rotation-minimising
 * frames, so the tube does not twist), fan caps at both ends. Outward-facing triangles.
 * Returns null for a polyline with fewer than two distinct points.
 */
export function buildTube(line: Polyline, sides: number): Mesh | null {
  const l = dedupePolyline(line)
  const n = l.points.length / 3
  if (n < 2 || sides < 3) return null
  const p = l.points
  // tangents
  const tan = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    let tx = p[3 * b]! - p[3 * a]!
    let ty = p[3 * b + 1]! - p[3 * a + 1]!
    let tz = p[3 * b + 2]! - p[3 * a + 2]!
    const len = Math.hypot(tx, ty, tz) || 1
    tx /= len
    ty /= len
    tz /= len
    tan.set([tx, ty, tz], 3 * i)
  }
  // initial normal: any vector perpendicular to the first tangent
  let nx = 0
  let ny = 0
  let nz = 0
  {
    const tx = tan[0]!
    const ty = tan[1]!
    const tz = tan[2]!
    const ax = Math.abs(tx) < 0.9 ? 1 : 0
    const ay = ax ? 0 : 1
    // n = t × a
    nx = ty * 0 - tz * ay
    ny = tz * ax - tx * 0
    nz = tx * ay - ty * ax
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    ny /= len
    nz /= len
  }
  const positions = new Float32Array((n * sides + 2) * 3)
  const indices: number[] = []
  for (let i = 0; i < n; i++) {
    const tx = tan[3 * i]!
    const ty = tan[3 * i + 1]!
    const tz = tan[3 * i + 2]!
    // transport: remove the component along the new tangent
    const d = nx * tx + ny * ty + nz * tz
    nx -= d * tx
    ny -= d * ty
    nz -= d * tz
    let len = Math.hypot(nx, ny, nz)
    if (len < 1e-6) {
      // tangent flipped onto the normal: pick a fresh perpendicular
      const ax = Math.abs(tx) < 0.9 ? 1 : 0
      const ay = ax ? 0 : 1
      nx = -tz * ay
      ny = tz * ax
      nz = tx * ay - ty * ax
      len = Math.hypot(nx, ny, nz) || 1
    }
    nx /= len
    ny /= len
    nz /= len
    // b = t × n
    const bx = ty * nz - tz * ny
    const by = tz * nx - tx * nz
    const bz = tx * ny - ty * nx
    const r = l.radius[i]!
    for (let s = 0; s < sides; s++) {
      const a = (2 * Math.PI * s) / sides
      const c = Math.cos(a) * r
      const sn = Math.sin(a) * r
      const o = 3 * (i * sides + s)
      positions[o] = p[3 * i]! + nx * c + bx * sn
      positions[o + 1] = p[3 * i + 1]! + ny * c + by * sn
      positions[o + 2] = p[3 * i + 2]! + nz * c + bz * sn
    }
    if (i > 0) {
      const r0 = (i - 1) * sides
      const r1 = i * sides
      for (let s = 0; s < sides; s++) {
        const s1 = (s + 1) % sides
        // ring angle runs n → b = counter-clockwise seen looking back along the tangent
        indices.push(r0 + s, r0 + s1, r1 + s1, r0 + s, r1 + s1, r1 + s)
      }
    }
  }
  const c0 = n * sides
  const c1 = c0 + 1
  positions.set(p.subarray(0, 3), 3 * c0)
  positions.set(p.subarray(3 * (n - 1), 3 * n), 3 * c1)
  for (let s = 0; s < sides; s++) {
    const s1 = (s + 1) % sides
    indices.push(c0, s1, s)
    indices.push(c1, (n - 1) * sides + s, (n - 1) * sides + s1)
  }
  return { positions, indices: Uint32Array.from(indices) }
}

/** Concatenate meshes into one (no welding). */
export function mergeMeshes(meshes: Mesh[]): Mesh {
  const nv = meshes.reduce((s, m) => s + m.positions.length, 0)
  const ni = meshes.reduce((s, m) => s + m.indices.length, 0)
  const positions = new Float32Array(nv)
  const indices = new Uint32Array(ni)
  let vo = 0
  let io = 0
  for (const m of meshes) {
    positions.set(m.positions, vo)
    const base = vo / 3
    for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k]! + base
    vo += m.positions.length
    io += m.indices.length
  }
  return { positions, indices }
}
