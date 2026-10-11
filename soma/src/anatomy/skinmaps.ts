// 体表图（皮节、皮神经分布区）：解析、按三角形取区域、与图谱概念互查。纯数据，不依赖 three.js。
// Skin maps (dermatomes, cutaneous nerve territories): decoding, per-triangle regions and
// lookups against the ontology. Pure data, no three.js.

import type { AnatomyGraph } from './graph.ts'
import { fetchJson } from './load.ts'
import type { SkinMap, SkinMaps } from './types.ts'

/** 未分配区域的索引值 / Region index meaning "unassigned". */
export const SKIN_UNASSIGNED = 255

export type SkinMapId = SkinMap['id']

/** 已解码的一张体表图：元数据加每个皮肤顶点一个区域索引。 */
/** One decoded skin map: its metadata plus one region index per skin vertex. */
export interface LoadedSkinMap extends SkinMap {
  data: Uint8Array
}

export interface LoadedSkinMaps {
  /** 体表图所绘制的皮肤部件 id / Part.id of the skin part the maps are painted on. */
  part: string
  vertexCount: number
  maps: LoadedSkinMap[]
}

/**
 * 校验并解码 skinmaps.json + skinmaps.bin；数据不自洽时抛出带说明的错误。
 * Validate and decode skinmaps.json + skinmaps.bin; throws a descriptive error when the
 * two files do not agree.
 */
export function decodeSkinMaps(json: SkinMaps, bin: ArrayBuffer): LoadedSkinMaps {
  if (!json || typeof json.part !== 'string' || !Number.isInteger(json.vertexCount) || !Array.isArray(json.maps)) {
    throw new Error('skinmaps.json: 结构不符合约定 / not a SkinMaps document')
  }
  const bytes = new Uint8Array(bin)
  const maps: LoadedSkinMap[] = []
  for (const m of json.maps) {
    if (!Array.isArray(m.regions) || m.regions.length === 0 || m.regions.length > SKIN_UNASSIGNED) {
      throw new Error(`skinmaps.json: 体表图 ${m.id} 的区域数无效 / map ${m.id} has an invalid region count`)
    }
    if (m.offset < 0 || m.offset + json.vertexCount > bytes.length) {
      throw new Error(`skinmaps.bin: 体表图 ${m.id} 超出文件范围 / map ${m.id} runs past the end of the file`)
    }
    const data = bytes.subarray(m.offset, m.offset + json.vertexCount)
    for (let i = 0; i < data.length; i++) {
      const r = data[i]!
      if (r !== SKIN_UNASSIGNED && r >= m.regions.length) {
        throw new Error(`skinmaps.bin: 体表图 ${m.id} 顶点 ${i} 的区域索引 ${r} 越界 / region index out of range`)
      }
    }
    maps.push({ ...m, data })
  }
  return { part: json.part, vertexCount: json.vertexCount, maps }
}

/**
 * 读取某个人体的体表图；该人体没有体表图时返回 null。
 * Fetch a body's skin maps; null when the body has none.
 */
export async function loadSkinMaps(baseUrl: string): Promise<LoadedSkinMaps | null> {
  const json = await fetchJson<SkinMaps>(`${baseUrl}skinmaps.json`)
  if (!json) return null
  const res = await fetch(`${baseUrl}skinmaps.bin`)
  if (!res.ok) return null
  return decodeSkinMaps(json, await res.arrayBuffer())
}

/**
 * 三角形的区域：三个顶点中占多数的区域；三个都不同时取第一个顶点的。
 * Region of a triangle: the majority of its three vertices; the first vertex when all differ.
 */
export function triangleRegion(data: Uint8Array, a: number, b: number, c: number): number {
  const ra = data[a] ?? SKIN_UNASSIGNED
  const rb = data[b] ?? SKIN_UNASSIGNED
  const rc = data[c] ?? SKIN_UNASSIGNED
  return rb === rc ? rb : ra
}

/**
 * 每个三角形一个区域索引（按索引缓冲的三角形顺序）。
 * One region index per triangle, in index-buffer order.
 */
export function triangleRegions(index: ArrayLike<number>, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.floor(index.length / 3))
  for (let t = 0; t < out.length; t++) out[t] = triangleRegion(data, index[t * 3]!, index[t * 3 + 1]!, index[t * 3 + 2]!)
  return out
}

/**
 * 区域的支配结构在当前人体中对应的部件（脊神经节 / 神经根 / 皮神经）。
 * Parts in this body for the structure supplying a region (spinal ganglion / root / nerve).
 */
export function regionParts(graph: AnatomyGraph, map: SkinMap, region: number): readonly string[] {
  const concept = map.regions[region]?.concept
  return concept ? graph.resolveFma(concept) : []
}

export interface SkinRegionRef {
  map: SkinMapId
  region: number
}

/**
 * 反查：这些部件（神经、神经根）支配哪些皮肤区域。
 * Reverse lookup: the skin regions supplied by any of these parts (nerves, spinal roots).
 */
export function regionsForParts(graph: AnatomyGraph, maps: LoadedSkinMaps, partIds: Iterable<string>): SkinRegionRef[] {
  const wanted = new Set(partIds)
  if (wanted.size === 0) return []
  const out: SkinRegionRef[] = []
  for (const m of maps.maps) {
    m.regions.forEach((r, i) => {
      if (!r.concept) return
      for (const id of graph.resolveFma(r.concept)) {
        if (wanted.has(id)) {
          out.push({ map: m.id, region: i })
          return
        }
      }
    })
  }
  return out
}

/** 每个区域的顶点数（图例显示覆盖面用）/ Vertex count per region, for the legend. */
export function regionVertexCounts(map: LoadedSkinMap): number[] {
  const counts = new Array<number>(map.regions.length).fill(0)
  for (let i = 0; i < map.data.length; i++) {
    const r = map.data[i]!
    if (r !== SKIN_UNASSIGNED) counts[r]!++
  }
  return counts
}
