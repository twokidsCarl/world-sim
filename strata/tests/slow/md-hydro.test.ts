import { describe, expect, it } from 'vitest'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initTriangular } from '../../src/substrates/md/ref/init'
import { fieldSums, profiles } from '../../src/substrates/md/ref/reducers'
import { computeForces, step, type MdState } from '../../src/substrates/md/ref/step'

const pair = analyticPair(LJ)

function channel(drive: number, temperature = 1): MdState {
  const s = initTriangular({ nx: 40, density: 0.7, temperature, seed: 8, aspect: 4 }, pair)
  s.walls = true
  s.wallTemperature = temperature
  // 两面壁同温。漏设远壁时它停在默认的 1.0，气体会落在两个壁温之间。
  // Both walls at the same temperature. Left unset, the far wall stays at its default of 1.0 and the gas settles between the two.
  s.wallTemperatureFar = temperature
  s.drive = drive
  s.seed = 8
  computeForces(s, pair)
  return s
}

describe('coarse-grained fields', () => {
  it('carry exactly the mass and momentum of the particles', () => {
    const s = initTriangular({ nx: 30, density: 0.6, temperature: 1.3, seed: 3 }, pair)
    step(s, pair, 0.004, 200)
    const f = fieldSums(s)
    let n = 0
    let px = 0
    let py = 0
    let v2 = 0
    for (let c = 0; c < f.count.length; c++) {
      n += f.count[c]!
      px += f.vx[c]!
      py += f.vy[c]!
      v2 += f.v2[c]!
    }
    let sx = 0
    let sy = 0
    let s2 = 0
    for (let i = 0; i < s.n; i++) {
      sx += s.vel[2 * i]!
      sy += s.vel[2 * i + 1]!
      s2 += s.vel[2 * i]! ** 2 + s.vel[2 * i + 1]! ** 2
    }
    expect(n).toBe(s.n)
    expect(Math.abs(px - sx)).toBeLessThan(1e-10)
    expect(Math.abs(py - sy)).toBeLessThan(1e-10)
    expect(Math.abs(v2 - s2) / s2).toBeLessThan(1e-12)
  })

  it('profiles recover a uniform density and the kinetic temperature at rest', () => {
    const s = initTriangular({ nx: 60, density: 0.5, temperature: 1.4, seed: 3 }, pair)
    step(s, pair, 0.004, 1500)
    const pr = profiles(fieldSums(s), s.box, 6)
    for (let b = 0; b < 6; b++) {
      expect(Math.abs(pr.density[b]! - 0.5)).toBeLessThan(0.06)
      expect(Math.abs(pr.temperature[b]! - pr.temperature.reduce((a, c) => a + c, 0) / 6)).toBeLessThan(0.15)
    }
  })
})

describe('channel with thermal walls', () => {
  it('keeps every particle between the walls and holds the wall temperature without driving', () => {
    const s = channel(0, 0.9)
    // 初始晶格熔化使气体冷却到约 0.74；壁面在约 60 个时间单位内把温度带回来。等 80 个时间单位
    // 时还残留约 0.015 的偏低（四个种子的平均），所以等 200。
    // Melting the initial lattice cools the gas to about 0.74; the walls bring it back over some
    // 60 time units. After 80 time units about 0.015 of the deficit remains (the mean over four
    // seeds), so wait 200.
    step(s, pair, 0.005, 40000)
    let T = 0
    const samples = 1600
    for (let k = 0; k < samples; k++) {
      step(s, pair, 0.005, 10)
      for (let i = 0; i < s.n; i++) {
        expect(s.pos[2 * i + 1]!).toBeGreaterThanOrEqual(0)
        expect(s.pos[2 * i + 1]!).toBeLessThan(s.box[1]!)
      }
      const pr = profiles(fieldSums(s), s.box, 1)
      T += pr.temperature[0]! / samples
    }
    expect(Math.abs(T - 0.9)).toBeLessThan(0.05)
  })

  it('driven flow develops the parabolic Poiseuille profile', () => {
    const s = channel(0.04)
    step(s, pair, 0.005, 6000)
    const bins = 12
    const u = new Float64Array(bins)
    const samples = 1500
    for (let k = 0; k < samples; k++) {
      step(s, pair, 0.005, 10)
      const pr = profiles(fieldSums(s), s.box, bins)
      for (let b = 0; b < bins; b++) u[b]! += pr.ux[b]! / samples
    }
    // 对 u = a s (1 - s) + b 做最小二乘：b 是壁面处的滑移速度。
    // Least squares for u = a s (1 - s) + b: b is the slip velocity at the walls.
    const x = Array.from({ length: bins }, (_, b) => ((b + 0.5) / bins) * (1 - (b + 0.5) / bins))
    const mx = x.reduce((p, c) => p + c, 0) / bins
    const mu = u.reduce((p, c) => p + c, 0) / bins
    let sxy = 0
    let sxx = 0
    let syy = 0
    for (let b = 0; b < bins; b++) {
      sxy += (x[b]! - mx) * (u[b]! - mu)
      sxx += (x[b]! - mx) ** 2
      syy += (u[b]! - mu) ** 2
    }
    const a = sxy / sxx
    const slip = mu - a * mx
    const r2 = (sxy * sxy) / (sxx * syy)
    console.log(`Poiseuille: mean ${mu.toFixed(3)}, centre ${(a / 4 + slip).toFixed(3)}, slip ${slip.toFixed(3)}, R² ${r2.toFixed(4)}`)
    expect(mu).toBeGreaterThan(0.1)
    expect(a).toBeGreaterThan(0)
    expect(r2).toBeGreaterThan(0.98)
    // 中间最快，壁面处最慢。 / Fastest in the middle, slowest at the walls.
    expect(u[bins / 2]!).toBeGreaterThan(2 * u[0]!)
    expect(u[bins / 2 - 1]!).toBeGreaterThan(2 * u[bins - 1]!)
  })
})
