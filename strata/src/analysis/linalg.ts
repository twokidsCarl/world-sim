// Small dense linear algebra for the analyses. Matrices are arrays of rows.

export type Matrix = number[][]

export const transpose = (a: Matrix): Matrix => a[0]!.map((_, j) => a.map((row) => row[j]!))

export function multiply(a: Matrix, b: Matrix): Matrix {
  const out = a.map(() => new Array<number>(b[0]!.length).fill(0))
  for (let i = 0; i < a.length; i++) {
    for (let k = 0; k < b.length; k++) {
      const aik = a[i]![k]!
      if (aik === 0) continue
      for (let j = 0; j < b[0]!.length; j++) out[i]![j]! += aik * b[k]![j]!
    }
  }
  return out
}

/**
 * Eigen-decomposition of a real symmetric matrix by cyclic Jacobi rotations. Returns
 * eigenvalues in descending order and the matching eigenvectors as columns of `vectors`.
 */
export function symmetricEigen(input: Matrix): { values: number[]; vectors: Matrix } {
  const n = input.length
  const a = input.map((row) => row.slice())
  const v: Matrix = a.map((_, i) => a.map((_, j) => (i === j ? 1 : 0)))
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p]![q]! ** 2
    if (off < 1e-30) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p]![q]!) < 1e-300) continue
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!
          const akq = a[k]![q]!
          a[k]![p] = c * akp - s * akq
          a[k]![q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!
          const aqk = a[q]![k]!
          a[p]![k] = c * apk - s * aqk
          a[q]![k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!
          const vkq = v[k]![q]!
          v[k]![p] = c * vkp - s * vkq
          v[k]![q] = s * vkp + c * vkq
        }
      }
    }
  }
  const order = a.map((_, i) => i).sort((i, j) => a[j]![j]! - a[i]![i]!)
  return { values: order.map((i) => a[i]![i]!), vectors: v.map((row) => order.map((i) => row[i]!)) }
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
export function solve(a: Matrix, b: number[]): number[] {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]!])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r
    ;[m[col], m[pivot]] = [m[pivot]!, m[col]!]
    const d = m[col]![col]!
    if (Math.abs(d) < 1e-300) throw new Error('singular matrix')
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / d
      for (let k = col; k <= n; k++) m[r]![k]! -= f * m[col]![k]!
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r]![n]!
    for (let k = r + 1; k < n; k++) s -= m[r]![k]! * x[k]!
    x[r] = s / m[r]![r]!
  }
  return x
}

/** Least squares by the normal equations; adequate for the few well-scaled columns used here. */
export function leastSquares(a: Matrix, b: number[]): number[] {
  const at = transpose(a)
  return solve(
    multiply(at, a),
    at.map((row) => row.reduce((s, v, i) => s + v * b[i]!, 0)),
  )
}

export interface Complex {
  re: number
  im: number
}

/**
 * Eigenvalues of a small real square matrix: characteristic polynomial by the
 * Faddeev–LeVerrier recurrence, roots by Durand–Kerner. Intended for n up to about 8.
 */
export function eigenvalues(a: Matrix): Complex[] {
  const n = a.length
  // c[k] is the coefficient of λ^(n-k); c[0] = 1.
  const c = [1]
  let m: Matrix = a.map((row) => row.map(() => 0))
  for (let k = 1; k <= n; k++) {
    const next = multiply(a, m)
    for (let i = 0; i < n; i++) next[i]![i]! += c[k - 1]!
    m = next
    const am = multiply(a, m)
    let trace = 0
    for (let i = 0; i < n; i++) trace += am[i]![i]!
    c.push(-trace / k)
  }
  const evaluate = (z: Complex): Complex => {
    let re = 1
    let im = 0
    for (let k = 1; k <= n; k++) {
      const r = re * z.re - im * z.im + c[k]!
      im = re * z.im + im * z.re
      re = r
    }
    return { re, im }
  }
  const scale = 1 + Math.max(...c.slice(1).map(Math.abs))
  const roots: Complex[] = Array.from({ length: n }, (_, i) => ({
    re: scale * Math.cos((2 * Math.PI * i) / n + 0.4),
    im: scale * Math.sin((2 * Math.PI * i) / n + 0.4),
  }))
  for (let iter = 0; iter < 500; iter++) {
    let moved = 0
    for (let i = 0; i < n; i++) {
      let dre = 1
      let dim = 0
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const xr = roots[i]!.re - roots[j]!.re
        const xi = roots[i]!.im - roots[j]!.im
        const r = dre * xr - dim * xi
        dim = dre * xi + dim * xr
        dre = r
      }
      const f = evaluate(roots[i]!)
      const den = dre * dre + dim * dim
      const sr = (f.re * dre + f.im * dim) / den
      const si = (f.im * dre - f.re * dim) / den
      roots[i] = { re: roots[i]!.re - sr, im: roots[i]!.im - si }
      moved = Math.max(moved, Math.hypot(sr, si))
    }
    if (moved < 1e-14 * scale) break
  }
  return roots
}
