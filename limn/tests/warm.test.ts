// 预热：卡片要用的文件预先取到本机 / warm-up: fetching ahead what the cards need
import { describe, expect, it } from 'vitest'
import catalog from '../data/catalog.json'
import sim from '../sim.json'
import { shouldWarm, warm, warmList, warmState } from '../server/warm'

describe('warm-up', () => {
  const items = warmList(sim.cards.map((c) => c.url))
  const labels = items.map((i) => i.label)

  it('covers every catalogue model, every neuron, and the structures and maps the cards open by id', () => {
    for (const m of catalog.models) expect(labels.some((l) => l === m.id || l === `PDB ${m.source.id}`), m.id).toBe(true)
    expect(labels).toContain('PDB 1AOI')
    expect(labels).toContain('EMD-1080')
    expect(labels.filter((l) => l.startsWith('MICrONS ')).length).toBe(5)
    // 整个细胞也在内：它的分割数据以前是页面每次逐块现取的 / whole cells too: their segmentation used to be fetched block by block by the page every time
    expect(labels).toContain('hela-organelles')
  })

  it('leaves the very large models to the end, largest download last', () => {
    const at = (id: string) => labels.indexOf(id)
    expect(at('influenza-virion')).toBe(labels.length - 1)
    expect(at('presynaptic-bouton')).toBeGreaterThan(at('mycoplasma-genitalium'))
    expect(at('syn3a-envelope')).toBeLessThan(at('influenza-virion'))
    expect(at('PDB 1AOI')).toBeLessThan(at('sars-cov-2-virion'))
  })

  it('goes on after a failure and reports what failed', async () => {
    const ran: string[] = []
    const lines: string[] = []
    await warm(
      [
        { label: 'a', run: async () => void ran.push('a') },
        { label: 'b', run: async () => { throw new Error('no network') } },
        { label: 'c', run: async () => void ran.push('c') },
      ],
      (l) => lines.push(l),
    )
    expect(ran).toEqual(['a', 'c'])
    expect(warmState).toMatchObject({ total: 3, done: 3, failed: ['b'], finished: true, current: '' })
    expect(lines.join('\n')).toMatch(/b failed: no network/)
    expect(lines.at(-1)).toMatch(/2\/3 ready/)
  })

  it('is on when hosted, off while developing, and obeys an explicit setting', () => {
    expect(shouldWarm({})).toBe(false)
    expect(shouldWarm({ WORLD_SIM_STATE: '/x' })).toBe(true)
    expect(shouldWarm({ WORLD_SIM_STATE: '/x', LIMN_WARM: '0' })).toBe(false)
    expect(shouldWarm({ LIMN_WARM: '1' })).toBe(true)
  })
})
