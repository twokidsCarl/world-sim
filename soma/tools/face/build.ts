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

import type { Part, Rig, Side, Vec3 } from '../../src/anatomy/types.ts'
import type { Bilingual, FaceAU, FaceChannel, FaceChannelKind, FaceData, FaceField, FaceSource, PainModel, Sourced } from '../../src/face/types.ts'
import { Surface, mergeMeshes } from '../rig/geom.ts'
import type { Body, RawMesh } from '../rig/io.ts'
import { type V3, add, cross, dot, len, mul, norm, sub } from '../rig/math.ts'
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
  lid?: 'upper' | 'lower'
  sectors?: { inferior: number; lateral: number; superior: number; medial: number }
}

export interface Curated {
  muscles: {
    muscles: MuscleDef[]
    bulge?: { gain: number; minMm: number; maxMm: number; limitMm: number; smoothing: number; creasePasses?: number }
    lid: { closureFraction: number; upperLidHeightMm: number; lowerLidHeightMm: number; overlapMm?: number; followers?: string }
    jaw: { joint: string; dof: number; closers: string[]; openers: string[] }
    missing: { name: string; note: Bilingual }[]
  }
  aus: { aus: { id: string; name: Bilingual; channels: Record<string, number>; jawFraction?: number; missing?: string[]; basis: Sourced }[] }
  pain: { pspi: PainModel['pspi'] & { formula: string }; keyframes: PainModel['keyframes']; mapping: Sourced; timing: PainModel['timing'] }
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
  symmetry: { muscle: string; countL: number; countR: number; meanMmL: number; meanMmR: number; mirroredMeanDiffMm: number }[]
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

export function buildFace(body: Body, rig: Rig, curated: Curated, log: (m: string) => void): { face: FaceData; bin: Uint8Array; report: FaceReport } {
  const parts = body.data.parts
  const bodyId = body.data.body
  // —— 皮肤 / the skin ——
  const skinPart = parts.filter((p) => p.tissue === 'skin' && p.system === 'integumentary' && body.meshes.has(p.id)).sort((a, b) => b.triangles - a.triangles || (a.id < b.id ? -1 : 1))[0]
  if (!skinPart) throw new Error('face: no skin part')
  const skin = body.meshes.get(skinPart.id)!
  const skinN = skin.positions.length / 3

  // —— 肌肉部件按精编条目匹配 / muscle parts matched to the curated entries ——
  const defs = curated.muscles.muscles
  const isMuscle = (p: Part): boolean => p.tissue === 'muscle' && body.meshes.has(p.id)
  const matched = new Map<string, Part[]>()
  const unmatched: FaceReport['unmatched'] = []
  for (const d of defs) {
    const re = new RegExp(d.match, 'i')
    const ps = d.model === 'recess' ? [] : parts.filter((p) => isMuscle(p) && re.test(p.name)).sort((a, b) => (a.id < b.id ? -1 : 1))
    matched.set(d.id, ps)
    if (ps.length === 0 && d.model !== 'recess') unmatched.push({ id: d.id, why: `no muscle part matches /${d.match}/i` })
  }
  const facial = [...new Set([...matched.values()].flat())]
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
  for (let t = 0; t < skin.indices.length; t += 3) {
    const a = skin.indices[t]!, b = skin.indices[t + 1]!, c = skin.indices[t + 2]!
    if (skin.positions[a * 3 + 1]! > regionMinY - 0.03 || skin.positions[b * 3 + 1]! > regionMinY - 0.03 || skin.positions[c * 3 + 1]! > regionMinY - 0.03) subIdx.push(a, b, c)
  }
  const skinSurf = new Surface({ positions: skin.positions, indices: Uint32Array.from(subIdx) })
  // 平滑 6 遍：口裂、睑缘的褶皱里法线很乱，不平滑的话相邻顶点的滑动方向会互相打架，拉出尖刺
  // six smoothing passes: inside the creases at the mouth and the lid margins the normals are erratic, and unsmoothed they make neighbouring vertices slide in conflicting directions and pull out spikes
  const normals = vertexNormals(skin, 6)
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
    const lidParts = parts.filter((p) => body.meshes.has(p.id) && (/orbicularis oculi/i.test(p.name) || /tarsal plate/i.test(p.name)) && (p.centroid[0] - midX) * sgn > 0)
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
    {
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
  const lipPart = parts.filter((p) => /^lip$/i.test(p.name) && body.meshes.has(p.id))[0] ?? null
  let deepSt: number | null = null
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

  // 口角轴到正中的距离：唇部件（没有则口轮匝肌的 0.8）的半宽加 3 mm / distance of the modiolus from the midline: half-width of the lip part (or 0.8 of orbicularis oris) plus 3 mm
  const modiolusOffset = lipPart ? (lipPart.bbox[3] - lipPart.bbox[0]) / 2 + 3 * MM : oris ? ((oris.bbox[3] - oris.bbox[0]) / 2) * 0.8 + 3 * MM : null

  // 皮肤上两唇相贴的那道褶：每一列（x）前表面最凹处，从正中向两侧逐列跟踪
  // the crease where the lips meet on the skin: the deepest point of the front surface in each column (x), tracked outwards from the midline
  const lipCrease = (() => {
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

  // —— 通道 / channels ——
  interface Chan {
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
      if (k === 'aboveStomion') m *= smooth((p[1] - (st - hw)) / (2 * hw))
      else if (k === 'belowStomion') m *= 1 - smooth((p[1] - (st - hw)) / (2 * hw))
      // 眉部肌肉带动的皮肤一直到上睑缘上方（眉下的皮肤是挂在眉上的）；颊部肌肉带动的到下睑缘下方为止
      // brow muscles carry the skin down to just above the upper lid margin (the skin under the brow hangs from it); cheek muscles carry it up to just below the lower lid margin
      else if (k === 'aboveEye') m *= smooth((p[1] - ((deep ? lidDeep : lidSkin).top - 2 * MM)) / (5 * MM))
      else if (k === 'belowEye') m *= 1 - smooth((p[1] - ((deep ? lidDeep : lidSkin).bottom - 7 * MM)) / (6 * MM))
    }
    return m
  }
  const mirror = (p: V3, sgn: number): V3 => [midX + (p[0] - midX) * sgn, p[1], p[2]]

  for (const d of defs) {
    const ps = matched.get(d.id)!
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
        const field: Field = (q, n, p, deep) => {
          const r = sub(q, os)
          const t = dot(r, e)
          if (t <= 0 || t > L2 + carry + reach) return [0, 0, 0]
          let perp2 = dot(r, r) - t * t
          // 作用线下方的皮肤挂在它上面：向下多带 hang 这么远 / skin below the line hangs from it: it is carried `hang` further down
          if (hang > 0 && r[1] - t * e[1] < 0) perp2 = Math.max(0, Math.sqrt(Math.max(0, perp2)) - hang) ** 2
          if (perp2 >= R2 * R2) return [0, 0, 0]
          const along = t <= L2 ? smooth(t / L2) : 1 - smooth((t - L2 - carry) / reach)
          const lat = (1 - perp2 / (R2 * R2)) ** 2
          // 只作用于与活动端同一侧的皮肤（法线方向相近），否则宽阔的颈阔肌会带动项部
          // only skin facing the same way as the mobile end (similar normal) is moved; otherwise the wide platysma would drag the nape
          const facing = smooth((dot(n, nI) + 0.2) / 0.7)
          const w = along * lat * facing * mask(d, p, deep)
          if (w <= 0) return [0, 0, 0]
          // 沿皮肤切面滑动整个幅度：切向分量重新归一（皮肤法线几乎与作用线平行时逐渐归零），
          // 否则皮肤离肌肉远、作用线斜穿过软组织时（厚的颊部），位移会被投影吃掉一截。
          // Slide by the full excursion within the tangent plane: the tangential direction is renormalised (fading out where the skin normal
          // is nearly parallel to the line); otherwise, where the skin lies far from the muscle and the line cuts obliquely through
          // soft tissue (a thick cheek), the projection would swallow part of the displacement.
          const tg = tangent(mul(e, -1), n)
          const tl = len(tg)
          if (tl < 1e-6) return [0, 0, 0]
          return mul(tg, (E * w * smooth(tl / 0.5)) / tl)
        }
        const id = s === 'M' ? d.id : `${d.id}_${s}`
        chans.push({ def: d, id, side: s, parts: ps.filter((p) => p.side === s), line: { origin: o as Vec3, insertion: i as Vec3, originOnSkin: os as Vec3, insertionOnSkin: is as Vec3 }, basis, excursion: E, field })
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
          const facing = smooth((dot(n, nC) + 0.2) / 0.7)
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
        if (!e.margins || !e.inner) {
          unmatched.push({ id: `${d.id}_${e.side}`, why: 'no palpebral fissure found on the lid meshes' })
          continue
        }
        const upper = d.lid === 'upper'
        const G = e.globe, r0 = e.radius
        const hUp = lidCfg.upperLidHeightMm * MM, hLow = lidCfg.lowerLidHeightMm * MM
        const sm = e.skinMargins
        const field: Field = (_q, _n, p, deep) => {
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
  for (let t = 0; t < skin.indices.length; t += 3) {
    const a2 = regionOf[skin.indices[t]!]!, b2 = regionOf[skin.indices[t + 1]!]!, c2 = regionOf[skin.indices[t + 2]!]!
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
  const rawNormals = vertexNormals(skin, 0)
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
  for (let ci = 0; ci < chans.length; ci++) {
    const ch = chans[ci]!
    const U = new Float64Array(nr * 3)
    for (let r = 0; r < nr; r++) {
      const v = regionVerts[r]!
      const p: V3 = [skin.positions[v * 3]!, skin.positions[v * 3 + 1]!, skin.positions[v * 3 + 2]!]
      const n: V3 = [normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!]
      const d = ch.field(p, n, p, false)
      ;(U[r * 3] = d[0]), (U[r * 3 + 1] = d[1]), (U[r * 3 + 2] = d[2])
    }
    if (ch.def.model !== 'lid' && ch.def.model !== 'recess' && bulge.gain > 0) {
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
        const w = Math.max(-lim, Math.min(lim, -bulge.gain * cover[r]! * div[r]!))
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
    if (ch.def.model !== 'lid' && ch.def.model !== 'recess') {
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
    for (let r = 0; r < nr; r++) put(ci, skinPart.id, regionVerts[r]!, [U[r * 3]!, U[r * 3 + 1]!, U[r * 3 + 2]!])
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
  const aus: FaceAU[] = curated.aus.aus.map((a) => {
    const ch: Record<string, number> = {}
    const missing = [...(a.missing ?? [])]
    for (const [muscle, w] of Object.entries(a.channels)) {
      const cs = channels.filter((c) => c.muscle === muscle)
      if (cs.length === 0) missing.push(`${muscle} (no channel in this body)`)
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
    for (let t = 0; t < skin.indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = skin.indices[t + k]!, b = skin.indices[t + ((k + 1) % 3)]!
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
    { zh: '皮肤是一张连续的面，没有睑裂和口裂，也没有眼球和口腔内面。闭眼：上睑的皮肤滑下来盖住两睑之间那片皮肤，睑裂的形状合上，但没有真正的睑缘。张口：唇不能分开，两唇之间的皮肤被拉成一个向口内凹陷的膜，看不到牙齿；真正的张口要在肌肉视图里看。', en: 'The skin is one continuous surface with no eye or mouth opening and no eyeball or mouth interior. Eye closure: upper-lid skin slides down over the patch of skin between the lids, so the shape of the fissure closes, but there are no true lid margins. Mouth opening: the lips cannot part; the skin between them is stretched into a membrane recessed into the mouth, and no teeth show. Real mouth opening is seen in the muscle view.' },
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
    inputs: {},
    binBytes: bin.length,
    parts: [...perPart.keys()].sort((a, b) => (a === skinPart.id ? -1 : b === skinPart.id ? 1 : a < b ? -1 : 1)).map((id) => ({ part: id, vertexCount: body.meshes.get(id)!.positions.length / 3, entries: perPart.get(id)! })),
    channels,
    aus,
    pain: { pspi: { terms: curated.pain.pspi.terms, binary: curated.pain.pspi.binary, max: curated.pain.pspi.max, basis: curated.pain.pspi.basis }, keyframes: curated.pain.keyframes, mapping: curated.pain.mapping, timing: curated.pain.timing },
    jaw: { joint: curated.muscles.jaw.joint, dof: curated.muscles.jaw.dof, max: jawMax, closers: jawRe(curated.muscles.jaw.closers), openers: jawRe(curated.muscles.jaw.openers) },
    bounds: { channel: +(Math.ceil(Math.max(maxChannel, ...channels.map((c) => c.excursion)) / MM * 10) / 10 * MM).toFixed(4), total: +(Math.ceil(maxTotal / MM * 10) / 10 * MM).toFixed(4) },
    landmarks: {
      midX: +midX.toFixed(6),
      stomionY: { skin: +skinSt.toFixed(6), deep: deepSt === null ? null : +deepSt.toFixed(6) },
      eyes: eyes.map((e) => ({ side: e.side, globe: [+e.globe[0].toFixed(6), +e.globe[1].toFixed(6), +e.globe[2].toFixed(6)] as Vec3, radius: +e.radius.toFixed(6), fissure: fis(e.margins), skinFissure: fis(e.skinMargins) })),
    },
    sources: curated.sources.sources,
    cautions,
  }
  const rep: FaceReport = {
    body: bodyId,
    skin: { part: skinPart.id, vertices: skinN, headVertices, faceVertices: faceStats.vertices, faceMeanEdgeMm: faceStats.meanEdgeMm, perRegion },
    muscles: report,
    unmatched,
    eyes: eyeReport,
    stomion: { skinY: +skinSt.toFixed(5), deepY: deepSt === null ? null : +deepSt.toFixed(5), differenceMm: deepSt === null ? null : +((skinSt - deepSt) / MM).toFixed(2) },
    deepParts: { considered: deep.length, displaced, byTissue },
    entries,
    binBytes: bin.length,
    symmetry,
  }
  return { face, bin, report: rep }
}
