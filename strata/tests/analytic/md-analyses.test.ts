import { describe, expect, it } from 'vitest'
import type { History } from '../../src/core/quantity'
import { MD_ANALYSES, diffuse, resample } from '../../src/levels/md-analyses'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initTriangular } from '../../src/substrates/md/ref/init'
import { fieldSums, profiles } from '../../src/substrates/md/ref/reducers'

describe('analyses on a concentration history', () => {
  const n = 24
  const dy = 1.5
  const D = 0.2
  const k = (2 * Math.PI) / (n * dy)
  const profile = (t: number) =>
    Float64Array.from({ length: n }, (_, j) => 0.3 + 0.25 * Math.exp(-D * k * k * t) * Math.cos(k * j * dy) + 0.1 * Math.exp(-4 * D * k * k * t) * Math.cos(2 * k * j * dy))
  // Unevenly spaced samples, as the engine records them.
  const times = Array.from({ length: 90 }, (_, i) => i * 0.5 + 0.2 * Math.sin(i))
  const history: History = { t: times, x: Float64Array.from({ length: n }, (_, j) => (j + 0.5) * dy), y: times.map(profile) }

  it('resampling gives equally spaced snapshots that match the data', () => {
    const { data, dt } = resample(history, 30)
    expect(data.length).toBe(30)
    expect(dt * 29).toBeCloseTo(times.at(-1)! - times[0]!, 12)
    const exact = profile(times[0]! + 10 * dt)
    for (let j = 0; j < n; j++) expect(Math.abs(data[10]![j]! - exact[j]!)).toBeLessThan(2e-3)
  })

  it('spectral diffusion matches the analytic decay of each mode', () => {
    const out = diffuse(profile(0), D, 7, dy)
    const exact = profile(7)
    for (let j = 0; j < n; j++) expect(out[j]!).toBeCloseTo(exact[j]!, 10)
  })

  it('the SINDy analysis reports the diffusion equation and a matching forward prediction', () => {
    const r = MD_ANALYSES.find((a) => a.id === 'sindy')!.compute(history, {})!
    const fitted = Number(/= ([\d.]+) ∂²c/.exec(r.headline)![1])
    expect(Math.abs(fitted / D - 1)).toBeLessThan(0.02)
    expect(r.headline).not.toContain('+')
    for (let j = 0; j < n; j++) expect(Math.abs(r.theory!.y[j]! - r.curve!.y[j]!)).toBeLessThan(5e-3)
  })

  it('the DMD analysis finds the decay rates D k² and 4 D k² of the two modes present', () => {
    const r = MD_ANALYSES.find((a) => a.id === 'dmd')!.compute(history, {})!
    expect(Math.abs(r.curve!.y[0]! / (D * k * k) - 1)).toBeLessThan(0.02)
    expect(Math.abs(r.curve!.y[1]! / (4 * D * k * k) - 1)).toBeLessThan(0.02)
    expect(Math.abs(r.theory!.y[1]! / r.theory!.y[0]! - 4)).toBeLessThan(1e-9)
  })
})

describe('stripe layout', () => {
  it('puts species B in a central band holding the requested fraction', () => {
    const s = initTriangular({ nx: 60, density: 0.6, temperature: 1, seed: 1, fractionB: 0.3, aspect: 6, stripe: true }, analyticPair(LJ))
    expect(s.box[0]! / s.box[1]!).toBeGreaterThan(4.5)
    let nB = 0
    for (let i = 0; i < s.n; i++) {
      nB += s.species[i]!
      if (s.species[i]) expect(Math.abs(s.pos[2 * i + 1]! / s.box[1]! - 0.5)).toBeLessThan(0.16)
    }
    expect(Math.abs(nB / s.n - 0.3)).toBeLessThan(0.1)
    const c = profiles(fieldSums(s), s.box, 12).fractionB
    expect(c[0]).toBe(0)
    expect(c[6]).toBe(1)
  })
})
