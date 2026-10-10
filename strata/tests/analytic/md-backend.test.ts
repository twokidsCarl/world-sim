import { describe, expect, it } from 'vitest'
import { defaults } from '../../src/core/params'
import { MdCpuBackend } from '../../src/substrates/md/backend-cpu'
import { MD_KNOBS } from '../../src/substrates/md/schema'

const base = { ...defaults(MD_KNOBS), nx: 20, density: 0.6 }
const scalarsOf = (b: MdCpuBackend) => b.reduce(['scalars'])

describe('MD CPU backend', () => {
  it('starts at the requested state point', () => {
    const f = scalarsOf(new MdCpuBackend({ ...base, temperature: 0.8 }, 1))
    expect(f.scalars!.temperature).toBeCloseTo(0.8, 12)
    expect(f.scalars!.density).toBeCloseTo(0.6, 12)
    expect(f.drift).toBe(0)
  })

  it('the thermostat brings the system to the bath temperature', () => {
    const b = new MdCpuBackend({ ...base, temperature: 1 }, 1)
    b.setParams({ ...base, thermostat: 1, temperature: 0.5 })
    b.step(3000)
    let T = 0
    for (let i = 0; i < 200; i++) {
      b.step(5)
      T += scalarsOf(b).scalars!.temperature / 200
    }
    expect(Math.abs(T - 0.5)).toBeLessThan(0.02)
  })

  it('energy minus exchanged heat is conserved under the thermostat, with error of order dt²', () => {
    const run = (dt: number) => {
      const b = new MdCpuBackend({ ...base, temperature: 1, dt }, 1)
      b.step(Math.round(2 / dt))
      b.setParams({ ...base, dt, thermostat: 1, temperature: 0.5 })
      b.step(Math.round(10 / dt))
      return Math.abs(scalarsOf(b).drift)
    }
    const coarse = run(0.004)
    const fine = run(0.002)
    expect(coarse).toBeLessThan(2e-3)
    expect(fine).toBeLessThan(coarse / 2.5)
  })

  it('without a bath, changing the temperature rescales velocities once and rebases the meter', () => {
    const b = new MdCpuBackend({ ...base, temperature: 1 }, 1)
    b.step(200)
    b.setParams({ ...base, temperature: 2 })
    const f = scalarsOf(b)
    expect(f.scalars!.temperature).toBeCloseTo(2, 10)
    expect(f.drift).toBe(0)
  })

  it('changing the potential recomputes forces and rebases the meter', () => {
    const b = new MdCpuBackend(base, 1)
    b.step(100)
    const before = scalarsOf(b).scalars!.pe
    b.setParams({ ...base, kind: 2 })
    const f = scalarsOf(b)
    expect(f.spec.kind).toBe('soft')
    expect(f.scalars!.pe).not.toBeCloseTo(before, 3)
    expect(f.drift).toBe(0)
    b.step(500)
    expect(Math.abs(scalarsOf(b).drift)).toBeLessThan(1e-3)
  })

  it('reducers are only filled in when requested', () => {
    const b = new MdCpuBackend(base, 1)
    const f = b.reduce(['rdf'])
    expect(f.rdf).toBeDefined()
    expect(f.scalars).toBeUndefined()
    expect(f.speedHist).toBeUndefined()
  })
})
