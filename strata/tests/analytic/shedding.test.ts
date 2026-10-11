import { describe, expect, it } from 'vitest'
import { gaussian } from '../../src/core/rng'
import type { History } from '../../src/core/quantity'
import { MD_ANALYSES } from '../../src/levels/md-analyses'

const shedding = MD_ANALYSES.find((a) => a.id === 'shedding')!
const params = { walls: 1, obstacle: 30, dim: 2 }

/** 一条标量历史：y[k] 只有一个分量。 / A scalar history: each y[k] has a single component. */
function history(signal: (t: number, k: number) => number): History {
  const t = Array.from({ length: 200 }, (_, k) => 5 * k)
  return { t, x: [0], y: t.map((time, k) => Float64Array.of(signal(time, k))) }
}

describe('shedding analysis', () => {
  it('recovers the frequency of a noisy oscillation and the Strouhal number', () => {
    // 周期 125，前一半振幅还在增长；D = 60、U = 1.2 时 St = 60 / (125 · 1.2) = 0.4。
    // Period 125, with the amplitude still growing over the first half; with D = 60 and
    // U = 1.2, St = 60 / (125 · 1.2) = 0.4.
    const h = history((t, k) => Math.min(1, t / 500) * Math.sin((2 * Math.PI * t) / 125) + 0.1 * gaussian(5, k))
    const r = shedding.compute(h, params, (id) => (id === 'meanFlow' ? 1.2 : undefined))!
    expect(r.agree).toBe(true)
    expect(r.headline).toContain('周期 125')
    expect(r.detail).toContain('St = f D / U = 0.40')
  })

  it('reports no period for pure noise', () => {
    const h = history((_, k) => gaussian(9, k))
    const r = shedding.compute(h, params, () => 1.2)!
    expect(r.agree).toBe(false)
    expect(r.headline).toBe('没有清晰的周期')
  })

  it('reports no period when the record holds fewer than two periods', () => {
    // 只用后一半（跨度 500），周期 400 放不下两个。
    // Only the second half is used (span 500), which cannot hold two periods of 400.
    const h = history((t) => Math.sin((2 * Math.PI * t) / 400))
    expect(shedding.compute(h, params, () => 1.2)!.agree).toBe(false)
  })
})
