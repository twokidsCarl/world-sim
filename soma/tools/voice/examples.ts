// 试听材料：WAV、语谱图和一个本地网页，全部写到 tools/voice/out/（不入库）。
// Listening material: WAV files, spectrograms and one local HTML page, all under tools/voice/out/ (not committed).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { painVocalisation } from '../../src/voice/control.ts'
import { renderVocalisation } from '../../src/voice/synth.ts'
import type { Onset, Sex } from '../../src/voice/types.ts'
import { Image } from '../skinmaps/render.ts'
import { measure } from './analysis.ts'
import { SAMPLE_RATE } from './fit.ts'
import { spectrogram } from './spectrogram.ts'
import { encodeWav } from './wav.ts'

export const EXAMPLE_INTENSITIES = [2, 4, 6, 8, 10]
export const EXAMPLE_SEEDS = [1, 2, 3]

interface Example {
  file: string
  sex: Sex
  onset: Onset
  intensity: number
  seed: number
  type: string
  silentByRule: boolean
  soundProbability: number
  durationS: number
  f0MeanHz: number
  levelDb: number
  hnrDb: number
  nonlinearShare: number
}

export function writeExamples(out: string): Example[] {
  mkdirSync(out, { recursive: true })
  const examples: Example[] = []
  for (const sex of ['female', 'male'] as const) {
    for (const onset of ['sudden', 'sustained'] as const) {
      const cells: Image[][] = []
      for (const intensity of EXAMPLE_INTENSITIES) {
        const row: Image[] = []
        for (const seed of EXAMPLE_SEEDS) {
          // 试听材料总是出声；按规则本来不出声的那些在页面上标出来。
          // Listening examples always sound; those that the rule would have left silent are marked on the page.
          const v = painVocalisation({ intensity, onset, sex, seed, vocalise: 'always' })
          const r = renderVocalisation(v.params!, SAMPLE_RATE)
          const m = measure(r.pcm, r.sampleRate)
          const file = `${sex}-${onset}-i${String(intensity).padStart(2, '0')}-s${seed}`
          writeFileSync(join(out, `${file}.wav`), encodeWav(r.pcm, r.sampleRate))
          const title = `${sex} ${onset} I=${intensity} seed ${seed} ${v.type}`
          spectrogram(r.pcm, r.sampleRate, title).write(join(out, `${file}.png`))
          row.push(spectrogram(r.pcm, r.sampleRate, `I=${intensity} s${seed} ${v.type}`, onset === 'sudden' ? 2.2 : 5))
          examples.push({ file, sex, onset, intensity, seed, type: v.type, silentByRule: v.silentByRule, soundProbability: v.soundProbability, durationS: m.durationS, f0MeanHz: m.f0MeanHz, levelDb: m.levelDb, hnrDb: m.hnrDb, nonlinearShare: m.nonlinearShare })
        }
        cells.push(row)
      }
      // 总览图：行是强度，列是种子，时间轴等长，便于一眼比较。
      // Overview sheet: rows are intensities, columns are seeds, on equal time axes for comparison at a glance.
      const w = cells[0]![0]!.w
      const h = cells[0]![0]!.h
      const sheet = new Image(w * EXAMPLE_SEEDS.length, h * EXAMPLE_INTENSITIES.length)
      cells.forEach((row, j) => row.forEach((img, i) => sheet.blit(img, i * w, j * h)))
      sheet.write(join(out, `sheet-${sex}-${onset}.png`))
    }
  }
  writeFileSync(join(out, 'index.html'), page(examples))
  return examples
}

function page(examples: Example[]): string {
  const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '–')
  const sections: string[] = []
  for (const sex of ['female', 'male'] as const) {
    for (const onset of ['sudden', 'sustained'] as const) {
      const rows = examples.filter((e) => e.sex === sex && e.onset === onset).map((e) => `<tr>
<td>${e.intensity}</td><td>${e.seed}</td><td>${e.type}${e.silentByRule ? ' <span class="muted">(按规则本来不出声 / silent by the rule; p = ' + e.soundProbability.toFixed(2) + ')</span>' : ''}</td>
<td><audio controls preload="none" src="${e.file}.wav"></audio></td>
<td><img loading="lazy" src="${e.file}.png" alt="spectrogram of ${e.file}"></td>
<td class="num">${fmt(e.durationS, 2)} s<br>F0 ${fmt(e.f0MeanHz)} Hz<br>${fmt(e.levelDb, 1)} dBFS<br>HNR ${fmt(e.hnrDb, 1)} dB<br>NL ${fmt(e.nonlinearShare * 100)} %</td>
</tr>`)
      sections.push(`<h2>${sex === 'female' ? '女声 / female' : '男声 / male'} · ${onset === 'sudden' ? '突发 / sudden' : '持续 / sustained'}</h2>
<table><thead><tr><th>强度<br>intensity</th><th>种子<br>seed</th><th>类型<br>type</th><th>音频<br>audio</th><th>语谱图 0–8 kHz<br>spectrogram</th><th>测量<br>measured</th></tr></thead><tbody>
${rows.join('\n')}
</tbody></table>`)
    }
  }
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>soma · 疼痛发声合成试听 / pain vocalisation examples</title>
<style>
:root { color-scheme: light dark; --ink: #1c1c1c; --muted: #666; --line: #d8d8d8; --bg: #fff; }
@media (prefers-color-scheme: dark) { :root { --ink: #e8e8e8; --muted: #a0a0a0; --line: #3a3a3a; --bg: #161616; } }
body { font: 14px/1.5 system-ui, sans-serif; color: var(--ink); background: var(--bg); margin: 0 auto; padding: 16px; max-width: 1100px; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 32px; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: middle; }
th { font-weight: 600; font-size: 12px; color: var(--muted); }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 12px; }
img { display: block; max-width: 100%; background: #fff; border-radius: 4px; }
audio { width: 220px; }
.muted { color: var(--muted); font-size: 12px; }
.wrap { overflow-x: auto; }
</style>
</head>
<body>
<h1>疼痛发声合成试听 / Pain vocalisation examples</h1>
<p>全部是参数合成的声音，没有任何录音。这是用于教学的疼痛行为计算模型的输出；被模拟的身体没有主观体验。音量差别很大（强度 2 到 10 相差约 20 dB 以上），先从低音量开始听。语谱图：横轴时间（刻度每 0.5 秒），纵轴 0–8 kHz（刻度每 1 kHz），颜色越深能量越大，动态范围 60 dB。测量值来自与校准相同的分析代码；NL 是非线性现象的替代指标。</p>
<p>Everything here is parametric synthesis; no recording is involved. This is output of a computational model of pain behaviour for teaching; the simulated body has no subjective experience. Loudness differs widely (more than about 20 dB between intensities 2 and 10), so start with the volume low. Spectrograms: time runs left to right (a tick every 0.5 s), frequency 0–8 kHz bottom to top (a tick every 1 kHz), darker means more energy, over a 60 dB range. Measured values come from the same analysis code used for calibration; NL is the proxy for nonlinear phenomena.</p>
<div class="wrap">
${sections.join('\n')}
</div>
</body>
</html>
`
}
