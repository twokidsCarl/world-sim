// 女性腹股沟：把由男性形变而来的结构放到她自己的骨性标志和股三角底上。
//   1. 髂腹股沟神经和生殖股神经生殖支：男性的远段沿精索进入阴囊；女性没有这一段（它们伴子宫圆韧带出腹股沟管，
//      止于阴阜和大阴唇前部的皮肤）。远段剪掉，保留到耻骨结节下方不远处。
//   2. 股血管：形变场只由骨锚定，把男性的股静脉、股动脉放在她真实的耻骨肌、长收肌、髂腰肌前方十几到二十几毫米处悬空。
//      股鞘本应贴在这些肌（股三角的底）上：把股三角内位于底前方的血管、神经、淋巴结一起向后移，使血管后壁贴到底上。
// The female groin: structures carried over from the male by the warp are put where they belong
// relative to her own bony landmarks and the floor of her femoral triangle.
//   1. Ilio-inguinal nerve and genital branch of the genitofemoral nerve: in the male their distal run
//      follows the spermatic cord into the scrotum; a woman has no such run (they leave the inguinal
//      canal with the round ligament of the uterus and end in the skin of the mons pubis and the
//      anterior part of the labium majus). The distal run is trimmed a short way below the pubic tubercle.
//   2. Femoral vessels: the warp is anchored on bone only and leaves the male femoral vein and artery
//      hanging 10–25 mm in front of her real pectineus, adductor longus and iliopsoas. The femoral
//      sheath lies on these muscles (the floor of the femoral triangle): the vessels, nerves and lymph
//      nodes in front of the floor inside the triangle are moved back together until the vessels'
//      posterior walls rest on the floor.
// 解剖依据是通行的教科书内容，编写时没有打开文献逐条核对。
// The anatomy is standard textbook content; no source was opened to verify it when this was written.

import type { Mesh } from './geometry.ts'
import { surfacePoints, thinPoints } from './register.ts'
import type { Polyline } from './tube.ts'

type V3 = [number, number, number]

/**
 * 耻骨结节：髋骨上、耻骨联合上缘附近（向下 25 mm、向上 8 mm 以内）、距正中面 15–32 mm 处最靠前的点。
 * Pubic tubercle: the most anterior point of the hip bone near the upper border of the symphysis
 * (within 25 mm below and 8 mm above it), 15–32 mm from the median plane.
 */
export function pubicTubercle(hip: Mesh, xMid = 0): V3 {
  const p = hip.positions
  let sum = 0
  for (let i = 0; i < p.length; i += 3) sum += p[i]! - xMid
  const sx = sum >= 0 ? 1 : -1
  // 联合面：距正中面 12 mm 以内的骨面；其前半部的最高点为联合上缘
  // the symphysial surface: bone within 12 mm of the median plane; the highest point of its anterior half is the upper border
  let zFront = -Infinity
  for (let i = 0; i < p.length; i += 3) if (sx * (p[i]! - xMid) < 0.012 && p[i + 2]! > zFront) zFront = p[i + 2]!
  let top = -Infinity
  for (let i = 0; i < p.length; i += 3) if (sx * (p[i]! - xMid) < 0.012 && p[i + 2]! > zFront - 0.02 && p[i + 1]! > top) top = p[i + 1]!
  let pt: V3 = [xMid + sx * 0.022, top, zFront]
  let best = -Infinity
  for (let i = 0; i < p.length; i += 3) {
    const u = sx * (p[i]! - xMid)
    if (u < 0.015 || u > 0.032 || p[i + 1]! < top - 0.025 || p[i + 1]! > top + 0.008) continue
    if (p[i + 2]! > best) {
      best = p[i + 2]!
      pt = [p[i]!, p[i + 1]!, p[i + 2]!]
    }
  }
  return pt
}

/** 髂前上棘：髋骨上部 45 % 高度内最靠前的点 / anterior superior iliac spine: the most anterior point in the upper 45 % of the hip bone's height */
export function anteriorSuperiorIliacSpine(hip: Mesh): V3 {
  const p = hip.positions
  let y0 = Infinity
  let y1 = -Infinity
  for (let i = 1; i < p.length; i += 3) {
    y0 = Math.min(y0, p[i]!)
    y1 = Math.max(y1, p[i]!)
  }
  let out: V3 = [0, 0, -Infinity]
  for (let i = 0; i < p.length; i += 3) if (p[i + 1]! > y0 + 0.55 * (y1 - y0) && p[i + 2]! > out[2]) out = [p[i]!, p[i + 1]!, p[i + 2]!]
  return out
}

// ── 1. 剪掉男性才有的远段 / trimming the male-only distal run ────────────────────────────────────────

/** 女性体内要剪掉阴囊段的神经 / the nerves whose scrotal run is trimmed in the female */
export const LABIAL_NERVE = /^(left|right) (ilio-?inguinal nerve|genital branch of genitofemoral nerve)$/i

export interface TrimOptions {
  /** 保留到耻骨结节以下多远（米）：大阴唇前三分之一由这两条神经支配，其余由阴部神经的阴唇后神经支配 / kept down to this far below the pubic tubercle (m): these two nerves supply the anterior third of the labium majus, the rest belongs to the posterior labial nerves of the pudendal nerve */
  below: number
  /** 只剪正中面两侧、耻骨结节外侧这么远以内的部分（米）；更外侧的是走向大腿内上部皮肤的分支，保留 / only what lies within this far lateral of the pubic tubercle is trimmed (m); branches further lateral go to the skin of the upper medial thigh and stay */
  lateral: number
}

export const TRIM_DEFAULTS: TrimOptions = { below: 0.02, lateral: 0.015 }

/**
 * 沿每条折线从近端走向远端，在第一个落入“耻骨结节以下 `below`、结节外侧 `lateral` 以内”的点之前剪断；
 * 起点就在该区内的折线（它发自被剪掉的那段）整条去掉。返回保留的折线和剪掉的长度。
 * Each polyline is followed from its proximal end and cut before the first point that lies more than
 * `below` under the pubic tubercle and within `lateral` of it sideways; a polyline that starts inside
 * that zone (it springs from a removed stretch) is dropped whole. Returns what is kept and how much
 * length was removed.
 */
export function trimLabialRun(lines: Polyline[], tubercle: readonly number[], xMid = 0, options: Partial<TrimOptions> = {}): { lines: Polyline[]; removedMm: number; keptMm: number } {
  const o = { ...TRIM_DEFAULTS, ...options }
  const reach = Math.abs(tubercle[0]! - xMid) + o.lateral
  const inZone = (l: Polyline, i: number) => l.points[3 * i + 1]! < tubercle[1]! - o.below && Math.abs(l.points[3 * i]! - xMid) < reach
  const len = (l: Polyline, a: number, b: number) => {
    let s = 0
    for (let i = a + 1; i < b; i++) s += Math.hypot(l.points[3 * i]! - l.points[3 * i - 3]!, l.points[3 * i + 1]! - l.points[3 * i - 2]!, l.points[3 * i + 2]! - l.points[3 * i - 1]!)
    return s
  }
  const out: Polyline[] = []
  let removed = 0
  let kept = 0
  for (const l of lines) {
    const n = l.radius.length
    let cut = n
    for (let i = 0; i < n; i++) {
      if (inZone(l, i)) {
        cut = i
        break
      }
    }
    if (cut < 2) {
      removed += len(l, 0, n)
      continue
    }
    kept += len(l, 0, cut)
    if (cut === n) {
      out.push(l)
      continue
    }
    removed += len(l, cut - 1, n)
    out.push({ points: l.points.slice(0, 3 * cut), radius: l.radius.slice(0, cut) })
  }
  return { lines: out, removedMm: Math.round(removed * 1e4) / 10, keptMm: Math.round(kept * 1e4) / 10 }
}

// ── 2. 股血管落到股三角的底上 / seating the femoral vessels on the floor of the femoral triangle ─────────

export interface SeatOptions {
  /** 格距（米）/ grid spacing (m) */
  cell: number
  /** 血管后壁与底之间留的间隙（筋膜）（米）/ gap left between the vessels' posterior wall and the floor (fascia) (m) */
  gap: number
  /** 后移的上限（米）/ cap on the backward shift (m) */
  maxShift: number
  /** 作用范围：耻骨结节以上、以下各多远（米），两端各在 `taper` 内渐变到零 / extent above and below the pubic tubercle (m), fading to zero over `taper` at either end */
  above: number
  below: number
  taper: number
  /** 血管投影之外，位移在此距离内保持不变、到 `reach` 处减为零（米）/ beyond the vessels' footprint the shift holds within this distance and falls to zero at `reach` (m) */
  hold: number
  reach: number
}

export const SEAT_DEFAULTS: SeatOptions = { cell: 0.003, gap: 0.002, maxShift: 0.025, above: 0.02, below: 0.14, taper: 0.03, hold: 0.006, reach: 0.025 }

export interface FemoralSeat {
  /** 一个点应向后（−z）移多少（米）；不在作用范围内或在底的后方时为 0 / how far a point moves back (−z), in m; 0 outside the window or behind the floor */
  shiftAt(x: number, y: number, z: number): number
  /** 就地移动一组点，返回移动了的点数 / moves points in place and returns how many moved */
  apply(points: Float32Array): number
  report: { cells: number; meanShiftMm: number; maxShiftMm: number; clearanceBeforeMm: { median: number; max: number }; window: { yFromMm: number; yToMm: number } }
}

/**
 * 一侧股三角的“落底”位移场。`floor`：构成底的结构（她的髋骨、股骨、髂肌、腰大肌、耻骨肌、长收肌、短收肌、大收肌）；
 * `vessels`：股动脉和股静脉（形变后的网格）。在冠状面（x、y）的网格上，每格取底的最前点和血管的最后点，其差减去间隙即该格
 * 需要后移的量；向血管投影之外平滑延伸并衰减到零。位于底后方的点不动；任何点都不会被移到底里面去。
 * The seating field of one femoral triangle. `floor`: what makes up the floor (her hip bone, femur,
 * iliacus, psoas major, pectineus, adductor longus, brevis and magnus); `vessels`: femoral artery and
 * vein (warped meshes). On a grid in the coronal plane (x, y) each cell takes the front-most point of
 * the floor and the rear-most point of the vessels; their difference less the gap is how far that cell
 * must move back; the amount is extended smoothly beyond the vessels' footprint and falls to zero.
 * Points behind the floor stay; no point is moved into the floor.
 */
export function buildFemoralSeat(floor: Mesh[], vessels: Mesh[], tubercle: readonly number[], options: Partial<SeatOptions> = {}): FemoralSeat {
  const o = { ...SEAT_DEFAULTS, ...options }
  const y0 = tubercle[1]! - o.below
  const y1 = tubercle[1]! + o.above
  let x0 = Infinity
  let x1 = -Infinity
  const vs = vessels.map((m) => thinPoints(surfacePoints(m, o.cell / 2), o.cell / 3))
  for (const s of vs) for (let i = 0; i < s.length; i += 3) {
    if (s[i + 1]! < y0 || s[i + 1]! > y1) continue
    x0 = Math.min(x0, s[i]!)
    x1 = Math.max(x1, s[i]!)
  }
  const empty: FemoralSeat = { shiftAt: () => 0, apply: () => 0, report: { cells: 0, meanShiftMm: 0, maxShiftMm: 0, clearanceBeforeMm: { median: 0, max: 0 }, window: { yFromMm: Math.round(y0 * 1000), yToMm: Math.round(y1 * 1000) } } }
  if (!Number.isFinite(x0)) return empty
  x0 -= o.reach + o.cell
  x1 += o.reach + o.cell
  const nx = Math.ceil((x1 - x0) / o.cell) + 1
  const ny = Math.ceil((y1 - y0) / o.cell) + 1
  const cellOf = (x: number, y: number) => {
    const i = Math.round((x - x0) / o.cell)
    const j = Math.round((y - y0) / o.cell)
    return i < 0 || j < 0 || i >= nx || j >= ny ? -1 : i + nx * j
  }
  const back = new Float32Array(nx * ny).fill(Infinity)
  for (const s of vs) for (let i = 0; i < s.length; i += 3) {
    const c = cellOf(s[i]!, s[i + 1]!)
    if (c >= 0 && s[i + 2]! < back[c]!) back[c] = s[i + 2]!
  }
  // 底：只算在该格血管后壁之后（或没有血管的格里任何位置）的点，取最前的
  // the floor: only points behind the vessels' posterior wall in that cell (anywhere, in cells without a vessel), the front-most of them
  const floorZ = new Float32Array(nx * ny).fill(-Infinity)
  const floorAny = new Float32Array(nx * ny).fill(-Infinity)
  for (const m of floor) {
    const s = thinPoints(surfacePoints(m, o.cell / 2), o.cell / 3)
    for (let i = 0; i < s.length; i += 3) {
      const c = cellOf(s[i]!, s[i + 1]!)
      if (c < 0) continue
      if (s[i + 2]! > floorAny[c]!) floorAny[c] = s[i + 2]!
      if (s[i + 2]! <= back[c]! + 0.001 && s[i + 2]! > floorZ[c]!) floorZ[c] = s[i + 2]!
    }
  }
  // 每格需要后移的量；只在既有血管又有底的格里有定义
  // the shift each cell needs; defined only where a cell has both a vessel and floor behind it
  const need = new Float32Array(nx * ny).fill(NaN)
  const clear: number[] = []
  for (let c = 0; c < nx * ny; c++) {
    if (!Number.isFinite(back[c]!) || !Number.isFinite(floorZ[c]!)) continue
    const gapNow = back[c]! - floorZ[c]!
    clear.push(gapNow)
    need[c] = Math.max(0, Math.min(o.maxShift, gapNow - o.gap))
  }
  if (!clear.length) return empty
  // 归一化卷积把“需要量”向外延伸；到最近的有定义格的距离决定衰减
  // normalised convolution extends the need outwards; the distance to the nearest defined cell sets the fall-off
  const r = Math.ceil(o.reach / o.cell)
  const sigma = 0.006 / o.cell
  const shift = new Float32Array(nx * ny)
  let cells = 0
  let sum = 0
  let max = 0
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    let ws = 0
    let acc = 0
    let dmin = Infinity
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const a = i + di
      const b = j + dj
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue
      const v = need[a + nx * b]!
      if (Number.isNaN(v)) continue
      const d2 = di * di + dj * dj
      const w = Math.exp(-d2 / (2 * sigma * sigma))
      ws += w
      acc += w * v
      if (d2 < dmin) dmin = d2
    }
    if (!ws) continue
    const d = Math.sqrt(dmin) * o.cell
    const t = d <= o.hold ? 1 : d >= o.reach ? 0 : 1 - (d - o.hold) / (o.reach - o.hold)
    const y = y0 + j * o.cell
    const ty = Math.max(0, Math.min(1, (y - y0) / o.taper, (y1 - y) / o.taper))
    const fall = t * t * (3 - 2 * t) * (ty * ty * (3 - 2 * ty))
    shift[i + nx * j] = (acc / ws) * fall
    if (shift[i + nx * j]! > 0) {
      cells++
      sum += shift[i + nx * j]!
      max = Math.max(max, shift[i + nx * j]!)
    }
  }
  const bilinear = (g: Float32Array, x: number, y: number, missing: number): number => {
    const fx = (x - x0) / o.cell
    const fy = (y - y0) / o.cell
    const i = Math.floor(fx)
    const j = Math.floor(fy)
    if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return missing
    const a = fx - i
    const b = fy - j
    const v = [g[i + nx * j]!, g[i + 1 + nx * j]!, g[i + nx * (j + 1)]!, g[i + 1 + nx * (j + 1)]!]
    if (v.some((q) => !Number.isFinite(q))) {
      const ok = v.filter((q) => Number.isFinite(q))
      return ok.length ? Math.max(...ok) : missing
    }
    return v[0]! * (1 - a) * (1 - b) + v[1]! * a * (1 - b) + v[2]! * (1 - a) * b + v[3]! * a * b
  }
  const shiftAt = (x: number, y: number, z: number): number => {
    const s = bilinear(shift, x, y, 0)
    if (s <= 0) return 0
    const f = bilinear(floorAny, x, y, -Infinity)
    // 在底后方的点不动；在底前方的点最多移到离底 0.5 mm 处
    // points behind the floor stay; points in front of it move back at most to 0.5 mm from it
    return Number.isFinite(f) ? Math.max(0, Math.min(s, z - f - 0.0005)) : s
  }
  const apply = (points: Float32Array): number => {
    let n = 0
    for (let i = 0; i < points.length; i += 3) {
      const s = shiftAt(points[i]!, points[i + 1]!, points[i + 2]!)
      if (s <= 0) continue
      points[i + 2] = points[i + 2]! - s
      n++
    }
    return n
  }
  clear.sort((a, b) => a - b)
  const r1 = (v: number) => Math.round(v * 1e4) / 10
  return { shiftAt, apply, report: { cells, meanShiftMm: cells ? r1(sum / cells) : 0, maxShiftMm: r1(max), clearanceBeforeMm: { median: r1(clear[clear.length >> 1]!), max: r1(clear[clear.length - 1]!) }, window: { yFromMm: Math.round(y0 * 1000), yToMm: Math.round(y1 * 1000) } } }
}

// ── 构建里的入口 / entry points for the build ────────────────────────────────────────────────────────

/** 构建中的部件（female.ts 的 FPart 满足这个形状）/ a part of the build (FPart in female.ts has this shape) */
export interface GroinPart {
  id: string
  name: string
  system: string
  tissue: string
  mesh: Mesh
  centrelines?: Polyline[]
}

/** 构成股三角底的结构（取她真实的部件，id 不以 W_ 开头）/ what makes up the floor of the femoral triangle (her real parts, ids not starting with W_) */
export const TRIANGLE_FLOOR = /^(hip bone|femur|iliacus|psoas major|pectineus|adductor longus|adductor brevis|adductor magnus)$/i

export interface SeatRow {
  side: 'Left' | 'Right'
  tubercleMm: number[]
  floorParts: number
  /** 落底之前血管后壁到底的距离 / distance from the vessels' posterior wall to the floor before seating */
  clearanceBeforeMm: { median: number; max: number }
  meanShiftMm: number
  maxShiftMm: number
  window: { yFromMm: number; yToMm: number }
  partsMoved: number
  /** 移动最多的部件：名称和最大后移量 / the parts moved most: name and largest backward shift */
  moved: { name: string; maxShiftMm: number }[]
}

/**
 * 两侧各建一个落底位移场，就地移动由男性形变而来（id 以 W_ 开头）的动脉、静脉、神经（网格和中心线）和淋巴结（整体平移）。
 * 找不到所需部件的一侧不动。
 * Builds the seating field of each side and moves, in place, the arteries, veins, nerves (meshes and
 * centrelines) and lymph nodes (each translated whole) that came from the male by the warp (ids
 * starting with W_). A side lacking the parts it needs is left alone.
 */
export function seatFemoralTriangles(parts: GroinPart[], options: Partial<SeatOptions> = {}): SeatRow[] {
  const rows: SeatRow[] = []
  for (const side of ['Left', 'Right'] as const) {
    const hip = parts.find((p) => p.tissue === 'bone' && p.name === `${side} hip bone`)
    const vessels = parts.filter((p) => p.id.startsWith('W_') && (p.name === `${side} femoral artery` || p.name === `${side} femoral vein`))
    if (!hip || vessels.length < 2) continue
    const floor = parts.filter((p) => !p.id.startsWith('W_') && p.name.startsWith(`${side} `) && TRIANGLE_FLOOR.test(p.name.slice(side.length + 1)))
    const tubercle = pubicTubercle(hip.mesh)
    const seat = buildFemoralSeat(floor.map((p) => p.mesh), vessels.map((p) => p.mesh), tubercle, options)
    if (!seat.report.cells) continue
    const moved: { name: string; maxShiftMm: number }[] = []
    for (const p of parts) {
      if (!p.id.startsWith('W_')) continue
      const node = p.system === 'lymphatic' && /\bnodes?\b/i.test(p.name)
      if (!(p.tissue === 'artery' || p.tissue === 'vein' || p.tissue === 'nerve' || node)) continue
      const src = p.mesh.positions
      const positions = Float32Array.from(src)
      let max = 0
      if (node) {
        const c = [0, 0, 0]
        for (let i = 0; i < src.length; i++) c[i % 3] = c[i % 3]! + src[i]! / (src.length / 3)
        max = seat.shiftAt(c[0]!, c[1]!, c[2]!)
        if (max > 0) for (let i = 2; i < positions.length; i += 3) positions[i] = positions[i]! - max
      } else if (seat.apply(positions)) {
        for (let i = 2; i < positions.length; i += 3) max = Math.max(max, src[i]! - positions[i]!)
      }
      if (max <= 0) continue
      p.mesh = { positions, indices: p.mesh.indices }
      if (p.centrelines) {
        p.centrelines = p.centrelines.map((l) => {
          const pts = Float32Array.from(l.points)
          seat.apply(pts)
          return { points: pts, radius: l.radius }
        })
      }
      moved.push({ name: p.name, maxShiftMm: Math.round(max * 1e4) / 10 })
    }
    moved.sort((a, b) => b.maxShiftMm - a.maxShiftMm || (a.name < b.name ? -1 : 1))
    rows.push({ side, tubercleMm: tubercle.map((v) => Math.round(v * 1e4) / 10), floorParts: floor.length, clearanceBeforeMm: seat.report.clearanceBeforeMm, meanShiftMm: seat.report.meanShiftMm, maxShiftMm: seat.report.maxShiftMm, window: seat.report.window, partsMoved: moved.length, moved: moved.slice(0, 12) })
  }
  return rows
}
