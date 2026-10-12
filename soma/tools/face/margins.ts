// 读取皮肤包清单里的睑缘、唇缘顶点环（可选）。皮肤包不在仓库里，所以没有它时一切照旧。
// Reads the lid-margin and lip-margin vertex loops from the skin package manifest (optional). The package is not in the
// repository, so everything works unchanged without it.
//
// 约定（提议，待皮肤的作者确认）：manifest.face.margins 是 { 名称: 顶点下标数组 }，下标按 skin.obj 的原始顺序，
// 名称为 upperLip、lowerLip、upperLidL、lowerLidL、upperLidR、lowerLidR。发布的皮肤重新编过号，所以按位置对应
// （0.05 mm 内）。目前只读出并写进构建报告；位移场还没有用它们。
// Convention (proposed, to be confirmed by the skin's author): manifest.face.margins is { name: vertex index array }, indices
// in the original order of skin.obj, names upperLip, lowerLip, upperLidL, lowerLidL, upperLidR, lowerLidR. The shipped skin is
// re-indexed, so vertices are matched by position (within 0.05 mm). For now they are only read and written into the build
// report; the displacement fields do not use them yet.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const MARGIN_NAMES = ['upperLip', 'lowerLip', 'upperLidL', 'lowerLidL', 'upperLidR', 'lowerLidR'] as const
export type MarginName = (typeof MARGIN_NAMES)[number]
export interface Margins {
  /** 发布的皮肤里的顶点下标，按环的顺序 / vertex indices in the shipped skin, in loop order. */
  loops: Partial<Record<MarginName, number[]>>
  /** 没能按位置对应上的顶点数 / vertices that could not be matched by position. */
  unmatched: number
}

export function readMargins(root: string, bodyId: string, shipped: Float32Array): Margins | null {
  const dir = join(root, 'data', 'raw', 'bodyshape', 'out', `${bodyId}-skin`)
  const manifestPath = join(dir, 'manifest.json'), objPath = join(dir, 'skin.obj')
  if (!existsSync(manifestPath) || !existsSync(objPath)) return null
  const margins = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { face?: { margins?: Record<string, unknown> } }).face?.margins
  if (!margins) return null
  const src: number[] = []
  for (const l of readFileSync(objPath, 'utf8').split('\n')) {
    if (!l.startsWith('v ')) continue
    const a = l.split(/\s+/)
    src.push(+a[1]!, +a[2]!, +a[3]!)
  }
  // 发布的顶点按 0.05 mm 的格子建索引 / the shipped vertices indexed on a 0.05 mm grid
  const key = (x: number, y: number, z: number): string => `${Math.round(x * 20000)},${Math.round(y * 20000)},${Math.round(z * 20000)}`
  const grid = new Map<string, number>()
  for (let v = 0; v < shipped.length / 3; v++) grid.set(key(shipped[v * 3]!, shipped[v * 3 + 1]!, shipped[v * 3 + 2]!), v)
  const out: Margins = { loops: {}, unmatched: 0 }
  for (const name of MARGIN_NAMES) {
    const list = margins[name]
    if (!Array.isArray(list)) continue
    const loop: number[] = []
    for (const i of list as number[]) {
      const x = src[i * 3]!, y = src[i * 3 + 1]!, z = src[i * 3 + 2]!
      let hit: number | undefined
      for (const dx of [0, -0.00005, 0.00005]) for (const dy of [0, -0.00005, 0.00005]) for (const dz of [0, -0.00005, 0.00005]) hit ??= grid.get(key(x + dx, y + dy, z + dz))
      if (hit === undefined) out.unmatched++
      else loop.push(hit)
    }
    out.loops[name] = loop
  }
  return out
}
