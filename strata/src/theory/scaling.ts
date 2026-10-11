// 用标度关系从基本常数推出 Lennard-Jones 物质的各个尺度。
//
// 原子尺寸随 Bohr 半径 a0 = ħ / (m_e c α) 变化，结合能随 Rydberg 能量
// Ry = α² m_e c² / 2 变化。对势参数取为它们的固定倍数（以氩标定），
// 原子质量取为质子质量的固定倍数。这是 Weisskopf (1975) 和
// Press & Lightman (1983) 式的量纲分析，而不是量子力学计算：
// 前置系数是拟合出来的，只有标度关系是推导出来的。
//
// From fundamental constants to the scales of a Lennard-Jones substance, by scaling.
//
// Atomic sizes follow the Bohr radius a0 = ħ / (m_e c α) and binding energies the Rydberg
// Ry = α² m_e c² / 2. The pair-potential parameters are taken as fixed multiples of these,
// calibrated on argon, and the atomic mass as a fixed multiple of the proton mass. This is
// dimensional analysis in the manner of Weisskopf (1975) and Press & Lightman (1983), not a
// quantum calculation: the prefactors are fitted, only the scaling is derived.

export const CODATA = {
  alpha: 7.2973525693e-3,
  electronMass: 9.1093837015e-31,
  protonMass: 1.67262192369e-27,
  hbar: 1.054571817e-34,
  h: 6.62607015e-34,
  c: 299792458,
  kB: 1.380649e-23,
  amu: 1.6605390666e-27,
}

const ARGON = { sigma: 3.405e-10, epsilonOverKB: 119.8, mass: 39.948 * CODATA.amu }

const bohr = (alpha: number) => CODATA.hbar / (CODATA.electronMass * CODATA.c * alpha)
const rydberg = (alpha: number) => (alpha * alpha * CODATA.electronMass * CODATA.c * CODATA.c) / 2

const SIGMA_IN_BOHR = ARGON.sigma / bohr(CODATA.alpha)
const EPSILON_IN_RYDBERG = (ARGON.epsilonOverKB * CODATA.kB) / rydberg(CODATA.alpha)
const MASS_IN_PROTONS = ARGON.mass / CODATA.protonMass

export interface UnitSystem {
  /** 长度单位 σ，米。 / Length unit σ, metres. */
  sigma: number
  /** 能量单位 ε，焦耳。 / Energy unit ε, joules. */
  epsilon: number
  /** 粒子质量，千克。 / Particle mass, kilograms. */
  mass: number
  /** 时间单位 σ √(m / ε)，秒。 / Time unit σ √(m / ε), seconds. */
  tau: number
  /** 温度单位 ε / kB，开尔文。 / Temperature unit ε / kB, kelvin. */
  kelvin: number
  /** 速度单位 σ / τ，米每秒。 / Speed unit σ / τ, metres per second. */
  speed: number
  /**
   * de Boer 参数 h / (σ √(m ε))：与温度无关的、衡量该物质量子性强弱的量。
   * de Boer parameter h / (σ √(m ε)): the thermal-free measure of how quantum the substance is.
   */
  deBoer: number
}

/**
 * 当精细结构常数为真实值的 alphaRatio 倍、电子与质子质量比为真实值的
 * massRatio 倍（电子质量保持不变）时，所模拟物质的各单位。
 * Units of the simulated substance when the fine-structure constant is alphaRatio times
 * its real value and the electron-to-proton mass ratio is massRatio times its real value
 * (electron mass held fixed).
 */
export function unitSystem(alphaRatio = 1, massRatio = 1): UnitSystem {
  const alpha = CODATA.alpha * alphaRatio
  const sigma = SIGMA_IN_BOHR * bohr(alpha)
  const epsilon = EPSILON_IN_RYDBERG * rydberg(alpha)
  const mass = (MASS_IN_PROTONS * CODATA.protonMass) / massRatio
  const tau = sigma * Math.sqrt(mass / epsilon)
  return {
    sigma,
    epsilon,
    mass,
    tau,
    kelvin: epsilon / CODATA.kB,
    speed: sigma / tau,
    deBoer: CODATA.h / (sigma * Math.sqrt(mass * epsilon)),
  }
}

/**
 * de Boer 参数大致超过此值（氖为 0.59）时，经典动力学就不再是好的描述。
 * Above roughly this de Boer parameter (neon is 0.59) classical dynamics is a poor description.
 */
export const DE_BOER_QUANTUM = 0.5
