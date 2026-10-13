// 装入开口后的皮肤包时，男女两条构建线共用的部分（包的读取、选择、简化、闭合见 skinPackage.ts）：
//   · 下标对照文件 skin-source.u32：发布的皮肤的每个顶点（按 GLB 解码次序）→ 包里 skin.obj 的顶点下标；
//   · pipeline-report.json 的 skinPackage.opened：按标签的顶点数、边界环、移植片及其来源、量化在唇部的后果、过渡环的质量；
//   · anatomy.json 里皮肤部件由什么构成、要加哪些数据源、要写哪些说明。
// 这里不按位置对应任何东西：上下唇缘的顶点成对重合，只有下标能区分。
//
// What the two builds share when they install an opened skin package (reading, choosing, simplifying and
// closing a package are in skinPackage.ts):
//   · the index sidecar skin-source.u32: every vertex of the shipped skin (in GLB decode order) → its
//     vertex index in the package's skin.obj;
//   · skinPackage.opened of pipeline-report.json: vertex counts by tag, boundary loops, the grafts and
//     where they come from, what the quantisation does at the lips, the quality of the blend rings;
//   · what the skin part of anatomy.json is made of, which sources to add and which cautions to write.
// Nothing here matches by position: the vertices of the two lip margins coincide in pairs and only
// their indices tell them apart.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceInfo } from '../../src/anatomy/types.ts'
import type { Mesh } from './geometry.ts'
import { glbVertexOrder, POSITION_BITS, positionStep, readGlb } from './glb.ts'
import { boundaryLoops, type OpenedSkin, type SkinPackage } from './skinPackage.ts'

/** 下标对照文件的名字（tools/rig 按这个名字读） / name of the index sidecar (tools/rig reads it under this name) */
export const SKIN_SOURCE_FILE = 'skin-source.u32'
/** 每个发布的皮肤顶点属于皮肤部件 composition 里的哪一片（一个字节，GLB 解码次序）；皮肤有 composition 时才写 / which piece of the skin part's `composition` each shipped skin vertex belongs to (one byte, GLB decode order); written only when the skin has a composition */
export const SKIN_PIECES_FILE = 'skin-pieces.u8'
/** 给查看器的小文件，免得它去取 1.5 MB 的报告 / a small file for the viewer, so that it need not fetch the 1.5 MB report */
export const DISPLAY_FILE = 'display.json'

/**
 * display.json 的内容，男女通用。字段恰好是这几个：
 *   hideWithOpaqueSkin   皮肤不透明时应隐藏的部件 id（被皮肤自带的耳取代的耳廓、挡在口裂里的深层“唇”）
 *   notEnclosedPartIds   皮肤作者有意不包住的部件 id（皮肤包 manifest 的 face.notEnclosed.partIds）
 *   skin.part            皮肤部件的 id；skin.opened 皮肤是否有眼和口的开口（同时有 skin-source.u32）；
 *                        skin.pieces 是否有 skin-pieces.u8（皮肤部件带 composition）
 * 同样的数据仍在 pipeline-report.json 里（appendages.hideWithOpaqueSkin、skinPackage.notEnclosedPartIds、skinPackage.opened）。
 * The contents of display.json, for both bodies. Exactly these fields:
 *   hideWithOpaqueSkin   ids of the parts to hide while the skin is opaque (the auricle superseded by the
 *                        skin's own ear, the deep "Lip" lying in the oral opening)
 *   notEnclosedPartIds   ids of the parts the skin's author deliberately did not enclose
 *                        (face.notEnclosed.partIds of the skin package manifest)
 *   skin.part            id of the skin part; skin.opened whether the skin has eye and mouth openings
 *                        (skin-source.u32 is then present); skin.pieces whether skin-pieces.u8 is present
 *                        (the skin part carries a composition)
 * The same data stay in pipeline-report.json (appendages.hideWithOpaqueSkin,
 * skinPackage.notEnclosedPartIds, skinPackage.opened).
 */
export function displayJson(hideWithOpaqueSkin: string[], notEnclosedPartIds: string[], skinPart: string | null, opened: boolean, pieces: boolean): string {
  return JSON.stringify({ hideWithOpaqueSkin: [...hideWithOpaqueSkin], notEnclosedPartIds: [...notEnclosedPartIds].sort(), skin: { part: skinPart, opened, pieces } })
}

/**
 * skin-pieces.u8 的内容：sidecarSource 是 skin-source.u32 的值（GLB 解码次序），pieceOfVertex 来自 openedSkinProvenance。
 * 各片的顶点数必须与 composition 里写的一致，否则抛错。
 * The contents of skin-pieces.u8: `sidecarSource` holds the values of skin-source.u32 (GLB decode order) and
 * `pieceOfVertex` comes from openedSkinProvenance. The vertex count of every piece must equal the one
 * stated in `composition`, or this throws.
 */
export function skinPieces(sidecarSource: Uint32Array, pieceOfVertex: Uint8Array, composition: SkinComponent[]): Uint8Array {
  const out = new Uint8Array(sidecarSource.length)
  const n = new Array<number>(composition.length).fill(0)
  for (let j = 0; j < out.length; j++) {
    out[j] = pieceOfVertex[sidecarSource[j]!]!
    n[out[j]!]!++
  }
  composition.forEach((c, i) => {
    if (n[i] !== c.vertices) throw new Error(`${SKIN_PIECES_FILE}: piece ${i} (${c.what.en.slice(0, 40)}) has ${n[i]} shipped vertices but the composition states ${c.vertices}`)
  })
  return out
}

/** 深层的“唇”部件（一个 Lip，或切开后的 Upper lip 和 Lower lip，见 lipSplit.ts）：皮肤开了口之后它正挡在口裂里，皮肤不透明时应隐藏 / the deep lip parts (one "Lip", or "Upper lip" and "Lower lip" after the split, see lipSplit.ts): once the skin has a mouth opening they sit in the fissure and are to be hidden while the skin is opaque */
export const DEEP_LIP_NAME = /^(upper |lower )?lip$/i

export interface SkinSidecar {
  /** 文件内容：小端 uint32，每个发布顶点一个 / the file: little-endian uint32, one per shipped vertex */
  bytes: Uint8Array
  /** 同样的内容，按 GLB 解码次序 / the same values, in GLB decode order */
  source: Uint32Array
  vertices: number
  /** 读回的 GLB 位置与简化后的位置之差的最大值（毫米），以及量化步长 / largest difference between the positions read back from the GLB and the simplified ones (mm), and the quantisation step */
  maxErrorMm: number
  stepMm: number
}

/**
 * 生成下标对照文件，并读回写好的 GLB 核对：顶点数、三角形（允许三个顶点轮换，索引编码器会轮换）、
 * 每个顶点的位置（不超过半个量化步长）都必须与预计的次序一致，否则抛错——宁可构建失败，也不写出对不上的文件。
 * Builds the index sidecar and checks it against the GLB as written: vertex count, triangles (up to a
 * rotation of their three vertices, which the index codec applies) and every vertex position (within
 * half a quantisation step) must agree with the predicted order, or this throws — a failed build is
 * better than a sidecar that does not match.
 * @param shipped  交给 writeSystemGlb 的那张网格 / the mesh handed to writeSystemGlb
 * @param source   shipped 的每个顶点在包的 skin.obj 里的下标 / for each vertex of `shipped`, its index in the package's skin.obj
 */
export async function skinSourceSidecar(glbPath: string, partId: string, shipped: Mesh, source: Uint32Array, bits: number): Promise<SkinSidecar> {
  const order = await glbVertexOrder(shipped.indices)
  const out = new Uint32Array(order.vertices)
  const from = new Int32Array(order.vertices).fill(-1)
  for (let v = 0; v < order.remap.length; v++) {
    const j = order.remap[v]!
    if (j === 0xffffffff) continue
    out[j] = source[v]!
    from[j] = v
  }
  const doc = await readGlb(glbPath)
  const node = doc.getRoot().listNodes().find((n) => n.getName() === partId)
  if (!node) throw new Error(`${SKIN_SOURCE_FILE}: ${partId} is not in ${glbPath}`)
  const prim = node.getMesh()!.listPrimitives()[0]!
  const pos = prim.getAttribute('POSITION')!
  const idx = prim.getIndices()!.getArray()!
  if (pos.getCount() !== order.vertices) throw new Error(`${SKIN_SOURCE_FILE}: the GLB holds ${pos.getCount()} skin vertices, ${order.vertices} were expected`)
  if (idx.length !== order.indices.length) throw new Error(`${SKIN_SOURCE_FILE}: the GLB holds ${idx.length / 3} skin triangles, ${order.indices.length / 3} were expected`)
  for (let t = 0; t < idx.length; t += 3) {
    const a = order.indices[t]!
    const b = order.indices[t + 1]!
    const c = order.indices[t + 2]!
    const x = idx[t]!
    const y = idx[t + 1]!
    const z = idx[t + 2]!
    if (!((x === a && y === b && z === c) || (x === b && y === c && z === a) || (x === c && y === a && z === b))) throw new Error(`${SKIN_SOURCE_FILE}: triangle ${t / 3} of the GLB is ${x},${y},${z}, expected ${a},${b},${c}: the writer's vertex order is not the predicted one`)
  }
  const m = node.getWorldMatrix()
  const step = positionStep(shipped.positions, bits)
  const el = [0, 0, 0]
  let max = 0
  for (let j = 0; j < order.vertices; j++) {
    pos.getElement(j, el)
    const v = from[j]!
    for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(el[k]! * m[5 * k]! + m[12 + k]! - shipped.positions[3 * v + k]!))
  }
  // 半步，加上 float32 存储的余量 / half a step, plus a margin for float32 storage
  if (max > 0.5 * step + 2e-6) throw new Error(`${SKIN_SOURCE_FILE}: a skin vertex of the GLB lies ${(max * 1000).toFixed(4)} mm from where the predicted order puts it (step ${(step * 1000).toFixed(4)} mm)`)
  const bytes = new Uint8Array(4 * order.vertices)
  const view = new DataView(bytes.buffer)
  for (let j = 0; j < order.vertices; j++) view.setUint32(4 * j, out[j]!, true)
  return { bytes, source: out, vertices: order.vertices, maxErrorMm: Math.round(max * 1e7) / 1e4, stepMm: Math.round(step * 1e7) / 1e4 }
}

// ── 报告 / the report ───────────────────────────────────────────────────────────────────────────────

interface GraftManifest {
  name?: string
  provenance?: string
  source?: { name?: string; url?: string; file?: string; license?: string; author?: string; note?: string; licenceLineInFile?: string; licenceNote?: { zh?: string; en?: string } }
  what?: { zh?: string; en?: string }
  patchVertices?: number[]
  blendRingVertices?: number[]
  constructionVertices?: number[]
}

export interface GraftRow {
  name: string
  /** manifest 里的来源标注：scanned = 扫描数据，curated = 人工建模 / the provenance label of the manifest: scanned data or artist-made (curated) */
  provenance: string
  source: { name: string; url: string; file?: string; license: string; attribution: string }
  what: { zh: string; en: string }
  /** 发布的顶点数：供体片、过渡环、构造面 / shipped vertices: donor patch, blend ring, constructed surface */
  shipped: { patch: number; blendRing: number; construction: number }
  /** 包里的顶点数 / vertices in the package */
  inPackage: { patch: number; blendRing: number; construction: number }
  /**
   * 过渡环和构造面的质量（在发布的网格上量）：碰到这些顶点的三角形的最长边，以及这些三角形之间的二面角
   * （0° = 平）。没有这类顶点时为 null。
   * Quality of the blend ring and the constructed surface, measured on the shipped mesh: the longest edge
   * of the triangles touching those vertices, and the dihedral angles between such triangles (0° = flat).
   * null when the graft has no such vertex.
   */
  ring: { triangles: number; longestEdgeMm: { median: number; p95: number; max: number }; dihedralDeg: { median: number; p95: number; max: number; over45: number } } | null
}

export interface LipQuantisation {
  bits: number
  stepMm: number
  /** 唇缘上成对重合的顶点：对数；发布后两个都在且下标不同的对数；量化后仍重合的对数 / coincident vertex pairs of the lip margins: how many; how many have both vertices shipped under different indices; how many still coincide after quantisation */
  marginPairs: number
  marginPairsShippedApart: number
  marginPairsCoincidentAfter: number
  /**
   * 唇内面两壁：上唇那一片的顶点相对于下唇那一片（1 mm 以内正下方有三角形的那些）的有符号间距。
   * crossedInPackage = 包里本来就相穿的个数；flipped = 量化后符号变了的个数；mergedPositions = 口区原本不同、量化后落到同一点的位置数。
   * The inner-lip walls: signed gap of the vertices of the upper-lip sheet against the lower-lip sheet
   * (those with a triangle of it straight under them within 1 mm). crossedInPackage = already through each
   * other in the package; flipped = sign changed by the quantisation; mergedPositions = positions of the
   * mouth sheets that were distinct and quantise to one point.
   */
  walls: { tested: number; crossedInPackage: number; gapMm: { p10: number; median: number; p90: number }; flipped: number; flippedGapInPackageMmMax: number; gapChangeMmMax: number; mergedPositions: number }
}

export interface OpenedSkinReport {
  dir: string
  steps: string[]
  /** 是否由磁盘上这一版作者的包做出来（null = 无法判断） / whether it was made from the author's package now on disk (null = cannot tell) */
  matchesAuthorPackage: boolean | null
  package: { vertices: number; triangles: number; closedVertices: number; closedTriangles: number; boundaryLoops: number; boundaryLoopSizes: number[] }
  shipped: { vertices: number; triangles: number; boundaryLoops: number; boundaryLoopSizes: number[]; boundaryEdges: number; restoredTriangles: number }
  /** 发布的顶点按标签的个数，以及包里的个数 / shipped vertices by tag, and the counts in the package */
  byTag: Record<string, { shipped: number; inPackage: number }>
  /** 被锁定（面部或标签非 0、且有三角形用到）而没有出现在发布网格里的顶点数；应为 0 / locked vertices (face region or non-zero tag, used by a triangle) missing from the shipped mesh; must be 0 */
  lockedVerticesMissing: number
  grafts: GraftRow[]
  quantisation: { chosen: LipQuantisation; at14Bits: LipQuantisation } | null
  sidecar?: { file: string; vertices: number; maxErrorMm: number; stepMm: number }
  closedCounterpart?: { vertices: number; triangles: number; boundaryEdges: number; used: boolean }
  /** 包的 graft-report.json 里第 3–5 趾的长度比例；没有则为 null / length scales of toes 3–5 from the package's graft-report.json; null when absent */
  toeLengthScale?: { min: number; max: number } | null
}

const stat3 = (a: number[], digits = 2): { median: number; p95: number; max: number } => {
  const s = [...a].sort((x, y) => x - y)
  const r = (v: number) => Number(v.toFixed(digits))
  return s.length ? { median: r(s[s.length >> 1]!), p95: r(s[Math.floor(0.95 * (s.length - 1))]!), max: r(s[s.length - 1]!) } : { median: 0, p95: 0, max: 0 }
}

/** 一组顶点周围的三角形有多长、多不平 / how long and how uneven the triangles round a set of vertices are */
function ringQuality(mesh: Mesh, inRing: Uint8Array): GraftRow['ring'] {
  const p = mesh.positions
  const I = mesh.indices
  const nv = p.length / 3
  const tris: number[] = []
  for (let t = 0; t < I.length; t += 3) if (inRing[I[t]!] || inRing[I[t + 1]!] || inRing[I[t + 2]!]) tris.push(t)
  if (!tris.length) return null
  const longest: number[] = []
  const normal = new Map<number, [number, number, number]>()
  const byEdge = new Map<number, number[]>()
  for (const t of tris) {
    const a = 3 * I[t]!, b = 3 * I[t + 1]!, c = 3 * I[t + 2]!
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
    longest.push(1000 * Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(vx - ux, vy - uy, vz - uz)))
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    // 面积为零的三角形没有法线，不参与二面角 / a triangle of zero area has no normal and takes no part in the dihedral angles
    if (l > 1e-14) normal.set(t, [nx / l, ny / l, nz / l])
    for (let k = 0; k < 3; k++) {
      const x = I[t + k]!, y = I[t + ((k + 1) % 3)]!
      const key = Math.min(x, y) * nv + Math.max(x, y)
      const list = byEdge.get(key)
      if (list) list.push(t)
      else byEdge.set(key, [t])
    }
  }
  const angles: number[] = []
  for (const list of byEdge.values()) {
    if (list.length !== 2) continue
    const n0 = normal.get(list[0]!), n1 = normal.get(list[1]!)
    if (!n0 || !n1) continue
    angles.push((Math.acos(Math.max(-1, Math.min(1, n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]))) * 180) / Math.PI)
  }
  return { triangles: tris.length, longestEdgeMm: stat3(longest), dihedralDeg: { ...stat3(angles, 1), over45: angles.filter((a) => a > 45).length } }
}

/**
 * 按 glTF 量化的做法把位置取整到 bits 位（以包围盒中心为原点、最长半边为 1），返回取整后的位置。
 * Positions rounded to `bits` bits the way the glTF quantisation does it (origin at the centre of the
 * bounding box, the longest half side as 1).
 */
export function quantisePositions(positions: Float32Array, bits: number): Float32Array {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
    b[k] = Math.min(b[k]!, positions[i + k]!)
    b[k + 3] = Math.max(b[k + 3]!, positions[i + k]!)
  }
  const half = Math.max(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!) / 2
  const c = [(b[0]! + b[3]!) / 2, (b[1]! + b[4]!) / 2, (b[2]! + b[5]!) / 2]
  const s = 2 ** (bits - 1) - 1
  const out = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i++) out[i] = (Math.round(((positions[i]! - c[i % 3]!) / half) * s) / s) * half + c[i % 3]!
  return out
}

/** 顶点到一片三角形的有符号间距：只取垂足落在三角形内、且在 reach 之内的最近一个 / signed gap of a vertex against a sheet of triangles: the nearest one whose foot point lies inside the triangle and within `reach` */
function signedGap(pos: Float32Array, v: number, tris: Uint32Array, reach: number): { gap: number; tri: number } | null {
  const x = pos[3 * v]!, y = pos[3 * v + 1]!, z = pos[3 * v + 2]!
  let best = Infinity
  let sign = 0
  let tri = -1
  for (let t = 0; t < tris.length; t += 3) {
    const a = 3 * tris[t]!, b = 3 * tris[t + 1]!, c = 3 * tris[t + 2]!
    const wx = x - pos[a]!, wy = y - pos[a + 1]!, wz = z - pos[a + 2]!
    if (Math.abs(wx) > 0.01 || Math.abs(wy) > 0.01 || Math.abs(wz) > 0.01) continue
    const ux = pos[b]! - pos[a]!, uy = pos[b + 1]! - pos[a + 1]!, uz = pos[b + 2]! - pos[a + 2]!
    const vx = pos[c]! - pos[a]!, vy = pos[c + 1]! - pos[a + 1]!, vz = pos[c + 2]! - pos[a + 2]!
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const nl = Math.hypot(nx, ny, nz)
    if (nl < 1e-14) continue
    nx /= nl; ny /= nl; nz /= nl
    const dn = wx * nx + wy * ny + wz * nz
    if (Math.abs(dn) >= best || Math.abs(dn) > reach) continue
    const px = wx - dn * nx, py = wy - dn * ny, pz = wz - dn * nz
    const d00 = ux * ux + uy * uy + uz * uz, d01 = ux * vx + uy * vy + uz * vz, d11 = vx * vx + vy * vy + vz * vz
    const d20 = px * ux + py * uy + pz * uz, d21 = px * vx + py * vy + pz * vz
    const den = d00 * d11 - d01 * d01
    const s = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den
    if (s < 0 || w < 0 || s + w > 1) continue
    best = Math.abs(dn)
    sign = dn < 0 ? -1 : 1
    tri = t
  }
  return best < Infinity ? { gap: best * sign, tri } : null
}

/** 顶点到 tris 里第 t 个三角形所在平面的有符号距离（不管垂足在不在三角形内） / signed distance of a vertex from the plane of the triangle at offset `t` of `tris` (whether or not the foot point lies inside it) */
function planeGap(pos: Float32Array, v: number, tris: Uint32Array, t: number): number | null {
  const a = 3 * tris[t]!, b = 3 * tris[t + 1]!, c = 3 * tris[t + 2]!
  const ux = pos[b]! - pos[a]!, uy = pos[b + 1]! - pos[a + 1]!, uz = pos[b + 2]! - pos[a + 2]!
  const vx = pos[c]! - pos[a]!, vy = pos[c + 1]! - pos[a + 1]!, vz = pos[c + 2]! - pos[a + 2]!
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  const nl = Math.hypot(nx, ny, nz)
  if (nl < 1e-14) return null
  return ((pos[3 * v]! - pos[a]!) * nx + (pos[3 * v + 1]! - pos[a + 1]!) * ny + (pos[3 * v + 2]! - pos[a + 2]!) * nz) / nl
}

/**
 * 量化在唇部的后果，在发布的网格上量（顶点次序无关）。
 * What the quantisation does at the lips, measured on the shipped mesh (vertex order does not matter).
 */
export function lipQuantisation(shipped: Mesh, source: Uint32Array, manifest: Record<string, unknown>, bits: number): LipQuantisation | null {
  const face = manifest.face as { margins?: Record<string, unknown>; sheets?: { mouth?: { upper?: number[]; lower?: number[] } } } | undefined
  const up = face?.margins?.upperLip
  const lo = face?.margins?.lowerLip
  if (!Array.isArray(up) || !Array.isArray(lo) || up.length !== lo.length) return null
  const shippedOf = new Map<number, number>()
  for (let v = 0; v < source.length; v++) shippedOf.set(source[v]!, v)
  const p = shipped.positions
  const q = quantisePositions(p, bits)
  let pairs = 0, apart = 0, coincident = 0
  for (let i = 0; i < up.length; i++) {
    if (up[i] === lo[i]) continue // 口角：上下唇缘共用 / a mouth corner: shared by both margins
    pairs++
    const a = shippedOf.get(up[i] as number), b = shippedOf.get(lo[i] as number)
    if (a === undefined || b === undefined || a === b) continue
    apart++
    if (q[3 * a] === q[3 * b] && q[3 * a + 1] === q[3 * b + 1] && q[3 * a + 2] === q[3 * b + 2]) coincident++
  }
  const upper = new Set<number>(), lower = new Set<number>()
  for (const v of face?.sheets?.mouth?.upper ?? []) if (shippedOf.has(v)) upper.add(shippedOf.get(v)!)
  for (const v of face?.sheets?.mouth?.lower ?? []) if (shippedOf.has(v)) lower.add(shippedOf.get(v)!)
  const tris: number[] = []
  for (let t = 0; t < shipped.indices.length; t += 3) if (lower.has(shipped.indices[t]!) && lower.has(shipped.indices[t + 1]!) && lower.has(shipped.indices[t + 2]!)) tris.push(shipped.indices[t]!, shipped.indices[t + 1]!, shipped.indices[t + 2]!)
  const sheet = Uint32Array.from(tris)
  const margin = new Set<number>()
  for (const v of up) if (shippedOf.has(v as number)) margin.add(shippedOf.get(v as number)!)
  const gaps: number[] = []
  let flipped = 0, flippedMax = 0, change = 0, crossed = 0
  for (const v of [...upper].sort((a, b) => a - b)) {
    if (margin.has(v)) continue
    const g0 = signedGap(p, v, sheet, 0.001)
    if (g0 === null) continue
    const g = g0.gap
    gaps.push(g * 1000)
    if (g < 0) crossed++
    const h0 = signedGap(q, v, sheet, 0.002)
    if (h0 === null) continue
    // 量化前后要对同一个三角形比：垂足在细长三角形的边上时，量化会让“最近的、垂足在内的三角形”换成另一个
    // （可能在另一侧、远在 1 mm 之外），那不是两壁换了次序。换了三角形时，改量到原来那个三角形所在平面的距离。
    // Before and after must be compared on the same triangle: where the foot point lies on the edge of a
    // sliver, quantisation makes "the nearest triangle holding the foot point" another one (possibly on the
    // other side and more than 1 mm away), which is not the walls changing order. When the triangle changed,
    // the distance to the plane of the original one is taken instead.
    const h = h0.tri === g0.tri ? h0.gap : planeGap(q, v, sheet, g0.tri)
    if (h === null) continue
    change = Math.max(change, Math.abs(h - g) * 1000)
    if (Math.sign(h) !== Math.sign(g)) {
      flipped++
      flippedMax = Math.max(flippedMax, Math.abs(g) * 1000)
    }
  }
  const distinct = new Set<string>(), after = new Set<string>()
  for (const v of [...upper, ...lower]) {
    distinct.add(`${p[3 * v]},${p[3 * v + 1]},${p[3 * v + 2]}`)
    after.add(`${q[3 * v]},${q[3 * v + 1]},${q[3 * v + 2]}`)
  }
  gaps.sort((a, b) => a - b)
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  const at = (f: number) => (gaps.length ? r3(gaps[Math.floor(f * (gaps.length - 1))]!) : 0)
  return {
    bits, stepMm: Math.round(positionStep(p, bits) * 1e7) / 1e4, marginPairs: pairs, marginPairsShippedApart: apart, marginPairsCoincidentAfter: coincident,
    walls: { tested: gaps.length, crossedInPackage: crossed, gapMm: { p10: at(0.1), median: at(0.5), p90: at(0.9) }, flipped, flippedGapInPackageMmMax: r3(flippedMax), gapChangeMmMax: r3(change), mergedPositions: distinct.size - after.size },
  }
}

/** 移植片的数据源写成 SourceInfo：许可的说法照 manifest 原样抄，不作裁断 / a graft's source as a SourceInfo: the licence statement is copied from the manifest as it stands, nothing is adjudicated */
function graftSource(g: GraftManifest): GraftRow['source'] {
  const s = g.source ?? {}
  const name = s.name ?? g.name ?? 'unknown source'
  const license = s.license ?? s.licenceLineInFile ?? ''
  const attribution = [s.author, s.note, s.licenceNote?.en].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ') || name
  return { name, url: s.url ?? '', ...(s.file ? { file: s.file } : {}), license, attribution }
}

/**
 * skinPackage.opened 一节。shipped / source 是简化后的开口皮肤及其每个顶点在包里的下标；lock 是简化时的锁定掩码（包的顶点）。
 * The skinPackage.opened section. `shipped` / `source` are the simplified opened skin and, per vertex, its
 * index in the package; `lock` is the lock mask of the simplification (over the package's vertices).
 */
export function openedSkinReport(pkg: SkinPackage, dir: string, matchesAuthorPackage: boolean | null, shipped: Mesh, source: Uint32Array, lock: Uint8Array, restoredTriangles: number, bits: number): OpenedSkinReport {
  const op = pkg.opened as OpenedSkin
  const nv = pkg.mesh.positions.length / 3
  const used = new Uint8Array(nv)
  for (const v of pkg.mesh.indices) used[v] = 1
  const isShipped = new Uint8Array(nv)
  for (const v of source) isShipped[v] = 1
  const byTag: OpenedSkinReport['byTag'] = {}
  const nameOf = new Map<number, string>(Object.entries(op.tagNames).map(([k, v]) => [v, k]))
  let missing = 0
  for (let v = 0; v < nv; v++) {
    const name = nameOf.get(op.tags[v]!) ?? `tag${op.tags[v]}`
    const row = (byTag[name] ??= { shipped: 0, inPackage: 0 })
    row.inPackage++
    if (isShipped[v]) row.shipped++
    if (lock[v] && used[v] && !isShipped[v]) missing++
  }
  const shippedOf = new Map<number, number>()
  for (let v = 0; v < source.length; v++) shippedOf.set(source[v]!, v)
  const grafts: GraftRow[] = []
  for (const g of ((pkg.manifest.grafted as { grafts?: GraftManifest[] } | undefined)?.grafts ?? [])) {
    const count = (list: number[] | undefined) => (list ?? []).filter((v) => isShipped[v]).length
    const inRing = new Uint8Array(shipped.positions.length / 3)
    for (const v of [...(g.blendRingVertices ?? []), ...(g.constructionVertices ?? [])]) {
      const j = shippedOf.get(v)
      if (j !== undefined) inRing[j] = 1
    }
    grafts.push({
      name: g.name ?? '', provenance: g.provenance ?? '', source: graftSource(g), what: { zh: g.what?.zh ?? '', en: g.what?.en ?? '' },
      shipped: { patch: count(g.patchVertices), blendRing: count(g.blendRingVertices), construction: count(g.constructionVertices) },
      inPackage: { patch: g.patchVertices?.length ?? 0, blendRing: g.blendRingVertices?.length ?? 0, construction: g.constructionVertices?.length ?? 0 },
      ring: ringQuality(shipped, inRing),
    })
  }
  const loopsPkg = boundaryLoops(pkg.mesh)
  const loops = boundaryLoops(shipped)
  const chosen = lipQuantisation(shipped, source, pkg.manifest, bits)
  const base = bits === POSITION_BITS ? chosen : lipQuantisation(shipped, source, pkg.manifest, POSITION_BITS)
  return {
    dir, steps: op.steps, matchesAuthorPackage,
    package: { vertices: nv, triangles: pkg.mesh.indices.length / 3, closedVertices: op.closedVertices, closedTriangles: pkg.closedMesh.indices.length / 3, boundaryLoops: loopsPkg.loops, boundaryLoopSizes: loopsPkg.sizes },
    shipped: { vertices: shipped.positions.length / 3, triangles: shipped.indices.length / 3, boundaryLoops: loops.loops, boundaryLoopSizes: loops.sizes, boundaryEdges: loops.edges, restoredTriangles },
    byTag, lockedVerticesMissing: missing, grafts,
    quantisation: chosen && base ? { chosen, at14Bits: base } : null,
  }
}

// ── anatomy.json：构成、数据源、说明 / anatomy.json: composition, sources, cautions ───────────────────────

export interface SkinComponent {
  what: { zh: string; en: string }
  /** scanned = 此人的扫描数据；curated = 拟合的参数化体表或人工建模的供体；construction = 构造物，不是解剖 / scanned = this person's scan; curated = the fitted parametric surface or an artist-made donor; construction = a construction aid, not anatomy */
  provenance: 'scanned' | 'curated' | 'construction'
  /** anatomy.json 的 sources 里的名字；构造物为 null / the name in `sources` of anatomy.json; null for construction */
  source: string | null
  /** 发布的顶点数 / shipped vertices */
  vertices: number
}

/**
 * 皮肤部件由什么构成（写进 anatomy.json 的皮肤部件记录，字段名 composition），以及要加进 sources 的数据源。
 * 移植片的数据源若与已有的数据源同名（男性的生殖器皮肤取自 BodyParts3D 4.0，已是第一个数据源），
 * 就在名字后加上文件名另列一条，把 manifest 里的许可说法原样带上。
 * What the skin part is made of (written into the skin part's record in anatomy.json, field
 * `composition`) and the sources to add to `sources`. When a graft's source has the name of a source
 * already listed (the male genital skin is from BodyParts3D 4.0, which is the first source), it is
 * listed again under the name plus the file, carrying the licence statement of the manifest as it stands.
 */
export function openedSkinProvenance(pkg: SkinPackage, report: OpenedSkinReport, existingSourceNames: string[]): { composition: SkinComponent[]; sources: SourceInfo[]; packageSource: SourceInfo; pieceOfVertex: Uint8Array } {
  const mod = (pkg.manifest.opened as { modification?: { en?: string } } | undefined)?.modification?.en
  const graftNote = (pkg.manifest.grafted as { note?: { en?: string } } | undefined)?.note?.en
  // Apache-2.0 第 4(b) 条：修改声明随来源一起走 / section 4(b) of the Apache License 2.0: the statement of changes travels with the source
  const packageSource: SourceInfo = { ...pkg.source, attribution: [pkg.source.attribution, graftNote, mod].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ') }
  const sources: SourceInfo[] = []
  const taken = new Set([...existingSourceNames, packageSource.name])
  const n = (k: string) => report.byTag[k]?.shipped ?? 0
  const fitted = ['skin', 'upperLip', 'lowerLip', 'mouthCorner', 'upperLidL', 'lowerLidL', 'upperLidR', 'lowerLidR', 'canthus'].reduce((a, k) => a + n(k), 0)
  const composition: SkinComponent[] = [{
    what: { zh: '按本体内部结构拟合的参数化体表（MHR）；口裂已剪开，两眼的封膜已删去，眼和口是真正的开口', en: 'parametric body surface (MHR) fitted to this body\'s internals; the oral fissure is cut and the membrane over each eye removed, so eye and mouth are real openings' },
    provenance: 'curated', source: packageSource.name, vertices: fitted,
  }]
  // 包的每个顶点属于 composition 的哪一片（下标）；先全部算作拟合的体表 / the piece of `composition` (its index) every vertex of the package belongs to; all start as fitted surface
  const op = pkg.opened as OpenedSkin
  const pieceOfVertex = new Uint8Array(op.tags.length)
  const manifestGrafts = ((pkg.manifest.grafted as { grafts?: GraftManifest[] } | undefined)?.grafts ?? [])
  const ringVertices: number[] = []
  let ring = 0
  report.grafts.forEach((_, i) => {
    for (const v of manifestGrafts[i]?.patchVertices ?? []) pieceOfVertex[v] = 1 + i
    for (const v of [...(manifestGrafts[i]?.blendRingVertices ?? []), ...(manifestGrafts[i]?.constructionVertices ?? [])]) ringVertices.push(v)
  })
  for (const g of report.grafts) {
    let name = g.source.name
    if (taken.has(name) && !sources.some((s) => s.name === name)) name = `${name} — ${g.source.file ?? g.name} (skin graft)`
    if (!sources.some((s) => s.name === name)) {
      sources.push({ name, url: g.source.url, license: g.source.license, attribution: g.source.attribution })
      taken.add(name)
    }
    composition.push({ what: { zh: g.what.zh.split('。')[0] + '（移植片）', en: `graft "${g.name}": ${g.what.en.split('. ')[0]}` }, provenance: g.provenance === 'scanned' ? 'scanned' : 'curated', source: name, vertices: g.shipped.patch })
    ring += g.shipped.blendRing + g.shipped.construction
  }
  if (ring) for (const v of ringVertices) pieceOfVertex[v] = composition.length
  if (ring) composition.push({ what: { zh: '移植片与拟合皮肤之间的过渡环和构造面（构造物，不是扫描数据，也不是解剖）', en: 'blend rings and constructed surfaces between the grafts and the fitted skin (construction: neither scanned data nor anatomy)' }, provenance: 'construction', source: null, vertices: ring })
  const rims = n('lidRimL') + n('lidRimR')
  const T = op.tagNames
  const mark = (tags: (number | undefined)[]) => {
    for (let v = 0; v < pieceOfVertex.length; v++) if (tags.includes(op.tags[v]!)) pieceOfVertex[v] = composition.length
  }
  if (rims) mark([T.lidRimL, T.lidRimR])
  if (rims) composition.push({ what: { zh: '两眼洞口朝向眼球的睑缘内卷（构造物，不是解剖）', en: 'lid rims turned in towards the globes round the eye openings (construction aid, not anatomy)' }, provenance: 'construction', source: null, vertices: rims })
  const pouch = n('oralPouchUpper') + n('oralPouchLower') + n('oralPouchSeam')
  if (pouch) mark([T.oralPouchUpper, T.oralPouchLower, T.oralPouchSeam])
  if (pouch) composition.push({ what: { zh: '口裂后面包住牙、牙龈和舌的口腔袋（构造物，不是解剖）', en: 'oral pouch behind the oral fissure, round teeth, gums and tongue (construction aid, not anatomy)' }, provenance: 'construction', source: null, vertices: pouch })
  return { composition, sources, packageSource, pieceOfVertex }
}

/** 包里 graft-report.json 记的第 3–5 趾的长度比例（各侧的最小值和最大值）；没有则为 null / the length scales of toes 3–5 from the package's graft-report.json (least and largest over the sides); null when absent */
export function toeStretch(packageDir: string): { min: number; max: number } | null {
  const f = join(packageDir, 'graft-report.json')
  if (!existsSync(f)) return null
  try {
    const sides = (JSON.parse(readFileSync(f, 'utf8')) as { toes?: { sides?: Record<string, { lengthScalePerToe?: number[] }> } }).toes?.sides ?? {}
    const v = Object.values(sides).flatMap((s) => (s.lengthScalePerToe ?? []).slice(2)).filter((x) => Number.isFinite(x))
    return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null
  } catch {
    return null
  }
}

/**
 * 开口和移植带来的说明，男女通用：眼和口是开口、内卷和口腔袋是构造物、各移植片是什么、过渡环量出来的质量。
 * toes 是 toeStretch 的结果。body 只决定足趾那一条里的人称（his / her，他 / 她），缺省为男性，与原先的文字相同。
 * The cautions that openings and grafts bring, for both bodies: eye and mouth are openings, rims and
 * pouch are construction aids, what each graft is, and the measured quality of the rings. `toes` is the
 * result of toeStretch. `body` only sets the pronouns of the caution about the toes (his / her); it
 * defaults to the male, which gives the wording as it was.
 */
export function openedSkinCautions(report: OpenedSkinReport, toes: { min: number; max: number } | null, body: 'male' | 'female' = 'male'): { zh: string; en: string }[] {
  const out: { zh: string; en: string }[] = []
  const w = body === 'female' ? { his: 'her', hers: 'hers', zh: '她' } : { his: 'his', hers: 'his', zh: '他' }
  out.push({
    en: 'The eyes and the mouth of the skin are real openings. The membrane between the lids was removed, so what shows in each eye is the globe of the anatomy data, and the lips are cut apart along the oral fissure (closed at rest). Behind the openings, the lid rims turned in towards the globes and the oral pouch round teeth, gums and tongue are construction aids that only hide the hollow inside of the body: they are not anatomy (there is no conjunctiva and no oral mucosa). The deep "Lip" part lies in the oral opening and is meant to be hidden while the skin is opaque.',
    zh: '皮肤上的眼和口是真正的开口：两睑之间的封膜已删去，洞里露出的是解剖数据里的眼球；上下唇沿口裂剪开，静止时闭合。洞口后面朝向眼球的睑缘内卷、包住牙、牙龈和舌的口腔袋都是构造物，只为不露出体内的空腔，不是解剖（没有结膜，也没有口腔黏膜）。深层的“唇”部件正位于口裂处，皮肤不透明时应隐藏。',
  })
  for (const g of report.grafts.filter((x) => /genital/i.test(x.name))) {
    const r = g.ring
    out.push({
      en: `The skin of the penis and scrotum is ${g.provenance === 'scanned' ? 'his own scanned skin (BodyParts3D)' : 'a donor surface'}, set into the fitted surface with no vertex moved. The pubic, perineal and upper inner-thigh surface round it and the ring joining the two are constructed, not scanned${r ? `: there the triangles are up to ${r.longestEdgeMm.max.toFixed(0)} mm long (median ${r.longestEdgeMm.median.toFixed(0)} mm) and neighbouring facets meet at up to ${r.dihedralDeg.max.toFixed(0)}° (${r.dihedralDeg.over45} edges above 45°), so the region is coarse and faceted` : ''}. The scanned neck of the scrotum and perineal raphe lie under the constructed surface and are not used; penis and scrotum move rigidly with the pelvis.`,
      zh: `阴茎和阴囊的皮肤${g.provenance === 'scanned' ? '是他本人的扫描皮肤（BodyParts3D）' : '取自供体'}，原样嵌入拟合的体表。它周围的耻区、会阴和大腿内侧上部的面，以及两者之间的过渡环是构造出来的，不是扫描数据${r ? `：那里的三角形最长 ${r.longestEdgeMm.max.toFixed(0)} mm（中位数 ${r.longestEdgeMm.median.toFixed(0)} mm），相邻小面的夹角最大 ${r.dihedralDeg.max.toFixed(0)}°（${r.dihedralDeg.over45} 条边超过 45°），所以这一带粗糙、有棱面` : ''}。扫描的阴囊颈部和会阴缝被构造面盖住，没有用上；阴茎和阴囊随骨盆刚性运动。`,
    })
  }
  const toeGrafts = report.grafts.filter((x) => /^toes/i.test(x.name))
  if (toeGrafts.length) {
    const longest = Math.max(0, ...toeGrafts.map((g) => g.ring?.longestEdgeMm.max ?? 0))
    const stretch = toes && toes.max > 1.05 ? { en: ` the third to fifth toes are stretched ${toes.min.toFixed(2)}–${toes.max.toFixed(2)} times to reach along ${w.his} phalanges and look slender;`, zh: `第 3–5 趾被拉长到 ${toes.min.toFixed(2)}–${toes.max.toFixed(2)} 倍才够到${w.zh}的趾骨，显得细长；` } : { en: '', zh: '' }
    out.push({
      en: `The toes are separate, with webs and nails, but they are not ${w.hers}: they come from an artist-made foot mesh (Blender Studio Human Base Meshes, CC0), each toe placed along ${w.his} toe bones and widened until it covers them;${stretch.en} the nails are shapes in the skin mesh, apart from the nail plate parts. About 2 cm of skin behind the toe bases is a constructed transition${longest ? ` (triangles up to ${longest.toFixed(0)} mm long)` : ''}. Where the web station lies on the proximal phalanx is an assumption.`,
      zh: `足趾是分开的，有趾蹼和趾甲，但不是${w.zh}本人的：取自人工建模的足部网格（Blender Studio Human Base Meshes，CC0），每个趾沿${w.zh}的趾骨摆放并加粗到盖住趾骨；${stretch.zh}趾甲是皮肤网格上的形状，与甲板部件无关。趾根之后约 2 cm 的皮肤是构造的过渡面${longest ? `（三角形最长 ${longest.toFixed(0)} mm）` : ''}。趾蹼在近节趾骨上的位置是假定的。`,
    })
  }
  for (const g of report.grafts.filter((x) => !/genital/i.test(x.name) && !/^toes/i.test(x.name))) {
    out.push({ en: `Part of the skin is a graft ("${g.name}", ${g.provenance}, from ${g.source.name}): ${g.what.en}`.slice(0, 600), zh: `皮肤的一部分是移植片（${g.name}，来自 ${g.source.name}）：${g.what.zh}`.slice(0, 250) })
  }
  return out
}
