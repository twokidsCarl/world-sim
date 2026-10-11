// 由骨骼几何求关节。data/curated/rig/joints.json 中的每个关节定义都列出所涉及的骨和一个求解方案；
// 下面的方案对这些骨的关节面做拟合（球面、双中心轴、回转轴、接触斑块等），并报告每次拟合的残差。
// Joints from bone geometry. Each joint definition of data/curated/rig/joints.json names the bones
// involved and a recipe; the recipes below fit the articular surfaces of those bones (sphere,
// two-centre axis, axis of revolution, contact patch, …) and report the residual of every fit.

import type { Joint, JointDof, Vec3 } from '../../src/anatomy/types.ts'
import { type Sample, fitRevolutionAxis, fitSphereRobust, pca } from './fits.ts'
import { Surface, meshVolume } from './geom.ts'
import { nelderMead, refineHinge } from './hinge.ts'
import type { Body } from './io.ts'
import { type V3, add, axisAngle, cross, deg, dist, dot, len, lerp, m3apply, mean, mul, norm, rad, reject, solve, sub } from './math.ts'

// ── 定义 / definitions ────────────────────────────────────────────────────────────────────────

export interface DofDef {
  axis: 0 | 1 | 2
  name: { en: string; zh: string }
  rom: string
  sign: [string, string]
  rest?: string
  driver?: { joint: string; dof: number }
}

export interface JointDef {
  id: string
  name: { en: string; zh: string }
  parent: string | null
  bones: string[]
  recipe: string
  args: Record<string, string | number | number[]>
  tail: { joint?: string; landmark?: string }
  frame: { axis0: string; keep: string; axis2?: string }
  dofs: DofDef[]
  branch?: string
  side: 'L' | 'R' | 'M'
  restProx?: string
  restNeutral?: number
}

export interface JointFile {
  joints: unknown[]
}

const SIDES = [
  { s: 'L', Side: 'Left', side: 'left', zh: '左' },
  { s: 'R', Side: 'Right', side: 'right', zh: '右' },
]

function subst<T>(v: T, vars: Record<string, string>): T {
  if (typeof v === 'string') return v.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m) as T
  if (Array.isArray(v)) return v.map((x) => subst(x, vars)) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, vars)])) as T
  return v
}

/** 把 joints.json 中的 `sides` / `for` 模板展开为每个关节一条定义。 Expands the `sides` / `for` templates of joints.json into one definition per joint. */
export function expandJointDefs(file: JointFile): JointDef[] {
  const out: JointDef[] = []
  for (const raw of file.joints as (Record<string, unknown> & { sides?: boolean; for?: Record<string, string>[] })[]) {
    const { sides, for: each, ...rest } = raw
    for (const sv of sides ? SIDES : [null]) {
      for (const fv of each ?? [{}]) {
        const d = subst(rest, { ...(sv ?? {}), ...fv }) as unknown as JointDef
        d.side = sv ? (sv.s as 'L' | 'R') : 'M'
        out.push(d)
      }
    }
  }
  return out
}

// ── 骨骼访问 / skeleton access ────────────────────────────────────────────────────────────────

export class Skeleton {
  private readonly surfaces = new Map<string, Surface>()
  private readonly sampleCache = new Map<string, Sample[]>()
  private readonly nameToId = new Map<string, string>()

  constructor(readonly body: Body) {
    for (const p of body.data.parts) if (!this.nameToId.has(p.name)) this.nameToId.set(p.name, p.id)
  }

  has(name: string): boolean {
    return this.nameToId.has(name)
  }
  id(name: string): string {
    const id = this.nameToId.get(name)
    if (!id) throw new Error(`rig: no part named "${name}" in this body`)
    return id
  }
  surface(name: string): Surface {
    let s = this.surfaces.get(name)
    if (!s) this.surfaces.set(name, (s = new Surface(this.body.meshes.get(this.id(name))!)))
    return s
  }
  /** 按面积加权的表面采样点，间距约 1.2 mm。 Area-weighted surface samples about 1.2 mm apart. */
  samples(name: string): Sample[] {
    let s = this.sampleCache.get(name)
    if (!s) this.sampleCache.set(name, (s = this.surface(name).samples(0.0012)))
    return s
  }
  minDistance(a: string, b: string): number {
    const B = this.surface(b)
    let m = Infinity
    for (const s of this.samples(a)) {
      const d = B.distance(s.p[0], s.p[1], s.p[2], m)
      if (d < m) m = d
    }
    return m
  }
  /** `a` 上距 `b` 表面不超过 `d` 的采样点。 Samples of `a` within `d` of the surface of `b`. */
  near(a: string, b: string, d: number): Sample[] {
    const B = this.surface(b)
    return this.samples(a).filter((s) => B.distance(s.p[0], s.p[1], s.p[2], d) <= d)
  }
  /** `a` 上距 `b` 不超过（最近距离 + 余量）的采样点。 Samples of `a` within (closest approach + margin) of `b`. */
  facing(a: string, b: string, margin: number): Sample[] {
    return this.near(a, b, this.minDistance(a, b) + margin)
  }
  centroid(name: string): V3 {
    return wmean(this.samples(name))
  }
  /** 骨的单位长轴（最大主方向），指向 `toward`。 Unit long axis of a bone (largest principal direction), oriented along `toward`. */
  longAxis(name: string, toward: V3): V3 {
    const s = this.samples(name)
    const ax = pca(s.map((x) => x.p), s.map((x) => x.w)).axes[0]
    return dot(ax, toward) < 0 ? mul(ax, -1) : ax
  }
  /** 沿 `dir` 方向最远的采样点。 The sample farthest along `dir`. */
  extreme(name: string, dir: V3): V3 {
    let best = -Infinity
    let p: V3 = [0, 0, 0]
    for (const s of this.samples(name)) {
      const v = dot(s.p, dir)
      if (v > best) (best = v), (p = s.p)
    }
    return p
  }
  /** 距骨沿 `dir` 方向极点不超过 `depth` 的采样点。 Samples within `depth` of the bone's extreme along `dir`. */
  endSamples(name: string, dir: V3, depth: number): Sample[] {
    const top = dot(this.extreme(name, dir), dir)
    return this.samples(name).filter((s) => dot(s.p, dir) >= top - depth)
  }
  volume(name: string): number {
    const m = this.body.meshes.get(this.id(name))!
    return Math.abs(meshVolume(m.positions, m.indices))
  }
}

const wmean = (s: Sample[]): V3 => {
  let W = 0
  const c: V3 = [0, 0, 0]
  for (const x of s) (W += x.w), (c[0] += x.w * x.p[0]), (c[1] += x.w * x.p[1]), (c[2] += x.w * x.p[2])
  return W > 0 ? mul(c, 1 / W) : c
}

// ── 结果 / results ────────────────────────────────────────────────────────────────────────────

export interface FitNote {
  /** 拟合的对象。 What was fitted. */
  what: string
  /** 残差均方根，单位为 mm，仅当该量为最小二乘拟合时给出。 RMS residual in mm, when the quantity is a least-squares fit. */
  rmsMm?: number
  radiusMm?: number
  samples?: number
  /** 自由格式的附加数值（角度单位为度，距离单位为 mm）。 Free-form extra numbers (angles in degrees, distances in mm). */
  extra?: Record<string, number | string>
}

export interface BuiltJoint {
  def: JointDef
  center: V3
  axes: [V3, V3, V3]
  tail: V3
  /** 随该关节刚性运动的骨的部件 id。 Part ids of the bones moving rigidly with the joint. */
  boneIds: string[]
  fits: FitNote[]
  basis: { en: string; zh: string }
  /** 各自由度在模型静止姿态下的角度，按解剖学约定度量（弧度）。 Angle of each dof in the model's rest pose, measured in the anatomical convention (radians). */
  rest: number[]
  restNotes: string[]
  /** 各自由度的耦合比（未被驱动时为 0）。 Coupling ratio per dof (0 when not driven). */
  driverRatio: number[]
  warnings: string[]
  landmarks?: Record<string, V3>
}

interface RecipeOut {
  center: V3
  axis?: V3
  frame?: [V3, V3, V3]
  landmarks?: Record<string, V3>
  fits: FitNote[]
  basis: { en: string; zh: string }
  driverRatio?: number
}

const mm = (x: number): number => Math.round(x * 1e5) / 100
const r1 = (x: number): number => Math.round(x * 10) / 10
const sideDir = (side: 'L' | 'R' | 'M'): V3 => (side === 'R' ? [-1, 0, 0] : [1, 0, 0])
const UP: V3 = [0, 1, 0], FRONT: V3 = [0, 0, 1]

function direction(name: string, side: 'L' | 'R' | 'M'): V3 {
  switch (name) {
    case 'anterior': return FRONT
    case 'posterior': return [0, 0, -1]
    case 'up': return UP
    case 'down': return [0, -1, 0]
    case 'left': return [1, 0, 0]
    case 'right': return [-1, 0, 0]
    case 'lateral': return sideDir(side)
    case 'medial': return mul(sideDir(side), -1)
  }
  throw new Error(`rig: unknown direction "${name}"`)
}

/** 对 `head` 朝向 `socket` 的部分做稳健球面拟合，再在整个球冠上重新生长。 Robust sphere through the part of `head` facing `socket`, then regrown over the whole spherical cap. */
function headSphere(sk: Skeleton, head: string, seed: Sample[], what: string): { center: V3; radius: number; note: FitNote; ok: boolean } {
  let res = fitSphereRobust(seed)
  if (!res) return { center: wmean(seed), radius: 0, note: { what: `${what}: too few samples for a sphere, centroid of the facing surface used`, samples: seed.length }, ok: false }
  // 重新生长：该骨上位于球面上且法线朝外的所有采样点
  // regrow: every sample of the bone lying on the sphere with an outward normal
  for (let it = 0; it < 3; it++) {
    const { center, radius } = res.fit
    const tol = Math.max(0.0005, 2 * res.fit.rms)
    const grown = sk.samples(head).filter((s) => {
      const v = sub(s.p, center)
      const l = len(v)
      return Math.abs(l - radius) <= tol && dot(v, s.n) / l > 0.8
    })
    if (grown.length < seed.length * 0.5) break
    const next = fitSphereRobust(grown)
    if (!next || Math.abs(next.fit.radius - radius) > 0.25 * radius) break
    res = next
  }
  const area = res.inliers.reduce((s, x) => s + x.w, 0)
  const cap = area / (4 * Math.PI * res.fit.radius ** 2)
  return {
    center: res.fit.center,
    radius: res.fit.radius,
    note: { what, rmsMm: mm(res.fit.rms), radiusMm: mm(res.fit.radius), samples: res.inliers.length, extra: { sphereCoverage: Math.round(cap * 100) / 100 } },
    ok: res.fit.rms < 0.12 * res.fit.radius,
  }
}

/**
 * 使轴的正向转动把参考点 ref 移向指定身体方向。
 * Orients an axis so that a positive rotation about it moves the point `ref` in the named body direction.
 */
function orientAxis(axis: V3, center: V3, ref: V3, dirName: string, side: 'L' | 'R' | 'M'): V3 {
  return dot(cross(axis, sub(ref, center)), direction(dirName, side)) < 0 ? mul(axis, -1) : axis
}

/** 去掉沿单位向量 n 的分量（不归一化）。 Removes the component along unit n (not normalised). */
const reject3 = (a: V3, n: V3): V3 => sub(a, mul(n, dot(a, n)))

/** 轴上离点 p 最近的点。 The point of the axis (point, dir) closest to p. */
const onAxis = (point: V3, dir: V3, p: V3): V3 => add(point, mul(dir, dot(sub(p, point), dir)))

/** 平面内的代数圆拟合。 Algebraic circle fit in a plane spanned by unit vectors u, v through `origin`. */
function fitCircle(pts: V3[], origin: V3, u: V3, v: V3): { center: V3; radius: number; rms: number } | null {
  const M = new Float64Array(9), b = new Float64Array(3)
  const xy = pts.map((p) => [dot(sub(p, origin), u), dot(sub(p, origin), v)] as [number, number])
  for (const [x, y] of xy) {
    const row = [2 * x, 2 * y, 1], rhs = x * x + y * y
    for (let i = 0; i < 3; i++) {
      b[i] = b[i]! + row[i]! * rhs
      for (let j = 0; j < 3; j++) M[i * 3 + j] = M[i * 3 + j]! + row[i]! * row[j]!
    }
  }
  const x = solve(M, b, 3)
  if (!x) return null
  const r2 = x[2]! + x[0]! * x[0]! + x[1]! * x[1]!
  if (!(r2 > 0)) return null
  const radius = Math.sqrt(r2)
  let e = 0
  for (const [px, py] of xy) e += (Math.hypot(px - x[0]!, py - x[1]!) - radius) ** 2
  return { center: add(origin, add(mul(u, x[0]!), mul(v, x[1]!))), radius, rms: Math.sqrt(e / xy.length) }
}

const hingeNote = (what: string, h: { rms: number; rmsInit: number; turned: number; shifted: number; samples: number }): FitNote => ({
  what,
  rmsMm: mm(h.rms),
  samples: h.samples,
  extra: { gapChangeRmsBeforeMm: mm(h.rmsInit), axisTurnedDeg: r1(deg(h.turned)), axisShiftedMm: mm(h.shifted) },
})

type Recipe = (sk: Skeleton, def: JointDef, built: Map<string, BuiltJoint>) => RecipeOut | null
const A = (def: JointDef, k: string): string => String(def.args[k])

const recipes: Record<string, Recipe> = {
  pelvis(sk, def) {
    const l = headSphere(sk, A(def, 'femurL'), sk.near(A(def, 'femurL'), A(def, 'hipL'), 0.01), 'left femoral head sphere')
    const r = headSphere(sk, A(def, 'femurR'), sk.near(A(def, 'femurR'), A(def, 'hipR'), 0.01), 'right femoral head sphere')
    return {
      center: lerp(l.center, r.center, 0.5),
      fits: [l.note, r.note],
      basis: {
        en: 'Root of the skeleton: the midpoint between the centres of the two femoral heads (sphere fits); axes are the body axes.',
        zh: '骨架的根：取左右股骨头球心（球面拟合）连线的中点；轴取身体坐标轴。',
      },
    }
  },

  contact(sk, def) {
    const a = A(def, 'a'), b = A(def, 'b'), margin = Number(def.args.margin)
    const gap = sk.minDistance(a, b)
    const sa = sk.facing(a, b, margin), sb = sk.facing(b, a, margin)
    const center = lerp(wmean(sa), wmean(sb), 0.5)
    return {
      center,
      fits: [{ what: `contact patch between ${a} and ${b}`, samples: sa.length + sb.length, extra: { closestApproachMm: mm(gap), patchSpreadMm: mm(pca([...sa, ...sb].map((s) => s.p)).sigma[0]) } }],
      basis: {
        en: `Centre of the facing articular surfaces of the two bones (all surface within ${mm(margin)} mm of their closest approach); axes from the body axes and the direction of the moved bone.`,
        zh: `取两骨相对关节面（距最近点 ${mm(margin)} mm 以内的表面）的中心；轴取身体坐标轴与被带动骨的方向。`,
      },
    }
  },

  ball(sk, def) {
    const head = A(def, 'head'), socket = A(def, 'socket')
    const s = headSphere(sk, head, sk.near(head, socket, Number(def.args.d)), `sphere fitted to the head of ${head}`)
    const gap = sk.minDistance(head, socket)
    s.note.extra = { ...s.note.extra, jointGapMm: mm(gap) }
    return {
      center: s.center,
      fits: [s.note],
      basis: {
        en: `Centre of a least-squares sphere fitted to the articular surface of the head (radius ${mm(s.radius)} mm, RMS residual ${s.note.rmsMm} mm). Flexion axis: the transverse body axis squared to the bone's long axis; rotation about the long axis (ISB convention: Wu et al. 2002/2005).`,
        zh: `对关节头的关节面作最小二乘球面拟合，取球心（半径 ${mm(s.radius)} mm，残差均方根 ${s.note.rmsMm} mm）。屈伸轴取身体横轴并与骨长轴正交；旋转绕骨长轴（ISB 约定：Wu 等 2002/2005）。`,
      },
    }
  },


  condyles(sk, def) {
    const femur = A(def, 'femur'), tibia = A(def, 'tibia')
    const down = sk.longAxis(femur, sub(sk.centroid(tibia), sk.centroid(femur)))
    const lat = reject(sideDir(def.side), down)
    const ant = cross(lat, down)
    const antFixed = dot(ant, FRONT) < 0 ? mul(ant, -1) : ant
    const length = dot(sub(sk.extreme(femur, down), sk.extreme(femur, mul(down, -1))), down)
    const distal = sk.endSamples(femur, down, 0.11 * length)
    const mid = dot(wmean(distal), lat)
    // 每侧髁的后面与下面：胫骨从伸到屈所滚过的部分
    // posterior and distal faces of each condyle: where the tibia rolls from extension to flexion
    const pick = (sign: number): Sample[] => distal.filter((s) => sign * (dot(s.p, lat) - mid) > 0.004 && dot(s.n, antFixed) < 0.25 && sign * dot(s.n, lat) > -0.5)
    const sl = headSphere(sk, femur, pick(1), 'sphere fitted to the lateral femoral condyle (posterior and distal surface)')
    const sm = headSphere(sk, femur, pick(-1), 'sphere fitted to the medial femoral condyle (posterior and distal surface)')
    const center = lerp(sl.center, sm.center, 0.5)
    const axis = orientAxis(norm(sub(sl.center, sm.center)), center, sk.centroid(tibia), def.dofs[0]!.sign[1], def.side)
    // 对照：让胫骨平台在 0–130° 内与股骨髁保持恒定间隙的最佳固定轴
    // comparison: the fixed axis that best keeps the tibial plateau at constant gap to the condyles over 0–130°
    const fn = refineHinge(sk.facing(tibia, femur, 0.004), sk.surface(femur), { point: center, dir: axis }, { sweep: [0, 130] })
    const use = fn.rms < fn.rmsInit && fn.turned < rad(10) && fn.shifted < 0.01
    return {
      center: use ? onAxis(fn.point, fn.dir, center) : center,
      axis: use ? fn.dir : axis,
      fits: [sl.note, sm.note, { what: 'spacing of the two condylar centres', extra: { spacingMm: mm(dist(sl.center, sm.center)) } }, hingeNote(`functional axis: tibial plateau at constant gap to the condyles over 0–130° of flexion (${use ? 'used' : 'not used'})`, fn)],
      basis: {
        en: `Flexion axis through the centres of spheres fitted to the posterior-distal surfaces of the medial and lateral femoral condyles (radii ${mm(sm.radius)} / ${mm(sl.radius)} mm, RMS ${sm.note.rmsMm} / ${sl.note.rmsMm} mm): the geometric centre axis, close to the transepicondylar axis used by Grood & Suntay 1983. Centre: midpoint between the two sphere centres. ${use ? `Then refined to the fixed axis that best keeps the tibial plateau at constant gap to the condyles over 0–130° (turned ${r1(deg(fn.turned))}°, moved ${mm(fn.shifted)} mm; RMS change of gap ${mm(fn.rmsInit)} → ${mm(fn.rms)} mm). ` : ''}The axis is fixed; the real knee also rolls and glides.`,
        zh: `屈伸轴取内、外侧股骨髁后下关节面球面拟合的两球心连线（半径 ${mm(sm.radius)} / ${mm(sl.radius)} mm，残差 ${sm.note.rmsMm} / ${sl.note.rmsMm} mm），即“几何中心轴”，接近 Grood & Suntay 1983 所用的经上髁轴。中心取两球心中点。${use ? `再精修为在 0–130° 内使胫骨平台与股骨髁间隙最恒定的固定轴（转动 ${r1(deg(fn.turned))}°、移动 ${mm(fn.shifted)} mm；间隙变化均方根 ${mm(fn.rmsInit)} → ${mm(fn.rms)} mm）。` : ''}轴固定不动，而真实膝关节还有滚动与滑动。`,
      },
    }
  },



  patella(sk, def, built) {
    const knee = built.get(A(def, 'knee'))
    if (!knee) return null
    const patella = A(def, 'patella'), tibia = A(def, 'tibia'), femur = A(def, 'femur')
    const down = sk.longAxis(tibia, [0, -1, 0])
    const axis = orientAxis(knee.axes[0], knee.center, sk.centroid(tibia), def.dofs[0]!.sign[1], def.side)
    const apex = sk.extreme(patella, down)
    // 胫骨粗隆：膝关节中心下方 3.5–9 cm 之间胫骨最靠前的点
    // tibial tuberosity: the most anterior point of the tibia 3.5–9 cm below the knee centre
    const prox = sk.samples(tibia).filter((s) => {
      const h = dot(sub(s.p, knee.center), down)
      return h > 0.035 && h < 0.09
    })
    let tub = prox[0]!.p
    for (const s of prox) if (s.p[2] > tub[2]) tub = s.p
    const L0 = dist(apex, tub)
    // 髌骨绕一条平行于膝轴的轴转动，转角 = ratio × 膝屈曲角。轴的位置（矢状面内 2 个参数）与
    // ratio 一起优化：既让髌骨关节面与股骨保持恒定间隙，又让髌韧带长度不变。
    // The patella turns about an axis parallel to the knee axis by ratio × knee flexion. The position
    // of that axis (2 parameters in the sagittal plane) and the ratio are optimised together so that
    // the patellar surface keeps its gap to the femur and the patellar ligament keeps its length.
    const F = sk.surface(femur)
    const all = sk.facing(patella, femur, 0.004)
    const stride = Math.max(1, Math.ceil(all.length / 80))
    const P: V3[] = [], N: V3[] = [], G: number[] = []
    for (let i = 0; i < all.length; i += stride) {
      const c = F.closest(all[i]!.p, 0.02)
      if (!c || c.distance < 1e-6) continue
      P.push(all[i]!.p), N.push(mul(sub(c.point, all[i]!.p), 1 / c.distance)), G.push(c.distance)
    }
    const u = norm(cross(axis, down)), v = cross(axis, u)
    // 髌骨不得压进胫骨：髌骨表面的采样点到胫骨面的距离不应小于静止时的一半
    // the patella must not be driven into the tibia: its surface samples may not come closer to the tibia than half their rest distance
    const T = sk.surface(tibia)
    const allP = sk.samples(patella)
    const Q: V3[] = [], QD: number[] = []
    for (let i = 0; i < allP.length; i += Math.max(1, Math.ceil(allP.length / 60))) {
      const d = T.distance(allP[i]!.p[0], allP[i]!.p[1], allP[i]!.p[2], 0.05)
      Q.push(allP[i]!.p), QD.push(Math.min(0.008, Number.isFinite(d) ? d : 0.008))
    }
    const thetas = [15, 35, 55, 75, 95, 115, 135].map(rad)
    const terms = (x: number[]): { gap: number; lig: number; tib: number } => {
      const c = add(knee.center, add(mul(u, x[0]!), mul(v, x[1]!)))
      let eg = 0, el = 0, n = 0, et = 0
      for (const th of thetas) {
        const Rp = axisAngle(axis, x[2]! * th), Rk = axisAngle(axis, th)
        const RkInv = axisAngle(axis, -th)
        for (let i = 0; i < Q.length; i++) {
          // 髌骨采样点换到胫骨的静止坐标系 / the patellar sample in the tibia's rest frame
          const w = add(c, m3apply(Rp, sub(Q[i]!, c)))
          const q = add(knee.center, m3apply(RkInv, sub(w, knee.center)))
          const d = T.distance(q[0], q[1], q[2], 0.02)
          if (d < QD[i]! / 2) et += (QD[i]! / 2 - d) ** 2
        }
        const t = add(knee.center, m3apply(Rk, sub(tub, knee.center)))
        el += (dist(add(c, m3apply(Rp, sub(apex, c))), t) - L0) ** 2
        for (let i = 0; i < P.length; i++) {
          const p = add(c, m3apply(Rp, sub(P[i]!, c)))
          const q = F.closest(p, 0.03)
          const g = q ? dot(sub(q.point, p), m3apply(Rp, N[i]!)) : 0.03
          eg += Math.min(0.006, Math.abs(g - G[i]!)) ** 2
          n++
        }
      }
      return { gap: Math.sqrt(eg / Math.max(1, n)), lig: Math.sqrt(el / thetas.length), tib: Math.sqrt(et / (thetas.length * Q.length)) }
    }
    const cost = (x: number[]): number => {
      const t = terms(x)
      return t.gap ** 2 + t.lig ** 2 + 25 * t.tib ** 2
    }
    let best = { x: [0, 0, 1], f: cost([0, 0, 1]) }
    for (const start of [[0, 0, 1], [0.008, -0.004, 0.8], [0.012, 0.004, 0.7], [0.004, 0.008, 0.9]]) {
      const r = nelderMead(cost, start, [0.004, 0.004, 0.1], 220)
      if (r.f < best.f) best = r
    }
    const rigid = terms([0, 0, 1]), opt = terms(best.x)
    const ratio = best.x[2]!
    const center = add(knee.center, add(mul(u, best.x[0]!), mul(v, best.x[1]!)))
    return {
      center,
      axis,
      landmarks: { apex },
      driverRatio: ratio,
      fits: [
        {
          what: 'patellar axis (parallel to the knee axis) and flexion ratio fitted together: patellar surface at constant gap to the femur and patellar ligament at constant length over 15–135° of knee flexion',
          rmsMm: mm(opt.gap),
          samples: P.length,
          extra: { ratio: Math.round(ratio * 1000) / 1000, tibiaEncroachmentRmsMm: mm(opt.tib), ligamentLengthRmsMm: mm(opt.lig), ligamentLengthMm: mm(L0), axisFromKneeAxisMm: mm(dist(center, knee.center)), gapChangeRmsIfRigidWithTibiaMm: mm(rigid.gap) },
        },
      ],
      basis: {
        en: `The patella turns about an axis parallel to the knee's flexion axis and ${mm(dist(center, knee.center))} mm from it, by ${Math.round(ratio * 100) / 100} × the knee flexion angle. Axis position and ratio are the least-squares compromise between keeping the patellar surface at constant gap to the femur (RMS change ${mm(opt.gap)} mm) and keeping the patellar ligament (apex of patella to tibial tuberosity, ${mm(L0)} mm) at constant length (RMS change ${mm(opt.lig)} mm) over 15–135° of flexion. A simple coupling: no medial-lateral tracking, tilt or contact.`,
        zh: `髌骨绕一条平行于膝关节屈伸轴、距其 ${mm(dist(center, knee.center))} mm 的轴转动，角度为膝屈曲角的 ${Math.round(ratio * 100) / 100} 倍。轴的位置与该比例是两项要求之间的最小二乘折中：在屈膝 15–135° 范围内，髌骨关节面与股骨的间隙不变（变化均方根 ${mm(opt.gap)} mm），且髌韧带（髌尖至胫骨粗隆，${mm(L0)} mm）长度不变（变化均方根 ${mm(opt.lig)} mm）。这只是简单耦合：不含内外侧轨迹、倾斜与接触。`,
      },
    }
  },

  malleolar(sk, def) {
    const tibia = A(def, 'tibia'), fibula = A(def, 'fibula'), talus = A(def, 'talus')
    const down = sk.longAxis(tibia, sub(sk.centroid(talus), sk.centroid(tibia)))
    const mmTip = wmean(sk.endSamples(tibia, down, 0.002)), lmTip = wmean(sk.endSamples(fibula, down, 0.002))
    const mid = lerp(mmTip, lmTip, 0.5)
    const ref = sk.centroid(A(def, 'foot'))
    const mall = orientAxis(norm(sub(lmTip, mmTip)), mid, ref, def.dofs[0]!.sign[1], def.side)
    const fits: FitNote[] = [{ what: 'tips of the medial and lateral malleoli (ISB axis)', extra: { spacingMm: mm(dist(mmTip, lmTip)) } }]
    // 距骨滑车作为回转面 / the talar dome as a surface of revolution
    const dome = [...sk.facing(talus, tibia, 0.003), ...sk.facing(talus, fibula, 0.002)]
    const rev = fitRevolutionAxis(dome)
    let init = { point: mid, dir: mall }
    if (rev) {
      const d = dot(rev.dir, mall) < 0 ? mul(rev.dir, -1) : rev.dir
      const ang = deg(Math.acos(Math.min(1, dot(d, mall))))
      fits.push({ what: 'axis of revolution fitted to the talar dome (trochlea tali)', rmsMm: mm(rev.rms), radiusMm: mm(rev.radius), samples: rev.count, extra: { angleToMalleolarAxisDeg: r1(ang), radiusRmsMm: mm(rev.radiusRms) } })
      if (ang < 30 && rev.radius > 0.01 && rev.radius < 0.035) init = { point: onAxis(rev.point, d, mid), dir: d }
    }
    // 功能性精修：胫腓骨的踝穴在背屈–跖屈范围内与距骨滑车保持恒定间隙
    // functional refinement: the mortise of tibia and fibula keeps a constant gap to the talar dome through dorsi-/plantar flexion
    const mortise = [...sk.facing(tibia, talus, 0.003), ...sk.facing(fibula, talus, 0.003)]
    const fn = refineHinge(mortise, sk.surface(talus), init, { sweep: [-40, 20], invert: true })
    const fromMall = refineHinge(mortise, sk.surface(talus), { point: mid, dir: mall }, { sweep: [-40, 20], invert: true, maxEvals: 1 })
    fits.push(hingeNote('functional axis: mortise of tibia and fibula at constant gap to the talar dome over 40° plantar flexion to 20° dorsiflexion', fn))
    fits[fits.length - 1]!.extra = { ...fits[fits.length - 1]!.extra, angleToMalleolarAxisDeg: r1(deg(Math.acos(Math.min(1, Math.abs(dot(fn.dir, mall)))))), gapChangeRmsOfMalleolarAxisMm: mm(fromMall.rmsInit) }
    const useFn = fn.rms <= fromMall.rmsInit
    const axis = useFn ? fn.dir : mall
    const center = useFn ? onAxis(fn.point, fn.dir, mid) : mid
    return {
      center,
      axis,
      fits,
      basis: useFn
        ? {
            en: `Functional hinge axis of the talocrural joint: the fixed axis about which the mortise of tibia and fibula stays at constant gap to the talar dome over 40° of plantar flexion to 20° of dorsiflexion (RMS change of gap ${mm(fn.rms)} mm; ${mm(fromMall.rmsInit)} mm for the line through the malleolar tips, the ISB axis of Wu et al. 2002, from which it lies ${fits[fits.length - 1]!.extra!.angleToMalleolarAxisDeg}°). Started from the axis of revolution of the talar dome.`,
            zh: `距小腿关节的功能性铰链轴：在跖屈 40° 至背屈 20° 的范围内，使胫腓骨踝穴与距骨滑车保持间隙不变的固定轴（间隙变化均方根 ${mm(fn.rms)} mm；ISB 推荐的内外踝尖连线（Wu 等 2002）为 ${mm(fromMall.rmsInit)} mm，两轴相差 ${fits[fits.length - 1]!.extra!.angleToMalleolarAxisDeg}°）。优化自距骨滑车的回转轴出发。`,
          }
        : {
            en: 'Axis through the tips of the medial and lateral malleoli (ISB recommendation, Wu et al. 2002); centre at their midpoint. The functional fit to the talar dome was no better on this body.',
            zh: '轴取内踝尖与外踝尖连线（ISB 推荐，Wu 等 2002），中心取其中点。在本模型上，对距骨滑车的功能性拟合并不更好。',
          },
    }
  },


  subtalar(sk, def) {
    const talus = A(def, 'talus'), calc = A(def, 'calcaneus')
    // 足的坐标系：足底平面由跟骨最低点与第一、第五跖骨头最低点确定
    // foot frame: the sole plane through the lowest points of the heel and of the first and fifth metatarsal heads
    const heel = sk.extreme(calc, [0, -1, -0.6])
    const h1 = sk.extreme(A(def, 'mt1'), [0, -1, 0.6]), h5 = sk.extreme(A(def, 'mt5'), [0, -1, 0.6])
    let dorsal = norm(cross(sub(h1, heel), sub(h5, heel)))
    if (dorsal[1] < 0) dorsal = mul(dorsal, -1)
    const fwd = reject(sub(lerp(h1, h5, 0.5), heel), dorsal)
    const medial = reject(mul(sideDir(def.side), -1), dorsal)
    const medialPerp = reject(sub(medial, mul(fwd, dot(medial, fwd))), dorsal)
    // Inman 1976 的平均方向：与足底成 42°，偏足长轴内侧 23°
    // mean orientation of Inman 1976: 42° above the sole, 23° medial of the long axis of the foot
    const inman = norm(add(mul(norm(add(mul(fwd, Math.cos(rad(23))), mul(medialPerp, Math.sin(rad(23))))), Math.cos(rad(42))), mul(dorsal, Math.sin(rad(42)))))
    const sa = sk.facing(talus, calc, 0.0025), sb = sk.facing(calc, talus, 0.0025)
    const point = lerp(wmean(sa), wmean(sb), 0.5)
    const init = { point, dir: orientAxis(inman, point, add(point, [0, -0.1, 0]), def.dofs[0]!.sign[1], def.side) }
    const fn = refineHinge(sa, sk.surface(calc), init, { sweep: [-15, 25], invert: true, dirWeight: 0.0006, posWeight: 0.0006 })
    const flip = dot(fn.dir, inman) < 0 ? -1 : 1
    const ax = mul(fn.dir, flip)
    const incl = deg(Math.asin(dot(ax, dorsal)))
    const devi = deg(Math.atan2(dot(ax, medialPerp), dot(ax, fwd)))
    const note = hingeNote('functional axis: talar facets at constant gap to the calcaneus over 15° eversion to 25° inversion, started from Inman’s mean axis (42° up, 23° medial)', fn)
    note.extra = { ...note.extra, inclinationDeg: r1(incl), medialDeviationDeg: r1(devi) }
    return {
      center: onAxis(fn.point, fn.dir, point),
      axis: fn.dir,
      fits: [{ what: 'facing surfaces of talus and calcaneus', samples: sa.length + sb.length }, note],
      basis: {
        en: `Started from the mean subtalar axis of Inman 1976 (42° above the sole, 23° medial to the long axis of the foot) through the centre of the talocalcaneal facets, then turned to keep the talar facets at constant gap to the calcaneus over the range of motion: ${r1(incl)}° above the sole and ${r1(devi)}° medial on this body (RMS change of gap ${mm(fn.rms)} mm, from ${mm(fn.rmsInit)} mm). The tarsal bones here have about 200 vertices each; the literature orientation dominates the result.`,
        zh: `自 Inman 1976 的平均距下关节轴（与足底成 42°、偏足长轴内侧 23°）出发，令其通过距跟关节面的中心，再调整到使距骨关节面在活动范围内与跟骨保持间隙不变：在本模型上为与足底成 ${r1(incl)}°、偏内侧 ${r1(devi)}°（间隙变化均方根由 ${mm(fn.rmsInit)} mm 降至 ${mm(fn.rms)} mm）。这些跗骨每块只有约 200 个顶点，结果主要由文献方向决定。`,
      },
    }
  },


  digit(sk, def, built) {
    const prox = A(def, 'proximal'), distal = A(def, 'distal')
    const from = def.args.axisFrom ? built.get(A(def, 'axisFrom')) : undefined
    if (def.args.axisFrom && !from) return null
    const toDistal = sub(sk.centroid(distal), sk.centroid(prox))
    const lp = sk.longAxis(prox, toDistal), ld = sk.longAxis(distal, toDistal)
    const seed = sk.facing(prox, distal, 0.0025)
    const head = headSphere(sk, prox, seed, `sphere fitted to the head of ${prox}`)
    // 合理性检查：球心必须在骨头的末端之内
    // sanity: the centre must lie inside the head, near the end of the bone
    const end = sk.extreme(prox, lp)
    const width = pca(sk.endSamples(prox, lp, 0.006).map((s) => s.p)).sigma[0] * 2
    let center = head.center
    const fits: FitNote[] = [head.note]
    const along = dot(sub(end, center), lp)
    if (!head.ok || head.radius > 2.2 * width || head.radius < 0.25 * width || along < 0 || along > 3 * width) {
      center = wmean(sk.endSamples(prox, lp, width))
      fits.push({ what: 'sphere fit rejected (not a credible head); centre of the end of the bone used instead', extra: { headWidthMm: mm(width) } })
    }
    // 屈伸轴的初值 / initial flexion axis
    const long = norm(add(lp, ld))
    const R = Math.max(0.005, 1.4 * width)
    const around = [...sk.samples(prox), ...sk.samples(distal)].filter((s) => dist(s.p, center) < R)
    const flat = around.map((s) => {
      const v = sub(s.p, center)
      return sub(v, mul(long, dot(v, long)))
    })
    const pc = pca(flat, around.map((s) => s.w))
    const ratio = pc.sigma[0] / Math.max(1e-9, pc.sigma[1])
    let axis: V3, how: { en: string; zh: string }
    if (def.args.slab) {
      // 前足（或手掌）是一块扁平的“板”：屈伸轴取板面内垂直于趾（指）长轴的方向
      // the forefoot is a flat slab: the flexion axis is the in-plane direction perpendicular to the toe
      const s = def.side === 'L' ? 'Left' : 'Right'
      const slab = ['first', 'second', 'third', 'fourth', 'fifth'].flatMap((o) => sk.samples(`${s} ${o} ${A(def, 'slab')} bone`))
      const n = pca(slab.map((x) => x.p), slab.map((x) => x.w)).axes[2]
      axis = norm(cross(n, long))
      how = { en: 'the direction lying in the plane of the five metatarsals and perpendicular to the toe (the phalanges of the toes are too small and too coarse here for a fit of their own)', zh: '取位于五块跖骨所在平面内、并垂直于该趾长轴的方向（本模型的趾骨太小、网格太粗，无法单独拟合）' }
    } else if (from && ratio < 1.2) {
      axis = reject(from.axes[0], long)
      how = { en: `parallel to the flexion axis of the next joint of the same digit (${from.def.id}), because this head is nearly spherical (width / thickness ${Math.round(ratio * 100) / 100})`, zh: `与同一指下一个关节（${from.def.id}）的屈伸轴平行，因为此关节头接近球形（宽厚比 ${Math.round(ratio * 100) / 100}）` }
    } else {
      axis = reject(pc.axes[0], long)
      how = { en: `the direction in which the head and the opposing base are widest, perpendicular to the bones' long axes (width / thickness ${Math.round(ratio * 100) / 100})`, zh: `取头与相对的底在垂直于骨长轴平面内最宽的方向（宽厚比 ${Math.round(ratio * 100) / 100}）` }
    }
    axis = orientAxis(axis, center, sk.centroid(distal), def.dofs[0]!.sign[1], def.side)
    fits.push({ what: 'initial flexion axis', samples: around.length, extra: { widthToThickness: Math.round(ratio * 100) / 100, rule: def.args.slab ? 'slab' : from && ratio < 1.2 ? `from ${from.def.id}` : 'widest direction' } })
    let refined = ''
    if (Array.isArray(def.args.sweep)) {
      const sweep = def.args.sweep as [number, number]
      const fn = refineHinge(sk.facing(distal, prox, 0.0025), sk.surface(prox), { point: center, dir: axis }, { sweep, dirWeight: 0.0002, posWeight: 0.0004 })
      fits.push(hingeNote(`functional axis: base of the distal bone at constant gap to the head over ${sweep[0]}…${sweep[1]}°`, fn))
      if (fn.rms < fn.rmsInit && fn.turned < rad(25)) {
        axis = fn.dir
        center = onAxis(fn.point, fn.dir, center)
        refined = `${mm(fn.rmsInit)}→${mm(fn.rms)}`
      }
    }
    return {
      center,
      axis,
      landmarks: { tip: sk.extreme(distal, ld) },
      fits,
      basis: {
        en: `Centre: sphere fitted to the head of the proximal bone (radius ${head.note.radiusMm ?? '–'} mm, RMS ${head.note.rmsMm ?? '–'} mm)${fits.length > 2 && fits[1]!.what.startsWith('sphere fit rejected') ? ', rejected as not credible; the centre of the end of the bone is used' : ''}. Flexion axis: ${how.en}${refined ? `; then refined so that the base of the distal bone keeps a constant gap to the head through the range of flexion (RMS change of gap ${refined} mm)` : ''}. Each of these bones has only about 200 vertices, so the axis is good to several degrees at best.`,
        zh: `中心：对近侧骨的头作球面拟合（半径 ${head.note.radiusMm ?? '–'} mm，残差 ${head.note.rmsMm ?? '–'} mm）${fits.length > 2 && fits[1]!.what.startsWith('sphere fit rejected') ? '，但拟合不可信，改取骨末端的中心' : ''}。屈伸轴：${how.zh}${refined ? `；再精修到使远侧骨的底在屈曲范围内与关节头保持间隙不变（间隙变化均方根 ${refined} mm）` : ''}。这些骨每块只有约 200 个顶点，轴的精度至多为数度。`,
      },
    }
  },


  elbow(sk, def) {
    const hum = A(def, 'humerus'), ulna = A(def, 'ulna'), radius = A(def, 'radius')
    const cap = headSphere(sk, hum, sk.facing(hum, radius, 0.003), 'sphere fitted to the capitulum of the humerus')
    const troSeed = sk.facing(hum, ulna, 0.003)
    const tro = fitSphereRobust(troSeed)
    const troC = tro ? tro.fit.center : wmean(troSeed)
    const long = sk.longAxis(hum, [0, -1, 0])
    const ref = sk.centroid(ulna)
    const fits: FitNote[] = [cap.note, { what: 'sphere fitted to the trochlear groove where it faces the ulna', rmsMm: tro ? mm(tro.fit.rms) : undefined, radiusMm: tro ? mm(tro.fit.radius) : undefined, samples: troSeed.length }]
    // 初值：通过滑车中心、垂直于肱骨长轴的横向线
    // start: the transverse line through the trochlear centre, perpendicular to the humeral shaft
    const distalEnd = sk.endSamples(hum, long, 0.035)
    const wide = pca(distalEnd.map((x) => reject3(x.p, long)), distalEnd.map((x) => x.w))
    const epi = reject(wide.axes[0], long)
    fits.push({ what: 'widest direction of the distal humerus (epicondylar line), start of the axis search', extra: { widthToThickness: Math.round((wide.sigma[0] / wide.sigma[1]) * 100) / 100 } })
    const init = { point: troC, dir: orientAxis(epi, troC, ref, def.dofs[0]!.sign[1], def.side) }
    // 功能性精修：尺骨滑车切迹在 −15…125° 内与肱骨滑车保持恒定间隙
    // functional refinement: the trochlear notch of the ulna keeps a constant gap to the trochlea over −15…125°
    const fn = refineHinge([...sk.facing(ulna, hum, 0.003), ...sk.facing(radius, hum, 0.003)], sk.surface(hum), init, { sweep: [-15, 125], maxEvals: 260, maxSamples: 200, steps: 7, dirWeight: 0.0006, posWeight: 0.0001, starts: [[0.008, 0], [-0.008, 0], [0, 0.008], [0, -0.008], [0.008, 0.008], [-0.008, -0.008], [0.008, -0.008], [-0.008, 0.008]] })
    fits.push(hingeNote('functional axis: trochlear notch of the ulna and fovea of the radial head at constant gap to trochlea and capitulum over −15…125° of flexion', fn))
    const axis = fn.dir
    const two = norm(sub(cap.center, troC))
    fits.push({ what: 'comparison with the line through the capitulum and trochlea centres (ISB) and with the humeral shaft', extra: { angleToTwoCentreLineDeg: r1(deg(Math.acos(Math.min(1, Math.abs(dot(two, axis)))))), capitulumCentreOffAxisMm: mm(len(cross(sub(cap.center, fn.point), axis))), angleToEpicondylarLineDeg: r1(deg(fn.turned)), angleToShaftDeg: r1(deg(Math.acos(Math.abs(dot(axis, long))))) } })
    return {
      center: onAxis(fn.point, axis, troC),
      axis,
      landmarks: { ulnarHead: wmean(sk.endSamples(ulna, sk.longAxis(ulna, [0, -1, 0]), 0.008)), capitulum: cap.center },
      fits,
      basis: {
        en: `Functional hinge axis of the humero-ulnar joint: the fixed axis about which the trochlear notch of the ulna and the fovea of the radial head stay at constant gap to the trochlea and capitulum over −15…125° of flexion (RMS change of gap ${mm(fn.rms)} mm). Started from the epicondylar line (widest direction of the distal humerus) through the centre of the trochlea (sphere fit, RMS ${fits[1]!.rmsMm ?? '–'} mm), from which the result lies ${r1(deg(fn.turned))}°. The ISB axis (Wu et al. 2005) joins the centres of trochlea and capitulum; the capitulum sphere of this coarse humerus (RMS ${cap.note.rmsMm ?? '–'} mm on a ${cap.note.radiusMm ?? '–'} mm radius) is too poor to define it, and its centre lies ${fits[fits.length - 1]!.extra!.capitulumCentreOffAxisMm} mm off the axis used.`,
        zh: `肱尺关节的功能性铰链轴：在屈曲 −15…125° 范围内，使尺骨滑车切迹、桡骨头凹与肱骨滑车、肱骨小头保持间隙不变的固定轴（间隙变化均方根 ${mm(fn.rms)} mm）。优化自通过滑车中心（球面拟合，残差 ${fits[1]!.rmsMm ?? '–'} mm）的内外上髁连线方向（肱骨远端最宽的方向）出发，结果与之相差 ${r1(deg(fn.turned))}°。ISB 的轴（Wu 等 2005）连接滑车与肱骨小头的中心；但本模型肱骨网格较粗，小头的球面拟合太差（半径 ${cap.note.radiusMm ?? '–'} mm 而残差 ${cap.note.rmsMm ?? '–'} mm），不足以定轴，其球心距所用轴 ${fits[fits.length - 1]!.extra!.capitulumCentreOffAxisMm} mm。`,
      },
    }
  },

  pronation(sk, def, built) {
    const radius = A(def, 'radius'), ulna = A(def, 'ulna')
    const elbow = built.get(def.parent!)
    if (!elbow) return null
    const down = sk.longAxis(radius, [0, -1, 0])
    const headS = sk.endSamples(radius, mul(down, -1), 0.009)
    const rev = fitRevolutionAxis(headS.filter((s) => Math.abs(dot(s.n, down)) < 0.5))
    const hc = wmean(headS)
    const radialHead = rev && rev.radius > 0.006 && rev.radius < 0.02 ? add(rev.point, mul(rev.dir, dot(sub(hc, rev.point), rev.dir))) : hc
    // 尺骨头：尺骨远端朝向桡骨的部分（乙状切迹的承座）
    // ulnar head: the distal end of the ulna where it faces the radius (seat of the sigmoid notch)
    const uDown = sk.longAxis(ulna, [0, -1, 0])
    const uEnd = sk.endSamples(ulna, uDown, 0.014)
    const R = sk.surface(radius)
    const seat = uEnd.filter((s) => R.distance(s.p[0], s.p[1], s.p[2], 0.006) <= 0.006)
    const us = seat.length >= 20 ? fitSphereRobust(seat) : null
    const endC = wmean(sk.endSamples(ulna, uDown, 0.008))
    const ulnarHead = us && us.fit.radius > 0.004 && us.fit.radius < 0.02 && dist(us.fit.center, endC) < 0.008 ? us.fit.center : endC
    const axis = norm(sub(ulnarHead, radialHead))
    const cap = elbow.landmarks?.capitulum
    const fits: FitNote[] = [
      { what: 'centre of the radial head (axis of revolution of its rim)', rmsMm: rev ? mm(rev.rms) : undefined, radiusMm: rev ? mm(rev.radius) : undefined, samples: headS.length },
      { what: 'centre of the ulnar head (sphere fitted to its seat facing the radius)', rmsMm: us ? mm(us.fit.rms) : undefined, radiusMm: us ? mm(us.fit.radius) : undefined, samples: seat.length },
    ]
    if (cap) fits.push({ what: 'distance of the capitulum centre from the forearm rotation axis (should be small: the axis is said to pass through it)', extra: { distanceMm: mm(len(cross(sub(cap, radialHead), axis))) } })
    return {
      center: radialHead,
      axis,
      landmarks: { ulnarHead, radialHead, radiusDistal: wmean(sk.endSamples(radius, down, 0.01)) },
      fits,
      basis: {
        en: 'Forearm rotation axis from the centre of the radial head to the centre of the ulnar head (the classical axis of pronation–supination); the radius, and with it the hand, turns about it while the ulna stays with the elbow hinge.',
        zh: '前臂旋转轴取桡骨头中心至尺骨头中心的连线（经典的旋前–旋后轴）；桡骨连同手绕此轴转动，尺骨只随肘关节铰链运动。',
      },
    }
  },

  wrist(sk, def, built) {
    const cap = A(def, 'capitate'), lun = A(def, 'lunate'), sca = A(def, 'scaphoid')
    const ru = built.get(def.parent!)
    if (!ru) return null
    const seed = [...sk.facing(cap, lun, 0.0025), ...sk.facing(cap, sca, 0.0025)]
    const head = headSphere(sk, cap, seed, 'sphere fitted to the head of the capitate')
    const prox = sk.longAxis(cap, [0, 1, 0])
    const fallback = wmean(sk.endSamples(cap, prox, 0.006))
    const ok = head.ok && head.radius > 0.003 && head.radius < 0.012 && dist(head.center, fallback) < 0.008
    const center = ok ? head.center : fallback
    const fits = [head.note]
    if (!ok) fits.push({ what: 'sphere fit rejected; centre of the proximal pole of the capitate used instead' })
    const axis = norm(sub(ru.landmarks!.radiusDistal!, ru.landmarks!.ulnarHead!))
    return {
      center,
      axis: dot(axis, sideDir(def.side)) < 0 ? mul(axis, -1) : axis,
      fits,
      basis: {
        en: 'Radiocarpal and midcarpal joints lumped into one centre in the head of the capitate (the usual single-centre approximation). Flexion axis: from the ulnar head to the distal end of the radius, squared to the line from the centre to the head of the third metacarpal (ISB hand axis, Wu et al. 2005).',
        zh: '桡腕关节与腕中关节合并为一个中心，位于头状骨头部（常用的单中心近似）。屈伸轴取尺骨头至桡骨远端的方向，并与“中心—第三掌骨头”连线正交（ISB 手部长轴，Wu 等 2005）。',
      },
    }
  },

  thumbBase(sk, def, built) {
    const mcp = built.get(A(def, 'axisFrom'))
    if (!mcp) return null
    const mc = A(def, 'metacarpal'), tr = A(def, 'trapezium')
    const sa = sk.facing(mc, tr, 0.0025), sb = sk.facing(tr, mc, 0.0025)
    return {
      center: lerp(wmean(sa), wmean(sb), 0.5),
      axis: mcp.axes[0],
      fits: [{ what: 'contact patch between the first metacarpal and the trapezium', samples: sa.length + sb.length, extra: { closestApproachMm: mm(sk.minDistance(mc, tr)) } }],
      basis: {
        en: "Centre of the saddle surfaces between the trapezium and the base of the first metacarpal. Flexion axis parallel to the thumb's own metacarpophalangeal flexion axis; abduction axis perpendicular to it and to the metacarpal. The two real axes of this saddle joint do not intersect (Hollister et al. 1992); here they do.",
        zh: '中心取大多角骨与第一掌骨底鞍状关节面的中心。屈伸轴与拇指自身掌指关节的屈伸轴平行；外展轴与之及掌骨长轴垂直。该鞍状关节真实的两条轴并不相交（Hollister 等 1992），此处简化为相交。',
      },
    }
  },

  disc(sk, def) {
    const upper = A(def, 'upper'), lower = A(def, 'lower')
    const cu = sk.centroid(upper), cl = sk.centroid(lower)
    const su = sk.surface(upper), sl = sk.surface(lower)
    // 位于两块椎骨之间的椎间盘部件 / a disc part lying between the two vertebrae
    let best: { id: string; c: V3; score: number } | null = null
    for (const p of sk.body.data.parts) {
      if (p.tissue !== 'cartilage' || !/intervertebral dis[ck]/i.test(p.name)) continue
      const c = p.centroid as V3
      const du = su.distance(c[0], c[1], c[2], 0.03), dl = sl.distance(c[0], c[1], c[2], 0.03)
      if (!Number.isFinite(du) || !Number.isFinite(dl)) continue
      const score = Math.abs(du - dl) + du + dl
      if (!best || score < best.score) best = { id: p.id, c, score }
    }
    if (best && best.score < 0.035) {
      const m = sk.body.meshes.get(best.id)!
      const s = new Surface(m).samples(0.002)
      const pc = pca(s.map((x) => x.p), s.map((x) => x.w))
      return {
        center: pc.center,
        fits: [{ what: `centroid of the intervertebral disc between ${upper} and ${lower}`, samples: s.length, extra: { discThicknessMm: mm(pc.sigma[2] * 3.46), discTiltDeg: r1(deg(Math.acos(Math.min(1, Math.abs(dot(pc.axes[2], UP)))))) } }],
        basis: {
          en: 'Centre of the intervertebral disc of this motion segment (centroid of the disc mesh). Axes: transverse body axis for flexion–extension, the line to the next segment centre for axial rotation. The real instantaneous axes lie a little behind and below the disc centre and move with the motion.',
          zh: '取该运动节段椎间盘的中心（椎间盘网格的形心）。屈伸轴取身体横轴，轴向旋转绕指向上一节段中心的连线。真实的瞬时转动轴位于椎间盘中心稍后下方，并随运动而移动。',
        },
      }
    }
    // 没有椎间盘部件：取两个椎体相对面的中点（前半部分）
    // no disc part: midpoint of the facing surfaces of the two vertebral bodies (anterior half)
    const zc = (cu[2] + cl[2]) / 2
    const fu = sk.near(upper, lower, sk.minDistance(upper, lower) + 0.012).filter((s) => s.p[2] > zc && s.n[1] < -0.5)
    const fl = sk.near(lower, upper, sk.minDistance(upper, lower) + 0.012).filter((s) => s.p[2] > zc && s.n[1] > 0.5)
    const center = fu.length && fl.length ? lerp(wmean(fu), wmean(fl), 0.5) : add(lerp(cu, cl, 0.5), [0, 0, 0.008])
    return {
      center,
      fits: [{ what: `no disc part between ${upper} and ${lower}: midpoint of the facing end-plates`, samples: fu.length + fl.length }],
      basis: {
        en: 'No disc mesh for this segment: centre taken midway between the facing end-plates of the two vertebral bodies.',
        zh: '该节段没有椎间盘网格：中心取上下两椎体相对终板之间的中点。',
      },
    }
  },

  dens(sk, def) {
    const atlas = A(def, 'atlas'), axisBone = A(def, 'axis')
    const ring = sk.surface(atlas).bbox
    const dens = sk.samples(axisBone).filter((s) => s.p[1] > ring[1] + 0.003)
    const pc = pca(dens.map((s) => s.p), dens.map((s) => s.w))
    let dir = pc.axes[0]
    if (dir[1] < 0) dir = mul(dir, -1)
    return {
      center: pc.center,
      axis: dir,
      fits: [{ what: 'dens of the axis (the part of C2 inside the ring of the atlas)', samples: dens.length, extra: { densTiltFromVerticalDeg: r1(deg(Math.acos(Math.min(1, dir[1])))), densLengthMm: mm(pc.sigma[0] * 3.46) } }],
      basis: {
        en: 'Rotation axis along the dens: the centre and long axis of the part of the axis vertebra that stands inside the ring of the atlas. About half of all cervical rotation happens here.',
        zh: '旋转轴沿齿突：取枢椎伸入寰椎环内部分的中心与长轴。颈部旋转约有一半发生在这里。',
      },
    }
  },

  occipital(sk, def) {
    const occ = A(def, 'occipital'), atlas = A(def, 'atlas')
    const patch = sk.facing(occ, atlas, 0.0025)
    const L = patch.filter((s) => s.p[0] > 0), R = patch.filter((s) => s.p[0] < 0)
    const cl = wmean(L), cr = wmean(R)
    const sph = fitSphereRobust(patch)
    const midp = lerp(cl, cr, 0.5)
    const useSphere = !!sph && sph.fit.radius > 0.012 && sph.fit.radius < 0.07 && sph.fit.center[1] > midp[1] && Math.abs(sph.fit.center[0]) < 0.006
    const center: V3 = useSphere ? [0, sph!.fit.center[1], sph!.fit.center[2]] : midp
    const top = sk.extreme(occ, UP)
    void top
    return {
      center,
      axis: norm(sub(cl, cr)),
      landmarks: { vertex: add(center, [0, 0.11, 0]) },
      fits: [{ what: 'occipital condyles facing the atlas, and the sphere through both', rmsMm: sph ? mm(sph.fit.rms) : undefined, radiusMm: sph ? mm(sph.fit.radius) : undefined, samples: patch.length, extra: { condyleSpacingMm: mm(dist(cl, cr)), sphereUsed: useSphere ? 'yes' : 'no' } }],
      basis: {
        en: useSphere
          ? 'Nodding axis through the two occipital condyles; centre at the centre of the sphere on which both condylar surfaces lie (above the joint line, inside the skull base).'
          : 'Nodding axis through the two occipital condyles; centre midway between the condylar surfaces (a common sphere could not be fitted reliably).',
        zh: useSphere ? '点头轴通过左右枕髁；中心取两侧枕髁关节面共同所在球面的球心（位于关节线上方、颅底内）。' : '点头轴通过左右枕髁；中心取两侧枕髁关节面之间的中点（未能可靠拟合共同球面）。',
      },
    }
  },

  tmj(sk, def) {
    const man = A(def, 'mandible')
    const cl = wmean(sk.facing(man, A(def, 'temporalL'), 0.003)), cr = wmean(sk.facing(man, A(def, 'temporalR'), 0.003))
    return {
      center: lerp(cl, cr, 0.5),
      axis: norm(sub(cl, cr)),
      landmarks: { chin: sk.extreme(man, norm([0, -0.5, 1])) },
      fits: [{ what: 'heads of the mandible facing the temporal bones', extra: { condyleSpacingMm: mm(dist(cl, cr)) } }],
      basis: {
        en: 'Both temporomandibular joints as one hinge through the two heads of the mandible. Real opening also slides the heads forward onto the articular tubercles (the axis then lies near the mandibular foramen); that translation is not modelled.',
        zh: '两侧颞下颌关节合并为一条通过左右下颌头的铰链轴。真实张口时下颌头还会向前滑到关节结节上（此时转动轴接近下颌孔），这一平移未建模。',
      },
    }
  },

  rib(sk, def, built) {
    const rib = A(def, 'rib'), vert = A(def, 'vertebra')
    const s = sk.samples(rib)
    const side = sideDir(def.side)
    // 肋头：肋骨最内侧的一端 / head: the most medial end of the rib
    let minx = Infinity
    for (const x of s) minx = Math.min(minx, dot(x.p, side))
    const head = wmean(s.filter((x) => dot(x.p, side) < minx + 0.006))
    const gap = sk.minDistance(rib, vert)
    const nearV = sk.near(rib, vert, gap + 0.004)
    const tub = nearV.filter((x) => dist(x.p, head) > 0.014 && dot(sub(x.p, head), side) > 0.008)
    const fits: FitNote[] = []
    let axis: V3 | null = null
    if (tub.length >= 5 && gap < 0.006) {
      const t = wmean(tub)
      axis = norm(sub(t, head))
      fits.push({ what: 'line from the head of the rib (costovertebral joint) to its tubercle (costotransverse joint)', samples: tub.length, extra: { neckLengthMm: mm(dist(t, head)), closestApproachMm: mm(gap) } })
    } else {
      // 浮肋没有肋横突关节：取上一根肋骨的肋颈方向
      // floating ribs have no costotransverse joint: take the neck direction of the rib above
      const n = Number(String(def.id).match(/\d+/)![0])
      const above = built.get(`rib${n - 1}_${def.side}`)
      if (!above && n > 1) return null
      // 第一肋也没有找到肋横突关节时：取通用的肋颈方向（向外、向后）
      // no costotransverse joint found even for the first rib: a generic neck direction (lateral and backward)
      axis = above ? mul(above.axes[0], dot(above.axes[0], side) < 0 ? -1 : 1) : norm(add(side, [0, 0, -0.6]))
      fits.push({ what: above ? 'no costotransverse joint (floating rib or no contact): axis direction of the rib above' : 'no costotransverse contact found; generic neck direction used', extra: { closestApproachMm: mm(gap) } })
    }
    if (dot(axis, side) < 0) axis = mul(axis, -1)
    let far = head, fd = 0
    for (const x of s) {
      const d = dist(x.p, head)
      if (d > fd) (fd = d), (far = x.p)
    }
    const toFrontal = deg(Math.asin(Math.min(1, Math.abs(axis[2]))))
    fits[0]!.extra = { ...fits[0]!.extra, axisAngleFromFrontalPlaneDeg: r1(toFrontal) }
    return {
      center: head,
      axis,
      landmarks: { anteriorEnd: far },
      fits,
      basis: {
        en: `One axis along the neck of the rib, from the costovertebral joint (head) to the costotransverse joint (tubercle), ${r1(toFrontal)}° behind the frontal plane here. Rotation about it gives the mixture of pump-handle (upper ribs, axis nearer frontal) and bucket-handle motion (lower ribs, axis nearer sagittal).`,
        zh: `单轴，沿肋颈方向：自肋头关节到肋横突关节，在本模型上偏离冠状面向后 ${r1(toFrontal)}°。绕此轴转动即得到“泵柄”（上位肋，轴近冠状面）与“桶柄”（下位肋，轴近矢状面）运动的混合。`,
      },
    }
  },

  scapula(sk, def): RecipeOut {
    const clav = A(def, 'clavicle'), scap = A(def, 'scapula'), margin = Number(def.args.margin)
    const sa = sk.facing(clav, scap, margin), sb = sk.facing(scap, clav, margin)
    const center = lerp(wmean(sa), wmean(sb), 0.5)
    // 肩胛骨体所在平面：去掉外侧三分之一（肩峰、喙突、关节盂突出于该平面之外）
    // plane of the scapular blade: drop the lateral third (acromion, coracoid, glenoid stand out of it)
    const all = sk.samples(scap)
    const side = sideDir(def.side)
    const xs = all.map((s) => dot(s.p, side)).sort((a, b) => a - b)
    const cut = xs[Math.floor(xs.length * 0.7)]!
    const blade = all.filter((s) => dot(s.p, side) < cut)
    const pc = pca(blade.map((s) => s.p), blade.map((s) => s.w))
    let n = pc.axes[2]
    if (dot(n, FRONT) < 0) n = mul(n, -1)
    const up = reject(UP, n)
    const lat = cross(up, n)
    return {
      center,
      frame: [n, up, dot(lat, side) < 0 ? mul(lat, -1) : lat] as [V3, V3, V3],
      fits: [
        { what: `contact patch between ${clav} and the acromion`, samples: sa.length + sb.length, extra: { closestApproachMm: mm(sk.minDistance(clav, scap)) } },
        { what: 'plane of the scapular blade', rmsMm: mm(pc.sigma[2]), samples: blade.length, extra: { bladeNormalToFrontalPlaneDeg: r1(deg(Math.acos(Math.min(1, n[2])))) } },
      ],
      basis: {
        en: 'Centre at the acromioclavicular joint (facing surfaces of clavicle and acromion). Axes from the plane of the scapular blade: upward rotation about its normal, internal rotation about the vertical line in the plane, tilt about the transverse line in the plane. The scapula is not constrained to glide on the rib cage.',
        zh: '中心取肩锁关节（锁骨与肩峰相对的关节面）。轴取自肩胛骨体所在平面：上回旋绕平面法线，内旋绕平面内的竖直线，前后倾绕平面内的横线。未约束肩胛骨贴着胸廓滑动。',
      },
    }
  },
}

// ── 组装关节 / assembling joints ──────────────────────────────────────────────────────────────

type BuiltWithLm = BuiltJoint

export interface Override {
  center?: Vec3
  axis0?: Vec3
  note: string
}

export function buildJoints(body: Body, defs: JointDef[], overrides: Record<string, Override> = {}): { joints: BuiltJoint[]; skeleton: Skeleton } {
  const sk = new Skeleton(body)
  const built = new Map<string, BuiltWithLm>()
  const raw = new Map<string, RecipeOut>()
  let pending = [...defs]
  for (let pass = 0; pass < 6 && pending.length; pass++) {
    const next: JointDef[] = []
    for (const def of pending) {
      const recipe = recipes[def.recipe]
      if (!recipe) throw new Error(`rig: unknown recipe "${def.recipe}" for joint ${def.id}`)
      const out = recipe(sk, def, built)
      if (!out) {
        next.push(def)
        continue
      }
      const ov = overrides[def.id]
      if (ov?.center) out.center = ov.center
      if (ov?.axis0) out.axis = norm(ov.axis0)
      if (ov) out.fits.push({ what: `hand correction applied: ${ov.note}` })
      raw.set(def.id, out)
      // 临时条目，供依赖它的关节读取中心、主轴和标志点
      // provisional entry so that dependants can read the centre, primary axis and landmarks
      built.set(def.id, {
        def, center: out.center, axes: [out.axis ?? [1, 0, 0], [0, 1, 0], [0, 0, 1]], tail: out.center, boneIds: def.bones.map((b) => sk.id(b)), fits: out.fits, basis: out.basis,
        rest: def.dofs.map(() => 0), restNotes: [], driverRatio: def.dofs.map(() => 0), warnings: [], landmarks: out.landmarks,
      })
    }
    if (next.length === pending.length) throw new Error(`rig: joints with unresolved dependencies: ${next.map((d) => d.id).join(', ')}`)
    pending = next
  }

  // 末端 / tails
  for (const def of defs) {
    const j = built.get(def.id)!
    if (def.tail.joint) {
      const t = built.get(def.tail.joint)
      if (!t) throw new Error(`rig: joint ${def.id}: tail joint ${def.tail.joint} not found`)
      j.tail = t.center
    } else {
      const lm = j.landmarks?.[def.tail.landmark!]
      if (!lm) throw new Error(`rig: joint ${def.id}: landmark ${def.tail.landmark} not produced by recipe ${def.recipe}`)
      j.tail = lm
    }
    if (dist(j.tail, j.center) < 1e-4) j.tail = add(j.center, [0, -0.01, 0])
  }

  // 坐标系与自由度符号 / frames and dof signs
  const world: Record<string, V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
  for (const def of defs) {
    const j = built.get(def.id)!
    const out = raw.get(def.id)!
    const long = norm(sub(j.tail, j.center))
    const pickAxis = (name: string): V3 => {
      if (name === 'fit') {
        if (!out.axis) throw new Error(`rig: joint ${def.id}: recipe ${def.recipe} gives no axis`)
        return out.axis
      }
      return world[name]!
    }
    let a0: V3, a1: V3, a2: V3
    if (def.frame.keep === 'frame') {
      ;[a0, a1, a2] = out.frame!
    } else if (def.frame.keep === 'long') {
      a2 = long
      a0 = reject(pickAxis(def.frame.axis0), a2)
      a1 = cross(a2, a0)
    } else if (def.frame.keep === 'axis') {
      a0 = norm(pickAxis(def.frame.axis0))
      a2 = reject(long, a0)
      a1 = cross(a2, a0)
    } else {
      a2 = norm(pickAxis(def.frame.axis2!))
      if (dot(a2, long) < 0) a2 = mul(a2, -1)
      a0 = reject(pickAxis(def.frame.axis0), a2)
      a1 = cross(a2, a0)
    }
    const axes: [V3, V3, V3] = [a0, a1, a2]
    const refs: Record<string, V3> = { tail: sub(j.tail, j.center), front: [0, 0, 0.1], up: [0, 0.1, 0], down: [0, -0.1, 0], lateral: mul(sideDir(def.side), 0.1) }
    for (const d of def.dofs) {
      const ref = refs[d.sign[0]]
      if (!ref) throw new Error(`rig: joint ${def.id}: unknown sign reference ${d.sign[0]}`)
      const v = cross(axes[d.axis], ref)
      const s = dot(v, direction(d.sign[1], def.side))
      if (Math.abs(s) < 0.2 * len(v) || len(v) < 0.1 * len(ref)) j.warnings.push(`dof "${d.name.en}": sign rule ${d.sign.join('→')} is weakly determined (cos ${r1(s / (len(v) || 1))})`)
      if (s < 0) axes[d.axis] = mul(axes[d.axis], -1)
    }
    j.axes = axes
  }

  // 解剖学约定下的静止姿态角度 / rest-pose angles in the anatomical convention
  for (const def of defs) {
    const j = built.get(def.id)!
    const long = norm(sub(j.tail, j.center))
    const parent = def.parent ? built.get(def.parent)! : null
    def.dofs.forEach((d, k) => {
      if (!d.rest) return
      const a = j.axes[d.axis]
      const angleAbout = (P: V3, D: V3): number => {
        const p = reject(P, a), q = reject(D, a)
        return Math.atan2(dot(a, cross(p, q)), dot(p, q))
      }
      if (d.rest === 'bend') {
        let P: V3
        if (def.restProx === 'down') P = [0, -1, 0]
        else if (def.recipe === 'digit') P = sk.longAxis(A(def, 'proximal'), long)
        else P = norm(sub(parent!.tail, parent!.center))
        j.rest[k] = angleAbout(P, long)
        j.restNotes.push(`${d.name.en}: ${r1(deg(j.rest[k]!))}° at rest (bend of the segment against ${def.restProx === 'down' ? 'the vertical' : 'the proximal segment'})`)
      } else if (d.rest === 'foot') {
        // 足底方向：从跟骨最低点指向各跖骨头最低点
        // sole direction: from the lowest point of the heel to the lowest points of the metatarsal heads
        const P = norm(sub(parent!.tail, parent!.center))
        const s = def.side === 'L' ? 'Left' : 'Right'
        const heel = sk.extreme(`${s} calcaneus`, [0, -1, -0.6])
        const heads = ['first', 'fifth'].map((o) => sk.extreme(`${s} ${o} metatarsal bone`, [0, -1, 0.6]))
        const sole = norm(sub(mean(heads), heel))
        j.rest[k] = angleAbout(P, sole) - rad(def.restNeutral ?? 90)
        j.restNotes.push(`${d.name.en}: ${r1(deg(j.rest[k]!))}° at rest (sole line against the leg; 0 = sole perpendicular to the tibia)`)
      } else if (d.rest === 'forearm') {
        // 腕部横向线相对于肘关节轴的夹角，绕前臂轴度量。
        // 解剖学姿势（完全旋后）下两者平行；临床中立位与之相差 90°。
        // angle of the wrist's transverse line against the elbow axis, about the forearm axis.
        // Anatomical position (full supination) has them parallel; the clinical neutral is 90° from that.
        const e = parent!.axes[0]
        const lm = j.landmarks!
        const w = norm(sub(lm.radiusDistal!, lm.ulnarHead!))
        const lat = sideDir(def.side)
        const eo = dot(e, lat) < 0 ? mul(e, -1) : e
        const phi = angleAbout(eo, w)
        j.rest[k] = phi - Math.PI / 2
        j.restNotes.push(`${d.name.en}: ${r1(deg(j.rest[k]!))}° at rest in the clinical convention (0 = thumb-up neutral, −90 = full supination): the wrist's transverse line is ${r1(deg(phi))}° from the elbow axis`)
      }
    })
    raw.get(def.id)!.driverRatio !== undefined && def.dofs.forEach((d, k) => d.driver && (j.driverRatio[k] = raw.get(def.id)!.driverRatio!))
  }

  // 每块骨必须恰好被归属一次 / every bone must be accounted for exactly once
  const seen = new Map<string, string>()
  for (const j of built.values()) {
    for (const b of j.boneIds) {
      if (seen.has(b)) throw new Error(`rig: bone ${b} is bound to both ${seen.get(b)} and ${j.def.id}`)
      seen.set(b, j.def.id)
    }
  }
  return { joints: defs.map((d) => built.get(d.id)!), skeleton: sk }
}

/** 由已构建的关节和活动范围表生成契约关节（带有提议的 `tail` 和 `driver` 扩展）。 Contract joints (with the proposed `tail` and `driver` extensions) from the built joints and the ROM table. */
export interface RomEntry {
  /** 正向运动和负向运动的正常范围，单位为度，自解剖学零位起算。 Normal range of the positive and of the negative movement, degrees, from the anatomical zero position. */
  positive: number
  negative: number
  status: 'sourced' | 'estimate'
  source: { name: string; url: string; license: string }
  note?: string
}

export interface JointExt extends Joint {
  /** 提议的契约扩展：该关节所带动节段的远端（静止姿态，单位为米）。 Proposed contract extension: distal end of the segment this joint moves (rest pose, metres). */
  tail: Vec3
  dofs: JointDofExt[]
}
export interface JointDofExt extends JointDof {
  /** 提议的契约扩展：该自由度的角度 = ratio × 驱动自由度的角度（+ 其自身的值）。 Proposed contract extension: this dof's angle = ratio × the driver dof's angle (+ its own value). */
  driver?: { joint: string; dof: number; ratio: number }
  /** 提议的契约扩展：关节处于解剖学零位时该自由度的角度（相对于静止姿态）。 Proposed contract extension: the dof angle (relative to rest) at which the joint is in the anatomical zero position. */
  neutral?: number
  /** 提议的契约扩展：当范围为估计值而非已发表的正常值时为 false。 Proposed contract extension: false when the range is an estimate rather than a published normal value. */
  sourced?: boolean
}

const round = (x: number, d = 6): number => Math.round(x * 10 ** d) / 10 ** d
const rv = (v: V3, d = 6): Vec3 => [round(v[0], d), round(v[1], d), round(v[2], d)]

export function toContract(joints: BuiltJoint[], rom: Record<string, RomEntry>): { joints: JointExt[]; notes: string[] } {
  const notes: string[] = []
  const out = joints.map((j): JointExt => {
    const dofs = j.def.dofs.map((d, k): JointDofExt => {
      const r = rom[d.rom]
      if (!r) throw new Error(`rig: joint ${j.def.id}: no ROM entry "${d.rom}" in rom.json`)
      const rest = j.rest[k]!
      let min = rad(-r.negative) - rest, max = rad(r.positive) - rest
      if (min > 0 || max < 0) {
        notes.push(`${j.def.id} "${d.name.en}": the rest pose (${r1(deg(rest))}° in the anatomical convention) lies outside the normal range −${r.negative}…${r.positive}°; range widened to include the rest pose`)
        min = Math.min(min, 0)
        max = Math.max(max, 0)
      }
      const dof: JointDofExt = { axis: d.axis, name: d.name, min: round(min, 5), max: round(max, 5), source: r.source }
      if (rest !== 0) dof.neutral = round(-rest, 5)
      if (r.status !== 'sourced') dof.sourced = false
      if (d.driver) dof.driver = { joint: d.driver.joint, dof: d.driver.dof, ratio: round(j.driverRatio[k]!, 4) }
      return dof
    })
    return { id: j.def.id, name: j.def.name, parent: j.def.parent, center: rv(j.center), axes: [rv(j.axes[0]), rv(j.axes[1]), rv(j.axes[2])], dofs, basis: j.basis, tail: rv(j.tail) }
  })
  return { joints: out, notes }
}

/** 骨的混合半径：相邻骨的影响在距其表面多远之内仍会混入。 Blend radius of a bone: how far from its surface a neighbouring bone's influence still mixes in. */
export function blendRadius(sk: Skeleton, boneName: string): number {
  return Math.min(0.02, Math.max(0.003, 0.25 * Math.cbrt(sk.volume(boneName))))
}
