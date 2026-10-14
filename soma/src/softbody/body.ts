// 笼子数据的读写，以及把它接到绑定（关节变换）和求解器上的运行时对象。
// Reading and writing the cage data, and the run-time object that connects it to the rig (joint transforms) and the solver.

import type { Xf } from '../../tools/rig/math.ts'
import { skin } from '../../tools/rig/pose.ts'
import { type Lattice, barycentric, locateSlot } from './lattice.ts'
import { type PointSet, type SolverInput, type SolverOptions, SoftSolver, lame } from './solver.ts'
import { MIN_FILL, NO_MUSCLE, REST0_UNIT, STIFF_FILL, type SoftData, type SoftSection } from './types.ts'

export interface LoadedSoft {
  data: SoftData
  nodes: Float32Array
  tets: Uint32Array
  tetSlot: Uint32Array
  tetMaterial: Uint8Array
  tetFill: Uint8Array
  tetSkin: Uint8Array
  tetMuscle: Uint16Array
  nodePin: Int16Array
  /** rig.bin 格式的结点影响 / node influences in rig.bin format */
  nodeInfluence: Uint8Array
  anchors: PointSet
  /** 每个锚点的权重 = 骨占四面体的体积比例（0–1）/ weight of every anchor = share of its tetrahedron taken by bone (0–1) */
  anchorWeight: Float32Array
  /** 零重力参考形状（没有则为 null）/ the zero-gravity reference (null when absent) */
  rest0: Float32Array | null
  embedded: Map<string, PointSet>
  /** 槽位 → 四面体下标 / slot → tetrahedron index */
  slotTet: Map<number, number>
}

/** 嵌入点的存盘编码：uint32 四面体 + 3 × uint16 重心坐标 + 2 字节填充。 On-disk encoding of embedded points: uint32 tetrahedron + 3 × uint16 barycentric + 2 bytes of padding. */
export function encodePoints(set: PointSet, weight?: ArrayLike<number>): Uint8Array {
  const n = set.tet.length
  const out = new Uint8Array(n * 12)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < n; i++) {
    dv.setUint32(i * 12, set.tet[i]!, true)
    // 重心坐标可能略出 [0,1]（点在笼子之外时的外推）：夹到范围内 / coordinates can leave [0,1] slightly (extrapolation outside the cage): clamped
    let b0 = Math.min(1, Math.max(0, set.bary[i * 4]!)), b1 = Math.min(1, Math.max(0, set.bary[i * 4 + 1]!)), b2 = Math.min(1, Math.max(0, set.bary[i * 4 + 2]!))
    const s = b0 + b1 + b2
    if (s > 1) (b0 /= s), (b1 /= s), (b2 /= s)
    dv.setUint16(i * 12 + 4, Math.round(b0 * 65535), true)
    dv.setUint16(i * 12 + 6, Math.round(b1 * 65535), true)
    dv.setUint16(i * 12 + 8, Math.round(b2 * 65535), true)
    if (weight) dv.setUint16(i * 12 + 10, Math.round(Math.min(1, Math.max(0, weight[i]!)) * 65535), true)
  }
  return out
}

export function decodePoints(bin: Uint8Array, s: SoftSection): PointSet {
  const dv = new DataView(bin.buffer, bin.byteOffset + s.offset, s.count * 12)
  const tet = new Uint32Array(s.count), bary = new Float32Array(s.count * 4)
  for (let i = 0; i < s.count; i++) {
    tet[i] = dv.getUint32(i * 12, true)
    const b0 = dv.getUint16(i * 12 + 4, true) / 65535, b1 = dv.getUint16(i * 12 + 6, true) / 65535, b2 = dv.getUint16(i * 12 + 8, true) / 65535
    bary.set([b0, b1, b2, 1 - b0 - b1 - b2], i * 4)
  }
  return { tet, bary }
}

/** 锚点记录末尾两个字节里的权重；旧文件里是 0，读成 1（硬锚点）。 The weight in the last two bytes of an anchor record; 0 in old files, read as 1 (a hard anchor). */
function anchorWeights(bin: Uint8Array, s: SoftSection): Float32Array {
  const dv = new DataView(bin.buffer, bin.byteOffset + s.offset, s.count * 12)
  return Float32Array.from({ length: s.count }, (_, i) => dv.getUint16(i * 12 + 10, true) / 65535 || 1)
}

export interface SoftArrays {
  nodes: Float32Array
  tets: Uint32Array
  tetSlot: Uint32Array
  tetMaterial: Uint8Array
  tetFill: Uint8Array
  tetSkin: Uint8Array
  tetMuscle: Uint16Array
  nodePin: Int16Array
  nodeInfluence: Uint8Array
  anchors: PointSet
  anchorWeight?: Float32Array
  rest0?: Float32Array | null
  embedded: { part: string; points: PointSet }[]
}

/** 写出 soft.bin，并把各段的偏移填进 data.sections / data.embedded。 Writes soft.bin and fills the offsets into data.sections / data.embedded. */
export function encodeSoft(data: Omit<SoftData, 'sections' | 'embedded' | 'nodeCount' | 'tetCount' | 'anchorCount'>, a: SoftArrays): { json: SoftData; bin: Uint8Array } {
  const chunks: Uint8Array[] = []
  let at = 0
  const put = (bytes: ArrayBufferView, count: number): SoftSection => {
    const u = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const s = { offset: at, count }
    chunks.push(u)
    at += u.length
    const pad = (4 - (at % 4)) % 4
    if (pad) chunks.push(new Uint8Array(pad)), (at += pad)
    return s
  }
  const N = a.nodes.length / 3, T = a.tets.length / 4
  const sections: SoftData['sections'] = {
    nodes: put(a.nodes, N),
    tets: put(a.tets, T),
    tetSlot: put(a.tetSlot, T),
    tetMaterial: put(a.tetMaterial, T),
    tetFill: put(a.tetFill, T),
    tetSkin: put(a.tetSkin, T),
    tetMuscle: put(a.tetMuscle, T),
    nodePin: put(a.nodePin, N),
    nodeInfluence: put(a.nodeInfluence, N),
    anchors: put(encodePoints(a.anchors, a.anchorWeight), a.anchors.tet.length),
  }
  if (a.rest0) {
    const q = new Int16Array(N * 3)
    for (let i = 0; i < N * 3; i++) q[i] = Math.max(-32767, Math.min(32767, Math.round((a.rest0[i]! - a.nodes[i]!) / REST0_UNIT)))
    sections.rest0 = put(q, N)
  }
  const embedded = a.embedded.map((e) => ({ part: e.part, ...put(encodePoints(e.points), e.points.tet.length) }))
  const bin = new Uint8Array(at)
  let o = 0
  for (const c of chunks) bin.set(c, o), (o += c.length)
  return { json: { ...data, nodeCount: N, tetCount: T, anchorCount: a.anchors.tet.length, sections, embedded }, bin }
}

export function decodeSoft(data: SoftData, bin: Uint8Array): LoadedSoft {
  const N = data.nodeCount, T = data.tetCount
  // 复制出来：各段按 4 字节对齐，但 bin 自身的 byteOffset 不一定 / copied out: sections are 4-byte aligned, the byteOffset of `bin` itself may not be
  const cut = (s: SoftSection, bytes: number): ArrayBuffer => bin.slice(s.offset, s.offset + bytes).buffer as ArrayBuffer
  const S = data.sections
  const nodes = new Float32Array(cut(S.nodes, N * 12))
  let rest0: Float32Array | null = null
  if (S.rest0) {
    const q = new Int16Array(cut(S.rest0, N * 6))
    rest0 = Float32Array.from(nodes, (v, i) => v + q[i]! * REST0_UNIT)
  }
  const tetSlot = new Uint32Array(cut(S.tetSlot, T * 4))
  const slotTet = new Map<number, number>()
  tetSlot.forEach((s, i) => slotTet.set(s, i))
  return {
    data, nodes, rest0, tetSlot, slotTet,
    tets: new Uint32Array(cut(S.tets, T * 16)),
    tetMaterial: new Uint8Array(cut(S.tetMaterial, T)),
    tetFill: new Uint8Array(cut(S.tetFill, T)),
    tetSkin: new Uint8Array(cut(S.tetSkin, T)),
    tetMuscle: new Uint16Array(cut(S.tetMuscle, T * 2)),
    nodePin: new Int16Array(cut(S.nodePin, N * 2)),
    nodeInfluence: new Uint8Array(cut(S.nodeInfluence, N * 12)),
    anchors: decodePoints(bin, S.anchors),
    anchorWeight: anchorWeights(bin, S.anchors),
    embedded: new Map(data.embedded.map((e) => [e.part, decodePoints(bin, e)])),
  }
}

/**
 * 任意静止空间的点（扁平 xyz）在笼子里的嵌入：由格子算出槽位，再查四面体。落在笼子之外的点 `inside` 为 0，
 * 权重全零（不被物理移动）。
 * Embedding of arbitrary rest-space points (flat xyz) in the cage: the slot follows from the lattice, the tetrahedron
 * from the slot. Points outside the cage get `inside` = 0 and zero weights (the physics does not move them).
 */
export function embedPoints(lattice: Lattice, slotTet: Map<number, number>, nodes: ArrayLike<number>, tets: Uint32Array, positions: ArrayLike<number>): PointSet & { inside: Uint8Array } {
  const n = positions.length / 3
  const tet = new Uint32Array(n), bary = new Float32Array(n * 4), inside = new Uint8Array(n)
  const b = [0, 0, 0, 0]
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!
    const t = slotTet.get(locateSlot(lattice, x, y, z))
    if (t === undefined) continue
    barycentric(nodes, tets[t * 4]!, tets[t * 4 + 1]!, tets[t * 4 + 2]!, tets[t * 4 + 3]!, x, y, z, b)
    tet[i] = t
    bary.set(b, i * 4)
    inside[i] = 1
  }
  return { tet, bary, inside }
}

export interface MixOptions {
  /** 皮肤刚度混入边界四面体的方式：'voigt' 按体积比例算术平均（面内受拉时的上界），'none' 不混入。 */
  /** How skin stiffness enters boundary tetrahedra: 'voigt' = arithmetic mean by volume share (the upper bound, right for in-plane tension), 'none' = not at all. */
  skin?: 'voigt' | 'none'
  /** 'phase3' = 第三阶段的混合式 fill·((1 − fs)·E_m + fs·E_s)、质量不计皮肤，只为前后对照 / 'phase3' = the phase-3 blend fill·((1 − fs)·E_m + fs·E_s) with no skin mass, for before/after comparison only */
  skinBlend?: 'phase4' | 'phase3'
  /** 用零重力参考形状（需要 rest0）而不是预应力 / use the zero-gravity reference (needs rest0) instead of the pre-stress */
  useRest0?: boolean
  /** false = 不要应变硬化（κ = 0）/ false = no strain stiffening (κ = 0) */
  stiffening?: boolean
  /** false = 不要 Maxwell 支路（只有长期响应）/ false = no Maxwell branch (the long-term response only) */
  viscous?: boolean
  /** 'hard' = 第一阶段的硬锚点；缺省按骨的体积比例给有限刚度 / 'hard' = the hard anchors of phase 1; by default a finite stiffness from the bone share */
  anchors?: 'weighted' | 'hard'
  /** 每种材料的杨氏模量倍数（按材料 id），做参数研究用 / a factor on the Young modulus of a material (by id), for parameter studies */
  scale?: Record<string, number>
  /** 覆盖某种材料的 κ / overrides κ of a material */
  kappa?: Record<string, number>
  /**
   * 按材料 id 给出 Ogden 型偏量能（取代该材料的 neo-Hookean 偏量部分，young 只定体积项）；false = 连材料表里给的也不用。
   * Ogden-type deviatoric energy by material id (replacing that material's neo-Hookean deviatoric part; young then sets the
   * volume term only); false = not even those given in the material table.
   */
  ogden?: Record<string, { c: number[]; m: number[] }> | false
}

/**
 * 锚点的刚度，N/m。骨占四面体体积的比例为 φ 时，把骨看成四面体里一块边长 ∝ φ^{1/3} 的刚体，它与四面体结点之间隔着
 * 厚约 cell·(1 − φ^{1/3})/2、面积约 cell²·φ^{2/3} 的软组织：k = G·面积/厚度 = 2·G·cell·φ^{2/3}/(1 − φ^{1/3})。
 * φ → 0 时 k → 0（擦过一角的骨不起作用），φ → 1 时 k → ∞（硬约束）。刚度与单元大小成正比、与 G 成正比，
 * 所以不会因为笼子粗就把组织拴死。这个公式是本项目的假设，不是文献里的。
 * The stiffness of an anchor, N/m. With bone taking the share φ of a tetrahedron, the bone is seen as a rigid lump of
 * size ∝ φ^{1/3} inside it, separated from the nodes by soft tissue about cell·(1 − φ^{1/3})/2 thick over an area of
 * about cell²·φ^{2/3}: k = G·area/thickness = 2·G·cell·φ^{2/3}/(1 − φ^{1/3}). k → 0 as φ → 0 (bone grazing a corner
 * does nothing) and k → ∞ as φ → 1 (a hard constraint). The stiffness scales with the cell and with G, so a coarse
 * cage no longer ties tissue down. The formula is this project's assumption, not from the literature.
 */
export function anchorStiffness(shear: number, cell: number, boneShare: number): number {
  const c = Math.cbrt(Math.min(0.98, Math.max(0, boneShare)))
  return (2 * shear * cell * c * c) / (1 - c)
}

/** 由笼子数据组出求解器的输入：每个四面体的 μ、λ、密度按材料、体内比例和皮肤比例算出。 Builds the solver input from the cage: μ, λ and density of every tetrahedron from its material, fill and skin share. */
export function solverInput(soft: LoadedSoft, mix: MixOptions = {}): SolverInput {
  const T = soft.data.tetCount, N = soft.data.nodeCount
  const mats = soft.data.materials
  const skinMat = mats[soft.data.skin.material]
  const mu = new Float32Array(T), lambda = new Float32Array(T), density = new Float32Array(T)
  const stiffening = new Float32Array(T), branchModulus = new Float32Array(T), branchTau = new Float32Array(T).fill(1)
  const kap = (m: (typeof mats)[number]): number => (mix.stiffening === false ? 0 : (mix.kappa?.[m.id] ?? m.stiffening ?? 0))
  const fibre = new Float32Array(T * 3), fibreModulus = new Float32Array(T), muscle = new Int32Array(T).fill(-1), stiff = new Float32Array(T).fill(1)
  // Ogden 型材料：每种一组项 / Ogden-type materials: one set of terms each
  const ogdenOf = new Map<number, number>(), terms: { c: number[]; m: number[] }[] = []
  const extra = mix.ogden
  if (extra !== false) mats.forEach((m, i) => {
    const q = extra?.[m.id] ?? m.ogden
    if (q && !m.rigid) (ogdenOf.set(i, terms.length), terms.push(q))
  })
  const ogMat = new Int16Array(T).fill(-1), ogScale = new Float32Array(T)
  for (let e = 0; e < T; e++) {
    const m = mats[soft.tetMaterial[e]!]!
    if (m.rigid) continue
    const fill = Math.max(MIN_FILL, soft.tetFill[e]! / 255)
    const fs = (mix.skin ?? 'voigt') === 'voigt' && skinMat ? soft.tetSkin[e]! / 255 : 0
    const ym = m.young * (mix.scale?.[m.id] ?? 1), ys = fs ? skinMat!.young * (mix.scale?.[skinMat!.id] ?? 1) : 0
    // 刚度的折减系数有一个比质量高的下限（"幽灵刚度"）：几乎全在体外的四面体上的结点又轻又软，快速运动时会甩出去十几厘米
    // stiffness gets a higher floor than mass ("ghost stiffness"): nodes of tetrahedra almost wholly outside the body are light and soft and would be flung out by many centimetres in fast motion
    // 体积比例（Voigt）：fs 是皮肤占整个四面体的比例，皮肤层在体内，所以 fs ≤ fill，其余组织占 fill − fs。
    // 第三阶段以前写成 fill·((1 − fs)·E_m + fs·E_s)：皮肤又被乘了一次 fill，表面四面体（fill ≈ 0.2–0.9）里皮肤的 E·V 少了这么多倍。
    // Volume shares (Voigt): fs is the skin's share of the whole tetrahedron and the skin layer lies inside the body, so
    // fs ≤ fill and the other tissue takes fill − fs. Up to phase 3 this read fill·((1 − fs)·E_m + fs·E_s): the skin was
    // multiplied by fill a second time, and its E·V in surface tetrahedra (fill ≈ 0.2–0.9) was short by that factor.
    // fill 只来自 9 个采样点，比按面积算的皮肤比例粗；皮肤比例更大时以它为准 / fill comes from nine samples only, coarser than the area-based skin share; where the skin share is larger it wins
    const legacy = mix.skinBlend === 'phase3'
    const sk = legacy ? Math.max(STIFF_FILL, fill) * Math.min(1, fs) : Math.min(1, fs), ff = legacy ? Math.max(STIFF_FILL, fill) : Math.max(STIFF_FILL, fill, sk)
    const young = (ff - sk) * ym + sk * ys
    const l = lame(young, m.poisson)
    const og = ogdenOf.get(soft.tetMaterial[e]!)
    if (og !== undefined) {
      // Ogden 材料：偏量部分由 Ogden 项给出（按非皮肤的体内比例加权），μ 只留混入的皮肤；λ 仍按整个混合物
      // an Ogden material: the deviatoric part comes from the Ogden terms (weighted by the non-skin share inside), μ keeps only the blended skin; λ still from the whole mixture
      ogMat[e] = og
      ogScale[e] = (ff - sk) * (mix.scale?.[m.id] ?? 1)
      l.mu = lame(sk * ys, m.poisson).mu
    }
    // 混合物的四次项和 Maxwell 支路同样按体积比例加权（Voigt）：κ 按 μ 加权，τ 按支路模量加权
    // the quartic term and the Maxwell branch of the mixture are volume-weighted likewise (Voigt): κ weighted by μ, τ by branch modulus
    const wm = og !== undefined ? 0 : (ff - sk) * ym, ws = sk * ys
    if (wm + ws > 0) stiffening[e] = (wm * kap(m) + ws * (sk ? kap(skinMat!) : 0)) / (wm + ws)
    if (mix.viscous !== false) {
      const gm = wm * (m.branchRatio ?? 0), gs = ws * (skinMat?.branchRatio ?? 0)
      if (gm + gs > 0) {
        branchModulus[e] = (gm + gs) / (2 * (1 + m.poisson))
        branchTau[e] = (gm * (m.branchTau ?? 1) + gs * (skinMat?.branchTau ?? 1)) / (gm + gs)
      }
    }
    mu[e] = l.mu
    lambda[e] = l.lambda
    // 皮肤比例大于 fill 时质量也按它算（与刚度一致）/ where the skin share exceeds fill, mass follows it too (as stiffness does)
    density[e] = legacy ? fill * m.density : (Math.max(fill, sk) - sk) * m.density + sk * (skinMat?.density ?? m.density)
    const mi = soft.tetMuscle[e]!
    if (mi !== NO_MUSCLE) {
      muscle[e] = mi
      const d = soft.data.muscles[mi]?.fibre
      if (d) {
        fibre.set(d, e * 3)
        fibreModulus[e] = fill * (m.fibreYoung ?? 0)
        stiff[e] = m.youngActive ? m.youngActive / m.young : 1
      }
    }
  }
  // 刚性四面体的质量仍要有（否则它的自由结点没有质量）/ rigid tetrahedra still need mass (or their free nodes would have none)
  for (let e = 0; e < T; e++) if (density[e] === 0) density[e] = mats[soft.tetMaterial[e]!]!.density * Math.max(MIN_FILL, soft.tetFill[e]! / 255)
  const pinned = Uint8Array.from(soft.nodePin, (j) => (j >= 0 ? 1 : 0))
  void N
  // 锚点刚度用所在四面体材料本身的 μ（不按体内比例折减：骨周围是实的）/ anchor stiffness from the μ of the tetrahedron's own material (not scaled by fill: tissue round a bone is solid)
  const anchorK = Float32Array.from(soft.anchors.tet, (e, i) => {
    const m = mats[soft.tetMaterial[e]!]!
    if (mix.anchors === 'hard') return Infinity
    const shear = m.rigid ? Infinity : (m.young * (mix.scale?.[m.id] ?? 1)) / (2 * (1 + m.poisson))
    return anchorStiffness(shear, soft.data.lattice.cell, soft.anchorWeight[i] ?? 1)
  })
  return { nodes: soft.nodes, tets: soft.tets, mu, lambda, density, pinned, fibre, fibreModulus, muscle, activeStiffening: stiff, anchors: soft.anchors, anchorStiffness: anchorK, stiffening, branchModulus, branchTau, ...(terms.length ? { ogden: { terms, material: ogMat, scale: ogScale } } : {}) }
}

export interface PoseFrames {
  /** 完整蒙皮变换、刚体部分、体型部分（tools/rig/pose.ts 的 jointFrames）/ full skinning transforms, rigid part, shape part (jointFrames of tools/rig/pose.ts) */
  xfs: Xf[]
  rigid: Xf[]
  shape: Xf[] | null
}

/**
 * 一副身体的软组织：每帧给它关节变换，它给出笼子结点在**静止空间**里的修正位移，再由嵌入传给渲染顶点。
 * 位移在蒙皮之前施加（与表情、体型的位移同一条路径），所以物理叠在蒙皮之上，不取代它。
 * The soft tissue of one body: given the joint transforms every frame it yields the corrective displacement of the
 * cage nodes in **rest space**, which the embeddings pass on to render vertices. The displacement is applied before
 * skinning (the path the face and shape displacements take), so the physics sits on top of skinning and never replaces it.
 */
export class SoftBody {
  readonly solver: SoftSolver
  /** 结点的修正位移，静止空间，扁平 xyz / corrective displacement of the nodes, rest space, flat xyz */
  readonly displacement: Float32Array
  private readonly rot: Float32Array
  private readonly dominant: Uint16Array
  private readonly restNodes: Float32Array
  private readonly skinned: Float32Array

  constructor(readonly soft: LoadedSoft, opts: SolverOptions = {}, readonly mix: MixOptions = {}) {
    const useRest0 = !!mix.useRest0 && !!soft.rest0
    this.solver = new SoftSolver(solverInput(soft, mix), { gravity: soft.data.gravity, prestressGravity: useRest0 ? null : soft.data.gravity, ...opts })
    // 没有指定子步数时按刚度比定（第四阶段）：99 % 分位的刚度比不超过 0.5、且不少于 8。全身 27 mm 笼子上仰卧的稳态位移
    // 2 个子步时大 14 %，4 个以上与 20 个相差不到 0.3 %；刚度比偏大时（体模混入皮肤、16 个子步）系统还会停不下来。
    // Without a given substep count it follows the stiffness ratio (phase 4): the 99th percentile within 0.5, and at
    // least 8. On the whole-body 27 mm cage the steady supine displacement is 14 % too large with 2 substeps and within
    // 0.3 % of 20 substeps from 4 on; with too large a ratio (the phantom with skin blended in, 16 substeps) the system
    // does not come to rest at all.
    if (opts.substeps === undefined) this.solver.substeps = Math.max(8, this.solver.substepsFor(1 / 60))
    const N = soft.data.nodeCount
    this.displacement = new Float32Array(N * 3)
    this.rot = new Float32Array(N * 9)
    for (let i = 0; i < N; i++) this.rot[i * 9] = this.rot[i * 9 + 4] = this.rot[i * 9 + 8] = 1
    this.solver.rotations = this.rot
    this.dominant = new Uint16Array(N)
    const dv = new DataView(soft.nodeInfluence.buffer, soft.nodeInfluence.byteOffset)
    for (let i = 0; i < N; i++) {
      let best = 0
      for (let k = 1; k < 4; k++) if (soft.nodeInfluence[i * 12 + 8 + k]! > soft.nodeInfluence[i * 12 + 8 + best]!) best = k
      this.dominant[i] = dv.getUint16(i * 12 + best * 2, true)
    }
    this.restNodes = useRest0 ? soft.rest0! : soft.nodes
    this.skinned = Float32Array.from(soft.nodes)
    if (useRest0) {
      // 参考构形是无重力形状，状态从发布的（受重力的）形状开始 / the reference is the unloaded shape, the state starts from the shipped (loaded) one
      this.solver.setReference(this.restNodes, true)
      this.solver.x.set(soft.nodes)
    }
    for (const c of soft.data.capsules) this.solver.addCapsule({ a: [...c.a], b: [...c.b], radius: c.radius })
  }

  /**
   * 前进一帧。`frames` 为 null 表示静止姿势。`gravity` 是**身体坐标系**里的重力（换体位 = 换这个向量）。
   * Advances one frame. `frames` = null means the rest pose. `gravity` is gravity in the **body frame** (a change of
   * posture is a change of this vector).
   */
  step(dt: number, frames: PoseFrames | null = null, gravity?: [number, number, number]): void {
    const s = this.solver, soft = this.soft, N = soft.data.nodeCount
    if (gravity) s.gravity = gravity
    if (frames) {
      // 笼子与部件用同一个蒙皮函数（对偶四元数），参考构形 = 蒙皮后的笼子 / the cage is skinned by the same function as the parts (dual quaternions); the reference = the skinned cage
      const ref = skin(this.restNodes, soft.nodeInfluence, 0, frames.xfs, 'dqs', undefined, frames.shape)
      if (this.restNodes !== soft.nodes) this.skinned.set(skin(soft.nodes, soft.nodeInfluence, 0, frames.xfs, 'dqs', undefined, frames.shape))
      else this.skinned.set(ref)
      for (let i = 0; i < N; i++) this.rot.set(frames.rigid[this.dominant[i]!]!.r, i * 9)
      s.setReference(ref)
      for (let k = 0; k < soft.data.capsules.length; k++) {
        const c = soft.data.capsules[k]!, xf = frames.xfs[soft.data.joints.indexOf(c.joint)]
        if (!xf) continue
        const cap = s.capsules[k]!.capsule
        for (const [src, dst] of [[c.a, cap.a], [c.b, cap.b]] as const) for (let r = 0; r < 3; r++) dst[r] = xf.r[r * 3]! * src[0] + xf.r[r * 3 + 1]! * src[1] + xf.r[r * 3 + 2]! * src[2] + xf.t[r]!
      }
    }
    s.step(dt)
    // 世界位移 u = x − 蒙皮后的发布笼子；转回静止空间：u_rest = Rᵀ·u（R 取权重最大的关节的转动，关节附近是近似）
    // world displacement u = x − the skinned shipped cage; back to rest space: u_rest = Rᵀ·u (R of the joint of largest weight; approximate near joints)
    const d = this.displacement, R = this.rot, sk = this.skinned
    for (let i = 0; i < N; i++) {
      const ux = s.x[i * 3]! - sk[i * 3]!, uy = s.x[i * 3 + 1]! - sk[i * 3 + 1]!, uz = s.x[i * 3 + 2]! - sk[i * 3 + 2]!
      const q = i * 9
      d[i * 3] = R[q]! * ux + R[q + 3]! * uy + R[q + 6]! * uz
      d[i * 3 + 1] = R[q + 1]! * ux + R[q + 4]! * uy + R[q + 7]! * uz
      d[i * 3 + 2] = R[q + 2]! * ux + R[q + 5]! * uy + R[q + 8]! * uz
    }
  }

  /** 任意静止空间点的嵌入（加载时对每个要变形的部件算一次）。 Embedding of arbitrary rest-space points (computed once per deforming part at load). */
  embed(positions: ArrayLike<number>): PointSet & { inside: Uint8Array } {
    return embedPoints(this.soft.data.lattice, this.soft.slotTet, this.soft.nodes, this.soft.tets, positions)
  }

  /** 把结点位移插值到嵌入点上：out = base + Σ bₖ·uₖ。 Interpolates the node displacement to embedded points: out = base + Σ bₖ·uₖ. */
  displace(points: PointSet, base: ArrayLike<number>, out: Float32Array): void {
    const d = this.displacement, T = this.soft.tets
    for (let i = 0; i < points.tet.length; i++) {
      const e = points.tet[i]! * 4
      let x = base[i * 3]!, y = base[i * 3 + 1]!, z = base[i * 3 + 2]!
      for (let k = 0; k < 4; k++) {
        const n = T[e + k]! * 3, b = points.bary[i * 4 + k]!
        x += b * d[n]!
        y += b * d[n + 1]!
        z += b * d[n + 2]!
      }
      out[i * 3] = x
      out[i * 3 + 1] = y
      out[i * 3 + 2] = z
    }
  }
}
