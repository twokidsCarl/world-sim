// 针对一维周期空间中偏微分方程的弱形式稀疏回归（SINDy：Brunton,
// Proctor & Kutz 2016；弱形式：Messenger & Bortz 2021）。
//
// 把 ∂c/∂t 的各候选右端项与光滑、紧支的检验函数做内积来检验。
// 分部积分把所有导数都转移到检验函数上，因此从不对含噪数据求导。
//
// Weak-form sparse regression for a PDE in one periodic space dimension (SINDy: Brunton,
// Proctor & Kutz 2016; weak form: Messenger & Bortz 2021).
//
// Candidate right-hand sides for ∂c/∂t are tested against smooth, compactly supported
// test functions. Integrating by parts moves every derivative onto the test function, so
// the noisy data are never differentiated.

import { leastSquares } from './linalg'

export interface Term {
  label: string
  /** 该项所求导的场，作为 c 的函数。 / The field the term differentiates, as a function of c. */
  field: (c: number) => number
  /** 作用在该场上的空间导数的阶数。 / Order of the space derivative applied to that field. */
  order: 0 | 1 | 2
}

export const DIFFUSION_LIBRARY: Term[] = [
  { label: '∂²c/∂y²', field: (c) => c, order: 2 },
  { label: '∂c/∂y', field: (c) => c, order: 1 },
  { label: 'c', field: (c) => c, order: 0 },
  { label: '∂²(c²)/∂y²', field: (c) => c * c, order: 2 },
  { label: 'c²', field: (c) => c * c, order: 0 },
]

export interface SindyResult {
  /**
   * 库中每一项对应一个系数；被回归舍弃的项系数严格为 0。
   * One coefficient per library term; exactly 0 for terms the regression discarded.
   */
  coefficients: number[]
  /**
   * 保留下来的各项所解释的弱形式时间导数的方差占比。
   * Fraction of the variance of the weak time derivative explained by the kept terms.
   */
  r2: number
}

/**
 * [-1, 1] 上的 (1 - s²)^p 及其对 s 的一阶、二阶导数。
 * (1 - s²)^p on [-1, 1] and its first two derivatives with respect to s.
 */
function bump(s: number, p: number): [number, number, number] {
  const q = 1 - s * s
  if (q <= 0) return [0, 0, 0]
  return [q ** p, -2 * p * s * q ** (p - 1), -2 * p * q ** (p - 1) + 4 * p * (p - 1) * s * s * q ** (p - 2)]
}

/**
 * `data[t][j]` 是周期网格上 t * dt 时刻、位置 j * dy 处的 c。`threshold` 是
 * 一项要被保留所需的最小贡献（相对于最大贡献）。
 * `data[t][j]` is c at time t * dt and position j * dy on a periodic grid. `threshold` is
 * the smallest contribution, relative to the largest, that a term must make to be kept.
 */
export function weakSindy(
  data: ArrayLike<number>[],
  dt: number,
  dy: number,
  library: Term[] = DIFFUSION_LIBRARY,
  threshold = 0.1,
): SindyResult {
  const nt = data.length
  const ny = data[0]!.length
  // 检验函数支集的半宽，以格点数计。 / Half-widths of the test-function support, in grid points.
  const ht = Math.max(2, Math.floor(nt / 6))
  // 空间方向取宽一些：必须分辨的是检验函数的二阶导数。
  // Wide in space: the second derivative of the test function is what must be resolved.
  const hy = Math.max(3, Math.floor(ny / 4))
  const p = 4
  const rows: number[][] = []
  const b: number[] = []
  for (let t0 = ht; t0 < nt - ht; t0 += Math.max(1, Math.floor(ht / 2))) {
    for (let y0 = 0; y0 < ny; y0 += Math.max(1, Math.floor(hy / 2))) {
      let lhs = 0
      const row = new Array<number>(library.length).fill(0)
      for (let a = -ht; a <= ht; a++) {
        const [ft, dft] = bump(a / ht, p)
        const slice = data[t0 + a]!
        for (let k = -hy; k <= hy; k++) {
          const [fy, dfy, d2fy] = bump(k / hy, p)
          const c = slice[(((y0 + k) % ny) + ny) % ny]!
          // ∫∫ φ ∂c/∂t = -∫∫ ∂φ/∂t c / ∫∫ φ ∂c/∂t = -∫∫ ∂φ/∂t c
          lhs -= (dft / (ht * dt)) * fy * c
          for (let i = 0; i < library.length; i++) {
            const term = library[i]!
            const f = term.field(c)
            // 分部积分 n 次得到 (-1)^n ∫∫ (∂ⁿφ/∂yⁿ) f。
            // n integrations by parts give (-1)^n ∫∫ (∂ⁿφ/∂yⁿ) f.
            row[i]! +=
              term.order === 2 ? (ft * d2fy * f) / (hy * dy) ** 2 : term.order === 1 ? (-ft * dfy * f) / (hy * dy) : ft * fy * f
          }
        }
      }
      rows.push(row)
      b.push(lhs)
    }
  }

  // 序贯阈值最小二乘，按每一项贡献的大小来取舍。
  // Sequentially thresholded least squares, judging each term by the size of what it contributes.
  const norms = library.map((_, i) => Math.sqrt(rows.reduce((s, r) => s + r[i]! * r[i]!, 0)))
  let active = library.map((_, i) => i).filter((i) => norms[i]! > 0)
  let coefficients = new Array<number>(library.length).fill(0)
  for (let iter = 0; iter < library.length; iter++) {
    const w = leastSquares(
      rows.map((r) => active.map((i) => r[i]!)),
      b,
    )
    coefficients = new Array<number>(library.length).fill(0)
    active.forEach((i, k) => (coefficients[i] = w[k]!))
    const size = active.map((i) => Math.abs(coefficients[i]!) * norms[i]!)
    const kept = active.filter((_, k) => size[k]! >= threshold * Math.max(...size))
    if (kept.length === active.length) break
    active = kept
  }
  let residual = 0
  let total = 0
  const mean = b.reduce((s, v) => s + v, 0) / b.length
  rows.forEach((r, k) => {
    const fit = r.reduce((s, v, i) => s + v * coefficients[i]!, 0)
    residual += (b[k]! - fit) ** 2
    total += (b[k]! - mean) ** 2
  })
  return { coefficients, r2: 1 - residual / total }
}

/**
 * 以文本形式给出拟合得到的方程，例如 "∂c/∂t = 0.0312 ∂²c/∂y²"。
 * The fitted equation as text, e.g. "∂c/∂t = 0.0312 ∂²c/∂y²".
 */
export function equationText(result: SindyResult, library: Term[] = DIFFUSION_LIBRARY): string {
  const parts = library
    .map((term, i) => ({ term, w: result.coefficients[i]! }))
    .filter(({ w }) => w !== 0)
    .map(({ term, w }, k) => `${k === 0 ? (w < 0 ? '−' : '') : w < 0 ? ' − ' : ' + '}${Math.abs(w).toPrecision(3)} ${term.label}`)
  return `∂c/∂t = ${parts.length ? parts.join('') : '0'}`
}
