// 肩外展时腋窝的量化检查：bun tools/rig/axilla-check.ts [male|female ...] [--rig <目录>] [--json <文件>]
// A quantitative check of the axilla in shoulder abduction: bun tools/rig/axilla-check.ts [male|female ...] [--rig <dir>] [--json <file>]
//
// 两副身体、两侧，静止、外展 90° 和 160°（tools/rig/postures.ts 的 raiseArm：闭环解出盂肱关节角，肩带按肩肱节律），
// 用 CPU 参考的摆姿势（tools/rig/pose.ts 的 Poser，对偶四元数，肌肉按 tapered 体积修正，与着色器同一公式）。
// Both bodies, both sides, at rest and at 90° and 160° of abduction (raiseArm in tools/rig/postures.ts: the glenohumeral
// angles solved in closed loop, the girdle by the scapulohumeral rhythm), posed by the CPU reference (Poser in
// tools/rig/pose.ts, dual quaternions, muscles volume-corrected in the tapered mode, the same formulas as the shader).
//
// 各量 / the quantities
//   · 腋后襞、腋前襞的皮肤（区域见 foldRegion）：边的拉伸比（当前长度 / 静止长度）的 p95、最大值、超过 1.5 倍的边所占比例；
//     折起的面积：摆好姿势后法线与三个顶点的（面积加权）顶点法线之和相反的三角形的面积（cm²，当前面积）。
//     与皮肤包那边量腋窝时的定义相同（只是区域按几何定，不靠皮肤包里的顶点表）。另量“浮起”：每个皱襞顶点到深层（腋窝周围的肌、骨、
//     腱、软骨）的距离比静止时多出多少（p95、最大值，mm），免得把皮肤拉离身体也算成拉伸减小。
//     the skin of the posterior and the anterior axillary fold (region: see foldRegion): edge stretch ratio (current / rest
//     length), its p95, maximum and the share of edges stretched by more than 1.5×; folded area: the area (cm², as posed) of
//     the triangles whose posed normal points against the sum of the (area-weighted) vertex normals of their three
//     vertices. The same definitions the skin package side used for the axilla (only the region is defined by geometry
//     here, not by a vertex list from the skin package). Also the lift: how much farther from the deep layer (muscle, bone,
//     tendon, cartilage near the axilla) each fold vertex is than at rest (p95, max, mm), so that pulling the skin off the
//     body cannot pass for less stretch.
//   · 腋窝周围穿出皮肤的深部结构：静止时离盂肱关节中心 AROUND 以内、不高于它 ABOVE 的深部部件（肌、腱、韧带、筋膜、脂肪、血管、神经、骨、腺）
//     的顶点，在摆好姿势的皮肤外面多于 OUTSIDE 的个数、按顶点分摊的静止面积（cm²）和最远距离（mm），分到背阔肌、大圆肌、
//     胸肌（胸大肌各部和胸小肌）、三角肌、脂肪、其他肌肉、其他。皮肤有开口（口裂、睑裂），摆姿势后在腋窝还会自身相交，
//     所以内外不按射线奇偶，也不按最近点处的法线（腋窝的凹处离得远的点会判错），而按广义环绕数（tools/rig/solid.ts 的
//     Winding，小于 ½ 为外面）；穿出的距离是到皮肤的最近距离。
//     deep parts through the skin round the axilla: the vertices of the deep parts (muscle, tendon, ligament, fascia, fat,
//     vessels, nerves, bone, gland) lying within AROUND of the glenohumeral centre at rest, and no more than ABOVE above it,
//     that end up more than OUTSIDE
//     outside the posed skin — their number, the rest area shared out to them (cm²) and the farthest (mm), split into
//     latissimus dorsi, teres major, pectoral (the parts of pectoralis major and pectoralis minor), deltoid, fat, other
//     muscle and other. The skin has openings (mouth, eyelids) and, posed, intersects itself in the axilla, so inside and
//     outside are decided neither by ray parity nor by the normal at the nearest point (distant points facing the hollow
//     of the axilla get that wrong) but by the generalised winding number (Winding in tools/rig/solid.ts, below ½ is
//     outside); how far out is the distance to the nearest point of the skin.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Part, Rig } from '../../src/anatomy/types.ts'
import { type Body, readBody } from './io.ts'
import type { V3 } from './math.ts'
import { type Pose, Poser } from './pose.ts'
import { PoseBuilder, raiseArm } from './postures.ts'
import { Surface, Winding } from './solid.ts'

const ROOT = join(import.meta.dirname, '..', '..')

/** 深部部件离盂肱关节中心多远以内算“腋窝周围”（米，静止）/ How near the glenohumeral centre (m, at rest) a deep part's vertex counts as "round the axilla". */
export const AROUND = 0.22
/** 并且不高于盂肱关节中心这么多（米）：颈和下颌不算，口裂开口附近的环绕数也不可靠 / and no higher than this above the glenohumeral centre (m): neck and jaw do not count, and the winding number is unreliable by the open mouth. */
export const ABOVE = 0.05
/** 在皮肤外多于这么多才算穿出（米）：滤掉贴着皮肤的皮下层的数值噪声 / Outside the skin by more than this (m) to count: filters numerical noise of the layer lying against the skin. */
export const OUTSIDE = 0.0005
/** 皱襞区域：离背阔肌和大圆肌（腋后）或胸大肌（腋前）表面这么近（米）/ Fold region: this close (m) to the surface of latissimus dorsi and teres major (posterior) or pectoralis major (anterior). */
export const FOLD_NEAR = 0.04
/** 皱襞区域沿肱骨（盂肱关节中心 0，肘 1）的范围 / The fold region's range along the humerus (glenohumeral centre 0, elbow 1). */
export const FOLD_T: [number, number] = [-0.2, 0.9]
/** 皱襞区域：从盂肱关节中心向内侧不超过这么远（米），把背中部排除在外 / Fold region: no further medial than this (m) from the glenohumeral centre, which keeps the middle of the back out. */
export const FOLD_MEDIAL = 0.12
/** 腋窝顶区域的半径（米）/ Radius of the axilla-dome region (m). */
export const DOME = 0.07

export type DeepGroup = 'latissimus' | 'teresMajor' | 'pectoral' | 'deltoid' | 'fat' | 'otherMuscle' | 'other'
export const DEEP_GROUPS: DeepGroup[] = ['latissimus', 'teresMajor', 'pectoral', 'deltoid', 'fat', 'otherMuscle', 'other']

export function deepGroup(p: Pick<Part, 'name' | 'tissue'>): DeepGroup {
  const n = p.name.toLowerCase()
  if (n.includes('latissimus dorsi')) return 'latissimus'
  if (n.includes('teres major')) return 'teresMajor'
  if (n.includes('pectoralis')) return 'pectoral'
  if (/deltoid muscle/.test(n)) return 'deltoid'
  if (p.tissue === 'fat') return 'fat'
  if (p.tissue === 'muscle') return 'otherMuscle'
  return 'other'
}

const DEEP_TISSUES = new Set(['muscle', 'tendon', 'ligament', 'fascia', 'fat', 'artery', 'vein', 'nerve', 'bone', 'cartilage', 'gland'])
/** 浮起的参照层 / The layer the lift is measured from. */
const LAYER_TISSUES = new Set(['muscle', 'tendon', 'bone', 'cartilage'])

export interface FoldStats {
  triangles: number
  edges: number
  p95: number
  max: number
  /** 超过 1.5 倍的边（%）/ Edges stretched by more than 1.5× (%). */
  over15Pct: number
  /** 折起的面积（cm²）/ Folded area (cm²). */
  foldedCm2: number
  /** 离开深层（肌、骨、腱、软骨）的距离比静止时多出多少（mm）：p95 和最大值。皮肤浮离身体时它变大。 How much farther from the deep layer (muscle, bone, tendon, cartilage) than at rest (mm): p95 and maximum. It grows when the skin lifts off the body. */
  liftP95Mm: number
  liftMaxMm: number
}

export interface DeepStats {
  count: number
  areaCm2: number
  maxMm: number
}

export interface AxillaRow {
  body: string
  side: 'L' | 'R'
  pose: string
  posterior: FoldStats
  anterior: FoldStats
  /** 腋窝顶：离腋窝中心（盂肱关节中心下 9 cm、后 1 cm）DOME 以内的皮肤 / the dome of the axilla: skin within DOME of the axilla centre (9 cm below and 1 cm behind the glenohumeral centre) */
  dome: FoldStats
  deep: Record<DeepGroup, DeepStats>
  deepTotal: DeepStats
}

/** 检查用的姿势：静止、外展 90°、160°（两侧同时）/ The poses checked: rest, abduction 90° and 160° (both sides at once). */
export function axillaPoses(rig: Rig): { id: string; pose: Pose }[] {
  const at = (deg: number): Pose => {
    const b = new PoseBuilder(rig.joints)
    raiseArm(b, 'L', deg, 0)
    raiseArm(b, 'R', deg, 0)
    return b.pose
  }
  return [{ id: 'rest', pose: {} }, { id: 'abd90', pose: at(90) }, { id: 'abd160', pose: at(160) }]
}

const r2 = (x: number): number => Math.round(x * 100) / 100
const r1 = (x: number): number => Math.round(x * 10) / 10

/** 皮肤部件：三角形最多的皮肤 / The skin part: the skin with most triangles. */
export function skinPartOf(body: Body): Part {
  const s = body.data.parts.filter((p) => p.tissue === 'skin' && body.meshes.has(p.id)).sort((a, b) => b.triangles - a.triangles)[0]
  if (!s) throw new Error('axilla-check: the body has no skin mesh')
  return s
}

function jointCentre(rig: Rig, id: string): V3 {
  const j = rig.joints.find((x) => x.id === id)
  if (!j) throw new Error(`axilla-check: the rig has no joint ${id}`)
  return j.center as V3
}

/**
 * 腋后襞（posterior）或腋前襞（anterior）的皮肤顶点（发布的皮肤网格的下标）：静止时离背阔肌和大圆肌（或胸大肌）的表面
 * FOLD_NEAR 以内，沿肱骨的位置在 FOLD_T 之内，在盂肱关节中心之后（或之前），离它向内侧不超过 FOLD_MEDIAL。
 * The skin vertices (indices of the shipped skin mesh) of the posterior or the anterior axillary fold: within FOLD_NEAR of
 * the surface of latissimus dorsi and teres major (or pectoralis major) at rest, within FOLD_T along the humerus, behind
 * (or in front of) the glenohumeral centre and no further than FOLD_MEDIAL medial of it.
 */
export function foldRegion(body: Body, rig: Rig, side: 'L' | 'R', which: 'posterior' | 'anterior'): Uint8Array {
  const skin = body.meshes.get(skinPartOf(body).id)!
  const word = side === 'L' ? 'left' : 'right'
  const re = which === 'posterior' ? /latissimus dorsi|teres major/ : /pectoralis major/
  const muscles = body.data.parts.filter((p) => p.tissue === 'muscle' && body.meshes.has(p.id) && re.test(p.name.toLowerCase()) && p.name.toLowerCase().includes(word))
  if (!muscles.length) throw new Error(`axilla-check: no ${which} fold muscles on the ${word} side`)
  const surf = new Surface(muscles.map((p) => body.meshes.get(p.id)!))
  const G = jointCentre(rig, `gh_${side}`), E = jointCentre(rig, `elbow_${side}`)
  const a: V3 = [E[0] - G[0], E[1] - G[1], E[2] - G[2]]
  const a2 = a[0] * a[0] + a[1] * a[1] + a[2] * a[2]
  const m = side === 'L' ? 1 : -1
  const P = skin.positions, n = P.length / 3
  const out = new Uint8Array(n)
  for (let v = 0; v < n; v++) {
    const x = P[v * 3]!, y = P[v * 3 + 1]!, z = P[v * 3 + 2]!
    const t = ((x - G[0]) * a[0] + (y - G[1]) * a[1] + (z - G[2]) * a[2]) / a2
    if (t < FOLD_T[0] || t > FOLD_T[1]) continue
    if (which === 'posterior' ? z >= G[2] : z <= G[2]) continue
    if (m * x < m * G[0] - FOLD_MEDIAL) continue
    if (surf.distance(x, y, z) > FOLD_NEAR) continue
    out[v] = 1
  }
  return out
}

/** 腋窝顶的皮肤顶点：静止时离腋窝中心 DOME 以内 / The skin vertices of the axilla dome: within DOME of the axilla centre at rest. */
export function domeRegion(body: Body, rig: Rig, side: 'L' | 'R'): Uint8Array {
  const skin = body.meshes.get(skinPartOf(body).id)!
  const G = jointCentre(rig, `gh_${side}`)
  const A: V3 = [G[0], G[1] - 0.09, G[2] - 0.01]
  const P = skin.positions, out = new Uint8Array(P.length / 3)
  for (let v = 0; v < out.length; v++) if (Math.hypot(P[v * 3]! - A[0], P[v * 3 + 1]! - A[1], P[v * 3 + 2]! - A[2]) < DOME) out[v] = 1
  return out
}

/** 按位置合并的顶点编号（皮肤在接缝处拆开了顶点）/ Vertex ids merged by position (the skin splits vertices at seams). */
function weldIds(P: Float32Array): Uint32Array {
  const key = new Map<string, number>()
  const out = new Uint32Array(P.length / 3)
  for (let i = 0; i < out.length; i++) {
    const k = `${Math.round(P[i * 3]! * 2e5)},${Math.round(P[i * 3 + 1]! * 2e5)},${Math.round(P[i * 3 + 2]! * 2e5)}`
    let u = key.get(k)
    if (u === undefined) key.set(k, (u = key.size))
    out[i] = u
  }
  return out
}

/** 皱襞区域的边拉伸和折起面积 / Edge stretch and folded area of a fold region. */
export function foldStats(rest: Float32Array, posed: Float32Array, idx: Uint32Array, region: Uint8Array, weldId?: Uint32Array, lift?: { rest: Float64Array; posed: (x: number, y: number, z: number) => number }): FoldStats {
  const wid = weldId ?? weldIds(rest)
  let nw = 0
  for (const u of wid) nw = Math.max(nw, u + 1)
  // 摆好姿势后的面积加权顶点法线（按合并后的顶点累加）/ posed area-weighted vertex normals (accumulated on merged vertices)
  const vn = new Float64Array(nw * 3)
  const tri = (A: Float32Array, a: number, b: number, c: number): [number, number, number, number] => {
    const ux = A[3 * b]! - A[3 * a]!, uy = A[3 * b + 1]! - A[3 * a + 1]!, uz = A[3 * b + 2]! - A[3 * a + 2]!
    const vx = A[3 * c]! - A[3 * a]!, vy = A[3 * c + 1]! - A[3 * a + 1]!, vz = A[3 * c + 2]! - A[3 * a + 2]!
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx, 0]
  }
  for (let t = 0; t < idx.length; t += 3) {
    const [nx, ny, nz] = tri(posed, idx[t]!, idx[t + 1]!, idx[t + 2]!)
    for (let k = 0; k < 3; k++) {
      const u = wid[idx[t + k]!]!
      vn[u * 3] = vn[u * 3]! + nx
      vn[u * 3 + 1] = vn[u * 3 + 1]! + ny
      vn[u * 3 + 2] = vn[u * 3 + 2]! + nz
    }
  }
  const ratios: number[] = []
  const seen = new Set<number>()
  let tris = 0, folded = 0
  const len = (A: Float32Array, a: number, b: number): number => Math.hypot(A[3 * a]! - A[3 * b]!, A[3 * a + 1]! - A[3 * b + 1]!, A[3 * a + 2]! - A[3 * b + 2]!)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!
    if (!(region[a] && region[b] && region[c])) continue
    tris++
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const ux = wid[x]!, uy = wid[y]!
      const key = Math.min(ux, uy) * nw + Math.max(ux, uy)
      if (seen.has(key)) continue
      seen.add(key)
      const l0 = len(rest, x, y)
      if (l0 > 1e-5) ratios.push(len(posed, x, y) / l0)
    }
    const [nx, ny, nz] = tri(posed, a, b, c)
    let mx = 0, my = 0, mz = 0
    for (const v of [a, b, c]) {
      const u = wid[v]!
      mx += vn[u * 3]!
      my += vn[u * 3 + 1]!
      mz += vn[u * 3 + 2]!
    }
    if (nx * mx + ny * my + nz * mz < 0) folded += Math.hypot(nx, ny, nz) / 2
  }
  ratios.sort((x, y) => x - y)
  const q = (f: number): number => (ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(f * ratios.length))]! : 0)
  // 浮起：按合并后的顶点各算一次 / lift: once per merged vertex
  const lifts: number[] = []
  if (lift) {
    const done = new Uint8Array(nw)
    for (let v = 0; v < region.length; v++) {
      if (!region[v] || done[wid[v]!]) continue
      done[wid[v]!] = 1
      lifts.push(lift.posed(posed[v * 3]!, posed[v * 3 + 1]!, posed[v * 3 + 2]!) - lift.rest[v]!)
    }
    lifts.sort((x, y) => x - y)
  }
  const ql = (f: number): number => (lifts.length ? lifts[Math.min(lifts.length - 1, Math.floor(f * lifts.length))]! : 0)
  return { triangles: tris, edges: ratios.length, p95: r2(q(0.95)), max: r2(q(1)), over15Pct: ratios.length ? r1((100 * ratios.filter((r) => r > 1.5).length) / ratios.length) : 0, foldedCm2: r1(folded * 1e4), liftP95Mm: r1(Math.max(0, ql(0.95)) * 1000), liftMaxMm: r1(Math.max(0, ql(1)) * 1000) }
}

/** 每个顶点分到的静止面积（相邻三角形面积的三分之一）/ The rest area of every vertex (a third of its triangles' areas). */
function vertexAreas(P: Float32Array, idx: Uint32Array): Float64Array {
  const out = new Float64Array(P.length / 3)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!
    const s = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6
    out[idx[t]!] = out[idx[t]!]! + s
    out[idx[t + 1]!] = out[idx[t + 1]!]! + s
    out[idx[t + 2]!] = out[idx[t + 2]!]! + s
  }
  return out
}

/** 一副身体：所有姿势、两侧的各量 / One body: every quantity for every pose and both sides. */
export function measureAxilla(body: Body, rig: Rig, bin: Uint8Array, poses: { id: string; pose: Pose }[] = axillaPoses(rig)): AxillaRow[] {
  const skinPart = skinPartOf(body)
  const skin = body.meshes.get(skinPart.id)!
  const wid = body.skinSource && body.skinSource.length === skin.positions.length / 3 ? body.skinSource : weldIds(skin.positions)
  const sides = ['L', 'R'] as const
  const regions = Object.fromEntries(sides.map((s) => [s, { posterior: foldRegion(body, rig, s, 'posterior'), anterior: foldRegion(body, rig, s, 'anterior'), dome: domeRegion(body, rig, s) }])) as Record<'L' | 'R', { posterior: Uint8Array; anterior: Uint8Array; dome: Uint8Array }>
  // 腋窝周围的深部部件及其顶点（静止）/ the deep parts round the axilla and their vertices (at rest)
  const G = Object.fromEntries(sides.map((s) => [s, jointCentre(rig, `gh_${s}`)])) as Record<'L' | 'R', V3>
  const deep: { part: Part; group: DeepGroup; near: Record<'L' | 'R', number[]>; area: Float64Array }[] = []
  for (const p of body.data.parts) {
    if (!DEEP_TISSUES.has(p.tissue) || !body.meshes.has(p.id)) continue
    const mesh = body.meshes.get(p.id)!
    const near: Record<'L' | 'R', number[]> = { L: [], R: [] }
    const P = mesh.positions
    for (let v = 0; v < P.length / 3; v++) {
      for (const s of sides) {
        const g = G[s]
        if (P[v * 3 + 1]! < g[1] + ABOVE && Math.hypot(P[v * 3]! - g[0], P[v * 3 + 1]! - g[1], P[v * 3 + 2]! - g[2]) < AROUND) near[s].push(v)
      }
    }
    if (near.L.length || near.R.length) deep.push({ part: p, group: deepGroup(p), near, area: vertexAreas(P, mesh.indices) })
  }
  // 深层（浮起的参照）：腋窝周围的肌、骨、腱、软骨 / the deep layer (reference of the lift): muscle, bone, tendon and cartilage round the axilla
  const layer = deep.filter((d) => LAYER_TISSUES.has(d.part.tissue))
  const restLayer = new Surface(layer.map((d) => body.meshes.get(d.part.id)!))
  const restLift = new Float64Array(skin.positions.length / 3)
  for (const s of sides) for (const w of ['posterior', 'anterior', 'dome'] as const) regions[s][w].forEach((on, v) => { if (on) restLift[v] = restLayer.distance(skin.positions[v * 3]!, skin.positions[v * 3 + 1]!, skin.positions[v * 3 + 2]!) })
  const rows: AxillaRow[] = []
  for (const { id, pose } of poses) {
    const poser = new Poser(rig, bin, pose)
    const posedSkin = poser.part(skinPart.id, skin.positions, 'dqs', false)
    const surf = new Surface([{ positions: posedSkin, indices: skin.indices }])
    const wind = new Winding(posedSkin, skin.indices)
    // 符号：在第 4 胸椎关节的中心（体内）核对 / the sign: checked at the centre of the T4 joint (inside the body)
    const mid = poser.jointCenter('T4')
    const sign = wind.at(mid[0], mid[1], mid[2]) < 0 ? -1 : 1
    const acc = Object.fromEntries(sides.map((s) => [s, Object.fromEntries(DEEP_GROUPS.map((g) => [g, { count: 0, areaCm2: 0, maxMm: 0 }]))])) as Record<'L' | 'R', Record<DeepGroup, DeepStats>>
    const posedLayer: { positions: Float32Array; indices: Uint32Array }[] = []
    for (const d of deep) {
      const posed = poser.part(d.part.id, body.meshes.get(d.part.id)!.positions, 'dqs', { mode: 'tapered' })
      if (LAYER_TISSUES.has(d.part.tissue)) posedLayer.push({ positions: posed, indices: body.meshes.get(d.part.id)!.indices })
      for (const s of sides) {
        const st = acc[s][d.group]
        for (const v of d.near[s]) {
          const x = posed[v * 3]!, y = posed[v * 3 + 1]!, z = posed[v * 3 + 2]!
          if (sign * wind.at(x, y, z) >= 0.5) continue
          const sd = surf.distance(x, y, z)
          if (sd <= OUTSIDE) continue
          st.count++
          st.areaCm2 += d.area[v]! * 1e4
          st.maxMm = Math.max(st.maxMm, sd * 1000)
        }
      }
    }
    const layerNow = new Surface(posedLayer)
    const lift = { rest: restLift, posed: (x: number, y: number, z: number): number => layerNow.distance(x, y, z) }
    for (const s of sides) {
      const groups = acc[s]
      for (const g of DEEP_GROUPS) (groups[g].areaCm2 = r1(groups[g].areaCm2)), (groups[g].maxMm = r1(groups[g].maxMm))
      const total = DEEP_GROUPS.reduce((t, g) => ({ count: t.count + groups[g].count, areaCm2: r1(t.areaCm2 + groups[g].areaCm2), maxMm: Math.max(t.maxMm, groups[g].maxMm) }), { count: 0, areaCm2: 0, maxMm: 0 })
      rows.push({
        body: body.data.body, side: s, pose: id,
        posterior: foldStats(skin.positions, posedSkin, skin.indices, regions[s].posterior, wid, lift),
        anterior: foldStats(skin.positions, posedSkin, skin.indices, regions[s].anterior, wid, lift),
        dome: foldStats(skin.positions, posedSkin, skin.indices, regions[s].dome, wid, lift),
        deep: groups, deepTotal: total,
      })
    }
  }
  return rows
}

/** 读入一副身体和它的绑定（rigDir 缺省为人体目录）/ Reads a body and its rig (rigDir defaults to the body directory). */
export async function checkAxilla(bodyId: 'male' | 'female', rigDir?: string): Promise<AxillaRow[]> {
  const dir = join(ROOT, 'public', 'anatomy', bodyId)
  const body = await readBody(dir)
  const rd = rigDir ?? dir
  const rig = JSON.parse(readFileSync(join(rd, 'rig.json'), 'utf8')) as Rig
  const bin = new Uint8Array(readFileSync(join(rd, 'rig.bin')))
  return measureAxilla(body, rig, bin)
}

/** 一行文字摘要 / A one-line summary. */
export function formatRow(r: AxillaRow): string {
  const f = (s: FoldStats): string => `p95 ${s.p95.toFixed(2)} max ${s.max.toFixed(1)} >1.5× ${s.over15Pct.toFixed(1)}% folded ${s.foldedCm2.toFixed(1)} cm² lift ${s.liftP95Mm}/${s.liftMaxMm} mm`
  const d = DEEP_GROUPS.filter((g) => r.deep[g].count).map((g) => `${g} ${r.deep[g].count}/${r.deep[g].areaCm2}cm²/${r.deep[g].maxMm}mm`).join(', ')
  return `${r.body} ${r.side} ${r.pose.padEnd(6)} | posterior ${f(r.posterior)} | anterior ${f(r.anterior)} | dome ${f(r.dome)} | outside skin ${r.deepTotal.count} (${r.deepTotal.areaCm2} cm², ${r.deepTotal.maxMm} mm)${d ? `: ${d}` : ''}`
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const opt = (name: string): string | null => {
    const i = args.indexOf(name)
    if (i < 0) return null
    const v = args[i + 1] ?? null
    args.splice(i, 2)
    return v
  }
  const rigBase = opt('--rig')
  const jsonOut = opt('--json')
  const bodies = (args.length ? args : ['male', 'female']) as ('male' | 'female')[]
  const all: AxillaRow[] = []
  for (const b of bodies) {
    const rd = rigBase ? (existsSync(join(resolve(rigBase), b, 'rig.json')) ? join(resolve(rigBase), b) : resolve(rigBase)) : undefined
    const rows = await checkAxilla(b, rd)
    for (const r of rows) console.log(formatRow(r))
    all.push(...rows)
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(all, null, 1))
}
