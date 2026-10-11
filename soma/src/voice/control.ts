// 控制层：疼痛强度和情境 → 发声类型和合成参数。
// The control layer: pain intensity and context → a vocalisation type and synthesis parameters.
//
// 这是用于教学的疼痛行为计算模型；被模拟的身体没有主观体验。「强度」是模型的输入量，
// 输出的是在该强度下人会发出的那一类声音的统计上相似的合成物，不是任何人的录音。
// This is a computational model of pain behaviour for teaching; the simulated body has no subjective
// experience. "Intensity" is a model input; the output is a synthetic sound statistically similar to
// the kind people produce at that intensity, not anybody's recording.
//
// 哪些有数据支持，哪些是假设：
// - 女声、突发：FITTED 里的各个量是对 VIVAE 语料疼痛子集的统计量拟合出来的（见 data/curated/voice/calibration.json）。
// - 男声：没有可用的男声语料；在女声映射上套用 Raine 等 (2019) 表 3、表 4 的男女差。
// - 持续性疼痛：频谱参数沿用突发的映射，时长取 Raine 等 (2019) 报告的各级平均时长；没有另行校准。
// - 强度刻度的对应、出不出声的概率、各类型的比例、各类型的轮廓形状：都是假设，见下面各处的注释。
// What rests on data and what is assumed:
// - Female, sudden onset: the quantities in FITTED are fitted to statistics of the pain subset of the
//   VIVAE corpus (see data/curated/voice/calibration.json).
// - Male: no usable male corpus; the male–female differences of Raine et al. (2019), Tables 3 and 4,
//   are applied on top of the female mapping.
// - Sustained pain: the spectral parameters reuse the sudden-onset mapping and the durations follow the
//   per-level mean durations reported by Raine et al. (2019); nothing was calibrated separately.
// - The correspondence between intensity scales, the probability of making a sound, the mix of types
//   and the contour shape of each type are all assumptions; see the comments at each place.

import { FITTED } from './fitted.ts'
import { makeRng, type Rng } from './rng.ts'
import { computeTimeline } from './synth.ts'
import type { Anchor, NoiseSegment, NonlinearSpan, Onset, Segment, Sex, Timeline, VocalisationParams, VocalisationType, VoicedSegment, Vowel } from './types.ts'

// 映射的结点：每个量在几个强度上各有一个值，中间线性插值。
// The knots of the mapping: each quantity has one value at a few intensities, linearly interpolated between.
export interface Knots {
  intensity: number[]
  // 一次发声的基频中心（Hz，对数正态的中位数）与其对数标准差 / F0 centre of a vocalisation (Hz, median of a log-normal) and its log SD
  f0Hz: number[]
  f0SdLog: number[]
  // 基频轮廓的起伏幅度（半音）/ size of the F0 contour's excursion (semitones)
  f0ExcursionSt: number[]
  durationS: number[]
  durationSdLog: number[]
  // 目标电平（dB 相对满刻度）与标准差 / target level (dB re full scale) and SD
  levelDb: number[]
  levelSdDb: number[]
  // 频谱倾斜不是拟合出来的：按「强度越高声门闭合越紧」手工给定（假设）
  // spectral tilt is not fitted: set by hand on the premise that higher intensity means a more pressed glottis (assumption)
  tiltDb: number[]
  noiseDb: number[]
  noiseDirect: number[]
  // 无声部分（吸气、气声）占时长的比例 / share of the duration that is unvoiced (inhalation, breath noise)
  unvoicedShare: number[]
  subShare: number[]
  chaosShare: number[]
}

// 语料的强度等级 → 我们的 0–10 刻度。这是假设，不是测量：
// VIVAE 的四级（low / moderate / strong / peak）按等距放在 2.5、5、7.5、10，peak 对应刻度顶端；
// Raine 等 (2019) 的三级按他们给演员的情境描述放在 3（烫到手指、踢到脚趾）、6.5（手臂骨折、肩关节脱位）、
// 10（「你能想到的最剧烈的疼痛」）。
// Corpus intensity levels → our 0–10 scale. An assumption, not a measurement: VIVAE's four levels
// (low / moderate / strong / peak) are placed evenly at 2.5, 5, 7.5 and 10, peak being the top of the
// scale; the three levels of Raine et al. (2019) are placed by the scenarios given to their actors, at
// 3 (scalded finger, stubbed toe), 6.5 (broken arm, dislocated shoulder) and 10 ("the most intense
// pain you can think of").
export const VIVAE_LEVELS = { low: 2.5, moderate: 5, strong: 7.5, peak: 10 } as const
export const RAINE_LEVELS = { mild: 3, moderate: 6.5, severe: 10 } as const
const RAINE_X = [RAINE_LEVELS.mild, RAINE_LEVELS.moderate, RAINE_LEVELS.severe]

// Raine 等 (2019) 表 3（女）与表 4（男）的各级均值；这里只用男女之间的比值和差值。
// Per-level means from Raine et al. (2019), Table 3 (female) and Table 4 (male); only the ratios and
// differences between the sexes are used here.
export const RAINE_2019 = {
  female: { f0MeanHz: [465.5, 539.9, 737.8], amplitudeDb: [55.1, 62.7, 71.38], hnrDb: [5.73, 10.57, 12.91] },
  male: { f0MeanHz: [270.7, 340.4, 440.8], amplitudeDb: [52.33, 62.62, 69.99], hnrDb: [2.51, 6.82, 8.44] },
  // 全体 60 人的平均时长（秒），正文结果一节 / mean duration over all 60 vocalisers (s), from the Results text
  durationS: [0.68, 1.77, 3.64],
} as const

// 声道长度（厘米）：成年男女的常用整数近似，是假设。/ Vocal-tract length (cm): round figures commonly used for adult men and women; an assumption.
export const VOCAL_TRACT_CM: Record<Sex, number> = { male: 17, female: 14.5 }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const smoothstep = (u: number) => { const c = clamp(u, 0, 1); return c * c * (3 - 2 * c) }

// 分段线性插值；两端取端点值，extrapolateLow 为真时低端沿第一段的斜率外推。
// Piecewise-linear interpolation; flat beyond the ends, or continuing the first segment's slope at the low end when extrapolateLow is set.
export function interp(xs: readonly number[], ys: readonly number[], x: number, extrapolateLow = false): number {
  const n = xs.length
  if (x <= xs[0]!) return extrapolateLow && n > 1 ? ys[0]! + ((ys[1]! - ys[0]!) / (xs[1]! - xs[0]!)) * (x - xs[0]!) : ys[0]!
  for (let i = 1; i < n; i++) if (x <= xs[i]!) return ys[i - 1]! + ((ys[i]! - ys[i - 1]!) * (x - xs[i - 1]!)) / (xs[i]! - xs[i - 1]!)
  return ys[n - 1]!
}

// 出声的概率。假设，没有找到可以直接引用的数字：
// 突发性刺激在强度 1 以下从不出声、3 时一半、5 以上总是出声；持续性疼痛更常被忍住：2 以下不出声、5 时一半、8 以上总是出声。
// Helmer 等 (2020, Eur J Pain) 的系统综述确认疼痛与发声在多数研究中相关，但没有给出按强度的出声比例。
// Probability of making any sound. An assumption; no citable figure was found. A sudden stimulus never
// draws a sound below intensity 1, does so half the time at 3 and always from 5; sustained pain is more
// often borne silently: never below 2, half the time at 5, always from 8. The systematic review of
// Helmer et al. (2020, Eur J Pain) confirms that pain and vocalisation are associated in most studies
// but gives no proportion vocalising by intensity.
export function soundProbability(intensity: number, onset: Onset): number {
  return onset === 'sudden' ? smoothstep((intensity - 1) / 4) : smoothstep((intensity - 2) / 6)
}

// 出声时各类型的权重，在强度 2、4、6、8、10 处给出。假设。
// Weights of the types given that a sound is made, at intensities 2, 4, 6, 8 and 10. An assumption.
const TYPE_X = [2, 4, 6, 8, 10]
const TYPE_WEIGHTS: Record<Onset, Record<Exclude<VocalisationType, 'none'>, number[]>> = {
  sudden: {
    inhalation: [0.2, 0.1, 0.03, 0.02, 0.02],
    grunt: [0.45, 0.4, 0.25, 0.1, 0.03],
    moan: [0.3, 0.3, 0.15, 0.08, 0.05],
    cry: [0.05, 0.2, 0.5, 0.5, 0.35],
    scream: [0, 0, 0.07, 0.3, 0.55],
  },
  sustained: {
    inhalation: [0.1, 0.05, 0, 0, 0],
    grunt: [0.2, 0.15, 0.1, 0.05, 0.02],
    moan: [0.7, 0.7, 0.55, 0.3, 0.13],
    cry: [0, 0.1, 0.3, 0.45, 0.4],
    scream: [0, 0, 0.05, 0.2, 0.45],
  },
}
const TYPES = ['inhalation', 'grunt', 'moan', 'cry', 'scream'] as const

export function typeProbabilities(intensity: number, onset: Onset): Record<Exclude<VocalisationType, 'none'>, number> {
  const w = TYPES.map((t) => Math.max(0, interp(TYPE_X, TYPE_WEIGHTS[onset][t], intensity)))
  const sum = w.reduce((a, b) => a + b, 0)
  return Object.fromEntries(TYPES.map((t, i) => [t, w[i]! / sum])) as Record<Exclude<VocalisationType, 'none'>, number>
}

export interface PainVocalisationInput {
  // 0–10
  intensity: number
  onset: Onset
  sex: Sex
  seed: number
  // 'auto'（默认）按出声概率决定；'always' 跳过这条规则，总是给出一次发声（做试听材料和校准用）。
  // 'auto' (default) applies the probability of sound; 'always' skips that rule and always returns a
  // vocalisation (for listening material and calibration).
  vocalise?: 'auto' | 'always'
  vocalTractCm?: number
  // 换一组映射结点（校准工具用）/ use another set of knots (for the calibration tool)
  knots?: Knots
}

export interface PainVocalisation {
  type: VocalisationType
  // 类型为 'none' 时为 null / null when the type is 'none'
  params: VocalisationParams | null
  timeline: Timeline
  // 该强度和起病方式下出声的概率 / probability of any sound at this intensity and onset
  soundProbability: number
  // 按规则这一次本来不出声（只有 vocalise: 'always' 时才可能为真而仍有参数）
  // by the rule this repetition would have been silent (only with vocalise: 'always' can this be true while params exist)
  silentByRule: boolean
}

const st = (semitones: number) => 2 ** (semitones / 12)
const pick = <T,>(rng: Rng, items: readonly T[]): T => items[Math.min(items.length - 1, Math.floor(rng.next() * items.length))]!

interface Draw {
  noiseDirect: number
  f0: number
  excursion: number
  tiltDb: number
  noiseDb: number
  subShare: number
  chaosShare: number
}

function nonlinearSpans(rng: Rng, d: Draw): NonlinearSpan[] {
  const spans: NonlinearSpan[] = []
  for (const kind of ['sub', 'chaos'] as const) {
    const share = clamp((kind === 'sub' ? d.subShare : d.chaosShare) * Math.exp(rng.gauss() * 0.8), 0, 0.8)
    const start = rng.range(0.08, 0.92 - Math.min(share, 0.8))
    const depth = rng.range(0.6, 1)
    if (share >= 0.03) spans.push({ t0: start, t1: start + share, kind, depth })
  }
  return spans
}

function voicedSegment(type: 'grunt' | 'moan' | 'cry' | 'scream', durationS: number, d: Draw, rng: Rng): VoicedSegment {
  const F = d.f0
  const E = d.excursion
  let f0: Anchor[]
  let amp: Anchor[]
  let mouth: Anchor[]
  let vowel: Vowel
  let openQuotient: number
  let tilt = d.tiltDb
  let noise = d.noiseDb
  // 各类型的轮廓形状是假设：闷哼短而下滑、嘴半闭；呻吟长、平缓、嘴近乎闭合、带气声；
  // 哭喊先升后降、嘴张开；尖叫基频高而持平、嘴全开、声门闭合得紧。
  // The contour shapes are assumptions: a grunt is short and falling with the mouth half closed; a moan
  // is long, gentle, nearly closed-mouthed and breathy; a cry rises then falls with the mouth open; a
  // scream is high and level with the mouth wide open and a pressed glottis.
  if (type === 'grunt') {
    const m = rng.range(0.2, 0.45)
    f0 = [{ t: 0, v: F * st(0.35 * E) }, { t: 0.25, v: F * st(0.2 * E) }, { t: 1, v: F * st(-0.65 * E) }]
    amp = [{ t: 0, v: 0 }, { t: 0.08, v: 1 }, { t: 0.5, v: 0.7 }, { t: 1, v: 0 }]
    mouth = [{ t: 0, v: 0.15 }, { t: 0.2, v: m }, { t: 1, v: 0.1 }]
    vowel = 'schwa'
    openQuotient = rng.range(0.5, 0.6)
  } else if (type === 'moan') {
    const m = rng.range(0.05, 0.3)
    f0 = [{ t: 0, v: F * st(-0.3 * E) }, { t: rng.range(0.2, 0.4), v: F * st(0.3 * E) }, { t: 1, v: F * st(-0.7 * E) }]
    amp = [{ t: 0, v: 0 }, { t: 0.2, v: 0.8 }, { t: 0.5, v: 1 }, { t: 0.8, v: 0.7 }, { t: 1, v: 0 }]
    mouth = [{ t: 0, v: m * 0.5 }, { t: 0.4, v: m }, { t: 1, v: m * 0.3 }]
    vowel = pick(rng, ['o', 'schwa', 'u'] as const)
    openQuotient = rng.range(0.7, 0.85)
    tilt += 2
    noise += 3
  } else if (type === 'cry') {
    const m = rng.range(0.55, 0.9)
    const tp = rng.range(0.15, 0.4)
    f0 = [{ t: 0, v: F * st(-0.4 * E) }, { t: tp, v: F * st(0.6 * E) }, { t: 0.72, v: F * st(0.1 * E) }, { t: 1, v: F * st(-0.4 * E) }]
    amp = [{ t: 0, v: 0 }, { t: 0.06, v: 0.9 }, { t: tp, v: 1 }, { t: 0.75, v: 0.7 }, { t: 1, v: 0 }]
    mouth = [{ t: 0, v: 0.3 }, { t: 0.12, v: m }, { t: 0.7, v: m * 0.9 }, { t: 1, v: 0.2 }]
    vowel = pick(rng, ['a', 'a', 'e'] as const)
    openQuotient = rng.range(0.55, 0.65)
  } else {
    const m = rng.range(0.85, 1)
    f0 = [{ t: 0, v: F * st(-0.5 * E) }, { t: 0.12, v: F * st(0.5 * E) }, { t: 0.6, v: F * st(0.4 * E) }, { t: 1, v: F * st(-0.3 * E) }]
    amp = [{ t: 0, v: 0 }, { t: 0.04, v: 1 }, { t: 0.8, v: 0.9 }, { t: 1, v: 0 }]
    mouth = [{ t: 0, v: 0.4 }, { t: 0.08, v: m }, { t: 0.85, v: m }, { t: 1, v: 0.3 }]
    vowel = 'a'
    openQuotient = rng.range(0.45, 0.55)
    tilt -= 2
  }
  return {
    kind: 'voiced',
    durationS,
    f0,
    amp,
    mouth,
    vowel,
    relDb: 0,
    openQuotient,
    tiltDb: tilt + rng.gauss() * 1.5,
    jitter: rng.range(0.003, 0.012),
    shimmer: rng.range(0.02, 0.06),
    noiseDb: noise + rng.gauss() * 3,
    noiseDirect: d.noiseDirect,
    flutterSt: rng.range(0.05, 0.2),
    nonlinear: nonlinearSpans(rng, d),
  }
}

function inhaleSegment(durationS: number, relDb: number, rng: Rng): NoiseSegment {
  const m = rng.range(0.25, 0.6)
  return {
    kind: 'inhale',
    durationS,
    amp: [{ t: 0, v: 0 }, { t: 0.15, v: 1 }, { t: 0.6, v: 0.6 }, { t: 1, v: 0 }],
    mouth: [{ t: 0, v: 0.15 }, { t: 0.3, v: m }, { t: 1, v: m * 0.7 }],
    vowel: pick(rng, ['e', 'schwa'] as const),
    relDb,
    noiseCutoffHz: rng.range(4000, 9000),
  }
}

function exhaleSegment(durationS: number, relDb: number, mouthStart: number, rng: Rng): NoiseSegment {
  return {
    kind: 'exhale',
    durationS,
    amp: [{ t: 0, v: 0.7 }, { t: 0.2, v: 1 }, { t: 1, v: 0 }],
    mouth: [{ t: 0, v: mouthStart }, { t: 1, v: 0.1 }],
    vowel: 'schwa',
    relDb,
    noiseCutoffHz: rng.range(3000, 7000),
  }
}

const EMPTY_TIMELINE = (): Timeline => ({ durationS: 0, frameRate: 100, events: [], mouth: new Float32Array(0), level: new Float32Array(0), airflow: new Float32Array(0), f0: new Float32Array(0) })

// 主入口。同样的输入（含种子）总是得到同样的结果；换种子得到同一强度下的另一次发声。
// The main entry point. The same input (seed included) always gives the same result; another seed
// gives another repetition at the same intensity.
export function painVocalisation(input: PainVocalisationInput): PainVocalisation {
  const intensity = clamp(input.intensity, 0, 10)
  const { onset, sex } = input
  const k = input.knots ?? FITTED
  const rng = makeRng(input.seed)
  const pSound = soundProbability(intensity, onset)
  // 抽签的顺序固定，所以 'always' 和 'auto' 在出声的那些种子上给出同一次发声。
  // The order of the draws is fixed, so 'always' and 'auto' give the same vocalisation for seeds that sound.
  const silentByRule = rng.next() >= pSound
  const uType = rng.next()
  if (silentByRule && input.vocalise !== 'always') return { type: 'none', params: null, timeline: EMPTY_TIMELINE(), soundProbability: pSound, silentByRule }

  const probs = typeProbabilities(intensity, onset)
  let type: Exclude<VocalisationType, 'none'> = 'scream'
  let acc = 0
  for (const t of TYPES) {
    acc += probs[t]
    if (uType < acc) { type = t; break }
  }

  const at = (ys: readonly number[], low = false) => interp(k.intensity, ys, intensity, low)
  const male = sex === 'male'
  const raine = (key: 'f0MeanHz' | 'amplitudeDb' | 'hnrDb') => (i: number) => [RAINE_2019.male[key][i]!, RAINE_2019.female[key][i]!] as const
  // 男声：基频乘以 Raine 的男女比，电平和谐噪比加上 Raine 的男女差（谐噪比的差按 1 dB 噪声对 1 dB 谐噪比折算）。
  // Male: F0 is multiplied by Raine's male/female ratio; level and HNR take Raine's male–female
  // difference (the HNR difference is converted at 1 dB of noise per dB of HNR).
  const f0Ratio = male ? interp(RAINE_X, [0, 1, 2].map((i) => raine('f0MeanHz')(i)[0] / raine('f0MeanHz')(i)[1]), intensity) : 1
  const levelOffset = male ? interp(RAINE_X, [0, 1, 2].map((i) => raine('amplitudeDb')(i)[0] - raine('amplitudeDb')(i)[1]), intensity) : 0
  const hnrOffset = male ? interp(RAINE_X, [0, 1, 2].map((i) => raine('hnrDb')(i)[0] - raine('hnrDb')(i)[1]), intensity) : 0

  const typeF0 = { inhalation: 1, grunt: 0.9, moan: 0.92, cry: 1, scream: 1.15 }[type]
  const draw: Draw = {
    noiseDirect: at(k.noiseDirect),
    f0: clamp(at(k.f0Hz) * f0Ratio * typeF0 * Math.exp(rng.gauss() * at(k.f0SdLog)), male ? 70 : 120, male ? 1100 : 1700),
    excursion: clamp(at(k.f0ExcursionSt) * Math.exp(rng.gauss() * 0.5), 0.5, 30),
    tiltDb: at(k.tiltDb),
    noiseDb: at(k.noiseDb) - hnrOffset,
    subShare: at(k.subShare) * (type === 'grunt' || type === 'scream' ? 1.3 : 0.85),
    chaosShare: at(k.chaosShare) * (type === 'scream' ? 1.5 : type === 'moan' ? 0.6 : 1),
  }
  // 时长：突发用拟合出来的结点；持续性用 Raine 的各级平均时长（对数正态，σ = 0.45，中位数 = 均值 / e^{σ²/2}）。
  // Duration: fitted knots for sudden onset; for sustained pain the per-level mean durations of Raine
  // (log-normal with σ = 0.45, median = mean / e^{σ²/2}).
  const durSd = onset === 'sudden' ? at(k.durationSdLog) : 0.45
  const durMedian = onset === 'sudden' ? at(k.durationS) : interp(RAINE_X, RAINE_2019.durationS, intensity, true) / Math.exp(0.45 ** 2 / 2)
  const typeDur = onset === 'sudden' ? { inhalation: 0.7, grunt: 0.6, moan: 1.3, cry: 1.05, scream: 1.2 }[type] : { inhalation: 0.5, grunt: 0.5, moan: 1.1, cry: 1, scream: 1 }[type]
  const total = clamp(Math.max(0.2, durMedian) * typeDur * Math.exp(rng.gauss() * durSd), 0.12, onset === 'sudden' ? 2.5 : 8)
  const levelDb = clamp(at(k.levelDb, true) + levelOffset + rng.gauss() * at(k.levelSdDb), -70, -8)
  const unvoiced = clamp(at(k.unvoicedShare) * Math.exp(rng.gauss() * 0.6), 0, 0.8)

  const segments: Segment[] = []
  if (type === 'inhalation') {
    segments.push(inhaleSegment(clamp(total, 0.15, 0.9), 0, rng))
  } else {
    // 呼吸群：一口气里的有声呼气；持续性疼痛里长的发声分成两三口气，中间是短促的换气。
    // Breath groups: one voiced exhalation per breath; a long vocalisation in sustained pain is split
    // into two or three breaths with a quick catch-breath between them.
    // 每口气的有声部分至少约 0.7 秒才分开（假设）。/ A breath is only split off when each voiced part keeps at least about 0.7 s (assumption).
    const noiseS = unvoiced * total
    const voicedS = Math.max(0.1, total - noiseS)
    const wanted = onset === 'sustained' && total > 1.6 ? (total > 3.2 && rng.next() < 0.6 ? 3 : rng.next() < 0.7 ? 2 : 1) : 1
    const groups = Math.max(1, Math.min(wanted, Math.floor(voicedS / 0.7)))
    const lead = onset === 'sudden' ? rng.next() < 0.55 : rng.next() < 0.25
    if (lead && noiseS >= 0.06) segments.push(inhaleSegment(Math.min(noiseS, 0.6), rng.range(-12, -4), rng))
    const weights = Array.from({ length: groups }, () => rng.range(0.7, 1.3))
    const wSum = weights.reduce((a, b) => a + b, 0)
    for (let g = 0; g < groups; g++) {
      if (g > 0) segments.push(inhaleSegment(rng.range(0.25, 0.45), rng.range(-18, -12), rng))
      const seg = voicedSegment(type, (voicedS * weights[g]!) / wSum, { ...draw, f0: draw.f0 * 0.95 ** g }, rng)
      seg.relDb = -1.5 * g
      segments.push(seg)
    }
    if (!lead && noiseS >= 0.06) {
      const last = segments[segments.length - 1] as VoicedSegment
      // 气声的收尾接在有声段后面：有声段的包络不落到零，直接过渡。
      // A breathy release follows the voiced part: the voiced envelope does not fall to zero but hands over.
      last.amp[last.amp.length - 1]!.v = 0.25
      segments.push(exhaleSegment(Math.min(noiseS, 0.7), rng.range(-16, -8), last.mouth[last.mouth.length - 1]!.v, rng))
    }
  }
  const params: VocalisationParams = {
    sex,
    vocalTractCm: input.vocalTractCm ?? VOCAL_TRACT_CM[sex],
    levelDb,
    seed: Math.floor(rng.next() * 2 ** 31),
    segments,
  }
  return { type, params, timeline: computeTimeline(params), soundProbability: pSound, silentByRule }
}
