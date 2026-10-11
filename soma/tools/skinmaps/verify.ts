// 皮肤分区图的数值检验：面积与左右对称、关键感觉点、经典检查点、两图一致性、连通性。
// Numeric checks of the skin maps: areas and left/right symmetry, key sensory points, classic
// checkpoints, agreement between the two maps, contiguity.

import type { MapDef, RegionDef } from './build.ts'
import type { Landmarks, SideLR, SkinExpr } from './landmarks.ts'
import type { Skin } from './mesh.ts'

export interface Text { zh: string; en: string }

export interface CheckDef {
  name: Text
  /**
   * 皮肤上的一点；或 { over: 部件名 }：该部件正前方的皮肤，取其中面积最大的分区
   * （单个顶点恰好落在分界线上时，换一套网格就会翻转）。
   * A point on the skin; or { over: part name }: the skin in front of that part, taking the
   * region with the largest share of it (a single vertex sitting on a boundary flips whenever
   * the mesh changes).
   */
  at: SkinExpr | { over: string }
  /** 可接受的分区 key（任一即可）/ Region keys that are acceptable (any one). */
  expect: string[]
  source: string
}

export interface AreaRow {
  key: string
  L: number
  R: number
  ratio: number | null
  /**
   * 镜像一致率：把该区每个顶点按正中面镜像到对侧，对侧最近的皮肤（15 mm 以内）标签相同的面积占比。
   * 衡量的是“图”是否左右对称，不受两侧皮肤网格面积本身不等的影响。
   * Mirror agreement: share of the region's area whose mirror image across the median plane lands
   * (within 15 mm) on skin with the same label. It measures the symmetry of the map itself and is
   * not affected by the two sides of the skin mesh having unequal area.
   */
  mirror: number | null
  /** 左右面积比超出 0.8–1.25，且镜像一致率低于 0.8 / L/R area ratio outside 0.8–1.25 and mirror agreement below 0.8. */
  flagged: boolean
}

const isLeft = (skin: Skin, v: number) => skin.left[v] === 1

/** 外壁顶点中未分配的比例 / Fraction of outer-wall vertices left unassigned (255). */
export function unassigned(skin: Skin, labels: Uint8Array): { count: number; fraction: number; innerCount: number } {
  let c = 0, n = 0, inner = 0
  for (let i = 0; i < skin.n; i++) {
    if (skin.outer[i]) { n++; if (labels[i] === 255) c++ } else if (labels[i] === 255) inner++
  }
  return { count: c, fraction: c / n, innerCount: inner }
}

/**
 * 各区每侧面积（cm²，仅外壁、不含被盖住的皮肤）、左右比和镜像一致率。
 * Area per region and side (cm², outer wall only, covered skin excluded), the L/R ratio and the mirror agreement.
 */
export function areas(skin: Skin, labels: Uint8Array, regions: RegionDef[]): AreaRow[] {
  const L = new Float64Array(regions.length), R = new Float64Array(regions.length)
  const same = new Float64Array(regions.length), seen = new Float64Array(regions.length)
  const cell = 0.015
  const grid = new Map<string, number[]>()
  const keyOf = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
  const use = (i: number) => skin.outer[i] === 1 && labels[i] !== 255 && !skin.covered[i]
  for (let i = 0; i < skin.n; i++) {
    if (!use(i)) continue
    const k = keyOf(skin.positions[i * 3]!, skin.positions[i * 3 + 1]!, skin.positions[i * 3 + 2]!)
    const l = grid.get(k)
    if (l) l.push(i)
    else grid.set(k, [i])
  }
  for (let i = 0; i < skin.n; i++) {
    if (!use(i)) continue
    const a = skin.area[i]! * 1e4
    ;(isLeft(skin, i) ? L : R)[labels[i]!]! += a
    const x = 2 * skin.midX - skin.positions[i * 3]!, y = skin.positions[i * 3 + 1]!, z = skin.positions[i * 3 + 2]!
    let best = -1, bd = cell
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const u of grid.get(keyOf(x + dx * cell, y + dy * cell, z + dz * cell)) ?? []) {
            const d = Math.hypot(skin.positions[u * 3]! - x, skin.positions[u * 3 + 1]! - y, skin.positions[u * 3 + 2]! - z)
            if (d < bd) { bd = d; best = u }
          }
    if (best < 0) continue
    seen[labels[i]!]! += a
    if (labels[best] === labels[i]) same[labels[i]!]! += a
  }
  return regions.map((r, k) => {
    const ratio = R[k]! > 0 ? L[k]! / R[k]! : null
    const mirror = seen[k]! > 0 ? +(same[k]! / seen[k]!).toFixed(3) : null
    const off = ratio === null || ratio < 0.8 || ratio > 1.25
    return { key: r.key, L: +L[k]!.toFixed(1), R: +R[k]!.toFixed(1), ratio: ratio === null ? null : +ratio.toFixed(3), mirror, flagged: off && (mirror === null || mirror < 0.8) }
  })
}

export interface PointResult { name: string; side: SideLR; got: string; expect: string[]; ok: boolean; source?: string; shares?: Record<string, number> }

/**
 * 某部件正前方（其包围盒在冠状面上的投影内、本侧一半）皮肤的分区面积构成。
 * Area shares of the regions on the skin in front of a part (inside the frontal projection of its bounding box, this side's half).
 */
export function regionsOver(lm: Landmarks, labels: Uint8Array, regions: RegionDef[], partName: string, side: SideLR): Record<string, number> {
  const skin = lm.skin
  const part = lm.body.byId.get(lm.partId(partName, side))!
  const [x0, y0, z0, x1, y1] = part.bbox
  const area = new Map<string, number>()
  let total = 0
  for (let i = 0; i < skin.n; i++) {
    if (!skin.outer[i] || labels[i] === 255 || isLeft(skin, i) !== (side === 'L')) continue
    const x = skin.positions[i * 3]!, y = skin.positions[i * 3 + 1]!, z = skin.positions[i * 3 + 2]!
    // 左右各放宽 5 mm，窄小的部件前方也能取到皮肤顶点 / 5 mm of slack sideways so that a narrow part still has skin vertices in front of it.
    if (x < x0 - 0.005 || x > x1 + 0.005 || y < y0 || y > y1 || z < z0 || skin.normals[i * 3 + 2]! <= 0) continue
    const k = regions[labels[i]!]!.key
    area.set(k, (area.get(k) ?? 0) + skin.area[i]!)
    total += skin.area[i]!
  }
  return Object.fromEntries([...area].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => [k, +(v / total).toFixed(3)]))
}

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
      if (typeof c.at === 'object' && 'over' in c.at) {
        const shares = regionsOver(lm, labels, def.regions, c.at.over, side)
        const got = Object.keys(shares)[0] ?? '(no skin)'
        out.push({ name: c.name.en, side, got, expect: c.expect, ok: c.expect.includes(got), source: c.source, shares })
        continue
      }
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

/**
 * 每区每侧的块数；只列出多于一块者。两块之间只要有顶点相距不到 2.5 mm 就算相连：有的皮肤网格在手指等处
 * 叠着两层几乎重合、只在别处相连的皮肤，看上去是一片，按网格连通却是两块。
 * Pieces per region and side; only regions in more than one piece are listed. Two pieces count as
 * joined when any of their vertices lie within 2.5 mm of each other: some skin meshes carry two
 * nearly coincident sheets (on the fingers, for instance) joined only elsewhere, which look like one
 * patch but are two by mesh connectivity.
 */
export function pieces(skin: Skin, labels: Uint8Array, regions: RegionDef[]): Piece[] {
  const comp = new Int32Array(skin.n).fill(-1)
  const areaOf: number[] = [], keyOfComp: string[] = []
  for (let i = 0; i < skin.n; i++) {
    if (!skin.outer[i] || comp[i]! >= 0 || labels[i] === 255) continue
    const left = isLeft(skin, i)
    const id = areaOf.length
    const stack = [i]
    comp[i] = id
    let area = 0
    while (stack.length) {
      const v = stack.pop()!
      area += skin.area[v]!
      for (let k = skin.adjStart[v]!; k < skin.adjStart[v + 1]!; k++) {
        const u = skin.adj[k]!
        if (skin.outer[u] && comp[u]! < 0 && labels[u] === labels[i] && isLeft(skin, u) === left) { comp[u] = id; stack.push(u) }
      }
    }
    areaOf.push(area * 1e4)
    keyOfComp.push(`${labels[i]}|${left ? 'L' : 'R'}`)
  }
  const parent = areaOf.map((_, k) => k)
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]! } return x }
  const cell = 0.0025
  const grid = new Map<string, number[]>()
  const cellKey = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
  for (let i = 0; i < skin.n; i++) {
    if (comp[i]! < 0) continue
    const k = cellKey(skin.positions[i * 3]!, skin.positions[i * 3 + 1]!, skin.positions[i * 3 + 2]!)
    const l = grid.get(k)
    if (l) l.push(i)
    else grid.set(k, [i])
  }
  for (let i = 0; i < skin.n; i++) {
    if (comp[i]! < 0) continue
    const x = skin.positions[i * 3]!, y = skin.positions[i * 3 + 1]!, z = skin.positions[i * 3 + 2]!
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const u of grid.get(cellKey(x + dx * cell, y + dy * cell, z + dz * cell)) ?? []) {
            if (comp[u] === comp[i] || keyOfComp[comp[u]!] !== keyOfComp[comp[i]!]) continue
            if (Math.hypot(skin.positions[u * 3]! - x, skin.positions[u * 3 + 1]! - y, skin.positions[u * 3 + 2]! - z) < cell) parent[find(comp[u]!)] = find(comp[i]!)
          }
  }
  const merged = new Map<number, number>()
  areaOf.forEach((a, k) => merged.set(find(k), (merged.get(find(k)) ?? 0) + a))
  const by = new Map<string, number[]>()
  for (const [root, a] of merged) by.set(keyOfComp[root]!, [...(by.get(keyOfComp[root]!) ?? []), a])
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
