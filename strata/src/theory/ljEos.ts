// 二维 Lennard-Jones 流体的状态方程，取自公开发表的拟合。
// Equation of state of the two-dimensional Lennard-Jones fluid, from a published fit.
//
// 出处 / Source: Homes, Mausbach, Thol, Nitzke & Vrabec, "Thermodynamic properties of
// low-dimensional (D<3) Lennard-Jones fluids", J. Mol. Liq. 429, 127529 (2025), Table 1
// and Eq. 30; open data at https://doi.org/10.14279/depositonce-22253.
//
// 它拟合的是完整的 12-6 势（模拟用 6.5σ 截断加长程修正），适用于 T = 0.4–4、ρ ≤ 0.8 的
// 流体。对照原始模拟数据，ρ ≤ 0.7 时压强准到约 0.5%，ρ = 0.8 时偏低 2–3%。
// It is fitted to the full 12-6 potential (simulated with a 6.5 σ cutoff plus long-range
// corrections) and covers the fluid at T = 0.4–4, ρ ≤ 0.8. Against the raw simulation
// data it gives the pressure to about 0.5% for ρ ≤ 0.7 and runs 2–3% low at ρ = 0.8.

import { rawPotential, type PotentialSpec } from '../substrates/md/potential'

/** 拟合所用的临界参数 / Critical parameters used by the fit. */
export const LJ2D_TC = 0.515
export const LJ2D_RHOC = 0.336

// 多项式项 n τ^t δ^d / Polynomial terms n τ^t δ^d: [n, t, d]
const POLY = [
  [0.03417967, 1, 4],
  [0.74397584, 0.125, 1],
  [-1.18987813, 1.03, 1],
  [-0.22086019, 1.125, 2],
  [0.1841414, 0.433, 3],
]

// 指数项 n τ^t δ^d exp(−δ^p) / Exponential terms n τ^t δ^d exp(−δ^p): [n, t, d, p]
const EXP = [
  [-0.850609, 3.55, 1, 2],
  [-0.44585525, 0.76, 3, 2],
  [1.19, 1.65, 2, 1],
  [-0.55470532, 4.36, 2, 2],
  [-1.1897886, 0.95, 4, 1],
  [-0.00740594, 1.67, 7, 1],
  [-0.02370576, 1.9, 3, 3],
  [-0.06393058, 4.74, 7, 3],
]

// 高斯项 n τ^t δ^d exp[−η(δ−ε)² − β(τ−γ)²] / Gaussian terms: [n, t, d, η, β, γ, ε]
const GAUSS = [
  [-0.14729086, 0.46, 1, 3.98, 3.29, 0.6092, 0.538],
  [0.29569597, 0.7, 1, 3.14, 0.66, 1.5657, 1.577],
  [-0.13664437, 1.17, 3, 3.73, 0.42, 2.03, 1.4472],
  [-0.17202278, 0.4, 2, 2.08, 3.23, 0.849, 0.8184],
  [-0.63080399, 0.28, 1, 2.82, 0.85, 1.25, 0.003],
]

/**
 * 约化剩余亥姆霍兹能 αʳ(τ, δ)，τ = Tc/T，δ = ρ/ρc。
 * Reduced residual Helmholtz energy αʳ(τ, δ), with τ = Tc/T and δ = ρ/ρc.
 */
function residualHelmholtz(tau: number, delta: number): number {
  let a = 0
  for (const [n, t, d] of POLY) a += n! * Math.pow(tau, t!) * Math.pow(delta, d!)
  for (const [n, t, d, p] of EXP) a += n! * Math.pow(tau, t!) * Math.pow(delta, d!) * Math.exp(-Math.pow(delta, p!))
  for (const [n, t, d, eta, beta, gamma, eps] of GAUSS) {
    a += n! * Math.pow(tau, t!) * Math.pow(delta, d!) * Math.exp(-eta! * (delta - eps!) ** 2 - beta! * (tau - gamma!) ** 2)
  }
  return a
}

/**
 * 完整 LJ 势下的压强 P = ρT (1 + δ ∂αʳ/∂δ) 与每粒子势能 u = T τ ∂αʳ/∂τ。
 * Pressure P = ρT (1 + δ ∂αʳ/∂δ) and potential energy per particle u = T τ ∂αʳ/∂τ
 * for the full Lennard-Jones potential.
 */
export function ljFluid2d(density: number, T: number): { pressure: number; energy: number } {
  const tau = LJ2D_TC / T
  const delta = density / LJ2D_RHOC
  const h = 1e-5
  const dDelta = (residualHelmholtz(tau, delta * (1 + h)) - residualHelmholtz(tau, delta * (1 - h))) / (2 * h * delta)
  const dTau = (residualHelmholtz(tau * (1 + h), delta) - residualHelmholtz(tau * (1 - h), delta)) / (2 * h * tau)
  return { pressure: density * T * (1 + delta * dDelta), energy: T * tau * dTau }
}

/**
 * 状态方程是否适用：单相流体，且在拟合范围之内。临界温度以下有气液两相区，这里不处理，
 * 直接要求温度明显高于 Tc。
 * Whether the equation of state applies: single-phase fluid inside the fitted range.
 * Below the critical temperature there is a two-phase region, which is not handled here;
 * the temperature is simply required to be clearly above Tc.
 */
export function ljFluid2dApplies(density: number, T: number): boolean {
  return T >= 0.6 && T <= 4 && density > 0 && density <= 0.8
}

/**
 * 被模拟的力平移截断势与完整势之间的压强差，平均场估计（截断半径以外取 g = 1，
 * 力平移项对 r < rc 也取 g = 1）：
 *   去掉 rc 以外的吸引尾巴：−πρ² [12 / (5 rc¹⁰) − 3 / rc⁴]
 *   力平移给每一对加上常数力 −f(rc)：(π/6) ρ² rc³ (−f(rc))
 * 只对 12-6 势写出了尾巴项；rc 越大越准，rc = 4 时两项合计约为压强的 1%。
 *
 * Pressure of the simulated force-shifted, truncated potential minus that of the full
 * potential, in mean-field approximation (g = 1 beyond the cutoff, and g = 1 for the
 * force-shift term as well):
 *   removing the attractive tail beyond rc: −πρ² [12 / (5 rc¹⁰) − 3 / rc⁴]
 *   the shift adds a constant force −f(rc) to every pair: (π/6) ρ² rc³ (−f(rc))
 * The tail term is written for the 12-6 potential only. It improves with rc; at rc = 4
 * the two terms together are about 1% of the pressure.
 */
export function cutoffPressureCorrection2d(spec: PotentialSpec, density: number): number {
  const rc = spec.rc
  const tail = Math.PI * density * density * (12 / (5 * Math.pow(rc, 10)) - 3 / Math.pow(rc, 4))
  const forceAtCutoff = -rawPotential(spec, rc).du
  const shift = (Math.PI / 6) * density * density * rc ** 3 * -forceAtCutoff
  return -tail + shift
}
