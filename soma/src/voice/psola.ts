// 在录音上做变化：变调、变速、缩放共振峰。方法是时域基音同步叠加（TD-PSOLA）：
// 沿基频轨迹在每个声门周期放一个标记，以标记为中心取两个周期长的加窗片段，再按新的间距叠加回去。
// 改变片段间距就改变了音高，而每个片段的频谱包络（共振峰）不变；重复或跳过片段就改变了时长。
// 共振峰缩放（由女声推出男声时用）另外靠重采样完成：放慢 1/a 倍使共振峰和音高都乘以 a，再用上面的方法把音高和时长改回目标值。
// Variation on recordings: pitch shift, time stretch and formant scaling, by time-domain
// pitch-synchronous overlap-add (TD-PSOLA). A mark is placed at every glottal cycle along the F0 track,
// a windowed grain two periods long is taken around each mark, and the grains are overlap-added at a
// new spacing. Changing the spacing changes the pitch while each grain keeps its spectral envelope
// (the formants); repeating or skipping grains changes the duration. Formant scaling (used to derive a
// male voice from female recordings) is done separately by resampling: slowing down by 1/a multiplies
// formants and pitch by a, after which the method above brings pitch and duration to their targets.

import { resample } from './resample.ts'

export interface TransformOptions {
  // 音高倍数（1 = 不变）/ pitch factor (1 = unchanged)
  pitchRatio: number
  // 时长倍数（1 = 不变）/ duration factor (1 = unchanged)
  timeRatio: number
  // 共振峰倍数（1 = 不变；小于 1 相当于更长的声道）/ formant factor (1 = unchanged; below 1 corresponds to a longer vocal tract)
  formantRatio?: number
}

// 内部在两倍采样率下工作：高基频时一个周期只有二三十个采样点，整数位置的误差会变成听得见的抖动。
// Internally everything runs at twice the sample rate: at high F0 a period is only twenty or thirty
// samples long, and whole-sample placement errors would turn into audible jitter.
const OVERSAMPLE = 2
const UNVOICED_HOP_S = 0.005

// f0Track：每秒 frameRate 帧，第 i 帧对应时刻 i / frameRate，0 表示无声。返回与输入同采样率的新波形。
// f0Track: frameRate frames per second, frame i at time i / frameRate, 0 = unvoiced. Returns a new
// waveform at the input's sample rate.
export function transformClip(pcm: Float32Array, sampleRate: number, f0Track: ArrayLike<number>, frameRate: number, opt: TransformOptions): Float32Array {
  const a = opt.formantRatio ?? 1
  const pitch = opt.pitchRatio / a
  const stretch = opt.timeRatio * a
  const sr = sampleRate * OVERSAMPLE
  // 先做共振峰缩放（和两倍过采样合成一次重采样）/ formant scaling first (folded into the oversampling step)
  const x = resample(pcm, sampleRate * a, sr)
  const n = x.length
  // 缩放后的时间轴上时刻 t 的基频 / F0 at time t on the scaled time axis
  const f0At = (sample: number) => {
    const frame = Math.round((sample / sr) * a * frameRate)
    const f = f0Track[Math.min(f0Track.length - 1, Math.max(0, frame))] ?? 0
    return f > 0 ? f * a : 0
  }
  // 波形的极性：取峰值更突出的一侧放标记 / polarity: marks go on the side with the more prominent peaks
  let pos = 0
  let neg = 0
  for (let i = 0; i < n; i++) { const v = x[i]!; if (v > pos) pos = v; if (-v > neg) neg = -v }
  const sign = pos >= neg ? 1 : -1

  // 分析标记 / analysis marks
  const marks: number[] = []
  const periods: number[] = []
  const hop = Math.round(UNVOICED_HOP_S * sr)
  let t = 0
  let wasVoiced = false
  while (t < n) {
    const f = f0At(t)
    if (f <= 0) {
      marks.push(t); periods.push(-hop)
      t += hop
      wasVoiced = false
      continue
    }
    const period = sr / f
    // 有声段的第一个标记在第一个周期内找峰；之后每次在预测位置前后四分之一周期内找峰。
    // The first mark of a voiced stretch is the peak within the first period; each later one is the
    // peak within a quarter period of the predicted position.
    const from = wasVoiced ? Math.round(t - period * 0.25) : t
    const to = wasVoiced ? Math.round(t + period * 0.25) : Math.round(t + period)
    let best = Math.min(n - 1, Math.max(0, wasVoiced ? Math.round(t) : t))
    let bestV = -Infinity
    for (let i = Math.max(0, from); i <= to && i < n; i++) if (x[i]! * sign > bestV) { bestV = x[i]! * sign; best = i }
    if (marks.length && best <= marks[marks.length - 1]!) best = marks[marks.length - 1]! + 1
    marks.push(best); periods.push(period)
    t = Math.round(best + period)
    wasVoiced = true
  }
  if (marks.length === 0) return new Float32Array(Math.max(1, Math.round(pcm.length * opt.timeRatio)))

  // 合成 / synthesis
  // 每个片段的窗是不对称的：左半边伸到前一个标记，右半边伸到后一个标记。这样不做任何改变时
  // 各窗相加恰好为 1，输出与输入逐样本相同（除了重采样的误差）。
  // Each grain's window is asymmetric: its left half reaches back to the previous mark and its right
  // half forward to the next. With no change asked for, the windows then sum to exactly 1 and the
  // output equals the input sample for sample (apart from resampling error).
  const m = Math.max(1, Math.round(n * stretch))
  const out = new Float32Array(m)
  const last = marks.length - 1
  const spacing = (i: number) => (i < last ? marks[i + 1]! - marks[i]! : i > 0 ? marks[i]! - marks[i - 1]! : hop)
  let cursor = 0
  let tOut = marks[0]! * stretch
  let lastMark = -1
  let flip = false
  while (tOut < m) {
    const tIn = tOut / stretch
    while (cursor < last && Math.abs(marks[cursor + 1]! - tIn) <= Math.abs(marks[cursor]! - tIn)) cursor++
    const mark = marks[cursor]!
    const voiced = periods[cursor]! > 0
    const left = cursor > 0 ? mark - marks[cursor - 1]! : spacing(0)
    const right = spacing(cursor)
    // 无声段里同一片段被重复使用时把它倒过来放，免得重复出周期性 / in unvoiced stretches a grain that is reused is reversed, so that repetition does not create periodicity
    flip = !voiced && mark === lastMark ? !flip : false
    lastMark = mark
    // 音高升高时片段叠得更密，按比例减小幅度 / raising the pitch packs grains more densely; scale them down in proportion
    const g = voiced && pitch > 1 ? 1 / pitch : 1
    const centre = Math.round(tOut)
    for (let j = -left + 1; j < right; j++) {
      const src = mark + (flip ? -j : j)
      const dst = centre + j
      if (src < 0 || src >= n || dst < 0 || dst >= m) continue
      const w = j < 0 ? 0.5 + 0.5 * Math.cos((Math.PI * j) / left) : 0.5 + 0.5 * Math.cos((Math.PI * j) / right)
      out[dst] = out[dst]! + x[src]! * w * g
    }
    tOut += voiced ? right / pitch : right
  }
  const y = resample(out, sr, sampleRate)
  // 整体响度对齐到原片段 / overall loudness is matched to the original clip
  let ex = 0
  let ey = 0
  for (let i = 0; i < pcm.length; i++) ex += pcm[i]! * pcm[i]!
  for (let i = 0; i < y.length; i++) ey += y[i]! * y[i]!
  const gain = ey > 0 ? Math.sqrt(ex / pcm.length / (ey / y.length)) : 1
  for (let i = 0; i < y.length; i++) y[i] = y[i]! * gain
  return y
}
