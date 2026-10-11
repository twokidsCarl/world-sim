import { shiftedPotential, type PotentialSpec } from '../substrates/md/potential'

/**
 * 实际模拟所用的力平移（force-shifted）势的第二位力系数：
 *   B2(T) = -(1/2) ∫ (exp(-u(r)/T) - 1) d^dim r
 * 在 [0, rc] 上用 Simpson 法则求积；截断半径之外被积函数为零。
 * Second virial coefficient of the force-shifted potential actually simulated:
 *   B2(T) = -(1/2) ∫ (exp(-u(r)/T) - 1) d^dim r
 * by Simpson's rule on [0, rc]; the integrand is zero beyond the cutoff.
 */
export function secondVirial(spec: PotentialSpec, T: number, dim: 2 | 3, intervals = 4000): number {
  const shell = dim === 2 ? 2 * Math.PI : 4 * Math.PI
  const f = (r: number) => {
    if (r === 0) return 0
    const u = shiftedPotential(spec, r).u
    const mayer = Number.isFinite(u) ? Math.exp(-u / T) - 1 : -1
    return mayer * shell * Math.pow(r, dim - 1)
  }
  const h = spec.rc / intervals
  let sum = f(0) + f(spec.rc)
  for (let i = 1; i < intervals; i++) sum += (i % 2 === 1 ? 4 : 2) * f(i * h)
  return (-0.5 * sum * h) / 3
}

/**
 * 由截断到 B2 的位力展开得到的压强；仅在低密度下成立。
 * Pressure from the virial expansion truncated at B2; valid at low density.
 */
export function virialPressure(spec: PotentialSpec, density: number, T: number, dim: 2 | 3): number {
  return density * T * (1 + secondVirial(spec, T, dim) * density)
}
