// 约化单位下的对势。每种势都在截断处做力平移（force-shifted），使 u(r) 和 f(r)
// 在 rc 处都连续地趋于零：
//   u_fs(r) = u(r) - u(rc) - (r - rc) u'(rc),   f_fs(r) = f(r) - f(rc)
// 模拟内核从不接触势的函数形式：它们使用 PairEval，后者返回 g = f(r)/r
// （于是力矢量为 g * dr）和 u，二者都是 r² 的函数。
//
// Pair potentials in reduced units. Every potential is force-shifted at the cutoff so
// that both u(r) and f(r) go continuously to zero at rc:
//   u_fs(r) = u(r) - u(rc) - (r - rc) u'(rc),   f_fs(r) = f(r) - f(rc)
// The simulation kernels never see the functional form: they consume a PairEval, which
// returns g = f(r)/r (so the force vector is g * dr) and u, both as functions of r².

export type PotentialSpec =
  /**
   * Mie n-m 势，归一化使势阱深度为 epsilon。n=12、m=6 即 Lennard-Jones 势。
   * Mie n-m, normalised so the well depth is epsilon. n=12, m=6 is Lennard-Jones.
   */
  | { kind: 'mie'; epsilon: number; sigma: number; n: number; m: number; rc: number }
  /** Morse 势：epsilon * ((1 - exp(-a (r - r0)))² - 1)。 / Morse: epsilon * ((1 - exp(-a (r - r0)))² - 1). */
  | { kind: 'morse'; epsilon: number; r0: number; a: number; rc: number }
  /**
   * 纯排斥的反幂律势：epsilon * (sigma / r)^n。
   * Purely repulsive inverse power: epsilon * (sigma / r)^n.
   */
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

/** 未移位的 u(r) 与 du/dr。 / Unshifted u(r) and du/dr. */
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

/**
 * 力平移后的 u(r) 与 f(r) = -du/dr；在 rc 及更远处为零。
 * Force-shifted u(r) and f(r) = -du/dr; zero at and beyond rc.
 */
export function shiftedPotential(spec: PotentialSpec, r: number): { u: number; f: number } {
  if (r >= spec.rc) return { u: 0, f: 0 }
  const a = rawPotential(spec, r)
  const c = rawPotential(spec, spec.rc)
  return { u: a.u - c.u - (r - spec.rc) * c.du, f: -(a.du - c.du) }
}

/**
 * 势阱最低点的位置：在 [0.5, rc] 上先扫描再用黄金分割细化。没有势阱（纯排斥）时返回 rc。
 * Where the well is deepest: a scan over [0.5, rc] refined by golden-section search.
 * Returns rc when there is no well (a purely repulsive potential).
 */
export function wellPosition(spec: PotentialSpec): number {
  const steps = 400
  let best = spec.rc
  let bestU = rawPotential(spec, spec.rc).u
  for (let i = 0; i < steps; i++) {
    const r = 0.5 + ((spec.rc - 0.5) * i) / steps
    const u = rawPotential(spec, r).u
    if (u < bestU) {
      bestU = u
      best = r
    }
  }
  if (best === spec.rc) return best
  const h = (spec.rc - 0.5) / steps
  let a = Math.max(0.5, best - h)
  let b = Math.min(spec.rc, best + h)
  const ratio = (Math.sqrt(5) - 1) / 2
  for (let i = 0; i < 60; i++) {
    const c = b - ratio * (b - a)
    const d = a + ratio * (b - a)
    if (rawPotential(spec, c).u < rawPotential(spec, d).u) b = d
    else a = c
  }
  return (a + b) / 2
}

/**
 * 只留排斥的那一半（Weeks–Chandler–Andersen 的做法）：在势阱最低点截断并上移阱深，
 * 势和力在截断处都连续地到零。
 * The repulsive half only (as Weeks, Chandler and Andersen do): cut at the bottom of the
 * well and shifted up by its depth, so both potential and force reach zero continuously
 * at the cut.
 */
export function repulsivePotential(spec: PotentialSpec, r: number): { u: number; f: number } {
  const rm = wellPosition(spec)
  if (r >= rm) return { u: 0, f: 0 }
  const a = rawPotential(spec, r)
  return { u: a.u - rawPotential(spec, rm).u, f: -a.du }
}

/** 精确的 f64 求值。供参考测试使用。 / Exact f64 evaluation. Used by the reference tests. */
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
  /** 区间数；数组存有 k + 1 个采样点。 / Number of intervals; arrays hold k + 1 samples. */
  k: number
  g: Float64Array
  u: Float64Array
}

/**
 * 在 [rMin², rc²] 上按 r² 的均匀网格对 g 和 u 列表。
 * rMin 以内的值钳制为最内侧的采样点，从而给陡峭芯区内的力封顶。
 * Tabulate g and u on a uniform grid in r² over [rMin², rc²]. Below rMin the values are
 * clamped to the innermost sample, which caps the force in the steep core.
 */
export function buildTable(spec: PotentialSpec, k = 2048, rMin = 0.5, repulsive = false): PairTable {
  const r2min = rMin * rMin
  const rc2 = spec.rc * spec.rc
  const g = new Float64Array(k + 1)
  const u = new Float64Array(k + 1)
  for (let i = 0; i <= k; i++) {
    const r = Math.sqrt(r2min + ((rc2 - r2min) * i) / k)
    const s = repulsive ? repulsivePotential(spec, r) : shiftedPotential(spec, r)
    g[i] = s.f / r
    u[i] = s.u
  }
  return { r2min, rc2, k, g, u }
}

/**
 * 按 r² 线性插值。GPU 内核用的就是这种形式。
 * Linear interpolation in r². This is the form the GPU kernel uses.
 */
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

/**
 * 可依赖于两个粒子各自组分的对相互作用。
 * A pair interaction that may depend on the species of both particles.
 */
export interface PairField {
  rc2: number
  /**
   * 组分 sj 的粒子作用于组分 si 的粒子的力所对应的 g 和 u。
   * g and u for the force on a particle of species si due to one of species sj.
   */
  eval(r2: number, out: PairOut, si: number, sj: number): void
}

/**
 * 按组分对分别列表：strength[si][sj] 是 epsilon 的缩放系数，用于 sj 对 si 的作用力。
 * 对称矩阵给出互易的力（牛顿第三定律）；非对称矩阵则不然，此时动量和能量不再守恒。
 * Per-species-pair tables: strength[si][sj] scales epsilon for the force on si from sj.
 * A symmetric matrix gives reciprocal forces (Newton's third law); an asymmetric one
 * does not, and then momentum and energy are no longer conserved.
 * repulsive[si][sj] 为真的那一对只留排斥的一半。
 * A pair with repulsive[si][sj] set keeps only its repulsive half.
 */
export function speciesTables(spec: PotentialSpec, strength: number[][], k = 2048, repulsive?: boolean[][]): PairTable[][] {
  return strength.map((row, si) =>
    row.map((e, sj) => buildTable({ ...spec, epsilon: spec.epsilon * e }, k, 0.5, repulsive?.[si]?.[sj] === true)),
  )
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
