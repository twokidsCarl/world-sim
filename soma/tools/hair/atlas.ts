// 发片贴图集：从本项目自己生成的发丝画出来（不用任何外部素材）。每种发片挑几簇有代表性的，把簇里的发丝（头发再按引导
// 发丝插值出更多根）放进发片坐标，按真实的纤维直径做抗锯齿光栅化。
//   atlas-a（RGBA）：R 覆盖率；G 根→梢位置、B 每根发丝的随机数、A 深度——这三项都预乘了覆盖率，多级纹理平均之后除回去仍然对
//   atlas-b（灰度）：发丝相对发片轴的偏角，同样预乘覆盖率
// The card atlas: drawn from this project's own strands (no outside material). A few representative groups are picked
// per card kind; their strands (for scalp hair, more interpolated from the guides) are put in card coordinates and
// rasterised with antialiasing at the real fibre diameter.
//   atlas-a (RGBA): R coverage; G root → tip position, B a random number per strand, A depth — all three premultiplied by
//   coverage, so dividing by it after mip averaging still gives the right value
//   atlas-b (grey): each strand's angle from the card axis, also premultiplied by coverage

import { type Card, cardSpace } from './cards.ts'
import { type V3, add, cross, gauss, len, norm, rng, scale, sub } from './geom.ts'
import type { Strand } from './strands.ts'

export type CardKind = 'long' | 'short' | 'brow' | 'lash' | 'beard' | 'body'

export const ATLAS_SIZE = 1024
/** 每种发片的贴图格：[x, y, 宽, 高]（像素），按种类排成一行 / tiles per card kind: [x, y, width, height] (pixels), one row per kind */
export const TILES: Record<CardKind, { count: number; w: number; h: number; y: number; x?: number }> = {
  long: { count: 16, w: 64, h: 512, y: 0 },
  short: { count: 16, w: 64, h: 256, y: 512 },
  brow: { count: 4, w: 128, h: 128, y: 768 },
  beard: { count: 4, w: 128, h: 128, y: 768, x: 512 },
  lash: { count: 4, w: 128, h: 128, y: 896 },
  body: { count: 4, w: 128, h: 128, y: 896, x: 512 },
}

export function tileRect(kind: CardKind, tile: number): [number, number, number, number] {
  const t = TILES[kind]
  return [(t.x ?? 0) + (tile % t.count) * t.w, t.y, t.w, t.h]
}

/** 深度的量程（米）：±这么多映射到 0…1 / depth range (m): ± this maps onto 0…1 */
export const DEPTH_RANGE: Record<CardKind, number> = { long: 0.004, short: 0.003, brow: 0.0004, lash: 0.0004, beard: 0.0005, body: 0.003 }

export class Atlas {
  readonly cov = new Float32Array(ATLAS_SIZE * ATLAS_SIZE)
  readonly s = new Float32Array(ATLAS_SIZE * ATLAS_SIZE)
  readonly id = new Float32Array(ATLAS_SIZE * ATLAS_SIZE)
  readonly depth = new Float32Array(ATLAS_SIZE * ATLAS_SIZE).fill(-Infinity)
  readonly angle = new Float32Array(ATLAS_SIZE * ATLAS_SIZE)
  /** 已画的发丝数 / strands drawn */
  strands = 0

  /** 画一根发丝：点列在贴图格里的像素坐标、每点的宽度（像素）、根→梢位置、深度（0…1）和偏角（0…1）/ draw one strand: per point the pixel position in the tile, width (px), root → tip position, depth (0…1) and angle (0…1) */
  draw(rect: [number, number, number, number], xs: number[], ys: number[], ws: number[], ss: number[], ds: number[], as: number[], id: number): void {
    const [x0, y0, tw, th] = rect
    for (let i = 0; i + 1 < xs.length; i++) {
      const ax = xs[i]!, ay = ys[i]!, bx = xs[i + 1]!, by = ys[i + 1]!
      const hw = Math.max(ws[i]!, ws[i + 1]!) / 2
      const pad = Math.max(1, hw) + 1
      const minX = Math.max(0, Math.floor(Math.min(ax, bx) - pad)), maxX = Math.min(tw - 1, Math.ceil(Math.max(ax, bx) + pad))
      const minY = Math.max(0, Math.floor(Math.min(ay, by) - pad)), maxY = Math.min(th - 1, Math.ceil(Math.max(ay, by) + pad))
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5, py = y + 0.5
          const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2))
          const dist = Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
          const w = ws[i]! + (ws[i + 1]! - ws[i]!) * t
          // 盒滤波的覆盖率：宽于一像素按距离，窄于一像素按宽度 / box-filter coverage: by distance when wider than a pixel, by width when narrower
          const c = w >= 1 ? Math.min(1, Math.max(0, w / 2 + 0.5 - dist)) : w * Math.min(1, Math.max(0, 1 - dist))
          if (c <= 0) continue
          const k = (y0 + y) * ATLAS_SIZE + x0 + x
          this.cov[k] = 1 - (1 - this.cov[k]!) * (1 - c)
          const d = ds[i]! + (ds[i + 1]! - ds[i]!) * t
          if (d >= this.depth[k]! || c > 0.5) {
            this.depth[k] = Math.max(d, this.depth[k] === -Infinity ? d : this.depth[k]!)
            this.s[k] = ss[i]! + (ss[i + 1]! - ss[i]!) * t
            this.id[k] = id
            this.angle[k] = as[i]! + (as[i + 1]! - as[i]!) * t
          }
        }
      }
    }
    this.strands++
  }

  /** 编码成两张图 / encode as the two images */
  encode(): { a: Uint8Array; b: Uint8Array } {
    const n = ATLAS_SIZE * ATLAS_SIZE
    const a = new Uint8Array(n * 4), b = new Uint8Array(n)
    const q = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255)
    // 随机数只要 16 级、深度 32 级、偏角 64 级：贴图集压得小很多，看不出差别 / the random number needs only 16 levels, depth 32 and angle 64: the atlas compresses far better with no visible difference
    const lv = (v: number, n: number): number => Math.round(Math.min(1, Math.max(0, v)) * (n - 1)) / (n - 1)
    for (let k = 0; k < n; k++) {
      const c = this.cov[k]!
      if (c <= 0) continue
      a[k * 4] = q(c)
      a[k * 4 + 1] = q(this.s[k]! * c)
      a[k * 4 + 2] = q(lv(this.id[k]!, 16) * c)
      a[k * 4 + 3] = q(lv(this.depth[k] === -Infinity ? 0.5 : this.depth[k]!, 32) * c)
      b[k] = q(lv(this.angle[k]!, 64) * c)
    }
    return { a, b }
  }
}

export interface TileStrandOptions {
  kind: CardKind
  /** 纤维直径（米）/ fibre diameter (m) */
  diameter: number
  /** 插值出的发丝数；0 = 只画簇里的发丝本身 / interpolated strands; 0 = draw the group's own strands only */
  count: number
  /** 根部偏移的半径（米）、向梢收拢的比例、随机游走的幅度（米）/ root offset radius (m), how much it gathers towards the tip, random-walk amplitude (m) */
  spread: number
  clump: number
  wander: number
  seed: number
}

/** 把一张发片的发丝画进它的贴图格 / draw a card's strands into its tile */
export function renderTile(atlas: Atlas, rect: [number, number, number, number], card: Card, strands: Strand[], o: TileStrandOptions): void {
  const r = rng(o.seed)
  const members = card.members.map((i) => strands[i]!)
  let cardLen = 0
  for (let k = 1; k < card.centre.length; k++) cardLen += len(sub(card.centre[k]!, card.centre[k - 1]!))
  const paths: { pts: V3[]; id: number }[] = []
  if (o.count === 0) for (const m of members) paths.push({ pts: m.pts, id: r() })
  else {
    for (let j = 0; j < o.count; j++) {
      const g = members[j % members.length]!
      const n = g.root.n
      const t1 = norm(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), t2 = cross(n, t1)
      const a = r() * 2 * Math.PI, rad = o.spread * Math.sqrt(r())
      const off = add(scale(t1, Math.cos(a) * rad), scale(t2, Math.sin(a) * rad))
      const lenScale = 0.82 + 0.2 * r()
      const pts: V3[] = []
      let wx = 0, wy = 0
      const N = g.pts.length
      const keep = Math.min(N, Math.max(2, Math.round(N * lenScale)))
      for (let k = 0; k < keep; k++) {
        const s = k / (N - 1)
        wx += gauss(r) * o.wander / Math.sqrt(N)
        wy += gauss(r) * o.wander / Math.sqrt(N)
        pts.push(add(add(g.pts[k]!, scale(off, 1 - o.clump * s)), add(scale(t1, wx * s), scale(t2, wy * s))))
      }
      paths.push({ pts, id: r() })
    }
  }
  const [, , tw, th] = rect
  const range = DEPTH_RANGE[o.kind]
  for (const { pts: raw, id } of paths) {
    const pts = smoothPath(raw, 4)
    const xs: number[] = [], ys: number[] = [], ws: number[] = [], ss: number[] = [], ds: number[] = [], as: number[] = []
    let arc = 0
    let total = 0
    for (let k = 1; k < pts.length; k++) total += len(sub(pts[k]!, pts[k - 1]!))
    let prevU = 0
    for (let k = 0; k < pts.length; k++) {
      if (k > 0) arc += len(sub(pts[k]!, pts[k - 1]!))
      const s = arc / cardLen
      if (s > 1) break
      const cs = cardSpace(card, pts[k]!, s)
      const u = cs.u
      xs.push((u + 0.5) * tw)
      ys.push(s * th)
      // 发梢最后 15% 变细 / the last 15 % of the strand tapers
      const taper = Math.min(1, (1 - arc / total) / 0.15)
      ws.push((o.diameter / cs.w) * tw * Math.max(0.15, taper))
      ss.push(s)
      ds.push(0.5 + cs.depth / (2 * range))
      const du = (u - prevU) * cs.w, dsW = k > 0 ? len(sub(pts[k]!, pts[k - 1]!)) : 1
      as.push(k > 0 ? 0.5 + Math.atan2(du, Math.max(1e-9, Math.sqrt(Math.max(0, dsW * dsW - du * du)))) / Math.PI : 0.5)
      prevU = u
    }
    if (as.length > 1) as[0] = as[1]!
    if (xs.length > 1) atlas.draw(rect, xs, ys, ws, ss, ds, as, id)
  }
}

/** Catmull–Rom 细分：每段分成 n 段，折线变光滑的曲线 / Catmull–Rom subdivision: each segment split into n, turning the polyline into a smooth curve */
export function smoothPath(p: V3[], n: number): V3[] {
  if (p.length < 3) return p
  const out: V3[] = []
  for (let i = 0; i + 1 < p.length; i++) {
    const p0 = p[Math.max(0, i - 1)]!, p1 = p[i]!, p2 = p[i + 1]!, p3 = p[Math.min(p.length - 1, i + 2)]!
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t
      const q: V3 = [0, 0, 0]
      for (let d = 0; d < 3; d++) q[d] = 0.5 * (2 * p1[d]! + (-p0[d]! + p2[d]!) * t + (2 * p0[d]! - 5 * p1[d]! + 4 * p2[d]! - p3[d]!) * t2 + (-p0[d]! + 3 * p1[d]! - 3 * p2[d]! + p3[d]!) * t3)
      out.push(q)
    }
  }
  out.push(p[p.length - 1]!)
  return out
}
