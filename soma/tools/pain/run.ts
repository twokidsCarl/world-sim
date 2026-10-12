// 入口：bun tools/pain/run.ts [male|female] [--side=R] [--trace=<场景 id>]
// 对两个体型（或指定的一个）运行一组参考场景，打印汇总表，并把时间序列写到 tools/pain/out/（不入库）。
// Entry point. Runs the reference scenarios for both bodies (or the one named), prints a summary
// table and writes the time series under tools/pain/out/ (not committed).
//
// 这是疼痛生理与行为的计算模型，用于教学：被模拟的身体没有主观体验。
// This is a computational model of pain physiology and behaviour for teaching: the simulated
// body has no subjective experience.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BodyId } from '../../src/anatomy/types.ts'
import { DISCLAIMER, prepareStimulus, type PainEvaluation } from '../../src/painmodel/index.ts'
import type { SideLR } from '../../src/painmodel/types.ts'
import { hasPainBody, loadPainBody, ROOT } from './load.ts'
import { SCENARIOS } from './scenarios.ts'

const args = process.argv.slice(2)
const bodies = (['male', 'female'] as BodyId[]).filter((b) => !args.some((a) => a === 'male' || a === 'female') || args.includes(b))
const side = (args.find((a) => a.startsWith('--side='))?.slice(7) === 'R' ? 'R' : 'L') as SideLR
const traceId = args.find((a) => a.startsWith('--trace='))?.slice(8)
const out = join(ROOT, 'tools/pain/out')
mkdirSync(out, { recursive: true })

const deg = (rad: number) => (rad * 180) / Math.PI
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))

/** 各体征偏离基线最大的值 / The value of each sign furthest from its baseline. */
function extremes(e: PainEvaluation) {
  const base = e.sample(-1).autonomic
  const best = { ...base }
  const t0 = e.stimulus.onset ?? 0
  for (let t = t0; t <= e.horizon; t += 0.1) {
    const a = e.sample(t).autonomic
    for (const k of Object.keys(a) as (keyof typeof a)[]) if (Math.abs(a[k] - base[k]) > Math.abs(best[k] - base[k])) best[k] = a[k]
  }
  return { base, best }
}

console.log(DISCLAIMER.zh)
console.log(DISCLAIMER.en)
let ran = 0
for (const bodyId of bodies) {
  if (!hasPainBody(bodyId)) {
    console.log(`\n${bodyId}: 数据不全，跳过 / data incomplete, skipped`)
    continue
  }
  const t0 = performance.now()
  const body = await loadPainBody(bodyId)
  console.log(`\n== ${bodyId}  (skin ${body.skin.part}, ${body.skinMaps.vertexCount} vertices, side ${side})`)
  const head = ['scenario', 'region', 'derm', 'territory', 'stimulus', 'threshold', 'drive', 'peak@s', 'path cm', 'Aδ ms', 'C s', 'reflex', 'HR', 'SBP/DBP', 'RR', 'pupil', 'SC μS']
  const rows: string[][] = [head]
  const summary: unknown[] = []
  for (const sc of SCENARIOS) {
    const stimulus = sc.build(body, side)
    const e = prepareStimulus(body, stimulus)
    const tr = e.trace
    const { best } = extremes(e)
    const reflex = e.reflex.withdraws
      ? `${(e.reflex.emgLatency! * 1000).toFixed(0)} ms ${e.reflex.targets.map((t) => `${t.joint}.${t.dof}:${deg(t.angle).toFixed(0)}°`).join(' ')}`
      : '-'
    rows.push([
      sc.id,
      tr.region.id,
      tr.dermatome?.key ?? '-',
      tr.territory?.key ?? '-',
      `${tr.magnitude.value.toFixed(1)} ${tr.magnitude.unit}`,
      `${tr.threshold.value.toFixed(1)}${tr.threshold.borrowed ? `*(${tr.threshold.site})` : ''}`,
      e.drive.toFixed(2),
      `${e.peak.intensity.toFixed(2)}@${e.peak.t.toFixed(2)}`,
      `${(tr.path.lengthM * 100).toFixed(1)}${tr.path.method === 'straight' ? ' straight' : tr.path.bridgedM > 0.02 ? ` (${(tr.path.bridgedM * 100).toFixed(0)} bridged)` : ''}`,
      (tr.latency.adelta * 1000).toFixed(0),
      tr.latency.c.toFixed(2),
      reflex,
      best.heartRate.toFixed(1),
      `${best.systolic.toFixed(0)}/${best.diastolic.toFixed(0)}`,
      best.respiratoryRate.toFixed(1),
      best.pupil.toFixed(2),
      best.skinConductance.toFixed(2),
    ])
    // 时间序列 / time series
    const lines = ['t,intensity,firstPain,secondPain,heartRate,systolic,diastolic,respiratoryRate,pupil,skinConductance,reflexPose']
    const end = Math.min(e.horizon, e.stimulusEnd + 30)
    for (let t = stimulus.onset ?? 0; t <= end + 1e-9; t += 0.05) {
      const s = e.sample(t)
      const a = s.autonomic
      const pose = Object.entries(s.reflexPose).map(([j, v]) => `${j}:${v.map((x) => deg(x).toFixed(1)).join('/')}`).join(' ')
      lines.push([t.toFixed(2), s.intensity.toFixed(3), s.firstPain.toFixed(3), s.secondPain.toFixed(3), a.heartRate.toFixed(2), a.systolic.toFixed(2), a.diastolic.toFixed(2), a.respiratoryRate.toFixed(2), a.pupil.toFixed(3), a.skinConductance.toFixed(3), pose].join(','))
    }
    writeFileSync(join(out, `${bodyId}.${sc.id}.csv`), lines.join('\n') + '\n')
    summary.push({ scenario: sc.id, name: sc.name, stimulus, drive: e.drive, peak: e.peak, output: e.output, reflex: e.reflex, trace: { ...tr, path: { ...tr.path, polyline: `${tr.path.polyline.length / 3} points` } }, mapFocusVertices: e.map.focus.vertices.length })
    if (traceId === sc.id) {
      console.log(`\n-- trace ${sc.id}`)
      for (const step of tr.steps) {
        console.log(`[${step.id}] ${step.text.zh}\n        ${step.text.en}`)
        for (const n of step.numbers) console.log(`    ${pad(n.label.en, 44)} ${Array.isArray(n.value) ? n.value.join('–') : Number(n.value.toFixed(4))} ${n.unit}  ${n.assumption ? 'ASSUMPTION' : n.sources.length ? n.sources.join(',') : 'computed'}`)
      }
      for (const c of tr.caveats) console.log(`  ! ${c.en}`)
      console.log(`  highlight: ${tr.highlightParts.length} parts; path through ${tr.path.parts.length} parts; sources: ${tr.sources.map((s) => s.id).join(', ')}`)
    }
    ran++
  }
  const widths = head.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)))
  for (const r of rows) console.log(r.map((x, c) => pad(x, widths[c]!)).join('  '))
  writeFileSync(join(out, `summary.${bodyId}.json`), JSON.stringify(summary, null, 1))
  console.log(`(${((performance.now() - t0) / 1000).toFixed(1)} s; * = 借用别处的阈值 / threshold borrowed from another site; 体征列为偏离基线最大的值 / sign columns show the value furthest from baseline)`)
}
if (ran === 0) {
  console.error('没有可运行的体型 / no body could be run')
  process.exit(1)
}
console.log(`\n时间序列和汇总在 tools/pain/out/ / time series and summaries are in tools/pain/out/`)
