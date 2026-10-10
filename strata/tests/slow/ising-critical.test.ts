import { describe, expect, it } from 'vitest'
import { binderCumulant, createIsing, latticeSums, wolffStep } from '../../src/substrates/ising/ref'
import { BINDER_CRITICAL, ISING_TC, onsagerMagnetisation } from '../../src/theory/onsager'

/** Equilibrium averages by Wolff cluster updates. */
function measure(L: number, T: number, j2: number, samples: number, seed = 1) {
  const s = createIsing(L, seed, true)
  const rng = { seed: seed * 7919 + L, counter: 0 }
  // Thermalise, measuring the mean cluster size on the way.
  let flipped = 0
  const warmup = 400 + 4 * L
  for (let i = 0; i < warmup; i++) flipped += wolffStep(s, T, j2, rng)
  // A fixed number of cluster flips between samples, enough to turn over about one
  // lattice of spins. It must not depend on the clusters actually drawn: stopping when
  // "enough spins have flipped" samples preferentially just after large clusters, which
  // biases the averages towards order.
  const perSample = Math.max(1, Math.ceil((L * L) / (flipped / warmup)))
  const sweep = () => {
    for (let i = 0; i < perSample; i++) wolffStep(s, T, j2, rng)
  }
  for (let i = 0; i < 100; i++) sweep()
  let abs = 0
  let m2 = 0
  let m4 = 0
  for (let i = 0; i < samples; i++) {
    sweep()
    const m = latticeSums(s.spins, L).s / (L * L)
    abs += Math.abs(m)
    m2 += m * m
    m4 += m ** 4
  }
  return { abs: abs / samples, binder: binderCumulant(m2, m4, samples) }
}

/** Temperature and cumulant where the Binder curves of two lattice sizes cross, by linear interpolation. */
function crossing(sizes: [number, number], temperatures: number[], j2: number, samples: number) {
  const curves = sizes.map((L) => temperatures.map((T) => measure(L, T, j2, samples).binder))
  const diff = temperatures.map((_, i) => curves[1]![i]! - curves[0]![i]!)
  for (let i = 0; i + 1 < temperatures.length; i++) {
    if (diff[i]! * diff[i + 1]! <= 0) {
      const w = diff[i]! / (diff[i]! - diff[i + 1]!)
      return {
        T: temperatures[i]! + w * (temperatures[i + 1]! - temperatures[i]!),
        binder: curves[0]![i]! + w * (curves[0]![i + 1]! - curves[0]![i]!),
      }
    }
  }
  throw new Error(`no crossing in [${temperatures[0]}, ${temperatures.at(-1)}]: ${diff.map((d) => d.toFixed(4))}`)
}

describe('Wolff cluster updates sample the right equilibrium', () => {
  it('magnetisation at T = 2.0 matches the exact solution', () => {
    expect(Math.abs(measure(48, 2, 0, 3000).abs - onsagerMagnetisation(2))).toBeLessThan(0.003)
  })

  it('the Binder cumulant tends to 2/3 in the ordered phase and to 0 in the disordered one', () => {
    expect(Math.abs(measure(32, 1.5, 0, 2000).binder - 2 / 3)).toBeLessThan(0.002)
    expect(Math.abs(measure(32, 6, 0, 4000).binder)).toBeLessThan(0.08)
  })
})

describe('critical behaviour of the 2D Ising model', () => {
  it('Binder curves for different sizes cross at the exact critical temperature', () => {
    const c = crossing([16, 32], [2.22, 2.27, 2.32], 0, 12000)
    console.log(`nearest-neighbour: crossing at T = ${c.T.toFixed(4)} (exact ${ISING_TC.toFixed(4)}), U4 = ${c.binder.toFixed(4)}`)
    expect(Math.abs(c.T / ISING_TC - 1)).toBeLessThan(0.01)
    expect(Math.abs(c.binder - BINDER_CRITICAL)).toBeLessThan(0.015)
  })

  it('at Tc the magnetisation falls as L^(-1/8)', () => {
    const sizes = [16, 32, 64]
    const m = sizes.map((L) => measure(L, ISING_TC, 0, 12000).abs)
    // Least-squares slope of ln m against ln L.
    const x = sizes.map(Math.log)
    const y = m.map(Math.log)
    const mx = x.reduce((a, b) => a + b, 0) / 3
    const my = y.reduce((a, b) => a + b, 0) / 3
    const slope = x.reduce((a, xi, i) => a + (xi - mx) * (y[i]! - my), 0) / x.reduce((a, xi) => a + (xi - mx) ** 2, 0)
    console.log(`|m| at Tc for L = ${sizes}: ${m.map((v) => v.toFixed(4))}; exponent ${slope.toFixed(4)} (exact -0.125)`)
    expect(Math.abs(slope + 0.125)).toBeLessThan(0.03)
  })

  it('a next-nearest-neighbour coupling moves Tc but not the critical cumulant', () => {
    const c = crossing([16, 32], [3.1, 3.15, 3.2, 3.25, 3.3], 0.3, 12000)
    console.log(`J2 = 0.3: crossing at T = ${c.T.toFixed(4)}, U4 = ${c.binder.toFixed(4)}`)
    expect(c.T / ISING_TC).toBeGreaterThan(1.2)
    expect(Math.abs(c.binder - BINDER_CRITICAL)).toBeLessThan(0.015)
  })
})
