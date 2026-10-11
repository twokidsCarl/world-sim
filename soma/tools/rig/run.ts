// 入口：bun tools/rig/run.ts [male|female] [--no-validate] [--no-renders]
// Entry point: bun tools/rig/run.ts [male|female] [--no-validate] [--no-renders]
//
// 读取 public/anatomy/<body>/ 里当前的数据，写出：
//   public/anatomy/<body>/rig.json         Rig（关节、绑定、肌肉作用线、注意事项）
//   public/anatomy/<body>/rig.bin          逐顶点关节影响
//   public/anatomy/<body>/rig-report.json  输入文件哈希、各关节拟合残差、绑定统计、验证结果
//   tools/rig/out/<body>/*.png             各标准姿势的离线渲染（不入库）
// Reads whatever is currently in public/anatomy/<body>/ and writes the files above. The report
// records a hash of every input, so a rig built from older geometry can be detected (see stale()).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { buildRig } from './build.ts'
import { readBody } from './io.ts'
import { validate } from './validate.ts'

const ROOT = join(import.meta.dirname, '..', '..')

/** rig-report.json 所记录的输入是否与磁盘上的当前文件一致。 Whether the inputs recorded in rig-report.json still match the files on disk. */
export function stale(bodyDir: string): string[] {
  const reportPath = join(bodyDir, 'rig-report.json')
  if (!existsSync(reportPath)) return ['rig-report.json is missing']
  const rec = (JSON.parse(readFileSync(reportPath, 'utf8')) as { inputs: Record<string, string> }).inputs
  const out: string[] = []
  for (const [name, hash] of Object.entries(rec)) {
    const path = name.startsWith('data/') ? join(ROOT, name) : join(bodyDir, name)
    if (!existsSync(path)) {
      out.push(`${name}: missing`)
      continue
    }
    const h = createHash('sha256').update(new Uint8Array(readFileSync(path))).digest('hex').slice(0, 16)
    if (h !== hash) out.push(`${name}: changed`)
  }
  return out
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const bodyId = args.find((a) => !a.startsWith('--')) ?? 'male'
  const dir = join(ROOT, 'public', 'anatomy', bodyId)
  const t0 = performance.now()
  const log = (m: string): void => console.log(`[rig ${bodyId} ${((performance.now() - t0) / 1000).toFixed(1)}s] ${m}`)
  const body = await readBody(dir)
  log(`read ${body.data.parts.length} parts`)
  // --skin=field：皮肤也按距离场绑定，不用外部权重；结果只写到 tools/rig/out/<body>-field/，不覆盖发布的文件（用于对比）
  // --skin=field: bind the skin by the distance field too, without external weights; results go to tools/rig/out/<body>-field/ only and the published files are left alone (for comparison)
  const generic = args.includes('--skin=field')
  const build = buildRig(body, log, { genericSkin: generic })
  const outDir = join(import.meta.dirname, 'out', generic ? `${bodyId}-field` : bodyId)
  mkdirSync(outDir, { recursive: true })
  const target = generic ? outDir : dir
  writeFileSync(join(target, 'rig.json'), JSON.stringify(build.rig))
  writeFileSync(join(target, 'rig.bin'), build.bin)
  log(`rig.json: ${build.rig.joints.length} joints, ${build.rig.bindings.length} bindings, ${build.rig.muscles.length} muscle lines; rig.bin ${(build.bin.length / 1e6).toFixed(2)} MB`)
  const validation = args.includes('--no-validate') ? null : validate(body, build, args.includes('--no-renders') ? null : outDir, log)
  if (validation) validation.renders = validation.renders.map((f) => f.slice(ROOT.length + 1))
  const report = {
    schema: 1,
    body: bodyId,
    inputs: build.inputs,
    binBytes: build.bin.length,
    joints: build.built.map((j) => ({ id: j.def.id, recipe: j.def.recipe, bones: j.def.bones.length, fits: j.fits, rest: j.restNotes, warnings: j.warnings })),
    field: build.fieldStats,
    bindings: build.byMethod,
    muscles: {
      parts: build.attach.filter((a) => a.tissue === 'muscle').length,
      linesEstablished: build.allLines.length,
      withLine: build.rig.muscles.length,
      ends: Object.fromEntries(['knowledge', 'knowledge+geometry', 'geometry', 'none'].map((k) => [k, build.attach.filter((a) => a.tissue === 'muscle' && a.ends === k).length])),
      knowledgeNotReached: build.attach.filter((a) => a.knowledgeMissed.length).map((a) => ({ part: a.part, name: a.name, missed: a.knowledgeMissed })),
      withoutLine: build.attach.filter((a) => a.tissue === 'muscle' && !a.line).map((a) => ({ part: a.part, name: a.name, why: a.why ?? '' })),
    },
    calibration: build.calibration,
    externalSkin: build.external,
    fieldQueries: build.field.queryStats,
    attach: build.attach,
    notes: build.notes,
    validation,
  }
  writeFileSync(join(target, 'rig-report.json'), JSON.stringify(report, null, 1))
  log('done')
}
