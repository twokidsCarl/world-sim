// 入口：bun tools/face/run.ts [male|female] [--no-renders]
// Entry point: bun tools/face/run.ts [male|female] [--no-renders]
//
// 读取 public/anatomy/<body>/ 里当前的数据（anatomy.json、各系统 GLB、rig.json）和
// data/curated/face/ 里的精编参数，写出：
//   public/anatomy/<body>/face.json   FaceData（通道、AU、疼痛映射、出处、注意事项）
//   public/anatomy/<body>/face.bin    逐顶点位移
//   tools/face/out/<body>/report.json 构建报告（不入库）
//   tools/face/out/<body>/*.png       离线渲染（不入库）
// Reads whatever is currently in public/anatomy/<body>/ (anatomy.json, the GLBs, rig.json) and the
// curated parameters in data/curated/face/, and writes the files above. face.json records a hash
// of every input, so a face built from older geometry can be detected (see stale()).
//
// 这是疼痛行为的计算模型，用于教学；模拟人并没有主观感受。
// This is a computational model of pain behaviour for teaching; the simulated body has no subjective experience.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rig } from '../../src/anatomy/types.ts'
import type { FaceData } from '../../src/face/types.ts'
import { readBody } from '../rig/io.ts'
import { type Curated, buildFace } from './build.ts'
import { renderAll, scene } from './renders.ts'
import { decodeAtlas, layerWeights, readUv } from './detail.ts'
import { type WrinklesCurated, buildDetail } from './detailBuild.ts'
import { renderSkinDetailed } from './detailRender.ts'
import { AU_MAX, painAUs } from './model.ts'
import { sheet } from '../rig/render.ts'
import { loadOpenings } from './openings.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const CURATED = ['muscles.json', 'aus.json', 'pain.json', 'emotions.json', 'visemes.json', 'sources.json'] as const
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 16)

/** face.json 所记录的输入是否与磁盘上的当前文件一致。 Whether the inputs recorded in face.json still match the files on disk. */
export function stale(bodyDir: string): string[] {
  const path = join(bodyDir, 'face.json')
  if (!existsSync(path)) return ['face.json is missing']
  const rec = (JSON.parse(readFileSync(path, 'utf8')) as FaceData).inputs
  const out: string[] = []
  for (const [name, hash] of Object.entries(rec)) {
    const p = name.startsWith('data/') ? join(ROOT, name) : join(bodyDir, name)
    if (!existsSync(p)) out.push(`${name}: missing`)
    else if (sha(new Uint8Array(readFileSync(p))) !== hash) out.push(`${name}: changed`)
  }
  return out
}

/** face/detail.json 所记录的输入是否与磁盘上的当前文件一致。 Whether the inputs recorded in face/detail.json still match the files on disk. */
export function staleDetail(bodyDir: string): string[] {
  const path = join(bodyDir, 'face', 'detail.json')
  if (!existsSync(path)) return ['face/detail.json is missing']
  const rec = (JSON.parse(readFileSync(path, 'utf8')) as { inputs: Record<string, string> }).inputs
  const out: string[] = []
  for (const [name, hash] of Object.entries(rec)) {
    const p = name.startsWith('data/') ? join(ROOT, name) : join(bodyDir, name)
    if (!existsSync(p)) out.push(`${name}: missing`)
    else if (sha(new Uint8Array(readFileSync(p))) !== hash) out.push(`${name}: changed`)
  }
  return out
}

export function readCurated(inputs?: Record<string, string>): Curated {
  const read = (name: (typeof CURATED)[number]): unknown => {
    const b = new Uint8Array(readFileSync(join(ROOT, 'data', 'curated', 'face', name)))
    if (inputs) inputs[`data/curated/face/${name}`] = sha(b)
    return JSON.parse(new TextDecoder().decode(b))
  }
  return { muscles: read('muscles.json'), aus: read('aus.json'), pain: read('pain.json'), emotions: read('emotions.json'), visemes: read('visemes.json'), sources: read('sources.json') } as Curated
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const bodyId = args.find((a) => !a.startsWith('--')) ?? 'male'
  const dir = join(ROOT, 'public', 'anatomy', bodyId)
  const t0 = performance.now()
  const log = (m: string): void => console.log(`[face ${bodyId} ${((performance.now() - t0) / 1000).toFixed(1)}s] ${m}`)
  const body = await readBody(dir)
  log(`read ${body.data.parts.length} parts`)
  const rigBytes = new Uint8Array(readFileSync(join(dir, 'rig.json')))
  const rig = JSON.parse(new TextDecoder().decode(rigBytes)) as Rig
  // 位移场只依赖几何和 rig.json 里的颞下颌关节；知识层和神经中心线不是输入
  // the fields depend only on the geometry and the temporomandibular joint in rig.json; the knowledge layer and nerve centrelines are not inputs
  const inputs: Record<string, string> = {}
  for (const [k, v] of Object.entries(body.inputs)) if (k === 'anatomy.json' || k.endsWith('.glb')) inputs[k] = v
  inputs['rig.json'] = sha(rigBytes)
  // rig.bin 不影响位移场，但渲染和运行时的结果（下颌、唇的蒙皮）取决于它，所以也记下来
  // rig.bin does not affect the fields, but the renders and the runtime result (skinning of jaw and lips) depend on it, so it is recorded too
  if (existsSync(join(dir, 'rig.bin'))) inputs['rig.bin'] = sha(new Uint8Array(readFileSync(join(dir, 'rig.bin'))))
  const curated = readCurated(inputs)
  // 皮肤的开口（有的话）。来自皮肤包时写回 face/openings.json；输入里记下索引旁车文件和开口文件的哈希
  // the skin's openings, when it has them. Written back to face/openings.json when converted from the package; the index sidecar and the openings file are recorded as inputs
  const skinGuess = body.data.parts.filter((p) => p.tissue === 'skin' && p.system === 'integumentary' && body.meshes.has(p.id)).sort((a, b) => b.triangles - a.triangles || (a.id < b.id ? -1 : 1))[0]!
  const loaded = loadOpenings(ROOT, dir, bodyId, skinGuess.id, body.meshes.get(skinGuess.id)!.positions.length / 3)
  mkdirSync(join(dir, 'face'), { recursive: true })
  if (loaded) {
    const text = JSON.stringify(loaded.openings)
    if (loaded.fromPackage) writeFileSync(join(dir, 'face', 'openings.json'), text)
    inputs['skin-source.u32'] = sha(new Uint8Array(readFileSync(join(dir, 'skin-source.u32'))))
    inputs['face/openings.json'] = sha(new TextEncoder().encode(text))
    log(`openings: ${loaded.fromPackage ? 'converted from the skin package' : 'read from face/openings.json'}; lip margins ${loaded.openings.margins.upperLip.length} / ${loaded.openings.margins.lowerLip.length}, pouch ${loaded.openings.oralPouch.upper.length * 2 + loaded.openings.oralPouch.seam.length}, rims ${loaded.openings.lidRims.map((r) => r.vertices.length).join(' + ')}`)
  } else log('no openings: the skin is closed; lips and lids are split by the measured crease and fissure')
  const rigBinBytes = existsSync(join(dir, 'rig.bin')) ? new Uint8Array(readFileSync(join(dir, 'rig.bin'))) : null
  const { face, bin, report } = buildFace(body, rig, curated, log, { openings: loaded?.openings ?? null, rigBin: rigBinBytes })
  face.inputs = Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : 1)))
  writeFileSync(join(dir, 'face.json'), JSON.stringify(face))
  writeFileSync(join(dir, 'face.bin'), bin)
  log(`face.json: ${face.channels.length} channels, ${face.aus.length} AUs, ${face.parts.length} parts, ${report.entries} entries; face.bin ${(bin.length / 1e6).toFixed(2)} MB; bounds ${(face.bounds.channel * 1000).toFixed(1)} / ${(face.bounds.total * 1000).toFixed(1)} mm`)
  log(`skin: ${report.skin.vertices} vertices, ${report.skin.faceVertices} in the face, mean edge ${report.skin.faceMeanEdgeMm} mm`)
  for (const u of report.unmatched) log(`NOT BUILT ${u.id}: ${u.why}`)
  // —— 皱纹细节层 / the wrinkle detail layer ——
  const wrBytes = new Uint8Array(readFileSync(join(ROOT, 'data', 'curated', 'face', 'wrinkles.json')))
  const wrinkles = JSON.parse(new TextDecoder().decode(wrBytes)) as WrinklesCurated
  const built = buildDetail(body, face, bin, wrinkles, loaded?.openings ?? null)
  built.detail.inputs = { 'face.bin': sha(bin), 'face.json': sha(new Uint8Array(readFileSync(join(dir, 'face.json')))), 'data/curated/face/wrinkles.json': sha(wrBytes) }
  const detailDir = join(dir, 'face')
  mkdirSync(detailDir, { recursive: true })
  writeFileSync(join(detailDir, 'detail.json'), JSON.stringify(built.detail))
  writeFileSync(join(detailDir, 'uv.bin'), built.uvBin)
  writeFileSync(join(detailDir, 'wrinkles.png'), built.atlas)
  const st = built.detail.uv.stretch
  log(`detail: ${built.detail.uv.count} UV vertices, texel ${(built.detail.uv.texel * 1000).toFixed(2)} mm, stretch p05 ${st.p05} median ${st.median} p95 ${st.p95}, flipped ${(st.flipped * 100).toFixed(1)}%; atlas ${built.detail.atlas.width}×${built.detail.atlas.height}, ${(built.atlas.length / 1e6).toFixed(2)} MB; ${built.detail.layers.map((l) => `${l.id} ${l.wrinkles}`).join(', ')}`)
  for (const k of built.skipped) log(`WRINKLE NOT DRAWN ${k}`)
  const outDir = join(import.meta.dirname, 'out', bodyId)
  mkdirSync(outDir, { recursive: true })
  let renders: string[] = []
  if (!args.includes('--no-renders')) {
    const rigBin = new Uint8Array(readFileSync(join(dir, 'rig.bin')))
    const sc = scene(body, rig, rigBin, face, bin, loaded?.openings ?? null)
    const all = args.includes('--detail-only') ? [] : renderAll(sc, outDir, log)
    // 带皱纹细节的皮肤图：经由发布的文件（uv.bin、wrinkles.png）解码后合成，与运行时走同一条路
    // skin renders with the wrinkle detail, composited from the published files (uv.bin, wrinkles.png) decoded as the runtime would
    const uv = readUv(built.detail, built.uvBin), layers = decodeAtlas(built.detail, built.atlas)
    const weightsOf = (aus: Record<string, number>): number[] => layerWeights(built.detail, aus)
    const save = (images: ReturnType<typeof renderSkinDetailed>, cols: number, name: string): void => {
      const f = join(outDir, name)
      sheet(images, cols).save(f)
      all.push(f)
    }
    for (const au of face.aus) {
      // 列：静止、强度 3、强度 5；上排正面，下排斜侧 / columns: rest, intensity 3, intensity 5; front above, three-quarter below
      const cols = [0, 3, AU_MAX].map((i) => renderSkinDetailed(sc, uv, layers, weightsOf, i ? { [au.id]: i } : {}, 620))
      save([...cols.map((c) => c[0]!), ...cols.map((c) => c[1]!)], 3, `detail-${au.id}.png`)
    }
    const lv = [0, 2, 4, 6, 8, 10].map((l) => renderSkinDetailed(sc, uv, layers, weightsOf, painAUs(face.pain, l), 640))
    save(lv.map((x) => x[0]!), 3, 'detail-pain-front.png')
    save(lv.map((x) => x[1]!), 3, 'detail-pain-oblique.png')
    // 肌肉视图：每个 AU 的静止、强度 3、强度 5 / muscle view: rest, intensity 3 and intensity 5 of every AU
    if (!args.includes('--detail-only')) {
      const { renderExpression } = await import('./renders.ts')
      for (const au of face.aus) {
        const cols = [0, 3, AU_MAX].map((i) => renderExpression(sc, i ? { [au.id]: i } : {}, { size: 520 }))
        save([...cols.map((c) => c[2]!), ...cols.map((c) => c[3]!)], 3, `muscle-${au.id}.png`)
      }
    }
    // 特写：眼（AU43、AU7）和口（AU25–27、AU10）/ close-ups: the eye (AU43, AU7) and the mouth (AU25–27, AU10)
    const eye = face.landmarks.eyes[0]
    if (eye) {
      const zoom = { center: [eye.globe[0], eye.globe[1], eye.globe[2]] as [number, number, number], halfHeight: 0.024, yaws: [0, 55] as [number, number] }
      const sets: Record<string, number>[] = [{}, { AU43: 1.5 }, { AU43: 3 }, { AU43: AU_MAX }, { AU7: AU_MAX }, { AU6: AU_MAX }]
      const im = sets.map((a) => renderSkinDetailed(sc, uv, layers, weightsOf, a, 460, zoom))
      save([...im.map((x) => x[0]!), ...im.map((x) => x[1]!)], sets.length, 'closeup-eye.png')
    }
    {
      const zoom = { center: [face.landmarks.midX, face.landmarks.stomionY.skin - 0.012, 0.1] as [number, number, number], halfHeight: 0.05, yaws: [0, 45] as [number, number] }
      const sets: Record<string, number>[] = [{}, { AU25: AU_MAX }, { AU26: AU_MAX }, { AU27: AU_MAX }, { AU10: AU_MAX }, { AU12: AU_MAX }, { AU20: AU_MAX }]
      const im = sets.map((a) => renderSkinDetailed(sc, uv, layers, weightsOf, a, 460, zoom))
      save([...im.map((x) => x[0]!), ...im.map((x) => x[1]!)], sets.length, 'closeup-mouth.png')
    }
    // 表情原型：上排皮肤正面，下排肌肉正面；第一列静止 / expression prototypes: skin front view above, muscle front view below; rest in the first column
    if (face.expressions?.length) {
      const { renderExpression } = await import('./renders.ts')
      const { expressionAUs } = await import('./model.ts')
      const sets: Record<string, number>[] = [{}, ...face.expressions.map((e) => expressionAUs(face.expressions, e.id, 1))]
      const skinIm = sets.map((a) => renderSkinDetailed(sc, uv, layers, weightsOf, a, 520))
      const deepIm = sets.map((a) => renderExpression(sc, a, { size: 520 }))
      save([...skinIm.map((x) => x[0]!), ...skinIm.map((x) => x[1]!)], sets.length, 'emotions-skin.png')
      save(deepIm.map((x) => x[2]!), sets.length, 'emotions-muscle.png')
    }
    log(`detail renders written`)
    renders = all.map((f) => f.slice(ROOT.length + 1))
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ ...report, detail: { uv: built.detail.uv, atlas: built.detail.atlas, skipped: built.skipped }, renders }, null, 1))
  log('done')
}
