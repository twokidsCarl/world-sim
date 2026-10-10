// Weak-form sparse regression for a PDE in one periodic space dimension (SINDy: Brunton,
// Proctor & Kutz 2016; weak form: Messenger & Bortz 2021).
//
// Candidate right-hand sides for ∂c/∂t are tested against smooth, compactly supported
// test functions. Integrating by parts moves every derivative onto the test function, so
// the noisy data are never differentiated.

import { leastSquares } from './linalg'

export interface Term {
  label: string
  /** The field the term differentiates, as a function of c. */
  field: (c: number) => number
  /** Order of the space derivative applied to that field. */
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
  /** One coefficient per library term; exactly 0 for terms the regression discarded. */
  coefficients: number[]
  /** Fraction of the variance of the weak time derivative explained by the kept terms. */
  r2: number
}

/** (1 - s²)^p on [-1, 1] and its first two derivatives with respect to s. */
function bump(s: number, p: number): [number, number, number] {
  const q = 1 - s * s
  if (q <= 0) return [0, 0, 0]
  return [q ** p, -2 * p * s * q ** (p - 1), -2 * p * q ** (p - 1) + 4 * p * (p - 1) * s * s * q ** (p - 2)]
}

/**
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
  // Half-widths of the test-function support, in grid points.
  const ht = Math.max(2, Math.floor(nt / 6))
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
          // ∫∫ φ ∂c/∂t = -∫∫ ∂φ/∂t c
          lhs -= (dft / (ht * dt)) * fy * c
          for (let i = 0; i < library.length; i++) {
            const term = library[i]!
            const f = term.field(c)
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

/** The fitted equation as text, e.g. "∂c/∂t = 0.0312 ∂²c/∂y²". */
export function equationText(result: SindyResult, library: Term[] = DIFFUSION_LIBRARY): string {
  const parts = library
    .map((term, i) => ({ term, w: result.coefficients[i]! }))
    .filter(({ w }) => w !== 0)
    .map(({ term, w }, k) => `${k === 0 ? (w < 0 ? '−' : '') : w < 0 ? ' − ' : ' + '}${Math.abs(w).toPrecision(3)} ${term.label}`)
  return `∂c/∂t = ${parts.length ? parts.join('') : '0'}`
}
