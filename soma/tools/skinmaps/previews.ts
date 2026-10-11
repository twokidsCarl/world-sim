// 预览图：全身四视图和局部放大图，带图例。仅供开发时目视检查。
// Previews: four whole-body views and close-ups, with a legend. For visual checking during development only.

import { join } from 'node:path'
import type { BuiltMap, MapDef } from './build.ts'
import type { Generated } from './generate.ts'
import { pos, type Skin, type V3 } from './mesh.ts'
import { hexRgb, renderView, sheet, STANDARD_VIEWS, type View } from './render.ts'

type Box = [number, number, number, number, number, number]

export function writePreviews(g: Generated, outDir: string, tag: string) {
  const { skin, lm } = g.ctx
  const around = (c: V3, r: [number, number, number]): Box => [c[0] - r[0], c[1] - r[1], c[2] - r[2], c[0] + r[0], c[1] + r[1], c[2] + r[2]]
  const hand = around(lm.point('mc3Head', 'R'), [0.11, 0.17, 0.2])
  const foot = around(lm.point('mt2Head', 'R'), [0.12, 0.2, 0.3])
  foot[4] = lm.point('ankle', 'R')[1] + 0.12
  const head: Box = [-0.2, lm.point('sternalNotch', 'R')[1], -1, 0.2, 3, 1]
  const neck = lm.point('sternalNotch', 'R')[1], hip = lm.point('ischialTuberosity', 'R')[1]
  const trunk: Box = [-0.2, hip - 0.04, -1, 0.2, neck + 0.12, 1]
  const details: View[] = [
    { name: 'head front', dir: [0, 0, -1], up: [0, 1, 0], box: head }, { name: 'head right', dir: [1, 0, 0], up: [0, 1, 0], box: head },
    { name: 'head back', dir: [0, 0, 1], up: [0, 1, 0], box: head }, { name: 'head top', dir: [0, -1, 0], up: [0, 0, 1], box: [-0.2, neck + 0.14, -1, 0.2, 3, 1] },
    { name: 'r hand palm', dir: [0, 0, -1], up: [0, 1, 0], box: hand }, { name: 'r hand dorsum', dir: [0, 0, 1], up: [0, 1, 0], box: hand },
    { name: 'r foot top', dir: [0, -1, 0], up: [0, 0, 1], box: foot }, { name: 'r sole', dir: [0, 1, 0], up: [0, 0, 1], box: [foot[0], foot[1], foot[2], foot[3], lm.point('ankle', 'R')[1] + 0.05, foot[5]] },
    { name: 'r foot lateral', dir: [1, 0, 0], up: [0, 1, 0], box: foot }, { name: 'r foot medial', dir: [-1, 0, 0], up: [0, 1, 0], box: foot },
    { name: 'perineum from below', dir: [0, 1, 0], up: [0, 0, 1], box: [-0.2, hip - 0.16, -1, 0.2, hip + 0.1, 1] },
  ]
  const trunkViews: View[] = [
    { name: 'trunk front', dir: [0, 0, -1], up: [0, 1, 0], box: trunk }, { name: 'trunk back', dir: [0, 0, 1], up: [0, 1, 0], box: trunk },
    { name: 'trunk right', dir: [1, 0, 0], up: [0, 1, 0], box: [-0.2, trunk[1], -1, 0, trunk[4], 1] },
  ]
  const one = (name: string, def: MapDef, built: BuiltMap) => {
    const cols = def.regions.map((r) => hexRgb(r.color))
    const col = (v: number) => (built.labels[v] === 255 ? [90, 90, 90] : cols[built.labels[v]!]!)
    const markers = [
      ...[...built.barrierVerts.values()].flat().map((v) => ({ p: pos(skin as Skin, v), c: [0, 0, 0] })),
      ...built.pinned.map((p) => ({ p: pos(skin, p.vertex), c: [255, 255, 0] })),
    ]
    const legend = def.regions.map((r) => ({ label: r.key, color: hexRgb(r.color) }))
    sheet(STANDARD_VIEWS.map((v) => renderView(skin, col, v, 620, markers)), legend, join(outDir, `${name}-${tag}-body.png`))
    sheet(details.map((v) => renderView(skin, col, v, 1500, markers)), legend, join(outDir, `${name}-${tag}-detail.png`), 6)
    sheet(trunkViews.map((v) => renderView(skin, col, v, 1300, markers)), legend, join(outDir, `${name}-${tag}-trunk.png`))
  }
  one('dermatomes', g.ctx.dermatomeDef, g.dermatome)
  one('cutaneous', g.ctx.cutaneousDef, g.cutaneous)
}
