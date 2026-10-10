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

/** Uniform in the open interval (0, 1). */
export function uniform(seed: number, counter: number): number {
  return (hash32(seed, counter) + 0.5) / 4294967296
}

/** Standard normal via Box–Muller; consumes counters 2c and 2c+1. */
export function gaussian(seed: number, counter: number): number {
  const u1 = uniform(seed, 2 * counter)
  const u2 = uniform(seed, 2 * counter + 1)
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}
