// Pair potentials in reduced units. Every potential is force-shifted at the cutoff so
// that both u(r) and f(r) go continuously to zero at rc:
//   u_fs(r) = u(r) - u(rc) - (r - rc) u'(rc),   f_fs(r) = f(r) - f(rc)
// The simulation kernels never see the functional form: they consume a PairEval, which
// returns g = f(r)/r (so the force vector is g * dr) and u, both as functions of r².

export type PotentialSpec =
  /** Mie n-m, normalised so the well depth is epsilon. n=12, m=6 is Lennard-Jones. */
  | { kind: 'mie'; epsilon: number; sigma: number; n: number; m: number; rc: number }
  /** Morse: epsilon * ((1 - exp(-a (r - r0)))² - 1). */
  | { kind: 'morse'; epsilon: number; r0: number; a: number; rc: number }
  /** Purely repulsive inverse power: epsilon * (sigma / r)^n. */
  | { kind: 'soft'; epsilon: number; sigma: number; n: number; rc: number }

export interface PairOut {
  /** f(r) / r */
  g: number
  u: number
}

export interface PairEval {
  rc2: number
  eval(r2: number, out: PairOut): void
}

export const LJ: PotentialSpec = { kind: 'mie', epsilon: 1, sigma: 1, n: 12, m: 6, rc: 2.5 }

/** Unshifted u(r) and du/dr. */
export function rawPotential(spec: PotentialSpec, r: number): { u: number; du: number } {
  switch (spec.kind) {
    case 'mie': {
      const { epsilon, sigma, n, m } = spec
      const c = (n / (n - m)) * Math.pow(n / m, m / (n - m)) * epsilon
      const sn = Math.pow(sigma / r, n)
      const sm = Math.pow(sigma / r, m)
      return { u: c * (sn - sm), du: (c * (-n * sn + m * sm)) / r }
    }
    case 'morse': {
      const e = Math.exp(-spec.a * (r - spec.r0))
      return { u: spec.epsilon * ((1 - e) * (1 - e) - 1), du: 2 * spec.epsilon * spec.a * e * (1 - e) }
    }
    case 'soft': {
      const s = spec.epsilon * Math.pow(spec.sigma / r, spec.n)
      return { u: s, du: (-spec.n * s) / r }
    }
  }
}

/** Force-shifted u(r) and f(r) = -du/dr; zero at and beyond rc. */
export function shiftedPotential(spec: PotentialSpec, r: number): { u: number; f: number } {
  if (r >= spec.rc) return { u: 0, f: 0 }
  const a = rawPotential(spec, r)
  const c = rawPotential(spec, spec.rc)
  return { u: a.u - c.u - (r - spec.rc) * c.du, f: -(a.du - c.du) }
}

/** Exact f64 evaluation. Used by the reference tests. */
export function analyticPair(spec: PotentialSpec): PairEval {
  const c = rawPotential(spec, spec.rc)
  const rc = spec.rc
  return {
    rc2: rc * rc,
    eval(r2, out) {
      const r = Math.sqrt(r2)
      const a = rawPotential(spec, r)
      out.u = a.u - c.u - (r - rc) * c.du
      out.g = -(a.du - c.du) / r
    },
  }
}

export interface PairTable {
  r2min: number
  rc2: number
  /** Number of intervals; arrays hold k + 1 samples. */
  k: number
  g: Float64Array
  u: Float64Array
}

/**
 * Tabulate g and u on a uniform grid in r² over [rMin², rc²]. Below rMin the values are
 * clamped to the innermost sample, which caps the force in the steep core.
 */
export function buildTable(spec: PotentialSpec, k = 2048, rMin = 0.5): PairTable {
  const r2min = rMin * rMin
  const rc2 = spec.rc * spec.rc
  const g = new Float64Array(k + 1)
  const u = new Float64Array(k + 1)
  for (let i = 0; i <= k; i++) {
    const r = Math.sqrt(r2min + ((rc2 - r2min) * i) / k)
    const s = shiftedPotential(spec, r)
    g[i] = s.f / r
    u[i] = s.u
  }
  return { r2min, rc2, k, g, u }
}

/** Linear interpolation in r². This is the form the GPU kernel uses. */
export function tablePair(t: PairTable): PairEval {
  const scale = t.k / (t.rc2 - t.r2min)
  const { g, u, k, r2min } = t
  return {
    rc2: t.rc2,
    eval(r2, out) {
      const x = Math.max(0, (r2 - r2min) * scale)
      const i = Math.min(k - 1, Math.floor(x))
      const w = Math.min(1, x - i)
      out.g = g[i] + w * (g[i + 1] - g[i])
      out.u = u[i] + w * (u[i + 1] - u[i])
    },
  }
}

/** A pair interaction that may depend on the species of both particles. */
export interface PairField {
  rc2: number
  /** g and u for the force on a particle of species si due to one of species sj. */
  eval(r2: number, out: PairOut, si: number, sj: number): void
}

/**
 * Per-species-pair tables: strength[si][sj] scales epsilon for the force on si from sj.
 * A symmetric matrix gives reciprocal forces (Newton's third law); an asymmetric one
 * does not, and then momentum and energy are no longer conserved.
 */
export function speciesTables(spec: PotentialSpec, strength: number[][], k = 2048): PairTable[][] {
  return strength.map((row) => row.map((e) => buildTable({ ...spec, epsilon: spec.epsilon * e }, k)))
}

export function speciesField(tables: PairTable[][]): PairField {
  const evals = tables.map((row) => row.map(tablePair))
  return {
    rc2: tables[0]![0]!.rc2,
    eval(r2, out, si, sj) {
      evals[si]![sj]!.eval(r2, out)
    },
  }
}
