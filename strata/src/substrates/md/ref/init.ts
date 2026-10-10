import { gaussian } from '../../../core/rng'
import type { PairEval } from '../potential'
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
function thermalise(s: MdState, temperature: number, seed: number, pair: PairEval): MdState {
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
export function initLattice(o: LatticeInit, pair: PairEval): MdState {
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
 * 2D triangular lattice with nx columns. The row count is the even number that makes the
 * periodic box closest to square, so the lattice is commensurate with the box.
 */
export function initTriangular(
  o: { nx: number; density: number; temperature: number; seed: number },
  pair: PairEval,
): MdState {
  const ny = 2 * Math.round(o.nx / Math.sqrt(3))
  const a = Math.sqrt(2 / (Math.sqrt(3) * o.density))
  const s = createState(2, o.nx * ny, [o.nx * a, (ny * a * Math.sqrt(3)) / 2])
  for (let row = 0; row < ny; row++) {
    for (let col = 0; col < o.nx; col++) {
      const i = row * o.nx + col
      s.pos[2 * i] = (col + 0.25 + 0.5 * (row % 2)) * a
      s.pos[2 * i + 1] = ((row + 0.5) * a * Math.sqrt(3)) / 2
    }
  }
  return thermalise(s, o.temperature, o.seed, pair)
}
