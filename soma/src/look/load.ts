// 读写实皮肤的 UV 网格（look/skin-uv.json + .bin，格式见 types.ts）。
// Reads the UV mesh of the lifelike skin (look/skin-uv.json + .bin; the format is in types.ts).

import { fetchJson } from '../anatomy/load.ts'
import { decodePngRgba } from './png.ts'
import { type SkinColourData, type SkinUvData, UV_SCALE } from './types.ts'

export interface LoadedSkinUv {
  data: SkinUvData
  /** 覆盖网格顶点 → 皮肤顶点 / overlay vertex → skin vertex */
  skinVertex: Uint32Array
  /** 每个覆盖网格顶点的 (u, v)，v 向上 / (u, v) per overlay vertex, v up */
  uv: Float32Array
  /** 三角形（覆盖网格顶点下标），与皮肤的三角形一一对应 / triangles (overlay vertex indices), one to one with the skin's */
  index: Uint32Array
  /** 颜色数据（查找表和部位贴图）；没有或坏了是 null，材质退回均匀底色 / the colour data (table and region map); null when absent or broken, and the material falls back to a uniform albedo */
  colour?: LoadedSkinColour | null
}

export interface LoadedSkinColour {
  data: SkinColourData
  /** 查找表，RGBA half-float 位模式 / the table, RGBA half-float bit patterns */
  lut: Uint16Array
  /** 部位贴图 RGBA8，第 0 行是 v = 0 / the region map, RGBA8, row 0 is v = 0 */
  regions: { width: number; height: number; data: Uint8Array }
}

/** 核对颜色数据的尺寸；不对就抛错 / Check the sizes of the colour data; throws when they are wrong. */
export function checkSkinColour(data: SkinColourData, lutBin: Uint8Array, regions: { width: number; height: number; data: Uint8Array }): LoadedSkinColour {
  if (data?.schema !== 1 || !data.lut || !data.regions || !data.tone) throw new Error('skin-colour.json 不是 SkinColourData / skin-colour.json is not a SkinColourData')
  const n = data.lut.size
  if (lutBin.byteLength !== n * n * 8) throw new Error(`skin-lut.bin has ${lutBin.byteLength} bytes, ${n}×${n} RGBA half-float needs ${n * n * 8}`)
  if (regions.width !== data.regions.size || regions.height !== data.regions.size) throw new Error(`skin-regions.png is ${regions.width}×${regions.height}, skin-colour.json says ${data.regions.size}`)
  const lut = new Uint16Array(lutBin.slice().buffer)
  return { data, lut, regions }
}

/** 取一个人体的皮肤颜色数据；没有时返回 null / Fetch a body's skin colour data; null when it has none. */
export async function loadSkinColour(dataset: string): Promise<LoadedSkinColour | null> {
  const base = `${import.meta.env.BASE_URL}anatomy/${dataset}/look/`
  const data = await fetchJson<SkinColourData>(`${base}skin-colour.json`).catch(() => null)
  if (!data || data.schema !== 1) return null
  const [lut, png] = await Promise.all([fetch(`${base}${data.lut.file}`), fetch(`${base}${data.regions.file}`)])
  if (!lut.ok || !png.ok) return null
  return checkSkinColour(data, new Uint8Array(await lut.arrayBuffer()), await decodePngRgba(new Uint8Array(await png.arrayBuffer())))
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

/**
 * 取一个人体的写实皮肤 UV 和颜色数据；没有 UV 时返回 null。颜色数据是附加的：坏了只告警，UV 照用。
 * Fetch a body's lifelike-skin UVs and colour data; null when it has no UVs. The colour data are an extra:
 * when broken they only warn and the UVs are still used.
 */
export async function loadSkinUv(dataset: string): Promise<LoadedSkinUv | null> {
  const base = `${import.meta.env.BASE_URL}anatomy/${dataset}/look/`
  const colour = loadSkinColour(dataset).catch((e: unknown) => {
    console.warn('[soma] lifelike skin colour unavailable:', e)
    return null
  })
  const data = await fetchJson<SkinUvData>(`${base}skin-uv.json`).catch(() => null)
  if (!data || data.schema !== 1) return null
  const res = await fetch(`${base}skin-uv.bin`)
  if (!res.ok) return null
  const uv = decodeSkinUv(data, new Uint8Array(await res.arrayBuffer()))
  uv.colour = await colour
  if (uv.colour && uv.colour.data.skin !== data.skin) {
    console.warn(`[soma] lifelike skin colour is for ${uv.colour.data.skin}, the UVs for ${data.skin}: not used`)
    uv.colour = null
  }
  return uv
}
