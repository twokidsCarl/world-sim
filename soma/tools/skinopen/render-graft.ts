// 看一眼移植后的皮肤：每个移植处，原皮肤 | 移植后（按分组着色：供体片、缝合三角形）| 移植后（同一肤色）。
// A look at the grafted skin: for every graft, the delivered skin | grafted (coloured by group: patch,
// stitch triangles) | grafted (one skin colour).
//
//   bun tools/skinopen/render-graft.ts <package-grafted-dir> [out-dir]

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type RenderItem, type Rgb, type View, render, sheet } from '../rig/render.ts'

const pkg = process.argv[2]
if (!pkg) throw new Error('usage: bun tools/skinopen/render-graft.ts <package-grafted-dir> [out-dir]')
const outDir = process.argv[3] ?? join(pkg, 'renders')
mkdirSync(outDir, { recursive: true })

function readObj(file: string): { positions: Float32Array; groups: Map<string, number[]> } {
  const pos: number[] = []
  const groups = new Map<string, number[]>()
  let cur: number[] = []
  groups.set('skin', cur)
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('v ')) {
      const t = line.split(/\s+/)
      pos.push(Number(t[1]), Number(t[2]), Number(t[3]))
    } else if (line.startsWith('g ')) {
      const name = line.slice(2).trim()
      if (!groups.has(name)) groups.set(name, [])
      cur = groups.get(name)!
    } else if (line.startsWith('f ')) {
      const t = line.trim().split(/\s+/).slice(1).map((s) => Number(s.split('/')[0]) - 1)
      for (let k = 1; k + 1 < t.length; k++) cur.push(t[0]!, t[k]!, t[k + 1]!)
    }
  }
  return { positions: Float32Array.from(pos), groups }
}

const manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8'))
const grafted = readObj(join(pkg, 'skin.obj'))
const delivered = readObj(join(pkg, 'skin-delivered.obj'))
const SKIN: Rgb = [226, 178, 156], PATCH: Rgb = [200, 150, 135], STITCH: Rgb = [120, 160, 220]
const items = (o: ReturnType<typeof readObj>, coloured: boolean): RenderItem[] =>
  [...o.groups].filter(([, f]) => f.length).map(([g, f]) => ({ positions: o.positions, indices: Uint32Array.from(f), color: !coloured || g === 'skin' ? SKIN : g.endsWith('Stitch') ? STITCH : PATCH }))

// 每个移植处自己的一组视图（方向按身体部位）/ each graft has its own set of views (directions by body region)
const VIEWS: Record<string, { name: string; yaw: number; pitch: number }[]> = {
  default: [{ name: 'front', yaw: 0, pitch: 0 }, { name: 'oblique', yaw: 40, pitch: 10 }, { name: 'lowOblique', yaw: -35, pitch: -30 }, { name: 'below', yaw: 0, pitch: -70 }],
  toes: [{ name: 'above', yaw: 0, pitch: 70 }, { name: 'front', yaw: 0, pitch: 10 }, { name: 'medial', yaw: -90, pitch: 10 }, { name: 'below', yaw: 0, pitch: -80 }],
}
for (const g of manifest.grafted.grafts as { name: string; rimOfHole: number[]; patchVertices: number[]; blendRingVertices: number[] }[]) {
  const ids = [...g.patchVertices, ...g.blendRingVertices]
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (const v of ids) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k]!, grafted.positions[v * 3 + k]!)
    hi[k] = Math.max(hi[k]!, grafted.positions[v * 3 + k]!)
  }
  const c: [number, number, number] = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2]
  const half = 0.62 * Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!)
  const imgs = []
  for (const v of VIEWS[/toe/i.test(g.name) ? 'toes' : 'default']!) {
    const view: View = { yaw: v.yaw, pitch: v.pitch, center: c, halfHeight: half, width: 520, height: 520 }
    imgs.push(render(items(delivered, false), view, [245, 245, 245]), render(items(grafted, true), view, [245, 245, 245]), render(items(grafted, false), view, [245, 245, 245]))
  }
  const file = join(outDir, `graft-${g.name}.png`)
  sheet(imgs, 3).save(file)
  console.log(file)
}
