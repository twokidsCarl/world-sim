import type { Volume } from './mrc'
// 这个文件里 `t` 另有所指，所以换个名字 / `t` means something else in this file, hence the other name
import { t as tr } from '../i18n'

/**
 * N5：分块存放的大体数据（OpenOrganelle 用它放整个细胞的电镜数据和细胞器的分割结果）。
 * 一个数据集是一个目录：attributes.json 说明尺寸、分块大小和数据类型，每个分块是一个小文件，
 * 路径是 x/y/z 三个分块下标。分块文件的开头是一小段二进制头（模式、维数、各维大小，都是大端），
 * 后面是 gzip 压缩的数值（大端，x 最快）。缺失的分块表示全是 0。
 *
 * 这里把一个分割数据集读成“这个体素是不是这种细胞器”的掩码（非 0 即为是）。
 *
 * N5: large volumes stored in blocks (OpenOrganelle keeps whole-cell electron microscopy and
 * organelle segmentations in it). A dataset is a directory: attributes.json gives the size, block
 * size and data type, and each block is a small file whose path is its x/y/z block index. A block
 * file starts with a short binary header (mode, number of dimensions, size along each, all
 * big-endian) followed by gzip-compressed values (big-endian, x fastest). A missing block is all
 * zeros.
 *
 * A segmentation dataset is read here as a mask of "is this voxel that organelle" (non-zero means yes).
 */
export interface N5Attributes {
  dimensions: number[]
  blockSize: number[]
  dataType: string
  compression: { type: string }
  pixelResolution?: { dimensions: number[]; unit: string }
  transform?: { axes: string[]; scale: number[]; translate: number[] }
}

const BYTES: Record<string, number> = { uint8: 1, int8: 1, uint16: 2, int16: 2, uint32: 4, int32: 4, uint64: 8, int64: 8, float32: 4 }

/** 一个分块里哪些体素非 0，以及这个分块的实际大小 / which voxels of one block are non-zero, and the block's actual size */
export async function readBlock(file: ArrayBuffer, attrs: N5Attributes): Promise<{ size: number[]; nonzero: Uint8Array }> {
  const v = new DataView(file)
  const mode = v.getUint16(0, false), ndim = v.getUint16(2, false)
  if (mode > 1 || ndim !== attrs.dimensions.length) throw new Error(tr('error.n5.header'))
  const size = Array.from({ length: ndim }, (_, i) => v.getUint32(4 + i * 4, false))
  const start = 4 + ndim * 4 + (mode === 1 ? 4 : 0)
  let payload = new Uint8Array(file, start)
  if (attrs.compression.type === 'gzip') payload = new Uint8Array(await new Response(new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  else if (attrs.compression.type !== 'raw') throw new Error(tr('error.n5.compression', { type: attrs.compression.type }))
  const w = BYTES[attrs.dataType]
  if (!w) throw new Error(tr('error.n5.dataType', { type: attrs.dataType }))
  const count = size.reduce((a, b) => a * b, 1)
  if (payload.length < count * w) throw new Error(tr('error.n5.truncated'))
  const nonzero = new Uint8Array(count)
  // 只关心是不是 0，所以字节序无所谓：任一字节非 0 即可 / only zero or not matters, so byte order does not: any non-zero byte will do
  for (let i = 0; i < count; i++) {
    let any = 0
    for (let b = 0; b < w; b++) any |= payload[i * w + b]!
    nonzero[i] = any ? 1 : 0
  }
  return { size, nonzero }
}

/**
 * 把一个三维 N5 分割数据集读成掩码。`base` 是数据集的地址（含尺度，如 …/mito_seg/s4）。
 * 长度单位照数据集的来（OpenOrganelle 是纳米）。
 * Read a three-dimensional N5 segmentation as a mask. `base` is the dataset's address including
 * its scale level (.../mito_seg/s4). Lengths are in the dataset's own unit (nanometres for OpenOrganelle).
 */
export async function readN5Mask(base: string, onProgress?: (done: number, total: number) => void, fetcher: typeof fetch = fetch): Promise<Volume & { attributes: N5Attributes }> {
  const res = await fetcher(`${base}/attributes.json`)
  if (!res.ok) throw new Error(tr('error.n5.missing', { base, status: res.status }))
  const attrs = (await res.json()) as N5Attributes
  if (attrs.dimensions.length !== 3) throw new Error(tr('error.n5.dims'))
  const [nx, ny, nz] = attrs.dimensions as [number, number, number]
  const [bx, by, bz] = attrs.blockSize as [number, number, number]
  if (nx * ny * nz > 400_000_000) throw new Error(tr('error.n5.tooBig'))
  const data = new Uint8Array(nx * ny * nz)
  const blocks: [number, number, number][] = []
  for (let iz = 0; iz * bz < nz; iz++) for (let iy = 0; iy * by < ny; iy++) for (let ix = 0; ix * bx < nx; ix++) blocks.push([ix, iy, iz])
  let done = 0
  const work = async () => {
    for (;;) {
      const b = blocks.pop()
      if (!b) return
      const r = await fetcher(`${base}/${b[0]}/${b[1]}/${b[2]}`).catch(() => null)
      // 缺失的分块全是 0（S3 对不存在的对象返回 403 或 404）/ a missing block is all zeros (S3 answers 403 or 404 for an absent object)
      if (r && r.ok) {
        const { size, nonzero } = await readBlock(await r.arrayBuffer(), attrs)
        const [sx, sy, sz] = size as [number, number, number]
        // 边上的分块常常按整块存放，超出数据集范围的部分要裁掉
        // blocks at the edge are often stored whole, and what lies beyond the dataset has to be clipped
        const x0 = b[0] * bx, y0 = b[1] * by, z0 = b[2] * bz
        const wx = Math.min(sx, nx - x0), wy = Math.min(sy, ny - y0), wz = Math.min(sz, nz - z0)
        for (let z = 0; z < wz; z++)
          for (let y = 0; y < wy; y++) data.set(nonzero.subarray(sx * (y + sy * z), sx * (y + sy * z) + wx), x0 + nx * (y0 + y + ny * (z0 + z)))
      }
      onProgress?.(++done, done + blocks.length)
    }
  }
  await Promise.all(Array.from({ length: 8 }, work))
  // 体素大小和起点：transform 里是按 z, y, x 写的 / voxel size and start: the transform lists them as z, y, x
  const t = attrs.transform
  const pick = (v: number[] | undefined, axis: string, fallback: number) => {
    const i = t?.axes.indexOf(axis) ?? -1
    return v && i >= 0 && Number.isFinite(v[i]) ? v[i]! : fallback
  }
  const px = attrs.pixelResolution?.dimensions
  return {
    nx, ny, nz, data,
    voxel: [pick(t?.scale, 'x', px?.[0] ?? 1), pick(t?.scale, 'y', px?.[1] ?? 1), pick(t?.scale, 'z', px?.[2] ?? 1)],
    origin: [pick(t?.translate, 'x', 0), pick(t?.translate, 'y', 0), pick(t?.translate, 'z', 0)],
    attributes: attrs,
  }
}
