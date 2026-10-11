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

  it('joins every node to its parent with a cone, starting thin where a branch leaves the soma', () => {
    const nodes = parseSwc(SWC)
    const m = neuronMolecule(nodes, 'n', 'n')
    const seg = m.segments!
    // 三点式胞体的两个辅助点不算；其余每个有父节点的节点一段 / the two helper points of a three-point soma do not count; every other node with a parent gives one segment
    expect(seg.length / 2).toBe(nodes.filter((n) => n.parent !== -1 && n.type !== 1).length)
    const at = (i: number) => [m.pos[i * 3]!, m.pos[i * 3 + 1]!, m.pos[i * 3 + 2]!, m.radius![i]!]
    const byId = new Map(nodes.map((n) => [n.id, n]))
    let fromSoma = 0
    for (let k = 0; k < seg.length; k += 2) {
      const a = at(seg[k]!), b = at(seg[k + 1]!)
      // 终点是某个节点，起点在它父节点的位置上 / the end is a node, and the start lies where its parent is
      const node = nodes.find((n) => n.type !== 1 && n.x === b[0] && n.y === b[1] && n.z === b[2])!
      const parent = byId.get(node.parent)!
      expect(a.slice(0, 3)).toEqual([parent.x, parent.y, parent.z])
      // 同一种类型，所以同一个颜色 / the same type, hence the same colour
      expect(m.chainOf[seg[k]!]).toBe(m.chainOf[seg[k + 1]!])
      if (parent.type === 1) {
        fromSoma++
        expect(a[3]).toBeLessThan(parent.r)
        expect(a[3]).toBeCloseTo(Math.max(node.r, 0.08))
      }
    }
    expect(fromSoma).toBeGreaterThan(0)
    expect(neuronMolecule(nodes, 'n', 'n', true).segments).toBeUndefined()
  })

  it('when dense, fills each segment with spheres close enough to read as one tube, tapering between the ends', () => {
    const m = neuronMolecule(parseSwc(SWC), 'n', 'n', true)
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
    const full = neuronMolecule(parseSwc(SWC), 'n', 'n', true).atomCount
    const capped = neuronMolecule(parseSwc(SWC), 'n', 'n', true, 60).atomCount
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

describe('connectome cells in a shared frame', () => {
  it('builds the address of a MICrONS skeleton and refuses anything else', async () => {
    const { micronsUrl } = await import('../src/neuro/swc')
    expect(micronsUrl('864691135122934055_294557')).toBe('https://bossdb-open-data.s3.amazonaws.com/iarpa_microns/minnie/minnie65/skeletons/v661/skeletons/864691135122934055_294557.swc')
    expect(() => micronsUrl('../secret')).toThrow()
  })

  it('crops to a sphere, and a node whose parent is gone draws no segment back to it', async () => {
    const { within, neuronMolecule, parseSwc } = await import('../src/neuro/swc')
    const nodes = parseSwc('0 1 0 0 0 5 -1\n1 3 10 0 0 1 0\n2 3 300 0 0 1 1\n3 3 20 0 0 1 2\n')
    const kept = within(nodes, [0, 0, 0], 100)
    expect(kept.map((n) => n.id)).toEqual([0, 1, 3])
    const mol = neuronMolecule(kept, 'x', 'x', true)
    // 没有任何球落在 20 和 300 之间 / no sphere lies between 20 and 300
    let far = 0
    for (let i = 0; i < mol.atomCount; i++) if (mol.pos[i * 3]! > 21) far++
    expect(far).toBe(0)
  })

  it('lists catalogue groups whose ids are well formed, and the host is on the allowlist', async () => {
    const table = (await import('../data/neurons.json')).default
    const { micronsUrl } = await import('../src/neuro/swc')
    const { allowed } = await import('../server/structures')
    for (const g of table.groups) {
      expect(g.cells.length).toBeGreaterThan(1)
      expect(g.radius).toBeGreaterThan(0)
      for (const c of g.cells) expect(allowed(micronsUrl(c))).toBe(true)
    }
  })
})
