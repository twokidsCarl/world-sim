// 疼痛反应的时间过程与发声：把"强度、起病方式、触发 / 保持"变成每一帧的 AU 强度，并让声音与张口同步。
// Time course and voice of the pain response: turns "intensity, onset, trigger / hold" into AU
// intensities for every frame, and keeps mouth and sound in step.
//
// 这是疼痛行为的计算模型，用于教学：被模拟的身体没有主观体验；强度 → 表情的数值是本项目的假设；
// 录音是演员按指令表演的。
// This is a computational model of pain behaviour for teaching: the simulated body has no
// subjective experience; the intensity → expression numbers are assumptions of this project;
// the recordings are acted.

import { envelope, painAUs } from '../../tools/face/model.ts'
import { useApp } from '../state/store.ts'
import { VOICE_PACK } from './build.ts'
import { PainVoice, loadVoicePack, schedulePainVocalisation, type ScheduledVocalisation } from '../voice/index.ts'
import { cleanAUs, maxAUs, type AUs } from './face.ts'

/** 一次"触发"所模拟的刺激时长，秒 / How long the stimulus of one trigger lasts, seconds. */
export const STIMULUS_SECONDS = { sudden: 0.6, sustained: 4 } as const
const VOICE_PACK_URL = `${import.meta.env.BASE_URL}voice/vivae-pain/`
/** 录音包的文件数（用于进度）；实际以 manifest 为准 / File count of the pack, for progress; the manifest is authoritative. */
const VOICE_PACK_FILES = 186

interface Episode {
  /** 刺激开始的时刻（performance.now 刻度，毫秒）/ Stimulus onset on the performance.now scale, ms. */
  t0: number
  duration: number
  level: number
}

let episode: Episode | null = null
let holdEnv = 0
let lastNow = 0
let context: AudioContext | null = null
let voice: PainVoice | null = null
let voiceLoading: Promise<PainVoice> | null = null
let scheduled: ScheduledVocalisation | null = null
let seed = 1
let pausedAt: number | null = null
let external = 0

export interface PainFrame {
  aus: AUs
  /** 是否还在变化（需要继续逐帧更新）/ Whether it is still changing (keep updating every frame). */
  animating: boolean
  /** 当前的气流（−1 吸气 … 1 呼气），没有发声时为 0 / Current airflow (−1 in … 1 out); 0 without a vocalisation. */
  airflow: number
}

/** 张口度（0–1）→ AU26 / AU27 的强度 / Mouth opening (0–1) → AU26 / AU27 intensities. */
export function mouthAUs(mouth: number): AUs {
  const m = Math.min(1, Math.max(0, mouth))
  if (m <= 0) return {}
  return { AU26: Math.min(5, m * 5), AU27: Math.max(0, (m - 0.6) / 0.4) * 5 }
}

function sampleVoice(): { mouth: number; airflow: number; playing: boolean } {
  const s = scheduled
  if (!s || !context) return { mouth: 0, airflow: 0, playing: false }
  const tl = s.vocalisation.timeline
  const t = context.currentTime - s.startTime
  if (t >= tl.durationS + 0.05 || context.currentTime > s.endTime + 0.2) {
    scheduled = null
    return { mouth: 0, airflow: 0, playing: false }
  }
  if (t < 0) return { mouth: 0, airflow: 0, playing: true }
  const i = Math.min(tl.mouth.length - 1, Math.floor(t * tl.frameRate))
  return { mouth: tl.mouth[i] ?? 0, airflow: tl.airflow[i] ?? 0, playing: true }
}

/**
 * 当前这一帧的 AU 强度：疼痛强度经时间包络得到的 AU、手动设定的 AU（取较大者），再叠加发声的张口。
 * The AU intensities of this frame: the pain level through its time envelope, the manually set
 * AUs (element-wise maximum), and the mouth opening of the vocalisation on top.
 */
export function painFrame(now: number): PainFrame {
  const s = useApp.getState()
  const face = s.face
  if (!face) return { aus: {}, animating: false, airflow: 0 }
  const dt = lastNow ? Math.min(0.1, Math.max(0, (now - lastNow) / 1000)) : 0
  lastNow = now
  const timing = face.data.pain.timing
  // "保持"：包络按起止时间常数平滑地趋向 1 或 0 / hold: the envelope slews towards 1 or 0 with the onset / offset times
  const target = s.pain.hold ? 1 : 0
  if (holdEnv < target) holdEnv = Math.min(target, holdEnv + dt / Math.max(0.05, timing.onset))
  else if (holdEnv > target) holdEnv = Math.max(target, holdEnv - dt / Math.max(0.05, timing.offset))
  let aus: AUs = {}
  let animating = holdEnv !== target
  if (holdEnv > 0) {
    const base = painAUs(face.data.pain, s.pain.level)
    for (const [id, v] of Object.entries(base)) aus[id] = v * holdEnv
  }
  if (episode) {
    const t = (now - episode.t0) / 1000
    const env = t < 0 ? 0 : envelope(timing, t, episode.duration)
    const done = t > episode.duration + timing.latency + timing.offset + 0.05
    if (done) episode = null
    else {
      animating = true
      const e: AUs = {}
      for (const [id, v] of Object.entries(painAUs(face.data.pain, episode.level))) e[id] = v * env
      aus = maxAUs(aus, e)
    }
  }
  if (external > 0) {
    // 刺激模型逐帧给出的强度（见 stim.ts）：直接换成表情，不经过包络
    // the intensity the stimulus model gives frame by frame (see stim.ts): straight to the expression, no envelope
    animating = true
    aus = maxAUs(aus, painAUs(face.data.pain, external))
  }
  aus = maxAUs(aus, s.aus)
  const v = sampleVoice()
  if (v.playing) {
    animating = true
    aus = maxAUs(aus, mouthAUs(v.mouth))
  }
  return { aus: cleanAUs(aus), animating, airflow: v.airflow }
}

async function ensureVoice(): Promise<PainVoice> {
  if (voice) return voice
  if (!voiceLoading) {
    useApp.setState({ voiceStatus: 'loading', voiceProgress: 0 })
    if (!VOICE_PACK) {
      // 商业构建不带录音包：不发请求，直接用参数合成器 / a commercial build ships no recordings: no request, straight to the parametric synthesizer
      voice = new PainVoice(null)
      useApp.setState({ voiceStatus: 'synthetic', voiceProgress: 1 })
      return Promise.resolve(voice)
    }
    let done = 0
    // 逐个文件计数来报告进度 / progress is reported by counting files as they arrive
    const counting = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = await fetch(input, init)
      done++
      useApp.setState({ voiceProgress: Math.min(1, done / VOICE_PACK_FILES) })
      return r
    }) as typeof fetch
    voiceLoading = loadVoicePack(VOICE_PACK_URL, counting).then((pack) => {
      voice = new PainVoice(pack)
      // 没有录音包（例如商业部署删掉了它）时用参数合成器 / without the pack (e.g. removed for a commercial deployment) the parametric synthesizer is used
      useApp.setState({ voiceStatus: voice.hasRecordings ? 'ready' : 'synthetic', voiceProgress: 1 })
      return voice
    })
  }
  return voiceLoading
}

/**
 * 触发一次疼痛反应。必须在用户手势（点击、按键）里调用：浏览器不允许无手势播放声音。
 * 静音时只有表情。第一次有声触发会先下载录音包（约 8.6 MB），表情等声音就绪后一起开始。
 * Trigger one pain response. Must be called from a user gesture (click, key): browsers do not
 * play sound without one. Muted, only the face responds. The first unmuted trigger downloads the
 * sound pack (about 8.6 MB) and the face waits so that both start together.
 */
export async function triggerPain(): Promise<void> {
  const s = useApp.getState()
  const { level, onset, muted, always } = s.pain
  if (level <= 0) return
  void s.ensureFace()
  void s.ensureRig() // 张口要靠下颌关节 / the jaw joint is what opens the mouth
  const duration = STIMULUS_SECONDS[onset]
  if (muted || typeof AudioContext === 'undefined') {
    episode = { t0: performance.now(), duration, level }
    useApp.setState((x) => ({ painNonce: x.painNonce + 1 }))
    return
  }
  // 在手势里创建 / 恢复音频上下文，之后才能在加载完成时出声
  // create / resume the audio context inside the gesture so sound can start once loading is done
  context ??= new AudioContext()
  // 没有用户手势时 resume() 可能一直不返回：等一小会儿，还不行就只做表情
  // without a user gesture resume() may never settle: wait briefly, and if still silent let the face respond alone
  if (context.state === 'suspended') await Promise.race([context.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 400))])
  if (context.state !== 'running') {
    episode = { t0: performance.now(), duration, level }
    useApp.setState((x) => ({ painNonce: x.painNonce + 1 }))
    return
  }
  const v = await ensureVoice()
  const body = useApp.getState().graph?.data.body ?? 'male'
  scheduled?.source?.stop()
  scheduled = schedulePainVocalisation(context, { intensity: level, onset, sex: body, seed: seed++, vocalise: always ? 'always' : 'auto' }, context.currentTime + 0.05, context.destination, v)
  // 表情与声音对齐：刺激开始 = 声音开始 / face and sound aligned: stimulus onset = start of the sound
  episode = { t0: performance.now() + (scheduled.startTime - context.currentTime) * 1000, duration, level }
  useApp.setState((x) => ({
    painNonce: x.painNonce + 1,
    lastVoice: { source: scheduled!.source ? scheduled!.vocalisation.source : 'none', type: scheduled!.vocalisation.type, probability: scheduled!.vocalisation.soundProbability },
  }))
}

/** 刺激模型此刻的疼痛强度（0–10）；0 表示没有 / The stimulus model's pain intensity right now (0–10); 0 = none. */
export function setExternalPainLevel(level: number): void {
  external = Math.min(10, Math.max(0, level))
}

/**
 * 在用户手势里调用：准备好音频上下文，稍后（不在手势里）才能出声。静音时什么都不做。
 * Call inside a user gesture: readies the audio context so that sound can start a little later,
 * outside the gesture. Does nothing while muted.
 */
export function primeVoice(): void {
  if (useApp.getState().pain.muted || typeof AudioContext === 'undefined') return
  context ??= new AudioContext()
  if (context.state === 'suspended') void context.resume().catch(() => undefined)
  void ensureVoice()
}

/**
 * 按给定强度发一次声（不带表情包络；张口由声音带动）。音频上下文没有在手势里准备好时不出声。
 * One vocalisation at the given intensity (no expression envelope; the sound drives the mouth).
 * Silent when the audio context was not readied in a gesture.
 */
export async function vocalise(level: number, onset: 'sudden' | 'sustained'): Promise<void> {
  const { pain, graph } = useApp.getState()
  if (pain.muted || level <= 0 || !context || context.state !== 'running') return
  const v = await ensureVoice()
  if (context.state !== 'running') return
  scheduled?.source?.stop()
  scheduled = schedulePainVocalisation(context, { intensity: level, onset, sex: graph?.data.body ?? 'male', seed: seed++, vocalise: pain.always ? 'always' : 'auto' }, context.currentTime + 0.03, context.destination, v)
  useApp.setState({ lastVoice: { source: scheduled.source ? scheduled.vocalisation.source : 'none', type: scheduled.vocalisation.type, probability: scheduled.vocalisation.soundProbability } })
}

/** 停止声音并结束当前的反应 / Stop the sound and end the current response. */
export function stopPain(): void {
  scheduled?.source?.stop()
  scheduled = null
  episode = null
}

/** 页面隐藏时暂停声音与计时，回来时接着走 / Suspend sound and timing while the page is hidden; carry on afterwards. */
export function setPainPaused(paused: boolean): void {
  if (paused) {
    if (pausedAt === null) pausedAt = performance.now()
    if (context?.state === 'running') void context.suspend()
    return
  }
  if (pausedAt !== null) {
    if (episode) episode.t0 += performance.now() - pausedAt
    pausedAt = null
    lastNow = 0
  }
  if (context?.state === 'suspended' && scheduled) void context.resume()
}

/** 测试用：清掉模块内的状态 / For tests: clear the module's state. */
export function resetPainController(): void {
  episode = null
  holdEnv = 0
  lastNow = 0
  scheduled = null
  pausedAt = null
  external = 0
}

/** 测试用：直接开始一次没有声音的反应 / For tests: start a silent response directly. */
export function startSilentEpisode(now: number, level: number, duration: number): void {
  episode = { t0: now, duration, level }
}
