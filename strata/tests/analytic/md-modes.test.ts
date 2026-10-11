import { describe, expect, it } from 'vitest'
import { dominantFrequency } from '../../src/analysis/oscillation'
import { uniform } from '../../src/core/rng'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initTriangular } from '../../src/substrates/md/ref/init'
import { MODE_COUNT, densityModes, modeStride, structureFactor } from '../../src/substrates/md/ref/reducers'
import { createState } from '../../src/substrates/md/ref/step'
import { virialSoundSpeed } from '../../src/theory/sound'

const pair = analyticPair(LJ)

describe('density modes and structure factor', () => {
  it('a single particle has |ρ_k| = 1 at every wave vector, with the right phase', () => {
    const s = createState(2, 1, [10, 8])
    s.pos.set([2.5, 2])
    const m = densityModes(s)
    for (let j = 0; j <= 2 * MODE_COUNT; j++) expect(Math.hypot(m.data[2 * j]!, m.data[2 * j + 1]!)).toBeCloseTo(1, 12)
    // k = 2π/10，x = 2.5：exp(-i π/2) = -i。 / k = 2π/10, x = 2.5: exp(-i π/2) = -i.
    expect(m.data[0]).toBeCloseTo(0, 12)
    expect(m.data[1]).toBeCloseTo(-1, 12)
  })

  it('an ideal gas has S(k) = 1 on average', () => {
    const n = 20000
    const s = createState(2, n, [40, 40])
    for (let k = 0; k < 2 * n; k++) s.pos[k] = 40 * uniform(4, k)
    const sk = structureFactor(densityModes(s), n, s.box)
    const mean = sk.y.reduce((a, b) => a + b, 0) / sk.y.length
    // 每个 S(k) 服从均值为 1 的指数分布；96 个的平均为 1 ± 0.1。
    // Each S(k) is exponentially distributed with mean 1; 96 of them average to 1 ± 0.1.
    expect(Math.abs(mean - 1)).toBeLessThan(0.3)
  })

  it('a triangular lattice has its Bragg peak along y at 4π / (a √3)', () => {
    const density = 0.9
    const s = initTriangular({ nx: 16, density, temperature: 0, seed: 1 }, pair)
    expect(modeStride(s.box[1]!)).toBe(1)
    const a = Math.sqrt(2 / (Math.sqrt(3) * density))
    const sk = structureFactor(densityModes(s), s.n, s.box)
    const bragg = (4 * Math.PI) / (a * Math.sqrt(3))
    const at = [...sk.x.keys()].reduce((best, i) => (Math.abs(sk.x[i]! - bragg) < Math.abs(sk.x[best]! - bragg) ? i : best), 0)
    expect(Math.abs(sk.x[at]! - bragg)).toBeLessThan(1e-9)
    // 全部 N 个粒子同相散射。 / All N particles scatter in phase.
    expect(sk.y[at]).toBeCloseTo(s.n, 6)
    // 偏离倒格矢时，完美晶格没有散射。
    // Away from reciprocal-lattice vectors the perfect lattice scatters nothing.
    expect(sk.y[0]!).toBeLessThan(1e-9)
  })

  it('large boxes sample every few wave vectors so the range still covers the first peak', () => {
    expect(modeStride(20)).toBe(1)
    const stride = modeStride(300)
    expect(stride).toBeGreaterThan(1)
    expect((2 * Math.PI * stride * MODE_COUNT) / 300).toBeGreaterThanOrEqual(12)
  })
})

describe('oscillation frequency', () => {
  it('recovers the frequency of a damped, offset oscillation from under two periods', () => {
    const omega = 0.37
    const t = Array.from({ length: 120 }, (_, i) => 0.25 * i + 0.05 * Math.sin(i))
    const y = t.map((x) => 0.4 + Math.exp(-0.01 * x) * Math.cos(omega * x + 0.3))
    const f = dominantFrequency(t, y)!
    expect(Math.abs(f.omega / omega - 1)).toBeLessThan(0.02)
    expect(f.quality).toBeGreaterThan(0.95)
  })

  it('declines to answer before a full period has been seen, when asked for one', () => {
    const t = Array.from({ length: 80 }, (_, i) => 0.1 * i)
    const y = t.map((x) => Math.cos(0.5 * x))
    // 周期为 12.6 的波经过 8 个时间单位：约 0.64 个周期。
    // 8 time units of a period-12.6 wave: about 0.64 periods.
    expect(dominantFrequency(t, y, 1)).toBeNull()
  })

  it('declines to answer on a record with no variation', () => {
    expect(dominantFrequency([0, 1, 2, 3, 4, 5, 6, 7, 8], [1, 1, 1, 1, 1, 1, 1, 1, 1])).toBeNull()
  })
})

describe('virial sound speed', () => {
  it('reduces to the ideal-gas value at zero density', () => {
    expect(virialSoundSpeed(LJ, 1e-9, 1.7, 2)).toBeCloseTo(Math.sqrt(2 * 1.7), 6)
    expect(virialSoundSpeed(LJ, 1e-9, 1.7, 3)).toBeCloseTo(Math.sqrt((5 / 3) * 1.7), 6)
  })

  it('repulsion-dominated gases are stiffer than ideal', () => {
    // 在 Boyle 温度以上 B2 > 0，所以声速比理想气体中快。
    // Above the Boyle temperature B2 > 0, so sound is faster than in the ideal gas.
    expect(virialSoundSpeed(LJ, 0.1, 4, 2)).toBeGreaterThan(Math.sqrt(8))
  })
})
