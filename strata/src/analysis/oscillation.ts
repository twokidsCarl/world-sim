// 在不等间隔时刻采样的振荡（可能有阻尼、可能有偏置）的频率。
// Frequency of a (possibly damped, possibly offset) oscillation sampled at uneven times.

import { leastSquares } from './linalg'

/**
 * 用线性最小二乘做最佳拟合 a cos ωt + b sin ωt + c 后的残差。
 * Residual of the best fit a cos ωt + b sin ωt + c, by linear least squares.
 */
function residual(t: ArrayLike<number>, y: ArrayLike<number>, omega: number): number {
  const rows: number[][] = []
  const b: number[] = []
  for (let i = 0; i < t.length; i++) {
    rows.push([Math.cos(omega * t[i]!), Math.sin(omega * t[i]!), 1])
    b.push(y[i]!)
  }
  let w: number[]
  try {
    w = leastSquares(rows, b)
  } catch {
    return Infinity
  }
  let r = 0
  for (let i = 0; i < b.length; i++) r += (b[i]! - (w[0]! * rows[i]![0]! + w[1]! * rows[i]![1]! + w[2]!)) ** 2
  return r
}

/**
 * 主振荡的角频率；如果记录覆盖不足 `minPeriods` 个周期则返回 null
 * （记录太短时得到的频率会严重偏高）。在每个试探频率上拟合一个正弦并保留
 * 拟合最好的那个；记录太短、Fourier 变换分辨不出谱峰时，这种做法仍然有效。
 * Angular frequency of the dominant oscillation, or null if the record covers fewer than
 * `minPeriods` periods of it (shorter records give frequencies that are far too high). A sinusoid is fitted at each trial frequency
 * and the best fit kept, which works on records too short for a Fourier transform to
 * resolve the peak.
 */
export function dominantFrequency(
  t: ArrayLike<number>,
  y: ArrayLike<number>,
  minPeriods = 0.75,
): { omega: number; quality: number } | null {
  const n = t.length
  if (n < 8) return null
  const span = t[n - 1]! - t[0]!
  let mean = 0
  for (let i = 0; i < n; i++) mean += y[i]! / n
  let total = 0
  for (let i = 0; i < n; i++) total += (y[i]! - mean) ** 2
  // 除舍入误差外没有变化：无可拟合。 / No variation beyond rounding: nothing to fit.
  if (!(total > 1e-20 * n * mean * mean) || total === 0) return null
  const lo = (2 * Math.PI * minPeriods) / span
  const hi = (Math.PI * n) / span / 4
  if (hi <= lo) return null
  const steps = 400
  let best = lo
  let bestR = Infinity
  for (let i = 0; i <= steps; i++) {
    const omega = lo * Math.pow(hi / lo, i / steps)
    const r = residual(t, y, omega)
    if (r < bestR) {
      bestR = r
      best = omega
    }
  }
  // 最佳拟合落在最低的试探频率上，说明真实周期比记录所能容纳的还长：
  // 尚未分辨出来。
  // The best fit sitting at the lowest trial frequency means the true period is longer
  // than the record allows: not resolved yet.
  if (best === lo) return null
  // 在相邻的两个试探频率之间用黄金分割搜索进一步细化。
  // Refine by golden-section search between the neighbouring trial frequencies.
  const ratio = Math.pow(hi / lo, 1 / steps)
  let a = best / ratio
  let b = best * ratio
  const g = (Math.sqrt(5) - 1) / 2
  for (let i = 0; i < 40; i++) {
    const c = b - g * (b - a)
    const d = a + g * (b - a)
    if (residual(t, y, c) < residual(t, y, d)) b = d
    else a = c
  }
  const omega = (a + b) / 2
  return { omega, quality: 1 - residual(t, y, omega) / total }
}
