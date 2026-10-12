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

const ROOT = join(import.meta.dirname, '..', '..')
const CURATED = ['muscles.json', 'aus.json', 'pain.json', 'sources.json'] as const
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

export function readCurated(inputs?: Record<string, string>): Curated {
  const read = (name: (typeof CURATED)[number]): unknown => {
    const b = new Uint8Array(readFileSync(join(ROOT, 'data', 'curated', 'face', name)))
    if (inputs) inputs[`data/curated/face/${name}`] = sha(b)
    return JSON.parse(new TextDecoder().decode(b))
  }
  return { muscles: read('muscles.json'), aus: read('aus.json'), pain: read('pain.json'), sources: read('sources.json') } as Curated
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
  const { face, bin, report } = buildFace(body, rig, curated, log)
  face.inputs = Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : 1)))
  writeFileSync(join(dir, 'face.json'), JSON.stringify(face))
  writeFileSync(join(dir, 'face.bin'), bin)
  log(`face.json: ${face.channels.length} channels, ${face.aus.length} AUs, ${face.parts.length} parts, ${report.entries} entries; face.bin ${(bin.length / 1e6).toFixed(2)} MB; bounds ${(face.bounds.channel * 1000).toFixed(1)} / ${(face.bounds.total * 1000).toFixed(1)} mm`)
  log(`skin: ${report.skin.vertices} vertices, ${report.skin.faceVertices} in the face, mean edge ${report.skin.faceMeanEdgeMm} mm`)
  for (const u of report.unmatched) log(`NOT BUILT ${u.id}: ${u.why}`)
  const outDir = join(import.meta.dirname, 'out', bodyId)
  mkdirSync(outDir, { recursive: true })
  let renders: string[] = []
  if (!args.includes('--no-renders')) {
    const rigBin = new Uint8Array(readFileSync(join(dir, 'rig.bin')))
    renders = renderAll(scene(body, rig, rigBin, face, bin), outDir, log).map((f) => f.slice(ROOT.length + 1))
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ ...report, renders }, null, 1))
  log('done')
}
