import { describe, expect, it } from 'vitest'
import {
  blockSpins,
  createIsing,
  latticeSums,
  pyramidLevels,
  sweep,
  thresholds,
} from '../../src/substrates/ising/ref'
import { ISING_TC, ellipticK, onsagerEnergy, onsagerMagnetisation } from '../../src/theory/onsager'

describe('Onsager exact solution', () => {
  it('critical temperature and limits', () => {
    expect(ISING_TC).toBeCloseTo(2.269185314, 8)
    expect(onsagerMagnetisation(2)).toBeCloseTo(0.911319, 5)
    expect(onsagerMagnetisation(ISING_TC + 1e-9)).toBe(0)
    expect(onsagerMagnetisation(0.5)).toBeCloseTo(1, 6)
  })

  it('energy per spin: ground state, critical point, high temperature', () => {
    expect(onsagerEnergy(0.3)).toBeCloseTo(-2, 6)
    expect(onsagerEnergy(ISING_TC)).toBeCloseTo(-Math.SQRT2, 6)
    // High-temperature series: e = -2 tanh(1/T) to leading order.
    expect(onsagerEnergy(50)).toBeCloseTo(-2 * Math.tanh(1 / 50), 4)
  })

  it('elliptic integral reference values', () => {
    expect(ellipticK(0)).toBeCloseTo(Math.PI / 2, 12)
    expect(ellipticK(0.5)).toBeCloseTo(1.685750354812596, 10)
  })
})

describe('Ising reference', () => {
  it('thresholds: downhill flips are always accepted, uphill follow exp(-dE/T)', () => {
    const thr = thresholds(2, 0, 0)
    // Spin up (s01 = 1) with all four neighbours down: dE = -8.
    expect(thr[25 + 0 * 5 + 2]).toBe(0xffffffff)
    // Spin up with all four neighbours up: dE = +8.
    expect(thr[25 + 4 * 5 + 2]! / 4294967296).toBeCloseTo(Math.exp(-4), 8)
  })

  it('is deterministic for a given seed', () => {
    const thr = thresholds(2.3, 0.2, 0.05)
    const a = createIsing(32, 9)
    const b = createIsing(32, 9)
    sweep(a, thr, 20)
    sweep(b, thr, 20)
    expect(a.spins).toEqual(b.spins)
    const c = createIsing(32, 10)
    sweep(c, thr, 20)
    expect(c.spins).not.toEqual(a.spins)
  })

  it('lattice sums on uniform and checkerboard states', () => {
    const L = 8
    expect(latticeSums(new Uint8Array(L * L).fill(1), L)).toEqual({ s: 64, nn: 128, nnn: 128 })
    const checker = Uint8Array.from({ length: L * L }, (_, i) => ((i % L) + Math.floor(i / L)) & 1)
    expect(latticeSums(checker, L)).toEqual({ s: 0, nn: -128, nnn: 128 })
  })

  it('block spins follow the majority', () => {
    const L = 4
    const src = Uint8Array.from([1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 0, 0])
    const dst = blockSpins(src, L, 1, 1)
    expect(dst[0]).toBe(1)
    expect(dst[1]).toBe(0)
    expect(dst[2]).toBe(1)
    expect(dst[3]).toBe(0)
    expect(pyramidLevels(512)).toBe(7)
    expect(pyramidLevels(64)).toBe(4)
  })

  it('magnetisation and energy at T = 2.0 match the exact solution', () => {
    const L = 64
    const thr = thresholds(2, 0, 0)
    const s = createIsing(L, 3, true)
    sweep(s, thr, 2000)
    let m = 0
    let e = 0
    const samples = 2000
    for (let i = 0; i < samples; i++) {
      sweep(s, thr, 5)
      const sums = latticeSums(s.spins, L)
      m += Math.abs(sums.s) / (L * L) / samples
      e += -sums.nn / (L * L) / samples
    }
    expect(Math.abs(m - onsagerMagnetisation(2))).toBeLessThan(0.005)
    expect(Math.abs(e - onsagerEnergy(2))).toBeLessThan(0.01)
  })

  it('high-temperature energy matches the exact solution', () => {
    const L = 64
    const thr = thresholds(4, 0, 0)
    const s = createIsing(L, 4)
    sweep(s, thr, 500)
    let e = 0
    const samples = 1000
    for (let i = 0; i < samples; i++) {
      sweep(s, thr, 3)
      e += -latticeSums(s.spins, L).nn / (L * L) / samples
    }
    expect(Math.abs(e - onsagerEnergy(4))).toBeLessThan(0.01)
  })

  it('block-spin flow: magnetisation grows with scale below Tc and shrinks above', () => {
    const L = 128
    const flow = (T: number, ordered: boolean) => {
      const thr = thresholds(T, 0, 0)
      const s = createIsing(L, 5, ordered)
      sweep(s, thr, 1500)
      const levels = pyramidLevels(L)
      const m = new Array<number>(levels).fill(0)
      const samples = 200
      for (let i = 0; i < samples; i++) {
        sweep(s, thr, 10)
        let spins = s.spins
        let size = L
        for (let k = 0; k < levels; k++) {
          m[k]! += Math.abs(latticeSums(spins, size).s) / (size * size) / samples
          if (k + 1 < levels) {
            spins = blockSpins(spins, size, s.seed, k + 1)
            size >>= 1
          }
        }
      }
      return m
    }
    const cold = flow(2.0, true)
    const hot = flow(3.0, false)
    for (let k = 1; k < cold.length; k++) expect(cold[k]!).toBeGreaterThan(cold[k - 1]!)
    expect(cold.at(-1)!).toBeGreaterThan(0.99)
    // Above Tc each block averages uncorrelated regions, so per-spin |m| at the coarsest
    // level is set by the handful of spins left, not by order: compare against random spins.
    const coarse = L >> (hot.length - 1)
    const random = Math.sqrt(2 / (Math.PI * coarse * coarse))
    expect(hot.at(-1)!).toBeLessThan(2.5 * random)
    expect(hot.at(-1)!).toBeLessThan(0.5 * cold.at(-1)!)
  })
})
