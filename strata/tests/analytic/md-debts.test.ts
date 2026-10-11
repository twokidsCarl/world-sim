import { describe, expect, it } from 'vitest'
import { defaults, type Params } from '../../src/core/params'
import { MD_QUANTITIES } from '../../src/levels/md'
import { compressibilityLimit } from '../../src/levels/md-analyses'
import type { MdFrame } from '../../src/substrates/md/backend-cpu'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initTriangular } from '../../src/substrates/md/ref/init'
import { fieldGrid } from '../../src/substrates/md/ref/reducers'
import { temperature } from '../../src/substrates/md/ref/step'
import { MD_KNOBS } from '../../src/substrates/md/schema'
import { secondVirial } from '../../src/theory/virial'

const pair = analyticPair(LJ)

describe('temperature', () => {
  // 给所有粒子加同一个速度不改变温度：整体流动不是热。
  // Adding the same velocity to every particle does not change the temperature: bulk flow is not heat.
  it('ignores bulk flow', () => {
    const s = initTriangular({ nx: 20, density: 0.6, temperature: 1.3, seed: 2 }, pair)
    const before = temperature(s)
    for (let i = 0; i < s.n; i++) {
      s.vel[2 * i]! += 5
      s.vel[2 * i + 1]! -= 2
    }
    expect(temperature(s)).toBeCloseTo(before, 10)
    expect(before).toBeCloseTo(1.3, 12)
  })
})

describe('vorticity field', () => {
  // 人为构造的剪切流 uₓ = γ y：涡量处处为 −γ。
  // A constructed shear flow uₓ = γ y: the vorticity is −γ everywhere.
  it('of a uniform shear flow is minus the shear rate', () => {
    const box = [80, 20, 1]
    const [gx, gy] = fieldGrid(box)
    const gamma = 0.05
    const cells = gx * gy
    const field = {
      gx,
      gy,
      count: new Float64Array(cells).fill(10),
      vx: Float64Array.from({ length: cells }, (_, c) => 10 * gamma * ((Math.floor(c / gx) + 0.5) / gy) * box[1]!),
      vy: new Float64Array(cells),
      v2: new Float64Array(cells),
      countB: new Float64Array(cells),
    }
    const q = MD_QUANTITIES.find((d) => d.id === 'vorticity')!
    const out = q.compute({ field, box } as unknown as MdFrame, {}) as unknown as { data: ArrayLike<number>; signed: boolean }
    expect(out.signed).toBe(true)
    for (const w of Array.from(out.data)) expect(w).toBeCloseTo(-gamma, 10)
  })
})

describe('long-wavelength limit of the structure factor', () => {
  const base: Params = { ...defaults(MD_KNOBS), rc: 4 }

  it('is defined only where the published equation of state applies', () => {
    expect(compressibilityLimit({ ...base, rc: 2.5, density: 0.5 }, 2)).toBeNull()
    expect(compressibilityLimit({ ...base, density: 0.5, walls: 1 }, 2)).toBeNull()
    expect(compressibilityLimit({ ...base, density: 0.5, dim: 3 }, 2)).toBeNull()
    expect(compressibilityLimit({ ...base, density: 0.5 }, 2)).not.toBeNull()
  })

  it('tends to the virial result 1 / (1 + 2 B2 ρ) at low density', () => {
    const T = 2
    const density = 0.02
    const s0 = compressibilityLimit({ ...base, density }, T)!
    // 这里的 B2 取完整势的（状态方程针对完整势），截断修正另算，差别在 ρ² 量级。
    // B2 here is that of the full potential (which the equation of state describes); the
    // cutoff correction comes on top and differs at order ρ².
    const b2 = secondVirial({ ...LJ, rc: 30 }, T, 2, 40000)
    expect(Math.abs(s0 / (1 / (1 + 2 * b2 * density)) - 1)).toBeLessThan(0.01)
  })

  it('a dense fluid is much less compressible than an ideal gas', () => {
    expect(compressibilityLimit({ ...base, density: 0.7 }, 1)!).toBeLessThan(0.1)
  })
})
