import { describe, expect, it } from 'vitest'
import { defaults } from '../../src/core/params'
import { MdCpuBackend } from '../../src/substrates/md/backend-cpu'
import { LJ, analyticPair } from '../../src/substrates/md/potential'
import { initTriangular } from '../../src/substrates/md/ref/init'
import { rdf, regionFrame, scalars, speedHistogram } from '../../src/substrates/md/ref/reducers'
import { step } from '../../src/substrates/md/ref/step'
import { MD_KNOBS } from '../../src/substrates/md/schema'

const pair = analyticPair(LJ)

describe('statistics over a selected region', () => {
  const s = initTriangular({ nx: 30, density: 0.7, temperature: 1.2, seed: 5 }, pair)
  step(s, pair, 0.004, 800)
  const whole: [number, number, number, number] = [0, 0, s.box[0]!, s.box[1]!]

  // 选区取整个盒子时，应与全体的统计一致。
  // With the whole box selected, the region must reproduce the whole-system statistics.
  it('the whole box as a region reproduces the whole-system values', () => {
    const sc = scalars(s)
    const r = regionFrame(s, whole, ['speedHist', 'rdf'], 4)
    expect(r.n).toBe(s.n)
    expect(r.density).toBeCloseTo(sc.density, 12)
    expect(r.psi6Local).toBeCloseTo(sc.psi6Local, 12)
    expect(r.coordination).toBeCloseTo(sc.coordination, 12)
    // 全体的温度扣除了质心自由度，差一个 (n-1)/n 因子。
    // The whole-system temperature removes the centre-of-mass degrees of freedom: a factor (n-1)/n.
    expect(r.temperature).toBeCloseTo((sc.temperature * (s.n - 1)) / s.n, 12)
    const speed = speedHistogram(s, 40, 4)
    for (let b = 0; b < 40; b++) expect(r.speedHist!.y[b]).toBeCloseTo(speed.y[b]!, 12)
    const g = rdf(s, 120, 4)
    for (let b = 0; b < 120; b++) expect(r.rdf!.y[b]).toBeCloseTo(g.y[b]!, 10)
  })

  it('a sub-region counts only the particles inside it', () => {
    const half: [number, number, number, number] = [0, 0, s.box[0]! / 2, s.box[1]!]
    const r = regionFrame(s, half, [], 4)
    let inside = 0
    for (let i = 0; i < s.n; i++) if (s.pos[2 * i]! < s.box[0]! / 2) inside++
    expect(r.n).toBe(inside)
    expect(Math.abs(r.density - 0.7)).toBeLessThan(0.05)
    expect(regionFrame(s, [0, 0, 1e-9, 1e-9], ['rdf'], 4).n).toBe(0)
  })

  it('the backend attaches region statistics only when a region is given', () => {
    const b = new MdCpuBackend({ ...defaults(MD_KNOBS), nx: 20 }, 1)
    expect(b.reduce(['scalars']).region).toBeUndefined()
    const f = b.reduce(['scalars', 'rdf'], [0, 0, b.box[0]! / 2, b.box[1]! / 2])
    expect(f.region!.n).toBeGreaterThan(0)
    expect(f.region!.n).toBeLessThan(b.n)
    expect(f.region!.rdf).toBeDefined()
    expect(f.region!.speedHist).toBeUndefined()
  })
})
