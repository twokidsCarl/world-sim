// 皱纹细节层的 CPU 参考实现：AU 强度 → 各层权重 → 合成的切线空间法线。
// CPU reference of the wrinkle detail layer: AU intensities → layer weights → the composite tangent-space normal.
//
// 运行时（片元着色器）应与这里一致。只依赖数据契约和 node:zlib（解 PNG；前端用浏览器自己的解码器即可）。
// The runtime (a fragment shader) should reproduce this. Depends only on the data contract and node:zlib
// (to decode the PNG; a frontend uses the browser's own decoder).
//
// 约定 / Conventions
//   · 层权重 w_l = clamp(Σ_AU drivers[AU] · (I_AU / 5)^gamma, 0, 1)。
//     Layer weight w_l = clamp(Σ_AU drivers[AU] · (I_AU / 5)^gamma, 0, 1).
//   · 每层的纹素存切线空间法线 n（rgb = n · 0.5 + 0.5）；合成时取斜率 g = n.xy / n.z 相加，再归一化：
//     n = normalize(Σ_l w_l · g_l, 1)。斜率相加等价于把各层的高度场按权重相加，所以是线性的。
//     Each layer's texel holds a tangent-space normal n (rgb = n · 0.5 + 0.5); layers are combined by adding the
//     slopes g = n.xy / n.z and renormalising: n = normalize(Σ_l w_l · g_l, 1). Adding slopes equals adding the
//     layers' height fields by weight, so the blend is linear.
//   · x 沿 u 增大的方向（身体左侧），y 沿 v 增大的方向（向上），z 沿表面法线向外。
//     x along increasing u (towards the body's left), y along increasing v (up), z out along the surface normal.

import { inflateSync } from 'node:zlib'
import type { FaceDetail } from '../../src/face/types.ts'
import { type AUs, AU_MAX } from './model.ts'

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/** 各层的权重，与 detail.layers 下标对应。 Weight of every layer, index-aligned with detail.layers. */
export function layerWeights(detail: Pick<FaceDetail, 'layers' | 'curve'>, aus: AUs): number[] {
  return detail.layers.map((l) => {
    let w = 0
    for (const [au, k] of Object.entries(l.drivers)) w += k * clamp((aus[au] ?? 0) / AU_MAX, 0, 1) ** detail.curve.gamma
    return clamp(w, 0, 1)
  })
}

/** 解码 8 位 RGB 的 PNG（不含隔行）。 Decodes an 8-bit RGB PNG (non-interlaced). */
export function decodePng(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 8, width = 0, height = 0
  const idat: Uint8Array[] = []
  while (o < bytes.length) {
    const len = dv.getUint32(o)
    const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!)
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8)
      height = dv.getUint32(o + 12)
      if (bytes[o + 16] !== 8 || bytes[o + 17] !== 2 || bytes[o + 20] !== 0) throw new Error('face detail: only 8-bit RGB, non-interlaced PNG is supported')
    } else if (type === 'IDAT') idat.push(bytes.subarray(o + 8, o + 8 + len))
    o += 12 + len
  }
  const z = new Uint8Array(idat.reduce((s, c) => s + c.length, 0))
  let p = 0
  for (const c of idat) z.set(c, p), (p += c.length)
  const raw = new Uint8Array(inflateSync(z))
  const stride = width * 3
  const data = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1, dst = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? data[dst + x - 3]! : 0, b = y > 0 ? data[dst - stride + x]! : 0, c = x >= 3 && y > 0 ? data[dst - stride + x - 3]! : 0
      let v = raw[src + x]!
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      data[dst + x] = v & 255
    }
  }
  return { width, height, data }
}

/** 读出 uv.bin：每个皮肤顶点的 (u, v)，没有 UV 的顶点为 NaN。 Decodes uv.bin: (u, v) per skin vertex, NaN where a vertex has none. */
export function readUv(detail: Pick<FaceDetail, 'uv' | 'vertexCount'>, bin: Uint8Array): Float32Array {
  const out = new Float32Array(detail.vertexCount * 2).fill(NaN)
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const n = detail.uv.count
  for (let i = 0; i < n; i++) {
    const v = dv.getUint32(i * 4, true)
    out[v * 2] = dv.getUint16(n * 4 + i * 4, true) / 65535
    out[v * 2 + 1] = dv.getUint16(n * 4 + i * 4 + 2, true) / 65535
  }
  return out
}

/** 解码后的图集：每层一张斜率图（每纹素 gx、gy）。 The decoded atlas: one slope map per layer (gx, gy per texel). */
export interface DetailLayers {
  tile: number
  slopes: Float32Array[]
}

export function decodeAtlas(detail: Pick<FaceDetail, 'atlas' | 'layers'>, png: Uint8Array): DetailLayers {
  const img = decodePng(png)
  if (img.width !== detail.atlas.width || img.height !== detail.atlas.height) throw new Error('face detail: atlas size does not match detail.json')
  const T = detail.atlas.tile
  const slopes = detail.layers.map((l) => {
    const s = new Float32Array(T * T * 2)
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const o = ((l.tile[1] * T + y) * img.width + l.tile[0] * T + x) * 3
        const nx = img.data[o]! / 127.5 - 1, ny = img.data[o + 1]! / 127.5 - 1, nz = Math.max(0.05, img.data[o + 2]! / 127.5 - 1)
        // 127、128 都当作 0：8 位无法精确表示 0 / both 127 and 128 count as zero: 8 bits cannot represent 0 exactly
        s[(y * T + x) * 2] = Math.abs(nx) < 0.006 ? 0 : nx / nz
        s[(y * T + x) * 2 + 1] = Math.abs(ny) < 0.006 ? 0 : ny / nz
      }
    }
    return s
  })
  return { tile: T, slopes }
}

/** (u, v) 处合成的切线空间法线（双线性取样）。 The composite tangent-space normal at (u, v), bilinearly sampled. */
export function compositeNormal(layers: DetailLayers, weights: number[], u: number, v: number): [number, number, number] {
  const T = layers.tile
  const fx = clamp(u, 0, 1) * (T - 1), fy = (1 - clamp(v, 0, 1)) * (T - 1)
  const x0 = Math.min(T - 2, Math.floor(fx)), y0 = Math.min(T - 2, Math.floor(fy)), tx = fx - x0, ty = fy - y0
  let gx = 0, gy = 0
  for (let l = 0; l < weights.length; l++) {
    const w = weights[l]!
    if (w === 0) continue
    const s = layers.slopes[l]!
    const a = (y0 * T + x0) * 2, b = a + 2, c = a + T * 2, d = c + 2
    gx += w * ((s[a]! * (1 - tx) + s[b]! * tx) * (1 - ty) + (s[c]! * (1 - tx) + s[d]! * tx) * ty)
    gy += w * ((s[a + 1]! * (1 - tx) + s[b + 1]! * tx) * (1 - ty) + (s[c + 1]! * (1 - tx) + s[d + 1]! * tx) * ty)
  }
  const k = 1 / Math.hypot(gx, gy, 1)
  return [gx * k, gy * k, k]
}
