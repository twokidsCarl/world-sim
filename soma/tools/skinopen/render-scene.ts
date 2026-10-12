// 通用的检查图：按一个 JSON 说明画若干网格、若干视图，拼成一张图。graft.py 写出说明文件，run.sh 调用本脚本。
// A general check render: draws some meshes from some views as told by a JSON spec and tiles them into one image.
// graft.py writes the specs and run.sh calls this script.
//
//   bun tools/skinopen/render-scene.ts <spec.json> [<spec.json> ...]
//
// 说明文件 / the spec:
//   { "out": "x.png", "columns": 3, "base": "目录（相对路径由它起算）/ directory relative paths start from",
//     "items": [ { "obj": "skin.obj", "color": [r,g,b], "groups": ["skin"], "notGroups": ["toesL"] },
//                { "positions": [...], "indices": [...], "color": [r,g,b] } ],
//     "views": [ { "yaw": 0, "pitch": 0, "center": [x,y,z], "halfHeight": 0.05, "width": 520, "height": 520,
//                  "slab": [-0.004, 0.004], "items": [0, 1] } ] }
// views[].items 省略时画全部 / all items are drawn when views[].items is omitted.

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { type RenderItem, type Rgb, type View, render, sheet } from '../rig/render.ts'

interface ItemSpec { obj?: string; positions?: number[]; indices?: number[]; color: Rgb; groups?: string[]; notGroups?: string[] }
interface ViewSpec extends View { items?: number[] }
interface Spec { out: string; columns?: number; base?: string; items: ItemSpec[]; views: ViewSpec[] }

const objCache = new Map<string, { positions: Float32Array; groups: Map<string, number[]> }>()
function readObj(file: string) {
  const hit = objCache.get(file)
  if (hit) return hit
  const pos: number[] = []
  const groups = new Map<string, number[]>()
  let cur: number[] = []
  groups.set('', cur)
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
  const o = { positions: Float32Array.from(pos), groups }
  objCache.set(file, o)
  return o
}

for (const specFile of process.argv.slice(2)) {
  const spec = JSON.parse(readFileSync(specFile, 'utf8')) as Spec
  const base = spec.base ?? dirname(specFile)
  const at = (p: string) => (isAbsolute(p) ? p : join(base, p))
  const items: RenderItem[] = spec.items.map((it) => {
    if (it.obj) {
      const o = readObj(at(it.obj))
      const idx: number[] = []
      for (const [g, f] of o.groups) {
        if (it.groups && !it.groups.includes(g)) continue
        if (it.notGroups && it.notGroups.includes(g)) continue
        for (const i of f) idx.push(i)
      }
      return { positions: o.positions, indices: Uint32Array.from(idx), color: it.color }
    }
    return { positions: Float32Array.from(it.positions ?? []), indices: Uint32Array.from(it.indices ?? []), color: it.color }
  })
  const imgs = spec.views.map((v) => render((v.items ? v.items.map((i) => items[i]!) : items).filter((i) => i.indices.length), v, [245, 245, 245]))
  sheet(imgs, spec.columns ?? imgs.length).save(at(spec.out))
  console.log(at(spec.out))
}
