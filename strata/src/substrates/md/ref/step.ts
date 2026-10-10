// CPU reference molecular dynamics in f64. This is the specification the GPU kernels
// are checked against. Reduced units, unit mass, periodic box, dimension 2 or 3.

import type { PairEval, PairOut } from '../potential'
import { buildCells, makeGrid, type CellGrid } from './cells'

export interface MdState {
  dim: 2 | 3
  n: number
  /** Box lengths, length 3; unused axes are 1. */
  box: Float64Array
  /** n * dim, wrapped into [0, box). */
  pos: Float64Array
  vel: Float64Array
  force: Float64Array
  /** Total potential energy for the current positions. */
  pe: number
  /** Sum over pairs of r · f, for the virial pressure. */
  virial: number
  step: number
  grid: CellGrid | null
}

export function createState(dim: 2 | 3, n: number, box: ArrayLike<number>): MdState {
  const b = new Float64Array([1, 1, 1])
  for (let d = 0; d < dim; d++) b[d] = box[d]
  return {
    dim,
    n,
    box: b,
    pos: new Float64Array(n * dim),
    vel: new Float64Array(n * dim),
    force: new Float64Array(n * dim),
    pe: 0,
    virial: 0,
    step: 0,
    grid: null,
  }
}

const out: PairOut = { g: 0, u: 0 }

/** Recompute forces, potential energy and virial. Each particle scans the full 3^dim stencil. */
export function computeForces(s: MdState, pair: PairEval, allPairs = false): void {
  const { dim, n, pos, force, box } = s
  const bx = box[0]
  const by = box[1]
  const bz = box[2]
  const rc2 = pair.rc2
  force.fill(0)
  let pe = 0
  let virial = 0

  const rc = Math.sqrt(rc2)
  if (!allPairs && (!s.grid || s.grid.rc !== rc)) s.grid = makeGrid(dim, box, rc, n)
  const grid = allPairs ? null : s.grid

  if (!grid) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i * dim] - pos[j * dim]
        let dy = pos[i * dim + 1] - pos[j * dim + 1]
        let dz = dim === 3 ? pos[i * dim + 2] - pos[j * dim + 2] : 0
        dx -= bx * Math.round(dx / bx)
        dy -= by * Math.round(dy / by)
        dz -= bz * Math.round(dz / bz)
        const r2 = dx * dx + dy * dy + dz * dz
        if (r2 >= rc2) continue
        pair.eval(r2, out)
        force[i * dim] += out.g * dx
        force[i * dim + 1] += out.g * dy
        force[j * dim] -= out.g * dx
        force[j * dim + 1] -= out.g * dy
        if (dim === 3) {
          force[i * dim + 2] += out.g * dz
          force[j * dim + 2] -= out.g * dz
        }
        pe += out.u
        virial += out.g * r2
      }
    }
  } else {
    buildCells(grid, dim, pos, box, n)
    const [nx, ny, nz] = grid.nc
    const { start, items, cellOf } = grid
    const zr = dim === 3 ? 1 : 0
    for (let i = 0; i < n; i++) {
      const c = cellOf[i]
      const cx = c % nx
      const cy = Math.floor(c / nx) % ny
      const cz = Math.floor(c / (nx * ny))
      const xi = pos[i * dim]
      const yi = pos[i * dim + 1]
      const zi = dim === 3 ? pos[i * dim + 2] : 0
      let fx = 0
      let fy = 0
      let fz = 0
      for (let oz = -zr; oz <= zr; oz++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const cc = ((cx + ox + nx) % nx) + nx * (((cy + oy + ny) % ny) + ny * ((cz + oz + nz) % nz))
            for (let k = start[cc]; k < start[cc + 1]; k++) {
              const j = items[k]
              if (j === i) continue
              let dx = xi - pos[j * dim]
              let dy = yi - pos[j * dim + 1]
              let dz = dim === 3 ? zi - pos[j * dim + 2] : 0
              dx -= bx * Math.round(dx / bx)
              dy -= by * Math.round(dy / by)
              dz -= bz * Math.round(dz / bz)
              const r2 = dx * dx + dy * dy + dz * dz
              if (r2 >= rc2) continue
              pair.eval(r2, out)
              fx += out.g * dx
              fy += out.g * dy
              fz += out.g * dz
              pe += 0.5 * out.u
              virial += 0.5 * out.g * r2
            }
          }
        }
      }
      force[i * dim] = fx
      force[i * dim + 1] = fy
      if (dim === 3) force[i * dim + 2] = fz
    }
  }
  s.pe = pe
  s.virial = virial
}

/** Velocity Verlet. Forces must be current on entry and are current on exit. */
export function step(s: MdState, pair: PairEval, dt: number, nSteps = 1): void {
  const { dim, n, pos, vel, force, box } = s
  const len = n * dim
  const half = 0.5 * dt
  for (let it = 0; it < nSteps; it++) {
    for (let k = 0; k < len; k++) {
      vel[k] += half * force[k]
      const L = box[k % dim]
      const x = pos[k] + dt * vel[k]
      pos[k] = x - L * Math.floor(x / L)
    }
    computeForces(s, pair)
    for (let k = 0; k < len; k++) vel[k] += half * force[k]
    s.step++
  }
}

export function kineticEnergy(s: MdState): number {
  let ke = 0
  for (let k = 0; k < s.n * s.dim; k++) ke += s.vel[k] * s.vel[k]
  return 0.5 * ke
}

/** Kinetic temperature, with the dim centre-of-mass degrees of freedom removed. */
export function temperature(s: MdState): number {
  return (2 * kineticEnergy(s)) / (s.dim * (s.n - 1))
}

export function momentum(s: MdState): number[] {
  const p = new Array<number>(s.dim).fill(0)
  for (let k = 0; k < s.n * s.dim; k++) p[k % s.dim] += s.vel[k]
  return p
}

export function volume(s: MdState): number {
  return s.box[0] * s.box[1] * s.box[2]
}

/** Virial pressure P = (N T + W / dim) / V. */
export function pressure(s: MdState): number {
  return (s.n * temperature(s) + s.virial / s.dim) / volume(s)
}
