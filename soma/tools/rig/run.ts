// 入口：bun tools/rig/run.ts [male|female] [--no-validate] [--no-renders] [--out <目录>]
// Entry point: bun tools/rig/run.ts [male|female] [--no-validate] [--no-renders] [--out <dir>]
//
// --out <目录>：rig.json、rig.bin、rig-report.json 和渲染图都写到该目录，不动 public/anatomy/<body>/（输入仍从那里读）。
// --out <dir>: rig.json, rig.bin, rig-report.json and the renders go to that directory and
// public/anatomy/<body>/ is left alone (the inputs are still read from there).
//
// 读取 public/anatomy/<body>/ 里当前的数据，写出：
//   public/anatomy/<body>/rig.json         Rig（关节、绑定、肌肉作用线、注意事项）
//   public/anatomy/<body>/rig.bin          逐顶点关节影响
//   public/anatomy/<body>/rig-report.json  输入文件哈希、各关节拟合残差、绑定统计、验证结果
//   tools/rig/out/<body>/*.png             各标准姿势的离线渲染（不入库）
// Reads whatever is currently in public/anatomy/<body>/ and writes the files above. The report
// records a hash of every input, so a rig built from older geometry can be detected (see stale()).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { buildRig } from './build.ts'
import { hashInput, inputFile, readBody } from './io.ts'
import { validate } from './validate.ts'

const ROOT = join(import.meta.dirname, '..', '..')

/**
 * rig-report.json 所记录的输入是否与磁盘上的当前文件一致。reportDir：报告所在目录（用 --out 构建到别处时），缺省即 bodyDir。
 * Whether the inputs recorded in rig-report.json still match the files on disk. `reportDir`: where the
 * report is (for a rig built elsewhere with --out); the body directory by default.
 */
export function stale(bodyDir: string, reportDir: string = bodyDir): string[] {
  const reportPath = join(reportDir, 'rig-report.json')
  if (!existsSync(reportPath)) return ['rig-report.json is missing']
  const rec = (JSON.parse(readFileSync(reportPath, 'utf8')) as { inputs: Record<string, string> }).inputs
  const out: string[] = []
  for (const [name, hash] of Object.entries(rec)) {
    const file = inputFile(name)
    const path = file.startsWith('data/') ? join(ROOT, file) : join(bodyDir, file)
    if (!existsSync(path)) {
      out.push(`${name}: missing`)
      continue
    }
    if (hashInput(name, path) !== hash) out.push(`${name}: changed`)
  }
  return out
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  // --out <目录> 或 --out=<目录>（相对路径相对于当前目录）/ --out <dir> or --out=<dir> (a relative path is relative to the current directory)
  const outAt = args.findIndex((a) => a === '--out' || a.startsWith('--out='))
  const outArg = outAt < 0 ? null : args[outAt]!.includes('=') ? args[outAt]!.slice(6) : (args[outAt + 1] ?? null)
  if (outAt >= 0 && !outArg) throw new Error('rig: --out needs a directory')
  if (outAt >= 0) args.splice(outAt, args[outAt]!.includes('=') ? 1 : 2)
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
  const outDir = outArg ? resolve(outArg) : join(import.meta.dirname, 'out', generic ? `${bodyId}-field` : bodyId)
  mkdirSync(outDir, { recursive: true })
  const target = outArg || generic ? outDir : dir
  writeFileSync(join(target, 'rig.json'), JSON.stringify(build.rig))
  writeFileSync(join(target, 'rig.bin'), build.bin)
  log(`rig.json: ${build.rig.joints.length} joints, ${build.rig.bindings.length} bindings, ${build.rig.muscles.length} muscle lines; rig.bin ${(build.bin.length / 1e6).toFixed(2)} MB`)
  const validation = args.includes('--no-validate') ? null : validate(body, build, args.includes('--no-renders') ? null : outDir, log)
  // 报告里不写本机绝对路径：仓库内的写相对路径，仓库外的只写文件名
  // no absolute local path in the report: relative inside the repository, the bare file name outside it
  if (validation) validation.renders = validation.renders.map((f) => (f.startsWith(ROOT + '/') ? f.slice(ROOT.length + 1) : basename(f)))
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
      via: build.via,
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
