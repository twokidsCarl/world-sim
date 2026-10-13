// Web Audio 的薄封装：把渲染结果放进 AudioBuffer，在共享时钟上的指定时刻播放。信号处理都在 synth.ts 里。
// A thin Web Audio wrapper: put a rendering into an AudioBuffer and play it at a given time on the
// shared clock. All signal processing lives in synth.ts.

import { painVocalisation, type PainVocalisation } from './control.ts'
import { renderPainVocalisation, type PainVoice, type PainVoiceInput } from './recorded.ts'
import { mouthTrack, type MouthFrame } from './mouth.ts'
import type { RenderResult } from './types.ts'

export function toAudioBuffer(ctx: BaseAudioContext, result: RenderResult): AudioBuffer {
  const buffer = ctx.createBuffer(1, result.pcm.length, result.sampleRate)
  buffer.getChannelData(0).set(result.pcm)
  return buffer
}

export interface ScheduledVocalisation {
  vocalisation: PainVocalisation
  // 没有声音时为 null / null when there is no sound
  source: AudioBufferSourceNode | null
  // 在 AudioContext 时钟上的起止时刻（秒）；时间线上的时刻 t 对应 startTime + t。
  // Start and end on the AudioContext clock (s); time t on the timeline corresponds to startTime + t.
  startTime: number
  endTime: number
}

// 生成并安排一次发声。when 是 AudioContext.currentTime 刻度上的时刻；面部表情用返回的
// startTime 加上 vocalisation.timeline 里的时刻来对齐。给了 voice 且它带着录音包时用录音，否则用参数合成器。
// Generate and schedule one vocalisation. `when` is on the AudioContext.currentTime scale; facial
// animation aligns itself with the returned startTime plus the times in vocalisation.timeline. With a
// `voice` that holds the sound pack the recordings are used; otherwise the parametric synthesizer.
export function schedulePainVocalisation(ctx: AudioContext, input: PainVoiceInput, when = ctx.currentTime, destination: AudioNode = ctx.destination, voice?: PainVoice): ScheduledVocalisation {
  const vocalisation = voice ? voice.vocalise(input) : painVocalisation(input)
  // 合成来源按上下文的采样率直接渲染；录音来源保持录音包的采样率，由浏览器重采样。
  // Synthetic sound is rendered at the context's own rate; recorded sound keeps the pack's rate and the browser resamples it.
  const result = renderPainVocalisation(vocalisation, vocalisation.recorded ? undefined : ctx.sampleRate)
  if (!result) return { vocalisation, source: null, startTime: when, endTime: when }
  const source = ctx.createBufferSource()
  source.buffer = toAudioBuffer(ctx, result)
  source.connect(destination)
  const startTime = Math.max(when, ctx.currentTime)
  source.start(startTime)
  return { vocalisation, source, startTime, endTime: startTime + result.pcm.length / result.sampleRate }
}

export interface AnalysedAudio {
  buffer: AudioBuffer
  durationS: number
  // 每秒 100 帧，第 i 帧对应时刻 i / 100 秒 / 100 frames per second, frame i at time i / 100 s
  frames: MouthFrame[]
  // 在共享时钟上的 when 时刻开始播放；返回的 startTime 加上帧的 t 就是这一帧的时刻。
  // Starts playback at `when` on the shared clock; the returned startTime plus a frame's t is that frame's time.
  play(when?: number, destination?: AudioNode): { source: AudioBufferSourceNode; startTime: number; endTime: number }
  // 时钟时刻 contextTime 对应的帧；还没开始或已经结束时返回 null。
  // The frame for clock time contextTime; null before the start or after the end.
  frameAt(contextTime: number, startTime: number): MouthFrame | null
}

// 分析用户选的音频文件：在页面里解码、混成单声道、算出口型轨迹。不联网，文件不离开页面。
// Analyses an audio file chosen by the user: decoded in the page, mixed to mono, mouth track computed.
// No network is involved and the file never leaves the page.
export async function analyseAudioFile(ctx: AudioContext, data: Blob | ArrayBuffer): Promise<AnalysedAudio> {
  const bytes = data instanceof ArrayBuffer ? data.slice(0) : await data.arrayBuffer()
  const buffer = await ctx.decodeAudioData(bytes)
  const mono = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c)
    for (let i = 0; i < mono.length; i++) mono[i] = mono[i]! + ch[i]! / buffer.numberOfChannels
  }
  const frames = mouthTrack(mono, buffer.sampleRate)
  return {
    buffer,
    durationS: buffer.duration,
    frames,
    play(when = ctx.currentTime, destination: AudioNode = ctx.destination) {
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(destination)
      const startTime = Math.max(when, ctx.currentTime)
      source.start(startTime)
      return { source, startTime, endTime: startTime + buffer.duration }
    },
    frameAt(contextTime, startTime) {
      const i = Math.floor((contextTime - startTime) * 100)
      return i >= 0 && i < frames.length ? frames[i]! : null
    },
  }
}
