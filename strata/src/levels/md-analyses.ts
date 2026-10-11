// 对记录下来的浓度分布做分析：它服从什么方程？
// Analyses over the recorded concentration profile: what equation does it obey?

import { dmd } from '../analysis/dmd'
import { dominantFrequency } from '../analysis/oscillation'
import { equationText, weakSindy } from '../analysis/sindy'
import type { AnalysisDef, History } from '../core/quantity'
import { boxOf, potentialSpec } from '../substrates/md/schema'
import { cutoffPressureCorrection2d, ljFluid2d, ljFluid2dApplies } from '../theory/ljEos'
import { virialSoundSpeed } from '../theory/sound'

const SNAPSHOTS = 60
/**
 * 一项的贡献至少要达到最大项的这个比例才会被保留。分箱后的粒子数据噪声较大
 * （每个箱百分之几），阈值取 0.1 时回归会留下一些拟合噪声的小的虚假项。
 * A term must contribute at least this fraction of the largest term to be kept. Binned
 * particle data are noisy (a few percent per bin), and at 0.1 the regression keeps small
 * spurious terms that fit that noise.
 */
const SPARSITY = 0.2

/**
 * 把历史记录线性插值到 `count` 个等间隔时刻上。
 * Linear interpolation of the history onto `count` equally spaced times.
 */
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

/**
 * 用 Fourier 模式求 ∂c/∂t = D ∂²c/∂y² 在周期网格上经过 `time` 之后的解。
 * Solution of ∂c/∂t = D ∂²c/∂y² on a periodic grid after `time`, by Fourier modes.
 */
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
    // 零模和 Nyquist 模在求和中只出现一次，其余模出现两次。
    // The zero and Nyquist modes appear once in the sum, the others twice.
    const weight = ((m === 0 || 2 * m === n ? 1 : 2) / n) * Math.exp(-D * k * k * time)
    for (let j = 0; j < n; j++) {
      out[j]! += weight * (a * Math.cos((2 * Math.PI * m * j) / n) + b * Math.sin((2 * Math.PI * m * j) / n))
    }
  }
  return out
}

const mixture = (p: Record<string, number>) => p.fractionB! > 0 && p.layoutB === 1 && !p.walls && p.dim !== 3

/**
 * 序列后半段的平均值与标准误。把后半段切成 10 块、用块平均的离散程度估计误差，
 * 这样相邻样本之间的相关不会让误差被低估。
 * Mean and standard error of the second half of a series. The half is cut into 10 blocks
 * and the error estimated from the scatter of the block means, so that correlation
 * between neighbouring samples does not make it look smaller than it is.
 */
export function blockAverage(values: number[]): { mean: number; error: number } {
  const half = values.slice(Math.floor(values.length / 2))
  const blocks = 10
  const size = Math.floor(half.length / blocks)
  const means: number[] = []
  for (let b = 0; b < blocks; b++) {
    let sum = 0
    for (let i = b * size; i < (b + 1) * size; i++) sum += half[i]!
    means.push(sum / size)
  }
  const mean = means.reduce((a, c) => a + c, 0) / blocks
  const variance = means.reduce((a, c) => a + (c - mean) ** 2, 0) / (blocks - 1)
  return { mean, error: Math.sqrt(variance / blocks) }
}

/**
 * 长波极限 S(k→0) = ρ T κ_T = T / (∂P/∂ρ)_T，压强取已发表的状态方程加截断修正。
 * 只在该状态方程适用时有值。
 * The long-wavelength limit S(k→0) = ρ T κ_T = T / (∂P/∂ρ)_T, with the pressure from the
 * published equation of state plus the cutoff correction. Defined only where that
 * equation of state applies.
 */
export function compressibilityLimit(p: Record<string, number>, T: number): number | null {
  const spec = potentialSpec(p)
  const applies =
    p.dim !== 3 &&
    spec.kind === 'mie' &&
    spec.n === 12 &&
    spec.m === 6 &&
    spec.rc >= 4 &&
    !p.fractionB &&
    !p.walls &&
    ljFluid2dApplies(p.density!, T)
  if (!applies) return null
  const pressure = (rho: number) => ljFluid2d(rho, T).pressure + cutoffPressureCorrection2d(spec, rho)
  const h = 1e-4
  return T / ((pressure(p.density! + h) - pressure(p.density! - h)) / (2 * h))
}

export const MD_ANALYSES: AnalysisDef[] = [
  {
    id: 'compressibility',
    level: 'structure',
    label: '长波极限：S(k→0) 对压缩率',
    source: 'lowK',
    minSamples: 100,
    when: (p) => !p.walls && p.dim !== 3,
    compute(h, p, latest) {
      const { mean, error } = blockAverage(h.y.map((y) => y[0]!))
      const T = latest('temperature') ?? p.temperature!
      const theory = compressibilityLimit(p, T)
      return {
        headline: `最长波处 S = ${mean.toPrecision(3)} ± ${error.toPrecision(2)}`,
        detail:
          theory === null
            ? '理想气体为 1；越不可压缩越小。这一组参数下没有可用的状态方程来给出理论值（需要二维 12-6 势、rc ≥ 4）。'
            : `涨落–压缩率关系给出 T / (∂P/∂ρ) = ${theory.toPrecision(3)}（压强取已发表的状态方程）。密度的自发涨落有多大，由流体有多难压缩决定。`,
        agree: theory === null ? undefined : Math.abs(mean - theory) < Math.max(3 * error, 0.15 * theory),
      }
    },
  },
  {
    id: 'wake',
    level: 'hydro',
    label: '圆盘后面有没有回流',
    source: 'wakeVelocity',
    minSamples: 60,
    when: (p) => p.walls === 1 && p.obstacle! > 0 && p.dim !== 3,
    compute(h) {
      const { mean, error } = blockAverage(h.y.map((y) => y[0]!))
      const backflow = mean + 2 * error < 0
      return {
        headline: `背风面的平均流速 ${mean.toFixed(3)} ± ${error.toFixed(3)}`,
        detail: backflow
          ? '明显为负：紧贴圆盘背后的流体在逆着来流方向走，那里有一对回流涡。没有任何一个粒子被规定要这样运动。'
          : '还不能说是负的。回流只在雷诺数够大时出现；流动建立起来也需要时间（取记录的后一半做平均）。',
        agree: backflow,
      }
    },
  },
  {
    id: 'sound',
    level: 'hydro',
    label: '声速：由最长密度波的振荡频率',
    source: 'soundMode',
    minSamples: 30,
    when: (p) => !p.walls,
    compute(h, p, latest) {
      // 至少一个完整周期：记录更短会高估频率。
      // At least one full period: shorter records overestimate the frequency.
      const fit = dominantFrequency(
        h.t,
        h.y.map((y) => y[0]!),
        1,
      )
      // 仅有热噪声时拟合很差；激发出的声波则拟合得很干净。
      // Thermal noise alone gives a poor fit; a launched wave gives a clean one.
      if (!fit || fit.quality < 0.5) {
        return { headline: '还没有清晰的振荡', detail: '点页头的“敲一下”激发一列驻波，再等它振荡满一个周期。' }
      }
      const dim = p.dim === 3 ? 3 : 2
      const k = (2 * Math.PI) / boxOf(p, p.backend === 0)[0]!
      const c = fit.omega / k
      // 冲击本身会使气体略微升温，所以采用实际测得的温度。
      // The kick itself heats the gas a little, so use the temperature actually measured.
      const T = latest('temperature') ?? p.temperature!
      const theory = virialSoundSpeed(potentialSpec(p), p.density!, T, dim)
      const ideal = Math.sqrt(((dim + 2) / dim) * T)
      return {
        headline: `声速 c = ω / k = ${c.toPrecision(3)}`,
        detail: `维里展开到 B₂ 的绝热声速 ${theory.toPrecision(3)}（仅低密度有效），理想气体 √(γT) = ${ideal.toPrecision(3)}，都取实测温度 ${T.toFixed(2)}；实测与前者之比 ${(c / theory).toFixed(2)}。拟合优度 ${fit.quality.toFixed(2)}。`,
        agree: Math.abs(c / theory - 1) < 0.1,
      }
    },
  },
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
      // 秩取 4：守恒的平均值加上衰减最慢的几个形状。
      // Rank 4: the conserved mean and the slowest decaying shapes.
      // 用标准 DMD。前向–后向的变体在这份真实数据上没有更准（见 README）。
      // Standard DMD. The forward–backward variant was no more accurate on these real data (see the README).
      const { rates } = dmd(data, dt, 4)
      const measured = [-rates[1]!.re, -rates[2]!.re]
      const D = weakSindy(data, dt, dy, undefined, SPARSITY).coefficients[0]!
      const k1 = (2 * Math.PI) / (h.x.length * dy)
      const predicted = [D * k1 * k1, 4 * D * k1 * k1]
      return {
        headline: `两个最慢模态的衰减率：${measured[0]!.toPrecision(3)} 和 ${measured[1]!.toPrecision(3)}`,
        detail:
          D > 0
            ? `扩散方程预言 D·(2πn/L)² = ${predicted[0]!.toPrecision(3)} 和 ${predicted[1]!.toPrecision(3)}（D 取自上面的拟合），比值 ${(measured[0]! / predicted[0]!).toFixed(2)} 和 ${(measured[1]! / predicted[1]!).toFixed(2)}。两种方法互不相干：一个拟合方程，一个只找线性模态。DMD 的读数随记录长度变化很大：初始的台阶含有许多高阶模，记录短时它们混进前几个模态，比值可以偏离数倍；高阶模衰减掉之后才接近 1。只能算量级上的印证。`
            : '上面的拟合没有给出正的扩散系数，无法比较。',
        curve: { x: [1, 2], y: measured },
        theory: D > 0 ? { x: [1, 2], y: predicted } : undefined,
        xLabel: '模态序号 n',
        theoryLabel: '扩散方程：衰减率正比于 n²',
      }
    },
  },
]
