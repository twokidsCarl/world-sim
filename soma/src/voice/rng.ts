// 可复现的伪随机数：同一个种子给出同一串数，合成结果因此可以逐样本重现。
// Reproducible pseudo-random numbers: one seed, one sequence, so a rendering can be repeated sample for sample.

export interface Rng {
  // [0, 1) 均匀 / uniform in [0, 1)
  next(): number
  // 标准正态 / standard normal
  gauss(): number
  range(lo: number, hi: number): number
  // 派生一个互不相关的子序列 / derive an independent sub-stream
  fork(label: number): Rng
}

export function makeRng(seed: number): Rng {
  let a = (Math.floor(seed) ^ 0x9e3779b9) >>> 0
  let spare: number | null = null
  // mulberry32
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = 0; i < 4; i++) next()
  const gauss = () => {
    if (spare !== null) { const s = spare; spare = null; return s }
    let u = 0
    while (u < 1e-12) u = next()
    const m = Math.sqrt(-2 * Math.log(u))
    const ang = 2 * Math.PI * next()
    spare = m * Math.sin(ang)
    return m * Math.cos(ang)
  }
  return {
    next,
    gauss,
    range: (lo, hi) => lo + (hi - lo) * next(),
    fork: (label) => makeRng(Math.imul((Math.floor(seed) + 0x632be5ab) >>> 0, 2654435761) ^ Math.imul(label + 1, 0x85ebca6b)),
  }
}
