import { describe, expect, it } from 'vitest'
import { agreement, type QuantityDef } from '../../src/core/quantity'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initTriangular } from '../../src/substrates/md/ref/init'
import { psi6, scalars } from '../../src/substrates/md/ref/reducers'
import { createState, step } from '../../src/substrates/md/ref/step'

const pair = analyticPair(LJ)

describe('hexatic order', () => {
  it('is exactly 1 on a perfect triangular lattice, locally and globally', () => {
    const s = initTriangular({ nx: 20, density: 0.9, temperature: 0, seed: 1 }, pair)
    const sc = scalars(s)
    expect(sc.psi6Local).toBeCloseTo(1, 10)
    expect(sc.psi6Global).toBeCloseTo(1, 10)
  })

  it('is low in a liquid, and globally incoherent', () => {
    const s = initTriangular({ nx: 30, density: 0.7, temperature: 1.5, seed: 2 }, pair)
    step(s, pair, 0.004, 3000)
    const sc = scalars(s)
    expect(sc.psi6Local).toBeLessThan(0.55)
    expect(sc.psi6Local).toBeGreaterThan(0.15)
    expect(sc.psi6Global).toBeLessThan(5 / Math.sqrt(s.n))
  })

  it('does not count an isolated pair as ordered', () => {
    const s = createState(2, 2, [20, 20])
    s.pos.set([5, 5, 6.1, 5])
    const psi = psi6(s)
    expect(Math.hypot(psi[0]!, psi[1]!)).toBeCloseTo(1 / 6, 12)
  })

  it('a rotated lattice keeps |ψ6| = 1 but changes its phase', () => {
    // 两个粒子的键在角度 θ 处贡献 exp(6iθ)：旋转 30° 使符号翻转。
    // Two particles' bond at angle θ contributes exp(6iθ): rotating by 30° flips the sign.
    const a = createState(2, 2, [20, 20])
    a.pos.set([5, 5, 6, 5])
    const b = createState(2, 2, [20, 20])
    b.pos.set([5, 5, 5 + Math.cos(Math.PI / 6), 5 + Math.sin(Math.PI / 6)])
    expect(psi6(a)[0]! * 6).toBeCloseTo(1, 12)
    expect(psi6(b)[0]! * 6).toBeCloseTo(-1, 12)
  })
})

describe('agreement between measurement and theory', () => {
  const q = (tolerance?: { abs?: number; rel?: number }) => ({ tolerance }) as QuantityDef<never>

  it('scalars use abs + rel * |theory|', () => {
    expect(agreement(q({ abs: 0.1 }), 1.05, 1)).toBe('agree')
    expect(agreement(q({ abs: 0.1 }), 1.2, 1)).toBe('differ')
    expect(agreement(q({ rel: 0.1 }), 10.9, 10)).toBe('agree')
    expect(agreement(q({ rel: 0.1 }), 11.1, 10)).toBe('differ')
  })

  it('is undefined without a theory or a tolerance', () => {
    expect(agreement(q({ abs: 1 }), 1, null)).toBe('none')
    expect(agreement(q(), 1, 1)).toBe('none')
    expect(agreement(q({ abs: 1 }), 1, NaN)).toBe('none')
  })

  it('curves compare summed absolute difference to summed theory', () => {
    const x = [0, 1, 2]
    expect(agreement(q({ rel: 0.1 }), { x, y: [1, 2, 3.2] }, { x, y: [1, 2, 3] })).toBe('agree')
    expect(agreement(q({ rel: 0.1 }), { x, y: [1, 2, 4] }, { x, y: [1, 2, 3] })).toBe('differ')
  })
})
