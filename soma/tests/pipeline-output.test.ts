// 校验生成的运行时数据。管线尚未运行时跳过（public/anatomy 已被 gitignore）：
// 请先运行 `bun run pipeline`。
// Validates the generated runtime data. Skipped when the pipeline has not been run
// (public/anatomy is gitignored): `bun run pipeline` first.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnatomyData, Concept, NervePath, Part } from '../src/anatomy/types.ts'
import type { Mesh } from '../tools/pipeline/geometry.ts'
import { runLandmarkChecks, type LandmarkResult } from '../tools/pipeline/landmarks.ts'
import type { Polyline } from '../tools/pipeline/tube.ts'
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
      expect(p.id).toMatch(/^(FJ\d+M?|R3_FMA\d+|ZA[0-9A-F]{8}|SOMA_[a-z_]+(_[LR])?)$/)
      // FMA id，或者对 FMA 中没有对应类的结构使用合成的 ZAC_… 概念 id
      // FMA ids, or a synthetic ZAC_… concept id for structures FMA has no class for
      expect(p.fma, p.id).toMatch(/^(FMA\d+(_[LR])?|ZAC_[a-z0-9_]+(_[LR])?)$/)
      expect(p.name.trim().length, p.id).toBeGreaterThan(0)
      expect(SYSTEMS, p.id).toContain(p.system)
      expect(TISSUES, p.id).toContain(p.tissue)
      expect(['L', 'R', 'M'], p.id).toContain(p.side)
      expect(p.provenance, p.id).toBe(p.id.startsWith('R3_') ? 'warped' : p.id.startsWith('ZA') || p.id.startsWith('SOMA_') ? 'curated' : 'scanned')
      // 每个部件所指的数据源都存在；只有来自第一个数据源的部件可以省略它
      // every part names a source that exists; only first-source parts may leave it out
      if (p.id.startsWith('FJ')) expect(p.source, p.id).toBeUndefined()
      else expect(data.sources.slice(1).map((x) => x.name), p.id).toContain(p.source)
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
        // 世界空间的包围盒（节点变换抵消了量化）必须与 JSON 中的 bbox 一致
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
    // 已剪枝：每个叶概念都带有部件 / pruned: every leaf concept carries parts
    for (const c of tree) if (!children.has(c.id)) expect(c.parts.length, `leaf ${c.id} ${c.name}`).toBeGreaterThan(0)
    return new Set(tree.flatMap((c) => c.parts))
  }

  it('reaches every part from the single-rooted isa tree', () => {
    const { isa } = data.trees
    expect(isa.filter((c) => c.parent === null).length).toBe(1)
    const reached = checkTree(isa)
    expect(data.parts.filter((p) => !reached.has(p.id)).map((p) => p.id)).toEqual([])
    // 直属部件只挂在一个概念上 / direct parts are attached to one concept only
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
    expect(max).toBeLessThanOrEqual(250)
    // 皮肤是包络：两个方向都排除 / the skin is an envelope: excluded in both directions
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
      // 单位是米，不是毫米 / metres, not millimetres
      expect(Math.abs(p.bbox[0]), p.id).toBeLessThan(0.6)
      expect(Math.abs(p.bbox[3]), p.id).toBeLessThan(0.6)
      expect(p.bbox[2], p.id).toBeGreaterThan(-0.4)
      expect(p.bbox[5], p.id).toBeLessThan(0.4)
    }
    const height = maxY - minY
    expect(height).toBeGreaterThan(1.6)
    expect(height).toBeLessThan(1.9)
    // 双足在 y = 0 附近（源坐标原点略高于跖屈足的趾尖）
    // feet near y = 0 (the source origin is a little above the toe tips of the plantar-flexed feet)
    expect(minY).toBeGreaterThan(-0.15)
    expect(minY).toBeLessThan(0.05)
    // 关于 x = 0 大致对称 / roughly symmetric about x = 0
    expect(Math.abs(minX + maxX)).toBeLessThan(0.02)
  })

  it('stays within the triangle budget', () => {
    const total = data.parts.reduce((s, p) => s + p.triangles, 0)
    expect(total).toBeGreaterThan(800_000)
    expect(total).toBeLessThan(2_400_000)
  })

  it('gets the left femur right', () => {
    const femur = byName('Left femur')
    expect(femur).toMatchObject({ side: 'L', system: 'skeletal', tissue: 'bone', fma: 'FMA24475' })
    expect(femur.centroid[0]).toBeGreaterThan(0.03)
    expect(layerOf(femur)).toBe('skeleton')
    const right = byName('Right femur')
    expect(right.side).toBe('R')
    expect(right.centroid[0]).toBeLessThan(-0.03)
    // 镜像孪生件位于同一高度 / mirror-image twins sit at the same height
    expect(Math.abs(right.centroid[1] - femur.centroid[1])).toBeLessThan(0.01)
    // 股骨长 40–50 cm，沿 Y 方向 / a femur is 40–50 cm long and runs along Y
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
    // 上–下 / superior–inferior
    expect(y('Frontal bone')).toBeGreaterThan(y('Mandible'))
    expect(y('Mandible')).toBeGreaterThan(y('Body of sternum'))
    expect(y('Body of sternum')).toBeGreaterThan(y('Sacrum'))
    expect(y('Left femur')).toBeGreaterThan(y('Left tibia'))
    expect(y('Left tibia')).toBeGreaterThan(y('Left calcaneus'))
    // 心脏位于膈下方的邻居——胃——之上，也在肾之上
    // the heart lies above the diaphragm's neighbour below it, the stomach, and above the kidneys
    expect(y('Wall of ventricle')).toBeGreaterThan(y('Stomach'))
    expect(y('Stomach')).toBeGreaterThan(y('Urinary bladder'))
    // 前–后 / anterior–posterior
    expect(z('Body of sternum')).toBeGreaterThan(z('Sixth thoracic vertebra') + 0.08)
    expect(z('Left patella')).toBeGreaterThan(z('Left femur'))
    expect(z('Frontal bone')).toBeGreaterThan(z('Occipital bone'))
    // 不成对但偏于一侧的内脏（名称中不带侧别）的左–右关系
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
    // 孪生件一致 / twins agree
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
    // 距中线 10 cm 以外只剩四肢和躯干外侧：名称必须与侧别一致
    // beyond 10 cm from the midline only limbs and the lateral trunk remain: names must agree
    const wrong = data.parts.filter((p) => Math.abs(p.centroid[0]) > 0.1 && p.side !== (p.centroid[0] > 0 ? 'L' : 'R') && p.side !== 'M')
    expect(wrong.map((p) => `${p.id} ${p.name}`)).toEqual([])
  })

  it('lists cautions in both languages, most important first', () => {
    expect(data.cautions!.length).toBeGreaterThanOrEqual(6)
    for (const c of data.cautions!) {
      expect(c.en.length, c.en).toBeGreaterThan(40)
      expect(c.zh, c.en).toMatch(/[\u4e00-\u9fff]/)
      expect(c.zh.length).toBeLessThan(260)
    }
    const all = data.cautions!.map((c) => c.en).join(' ')
    for (const w of ['not a scan of one person', 'Z-Anatomy', 'BodyParts3D 3.0', 'Transversus abdominis', 'phrenic nerve', 'Left/right labels']) expect(all).toContain(w)
  })

  it('gives each side its own concept where a lateralised part was filed under an unsided class', () => {
    // 来自 Z-Anatomy 包的左侧部件和右侧部件不会共用同一个概念
    // no concept is shared by a left and a right part that came from the Z-Anatomy package
    const sides = new Map<string, Set<string>>()
    for (const p of data.parts) if (p.id.startsWith('ZA') && p.side !== 'M') sides.set(p.fma, (sides.get(p.fma) ?? new Set()).add(p.side))
    expect([...sides].filter(([, v]) => v.size > 1).map(([k]) => k)).toEqual([])
    const minted = data.parts.filter((p) => /^FMA\d+_[LR]$/.test(p.fma))
    expect(minted.length).toBeGreaterThan(100)
    const isa = new Map(data.trees.isa.map((c) => [c.id, c]))
    for (const p of minted) {
      const c = isa.get(p.fma)!
      expect(c.parent, p.name).toBe(p.fma.replace(/_[LR]$/, ''))
      expect(p.fma.endsWith(`_${p.side}`), p.name).toBe(true)
      expect(c.name.toLowerCase(), p.name).toBe(p.name.toLowerCase())
      expect(c.parts).toEqual([p.id])
    }
  })

  it('applies the source label corrections', () => {
    // FJ2190 原是位于左腿的 "Right fibular vein"：现在归入左侧概念，而不是左侧部件挂右侧的类
    // FJ2190 was "Right fibular vein" on the left leg: now the left concept, not a right-side class on a left part
    const fj = byId.get('FJ2190')!
    expect(fj).toMatchObject({ name: 'Left fibular vein', fma: 'FMA44886', side: 'L' })
    expect(fj.centroid[0]).toBeGreaterThan(0.03)
    expect(data.trees.isa.find((c) => c.id === 'FMA44886')!.parts).toContain('FJ2190')
    expect(data.trees.isa.find((c) => c.id === 'FMA44885')?.parts ?? []).not.toContain('FJ2190')
    for (const p of data.parts) {
      const c = data.trees.isa.find((x) => x.id === p.fma)!
      if (/^right /.test(c.name)) expect(p.side, `${p.id} ${p.name} under "${c.name}"`).not.toBe('L')
      if (/^left /.test(c.name)) expect(p.side, `${p.id} ${p.name} under "${c.name}"`).not.toBe('R')
    }
    // BodyParts3D 中标签互换的元素对（tools/pipeline/corrections.ts）
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
    // 树也随之调整：分侧概念下挂的是带有其 id 的部件
    // and the trees follow: the lateralised concept holds the part that carries its id
    const concept = data.trees.isa.find((c) => c.name === 'left flexor pollicis brevis')!
    expect(concept.parts.map((id) => byId.get(id)!.name)).toEqual(['Left flexor pollicis brevis'])
    expect(byId.get(concept.parts[0]!)!.fma).toBe(concept.id)
  })

  it('keeps Part.fma consistent with the isa tree', () => {
    const concepts = new Map(data.trees.isa.map((c) => [c.id, c]))
    for (const p of data.parts) expect(concepts.has(p.fma), `${p.id} ${p.fma}`).toBe(true)
  })

  // ── 从 BodyParts3D 3.0 导入的部件（肺、腹壁、背阔肌、面部） / parts imported from BodyParts3D 3.0 (lungs, abdominal wall, latissimus dorsi, face) ──────
  const r3 = present ? data.parts.filter((p) => p.id.startsWith('R3_')) : []
  describe.skipIf(r3.length === 0)('release 3.0 import', () => {
    const union = (parts: Part[]) => [0, 1, 2].map((k) => Math.min(...parts.map((p) => p.bbox[k]!))).concat([3, 4, 5].map((k) => Math.max(...parts.map((p) => p.bbox[k]!))))
    const LOBES = ['Upper lobe of right lung', 'Middle lobe of lung', 'Lower lobe of right lung', 'Upper lobe of left lung', 'Lower lobe of left lung']

    it('records the second source and marks imported parts as warped', () => {
      expect(data.sources.slice(0, 2).map((s) => s.name)).toEqual(['BodyParts3D 4.0', 'BodyParts3D 3.0'])
      expect(data.sources[1]!.license).toBe('CC BY-SA 2.1 JP')
      expect(r3.length).toBeGreaterThan(50)
      expect(r3.length).toBeLessThan(120)
      for (const p of r3) {
        expect(p.provenance).toBe('warped')
        expect(p.source).toBe('BodyParts3D 3.0')
        expect(p.id).toBe(`R3_${p.fma}`)
        // 导入的概念绝不与 4.0 中已有部件的概念重复
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
      // 上叶在下叶之上；心脏在两肺之间；肺底靠近膈穹
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
      // 并且各肺叶与穿行其中的结构相接触 / and the lobes touch what runs through them
      const touching = airways.filter((a) => a.adjacent.some((id) => LOBES.includes(byId.get(id)!.name)))
      expect(touching.length).toBeGreaterThan(5)
    })

    it('has the liver (as its 4.0 segments) on the right under the diaphragm', () => {
      // 有意不导入 3.0 的整器官肝：4.0 以肝段的形式提供它
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
        // 位于腰椎前方，从肋缘向下到耻骨
        // in front of the lumbar spine, from the costal margin down to the pubis
        expect(rectus.centroid[2]).toBeGreaterThan(lumbar.centroid[2] + 0.08)
        expect(rectus.bbox[4]).toBeLessThan(sternum.bbox[4])
        expect(rectus.bbox[4]).toBeGreaterThan(byName('Xiphoid process').bbox[1] - 0.03)
        expect(rectus.bbox[1]).toBeGreaterThan(byName(`${side} hip bone`).bbox[1])
        expect(rectus.bbox[1]).toBeLessThan(byName(`${side} hip bone`).bbox[4])
        // 由前到后的层次：腹外斜肌、腹内斜肌、腹横肌
        // layering front to back: external oblique, internal oblique, transversus abdominis
        const names = rectus.adjacent.map((id) => byId.get(id)!.name)
        expect(names).toContain(`${side} external oblique`)
        const io = byName(`${side} internal oblique`)
        const ta = byName(`${side} transversus abdominis`)
        expect(io.adjacent.map((id) => byId.get(id)!.name)).toEqual(expect.arrayContaining([`${side} external oblique`, `${side} transversus abdominis`]))
        expect(Math.abs(ta.centroid[0])).toBeLessThan(Math.abs(byName(`${side} external oblique`).centroid[0]) + 0.01)
        expect(byName(`${side} quadratus lumborum`).centroid[2]).toBeLessThan(rectus.centroid[2] - 0.08)
      }
      // 位于内脏前方，而不是在内脏内部 / stays in front of the viscera rather than inside them
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
      // 在额骨的外侧面上：质心在额骨质心的前方
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

  // ── 从 Z-Anatomy / Open3DModel 包导入的部件 / parts imported from the Z-Anatomy / Open3DModel package ───────────────────────────────────
  const za = present ? data.parts.filter((p) => p.id.startsWith('ZA')) : []
  describe.skipIf(za.length === 0)('Z-Anatomy / Open3DModel import', () => {
    const NERVES = join(DIR, 'nerves.json')
    const nervePaths = (existsSync(NERVES) ? JSON.parse(readFileSync(NERVES, 'utf8')) : []) as NervePath[]
    const names = (p: Part) => p.adjacent.map((id) => byId.get(id)!.name)

    it('adds the two sources with share-alike licences and marks the parts as curated', () => {
      const src = new Map(data.sources.map((s) => [s.name, s]))
      for (const n of ['Z-Anatomy', 'Open3DModel']) {
        expect(src.get(n)!.license).toBe('CC BY-SA 4.0')
        expect(src.get(n)!.attribution).toMatch(/registered to the BodyParts3D 4\.0 body/)
      }
      expect(src.get('Z-Anatomy')!.attribution).toContain('Z-Anatomy - The libre 3D atlas of anatomy - CC-BY-SA 4.0')
      for (const p of za) {
        expect(p.provenance).toBe('curated')
        expect(['Z-Anatomy', 'Open3DModel'], p.id).toContain(p.source)
      }
      // Open3DModel：神经，以及第 2 批的下肢关节结构
      // Open3DModel: nerves, and the lower-limb joint structures of batch 2
      expect(za.filter((p) => p.source === 'Open3DModel').every((p) => p.tissue === 'nerve' || p.system === 'skeletal' || p.system === 'nervous')).toBe(true)
    })

    it('classifies nerves, lymph nodes, glands, ligaments and fasciae', () => {
      const count = (f: (p: Part) => boolean) => za.filter(f).length
      expect(count((p) => p.system === 'nervous' && p.tissue === 'nerve')).toBeGreaterThan(400)
      expect(count((p) => p.system === 'lymphatic')).toBeGreaterThan(100)
      expect(count((p) => p.system === 'skeletal' && p.tissue === 'ligament')).toBeGreaterThan(200)
      expect(count((p) => p.system === 'muscular' && p.tissue === 'fascia')).toBeGreaterThan(40)
      expect(za.every((p) => ['nervous', 'lymphatic', 'endocrine', 'skeletal', 'muscular', 'digestive', 'integumentary'].includes(p.system)), 'systems').toBe(true)
      expect(byName('Left sciatic nerve')).toMatchObject({ system: 'nervous', tissue: 'nerve', side: 'L', source: 'Open3DModel' })
      expect(byName('Right vagus nerve (X)')).toMatchObject({ system: 'nervous', tissue: 'nerve', source: 'Z-Anatomy' })
      expect(byName('Left palatine tonsil')).toMatchObject({ system: 'lymphatic', side: 'L' })
      expect(byName('Left fascia lata')).toMatchObject({ system: 'muscular', tissue: 'fascia' })
      expect(LAYERS[byName('Left fascia lata').depth]!.key).toBe('fascia')
      expect(LAYERS[byName('Left sciatic nerve').depth]!.key).toBe('neurovascular')
      expect(LAYERS[byName('Left posterior cruciate ligament').depth]!.key).toBe('joints')
      // BodyParts3D 自带的神经部件优先于导入的重复件
      // BodyParts3D's own nerve parts win over imported duplicates
      expect(data.parts.filter((p) => /^Left optic nerve/.test(p.name)).every((p) => p.id.startsWith('FJ'))).toBe(true)
      expect(byName('Left oculomotor nerve (III)').source).toBe('Z-Anatomy')
    })

    it('puts the thyroid in front of the trachea, below the thyroid cartilage', () => {
      const thyroid = byName('Thyroid gland')
      expect(thyroid).toMatchObject({ system: 'endocrine', tissue: 'gland', side: 'M', source: 'Z-Anatomy' })
      const trachea = byName('Trachea')
      const cartilage = byName('Thyroid cartilage')
      expect(Math.abs(thyroid.centroid[0])).toBeLessThan(0.008)
      // 包绕气管上段：在高度上与之重叠，峡部位于气管前方
      // wraps the upper trachea: overlaps it in height, its isthmus lies in front of it
      expect(thyroid.bbox[1]).toBeGreaterThan(trachea.bbox[1])
      expect(thyroid.bbox[1]).toBeLessThan(trachea.bbox[4])
      expect(thyroid.bbox[5]).toBeGreaterThan(trachea.bbox[5] - 0.002)
      // 在喉结下方：质心低于甲状软骨的质心
      // below the laryngeal prominence: centroid under the thyroid cartilage's centroid
      expect(thyroid.centroid[1]).toBeLessThan(cartilage.centroid[1])
      expect(cartilage.centroid[1] - thyroid.centroid[1]).toBeLessThan(0.06)
      expect(names(thyroid)).toContain('Trachea')
      // 甲状腺宽 4–6 cm / a thyroid is 4–6 cm wide
      expect(thyroid.bbox[3] - thyroid.bbox[0]).toBeGreaterThan(0.03)
      expect(thyroid.bbox[3] - thyroid.bbox[0]).toBeLessThan(0.075)
      for (const side of ['Left', 'Right']) expect(Math.abs(byName(`${side} superior parathyroid gland`).centroid[1] - thyroid.centroid[1])).toBeLessThan(0.03)
    })

    it('has lymph nodes where their names say', () => {
      const y = (n: string) => byName(n).centroid[1]
      expect(y('Left submandibular nodes')).toBeGreaterThan(y('Left supraclavicular nodes'))
      expect(y('Left supraclavicular nodes')).toBeGreaterThan(y('Left central axillary nodes'))
      expect(y('Left central axillary nodes')).toBeGreaterThan(y('Left superomedial superficial inguinal nodes'))
      expect(y('Left superomedial superficial inguinal nodes')).toBeGreaterThan(y('Left deep popliteal nodes'))
      expect(Math.abs(byName('Left central axillary nodes').centroid[0])).toBeGreaterThan(0.1)
      const hip = byName('Left hip bone')
      const inguinal = byName('Left superomedial superficial inguinal nodes')
      expect(inguinal.centroid[1]).toBeGreaterThan(hip.bbox[1] - 0.05)
      expect(inguinal.centroid[1]).toBeLessThan(hip.bbox[4])
      expect(inguinal.centroid[2]).toBeGreaterThan(hip.centroid[2])
    })

    it('has knee and ankle ligaments at their joints', () => {
      const pcl = byName('Left posterior cruciate ligament')
      const femur = byName('Left femur')
      const tibia = byName('Left tibia')
      expect(pcl.centroid[1]).toBeLessThan(femur.bbox[1] + 0.05)
      expect(pcl.centroid[1]).toBeGreaterThan(tibia.bbox[4] - 0.03)
      expect(names(pcl)).toEqual(expect.arrayContaining(['Left femur', 'Left tibia']))
      const fib = byName('Left fibular collateral ligament')
      expect(fib.centroid[0]).toBeGreaterThan(pcl.centroid[0])
      expect(names(fib)).toContain('Left fibula')
    })

    it('ships nerves.json consistent with the nerve parts', () => {
      expect(nervePaths.length).toBeGreaterThan(350)
      const seen = new Set<string>()
      for (const n of nervePaths) {
        expect(seen.has(n.part), `${n.part} twice`).toBe(false)
        seen.add(n.part)
        const part = byId.get(n.part)
        expect(part, n.part).toBeDefined()
        expect(part!.tissue, n.part).toBe('nerve')
        expect(n.branches.length, n.part).toBeGreaterThan(0)
        for (const b of n.branches) {
          expect(b.points.length % 3, n.part).toBe(0)
          expect(b.radius.length, n.part).toBe(b.points.length / 3)
          expect(b.radius.length, n.part).toBeGreaterThanOrEqual(2)
          expect(b.points.every(Number.isFinite) && b.radius.every((r) => r > 0 && r < 0.01), n.part).toBe(true)
          // 管是围绕这条线生成的：每个点都位于按其半径外扩的部件包围盒内
          // the tube was built round this line: every point lies inside the part's bounds grown by its radius
          for (let i = 0; i < b.points.length; i += 3) {
            const r = b.radius[i / 3]! + 2e-4
            for (let k = 0; k < 3; k++) {
              expect(b.points[i + k]!, `${part!.name} point ${i / 3}`).toBeGreaterThanOrEqual(part!.bbox[k]! - r)
              expect(b.points[i + k]!, `${part!.name} point ${i / 3}`).toBeLessThanOrEqual(part!.bbox[k + 3]! + r)
            }
          }
        }
      }
      // 每条以管生成的神经都有中心线；神经节（网格）没有
      // every tube-built nerve has its centreline; ganglia (meshes) have none
      const tubes = za.filter((p) => p.tissue === 'nerve' && !/ganglion|ganglia/i.test(p.name))
      // ……少数源中心线无法恢复的除外（它们改为按网格形变）
      // … except the few whose source centreline could not be recovered (warped as meshes instead)
      const without = tubes.filter((p) => !seen.has(p.id)).map((p) => p.name)
      expect(without.length).toBeLessThanOrEqual(8)
      expect(without.filter((n) => !/dorsal branch of ulnar nerve|lumbar plexus|lumbosacral trunk|sacral plexus/.test(n))).toEqual([])
      expect(za.filter((p) => /spinal ganglion/.test(p.name) && seen.has(p.id))).toEqual([])
      // 长的神经确实长 / long nerves are long
      const length = (name: string) => {
        const n = nervePaths.find((x) => x.part === byName(name).id)!
        return Math.max(...n.branches.map((b) => {
          let l = 0
          for (let i = 3; i < b.points.length; i += 3) l += Math.hypot(b.points[i]! - b.points[i - 3]!, b.points[i + 1]! - b.points[i - 2]!, b.points[i + 2]! - b.points[i - 1]!)
          return l
        }))
      }
      expect(length('Left sciatic nerve')).toBeGreaterThan(0.25)
      expect(length('Left median nerve')).toBeGreaterThan(0.4)
      expect(length('Left ulnar nerve')).toBeGreaterThan(0.4)
    })

    it('passes the anatomical landmark checks on the shipped geometry', async () => {
      // 网格直接取自 GLB（世界空间），中心线取自 nerves.json
      // meshes straight from the GLBs (world space), centrelines from nerves.json
      const wanted = new Set<string>()
      for (const side of ['Left', 'Right']) {
        const s = side.toLowerCase()
        for (const n of [`${side} radius`, `Flexor retinaculum of ${s} wrist`, `${side} humerus`, `${side} piriformis`, `${side} femur`, `Long head of ${s} biceps femoris`, `${side} semimembranosus`, `${side} fibula`, `${side} inguinal ligament`, `${side} femoral artery`, `${side} scalenus anterior`, `${side} scalenus medius`]) wanted.add(n)
        for (const o of ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']) wanted.add(`${side} ${o} rib`)
      }
      const meshes = new Map<string, Mesh>()
      const systems = new Set([...wanted].map((n) => byName(n).system))
      for (const sys of systems) {
        const doc = await readGlb(join(DIR, `${sys}.glb`))
        for (const node of doc.getRoot().listNodes()) {
          const part = byId.get(node.getName())
          if (!part || !wanted.has(part.name)) continue
          const prim = node.getMesh()!.listPrimitives()[0]!
          const pos = prim.getAttribute('POSITION')!
          const m = node.getWorldMatrix()
          const positions = new Float32Array(pos.getCount() * 3)
          const v = [0, 0, 0]
          for (let i = 0; i < pos.getCount(); i++) {
            pos.getElement(i, v)
            for (let k = 0; k < 3; k++) positions[3 * i + k] = v[k]! * m[5 * k]! + m[12 + k]!
          }
          meshes.set(part.name, { positions, indices: Uint32Array.from(prim.getIndices()!.getArray()!) })
        }
      }
      const lines = new Map<string, Polyline[]>(nervePaths.map((n) => [byId.get(n.part)!.name, n.branches.map((b) => ({ points: Float32Array.from(b.points), radius: Float32Array.from(b.radius) }))]))
      const results = runLandmarkChecks({ mesh: (n) => meshes.get(n) ?? null, nerve: (n) => lines.get(n) ?? null })
      const get = (id: string, side: 'L' | 'R'): LandmarkResult => results.find((r) => r.id === id && r.side === side)!
      expect(results.length).toBe(18)
      expect(results.filter((r) => !r.evaluated).map((r) => `${r.side} ${r.id}: ${r.measured}`)).toEqual([])
      expect(results.filter((r) => !r.pass).map((r) => `${r.side} ${r.id}: ${r.measured}`)).toEqual([])
      // 这些判定背后的容差，在数值上重新表述（mm）
      // the tolerances behind those verdicts, restated on the numbers (mm)
      for (const side of ['L', 'R'] as const) {
        const wrist = get('median-wrist', side).values
        expect(wrist.palmarOfRadius!).toBeGreaterThan(3)
        expect(wrist.toRadius!).toBeLessThan(20)
        expect(wrist.toRetinaculum!).toBeLessThan(8)
        const elbow = get('ulnar-epicondyle', side).values
        expect(elbow.toEpicondyle!).toBeLessThan(15)
        expect(elbow.posterior!).toBeGreaterThan(0)
        const pir = get('sciatic-piriformis', side).values
        expect(pir.toPiriformis!).toBeLessThan(12)
        const thigh = get('sciatic-thigh', side).values
        expect(thigh.posteriorMin!).toBeGreaterThan(5)
        expect(thigh.betweenMin!).toBeGreaterThan(-0.35)
        expect(thigh.betweenMax!).toBeLessThan(1.35)
        const radial = get('radial-humerus', side).values
        expect(radial.toBone!).toBeLessThan(15)
        expect(radial.posterior!).toBeGreaterThan(3)
        expect(radial.medialProximal!).toBeGreaterThan(0)
        expect(radial.lateralDistal!).toBeGreaterThan(0)
        expect(get('fibular-neck', side).values.toFibula!).toBeLessThan(8)
        const fem = get('femoral-triangle', side).values
        expect(fem.lateral!).toBeGreaterThan(2)
        expect(fem.separation!).toBeLessThan(40)
        const plexus = get('plexus-scalenes', side).values
        expect(plexus.rootsEvaluated!).toBe(5)
        expect(plexus.rootsBetween!).toBeGreaterThanOrEqual(3)
        const ribs = get('intercostal-ribs', side).values
        expect(ribs.nerves!).toBeGreaterThanOrEqual(10)
        expect(ribs.worstMedianDistance!).toBeLessThan(6)
        expect(ribs.meanBelow!).toBeGreaterThan(0.6)
      }
    }, 120_000)

    it('keeps nerve adjacency lists in proportion', () => {
      const nerves = za.filter((p) => p.tissue === 'nerve')
      const deg = nerves.map((p) => p.adjacent.length).sort((a, b) => a - b)
      expect(deg[Math.floor(deg.length / 2)]!).toBeLessThan(40)
      expect(deg[deg.length - 1]!).toBeLessThanOrEqual(250)
      const sciatic = names(byName('Left sciatic nerve'))
      expect(sciatic.some((n) => /biceps femoris|semimembranosus|semitendinosus|adductor magnus/.test(n))).toBe(true)
      expect(names(byName('Left median nerve')).some((n) => /flexor/.test(n))).toBe(true)
    })

    it('places imported concepts in the isa tree along the FMA is-a chain', () => {
      const isa = new Map(data.trees.isa.map((c) => [c.id, c]))
      const up = (id: string): string[] => {
        const c = isa.get(id)
        return c ? [c.name, ...(c.parent ? up(c.parent) : [])] : []
      }
      expect(up(byName('Right median nerve').fma).slice(0, 3)).toEqual(['right median nerve', 'median nerve', 'peripheral nerve'])
      expect(up(byName('Left fascia lata').fma).slice(0, 2)).toEqual(['left fascia lata', 'fascia lata'])
      expect(up(byName('Thyroid gland').fma)).toEqual(expect.arrayContaining(['thyroid gland', 'lobular organ', 'organ']))
      expect(up(byName('Left deep popliteal nodes').fma)).toEqual(expect.arrayContaining(['deep popliteal lymph node group', 'lymph node group']))
      const synthetic = za.filter((p) => p.fma.startsWith('ZAC_'))
      expect(synthetic.length).toBeGreaterThan(0)
      for (const p of synthetic) {
        const chain = up(p.fma)
        expect(chain.length, p.name).toBeGreaterThan(1)
        expect(chain[chain.length - 1], p.name).toBe('anatomical entity')
      }
    })
  })

  // ── 补缺一轮：膝、关节囊、淋巴结、脊髓、推导的薄壳 / gap-fill round: knee, joint capsules, lymph nodes, spinal cord, derived shells ────────────
  describe.skipIf(!present || !data.parts.some((p) => p.id.startsWith('SOMA_')))('gap-fill structures', () => {
    const report = present ? (JSON.parse(readFileSync(join(DIR, 'pipeline-report.json'), 'utf8')) as Record<string, any>) : {}
    const names = (p: Part) => p.adjacent.map((id) => byId.get(id)!.name)

    it('has menisci and cruciate ligaments inside the knee, on the tibial plateau', () => {
      for (const [S, sign] of [['Left', 1], ['Right', -1]] as const) {
        const femur = byName(`${S} femur`)
        const tibia = byName(`${S} tibia`)
        const plateau = tibia.bbox[4]
        for (const n of ['lateral meniscus', 'medial meniscus']) {
          const m = byName(`${S} ${n}`)
          expect(m).toMatchObject({ system: 'skeletal', tissue: 'cartilage', source: 'Open3DModel', provenance: 'curated' })
          // 位于两骨之间：距胫骨顶端 2.5 cm 以内，在股骨髁主体之下
          // between the bones: within 2.5 cm of the top of the tibia, below the femoral condyles' bulk
          expect(Math.abs(m.centroid[1] - plateau), `${S} ${n} height`).toBeLessThan(0.025)
          expect(m.centroid[1]).toBeLessThan(femur.centroid[1])
          expect(names(m)).toEqual(expect.arrayContaining([`${S} tibia`, `${S} femur`]))
        }
        // 外侧半月板在膝的外侧，内侧半月板在膝的内侧
        // lateral meniscus on the outer side of the knee, medial on the inner
        expect(byName(`${S} lateral meniscus`).centroid[0] * sign).toBeGreaterThan(byName(`${S} medial meniscus`).centroid[0] * sign)
        for (const n of ['anterior cruciate ligament', 'posterior cruciate ligament']) {
          const l = byName(`${S} ${n}`)
          expect(l).toMatchObject({ system: 'skeletal', tissue: 'ligament', source: 'Open3DModel' })
          expect(names(l)).toEqual(expect.arrayContaining([`${S} tibia`, `${S} femur`]))
          expect(l.centroid[0]).toBeGreaterThan(Math.min(femur.bbox[0], tibia.bbox[0]))
          expect(l.centroid[0]).toBeLessThan(Math.max(femur.bbox[3], tibia.bbox[3]))
        }
        // 前交叉韧带（ACL）在胫骨上的附着点比后交叉韧带（PCL）更靠前
        // the ACL attaches further forward on the tibia than the PCL
        expect(byName(`${S} anterior cruciate ligament`).bbox[5]).toBeGreaterThan(byName(`${S} posterior cruciate ligament`).bbox[5] - 0.02)
        expect(names(byName(`${S} articular capsule of knee joint`))).toEqual(expect.arrayContaining([`${S} femur`, `${S} tibia`]))
      }
      const rows = report.zAnatomy.jointRefits as { name: string; shipped: boolean; after: { inBone: number }; ends: { gapMm: number }[] }[]
      const knee = rows.filter((r) => /menisc|cruciate/.test(r.name))
      expect(knee.length).toBeGreaterThanOrEqual(20)
      for (const r of knee) {
        expect(r.shipped, r.name).toBe(true)
        expect(r.after.inBone, r.name).toBeLessThan(0.25)
        for (const e of r.ends) expect(e.gapMm, r.name).toBeLessThan(1.5)
      }
      expect(rows.filter((r) => r.shipped).length / rows.length).toBeGreaterThan(0.9)
    })

    it('has joint capsules that reach both bones of their joint', () => {
      for (const [n, bones] of [['articular capsule of hip joint', ['femur', 'hip bone']], ['articular capsule of glenohumeral joint', ['humerus', 'scapula']], ['articular capsule of elbow joint', ['humerus', 'ulna']], ['articular capsule of ankle joint', ['tibia', 'talus']]] as const) {
        for (const S of ['Left', 'Right']) expect(names(byName(`${S} ${n}`)), `${S} ${n}`).toEqual(expect.arrayContaining(bones.map((b) => `${S} ${b}`)))
      }
    })

    it('has the spinal cord in the vertebral canal with the roots meeting it', () => {
      const cord = byName('Spinal cord')
      expect(cord).toMatchObject({ system: 'nervous', tissue: 'brain', side: 'M', fma: 'FMA7647' })
      expect(report.spinalCord.surfaceInBone).toBeLessThan(0.01)
      expect(report.spinalCord.roots).toBeGreaterThan(60)
      expect(report.spinalCord.rootGapMedianMm).toBeLessThan(1.5)
      expect(report.spinalCord.rootGapMaxMm).toBeLessThan(4)
      const c7 = byName('Seventh cervical vertebra')
      const t6 = byName('Sixth thoracic vertebra')
      for (const v of [c7, t6]) {
        expect(cord.bbox[1]).toBeLessThan(v.centroid[1])
        expect(cord.bbox[4]).toBeGreaterThan(v.centroid[1])
        expect(Math.abs(v.centroid[0])).toBeLessThan(0.01)
      }
      // 止于 L2/L3（示意性的），位于椎体后方
      // ends at L2/L3 (schematic), behind the vertebral bodies
      expect(cord.bbox[1]).toBeGreaterThan(byName('Fourth lumbar vertebra').centroid[1])
      expect(Math.abs(cord.centroid[0])).toBeLessThan(0.006)
      expect(byName('Spinal dura').tissue).toBe('fascia')
    })

    it('has a derived subcutaneous fat layer between the skin and the muscles', () => {
      const fat = data.parts.filter((p) => /^SOMA_fat_/.test(p.id))
      expect(fat.map((p) => p.id).sort()).toEqual(['head', 'lower_limb_L', 'lower_limb_R', 'neck', 'trunk', 'upper_limb_L', 'upper_limb_R'].map((r) => `SOMA_fat_${r}`))
      const skin = byName('Skin')
      for (const p of fat) {
        expect(p.tissue).toBe('fat')
        expect(p.system).toBe('integumentary')
        expect(p.provenance).toBe('curated')
        expect(p.source).toBe('soma (derived)')
        expect(layerOf(p)).toBe('fat')
        // 与皮肤一样不参与邻接 / like the skin, never in the adjacency
        expect(p.adjacent, p.id).toEqual([])
        for (let k = 0; k < 3; k++) {
          expect(p.bbox[k]!, p.id).toBeGreaterThanOrEqual(skin.bbox[k]! - 1e-4)
          expect(p.bbox[k + 3]!, p.id).toBeLessThanOrEqual(skin.bbox[k + 3]! + 1e-4)
        }
      }
      // 左右对称，躯干最多 / left and right agree, the trunk holds the most
      const vol = (id: string) => report.fat.regions.find((r: { id: string }) => r.id === id).volumeMl as number
      expect(Math.abs(vol('SOMA_fat_lower_limb_L') - vol('SOMA_fat_lower_limb_R')) / vol('SOMA_fat_lower_limb_L')).toBeLessThan(0.1)
      expect(Math.abs(vol('SOMA_fat_upper_limb_L') - vol('SOMA_fat_upper_limb_R')) / vol('SOMA_fat_upper_limb_L')).toBeLessThan(0.1)
      expect(vol('SOMA_fat_trunk')).toBeGreaterThan(vol('SOMA_fat_lower_limb_L'))
      // 总量在合理范围：体内体积的 10%–30% / total within a plausible range: 10–30% of the volume inside the skin
      expect(report.fat.fatVolumeL / report.fat.bodyVolumeL).toBeGreaterThan(0.1)
      expect(report.fat.fatVolumeL / report.fat.bodyVolumeL).toBeLessThan(0.3)
      expect(skin.depth).toBeLessThan(fat[0]!.depth)
      expect(fat[0]!.depth).toBeLessThan(byName('Left fascia lata').depth)
      expect(data.cautions!.some((c) => /subcutaneous fat/i.test(c.en) && /皮下脂肪/.test(c.zh))).toBe(true)
    })

    it('has derived pleura and pericardium round our own lungs and heart', () => {
      for (const [id, covered] of [['SOMA_visceral_pleura_L', /lobe of left lung/], ['SOMA_visceral_pleura_R', /lobe of right lung|^Middle lobe of lung$/], ['SOMA_pericardium', /^Wall of /]] as const) {
        const shell = byId.get(id)!
        expect(shell).toMatchObject({ provenance: 'curated', source: 'soma (derived)', tissue: 'fascia' })
        for (const p of data.parts.filter((q) => covered.test(q.name))) {
          for (let k = 0; k < 3; k++) {
            expect(shell.bbox[k]!, `${shell.name} around ${p.name}`).toBeLessThan(p.bbox[k]! + 0.002)
            expect(shell.bbox[k + 3]!, `${shell.name} around ${p.name}`).toBeGreaterThan(p.bbox[k + 3]! - 0.002)
          }
        }
      }
      for (const r of report.derived as { name: string; contentInside: number; surfaceInBone: number }[]) {
        expect(r.contentInside, r.name).toBeGreaterThan(0.97)
        expect(r.surfaceInBone, r.name).toBeLessThan(0.12)
      }
      expect(data.sources.some((s) => s.name === 'soma (derived)')).toBe(true)
      expect(data.cautions!.map((c) => c.en).join(' ')).toMatch(/envelopes computed/)
    })

    it('has the parotid glands, nails and rescued lymph nodes', () => {
      const parotid = byName('Left parotid gland')
      expect(parotid).toMatchObject({ system: 'digestive', tissue: 'gland', side: 'L' })
      const mandible = byName('Mandible')
      expect(parotid.centroid[0]).toBeGreaterThan(0.04)
      expect(Math.abs(parotid.centroid[1] - mandible.centroid[1])).toBeLessThan(0.05)
      expect(byName('Left nail plate').system).toBe('integumentary')
      const moved = report.zAnatomy.lymphMoved as { name: string; movedMm: number | null; insideAfter: number | null }[]
      expect(moved.filter((m) => m.movedMm !== null).length).toBeGreaterThanOrEqual(20)
      for (const m of moved.filter((x) => x.movedMm !== null)) {
        expect(m.movedMm!, m.name).toBeLessThanOrEqual(30)
        expect(m.insideAfter!, m.name).toBeLessThanOrEqual(0.1)
        expect(data.parts.some((p) => p.name === m.name), m.name).toBe(true)
      }
      expect(byName('Left anterior tibial node').system).toBe('lymphatic')
    })
  })
})
