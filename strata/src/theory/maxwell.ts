// Maxwell–Boltzmann speed distribution for unit mass in 2 or 3 dimensions.

export function speedPdf(dim: 2 | 3, T: number, v: number): number {
  const e = Math.exp((-v * v) / (2 * T))
  return dim === 2 ? (v / T) * e : Math.sqrt(2 / Math.PI) * ((v * v) / Math.pow(T, 1.5)) * e
}

export function speedCdf(dim: 2 | 3, T: number, v: number): number {
  const e = Math.exp((-v * v) / (2 * T))
  if (dim === 2) return 1 - e
  return erf(v / Math.sqrt(2 * T)) - Math.sqrt(2 / Math.PI) * (v / Math.sqrt(T)) * e
}

/** Abramowitz & Stegun 7.1.26; absolute error below 1.5e-7. */
export function erf(x: number): number {
  const s = Math.sign(x)
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  return s * (1 - poly * Math.exp(-a * a))
}
