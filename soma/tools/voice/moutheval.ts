// 入口：bun tools/voice/moutheval.ts
// 用带音素级对齐的开放许可语音检验 mouthTrack：LibriSpeech dev-clean 的一小部分（CC BY 4.0，Panayotov 等 2015）
// 加上 Lugosch 用 Montreal Forced Aligner 做的对齐（Zenodo 2619474，CC BY 4.0）。两者都只下载在
// data/raw/voice/ 里，不入库；这里只输出按音素类别汇总的分数。对齐本身是自动生成的，不是人工标注。
// AUC = 随机取一个正类音素和一个负类音素，正类的特征值更大的概率（0.5 = 瞎猜，1 = 完全分开）。
// Entry point: bun tools/voice/moutheval.ts
// Checks mouthTrack against open-licence speech with phone-level alignment: a small part of
// LibriSpeech dev-clean (CC BY 4.0, Panayotov et al. 2015) with the alignments Lugosch made with the
// Montreal Forced Aligner (Zenodo 2619474, CC BY 4.0). Both are downloaded under data/raw/voice/ only
// and not committed; only scores aggregated by phone class are reported. The alignments are automatic,
// not hand labels. AUC = the probability that a random phone of the positive class has a larger
// feature value than a random phone of the negative class (0.5 = chance, 1 = perfect separation).

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mouthTrack, type MouthFrame } from '../../src/voice/mouth.ts'
import { ROOT } from './corpus.ts'
import { decodeWav } from './wav.ts'

const WAV_DIR = join(ROOT, 'data/raw/voice/librispeech-wav')
const GRID_DIR = join(ROOT, 'data/raw/voice/librispeech-alignments')

function phones(textGrid: string): { a: number; b: number; p: string }[] {
  const tier = textGrid.slice(textGrid.indexOf('name = "phones"'))
  const out: { a: number; b: number; p: string }[] = []
  const re = /xmin = ([\d.]+)\s+xmax = ([\d.]+)\s+text = "([^"]*)"/g
  for (let m = re.exec(tier); m; m = re.exec(tier)) out.push({ a: Number(m[1]), b: Number(m[2]), p: m[3]!.replace(/\d/g, '') })
  return out
}

function auc(pos: number[], neg: number[]): number {
  const all = [...pos.map((v) => [v, 1] as const), ...neg.map((v) => [v, 0] as const)].sort((x, y) => x[0] - y[0])
  let rank = 0
  let i = 0
  while (i < all.length) {
    let j = i
    while (j < all.length && all[j]![0] === all[i]![0]) j++
    for (let k = i; k < j; k++) if (all[k]![1]) rank += (i + j + 1) / 2
    i = j
  }
  return (rank - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length)
}

if (!existsSync(WAV_DIR)) throw new Error('data/raw/voice/librispeech-wav/ not found; this evaluation needs the local download')
const by: Record<string, { open: number[]; round: number[]; closure: number[]; flagged: number[]; dental: number[]; tip: number[] }> = {}
let seconds = 0
let cpu = 0
let files = 0
for (const name of readdirSync(WAV_DIR).sort()) {
  const grid = join(GRID_DIR, name.replace('.wav', '.TextGrid'))
  if (!existsSync(grid)) continue
  const wav = decodeWav(readFileSync(join(WAV_DIR, name)))
  const t0 = performance.now()
  const frames = mouthTrack(wav.samples, wav.sampleRate)
  cpu += performance.now() - t0
  seconds += wav.samples.length / wav.sampleRate
  files++
  for (const ph of phones(readFileSync(grid, 'utf8'))) {
    if (!ph.p || ph.p === 'sil' || ph.p === 'sp' || ph.p === 'spn') continue
    const seg: MouthFrame[] = frames.slice(Math.round(ph.a * 100), Math.max(Math.round(ph.a * 100) + 1, Math.round(ph.b * 100)))
    if (seg.length === 0) continue
    // 取中间三分之一 / the middle third
    const mid = seg.slice(Math.floor(seg.length / 3), Math.max(Math.floor(seg.length / 3) + 1, Math.ceil((2 * seg.length) / 3)))
    const mean = (k: (f: MouthFrame) => number, s = mid) => s.reduce((a, f) => a + k(f), 0) / s.length
    const e = (by[ph.p] ??= { open: [], round: [], closure: [], flagged: [], dental: [], tip: [] })
    e.open.push(mean((f) => f.open))
    e.round.push(mean((f) => f.round))
    const closed = seg.filter((f) => f.closure > 0)
    e.flagged.push(closed.length ? 1 : 0)
    if (closed.length) e.closure.push(mean((f) => f.closure, closed))
    e.dental.push(mean((f) => f.dental))
    e.tip.push(mean((f) => f.tongue.tip))
  }
}
const pool = (ps: string[], k: 'open' | 'round' | 'closure' | 'flagged' | 'dental' | 'tip') => ps.flatMap((p) => by[p]?.[k] ?? [])
const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN)
const line = (label: string, pos: number[], neg: number[]) => console.log(`${label.padEnd(66)} AUC ${auc(pos, neg).toFixed(2)}   (n = ${pos.length} vs ${neg.length}; means ${avg(pos).toFixed(2)} vs ${avg(neg).toFixed(2)})`)
console.log(`${files} utterances, ${seconds.toFixed(0)} s of speech; mouthTrack cost ${(cpu / seconds).toFixed(1)} ms of CPU per second of audio`)
line('open: open vowels (AA AE AO AW AY) vs close vowels (IY IH UW UH)', pool(['AA', 'AE', 'AO', 'AW', 'AY'], 'open'), pool(['IY', 'IH', 'UW', 'UH'], 'open'))
line('open: all vowels vs all consonants', pool(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW'], 'open'), pool(['B', 'CH', 'D', 'DH', 'F', 'G', 'HH', 'JH', 'K', 'L', 'M', 'N', 'NG', 'P', 'R', 'S', 'SH', 'T', 'TH', 'V', 'W', 'Y', 'Z', 'ZH'], 'open'))
line('round: rounded (UW OW AO UH OY W) vs spread (IY IH EY EH AE Y)', pool(['UW', 'OW', 'AO', 'UH', 'OY', 'W'], 'round'), pool(['IY', 'IH', 'EY', 'EH', 'AE', 'Y'], 'round'))
line('closure detected at all: stops and nasals vs vowels', pool(['P', 'B', 'M', 'T', 'D', 'N', 'K', 'G', 'NG'], 'flagged'), pool(['AA', 'AE', 'AH', 'AO', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'UW'], 'flagged'))
line('closure value where detected: bilabial (P B M) vs other (T D N K G NG)', pool(['P', 'B', 'M'], 'closure'), pool(['T', 'D', 'N', 'K', 'G', 'NG'], 'closure'))
line('dental: labiodental (F V) vs sibilants (S Z SH ZH)', pool(['F', 'V'], 'dental'), pool(['S', 'Z', 'SH', 'ZH'], 'dental'))
line('dental: labiodental (F V) vs dental and glottal (TH DH HH)', pool(['F', 'V'], 'dental'), pool(['TH', 'DH', 'HH'], 'dental'))
line('dental: labiodental (F V) vs vowels', pool(['F', 'V'], 'dental'), pool(['AA', 'AE', 'AH', 'EH', 'IH', 'IY', 'OW', 'UW'], 'dental'))
line('tongue tip: sibilants (S Z SH ZH) vs everything else', pool(['S', 'Z', 'SH', 'ZH'], 'tip'), Object.keys(by).filter((p) => !['S', 'Z', 'SH', 'ZH', 'CH', 'JH'].includes(p)).flatMap((p) => by[p]!.tip))
for (const [label, ps] of [['closure detection rate', ['P', 'B', 'M', 'T', 'D', 'N', 'K', 'G', 'NG']], ['false closures in vowels', ['AA', 'AE', 'AH', 'AO', 'EH', 'IH', 'IY', 'OW', 'UW']]] as const) console.log(`${label}: ${ps.map((p) => `${p} ${(avg(by[p]?.flagged ?? []) * 100).toFixed(0)}%`).join(', ')}`)
console.log(`mean open by vowel: ${['IY', 'IH', 'UW', 'UH', 'EY', 'EH', 'ER', 'AH', 'OW', 'AO', 'AE', 'AA', 'AW', 'AY'].map((p) => `${p} ${avg(by[p]?.open ?? []).toFixed(2)}`).join(', ')}`)
