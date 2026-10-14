// 写实外观显示时不画皮肤下面的部件：在一张小的固定图上核对哪些部件画、哪些不画，以及各种豁免。
// While the lifelike look shows, parts under the skin are not drawn: on a small fixed graph, which parts are drawn and
// which not, and every exemption.
import { describe, expect, it } from 'vitest'
import { AnatomyGraph } from '../src/anatomy/graph.ts'
import type { AnatomyData, Part, SystemId } from '../src/anatomy/types.ts'
import { LOOK_HIDES_HINT, LOOK_HIDES_INTERNAL } from '../src/look/statements.ts'
import { GHOST, HIDDEN, NORMAL, computeDisplay, hideUnderLifelikeSkin, type DisplayInput } from '../src/state/display.ts'

function part(id: string, system: SystemId, depth: number): Part {
  return { id, fma: `FMA${id}`, name: id, system, tissue: 'other', depth, side: 'M', provenance: 'scanned', bbox: [0, 0, 0, 1, 1, 1], centroid: [0.5, 0.5, 0.5], triangles: 1, adjacent: id === 'muscle' ? ['fat'] : id === 'fat' ? ['muscle'] : [] }
}

const data: AnatomyData = {
  schema: 1,
  body: 'male',
  sources: [],
  systems: [],
  layers: [{ name: { en: 'a', zh: 'a' } }, { name: { en: 'b', zh: 'b' } }],
  parts: [
    part('skin', 'integumentary', 0),
    part('fat', 'integumentary', 1),
    part('muscle', 'muscular', 1),
    part('bone', 'skeletal', 1),
    part('tooth', 'digestive', 1),
    part('eye', 'nervous', 1),
    part('hairShell', 'integumentary', 0),
  ],
  trees: { isa: [], partOf: [] },
}
const graph = new AnatomyGraph(data)
const base: DisplayInput = { systems: {}, peel: 0, hidden: new Set(), isolated: null, adjacentMode: false, selected: new Set(), unfitted: new Set(['hairShell']) }
const EYE = new Set([graph.indexOf('eye')])

function lifelike(over: Partial<DisplayInput> = {}, keep: (ReadonlySet<string> | null)[] = []): number[] {
  const input = { ...base, ...over }
  const d = computeDisplay(graph, input)
  hideUnderLifelikeSkin(graph, d, { skin: 'skin', keep: [input.selected, input.isolated, input.forced ?? null, input.unfitted ?? null, ...keep], keepIndex: EYE })
  return [...d]
}

describe('hideUnderLifelikeSkin', () => {
  it('draws only the skin (and the eyes, which their own layer handles) in lifelike mode', () => {
    // 不写实时（规则不跑）一切照旧 / without the lifelike look (the rule does not run) nothing changes
    expect([...computeDisplay(graph, base)]).toEqual([NORMAL, NORMAL, NORMAL, NORMAL, NORMAL, NORMAL, HIDDEN])
    expect(lifelike()).toEqual([NORMAL, HIDDEN, HIDDEN, HIDDEN, HIDDEN, NORMAL, HIDDEN])
  })

  it('keeps selected parts, the stimulus pathway, isolated parts and parts seen through the openings', () => {
    expect(lifelike({ selected: new Set(['muscle']) })[2]).toBe(NORMAL)
    expect(lifelike({}, [new Set(['bone'])])[3]).toBe(NORMAL) // 刺激通路 / stimulus pathway
    expect(lifelike({ isolated: new Set(['skin', 'fat']) })).toEqual([NORMAL, NORMAL, HIDDEN, HIDDEN, HIDDEN, HIDDEN, HIDDEN])
    expect(lifelike({ forced: new Set(['tooth']) })[4]).toBe(NORMAL)
  })

  it('leaves the hair shells to their own rule and the adjacent focus to the selection', () => {
    // 外壳按原规则：皮肤不透明时藏着，选中时显示 / the shells keep their rule: hidden under the opaque skin, shown when selected
    expect(lifelike()[6]).toBe(HIDDEN)
    expect(lifelike({ selected: new Set(['hairShell']) })[6]).toBe(NORMAL)
    // 相邻模式：选中部件的相邻部件也保留 / adjacent mode: the neighbours of the selection are kept as well
    const d = computeDisplay(graph, { ...base, adjacentMode: true, selected: new Set(['muscle']) })
    hideUnderLifelikeSkin(graph, d, { skin: 'skin', keep: [new Set(['muscle']), new Set(['muscle', 'fat'])], keepIndex: EYE })
    expect([...d]).toEqual([GHOST, NORMAL, NORMAL, HIDDEN, HIDDEN, GHOST, HIDDEN])
  })

  it('never shows a part that the other rules hid', () => {
    expect(lifelike({ hidden: new Set(['skin']) })[0]).toBe(HIDDEN)
    expect(lifelike({ systems: { nervous: { visible: false, opacity: 1 } } })[5]).toBe(HIDDEN)
  })

  it('says so in both languages', () => {
    for (const s of [LOOK_HIDES_INTERNAL, LOOK_HIDES_HINT]) {
      expect(/[一-鿿]/.test(s.zh)).toBe(true)
      expect(s.en).toMatch(/look=0|lifelike look off/)
    }
  })
})
