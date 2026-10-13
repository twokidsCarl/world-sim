// "由音频带动口形"：用户选的音频文件在页面里解码、分析成口形轨迹，播放时口形逐帧跟随。没有语音合成，文件不离开页面。
// "Speak from audio": an audio file the user chose is decoded and analysed into a mouth track in the page, and the mouth
// follows it frame by frame during playback. There is no speech synthesis, and the file never leaves the page.
//
// 从声音推出的口形是近似的：开口度可靠，圆唇一般，闭合较弱（只当作一般的闭唇），唇齿音（f、v）检测不出来。
// 特征 → 口形的规则在 tools/face/model.ts 的 mouthFrameToChannels，这里逐帧调用它，所以应用里的结果与参考实现一致。
// Mouth shapes from sound are approximate: opening is reliable, rounding moderate, closure weak (treated as a generic lip
// closure) and labiodentals (f, v) are not detected. The feature → shape rules are mouthFrameToChannels of
// tools/face/model.ts, called here for every frame, so what the app shows equals the reference.

import { mouthFrameToChannels, type Activations, type MouthPose, type MouthState } from '../../tools/face/model.ts'
import { useApp } from '../state/store.ts'
import { analyseAudioFile, type AnalysedAudio, type MouthFrame } from '../voice/index.ts'
import type { FaceData } from './types.ts'

/** 超过这个时长的音频不分析（分析是同步的，约每分钟音频 1 秒）/ Audio longer than this is not analysed (the analysis is synchronous, about 1 s per minute of audio). */
export const MAX_SPEECH_SECONDS = 600

let context: AudioContext | null = null
let analysed: AnalysedAudio | null = null
let playing: { source: AudioBufferSourceNode; startTime: number; endTime: number } | null = null
let token = 0

/** 逐帧推进的平滑状态：index 是已经算到的帧，before 是算这一帧之前的状态 / The smoothing state advanced frame by frame: `index` is the frame reached, `before` the state before it. */
let index = -1
let before: MouthState | undefined
let state: MouthState | undefined
let last: { face: FaceData; index: number; out: SpeechSample } | null = null

export interface SpeechSample {
  /** 帧下标（每秒 100 帧）/ frame index (100 per second). */
  index: number
  frame: MouthFrame
  state: MouthState
  pose: MouthPose
  channels: Activations
  jaw: number
}

const setStatus = (patch: Partial<ReturnType<typeof useApp.getState>['speech']>): void => useApp.setState((s) => ({ speech: { ...s.speech, ...patch } }))

function ensureContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  context ??= new AudioContext()
  return context
}

/**
 * 读入并分析一个音频文件。可以不在用户手势里调用（解码不需要）；播放另由 playSpeech 在手势里开始。
 * Load and analyse an audio file. Need not be called in a user gesture (decoding does not need one); playback is started
 * separately by playSpeech, inside a gesture.
 */
export async function loadSpeech(data: Blob | ArrayBuffer, name: string): Promise<boolean> {
  stopSpeech()
  const mine = ++token
  const ctx = ensureContext()
  if (!ctx) {
    setStatus({ status: 'error', name, durationS: 0, message: '这个浏览器没有 Web Audio / this browser has no Web Audio' })
    return false
  }
  analysed = null
  setStatus({ status: 'analysing', name, durationS: 0, message: '' })
  // 让"正在分析"先画出来，再做同步的分析 / let "analysing" paint before the synchronous analysis
  await new Promise((r) => setTimeout(r, 30))
  try {
    const bytes = data instanceof ArrayBuffer ? data : await data.arrayBuffer()
    const a = await analyseAudioFileBounded(ctx, bytes)
    if (mine !== token) return false
    analysed = a
    setStatus({ status: 'ready', name, durationS: a.durationS, message: '' })
    return true
  } catch (err) {
    if (mine !== token) return false
    setStatus({ status: 'error', name, durationS: 0, message: err instanceof Error ? err.message : String(err) })
    return false
  }
}

async function analyseAudioFileBounded(ctx: AudioContext, bytes: ArrayBuffer): Promise<AnalysedAudio> {
  // 压缩格式的时长要解码才知道；这里按字节数先挡掉明显过大的文件（未压缩 48 kHz 立体声 16 位约 11.5 MB / 分钟）
  // a compressed file's duration is known only after decoding; plainly oversized files are refused by byte count first
  // (uncompressed 48 kHz stereo 16-bit is about 11.5 MB a minute)
  if (bytes.byteLength > 200 * 1048576) throw new Error('文件超过 200 MB / the file is over 200 MB')
  let a: AnalysedAudio
  try {
    a = await analyseAudioFile(ctx, bytes)
  } catch (err) {
    throw new Error(`无法解码这个音频文件 / this audio file could not be decoded${err instanceof Error && err.message ? `: ${err.message}` : ''}`)
  }
  if (a.durationS > MAX_SPEECH_SECONDS) throw new Error(`音频超过 ${MAX_SPEECH_SECONDS / 60} 分钟 / the audio is longer than ${MAX_SPEECH_SECONDS / 60} minutes`)
  return a
}

/**
 * 从头播放。必须在用户手势（点击、按键）里调用：浏览器不允许无手势出声。返回是否真的开始了。
 * Play from the start. Must be called inside a user gesture (click, key): browsers do not play sound without one.
 * Returns whether playback really started.
 */
export async function playSpeech(): Promise<boolean> {
  const ctx = context, a = analysed
  if (!ctx || !a) return false
  const mine = token
  if (ctx.state === 'suspended') await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 400))])
  if (mine !== token || analysed !== a) return false
  if (ctx.state !== 'running') {
    setStatus({ status: 'ready', message: '浏览器没有允许播放：请直接点“播放” / the browser did not allow playback: press Play directly' })
    return false
  }
  halt()
  const p = a.play(ctx.currentTime + 0.05)
  playing = p
  p.source.onended = () => {
    if (playing !== p) return
    playing = null
    resetTrack()
    setStatus({ status: 'ready' })
  }
  resetTrack()
  setStatus({ status: 'playing', message: '' })
  // 张口要靠下颌关节 / the jaw joint is what opens the mouth
  void useApp.getState().ensureFace()
  void useApp.getState().ensureRig()
  return true
}

function resetTrack(): void {
  index = -1
  before = undefined
  state = undefined
  last = null
}

function halt(): void {
  const p = playing
  playing = null
  if (p) {
    p.source.onended = null
    try {
      p.source.stop()
    } catch {
      // 还没开始或已经结束 / not started yet, or already ended
    }
  }
  resetTrack()
}

/** 停止播放；分析结果留着，可以重播 / Stop playback; the analysis is kept, so it can be replayed. */
export function stopSpeech(): void {
  const was = !!playing
  halt()
  if (was) setStatus({ status: 'ready' })
}

/** 丢掉音频和分析结果 / Drop the audio and its analysis. */
export function clearSpeech(): void {
  halt()
  token++
  analysed = null
  setStatus({ status: 'idle', name: '', durationS: 0, message: '' })
}

/** 播放头在音轨上的时刻（秒）；没有在播放时为 null / The playhead's time on the track (seconds); null when not playing. */
export function speechTime(): number | null {
  if (!playing || !context) return null
  // 听到的声音比时钟晚一个输出延迟 / what is heard lags the clock by the output latency
  const latency = Math.min(0.2, Math.max(0, context.outputLatency || 0))
  return context.currentTime - latency - playing.startTime
}

/**
 * 此刻的口形（正在播放时），按给定人体的数据换成通道。平滑状态从第 0 帧逐帧推进，所以与"把 mouthFrameToChannels
 * 从头按每秒 100 帧跑到这一帧"的结果完全相同，不随渲染帧率变化。
 * The mouth shape right now (while playing), turned into channels with the given body's data. The smoothing state advances
 * frame by frame from frame 0, so the result is exactly what running mouthFrameToChannels from the start at 100 frames a
 * second up to this frame gives, whatever the rendering frame rate.
 */
export function speechFrame(face: FaceData): SpeechSample | null {
  const a = analysed
  const t = speechTime()
  if (!a || t === null) return null
  const i = Math.floor(t * 100)
  if (i < 0 || i >= a.frames.length) return null
  if (last && last.index === i && last.face === face) return last.out
  if (i !== index) {
    let st = i > index ? state : undefined
    for (let k = i > index && index >= 0 ? index + 1 : 0; k < i; k++) st = mouthFrameToChannels(face, a.frames[k]!, st).state
    before = st
    index = i
  }
  const r = mouthFrameToChannels(face, a.frames[i]!, before)
  state = r.state
  const out: SpeechSample = { index: i, frame: a.frames[i]!, state: r.state, pose: r.pose, channels: r.channels, jaw: r.jaw }
  last = { face, index: i, out }
  return out
}

/** 最近一次算出的口形（验证用）/ The mouth shape last computed (verification). */
export function lastSpeechSample(): SpeechSample | null {
  return last?.out ?? null
}

/** 界面上的小条用：整条轨迹和播放头 / For the strip in the UI: the whole track and the playhead. */
export function speechTrack(): { frames: readonly MouthFrame[]; durationS: number; time: number | null } | null {
  return analysed ? { frames: analysed.frames, durationS: analysed.durationS, time: speechTime() } : null
}

/** 页面隐藏时暂停音频时钟（口形随之停住），回来时接着播 / Suspend the audio clock while the page is hidden (the mouth stops with it); carry on afterwards. */
export function setSpeechPaused(paused: boolean): void {
  if (!context) return
  if (paused) {
    if (context.state === 'running' && playing) void context.suspend()
  } else if (context.state === 'suspended' && playing) void context.resume()
}
