import { describe, expect, it } from 'vitest'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initFcc } from '../../src/substrates/md/ref/init'
import { fieldSums, profiles } from '../../src/substrates/md/ref/reducers'
import { computeForces, step, type MdState } from '../../src/substrates/md/ref/step'

const pair = analyticPair(LJ)

function channel(drive: number, temperature: number): MdState {
  const s = initFcc({ cells: 7, density: 0.7, temperature, seed: 8 }, pair)
  s.walls = true
  s.wallTemperature = temperature
  s.wallTemperatureFar = temperature
  s.drive = drive
  s.seed = 8
  computeForces(s, pair)
  return s
}

describe('3D channel with thermal walls', () => {
  it('holds the wall temperature without driving', () => {
    const s = channel(0, 1.3)
    step(s, pair, 0.005, 6000)
    let T = 0
    const samples = 400
    for (let k = 0; k < samples; k++) {
      step(s, pair, 0.005, 10)
      T += profiles(fieldSums(s), s.box, 1).temperature[0]! / samples
    }
    console.log(`3D walls at 1.3: gas temperature ${T.toFixed(3)}`)
    expect(Math.abs(T - 1.3)).toBeLessThan(0.07)
  }, 240_000)

  it('driven flow develops the parabolic Poiseuille profile', () => {
    const s = channel(0.08, 1.3)
    step(s, pair, 0.005, 5000)
    const bins = 12
    const u = new Float64Array(bins)
    const samples = 800
    for (let k = 0; k < samples; k++) {
      step(s, pair, 0.005, 10)
      const pr = profiles(fieldSums(s), s.box, bins)
      for (let b = 0; b < bins; b++) u[b]! += pr.ux[b]! / samples
    }
    // 对 u = a s (1 − s) + b 做最小二乘，与二维的测试相同。 / Least squares for u = a s (1 − s) + b, as in the 2D test.
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
    const r2 = (sxy * sxy) / (sxx * syy)
    console.log(`3D Poiseuille: width ${s.box[1]!.toFixed(1)}, mean ${mu.toFixed(3)}, slip ${(mu - a * mx).toFixed(3)}, R² ${r2.toFixed(4)}`)
    expect(mu).toBeGreaterThan(0.1)
    expect(a).toBeGreaterThan(0)
    expect(r2).toBeGreaterThan(0.97)
    expect(u[bins / 2]!).toBeGreaterThan(1.5 * u[0]!)
  }, 240_000)
})
