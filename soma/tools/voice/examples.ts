// 试听材料：WAV、语谱图和一个本地网页，全部写到 tools/voice/out/（不入库）。
// 页面按来源分行：基于录音的（女声突发、持续、由女声推出的男声），以及作对比的参数合成。
// 基于录音的每一条旁边放着用到的原录音（直接引用本机的录音包），便于听出变化处理留下的痕迹。
// Listening material: WAV files, spectrograms and one local HTML page, all under tools/voice/out/ (not
// committed). The page has one block per kind of source: recording-based (female sudden, sustained,
// the male voice derived from female recordings) and, for comparison, parametric synthesis. Next to
// each recording-based item sits the untouched recording it used (referenced straight from the local
// pack), so that traces of the processing can be heard.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { painVocalisation } from '../../src/voice/control.ts'
import type { PackManifest } from '../../src/voice/pack.ts'
import { assemblePack, PainVoice, renderPainVocalisation, type PainVoiceInput, type VoicePack } from '../../src/voice/recorded.ts'
import { measure } from './analysis.ts'
import { spectrogram } from './spectrogram.ts'
import { encodeWav } from './wav.ts'

export function loadLocalPack(dir: string): VoicePack | null {
  if (!existsSync(join(dir, 'manifest.json'))) return null
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as PackManifest
  return assemblePack(manifest, (f) => (existsSync(join(dir, f)) ? new Uint8Array(readFileSync(join(dir, f))) : undefined))
}

interface Item {
  file: string
  intensity: number
  seed: number
  type: string
  clips: string[]
  durationS: number
  f0MeanHz: number
  levelDb: number
}

interface Block {
  title: string
  note: string
  items: Item[]
}

export function writeExamples(out: string, packDir: string): number {
  // 清掉上一版留下的文件 / clear what an earlier version left behind
  if (existsSync(out)) for (const f of readdirSync(out)) if (/\.(wav|png|html)$/.test(f)) rmSync(join(out, f))
  mkdirSync(out, { recursive: true })
  const pack = loadLocalPack(packDir)
  const blocks: Block[] = []
  const render = (name: string, voice: PainVoice | null, input: PainVoiceInput): Item => {
    const v = voice ? voice.vocalise({ ...input, vocalise: 'always' }) : painVocalisation({ ...input, vocalise: 'always' })
    const r = renderPainVocalisation(v)!
    const m = measure(r.pcm, r.sampleRate)
    writeFileSync(join(out, `${name}.wav`), encodeWav(r.pcm, r.sampleRate))
    spectrogram(r.pcm, r.sampleRate, `${name} ${v.type}`).write(join(out, `${name}.png`))
    return { file: name, intensity: input.intensity, seed: input.seed, type: v.type, clips: v.recorded?.clips.filter((c, i, a) => a.indexOf(c) === i) ?? [], durationS: m.durationS, f0MeanHz: m.f0MeanHz, levelDb: m.levelDb }
  }
  if (pack) {
    const voice = new PainVoice(pack)
    const female: Item[] = []
    for (const intensity of [2, 4, 6, 8, 10]) for (const seed of [1, 2, 3]) female.push(render(`recorded-female-sudden-i${String(intensity).padStart(2, '0')}-v${seed}`, voice, { intensity, onset: 'sudden', sex: 'female', seed: intensity * 100 + seed }))
    blocks.push({ title: '1. 基于录音 · 女声 · 突发 / Recording-based · female · sudden', note: '每条是一条 VIVAE 录音加上小幅变调（±1.5 半音）、变速（±12%）和增益。强度 2、4、6、8 落在两个录音等级之间，按距离随机取其中一级，所以同一强度的三条可能来自不同等级。<br>Each item is one VIVAE recording with a small pitch shift (±1.5 semitones), time stretch (±12 %) and gain. Intensities 2, 4, 6 and 8 fall between two recorded levels and take one of them at random by distance, so the three items of one intensity may come from different levels.', items: female })
    const sustained: Item[] = []
    for (const intensity of [6, 10]) for (const seed of [1, 2]) sustained.push(render(`recorded-female-sustained-i${String(intensity).padStart(2, '0')}-v${seed}`, voice, { intensity, onset: 'sustained', sex: 'female', seed: intensity * 100 + 50 + seed }))
    blocks.push({ title: '2. 基于录音 · 女声 · 持续 / Recording-based · female · sustained', note: '几条录音接成一串，中间是 0.25–0.45 秒的换气（气声取自某条录音的开头）。串里的各条可能来自不同的说话人——这一点听起来是否别扭，需要人来判断。<br>Several recordings in a row with catch-breaths of 0.25–0.45 s between them (the breath noise is taken from the start of some recording). The items of a sequence may come from different speakers; whether that sounds wrong needs a human ear.', items: sustained })
    const male: Item[] = []
    for (const intensity of [4, 7, 10]) for (const seed of [1, 2]) male.push(render(`derived-male-sudden-i${String(intensity).padStart(2, '0')}-v${seed}`, voice, { intensity, onset: 'sudden', sex: 'male', seed: intensity * 100 + 70 + seed }))
    blocks.push({ title: '3. 由女声录音推出的男声 / Male voice DERIVED FROM FEMALE RECORDINGS', note: '不是男声录音：把女声录音的音高乘以约 0.6（Raine 等 2019 的男女平均基频之比）、共振峰乘以 0.853（声道长度之比 14.5/17）。这是风险最大的一种变换，测得的失真也最大；如果听起来不行，调用方可以改用参数合成的男声（male: \'synthetic\'）。<br>These are not male recordings: the pitch of female recordings is multiplied by about 0.6 (the male/female mean-F0 ratio of Raine et al. 2019) and the formants by 0.853 (the vocal-tract length ratio 14.5/17). This is the riskiest transformation and the one with the largest measured distortion; if it sounds poor, the caller can choose the parametric male voice instead (male: \'synthetic\').', items: male })
  }
  const synth: Item[] = [
    render('synthetic-female-sudden-i06', null, { intensity: 6, onset: 'sudden', sex: 'female', seed: 2 }),
    render('synthetic-female-sudden-i10', null, { intensity: 10, onset: 'sudden', sex: 'female', seed: 2 }),
    render('synthetic-male-sudden-i07', null, { intensity: 7, onset: 'sudden', sex: 'male', seed: 2 }),
  ]
  blocks.push({ title: `${pack ? '4' : '1'}. 参数合成（没有录音包时的后备）/ Parametric synthesis (the fallback when the pack is absent)`, note: '完全由参数合成，没有用任何录音。这是第一版，放在这里作对比。<br>Entirely parametric, no recording involved. This is the first version, shown for comparison.', items: synth })
  writeFileSync(join(out, 'index.html'), page(blocks, pack !== null))
  return blocks.reduce((s, b) => s + b.items.length, 0)
}

function page(blocks: Block[], hasPack: boolean): string {
  const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '–')
  const sections = blocks.map((b) => `<h2>${b.title}</h2>
<p class="muted">${b.note}</p>
<div class="wrap"><table><thead><tr><th>强度<br>intensity</th><th>类型<br>type</th><th>处理后<br>as produced</th><th>用到的原录音（VIVAE，CC BY-NC，仅本机）<br>real recording used (VIVAE, CC BY-NC, local only)</th><th>语谱图 0–8 kHz<br>spectrogram</th><th>测量<br>measured</th></tr></thead><tbody>
${b.items.map((e) => `<tr><td>${e.intensity}</td><td>${e.type}</td>
<td><audio controls preload="none" src="${e.file}.wav"></audio></td>
<td>${e.clips.length ? e.clips.map((c) => `<div class="orig"><audio controls preload="none" src="../../../public/voice/vivae-pain/${c}"></audio><span class="muted">${c}</span></div>`).join('') : '<span class="muted">—</span>'}</td>
<td><img loading="lazy" src="${e.file}.png" alt="spectrogram of ${e.file}"></td>
<td class="num">${fmt(e.durationS, 2)} s<br>F0 ${fmt(e.f0MeanHz)} Hz<br>${fmt(e.levelDb, 1)} dBFS</td></tr>`).join('\n')}
</tbody></table></div>`)
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>soma · 疼痛发声试听 / pain vocalisation examples</title>
<style>
:root { color-scheme: light dark; --ink: #1c1c1c; --muted: #666; --line: #d8d8d8; --bg: #fff; }
@media (prefers-color-scheme: dark) { :root { --ink: #e8e8e8; --muted: #a0a0a0; --line: #3a3a3a; --bg: #161616; } }
body { font: 14px/1.5 system-ui, sans-serif; color: var(--ink); background: var(--bg); margin: 0 auto; padding: 16px; max-width: 1200px; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 32px; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: middle; }
th { font-weight: 600; font-size: 12px; color: var(--muted); }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 12px; }
img { display: block; max-width: 360px; background: #fff; border-radius: 4px; }
audio { width: 210px; display: block; }
.orig + .orig { margin-top: 6px; }
.muted { color: var(--muted); font-size: 12px; }
.wrap { overflow-x: auto; }
</style>
</head>
<body>
<h1>疼痛发声试听 / Pain vocalisation examples</h1>
<p>${hasPack ? '第 1–3 部分基于 VIVAE 语料的真实录音（Holz、Larrouy-Maestri、Poeppel；CC BY-NC 4.0，仅限非商业使用），是表演出来的发声，不是真实疼痛时的录音。' : '本机没有录音包（public/voice/vivae-pain/），所以只有参数合成的例子。'}这是用于教学的疼痛行为计算模型的输出；被模拟的身体没有主观体验。音量差别很大（强度 2 到 10 相差 20 dB 以上），先把音量调低。本页只在本机使用，不入库。</p>
<p>${hasPack ? 'Parts 1–3 are based on real recordings from the VIVAE corpus (Holz, Larrouy-Maestri &amp; Poeppel; CC BY-NC 4.0, non-commercial use only); they are acted vocalisations, not recordings made during real pain.' : 'The sound pack (public/voice/vivae-pain/) is not present on this machine, so only parametric examples are shown.'} This is output of a computational model of pain behaviour for teaching; the simulated body has no subjective experience. Loudness differs widely (more than 20 dB between intensities 2 and 10), so start with the volume low. This page is for local use only and is not committed.</p>
${sections.join('\n')}
</body>
</html>
`
}
