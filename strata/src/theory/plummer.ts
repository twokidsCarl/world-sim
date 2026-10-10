// The Plummer model with total mass M = 1, scale radius a = 1 and G = 1.

/** Mass density at radius r. */
export function plummerDensity(r: number): number {
  return (3 / (4 * Math.PI)) * Math.pow(1 + r * r, -2.5)
}

/** Mass inside radius r. */
export function plummerMass(r: number): number {
  return (r * r * r) / Math.pow(1 + r * r, 1.5)
}

/** Half-mass radius: (2^(2/3) - 1)^(-1/2). */
export const PLUMMER_HALF_MASS = 1 / Math.sqrt(Math.pow(2, 2 / 3) - 1)

/** Free-fall time of a cold uniform sphere of mass 1 and radius 1: π / (2 √2). */
export const FREE_FALL_TIME = Math.PI / (2 * Math.SQRT2)
