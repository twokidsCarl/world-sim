// Geometric "exposure" of a part: the share of its surface that looks straight at the skin with
// nothing solid in between. Used to split the muscular system into a superficial and a deep peel
// layer (see layers.ts for the rule and its threshold).
//
// Method: all occluders (and the skin) are rasterised into a coarse occupancy grid from surface
// samples. From every surface sample of a target part a ray is marched along the outward face
// normal. The sample counts as exposed when the ray reaches a skin cell within `maxDistance`
// before entering a cell occupied by any occluder other than the part itself.

import { PointBuffer, sampleSurface } from './adjacency.ts'
import type { Mesh } from './geometry.ts'

export type ExposureRole = 'skin' | 'occluder' | 'ignore'

export interface ExposureOptions {
  /** Occupancy cell size. */
  cell: number
  /** Surface sample spacing (should be below the cell size so surfaces rasterise watertight). */
  spacing: number
  /** A ray that has not met skin after this distance counts as not exposed. */
  maxDistance: number
}

const SLOTS = 4
const NONE = 0xffff

/**
 * @returns for each index in `targets`, the exposed fraction of its surface samples (0..1).
 */
export function computeExposure(
  meshes: Mesh[],
  roles: ExposureRole[],
  targets: number[],
  opts: ExposureOptions,
): number[] {
  const { cell, spacing, maxDistance } = opts
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (const m of meshes) {
    const p = m.positions
    for (let i = 0; i < p.length; i += 3) {
      if (p[i]! < minX) minX = p[i]!
      if (p[i]! > maxX) maxX = p[i]!
      if (p[i + 1]! < minY) minY = p[i + 1]!
      if (p[i + 1]! > maxY) maxY = p[i + 1]!
      if (p[i + 2]! < minZ) minZ = p[i + 2]!
      if (p[i + 2]! > maxZ) maxZ = p[i + 2]!
    }
  }
  if (!Number.isFinite(minX)) return targets.map(() => 0)
  const inv = 1 / cell
  const nx = Math.floor((maxX - minX) * inv) + 1
  const ny = Math.floor((maxY - minY) * inv) + 1
  const nz = Math.floor((maxZ - minZ) * inv) + 1
  const cells = nx * ny * nz
  const skin = new Uint8Array(cells)
  // up to SLOTS distinct occluder owners per cell; `crowded` marks cells with more
  const slots = new Uint16Array(cells * SLOTS).fill(NONE)
  const crowded = new Uint8Array(cells)

  const buf = new PointBuffer(1 << 16)
  for (let i = 0; i < meshes.length; i++) {
    const role = roles[i]!
    if (role === 'ignore') continue
    buf.length = 0
    sampleSurface(meshes[i]!, spacing, buf)
    const d = buf.data
    for (let k = 0; k < buf.length; k++) {
      const c =
        Math.floor((d[3 * k]! - minX) * inv) +
        nx * (Math.floor((d[3 * k + 1]! - minY) * inv) + ny * Math.floor((d[3 * k + 2]! - minZ) * inv))
      if (role === 'skin') {
        skin[c] = 1
        continue
      }
      const base = c * SLOTS
      let s = 0
      for (; s < SLOTS; s++) {
        const o = slots[base + s]!
        if (o === i) break
        if (o === NONE) {
          slots[base + s] = i
          break
        }
      }
      if (s === SLOTS) crowded[c] = 1
    }
  }

  const step = cell / 2
  const steps = Math.ceil(maxDistance / step)
  const out: number[] = []
  for (const ti of targets) {
    const m = meshes[ti]!
    const p = m.positions
    const idx = m.indices
    let exposed = 0
    let total = 0
    for (let t = 0; t < idx.length; t += 3) {
      const a = 3 * idx[t]!
      const b = 3 * idx[t + 1]!
      const c = 3 * idx[t + 2]!
      const ux = p[b]! - p[a]!
      const uy = p[b + 1]! - p[a + 1]!
      const uz = p[b + 2]! - p[a + 2]!
      const vx = p[c]! - p[a]!
      const vy = p[c + 1]! - p[a + 1]!
      const vz = p[c + 2]! - p[a + 2]!
      let nxn = uy * vz - uz * vy
      let nyn = uz * vx - ux * vz
      let nzn = ux * vy - uy * vx
      const len = Math.hypot(nxn, nyn, nzn)
      if (len === 0) continue
      const area = len / 2
      nxn /= len
      nyn /= len
      nzn /= len
      // one ray per triangle from its centroid, weighted by area
      let x = (p[a]! + p[b]! + p[c]!) / 3
      let y = (p[a + 1]! + p[b + 1]! + p[c + 1]!) / 3
      let z = (p[a + 2]! + p[b + 2]! + p[c + 2]!) / 3
      total += area
      let hit = false
      for (let s = 0; s < steps; s++) {
        x += nxn * step
        y += nyn * step
        z += nzn * step
        const ix = Math.floor((x - minX) * inv)
        const iy = Math.floor((y - minY) * inv)
        const iz = Math.floor((z - minZ) * inv)
        if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) break
        const cidx = ix + nx * (iy + ny * iz)
        const base = cidx * SLOTS
        let blocked = crowded[cidx] === 1
        for (let k = 0; k < SLOTS && !blocked; k++) {
          const o = slots[base + k]!
          if (o === NONE) break
          if (o !== ti) blocked = true
        }
        if (blocked) break
        if (skin[cidx]) {
          hit = true
          break
        }
      }
      if (hit) exposed += area
    }
    out.push(total > 0 ? exposed / total : 0)
  }
  return out
}
