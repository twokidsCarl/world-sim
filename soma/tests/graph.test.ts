import { describe, expect, it } from 'vitest'
import { AnatomyGraph, boundsCenter, normalizeText } from '../src/anatomy/graph.ts'
import type { AnatomyData, Concept, NameEntry, Part, Relation } from '../src/anatomy/types.ts'

function part(id: string, fma: string, name: string, over: Partial<Part> = {}): Part {
  return {
    id,
    fma,
    name,
    system: 'skeletal',
    tissue: 'bone',
    depth: 2,
    side: 'M',
    provenance: 'scanned',
    bbox: [0, 0, 0, 1, 1, 1],
    centroid: [0.5, 0.5, 0.5],
    triangles: 12,
    adjacent: [],
    ...over,
  }
}

const c = (id: string, name: string, parent: string | null, parts: string[] = []): Concept => ({ id, name, parent, parts })

function makeData(): AnatomyData {
  return {
    schema: 1,
    body: 'male',
    sources: [{ name: 'Test', url: 'https://example.org', license: 'CC0', attribution: 'none' }],
    systems: [
      { id: 'skeletal', name: { en: 'Skeletal', zh: '骨骼系统' }, color: '#eee', glb: 'skeletal.glb', partCount: 4 },
      { id: 'muscular', name: { en: 'Muscular', zh: '肌肉系统' }, color: '#a00', glb: 'muscular.glb', partCount: 1 },
      { id: 'nervous', name: { en: 'Nervous', zh: '神经系统' }, color: '#aa0', glb: null, partCount: 0 },
    ],
    layers: [{ name: { en: 'Skin', zh: '皮肤' } }, { name: { en: 'Muscle', zh: '肌肉' } }, { name: { en: 'Bone', zh: '骨' } }],
    parts: [
      part('P1', 'FMA10', 'Left femur', { side: 'L', bbox: [0.1, 0.5, 0, 0.2, 0.9, 0.1], centroid: [0.15, 0.7, 0.05], adjacent: ['P3', 'P5', 'GONE'] }),
      part('P2', 'FMA11', 'Right femur', { side: 'R', bbox: [-0.2, 0.5, 0, -0.1, 0.9, 0.1], centroid: [-0.15, 0.7, 0.05], adjacent: ['P4'] }),
      part('P3', 'FMA12', 'Left tibia', { side: 'L', bbox: [0.1, 0.1, 0, 0.2, 0.5, 0.1], centroid: [0.15, 0.3, 0.05], adjacent: ['P1'] }),
      part('P4', 'FMA13', 'Right tibia', { side: 'R', bbox: [-0.2, 0.1, 0, -0.1, 0.5, 0.1], centroid: [-0.15, 0.3, 0.05], adjacent: ['P2'] }),
      part('P5', 'FMA20', 'Left quadriceps femoris', { system: 'muscular', tissue: 'muscle', depth: 1, side: 'L', adjacent: ['P1'] }),
    ],
    trees: {
      isa: [
        c('FMA1', 'Anatomical structure', null),
        c('FMA2', 'Bone organ', 'FMA1'),
        c('FMA3', 'Femur', 'FMA2'),
        c('FMA4', 'Tibia', 'FMA2'),
        c('FMA10', 'Left femur', 'FMA3', ['P1']),
        c('FMA11', 'Right femur', 'FMA3', ['P2']),
        c('FMA12', 'Left tibia', 'FMA4', ['P3']),
        c('FMA13', 'Right tibia', 'FMA4', ['P4']),
        c('FMA5', 'Muscle organ', 'FMA1'),
        c('FMA20', 'Left quadriceps femoris', 'FMA5', ['P5']),
        c('FMA6', 'Empty class', 'FMA1'),
      ],
      partOf: [
        c('FMA100', 'Human body', null),
        c('FMA101', 'Left lower limb', 'FMA100', ['P1', 'P3', 'NOPE']),
        c('FMA102', 'Orphan region', 'FMA999', ['P2']),
      ],
    },
  }
}

const names: Record<string, NameEntry> = {
  FMA10: { zh: '左股骨', la: 'Femur sinistrum', status: 'unreviewed' },
  FMA11: { zh: '右股骨', status: 'reviewed' },
  FMA3: { zh: '股骨', la: 'Femur', status: 'reviewed' },
  FMA20: { zh: '左股四头肌', la: 'Musculus quadriceps femoris', status: 'unreviewed' },
}

const src = { name: 'Src', url: 'https://example.org/s', license: 'CC0' }
const relations: Relation[] = [
  { subject: 'FMA20', kind: 'origin', object: 'FMA10', objectLabel: { en: 'Femur', zh: '股骨' }, source: src, status: 'unreviewed' },
  { subject: 'FMA20', kind: 'insertion', object: 'FMA4', objectLabel: { en: 'Tibial tuberosity' }, source: src, status: 'reviewed' },
  { subject: 'FMA20', kind: 'origin', objectLabel: { en: 'Ilium' }, source: src, status: 'unreviewed' },
  { subject: 'FMA20', kind: 'innervatedBy', object: 'FMA777', objectLabel: { en: 'Femoral nerve' }, source: src, status: 'unreviewed' },
]

const graph = () => new AnatomyGraph(makeData(), names, relations)

describe('AnatomyGraph parts', () => {
  it('indexes parts by id, system and FMA id', () => {
    const g = graph()
    expect(g.part('P3')?.name).toBe('Left tibia')
    expect(g.part('nope')).toBeUndefined()
    expect(g.indexOf('P4')).toBe(3)
    expect(g.indexOf('nope')).toBe(-1)
    expect(g.partsBySystem('skeletal').map((p) => p.id)).toEqual(['P1', 'P2', 'P3', 'P4'])
    expect(g.partsBySystem('muscular').map((p) => p.id)).toEqual(['P5'])
    expect(g.partsBySystem('nervous')).toEqual([])
    expect(g.partsByFma('FMA12').map((p) => p.id)).toEqual(['P3'])
  })

  it('drops dangling adjacency ids', () => {
    expect(graph().adjacentParts('P1').map((p) => p.id)).toEqual(['P3', 'P5'])
    expect(graph().adjacentParts('nope')).toEqual([])
  })

  it('computes union bounds', () => {
    const g = graph()
    expect(g.bounds(['P1', 'P3'])).toEqual([0.1, 0.1, 0, 0.2, 0.9, 0.1])
    expect(g.bounds(['nope'])).toBeNull()
    expect(g.bodyBounds).toEqual([-0.2, 0, 0, 1, 1, 1])
    expect(boundsCenter([0, 0, 0, 2, 4, 6])).toEqual([1, 2, 3])
  })
})

describe('AnatomyGraph trees', () => {
  it('finds roots and children, treating a missing parent as a root', () => {
    const g = graph()
    expect(g.roots('isa').map((x) => x.id)).toEqual(['FMA1'])
    expect(g.children('isa', 'FMA1').map((x) => x.name)).toEqual(['Bone organ', 'Empty class', 'Muscle organ'])
    expect(g.roots('partOf').map((x) => x.id)).toEqual(['FMA100', 'FMA102'])
    expect(g.conceptCount('isa')).toBe(11)
  })

  it('walks ancestors and paths', () => {
    const g = graph()
    expect(g.ancestors('isa', 'FMA10').map((x) => x.id)).toEqual(['FMA3', 'FMA2', 'FMA1'])
    expect(g.path('isa', 'FMA10').map((x) => x.id)).toEqual(['FMA1', 'FMA2', 'FMA3', 'FMA10'])
    expect(g.ancestors('isa', 'FMA1')).toEqual([])
    expect(g.path('isa', 'missing')).toEqual([])
  })

  it('collects descendant parts and counts, ignoring part ids not in the body', () => {
    const g = graph()
    expect([...g.descendantParts('isa', 'FMA2')].sort()).toEqual(['P1', 'P2', 'P3', 'P4'])
    expect(g.descendantParts('isa', 'FMA3')).toEqual(['P1', 'P2'])
    expect(g.descendantParts('isa', 'FMA6')).toEqual([])
    expect(g.descendantParts('isa', 'missing')).toEqual([])
    expect(g.descendantParts('partOf', 'FMA101')).toEqual(['P1', 'P3'])
    expect(g.partCount('isa', 'FMA1')).toBe(5)
    expect(g.partCount('isa', 'FMA6')).toBe(0)
    expect(g.partCount('partOf', 'FMA100')).toBe(2)
    // memoised: same array instance on repeat calls
    expect(g.descendantParts('isa', 'FMA2')).toBe(g.descendantParts('isa', 'FMA2'))
  })

  it('reports coverage: isa covers everything, partOf only a subset', () => {
    const g = graph()
    expect(g.coverage('isa')).toBe(5)
    expect(g.coverage('partOf')).toBe(3)
  })

  it('gives each part its chain in each tree', () => {
    const g = graph()
    expect(g.partChain('isa', 'P5').map((x) => x.id)).toEqual(['FMA1', 'FMA5', 'FMA20'])
    expect(g.partChain('partOf', 'P3').map((x) => x.id)).toEqual(['FMA100', 'FMA101'])
    expect(g.partChain('partOf', 'P5')).toEqual([])
    expect(g.conceptOfPart('partOf', 'P2')?.id).toBe('FMA102')
  })

  it('counts a part once when several concepts list it, and files it under the deepest', () => {
    const d = makeData()
    d.trees.partOf = [
      c('B', 'Body', null, ['P1']),
      c('L', 'Limb', 'B', ['P1', 'P3']),
      c('T', 'Thigh', 'L', ['P1']),
      c('S', 'Skeleton', 'B', ['P3']),
    ]
    const g = new AnatomyGraph(d)
    expect(g.partCount('partOf', 'B')).toBe(2)
    expect(g.partCount('partOf', 'L')).toBe(2)
    expect(g.coverage('partOf')).toBe(2)
    expect(g.partChain('partOf', 'P1').map((x) => x.id)).toEqual(['B', 'L', 'T'])
  })

  it('survives cyclic parent links', () => {
    const d = makeData()
    d.trees.partOf = [c('A', 'A', 'B', ['P1']), c('B', 'B', 'A', ['P2'])]
    const g = new AnatomyGraph(d)
    expect(g.ancestors('partOf', 'A').map((x) => x.id)).toEqual(['B'])
    expect([...g.descendantParts('partOf', 'A')].sort()).toEqual(['P1', 'P2'])
    expect(g.roots('partOf')).toEqual([])
  })

  it('resolves an FMA id to parts: own id first, then concept descendants', () => {
    const g = graph()
    expect(g.resolveFma('FMA10')).toEqual(['P1'])
    expect(g.resolveFma('FMA4')).toEqual(['P3', 'P4'])
    expect(g.resolveFma('FMA101')).toEqual(['P1', 'P3'])
    expect(g.resolveFma('FMA777')).toEqual([])
  })
})

describe('AnatomyGraph knowledge', () => {
  it('prefers zh names and keeps review status', () => {
    const g = graph()
    expect(g.partName(g.part('P1')!)).toEqual({ primary: '左股骨', en: 'Left femur', zh: '左股骨', la: 'Femur sinistrum', status: 'unreviewed' })
    expect(g.partName(g.part('P3')!)).toEqual({ primary: 'Left tibia', en: 'Left tibia', zh: undefined, la: undefined, status: undefined })
    expect(g.conceptName(g.concept('isa', 'FMA3')!).primary).toBe('股骨')
  })

  it('works with no knowledge layer at all', () => {
    const g = new AnatomyGraph(makeData())
    expect(g.hasKnowledge).toBe(false)
    expect(g.partName(g.part('P1')!).primary).toBe('Left femur')
    expect(g.relationsFor('FMA20')).toEqual([])
    expect(g.search('femur').length).toBeGreaterThan(0)
    expect(g.search('股骨')).toEqual([])
  })

  it('groups relations by kind', () => {
    const groups = graph().relationsByKind('FMA20')
    expect(groups.map(([k, l]) => [k, l.length])).toEqual([
      ['origin', 2],
      ['insertion', 1],
      ['innervatedBy', 1],
    ])
    expect(graph().relationsByKind('FMA10')).toEqual([])
  })
})

describe('AnatomyGraph search', () => {
  it('matches English names case-insensitively, group concept first', () => {
    const r = graph().search('FEMUR')
    expect(r[0]).toMatchObject({ kind: 'concept', id: 'FMA3', tree: 'isa', partCount: 2 })
    expect(r.map((x) => x.id)).toEqual(expect.arrayContaining(['P1', 'P2']))
  })

  it('matches Chinese and Latin names', () => {
    const g = graph()
    expect(g.search('左股骨')[0]).toMatchObject({ kind: 'part', id: 'P1' })
    expect(g.search('股骨').map((x) => x.id)).toEqual(expect.arrayContaining(['FMA3', 'P1', 'P2']))
    expect(g.search('musculus quadriceps')[0]).toMatchObject({ kind: 'part', id: 'P5' })
  })

  it('matches FMA ids with or without the prefix, and part ids', () => {
    const g = graph()
    expect(g.search('FMA12')[0]).toMatchObject({ kind: 'part', id: 'P3' })
    expect(g.search('12')[0]).toMatchObject({ kind: 'part', id: 'P3' })
    expect(g.search('fma100')[0]).toMatchObject({ kind: 'concept', id: 'FMA100', tree: 'partOf' })
    expect(g.search('p4')[0]).toMatchObject({ kind: 'part', id: 'P4' })
  })

  it('does not list a part twice via its own single-part concept', () => {
    const r = graph().search('left tibia')
    expect(r.filter((x) => x.fma === 'FMA12')).toHaveLength(1)
    expect(r[0]).toMatchObject({ kind: 'part', id: 'P3' })
  })

  it('requires every token of a multi-word query', () => {
    const g = graph()
    expect(g.search('tibia left').map((x) => x.id)).toEqual(['P3'])
    expect(g.search('tibia zzz')).toEqual([])
  })

  it('handles empty queries and limits', () => {
    const g = graph()
    expect(g.search('   ')).toEqual([])
    expect(g.search('e', 2)).toHaveLength(2)
    expect(normalizeText('  ＦＭＡ１２ ')).toBe('fma12')
  })
})
