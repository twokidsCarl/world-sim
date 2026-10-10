import { describe, expect, it } from 'vitest'
import { computeAdjacency, PointBuffer, sampleSurface } from '../tools/pipeline/adjacency.ts'
import { classify, sideFromName, sideOf } from '../tools/pipeline/classify.ts'
import { computeExposure } from '../tools/pipeline/exposure.ts'
import { computeNormals, measure, simplifyMesh, sourceToRuntime, weld, type Mesh } from '../tools/pipeline/geometry.ts'
import { depthOf, LAYERS, SUPERFICIAL_EXPOSURE } from '../tools/pipeline/layers.ts'
import { parseObj, parseObjHeader } from '../tools/pipeline/obj.ts'
import { buildOntology, directParts, emitConcepts, parseTsv } from '../tools/pipeline/tables.ts'

const enc = (s: string) => new TextEncoder().encode(s)

/** Axis-aligned box with outward-facing triangles. */
function box(min: [number, number, number], max: [number, number, number]): Mesh {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1])
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7])
  return { positions, indices }
}

describe('parseTsv', () => {
  it('reads a header and rows, tolerating CRLF, BOM and blank lines', () => {
    const t = parseTsv('﻿a\tb\tc\r\n1\t2\t3\r\n\r\nx y\t\tz\n')
    expect(t.header).toEqual(['a', 'b', 'c'])
    expect(t.rows).toEqual([['1', '2', '3'], ['x y', '', 'z']])
  })
})

const RELATIONS = [
  'parent id\tparent name\tchild id\tchild name',
  'FMA1\tanatomical entity\tFMA2\tbone organ',
  'FMA1\tanatomical entity\tFMA3\tmuscle organ',
  'FMA2\tbone organ\tFMA4\tfemur',
  'FMA4\tfemur\tFMA5\tleft femur',
  'FMA4\tfemur\tFMA6\tright femur',
  'FMA3\tmuscle organ\tFMA7\tsartorius',
].join('\n')
const ELEMENTS = [
  'concept id\tname\telement file id',
  'FMA1\tanatomical entity\tFJ1', 'FMA1\tanatomical entity\tFJ2', 'FMA1\tanatomical entity\tFJ3', 'FMA1\tanatomical entity\tFJ9',
  'FMA2\tbone organ\tFJ1', 'FMA2\tbone organ\tFJ2', 'FMA2\tbone organ\tFJ3',
  'FMA4\tfemur\tFJ1', 'FMA4\tfemur\tFJ2', 'FMA4\tfemur\tFJ3',
  'FMA5\tleft femur\tFJ1',
  'FMA6\tright femur\tFJ2',
  'FMA3\tmuscle organ\tFJ9', 'FMA7\tsartorius\tFJ9',
].join('\n')

describe('ontology', () => {
  const onto = buildOntology(RELATIONS, ELEMENTS)
  it('finds the root, parents and children', () => {
    expect(onto.root).toBe('FMA1')
    expect(onto.parent.get('FMA5')).toBe('FMA4')
    expect(onto.parent.get('FMA1')).toBeNull()
    expect(onto.children.get('FMA4')).toEqual(['FMA5', 'FMA6'])
  })
  it('lists the concepts of an element most specific first', () => {
    expect(onto.conceptsOf.get('FJ1')).toEqual(['FMA5', 'FMA4', 'FMA2', 'FMA1'])
    expect(onto.conceptsOf.get('FJ3')).toEqual(['FMA4', 'FMA2', 'FMA1'])
  })
  it('derives direct parts by subtracting the children', () => {
    expect(directParts(onto, 'FMA4')).toEqual(['FJ3'])
    expect(directParts(onto, 'FMA5')).toEqual(['FJ1'])
    expect(directParts(onto, 'FMA1')).toEqual([])
  })
  it('emits parents before children and prunes concepts without kept parts', () => {
    const concepts = emitConcepts(onto, new Set(['FJ1', 'FJ3']))
    expect(concepts.map((c) => c.id)).toEqual(['FMA1', 'FMA2', 'FMA4', 'FMA5'])
    expect(concepts.find((c) => c.id === 'FMA4')).toEqual({ id: 'FMA4', name: 'femur', parent: 'FMA2', parts: ['FJ3'] })
    const seen = new Set<string>()
    for (const c of concepts) {
      if (c.parent) expect(seen.has(c.parent)).toBe(true)
      seen.add(c.id)
    }
  })
  it('rejects a concept with two parents', () => {
    expect(() => buildOntology(RELATIONS + '\nFMA3\tmuscle organ\tFMA5\tleft femur', ELEMENTS)).toThrow(/more than one parent/)
  })
})

const OBJ = `#
# The license ...
#
# File ID : FJ9999
# Representation ID : BP1
# Build-up logic : FMA 3.0 is_a
# Concept ID : FMA24475
# English name : Left femur
# Bounds(mm): (-1.500000,-2.000000,0.000000)-(1.000000,2.000000,3.250000)
# Volume(cm3): 12.500000
#
v 0 0 0
v 1.5 0 0
v 0 2 0
v 0 0 -3e0
vn 0 0 1
vn 0 0 1
vn 0 0 1
vn 1 0 0
g FJ9999
usemtl x
f 1//1 2//2 3//3
f 1//1 3//3 4//4
`

describe('parseObj', () => {
  it('reads the BodyParts3D header', () => {
    const h = parseObjHeader(OBJ)
    expect(h).toMatchObject({ fileId: 'FJ9999', representationId: 'BP1', conceptId: 'FMA24475', name: 'Left femur', volume: 12.5, buildUp: 'FMA 3.0 is_a' })
    expect(h.bounds).toEqual([-1.5, -2, 0, 1, 2, 3.25])
  })
  it('keeps blank header fields undefined-ish rather than inventing them', () => {
    const h = parseObjHeader('# File ID : FJ1\n# Concept ID : \n# English name : \n# Volume(cm3): 1.0\n')
    expect(h.fileId).toBe('FJ1')
    expect(h.name).toBe('')
    expect(h.conceptId).toBe('')
  })
  it('reads v, vn and v//vn faces', () => {
    const m = parseObj(enc(OBJ))
    expect(Array.from(m.positions)).toEqual([0, 0, 0, 1.5, 0, 0, 0, 2, 0, 0, 0, -3])
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 2, 3])
    expect(m.normals && Array.from(m.normals.slice(9, 12))).toEqual([1, 0, 0])
    expect(m.header.name).toBe('Left femur')
  })
  it('handles v, v/vt, v/vt/vn, negative indices, polygons and CRLF', () => {
    const m = parseObj(enc('v 0 0 0\r\nv 1 0 0\r\nv 1 1 0\r\nv 0 1 0\r\nvt 0 0\r\nf 1 2 3 4\r\nf -4/1 -3/1 -2/1\r\nf 1/1/1 2/1/1 4/1/1\r\n'))
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 2, 3, 0, 1, 2, 0, 1, 3])
    expect(m.positions.length).toBe(12)
  })
  it('parses signs, decimals and exponents', () => {
    const m = parseObj(enc('v -35.3372 +147.596 1.5e3\nv .5 -0.25 2E-2\nv 1 2 3\nf 1 2 3\n'))
    const p = Array.from(m.positions)
    expect(p[0]).toBeCloseTo(-35.3372, 4)
    expect(p[1]).toBeCloseTo(147.596, 3)
    expect(p[2]).toBeCloseTo(1500, 3)
    expect(p[3]).toBeCloseTo(0.5, 6)
    expect(p[4]).toBeCloseTo(-0.25, 6)
    expect(p[5]).toBeCloseTo(0.02, 6)
  })
  it('throws on a face that references a missing vertex', () => {
    expect(() => parseObj(enc('v 0 0 0\nf 1 2 3\n'))).toThrow()
  })
})

describe('geometry', () => {
  it('converts source mm (Z up, anterior −Y) to runtime m (Y up, anterior +Z)', () => {
    // a point 10 mm to the left, 20 mm anterior, 1500 mm up
    const out = sourceToRuntime(new Float32Array([10, -20, 1500]))
    expect(out[0]).toBeCloseTo(0.01)
    expect(out[1]).toBeCloseTo(1.5)
    expect(out[2]).toBeCloseTo(0.02)
  })
  it('measures a box: area, positive volume for outward winding, centroid, bbox', () => {
    const s = measure(box([1, 2, 3], [2, 4, 6]))
    expect(s.area).toBeCloseTo(2 * (1 * 2 + 2 * 3 + 1 * 3), 5)
    expect(s.signedVolume).toBeCloseTo(6, 5)
    expect(s.centroid.map((v) => +v.toFixed(4))).toEqual([1.5, 3, 4.5])
    expect(s.bbox).toEqual([1, 2, 3, 2, 4, 6])
  })
  it('welds duplicate vertices and drops degenerate and duplicate triangles', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, /* dup of 0 */ 0, 0, 0, 1, 1, 0, /* unused */ 9, 9, 9])
    const indices = new Uint32Array([0, 1, 2, /* same tri via dup */ 3, 1, 2, /* degenerate */ 0, 3, 1, 1, 4, 2])
    const w = weld(positions, indices)
    expect(w.positions.length / 3).toBe(4)
    expect(w.indices.length / 3).toBe(2)
    expect(w.removedTriangles).toBe(2)
    expect(w.remap[3]).toBe(w.remap[0])
  })
  it('computes unit normals pointing out of a box', () => {
    const b = box([0, 0, 0], [1, 1, 1])
    const n = computeNormals(b)
    for (let v = 0; v < 8; v++) {
      const d = [0, 1, 2].map((k) => n[3 * v + k]! * (b.positions[3 * v + k]! - 0.5))
      expect(d[0]! + d[1]! + d[2]!).toBeGreaterThan(0)
      expect(Math.hypot(n[3 * v]!, n[3 * v + 1]!, n[3 * v + 2]!)).toBeCloseTo(1, 5)
    }
  })
  it('simplifies a densely tessellated plane within the error bound and leaves small meshes alone', async () => {
    const n = 20
    const positions = new Float32Array((n + 1) * (n + 1) * 3)
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.set([i / n, j / n, 0], 3 * (j * (n + 1) + i))
    const idx: number[] = []
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i
      idx.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1)
    }
    const mesh = { positions, indices: new Uint32Array(idx) }
    const out = await simplifyMesh(mesh, 0.001, 8)
    expect(out.indices.length / 3).toBeLessThan(200)
    expect(measure(out).area).toBeCloseTo(1, 3)
    const same = await simplifyMesh(mesh, 0.001, 800)
    expect(same.indices.length).toBe(mesh.indices.length)
  })
})

describe('classify', () => {
  const c = (name: string, isa: string[], partOf: string[] = []) => {
    const r = classify({ name, isa, partOf })
    return `${r.system}/${r.tissue}/${r.signal}`
  }
  it('uses the IS-A chain first', () => {
    expect(c('Left femur', ['left femur', 'femur', 'long bone', 'bone organ', 'organ'])).toBe('skeletal/bone/isa')
    expect(c('Right sartorius', ['right sartorius', 'sartorius', 'muscle of thigh', 'muscle organ'])).toBe('muscular/muscle/isa')
    expect(c('Left radial artery', ['left radial artery', 'artery', 'segment of arterial tree organ'])).toBe('cardiovascular/artery/isa')
    expect(c('Set of perforating veins', ['set of perforating veins', 'set of veins', 'anatomical set'])).toBe('cardiovascular/vein/isa')
    expect(c('Left frontal nerve', ['left frontal nerve', 'nerve', 'segment of neural tree organ'])).toBe('nervous/nerve/isa')
    expect(c('Pons', ['pons', 'segment of brain', 'segment of neuraxis'])).toBe('nervous/brain/isa')
  })
  it('follows anatomical convention for teeth, joints, larynx and the heart', () => {
    expect(c('Left upper canine tooth', ['canine tooth', 'tooth', 'organ with organ cavity'])).toBe('digestive/tooth/isa')
    expect(c('Intervertebral disk of axis', ['intervertebral disk', 'cartilage organ'])).toBe('skeletal/cartilage/isa')
    expect(c('Right long plantar ligament', ['long plantar ligament', 'skeletal ligament', 'ligament organ'])).toBe('skeletal/ligament/isa')
    expect(c('Thyroid cartilage', ['thyroid cartilage', 'laryngeal cartilage', 'cartilage organ'])).toBe('respiratory/cartilage/isa')
    expect(c('Anterior leaflet of mitral valve', ['anterior leaflet of mitral valve', 'leaf of cardiac valve', 'organ component'], ['heart'])).toBe('cardiovascular/heart/isa')
    expect(c('Cavity of left ventricle', ['cavity of left ventricle', 'cavity of cardiac chamber', 'anatomical space'], ['heart'])).toBe('cardiovascular/space/isa')
  })
  it('keeps coronary vessels as vessels although they are part of the heart', () => {
    expect(c('Right conus artery', ['right conus artery', 'coronary artery', 'artery', 'segment of arterial tree organ'], ['right coronary artery', 'heart'])).toBe('cardiovascular/artery/isa')
  })
  it('puts exceptions above the broad rule they carve out of', () => {
    // FMA files the Achilles tendon under skeletal ligament
    expect(c('Right calcaneal tendon', ['right calcaneal tendon', 'calcaneal tendon', 'skeletal ligament', 'ligament organ'])).toBe('muscular/tendon/isa')
    // extra-ocular muscles are muscles, not "eye"
    expect(c('Left medial rectus', ['left medial rectus', 'extra-ocular muscle', 'muscle organ'], ['left eye'])).toBe('muscular/muscle/isa')
    expect(c('Optic chiasm', ['optic chiasm', 'nerve trunk', 'segment of neural tree organ'])).toBe('nervous/brain/isa')
  })
  it('falls back to the PART-OF system, then to the name, then to other', () => {
    expect(c('Stomach', ['stomach', 'organ with organ cavity', 'organ'], ['stomach', 'gastrointestinal tract', 'alimentary system'])).toBe('digestive/organ/partOf')
    expect(c('Left kidney', ['left kidney', 'kidney', 'organ'], ['left kidney', 'urinary system'])).toBe('urinary/organ/partOf')
    expect(c('Some unnamed artery', ['mystery'])).toBe('cardiovascular/artery/name')
    expect(c('Thing', ['mystery'])).toBe('other/other/none')
  })
})

describe('side', () => {
  it('reads the side from the name', () => {
    expect(sideFromName('Left femur')).toBe('L')
    expect(sideFromName('Spinal part of right deltoid')).toBe('R')
    expect(sideFromName('Cleft palate')).toBeNull()
    expect(sideFromName('Right anterior branch of left coronary artery')).toBeNull()
  })
  it('falls back to geometry with a midline tolerance; left is +X', () => {
    expect(sideOf('Stomach', [0.04, 1, 0], [0.01, 0, 0, 0.09, 1, 1])).toBe('L')
    expect(sideOf('Gallbladder', [-0.05, 1, 0], [-0.07, 0, 0, -0.02, 1, 1])).toBe('R')
    expect(sideOf('Sternum', [0.001, 1, 0], [-0.03, 0, 0, 0.03, 1, 1])).toBe('M')
    // off-centre centroid but the part spans the midline
    expect(sideOf('Liver', [-0.05, 1, 0], [-0.12, 0, 0, 0.06, 1, 1])).toBe('M')
    expect(sideOf('Left femur', [-0.2, 1, 0], [-0.3, 0, 0, -0.1, 1, 1])).toBe('L')
  })
})

describe('layers', () => {
  const name = (d: number) => LAYERS[d]!.key
  it('orders layers superficial to deep', () => {
    expect(name(depthOf('integumentary', 'skin'))).toBe('skin')
    expect(name(depthOf('muscular', 'muscle', SUPERFICIAL_EXPOSURE + 0.01))).toBe('muscle-superficial')
    expect(name(depthOf('muscular', 'muscle', 0))).toBe('muscle-deep')
    expect(name(depthOf('cardiovascular', 'artery'))).toBe('neurovascular')
    expect(name(depthOf('cardiovascular', 'heart'))).toBe('viscera')
    expect(name(depthOf('skeletal', 'cartilage'))).toBe('joints')
    expect(name(depthOf('skeletal', 'bone'))).toBe('skeleton')
    expect(name(depthOf('digestive', 'tooth'))).toBe('skeleton')
    expect(depthOf('integumentary', 'skin')).toBeLessThan(depthOf('muscular', 'muscle', 1))
    expect(depthOf('muscular', 'muscle', 0)).toBeLessThan(depthOf('skeletal', 'bone'))
  })
})

describe('adjacency', () => {
  it('samples a surface no coarser than the spacing', () => {
    const buf = new PointBuffer(4)
    const n = sampleSurface(box([0, 0, 0], [1, 1, 1]), 0.25, buf)
    expect(n).toBe(buf.length)
    expect(n).toBeGreaterThanOrEqual(6 * 16)
    for (let i = 0; i < n * 3; i++) {
      expect(buf.data[i]!).toBeGreaterThanOrEqual(0)
      expect(buf.data[i]!).toBeLessThanOrEqual(1)
    }
  })
  it('links parts within the threshold, symmetrically, and nothing else', () => {
    const meshes = [
      box([0, 0, 0], [10, 10, 10]),
      box([11, 0, 0], [21, 10, 10]), // 1 away from #0
      box([26, 0, 0], [36, 10, 10]), // 5 away from #1
      box([0, 11.5, 0], [10, 20, 10]), // 1.5 away from #0
    ]
    const r = computeAdjacency(meshes, { threshold: 2, spacing: 1 })
    expect(r.neighbours).toEqual([[1, 3], [0], [], [0]])
    expect(r.samples).toBeGreaterThan(0)
  })
})

describe('exposure', () => {
  it('scores an uncovered slab about one half and a covered one zero', () => {
    const skin = box([-50, 30, -50], [50, 31, 50])
    const top = box([-20, 10, -20], [20, 14, 20]) // directly under the skin
    const under = box([-20, 0, -20], [20, 4, 20]) // hidden beneath `top`
    const e = computeExposure([skin, top, under], ['skin', 'occluder', 'occluder'], [1, 2], { cell: 2, spacing: 1.5, maxDistance: 40 })
    expect(e[0]!).toBeGreaterThan(0.35)
    expect(e[0]!).toBeLessThan(0.6)
    expect(e[1]!).toBeLessThan(0.05)
  })
})
