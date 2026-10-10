import { describe, expect, it } from 'vitest'
import {
  accelerations,
  createGravity,
  gravityScalars,
  leapfrog,
  plummerSphere,
  radialCounts,
  uniformSphere,
} from '../../src/substrates/gravity/ref'
import { FREE_FALL_TIME, PLUMMER_HALF_MASS, plummerMass } from '../../src/theory/plummer'

describe('gravity reference', () => {
  it('two bodies on a circular orbit keep the Kepler period', () => {
    // Equal masses 0.5 at separation 1: ω² = G M / d³ = 1, so the period is 2π.
    const s = createGravity(2)
    s.mass.set([0.5, 0.5])
    s.pos.set([-0.5, 0, 0, 0.5, 0, 0])
    s.vel.set([0, -0.5, 0, 0, 0.5, 0])
    accelerations(s, 0)
    const dt = 2e-3
    const orbits = 100
    let crossings = 0
    let lastCrossing = 0
    let prevY = s.pos[4]!
    for (let i = 1; crossings < orbits; i++) {
      leapfrog(s, 0, dt)
      const y = s.pos[4]!
      // Body 1 crosses y = 0 upward once per orbit; interpolate the crossing time.
      if (prevY < 0 && y >= 0) {
        crossings++
        lastCrossing = (i - y / (y - prevY)) * dt
      }
      prevY = y
    }
    expect(Math.abs(lastCrossing / orbits / (2 * Math.PI) - 1)).toBeLessThan(1e-3)
    expect(Math.abs(Math.hypot(s.pos[3]! - s.pos[0]!, s.pos[4]! - s.pos[1]!) - 1)).toBeLessThan(1e-3)
  })

  it('conserves momentum exactly and energy to second order in dt', () => {
    const error = (dt: number) => {
      const s = uniformSphere(200, 0.6, 0.05, 2)
      const e0 = gravityScalars(s)
      leapfrog(s, 0.05, dt, Math.round(1 / dt))
      const e1 = gravityScalars(s)
      expect(e1.momentum).toBeLessThan(1e-14)
      return Math.abs(e1.ke + e1.pe - e0.ke - e0.pe) / Math.abs(e0.pe)
    }
    const coarse = error(0.004)
    const fine = error(0.002)
    expect(coarse).toBeLessThan(1e-3)
    expect(fine).toBeLessThan(coarse / 2.5)
  })

  it('a uniform sphere has U = -3/5 and starts at the requested virial ratio', () => {
    const s = uniformSphere(1500, 0.3, 0.001, 1)
    const sc = gravityScalars(s)
    expect(Math.abs(sc.pe + 0.6)).toBeLessThan(0.02)
    expect(sc.virial).toBeCloseTo(0.3, 10)
    expect(sc.momentum).toBeLessThan(1e-14)
    expect(Math.abs(sc.halfMassRadius - Math.cbrt(0.5))).toBeLessThan(0.03)
  })

  it('a Plummer sphere is sampled with the right mass profile and is in virial equilibrium', () => {
    const s = plummerSphere(3000, 0.01, 5)
    const sc = gravityScalars(s)
    expect(Math.abs(sc.halfMassRadius - PLUMMER_HALF_MASS)).toBeLessThan(0.08)
    expect(Math.abs(sc.virial - 1)).toBeLessThan(0.05)
    // U = -3π/32 for the untruncated, unsoftened model.
    expect(Math.abs(sc.pe + (3 * Math.PI) / 32)).toBeLessThan(0.02)
    const counts = radialCounts(s, 8, 4)
    let inside = 0
    for (let b = 0; b < 8; b++) {
      inside += counts[b]!
      expect(Math.abs(inside / s.n - plummerMass((b + 1) * 0.5))).toBeLessThan(0.03)
    }
  })

  it('a Plummer sphere stays in virial equilibrium', () => {
    const s = plummerSphere(400, 0.03, 6)
    let ratio = 0
    let bound = 0
    const samples = 100
    for (let i = 0; i < samples; i++) {
      leapfrog(s, 0.03, 0.01, 10)
      const sc = gravityScalars(s)
      ratio += sc.virial / samples
      bound += sc.virialBound / samples
    }
    expect(Math.abs(ratio - 1)).toBeLessThan(0.05)
    expect(Math.abs(bound - 1)).toBeLessThan(0.05)
  })

  it('a cold sphere collapses within a free-fall time and then virialises', () => {
    const eps = 0.05
    const s = uniformSphere(500, 0, eps, 7)
    const dt = 0.002
    let minRadius = Infinity
    for (let t = 0; t < 1.3 * FREE_FALL_TIME; t += 20 * dt) {
      leapfrog(s, eps, dt, 20)
      minRadius = Math.min(minRadius, gravityScalars(s).halfMassRadius)
    }
    expect(minRadius).toBeLessThan(0.35)
    leapfrog(s, eps, dt, Math.round((2.7 * FREE_FALL_TIME) / dt))
    let ratio = 0
    let boundRatio = 0
    const samples = 100
    for (let i = 0; i < samples; i++) {
      leapfrog(s, eps, dt, Math.round(FREE_FALL_TIME / dt / samples))
      const sc = gravityScalars(s)
      ratio += sc.virial / samples
      boundRatio += sc.virialBound / samples
    }
    const end = gravityScalars(s)
    console.log(
      `cold collapse, N=500: 2K/|U| all ${ratio.toFixed(3)}, bound 2K/|W| ${boundRatio.toFixed(3)}, bound fraction ${end.boundFraction.toFixed(3)}`,
    )
    // Some bodies are ejected; the virial theorem holds for what stays bound.
    expect(end.boundFraction).toBeGreaterThan(0.7)
    expect(end.boundFraction).toBeLessThan(1)
    expect(Math.abs(boundRatio - 1)).toBeLessThan(0.1)
  })

  it('every body of a cold sphere starts bound', () => {
    const sc = gravityScalars(uniformSphere(300, 0, 0.02, 3))
    expect(sc.boundFraction).toBe(1)
    expect(sc.virialBound).toBe(0)
  })
})
