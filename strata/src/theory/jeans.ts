// 静态均匀背景上冷物质的引力不稳定性（Jeans 1902；Zel'dovich 1970）。
// 单位：盒子边长 1，总质量 1（平均密度 ρ̄ = 1），G = 1。
// Gravitational instability of cold matter on a static uniform background (Jeans 1902;
// Zel'dovich 1970). Units: box side 1, total mass 1 (mean density ρ̄ = 1), G = 1.

/**
 * 线性增长率：密度扰动服从 δ̈ = 4πGρ̄ δ，增长模 δ ∝ exp(γt)，γ = √(4πGρ̄)，与波长无关。
 * Linear growth rate: a density perturbation obeys δ̈ = 4πGρ̄ δ, so the growing mode goes
 * as exp(γt) with γ = √(4πGρ̄), whatever the wavelength.
 */
export const JEANS_RATE = Math.sqrt(4 * Math.PI)

/**
 * 粒子网格法对波数为 k（每个盒子的整周期数）的平面波的力打的折扣：云在格中（CIC）的
 * 分配和插值各乘一个 sinc²，中心差分再乘一个 sin(x)/x。增长率乘它的平方根。
 * The factor by which the particle-mesh method weakens the force on a plane wave of wave
 * number k (whole periods per box): cloud-in-cell deposit and interpolation each multiply
 * by sinc², and the central difference by sin(x)/x. The growth rate gets its square root.
 */
export function meshForceFactor(k: number, M: number): number {
  const half = (Math.PI * k) / M
  const sinc = Math.sin(half) / half
  return sinc ** 4 * (Math.sin(2 * half) / (2 * half))
}

/** 第一类贝塞尔函数 J₁(x)，幂级数，适用于 |x| 不大的情形。 / Bessel function of the first kind J₁(x) by its power series, for moderate |x|. */
export function besselJ1(x: number): number {
  let term = x / 2
  let sum = term
  for (let k = 1; k < 40; k++) {
    term *= -(x * x) / (4 * k * (k + 1))
    sum += term
    if (Math.abs(term) < 1e-17 * Math.abs(sum)) break
  }
  return sum
}

/**
 * 一维平面波在壳层交叉之前的严格解（Zel'dovich）：粒子 x = q + A(t) sin(2πkq) / (2πk)，
 * 纯增长模 A(t) = A₀ exp(γt)。此时基频密度模的幅度是 2 J₁(A)，壳层交叉发生在 A = 1。
 * 返回 { amplitude, crossed }。
 * The exact solution for a 1D plane wave before shell crossing (Zel'dovich): particles sit
 * at x = q + A(t) sin(2πkq) / (2πk) with the pure growing mode A(t) = A₀ exp(γt). The
 * amplitude of the fundamental density mode is then 2 J₁(A), and shells cross at A = 1.
 * Returns { amplitude, crossed }.
 */
export function zeldovichMode(a0: number, rate: number, t: number): { amplitude: number; crossed: boolean } {
  const a = a0 * Math.exp(rate * t)
  return { amplitude: 2 * besselJ1(Math.min(a, 1)), crossed: a >= 1 }
}

/** 壳层交叉（密度第一次发散）的时刻。 / The time of shell crossing, when the density first diverges. */
export function crossingTime(a0: number, rate: number): number {
  return Math.log(1 / a0) / rate
}
