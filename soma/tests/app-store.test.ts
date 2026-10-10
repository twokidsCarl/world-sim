import { beforeEach, describe, expect, it } from 'vitest'
import { AnatomyGraph } from '../src/anatomy/graph.ts'
import type { AnatomyData, Part, SystemId } from '../src/anatomy/types.ts'
import { isSolo, useApp } from '../src/state/store.ts'

const p = (id: string, system: SystemId, adjacent: string[] = []): Part => ({
  id,
  fma: `FMA${id}`,
  name: id,
  system,
  tissue: 'other',
  depth: 0,
  side: 'M',
  provenance: 'scanned',
  bbox: [0, 0, 0, 1, 1, 1],
  centroid: [0, 0, 0],
  triangles: 1,
  adjacent,
})

const data: AnatomyData = {
  schema: 1,
  body: 'male',
  sources: [],
  systems: [
    { id: 'skeletal', name: { en: 'S', zh: 'S' }, color: '#fff', glb: 's.glb', partCount: 2 },
    { id: 'muscular', name: { en: 'M', zh: 'M' }, color: '#f00', glb: 'm.glb', partCount: 1 },
  ],
  layers: [{ name: { en: 'a', zh: 'a' } }],
  parts: [p('a', 'skeletal'), p('b', 'skeletal'), p('c', 'muscular')],
  trees: {
    isa: [
      { id: 'ROOT', name: 'Root', parent: null, parts: [] },
      { id: 'BONES', name: 'Bones', parent: 'ROOT', parts: ['a', 'b'] },
      { id: 'FMAc', name: 'c', parent: 'ROOT', parts: ['c'] },
      { id: 'NONE', name: 'None', parent: 'BONES', parts: [] },
    ],
    partOf: [],
  },
}

const S = () => useApp.getState()

beforeEach(() => {
  S().init(new AnatomyGraph(data), 'fixture')
  S().clearSelection()
  S().showAll()
})

describe('store selection', () => {
  it('selects parts, ignoring unknown ids', () => {
    S().selectParts(['a', 'zzz'])
    expect(S().selection.ids).toEqual(['a'])
    expect(S().selection.concept).toBeNull()
  })

  it('additive click toggles membership', () => {
    S().selectParts(['a'])
    S().selectParts(['b'], { additive: true })
    expect(S().selection.ids).toEqual(['a', 'b'])
    S().selectParts(['a'], { additive: true })
    expect(S().selection.ids).toEqual(['b'])
  })

  it('selecting a concept selects every part under it and can reveal it in the tree', () => {
    S().selectConcept('isa', 'BONES', { reveal: true })
    expect(S().selection.ids).toEqual(['a', 'b'])
    expect(S().selection.concept).toEqual({ tree: 'isa', id: 'BONES' })
    expect(S().expanded.isa.has('ROOT')).toBe(true)
    expect(S().leftTab).toBe('tree')
    expect(S().reveal).toMatchObject({ tree: 'isa', id: 'BONES' })
  })

  it('keeps an empty concept selected so its info can be shown', () => {
    S().selectConcept('isa', 'NONE')
    expect(S().selection.ids).toEqual([])
    expect(S().selection.concept).toEqual({ tree: 'isa', id: 'NONE' })
  })

  it('selectFma resolves a part id first, then a concept', () => {
    expect(S().selectFma('FMAa')).toBe(true)
    expect(S().selection.ids).toEqual(['a'])
    expect(S().selectFma('BONES')).toBe(true)
    expect(S().selection.concept).toEqual({ tree: 'isa', id: 'BONES' })
    expect(S().selectFma('FMA404')).toBe(false)
  })
})

describe('store visibility', () => {
  it('solo shows one system and toggles back', () => {
    S().soloSystem('muscular')
    expect(S().systems.skeletal?.visible).toBe(false)
    expect(S().systems.muscular?.visible).toBe(true)
    expect(isSolo(S().systems, 'muscular')).toBe(true)
    S().soloSystem('muscular')
    expect(S().systems.skeletal?.visible).toBe(true)
  })

  it('clamps opacity and keeps visibility', () => {
    S().setSystemOpacity('skeletal', 1.7)
    expect(S().systems.skeletal).toEqual({ visible: true, opacity: 1 })
    S().setSystemOpacity('skeletal', -1)
    expect(S().systems.skeletal?.opacity).toBe(0)
  })

  it('hiding the selection clears it; show-all restores everything', () => {
    S().selectParts(['a'])
    S().hideSelection()
    expect([...S().hidden]).toEqual(['a'])
    expect(S().selection.ids).toEqual([])
    S().setPeel(3)
    S().setSystemVisible('muscular', false)
    S().selectParts(['b'])
    S().isolateSelection()
    S().setAdjacentMode(true)
    expect([...(S().isolated ?? [])]).toEqual(['b'])
    S().showAll()
    expect(S().hidden.size).toBe(0)
    expect(S().isolated).toBeNull()
    expect(S().adjacentMode).toBe(false)
    expect(S().peel).toBe(0)
    expect(S().systems.muscular?.visible).toBe(true)
  })

  it('hide/show by id set (tree eye toggle)', () => {
    S().hideParts(['a', 'b'])
    expect(S().hidden.size).toBe(2)
    S().showParts(['a'])
    expect([...S().hidden]).toEqual(['b'])
  })

  it('provenance filter and colour mode; show-all clears the filter but keeps the colour mode', () => {
    S().setProvenanceVisible('curated', false)
    S().setProvenanceVisible('warped', false)
    S().setProvenanceVisible('warped', true)
    expect([...S().provenanceHidden]).toEqual(['curated'])
    S().setColorMode('source')
    S().showAll()
    expect(S().provenanceHidden.size).toBe(0)
    expect(S().colorMode).toBe('source')
    S().setColorMode('tissue')
    expect(S().nerveBoost).toBe(true)
    S().setNerveBoost(false)
    expect(S().nerveBoost).toBe(false)
    S().setNerveBoost(true)
  })

  it('focus requests bump a nonce', () => {
    const n = S().focusRequest.nonce
    S().requestFocus(['a'])
    expect(S().focusRequest).toEqual({ nonce: n + 1, ids: ['a'] })
  })
})
