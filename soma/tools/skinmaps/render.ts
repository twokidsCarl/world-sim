// 无界面预览：一个小型正交投影深度缓冲光栅化器和 PNG 写出器。仅供开发使用。
// Headless previews: a small orthographic z-buffer rasteriser and a PNG writer. Dev tool only.

import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { cross, dot, norm, pos, sub, type Skin, type V3 } from './mesh.ts'

export class Image {
  readonly data: Uint8Array
  constructor(readonly w: number, readonly h: number, bg: [number, number, number] = [255, 255, 255]) {
    this.data = new Uint8Array(w * h * 3)
    for (let i = 0; i < w * h; i++) this.data.set(bg, i * 3)
  }
  set(x: number, y: number, c: ArrayLike<number>) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const o = (y * this.w + x) * 3
    this.data[o] = c[0]!; this.data[o + 1] = c[1]!; this.data[o + 2] = c[2]!
  }
  rect(x: number, y: number, w: number, h: number, c: readonly number[]) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c)
  }
  blit(src: Image, x: number, y: number) {
    for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) this.set(x + i, y + j, src.data.subarray((j * src.w + i) * 3, (j * src.w + i) * 3 + 3))
  }
  text(x: number, y: number, s: string, c: readonly number[] = [0, 0, 0], scale = 1) {
    let cx = x
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] ?? FONT['?']!
      for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r]![q] === '#') this.rect(cx + q * scale, y + r * scale, scale, scale, c)
      cx += 6 * scale
    }
  }
  write(path: string) {
    const raw = new Uint8Array((this.w * 3 + 1) * this.h)
    for (let y = 0; y < this.h; y++) raw.set(this.data.subarray(y * this.w * 3, (y + 1) * this.w * 3), y * (this.w * 3 + 1) + 1)
    const chunk = (type: string, body: Uint8Array) => {
      const out = new Uint8Array(12 + body.length)
      const dv = new DataView(out.buffer)
      dv.setUint32(0, body.length)
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
      out.set(body, 8)
      dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)))
      return out
    }
    const ihdr = new Uint8Array(13)
    const dv = new DataView(ihdr.buffer)
    dv.setUint32(0, this.w); dv.setUint32(4, this.h)
    ihdr[8] = 8; ihdr[9] = 2
    const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))]
    writeFileSync(path, Buffer.concat(parts))
  }
}

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 255]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const G = (s: string) => s.split('|')
const FONT: Record<string, string[]> = {
  A: G('.###.|#...#|#...#|#####|#...#|#...#|#...#'), B: G('####.|#...#|#...#|####.|#...#|#...#|####.'),
  C: G('.###.|#...#|#....|#....|#....|#...#|.###.'), D: G('####.|#...#|#...#|#...#|#...#|#...#|####.'),
  E: G('#####|#....|#....|####.|#....|#....|#####'), F: G('#####|#....|#....|####.|#....|#....|#....'),
  G: G('.###.|#...#|#....|#.###|#...#|#...#|.###.'), H: G('#...#|#...#|#...#|#####|#...#|#...#|#...#'),
  I: G('.###.|..#..|..#..|..#..|..#..|..#..|.###.'), J: G('..###|...#.|...#.|...#.|...#.|#..#.|.##..'),
  K: G('#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#'), L: G('#....|#....|#....|#....|#....|#....|#####'),
  M: G('#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#'), N: G('#...#|##..#|#.#.#|#..##|#...#|#...#|#...#'),
  O: G('.###.|#...#|#...#|#...#|#...#|#...#|.###.'), P: G('####.|#...#|#...#|####.|#....|#....|#....'),
  Q: G('.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#'), R: G('####.|#...#|#...#|####.|#.#..|#..#.|#...#'),
  S: G('.####|#....|#....|.###.|....#|....#|####.'), T: G('#####|..#..|..#..|..#..|..#..|..#..|..#..'),
  U: G('#...#|#...#|#...#|#...#|#...#|#...#|.###.'), V: G('#...#|#...#|#...#|#...#|#...#|.#.#.|..#..'),
  W: G('#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#'), X: G('#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#'),
  Y: G('#...#|#...#|.#.#.|..#..|..#..|..#..|..#..'), Z: G('#####|....#|...#.|..#..|.#...|#....|#####'),
  '0': G('.###.|#...#|#..##|#.#.#|##..#|#...#|.###.'), '1': G('..#..|.##..|..#..|..#..|..#..|..#..|.###.'),
  '2': G('.###.|#...#|....#|...#.|..#..|.#...|#####'), '3': G('####.|....#|....#|.###.|....#|....#|####.'),
  '4': G('...#.|..##.|.#.#.|#..#.|#####|...#.|...#.'), '5': G('#####|#....|####.|....#|....#|#...#|.###.'),
  '6': G('.###.|#....|#....|####.|#...#|#...#|.###.'), '7': G('#####|....#|...#.|..#..|.#...|.#...|.#...'),
  '8': G('.###.|#...#|#...#|.###.|#...#|#...#|.###.'), '9': G('.###.|#...#|#...#|.####|....#|....#|.###.'),
  ' ': G('.....|.....|.....|.....|.....|.....|.....'), '-': G('.....|.....|.....|#####|.....|.....|.....'),
  '.': G('.....|.....|.....|.....|.....|.##..|.##..'), ',': G('.....|.....|.....|.....|.##..|..#..|.#...'),
  '/': G('....#|....#|...#.|..#..|.#...|#....|#....'), '(': G('...#.|..#..|.#...|.#...|.#...|..#..|...#.'),
  ')': G('.#...|..#..|...#.|...#.|...#.|..#..|.#...'), ':': G('.....|.##..|.##..|.....|.##..|.##..|.....'),
  '?': G('.###.|#...#|....#|...#.|..#..|.....|..#..'), '+': G('.....|..#..|..#..|#####|..#..|..#..|.....'),
  '=': G('.....|.....|#####|.....|#####|.....|.....'), '%': G('##..#|##.#.|...#.|..#..|.#...|.#.##|#..##'),
}

export interface View {
  name: string
  /**
   * 相机的观察方向。
   * Direction the camera looks along.
   */
  dir: V3
  up: V3
  /**
   * 可选裁剪框 [minX, minY, minZ, maxX, maxY, maxZ]（米）；只绘制框内的几何体。
   * Optional crop: [minX, minY, minZ, maxX, maxY, maxZ] in metres; only geometry inside is drawn.
   */
  box?: [number, number, number, number, number, number]
}

export const STANDARD_VIEWS: View[] = [
  { name: 'front', dir: [0, 0, -1], up: [0, 1, 0] },
  { name: 'back', dir: [0, 0, 1], up: [0, 1, 0] },
  { name: 'left', dir: [-1, 0, 0], up: [0, 1, 0] },
  { name: 'right', dir: [1, 0, 0], up: [0, 1, 0] },
]

export const hexRgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.replace('#', ''), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

/**
 * 按顶点标签着色绘制外壁（三角形内部取最近顶点的颜色）。
 * Renders the outer wall with one colour per vertex label (nearest-vertex colouring inside triangles).
 */
export function renderView(skin: Skin, vertexColor: (v: number) => readonly number[], view: View, pxPerM: number, markers: { p: V3; c: readonly number[] }[] = []): Image {
  const d = norm(view.dir)
  const right = norm(cross(d, view.up))
  const up = cross(right, d)
  const inBox = (p: V3) => !view.box || (p[0] >= view.box[0] && p[1] >= view.box[1] && p[2] >= view.box[2] && p[0] <= view.box[3] && p[1] <= view.box[4] && p[2] <= view.box[5])
  const tris: number[] = []
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (let t = 0; t < skin.indices.length; t += 3) {
    const a = skin.indices[t]!, b = skin.indices[t + 1]!, c = skin.indices[t + 2]!
    if (!(skin.outer[a] && skin.outer[b] && skin.outer[c])) continue
    if (!(inBox(pos(skin, a)) && inBox(pos(skin, b)) && inBox(pos(skin, c)))) continue
    tris.push(a, b, c)
    for (const v of [a, b, c]) {
      const p = pos(skin, v)
      const x = dot(p, right), y = dot(p, up)
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  const pad = 6
  const w = Math.ceil((x1 - x0) * pxPerM) + pad * 2, h = Math.ceil((y1 - y0) * pxPerM) + pad * 2
  const img = new Image(w, h)
  const zb = new Float32Array(w * h).fill(Infinity)
  const light = norm([-d[0] + 0.3 * up[0], -d[1] + 0.3 * up[1], -d[2] + 0.3 * up[2]])
  const proj = (p: V3): V3 => [(dot(p, right) - x0) * pxPerM + pad, (y1 - dot(p, up)) * pxPerM + pad, dot(p, d)]
  for (let t = 0; t < tris.length; t += 3) {
    const ids = [tris[t]!, tris[t + 1]!, tris[t + 2]!]
    const P3 = ids.map((v) => pos(skin, v))
    const nn = norm(cross(sub(P3[1]!, P3[0]!), sub(P3[2]!, P3[0]!)))
    if (dot(nn, d) > 0) continue
    const shade = 0.45 + 0.55 * Math.max(0, dot(nn, light))
    const cols = ids.map((v) => vertexColor(v))
    const [A, B, C] = P3.map(proj) as [V3, V3, V3]
    const minx = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), maxx = Math.min(w - 1, Math.ceil(Math.max(A[0], B[0], C[0])))
    const miny = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), maxy = Math.min(h - 1, Math.ceil(Math.max(A[1], B[1], C[1])))
    const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1])
    if (Math.abs(den) < 1e-12) continue
    for (let y = miny; y <= maxy; y++)
      for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5, py = y + 0.5
        const l0 = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / den
        const l1 = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / den
        const l2 = 1 - l0 - l1
        if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue
        const z = l0 * A[2] + l1 * B[2] + l2 * C[2]
        if (z >= zb[y * w + x]!) continue
        zb[y * w + x] = z
        const c = l0 >= l1 && l0 >= l2 ? cols[0]! : l1 >= l2 ? cols[1]! : cols[2]!
        img.set(x, y, [c[0]! * shade, c[1]! * shade, c[2]! * shade])
      }
  }
  for (const m of markers) {
    if (!inBox(m.p)) continue
    const q = proj(m.p)
    const x = Math.round(q[0]), y = Math.round(q[1])
    if (x < 0 || y < 0 || x >= w || y >= h || q[2] > zb[y * w + x]! + 0.004) continue
    img.rect(x - 2, y - 2, 5, 5, [0, 0, 0])
    img.rect(x - 1, y - 1, 3, 3, m.c)
  }
  img.text(4, 4, view.name, [60, 60, 60], 2)
  return img
}

/**
 * 把各图从左到右排布，并附图例栏。
 * Lays images out left to right with a legend column.
 */
export function sheet(images: Image[], legend: { label: string; color: readonly number[] }[], path: string, columns = images.length) {
  const rows: Image[][] = []
  for (let i = 0; i < images.length; i += columns) rows.push(images.slice(i, i + columns))
  const rowH = rows.map((r) => Math.max(...r.map((i) => i.h)))
  const rowW = rows.map((r) => r.reduce((s, i) => s + i.w + 8, 0))
  const perCol = Math.max(1, Math.floor((rowH.reduce((a, b) => a + b, 0) - 10) / 18))
  const legendCols = Math.ceil(legend.length / perCol)
  const colW = 30 + 6 * 2 * Math.max(1, ...legend.map((l) => l.label.length))
  const out = new Image(Math.max(...rowW) + legendCols * colW + 10, rowH.reduce((a, b) => a + b, 0) + 10)
  let y = 5
  rows.forEach((r, ri) => {
    let x = 5
    for (const im of r) { out.blit(im, x, y); x += im.w + 8 }
    y += rowH[ri]!
  })
  legend.forEach((l, i) => {
    const lx = Math.max(...rowW) + Math.floor(i / perCol) * colW, ly = 8 + (i % perCol) * 18
    out.rect(lx, ly, 18, 14, l.color)
    out.text(lx + 24, ly, l.label, [0, 0, 0], 2)
  })
  out.write(path)
}
