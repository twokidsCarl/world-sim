// 发片：把相邻、走向相近的发丝聚成一簇（k 均值），每簇做成一条沿中心线的带子；带子的宽度取簇内发丝在侧向上的散布。
// 低一级的细节层次用更少、更宽的簇。每条发片的根投到皮肤上，记下三角形的三个顶点和重心坐标。
// Hair cards: neighbouring strands running alike are grouped (k-means), and each group becomes a strip along its centre
// line; the strip's width is the group's spread sideways. Lower levels of detail use fewer, wider groups. Each card's
// root is projected onto the skin, recording the triangle's three vertices and barycentric coordinates.

import type { HeadFrame } from './frame.ts'
import { type Surface, type V3, add, cross, dot, len, mix, norm, rng, scale, sub, hash01 } from './geom.ts'
import { type Root, rootAt } from './sample.ts'
import type { BodyData } from './skin.ts'
import { outward, resample, type Strand } from './strands.ts'

export interface Card {
  /** 中心线（段数 + 1 个环）/ centre line (segments + 1 rings) */
  centre: V3[]
  /** 每个环的侧向单位向量和宽度（米）/ per ring: sideways unit vector and width (m) */
  side: V3[]
  width: number[]
  /** 每个环的两个顶点（世界坐标）/ the two vertices of each ring (world) */
  verts: V3[]
  root: Root
  layer: number
  members: number[]
  tile: number
}

export interface CardOptions {
  clusters: number
  segments: number
  minWidth: number
  maxWidth: number
  /** 发梢处宽度的比例 / width ratio at the tip */
  tipWidth: number
  /** 侧向：'scalp' 贴着头的外表面，'skin' 贴着根部的皮肤，'spread' 沿各根的连线 / sideways: 'scalp' along the head's outer surface, 'skin' along the skin at the root, 'spread' along the line through the roots */
  orient: 'scalp' | 'skin' | 'spread'
  /** 顶点离皮肤至少这么远（米）/ keep vertices at least this far out of the skin (m) */
  clearance: number
  /** 中心线平滑的遍数 / passes of centre-line smoothing */
  smooth?: number
  /** 按顺序分组（睫毛），不用 k 均值 / group in order (lashes) instead of k-means */
  sequential?: number[][]
}

/** k 均值；返回每个点所属的簇 / k-means; returns each point's cluster */
export function kmeans(feat: Float32Array, dim: number, k: number, iters: number, seed: number): Int32Array {
  const n = feat.length / dim
  const r = rng(seed)
  k = Math.max(1, Math.min(k, n))
  // 初值：均匀抽样 / initial centres: an even sample
  const order = Array.from({ length: n }, (_, i) => i).sort(() => r() - 0.5)
  const cen = new Float32Array(k * dim)
  for (let c = 0; c < k; c++) for (let d = 0; d < dim; d++) cen[c * dim + d] = feat[order[c]! * dim + d]!
  const asg = new Int32Array(n)
  // 用网格加速最近中心的查找（前三维是根的位置）/ a grid speeds up the nearest-centre search (the first three dimensions are the root position)
  for (let it = 0; it < iters; it++) {
    const cell = 0.012
    const grid = new Map<string, number[]>()
    for (let c = 0; c < k; c++) {
      const key = `${Math.floor(cen[c * dim]! / cell)},${Math.floor(cen[c * dim + 1]! / cell)},${Math.floor(cen[c * dim + 2]! / cell)}`
      const l = grid.get(key)
      if (l) l.push(c)
      else grid.set(key, [c])
    }
    for (let i = 0; i < n; i++) {
      let best = -1, bd = Infinity
      const gx = Math.floor(feat[i * dim]! / cell), gy = Math.floor(feat[i * dim + 1]! / cell), gz = Math.floor(feat[i * dim + 2]! / cell)
      for (let reach = 1; reach <= 6 && best < 0; reach += 2) {
        for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) for (let dz = -reach; dz <= reach; dz++) {
          const l = grid.get(`${gx + dx},${gy + dy},${gz + dz}`)
          if (!l) continue
          for (const c of l) {
            let d2 = 0
            for (let d = 0; d < dim; d++) d2 += (feat[i * dim + d]! - cen[c * dim + d]!) ** 2
            if (d2 < bd) (bd = d2), (best = c)
          }
        }
      }
      if (best < 0) {
        for (let c = 0; c < k; c++) {
          let d2 = 0
          for (let d = 0; d < dim; d++) d2 += (feat[i * dim + d]! - cen[c * dim + d]!) ** 2
          if (d2 < bd) (bd = d2), (best = c)
        }
      }
      asg[i] = best
    }
    const sum = new Float64Array(k * dim), cnt = new Int32Array(k)
    for (let i = 0; i < n; i++) {
      const a = asg[i]!
      cnt[a] = cnt[a]! + 1
      for (let d = 0; d < dim; d++) sum[a * dim + d] = sum[a * dim + d]! + feat[i * dim + d]!
    }
    for (let c = 0; c < k; c++) if (cnt[c]) for (let d = 0; d < dim; d++) cen[c * dim + d] = sum[c * dim + d]! / cnt[c]!
  }
  return asg
}

/** 把发丝做成发片 / turn strands into cards */
export function makeCards(b: BodyData, f: HeadFrame, surface: Surface, strands: Strand[], o: CardOptions, seed: number): Card[] {
  let groups: number[][]
  if (o.sequential) groups = o.sequential
  else {
    // 特征：根、中点、梢（越往梢权重越小）/ features: root, middle, tip (less weight towards the tip)
    const dim = 9
    const feat = new Float32Array(strands.length * dim)
    strands.forEach((s, i) => {
      const m = s.pts[Math.floor(s.pts.length / 2)]!, t = s.pts[s.pts.length - 1]!
      feat.set([...s.root.p, ...scale(m, 0.5), ...scale(t, 0.25)], i * dim)
    })
    const asg = kmeans(feat, dim, o.clusters, 12, seed)
    const map = new Map<number, number[]>()
    asg.forEach((c, i) => {
      const l = map.get(c)
      if (l) l.push(i)
      else map.set(c, [i])
    })
    groups = [...map.values()]
  }
  const cards: Card[] = []
  for (const members of groups) {
    if (!members.length) continue
    const ms = members.map((i) => strands[i]!)
    const N = ms[0]!.pts.length
    const mean: V3[] = []
    for (let k = 0; k < N; k++) {
      let p: V3 = [0, 0, 0]
      for (const s of ms) p = add(p, s.pts[Math.min(k, s.pts.length - 1)]!)
      mean.push(scale(p, 1 / ms.length))
    }
    // 发片从最上游的根开始，而不是从各根的平均位置：否则发际线和分缝处会空出一条
    // the card starts at the most upstream root rather than at the roots' mean: otherwise a strip is left bare at the hairline and the part
    if (o.orient === 'scalp' && ms.length > 1) {
      const t0 = norm(sub(mean[1]!, mean[0]!))
      let lo = 0
      for (const st of ms) lo = Math.min(lo, dot(sub(st.root.p, mean[0]!), t0))
      if (lo < -1e-4) mean.unshift(add(mean[0]!, scale(t0, lo)))
    }
    // 中心线先做滑动平均：波纹留给贴图，几何只保留整体的走势（否则段数不够时折成锯齿）
    // the centre line is smoothed by a moving average first: the waves are left to the texture and the geometry keeps only the overall course (otherwise too few segments fold it into a zigzag)
    const smoothN = o.smooth ?? 0
    for (let pass = 0; pass < smoothN; pass++) {
      const prev = mean.map((p) => p)
      for (let k = 2; k < mean.length - 1; k++) mean[k] = scale(add(add(prev[k - 1]!, prev[k]!), prev[k + 1]!), 1 / 3)
    }
    const centre = resample(mean, o.segments + 1)
    const R = centre.length
    const side: V3[] = [], width: number[] = []
    let prevSide: V3 | null = null
    for (let k = 0; k < R; k++) {
      const t = norm(sub(centre[Math.min(R - 1, k + 1)]!, centre[Math.max(0, k - 1)]!))
      let s: V3
      if (o.orient === 'scalp') s = cross(t, outward(f, centre[k]!))
      else if (o.orient === 'skin') s = cross(t, ms[0]!.root.n)
      else {
        const spread = ms.length > 1 ? sub(ms[ms.length - 1]!.root.p, ms[0]!.root.p) : cross(t, f.y)
        s = sub(spread, scale(t, dot(spread, t)))
      }
      s = len(s) < 1e-6 && prevSide ? prevSide : norm(s)
      if (prevSide && dot(s, prevSide) < 0) s = scale(s, -1)
      prevSide = s
      side.push(s)
      // 簇内发丝在侧向上的散布 / the group's spread sideways
      const fk = k / (R - 1)
      let m2 = 0
      for (const st of ms) {
        const p = st.pts[Math.min(st.pts.length - 1, Math.round(fk * (st.pts.length - 1)))]!
        m2 += dot(sub(p, centre[k]!), s) ** 2
      }
      const spread = 2.5 * Math.sqrt(m2 / ms.length)
      const w = Math.min(o.maxWidth, Math.max(o.minWidth, spread + o.minWidth * 0.5))
      width.push(w * (1 - (1 - o.tipWidth) * fk * fk))
    }
    // 根：中心线起点投到皮肤 / the root: the centre line's start projected onto the skin
    const c = surface.closest(centre[0]!, 0.02)
    if (!c) continue
    const [va, vb, vc] = surface.triangle(c.face)
    const root = rootAt(b.skin.positions, b.normals, [va, vb, vc], c.bary)
    centre[0] = root.p
    const verts: V3[] = []
    for (let k = 0; k < R; k++) {
      for (const sgn of [-1, 1]) {
        let p = add(centre[k]!, scale(side[k]!, (sgn * width[k]!) / 2))
        // 查 3 厘米内：平滑后的中心线或横向展开可能陷进身体一两厘米 / search within 3 cm: the smoothed centre line or the sideways spread can sink a centimetre or two into the body
        const q = surface.closest(p, 0.03)
        if (q && dot(sub(p, q.point), q.normal) < o.clearance) p = add(q.point, scale(q.normal, o.clearance))
        verts.push(p)
      }
    }
    const layer = ms.reduce((a, s) => a + s.layer, 0) / ms.length
    cards.push({ centre, side, width, verts, root, layer, members, tile: 0 })
  }
  cards.forEach((c, i) => (c.tile = Math.floor(hash01(i, seed) * 1e6)))
  return cards
}

/** 一簇发丝放进发片自己的坐标：s 沿中心线（0 根 → 1 梢）、u 横向（−0.5 … 0.5）、深度（米，向外为正）/ a group's strands in the card's own coordinates: s along the centre line (0 root → 1 tip), u across (−0.5 … 0.5), depth (m, outward positive) */
export function cardSpace(card: Card, p: V3, s: number): { u: number; depth: number; w: number } {
  const R = card.centre.length
  const x = s * (R - 1)
  const k = Math.min(R - 2, Math.floor(x)), t = x - k
  const c = mix(card.centre[k]!, card.centre[k + 1]!, t)
  const side = norm(mix(card.side[k]!, card.side[k + 1]!, t))
  const w = card.width[k]! * (1 - t) + card.width[k + 1]! * t
  const tan = norm(sub(card.centre[k + 1]!, card.centre[k]!))
  const n = cross(side, tan)
  const d = sub(p, c)
  return { u: dot(d, side) / w, depth: dot(d, n), w }
}
