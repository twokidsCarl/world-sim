// 二维 Ising 模型的 CPU 参考实现：含最近邻（J = 1）与对角（J2）耦合以及外场 h，
// 在四个交错子格上按 Metropolis 算法更新。决定是否翻转的全部运算都是整数运算，
// 因此 GPU 内核能逐位复现。
// CPU reference for the 2D Ising model with nearest (J = 1) and diagonal (J2) couplings
// and a field h, updated by Metropolis on four interleaved sublattices. Everything that
// decides a flip is integer arithmetic, so the GPU kernel reproduces it bit for bit.

import { hash32, uniform } from '../../core/rng'

export const TIE_KEY = 0x40000000
const ALWAYS = 0xffffffff

/**
 * 接受阈值表，索引为 s01 * 25 + ((nn + 4) / 2) * 5 + (nnn + 4) / 2，
 * 其中 s01 是以 0/1 表示的自旋，nn、nnn 是近邻自旋之和。
 * 阈值为 ALWAYS 或随机 u32 小于阈值时接受翻转。
 * Acceptance thresholds indexed by s01 * 25 + ((nn + 4) / 2) * 5 + (nnn + 4) / 2, where
 * s01 is the spin as 0/1 and nn, nnn are the neighbour sums. A flip is accepted when the
 * threshold is ALWAYS or the random u32 is below it.
 */
export function thresholds(T: number, j2: number, h: number): Uint32Array {
  const out = new Uint32Array(50)
  for (let s01 = 0; s01 < 2; s01++) {
    for (let a = 0; a < 5; a++) {
      for (let b = 0; b < 5; b++) {
        const dE = 2 * (2 * s01 - 1) * (2 * a - 4 + j2 * (2 * b - 4) + h)
        out[s01 * 25 + a * 5 + b] = dE <= 0 ? ALWAYS : Math.min(Math.floor(Math.exp(-dE / T) * 4294967296), ALWAYS - 1)
      }
    }
  }
  return out
}

export interface IsingState {
  L: number
  /** 每个格点取 0 或 1，按行主序存储。 / 0 or 1 per site, row-major. */
  spins: Uint8Array
  seed: number
  /** 已完成的子格遍数；四遍构成一次扫描。 / Number of sublattice passes done; four make one sweep. */
  pass: number
}

export function createIsing(L: number, seed: number, ordered = false): IsingState {
  const spins = new Uint8Array(L * L)
  for (let i = 0; i < L * L; i++) spins[i] = ordered ? 1 : hash32(seed ^ 0x1234567, i) & 1
  return { L, spins, seed, pass: 0 }
}

const pm = (b: number) => 2 * b - 1

/**
 * 一遍子格更新。更新满足 (x & 1) + 2 (y & 1) 等于 pass & 3 的格点。
 * One sublattice pass. Sites with (x & 1) + 2 (y & 1) equal to pass & 3 are updated.
 */
export function sublatticePass(s: IsingState, thr: Uint32Array): void {
  const { L, spins } = s
  const colour = s.pass & 3
  const key = hash32(s.seed, s.pass)
  for (let y = (colour >> 1) & 1; y < L; y += 2) {
    const up = ((y + L - 1) % L) * L
    const down = ((y + 1) % L) * L
    const row = y * L
    for (let x = colour & 1; x < L; x += 2) {
      const l = (x + L - 1) % L
      const r = (x + 1) % L
      const nn = pm(spins[row + l]) + pm(spins[row + r]) + pm(spins[up + x]) + pm(spins[down + x])
      const nnn = pm(spins[up + l]) + pm(spins[up + r]) + pm(spins[down + l]) + pm(spins[down + r])
      const site = row + x
      const t = thr[spins[site] * 25 + ((nn + 4) >> 1) * 5 + ((nnn + 4) >> 1)]
      if (t === ALWAYS || hash32(key, site) < t) spins[site] ^= 1
    }
  }
  s.pass++
}

export function sweep(s: IsingState, thr: Uint32Array, n = 1): void {
  for (let i = 0; i < 4 * n; i++) sublatticePass(s, thr)
}

/**
 * 对 2×2 块取多数规则；平局由固定的逐格点哈希决定。
 * Majority rule over 2×2 blocks; ties are broken by a fixed per-site hash.
 */
export function blockSpins(src: Uint8Array, L: number, seed: number, level: number): Uint8Array {
  const M = L >> 1
  const dst = new Uint8Array(M * M)
  const key = hash32(seed, TIE_KEY + level)
  for (let y = 0; y < M; y++) {
    for (let x = 0; x < M; x++) {
      const i = 2 * y * L + 2 * x
      const sum = src[i] + src[i + 1] + src[i + L] + src[i + L + 1]
      dst[y * M + x] = sum > 2 ? 1 : sum < 2 ? 0 : hash32(key, y * M + x) & 1
    }
  }
  return dst
}

export interface LatticeSums {
  /** Σ s */
  s: number
  /** 对最近邻键求 s s' 之和（每个格点 2 条）。 / Σ over nearest-neighbour bonds of s s' (2 per site). */
  nn: number
  /** 对对角键求 s s' 之和（每个格点 2 条）。 / Σ over diagonal bonds of s s' (2 per site). */
  nnn: number
}

export function latticeSums(spins: Uint8Array, L: number): LatticeSums {
  let s = 0
  let nn = 0
  let nnn = 0
  for (let y = 0; y < L; y++) {
    const down = ((y + 1) % L) * L
    for (let x = 0; x < L; x++) {
      const r = (x + 1) % L
      const l = (x + L - 1) % L
      const v = pm(spins[y * L + x])
      s += v
      nn += v * (pm(spins[y * L + r]) + pm(spins[down + x]))
      nnn += v * (pm(spins[down + r]) + pm(spins[down + l]))
    }
  }
  return { s, nn, nnn }
}

/**
 * 金字塔中的晶格层数：边长不断减半，直到再减就小于 8 为止。
 * Number of lattices in the pyramid: halve until the side would drop below 8.
 */
export function pyramidLevels(L: number): number {
  let levels = 1
  for (let size = L; size >= 16 && size % 2 === 0; size >>= 1) levels++
  return levels
}

/**
 * 零场下的一次 Wolff 集团翻转（Wolff 1989），含最近邻（J = 1）与对角（J2 >= 0）耦合。
 * 从随机选取的种子格点出发生长同向自旋集团，每个同向近邻以概率 1 - exp(-2 J / T) 加入，
 * 然后整体翻转。与单自旋 Metropolis 不同，它在临界点不会出现临界慢化，
 * 所以临界行为的测试用的是它；它不属于被模拟的动力学。`rng` 保存随机数流的位置，并会被推进。
 * 返回集团大小。
 * One Wolff cluster flip (Wolff 1989) in zero field, with nearest (J = 1) and diagonal
 * (J2 >= 0) couplings. Grow a cluster of aligned spins from a random seed site, adding
 * each aligned neighbour with probability 1 - exp(-2 J / T), and flip it whole. Unlike
 * single-spin Metropolis it does not slow down at the critical point, so it is what the
 * critical-behaviour tests use; it is not part of the simulated dynamics. `rng` holds the
 * stream position and is advanced. Returns the cluster size.
 */
export function wolffStep(s: IsingState, T: number, j2: number, rng: { seed: number; counter: number }): number {
  const { L, spins } = s
  const next = () => uniform(rng.seed, rng.counter++)
  const pNear = 1 - Math.exp(-2 / T)
  const pDiagonal = j2 > 0 ? 1 - Math.exp((-2 * j2) / T) : 0
  const start = Math.floor(next() * L * L)
  const value = spins[start]
  const stack = [start]
  spins[start] ^= 1
  let size = 1
  const visit = (site: number, p: number) => {
    if (spins[site] === value && next() < p) {
      spins[site] ^= 1
      stack.push(site)
      size++
    }
  }
  while (stack.length > 0) {
    const site = stack.pop()!
    const x = site % L
    const y = (site - x) / L
    const l = (x + L - 1) % L
    const r = (x + 1) % L
    const up = ((y + L - 1) % L) * L
    const down = ((y + 1) % L) * L
    visit(y * L + l, pNear)
    visit(y * L + r, pNear)
    visit(up + x, pNear)
    visit(down + x, pNear)
    if (pDiagonal > 0) {
      visit(up + l, pDiagonal)
      visit(up + r, pDiagonal)
      visit(down + l, pDiagonal)
      visit(down + r, pDiagonal)
    }
  }
  return size
}

/**
 * 由累积的矩计算 Binder 四阶累积量 U4 = 1 - <m⁴> / (3 <m²>²)。
 * Binder's fourth-order cumulant U4 = 1 - <m⁴> / (3 <m²>²) from accumulated moments.
 */
export function binderCumulant(m2: number, m4: number, samples: number): number {
  if (samples === 0 || m2 === 0) return NaN
  return 1 - m4 / samples / (3 * (m2 / samples) ** 2)
}

/**
 * 局部状态的个数：自旋（2 种）× 四个最近邻之和（5 种）。
 * Number of local states: the spin (2 values) times the sum of its four nearest neighbours (5 values).
 */
export const LOCAL_STATES = 10

/**
 * 格点的局部状态编号：spin * 5 + (近邻和 + 4) / 2。
 * Index of a site's local state: spin * 5 + (neighbour sum + 4) / 2.
 */
function localState(spins: Uint8Array, L: number, x: number, y: number): number {
  const l = (x + L - 1) % L
  const r = (x + 1) % L
  const up = ((y + L - 1) % L) * L
  const down = ((y + 1) % L) * L
  const nn = pm(spins[y * L + l]) + pm(spins[y * L + r]) + pm(spins[up + x]) + pm(spins[down + x])
  return spins[y * L + x] * 5 + ((nn + 4) >> 1)
}

/**
 * 两个时刻之间局部状态的转移计数，按行优先排成 LOCAL_STATES × LOCAL_STATES。
 * Counts of local-state transitions between two times, row-major LOCAL_STATES × LOCAL_STATES.
 */
export function transitionCounts(before: Uint8Array, after: Uint8Array, L: number): Float64Array {
  const counts = new Float64Array(LOCAL_STATES * LOCAL_STATES)
  for (let y = 0; y < L; y++) {
    for (let x = 0; x < L; x++) counts[localState(before, L, x, y) * LOCAL_STATES + localState(after, L, x, y)]++
  }
  return counts
}
