import { describe, expect, it } from 'vitest'
import { uniform } from '../../src/core/rng'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initLattice, initTriangular } from '../../src/substrates/md/ref/init'
import { rdf, rdfCounts, rdfNormalise, speeds } from '../../src/substrates/md/ref/reducers'
import { createState, pressure, step, temperature, volume } from '../../src/substrates/md/ref/step'
import { speedCdf } from '../../src/theory/maxwell'
import { secondVirial } from '../../src/theory/virial'

const pair = analyticPair(LJ)

/**
 * 样本相对于连续 cdf 的 Kolmogorov–Smirnov p 值。
 * Kolmogorov–Smirnov p-value of a sample against a continuous cdf.
 */
function ksPValue(sample: Float64Array, cdf: (x: number) => number): number {
  const x = Float64Array.from(sample).sort()
  const n = x.length
  let d = 0
  for (let i = 0; i < n; i++) {
    const f = cdf(x[i]!)
    d = Math.max(d, f - i / n, (i + 1) / n - f)
  }
  const lambda = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * d
  let p = 0
  for (let k = 1; k <= 100; k++) p += 2 * (k % 2 === 1 ? 1 : -1) * Math.exp(-2 * k * k * lambda * lambda)
  return Math.min(1, Math.max(0, p))
}

describe('kinetic level', () => {
  it.each([2, 3] as const)('%iD speeds follow the Maxwell–Boltzmann distribution', (dim) => {
    const s = initLattice({ dim, perSide: dim === 2 ? 40 : 12, density: 0.5, temperature: 1.2, seed: 11 }, pair)
    step(s, pair, 0.004, 3000)
    const T = temperature(s)
    expect(ksPValue(speeds(s), (v) => speedCdf(dim, T, v))).toBeGreaterThan(0.01)
  })

  it('the KS test has power: a wrong temperature is rejected', () => {
    const s = initLattice({ dim: 2, perSide: 40, density: 0.5, temperature: 1.2, seed: 11 }, pair)
    step(s, pair, 0.004, 3000)
    const T = temperature(s)
    expect(ksPValue(speeds(s), (v) => speedCdf(2, 1.25 * T, v))).toBeLessThan(0.01)
  })

  it('g(r) = 1 for an ideal gas', () => {
    const n = 10000
    const L = 100
    const counts = new Float64Array(20)
    const configs = 8
    for (let c = 0; c < configs; c++) {
      const s = createState(2, n, [L, L])
      for (let k = 0; k < 2 * n; k++) s.pos[k] = L * uniform(100 + c, k)
      rdfCounts(s, 5, counts)
    }
    const g = rdfNormalise(counts, 5, n, L * L, 2, configs)
    for (let b = 4; b < 20; b++) expect(Math.abs(g.y[b]! - 1)).toBeLessThan(0.02)
  })

  it('a triangular lattice has neighbour shells at a, √3 a and 2a', () => {
    const density = 0.9
    const s = initTriangular({ nx: 20, density, temperature: 0, seed: 1 }, pair)
    const a = Math.sqrt(2 / (Math.sqrt(3) * density))
    const bins = 400
    const g = rdf(s, bins, 2.3 * a)
    const w = (2.3 * a) / bins
    const occupied = [...g.y.keys()].filter((b) => g.y[b]! > 0)
    const expected = [a, Math.sqrt(3) * a, 2 * a].map((r) => Math.floor(r / w))
    // 每个壳层可能因舍入而跨在分箱边界上，所以允许落在相邻的箱里。
    // Each shell may straddle a bin edge by rounding, so allow the adjacent bin.
    expect(occupied.length).toBeLessThanOrEqual(6)
    for (const e of expected) expect(occupied.some((b) => Math.abs(b - e) <= 1)).toBe(true)
    for (const b of occupied) expect(expected.some((e) => Math.abs(b - e) <= 1)).toBe(true)
    // 前三个壳层各有六个近邻。 / Six neighbours in each of the first three shells.
    const shellCount = (e: number) =>
      occupied.filter((b) => Math.abs(b - e) <= 1).reduce((sum, b) => sum + g.y[b]! * density * Math.PI * w * w * (2 * b + 1), 0)
    for (const e of expected) expect(shellCount(e)).toBeCloseTo(6, 6)
  })
})

describe('thermodynamic level', () => {
  it('low-density pressure follows the virial expansion to B2', () => {
    const density = 0.02
    // T = 2.5 高于二维 Boyle 温度（B2 > 0），且碰撞足够频繁，
    // 能在本次运行内使对关联达到平衡。T ≈ 1 以下，同样的运行长度
    // 对近距离粒子对采样不足，读数比 B2 低 20–40%。
    // T = 2.5 is above the 2D Boyle temperature (B2 > 0) and collisions are frequent enough
    // to equilibrate pair correlations within the run. Below T ≈ 1 the same run length
    // undersamples close pairs and reads 20–40% short of B2.
    const s = initLattice({ dim: 2, perSide: 30, density, temperature: 2.5, seed: 5 }, pair)
    step(s, pair, 0.005, 6000)
    let p = 0
    let T = 0
    const samples = 3000
    for (let i = 0; i < samples; i++) {
      step(s, pair, 0.005, 10)
      p += pressure(s) / samples
      T += temperature(s) / samples
    }
    const b2 = secondVirial(LJ, T, 2)
    const ideal = density * T
    const excess = p / ideal - 1
    expect(s.n / volume(s)).toBeCloseTo(density, 12)
    expect(Math.abs(p / (ideal * (1 + b2 * density)) - 1)).toBeLessThan(0.01)
    // 单独取相互作用部分，这样测试就不能只靠理想气体项通过。
    // The interaction part on its own, so the test cannot pass on the ideal-gas term alone.
    expect(Math.abs(b2 * density)).toBeGreaterThan(0.01)
    expect(Math.abs(excess / (b2 * density) - 1)).toBeLessThan(0.15)
  })
})
