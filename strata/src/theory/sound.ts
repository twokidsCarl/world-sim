import { secondVirial } from './virial'
import type { PotentialSpec } from '../substrates/md/potential'

/**
 * 由截断到 B2 的位力状态方程 P = ρT (1 + B2(T) ρ) 以及与之相容的
 * 量热状态方程得到的绝热声速。一般地
 *
 *   c² = (∂P/∂ρ)_T + T (∂P/∂T)_ρ² / (ρ² c_v)，
 *
 * 其中 c_v 是每个粒子的定容热容。到这一阶
 * c_v = d/2 - ρ (2 T B2' + T² B2'')。零密度极限下即理想气体的结果
 * c = √(γ T)，其中 γ = (d + 2) / d。仅在低密度下成立。
 *
 * Adiabatic sound speed from the virial equation of state truncated at B2,
 * P = ρT (1 + B2(T) ρ), with the matching caloric equation. In general
 *
 *   c² = (∂P/∂ρ)_T + T (∂P/∂T)_ρ² / (ρ² c_v),
 *
 * where c_v is the heat capacity per particle at constant volume. To this order
 * c_v = d/2 - ρ (2 T B2' + T² B2''). At zero density this is the ideal-gas value
 * c = √(γ T) with γ = (d + 2) / d. Valid at low density only.
 */
export function virialSoundSpeed(spec: PotentialSpec, density: number, T: number, dim: 2 | 3): number {
  const h = 1e-3 * T
  const b = secondVirial(spec, T, dim)
  const bPlus = secondVirial(spec, T + h, dim)
  const bMinus = secondVirial(spec, T - h, dim)
  const b1 = (bPlus - bMinus) / (2 * h)
  const b2 = (bPlus - 2 * b + bMinus) / (h * h)
  const dPdRho = T * (1 + 2 * b * density)
  const dPdT = density * (1 + b * density) + density * density * T * b1
  const cv = dim / 2 - density * (2 * T * b1 + T * T * b2)
  return Math.sqrt(dPdRho + (T * dPdT * dPdT) / (density * density * cv))
}
