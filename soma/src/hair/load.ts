// 取毛发数据：hair.json、各发片的 .bin、贴图集。只在写实外观显示时才取（由 HairLayer 触发）。
// Fetching the hair data: hair.json, each piece's .bin, the atlas. Fetched only once the lifelike look shows (HairLayer triggers it).

import { fetchJson } from '../anatomy/load.ts'
import type { HairData, HairPieceId } from '../look/types.ts'

// `base`：这副人体的 hair/ 目录的地址（以 / 结尾）/ `base`: the address of this body's hair/ directory (ending in /)

/** 说明文件；没有或版本不对返回 null / the description; null when absent or of another schema */
export async function loadHairData(base: string): Promise<HairData | null> {
  const data = await fetchJson<HairData>(`${base}hair.json`).catch(() => null)
  return data && data.schema === 1 ? data : null
}

export async function loadPiece(base: string, data: HairData, id: HairPieceId): Promise<Uint8Array | null> {
  const piece = data.pieces.find((p) => p.id === id)
  if (!piece) return null
  const res = await fetch(`${base}${piece.file}`)
  if (!res.ok) return null
  const bin = new Uint8Array(await res.arrayBuffer())
  if (bin.byteLength !== piece.bytes) throw new Error(`${piece.file} has ${bin.byteLength} bytes, hair.json says ${piece.bytes}`)
  return bin
}

/** 取一张图，原样解码（不预乘、不做色彩空间转换：通道里存的是数据）/ fetch an image decoded as is (no premultiplication, no colour-space conversion: the channels hold data) */
export async function loadAtlasImage(base: string, file: string): Promise<ImageBitmap | null> {
  const res = await fetch(`${base}${file}`)
  if (!res.ok) return null
  return createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
}

/** 头皮底色的数据：顶点和离头皮边界的带符号距离（毫米）/ the scalp tint data: vertices and signed distance from the scalp border (mm) */
export async function loadScalp(base: string, data: HairData): Promise<{ vertices: Uint32Array; distance: Int8Array } | null> {
  const res = await fetch(`${base}${data.scalp.file}`)
  if (!res.ok) return null
  const bin = new Uint8Array(await res.arrayBuffer())
  const n = data.scalp.vertices
  if (bin.byteLength !== n * 5) throw new Error(`${data.scalp.file} has ${bin.byteLength} bytes, hair.json implies ${n * 5}`)
  const copy = bin.slice()
  return { vertices: new Uint32Array(copy.buffer, 0, n), distance: new Int8Array(copy.buffer, n * 4, n) }
}
