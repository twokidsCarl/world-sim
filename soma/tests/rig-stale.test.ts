// 报告里记录的输入哈希：只反映绑定真正依赖的内容（tools/rig/io.ts 的 hashInput）。
// The input hashes recorded in the reports reflect only what the rig depends on (hashInput in tools/rig/io.ts).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hashInput, inputFile } from '../tools/rig/io.ts'
import { stale } from '../tools/rig/run.ts'
import { shapeStale } from '../tools/rig/shape-build.ts'

const root = mkdtempSync(join(tmpdir(), 'rig-stale-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** 一个最小的人体目录：anatomy.json、一个“GLB”、nerves.json 和同级的 knowledge/relations.json。 A minimal body directory: anatomy.json, one "GLB", nerves.json and the sibling knowledge/relations.json. */
function makeBody(name: string): { dir: string; anatomy: Record<string, unknown>; write: () => void } {
  const dir = join(root, name, 'male')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(root, name, 'knowledge'), { recursive: true })
  const anatomy: Record<string, unknown> = {
    schema: 1, body: 'male',
    cautions: [{ zh: '本模型未经解剖学专家审校。', en: 'No anatomist has reviewed this model.' }],
    sources: [{ name: 'BodyParts3D 4.0', url: 'https://example.org', license: 'CC BY 4.0', attribution: 'x' }],
    systems: [{ id: 'skeletal', name: { en: 'Skeletal', zh: '骨骼' }, color: '#eee', glb: 'skeletal.glb', partCount: 1 }],
    layers: [{ name: { en: 'Skin', zh: '皮肤' } }],
    parts: [{ id: 'FJ3259', fma: 'FMA24475', name: 'Left femur', system: 'skeletal', tissue: 'bone', depth: 6, side: 'L', provenance: 'scanned', bbox: [0, 0, 0, 1, 1, 1], centroid: [0.5, 0.5, 0.5], volume: 400, triangles: 12, adjacent: [] }],
    trees: { isa: [{ id: 'FMA24475', name: 'Left femur', parent: null, parts: ['FJ3259'] }], partOf: [] },
  }
  const write = (): void => writeFileSync(join(dir, 'anatomy.json'), JSON.stringify(anatomy))
  write()
  writeFileSync(join(dir, 'skeletal.glb'), new Uint8Array([103, 108, 84, 70, 1, 2, 3, 4, 5, 6, 7, 8]))
  writeFileSync(join(dir, 'nerves.json'), '[]')
  writeFileSync(join(root, name, 'knowledge', 'relations.json'), JSON.stringify([{ subject: 'FMA1', kind: 'origin', object: 'FMA24475', objectLabel: { en: 'femur' }, source: { name: 'W', url: '', license: '' }, status: 'unreviewed' }]))
  return { dir, anatomy, write }
}

function record(dir: string, file: string, keys: string[]): void {
  const inputs = Object.fromEntries(keys.map((k) => [k, hashInput(k, join(dir, inputFile(k)))]))
  writeFileSync(join(dir, file), JSON.stringify({ inputs }))
}

const KEYS = ['anatomy.json#parts', 'skeletal.glb', 'nerves.json', '../knowledge/relations.json#attachments']

describe('recorded input hashes', () => {
  it('ignore prose in anatomy.json but not what the rig reads', () => {
    const b = makeBody('a')
    record(b.dir, 'rig-report.json', KEYS)
    expect(stale(b.dir)).toEqual([])
    // 改一句注意事项、换来源说明、调整剥离层次：绑定不依赖这些
    // reword a caution, change the source note, move the peel depth: the rig depends on none of these
    ;(b.anatomy.cautions as { zh: string; en: string }[])[0]!.en = 'This model has not been reviewed by an anatomist, and more.'
    ;(b.anatomy.cautions as unknown[]).push({ zh: '新增的一条。', en: 'One more.' })
    ;(b.anatomy.sources as { attribution: string }[])[0]!.attribution = 'changed'
    ;(b.anatomy.parts as { depth: number }[])[0]!.depth = 7
    b.write()
    expect(stale(b.dir)).toEqual([])
    // 改一个部件的 id：过期 / change a part id: stale
    ;(b.anatomy.parts as { id: string }[])[0]!.id = 'FJ9999'
    b.write()
    expect(stale(b.dir)).toEqual(['anatomy.json#parts: changed'])
  })

  it('notice a changed tissue, bounding box or part order', () => {
    for (const change of [(p: Record<string, unknown>[]) => (p[0]!.tissue = 'cartilage'), (p: Record<string, unknown>[]) => ((p[0]!.bbox as number[])[3] = 1.5), (p: Record<string, unknown>[]) => p.unshift({ ...p[0]!, id: 'FJ1' })]) {
      const b = makeBody(`t${Math.random().toString(36).slice(2, 8)}`)
      record(b.dir, 'rig-report.json', KEYS)
      change(b.anatomy.parts as Record<string, unknown>[])
      b.write()
      expect(stale(b.dir)).toEqual(['anatomy.json#parts: changed'])
    }
  })

  it('notice a changed vertex: geometry files are hashed by their bytes', () => {
    const b = makeBody('g')
    record(b.dir, 'rig-report.json', KEYS)
    const glb = new Uint8Array(readFileSync(join(b.dir, 'skeletal.glb')))
    glb[8] = glb[8]! ^ 1
    writeFileSync(join(b.dir, 'skeletal.glb'), glb)
    expect(stale(b.dir)).toEqual(['skeletal.glb: changed'])
  })

  it('follow only the attachment relations of the knowledge file', () => {
    const b = makeBody('k')
    record(b.dir, 'rig-report.json', KEYS)
    const path = join(b.dir, '..', 'knowledge', 'relations.json')
    const rel = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[]
    // 其它种类的关系、标签和状态不影响绑定 / other kinds of relation, labels and review status do not touch the rig
    rel.push({ subject: 'FMA1', kind: 'innervatedBy', object: 'FMA2', objectLabel: { en: 'nerve' }, source: { name: 'W', url: '', license: '' }, status: 'unreviewed' })
    rel[0]!.status = 'reviewed'
    writeFileSync(path, JSON.stringify(rel))
    expect(stale(b.dir)).toEqual([])
    rel.push({ subject: 'FMA1', kind: 'insertion', object: 'FMA3', objectLabel: { en: 'tibia' }, source: { name: 'W', url: '', license: '' }, status: 'unreviewed' })
    writeFileSync(path, JSON.stringify(rel))
    expect(stale(b.dir)).toEqual(['../knowledge/relations.json#attachments: changed'])
  })

  it('strip explanatory keys from curated files and read only three fields of a package manifest', () => {
    const dir = join(root, 'c')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'bindings.json'), m = join(dir, 'manifest.json')
    writeFileSync(f, JSON.stringify({ _doc: { zh: '说明', en: 'doc' }, defaults: { skin: { method: 'field', beta: 0.4 } }, rules: [{ match: 'x', why: { zh: '因为', en: 'because' } }] }))
    const h = hashInput('bindings.json#data', f)
    writeFileSync(f, JSON.stringify({ _doc: { zh: '改过的说明', en: 'reworded' }, defaults: { skin: { method: 'field', beta: 0.4 } }, rules: [{ match: 'x', why: { zh: '换个说法', en: 'put differently' } }] }))
    expect(hashInput('bindings.json#data', f)).toBe(h)
    writeFileSync(f, JSON.stringify({ defaults: { skin: { method: 'field', beta: 0.5 } }, rules: [{ match: 'x' }] }))
    expect(hashInput('bindings.json#data', f)).not.toBe(h)
    writeFileSync(m, JSON.stringify({ source: { name: 'S' }, fittedTo: { body: 'male' }, statureM: 1.72, what: { en: 'a skin' } }))
    const hm = hashInput('manifest.json#package', m)
    writeFileSync(m, JSON.stringify({ source: { name: 'S', url: 'u' }, fittedTo: { body: 'male', key: 'k2' }, statureM: 1.72, what: { en: 'the same skin, described anew' } }))
    expect(hashInput('manifest.json#package', m)).toBe(hm)
    writeFileSync(m, JSON.stringify({ source: { name: 'S' }, fittedTo: { body: 'female' }, statureM: 1.72 }))
    expect(hashInput('manifest.json#package', m)).not.toBe(hm)
  })

  it('apply to the shape report in the same way', () => {
    const b = makeBody('s')
    writeFileSync(join(b.dir, 'rig.bin'), new Uint8Array([1, 2, 3]))
    record(b.dir, 'shape.report.json', [...KEYS, 'rig.bin'])
    ;(b.anatomy.cautions as { en: string }[])[0]!.en = 'reworded'
    b.write()
    expect(shapeStale(b.dir)).toEqual([])
    writeFileSync(join(b.dir, 'rig.bin'), new Uint8Array([1, 2, 4]))
    expect(shapeStale(b.dir)).toEqual(['rig.bin: changed'])
  })
})
