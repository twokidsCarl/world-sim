// 解码 8 位 RGB / RGBA、非隔行的 PNG。自己解而不走 <img> / canvas：那条路可能做色彩管理或预乘透明度，
// 而写实皮肤的贴图是数据（倍数、粗糙度），一个数都不能变。
// Decodes 8-bit RGB / RGBA, non-interlaced PNGs. Decoded here rather than through <img> / canvas: that route
// may colour-manage or premultiply alpha, and the lifelike skin's maps are data (multipliers, roughness) of
// which not one value may change.

export interface DecodedPng {
  width: number
  height: number
  /** RGBA8，第 0 行是文件里的第一行 / RGBA8; row 0 is the first row in the file */
  data: Uint8Array
}

async function inflate(z: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([z as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function decodePngRgba(bytes: Uint8Array): Promise<DecodedPng> {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  if (sig.some((b, i) => bytes[i] !== b)) throw new Error('不是 PNG / not a PNG')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 8, width = 0, height = 0, channels = 0
  const idat: Uint8Array[] = []
  while (o + 8 <= bytes.length) {
    const len = dv.getUint32(o)
    const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!)
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8)
      height = dv.getUint32(o + 12)
      const depth = bytes[o + 16], colour = bytes[o + 17], interlace = bytes[o + 20]
      if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) throw new Error('只支持 8 位 RGB / RGBA、非隔行的 PNG / only 8-bit RGB / RGBA, non-interlaced PNGs are supported')
      channels = colour === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(bytes.subarray(o + 8, o + 8 + len))
    else if (type === 'IEND') break
    o += 12 + len
  }
  if (!channels) throw new Error('PNG 没有 IHDR / the PNG has no IHDR')
  const z = new Uint8Array(idat.reduce((s, c) => s + c.length, 0))
  let p = 0
  for (const c of idat) {
    z.set(c, p)
    p += c.length
  }
  const raw = await inflate(z)
  const bpp = channels
  const stride = width * bpp
  if (raw.length < (stride + 1) * height) throw new Error('PNG 的数据不完整 / the PNG is truncated')
  let line = new Uint8Array(stride), prev = new Uint8Array(stride)
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp]! : 0, b = prev[x]!, c = x >= bpp ? prev[x - bpp]! : 0
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
    for (let x = 0, q = y * width * 4; x < stride; x += bpp, q += 4) {
      data[q] = line[x]!
      data[q + 1] = line[x + 1]!
      data[q + 2] = line[x + 2]!
      data[q + 3] = bpp === 4 ? line[x + 3]! : 255
    }
    ;[line, prev] = [prev, line]
  }
  return { width, height, data }
}
