// 正方晶格上 q 态 Potts 模型的严格结果，H = −Σ δ(sᵢ, sⱼ)（对最近邻键求和，J = 1）。
// 临界温度来自自对偶性；q > 4 时相变是一级的，潜热由 Baxter (1973) 给出。
// 见 F. Y. Wu, Rev. Mod. Phys. 54, 235 (1982) 的综述。
// Exact results for the q-state Potts model on the square lattice, H = −Σ δ(sᵢ, sⱼ) over
// nearest-neighbour bonds with J = 1. The transition temperature follows from
// self-duality; for q > 4 the transition is first order, with the latent heat given by
// Baxter (1973). See the review by F. Y. Wu, Rev. Mod. Phys. 54, 235 (1982).

/** 相变温度 Tc = 1 / ln(1 + √q)。 / Transition temperature Tc = 1 / ln(1 + √q). */
export function pottsTc(q: number): number {
  return 1 / Math.log(1 + Math.sqrt(q))
}

/**
 * 相变点上每个格点的能量：q ≤ 4 时就是能量本身，q > 4 时是有序相与无序相能量的平均。
 * Energy per site at the transition: the energy itself for q ≤ 4, and the mean of the
 * ordered and disordered energies for q > 4.
 */
export function pottsCriticalEnergy(q: number): number {
  return -(1 + 1 / Math.sqrt(q))
}

/**
 * 每个格点的潜热（q ≤ 4 时为 0）：L = 2 (1 + 1/√q) tanh(Θ/2) Π tanh²(nΘ)，其中 2 cosh Θ = √q。
 * Latent heat per site (0 for q ≤ 4): L = 2 (1 + 1/√q) tanh(Θ/2) Π tanh²(nΘ), with 2 cosh Θ = √q.
 */
export function pottsLatentHeat(q: number): number {
  if (q <= 4) return 0
  const theta = Math.acosh(Math.sqrt(q) / 2)
  let product = 1
  for (let n = 1; n < 200; n++) {
    const t = Math.tanh(n * theta)
    product *= t * t
    if (1 - t < 1e-17) break
  }
  return 2 * (1 + 1 / Math.sqrt(q)) * Math.tanh(theta / 2) * product
}

/**
 * 相变点上两个共存相各自的能量（q ≤ 4 时两者相等）。
 * Energies of the two coexisting phases at the transition (equal for q ≤ 4).
 */
export function pottsCoexistence(q: number): { ordered: number; disordered: number } {
  const mean = pottsCriticalEnergy(q)
  const half = pottsLatentHeat(q) / 2
  return { ordered: mean - half, disordered: mean + half }
}
