import { describe, expect, it } from 'vitest'
import { defaults } from '../../src/core/params'
import { MdCpuBackend } from '../../src/substrates/md/backend-cpu'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initFcc } from '../../src/substrates/md/ref/init'
import { coordination, rdf, scalars } from '../../src/substrates/md/ref/reducers'
import { kineticEnergy, step, temperature, volume } from '../../src/substrates/md/ref/step'
import { MD_KNOBS, fccCells } from '../../src/substrates/md/schema'

const pair = analyticPair(LJ)

describe('3D molecular dynamics', () => {
  it('fcc lattice has the requested density, 12 nearest neighbours and the right shells', () => {
    const density = 1.0
    const s = initFcc({ cells: 5, density, temperature: 0, seed: 1 }, pair)
    expect(s.n).toBe(500)
    expect(s.n / volume(s)).toBeCloseTo(density, 12)
    expect(coordination(s)).toBe(12)
    // 最近邻距离为 a/√2，其中 a = (4/ρ)^(1/3)；第二壳层在 a 处。
    // Nearest-neighbour distance a/√2 with a = (4/ρ)^(1/3); the second shell is at a.
    const a = Math.cbrt(4 / density)
    const g = rdf(s, 400, 2)
    const w = 2 / 400
    const occupied = [...g.y.keys()].filter((b) => g.y[b]! > 0)
    expect(Math.abs((occupied[0]! + 0.5) * w - a / Math.SQRT2)).toBeLessThan(2 * w)
    expect(occupied.some((b) => Math.abs((b + 0.5) * w - a) < 2 * w)).toBe(true)
  })

  it('conserves energy to second order in dt', () => {
    const fluctuation = (dt: number) => {
      const s = initFcc({ cells: 4, density: 0.7, temperature: 1.5, seed: 2 }, pair)
      step(s, pair, 0.002, 500)
      const e: number[] = []
      for (let i = 0; i < Math.round(2 / dt); i++) {
        step(s, pair, dt)
        e.push(kineticEnergy(s) + s.pe)
      }
      const mean = e.reduce((p, c) => p + c, 0) / e.length
      return Math.sqrt(e.reduce((p, c) => p + (c - mean) ** 2, 0) / e.length) / s.n
    }
    const coarse = fluctuation(0.004)
    const fine = fluctuation(0.002)
    expect(coarse).toBeLessThan(1e-3)
    expect(coarse / fine).toBeGreaterThan(3)
    expect(coarse / fine).toBeLessThan(5)
  })

  it('a hot crystal melts: the first shell is no longer 12 distinct neighbours', () => {
    const s = initFcc({ cells: 5, density: 0.8, temperature: 2.5, seed: 3 }, pair)
    step(s, pair, 0.004, 1500)
    expect(temperature(s)).toBeGreaterThan(1)
    expect(coordination(s)).toBeLessThan(11)
    expect(scalars(s).psi6Local).toBe(0)
  })

  it('the backend builds a 3D system from the dimension knob', () => {
    const b = new MdCpuBackend({ ...defaults(MD_KNOBS), dim: 3, nx: 16, density: 0.9, temperature: 0.2, walls: 1 }, 1)
    expect(b.dim).toBe(3)
    expect(b.n).toBe(4 * fccCells(16) ** 3)
    expect(b.state.walls).toBe(false)
    b.step(50)
    const f = b.reduce(['scalars', 'rdf', 'speedHist', 'field'])
    expect(f.scalars!.dim).toBe(3)
    expect(f.scalars!.coordination).toBeGreaterThan(11.5)
    expect(f.field!.count.reduce((a, c) => a + c, 0)).toBe(b.n)
  })
})
