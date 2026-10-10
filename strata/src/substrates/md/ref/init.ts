import { gaussian, uniform } from '../../../core/rng'
import type { PairField } from '../potential'
import { computeForces, createState, kineticEnergy, type MdState } from './step'

export interface LatticeInit {
  dim: 2 | 3
  /** Particles per axis; n = perSide^dim. */
  perSide: number
  /** Number density n / V. */
  density: number
  temperature: number
  seed: number
}

/** Gaussian velocities with zero net momentum, rescaled to the exact temperature; then forces. */
function thermalise(s: MdState, temperature: number, seed: number, pair: PairField): MdState {
  const { dim, n } = s
  for (let k = 0; k < n * dim; k++) s.vel[k] = gaussian(seed, k)
  for (let d = 0; d < dim; d++) {
    let p = 0
    for (let i = 0; i < n; i++) p += s.vel[i * dim + d]
    for (let i = 0; i < n; i++) s.vel[i * dim + d] -= p / n
  }
  const target = 0.5 * dim * (n - 1) * temperature
  const scale = Math.sqrt(target / kineticEnergy(s))
  for (let k = 0; k < n * dim; k++) s.vel[k] *= scale
  computeForces(s, pair)
  return s
}

/** Square/cubic lattice. */
export function initLattice(o: LatticeInit, pair: PairField): MdState {
  const { dim, perSide } = o
  const n = Math.pow(perSide, dim)
  const L = Math.pow(n / o.density, 1 / dim)
  const s = createState(dim, n, [L, L, L])
  const a = L / perSide
  for (let i = 0; i < n; i++) {
    let rem = i
    for (let d = 0; d < dim; d++) {
      s.pos[i * dim + d] = ((rem % perSide) + 0.5) * a
      rem = Math.floor(rem / perSide)
    }
  }
  return thermalise(s, o.temperature, o.seed, pair)
}

/**
 * 2D triangular lattice with nx columns. The row count is the even number that brings the
 * periodic box closest to the requested aspect ratio (square by default), so the lattice
 * is commensurate with the box.
 */
export function initTriangular(
  o: {
    nx: number
    density: number
    temperature: number
    seed: number
    fractionB?: number
    aspect?: number
    /** Put species B in a band across the middle of the box instead of mixing it at random. */
    stripe?: boolean
  },
  pair: PairField,
): MdState {
  // `aspect` is the box's width over its height.
  const ny = Math.max(2, 2 * Math.round(o.nx / Math.sqrt(3) / (o.aspect ?? 1)))
  const a = Math.sqrt(2 / (Math.sqrt(3) * o.density))
  const s = createState(2, o.nx * ny, [o.nx * a, (ny * a * Math.sqrt(3)) / 2])
  for (let row = 0; row < ny; row++) {
    for (let col = 0; col < o.nx; col++) {
      const i = row * o.nx + col
      s.pos[2 * i] = (col + 0.25 + 0.5 * (row % 2)) * a
      s.pos[2 * i + 1] = ((row + 0.5) * a * Math.sqrt(3)) / 2
      const fractionB = o.fractionB ?? 0
      // Either a band across the middle, or independently at random (an ideal mixture).
      s.species[i] = (o.stripe ? Math.abs((row + 0.5) / ny - 0.5) < fractionB / 2 : uniform(o.seed ^ 0x51ec1e5, i) < fractionB) ? 1 : 0
    }
  }
  return thermalise(s, o.temperature, o.seed, pair)
}

/**
 * 3D face-centred cubic lattice of `cells` conventional cells per side (4 particles each)
 * in a cubic periodic box.
 */
export function initFcc(
  o: { cells: number; density: number; temperature: number; seed: number; fractionB?: number },
  pair: PairField,
): MdState {
  const n = 4 * o.cells ** 3
  const L = Math.cbrt(n / o.density)
  const a = L / o.cells
  const s = createState(3, n, [L, L, L])
  const basis = [
    [0, 0, 0],
    [0.5, 0.5, 0],
    [0.5, 0, 0.5],
    [0, 0.5, 0.5],
  ]
  let i = 0
  for (let z = 0; z < o.cells; z++) {
    for (let y = 0; y < o.cells; y++) {
      for (let x = 0; x < o.cells; x++) {
        for (const b of basis) {
          s.pos[3 * i] = (x + b[0]! + 0.25) * a
          s.pos[3 * i + 1] = (y + b[1]! + 0.25) * a
          s.pos[3 * i + 2] = (z + b[2]! + 0.25) * a
          s.species[i] = uniform(o.seed ^ 0x51ec1e5, i) < (o.fractionB ?? 0) ? 1 : 0
          i++
        }
      }
    }
  }
  return thermalise(s, o.temperature, o.seed, pair)
}
