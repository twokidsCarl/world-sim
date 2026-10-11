import { describe, expect, it } from 'vitest'
import {
  blockStates,
  createPotts,
  latticeSums,
  orderParameter,
  sweep,
  thresholds,
  wolffStep,
} from '../../src/substrates/potts/ref'
import { onsagerEnergy } from '../../src/theory/onsager'
import { pottsCoexistence, pottsCriticalEnergy, pottsLatentHeat, pottsTc } from '../../src/theory/potts'

describe('Potts theory', () => {
  it('reproduces the published transition temperatures and latent heats', () => {
    // q = 2 就是 Ising 模型，耦合减半：Tc = T_Ising / 2。 / q = 2 is the Ising model at half the coupling.
    expect(pottsTc(2)).toBeCloseTo(1 / Math.log(1 + Math.SQRT2), 12)
    expect(pottsTc(3)).toBeCloseTo(0.99497, 4)
    expect(pottsTc(4)).toBeCloseTo(1 / Math.log(3), 12)
    expect(pottsLatentHeat(4)).toBe(0)
    // Baxter 的潜热：q = 8 为 0.486358，q = 10 为 0.6961。 / Baxter's latent heat: 0.486358 for q = 8, 0.6961 for q = 10.
    expect(pottsLatentHeat(8)).toBeCloseTo(0.486358, 5)
    expect(pottsLatentHeat(10)).toBeCloseTo(0.6961, 3)
    const { ordered, disordered } = pottsCoexistence(8)
    expect((ordered + disordered) / 2).toBeCloseTo(pottsCriticalEnergy(8), 12)
    expect(disordered - ordered).toBeCloseTo(0.486358, 5)
  })
})

describe('Potts reference', () => {
  it('lattice sums, order parameter and block states on simple states', () => {
    const L = 4
    const uniform = new Uint8Array(L * L).fill(2)
    const sums = latticeSums(uniform, L)
    expect(sums.bonds).toBe(2 * L * L)
    expect(orderParameter(sums.counts, 3)).toBe(1)
    // 四种状态铺成 2×2 的图案：没有同态的键，各态均分。
    // Four states tiled 2×2: no like bonds, equal populations.
    const tiled = Uint8Array.from({ length: L * L }, (_, i) => (i % 2) + 2 * (Math.floor(i / L) % 2))
    expect(latticeSums(tiled, L).bonds).toBe(0)
    expect(orderParameter(latticeSums(tiled, L).counts, 4)).toBe(0)
    expect(blockStates(uniform, L, 1, 1)).toEqual(new Uint8Array(4).fill(2))
    // 三比一的块取多数；二比二的块取其中之一。 / A 3–1 block takes the majority; a 2–2 block takes one of the two.
    const block = Uint8Array.from([5, 5, 1, 1, 5, 0, 2, 2, 3, 3, 4, 4, 3, 3, 6, 7])
    const coarse = blockStates(block, 4, 9, 1)
    expect(coarse[0]).toBe(5)
    expect([1, 2]).toContain(coarse[1])
    expect(coarse[2]).toBe(3)
    expect(coarse[3]).toBe(4)
  })

  it('never produces a state outside 0..q−1 and is deterministic', () => {
    const a = createPotts(16, 5, 3)
    const b = createPotts(16, 5, 3)
    sweep(a, thresholds(0.9), 50)
    sweep(b, thresholds(0.9), 50)
    expect(a.spins).toEqual(b.spins)
    expect(Math.max(...a.spins)).toBeLessThan(5)
    expect(new Set(a.spins).size).toBeGreaterThan(1)
  })

  it('q = 2 reproduces the Onsager energy of the Ising model at twice the temperature', () => {
    // δ(s, s') = (1 + s s') / 2，所以 Potts 的温度 T 对应 Ising 的 2T，
    // 每格点能量 = −1 + E_Ising(2T) / 2。
    // δ(s, s') = (1 + s s') / 2, so Potts at T is Ising at 2T, with energy per site
    // −1 + E_Ising(2T) / 2.
    for (const T of [0.9, 1.5]) {
      const L = 48
      const s = createPotts(L, 2, 11, T < pottsTc(2))
      const thr = thresholds(T)
      sweep(s, thr, 3000)
      let e = 0
      const samples = 400
      for (let i = 0; i < samples; i++) {
        sweep(s, thr, 10)
        e -= latticeSums(s.spins, L).bonds / (L * L) / samples
      }
      expect(Math.abs(e - (-1 + onsagerEnergy(2 * T) / 2))).toBeLessThan(0.01)
    }
  })

  it('Metropolis and Wolff updates agree on the energy away from the transition', () => {
    const L = 32
    const q = 3
    const T = 1.2
    const a = createPotts(L, q, 5)
    const thr = thresholds(T)
    sweep(a, thr, 2000)
    const b = createPotts(L, q, 6)
    const rng = { seed: 77, counter: 0 }
    for (let i = 0; i < 4000; i++) wolffStep(b, T, rng)
    let ea = 0
    let eb = 0
    const samples = 400
    for (let i = 0; i < samples; i++) {
      sweep(a, thr, 5)
      for (let k = 0; k < 40; k++) wolffStep(b, T, rng)
      ea -= latticeSums(a.spins, L).bonds / (L * L) / samples
      eb -= latticeSums(b.spins, L).bonds / (L * L) / samples
    }
    expect(Math.abs(ea - eb)).toBeLessThan(0.01)
  })
})
