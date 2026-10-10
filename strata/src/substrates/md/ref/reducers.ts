// Reductions of the micro state to the small summaries the levels are built from.
// On the GPU these become compute passes whose output is read back.

import { buildCells, makeGrid } from './cells'
import { kineticEnergy, momentum, pressure, temperature, volume, type MdState } from './step'

/** Cells per axis of the coarse-grained fields. */
export const FIELD_G = 48

/** Per-cell sums over the particles in each cell of a g × g grid, row-major with y as the row. */
export interface FieldSums {
  g: number
  count: Float64Array
  vx: Float64Array
  vy: Float64Array
  /** Σ |v|² */
  v2: Float64Array
}

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
  /** Mean of |ψ6| over particles: local hexatic order, insensitive to grain orientation. */
  psi6Local: number
  /** |mean of ψ6|: hexatic order coherent across the whole box. */
  psi6Global: number
  /** Fraction of particles that are species B. */
  fractionB: number
  /**
   * Demixing order parameter: 1 - (fraction of unlike neighbour bonds) / (2 xA xB).
   * 0 for a random mixture, approaching 1 as the species separate; 0 for one component.
   */
  demix: number
}

/** Neighbours for the hexatic order parameter lie within this distance. */
export const PSI_RADIUS = 1.5

export interface Hist {
  /** Bin centres. */
  x: Float64Array
  y: Float64Array
}

/**
 * Hexatic bond-orientational order per particle (2D): ψ6 = Σ exp(6 i θ) / max(n, 6) over
 * the n neighbours within PSI_RADIUS. Dividing by at least 6 keeps an isolated pair or a
 * surface particle from counting as perfectly ordered. Returns interleaved (Re, Im).
 */
export function psi6(s: MdState): Float64Array {
  const out = new Float64Array(2 * s.n)
  const count = new Float64Array(s.n)
  const { pos, box, dim } = s
  forEachPair(s, PSI_RADIUS, (i, j) => {
    let dx = pos[i * dim] - pos[j * dim]
    let dy = pos[i * dim + 1] - pos[j * dim + 1]
    dx -= box[0] * Math.round(dx / box[0])
    if (!s.walls) dy -= box[1] * Math.round(dy / box[1])
    // exp(6 i θ) is the same for the bond seen from either end.
    const theta = 6 * Math.atan2(dy, dx)
    const re = Math.cos(theta)
    const im = Math.sin(theta)
    out[2 * i] += re
    out[2 * i + 1] += im
    out[2 * j] += re
    out[2 * j + 1] += im
    count[i]++
    count[j]++
  })
  for (let i = 0; i < s.n; i++) {
    const norm = Math.max(count[i], 6)
    out[2 * i] /= norm
    out[2 * i + 1] /= norm
  }
  return out
}

/** Neighbour bonds within PSI_RADIUS: total, and those joining different species. */
export function bondCounts(s: MdState): { total: number; unlike: number } {
  let total = 0
  let unlike = 0
  forEachPair(s, PSI_RADIUS, (i, j) => {
    total++
    if (s.species[i] !== s.species[j]) unlike++
  })
  return { total, unlike }
}

export function demixing(fractionB: number, bonds: { total: number; unlike: number }): number {
  const random = 2 * fractionB * (1 - fractionB)
  if (random === 0 || bonds.total === 0) return 0
  return 1 - bonds.unlike / bonds.total / random
}

export function scalars(s: MdState): MdScalars {
  const p = momentum(s)
  let psiRe = 0
  let psiIm = 0
  let psiAbs = 0
  if (s.dim === 2) {
    const psi = psi6(s)
    for (let i = 0; i < s.n; i++) {
      psiRe += psi[2 * i]
      psiIm += psi[2 * i + 1]
      psiAbs += Math.hypot(psi[2 * i], psi[2 * i + 1])
    }
  }
  let nB = 0
  for (let i = 0; i < s.n; i++) nB += s.species[i]
  const fractionB = nB / s.n
  return {
    n: s.n,
    dim: s.dim,
    ke: kineticEnergy(s),
    pe: s.pe,
    density: s.n / volume(s),
    temperature: temperature(s),
    pressure: pressure(s),
    momentum: Math.hypot(...p) / s.n,
    psi6Local: psiAbs / s.n,
    psi6Global: Math.hypot(psiRe, psiIm) / s.n,
    fractionB,
    demix: nB > 0 ? demixing(fractionB, bondCounts(s)) : 0,
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
      if (!(s.walls && d === 1)) dx -= box[d] * Math.round(dx / box[d])
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

/**
 * Coarse-grain the particles onto a grid with a top-hat kernel: the simplest case of the
 * Irving–Kirkwood/Hardy construction, in which mass and momentum of the fields equal
 * those of the particles exactly.
 */
export function fieldSums(s: MdState, g = FIELD_G): FieldSums {
  const out: FieldSums = {
    g,
    count: new Float64Array(g * g),
    vx: new Float64Array(g * g),
    vy: new Float64Array(g * g),
    v2: new Float64Array(g * g),
  }
  const { dim, pos, vel, box } = s
  for (let i = 0; i < s.n; i++) {
    const cx = Math.min(g - 1, Math.floor((pos[i * dim] / box[0]) * g))
    const cy = Math.min(g - 1, Math.floor((pos[i * dim + 1] / box[1]) * g))
    const c = cy * g + cx
    const vx = vel[i * dim]
    const vy = vel[i * dim + 1]
    out.count[c]++
    out.vx[c] += vx
    out.vy[c] += vy
    out.v2[c] += vx * vx + vy * vy
  }
  return out
}

/** Profiles across y (averaged over x): number density, flow velocity u_x, and temperature. */
export function profiles(
  f: FieldSums,
  box: ArrayLike<number>,
  bins = 24,
): { y: Float64Array; density: Float64Array; ux: Float64Array; temperature: Float64Array } {
  const per = f.g / bins
  const y = new Float64Array(bins)
  const density = new Float64Array(bins)
  const ux = new Float64Array(bins)
  const temperature = new Float64Array(bins)
  for (let b = 0; b < bins; b++) {
    let n = 0
    let px = 0
    let py = 0
    let v2 = 0
    for (let row = b * per; row < (b + 1) * per; row++) {
      for (let cx = 0; cx < f.g; cx++) {
        const c = row * f.g + cx
        n += f.count[c]
        px += f.vx[c]
        py += f.vy[c]
        v2 += f.v2[c]
      }
    }
    y[b] = (b + 0.5) / bins
    density[b] = n / ((box[0]! * box[1]!) / bins)
    ux[b] = n > 0 ? px / n : 0
    // Kinetic temperature of the motion relative to the local mean flow, in 2D.
    temperature[b] = n > 1 ? (v2 - (px * px + py * py) / n) / (2 * n) : 0
  }
  return { y, density, ux, temperature }
}
