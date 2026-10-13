// 外部皮肤包：由体型工具（tools/bodyshape）按本体的内部结构拟合好的单层皮肤，装入后替换
// 原有的皮肤部件，再在新皮肤与深部结构之间重新推导皮下脂肪。男女两个人体通用。
//
// 包目录（如 data/raw/bodyshape/out/female-skin/）的内容：
//   manifest.json   source{name,url,license,attribution}；可选 fittedTo{body,key}
//   skin.obj        单层封闭皮肤，米，Y 向上，+Z 向前，+X 为身体左侧，与 public/anatomy/<body> 同原点
//   其余文件（蒙皮权重、关节、形状场、许可证文本）由运行时和装配工具使用，这里不读。
// 包是“按某一版内部结构拟合”的：manifest.fittedTo.key 必须等于本次构建的内部结构指纹
// （见 internalsKey），否则不装入——皮肤与骨、肌对不上比沿用占位皮肤更糟。
//
// External skin package: a single-walled skin fitted to this body's internals by the body-shape
// tools (tools/bodyshape). Installing it replaces the skin part; the subcutaneous fat is then
// derived again between the new skin and the deep parts. Generic: both bodies use it.
//
// A package directory (e.g. data/raw/bodyshape/out/female-skin/) holds:
//   manifest.json   source{name,url,license,attribution}; optional fittedTo{body,key}
//   skin.obj        closed single-walled skin; metres, Y up, +Z anterior, +X the body's left, same
//                   origin as public/anatomy/<body>
//   other files (skin weights, joints, shape fields, licence texts) serve the runtime and the
//   rigging tools and are not read here.
// A package is fitted to one version of the internals: manifest.fittedTo.key must equal the
// fingerprint of this build's internals (see internalsKey), otherwise it is not installed — a skin
// that does not match bones and muscles is worse than keeping the placeholder.

//
// 开口后的包（tools/skinopen 写出的 <body>-skin-open/，见 tools/skinopen/INTEGRATION.txt）多出：
//   skin-closed.obj     开口之前（移植之后）的闭合皮肤；凡是判断内外的地方都用它
//   vertex-tags.u8      每个顶点一个标签（唇缘、睑缘、内卷、口腔袋、移植片……）
//   source-vertex.u32   每个顶点的逐顶点数据取自闭合皮肤的哪个顶点
// 这时 skin.obj 不闭合（两眼内卷的内缘是两个边界环），上下唇缘是成对重合的顶点：
// 这条路径上任何一步都不能按位置合并顶点，对应关系一律按下标。
//
// An opened package (<body>-skin-open/ written by tools/skinopen, see tools/skinopen/INTEGRATION.txt) adds:
//   skin-closed.obj     the closed skin before the openings (after the grafts); every inside test uses it
//   vertex-tags.u8      one tag per vertex (lip and lid margins, rims, oral pouch, graft patches …)
//   source-vertex.u32   the vertex of the closed skin each vertex takes its per-vertex data from
// skin.obj is then not closed (the inner edges of the two lid rims are boundary loops) and the lip
// margins are coincident vertex pairs: nothing on this path may merge vertices by position, and all
// correspondence is by index.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceInfo } from '../../src/anatomy/types.ts'
import { MeshoptSimplifier } from 'meshoptimizer'
import { compact, measure, type Mesh } from './geometry.ts'
import { InsideTester, PointIndex, surfacePoints, thinPoints } from './register.ts'

/** 开口后的包才有的内容 / what only an opened package carries */
export interface OpenedSkin {
  /** vertex-tags.u8：skin.obj 每个顶点一个标签，0 = 普通皮肤 / vertex-tags.u8: one tag per vertex of skin.obj, 0 = ordinary skin */
  tags: Uint8Array
  /** 标签名 → 值（manifest.opened.vertexTags） / tag name → value (manifest.opened.vertexTags) */
  tagNames: Record<string, number>
  /** source-vertex.u32：每个顶点的逐顶点数据取自 skin-closed.obj 的哪个顶点 / source-vertex.u32: the vertex of skin-closed.obj each vertex takes its per-vertex data from */
  sourceVertex: Uint32Array
  /** 闭合皮肤的顶点数；skin.obj 的前这么多个顶点与它相同 / vertex count of the closed skin; the first that many vertices of skin.obj are the same */
  closedVertices: number
  /** 从 skin.obj 删去的封住睑裂的三角形（skin.obj 的顶点下标），在 skin-closed.obj 里仍在 / the triangles closing the palpebral fissures that were removed from skin.obj (its vertex indices); still present in skin-closed.obj */
  eyeMembrane: Uint32Array
  /** 本包试过的步骤（manifest.opened.steps），最后一项是 open / the steps tried for this package (manifest.opened.steps); the last is `open` */
  steps: string[]
}

export interface SkinPackage {
  /** skin.obj：显示用的皮肤；开口后的包里它不闭合 / skin.obj: the skin that is shown; not closed in an opened package */
  mesh: Mesh
  /**
   * 闭合的皮肤：有 skin-closed.obj 就是它，否则就是 mesh 本身。判断内外（射线奇偶）、推导皮下脂肪、贴合附属物都用它。
   * The closed skin: skin-closed.obj when the package has one, otherwise `mesh` itself. Inside tests (ray
   * parity), the fat derivation and the appendage conforming all use it.
   */
  closedMesh: Mesh
  /** 开口后的包的标签等；普通（闭合）包为 null / tags and the rest of an opened package; null for an ordinary (closed) one */
  opened: OpenedSkin | null
  source: SourceInfo
  /** 包声明它所拟合的内部结构；缺省表示未声明 / what the package says it was fitted to; absent when it does not say */
  fittedTo: { body: string; key: string } | null
  manifest: Record<string, unknown>
  /**
   * 皮肤作者有意不包住的部件的 id（manifest.face.notEnclosed.partIds：眼球各部、睑缘处的眼轮匝肌、唇、牙、舌、鼻软骨等），没有则为空
   * ids of the parts the skin's author deliberately left out of the set to enclose (manifest.face.notEnclosed.partIds: parts of the eyeball, orbicularis oculi at the lid margins, lips, teeth, tongue, nasal cartilages …); empty when the manifest gives none
   */
  notEnclosed: string[]
  /** 包里参数化模型的眼关节位置（joints.json 的 l_eye / r_eye），没有则为 null / the eye joints of the parametric model (l_eye / r_eye in joints.json); null when absent */
  eyeJoints: { L: [number, number, number]; R: [number, number, number] } | null
  /** 皮肤作者自己量的数（包里的 manifest.json、final-checks.json）；管线不重算，只在说明里引用 / figures measured by the skin's author (manifest.json and final-checks.json of the package); the pipeline does not recompute them and only quotes them in the cautions */
  author: { bmiByVolume: number | null; targetBmi: number | null; bideltoidMm: { target: number; final: number } | null }
}

/**
 * 读 OBJ 的顶点和面（只取位置；多边形按扇形三角化）。顶点顺序保持文件中的顺序。
 * Reads vertices and faces of an OBJ (positions only; polygons are fanned). Vertex order is the file's.
 */
export function parseSkinObj(text: string): Mesh {
  const positions: number[] = []
  const indices: number[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) {
      const p = line.trim().split(/\s+/)
      positions.push(Number(p[1]), Number(p[2]), Number(p[3]))
    } else if (line.startsWith('f ')) {
      const f = line.trim().split(/\s+/).slice(1).map((t) => Number(t.split('/')[0]))
      const n = positions.length / 3
      const ix = f.map((i) => (i < 0 ? n + i : i - 1))
      for (let k = 1; k + 1 < ix.length; k++) indices.push(ix[0]!, ix[k]!, ix[k + 1]!)
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
}

/**
 * vertex-tags.u8 的取值（tools/skinopen/INTEGRATION.txt 第 2、8 节）；包的 manifest.opened.vertexTags 若给出则以它为准。
 * Values of vertex-tags.u8 (sections 2 and 8 of tools/skinopen/INTEGRATION.txt); manifest.opened.vertexTags of the package wins where it is given.
 */
export const DEFAULT_SKIN_TAGS: Record<string, number> = {
  skin: 0, upperLip: 1, lowerLip: 2, mouthCorner: 3, upperLidL: 4, lowerLidL: 5, upperLidR: 6, lowerLidR: 7, lidRimL: 8, lidRimR: 9,
  oralPouchUpper: 10, oralPouchLower: 11, oralPouchSeam: 12, canthus: 13, removed: 14, graftScanned: 15, graftBlend: 16, graftCurated: 17, graftConstruction: 18,
}

/** 读皮肤包；目录或必需文件不存在时返回 null / reads a skin package; null when the directory or a required file is missing */
export function loadSkinPackage(dir: string): SkinPackage | null {
  const mf = join(dir, 'manifest.json')
  const obj = join(dir, 'skin.obj')
  if (!existsSync(mf) || !existsSync(obj)) return null
  const manifest = JSON.parse(readFileSync(mf, 'utf8')) as Record<string, unknown>
  const src = (manifest.source ?? {}) as Record<string, string>
  if (!src.name || !src.license) throw new Error(`skin package ${mf}: manifest.source needs name and license`)
  const fitted = manifest.fittedTo as { body?: string; key?: string } | undefined
  const optional = <T>(file: string): T | null => {
    const f = join(dir, file)
    try {
      return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as T) : null
    } catch {
      return null
    }
  }
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const joints = optional<{ names?: string[]; positions?: number[][] }>('joints.json')
  const jointAt = (name: string): [number, number, number] | null => {
    const i = joints?.names?.indexOf(name) ?? -1
    const q = i >= 0 ? joints?.positions?.[i] : undefined
    return q && q.length === 3 && q.every((v) => Number.isFinite(v)) ? [q[0]!, q[1]!, q[2]!] : null
  }
  const eyeL = jointAt('l_eye')
  const eyeR = jointAt('r_eye')
  const bd = optional<{ bideltoidBreadthMm?: { target?: number; final?: number } }>('final-checks.json')?.bideltoidBreadthMm
  const ne = ((manifest.face as { notEnclosed?: { partIds?: unknown } } | undefined)?.notEnclosed?.partIds ?? []) as unknown
  const mesh = parseSkinObj(readFileSync(obj, 'utf8'))
  // 开口后的包：闭合的那张网格、标签、数据来源三样齐全才算；缺一样就按普通包处理（skin.obj 必须自己闭合）
  // an opened package needs all three of closed companion, tags and data sources; with any missing it is treated as an ordinary package (whose skin.obj must itself be closed)
  let closedMesh = mesh
  let opened: OpenedSkin | null = null
  const companion = join(dir, 'skin-closed.obj')
  const tagFile = join(dir, 'vertex-tags.u8')
  const srcFile = join(dir, 'source-vertex.u32')
  if (existsSync(companion) && existsSync(tagFile) && existsSync(srcFile)) {
    closedMesh = parseSkinObj(readFileSync(companion, 'utf8'))
    const nv = mesh.positions.length / 3
    const tags = new Uint8Array(readFileSync(tagFile))
    const sb = readFileSync(srcFile)
    if (tags.length !== nv) throw new Error(`skin package ${dir}: vertex-tags.u8 has ${tags.length} entries but skin.obj has ${nv} vertices`)
    if (sb.length !== 4 * nv) throw new Error(`skin package ${dir}: source-vertex.u32 has ${sb.length / 4} entries but skin.obj has ${nv} vertices`)
    const sourceVertex = new Uint32Array(nv)
    for (let v = 0; v < nv; v++) sourceVertex[v] = sb.readUInt32LE(4 * v)
    const closedVertices = closedMesh.positions.length / 3
    for (let v = 0; v < nv; v++) if (sourceVertex[v]! >= closedVertices) throw new Error(`skin package ${dir}: source-vertex.u32 names vertex ${sourceVertex[v]} but skin-closed.obj has ${closedVertices}`)
    const op = (manifest.opened ?? {}) as { vertexTags?: Record<string, number>; steps?: string[] }
    const mem = ((manifest.face as { removedEyeMembrane?: Record<string, unknown> } | undefined)?.removedEyeMembrane ?? {}) as Record<string, unknown>
    const tri: number[] = []
    for (const side of Object.keys(mem).sort()) {
      const list = mem[side]
      if (!Array.isArray(list)) continue
      for (const t of list) if (Array.isArray(t) && t.length === 3 && t.every((x) => Number.isInteger(x) && x >= 0 && x < nv)) tri.push(t[0], t[1], t[2])
    }
    opened = { tags, tagNames: { ...DEFAULT_SKIN_TAGS, ...(op.vertexTags ?? {}) }, sourceVertex, closedVertices, eyeMembrane: Uint32Array.from(tri), steps: Array.isArray(op.steps) ? op.steps.filter((x): x is string => typeof x === 'string') : [] }
  }
  return {
    closedMesh,
    opened,
    notEnclosed: Array.isArray(ne) ? ne.filter((x): x is string => typeof x === 'string') : [],
    eyeJoints: eyeL && eyeR ? { L: eyeL, R: eyeR } : null,
    author: { bmiByVolume: num(manifest.bmiByVolume), targetBmi: num(manifest.targetBmi), bideltoidMm: num(bd?.target) !== null && num(bd?.final) !== null ? { target: bd!.target!, final: bd!.final! } : null },
    mesh,
    source: { name: src.name, url: src.url ?? '', license: src.license, attribution: src.attribution ?? src.name },
    fittedTo: fitted?.body && fitted.key ? { body: fitted.body, key: fitted.key } : null,
    manifest,
  }
}

/**
 * 内部结构的指纹：全部骨的名称和包围盒（毫米取整）的 SHA-1 前 16 位。骨架一变（姿势、比例），
 * 指纹就变，按旧骨架拟合的皮肤包随之失效。
 * Fingerprint of the internals: the first 16 hex digits of the SHA-1 over every bone's name and
 * bounding box (rounded to millimetres). It changes whenever the skeleton does (pose, proportions),
 * which invalidates a skin package fitted to the old one.
 */
export function internalsKey(bones: { name: string; bbox: readonly number[] }[]): string {
  const rows = bones.map((b) => `${b.name}:${b.bbox.map((v) => Math.round(v * 1000)).join(',')}`).sort()
  return createHash('sha1').update(rows.join('\n')).digest('hex').slice(0, 16)
}

export interface SkinFit {
  /** 皮肤是否封闭：没有边界边（每条边被偶数个三角形共用） / is the skin closed: no boundary edge (every edge shared by an even number of triangles) */
  closed: boolean
  /** 被两个以上三角形共用的边数；原始皮肤为 0，简化后在皮肤相贴处会有几条 / edges shared by more than two triangles: none in a source skin, a few after simplification where skin lies against skin */
  nonManifoldEdges: number
  /** 深部结构表面采样点落在皮肤之外的比例，以及其中超出 5 mm 的比例 / share of deep-part surface samples outside the skin, and of those more than 5 mm outside */
  outside: number
  outside5mm: number
  /** 最靠外的若干部件；maxMm 为其采样点到皮肤面的最大距离（精确到三角形） / the parts that stick out most; maxMm is the largest distance of their samples from the skin surface (exact, to the triangles) */
  worst: { name: string; outside: number; maxMm: number }[]
  /**
   * 皮肤作者有意不包住的部件（见 SkinPackage.notEnclosed）：不计入上面的 outside / outside5mm / worst，单独在这里报告。
   * 没有给出豁免名单时不出现。
   * The parts the skin's author deliberately did not enclose (see SkinPackage.notEnclosed): left out of
   * outside / outside5mm / worst above and reported here on their own. Absent when no exemption list was given.
   */
  notEnclosedByDesign?: { parts: number; outside: number; outside5mm: number; worst: { name: string; outside: number; maxMm: number }[] }
}

/** 边的使用次数统计：边界边（奇数次）与非流形边（多于两次） / edge use: boundary edges (odd count) and non-manifold edges (more than two) */
export function edgeTopology(mesh: Mesh): { boundaryEdges: number; nonManifoldEdges: number } {
  const edges = new Map<number, number>()
  const nv = mesh.positions.length / 3
  for (let t = 0; t < mesh.indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = mesh.indices[t + k]!
    const b = mesh.indices[t + ((k + 1) % 3)]!
    const key = Math.min(a, b) * nv + Math.max(a, b)
    edges.set(key, (edges.get(key) ?? 0) + 1)
  }
  let boundaryEdges = 0
  let nonManifoldEdges = 0
  for (const c of edges.values()) {
    if (c % 2) boundaryEdges++
    if (c > 2) nonManifoldEdges++
  }
  return { boundaryEdges, nonManifoldEdges }
}

/**
 * 点到三角网格表面的精确距离（三角形装在均匀网格里）。用于毫米以下的量：角膜、乳头到皮肤的距离。
 * Exact distance from a point to the surface of a triangle mesh (triangles binned in a uniform
 * grid). For sub-millimetre quantities: how far the cornea or a nipple is from the skin.
 */
export class SurfaceDistance {
  private readonly cells = new Map<number, number[]>()
  private readonly o: [number, number, number]
  private readonly n: [number, number, number]
  constructor(private readonly mesh: Mesh, private readonly cell = 0.006) {
    const p = mesh.positions
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k]!, p[i + k]!)
      b[k + 3] = Math.max(b[k + 3]!, p[i + k]!)
    }
    this.o = [b[0]!, b[1]!, b[2]!]
    this.n = [0, 1, 2].map((k) => Math.floor((b[k + 3]! - b[k]!) / cell) + 1) as [number, number, number]
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const lo = [Infinity, Infinity, Infinity]
      const hi = [-Infinity, -Infinity, -Infinity]
      for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) {
        const v = p[3 * mesh.indices[t + c]! + k]!
        lo[k] = Math.min(lo[k]!, v)
        hi[k] = Math.max(hi[k]!, v)
      }
      const i0 = this.ix(lo[0]!, 0), i1 = this.ix(hi[0]!, 0), j0 = this.ix(lo[1]!, 1), j1 = this.ix(hi[1]!, 1), k0 = this.ix(lo[2]!, 2), k1 = this.ix(hi[2]!, 2)
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const key = this.key(i, j, k)
        let list = this.cells.get(key)
        if (!list) this.cells.set(key, (list = []))
        list.push(t)
      }
    }
  }
  private ix(v: number, k: number): number {
    return Math.max(0, Math.min(this.n[k]! - 1, Math.floor((v - this.o[k]!) / this.cell)))
  }
  private key(i: number, j: number, k: number): number {
    return i + this.n[0] * (j + this.n[1] * k)
  }
  /** 到表面的距离；超过 max 时返回 max / distance to the surface; `max` when further than that */
  distance(x: number, y: number, z: number, max = 0.05): number {
    const p = this.mesh.positions
    const idx = this.mesh.indices
    const ci = Math.floor((x - this.o[0]) / this.cell), cj = Math.floor((y - this.o[1]) / this.cell), ck = Math.floor((z - this.o[2]) / this.cell)
    let best = max
    const rings = Math.ceil(max / this.cell) + 1
    for (let r = 0; r <= rings; r++) {
      // 第 r 圈之内的格子都看过了：更远的三角形至少在 (r − 1)·cell 之外 / every cell within ring r − 1 was visited: anything further is at least (r − 1)·cell away
      if ((r - 1) * this.cell > best) break
      for (let k = ck - r; k <= ck + r; k++) {
        if (k < 0 || k >= this.n[2]) continue
        for (let j = cj - r; j <= cj + r; j++) {
          if (j < 0 || j >= this.n[1]) continue
          for (let i = ci - r; i <= ci + r; i++) {
            if (i < 0 || i >= this.n[0]) continue
            if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== r) continue
            const list = this.cells.get(this.key(i, j, k))
            if (!list) continue
            for (const t of list) {
              const d = pointTriangleDistance(x, y, z, p, 3 * idx[t]!, 3 * idx[t + 1]!, 3 * idx[t + 2]!)
              if (d < best) best = d
            }
          }
        }
      }
    }
    return best
  }
}

/** 点到三角形的距离（Ericson, Real-Time Collision Detection 5.1.5） / distance from a point to a triangle (Ericson, Real-Time Collision Detection 5.1.5) */
function pointTriangleDistance(px: number, py: number, pz: number, v: Float32Array, a: number, b: number, c: number): number {
  const ax = v[a]!, ay = v[a + 1]!, az = v[a + 2]!
  const abx = v[b]! - ax, aby = v[b + 1]! - ay, abz = v[b + 2]! - az
  const acx = v[c]! - ax, acy = v[c + 1]! - ay, acz = v[c + 2]! - az
  const apx = px - ax, apy = py - ay, apz = pz - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  let qx: number, qy: number, qz: number
  if (d1 <= 0 && d2 <= 0) {
    qx = ax; qy = ay; qz = az
  } else {
    const bpx = px - v[b]!, bpy = py - v[b + 1]!, bpz = pz - v[b + 2]!
    const d3 = abx * bpx + aby * bpy + abz * bpz
    const d4 = acx * bpx + acy * bpy + acz * bpz
    const cpx = px - v[c]!, cpy = py - v[c + 1]!, cpz = pz - v[c + 2]!
    const d5 = abx * cpx + aby * cpy + abz * cpz
    const d6 = acx * cpx + acy * cpy + acz * cpz
    const vc = d1 * d4 - d3 * d2
    const vb = d5 * d2 - d1 * d6
    const va = d3 * d6 - d5 * d4
    if (d3 >= 0 && d4 <= d3) {
      qx = v[b]!; qy = v[b + 1]!; qz = v[b + 2]!
    } else if (d6 >= 0 && d5 <= d6) {
      qx = v[c]!; qy = v[c + 1]!; qz = v[c + 2]!
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const t = d1 / (d1 - d3)
      qx = ax + t * abx; qy = ay + t * aby; qz = az + t * abz
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const t = d2 / (d2 - d6)
      qx = ax + t * acx; qy = ay + t * acy; qz = az + t * acz
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const t = (d4 - d3) / (d4 - d3 + (d5 - d6))
      qx = v[b]! + t * (v[c]! - v[b]!); qy = v[b + 1]! + t * (v[c + 1]! - v[b + 1]!); qz = v[b + 2]! + t * (v[c + 2]! - v[b + 2]!)
    } else {
      const den = 1 / (va + vb + vc)
      const s = vb * den
      const t = vc * den
      qx = ax + abx * s + acx * t; qy = ay + aby * s + acy * t; qz = az + abz * s + acz * t
    }
  }
  return Math.hypot(px - qx, py - qy, pz - qz)
}

/**
 * 皮肤是否包得住内部结构。皮肤必须是单层封闭曲面。
 * exempt 给出皮肤作者有意不包住的部件的 id：这些部件不计入 outside / outside5mm / worst，
 * 而是单独报告在 notEnclosedByDesign 里。不在名单上的部件露出皮肤 5 mm 以上，outside5mm 就不为零。
 * Does the skin contain the internals? The skin must be a closed single-walled surface.
 * `exempt` holds the ids of the parts the skin's author deliberately did not enclose: they do not
 * count towards outside / outside5mm / worst and are reported apart, under notEnclosedByDesign. Any
 * part not on that list that lies more than 5 mm outside the skin makes outside5mm non-zero.
 */
export function checkSkinFit(skin: Mesh, deep: { id?: string; name: string; mesh: Mesh }[], exempt?: ReadonlySet<string>): SkinFit {
  const topo = edgeTopology(skin)
  const tester = new InsideTester(skin, 256)
  const surface = new SurfaceDistance(skin)
  // [0] 应当包住的部件，[1] 有意不包的部件 / [0] the parts to be enclosed, [1] the parts left out by design
  const sum = [{ total: 0, out: 0, out5: 0, parts: 0 }, { total: 0, out: 0, out5: 0, parts: 0 }]
  const rows: { name: string; outside: number; maxMm: number }[][] = [[], []]
  for (const d of deep) {
    const g = exempt && d.id !== undefined && exempt.has(d.id) ? 1 : 0
    const pts = thinPoints(surfacePoints(d.mesh, 0.006), 0.005)
    let o = 0
    let far = 0
    for (let i = 0; i < pts.length; i += 3) {
      if (tester.contains(pts[i]!, pts[i + 1]!, pts[i + 2]!)) continue
      o++
      const dist = surface.distance(pts[i]!, pts[i + 1]!, pts[i + 2]!, 0.05)
      if (dist > 0.005) sum[g]!.out5++
      if (dist > far) far = dist
    }
    const n = pts.length / 3
    sum[g]!.total += n
    sum[g]!.out += o
    sum[g]!.parts++
    if (n) rows[g]!.push({ name: d.name, outside: o / n, maxMm: Math.round(far * 1e4) / 10 })
  }
  const worst = (g: number) => rows[g]!.sort((a, b) => b.outside - a.outside || (a.name < b.name ? -1 : 1)).filter((r) => r.outside > 0).slice(0, 10)
  const share = (g: number, k: 'out' | 'out5') => (sum[g]!.total ? sum[g]![k] / sum[g]!.total : 0)
  return {
    closed: topo.boundaryEdges === 0, nonManifoldEdges: topo.nonManifoldEdges, outside: share(0, 'out'), outside5mm: share(0, 'out5'), worst: worst(0),
    ...(exempt ? { notEnclosedByDesign: { parts: sum[1]!.parts, outside: share(1, 'out'), outside5mm: share(1, 'out5'), worst: worst(1) } } : {}),
  }
}

/**
 * 一组点相对于皮肤的有符号距离（毫米；正 = 在皮肤外），以及在皮肤外的比例。
 * Signed distance of a set of points from the skin (mm; positive = outside), and the share outside.
 */
export function signedDistanceToSkin(tester: InsideTester, surface: SurfaceDistance, pts: Float32Array): { outside: number; minMm: number; medianMm: number; p99Mm: number; maxMm: number } {
  const d: number[] = []
  let o = 0
  for (let i = 0; i < pts.length; i += 3) {
    const inside = tester.contains(pts[i]!, pts[i + 1]!, pts[i + 2]!)
    if (!inside) o++
    d.push((inside ? -1 : 1) * surface.distance(pts[i]!, pts[i + 1]!, pts[i + 2]!, 0.1) * 1000)
  }
  d.sort((a, b) => a - b)
  const r1 = (v: number) => Math.round(v * 10) / 10
  const n = d.length
  return n ? { outside: Math.round((o / n) * 1e4) / 1e4, minMm: r1(d[0]!), medianMm: r1(d[n >> 1]!), p99Mm: r1(d[Math.floor(0.99 * (n - 1))]!), maxMm: r1(d[n - 1]!) } : { outside: 0, minMm: 0, medianMm: 0, p99Mm: 0, maxMm: 0 }
}

/** 被三角形用到的顶点的坐标（源网格里可能留有没被引用的顶点） / coordinates of the vertices used by a triangle (a source mesh may carry unreferenced ones) */
export function usedVertices(mesh: Mesh): Float32Array {
  const used = [...new Set(mesh.indices)].sort((a, b) => a - b)
  const out = new Float32Array(used.length * 3)
  used.forEach((v, i) => out.set(mesh.positions.subarray(3 * v, 3 * v + 3), 3 * i))
  return out
}

export interface FaceAgainstSkin {
  /** 皮肤下的覆盖厚度（毫米；负 = 在皮肤外）：最小值、中位数 / cover under the skin (mm; negative = outside the skin): least and median */
  cover: Record<string, { minMm: number; medianMm: number; parts: number } | null>
  /** 参数化模型的眼关节相对于眼球中心的位置（毫米）；lateralMm 为正表示眼关节更靠外 / the parametric model's eye joint relative to the centre of the eyeball (mm); lateralMm positive = the joint lies further from the midline */
  eyeJoint: Record<'L' | 'R', { distanceMm: number; lateralMm: number; offsetMm: number[] }> | null
}

/**
 * 面部几处结构在皮肤下有多深。皮肤包按设计不把眼睑区和唇区的皮肤外推去盖住其下的结构，
 * 所以睑缘处的眼轮匝肌内环（睑部）、角膜、唇会略微露出；这里量出实际的数，写进报告和说明。
 * How deep a few facial structures lie under the skin. By design a skin package does not push the
 * lid and lip skin out to cover what lies there, so the inner ring of orbicularis oculi at the lid
 * margins (its palpebral part), the cornea and the lips come through slightly; the actual figures
 * are measured here for the report and the cautions.
 */
export function faceAgainstSkin(skin: Mesh, parts: { name: string; mesh: Mesh }[], eyeJoints: SkinPackage['eyeJoints']): FaceAgainstSkin {
  const tester = new InsideTester(skin, 256)
  const surface = new SurfaceDistance(skin)
  const groups: [string, RegExp][] = [
    ['palpebralOrbicularisOculi', /^palpebral part of (left|right) orbicularis oculi$/i],
    ['orbitalOrbicularisOculi', /^orbital part of (left|right) orbicularis oculi$/i],
    ['cornea', /^(left|right) cornea$/i],
    // 唇：一个部件，或切开后的上唇和下唇（lipSplit.ts） / the lip: one part, or upper and lower lip after the split (lipSplit.ts)
    ['lip', /^(upper |lower )?lip$/i],
    ['nasalCartilages', /\b(nasal|alar) cartilage$/i],
    ['orbicularisOris', /^orbicularis oris$/i],
    ['mandible', /^mandible$/i],
  ]
  const cover: FaceAgainstSkin['cover'] = {}
  for (const [key, rx] of groups) {
    const list = parts.filter((p) => rx.test(p.name))
    if (!list.length) {
      cover[key] = null
      continue
    }
    const pts: number[] = []
    for (const p of list) {
      // 三角形用到的顶点，加上表面的密采样 / the vertices used by a triangle, plus a dense sampling of the surface
      for (const v of usedVertices(p.mesh)) pts.push(v)
      for (const v of surfacePoints(p.mesh, 0.001)) pts.push(v)
    }
    const d = signedDistanceToSkin(tester, surface, Float32Array.from(pts))
    // 覆盖厚度 = −有符号距离 / cover = −signed distance
    cover[key] = { minMm: -d.maxMm, medianMm: -d.medianMm, parts: list.length }
  }
  let eyeJoint: FaceAgainstSkin['eyeJoint'] = null
  if (eyeJoints) {
    const out: Partial<Record<'L' | 'R', { distanceMm: number; lateralMm: number; offsetMm: number[] }>> = {}
    for (const [side, word] of [['L', 'left'], ['R', 'right']] as const) {
      const sclera = parts.find((p) => new RegExp(`^${word} sclera$`, 'i').test(p.name))
      if (!sclera) continue
      // 眼球中心取巩膜表面的面积加权质心（巩膜近似球面）。不用包围盒：BodyParts3D 的 "Right sclera"（FJ1368）
      // 在身体左侧 x = +31 mm 处带着一粒 3 µm 大的碎屑，会把包围盒的中心拉偏 24 mm。
      // The centre of the globe is the area-weighted centroid of the sclera's surface (the sclera is nearly a
      // sphere). Not the bounding box: "Right sclera" of BodyParts3D (FJ1368) carries a 3 µm speck at
      // x = +31 mm, on the body's left, which would pull the centre of the box 24 mm off.
      const c = measure(sclera.mesh).centroid
      const j = eyeJoints[side]
      const off = [j[0] - c[0]!, j[1] - c[1]!, j[2] - c[2]!]
      const r1 = (v: number) => Math.round(v * 1e4) / 10
      out[side] = { distanceMm: r1(Math.hypot(off[0]!, off[1]!, off[2]!)), lateralMm: r1(side === 'L' ? off[0]! : -off[0]!), offsetMm: off.map(r1) }
    }
    if (out.L && out.R) eyeJoint = { L: out.L, R: out.R }
  }
  return { cover, eyeJoint }
}

// ── 面部保留原始分辨率 / the face kept at source resolution ─────────────────────────────────────────
// 整张皮肤简化到约 1.4 万个顶点后，面部只剩约 1,400 个顶点、边长 5–7 mm，做不出表情。
// 因此面部区域的顶点一个也不动（锁定），其余部分照旧简化。仍是一个部件、一张网格：
// 简化器只在同一张网格上合并未锁定的顶点，两种分辨率之间不会出现缝。
// Simplified as a whole to about 14k vertices, the skin keeps only about 1,400 vertices in the face,
// with 5–7 mm edges: too coarse for facial expression. So the vertices of the face region are locked
// (none is moved or removed) and the rest is simplified as before. It stays one part and one mesh:
// the simplifier only collapses unlocked vertices of that one mesh, so no seam opens between the
// two resolutions.

/**
 * 表情肌（按名称选）：面部区域以它们为准。不含颈阔肌（下行到颈、胸）、枕肌和颞顶肌（在头的后部和侧面）。
 * The muscles of facial expression (by name): they define the face region. Platysma (runs down
 * the neck onto the chest), occipitalis and temporoparietalis (back and side of the head) are left out.
 */
export const FACE_MUSCLE_NAME = /buccinator|corrugator supercilii|depressor (anguli oris|labii inferioris|septi nasi)|frontalis|levator (anguli oris|labii superioris)|mentalis|nasalis|procerus|risorius|zygomaticus|orbicularis (oris|oculi)/i
/** 面部区域：距表情肌表面不超过此距离的皮肤顶点（米） / the face region: skin vertices no further than this from the surface of a muscle of facial expression (m) */
export const FACE_REGION_RADIUS = 0.03

/**
 * 面部区域的顶点掩码：皮肤顶点到任一表情肌表面的距离 ≤ radius 的记 1。
 * 规则只用到本体自己的表情肌，男女通用，不依赖皮肤包的顶点编号。
 * Vertex mask of the face region: 1 where a skin vertex lies within `radius` of the surface of any
 * muscle of facial expression. The rule uses only the body's own facial muscles, so it serves both
 * bodies and does not depend on the vertex numbering of the skin package.
 */
export function faceRegionOfSkin(skin: Mesh, facialMuscles: Mesh[], radius = FACE_REGION_RADIUS): Uint8Array {
  const nv = skin.positions.length / 3
  const mask = new Uint8Array(nv)
  if (!facialMuscles.length) return mask
  const pts: number[] = []
  for (const m of facialMuscles) for (const v of thinPoints(surfacePoints(m, 0.002), 0.002)) pts.push(v)
  const index = new PointIndex(Float32Array.from(pts), 0.01)
  for (let v = 0; v < nv; v++) {
    if (index.distance(skin.positions[3 * v]!, skin.positions[3 * v + 1]!, skin.positions[3 * v + 2]!, radius + 0.005) <= radius) mask[v] = 1
  }
  return mask
}

export interface SkinResolution {
  vertices: number
  triangles: number
  /** 面部区域内的顶点数、两端都在区域内的边的平均长度和最大长度（毫米） / vertices in the face region; mean and largest length of the edges with both ends in it (mm) */
  face: { vertices: number; triangles: number; meanEdgeMm: number; p95EdgeMm: number; maxEdgeMm: number }
  /** 区域之外 / outside the region */
  rest: { vertices: number; meanEdgeMm: number }
}

/** 网格在面部区域内外的分辨率 / resolution of a mesh inside and outside the face region */
export function skinResolution(mesh: Mesh, inFace: Uint8Array): SkinResolution {
  const nv = mesh.positions.length / 3
  const p = mesh.positions
  let fv = 0
  for (let v = 0; v < nv; v++) fv += inFace[v]!
  const faceLens: number[] = []
  let restSum = 0
  let restN = 0
  let ft = 0
  for (let t = 0; t < mesh.indices.length; t += 3) {
    if (inFace[mesh.indices[t]!] && inFace[mesh.indices[t + 1]!] && inFace[mesh.indices[t + 2]!]) ft++
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[t + k]!
      const b = mesh.indices[t + ((k + 1) % 3)]!
      // 每条边在两个三角形里各出现一次，只数一次 / every edge appears once in each of its two triangles: count it once
      if (a > b) continue
      const l = Math.hypot(p[3 * a]! - p[3 * b]!, p[3 * a + 1]! - p[3 * b + 1]!, p[3 * a + 2]! - p[3 * b + 2]!)
      if (inFace[a] && inFace[b]) faceLens.push(l)
      else if (!inFace[a] && !inFace[b]) {
        restSum += l
        restN++
      }
    }
  }
  faceLens.sort((a, b) => a - b)
  const r2 = (v: number) => Math.round(v * 1e5) / 100
  return {
    vertices: nv,
    triangles: mesh.indices.length / 3,
    face: { vertices: fv, triangles: ft, meanEdgeMm: faceLens.length ? r2(faceLens.reduce((a, b) => a + b, 0) / faceLens.length) : 0, p95EdgeMm: faceLens.length ? r2(faceLens[Math.floor(0.95 * (faceLens.length - 1))]!) : 0, maxEdgeMm: faceLens.length ? r2(faceLens[faceLens.length - 1]!) : 0 },
    rest: { vertices: nv - fv, meanEdgeMm: restN ? r2(restSum / restN) : 0 },
  }
}

export interface SkinSimplifyResult {
  mesh: Mesh
  /** 输出网格的面部掩码（与输入的掩码对应同一批顶点） / face mask of the output mesh (the same vertices as in the input mask) */
  inFace: Uint8Array
  error: number
  /**
   * 输出网格的每个顶点在输入网格里的下标。简化器不产生新顶点，所以每个输出顶点都有对应；
   * 位置重合的顶点（上下唇缘）靠它区分，不靠位置。
   * For every vertex of the output mesh, its index in the input mesh. The simplifier creates no vertices,
   * so every output vertex has one; coincident vertices (the two lip margins) are told apart by it, not by position.
   */
  source: Uint32Array
  /** 被简化器丢掉后又原样补回的全锁定三角形数（见函数说明） / fully locked triangles the simplifier dropped and that were put back as they were (see the function) */
  restoredTriangles: number
}

/**
 * 简化皮肤，面部区域（keep 为 1 的顶点）保持原样。keep 之外按与其他部件相同的规则简化：
 * 误差上限 maxError，三角形数不少于“区域外面积 / 边长 maxEdge 的正三角形面积”。
 * 锁定的顶点既不移动也不被合并，三个顶点都锁定的三角形原样保留。
 * Simplifies the skin, leaving the face region (vertices with keep = 1) as it is. Outside it the
 * rule is the one every other part gets: error at most maxError, and no fewer triangles than
 * "area outside the region / area of an equilateral triangle of edge maxEdge". A locked vertex is
 * neither moved nor collapsed, and a triangle whose three vertices are locked is kept as it is.
 */
export async function simplifySkinKeepingFace(mesh: Mesh, keep: Uint8Array, maxError: number, maxEdge: number, minTriangles: number): Promise<SkinSimplifyResult> {
  await MeshoptSimplifier.ready
  const p = mesh.positions
  let lockedTriangles = 0
  let restArea = 0
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]!
    const b = mesh.indices[t + 1]!
    const c = mesh.indices[t + 2]!
    if (keep[a] && keep[b] && keep[c]) {
      lockedTriangles++
      continue
    }
    const ux = p[3 * b]! - p[3 * a]!
    const uy = p[3 * b + 1]! - p[3 * a + 1]!
    const uz = p[3 * b + 2]! - p[3 * a + 2]!
    const vx = p[3 * c]! - p[3 * a]!
    const vy = p[3 * c + 1]! - p[3 * a + 1]!
    const vz = p[3 * c + 2]! - p[3 * a + 2]!
    restArea += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
  }
  const floor = Math.max(minTriangles, restArea / (0.433 * maxEdge ** 2))
  const target = 3 * (lockedTriangles + Math.floor(floor))
  const nv = p.length / 3
  const identity = (): Uint32Array => Uint32Array.from({ length: nv }, (_, v) => v)
  if (target >= mesh.indices.length) return { mesh, inFace: keep, error: 0, source: identity(), restoredTriangles: 0 }
  const [simplified, err] = MeshoptSimplifier.simplifyWithAttributes(mesh.indices, mesh.positions, 3, new Float32Array(0), 0, [], keep, target, maxError, ['ErrorAbsolute'])
  if (simplified.length === 0 || simplified.length >= mesh.indices.length) return { mesh, inFace: keep, error: 0, source: identity(), restoredTriangles: 0 }
  // 简化器内部按位置把重合的顶点看成一个：含有两个重合顶点的三角形（面积为零，移植片的供体网格里有）
  // 在它看来是退化的，即使三个顶点都锁定也会被丢掉，网格上就多出边界边。把这样丢掉的全锁定三角形原样补回，
  // 让“全锁定的三角形原样保留”这句话成立。锁定的顶点没有移动，补回的三角形与原来的一模一样。
  // Internally the simplifier treats coincident vertices as one: a triangle with two coincident vertices
  // (zero area; the donor mesh of a graft has some) is degenerate to it and is dropped even when all three
  // of its vertices are locked, which leaves boundary edges. Such dropped fully locked triangles are put
  // back as they were, so that "a fully locked triangle is kept as it is" holds. Locked vertices have not
  // moved, so a restored triangle is exactly the original.
  let idx: Uint32Array = simplified
  let restoredTriangles = 0
  {
    const key = (a: number, b: number, c: number): string => {
      // 旋转到最小下标在前，保留绕向 / rotate the smallest index to the front, keeping the winding
      if (a <= b && a <= c) return `${a},${b},${c}`
      if (b <= a && b <= c) return `${b},${c},${a}`
      return `${c},${a},${b}`
    }
    const present = new Set<string>()
    for (let t = 0; t < simplified.length; t += 3) present.add(key(simplified[t]!, simplified[t + 1]!, simplified[t + 2]!))
    const missing: number[] = []
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]!
      const b = mesh.indices[t + 1]!
      const c = mesh.indices[t + 2]!
      if (!(keep[a] && keep[b] && keep[c])) continue
      const k = key(a, b, c)
      if (present.has(k)) continue
      present.add(k)
      missing.push(a, b, c)
    }
    if (missing.length) {
      restoredTriangles = missing.length / 3
      const all = new Uint32Array(simplified.length + missing.length)
      all.set(simplified)
      all.set(missing, simplified.length)
      idx = all
    }
  }
  // compact 按索引首次出现的次序重排顶点；掩码跟着重排 / compact renumbers vertices in order of first use; the mask follows
  const map = new Int32Array(nv).fill(-1)
  let n = 0
  for (let k = 0; k < idx.length; k++) if (map[idx[k]!] === -1) map[idx[k]!] = n++
  const inFace = new Uint8Array(n)
  const source = new Uint32Array(n)
  for (let v = 0; v < nv; v++) if (map[v]! >= 0) {
    inFace[map[v]!] = keep[v]!
    source[map[v]!] = v
  }
  return { mesh: compact({ positions: mesh.positions, indices: idx }), inFace, error: err, source, restoredTriangles }
}

// ── 开口后的皮肤 / the opened skin ──────────────────────────────────────────────────────────────────

/**
 * 边界环：只被一个三角形用到的边连成的环。闭合曲面为 0；开口后的皮肤应为 2（两眼内卷的内缘）。
 * 环按边界边的连通分量数；sizes 是各环的边数，从大到小。
 * Boundary loops: the loops formed by edges used by one triangle only. None on a closed surface; two on
 * an opened skin (the inner edges of the two lid rims). Loops are the connected components of the
 * boundary edges; `sizes` holds their edge counts, largest first.
 */
export function boundaryLoops(mesh: Mesh): { edges: number; loops: number; sizes: number[] } {
  const nv = mesh.positions.length / 3
  const count = new Map<number, number>()
  for (let t = 0; t < mesh.indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = mesh.indices[t + k]!
    const b = mesh.indices[t + ((k + 1) % 3)]!
    const key = Math.min(a, b) * nv + Math.max(a, b)
    count.set(key, (count.get(key) ?? 0) + 1)
  }
  const parent = new Map<number, number>()
  const find = (v: number): number => {
    let r = v
    while (parent.get(r) !== r) r = parent.get(r)!
    let c = v
    while (parent.get(c) !== r) {
      const next = parent.get(c)!
      parent.set(c, r)
      c = next
    }
    return r
  }
  const edges: [number, number][] = []
  for (const [key, c] of count) {
    if (c !== 1) continue
    const a = Math.floor(key / nv)
    const b = key % nv
    edges.push([a, b])
    if (!parent.has(a)) parent.set(a, a)
    if (!parent.has(b)) parent.set(b, b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb))
  }
  const size = new Map<number, number>()
  for (const [a] of edges) size.set(find(a), (size.get(find(a)) ?? 0) + 1)
  const sizes = [...size.values()].sort((x, y) => y - x)
  return { edges: edges.length, loops: sizes.length, sizes }
}

/**
 * 简化时要锁住的顶点：面部区域，加上标签非 0 的全部顶点（唇缘、睑缘、内卷、口腔袋、移植片及其过渡环）。
 * The vertices the simplifier must leave alone: the face region plus every vertex with a non-zero tag
 * (lip and lid margins, rims, oral pouch, graft patches and their blend rings).
 */
export function skinLockMask(inFace: Uint8Array, tags: Uint8Array | null): Uint8Array {
  const lock = Uint8Array.from(inFace)
  if (tags) for (let v = 0; v < lock.length; v++) if (tags[v]) lock[v] = 1
  return lock
}

/**
 * 由发布的（简化后的）开口皮肤得到与它对应的闭合曲面，供判断内外用：去掉内卷和口腔袋的三角形，
 * 补回封住睑裂的三角形，再把下唇缘的复制顶点并回它的孪生顶点。全部按下标做（source-vertex.u32、
 * 标签、manifest 里的三角形表），不按位置。睑缘、唇缘顶点在简化时是锁定的，所以一定都在。
 * 返回的网格若仍有边界边（比如包的标签表与这里的假定不符），调用方应当不用它。
 * The closed counterpart of the shipped (simplified) opened skin, for inside tests: the triangles of rims
 * and pouch are removed, the triangles that closed the palpebral fissures are put back, and the duplicated
 * lower-lip margin vertices are merged into their twins. All of it by index (source-vertex.u32, the tags
 * and the triangle list of the manifest), nothing by position. Lid and lip margin vertices were locked in
 * the simplification, so all of them are present. If the result still has boundary edges (the package's
 * tags not being what is assumed here, say), the caller should not use it.
 * @param shipped  发布的开口皮肤 / the shipped opened skin
 * @param source   shipped 的每个顶点在包的 skin.obj 里的下标 / for each vertex of `shipped`, its index in the package's skin.obj
 */
export function closeShippedSkin(shipped: Mesh, source: Uint32Array, opened: OpenedSkin): Mesh {
  const T = opened.tagNames
  const aid = new Set([T.lidRimL, T.lidRimR, T.oralPouchUpper, T.oralPouchLower, T.oralPouchSeam].filter((x): x is number => x !== undefined))
  const nv = shipped.positions.length / 3
  // 包的顶点下标 → 发布的顶点下标 / package vertex index → shipped vertex index
  const shippedOf = new Map<number, number>()
  for (let v = 0; v < nv; v++) shippedOf.set(source[v]!, v)
  // 复制出来的顶点（下标 ≥ closedVertices 且不是构造物）并回它的来源顶点 / duplicated vertices (index ≥ closedVertices, not a construction aid) go back to their source vertex
  const to = new Uint32Array(nv)
  for (let v = 0; v < nv; v++) {
    const s = source[v]!
    to[v] = v
    if (s >= opened.closedVertices && !aid.has(opened.tags[s]!)) {
      const twin = shippedOf.get(opened.sourceVertex[s]!)
      if (twin !== undefined) to[v] = twin
    }
  }
  const idx: number[] = []
  for (let t = 0; t < shipped.indices.length; t += 3) {
    const a = shipped.indices[t]!
    const b = shipped.indices[t + 1]!
    const c = shipped.indices[t + 2]!
    if (aid.has(opened.tags[source[a]!]!) || aid.has(opened.tags[source[b]!]!) || aid.has(opened.tags[source[c]!]!)) continue
    idx.push(to[a]!, to[b]!, to[c]!)
  }
  for (let t = 0; t < opened.eyeMembrane.length; t += 3) {
    const a = shippedOf.get(opened.eyeMembrane[t]!)
    const b = shippedOf.get(opened.eyeMembrane[t + 1]!)
    const c = shippedOf.get(opened.eyeMembrane[t + 2]!)
    if (a === undefined || b === undefined || c === undefined) continue
    idx.push(a, b, c)
  }
  return compact({ positions: shipped.positions, indices: Uint32Array.from(idx) })
}

export interface SkinPackageChoice {
  /** 要装入的包；没有可装的为 null / the package to install; null when there is none to install */
  pkg: SkinPackage | null
  /** 它的目录（相对项目根） / its directory (relative to the project root) */
  dir: string
  /** 'opened' = 开口后的包；'closed' = 皮肤作者的闭合包；'none' = 都不能装 / 'opened' = the opened package; 'closed' = the author's closed package; 'none' = neither can be installed */
  state: 'opened' | 'closed' | 'none'
  /** 不装入的原因（state 为 none 时） / why nothing is installed (when state is 'none') */
  reason?: string
  /** 开口后的包的情况；没有那个目录时不出现 / the state of the opened package; absent when that directory does not exist */
  openedPackage?: { dir: string; fittedTo: { body: string; key: string } | null; used: boolean; reason?: string; matchesAuthorPackage: boolean | null }
  /** 皮肤作者的包（始终读入，用来报告） / the author's package (always read, for the report) */
  author: SkinPackage | null
}

/**
 * 选要装入的皮肤包，男女通用。`<authorDir>-open/` 存在、是开口后的包、且其 manifest.fittedTo
 * （由作者的包原样带过来）与本体及本次内部结构指纹一致时装它；否则照旧看作者的闭合包 authorDir。
 * 还核对开口后的包是不是由磁盘上这一版作者的包做出来的（包里的 skin-delivered.obj，没有移植时是
 * skin-closed.obj，应与作者的 skin.obj 逐字节相同）：不相同只报告，不拒绝——它仍是按同一指纹拟合的、
 * 自身一致的包。SOMA_SKIN_OPENED=0 时不看开口后的包（用来核对闭合包的行为没有变）。
 * Chooses the skin package to install; serves both bodies. `<authorDir>-open/` is installed when it
 * exists, is an opened package and its manifest.fittedTo (carried over from the author's package) names
 * this body and this build's internals fingerprint; otherwise the author's closed package `authorDir`
 * is considered as before. Whether the opened package was made from the author's package now on disk is
 * checked too (skin-delivered.obj of the package, or skin-closed.obj when nothing was grafted, must equal
 * the author's skin.obj byte for byte): a mismatch is reported, not refused — it is still a
 * self-consistent package fitted to the same fingerprint. With SOMA_SKIN_OPENED=0 the opened package is
 * ignored (to check that the behaviour with a closed package is unchanged).
 */
export function selectSkinPackage(root: string, authorDir: string, body: string, key: string): SkinPackageChoice {
  const author = loadSkinPackage(join(root, authorDir))
  const openDir = `${authorDir.replace(/\/+$/, '')}-open`
  const fitsKey = (p: SkinPackage | null): boolean => !!p && p.fittedTo?.body === body && p.fittedTo.key === key
  const why = (p: SkinPackage | null): string => (!p ? 'no package' : !p.fittedTo ? 'the package does not say which internals it was fitted to (manifest.fittedTo missing)' : 'fitted to other internals')
  let openedPackage: SkinPackageChoice['openedPackage']
  if (existsSync(join(root, openDir, 'manifest.json'))) {
    if (process.env.SOMA_SKIN_OPENED === '0') openedPackage = { dir: openDir, fittedTo: null, used: false, reason: 'ignored (SOMA_SKIN_OPENED=0)', matchesAuthorPackage: null }
    else {
      const op = loadSkinPackage(join(root, openDir))
      let matches: boolean | null = null
      const authorObj = join(root, authorDir, 'skin.obj')
      const delivered = [join(root, openDir, 'skin-delivered.obj'), join(root, openDir, 'skin-closed.obj')].find((f) => existsSync(f))
      if (delivered && existsSync(authorObj)) matches = readFileSync(delivered).equals(readFileSync(authorObj))
      const reason = !op ? 'manifest.json or skin.obj missing' : !op.opened ? 'not an opened package (skin-closed.obj, vertex-tags.u8 or source-vertex.u32 missing)' : fitsKey(op) ? undefined : why(op)
      openedPackage = { dir: openDir, fittedTo: op?.fittedTo ?? null, used: !reason, ...(reason ? { reason } : {}), matchesAuthorPackage: matches }
      if (op && !reason) return { pkg: op, dir: openDir, state: 'opened', openedPackage, author }
    }
  }
  if (fitsKey(author)) return { pkg: author, dir: authorDir, state: 'closed', ...(openedPackage ? { openedPackage } : {}), author }
  return { pkg: null, dir: authorDir, state: 'none', reason: why(author), ...(openedPackage ? { openedPackage } : {}), author }
}

/**
 * 皮肤包只保证包住肌、骨、软骨和器官。贴在它们外面的薄结构（筋膜、皮神经、浅静脉）以及为旧皮肤做的
 * 体表部件（头发、眉、外耳、甲）不在拟合之列：这里量出它们露在皮肤外的程度，并给出相应的说明。
 * A skin package only promises to enclose muscles, bones, cartilages and organs. The thin structures
 * lying on them (fasciae, cutaneous nerves, superficial veins) and the surface parts made for the
 * earlier skin (hair, eyebrows, external ears, nails) were not part of the fit: how far they come
 * through the skin is measured here, and the caution that says so is written.
 */
export function notFittedAgainstSkin(skin: Mesh, thin: { name: string; mesh: Mesh }[], surfaceParts: { name: string; mesh: Mesh }[]): { thin: SkinFit; surfaceParts: SkinFit; caution: { zh: string; en: string } } {
  const t = checkSkinFit(skin, thin)
  const sp = checkSkinFit(skin, surfaceParts)
  const worst = [...t.worst].sort((a, b) => b.maxMm - a.maxMm)[0]
  const pct = (t.outside * 100).toFixed(1)
  const far = worst ? worst.maxMm.toFixed(0) : '0'
  const bare = (n: string) => n.replace(/^(Left|Right) /, '').toLowerCase()
  const names = [...new Set(sp.worst.filter((w) => w.outside > 0.1).map((w) => bare(w.name)))]
  return {
    thin: t,
    surfaceParts: sp,
    caution: {
      en: `The skin was fitted to enclose muscles, bones, cartilages and organs only. Fasciae, cutaneous nerves and superficial vessels lying on them were not considered, and ${pct}% of their surface comes through the skin, by up to ${far} mm${worst ? ` (${bare(worst.name)})` : ''}.${names.length ? ` Surface parts made for the earlier skin do not sit on this one: ${names.join(', ')}.` : ''}`,
      zh: `皮肤拟合时只保证包住肌、骨、软骨和器官，贴在它们外面的筋膜、皮神经和浅血管没有考虑：这些结构的表面有 ${pct}% 露在皮肤之外，最多 ${far} mm。${names.length ? `为旧皮肤制作的体表部件（头发、眉、外耳、甲、阴毛等）与这层皮肤对不上。` : ''}`,
    },
  }
}
