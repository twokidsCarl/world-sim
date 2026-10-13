// 神经在肌内的走行：哪些是解剖上本来如此（进入所支配肌的肌支、已知的穿肌段），哪些不是；
// 以及把后者从肌里移出来。女性构建用：她的下肢肌是真实的（Denver），神经是男性的、经形变而来。
// Nerves running inside muscles: which stretches are anatomy (motor branches entering the muscle they
// supply, known passages through a muscle) and which are not; and moving the latter out of the muscle.
// Used by the female build: her leg muscles are real (Denver), her nerves are male ones carried by a warp.
//
// 规则所依据的是通行的解剖学教科书内容（各神经支配哪些肌、哪些神经干穿过哪块肌）；编写时没有逐条打开文献核对。
// The rules encode standard textbook anatomy (which muscles each nerve supplies, which trunks pass
// through which muscle); no source was opened to verify them entry by entry when this was written.

import { measure, type Mesh } from './geometry.ts'
import { pushOutOfSolids, SurfaceField, type ExistingPart } from './import3.ts'
import { densify } from './importZa.ts'
import { PointIndex, surfacePoints, thinPoints } from './register.ts'
import { buildTube, mergeMeshes, simplifyPolyline, type Polyline } from './tube.ts'

// ── 内外判定 / inside test ───────────────────────────────────────────────────────────────────────────

/**
 * 封闭网格的内外判定，沿 x、y、z 三个方向各数一次射线交点，取多数。每个方向同时看奇偶和带符号的交点数：
 * 两个封闭壳相互重叠处（接上的腱伸入肌腹的那一段）奇偶为偶，带符号的计数为 2，仍判为内。
 * Inside test for closed meshes: ray crossings are counted along x, y and z and the majority wins.
 * Each direction looks at both the parity and the signed count: where two closed shells overlap (the
 * stretch of a spliced tendon that reaches into the belly) the parity is even but the signed count is
 * 2, which still reads as inside.
 */
export class SolidTester {
  readonly bbox: [number, number, number, number, number, number]
  private readonly grids: { u: number; v: number; w: number; u0: number; v0: number; inv: number; nu: number; nv: number; start: Uint32Array; tris: Uint32Array }[] = []

  constructor(private readonly mesh: Mesh, resolution = 40) {
    this.bbox = measure(mesh).bbox
    const p = mesh.positions
    const idx = mesh.indices
    for (const w of [0, 1, 2]) {
      const u = (w + 1) % 3
      const v = (w + 2) % 3
      const u0 = this.bbox[u]!
      const v0 = this.bbox[v]!
      const inv = resolution / Math.max(this.bbox[u + 3]! - u0, this.bbox[v + 3]! - v0, 1e-9)
      const nu = Math.floor((this.bbox[u + 3]! - u0) * inv) + 1
      const nv = Math.floor((this.bbox[v + 3]! - v0) * inv) + 1
      const span = (t: number): [number, number, number, number] => {
        const a = 3 * idx[t]!
        const b = 3 * idx[t + 1]!
        const c = 3 * idx[t + 2]!
        return [
          Math.floor((Math.min(p[a + u]!, p[b + u]!, p[c + u]!) - u0) * inv), Math.min(nu - 1, Math.floor((Math.max(p[a + u]!, p[b + u]!, p[c + u]!) - u0) * inv)),
          Math.floor((Math.min(p[a + v]!, p[b + v]!, p[c + v]!) - v0) * inv), Math.min(nv - 1, Math.floor((Math.max(p[a + v]!, p[b + v]!, p[c + v]!) - v0) * inv)),
        ]
      }
      const start = new Uint32Array(nu * nv + 1)
      for (let t = 0; t < idx.length; t += 3) {
        const [a0, a1, b0, b1] = span(t)
        for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) start[i + nu * j + 1] = start[i + nu * j + 1]! + 1
      }
      for (let c = 0; c < nu * nv; c++) start[c + 1] = start[c + 1]! + start[c]!
      const tris = new Uint32Array(start[nu * nv]!)
      const fill = start.slice(0, nu * nv)
      for (let t = 0; t < idx.length; t += 3) {
        const [a0, a1, b0, b1] = span(t)
        for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) {
          tris[fill[i + nu * j]!] = t
          fill[i + nu * j] = fill[i + nu * j]! + 1
        }
      }
      this.grids.push({ u, v, w, u0, v0, inv, nu, nv, start, tris })
    }
  }

  contains(x: number, y: number, z: number): boolean {
    const b = this.bbox
    if (x < b[0] || x > b[3] || y < b[1] || y > b[4] || z < b[2] || z > b[5]) return false
    const q = [x, y, z]
    const p = this.mesh.positions
    const idx = this.mesh.indices
    let votes = 0
    for (const g of this.grids) {
      // 稍微偏开，避开恰好落在顶点或边上的情形 / nudged off exact vertex and edge alignments
      const eps = 1e-6 / g.inv
      const qu = q[g.u]! + 0.7231 * eps
      const qv = q[g.v]! + 0.3117 * eps
      const c = Math.min(g.nu - 1, Math.floor((qu - g.u0) * g.inv)) + g.nu * Math.min(g.nv - 1, Math.floor((qv - g.v0) * g.inv))
      let parity = 0
      let signed = 0
      for (let s = g.start[c]!; s < g.start[c + 1]!; s++) {
        const t = g.tris[s]!
        const a = 3 * idx[t]!
        const bb = 3 * idx[t + 1]!
        const cc = 3 * idx[t + 2]!
        const au = p[a + g.u]! - qu
        const av = p[a + g.v]! - qv
        const bu = p[bb + g.u]! - qu
        const bv = p[bb + g.v]! - qv
        const cu = p[cc + g.u]! - qu
        const cv = p[cc + g.v]! - qv
        const w0 = bu * cv - bv * cu
        const w1 = cu * av - cv * au
        const w2 = au * bv - av * bu
        const pos = w0 > 0 && w1 > 0 && w2 > 0
        const neg = w0 < 0 && w1 < 0 && w2 < 0
        if (!pos && !neg) continue
        const hit = (w0 * p[a + g.w]! + w1 * p[bb + g.w]! + w2 * p[cc + g.w]!) / (w0 + w1 + w2)
        if (hit <= q[g.w]!) continue
        parity ^= 1
        signed += pos ? 1 : -1
      }
      if (parity === 1 || signed !== 0) votes++
    }
    return votes >= 2
  }
}

// ── 规则 / the rule ──────────────────────────────────────────────────────────────────────────────────

/**
 * 神经 → 它所支配的肌。`whole`：整条都是肌支（“……肌支”“至某肌的神经”、臀上/臀下神经），在所支配的肌内的任何一段都算；
 * 否则是混合神经干：只有它的分支（部件里最粗那条折线之外的折线）在所支配的肌内才算，干本身不算。
 * Nerve → the muscles it supplies. `whole`: the whole part is a motor branch ("muscular branches of …",
 * "nerve to …", the gluteal nerves), and any stretch of it inside a muscle it supplies counts; otherwise
 * it is a mixed trunk: only its branches (every polyline of the part other than the thickest one) count
 * inside a muscle they supply, never the trunk itself.
 */
export const NERVE_SUPPLY: { nerve: RegExp; muscle: RegExp; whole?: boolean }[] = [
  { nerve: /muscular branches of femoral nerve/i, muscle: /rectus femoris|vastus|sartorius|pectineus|iliacus|articularis genus/i, whole: true },
  { nerve: /nerves? to psoas major and iliacus/i, muscle: /psoas|iliacus/i, whole: true },
  { nerve: /nerve to obturator internus/i, muscle: /obturator internus|gemellus superior|superior gemellus/i, whole: true },
  { nerve: /nerve to quadratus femoris/i, muscle: /quadratus femoris|gemellus inferior|inferior gemellus/i, whole: true },
  { nerve: /nerve to piriformis/i, muscle: /piriformis/i, whole: true },
  { nerve: /nerves? to levator ani and coccygeus/i, muscle: /levator ani|pubovisceral|puborectal|iliococcyge|coccyge/i, whole: true },
  { nerve: /superior gluteal nerve/i, muscle: /gluteus medius|gluteus minimus|tensor fasciae latae/i, whole: true },
  { nerve: /inferior gluteal nerve/i, muscle: /gluteus maximus/i, whole: true },
  { nerve: /^(left|right) femoral nerve$/i, muscle: /iliacus|pectineus/i },
  { nerve: /anterior branch of obturator nerve/i, muscle: /adductor longus|adductor brevis|gracilis|pectineus/i },
  { nerve: /posterior branch of obturator nerve/i, muscle: /obturator externus|adductor magnus|adductor minimus|adductor brevis/i },
  { nerve: /^(left|right) obturator nerve$/i, muscle: /obturator externus/i },
  { nerve: /sciatic nerve/i, muscle: /semitendinosus|semimembranosus|biceps femoris|adductor magnus/i },
  { nerve: /common fibular nerve/i, muscle: /short head of .*biceps femoris/i },
  { nerve: /tibial nerve/i, muscle: /gastrocnemius|soleus|plantaris|popliteus|tibialis posterior|flexor digitorum longus|flexor hallucis longus/i },
  { nerve: /deep fibular nerve/i, muscle: /tibialis anterior|extensor digitorum longus|extensor hallucis longus|fibularis tertius|extensor digitorum brevis/i },
  { nerve: /superficial fibular nerve/i, muscle: /fibularis longus|fibularis brevis|peroneus/i },
  { nerve: /pudendal nerve|perineal nerve|inferior (rectal|anal) nerve/i, muscle: /perineal|bulbospongios|ischiocavernos|anal sphincter|urethra/i },
]

/**
 * 神经干本来就穿过的肌 / muscles a trunk really passes through:
 * 腰丛在腰大肌内形成，各支自肌内穿出（生殖股神经穿出其前面）；闭孔神经后支穿闭孔外肌；
 * 腓总神经绕腓骨颈时在腓骨长肌深面分叉，腓浅神经起始段在腓骨长肌内；腓深神经向前穿过趾长伸肌起始部。
 * the lumbar plexus forms inside psoas major and its branches leave through the muscle (the
 * genitofemoral nerve through its anterior surface); the posterior branch of the obturator nerve
 * pierces obturator externus; the common fibular nerve divides deep to fibularis longus at the neck
 * of the fibula, and the superficial fibular nerve begins inside that muscle; the deep fibular nerve
 * passes forwards through the origin of extensor digitorum longus.
 */
export const NERVE_PASSAGES: { nerve: RegExp; muscle: RegExp }[] = [
  { nerve: /genitofemoral nerve|femoral nerve|obturator nerve|lateral femoral cutaneous nerve|iliohypogastric|ilio-?inguinal|lumbar plexus|lumbosacral trunk|subcostal nerve/i, muscle: /psoas major/i },
  { nerve: /posterior branch of obturator nerve/i, muscle: /obturator externus/i },
  { nerve: /common fibular nerve|superficial fibular nerve|deep fibular nerve/i, muscle: /fibularis longus|peroneus longus/i },
  { nerve: /deep fibular nerve/i, muscle: /extensor digitorum longus/i },
]

export type CourseClass = 'motor' | 'passage' | 'unexplained'

/** 部件里最粗的折线（并列时取最长的）：神经干 / the thickest polyline of a part (the longest among equals): the trunk */
export function trunkIndex(lines: Polyline[]): number {
  let best = 0
  let bestR = -1
  let bestN = -1
  lines.forEach((l, i) => {
    let r = 0
    for (const x of l.radius) if (x > r) r = x
    r = Math.round(r * 1e6)
    if (r > bestR || (r === bestR && l.radius.length > bestN)) {
      best = i
      bestR = r
      bestN = l.radius.length
    }
  })
  return best
}

/** 神经 `nerve` 的一条折线（`isTrunk`：是否为干）在肌 `muscle` 内的一段属于哪一类 / the class of a stretch of one polyline of `nerve` (`isTrunk`: the trunk or a branch) inside `muscle` */
export function classifyCourse(nerve: string, muscle: string, isTrunk: boolean): CourseClass {
  for (const s of NERVE_SUPPLY) if (s.nerve.test(nerve) && s.muscle.test(muscle) && (s.whole || !isTrunk)) return 'motor'
  for (const s of NERVE_PASSAGES) if (s.nerve.test(nerve) && s.muscle.test(muscle)) return 'passage'
  return 'unexplained'
}

export const COURSE_RULE =
  'A stretch of nerve more than 3 mm inside one of her real muscles is "motor" when the muscle is one the nerve supplies and the stretch belongs to a named motor nerve or to a side branch (any polyline other than the thickest) of a mixed nerve; "passage" when the trunk is known to pass through that muscle (lumbar plexus branches through psoas major, posterior branch of the obturator nerve through obturator externus, the fibular nerves through fibularis longus at the neck of the fibula, the deep fibular nerve through the origin of extensor digitorum longus); otherwise "unexplained". Supply and passages follow standard textbook anatomy; no source was opened to verify the table.'

// ── 统计 / the measure ───────────────────────────────────────────────────────────────────────────────

export interface CourseNerve {
  id: string
  name: string
  lines: Polyline[]
}

export interface CourseSolid {
  id: string
  name: string
  mesh: Mesh
}

export interface CourseRow {
  nerve: string
  muscle: string
  class: CourseClass
  lengthMm: number
}

export interface CourseReport {
  rule: string
  deepMm: number
  /** 所有神经中心线的总长（米）/ total centreline length of all nerves (m) */
  lengthM: number
  muscles: number
  /** 深入她真实肌内超过 `deepMm` 的长度占总长的比例：全部、肌支、穿肌段、无法解释的 / share of the total length lying more than `deepMm` inside her real muscles: all of it, motor branches, passages, unexplained */
  rawShare: number
  motorShare: number
  passageShare: number
  unexplainedShare: number
  /** 无法解释的各段，按长度排序 / the unexplained stretches, longest first */
  unexplained: CourseRow[]
  /** 算作解剖的各段，按长度排序 / the stretches counted as anatomy, longest first */
  explained: CourseRow[]
}

interface Prepared {
  s: CourseSolid
  bbox: number[]
  tester: SolidTester | null
  surface: PointIndex | null
}

const prepare = (solids: CourseSolid[]): Prepared[] => solids.map((s) => ({ s, bbox: measure(s.mesh).bbox, tester: null, surface: null }))

/** 点在哪块肌内且距其表面超过 `deep`；没有则返回 -1 / the muscle a point lies in, more than `deep` from its surface; -1 when none */
function deepIn(muscles: Prepared[], x: number, y: number, z: number, deep: number): number {
  for (let i = 0; i < muscles.length; i++) {
    const m = muscles[i]!
    const b = m.bbox
    if (x < b[0]! || x > b[3]! || y < b[1]! || y > b[4]! || z < b[2]! || z > b[5]!) continue
    m.tester ??= new SolidTester(m.s.mesh)
    if (!m.tester.contains(x, y, z)) continue
    m.surface ??= new PointIndex(thinPoints(surfacePoints(m.s.mesh, 0.0025), 0.002), 0.008)
    if (m.surface.distance(x, y, z, deep) >= deep) return i
  }
  return -1
}

/**
 * 神经中心线深入真实肌内的长度，按上面的规则分类。`muscles` 只给她真实的肌（Denver、CT、Wu），不含形变来的男性肌。
 * Length of nerve centrelines deep inside real muscles, classified by the rule above. `muscles` are her
 * real muscles only (Denver, CT, Wu), not the male muscles carried by the warp.
 */
export function nerveCourseReport(nerves: CourseNerve[], muscles: CourseSolid[], opts: { deep?: number; step?: number; rows?: number } = {}): CourseReport {
  const { deep = 0.003, step = 0.001, rows = 40 } = opts
  const prepared = prepare(muscles)
  const acc = new Map<string, CourseRow>()
  let total = 0
  for (const n of nerves) {
    const trunk = trunkIndex(n.lines)
    n.lines.forEach((line, li) => {
      const d = densify(line, step)
      const m = d.points.length / 3
      if (m < 2) return
      const seg = (j: number) => Math.hypot(d.points[3 * j]! - d.points[3 * j - 3]!, d.points[3 * j + 1]! - d.points[3 * j - 2]!, d.points[3 * j + 2]! - d.points[3 * j - 1]!)
      for (let i = 0; i < m; i++) {
        const w = (i > 0 ? seg(i) / 2 : 0) + (i < m - 1 ? seg(i + 1) / 2 : 0)
        total += w
        const k = deepIn(prepared, d.points[3 * i]!, d.points[3 * i + 1]!, d.points[3 * i + 2]!, deep)
        if (k < 0) continue
        const muscle = prepared[k]!.s.name
        const cls = classifyCourse(n.name, muscle, li === trunk)
        const key = `${n.name}|${muscle}|${cls}`
        const row = acc.get(key) ?? { nerve: n.name, muscle, class: cls, lengthMm: 0 }
        row.lengthMm += w * 1000
        acc.set(key, row)
      }
    })
  }
  const all = [...acc.values()].sort((a, b) => b.lengthMm - a.lengthMm || (a.nerve + a.muscle < b.nerve + b.muscle ? -1 : 1))
  const sum = (c?: CourseClass) => all.filter((r) => !c || r.class === c).reduce((s, r) => s + r.lengthMm, 0) / 1000
  const share = (v: number) => (total ? Math.round((v / total) * 1e5) / 1e5 : 0)
  const tidy = (r: CourseRow): CourseRow => ({ ...r, lengthMm: Math.round(r.lengthMm * 10) / 10 })
  return {
    rule: COURSE_RULE, deepMm: deep * 1000, lengthM: Math.round(total * 100) / 100, muscles: muscles.length,
    rawShare: share(sum()), motorShare: share(sum('motor')), passageShare: share(sum('passage')), unexplainedShare: share(sum('unexplained')),
    unexplained: all.filter((r) => r.class === 'unexplained').slice(0, rows).map(tidy),
    explained: all.filter((r) => r.class !== 'unexplained').slice(0, rows).map(tidy),
  }
}

// ── 移出 / clearing ──────────────────────────────────────────────────────────────────────────────────

/** 由中心线重建神经的管状网格（与 importZa.ts 的做法相同）/ rebuilds a nerve's tube mesh from its centrelines (as importZa.ts does) */
export function nerveTubes(lines: Polyline[], sidesByRadius: [number, number][] = [[0.00045, 5], [0.001, 6]], sides = 8): Mesh | null {
  const tubes: Mesh[] = []
  for (const b of lines) {
    let maxR = 0
    for (const r of b.radius) if (r > maxR) maxR = r
    const tube = buildTube(b, sidesByRadius.find(([r]) => maxR < r)?.[1] ?? sides)
    if (tube) tubes.push(tube)
  }
  return tubes.length ? mergeMeshes(tubes) : null
}

export interface ClearOptions {
  /** 一个点最多移动多远（米）/ how far a point may be moved (m) */
  maxPush: number
  /** 中心线重采样的间距（米）/ spacing the centrelines are resampled to (m) */
  step: number
  /** 位移沿中心线平滑的半宽（米）/ half-width over which the displacement is smoothed along the centreline (m) */
  smooth: number
}

export const CLEAR_DEFAULTS: ClearOptions = { maxPush: 0.04, step: 0.002, smooth: 0.008 }

export interface ClearResult {
  /** 改动过的神经：新的中心线和网格 / the nerves that changed: new centrelines and mesh */
  changed: Map<string, { lines: Polyline[]; mesh: Mesh }>
  nerves: number
  pointsMoved: number
  meanMoveMm: number
  maxMoveMm: number
}

/**
 * 把神经从规则解释不了的肌里移出来：有“无法解释”的深入段的折线，其上的点沿就近的出路滑到肌表面之外（同
 * pushOutOfSolids），位移沿中心线平滑，最后再滑出骨。算作肌支或穿肌段的肌不当作障碍。只动确有这种段的折线。
 * Moves nerves out of muscles the rule cannot explain: on polylines that have an "unexplained" deep
 * stretch, points slide out past the muscle surface by the locally dominant way out (pushOutOfSolids),
 * the displacement is smoothed along the centreline, and bone is cleared last. Muscles in which the
 * polyline counts as a motor branch or a passage are not obstacles. Polylines without such a stretch
 * are left exactly as they are.
 */
export function clearNervesFromMuscles(nerves: CourseNerve[], muscles: (CourseSolid & { fma?: string })[], bones: (CourseSolid & { fma?: string })[], options: Partial<ClearOptions> = {}): ClearResult {
  const opts = { ...CLEAR_DEFAULTS, ...options }
  const prepared = prepare(muscles)
  const solids: ExistingPart[] = [
    ...muscles.map((m) => ({ id: m.id, fma: m.fma ?? m.id, name: m.name, mesh: m.mesh, stats: measure(m.mesh), system: 'muscular', tissue: 'muscle' }) as ExistingPart),
    ...bones.map((m) => ({ id: m.id, fma: m.fma ?? m.id, name: m.name, mesh: m.mesh, stats: measure(m.mesh), system: 'skeletal', tissue: 'bone' }) as ExistingPart),
  ]
  const field = new SurfaceField(solids)
  const changed = new Map<string, { lines: Polyline[]; mesh: Mesh }>()
  let pointsMoved = 0
  let moveSum = 0
  let moveMax = 0
  for (const n of nerves) {
    const trunk = trunkIndex(n.lines)
    let touched = false
    const out = n.lines.map((line, li) => {
      const d = densify(line, opts.step)
      const m = d.points.length / 3
      if (m < 2) return line
      // 这条折线在哪些肌里有无法解释的深入段 / the muscles this polyline has an unexplained deep stretch in
      const offending = new Set<number>()
      for (let i = 0; i < m; i++) {
        const k = deepIn(prepared, d.points[3 * i]!, d.points[3 * i + 1]!, d.points[3 * i + 2]!, 0.003)
        if (k >= 0 && classifyCourse(n.name, prepared[k]!.s.name, li === trunk) === 'unexplained') offending.add(k)
      }
      if (!offending.size) return line
      const bbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
      for (let i = 0; i < d.points.length; i += 3) for (let k = 0; k < 3; k++) {
        bbox[k] = Math.min(bbox[k]!, d.points[i + k]!)
        bbox[k + 3] = Math.max(bbox[k + 3]!, d.points[i + k]!)
      }
      let maxR = 0
      for (const r of d.radius) if (r > maxR) maxR = r
      const push = { clearance: Math.min(0.002, maxR) + 0.0003, maxPush: opts.maxPush, radius: 0.008, step: 0.0002 }
      // 不算障碍的肌：这条折线在其中算肌支或穿肌段 / not obstacles: muscles in which this polyline is a motor branch or a passage
      const obstacle = (i: number) => i < muscles.length && classifyCourse(n.name, muscles[i]!.name, li === trunk) === 'unexplained'
      let pts = pushOutOfSolids(d.points, bbox, field, obstacle, push).positions
      pts = pushOutOfSolids(pts, bbox, field, obstacle, push).positions
      // 位移沿中心线平滑（两端不动的点保持不动的趋势由平均自然给出）/ the displacement is smoothed along the centreline
      const half = Math.max(1, Math.round(opts.smooth / opts.step))
      const sm = new Float32Array(pts.length)
      for (let i = 0; i < m; i++) {
        let ws = 0
        const acc = [0, 0, 0]
        for (let j = Math.max(0, i - half); j <= Math.min(m - 1, i + half); j++) {
          const w = half + 1 - Math.abs(j - i)
          ws += w
          for (let k = 0; k < 3; k++) acc[k] = acc[k]! + w * (pts[3 * j + k]! - d.points[3 * j + k]!)
        }
        // 平滑只许把位移加大到不小于原位移的一半以上的程度：已经移出去的点不被拉回肌里
        // smoothing may spread the displacement but never pulls a moved point back by more than half
        for (let k = 0; k < 3; k++) {
          const raw = pts[3 * i + k]! - d.points[3 * i + k]!
          const s = acc[k]! / ws
          sm[3 * i + k] = d.points[3 * i + k]! + (Math.abs(s) < Math.abs(raw) / 2 ? raw / 2 + s / 2 : s)
        }
      }
      // 起点不动：分支仍接在干上 / the first point stays: a branch remains joined to its trunk
      for (let k = 0; k < 3; k++) sm[k] = d.points[k]!
      pts = pushOutOfSolids(sm, bbox, field, obstacle, push).positions
      pts = pushOutOfSolids(pts, bbox, field, (i) => i >= muscles.length, { ...push, maxPush: 0.01 }).positions
      for (let k = 0; k < 3; k++) pts[k] = d.points[k]!
      for (let i = 0; i < m; i++) {
        const mv = Math.hypot(pts[3 * i]! - d.points[3 * i]!, pts[3 * i + 1]! - d.points[3 * i + 1]!, pts[3 * i + 2]! - d.points[3 * i + 2]!)
        if (mv < 1e-6) continue
        pointsMoved++
        moveSum += mv
        moveMax = Math.max(moveMax, mv)
      }
      touched = true
      return simplifyPolyline({ points: pts, radius: d.radius }, 0.00025, 0.15, 0.012)
    })
    if (!touched) continue
    const mesh = nerveTubes(out)
    if (mesh) changed.set(n.id, { lines: out, mesh })
  }
  return { changed, nerves: changed.size, pointsMoved, meanMoveMm: pointsMoved ? Math.round((moveSum / pointsMoved) * 1e4) / 10 : 0, maxMoveMm: Math.round(moveMax * 1e4) / 10 }
}

// ── 构建里的入口 / entry point for the build ─────────────────────────────────────────────────────────

/** 构建中的部件（female.ts 的 FPart 满足这个形状）/ a part of the build (FPart in female.ts has this shape) */
export interface CoursePart {
  id: string
  fma?: string
  name: string
  tissue: string
  mesh: Mesh
  centrelines?: Polyline[]
}

export interface SettledCourses {
  /** 移出之前，在当时的几何上 / before clearing, on the geometry as it then was */
  before: { rawShare: number; motorShare: number; passageShare: number; unexplainedShare: number }
  cleared: { nerves: number; pointsMoved: number; meanMoveMm: number; maxMoveMm: number }
  /** 移出之后 / after clearing */
  after: CourseReport
}

/** 她真实的部件：id 不以 W_（形变来的男性部件）或 HRA_ 开头 / her real parts: ids not starting with W_ (male parts carried by the warp) or HRA_ */
export const isRealPart = (p: { id: string }): boolean => !p.id.startsWith('W_') && !p.id.startsWith('HRA_')

/**
 * 在当前几何上统计神经在她真实肌内的走行，把规则解释不了的段移出（就地改神经的中心线和网格），再统计一次。
 * 应在所有会移动肌的步骤（收拢、体形）之后调用。
 * Measures the nerves' courses inside her real muscles on the present geometry, moves the stretches
 * the rule cannot explain out of the muscles (nerve centrelines and meshes are changed in place), and
 * measures again. To be called after every step that moves muscles (slimming, body shape).
 */
export function settleNerveCourses(parts: CoursePart[], options: Partial<ClearOptions> = {}): SettledCourses {
  const muscles = parts.filter((p) => p.tissue === 'muscle' && isRealPart(p))
  const bones = parts.filter((p) => (p.tissue === 'bone' || p.tissue === 'cartilage') && isRealPart(p))
  const nerveParts = parts.filter((p) => p.tissue === 'nerve' && p.centrelines?.length)
  const asNerves = () => nerveParts.map((p) => ({ id: p.id, name: p.name, lines: p.centrelines! }))
  const b = nerveCourseReport(asNerves(), muscles)
  const c = clearNervesFromMuscles(asNerves(), muscles, bones, options)
  for (const p of nerveParts) {
    const ch = c.changed.get(p.id)
    if (!ch) continue
    p.centrelines = ch.lines
    p.mesh = ch.mesh
  }
  return {
    before: { rawShare: b.rawShare, motorShare: b.motorShare, passageShare: b.passageShare, unexplainedShare: b.unexplainedShare },
    cleared: { nerves: c.nerves, pointsMoved: c.pointsMoved, meanMoveMm: c.meanMoveMm, maxMoveMm: c.maxMoveMm },
    after: nerveCourseReport(asNerves(), muscles),
  }
}
