// Web Audio 的薄封装：把渲染结果放进 AudioBuffer，在共享时钟上的指定时刻播放。信号处理都在 synth.ts 里。
// A thin Web Audio wrapper: put a rendering into an AudioBuffer and play it at a given time on the
// shared clock. All signal processing lives in synth.ts.

import { painVocalisation, type PainVocalisation, type PainVocalisationInput } from './control.ts'
import { renderVocalisation } from './synth.ts'
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
// startTime 加上 vocalisation.timeline 里的时刻来对齐。
// Generate and schedule one vocalisation. `when` is on the AudioContext.currentTime scale; facial
// animation aligns itself with the returned startTime plus the times in vocalisation.timeline.
export function schedulePainVocalisation(ctx: AudioContext, input: PainVocalisationInput, when = ctx.currentTime, destination: AudioNode = ctx.destination): ScheduledVocalisation {
  const vocalisation = painVocalisation(input)
  if (!vocalisation.params) return { vocalisation, source: null, startTime: when, endTime: when }
  // 按上下文的采样率直接渲染，不用重采样 / render at the context's own sample rate, so nothing is resampled
  const result = renderVocalisation(vocalisation.params, ctx.sampleRate)
  const source = ctx.createBufferSource()
  source.buffer = toAudioBuffer(ctx, result)
  source.connect(destination)
  const startTime = Math.max(when, ctx.currentTime)
  source.start(startTime)
  return { vocalisation, source, startTime, endTime: startTime + result.pcm.length / result.sampleRate }
}
