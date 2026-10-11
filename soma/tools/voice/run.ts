// 入口：bun tools/voice/run.ts [--no-fit] [--no-examples]
// 1. 本机有 VIVAE 语料（data/raw/voice/，不入库）时重新分析，写出 data/curated/voice/calibration.json；
//    没有时沿用已入库的那一份。
// 2. 对校准目标拟合控制层的映射，写出 src/voice/fitted.ts（--no-fit 跳过）。
// 3. 打印并保存「目标 vs 合成」对照表（tools/voice/out/report.json、report.txt，不入库）。
// 4. 渲染试听材料到 tools/voice/out/（--no-examples 跳过）。
// Entry point: bun tools/voice/run.ts [--no-fit] [--no-examples]
// 1. Re-analyse the VIVAE corpus when it is present locally (data/raw/voice/, not committed) and write
//    data/curated/voice/calibration.json; otherwise reuse the committed file.
// 2. Fit the control mapping to the calibration targets and write src/voice/fitted.ts (skip with --no-fit).
// 3. Print and save the target-versus-synthesis table (tools/voice/out/report.json and report.txt, not committed).
// 4. Render the listening material into tools/voice/out/ (skip with --no-examples).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_ANALYSIS } from './analysis.ts'
import { analyseCorpus, buildCalibration, CALIBRATION_PATH, corpusPresent, LEVELS, loadCalibration, ROOT, summarise } from './corpus.ts'
import { compare, fit, formatTable, knotsSource, SAMPLE_RATE, synthMeasures } from './fit.ts'

const t0 = performance.now()
const args = new Set(process.argv.slice(2))
const out = join(ROOT, 'tools/voice/out')
mkdirSync(out, { recursive: true })

let calibration
if (corpusPresent()) {
  calibration = buildCalibration(analyseCorpus())
  mkdirSync(dirname(CALIBRATION_PATH), { recursive: true })
  writeFileSync(CALIBRATION_PATH, JSON.stringify(calibration, null, 1) + '\n')
  console.log(`corpus analysed: ${LEVELS.map((lv) => `${lv} n=${calibration!.vivae.levels[lv].n}`).join(', ')} -> data/curated/voice/calibration.json`)
} else {
  calibration = loadCalibration()
  console.log('corpus not present under data/raw/voice/; using the committed calibration.json')
}
const same = JSON.stringify(calibration.analysisOptions) === JSON.stringify(DEFAULT_ANALYSIS)
if (!same) throw new Error('calibration.json was made with other analysis settings; download the corpus and re-run')

const targets = calibration.vivae.levels
if (!args.has('--no-fit')) {
  const knots = fit(targets, undefined, undefined, (s) => console.log(s))
  writeFileSync(join(ROOT, 'src/voice/fitted.ts'), knotsSource(knots))
  console.log('wrote src/voice/fitted.ts')
}
// 重新读入刚写出的结点（动态导入，避免用到启动时的旧值）
// load the knots just written (a dynamic import, so the values from start-up are not used)
const { FITTED } = (await import(`../../src/voice/fitted.ts?t=${Date.now()}`)) as typeof import('../../src/voice/fitted.ts')

const rows = compare(targets, FITTED)
const table = formatTable(rows)
console.log('\nfemale, sudden onset, against VIVAE pain (per level: p25 / p50 / p75 (mean))')
console.log(table)
const missed = rows.filter((r) => !r.match)
console.log(`\n${rows.length - missed.length}/${rows.length} cells match; not matching: ${missed.map((r) => `${r.key}@${r.level}`).join(', ') || 'none'}`)

// 没有校准数据的两种情况也测一遍，只作记录：男声、持续性。
// The two uncalibrated cases are measured as well, for the record only: male voice and sustained onset.
const side: Record<string, unknown> = {}
const sideLines: string[] = []
for (const [label, sex, onset] of [['male sudden', 'male', 'sudden'], ['female sustained', 'female', 'sustained'], ['male sustained', 'male', 'sustained']] as const) {
  for (const intensity of [3, 6.5, 10]) {
    const s = summarise(synthMeasures(FITTED, intensity, 200, 700000, sex, onset))
    side[`${label} @ ${intensity}`] = { f0MeanHz: s.f0MeanHz, durationS: s.durationS, levelDb: s.levelDb, hnrDb: s.hnrDb, nonlinearShare: s.nonlinearShare }
    sideLines.push(`${label.padEnd(17)} I=${String(intensity).padEnd(4)} F0 mean ${s.f0MeanHz.mean.toFixed(0)} Hz (p50 ${s.f0MeanHz.p50.toFixed(0)}), duration mean ${s.durationS.mean.toFixed(2)} s, level p50 ${s.levelDb.p50.toFixed(1)} dBFS, HNR mean ${s.hnrDb.mean.toFixed(1)} dB, nonlinear mean ${(s.nonlinearShare.mean * 100).toFixed(0)} %`)
  }
}
console.log('\nuncalibrated cases (our analysis; Raine levels mild/moderate/severe placed at 3/6.5/10):')
console.log(sideLines.join('\n'))
writeFileSync(join(out, 'report.json'), JSON.stringify({ knots: FITTED, rows, side }, null, 1))
writeFileSync(join(out, 'report.txt'), `${table}\n\n${sideLines.join('\n')}\n`)

if (!args.has('--no-examples')) {
  const { writeExamples } = await import('./examples.ts')
  const examples = writeExamples(out)
  console.log(`\nwrote ${examples.length} examples (WAV + PNG), 4 overview sheets and index.html to tools/voice/out/`)
}

// 合成的计算开销 / CPU cost of synthesis
{
  const { painVocalisation } = await import('../../src/voice/control.ts')
  const { renderVocalisation } = await import('../../src/voice/synth.ts')
  let audio = 0
  const t = performance.now()
  for (let s = 0; s < 200; s++) {
    const v = painVocalisation({ intensity: 2 + (s % 9), onset: s % 2 ? 'sudden' : 'sustained', sex: s % 3 ? 'female' : 'male', seed: s, vocalise: 'always' })
    audio += renderVocalisation(v.params!, SAMPLE_RATE).pcm.length / SAMPLE_RATE
  }
  const ms = performance.now() - t
  console.log(`synthesis cost: ${(ms / audio).toFixed(1)} ms of CPU per second of audio at ${SAMPLE_RATE} Hz (${audio.toFixed(0)} s rendered)`)
}
console.log(`done in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
