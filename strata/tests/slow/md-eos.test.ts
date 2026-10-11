import { describe, expect, it } from 'vitest'
import { analyticPair, type PotentialSpec } from '../../src/substrates/md/potential'
import { initTriangular } from '../../src/substrates/md/ref/init'
import { kineticEnergy, pressure, step, temperature } from '../../src/substrates/md/ref/step'
import { cutoffPressureCorrection2d, ljFluid2d, ljFluid2dApplies } from '../../src/theory/ljEos'

// 模拟数据：Homes 等 (2025) 的 2D_bulk_data.csv，完整 LJ 势（rc = 6.5σ 加长程修正），N = 65536。
// Simulation data: 2D_bulk_data.csv of Homes et al. (2025), full LJ potential (rc = 6.5 σ
// plus long-range corrections), N = 65536. Columns: T, ρ, P, potential energy per particle.
const REFERENCE: [number, number, number, number][] = [
  [0.7, 0.6, 0.34337, -1.7577],
  [0.7, 0.7, 0.748525, -2.04993],
  [1.0, 0.3, 0.267368, -0.86093],
  [1.0, 0.5, 0.571004, -1.36815],
  [1.0, 0.6, 0.921632, -1.64057],
  [1.0, 0.7, 1.698185, -1.92553],
  [1.4, 0.5, 1.061912, -1.26672],
  [2.0, 0.3, 0.75537, -0.68822],
  [2.0, 0.6, 2.781, -1.38113],
  [2.0, 0.7, 4.53543, -1.57382],
  [3.0, 0.5, 2.93952, -0.992],
  [3.0, 0.7, 7.06802, -1.25843],
]

/**
 * 在给定状态点跑恒温模拟，返回时间平均的压强与每粒子势能。
 * Run a thermostatted simulation at a state point; returns time-averaged pressure and
 * potential energy per particle.
 */
function simulate(spec: PotentialSpec, density: number, T: number, equilibrate: number, sample: number) {
  const pair = analyticPair(spec)
  const s = initTriangular({ nx: 30, density, temperature: T, seed: 11 }, pair)
  const dt = 0.004
  // Berendsen 弱耦合恒温 / Berendsen weak-coupling thermostat.
  const thermostat = () => {
    const lambda = Math.sqrt(1 + (dt / 0.2) * (T / temperature(s) - 1))
    for (let k = 0; k < s.vel.length; k++) s.vel[k]! *= lambda
  }
  for (let i = 0; i < equilibrate; i++) {
    step(s, pair, dt)
    thermostat()
  }
  let p = 0
  let u = 0
  let meanT = 0
  for (let i = 0; i < sample; i++) {
    step(s, pair, dt)
    thermostat()
    p += pressure(s) / sample
    u += s.pe / s.n / sample
    meanT += temperature(s) / sample
  }
  return { p, u, T: meanT, ke: kineticEnergy(s) }
}

describe('published equation of state of the 2D Lennard-Jones fluid', () => {
  it('reproduces the simulation data it was fitted to', () => {
    for (const [T, density, p, u] of REFERENCE) {
      const eos = ljFluid2d(density, T)
      expect(Math.abs(eos.pressure / p - 1), `P at T=${T}, ρ=${density}`).toBeLessThan(0.01)
      expect(Math.abs(eos.energy / u - 1), `u at T=${T}, ρ=${density}`).toBeLessThan(0.01)
    }
  })

  it('applies only to the single-phase fluid inside the fitted range', () => {
    expect(ljFluid2dApplies(0.6, 1)).toBe(true)
    expect(ljFluid2dApplies(0.6, 0.45)).toBe(false)
    expect(ljFluid2dApplies(0.9, 1)).toBe(false)
    expect(ljFluid2dApplies(0.5, 5)).toBe(false)
  })
})

describe('our molecular dynamics against the published data', () => {
  it('with a long cutoff, a dense fluid has the published pressure and energy', () => {
    // rc = 6.5 与文献的模拟一致；此处力平移与长程修正都远小于 1%。
    // rc = 6.5 as in the published simulations; here the force shift and the long-range
    // correction are both far below 1%.
    const spec: PotentialSpec = { kind: 'mie', epsilon: 1, sigma: 1, n: 12, m: 6, rc: 6.5 }
    const [T, density, p, u] = REFERENCE[4]!
    const r = simulate(spec, density, T, 2500, 4000)
    const expected = p + cutoffPressureCorrection2d(spec, density)
    console.log(
      `T=${T}, ρ=${density}, rc=6.5: P = ${r.p.toFixed(4)} (published ${p}, with cutoff correction ${expected.toFixed(4)}), u = ${r.u.toFixed(4)} (published ${u}), <T> = ${r.T.toFixed(4)}`,
    )
    expect(Math.abs(r.T - T)).toBeLessThan(0.01)
    expect(Math.abs(r.p / expected - 1)).toBeLessThan(0.03)
    expect(Math.abs(r.u / u - 1)).toBeLessThan(0.01)
  }, 240_000)

  it('at rc = 4 the equation of state plus the cutoff correction still matches', () => {
    const spec: PotentialSpec = { kind: 'mie', epsilon: 1, sigma: 1, n: 12, m: 6, rc: 4 }
    const T = 2
    const density = 0.7
    const r = simulate(spec, density, T, 2500, 5000)
    const eos = ljFluid2d(density, T).pressure
    const correction = cutoffPressureCorrection2d(spec, density)
    console.log(
      `T=${T}, ρ=${density}, rc=4: P = ${r.p.toFixed(4)}, equation of state ${eos.toFixed(4)} + cutoff correction ${correction.toFixed(4)} = ${(eos + correction).toFixed(4)}`,
    )
    expect(Math.abs(r.p / (eos + correction) - 1)).toBeLessThan(0.03)
  }, 240_000)
})
