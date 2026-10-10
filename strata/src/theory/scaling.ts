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
  /** Length unit σ, metres. */
  sigma: number
  /** Energy unit ε, joules. */
  epsilon: number
  /** Particle mass, kilograms. */
  mass: number
  /** Time unit σ √(m / ε), seconds. */
  tau: number
  /** Temperature unit ε / kB, kelvin. */
  kelvin: number
  /** Speed unit σ / τ, metres per second. */
  speed: number
  /** de Boer parameter h / (σ √(m ε)): the thermal-free measure of how quantum the substance is. */
  deBoer: number
}

/**
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

/** Above roughly this de Boer parameter (neon is 0.59) classical dynamics is a poor description. */
export const DE_BOER_QUANTUM = 0.5
