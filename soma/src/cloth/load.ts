// 读穿好的衣服（public/anatomy/<body>/cloth/<garment>.{json,bin}，格式见 tools/cloth/output.ts）。
// Reads dressed garments (public/anatomy/<body>/cloth/<garment>.{json,bin}; the format is in tools/cloth/output.ts).

import { fetchJson } from '../anatomy/load.ts'
import type { GarmentId } from './garments.ts'

export { GARMENTS, parseWear, type GarmentId } from './garments.ts'

interface BufferInfo {
  offset: number
  count: number
  type: 'f32' | 'u32' | 'u16' | 'u8' | 'i8'
  itemSize: number
}

export interface ClothData {
  schema: number
  body: string
  garment: GarmentId
  skin: string
  skinVertexCount: number
  skinTriangleCount: number
  vertexCount: number
  triangleCount: number
  fabric: { id: string; density: number; stretchWarp: number; stretchWeft: number; shear: number; bending: number; thickness: number; friction: number }
  panels: { name: string; part: string; front: boolean; offset: number; count: number }[]
  edgeKinds: string[]
  buffers: Record<'position' | 'uv' | 'index' | 'stitch' | 'bindVert' | 'bindBary' | 'bindOffset' | 'edgeKind' | 'panel', BufferInfo> & { attach?: BufferInfo }
}

export interface LoadedCloth {
  data: ClothData
  position: Float32Array
  uv: Float32Array
  index: Uint32Array
  stitch: Uint32Array
  /** 每个顶点绑定的皮肤三角形的三个皮肤顶点 / The three skin vertices of each vertex's bound triangle. */
  bindVert: Uint32Array
  bindBary: Float32Array
  bindOffset: Float32Array
  /** 1 = 绑在皮肤上（运行时跟着皮肤走）/ 1 = bound to the skin (moved with it at run time) */
  attach: Uint8Array
  edgeKind: Int8Array
  panel: Uint8Array
}

function view(bin: ArrayBuffer, b: BufferInfo): Float32Array | Uint32Array | Uint16Array | Uint8Array | Int8Array {
  const C = { f32: Float32Array, u32: Uint32Array, u16: Uint16Array, u8: Uint8Array, i8: Int8Array }[b.type]
  return new C(bin, b.offset, b.count)
}

/** 解码；长度或下标不对就抛错 / Decode; throws on a wrong length or index. */
export function decodeCloth(data: ClothData, bin: ArrayBuffer): LoadedCloth {
  const b = data.buffers
  const n = data.vertexCount
  for (const [k, info] of Object.entries(b)) {
    const size = info.type === 'f32' || info.type === 'u32' ? 4 : info.type === 'u16' ? 2 : 1
    if (info.offset + info.count * size > bin.byteLength) throw new Error(`cloth ${data.garment}: buffer ${k} runs past the end of the file`)
  }
  const index = Uint32Array.from(view(bin, b.index))
  const bindVert = Uint32Array.from(view(bin, b.bindVert))
  if (index.length !== data.triangleCount * 3 || bindVert.length !== n * 3) throw new Error(`cloth ${data.garment}: counts do not match`)
  for (let i = 0; i < index.length; i++) if (index[i]! >= n) throw new Error(`cloth ${data.garment}: triangle corner ${i} points beyond the mesh`)
  for (let i = 0; i < n * 3; i++) if (bindVert[i]! >= data.skinVertexCount) throw new Error(`cloth ${data.garment}: vertex ${i} is bound beyond the skin`)
  return {
    data,
    position: Float32Array.from(view(bin, b.position)),
    uv: Float32Array.from(view(bin, b.uv)),
    index,
    stitch: Uint32Array.from(view(bin, b.stitch)),
    bindVert,
    bindBary: Float32Array.from(view(bin, b.bindBary)),
    bindOffset: Float32Array.from(view(bin, b.bindOffset)),
    attach: b.attach ? Uint8Array.from(view(bin, b.attach)) : new Uint8Array(n),
    edgeKind: Int8Array.from(view(bin, b.edgeKind)),
    panel: Uint8Array.from(view(bin, b.panel)),
  }
}

/** 取一件衣服；这副人体没有它时返回 null / Fetch one garment; null when the body has none. */
export async function loadCloth(dataset: string, garment: GarmentId): Promise<LoadedCloth | null> {
  const base = `${import.meta.env.BASE_URL}anatomy/${dataset}/cloth/`
  const data = await fetchJson<ClothData>(`${base}${garment}.json`).catch(() => null)
  if (!data || data.schema !== 1) return null
  const res = await fetch(`${base}${garment}.bin`)
  if (!res.ok) return null
  return decodeCloth(data, await res.arrayBuffer())
}
