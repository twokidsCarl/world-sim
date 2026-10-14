// 头部形变里的纯函数：径向基样条、绕寰枕关节的转动、厚度表。
// The pure functions of the head warp: the radial-basis spline, the rotation about the atlanto-occipital joint, the depth table.
import { describe, expect, it } from 'vitest'
import { headFlexion, PINNED_HEAD_FLEXION, type AtlantoOccipital } from '../tools/pipeline/headPose.ts'
import { DEPTHS, RbfWarp } from '../tools/pipeline/headWarp.ts'
import { applyT } from '../tools/pipeline/shoulder.ts'

describe('RbfWarp', () => {
  // 伪随机点，固定种子 / pseudo-random points from a fixed seed
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.2
  const src = Array.from({ length: 40 * 3 }, rnd)

  it('reproduces an affine map exactly and adds no bending to it', () => {
    // 仿射运动不受罚：正则再大也应精确重现 / affine motion is not penalised: reproduced exactly however strong the regularisation
    const A = (p: number[]) => [1.1 * p[0]! + 0.05 * p[1]! + 0.01, 0.9 * p[1]! - 0.02 * p[2]! - 0.02, 1.05 * p[2]! + 0.03 * p[0]! + 0.005]
    const dst = src.flatMap((_, i) => (i % 3 === 0 ? A(src.slice(i, i + 3)) : []))
    const w = RbfWarp.fit(src, dst, new Array(40).fill(1e-2))
    const q = [0.03, -0.07, 0.11]
    const out = w.apply(q)
    const want = A(q)
    for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(want[k]!, 5)
  })

  it('interpolates its constraints when the regularisation is small and relaxes them when it is large', () => {
    const dst = src.map((v, i) => v + (i % 3 === 1 ? 0.01 * Math.sin(40 * src[i - 1]!) : 0))
    const err = (lambda: number) => {
      const out = RbfWarp.fit(src, dst, new Array(40).fill(lambda)).apply(src)
      return Math.max(...Array.from(out, (v, i) => Math.abs(v - dst[i]!)))
    }
    expect(err(1e-9)).toBeLessThan(1e-5)
    expect(err(1)).toBeGreaterThan(1e-3)
  })

  it('is the identity before anything is fitted', () => {
    const out = RbfWarp.identity().apply([0.1, 0.2, 0.3])
    expect(Array.from(out).map((v) => Number(v.toFixed(6)))).toEqual([0.1, 0.2, 0.3])
  })
})

describe('headFlexion', () => {
  const joint: AtlantoOccipital = { left: [0.02, 1.38, 0.08], right: [-0.02, 1.38, 0.08], axis: [1, 0, 0], gapMm: { left: { min: 0, median: 0 }, right: { min: 0, median: 0 } } }

  it('takes a point in front of the joint down for a positive angle and up for a negative one', () => {
    const front: [number, number, number] = [0, 1.38, 0.18]
    expect(applyT(headFlexion(joint, 5), front)[1]).toBeLessThan(1.38)
    expect(applyT(headFlexion(joint, -5), front)[1]).toBeGreaterThan(1.38)
  })

  it('leaves the points of the axis where they are', () => {
    const p = applyT(headFlexion(joint, PINNED_HEAD_FLEXION.angleDeg), joint.left)
    for (let k = 0; k < 3; k++) expect(p[k]).toBeCloseTo(joint.left[k]!, 9)
  })

  it('is pinned inside the limit and inside the in-vitro range it quotes', () => {
    expect(Math.abs(PINNED_HEAD_FLEXION.angleDeg)).toBeLessThanOrEqual(PINNED_HEAD_FLEXION.maxDeg)
    expect(Math.abs(PINNED_HEAD_FLEXION.angleDeg)).toBeLessThan(PINNED_HEAD_FLEXION.range.inVitroFlexionExtensionRomDeg)
  })
})

describe('DEPTHS', () => {
  it('gives every entry a positive mean, a positive SD and a source, and marks loose pairings as no constraint', () => {
    for (const d of DEPTHS) {
      expect(d.meanMm).toBeGreaterThan(0)
      expect(d.sdMm).toBeGreaterThan(0)
      expect(d.source.length).toBeGreaterThan(20)
    }
    for (const d of DEPTHS.filter((x) => /^(zygion|gonion|midRamus|mastoid|euryon|vertex|opisthocranion)/.test(x.skin))) expect(d.weight).toBe(0)
  })

  it('names each skin landmark once', () => {
    expect(new Set(DEPTHS.map((d) => d.skin)).size).toBe(DEPTHS.length)
  })
})
