// 基于录音的发声：运行时如果有录音包（public/voice/vivae-pain/，CC BY-NC 4.0，可整个删掉），
// 就从里面选录音并在录音上做变化；没有录音包时退回参数合成器。
// 本文件是代码（MIT），不含任何录音。
// Recording-based vocalisation: when the sound pack is present at run time
// (public/voice/vivae-pain/, CC BY-NC 4.0, removable as a whole), recordings are picked from it and
// varied; without the pack everything falls back to the parametric synthesizer.
// This file is code (MIT) and contains no recording.
//
// 这是用于教学的疼痛行为计算模型；被模拟的身体没有主观体验。录音是按指令表演出来的，不是真实疼痛时录的。
// This is a computational model of pain behaviour for teaching; the simulated body has no subjective
// experience. The recordings are acted on instruction, not made during real pain.

import { EMPTY_TIMELINE, interp, painVocalisation, RAINE_2019, RAINE_X, soundProbability, VIVAE_LEVELS, VOCAL_TRACT_CM, type PainVocalisation, type PainVocalisationInput } from './control.ts'
import { PACK_FRAME_RATE, PACK_LEVELS, type PackClip, type PackManifest } from './pack.ts'
import { transformClip } from './psola.ts'
import { resample } from './resample.ts'
import { makeRng, type Rng } from './rng.ts'
import { renderVocalisation } from './synth.ts'
import type { RenderResult, Timeline, TimelineEvent } from './types.ts'
import { decodeWav } from './wav.ts'

export interface VoicePack {
  manifest: PackManifest
  sampleRate: number
  // 文件名 → 解码后的波形 / file name → decoded waveform
  audio: Map<string, Float32Array>
}

// 变化的范围。这些界限是按失真测量定的（见 tools/voice/run.ts 的报告），不是听出来的。
// The ranges of variation. These bounds were set from distortion measurements (see the report of
// tools/voice/run.ts), not by ear.
export const VARIATION = {
  // 变调：±1.5 个半音 / pitch shift: ±1.5 semitones
  pitchSemitones: 1.5,
  // 变速：±12% / time stretch: ±12 %
  stretch: 0.12,
  // 强度每偏离所选录音的等级 1 个单位，增益改变的 dB 数（取自语料各级电平的中位数：约 22 dB / 7.5）
  // gain change in dB per unit of intensity away from the chosen recording's level (from the corpus's median levels: about 22 dB over 7.5)
  gainDbPerUnit: 2.9,
  maxGainDb: 5,
  // 同一个发声器最近用过的多少条录音不再选 / how many of a voice's most recent recordings are not picked again
  memory: 8,
} as const

// 由女声录音推出男声时共振峰的倍数：女、男声道长度之比 / formant factor for deriving a male voice from female recordings: the ratio of female to male vocal-tract length
export const MALE_FORMANT_RATIO = VOCAL_TRACT_CM.female / VOCAL_TRACT_CM.male

export function assemblePack(manifest: PackManifest, bytesOf: (file: string) => Uint8Array | undefined): VoicePack | null {
  const audio = new Map<string, Float32Array>()
  for (const clip of manifest.clips) {
    const bytes = bytesOf(clip.file)
    if (!bytes) return null
    audio.set(clip.file, decodeWav(bytes).samples)
  }
  return audio.size > 0 ? { manifest, sampleRate: manifest.sampleRate, audio } : null
}

// 取录音包；目录不存在（比如商业构建把它删了）或任何一步失败时返回 null，调用方就用参数合成器。
// Fetches the pack; returns null when the directory is absent (for example removed from a commercial
// build) or anything fails, in which case the caller uses the parametric synthesizer.
export async function loadVoicePack(baseUrl = '/voice/vivae-pain/', fetchFn: typeof fetch = fetch): Promise<VoicePack | null> {
  try {
    const res = await fetchFn(`${baseUrl}manifest.json`)
    if (!res.ok) return null
    const manifest = (await res.json()) as PackManifest
    if (!Array.isArray(manifest.clips)) return null
    const files = new Map<string, Uint8Array>()
    await Promise.all(manifest.clips.map(async (clip) => {
      const r = await fetchFn(`${baseUrl}${clip.file}`)
      if (r.ok) files.set(clip.file, new Uint8Array(await r.arrayBuffer()))
    }))
    return assemblePack(manifest, (f) => files.get(f))
  } catch {
    return null
  }
}

export interface PainVoiceInput extends PainVocalisationInput {
  // 男声怎么来：'derived'（默认）= 由女声录音降调并缩放共振峰得到；'synthetic' = 用参数合成器
  // how the male voice is made: 'derived' (default) = from the female recordings by lowering the pitch
  // and scaling the formants; 'synthetic' = the parametric synthesizer
  male?: 'derived' | 'synthetic'
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const LEVEL_X = PACK_LEVELS.map((l) => VIVAE_LEVELS[l])

interface Piece {
  pcm: Float32Array
  timeline: Timeline
  clip: PackClip
}

// 一条录音的时间线，按同样的变调和变速变换过 / a recording's timeline, transformed by the same pitch and time factors as its audio
function clipTimeline(clip: PackClip, durationS: number, pitchRatio: number, timeRatio: number, gain: number): Timeline {
  const frames = Math.max(1, Math.ceil(durationS * PACK_FRAME_RATE))
  const tl: Timeline = { durationS, frameRate: PACK_FRAME_RATE, events: [], mouth: new Float32Array(frames), level: new Float32Array(frames), airflow: new Float32Array(frames), f0: new Float32Array(frames) }
  const t = clip.tracks
  let max = -Infinity
  for (const v of t.levelDb) max = Math.max(max, v)
  const firstVoiced = t.voiced.indexOf('1')
  const kinds: TimelineEvent['kind'][] = []
  for (let j = 0; j < frames; j++) {
    const i = Math.min(t.f0.length - 1, Math.round(j / timeRatio))
    const active = t.levelDb[i]! > max - 30
    const voiced = t.voiced[i] === '1'
    const amp = active ? 10 ** ((t.levelDb[i]! - max) / 20) : 0
    tl.mouth[j] = t.mouth[i]! / 100
    tl.level[j] = amp * gain
    tl.f0[j] = voiced ? t.f0[i]! * pitchRatio : 0
    // 气流方向分不出来，按假设给：第一个有声帧之前的气声算吸气，其余算呼气。
    // The direction of airflow cannot be told from the audio; by assumption breath noise before the
    // first voiced frame counts as inhalation and everything else as exhalation.
    const inhale = !voiced && (firstVoiced < 0 || i < firstVoiced)
    tl.airflow[j] = inhale ? -amp : amp
    kinds.push(!active ? 'pause' : voiced ? 'voiced' : inhale ? 'inhale' : 'exhale')
  }
  let start = 0
  for (let j = 1; j <= frames; j++) {
    if (j === frames || kinds[j] !== kinds[start]) {
      tl.events.push({ kind: kinds[start]!, startS: start / PACK_FRAME_RATE, endS: Math.min(durationS, j / PACK_FRAME_RATE) })
      start = j
    }
  }
  return tl
}

function concatTimelines(parts: Timeline[]): Timeline {
  const durationS = parts.reduce((s, p) => s + p.durationS, 0)
  const frames = Math.max(1, Math.ceil(durationS * PACK_FRAME_RATE))
  const tl: Timeline = { durationS, frameRate: PACK_FRAME_RATE, events: [], mouth: new Float32Array(frames), level: new Float32Array(frames), airflow: new Float32Array(frames), f0: new Float32Array(frames) }
  let offset = 0
  for (const p of parts) {
    const base = Math.round(offset * PACK_FRAME_RATE)
    for (let j = 0; j < p.mouth.length && base + j < frames; j++) {
      tl.mouth[base + j] = p.mouth[j]!
      tl.level[base + j] = p.level[j]!
      tl.airflow[base + j] = p.airflow[j]!
      tl.f0[base + j] = p.f0[j]!
    }
    for (const e of p.events) tl.events.push({ kind: e.kind, startS: e.startS + offset, endS: e.endS + offset })
    offset += p.durationS
  }
  let peak = 0
  for (const v of tl.level) peak = Math.max(peak, v)
  if (peak > 0) for (let j = 0; j < frames; j++) { tl.level[j] = tl.level[j]! / peak; tl.airflow[j] = clamp(tl.airflow[j]! / peak, -1, 1) }
  return tl
}

// 一个发声器：记得自己最近用过哪些录音，所以连续几次不会重复。同样的种子序列和调用顺序给出同样的结果。
// A voice: it remembers which recordings it used most recently, so consecutive calls do not repeat.
// The same sequence of seeds and calls gives the same results.
export class PainVoice {
  private recent: string[] = []
  private readonly byLevel: PackClip[][]
  private readonly breaths: { clip: PackClip; from: number; to: number }[] = []

  constructor(readonly pack: VoicePack | null) {
    this.byLevel = PACK_LEVELS.map((l) => (pack ? pack.manifest.clips.filter((c) => c.level === l) : []))
    // 换气声的来源：录音开头、第一个有声帧之前至少 0.15 秒的气声 / where catch-breaths come from: breath noise of at least 0.15 s before the first voiced frame of a recording
    for (const clip of pack?.manifest.clips ?? []) {
      const t = clip.tracks
      let max = -Infinity
      for (const v of t.levelDb) max = Math.max(max, v)
      const first = t.voiced.indexOf('1')
      const end = first < 0 ? t.voiced.length : first
      let from = 0
      while (from < end && t.levelDb[from]! <= max - 25) from++
      if (end - from >= 15) this.breaths.push({ clip, from, to: end })
    }
  }

  get hasRecordings(): boolean {
    return this.pack !== null && this.byLevel.every((l) => l.length > 1)
  }

  vocalise(input: PainVoiceInput): PainVocalisation {
    if (!this.hasRecordings || (input.sex === 'male' && input.male === 'synthetic')) return painVocalisation(input)
    const pack = this.pack!
    const intensity = clamp(input.intensity, 0, 10)
    const rng = makeRng(input.seed)
    const pSound = soundProbability(intensity, input.onset)
    const silentByRule = rng.next() >= pSound
    if (silentByRule && input.vocalise !== 'always') return { type: 'none', params: null, timeline: EMPTY_TIMELINE(), soundProbability: pSound, silentByRule, source: 'recorded' }

    const male = input.sex === 'male'
    // 男声：音高乘以 Raine 等 (2019) 的男女平均基频之比，共振峰乘以声道长度之比。
    // Male: pitch times the male/female mean-F0 ratio of Raine et al. (2019), formants times the vocal-tract length ratio.
    const maleF0 = male ? interp(RAINE_X, [0, 1, 2].map((i) => RAINE_2019.male.f0MeanHz[i]! / RAINE_2019.female.f0MeanHz[i]!), intensity) : 1
    const formantRatio = male ? MALE_FORMANT_RATIO : 1

    const piece = (allowBreathy: boolean, extraDb: number): Piece => {
      // 强度落在两个录音等级之间时，按距离的比例在两级里选一级。音色因此是在等级之间跳变的，不是连续过渡。
      // Between two recorded levels one of them is chosen with probability by distance. Timbre
      // therefore steps between levels; it does not change continuously.
      const pos = clamp((intensity - LEVEL_X[0]!) / (LEVEL_X[1]! - LEVEL_X[0]!), 0, PACK_LEVELS.length - 1)
      const lower = Math.min(PACK_LEVELS.length - 1, Math.floor(pos))
      const levelIndex = rng.next() < pos - lower ? Math.min(PACK_LEVELS.length - 1, lower + 1) : lower
      let pool = this.byLevel[levelIndex]!.filter((c) => allowBreathy || c.type !== 'inhalation')
      const fresh = pool.filter((c) => !this.recent.includes(c.file))
      if (fresh.length > 0) pool = fresh
      const clip = pool[Math.min(pool.length - 1, Math.floor(rng.next() * pool.length))]!
      this.recent.push(clip.file)
      if (this.recent.length > VARIATION.memory) this.recent.shift()
      const pitchRatio = 2 ** ((rng.range(-1, 1) * VARIATION.pitchSemitones) / 12) * maleF0
      const timeRatio = 1 + rng.range(-1, 1) * VARIATION.stretch
      const gainDb = clamp(VARIATION.gainDbPerUnit * (intensity - LEVEL_X[levelIndex]!), -8, VARIATION.maxGainDb) + rng.gauss() * 1 + extraDb
      const gain = 10 ** (gainDb / 20)
      const pcm = transformClip(pack.audio.get(clip.file)!, pack.sampleRate, clip.tracks.f0, PACK_FRAME_RATE, { pitchRatio, timeRatio, formantRatio })
      for (let i = 0; i < pcm.length; i++) pcm[i] = pcm[i]! * gain
      return { pcm, clip, timeline: clipTimeline(clip, pcm.length / pack.sampleRate, pitchRatio, timeRatio, gain) }
    }

    const pieces: Piece[] = []
    if (input.onset === 'sudden') {
      pieces.push(piece(true, 0))
    } else {
      // 持续性疼痛：一串录音，中间夹着换气。总时长的目标取 Raine 等 (2019) 的各级平均时长（对数正态，σ = 0.45）。
      // Sustained pain: a sequence of recordings with catch-breaths between them. The target total
      // duration follows the per-level mean durations of Raine et al. (2019) (log-normal, σ = 0.45).
      const target = clamp((interp(RAINE_X, RAINE_2019.durationS, intensity, true) / Math.exp(0.45 ** 2 / 2)) * Math.exp(rng.gauss() * 0.45), 0.3, 8)
      let total = 0
      while (pieces.length < 6 && (pieces.length === 0 || total < target - 0.3)) {
        if (pieces.length > 0) {
          const gap = this.breath(rng, pieces[pieces.length - 1]!, formantRatio)
          pieces.push(gap)
          total += gap.timeline.durationS
        }
        const p = piece(false, -1.5 * Math.floor(pieces.length / 2))
        pieces.push(p)
        total += p.timeline.durationS
      }
    }
    const length = pieces.reduce((s, p) => s + p.pcm.length, 0)
    const pcm = new Float32Array(length)
    let offset = 0
    let peak = 0
    for (const p of pieces) { pcm.set(p.pcm, offset); offset += p.pcm.length }
    for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(pcm[i]!))
    // 峰值不超过 0.95：超过就整体降低，不削波 / peaks stay below 0.95: the whole signal is lowered if need be, never clipped
    if (peak > 0.95) for (let i = 0; i < length; i++) pcm[i] = (pcm[i]! * 0.95) / peak
    const voicedPieces = pieces.filter((p) => p.clip.type !== 'inhalation' || pieces.length === 1)
    const main = voicedPieces.reduce((a, b) => (b.clip.levelDb > a.clip.levelDb ? b : a))
    return {
      type: main.clip.type,
      params: null,
      timeline: concatTimelines(pieces.map((p) => p.timeline)),
      soundProbability: pSound,
      silentByRule,
      source: 'recorded',
      recorded: { pcm, sampleRate: pack.sampleRate, clips: pieces.map((p) => p.clip.file) },
    }
  }

  // 两条录音之间的换气：0.25–0.45 秒，中间放一段取自某条录音开头的气声，比前一条录音低约 12 dB。
  // The catch-breath between two recordings: 0.25–0.45 s holding breath noise taken from the start of
  // some recording, about 12 dB below the recording before it.
  private breath(rng: Rng, before: Piece, formantRatio: number): Piece {
    const pack = this.pack!
    const sr = pack.sampleRate
    const n = Math.round(rng.range(0.25, 0.45) * sr)
    const pcm = new Float32Array(n)
    const frames = Math.ceil((n / sr) * PACK_FRAME_RATE)
    const tl: Timeline = { durationS: n / sr, frameRate: PACK_FRAME_RATE, events: [], mouth: new Float32Array(frames), level: new Float32Array(frames), airflow: new Float32Array(frames), f0: new Float32Array(frames) }
    const source = this.breaths.length ? this.breaths[Math.min(this.breaths.length - 1, Math.floor(rng.next() * this.breaths.length))]! : null
    if (!source) {
      tl.events.push({ kind: 'pause', startS: 0, endS: tl.durationS })
      return { pcm, timeline: tl, clip: before.clip }
    }
    const from = Math.round((source.from / PACK_FRAME_RATE) * sr)
    const raw = pack.audio.get(source.clip.file)!.subarray(from, Math.round((source.to / PACK_FRAME_RATE) * sr))
    // 男声时换气声的共振峰也一起缩放 / for the male voice the breath's formants are scaled as well
    const snippet = formantRatio === 1 ? raw : resample(Float32Array.from(raw), sr * formantRatio, sr)
    const len = Math.min(snippet.length, n - Math.round(0.04 * sr))
    const at = Math.floor((n - len) / 2)
    const rmsOf = (x: Float32Array, m: number) => { let s = 0; for (let i = 0; i < m; i++) s += x[i]! * x[i]!; return Math.sqrt(s / Math.max(1, m)) }
    const g = (rmsOf(before.pcm, before.pcm.length) * 10 ** (-12 / 20)) / Math.max(1e-6, rmsOf(snippet, len))
    const fade = Math.round(0.02 * sr)
    for (let i = 0; i < len; i++) pcm[at + i] = snippet[i]! * g * Math.min(1, i / fade, (len - 1 - i) / fade)
    const a = at / sr
    const b = (at + len) / sr
    const amp = 10 ** (-12 / 20) * (before.timeline.level.reduce((m, v) => Math.max(m, v), 0) || 1)
    for (let j = Math.ceil(a * PACK_FRAME_RATE); j < frames && j / PACK_FRAME_RATE < b; j++) { tl.level[j] = amp; tl.airflow[j] = -amp; tl.mouth[j] = 0.25 }
    if (a > 0) tl.events.push({ kind: 'pause', startS: 0, endS: a })
    tl.events.push({ kind: 'inhale', startS: a, endS: b })
    if (b < tl.durationS) tl.events.push({ kind: 'pause', startS: b, endS: tl.durationS })
    return { pcm, timeline: tl, clip: { ...before.clip, type: 'inhalation', levelDb: -200 } }
  }
}

// 把一次发声渲染成波形：录音来源的按需要重采样，合成来源的现算。类型为 'none' 时返回 null。
// Renders a vocalisation to a waveform: a recorded one is resampled if need be, a synthetic one is
// computed. Returns null for type 'none'.
export function renderPainVocalisation(v: PainVocalisation, sampleRate?: number): RenderResult | null {
  if (v.recorded) {
    const rate = sampleRate ?? v.recorded.sampleRate
    return { sampleRate: rate, pcm: rate === v.recorded.sampleRate ? v.recorded.pcm : resample(v.recorded.pcm, v.recorded.sampleRate, rate), timeline: v.timeline, limitedDb: 0 }
  }
  return v.params ? renderVocalisation(v.params, sampleRate ?? 44100) : null
}
