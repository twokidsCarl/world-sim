// 拟合：调整控制层映射的结点，使合成输出的统计分布（用同一套分析测出来）对上语料的目标。
// 每一轮在每个强度等级上合成一批发声、测量，再按差值修正各结点；全程用同一组种子，所以结果可复现。
// The fit: adjust the knots of the control mapping until the statistics of synthesized output
// (measured by the same analysis) meet the corpus targets. Each round synthesizes and measures a
// batch per intensity level and corrects the knots by the residual; the seeds are the same throughout,
// so the result is reproducible.

import { painVocalisation, type Knots } from '../../src/voice/control.ts'
import { renderVocalisation } from '../../src/voice/synth.ts'
import { measure, type Measures } from './analysis.ts'
import { LEVELS, summarise, type Calibration, type Level, type LevelStats, type StatKey } from './corpus.ts'

export const SAMPLE_RATE = 44100

// 起点：粗略的手工估计，拟合从这里出发。/ Starting point: a rough guess by hand; the fit starts here.
export const INITIAL_KNOTS: Knots = {
  intensity: [2.5, 5, 7.5, 10],
  f0Hz: [330, 380, 450, 570],
  f0SdLog: [0.3, 0.2, 0.2, 0.2],
  f0ExcursionSt: [8, 8, 10, 12],
  durationS: [0.58, 0.68, 0.89, 1.0],
  durationSdLog: [0.4, 0.35, 0.4, 0.4],
  levelDb: [-42, -38, -29, -21],
  levelSdDb: [5, 7, 9, 6],
  tiltDb: [8, 6, 3, 0],
  noiseDirect: [0.5, 0.5, 0.5, 0.5],
  noiseDb: [-18, -24, -26, -26],
  unvoicedShare: [0.3, 0.2, 0.2, 0.15],
  subShare: [0.02, 0.03, 0.05, 0.1],
  chaosShare: [0.1, 0.08, 0.06, 0.1],
}

export function synthMeasures(knots: Knots, intensity: number, seeds: number, seedBase: number, sex: 'female' | 'male' = 'female', onset: 'sudden' | 'sustained' = 'sudden'): Measures[] {
  const out: Measures[] = []
  for (let s = 0; s < seeds; s++) {
    const v = painVocalisation({ intensity, onset, sex, seed: seedBase + s, vocalise: 'always', knots })
    out.push(measure(renderVocalisation(v.params!, SAMPLE_RATE).pcm, SAMPLE_RATE))
  }
  return out
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const iqr = (s: LevelStats, k: StatKey) => s[k].p75 - s[k].p25
const logIqr = (s: LevelStats, k: StatKey) => Math.log(s[k].p75 / s[k].p25)
const trimean = (s: LevelStats, k: StatKey) => (s[k].p25 + 2 * s[k].p50 + s[k].p75) / 4
const round = (v: number) => Number(v.toPrecision(4))

export function fit(targets: Calibration['vivae']['levels'], rounds = 16, seeds = 240, log: (s: string) => void = () => {}): Knots {
  const k: Knots = structuredClone(INITIAL_KNOTS)
  const eta = 0.6
  const step = [0.4, 0.4, 0.4, 0.4]
  const lastSign = [0, 0, 0, 0]
  for (let r = 0; r < rounds; r++) {
    let worst = 0
    LEVELS.forEach((lv: Level, j) => {
      const T = targets[lv].measures
      const M = summarise(synthMeasures(k, targets[lv].intensity, seeds, 100000))
      // 位置：中位数对中位数（比例量用均值，因为它们的中位数常常贴着 0）
      // location: median against median (means for the shares, whose medians often sit at 0)
      k.f0Hz[j] = clamp(k.f0Hz[j]! * (T.f0MeanHz.p50 / M.f0MeanHz.p50) ** eta, 120, 1500)
      k.f0ExcursionSt[j] = clamp(k.f0ExcursionSt[j]! * (T.f0RangeSt.p50 / M.f0RangeSt.p50) ** eta, 0.5, 24)
      k.durationS[j] = clamp(k.durationS[j]! * (T.durationS.p50 / M.durationS.p50) ** eta, 0.15, 3)
      k.levelDb[j] = k.levelDb[j]! + eta * (T.levelDb.p50 - M.levelDb.p50)
      // 质心在低强度时是双峰分布（有声的暗、气声的亮），中位数会跳，所以用三均值 (p25 + 2·p50 + p75) / 4
      // the centroid is bimodal at low intensity (dark voiced items, bright breathy ones) and its median jumps, hence the trimean (p25 + 2·p50 + p75) / 4
      // 步长自适应：残差变号就把步长减半（低强度时噪声很强，这个量非常敏感，固定步长会来回振荡）
      // adaptive step: halved whenever the residual changes sign (at low intensity the noise is strong
      // and this knob is very sensitive; a fixed step oscillates)
      const res = trimean(T, 'centroidHz') - trimean(M, 'centroidHz')
      if (Math.sign(res) !== lastSign[j] && lastSign[j] !== 0) step[j] = step[j]! / 2
      lastSign[j] = Math.sign(res)
      k.noiseDirect[j] = clamp(k.noiseDirect[j]! + Math.sign(res) * step[j]! * Math.min(1, Math.abs(res) / 300), 0, 3)
      k.noiseDb[j] = clamp(k.noiseDb[j]! + eta * 0.8 * (M.hnrDb.p50 - T.hnrDb.p50), -60, 0)
      k.unvoicedShare[j] = clamp(k.unvoicedShare[j]! + eta * (M.voicedShare.p50 - T.voicedShare.p50), 0, 0.7)
      k.subShare[j] = clamp(k.subShare[j]! + 2 * eta * (T.subShare.mean - M.subShare.mean), 0, 0.6)
      k.chaosShare[j] = clamp(k.chaosShare[j]! + eta * (T.chaosShare.mean - M.chaosShare.mean), 0, 0.6)
      // 离散程度：四分位距对四分位距 / spread: interquartile range against interquartile range
      k.f0SdLog[j] = clamp(k.f0SdLog[j]! * (logIqr(T, 'f0MeanHz') / logIqr(M, 'f0MeanHz')) ** 0.5, 0.03, 0.7)
      k.durationSdLog[j] = clamp(k.durationSdLog[j]! * (logIqr(T, 'durationS') / logIqr(M, 'durationS')) ** 0.5, 0.05, 0.8)
      k.levelSdDb[j] = clamp(k.levelSdDb[j]! * (iqr(T, 'levelDb') / iqr(M, 'levelDb')) ** 0.5, 0.5, 14)
      worst = Math.max(worst, Math.abs(Math.log(T.f0MeanHz.p50 / M.f0MeanHz.p50)), Math.abs(T.levelDb.p50 - M.levelDb.p50) / 10, Math.abs(T.hnrDb.p50 - M.hnrDb.p50) / 10, Math.abs(T.centroidHz.p50 - M.centroidHz.p50) / 1000)
    })
    log(`fit round ${r + 1}/${rounds}: worst scaled residual ${worst.toFixed(3)}`)
  }
  for (const key of Object.keys(k) as (keyof Knots)[]) k[key] = k[key].map(round)
  return k
}

export function knotsSource(k: Knots): string {
  const lines = (Object.keys(k) as (keyof Knots)[]).map((key) => `  ${key}: [${k[key].join(', ')}],`)
  return `// 由 bun tools/voice/run.ts 生成，不要手改。
// 控制层映射的结点，对 data/curated/voice/calibration.json 里 VIVAE 疼痛子集（女声）的统计量拟合得到。
// Generated by bun tools/voice/run.ts; do not edit by hand.
// The knots of the control mapping, fitted to the statistics of the VIVAE pain subset (female voices)
// in data/curated/voice/calibration.json.
import type { Knots } from './control.ts'

export const FITTED: Knots = {
${lines.join('\n')}
}
`
}

// 对照表里的一行。match：合成的中位数落在目标中位数 ± 四分之一个目标四分位距之内（比例量比的是均值，容差 0.03）。
// One row of the comparison table. match: the synthesized median lies within a quarter of the target's
// interquartile range of the target median (shares compare means, with a tolerance of 0.03).
export interface MatchRow {
  key: StatKey
  level: Level
  target: { p25: number; p50: number; p75: number; mean: number }
  synth: { p25: number; p50: number; p75: number; mean: number }
  match: boolean
  spreadRatio: number
}

export const REPORT_KEYS: StatKey[] = ['f0MeanHz', 'f0RangeSt', 'durationS', 'levelDb', 'hnrDb', 'centroidHz', 'voicedShare', 'nonlinearShare', 'subShare', 'chaosShare']
const SHARE_KEYS = new Set<StatKey>(['nonlinearShare', 'subShare', 'chaosShare'])

export function compare(targets: Calibration['vivae']['levels'], knots: Knots, seeds = 400): MatchRow[] {
  const rows: MatchRow[] = []
  for (const lv of LEVELS) {
    const T = targets[lv].measures
    // 评估用的种子和拟合用的不同 / the evaluation seeds differ from the fitting seeds
    const M = summarise(synthMeasures(knots, targets[lv].intensity, seeds, 500000))
    for (const key of REPORT_KEYS) {
      const t = T[key]
      const m = M[key]
      const share = SHARE_KEYS.has(key)
      const match = share ? Math.abs(m.mean - t.mean) <= 0.03 : Math.abs(m.p50 - t.p50) <= 0.25 * (t.p75 - t.p25)
      rows.push({ key, level: lv, target: { p25: t.p25, p50: t.p50, p75: t.p75, mean: t.mean }, synth: { p25: m.p25, p50: m.p50, p75: m.p75, mean: m.mean }, match, spreadRatio: Number(((m.p75 - m.p25) / (t.p75 - t.p25)).toFixed(2)) })
    }
  }
  return rows
}

export function formatTable(rows: MatchRow[]): string {
  const f = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3))
  const lines = ['parameter       level     target p25/p50/p75 (mean)            synth p25/p50/p75 (mean)             IQR ratio  match']
  for (const r of rows) {
    const cell = (s: MatchRow['target']) => `${f(s.p25)} / ${f(s.p50)} / ${f(s.p75)} (${f(s.mean)})`.padEnd(36)
    lines.push(`${r.key.padEnd(15)} ${r.level.padEnd(9)} ${cell(r.target)} ${cell(r.synth)} ${String(r.spreadRatio).padEnd(10)} ${r.match ? 'yes' : 'NO'}`)
  }
  return lines.join('\n')
}
