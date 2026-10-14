// 裁片的起始摆放：把每片按弧长“卷”到身体对应部位外面一圈（像虚拟试衣那样），缝线两侧大致对齐。
// GarmentCode 的平面摆放只用来定高度、左右和前后；围度方向按身体截面凸包的弧长展开（等距），
// 裁片比截面宽时把这一圈往外放大，使一周的长度等于各片在这一高度的宽度之和。
// Initial placement of the panels: each one is "wrapped" by arc length around the body part it
// belongs to (as virtual try-on systems do), so that the two sides of every seam roughly meet.
// GarmentCode's flat placement only decides height, left/right and front/back; across the girth a
// panel is laid out isometrically along the convex hull of the body's cross-section, and where the
// panels are wider than the section the loop is enlarged so its length equals their summed width.

import type { GarmentMesh, PanelMesh } from './pattern.ts'

type V3 = [number, number, number]

export interface BodyFrame {
  /** 摆好姿势的皮肤顶点 / The posed skin vertices. */
  skin: Float32Array
  index: Uint32Array
  floorY: number
  /** 裆底高度（世界坐标）/ Crotch height (world). */
  crotchY: number
  /** 腋窝高度、颈侧点高度（世界坐标）/ Armpit and side-neck-point heights (world). */
  armpitY: number
  sideNeckY: number
  /** 关节中心（摆好姿势后）/ Joint centres (posed). */
  joint: (id: string) => V3
}

/** 水平截面的点（x, z），只要满足 keep 的 / Points (x, z) of a horizontal cut, those passing `keep`. */
function sliceY(skin: Float32Array, index: Uint32Array, y: number, keep: (x: number, z: number) => boolean): number[] {
  const out: number[] = []
  for (let t = 0; t < index.length; t += 3) {
    let prev = index[t + 2]!
    for (let k = 0; k < 3; k++) {
      const cur = index[t + k]!
      const ya = skin[prev * 3 + 1]! - y, yb = skin[cur * 3 + 1]! - y
      if ((ya > 0) !== (yb > 0)) {
        const s = ya / (ya - yb)
        const x = skin[prev * 3]! + (skin[cur * 3]! - skin[prev * 3]!) * s
        const z = skin[prev * 3 + 2]! + (skin[cur * 3 + 2]! - skin[prev * 3 + 2]!) * s
        if (keep(x, z)) out.push(x, z)
      }
      prev = cur
    }
  }
  return out
}

/** 二维凸包（单调链，逆时针）/ 2-D convex hull (monotone chain, counter-clockwise). */
export function hull2(pts: number[]): number[] {
  const n = pts.length / 2
  if (n < 3) return pts.slice()
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => pts[a * 2]! - pts[b * 2]! || pts[a * 2 + 1]! - pts[b * 2 + 1]!)
  const cross = (o: number, a: number, b: number): number =>
    (pts[a * 2]! - pts[o * 2]!) * (pts[b * 2 + 1]! - pts[o * 2 + 1]!) - (pts[a * 2 + 1]! - pts[o * 2 + 1]!) * (pts[b * 2]! - pts[o * 2]!)
  const lower: number[] = [], upper: number[] = []
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, i) <= 0) lower.pop()
    lower.push(i)
  }
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, i) <= 0) upper.pop()
    upper.push(i)
  }
  const h = lower.slice(0, -1).concat(upper.slice(0, -1))
  return h.flatMap((i) => [pts[i * 2]!, pts[i * 2 + 1]!])
}

/** 凸包上按弧长取点 / A convex loop parameterised by arc length. */
class Loop {
  readonly cum: number[] = [0]
  readonly length: number
  readonly cx: number
  readonly cz: number
  constructor(readonly p: number[]) {
    const n = p.length / 2
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      this.cum.push(this.cum[i]! + Math.hypot(p[j * 2]! - p[i * 2]!, p[j * 2 + 1]! - p[i * 2 + 1]!))
    }
    this.length = this.cum[n]!
    let sx = 0, sz = 0
    for (let i = 0; i < n; i++) {
      sx += p[i * 2]!
      sz += p[i * 2 + 1]!
    }
    this.cx = sx / n
    this.cz = sz / n
  }

  /** 弧长参数 s 处的点和外法线 / Point and outward normal at arc parameter s. */
  at(s: number): [number, number, number, number] {
    const n = this.p.length / 2
    s = ((s % this.length) + this.length) % this.length
    let i = 0
    while (i < n - 1 && this.cum[i + 1]! < s) i++
    const j = (i + 1) % n
    const seg = this.cum[i + 1]! - this.cum[i]!
    const t = seg > 0 ? (s - this.cum[i]!) / seg : 0
    const x = this.p[i * 2]! + (this.p[j * 2]! - this.p[i * 2]!) * t, z = this.p[i * 2 + 1]! + (this.p[j * 2 + 1]! - this.p[i * 2 + 1]!) * t
    // 逆时针多边形的外法线 = 切线顺时针转 90° / outward normal of a counter-clockwise loop = tangent turned 90° clockwise
    let nx = this.p[j * 2 + 1]! - this.p[i * 2 + 1]!, nz = -(this.p[j * 2]! - this.p[i * 2]!)
    const l = Math.hypot(nx, nz) || 1
    nx /= l
    nz /= l
    return [x, z, nx, nz]
  }

  /** 竖线 x = x0 与凸包的交点中 z 最大（front）或最小的那个的弧长参数 / Arc parameter of the crossing of x = x0 with the largest (front) or smallest z. */
  crossing(x0: number, front: boolean): number {
    const n = this.p.length / 2
    let best = NaN, bz = front ? -Infinity : Infinity
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const xa = this.p[i * 2]!, xb = this.p[j * 2]!
      if ((xa - x0) * (xb - x0) > 0 || xa === xb) continue
      const t = (x0 - xa) / (xb - xa)
      const z = this.p[i * 2 + 1]! + (this.p[j * 2 + 1]! - this.p[i * 2 + 1]!) * t
      if (front ? z > bz : z < bz) {
        bz = z
        best = this.cum[i]! + t * (this.cum[i + 1]! - this.cum[i]!)
      }
    }
    if (Number.isNaN(best)) {
      // 竖线没碰到凸包：取 x 最近的顶点 / the line misses the hull: the vertex nearest in x
      let d = Infinity
      for (let i = 0; i < n; i++) {
        const e = Math.abs(this.p[i * 2]! - x0) - (front ? this.p[i * 2 + 1]! : -this.p[i * 2 + 1]!) * 1e-3
        if (e < d) {
          d = e
          best = this.cum[i]!
        }
      }
    }
    return best
  }

  /** 从参数 s0 沿 x 增大的方向走 ds 的符号 / The sign that walks from s0 towards increasing x. */
  xSign(s0: number): number {
    const a = this.at(s0 + 0.005)[0], b = this.at(s0 - 0.005)[0]
    return a >= b ? 1 : -1
  }
}

/** 一片裁片在若干个“行”（按高度或轴向分箱）上的跨度 / A panel's span over rows (binned by height or by axial position). */
class Rows {
  readonly lo = new Map<number, number>()
  readonly hi = new Map<number, number>()
  constructor(readonly bin: number) {}
  add(key: number, c: number): void {
    const k = Math.round(key / this.bin)
    this.lo.set(k, Math.min(this.lo.get(k) ?? Infinity, c))
    this.hi.set(k, Math.max(this.hi.get(k) ?? -Infinity, c))
  }
  span(key: number): [number, number] {
    const k = Math.round(key / this.bin)
    for (let d = 0; d < 50; d++) {
      for (const kk of [k - d, k + d]) {
        const lo = this.lo.get(kk)
        if (lo !== undefined) return [lo, this.hi.get(kk)!]
      }
    }
    return [0, 0]
  }
}

export interface PlaceOptions {
  /** 起始时离皮肤的距离（米）/ Initial distance from the skin (metres). */
  gap: number
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * 算出整件衣服的起始位置（米，世界坐标，摆好姿势的身体外面）。
 * The garment's initial positions (metres, world, around the posed body).
 */
export function placeGarment(g: GarmentMesh, body: BodyFrame, opt: PlaceOptions): Float64Array {
  const out = new Float64Array(g.placed.length)
  const xc = 0.5 * (body.joint('hip_L')[0] + body.joint('hip_R')[0])
  const gh = { L: body.joint('gh_L'), R: body.joint('gh_R') }
  const el = { L: body.joint('elbow_L'), R: body.joint('elbow_R') }
  const ARM_R = 0.055

  // 躯干截面：去掉手臂（按手臂轴线到这一高度的位置）/ trunk sections: arms removed (by where the arm axis is at this height)
  const trunkCache = new Map<number, Loop>()
  const trunk = (y: number): Loop => {
    const k = Math.round(y * 200)
    let l = trunkCache.get(k)
    if (!l) {
      const yy = k / 200
      const lim = (side: 'L' | 'R'): number => {
        const s = gh[side], e = el[side]
        if (yy >= s[1]) return Math.abs(s[0] - xc) + 0.035
        const t = (yy - s[1]) / (e[1] - s[1])
        const ax = Math.abs(s[0] + (e[0] - s[0]) * Math.min(t, 1.5) - xc)
        return Math.max(Math.abs(s[0] - xc) - 0.04, ax - ARM_R * 1.3)
      }
      const limL = lim('L'), limR = lim('R')
      const pts = sliceY(body.skin, body.index, yy, (x) => (x >= xc ? x - xc < limL : xc - x < limR) && Math.abs(x - xc) < 0.32)
      l = new Loop(hull2(pts))
      trunkCache.set(k, l)
    }
    return l
  }
  const legCache = new Map<string, Loop>()
  const leg = (y: number, side: 'L' | 'R'): Loop => {
    // 脚底附近的截面太小（甚至没有）：最低取到地面以上 4 cm / sections near the sole are tiny or empty: no lower than 4 cm above the floor
    const k = Math.round(Math.max(y, body.floorY + 0.04) * 200)
    const key = `${side}${k}`
    let l = legCache.get(key)
    if (!l) {
      const sgn = side === 'L' ? 1 : -1
      const pts = sliceY(body.skin, body.index, k / 200, (x) => sgn * (x - xc) > 0.005 && sgn * (x - xc) < 0.32)
      l = new Loop(hull2(pts))
      legCache.set(key, l)
    }
    return l
  }

  // 上衣：整体抬高，使躯干片的最高点（颈侧）落在我们身体的颈侧点高度；GarmentCode 的高度按它自己的
  // 人体比例推算，在我们的身体上低了几厘米，衣服会挂不上肩
  // tops: lifted as a whole so the highest torso-panel point (side of the neck) sits at our body's
  // side-neck height; GarmentCode derives heights from its own body proportions, which on our bodies
  // come out a few centimetres low, and the garment would not hang from the shoulders
  let lift = 0
  if (g.panels.some((p) => p.name.includes('torso'))) {
    let top = -Infinity
    for (const p of g.panels) if (p.name.includes('torso')) for (let i = 0; i < p.count; i++) top = Math.max(top, p.placed[i * 3 + 1]! + body.floorY)
    lift = body.sideNeckY - top
  }
  // 每片在各高度的跨度（GarmentCode 的平面摆放，米）/ each panel's span at each height (GarmentCode's flat placement, metres)
  const Y = (p: PanelMesh, i: number): number => p.placed[i * 3 + 1]! + body.floorY + lift
  const X = (p: PanelMesh, i: number): number => p.placed[i * 3]!
  const rowsOf = new Map<PanelMesh, Rows>()
  for (const p of g.panels) {
    if (p.part.startsWith('arm')) continue
    const r = new Rows(0.01)
    for (let i = 0; i < p.count; i++) r.add(Y(p, i), X(p, i))
    rowsOf.set(p, r)
  }
  const torsoPanels = g.panels.filter((p) => p.part === 'torso' || p.part.startsWith('leg'))
  const widthAt = (y: number, panels: PanelMesh[]): number => panels.reduce((s, p) => {
    const [lo, hi] = rowsOf.get(p)!.span(y)
    return s + Math.max(0, hi - lo)
  }, 0)

  const torsoPoint = (p: PanelMesh, i: number): V3 => {
    const y = Y(p, i)
    const loop = trunk(Math.min(y, body.sideNeckY - 0.01))
    const [lo, hi] = rowsOf.get(p)!.span(y)
    // 裁片在中线哪一侧：跨中线的按中线，否则从靠中线的那一端量起
    // which side of the midline: a panel across it measures from the midline, otherwise from its end nearest the midline
    const x = X(p, i)
    const s = lo < 0 && hi > 0 ? x : lo >= 0 ? x - lo : x - hi
    // 腋下以上不放大（那里裁片宽度包括袖窿以上的肩部）/ no enlarging above the armpit (the panel width there includes the shoulder above the armhole)
    const W = y > body.armpitY ? 0 : widthAt(y, torsoPanels)
    const gap = Math.max(opt.gap, (W - loop.length) / (2 * Math.PI))
    const s0 = loop.crossing(xc, p.front)
    // 弧长量在外扩 gap 后的那一圈上：换回原凸包上的参数 / arc length is measured on the loop offset by `gap`: converted back to the hull's parameter
    const sb = (s * loop.length) / (loop.length + 2 * Math.PI * gap)
    const [hx, hz, nx, nz] = loop.at(s0 + loop.xSign(s0) * Math.max(-loop.length / 2, Math.min(loop.length / 2, sb)))
    return [hx + nx * gap, y, hz + nz * gap]
  }

  const legPoint = (p: PanelMesh, i: number, side: 'L' | 'R'): V3 => {
    const y = Y(p, i)
    const loop = leg(y, side)
    const [lo, hi] = rowsOf.get(p)!.span(y)
    const s = X(p, i) - (lo + hi) / 2
    const mates = g.panels.filter((q) => q.part === p.part)
    const W = widthAt(y, mates)
    const gap = Math.max(opt.gap, (W - loop.length) / (2 * Math.PI))
    let minX = Infinity, maxX = -Infinity
    for (let k = 0; k < loop.p.length; k += 2) {
      minX = Math.min(minX, loop.p[k]!)
      maxX = Math.max(maxX, loop.p[k]!)
    }
    const s0 = loop.crossing((minX + maxX) / 2, p.front)
    const sb = (s * loop.length) / (loop.length + 2 * Math.PI * gap)
    const [hx, hz, nx, nz] = loop.at(s0 + loop.xSign(s0) * Math.max(-loop.length / 2, Math.min(loop.length / 2, sb)))
    return [hx + nx * gap, y, hz + nz * gap]
  }

  // 裆前最靠前的皮肤（中线 ±6 cm、裆底上下）/ the most anterior skin in front of the crotch (midline ±6 cm, around the crotch level)
  const crotch = { halfWidth: 0.06, front: -Infinity }
  for (let v = 0; v < body.skin.length; v += 3) {
    const x = body.skin[v]!, y = body.skin[v + 1]!
    if (Math.abs(x - xc) < crotch.halfWidth && y > body.crotchY - 0.12 && y < body.crotchY + 0.08) crotch.front = Math.max(crotch.front, body.skin[v + 2]!)
  }
  for (const p of g.panels) {
    if (p.part.startsWith('arm')) {
      placeSleeve(g, p, body, opt, out, xc)
      continue
    }
    for (let i = 0; i < p.count; i++) {
      let q: V3
      if (p.part.startsWith('leg')) {
        const side = p.part.endsWith('L') ? 'L' : 'R'
        const y = Y(p, i)
        const t = smooth(body.crotchY - 0.08, body.crotchY + 0.01, y)
        if (t >= 1) q = torsoPoint(p, i)
        else if (t <= 0) q = legPoint(p, i, side)
        else {
          const a = legPoint(p, i, side), b = torsoPoint(p, i)
          q = [a[0] + (b[0] - a[0]) * t, y, a[2] + (b[2] - a[2]) * t]
        }
      } else q = torsoPoint(p, i)
      // 裆前：前片靠中线的部分放到外生殖器前面（否则缝合后它们会从布里穿出来）
      // in front of the crotch: the part of a front panel near the midline is put in front of the external genitalia
      // (otherwise they end up poking through the cloth once it is sewn)
      if (p.front && p.part.startsWith('leg') && Math.abs(q[0] - xc) < crotch.halfWidth && q[1] > body.crotchY - 0.12 && q[1] < body.crotchY + 0.08) {
        q[2] = Math.max(q[2], crotch.front + opt.gap)
      }
      out.set(q, (p.offset + i) * 3)
    }
  }
  return out
}

/** 袖片：绕上臂轴线卷成圆筒，袖山顶在肩端 / Sleeves: rolled into a tube around the upper-arm axis, the cap at the shoulder end. */
function placeSleeve(g: GarmentMesh, p: PanelMesh, body: BodyFrame, opt: PlaceOptions, out: Float64Array, xc: number): void {
  const side = p.part.endsWith('L') ? 'L' : 'R'
  const sgn = side === 'L' ? 1 : -1
  const s = body.joint(`gh_${side}`), e = body.joint(`elbow_${side}`)
  let d: V3 = [e[0] - s[0], e[1] - s[1], e[2] - s[2]]
  const dl = Math.hypot(...d)
  d = [d[0] / dl, d[1] / dl, d[2] / dl]
  // 前方 f：+z 去掉沿轴分量；上外侧 l：额状面内与轴垂直、朝上外 / anterior f: +z minus its axial part; upper-lateral l: in the frontal plane, perpendicular to the axis, pointing up and out
  let f: V3 = [-d[2] * d[0], -d[2] * d[1], 1 - d[2] * d[2]]
  const fl = Math.hypot(...f)
  f = [f[0] / fl, f[1] / fl, f[2] / fl]
  let l: V3 = [d[1] * f[2] - d[2] * f[1], d[2] * f[0] - d[0] * f[2], d[0] * f[1] - d[1] * f[0]]
  if (l[0] * sgn < 0) l = [-l[0], -l[1], -l[2]]
  // GarmentCode 摆放里袖子的轴向（朝下）和上外侧方向 / the sleeve's axial (downward) and upper-lateral directions in GarmentCode's placement
  const mates = g.panels.filter((q) => q.part === p.part)
  const frame = (q: PanelMesh): { a: (i: number) => number; c: (i: number) => number } => {
    // 由裁片局部坐标轴算：x 沿袖长，y 朝上外 / from the panel's local axes: x along the sleeve, y up and out
    const o = q.placed
    const i0 = 0
    // 局部 x 方向在三维中的方向：用两个局部 x 不同、y 相近的点估计 / the 3-D direction of local x, from the panel's placement
    const R = localAxes(q)
    let ax = R.x, ay = R.y
    if (ax[1] > 0) ax = [-ax[0], -ax[1], -ax[2]]
    void i0
    return {
      a: (i) => o[i * 3]! * ax[0] + o[i * 3 + 1]! * ax[1] + o[i * 3 + 2]! * ax[2],
      c: (i) => o[i * 3]! * ay[0] + o[i * 3 + 1]! * ay[1] + o[i * 3 + 2]! * ay[2],
    }
  }
  // 各片的轴向起点（袖山端）对齐到同一处：取所有袖片轴向坐标的最小值 / all sleeve panels share the cap end: the minimum axial coordinate over them
  let a0 = Infinity
  const fr = new Map(mates.map((q) => [q, frame(q)]))
  for (const q of mates) for (let i = 0; i < q.count; i++) a0 = Math.min(a0, fr.get(q)!.a(i))
  const rows = new Map(mates.map((q) => {
    const r = new Rows(0.01)
    for (let i = 0; i < q.count; i++) r.add(fr.get(q)!.a(i) - a0, fr.get(q)!.c(i))
    return [q, r]
  }))
  const me = fr.get(p)!
  const CAP = 0.045
  for (let i = 0; i < p.count; i++) {
    const a = me.a(i) - a0
    const [lo, hi] = rows.get(p)!.span(a)
    const c = me.c(i) - (lo + hi) / 2
    const W = mates.reduce((sum, q) => {
      const [l2, h2] = rows.get(q)!.span(a)
      return sum + (h2 - l2)
    }, 0)
    const R = Math.max(0.055 + opt.gap, W / (2 * Math.PI))
    const phi = c / R
    const fwd = p.front ? 1 : -1
    const along = a - CAP
    const dir: V3 = [fwd * Math.cos(phi) * f[0] + Math.sin(phi) * l[0], fwd * Math.cos(phi) * f[1] + Math.sin(phi) * l[1], fwd * Math.cos(phi) * f[2] + Math.sin(phi) * l[2]]
    out.set([s[0] + d[0] * along + dir[0] * R, s[1] + d[1] * along + dir[1] * R, s[2] + d[2] * along + dir[2] * R], (p.offset + i) * 3)
  }
  void xc
}

/** 裁片局部 x、y 轴在 GarmentCode 摆放里的三维方向 / The 3-D directions of a panel's local x and y axes in GarmentCode's placement. */
function localAxes(q: PanelMesh): { x: V3; y: V3 } {
  // 用最小二乘：placed = R·local + t，取三个不共线的点即可 / placed = R·local + t; three non-collinear points suffice
  const n = q.count
  let i1 = 0, i2 = 0, best = 0
  for (let i = 1; i < n; i++) {
    const dx = q.local[i * 2]! - q.local[0]!, dy = q.local[i * 2 + 1]! - q.local[1]!
    if (dx * dx + dy * dy > best) {
      best = dx * dx + dy * dy
      i1 = i
    }
  }
  best = 0
  for (let i = 1; i < n; i++) {
    const ax = q.local[i1 * 2]! - q.local[0]!, ay = q.local[i1 * 2 + 1]! - q.local[1]!
    const bx = q.local[i * 2]! - q.local[0]!, by = q.local[i * 2 + 1]! - q.local[1]!
    const c = Math.abs(ax * by - ay * bx)
    if (c > best) {
      best = c
      i2 = i
    }
  }
  // 解 2×2：Δplaced = [X Y]·Δlocal / solve the 2×2: Δplaced = [X Y]·Δlocal
  const a = [q.local[i1 * 2]! - q.local[0]!, q.local[i1 * 2 + 1]! - q.local[1]!]
  const b = [q.local[i2 * 2]! - q.local[0]!, q.local[i2 * 2 + 1]! - q.local[1]!]
  const det = a[0]! * b[1]! - a[1]! * b[0]!
  const P = (i: number, k: number): number => q.placed[i * 3 + k]! - q.placed[k]!
  const X: number[] = [], Yv: number[] = []
  for (let k = 0; k < 3; k++) {
    const pa = P(i1, k), pb = P(i2, k)
    X.push((pa * b[1]! - pb * a[1]!) / det)
    Yv.push((pb * a[0]! - pa * b[0]!) / det)
  }
  const nx = Math.hypot(X[0]!, X[1]!, X[2]!), ny = Math.hypot(Yv[0]!, Yv[1]!, Yv[2]!)
  return { x: [X[0]! / nx, X[1]! / nx, X[2]! / nx], y: [Yv[0]! / ny, Yv[1]! / ny, Yv[2]! / ny] }
}
