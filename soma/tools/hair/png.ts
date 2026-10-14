// 写 PNG（灰度或 RGBA，逐行选滤波器以压得更小）/ Writing PNGs (grey or RGBA, choosing a filter per row to compress better).
import { deflateSync, inflateSync } from 'node:zlib'

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, body.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  let c = 0xffffffff
  for (let i = 4; i < 8 + body.length; i++) c = crcTable[(c ^ out[i]!) & 255]! ^ (c >>> 8)
  dv.setUint32(8 + body.length, (c ^ 0xffffffff) >>> 0)
  return out
}

/** `channels` 为 1（灰度）或 4（RGBA）/ `channels` is 1 (grey) or 4 (RGBA) */
export function encodePng(data: Uint8Array, width: number, height: number, channels: 1 | 4): Uint8Array {
  const stride = width * channels
  const raw = new Uint8Array((stride + 1) * height)
  const cand = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride)
    const up = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null
    let best = -1, bestSum = Infinity
    const out = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let f = 0; f < 5; f++) {
      let sum = 0
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? row[i - channels]! : 0, b = up ? up[i]! : 0, c = up && i >= channels ? up[i - channels]! : 0
        let pred = 0
        if (f === 1) pred = a
        else if (f === 2) pred = b
        else if (f === 3) pred = (a + b) >> 1
        else if (f === 4) {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        }
        const v = (row[i]! - pred) & 255
        cand[i] = v
        sum += v < 128 ? v : 256 - v
      }
      if (sum < bestSum) {
        bestSum = sum
        best = f
        out.set(cand)
      }
    }
    raw[y * (stride + 1)] = best
  }
  const head = new Uint8Array(13)
  const hv = new DataView(head.buffer)
  hv.setUint32(0, width)
  hv.setUint32(4, height)
  head.set([8, channels === 4 ? 6 : 0, 0, 0, 0], 8)
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) out.set(p, o), (o += p.length)
  return out
}

/** 读 8 位灰度或 RGBA 的 PNG（只认本项目自己写的这两种）/ read an 8-bit grey or RGBA PNG (only the two kinds this project writes) */
export function decodePng(png: Uint8Array): { data: Uint8Array; width: number; height: number; channels: 1 | 4 } {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let o = 8, width = 0, height = 0, channels: 1 | 4 = 4
  const idat: Uint8Array[] = []
  while (o < png.length) {
    const n = dv.getUint32(o)
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8))
    const body = png.subarray(o + 8, o + 8 + n)
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8)
      height = dv.getUint32(o + 12)
      if (body[8] !== 8 || (body[9] !== 6 && body[9] !== 0)) throw new Error('decodePng: only 8-bit grey or RGBA')
      channels = body[9] === 6 ? 4 : 1
    } else if (type === 'IDAT') idat.push(body)
    o += 12 + n
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat)))
  const stride = width * channels
  const out = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[y * stride + i - channels]! : 0, b = y > 0 ? out[(y - 1) * stride + i]! : 0, c = y > 0 && i >= channels ? out[(y - 1) * stride + i - channels]! : 0
      let pred = 0
      if (f === 1) pred = a
      else if (f === 2) pred = b
      else if (f === 3) pred = (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * stride + i] = (src[i]! + pred) & 255
    }
  }
  return { data: out, width, height, channels }
}
