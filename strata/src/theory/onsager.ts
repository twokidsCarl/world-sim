// Exact results for the 2D square-lattice Ising model with nearest-neighbour coupling
// J = 1 and zero field (Onsager 1944; Yang 1952).

export const ISING_TC = 2 / Math.log(1 + Math.SQRT2)

/** Spontaneous magnetisation per spin; zero at and above Tc. */
export function onsagerMagnetisation(T: number): number {
  if (T >= ISING_TC) return 0
  return Math.pow(1 - Math.pow(Math.sinh(2 / T), -4), 1 / 8)
}

/** Complete elliptic integral of the first kind K(k), by the arithmetic–geometric mean. */
export function ellipticK(k: number): number {
  let a = 1
  let b = Math.sqrt(1 - k * k)
  for (let i = 0; i < 40 && Math.abs(a - b) > 1e-15 * a; i++) {
    const t = 0.5 * (a + b)
    b = Math.sqrt(a * b)
    a = t
  }
  return Math.PI / (2 * a)
}

/** Internal energy per spin. */
export function onsagerEnergy(T: number): number {
  const b = 1 / T
  const kappa = (2 * Math.sinh(2 * b)) / Math.pow(Math.cosh(2 * b), 2)
  const t2 = Math.pow(Math.tanh(2 * b), 2)
  // At Tc the bracket's second term vanishes while K diverges logarithmically; the product is 0.
  const second = Math.abs(2 * t2 - 1) < 1e-12 ? 0 : (2 / Math.PI) * (2 * t2 - 1) * ellipticK(Math.min(kappa, 1 - 1e-15))
  return (-1 / Math.tanh(2 * b)) * (1 + second)
}
