// 面部表情层的运行时：加载 face.json / face.bin，按 AU 强度计算各部件在静止空间里的顶点位移。纯数据，不依赖 three.js。
// Runtime of the facial expression layer: load face.json / face.bin and compute each part's
// rest-space vertex displacement from AU intensities. Pure data, no three.js.
//
// 这是疼痛行为（面部表情）的计算模型，用于教学；被模拟的身体没有主观体验。
// This is a computational model of pain behaviour (the facial expression) for teaching; the
// simulated body has no subjective experience.
//
// 公式与 tools/face/model.ts 的参考实现相同（AU → 通道激活 → 位移之和）；这里只是把每个部件
// 用到的稀疏场预先解码好，逐帧求和时不再解析二进制。
// Same formula as the reference in tools/face/model.ts (AUs → channel activations → sum of
// displacements); the sparse fields of each part are merely decoded once so the per-frame sum
// does not parse binary data.

import { activations, readField, type AUs, type Activations } from '../../tools/face/model.ts'
import { fetchJson } from '../anatomy/load.ts'
import type { FaceData } from '../face/types.ts'

export type { AUs, Activations }
export { activations }

interface PartField {
  channel: string
  index: Uint32Array
  delta: Float32Array
}

export interface LoadedFace {
  data: FaceData
  bin: Uint8Array
  /** 部件 id → 作用在它上面的各通道位移场 / Part id → the channel fields acting on it. */
  fields: Map<string, PartField[]>
  /** 部件 id → face.json 声明的顶点数 / Part id → the vertex count face.json declares. */
  vertexCount: Map<string, number>
}

/** 把 face.json + face.bin 整理成按部件索引的形式；数据不自洽时抛错。 */
/** Index face.json + face.bin by part; throws when the two do not agree. */
export function indexFace(data: FaceData, bin: Uint8Array): LoadedFace {
  if (!data || !Array.isArray(data.channels) || !Array.isArray(data.aus) || !Array.isArray(data.parts)) {
    throw new Error('face.json: 结构不符合约定 / not a FaceData document')
  }
  const vertexCount = new Map(data.parts.map((p) => [p.part, p.vertexCount]))
  const fields = new Map<string, PartField[]>()
  for (const ch of data.channels) {
    for (const f of ch.fields) {
      const n = vertexCount.get(f.part)
      if (n === undefined) throw new Error(`face.json: 通道 ${ch.id} 引用了未列出的部件 ${f.part} / channel refers to an unlisted part`)
      if (f.offset < 0 || f.offset + f.count * 10 > bin.length) throw new Error(`face.bin: 通道 ${ch.id} 的场超出文件范围 / field runs past the end of the file`)
      const { index, delta } = readField(bin, f)
      for (let i = 0; i < index.length; i++) {
        if (index[i]! >= n) throw new Error(`face.bin: 通道 ${ch.id} 在部件 ${f.part} 上的顶点下标越界 / vertex index out of range`)
      }
      const list = fields.get(f.part)
      if (list) list.push({ channel: ch.id, index, delta })
      else fields.set(f.part, [{ channel: ch.id, index, delta }])
    }
  }
  return { data, bin, fields, vertexCount }
}

/** 读取某个人体的表情数据；没有则返回 null。 Fetch a body's expression data; null when it has none. */
export async function loadFace(baseUrl: string): Promise<LoadedFace | null> {
  const data = await fetchJson<FaceData>(`${baseUrl}face.json`)
  if (!data) return null
  const res = await fetch(`${baseUrl}face.bin`)
  if (!res.ok) return null
  return indexFace(data, new Uint8Array(await res.arrayBuffer()))
}

/**
 * 一个部件变形后的静止位置：out = rest + Σ_c a_c · D_c。返回是否有任何通道在起作用。
 * A part's displaced rest positions: out = rest + Σ_c a_c · D_c. Returns whether any channel was active.
 */
export function displacePart(face: LoadedFace, part: string, rest: Float32Array, act: Activations, out: Float32Array): boolean {
  out.set(rest)
  let any = false
  for (const f of face.fields.get(part) ?? []) {
    const a = Math.min(1, Math.max(0, act[f.channel] ?? 0))
    if (a === 0) continue
    any = true
    const { index, delta } = f
    for (let i = 0; i < index.length; i++) {
      const v = index[i]! * 3
      out[v] = out[v]! + a * delta[i * 3]!
      out[v + 1] = out[v + 1]! + a * delta[i * 3 + 1]!
      out[v + 2] = out[v + 2]! + a * delta[i * 3 + 2]!
    }
  }
  return any
}

/** AU 强度的规范化：只留 0–5 之间的非零值，键按升序 / Normalise AU intensities: non-zero values within 0–5, keys sorted. */
export function cleanAUs(aus: AUs): AUs {
  const out: AUs = {}
  for (const id of Object.keys(aus).sort()) {
    const v = Math.min(5, Math.max(0, aus[id] ?? 0))
    if (v > 1e-4) out[id] = v
  }
  return out
}

/** 两组 AU 逐项取较大者 / The element-wise maximum of two AU sets. */
export function maxAUs(a: AUs, b: AUs): AUs {
  const out: AUs = { ...a }
  for (const [id, v] of Object.entries(b)) out[id] = Math.max(out[id] ?? 0, v)
  return out
}

/** 判断两组 AU 是否足够接近（免得每帧重算）/ Whether two AU sets are close enough to skip recomputing. */
export function sameAUs(a: AUs, b: AUs, eps = 2e-3): boolean {
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) if (Math.abs((a[id] ?? 0) - (b[id] ?? 0)) > eps) return false
  return true
}
