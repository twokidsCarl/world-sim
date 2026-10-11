import { describe, expect, it } from 'vitest'
import { defaults } from '../../src/core/params'
import { MdCpuBackend } from '../../src/substrates/md/backend-cpu'
import { LJ, buildTable, repulsivePotential, speciesField, speciesTables, wellPosition } from '../../src/substrates/md/potential'
import { initChains } from '../../src/substrates/md/ref/init'
import { aggregates } from '../../src/substrates/md/ref/reducers'
import { computeForces, kineticEnergy, momentum, step } from '../../src/substrates/md/ref/step'
import { BOND_K, BOND_R0, MD_KNOBS, chainOf, repulsiveMatrix, strengthMatrix } from '../../src/substrates/md/schema'

/** 头只有排斥，尾–尾相吸。 / Heads only repel; tails attract each other. */
const field = (epsTT: number) => speciesField(speciesTables(LJ, [[1, 1], [1, epsTT]], 2048, [[true, true], [true, false]]))
const chains = (chain: number, density = 0.2, temperature = 1) =>
  initChains({ nx: 24, density, temperature, seed: 4, chain, bondK: BOND_K, bondR0: BOND_R0 }, field(2))

describe('repulsive half of a pair potential', () => {
  it('is cut at the bottom of the well, non-negative, and continuous there', () => {
    const rm = wellPosition(LJ)
    expect(rm).toBeCloseTo(Math.pow(2, 1 / 6), 6)
    expect(repulsivePotential(LJ, rm + 1e-6)).toEqual({ u: 0, f: 0 })
    expect(repulsivePotential(LJ, rm - 1e-6).u).toBeLessThan(1e-9)
    expect(Math.abs(repulsivePotential(LJ, rm - 1e-6).f)).toBeLessThan(1e-3)
    // r = σ 处完整的势为 0，所以排斥的那一半等于阱深 ε。 / At r = σ the full potential is 0, so the repulsive half equals the well depth ε.
    expect(repulsivePotential(LJ, 1).u).toBeCloseTo(1, 10)
    const table = buildTable(LJ, 2048, 0.5, true)
    for (const u of table.u) expect(u).toBeGreaterThanOrEqual(0)
    expect(wellPosition({ kind: 'soft', epsilon: 1, sigma: 1, n: 12, rc: 1.5 })).toBe(1.5)
  })
})

describe('bonded amphiphiles', () => {
  it('start with every bond at its rest length, heads first, at the requested density', () => {
    const s = chains(3)
    expect(s.n % 3).toBe(0)
    expect(s.n / (s.box[0]! * s.box[1]!)).toBeCloseTo(0.2, 10)
    for (let i = 0; i < s.n; i++) {
      expect(s.species[i]).toBe(i % 3 === 0 ? 0 : 1)
      if ((i + 1) % 3 !== 0) expect(Math.hypot(s.pos[2 * i]! - s.pos[2 * i + 2]!, s.pos[2 * i + 1]! - s.pos[2 * i + 3]!)).toBeCloseTo(BOND_R0, 10)
    }
  })

  it('bond forces are minus the gradient of the total potential energy', () => {
    const s = chains(3)
    step(s, field(2), 0.004, 300)
    computeForces(s, field(2))
    const h = 1e-6
    for (const k of [0, 3, 8, 17, 40]) {
      const x = s.pos[k]!
      const f = s.force[k]!
      s.pos[k] = x + h
      computeForces(s, field(2))
      const up = s.pe
      s.pos[k] = x - h
      computeForces(s, field(2))
      const down = s.pe
      s.pos[k] = x
      // 势表按 r² 线性插值，力和势的导数只在表的精度内一致。
      // The table interpolates linearly in r², so force and energy derivative agree only to the table's accuracy.
      expect(Math.abs(f + (up - down) / (2 * h))).toBeLessThan(2e-2 * (1 + Math.abs(f)))
    }
  })

  it('conserve energy and momentum, and keep the bonds between the rest length and the contact distance', () => {
    const s = chains(4)
    step(s, field(2), 0.002, 500)
    const e0 = kineticEnergy(s) + s.pe
    step(s, field(2), 0.002, 2000)
    expect(Math.abs(kineticEnergy(s) + s.pe - e0) / s.n).toBeLessThan(2e-3)
    for (const p of momentum(s)) expect(Math.abs(p)).toBeLessThan(1e-9)
    let mean = 0
    let bonds = 0
    for (let i = 0; i + 1 < s.n; i++) {
      if ((i + 1) % 4 === 0) continue
      let dx = s.pos[2 * i]! - s.pos[2 * i + 2]!
      let dy = s.pos[2 * i + 1]! - s.pos[2 * i + 3]!
      dx -= s.box[0]! * Math.round(dx / s.box[0]!)
      dy -= s.box[1]! * Math.round(dy / s.box[1]!)
      const r = Math.hypot(dx, dy)
      expect(r).toBeGreaterThan(0.6)
      expect(r).toBeLessThan(1.5)
      mean += r
      bonds++
    }
    // 成键的两个珠子之间还有对势的排斥（在 2^(1/6) ≈ 1.12 以内），所以平均键长比弹簧的平衡长度略长。
    // Bonded beads also repel through the pair potential (inside 2^(1/6) ≈ 1.12), so the mean bond is a little longer than the spring's rest length.
    expect(mean / bonds).toBeGreaterThan(BOND_R0)
    expect(mean / bonds).toBeLessThan(Math.pow(2, 1 / 6) + 0.03)
  })

  it('the knob builds chains in the backend and reports aggregate statistics', () => {
    const p = { ...defaults(MD_KNOBS), chain: 3, nx: 30, density: 0.2, temperature: 1, epsBB: 2, thermostat: 1 }
    expect(chainOf(p)).toBe(3)
    expect(chainOf({ ...p, dim: 3 })).toBe(0)
    expect(strengthMatrix(p)).toEqual([
      [1, 1],
      [1, 2],
    ])
    expect(repulsiveMatrix(p)![1]![1]).toBe(false)
    const b = new MdCpuBackend(p, 1)
    expect(b.state.chain).toBe(3)
    b.step(100)
    const f = b.reduce(['scalars', 'aggregates'])
    expect(f.aggregates!.molecules).toBe(b.n / 3)
    expect(f.aggregates!.sizes.reduce((a, c) => a + c, 0)).toBeCloseTo(1, 12)
    expect(new MdCpuBackend({ ...p, chain: 0 }, 1).reduce(['aggregates']).aggregates).toBeUndefined()
  })
})

describe('aggregate statistics', () => {
  it('count molecules joined through their tails, across the periodic boundary too', () => {
    // 五个二珠分子（头、尾）。尾珠：A(1,1)、B(2,1) 相邻；C(9.6,5)、D(0.3,5) 隔着边界相邻；E 独自一个。
    // Five two-bead molecules (head, tail). Tails: A(1,1) and B(2,1) are neighbours; C(9.6,5) and D(0.3,5)
    // are neighbours across the boundary; E is alone.
    const pos = [1, 2, 1, 1, 2, 2, 2, 1, 9.6, 6, 9.6, 5, 0.3, 6, 0.3, 5, 5, 8, 5, 9]
    const a = aggregates(pos, 2, 10, 2, [10, 10])
    expect(a.molecules).toBe(5)
    expect(a.free).toBeCloseTo(1 / 5, 12)
    expect(a.largest).toBe(2)
    expect(a.mean).toBeCloseTo((2 * 2 + 2 * 2 + 1) / 5, 12)
    expect(Array.from(a.sizes.slice(0, 3))).toEqual([0.2, 0.8, 0])
    // 头靠得近不算：把 E 的头放到 A 的头旁边，E 仍然落单。
    // Close heads do not count: with E's head next to A's, E is still on its own.
    pos[16] = 1.2
    pos[17] = 2.2
    expect(aggregates(pos, 2, 10, 2, [10, 10]).free).toBeCloseTo(1 / 5, 12)
  })
})
