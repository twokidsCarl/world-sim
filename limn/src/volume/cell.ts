/**
 * 一个细胞的各种细胞器的表面：从分割数据取掩码、算出三角网格，合成一份几何。
 * 浏览器和本地服务都用这一段：平常由服务预先做好、存成一个文件（见 server/tools/cell.ts），
 * 页面只读那个文件；没有服务时页面自己现算。
 *
 * The surfaces of a cell's organelles: masks are read from the segmentation, turned into triangle
 * meshes, and gathered into one geometry. Both the browser and the local service use this code:
 * normally the service prepares it ahead of time and keeps it as one file (see
 * server/tools/cell.ts), which is all the page reads; without the service the page computes it.
 */
import { dilate, pad, surfaceMesh, voxelIndex, type Volume } from './mrc'
import { readN5Mask } from './n5'

export interface CellSource {
  base: string
  scale: string
  organelles: { label: string }[]
}

export interface CellGeometry {
  /** 表面的点 x, y, z（数据集的长度单位）/ surface points x, y, z in the dataset's unit */
  positions: Float32Array
  /** 三角形，每个三个点的下标；`dense` 时为空 / triangles as three point indices each; empty when `dense` */
  triangles: Uint32Array
  /** 用小球画时每个点的球半径 / the sphere radius of each point when drawn with spheres */
  radius: number
  voxel: [number, number, number]
  /** 每种细胞器在点表里的范围 / the range of each organelle in the point list */
  parts: { label: string; start: number; count: number }[]
  /** 没取到或没有表面的细胞器 / organelles that could not be fetched or have no surface */
  missing: string[]
}

export interface CellProgress {
  fetching?(label: string, done: number, total: number): void
  surfacing?(label: string): void | Promise<void>
}

/** 细胞核的标签：别的细胞器贴着它的部分不画 / the nucleus's label: the parts of other organelles that hug it are not drawn */
const NUCLEUS = 'nucleus_seg'

/**
 * `dense` 为真时不出三角形，贴着细胞核的点事后删掉（加入网格之前的画法，留作对照）。
 * With `dense` no triangles are made and points hugging the nucleus are removed afterwards (the
 * way it was drawn before meshes, kept for comparison).
 */
export async function buildCell(src: CellSource, dense: boolean, progress: CellProgress = {}, fetcher: typeof fetch = fetch): Promise<CellGeometry> {
  const pos: number[] = [], triangles: number[] = []
  const parts: CellGeometry['parts'] = []
  const missing: string[] = []
  let voxel: [number, number, number] = [0, 0, 0]
  let radius = 0
  let nearNucleus: { vol: Volume; mask: Uint8Array } | null = null
  for (const o of src.organelles) {
    const vol = await readN5Mask(`${src.base}/${o.label}/${src.scale}`, (done, total) => progress.fetching?.(o.label, done, total), fetcher).catch(() => null)
    if (!vol) {
      missing.push(o.label)
      continue
    }
    voxel = vol.voxel
    await progress.surfacing?.(o.label)
    // 核膜算在内质网的分割里，紧贴着细胞核的表面；两层表面叠在一起会互相抢，所以别的细胞器贴着细胞核的那部分不画。
    // 画网格时在取表面之前就把这些体素去掉，表面仍是封闭的，剖开时才能画出实心的断面；四周也补一层空体素。
    // the nuclear envelope belongs to the ER segmentation and lies right on the nucleus's surface; two coincident surfaces fight over every pixel, so the part of any other organelle that hugs the nucleus is not drawn.
    // For the mesh those voxels are removed before the surface is taken, which keeps it closed, as a solid section at a cut requires; a layer of empty voxels is added all round as well.
    if (!dense && nearNucleus && o.label !== NUCLEUS) {
      const nn = nearNucleus
      for (let z = 0, i = 0; z < vol.nz; z++)
        for (let y = 0; y < vol.ny; y++)
          for (let x = 0; x < vol.nx; x++, i++) {
            if (!vol.data[i]) continue
            const k = voxelIndex(nn.vol, vol.origin[0] + x * vol.voxel[0], vol.origin[1] + y * vol.voxel[1], vol.origin[2] + z * vol.voxel[2])
            if (k >= 0 && nn.mask[k]) vol.data[i] = 0
          }
    }
    const surface = surfaceMesh(dense ? vol : pad(vol), 0.5)
    const pts = surface.positions
    if (pts.length === 0) {
      missing.push(o.label)
      continue
    }
    const start = pos.length / 3
    // 每个表面点一个球，半径略小于一个体素 / a sphere on every surface point, a little under a voxel in radius
    radius = Math.min(...vol.voxel) * 0.95
    if (o.label === NUCLEUS) nearNucleus = { vol, mask: dilate(vol, 2) }
    const near = dense && o.label !== NUCLEUS ? nearNucleus : null
    // 表面的每个点在总表里排第几；没画的是 -1 / where each point of this surface lands in the whole list, -1 if it is not drawn
    const placed = new Int32Array(pts.length / 3).fill(-1)
    for (let i = 0; i < pts.length; i += 3) {
      if (near) {
        const k = voxelIndex(near.vol, pts[i]!, pts[i + 1]!, pts[i + 2]!)
        if (k >= 0 && near.mask[k]) continue
      }
      placed[i / 3] = pos.length / 3
      pos.push(pts[i]!, pts[i + 1]!, pts[i + 2]!)
    }
    // 三个顶点都还在的三角形才留下 / a triangle is kept only when all three of its vertices are
    if (!dense)
      for (let t = 0; t < surface.triangles.length; t += 3) {
        const a = placed[surface.triangles[t]!]!, b = placed[surface.triangles[t + 1]!]!, c = placed[surface.triangles[t + 2]!]!
        if (a >= 0 && b >= 0 && c >= 0) triangles.push(a, b, c)
      }
    if (pos.length / 3 === start) {
      missing.push(o.label)
      continue
    }
    parts.push({ label: o.label, start, count: pos.length / 3 - start })
  }
  return { positions: new Float32Array(pos), triangles: new Uint32Array(triangles), radius, voxel, parts, missing }
}

export const CELL_MAGIC = 'LIMNCEL1'

/** 文件：8 字节标记，4 字节头部长度，JSON 头部（补到 4 的倍数），点（每个 3 个浮点数），三角形（每个 3 个 32 位整数）/ the file: an 8-byte tag, 4 bytes of header length, the JSON header (padded to a multiple of 4), the points (3 floats each), the triangles (3 32-bit integers each) */
export function encodeCell(g: CellGeometry): Uint8Array {
  let json = new TextEncoder().encode(JSON.stringify({ radius: g.radius, voxel: g.voxel, parts: g.parts, missing: g.missing, points: g.positions.length / 3, triangles: g.triangles.length / 3 }))
  if (json.length % 4) {
    const padded = new Uint8Array(json.length + 4 - (json.length % 4)).fill(32)
    padded.set(json)
    json = padded
  }
  const out = new Uint8Array(12 + json.length + g.positions.byteLength + g.triangles.byteLength)
  out.set(new TextEncoder().encode(CELL_MAGIC))
  new DataView(out.buffer).setUint32(8, json.length, true)
  out.set(json, 12)
  out.set(new Uint8Array(g.positions.buffer, g.positions.byteOffset, g.positions.byteLength), 12 + json.length)
  out.set(new Uint8Array(g.triangles.buffer, g.triangles.byteOffset, g.triangles.byteLength), 12 + json.length + g.positions.byteLength)
  return out
}

export function decodeCell(buf: Uint8Array): CellGeometry {
  if (new TextDecoder().decode(buf.subarray(0, 8)) !== CELL_MAGIC) throw new Error('不是预处理过的细胞文件 / not a prepared cell file')
  const n = new DataView(buf.buffer, buf.byteOffset).getUint32(8, true)
  const h = JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + n))) as { radius: number; voxel: [number, number, number]; parts: CellGeometry['parts']; missing: string[]; points: number; triangles: number }
  const body = buf.slice(12 + n)
  return {
    positions: new Float32Array(body.buffer, 0, h.points * 3),
    triangles: new Uint32Array(body.buffer, h.points * 12, h.triangles * 3),
    radius: h.radius, voxel: h.voxel, parts: h.parts, missing: h.missing,
  }
}
