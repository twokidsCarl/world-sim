import { describe, expect, it } from 'vitest'
import { uniform } from '../../src/core/rng'
import { computeAccelerations, createMesh, fft3d, initMesh, meshScalars, step } from '../../src/substrates/mesh/ref'
import { JEANS_RATE, besselJ1, crossingTime, meshForceFactor, zeldovichMode } from '../../src/theory/jeans'

describe('3D FFT', () => {
  it('matches a direct Fourier sum and inverts itself', () => {
    const M = 8
    const cells = M ** 3
    const a = new Float64Array(2 * cells)
    for (let i = 0; i < 2 * cells; i++) a[i] = uniform(3, i) - 0.5
    const original = a.slice()
    const out = fft3d(a, new Float64Array(2 * cells), M, -1).slice()
    for (const [kx, ky, kz] of [
      [0, 0, 0],
      [1, 0, 0],
      [3, 5, 2],
      [7, 7, 1],
    ] as const) {
      let re = 0
      let im = 0
      for (let z = 0; z < M; z++) {
        for (let y = 0; y < M; y++) {
          for (let x = 0; x < M; x++) {
            const c = x + M * (y + M * z)
            const angle = (-2 * Math.PI * (kx * x + ky * y + kz * z)) / M
            re += original[2 * c]! * Math.cos(angle) - original[2 * c + 1]! * Math.sin(angle)
            im += original[2 * c]! * Math.sin(angle) + original[2 * c + 1]! * Math.cos(angle)
          }
        }
      }
      const c = kx + M * (ky + M * kz)
      expect(out[2 * c]).toBeCloseTo(re, 9)
      expect(out[2 * c + 1]).toBeCloseTo(im, 9)
    }
    const back = fft3d(out, new Float64Array(2 * cells), M, 1)
    for (let i = 0; i < 2 * cells; i++) expect(back[i]! / cells).toBeCloseTo(original[i]!, 10)
  })
})

describe('Jeans theory helpers', () => {
  it('Bessel J₁ and the mesh force factor have their known values', () => {
    expect(besselJ1(1)).toBeCloseTo(0.4400505857, 9)
    expect(besselJ1(0.1)).toBeCloseTo(0.0499375260, 9)
    expect(meshForceFactor(1, 64)).toBeGreaterThan(0.995)
    expect(meshForceFactor(1, 64)).toBeLessThan(1)
    expect(crossingTime(0.01, JEANS_RATE)).toBeCloseTo(Math.log(100) / Math.sqrt(4 * Math.PI), 12)
  })
})

describe('particle-mesh gravity reference', () => {
  it('a uniform lattice feels no force', () => {
    const s = initMesh(16, 16, 0, 0, 1)
    let max = 0
    for (const a of s.acc) max = Math.max(max, Math.abs(a))
    expect(max).toBeLessThan(1e-10)
    expect(meshScalars(s).sigma).toBeLessThan(1e-12)
  })

  it('the potential of one density wave is −4π δ / k², weakened by the known mesh factor', () => {
    // 粒子就放在格点上（每个格点一个），再按平面波挪动一点。
    // One particle per grid point, displaced slightly by a plane wave.
    const M = 32
    const amplitude = 1e-3
    const s = initMesh(M, M, 0, amplitude, 1)
    // 线性理论：加速度 = 4π ψ（指向密度高处），ψ_x = −A sin(2πq) / 2π，即 a_x = −2A sin(2πq)。
    // Linear theory: acceleration = 4π ψ (towards the overdensity); with ψ_x = −A sin(2πq) / 2π, a_x = −2A sin(2πq).
    const factor = meshForceFactor(1, M)
    let worst = 0
    for (let i = 0; i < s.n; i += 97) {
      const q = ((i % M) + 0.5) / M
      const expected = -2 * amplitude * Math.sin(2 * Math.PI * q) * factor
      worst = Math.max(worst, Math.abs(s.acc[3 * i]! - expected))
      expect(Math.abs(s.acc[3 * i + 1]!)).toBeLessThan(1e-9)
    }
    expect(worst).toBeLessThan(2e-3 * 2 * amplitude)
  })

  it('two bodies attract with the inverse-square law at separations of several cells', () => {
    const M = 64
    for (const [dx, dy, dz] of [
      [6, 0, 0],
      [4, 4, 3],
      [0, 7.5, 2.2],
    ] as const) {
      const s = createMesh(2, M)
      s.pos.set([0.3103, 0.4207, 0.5311, 0.3103 + dx / M, 0.4207 + dy / M, 0.5311 + dz / M])
      computeAccelerations(s)
      const r = Math.hypot(dx, dy, dz) / M
      // 每个粒子质量 1/2。 / Each particle has mass 1/2.
      const expected = 0.5 / (r * r)
      const towards = (s.acc[0]! * dx + s.acc[1]! * dy + s.acc[2]! * dz) / Math.hypot(dx, dy, dz)
      expect(Math.abs(towards / expected - 1)).toBeLessThan(0.06)
      // 作用力与反作用力相等：总动量守恒。 / Action equals reaction: total momentum is conserved.
      for (let d = 0; d < 3; d++) expect(Math.abs(s.acc[d]! + s.acc[3 + d]!)).toBeLessThan(1e-9 * expected)
    }
  })

  it('a plane wave grows at the Jeans rate and follows the Zel’dovich solution up to shell crossing', () => {
    const M = 32
    const a0 = 0.02
    const s = initMesh(M, M, 0, a0, 1)
    const rate = JEANS_RATE * Math.sqrt(meshForceFactor(1, M))
    const dt = 0.002
    const tc = crossingTime(a0, rate)
    let worst = 0
    let measured = 0
    while (s.time < 0.9 * tc) {
      step(s, dt, 25)
      const mode = meshScalars(s).mode
      worst = Math.max(worst, Math.abs(mode / zeldovichMode(a0, rate, s.time).amplitude - 1))
      if (measured === 0 && s.time > 0.5) measured = Math.log(mode / (2 * besselJ1(a0))) / s.time
    }
    console.log(`plane wave: growth rate ${measured.toFixed(4)} against √(4π) = ${JEANS_RATE.toFixed(4)} (mesh-corrected ${rate.toFixed(4)}); worst deviation from Zel'dovich ${(100 * worst).toFixed(2)}%`)
    expect(Math.abs(measured / JEANS_RATE - 1)).toBeLessThan(0.02)
    expect(worst).toBeLessThan(0.03)
    // 总动量保持为零；横向没有运动。 / Total momentum stays zero; nothing moves sideways.
    const sc = meshScalars(s)
    expect(sc.momentum).toBeLessThan(1e-12)
    for (let i = 0; i < s.n; i += 53) expect(Math.abs(s.vel[3 * i + 1]!)).toBeLessThan(1e-9)
    // 越过壳层交叉之后，网格上的峰值密度远高于平均。 / Past shell crossing the peak density on the grid is far above the mean.
    while (s.time < 1.1 * tc) step(s, dt, 25)
    expect(meshScalars(s).peak).toBeGreaterThan(5)
  }, 120_000)

  it('a random field grows at the Jeans rate while it is linear and conserves momentum', () => {
    const s = initMesh(32, 32, 1, 0.02, 7)
    const before = meshScalars(s)
    // 纯增长模里动能等于势能的大小：总能量为零。 / In the pure growing mode the kinetic energy equals the size of the potential energy: zero total energy.
    expect(Math.abs(before.ke / -before.pe - 1)).toBeLessThan(0.03)
    step(s, 0.002, 150)
    const after = meshScalars(s)
    const rate = Math.log(after.sigma / before.sigma) / s.time
    console.log(`random field: σ ${before.sigma.toFixed(4)} → ${after.sigma.toFixed(4)}, rate ${rate.toFixed(3)} against ${JEANS_RATE.toFixed(3)}`)
    expect(Math.abs(before.sigma / 0.02 - 1)).toBeLessThan(0.2)
    expect(Math.abs(rate / JEANS_RATE - 1)).toBeLessThan(0.08)
    expect(after.momentum).toBeLessThan(1e-12)
  }, 120_000)
})
