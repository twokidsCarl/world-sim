// 屏幕空间次表面散射：核按通道归一、对称、红光最宽；地址里的 sss=1。
// Screen-space subsurface scattering: the kernel is normalised per channel, symmetric, widest in red; sss=1 in the address.
import { describe, expect, it } from 'vitest'
import { sssKernel } from '../src/look/sssPass.ts'
import { formatUrl, parseUrl } from '../src/state/urlState.ts'

describe('separable SSS kernel', () => {
  const k = sssKernel()
  it('has an odd number of taps, symmetric offsets and a centre tap', () => {
    expect(k.length % 2).toBe(1)
    const half = (k.length - 1) / 2
    expect(k[half]!.mm).toBe(0)
    for (let i = 0; i < half; i++) {
      expect(k[i]!.mm).toBeCloseTo(-k[k.length - 1 - i]!.mm)
      for (let c = 0; c < 3; c++) expect(k[i]!.w[c]).toBeCloseTo(k[k.length - 1 - i]!.w[c]!)
    }
    for (let i = 1; i < k.length; i++) expect(k[i]!.mm).toBeGreaterThan(k[i - 1]!.mm)
  })

  it('sums to 1 per channel, with red spreading furthest and blue least', () => {
    for (let c = 0; c < 3; c++) expect(k.reduce((s, t) => s + t.w[c]!, 0)).toBeCloseTo(1, 6)
    // 二阶矩：红 > 绿 > 蓝（剖面里红光的高斯最宽）/ second moment: red > green > blue (red has the widest Gaussians in the profile)
    const m2 = (c: number) => k.reduce((s, t) => s + t.w[c]! * t.mm * t.mm, 0)
    expect(m2(0)).toBeGreaterThan(m2(1))
    expect(m2(1)).toBeGreaterThan(m2(2))
    for (const t of k) for (const w of t.w) expect(w).toBeGreaterThanOrEqual(0)
  })
})

describe('sss URL parameter', () => {
  it('sss=1 turns it on and is the only value written', () => {
    expect(parseUrl('?skin=1&sss=1').state.sss).toBe(true)
    expect(parseUrl('?sss=0').state.sss).toBeUndefined()
    expect(parseUrl('?sss=x').warnings.length).toBe(1)
    expect(formatUrl({ skin: true, sss: true })).toContain('sss=1')
    expect(formatUrl({ skin: true })).not.toContain('sss')
  })
})
