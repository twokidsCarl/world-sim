// 声学分析：对语料录音和合成器输出用完全相同的代码与参数，这样两边的数字才可比。
// 方法是自写的简化版（思路取自 Boersma 1993 的自相关基频法），没有人工校正，
// 所以数值与 Praat 加人工校正得到的（例如 Raine 等 2019）不能直接逐项对比。
// Acoustic analysis: the very same code and settings are applied to corpus recordings and to the
// synthesizer's output, which is what makes the two sides comparable. The method is a simplified
// implementation of our own (autocorrelation pitch in the spirit of Boersma 1993) with no manual
// correction, so its numbers are not item-by-item comparable to Praat-plus-manual-correction
// figures such as those of Raine et al. 2019.

export interface AnalysisOptions {
  f0FloorHz: number
  f0CeilingHz: number
  frameS: number
  hopS: number
  // 归一化自相关峰值达到此值才算有声 / a frame is voiced when its normalised autocorrelation peak reaches this
  voicingThreshold: number
  // 每高一个八度的加分（偏向较短周期）/ bonus per octave towards shorter periods
  octaveCost: number
  // 相对全段最响一帧的活动门限（dB）/ activity threshold relative to the loudest frame (dB)
  activeDb: number
  // 有声判定的电平门限（dB，相对最响一帧）：更弱的帧里常是气声在共振峰上的窄带鸣响，会被误当成很高的基频。
  // level gate for voicing (dB re the loudest frame): weaker frames are often breath noise ringing
  // narrow-band in a formant, which would pass for a very high F0.
  voicedDb: number
  // 半周期处的自相关不低于「整周期处 − 此值」时判为次谐波（倍周期）
  // period doubling is flagged when the autocorrelation at half the chosen lag is within this margin of the peak
  subMargin: number
  // 或者：两倍（三倍）周期处的自相关比所选周期处高出至少这么多
  // or: the autocorrelation at twice (three times) the chosen period exceeds that at the period by at least this much
  subRise: number
  // 候选周期 L 必须在 2L 处重现：r(2L) ≥ 此值 × r(L)。窄带噪声（共振峰滤过的气声）过不了这一关。
  // a candidate period L has to repeat at 2L: r(2L) ≥ this × r(L). Narrow-band noise (breath noise
  // ringing in a formant) fails it.
  repeatRatio: number
  // 发声段内部、周期性低于此值的帧算作「非周期」（混沌的替代指标）
  // inside a phonation stretch, frames whose periodicity falls below this count as aperiodic (the chaos proxy)
  aperiodicR: number
  centroidMaxHz: number
}

export const DEFAULT_ANALYSIS: AnalysisOptions = {
  f0FloorHz: 100,
  f0CeilingHz: 2200,
  frameS: 0.04,
  hopS: 0.01,
  voicingThreshold: 0.45,
  octaveCost: 0.04,
  activeDb: -25,
  voicedDb: -20,
  subMargin: 0.1,
  subRise: 0.03,
  repeatRatio: 0.85,
  aperiodicR: 0.6,
  centroidMaxHz: 10000,
}

export interface Frame {
  t: number
  rmsDb: number
  active: boolean
  voiced: boolean
  f0: number
  r: number
  centroidHz: number
  sub: boolean
  chaos: boolean
}

export interface Measures {
  // 首末活动帧之间的时长（秒）/ time between the first and the last active frame (s)
  durationS: number
  // 活动帧的均方根电平，dB 相对满刻度 / RMS level over active frames, dB re full scale
  levelDb: number
  peakDb: number
  // 有声帧占活动帧的比例 / share of active frames that are voiced
  voicedShare: number
  // 以下基频量只在有声帧上统计；无有声帧时为 NaN / F0 figures use voiced frames only; NaN when there are none
  f0MeanHz: number
  f0MedianHz: number
  f0P5Hz: number
  f0P95Hz: number
  f0RangeSt: number
  // 谐噪比（dB），有声帧平均 / harmonics-to-noise ratio (dB), mean over voiced frames
  hnrDb: number
  centroidHz: number
  // 非线性现象的替代指标：次谐波帧 + 发声段内的非周期帧，占活动帧的比例
  // proxy for nonlinear phenomena: subharmonic frames plus aperiodic frames inside phonation, as a share of active frames
  nonlinearShare: number
  subShare: number
  chaosShare: number
}

export const MEASURE_KEYS = ['durationS', 'levelDb', 'voicedShare', 'f0MeanHz', 'f0RangeSt', 'hnrDb', 'centroidHz', 'nonlinearShare'] as const
export type MeasureKey = (typeof MEASURE_KEYS)[number]

// 原位基 2 快速傅里叶变换 / in-place radix-2 FFT
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const xr = re[b]! * cr - im[b]! * ci
        const xi = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - xr; im[b] = im[a]! - xi
        re[a] = re[a]! + xr; im[a] = im[a]! + xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] = re[i]! / n; im[i] = im[i]! / n }
}

export const quantile = (sorted: ArrayLike<number>, q: number): number => {
  if (sorted.length === 0) return NaN
  const p = (sorted.length - 1) * q
  const i = Math.floor(p)
  const a = sorted[i]!
  const b = sorted[Math.min(sorted.length - 1, i + 1)]!
  return a + (b - a) * (p - i)
}

export function analyseFrames(x: Float32Array, sampleRate: number, opt: AnalysisOptions = DEFAULT_ANALYSIS): Frame[] {
  const frameN = Math.round(opt.frameS * sampleRate)
  const hop = Math.round(opt.hopS * sampleRate)
  let size = 1
  while (size < frameN * 2) size <<= 1
  const minLag = Math.max(2, Math.floor(sampleRate / opt.f0CeilingHz))
  const maxLag = Math.min(Math.floor(frameN / 2), Math.ceil(sampleRate / opt.f0FloorHz))
  const win = new Float64Array(frameN)
  for (let i = 0; i < frameN; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / frameN)
  // 窗函数自身的自相关，用来校正长时延处的衰减 / the window's own autocorrelation, to undo the taper at long lags
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  re.set(win)
  fft(re, im)
  for (let i = 0; i < size; i++) { re[i] = re[i]! * re[i]! + im[i]! * im[i]!; im[i] = 0 }
  fft(re, im, true)
  const winAc = Float64Array.from(re.subarray(0, frameN), (v) => v / re[0]!)

  const frames: Frame[] = []
  const r = new Float64Array(2 * maxLag + 3)
  const binHz = sampleRate / size
  const topBin = Math.min(size / 2, Math.floor(opt.centroidMaxHz / binHz))
  for (let start = 0; start + frameN <= x.length; start += hop) {
    let mean = 0
    for (let i = 0; i < frameN; i++) mean += x[start + i]!
    mean /= frameN
    let energy = 0
    re.fill(0); im.fill(0)
    for (let i = 0; i < frameN; i++) {
      const v = x[start + i]! - mean
      energy += v * v
      re[i] = v * win[i]!
    }
    const rmsDb = 10 * Math.log10(energy / frameN + 1e-12)
    fft(re, im)
    let cNum = 0
    let cDen = 0
    for (let i = 0; i < size; i++) {
      const p = re[i]! * re[i]! + im[i]! * im[i]!
      if (i > 0 && i <= topBin) { const a = Math.sqrt(p); cNum += a * i * binHz; cDen += a }
      re[i] = p; im[i] = 0
    }
    fft(re, im, true)
    const r0 = re[0]!
    const frame: Frame = { t: (start + frameN / 2) / sampleRate, rmsDb, active: false, voiced: false, f0: 0, r: 0, centroidHz: cDen > 0 ? cNum / cDen : 0, sub: false, chaos: false }
    frames.push(frame)
    if (r0 <= 0) continue
    for (let l = 0; l < r.length && l < frameN; l++) r[l] = Math.min(1, re[l]! / r0 / winAc[l]!)
    let best = 0
    let bestScore = -Infinity
    let bestR = 0
    for (let l = Math.max(minLag, 1); l <= maxLag; l++) {
      const c = r[l]!
      if (c <= r[l - 1]! || c < r[l + 1]! || c < 0.2) continue
      // 抛物线内插峰值位置与高度 / parabolic interpolation of the peak position and height
      const d = r[l - 1]! - 2 * c + r[l + 1]!
      const off = d !== 0 ? (0.5 * (r[l - 1]! - r[l + 1]!)) / d : 0
      const peak = Math.min(1, c - 0.25 * (r[l - 1]! - r[l + 1]!) * off)
      let twice = -Infinity
      for (let j = Math.floor((l + off) * 2 * 0.96); j <= Math.ceil((l + off) * 2 * 1.04); j++) twice = Math.max(twice, r[j]!)
      if (twice < opt.repeatRatio * peak) continue
      const score = peak - opt.octaveCost * Math.log2((l + off) / minLag)
      if (score > bestScore) { bestScore = score; best = l + off; bestR = peak }
    }
    if (best === 0) continue
    // 倍周期：所选时延的一半（或三分之一）处也有接近的峰，说明真正的基频更高，本帧带次谐波。
    // Period doubling: a comparable peak at half (or a third of) the chosen lag means the true F0 is
    // higher and this frame carries a subharmonic.
    for (const k of [2, 3]) {
      const target = best / k
      if (target < minLag) continue
      let lagK = 0
      let rK = -Infinity
      for (let l = Math.max(minLag, Math.floor(target * 0.94)); l <= Math.ceil(target * 1.06); l++) {
        if (r[l]! > rK && r[l]! >= r[l - 1]! && r[l]! >= r[l + 1]!) { rK = r[l]!; lagK = l }
      }
      if (lagK > 0 && rK >= bestR - opt.subMargin && rK >= opt.voicingThreshold) {
        frame.sub = true
        best = lagK
        break
      }
    }
    // 反过来：两倍（或三倍）周期处的峰明显更高，同样是倍周期，基频不变。
    // The other way round: a clearly higher peak at twice (or three times) the period is period doubling too; F0 stays.
    if (!frame.sub) {
      for (const k of [2, 3]) {
        const target = best * k
        let rK = -Infinity
        for (let l = Math.floor(target * 0.96); l <= Math.ceil(target * 1.04) && l + 1 < r.length && l + 1 < frameN; l++) {
          if (r[l]! > rK && r[l]! >= r[l - 1]! && r[l]! >= r[l + 1]!) rK = r[l]!
        }
        if (rK >= bestR + opt.subRise) { frame.sub = true; break }
      }
    }
    frame.f0 = sampleRate / best
    frame.r = bestR
  }

  let maxDb = -Infinity
  for (const f of frames) maxDb = Math.max(maxDb, f.rmsDb)
  for (const f of frames) {
    f.active = f.rmsDb > maxDb + opt.activeDb && f.rmsDb > -70
    f.voiced = f.active && f.rmsDb > maxDb + opt.voicedDb && f.r >= opt.voicingThreshold
    if (!f.voiced) f.sub = false
  }
  // 五点中值平滑，去掉孤立的八度跳变 / five-point median smoothing against isolated octave jumps
  const raw = frames.map((f) => f.f0)
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!
    if (!f.voiced) continue
    const near: number[] = []
    for (let j = Math.max(0, i - 2); j <= Math.min(frames.length - 1, i + 2); j++) if (frames[j]!.voiced) near.push(raw[j]!)
    near.sort((a, b) => a - b)
    f.f0 = near[near.length >> 1]!
  }
  // 发声段内部的非周期帧：前后 0.2 秒内都有周期性好的帧，而本帧周期性差且不比它们弱 10 dB 以上。
  // Aperiodic frames inside phonation: clearly periodic frames within 0.2 s on both sides, while this
  // frame is poorly periodic and no more than 10 dB weaker than they are.
  const span = Math.round(0.2 / opt.hopS)
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!
    if (!f.active || f.r >= opt.aperiodicR) continue
    let before = -Infinity
    let after = -Infinity
    for (let j = Math.max(0, i - span); j < i; j++) if (frames[j]!.voiced && frames[j]!.r >= opt.aperiodicR) before = Math.max(before, frames[j]!.rmsDb)
    for (let j = i + 1; j <= Math.min(frames.length - 1, i + span); j++) if (frames[j]!.voiced && frames[j]!.r >= opt.aperiodicR) after = Math.max(after, frames[j]!.rmsDb)
    if (f.rmsDb > Math.min(before, after) - 10 && before > -Infinity && after > -Infinity) f.chaos = true
  }
  return frames
}

export function measure(x: Float32Array, sampleRate: number, opt: AnalysisOptions = DEFAULT_ANALYSIS): Measures {
  const frames = analyseFrames(x, sampleRate, opt)
  const active = frames.filter((f) => f.active)
  const voiced = active.filter((f) => f.voiced)
  let peak = 0
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!))
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN)
  const f0 = voiced.map((f) => f.f0).sort((a, b) => a - b)
  const p5 = quantile(f0, 0.05)
  const p95 = quantile(f0, 0.95)
  const power = mean(active.map((f) => 10 ** (f.rmsDb / 10)))
  const sub = active.filter((f) => f.sub).length
  const chaos = active.filter((f) => f.chaos && !f.sub).length
  return {
    durationS: active.length ? active[active.length - 1]!.t - active[0]!.t + opt.hopS : 0,
    levelDb: active.length ? 10 * Math.log10(power) : -Infinity,
    peakDb: 20 * Math.log10(peak + 1e-12),
    voicedShare: active.length ? voiced.length / active.length : 0,
    f0MeanHz: mean(f0),
    f0MedianHz: quantile(f0, 0.5),
    f0P5Hz: p5,
    f0P95Hz: p95,
    f0RangeSt: f0.length ? 12 * Math.log2(p95 / p5) : NaN,
    hnrDb: mean(voiced.map((f) => { const r = Math.min(0.999, f.r); return 10 * Math.log10(r / (1 - r)) })),
    centroidHz: mean(active.map((f) => f.centroidHz)),
    nonlinearShare: active.length ? (sub + chaos) / active.length : 0,
    subShare: active.length ? sub / active.length : 0,
    chaosShare: active.length ? chaos / active.length : 0,
  }
}

export interface Aggregate {
  n: number
  mean: number
  sd: number
  p10: number
  p25: number
  p50: number
  p75: number
  p90: number
}

// 只保留汇总量；NaN（例如没有有声帧的录音的基频）不计入，n 是实际计入的个数。
// Aggregates only. NaN values (e.g. F0 of a recording with no voiced frame) are left out, and n counts what went in.
export function aggregate(values: number[], digits = 4): Aggregate {
  const v = values.filter((a) => Number.isFinite(a)).sort((a, b) => a - b)
  const round = (a: number) => (Number.isFinite(a) ? Number(a.toPrecision(digits)) : NaN)
  const m = v.reduce((s, a) => s + a, 0) / v.length
  const sd = Math.sqrt(v.reduce((s, a) => s + (a - m) ** 2, 0) / Math.max(1, v.length - 1))
  return { n: v.length, mean: round(m), sd: round(sd), p10: round(quantile(v, 0.1)), p25: round(quantile(v, 0.25)), p50: round(quantile(v, 0.5)), p75: round(quantile(v, 0.75)), p90: round(quantile(v, 0.9)) }
}
