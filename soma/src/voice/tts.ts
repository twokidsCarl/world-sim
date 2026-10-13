// 语音合成的前端一侧：向后端（soma/server，/api/tts）要声音和音素时间线，再把音素换成视位时间线。
// 口形由音素决定，不是从声音里猜的；后端不在时（例如只有静态文件的部署）ttsAvailable 返回 false，
// 界面可以改用随仓库附带的示范片段（public/voice/tts-demo/manifest.json，里面的时间线格式相同）。
// The browser side of speech synthesis: ask the backend (soma/server, /api/tts) for audio with a phoneme timeline, then
// turn the phonemes into a viseme timeline. Mouth shapes come from phonemes, not from guesses about the audio. Without
// the backend (a static-only deployment, say) ttsAvailable returns false and the UI can fall back on the demo clips
// shipped in the repository (public/voice/tts-demo/manifest.json, whose timelines have the same format).

import type { VisemeSegment } from '../../tools/face/model.ts'
import { decodeWav } from './wav.ts'

export type TtsLang = 'en' | 'zh'

export interface TtsRequest {
  /** 1 到 300 个字符 / 1 to 300 characters. */
  text: string
  lang: TtsLang
  /** 不给就用这种语言的默认声音 / the language's default voice when omitted. */
  voice?: string
  /** 0.5 到 2，默认 1 / 0.5 to 2, default 1. */
  speed?: number
}

/** 时间线上的一个音。英语：phone 是 ARPAbet（不带重音数字）。普通话：phone 是拼音的声母或韵母（ü 写作 v）。停顿是 sil。 One sound of the timeline. English: `phone` is ARPAbet without a stress digit. Mandarin: a pinyin initial or final (ü written v). A pause is `sil`. */
export interface TtsPhone {
  /** 起止，秒 / start and end, seconds. */
  t0: number
  t1: number
  phone: string
  /** 模型自己的记号，便于追查 / the model's own symbol, for traceability. */
  symbol: string
  /** words 里的下标；停顿为 null / index into `words`; null for a pause. */
  word: number | null
  /** 英语元音的重音：0 无、1 主、2 次；辅音为 null / stress of an English vowel: 0 none, 1 primary, 2 secondary; null on consonants. */
  stress?: number | null
  /** 普通话的声调 1–5（5 是轻声），记在韵母和儿化上；声母为 null / Mandarin tone 1–5 (5 is neutral), on finals and erhua; null on initials. */
  tone?: number | null
  part?: 'initial' | 'final' | 'erhua' | 'other'
}

export interface TtsWord {
  t0: number
  t1: number
  text: string
}

export interface TtsModel {
  name: string
  version: string
  licence: string
  source?: string
  commit?: string
}

export interface TtsResult {
  /** 单声道，范围 ±1；可直接放进 AudioBuffer（toAudioBuffer）/ mono, within ±1; goes straight into an AudioBuffer (toAudioBuffer). */
  pcm: Float32Array
  sampleRate: number
  durationS: number
  lang: TtsLang
  voice: string
  phonemes: TtsPhone[]
  words: TtsWord[]
  model: TtsModel
  /** 例如词典里没有、按拼写规则读的词 / e.g. words missing from the dictionary and pronounced by spelling rules. */
  warnings: { word: string; note: string }[]
}

/** 后端拒绝了请求。field 和 allowed 说明哪个字段、允许什么。 The backend refused the request; `field` and `allowed` say which field and what is allowed. */
export class TtsError extends Error {
  constructor(message: string, readonly status: number, readonly field: string | null = null, readonly allowed: unknown = null) {
    super(message)
    this.name = 'TtsError'
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface TtsOptions {
  /** 接口的前缀；默认同源的 /api（不写死主机和端口）/ prefix of the routes; same-origin /api by default (no hard-coded host or port). */
  base?: string
  fetch?: FetchLike
  signal?: AbortSignal
}

/**
 * 后端在不在：问一次 /api/health，默认最多等 1.5 秒。从不抛错。给了 lang 时，那种语言的模型缺失或加载失败也算不在
 * （还在加载算在：第一次合成会等它）。
 * Is the backend there: one request to /api/health, waiting 1.5 s at most by default. Never throws. With `lang`, a
 * missing or failed model for that language also counts as absent (still loading counts as present: the first
 * synthesis waits for it).
 */
export async function ttsAvailable(opts: TtsOptions & { timeoutMs?: number; lang?: TtsLang } = {}): Promise<boolean> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController()
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 1500) : null
  try {
    const f = opts.fetch ?? (typeof fetch === 'undefined' ? null : fetch)
    if (!f) return false
    const response = await f(`${opts.base ?? '/api'}/health`, { signal: controller?.signal, headers: { accept: 'application/json' } })
    if (!response.ok) return false
    const body = (await response.json()) as { ok?: boolean; service?: string; languages?: Record<string, { status?: string }> }
    if (body?.ok !== true || body.service !== 'soma-tts') return false
    const usable = (l: string): boolean => ['ready', 'loading', 'pending'].includes(body.languages?.[l]?.status ?? '')
    return opts.lang ? usable(opts.lang) : Object.keys(body.languages ?? {}).some(usable)
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** /api/tts/voices 里的一个声音 / one voice of /api/tts/voices. */
export interface TtsVoice {
  id: string
  lang: TtsLang
  sex: string
  accent: string
  default: boolean
  ready: boolean
  model: { name: string; version: string; licence: string }
}

/** 后端声明的上限 / the limits the backend declares. */
export interface TtsLimits {
  maxTextLength: number
  maxSeconds: number
  speed: [number, number]
}

/**
 * 声音清单和上限（/api/tts/voices）。后端不在或回答不对时返回 null，从不抛错。
 * The voice list and the limits (/api/tts/voices). Null when the backend is absent or answers something else; never throws.
 */
export async function ttsVoices(opts: TtsOptions & { timeoutMs?: number } = {}): Promise<{ voices: TtsVoice[]; limits: TtsLimits } | null> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController()
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000) : null
  try {
    const f = opts.fetch ?? (typeof fetch === 'undefined' ? null : fetch)
    if (!f) return null
    const response = await f(`${opts.base ?? '/api'}/tts/voices`, { signal: controller?.signal, headers: { accept: 'application/json' } })
    if (!response.ok) return null
    const body = (await response.json()) as { voices?: TtsVoice[]; limits?: Partial<TtsLimits> }
    if (!Array.isArray(body?.voices)) return null
    const speed = Array.isArray(body.limits?.speed) && body.limits.speed.length === 2 ? body.limits.speed : ([0.5, 2] as [number, number])
    return { voices: body.voices.filter((v) => v && typeof v.id === 'string' && (v.lang === 'en' || v.lang === 'zh')), limits: { maxTextLength: Number(body.limits?.maxTextLength) || 300, maxSeconds: Number(body.limits?.maxSeconds) || 13, speed: [Number(speed[0]) || 0.5, Number(speed[1]) || 2] } }
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function base64Bytes(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * 合成一句话。请求被拒绝时抛 TtsError（带 field 和 allowed）；连不上时抛普通的错误。同样的输入得到同样的声音。
 * Synthesize one utterance. Throws TtsError (with `field` and `allowed`) when the request is refused, and an ordinary
 * error when the backend cannot be reached. The same input gives the same audio.
 */
export async function synthesize(req: TtsRequest, opts: TtsOptions = {}): Promise<TtsResult> {
  const f = opts.fetch ?? fetch
  const response = await f(`${opts.base ?? '/api'}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal: opts.signal })
  let body: Record<string, unknown> | null = null
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    body = null
  }
  if (!response.ok || !body) {
    const detail = typeof body?.detail === 'string' ? body.detail : `语音合成失败 / speech synthesis failed (HTTP ${response.status})`
    throw new TtsError(detail, response.status, typeof body?.field === 'string' ? body.field : null, body?.allowed ?? null)
  }
  const wav = decodeWav(base64Bytes(String(body.audio)))
  return {
    pcm: wav.samples,
    sampleRate: wav.sampleRate,
    durationS: wav.samples.length / wav.sampleRate,
    lang: body.lang as TtsLang,
    voice: String(body.voice),
    phonemes: body.phonemes as TtsPhone[],
    words: body.words as TtsWord[],
    model: body.model as TtsModel,
    warnings: (body.warnings as TtsResult['warnings'] | undefined) ?? [],
  }
}

// —— 音素 → 视位 / phonemes → visemes ——

/** 一个音里的一个口形：at 是它在这个音里开始的相对时刻（0 到 1）。 One mouth shape inside a sound: `at` is the relative moment (0 to 1) it starts within the sound. */
export interface VisemeStep {
  viseme: string
  at: number
  /** 面部数据里没有 viseme 这个 id 时（旧数据）改用的口形 / the shape used instead when the face data lacks the id `viseme` (older data). */
  fallback?: string
}

/** data/curated/face/phonemes-en.json */
export interface PhonemesEn {
  power: { byStress: Record<string, number>; consonant: number }
  phones: Record<string, { viseme: string; sequence?: VisemeStep[] }>
}

/** data/curated/face/visemes-zh.json */
export interface VisemesZh {
  power: { byTone: Record<string, number>; initial: number }
  initials: Record<string, { sequence: VisemeStep[] }>
  finals: Record<string, { sequence: VisemeStep[] }>
  erhua: Record<string, { sequence: VisemeStep[] }>
}

export interface VisemeTables {
  en?: PhonemesEn
  zh?: VisemesZh
}

function steps(p: TtsPhone, lang: TtsLang, tables: VisemeTables): { sequence: VisemeStep[]; power: number } | null {
  if (lang === 'en') {
    const t = tables.en
    const entry = t?.phones[p.phone]
    if (!t || !entry) return null
    const power = p.stress === null || p.stress === undefined ? t.power.consonant : (t.power.byStress[String(p.stress)] ?? 1)
    return { sequence: entry.sequence ?? [{ viseme: entry.viseme, at: 0 }], power }
  }
  const t = tables.zh
  if (!t) return null
  const entry = p.part === 'initial' ? t.initials[p.phone] : p.part === 'final' ? t.finals[p.phone] : p.part === 'erhua' ? t.erhua[p.phone] : (t.initials[p.phone] ?? t.finals[p.phone])
  if (!entry) return null
  const power = p.part === 'initial' || p.tone === null || p.tone === undefined ? t.power.initial : (t.power.byTone[String(p.tone)] ?? 1)
  return { sequence: entry.sequence, power }
}

type Segment = VisemeSegment & { /** 所属的协同发音分组（普通话：音节）/ its co-articulation group (Mandarin: the syllable). */ group: number }

function segments(phonemes: readonly TtsPhone[], lang: TtsLang, tables: VisemeTables, opts: { available?: Iterable<string> }): Segment[] {
  const available = opts.available ? new Set(opts.available) : null
  const out: Segment[] = []
  // 普通话按音节分组：声母开一个新音节；前面不是本音节声母的韵母（零声母）也开一个；儿化并入前一个音节。英语整句一组。
  // Mandarin is grouped by syllable: an initial opens one, so does a final not preceded by its own initial (zero initial); erhua
  // joins the syllable before it. English is one group for the whole utterance.
  let group = 0
  let open: 'initial' | 'final' | null = null
  for (const p of phonemes) {
    if (p.phone === 'sil' || !(p.t1 > p.t0)) {
      if (p.phone === 'sil') open = null
      continue
    }
    if (lang === 'zh') {
      if (p.part === 'initial' || (p.part === 'final' && open !== 'initial') || (p.part !== 'final' && p.part !== 'erhua')) group++
      open = p.part === 'initial' ? 'initial' : 'final'
    }
    const s = steps(p, lang, tables)
    if (!s) continue
    const span = p.t1 - p.t0
    s.sequence.forEach((step, i) => {
      const next = s.sequence[i + 1]
      const start = p.t0 + span * step.at
      const end = next ? p.t0 + span * next.at : p.t1
      if (!(end > start)) return
      out.push({ viseme: available && step.fallback && !available.has(step.viseme) ? step.fallback : step.viseme, start, end, power: s.power, group })
    })
  }
  return out
}

/**
 * 音素时间线 → 视位时间线（coarticulate 的输入）。纯函数。停顿和表里没有的音不产生视位（那段时间口形回到静止）；
 * 一个音对应几个口形时（双元音、带鼻音韵尾的韵母）按表里的相对时刻切开。available 是面部数据里实际有的视位 id：
 * 给了它、而表里的 viseme 不在其中时，用那一步的 fallback（旧的面部数据没有普通话专用的口形）；不给就照表里的 viseme。
 * A phoneme timeline → a viseme timeline (the input of `coarticulate`). Pure. Pauses and sounds missing from the table
 * yield no viseme (the mouth returns to rest for that stretch); a sound with several shapes (a diphthong, a final with
 * a nasal coda) is cut at the relative moments given in the table. `available` holds the viseme ids the face data
 * really has: when it is given and lacks a step's `viseme`, that step's `fallback` is used (older face data has no
 * Mandarin-only shapes); without it the table's `viseme` is taken as it is.
 */
export function phonemesToVisemeSegments(phonemes: readonly TtsPhone[], lang: TtsLang, tables: VisemeTables, opts: { available?: Iterable<string> } = {}): VisemeSegment[] {
  return segments(phonemes, lang, tables, opts).map(({ group: _group, ...s }) => s)
}

/**
 * 同上，但按协同发音的范围分组：普通话一个音节一组（圆唇的提前和延后不跨音节），英语整句一组。
 * 交给 src/face/visemeTrack.ts 的 coarticulateGroups。
 * As above, but grouped by the reach of co-articulation: one group per syllable in Mandarin (anticipated and carried-over
 * rounding does not cross a syllable boundary) and one group for the whole utterance in English. For coarticulateGroups
 * of src/face/visemeTrack.ts.
 */
export function phonemesToVisemeGroups(phonemes: readonly TtsPhone[], lang: TtsLang, tables: VisemeTables, opts: { available?: Iterable<string> } = {}): VisemeSegment[][] {
  const out: VisemeSegment[][] = []
  let last = NaN
  for (const { group, ...s } of segments(phonemes, lang, tables, opts)) {
    if (group !== last) out.push([])
    last = group
    out[out.length - 1]!.push(s)
  }
  return out
}
