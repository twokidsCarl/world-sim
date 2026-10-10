// Checks the generated dev fixture against the contract shapes the app must handle.
// public/anatomy/ is not committed, so this skips until `bun tools/fixture/make-fixture.ts` has run.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AnatomyGraph, isFmaId } from '../src/anatomy/graph.ts'
import type { AnatomyData, NameEntry, NervePath, Relation } from '../src/anatomy/types.ts'

const dir = resolve(__dirname, '../public/anatomy/fixture')
const read = <T>(f: string): T => JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as T

describe.skipIf(!existsSync(resolve(dir, 'anatomy.json')))('generated fixture', () => {
  const load = () => {
    const data = read<AnatomyData>('anatomy.json')
    return { data, graph: new AnatomyGraph(data, read<Record<string, NameEntry>>('knowledge/names.json'), read<Relation[]>('knowledge/relations.json')) }
  }

  it('is self-consistent', () => {
    const { data, graph } = load()
    expect(data.schema).toBe(1)
    expect(graph.cautions.length).toBeGreaterThanOrEqual(2)
    for (const c of graph.cautions) expect(c.zh.length * c.en.length).toBeGreaterThan(0)
    expect(new Set(data.parts.map((p) => p.id)).size).toBe(data.parts.length)
    expect(graph.coverage('isa')).toBe(data.parts.length)
    expect(graph.coverage('partOf')).toBeLessThan(data.parts.length)
    for (const p of data.parts) {
      expect(p.depth).toBeLessThan(data.layers.length)
      for (const a of p.adjacent) expect(graph.part(a)?.adjacent).toContain(p.id)
      if (p.source !== undefined) expect(data.sources.map((s) => s.name)).toContain(p.source)
    }
    for (const sys of data.systems) expect(graph.partsBySystem(sys.id).length).toBe(sys.partCount)
  })

  it('exercises several sources and every provenance value', () => {
    const { graph } = load()
    const groups = graph.provenanceGroups()
    expect(groups.map((g) => g.provenance)).toEqual(['scanned', 'warped', 'curated'])
    expect(new Set(groups.flatMap((g) => g.sources.map((s) => s.info.name))).size).toBe(3)
  })

  it('has non-FMA ids, twins sharing an unsided concept, and thin nerves with centrelines', () => {
    const { data, graph } = load()
    const synthetic = data.parts.filter((p) => !isFmaId(p.fma))
    expect(synthetic.length).toBeGreaterThanOrEqual(4)
    expect(synthetic.every((p) => p.id.startsWith('ZA'))).toBe(true)
    const left = synthetic.find((p) => p.name === 'Left ulnar nerve')!
    expect(graph.partsByFma(left.fma).length).toBe(2)
    expect(graph.partName(left).primary).toBe('左尺神经')
    const paths = read<NervePath[]>('nerves.json')
    expect(paths.length).toBe(synthetic.length)
    for (const n of paths) {
      expect(graph.part(n.part)?.tissue).toBe('nerve')
      for (const b of n.branches) {
        expect(b.points.length).toBe(b.radius.length * 3)
        expect(Math.max(...b.radius)).toBeLessThan(0.001)
      }
    }
  })

  it('has relations that resolve through a non-FMA concept id, and the inverse kind', () => {
    const { graph } = load()
    const biceps = graph.parts.find((p) => p.name === 'Left biceps brachii')!
    const inn = graph.relationsFor(biceps.fma).find((r) => r.kind === 'innervatedBy')!
    expect(isFmaId(inn.object!)).toBe(false)
    expect(graph.resolveFma(inn.object!).map((id) => graph.part(id)!.side).sort()).toEqual(['L', 'R'])
    const back = graph.relationsByKind(inn.object!).find(([k]) => k === 'innervates')!
    expect(back[1].length).toBeGreaterThanOrEqual(3)
    expect(back[1].some((r) => r.object === biceps.fma)).toBe(true)
  })
})
