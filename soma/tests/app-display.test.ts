import { describe, expect, it } from 'vitest'
import { AnatomyGraph } from '../src/anatomy/graph.ts'
import type { AnatomyData, Part, SystemId } from '../src/anatomy/types.ts'
import {
  EXPLODE_GAIN,
  GHOST,
  HIDDEN,
  NORMAL,
  adjacentFocus,
  clipRay,
  computeDisplay,
  computeExplode,
  sectionPlane,
  type DisplayInput,
} from '../src/state/display.ts'

function part(id: string, system: SystemId, depth: number, centroid: [number, number, number], adjacent: string[] = []): Part {
  return {
    id,
    fma: `FMA${id}`,
    name: id,
    system,
    tissue: 'other',
    depth,
    side: 'M',
    provenance: 'scanned',
    bbox: [centroid[0] - 0.1, centroid[1] - 0.1, centroid[2] - 0.1, centroid[0] + 0.1, centroid[1] + 0.1, centroid[2] + 0.1],
    centroid,
    triangles: 1,
    adjacent,
  }
}

const data: AnatomyData = {
  schema: 1,
  body: 'male',
  sources: [],
  systems: [],
  layers: [{ name: { en: 'a', zh: 'a' } }, { name: { en: 'b', zh: 'b' } }, { name: { en: 'c', zh: 'c' } }],
  parts: [
    part('skin', 'integumentary', 0, [0, 1, 0]),
    part('muscle', 'muscular', 1, [0.4, 1, 0], ['bone']),
    part('bone', 'skeletal', 2, [0.2, 1, 0], ['muscle', 'vessel']),
    part('vessel', 'cardiovascular', 2, [-0.4, 0.5, 0], ['bone']),
  ],
  trees: { isa: [], partOf: [] },
}
const graph = new AnatomyGraph(data)

const base: DisplayInput = { systems: {}, peel: 0, hidden: new Set(), isolated: null, adjacentMode: false, selected: new Set() }
const run = (over: Partial<DisplayInput>) => [...computeDisplay(graph, { ...base, ...over })]

describe('computeDisplay', () => {
  it('shows everything by default', () => {
    expect(run({})).toEqual([NORMAL, NORMAL, NORMAL, NORMAL])
  })

  it('applies system visibility', () => {
    expect(run({ systems: { muscular: { visible: false, opacity: 1 } } })).toEqual([NORMAL, HIDDEN, NORMAL, NORMAL])
  })

  it('peels superficial layers first', () => {
    expect(run({ peel: 1 })).toEqual([HIDDEN, NORMAL, NORMAL, NORMAL])
    expect(run({ peel: 2 })).toEqual([HIDDEN, HIDDEN, NORMAL, NORMAL])
  })

  it('hides explicitly hidden parts', () => {
    expect(run({ hidden: new Set(['bone']) })).toEqual([NORMAL, NORMAL, HIDDEN, NORMAL])
  })

  it('keeps a selected part visible through every filter', () => {
    expect(
      run({ peel: 2, hidden: new Set(['skin']), systems: { integumentary: { visible: false, opacity: 1 } }, selected: new Set(['skin']) }),
    ).toEqual([NORMAL, HIDDEN, NORMAL, NORMAL])
  })

  it('isolation overrides system toggles and peel', () => {
    expect(run({ isolated: new Set(['muscle']), peel: 2, systems: { muscular: { visible: false, opacity: 1 } } })).toEqual([
      HIDDEN,
      NORMAL,
      HIDDEN,
      HIDDEN,
    ])
  })

  it('adjacent mode ghosts everything but the selection and its neighbours', () => {
    expect(run({ adjacentMode: true, selected: new Set(['bone']) })).toEqual([GHOST, NORMAL, NORMAL, NORMAL])
    expect(run({ adjacentMode: true, selected: new Set(['muscle']) })).toEqual([GHOST, NORMAL, NORMAL, GHOST])
    // neighbours are revealed even when their system is off; other hidden parts stay hidden
    expect(
      run({ adjacentMode: true, selected: new Set(['muscle']), systems: { skeletal: { visible: false, opacity: 1 } }, hidden: new Set(['vessel']) }),
    ).toEqual([GHOST, NORMAL, NORMAL, HIDDEN])
    // no selection: the mode has nothing to focus on
    expect(run({ adjacentMode: true })).toEqual([NORMAL, NORMAL, NORMAL, NORMAL])
  })

  it('reuses the output buffer when it fits', () => {
    const out = new Uint8Array(4)
    expect(computeDisplay(graph, base, out)).toBe(out)
    expect(computeDisplay(graph, base, new Uint8Array(2))).toHaveLength(4)
  })

  it('adjacentFocus is selection plus neighbours', () => {
    expect([...adjacentFocus(graph, new Set(['bone']))].sort()).toEqual(['bone', 'muscle', 'vessel'])
  })
})

describe('computeExplode', () => {
  it('is zero at amount 0', () => {
    expect([...computeExplode(graph, 0, null)]).toEqual(new Array(12).fill(0))
  })

  it('pushes parts away from the body centre in proportion to their offset', () => {
    const o = computeExplode(graph, 0.5, null)
    const b = graph.bodyBounds
    const cx = (b[0] + b[3]) / 2
    const cy = (b[1] + b[4]) / 2
    const k = 0.5 * EXPLODE_GAIN
    expect(o[3]).toBeCloseTo((0.4 - cx) * k)
    expect(o[4]).toBeCloseTo((1 - cy) * k)
    expect(o[9]).toBeCloseTo((-0.4 - cx) * k)
    // further from the centre moves further
    expect(Math.abs(o[3]!)).toBeGreaterThan(Math.abs(o[6]!))
  })

  it('with a selection scope only moves those parts, about their own centre', () => {
    const o = computeExplode(graph, 1, new Set(['muscle', 'bone']))
    expect([o[0], o[1], o[2]]).toEqual([0, 0, 0])
    expect([o[9], o[10], o[11]]).toEqual([0, 0, 0])
    expect(o[3]).toBeCloseTo(-o[6]!) // symmetric about the pair's centre
    expect(o[3]!).toBeGreaterThan(0)
  })

  it('falls back to the whole body when the scope has fewer than two parts', () => {
    const a = computeExplode(graph, 1, new Set(['bone']))
    const b = computeExplode(graph, 1, null)
    expect([...a]).toEqual([...b])
  })
})

describe('section plane', () => {
  const bounds: [number, number, number, number, number, number] = [-1, 0, -0.5, 1, 2, 0.5]
  const kept = (p: { normal: number[]; constant: number }, x: number, y: number, z: number) =>
    p.normal[0]! * x + p.normal[1]! * y + p.normal[2]! * z + p.constant >= 0

  it('axial keeps what is below the plane, flip keeps what is above', () => {
    const p = sectionPlane(bounds, { enabled: true, axis: 'axial', position: 0.5, flip: false })
    expect(kept(p, 0, 0.9, 0)).toBe(true)
    expect(kept(p, 0, 1.1, 0)).toBe(false)
    const f = sectionPlane(bounds, { enabled: true, axis: 'axial', position: 0.5, flip: true })
    expect(kept(f, 0, 0.9, 0)).toBe(false)
    expect(kept(f, 0, 1.1, 0)).toBe(true)
  })

  it('maps position across the body extent on each axis', () => {
    const s = sectionPlane(bounds, { enabled: true, axis: 'sagittal', position: 0.25, flip: false })
    expect(kept(s, -0.6, 1, 0)).toBe(true)
    expect(kept(s, -0.4, 1, 0)).toBe(false)
    const c = sectionPlane(bounds, { enabled: true, axis: 'coronal', position: 1, flip: false })
    expect(kept(c, 0, 1, 0.49)).toBe(true)
    expect(c.normal).toEqual([0, 0, -1])
  })

  it('clips a ray to the kept half-space', () => {
    const p = sectionPlane(bounds, { enabled: true, axis: 'axial', position: 0.5, flip: false }) // keep y <= 1
    // from above, looking down: enters the kept half at t = 2
    expect(clipRay([0, 3, 0], [0, -1, 0], p)).toEqual([2, Infinity])
    // from below, looking up: leaves it at t = 1
    expect(clipRay([0, 0, 0], [0, 1, 0], p)).toEqual([0, 1])
    // above and looking further up: never enters
    expect(clipRay([0, 3, 0], [0, 1, 0], p)).toBeNull()
    // parallel rays are all-or-nothing
    expect(clipRay([0, 0.5, 0], [1, 0, 0], p)).toEqual([0, Infinity])
    expect(clipRay([0, 1.5, 0], [1, 0, 0], p)).toBeNull()
  })
})
