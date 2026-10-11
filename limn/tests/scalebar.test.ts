// 比例尺 / the scale bar
import { describe, expect, it } from 'vitest'
import { scaleBar } from '../src/render/scalebar'

describe('scaleBar', () => {
  it('picks 1, 2 or 5 times a power of ten near a fifth of the width', () => {
    // 1000 px 宽、每像素 0.1 Å：画面宽 100 Å，五分之一是 20 Å = 2 nm / 1000 px at 0.1 Å each: 100 Å wide, a fifth is 20 Å = 2 nm
    expect(scaleBar(0.1, 1000)).toEqual({ px: 200, label: '2 nm', angstrom: 20 })
    expect(scaleBar(0.1, 800)!.label).toBe('1 nm')
    expect(scaleBar(0.26, 1000)!.label).toBe('5 nm')
    for (const per of [0.013, 0.07, 0.4, 3, 55, 900]) {
      const b = scaleBar(per, 1200)!
      // 长度在画面宽度的十分之一到五分之一之间 / the length is between a tenth and a fifth of the width
      expect(b.px).toBeLessThanOrEqual(240 + 1e-9)
      expect(b.px).toBeGreaterThan(96)
      expect(b.label).toMatch(/^(1|2|5|10|20|50|100|200|500|0\.1|0\.2|0\.5) (Å|nm|µm)$/)
    }
  })

  it('reads in Å, nm or µm, whatever unit the scene is in', () => {
    expect(scaleBar(0.02, 1000)!.label).toBe('2 Å')
    expect(scaleBar(30, 1000)!.label).toBe('500 nm')
    expect(scaleBar(60, 1000)!.label).toBe('1 µm')
    // 细胞器：坐标是 nm，每像素 40 nm，画面宽 40 µm / organelles: coordinates in nm, 40 nm a pixel, a frame 40 µm wide
    expect(scaleBar(40, 1000, 'nm')).toEqual({ px: 125, label: '5 µm', angstrom: 50_000 })
    // 神经元：坐标是 µm，每像素 0.25 µm / a neuron: coordinates in µm, 0.25 µm a pixel
    expect(scaleBar(0.25, 1000, 'µm')).toEqual({ px: 200, label: '50 µm', angstrom: 500_000 })
    // 换单位不改变它在画面上的长度 / changing the unit leaves its on-screen length as it was
    expect(scaleBar(4, 1000, 'nm')!.px).toBeCloseTo(scaleBar(40, 1000, 'Å')!.px)
  })

  it('gives nothing for an empty frame', () => {
    expect(scaleBar(0, 1000)).toBeNull()
    expect(scaleBar(1, 0)).toBeNull()
  })
})
