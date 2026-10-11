import { describe, expect, it } from 'vitest'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initFcc } from '../../src/substrates/md/ref/init'
import { rdf, regionFrame, scalars } from '../../src/substrates/md/ref/reducers'
import { computeForces, step } from '../../src/substrates/md/ref/step'

const pair = analyticPair(LJ)

/** 三维液体，y 方向两面热壁。 / A 3D liquid between two thermal walls across y. */
function slab(cells: number, density: number, temperature: number) {
  const s = initFcc({ cells, density, temperature, seed: 5 }, pair)
  s.walls = true
  s.wallTemperature = temperature
  s.wallTemperatureFar = temperature
  s.seed = 5
  computeForces(s, pair)
  return s
}

describe('3D molecular dynamics between walls', () => {
  it('cell-list forces equal all-pairs forces, with no interaction across the walls', () => {
    const a = slab(5, 0.7, 1.2)
    step(a, pair, 0.004, 100)
    const b = slab(5, 0.7, 1.2)
    b.pos.set(a.pos)
    computeForces(a, pair)
    computeForces(b, pair, true)
    expect(a.pe).toBeCloseTo(b.pe, 8)
    for (let k = 0; k < a.n * 3; k++) expect(Math.abs(a.force[k]! - b.force[k]!)).toBeLessThan(1e-9)
    // 周期盒里同样的位置受力不同：壁面确实切断了跨 y 边界的相互作用。
    // The same positions in a periodic box give different forces: the walls do cut the interaction across the y boundary.
    const periodic = slab(5, 0.7, 1.2)
    periodic.walls = false
    periodic.pos.set(a.pos)
    computeForces(periodic, pair)
    expect(Math.abs(periodic.pe - a.pe)).toBeGreaterThan(1)
  })

  it('keeps every particle between the walls', () => {
    const s = slab(4, 0.6, 1.5)
    for (let k = 0; k < 40; k++) {
      step(s, pair, 0.005, 25)
      for (let i = 0; i < s.n; i++) {
        expect(s.pos[3 * i + 1]!).toBeGreaterThanOrEqual(0)
        expect(s.pos[3 * i + 1]!).toBeLessThan(s.box[1]!)
      }
    }
  })
})

describe('region statistics in 3D', () => {
  it('the whole box as a region reproduces the whole-system values', () => {
    const s = initFcc({ cells: 5, density: 0.7, temperature: 1.4, seed: 2 }, pair)
    step(s, pair, 0.004, 400)
    const whole = scalars(s)
    const r = regionFrame(s, [0, 0, s.box[0]!, s.box[1]!], ['speedHist', 'rdf'], 6)
    expect(r.n).toBe(s.n)
    expect(r.density).toBeCloseTo(whole.density, 12)
    expect(r.coordination).toBeCloseTo(whole.coordination, 10)
    // 选区不扣质心自由度，所以与全体温度差一个 (n − 1) / n 的因子。
    // The region removes no centre-of-mass degrees of freedom, hence a factor (n − 1) / n from the whole-system temperature.
    expect(r.temperature).toBeCloseTo((whole.temperature * (s.n - 1)) / s.n, 8)
    expect(r.psi6Local).toBe(0)
    // 速度分布归一；g(r) 与全体的 g(r) 相同（同样的 rmax 与分箱）。
    // The speed distribution is normalised; g(r) equals the whole-system g(r) (same rmax and bins).
    const w = r.speedHist!.x[1]! - r.speedHist!.x[0]!
    expect(r.speedHist!.y.reduce((a, c) => a + c * w, 0)).toBeCloseTo(1, 2)
    const g = rdf(s, 120, r.rdf!.x[119]! + (r.rdf!.x[1]! - r.rdf!.x[0]!) / 2)
    for (let b = 20; b < 120; b++) expect(Math.abs(r.rdf!.y[b]! - g.y[b]!)).toBeLessThan(1e-9)
  })

  it('a sub-region is a column through the box along z', () => {
    const s = initFcc({ cells: 5, density: 0.7, temperature: 1.4, seed: 2 }, pair)
    step(s, pair, 0.004, 200)
    const half = regionFrame(s, [0, 0, s.box[0]! / 2, s.box[1]!], [], 6)
    let inside = 0
    for (let i = 0; i < s.n; i++) inside += s.pos[3 * i]! < s.box[0]! / 2 ? 1 : 0
    expect(half.n).toBe(inside)
    expect(Math.abs(half.density - 0.7)).toBeLessThan(0.06)
  })
})
