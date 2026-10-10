// Mesh utilities: coordinate conversion, welding, measurements, normals, simplification.

import { MeshoptSimplifier } from 'meshoptimizer'

export interface Mesh {
  positions: Float32Array
  indices: Uint32Array
}

/**
 * BodyParts3D source frame (mm, Z up, left +X, anterior -Y) -> runtime frame (m, Y up, left +X,
 * anterior +Z): (x, y, z) -> (x, z, -y) / 1000. A proper rotation, so winding is unchanged.
 */
export function sourceToRuntime(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i]! / 1000
    out[i + 1] = src[i + 2]! / 1000
    out[i + 2] = -src[i + 1]! / 1000
  }
  return out
}

/** Same rotation for direction vectors (no scaling). */
export function rotateToRuntime(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i]!
    out[i + 1] = src[i + 2]!
    out[i + 2] = -src[i + 1]!
  }
  return out
}

export interface WeldResult extends Mesh {
  /** old vertex index -> new vertex index */
  remap: Uint32Array
  removedVertices: number
  removedTriangles: number
}

/**
 * Merge vertices with bit-identical positions, drop degenerate triangles (repeated index) and
 * exact duplicate triangles (same three vertices in the same cyclic order), drop unused vertices.
 */
export function weld(positions: Float32Array, indices: Uint32Array): WeldResult {
  const nv = positions.length / 3
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length)
  const remap = new Uint32Array(nv)
  const map = new Map<string, number>()
  const rep = new Uint32Array(nv) // new index -> a source vertex
  let count = 0
  for (let v = 0; v < nv; v++) {
    // -0 and +0 compare equal as positions; normalise the sign bit of zero.
    const a = bits[3 * v]! === 0x80000000 ? 0 : bits[3 * v]!
    const b = bits[3 * v + 1]! === 0x80000000 ? 0 : bits[3 * v + 1]!
    const c = bits[3 * v + 2]! === 0x80000000 ? 0 : bits[3 * v + 2]!
    const key = String.fromCharCode(a & 0xffff, a >>> 16, b & 0xffff, b >>> 16, c & 0xffff, c >>> 16)
    let id = map.get(key)
    if (id === undefined) {
      id = count++
      map.set(key, id)
      rep[id] = v
    }
    remap[v] = id
  }
  const outIdx = new Uint32Array(indices.length)
  const triSeen = new Set<string>()
  let ni = 0
  for (let t = 0; t < indices.length; t += 3) {
    let a = remap[indices[t]!]!
    let b = remap[indices[t + 1]!]!
    let c = remap[indices[t + 2]!]!
    if (a === b || b === c || a === c) continue
    // rotate so the smallest index is first (keeps orientation)
    if (b < a && b < c) [a, b, c] = [b, c, a]
    else if (c < a && c < b) [a, b, c] = [c, a, b]
    const key = `${a},${b},${c}`
    if (triSeen.has(key)) continue
    triSeen.add(key)
    outIdx[ni] = a
    outIdx[ni + 1] = b
    outIdx[ni + 2] = c
    ni += 3
  }
  // compact: only vertices still referenced
  const used = new Int32Array(count).fill(-1)
  let nUsed = 0
  for (let k = 0; k < ni; k++) {
    const v = outIdx[k]!
    if (used[v] === -1) used[v] = nUsed++
    outIdx[k] = used[v]!
  }
  const outPos = new Float32Array(nUsed * 3)
  for (let id = 0; id < count; id++) {
    const u = used[id]!
    if (u < 0) continue
    const s = rep[id]!
    outPos[3 * u] = positions[3 * s]!
    outPos[3 * u + 1] = positions[3 * s + 1]!
    outPos[3 * u + 2] = positions[3 * s + 2]!
  }
  const finalRemap = new Uint32Array(nv)
  for (let v = 0; v < nv; v++) {
    const u = used[remap[v]!]!
    finalRemap[v] = u < 0 ? 0xffffffff : u
  }
  return {
    positions: outPos,
    indices: outIdx.slice(0, ni),
    remap: finalRemap,
    removedVertices: nv - nUsed,
    removedTriangles: indices.length / 3 - ni / 3,
  }
}

export interface MeshStats {
  bbox: [number, number, number, number, number, number]
  /** Area-weighted surface centroid. */
  centroid: [number, number, number]
  area: number
  /** Signed enclosed volume (positive when triangles wind counter-clockwise seen from outside). */
  signedVolume: number
  /** Mean triangle edge length. */
  meanEdge: number
}

export function measure(mesh: Mesh): MeshStats {
  const p = mesh.positions
  const idx = mesh.indices
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!
    const y = p[i + 1]!
    const z = p[i + 2]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  // Measure relative to the bbox centre to keep the volume sum well conditioned.
  const ox = (minX + maxX) / 2
  const oy = (minY + maxY) / 2
  const oz = (minZ + maxZ) / 2
  let area = 0
  let vol = 0
  let cx = 0
  let cy = 0
  let cz = 0
  let edge = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t]!
    const b = 3 * idx[t + 1]!
    const c = 3 * idx[t + 2]!
    const ax = p[a]! - ox
    const ay = p[a + 1]! - oy
    const az = p[a + 2]! - oz
    const bx = p[b]! - ox
    const by = p[b + 1]! - oy
    const bz = p[b + 2]! - oz
    const ux = p[c]! - ox
    const uy = p[c + 1]! - oy
    const uz = p[c + 2]! - oz
    const e1x = bx - ax
    const e1y = by - ay
    const e1z = bz - az
    const e2x = ux - ax
    const e2y = uy - ay
    const e2z = uz - az
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    const ar = 0.5 * Math.hypot(nx, ny, nz)
    area += ar
    cx += (ar * (ax + bx + ux)) / 3
    cy += (ar * (ay + by + uy)) / 3
    cz += (ar * (az + bz + uz)) / 3
    vol += (ax * nx + ay * ny + az * nz) / 6
    edge += Math.hypot(e1x, e1y, e1z) + Math.hypot(e2x, e2y, e2z) + Math.hypot(ux - bx, uy - by, uz - bz)
  }
  const nt = idx.length / 3
  const centroid: [number, number, number] =
    area > 0 ? [ox + cx / area, oy + cy / area, oz + cz / area] : [ox, oy, oz]
  return {
    bbox: [minX, minY, minZ, maxX, maxY, maxZ],
    centroid,
    area,
    signedVolume: vol,
    meanEdge: nt ? edge / (3 * nt) : 0,
  }
}

/** Smooth per-vertex normals, weighting each face normal by the corner angle. */
export function computeNormals(mesh: Mesh): Float32Array {
  const p = mesh.positions
  const idx = mesh.indices
  const n = new Float32Array(p.length)
  for (let t = 0; t < idx.length; t += 3) {
    const ia = 3 * idx[t]!
    const ib = 3 * idx[t + 1]!
    const ic = 3 * idx[t + 2]!
    const abx = p[ib]! - p[ia]!
    const aby = p[ib + 1]! - p[ia + 1]!
    const abz = p[ib + 2]! - p[ia + 2]!
    const acx = p[ic]! - p[ia]!
    const acy = p[ic + 1]! - p[ia + 1]!
    const acz = p[ic + 2]! - p[ia + 2]!
    const bcx = p[ic]! - p[ib]!
    const bcy = p[ic + 1]! - p[ib + 1]!
    const bcz = p[ic + 2]! - p[ib + 2]!
    let nx = aby * acz - abz * acy
    let ny = abz * acx - abx * acz
    let nz = abx * acy - aby * acx
    const nl = Math.hypot(nx, ny, nz)
    if (nl === 0) continue
    nx /= nl
    ny /= nl
    nz /= nl
    const lab = Math.hypot(abx, aby, abz)
    const lac = Math.hypot(acx, acy, acz)
    const lbc = Math.hypot(bcx, bcy, bcz)
    if (lab === 0 || lac === 0 || lbc === 0) continue
    const clamp = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v)
    const wa = Math.acos(clamp((abx * acx + aby * acy + abz * acz) / (lab * lac)))
    const wb = Math.acos(clamp(-(abx * bcx + aby * bcy + abz * bcz) / (lab * lbc)))
    const wc = Math.PI - wa - wb
    n[ia] = n[ia]! + nx * wa
    n[ia + 1] = n[ia + 1]! + ny * wa
    n[ia + 2] = n[ia + 2]! + nz * wa
    n[ib] = n[ib]! + nx * wb
    n[ib + 1] = n[ib + 1]! + ny * wb
    n[ib + 2] = n[ib + 2]! + nz * wb
    n[ic] = n[ic]! + nx * wc
    n[ic + 1] = n[ic + 1]! + ny * wc
    n[ic + 2] = n[ic + 2]! + nz * wc
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!)
    if (l > 0) {
      n[i] = n[i]! / l
      n[i + 1] = n[i + 1]! / l
      n[i + 2] = n[i + 2]! / l
    } else {
      n[i + 1] = 1 // isolated/degenerate vertex: any unit vector
    }
  }
  return n
}

/** Mean dot product between two unit-normal sets and the fraction that disagree by more than 90°. */
export function compareNormals(a: Float32Array, b: Float32Array): { meanDot: number; flipped: number } {
  let sum = 0
  let flipped = 0
  const n = Math.min(a.length, b.length) / 3
  for (let i = 0; i < 3 * n; i += 3) {
    const la = Math.hypot(a[i]!, a[i + 1]!, a[i + 2]!) || 1
    const lb = Math.hypot(b[i]!, b[i + 1]!, b[i + 2]!) || 1
    const d = (a[i]! * b[i]! + a[i + 1]! * b[i + 1]! + a[i + 2]! * b[i + 2]!) / (la * lb)
    sum += d
    if (d < 0) flipped++
  }
  return { meanDot: n ? sum / n : 1, flipped: n ? flipped / n : 0 }
}

export function flipWinding(indices: Uint32Array): void {
  for (let t = 0; t < indices.length; t += 3) {
    const b = indices[t + 1]!
    indices[t + 1] = indices[t + 2]!
    indices[t + 2] = b
  }
}

/** Drop vertices no triangle references. */
export function compact(mesh: Mesh): Mesh {
  const nv = mesh.positions.length / 3
  const map = new Int32Array(nv).fill(-1)
  const indices = new Uint32Array(mesh.indices.length)
  let n = 0
  for (let k = 0; k < indices.length; k++) {
    const v = mesh.indices[k]!
    if (map[v] === -1) map[v] = n++
    indices[k] = map[v]!
  }
  const positions = new Float32Array(3 * n)
  for (let v = 0; v < nv; v++) {
    const u = map[v]!
    if (u < 0) continue
    positions[3 * u] = mesh.positions[3 * v]!
    positions[3 * u + 1] = mesh.positions[3 * v + 1]!
    positions[3 * u + 2] = mesh.positions[3 * v + 2]!
  }
  return { positions, indices }
}

export interface SimplifyResult extends Mesh {
  /** Achieved error in the units of `positions`. */
  error: number
}

/**
 * Error-bounded simplification: collapse as far as `maxError` (absolute, same units as the
 * positions) allows, but never below `minTriangles`.
 */
export async function simplifyMesh(mesh: Mesh, maxError: number, minTriangles: number): Promise<SimplifyResult> {
  await MeshoptSimplifier.ready
  const nt = mesh.indices.length / 3
  if (nt <= minTriangles) return { ...mesh, error: 0 }
  const target = Math.max(3, Math.floor(minTriangles) * 3)
  const [idx, err] = MeshoptSimplifier.simplify(mesh.indices, mesh.positions, 3, target, maxError, ['ErrorAbsolute'])
  if (idx.length === 0 || idx.length >= mesh.indices.length) return { ...mesh, error: 0 }
  const out = compact({ positions: mesh.positions, indices: idx })
  return { ...out, error: err }
}
