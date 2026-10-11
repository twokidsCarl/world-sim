// 一个极小的正交投影软件光栅器（深度缓冲、双面平面着色），输出 PNG。
// 用于离线查看摆好姿态的人体，无需浏览器或 GPU。
// A tiny orthographic software rasteriser (z-buffer, flat two-sided shading) that writes PNGs.
// Used to look at posed bodies offline, without a browser or GPU.

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

export type Rgb = readonly [number, number, number]

export class Image {
  readonly data: Uint8Array
  constructor(readonly width: number, readonly height: number, bg: Rgb = [255, 255, 255]) {
    this.data = new Uint8Array(width * height * 3)
    for (let i = 0; i < width * height; i++) this.data.set(bg, i * 3)
  }

  blit(src: Image, x0: number, y0: number): void {
    for (let y = 0; y < src.height; y++) {
      if (y + y0 < 0 || y + y0 >= this.height) continue
      for (let x = 0; x < src.width; x++) {
        if (x + x0 < 0 || x + x0 >= this.width) continue
        const s = (y * src.width + x) * 3, d = ((y + y0) * this.width + x + x0) * 3
        this.data[d] = src.data[s]!
        this.data[d + 1] = src.data[s + 1]!
        this.data[d + 2] = src.data[s + 2]!
      }
    }
  }

  png(): Uint8Array {
    const raw = new Uint8Array((this.width * 3 + 1) * this.height)
    for (let y = 0; y < this.height; y++) raw.set(this.data.subarray(y * this.width * 3, (y + 1) * this.width * 3), y * (this.width * 3 + 1) + 1)
    const crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
    const chunk = (type: string, body: Uint8Array): Uint8Array => {
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
    const head = new Uint8Array(13)
    const hv = new DataView(head.buffer)
    hv.setUint32(0, this.width)
    hv.setUint32(4, this.height)
    head.set([8, 2, 0, 0, 0], 8)
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 6 }))), chunk('IEND', new Uint8Array(0))]
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
    let o = 0
    for (const p of parts) out.set(p, o), (o += p.length)
    return out
  }

  save(path: string): void {
    writeFileSync(path, this.png())
  }
}

export interface RenderItem {
  positions: Float32Array
  indices: Uint32Array
  color: Rgb
  /** 可选的逐顶点颜色（扁平 rgb，0–255），覆盖 `color`。 Optional per-vertex colours (flat rgb 0–255), overriding `color`. */
  vertexColors?: Uint8Array
}

export interface View {
  /** 相机绕竖直轴的旋转，单位为度：0 = 从正面看，90 = 从身体左侧看。 Rotation of the camera about the vertical axis, degrees: 0 = from the front, 90 = from the body's left. */
  yaw: number
  /** 相机的仰角，单位为度（正值表示从上方俯视）。 Elevation of the camera, degrees (positive looks down from above). */
  pitch?: number
  /** 视图中心及半高，单位为米。 Centre of the view and half-height in metres. */
  center: [number, number, number]
  halfHeight: number
  width: number
  height: number
  /** 只保留该深度范围内的片元（沿视轴的米数，`center` 处为 0）——即一个切片。 Keep only fragments within this depth range (metres along the view axis, 0 at `center`) — a slab cut. */
  slab?: [number, number]
}

export function render(items: RenderItem[], view: View, bg: Rgb = [255, 255, 255]): Image {
  const img = new Image(view.width, view.height, bg)
  const zbuf = new Float32Array(view.width * view.height).fill(-Infinity)
  const yaw = (view.yaw * Math.PI) / 180, pitch = ((view.pitch ?? 0) * Math.PI) / 180
  // 相机基向量：右、上、朝向观察者 / camera basis: right, up, toward-viewer
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch)
  const right = [cy, 0, -sy], back = [sy * cp, sp, cy * cp], up = [-sy * sp, cp, -cy * sp]
  const scale = view.height / (2 * view.halfHeight)
  const [cx, cyy, cz] = view.center
  const light = [0.35, 0.5, 0.8]
  const ll = Math.hypot(light[0]!, light[1]!, light[2]!)
  for (const it of items) {
    const n = it.positions.length / 3
    const sx = new Float32Array(n), syy = new Float32Array(n), sz = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = it.positions[i * 3]! - cx, y = it.positions[i * 3 + 1]! - cyy, z = it.positions[i * 3 + 2]! - cz
      sx[i] = (x * right[0]! + y * right[1]! + z * right[2]!) * scale + view.width / 2
      syy[i] = view.height / 2 - (x * up[0]! + y * up[1]! + z * up[2]!) * scale
      sz[i] = x * back[0]! + y * back[1]! + z * back[2]!
    }
    for (let t = 0; t < it.indices.length; t += 3) {
      const a = it.indices[t]!, b = it.indices[t + 1]!, c = it.indices[t + 2]!
      const x0 = sx[a]!, y0 = syy[a]!, x1 = sx[b]!, y1 = syy[b]!, x2 = sx[c]!, y2 = syy[c]!
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
      if (area === 0) continue
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(view.width - 1, Math.ceil(Math.max(x0, x1, x2)))
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(view.height - 1, Math.ceil(Math.max(y0, y1, y2)))
      if (minX > maxX || minY > maxY) continue
      // 相机空间中的面法线，用于着色 / face normal in camera space for shading
      const ux = x1 - x0, uy = -(y1 - y0), uz = (sz[b]! - sz[a]!) * scale
      const vx = x2 - x0, vy = -(y2 - y0), vz = (sz[c]! - sz[a]!) * scale
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      const nl = Math.hypot(nx, ny, nz) || 1
      if (nz < 0) (nx = -nx), (ny = -ny), (nz = -nz)
      const shade = 0.35 + 0.65 * Math.max(0, (nx * light[0]! + ny * light[1]! + nz * light[2]!) / (nl * ll))
      let col: Rgb = it.color
      if (it.vertexColors) {
        const vc = it.vertexColors
        col = [(vc[a * 3]! + vc[b * 3]! + vc[c * 3]!) / 3, (vc[a * 3 + 1]! + vc[b * 3 + 1]! + vc[c * 3 + 1]!) / 3, (vc[a * 3 + 2]! + vc[b * 3 + 2]! + vc[c * 3 + 2]!) / 3]
      }
      const r = col[0] * shade, g = col[1] * shade, bl = col[2] * shade
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5, py = y + 0.5
          const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area
          const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area
          const w2 = 1 - w0 - w1
          if (w0 < 0 || w1 < 0 || w2 < 0) continue
          const z = w0 * sz[a]! + w1 * sz[b]! + w2 * sz[c]!
          if (view.slab && (z < view.slab[0] || z > view.slab[1])) continue
          const k = y * view.width + x
          if (z <= zbuf[k]!) continue
          zbuf[k] = z
          img.data[k * 3] = r
          img.data[k * 3 + 1] = g
          img.data[k * 3 + 2] = bl
        }
      }
    }
  }
  return img
}

/** 把图像从左到右平铺，每 `columns` 张后换行。 Tiles images left to right, wrapping after `columns`. */
export function sheet(images: Image[], columns = images.length, gap = 4): Image {
  const w = Math.max(...images.map((i) => i.width)), h = Math.max(...images.map((i) => i.height))
  const rows = Math.ceil(images.length / columns)
  const out = new Image(columns * (w + gap) + gap, rows * (h + gap) + gap, [40, 40, 40])
  images.forEach((im, i) => out.blit(im, gap + (i % columns) * (w + gap), gap + Math.floor(i / columns) * (h + gap)))
  return out
}
