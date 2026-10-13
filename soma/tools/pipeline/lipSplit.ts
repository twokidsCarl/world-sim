// 把深层的“唇”部件沿它自己的口裂分成上唇和下唇两个部件。男女两个人体共用（男 FJ2814，女 W_FJ2814）。
//
// BodyParts3D 的 Lip（FMA59816）是一张连通的网格：上下唇的唇红连成一片薄壳（约 1 mm 厚，带许多小孔），跨过口裂，
// 所以张口时它没法跟着上下颌分开。这里找出它自己的口裂线，沿这条线切开并给切口加盖：
//   · 口裂线：把网格的前表面（每个 (x, y) 处最大的 z）按 x 分栏，每一栏里上下两个隆起之间最深的那道沟就是口裂；
//     口角处没有沟，取该栏的中点。对这些点做加权最小二乘，拟合一条二次曲线 y = a + b·x + c·x²。
//   · 切开：切面是这条曲线沿前后方向拉出的柱面。先把坐标变成 y′ = y − f(x)，柱面就成了平面 y′ = 0，
//     用 meshRepair.ts 的 cutByPlane 切开并加盖，再变回去。两半的盖是同一组三角形（绕向相反），严丝合缝。
//   · 源网格里另有十几粒两三个三角形的碎屑：不切，按质心归到上唇或下唇。
// FMA 里上唇是 FMA59817（Upper lip），下唇是 FMA59818（Lower lip），都是 FMA59816（Lip）的子类
// （查自管线所用的 FMA 表，见 zanatomy.ts 的 loadFmaNames）。
// 原来的部件 id 退役（它指的是整个唇，留给其中一半会让旧的引用悄悄变了意思），新 id 是 `<原 id>_upper` 和 `<原 id>_lower`。
//
// Splits the deep "Lip" part along its own oral fissure into an upper-lip and a lower-lip part. Shared by
// both bodies (male FJ2814, female W_FJ2814).
//
// Lip of BodyParts3D (FMA59816) is one connected mesh: the vermilion of both lips as one thin shell (about
// 1 mm thick, with many small holes) across the oral fissure, so it cannot part with the jaws when the
// mouth opens. Its own fissure line is found here, and the mesh is cut along it with the cuts capped:
//   · the fissure: the front surface of the mesh (the largest z at each (x, y)) is binned by x; in each
//     column the deepest groove between the upper and the lower bulge is the fissure; at the corners of the
//     mouth there is no groove and the middle of the column is taken. A quadratic y = a + b·x + c·x² is
//     fitted to these points by weighted least squares.
//   · the cut: the cutting surface is that curve extruded front to back. With y′ = y − f(x) it becomes the
//     plane y′ = 0; cutByPlane of meshRepair.ts cuts and caps there, and the result is mapped back. The two
//     caps are the same triangles with opposite winding, so the halves meet exactly.
//   · the source mesh also carries a dozen specks of two or three triangles: they are not cut and go to
//     the upper or the lower lip by their centroid.
// In the FMA the upper lip is FMA59817 (Upper lip) and the lower lip FMA59818 (Lower lip), both subclasses
// of FMA59816 (Lip) — looked up in the FMA table the pipeline uses (loadFmaNames in zanatomy.ts).
// The original part id is retired (it named the whole lip; giving it to one half would silently change
// what old references mean); the new ids are `<original id>_upper` and `<original id>_lower`.

import { measure, type Mesh } from './geometry.ts'
import { components, cutByPlane, mergeMeshes, topology } from './meshRepair.ts'
import { surfacePoints } from './register.ts'

/** 要切开的部件：名称正是 Lip，且不是皮肤系统的 / the part to split: named exactly Lip, and not of the integumentary system */
export const WHOLE_LIP_NAME = /^lip$/i

export const LIP_HALVES = {
  upper: { suffix: '_upper', fma: 'FMA59817', name: 'Upper lip', conceptName: 'upper lip' },
  lower: { suffix: '_lower', fma: 'FMA59818', name: 'Lower lip', conceptName: 'lower lip' },
} as const
/** 两半所属的上位概念（原部件的概念） / the parent concept of both halves (the concept of the original part) */
export const LIP_PARENT_FMA = 'FMA59816'

/** 由原部件 id 得到两半的 id / the ids of the two halves from the original part id */
export function lipPartIds(id: string): { upper: string; lower: string } {
  return { upper: id + LIP_HALVES.upper.suffix, lower: id + LIP_HALVES.lower.suffix }
}

/**
 * 把一组部件 id 里已经退役的唇 id 换成两半的 id（皮肤包的 manifest 等只读数据里还写着旧 id）。
 * Replaces a retired lip id in a list of part ids by the ids of its two halves (read-only data such as a
 * skin package manifest still name the old id).
 */
export function expandRetiredLipIds(ids: readonly string[], retired: ReadonlyMap<string, { upper: string; lower: string }>): string[] {
  return ids.flatMap((id) => {
    const h = retired.get(id)
    return h ? [h.upper, h.lower] : [id]
  })
}

export interface LipSplitOptions {
  /** 分栏的宽度（x）和前表面取样的格距（y），米 / column width (x) and the grid step of the front surface (y), metres */
  column: number
  step: number
  /** 沟深不到此值（米）的栏不算有口裂 / a column whose groove is shallower than this (m) has no fissure */
  minGroove: number
  /** 没有沟的栏只有在它的高度不到最高一栏的这一比例时才算口角 / a column without a groove counts as a corner of the mouth only when its height is under this share of the tallest column */
  cornerShare: number
  /** 口角点的权重（沟的权重是沟深，毫米） / weight of a corner point (a groove weighs its depth in mm) */
  cornerWeight: number
}

export const LIP_SPLIT_DEFAULTS: LipSplitOptions = { column: 0.002, step: 0.00025, minGroove: 0.0001, cornerShare: 0.4, cornerWeight: 0.3 }

export interface LipSplitReport {
  /** 口裂线 y = a + b·x + c·x²（米） / the fissure line y = a + b·x + c·x² (metres) */
  fissure: { a: number; b: number; c: number; columns: number; grooves: number; corners: number; grooveDepthMm: { median: number; max: number }; residualMm: { rms: number; max: number }; yAtMidlineM: number; yAtCornersM: [number, number]; xRangeM: [number, number] }
  source: { triangles: number; components: number; watertight: boolean; volumeMl: number; areaCm2: number }
  cut: { loops: number; holes: number; capTriangles: number; capAreaCm2: number }
  specks: { upper: number; lower: number; triangles: number }
  upper: { triangles: number; watertight: boolean; boundaryEdges: number; volumeMl: number; areaCm2: number; bbox: number[] }
  lower: { triangles: number; watertight: boolean; boundaryEdges: number; volumeMl: number; areaCm2: number; bbox: number[] }
  /** 两半体积之和与原体积之差（毫升）：盖是成对的，应接近 0 / sum of the two volumes minus the original (ml): the caps come in pairs, so it should be near 0 */
  volumeDifferenceMl: number
}

/** 找口裂线：返回二次曲线的系数和拟合情况；找不到（没有一栏有沟）返回 null / finds the fissure line: the quadratic's coefficients and how it fits; null when no column has a groove */
export function lipFissure(mesh: Mesh, opts: LipSplitOptions = LIP_SPLIT_DEFAULTS): LipSplitReport['fissure'] | null {
  const b = measure(mesh).bbox
  const nx = Math.max(1, Math.ceil((b[3] - b[0]) / opts.column))
  const ny = Math.max(1, Math.ceil((b[4] - b[1]) / opts.step) + 1)
  const front = new Float64Array(nx * ny).fill(-Infinity)
  const pts = surfacePoints(mesh, opts.step * 0.6)
  for (let i = 0; i < pts.length; i += 3) {
    const cx = Math.min(nx - 1, Math.max(0, Math.floor((pts[i]! - b[0]) / opts.column)))
    const cy = Math.min(ny - 1, Math.max(0, Math.floor((pts[i + 1]! - b[1]) / opts.step)))
    if (pts[i + 2]! > front[cx * ny + cy]!) front[cx * ny + cy] = pts[i + 2]!
  }
  interface Col { x: number; lo: number; hi: number; groove: number; depth: number }
  const cols: Col[] = []
  for (let cx = 0; cx < nx; cx++) {
    let lo = 0
    let hi = ny - 1
    while (lo < ny && front[cx * ny + lo] === -Infinity) lo++
    while (hi >= 0 && front[cx * ny + hi] === -Infinity) hi--
    if (hi - lo < 4) continue
    // 补上空格，5 点平均 / fill the empty cells, 5-tap mean
    const f = new Float64Array(ny)
    for (let k = lo; k <= hi; k++) f[k] = front[cx * ny + k] === -Infinity ? f[k - 1]! : front[cx * ny + k]!
    const s = Float64Array.from(f)
    for (let k = lo + 2; k <= hi - 2; k++) s[k] = (f[k - 2]! + f[k - 1]! + f[k]! + f[k + 1]! + f[k + 2]!) / 5
    // 沟：使 min(下方的最高处, 上方的最高处) − 本处 最大的位置 / the groove: where min(highest below, highest above) − here is largest
    const below = new Float64Array(ny).fill(-Infinity)
    const above = new Float64Array(ny).fill(-Infinity)
    for (let k = lo + 1; k <= hi; k++) below[k] = Math.max(below[k - 1]!, s[k - 1]!)
    for (let k = hi - 1; k >= lo; k--) above[k] = Math.max(above[k + 1]!, s[k + 1]!)
    let groove = -1
    let depth = 0
    for (let k = lo + 2; k <= hi - 2; k++) {
      const d = Math.min(below[k]!, above[k]!) - s[k]!
      if (d > depth) {
        depth = d
        groove = k
      }
    }
    cols.push({ x: b[0] + (cx + 0.5) * opts.column, lo, hi, groove, depth })
  }
  if (!cols.length) return null
  const tallest = cols.reduce((a, c) => Math.max(a, c.hi - c.lo), 0)
  const samples: { x: number; y: number; w: number }[] = []
  const depths: number[] = []
  let corners = 0
  for (const c of cols) {
    if (c.groove >= 0 && c.depth >= opts.minGroove) {
      samples.push({ x: c.x, y: b[1] + (c.groove + 0.5) * opts.step, w: c.depth * 1000 })
      depths.push(c.depth * 1000)
    } else if (c.hi - c.lo < opts.cornerShare * tallest) {
      samples.push({ x: c.x, y: b[1] + ((c.lo + c.hi + 1) / 2) * opts.step, w: opts.cornerWeight })
      corners++
    }
  }
  if (!depths.length) return null
  // 加权最小二乘 y = a + b·x + c·x²（x 以毫米计、以包围盒中点为原点，免得法方程病态）
  // weighted least squares y = a + b·x + c·x² (x in millimetres about the middle of the box, to keep the normal equations well conditioned)
  const x0 = (b[0] + b[3]) / 2
  const m = [0, 0, 0, 0, 0]
  const r = [0, 0, 0]
  for (const q of samples) {
    const x = (q.x - x0) * 1000
    const xp = [1, x, x * x, x * x * x, x * x * x * x]
    for (let k = 0; k < 5; k++) m[k] = m[k]! + q.w * xp[k]!
    for (let k = 0; k < 3; k++) r[k] = r[k]! + q.w * xp[k]! * q.y
  }
  const A = [[m[0]!, m[1]!, m[2]!], [m[1]!, m[2]!, m[3]!], [m[2]!, m[3]!, m[4]!]]
  const det3 = (M: number[][]) => M[0]![0]! * (M[1]![1]! * M[2]![2]! - M[1]![2]! * M[2]![1]!) - M[0]![1]! * (M[1]![0]! * M[2]![2]! - M[1]![2]! * M[2]![0]!) + M[0]![2]! * (M[1]![0]! * M[2]![1]! - M[1]![1]! * M[2]![0]!)
  const D = det3(A)
  let coef: [number, number, number]
  if (samples.length >= 3 && Math.abs(D) > 1e-9) {
    const col = (k: number) => A.map((row, i) => row.map((v, j) => (j === k ? r[i]! : v)))
    coef = [det3(col(0)) / D, det3(col(1)) / D, det3(col(2)) / D]
  } else coef = [r[0]! / m[0]!, 0, 0]
  // 换回以米计、以身体坐标为原点的系数 / back to coefficients in metres about the body origin
  const c2 = coef[2] * 1e6
  const c1 = coef[1] * 1e3 - 2 * c2 * x0
  const c0 = coef[0] - coef[1] * 1e3 * x0 + c2 * x0 * x0
  const f = (x: number) => c0 + c1 * x + c2 * x * x
  let ss = 0
  let sw = 0
  let worst = 0
  for (const q of samples) {
    const e = Math.abs(q.y - f(q.x))
    ss += q.w * e * e
    sw += q.w
    if (e > worst) worst = e
  }
  depths.sort((p, q) => p - q)
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  return {
    a: c0, b: c1, c: c2, columns: cols.length, grooves: depths.length, corners,
    grooveDepthMm: { median: r3(depths[depths.length >> 1]!), max: r3(depths[depths.length - 1]!) },
    residualMm: { rms: r3(Math.sqrt(ss / sw) * 1000), max: r3(worst * 1000) },
    yAtMidlineM: Math.round(f(x0) * 1e5) / 1e5, yAtCornersM: [Math.round(f(b[0]) * 1e5) / 1e5, Math.round(f(b[3]) * 1e5) / 1e5], xRangeM: [Math.round(b[0] * 1e5) / 1e5, Math.round(b[3] * 1e5) / 1e5],
  }
}

/**
 * 切开。输入须已焊接；主连通片须封闭。失败（找不到口裂，或某一半是空的）时返回 null，调用方保留原部件。
 * The split. The input must be welded and its main component closed. Null on failure (no fissure found, or
 * one half empty); the caller then keeps the original part.
 */
export function splitLip(input: Mesh, opts: LipSplitOptions = LIP_SPLIT_DEFAULTS): { upper: Mesh; lower: Mesh; report: LipSplitReport } | null {
  const fissure = lipFissure(input, opts)
  if (!fissure) return null
  const f = (x: number) => fissure.a + fissure.b * x + fissure.c * x * x
  const comps = components(input).map((m) => ({ m, tris: m.indices.length / 3 })).sort((p, q) => q.tris - p.tris)
  const main = comps[0]!.m
  // y′ = y − f(x)：口裂的柱面变成平面 y′ = 0 / y′ = y − f(x): the fissure's cylinder becomes the plane y′ = 0
  const shear = (m: Mesh, sign: number): Mesh => {
    const p = Float32Array.from(m.positions)
    for (let i = 0; i < p.length; i += 3) p[i + 1] = p[i + 1]! + sign * f(p[i]!)
    return { positions: p, indices: m.indices }
  }
  const cut = cutByPlane(shear(main, -1), [0, 1, 0], 0)
  if (!cut.positive.indices.length || !cut.negative.indices.length) return null
  const halves: [Mesh[], Mesh[]] = [[shear(cut.positive, 1)], [shear(cut.negative, 1)]]
  const speck = [0, 0]
  let speckTriangles = 0
  for (const c of comps.slice(1)) {
    const ct = measure(c.m).centroid
    const side = ct[1] - f(ct[0]) > 0 ? 0 : 1
    halves[side]!.push(c.m)
    speck[side]!++
    speckTriangles += c.tris
  }
  const finish = (list: Mesh[]): Mesh => {
    // 不再焊接：切口上的点不能按位置合并 / no welding here: points on the cut must not be merged by position
    return list.length === 1 ? list[0]! : mergeMeshes(list)
  }
  const upper = finish(halves[0])
  const lower = finish(halves[1])
  const src = measure(input)
  const r2 = (v: number) => Math.round(v * 100) / 100
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4
  const row = (m: Mesh) => {
    const st = measure(m)
    const tp = topology(m)
    return { triangles: m.indices.length / 3, watertight: tp.watertight, boundaryEdges: tp.boundaryEdges, volumeMl: r4(st.signedVolume * 1e6), areaCm2: r2(st.area * 1e4), bbox: st.bbox.map((v) => Math.round(v * 1e5) / 1e5) }
  }
  const u = row(upper)
  const l = row(lower)
  const capTriangles = (cut.positive.indices.length + cut.negative.indices.length) / 3 - main.indices.length / 3
  // 盖的面积：两半的面积之和减去原主片的面积（切开本身不改变面积），除以 2 / cap area: the two halves' area minus the main component's (cutting itself changes no area), halved
  const capArea = (measure(cut.positive).area + measure(cut.negative).area - measure(shear(main, -1)).area) / 2
  return {
    upper, lower,
    report: {
      fissure,
      source: { triangles: input.indices.length / 3, components: comps.length, watertight: topology(input).watertight, volumeMl: r4(src.signedVolume * 1e6), areaCm2: r2(src.area * 1e4) },
      cut: { loops: cut.loops, holes: cut.holes, capTriangles, capAreaCm2: r2(capArea * 1e4) },
      specks: { upper: speck[0]!, lower: speck[1]!, triangles: speckTriangles },
      upper: u, lower: l,
      volumeDifferenceMl: r4(u.volumeMl + l.volumeMl - src.signedVolume * 1e6),
    },
  }
}
