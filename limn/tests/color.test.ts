import { describe, expect, it } from 'vitest'
import { hex, oklch, parseHex, toOklch } from '../src/style/oklab'
import { spreadHues } from '../src/style/assign'
import { ROLE_HUE } from '../src/style/palettes'

describe('oklch', () => {
  it('round-trips a colour sampled from a Goodsell image', () => {
    const src = parseHex('#7EE37E')
    const { L, C, h } = toOklch(src)
    expect(L).toBeCloseTo(0.831, 2)
    expect(C).toBeCloseTo(0.167, 2)
    expect(hex(oklch(L, C, h))).toBe('#7ee37e')
  })
  it('clips chroma, not lightness or hue, when out of gamut', () => {
    const c = toOklch(oklch(0.8, 0.5, 145))
    expect(c.L).toBeCloseTo(0.8, 1)
    expect(c.h).toBeCloseTo(145, 0)
    expect(c.C).toBeLessThan(0.3)
  })
})

describe('spreadHues', () => {
  it('fans entities of one role across that role’s range and leaves singles alone', () => {
    const c = spreadHues({ roles: ['soluble', 'soluble', 'soluble', 'nucleic'], hueShift: [0, 0, 0, 0], override: [null, null, null, null] })
    const s = ROLE_HUE.soluble.spread
    expect(c.hueShift).toEqual([-s, 0, s, 0])
  })
})
