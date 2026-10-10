// CPU reference for softened Newtonian gravity in 3D: direct O(N²) summation and a
// kick-drift-kick leapfrog. Units: G = 1; the total mass of the standard initial
// conditions is 1.

import { uniform } from '../../core/rng'

export interface GravityState {
  n: number
  /** n * 3 */
  pos: Float64Array
  vel: Float64Array
  acc: Float64Array
  mass: Float64Array
  /** Potential per unit mass at each body. */
  phi: Float64Array
  step: number
}

export function createGravity(n: number): GravityState {
  return {
    n,
    pos: new Float64Array(3 * n),
    vel: new Float64Array(3 * n),
    acc: new Float64Array(3 * n),
    mass: new Float64Array(n),
    phi: new Float64Array(n),
    step: 0,
  }
}

/** Plummer softening: 1/r is replaced by 1/sqrt(r² + eps²). */
export function accelerations(s: GravityState, eps: number): void {
  const { n, pos, acc, mass, phi } = s
  const eps2 = eps * eps
  acc.fill(0)
  phi.fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = pos[3 * j] - pos[3 * i]
      const dy = pos[3 * j + 1] - pos[3 * i + 1]
      const dz = pos[3 * j + 2] - pos[3 * i + 2]
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2)
      const inv3 = inv * inv * inv
      acc[3 * i] += mass[j] * dx * inv3
      acc[3 * i + 1] += mass[j] * dy * inv3
      acc[3 * i + 2] += mass[j] * dz * inv3
      acc[3 * j] -= mass[i] * dx * inv3
      acc[3 * j + 1] -= mass[i] * dy * inv3
      acc[3 * j + 2] -= mass[i] * dz * inv3
      phi[i] -= mass[j] * inv
      phi[j] -= mass[i] * inv
    }
  }
}

/** Kick-drift-kick leapfrog. Accelerations must be current on entry and are on exit. */
export function leapfrog(s: GravityState, eps: number, dt: number, nSteps = 1): void {
  const { pos, vel, acc } = s
  for (let it = 0; it < nSteps; it++) {
    for (let k = 0; k < pos.length; k++) {
      vel[k] += 0.5 * dt * acc[k]
      pos[k] += dt * vel[k]
    }
    accelerations(s, eps)
    for (let k = 0; k < pos.length; k++) vel[k] += 0.5 * dt * acc[k]
    s.step++
  }
}

export interface GravityScalars {
  ke: number
  /** Potential energy; negative. */
  pe: number
  /** |total momentum| */
  momentum: number
  /** 2K / |U| over all bodies. Not expected to be 1: see `virialBound`. */
  virial: number
  /** Fraction of bodies that are bound (v²/2 + φ < 0). */
  boundFraction: number
  /** Position of the body deepest in the potential: the centre of the bound remnant. */
  centre: [number, number, number]
  /**
   * 2K / |W| for the bound bodies, with K measured relative to their mean velocity and
   * W = Σ m (x - centre) · a the virial of the forces. The virial theorem says this is 1
   * for a relaxed bound system, for any force law including the softened one; 2K / |U|
   * equals it only for an unsoftened 1/r potential.
   */
  virialBound: number
  /** Radius of the sphere about `centre` holding half of all bodies. */
  halfMassRadius: number
}

/** Sums over bound bodies from which `virialBound` is formed; the GPU reduces to the same. */
export interface BoundSums {
  count: number
  mass: number
  ke: number
  /** Σ m v */
  mv: [number, number, number]
  /** Σ m a */
  ma: [number, number, number]
  /** Σ m x · a */
  mxa: number
}

export function boundVirial(b: BoundSums, centre: ArrayLike<number>): number {
  if (b.mass === 0) return NaN
  const keRelative = b.ke - (b.mv[0] ** 2 + b.mv[1] ** 2 + b.mv[2] ** 2) / (2 * b.mass)
  const w = b.mxa - (centre[0]! * b.ma[0] + centre[1]! * b.ma[1] + centre[2]! * b.ma[2])
  return (2 * keRelative) / Math.abs(w)
}

export function gravityScalars(s: GravityState): GravityScalars {
  let ke = 0
  let pe = 0
  let deepest = 0
  const p = [0, 0, 0]
  const b: BoundSums = { count: 0, mass: 0, ke: 0, mv: [0, 0, 0], ma: [0, 0, 0], mxa: 0 }
  for (let i = 0; i < s.n; i++) {
    const m = s.mass[i]
    let v2 = 0
    for (let d = 0; d < 3; d++) {
      v2 += s.vel[3 * i + d] ** 2
      p[d] += m * s.vel[3 * i + d]
    }
    ke += 0.5 * m * v2
    pe += 0.5 * m * s.phi[i]
    if (s.phi[i] < s.phi[deepest]) deepest = i
    if (0.5 * v2 + s.phi[i] < 0) {
      b.count++
      b.mass += m
      b.ke += 0.5 * m * v2
      for (let d = 0; d < 3; d++) {
        b.mv[d] += m * s.vel[3 * i + d]
        b.ma[d] += m * s.acc[3 * i + d]
        b.mxa += m * s.pos[3 * i + d] * s.acc[3 * i + d]
      }
    }
  }
  const centre: [number, number, number] = [s.pos[3 * deepest], s.pos[3 * deepest + 1], s.pos[3 * deepest + 2]]
  const radii = Float64Array.from({ length: s.n }, (_, i) =>
    Math.hypot(s.pos[3 * i] - centre[0], s.pos[3 * i + 1] - centre[1], s.pos[3 * i + 2] - centre[2]),
  ).sort()
  return {
    ke,
    pe,
    momentum: Math.hypot(...p),
    virial: (2 * ke) / Math.abs(pe),
    boundFraction: b.count / s.n,
    centre,
    virialBound: boundVirial(b, centre),
    halfMassRadius: radii[Math.floor(s.n / 2)],
  }
}

/** Counts of bodies in `bins` equal-width radial shells out to rmax, about `centre`. */
export function radialCounts(s: GravityState, bins: number, rmax: number, centre: ArrayLike<number> = [0, 0, 0]): Float64Array {
  const out = new Float64Array(bins)
  for (let i = 0; i < s.n; i++) {
    const r = Math.hypot(s.pos[3 * i] - centre[0]!, s.pos[3 * i + 1] - centre[1]!, s.pos[3 * i + 2] - centre[2]!)
    const b = Math.floor((r / rmax) * bins)
    if (b < bins) out[b]++
  }
  return out
}

/** Shift to the centre-of-mass frame. */
function centre(s: GravityState): void {
  let m = 0
  const x = [0, 0, 0]
  const v = [0, 0, 0]
  for (let i = 0; i < s.n; i++) {
    m += s.mass[i]
    for (let d = 0; d < 3; d++) {
      x[d] += s.mass[i] * s.pos[3 * i + d]
      v[d] += s.mass[i] * s.vel[3 * i + d]
    }
  }
  for (let i = 0; i < s.n; i++) {
    for (let d = 0; d < 3; d++) {
      s.pos[3 * i + d] -= x[d] / m
      s.vel[3 * i + d] -= v[d] / m
    }
  }
}

/** A direction uniform on the unit sphere, from two uniforms. */
function direction(u: number, v: number): [number, number, number] {
  const z = 2 * u - 1
  const r = Math.sqrt(1 - z * z)
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v), z]
}

/**
 * Uniform sphere of radius 1 and mass 1 with isotropic Gaussian velocities scaled so
 * that 2K / |U| equals `virial` (0 is a cold start), U being the softened potential energy.
 */
export function uniformSphere(n: number, virial: number, eps: number, seed: number): GravityState {
  const s = createGravity(n)
  let c = 0
  const next = () => uniform(seed, c++)
  for (let i = 0; i < n; i++) {
    s.mass[i] = 1 / n
    const r = Math.cbrt(next())
    const dir = direction(next(), next())
    for (let d = 0; d < 3; d++) {
      s.pos[3 * i + d] = r * dir[d]
      // Sum of three uniforms: close enough to Gaussian for an initial velocity field.
      s.vel[3 * i + d] = next() + next() + next() - 1.5
    }
  }
  centre(s)
  accelerations(s, eps)
  const sc = gravityScalars(s)
  const scale = Math.sqrt((virial * Math.abs(sc.pe)) / (2 * sc.ke))
  for (let k = 0; k < s.vel.length; k++) s.vel[k] *= scale
  return s
}

/**
 * Plummer sphere in equilibrium with scale radius 1 and mass 1 (Aarseth, Hénon & Wielen
 * 1974). Radii beyond `cut` are redrawn so a few distant bodies do not dominate the view.
 */
export function plummerSphere(n: number, eps: number, seed: number, cut = 10): GravityState {
  const s = createGravity(n)
  let c = 0
  const next = () => uniform(seed, c++)
  for (let i = 0; i < n; i++) {
    s.mass[i] = 1 / n
    let r = Infinity
    while (r > cut) r = 1 / Math.sqrt(Math.pow(next(), -2 / 3) - 1)
    const dir = direction(next(), next())
    // Speed as a fraction q of the escape speed, by rejection from q² (1 - q²)^(7/2).
    let q = 0
    for (;;) {
      q = next()
      if (0.1 * next() < q * q * Math.pow(1 - q * q, 3.5)) break
    }
    const speed = q * Math.SQRT2 * Math.pow(1 + r * r, -0.25)
    const vdir = direction(next(), next())
    for (let d = 0; d < 3; d++) {
      s.pos[3 * i + d] = r * dir[d]
      s.vel[3 * i + d] = speed * vdir[d]
    }
  }
  centre(s)
  accelerations(s, eps)
  return s
}
