import { describe, expect, it } from 'vitest'
import { measure, type Mesh } from '../tools/pipeline/geometry.ts'
import { SurfaceField, type ExistingPart } from '../tools/pipeline/import3.ts'
import { canalFor, densify, isaPathFromFma, MIN_NERVE_RADIUS, NERVE_BUILD_DEFAULTS, pathStats, registerZa, syntheticConceptId, toPolyline, warpNerve, ZA_REGISTER_DEFAULTS } from '../tools/pipeline/importZa.ts'
import { nerveAgreement, slabCentroid } from '../tools/pipeline/landmarks.ts'
import { buildDeformation } from '../tools/pipeline/register.ts'
import { buildTube, dedupePolyline, mergeMeshes, polylineLength, simplifyPolyline, type Polyline } from '../tools/pipeline/tube.ts'
import { displayName, type ZaAnchor, type ZaPackage } from '../tools/pipeline/zanatomy.ts'

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
  face([x0, y0, z0], [d[0]!, 0, 0], [0, d[1]!, 0], true)
  face([x0, y0, max[2]], [d[0]!, 0, 0], [0, d[1]!, 0], false)
  face([x0, y0, z0], [d[0]!, 0, 0], [0, 0, d[2]!], false)
  face([x0, max[1], z0], [d[0]!, 0, 0], [0, 0, d[2]!], true)
  face([x0, y0, z0], [0, d[1]!, 0], [0, 0, d[2]!], true)
  face([max[0], y0, z0], [0, d[1]!, 0], [0, 0, d[2]!], false)
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}
const part = (id: string, name: string, mesh: Mesh, tissue: ExistingPart['tissue']): ExistingPart => ({ id, fma: 'FMA' + id, name, mesh, stats: measure(mesh), tissue, system: tissue === 'muscle' ? 'muscular' : 'skeletal' })
const line = (pts: number[][], r = 0.001): Polyline => ({ points: Float32Array.from(pts.flat()), radius: Float32Array.from(pts.map(() => r)) })

describe('tube', () => {
  it('measures and simplifies polylines', () => {
    const l = line([[0, 0, 0], [0.01, 0, 0], [0.02, 0.00001, 0], [0.03, 0, 0], [0.03, 0.02, 0]])
    expect(polylineLength(l.points)).toBeCloseTo(0.05, 4)
    const s = simplifyPolyline(l, 0.0001)
    expect(Array.from(s.points).map((v) => +v.toFixed(3))).toEqual([0, 0, 0, 0.03, 0, 0, 0.03, 0.02, 0])
    // a radius change keeps its point; maxSegment keeps long straight runs sampled
    const taper: Polyline = { points: l.points, radius: Float32Array.from([0.001, 0.001, 0.003, 0.001, 0.001]) }
    expect(simplifyPolyline(taper, 0.0001).points.length / 3).toBeGreaterThan(3)
    expect(simplifyPolyline(l, 0.0001, 0.15, 0.011).points.length / 3).toBeGreaterThanOrEqual(5)
    expect(dedupePolyline(line([[0, 0, 0], [0, 0, 0], [1, 0, 0]])).points.length).toBe(6)
  })
  it('builds a closed, outward-facing tube of the right size', () => {
    const pts: number[][] = []
    for (let i = 0; i <= 100; i++) pts.push([Math.cos((i / 100) * Math.PI) * 0.1, Math.sin((i / 100) * Math.PI) * 0.1, i * 0.0005])
    const l = line(pts, 0.002)
    const tube = buildTube(l, 8)!
    expect(tube.positions.length / 3).toBe(101 * 8 + 2)
    expect(tube.indices.length / 3).toBe(100 * 16 + 16)
    const s = measure(tube)
    const len = polylineLength(l.points)
    // an octagonal prism: area = 8·2r·sin(π/8)·L, volume = 2√2·r²·L
    expect(s.signedVolume).toBeCloseTo(2 * Math.SQRT2 * 0.002 ** 2 * len, 7)
    expect(s.area / (8 * 2 * 0.002 * Math.sin(Math.PI / 8) * len)).toBeGreaterThan(0.99)
    expect(s.area / (8 * 2 * 0.002 * Math.sin(Math.PI / 8) * len)).toBeLessThan(1.02)
    // watertight: every edge is shared by exactly two triangles
    const edges = new Map<string, number>()
    for (let t = 0; t < tube.indices.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = tube.indices[t + k]!
      const b = tube.indices[t + ((k + 1) % 3)]!
      const key = a < b ? `${a},${b}` : `${b},${a}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
    expect([...edges.values()].every((c) => c === 2)).toBe(true)
    expect(buildTube(line([[0, 0, 0]]), 8)).toBeNull()
    expect(mergeMeshes([tube, tube]).indices.length).toBe(2 * tube.indices.length)
  })
})

describe('nerve paths', () => {
  const bone = part('B', 'Left femur', box([0, 0, 0], [0.03, 0.2, 0.03], 12), 'bone')
  const muscle = part('M', 'Left vastus', box([0.05, 0, 0], [0.11, 0.2, 0.06], 12), 'muscle')
  const field = new SurfaceField([bone, muscle])
  const identity = buildDeformation(new Float32Array([0, 0, 0, 1, 1, 1]), new Float32Array([0, 0, 0, 1, 1, 1]))

  it('densifies and clamps radii', () => {
    const d = densify(line([[0, 0, 0], [0.01, 0, 0]]), 0.003)
    expect(d.points.length / 3).toBe(5)
    expect(d.radius.length).toBe(5)
    expect(toPolyline({ points: [[0, 0, 0], [1, 0, 0]], radius: [0, 0.001] }).radius[0]).toBeCloseTo(MIN_NERVE_RADIUS, 9)
  })
  it('measures how much of a path lies in bone, in a canal, and deep in muscle', () => {
    // 10 cm outside everything, 10 cm along the middle of the bone, 10 cm through the middle of the muscle
    const path = [line([[-0.02, 0.05, 0.015], [-0.02, 0.15, 0.015]]), line([[0.015, 0.05, 0.015], [0.015, 0.15, 0.015]]), line([[0.08, 0.05, 0.03], [0.08, 0.15, 0.03]])]
    const s = pathStats(path, field)
    expect(s.length).toBeCloseTo(0.3, 3)
    expect(s.inBone).toBeCloseTo(1 / 3, 2)
    expect(s.deepInMuscle).toBeCloseTo(1 / 3, 2)
    expect(s.inCanal).toBe(0)
    expect(s.bones[0]![0]).toBe('Left femur')
    const canal = pathStats(path, field, (b) => /femur/.test(b))
    expect(canal.inBone).toBe(0)
    expect(canal.inCanal).toBeCloseTo(1 / 3, 2)
    // just under the muscle's surface does not count as deep
    expect(pathStats([line([[0.08, 0.05, 0.001], [0.08, 0.15, 0.001]])], field).deepInMuscle).toBe(0)
  })
  it('slides a nerve out of bone and out of a muscle belly, but not out of its canal', () => {
    const grazing = { points: [[0.002, 0.05, 0.015], [0.002, 0.15, 0.015]], radius: [0.0005, 0.0005] } // 2 mm under the bone surface
    const w = warpNerve([grazing], identity, field)
    expect(w.before.inBone).toBeGreaterThan(0.95)
    expect(w.after.inBone).toBe(0)
    expect(w.pushedOutOfBone).toBeGreaterThan(0)
    expect(w.mesh!.indices.length).toBeGreaterThan(0)
    for (let i = 0; i < w.branches[0]!.points.length; i += 3) expect(w.branches[0]!.points[i]!).toBeLessThan(0)
    const kept = warpNerve([grazing], identity, field, { ...warpNerveDefaults(), canal: () => true })
    expect(kept.pushed).toBe(0)
    expect(kept.after.inCanal).toBeGreaterThan(0.95)
    // 8 mm inside the muscle, far from the bone: moved to the muscle's surface
    const inMuscle = { points: [[0.08, 0.05, 0.008], [0.08, 0.15, 0.008]], radius: [0.0005, 0.0005] }
    const m = warpNerve([inMuscle], identity, field)
    expect(m.before.deepInMuscle).toBeGreaterThan(0.95)
    expect(m.after.deepInMuscle).toBe(0)
    // next to the bone the muscle clean-up is switched off (a nerve lying on bone under a muscle stays)
    const hugging = { points: [[0.055, 0.05, 0.015], [0.055, 0.15, 0.015]], radius: [0.0005, 0.0005] }
    const tight = new SurfaceField([part('B', 'Left femur', box([0, 0, 0], [0.05, 0.2, 0.03], 12), 'bone'), muscle])
    const h = warpNerve([hugging], identity, tight)
    expect(h.pushed).toBe(0)
  })
  it('scores agreement between an existing nerve mesh and an imported centreline', () => {
    const existing = buildTube(line([[0, 0, 0], [0.05, 0, 0]], 0.001), 8)!
    const a = nerveAgreement(existing, [line([[0, 0.003, 0], [0.05, 0.003, 0]])])
    expect(a.median).toBeGreaterThan(0.002)
    expect(a.median).toBeLessThan(0.0045)
    expect(a.overlap).toBe(1)
  })
})

const warpNerveDefaults = () => NERVE_BUILD_DEFAULTS

describe('registerZa', () => {
  // atlas frame: a left and a right bone; in our body the left one sits 2 cm higher, the right one 1 cm lower
  const leftAtlas = box([0.1, 0, 0], [0.13, 0.2, 0.03], 10)
  const rightAtlas = box([-0.13, 0, 0], [-0.1, 0.2, 0.03], 10)
  const shift = (m: Mesh, dy: number): Mesh => ({ positions: Float32Array.from(m.positions, (v, i) => (i % 3 === 1 ? v + dy : v)), indices: m.indices })
  const field = new SurfaceField([part('FJ1', 'Left bone', shift(leftAtlas, 0.02), 'bone'), part('FJ2', 'Right bone', shift(rightAtlas, -0.01), 'bone')])
  const anchor = (id: string, side: 'L' | 'R', bp: string, dy: number, frame: 'za' | 'o3d', name: string): ZaAnchor => ({
    id, source: frame === 'za' ? 'z-anatomy' : 'open3dmodel', frame, name, side, bp3dIds: [bp], fma: null, anchorClass: 'bone', tissue: 'bone',
    icp: { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, dy, 0] }, residualMeanMm: 0.2, residualP95Mm: 0.5, resculpted: false, quality: 'good', files: { mesh: { file: id, vOffset: 0, vCount: 0, iOffset: 0, iCount: 0 } },
  })
  const meshes: Record<string, Mesh> = { a: leftAtlas, b: rightAtlas, c: leftAtlas, missing: leftAtlas }
  const pkg: ZaPackage = {
    items: [], sources: [],
    anchors: [anchor('a', 'L', 'FJ1', 0.02, 'za', 'Bone'), anchor('b', 'R', 'FJ2', -0.01, 'za', 'Bone'), anchor('c', 'L', 'FJ1', 0.02, 'o3d', 'Other bone'), anchor('missing', 'L', 'FJ404', 0, 'za', 'Gone')],
    mesh: (ref) => meshes[ref.file]!,
    centreline: () => null,
  }
  const reg = registerZa(pkg, field, { ...ZA_REGISTER_DEFAULTS, anchorSpacing: 0.01 })

  it('skips anchors whose part is unknown and builds one deformation per frame and side', () => {
    expect(reg.anchorsUsed).toBe(3)
    expect(reg.anchorsSkipped.map((a) => a.name)).toEqual(['Gone'])
    // a left item only feels the left anchor, wherever it is
    expect(reg.deformation('za', 'L').displacementAt(-0.11, 0.1, 0.01)[1]).toBeCloseTo(0.02, 3)
    expect(reg.deformation('za', 'R').displacementAt(0.11, 0.1, 0.01)[1]).toBeCloseTo(-0.01, 3)
    // a midline item feels both
    const mid = reg.deformation('za', 'M').displacementAt(0, 0.1, 0.01)[1]
    expect(mid).toBeGreaterThan(-0.01)
    expect(mid).toBeLessThan(0.02)
    expect(() => reg.deformation('o3d', 'R')).not.toThrow() // borrows the Z-Anatomy right anchor
    const st = reg.stats()
    expect(st['za:L']).toMatchObject({ structures: 1, bone: 1, soft: 0, crossFrame: 0 })
    // the Open3DModel frame adds Z-Anatomy anchors for structures it does not have itself ("Bone")
    expect(st['o3d:L']).toMatchObject({ structures: 2, bone: 1, crossFrame: 1 })
    expect(st['za:L']!.residualMax).toBeLessThan(0.001)
  })
})

describe('tree placement and names', () => {
  it('walks the FMA is-a chain to the first concept the tree has', () => {
    const parents: Record<string, string[]> = { FMA3: ['FMA2'], FMA2: ['FMA1'], FMA1: ['FMA0'], FMA9: ['FMA8'], FMA8: [] }
    const labels: Record<string, string> = { FMA3: 'Left median nerve', FMA2: 'Median nerve', FMA1: 'Nerve', FMA8: 'Odd thing' }
    const inTree = (id: string) => id === 'FMA1'
    expect(isaPathFromFma('FMA1', 'Nerve', (i) => parents[i], (i) => labels[i], inTree, 'FB')).toEqual({ path: [], anchor: 'FMA1', how: 'own concept' })
    expect(isaPathFromFma('FMA3', 'Left median nerve', (i) => parents[i], (i) => labels[i], inTree, 'FB')).toEqual({ path: [['FMA3', 'left median nerve'], ['FMA2', 'median nerve']], anchor: 'FMA1', how: 'FMA is-a chain' })
    // chain that never meets the tree: only the concept itself, under the fallback
    expect(isaPathFromFma('FMA9', 'C5 root', (i) => parents[i], (i) => labels[i], inTree, 'FB')).toEqual({ path: [['FMA9', 'C5 root']], anchor: 'FB', how: 'by hand' })
    expect(isaPathFromFma('FMA9', 'x', () => undefined, () => undefined, inTree, null).how).toBe('none')
  })
  it('makes stable non-FMA concept ids', () => {
    expect(syntheticConceptId('Recurrent (thenar) branch of median nerve', 'L')).toBe('ZAC_recurrent_thenar_branch_of_median_nerve_L')
    expect(syntheticConceptId('Sympathetic nerves', 'M')).toBe('ZAC_sympathetic_nerves')
    expect(syntheticConceptId('Sympathetic nerves', 'R')).not.toMatch(/^FMA/)
  })
  it('names parts in the BodyParts3D style', () => {
    expect(displayName('Median nerve', 'L')).toBe('Left median nerve')
    expect(displayName('C5 root of brachial plexus', 'R')).toBe('Right C5 root of brachial plexus')
    expect(displayName('(Anterior tibial node)', 'L')).toBe('Left anterior tibial node')
    expect(displayName('Vagus nerve (X)', 'R')).toBe('Right vagus nerve (X)')
    expect(displayName('Thyroid gland', 'M')).toBe('Thyroid gland')
  })
  it('knows which bones a nerve may run through', () => {
    expect(canalFor('Inferior alveolar nerve')('Mandible')).toBe(true)
    expect(canalFor('Inferior alveolar nerve')('Left femur')).toBe(false)
    expect(canalFor('Facial nerve (VII)')('Left temporal bone')).toBe(true)
    expect(canalFor('S2 root in cauda equina')('Sacrum')).toBe(true)
    expect(canalFor('Sciatic nerve')('Sacrum')).toBe(false)
    expect(canalFor('Median nerve')('Left radius')).toBe(false)
  })
  it('finds slab centroids', () => {
    const c = slabCentroid(box([0, 0, 0], [2, 10, 4], 4), 4, 6)!
    expect(c.map((v) => +v.toFixed(3))).toEqual([1, 5, 2])
    expect(slabCentroid(box([0, 0, 0], [1, 1, 1], 2), 5, 6)).toBeNull()
  })
})
