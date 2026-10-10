import { describe, expect, it } from 'vitest'
import { measure, type Mesh } from '../tools/pipeline/geometry.ts'
import { contentsInside, evaluateCandidates, IMPORT3_DEFAULTS, overlapWith, pairStructures, placeConcept, pushOutOfSolids, register3to4, SurfaceField, type ExistingPart } from '../tools/pipeline/import3.ts'
import { surfacePoints, thinPoints } from '../tools/pipeline/register.ts'
import { fmaOf, parseRelease3Tables, walkAncestors, type Release3, type Release3Part } from '../tools/pipeline/release3.ts'
import { buildOntology } from '../tools/pipeline/tables.ts'

/** Box tessellated finely enough for surface sampling and ICP to have something to hold on to. */
function box(min: [number, number, number], max: [number, number, number], n = 6): Mesh {
  const pos: number[] = []
  const idx: number[] = []
  const face = (o: number[], u: number[], v: number[], flip: boolean) => {
    const base = pos.length / 3
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(o[0]! + (u[0]! * i + v[0]! * j) / n, o[1]! + (u[1]! * i + v[1]! * j) / n, o[2]! + (u[2]! * i + v[2]! * j) / n)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = base + j * (n + 1) + i
      const tri = [a, a + 1, a + n + 2, a, a + n + 2, a + n + 1]
      if (flip) for (let k = 0; k < 6; k += 3) [tri[k + 1], tri[k + 2]] = [tri[k + 2]!, tri[k + 1]!]
      idx.push(...tri)
    }
  }
  const [x0, y0, z0] = min
  const d = [max[0] - x0, max[1] - y0, max[2] - z0]
  face([x0, y0, z0], [d[0]!, 0, 0], [0, d[1]!, 0], true) // z = z0
  face([x0, y0, max[2]], [d[0]!, 0, 0], [0, d[1]!, 0], false)
  face([x0, y0, z0], [d[0]!, 0, 0], [0, 0, d[2]!], false) // y = y0
  face([x0, max[1], z0], [d[0]!, 0, 0], [0, 0, d[2]!], true)
  face([x0, y0, z0], [0, d[1]!, 0], [0, 0, d[2]!], true) // x = x0
  face([max[0], y0, z0], [0, d[1]!, 0], [0, 0, d[2]!], false)
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}
const shifted = (m: Mesh, d: [number, number, number]): Mesh => ({ positions: Float32Array.from(m.positions, (v, i) => v + d[i % 3]!), indices: m.indices })
const existing = (id: string, fma: string, name: string, mesh: Mesh, tissue: ExistingPart['tissue'], system: ExistingPart['system']): ExistingPart => ({ id, fma, name, mesh, stats: measure(mesh), tissue, system })
const r3part = (id: string, name: string, mesh: Mesh): Release3Part => ({ id, name, mesh, stats: measure(mesh), sourceTriangles: mesh.indices.length / 3 })

describe('release 3.0 tables', () => {
  const t = parseRelease3Tables(
    '"id"\ten\nFMA1\thuman body\nFMA10\tmuscular system\nFMA20\trectus abdominis\nFMA21\tleft rectus abdominis\nBP7\tleft costal cartilage\n',
    '"id"\tname\tpart id\tpart name\nFMA1\thuman body\tFMA10\tmuscular system\nFMA10\tmuscular system\tFMA20\trectus abdominis\nFMA20\trectus abdominis\tFMA21\tleft rectus abdominis\nFMA1\thuman body\tFMA21\tleft rectus abdominis\nFMA30\tcostal cartilage\tBP7\tleft costal cartilage\n',
  )
  it('reads names and the multi-parent conventional tree', () => {
    expect(t.names.get('FMA21')).toBe('left rectus abdominis')
    expect(t.names.get('FMA30')).toBe('costal cartilage') // only named in the tree file
    expect(t.parents.get('FMA21')).toEqual(['FMA20', 'FMA1'])
  })
  it('maps file ids to FMA ids', () => {
    expect(fmaOf('FMA7197')).toBe('FMA7197')
    expect(fmaOf('FMA14543nsn')).toBe('FMA14543')
    expect(fmaOf('BP24')).toBeNull()
  })
  it('walks ancestors breadth-first with distances', () => {
    const seen: [string, number][] = []
    walkAncestors(t.parents, 'FMA21', (a, d) => void seen.push([a, d]))
    expect(seen).toEqual([['FMA20', 1], ['FMA1', 1], ['FMA10', 2]])
  })
})

describe('placeConcept', () => {
  const rel = 'parent id\tparent name\tchild id\tchild name\n'
  const isa = buildOntology(rel + 'FMA0\tanatomical entity\tFMA100\tmuscle organ\nFMA100\tmuscle organ\tFMA101\tmuscle of anterior abdominal wall\nFMA0\tanatomical entity\tFMA200\torgan\nFMA200\torgan\tFMA7197\tliver\n', 'concept id\tname\telement file id\nFMA0\tanatomical entity\tFJ1\nFMA200\torgan\tFJ1\nFMA7197\tliver\tFJ1\n')
  const partOf = buildOntology(rel + 'FMA1\thuman body\tFMA10\tmuscular system\nFMA1\thuman body\tFMA7309\tright lung\n', 'concept id\tname\telement file id\nFMA1\thuman body\tFJ1\nFMA7309\tright lung\tFJ1\n')
  const tables = parseRelease3Tables(
    '"id"\ten\nFMA21\tleft rectus abdominis\nFMA20\trectus abdominis\nFMA7197\tliver\nFMA7333\tupper lobe of right lung\nFMA7334\tright hilum\nFMA999\tmystery muscle\n',
    '"id"\tname\tpart id\tpart name\nFMA1\thuman body\tFMA10\tmuscular system\nFMA10\tmuscular system\tFMA20\trectus abdominis\nFMA20\trectus abdominis\tFMA21\tleft rectus abdominis\nFMA7309\tright lung\tFMA7333\tupper lobe of right lung\nFMA7309\tright lung\tFMA7334\tright hilum\nFMA1\thuman body\tFMA7309\tright lung\nFMA10\tmuscular system\tFMA999\tmystery muscle\n',
  )
  const r3: Release3 = { parts: new Map(), ...tables }
  it('uses the concept itself when the 4.0 tree has it', () => {
    const p = placeConcept(r3, 'FMA7197', isa, partOf)
    expect(p).toMatchObject({ fma: 'FMA7197', isaConcept: 'FMA7197', isaViaAncestor: false, isaByHand: false })
    expect(p.isa).toEqual(['liver', 'liver', 'organ', 'anatomical entity'])
  })
  it('applies the hand-made IS-A rules and collects 3.0 ancestors as PART-OF signal', () => {
    const p = placeConcept(r3, 'FMA21', isa, partOf)
    expect(p).toMatchObject({ isaConcept: 'FMA101', isaViaAncestor: true, isaByHand: true, partOfConcept: 'FMA10', partOfViaAncestor: true })
    expect(p.isa).toEqual(['left rectus abdominis', 'muscle of anterior abdominal wall', 'muscle organ', 'anatomical entity'])
    expect(p.partOf).toEqual(expect.arrayContaining(['muscular system', 'human body', 'rectus abdominis']))
  })
  it('falls back to the nearest 3.0 ancestor the tree knows, or nothing', () => {
    const hilum = placeConcept(r3, 'FMA7334', isa, partOf)
    expect(hilum).toMatchObject({ partOfConcept: 'FMA7309', partOfViaAncestor: true, isaConcept: null })
    expect(hilum.partOf.slice(0, 2)).toEqual(['right lung', 'human body'])
    const mystery = placeConcept(r3, 'FMA999', isa, partOf)
    expect(mystery).toMatchObject({ isaConcept: null, isaByHand: false, partOfConcept: 'FMA10' })
  })
  it('refuses a hand-made rule whose target concept the tree does not have', () => {
    expect(() => placeConcept(r3, 'FMA7333', isa, partOf)).toThrow(/anatomical lobe/)
  })
})

describe('pairStructures', () => {
  it('pairs by concept id, never pairs nsn/BP ids, and falls back to the aggregate', () => {
    const m = box([0, 0, 0], [1, 1, 1], 1)
    const r3: Release3 = { parts: new Map([['FMA1', r3part('FMA1', 'a', m)], ['FMA1nsn', r3part('FMA1nsn', 'a, nsn', m)], ['BP9', r3part('BP9', 'b', m)], ['FMA2', r3part('FMA2', 'c', m)], ['FMA3', r3part('FMA3', 'd', m)]]), names: new Map(), parents: new Map() }
    const ex = [existing('FJ1', 'FMA1', 'a', m, 'bone', 'skeletal'), existing('FJ2', 'FMA50', 'x', m, 'organ', 'digestive')]
    const pairs = pairStructures(r3, ex, (c) => (c === 'FMA2' ? ['FJ2'] : []))
    expect([...pairs.keys()].sort()).toEqual(['FMA1', 'FMA2'])
    expect(pairs.get('FMA1')).toEqual({ kind: 'direct', elements: ['FJ1'] })
    expect(pairs.get('FMA2')).toEqual({ kind: 'aggregate', elements: ['FJ2'] })
  })
})

describe('registration and import on a toy body', () => {
  // "3.0": two bones 20 cm apart and a muscle hanging between them; in "4.0" the whole body sits
  // 3 cm higher and 1 cm forward, and the muscle is missing.
  const D: [number, number, number] = [0, 0.03, 0.01]
  const boneA3 = box([0, 0, 0], [0.04, 0.1, 0.03])
  const boneB3 = box([0.2, 0, 0], [0.25, 0.08, 0.04])
  const muscle3 = box([0.06, 0.02, 0.005], [0.18, 0.06, 0.02])
  const organ3 = box([0.07, 0.03, 0.03], [0.17, 0.05, 0.05])
  const r3: Release3 = {
    parts: new Map([['FMA1', r3part('FMA1', 'bone a', boneA3)], ['FMA2', r3part('FMA2', 'bone b', boneB3)], ['FMA3', r3part('FMA3', 'muscle', muscle3)], ['FMA4', r3part('FMA4', 'organ', organ3)]]),
    names: new Map(), parents: new Map(),
  }
  const ex = [
    existing('FJ1', 'FMA1', 'Bone a', shifted(boneA3, D), 'bone', 'skeletal'),
    existing('FJ2', 'FMA2', 'Bone b', shifted(boneB3, D), 'bone', 'skeletal'),
    // 4.0 has the organ as two halves under other concept ids
    existing('FJ3', 'FMA41', 'Organ left half', shifted(box([0.07, 0.03, 0.03], [0.12, 0.05, 0.05]), D), 'organ', 'digestive'),
    existing('FJ4', 'FMA42', 'Organ right half', shifted(box([0.12, 0.03, 0.03], [0.17, 0.05, 0.05]), D), 'organ', 'digestive'),
  ]
  const opts = { ...IMPORT3_DEFAULTS, anchorSpacing: 0.01, minSigma: 0.02 }
  const pairs = pairStructures(r3, ex, () => [])
  const reg = register3to4(r3, ex, pairs, opts)

  it('fits the shared structures and reports the frame offset', () => {
    expect(reg.fits.length).toBe(2)
    for (const f of reg.fits) {
      expect(f.accepted).toBe(true)
      expect(f.centroidOffset[1]).toBeCloseTo(0.03, 3)
      expect(f.centroidOffset[2]).toBeCloseTo(0.01, 3)
      expect(f.rawForward.median).toBeGreaterThan(0.005)
      expect(Math.max(f.forward.p95, f.backward.p95)).toBeLessThan(0.002)
    }
    expect(reg.anchorStructures).toBe(2)
    expect(reg.fitResidual.max).toBeLessThan(0.002)
  })

  it('warps the missing structure along, flags the already-present one as redundant', () => {
    const field = new SurfaceField(ex)
    const cands = evaluateCandidates(r3, pairs, reg, field, (p) => (p.id === 'FMA4' ? 'digestive' : 'muscular'), () => null, opts)
    expect(cands.map((c) => c.part.id).sort()).toEqual(['FMA3', 'FMA4'])
    const muscle = cands.find((c) => c.part.id === 'FMA3')!
    expect(muscle.report.decision).toBe('import')
    expect(muscle.report.displacement).toBeCloseTo(Math.hypot(0.03, 0.01), 2)
    expect(muscle.stats.centroid[1]).toBeCloseTo(measure(muscle3).centroid[1] + 0.03, 2)
    expect(muscle.report.deepInside).toBe(0)
    const organ = cands.find((c) => c.part.id === 'FMA4')!
    expect(organ.report.decision).toBe('redundant')
    expect(organ.report.onSameSystem).toBeGreaterThan(0.7)
    // a veto wins over everything
    const vetoed = evaluateCandidates(r3, pairs, reg, field, () => 'muscular', (p) => (p.id === 'FMA3' ? 'because' : null), opts)
    expect(vetoed.find((c) => c.part.id === 'FMA3')!.report).toMatchObject({ decision: 'excluded', reason: 'because' })
  })
})

describe('collision checks', () => {
  const bone = existing('B', 'FMA1', 'Bone', box([0, 0, 0], [0.1, 0.02, 0.1], 10), 'bone', 'skeletal')
  const soft = existing('S', 'FMA2', 'Organ', box([0, 0.05, 0], [0.1, 0.09, 0.1], 10), 'organ', 'digestive')
  const field = new SurfaceField([bone, soft])

  it('measures what lies on, inside and deep inside existing solids', () => {
    // a plate straddling the top face of the bone: lower half inside
    const plate = box([0.02, 0.012, 0.02], [0.08, 0.028, 0.08], 8)
    const pts = thinPoints(surfacePoints(plate, 0.003), 0.002)
    const ov = overlapWith(pts, measure(plate).bbox, field, 0.002, 0.004, () => true)
    expect(ov.insideAny).toBeGreaterThan(0.3)
    expect(ov.insideAny).toBeLessThan(0.7)
    expect(ov.inside.get(0)!).toBeCloseTo(ov.insideAny, 6)
    expect(ov.inside.has(1)).toBe(false)
    expect(ov.deepAny).toBeGreaterThan(0.05)
    expect(ov.deepAny).toBeLessThan(ov.insideAny)
    expect(ov.onAny).toBeGreaterThan(0)
  })

  it('slides vertices out of hard tissue on the side they came from, and only out of hard tissue', () => {
    const plate = box([0.02, 0.017, 0.02], [0.08, 0.024, 0.08], 8) // sunk 3 mm into the bone's top
    const before = plate.positions
    const res = pushOutOfSolids(before, measure(plate).bbox, field, (i) => field.parts[i]!.tissue === 'bone')
    expect(res.inside).toBeGreaterThan(50)
    expect(res.moved).toBe(res.inside)
    const tester = field.tester(0)
    for (let i = 0; i < before.length; i += 3) {
      expect(tester.contains(res.positions[i]!, res.positions[i + 1]!, res.positions[i + 2]!)).toBe(false)
      // pushed up through the top face, not sideways or down
      expect(res.positions[i + 1]!).toBeGreaterThanOrEqual(before[i + 1]! - 1e-6)
      expect(Math.abs(res.positions[i]! - before[i]!)).toBeLessThan(0.0015)
    }
    expect(res.maxPush).toBeLessThan(0.0045)
    // a plate inside the soft organ is left alone
    const inOrgan = box([0.02, 0.06, 0.02], [0.08, 0.08, 0.08], 4)
    const untouched = pushOutOfSolids(inOrgan.positions, measure(inOrgan).bbox, field, (i) => field.parts[i]!.tissue === 'bone')
    expect(untouched.inside).toBe(0)
    expect(Array.from(untouched.positions)).toEqual(Array.from(inOrgan.positions))
  })

  it('leaves vertices that are too deep to rescue', () => {
    const deep = box([0.03, 0.008, 0.03], [0.07, 0.012, 0.07], 4) // 8–12 mm from every face but the bottom/top (10 mm)
    const res = pushOutOfSolids(deep.positions, measure(deep).bbox, field, () => true, { clearance: 0.0004, maxPush: 0.003, radius: 0.012, step: 0.0002 })
    expect(res.inside).toBe(deep.positions.length / 3)
    expect(res.moved).toBe(0)
  })

  it('measures how much of a content lies inside an organ surface', () => {
    const organ = box([0, 0, 0], [0.1, 0.1, 0.1], 4)
    const insideIt = existing('a', 'F', 'in', box([0.03, 0.03, 0.03], [0.06, 0.06, 0.06], 4), 'artery', 'cardiovascular')
    const half = existing('b', 'F', 'half', box([0.08, 0.03, 0.03], [0.12, 0.06, 0.06], 6), 'artery', 'cardiovascular')
    expect(contentsInside(organ, [insideIt]).fraction).toBe(1)
    const h = contentsInside(organ, [half]).fraction
    expect(h).toBeGreaterThan(0.35)
    expect(h).toBeLessThan(0.65)
    // a second mesh that covers the rest
    expect(contentsInside([organ, box([0.1, 0, 0], [0.2, 0.1, 0.1], 4)], [half]).fraction).toBeGreaterThan(0.9)
    const both = contentsInside(organ, [insideIt, half])
    expect(both.worst[0]![0]).toBe('half')
  })
})
