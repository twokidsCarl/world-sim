// Analyses over the recorded concentration profile: what equation does it obey?

import { dmd } from '../analysis/dmd'
import { equationText, weakSindy } from '../analysis/sindy'
import type { AnalysisDef, History } from '../core/quantity'

const SNAPSHOTS = 60
/**
 * A term must contribute at least this fraction of the largest term to be kept. Binned
 * particle data are noisy (a few percent per bin), and at 0.1 the regression keeps small
 * spurious terms that fit that noise.
 */
const SPARSITY = 0.2

/** Linear interpolation of the history onto `count` equally spaced times. */
export function resample(h: History, count: number): { data: Float64Array[]; dt: number } {
  const t0 = h.t[0]!
  const dt = (h.t[h.t.length - 1]! - t0) / (count - 1)
  const data: Float64Array[] = []
  let k = 0
  for (let i = 0; i < count; i++) {
    const t = t0 + i * dt
    while (k < h.t.length - 2 && h.t[k + 1]! < t) k++
    const w = Math.min(1, Math.max(0, (t - h.t[k]!) / (h.t[k + 1]! - h.t[k]!)))
    data.push(Float64Array.from(h.y[k]!, (v, j) => v + w * (h.y[k + 1]![j]! - v)))
  }
  return { data, dt }
}

/** Solution of ∂c/∂t = D ∂²c/∂y² on a periodic grid after `time`, by Fourier modes. */
export function diffuse(c0: ArrayLike<number>, D: number, time: number, dy: number): Float64Array {
  const n = c0.length
  const out = new Float64Array(n)
  for (let m = 0; m <= n / 2; m++) {
    let a = 0
    let b = 0
    for (let j = 0; j < n; j++) {
      a += c0[j]! * Math.cos((2 * Math.PI * m * j) / n)
      b += c0[j]! * Math.sin((2 * Math.PI * m * j) / n)
    }
    const k = (2 * Math.PI * m) / (n * dy)
    // The zero and Nyquist modes appear once in the sum, the others twice.
    const weight = ((m === 0 || 2 * m === n ? 1 : 2) / n) * Math.exp(-D * k * k * time)
    for (let j = 0; j < n; j++) {
      out[j]! += weight * (a * Math.cos((2 * Math.PI * m * j) / n) + b * Math.sin((2 * Math.PI * m * j) / n))
    }
  }
  return out
}

const mixture = (p: Record<string, number>) => p.fractionB! > 0 && p.layoutB === 1 && !p.walls

export const MD_ANALYSES: AnalysisDef[] = [
  {
    id: 'sindy',
    level: 'meta',
    label: '方程发现：浓度服从什么方程',
    source: 'concentration',
    minSamples: 40,
    when: mixture,
    compute(h) {
      const { data, dt } = resample(h, SNAPSHOTS)
      const dy = h.x[1]! - h.x[0]!
      const fit = weakSindy(data, dt, dy, undefined, SPARSITY)
      const pureDiffusion = fit.coefficients[0]! > 0 && fit.coefficients.slice(1).every((w) => w === 0)
      const elapsed = dt * (SNAPSHOTS - 1)
      return {
        headline: equationText(fit),
        detail: `候选项 5 个，稀疏回归保留了其中 ${fit.coefficients.filter((w) => w !== 0).length} 个；拟合优度 R² = ${fit.r2.toFixed(3)}；用了 ${elapsed.toFixed(0)} 个时间单位内的剖面`,
        curve: { x: h.x, y: data[SNAPSHOTS - 1]! },
        theory: pureDiffusion ? { x: h.x, y: diffuse(data[0]!, fit.coefficients[0]!, elapsed, dy) } : undefined,
        xLabel: '横向位置 y / σ',
        theoryLabel: '用发现的方程把最早的剖面推演到现在',
      }
    },
  },
  {
    id: 'dmd',
    level: 'meta',
    label: '动态模态分解：各模态衰减多快',
    source: 'concentration',
    minSamples: 40,
    when: mixture,
    compute(h) {
      const { data, dt } = resample(h, SNAPSHOTS)
      const dy = h.x[1]! - h.x[0]!
      // Rank 4: the conserved mean and the slowest decaying shapes.
      const { rates } = dmd(data, dt, 4)
      const measured = [-rates[1]!.re, -rates[2]!.re]
      const D = weakSindy(data, dt, dy, undefined, SPARSITY).coefficients[0]!
      const k1 = (2 * Math.PI) / (h.x.length * dy)
      const predicted = [D * k1 * k1, 4 * D * k1 * k1]
      return {
        headline: `两个最慢模态的衰减率：${measured[0]!.toPrecision(3)} 和 ${measured[1]!.toPrecision(3)}`,
        detail:
          D > 0
            ? `扩散方程预言 D·(2πn/L)² = ${predicted[0]!.toPrecision(3)} 和 ${predicted[1]!.toPrecision(3)}（D 取自上面的拟合），比值 ${(measured[0]! / predicted[0]!).toFixed(2)} 和 ${(measured[1]! / predicted[1]!).toFixed(2)}。两种方法互不相干：一个拟合方程，一个只找线性模态。DMD 对噪声和所取的时间窗敏感，这里的偏差可达三四成，只能算量级上的印证。`
            : '上面的拟合没有给出正的扩散系数，无法比较。',
        curve: { x: [1, 2], y: measured },
        theory: D > 0 ? { x: [1, 2], y: predicted } : undefined,
        xLabel: '模态序号 n',
        theoryLabel: '扩散方程：衰减率正比于 n²',
      }
    },
  },
]
