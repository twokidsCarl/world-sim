// Reductions of the micro state to the small summaries the levels are built from.
// On the GPU these become compute passes whose output is read back.

import { buildCells, makeGrid } from './cells'
import { kineticEnergy, momentum, pressure, temperature, volume, type MdState } from './step'

export interface MdScalars {
  n: number
  dim: 2 | 3
  ke: number
  pe: number
  density: number
  temperature: number
  pressure: number
  /** Magnitude of total momentum per particle. */
  momentum: number
}

export interface Hist {
  /** Bin centres. */
  x: Float64Array
  y: Float64Array
}

export function scalars(s: MdState): MdScalars {
  const p = momentum(s)
  return {
    n: s.n,
    dim: s.dim,
    ke: kineticEnergy(s),
    pe: s.pe,
    density: s.n / volume(s),
    temperature: temperature(s),
    pressure: pressure(s),
    momentum: Math.hypot(...p) / s.n,
  }
}

export function speeds(s: MdState): Float64Array {
  const out = new Float64Array(s.n)
  for (let i = 0; i < s.n; i++) {
    let v2 = 0
    for (let d = 0; d < s.dim; d++) v2 += s.vel[i * s.dim + d] * s.vel[i * s.dim + d]
    out[i] = Math.sqrt(v2)
  }
  return out
}

/** Speed histogram normalised as a probability density on [0, vmax]. */
export function speedHistogram(s: MdState, bins: number, vmax: number): Hist {
  const x = new Float64Array(bins)
  const y = new Float64Array(bins)
  const w = vmax / bins
  for (const v of speeds(s)) {
    const b = Math.floor(v / w)
    if (b < bins) y[b]++
  }
  for (let b = 0; b < bins; b++) {
    x[b] = (b + 0.5) * w
    y[b] /= s.n * w
  }
  return { x, y }
}

/** Visit each unordered pair closer than r once. r is capped at half the shortest box side. */
export function forEachPair(s: MdState, r: number, fn: (i: number, j: number, r2: number) => void): void {
  const { dim, n, pos, box } = s
  let half = Infinity
  for (let d = 0; d < dim; d++) half = Math.min(half, box[d] / 2)
  r = Math.min(r, half)
  const r2max = r * r
  const dist2 = (i: number, j: number) => {
    let r2 = 0
    for (let d = 0; d < dim; d++) {
      let dx = pos[i * dim + d] - pos[j * dim + d]
      dx -= box[d] * Math.round(dx / box[d])
      r2 += dx * dx
    }
    return r2
  }
  const grid = makeGrid(dim, box, r, n)
  if (!grid) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const r2 = dist2(i, j)
        if (r2 < r2max) fn(i, j, r2)
      }
    }
    return
  }
  buildCells(grid, dim, pos, box, n)
  const [nx, ny, nz] = grid.nc
  const zr = dim === 3 ? 1 : 0
  for (let i = 0; i < n; i++) {
    const c = grid.cellOf[i]
    const cx = c % nx
    const cy = Math.floor(c / nx) % ny
    const cz = Math.floor(c / (nx * ny))
    for (let oz = -zr; oz <= zr; oz++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cc = ((cx + ox + nx) % nx) + nx * (((cy + oy + ny) % ny) + ny * ((cz + oz + nz) % nz))
          for (let k = grid.start[cc]; k < grid.start[cc + 1]; k++) {
            const j = grid.items[k]
            if (j <= i) continue
            const r2 = dist2(i, j)
            if (r2 < r2max) fn(i, j, r2)
          }
        }
      }
    }
  }
}

/** Add this configuration's pair-distance counts to `counts`; returns the rmax actually used. */
export function rdfCounts(s: MdState, rmax: number, counts: Float64Array): number {
  const bins = counts.length
  let half = Infinity
  for (let d = 0; d < s.dim; d++) half = Math.min(half, s.box[d] / 2)
  const used = Math.min(rmax, half)
  forEachPair(s, used, (_i, _j, r2) => {
    const b = Math.floor((Math.sqrt(r2) / used) * bins)
    if (b < bins) counts[b]++
  })
  return used
}

/** Turn accumulated pair counts into g(r): counts relative to an ideal gas at the same density. */
export function rdfNormalise(
  counts: Float64Array,
  rmax: number,
  n: number,
  vol: number,
  dim: 2 | 3,
  samples = 1,
): Hist {
  const bins = counts.length
  const w = rmax / bins
  const x = new Float64Array(bins)
  const y = new Float64Array(bins)
  for (let b = 0; b < bins; b++) {
    const r0 = b * w
    const r1 = r0 + w
    const shell = dim === 2 ? Math.PI * (r1 * r1 - r0 * r0) : (4 / 3) * Math.PI * (r1 * r1 * r1 - r0 * r0 * r0)
    x[b] = r0 + 0.5 * w
    y[b] = counts[b] / (samples * 0.5 * n * (n / vol) * shell)
  }
  return { x, y }
}

export function rdf(s: MdState, bins: number, rmax: number): Hist {
  const counts = new Float64Array(bins)
  const used = rdfCounts(s, rmax, counts)
  return rdfNormalise(counts, used, s.n, volume(s), s.dim)
}
