// 入口：bun tools/look/preintegrated.ts — 预积分皮肤散射的查找表（Penner 和 Borshukov 2011，GPU Pro 2，按论文重写）。
// Entry point: bun tools/look/preintegrated.ts — the lookup table of pre-integrated skin scattering (Penner &
// Borshukov 2011, GPU Pro 2, reimplemented from the paper).
//
// 做法 / How
//   把光照在半径 r 的圆环上按皮肤的扩散剖面 R(d) 积分：
//     D(θ, r) = ∫ cos⁺(θ + x) R(2r sin(x/2)) dx / ∫ R(2r sin(x/2)) dx，x ∈ [−π, π]
//   R 用 d'Eon、Luebke 和 Enderton 2007（GPU Gems 3 第 14 章）的六个高斯之和（方差 mm²、RGB 权重）。
//   Light is integrated over a ring of radius r with the skin's diffusion profile R(d):
//     D(θ, r) = ∫ cos⁺(θ + x) R(2r sin(x/2)) dx / ∫ R(2r sin(x/2)) dx, x ∈ [−π, π]
//   R is the sum of six Gaussians of d'Eon, Luebke & Enderton 2007 (GPU Gems 3, chapter 14; variances in mm², RGB weights).
// 表的轴 / axes
//   u = N·L · 0.5 + 0.5；v = sqrt(κ / KAPPA_MAX)，κ = 1/r（mm⁻¹）。v = 0（平面）时就是 cos⁺θ，与朗伯相同。
//   u = N·L · 0.5 + 0.5; v = sqrt(κ / KAPPA_MAX), κ = 1/r (mm⁻¹). At v = 0 (flat) it is cos⁺θ, the same as Lambert.
// 输出 / output: public/anatomy/<body>/look/skin-preint.bin（128×32 RGBA half-float，两个人体同一份 / the same for both bodies）

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DataUtils } from 'three'

export const PREINT_W = 128
export const PREINT_H = 32
/** 表能表示的最大曲率（mm⁻¹）：半径 2 mm / the largest curvature the table holds (mm⁻¹): a radius of 2 mm */
export const KAPPA_MAX = 0.5

/** d'Eon 等 2007 的皮肤剖面：[方差 mm², R, G, B] / the skin profile of d'Eon et al. 2007: [variance mm², R, G, B] */
export const PROFILE: [number, number, number, number][] = [
  [0.0064, 0.233, 0.455, 0.649],
  [0.0484, 0.1, 0.336, 0.344],
  [0.187, 0.118, 0.198, 0.0],
  [0.567, 0.113, 0.007, 0.007],
  [1.99, 0.358, 0.004, 0.0],
  [7.41, 0.078, 0.0, 0.0],
]

function profile(d: number, c: number): number {
  let s = 0
  for (const g of PROFILE) s += (g[c + 1]! * Math.exp(-(d * d) / (2 * g[0]))) / (2 * Math.PI * g[0])
  return s
}

/** 一个格子的 RGB / the RGB of one entry */
export function preintegrate(cosTheta: number, kappa: number, steps = 2048): [number, number, number] {
  const theta = Math.acos(Math.max(-1, Math.min(1, cosTheta)))
  if (kappa <= 1e-6) return [Math.max(0, cosTheta), Math.max(0, cosTheta), Math.max(0, cosTheta)]
  const r = 1 / kappa
  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    let num = 0, den = 0
    for (let k = 0; k < steps; k++) {
      const x = -Math.PI + ((k + 0.5) / steps) * 2 * Math.PI
      const w = profile(Math.abs(2 * r * Math.sin(x / 2)), c)
      num += Math.max(0, Math.cos(theta + x)) * w
      den += w
    }
    out[c] = num / den
  }
  return out
}

export function buildPreint(w = PREINT_W, h = PREINT_H, steps = 2048): Float32Array {
  const out = new Float32Array(w * h * 4)
  for (let j = 0; j < h; j++) {
    const v = j / (h - 1)
    const kappa = KAPPA_MAX * v * v
    for (let i = 0; i < w; i++) {
      const rgb = preintegrate((i / (w - 1)) * 2 - 1, kappa, steps)
      out.set([...rgb, 1], (j * w + i) * 4)
    }
  }
  return out
}

function main(): void {
  const root = join(import.meta.dirname, '..', '..')
  const t = buildPreint()
  const half = new Uint16Array(t.length)
  for (let i = 0; i < t.length; i++) half[i] = DataUtils.toHalfFloat(t[i]!)
  for (const body of ['male', 'female']) {
    const dir = join(root, 'public', 'anatomy', body, 'look')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'skin-preint.bin'), new Uint8Array(half.buffer))
  }
  console.log(`skin-preint.bin: ${PREINT_W}×${PREINT_H}, ${(half.byteLength / 1024).toFixed(0)} kB`)
}

if (import.meta.main) main()
