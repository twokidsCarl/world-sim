import { describe, expect, it } from 'vitest'
import { dmd } from '../../src/analysis/dmd'
import { eigenvalues, leastSquares, symmetricEigen } from '../../src/analysis/linalg'
import { DIFFUSION_LIBRARY, equationText, weakSindy } from '../../src/analysis/sindy'
import { gaussian, uniform } from '../../src/core/rng'

describe('linear algebra', () => {
  it('symmetric eigen-decomposition reproduces a known spectrum', () => {
    const { values, vectors } = symmetricEigen([
      [2, 1, 0],
      [1, 2, 1],
      [0, 1, 2],
    ])
    expect(values[0]).toBeCloseTo(2 + Math.SQRT2, 12)
    expect(values[1]).toBeCloseTo(2, 12)
    expect(values[2]).toBeCloseTo(2 - Math.SQRT2, 12)
    // 中间的本征向量是 (1, 0, -1) / √2。 / The middle eigenvector is (1, 0, -1) / √2.
    expect(Math.abs(vectors[1]![1]!)).toBeLessThan(1e-12)
    expect(Math.abs(vectors[0]![1]! + vectors[2]![1]!)).toBeLessThan(1e-12)
  })

  it('eigenvalues of a non-symmetric matrix, including a complex pair', () => {
    // 分块对角：一个旋转–缩放块（0.9 e^{±0.5i}）和一个实本征值 0.5。
    // Block diagonal: a rotation-scaling block (0.9 e^{±0.5i}) and a real eigenvalue 0.5.
    const c = 0.9 * Math.cos(0.5)
    const s = 0.9 * Math.sin(0.5)
    const ev = eigenvalues([
      [c, -s, 0],
      [s, c, 0],
      [0, 0, 0.5],
    ]).sort((a, b) => a.im - b.im)
    expect(ev[0]!.re).toBeCloseTo(c, 10)
    expect(ev[0]!.im).toBeCloseTo(-s, 10)
    expect(ev[1]!.re).toBeCloseTo(0.5, 10)
    expect(Math.abs(ev[1]!.im)).toBeLessThan(1e-10)
    expect(ev[2]!.im).toBeCloseTo(s, 10)
  })

  it('least squares recovers a linear relation', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [1, i, i * i])
    const w = leastSquares(
      rows,
      rows.map((r) => 3 - 2 * r[1]! + 0.5 * r[2]!),
    )
    expect(w[0]).toBeCloseTo(3, 8)
    expect(w[1]).toBeCloseTo(-2, 8)
    expect(w[2]).toBeCloseTo(0.5, 8)
  })
})

describe('dynamic mode decomposition', () => {
  it('recovers the decay rates and frequency of a sum of damped modes', () => {
    const m = 24
    const dt = 0.1
    const snapshots = Array.from({ length: 60 }, (_, t) =>
      Float64Array.from({ length: m }, (_, j) => {
        const y = (2 * Math.PI * j) / m
        const time = t * dt
        return (
          1 +
          Math.exp(-0.3 * time) * Math.cos(y) +
          0.5 * Math.exp(-1.2 * time) * Math.cos(2 * y) +
          0.7 * Math.exp(-0.05 * time) * Math.cos(3 * y - 2 * time)
        )
      }),
    )
    // 秩：常数项、两个实模态和一个行波（一对复共轭）。
    // Rank: the constant, two real modes, and a travelling wave (a complex pair).
    const { rates } = dmd(snapshots, dt, 5)
    expect(rates.length).toBe(5)
    expect(rates[0]!.re).toBeCloseTo(0, 6)
    expect(rates[1]!.re).toBeCloseTo(-0.05, 6)
    expect(rates[2]!.re).toBeCloseTo(-0.05, 6)
    expect(Math.abs(rates[1]!.im)).toBeCloseTo(2, 6)
    expect(rates[3]!.re).toBeCloseTo(-0.3, 6)
    expect(rates[4]!.re).toBeCloseTo(-1.2, 6)
  })
})

describe('weak-form SINDy', () => {
  it('recovers the heat equation from noiseless data', () => {
    const D = 0.02
    const ny = 32
    const dy = 1 / ny
    const dt = 0.05
    const data = Array.from({ length: 80 }, (_, t) =>
      Float64Array.from({ length: ny }, (_, j) => {
        const y = j * dy
        const k = 2 * Math.PI
        return 0.3 + 0.2 * Math.exp(-D * k * k * t * dt) * Math.cos(k * y) + 0.1 * Math.exp(-D * 4 * k * k * t * dt) * Math.sin(2 * k * y)
      }),
    )
    const r = weakSindy(data, dt, dy)
    expect(Math.abs(r.coefficients[0]! / D - 1)).toBeLessThan(0.01)
    for (let i = 1; i < DIFFUSION_LIBRARY.length; i++) expect(r.coefficients[i]).toBe(0)
    expect(r.r2).toBeGreaterThan(0.999)
    expect(equationText(r)).toBe('∂c/∂t = 0.0200 ∂²c/∂y²')
  })

  it('discovers the diffusion equation and its coefficient from random walkers', () => {
    const walkers = 100000
    const ny = 24
    const step = 0.004
    const dt = 1
    const D = (step * step) / (2 * dt)
    // 行走者从一条带出发，这条带占周期单位区间的四分之一。
    // Walkers start in a stripe covering a quarter of the periodic unit interval.
    const x = Float64Array.from({ length: walkers }, (_, i) => 0.375 + 0.25 * uniform(1, i))
    const data: Float64Array[] = []
    for (let t = 0; t < 2000; t++) {
      if (t % 20 === 0) {
        const hist = new Float64Array(ny)
        for (let i = 0; i < walkers; i++) hist[Math.floor(x[i]! * ny)]! += ny / walkers
        data.push(hist)
      }
      for (let i = 0; i < walkers; i++) {
        const next = x[i]! + step * gaussian(2 + t, i)
        x[i] = next - Math.floor(next)
      }
    }
    const r = weakSindy(data, 20 * dt, 1 / ny)
    expect(Math.abs(r.coefficients[0]! / D - 1)).toBeLessThan(0.05)
    for (let i = 1; i < DIFFUSION_LIBRARY.length; i++) expect(r.coefficients[i]).toBe(0)
    expect(r.r2).toBeGreaterThan(0.98)
  })
})
