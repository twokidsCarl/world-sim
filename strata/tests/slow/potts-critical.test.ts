import { describe, expect, it } from 'vitest'
import { createPotts, latticeSums, orderParameter, sweep, thresholds, wolffStep } from '../../src/substrates/potts/ref'
import { pottsCoexistence, pottsCriticalEnergy, pottsTc } from '../../src/theory/potts'

/** 相变点上用 Wolff 更新取平衡平均；两次取样之间的集团数固定。 / Equilibrium averages at the transition by Wolff updates, with a fixed number of clusters between samples. */
function atTransition(L: number, q: number, samples: number) {
  const T = pottsTc(q)
  const s = createPotts(L, q, 1, true)
  const rng = { seed: 7919 + L, counter: 0 }
  let flipped = 0
  const warmup = 400 + 8 * L
  for (let i = 0; i < warmup; i++) flipped += wolffStep(s, T, rng)
  const perSample = Math.max(1, Math.ceil((L * L) / (flipped / warmup)))
  for (let i = 0; i < 100 * perSample; i++) wolffStep(s, T, rng)
  let energy = 0
  let order = 0
  for (let i = 0; i < samples; i++) {
    for (let k = 0; k < perSample; k++) wolffStep(s, T, rng)
    const sums = latticeSums(s.spins, L)
    energy -= sums.bonds / (L * L) / samples
    order += orderParameter(sums.counts, q) / samples
  }
  return { energy, order }
}

/** 相变点上用 Metropolis 更新跑一段，再取一段时间平均的能量。 / Run Metropolis at the transition, then average the energy over a further stretch. */
function metropolisEnergy(L: number, q: number, ordered: boolean, sweeps: number): number {
  const s = createPotts(L, q, 3, ordered)
  const thr = thresholds(pottsTc(q))
  sweep(s, thr, sweeps)
  let energy = 0
  const samples = 100
  for (let i = 0; i < samples; i++) {
    sweep(s, thr, 20)
    energy -= latticeSums(s.spins, L).bonds / (L * L) / samples
  }
  return energy
}

describe('Potts model at its transition', () => {
  it('q = 3: the energy approaches the exact −(1 + 1/√3) as the lattice grows', () => {
    const exact = pottsCriticalEnergy(3)
    const small = atTransition(32, 3, 4000).energy
    const large = atTransition(64, 3, 4000).energy
    expect(Math.abs(large - exact)).toBeLessThan(Math.abs(small - exact))
    expect(Math.abs(large - exact)).toBeLessThan(0.025)
  })

  it('q = 3: the order parameter at the transition decays as L^(−2/15)', () => {
    const sizes = [16, 32, 64]
    const order = sizes.map((L) => atTransition(L, 3, 8000).order)
    const slope = Math.log(order[2]! / order[0]!) / Math.log(sizes[2]! / sizes[0]!)
    // β/ν = (1/9) / (5/6) = 2/15；Ising（q = 2）是 1/8。 / β/ν = (1/9) / (5/6) = 2/15; Ising (q = 2) has 1/8.
    expect(Math.abs(slope + 2 / 15)).toBeLessThan(0.015)
  })

  it('q = 8: ordered and disordered starts stay at two different energies, a latent heat apart', () => {
    const { ordered, disordered } = pottsCoexistence(8)
    const fromOrdered = metropolisEnergy(192, 8, true, 8000)
    const fromRandom = metropolisEnergy(192, 8, false, 8000)
    expect(Math.abs(fromOrdered - ordered)).toBeLessThan(0.04)
    expect(Math.abs(fromRandom - disordered)).toBeLessThan(0.04)
    expect(fromRandom - fromOrdered).toBeGreaterThan(0.4)
  }, 120_000)

  it('q = 3: both starts reach the same energy (no latent heat)', () => {
    const fromOrdered = metropolisEnergy(64, 3, true, 30000)
    const fromRandom = metropolisEnergy(64, 3, false, 30000)
    expect(Math.abs(fromOrdered - fromRandom)).toBeLessThan(0.04)
  })
})
