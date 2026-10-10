import { describe, expect, it } from 'vitest'
import {
  LJ,
  analyticPair,
  buildTable,
  rawPotential,
  shiftedPotential,
  tablePair,
  type PotentialSpec,
} from '../../src/substrates/md/potential'

const specs: PotentialSpec[] = [
  LJ,
  { kind: 'mie', epsilon: 1.3, sigma: 0.9, n: 9, m: 6, rc: 2.2 },
  { kind: 'morse', epsilon: 1, r0: 1.1, a: 5, rc: 2.5 },
  { kind: 'soft', epsilon: 1, sigma: 1, n: 12, rc: 1.5 },
]

describe('pair potentials', () => {
  it('Lennard-Jones has its minimum at 2^(1/6) sigma with depth epsilon', () => {
    const rm = Math.pow(2, 1 / 6)
    const a = rawPotential(LJ, rm)
    expect(a.u).toBeCloseTo(-1, 12)
    expect(a.du).toBeCloseTo(0, 12)
    expect(rawPotential(LJ, 1).u).toBeCloseTo(0, 12)
  })

  it('general Mie potential is normalised to well depth epsilon', () => {
    const spec = specs[1] as Extract<PotentialSpec, { kind: 'mie' }>
    const rm = spec.sigma * Math.pow(spec.n / spec.m, 1 / (spec.n - spec.m))
    expect(rawPotential(spec, rm).u).toBeCloseTo(-spec.epsilon, 12)
    expect(rawPotential(spec, rm).du).toBeCloseTo(0, 11)
  })

  it.each(specs)('$kind: force-shifted u and f vanish at the cutoff', (spec) => {
    const eps = 1e-7
    const s = shiftedPotential(spec, spec.rc - eps)
    expect(Math.abs(s.u)).toBeLessThan(1e-12)
    expect(Math.abs(s.f)).toBeLessThan(1e-5)
    expect(shiftedPotential(spec, spec.rc + eps)).toEqual({ u: 0, f: 0 })
  })

  it.each(specs)('$kind: f equals -du/dr', (spec) => {
    const h = 1e-5
    for (let r = 0.85; r < spec.rc - 0.01; r += 0.037) {
      const num = -(shiftedPotential(spec, r + h).u - shiftedPotential(spec, r - h).u) / (2 * h)
      const f = shiftedPotential(spec, r).f
      expect(Math.abs(f - num)).toBeLessThan(1e-6 * (1 + Math.abs(f)))
    }
  })

  it.each(specs)('$kind: table interpolation matches the analytic form', (spec) => {
    const exact = analyticPair(spec)
    const table = tablePair(buildTable(spec))
    const a = { g: 0, u: 0 }
    const b = { g: 0, u: 0 }
    // Scale for the absolute part of the tolerance: values near the zero crossings are tiny.
    const ref = { g: 0, u: 0 }
    exact.eval(1, ref)
    for (let r = 0.85; r < spec.rc; r += 0.0113) {
      exact.eval(r * r, a)
      table.eval(r * r, b)
      expect(Math.abs(a.g - b.g)).toBeLessThan(1e-3 * Math.abs(a.g) + 1e-4 * Math.abs(ref.g))
      expect(Math.abs(a.u - b.u)).toBeLessThan(1e-3 * Math.abs(a.u) + 1e-4)
    }
  })
})
