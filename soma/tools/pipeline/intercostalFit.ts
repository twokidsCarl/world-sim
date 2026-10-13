// 女性：把第 7–11 肋间神经（胸腹神经）离开肋弓之后在腹壁里的一段，按她自己的体表标志重新定位。
//
// 她的肋间神经是男性的中心线经形变场带过来的。沿肋骨的一段贴着她自己的肋（标志点检查 intercostal-ribs 通过），不动；
// 离开骨性胸廓之后，神经在腹壁里没有骨可依，位置完全是外推的，前端落在哪里与她的剑突、脐无关。
// 这里只改这一段：
//   · 支点：中心线上最后一个距她自己的第 n 或第 n+1 肋（骨）不超过 pivotReach 的点；支点及其后方原样不动。
//   · 前端的目标高度（出处见 LEVEL_SOURCES，都是打开核对过的）：
//       第 7 肋间神经止于剑突（Gray 1918 第 945 页）——取剑突最低点下方 belowXiphoid；
//       第 10 肋间神经止于脐（同上）——取皮肤上的脐；
//       第 8、9 在两者之间等分（内插，没有出处）；
//       第 11 取第 10 与“第 12 平面”的中点；“第 12 平面”取腹股沟韧带中点（髂前上棘与耻骨结节的中点）的高度，
//       这是 ISNCSCI 的 T12 关键感觉点，用在正中线旁是本项目的假定。模型里没有肋下神经。
//   · 前端距正中线的距离保持原值，限制在 endOffset 之内（白线旁）。
//   · 位移：前端位移 Δ 按弧长用 smoothstep 从支点处的 0 过渡到前端的 1，加在原中心线上（保持原来的弯曲形状）。
//   · 层次：神经在腹内斜肌与腹横肌之间前行，到腹直肌鞘穿入，支配腹直肌，以前皮支终（Gray 1918 第 945 页）。
//     所以位移之后沿水平的径向把每个点落到：有腹直肌处在腹直肌的后面，否则有腹横肌处在腹横肌的外表面（即它与腹内斜肌之间）；
//     最后 perforate 这一段从腹直肌后面过渡到前面（前皮支）。两块肌都碰不到的点保持位移后的位置。
// 中心线改好之后由调用方重建管状网格。第 5、6 肋间神经一直在自己的肋间隙里走到胸骨旁，没有打开过给出其终点高度的出处，不动。
//
// Female: the stretch of intercostal nerves 7–11 (the thoraco-abdominal nerves) beyond the costal margin, in
// the abdominal wall, re-placed by her own surface landmarks.
//
// Her intercostal nerves are the male centrelines carried over by the registration field. Along the ribs
// they lie on her own ribs (the landmark check intercostal-ribs passes) and stay. Beyond the bony thorax no
// bone guides them: their place in the abdominal wall is pure extrapolation, and where the anterior end lands
// has nothing to do with her xiphoid process or her navel. Only that stretch is changed here:
//   · pivot: the last centreline point within `pivotReach` of her own rib n or n+1 (bone); the pivot and
//     everything behind it stay as they are.
//   · target height of the anterior end (sources in LEVEL_SOURCES, each opened and checked):
//       the 7th intercostal nerve ends at the xiphoid process (Gray 1918, p. 945) — `belowXiphoid` under its
//       lowest point; the 10th ends at the navel (same) — the navel of the skin; the 8th and 9th divide the
//       distance evenly (interpolation, no source); the 11th lies midway between the 10th and a "level of
//       the 12th", taken as the height of the midpoint of the inguinal ligament (midway between anterior
//       superior iliac spine and pubic tubercle) — the ISNCSCI key sensory point of T12; using it beside the
//       midline is this project's assumption. The model has no subcostal nerve.
//   · the distance of the end from the midline is kept, limited to `endOffset` (beside the linea alba).
//   · displacement: the end's displacement Δ, blended by arc length with a smoothstep from 0 at the pivot
//     to 1 at the end, is added to the original centreline (which keeps its own curvature).
//   · layer: the nerves run forwards between obliquus internus and transversus abdominis to the sheath of
//     rectus abdominis, which they perforate; they supply the rectus and end as anterior cutaneous branches
//     (Gray 1918, p. 945). After the displacement each point is therefore seated along the horizontal radial
//     direction: behind rectus abdominis where there is rectus, else on the outer surface of transversus
//     abdominis (between it and the internal oblique) where there is transversus; over the last `perforate`
//     the nerve passes from behind the rectus to its front (the anterior cutaneous branch). A point that
//     meets neither muscle stays where the displacement put it.
// The caller rebuilds the tube from the changed centreline. Intercostal nerves 5 and 6 run in their own
// spaces to the side of the sternum; no source giving a level for their ends was opened, so they stay.

import { measure, type Mesh } from './geometry.ts'
import { anteriorSuperiorIliacSpine, pubicTubercle } from './groin.ts'
import { InsideTester, PointIndex, surfacePoints, thinPoints } from './register.ts'
import { simplifyPolyline, type Polyline } from './tube.ts'

export const LEVEL_SOURCES = [
  { claim: 'The 7th intercostal nerve ends at the xiphoid process of the sternum; the 10th intercostal nerve terminates at the navel.', name: "Wikipedia “Intercostal nerves”, which incorporates public-domain text from p. 945 of Gray's Anatomy, 20th ed. (1918); opened 2026-10-13", url: 'https://en.wikipedia.org/wiki/Intercostal_nerves' },
  { claim: 'The 7th–11th nerves pass between the obliquus internus and transversus abdominis to the sheath of the rectus abdominis, which they perforate; they supply the rectus and end as the anterior cutaneous branches of the abdomen.', name: "Wikipedia “Thoraco-abdominal nerves” (text of Gray's Anatomy, 20th ed., 1918); opened 2026-10-13", url: 'https://en.wikipedia.org/wiki/Thoraco-abdominal_nerves' },
  { claim: 'T12 key sensory point: intersection of the midclavicular line and the midpoint of the inguinal ligament (T10: midclavicular line at the horizontal level of the umbilicus).', name: 'Wikipedia “Dermatome (anatomy)”, list attributed to the ISNCSCI key sensory points (American Spinal Injury Association); opened 2026-10-13', url: 'https://en.wikipedia.org/wiki/Dermatome_(anatomy)' },
] as const

export interface IntercostalFitOptions {
  /** 支点：距自己的肋（骨）不超过这么远的最后一个点（米） / the pivot: the last point this near to its own ribs (bone), m */
  pivotReach: number
  /** 第 7 肋间神经的前端在剑突最低点下方多少（米） / how far below the lowest point of the xiphoid process the 7th nerve ends (m) */
  belowXiphoid: number
  /** 前端距正中线的距离限制在这个范围内（米） / the end's distance from the midline is kept within this range (m) */
  endOffset: [number, number]
  /** 末段从腹直肌后面穿到前面的长度（米） / length of the last stretch that passes from behind the rectus to its front (m) */
  perforate: number
  /** 重采样的间距和径向搜索的步长、范围（米） / resampling step, and step and reach of the radial search (m) */
  step: number
  rayStep: number
  rayReach: number
  /** 前端位移小于它的神经不动（米） / a nerve whose end would move by less than this is left alone (m) */
  minMove: number
  /** 支点以远短于它的神经不动（米） / a nerve with less than this beyond its pivot is left alone (m) */
  minStretch: number
  /** 肌与神经之间留的空隙（米） / clearance left between muscle and nerve (m) */
  clearance: number
}

export const INTERCOSTAL_FIT_DEFAULTS: IntercostalFitOptions = { pivotReach: 0.015, belowXiphoid: 0.01, endOffset: [0.008, 0.02], perforate: 0.012, step: 0.002, rayStep: 0.0005, rayReach: 0.04, minMove: 0.002, minStretch: 0.02, clearance: 0.0005 }

const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth']

export interface IntercostalFitPart {
  id: string
  name: string
  tissue: string
  mesh: Mesh
  centrelines?: Polyline[]
}

export interface IntercostalFitRow {
  id: string
  name: string
  side: 'L' | 'R'
  nerve: number
  changed: boolean
  reason?: string
  /** 前端的高度（毫米）：之前、目标、之后 / height of the anterior end (mm): before, target, after */
  endYMm: { before: number; target: number; after: number }
  endMm: { before: number[]; after: number[] }
  /** 之后：前端相对剑突最低点、脐、耻骨结节的高度（毫米，正 = 在其上方） / afterwards: the end against the lowest point of the xiphoid, the navel and the pubic tubercles (mm, positive = above) */
  againstMm: { xiphoidTip: { before: number; after: number }; navel: { before: number; after: number }; pubicTubercle: { before: number; after: number } }
  pivotMm?: number[]
  refittedLengthMm?: { before: number; after: number }
  /** 重新定位的一段落在各肌内的点所占比例，之前和之后 / share of the points of the re-placed stretch inside each muscle, before and after */
  insideMuscle?: Record<string, { before: number; after: number }>
  /** 径向落位：落在腹直肌后、腹横肌外、没有碰到肌的点数 / radial seating: points put behind rectus, on transversus, and meeting no muscle */
  seated?: { behindRectus: number; onTransversus: number; free: number }
  /** 之后落在骨或软骨内的点数 / points inside bone or cartilage afterwards */
  inBoneAfter?: number
}

export interface IntercostalFitReport {
  applied: boolean
  reason?: string
  options?: IntercostalFitOptions
  sources?: typeof LEVEL_SOURCES
  /** 所用的标志（米） / the landmarks used (m) */
  landmarks?: { midlineX: number; xiphoidTipY: number; navelY: number; navelFrom: string; asisY: number; pubicTubercleY: number; inguinalMidY: number }
  /** 各神经前端的目标高度（米）和它的依据 / target height of each nerve's end (m) and what it rests on */
  levels?: { nerve: number; y: number; basis: string }[]
  notRefitted?: string
  rows?: IntercostalFitRow[]
}

function resample(line: Polyline, step: number): Polyline {
  const pts: number[] = []
  const rad: number[] = []
  const n = line.radius.length
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const ax = line.points[3 * i - 3]!, ay = line.points[3 * i - 2]!, az = line.points[3 * i - 1]!
      const bx = line.points[3 * i]!, by = line.points[3 * i + 1]!, bz = line.points[3 * i + 2]!
      const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / step))
      for (let j = 1; j < k; j++) {
        const t = j / k
        pts.push(ax + t * (bx - ax), ay + t * (by - ay), az + t * (bz - az))
        rad.push(line.radius[i - 1]! + t * (line.radius[i]! - line.radius[i - 1]!))
      }
    }
    pts.push(line.points[3 * i]!, line.points[3 * i + 1]!, line.points[3 * i + 2]!)
    rad.push(line.radius[i]!)
  }
  return { points: Float32Array.from(pts), radius: Float32Array.from(rad) }
}

const lengthOf = (p: Float32Array, from: number): number => {
  let l = 0
  for (let i = from + 1; i < p.length / 3; i++) l += Math.hypot(p[3 * i]! - p[3 * i - 3]!, p[3 * i + 1]! - p[3 * i - 2]!, p[3 * i + 2]! - p[3 * i - 1]!)
  return l
}

/**
 * @param parts 全部部件（只读；按名称取肋、剑突、髋骨、腹壁肌和肋间神经） / every part (read only; ribs, xiphoid, hip bones, abdominal wall muscles and the intercostal nerves are taken by name)
 * @param navel 皮肤上的脐（米）和它的出处；没有则不做 / the navel of the skin (m) and where it comes from; without it nothing is done
 */
export function refitIntercostalNerves(parts: IntercostalFitPart[], navel: { y: number; from: string } | null, opts: IntercostalFitOptions = INTERCOSTAL_FIT_DEFAULTS): { changed: Map<string, Polyline[]>; report: IntercostalFitReport } {
  const changed = new Map<string, Polyline[]>()
  const byName = new Map<string, IntercostalFitPart>()
  for (const p of parts) if (!byName.has(p.name)) byName.set(p.name, p)
  const xiphoid = byName.get('Xiphoid process')
  const hips = (['Left', 'Right'] as const).map((S) => byName.get(`${S} hip bone`))
  if (!navel) return { changed, report: { applied: false, reason: 'no navel known on the skin (no skin package fitted to these internals that records one)' } }
  if (!xiphoid || !hips[0] || !hips[1]) return { changed, report: { applied: false, reason: 'xiphoid process or a hip bone is missing' } }
  const xs = measure(xiphoid.mesh)
  const xMid = xs.centroid[0]
  const tipY = xs.bbox[1]
  const asisY = (anteriorSuperiorIliacSpine(hips[0].mesh)[1] + anteriorSuperiorIliacSpine(hips[1].mesh)[1]) / 2
  // 骨盆自己的正中面（两髋骨内缘的中点）：与剑突的正中线可以差几毫米 / the pelvis' own median plane (midway between the inner edges of the hip bones): it can be a few millimetres off the xiphoid's midline
  const xPelvis = (measure(hips[0].mesh).bbox[0] + measure(hips[1].mesh).bbox[3]) / 2
  const tubY = (pubicTubercle(hips[0].mesh, xPelvis)[1] + pubicTubercle(hips[1].mesh, xPelvis)[1]) / 2
  const y12 = (asisY + tubY) / 2
  const y7 = tipY - opts.belowXiphoid
  const y10 = navel.y
  const levels = [
    { nerve: 7, y: y7, basis: `${opts.belowXiphoid * 1000} mm below the lowest point of the xiphoid process (Gray 1918: ends at the xiphoid process)` },
    { nerve: 8, y: y7 + (y10 - y7) / 3, basis: 'one third of the way from the 7th to the 10th (interpolated, no source)' },
    { nerve: 9, y: y7 + (2 * (y10 - y7)) / 3, basis: 'two thirds of the way from the 7th to the 10th (interpolated, no source)' },
    { nerve: 10, y: y10, basis: 'the navel of the skin (Gray 1918: terminates at the navel)' },
    { nerve: 11, y: (y10 + y12) / 2, basis: 'midway between the 10th and the height of the midpoint of the inguinal ligament (the ISNCSCI T12 key point; used beside the midline by assumption)' },
  ]
  // 径向搜索的轴：正中线，前后位置取腰椎椎体的质心 / the axis of the radial search: the midline, at the depth of the lumbar vertebral bodies
  const lumbar = parts.filter((p) => p.tissue === 'bone' && /lumbar vertebra/i.test(p.name))
  const zAxis = lumbar.length ? lumbar.reduce((a, p) => a + measure(p.mesh).centroid[2], 0) / lumbar.length : xs.centroid[2] - 0.1
  const hard = parts.filter((p) => p.tissue === 'bone' || p.tissue === 'cartilage').map((p) => ({ box: measure(p.mesh).bbox, mesh: p.mesh, tester: null as InsideTester | null }))
  const inHard = (x: number, y: number, z: number): boolean => hard.some((b) => x >= b.box[0] && x <= b.box[3] && y >= b.box[1] && y <= b.box[4] && z >= b.box[2] && z <= b.box[5] && (b.tester ??= new InsideTester(b.mesh, 48)).contains(x, y, z))
  const r1 = (v: number) => Math.round(v * 1e4) / 10
  const rows: IntercostalFitRow[] = []
  for (const [S, sd, sgn] of [['Left', 'L', 1], ['Right', 'R', -1]] as const) {
    const muscle = (n: string) => {
      const p = byName.get(`${S} ${n}`)
      return p ? new InsideTester(p.mesh, 96) : null
    }
    const M = { rectus: muscle('rectus abdominis'), transversus: muscle('transversus abdominis'), internalOblique: muscle('internal oblique'), externalOblique: muscle('external oblique') }
    for (const lv of levels) {
      const part = byName.get(`${S} ${ORD[lv.nerve - 1]} intercostal nerve`)
      const ribs = [byName.get(`${S} ${ORD[lv.nerve - 1]} rib`), byName.get(`${S} ${ORD[lv.nerve]} rib`)].filter((p): p is IntercostalFitPart => !!p && p.tissue === 'bone')
      if (!part?.centrelines?.length) continue
      const src = part.centrelines
      // 主干：最长的一条；其余分支（现在没有）不动 / the trunk: the longest line; other branches (none at present) stay
      let main = 0
      src.forEach((l, i) => {
        if (lengthOf(l.points, 0) > lengthOf(src[main]!.points, 0)) main = i
      })
      const fine = resample(src[main]!, opts.step)
      const P = fine.points
      const n = fine.radius.length
      // 前端 = 离正中线近、靠前的一端 / the anterior end = the end near the midline, in front
      const endIsLast = P[3 * n - 1]! >= P[2]!
      if (!endIsLast) {
        // 颠倒次序，使前端在最后 / reversed so that the anterior end comes last
        for (let i = 0, j = n - 1; i < j; i++, j--) {
          for (let k = 0; k < 3; k++) [P[3 * i + k], P[3 * j + k]] = [P[3 * j + k]!, P[3 * i + k]!]
          ;[fine.radius[i], fine.radius[j]] = [fine.radius[j]!, fine.radius[i]!]
        }
      }
      const E = [P[3 * n - 3]!, P[3 * n - 2]!, P[3 * n - 1]!]
      const against = (y: number) => ({ xiphoidTip: r1(y - tipY), navel: r1(y - y10), pubicTubercle: r1(y - tubY) })
      const base = { id: part.id, name: part.name, side: sd, nerve: lv.nerve }
      const same = (reason: string): IntercostalFitRow => {
        const a = against(E[1]!)
        return { ...base, changed: false, reason, endYMm: { before: r1(E[1]!), target: r1(lv.y), after: r1(E[1]!) }, endMm: { before: E.map(r1), after: E.map(r1) }, againstMm: { xiphoidTip: { before: a.xiphoidTip, after: a.xiphoidTip }, navel: { before: a.navel, after: a.navel }, pubicTubercle: { before: a.pubicTubercle, after: a.pubicTubercle } } }
      }
      if (ribs.length < 2) {
        rows.push(same('a rib of its space is missing'))
        continue
      }
      const ribIx = new PointIndex(thinPoints(Float32Array.from(ribs.flatMap((r) => [...surfacePoints(r.mesh, 0.002)])), 0.002), 0.008)
      let pivot = -1
      for (let i = 0; i < n; i++) if (ribIx.distance(P[3 * i]!, P[3 * i + 1]!, P[3 * i + 2]!, opts.pivotReach) <= opts.pivotReach) pivot = i
      const stretch = pivot >= 0 ? lengthOf(P, pivot) : 0
      if (pivot < 0 || stretch < opts.minStretch) {
        rows.push(same('no stretch beyond the bony thorax'))
        continue
      }
      const off = Math.min(opts.endOffset[1], Math.max(opts.endOffset[0], sgn * (E[0]! - xMid)))
      const D = [xMid + sgn * off - E[0]!, lv.y - E[1]!]
      // 前端已在目标处的（位移不到 minMove）不加位移，但照样做径向落位 / an end already at its target (less than minMove away) gets no displacement, but the radial seating is done all the same
      if (Math.hypot(D[0]!, D[1]!) < opts.minMove) D[0] = D[1] = 0
      // 弧长参数 u：支点 0，前端 1 / arc-length parameter u: 0 at the pivot, 1 at the end
      const u = new Float64Array(n)
      for (let i = pivot + 1; i < n; i++) u[i] = u[i - 1]! + Math.hypot(P[3 * i]! - P[3 * i - 3]!, P[3 * i + 1]! - P[3 * i - 2]!, P[3 * i + 2]! - P[3 * i - 1]!) / stretch
      const Q = Float32Array.from(P)
      for (let i = pivot + 1; i < n; i++) {
        const w = u[i]! * u[i]! * (3 - 2 * u[i]!)
        Q[3 * i] = P[3 * i]! + w * D[0]!
        Q[3 * i + 1] = P[3 * i + 1]! + w * D[1]!
      }
      // 径向落位 / radial seating
      const dr = new Float64Array(n)
      const seated = { behindRectus: 0, onTransversus: 0, free: 0 }
      const dir = (i: number): [number, number, number] => {
        const dx = Q[3 * i]! - xMid, dz = Q[3 * i + 2]! - zAxis
        const r = Math.hypot(dx, dz) || 1
        return [dx / r, dz / r, r]
      }
      const newLen = lengthOf(Q, pivot)
      for (let i = pivot + 1; i < n; i++) {
        const [cx, cz, r0] = dir(i)
        const y = Q[3 * i + 1]!
        const rho = fine.radius[i]! + opts.clearance
        // 自外向内：进入腹直肌的半径、离开腹直肌的半径、进入腹横肌的半径 / from outside inwards: the radius entering rectus, leaving it, and entering transversus
        let rRa = NaN, rRp = NaN, rT = NaN
        for (let r = r0 + opts.rayReach; r >= r0 - opts.rayReach; r -= opts.rayStep) {
          const x = xMid + cx * r, z = zAxis + cz * r
          if (M.rectus?.contains(x, y, z)) {
            if (Number.isNaN(rRa)) rRa = r
            rRp = r
          }
          if (Number.isNaN(rT) && M.transversus?.contains(x, y, z)) rT = r
        }
        let want = NaN
        if (!Number.isNaN(rRa)) {
          want = rRp - rho
          // 末段穿到腹直肌前面 / the last stretch passes to the front of the rectus
          const left = (1 - u[i]!) * newLen
          if (left < opts.perforate) {
            const t = 1 - left / opts.perforate
            want = rRp - rho + t * t * (3 - 2 * t) * (rRa + rho - (rRp - rho))
          }
          seated.behindRectus++
        } else if (!Number.isNaN(rT)) {
          want = rT + rho
          seated.onTransversus++
        } else seated.free++
        // 靠近支点处逐渐生效，免得在支点处折一下 / taking effect gradually near the pivot, so that there is no kink there
        const g = Math.min(1, u[i]! / 0.25)
        dr[i] = Number.isNaN(want) ? NaN : g * g * (3 - 2 * g) * (want - r0)
      }
      // 没碰到肌的点：取两侧已落位的点的线性内插 / points that met no muscle: linear interpolation between seated neighbours
      dr[pivot] = 0
      for (let i = pivot + 1; i < n; i++) {
        if (!Number.isNaN(dr[i]!)) continue
        let j = i
        while (j < n && Number.isNaN(dr[j]!)) j++
        const a = dr[i - 1]!
        const b = j < n ? dr[j]! : a
        for (let k = i; k < j; k++) dr[k] = a + ((k - i + 1) / (j - i + 1)) * (b - a)
        i = j - 1
      }
      // 平滑径向位移（末段穿出的部分和支点不参与） / the radial offsets are smoothed (not the perforating stretch, not the pivot)
      for (let pass = 0; pass < 40; pass++) {
        const t = Float64Array.from(dr)
        for (let i = pivot + 1; i < n - 1; i++) if ((1 - u[i]!) * newLen >= opts.perforate) dr[i] = 0.25 * t[i - 1]! + 0.5 * t[i]! + 0.25 * t[i + 1]!
      }
      // 落在骨或软骨里的点（第 7、8 肋间神经从肋软骨的深面经过）：沿径向往里退到出来为止，退的量再平滑两遍、再退一次
      // points inside bone or cartilage (the 7th and 8th nerves pass deep to the costal cartilages): moved inwards along the radius until they are out; those extra offsets are smoothed and the step repeated twice
      const place = (i: number, r: number): [number, number, number] => {
        const [cx, cz, r0] = dir(i)
        return [xMid + cx * (r0 + r), Q[3 * i + 1]!, zAxis + cz * (r0 + r)]
      }
      for (let round = 0; round < 3; round++) {
        for (let i = pivot + 1; i < n; i++) {
          let q = place(i, dr[i]!)
          let back = 0
          while (back < 0.03 && inHard(q[0], q[1], q[2])) {
            back += opts.rayStep
            q = place(i, dr[i]! - back)
          }
          if (back > 0) dr[i] = dr[i]! - back - fine.radius[i]! - opts.clearance
        }
        if (round === 2) break
        for (let pass = 0; pass < 4; pass++) {
          const t = Float64Array.from(dr)
          for (let i = pivot + 1; i < n - 1; i++) dr[i] = Math.min(t[i]!, 0.25 * t[i - 1]! + 0.5 * t[i]! + 0.25 * t[i + 1]!)
        }
      }
      for (let i = pivot + 1; i < n; i++) {
        const q = place(i, dr[i]!)
        Q[3 * i] = q[0]
        Q[3 * i + 2] = q[2]
      }
      const share = (pts: Float32Array, t: InsideTester | null): number => {
        if (!t) return 0
        let c = 0
        for (let i = pivot + 1; i < n; i++) if (t.contains(pts[3 * i]!, pts[3 * i + 1]!, pts[3 * i + 2]!)) c++
        return Math.round((c / (n - pivot - 1)) * 1e3) / 1e3
      }
      let inBone = 0
      for (let i = pivot + 1; i < n; i++) if (inHard(Q[3 * i]!, Q[3 * i + 1]!, Q[3 * i + 2]!)) inBone++
      const line = simplifyPolyline({ points: Q, radius: fine.radius }, 0.00025, 0.15, 0.012)
      changed.set(part.id, src.map((l, i) => (i === main ? line : l)))
      const F = [Q[3 * n - 3]!, Q[3 * n - 2]!, Q[3 * n - 1]!]
      const b = against(E[1]!)
      const a = against(F[1]!)
      rows.push({
        ...base, changed: true, endYMm: { before: r1(E[1]!), target: r1(lv.y), after: r1(F[1]!) }, endMm: { before: E.map(r1), after: F.map(r1) },
        againstMm: { xiphoidTip: { before: b.xiphoidTip, after: a.xiphoidTip }, navel: { before: b.navel, after: a.navel }, pubicTubercle: { before: b.pubicTubercle, after: a.pubicTubercle } },
        pivotMm: [P[3 * pivot]!, P[3 * pivot + 1]!, P[3 * pivot + 2]!].map(r1), refittedLengthMm: { before: r1(stretch), after: r1(lengthOf(Q, pivot)) },
        insideMuscle: Object.fromEntries(Object.entries(M).map(([k, t]) => [k, { before: share(P, t), after: share(Q, t) }])), seated, inBoneAfter: inBone,
      })
    }
  }
  return {
    changed,
    report: {
      applied: rows.some((r) => r.changed), options: opts, sources: LEVEL_SOURCES,
      landmarks: { midlineX: Math.round(xMid * 1e4) / 1e4, xiphoidTipY: Math.round(tipY * 1e4) / 1e4, navelY: Math.round(y10 * 1e4) / 1e4, navelFrom: navel.from, asisY: Math.round(asisY * 1e4) / 1e4, pubicTubercleY: Math.round(tubY * 1e4) / 1e4, inguinalMidY: Math.round(y12 * 1e4) / 1e4 },
      levels: levels.map((l) => ({ nerve: l.nerve, y: Math.round(l.y * 1e4) / 1e4, basis: l.basis })),
      notRefitted: 'intercostal nerves 1–6 (they run in their own intercostal spaces to the side of the sternum; no source giving a level for their ends was opened); there is no subcostal nerve in the model; no nerve has a separate lateral cutaneous branch in the centreline data (each is one line), so there was none to preserve or to lose',
      rows,
    },
  }
}
