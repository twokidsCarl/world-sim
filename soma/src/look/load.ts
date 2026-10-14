// 读写实皮肤的 UV 网格（look/skin-uv.json + .bin，格式见 types.ts）。
// Reads the UV mesh of the lifelike skin (look/skin-uv.json + .bin; the format is in types.ts).

import { fetchJson } from '../anatomy/load.ts'
import { type SkinUvData, UV_SCALE } from './types.ts'

export interface LoadedSkinUv {
  data: SkinUvData
  /** 覆盖网格顶点 → 皮肤顶点 / overlay vertex → skin vertex */
  skinVertex: Uint32Array
  /** 每个覆盖网格顶点的 (u, v)，v 向上 / (u, v) per overlay vertex, v up */
  uv: Float32Array
  /** 三角形（覆盖网格顶点下标），与皮肤的三角形一一对应 / triangles (overlay vertex indices), one to one with the skin's */
  index: Uint32Array
}

/** 解码 .bin；长度或下标不对就抛错 / Decode the .bin; throws on a wrong length or index. */
export function decodeSkinUv(data: SkinUvData, bin: Uint8Array): LoadedSkinUv {
  const n = data.vertexCount
  const expected = n * 8 + data.triangleCount * 12
  if (bin.byteLength !== expected) throw new Error(`skin-uv.bin has ${bin.byteLength} bytes, skin-uv.json implies ${expected}`)
  if (data.triangleCount !== data.skinTriangleCount) throw new Error('skin-uv: the triangles must match the skin one to one')
  const copy = bin.slice()
  const skinVertex = new Uint32Array(copy.buffer, 0, n)
  const q = new Uint16Array(copy.buffer, n * 4, n * 2)
  const index = new Uint32Array(copy.buffer, n * 8, data.triangleCount * 3)
  for (let i = 0; i < n; i++) if (skinVertex[i]! >= data.skinVertexCount) throw new Error(`skin-uv: vertex ${i} points beyond the skin`)
  for (let i = 0; i < index.length; i++) if (index[i]! >= n) throw new Error(`skin-uv: triangle corner ${i} points beyond the overlay`)
  const uv = new Float32Array(n * 2)
  for (let i = 0; i < n * 2; i++) uv[i] = q[i]! / UV_SCALE
  return { data, skinVertex, uv, index }
}

/** 取一个人体的写实皮肤 UV；没有这份数据时返回 null / Fetch a body's lifelike-skin UVs; null when it has none. */
export async function loadSkinUv(dataset: string): Promise<LoadedSkinUv | null> {
  const base = `${import.meta.env.BASE_URL}anatomy/${dataset}/look/`
  const data = await fetchJson<SkinUvData>(`${base}skin-uv.json`).catch(() => null)
  if (!data || data.schema !== 1) return null
  const res = await fetch(`${base}skin-uv.bin`)
  if (!res.ok) return null
  return decodeSkinUv(data, new Uint8Array(await res.arrayBuffer()))
}
