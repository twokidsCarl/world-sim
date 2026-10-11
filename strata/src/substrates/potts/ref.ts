// 二维 q 态 Potts 模型的 CPU 参考实现：H = −Σ δ(sᵢ, sⱼ)，对最近邻键求和。
// 在两个交错子格上按 Metropolis 算法更新：每个格点提议换成另外 q − 1 个状态里随机的一个。
// 决定是否接受的全部运算都是整数运算，因此 GPU 内核能逐位复现。
// CPU reference for the 2D q-state Potts model, H = −Σ δ(sᵢ, sⱼ) over nearest-neighbour
// bonds. Metropolis updates on two interleaved sublattices: each site proposes one of the
// other q − 1 states at random. Everything that decides an acceptance is integer
// arithmetic, so the GPU kernel reproduces it bit for bit.

import { hash32, uniform } from '../../core/rng'

export const MAX_Q = 8
export const TIE_KEY = 0x40000000
const ACCEPT_KEY = 0x5bd1e995
const ALWAYS = 0xffffffff

/**
 * 接受阈值，下标是能量的增量 ΔE = 旧状态的同态近邻数 − 新状态的同态近邻数（1 到 4）；
 * 下标 0 恒为接受。随机 u32 小于阈值时接受。
 * Acceptance thresholds indexed by the energy increase ΔE = like neighbours of the old
 * state − like neighbours of the new one (1 to 4); index 0 always accepts. A proposal is
 * accepted when the random u32 is below the threshold.
 */
export function thresholds(T: number): Uint32Array {
  const out = new Uint32Array(5)
  out[0] = ALWAYS
  for (let d = 1; d <= 4; d++) out[d] = Math.min(Math.floor(Math.exp(-d / T) * 4294967296), ALWAYS - 1)
  return out
}

export interface PottsState {
  L: number
  q: number
  /** 每个格点取 0 到 q − 1，按行主序存储。 / 0 to q − 1 per site, row-major. */
  spins: Uint8Array
  seed: number
  /** 已完成的子格遍数；两遍构成一次扫描。 / Number of sublattice passes done; two make one sweep. */
  pass: number
}

export function createPotts(L: number, q: number, seed: number, ordered = false): PottsState {
  const spins = new Uint8Array(L * L)
  if (!ordered) for (let i = 0; i < L * L; i++) spins[i] = hash32(seed ^ 0x1234567, i) % q
  return { L, q, spins, seed, pass: 0 }
}

/**
 * 一遍子格更新：更新 (x + y) 的奇偶与 pass 相同的格点。L 必须是偶数。
 * One sublattice pass: sites whose (x + y) has the parity of `pass` are updated. L must be even.
 */
export function sublatticePass(s: PottsState, thr: Uint32Array): void {
  const { L, q, spins } = s
  const colour = s.pass & 1
  const key = hash32(s.seed, s.pass)
  const acceptKey = hash32(s.seed ^ ACCEPT_KEY, s.pass)
  for (let y = 0; y < L; y++) {
    const up = ((y + L - 1) % L) * L
    const down = ((y + 1) % L) * L
    const row = y * L
    for (let x = (y + colour) & 1; x < L; x += 2) {
      const site = row + x
      const a = spins[row + ((x + L - 1) % L)]!
      const b = spins[row + ((x + 1) % L)]!
      const c = spins[up + x]!
      const d = spins[down + x]!
      const old = spins[site]!
      const next = (old + 1 + (hash32(key, site) % (q - 1))) % q
      const dE =
        Number(a === old) + Number(b === old) + Number(c === old) + Number(d === old) -
        (Number(a === next) + Number(b === next) + Number(c === next) + Number(d === next))
      if (dE <= 0 || hash32(acceptKey, site) < thr[dE]!) spins[site] = next
    }
  }
  s.pass++
}

export function sweep(s: PottsState, thr: Uint32Array, n = 1): void {
  for (let i = 0; i < 2 * n; i++) sublatticePass(s, thr)
}

/**
 * 2×2 块取相对多数的状态。块里的四个格点各自数一数有几个与自己同态；并列第一时，
 * 由逐块哈希挑中的那个格点若在并列者之中就取它，否则取顺序上的第一个。
 * Plurality rule over 2×2 blocks. Each of the four cells counts how many cells share its
 * state; among those tied for the most, the cell picked by a per-block hash wins if it is
 * one of them, otherwise the first in order.
 */
export function blockStates(src: Uint8Array, L: number, seed: number, level: number): Uint8Array {
  const M = L >> 1
  const dst = new Uint8Array(M * M)
  const key = hash32(seed, TIE_KEY + level)
  const cell = [0, 0, 0, 0]
  const count = [0, 0, 0, 0]
  for (let y = 0; y < M; y++) {
    for (let x = 0; x < M; x++) {
      const i = 2 * y * L + 2 * x
      cell[0] = src[i]!
      cell[1] = src[i + 1]!
      cell[2] = src[i + L]!
      cell[3] = src[i + L + 1]!
      let most = 0
      for (let k = 0; k < 4; k++) {
        count[k] = 0
        for (let j = 0; j < 4; j++) count[k]! += Number(cell[j] === cell[k])
        most = Math.max(most, count[k]!)
      }
      let pick = hash32(key, y * M + x) & 3
      if (count[pick] !== most) {
        pick = 0
        while (count[pick] !== most) pick++
      }
      dst[y * M + x] = cell[pick]!
    }
  }
  return dst
}

export interface PottsSums {
  /** 各状态的格点数，长度 MAX_Q。 / Sites in each state, length MAX_Q. */
  counts: number[]
  /** 两端同态的最近邻键数（每个格点 2 条键）。 / Nearest-neighbour bonds joining like states (2 bonds per site). */
  bonds: number
}

export function latticeSums(spins: Uint8Array, L: number): PottsSums {
  const counts = new Array<number>(MAX_Q).fill(0)
  let bonds = 0
  for (let y = 0; y < L; y++) {
    const down = ((y + 1) % L) * L
    for (let x = 0; x < L; x++) {
      const v = spins[y * L + x]!
      counts[v]!++
      bonds += Number(v === spins[y * L + ((x + 1) % L)]) + Number(v === spins[down + x])
    }
  }
  return { counts, bonds }
}

/**
 * 序参量 m = (q ρ_max − 1) / (q − 1)：各态均分时为 0，全在一个态时为 1。
 * Order parameter m = (q ρ_max − 1) / (q − 1): 0 when the states are equally populated, 1
 * when every site is in one state.
 */
export function orderParameter(counts: ArrayLike<number>, q: number): number {
  let total = 0
  let most = 0
  for (let k = 0; k < q; k++) {
    total += counts[k]!
    most = Math.max(most, counts[k]!)
  }
  return total > 0 ? ((q * most) / total - 1) / (q - 1) : 0
}

/**
 * 一次 Wolff 集团更新：从随机格点出发生长同态集团，每个同态近邻以概率 1 − exp(−1/T) 加入，
 * 然后把整个集团换成另一个随机状态。临界点上它不会临界慢化，所以测试用它取平衡平均；
 * 它不属于被模拟的动力学。返回集团大小。
 * One Wolff cluster update: grow a cluster of like states from a random site, adding each
 * like neighbour with probability 1 − exp(−1/T), then move the whole cluster to another
 * state chosen at random. It does not slow down at the critical point, so the tests use
 * it for equilibrium averages; it is not part of the simulated dynamics. Returns the
 * cluster size.
 */
export function wolffStep(s: PottsState, T: number, rng: { seed: number; counter: number }): number {
  const { L, q, spins } = s
  const next = () => uniform(rng.seed, rng.counter++)
  const p = 1 - Math.exp(-1 / T)
  const start = Math.floor(next() * L * L)
  const old = spins[start]!
  const value = (old + 1 + Math.floor(next() * (q - 1))) % q
  const stack = [start]
  spins[start] = value
  let size = 1
  const visit = (site: number) => {
    if (spins[site] === old && next() < p) {
      spins[site] = value
      stack.push(site)
      size++
    }
  }
  while (stack.length > 0) {
    const site = stack.pop()!
    const x = site % L
    const y = (site - x) / L
    visit(y * L + ((x + L - 1) % L))
    visit(y * L + ((x + 1) % L))
    visit(((y + L - 1) % L) * L + x)
    visit(((y + 1) % L) * L + x)
  }
  return size
}
