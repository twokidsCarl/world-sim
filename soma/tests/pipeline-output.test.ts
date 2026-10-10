// Validates the generated runtime data. Skipped when the pipeline has not been run
// (public/anatomy is gitignored): `bun run pipeline` first.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData, Concept, Part } from '../src/anatomy/types.ts'
import { readGlb } from '../tools/pipeline/glb.ts'
import { LAYERS } from '../tools/pipeline/layers.ts'

const DIR = join(import.meta.dirname, '../public/anatomy/male')
const FILE = join(DIR, 'anatomy.json')
const present = existsSync(FILE)

const SYSTEMS = ['integumentary', 'muscular', 'skeletal', 'cardiovascular', 'nervous', 'respiratory', 'digestive', 'urinary', 'reproductive', 'endocrine', 'lymphatic', 'other']
const TISSUES = ['skin', 'fat', 'fascia', 'muscle', 'tendon', 'ligament', 'cartilage', 'bone', 'tooth', 'artery', 'vein', 'heart', 'nerve', 'brain', 'organ', 'gland', 'space', 'other']

describe.skipIf(!present)('pipeline output (public/anatomy/male)', () => {
  const data = (present ? JSON.parse(readFileSync(FILE, 'utf8')) : null) as AnatomyData
  const byId = new Map<string, Part>(present ? data.parts.map((p) => [p.id, p]) : [])
  const byName = (name: string): Part => {
    const hits = data.parts.filter((p) => p.name === name)
    expect(hits.length, `parts named "${name}"`).toBe(1)
    return hits[0]!
  }
  const layerOf = (p: Part) => LAYERS[p.depth]!.key

  it('has the contract header', () => {
    expect(data.schema).toBe(1)
    expect(data.body).toBe('male')
    expect(data.sources.length).toBeGreaterThan(0)
    expect(data.sources[0]!.license).toBe('CC BY 4.0')
    expect(data.sources[0]!.attribution).toContain('BodyParts3D')
    expect(data.layers.length).toBe(LAYERS.length)
    expect(data.parts.length).toBeGreaterThan(1000)
  })

  it('has unique part ids and well-formed parts', () => {
    expect(byId.size).toBe(data.parts.length)
    for (const p of data.parts) {
      expect(p.id).toMatch(/^(FJ\d+M?|R3_FMA\d+)$/)
      expect(p.fma, p.id).toMatch(/^FMA\d+$/)
      expect(p.name.trim().length, p.id).toBeGreaterThan(0)
      expect(SYSTEMS, p.id).toContain(p.system)
      expect(TISSUES, p.id).toContain(p.tissue)
      expect(['L', 'R', 'M'], p.id).toContain(p.side)
      expect(p.provenance, p.id).toBe(p.id.startsWith('R3_') ? 'warped' : 'scanned')
      expect(Number.isInteger(p.depth) && p.depth >= 0 && p.depth < data.layers.length, p.id).toBe(true)
      expect(p.triangles, p.id).toBeGreaterThan(3)
      if (p.volume !== undefined) expect(p.volume, p.id).toBeGreaterThan(0)
    }
  })

  it('leaves nothing unclassified', () => {
    expect(data.parts.filter((p) => p.system === 'other' || p.tissue === 'other').map((p) => `${p.id} ${p.name}`)).toEqual([])
  })

  it('describes systems consistently with the parts', () => {
    expect(data.systems.map((s) => s.id)).toEqual(SYSTEMS)
    expect(new Set(data.systems.map((s) => s.color.toLowerCase())).size).toBe(data.systems.length)
    for (const s of data.systems) {
      const n = data.parts.filter((p) => p.system === s.id).length
      expect(s.partCount, s.id).toBe(n)
      expect(s.glb, s.id).toBe(n > 0 ? `${s.id}.glb` : null)
      expect(s.color).toMatch(/^#[0-9a-f]{6}$/i)
      expect(s.name.en.length && s.name.zh.length).toBeGreaterThan(0)
      if (s.glb) expect(existsSync(join(DIR, s.glb)), s.glb).toBe(true)
    }
  })

  it('puts every part in exactly one GLB, as a named node of its system, matching the JSON', async () => {
    const seen = new Map<string, string>()
    for (const s of data.systems) {
      if (!s.glb) continue
      const doc = await readGlb(join(DIR, s.glb))
      const used = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName)
      expect(used, s.glb).toContain('EXT_meshopt_compression')
      expect(used, s.glb).toContain('KHR_mesh_quantization')
      const nodes = doc.getRoot().listNodes()
      expect(nodes.length, s.glb).toBe(s.partCount)
      for (const node of nodes) {
        const id = node.getName()
        expect(seen.has(id), `${id} appears twice`).toBe(false)
        seen.set(id, s.id)
        const part = byId.get(id)
        expect(part, `${id} in ${s.glb} is not a part`).toBeDefined()
        expect(part!.system, id).toBe(s.id)
        const mesh = node.getMesh()!
        expect(mesh.getName()).toBe(id)
        const prims = mesh.listPrimitives()
        expect(prims.length, id).toBe(1)
        const prim = prims[0]!
        expect(prim.getIndices()!.getCount() / 3, `${id} triangles`).toBe(part!.triangles)
        const pos = prim.getAttribute('POSITION')!
        const nrm = prim.getAttribute('NORMAL')!
        expect(nrm, `${id} normals`).toBeTruthy()
        expect(nrm.getCount()).toBe(pos.getCount())
        // world-space bounds (node transform undoes the quantisation) must match the JSON bbox
        const m = node.getWorldMatrix()
        expect([m[1], m[2], m[4], m[6], m[8], m[9]].every((v) => v === 0), `${id} has a rotation`).toBe(true)
        const lo = pos.getMinNormalized([0, 0, 0])
        const hi = pos.getMaxNormalized([0, 0, 0])
        for (let k = 0; k < 3; k++) {
          const scale = m[5 * k]!
          const a = lo[k]! * scale + m[12 + k]!
          const b = hi[k]! * scale + m[12 + k]!
          expect(Math.abs(Math.min(a, b) - part!.bbox[k]!), `${id} bbox min ${k}`).toBeLessThan(2e-4)
          expect(Math.abs(Math.max(a, b) - part!.bbox[k + 3]!), `${id} bbox max ${k}`).toBeLessThan(2e-4)
        }
      }
    }
    expect(seen.size).toBe(data.parts.length)
  }, 120_000)

  const checkTree = (tree: Concept[]) => {
    const ids = new Set<string>()
    const children = new Map<string, number>()
    for (const c of tree) {
      expect(ids.has(c.id), `concept ${c.id} twice`).toBe(false)
      if (c.parent !== null) {
        expect(ids.has(c.parent), `${c.id}: parent ${c.parent} must come first`).toBe(true)
        children.set(c.parent, (children.get(c.parent) ?? 0) + 1)
      }
      ids.add(c.id)
      for (const p of c.parts) expect(byId.has(p), `${c.id} references unknown part ${p}`).toBe(true)
    }
    // pruned: every leaf concept carries parts
    for (const c of tree) if (!children.has(c.id)) expect(c.parts.length, `leaf ${c.id} ${c.name}`).toBeGreaterThan(0)
    return new Set(tree.flatMap((c) => c.parts))
  }

  it('reaches every part from the single-rooted isa tree', () => {
    const { isa } = data.trees
    expect(isa.filter((c) => c.parent === null).length).toBe(1)
    const reached = checkTree(isa)
    expect(data.parts.filter((p) => !reached.has(p.id)).map((p) => p.id)).toEqual([])
    // direct parts are attached to one concept only
    expect(isa.reduce((n, c) => n + c.parts.length, 0)).toBe(reached.size)
  })

  it('has a well-formed (partial) partOf tree', () => {
    const reached = checkTree(data.trees.partOf)
    expect(reached.size).toBeGreaterThan(1000)
    expect(reached.size).toBeLessThanOrEqual(data.parts.length)
  })

  it('has symmetric adjacency over existing ids', () => {
    let pairs = 0
    for (const p of data.parts) {
      expect(new Set(p.adjacent).size, `${p.id} duplicate neighbours`).toBe(p.adjacent.length)
      for (const q of p.adjacent) {
        expect(q, p.id).not.toBe(p.id)
        const other = byId.get(q)
        expect(other, `${p.id} -> ${q}`).toBeDefined()
        expect(other!.adjacent.includes(p.id), `${q} should list ${p.id}`).toBe(true)
        pairs++
      }
    }
    expect(pairs / 2).toBeGreaterThan(5000)
    const max = Math.max(...data.parts.map((p) => p.adjacent.length))
    expect(max).toBeLessThanOrEqual(200)
    // the skin is an envelope: excluded in both directions
    const skin = byName('Skin')
    expect(skin.adjacent).toEqual([])
  })

  it('has finite bounds inside a plausible human envelope', () => {
    let minY = Infinity
    let maxY = -Infinity
    let minX = Infinity
    let maxX = -Infinity
    for (const p of data.parts) {
      expect(p.bbox.every(Number.isFinite) && p.centroid.every(Number.isFinite), p.id).toBe(true)
      for (let k = 0; k < 3; k++) {
        expect(p.bbox[k]!, p.id).toBeLessThanOrEqual(p.bbox[k + 3]!)
        expect(p.centroid[k]!, p.id).toBeGreaterThanOrEqual(p.bbox[k]! - 1e-4)
        expect(p.centroid[k]!, p.id).toBeLessThanOrEqual(p.bbox[k + 3]! + 1e-4)
      }
      minY = Math.min(minY, p.bbox[1])
      maxY = Math.max(maxY, p.bbox[4])
      minX = Math.min(minX, p.bbox[0])
      maxX = Math.max(maxX, p.bbox[3])
      // metres, not millimetres
      expect(Math.abs(p.bbox[0]), p.id).toBeLessThan(0.6)
      expect(Math.abs(p.bbox[3]), p.id).toBeLessThan(0.6)
      expect(p.bbox[2], p.id).toBeGreaterThan(-0.4)
      expect(p.bbox[5], p.id).toBeLessThan(0.4)
    }
    const height = maxY - minY
    expect(height).toBeGreaterThan(1.6)
    expect(height).toBeLessThan(1.9)
    // feet near y = 0 (the source origin is a little above the toe tips of the plantar-flexed feet)
    expect(minY).toBeGreaterThan(-0.15)
    expect(minY).toBeLessThan(0.05)
    // roughly symmetric about x = 0
    expect(Math.abs(minX + maxX)).toBeLessThan(0.02)
  })

  it('stays within the triangle budget', () => {
    const total = data.parts.reduce((s, p) => s + p.triangles, 0)
    expect(total).toBeGreaterThan(800_000)
    expect(total).toBeLessThan(1_900_000)
  })

  it('gets the left femur right', () => {
    const femur = byName('Left femur')
    expect(femur).toMatchObject({ side: 'L', system: 'skeletal', tissue: 'bone', fma: 'FMA24475' })
    expect(femur.centroid[0]).toBeGreaterThan(0.03)
    expect(layerOf(femur)).toBe('skeleton')
    const right = byName('Right femur')
    expect(right.side).toBe('R')
    expect(right.centroid[0]).toBeLessThan(-0.03)
    // mirror-image twins sit at the same height
    expect(Math.abs(right.centroid[1] - femur.centroid[1])).toBeLessThan(0.01)
    // a femur is 40–50 cm long and runs along Y
    const len = femur.bbox[4] - femur.bbox[1]
    expect(len).toBeGreaterThan(0.38)
    expect(len).toBeLessThan(0.52)
    const neighbours = femur.adjacent.map((id) => byId.get(id)!.name)
    expect(neighbours).toEqual(expect.arrayContaining(['Left tibia', 'Left patella', 'Left hip bone']))
    expect(neighbours).not.toContain('Right femur')
  })

  it('respects the coordinate convention: Y up, anterior +Z, left +X', () => {
    const y = (n: string) => byName(n).centroid[1]
    const z = (n: string) => byName(n).centroid[2]
    const x = (n: string) => byName(n).centroid[0]
    // superior–inferior
    expect(y('Frontal bone')).toBeGreaterThan(y('Mandible'))
    expect(y('Mandible')).toBeGreaterThan(y('Body of sternum'))
    expect(y('Body of sternum')).toBeGreaterThan(y('Sacrum'))
    expect(y('Left femur')).toBeGreaterThan(y('Left tibia'))
    expect(y('Left tibia')).toBeGreaterThan(y('Left calcaneus'))
    // the heart lies above the diaphragm's neighbour below it, the stomach, and above the kidneys
    expect(y('Wall of ventricle')).toBeGreaterThan(y('Stomach'))
    expect(y('Stomach')).toBeGreaterThan(y('Urinary bladder'))
    // anterior–posterior
    expect(z('Body of sternum')).toBeGreaterThan(z('Sixth thoracic vertebra') + 0.08)
    expect(z('Left patella')).toBeGreaterThan(z('Left femur'))
    expect(z('Frontal bone')).toBeGreaterThan(z('Occipital bone'))
    // left–right for unpaired, lateralised viscera (named without a side)
    expect(x('Spleen')).toBeGreaterThan(0.03)
    expect(byName('Spleen').side).toBe('L')
    expect(x('Gallbladder')).toBeLessThan(-0.01)
    expect(x('Left kidney')).toBeGreaterThan(0.02)
    expect(x('Right kidney')).toBeLessThan(-0.02)
    expect(byName('Body of sternum').side).toBe('M')
  })

  it('classifies by anatomical convention', () => {
    const teeth = data.parts.filter((p) => p.tissue === 'tooth')
    expect(teeth.length).toBe(28)
    expect(teeth.every((p) => p.system === 'digestive')).toBe(true)
    expect(byName('Left patella')).toMatchObject({ system: 'skeletal', tissue: 'bone' })
    expect(byName('Anterior leaflet of mitral valve')).toMatchObject({ system: 'cardiovascular', tissue: 'heart' })
    expect(byName('Wall of ventricle')).toMatchObject({ system: 'cardiovascular', tissue: 'heart', side: 'M' })
    expect(byName('Arch of aorta')).toMatchObject({ system: 'cardiovascular', tissue: 'artery' })
    expect(byName('Left femoral vein')).toMatchObject({ system: 'cardiovascular', tissue: 'vein', side: 'L' })
    expect(byName('Left first costal cartilage')).toMatchObject({ system: 'skeletal', tissue: 'cartilage', side: 'L' })
    expect(byName('Thyroid cartilage')).toMatchObject({ system: 'respiratory', tissue: 'cartilage' })
    expect(byName('Trachea')).toMatchObject({ system: 'respiratory', tissue: 'organ' })
    expect(byName('Stomach')).toMatchObject({ system: 'digestive', tissue: 'organ' })
    expect(byName('Left kidney')).toMatchObject({ system: 'urinary', side: 'L' })
    expect(byName('Prostate')).toMatchObject({ system: 'reproductive', tissue: 'gland' })
    expect(byName('Pituitary gland')).toMatchObject({ system: 'endocrine', tissue: 'gland' })
    expect(byName('Spleen')).toMatchObject({ system: 'lymphatic' })
    expect(byName('Skin')).toMatchObject({ system: 'integumentary', tissue: 'skin', depth: 0, side: 'M' })
    expect(byName('Left frontal nerve')).toMatchObject({ system: 'nervous', tissue: 'nerve' })
    expect(byName('Corpus callosum')).toMatchObject({ system: 'nervous', tissue: 'brain' })
    expect(byName('Right calcaneal tendon')).toMatchObject({ system: 'muscular', tissue: 'tendon' })
    const muscles = data.parts.filter((p) => p.tissue === 'muscle')
    expect(muscles.length).toBeGreaterThan(350)
    expect(muscles.every((p) => p.system === 'muscular')).toBe(true)
    const bones = data.parts.filter((p) => p.tissue === 'bone')
    expect(bones.length).toBeGreaterThanOrEqual(200)
    expect(bones.length).toBeLessThanOrEqual(212)
  })

  it('orders peel layers sensibly', () => {
    expect(layerOf(byName('Right gluteus maximus'))).toBe('muscle-superficial')
    expect(layerOf(byName('Right gluteus minimus'))).toBe('muscle-deep')
    expect(layerOf(byName('Left sartorius'))).toBe('muscle-superficial')
    expect(layerOf(byName('Left vastus intermedius'))).toBe('muscle-deep')
    expect(layerOf(byName('Left psoas major'))).toBe('muscle-deep')
    expect(layerOf(byName('Right pectoralis minor'))).toBe('muscle-deep')
    // twins agree
    for (const p of data.parts) {
      if (p.system !== 'muscular' || !/^Left /.test(p.name)) continue
      const twins = data.parts.filter((q) => q.name === p.name.replace(/^Left /, 'Right '))
      for (const t of twins) expect(t.depth, `${p.name} vs ${t.name}`).toBe(p.depth)
    }
    expect(byName('Skin').depth).toBeLessThan(byName('Left sartorius').depth)
    expect(byName('Left sartorius').depth).toBeLessThan(byName('Left femoral artery').depth)
    expect(byName('Left femoral artery').depth).toBeLessThan(byName('Stomach').depth)
    expect(byName('Stomach').depth).toBeLessThan(byName('Left femur').depth)
  })

  it('keeps sides consistent with geometry away from the midline', () => {
    // beyond 10 cm from the midline only limbs and the lateral trunk remain: names must agree
    const wrong = data.parts.filter((p) => Math.abs(p.centroid[0]) > 0.1 && p.side !== (p.centroid[0] > 0 ? 'L' : 'R') && p.side !== 'M')
    expect(wrong.map((p) => `${p.id} ${p.name}`)).toEqual([])
  })

  it('applies the source label corrections', () => {
    // label pairs that are swapped in BodyParts3D (tools/pipeline/corrections.ts)
    for (const name of ['flexor pollicis brevis', 'middle pharyngeal constrictor', 'ascending lumbar vein']) {
      const l = byName(`Left ${name}`)
      const r = byName(`Right ${name}`)
      expect(l.side).toBe('L')
      expect(l.bbox[0], l.name).toBeGreaterThan(-0.002)
      expect(r.side).toBe('R')
      expect(r.bbox[3], r.name).toBeLessThan(0.002)
      expect(l.fma).not.toBe(r.fma)
    }
    // and the trees follow: the lateralised concept holds the part that carries its id
    const concept = data.trees.isa.find((c) => c.name === 'left flexor pollicis brevis')!
    expect(concept.parts.map((id) => byId.get(id)!.name)).toEqual(['Left flexor pollicis brevis'])
    expect(byId.get(concept.parts[0]!)!.fma).toBe(concept.id)
  })

  it('keeps Part.fma consistent with the isa tree', () => {
    const concepts = new Map(data.trees.isa.map((c) => [c.id, c]))
    for (const p of data.parts) expect(concepts.has(p.fma), `${p.id} ${p.fma}`).toBe(true)
  })

  // ── parts imported from BodyParts3D 3.0 (lungs, abdominal wall, latissimus dorsi, face) ──────
  const r3 = present ? data.parts.filter((p) => p.id.startsWith('R3_')) : []
  describe.skipIf(r3.length === 0)('release 3.0 import', () => {
    const union = (parts: Part[]) => [0, 1, 2].map((k) => Math.min(...parts.map((p) => p.bbox[k]!))).concat([3, 4, 5].map((k) => Math.max(...parts.map((p) => p.bbox[k]!))))
    const LOBES = ['Upper lobe of right lung', 'Middle lobe of lung', 'Lower lobe of right lung', 'Upper lobe of left lung', 'Lower lobe of left lung']

    it('records the second source and marks imported parts as warped', () => {
      expect(data.sources.map((s) => s.name)).toEqual(['BodyParts3D 4.0', 'BodyParts3D 3.0'])
      expect(data.sources[1]!.license).toBe('CC BY-SA 2.1 JP')
      expect(r3.length).toBeGreaterThan(50)
      expect(r3.length).toBeLessThan(120)
      for (const p of r3) {
        expect(p.provenance).toBe('warped')
        expect(p.id).toBe(`R3_${p.fma}`)
        // an imported concept never duplicates a concept 4.0 already has a part for
        expect(data.parts.filter((q) => q.fma === p.fma).length, p.name).toBe(1)
      }
    })

    it('has both lungs, inside the rib cage, around the heart, on the diaphragm', () => {
      const lobes = LOBES.map(byName)
      for (const l of lobes) expect(l).toMatchObject({ system: 'respiratory', tissue: 'organ' })
      expect(lobes.slice(0, 3).every((l) => l.side === 'R' && l.centroid[0] < -0.03)).toBe(true)
      expect(lobes.slice(3).every((l) => l.side === 'L' && l.centroid[0] > 0.03)).toBe(true)
      const cage = union(data.parts.filter((p) => p.tissue === 'bone' && (/\brib$/.test(p.name) || /thoracic vertebra$/.test(p.name) || ['Manubrium', 'Body of sternum'].includes(p.name))))
      for (const l of lobes) {
        for (let k = 0; k < 3; k++) {
          expect(l.bbox[k]!, `${l.name} min ${k}`).toBeGreaterThan(cage[k]! - 0.005)
          expect(l.bbox[k + 3]!, `${l.name} max ${k}`).toBeLessThan(cage[k + 3]! + 0.005)
        }
      }
      // upper lobes above lower lobes; the heart between the lungs; lung bases near the diaphragm dome
      expect(byName('Upper lobe of right lung').centroid[1]).toBeGreaterThan(byName('Lower lobe of right lung').centroid[1])
      expect(byName('Upper lobe of left lung').centroid[1]).toBeGreaterThan(byName('Lower lobe of left lung').centroid[1])
      const heart = byName('Wall of ventricle')
      expect(heart.centroid[0]).toBeGreaterThan(byName('Lower lobe of right lung').centroid[0])
      expect(heart.centroid[0]).toBeLessThan(byName('Lower lobe of left lung').centroid[0])
      const diaphragm = byName('Diaphragm')
      for (const n of ['Lower lobe of right lung', 'Lower lobe of left lung']) {
        const l = byName(n)
        expect(l.centroid[1]).toBeGreaterThan(diaphragm.centroid[1])
        expect(l.bbox[1]).toBeGreaterThan(diaphragm.bbox[1])
        expect(l.bbox[1]).toBeLessThan(diaphragm.bbox[4])
        expect(l.adjacent.map((id) => byId.get(id)!.name)).toContain('Diaphragm')
      }
    })

    it('puts the 4.0 bronchial tree inside the lungs', () => {
      const airways = data.parts.filter((p) => /bronchial tree$/.test(p.name))
      expect(airways.length).toBeGreaterThan(80)
      const lobes = LOBES.map(byName)
      const inside = airways.filter((a) => lobes.some((l) => [0, 1, 2].every((k) => a.centroid[k]! > l.bbox[k]! && a.centroid[k]! < l.bbox[k + 3]!)))
      expect(inside.length / airways.length).toBeGreaterThan(0.95)
      // and the lobes touch what runs through them
      const touching = airways.filter((a) => a.adjacent.some((id) => LOBES.includes(byId.get(id)!.name)))
      expect(touching.length).toBeGreaterThan(5)
    })

    it('has the liver (as its 4.0 segments) on the right under the diaphragm', () => {
      // the whole-organ liver of 3.0 is deliberately not imported: 4.0 has it as segments
      expect(data.parts.some((p) => p.name === 'Liver')).toBe(false)
      const segments = data.parts.filter((p) => /^Hepatovenous segment/.test(p.name) || p.name === 'Caudate lobe of liver')
      expect(segments.length).toBe(10)
      const volume = segments.reduce((s, p) => s + (p.volume ?? 0), 0)
      expect(volume).toBeGreaterThan(1200)
      const cx = segments.reduce((s, p) => s + p.centroid[0] * (p.volume ?? 1), 0) / volume
      expect(cx).toBeLessThan(-0.02)
      const diaphragm = byName('Diaphragm')
      const cy = segments.reduce((s, p) => s + p.centroid[1] * (p.volume ?? 1), 0) / volume
      expect(cy).toBeLessThan(diaphragm.bbox[4])
      expect(cy).toBeLessThan(byName('Wall of ventricle').centroid[1])
      expect(cy).toBeGreaterThan(byName('Right kidney').centroid[1] - 0.05)
      expect(segments.some((p) => p.adjacent.map((id) => byId.get(id)!.name).includes('Diaphragm'))).toBe(true)
      const liver = data.trees.partOf.find((c) => c.name === 'liver')!
      const kids = (id: string): string[] => data.trees.partOf.filter((c) => c.parent === id).flatMap((c) => [...c.parts, ...kids(c.id)])
      expect([...liver.parts, ...kids(liver.id)].length).toBeGreaterThan(20)
    })

    it('has the abdominal wall: rectus abdominis, internal oblique, transversus abdominis', () => {
      const sternum = byName('Body of sternum')
      const lumbar = byName('Third lumbar vertebra')
      for (const side of ['Left', 'Right'] as const) {
        const rectus = byName(`${side} rectus abdominis`)
        expect(rectus).toMatchObject({ system: 'muscular', tissue: 'muscle', side: side[0] })
        expect(Math.sign(rectus.centroid[0])).toBe(side === 'Left' ? 1 : -1)
        expect(Math.abs(rectus.centroid[0])).toBeLessThan(0.08)
        // in front of the lumbar spine, from the costal margin down to the pubis
        expect(rectus.centroid[2]).toBeGreaterThan(lumbar.centroid[2] + 0.08)
        expect(rectus.bbox[4]).toBeLessThan(sternum.bbox[4])
        expect(rectus.bbox[4]).toBeGreaterThan(byName('Xiphoid process').bbox[1] - 0.03)
        expect(rectus.bbox[1]).toBeGreaterThan(byName(`${side} hip bone`).bbox[1])
        expect(rectus.bbox[1]).toBeLessThan(byName(`${side} hip bone`).bbox[4])
        // layering front to back: external oblique, internal oblique, transversus abdominis
        const names = rectus.adjacent.map((id) => byId.get(id)!.name)
        expect(names).toContain(`${side} external oblique`)
        const io = byName(`${side} internal oblique`)
        const ta = byName(`${side} transversus abdominis`)
        expect(io.adjacent.map((id) => byId.get(id)!.name)).toEqual(expect.arrayContaining([`${side} external oblique`, `${side} transversus abdominis`]))
        expect(Math.abs(ta.centroid[0])).toBeLessThan(Math.abs(byName(`${side} external oblique`).centroid[0]) + 0.01)
        expect(byName(`${side} quadratus lumborum`).centroid[2]).toBeLessThan(rectus.centroid[2] - 0.08)
      }
      // stays in front of the viscera rather than inside them
      expect(byName('Left rectus abdominis').centroid[2]).toBeGreaterThan(byName('Stomach').centroid[2])
    })

    it('has latissimus dorsi on the back, reaching from the pelvis to the arm', () => {
      for (const side of ['Left', 'Right'] as const) {
        const lat = byName(`${side} latissimus dorsi`)
        expect(lat).toMatchObject({ system: 'muscular', tissue: 'muscle', side: side[0] })
        expect(layerOf(lat)).toBe('muscle-superficial')
        expect(lat.centroid[2]).toBeLessThan(byName('Body of sternum').centroid[2] - 0.1)
        expect(lat.centroid[2]).toBeLessThan(byName('Third lumbar vertebra').centroid[2])
        expect(lat.bbox[4] - lat.bbox[1]).toBeGreaterThan(0.3)
        expect(lat.bbox[1]).toBeLessThan(byName(`${side} hip bone`).bbox[4])
        const names = lat.adjacent.map((id) => byId.get(id)!.name)
        expect(names).toContain(`${side} humerus`)
        expect(names.some((n) => /teres major|serratus|trapezius/.test(n))).toBe(true)
      }
    })

    it('has the muscles of mastication and facial expression on the skull, not in it', () => {
      const masseter = byName('Superficial part of left masseter')
      expect(masseter).toMatchObject({ system: 'muscular', tissue: 'muscle', side: 'L' })
      expect(masseter.adjacent.map((id) => byId.get(id)!.name)).toContain('Mandible')
      const temporalis = byName('Left temporalis')
      expect(temporalis.centroid[1]).toBeGreaterThan(masseter.centroid[1])
      expect(temporalis.adjacent.map((id) => byId.get(id)!.name).some((n) => /parietal|temporal|sphenoid|frontal/i.test(n))).toBe(true)
      const frontalis = byName('Left frontalis')
      const frontal = byName('Frontal bone')
      // on the outer face of the frontal bone: centroid in front of the bone's
      expect(frontalis.centroid[2]).toBeGreaterThan(frontal.centroid[2])
      expect(byName('Orbicularis oris').side).toBe('M')
      for (const n of ['Left zygomaticus major', 'Right buccinator', 'Left occipitalis', 'Aponeurosis of epicranius']) expect(byName(n).system).toBe('muscular')
      expect(byName('Aponeurosis of epicranius').tissue).toBe('tendon')
      expect(byName('Left inguinal ligament')).toMatchObject({ system: 'skeletal', tissue: 'ligament' })
    })

    it('attaches imported parts to both trees', () => {
      const isa = new Map(data.trees.isa.map((c) => [c.id, c]))
      const up = (id: string): string[] => {
        const c = isa.get(id)
        return c ? [c.name, ...(c.parent ? up(c.parent) : [])] : []
      }
      expect(up(byName('Left rectus abdominis').fma)).toEqual(expect.arrayContaining(['left rectus abdominis', 'muscle of anterior abdominal wall', 'muscle organ']))
      expect(up(byName('Left temporalis').fma)).toContain('muscle of head')
      const po = new Map(data.trees.partOf.map((c) => [c.id, c]))
      const lobe = po.get(byName('Upper lobe of right lung').fma)!
      expect(lobe.parts).toContain(byName('Upper lobe of right lung').id)
      expect(po.get(lobe.parent!)!.name).toBe('right lung')
    })
  })
})
