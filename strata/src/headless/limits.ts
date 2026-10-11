// 不用浏览器运行时的界限。CPU 参考实现比 GPU 慢两三个数量级，所以尺寸旋钮的上限
// 比界面里的小；这里写明，而不是像界面那样悄悄截到上限。
// Bounds for running without a browser. The CPU reference is two to three orders of
// magnitude slower than the GPU, so size knobs have lower ceilings than in the UI; they are
// stated here instead of being clamped silently as the UI does.

import type { Params } from '../core/params'

export interface RunLimits {
  /** 一次请求最多跑多少步（各阶段合计）。 / Most steps in one request, all stages together. */
  steps: number
  /** 旋钮在 CPU 上的上限（没列的用界面的上限）。 / Ceilings of knobs on the CPU (the UI's own where not listed). */
  max: Record<string, number>
  /** 一个能直接跑的请求。 / A request that runs as it is. */
  example: Record<string, unknown>
}

export const RUN_LIMITS: Record<string, RunLimits> = {
  md: {
    steps: 20000,
    max: { nx: 70 },
    example: { params: { nx: 40, density: 0.6, temperature: 1, thermostat: 1, rc: 4 }, steps: 3000, seed: 1, samples: 10, quantities: ['temperature', 'pressure', 'rdf'] },
  },
  ising: {
    steps: 20000,
    max: { L: 8, L3: 5 },
    example: { params: { T: 2.1, L: 6 }, steps: 10000, seed: 1, samples: 20, quantities: ['magnetisation', 'energy'] },
  },
  potts: {
    steps: 20000,
    max: { L: 8 },
    example: { params: { q: 3, tau: 0.9, L: 6 }, steps: 2000, seed: 1, samples: 10, quantities: ['energy', 'order'] },
  },
  gravity: {
    steps: 10000,
    max: { n: 10 },
    example: { params: { initial: 1, n: 10 }, steps: 500, seed: 1, samples: 10, quantities: ['virial', 'halfMass', 'drift'] },
  },
  mesh: {
    steps: 2000,
    max: { side: 5, grid: 5 },
    example: { params: { initial: 0, amplitude: 0.03, side: 4, grid: 5 }, steps: 300, seed: 1, samples: 10, quantities: ['mode', 'sigma'] },
  },
}

/** 三维粒子体系在 CPU 上每边最多 8 个面心立方晶胞，对应 nx ≤ 32。 / In 3D the CPU takes at most 8 fcc cells a side, i.e. nx ≤ 32. */
export const MD_3D_MAX_NX = 32

/**
 * 只在某些旋钮组合下才有的界限；违反时返回 [字段, 中文说明, 英文说明]。
 * Bounds that depend on a combination of knobs; returns [field, Chinese, English] when one is broken.
 */
export function combinedLimit(substrate: string, p: Params): [string, string, string] | null {
  if (substrate === 'md' && p.dim === 3 && p.nx! > MD_3D_MAX_NX) {
    return ['params.nx', `三维（dim = 3）时 nx 最多 ${MD_3D_MAX_NX}`, `with dim = 3, nx may be at most ${MD_3D_MAX_NX}`]
  }
  return null
}

export const MAX_SAMPLES = 100
export const MAX_STAGES = 5
export const MAX_SEED = 2147483647
