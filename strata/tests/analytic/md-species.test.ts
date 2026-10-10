import { describe, expect, it } from 'vitest'
import { defaults, type Params } from '../../src/core/params'
import { MdCpuBackend } from '../../src/substrates/md/backend-cpu'
import { LJ, speciesField, speciesTables } from '../../src/substrates/md/potential'
import { initTriangular } from '../../src/substrates/md/ref/init'
import { bondCounts, demixing, scalars } from '../../src/substrates/md/ref/reducers'
import { computeForces, createState, kineticEnergy, momentum, step } from '../../src/substrates/md/ref/step'
import { MD_KNOBS, strengthMatrix } from '../../src/substrates/md/schema'

const mix = (p: Partial<Params> = {}): Params => ({
  ...defaults(MD_KNOBS),
  nx: 24,
  density: 0.7,
  temperature: 1,
  fractionB: 0.5,
  ...p,
})
const fieldOf = (p: Params) => speciesField(speciesTables(LJ, strengthMatrix(p)))
const start = (p: Params) =>
  initTriangular({ nx: p.nx!, density: p.density!, temperature: p.temperature!, seed: 4, fractionB: p.fractionB }, fieldOf(p))

describe('two species', () => {
  it('the strength matrix is symmetric unless reciprocity is broken', () => {
    const m = strengthMatrix(mix({ epsAB: 0.4, epsBB: 1.5 }))
    expect(m).toEqual([
      [1, 0.4],
      [0.4, 1.5],
    ])
    const broken = strengthMatrix(mix({ epsAB: 0.4, nonreciprocal: 0.5 }))
    expect(broken[0]![1]).toBeCloseTo(0.6, 12)
    expect(broken[1]![0]).toBeCloseTo(0.2, 12)
    expect(strengthMatrix(mix({ fractionB: 0 }))).toEqual([[1]])
  })

  it('species are assigned at the requested fraction and start as a random mixture', () => {
    const s = start(mix({ nx: 60, fractionB: 0.3 }))
    const sc = scalars(s)
    expect(Math.abs(sc.fractionB - 0.3)).toBeLessThan(0.02)
    expect(Math.abs(sc.demix)).toBeLessThan(0.05)
  })

  it('cell-list and all-pairs forces agree for a mixture, reciprocal or not', () => {
    for (const nonreciprocal of [0, 0.5]) {
      const p = mix({ epsAB: 0.4, epsBB: 1.5, nonreciprocal })
      const field = fieldOf(p)
      const a = start(p)
      step(a, field, 0.004, 50)
      const b = createState(2, a.n, a.box)
      b.pos.set(a.pos)
      b.species.set(a.species)
      computeForces(b, field, true)
      for (let k = 0; k < a.force.length; k++) expect(Math.abs(a.force[k]! - b.force[k]!)).toBeLessThan(1e-9)
      expect(a.pe).toBeCloseTo(b.pe, 8)
    }
  })

  it('a symmetric matrix conserves momentum, and energy up to an error of order dt²', () => {
    const p = mix({ epsAB: 0.4, epsBB: 1.5 })
    const field = fieldOf(p)
    // RMS deviation of the total energy from its mean over the same physical time.
    const fluctuation = (dt: number) => {
      const s = start(p)
      step(s, field, 0.002, 600)
      const e: number[] = []
      for (let i = 0; i < Math.round(4 / dt); i++) {
        step(s, field, dt)
        e.push(kineticEnergy(s) + s.pe)
      }
      for (const c of momentum(s)) expect(Math.abs(c)).toBeLessThan(1e-12 * s.n)
      const mean = e.reduce((a, b) => a + b, 0) / e.length
      return Math.sqrt(e.reduce((a, b) => a + (b - mean) ** 2, 0) / e.length) / s.n
    }
    const coarse = fluctuation(0.004)
    const fine = fluctuation(0.002)
    expect(coarse).toBeLessThan(1e-3)
    expect(coarse / fine).toBeGreaterThan(3)
    expect(coarse / fine).toBeLessThan(5)
  })

  it('breaking reciprocity violates momentum conservation', () => {
    const p = mix({ epsAB: 1, nonreciprocal: 0.5 })
    const field = fieldOf(p)
    const s = start(p)
    step(s, field, 0.004, 2000)
    expect(Math.hypot(...momentum(s)) / s.n).toBeGreaterThan(1e-3)
  })

  it('weak unlike attraction makes a cooled mixture demix', () => {
    const b = new MdCpuBackend(mix({ nx: 30, density: 0.6, temperature: 0.6, thermostat: 1, epsAB: 0.1 }), 4)
    b.step(6000)
    expect(b.reduce(['scalars']).scalars!.demix).toBeGreaterThan(0.4)
  })

  it('demixing is 0 for a random mixture and 1 with no unlike bonds', () => {
    expect(demixing(0.5, { total: 100, unlike: 50 })).toBeCloseTo(0, 12)
    expect(demixing(0.5, { total: 100, unlike: 0 })).toBe(1)
    expect(demixing(0, { total: 100, unlike: 0 })).toBe(0)
    const s = createState(2, 3, [20, 20])
    s.pos.set([5, 5, 6, 5, 5.5, 5.9])
    s.species.set([0, 0, 1])
    expect(bondCounts(s)).toEqual({ total: 3, unlike: 2 })
  })
})
