// 显示用的标度和颜色：激活度 → 色带上的位置、长度变化 → 冷暖色。图例和三维视图用同一组函数，所以图例是准的。
// Display scales and colours: activation → position on the ramp, length change → warm or cool. The legend and
// the 3D view use the same functions, so the legend is exact.

/** 色带上的停靠点，十六进制 sRGB / Ramp stops, hex sRGB. */
export interface Stop {
  t: number
  color: string
}

/**
 * 负荷（估计）：不用力的肌肉是去饱和的灰红色（比正常的肌肉色淡，解剖仍然看得清），用力越多越暖、越亮：
 * 砖红 → 橙红 → 橙 → 亮黄。
 * Load (estimate): a muscle doing nothing is a desaturated grey-red (paler than the normal muscle colour, the
 * anatomy stays readable); the more it works the warmer and brighter: brick → orange-red → orange → bright yellow.
 */
export const LOAD_RAMP: Stop[] = [
  { t: 0, color: '#8f7d79' },
  { t: 0.2, color: '#b8553c' },
  { t: 0.45, color: '#e8491c' },
  { t: 0.72, color: '#ff8c1a' },
  { t: 1, color: '#ffe35a' },
]

/** 长度变化：缩短为暖色（橙），拉长为冷色（蓝），不变为去饱和的肌肉色 / Length change: shortened warm (orange), lengthened cool (blue), unchanged the desaturated muscle colour. */
export const LENGTH_RAMP: Stop[] = [
  { t: -1, color: '#ffb02e' },
  { t: -0.5, color: '#e0672a' },
  { t: 0, color: '#8f7d79' },
  { t: 0.5, color: '#4f86c9' },
  { t: 1, color: '#49b6ff' },
]

/** 没有数据的肌肉（没有作用线，或不参与负荷估计）/ Muscles without data (no line, or left out of the load estimate). */
export const NO_DATA_COLOR = '#7d7774'

/** 长度变化达到 ±这个比例即为满色 / Length change at which the colour saturates (±). */
export const LENGTH_FULL = 0.2

/**
 * 激活度 → 0…1 的显示量。抵抗重力保持姿势的激活度通常只有百分之几，所以用幂函数把低端拉开；达到 `full` 即为满。
 * Activation → a display level in 0…1. Holding a posture against gravity usually takes a few per cent only, so a
 * power law spreads the low end; `full` and above is the top.
 */
export function loadLevel(activation: number, full: number): number {
  if (!(activation > 0)) return 0
  return Math.min(1, Math.pow(activation / full, 0.55))
}

/** 长度变化（比值 − 1）→ −1…1：负为缩短 / Length change (ratio − 1) → −1…1; negative = shortened. */
export function lengthLevel(d: number): number {
  const a = Math.min(1, Math.pow(Math.abs(d) / LENGTH_FULL, 0.7))
  return d < 0 ? -a : a
}

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]

/** 色带在 t 处的颜色（sRGB 0…255 三个分量）/ The ramp's colour at t (sRGB, three components 0…255). */
export function rampColor(ramp: Stop[], t: number): [number, number, number] {
  if (t <= ramp[0]!.t) return hex(ramp[0]!.color)
  for (let i = 1; i < ramp.length; i++) {
    const a = ramp[i - 1]!, b = ramp[i]!
    if (t <= b.t) {
      const k = (t - a.t) / (b.t - a.t)
      const ca = hex(a.color), cb = hex(b.color)
      return [ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k]
    }
  }
  return hex(ramp[ramp.length - 1]!.color)
}

export function rampCss(ramp: Stop[], t: number): string {
  const c = rampColor(ramp, t)
  return `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`
}

/** 图例用的 CSS 渐变，按显示量均匀取样 / A CSS gradient for the legend, sampled evenly in display level. */
export function rampGradient(ramp: Stop[], from: number, to: number, steps = 12): string {
  const parts: string[] = []
  for (let i = 0; i <= steps; i++) parts.push(`${rampCss(ramp, from + ((to - from) * i) / steps)} ${Math.round((100 * i) / steps)}%`)
  return `linear-gradient(90deg, ${parts.join(', ')})`
}

/**
 * 肌腹增粗量：显示量 × 上限。着色器里肌腹中段按 1 + b 增粗，两端相应变细，使体积到一阶不变（见 skinning.ts）。
 * Belly thickening: display level × the maximum. In the shader the mid-belly thickens by 1 + b and the ends thin
 * accordingly, keeping volume to first order (see skinning.ts).
 */
export function bulgeAmount(activation: number, full: number, max: number): number {
  return max * loadLevel(activation, full)
}
