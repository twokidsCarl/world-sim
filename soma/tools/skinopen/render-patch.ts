// 看一眼定位好但没有接进皮肤的一片（如 vulva-patch.obj）：从下、前下、侧下三个方向；可同时画出现有皮肤（半边）作对照。
// A look at a patch that was fitted but not grafted (e.g. vulva-patch.obj): from below, antero-inferior and
// latero-inferior; the present skin can be drawn with it for comparison.
//
//   bun tools/skinopen/render-patch.ts <patch.obj> <out.png> [skin.obj]

import { readFileSync } from 'node:fs'
import { type RenderItem, type View, render, sheet } from '../rig/render.ts'

const [patchFile, outFile, skinFile] = process.argv.slice(2)
if (!patchFile || !outFile) throw new Error('usage: bun tools/skinopen/render-patch.ts <patch.obj> <out.png> [skin.obj]')
function readObj(file: string): RenderItem {
  const pos: number[] = [], idx: number[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('v ')) {
      const t = line.split(/\s+/)
      pos.push(Number(t[1]), Number(t[2]), Number(t[3]))
    } else if (line.startsWith('f ')) {
      const t = line.trim().split(/\s+/).slice(1).map((s) => Number(s.split('/')[0]) - 1)
      for (let k = 1; k + 1 < t.length; k++) idx.push(t[0]!, t[k]!, t[k + 1]!)
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), color: [226, 178, 156] }
}
const patch = readObj(patchFile)
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
for (let i = 0; i < patch.positions.length; i++) {
  lo[i % 3] = Math.min(lo[i % 3]!, patch.positions[i]!)
  hi[i % 3] = Math.max(hi[i % 3]!, patch.positions[i]!)
}
const c: [number, number, number] = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2]
const half = 0.6 * Math.max(hi[0]! - lo[0]!, hi[2]! - lo[2]!)
const views: View[] = [{ yaw: 0, pitch: -89 }, { yaw: 0, pitch: -45 }, { yaw: 60, pitch: -50 }].map((v) => ({ ...v, center: c, halfHeight: half, width: 560, height: 560 }))
const imgs = views.map((v) => render([patch], v, [245, 245, 245]))
if (skinFile) {
  // 现有皮肤画成另一种颜色，并把视野放大，看两者相距多远 / the present skin in another colour and a wider view, to show how far apart the two are
  const skin = { ...readObj(skinFile), color: [150, 170, 200] as const }
  for (const v of [{ yaw: 0, pitch: -89 }, { yaw: 0, pitch: 0 }, { yaw: 90, pitch: 0 }]) {
    const slab: [number, number] | undefined = v.pitch === 0 ? [-0.004, 0.004] : undefined
    imgs.push(render([skin, { ...patch, color: [226, 120, 100] }], { ...v, center: c, halfHeight: half * 1.6, width: 560, height: 560, ...(slab ? { slab } : {}) }, [245, 245, 245]))
  }
}
sheet(imgs, 3).save(outFile)
console.log(outFile)
