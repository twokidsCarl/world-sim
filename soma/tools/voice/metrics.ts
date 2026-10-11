// 两段时间上对齐的声音之间的距离，用来度量变换（变调、变速、缩放共振峰）带来的失真。
// 定义：
// - 对数梅尔谱：25 毫秒汉宁窗、10 毫秒帧移，60 个三角形梅尔滤波器覆盖 60–8000 Hz，功率取自然对数。
// - 对数梅尔距离（dB）：两段的对数梅尔谱逐帧逐带相减（先去掉整体增益差），取均方根，换成 dB。
// - 梅尔倒谱失真 MCD（dB）：对数梅尔谱做 DCT-II 得倒谱，取第 1–13 项（不含第 0 项），
//   每帧 (10 / ln 10)·sqrt(2·Σ Δc²)，再对帧平均。没有做动态时间规整：两段按已知的时间映射对齐。
// 只统计参考信号里比其最响一帧低不超过 40 dB 的帧。这里的 MCD 建立在 60 带梅尔谱上，
// 和语音合成文献里基于 mel-generalised cepstrum 的 MCD 数值不能直接比较。
// Distances between two time-aligned sounds, used to measure the distortion a transformation (pitch
// shift, time stretch, formant scaling) introduces. Definitions:
// - log-mel spectrogram: 25 ms Hann window, 10 ms hop, 60 triangular mel filters over 60–8000 Hz,
//   natural log of power.
// - log-mel distance (dB): RMS over frames and bands of the difference between the two log-mel
//   spectrograms (after removing the overall gain difference), expressed in dB.
// - mel-cepstral distortion MCD (dB): cepstra by DCT-II of the log-mel spectrum, coefficients 1–13
//   (without the 0th); per frame (10 / ln 10)·sqrt(2·Σ Δc²), averaged over frames. No dynamic time
//   warping: the two sounds are aligned by their known time mapping.
// Only frames of the reference within 40 dB of its loudest frame are counted. This MCD rests on a
// 60-band mel spectrum and is not numerically comparable to the mel-generalised-cepstrum MCD of the
// speech-synthesis literature.

import { fft } from './analysis.ts'

const BANDS = 60
const LO_HZ = 60
const HI_HZ = 8000
const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700)
const melInv = (m: number) => 700 * (10 ** (m / 2595) - 1)

export interface LogMel {
  frames: number
  bands: number
  data: Float32Array
  // 每帧的总功率（dB）/ total power per frame (dB)
  powerDb: Float32Array
}

// warp：把频率轴乘以这个数再取滤波器（用来和共振峰被缩放过的声音比较）。
// warp: multiplies the frequency axis before the filters are applied (for comparing against a sound whose formants were scaled).
export function logMel(x: Float32Array, sampleRate: number, warp = 1): LogMel {
  const win = Math.round(0.025 * sampleRate)
  const hop = Math.round(0.01 * sampleRate)
  let size = 1
  while (size < win) size <<= 1
  const frames = Math.max(0, Math.floor((x.length - win) / hop) + 1)
  const edges = Array.from({ length: BANDS + 2 }, (_, i) => (melInv(mel(LO_HZ) + ((mel(HI_HZ) - mel(LO_HZ)) * i) / (BANDS + 1)) * warp * size) / sampleRate)
  const data = new Float32Array(frames * BANDS)
  const powerDb = new Float32Array(frames)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  for (let f = 0; f < frames; f++) {
    re.fill(0); im.fill(0)
    let total = 0
    for (let i = 0; i < win; i++) { const v = x[f * hop + i]!; total += v * v; re[i] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win)) }
    powerDb[f] = 10 * Math.log10(total / win + 1e-12)
    fft(re, im)
    for (let b = 0; b < BANDS; b++) {
      const lo = edges[b]!
      const mid = edges[b + 1]!
      const hi = edges[b + 2]!
      let s = 0
      for (let k = Math.max(1, Math.ceil(lo)); k <= Math.min(size / 2 - 1, Math.floor(hi)); k++) {
        const w = k <= mid ? (k - lo) / (mid - lo) : (hi - k) / (hi - mid)
        s += w * (re[k]! * re[k]! + im[k]! * im[k]!)
      }
      data[f * BANDS + b] = Math.log(s / size + 1e-10)
    }
  }
  return { frames, bands: BANDS, data, powerDb }
}

export interface Distance {
  logMelDb: number
  mcdDb: number
  frames: number
}

// timeRatio：test 的时长是 ref 的多少倍；ref 的第 f 帧对应 test 的第 f·timeRatio 帧。
// timeRatio: how many times longer test is than ref; frame f of ref corresponds to frame f·timeRatio of test.
export function distance(ref: LogMel, test: LogMel, timeRatio = 1): Distance {
  let peak = -Infinity
  for (const p of ref.powerDb) peak = Math.max(peak, p)
  const pairs: [number, number][] = []
  for (let f = 0; f < ref.frames; f++) {
    const g = Math.round(f * timeRatio)
    if (g < test.frames && ref.powerDb[f]! > peak - 40) pairs.push([f, g])
  }
  if (pairs.length === 0) return { logMelDb: NaN, mcdDb: NaN, frames: 0 }
  // 整体增益差 / overall gain difference
  let offset = 0
  for (const [f, g] of pairs) for (let b = 0; b < BANDS; b++) offset += test.data[g * BANDS + b]! - ref.data[f * BANDS + b]!
  offset /= pairs.length * BANDS
  let sq = 0
  let mcd = 0
  const d = new Float64Array(BANDS)
  for (const [f, g] of pairs) {
    for (let b = 0; b < BANDS; b++) { d[b] = test.data[g * BANDS + b]! - ref.data[f * BANDS + b]! - offset; sq += d[b]! * d[b]! }
    let s = 0
    for (let c = 1; c <= 13; c++) {
      let v = 0
      for (let b = 0; b < BANDS; b++) v += d[b]! * Math.cos((Math.PI * c * (b + 0.5)) / BANDS)
      // 倒谱系数按「对数幅度谱 = c0 + 2·Σ c_k·cos」的约定：c_k = (1/B)·Σ ln|幅度|·cos；d 是对数功率，所以再乘 1/2
      // cepstral coefficients in the convention "log amplitude spectrum = c0 + 2·Σ c_k·cos": c_k = (1/B)·Σ ln|amplitude|·cos; d is log power, hence the extra 1/2
      v *= 0.5 / BANDS
      s += v * v
    }
    mcd += (10 / Math.LN10) * Math.sqrt(2 * s)
  }
  return { logMelDb: (10 / Math.LN10) * Math.sqrt(sq / (pairs.length * BANDS)), mcdDb: mcd / pairs.length, frames: pairs.length }
}
