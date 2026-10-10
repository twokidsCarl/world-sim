import { describe, expect, it } from 'vitest'
import { uniform } from '../../src/core/rng'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initLattice } from '../../src/substrates/md/ref/init'
import {
  computeForces,
  createState,
  kineticEnergy,
  momentum,
  step,
  temperature,
  type MdState,
} from '../../src/substrates/md/ref/step'

const pair = analyticPair(LJ)
const liquid = (dim: 2 | 3, perSide: number) =>
  initLattice({ dim, perSide, density: 0.7, temperature: 1, seed: 7 }, pair)

const energy = (s: MdState) => kineticEnergy(s) + s.pe

/** Total-energy samples after an equilibration run, one per step. */
function energyTrace(dt: number, time: number, equilibrate: number): number[] {
  const s = liquid(2, 20)
  step(s, pair, 0.002, Math.round(equilibrate / 0.002))
  const out: number[] = []
  for (let i = 0; i < Math.round(time / dt); i++) {
    step(s, pair, dt)
    out.push(energy(s))
  }
  return out
}

function std(x: number[]): number {
  const mean = x.reduce((a, b) => a + b, 0) / x.length
  return Math.sqrt(x.reduce((a, b) => a + (b - mean) * (b - mean), 0) / x.length)
}

/** Least-squares slope of x against its index. */
function slope(x: number[]): number {
  const n = x.length
  const mi = (n - 1) / 2
  const mx = x.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - mi) * (x[i]! - mx)
    den += (i - mi) * (i - mi)
  }
  return num / den
}

describe('MD reference: micro level', () => {
  it('initialises at the requested temperature with zero net momentum', () => {
    const s = liquid(2, 20)
    expect(s.n).toBe(400)
    expect(temperature(s)).toBeCloseTo(1, 12)
    for (const p of momentum(s)) expect(Math.abs(p)).toBeLessThan(1e-12)
  })

  it.each([2, 3] as const)('cell-list forces equal all-pairs forces in %iD', (dim) => {
    const n = dim === 2 ? 300 : 500
    const L = dim === 2 ? 20 : 9
    const a = createState(dim, n, [L, L, L])
    // Jittered lattice: random enough to exercise every stencil cell, without overlaps.
    const side = Math.ceil(Math.pow(n, 1 / dim))
    for (let i = 0; i < n; i++) {
      let rem = i
      for (let d = 0; d < dim; d++) {
        a.pos[i * dim + d] = ((rem % side) + 0.5 + 0.3 * (uniform(3, i * dim + d) - 0.5)) * (L / side)
        rem = Math.floor(rem / side)
      }
    }
    const b = createState(dim, n, [L, L, L])
    b.pos.set(a.pos)
    computeForces(a, pair)
    computeForces(b, pair, true)
    expect(a.grid).not.toBeNull()
    expect(a.pe).toBeCloseTo(b.pe, 9)
    expect(a.virial).toBeCloseTo(b.virial, 8)
    let fmax = 0
    for (let k = 0; k < n * dim; k++) {
      expect(Math.abs(a.force[k]! - b.force[k]!)).toBeLessThan(1e-10)
      fmax = Math.max(fmax, Math.abs(b.force[k]!))
    }
    expect(fmax).toBeGreaterThan(0.1)
  })

  it('conserves momentum', () => {
    const s = liquid(2, 20)
    step(s, pair, 0.005, 2000)
    for (const p of momentum(s)) expect(Math.abs(p)).toBeLessThan(1e-11)
  })

  it('is time-reversible: 200 steps forward then back returns to the start', () => {
    const s = liquid(2, 20)
    step(s, pair, 0.005, 500)
    const pos0 = s.pos.slice()
    const vel0 = s.vel.slice()
    step(s, pair, 0.005, 200)
    for (let k = 0; k < s.vel.length; k++) s.vel[k] = -s.vel[k]!
    step(s, pair, 0.005, 200)
    for (let k = 0; k < pos0.length; k++) {
      expect(Math.abs(s.pos[k]! - pos0[k]!)).toBeLessThan(1e-8)
      expect(Math.abs(s.vel[k]! + vel0[k]!)).toBeLessThan(1e-8)
    }
  })

  it('energy fluctuation scales as dt^2 (velocity Verlet is second order)', () => {
    const coarse = std(energyTrace(0.004, 4, 5))
    const fine = std(energyTrace(0.002, 4, 5))
    expect(coarse / fine).toBeGreaterThan(3.5)
    expect(coarse / fine).toBeLessThan(4.5)
  })

  it('has no secular energy drift at dt = 0.005', () => {
    const trace = energyTrace(0.005, 50, 5)
    expect(trace.length).toBe(10000)
    const drift = Math.abs(slope(trace) * trace.length)
    expect(drift / Math.abs(trace[0]!)).toBeLessThan(1e-5)
  })

  it('3D runs and conserves energy too', () => {
    const s = liquid(3, 6)
    step(s, pair, 0.002, 500)
    const e0 = energy(s)
    step(s, pair, 0.002, 1000)
    expect(Math.abs(energy(s) - e0) / Math.abs(e0)).toBeLessThan(1e-4)
  })
})
