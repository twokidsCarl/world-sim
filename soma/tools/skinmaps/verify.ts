// 皮肤分区图的数值检验：面积与左右对称、关键感觉点、经典检查点、两图一致性、连通性。
// Numeric checks of the skin maps: areas and left/right symmetry, key sensory points, classic
// checkpoints, agreement between the two maps, contiguity.

import type { MapDef, RegionDef } from './build.ts'
import type { Landmarks, SideLR, SkinExpr } from './landmarks.ts'
import type { Skin } from './mesh.ts'

export interface Text { zh: string; en: string }

export interface CheckDef {
  name: Text
  at: SkinExpr
  /** 可接受的分区 key（任一即可）/ Region keys that are acceptable (any one). */
  expect: string[]
  source: string
}

export interface AreaRow { key: string; L: number; R: number; ratio: number | null; flagged: boolean }

const isLeft = (skin: Skin, v: number) => skin.positions[v * 3]! >= skin.midX

/** 外壁顶点中未分配的比例 / Fraction of outer-wall vertices left unassigned (255). */
export function unassigned(skin: Skin, labels: Uint8Array): { count: number; fraction: number; innerCount: number } {
  let c = 0, n = 0, inner = 0
  for (let i = 0; i < skin.n; i++) {
    if (skin.outer[i]) { n++; if (labels[i] === 255) c++ } else if (labels[i] === 255) inner++
  }
  return { count: c, fraction: c / n, innerCount: inner }
}

/** 各区每侧面积（cm²，仅外壁）及左右比 / Area per region and side (cm², outer wall only) with the L/R ratio. */
export function areas(skin: Skin, labels: Uint8Array, regions: RegionDef[]): AreaRow[] {
  const L = new Float64Array(regions.length), R = new Float64Array(regions.length)
  for (let i = 0; i < skin.n; i++) {
    if (!skin.outer[i] || labels[i] === 255) continue
    ;(isLeft(skin, i) ? L : R)[labels[i]!]! += skin.area[i]! * 1e4
  }
  return regions.map((r, k) => {
    const ratio = R[k]! > 0 ? L[k]! / R[k]! : null
    return { key: r.key, L: +L[k]!.toFixed(1), R: +R[k]!.toFixed(1), ratio: ratio === null ? null : +ratio.toFixed(3), flagged: ratio === null || ratio < 0.8 || ratio > 1.25 }
  })
}

export interface PointResult { name: string; side: SideLR; got: string; expect: string[]; ok: boolean; source?: string }

/** 标志点所在的分区 / The region a landmark's skin vertex lies in. */
export function regionAt(lm: Landmarks, labels: Uint8Array, regions: RegionDef[], at: SkinExpr, side: SideLR): string {
  const l = labels[lm.vertex(at, side)]!
  return l === 255 ? '(unassigned)' : regions[l]!.key
}

/** 每个带 pin 的种子（关键感觉点）是否落在本区 / Whether every pinned seed (key sensory point) lies in its own region. */
export function keyPoints(lm: Landmarks, labels: Uint8Array, def: MapDef): PointResult[] {
  const out: PointResult[] = []
  for (const r of def.regions)
    for (const s of r.seeds) {
      if (!s.pin || !s.curve) continue
      for (const side of ['L', 'R'] as SideLR[])
        for (const item of s.curve) {
          const got = regionAt(lm, labels, def.regions, item as SkinExpr, side)
          out.push({ name: typeof item === 'string' ? item : JSON.stringify(item), side, got, expect: [r.key], ok: got === r.key })
        }
    }
  return out
}

export function checks(lm: Landmarks, labels: Uint8Array, def: MapDef, list: CheckDef[]): PointResult[] {
  const out: PointResult[] = []
  for (const c of list)
    for (const side of ['L', 'R'] as SideLR[]) {
      const got = regionAt(lm, labels, def.regions, c.at, side)
      out.push({ name: c.name.en, side, got, expect: c.expect, ok: c.expect.includes(got), source: c.source })
    }
  return out
}

/** 教科书节段 → 皮节图分区 key / Textbook segment → region key(s) of the dermatome map. */
export function segmentKeys(seg: string): string[] {
  if (seg === 'V') return ['V1', 'V2', 'V3']
  if (seg === 'S4' || seg === 'S5' || seg === 'Co') return ['S4-5']
  return [seg]
}

export interface CompositionRow {
  key: string
  basis: string
  segments: string[]
  areaCm2: number
  /** 面积落在教科书节段皮节内的比例 / Share of the territory's area lying in the dermatomes of its textbook segments. */
  inExpected: number
  /** 同上，但把相邻一个节段也算作符合 / Same, also counting dermatomes one segment away as agreeing. */
  inExpectedOrAdjacent: number
  top: { dermatome: string; share: number }[]
  flagged: boolean
}

/** 每个皮神经分布区的皮节构成，与其教科书节段比较 / Dermatome composition of each nerve territory against its textbook root values. */
export function composition(skin: Skin, derm: { def: MapDef; labels: Uint8Array }, cut: { def: MapDef; labels: Uint8Array }): CompositionRow[] {
  const nd = derm.def.regions.length
  const order = derm.def.regions.map((r) => r.key)
  return cut.def.regions.map((r, k) => {
    const a = new Float64Array(nd)
    let total = 0
    for (let i = 0; i < skin.n; i++) {
      if (!skin.outer[i] || cut.labels[i] !== k || derm.labels[i] === 255) continue
      a[derm.labels[i]!]! += skin.area[i]!
      total += skin.area[i]!
    }
    const segs = (r.segments as string[] | undefined) ?? []
    const want = new Set(segs.flatMap(segmentKeys))
    const near = new Set(want)
    // 相邻节段：皮节表中序号相差 1（三叉神经各支除外）/ Adjacent = next in the dermatome list (not across the trigeminal divisions).
    for (const w of want) {
      const i = order.indexOf(w)
      if (i < 3) continue
      if (i - 1 >= 3) near.add(order[i - 1]!)
      if (i + 1 < nd) near.add(order[i + 1]!)
    }
    let inE = 0, inN = 0
    for (let d = 0; d < nd; d++) {
      if (want.has(order[d]!)) inE += a[d]!
      if (near.has(order[d]!)) inN += a[d]!
    }
    const top = [...a].map((v, d) => ({ dermatome: order[d]!, share: total ? +(v / total).toFixed(3) : 0 })).filter((x) => x.share >= 0.05).sort((x, y) => y.share - x.share || x.dermatome.localeCompare(y.dermatome)).slice(0, 4)
    const inExpected = total ? +(inE / total).toFixed(3) : 0
    return { key: r.key, basis: String(r.basis), segments: segs, areaCm2: +(total * 1e4).toFixed(1), inExpected, inExpectedOrAdjacent: total ? +(inN / total).toFixed(3) : 0, top, flagged: inExpected < 0.5 }
  })
}

export interface Piece { region: string; side: SideLR; pieces: number; smallerCm2: number[] }

/** 每区每侧的连通块数；只列出多于一块者 / Connected pieces per region and side; only regions in more than one piece are listed. */
export function pieces(skin: Skin, labels: Uint8Array, regions: RegionDef[]): Piece[] {
  const seen = new Uint8Array(skin.n)
  const by = new Map<string, number[]>()
  for (let i = 0; i < skin.n; i++) {
    if (!skin.outer[i] || seen[i] || labels[i] === 255) continue
    const left = isLeft(skin, i)
    const stack = [i]
    seen[i] = 1
    let area = 0
    while (stack.length) {
      const v = stack.pop()!
      area += skin.area[v]!
      for (let k = skin.adjStart[v]!; k < skin.adjStart[v + 1]!; k++) {
        const u = skin.adj[k]!
        if (skin.outer[u] && !seen[u] && labels[u] === labels[i] && isLeft(skin, u) === left) { seen[u] = 1; stack.push(u) }
      }
    }
    const key = `${labels[i]}|${left ? 'L' : 'R'}`
    by.set(key, [...(by.get(key) ?? []), area * 1e4])
  }
  const out: Piece[] = []
  for (const [key, list] of by) {
    if (list.length < 2) continue
    const [l, side] = key.split('|') as [string, SideLR]
    const sorted = list.sort((a, b) => b - a)
    out.push({ region: regions[+l]!.key, side, pieces: list.length, smallerCm2: sorted.slice(1).map((x) => +x.toFixed(1)) })
  }
  return out.sort((a, b) => a.region.localeCompare(b.region) || a.side.localeCompare(b.side))
}

/**
 * 椒盐噪声指标：没有任何同标签邻点的孤立顶点数，以及被邻点多数否决的顶点比例。
 * Salt-and-pepper measures: vertices with no neighbour of their own label, and the share of
 * vertices outvoted by their neighbours.
 */
export function speckle(skin: Skin, labels: Uint8Array): { isolated: number; outvotedFraction: number } {
  let isolated = 0, outvoted = 0, n = 0
  for (let i = 0; i < skin.n; i++) {
    if (!skin.outer[i] || labels[i] === 255) continue
    let same = 0, total = 0
    for (let k = skin.adjStart[i]!; k < skin.adjStart[i + 1]!; k++) {
      const u = skin.adj[k]!
      if (!skin.outer[u] || isLeft(skin, u) !== isLeft(skin, i)) continue
      total++
      if (labels[u] === labels[i]) same++
    }
    if (!total) continue
    n++
    if (same === 0) isolated++
    if (same * 2 < total) outvoted++
  }
  return { isolated, outvotedFraction: +(outvoted / n).toFixed(4) }
}
