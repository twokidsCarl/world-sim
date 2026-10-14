// 写实的眼的"活"：自发眨眼、注视时的微扫视、瞳孔随疼痛变化。纯数据，不依赖 three.js；给定种子，时间表完全确定。
// What keeps the lifelike eyes alive: spontaneous blinks, microsaccades while fixating, and the pupil following pain. Pure
// data, no three.js; given a seed, the schedules are fully deterministic.
//
// 时间用"眼的时钟"（秒）：只在写实的眼显示、页面可见时走，所以页面隐藏时眨眼和微扫视都停下。
// Time is the "eye clock" (seconds): it runs only while the lifelike eyes show and the page is visible, so blinks and
// microsaccades stop while the page is hidden.
//
// 来源 / Sources
//   · 自发眨眼频率：100 名男性在正视、安静时平均 13.8 ± 9.7 次/分（Doughty & Naase 2006）；Doughty 的综述给出正视 8–21、
//     交谈 10.5–32.5 次/分。这里取 15 次/分；间隔的分布（伽马分布，形状 2，最短 1 s）是假设。
//     Spontaneous blink rate: 13.8 ± 9.7 per minute in 100 men in primary gaze and silence (Doughty & Naase 2006); Doughty's
//     review gives 8–21 in primary gaze and 10.5–32.5 in conversation. 15 per minute is used here; the distribution of the
//     intervals (gamma, shape 2, at least 1 s) is an assumption.
//   · 眨眼的运动学：Kwon 等 2013（J R Soc Interface 10:20130227，600 帧/秒，25 人）——闭合约 0.1 s，闭着 58 ± 4 ms，
//     从开始到恢复 97% 共 299 ± 8 ms；闭合的峰速（243 mm/s）比睁开（157 mm/s）快约 1.5 倍。他们测的是自主眨眼；
//     自发眨眼也取同样的形状，只是不算最后 3% 的慢恢复。
//     Blink kinematics: Kwon et al. 2013 (J R Soc Interface 10:20130227, 600 frames/s, 25 people) — closing about 0.1 s,
//     closed 58 ± 4 ms, 299 ± 8 ms from the start to 97% recovery; peak closing speed (243 mm/s) about 1.5 times the opening
//     (157 mm/s). They measured voluntary blinks; spontaneous blinks take the same shape here, without the slow last 3%.
//   · 微扫视：幅度 2–120 角分（Wikipedia "Microsaccade"），历时约 25 ms（Martinez-Conde，Barrow Quarterly）。频率
//     每秒约 1–2 次是常见的说法，这里取 1.2 次/秒，没有核对原始文献，算假设；幅度取 6–30 角分。
//     Microsaccades: 2–120 arcmin (Wikipedia "Microsaccade"), lasting about 25 ms (Martinez-Conde, Barrow Quarterly). One to
//     two per second is the usual statement; 1.2 per second is used here, not checked against a primary source, so an
//     assumption; amplitudes are taken between 6 and 30 arcmin.
//   · 瞳孔：疼痛模型的自主体征表（data/curated/pain/autonomic.json，只读）——基线 4 mm，在参考强度 6 时扩大 28%，
//     上升、回落的时间常数 0.3 s、2 s。那些数值来自麻醉下的病人。场景的光照是固定的，所以没有光照项。
//     Pupil: the pain model's table of autonomic signs (data/curated/pain/autonomic.json, read only) — baseline 4 mm, 28%
//     wider at the reference intensity 6, rising and falling with time constants of 0.3 s and 2 s. Those numbers come from
//     anaesthetised patients. The scene's lighting is fixed, so there is no light term.

import { AUTONOMIC } from '../painmodel/tables.ts'
import { EYE } from './eyesFit.ts'

export const BLINK = {
  /** 每分钟次数 / per minute */
  ratePerMin: 15,
  /** 间隔的伽马分布形状、最短间隔（秒）/ gamma shape of the intervals and the shortest interval (seconds) */
  shape: 2,
  minInterval: 1,
  /** 闭合、闭着、睁开（秒）/ closing, closed, opening (seconds) */
  close: 0.1,
  closed: 0.05,
  open: 0.15,
}

export const MICROSACCADE = {
  perSecond: 1.2,
  /** 幅度（度）/ amplitude (degrees) */
  min: 0.1,
  max: 0.5,
  /** 离注视点的偏移不超过（度）/ the offset from the fixation point never exceeds (degrees) */
  bound: 0.5,
}

/** 缺省的种子 / the default seed */
export const DEFAULT_SEED = 0x50a1

/** mulberry32：一个小而确定的伪随机数发生器 / mulberry32: a small deterministic pseudo-random generator */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 形状为整数 k 的伽马分布：k 个指数分布之和 / gamma with an integer shape k: the sum of k exponentials */
function gamma(r: () => number, k: number, mean: number): number {
  let s = 0
  for (let i = 0; i < k; i++) s -= Math.log(1 - r())
  return (s * mean) / k
}

/** 一次眨眼开始后 t 秒的闭合程度（0 睁开 … 1 闭合）/ How closed the lids are t seconds after a blink starts (0 open … 1 closed). */
export function blinkCurve(t: number): number {
  const { close, closed, open } = BLINK
  if (t <= 0) return 0
  // 两段都用余弦缓动：峰速与时长成反比，闭合比睁开快 open/close = 1.5 倍 / both phases ease with a cosine: peak speed goes inversely with duration, so closing is open/close = 1.5 times faster
  if (t < close) return 0.5 - 0.5 * Math.cos((Math.PI * t) / close)
  if (t < close + closed) return 1
  const u = (t - close - closed) / open
  if (u < 1) return 0.5 + 0.5 * Math.cos(Math.PI * u)
  return 0
}

/** 一次眨眼的总时长（秒）/ Total duration of one blink (seconds). */
export const BLINK_SECONDS = BLINK.close + BLINK.closed + BLINK.open

/**
 * 眼的"活"：按种子生成的眨眼和微扫视时间表（按需往后延长），以及瞳孔的一阶平滑。
 * The eyes' life: the blink and microsaccade schedules generated from the seed (extended on demand), and the first-order
 * smoothing of the pupil.
 */
export class EyeLife {
  private readonly blinkRng: () => number
  private readonly saccadeRng: () => number
  /** 眨眼开始的时刻（秒，递增）/ blink start times (seconds, increasing) */
  readonly blinks: number[] = []
  /** 微扫视：时刻和之后的偏移（度）/ microsaccades: time and the offset after it (degrees) */
  readonly saccades: { t: number; yaw: number; pitch: number }[] = []
  private pupil = EYE.pupilDefault

  constructor(readonly seed: number = DEFAULT_SEED) {
    this.blinkRng = rng(seed)
    this.saccadeRng = rng(seed ^ 0x9e3779b9)
  }

  private extend(t: number): void {
    const mean = 60 / BLINK.ratePerMin
    while (!this.blinks.length || this.blinks[this.blinks.length - 1]! < t + 1) {
      const last = this.blinks.length ? this.blinks[this.blinks.length - 1]! : 0
      this.blinks.push(last + Math.max(BLINK.minInterval, gamma(this.blinkRng, BLINK.shape, mean)))
    }
    while (!this.saccades.length || this.saccades[this.saccades.length - 1]!.t < t + 1) {
      const prev = this.saccades.length ? this.saccades[this.saccades.length - 1]! : { t: 0, yaw: 0, pitch: 0 }
      const dt = -Math.log(1 - this.saccadeRng()) / MICROSACCADE.perSecond
      const amp = MICROSACCADE.min + (MICROSACCADE.max - MICROSACCADE.min) * this.saccadeRng()
      const dir = 2 * Math.PI * this.saccadeRng()
      let yaw = prev.yaw + amp * Math.cos(dir)
      let pitch = prev.pitch + amp * Math.sin(dir)
      // 偏得太远就拉回注视点那一侧 / too far out, it is pulled back towards the fixation point
      const r = Math.hypot(yaw, pitch)
      if (r > MICROSACCADE.bound) {
        yaw = (yaw / r) * MICROSACCADE.bound * this.saccadeRng()
        pitch = (pitch / r) * MICROSACCADE.bound * this.saccadeRng()
      }
      this.saccades.push({ t: prev.t + dt, yaw, pitch })
    }
  }

  /** 时刻 t 的眨眼闭合程度 0–1 / blink closure 0–1 at time t */
  blinkAt(t: number): number {
    this.extend(t)
    // 最近一次开始于 t 之前的眨眼 / the latest blink that started before t
    let lo = 0, hi = this.blinks.length - 1, k = -1
    while (lo <= hi) {
      const m = (lo + hi) >> 1
      if (this.blinks[m]! <= t) {
        k = m
        lo = m + 1
      } else hi = m - 1
    }
    return k < 0 ? 0 : blinkCurve(t - this.blinks[k]!)
  }

  /** 时刻 t 注视的微小偏移（度）/ the small gaze offset at time t (degrees) */
  offsetAt(t: number): { yaw: number; pitch: number } {
    this.extend(t)
    let cur = { yaw: 0, pitch: 0 }
    for (let i = this.saccades.length - 1; i >= 0; i--) {
      if (this.saccades[i]!.t <= t) {
        cur = this.saccades[i]!
        break
      }
    }
    return { yaw: cur.yaw, pitch: cur.pitch }
  }

  /** 往后推进 dt 秒的瞳孔直径（米）：向目标一阶趋近，扩大用上升时间常数、回缩用回落时间常数 / the pupil diameter (metres) after dt seconds: a first-order approach to the target, the rise time constant when widening, the fall when narrowing */
  stepPupil(dt: number, target: number): number {
    const s = AUTONOMIC.signs.pupil
    const tau = target > this.pupil ? s.rise.value : s.fall.value
    this.pupil = dt > 0 ? this.pupil + (target - this.pupil) * (1 - Math.exp(-dt / Math.max(1e-3, tau))) : target
    if (Math.abs(this.pupil - target) < 1e-6) this.pupil = target
    return this.pupil
  }
}

/**
 * 疼痛强度（0–10，持续的）对应的瞳孔直径（米）：自主体征表的公式，基线 × (1 + 效应% × 强度 / 参考强度)，限在 2–8 mm。
 * The pupil diameter (metres) for a sustained pain intensity (0–10): the autonomic table's formula,
 * baseline × (1 + effect% × intensity / reference), kept within 2–8 mm.
 */
export function pupilForPain(level: number): number {
  const s = AUTONOMIC.signs.pupil
  const k = Math.max(0, level) / s.referenceIntensity.value
  const mm = s.mode === 'percent' ? s.baseline.value * (1 + (s.effect.value / 100) * k) : s.baseline.value + s.effect.value * k
  return Math.min(EYE.pupilRange[1], Math.max(EYE.pupilRange[0], mm / 1000))
}

/**
 * 瞳孔的目标直径（米）：刺激正在进行时直接取疼痛模型的瞳孔输出（它自己已经带了时间过程，direct = true）；
 * 否则按持续的疼痛强度（"保持"）算，没有疼痛时是基线 4 mm。只读 store 的状态。
 * The target pupil diameter (metres): while a stimulus runs, the pain model's pupil output as it is (it already carries its
 * time course; direct = true); otherwise from the sustained pain level ("hold"), the 4 mm baseline without pain. Reads the
 * store's state only.
 */
export function pupilTarget(s: { pain: { level: number; hold: boolean }; stimNow: { running: boolean; sample: { autonomic: { pupil: number } } } | null }): { target: number; direct: boolean } {
  if (s.stimNow?.running) return { target: Math.min(EYE.pupilRange[1], Math.max(EYE.pupilRange[0], s.stimNow.sample.autonomic.pupil / 1000)), direct: true }
  return { target: pupilForPain(s.pain.hold ? s.pain.level : 0), direct: false }
}
