import { describe, expect, it } from 'vitest'
import { Correlator, autocorrelation, runningIntegral } from '../../src/analysis/autocorrelation'
import { defaults, type Params } from '../../src/core/params'
import { gaussian } from '../../src/core/rng'
import { MD_QUANTITIES } from '../../src/levels/md'
import { MD_ANALYSES } from '../../src/levels/md-analyses'
import { MdCpuBackend } from '../../src/substrates/md/backend-cpu'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initTriangular } from '../../src/substrates/md/ref/init'
import { computeForces, createState, meanSquareDisplacement, step } from '../../src/substrates/md/ref/step'
import { MD_KNOBS } from '../../src/substrates/md/schema'

const pair = analyticPair(LJ)

describe('autocorrelation', () => {
  // AR(1) 过程 x(t+1) = a x(t) + 噪声：C(k) = C(0) aᵏ，积分为 C(0) (1 + a) / (2 (1 − a))（梯形法）。
  // An AR(1) process x(t+1) = a x(t) + noise has C(k) = C(0) aᵏ, whose trapezoid integral is C(0) (1 + a) / (2 (1 − a)).
  it('recovers the exponential decay of an AR(1) process and its integral', () => {
    const a = 0.9
    const x = new Float64Array(200000)
    for (let i = 1; i < x.length; i++) x[i] = a * x[i - 1]! + gaussian(8, i)
    const c = autocorrelation(x, 80)
    expect(c[0]!).toBeCloseTo(1 / (1 - a * a), 0)
    expect(c[10]! / c[0]!).toBeCloseTo(Math.pow(a, 10), 1)
    const integral = runningIntegral(c, 1)
    expect(Math.abs(integral[80]! / ((c[0]! * (1 + a)) / (2 * (1 - a))) - 1)).toBeLessThan(0.08)
  })
})

describe('accumulating correlator', () => {
  it('agrees with the direct autocorrelation of the same series', () => {
    const x = Float64Array.from({ length: 5000 }, (_, i) => Math.sin(0.1 * i) + 0.5 * gaussian(4, i) + 0.3)
    const c = new Correlator(40)
    for (const v of x) c.add(v)
    const direct = autocorrelation(x, 40)
    const got = c.result()
    expect(c.samples).toBe(5000)
    // 两者对均值的处理略有不同（整体均值对各滞后的局部均值），差别在 1/N 量级。
    // The two treat the mean slightly differently (overall mean against per-lag means), a difference of order 1/N.
    for (let k = 0; k <= 40; k++) expect(Math.abs(got[k]! - direct[k]!)).toBeLessThan(5e-3)
  })
})

describe('displacement and shear stress', () => {
  it('the xy virial is the same from the cell list and from all pairs', () => {
    const a = initTriangular({ nx: 20, density: 0.7, temperature: 1.2, seed: 2 }, pair)
    step(a, pair, 0.004, 100)
    const b = createState(2, a.n, a.box)
    b.pos.set(a.pos)
    computeForces(b, pair, true)
    expect(a.virialXY).toBeCloseTo(b.virialXY, 8)
    expect(Math.abs(a.virialXY)).toBeGreaterThan(1e-3)
  })

  it('displacement is ballistic at first: ⟨Δr²⟩ = d T t²', () => {
    const s = initTriangular({ nx: 30, density: 0.05, temperature: 2, seed: 3 }, pair)
    s.disp = new Float64Array(s.n * 2)
    step(s, pair, 0.002, 20)
    const t = 20 * 0.002
    expect(meanSquareDisplacement(s) / (2 * 2 * t * t)).toBeCloseTo(1, 1)
  })
})

describe('transport coefficients from equilibrium fluctuations', () => {
  const run = (p: Params, steps: number) => {
    const b = new MdCpuBackend(p, 5)
    b.step(1500)
    b.reduce(['transport'])
    const t: number[] = []
    const msd: number[] = []
    let frame = b.reduce(['transport'])
    for (let i = 0; i < steps / 50; i++) {
      b.step(50)
      frame = b.reduce(['transport'])
      t.push(frame.time)
      msd.push(frame.transport!.msd)
    }
    return { frame, t, msd, n: b.n }
  }

  it('self-diffusion from the mean-square displacement', () => {
    // 与“方程发现”场景同一个状态点；那里 SINDy 在 GPU 上拟合出 0.47 到 0.53。
    // The same state point as the equation-discovery scenario, where SINDy fitted 0.47 to 0.53 on the GPU.
    const p: Params = { ...defaults(MD_KNOBS), nx: 30, density: 0.6, temperature: 2, thermostat: 1 }
    const { t, msd, n } = run(p, 12000)
    const analysis = MD_ANALYSES.find((a) => a.id === 'selfDiffusion')!
    const r = analysis.compute({ t, x: [0], y: msd.map((v) => Float64Array.of(v)) }, p, () => undefined)!
    const D = Number(/D = ([\d.]+)/.exec(r.headline)![1])
    console.log(`self-diffusion at ρ = 0.6, T = 2 (N = ${n}): D = ${D}`)
    expect(D).toBeGreaterThan(0.3)
    expect(D).toBeLessThan(0.8)
  }, 240_000)

  it('shear viscosity from the Green–Kubo integral', () => {
    // 与管道流场景同一个状态点；那里由流量反推的粘度约 1.4 到 1.5。
    // 60 个时间单位的记录给出的 η 可以相差一倍，所以这里累计 300 个时间单位。
    // The same state point as the channel-flow scenario, where the viscosity inferred from
    // the flow rate was about 1.4 to 1.5. A record of 60 time units can be off by a factor
    // of two, so 300 time units are accumulated here.
    const p: Params = { ...defaults(MD_KNOBS), nx: 30, density: 0.7, temperature: 1, thermostat: 1 }
    const { frame, n } = run(p, 60000)
    const q = MD_QUANTITIES.find((d) => d.id === 'gkViscosity')!
    const curve = q.compute(frame, p) as { x: Float64Array; y: Float64Array }
    const at = (tau: number) => curve.y[curve.x.findIndex((x) => x >= tau)]!
    console.log(`Green–Kubo viscosity at ρ = 0.7, T = 1 (N = ${n}, ${frame.transport!.samples} steps): η(0.5) = ${at(0.5).toFixed(3)}, η(1) = ${at(1).toFixed(3)}, η(2) = ${at(2).toFixed(3)}, η(3) = ${curve.y[curve.y.length - 1]!.toFixed(3)}`)
    expect(curve.x.length).toBeGreaterThan(50)
    expect(at(1)).toBeGreaterThan(1.0)
    expect(at(1)).toBeLessThan(2.2)
  }, 600_000)
})
