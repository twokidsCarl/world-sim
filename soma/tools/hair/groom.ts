// 头发的整套造型：引导发丝的根（头皮上稀疏的泊松圆盘）、层、生长、沉降、波纹、剪齐。
// A whole scalp groom: guide roots (a sparse Poisson disk over the scalp), layers, growth, settling, waves, the cut.

import { type HeadFrame, hairlineAt, toHead, azimuth } from './frame.ts'
import { type Surface, type V3, at } from './geom.ts'
import { scatter } from './sample.ts'
import type { Params, Scalp } from './scalp.ts'
import type { BodyData } from './skin.ts'
import { type ScalpStyle, type Strand, type StyleRule, addWaves, growStrand, styleRule } from './strands.ts'

export interface ScalpGroom {
  style: ScalpStyle
  rule: StyleRule
  guides: Strand[]
}

/** 每平方厘米几根引导发丝 / guide strands per cm² */
const GUIDES_PER_CM2: Record<ScalpStyle, number> = { short: 9, long: 9 }

/** 肩线高度（世界 y）：肩峰附近皮肤的最高处 / shoulder line height (world y): the highest skin near the acromion */
export function shoulderY(b: BodyData, f: HeadFrame): number {
  const P = b.skin.positions
  let best = -Infinity
  for (let i = 0; i < P.length / 3; i++) {
    const p = at(P, i)
    const ax = Math.abs(p[0] - f.origin[0])
    if (ax > 0.15 && ax < 0.19 && Math.abs(p[2] - f.origin[2]) < 0.1 && p[1] < f.origin[1] - 0.12) best = Math.max(best, p[1])
  }
  return best
}

export function scalpGroom(b: BodyData, f: HeadFrame, surface: Surface, scalp: Scalp, style: ScalpStyle, P: Params, seed: number): ScalpGroom {
  const hairline = (l: V3): number => hairlineAt(scalp.knots, azimuth(l))
  const rule = styleRule(style, f, P, hairline)
  const full = P.scalpDensity.value * 1e4
  const roots = scatter(b.skin.positions, b.normals, scalp.triangles, (p) => (scalp.density(p) / full) * GUIDES_PER_CM2[style] * 1e4, seed)
  const lowest = Math.min(...scalp.knots.map((k) => k[1]))
  const shoulder = shoulderY(b, f)
  // 一刀齐，后面比两侧低 3 厘米（U 形）/ a blunt cut, 3 cm lower at the back than at the sides (a U shape)
  const cut = style === 'long' ? (phi: number): number => shoulder - 0.07 - 0.03 * ((1 - Math.cos((phi * Math.PI) / 180)) / 2) ** 2 : null
  const guides: Strand[] = roots.map((root, i) => {
    const l = toHead(f, root.p)
    // 高处的根在外层 / higher roots lie on the outside
    const layer = Math.min(1, Math.max(0, (l[1] - lowest) / (f.top - lowest)))
    const s = growStrand(f, surface, rule, root, layer, seed * 7919 + i, cut)
    return { ...s, pts: addWaves(f, surface, rule, s, s.phase) }
  })
  return { style, rule, guides }
}
