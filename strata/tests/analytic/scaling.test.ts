import { describe, expect, it } from 'vitest'
import { unitSystem } from '../../src/theory/scaling'

describe('constants to reduced units', () => {
  it('reproduces argon at the real constants', () => {
    const u = unitSystem()
    expect(u.sigma).toBeCloseTo(3.405e-10, 15)
    expect(u.kelvin).toBeCloseTo(119.8, 6)
    expect(u.tau * 1e12).toBeCloseTo(2.156, 2)
    expect(u.deBoer).toBeCloseTo(0.186, 3)
    expect(u.speed).toBeCloseTo(157.9, 0)
  })

  it('doubling alpha halves lengths and quadruples energies', () => {
    const a = unitSystem()
    const b = unitSystem(2)
    expect(b.sigma / a.sigma).toBeCloseTo(0.5, 12)
    expect(b.kelvin / a.kelvin).toBeCloseTo(4, 12)
    expect(b.tau / a.tau).toBeCloseTo(0.25, 12)
    expect(b.mass).toBe(a.mass)
  })

  it('the de Boer parameter depends on the mass ratio only, as its square root', () => {
    expect(unitSystem(3).deBoer).toBeCloseTo(unitSystem().deBoer, 12)
    expect(unitSystem(1, 4).deBoer / unitSystem().deBoer).toBeCloseTo(2, 12)
    expect(unitSystem(1, 4).mass / unitSystem().mass).toBeCloseTo(0.25, 12)
  })
})
