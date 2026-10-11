import { describe, expect, it } from 'vitest'
import { LJ } from '../../src/substrates/md/potential'
import { erf, speedCdf, speedPdf } from '../../src/theory/maxwell'
import { secondVirial } from '../../src/theory/virial'

describe('Maxwell–Boltzmann', () => {
  it.each([2, 3] as const)('%iD pdf integrates to 1 and to the cdf', (dim) => {
    const T = 0.7
    const h = 1e-3
    let sum = 0
    for (let v = h / 2; v < 12; v += h) {
      sum += speedPdf(dim, T, v) * h
      if (Math.abs(v - 1.0005) < 1e-9) expect(sum).toBeCloseTo(speedCdf(dim, T, 1.001), 5)
    }
    expect(sum).toBeCloseTo(1, 6)
  })

  it.each([2, 3] as const)('%iD mean square speed is dim * T', (dim) => {
    const T = 1.3
    const h = 1e-3
    let v2 = 0
    for (let v = h / 2; v < 20; v += h) v2 += v * v * speedPdf(dim, T, v) * h
    expect(v2).toBeCloseTo(dim * T, 5)
  })

  it('erf matches reference values', () => {
    expect(erf(0.5)).toBeCloseTo(0.5204998778, 6)
    expect(erf(1)).toBeCloseTo(0.8427007929, 6)
    expect(erf(-2)).toBeCloseTo(-0.995322265, 6)
  })
})

describe('second virial coefficient', () => {
  // 截断半径很长时力移位可以忽略，完整三维 Lennard-Jones 势的
  // 教科书数值适用。
  // With a very long cutoff the force shift is negligible and the textbook values for
  // the full 3D Lennard-Jones potential apply.
  const full = { ...LJ, rc: 30 }

  it('3D Lennard-Jones: B2 vanishes at the Boyle temperature T* = 3.418', () => {
    expect(Math.abs(secondVirial(full, 3.418, 3, 40000))).toBeLessThan(5e-3)
  })

  it('3D Lennard-Jones: B2(T* = 1) = -2.538 in units of 2πσ³/3', () => {
    expect(secondVirial(full, 1, 3, 40000) / ((2 * Math.PI) / 3)).toBeCloseTo(-2.538, 2)
  })

  it('hard-core limit: a steep repulsive potential approaches the hard-disk value πσ²/2', () => {
    const b2 = secondVirial({ kind: 'soft', epsilon: 1, sigma: 1, n: 200, rc: 1.5 }, 1, 2, 40000)
    expect(b2 / (Math.PI / 2)).toBeGreaterThan(0.98)
    expect(b2 / (Math.PI / 2)).toBeLessThan(1.02)
  })

  it('is converged in the number of intervals', () => {
    expect(secondVirial(LJ, 1.5, 2, 4000)).toBeCloseTo(secondVirial(LJ, 1.5, 2, 32000), 6)
  })
})
