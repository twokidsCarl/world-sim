// 神经元形态重建 / neuron reconstructions
import { describe, expect, it } from 'vitest'
import neuronTable from '../data/neurons.json'
import { neuromorphoUrl, neuronMolecule, parseSwc } from '../src/neuro/swc'

// 三点式胞体，一根基树突（半径从 1 渐细到 0.5），一根顶树突
// a three-point soma, one basal dendrite (tapering from radius 1 to 0.5), one apical dendrite
const SWC = `# a comment
1 1 0 0 0 10 -1
2 1 0 10 0 10 1
3 1 0 -10 0 10 1
4 3 20 0 0 1.0 1
5 3 50 0 0 0.5 4
6 4 0 40 0 2.0 1
bad line
7 4 0 80 0 0 6
`

describe('SWC', () => {
  it('reads nodes and skips comments and broken lines', () => {
    const nodes = parseSwc(SWC)
    expect(nodes.length).toBe(7)
    expect(nodes[4]).toEqual({ id: 5, type: 3, x: 50, y: 0, z: 0, r: 0.5, parent: 4 })
  })

  it('draws a three-point soma as one sphere, and each type as its own chain', () => {
    const m = neuronMolecule(parseSwc(SWC), 'n', 'n')
    expect(m.entities.map((e) => e.id)).toEqual(['1', '3', '4'])
    const soma = m.chains[0]!
    expect(soma.count).toBe(1)
    expect(m.radius![soma.start]).toBe(10)
    expect(Array.from(m.pos.subarray(0, 3))).toEqual([0, 0, 0])
  })

  it('fills each segment with spheres close enough to read as one tube, tapering between the ends', () => {
    const m = neuronMolecule(parseSwc(SWC), 'n', 'n')
    const basal = m.chains[1]!
    // 从 x = 20 到 50 的那一段上的球，按 x 排序 / the spheres on the stretch from x = 20 to 50, in order of x
    const on = [] as { x: number; r: number }[]
    for (let i = basal.start; i < basal.start + basal.count; i++) if (m.pos[i * 3]! >= 20 && m.pos[i * 3 + 1] === 0) on.push({ x: m.pos[i * 3]!, r: m.radius![i]! })
    on.sort((a, b) => a.x - b.x)
    expect(on[0]).toEqual({ x: 20, r: 1 })
    expect(on[on.length - 1]).toEqual({ x: 50, r: 0.5 })
    for (let k = 1; k < on.length; k++) {
      // 相邻球心的距离不超过较小半径的一半 / neighbouring centres are no further apart than half the smaller radius
      expect(on[k]!.x - on[k - 1]!.x).toBeLessThanOrEqual(Math.min(on[k]!.r, on[k - 1]!.r) * 0.5)
      expect(on[k]!.r).toBeLessThanOrEqual(on[k - 1]!.r + 1e-9)
    }
    // 半径为 0 的节点也画得出来 / a node of radius 0 is still drawn
    expect(Math.min(...Array.from(m.radius!))).toBeGreaterThan(0)
  })

  it('widens the spacing rather than exceed the sphere budget', () => {
    const full = neuronMolecule(parseSwc(SWC), 'n', 'n').atomCount
    const capped = neuronMolecule(parseSwc(SWC), 'n', 'n', 60).atomCount
    expect(full).toBeGreaterThan(200)
    expect(capped).toBeLessThan(120)
  })

  it('builds NeuroMorpho addresses and has a source for every neuron in the catalogue', () => {
    expect(neuromorphoUrl('Allman', '02a_pyramidal2aFI')).toBe('https://neuromorpho.org/dableFiles/allman/CNG%20version/02a_pyramidal2aFI.CNG.swc')
    for (const n of neuronTable.neurons) {
      expect(n.doi).toMatch(/^10\./)
      for (const k of ['title', 'titleEn', 'name', 'archive', 'species', 'has', 'hasEn'] as const) expect(n[k]).toBeTruthy()
    }
  })
})
