// 动态模态分解（Schmid 2010）：拟合把每个快照映到下一个快照的最佳线性映射，
// 并限制在前几个主奇异方向上，再把它的本征值读作增长率或衰减率。
// Dynamic mode decomposition (Schmid 2010): fit the best linear map taking each snapshot
// to the next, restricted to the leading singular directions, and read its eigenvalues
// as growth or decay rates.

import { eigenvalues, multiply, symmetricEigen, transpose, type Complex, type Matrix } from './linalg'

export interface DmdResult {
  /**
   * 连续时间本征值 ln(μ) / dt：实部是增长率，虚部是角频率。
   * Continuous-time eigenvalues ln(μ) / dt: real part is the growth rate, imaginary the angular frequency.
   */
  rates: Complex[]
  /** 快照矩阵的奇异值，按降序排列。 / Singular values of the snapshot matrix, descending. */
  singular: number[]
}

/**
 * `snapshots[t]` 是 t * dt 时刻的状态。`rank` 是保留的奇异方向数。
 * 返回的速率按衰减由慢到快排序。
 * `snapshots[t]` is the state at time t * dt. `rank` is the number of singular directions
 * kept. Rates are returned sorted from slowest decay to fastest.
 */
export function dmd(snapshots: ArrayLike<number>[], dt: number, rank: number): DmdResult {
  const steps = snapshots.length - 1
  const m = snapshots[0]!.length
  // 每一列是一个快照：X 取 0..T-1，Y 取 1..T。
  // Columns are snapshots: X holds 0..T-1, Y holds 1..T.
  const x: Matrix = Array.from({ length: m }, (_, i) => Array.from({ length: steps }, (_, t) => snapshots[t]![i]!))
  const y: Matrix = Array.from({ length: m }, (_, i) => Array.from({ length: steps }, (_, t) => snapshots[t + 1]![i]!))
  // 由 m × m 的 Gram 矩阵求左奇异向量，这里它是较小的那个矩阵。
  // Left singular vectors from the m × m Gram matrix, which is the small one here.
  const { values, vectors } = symmetricEigen(multiply(x, transpose(x)))
  const singular = values.map((v) => Math.sqrt(Math.max(v, 0)))
  const r = Math.min(rank, singular.filter((s) => s > 1e-10 * singular[0]!).length)
  const u: Matrix = vectors.map((row) => row.slice(0, r))
  // Ã = Uᵀ Y V Σ⁻¹ = Uᵀ Y Xᵀ U Σ⁻²，因为 V Σ⁻¹ = Xᵀ U Σ⁻²。
  // Ã = Uᵀ Y V Σ⁻¹ = Uᵀ Y Xᵀ U Σ⁻², since V Σ⁻¹ = Xᵀ U Σ⁻².
  const ut = transpose(u)
  const reduced = multiply(multiply(ut, multiply(y, transpose(x))), u).map((row) =>
    row.map((v, j) => v / (singular[j]! * singular[j]!)),
  )
  const rates = eigenvalues(reduced)
    .map((mu) => ({ re: Math.log(Math.hypot(mu.re, mu.im)) / dt, im: Math.atan2(mu.im, mu.re) / dt }))
    .sort((a, b) => b.re - a.re)
  return { rates, singular }
}
