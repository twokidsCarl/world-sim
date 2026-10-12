// 皱纹细节层的运行时数据：读 detail.json / uv.bin / wrinkles.png，算各层权重。
// 公式与 tools/face/detail.ts（CPU 参考实现）一致；那个文件依赖 node:zlib，浏览器里不能直接引入，
// 所以这里重写了与数据有关的几小段，并在 tests/app-detail.test.ts 里逐项对照参考实现。
// Runtime data of the wrinkle detail layer: reads detail.json / uv.bin / wrinkles.png and computes
// the layer weights. The formulas are those of tools/face/detail.ts (the CPU reference); that file
// depends on node:zlib and cannot be imported in a browser, so the few data-facing pieces are
// rewritten here and checked against the reference item by item in tests/app-detail.test.ts.

import { fetchJson } from '../anatomy/load.ts'
import type { FaceDetail } from '../face/types.ts'
import type { AUs } from './face.ts'

const AU_MAX = 5
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

export interface LoadedDetail {
  data: FaceDetail
  /** 每个皮肤顶点的 (u, v)；没有细节的顶点为 NaN / (u, v) per skin vertex; NaN where a vertex takes no detail. */
  uv: Float32Array
  /** 有细节的皮肤顶点下标（升序）/ Skin vertex indices that take detail (ascending). */
  vertices: Uint32Array
  /** 图集的像素，RGBA8，第 0 行在图像顶部 / The atlas pixels, RGBA8, row 0 at the top of the image. */
  atlas: { width: number; height: number; data: Uint8Array }
}

/** 各层的权重，与 detail.layers 下标对应 / Weight of every layer, index-aligned with detail.layers. */
export function layerWeights(detail: Pick<FaceDetail, 'layers' | 'curve'>, aus: AUs, out: number[] = []): number[] {
  detail.layers.forEach((l, i) => {
    let w = 0
    for (const au in l.drivers) w += l.drivers[au]! * clamp((aus[au] ?? 0) / AU_MAX, 0, 1) ** detail.curve.gamma
    out[i] = clamp(w, 0, 1)
  })
  out.length = detail.layers.length
  return out
}

/** 读 uv.bin：count × uint32 顶点下标，随后 count × 2 × uint16 / Decodes uv.bin: count × uint32 vertex indices, then count × 2 × uint16. */
export function readUv(detail: Pick<FaceDetail, 'uv' | 'vertexCount'>, bin: Uint8Array): { uv: Float32Array; vertices: Uint32Array } {
  const n = detail.uv.count
  if (bin.length < n * 8) throw new Error(`uv.bin 比 detail.json 声明的短 / uv.bin is shorter than detail.json says (${bin.length} < ${n * 8})`)
  const uv = new Float32Array(detail.vertexCount * 2).fill(NaN)
  const vertices = new Uint32Array(n)
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  for (let i = 0; i < n; i++) {
    const v = dv.getUint32(i * 4, true)
    if (v >= detail.vertexCount) throw new Error('uv.bin 里的顶点下标超出皮肤顶点数 / a vertex index in uv.bin is beyond the skin')
    vertices[i] = v
    uv[v * 2] = dv.getUint16(n * 4 + i * 4, true) / 65535
    uv[v * 2 + 1] = dv.getUint16(n * 4 + i * 4 + 2, true) / 65535
  }
  return { uv, vertices }
}

async function inflate(z: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([z as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * 解码 8 位 RGB、非隔行的 PNG，得到 RGBA8。自己解而不走 <img> / canvas：那条路可能做色彩管理，
 * 而这张图是线性数据（法线），一个数都不能变。
 * Decodes an 8-bit RGB, non-interlaced PNG to RGBA8. Decoded here rather than through <img> /
 * canvas: that route may colour-manage, and this image is linear data (normals) of which not one
 * value may change.
 */
export async function decodePngRgb(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 8, width = 0, height = 0
  const idat: Uint8Array[] = []
  while (o + 8 <= bytes.length) {
    const len = dv.getUint32(o)
    const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!)
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8)
      height = dv.getUint32(o + 12)
      if (bytes[o + 16] !== 8 || bytes[o + 17] !== 2 || bytes[o + 20] !== 0) throw new Error('皱纹图集只支持 8 位 RGB、非隔行的 PNG / the wrinkle atlas must be an 8-bit RGB, non-interlaced PNG')
    } else if (type === 'IDAT') idat.push(bytes.subarray(o + 8, o + 8 + len))
    o += 12 + len
  }
  const z = new Uint8Array(idat.reduce((s, c) => s + c.length, 0))
  let p = 0
  for (const c of idat) {
    z.set(c, p)
    p += c.length
  }
  const raw = await inflate(z)
  const stride = width * 3
  if (raw.length < (stride + 1) * height) throw new Error('皱纹图集的数据不完整 / the wrinkle atlas is truncated')
  const line = new Uint8Array(stride), prev = new Uint8Array(stride)
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? line[x - 3]! : 0, b = prev[x]!, c = x >= 3 ? prev[x - 3]! : 0
      let v = raw[src + x]!
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[x] = v & 255
    }
    for (let x = 0, q = y * width * 4; x < stride; x += 3, q += 4) {
      data[q] = line[x]!
      data[q + 1] = line[x + 1]!
      data[q + 2] = line[x + 2]!
      data[q + 3] = 255
    }
    prev.set(line)
  }
  return { width, height, data }
}

/** 校验三个文件相互一致 / Check that the three files agree with each other. */
export function checkDetail(data: FaceDetail, uvBin: Uint8Array, atlas: { width: number; height: number; data: Uint8Array }): LoadedDetail {
  if (data?.schema !== 1 || !Array.isArray(data.layers) || !data.uv || !data.atlas) throw new Error('detail.json 不是 FaceDetail / detail.json is not a FaceDetail')
  if (atlas.width !== data.atlas.width || atlas.height !== data.atlas.height) throw new Error('皱纹图集的尺寸与 detail.json 不符 / the atlas size does not match detail.json')
  const T = data.atlas.tile
  for (const l of data.layers) {
    if ((l.tile[0] + 1) * T > atlas.width || (l.tile[1] + 1) * T > atlas.height) throw new Error(`细节层 ${l.id} 的格子在图集之外 / the tile of layer ${l.id} is outside the atlas`)
  }
  return { data, ...readUv(data, uvBin), atlas }
}

/** 细节层三个文件；这副人体没有时为 null / The three files of the detail layer; null when this body has none. */
export async function loadDetail(baseUrl: string): Promise<LoadedDetail | null> {
  const data = await fetchJson<FaceDetail>(`${baseUrl}face/detail.json`)
  if (!data) return null
  const [uv, png] = await Promise.all([fetch(`${baseUrl}face/${data.uv.file}`), fetch(`${baseUrl}face/${data.atlas.file}`)])
  if (!uv.ok || !png.ok) return null
  return checkDetail(data, new Uint8Array(await uv.arrayBuffer()), await decodePngRgb(new Uint8Array(await png.arrayBuffer())))
}
