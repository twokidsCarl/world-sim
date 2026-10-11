// 信号层：参数 → 单声道 PCM。纯函数，没有依赖，不碰 Web Audio，所以能在测试和离线工具里跑。
// The signal layer: parameters → mono PCM. A pure function with no dependencies and no Web Audio,
// so it runs in tests and offline tools.
//
// 信号模型按 Anikin (2019, Behav Res Methods 51:778–792) 对 soundgen 的文字描述来设计：声源 + 送气噪声 →
// 声道共振峰滤波，非线性现象用次谐波和强扰动来模拟。soundgen 的源代码是 GPL，这里没有阅读也没有移植它；
// 具体实现是自己写的，并且和它不同：声源在时域里逐个声门脉冲生成（它是把谐波叠加起来），
// 共振峰用级联的二阶谐振器（它在频域里算传递函数）。
// The signal model follows the published description of soundgen in Anikin (2019, Behav Res Methods
// 51:778–792): a source plus aspiration noise, filtered by vocal-tract formants, with nonlinear
// phenomena imitated by subharmonics and strong perturbation. soundgen's source code is GPL; it was
// neither read nor ported. The implementation here is our own and differs: the source is built pulse by
// pulse in the time domain (soundgen sums harmonics) and the formants are a cascade of second-order
// resonators (soundgen computes a transfer function in the frequency domain).

import { makeRng, type Rng } from './rng.ts'
import type { Anchor, NoiseSegment, RenderResult, Segment, Timeline, VocalisationParams, VoicedSegment, Vowel } from './types.ts'

// 温暖空气中的声速，厘米每秒（Anikin 2019 用的值）/ speed of sound in warm air, cm/s (the value used by Anikin 2019)
export const SPEED_OF_SOUND_CM_S = 35400
export const TIMELINE_FRAME_RATE = 100
// 八个共振峰，覆盖到约 8–9 kHz；只用五个时 5 kHz 以上几乎没有能量，频谱质心明显低于录音。
// Eight formants, reaching about 8–9 kHz; with five there is almost no energy above 5 kHz and the
// spectral centroid falls well below that of recordings.
const FORMANT_COUNT = 8
const CONTROL_BLOCK = 32
const TAIL_S = 0.04
const NOISE_DAMPING = 2.5

// 元音目标：前三个共振峰相对中性元音（均匀管）的倍数。来自教科书上成年男性元音的常见近似值，未逐项核对出处。
// Vowel targets: multipliers on the first three formants of the neutral vowel (uniform tube). Taken
// from commonly quoted textbook approximations for adult male vowels; not checked against a specific source.
const VOWEL_FACTORS: Record<Vowel, readonly [number, number, number]> = {
  schwa: [1, 1, 1],
  a: [1.45, 0.78, 0.97],
  e: [1.06, 1.18, 0.97],
  o: [1.1, 0.56, 0.93],
  u: [0.62, 0.58, 0.88],
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// 控制点之间线性插值 / linear interpolation between control points
export function contour(anchors: readonly Anchor[], t: number): number {
  const n = anchors.length
  if (n === 0) return 0
  if (t <= anchors[0]!.t) return anchors[0]!.v
  for (let i = 1; i < n; i++) {
    const b = anchors[i]!
    if (t <= b.t) {
      const a = anchors[i - 1]!
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1
      return a.v + (b.v - a.v) * u
    }
  }
  return anchors[n - 1]!.v
}

// 基频：在对数域内用余弦过渡，轮廓没有折角 / F0: cosine transitions in the log domain, so the contour has no corners
export function f0Contour(anchors: readonly Anchor[], t: number): number {
  const n = anchors.length
  if (n === 0) return 0
  if (t <= anchors[0]!.t) return anchors[0]!.v
  for (let i = 1; i < n; i++) {
    const b = anchors[i]!
    if (t <= b.t) {
      const a = anchors[i - 1]!
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1
      const s = 0.5 - 0.5 * Math.cos(Math.PI * u)
      return Math.exp(Math.log(a.v) + (Math.log(b.v) - Math.log(a.v)) * s)
    }
  }
  return anchors[n - 1]!.v
}

// 共振峰频率与带宽。
// 中性元音：F_n = (2n − 1)·c / (4·VTL)（一端封闭的均匀管）。张口度 m 使各共振峰平移
// ΔF = (m − 0.5)·c / (4·VTL)，嘴完全闭上时 F1 带宽加到 175 Hz（两条都取自 Anikin 2019 的描述）。
// 带宽 B = 80 + 0.04·F 是这里的假设；无声段（声门敞开，阻尼更大）再乘以 damping，也是假设。
// Formant frequencies and bandwidths. Neutral vowel: F_n = (2n − 1)·c / (4·VTL) (uniform tube closed
// at one end). Mouth opening m shifts the formants by ΔF = (m − 0.5)·c / (4·VTL), and a fully closed
// mouth widens F1 to 175 Hz (both as described by Anikin 2019). The bandwidth rule B = 80 + 0.04·F is
// an assumption of ours, and so is the extra `damping` factor used for unvoiced segments (an open
// glottis damps the tract more).
export function formants(vocalTractCm: number, vowel: Vowel, mouth: number, damping = 1): { freq: number[]; bw: number[] } {
  const quarter = SPEED_OF_SOUND_CM_S / (4 * vocalTractCm)
  const factors = VOWEL_FACTORS[vowel]
  const shift = (clamp(mouth, 0, 1) - 0.5) * quarter
  const freq: number[] = []
  const bw: number[] = []
  for (let n = 1; n <= FORMANT_COUNT; n++) {
    const f = Math.max(180, (2 * n - 1) * quarter * (factors[n - 1] ?? 1) + shift)
    freq.push(f)
    bw.push((80 + 0.04 * f) * damping)
  }
  const closed = 1 - clamp(mouth / 0.1, 0, 1)
  bw[0] = bw[0]! + (175 - bw[0]!) * closed
  return { freq, bw }
}

// 嘴闭上时辐射出来的声音变弱（假设：闭口时约 −12 dB，张到 0.25 以上不再衰减）。
// A closed mouth radiates less sound (assumption: about −12 dB when closed, no loss above an opening of 0.25).
const mouthGain = (mouth: number) => {
  const u = clamp(mouth / 0.25, 0, 1)
  return 0.25 + 0.75 * u * u * (3 - 2 * u)
}

// 频谱倾斜滤波器：一阶，3 kHz 处相对直流的增益为 −tiltDb 分贝。
// tiltDb > 0 是低通（声音变暗），tiltDb < 0 是预加重 y = x − β·x[n−1]（声音变亮）。返回 [低通系数, β]。
// The spectral-tilt filter: first order, with a gain of −tiltDb dB at 3 kHz relative to DC.
// tiltDb > 0 is a low-pass (darker), tiltDb < 0 a pre-emphasis y = x − β·x[n−1] (brighter).
// Returns [low-pass coefficient, β].
function tiltCoefficients(tiltDb: number, sampleRate: number): [number, number] {
  if (Math.abs(tiltDb) <= 0.01) return [0, 0]
  const cos = Math.cos((2 * Math.PI * Math.min(3000, sampleRate * 0.45)) / sampleRate)
  const target = 10 ** (-Math.abs(tiltDb) / 10)
  // 两种情况解的是同一个方程：(1 − a)² / (1 + a² − 2a·cos ω) = 目标功率比
  // both cases solve the same equation: (1 − a)² / (1 + a² − 2a·cos ω) = target power ratio
  let lo = 0
  let hi = 0.98
  for (let i = 0; i < 40; i++) {
    const a = (lo + hi) / 2
    const g = ((1 - a) * (1 - a)) / (1 + a * a - 2 * a * cos)
    if (g > target) lo = a
    else hi = a
  }
  const a = (lo + hi) / 2
  return tiltDb > 0 ? [a, 0] : [0, a]
}

class FormantFilter {
  private readonly a = new Float64Array(FORMANT_COUNT)
  private readonly b = new Float64Array(FORMANT_COUNT)
  private readonly c = new Float64Array(FORMANT_COUNT)
  private readonly y1 = new Float64Array(FORMANT_COUNT)
  private readonly y2 = new Float64Array(FORMANT_COUNT)
  private active = FORMANT_COUNT
  constructor(private readonly sampleRate: number) {}

  set(freq: readonly number[], bw: readonly number[]) {
    this.active = 0
    for (let i = 0; i < FORMANT_COUNT; i++) {
      // 接近奈奎斯特频率的共振峰不要 / drop formants too close to the Nyquist frequency
      if (freq[i]! > this.sampleRate * 0.45) break
      const c = -Math.exp((-2 * Math.PI * bw[i]!) / this.sampleRate)
      const b = 2 * Math.exp((-Math.PI * bw[i]!) / this.sampleRate) * Math.cos((2 * Math.PI * freq[i]!) / this.sampleRate)
      this.c[i] = c
      this.b[i] = b
      this.a[i] = 1 - b - c
      this.active = i + 1
    }
  }

  run(x: number): number {
    let v = x
    for (let i = 0; i < this.active; i++) {
      const y = this.a[i]! * v + this.b[i]! * this.y1[i]! + this.c[i]! * this.y2[i]!
      this.y2[i] = this.y1[i]!
      this.y1[i] = y
      v = y
    }
    return v
  }
}

// 起止各 4 毫秒的淡入淡出，包络控制点再怎么写也不会有咔嗒声。
// A 4 ms fade at either end, so no choice of envelope anchors can produce a click.
const edgeFade = (i: number, n: number, sampleRate: number) => {
  const k = 0.004 * sampleRate
  return Math.min(1, i / k, (n - 1 - i) / k)
}

function depthAt(seg: VoicedSegment, kind: 'sub' | 'chaos', t: number, rampT: number): number {
  let d = 0
  for (const s of seg.nonlinear) {
    if (s.kind !== kind) continue
    const edge = Math.min((t - s.t0) / rampT, (s.t1 - t) / rampT)
    if (edge > 0) d = Math.max(d, s.depth * Math.min(1, edge))
  }
  return d
}

function renderVoiced(seg: VoicedSegment, p: VocalisationParams, sampleRate: number, rng: Rng): Float32Array {
  const n = Math.max(1, Math.round(seg.durationS * sampleRate))
  const total = n + Math.round(TAIL_S * sampleRate)
  const out = new Float32Array(total)
  const filter = new FormantFilter(sampleRate)
  const oq = clamp(seg.openQuotient, 0.3, 0.9)
  const [tiltA, tiltB] = tiltCoefficients(seg.tiltDb, sampleRate)
  const noiseGain = 10 ** (seg.noiseDb / 20)
  // 送气噪声：白噪声经 4 kHz 一阶低通再做一阶差分（口唇辐射），所以能量偏在高频，
  // 和气声里「噪声主要在高频、谐波主要在低频」的常见情形一致。这个谱形是这里的假设。
  // Aspiration noise: white noise through a 4 kHz one-pole low-pass and then a first difference (lip
  // radiation), which puts its energy towards the high frequencies, as in breathy voices where noise
  // dominates high up and harmonics low down. The spectral shape is an assumption of ours.
  const noiseA = Math.exp((-2 * Math.PI * Math.min(4000, sampleRate * 0.4)) / sampleRate)
  // 慢速基频漂移：每 60 毫秒取一个随机值，余弦过渡 / slow F0 drift: one random value every 60 ms, cosine transitions
  const stepN = Math.round(0.06 * sampleRate)
  const drift: number[] = []
  for (let i = 0; i <= Math.ceil(total / stepN) + 1; i++) drift.push(rng.gauss() * seg.flutterSt)
  const rampT = Math.min(0.5, 0.02 / Math.max(0.02, seg.durationS))
  const nyquistGuard = sampleRate * 0.4

  let phase = 0
  let pulse = 0
  let periodMul = 1
  let ampMul = 1
  let tiltState = 0
  let tiltPrev = 0
  let noiseState = 0
  let noisePrev = 0
  let direct = 0
  let mouth = 0
  let sub = 0
  let chaos = 0
  let gain = 0
  let f0Base = 0
  for (let i = 0; i < total; i++) {
    const inside = i < n
    if (i % CONTROL_BLOCK === 0) {
      const t = Math.min(1, i / n)
      mouth = contour(seg.mouth, t)
      const f = formants(p.vocalTractCm, seg.vowel, mouth)
      filter.set(f.freq, f.bw)
      sub = depthAt(seg, 'sub', t, rampT)
      chaos = depthAt(seg, 'chaos', t, rampT)
      gain = inside ? contour(seg.amp, t) * mouthGain(mouth) : 0
      const k = i / stepN
      const k0 = Math.floor(k)
      const s = 0.5 - 0.5 * Math.cos(Math.PI * (k - k0))
      const st = drift[k0]! + (drift[k0 + 1]! - drift[k0]!) * s
      f0Base = f0Contour(seg.f0, t) * 2 ** (st / 12)
    }
    let x = 0
    if (inside) {
      const dt = Math.min(nyquistGuard, f0Base * periodMul) / sampleRate
      phase += dt
      if (phase >= 1) {
        phase -= 1
        pulse++
        // 新的一个声门周期：抽取本周期的扰动。混沌 = 很强的周期与幅度扰动；次谐波 = 相邻周期一强一弱、一长一短。
        // A new glottal cycle: draw its perturbations. Chaos = very strong period and amplitude
        // perturbation; subharmonic = alternating strong/weak and long/short cycles.
        const odd = pulse & 1
        periodMul = Math.exp(rng.gauss() * (seg.jitter + 0.16 * chaos)) * (1 + (odd ? 0.03 : -0.03) * sub)
        ampMul = Math.max(0.05, 1 + rng.gauss() * (seg.shimmer + 0.4 * chaos)) * (odd ? 1 - 0.35 * sub : 1)
      }
      // 声门气流的导数（KLGLOTT88 形状：开放期内气流为 x² − x³），闭合瞬间的阶跃用 polyBLEP 限带。
      // The derivative of glottal flow (KLGLOTT88 shape: flow x² − x³ during the open phase); the
      // step at closure is band-limited with polyBLEP.
      let v = 0
      if (phase < oq) {
        const u = phase / oq
        v = 2 * u - 3 * u * u
      }
      const d = phase - oq
      if (d >= 0 && d < dt) {
        const u = d / dt
        v += 0.5 * (u + u - u * u - 1)
      } else if (d < 0 && d > -dt) {
        const u = d / dt
        v += 0.5 * (u * u + u + u + 1)
      }
      const pulseValue = v * ampMul
      tiltState = tiltA * tiltState + (1 - tiltA) * (pulseValue - tiltB * tiltPrev)
      tiltPrev = pulseValue
      // 送气噪声：声门开放时更强；混沌段里再加强 / aspiration noise: stronger while the glottis is open, and boosted in chaotic stretches
      const white = rng.next() + rng.next() + rng.next() - 1.5
      noiseState = noiseA * noiseState + (1 - noiseA) * white
      const breath = noiseState - noisePrev
      noisePrev = noiseState
      const g = gain * edgeFade(i, n, sampleRate)
      direct = breath * noiseGain * (phase < oq ? 1 : 0.4) * (1 + 3 * chaos) * 6 * g
      x = tiltState * g + direct
    }
    // 噪声除了经过声道滤波，还有一份不经滤波直接加到输出上：级联的全极点滤波器在最高共振峰以上衰减得很快，
    // 而录音里的湍流噪声一直延伸到 8–10 kHz。直通的比例由 noiseDirect 给出；这条通路本身是这里的假设。
    // Besides passing through the tract filter, the noise is also added to the output unfiltered: a
    // cascade of all-pole resonators falls away quickly above its highest formant, whereas turbulence
    // noise in recordings extends to 8–10 kHz. noiseDirect sets the share sent direct; the path itself is
    // an assumption of ours.
    out[i] = filter.run(x) + (inside ? direct * seg.noiseDirect : 0)
  }
  return out
}

function renderNoise(seg: NoiseSegment, p: VocalisationParams, sampleRate: number, rng: Rng): Float32Array {
  const n = Math.max(1, Math.round(seg.durationS * sampleRate))
  const total = n + Math.round(TAIL_S * sampleRate)
  const out = new Float32Array(total)
  const filter = new FormantFilter(sampleRate)
  const a = Math.exp((-2 * Math.PI * Math.min(seg.noiseCutoffHz, sampleRate * 0.45)) / sampleRate)
  let state = 0
  let prev = 0
  let gain = 0
  for (let i = 0; i < total; i++) {
    if (i % CONTROL_BLOCK === 0) {
      const t = Math.min(1, i / n)
      const mouth = contour(seg.mouth, t)
      const f = formants(p.vocalTractCm, seg.vowel, mouth, NOISE_DAMPING)
      filter.set(f.freq, f.bw)
      gain = i < n ? contour(seg.amp, t) * mouthGain(mouth) : 0
    }
    let x = 0
    if (i < n) {
      const white = rng.next() + rng.next() + rng.next() - 1.5
      state = a * state + (1 - a) * white
      // 一阶差分近似口唇辐射 / a first difference stands in for lip radiation
      x = (state - prev) * gain * edgeFade(i, n, sampleRate)
      prev = state
    }
    out[i] = filter.run(x)
  }
  return out
}

const rms = (x: Float32Array, n: number) => {
  let s = 0
  for (let i = 0; i < n; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / Math.max(1, n))
}

export const totalDuration = (segments: readonly Segment[]) => segments.reduce((s, g) => s + g.durationS, 0)

// 时间线只依赖参数，不需要渲染音频。/ The timeline depends on the parameters only; no audio is rendered.
export function computeTimeline(p: VocalisationParams): Timeline {
  const durationS = totalDuration(p.segments)
  const frames = Math.max(1, Math.ceil(durationS * TIMELINE_FRAME_RATE))
  const tl: Timeline = {
    durationS,
    frameRate: TIMELINE_FRAME_RATE,
    events: [],
    mouth: new Float32Array(frames),
    level: new Float32Array(frames),
    airflow: new Float32Array(frames),
    f0: new Float32Array(frames),
  }
  let start = 0
  for (const seg of p.segments) {
    const end = start + seg.durationS
    tl.events.push({ kind: seg.kind, startS: start, endS: end })
    if (seg.kind !== 'pause') {
      const rel = 10 ** (seg.relDb / 20)
      for (let f = Math.ceil(start * TIMELINE_FRAME_RATE); f < frames && f / TIMELINE_FRAME_RATE < end; f++) {
        const t = seg.durationS > 0 ? (f / TIMELINE_FRAME_RATE - start) / seg.durationS : 0
        const amp = contour(seg.amp, t)
        tl.mouth[f] = clamp(contour(seg.mouth, t), 0, 1)
        tl.level[f] = amp * rel
        tl.airflow[f] = seg.kind === 'inhale' ? -amp : amp
        if (seg.kind === 'voiced') tl.f0[f] = f0Contour(seg.f0, t)
      }
    }
    start = end
  }
  let peak = 0
  for (const v of tl.level) peak = Math.max(peak, v)
  if (peak > 0) for (let i = 0; i < frames; i++) tl.level[i] = tl.level[i]! / peak
  return tl
}

// 核心：参数 → PCM。同样的参数和采样率总是给出同样的样本。
// The core: parameters → PCM. The same parameters and sample rate always give the same samples.
export function renderVocalisation(p: VocalisationParams, sampleRate = 44100): RenderResult {
  const timeline = computeTimeline(p)
  const tail = Math.round(TAIL_S * sampleRate)
  const pcm = new Float32Array(Math.round(timeline.durationS * sampleRate) + tail)
  const root = makeRng(p.seed)
  let start = 0
  let energy = 0
  let sounding = 0
  p.segments.forEach((seg, index) => {
    if (seg.kind !== 'pause') {
      const rng = root.fork(index)
      const buf = seg.kind === 'voiced' ? renderVoiced(seg, p, sampleRate, rng) : renderNoise(seg, p, sampleRate, rng)
      const n = buf.length - tail
      // 每段先归一到自己的相对电平，这样各段之间的响度关系由 relDb 说了算，而不取决于基频和共振峰碰巧怎么对上。
      // Each segment is first normalised to its own relative level, so loudness relations between
      // segments are set by relDb and not by how F0 and the formants happen to line up.
      const r = rms(buf, n)
      const g = r > 0 ? 10 ** (seg.relDb / 20) / r : 0
      const offset = Math.round(start * sampleRate)
      for (let i = 0; i < buf.length && offset + i < pcm.length; i++) {
        const v = buf[i]! * g
        pcm[offset + i] = pcm[offset + i]! + v
        if (i < n) energy += v * v
      }
      sounding += n
    }
    start += seg.durationS
  })
  // 去掉直流和次声成分（一阶高通，40 Hz）/ remove DC and infrasonic content (one-pole high-pass at 40 Hz)
  const hp = Math.exp((-2 * Math.PI * 40) / sampleRate)
  let x1 = 0
  let y1 = 0
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i]!
    y1 = hp * (y1 + x - x1)
    x1 = x
    pcm[i] = y1
  }
  let g = sounding > 0 && energy > 0 ? 10 ** (p.levelDb / 20) / Math.sqrt(energy / sounding) : 0
  let peak = 0
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!))
  // 峰值不超过 0.95：超过就整体降低（不做削波、不做压缩），并把降了多少报告出去。
  // Peaks stay below 0.95: if they would not, the whole signal is lowered (no clipping, no
  // compression) and the amount is reported.
  let limitedDb = 0
  if (peak * g > 0.95) {
    limitedDb = 20 * Math.log10((peak * g) / 0.95)
    g = 0.95 / peak
  }
  for (let i = 0; i < pcm.length; i++) pcm[i] = pcm[i]! * g
  return { sampleRate, pcm, timeline, limitedDb }
}
