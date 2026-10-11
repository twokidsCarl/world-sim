// 外部提供的蒙皮权重：某个部件（例如换用 MHR 拓扑的新皮肤）自带按别的骨架给出的关节权重时，
// 把那些关节映射到本骨架的关节，直接用作该部件的绑定，而不再由距离场计算。
// Externally supplied skin weights: when a part (for example the replacement skin in MHR topology)
// comes with joint weights for another skeleton, those joints are mapped to the joints of this
// rig and used as the part's binding directly, instead of weights from the distance field.
//
// 目录格式（data/raw/bodyshape/out/<body>-skin/）/ directory layout:
//   weights.bin   记录 (uint32 顶点, uint32 关节, float32 权重)，小端 / records (uint32 vertex, uint32 joint, float32 weight), little endian
//   joints.json   names、parents、mapping[i].anatomical = 本骨架的关节 id 或 null / this rig's joint id, or null
//   manifest.json 顶点数见 files["skin.obj"] 的说明 / the vertex count is stated under files["skin.obj"]

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ExternalWeights {
  dir: string
  vertexCount: number
  /** 每个顶点：本骨架的关节下标 → 权重（和为 1）。 Per vertex: joint index of this rig → weight (summing to 1). */
  rows: Map<number, number>[]
  /** 外部关节各自落到了本骨架的哪个关节。 Which joint of this rig every external joint was mapped to. */
  mapped: { external: string; joint: string; how: 'mapping' | 'parent' }[]
  notes: string[]
}

interface JointsFile {
  names: string[]
  parents: number[]
  mapping: { mhr?: string; anatomical: string | null }[]
}

/** 读入外部权重并映射到本骨架；目录不存在时返回 null。 Reads external weights and maps them onto this rig; null when the directory is absent. */
export function loadExternalWeights(dir: string, jointIds: string[]): ExternalWeights | null {
  const wp = join(dir, 'weights.bin'), jp = join(dir, 'joints.json')
  if (!existsSync(wp) || !existsSync(jp)) return null
  const jf = JSON.parse(readFileSync(jp, 'utf8')) as JointsFile
  const index = new Map(jointIds.map((id, i) => [id, i]))
  const notes: string[] = []
  // 外部关节 → 本骨架关节：先用 mapping；没有映射（扭转辅助骨、末端节点）或 id 不认识的，沿父关节向上找
  // external joint → joint of this rig: the mapping first; joints without one (twist helpers, end nodes) or with an unknown id climb to their parent
  const target = new Int32Array(jf.names.length).fill(-2)
  const how: ('mapping' | 'parent')[] = jf.names.map(() => 'parent')
  const resolve = (i: number, depth: number): number => {
    if (target[i]! !== -2) return target[i]!
    const a = jf.mapping[i]?.anatomical ?? null
    let t = -1
    if (a !== null && index.has(a)) {
      t = index.get(a)!
      how[i] = 'mapping'
    } else {
      if (a !== null) notes.push(`external joint ${jf.names[i]}: mapped to "${a}", which is not a joint of this rig; its parent's joint is used`)
      const p = jf.parents[i]!
      t = p >= 0 && depth < jf.names.length ? resolve(p, depth + 1) : -1
    }
    target[i] = t
    return t
  }
  jf.names.forEach((_, i) => resolve(i, 0))
  const buf = readFileSync(wp)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const records = Math.floor(buf.byteLength / 12)
  let vertexCount = 0
  for (let r = 0; r < records; r++) vertexCount = Math.max(vertexCount, dv.getUint32(r * 12, true) + 1)
  const rows: Map<number, number>[] = Array.from({ length: vertexCount }, () => new Map<number, number>())
  let dropped = 0
  for (let r = 0; r < records; r++) {
    const v = dv.getUint32(r * 12, true), j = dv.getUint32(r * 12 + 4, true), w = dv.getFloat32(r * 12 + 8, true)
    const t = target[j] ?? -1
    if (t < 0 || !(w > 0)) {
      if (w > 0) dropped += w
      continue
    }
    rows[v]!.set(t, (rows[v]!.get(t) ?? 0) + w)
  }
  let empty = 0
  for (const row of rows) {
    let s = 0
    for (const w of row.values()) s += w
    if (s <= 0) empty++
    else for (const [j, w] of row) row.set(j, w / s)
  }
  if (dropped > 0) notes.push(`external weights: total weight ${dropped.toFixed(1)} on joints with no counterpart in this rig was dropped and the rest renormalised`)
  if (empty > 0) notes.push(`external weights: ${empty} vertices have no usable weight (filled from their neighbours)`)
  return {
    dir, vertexCount, rows, notes,
    mapped: jf.names.flatMap((n, i) => (target[i]! >= 0 ? [{ external: n, joint: jointIds[target[i]!]!, how: how[i]! }] : [])),
  }
}
