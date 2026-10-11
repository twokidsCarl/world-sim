import { describe, expect, it } from 'vitest'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initTriangular } from '../../src/substrates/md/ref/init'
import { reverseTime, stepReversible, toReversible } from '../../src/substrates/md/ref/reversible'
import { kineticEnergy, step } from '../../src/substrates/md/ref/step'

const pair = analyticPair(LJ)
const fresh = () => initTriangular({ nx: 16, density: 0.7, temperature: 1.2, seed: 9 }, pair)

describe('bit-reversible integrator', () => {
  it('returns to the starting state exactly after running forward and back', () => {
    const r = toReversible(fresh(), pair, 0.005)
    const x0 = r.x.slice()
    stepReversible(r, pair, 0.005, 1)
    const x1 = r.x.slice()
    stepReversible(r, pair, 0.005, 2999)
    // 系统已经熔化：它离起点很远。 / The system has melted: it is nowhere near where it started.
    let moved = 0
    for (let k = 0; k < x0.length; k++) moved = Math.max(moved, Math.abs(r.x[k]! - x0[k]!))
    expect(moved).toBeGreaterThan(2 ** 32)
    const here = r.x.slice()
    reverseTime(r, pair, 0.005)
    // 反转不会移动任何东西。 / Reversing does not move anything.
    expect(r.x).toEqual(here)
    expect(r.md.step).toBe(3000)
    stepReversible(r, pair, 0.005, 3000)
    // 回到第 0 步，并以第 1 步作为“上一”时间层，因为时间在倒流。
    // Back at step 0, with step 1 as the "previous" level because time runs backwards.
    expect(r.x).toEqual(x0)
    expect(r.xPrev).toEqual(x1)
  })

  it('reversing twice continues the original trajectory', () => {
    const a = toReversible(fresh(), pair, 0.005)
    const b = toReversible(fresh(), pair, 0.005)
    stepReversible(a, pair, 0.005, 200)
    stepReversible(b, pair, 0.005, 100)
    reverseTime(b, pair, 0.005)
    reverseTime(b, pair, 0.005)
    stepReversible(b, pair, 0.005, 100)
    expect(b.x).toEqual(a.x)
    expect(b.xPrev).toEqual(a.xPrev)
  })

  it('an ordinary floating-point integrator does not come back', () => {
    const s = fresh()
    const pos0 = s.pos.slice()
    step(s, pair, 0.005, 3000)
    for (let k = 0; k < s.vel.length; k++) s.vel[k] = -s.vel[k]!
    step(s, pair, 0.005, 3000)
    let off = 0
    for (let k = 0; k < pos0.length; k++) {
      const L = s.box[k % 2]!
      const d = s.pos[k]! - pos0[k]!
      off = Math.max(off, Math.abs(d - L * Math.round(d / L)))
    }
    // 混沌在 15 个时间单位内放大舍入误差，直到轨迹丢失。
    // Chaos amplifies the rounding error over 15 time units until the trajectory is lost.
    expect(off).toBeGreaterThan(0.1)
  })

  it('conserves energy to second order like velocity Verlet', () => {
    const fluctuation = (dt: number) => {
      const r = toReversible(fresh(), pair, dt)
      stepReversible(r, pair, dt, Math.round(2 / dt))
      const e: number[] = []
      for (let i = 0; i < Math.round(4 / dt); i++) {
        stepReversible(r, pair, dt)
        e.push(kineticEnergy(r.md) + r.md.pe)
      }
      const mean = e.reduce((a, b) => a + b, 0) / e.length
      return Math.sqrt(e.reduce((a, b) => a + (b - mean) ** 2, 0) / e.length) / r.md.n
    }
    const coarse = fluctuation(0.004)
    const fine = fluctuation(0.002)
    expect(coarse).toBeLessThan(1e-3)
    expect(coarse / fine).toBeGreaterThan(3)
    expect(coarse / fine).toBeLessThan(5)
  })

  it('positions stay inside the periodic box', () => {
    const r = toReversible(fresh(), pair, 0.005)
    stepReversible(r, pair, 0.005, 500)
    for (let k = 0; k < r.x.length; k++) {
      expect(Number.isInteger(r.x[k]!)).toBe(true)
      expect(r.x[k]!).toBeGreaterThanOrEqual(0)
      expect(r.x[k]!).toBeLessThan(r.period[k % 2]!)
    }
  })
})
