// 面部表情层的构建：从肌肉部件的几何和精编参数，算出每个通道在皮肤和深层部件上的位移场。
// Build of the facial expression layer: from the geometry of the muscle parts and the curated
// parameters, compute every channel's displacement field on the skin and on the deep parts.
//
// 做法 / Method
//   · 线状肌：作用线的两端取自肌肉网格（主轴方向上两端各 15% 顶点的质心），哪一端固定由精编的 hint 决定；
//     左右两侧的作用线对正中矢状面取平均（对称化）。两端投影到皮肤上，皮肤顶点沿皮肤切面被拉向固定端，
//     权重沿作用线从固定端的 0 升到活动端的 1，越过活动端后衰减，向两侧衰减。
//     Linear muscle: both ends of the line come from the muscle mesh (centroids of the extreme 15% of
//     vertices along the principal axis); the curated hint says which end is fixed; left and right
//     lines are averaged about the midsagittal plane (symmetrised). Both ends are projected onto the
//     skin, and skin vertices are pulled within the skin's tangent plane towards the fixed end, with a
//     weight rising from 0 at the fixed end to 1 at the mobile end, decaying beyond it and sideways.
//   · 环状肌：环周围的皮肤沿切面被拉向环心，按方位（上、下、内、外）加权。
//     Sphincter: skin round the ring is drawn towards the centre in the tangent plane, weighted by sector.
//   · 眼睑：深层的睑裂上下缘用射线在睑部肌肉网格上量出；上睑下落、下睑上抬到闭合线，保持到眼球中心的距离。
//     皮肤是一张闭合的面，没有睑裂：皮肤上另量一套睑缘（两睑之间那片凹进去的皮肤的上下边），上睑的皮肤滑下来盖住
//     那片皮肤，睑裂只是“形状”合上了。
//     Eyelids: the margins of the deep palpebral fissure are measured by ray casting on the lid muscle meshes; the upper lid
//     comes down and the lower lid up to the closure line, keeping its distance from the globe centre. The skin is one closed
//     surface with no fissure: a second pair of margins is measured on the skin (the upper and lower edge of the recessed patch
//     between the lids), and upper-lid skin slides down over that patch, so that only the SHAPE of the fissure closes.
//   · 厚度变化：皮肤沿切面滑动时，被挤压处增厚、被拉开处变薄，w = −(H / 2)·div_s(u)，沿法线（见“在皮肤上求值”一节）。
//     Thickness change: as the skin slides, it thickens where squeezed and thins where stretched, w = −(H / 2)·div_s(u) along the
//     normal (see the section that evaluates the fields on the skin).
//   · 口裂内陷：皮肤的唇不能分开；张口时把两唇相贴的那道褶向口内推，是几何上的替代，不是肌肉。
//     Oral recess: the lips of the skin cannot part; on mouth opening the crease where they meet is pushed into the mouth. A
//     geometric stand-in, not a muscle.
//   · 深层部件（肌肉、眉、唇、睑板、皮下脂肪、软骨、血管、神经……）跟随其上方皮肤的切向位移场（不含厚度变化），
//     离皮肤越深、离骨越近，跟随得越少。肌肉因此沿作用线缩短；不做隆起（体积不守恒）。
//     Deep parts (muscles, eyebrow, lips, tarsal plates, subcutaneous fat, cartilages, vessels, nerves …) follow the tangential
//     field of the skin above them (without the thickness change), less so the deeper below the skin and the closer to bone.
//     Muscles thereby shorten along their line; no bulge is modelled for them (their volume is not preserved).

//   · 皮肤有真实的睑裂和口裂时（face/openings.json，见 openings.ts）：上下唇、上下睑按清单里的“片”区分，不再量褶；
//     闭眼 = 上睑缘沿眼球表面落到下睑缘上，睑的皮肤跟着走；睑缘内卷和口腔袋跟随各自的缘顶点；
//     口角成形通道让张口时的口裂呈杏仁形。“口裂内陷”和“上睑皮肤滑过那片皮肤”这两个替代做法只用于闭合的皮肤。
//     When the skin has real eye and mouth openings (face/openings.json, see openings.ts): the lips and the lids are told apart
//     by the sheets of the manifest instead of a measured crease; eye closure = the upper lid margin comes down onto the lower
//     along the globe's surface with the lid skin following; lid rims and the oral pouch follow their margin vertices; and a
//     corner-shaping channel makes the opened mouth almond-shaped. The two stand-ins — the oral recess and "upper-lid skin
//     slides over the patch" — are used for a closed skin only.
//   · 口周的抹匀（开口的皮肤）：口裂附近的网格很密，两唇相贴的面只隔零点几毫米，逐顶点的场在那里会撕出裂口。所以肌肉通道在口裂和
//     口角附近的位移在网格上按 2.5 mm 的长度抹匀（屏蔽泊松方程；不分上下唇的通道把口裂焊上）；口角成形通道把口周的下颌份额换成
//     跟随唇缘的光滑的场；眉毛照搬皮肤的全部位移；眼睑通道的场在睑缘之外抹匀。
//     Evening round the mouth (opened skin): the mesh near the fissure is very dense and the contact surfaces of the lips lie tenths of
//     a millimetre apart, so a per-vertex field tears there. Muscle channels therefore have their displacement near the fissure and
//     the corners evened over the mesh on a length of 2.5 mm (a screened Poisson solve; with the fissure welded for channels that do
//     not tell the lips apart); the corner-shaping channel replaces the perioral jaw share by a smooth field that follows the
//     margins; the eyebrows copy the whole displacement of the skin; lid channel fields are evened off the margins.

import type { Part, Rig, Side, Vec3 } from '../../src/anatomy/types.ts'
import type { Bilingual, FaceAU, FaceChannel, FaceChannelKind, FaceData, FaceField, FaceOpenings, FaceSource, PainModel, Sourced } from '../../src/face/types.ts'
import { Surface, mergeMeshes } from '../rig/geom.ts'
import type { Body, RawMesh } from '../rig/io.ts'
import { type V3, add, cross, dot, len, mul, norm, sub } from '../rig/math.ts'
import { Poser } from '../rig/pose.ts'
import { Q } from './model.ts'

export interface MuscleDef {
  id: string
  match: string
  name: Bilingual
  model: FaceChannelKind
  hint?: V3
  excursionMm: number
  spreadMm: number
  reachMm: number
  carryMm?: number
  hangMm?: number
  project?: 'front'
  axis?: 'hint'
  insertAt?: 'modiolus'
  mask: ('aboveStomion' | 'belowStomion' | 'aboveEye' | 'belowEye')[]
  attachments: { origin: Bilingual; insertion: Bilingual }
  action: Bilingual
  ring?: 'outer' | 'inner' | 'single'
  lid?: 'upper' | 'lower' | 'raise'
  /** 把一块肌肉的场按到正中的距离分成内侧、外侧两个通道（额肌 → AU1 / AU2）/ split one muscle's field by distance from the midline into a medial and a lateral channel (frontalis → AU1 / AU2). */
  split?: { atMm: number; blendMm: number }
  raiseMm?: number
  sectors?: { inferior: number; lateral: number; superior: number; medial: number }
  /**
   * 沿唇的延续（只用于有真实口裂的皮肤）：'corner' = 止于口角轴的肌肉，把整条唇带着走，份额从口角的 1 降到正中的 0；
   * 'middle' = 唇的提肌 / 降肌，场沿唇缘一直延伸到正中，到口角降为 0。bandMm 是离口裂多远处降为 0。
   * Carry along the lip (opened skin only): 'corner' = a muscle inserting at the modiolus carries the whole lip with it, its share
   * falling from 1 at the corner to 0 at the midline; 'middle' = a lip elevator / depressor whose field runs along the margin
   * to the midline and falls to 0 at the corner. bandMm is the distance from the fissure at which it reaches 0.
   */
  lip?: { profile: 'corner' | 'middle'; bandMm?: number }
  /** 唇的几何通道（model: 'lip'）做什么 / what a geometric lip channel (model 'lip') does. */
  lipAction?: 'seal' | 'dental' | 'protrude' | 'rollUpper' | 'rollLower' | 'press' | 'upperDepress' | 'evert' | 'purse'
  /** seal / dental 通道求解时所用的下颌张开角占活动范围的比例 / the jaw opening, as a fraction of its range, at which a seal / dental channel is solved. */
  refJawFraction?: number
  /** 舌的示意姿势（model: 'tongue'）/ the schematic tongue pose (model 'tongue'). */
  tongue?: 'tip' | 'front' | 'back' | 'low' | 'retro'
}

export interface Curated {
  muscles: {
    muscles: MuscleDef[]
    bulge?: { gain: number; minMm: number; maxMm: number; limitMm: number; smoothing: number; creasePasses?: number }
    corner?: { handoverMm: number; saturationDeg: number; foldPasses: number; minAreaRatio: number; maxAreaRatio: number; zoneMm: number; shareAtCorner?: number; gapExponent?: number; jawRegionMm?: number; regionMm?: number; marginSmoothing?: number; sliverMm?: number; smoothMm?: number }
    lid: { closureFraction: number; upperLidHeightMm: number; lowerLidHeightMm: number; overlapMm?: number; followers?: string; gapMm?: number; smoothPasses?: number }
    jaw: { joint: string; dof: number; closers: string[]; openers: string[] }
    missing: { name: string; note: Bilingual }[]
  }
  aus: { aus: { id: string; name: Bilingual; channels: Record<string, number>; jawFraction?: number; missing?: string[]; basis: Sourced }[] }
  pain: { pspi: PainModel['pspi'] & { formula: string }; keyframes: PainModel['keyframes']; mapping: Sourced; timing: PainModel['timing'] }
  emotions?: { emotions: FaceData['expressions'] }
  visemes?: FaceData['visemes'] & { _doc?: unknown }
  sources: { sources: FaceSource[] }
}

export interface FaceReport {
  body: string
  skin: { part: string; vertices: number; headVertices: number; faceVertices: number; faceMeanEdgeMm: number; perRegion: Record<string, { vertices: number; meanEdgeMm: number }> }
  muscles: { id: string; parts: string[]; basis: string; lengthMm: Record<string, number>; pcaVsHintCos: Record<string, number>; asymmetryMm: number | null; skinVertices: Record<string, number> }[]
  unmatched: { id: string; why: string }[]
  eyes: { side: Side; rings: { inner: string; outer: string; innerName: string; outerName: string; namesAgreeWithSize: boolean } | null; fissureMm: { width: number; aperture: number } | null; skinFissureMm: { width: number; aperture: number; centreVsGlobeX: number; upperVsDeep: number | null; lowerVsDeep: number | null; stepUpper: number; stepLower: number } | null }[]
  stomion: { skinY: number; deepY: number | null; differenceMm: number | null }
  deepParts: { considered: number; displaced: number; byTissue: Record<string, number> }
  entries: number
  binBytes: number
  openings: null | { lidClearance: { eye: Side; lid: string; atHalfMm: number; atFullMm: number }[]; rimVertices: number; pouchVertices: number }
  mouth: null | { widthMm: number; foldPasses: Record<string, number>; sealResidualMm: number | null; dentalResidualMm: number | null; incisalEdge: number[] | null; lipParts: string[]; tongue: string | null }
  symmetry: { muscle: string; countL: number; countR: number; meanMmL: number; meanMmR: number; mirroredMeanDiffMm: number }[]
  /** 视位的下颌比例是否按这副身体自己的切牙下降量换算过（见 visemeJawForBody）/ whether the visemes' jaw fractions were converted with this body's own incisor drop (see visemeJawForBody) */
  visemeJaw: VisemeJawReport
}

const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}
const MM = 0.001
/** 小于此值的位移不存 / displacements below this are not stored. */
const EPS = 0.02 * MM

/** 对称 3×3 矩阵的主特征向量（幂迭代，从 `start` 出发，结果确定）。 Principal eigenvector of a symmetric 3×3 (power iteration from `start`; deterministic). */
function principalAxis(pts: V3[], start: V3): V3 {
  const c: V3 = [0, 0, 0]
  for (const p of pts) (c[0] += p[0]), (c[1] += p[1]), (c[2] += p[2])
  c[0] /= pts.length, c[1] /= pts.length, c[2] /= pts.length
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (const p of pts) {
    const d = sub(p, c)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] = m[i * 3 + j]! + d[i]! * d[j]!
  }
  let v = norm(start)
  for (let it = 0; it < 200; it++) {
    const w: V3 = [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]]
    const l = len(w)
    if (l < 1e-20) break
    v = mul(w, 1 / l)
  }
  return v
}

/** 沿 `axis` 两端各 `frac` 顶点的质心：[低端, 高端]。 Centroids of the extreme `frac` of points at both ends along `axis`: [low end, high end]. */
function ends(pts: V3[], axis: V3, frac = 0.15): [V3, V3] {
  const t = pts.map((p) => dot(p, axis))
  const order = t.map((_, i) => i).sort((a, b) => t[a]! - t[b]! || a - b)
  const k = Math.max(1, Math.round(pts.length * frac))
  const mean = (idx: number[]): V3 => {
    const s: V3 = [0, 0, 0]
    for (const i of idx) (s[0] += pts[i]![0]), (s[1] += pts[i]![1]), (s[2] += pts[i]![2])
    return mul(s, 1 / idx.length)
  }
  return [mean(order.slice(0, k)), mean(order.slice(-k))]
}

function meshPoints(m: RawMesh): V3[] {
  const out: V3[] = []
  for (let i = 0; i < m.positions.length; i += 3) out.push([m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!])
  return out
}

/** 面积加权、再平滑 `passes` 遍的顶点法线。 Area-weighted vertex normals, smoothed `passes` times. */
function vertexNormals(m: RawMesh, passes = 2): Float32Array {
  const n = new Float32Array(m.positions.length)
  const p = m.positions, idx = m.indices
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3
    const u: V3 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!], v: V3 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!]
    const f = cross(u, v)
    for (const i of [a, b, c]) (n[i] = n[i]! + f[0]), (n[i + 1] = n[i + 1]! + f[1]), (n[i + 2] = n[i + 2]! + f[2])
  }
  const normalise = (a: Float32Array): void => {
    for (let i = 0; i < a.length; i += 3) {
      const l = Math.hypot(a[i]!, a[i + 1]!, a[i + 2]!) || 1
      ;(a[i] = a[i]! / l), (a[i + 1] = a[i + 1]! / l), (a[i + 2] = a[i + 2]! / l)
    }
  }
  normalise(n)
  let cur = n
  for (let pass = 0; pass < passes; pass++) {
    const next = Float32Array.from(cur)
    for (let t = 0; t < idx.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = idx[t + k]! * 3, b = idx[t + ((k + 1) % 3)]! * 3
        for (let c = 0; c < 3; c++) (next[a + c] = next[a + c]! + cur[b + c]!), (next[b + c] = next[b + c]! + cur[a + c]!)
      }
    }
    normalise(next)
    cur = next
  }
  return cur
}

/** 场函数：皮肤上的位置 ps（深层点为其在皮肤上的投影）、该处皮肤法线 n、点本身的位置 p。 A field: position on the skin `ps` (for a deep point, its projection onto the skin), the skin normal `n` there, and the point's own position `p`. */
type Field = (ps: V3, n: V3, p: V3, deep: boolean) => V3

interface Eye {
  side: Side
  globe: V3
  radius: number
  inner: Part | null
  outer: Part | null
  /** 睑裂上下缘的采样表（按 x）。 Sampled margins of the fissure (by x). */
  margins: { x0: number; step: number; lower: number[]; upper: number[] } | null
  /** 皮肤上的睑裂（皮肤是一张闭合的面，睑裂只是形状）：上下缘，以及缘上台阶的高度。 The fissure on the skin (a closed surface, so the fissure is only a shape): both margins and the height of the step at each. */
  skinMargins: { x0: number; step: number; lower: number[]; upper: number[]; tUp: number[]; tLow: number[]; /** 两睑之间皮肤的二次曲面系数 / coefficients of the quadric through the skin between the lids */ patch: number[] } | null
  /** 名字与环的大小是否一致 / whether the names agree with the ring sizes. */
  sizeAgrees: boolean
}

const tangent = (v: V3, n: V3): V3 => sub(v, mul(n, dot(v, n)))

/**
 * 点到折线的最近点：所在线段的两个端点下标 a、b = a ± 1，a 的权重 ka（b 的权重 1 − ka），以及距离。对 p 连续。
 * The nearest point of a polyline to p: the indices a and b = a ± 1 of the segment's ends, the weight ka of a (1 − ka for b) and the
 * distance. Continuous in p.
 */
function nearestOnPolyline(p: V3, pl: V3[]): { a: number; b: number; ka: number; distance: number } {
  let best = { a: 0, b: Math.min(1, pl.length - 1), ka: 1, distance: Infinity }
  for (let i = 0; i + 1 < pl.length; i++) {
    const e = sub(pl[i + 1]!, pl[i]!), l2 = dot(e, e)
    const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, pl[i]!), e) / l2)) : 0
    const d = len(sub(p, add(pl[i]!, mul(e, t))))
    if (d < best.distance) best = { a: i, b: i + 1, ka: 1 - t, distance: d }
  }
  return best
}

/** 深层的唇部件：名为 Lip，或拆开后的 Upper lip / Lower lip（不含肌肉、牙）。 The deep lip parts: named Lip or, once split, Upper lip / Lower lip (muscles and teeth excluded). */
export const isLipPart = (p: Pick<Part, 'name' | 'tissue'>): boolean => p.tissue !== 'muscle' && p.tissue !== 'tooth' && p.tissue !== 'bone' && /^((upper|lower|superior|inferior) )?lips?$|^lips?,? \(?(upper|lower|superior|inferior)/i.test(p.name.trim())

export interface VisemeJawReport {
  rule: string
  recordedDropMm: Record<string, number> | null
  ownDropMm: Record<string, number> | null
  converted: boolean
  ownMmPerJawFraction: number | null
}

/**
 * 视位的下颌比例（visemes.json 的 jaw）是按 calibration.geometry 里记下的那副几何标定的：jaw = 目标毫米数 / mmPerJawFraction。
 * 这副身体的切牙下降量（用骨架实算，比例 0.05 和 0.1 处）与记下的相差都在 0.05 mm 以内时原样使用；否则（几何变了，例如女性换了新头）
 * 所有视位的 jaw 都乘以 mmPerJawFraction / 自己的每比例毫米数（比例 0.1 处），使切缘的下降量仍是表里的毫米数，视位之间的次序和相等关系不变。
 * 夸张风格（clear）按下颌上限的比例规定（如开口的 a 是上限的一半），不换算；只在它小于换算后的正常值时提到正常值，夸张的不比正常的小。
 * The visemes' jaw fractions (jaw in visemes.json) were calibrated on the geometry recorded under calibration.geometry: jaw = target
 * millimetres / mmPerJawFraction. When this body's incisor drop (computed with the rig at fractions 0.05 and 0.1) is within 0.05 mm of
 * the recorded one at both, they are used as they are; otherwise (the geometry has changed, e.g. the female's new head) they are
 * converted with the body's own millimetres: every jaw is multiplied by mmPerJawFraction / the body's own mm per fraction (at 0.1),
 * so the drop at the incisal edge is still the millimetres of the table and the order and equalities among the visemes are kept. The
 * exaggerated style (clear) is set as a fraction of the jaw's limit (the open a at half of it) and is not converted; only where it
 * falls below the converted normal value is it raised to that, so the exaggerated is never smaller than the normal.
 */
function visemeJawForBody(body: Body, rig: Rig, rigBin: Uint8Array | null | undefined, curated: Curated, jawMax: number): { visemes: NonNullable<Curated['visemes']>['visemes']; report: VisemeJawReport } {
  const list = curated.visemes?.visemes ?? []
  const cal = (curated.visemes as { calibration?: { mmPerJawFraction?: number; geometry?: Record<string, { incisorDropMmAtFraction?: Record<string, number> }> } } | undefined)?.calibration
  const rule = 'kept when the rig-computed incisor drop at jaw fractions 0.05 and 0.1 is within 0.05 mm of calibration.geometry; otherwise every jaw is multiplied by mmPerJawFraction / own mm per fraction (at 0.1); clear kept, raised to the normal value where below it'
  const none: VisemeJawReport = { rule, recordedDropMm: null, ownDropMm: null, converted: false, ownMmPerJawFraction: null }
  const recorded = cal?.geometry?.[body.data.body]?.incisorDropMmAtFraction
  const jawJ = rig.joints.find((j) => j.id === curated.muscles.jaw.joint)
  const lower = body.data.parts.filter((p) => p.tissue === 'tooth' && /lower central.*incisor/i.test(p.name) && body.meshes.has(p.id))
  if (!cal?.mmPerJawFraction || !recorded || recorded['0.05'] === undefined || recorded['0.1'] === undefined || !rigBin || !jawJ || lower.length === 0) return { visemes: list, report: none }
  // 下切牙切缘：下中切牙上最高的顶点（与 tests/face-mouth.test.ts 相同）/ the lower incisal edge: the highest vertex of the lower central incisors (as in tests/face-mouth.test.ts)
  let edge = { part: '', v: -1, y: -Infinity }
  for (const p of lower) {
    const m = body.meshes.get(p.id)!.positions
    for (let i = 0; i < m.length; i += 3) if (m[i + 1]! > edge.y) edge = { part: p.id, v: i / 3, y: m[i + 1]! }
  }
  const dof = curated.muscles.jaw.dof
  const drop = (f: number): number => (edge.y - new Poser(rig, rigBin, { [jawJ.id]: Array.from({ length: dof + 1 }, (_, k) => (k === dof ? f * jawMax : 0)) }).part(edge.part, body.meshes.get(edge.part)!.positions, 'dqs', false)[edge.v * 3 + 1]!) / MM
  const own = { '0.05': +drop(0.05).toFixed(2), '0.1': +drop(0.1).toFixed(2) }
  const same = Math.abs(own['0.05'] - recorded['0.05']) <= 0.05 && Math.abs(own['0.1'] - recorded['0.1']) <= 0.05
  const perFraction = drop(0.1) / 0.1
  const report: VisemeJawReport = { rule, recordedDropMm: { '0.05': recorded['0.05'], '0.1': recorded['0.1'] }, ownDropMm: own, converted: !same, ownMmPerJawFraction: +perFraction.toFixed(2) }
  if (same) return { visemes: list, report }
  const ratio = cal.mmPerJawFraction / perFraction
  const scale = (x: number): number => +(x * ratio).toFixed(4)
  const visemes = list.map((v) => {
    const jaw = scale(v.jaw ?? 0)
    return { ...v, jaw, ...(v.clear ? { clear: { ...v.clear, jaw: Math.max(v.clear.jaw ?? 0, jaw) } } : {}) }
  })
  return { visemes, report }
}

export function buildFace(body: Body, rig: Rig, curated: Curated, log: (m: string) => void, opts: { openings?: FaceOpenings | null; rigBin?: Uint8Array | null } = {}): { face: FaceData; bin: Uint8Array; report: FaceReport } {
  const parts = body.data.parts
  const bodyId = body.data.body
  // —— 皮肤 / the skin ——
  const skinPart = parts.filter((p) => p.tissue === 'skin' && p.system === 'integumentary' && body.meshes.has(p.id)).sort((a, b) => b.triangles - a.triangles || (a.id < b.id ? -1 : 1))[0]
  if (!skinPart) throw new Error('face: no skin part')
  const skin = body.meshes.get(skinPart.id)!
  const skinN = skin.positions.length / 3

  // —— 开口 / the openings ——
  const O = opts.openings && opts.openings.vertexCount === skinN && opts.openings.skin === skinPart.id ? opts.openings : null
  /** 构造物：1 = 睑缘内卷，2 = 口腔袋 / construction aids: 1 = lid rim, 2 = oral pouch. */
  const aid = new Uint8Array(skinN)
  /** 片：1 上唇，2 下唇，3 口角外侧，4 上睑，5 下睑 / sheet: 1 upper lip, 2 lower lip, 3 lateral to the mouth corner, 4 upper lid, 5 lower lid. */
  const sheet = new Uint8Array(skinN)
  if (O) {
    for (const r of O.lidRims) for (const v of r.vertices) aid[v] = 1
    for (const v of [...O.oralPouch.upper, ...O.oralPouch.lower, ...O.oralPouch.seam]) aid[v] = 2
    for (const v of O.sheets.mouthLateral) sheet[v] = 3
    for (const v of O.sheets.mouthUpper) sheet[v] = 1
    for (const v of O.sheets.mouthLower) sheet[v] = 2
    for (const v of [...O.sheets.eyeUpperL, ...O.sheets.eyeUpperR]) sheet[v] = 4
    for (const v of [...O.sheets.eyeLowerL, ...O.sheets.eyeLowerR]) sheet[v] = 5
  }
  // 不含构造物的皮肤三角形：法线、最近点、射线、散度都只用它们（口腔袋在唇后面，会被当成皮肤）
  // the skin triangles without the construction aids: normals, closest points, rays and divergence use only these (the pouch lies behind the lips and would pass for skin)
  const skinTri = O ? Uint32Array.from((() => {
    const out: number[] = []
    for (let t = 0; t < skin.indices.length; t += 3) {
      const a = skin.indices[t]!, b = skin.indices[t + 1]!, c = skin.indices[t + 2]!
      if (!aid[a] && !aid[b] && !aid[c]) out.push(a, b, c)
    }
    return out
  })()) : skin.indices
  const skinMesh: RawMesh = { positions: skin.positions, indices: skinTri }
  const P3 = (v: number): V3 => [skin.positions[v * 3]!, skin.positions[v * 3 + 1]!, skin.positions[v * 3 + 2]!]
  /** 求值时当前的皮肤顶点及其所在的片（深层部件求值时为 −1 / 0）。 The skin vertex being evaluated and its sheet (−1 / 0 while deep parts are evaluated). */
  let curVertex = -1, curSheet = 0
  /** 当前顶点是否用唇的专用法线（唇的两片、口角及其旁边）/ whether the current vertex uses the lips' own normals (both lip sheets, the corners and what lies beside them). */
  let curLip = false
  /** 当前顶点的口周权重（0–1）：口裂附近为 1，向外渐隐 / perioral weight of the current vertex (0–1): 1 near the oral fissure, fading outwards. */
  let curZone = 0

  // —— 肌肉部件按精编条目匹配 / muscle parts matched to the curated entries ——
  const defs = curated.muscles.muscles
  const isMuscle = (p: Part): boolean => p.tissue === 'muscle' && body.meshes.has(p.id)
  const matched = new Map<string, Part[]>()
  const unmatched: FaceReport['unmatched'] = []
  for (const d of defs) {
    const re = new RegExp(d.match, 'i')
    const ps = d.model === 'recess' || d.model === 'corner' ? [] : d.model === 'lip' ? parts.filter((p) => isMuscle(p) && /^orbicularis oris$/i.test(p.name)) : d.model === 'tongue' ? parts.filter((p) => /^tongue$/i.test(p.name) && body.meshes.has(p.id)) : parts.filter((p) => isMuscle(p) && re.test(p.name)).sort((a, b) => (a.id < b.id ? -1 : 1))
    matched.set(d.id, ps)
    if (ps.length === 0 && d.model !== 'recess' && d.model !== 'corner' && d.model !== 'lip') unmatched.push({ id: d.id, why: `no muscle part matches /${d.match}/i` })
  }
  const facial = [...new Set([...matched.entries()].filter(([id]) => defs.find((x) => x.id === id)!.model !== 'tongue').flatMap(([, v]) => v))]
  if (facial.length === 0) throw new Error('face: no facial muscles found')
  // 头部正中矢状面：成对肌肉质心 x 的平均 / midsagittal plane of the head: mean x of the centroids of paired muscles
  let mxS = 0, mxN = 0
  for (const d of defs) {
    const ps = matched.get(d.id)!
    const L = ps.filter((p) => p.side === 'L'), R = ps.filter((p) => p.side === 'R')
    if (L.length !== 1 || R.length !== 1) continue
    mxS += (L[0]!.centroid[0] + R[0]!.centroid[0]) / 2
    mxN++
  }
  const midX = mxN ? mxS / mxN : 0
  const regionMinY = Math.min(...facial.map((p) => p.bbox[1])) - 0.02
  const noPlatysma = facial.filter((p) => !/platysma/i.test(p.name))
  const faceMinY = Math.min(...noPlatysma.map((p) => p.bbox[1])) - 0.01
  const faceMaxY = Math.max(...noPlatysma.map((p) => p.bbox[4]))
  const faceMinZ = Math.min(...noPlatysma.filter((p) => !/frontalis/i.test(p.name)).map((p) => p.bbox[2])) - 0.01

  // 区域内的皮肤子网格，用于最近点和射线查询 / sub-mesh of the skin inside the region, for closest-point and ray queries
  const subIdx: number[] = []
  for (let t = 0; t < skinTri.length; t += 3) {
    const a = skinTri[t]!, b = skinTri[t + 1]!, c = skinTri[t + 2]!
    if (skin.positions[a * 3 + 1]! > regionMinY - 0.03 || skin.positions[b * 3 + 1]! > regionMinY - 0.03 || skin.positions[c * 3 + 1]! > regionMinY - 0.03) subIdx.push(a, b, c)
  }
  const skinSurf = new Surface({ positions: skin.positions, indices: Uint32Array.from(subIdx) })
  // 平滑 6 遍：口裂、睑缘的褶皱里法线很乱，不平滑的话相邻顶点的滑动方向会互相打架，拉出尖刺
  // six smoothing passes: inside the creases at the mouth and the lid margins the normals are erratic, and unsmoothed they make neighbouring vertices slide in conflicting directions and pull out spikes
  const normals = vertexNormals(skinMesh, 6)
  const onSkin = (p: V3): { point: V3; normal: V3; distance: number } => {
    const r = skinSurf.closestFace(p)
    if (!r) return { point: p, normal: [0, 0, 1], distance: Infinity }
    const n: V3 = [0, 0, 0]
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) n[c] = n[c]! + r.bary[k]! * normals[r.verts[k]! * 3 + c]!
    return { point: r.point, normal: norm(n), distance: r.distance }
  }

  /** `c` 周围 `radius` 内皮肤顶点法线的平均：比单点的法线稳（眼周的皮肤很乱）。 Mean normal of the skin vertices within `radius` of `c`: steadier than the normal at one point (the skin round the eyes is rough). */
  const meanNormal = (c: V3, radius: number, fallback: V3): V3 => {
    const n: V3 = [0, 0, 0]
    for (let v = 0; v < skinN; v++) {
      if (Math.hypot(skin.positions[v * 3]! - c[0], skin.positions[v * 3 + 1]! - c[1], skin.positions[v * 3 + 2]! - c[2]) > radius) continue
      ;(n[0] += normals[v * 3]!), (n[1] += normals[v * 3 + 1]!), (n[2] += normals[v * 3 + 2]!)
    }
    return len(n) > 1e-9 ? norm(n) : fallback
  }

  // —— 骨和牙 / bone and teeth ——
  // 硬组织：骨、牙，以及鼻以外的软骨（喉软骨不随表情肌移动，并挡住其内的结构）
  // hard tissue: bone, teeth, and cartilage other than that of the nose (the laryngeal cartilages do not move with the facial muscles and shield what lies inside them)
  const isHard = (p: Part): boolean => p.tissue === 'bone' || p.tissue === 'tooth' || (p.tissue === 'cartilage' && !/nasal|alar/i.test(p.name))
  const hard = parts.filter((p) => isHard(p) && p.bbox[4] > regionMinY && body.meshes.has(p.id))
  const boneSurf = new Surface(mergeMeshes(hard.map((p) => body.meshes.get(p.id)!)))

  // —— 眼 / the eyes ——
  const eyes: Eye[] = []
  const lidCfg = curated.muscles.lid
  const ooculi = parts.filter((p) => isMuscle(p) && /orbicularis oculi/i.test(p.name))
  for (const side of ['L', 'R'] as const) {
    const sgn = side === 'L' ? 1 : -1
    const sclera = parts.filter((p) => /sclera/i.test(p.name) && (p.centroid[0] - midX) * sgn > 0 && body.meshes.has(p.id))[0]
    if (!sclera) continue
    const b = sclera.bbox
    const globe: V3 = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]
    const radius = (b[3] - b[0] + b[4] - b[1]) / 4
    const rings = ooculi.filter((p) => (p.centroid[0] - midX) * sgn > 0).map((p) => {
      const m = body.meshes.get(p.id)!
      let s = 0
      for (let i = 0; i < m.positions.length; i += 3) s += Math.hypot(m.positions[i]! - globe[0], m.positions[i + 1]! - globe[1])
      return { p, r: s / (m.positions.length / 3) }
    }).sort((a, b2) => a.r - b2.r)
    // 按名字取：睑部是贴着睑缘的内环，眶部是外环；名字不全时才退回到按环的大小取
    // chosen by name: the palpebral part is the inner ring at the lid margins, the orbital part the outer ring; ring size is only the fallback when a name is missing
    const named = { inner: rings.find((x) => /palpebral part/i.test(x.p.name))?.p ?? null, outer: rings.find((x) => /orbital part/i.test(x.p.name))?.p ?? null }
    const bySize = { inner: rings.length >= 2 ? rings[0]!.p : null, outer: rings.length >= 1 ? rings[rings.length - 1]!.p : null }
    const use = named.inner && named.outer ? named : bySize
    eyes.push({ side, globe, radius, inner: use.inner, outer: use.outer, sizeAgrees: use.inner === bySize.inner && use.outer === bySize.outer, margins: null, skinMargins: null })
  }
  /** 某 x 处睑裂的下缘和上缘；睑裂之外返回 null。 Lower and upper margin of the fissure at x; null outside it. */
  const marginsAt = (e: Eye, x: number): [number, number] | null => {
    const m = e.margins
    if (!m) return null
    const f = (x - m.x0) / m.step
    if (f < 0 || f > m.lower.length - 1) return null
    const i = Math.min(m.lower.length - 2, Math.floor(f)), t = f - i
    return [m.lower[i]! * (1 - t) + m.lower[i + 1]! * t, m.upper[i]! * (1 - t) + m.upper[i + 1]! * t]
  }

  const eyeReport: FaceReport['eyes'] = []
  for (const e of eyes) {
    // 睑裂：从前方向眼球投射线，没有先碰到眼睑（眼轮匝肌、睑板）的地方就是开着的
    // the fissure: rays cast at the globe from the front; where no lid (orbicularis oculi, tarsal plate) is hit first, the eye is open
    const sgn = e.side === 'L' ? 1 : -1
    // 上睑提肌（及其腱膜）也算眼睑的一层：眼轮匝肌的睑部和眶部是两块相贴的网格，接缝处有极窄的缝，
    // 射线偶尔从缝里穿过、碰到眼球，睑裂就被误量到上睑上方很远处；缝后面正是上睑提肌。
    // the levator palpebrae superioris (and its aponeurosis) counts as a layer of the lid as well: the palpebral and orbital parts of
    // orbicularis oculi are two abutting meshes with a hairline gap at their seam, and a ray now and then slips through it to the
    // globe, putting the fissure far above the upper lid; the levator lies right behind that seam.
    const lidParts = parts.filter((p) => body.meshes.has(p.id) && (/orbicularis oculi/i.test(p.name) || /tarsal plate/i.test(p.name) || /levator palpebrae/i.test(p.name)) && (p.centroid[0] - midX) * sgn > 0)
    let rep: FaceReport['eyes'][number] = { side: e.side, rings: null, fissureMm: null, skinFissureMm: null }
    if (e.inner && e.outer && e.inner !== e.outer) rep.rings = { inner: e.inner.id, outer: e.outer.id, innerName: e.inner.name, outerName: e.outer.name, namesAgreeWithSize: e.sizeAgrees }
    if (lidParts.length) {
      const lids = new Surface(mergeMeshes(lidParts.map((p) => body.meshes.get(p.id)!)))
      const step = 0.5 * MM, ystep = 0.2 * MM, half = e.radius
      const cols = Math.round((2 * half) / step) + 1
      const lower: number[] = [], upper: number[] = []
      for (let i = 0; i < cols; i++) {
        const x = e.globe[0] - half + i * step
        let lo = Infinity, hi = -Infinity
        for (let y = e.globe[1] - half; y <= e.globe[1] + half; y += ystep) {
          const d2 = e.radius * e.radius - (x - e.globe[0]) ** 2 - (y - e.globe[1]) ** 2
          if (d2 <= 0) continue
          const zs = e.globe[2] + Math.sqrt(d2)
          const z0 = e.globe[2] + 0.06
          const hit = lids.firstHit([x, y, z0], [x, y, zs])
          if (!hit) (lo = Math.min(lo, y)), (hi = Math.max(hi, y))
        }
        lower.push(lo), upper.push(hi)
      }
      // 只保留最长的一段连续开口，再做 3 点平滑 / keep the longest run of open columns, then smooth over 3 columns
      let best = [0, -1], run = -1
      for (let i = 0; i <= cols; i++) {
        const open = i < cols && upper[i]! > lower[i]!
        if (open && run < 0) run = i
        if (!open && run >= 0) {
          if (i - 1 - run > best[1]! - best[0]!) best = [run, i - 1]
          run = -1
        }
      }
      if (best[1]! - best[0]! >= 4) {
        const lo2: number[] = [], up2: number[] = []
        for (let i = best[0]!; i <= best[1]!; i++) {
          let sl = 0, su = 0, k = 0
          for (let j = Math.max(best[0]!, i - 1); j <= Math.min(best[1]!, i + 1); j++) (sl += lower[j]!), (su += upper[j]!), k++
          lo2.push(sl / k), up2.push(su / k)
        }
        e.margins = { x0: e.globe[0] - half + best[0]! * step, step, lower: lo2, upper: up2 }
        rep.fissureMm = { width: ((best[1]! - best[0]!) * step) / MM, aperture: Math.max(...lo2.map((l, i) => up2[i]! - l)) / MM }
      }
    }
    if (!O) {
      // 皮肤上的睑裂：皮肤是闭合的，上下睑之间是一片“眼球形”的皮肤，睑缘处有一道台阶。
      // 每一列（x）沿 y 看前表面的深度：自下而上，前跳最陡处是上睑缘，后跳最陡处是下睑缘。
      // The fissure on the skin: the skin is closed, with a globe-shaped patch between the lids and a step at each margin.
      // In every column (x) the depth of the front surface is followed along y: going up, the steepest forward jump is the upper
      // margin and the steepest backward jump the lower margin.
      const z = (x: number, y: number): number | null => {
        const h = skinSurf.firstHit([x, y, e.globe[2] + 0.08], [x, y, e.globe[2] - 0.02])
        return h ? e.globe[2] + 0.08 - h.distance : null
      }
      // 两睑之间那片皮肤比上下睑都凹进去。每一列从睑裂中部出发，沿前表面向上、向下走，
      // 前表面在 0.8 mm 内抬高超过 RISE_UP / RISE_LOW 的地方就是上 / 下睑缘。从正对眼球中心的一列向两侧逐列走，
      // 每列的出发点取上一列睑裂的中点；睑裂窄到 1.2 mm 以下、或出发点一下子浅了 1.5 mm（走出了眦部）就停。
      // 深层睑裂只提供出发的高度，不用它的左右位置：皮肤上的眼和深层的眼球左右可以差好几毫米。
      // The skin between the lids is recessed behind both lids. In each column the front surface is followed up and down from the
      // middle of the fissure; where the surface rises by more than RISE_UP / RISE_LOW within 0.8 mm, that is the upper / lower
      // margin. Columns are walked outwards from the one in front of the globe centre, each starting at the middle of the previous
      // column's fissure, and the walk stops where the fissure is under 1.2 mm tall or the start point is suddenly 1.5 mm shallower
      // (past the canthus). The deep fissure only supplies the starting height, not its left–right position: the eye on the skin and
      // the deep globe can be several millimetres apart sideways.
      const RISE_UP = 0.5 * MM, RISE_LOW = 0.3 * MM
      const dm = e.margins
      const step = 0.5 * MM, half = 26 * MM, cols = Math.round((2 * half) / step) + 1
      const lower: number[] = new Array<number>(cols).fill(NaN), upper: number[] = new Array<number>(cols).fill(NaN), tUp: number[] = new Array<number>(cols).fill(NaN), tLow: number[] = new Array<number>(cols).fill(NaN)
      const column = (x: number, y0: number): { lo: number; up: number; z0: number } | null => {
        const z0 = z(x, y0)
        if (z0 === null) return null
        const walk = (dir: number, rise: number): number | null => {
          // 台阶：0.8 mm 的行程内前表面抬高超过 rise / a step: the front surface rising by more than `rise` within 0.8 mm of travel
          const hist = [z0]
          for (let k = 1; k <= 60; k++) {
            const zz = z(x, y0 + dir * k * 0.2 * MM)
            if (zz === null) return null
            if (zz - hist[Math.max(0, hist.length - 4)]! > rise) return y0 + dir * (k - 2) * 0.2 * MM
            hist.push(zz)
          }
          return null
        }
        const up = walk(1, RISE_UP), lo = walk(-1, RISE_LOW)
        return up === null ? null : { lo: lo ?? NaN, up, z0 }
      }
      if (dm) {
        const mid = dm.lower.length >> 1
        const xAt = (i: number): number => e.globe[0] - half + i * step
        const start = Math.round(half / step)
        const c0 = column(xAt(start), (dm.lower[mid]! + dm.upper[mid]!) / 2)
        if (c0 && !Number.isNaN(c0.lo)) {
          // 走两遍：第一遍不加“向两眦收拢”的限制，只为找到睑裂最高的一列；第二遍从那一列出发，加上限制。
          // Two passes: the first, without the tapering rule, only finds the tallest column; the second starts from that column with the rule.
          const walkOut = (i0: number, first: { lo: number; up: number; z0: number }, taper: boolean, visit: (i: number, c: { lo: number; up: number; z0: number }) => void): void => {
            visit(i0, first)
            const ap0 = first.up - first.lo
            for (const dir of [1, -1]) {
              let prev = first, least = ap0
              for (let i = i0 + dir; i >= 0 && i < cols && Math.abs(i - start) * step <= 24 * MM; i += dir) {
                const c = column(xAt(i), (prev.lo + prev.up) / 2)
                // 出发点比正中一列浅 3 mm 以上（上了鼻梁）或深 12 mm 以上（绕到了面侧）也停 / also stop where the start point is over 3 mm shallower than in the first column (up the nose) or over 12 mm deeper (round the side of the face)
                if (!c || c.z0 - prev.z0 > 1.5 * MM || c.z0 - c0.z0 > 3 * MM || c.z0 - c0.z0 < -12 * MM) break
                // 下睑缘在外侧常常平得没有台阶：沿用上一列的 / laterally the lower margin often flattens out with no step: the previous column's is kept
                if (Number.isNaN(c.lo) || c.lo < prev.lo - 0.6 * MM) c.lo = prev.lo
                const ap = c.up - c.lo
                if (ap < 1.2 * MM || ap > 15 * MM) break
                // 睑裂向两眦收拢：收窄之后不得再变宽 / the fissure tapers towards the canthi: it may not widen again once it has narrowed
                if (taper && ap > least + 0.8 * MM) break
                least = Math.min(least, ap)
                visit(i, c)
                prev = c
              }
            }
          }
          let iMax = start, cMax = c0
          walkOut(start, c0, false, (i, c) => {
            if (c.up - c.lo > cMax.up - cMax.lo) (iMax = i), (cMax = c)
          })
          walkOut(iMax, cMax, true, (i, c) => {
            ;(lower[i] = c.lo), (upper[i] = c.up)
          })
          for (let i = 0; i < cols; i++) if (!Number.isNaN(upper[i]!)) (tUp[i] = 0), (tLow[i] = 0)
        }
      }
      let best = [0, -1], run = -1
      for (let i = 0; i <= cols; i++) {
        const open = i < cols && !Number.isNaN(upper[i]!)
        if (open && run < 0) run = i
        if (!open && run >= 0) {
          if (i - 1 - run > best[1]! - best[0]!) best = [run, i - 1]
          run = -1
        }
      }
      if (best[1]! - best[0]! >= 8) {
        // 5 列滑动中位数去掉离群的列，再做 5 列平均 / a 5-column running median removes outlier columns, then a 5-column mean
        const cut = (a: number[]): number[] => a.slice(best[0]!, best[1]! + 1)
        const med = (a: number[]): number[] => a.map((_, i) => {
          const w = a.slice(Math.max(0, i - 2), Math.min(a.length, i + 3)).sort((p, q) => p - q)
          return w[w.length >> 1]!
        })
        const avg = (a: number[]): number[] => a.map((_, i) => {
          let sum = 0, k = 0
          for (let j = Math.max(0, i - 2); j <= Math.min(a.length - 1, i + 2); j++) (sum += a[j]!), k++
          return sum / k
        })
        const lo = avg(med(cut(lower))), up = avg(med(cut(upper)))
        const x0 = e.globe[0] - half + best[0]! * step
        // 两睑之间那片皮肤的二次曲面拟合：z = c0 + c1·u + c2·v + c3·u² + c4·u·v + c5·v²（u、v 为相对眼球中心的 x、y）
        // a quadric fitted to the skin patch between the lids: z = c0 + c1·u + c2·v + c3·u² + c4·u·v + c5·v² (u, v are x, y relative to the globe centre)
        const A: number[][] = Array.from({ length: 6 }, () => new Array<number>(7).fill(0))
        let n = 0
        for (let i = 0; i < lo.length; i++) {
          const x = x0 + i * step
          for (let y = lo[i]! + 0.8 * MM; y <= up[i]! - 0.8 * MM; y += 0.5 * MM) {
            const zz = z(x, y)
            if (zz === null) continue
            const u = x - e.globe[0], v = y - e.globe[1]
            const row = [1, u, v, u * u, u * v, v * v, zz - e.globe[2]]
            for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) A[r]![c] = A[r]![c]! + row[r]! * row[c]!
            n++
          }
        }
        let patch: number[] | null = null
        if (n >= 30) {
          // 高斯消元（列主元）/ Gaussian elimination with partial pivoting
          const scale = [1, 1e2, 1e2, 1e4, 1e4, 1e4]
          for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) A[r]![c] = A[r]![c]! * scale[r]! * (c < 6 ? scale[c]! : 1)
          let ok = true
          for (let c = 0; c < 6 && ok; c++) {
            let piv = c
            for (let r = c + 1; r < 6; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r
            if (Math.abs(A[piv]![c]!) < 1e-12) ok = false
            ;[A[c], A[piv]] = [A[piv]!, A[c]!]
            for (let r = 0; r < 6; r++) {
              if (r === c) continue
              const f = A[r]![c]! / A[c]![c]!
              for (let k = c; k < 7; k++) A[r]![k] = A[r]![k]! - f * A[c]![k]!
            }
          }
          if (ok) patch = A.map((row, r) => (row[6]! / row[r]!) * scale[r]!)
        }
        if (patch) {
          e.skinMargins = { x0, step, lower: lo, upper: up, tUp: avg(med(cut(tUp))), tLow: avg(med(cut(tLow))), patch }
          const sm = e.skinMargins
          const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length
          const k = sm.lower.reduce((bi, l, i) => (sm.upper[i]! - l > sm.upper[bi]! - sm.lower[bi]! ? i : bi), 0)
          const xk = x0 + k * step
          const dmk = marginsAt(e, xk)
          rep.skinFissureMm = { width: +(((lo.length - 1) * step) / MM).toFixed(1), aperture: +((sm.upper[k]! - sm.lower[k]!) / MM).toFixed(2), centreVsGlobeX: +((x0 + ((lo.length - 1) * step) / 2 - e.globe[0]) / MM).toFixed(2), upperVsDeep: dmk ? +((sm.upper[k]! - dmk[1]) / MM).toFixed(2) : null, lowerVsDeep: dmk ? +((sm.lower[k]! - dmk[0]) / MM).toFixed(2) : null, stepUpper: +(mean(sm.tUp) / MM).toFixed(2), stepLower: +(mean(sm.tLow) / MM).toFixed(2) }
        }
      }
    }
    if (O) {
      // 皮肤有真实的睑裂：上下缘直接取清单里的睑缘环，按 x 每 0.5 mm 采样
      // the skin has a real fissure: both margins are the lid-margin loops of the manifest, sampled every 0.5 mm in x
      const up = (e.side === 'L' ? O.margins.upperLidL : O.margins.upperLidR).map(P3), lo = (e.side === 'L' ? O.margins.lowerLidL : O.margins.lowerLidR).map(P3)
      const yAt = (pl: V3[], x: number): number => {
        // 沿环找跨过 x 的线段；有多段时取平均 / the loop segments spanning x; their mean when several do
        let sum = 0, k = 0
        for (let i = 0; i + 1 < pl.length; i++) {
          const a = pl[i]!, b = pl[i + 1]!
          if ((a[0] - x) * (b[0] - x) > 0 || a[0] === b[0]) continue
          sum += a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])
          k++
        }
        return k ? sum / k : NaN
      }
      const xa = Math.min(up[0]![0], up[up.length - 1]![0]), xb = Math.max(up[0]![0], up[up.length - 1]![0])
      const step = 0.5 * MM, n = Math.floor((xb - xa) / step) + 1
      const lower: number[] = [], upper: number[] = []
      for (let i = 0; i < n; i++) {
        const x = Math.min(xb - 1e-7, Math.max(xa + 1e-7, xa + i * step))
        const u = yAt(up, x), l = yAt(lo, x)
        upper.push(Number.isNaN(u) ? (upper[upper.length - 1] ?? up[0]![1]) : u)
        lower.push(Number.isNaN(l) ? (lower[lower.length - 1] ?? lo[0]![1]) : l)
      }
      e.skinMargins = { x0: xa, step, lower, upper, tUp: lower.map(() => 0), tLow: lower.map(() => 0), patch: [] }
      const k = lower.reduce((bi, l, i) => (upper[i]! - l > upper[bi]! - lower[bi]! ? i : bi), 0)
      const dmk = marginsAt(e, xa + k * step)
      rep.skinFissureMm = { width: +((xb - xa) / MM).toFixed(1), aperture: +((upper[k]! - lower[k]!) / MM).toFixed(2), centreVsGlobeX: +(((xa + xb) / 2 - e.globe[0]) / MM).toFixed(2), upperVsDeep: dmk ? +((upper[k]! - dmk[1]) / MM).toFixed(2) : null, lowerVsDeep: dmk ? +((lower[k]! - dmk[0]) / MM).toFixed(2) : null, stepUpper: 0, stepLower: 0 }
    }
    eyeReport.push(rep)
  }
  const eyeY = eyes.length ? eyes.reduce((s, e) => s + e.globe[1], 0) / eyes.length : faceMaxY
  // 上、下睑缘的高度：深层的（睑部肌肉网格）和皮肤上的各一套；皮肤上的眼和深层的眼可以差几毫米
  // heights of the upper and lower lid margins, one pair for the deep layer (lid muscle meshes) and one for the skin; the eye on the skin and the deep eye can differ by millimetres
  const lidLevels = (pick: (e: Eye) => { lower: number[]; upper: number[] } | null): { top: number; bottom: number } => {
    const tops: number[] = [], bottoms: number[] = []
    for (const e of eyes) {
      const m = pick(e)
      if (!m) continue
      tops.push(Math.max(...m.upper)), bottoms.push(Math.min(...m.lower))
    }
    return tops.length ? { top: tops.reduce((a, b) => a + b, 0) / tops.length, bottom: bottoms.reduce((a, b) => a + b, 0) / bottoms.length } : { top: eyeY + 5 * MM, bottom: eyeY - 5 * MM }
  }
  const lidDeep = lidLevels((e) => e.margins)
  const lidSkin = lidLevels((e) => e.skinMargins ?? e.margins)
  // —— 口裂 / the oral fissure ——
  const oris = parts.filter((p) => isMuscle(p) && /^orbicularis oris$/i.test(p.name))[0] ?? null
  // 深层的唇：一个部件（"Lip"）或拆开的两个（上唇、下唇）；按名字找，不按 id / the deep lips: one part ("Lip") or two after the split (upper lip, lower lip); found by name, never by id
  const lipParts = parts.filter((p) => isLipPart(p) && body.meshes.has(p.id)).sort((a, b) => (a.id < b.id ? -1 : 1))
  const lipPart = lipParts.length === 1 ? lipParts[0]! : null
  let deepSt: number | null = null
  if (lipParts.length >= 2) {
    // 两个部件：正中两旁 ±10 mm 内，上面那个的最低点和下面那个的最高点之间 / two parts: within ±10 mm of the midline, between the lowest point of the upper one and the highest of the lower one
    const sorted = [...lipParts].sort((a, b) => b.centroid[1] - a.centroid[1])
    const ext = (p: Part, pick: (a: number, b: number) => number, start: number): number => {
      const m = body.meshes.get(p.id)!.positions
      let v = start
      for (let i = 0; i < m.length; i += 3) if (Math.abs(m[i]! - midX) < 10 * MM) v = pick(v, m[i + 1]!)
      return v
    }
    const lo = ext(sorted[0]!, Math.min, Infinity), hi = ext(sorted[sorted.length - 1]!, Math.max, -Infinity)
    if (Number.isFinite(lo) && Number.isFinite(hi)) deepSt = (lo + hi) / 2
  }
  if (lipPart) {
    // 深层：正中附近从前方投射线，唇部件上下两片之间打不到的那一段的中点
    // deep: rays from the front near the midline; the middle of the gap between the two lips of the lip part
    const lip = new Surface(body.meshes.get(lipPart.id)!)
    const b = lipPart.bbox
    let bestLo = 0, bestLen = 0, run = NaN
    for (let y = b[1]; y <= b[4] + 1e-9; y += 0.1 * MM) {
      // 正中线上两唇常常连在一起，所以看正中两旁的四列：少于三列打到唇就算口裂
      // at the midline the lips are often fused, so four columns beside it are used: fewer than three hits counts as the fissure
      let hits = 0
      for (const dx of [-8, -4, 4, 8]) if (lip.firstHit([midX + dx * MM, y, b[5] + 0.05], [midX + dx * MM, y, b[2] - 0.02])) hits++
      const hit = hits >= 3
      if (!hit && Number.isNaN(run)) run = y
      if (hit && !Number.isNaN(run)) {
        if (run > b[1] + 0.5 * MM && y - run > bestLen) (bestLen = y - run), (bestLo = run)
        run = NaN
      }
    }
    if (bestLen > 0) deepSt = bestLo + bestLen / 2
  }
  // 皮肤：正中线的前表面轮廓上，两唇之间最凹的一点（在深层口裂上下 5 mm 内找；没有唇部件时在口轮匝肌范围内找）
  // skin: on the midline profile of the front surface, the deepest point between the lips (searched within 5 mm of the deep fissure, or within orbicularis oris when there is no lip part)
  const stLo = deepSt !== null ? deepSt - 5 * MM : oris ? oris.bbox[1] + (oris.bbox[4] - oris.bbox[1]) * 0.3 : faceMinY
  const stHi = deepSt !== null ? deepSt + 5 * MM : oris ? oris.bbox[4] - (oris.bbox[4] - oris.bbox[1]) * 0.3 : faceMinY + 0.03
  const profile: { y: number; z: number }[] = []
  for (let y = stLo - 6 * MM; y <= stHi + 6 * MM; y += 0.25 * MM) {
    const h = skinSurf.firstHit([midX, y, 1], [midX, y, -1])
    if (h) profile.push({ y, z: 1 - h.distance })
  }
  let skinSt = (stLo + stHi) / 2
  {
    // 凹陷程度 = 上下两侧各自最突出的点连线之下的深度 / concavity = depth below the chord between the most prominent points above and below
    let bestDepth = -Infinity
    for (let i = 0; i < profile.length; i++) {
      const q = profile[i]!
      if (q.y < stLo || q.y > stHi) continue
      let up = -Infinity, dn = -Infinity
      for (const r of profile) {
        if (r.y > q.y && r.y < q.y + 6 * MM) up = Math.max(up, r.z)
        if (r.y < q.y && r.y > q.y - 6 * MM) dn = Math.max(dn, r.z)
      }
      const depth = Math.min(up, dn) - q.z
      if (depth > bestDepth) (bestDepth = depth), (skinSt = q.y)
    }
  }

  if (O) skinSt = P3(O.margins.upperLip[O.margins.upperLip.length >> 1]!)[1]
  // 口角轴到正中的距离：唇部件（没有则口轮匝肌的 0.8）的半宽加 3 mm / distance of the modiolus from the midline: half-width of the lip part (or 0.8 of orbicularis oris) plus 3 mm
  const lipBox = lipParts.length ? [Math.min(...lipParts.map((p) => p.bbox[0])), Math.max(...lipParts.map((p) => p.bbox[3]))] : null
  const modiolusOffset = O ? (Math.abs(P3(O.points.mouthCornerL)[0] - midX) + Math.abs(P3(O.points.mouthCornerR)[0] - midX)) / 2 + 3 * MM : lipBox ? (lipBox[1]! - lipBox[0]!) / 2 + 3 * MM : oris ? ((oris.bbox[3] - oris.bbox[0]) / 2) * 0.8 + 3 * MM : null

  // 皮肤上两唇相贴的那道褶：每一列（x）前表面最凹处，从正中向两侧逐列跟踪
  // the crease where the lips meet on the skin: the deepest point of the front surface in each column (x), tracked outwards from the midline
  const lipCreaseOpen = (): { W: number; stepX: number; n: number; mid: number; crease: number[]; zAt: (x: number, y: number) => number | null } => {
    // 皮肤有真实的口裂：那道线就是上唇缘 / the skin has a real oral fissure: the line is the upper lip margin
    const pl = O!.margins.upperLip.map(P3)
    const W = (modiolusOffset ?? 25 * MM) - 3 * MM
    const stepX = 0.5 * MM, n = Math.round((2 * W) / stepX) + 1, mid = n >> 1
    const crease: number[] = []
    for (let i = 0; i < n; i++) {
      const x = midX + (i - mid) * stepX
      let y = x < pl[0]![0] ? pl[0]![1] : pl[pl.length - 1]![1]
      for (let k = 0; k + 1 < pl.length; k++) {
        const a = pl[k]!, b = pl[k + 1]!
        if (x >= a[0] && x <= b[0] && b[0] > a[0]) y = a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])
      }
      crease.push(y)
    }
    return { W, stepX, n, mid, crease, zAt: () => null }
  }
  const lipCrease = O ? lipCreaseOpen() : (() => {
    const W = (modiolusOffset ?? 25 * MM) - 3 * MM
    const stepX = 0.5 * MM, n = Math.round((2 * W) / stepX) + 1, mid = n >> 1
    const crease = new Array<number>(n).fill(NaN)
    const zAt = (x: number, y: number): number | null => {
      const h = skinSurf.firstHit([x, y, 1], [x, y, -1])
      return h ? 1 - h.distance : null
    }
    const deepest = (x: number, y0: number, win: number): number => {
      let by = y0, bz = Infinity
      for (let y = y0 - win; y <= y0 + win + 1e-9; y += 0.1 * MM) {
        const zz = zAt(x, y)
        if (zz !== null && zz < bz) (bz = zz), (by = y)
      }
      return by
    }
    crease[mid] = deepest(midX, skinSt, 1.5 * MM)
    for (const dir of [1, -1]) for (let i = mid + dir; i >= 0 && i < n; i += dir) crease[i] = deepest(midX + (i - mid) * stepX, crease[i - dir]!, 0.6 * MM)
    return { W, stepX, n, mid, crease, zAt }
  })()
  /** 皮肤上某 x 处口裂的高度（超出口角的地方取末端的值）。 Height of the oral fissure on the skin at x (the end value beyond the corners of the mouth). */
  const stomionAt = (x: number): number => {
    const f = Math.min(lipCrease.n - 1, Math.max(0, (x - midX) / lipCrease.stepX + lipCrease.mid))
    const i = Math.min(lipCrease.n - 2, Math.floor(f)), t = f - i
    return lipCrease.crease[i]! * (1 - t) + lipCrease.crease[i + 1]! * t
  }

  // —— 口角的交接 / the hand-over round the mouth corners ——
  // 上唇肌和下唇肌的场不再按“上片 / 下片”一刀切开，而是按绕口角的角度坐标做单位分解：
  //   θ = atan2(v, u)，u 是到口角的外侧距离（口角内侧为负），v 是高出口裂的高度（上唇片取正、下唇片取负）；
  //   上唇份额 = 0.5 + 0.5 · S(θ) · ρ(r)，S 在 |θ| ≥ saturationDeg 处饱和为 ±1，ρ 在离口角 handoverMm 内从 0 升到 1。
  // 口角本身各得一半；沿口裂向内，上下唇缘的份额逐渐分开到 1 和 0；口角外侧的颊部按角度平滑过渡。
  // The fields of upper-lip and lower-lip muscles are no longer cut apart by sheet but partitioned in an angular coordinate about the
  // corner: θ = atan2(v, u), u the lateral distance from the corner (negative medial to it) and v the height above the fissure
  // (positive on the upper-lip sheet, negative on the lower); upper share = 0.5 + 0.5 · S(θ) · ρ(r), with S saturating at ±1 for
  // |θ| ≥ saturationDeg and ρ rising from 0 to 1 within handoverMm of the corner. The corner itself takes half of each; along the
  // fissure the shares of the two margins part gradually to 1 and 0; lateral to the corner the cheek blends smoothly by angle.
  const cornerCfg = curated.muscles.corner ?? { handoverMm: 8, saturationDeg: 60, foldPasses: 40, minAreaRatio: 0.3, maxAreaRatio: 3.5, zoneMm: 16 }
  const cornerL: V3 | null = O ? P3(O.points.mouthCornerL) : null, cornerR: V3 | null = O ? P3(O.points.mouthCornerR) : null
  const upperShare = (p: V3, sh: number): number => {
    const left = p[0] >= midX
    const C = left ? cornerL! : cornerR!
    const u = (left ? 1 : -1) * (p[0] - C[0])
    let v = p[1] - stomionAt(p[0])
    if (sh === 1) v = Math.max(Math.abs(v), 1e-9)
    else if (sh === 2) v = -Math.max(Math.abs(v), 1e-9)
    const th = Math.atan2(v, u)
    const S = Math.sign(th) * smooth(Math.abs(th) / ((cornerCfg.saturationDeg * Math.PI) / 180))
    return 0.5 + 0.5 * S * smooth(len(sub(p, C)) / (cornerCfg.handoverMm * MM))
  }

  // —— 口周的调和插值 / harmonic interpolation round the mouth ——
  // 口裂附近的皮肤网格很密（边长不到 0.5 mm），两唇相贴的面互相只隔零点几毫米。逐顶点算出来的场在这里只要有一点不一致
  // （法线、所在的片、蒙皮权重），相邻顶点就差出几毫米，撕出裂口和碎片。所以这一带不逐顶点求值，而是只规定边界上的值
  // （唇缘、区域的外圈），内部解拉普拉斯方程（余切权重，截到正值，满足极值原理），得到的场在网格上是光滑的。
  // 上下唇缘是不同的顶点，口裂是区域里一道真实的缝，所以上下唇各自在自己的唇缘和外圈之间插值。
  // The skin mesh near the oral fissure is very dense (edges under 0.5 mm) and the contact surfaces of the lips lie a few tenths of
  // a millimetre apart. A field evaluated vertex by vertex there needs only a slight inconsistency (normal, sheet, skin weight)
  // for neighbours to differ by millimetres and tear into cracks and shards. So this zone is not evaluated per vertex: values are
  // prescribed on its boundary only (the lip margins and the outer ring) and Laplace's equation is solved inside (cotangent
  // weights clamped positive, so the maximum principle holds), which gives a field that is smooth on the mesh. Upper and lower
  // margin are different vertices and the fissure is a real slit in the domain, so each lip interpolates between its own margin
  // and the outer ring.
  const PERI_MM = 40
  const peri = O ? (() => {
    const mpts = O.margins.upperLip.map(P3)
    const verts: number[] = [], local = new Int32Array(skinN).fill(-1), dM: number[] = []
    for (let v = 0; v < skinN; v++) {
      if (aid[v]) continue
      const p = P3(v)
      if (Math.abs(p[0] - midX) > 0.08 || Math.abs(p[1] - skinSt) > 0.06 || p[2] < cornerLz0() - 0.06) continue
      const d = nearestOnPolyline(p, mpts).distance
      if (d > PERI_MM * MM) continue
      ;(local[v] = verts.length), verts.push(v), dM.push(d)
    }
    // alias：把下唇缘顶点并到与它重合的上唇缘顶点上（口裂被“焊上”），用于不分上下唇的通道
    // alias: the lower margin vertices merged into the upper ones they coincide with (the fissure "welded"), for channels that do not tell the lips apart
    const adjacency = (alias: Int32Array | null): { nbr: number[][]; wgt: number[][]; mass: Float64Array } => {
    const maps: Map<number, number>[] = verts.map(() => new Map())
    const mass = new Float64Array(verts.length)
    const rp = (i: number): number => (alias && alias[i]! >= 0 ? alias[i]! : i)
    for (let t = 0; t < skinTri.length; t += 3) {
      const tv = [skinTri[t]!, skinTri[t + 1]!, skinTri[t + 2]!]
      if (local[tv[0]!]! < 0 || local[tv[1]!]! < 0 || local[tv[2]!]! < 0) continue
      const q = tv.map(P3)
      const ar = len(cross(sub(q[1]!, q[0]!), sub(q[2]!, q[0]!))) / 6
      for (let k = 0; k < 3; k++) mass[rp(local[tv[k]!]!)] = mass[rp(local[tv[k]!]!)]! + ar
      for (let k = 0; k < 3; k++) {
        // 顶点 k 处的角的余切，加到对边上 / the cotangent of the angle at vertex k goes to the opposite edge
        const u = sub(q[(k + 1) % 3]!, q[k]!), w = sub(q[(k + 2) % 3]!, q[k]!)
        const cr = len(cross(u, w))
        const cot = cr > 1e-14 ? Math.min(8, Math.max(0.05, dot(u, w) / cr)) : 0.05
        const a = rp(local[tv[(k + 1) % 3]!]!), b = rp(local[tv[(k + 2) % 3]!]!)
        if (a === b) continue
        maps[a]!.set(b, (maps[a]!.get(b) ?? 0) + cot)
        maps[b]!.set(a, (maps[b]!.get(a) ?? 0) + cot)
      }
    }
    const nbr = maps.map((m) => [...m.keys()].sort((a, b) => a - b)), wgt = maps.map((m, i) => nbr[i]!.map((j) => m.get(j)!))
    return { nbr, wgt, mass }
    }
    const weldAlias = new Int32Array(verts.length).fill(-1)
    for (let i = 1; i + 1 < O.margins.upperLip.length; i++) weldAlias[local[O.margins.lowerLip[i]!]!] = local[O.margins.upperLip[i]!]!
    const open = adjacency(null), welded = adjacency(weldAlias)
    /**
     * 在 free 标出的顶点上解拉普拉斯方程，其余顶点的值是边界条件；x 就地改写（雅可比预条件的共轭梯度）。
     * Solves Laplace's equation on the vertices flagged in `free`, the values of all others being boundary conditions; x is
     * overwritten in place (conjugate gradients with a Jacobi preconditioner).
     */
    // screen > 0：解 (M + screen · L) x = M · x₀（x₀ 是传入的 x，M 是集中质量）：把 x₀ 在长度 √screen 上抹匀，大尺度的形状不变。
    // screen > 0: solves (M + screen · L) x = M · x₀ (x₀ being the x passed in, M the lumped mass): x₀ is evened over a length of √screen while its large-scale shape is kept.
    const solve = (free: Uint8Array, x: Float64Array, weld = false, screen = 0): void => {
      const { nbr, wgt, mass } = weld ? welded : open
      const kL = screen > 0 ? screen : 1
      const ids: number[] = []
      for (let i = 0; i < verts.length; i++) if (free[i] && nbr[i]!.length) ids.push(i)
      const n = ids.length
      if (n === 0) return
      const pos = new Int32Array(verts.length).fill(-1)
      ids.forEach((i, k) => (pos[i] = k))
      const diag = new Float64Array(n), b = new Float64Array(n)
      for (let k = 0; k < n; k++) {
        const i = ids[k]!
        for (let e = 0; e < nbr[i]!.length; e++) {
          diag[k] = diag[k]! + kL * wgt[i]![e]!
          if (pos[nbr[i]![e]!]! < 0) b[k] = b[k]! + kL * wgt[i]![e]! * x[nbr[i]![e]!]!
        }
        if (screen > 0) (diag[k] = diag[k]! + mass[i]!), (b[k] = b[k]! + mass[i]! * x[i]!)
      }
      const mulA = (src: Float64Array, dst: Float64Array): void => {
        for (let k = 0; k < n; k++) {
          const i = ids[k]!
          let s = diag[k]! * src[k]!
          for (let e = 0; e < nbr[i]!.length; e++) {
            const j = pos[nbr[i]![e]!]!
            if (j >= 0) s -= kL * wgt[i]![e]! * src[j]!
          }
          dst[k] = s
        }
      }
      const u = new Float64Array(n), r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n)
      for (let k = 0; k < n; k++) u[k] = x[ids[k]!]!
      mulA(u, Ap)
      let rz = 0, bn = 0
      for (let k = 0; k < n; k++) (r[k] = b[k]! - Ap[k]!), (z[k] = r[k]! / diag[k]!), (p[k] = z[k]!), (rz += r[k]! * z[k]!), (bn += b[k]! * b[k]! / diag[k]!)
      const stop = Math.max(1e-30, bn * 1e-16)
      for (let it = 0; it < 4000 && rz > stop; it++) {
        mulA(p, Ap)
        let pAp = 0
        for (let k = 0; k < n; k++) pAp += p[k]! * Ap[k]!
        if (pAp <= 0) break
        const al = rz / pAp
        let rz2 = 0
        for (let k = 0; k < n; k++) (u[k] = u[k]! + al * p[k]!), (r[k] = r[k]! - al * Ap[k]!), (z[k] = r[k]! / diag[k]!), (rz2 += r[k]! * z[k]!)
        const be = rz2 / rz
        rz = rz2
        for (let k = 0; k < n; k++) p[k] = z[k]! + be * p[k]!
      }
      for (let k = 0; k < n; k++) x[ids[k]!] = u[k]!
    }
    // 唇缘各顶点沿唇的弧长比例：正中 0，口角 1 / arc-length fraction of every margin vertex along the lip: 0 at the middle, 1 at the corner
    const nM = mpts.length, midI = nM >> 1
    const cum = [0]
    for (let i = 1; i < nM; i++) cum.push(cum[i - 1]! + len(sub(mpts[i]!, mpts[i - 1]!)))
    const sMargin = cum.map((c, i) => (i >= midI ? (c - cum[midI]!) / Math.max(1e-9, cum[nM - 1]! - cum[midI]!) : (cum[midI]! - c) / Math.max(1e-9, cum[midI]!)))
    // 网格里还有一些顶点正好落在唇缘线上、却不在清单的唇缘环里（它们和唇缘顶点组成三点共线的碎三角形）。它们当作唇缘的一部分：
    // 值取所在线段两端唇缘顶点的线性插值（下唇片的取下唇缘，其余取上唇缘）。
    // The mesh also has vertices lying exactly on the margin line without being in the manifest's margin loops (with margin vertices
    // they form collinear sliver triangles). They are treated as part of the margin: their value is the linear interpolant of the
    // margin vertices at both ends of their segment (the lower margin for the lower-lip sheet, the upper for all others).
    const onM = new Set([...O.margins.upperLip, ...O.margins.lowerLip])
    const onLine: { i: number; lower: boolean; a: number; b: number; ka: number }[] = []
    verts.forEach((v, i) => {
      if (onM.has(v) || dM[i]! > 0.15 * MM) return
      const np = nearestOnPolyline(P3(v), mpts)
      onLine.push({ i, lower: sheet[v] === 2, a: np.a, b: np.b, ka: np.ka })
    })
    return { verts, local, dM, solve, sMargin, onLine }
  })() : null
  function cornerLz0(): number {
    return O ? Math.min(P3(O.points.mouthCornerL)[2], P3(O.points.mouthCornerR)[2]) : 0
  }

  // —— 通道 / channels ——
  interface Chan {
    /** 深层部件上预先算好的位移（舌的姿势）/ precomputed displacements on deep parts (tongue poses). */
    deepTables?: Map<string, Map<number, V3>>
    /** 皮肤上预先算好的位移（唇的几何通道），深层的唇跟随它 / the precomputed skin displacement (geometric lip channels), which the deep lips follow. */
    skinTable?: Map<number, V3>
    refJaw?: number
    def: MuscleDef
    id: string
    side: Side
    parts: Part[]
    line: FaceChannel['line']
    basis: FaceChannel['basis']
    excursion: number
    field: Field
  }
  const chans: Chan[] = []
  const report: FaceReport['muscles'] = []
  const mask = (d: MuscleDef, p: V3, deep: boolean): number => {
    let m = 1
    // 皮肤按它自己那道褶（随 x 变化）分上下唇；深层部件按唇部件的口裂 / the skin is split into upper and lower lip along its own crease (which varies with x); deep parts along the fissure of the lip part
    const st = deep ? (deepSt ?? skinSt) : stomionAt(p[0])
    const hw = 1 * MM + 0.8 * Math.max(0, Math.abs(p[0] - midX) - lipCrease.W)
    for (const k of d.mask) {
      // 口裂以内上下唇的分界是锐利的（±1 mm）；出了口角，颊部并没有这条界线，分界逐渐放宽（每向外 1 mm 加宽 0.8 mm），
      // 否则上唇肌和下唇肌的场会在颊部沿口裂的延长线对着拉，撕出一道口角外的裂痕。
      // Between the corners of the mouth the split between the lips is sharp (±1 mm); beyond the corners the cheek has no such boundary
      // and the split widens (0.8 mm per mm outwards); otherwise the fields of upper-lip and lower-lip muscles would pull against each
      // other along the extension of the fissure and tear a line out from the mouth corner.
      // 皮肤有真实口裂时，口裂附近的顶点按所在的片分，不看高度（上下唇缘的顶点位置相同）
      // with a real oral fissure the vertices near it are split by sheet, not by height (upper and lower margin vertices share positions)
      if (k === 'aboveStomion') m *= !deep && O ? upperShare(p, curSheet) : smooth((p[1] - (st - hw)) / (2 * hw))
      else if (k === 'belowStomion') m *= !deep && O ? 1 - upperShare(p, curSheet) : 1 - smooth((p[1] - (st - hw)) / (2 * hw))
      else if (k === 'aboveEye' && !deep && curSheet === 5) m = 0
      else if (k === 'belowEye' && !deep && curSheet === 4) m = 0
      // 眉部肌肉带动的皮肤一直到上睑缘上方（眉下的皮肤是挂在眉上的）；颊部肌肉带动的到下睑缘下方为止
      // brow muscles carry the skin down to just above the upper lid margin (the skin under the brow hangs from it); cheek muscles carry it up to just below the lower lid margin
      else if (k === 'aboveEye') m *= smooth((p[1] - ((deep ? lidDeep : lidSkin).top - 2 * MM)) / (5 * MM))
      else if (k === 'belowEye') m *= 1 - smooth((p[1] - ((deep ? lidDeep : lidSkin).bottom - 7 * MM)) / (6 * MM))
    }
    return m
  }
  const mirror = (p: V3, sgn: number): V3 => [midX + (p[0] - midX) * sgn, p[1], p[2]]
  const cornerDefs: MuscleDef[] = []
  const lidClearance: { eye: Side; lid: string; atHalfMm: number; atFullMm: number }[] = []
  /**
   * 开口皮肤上的眼睑：闭合线 M(t) = 下睑缘 + closureFraction ×（上睑缘 − 下睑缘），t 是沿睑缘的弧长比例；
   * 上睑缘各顶点走到 M，下睑缘各顶点也走到 M。M 到眼球中心的距离不小于该方向上眼球（巩膜、角膜）表面的半径加 lidGapMm，
   * 所以眼睑从角膜之上滑过去。位移场是线性的，半闭时睑缘走在弦上而不是弧上；弦的中点可能比弧低，
   * 所以目标再向外抬高一个弦高，保证半闭时也不进角膜（构建报告给出半闭和全闭时睑缘到眼球表面的最小间隙）。
   * 睑的皮肤（清单里的 eye upper / lower 片）跟随最近的两个睑缘顶点，权重随到睑缘的距离在 upperLidHeightMm /
   * lowerLidHeightMm 内衰减到 0，并保持各自到眼球中心的距离不小于静止时的。
   * Lids on an opened skin: the closure line is M(t) = lower margin + closureFraction × (upper margin − lower margin), t being the
   * arc-length fraction along the margin; every upper-margin vertex travels to M and so does every lower-margin vertex. M is no
   * closer to the globe centre than the radius of the globe surface (sclera, cornea) in that direction plus lidGapMm, so the lid
   * slides over the cornea. The field is linear, so at half closure the margin is on the chord, not the arc; the chord's midpoint
   * can lie lower than the arc, hence the target is lifted outwards by the sagitta so that the half-closed lid stays out of the
   * cornea too (the build report gives the least gap between margin and globe surface at half and full closure).
   * The lid skin (the eye upper / lower sheets of the manifest) follows the two nearest margin vertices, with a weight falling to 0
   * over upperLidHeightMm / lowerLidHeightMm of distance from the margin, and keeps at least its rest distance from the globe centre.
   */
  const lidOpen = (e: Eye, upper: boolean, raise = 0): Map<number, V3> => {
    const out = new Map<number, V3>()
    if (!O) return out
    const L = e.side === 'L'
    const U = (L ? O.margins.upperLidL : O.margins.upperLidR), Lo = (L ? O.margins.lowerLidL : O.margins.lowerLidR)
    const own = upper ? U : Lo
    const sheetList = upper ? (L ? O.sheets.eyeUpperL : O.sheets.eyeUpperR) : (L ? O.sheets.eyeLowerL : O.sheets.eyeLowerR)
    const G = e.globe
    const sgn = L ? 1 : -1
    const globeParts = parts.filter((p) => body.meshes.has(p.id) && /cornea|sclera/i.test(p.name) && (p.centroid[0] - midX) * sgn > 0)
    const globe = globeParts.length ? new Surface(mergeMeshes(globeParts.map((p) => body.meshes.get(p.id)!))) : null
    /** 从眼球中心沿 dir 方向眼球表面的半径 / radius of the globe surface from its centre along dir. */
    const rGlobe = (dir: V3): number => {
      if (!globe) return e.radius
      const far = add(G, mul(dir, 0.05))
      const h = globe.firstHit(far, G)
      return h ? 0.05 - h.distance : e.radius
    }
    const gap = (lidCfg.gapMm ?? 0.4) * MM
    const frac = (loop: number[]): number[] => {
      const t = [0]
      for (let i = 1; i < loop.length; i++) t.push(t[i - 1]! + len(sub(P3(loop[i]!), P3(loop[i - 1]!))))
      return t.map((x) => x / (t[t.length - 1]! || 1))
    }
    const tU = frac(U), tL = frac(Lo)
    const at = (loop: number[], ts: number[], t: number): V3 => {
      let i = 0
      while (i < ts.length - 2 && ts[i + 1]! < t) i++
      const k = ts[i + 1]! > ts[i]! ? Math.min(1, Math.max(0, (t - ts[i]!) / (ts[i + 1]! - ts[i]!))) : 0
      const a = P3(loop[i]!), b = P3(loop[i + 1]!)
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
    }
    const cf = lidCfg.closureFraction
    const ownT = upper ? tU : tL
    const D: V3[] = []
    let minHalf = Infinity, minFull = Infinity
    const lift = (target: V3): V3 => {
      const d = norm(sub(target, G))
      const rho = Math.max(len(sub(target, G)), rGlobe(d) + gap)
      return add(G, mul(d, rho))
    }
    /**
     * 半闭时的弦中点不得进入眼球表面：不够就把目标再向外抬；`lifted` 表示这一步确实抬了。
     * The chord midpoint at half closure must stay outside the globe surface: the target is lifted further if it does not;
     * `lifted` says whether this step did lift it.
     */
    const clearChords = (M0: V3, from: V3[]): { M: V3; lifted: boolean } => {
      let M = M0, lifted = false
      for (let it = 0; it < 4; it++) {
        let lack = 0
        for (const p of from) {
          const mid: V3 = [(p[0] + M[0]) / 2, (p[1] + M[1]) / 2, (p[2] + M[2]) / 2]
          lack = Math.max(lack, rGlobe(norm(sub(mid, G))) + gap - len(sub(mid, G)))
        }
        if (lack <= 0) break
        lifted = true
        M = add(M, mul(norm(sub(M, G)), 2 * lack))
      }
      return { M, lifted }
    }
    /** 一侧眼睑在 t 处原来的闭合目标（含越线量）/ the former closing target of one lid at t (overlap included). */
    const ownTarget = (t: number, isUpper: boolean, p: V3): { M: V3; lifted: boolean } => {
      const lo = at(Lo, tL, t), up = at(U, tU, t)
      let M: V3 = [lo[0] + (up[0] - lo[0]) * cf, lo[1] + (up[1] - lo[1]) * cf, lo[2] + (up[2] - lo[2]) * cf]
      // 上下睑各越过闭合线一点（overlapMm 的一小部分），使缘确实合拢 / each lid goes a little past the line (a fraction of overlapMm) so that the margins really meet
      const dirUL = norm(sub(lo, up))
      M = add(M, mul(dirUL, (isUpper ? 1 : -1) * Math.min(0.25 * MM, (lidCfg.overlapMm ?? 0) * MM)))
      return clearChords(lift(M), [p])
    }
    own.forEach((v, i) => {
      const p = P3(v)
      if (i === 0 || i === own.length - 1) {
        // 眦不动 / the canthi stay
        D.push([0, 0, 0])
        return
      }
      const t = ownT[i]!
      const lo = at(Lo, tL, t), up = at(U, tU, t)
      const dirUL = norm(sub(lo, up))
      let M: V3
      if (raise > 0) {
        // 上睑上提（AU5）：睑缘离开下睑方向上移 raise，中间最多、两眦为 0 / upper-lid raise (AU5): the margin moves away from the lower lid by `raise`, most in the middle and nothing at the canthi
        M = clearChords(lift(add(p, mul(dirUL, -raise * 4 * t * (1 - t)))), [p]).M
      } else {
        const mine = ownTarget(t, upper, p)
        const theirs = ownTarget(t, !upper, upper ? lo : up)
        M = mine.M
        if (mine.lifted || theirs.lifted) {
          // 为让开角膜而把目标向外抬时，上睑抬得多、下睑抬得少，两缘在深度上会差开几毫米、合不拢。
          // 这时两睑走到同一个会合点：闭合线上的点先推到眼球表面之外，再抬到两条弦（上睑缘、下睑缘到它）的中点都在眼球表面之外。
          // When the target is lifted outwards to clear the cornea, the upper lid is lifted much more than the lower, and the margins
          // end millimetres apart in depth and do not meet. Then both lids go to one shared meeting point: the point of the closure
          // line, pushed out of the globe surface and then lifted until the midpoints of both chords (from the upper and from the
          // lower margin to it) lie outside the globe surface.
          const C: V3 = [lo[0] + (up[0] - lo[0]) * cf, lo[1] + (up[1] - lo[1]) * cf, lo[2] + (up[2] - lo[2]) * cf]
          M = clearChords(lift(C), [up, lo]).M
        }
      }
      const mid: V3 = [(p[0] + M[0]) / 2, (p[1] + M[1]) / 2, (p[2] + M[2]) / 2]
      minHalf = Math.min(minHalf, len(sub(mid, G)) - rGlobe(norm(sub(mid, G))))
      minFull = Math.min(minFull, len(sub(M, G)) - rGlobe(norm(sub(M, G))))
      D.push(sub(M, p))
    })
    own.forEach((v, i) => out.set(v, D[i]!))
    lidClearance.push({ eye: e.side, lid: upper ? 'upper' : 'lower', atHalfMm: +(minHalf / MM).toFixed(2), atFullMm: +(minFull / MM).toFixed(2) })
    const h = (upper ? lidCfg.upperLidHeightMm : lidCfg.lowerLidHeightMm) * MM
    const mp = own.map(P3)
    const onMargin = new Set(own)
    // 跟随的不只是清单里的那一片：睑缘 h 以内的所有皮肤顶点（对侧那一片和构造物除外），否则片的边界处会断出一道台阶
    // not only the sheet of the manifest follows: every skin vertex within h of the margin does (the opposite sheet and the construction aids excepted), or a step would break out at the edge of the sheet
    const inSheet = new Set(sheetList)
    const followers: number[] = []
    const other = upper ? 5 : 4
    const side = (p: V3): boolean => {
      // 片以外的顶点：上睑通道只管闭合线以上的，下睑通道只管以下的 / outside the sheets: the upper channel takes vertices above the closure line, the lower one those below
      const m = e.skinMargins
      if (!m) return false
      const f = Math.min(m.lower.length - 1, Math.max(0, (p[0] - m.x0) / m.step)), i = Math.min(m.lower.length - 2, Math.floor(f)), t = f - i
      const yc = (m.lower[i]! * (1 - t) + m.lower[i + 1]! * t) * (1 - cf) + (m.upper[i]! * (1 - t) + m.upper[i + 1]! * t) * cf
      return upper ? p[1] > yc : p[1] < yc
    }
    for (let v = 0; v < skinN; v++) {
      if (aid[v] || sheet[v]! === other || (sheet[v]! >= 1 && sheet[v]! <= 3)) continue
      const p = P3(v)
      if (Math.abs(p[0] - G[0]) > 0.04 || Math.abs(p[1] - G[1]) > 0.04 || p[2] < G[2]) continue
      if (inSheet.has(v) || side(p)) followers.push(v)
    }
    for (const v of followers) {
      if (onMargin.has(v)) continue
      const p = P3(v)
      // 最近的两个睑缘顶点，按距离反比混合 / the two nearest margin vertices, blended by inverse distance
      let a = -1, b = -1, da = Infinity, db = Infinity
      for (let i = 0; i < mp.length; i++) {
        const dd = len(sub(p, mp[i]!))
        if (dd < da) (b = a), (db = da), (a = i), (da = dd)
        else if (dd < db) (b = i), (db = dd)
      }
      const w = 1 - smooth(da / h)
      if (w <= 0) continue
      const ka = db / Math.max(1e-9, da + db), kb = 1 - ka
      const dv: V3 = [(D[a]![0] * ka + D[b]![0] * kb) * w, (D[a]![1] * ka + D[b]![1] * kb) * w, (D[a]![2] * ka + D[b]![2] * kb) * w]
      let q = add(p, dv)
      // 保持到眼球中心的距离不小于静止时的，也不进眼球表面 / keep at least the rest distance from the globe centre, and stay out of the globe surface
      const rho0 = len(sub(p, G))
      if (rho0 < e.radius + 10 * MM) {
        const d = norm(sub(q, G))
        const rho = Math.max(len(sub(q, G)), rho0, p[2] > G[2] ? rGlobe(d) + gap : 0)
        // 修正量在离眼球 6–10 mm 之间渐隐，免得边界处出现一道缝 / the correction fades between 6 and 10 mm from the globe so that no seam shows at its edge
        const k = 1 - smooth((rho0 - e.radius - 6 * MM) / (4 * MM))
        q = add(q, mul(d, (rho - len(sub(q, G))) * k))
      }
      out.set(v, sub(q, p))
    }
    return out
  }
  /** 预先算好的皮肤位移（按顶点），用于开口皮肤上的眼睑和口角通道 / precomputed skin displacements (by vertex) for the lid and corner channels on an opened skin. */
  const tabled = (m: Map<number, V3>): Field => (_q, _n, _p, deep) => (deep ? [0, 0, 0] : (m.get(curVertex) ?? [0, 0, 0]))

  for (const d of defs) {
    const ps = matched.get(d.id)!
    if (d.model === 'recess' && O) continue
    if (d.model === 'corner') {
      if (O) cornerDefs.push(d)
      continue
    }
    if (d.model === 'lip' || d.model === 'tongue') continue
    if (d.model === 'recess') {
      // 口裂内陷：沿皮肤上两唇相贴的那道褶（每一列前表面最凹处，从正中向两侧逐列跟踪）把皮肤向口内推
      // oral recess: along the crease where the lips meet on the skin (the deepest point of the front surface in each column, tracked outwards from the midline) the skin is pushed into the mouth
      const { W, stepX, n, mid, crease, zAt } = lipCrease
      const cP = onSkin([midX, crease[mid]!, 1])
      const back = mul(meanNormal(cP.point, 15 * MM, cP.normal), -1)
      const D = d.excursionMm * MM, band = d.spreadMm * MM
      const field: Field = (_q, _n, p, deep) => {
        if (deep) return [0, 0, 0]
        const f = (p[0] - midX) / stepX + mid
        if (f < 0 || f > n - 1 || p[2] < cP.point[2] - 30 * MM) return [0, 0, 0]
        const i = Math.min(n - 2, Math.floor(f)), t = f - i
        const yc = crease[i]! * (1 - t) + crease[i + 1]! * t
        if (Math.abs(p[1] - yc) > 8 * MM) return [0, 0, 0]
        // 褶里面藏着的顶点（在前表面之后 0.5 mm 以上）整个内陷，不论离褶线多远：否则张口时它们会参差不齐地露出来
        // vertices hidden inside the fold (more than 0.5 mm behind the front surface) are recessed in full however far from the crease line: otherwise they show as ragged shards when the mouth opens
        const zf = zAt(p[0], p[1])
        const hidden = zf === null ? 0 : smooth((zf - p[2] - 0.5 * MM) / (1 * MM))
        const w = Math.max(1 - smooth(Math.abs(p[1] - yc) / band), hidden) * (1 - smooth((Math.abs(p[0] - midX) / W - 0.55) / 0.45))
        return w > 0 ? mul(back, D * w) : [0, 0, 0]
      }
      const c: V3 = [midX, crease[mid]!, cP.point[2]]
      chans.push({ def: d, id: d.id, side: 'M', parts: [], line: { origin: c as Vec3, insertion: c as Vec3, originOnSkin: cP.point as Vec3, insertionOnSkin: cP.point as Vec3 }, basis: 'landmarks', excursion: D, field })
      report.push({ id: d.id, parts: [], basis: 'landmarks', lengthMm: { M: +((2 * W) / MM).toFixed(1) }, pcaVsHintCos: {}, asymmetryMm: null, skinVertices: {} })
      continue
    }
    if (ps.length === 0) continue
    if (d.model === 'linear') {
      const sides = (['L', 'R', 'M'] as const).filter((s) => ps.some((p) => p.side === s))
      // 每侧在“左侧坐标”里量出作用线 / measure the line of each side in left-side coordinates
      const measured = new Map<Side, { o: V3; i: V3; halfWidth: number; cos: number; basis: FaceChannel['basis'] }>()
      for (const s of sides) {
        const sgn = s === 'R' ? -1 : 1
        const pts = ps.filter((p) => p.side === s).flatMap((p) => meshPoints(body.meshes.get(p.id)!)).map((p) => mirror(p, sgn))
        const hint = norm(d.hint ?? [0, 1, 0])
        let axis = principalAxis(pts, hint)
        if (dot(axis, hint) < 0) axis = mul(axis, -1)
        const cos = dot(axis, hint)
        let basis: FaceChannel['basis'] = 'geometry'
        // 主轴与 hint 相差太大（宽而短的片状肌）：改用 hint 的方向 / principal axis too far from the hint (a wide, short sheet): use the hint direction instead
        // 精编数据也可以直接指定用 hint（axis: 'hint'）：网格近似一个团块、主轴没有意义的肌肉（颏肌）
        // the curated data can also demand the hint outright (axis: 'hint'): muscles whose mesh is nearly a blob with no meaningful principal axis (mentalis)
        if (cos < 0.6 || d.axis === 'hint') (axis = hint), (basis = 'geometry+override')
        const [lo, hi] = ends(pts, axis)
        // hint 从活动端指向固定端：高端是起点 / the hint points from the mobile to the fixed end: the high end is the origin
        let o = hi, i = lo
        if (d.axis === 'hint') {
          // 作用线严格沿 hint，穿过网格质心，长度取两端沿 hint 的间距：团块状网格两端的质心会偏向一侧
          // the line runs strictly along the hint through the mesh centroid, its length being the spacing of the two ends along the hint: the end centroids of a blob-like mesh lie off to one side
          const c: V3 = [0, 0, 0]
          for (const p of pts) (c[0] += p[0] / pts.length), (c[1] += p[1] / pts.length), (c[2] += p[2] / pts.length)
          o = add(c, mul(hint, dot(sub(hi, c), hint)))
          i = add(c, mul(hint, dot(sub(lo, c), hint)))
        }
        const e = norm(sub(i, o))
        let s2 = 0
        for (const p of pts) {
          const r = sub(p, o)
          const t = dot(r, e)
          s2 += dot(r, r) - t * t
        }
        measured.set(s, { o, i, halfWidth: 1.5 * Math.sqrt(s2 / pts.length), cos, basis })
      }
      // 对称化：左右两侧取平均 / symmetrise: average of left and right
      let L = measured.get('L'), R = measured.get('R')
      if (L && R && L.basis !== R.basis) {
        // 两侧必须用同一种取法：只要一侧的主轴不可靠，两侧都改用 hint 的方向
        // both sides must be measured the same way: if the principal axis fails on one, both use the hint direction
        for (const s of ['L', 'R'] as const) {
          const sgn = s === 'R' ? -1 : 1
          const pts = ps.filter((p) => p.side === s).flatMap((p) => meshPoints(body.meshes.get(p.id)!)).map((p) => mirror(p, sgn))
          const hint = norm(d.hint ?? [0, 1, 0])
          const [lo, hi] = ends(pts, hint)
          const e = norm(sub(lo, hi))
          let s2 = 0
          for (const p of pts) {
            const r = sub(p, hi)
            const t = dot(r, e)
            s2 += dot(r, r) - t * t
          }
          measured.set(s, { o: hi, i: lo, halfWidth: 1.5 * Math.sqrt(s2 / pts.length), cos: measured.get(s)!.cos, basis: 'geometry+override' })
        }
        ;(L = measured.get('L')), (R = measured.get('R'))
      }
      let asym: number | null = null
      if (L && R) {
        asym = Math.max(len(sub(L.o, R.o)), len(sub(L.i, R.i))) / MM
        const o = mul(add(L.o, R.o), 0.5), i = mul(add(L.i, R.i), 0.5), hw = (L.halfWidth + R.halfWidth) / 2
        const basis = L.basis === 'geometry' && R.basis === 'geometry' ? 'geometry' : 'geometry+override'
        measured.set('L', { ...L, o, i, halfWidth: hw, basis })
        measured.set('R', { ...R, o, i, halfWidth: hw, basis })
      }
      const rep: FaceReport['muscles'][number] = { id: d.id, parts: ps.map((p) => p.id), basis: '', lengthMm: {}, pcaVsHintCos: {}, asymmetryMm: asym === null ? null : +asym.toFixed(2), skinVertices: {} }
      for (const s of sides) {
        const m = measured.get(s)!
        const sgn = s === 'R' ? -1 : 1
        const o = mirror(m.o, sgn), i = mirror(m.i, sgn)
        // project = 'front'：两端从正前方投影到皮肤，而不是取最近点。软组织厚的地方（颏部）最近点会偏到一侧，
        // 把本该向上的拉力变成横向的。
        // project = 'front': both ends are projected onto the skin from straight ahead instead of taking the nearest point. Where the
        // soft tissue is thick (the chin) the nearest point lies off to one side and turns an upward pull into a sideways one.
        const front = (q: V3): V3 | null => {
          const h = skinSurf.firstHit([q[0], q[1], 1], [q[0], q[1], -1])
          return h ? [q[0], q[1], 1 - h.distance] : null
        }
        const os = (d.project === 'front' ? front(o) : null) ?? onSkin(o).point
        const isP = onSkin(i)
        let is = (d.project === 'front' ? front(i) : null) ?? isP.point
        let nI = d.project === 'front' ? onSkin(is).normal : isP.normal
        let basis = m.basis
        if (d.insertAt === 'modiolus' && modiolusOffset !== null) {
          // 皮肤上的口角轴：口角外侧 3 mm，从正前方投影 / the modiolus on the skin: 3 mm lateral to the corner of the mouth, projected from straight ahead
          const x = midX + sgn * modiolusOffset
          const h = skinSurf.firstHit([x, skinSt, 1], [x, skinSt, -1])
          if (h) (is = [x, skinSt, 1 - h.distance]), (nI = onSkin(is).normal), (basis = 'geometry+override')
        }
        const L2 = len(sub(is, os))
        if (L2 < 2 * MM) {
          unmatched.push({ id: `${d.id}_${s}`, why: 'line of action shorter than 2 mm on the skin' })
          continue
        }
        const e = mul(sub(is, os), 1 / L2)
        nI = meanNormal(is, 12 * MM, nI)
        const R2 = m.halfWidth + d.spreadMm * MM, reach = d.reachMm * MM, carry = (d.carryMm ?? 0) * MM, hang = (d.hangMm ?? 0) * MM, E = d.excursionMm * MM
        // 沿唇的延续（开口的皮肤）：见 MuscleDef.lip / the carry along the lip (opened skin): see MuscleDef.lip
        const lipW = (q: V3): number => {
          if (!O || !d.lip || s === 'M') return 0
          const C = sgn > 0 ? cornerL! : cornerR!
          if (q[2] < C[2] - 25 * MM) return 0
          const Wc = Math.abs(C[0] - midX)
          const sN = (sgn * (q[0] - midX)) / Wc
          const v = q[1] - stomionAt(q[0])
          const Rb = (d.lip.bandMm ?? 16) * MM
          if (Math.abs(v) >= Rb) return 0
          const band = (1 - (v * v) / (Rb * Rb)) ** 2
          if (d.lip.profile === 'corner') {
            if (sN <= 0) return 0
            // 口角处为 1，向正中平滑降到 0；口角外侧 6 mm 内交还给作用线自己的场 / 1 at the corner, falling smoothly to 0 at the midline; handed back to the line's own field within 6 mm lateral of the corner
            return (sN <= 1 ? smooth(sN) : 1 - smooth(((sN - 1) * Wc) / (6 * MM))) * band
          }
          return (1 - smooth((Math.abs(sN) - 0.45) / 0.5)) * band * smooth((sgn * (q[0] - midX) + 6 * MM) / (12 * MM))
        }
        const field: Field = (q, n, p, deep) => {
          const r = sub(q, os)
          const t = dot(r, e)
          let wC = 0
          if (t > 0 && t <= L2 + carry + reach) {
            let perp2 = dot(r, r) - t * t
            // 作用线下方的皮肤挂在它上面：向下多带 hang 这么远 / skin below the line hangs from it: it is carried `hang` further down
            if (hang > 0 && r[1] - t * e[1] < 0) perp2 = Math.max(0, Math.sqrt(Math.max(0, perp2)) - hang) ** 2
            if (perp2 < R2 * R2) wC = (t <= L2 ? smooth(t / L2) : 1 - smooth((t - L2 - carry) / reach)) * (1 - perp2 / (R2 * R2)) ** 2
          }
          // 只作用于与活动端同一侧的皮肤（法线方向相近），否则宽阔的颈阔肌会带动项部
          // only skin facing the same way as the mobile end (similar normal) is moved; otherwise the wide platysma would drag the nape
          // 唇的内面（口袋壁）法线是反的：唇这两片不按法线筛 / the inner faces of the lips (the pocket walls) have reversed normals: the two lip sheets are not filtered by normal
          // 口周（curZone）逐渐不按法线筛，过渡是连续的 / round the mouth (curZone) the filter fades out continuously
          const f0 = smooth((dot(n, nI) + 0.2) / 0.7)
          const facing = deep ? f0 : f0 + (1 - f0) * curZone
          // 成对的肌肉在正中线两侧 ±6 mm 内交接，各占一半，免得左右两个场在正中叠成两倍
          // paired muscles hand over within ±6 mm of the midline, half each, so that the left and right fields do not add to double there
          const cross = s === 'M' ? 1 : smooth((sgn * (q[0] - midX) + 6 * MM) / (12 * MM))
          // 唇内（口角内侧、离口裂 6 mm 内）只用沿唇的延续：上下唇必须一起走，否则作用线偏在口裂上方时上唇被多带走一截，
          // 两唇相贴的面就翻出来了 / inside the lips (medial to the corner, within 6 mm of the fissure) only the carry along the lip is used: both
          // lips must travel together, or a line lying above the fissure takes the upper lip further and turns the contact surfaces out
          let inLip = 0
          if (O && d.lip?.profile === 'corner' && s !== 'M') {
            const C = sgn > 0 ? cornerL! : cornerR!
            const sN = (sgn * (q[0] - midX)) / Math.abs(C[0] - midX)
            if (q[2] > C[2] - 25 * MM) inLip = (1 - smooth((sN - 0.85) / 0.3)) * (1 - smooth((Math.abs(q[1] - stomionAt(q[0])) - 6 * MM) / (8 * MM)))
          }
          const wG = Math.max(wC * cross * (1 - inLip), lipW(q))
          if (wG <= 0) return [0, 0, 0]
          const w = wG * facing * mask(d, p, deep)
          if (w <= 0) return [0, 0, 0]
          // 沿皮肤切面滑动整个幅度：切向分量重新归一（皮肤法线几乎与作用线平行时逐渐归零），
          // 否则皮肤离肌肉远、作用线斜穿过软组织时（厚的颊部），位移会被投影吃掉一截。
          // Slide by the full excursion within the tangent plane: the tangential direction is renormalised (fading out where the skin normal
          // is nearly parallel to the line); otherwise, where the skin lies far from the muscle and the line cuts obliquely through
          // soft tissue (a thick cheek), the projection would swallow part of the displacement.
          // 沿唇延续的部分顺着唇走（去掉作用线的前后分量），口角外侧 8 mm 内过渡回作用线本身的方向：
          // 唇贴着牙弓滑动，不会被整体向后拉进牙里。
          // The part carried along the lip travels along the lip (the line's front–back component removed), blending back to the line's own
          // direction within 8 mm lateral of the corner: the lips slide round the dental arch and are not drawn back into the teeth.
          let pull = mul(e, -1)
          if (O && d.lip?.profile === 'corner' && s !== 'M' && !deep) {
            const C = sgn > 0 ? cornerL! : cornerR!
            const lateral = sgn * (q[0] - C[0])
            const f = (1 - smooth(lateral / (8 * MM))) * curZone
            const flat = norm([pull[0], pull[1], 0])
            pull = norm(add(mul(pull, 1 - f), mul(flat, f)))
          }
          const tg = tangent(pull, n)
          const tl = len(tg)
          if (tl < 1e-6) return [0, 0, 0]
          return mul(tg, (E * w * smooth(tl / 0.5)) / tl)
        }
        const id = s === 'M' ? d.id : `${d.id}_${s}`
        const line = { origin: o as Vec3, insertion: i as Vec3, originOnSkin: os as Vec3, insertionOnSkin: is as Vec3 }
        if (d.split) {
          // 内侧、外侧两个通道：同一个场乘以随到正中距离变化的权重，两者之和等于原来的场
          // a medial and a lateral channel: the same field times a weight that varies with distance from the midline; the two add up to the original field
          const sp = d.split
          const lateralShare = (q: V3): number => smooth((Math.abs(q[0] - midX) - (sp.atMm - sp.blendMm) * MM) / (2 * sp.blendMm * MM))
          for (const part of ['medial', 'lateral'] as const) {
            const f: Field = (q, n, p, deep) => mul(field(q, n, p, deep), part === 'lateral' ? lateralShare(q) : 1 - lateralShare(q))
            chans.push({ def: { ...d, id: `${d.id}_${part}`, name: { zh: `${d.name.zh}（${part === 'medial' ? '内侧部' : '外侧部'}）`, en: `${d.name.en}, ${part} part` } }, id: `${d.id}_${part}_${s}`, side: s, parts: ps.filter((p) => p.side === s), line, basis, excursion: E, field: f })
          }
        } else chans.push({ def: d, id, side: s, parts: ps.filter((p) => p.side === s), line, basis, excursion: E, field })
        rep.basis = basis
        rep.lengthMm[s] = +(len(sub(i, o)) / MM).toFixed(1)
        rep.pcaVsHintCos[s] = +m.cos.toFixed(3)
      }
      report.push(rep)
    } else if (d.model === 'sphincter') {
      const E = d.excursionMm * MM
      const sec = d.sectors ?? { inferior: 1, lateral: 1, superior: 1, medial: 1 }
      const make = (side: Side, part: Part, centre: V3, a: number, b: number, s0: number, centreDeep: V3 | null = null): void => {
        const cP = onSkin(centre)
        const cs = cP.point, nC = meanNormal(cP.point, Math.max(a, b), cP.normal)
        // 深层部件以深层的环心为准，皮肤以皮肤上的为准 / deep parts use the deep centre, the skin its own
        const cDeep = centreDeep ? onSkin(centreDeep).point : cs
        const sgn = side === 'R' ? -1 : 1
        const field: Field = (q, n, p, deep) => {
          const c = deep ? cDeep : cs
          const dx = (q[0] - c[0]) * sgn, dy = q[1] - c[1]
          const s = Math.hypot(dx / a, dy / b)
          if (s <= s0 || s >= 1.8) return [0, 0, 0]
          // 从 s0 平缓升到环的外缘，再平缓降到 1.8：越平缓，环的边界越不显眼
          // a gentle rise from s0 to the outer edge of the ring and a gentle fall to 1.8: the gentler, the less the edge of the ring shows
          const prof = s < 1 ? smooth((s - s0) / Math.max(1e-6, 1 - s0)) : 1 - smooth((s - 1) / 0.8)
          const r = Math.hypot(dx, dy) || 1
          // 单个居中的环（口）：两侧都算“外侧” / a single midline ring (the mouth): both sides count as lateral
          const cx = side === 'M' ? Math.abs(dx) / r : dx / r, sy = dy / r
          const w = cx * cx * (cx >= 0 ? sec.lateral : sec.medial) + sy * sy * (sy >= 0 ? sec.superior : sec.inferior)
          const dir = tangent(sub(c, q), n)
          const l = len(dir)
          if (l < 1e-9) return [0, 0, 0]
          // 只作用于与环心同一侧的皮肤 / only skin facing the same way as the centre of the ring
          const f0 = smooth((dot(n, nC) + 0.2) / 0.7)
          const facing = deep ? f0 : f0 + (1 - f0) * curZone
          return mul(dir, (E * prof * w * facing * mask(d, p, deep)) / l)
        }
        chans.push({ def: d, id: side === 'M' ? d.id : `${d.id}_${side}`, side, parts: [part], line: { origin: centre as Vec3, insertion: centre as Vec3, originOnSkin: cs as Vec3, insertionOnSkin: cs as Vec3 }, basis: 'landmarks', excursion: E, field })
      }
      const rep: FaceReport['muscles'][number] = { id: d.id, parts: [], basis: 'landmarks', lengthMm: {}, pcaVsHintCos: {}, asymmetryMm: null, skinVertices: {} }
      if (d.ring === 'outer') {
        // 两侧的环取同样的半径（左右平均）/ both rings get the same radii (mean of left and right)
        const dims = eyes.filter((e) => e.outer).map((e) => {
          const o = e.outer!.bbox, inn = (e.inner ?? e.outer)!.bbox
          return { a: (o[3] - o[0]) / 2, b: (o[4] - o[1]) / 2, ai: (inn[3] - inn[0]) / 2 }
        })
        const a = dims.reduce((s, x) => s + x.a, 0) / Math.max(1, dims.length), b = dims.reduce((s, x) => s + x.b, 0) / Math.max(1, dims.length), ai = dims.reduce((s, x) => s + x.ai, 0) / Math.max(1, dims.length)
        for (const e of eyes) {
          if (!e.outer) continue
          // 皮肤上的环心：皮肤睑裂的中点 / centre on the skin: the middle of the skin's fissure
          const deepC: V3 = [e.globe[0], e.globe[1], e.globe[2] + e.radius]
          const sm = e.skinMargins
          let skinC = deepC
          if (sm) {
            const k = sm.lower.length >> 1
            skinC = [sm.x0 + k * sm.step, (sm.lower[k]! + sm.upper[k]!) / 2, e.globe[2] + e.radius]
          }
          void ai
          make(e.side, e.outer, skinC, a, b, 0.25, deepC)
          rep.parts.push(e.outer.id)
          rep.lengthMm[e.side] = +((2 * a) / MM).toFixed(1)
        }
      } else if (ps[0]) {
        const o = ps[0].bbox
        make('M', ps[0], [midX, skinSt, o[5]], (o[3] - o[0]) / 2, (o[4] - o[1]) / 2, 0.1)
        rep.parts.push(ps[0].id)
        rep.lengthMm.M = +((o[3] - o[0]) / MM).toFixed(1)
      }
      report.push(rep)
    } else {
      const rep: FaceReport['muscles'][number] = { id: d.id, parts: [], basis: 'landmarks', lengthMm: {}, pcaVsHintCos: {}, asymmetryMm: null, skinVertices: {} }
      for (const e of eyes) {
        if (d.lid === 'raise') {
          // 上睑提肌：只在有真实睑裂的皮肤上实现为上睑缘沿眼球上移；深层的眼睑部件不动
          // levator palpebrae superioris: implemented only on a skin with a real fissure, as the upper lid margin rising along the globe; the deep lid parts do not move
          const own = ps.filter((p) => (p.centroid[0] - midX) * (e.side === 'L' ? 1 : -1) > 0)
          if (!O || own.length === 0) {
            unmatched.push({ id: `${d.id}_${e.side}`, why: 'needs a skin with a real palpebral fissure and the levator palpebrae superioris part' })
            continue
          }
          const table = lidOpen(e, true, (d.raiseMm ?? 2.5) * MM)
          lidClearance.pop()
          const c: V3 = [e.globe[0], e.globe[1], e.globe[2] + e.radius]
          chans.push({ def: d, id: `${d.id}_${e.side}`, side: e.side, parts: own, line: { origin: c as Vec3, insertion: c as Vec3, originOnSkin: c as Vec3, insertionOnSkin: c as Vec3 }, basis: 'landmarks', excursion: (d.raiseMm ?? 2.5) * MM, field: tabled(table) })
          rep.parts.push(...own.map((p) => p.id))
          continue
        }
        if (!e.margins || !e.inner) {
          unmatched.push({ id: `${d.id}_${e.side}`, why: 'no palpebral fissure found on the lid meshes' })
          continue
        }
        const upper = d.lid === 'upper'
        const G = e.globe, r0 = e.radius
        const hUp = lidCfg.upperLidHeightMm * MM, hLow = lidCfg.lowerLidHeightMm * MM
        const sm = e.skinMargins
        const openLid = O ? lidOpen(e, upper) : null
        const field: Field = (_q, _n, p, deep) => {
          if (!deep && openLid) return openLid.get(curVertex) ?? [0, 0, 0]
          if (p[2] < G[2] + 2 * MM) return [0, 0, 0]
          if (!deep) {
            // 皮肤：没有开口，只能让睑裂的“形状”变窄——上睑的皮肤滑下来，盖到两睑之间那片眼球形的皮肤上，
            // 那片皮肤本身被压向闭合线。所有顶点保持它在那片皮肤的拟合曲面之上（或之下）的高度：
            // 眼睑顶点原本高出一个睑缘台阶，滑进睑裂后仍高出这么多；藏在褶皱里的顶点仍然藏着。
            // The skin has no opening, so only the SHAPE of the fissure can narrow: upper-lid skin slides down over the globe-shaped
            // patch between the lids, and that patch itself is compressed towards the closure line. Every vertex keeps its height
            // above (or below) the surface fitted to the patch: lid vertices stand proud by the step at the margin and stay so once
            // inside the fissure; vertices hidden in the fold stay hidden.
            if (!sm) return [0, 0, 0]
            const f = (p[0] - sm.x0) / sm.step
            if (f < 0 || f > sm.lower.length - 1) return [0, 0, 0]
            const i = Math.min(sm.lower.length - 2, Math.floor(f)), t = f - i
            const lerp = (a: number[]): number => a[i]! * (1 - t) + a[i + 1]! * t
            const yl = lerp(sm.lower), yu = lerp(sm.upper)
            // 两端各 3 mm 内逐渐收拢，免得眦部出现断崖 / taper over 3 mm at both ends so that no cliff appears at the canthi
            const edge = smooth(Math.min(f, sm.lower.length - 1 - f) * sm.step / (3 * MM))
            const H = yu - yl
            if (H <= 0) return [0, 0, 0]
            const ov = Math.min((lidCfg.overlapMm ?? 0) * MM, H / 2)
            const yc = yl + lidCfg.closureFraction * H + (upper ? -ov : ov)
            let dy = 0
            if (upper) {
              if (p[1] >= yu) dy = -(yu - yc) * (1 - smooth((p[1] - yu) / hUp))
              else if (p[1] > yc) dy = -(p[1] - yc)
            } else {
              if (p[1] <= yl) dy = (yc - yl) * (1 - smooth((yl - p[1]) / hLow))
              else if (p[1] < yc) dy = yc - p[1]
            }
            dy *= edge
            if (dy === 0) return [0, 0, 0]
            const c = sm.patch, u = p[0] - G[0]
            // 曲面只在睑裂的高度范围内有意义，范围之外取边界上的值 / the surface only means something within the height of the fissure; beyond it the value at the boundary is used
            const S = (y: number): number => {
              const v = Math.min(yu + 1 * MM, Math.max(yl - 1 * MM, y)) - G[1]
              return c[0]! + c[1]! * u + c[2]! * v + c[3]! * u * u + c[4]! * u * v + c[5]! * v * v
            }
            // 离那片皮肤很远的顶点（眉、颊）不跟曲面走 / vertices far from the patch (brow, cheek) do not follow the surface
            const near = 1 - smooth((Math.abs(p[2] - G[2] - S(p[1])) - 6 * MM) / (6 * MM))
            return [0, dy, (S(p[1] + dy) - S(p[1])) * near]
          }
          const mg = marginsAt(e, p[0])
          if (!mg) return [0, 0, 0]
          const [yl, yu] = mg
          const H = yu - yl
          if (H <= 0) return [0, 0, 0]
          // 各自的目标线越过闭合线一点，使两睑缘确实合拢 / each lid's target lies a little past the closure line so that the margins really meet
          const ov = Math.min((lidCfg.overlapMm ?? 0) * MM, H / 2)
          const yc = yl + lidCfg.closureFraction * H + (upper ? -ov : ov)
          let dy = 0
          if (upper) {
            if (p[1] >= yu) dy = -(yu - yc) * (1 - smooth((p[1] - yu) / hUp))
            else if (p[1] > yc) dy = -(p[1] - yc)
          } else {
            if (p[1] <= yl) dy = (yc - yl) * (1 - smooth((yl - p[1]) / hLow))
            else if (p[1] < yc) dy = yc - p[1]
          }
          if (dy === 0) return [0, 0, 0]
          const rho = len(sub(p, G))
          dy *= 1 - smooth((rho - r0 - 8 * MM) / (8 * MM))
          let q: V3 = [p[0], p[1] + dy, p[2]]
          // 贴着眼球滑动：保持到眼球中心的距离 / slide over the globe: keep the distance from its centre
          if (rho < r0 + 8 * MM) {
            const l = len(sub(q, G))
            if (l > 1e-9) q = add(G, mul(sub(q, G), rho / l))
          }
          return sub(q, p)
        }
        const mid = e.margins.lower.length >> 1
        const ap = e.margins.upper[mid]! - e.margins.lower[mid]!
        const c: V3 = [G[0], e.margins.lower[mid]! + lidCfg.closureFraction * ap, G[2] + r0]
        chans.push({ def: d, id: `${d.id}_${e.side}`, side: e.side, parts: [e.inner], line: { origin: c as Vec3, insertion: c as Vec3, originOnSkin: onSkin(c).point as Vec3, insertionOnSkin: onSkin(c).point as Vec3 }, basis: 'landmarks', excursion: ap * (upper ? 1 - lidCfg.closureFraction : lidCfg.closureFraction) + (lidCfg.overlapMm ?? 0) * MM, field })
        rep.parts.push(e.inner.id)
        rep.lengthMm[e.side] = +(ap / MM).toFixed(1)
      }
      report.push(rep)
    }
  }
  // —— 口角成形（开口的皮肤）/ mouth-corner shaping (opened skin) ——
  // 骨架里唇缘的下颌权重 w：上唇缘 0、下唇缘 1，直到口角。张口角 θ 时希望口角附近的顶点按份额 t 跟随下颌，
  // t 在口角处为 0.5，沿表面离口角 taper 远处回到 w。静止空间里的位移 d 满足（线性混合蒙皮）
  //   (I + w(R − I)) d = (t − w)(R − I) p，R 是绕颞下颌关节轴转 θmax。
  // 通道的激活 = θ / θmax；位移对激活是线性的，所以中间角度只是近似。
  // In the rig the jaw weight w of the lip margins is 0 on the upper and 1 on the lower, right up to the corners. At an opening θ the
  // vertices near a corner should follow the jaw with share t, 0.5 at the corner and back to w at `taper` from it. The rest-space
  // displacement d satisfies (linear blend skinning) (I + w(R − I)) d = (t − w)(R − I) p, with R the rotation by θmax about the
  // temporomandibular axis. Channel activation = θ / θmax; the displacement is linear in it, so intermediate angles are approximate.
  let cornerTable: Map<number, V3> | null = null
  for (const d of cornerDefs) {
    const jawJ = rig.joints.find((j) => j.id === curated.muscles.jaw.joint)
    const dof = jawJ?.dofs[curated.muscles.jaw.dof]
    const binding = rig.bindings.find((b) => b.part === skinPart.id)
    if (!O || !jawJ || !dof || !opts.rigBin || !binding || binding.offset === undefined) {
      unmatched.push({ id: d.id, why: 'needs the openings, the jaw joint and the skin weights of rig.bin' })
      continue
    }
    const jawIndex = rig.joints.indexOf(jawJ)
    const bin = opts.rigBin, bdv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
    const jawShare = (v: number): number => {
      let w = 0
      const o = binding.offset! + v * 12
      for (let k = 0; k < 4; k++) if (bdv.getUint16(o + k * 2, true) === jawIndex) w += bin[o + 8 + k]! / 255
      return w
    }
    const ax = norm(jawJ.axes[dof.axis] as V3), c = jawJ.center as V3, th = dof.max
    const [x, y, z] = ax, cs = Math.cos(th), sn = Math.sin(th), k1 = 1 - cs
    const R = [cs + x * x * k1, x * y * k1 - z * sn, x * z * k1 + y * sn, y * x * k1 + z * sn, cs + y * y * k1, y * z * k1 - x * sn, z * x * k1 - y * sn, z * y * k1 + x * sn, cs + z * z * k1]
    const corners = [P3(O.points.mouthCornerL), P3(O.points.mouthCornerR)]
    const table = new Map<number, V3>()
    cornerTable = table
    let maxD = 0
    // 下颌份额 t 的场：唇缘上按弧长比例 s 规定（正中 s = 0，口角 s = 1）——张口时两唇缘之间的开度按 gap(s) = (1 − s²)^gapExponent
    // 分布，口角的份额是 shareAtCorner；上唇缘 t = shareAtCorner · (1 − gap)，下唇缘 t = shareAtCorner + (1 − shareAtCorner) · gap。
    // 离口裂 jawRegionMm 以外 t = 骨架的权重 w；两者之间解拉普拉斯方程。骨架的权重在唇缘一行和它旁边差 0.2（张口 0.25 弧度时
    // 就是 4–5 mm 的台阶），这个通道把口周的份额整个换成光滑的 t。
    // The field of jaw share t: prescribed on the margins by arc-length fraction s (0 at the middle, 1 at the corner) — the opening
    // between the margins follows gap(s) = (1 − s²)^gapExponent and the corner's share is shareAtCorner; upper margin
    // t = shareAtCorner · (1 − gap), lower margin t = shareAtCorner + (1 − shareAtCorner) · gap. Beyond jawRegionMm from the
    // fissure t = the rig weight w; Laplace's equation is solved in between. The rig weight differs by 0.2 between the margin row
    // and the row beside it (a step of 4–5 mm at an opening of 0.25 rad); this channel replaces the perioral share by the smooth t.
    const c0 = cornerCfg.shareAtCorner ?? 0.5, gexp = cornerCfg.gapExponent ?? 0.7, regionJ = (cornerCfg.jawRegionMm ?? 30) * MM
    void d.excursionMm
    const nP = peri!.verts.length
    const tShare = new Float64Array(nP), free = new Uint8Array(nP), wRig = new Float64Array(nP)
    // 1. 骨架权重先抹匀（4 mm）：w̃ / the rig weight evened first (over 4 mm): w̃
    peri!.verts.forEach((v, i) => {
      wRig[i] = tShare[i] = jawShare(v)
      free[i] = peri!.dM[i]! < (PERI_MM - 2) * MM ? 1 : 0
    })
    peri!.solve(free, tShare, false, (4 * MM) ** 2)
    // 2. 唇缘上的份额 / the share on the margins
    const nMg = O.margins.upperLip.length
    const tU: number[] = [], tL: number[] = []
    for (let i = 0; i < nMg; i++) {
      const gap = (1 - Math.min(1, peri!.sMargin[i]!) ** 2) ** gexp
      tU.push(c0 * (1 - gap)), tL.push(c0 + (1 - c0) * gap)
    }
    // 3. 其余顶点：t = w̃ + (t_唇缘 − w̃) · B(d)，B = 1 − smooth(d / regionJ)，d 是到唇缘的距离，t_唇缘 取最近的唇缘点（上、下唇缘按绕口角的
    //    份额混合）。B 在 d = 0 处斜率为零：两唇相贴的面和红唇跟着唇缘整体走，过渡落在唇外面的皮肤上（那里的三角形大而规则）。
    //    纯调和插值在口角（缝的尖端）有 √r 型的奇点，唇缘旁 0.5 mm 内就差出 0.7 mm，所以不用它。
    // 3. Everywhere else t = w̃ + (t_margin − w̃) · B(d), B = 1 − smooth(d / regionJ), d being the distance from the margin and t_margin
    //    the value at the nearest margin point (upper and lower margin mixed by the share about the corner). B has zero slope at
    //    d = 0: the contact surfaces and the vermilion travel with their margin as a whole and the transition falls on the skin
    //    outside the lips, where triangles are large and regular. A purely harmonic interpolant has a √r singularity at the corner
    //    (the tip of the slit), 0.7 mm of difference within 0.5 mm of the margin, and is not used for that reason.
    const mptsJ = O.margins.upperLip.map(P3)
    const onMJ = new Set([...O.margins.upperLip, ...O.margins.lowerLip])
    peri!.verts.forEach((v, i) => {
      free[i] = 0
      if (onMJ.has(v)) return
      const p = P3(v), np = nearestOnPolyline(p, mptsJ)
      // 唇的两片各跟自己的唇缘（不混合：混合的过渡带会在 8 mm 内差出 0.3 的份额）；其余顶点按绕口角的角度混合
      // each lip sheet follows its own margin (no mixing: a mixing band would change the share by 0.3 within 8 mm); all other vertices mix by the angle about the corner
      const us = sheet[v] === 1 ? 1 : sheet[v] === 2 ? 0 : upperShare(p, 0)
      const tm = (tU[np.a]! * np.ka + tU[np.b]! * (1 - np.ka)) * us + (tL[np.a]! * np.ka + tL[np.b]! * (1 - np.ka)) * (1 - us)
      const d = peri!.dM[i]!
      const t = tShare[i]! + (tm - tShare[i]!) * (1 - smooth(d / regionJ))
      // 外圈回到骨架本来的权重 / back to the rig's own weight in the outer ring
      const k = smooth((d - regionJ) / ((PERI_MM - 4) * MM - regionJ))
      tShare[i] = t + (wRig[i]! - t) * k
      free[i] = d < (PERI_MM - 4) * MM ? 1 : 0
    })
    for (let i = 0; i < nMg; i++) {
      const iu = peri!.local[O.margins.upperLip[i]!]!, il = peri!.local[O.margins.lowerLip[i]!]!
      ;(tShare[iu] = tU[i]!), (tShare[il] = tL[i]!)
    }
    for (const f of peri!.onLine) {
      const M = f.lower ? tL : tU
      tShare[f.i] = M[f.a]! * f.ka + M[f.b]! * (1 - f.ka)
      free[f.i] = 0
    }
    // 4. 最后在 1.5 mm 上抹匀一遍（唇缘固定）/ finally evened once over 1.5 mm (margins fixed)
    peri!.solve(free, tShare, false, (1.5 * MM) ** 2)
    // 对偶四元数混合下，份额 x 的顶点绕颞下颌轴转过的角度 / under dual-quaternion blending a vertex of share x turns about the temporomandibular axis by this angle
    const phi = (xs: number): number => 2 * Math.atan2(xs * Math.sin(th / 2), 1 - xs + xs * Math.cos(th / 2))
    const rot = (r: V3, a: number): V3 => {
      const ca = Math.cos(a), sa = Math.sin(a), kd = dot(ax, r) * (1 - ca), cr = cross(ax, r)
      return [r[0] * ca + cr[0] * sa + ax[0] * kd, r[1] * ca + cr[1] * sa + ax[1] * kd, r[2] * ca + cr[2] * sa + ax[2] * kd]
    }
    void R
    const items: { v: number; w: number; target: V3; d: V3 }[] = []
    peri!.verts.forEach((v, i) => {
      const w = jawShare(v), t = tShare[i]!
      if (Math.abs(t - w) < 1e-4) return
      const r = sub(P3(v), c)
      items.push({ v, w, target: add(c, rot(r, phi(t))), d: sub(rot(r, phi(t) - phi(w)), r) })
    })
    // 口腔袋：每个袋顶点取它最近的皮肤顶点的份额（10 mm 内完全取，16 mm 处回到自己的权重），按自己的权重换算成位移，
    // 所以袋壁在张口时始终贴在唇的后面；缝不动。
    // The oral pouch: every pouch vertex takes the share of its nearest skin vertex (fully within 10 mm, back to its own weight at
    // 16 mm) and converts it into a displacement with its own weight, so the wall stays right behind the lips as the jaw opens;
    // the seam stays.
    {
      const pp = peri!.verts.map(P3)
      for (const v of [...O.oralPouch.upper, ...O.oralPouch.lower]) {
        const p = P3(v)
        let best = -1, bd = 16 * MM
        for (let i = 0; i < pp.length; i++) {
          const q = pp[i]!
          if (Math.abs(q[0] - p[0]) > bd || Math.abs(q[1] - p[1]) > bd) continue
          const dd = len(sub(q, p))
          if (dd < bd) (bd = dd), (best = i)
        }
        if (best < 0) continue
        const w = jawShare(v), t = w + (tShare[best]! - w) * (1 - smooth((bd - 10 * MM) / (6 * MM)))
        if (Math.abs(t - w) < 1e-4) continue
        const r = sub(p, c)
        items.push({ v, w, target: add(c, rot(r, phi(t))), d: sub(rot(r, phi(t) - phi(w)), r) })
      }
    }
    // 用真实的蒙皮校正几遍（权重里若还有别的关节，上面的闭式解只是近似）/ a few corrections with the real skinning (the closed form above is only approximate when other joints share the weight)
    {
      const pose = { [jawJ.id]: Array.from({ length: curated.muscles.jaw.dof + 1 }, (_, k) => (k === curated.muscles.jaw.dof ? th : 0)) }
      const poser = new Poser(rig, opts.rigBin, pose)
      for (let it = 0; it < 3; it++) {
        const pos = Float32Array.from(skin.positions)
        for (const m of items) (pos[m.v * 3] = pos[m.v * 3]! + m.d[0]), (pos[m.v * 3 + 1] = pos[m.v * 3 + 1]! + m.d[1]), (pos[m.v * 3 + 2] = pos[m.v * 3 + 2]! + m.d[2])
        const cur = poser.part(skinPart.id, pos, 'dqs', false)
        for (const m of items) m.d = add(m.d, rot(sub(m.target, [cur[m.v * 3]!, cur[m.v * 3 + 1]!, cur[m.v * 3 + 2]!]), -phi(m.w)))
      }
    }
    for (const m of items) {
      if (len(m.d) < EPS) continue
      table.set(m.v, m.d)
      maxD = Math.max(maxD, len(m.d))
    }
    const taper = regionJ
    const cc: V3 = [midX, skinSt, corners[0]![2]]
    chans.push({ def: d, id: d.id, side: 'M', parts: [], line: { origin: cc as Vec3, insertion: cc as Vec3, originOnSkin: cc as Vec3, insertionOnSkin: cc as Vec3 }, basis: 'landmarks', excursion: maxD, field: tabled(table) })
    report.push({ id: d.id, parts: [], basis: 'landmarks', lengthMm: { M: +(taper / MM).toFixed(1) }, pcaVsHintCos: {}, asymmetryMm: null, skinVertices: {} })
  }
  // —— 唇的几何通道和舌的示意姿势（开口的皮肤）/ geometric lip channels and schematic tongue poses (opened skin) ——
  // 这些通道不是由肌肉的作用线算出来的，而是直接规定唇缘怎样走，唇的其余部分按到唇缘的距离跟随：
  //   seal        下唇缘走到上唇缘上（双唇闭合）。在下颌张开 refJawFraction 的姿势下用真实的蒙皮迭代求解，
  //               所以它正好抵消下颌带给下唇的位移；运行时激活 = 闭合量 × 下颌角 / refJaw。
  //   dental      下唇缘中段走到上切牙的切缘（唇齿音），同样在 refJawFraction 的姿势下求解。
  //   protrude    两唇沿口的朝向前移（圆唇时前突）；rollUpper / rollLower 唇缘向口内卷；press 红唇上下压扁；
  //   upperDepress 上唇缘下移。
  // 幅度和轮廓都是假设；肌肉基础是口轮匝肌（seal、dental 还有颏肌），但没有按肌肉力学计算。
  // These channels are not derived from a muscle's line of action: they prescribe how the lip margin travels, and the rest of the lip
  // follows by distance from the margin. seal: the lower margin travels onto the upper (bilabial closure), solved iteratively with the
  // real skinning in the pose with the jaw opened by refJawFraction, so that it exactly undoes what the jaw does to the lower lip; at
  // run time its activation = closure × jaw angle / refJaw. dental: the middle of the lower margin travels to the incisal edge of the
  // upper incisors (labiodentals), solved in the same way. protrude: both lips move forward along the facing of the mouth;
  // rollUpper / rollLower: a margin rolls into the mouth; press: the vermilion is flattened vertically; upperDepress: the upper
  // margin moves down. Excursions and profiles are assumptions; the muscular basis is orbicularis oris (with mentalis for seal and
  // dental), but no muscle mechanics is computed.
  const mouthRep: NonNullable<FaceReport['mouth']> = { widthMm: 0, foldPasses: {}, sealResidualMm: null, dentalResidualMm: null, incisalEdge: null, lipParts: lipParts.map((p) => p.id), tongue: null }
  const lipDefs = defs.filter((d) => d.model === 'lip')
  /** 口周皮肤顶点在上唇一侧还是下唇一侧 / whether a perioral skin vertex is on the upper-lip or the lower-lip side. */
  const upperSide = new Map<number, boolean>()
  {
    const jawJ = rig.joints.find((j) => j.id === curated.muscles.jaw.joint)
    const dof = jawJ?.dofs[curated.muscles.jaw.dof]
    if (O && lipDefs.length && jawJ && dof && opts.rigBin && cornerL && cornerR) {
      const U = O.margins.upperLip, Lo = O.margins.lowerLip, nM = U.length, midI = nM >> 1
      const mp = U.map(P3)
      mouthRep.widthMm = +(len(sub(cornerL, cornerR)) / MM).toFixed(1)
      const sOf = (x: number): number => Math.min(1, Math.abs(x - midX) / Math.abs((x >= midX ? cornerL : cornerR)[0] - midX))
      const F = meanNormal(mp[midI]!, 15 * MM, [0, 0, 1])
      // 跟随者：口裂 26 mm 内的皮肤顶点，记下最近的两个唇缘点 / followers: skin vertices within 26 mm of the fissure, with their two nearest margin points
      const fol: { v: number; a: number; b: number; ka: number; da: number; upper: boolean; vv: number; s: number }[] = []
      const onMargin = new Map<number, number>()
      U.forEach((v, i) => onMargin.set(v, i))
      Lo.forEach((v, i) => onMargin.set(v, i))
      for (let v = 0; v < skinN; v++) {
        if (aid[v]) continue
        const p = P3(v)
        if (Math.abs(p[0] - midX) > 0.06 || Math.abs(p[1] - skinSt) > 0.04 || p[2] < cornerL[2] - 25 * MM) continue
        const own = onMargin.get(v)
        const np = own !== undefined ? { a: own, b: own === 0 ? 1 : own - 1, ka: 1, distance: 0 } : nearestOnPolyline(p, mp)
        const { a, b, ka } = np, da = np.distance
        if (da > 26 * MM) continue
        const vv = p[1] - stomionAt(p[0])
        const upper = sheet[v] === 1 ? true : sheet[v] === 2 ? false : vv >= 0
        upperSide.set(v, upper)
        fol.push({ v, a, b, ka, da, upper, vv: upper ? Math.abs(vv) : -Math.abs(vv), s: sOf(p[0]) })
      }
      const spread = (Dm: V3[], which: 'upper' | 'lower' | 'both', H: number): Map<number, V3> => {
        const out = new Map<number, V3>()
        for (const f of fol) {
          if (which !== 'both' && f.upper !== (which === 'upper')) continue
          const w = 1 - smooth(f.da / H)
          if (w <= 0) continue
          const A = Dm[f.a]!, B = Dm[f.b]!, kb = 1 - f.ka
          const d: V3 = [(A[0] * f.ka + B[0] * kb) * w, (A[1] * f.ka + B[1] * kb) * w, (A[2] * f.ka + B[2] * kb) * w]
          if (d[0] !== 0 || d[1] !== 0 || d[2] !== 0) out.set(f.v, d)
        }
        return out
      }
      const posed = (frac: number, tables: [Map<number, V3>, number][]): Float32Array => {
        const pos = Float32Array.from(skin.positions)
        for (const [t, k] of tables) for (const [v, d] of t) (pos[v * 3] = pos[v * 3]! + d[0] * k), (pos[v * 3 + 1] = pos[v * 3 + 1]! + d[1] * k), (pos[v * 3 + 2] = pos[v * 3 + 2]! + d[2] * k)
        const pose = { [jawJ.id]: Array.from({ length: curated.muscles.jaw.dof + 1 }, (_, k) => (k === curated.muscles.jaw.dof ? frac * dof.max : 0)) }
        return new Poser(rig, opts.rigBin!, pose).part(skinPart.id, pos, 'dqs', false)
      }
      const at = (a: Float32Array, v: number): V3 => [a[v * 3]!, a[v * 3 + 1]!, a[v * 3 + 2]!]
      const zero = (): V3[] => mp.map(() => [0, 0, 0] as V3)
      // 上切牙的切缘：每个 x 处最低的点及其唇面 / the incisal edge of the upper incisors: the lowest point at each x and its labial face
      const upperIncisors = parts.filter((p) => p.tissue === 'tooth' && /upper (central|lateral).*incisor/i.test(p.name) && body.meshes.has(p.id))
      const incPts = upperIncisors.flatMap((p) => meshPoints(body.meshes.get(p.id)!))
      const edgeAt = (x: number): V3 | null => {
        const near = incPts.filter((q) => Math.abs(q[0] - x) < 1.5 * MM)
        if (near.length === 0) return null
        const y = Math.min(...near.map((q) => q[1]))
        return [x, y, Math.max(...near.filter((q) => q[1] < y + 2 * MM).map((q) => q[2]))]
      }
      const e0 = edgeAt(midX)
      mouthRep.incisalEdge = e0 ? e0.map((x) => +x.toFixed(5)) : null
      const ct = cornerTable ?? new Map<number, V3>()
      for (const d of lipDefs) {
        const E = d.excursionMm * MM
        let table = new Map<number, V3>()
        const frac = d.refJawFraction ?? 0.1
        if (d.lipAction === 'seal' || d.lipAction === 'dental') {
          const base = posed(frac, [[ct, frac]])
          const goal: (V3 | null)[] = mp.map((_, i) => {
            if (i === 0 || i === nM - 1) return null
            if (d.lipAction === 'seal') return at(base, U[i]!)
            const ed = edgeAt(mp[i]![0])
            const k = 1 - smooth((Math.abs(mp[i]![0] - midX) - d.spreadMm * MM) / (d.reachMm * MM))
            if (!ed || k <= 0) return null
            // 下唇缘停在切缘的前下方一点，不进牙里 / the margin stops just below and in front of the edge, outside the tooth
            const tgt: V3 = [ed[0], ed[1] - 0.3 * MM, ed[2] + 0.4 * MM], from = at(base, Lo[i]!)
            return [from[0] + (tgt[0] - from[0]) * k, from[1] + (tgt[1] - from[1]) * k, from[2] + (tgt[2] - from[2]) * k]
          })
          const Dm = zero()
          let res = 0
          for (let it = 0; it < 8; it++) {
            table = spread(Dm, 'lower', (d.lip?.bandMm ?? 16) * MM)
            const cur = posed(frac, [[ct, frac], [table, 1]])
            res = 0
            for (let i = 1; i + 1 < nM; i++) {
              const g = goal[i]
              if (!g) continue
              const r = sub(g, at(cur, Lo[i]!))
              res = Math.max(res, len(r))
              if (it < 7) Dm[i] = add(Dm[i]!, r)
            }
          }
          if (d.lipAction === 'seal') mouthRep.sealResidualMm = +(res / MM).toFixed(3)
          else mouthRep.dentalResidualMm = +(res / MM).toFixed(3)
        } else if (d.lipAction === 'protrude') {
          table = spread(mp.map((q) => mul(F, E * (1 - 0.8 * smooth(sOf(q[0]))))), 'both', (d.lip?.bandMm ?? 22) * MM)
        } else if (d.lipAction === 'rollUpper' || d.lipAction === 'rollLower') {
          const Dm = mp.map((q, i) => (i === 0 || i === nM - 1 ? ([0, 0, 0] as V3) : mul(F, -E * (1 - smooth((sOf(q[0]) - 0.55) / 0.45)))))
          table = spread(Dm, d.lipAction === 'rollUpper' ? 'upper' : 'lower', (d.lip?.bandMm ?? 9) * MM)
        } else if (d.lipAction === 'purse') {
          // 收拢：唇缘各点沿唇缘向正中走 excursionMm × s（s 是到正中的弧长比例，口角处最大），整条唇均匀缩短；口周皮肤在 bandMm 内跟随
          // pursing: every margin point travels along the margin towards the midline by excursionMm × s (s the arc-length fraction from the middle, greatest at the corners), so the whole lip shortens evenly; the perioral skin follows within bandMm
          const Dm = mp.map((q, i) => {
            if (i === midI) return [0, 0, 0] as V3
            // 方向取到隔四个点的唇缘点：唇缘折线本身有零点几毫米的锯齿 / the direction is taken to the margin point four vertices on: the polyline itself zigzags by tenths of a millimetre
            const to = mp[i < midI ? Math.min(midI, i + 4) : Math.max(midI, i - 4)]!
            return mul(norm(sub(to, q)), E * Math.min(1, peri!.sMargin[i]!))
          })
          table = spread(Dm, 'both', (d.lip?.bandMm ?? 22) * MM)
        } else if (d.lipAction === 'evert') {
          // 外翻：上唇缘向前上、下唇缘向前下各走 excursionMm（前 : 上下 = 1 : 0.7），唇的其余部分按到唇缘的距离跟随，口角不动；
          // 唇缘是红唇最靠里的一条线，它向前、向外走，红唇的内面就翻到外面来（漏斗形的唇）
          // eversion: the upper margin travels forward and up, the lower forward and down, by excursionMm each (forward : vertical =
          // 1 : 0.7); the rest of the lip follows by distance from the margin and the corners stay. The margin is the innermost line
          // of the vermilion: as it moves forward and outward the inner face of the lip turns out (funnelled lips)
          const prof = (q: V3, i: number): number => (i === 0 || i === nM - 1 ? 0 : 1 - smooth((sOf(q[0]) - 0.45) / 0.5))
          const H = (d.lip?.bandMm ?? 8) * MM
          for (const [which, sy] of [['upper', 1], ['lower', -1]] as const) for (const [v, dv] of spread(mp.map((q, i) => add(mul(F, E * prof(q, i)), [0, sy * 0.7 * E * prof(q, i), 0] as V3)), which, H)) table.set(v, dv)
        } else if (d.lipAction === 'upperDepress') {
          const Dm = mp.map((q, i) => (i === 0 || i === nM - 1 ? ([0, 0, 0] as V3) : ([0, -E * (1 - smooth((sOf(q[0]) - 0.5) / 0.45)), 0] as V3)))
          table = spread(Dm, 'upper', (d.lip?.bandMm ?? 14) * MM)
        } else if (d.lipAction === 'press') {
          // 红唇向口裂压扁：离口裂 h 处的顶点向口裂走 spreadMm/10 × h（唇缘不动），并整体向后贴 excursionMm
          // the vermilion is flattened towards the fissure: a vertex at height h travels spreadMm/10 × h towards it (the margins stay), and the whole is pressed back by excursionMm
          const H = (d.lip?.bandMm ?? 12) * MM
          for (const f of fol) {
            const g = 1 - smooth((f.s - 0.55) / 0.45)
            const w = 1 - smooth(Math.abs(f.vv) / H)
            if (g <= 0 || w <= 0 || f.da > H) continue
            const back = mul(F, -E * g * (1 - smooth(f.da / (0.7 * H))))
            table.set(f.v, [back[0], back[1] - (d.spreadMm / 10) * f.vv * w * g, back[2]])
          }
        }
        let maxD = 0
        for (const dv of table.values()) maxD = Math.max(maxD, len(dv))
        const c = mp[midI]!
        chans.push({ def: d, id: d.id, side: 'M', parts: matched.get(d.id)!, line: { origin: c as Vec3, insertion: c as Vec3, originOnSkin: c as Vec3, insertionOnSkin: c as Vec3 }, basis: 'landmarks', excursion: maxD, field: tabled(table), skinTable: table, ...(d.lipAction === 'seal' || d.lipAction === 'dental' ? { refJaw: +(frac * dof.max).toFixed(5) } : {}) })
        report.push({ id: d.id, parts: matched.get(d.id)!.map((p) => p.id), basis: 'landmarks', lengthMm: { M: +(maxD / MM).toFixed(2) }, pcaVsHintCos: {}, asymmetryMm: null, skinVertices: {} })
      }
    } else for (const d of lipDefs) unmatched.push({ id: d.id, why: 'needs a skin with a real oral fissure, the jaw joint and rig.bin' })
  }
  // 舌：一个部件；几个示意的位移姿势，按沿舌长（z）和舌高（y）的归一化坐标加权。不是解剖的舌肌，幅度是假设。
  // The tongue: one part; a few schematic displacement poses weighted by normalised position along its length (z) and height (y).
  // Not the anatomical tongue muscles; excursions are assumptions.
  for (const d of defs.filter((x) => x.model === 'tongue')) {
    const part = matched.get(d.id)![0]
    if (!part) continue
    mouthRep.tongue = part.id
    const m = body.meshes.get(part.id)!, b = part.bbox, E = d.excursionMm * MM
    const table = new Map<number, V3>()
    for (let v = 0; v < m.positions.length / 3; v++) {
      const tz = (m.positions[v * 3 + 2]! - b[2]) / Math.max(1e-9, b[5] - b[2]), ty = (m.positions[v * 3 + 1]! - b[1]) / Math.max(1e-9, b[4] - b[1])
      const yw = smooth((ty - 0.2) / 0.5)
      const g = (c: number, w: number): number => Math.exp(-(((tz - c) / w) ** 2))
      // 卷舌：舌尖段向上并向后（上 : 后 = 1 : 0.8），越靠舌尖越多；紧挨其后的舌面略降，让舌尖像是翘起来的
      // retroflex: the tip segment travels up and back (up : back = 1 : 0.8), more towards the tip; the blade just behind it dips a little so that the tip reads as curled
      const dv: V3 = d.tongue === 'retro' ? add(mul([0, 0.78, -0.62], E * smooth((tz - 0.55) / 0.45)), mul([0, -1, 0], 0.2 * E * g(0.5, 0.12) * yw)) : d.tongue === 'tip' ? mul([0, 1, 0.25], E * smooth((tz - 0.6) / 0.4)) : d.tongue === 'front' ? mul([0, 1, 0], E * g(0.65, 0.2) * yw) : d.tongue === 'back' ? mul([0, 1, -0.3], E * g(0.25, 0.22) * yw) : mul([0, -1, 0], E * (0.4 + 0.6 * smooth(tz)) * yw)
      if (len(dv) > EPS) table.set(v, dv)
    }
    const c = part.centroid as V3
    chans.push({ def: d, id: d.id, side: 'M', parts: [part], line: { origin: c as Vec3, insertion: c as Vec3, originOnSkin: c as Vec3, insertionOnSkin: c as Vec3 }, basis: 'landmarks', excursion: E, field: () => [0, 0, 0], deepTables: new Map([[part.id, table]]) })
    report.push({ id: d.id, parts: [part.id], basis: 'landmarks', lengthMm: { M: +((b[5] - b[2]) / MM).toFixed(1) }, pcaVsHintCos: {}, asymmetryMm: null, skinVertices: {} })
  }
  chans.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  log(`${chans.length} channels from ${facial.length} muscle parts; midX ${(midX / MM).toFixed(1)} mm; stomion skin ${skinSt.toFixed(4)} deep ${deepSt?.toFixed(4) ?? 'none'}`)

  // —— 在皮肤上求值 / evaluate on the skin ——
  type Sparse = { index: number[]; delta: number[] }
  const fields: Map<string, Sparse>[] = chans.map(() => new Map())
  const put = (ci: number, part: string, v: number, d: V3): void => {
    if (!Number.isFinite(d[0]) || !Number.isFinite(d[1]) || !Number.isFinite(d[2])) throw new Error(`face: non-finite displacement in ${chans[ci]!.id} on ${part}`)
    if (Math.hypot(d[0], d[1], d[2]) < EPS) return
    let f = fields[ci]!.get(part)
    if (!f) fields[ci]!.set(part, (f = { index: [], delta: [] }))
    f.index.push(v)
    f.delta.push(d[0], d[1], d[2])
  }
  // 皮肤上的场分两部分：沿切面的滑动（上面各通道的场函数），和由它引起的厚度变化。
  // 软组织近似不可压：皮肤表面滑动 u、到骨面处减为 0，则厚度为 H 的一层因面内压缩而增厚
  //   w = −(H / 2) · div_s(u)        （div_s 是曲面上的散度；线性剪切剖面下的体积守恒）
  // 沿法线向外。H 取皮肤到骨的距离，限制在 bulge.minMm–bulge.maxMm；|w| 不超过 bulge.limitMm。
  // 这是一阶近似：被挤压的地方鼓起（眉间、鼻旁、颊部），被拉开的地方变薄；它给不出皱纹（屈曲）。
  // The field on the skin has two parts: sliding within the tangent plane (the channel field functions above) and the change of
  // thickness it causes. Soft tissue is nearly incompressible: if the skin surface slides by u and the sliding falls to zero at the
  // bone, a layer of thickness H thickens under in-plane compression by
  //   w = −(H / 2) · div_s(u)        (div_s is the surface divergence; volume conservation for a linear shear profile)
  // along the outward normal. H is the distance from skin to bone, limited to bulge.minMm–bulge.maxMm; |w| is capped at
  // bulge.limitMm. This is a first-order approximation: tissue bulges where it is squeezed (glabella, beside the nose, cheek) and
  // thins where it is stretched; it cannot produce wrinkles (buckling).
  const bulge = curated.muscles.bulge ?? { gain: 0.5, minMm: 2, maxMm: 10, limitMm: 3, smoothing: 2 }
  const regionVerts: number[] = []
  const regionOf = new Int32Array(skinN).fill(-1)
  for (let v = 0; v < skinN; v++) if (skin.positions[v * 3 + 1]! >= regionMinY) (regionOf[v] = regionVerts.length), regionVerts.push(v)
  const nr = regionVerts.length
  const regionTris: number[] = []
  for (let t = 0; t < skinTri.length; t += 3) {
    const a2 = regionOf[skinTri[t]!]!, b2 = regionOf[skinTri[t + 1]!]!, c2 = regionOf[skinTri[t + 2]!]!
    if (a2 >= 0 && b2 >= 0 && c2 >= 0) regionTris.push(a2, b2, c2)
  }
  const cover = new Float64Array(nr)
  for (let r = 0; r < nr; r++) {
    const v = regionVerts[r]! * 3
    const d = boneSurf.distance(skin.positions[v]!, skin.positions[v + 1]!, skin.positions[v + 2]!, bulge.maxMm * MM)
    cover[r] = Math.min(bulge.maxMm * MM, Math.max(bulge.minMm * MM, d))
  }
  // 每个三角形里三个形函数的梯度（常量）和面积 / the (constant) gradients of the three shape functions in every triangle, and its area
  const ntr = regionTris.length / 3
  const grad = new Float64Array(ntr * 9), area = new Float64Array(ntr)
  for (let t = 0; t < ntr; t++) {
    const P = skin.positions
    const ia = regionVerts[regionTris[t * 3]!]! * 3, ib = regionVerts[regionTris[t * 3 + 1]!]! * 3, ic = regionVerts[regionTris[t * 3 + 2]!]! * 3
    const A: V3 = [P[ia]!, P[ia + 1]!, P[ia + 2]!], B: V3 = [P[ib]!, P[ib + 1]!, P[ib + 2]!], C: V3 = [P[ic]!, P[ic + 1]!, P[ic + 2]!]
    const nn = cross(sub(B, A), sub(C, A))
    const a2 = len(nn)
    if (a2 < 1e-14) continue
    area[t] = a2 / 2
    const n = mul(nn, 1 / a2)
    // ∇φ_i = n × (对边) / (2A) / ∇φ_i = n × (opposite edge) / (2A)
    const g = [cross(n, sub(C, B)), cross(n, sub(A, C)), cross(n, sub(B, A))]
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) grad[t * 9 + k * 3 + c] = g[k]![c]! / a2
  }
  const rawNormals = vertexNormals(skinMesh, 0)
  const creased = new Uint8Array(nr)
  for (let r = 0; r < nr; r++) {
    const v = regionVerts[r]! * 3
    if (rawNormals[v]! * normals[v]! + rawNormals[v + 1]! * normals[v + 1]! + rawNormals[v + 2]! * normals[v + 2]! < 0.7) creased[r] = 1
  }
  // 邻接表，以及“褶皱附近”的标记（褶皱顶点和它们的两圈邻居）/ adjacency, and the near-crease flag (crease vertices and their two rings of neighbours)
  const neighbourSets: Set<number>[] = Array.from({ length: nr }, () => new Set<number>())
  for (let t = 0; t < regionTris.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a2 = regionTris[t + k]!, b2 = regionTris[t + ((k + 1) % 3)]!
      neighbourSets[a2]!.add(b2), neighbourSets[b2]!.add(a2)
    }
  }
  const neighbours = neighbourSets.map((x) => [...x].sort((a2, b2) => a2 - b2))
  let nearCrease = Uint8Array.from(creased)
  for (let ring = 0; ring < 2; ring++) {
    const grown = Uint8Array.from(nearCrease)
    for (let r = 0; r < nr; r++) if (nearCrease[r]) for (const o of neighbours[r]!) grown[o] = 1
    nearCrease = grown
  }
  const vertArea = new Float64Array(nr)
  for (let t = 0; t < ntr; t++) for (let k = 0; k < 3; k++) vertArea[regionTris[t * 3 + k]!] = vertArea[regionTris[t * 3 + k]!]! + area[t]!
  // 唇的两片（含口袋的内壁）用一套专门的法线：周围 5 mm 内口周皮肤顶点原始法线的平均。口袋两壁的法线几乎相反，
  // 平均后互相抵消，剩下的是唇外表面的朝向；位置重合的上下唇缘顶点因此得到相同的法线，同一个场不会把它们拉开。
  // The two lip sheets (pocket walls included) get normals of their own: the mean raw normal of the perioral skin vertices within
  // 5 mm. The two walls of the pocket have nearly opposite normals and cancel, leaving the facing of the outer lip surface; the
  // coincident upper and lower margin vertices thus get the same normal, and one field cannot pull them apart.
  const lipNormal = new Map<number, V3>()
  /** 口周权重：离口裂 14 mm 内为 1，到 24 mm 降为 0 / the perioral weight: 1 within 14 mm of the fissure, 0 from 24 mm. */
  const zoneW = new Float64Array(nr)
  if (O) {
    const mpts = O.margins.upperLip.map(P3)
    const around: number[] = []
    for (let r = 0; r < nr; r++) {
      const v = regionVerts[r]!
      if (aid[v]) continue
      const p = P3(v)
      if (Math.abs(p[0] - midX) > 0.07 || Math.abs(p[1] - skinSt) > 0.05 || p[2] < cornerL![2] - 30 * MM) continue
      let dmin = Infinity
      for (const q of mpts) dmin = Math.min(dmin, len(sub(p, q)))
      if (dmin < 32 * MM) around.push(v)
      zoneW[r] = 1 - smooth((dmin - 14 * MM) / (10 * MM))
    }
    const pos = around.map(P3)
    // 口裂附近（两唇相贴的面、红唇）法线没有意义：上下两个面的法线相反，平均出来朝哪儿全凭运气，沿切面滑动时就会把唇带向口内。
    // 那里改用牙弓的朝向：过口裂中点和两口角的竖直圆柱面的法线（水平、向外）；离口裂 5 mm 以外逐渐换回皮肤自己的法线。
    // Near the fissure (the contact surfaces, the vermilion) a normal means nothing: the two surfaces face opposite ways and their mean
    // points wherever chance has it, so sliding in that tangent plane drags the lips into the mouth. There the facing of the dental arch
    // is used instead — the normal (horizontal, outward) of the vertical cylinder through the middle of the fissure and both corners —
    // blending back to the skin's own normal beyond 5 mm from the fissure.
    const midP = mpts[mpts.length >> 1]!
    const halfChord = (Math.abs(cornerL![0] - midX) + Math.abs(cornerR![0] - midX)) / 2, sag = Math.max(1 * MM, midP[2] - (cornerL![2] + cornerR![2]) / 2)
    const archZ = midP[2] - (halfChord * halfChord + sag * sag) / (2 * sag)
    for (const v of around) {
      if (zoneW[regionOf[v]!]! <= 0) continue
      const p = P3(v)
      let dmin = Infinity
      for (const q of mpts) dmin = Math.min(dmin, len(sub(p, q)))
      const core = 1 - smooth((dmin - 5 * MM) / (8 * MM))
      const nArch = norm([p[0] - midX, 0, p[2] - archZ])
      // 平滑法线打底，保证互相抵消时也有一个连续的结果 / the smoothed normal as a floor, so that the result stays continuous where the raw ones cancel
      const n: V3 = [normals[v * 3]! * 0.5, normals[v * 3 + 1]! * 0.5, normals[v * 3 + 2]! * 0.5]
      for (let i = 0; i < around.length; i++) {
        const q = pos[i]!
        if (Math.abs(q[0] - p[0]) > 6 * MM || Math.abs(q[1] - p[1]) > 6 * MM || len(sub(q, p)) > 6 * MM) continue
        const u = around[i]! * 3
        ;(n[0] += rawNormals[u]!), (n[1] += rawNormals[u + 1]!), (n[2] += rawNormals[u + 2]!)
      }
      const nSkin: V3 = len(n) > 1e-6 ? norm(n) : [0, 0, 1]
      lipNormal.set(v, norm(add(mul(nSkin, 1 - core), mul(nArch, core))))
    }
  }
  // 口角一带的三角形：用来检查折叠 / the triangles round the mouth corners, checked for folds
  const cornerTris: number[] = []
  if (O) {
    const zr = cornerCfg.zoneMm * MM
    const nearCorner = (r: number): boolean => {
      const p = P3(regionVerts[r]!)
      return Math.min(len(sub(p, cornerL!)), len(sub(p, cornerR!))) < zr
    }
    for (let t = 0; t < ntr; t++) if (area[t]! > 1e-12 && nearCorner(regionTris[t * 3]!) && nearCorner(regionTris[t * 3 + 1]!) && nearCorner(regionTris[t * 3 + 2]!)) cornerTris.push(t)
  }
  /**
   * 口角的检查（以及万一不过时的退路；现在每个通道都是 0 遍）：激活为 1 时，口角一带的三角形若翻折（法线与静止时相反）或面积比超出 [minAreaRatio, maxAreaRatio]，
   * 就把这些三角形的顶点及其一圈邻居的位移向邻居的平均抹匀，直到没有这样的三角形（最多 foldPasses 遍）。返回用了几遍。
   * The check at the corner (and the fallback should it fail; currently 0 passes for every channel): at activation 1, where a triangle round a corner folds (normal reversed against rest) or its
   * area ratio leaves [minAreaRatio, maxAreaRatio], the displacement of its vertices and their ring of neighbours is evened towards the
   * neighbours' mean until no such triangle is left (at most foldPasses passes). Returns the number of passes used.
   */
  let dbgName = ''
  const unfold = (U: Float64Array, after: () => void): number => {
    const P = skin.positions
    for (let pass = 0; pass < cornerCfg.foldPasses; pass++) {
      const bad = new Uint8Array(nr)
      let any = false
      for (const t of cornerTris) {
        const q: V3[] = []
        for (let k = 0; k < 3; k++) {
          const r = regionTris[t * 3 + k]!, v = regionVerts[r]! * 3
          q.push([P[v]! + U[r * 3]!, P[v + 1]! + U[r * 3 + 1]!, P[v + 2]! + U[r * 3 + 2]!])
        }
        const a = regionVerts[regionTris[t * 3]!]! * 3, b = regionVerts[regionTris[t * 3 + 1]!]! * 3, c = regionVerts[regionTris[t * 3 + 2]!]! * 3
        const n0 = cross([P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!], [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!])
        const n1 = cross(sub(q[1]!, q[0]!), sub(q[2]!, q[0]!))
        const ratio = len(n1) / Math.max(1e-18, len(n0))
        // 三角形的“高” = 2 × 面积 / 最长边。高不到 sliverMm 的是退化的碎三角形（唇缘上三点几乎共线），零点零几毫米的差别就让它的法线翻转，
        // 而它不占任何像素：翻折只查静止或变形后高 ≥ sliverMm 的，面积比只查静止时高 ≥ sliverMm 的。
        // A triangle's "height" = 2 × area / longest edge. One lower than sliverMm is a degenerate sliver (three nearly collinear points on
        // the margin): hundredths of a millimetre reverse its normal, and it covers no pixel. Folds are checked for triangles whose rest
        // or deformed height is ≥ sliverMm, the area ratio for those whose rest height is ≥ sliverMm.
        const p0: V3[] = [[P[a]!, P[a + 1]!, P[a + 2]!], [P[b]!, P[b + 1]!, P[b + 2]!], [P[c]!, P[c + 1]!, P[c + 2]!]]
        const longest = (x: V3[]): number => Math.max(len(sub(x[1]!, x[0]!)), len(sub(x[2]!, x[1]!)), len(sub(x[0]!, x[2]!)))
        const h0 = len(n0) / Math.max(1e-12, longest(p0)), h1 = len(n1) / Math.max(1e-12, longest(q)), sliver = (cornerCfg.sliverMm ?? 0.05) * MM
        if ((dot(n0, n1) <= 0 && Math.max(h0, h1) >= sliver) || (h0 >= sliver && (ratio < cornerCfg.minAreaRatio || ratio > cornerCfg.maxAreaRatio))) {
          if (process.env.FACE_DEBUG && pass === 0) console.log('  bad', dbgName, [0, 1, 2].map((k) => { const r = regionTris[t * 3 + k]!, v = regionVerts[r]!, i = peri!.local[v]!; return `${v}:s${sheet[v]}:d${(peri!.dM[i]! / MM).toFixed(1)}:f${periFreeC[i]}:u${(Math.hypot(U[r * 3]!, U[r * 3 + 1]!, U[r * 3 + 2]!) / MM).toFixed(2)}` }).join(' '), 'area', (len(n0) / 2 / MM / MM).toFixed(4), 'ratio', ratio.toFixed(2), 'cos', (dot(n0, n1) / Math.max(1e-30, len(n0) * len(n1))).toFixed(2))
          any = true
          for (let k = 0; k < 3; k++) bad[regionTris[t * 3 + k]!] = 1
        }
      }
      if (!any) return pass
      const grown = Uint8Array.from(bad)
      for (let r = 0; r < nr; r++) if (bad[r]) for (const o of neighbours[r]!) grown[o] = 1
      const next = Float64Array.from(U)
      for (let r = 0; r < nr; r++) {
        if (!grown[r]) continue
        const nb = neighbours[r]!
        if (nb.length === 0) continue
        for (let c = 0; c < 3; c++) {
          let sum = 0
          for (const o of nb) sum += U[o * 3 + c]!
          next[r * 3 + c] = 0.5 * U[r * 3 + c]! + 0.5 * (sum / nb.length)
        }
      }
      U.set(next)
      after()
    }
    return cornerCfg.foldPasses
  }
  // 调和插值的自由顶点（口裂 regionMm 以内、不在唇缘上），以及口周顶点在面部区域里的下标
  // the free vertices of the harmonic interpolation (within regionMm of the fissure and not on a margin), and the region index of every perioral vertex
  const periFreeW = new Uint8Array(peri?.verts.length ?? 0)
  const periFreeC = new Uint8Array(peri?.verts.length ?? 0), periR = new Int32Array(peri?.verts.length ?? 0)
  if (O && peri) {
    const onM = new Set([...O.margins.upperLip, ...O.margins.lowerLip])
    peri.verts.forEach((v, i) => {
      periR[i] = regionOf[v]!
      if (regionOf[v]! < 0) throw new Error('face: a perioral vertex lies outside the face region')
      // 口角周围取得更大（zoneMm）：那里几块肌肉的场交接，逐顶点的值最不一致 / larger round the corners (zoneMm): several muscle fields hand over there and per-vertex values are least consistent
      const p = P3(v), dc = Math.min(len(sub(p, cornerL!)), len(sub(p, cornerR!)))
      periFreeC[i] = !onM.has(v) && (peri.dM[i]! < (cornerCfg.regionMm ?? 9) * MM || dc < cornerCfg.zoneMm * MM) ? 1 : 0
    })
    for (const f of peri.onLine) periFreeC[f.i] = 0
    periFreeW.set(periFreeC)
  }
  const pouchNear = new Map<number, { skin: number; k: number }>()
  if (O) {
    const cand = regionVerts.filter((v) => !aid[v] && Math.abs(skin.positions[v * 3 + 1]! - skinSt) < 0.06 && Math.abs(skin.positions[v * 3]! - midX) < 0.06)
    for (const v of [...O.oralPouch.upper, ...O.oralPouch.lower]) {
      const p = P3(v)
      let best = -1, bd = 16 * MM
      for (const u of cand) {
        const dx = skin.positions[u * 3]! - p[0], dy = skin.positions[u * 3 + 1]! - p[1]
        if (Math.abs(dx) > bd || Math.abs(dy) > bd) continue
        const dd = Math.hypot(dx, dy, skin.positions[u * 3 + 2]! - p[2])
        if (dd < bd) (bd = dd), (best = u)
      }
      if (best >= 0) pouchNear.set(v, { skin: best, k: 1 - smooth((bd - 10 * MM) / (6 * MM)) })
    }
  }
  /** 每个通道在皮肤上最终的位移（按面部区域的下标）：贴在皮肤上的薄壳（眉毛）照搬它 / every channel's final displacement on the skin (by region index): shells lying on the skin (the eyebrows) copy it. */
  const skinU: Float64Array[] = []
  for (let ci = 0; ci < chans.length; ci++) {
    const ch = chans[ci]!
    const U = new Float64Array(nr * 3)
    for (let r = 0; r < nr; r++) {
      const v = regionVerts[r]!
      const p: V3 = [skin.positions[v * 3]!, skin.positions[v * 3 + 1]!, skin.positions[v * 3 + 2]!]
      const n: V3 = [normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!]
      // 构造物（睑缘内卷、口腔袋）不求值，稍后跟随它们的缘顶点 / construction aids (lid rims, oral pouch) are not evaluated; they follow their margin vertices below
      if (aid[v]) {
        const dv = ch.def.model === 'corner' ? cornerTable?.get(v) : undefined
        if (dv) (U[r * 3] = dv[0]), (U[r * 3 + 1] = dv[1]), (U[r * 3 + 2] = dv[2])
        continue
      }
      ;(curVertex = v), (curSheet = sheet[v]!)
      const ln = lipNormal.get(v), zw = zoneW[r]!
      ;(curLip = ln !== undefined), (curZone = zw)
      const d = ch.field(p, ln ? norm(add(mul(n, 1 - zw), mul(ln, zw))) : n, p, false)
      ;(U[r * 3] = d[0]), (U[r * 3 + 1] = d[1]), (U[r * 3 + 2] = d[2])
    }
    ;(curVertex = -1), (curSheet = 0), (curLip = false), (curZone = 0)
    const plain = ch.def.model !== 'lid' && ch.def.model !== 'recess' && ch.def.model !== 'corner' && ch.def.model !== 'lip' && ch.def.model !== 'tongue'
    if (plain && bulge.gain > 0) {
      let div = new Float64Array(nr)
      for (let t = 0; t < ntr; t++) {
        let d = 0
        for (let k = 0; k < 3; k++) {
          const r = regionTris[t * 3 + k]!
          d += U[r * 3]! * grad[t * 9 + k * 3]! + U[r * 3 + 1]! * grad[t * 9 + k * 3 + 1]! + U[r * 3 + 2]! * grad[t * 9 + k * 3 + 2]!
        }
        for (let k = 0; k < 3; k++) div[regionTris[t * 3 + k]!] = div[regionTris[t * 3 + k]!]! + d * area[t]!
      }
      for (let r = 0; r < nr; r++) div[r] = vertArea[r]! > 0 ? div[r]! / vertArea[r]! : 0
      // 在网格上平滑几遍（面积加权）/ a few smoothing passes over the mesh (area-weighted)
      for (let pass = 0; pass < bulge.smoothing; pass++) {
        const next = new Float64Array(nr)
        for (let t = 0; t < ntr; t++) {
          const m = (div[regionTris[t * 3]!]! + div[regionTris[t * 3 + 1]!]! + div[regionTris[t * 3 + 2]!]!) / 3
          for (let k = 0; k < 3; k++) next[regionTris[t * 3 + k]!] = next[regionTris[t * 3 + k]!]! + m * area[t]!
        }
        for (let r = 0; r < nr; r++) next[r] = vertArea[r]! > 0 ? next[r]! / vertArea[r]! : 0
        div = next
      }
      const lim = bulge.limitMm * MM
      for (let r = 0; r < nr; r++) {
        // 褶皱里的顶点（平滑前后的法线相差很大）不加厚度变化：那里的散度是网格折叠造成的假象
        // no thickness change for vertices inside creases (raw and smoothed normals far apart): the divergence there is an artefact of the folded mesh
        if (creased[r]) continue
        if (U[r * 3] === 0 && U[r * 3 + 1] === 0 && U[r * 3 + 2] === 0 && Math.abs(div[r]!) < 1e-6) continue
        // 口周的三片不变薄：口腔袋只在皮肤后面 3 mm，皮肤向内让就会露出它 / the three perioral sheets do not thin: the oral pouch lies only 3 mm behind the skin and would show if the skin gave way inwards
        const w = Math.max(-lim * (1 - zoneW[r]!), Math.min(lim, -bulge.gain * cover[r]! * div[r]!))
        const v = regionVerts[r]! * 3
        ;(U[r * 3] = U[r * 3]! + w * normals[v]!), (U[r * 3 + 1] = U[r * 3 + 1]! + w * normals[v + 1]!), (U[r * 3 + 2] = U[r * 3 + 2]! + w * normals[v + 2]!)
      }
    }
    // 褶皱附近把位移场在网格上抹匀：褶里的顶点法线乱，相邻顶点的滑动方向不一致，叠加几个通道后就撕出锯齿（口角、鼻旁）。
    // 只动褶皱顶点及其两圈邻居；眼睑和口裂内陷本来就要在褶处不连续，不抹。
    // Near creases the field is evened out over the mesh: inside a fold the vertex normals are erratic, neighbouring vertices slide in
    // inconsistent directions, and with several channels added the skin tears into jagged shards (mouth corners, beside the nose).
    // Only crease vertices and their two rings of neighbours are touched; lids and the oral recess are meant to be discontinuous at
    // the crease and are left alone.
    if (plain) {
      for (let pass = 0; pass < (bulge.creasePasses ?? 0); pass++) {
        const next = Float64Array.from(U)
        for (let r = 0; r < nr; r++) {
          if (!nearCrease[r]) continue
          const nb = neighbours[r]!
          if (nb.length === 0) continue
          for (let c = 0; c < 3; c++) {
            let sum = 0
            for (const o of nb) sum += U[o * 3 + c]!
            next[r * 3 + c] = 0.3 * U[r * 3 + c]! + 0.7 * (sum / nb.length)
          }
        }
        U.set(next)
      }
    }
    if (O && plain) {
      // 先让唇缘和两唇相贴的面一致，再查折叠，然后再做一遍（抹匀会动到它们）
      // first make the margins and the contact surfaces consistent, then check for folds, then once more (the evening touches them)
      const split = ch.def.mask.includes('aboveStomion') || ch.def.mask.includes('belowStomion')
      // 不分上下唇的通道：位置重合的上下唇缘顶点取同一个位移（两者的平均），口裂不会被这个通道拉开
      // a channel that does not tell the lips apart: the coincident upper and lower margin vertices take one displacement (the mean of the two), so this channel cannot pull the fissure open
      const MU = O.margins.upperLip.map((v) => regionOf[v]!), ML = O.margins.lowerLip.map((v) => regionOf[v]!), nMg = MU.length
      if (!split) for (let i = 1; i + 1 < nMg; i++) for (let c = 0; c < 3; c++) U[MU[i]! * 3 + c] = U[ML[i]! * 3 + c] = (U[MU[i]! * 3 + c]! + U[ML[i]! * 3 + c]!) / 2
      // 唇缘上的位移沿唇缘抹匀几遍（口角用上下唇缘两个邻居）/ the displacement on the margins is evened along them a few times (a corner uses its neighbours on both margins)
      for (let pass = 0; pass < (cornerCfg.marginSmoothing ?? 3); pass++) {
        const src = Float64Array.from(U)
        for (let c = 0; c < 3; c++) {
          for (const M of [MU, ML]) for (let i = 1; i + 1 < nMg; i++) U[M[i]! * 3 + c] = 0.5 * src[M[i]! * 3 + c]! + 0.25 * (src[M[i - 1]! * 3 + c]! + src[M[i + 1]! * 3 + c]!)
          for (const [e, k] of [[0, 1], [nMg - 1, nMg - 2]] as const) U[MU[e]! * 3 + c] = 0.5 * src[MU[e]! * 3 + c]! + 0.25 * (src[MU[k]! * 3 + c]! + src[ML[k]! * 3 + c]!)
        }
      }
      // 口裂 regionMm 以内：位移由唇缘和外圈调和插值得到（见“口周的调和插值”）/ within regionMm of the fissure the displacement is the harmonic interpolant of the margins and the outer ring (see "harmonic interpolation round the mouth")
      const x = new Float64Array(peri!.verts.length), screenC = ((cornerCfg.smoothMm ?? 2.5) * MM) ** 2
      // 不分上下唇的通道：先把口裂焊上、唇缘也当未知量解一遍——唇缘上的值由此与周围的调和场一致，口角（缝的尖端）没有奇点；
      // 分上下唇的通道：唇缘上的值是规定的（上面抹匀过的逐顶点值）。
      // A channel that does not tell the lips apart: first solve with the fissure welded and the margins unknown too — the margin
      // values are then consistent with the harmonic field round them and the corner (the tip of the slit) has no singularity. A
      // channel that does: the margin values are prescribed (the per-vertex values evened above).
      if (!split) {
        const lMU = O.margins.upperLip.map((v) => peri!.local[v]!), lML = O.margins.lowerLip.map((v) => peri!.local[v]!)
        for (const i of lMU) periFreeW[i] = 1
        for (const f of peri!.onLine) periFreeW[f.i] = 1
        for (let c = 0; c < 3; c++) {
          for (let i = 0; i < x.length; i++) x[i] = U[periR[i]! * 3 + c]!
          peri!.solve(periFreeW, x, true, screenC)
          for (let i = 0; i < nMg; i++) U[MU[i]! * 3 + c] = U[ML[i]! * 3 + c] = x[lMU[i]!]!
        }
        void lML
      }
      for (const f of peri!.onLine) {
        const M = f.lower ? ML : MU, r = periR[f.i]!
        for (let c = 0; c < 3; c++) U[r * 3 + c] = U[M[f.a]! * 3 + c]! * f.ka + U[M[f.b]! * 3 + c]! * (1 - f.ka)
      }
      for (let c = 0; c < 3; c++) {
        for (let i = 0; i < x.length; i++) x[i] = U[periR[i]! * 3 + c]!
        peri!.solve(periFreeC, x, false, screenC)
        for (let i = 0; i < x.length; i++) if (periFreeC[i]) U[periR[i]! * 3 + c] = x[i]!
      }
      dbgName = ch.id
      mouthRep.foldPasses[ch.id] = unfold(U, () => {})
    }
    if (O && ch.def.model === 'lid' && (lidCfg.smoothPasses ?? 0) > 0) {
      // 眼睑通道：睑缘上的值不动，其余顶点的位移在网格上抹匀 smoothPasses 遍。跟随的权重是按“到最近睑缘顶点的距离”逐顶点取的，
      // 上睑沟（重睑的褶）里叠在一起的顶点因此得到参差的位移，闭眼时上睑上出现一道锯齿状的横褶。
      // lid channels: the margin values stay and the displacement of all other vertices is evened over the mesh smoothPasses times.
      // The follower weight is taken per vertex from "distance to the nearest margin vertex", so vertices stacked inside the
      // supratarsal fold get ragged displacements and a jagged horizontal crease appears on the closed upper lid.
      const fixed = new Uint8Array(nr)
      for (const M of [O.margins.upperLidL, O.margins.lowerLidL, O.margins.upperLidR, O.margins.lowerLidR]) for (const v of M) if (regionOf[v]! >= 0) fixed[regionOf[v]!] = 1
      let active: number[] = []
      for (let r = 0; r < nr; r++) if (!fixed[r] && !aid[regionVerts[r]!] && (U[r * 3] !== 0 || U[r * 3 + 1] !== 0 || U[r * 3 + 2] !== 0)) active.push(r)
      // 加上一圈邻居，让场在边界上也平缓地落到零 / plus one ring of neighbours, so that the field also falls to zero gently at its edge
      const set = new Set(active)
      for (const r of active) for (const o of neighbours[r]!) if (!fixed[o] && !aid[regionVerts[o]!]) set.add(o)
      active = [...set].sort((a, b) => a - b)
      for (let pass = 0; pass < (lidCfg.smoothPasses ?? 0); pass++) {
        const src = Float64Array.from(U)
        for (const r of active) {
          const nb = neighbours[r]!
          if (nb.length === 0) continue
          for (let c = 0; c < 3; c++) {
            let sum = 0
            for (const o of nb) sum += src[o * 3 + c]!
            U[r * 3 + c] = 0.5 * src[r * 3 + c]! + 0.5 * (sum / nb.length)
          }
        }
      }
    }
    if (O && peri && (ch.def.lipAction === 'purse' || ch.def.lipAction === 'evert')) {
      // 收拢和外翻这两个唇的几何通道：唇缘上的值不动，唇缘线上的其余顶点取插值，口裂附近其余顶点在 smoothMm 上抹匀——
      // 逐顶点按“最近的唇缘点”得到的场在两唇相贴的面上同样参差。其余的唇通道（闭唇、唇齿、前突、内卷、压扁）不抹：量过，抹了反而多出翻折。
      // the pursing and eversion lip channels: the margin values stay, the other vertices on the margin line take the interpolant,
      // and the rest near the fissure is evened over smoothMm — a field built per vertex from "the nearest margin point" is just as
      // ragged on the contact surfaces. The other lip channels (seal, dental, protrusion, roll, press) are left alone: measured,
      // evening them adds folds instead.
      const MU = O.margins.upperLip.map((v) => regionOf[v]!), ML = O.margins.lowerLip.map((v) => regionOf[v]!)
      for (const f of peri.onLine) {
        const M = f.lower ? ML : MU, r = periR[f.i]!
        for (let c = 0; c < 3; c++) U[r * 3 + c] = U[M[f.a]! * 3 + c]! * f.ka + U[M[f.b]! * 3 + c]! * (1 - f.ka)
      }
      const x = new Float64Array(peri.verts.length)
      for (let c = 0; c < 3; c++) {
        for (let i = 0; i < x.length; i++) x[i] = U[periR[i]! * 3 + c]!
        peri.solve(periFreeC, x, false, ((cornerCfg.smoothMm ?? 2.5) * MM) ** 2)
        for (let i = 0; i < x.length; i++) if (periFreeC[i]) U[periR[i]! * 3 + c] = x[i]!
      }
    }
    if (O) {
      // 睑缘内卷的每个顶点照搬它所属睑缘顶点的位移；口腔袋的每一列跟随它的唇缘顶点，从唇缘一行的 1 降到缝处的 0
      // every lid-rim vertex copies the displacement of its margin vertex; every pouch column follows its lip-margin vertex, from 1 in the row at the margin to 0 at the seam
      const copy = (to: number, from: number, k: number): void => {
        const a = regionOf[to]!, b = regionOf[from]!
        if (a < 0 || b < 0) return
        ;(U[a * 3] = U[b * 3]! * k), (U[a * 3 + 1] = U[b * 3 + 1]! * k), (U[a * 3 + 2] = U[b * 3 + 2]! * k)
      }
      for (const rim of O.lidRims) rim.vertices.forEach((v, i) => copy(v, rim.of[i]!, 1))
      // 口腔袋的壁紧贴在唇和口周皮肤后面约 3 mm（它包着牙和牙龈，前壁一直伸到鼻底）。每个袋顶点跟随它前面最近的皮肤顶点：
      // 10 mm 以内（一个唇厚）完全跟随，到 16 mm 处降为 0。这样皮肤滑动或向内让时袋壁始终在皮肤后面，不会从皮肤里露出来；缝和后壁不动。
      // The pouch wall lies about 3 mm behind the lips and the perioral skin (it encloses teeth and gingiva, and its front wall
      // reaches up to the base of the nose). Every pouch vertex follows the nearest skin vertex in front of it: fully within 10 mm
      // (a lip's thickness), falling to 0 at 16 mm. The wall thus stays behind the skin when the skin slides or gives way inwards and cannot show
      // through it; the seam and the back wall do not move.
      // 口角成形通道的袋顶点已经按它们自己的权重算好了 / the corner-shaping channel has its pouch vertices computed with their own weights already
      if (ch.def.model !== 'corner') for (const [v, near] of pouchNear) copy(v, near.skin, near.k)
    }
    for (let r = 0; r < nr; r++) put(ci, skinPart.id, regionVerts[r]!, [U[r * 3]!, U[r * 3 + 1]!, U[r * 3 + 2]!])
    skinU.push(U)
  }
  for (const [ci, ch] of chans.entries()) {
    const rep = report.find((r) => r.id === ch.def.id)
    if (rep) rep.skinVertices[ch.side] = fields[ci]!.get(skinPart.id)?.index.length ?? 0
  }
  // 有位移的皮肤范围，用来挑深层部件 / extent of the displaced skin, used to pick the deep parts
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const f of fields) {
    const s = f.get(skinPart.id)
    if (!s) continue
    for (const v of s.index) for (let c = 0; c < 3; c++) (box[c] = Math.min(box[c]!, skin.positions[v * 3 + c]!)), (box[c + 3] = Math.max(box[c + 3]!, skin.positions[v * 3 + c]!))
  }
  for (const e of eyes) for (let c = 0; c < 3; c++) (box[c] = Math.min(box[c]!, e.globe[c]! - e.radius - 0.01)), (box[c + 3] = Math.max(box[c + 3]!, e.globe[c]! + e.radius + 0.01))

  // —— 深层部件 / deep parts ——
  // 不动的：骨、牙、脑、眼球及其内容物（神经系统里组织为 organ / space 的部件）、皮肤上的其他小部件之外的皮肤本身已处理
  // left alone: bone, teeth, brain, the eyeball and its contents (parts of the nervous system with tissue organ / space)
  const DEPTH_FULL = 14 * MM, DEPTH_NONE = 20 * MM, BONE_FREE = 3 * MM
  const follows = (p: Part): boolean => {
    if (p.id === skinPart.id || !body.meshes.has(p.id)) return false
    if (isHard(p) || p.tissue === 'brain') return false
    if (p.system === 'nervous' && (p.tissue === 'organ' || p.tissue === 'space' || p.tissue === 'gland')) return false
    const b = p.bbox
    return b[3] > box[0]! - DEPTH_NONE && b[0] < box[3]! + DEPTH_NONE && b[4] > box[1]! - DEPTH_NONE && b[1] < box[4]! + DEPTH_NONE && b[5] > box[2]! - DEPTH_NONE && b[2] < box[5]! + DEPTH_NONE
  }
  const lidFollower = new RegExp(lidCfg.followers ?? '.', 'i')
  const deep = parts.filter(follows).sort((a, b) => (a.id < b.id ? -1 : 1))
  const byTissue: Record<string, number> = {}
  let displaced = 0
  for (const part of deep) {
    const m = body.meshes.get(part.id)!
    const n = m.positions.length / 3
    let any = false
    // 眉毛是贴在皮肤上的薄壳（内表面在皮肤下 0.5 mm）：每个顶点照搬它在皮肤上最近点处皮肤的全部位移（含厚度变化，不随深度和骨的远近衰减）。
    // 按一般深层部件处理时它不带厚度变化、近骨处还要衰减，皮肤一鼓起来（皱眉时的眉间）眉毛的内侧端就沉到皮肤下面，只剩碎片。
    // The eyebrow is a thin shell lying on the skin (its inner face 0.5 mm below the surface): every vertex copies the whole
    // displacement of the skin at its nearest skin point (thickness change included, no attenuation with depth or nearness to bone).
    // Treated as an ordinary deep part it gets no thickness change and is attenuated near bone, so wherever the skin bulges (the
    // glabella in a frown) the medial end of the brow sinks under the skin and only fragments remain.
    if (/eyebrow/i.test(part.name)) {
      for (let v = 0; v < n; v++) {
        const r = skinSurf.closestFace([m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]!])
        if (!r || r.distance > 6 * MM) continue
        const rr = r.verts.map((x) => regionOf[x]!)
        if (rr.some((x) => x < 0)) continue
        for (let ci = 0; ci < chans.length; ci++) {
          const U = skinU[ci]!
          const d: V3 = [0, 0, 0]
          for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) d[c] = d[c]! + r.bary[k]! * U[rr[k]! * 3 + c]!
          const before = fields[ci]!.get(part.id)?.index.length ?? 0
          put(ci, part.id, v, d)
          if ((fields[ci]!.get(part.id)?.index.length ?? 0) > before) any = true
        }
      }
      if (any) (displaced++), (byTissue[part.tissue] = (byTissue[part.tissue] ?? 0) + 1)
      continue
    }
    for (let v = 0; v < n; v++) {
      const p: V3 = [m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]!]
      if (p[0] < box[0]! - DEPTH_NONE || p[0] > box[3]! + DEPTH_NONE || p[1] < box[1]! - DEPTH_NONE || p[1] > box[4]! + DEPTH_NONE || p[2] < box[2]! - DEPTH_NONE || p[2] > box[5]! + DEPTH_NONE) continue
      const s = onSkin(p)
      if (s.distance >= DEPTH_NONE) continue
      const db = boneSurf.distance(p[0], p[1], p[2], BONE_FREE)
      const k = (1 - smooth((s.distance - DEPTH_FULL) / (DEPTH_NONE - DEPTH_FULL))) * smooth(Math.min(1, db / BONE_FREE))
      if (k <= 0) continue
      // 眶内、眼球赤道之后的点不动（眼外肌、泪腺）/ points inside the orbit behind the equator of the globe stay put (extraocular muscles, lacrimal gland)
      if (!lidFollower.test(part.name) && eyes.some((e) => p[2] < e.globe[2] + 0.3 * e.radius && Math.hypot(p[0] - e.globe[0], p[1] - e.globe[1], p[2] - e.globe[2]) < e.radius + 12 * MM)) continue
      // 与皮肤之间隔着骨的点不动（颅内的硬脑膜、口腔里的结构）/ points with bone between them and the skin stay put (dura inside the skull, structures inside the mouth)
      if (boneSurf.crossings(p, s.point, 0.2 * MM) > 0) continue
      for (let ci = 0; ci < chans.length; ci++) {
        const ch = chans[ci]!
        // 眼睑通道按点本身的位置求值，不随深度衰减（睑板、睑部肌肉要完整地合上）
        // lid channels are evaluated at the point itself and are not attenuated with depth (tarsal plates and lid muscle must close completely)
        if (ch.def.model === 'lid' && !lidFollower.test(part.name)) continue
        const d = ch.def.model === 'lid' ? ch.field(p, s.normal, p, true) : mul(ch.field(s.point, s.normal, p, true), k)
        const before = fields[ci]!.get(part.id)?.index.length ?? 0
        put(ci, part.id, v, d)
        if ((fields[ci]!.get(part.id)?.index.length ?? 0) > before) any = true
      }
    }
    if (any) (displaced++), (byTissue[part.tissue] = (byTissue[part.tissue] ?? 0) + 1)
  }
  // 舌的姿势直接写到舌上；唇的几何通道：深层的唇和口轮匝肌跟随同侧最近的皮肤顶点（3 mm 内完全跟随，8 mm 处为 0）
  // tongue poses are written straight onto the tongue; geometric lip channels: the deep lips and orbicularis oris follow the nearest skin vertex of their own side (fully within 3 mm, nothing at 8 mm)
  for (const [ci, ch] of chans.entries()) {
    for (const [part, table] of ch.deepTables ?? []) for (const v of [...table.keys()].sort((a, b) => a - b)) put(ci, part, v, table.get(v)!)
    if (!ch.skinTable || ch.skinTable.size === 0) continue
    const keys = [...ch.skinTable.keys()], kp = keys.map(P3)
    for (const part of parts.filter((p) => body.meshes.has(p.id) && (isLipPart(p) || (isMuscle(p) && /^orbicularis oris$/i.test(p.name)))).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const m = body.meshes.get(part.id)!
      for (let v = 0; v < m.positions.length / 3; v++) {
        const p: V3 = [m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]!]
        const up = p[1] > (deepSt ?? skinSt)
        let best = -1, bd = 8 * MM
        for (let i = 0; i < keys.length; i++) {
          const q = kp[i]!
          if (Math.abs(q[0] - p[0]) > bd || Math.abs(q[1] - p[1]) > bd || upperSide.get(keys[i]!) !== up) continue
          const dd = len(sub(q, p))
          if (dd < bd) (bd = dd), (best = i)
        }
        if (best >= 0) put(ci, part.id, v, mul(ch.skinTable.get(keys[best]!)!, 1 - smooth((bd - 3 * MM) / (5 * MM))))
      }
    }
  }
  log(`deep parts: ${deep.length} considered, ${displaced} displaced`)

  // 深层部件上最大位移不到 0.25 mm 的场不存：看不出来，却会让上百个部件多出一个变形
  // fields on deep parts whose largest displacement is under 0.25 mm are dropped: invisible, yet they would give a hundred more parts a deformation
  const MIN_FIELD = 0.25 * MM
  for (const f of fields) {
    for (const [part, s] of [...f]) {
      if (part === skinPart.id) continue
      let m = 0
      for (let i = 0; i < s.index.length; i++) m = Math.max(m, Math.hypot(s.delta[i * 3]!, s.delta[i * 3 + 1]!, s.delta[i * 3 + 2]!))
      if (m < MIN_FIELD) f.delete(part)
    }
  }

  // —— 写 face.bin / write face.bin ——
  let bytes = 0
  for (const f of fields) for (const s of f.values()) bytes += Math.ceil((s.index.length * 10) / 4) * 4
  const bin = new Uint8Array(bytes)
  const dv = new DataView(bin.buffer)
  let off = 0, entries = 0
  const perPart = new Map<string, number>()
  // 通道的幅度：精编的切向幅度和实际算出的最大位移中较大的一个。眼睑通道只有后者（各列睑裂高度不同，沿眼球滑动还带来前后分量）；
  // 其余通道的实际位移可以略大于切向幅度，因为还叠加了沿法线的厚度变化。
  // A channel's excursion: the larger of the curated tangential excursion and the largest displacement actually computed. Lid channels
  // have only the latter (the aperture differs per column and sliding over the globe adds a depth component); for the others the
  // actual displacement can slightly exceed the tangential excursion because the thickness change along the normal is added.
  const fieldMax = (ci: number): number => {
    let m = 0
    for (const s of fields[ci]!.values()) for (let i = 0; i < s.index.length; i++) m = Math.max(m, Math.hypot(s.delta[i * 3]!, s.delta[i * 3 + 1]!, s.delta[i * 3 + 2]!))
    return m
  }
  const channels: FaceChannel[] = chans.map((ch, ci) => {
    const out: FaceField[] = []
    for (const part of [...fields[ci]!.keys()].sort((a, b) => (a === skinPart.id ? -1 : b === skinPart.id ? 1 : a < b ? -1 : 1))) {
      const s = fields[ci]!.get(part)!
      let scale = 0
      for (const x of s.delta) scale = Math.max(scale, Math.abs(x))
      scale = +scale.toPrecision(6)
      const count = s.index.length
      for (let i = 0; i < count; i++) dv.setUint32(off + i * 4, s.index[i]!, true)
      for (let i = 0; i < count * 3; i++) dv.setInt16(off + count * 4 + i * 2, Math.max(-Q, Math.min(Q, Math.round((s.delta[i]! / scale) * Q))), true)
      out.push({ part, offset: off, count, scale })
      off += Math.ceil((count * 10) / 4) * 4
      entries += count
      perPart.set(part, (perPart.get(part) ?? 0) + count)
    }
    const r6 = (p: Vec3): Vec3 => [+p[0].toFixed(6), +p[1].toFixed(6), +p[2].toFixed(6)]
    return {
      id: ch.id,
      muscle: ch.def.id,
      name: ch.def.name,
      kind: ch.def.model,
      side: ch.side,
      parts: ch.parts.map((p) => p.id),
      line: { origin: r6(ch.line.origin), insertion: r6(ch.line.insertion), originOnSkin: r6(ch.line.originOnSkin), insertionOnSkin: r6(ch.line.insertionOnSkin) },
      basis: ch.basis,
      excursion: +Math.max(ch.def.model === 'lid' ? 0 : ch.excursion, fieldMax(ci)).toFixed(6),
      fields: out,
      ...(ch.refJaw !== undefined ? { refJaw: ch.refJaw } : {}),
    }
  })

  // 上界：单个通道的最大位移；所有通道全激活时每个顶点位移模长之和的最大值
  // bounds: the largest displacement of one channel; the largest per-vertex sum of magnitudes with every channel fully active
  let maxChannel = 0
  const sum = new Map<string, Float64Array>()
  for (const [ci] of chans.entries()) {
    for (const [part, s] of fields[ci]!) {
      let acc = sum.get(part)
      if (!acc) sum.set(part, (acc = new Float64Array(body.meshes.get(part)!.positions.length / 3)))
      for (let i = 0; i < s.index.length; i++) {
        const l = Math.hypot(s.delta[i * 3]!, s.delta[i * 3 + 1]!, s.delta[i * 3 + 2]!)
        maxChannel = Math.max(maxChannel, l)
        acc[s.index[i]!] = acc[s.index[i]!]! + l
      }
    }
  }
  let maxTotal = 0
  for (const acc of sum.values()) for (const x of acc) maxTotal = Math.max(maxTotal, x)

  // —— AU、疼痛映射 / AUs and the pain mapping ——
  const jawJoint = rig.joints.find((j) => j.id === curated.muscles.jaw.joint)
  const jawMax = jawJoint?.dofs[curated.muscles.jaw.dof]?.max ?? 0
  const visemeJaw = visemeJawForBody(body, rig, opts.rigBin, curated, jawMax)
  const aus: FaceAU[] = curated.aus.aus.map((a) => {
    const ch: Record<string, number> = {}
    const missing = [...(a.missing ?? [])]
    for (const [muscle, w] of Object.entries(a.channels)) {
      const cs = channels.filter((c) => c.muscle === muscle)
      // 替代通道（口裂内陷、口角成形）只在各自适用的皮肤上有，缺了不算缺肌肉 / the stand-in channels (oral recess, corner shaping) exist only on the skin they apply to; their absence is not a missing muscle
      const standIn = defs.find((x) => x.id === muscle)?.model
      if (cs.length === 0 && standIn !== 'recess' && standIn !== 'corner' && standIn !== 'lip' && standIn !== 'tongue') missing.push(`${muscle} (no channel in this body)`)
      for (const c of cs) ch[c.id] = w
    }
    return { id: a.id, name: a.name, channels: ch, ...(a.jawFraction ? { jaw: +(a.jawFraction * jawMax).toFixed(5) } : {}), ...(missing.length ? { missing } : {}), basis: a.basis }
  })
  const jawRe = (names: string[]): string[] => parts.filter((p) => isMuscle(p) && names.some((n) => p.name.toLowerCase().includes(n))).map((p) => p.id).sort()

  // —— 皮肤分辨率 / skin resolution ——
  const inFace = (v: number): boolean => skin.positions[v * 3 + 1]! > faceMinY && skin.positions[v * 3 + 1]! < faceMaxY && skin.positions[v * 3 + 2]! > faceMinZ
  const regionDefs: Record<string, (x: number, y: number, z: number) => boolean> = {}
  for (const e of eyes) regionDefs[`eye_${e.side} (40 × 30 mm round the globe)`] = (x, y, z) => Math.abs(x - e.globe[0]) < 20 * MM && Math.abs(y - e.globe[1]) < 15 * MM && z > e.globe[2]
  regionDefs['glabella and brows (between and 25 mm above the eyes)'] = (x, y, z) => eyes.length > 0 && Math.abs(x - midX) < 45 * MM && y > eyeY + 8 * MM && y < eyeY + 33 * MM && z > eyes[0]!.globe[2] - 10 * MM
  if (oris) regionDefs['mouth (orbicularis oris box)'] = (x, y, z) => x > oris.bbox[0] && x < oris.bbox[3] && y > oris.bbox[1] && y < oris.bbox[4] && z > oris.bbox[2] - 5 * MM
  regionDefs['nose and upper lip (midline ± 20 mm, stomion to eye level)'] = (x, y, z) => Math.abs(x - midX) < 20 * MM && y > skinSt && y < eyeY && z > (oris ? oris.bbox[2] : faceMinZ)
  const edgeStats = (pred: (v: number) => boolean): { vertices: number; meanEdgeMm: number } => {
    let nv = 0, es = 0, en = 0
    for (let v = 0; v < skinN; v++) if (pred(v)) nv++
    for (let t = 0; t < skinTri.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = skinTri[t + k]!, b = skinTri[t + ((k + 1) % 3)]!
        if (!pred(a) || !pred(b)) continue
        es += Math.hypot(skin.positions[a * 3]! - skin.positions[b * 3]!, skin.positions[a * 3 + 1]! - skin.positions[b * 3 + 1]!, skin.positions[a * 3 + 2]! - skin.positions[b * 3 + 2]!)
        en++
      }
    }
    return { vertices: nv, meanEdgeMm: en ? +((es / en) / MM).toFixed(2) : 0 }
  }
  const perRegion: FaceReport['skin']['perRegion'] = {}
  for (const [name, f] of Object.entries(regionDefs)) perRegion[name] = edgeStats((v) => f(skin.positions[v * 3]!, skin.positions[v * 3 + 1]!, skin.positions[v * 3 + 2]!))
  const faceStats = edgeStats(inFace)
  let headVertices = 0
  for (let v = 0; v < skinN; v++) if (skin.positions[v * 3 + 1]! > faceMinY) headVertices++

  // —— 左右对称性 / left–right symmetry ——
  const symmetry: FaceReport['symmetry'] = []
  for (const d of defs) {
    const li = chans.findIndex((c) => c.def.id === d.id && c.side === 'L'), ri = chans.findIndex((c) => c.def.id === d.id && c.side === 'R')
    if (li < 0 || ri < 0) continue
    const stat = (ci: number, sgn: number): { n: number; mean: V3; mag: number } => {
      const s = fields[ci]!.get(skinPart.id)
      const mean: V3 = [0, 0, 0]
      let mag = 0
      if (!s || !s.index.length) return { n: 0, mean, mag }
      for (let i = 0; i < s.index.length; i++) {
        ;(mean[0] += s.delta[i * 3]! * sgn), (mean[1] += s.delta[i * 3 + 1]!), (mean[2] += s.delta[i * 3 + 2]!)
        mag += Math.hypot(s.delta[i * 3]!, s.delta[i * 3 + 1]!, s.delta[i * 3 + 2]!)
      }
      return { n: s.index.length, mean: mul(mean, 1 / s.index.length), mag: mag / s.index.length }
    }
    const l = stat(li, 1), r = stat(ri, -1)
    symmetry.push({ muscle: d.id, countL: l.n, countR: r.n, meanMmL: +(l.mag / MM).toFixed(3), meanMmR: +(r.mag / MM).toFixed(3), mirroredMeanDiffMm: +(len(sub(l.mean, r.mean)) / MM).toFixed(3) })
  }

  const skinEyeOffset = eyeReport.map((e) => e.skinFissureMm).filter((x): x is NonNullable<typeof x> => !!x)
  const offX = skinEyeOffset.length ? Math.max(...skinEyeOffset.map((x) => Math.abs(x.centreVsGlobeX))) : 0
  const offY = skinEyeOffset.length ? Math.max(...skinEyeOffset.map((x) => Math.abs(((x.upperVsDeep ?? 0) + (x.lowerVsDeep ?? 0)) / 2))) : 0
  const cautions: Bilingual[] = [
    { zh: '这是疼痛行为（面部表情）的计算模型，用于教学；模拟人并没有主观感受。从疼痛强度到各动作单元强度的数值是构造的一种典型组合，没有出处；真人的疼痛表情因人而异。', en: 'This is a computational model of pain behaviour (the facial expression) for teaching; the simulated body has no subjective experience. The numbers from pain intensity to action unit intensities are one constructed canonical pattern without a source; real pain faces differ between people.' },
    O
      ? { zh: '皮肤有真实的睑裂和口裂。睑缘内卷和口腔袋是构造物，不是解剖：它们只是为了开口时不露出头内的空腔。闭眼时上睑缘沿眼球表面落到下睑缘上；位移场是线性的，半闭时睑缘走在弦上，比真实的弧形路径略高。张口时口角附近的唇缘由“口角成形”通道拉成杏仁形，这个通道的激活应等于下颌张开角与其上限之比。', en: 'The skin has real eye and mouth openings. The lid rims and the oral pouch are construction aids, not anatomy: they only keep the hollow inside of the head from showing. On eye closure the upper lid margin comes down onto the lower along the globe\'s surface; the field is linear, so half-closed the margin is on a chord, slightly proud of the true arc. On mouth opening the lip margins near the corners are shaped into an almond by the corner-shaping channel, whose activation should equal the jaw opening divided by its limit.' }
      : { zh: '皮肤是一张连续的面，没有睑裂和口裂，也没有眼球和口腔内面。闭眼：上睑的皮肤滑下来盖住两睑之间那片皮肤，睑裂的形状合上，但没有真正的睑缘。张口：唇不能分开，两唇之间的皮肤被拉成一个向口内凹陷的膜，看不到牙齿；真正的张口要在肌肉视图里看。', en: 'The skin is one continuous surface with no eye or mouth opening and no eyeball or mouth interior. Eye closure: upper-lid skin slides down over the patch of skin between the lids, so the shape of the fissure closes, but there are no true lid margins. Mouth opening: the lips cannot part; the skin between them is stretched into a membrane recessed into the mouth, and no teeth show. Real mouth opening is seen in the muscle view.' },
    { zh: `面部皮肤约 ${faceStats.vertices} 个顶点（平均边长 ${faceStats.meanEdgeMm} mm）：能表现皮肤的整体移动和被挤压处的鼓起，但画不出皱纹——眉间纵纹、鼻背皱纹、鱼尾纹都没有，鼻唇沟只是一道平缓的隆起。`, en: `The facial skin has about ${faceStats.vertices} vertices (mean edge ${faceStats.meanEdgeMm} mm): it shows the bulk movement of the skin and the bulging where it is squeezed, but no wrinkles — no glabellar furrows, nose wrinkles or crow's feet, and the nasolabial furrow is only a gentle ridge.` },
    { zh: '每个通道的位移场是线性的、互相叠加：皮肤沿切面滑动，外加一阶的厚度变化（挤压处增厚）；没有屈曲，没有组织之间的碰撞，几个动作单元同时全强度时口周和鼻旁的皮肤会互相穿插、出现锯齿。深层部件跟随其上方的皮肤，肌肉会缩短但不会变粗。全激活时的位移幅度、作用范围和各动作单元里的肌肉权重都是假设。', en: 'Each channel\'s displacement field is linear and the fields add: the skin slides in its tangent plane, plus a first-order change of thickness (thickening where squeezed); there is no buckling and no collision between tissues, and with several action units at full intensity the skin round the mouth and beside the nose interpenetrates and turns jagged. Deep parts follow the skin above them, and muscles shorten without thickening. Excursions at full activation, zones of influence and the muscle weights within each action unit are assumptions.' },
    { zh: '数据里没有降眉肌、降鼻中隔肌和上睑板肌；AU4 只由皱眉肌和降眉间肌驱动。', en: 'The data has no depressor supercilii, depressor septi nasi or superior tarsal muscle; AU4 is driven by corrugator supercilii and procerus only.' },
  ]
  if (offX > 2 || offY > 2) cautions.push({ zh: `皮肤上的眼和深层的眼球没有对齐：皮肤睑裂的中点比眼球中心偏外侧最多 ${offX.toFixed(1)} mm，睑缘的高度相差最多 ${offY.toFixed(1)} mm。皮肤和深层的眼睑各按自己的位置开合，所以皮肤半透明时两层的眼睑对不上。`, en: `The eye on the skin and the deep globe are not aligned: the middle of the skin's fissure lies up to ${offX.toFixed(1)} mm lateral to the globe centre, and the lid margins differ in height by up to ${offY.toFixed(1)} mm. Skin and deep lids each open and close where they are, so with a see-through skin the two layers of lids do not coincide.` })
  if (eyeReport.some((e) => e.rings && !e.rings.namesAgreeWithSize)) cautions.push({ zh: '眼轮匝肌两个部件的名字与环的大小不符（名为“睑部”的不是较小的内环）；本层按名字使用它们，眼周的结果不可信。', en: 'The names of the two orbicularis oculi parts disagree with their ring sizes (the part named "palpebral" is not the smaller, inner ring); this layer uses them by name, so the result round the eyes is not to be trusted.' })

  const fis = (m: { x0: number; step: number; lower: number[]; upper: number[] } | null): { x0: number; x1: number; aperture: number; lowerY: number; upperY: number } | null => (m ? { x0: +m.x0.toFixed(6), x1: +(m.x0 + m.step * (m.lower.length - 1)).toFixed(6), aperture: +Math.max(...m.lower.map((l, i) => m.upper[i]! - l)).toFixed(6), lowerY: +Math.min(...m.lower).toFixed(6), upperY: +Math.max(...m.upper).toFixed(6) } : null)
  const face: FaceData = {
    schema: 1,
    body: bodyId,
    note: { zh: '由面部肌肉的解剖几何驱动的参数化面部表情：肌肉激活 → 皮肤和深层部件的位移；FACS 动作单元是肌肉激活的组合；疼痛强度映射到动作单元强度。这是疼痛行为的计算模型，用于教学；模拟人并没有主观感受。没有使用任何真人面部数据。', en: 'A parametric facial expression driven by the anatomical geometry of the facial muscles: muscle activation → displacement of the skin and deep parts; FACS action units are combinations of muscle activations; pain intensity maps to action unit intensities. This is a computational model of pain behaviour for teaching; the simulated body has no subjective experience. No data of real faces was used.' },
    skin: skinPart.id,
    ...(O ? { openings: 'face/openings.json' } : {}),
    inputs: {},
    binBytes: bin.length,
    parts: [...perPart.keys()].sort((a, b) => (a === skinPart.id ? -1 : b === skinPart.id ? 1 : a < b ? -1 : 1)).map((id) => ({ part: id, vertexCount: body.meshes.get(id)!.positions.length / 3, entries: perPart.get(id)! })),
    channels,
    aus,
    ...(curated.emotions ? { expressions: curated.emotions.emotions } : {}),
    ...(curated.visemes ? { visemes: { timing: curated.visemes.timing, features: curated.visemes.features, visemes: visemeJaw.visemes } } : {}),
    pain: { pspi: { terms: curated.pain.pspi.terms, binary: curated.pain.pspi.binary, max: curated.pain.pspi.max, basis: curated.pain.pspi.basis }, keyframes: curated.pain.keyframes, mapping: curated.pain.mapping, timing: curated.pain.timing },
    jaw: { joint: curated.muscles.jaw.joint, dof: curated.muscles.jaw.dof, max: jawMax, closers: jawRe(curated.muscles.jaw.closers), openers: jawRe(curated.muscles.jaw.openers) },
    bounds: { channel: +(Math.ceil(Math.max(maxChannel, ...channels.map((c) => c.excursion)) / MM * 10) / 10 * MM).toFixed(4), total: +(Math.ceil(maxTotal / MM * 10) / 10 * MM).toFixed(4) },
    landmarks: {
      midX: +midX.toFixed(6),
      stomionY: { skin: +skinSt.toFixed(6), deep: deepSt === null ? null : +deepSt.toFixed(6) },
      eyes: eyes.map((e) => ({ side: e.side, globe: [+e.globe[0].toFixed(6), +e.globe[1].toFixed(6), +e.globe[2].toFixed(6)] as Vec3, radius: +e.radius.toFixed(6), fissure: fis(e.margins), skinFissure: e.skinMargins ? { ...fis(e.skinMargins)!, ...(O ? { lower: e.skinMargins.lower.map((y, i) => [+(e.skinMargins!.x0 + i * e.skinMargins!.step).toFixed(6), +y.toFixed(6)] as [number, number]).filter((_, i, a) => i % 4 === 0 || i === a.length - 1) } : {}) } : null })),
    },
    sources: curated.sources.sources,
    cautions,
  }
  const rep: FaceReport = {
    visemeJaw: visemeJaw.report,
    body: bodyId,
    skin: { part: skinPart.id, vertices: skinN, headVertices, faceVertices: faceStats.vertices, faceMeanEdgeMm: faceStats.meanEdgeMm, perRegion },
    muscles: report,
    unmatched,
    eyes: eyeReport,
    stomion: { skinY: +skinSt.toFixed(5), deepY: deepSt === null ? null : +deepSt.toFixed(5), differenceMm: deepSt === null ? null : +((skinSt - deepSt) / MM).toFixed(2) },
    deepParts: { considered: deep.length, displaced, byTissue },
    entries,
    binBytes: bin.length,
    openings: O ? { lidClearance, rimVertices: O.lidRims.reduce((n, r) => n + r.vertices.length, 0), pouchVertices: O.oralPouch.upper.length + O.oralPouch.lower.length + O.oralPouch.seam.length } : null,
    mouth: O ? mouthRep : null,
    symmetry,
  }
  return { face, bin, report: rep }
}
