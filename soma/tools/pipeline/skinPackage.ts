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

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SourceInfo } from '../../src/anatomy/types.ts'
import type { Mesh } from './geometry.ts'
import { InsideTester, PointIndex, surfacePoints, thinPoints } from './register.ts'

export interface SkinPackage {
  mesh: Mesh
  source: SourceInfo
  /** 包声明它所拟合的内部结构；缺省表示未声明 / what the package says it was fitted to; absent when it does not say */
  fittedTo: { body: string; key: string } | null
  manifest: Record<string, unknown>
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

/** 读皮肤包；目录或必需文件不存在时返回 null / reads a skin package; null when the directory or a required file is missing */
export function loadSkinPackage(dir: string): SkinPackage | null {
  const mf = join(dir, 'manifest.json')
  const obj = join(dir, 'skin.obj')
  if (!existsSync(mf) || !existsSync(obj)) return null
  const manifest = JSON.parse(readFileSync(mf, 'utf8')) as Record<string, unknown>
  const src = (manifest.source ?? {}) as Record<string, string>
  if (!src.name || !src.license) throw new Error(`skin package ${mf}: manifest.source needs name and license`)
  const fitted = manifest.fittedTo as { body?: string; key?: string } | undefined
  return {
    mesh: parseSkinObj(readFileSync(obj, 'utf8')),
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
  /** 皮肤是否封闭（每条边恰为两个三角形共用） / is the skin closed (every edge shared by exactly two triangles) */
  closed: boolean
  /** 深部结构表面采样点落在皮肤之外的比例，以及其中超出 5 mm 的比例 / share of deep-part surface samples outside the skin, and of those more than 5 mm outside */
  outside: number
  outside5mm: number
  /** 最靠外的若干部件 / the parts that stick out most */
  worst: { name: string; outside: number }[]
}

/**
 * 皮肤是否包得住内部结构。皮肤必须是单层封闭曲面。
 * Does the skin contain the internals? The skin must be a closed single-walled surface.
 */
export function checkSkinFit(skin: Mesh, deep: { name: string; mesh: Mesh }[]): SkinFit {
  const edges = new Map<number, number>()
  const nv = skin.positions.length / 3
  for (let t = 0; t < skin.indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = skin.indices[t + k]!
    const b = skin.indices[t + ((k + 1) % 3)]!
    const key = Math.min(a, b) * nv + Math.max(a, b)
    edges.set(key, (edges.get(key) ?? 0) + 1)
  }
  let closed = true
  for (const c of edges.values()) if (c !== 2) {
    closed = false
    break
  }
  const tester = new InsideTester(skin, 256)
  const surface = new PointIndex(thinPoints(surfacePoints(skin, 0.003), 0.002), 0.01)
  let total = 0
  let out = 0
  let out5 = 0
  const rows: { name: string; outside: number }[] = []
  for (const d of deep) {
    const pts = thinPoints(surfacePoints(d.mesh, 0.006), 0.005)
    let o = 0
    for (let i = 0; i < pts.length; i += 3) {
      if (tester.contains(pts[i]!, pts[i + 1]!, pts[i + 2]!)) continue
      o++
      if (surface.distance(pts[i]!, pts[i + 1]!, pts[i + 2]!, 0.02) > 0.005) out5++
    }
    const n = pts.length / 3
    total += n
    out += o
    if (n) rows.push({ name: d.name, outside: o / n })
  }
  rows.sort((a, b) => b.outside - a.outside || (a.name < b.name ? -1 : 1))
  return { closed, outside: total ? out / total : 0, outside5mm: total ? out5 / total : 0, worst: rows.filter((r) => r.outside > 0).slice(0, 10) }
}
