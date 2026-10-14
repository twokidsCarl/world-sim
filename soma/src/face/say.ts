// "说一句话"：一段带音素时间线的声音（后端合成的，或随仓库附带的示范片段）在共用的时钟上播放，口形由音素决定。
// "Say something": audio that comes with a phoneme timeline (synthesized by the backend, or a demo clip shipped with the
// repository) plays on a shared clock and the mouth shapes are set by the phonemes.
//
// 时钟有两种：浏览器允许出声时用 AudioContext 的时钟（声音和口形同一个时钟，不会漂）；不允许时（没有用户手势，
// 例如由链接或卡片自己开始）用页面时钟无声地走，界面给一个"声音"按钮，点了之后从头带声音重播。
// 纯逻辑（音素 → 视位轨迹 → 口形）在 visemeTrack.ts；这里只有装载、时钟和状态。
// There are two clocks: the AudioContext clock when the browser allows sound (audio and mouth share one clock and cannot
// drift), and the page clock, silently, when it does not (no user gesture, e.g. started by a link or a card) — the UI then
// offers a "sound" button that replays from the start with audio. The pure logic (phonemes → viseme track → mouth shape) is
// visemeTrack.ts; this file only loads, keeps time and reports state.

import type { MouthPose, VisemeTrack } from '../../tools/face/model.ts'
import { useApp, type SayStatus } from '../state/store.ts'
import { mouthTrack, type MouthFrame } from '../voice/mouth.ts'
import { synthesize, TtsError, type TtsLang, type TtsModel, type TtsPhone, type TtsRequest, type TtsWord, type VisemeTables } from '../voice/tts.ts'
import { decodeWav } from '../voice/wav.ts'
import { FeatureStepper, setSpeechRival, speechContext, stopSpeech } from './speech.ts'
import type { FaceData, FaceVisemes } from './types.ts'
import { phonemeTrack, resolveStyle, spokenAt, trackIndex, trackPose } from './visemeTrack.ts'

/**
 * 示范片段包的清单（相对站点根）。再加一个包只要在这里加一行：清单的形状相同
 * （clips[] 里每条有 file、lang、text、durationS、phonemes、words；有 model 的是机器合成的，有 source 的是真人录音）。
 * librispeech-demo 是真人朗读（LibriSpeech，CC BY 4.0），时间线是自动对齐；商业构建也保留它（只去掉 vivae-pain）。
 * The manifests of the demo packs (relative to the site root). Adding another pack takes one more line here: the manifest has the
 * same shape (each entry of clips[] has file, lang, text, durationS, phonemes and words; one with a `model` is machine-synthesized,
 * one with a `source` is a recording of a person). librispeech-demo is real read speech (LibriSpeech, CC BY 4.0) with automatically
 * aligned timelines; the commercial build keeps it too (only vivae-pain is removed).
 */
export const DEMO_PACKS: readonly string[] = ['voice/tts-demo/manifest.json', 'voice/librispeech-demo/manifest.json']

/** 真人录音片段的出处（只有编号，没有朗读者的名字）/ Where a recorded clip comes from (numbers only, no reader's name). */
export interface DemoRecording {
  corpus: string
  speaker: string
  sex: 'female' | 'male' | ''
  chapter: string
  utterance: string
  book: string
  /** 时间线是怎么来的，例如自动对齐 / how the timeline was made, e.g. an automatic alignment. */
  alignment: string
}

export interface DemoClip {
  /** 文件名去掉扩展名，如 zh-03；URL 的 say= 用它 / the file name without its extension, e.g. zh-03; what say= in the URL takes. */
  id: string
  pack: string
  url: string
  lang: TtsLang
  voice: string
  text: string
  durationS: number
  phonemes: TtsPhone[]
  words: TtsWord[]
  model: TtsModel | null
  /** 真人录音的出处；机器合成的为 null / the source of a recording; null when machine-synthesized. */
  recording: DemoRecording | null
  warnings: { word: string; note: string }[]
}

export interface DemoPack {
  path: string
  licence: string
  clips: DemoClip[]
}

interface Manifest {
  licence?: string
  clips?: { file?: string; lang?: string; voice?: string; text?: string; durationS?: number; phonemes?: TtsPhone[]; words?: TtsWord[]; model?: TtsModel; source?: Partial<Record<keyof DemoRecording, unknown>>; warnings?: { word: string; note: string }[] }[]
}

function recordingOf(s: Partial<Record<keyof DemoRecording, unknown>> | undefined): DemoRecording | null {
  if (!s || typeof s !== 'object' || typeof s.speaker !== 'string') return null
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  return { corpus: str(s.corpus), speaker: s.speaker, sex: s.sex === 'female' || s.sex === 'male' ? s.sex : '', chapter: str(s.chapter), utterance: str(s.utterance), book: str(s.book), alignment: str(s.alignment) }
}

/** 清单 → 包（纯函数）：不完整的条目跳过。 A manifest → a pack (pure): incomplete entries are skipped. */
export function packFromManifest(path: string, manifest: unknown, root = ''): DemoPack {
  const m = (manifest ?? {}) as Manifest
  const dir = path.slice(0, path.lastIndexOf('/') + 1)
  const clips: DemoClip[] = []
  for (const c of Array.isArray(m.clips) ? m.clips : []) {
    if (!c || typeof c.file !== 'string' || (c.lang !== 'en' && c.lang !== 'zh') || !Array.isArray(c.phonemes) || !(Number(c.durationS) > 0)) continue
    clips.push({
      id: c.file.replace(/\.[A-Za-z0-9]+$/, ''),
      pack: path,
      url: `${root}${dir}${c.file}`,
      lang: c.lang,
      voice: String(c.voice ?? ''),
      text: String(c.text ?? ''),
      durationS: Number(c.durationS),
      phonemes: c.phonemes,
      words: Array.isArray(c.words) ? c.words : [],
      model: c.model && typeof c.model.name === 'string' ? c.model : null,
      recording: c.model ? null : recordingOf(c.source),
      warnings: Array.isArray(c.warnings) ? c.warnings : [],
    })
  }
  return { path, licence: String(m.licence ?? ''), clips }
}

let packs: Promise<DemoPack[]> | null = null

/** 读入全部示范包（只读一次）；读不到的包跳过。 Load every demo pack (once); a pack that cannot be read is skipped. */
export function loadDemoPacks(): Promise<DemoPack[]> {
  packs ??= Promise.all(
    DEMO_PACKS.map(async (path) => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}${path}`)
        if (!res.ok) return null
        return packFromManifest(path, await res.json(), import.meta.env.BASE_URL)
      } catch {
        return null
      }
    }),
  ).then((list) => list.filter((p): p is DemoPack => !!p && p.clips.length > 0))
  return packs
}

let tables: Promise<VisemeTables> | null = null
let tablesNow: VisemeTables | null = null

/** 音素 → 视位的两张映射表，按需加载 / the two phoneme → viseme tables, loaded on demand. */
function loadTables(): Promise<VisemeTables> {
  tables ??= Promise.all([import('../../data/curated/face/phonemes-en.json'), import('../../data/curated/face/visemes-zh.json')]).then(([en, zh]) => {
    tablesNow = { en: en.default as unknown as VisemeTables['en'], zh: zh.default as unknown as VisemeTables['zh'] }
    return tablesNow
  })
  return tables
}

interface Clip {
  id: string | null
  source: 'demo' | 'tts'
  lang: TtsLang
  pcm: Float32Array
  sampleRate: number
  durationS: number
  phonemes: TtsPhone[]
  words: TtsWord[]
}

interface Playing {
  clock: 'audio' | 'wall'
  /** 时间线的 0 在时钟上的时刻，秒（AudioContext 的时刻，或 performance.now() / 1000）/ where the timeline's 0 lies on the clock, seconds (AudioContext time, or performance.now() / 1000). */
  start: number
  source: AudioBufferSourceNode | null
  /** 页面时钟暂停的时刻（秒）；没有暂停为 null / when the page clock was paused (seconds); null when running. */
  pausedAt: number | null
  /** 无声地循环（嵌入的卡片）/ loop silently (an embedded card). */
  loop: boolean
  /** 被 seekSay 定住：页面回到前台也不继续走 / held by seekSay: does not run on when the page comes back. */
  frozen?: boolean
}

/** 循环播放时两遍之间的停顿，秒 / the rest between two rounds when looping, seconds. */
const LOOP_GAP = 1.2

let clip: Clip | null = null
let playing: Playing | null = null
let token = 0
let tracks = new Map<FaceVisemes, VisemeTrack>()
let features: MouthFrame[] | null = null
const stepper = new FeatureStepper()

export interface SaySample {
  /** 时间线上的时刻，秒 / time on the timeline, seconds. */
  t: number
  /** 所用的那一帧的下标（每秒 100 帧）/ index of the frame used (100 a second). */
  index: number
  kind: 'phonemes' | 'audio'
  pose: MouthPose
}
let last: SaySample | null = null

const setStatus = (patch: Partial<SayStatus>): void => useApp.setState((s) => ({ say: { ...s.say, ...patch } }))

function halt(): void {
  const p = playing
  playing = null
  if (p?.source) {
    p.source.onended = null
    try {
      p.source.stop()
    } catch {
      // 还没开始或已经结束 / not started yet, or already ended
    }
  }
  stepper.reset()
  last = null
}

function adopt(next: Clip, status: Partial<SayStatus>): void {
  halt()
  clip = next
  tracks = new Map()
  features = null
  setStatus({ status: 'ready', clip: next.id, source: next.source, lang: next.lang, durationS: next.durationS, sound: false, message: '', warnings: [], model: null, recording: null, licence: '', ...status })
}

/**
 * 装入一个示范片段（不播放）。id 不分大小写。返回是否成功。
 * Load a demo clip (without playing it). The id is matched without regard to case. Returns whether it worked.
 */
export async function loadDemoClip(id: string): Promise<boolean> {
  halt()
  const mine = ++token
  setStatus({ status: 'loading', message: '' })
  try {
    const [all] = await Promise.all([loadDemoPacks(), loadTables()])
    const pack = all.find((p) => p.clips.some((c) => c.id.toLowerCase() === id.toLowerCase()))
    const c = pack?.clips.find((x) => x.id.toLowerCase() === id.toLowerCase())
    if (!pack || !c) throw new Error(`没有示范片段 "${id}" / no demo clip "${id}"`)
    const res = await fetch(c.url)
    if (!res.ok) throw new Error(`读不到 ${c.id} 的声音 / the audio of ${c.id} could not be read (HTTP ${res.status})`)
    const wav = decodeWav(new Uint8Array(await res.arrayBuffer()))
    if (mine !== token) return false
    adopt({ id: c.id, source: 'demo', lang: c.lang, pcm: wav.samples, sampleRate: wav.sampleRate, durationS: wav.samples.length / wav.sampleRate, phonemes: c.phonemes, words: c.words }, { text: c.text, voice: c.voice, warnings: c.warnings, model: c.model ? { name: c.model.name, version: c.model.version, licence: c.model.licence } : null, recording: c.recording, licence: pack.licence })
    return true
  } catch (err) {
    if (mine !== token) return false
    clip = null
    setStatus({ status: 'error', clip: null, source: null, message: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/**
 * 请后端合成一句话并装入（不播放）。后端拒绝时把它的话原样放进 message（中英都有）。文字不进 URL。
 * Ask the backend to synthesize an utterance and load it (without playing it). When the backend refuses, its message goes
 * into `message` verbatim (it is bilingual). The text never enters the URL.
 */
export async function loadSynthesized(req: TtsRequest): Promise<boolean> {
  halt()
  const mine = ++token
  setStatus({ status: 'loading', message: '' })
  try {
    const [r] = await Promise.all([synthesize(req), loadTables()])
    if (mine !== token) return false
    adopt({ id: null, source: 'tts', lang: r.lang, pcm: r.pcm, sampleRate: r.sampleRate, durationS: r.durationS, phonemes: r.phonemes, words: r.words }, { text: req.text, voice: r.voice, warnings: r.warnings, model: { name: r.model.name, version: r.model.version, licence: r.model.licence } })
    return true
  } catch (err) {
    if (mine !== token) return false
    const detail = err instanceof TtsError ? err.message : `连不上语音合成服务 / the speech-synthesis service could not be reached${err instanceof Error && err.message ? `: ${err.message}` : ''}`
    // 原来装着的片段还在，可以接着播 / the clip loaded before is still there and can be played
    setStatus({ status: clip ? 'ready' : 'error', message: detail })
    return false
  }
}

/** 页面是否已经有过用户手势（没有这个接口的浏览器当作有过）/ Whether the page has had a user gesture (assumed so where the interface is missing). */
function userHasActed(): boolean {
  const ua = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
  return ua ? ua.hasBeenActive : true
}

async function audible(): Promise<AudioContext | null> {
  // 没有过用户手势时浏览器不会让 AudioContext 运行：不去创建它（否则控制台里多一条警告）
  // without a user gesture the browser will not run an AudioContext: it is not even created (which would only add a console warning)
  if (!userHasActed()) return null
  const ctx = speechContext()
  if (!ctx) return null
  if (ctx.state === 'suspended') await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 400))])
  return ctx.state === 'running' ? ctx : null
}

function startAudio(ctx: AudioContext, c: Clip, offset: number): Playing {
  const buffer = ctx.createBuffer(1, c.pcm.length, c.sampleRate)
  buffer.getChannelData(0).set(c.pcm)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  const when = ctx.currentTime + 0.05
  const from = Math.min(Math.max(0, offset), Math.max(0, c.durationS - 0.01))
  source.start(when, from)
  const p: Playing = { clock: 'audio', start: when - from, source, pausedAt: null, loop: false }
  source.onended = () => {
    if (playing === p) finish()
  }
  return p
}

function finish(): void {
  halt()
  setStatus({ status: 'ready' })
}

/**
 * 从头播放装好的片段。sound 为 true 时尽量出声（要在用户手势里调用才行）；浏览器不允许时改用页面时钟无声地走，
 * 状态里的 sound 为 false。返回是否开始了。
 * Play the loaded clip from the start. With `sound` true it tries to be audible (which only works inside a user gesture); when
 * the browser does not allow it, the page clock runs it silently and `sound` in the status is false. Returns whether it started.
 */
export async function playSay(opts: { sound?: boolean; loop?: boolean } = {}): Promise<boolean> {
  const c = clip
  if (!c) return false
  halt()
  stopSpeech()
  const mine = ++token
  const ctx = opts.sound === false ? null : await audible()
  if (mine !== token || clip !== c) return false
  // "按音频"要的声学特征在开始前算好（同步，约每分钟声音 1 秒），不放到第一帧里
  // the acoustic features of "by audio analysis" are computed before the start (synchronous, about 1 s per minute of audio), not inside the first frame
  if (useApp.getState().say.mode === 'audio') features ??= mouthTrack(c.pcm, c.sampleRate)
  playing = ctx ? startAudio(ctx, c, 0) : { clock: 'wall', start: performance.now() / 1000 + 0.05, source: null, pausedAt: null, loop: !!opts.loop }
  setStatus({ status: 'playing', sound: !!ctx, message: '' })
  // 张口要靠下颌关节 / the jaw joint is what opens the mouth
  void useApp.getState().ensureFace()
  void useApp.getState().ensureRig()
  return true
}

/**
 * 在用户手势里先把 AudioContext 叫醒：之后要等网络（合成、取片段）再播放时，声音仍然能响。
 * Wake the AudioContext inside a user gesture, so that sound still works when playback has to wait for the network
 * (synthesis, fetching a clip) first.
 */
export function primeSaySound(): void {
  const ctx = userHasActed() ? speechContext() : null
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
}

/** 停止播放；片段留着，可以重播 / Stop playback; the clip is kept and can be replayed. */
export function stopSay(): void {
  const was = !!playing
  token++
  halt()
  if (was) setStatus({ status: 'ready' })
}

/** 丢掉片段 / Drop the clip. */
export function clearSay(): void {
  token++
  halt()
  clip = null
  tracks = new Map()
  features = null
  setStatus({ status: 'idle', clip: null, source: null, text: '', lang: null, voice: '', durationS: 0, sound: false, message: '', warnings: [], model: null, recording: null, licence: '' })
}

/** 换带动方式：从头重播（声音的有无不变）/ Change what drives the mouth: replays from the start (audible or not as before). */
export function setSayMode(mode: SayStatus['mode']): void {
  const s = useApp.getState().say
  if (s.mode === mode) return
  setStatus({ mode })
  if (playing) void playSay({ sound: playing.clock === 'audio', loop: playing.loop })
}

/** 播放头在时间线上的时刻，秒；没有在播放时为 null / The playhead on the timeline, seconds; null when not playing. */
export function sayTime(): number | null {
  const p = playing
  if (!p) return null
  if (p.clock === 'wall') return (p.pausedAt ?? performance.now() / 1000) - p.start
  const ctx = speechContext()
  if (!ctx) return null
  // 听到的声音比时钟晚一个输出延迟 / what is heard lags the clock by the output latency
  return ctx.currentTime - Math.min(0.2, Math.max(0, ctx.outputLatency || 0)) - p.start
}

/** 播放头；到了结尾就结束（或开始下一遍）/ The playhead; ends playback (or starts the next round) at the end. */
function advance(): number | null {
  const c = clip, p = playing
  const t = sayTime()
  if (!c || !p || t === null) return null
  if (t < c.durationS) return t
  if (p.clock === 'wall' && p.loop && p.pausedAt === null) {
    p.start = performance.now() / 1000 + LOOP_GAP
    stepper.reset()
    return null
  }
  finish()
  return null
}

/**
 * 此刻的口形（正在播放时），按给定人体的视位表算。"按音素"时取视位轨迹的一帧（风格见 resolveStyle）；
 * "按音频"时把同一段声音的声学特征逐帧换成口形（近似，与"由音频带动口形"同一条路线）。
 * The mouth shape right now (while playing), for the given body's viseme table. "By phonemes" takes a frame of the viseme
 * track (for the style see resolveStyle); "by audio analysis" turns the acoustic features of the same audio into a shape frame
 * by frame (approximate; the same route as "speak from audio").
 */
export function sayFrame(face: FaceData): SaySample | null {
  const c = clip
  const t = advance()
  if (!c || t === null || t < 0 || !face.visemes) return null
  const s = useApp.getState()
  if (s.say.mode === 'audio') {
    features ??= mouthTrack(c.pcm, c.sampleRate)
    const r = stepper.at(face, features, Math.floor(t * 100))
    last = r ? { t, index: r.index, kind: 'audio', pose: r.pose } : null
    return last
  }
  if (!tablesNow) return null
  let track = tracks.get(face.visemes)
  if (!track) {
    track = phonemeTrack(c.phonemes, c.lang, tablesNow, face.visemes, c.durationS)
    tracks.set(face.visemes, track)
  }
  const index = trackIndex(track, t)
  const pose = trackPose(face, track, index, resolveStyle(s.speechStyle, 'speech'))
  last = pose ? { t, index, kind: 'phonemes', pose } : null
  return last
}

/** 最近一次用过的口形（验证用）/ The mouth shape last used (verification). */
export function lastSaySample(): SaySample | null {
  return last
}

/** 装着的片段的时间线（验证和界面用）/ The loaded clip's timeline (verification and the UI). */
export function sayClip(): { id: string | null; source: 'demo' | 'tts'; lang: TtsLang; durationS: number; phonemes: readonly TtsPhone[]; words: readonly TtsWord[] } | null {
  return clip ? { id: clip.id, source: clip.source, lang: clip.lang, durationS: clip.durationS, phonemes: clip.phonemes, words: clip.words } : null
}

/** 此刻在说的音和词（界面显示用）/ The sound and word being spoken right now (for display). */
export function sayNow(): { t: number; phone: TtsPhone | null; word: TtsWord | null; wordIndex: number } | null {
  const c = clip
  const t = advance()
  if (!c || t === null) return null
  return { t, ...spokenAt(c.phonemes, c.words, t) }
}

/**
 * 在用户手势里打开声音：正在无声地播放（或刚播完）时，从头带声音重播一遍。返回声音是否真的开了。
 * Turn the sound on inside a user gesture: while playing silently (or after it ended), replay from the start with audio.
 * Returns whether sound really started.
 */
export async function enableSaySound(): Promise<boolean> {
  if (!clip) return false
  const ok = await playSay({ sound: true })
  return ok && useApp.getState().say.sound
}

/** 页面隐藏时停住时钟（口形随之停住），回来时接着播 / Stop the clock while the page is hidden (the mouth stops with it); carry on afterwards. */
export function setSayPaused(paused: boolean): void {
  const p = playing
  if (!p) return
  if (p.clock === 'wall') {
    const now = performance.now() / 1000
    if (paused && p.pausedAt === null) p.pausedAt = now
    else if (!paused && p.pausedAt !== null && !p.frozen) {
      p.start += now - p.pausedAt
      p.pausedAt = null
    }
    return
  }
  const ctx = speechContext()
  if (!ctx) return
  if (paused) {
    if (ctx.state === 'running') void ctx.suspend()
  } else if (ctx.state === 'suspended') void ctx.resume()
}

// 两路说话同一时刻只播一个 / only one of the two speech routes plays at a time
setSpeechRival(stopSay)

/** 测试用：清掉模块内的状态 / For tests: clear the module's state. */
export function resetSay(): void {
  token++
  halt()
  clip = null
  tracks = new Map()
  features = null
}

/**
 * 验证和测试用：直接装入一段时间线（不经网络和解码，没有声音）。tables 不给时用已经加载的映射表。
 * For verification and tests: load a timeline directly (no network, no decoding, no audio). Without `tablesFor` the mapping
 * tables already loaded are used.
 */
export function loadTimeline(c: { id?: string; lang: TtsLang; durationS: number; phonemes: TtsPhone[]; words?: TtsWord[] }, tablesFor?: VisemeTables): void {
  if (tablesFor) tablesNow = tablesFor
  token++
  adopt({ id: c.id ?? null, source: 'demo', lang: c.lang, pcm: new Float32Array(0), sampleRate: 24000, durationS: c.durationS, phonemes: c.phonemes, words: c.words ?? [] }, { text: '' })
}

/**
 * 验证和测试用：把播放头拨到时间线上的 t 秒并停在那里（无声，页面时钟）；之后口形就是那一帧的。
 * For verification and tests: move the playhead to t seconds on the timeline and hold it there (silent, page clock); the mouth
 * then shows that frame.
 */
export function seekSay(t: number): void {
  if (!clip) return
  token++
  halt()
  const now = performance.now() / 1000
  playing = { clock: 'wall', start: now - t, source: null, pausedAt: now, loop: false, frozen: true }
  setStatus({ status: 'playing', sound: false, message: '' })
}
