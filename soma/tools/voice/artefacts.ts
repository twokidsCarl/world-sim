// 度量在录音上做变化带来的失真：对录音包里的每条录音做变调、变速、由女声推男声，
// 与原录音比较（距离的定义见 metrics.ts），只输出汇总量。
// 「往返」= 变过去再用相反的变换变回来，与原录音比：这样比的是处理本身留下的痕迹，不含变调本来就该有的差别。
// Measures the distortion introduced by varying the recordings: every clip of the pack is pitch-shifted,
// time-stretched and turned into the derived male voice, and compared with the untouched clip
// (distances as defined in metrics.ts); only aggregates are reported.
// "Round trip" = transformed and then transformed back with the inverse, compared with the original:
// that isolates the traces of the processing itself from the difference a pitch change is meant to make.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PackManifest } from '../../src/voice/pack.ts'
import { transformClip } from '../../src/voice/psola.ts'
import { MALE_FORMANT_RATIO } from '../../src/voice/recorded.ts'
import { measure } from './analysis.ts'
import { distance, logMel } from './metrics.ts'
import { decodeWav } from './wav.ts'

export interface ArtefactRow {
  label: string
  n: number
  mcdMean: number
  mcdP90: number
  logMelMean: number
  note?: string
}

const stats = (v: number[]) => {
  const s = v.filter(Number.isFinite).sort((a, b) => a - b)
  return { mean: s.reduce((a, b) => a + b, 0) / s.length, p90: s[Math.floor(0.9 * (s.length - 1))]!, n: s.length }
}

export function measureArtefacts(packDir: string): ArtefactRow[] {
  const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8')) as PackManifest
  const sr = manifest.sampleRate
  const fr = manifest.frameRate
  const cases: { label: string; pitch: number; time: number; formant?: number; roundTrip?: boolean; warp?: number }[] = []
  const st = (x: number) => 2 ** (x / 12)
  cases.push({ label: 'identity (no change)', pitch: 1, time: 1 })
  for (const s of [1.5, 3]) {
    cases.push({ label: `pitch +${s} st`, pitch: st(s), time: 1 }, { label: `pitch -${s} st`, pitch: st(-s), time: 1 })
    cases.push({ label: `pitch +${s} st, round trip`, pitch: st(s), time: 1, roundTrip: true }, { label: `pitch -${s} st, round trip`, pitch: st(-s), time: 1, roundTrip: true })
  }
  for (const d of [0.12, 0.25]) {
    cases.push({ label: `stretch +${d * 100} %`, pitch: 1, time: 1 + d }, { label: `stretch -${d * 100} %`, pitch: 1, time: 1 - d })
  }
  cases.push({ label: 'pitch +1.5 st and stretch +12 %', pitch: st(1.5), time: 1.12 }, { label: 'pitch -1.5 st and stretch -12 %', pitch: st(-1.5), time: 0.88 })
  cases.push({ label: 'derived male (pitch x0.60, formants x0.853), formant-warped comparison', pitch: 0.6, time: 1, formant: MALE_FORMANT_RATIO, warp: MALE_FORMANT_RATIO })
  cases.push({ label: 'derived male, round trip', pitch: 0.6, time: 1, formant: MALE_FORMANT_RATIO, roundTrip: true })
  cases.push({ label: 'formants x0.853 only (pitch kept), formant-warped comparison', pitch: 1, time: 1, formant: MALE_FORMANT_RATIO, warp: MALE_FORMANT_RATIO })

  const rows: ArtefactRow[] = []
  const clips = manifest.clips.map((c) => ({ c, pcm: decodeWav(readFileSync(join(packDir, c.file))).samples }))
  const refs = clips.map(({ pcm }) => logMel(pcm, sr))
  for (const k of cases) {
    const mcd: number[] = []
    const lm: number[] = []
    const f0Ratio: number[] = []
    clips.forEach(({ c, pcm }, i) => {
      let y = transformClip(pcm, sr, c.tracks.f0, fr, { pitchRatio: k.pitch, timeRatio: k.time, formantRatio: k.formant })
      let ratio = k.time
      if (k.roundTrip) {
        // 变回去时用的基频轨迹是原轨迹乘以音高倍数、按时长倍数拉伸 / the way back uses the original F0 track times the pitch factor, stretched by the time factor
        const f0 = Array.from({ length: Math.ceil((y.length / sr) * fr) }, (_, j) => (c.tracks.f0[Math.min(c.tracks.f0.length - 1, Math.round(j / k.time))] ?? 0) * k.pitch)
        y = transformClip(y, sr, f0, fr, { pitchRatio: 1 / k.pitch, timeRatio: 1 / k.time, formantRatio: k.formant ? 1 / k.formant : 1 })
        ratio = 1
      } else if (k.formant && k.pitch !== 1 && c.f0MeanHz) {
        const m = measure(y, sr)
        if (Number.isFinite(m.f0MeanHz)) f0Ratio.push(m.f0MeanHz / c.f0MeanHz)
      }
      // 共振峰缩放过的声音：把它的频率轴按同样的倍数取样，再和原录音比 / a formant-scaled sound is sampled on a frequency axis scaled by the same factor before comparison
      const d = distance(refs[i]!, logMel(y, sr, k.roundTrip ? 1 : (k.warp ?? 1)), ratio)
      mcd.push(d.mcdDb)
      lm.push(d.logMelDb)
    })
    const a = stats(mcd)
    const b = stats(lm)
    const r = f0Ratio.length ? stats(f0Ratio) : null
    rows.push({ label: k.label, n: a.n, mcdMean: Number(a.mean.toFixed(2)), mcdP90: Number(a.p90.toFixed(2)), logMelMean: Number(b.mean.toFixed(2)), note: r ? `measured mean-F0 ratio ${r.mean.toFixed(2)} (asked 0.60)` : undefined })
  }
  return rows
}

export function formatArtefacts(rows: ArtefactRow[]): string {
  return ['transformation                                                              n    MCD mean  MCD p90  log-mel mean (dB)', ...rows.map((r) => `${r.label.padEnd(74)} ${String(r.n).padEnd(4)} ${r.mcdMean.toFixed(2).padEnd(9)} ${r.mcdP90.toFixed(2).padEnd(8)} ${r.logMelMean.toFixed(2)}${r.note ? `   ${r.note}` : ''}`)].join('\n')
}

if (import.meta.main) {
  const { PACK_DIR } = await import('./pack.ts')
  console.log(formatArtefacts(measureArtefacts(PACK_DIR)))
}
