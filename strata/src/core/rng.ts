// 基于计数器的随机数发生器：取值只依赖 (seed, counter)，因此 CPU 参考实现与
// WGSL 内核无需共享可变状态就能产生完全相同的随机数流。
// 只用 32 位整数运算（这里用 Math.imul，WGSL 中用 u32 算术）。
// Counter-based RNG: value depends only on (seed, counter), so the CPU reference and
// the WGSL kernels can produce identical streams without shared mutable state.
// Uses only 32-bit integer ops (Math.imul here, u32 arithmetic in WGSL).

export function hash32(seed: number, counter: number): number {
  let h = (seed | 0) ^ Math.imul(counter | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  h = Math.imul(h + (seed | 0), 0x27d4eb2f)
  h ^= h >>> 15
  return h >>> 0
}

/** 开区间 (0, 1) 上的均匀分布。 / Uniform in the open interval (0, 1). */
export function uniform(seed: number, counter: number): number {
  return (hash32(seed, counter) + 0.5) / 4294967296
}

/**
 * 用 Box–Muller 变换生成标准正态分布；消耗计数器 2c 和 2c+1。
 * Standard normal via Box–Muller; consumes counters 2c and 2c+1.
 */
export function gaussian(seed: number, counter: number): number {
  const u1 = uniform(seed, 2 * counter)
  const u2 = uniform(seed, 2 * counter + 1)
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}
