import { describe, expect, it } from 'vitest'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initTriangular } from '../../src/substrates/md/ref/init'
import { fieldSums, profiles } from '../../src/substrates/md/ref/reducers'
import { computeForces, kineticEnergy, step, type MdState } from '../../src/substrates/md/ref/step'

const pair = analyticPair(LJ)

function channel(density: number, temperature: number, nx = 40): MdState {
  const s = initTriangular({ nx, density, temperature, seed: 4, aspect: 2 }, pair)
  s.walls = true
  s.wallTemperature = temperature
  s.wallTemperatureFar = temperature
  s.seed = 4
  computeForces(s, pair)
  return s
}

describe('gravity between thermal walls', () => {
  // 稀薄气体在重力场中的平衡密度服从气压公式 ρ(y) ∝ exp(g y / T)（重力指向 +y）。
  // A dilute gas in a gravitational field has the barometric density ρ(y) ∝ exp(g y / T)
  // at equilibrium (gravity pointing along +y).
  it('a dilute gas settles into the barometric density profile', () => {
    const T = 1.5
    const g = 0.03
    const s = channel(0.03, T)
    s.gravity = g
    // 加上重力后气体先往下落、再弹回来，密度剖面来回晃荡；实测它在约 240 个时间单位之后才稳下来
    // （在 60 到 120 之间去量，斜率会偏大一成半）。所以先等 240，再平均 240。
    // Once gravity is on the gas first falls and then rebounds, and the density profile sloshes;
    // it is measured to settle only after about 240 time units (sampled between 60 and 120, the
    // slope comes out some 15% too steep). So wait 240, then average over 240.
    step(s, pair, 0.005, 48000)
    const bins = 8
    const density = new Float64Array(bins)
    const samples = 1200
    for (let k = 0; k < samples; k++) {
      step(s, pair, 0.005, 40)
      const pr = profiles(fieldSums(s), s.box, bins)
      for (let b = 0; b < bins; b++) density[b]! += pr.density[b]! / samples
    }
    // ln ρ 对 y 的最小二乘斜率应为 g / T。 / The least-squares slope of ln ρ against y should be g / T.
    const y = Array.from({ length: bins }, (_, b) => ((b + 0.5) / bins) * s.box[1]!)
    const ln = Array.from(density, Math.log)
    const my = y.reduce((a, c) => a + c, 0) / bins
    const ml = ln.reduce((a, c) => a + c, 0) / bins
    const slope = y.reduce((a, yi, i) => a + (yi - my) * (ln[i]! - ml), 0) / y.reduce((a, yi) => a + (yi - my) ** 2, 0)
    console.log(`barometric slope ${slope.toFixed(5)} against g/T = ${(g / T).toFixed(5)}; height ${s.box[1]!.toFixed(1)}`)
    expect(Math.abs(slope / (g / T) - 1)).toBeLessThan(0.1)
  }, 240_000)
})

describe('walls at two temperatures', () => {
  it('without gravity the gas conducts: its temperature runs from one wall value to the other', () => {
    const s = channel(0.3, 1, 30)
    s.wallTemperature = 0.8
    s.wallTemperatureFar = 2
    step(s, pair, 0.005, 16000)
    const bins = 6
    const T = new Float64Array(bins)
    const samples = 500
    for (let k = 0; k < samples; k++) {
      step(s, pair, 0.005, 20)
      const pr = profiles(fieldSums(s), s.box, bins)
      for (let b = 0; b < bins; b++) T[b]! += pr.temperature[b]! / samples
    }
    console.log(`temperature across the gap: ${Array.from(T, (v) => v.toFixed(3))}`)
    // 单调上升，两端落在两个壁面温度之间（壁面处有温度跳跃）。
    // Monotonically rising, and at both ends between the two wall temperatures (there is
    // a temperature jump at each wall).
    for (let b = 1; b < bins; b++) expect(T[b]!).toBeGreaterThan(T[b - 1]!)
    expect(T[0]!).toBeGreaterThan(0.8)
    expect(T[bins - 1]!).toBeLessThan(2)
    expect(T[bins - 1]! - T[0]!).toBeGreaterThan(0.4)
  }, 240_000)
})

describe('a fixed disc obstacle', () => {
  it('keeps particles out and conserves energy', () => {
    const s = initTriangular({ nx: 30, density: 0.5, temperature: 1.5, seed: 6, obstacle: { fx: 0.5, fy: 0.5, r: 6 } }, pair)
    const o = s.obstacle!
    // 圆盘内没有放粒子，所以粒子数少于满格的 30 × 34。
    // No particles were placed inside the disc, so there are fewer than the full 30 × 34.
    expect(s.n).toBeLessThan(30 * 34)
    expect(s.n).toBeGreaterThan(30 * 34 - 90)
    step(s, pair, 0.002, 1500)
    const e0 = kineticEnergy(s) + s.pe
    let deepest = Infinity
    for (let k = 0; k < 40; k++) {
      step(s, pair, 0.002, 100)
      for (let i = 0; i < s.n; i++) deepest = Math.min(deepest, Math.hypot(s.pos[2 * i]! - o.x, s.pos[2 * i + 1]! - o.y))
    }
    console.log(`closest approach to the disc centre ${deepest.toFixed(3)} for radius ${o.r}`)
    expect(deepest).toBeGreaterThan(o.r - 0.25)
    expect(Math.abs(kineticEnergy(s) + s.pe - e0) / s.n).toBeLessThan(2e-3)
  }, 240_000)
})
