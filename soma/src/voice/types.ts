// 合成器的数据契约：控制层写，信号层读。
// The synthesizer's data contract: written by the control layer, read by the signal layer.
//
// 这是用于教学的疼痛行为计算模型；被模拟的身体没有主观体验，这里的「疼痛强度」只是模型的一个输入量。
// This is a computational model of pain behaviour for teaching; the simulated body has no subjective
// experience, and "pain intensity" here is nothing more than an input to the model.

export type Sex = 'male' | 'female'
export type Onset = 'sudden' | 'sustained'
export type VocalisationType = 'none' | 'inhalation' | 'grunt' | 'moan' | 'cry' | 'scream'
export type Vowel = 'schwa' | 'a' | 'e' | 'o' | 'u' | 'i'

// 控制点：t 是段内归一化时间 0–1 / a control point; t is normalised time within the segment, 0–1
export interface Anchor {
  t: number
  v: number
}

// 一段非线性发声：次谐波（倍周期）或混沌（强烈的周期与幅度扰动）。
// A stretch of nonlinear phonation: subharmonics (period doubling) or chaos (strong period and amplitude perturbation).
export interface NonlinearSpan {
  t0: number
  t1: number
  kind: 'sub' | 'chaos'
  // 0–1
  depth: number
}

interface SegmentBase {
  durationS: number
  // 幅度包络 0–1 / amplitude envelope, 0–1
  amp: Anchor[]
  // 张口度 0（闭）–1（全开），以后由下颌驱动 / mouth opening, 0 (closed) to 1 (fully open); to be driven by the jaw later
  mouth: Anchor[]
  vowel: Vowel
  // 本段相对整段发声目标电平的电平（dB）/ this segment's level relative to the vocalisation's target level (dB)
  relDb: number
}

export interface VoicedSegment extends SegmentBase {
  kind: 'voiced'
  // 基频轮廓（Hz），在对数域内平滑插值 / F0 contour (Hz), smoothly interpolated in the log domain
  f0: Anchor[]
  // 开商：声门开放时间占周期的比例，0.3–0.9 / open quotient: share of the period the glottis is open, 0.3–0.9
  openQuotient: number
  // 频谱倾斜：3 kHz 处相对直流衰减的 dB 数；负值表示提升高频（声音更亮、更「挤」）。
  // spectral tilt: attenuation at 3 kHz relative to DC, in dB; negative values boost the highs (brighter, more pressed).
  tiltDb: number
  // 周期扰动与幅度扰动（标准差，相对值）/ jitter and shimmer (standard deviation, relative)
  jitter: number
  shimmer: number
  // 送气噪声相对声门脉冲的电平（dB）/ aspiration noise level relative to the glottal pulses (dB)
  noiseDb: number
  // 送气噪声不经声道滤波直接辐射的比例（0 = 全部经过滤波），决定高频噪声的多少
  // share of the aspiration noise radiated without the tract filter (0 = all filtered); sets how much high-frequency noise there is
  noiseDirect: number
  // 基频的慢速随机漂移（半音，标准差）/ slow random F0 drift (semitones, standard deviation)
  flutterSt: number
  nonlinear: NonlinearSpan[]
}

// 无声段：吸气（倒抽气）或呼出的气声。/ An unvoiced segment: an inhalation (gasp) or breathy exhalation noise.
export interface NoiseSegment extends SegmentBase {
  kind: 'inhale' | 'exhale'
  // 噪声源的低通截止频率（Hz）/ low-pass cutoff of the noise source (Hz)
  noiseCutoffHz: number
}

export interface PauseSegment {
  kind: 'pause'
  durationS: number
}

export type Segment = VoicedSegment | NoiseSegment | PauseSegment

export interface VocalisationParams {
  sex: Sex
  // 声道长度（厘米），决定共振峰间距 / vocal-tract length (cm); sets the formant spacing
  vocalTractCm: number
  // 整段发声的目标均方根电平，dB 相对满刻度（只在有声音的样本上统计）
  // target RMS level of the vocalisation in dB re full scale (over sounding samples only)
  levelDb: number
  // 信号层用的随机种子（噪声、扰动）/ seed for the signal layer (noise, perturbations)
  seed: number
  segments: Segment[]
}

export interface TimelineEvent {
  kind: Segment['kind']
  startS: number
  endS: number
}

// 给面部表情和呼吸动画读的时间线，帧率固定；不需要渲染音频就能算出来。
// The timeline that facial expression and breathing animation read, at a fixed frame rate; it can be
// computed without rendering any audio.
export interface Timeline {
  durationS: number
  frameRate: number
  events: TimelineEvent[]
  // 每帧的张口度 0–1（停顿时回到 0）/ mouth opening per frame, 0–1 (returns to 0 in pauses)
  mouth: Float32Array
  // 每帧的相对响度包络 0–1 / relative loudness envelope per frame, 0–1
  level: Float32Array
  // 每帧的气流方向与大小：吸气为负，呼气（含发声）为正，−1…1
  // airflow direction and size per frame: negative for inhalation, positive for exhalation (voiced or not), −1…1
  airflow: Float32Array
  // 每帧的目标基频（Hz），无声为 0 / target F0 per frame (Hz), 0 when unvoiced
  f0: Float32Array
}

export interface RenderResult {
  sampleRate: number
  // 单声道 PCM，范围 (−1, 1) / mono PCM within (−1, 1)
  pcm: Float32Array
  timeline: Timeline
  // 为了不削波而整体降低的 dB 数（通常为 0）/ dB by which the whole signal was lowered to avoid clipping (normally 0)
  limitedDb: number
}
