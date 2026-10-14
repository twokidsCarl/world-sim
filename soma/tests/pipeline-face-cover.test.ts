// 新头的收尾步骤里的纯函数：需要量沿网格铺开、牙列的均匀缩放、由眶上缘求眉线
// the pure functions of the finishing steps for the new head: spreading a need along a mesh, the uniform scale of the dentition, the brow line from the supraorbital rim
import { describe, expect, it } from 'vitest'
import { BROW_RULE, browBandFromRim } from '../tools/pipeline/browPose.ts'
import { COVER_DEFAULTS, spreadNeed } from '../tools/pipeline/faceCover.ts'
import { INCISOR_SHOW, PINNED_TOOTH_SCALE, scaleAbout } from '../tools/pipeline/headWarp.ts'

describe('spreadNeed', () => {
  // 一条五个顶点的三角形带 / a strip of triangles over five vertices
  const strip = [0, 1, 2, 1, 2, 3, 2, 3, 4]
  it('never decreases a need and leaves zero needs zero without rounds', () => {
    const m = spreadNeed([0, 0, 1, 0, 0], strip, 0, 0.8)
    expect(Array.from(m)).toEqual([0, 0, 1, 0, 0])
  })
  it('passes a share of a need to the neighbours, less with every ring', () => {
    const m = spreadNeed([0, 0, 0, 0, 1], strip, 3, 0.8)
    expect(m[4]).toBe(1)
    expect(m[3]!).toBeGreaterThan(0)
    expect(m[3]!).toBeLessThan(1)
    expect(m[2]!).toBeGreaterThan(0)
    expect(m[0]!).toBeLessThan(m[2]!)
    for (let i = 0; i < 5; i++) expect(m[i]!).toBeGreaterThanOrEqual([0, 0, 0, 0, 1][i]!)
  })
  it('keeps a uniform need uniform', () => {
    const m = spreadNeed([2, 2, 2, 2, 2], strip, 4, COVER_DEFAULTS.keep)
    for (const v of m) expect(v).toBeCloseTo(2, 6)
  })
})

describe('the dentition as a similarity', () => {
  it('scales every distance by the pinned factor and keeps the centre', () => {
    const c: [number, number, number] = [0.01, 1.4, 0.08]
    const p = scaleAbout([0.02, 1.41, 0.09, -0.01, 1.39, 0.07, ...c], c, PINNED_TOOTH_SCALE.scale)
    const d = (i: number, j: number) => Math.hypot(p[3 * i]! - p[3 * j]!, p[3 * i + 1]! - p[3 * j + 1]!, p[3 * i + 2]! - p[3 * j + 2]!)
    expect(d(0, 1)).toBeCloseTo(PINNED_TOOTH_SCALE.scale * Math.hypot(0.03, 0.02, 0.02), 6)
    expect(Array.from(p.subarray(6, 9)).map((v) => Math.round(v * 1e6) / 1e6)).toEqual(c)
  })
  it('pins a scale that follows from the tabled dimorphism and stays within a few per cent', () => {
    expect(PINNED_TOOTH_SCALE.scale).toBeCloseTo(1 / (1 + PINNED_TOOTH_SCALE.medianDimorphismPercent / 100), 3)
    expect(PINNED_TOOTH_SCALE.scale).toBeGreaterThan(0.95)
    expect(PINNED_TOOTH_SCALE.scale).toBeLessThan(1)
    expect(INCISOR_SHOW).toBe(0.002)
  })
})

describe('browBandFromRim', () => {
  const eyes = { L: [0.031, 1.42, 0.08], R: [-0.031, 1.42, 0.08] }
  // 一条合成的眶上缘：眼关节上方 14 mm；缘以下的骨面（眶顶）陡然向后，缘以上的额骨缓缓后倾
  // a synthetic supraorbital rim 14 mm above the eye joints; below it the bone (the orbital roof) recedes steeply, above it the frontal bone slopes back gently
  const frontal: number[] = []
  for (let x = -0.07; x <= 0.07; x += 0.001) for (let dy = 0.008; dy <= 0.028; dy += 0.001) frontal.push(x, 1.42 + dy, 0.09 - (dy < 0.014 ? (0.014 - dy) * 2 : (dy - 0.014) * 0.3))
  it('puts the lower border of the brow by the rule on the rim it finds', () => {
    const r = browBandFromRim(frontal, eyes)!
    expect(r).not.toBeNull()
    const B = r.band.bandOnTheRestHead_mmFromEyeJoint
    expect(B.lateralOffset_u).toEqual([...BROW_RULE.u])
    r.rimAboveEyeJointMm.forEach((v) => expect(Math.abs(v - 14)).toBeLessThan(1.6))
    B.centreHeightAboveEyeCentre.forEach((c, i) => expect(c - BROW_RULE.halfWidthMm[i]! - r.rimAboveEyeJointMm[i]!).toBeCloseTo(BROW_RULE.lowerBorderAboveRimMm[i]!, 0))
    // 内侧宽、外侧窄 / wide medially, narrow laterally
    expect(BROW_RULE.halfWidthMm[0]!).toBeGreaterThan(BROW_RULE.halfWidthMm[BROW_RULE.halfWidthMm.length - 1]!)
  })
  it('returns null where there is no bone', () => {
    expect(browBandFromRim([], eyes)).toBeNull()
  })
})
