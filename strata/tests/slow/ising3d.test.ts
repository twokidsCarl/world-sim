import { describe, expect, it } from 'vitest'
import { binderCumulant } from '../../src/substrates/ising/ref'
import {
  BINDER3D_CRITICAL,
  ISING3D_TC,
  blockSpins3d,
  createIsing3d,
  latticeSums3d,
  pyramidLevels3d,
  sweep3d,
  thresholds3d,
  wolffStep3d,
} from '../../src/substrates/ising/ref3d'

/** 用 Wolff 团簇更新取平衡平均；两次取样之间的团簇数固定。 / Equilibrium averages by Wolff updates, with a fixed number of clusters between samples. */
function measure(L: number, T: number, samples: number, seed = 1) {
  const s = createIsing3d(L, seed, true)
  const rng = { seed: seed * 7919 + L, counter: 0 }
  let flipped = 0
  const warmup = 300 + 6 * L
  for (let i = 0; i < warmup; i++) flipped += wolffStep3d(s, T, rng)
  const perSample = Math.max(1, Math.ceil(s.spins.length / (flipped / warmup)))
  const sweep = () => {
    for (let i = 0; i < perSample; i++) wolffStep3d(s, T, rng)
  }
  for (let i = 0; i < 60; i++) sweep()
  let abs = 0
  let m2 = 0
  let m4 = 0
  for (let i = 0; i < samples; i++) {
    sweep()
    const m = latticeSums3d(s.spins, L).s / s.spins.length
    abs += Math.abs(m)
    m2 += m * m
    m4 += m ** 4
  }
  return { abs: abs / samples, binder: binderCumulant(m2, m4, samples) }
}

describe('3D Ising reference', () => {
  it('lattice sums and block spins on simple states', () => {
    const L = 4
    const up = new Uint8Array(L ** 3).fill(1)
    expect(latticeSums3d(up, L)).toEqual({ s: 64, nn: 192 })
    const checker = Uint8Array.from({ length: L ** 3 }, (_, i) => ((i % L) + (Math.floor(i / L) % L) + Math.floor(i / (L * L))) & 1)
    expect(latticeSums3d(checker, L)).toEqual({ s: 0, nn: -192 })
    expect(blockSpins3d(up, L, 1, 1)).toEqual(new Uint8Array(8).fill(1))
    expect(pyramidLevels3d(64)).toBe(5)
  })

  it('is deterministic for a given seed, and Metropolis orders the lattice well below Tc', () => {
    const thr = thresholds3d(3, 0)
    const a = createIsing3d(16, 5, true)
    const b = createIsing3d(16, 5, true)
    sweep3d(a, thr, 200)
    sweep3d(b, thr, 200)
    expect(a.spins).toEqual(b.spins)
    // T = 3 远低于 Tc = 4.51：磁化强度接近饱和。 / T = 3 is far below Tc = 4.51: the magnetisation is near saturation.
    expect(Math.abs(latticeSums3d(a.spins, 16).s) / 16 ** 3).toBeGreaterThan(0.9)
  })

  it('Metropolis and Wolff agree on the magnetisation at T = 4.0', () => {
    const L = 16
    const thr = thresholds3d(4, 0)
    const s = createIsing3d(L, 3, true)
    sweep3d(s, thr, 500)
    let m = 0
    const samples = 600
    for (let i = 0; i < samples; i++) {
      sweep3d(s, thr, 3)
      m += Math.abs(latticeSums3d(s.spins, L).s) / L ** 3 / samples
    }
    const w = measure(L, 4, 3000).abs
    console.log(`3D |m| at T = 4.0, L = 16: Metropolis ${m.toFixed(4)}, Wolff ${w.toFixed(4)}`)
    expect(Math.abs(m - w)).toBeLessThan(0.01)
  }, 240_000)
})

describe('critical behaviour of the 3D Ising model', () => {
  it('Binder curves for L = 8 and 16 cross near the critical temperature', () => {
    const temperatures = [4.4, 4.5, 4.6]
    const curves = [8, 16].map((L) => temperatures.map((T) => measure(L, T, 12000).binder))
    const diff = temperatures.map((_, i) => curves[1]![i]! - curves[0]![i]!)
    let crossT = NaN
    let crossU = NaN
    for (let i = 0; i + 1 < temperatures.length; i++) {
      if (diff[i]! * diff[i + 1]! <= 0) {
        const w = diff[i]! / (diff[i]! - diff[i + 1]!)
        crossT = temperatures[i]! + w * (temperatures[i + 1]! - temperatures[i]!)
        crossU = curves[0]![i]! + w * (curves[0]![i + 1]! - curves[0]![i]!)
      }
    }
    console.log(`3D: Binder crossing at T = ${crossT.toFixed(4)} (Tc = ${ISING3D_TC.toFixed(4)}), U4 = ${crossU.toFixed(4)} (reference ${BINDER3D_CRITICAL})`)
    // 这么小的晶格在三维里有明显的修正项，交点比 Tc 略偏。
    // Lattices this small have noticeable corrections to scaling in 3D, so the crossing sits slightly off Tc.
    expect(Math.abs(crossT / ISING3D_TC - 1)).toBeLessThan(0.015)
    expect(Math.abs(crossU - BINDER3D_CRITICAL)).toBeLessThan(0.04)
  }, 600_000)

  it('at Tc the magnetisation falls as L^(-β/ν) with β/ν ≈ 0.518, not the 2D value 1/8', () => {
    const sizes = [8, 16, 32]
    const m = sizes.map((L) => measure(L, ISING3D_TC, L === 32 ? 4000 : 10000).abs)
    const x = sizes.map(Math.log)
    const y = m.map(Math.log)
    const mx = x.reduce((a, b) => a + b, 0) / 3
    const my = y.reduce((a, b) => a + b, 0) / 3
    const slope = x.reduce((a, xi, i) => a + (xi - mx) * (y[i]! - my), 0) / x.reduce((a, xi) => a + (xi - mx) ** 2, 0)
    console.log(`3D |m| at Tc for L = ${sizes}: ${m.map((v) => v.toFixed(4))}; exponent ${slope.toFixed(4)} (reference -0.518; 2D is -0.125)`)
    expect(Math.abs(slope + 0.518)).toBeLessThan(0.04)
  }, 600_000)
})
