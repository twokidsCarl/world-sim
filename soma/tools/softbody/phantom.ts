// 乳房的体模：半球形的乳房组织贴在刚性胸壁上，换体位（重力是身体坐标系里的三维向量），量乳头和组织的位移。
// 不读任何人体数据（女性身体正在重建，这里只用几何体），用来把"网格、底面边界条件、乳房大小、材料、体位方向"几个因素分开。
// A breast phantom: a hemisphere of breast tissue on a rigid chest wall; the posture changes (gravity is a 3D vector in
// the body frame) and the displacement of the nipple and of the tissue is measured. No body data is read (the female
// body is being rebuilt; this is geometry only); it separates mesh, base boundary condition, breast size, material and
// the direction of posture.
//
//   bun tools/softbody/phantom.ts
//
// 坐标 / Frames
//   身体坐标系：x = 向外侧（这只乳房的外侧），y = 向头，z = 向前。体位的重力在这个坐标系里给出（POSTURE_GRAVITY）。
//   体模网格：胸壁是 y = 0 平面，y 是胸壁法线；胸壁法线 = 向前绕头脚轴向外侧转 wallTiltDeg（乳房坐在弯曲的胸廓上，
//   法线朝前外方；这个角度没有出处，是参数）。网格 x = 胸壁平面内向外侧，网格 z = 向头。
//   Body frame: x = lateral (to this breast's outer side), y = cranial, z = anterior. Posture gravity is given in this
//   frame (POSTURE_GRAVITY). Phantom mesh: the chest wall is the plane y = 0 and y its normal; the wall normal is
//   anterior turned laterally about the cranio-caudal axis by wallTiltDeg (the breast sits on a curved rib cage, its
//   wall faces forward and outward; the angle has no source and is a parameter). Mesh x = lateral within the wall plane,
//   mesh z = cranial.
//
// 底面 / The base
//   'bonded'        底面结点全部钉住（第二、三阶段的做法）/ every base node pinned (as in phases 2 and 3)
//   'slidingCentre' 底面在胸壁上无摩擦滑动，中心一小片钉住（第三阶段的上限算例）/ frictionless sliding with a small central patch pinned (the phase-3 upper bound)
//   'sliding'       底面在胸壁上无摩擦滑动，底面的周边钉住：乳房在胸大肌上自由滑动，边缘由悬韧带系在深筋膜上（mira2018）
//                   frictionless sliding with the rim of the base pinned: the breast moves freely over pectoralis and its
//                   border is tied to the deep fascia by the suspensory ligaments (mira2018)
//   'fascia'        同 'sliding'，另在底面加一层浅筋膜深层（mira2018：0.1 mm 厚的壳；该文按它的模量控制滑动量），按体积比例混入
//                   底层四面体（与皮肤混入笼子同一种做法）
//                   as 'sliding', plus the deep layer of the superficial fascia on the base (mira2018: a 0.1 mm shell whose
//                   modulus controls the amount of sliding there), blended by volume share into the bottom tetrahedra (as
//                   the skin is blended into the cage)
//   mira2018 的摩擦系数 k = 0.1 没有实现：该文说改变 k 几乎不影响结果；俯卧时底面受拉，库仑摩擦也没有意义。
//   The friction coefficient k = 0.1 of mira2018 is not implemented: that paper reports k hardly matters, and in the
//   prone position the base is in tension, where Coulomb friction means nothing.

import { boxKuhn } from '../../src/softbody/lattice.ts'
import { type PointSet, SoftSolver, type Vec3, lame } from '../../src/softbody/solver.ts'

export type Posture = 'standing' | 'supine' | 'prone' | 'lateral' | 'medial'

/** 身体坐标系里的重力（x 外侧、y 头、z 前），m/s² / gravity in the body frame (x lateral, y cranial, z anterior), m/s² */
export const POSTURE_GRAVITY: Record<Posture, Vec3> = {
  standing: [0, -9.81, 0],
  // 仰卧：背朝下，重力指向背侧 / supine: lying on the back, gravity points posterior
  supine: [0, 0, -9.81],
  // 俯卧：重力指向前方（离开胸壁）/ prone: gravity points anterior (away from the wall)
  prone: [0, 0, 9.81],
  // 向这只乳房的一侧侧卧：重力指向外侧 / lying on this breast's side: gravity points lateral
  lateral: [9.81, 0, 0],
  // 向对侧侧卧：重力指向中线 / lying on the other side: gravity points medial
  medial: [-9.81, 0, 0],
}

export interface PhantomCase {
  /** 乳房体积，毫升 / breast volume, mL */
  volumeMl: number
  cell: number
  base: 'bonded' | 'sliding' | 'slidingCentre' | 'fascia'
  /** 剪切模量，帕 / shear modulus, Pa */
  shear: number
  /** 胸壁法线相对正前方向外侧的转角，度（缺省 0）/ lateral turn of the wall normal from straight anterior, degrees (default 0) */
  wallTiltDeg?: number
  /** base = 'fascia' 时的筋膜层：杨氏模量（帕）和厚度（米）/ the fascia layer for base = 'fascia': Young's modulus (Pa) and thickness (m) */
  fascia?: { young: number; thickness: number }
  /** 穹顶表面的皮肤层（可选）：杨氏模量（帕）、厚度（米）、硬化系数 κ / an optional skin layer on the dome: Young's modulus (Pa), thickness (m), stiffening κ */
  skin?: { young: number; thickness: number; stiffening?: number }
  substeps?: number
}

export interface PhantomPair {
  from: Posture
  to: Posture
  nippleMm: number
  meanTissueMm: number
  /** 乳头位移，身体坐标系（外侧、头、前），毫米 / nipple displacement in the body frame (lateral, cranial, anterior), mm */
  nippleVectorMm: Vec3
}

export interface PhantomResult {
  /** 俯卧 → 仰卧（与 proneSupine2016 对照的那一对）/ prone → supine (the pair compared with proneSupine2016) */
  nippleMm: number
  meanTissueMm: number
  volumeRatio: number
  tets: number
  frames: number
  /** false = 至少一个体位在帧数上限内没有停下来（位移还在长，数值是下限）/ false = at least one posture did not come to rest within the frame cap (still moving; the numbers are lower bounds) */
  converged: boolean
  /** 所有体位里四面体体积比 J 的最小值，和 J < 0.3 的四面体个数（压扁或翻转的单元：这一行的位移不可信）/ the smallest tetrahedron volume ratio J over all postures, and the count of tetrahedra with J < 0.3 (crushed or inverted elements: the row's displacements are not to be trusted) */
  minJ: number
  crushedTets: number
  pairs: PhantomPair[]
}

export interface PhantomModel {
  solver: SoftSolver
  nodes: Float32Array
  tets: Uint32Array
  used: Uint8Array
  pinned: Uint8Array
  nipple: number
  /** 身体坐标系 → 网格坐标系 / body frame → mesh frame */
  toMesh(v: Vec3): Vec3
  /** 网格坐标系 → 身体坐标系 / mesh frame → body frame */
  toBody(v: Vec3): Vec3
}

/** 四面体一个面上的三个结点（对着第 k 个角）/ the three nodes of the face opposite corner k */
const faceOf = (tets: Uint32Array, e: number, k: number): [number, number, number] => [0, 1, 2, 3].filter((c) => c !== k).map((c) => tets[e * 4 + c]!) as [number, number, number]

function triArea(p: Float32Array, f: [number, number, number]): number {
  const [a, b, c] = f.map((i) => i * 3) as [number, number, number]
  const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!, vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
}

export function buildPhantom(c: PhantomCase): PhantomModel {
  const r = Math.cbrt((3 * c.volumeMl * 1e-6) / (2 * Math.PI))
  const n = Math.ceil((2 * r) / c.cell) + 1, nz = Math.ceil(r / c.cell) + 1
  const m = boxKuhn([n, nz, n], c.cell)
  const half = (n * c.cell) / 2
  const keep: number[] = []
  for (let e = 0; e < m.tets.length / 4; e++) {
    let cx = 0, cy = 0, cz = 0
    for (let k = 0; k < 4; k++) {
      const i = m.tets[e * 4 + k]! * 3
      cx += m.nodes[i]! / 4
      cy += m.nodes[i + 1]! / 4
      cz += m.nodes[i + 2]! / 4
    }
    if (Math.hypot(cx - half, cy, cz - half) < r) keep.push(e)
  }
  const tets = new Uint32Array(keep.length * 4)
  keep.forEach((e, k) => tets.set(m.tets.subarray(e * 4, e * 4 + 4), k * 4))
  const used = new Uint8Array(m.nodes.length / 3)
  for (const i of tets) used[i] = 1
  const T = keep.length, N = m.nodes.length / 3
  const nodes = m.nodes
  const onBase = (i: number): boolean => nodes[i * 3 + 1]! < 1e-9
  const radial = (i: number): number => Math.hypot(nodes[i * 3]! - half, nodes[i * 3 + 2]! - half)
  let rim = 0
  for (let i = 0; i < N; i++) if (used[i] && onBase(i)) rim = Math.max(rim, radial(i))
  const pinned = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if (!used[i]) pinned[i] = 1
    else if (onBase(i)) {
      if (c.base === 'bonded') pinned[i] = 1
      else if (c.base === 'slidingCentre' && radial(i) < 0.25 * r) pinned[i] = 1
      else if ((c.base === 'sliding' || c.base === 'fascia') && radial(i) > rim - 0.5 * c.cell) pinned[i] = 1
    }
  }
  // 材料：均质乳房 + 混入的筋膜、皮肤（Voigt，按层的体积占四面体的比例）/ material: homogeneous breast plus the blended fascia and skin (Voigt, by the layer's share of the tetrahedron)
  const E0 = 2 * c.shear * 1.49
  const young = new Float64Array(T).fill(E0), kappa = new Float32Array(T)
  const vol = (e: number): number => {
    const q = [0, 1, 2, 3].map((k) => tets[e * 4 + k]! * 3)
    const d = (k: number, a: number): number => nodes[q[k]! + a]! - nodes[q[0]! + a]!
    return Math.abs(d(1, 0) * (d(2, 1) * d(3, 2) - d(2, 2) * d(3, 1)) - d(1, 1) * (d(2, 0) * d(3, 2) - d(2, 2) * d(3, 0)) + d(1, 2) * (d(2, 0) * d(3, 1) - d(2, 1) * d(3, 0))) / 6
  }
  if ((c.base === 'fascia' && c.fascia) || c.skin) {
    const faces = new Map<string, number>()
    for (let e = 0; e < T; e++) for (let k = 0; k < 4; k++) {
      const key = faceOf(tets, e, k).sort((a, b) => a - b).join(',')
      faces.set(key, (faces.get(key) ?? 0) + 1)
    }
    for (let e = 0; e < T; e++) for (let k = 0; k < 4; k++) {
      const f = faceOf(tets, e, k)
      if (faces.get([...f].sort((a, b) => a - b).join(',')) !== 1) continue
      const base = f.every(onBase)
      const layer = base ? (c.base === 'fascia' ? c.fascia : undefined) : c.skin
      if (!layer) continue
      const share = Math.min(1, (triArea(nodes, f) * layer.thickness) / vol(e))
      const add = share * layer.young
      const ks = !base && c.skin?.stiffening ? c.skin.stiffening : 0
      kappa[e] = (kappa[e]! * young[e]! + ks * add) / (young[e]! + add)
      young[e] = young[e]! + add
    }
  }
  const mu = new Float32Array(T), lambda = new Float32Array(T)
  for (let e = 0; e < T; e++) {
    const l = lame(young[e]!, 0.49)
    mu[e] = l.mu
    lambda[e] = l.lambda
  }
  const s = new SoftSolver({ nodes, tets, mu, lambda, density: new Float32Array(T).fill(1000), pinned, stiffening: kappa }, { gravity: [0, 0, 0], substeps: c.substeps ?? 16, damping: 6 })
  // 子步数不少于刚度比要求的（取最大值：体模小，每个四面体都在传力路径上）；混入皮肤后 16 个子步时体模停不下来
  // no fewer substeps than the stiffness ratio asks for (its maximum: the phantom is small and every tetrahedron carries load); with skin blended in, the phantom never comes to rest at 16 substeps
  if (c.substeps === undefined) s.substeps = Math.max(16, s.substepsFor(1 / 60, 0.5, 0, 1))
  if (c.base !== 'bonded') {
    const tet: number[] = [], bary: number[] = []
    const seen = new Set<number>()
    for (let e = 0; e < T; e++) for (let k = 0; k < 4; k++) {
      const i = tets[e * 4 + k]!
      if (seen.has(i) || pinned[i] || !onBase(i)) continue
      seen.add(i)
      tet.push(e)
      bary.push(...[0, 1, 2, 3].map((q) => (q === k ? 1 : 0)))
    }
    const points: PointSet = { tet: Uint32Array.from(tet), bary: Float32Array.from(bary) }
    // 两张方向相反的平面 = 双侧约束：底面留在胸壁上，只能在面内无摩擦地滑动 / two opposite planes = a bilateral constraint: the base stays on the wall and slides in its plane without friction
    s.planes = [{ n: [0, 1, 0], d: 0, points }, { n: [0, -1, 0], d: 0, points }]
  }
  // 乳头：穹顶最高处的结点 / the nipple: the node at the top of the dome
  let nip = -1, top = -1
  for (let i = 0; i < N; i++) if (used[i] && radial(i) < c.cell && nodes[i * 3 + 1]! > top) (top = nodes[i * 3 + 1]!), (nip = i)
  const a = ((c.wallTiltDeg ?? 0) * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a)
  // 网格轴在身体坐标系里：x̂_m = (cos a, 0, −sin a)，ŷ_m = 胸壁法线 (sin a, 0, cos a)，ẑ_m = 向头 / mesh axes in the body frame: x̂_m = (cos a, 0, −sin a), ŷ_m = wall normal (sin a, 0, cos a), ẑ_m = cranial
  const toMesh = (v: Vec3): Vec3 => [ca * v[0] - sa * v[2], sa * v[0] + ca * v[2], v[1]]
  const toBody = (v: Vec3): Vec3 => [ca * v[0] + sa * v[1], v[2], -sa * v[0] + ca * v[1]]
  return { solver: s, nodes, tets, used, pinned, nipple: nip, toMesh, toBody }
}

/** 从无载形状出发，在一个体位下走到平衡；返回结点位置和帧数 / from the unloaded shape, run to equilibrium in one posture; returns node positions and frames */
export function settlePosture(m: PhantomModel, p: Posture, maxFrames = 4000): { x: Float64Array; frames: number; converged: boolean } {
  const s = m.solver
  s.reset()
  s.gravity = m.toMesh(POSTURE_GRAVITY[p])
  const frames = s.settle(1 / 60, 2e-5, maxFrames)
  return { x: Float64Array.from(s.x), frames, converged: frames < maxFrames }
}

/** 各四面体的体积比 J（相对无载形状）的最小值和 J < 0.3 的个数 / the smallest volume ratio J of the tetrahedra (against the unloaded shape) and the count below 0.3 */
function elementJ(m: PhantomModel, x: Float64Array): { min: number; below: number } {
  let min = Infinity, below = 0
  const X = m.nodes
  for (let e = 0; e < m.tets.length / 4; e++) {
    const q = [0, 1, 2, 3].map((k) => m.tets[e * 4 + k]! * 3)
    const v = (P: ArrayLike<number>): number => {
      const d = (k: number, a: number): number => P[q[k]! + a]! - P[q[0]! + a]!
      return d(1, 0) * (d(2, 1) * d(3, 2) - d(2, 2) * d(3, 1)) - d(1, 1) * (d(2, 0) * d(3, 2) - d(2, 2) * d(3, 0)) + d(1, 2) * (d(2, 0) * d(3, 1) - d(2, 1) * d(3, 0))
    }
    const J = v(x) / v(X)
    min = Math.min(min, J)
    if (J < 0.3) below++
  }
  return { min, below }
}

const PAIRS: [Posture, Posture][] = [['prone', 'supine'], ['standing', 'supine'], ['standing', 'prone'], ['supine', 'lateral'], ['supine', 'medial']]

export function phantom(c: PhantomCase, pairs: [Posture, Posture][] = PAIRS): PhantomResult {
  const m = buildPhantom(c)
  const need = new Set(pairs.flat())
  const at = new Map<Posture, Float64Array>()
  let frames = 0, converged = true, minJ = Infinity, crushed = 0
  let volumeRatio = 1
  for (const p of need) {
    const r = settlePosture(m, p)
    at.set(p, r.x)
    frames += r.frames
    converged &&= r.converged
    const q = elementJ(m, r.x)
    minJ = Math.min(minJ, q.min)
    crushed = Math.max(crushed, q.below)
    if (p === 'supine') volumeRatio = m.solver.volume() / m.solver.referenceVolume()
  }
  const N = m.nodes.length / 3
  const out: PhantomPair[] = pairs.map(([from, to]) => {
    const a = at.get(from)!, b = at.get(to)!
    let sum = 0, cnt = 0
    for (let i = 0; i < N; i++) if (m.used[i] && !m.pinned[i]) (sum += Math.hypot(b[i * 3]! - a[i * 3]!, b[i * 3 + 1]! - a[i * 3 + 1]!, b[i * 3 + 2]! - a[i * 3 + 2]!)), cnt++
    const q = m.nipple * 3
    const d = m.toBody([b[q]! - a[q]!, b[q + 1]! - a[q + 1]!, b[q + 2]! - a[q + 2]!])
    const r1 = (x: number): number => Math.round(x * 1e4) / 10
    return { from, to, nippleMm: r1(Math.hypot(...d)), meanTissueMm: r1(sum / cnt), nippleVectorMm: d.map(r1) as Vec3 }
  })
  const ps = out.find((q) => q.from === 'prone' && q.to === 'supine') ?? out[0]!
  return { nippleMm: ps.nippleMm, meanTissueMm: ps.meanTissueMm, volumeRatio: Math.round(volumeRatio * 1e4) / 1e4, tets: m.tets.length / 4, frames, converged, minJ: Math.round(minJ * 100) / 100, crushedTets: crushed, pairs: out }
}

if (import.meta.main) {
  const base: PhantomCase = { volumeMl: 262, cell: 0.01, base: 'bonded', shear: 357.1 }
  // 皮肤取 materials.json 的值（forearm2026：E = 56.4 kPa，1.13 mm，κ = 17.4）/ skin as in materials.json (forearm2026: E = 56.4 kPa, 1.13 mm, κ = 17.4)
  const skin = { young: 56400, thickness: 0.00113, stiffening: 17.4 }
  // mira2018 拟合到的乳房皮肤（连同浅筋膜浅层）：2 mm 厚的壳，E = 4 kPa / the breast skin fitted by mira2018 (with the superficial layer of the superficial fascia): a 2 mm shell, E = 4 kPa
  const breastSkin = { young: 4000, thickness: 0.002 }
  const cases: [string, Partial<PhantomCase>][] = [
    ['sliding + mira2018 breast skin', { base: 'sliding', skin: breastSkin }],
    ['bonded', {}],
    ['bonded + skin', { skin }],
    ['sliding + skin', { base: 'sliding', skin }],
    ['fascia 80 kPa + skin', { base: 'fascia', fascia: { young: 80e3, thickness: 1e-4 }, skin }],
    ['sliding + skin, wall turned 30°', { base: 'sliding', skin, wallTiltDeg: 30 }],
  ]
  for (const [label, c] of cases) {
    const t0 = performance.now()
    const res = phantom({ ...base, ...c })
    console.log(label.padEnd(36), JSON.stringify({ ...res, pairs: res.pairs.map((p) => `${p.from}→${p.to} ${p.nippleMm}/${p.meanTissueMm}`) }), `${((performance.now() - t0) / 1000).toFixed(1)} s`)
  }
}
