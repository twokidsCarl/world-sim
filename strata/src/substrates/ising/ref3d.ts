// 三维简单立方晶格上的 Ising 模型（只有最近邻耦合 J = 1，加外场 h）的 CPU 参考实现。
// 与二维的 ref.ts 同一套做法：按奇偶两个子格交替做 Metropolis，决定翻转的全是整数运算，
// 所以 GPU 内核可以逐位复现。
//
// CPU reference for the Ising model on the 3D simple cubic lattice (nearest-neighbour
// coupling J = 1 only, plus a field h). Same approach as the 2D ref.ts: Metropolis on two
// interleaved parity sublattices, with every flip decided by integer arithmetic, so the
// GPU kernel reproduces it bit for bit.

import { hash32, uniform } from '../../core/rng'
import { TIE_KEY } from './ref'

const ALWAYS = 0xffffffff

/**
 * 三维的临界温度：数值结果 β_c = 0.221654(2)（三维没有精确解），即 Tc = 4.5115。
 * Critical temperature in 3D: the numerical result β_c = 0.221654(2) (there is no exact
 * solution in 3D), i.e. Tc = 4.5115.
 */
export const ISING3D_TC = 1 / 0.221654

/**
 * 临界点的 Binder 累积量（周期边界的立方体）：0.465(3)。
 * Binder cumulant at the critical point (periodic cube): 0.465(3).
 */
export const BINDER3D_CRITICAL = 0.465

/**
 * 接受阈值表，下标 s01 * 7 + (nn + 6) / 2，nn 是六个近邻之和。
 * Acceptance thresholds indexed by s01 * 7 + (nn + 6) / 2, with nn the sum of the six neighbours.
 */
export function thresholds3d(T: number, h: number): Uint32Array {
  const out = new Uint32Array(14)
  for (let s01 = 0; s01 < 2; s01++) {
    for (let a = 0; a < 7; a++) {
      const dE = 2 * (2 * s01 - 1) * (2 * a - 6 + h)
      out[s01 * 7 + a] = dE <= 0 ? ALWAYS : Math.min(Math.floor(Math.exp(-dE / T) * 4294967296), ALWAYS - 1)
    }
  }
  return out
}

export interface Ising3dState {
  L: number
  /** 每个格点 0 或 1，下标 x + L (y + L z)。 / 0 or 1 per site, indexed x + L (y + L z). */
  spins: Uint8Array
  seed: number
  /** 已做的子格遍数；两遍为一次扫描。 / Sublattice passes done; two make one sweep. */
  pass: number
}

export function createIsing3d(L: number, seed: number, ordered = false): Ising3dState {
  const spins = new Uint8Array(L * L * L)
  for (let i = 0; i < spins.length; i++) spins[i] = ordered ? 1 : hash32(seed ^ 0x1234567, i) & 1
  return { L, spins, seed, pass: 0 }
}

const pm = (b: number) => 2 * b - 1

/** 六个近邻之和。 / Sum of the six neighbours. */
function neighbourSum(spins: Uint8Array, L: number, x: number, y: number, z: number): number {
  const xm = (x + L - 1) % L
  const xp = (x + 1) % L
  const ym = (y + L - 1) % L
  const yp = (y + 1) % L
  const zm = (z + L - 1) % L
  const zp = (z + 1) % L
  const at = (a: number, b: number, c: number) => pm(spins[a + L * (b + L * c)])
  return at(xm, y, z) + at(xp, y, z) + at(x, ym, z) + at(x, yp, z) + at(x, y, zm) + at(x, y, zp)
}

/** 一遍子格更新：更新 (x + y + z) 的奇偶等于 pass & 1 的格点。 / One sublattice pass: sites whose (x + y + z) parity equals pass & 1 are updated. */
export function sublatticePass3d(s: Ising3dState, thr: Uint32Array): void {
  const { L, spins } = s
  const parity = s.pass & 1
  const key = hash32(s.seed, s.pass)
  for (let z = 0; z < L; z++) {
    for (let y = 0; y < L; y++) {
      for (let x = (y + z + parity) & 1; x < L; x += 2) {
        const site = x + L * (y + L * z)
        const t = thr[spins[site] * 7 + ((neighbourSum(spins, L, x, y, z) + 6) >> 1)]
        if (t === ALWAYS || hash32(key, site) < t) spins[site] ^= 1
      }
    }
  }
  s.pass++
}

export function sweep3d(s: Ising3dState, thr: Uint32Array, n = 1): void {
  for (let i = 0; i < 2 * n; i++) sublatticePass3d(s, thr)
}

/** 2×2×2 的多数表决；平局由固定的逐格点哈希决定。 / Majority rule over 2×2×2 blocks; ties are broken by a fixed per-site hash. */
export function blockSpins3d(src: Uint8Array, L: number, seed: number, level: number): Uint8Array {
  const M = L >> 1
  const dst = new Uint8Array(M * M * M)
  const key = hash32(seed, TIE_KEY + level)
  for (let z = 0; z < M; z++) {
    for (let y = 0; y < M; y++) {
      for (let x = 0; x < M; x++) {
        let sum = 0
        for (let c = 0; c < 8; c++) sum += src[2 * x + (c & 1) + L * (2 * y + ((c >> 1) & 1) + L * (2 * z + (c >> 2)))]
        const site = x + M * (y + M * z)
        dst[site] = sum > 4 ? 1 : sum < 4 ? 0 : hash32(key, site) & 1
      }
    }
  }
  return dst
}

/** Σ s 与 Σ 最近邻键 s s'（每个格点 3 条）。 / Σ s and Σ over nearest-neighbour bonds of s s' (3 per site). */
export function latticeSums3d(spins: Uint8Array, L: number): { s: number; nn: number } {
  let s = 0
  let nn = 0
  for (let z = 0; z < L; z++) {
    for (let y = 0; y < L; y++) {
      for (let x = 0; x < L; x++) {
        const v = pm(spins[x + L * (y + L * z)])
        s += v
        nn +=
          v *
          (pm(spins[((x + 1) % L) + L * (y + L * z)]) +
            pm(spins[x + L * (((y + 1) % L) + L * z)]) +
            pm(spins[x + L * (y + L * ((z + 1) % L))]))
      }
    }
  }
  return { s, nn }
}

/** 金字塔的层数：边长减半，直到再减就小于 4。 / Number of lattices in the pyramid: halve the side until it would drop below 4. */
export function pyramidLevels3d(L: number): number {
  let levels = 1
  for (let size = L; size >= 8 && size % 2 === 0; size >>= 1) levels++
  return levels
}

/**
 * 一次 Wolff 团簇翻转（零外场）。只用于检验临界行为的测试，不是被模拟的动力学。返回团簇大小。
 * One Wolff cluster flip (zero field). Used only by the tests of critical behaviour; it
 * is not part of the simulated dynamics. Returns the cluster size.
 */
export function wolffStep3d(s: Ising3dState, T: number, rng: { seed: number; counter: number }): number {
  const { L, spins } = s
  const next = () => uniform(rng.seed, rng.counter++)
  const p = 1 - Math.exp(-2 / T)
  const start = Math.floor(next() * spins.length)
  const value = spins[start]
  const stack = [start]
  spins[start] ^= 1
  let size = 1
  const visit = (site: number) => {
    if (spins[site] === value && next() < p) {
      spins[site] ^= 1
      stack.push(site)
      size++
    }
  }
  while (stack.length > 0) {
    const site = stack.pop()!
    const x = site % L
    const y = Math.floor(site / L) % L
    const z = Math.floor(site / (L * L))
    visit(((x + 1) % L) + L * (y + L * z))
    visit(((x + L - 1) % L) + L * (y + L * z))
    visit(x + L * (((y + 1) % L) + L * z))
    visit(x + L * (((y + L - 1) % L) + L * z))
    visit(x + L * (y + L * ((z + 1) % L)))
    visit(x + L * (y + L * ((z + L - 1) % L)))
  }
  return size
}
