// Surface adjacency between parts.
//
// Every part's surface is covered with sample points no further than `spacing` apart (triangles are
// bisected until no edge exceeds it; one sample per piece). Samples go into a uniform grid with cell size
// = threshold; two parts are adjacent when any sample of one lies within `threshold` of a sample
// of the other. Only the 27-cell neighbourhood is searched, so cost is linear in sample count.
//
// Consequences of sampling: a reported pair is never further apart than `threshold`; a pair whose
// true gap is below roughly threshold − spacing is always found; gaps in between may be missed.

import type { Mesh } from './geometry.ts'

export interface AdjacencyOptions {
  /** Maximum sample-to-sample distance that counts as touching, in mesh units. */
  threshold: number
  /** Maximum distance between neighbouring samples on a surface, in mesh units. */
  spacing: number
}

export interface AdjacencyResult {
  /** neighbours[i] = sorted indices of parts adjacent to part i (symmetric, no self). */
  neighbours: number[][]
  samples: number
}

/** Growable xyz point list. */
export class PointBuffer {
  data: Float32Array
  /** number of points */
  length = 0
  constructor(capacity = 1024) {
    this.data = new Float32Array(capacity * 3)
  }
  push(x: number, y: number, z: number): void {
    const w = this.length * 3
    if (w + 3 > this.data.length) {
      const g = new Float32Array(this.data.length * 2)
      g.set(this.data)
      this.data = g
    }
    this.data[w] = x
    this.data[w + 1] = y
    this.data[w + 2] = z
    this.length++
  }
}

/**
 * Sample points: each triangle is bisected across its longest edge until no edge is longer than
 * `spacing`, and the centroid of every resulting piece is emitted. (Longest-edge bisection rather
 * than a regular n×n split, because the source has many sliver triangles that an n×n split
 * oversamples by an order of magnitude.) Returns the number of points appended.
 */
export function sampleSurface(mesh: Mesh, spacing: number, out: PointBuffer): number {
  const p = mesh.positions
  const idx = mesh.indices
  const s2 = spacing * spacing
  const before = out.length
  const stack: number[] = []
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t]!
    const b = 3 * idx[t + 1]!
    const c = 3 * idx[t + 2]!
    stack.push(p[a]!, p[a + 1]!, p[a + 2]!, p[b]!, p[b + 1]!, p[b + 2]!, p[c]!, p[c + 1]!, p[c + 2]!)
    while (stack.length) {
      const cz = stack.pop()!
      const cy = stack.pop()!
      const cx = stack.pop()!
      const bz = stack.pop()!
      const by = stack.pop()!
      const bx = stack.pop()!
      const az = stack.pop()!
      const ay = stack.pop()!
      const ax = stack.pop()!
      const ab = (bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2
      const bc = (cx - bx) ** 2 + (cy - by) ** 2 + (cz - bz) ** 2
      const ca = (ax - cx) ** 2 + (ay - cy) ** 2 + (az - cz) ** 2
      if (ab <= s2 && bc <= s2 && ca <= s2) {
        out.push((ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3)
      } else if (ab >= bc && ab >= ca) {
        const mx = (ax + bx) / 2
        const my = (ay + by) / 2
        const mz = (az + bz) / 2
        stack.push(ax, ay, az, mx, my, mz, cx, cy, cz, mx, my, mz, bx, by, bz, cx, cy, cz)
      } else if (bc >= ca) {
        const mx = (bx + cx) / 2
        const my = (by + cy) / 2
        const mz = (bz + cz) / 2
        stack.push(ax, ay, az, bx, by, bz, mx, my, mz, ax, ay, az, mx, my, mz, cx, cy, cz)
      } else {
        const mx = (cx + ax) / 2
        const my = (cy + ay) / 2
        const mz = (cz + az) / 2
        stack.push(ax, ay, az, bx, by, bz, mx, my, mz, mx, my, mz, bx, by, bz, cx, cy, cz)
      }
    }
  }
  return out.length - before
}

export function computeAdjacency(meshes: Mesh[], opts: AdjacencyOptions): AdjacencyResult {
  const n = meshes.length
  if (n > 0xffff) throw new Error('too many parts for 16-bit owners')
  const { threshold, spacing } = opts

  // 1. samples
  const buffer = new PointBuffer(1 << 20)
  const counts = meshes.map((m) => sampleSurface(m, spacing, buffer))
  const total = buffer.length
  const pts = buffer.data
  const owner = new Uint16Array(total)
  {
    let o = 0
    for (let i = 0; i < n; i++) {
      owner.fill(i, o, o + counts[i]!)
      o += counts[i]!
    }
  }
  if (total === 0) return { neighbours: meshes.map(() => []), samples: 0 }

  // 2. grid
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < total * 3; i += 3) {
    const x = pts[i]!
    const y = pts[i + 1]!
    const z = pts[i + 2]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const inv = 1 / threshold
  const nx = Math.floor((maxX - minX) * inv) + 1
  const ny = Math.floor((maxY - minY) * inv) + 1
  const nz = Math.floor((maxZ - minZ) * inv) + 1
  const cells = nx * ny * nz
  if (cells > 2 ** 30) throw new Error(`adjacency grid too large (${nx}×${ny}×${nz})`)
  const key = new Uint32Array(total)
  const start = new Uint32Array(cells + 1)
  for (let i = 0; i < total; i++) {
    const ix = Math.floor((pts[3 * i]! - minX) * inv)
    const iy = Math.floor((pts[3 * i + 1]! - minY) * inv)
    const iz = Math.floor((pts[3 * i + 2]! - minZ) * inv)
    const k = ix + nx * (iy + ny * iz)
    key[i] = k
    start[k + 1] = start[k + 1]! + 1
  }
  for (let c = 0; c < cells; c++) start[c + 1] = start[c + 1]! + start[c]!
  const order = new Uint32Array(total)
  {
    const fill = start.slice(0, cells)
    for (let i = 0; i < total; i++) {
      const k = key[i]!
      order[fill[k]!] = i
      fill[k] = fill[k]! + 1
    }
  }
  // cell -> its single owner, or MIXED when several parts have samples in it, or EMPTY
  const EMPTY = 0xffff
  const MIXED = 0xfffe
  const cellOwner = new Uint16Array(cells).fill(EMPTY)
  for (let c = 0; c < cells; c++) {
    const s = start[c]!
    const e = start[c + 1]!
    if (s === e) continue
    let o = owner[order[s]!]!
    for (let k = s + 1; k < e; k++) {
      if (owner[order[k]!] !== o) {
        o = MIXED
        break
      }
    }
    cellOwner[c] = o
  }

  // 3. pairs
  const adj = new Uint8Array(n * n)
  const t2 = threshold * threshold
  const testCells = (c1: number, c2: number): void => {
    const o1 = cellOwner[c1]!
    const o2 = cellOwner[c2]!
    if (o1 !== MIXED && o2 !== MIXED) {
      if (o1 === o2 || adj[o1 * n + o2]) return
    }
    const s1 = start[c1]!
    const e1 = start[c1 + 1]!
    const s2 = start[c2]!
    const e2 = start[c2 + 1]!
    for (let a = s1; a < e1; a++) {
      const pa = order[a]!
      const oa = owner[pa]!
      const x = pts[3 * pa]!
      const y = pts[3 * pa + 1]!
      const z = pts[3 * pa + 2]!
      for (let b = c1 === c2 ? a + 1 : s2; b < e2; b++) {
        const pb = order[b]!
        const ob = owner[pb]!
        if (ob === oa || adj[oa * n + ob]) continue
        const dx = pts[3 * pb]! - x
        const dy = pts[3 * pb + 1]! - y
        const dz = pts[3 * pb + 2]! - z
        if (dx * dx + dy * dy + dz * dz <= t2) {
          adj[oa * n + ob] = 1
          adj[ob * n + oa] = 1
        }
      }
    }
  }
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const c = ix + nx * (iy + ny * iz)
        if (cellOwner[c] === EMPTY) continue
        testCells(c, c)
        // the 13 "forward" neighbours; the other 13 are covered from the neighbour's side
        for (let dz = 0; dz <= 1; dz++) {
          const z = iz + dz
          if (z >= nz) continue
          for (let dy = dz === 0 ? 0 : -1; dy <= 1; dy++) {
            const y = iy + dy
            if (y < 0 || y >= ny) continue
            for (let dx = dz === 0 && dy === 0 ? 1 : -1; dx <= 1; dx++) {
              const x = ix + dx
              if (x < 0 || x >= nx) continue
              const c2 = x + nx * (y + ny * z)
              if (cellOwner[c2] === EMPTY) continue
              testCells(c, c2)
            }
          }
        }
      }
    }
  }
  const neighbours: number[][] = []
  for (let i = 0; i < n; i++) {
    const list: number[] = []
    for (let j = 0; j < n; j++) if (adj[i * n + j]) list.push(j)
    neighbours.push(list)
  }
  return { neighbours, samples: total }
}
