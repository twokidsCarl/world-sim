// 眉毛和睫毛。
// 眉毛：形状取发布的眉毛外壳在皮肤上的投影（每个人体自己的），按文献的根数撒根；方向按"内端朝上、上缘朝外下、下缘朝外上"，
// 以很小的角度出皮肤、贴着皮肤长。
// 睫毛：沿每个人体自己的睑缘链（内眦 → 外眦）分几排生长，先朝前出、再往上（上睑）或往下（下睑）弯，外侧的向外撒开。
// Eyebrows and eyelashes.
// Eyebrows: the shape is the shipped eyebrow shell projected onto the skin (each body's own), with roots scattered by
// the counts from the literature; directions follow "the medial end points up, the top edge outward and down, the
// bottom edge outward and up"; hairs leave the skin at a shallow angle and lie along it.
// Eyelashes: grown in a few rows along each body's own lid-margin chains (medial → lateral canthus), first forward,
// then curving up (upper lid) or down (lower lid); the lateral ones fan outward.

import { type HeadFrame, fromHeadDir, toHead } from './frame.ts'
import { type Surface, type V3, add, at, cross, dot, gauss, len, mix, norm, rng, rotate, scale, sub, tangential } from './geom.ts'
import { type Root, rootAt, scatter } from './sample.ts'
import type { Params } from './scalp.ts'
import type { BodyData } from './skin.ts'
import type { Strand } from './strands.ts'

/** 一侧眉毛在头部坐标里的轮廓：沿眉的方向分段，每段的上下边界 / one eyebrow's outline in head coordinates: bands along the brow, each with a top and bottom */
interface BrowOutline {
  side: number
  x0: number
  x1: number
  lo: number[]
  hi: number[]
}

const BINS = 12

function browOutlines(b: BodyData, f: HeadFrame): BrowOutline[] {
  const H = b.browShell.positions
  const out: BrowOutline[] = []
  for (const side of [1, -1]) {
    const pts: V3[] = []
    for (let i = 0; i < H.length / 3; i++) {
      const l = toHead(f, at(H, i))
      if (Math.sign(l[0]) === side) pts.push(l)
    }
    const xs = pts.map((p) => Math.abs(p[0]))
    const x0 = Math.min(...xs), x1 = Math.max(...xs)
    const lo = new Array<number>(BINS).fill(Infinity), hi = new Array<number>(BINS).fill(-Infinity)
    for (const p of pts) {
      const k = Math.min(BINS - 1, Math.floor(((Math.abs(p[0]) - x0) / (x1 - x0)) * BINS))
      lo[k] = Math.min(lo[k]!, p[1])
      hi[k] = Math.max(hi[k]!, p[1])
    }
    // 空段用两边插值 / empty bands are filled from their neighbours
    for (let k = 0; k < BINS; k++) {
      if (isFinite(lo[k]!)) continue
      const a = k - 1 >= 0 ? k - 1 : k + 1
      lo[k] = lo[a]!
      hi[k] = hi[a]!
    }
    out.push({ side, x0, x1, lo, hi })
  }
  return out
}

/** 头部坐标的一点在哪条眉里：返回 s（0 内端 → 1 外端）、v（−1 下缘 → 1 上缘）；不在为 null / where a head-coordinate point lies in a brow: s (0 medial → 1 lateral), v (−1 bottom → 1 top); null outside */
function browCoords(o: BrowOutline, l: V3): { s: number; v: number } | null {
  if (Math.sign(l[0]) !== o.side) return null
  const s = (Math.abs(l[0]) - o.x0) / (o.x1 - o.x0)
  if (s < 0 || s > 1) return null
  const x = s * (BINS - 1)
  const k = Math.min(BINS - 2, Math.floor(x)), t = x - k
  const lo = o.lo[k]! * (1 - t) + o.lo[k + 1]! * t, hi = o.hi[k]! * (1 - t) + o.hi[k + 1]! * t
  const mid = (lo + hi) / 2, half = Math.max(0.0015, (hi - lo) / 2)
  const v = (l[1] - mid) / half
  if (Math.abs(v) > 1) return null
  return { s, v }
}

/** 眉毛：每侧一组发丝 / eyebrows: a set of hairs per side */
export function browGroom(b: BodyData, f: HeadFrame, surface: Surface, P: Params, seed: number): { strands: Strand[]; area: number } {
  const outlines = browOutlines(b, f)
  const tris: [number, number, number][] = []
  const I = b.skin.indices, Pp = b.skin.positions
  for (let t = 0; t < I.length; t += 3) {
    const tri: [number, number, number] = [I[t]!, I[t + 1]!, I[t + 2]!]
    if (tri.some((v) => outlines.some((o) => browCoords(o, toHead(f, at(Pp, v))) !== null))) tris.push(tri)
  }
  // 先量出眉的面积，再按每条眉的根数定密度；两端（尤其外端）稀一些 / measure the brow area first, then set the density from the hairs per brow; both ends (the tail most) are sparser
  const profile = (s: number, v: number): number => (1 - 0.55 * Math.max(0, s - 0.6) / 0.4) * (1 - 0.5 * v * v) * Math.min(1, s / 0.08 + 0.3)
  const unit = scatter(Pp, b.normals, tris, (p) => {
    const l = toHead(f, p)
    for (const o of outlines) {
      const c = browCoords(o, l)
      if (c) return 1e6 * profile(c.s, c.v)
    }
    return 0
  }, seed, 4)
  const area = unit.length / 1e6 / 2 // 每侧（平方米，按权重）/ per side (m², weighted)
  const target = P.browCount.value as number
  const roots = scatter(Pp, b.normals, tris, (p) => {
    const l = toHead(f, p)
    for (const o of outlines) {
      const c = browCoords(o, l)
      if (c) return (target / area) * profile(c.s, c.v)
    }
    return 0
  }, seed + 1, 6)
  const r = rng(seed + 2)
  const exit = (P.browDirection.exitAngleDeg * Math.PI) / 180
  const L0 = P.browLength.value / 1000
  const strands = roots.map((root, i) => {
    const l = toHead(f, root.p)
    const o = outlines.find((x) => browCoords(x, l))!
    const { s, v } = browCoords(o, l)!
    // 与"外侧水平"的夹角（度）：内端 80°，中段 25°，尾端 −15°；上缘的毛向下偏、下缘的向上偏
    // angle from "lateral horizontal" (degrees): 80° at the medial end, 25° mid-brow, −15° at the tail; top-edge hairs tilt down, bottom-edge hairs up
    const base = s < 0.18 ? 80 - (s / 0.18) * 50 : s < 0.6 ? 30 - ((s - 0.18) / 0.42) * 25 : 5 - ((s - 0.6) / 0.4) * 20
    const ang = ((base - 14 * v + 6 * gauss(r)) * Math.PI) / 180
    const lateral = fromHeadDir(f, [o.side, 0, 0]), up = f.y
    const dir = norm(tangential(add(scale(lateral, Math.cos(ang)), scale(up, Math.sin(ang))), root.n))
    const L = L0 * (s < 0.15 ? 0.7 : s > 0.8 ? 0.8 : 1) * (1 + 0.15 * gauss(r))
    return lieAlong(surface, root, dir, Math.max(0.003, L), exit, 5, 0.00025, i)
  })
  return { strands, area }
}

/** 一根贴着皮肤长的短毛：以 `exit` 角出皮肤，然后弯向皮肤、保持在皮肤外 `gap` 处 / a short hair lying along the skin: leaves at `exit`, then bends towards it and stays `gap` above it */
function lieAlong(surface: Surface, root: Root, dir: V3, L: number, exit: number, points: number, gap: number, seed: number): Strand {
  const seg = L / (points - 1)
  let d = norm(add(scale(dir, Math.cos(exit)), scale(root.n, Math.sin(exit))))
  const pts: V3[] = [root.p]
  let n = root.n
  for (let k = 1; k < points; k++) {
    let p = add(pts[k - 1]!, scale(d, seg))
    const c = surface.closest(p, 0.01)
    if (c) {
      n = c.normal
      const h = dot(sub(p, c.point), c.normal)
      if (h < gap) p = add(c.point, scale(c.normal, gap))
    }
    pts.push(p)
    // 往皮肤方向弯 / bend towards the skin
    d = norm(mix(d, norm(tangential(d, n)), 0.5))
  }
  return { root, pts, layer: 0, phase: (seed * 0.618) % 1 }
}

export interface Lash extends Strand {
  /** 上睑 / 下睑 / upper / lower lid */
  upper: boolean
  side: number
  /** 沿睑缘的位置（0 内眦 → 1 外眦）/ position along the margin (0 medial → 1 lateral) */
  t: number
  row: number
}

/** 睫毛 / eyelashes */
export function lashGroom(b: BodyData, f: HeadFrame, surface: Surface, P: Params, seed: number): Lash[] {
  const r = rng(seed)
  const Pp = b.skin.positions
  const out: Lash[] = []
  const chains: [number[], boolean, number][] = [
    [b.lids.upperL, true, 1],
    [b.lids.lowerL, false, 1],
    [b.lids.upperR, true, -1],
    [b.lids.lowerR, false, -1],
  ]
  for (const [chain, upper, side] of chains) {
    const pts = chain.map((v) => at(Pp, v))
    const cum = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + len(sub(pts[i]!, pts[i - 1]!)))
    const total = cum[cum.length - 1]!
    // 睑缘的中心（睁眼时眼裂的中心附近）/ centre of the margin (near the centre of the open fissure)
    const centre = scale(pts.reduce((a, p) => add(a, p), [0, 0, 0] as V3), 1 / pts.length)
    const count = Math.round(upper ? P.lashCountUpper.value : P.lashCountLower.value)
    const rows = upper ? P.lashRows.upper : P.lashRows.lower
    const Lmean = (upper ? P.lashLengthUpper.value : P.lashLengthLower.value) / 1000
    const at01 = (t: number): { p: V3; tan: V3 } => {
      const s = t * total
      let i = 0
      while (i < cum.length - 2 && cum[i + 1]! < s) i++
      const u = (s - cum[i]!) / ((cum[i + 1]! - cum[i]!) || 1)
      return { p: mix(pts[i]!, pts[i + 1]!, u), tan: norm(sub(pts[i + 1]!, pts[i]!)) }
    }
    for (let k = 0; k < count; k++) {
      const row = k % rows
      // 睫毛长在睑缘外侧 5/6：内眦那一小段（泪小点）没有 / lashes grow along the lateral five sixths of the margin: the short medial stretch (the punctum) has none
      const t = 0.15 + 0.83 * ((k + 0.5 + 0.3 * gauss(r)) / count)
      const { p: m, tan } = at01(Math.min(0.99, Math.max(0.12, t)))
      // 离开眼裂、贴着皮肤往外挪：每排 0.35 毫米 / away from the fissure along the skin: 0.35 mm per row
      const away = norm(tangential(sub(m, centre), f.z))
      const q = add(m, scale(away, 0.0004 + 0.00035 * row))
      const c = surface.closest(q, 0.004)
      if (!c) continue
      const [va, vb, vc] = surface.triangle(c.face)
      const root = rootAt(Pp, b.normals, [va, vb, vc], c.bary)
      // 长度沿睑缘的分布：内侧短、中外侧最长 / length along the margin: short medially, longest mid-lateral
      const prof = 0.6 + 0.55 * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.1) / 0.95)) ** 0.8)
      // 后排略短；除以各排的平均系数，使整体的中位长度仍等于文献值 / back rows a little shorter; divided by the rows' mean factor so the overall median still equals the literature value
      const rowMean = 1 - 0.06 * (rows - 1)
      const L = (Lmean * prof * (1 - 0.12 * row) * (1 + 0.08 * gauss(r))) / rowMean
      out.push({ ...lashStrand(f, surface, root, tan, upper, side, t, L, r), upper, side, t, row })
    }
  }
  return out
}

function lashStrand(f: HeadFrame, surface: Surface, root: Root, tan: V3, upper: boolean, side: number, t: number, L: number, r: () => number): Strand {
  const points = 6
  const seg = L / (points - 1)
  const fwd = f.z
  const vert = upper ? f.y : scale(f.y, -1)
  // 出睑缘：朝前，上睑略朝下 10°、下睑朝下 15°；外侧向外撒开最多 30°，内侧向内 10°
  // leaving the margin: forward, 10° down for the upper lid and 15° down for the lower; the lateral ones fan out up to 30°, the medial in by 10°
  let d = norm(add(fwd, scale(f.y, upper ? -0.18 : -0.27)))
  const fan = ((t - 0.35) * (t > 0.35 ? 30 / 0.65 : 10 / 0.35) * Math.PI) / 180
  d = rotate(d, f.y, side * fan)
  // 弯曲的总角度：上睑 60°、下睑 25°（本项目的假设）/ total curl: 60° upper, 25° lower (this project's assumption)
  const curl = ((upper ? 60 : 25) * (1 + 0.15 * gauss(r)) * Math.PI) / 180
  const axis = norm(cross(d, vert))
  const pts: V3[] = [root.p]
  for (let k = 1; k < points; k++) {
    let p = add(pts[k - 1]!, scale(d, seg))
    const c = surface.closest(p, 0.003)
    if (c && dot(sub(p, c.point), c.normal) < 0.0003) p = add(c.point, scale(c.normal, 0.0003))
    pts.push(p)
    d = rotate(d, axis, curl / (points - 1))
  }
  void tan
  return { root, pts, layer: 0, phase: 0 }
}
