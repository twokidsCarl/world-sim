// 软组织物理的 Web Worker 协议，以及界面和地址参数共用的纯逻辑（不依赖 DOM、three.js、Worker）。
// The Web Worker protocol of the soft-tissue physics, plus the pure logic the UI and the URL parameters share (no DOM,
// no three.js, no Worker). Tests: tests/softbody-ui.test.ts.
//
// 两个 worker / Two workers
//   press    按压：在点击处建一块细笼子跑 press()（src/softbody/site.ts、press.ts），边算边回传凹陷。
//            pressing: builds a fine cage at the clicked site and runs press() (src/softbody/site.ts, press.ts), sending
//            the dent back while it solves.
//   posture  体位：建全身 27 mm 笼子，按体位转动重力，走到平衡，回传皮肤相对站立的位移。
//            posture: builds the whole-body 27 mm cage, turns gravity for the posture, runs to equilibrium and sends back
//            the skin's displacement relative to standing.
//
// 消息 / Messages (main → worker)
//   { type: 'init', body }                              人体：部件表、皮肤、绑定 / the body: part table, skin, rig
//   { type: 'meshes', meshes }                          补充部件的静止几何 / rest geometry of more parts
//   { type: 'press', id, site, probe, target }          一次按压 / one press
//   { type: 'posture', id, posture }                    一个体位 / one posture
//   { type: 'pause', paused }                           页面隐藏时暂停（体位）/ pause while the page is hidden (posture)
//   { type: 'cancel', id }                              放弃一项 / drop a job
// 回复 / Replies (worker → main)
//   { type: 'progress', id, … }                         进度（凹陷或体位的中间量）/ progress (dent, or posture figures)
//   { type: 'press-done', id, result, dent, timing }
//   { type: 'posture-done', id, posture, offsets, stats }
//   { type: 'error', id, message }
//
// 位移都在静止空间（静止姿势、默认体型），米；按皮肤顶点给出，加在蒙皮之前（与表情、体型的位移同一条路径）。
// Displacements are in rest space (rest pose, default shape), metres, per skin vertex, applied before skinning (the
// path the face and shape displacements take).

import type { Rig, SystemId } from '../anatomy/types.ts'

export type Vec3 = [number, number, number]

// ---------------------------------------------------------------- 体位 / postures

export type Posture = 'standing' | 'supine' | 'prone' | 'left' | 'right'
export const POSTURES: { id: Posture; zh: string; en: string }[] = [
  { id: 'standing', zh: '站立', en: 'standing' },
  { id: 'supine', zh: '仰卧', en: 'supine' },
  { id: 'prone', zh: '俯卧', en: 'prone' },
  { id: 'left', zh: '左侧卧', en: 'lying on the left side' },
  { id: 'right', zh: '右侧卧', en: 'lying on the right side' },
]

/**
 * 身体坐标系里的重力（x = 身体的左侧，y = 向头，z = 向前；与网格同一坐标系）。换体位 = 转动重力，骨架不动。
 * Gravity in the body frame (x = the body's left, y = cranial, z = anterior; the frame of the meshes). A change of
 * posture turns gravity; the skeleton stays where it is.
 */
export const POSTURE_GRAVITY: Record<Posture, Vec3> = {
  standing: [0, -9.81, 0],
  supine: [0, 0, -9.81],
  prone: [0, 0, 9.81],
  left: [9.81, 0, 0],
  right: [-9.81, 0, 0],
}

/**
 * 卧位的支撑面：法线朝向允许的一侧，平面过皮肤在重力方向上最低的点；这一点 5 cm 以内的皮肤顶点与它接触
 * （tools/softbody/validate.ts 的 lieSupine 的做法，推广到俯卧和侧卧）。站立没有支撑面。
 * The support plane of a lying posture: its normal points to the allowed side and it passes through the skin's lowest
 * point along gravity; skin vertices within 5 cm of that point touch it (the way of lieSupine in
 * tools/softbody/validate.ts, extended to prone and the sides). Standing has none.
 */
export function supportPlane(posture: Posture, skin: ArrayLike<number>): { n: Vec3; d: number; vertices: number[] } | null {
  if (posture === 'standing') return null
  const g = POSTURE_GRAVITY[posture]
  const n = g.map((v) => (v > 0 ? -1 : v < 0 ? 1 : 0)) as Vec3
  let low = Infinity
  for (let i = 0; i < skin.length; i += 3) low = Math.min(low, n[0] * skin[i]! + n[1] * skin[i + 1]! + n[2] * skin[i + 2]!)
  const vertices: number[] = []
  for (let i = 0; i < skin.length; i += 3) if (n[0] * skin[i]! + n[1] * skin[i + 1]! + n[2] * skin[i + 2]! < low + 0.05) vertices.push(i / 3)
  return { n, d: low, vertices }
}

// ---------------------------------------------------------------- 压头 / the probe

export type ProbeKind = 'sphere' | 'flat'
export interface ProbeSpec {
  kind: ProbeKind
  radiusMm: number
}
export type PressTarget = { forceN: number } | { depthMm: number }

/** 界面和地址里允许的范围（超出即截断）/ The ranges the UI and the URL allow (values outside are clamped). */
export const PROBE_LIMITS = { radiusMm: { min: 2, max: 15 }, forceN: { min: 0.05, max: 20 }, depthMm: { min: 0.2, max: 15 } } as const

export interface PhysParam {
  probe: ProbeSpec
  target: PressTarget
  /** 部位：命名部位加侧别，或静止坐标（毫米），写法与 stim= 相同 / the site: a named site with its side, or a rest position in mm, written as in stim= */
  site: string
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const num = (v: number): string => String(Math.round(v * 1000) / 1000)

/**
 * 地址参数 phys= / The URL parameter phys=
 *   phys=1                               打开软组织物理（体位由 grav= 给出）/ soft-tissue physics on (the posture comes from grav=)
 *   phys=<probe>,<radius mm>,<target>@<site>
 *       probe   sphere | flat            球形压头 / 平头圆柱压头 / a spherical probe / a flat-ended cylindrical punch
 *       target  1N | 4.5mm               力控（牛）或深度控（毫米）/ force control (newtons) or depth control (millimetres)
 *       site    forearm_L | p-182,1034,28 与 stim= 的部位写法相同 / written as the site of stim=
 *   例 / e.g.   phys=sphere,5,1N@forearm_L    phys=flat,13,4.5mm@p290,1020,80
 * 地址参数 grav= / The URL parameter grav=
 *   grav=supine | prone | left | right   体位；省略为站立。与肌肉活动显示共用这个参数（它只认 supine、prone）。
 *                                        the posture; standing when omitted. Shared with the muscle-activity display (which
 *                                        reads supine and prone only).
 */
export function parsePhysParam(text: string | null): { on: boolean; press: PhysParam | null; error: string | null } {
  if (text === null || text === '') return { on: false, press: null, error: null }
  if (text === '1' || text === 'on') return { on: true, press: null, error: null }
  const at = text.indexOf('@')
  const bad = (why: string): { on: boolean; press: null; error: string } => ({ on: true, press: null, error: `phys: ${why}（形式为 sphere,5,1N@forearm_L 或 flat,13,4.5mm@p290,1020,80）/ ${why} (form sphere,5,1N@forearm_L or flat,13,4.5mm@p290,1020,80)` })
  if (at < 0) return bad('缺少 @部位 / missing @site')
  const f = text.slice(0, at).split(',')
  const site = text.slice(at + 1)
  if (f.length !== 3) return bad('要三项：压头,半径,目标 / three items are needed: probe,radius,target')
  const kind = f[0] === 'sphere' || f[0] === 'flat' ? f[0] : null
  if (!kind) return bad(`压头只能是 sphere 或 flat，不是 "${f[0]}" / the probe must be sphere or flat, not "${f[0]}"`)
  const radius = Number(f[1])
  if (!Number.isFinite(radius) || radius <= 0) return bad(`半径要是正数（毫米），不是 "${f[1]}" / the radius must be a positive number of millimetres, not "${f[1]}"`)
  const m = /^(\d+(?:\.\d+)?)(N|mm)$/i.exec(f[2]!)
  if (!m) return bad(`目标要写成 1N 或 4.5mm，不是 "${f[2]}" / the target must read like 1N or 4.5mm, not "${f[2]}"`)
  if (!site) return bad('部位是空的 / the site is empty')
  const v = Number(m[1])
  const target: PressTarget = m[2]!.toLowerCase() === 'n' ? { forceN: clamp(v, PROBE_LIMITS.forceN.min, PROBE_LIMITS.forceN.max) } : { depthMm: clamp(v, PROBE_LIMITS.depthMm.min, PROBE_LIMITS.depthMm.max) }
  return { on: true, press: { probe: { kind, radiusMm: clamp(radius, PROBE_LIMITS.radiusMm.min, PROBE_LIMITS.radiusMm.max) }, target, site }, error: null }
}

export function formatPhysParam(p: PhysParam | null, on: boolean): string | null {
  if (!p) return on ? '1' : null
  const t = 'forceN' in p.target ? `${num(p.target.forceN)}N` : `${num(p.target.depthMm)}mm`
  return `${p.probe.kind},${num(p.probe.radiusMm)},${t}@${p.site}`
}

export function parseGravParam(text: string | null): Posture {
  return text === 'supine' || text === 'prone' || text === 'left' || text === 'right' ? text : 'standing'
}

export function formatGravParam(p: Posture): string | null {
  return p === 'standing' ? null : p
}

// ---------------------------------------------------------------- 人体数据 / body data

/** 建笼子用到的部件字段（AnatomyData.parts 的子集）/ The part fields the cage builder uses (a subset of AnatomyData.parts). */
export interface PartLite {
  id: string
  name: string
  system: string
  tissue: string
  side?: string
  bbox: number[]
  centroid: number[]
  triangles: number
}

export interface MeshPayload {
  id: string
  /** 静止位置，米 / rest positions, metres */
  positions: Float32Array
  /** 部件内的下标 / part-local indices */
  indices: Uint32Array
}

export interface BodyPayload {
  body: 'male' | 'female'
  parts: PartLite[]
  skin: MeshPayload
  rig: Rig
  rigBin: Uint8Array
}

/**
 * 笼子会读到网格的部件：骨、软骨、牙、肌肉、脂肪、乳腺、脏器、心、皮肤（tools/softbody/cage.ts 的分类），并且在建笼子
 * 用到的系统里。其余部件（神经、血管、韧带…）笼子不看。
 * Parts whose mesh the cage reads: bone, cartilage, tooth, muscle, fat, gland, organ, heart, skin (the classes of
 * tools/softbody/cage.ts), in the systems the cage uses. The cage ignores every other part (nerves, vessels, ligaments…).
 */
export const CAGE_TISSUES = new Set(['bone', 'cartilage', 'tooth', 'muscle', 'fat', 'gland', 'organ', 'heart', 'skin'])
export const CAGE_SYSTEMS: SystemId[] = ['integumentary', 'skeletal', 'muscular', 'digestive', 'urinary', 'reproductive', 'respiratory', 'cardiovascular']

export function cageParts(parts: readonly PartLite[], box: readonly number[] | null = null): PartLite[] {
  return parts.filter((p) => CAGE_TISSUES.has(p.tissue) && (CAGE_SYSTEMS as string[]).includes(p.system) && (!box || (p.bbox[0]! <= box[3]! && p.bbox[3]! >= box[0]! && p.bbox[1]! <= box[4]! && p.bbox[4]! >= box[1]! && p.bbox[2]! <= box[5]! && p.bbox[5]! >= box[2]!)))
}

/** 细笼子的单元边长和区域半边长（米），即 buildSiteFrom（src/softbody/site.ts）的缺省 / cell edge and region half-size (metres) of a fine cage: the defaults of buildSiteFrom (src/softbody/site.ts) */
export function siteGeometry(probeRadius: number, o: { cell?: number; extent?: number } = {}): { cell: number; extent: number } {
  const cell = o.cell ?? Math.min(0.006, Math.max(0.002, probeRadius / 3))
  return { cell, extent: o.extent ?? Math.max(3 * probeRadius, probeRadius + 5 * cell) }
}

/**
 * 细笼子要的部件所在的盒子：区域（半边长 extent）再向外 2 个单元加 1 cm——碰到区域边上四面体的骨点也要算进去。
 * The box of the parts a fine cage needs: the region (half-size `extent`) grown by two cells and 1 cm, so that bone
 * points in tetrahedra on the region's edge are counted too.
 */
export function siteBox(site: Vec3, extent: number, cell: number): number[] {
  const m = extent + 2 * cell + 0.01
  return [site[0] - m, site[1] - m, site[2] - m, site[0] + m, site[1] + m, site[2] + m]
}

// ---------------------------------------------------------------- 消息 / messages

export interface PressSite {
  /** 静止空间的压入点，米 / the site in rest space, metres */
  position: Vec3
  /** 最近的皮肤顶点 / the nearest skin vertex */
  vertex: number
  /** 点在哪个三角形上（点击时有），用来插值法线 / the triangle hit (when clicked), for interpolating the normal */
  triangle?: [number, number, number]
  barycentric?: [number, number, number]
}

export type Request =
  | { type: 'init'; body: BodyPayload }
  | { type: 'meshes'; meshes: MeshPayload[] }
  | { type: 'press'; id: number; site: PressSite; probe: ProbeSpec; target: PressTarget }
  | { type: 'posture'; id: number; posture: Posture }
  | { type: 'pause'; paused: boolean }
  | { type: 'cancel'; id: number }

/** 主皮肤以外、跟着笼子走的部件（皮肤的其他片、皮下脂肪）的逐顶点位移 / per-vertex displacement of parts other than the main skin that follow the cage (other skin pieces, subcutaneous fat) */
export interface PartOffsets {
  id: string
  offsets: Float32Array
}

/** 按压时其他部件（皮下脂肪、皮肤的其他片）的稀疏位移；count 是该部件的顶点数 / the sparse displacement of other parts (subcutaneous fat, other skin pieces) during a press; count is the part's vertex count */
export interface PartDent extends SparseOffsets {
  id: string
  count: number
}

/** 稀疏的逐皮肤顶点位移 / sparse per-skin-vertex displacement */
export interface SparseOffsets {
  vertices: Uint32Array
  /** xyz × vertices.length，米 / xyz × vertices.length, metres */
  offsets: Float32Array
}

export interface PressSummary {
  depthMm: number
  forceN: number
  meanPressureKPa: number
  peakPressureKPa: number
  contactAreaMm2: number
  peakStrain: number
  valid: boolean
  flags: string[]
  stoppedBy: 'strain-gate' | 'tissue-thickness' | null
  gate: 'strain' | 'force-drop' | 'not-finite' | null
  cellMm: number
  tissueThicknessMm: number | null
  frames: number
  converged: boolean
  /** 要求的目标 / the requested target */
  target: PressTarget
  probe: ProbeSpec
  /** 压入方向（向外，单位向量）/ the pressing direction (outward, unit) */
  outward: Vec3
}

export interface PressTiming {
  /** 建"体内"判断（每个 worker 一次）/ building the inside test (once per worker) */
  insideMs: number
  cageMs: number
  solverMs: number
  solveMs: number
  /** 收到请求到第一次回传凹陷 / from the request to the first dent sent back */
  firstDentMs: number | null
  totalMs: number
  msPerFrame: number
  nodes: number
  tets: number
}

export interface PostureStats {
  posture: Posture
  frames: number
  converged: boolean
  maxSpeed: number
  msPerFrame: number
  substeps: number
  cageMs: number
  solveMs: number
  nodes: number
  tets: number
  /** 皮肤相对站立的位移：平均和最大，毫米 / skin displacement relative to standing: mean and largest, mm */
  skinMeanMm: number
  skinMaxMm: number
  supportForceN: number | null
  /** 这个体位是从缓存里取的 / served from the cache */
  cached: boolean
}

/**
 * 凹陷的细分显示网格（src/softbody/dentmesh.ts）在一次按压里的更新：网格只在第一次和结束时带上；`dent` 是细分顶点的位移，
 * `hide` 是被盖住的皮肤顶点向里收的位移（都是 xyz，米）。
 * An update of the dent's subdivided display mesh (src/softbody/dentmesh.ts) during a press: the mesh itself comes with
 * the first update and the last; `dent` is the displacement of the subdivided vertices and `hide` the inward displacement
 * of the skin vertices it covers (both xyz, metres).
 */
export interface PatchUpdate {
  mesh?: { position: Float32Array; index: Uint32Array; corners: Uint32Array; weights: Float32Array; hidden: Uint32Array }
  dent: Float32Array
  hide: Float32Array
}

export type Reply =
  | { type: 'ready'; insideMs: number }
  | { type: 'progress'; id: number; stage: 'cage' | 'solve'; frames: number; elapsedMs: number; depthMm?: number; maxSpeed?: number; msPerFrame?: number; dent?: SparseOffsets; patch?: PatchUpdate; parts?: PartDent[] }
  | { type: 'press-done'; id: number; result: PressSummary; dent: SparseOffsets; patch?: PatchUpdate; parts: PartDent[]; timing: PressTiming }
  | { type: 'posture-done'; id: number; posture: Posture; offsets: Float32Array; parts: PartOffsets[]; stats: PostureStats }
  | { type: 'error'; id: number; message: string }

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))

/**
 * 检查一条请求；不对时抛出说明哪个字段、允许什么值的错误（worker 收到就回 error）。
 * Checks a request; when it is wrong, throws an error naming the field and the values allowed (the worker answers with `error`).
 */
export function checkRequest(m: unknown): Request {
  if (!m || typeof m !== 'object') throw new Error('softbody worker: 消息必须是对象 / the message must be an object')
  const r = m as Record<string, unknown>
  const id = (): number => {
    if (typeof r.id !== 'number' || !Number.isInteger(r.id)) throw new Error(`softbody worker: ${String(r.type)}.id 必须是整数 / must be an integer`)
    return r.id
  }
  switch (r.type) {
    case 'init': {
      const b = r.body as BodyPayload | undefined
      if (!b || (b.body !== 'male' && b.body !== 'female')) throw new Error('softbody worker: init.body.body 只能是 male 或 female / must be male or female')
      if (!Array.isArray(b.parts) || !b.skin || !(b.skin.positions instanceof Float32Array) || !(b.skin.indices instanceof Uint32Array)) throw new Error('softbody worker: init.body 需要 parts、skin.positions（Float32Array）、skin.indices（Uint32Array）/ needs parts, skin.positions (Float32Array), skin.indices (Uint32Array)')
      if (!b.rig || !(b.rigBin instanceof Uint8Array)) throw new Error('softbody worker: init.body 需要 rig 和 rigBin（Uint8Array）/ needs rig and rigBin (Uint8Array)')
      return { type: 'init', body: b }
    }
    case 'meshes': {
      if (!Array.isArray(r.meshes) || !r.meshes.every((x: MeshPayload) => typeof x.id === 'string' && x.positions instanceof Float32Array && x.indices instanceof Uint32Array)) throw new Error('softbody worker: meshes 每项要有 id、positions（Float32Array）、indices（Uint32Array）/ every item needs id, positions (Float32Array), indices (Uint32Array)')
      return { type: 'meshes', meshes: r.meshes as MeshPayload[] }
    }
    case 'press': {
      const site = r.site as PressSite | undefined
      if (!site || !isVec3(site.position) || typeof site.vertex !== 'number') throw new Error('softbody worker: press.site 需要 position（三个数，米）和 vertex（整数）/ needs position (three numbers, metres) and vertex (an integer)')
      const p = r.probe as ProbeSpec | undefined
      if (!p || (p.kind !== 'sphere' && p.kind !== 'flat')) throw new Error('softbody worker: press.probe.kind 只能是 sphere 或 flat / must be sphere or flat')
      if (!(p.radiusMm >= PROBE_LIMITS.radiusMm.min && p.radiusMm <= PROBE_LIMITS.radiusMm.max)) throw new Error(`softbody worker: press.probe.radiusMm 要在 ${PROBE_LIMITS.radiusMm.min}–${PROBE_LIMITS.radiusMm.max} 之内 / must be within ${PROBE_LIMITS.radiusMm.min}–${PROBE_LIMITS.radiusMm.max}`)
      const t = r.target as Record<string, number> | undefined
      if (!t || ('forceN' in t ? !(t.forceN! >= PROBE_LIMITS.forceN.min && t.forceN! <= PROBE_LIMITS.forceN.max) : 'depthMm' in t ? !(t.depthMm! >= PROBE_LIMITS.depthMm.min && t.depthMm! <= PROBE_LIMITS.depthMm.max) : true)) {
        throw new Error(`softbody worker: press.target 要么是 { forceN: ${PROBE_LIMITS.forceN.min}–${PROBE_LIMITS.forceN.max} }，要么是 { depthMm: ${PROBE_LIMITS.depthMm.min}–${PROBE_LIMITS.depthMm.max} } / must be either { forceN } or { depthMm } within those ranges`)
      }
      return { type: 'press', id: id(), site, probe: { kind: p.kind, radiusMm: p.radiusMm }, target: 'forceN' in t ? { forceN: t.forceN! } : { depthMm: t.depthMm! } }
    }
    case 'posture': {
      if (!POSTURES.some((p) => p.id === r.posture)) throw new Error(`softbody worker: posture.posture 只能是 ${POSTURES.map((p) => p.id).join('、')} / must be one of ${POSTURES.map((p) => p.id).join(', ')}`)
      return { type: 'posture', id: id(), posture: r.posture as Posture }
    }
    case 'pause':
      if (typeof r.paused !== 'boolean') throw new Error('softbody worker: pause.paused 必须是 true 或 false / must be true or false')
      return { type: 'pause', paused: r.paused }
    case 'cancel':
      return { type: 'cancel', id: id() }
  }
  throw new Error(`softbody worker: 不认识的消息类型 "${String(r.type)}"（init、meshes、press、posture、pause、cancel）/ unknown message type`)
}

// ---------------------------------------------------------------- 皮肤位移 / skin displacement

/**
 * 嵌入点的位移：Σ bₖ·(xₖ − x₀ₖ)，只取 inside 为 1 的点。`x` 是求解器此刻的结点位置，`x0` 是笼子的静止结点。
 * The displacement of embedded points: Σ bₖ·(xₖ − x₀ₖ), for points with inside = 1 only. `x` holds the solver's present
 * node positions, `x0` the cage's rest nodes.
 */
export function embeddedDisplacement(points: { tet: Uint32Array; bary: Float32Array; inside?: Uint8Array }, vertices: ArrayLike<number>, tets: Uint32Array, x: ArrayLike<number>, x0: ArrayLike<number>, minMm = 0): SparseOffsets {
  const keepV: number[] = [], keepO: number[] = []
  for (let i = 0; i < points.tet.length; i++) {
    if (points.inside && !points.inside[i]) continue
    const e = points.tet[i]! * 4
    let ux = 0, uy = 0, uz = 0
    for (let k = 0; k < 4; k++) {
      const n = tets[e + k]! * 3, b = points.bary[i * 4 + k]!
      ux += b * (x[n]! - x0[n]!)
      uy += b * (x[n + 1]! - x0[n + 1]!)
      uz += b * (x[n + 2]! - x0[n + 2]!)
    }
    if (Math.hypot(ux, uy, uz) * 1000 < minMm) continue
    keepV.push(vertices[i]!)
    keepO.push(ux, uy, uz)
  }
  return { vertices: Uint32Array.from(keepV), offsets: Float32Array.from(keepO) }
}

/** 稠密版：每个嵌入点的位移写进 out（xyz），inside 为 0 的点写 0 / the dense version: every embedded point's displacement into out (xyz), 0 where inside is 0 */
export function denseDisplacement(points: { tet: Uint32Array; bary: Float32Array; inside?: Uint8Array }, tets: Uint32Array, x: ArrayLike<number>, x0: ArrayLike<number>, out: Float32Array = new Float32Array(points.tet.length * 3)): Float32Array {
  for (let i = 0; i < points.tet.length; i++) {
    let ux = 0, uy = 0, uz = 0
    if (!points.inside || points.inside[i]) {
      const e = points.tet[i]! * 4
      for (let k = 0; k < 4; k++) {
        const n = tets[e + k]! * 3, b = points.bary[i * 4 + k]!
        ux += b * (x[n]! - x0[n]!)
        uy += b * (x[n + 1]! - x0[n + 1]!)
        uz += b * (x[n + 2]! - x0[n + 2]!)
      }
    }
    out[i * 3] = ux
    out[i * 3 + 1] = uy
    out[i * 3 + 2] = uz
  }
  return out
}

/** out += scale · sparse（按皮肤顶点）/ out += scale · sparse (by skin vertex) */
export function addSparse(out: Float32Array, s: SparseOffsets, scale = 1): void {
  for (let i = 0; i < s.vertices.length; i++) {
    const v = s.vertices[i]! * 3
    if (v + 2 >= out.length) continue
    out[v] = out[v]! + scale * s.offsets[i * 3]!
    out[v + 1] = out[v + 1]! + scale * s.offsets[i * 3 + 1]!
    out[v + 2] = out[v + 2]! + scale * s.offsets[i * 3 + 2]!
  }
}

/** 稀疏位移里最大的模，毫米 / the largest magnitude in a sparse displacement, mm */
export function sparseMaxMm(s: SparseOffsets): number {
  let m = 0
  for (let i = 0; i < s.vertices.length; i++) m = Math.max(m, Math.hypot(s.offsets[i * 3]!, s.offsets[i * 3 + 1]!, s.offsets[i * 3 + 2]!))
  return m * 1000
}

/**
 * 松开后凹陷回弹的包络：1 → 0，用时 `ms`，先快后慢（平滑的三次）。这是显示用的过渡，不是组织的蠕变恢复（没有模拟）。
 * The envelope of the dent springing back after release: 1 → 0 over `ms`, fast then slow (a smooth cubic). It is a
 * display transition, not the tissue's creep recovery (not simulated).
 */
export function releaseEnvelope(sinceReleaseMs: number, ms = 700): number {
  if (sinceReleaseMs <= 0) return 1
  if (sinceReleaseMs >= ms) return 0
  const t = 1 - sinceReleaseMs / ms
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------- 位移着色 / displacement colours

/** 位移着色的满量程，毫米（固定，几个体位可以互相比较）/ full scale of the displacement colours, mm (fixed, so postures compare) */
export const DISP_FULL_MM = 30
/** 顺序色带：深蓝 → 青 → 浅黄（与疼痛的红橙色分开）/ a sequential ramp: deep blue → cyan → pale yellow (kept apart from the reds and oranges of pain) */
export const DISP_RAMP: { t: number; rgb: Vec3 }[] = [
  { t: 0, rgb: [0.15, 0.25, 0.55] },
  { t: 0.33, rgb: [0.2, 0.5, 0.8] },
  { t: 0.66, rgb: [0.35, 0.8, 0.8] },
  { t: 1, rgb: [0.95, 0.96, 0.6] },
]

/** 色带上 t（0–1，超出截断）处的颜色 / the ramp's colour at t (0–1, clamped) */
export function dispRamp(t: number): Vec3 {
  const x = Math.min(1, Math.max(0, t))
  for (let i = 1; i < DISP_RAMP.length; i++) {
    const a = DISP_RAMP[i - 1]!, b = DISP_RAMP[i]!
    if (x <= b.t) {
      const k = (x - a.t) / (b.t - a.t)
      return [a.rgb[0] + k * (b.rgb[0] - a.rgb[0]), a.rgb[1] + k * (b.rgb[1] - a.rgb[1]), a.rgb[2] + k * (b.rgb[2] - a.rgb[2])]
    }
  }
  return [...DISP_RAMP[DISP_RAMP.length - 1]!.rgb]
}

/**
 * 逐顶点位移（xyz，米，真实大小）→ 逐顶点颜色（rgba，0–1）：模长按 0–DISP_FULL_MM 映到色带（零也上色）。
 * Per-vertex displacement (xyz, metres, true size) → per-vertex colour (rgba, 0–1): the magnitude maps onto the ramp
 * over 0–DISP_FULL_MM (zero is coloured too).
 */
export function displacementColors(offsets: ArrayLike<number>, opacity = 0.75, out: Float32Array = new Float32Array((offsets.length / 3) * 4)): Float32Array {
  for (let i = 0; i < offsets.length / 3; i++) {
    const mm = Math.hypot(offsets[i * 3]!, offsets[i * 3 + 1]!, offsets[i * 3 + 2]!) * 1000
    const c = dispRamp(mm / DISP_FULL_MM)
    out[i * 4] = c[0]
    out[i * 4 + 1] = c[1]
    out[i * 4 + 2] = c[2]
    out[i * 4 + 3] = opacity
  }
  return out
}
