// 体表图：解码、三角形区域、概念互查，以及 store 中的开关与往返流程。
// Skin maps: decoding, per-triangle regions, concept lookups, and the store's toggle and round-trip flows.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { AnatomyGraph } from '../src/anatomy/graph.ts'
import {
  SKIN_UNASSIGNED,
  decodeSkinMaps,
  regionParts,
  regionVertexCounts,
  regionsForParts,
  triangleRegion,
  triangleRegions,
  type LoadedSkinMaps,
} from '../src/anatomy/skinmaps.ts'
import type { AnatomyData, NameEntry, Part, Relation, SkinMaps } from '../src/anatomy/types.ts'
import { setSkinMapLoader, useApp } from '../src/state/store.ts'

const p = (id: string, fma: string, over: Partial<Part> = {}): Part => ({
  id,
  fma,
  name: id,
  system: 'nervous',
  tissue: 'nerve',
  depth: 0,
  side: 'M',
  provenance: 'curated',
  bbox: [0, 0, 0, 1, 1, 1],
  centroid: [0, 0, 0],
  triangles: 1,
  adjacent: [],
  ...over,
})

const data: AnatomyData = {
  schema: 1,
  body: 'male',
  sources: [],
  systems: [
    { id: 'nervous', name: { en: 'N', zh: 'N' }, color: '#ff0', glb: 'n.glb', partCount: 3 },
    { id: 'integumentary', name: { en: 'I', zh: 'I' }, color: '#fa8', glb: 'i.glb', partCount: 1 },
  ],
  layers: [{ name: { en: 'a', zh: 'a' } }],
  parts: [
    p('skin', 'FMAskin', { system: 'integumentary', tissue: 'skin' }),
    p('ulnarL', 'FMA1L', { side: 'L' }),
    p('ulnarR', 'FMA1R', { side: 'R' }),
    p('c5', 'FMAc5'),
  ],
  trees: {
    isa: [
      { id: 'ROOT', name: 'Root', parent: null, parts: ['skin'] },
      { id: 'FMA1', name: 'Ulnar nerve', parent: 'ROOT', parts: [] },
      { id: 'FMA1L', name: 'Left ulnar nerve', parent: 'FMA1', parts: ['ulnarL'] },
      { id: 'FMA1R', name: 'Right ulnar nerve', parent: 'FMA1', parts: ['ulnarR'] },
      { id: 'FMAc5', name: 'C5 ganglion', parent: 'ROOT', parts: ['c5'] },
    ],
    partOf: [],
  },
}

const src = { name: 'S', url: 'https://example.org', license: 'CC0' }
const json: SkinMaps = {
  part: 'skin',
  vertexCount: 6,
  maps: [
    {
      id: 'dermatome',
      name: { zh: '皮节', en: 'Dermatomes' },
      regions: [
        { name: { zh: 'C5', en: 'C5' }, concept: 'FMAc5', color: '#ff0000' },
        { name: { zh: 'C6', en: 'C6' }, concept: 'FMA404', color: '#00ff00' },
      ],
      offset: 0,
      method: { zh: '方法', en: 'method' },
      sources: [src],
      status: 'unreviewed',
    },
    {
      id: 'cutaneousNerve',
      name: { zh: '皮神经分布区', en: 'Territories' },
      regions: [
        { name: { zh: '尺神经', en: 'Ulnar nerve' }, concept: 'FMA1', color: '#0000ff' },
        { name: { zh: '其余', en: 'Rest' }, color: '#888888' },
      ],
      offset: 6,
      method: { zh: '方法', en: 'method' },
      sources: [src],
      status: 'unreviewed',
    },
  ],
}
const bin = new Uint8Array([0, 0, 0, 1, 1, 255, /* map 2 */ 0, 1, 1, 1, 0, 0])
const graph = new AnatomyGraph(data)
const loaded = (): LoadedSkinMaps => decodeSkinMaps(json, bin.buffer.slice(0))

describe('decodeSkinMaps', () => {
  it('slices one byte per vertex per map', () => {
    const m = loaded()
    expect(m.part).toBe('skin')
    expect([...m.maps[0]!.data]).toEqual([0, 0, 0, 1, 1, 255])
    expect([...m.maps[1]!.data]).toEqual([0, 1, 1, 1, 0, 0])
    expect(regionVertexCounts(m.maps[0]!)).toEqual([3, 2])
  })

  it('rejects files that do not agree', () => {
    expect(() => decodeSkinMaps(json, bin.buffer.slice(0, 10))).toThrow(/skinmaps\.bin/)
    const bad = new Uint8Array(bin)
    bad[2] = 7
    expect(() => decodeSkinMaps(json, bad.buffer)).toThrow(/越界|out of range/)
    expect(() => decodeSkinMaps({ ...json, maps: [{ ...json.maps[0]!, regions: [] }] }, bin.buffer.slice(0))).toThrow(/区域数|region count/)
    expect(() => decodeSkinMaps({} as SkinMaps, bin.buffer.slice(0))).toThrow(/SkinMaps/)
  })
})

describe('per-triangle regions', () => {
  const d = new Uint8Array([0, 0, 1, 1, 2, SKIN_UNASSIGNED])
  it('takes the majority of the three vertices, the first when all differ', () => {
    expect(triangleRegion(d, 0, 1, 2)).toBe(0)
    expect(triangleRegion(d, 0, 2, 3)).toBe(1)
    expect(triangleRegion(d, 2, 0, 3)).toBe(1)
    expect(triangleRegion(d, 0, 2, 4)).toBe(0)
    expect(triangleRegion(d, 5, 5, 0)).toBe(SKIN_UNASSIGNED)
    expect(triangleRegion(d, 0, 99, 98)).toBe(SKIN_UNASSIGNED) // out-of-range vertices count as unassigned
  })

  it('maps a whole index buffer', () => {
    expect([...triangleRegions([0, 1, 2, 2, 3, 4, 4, 5, 5], d)]).toEqual([0, 1, SKIN_UNASSIGNED])
  })
})

describe('regions and the ontology', () => {
  it('resolves a region to its supplying parts, through a concept when needed', () => {
    const m = loaded()
    expect(regionParts(graph, m.maps[0]!, 0)).toEqual(['c5'])
    expect(regionParts(graph, m.maps[0]!, 1)).toEqual([]) // concept not in this body
    expect([...regionParts(graph, m.maps[1]!, 0)].sort()).toEqual(['ulnarL', 'ulnarR'])
    expect(regionParts(graph, m.maps[1]!, 1)).toEqual([]) // no concept at all
    expect(regionParts(graph, m.maps[1]!, 9)).toEqual([])
  })

  it('finds the regions supplied by selected parts', () => {
    const m = loaded()
    expect(regionsForParts(graph, m, ['ulnarR'])).toEqual([{ map: 'cutaneousNerve', region: 0 }])
    expect(regionsForParts(graph, m, ['c5', 'ulnarL'])).toEqual([
      { map: 'dermatome', region: 0 },
      { map: 'cutaneousNerve', region: 0 },
    ])
    expect(regionsForParts(graph, m, ['skin'])).toEqual([])
    expect(regionsForParts(graph, m, [])).toEqual([])
  })
})

describe('store: skin map flows', () => {
  const S = () => useApp.getState()
  let loads = 0
  beforeEach(() => {
    loads = 0
    setSkinMapLoader(async () => {
      loads++
      return loaded()
    })
    useApp.setState({ skinMapMode: 'off' })
    S().init(new AnatomyGraph(data), 'male')
    S().clearSelection()
  })

  it('loads lazily, once, on first use', async () => {
    expect(S().skinMapsStatus).toBe('idle')
    expect(loads).toBe(0)
    S().setSkinMapMode('dermatome')
    expect(S().skinMapsStatus).toBe('loading')
    await S().ensureSkinMaps()
    expect(S().skinMapsStatus).toBe('ready')
    S().setSkinMapMode('cutaneousNerve')
    S().setSkinMapMode('off')
    S().setSkinMapMode('dermatome')
    await S().ensureSkinMaps()
    expect(loads).toBe(1)
  })

  it('reports a body without maps, and one whose skin part is missing', async () => {
    setSkinMapLoader(async () => null)
    S().setSkinMapMode('dermatome')
    await S().ensureSkinMaps()
    expect(S().skinMapsStatus).toBe('missing')
    S().init(new AnatomyGraph(data), 'male')
    setSkinMapLoader(async () => ({ ...loaded(), part: 'nope' }))
    await S().ensureSkinMaps()
    expect(S().skinMapsStatus).toBe('error')
    expect(S().skinMaps).toBeNull()
  })

  it('region → nerve: selects the supplying parts and makes the skin see-through', async () => {
    S().setSkinMapMode('cutaneousNerve')
    await S().ensureSkinMaps()
    S().selectSkinRegions([0])
    expect(S().skinRegions).toEqual([0])
    expect(S().showRegionNerve(0)).toBe(true)
    expect([...S().selection.ids].sort()).toEqual(['ulnarL', 'ulnarR'])
    expect(S().skinSeeThrough).toBe(true)
    expect(S().skinRegions).toEqual([0])
    expect(S().showRegionNerve(1)).toBe(false) // no concept
    // 再点一个区域：回到不透明，并清除结构选择 / picking another region: opaque again, selection dropped
    S().selectSkinRegions([1])
    expect(S().skinSeeThrough).toBe(false)
    expect(S().selection.ids).toEqual([])
  })

  it('nerve → region: turns the right map on and highlights it', async () => {
    S().selectParts(['c5'])
    expect(await S().showSkinForSelection()).toBe(1)
    expect(S().skinMapMode).toBe('dermatome')
    expect(S().skinRegions).toEqual([0])
    expect(S().selection.ids).toEqual(['c5'])
    S().selectParts(['ulnarL'])
    expect(await S().showSkinForSelection()).toBe(1)
    expect(S().skinMapMode).toBe('cutaneousNerve')
    S().selectParts(['skin'])
    expect(await S().showSkinForSelection()).toBe(0)
  })

  it('additive region picks toggle; clearing the selection clears regions; a body switch drops the maps', async () => {
    S().setSkinMapMode('dermatome')
    await S().ensureSkinMaps()
    S().selectSkinRegions([0])
    S().selectSkinRegions([1], { additive: true })
    expect(S().skinRegions).toEqual([0, 1])
    S().selectSkinRegions([0], { additive: true })
    expect(S().skinRegions).toEqual([1])
    S().clearSelection()
    expect(S().skinRegions).toEqual([])
    S().selectSkinRegions([1])
    S().init(new AnatomyGraph({ ...data, body: 'female' }), 'female')
    expect(S().skinMaps).toBeNull()
    expect(S().skinRegions).toEqual([])
    expect(S().skinMapMode).toBe('dermatome') // 开关保留，新人体的图重新加载 / the mode is kept; the new body's maps reload
    await S().ensureSkinMaps()
    expect(S().skinMapsStatus).toBe('ready')
    expect(loads).toBe(2)
  })
})

// 生成的示例数据（未提交，缺失时跳过）/ the generated fixture (not committed; skipped when absent)
const dir = resolve(__dirname, '../public/anatomy/fixture')
describe.skipIf(!existsSync(resolve(dir, 'skinmaps.json')))('fixture skin maps', () => {
  const read = <T>(f: string): T => JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as T
  it('decode, cover every region, and resolve their concepts', () => {
    const g = new AnatomyGraph(read<AnatomyData>('anatomy.json'), read<Record<string, NameEntry>>('knowledge/names.json'), read<Relation[]>('knowledge/relations.json'))
    const raw = readFileSync(resolve(dir, 'skinmaps.bin'))
    const m = decodeSkinMaps(read<SkinMaps>('skinmaps.json'), raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    expect(g.part(m.part)?.tissue).toBe('skin')
    expect(m.maps.map((x) => x.id)).toEqual(['dermatome', 'cutaneousNerve'])
    for (const map of m.maps) {
      expect(regionVertexCounts(map).every((n) => n > 0)).toBe(true)
      expect(map.method.zh).toMatch(/未经临床审校/)
    }
    expect(m.maps[1]!.data.includes(SKIN_UNASSIGNED)).toBe(true)
    const nerve = m.maps[1]!
    const ulnar = regionParts(g, nerve, 0).map((id) => g.part(id)!.name).sort()
    expect(ulnar).toEqual(['Left ulnar nerve', 'Right ulnar nerve'])
    expect(regionParts(g, m.maps[0]!, 2)).toEqual([]) // 概念不在此人体中 / concept absent from this body
    expect(regionsForParts(g, m, [g.parts.find((x) => x.name === 'Spinal cord')!.id])).toEqual([{ map: 'dermatome', region: 1 }])
  })
})
