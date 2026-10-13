// 腔的装配：读一副人体（只读），把消化道各段接成一条从口到肛门的管，并给泌尿、生殖器官的主要腔；
// 结果只写到命令行给的输出目录，不写 public/。纯函数在 lumen.ts。
// 构造出来的几何一律标明：桥接段（两段器官之间）、引导段（口腔、咽、肛管末段：这副人体里没有它们的壁）、
// 以及穿过器官两端封盖的那几站（封盖是分割的产物，不是解剖）。
//
// Assembly of the lumina: reads one body (read-only), joins the segments of the alimentary canal into
// one tube from mouth to anus and adds the main cavities of the urinary and genital organs. Results
// go only to the output directory given on the command line, never to public/. Pure functions are in
// lumen.ts. Constructed geometry is always labelled: bridges (between two organ pieces), guided
// stretches (oral cavity, pharynx, the last part of the anal canal: this body has no wall for them)
// and the stations that pass through the end caps of an organ (the caps come from segmentation and
// are not anatomy).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AnatomyData, Part, PartPiece } from '../../src/anatomy/types.ts'
import { readGlbParts, type RawMesh } from '../skinmaps/io.ts'
import { render, sheet, type RenderItem, type Rgb, type View } from '../rig/render.ts'
import { computeNormals, type Mesh } from './geometry.ts'
import { writeSystemGlb } from './glb.ts'
import { signedVolume, topology } from './meshRepair.ts'
import { SolidTester } from './nerveCourse.ts'
import { loadFmaNames } from './zanatomy.ts'
import { headGuides } from './lumenHead.ts'
import {
  arcBridge, arcLengths, relaxKinks, teardropBridge, axisCount, axisEnds, axisLength, axisPoint, capRings, curvatureRadius, distanceToMesh, limitByPlanes, offsetInward, orderChain, orientChain,
  rayNearest, resamplePolyline, reverseAxis, ringCalibre, ringPlaneCrossings, ringsToMesh, ringVolume, sampleRings, selfIntersections, separateRings, shellAxis, sphincterNarrowing, transportFrames, vec, type Axis, type V3,
} from './lumen.ts'

const ROOT = join(import.meta.dirname, '../..')
/** 女性标本里合在一起的子宫与阴道腔：分成三片后这个 id 退役 / the specimen's combined uterine and vaginal lumen: retired once it is split in three */
export const UTEROVAGINAL_ID = 'WU_uterine_and_vaginal_lumen'
export const UTEROVAGINAL_PIECES = ['WU_uterine_cavity', 'WU_cervical_canal', 'WU_vaginal_lumen'] as const
/** 每圈的方向数 / directions per ring */
export const SIDES = 16
/** 中心线取样间距（米） / centreline sampling step (metres) */
export const STEP = 0.003

// ── 壁厚口径表 / the wall and calibre table ──────────────────────────────────────────────────────────

interface Quantity { value: number | null; source: string | null; assumption?: boolean }
interface WallsFile {
  segments: Record<string, { wall: Quantity; calibre: { collapsed: Quantity; distended: Quantity }; rest: { state: string; filling?: number; source?: string | null; assumption?: boolean } }>
  sphincters: Record<string, { length: Quantity; closedRatio: Quantity }>
}
export interface SegmentTable { wall: number; collapsed: number; distended: number; wallAssumed: boolean; calibreAssumed: boolean; rest: string }

export function loadWalls(path = join(ROOT, 'data/curated/lumen/walls.json')): WallsFile {
  return JSON.parse(readFileSync(path, 'utf8')) as WallsFile
}
export function segmentTable(walls: WallsFile, key: string): SegmentTable {
  const s = walls.segments[key]
  if (!s) throw new Error(`walls.json has no segment ${key}`)
  return {
    wall: (s.wall.value ?? 0) / 1000,
    collapsed: (s.calibre.collapsed.value ?? 0) / 1000,
    distended: (s.calibre.distended.value ?? 0) / 1000,
    wallAssumed: !!s.wall.assumption,
    calibreAssumed: !!s.calibre.collapsed.assumption || !!s.calibre.distended.assumption,
    rest: s.rest.state,
  }
}

export interface RestFilling { filling: number; state: string; assumption: boolean; source: string | null }
/** 表里一段的静止充盈度（0 塌陷 … 1 充盈到壁所允许的最大） / the resting filling of a segment in the table (0 collapsed … 1 as full as the wall allows) */
export function restFilling(walls: WallsFile, key: string): RestFilling {
  const r = walls.segments[key]!.rest
  return { filling: r.filling ?? (r.state === 'open' ? 1 : 0), state: r.state, assumption: !!r.assumption, source: r.source ?? null }
}

// ── 这副人体里的管道 / the canal of this body ────────────────────────────────────────────────────────

interface Group {
  key: string
  /** walls.json 里的段 / segment key in walls.json */
  seg: string
  lumenId: string
  name: string
  /** FMA 概念号（查自管线所用的 FMA 表） / FMA concept id (looked up in the FMA table the pipeline uses) */
  fma: string
  /** 'derive'：由壁推出；'real'：标本自己的腔，原样使用；'guide'：没有壁，按标志构造 / 'derive': from the wall; 'real': the specimen's own lumen used as it is; 'guide': no wall, constructed from landmarks */
  mode: 'derive' | 'real' | 'guide'
  /** 侧面进入的囊（胃：食管从贲门进；升结肠：回肠从回盲口进，盲肠是盲端） / a sac entered from the side (stomach via the cardia; ascending colon via the ileocaecal orifice, the caecum being the blind end) */
  sac?: boolean
  parts: string[]
}

/** 空肠、回肠各片的次序：编号按字符串排序后依次得到部件号（见报告里的核对）。 / Order of the jejunal and ileal pieces: part ids follow the string-sorted order of a running number (checked in the report). */
export function numberedOrder(idsAscending: string[]): string[] {
  const n = idsAscending.length
  const labels = Array.from({ length: n }, (_, i) => String(i + 1)).sort()
  return Array.from({ length: n }, (_, i) => idsAscending[labels.indexOf(String(i + 1))]!)
}

function canalGroups(body: 'male' | 'female', data: { parts: Part[] }): Group[] {
  const p = body === 'female' ? 'W_' : ''
  const byName = (rx: RegExp): string[] => data.parts.filter((q) => rx.test(q.name) && q.system === 'digestive').map((q) => q.id).sort()
  const jej = numberedOrder(byName(/part of jejunum$/i))
  const ile = numberedOrder(byName(/part of ileum$/i))
  const g: Group[] = [
    { key: 'oral', seg: 'oral_cavity', lumenId: 'LUMEN_oral_cavity', name: 'Oral cavity proper', fma: 'FMA49182', mode: 'guide', parts: [] },
    { key: 'pharynx', seg: 'pharynx', lumenId: 'LUMEN_pharynx', name: 'Cavity of pharynx', fma: 'FMA54935', mode: 'guide', parts: [] },
    { key: 'oesophagus', seg: 'oesophagus', lumenId: 'LUMEN_esophagus', name: 'Lumen of esophagus', fma: 'FMA9398', mode: 'derive', parts: [p + 'FJ2563'] },
    { key: 'stomach', seg: 'stomach', lumenId: 'LUMEN_stomach', name: 'Cavity of stomach', fma: 'FMA14585', mode: 'derive', sac: true, parts: [p + 'FJ2564'] },
    { key: 'duodenum', seg: 'duodenum', lumenId: 'LUMEN_duodenum', name: 'Lumen of duodenum', fma: 'FMA14589', mode: 'derive', parts: [p + 'FJ2573'] },
    { key: 'jejunum', seg: 'jejunum', lumenId: 'LUMEN_jejunum', name: 'Lumen of jejunum', fma: 'FMA14590', mode: 'derive', parts: jej },
    { key: 'ileum', seg: 'ileum', lumenId: 'LUMEN_ileum', name: 'Lumen of ileum', fma: 'FMA14591', mode: 'derive', parts: [...ile, p + 'FJ2599'] },
    { key: 'ascending', seg: 'ascending_colon', lumenId: 'LUMEN_ascending_colon', name: 'Lumen of ascending colon', fma: 'FMA14593', mode: 'derive', sac: true, parts: [p + 'FJ2566'] },
    { key: 'transverse', seg: 'transverse_colon', lumenId: 'LUMEN_transverse_colon', name: 'Lumen of transverse colon', fma: 'FMA14594', mode: 'derive', parts: [p + 'FJ2572'] },
    { key: 'descending', seg: 'descending_colon', lumenId: 'LUMEN_descending_colon', name: 'Lumen of descending colon', fma: 'FMA14595', mode: 'derive', parts: [p + 'FJ2567'] },
    body === 'male'
      ? { key: 'rectum', seg: 'rectum', lumenId: 'LUMEN_rectum', name: 'Lumen of rectum', fma: 'FMA14598', mode: 'derive', parts: ['FJ2571'] }
      : { key: 'rectum', seg: 'rectum', lumenId: 'WU_rectal_lumen', name: 'Lumen of rectum', fma: 'FMA14598', mode: 'real', parts: ['WU_rectal_lumen'] },
    { key: 'anal', seg: 'anal_canal', lumenId: 'LUMEN_anal_canal', name: 'Lumen of anal canal', fma: 'FMA17357', mode: 'guide', parts: [] },
  ]
  return g
}

// ── 小工具 / small helpers ───────────────────────────────────────────────────────────────────────────

const P3 = (a: ArrayLike<number>, i: number): V3 => [a[3 * i]!, a[3 * i + 1]!, a[3 * i + 2]!]
const mm = (x: number): number => Math.round(x * 1e4) / 10
const mm3 = (v: ArrayLike<number>): number[] => [mm(v[0]!), mm(v[1]!), mm(v[2]!)]
const median = (a: number[]): number => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1]! : NaN)

function meshHash(m: Mesh): string {
  let h = 2166136261
  const b = new Uint8Array(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength)
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 16777619)
  return (h >>> 0).toString(16)
}

// ── 装配 / assembly ──────────────────────────────────────────────────────────────────────────────────

/** 站的来历 / where a station comes from */
export const KIND = { derived: 0, real: 1, guide: 2, bridge: 3, cap: 4 } as const
const KIND_NAME = ['derived', 'real', 'guide', 'bridge', 'cap'] as const

interface Stretch {
  /** 第几条行程 / which run */
  run: number
  group: number
  kind: 'wall' | 'real' | 'guide' | 'bridge'
  part?: string
  pts: Float64Array
  /** 桥接段保持上游半径（下游是侧面进入的囊或真实的腔） / bridge keeps the upstream radius (downstream is a side-entered sac or a real lumen) */
  hold?: boolean
  /** 引导段的缺省半径 / default radius of a guided stretch */
  radius?: number
  /** 桥两头的壁部件 / the wall parts at the two ends of a bridge */
  between?: (string | undefined)[]
  /** 这座桥通向的囊或真实的腔：到它的腔面外侧为止 / the sac or real lumen this bridge leads into: it ends outside that lumen surface */
  into?: string
  /** 起点要退到这个真实的腔之外 / the start is pulled back to outside this real lumen */
  avoid?: string
  /** 发夹处的水滴形环 / a teardrop loop at a hairpin */
  loop?: boolean
  /** 这一段从囊的盲端开始，起点加盖 / the stretch starts at the blind end of a sac and is closed there */
  blind?: boolean
  /** 引导段以这些真实部件为界；射线在 maxR 之内没打到的方向算构造 / a guided stretch bounded by these real parts; directions whose ray meets none within maxR are construction */
  bounds?: { id: string; mesh: Mesh; solid: SolidTester }[]
  maxR?: number
}

export interface LumenPartOut {
  id: string
  name: string
  fma: string
  group: string
  mesh: Mesh
  /** 每个顶点的中心线点（充盈用） / the centreline point of every vertex (for filling) */
  centres: Float32Array
  composition: PartPiece[]
  volumeCm3: number
  provenance: 'curated'
  walls: string[]
  filling: { rest: number; displacement: Float32Array }
  /** 每个顶点是否是构造的（渲染用） / per vertex: constructed or not (for rendering) */
  constructed: Uint8Array
  /** 每个顶点的来历：0 由壁推出，1 构造，2 以真实部件为界，3 标本自己的腔面 / origin of every vertex: 0 derived from a wall, 1 construction, 2 bounded by real parts, 3 the specimen's own lumen surface */
  origin: Uint8Array
  system: 'digestive' | 'urinary' | 'reproductive'
  restState: RestFilling
}

export interface BuildResult {
  report: Record<string, unknown>
  parts: LumenPartOut[]
  /** 渲染用：壁、真实的腔 / for rendering: walls and real lumina */
  context: { id: string; mesh: Mesh; role: 'wall' | 'real' | 'bound' }[]
  path: { centre: Float64Array; kind: Uint8Array; radius: Float64Array; dir?: Float64Array; inner?: Float64Array; part?: (string | undefined)[]; group?: number[] }
}

/** 内存里的一副人体：构建的某一步调用时用（不读 public/） / a body held in memory, for a call from inside a build (public/ is not read) */
export interface LumenInput {
  parts: Part[]
  mesh: (id: string) => Mesh | undefined
  /** 部件没有写 source 时的来源名 / the source name of a part that states none */
  defaultSource?: string
}

export async function buildLumen(body: 'male' | 'female', anatomyDir = join(ROOT, 'public/anatomy', body), input?: LumenInput): Promise<BuildResult> {
  const data: Pick<AnatomyData, 'parts' | 'sources'> = input ? { parts: input.parts, sources: [{ name: input.defaultSource ?? '', url: '', license: '', attribution: '' }] } : (JSON.parse(readFileSync(join(anatomyDir, 'anatomy.json'), 'utf8')) as AnatomyData)
  const partById = new Map<string, Part>(data.parts.map((q) => [q.id, q]))
  const glb = new Map<string, Map<string, RawMesh>>()
  const meshOf = async (id: string): Promise<Mesh> => {
    const part = partById.get(id)
    if (!part) throw new Error(`${body}: no part ${id}`)
    if (input) {
      const m = input.mesh(id)
      if (!m) throw new Error(`${body}: no mesh for ${id}`)
      return m
    }
    if (!glb.has(part.system)) glb.set(part.system, await readGlbParts(join(anatomyDir, `${part.system}.glb`)))
    const m = glb.get(part.system)!.get(id)
    if (!m) throw new Error(`${body}: ${id} is not in ${part.system}.glb`)
    return m
  }
  const findPart = (rx: RegExp, system?: string): Part | undefined => data.parts.find((q) => rx.test(q.name) && (!system || q.system === system))
  const walls = loadWalls()
  const groups = canalGroups(body, data)
  const fmaNames = loadFmaNames()
  const report: Record<string, unknown> = { body }
  const hashesBefore = new Map<string, string>()

  // 1. 各段的中心线 / the centreline of every piece
  interface Item { group: number; part: string; mesh: Mesh; axis: Axis; inventory: Record<string, unknown>; inventoryBox: number[] }
  const items: Item[] = []
  for (let gi = 0; gi < groups.length; gi++) for (const id of groups[gi]!.parts) {
    const mesh = await meshOf(id)
    hashesBefore.set(id, meshHash(mesh))
    const axis = shellAxis(mesh, { step: 0.004, smooth: 6 })
    const part = partById.get(id)!
    const r = Array.from(axis.radius).slice(1, -1)
    const mid = r.slice(Math.floor(r.length * 0.15), Math.max(Math.floor(r.length * 0.15) + 1, Math.ceil(r.length * 0.85)))
    const topo = topology(mesh)
    items.push({
      group: gi, part: id, mesh, axis, inventoryBox: part.bbox,
      inventory: {
        id, name: part.name, fma: part.fma, provenance: part.provenance, source: part.source ?? data.sources[0]?.name, triangles: topo.triangles, closed: topo.watertight,
        volumeCm3: Math.round(signedVolume(mesh) * 1e7) / 10, centrelineMm: mm(axisLength(axis)),
        outerDiameterMm: { mean: mm((2 * mid.reduce((s, x) => s + x, 0)) / mid.length), min: mm(2 * Math.min(...mid)), max: mm(2 * Math.max(...mid)) },
      },
    })
  }
  // 方向：整条链上动态规划 / directions: dynamic programming over the whole chain
  const links = orientChain(items.map((it) => ({ id: it.part, ends: axisEnds(it.axis) })))
  for (let i = 0; i < items.length; i++) {
    if (links[i]!.reversed) items[i]!.axis = reverseAxis(items[i]!.axis)
    const [a, b] = axisEnds(items[i]!.axis)
    Object.assign(items[i]!.inventory, { endInMm: mm3(a), endOutMm: mm3(b) })
  }

  // 小肠次序的核对：相邻两片是否相贴、名称是否单调、只按端点距离排会怎样
  // checks on the order of the small-intestine pieces: do consecutive pieces touch, are the names monotone, and what does ordering by end distance alone give
  {
    const si = items.filter((it) => ['jejunum', 'ileum'].includes(groups[it.group]!.key))
    const cls = (n: string): number => ['Proximal part of jejunum', 'Middle part of jejunum', 'Distal part of jejunum', 'Proximal part of ileum', 'Middle part of ileum', 'Distal part of ileum', 'Ileocecal junction'].indexOf(n)
    let touching = 0, worst = 0, inversions = 0
    for (let i = 1; i < si.length; i++) {
      let best = Infinity
      const a = si[i - 1]!.mesh, b = si[i]!.mesh
      for (let v = 0; v < a.positions.length; v += 3) best = Math.min(best, distanceToMesh(b, [a.positions[v]!, a.positions[v + 1]!, a.positions[v + 2]!]))
      if (best <= 0.0015) touching++
      worst = Math.max(worst, best)
      if (cls(partById.get(si[i]!.part)!.name) < cls(partById.get(si[i - 1]!.part)!.name)) inversions++
    }
    const duo = items.find((it) => groups[it.group]!.key === 'duodenum')!
    const greedy = orderChain(si.map((it) => ({ id: it.part, ends: axisEnds(it.axis) })), axisEnds(duo.axis)[1])
    let agree = 0
    for (let i = 1; i < greedy.length; i++) {
      const k = si.findIndex((it) => it.part === greedy[i]!.id)
      if (k > 0 && si[k - 1]!.part === greedy[i - 1]!.id) agree++
    }
    report.smallIntestineOrder = {
      rule: 'part ids follow the string-sorted order of a running number (1, 10, 11, …, 19, 2, 20, …), separately for jejunum and ileum; inferred from the ids, not stated by the source',
      pieces: si.length, consecutivePairs: si.length - 1, pairsTouchingWithin1p5mm: touching, largestSurfaceGapMm: mm(worst), nameClassInversions: inversions,
      orderByEndDistanceAlone: { adjacenciesInCommon: agree, of: si.length - 1, note: 'greedy + 2-opt on end-to-end distance; the pieces are packed side by side, so end distance alone does not recover the order' },
    }
  }

  // 2. 口腔和咽：中心线和定界的真实部件（见 lumenHead.ts） / mouth and pharynx: centrelines and the real parts that bound them (see lumenHead.ts)
  const oesIn = axisEnds(items[0]!.axis)[0]
  const head = await headGuides(data.parts, meshOf, oesIn)
  const tPh = segmentTable(walls, 'pharynx'), tOral = segmentTable(walls, 'oral_cavity')
  const smoothPts = (pts: V3[], passes: number): Float64Array => {
    let line = pts.map((q) => [...q] as V3)
    for (let it = 0; it < passes; it++) {
      const next = line.map((q) => [...q] as V3)
      for (let i = 1; i < line.length - 1; i++) for (let q = 0; q < 3; q++) next[i]![q] = 0.5 * line[i]![q]! + 0.25 * (line[i - 1]![q]! + line[i + 1]![q]!)
      line = next
    }
    return Float64Array.from(line.flat())
  }
  const boundsOf = (list: { id: string; mesh: Mesh }[]): { id: string; mesh: Mesh; solid: SolidTester }[] => list.map((q) => ({ ...q, solid: new SolidTester(q.mesh) }))

  // 3. 把各段排成几条“行程”：一条行程是一串首尾相接的圈。囊（胃、升结肠）自成一程，从盲端到出口；
  //    上游的管（食管、回肠）在囊的腔面外侧停住，开口对着囊壁，不伸进囊腔里（伸进去就与囊的腔面相交）。
  //    标本自己的腔（女性直肠）同样：上游在它外面停住，下游从它外面开始。
  // 3. Lay the stretches out as "runs": a run is one chain of rings. A sac (stomach, ascending colon) is
  //    a run of its own from blind end to outlet; the tube upstream (oesophagus, ileum) stops just
  //    outside the sac's lumen surface with its open end facing the sac wall and does not reach into
  //    the cavity (which would intersect the sac's lumen surface). The specimen's own lumen (female
  //    rectum) is treated the same way: upstream stops outside it and downstream starts outside it.
  const tables = groups.map((g) => segmentTable(walls, g.seg))
  const SLIT = 0.0003, MARGIN = 0.0004
  const stretches: Stretch[] = []
  const gapRows: Record<string, unknown>[] = []
  let run = 0
  stretches.push({ run, group: 0, kind: 'guide', pts: resamplePolyline(smoothPts(head.oral, 2), STEP), radius: Math.max(tOral.collapsed, 0.004) / 2, bounds: boundsOf(head.oralBounds), maxR: 0.028 })
  stretches.push({ run, group: 1, kind: 'guide', pts: resamplePolyline(smoothPts(head.pharynx, 3), STEP), radius: tPh.collapsed / 2, bounds: boundsOf(head.pharynxBounds), maxR: 0.02 })
  const tail = (s: Stretch): { p: V3; t: V3 } => {
    const n = s.pts.length / 3
    return { p: P3(s.pts, n - 1), t: vec.unit(vec.sub(P3(s.pts, n - 1), P3(s.pts, Math.max(0, n - 3)))) }
  }
  const meshByPart = new Map(items.map((it) => [it.part, it.mesh]))
  const testers = new Map<string, SolidTester>()
  const solid = (id: string): SolidTester => {
    if (!testers.has(id)) testers.set(id, new SolidTester(meshByPart.get(id)!))
    return testers.get(id)!
  }
  // 每一段的轴和两端截掉的长度 / the axis of every piece and what is cut off at either end
  const BEND_MIN = 0.006
  let loops = 0
  const ax = items.map((it, i) => {
    const g = groups[it.group]!
    const pts = resamplePolyline(it.axis.points, STEP)
    const n = pts.length / 3
    const r = Array.from(it.axis.radius).slice(1, -1)
    const meanR = r.reduce((s, x) => s + x, 0) / Math.max(1, r.length)
    const cap = Math.min(0.5 * meanR, 0.25 * axisLength(it.axis))
    const sAx = arcLengths(pts)
    const total = sAx[n - 1]!
    const real = g.mode === 'real'
    const side = real || (!!g.sac && (i === 0 || items[i - 1]!.group !== it.group))
    // 两端的封盖不取截面：这一段在封盖处截短 / no cross-sections are taken in the end caps: the stretch is cut short there
    const capEnd = i === items.length - 1 ? Math.min(cap, 0.004) : cap
    let b0 = n - 1
    while (b0 > 2 && total - sAx[b0]! < capEnd) b0--
    let a0 = 0
    const inset = side ? (real ? 0.002 : Math.min(cap, tables[it.group]!.wall + 0.002)) : cap
    while (a0 < b0 - 1 && sAx[a0]! < inset) a0++
    return { pts, n, sAx, total, cap, real, side, a0, b0, trimmedA: 0, trimmedB: 0 }
  })
  // 急弯的接头：两段的端部互相埋在对方里，截点几乎重合而方向相反，直接相连就是一个折角。把两边的截点各自沿轴往回退，
  // 直到两点之间能放下一段曲率半径不小于 BEND_MIN 的圆弧（弦长 g、转角 θ 时半径为 g / (2 sin(θ/2))）；每边最多退掉该段的 35%。
  // 退掉的那几站仍在壁内，截面改为插值并限制在两段壁之内。
  // Sharp junctions: the ends of the two pieces are buried in each other, the cut points nearly coincide
  // while the directions oppose, and joining them directly leaves a kink. Both cut points are moved back
  // along their axes until an arc of radius no less than BEND_MIN fits between them (radius
  // g / (2 sin(θ/2)) for a chord g and a turn θ); at most 35% of a piece is given up at either end. The
  // stations given up are still inside the walls; their sections are interpolated and kept inside the two walls.
  const junctionGeom = (i: number): { g: number; theta: number; R: number } => {
    const A = ax[i - 1]!, B = ax[i]!
    const pa = P3(A.pts, A.b0), pb = P3(B.pts, B.a0)
    const ta = vec.unit(vec.sub(pa, P3(A.pts, Math.max(0, A.b0 - 2)))), tb = vec.unit(vec.sub(P3(B.pts, Math.min(B.n - 1, B.a0 + 2)), pb))
    const g = vec.dist(pa, pb)
    const theta = Math.acos(Math.max(-1, Math.min(1, vec.dot(ta, tb))))
    return { g, theta, R: theta < 0.05 ? Infinity : g / (2 * Math.sin(theta / 2)) }
  }
  for (let i = 1; i < items.length; i++) {
    const A = ax[i - 1]!, B = ax[i]!
    if (B.side || A.real) continue
    for (let guard = 0; guard < 200 && junctionGeom(i).R < BEND_MIN; guard++) {
      const canA = A.b0 - 1 > A.a0 + 2 && A.sAx[A.b0 - 1]! > 0.65 * A.total, canB = B.a0 + 1 < B.b0 - 2 && B.sAx[B.a0 + 1]! < 0.35 * B.total
      if (!canA && !canB) break
      if (canA && (!canB || A.trimmedB <= B.trimmedA)) (A.b0--, A.trimmedB++)
      else (B.a0++, B.trimmedA++)
    }
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    const g = groups[it.group]!
    const prevStretch = stretches[stretches.length - 1]!
    const prev = tail(prevStretch)
    const { pts: axisPts, sAx, total, cap, real, side, a0, b0 } = ax[i]!
    let entryPoint: V3, sideEntry = false
    if (side) {
      // 侧面进入：离上一段出口最近的轴上的站（囊：不在盲端的封盖里） / side entry: the axis station nearest the previous exit (for a sac, outside the cap of the blind end)
      let entry = a0, bd = Infinity
      for (let k = a0; k <= b0; k++) {
        if (sAx[k]! > total * 0.6 || (!real && sAx[k]! < cap)) continue
        const d = vec.dist(P3(axisPts, k), prev.p)
        if (d < bd) (bd = d), (entry = k)
      }
      entryPoint = P3(axisPts, entry)
      sideEntry = true
      const t1 = vec.unit(vec.sub(entryPoint, prev.p))
      stretches.push({ run, group: prevStretch.group, kind: 'bridge', pts: arcBridge(prev.p, prev.t, entryPoint, t1, STEP), hold: true, between: [prevStretch.part], into: it.part })
      run++
    } else {
      entryPoint = P3(axisPts, a0)
      const entryT = vec.unit(vec.sub(P3(axisPts, Math.min(b0, a0 + 2)), entryPoint))
      // 能放下的圆弧半径不到 4 mm：发夹，用水滴形的环（半径 3 mm）；否则用圆弧，弯得越急取样越密
      // no arc of 4 mm radius fits: a hairpin, carried round a teardrop loop (3 mm radius); otherwise an arc, sampled the finer the tighter it is
      const theta = Math.acos(Math.max(-1, Math.min(1, vec.dot(prev.t, entryT))))
      const Rarc = theta < 0.05 ? Infinity : vec.dist(prev.p, entryPoint) / (2 * Math.sin(theta / 2))
      const loop = i > 0 && prevStretch.kind === 'wall' && Rarc < 0.004
      if (loop) loops++
      const pts = loop ? teardropBridge(prev.p, prev.t, entryPoint, entryT, 0.003, 0.0012) : arcBridge(prev.p, prev.t, entryPoint, entryT, Math.max(0.0012, Math.min(STEP, Rarc / 2.5)))
      stretches.push({ run, group: it.group, kind: 'bridge', pts, between: [prevStretch.part, it.part], loop })
    }
    if (i > 0) {
      const turn = (Math.acos(Math.max(-1, Math.min(1, vec.dot(prev.t, vec.unit(vec.sub(P3(axisPts, Math.min(b0, a0 + 2)), P3(axisPts, a0))))))) * 180) / Math.PI
      const br = stretches[stretches.length - 1]!.pts
      const Rc = Array.from(curvatureRadius(br)).filter(Number.isFinite)
      gapRows.push({ from: items[i - 1]!.part, to: it.part, endToEndGapMm: mm(vec.dist(axisEnds(items[i - 1]!.axis)[1], sideEntry ? entryPoint : P3(axisPts, 0))), bridgeSpanMm: mm(vec.dist(prev.p, entryPoint)), bridgeLengthMm: mm(arcLengths(br)[br.length / 3 - 1]!), turnDeg: Math.round(turn), smallestRadiusOfCurvatureMm: Rc.length ? mm(Math.min(...Rc)) : null, stationsGivenUpForTheBend: [ax[i - 1]!.trimmedB, ax[i]!.trimmedA], teardropLoop: !!stretches[stretches.length - 1]!.loop, sideEntry })
    }
    stretches.push({ run, group: it.group, kind: real ? 'real' : 'wall', part: it.part, pts: axisPts.slice(3 * a0, 3 * (b0 + 1)), blind: side && !real })
    if (real) run++
  }

  // 肛门：沿直肠出口方向找皮肤 / the anus: the skin along the direction in which the rectum ends
  const skinPart = data.parts.filter((q) => q.tissue === 'skin').sort((a, b) => b.triangles - a.triangles)[0]
  const anus: Record<string, unknown> = {}
  {
    const lastStretch = stretches[stretches.length - 1]!
    const end = tail(lastStretch)
    let target: V3 | null = null
    if (skinPart) {
      const skin = await meshOf(skinPart.id)
      const h = rayNearest(skin, end.p, end.t)
      if (Number.isFinite(h.distance) && h.distance < 0.08) target = vec.add(end.p, vec.mul(end.t, h.distance))
      else {
        // 没有交点：取出口下方、中线附近最近的皮肤顶点 / no hit: the nearest skin vertex below the exit near the midline
        let bd = Infinity
        for (let v = 0; v < skin.positions.length; v += 3) {
          const q: V3 = [skin.positions[v]!, skin.positions[v + 1]!, skin.positions[v + 2]!]
          if (Math.abs(q[0] - end.p[0]) > 0.01 || q[1] > end.p[1]) continue
          const d = vec.dist(q, end.p)
          if (d < bd) (bd = d), (target = q)
        }
        anus.method = 'nearest skin vertex below the rectal end within 10 mm of the midline (the ray along the rectal axis missed the skin)'
      }
      if (target) {
        const tAnal = segmentTable(walls, 'anal_canal')
        Object.assign(anus, {
          method: anus.method ?? 'ray from the lower end of the rectal centreline along its tangent to the skin part',
          skinPart: skinPart.id, rectalEndMm: mm3(end.p), directionOfCanal: end.t.map((x) => Math.round(x * 1000) / 1000), anusOnSkinMm: mm3(target), distanceMm: mm(vec.dist(end.p, target)),
          ring: { closedDiameterMm: mm(tAnal.collapsed), distendedDiameterMm: mm(tAnal.distended), note: 'calibres are assumptions (walls.json)' },
        })
        const gi = groups.findIndex((g) => g.key === 'anal')
        const pts = resamplePolyline(Float64Array.from([...end.p, ...target]), STEP)
        stretches.push({ run, group: gi, kind: 'guide', pts, radius: tAnal.collapsed / 2 + 0.0015, avoid: lastStretch.kind === 'real' ? lastStretch.part : undefined })
      }
    }
  }

  // 站 / stations
  const centre: number[] = []
  const kind: number[] = []
  const grp: number[] = []
  const partOf: (string | undefined)[] = []
  const stretchOf: number[] = []
  const runOf: number[] = []
  for (let si = 0; si < stretches.length; si++) {
    const s = stretches[si]!
    let n = s.pts.length / 3
    let first = 0
    if (s.into) {
      // 进囊（或真实的腔）的桥：到腔面外侧为止 / a bridge into a sac (or a real lumen): it ends outside the lumen surface
      const intoMesh = meshByPart.get(s.into)!
      const isReal = groups[items.find((it) => it.part === s.into)!.group]!.mode === 'real'
      const wallIn = isReal ? 0 : tables[items.find((it) => it.part === s.into)!.group]!.wall
      for (let i = 0; i < n; i++) {
        const q = P3(s.pts, i)
        const inside = solid(s.into).contains(q[0], q[1], q[2])
        const d = distanceToMesh(intoMesh, q)
        if (isReal ? inside || d < 0.001 : inside && d > wallIn - 2 * MARGIN) {
          n = i
          break
        }
      }
    }
    if (s.avoid) {
      const m = meshByPart.get(s.avoid)!
      while (first < n - 2) {
        const q = P3(s.pts, first)
        if (!solid(s.avoid).contains(q[0], q[1], q[2]) && distanceToMesh(m, q) >= 0.001) break
        first++
      }
    }
    for (let i = first; i < n; i++) {
      const q = P3(s.pts, i)
      const last = centre.length / 3 - 1
      if (i === first && last >= 0 && runOf[last] === s.run && vec.dist(q, P3(centre, last)) < 1e-6) {
        // 与上一站重合：这一站归下游，但若下游是桥就保留上游的 / coincides with the previous station: it goes to the downstream stretch, unless that is a bridge
        if (s.kind === 'bridge') continue
        centre.length -= 3
        kind.pop(); grp.pop(); partOf.pop(); stretchOf.pop(); runOf.pop()
      }
      centre.push(...q)
      kind.push(s.kind === 'guide' ? KIND.guide : s.kind === 'bridge' ? KIND.bridge : s.kind === 'real' ? KIND.real : KIND.derived)
      grp.push(s.group)
      partOf.push(s.part)
      stretchOf.push(si)
      runOf.push(s.run)
    }
  }
  // 剩下的折角（桥与轴相接处）抹平；抹平会把站挤到一起，离上一站不到 0.8 mm 的站去掉
  // the kinks that are left (where a bridge meets an axis) are smoothed out; smoothing crowds stations together, and one closer than 0.8 mm to the one before it is dropped
  let kinksRelaxed = 0, stationsDropped = 0
  {
    const all = Float64Array.from(centre)
    const keep: number[] = []
    for (let i = 0; i < all.length / 3; ) {
      let j = i
      while (j < all.length / 3 && runOf[j] === runOf[i]) j++
      const sub = all.slice(3 * i, 3 * j)
      kinksRelaxed += relaxKinks(sub)
      all.set(sub, 3 * i)
      let last = i
      keep.push(i)
      for (let k = i + 1; k < j; k++) {
        if (k < j - 1 && vec.dist(P3(all, k), P3(all, last)) < 0.0008) {
          stationsDropped++
          continue
        }
        keep.push(k)
        last = k
      }
      i = j
    }
    const pick = <T>(arr: T[]): T[] => keep.map((k) => arr[k]!)
    const c2 = keep.flatMap((k) => P3(all, k))
    centre.length = 0
    centre.push(...c2)
    const k2 = pick(kind), g2 = pick(grp), p2 = pick(partOf), s2 = pick(stretchOf), r2 = pick(runOf)
    kind.length = grp.length = partOf.length = stretchOf.length = runOf.length = 0
    kind.push(...k2); grp.push(...g2); partOf.push(...p2); stretchOf.push(...s2); runOf.push(...r2)
  }
  // 两段中心线几乎相交的地方（源数据里两片肠管叠在一起）：把两处各自推开，直到相距 2.5 mm，左右各两站跟着挪一半、四分之一。
  // 否则两条缝一样细的腔也会互相穿过。
  // Where two stretches of centreline all but cross (two pieces of bowel lying on top of each other in the
  // source) both are pushed apart until 2.5 mm separate them, two stations on either side following by a
  // half and a quarter. Otherwise even two lumina as thin as slits would pass through each other.
  let centresPushedApart = 0
  {
    const n = centre.length / 3
    const DMIN = 0.0025
    for (let pass = 0; pass < 20; pass++) {
      let any = false
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        if (runOf[i] === runOf[j] && j - i <= 12) continue
        const d = vec.dist(P3(centre, i), P3(centre, j))
        if (d >= DMIN) continue
        any = true
        if (pass === 0) centresPushedApart++
        const e = d > 1e-7 ? vec.unit(vec.sub(P3(centre, j), P3(centre, i))) : ([1, 0, 0] as V3)
        const push = (DMIN - d) / 2 + 1e-5
        for (const [k0, sgn] of [[i, -1], [j, 1]] as const) for (let w = -2; w <= 2; w++) {
          const k = k0 + w
          if (k < 0 || k >= n || runOf[k] !== runOf[k0]) continue
          const f = sgn * push * (w === 0 ? 1 : Math.abs(w) === 1 ? 0.5 : 0.25)
          for (let q = 0; q < 3; q++) centre[3 * k + q] = centre[3 * k + q]! + f * e[q]!
        }
      }
      if (!any) break
    }
  }
  const N = centre.length / 3
  const C = Float64Array.from(centre)
  const runs: [number, number][] = []
  for (let i = 0; i < N; ) {
    let j = i
    while (j < N && runOf[j] === runOf[i]) j++
    runs.push([i, j])
    i = j
  }
  /** 桥上一站可以待在哪些壁里 / the walls a bridge station may lie in */
  const homeOf = (i: number): string[] => {
    const s = stretches[stretchOf[i]!]!
    return (partOf[i] ? [partOf[i]] : [...(s.between ?? []), s.into]).filter((x): x is string => !!x)
  }
  const insideAny = (ids: string[], q: ArrayLike<number>): boolean => ids.some((id) => solid(id).contains(q[0]!, q[1]!, q[2]!))
  // 桥上仍在相邻壁部件之内的站记为“封盖”：那里有壁，只是截面是插值的
  // bridge stations still inside a neighbouring wall part are recorded as "cap": a wall exists there, only the cross-section is interpolated
  for (let i = 0; i < N; i++) if (kind[i] === KIND.bridge && insideAny(homeOf(i), P3(C, i))) kind[i] = KIND.cap
  const S = new Float64Array(N)
  const dir = new Float64Array(N * SIDES * 3)
  for (const [a, b] of runs) {
    const sub = C.subarray(3 * a, 3 * b)
    const s = arcLengths(sub)
    const base = a > 0 ? S[a - 1]! + vec.dist(P3(C, a - 1), P3(C, a)) : 0
    for (let i = a; i < b; i++) S[i] = base + s[i - a]!
    const f = transportFrames(sub)
    for (let i = a; i < b; i++) for (let k = 0; k < SIDES; k++) {
      const ang = (2 * Math.PI * k) / SIDES
      for (let q = 0; q < 3; q++) dir[3 * (i * SIDES + k) + q] = Math.cos(ang) * f.u[3 * (i - a) + q]! + Math.sin(ang) * f.v[3 * (i - a) + q]!
    }
  }

  // 4. 截面与内缩 / cross-sections and the offset
  /** 每个顶点的来历：0 由壁推出，1 构造，2 以真实部件为界 / origin of every vertex: 0 derived from a wall, 1 construction, 2 bounded by real parts */
  const origin = new Uint8Array(N * SIDES).fill(1)
  const outer = new Float64Array(N * SIDES).fill(NaN)
  const cosA = new Float64Array(N * SIDES).fill(1)
  const inner = new Float64Array(N * SIDES).fill(NaN)
  const collapsedStation = new Uint8Array(N)
  let guideInsideBound = 0
  for (let i = 0; i < N; i++) {
    const o = P3(C, i)
    if (kind[i] === KIND.guide) {
      const s = stretches[stretchOf[i]!]!
      const fallback = s.radius ?? 0.002
      const hits: number[] = []
      const inBound = !!s.bounds && s.bounds.some((b) => b.solid.contains(o[0], o[1], o[2]))
      if (inBound) guideInsideBound++
      for (let k = 0; k < SIDES; k++) {
        let best = Infinity
        if (s.bounds && !inBound) for (const b of s.bounds) best = Math.min(best, rayNearest(b.mesh, o, P3(dir, i * SIDES + k)).distance)
        if (best < (s.maxR ?? 0)) {
          inner[i * SIDES + k] = Math.max(SLIT, best - MARGIN)
          origin[i * SIDES + k] = 2
          hits.push(best - MARGIN)
        }
      }
      // 没有打到真实部件的方向：取这一站打到的半径的中位数（没有就取缺省半径），这是构造
      // directions that hit no real part take the median of this station's hits (the default radius when there are none): construction
      const fill = Math.max(SLIT, hits.length >= 3 ? Math.min(median(hits), s.maxR ?? fallback) : fallback)
      for (let k = 0; k < SIDES; k++) if (!Number.isFinite(inner[i * SIDES + k]!)) inner[i * SIDES + k] = fill
      // 从部件之间的缝里射出去很远的单条射线会成一片尖刺：一条射线不超过左右两邻中较小者的两倍加 1 mm；被削的算构造
      // a single ray escaping far through a gap between parts makes a fin: a ray may not exceed twice the smaller of its two neighbours plus 1 mm; one that is cut counts as construction
      for (let pass = 0; pass < 3; pass++) for (let k = 0; k < SIDES; k++) {
        const lim = 2 * Math.min(inner[i * SIDES + ((k + 1) % SIDES)]!, inner[i * SIDES + ((k + SIDES - 1) % SIDES)]!) + 0.001
        if (inner[i * SIDES + k]! > lim) (inner[i * SIDES + k] = lim), (origin[i * SIDES + k] = 1)
      }
      continue
    }
    if (kind[i] !== KIND.derived && kind[i] !== KIND.real) continue
    const mesh = meshByPart.get(partOf[i]!)!
    // 中心不在自己的壁里（凹的截面）：不能从这里取截面 / a centre outside its own wall (a concave section): no cross-section can be taken from here
    if (!solid(partOf[i]!).contains(o[0], o[1], o[2])) {
      kind[i] = KIND.bridge
      continue
    }
    const vals: number[] = []
    for (let k = 0; k < SIDES; k++) {
      const h = rayNearest(mesh, o, P3(dir, i * SIDES + k))
      if (Number.isFinite(h.distance)) {
        outer[i * SIDES + k] = h.distance
        cosA[i * SIDES + k] = h.cos
        vals.push(h.distance)
      }
    }
    if (vals.length < SIDES) {
      kind[i] = KIND.cap
      continue
    }
    if (kind[i] === KIND.real) for (let k = 0; k < SIDES; k++) inner[i * SIDES + k] = outer[i * SIDES + k]!
    else {
      const t = tables[grp[i]!]!
      const res = offsetInward(outer.subarray(i * SIDES, (i + 1) * SIDES), cosA.subarray(i * SIDES, (i + 1) * SIDES), 1, SIDES, { wall: t.wall, slit: 0.0005 })
      inner.set(res.inner, i * SIDES)
      collapsedStation[i] = res.collapsed[0]!
      origin.fill(0, i * SIDES, (i + 1) * SIDES)
    }
  }
  // 桥和封盖处的半径：同一行程里两侧有效的圈之间按弧长线性插值；保持型的桥沿用上游
  // radii of bridges and caps: linear in arc length between the valid rings on either side within the run; a holding bridge keeps the upstream ring
  const valid = (i: number): boolean => kind[i] === KIND.derived || kind[i] === KIND.real || kind[i] === KIND.guide
  for (const [ra, rb] of runs) {
    for (let i = ra; i < rb; ) {
      if (valid(i)) {
        i++
        continue
      }
      let j = i
      let hold = false
      while (j < rb && !valid(j)) (hold = hold || !!stretches[stretchOf[j]!]!.hold), j++
      const a = i - 1, b = j
      for (let q = i; q < j; q++) for (let k = 0; k < SIDES; k++) {
        const va = a >= ra ? inner[a * SIDES + k]! : NaN, vb = b < rb ? inner[b * SIDES + k]! : NaN
        let r: number
        if (a < ra) r = b < rb ? vb : 0.002
        else if (b >= rb || hold) r = va
        else r = va + ((vb - va) * (S[q]! - S[a]!)) / Math.max(1e-9, S[b]! - S[a]!)
        inner[q * SIDES + k] = r
      }
      i = j
    }
  }
  // 插值出来的圈不许超出它所在的壁：沿每条射线找到离开壁的地方，退回一个壁厚
  // an interpolated ring may not leave the walls it lies in: along every ray the place where the wall is left is found and one wall thickness taken off
  let clampedToWall = 0
  for (let i = 0; i < N; i++) {
    if (kind[i] !== KIND.cap && kind[i] !== KIND.bridge) continue
    const home = homeOf(i)
    const o = P3(C, i)
    if (!insideAny(home, o)) {
      kind[i] = KIND.bridge
      continue
    }
    kind[i] = KIND.cap
    const wall = tables[grp[i]!]!.wall
    let hit = false
    for (let k = 0; k < SIDES; k++) {
      const d = P3(dir, i * SIDES + k)
      const r = inner[i * SIDES + k]!
      for (let rho = 0.0005; rho <= r + wall + 0.0005; rho += 0.0005) {
        if (insideAny(home, vec.add(o, vec.mul(d, rho)))) continue
        const lim = Math.max(SLIT, rho - 0.00025 - wall)
        if (lim < r) (inner[i * SIDES + k] = lim), (hit = true)
        break
      }
    }
    if (hit) clampedToWall++
  }
  // 口径不超过表里的充盈口径 / calibre no larger than the tabled distended calibre
  {
    const cal = ringCalibre(inner, N, SIDES)
    for (let i = 0; i < N; i++) {
      const lim = tables[grp[i]!]!.distended
      if (kind[i] === KIND.real || !(cal[i]! > lim)) continue
      for (let k = 0; k < SIDES; k++) inner[i * SIDES + k] = inner[i * SIDES + k]! * (lim / cal[i]!)
    }
  }

  // 5. 括约肌 / sphincters
  const groupRange = (key: string): [number, number] => {
    const gi = groups.findIndex((g) => g.key === key)
    let a = -1, b = -1
    for (let i = 0; i < N; i++) if (grp[i] === gi) (a = a < 0 ? i : a), (b = i)
    return [a, b]
  }
  const sph: Record<string, unknown>[] = []
  const narrow = (name: string, at: number): void => {
    const t = walls.sphincters[name]!
    const length = (t.length.value ?? 0) / 1000, ratio = t.closedRatio.value ?? 1
    const before = ringCalibre(inner, N, SIDES)
    const res = sphincterNarrowing(inner, S, SIDES, at, length, ratio, SLIT * 2)
    inner.set(res.radius)
    const after = ringCalibre(inner, N, SIDES)
    let k = 0
    for (let i = 0; i < N; i++) if (Math.abs(S[i]! - at) < Math.abs(S[k]! - at)) k = i
    sph.push({ sphincter: name, atArcMm: mm(at), atMm: mm3(P3(C, k)), lengthMm: mm(length), closedRatio: ratio, calibreBeforeMm: mm(before[k]!), calibreAfterMm: mm(after[k]!), assumption: true })
  }
  const lenOf = (name: string): number => (walls.sphincters[name]!.length.value ?? 0) / 1000
  const lastWallOf = (key: string): number => {
    let i = groupRange(key)[1]
    while (i > 0 && kind[i] !== KIND.derived && grp[i - 1] === grp[i]) i--
    return i
  }
  narrow('upper_oesophageal', S[groupRange('oesophagus')[0]]! + lenOf('upper_oesophageal') / 2)
  narrow('lower_oesophageal', S[lastWallOf('oesophagus')]! - lenOf('lower_oesophageal') / 2)
  narrow('pyloric', S[groupRange('stomach')[1]]!)
  narrow('ileocaecal', S[lastWallOf('ileum')]! - lenOf('ileocaecal') / 2)
  narrow('internal_anal', S[N - 1]! - 0.012 - lenOf('internal_anal') / 2)
  narrow('external_anal', S[N - 1]! - lenOf('external_anal') / 2)
  /** 只做了内缩、插值和括约肌的半径：下面两条规则之前的状态，用来算体积的损失 / radii after offset, interpolation and sphincters only: the state before the two rules below, for the volume loss */
  const innerBase = inner.slice()

  // 6. 弯处：逐条射线的平面限制（见 limitByPlanes）/ bends: the per-ray plane limit (see limitByPlanes)
  const bendCut = new Float64Array(N)
  const covLo = new Int32Array(N), covHi = new Int32Array(N)
  let limited = 0
  for (const [a, b] of runs) {
    const sub = inner.slice(a * SIDES, b * SIDES)
    const res = limitByPlanes(sub, C.subarray(3 * a, 3 * b), dir.subarray(3 * a * SIDES, 3 * b * SIDES), SIDES, { floor: SLIT })
    inner.set(sub, a * SIDES)
    bendCut.set(res.cut, a)
    for (let i = a; i < b; i++) (covLo[i] = res.lo[i - a]! + a), (covHi[i] = res.hi[i - a]! + a)
    limited += res.limited
  }
  // 7. 互相伸进对方的两段腔：各让一半重叠深度（见 separateRings），中间留 1 mm（假设值）。扫描的壁不动，只是腔让开。
  //    标本自己的腔不动：别的腔的射线在它外面 0.4 mm 处停住。每一站让了多少、让给谁都记下来。
  // 7. Two stretches of lumen reaching into each other each give half of the overlap depth (see
  //    separateRings), leaving 1 mm between them (an assumption). The scanned walls are not moved, only
  //    the lumina give way. The specimen's own lumen does not move: rays of other lumina stop 0.4 mm
  //    outside it. What every station gave, and to which, is recorded.
  const overlapRows: { station: number; group: string; part: string | null; other: string | null; otherStation: number | null; shrinkMm: number }[] = []
  for (let i = 0; i < N; i++) {
    if (kind[i] === KIND.real) continue
    const o = P3(C, i)
    for (const other of items) {
      if (groups[other.group]!.mode !== 'real') continue
      const b = other.inventoryBox
      if (o[0] < b[0]! - 0.04 || o[0] > b[3]! + 0.04 || o[1] < b[1]! - 0.04 || o[1] > b[4]! + 0.04 || o[2] < b[2]! - 0.04 || o[2] > b[5]! + 0.04) continue
      const inside = solid(other.part).contains(o[0], o[1], o[2])
      let shrink = 0
      for (let k = 0; k < SIDES; k++) {
        const r = inner[i * SIDES + k]!
        const lim = inside ? SLIT : Math.max(SLIT, rayNearest(other.mesh, o, P3(dir, i * SIDES + k)).distance - MARGIN)
        if (lim < r) (shrink = Math.max(shrink, r - lim)), (inner[i * SIDES + k] = lim)
      }
      if (shrink > 0) overlapRows.push({ station: i, group: groups[grp[i]!]!.key, part: partOf[i] ?? null, other: other.part, otherStation: null, shrinkMm: mm(shrink) })
    }
  }
  const SEPTUM = 0.001
  const sepRes = separateRings(inner, C, dir, SIDES, { covered: (i, j) => kind[i] === KIND.real || kind[j] === KIND.real || (j >= covLo[i]! && j <= covHi[i]!), sep: SEPTUM, floor: SLIT })
  for (let i = 0; i < N; i++) if (sepRes.gave[i]! > 1e-6) overlapRows.push({ station: i, group: groups[grp[i]!]!.key, part: partOf[i] ?? null, other: partOf[sepRes.partner[i]!] ?? null, otherStation: sepRes.partner[i]!, shrinkMm: mm(sepRes.gave[i]!) })

  // 8. 充盈：inner 是充盈到头（f = 1）的面——由静止不动的壁决定，再大就出壁了；f = 0 时每一站按比例缩到表里的塌陷口径
  //    （本来就更窄的不动）。存下来的几何是 f = 静止充盈度 时的面。
  // 8. Filling: `inner` is the fully filled surface (f = 1) — set by the wall, which does not move, so
  //    nothing larger fits; at f = 0 every station is scaled to the tabled collapsed calibre (a station
  //    already narrower is left). The stored geometry is the surface at f = the resting filling.
  const r1 = inner
  const r0 = new Float64Array(N * SIDES)
  const restOf = groups.map((g) => restFilling(walls, g.seg))
  const fill0 = (): void => {
    const cal = ringCalibre(r1, N, SIDES)
    for (let i = 0; i < N; i++) {
      const lo = tables[grp[i]!]!.collapsed
      const f = cal[i]! > lo ? lo / cal[i]! : 1
      for (let k = 0; k < SIDES; k++) r0[i * SIDES + k] = Math.min(r1[i * SIDES + k]!, Math.max(SLIT, r1[i * SIDES + k]! * f))
    }
  }
  fill0()
  const radiiAt = (f: number, useRest = false): Float64Array => {
    const out = new Float64Array(N * SIDES)
    for (let i = 0; i < N; i++) {
      const ff = useRest ? restOf[grp[i]!]!.filling : f
      for (let k = 0; k < SIDES; k++) out[i * SIDES + k] = r0[i * SIDES + k]! + ff * (r1[i * SIDES + k]! - r0[i * SIDES + k]!)
    }
    return out
  }
  /** 整条管在给定半径下的网格，以及每个三角形所在的站（真实的腔那几站不出面；标本自己的腔原样加进来） / the whole canal as one mesh at given radii with the station of every triangle (no surface for stations of a real lumen; the specimen's own lumen is added as it is) */
  const canalMesh = (rad: Float64Array): { mesh: Mesh; station: Int32Array } => {
    const meshes: Mesh[] = []
    const st: number[] = []
    for (const [a, b] of runs) {
      if (kind[a] === KIND.real || b - a < 2) continue
      let m = ringsToMesh(C.subarray(3 * a, 3 * b), dir.subarray(3 * a * SIDES, 3 * b * SIDES), rad.subarray(a * SIDES, b * SIDES), b - a, SIDES)
      for (let t = 0; t < m.indices.length / 3; t++) st.push(a + Math.floor(t / (2 * SIDES)))
      if (stretches[stretchOf[a]!]!.blind) {
        m = capRings(m, C.subarray(3 * a, 3 * b), b - a, SIDES, true, false)
        for (let k = 0; k < SIDES; k++) st.push(a)
      }
      meshes.push(m)
    }
    for (const it of items) if (groups[it.group]!.mode === 'real') {
      meshes.push(it.mesh)
      for (let t = 0; t < it.mesh.indices.length / 3; t++) st.push(-1)
    }
    return { mesh: mergeParts(meshes), station: Int32Array.from(st) }
  }
  // 9. 自交检查和最后的修补：在 f = 1、静止、f = 0 三个状态下数相交的三角形对；还有的话，把牵涉到的站再缩小两成，
  //    直到一对也没有。每一站缩了多少都记下来（前面两条规则之后应当所剩无几）。
  // 9. The self-intersection check and a last repair: intersecting triangle pairs are counted at f = 1,
  //    at rest and at f = 0; while any remain the stations involved are shrunk by a fifth, until none is
  //    left. What every station lost is recorded (little should remain after the two rules above).
  const beforeRepair = { atFull: selfIntersections(canalMesh(r1).mesh, 1e9), ringPairsCrossing: 0 }
  for (const [a, b] of runs) if (kind[a] !== KIND.real) beforeRepair.ringPairsCrossing += ringPlaneCrossings(C.subarray(3 * a, 3 * b), dir.subarray(3 * a * SIDES, 3 * b * SIDES), r1.subarray(a * SIDES, b * SIDES), SIDES)
  const repairFactor = new Float64Array(N).fill(1)
  let repairRounds = 0, bestTotal = Infinity, stall = 0
  const stateCounts: Record<string, number> = {}
  for (; repairRounds < 60; repairRounds++) {
    const bad = new Set<number>()
    for (const [name, rad] of [['full', r1], ['rest', radiiAt(0, true)], ['empty', r0]] as const) {
      const cm = canalMesh(rad)
      const pairs: number[] = []
      stateCounts[name] = selfIntersections(cm.mesh, 1e9, pairs)
      for (const t of pairs) if (cm.station[t]! >= 0) (bad.add(cm.station[t]!), bad.add(Math.min(N - 1, cm.station[t]! + 1)))
    }
    if (!bad.size) break
    // 连着八轮没有变少就停（剩下的不是缩小能解决的） / stop after eight rounds without progress (what is left cannot be solved by shrinking)
    const totalNow = stateCounts.full! + stateCounts.rest! + stateCounts.empty!
    if (totalNow < bestTotal) (bestTotal = totalNow), (stall = 0)
    else if (++stall >= 8) break
    for (const i of bad) {
      repairFactor[i] = repairFactor[i]! * 0.8
      for (let k = 0; k < SIDES; k++) {
        r1[i * SIDES + k] = Math.max(SLIT, r1[i * SIDES + k]! * 0.8)
        r0[i * SIDES + k] = Math.min(r1[i * SIDES + k]!, Math.max(SLIT, r0[i * SIDES + k]! * 0.8))
      }
    }
  }
  // 修不掉的：列出来 / what the repair could not remove: listed
  const leftRows: Record<string, unknown>[] = []
  {
    const cm = canalMesh(r1)
    const pairs: number[] = []
    selfIntersections(cm.mesh, 1e9, pairs)
    const seen = new Set<string>()
    for (let q = 0; q < pairs.length; q += 2) {
      const a = cm.station[pairs[q]!]!, b = cm.station[pairs[q + 1]!]!
      const key = `${Math.min(a, b)}-${Math.max(a, b)}`
      if (seen.has(key)) continue
      seen.add(key)
      const d = (i: number): unknown => (i < 0 ? 'real lumen' : { station: i, group: groups[grp[i]!]!.key, kind: KIND_NAME[kind[i]!], part: partOf[i] ?? null, maxRadiusMm: mm(Math.max(...r1.subarray(i * SIDES, (i + 1) * SIDES))), atMm: mm3(P3(C, i)) })
      leftRows.push({ a: d(a), b: d(b) })
    }
  }
  const repairRows: { station: number; group: string; factor: number }[] = []
  for (let i = 0; i < N; i++) if (repairFactor[i]! < 1) repairRows.push({ station: i, group: groups[grp[i]!]!.key, factor: Math.round(repairFactor[i]! * 1000) / 1000 })
  const rRest = radiiAt(0, true)

  // 10. 每组一个腔部件 / one lumen part per group
  const parts: LumenPartOut[] = []
  const groupRows: Record<string, unknown>[] = []
  let pathConstructed = 0, pathTotal = 0
  const stepLen = (i: number): number => (i > 0 && runOf[i - 1] === runOf[i] ? S[i]! - S[i - 1]! : 0)
  for (let i = 1; i < N; i++) {
    pathTotal += stepLen(i)
    if (kind[i] === KIND.bridge || (kind[i] === KIND.guide && !origin.subarray(i * SIDES, (i + 1) * SIDES).includes(2))) pathConstructed += stepLen(i)
  }
  const volOf = (rad: Float64Array, a: number, b: number): number => ringVolume(C.subarray(3 * a, 3 * b + 3), dir, rad.subarray(a * SIDES, (b + 1) * SIDES), b - a + 1, SIDES)
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]!
    const t = tables[gi]!
    let a = -1, b = -1
    for (let i = 0; i < N; i++) if (grp[i] === gi) (a = a < 0 ? i : a), (b = i)
    if (a < 0) continue
    const lengthBy: Record<string, number> = { derived: 0, real: 0, guide: 0, bridge: 0, cap: 0 }
    for (let i = a; i <= b; i++) lengthBy[KIND_NAME[kind[i]!]!]! += stepLen(i)
    const total = Object.values(lengthBy).reduce((s, x) => s + x, 0)
    const row: Record<string, unknown> = {
      group: g.key, lumen: g.lumenId, name: g.name, fma: g.fma, fmaLabel: fmaNames?.label.get(g.fma) ?? null, mode: g.mode, wallParts: g.parts.length,
      centrelineMm: mm(total), byOriginMm: Object.fromEntries(Object.entries(lengthBy).map(([k, v]) => [k, mm(v)])),
      constructedCentrelineMm: mm(lengthBy.bridge! + lengthBy.guide!), constructedShare: Math.round((1000 * (lengthBy.bridge! + lengthBy.guide!)) / Math.max(1e-9, total)) / 1000,
      interpolatedThroughCapsMm: mm(lengthBy.cap!),
      wallMm: mm(t.wall), wallAssumed: t.wallAssumed, calibreAssumed: t.calibreAssumed, restState: t.rest, restFilling: restOf[gi],
    }
    if (g.mode !== 'real') {
      // 与下游共用一圈，两个部件才接得上 / one ring is shared with the part downstream so that the two meet
      const next = b + 1 < N && runOf[b + 1] === runOf[b] && groups[grp[b + 1]!]!.mode !== 'real' ? b + 1 : b
      const st = next - a + 1
      const cc = C.subarray(3 * a, 3 * (next + 1)), dd = dir.subarray(3 * a * SIDES, 3 * (next + 1) * SIDES)
      const rr = rRest.subarray(a * SIDES, (next + 1) * SIDES)
      let mesh = ringsToMesh(cc, dd, rr, st, SIDES)
      const ringVerts = st * SIDES
      const blind = !!stretches[stretchOf[a]!]!.blind && (a === 0 || runOf[a - 1] !== runOf[a])
      if (blind) mesh = capRings(mesh, cc, st, SIDES, true, false)
      const nv = mesh.positions.length / 3
      const centres = new Float32Array(nv * 3)
      const org = new Uint8Array(nv)
      const disp = new Float32Array(nv * 3)
      for (let v = 0; v < nv; v++) {
        const sIdx = v < ringVerts ? Math.floor(v / SIDES) : 0
        centres.set(P3(cc, sIdx), 3 * v)
        if (v >= ringVerts) {
          org[v] = 1
          continue
        }
        const gv = a * SIDES + v
        org[v] = origin[gv]!
        const dr = r1[gv]! - r0[gv]!
        for (let q = 0; q < 3; q++) disp[3 * v + q] = dr * dir[3 * gv + q]!
      }
      const count = (x: number): number => org.reduce((s, y) => s + (y === x ? 1 : 0), 0)
      const cal1 = ringCalibre(r1.subarray(a * SIDES, (b + 1) * SIDES), b - a + 1, SIDES)
      const calR = ringCalibre(rRest.subarray(a * SIDES, (b + 1) * SIDES), b - a + 1, SIDES)
      const cal0 = ringCalibre(r0.subarray(a * SIDES, (b + 1) * SIDES), b - a + 1, SIDES)
      const meanOf = (x: ArrayLike<number>): number => Array.from(x).reduce((s, y) => s + y, 0) / Math.max(1, x.length)
      const composition: PartPiece[] = []
      if (count(0)) composition.push({ what: { zh: `由 ${g.parts.length} 个壁部件的外表面内缩 ${mm(t.wall)} mm 得到（文献壁厚，不是扫描）`, en: `outer surface of ${g.parts.length} wall part(s) offset inward by ${mm(t.wall)} mm (literature wall thickness, not scanned)` }, provenance: 'curated', source: 'soma (derived)', vertices: count(0) })
      if (count(2)) composition.push({ what: { zh: '以这副人体里周围的真实部件的表面为界（射线打到的最近的面）', en: 'bounded by the surfaces of the real parts around it in this body (the nearest surface each ray meets)' }, provenance: 'curated', source: 'soma (derived)', vertices: count(2) })
      if (count(1)) composition.push({ what: { zh: '构造：器官之间的桥接、穿过器官端盖的几站、没有壁可依的部分', en: 'construction: bridges between organs, stations through an organ’s end caps, stretches with no wall to follow' }, provenance: 'construction', source: null, vertices: count(1) })
      const volBase = volOf(innerBase, a, b), vol1 = volOf(r1, a, b), volR = volOf(rRest, a, b), vol0 = volOf(r0, a, b)
      const cm3 = (v: number): number => Math.round(v * 1e7) / 10
      // 各种来历的面积 / surface area by origin
      const areaBy = [0, 0, 0]
      for (let tIdx = 0; tIdx < mesh.indices.length; tIdx += 3) {
        const ia = mesh.indices[tIdx]!, ib = mesh.indices[tIdx + 1]!, ic = mesh.indices[tIdx + 2]!
        const A = P3(mesh.positions, ia), B = P3(mesh.positions, ib), Cc = P3(mesh.positions, ic)
        const o3 = [org[ia]!, org[ib]!, org[ic]!]
        areaBy[o3.includes(1) ? 1 : o3.includes(2) ? 2 : 0]! += 0.5 * vec.len(vec.cross(vec.sub(B, A), vec.sub(Cc, A)))
      }
      const overl = overlapRows.filter((r) => r.station >= a && r.station <= b)
      Object.assign(row, {
        triangles: mesh.indices.length / 3, vertices: nv, blindEndClosed: blind,
        volumeCm3: { beforeOverlapAndBendRules: cm3(volBase), full: cm3(vol1), rest: cm3(volR), empty: cm3(vol0), lossShare: volBase > 0 ? Math.round((1000 * (volBase - vol1)) / volBase) / 1000 : 0 },
        calibreMm: { full: { mean: mm(meanOf(cal1)), min: mm(Math.min(...cal1)), max: mm(Math.max(...cal1)) }, rest: { mean: mm(meanOf(calR)) }, empty: { mean: mm(meanOf(cal0)) }, tabled: [mm(t.collapsed), mm(t.distended)] },
        surfaceAreaCm2: { derived: Math.round(areaBy[0]! * 1e5) / 10, boundedByRealParts: Math.round(areaBy[2]! * 1e5) / 10, construction: Math.round(areaBy[1]! * 1e5) / 10 },
        collapsedStations: Array.from({ length: b - a + 1 }, (_, q) => collapsedStation[a + q]!).reduce((s, x) => s + x, 0),
        stationsGivingWayToOtherWalls: new Set(overl.map((r) => r.station)).size, stationsLimitedAtBends: Array.from(bendCut.subarray(a, b + 1)).filter((x) => x > 0).length, stationsRepaired: repairRows.filter((r) => r.station >= a && r.station <= b).length,
        composition: composition.map((c) => ({ provenance: c.provenance, vertices: c.vertices })),
      })
      parts.push({ id: g.lumenId, name: g.name, fma: g.fma, group: g.key, system: 'digestive', mesh, centres, composition, volumeCm3: volR * 1e6, provenance: 'curated', walls: g.parts, filling: { rest: restOf[gi]!.filling, displacement: disp }, constructed: Uint8Array.from(org, (x) => (x === 1 ? 1 : 0)), origin: org, restState: restOf[gi]! })
    } else {
      const m = await meshOf(g.parts[0]!)
      const cal = ringCalibre(r1, N, SIDES)
      Object.assign(row, { note: 'the specimen’s own lumen, used unchanged; no new part', volumeCm3: Math.round(signedVolume(m) * 1e7) / 10, triangles: m.indices.length / 3, calibreMm: { mean: mm(Array.from(cal).slice(a, b + 1).reduce((s, x) => s + x, 0) / (b - a + 1)) } })
    }
    groupRows.push(row)
  }

  // 11. 检查 / checks
  const meanR = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    let s = 0
    for (let k = 0; k < SIDES; k++) s += rRest[i * SIDES + k]!
    meanR[i] = s / SIDES
  }
  let maxStep = 0
  for (let i = 1; i < N; i++) maxStep = Math.max(maxStep, stepLen(i))
  // 腔在壁内：由壁推出的每个顶点，在 f = 1（最大的状态）下 / lumen inside wall: every vertex derived from a wall, at f = 1 (the largest state)
  let insideN = 0, outsideN = 0, minClear = Infinity
  const clearRatio: number[] = []
  const outsideRows: Record<string, unknown>[] = []
  for (let i = 0; i < N; i++) {
    if (kind[i] !== KIND.derived) continue
    const id = partOf[i]!
    const mesh = meshByPart.get(id)!
    for (let k = 0; k < SIDES; k++) {
      const v = vec.add(P3(C, i), vec.mul(P3(dir, i * SIDES + k), r1[i * SIDES + k]!))
      if (solid(id).contains(v[0], v[1], v[2])) insideN++
      else (outsideN++, outsideRows.push({ station: i, part: id, atMm: mm3(v) }))
      if (k % 2 === 0) {
        const d = distanceToMesh(mesh, v)
        minClear = Math.min(minClear, d)
        clearRatio.push(d / tables[grp[i]!]!.wall)
      }
    }
  }
  let ringCross = 0
  for (const [a, b] of runs) if (kind[a] !== KIND.real) ringCross += ringPlaneCrossings(C.subarray(3 * a, 3 * b), dir.subarray(3 * a * SIDES, 3 * b * SIDES), r1.subarray(a * SIDES, b * SIDES), SIDES)
  let wallsUnchanged = true
  for (const it of items) if (meshHash(await meshOf(it.part)) !== hashesBefore.get(it.part)) wallsUnchanged = false
  // 充盈：体积随 f 单调 / filling: volume is monotone in f
  const fillingSteps = [0, 0.25, 0.5, 0.75, 1]
  const fillingRows = groupRows.filter((r) => r.mode !== 'real').map((r) => {
    const [a, b] = groupRange(r.group as string)
    const vols = fillingSteps.map((f) => Math.round(volOf(radiiAt(f), a, b) * 1e7) / 10)
    return { group: r.group, volumeCm3AtF: vols, monotone: vols.every((v, q) => q === 0 || v >= vols[q - 1]!) }
  })

  const lengths: Record<string, number> = {}
  for (const r of groupRows) lengths[r.group as string] = r.centrelineMm as number
  const si = (lengths.duodenum ?? 0) + (lengths.jejunum ?? 0) + (lengths.ileum ?? 0)
  const siRows = groupRows.filter((r) => ['duodenum', 'jejunum', 'ileum'].includes(r.group as string))
  const siConstructed = siRows.reduce((s, r) => s + (r.constructedCentrelineMm as number), 0)
  report.canal = {
    stations: N, sides: SIDES, stepMm: mm(STEP), totalCentrelineMm: mm(pathTotal),
    runs: runs.map(([a, b]) => ({ from: groups[grp[a]!]!.key, to: groups[grp[b - 1]!]!.key, stations: b - a, startsAtBlindEnd: !!stretches[stretchOf[a]!]!.blind, startMm: mm3(P3(C, a)), endMm: mm3(P3(C, b - 1)) })),
    runsNote: 'a sac (stomach, ascending colon) is a run from its blind end to its outlet; the tube upstream ends open just outside the sac’s lumen surface. The centreline length counts every run, the blind ends included.',
    constructedCentrelineMm: mm(pathConstructed), constructedShare: Math.round((1000 * pathConstructed) / pathTotal) / 1000,
    interpolatedThroughCapsMm: mm(groupRows.reduce((s, r) => s + (r.interpolatedThroughCapsMm as number) / 1000, 0)),
    groups: groupRows,
  }
  report.smallIntestine = {
    centrelineMm: Math.round(si), duodenumMm: lengths.duodenum, jejunumMm: lengths.jejunum, ileumMm: lengths.ileum,
    constructedMm: Math.round(siConstructed), constructedShare: Math.round((1000 * siConstructed) / si) / 1000,
    interpolatedThroughCapsMm: Math.round(siRows.reduce((s, r) => s + (r.interpolatedThroughCapsMm as number), 0)),
    published: { textbookLivingMm: 3050, intraoperativeTreitzToValveMm: { mean: 5060, sd: 1050, range: [2850, 8450] }, sources: ['openstax_23_5', 'teitelbaum2013'] },
  }
  report.inventory = items.map((it) => ({ group: groups[it.group]!.key, ...it.inventory }))
  report.gaps = gapRows
  report.sphincters = sph
  report.openings = { anus }
  {
    // 喉口离消化道中心线最近的一站 / the canal station nearest the laryngeal inlet
    let k = -1
    if (head.laryngealInlet) for (let i = 0; i < N; i++) if (k < 0 || vec.dist(P3(C, i), head.laryngealInlet) < vec.dist(P3(C, k), head.laryngealInlet)) k = i
    report.head = { ...head.report, laryngealInlet: head.laryngealInlet ? { atMm: mm3(head.laryngealInlet), method: 'midway between the highest point of the epiglottis and the mean of the highest points of the arytenoid cartilages', nearestCanalStation: k, canalGroupThere: groups[grp[k]!]!.key, distanceToCentrelineMm: mm(vec.dist(P3(C, k), head.laryngealInlet)), note: 'a branch point only: no airway lumen is built here' } : null }
  }
  report.overlapShrink = {
    rule: 'where a ring point of one station lies inside the disc of another station that the bend rule does not cover, both rings give half of the overlap depth plus half of a 1 mm septum (separateRings); a ray also stops 0.4 mm outside a real lumen of the specimen. Scanned walls are not moved.',
    stations: new Set(overlapRows.map((r) => r.station)).size, rows: overlapRows.length, passes: sepRes.passes, overlapsLeft: sepRes.remaining, septumMm: mm(SEPTUM), septumAssumed: true,
    list: overlapRows,
  }
  report.bendLimit = { rule: 'per-ray plane limit over a window of 12 stations and 100° of turn, share 0.85 (limitByPlanes)', stations: limited, list: Array.from(bendCut).map((x, i) => ({ station: i, group: groups[grp[i]!]!.key, kind: KIND_NAME[kind[i]!]!, cutMm: mm(x) })).filter((r) => r.cutMm > 0) }
  report.repair = { rule: 'stations of triangles still intersecting at f = 1, at rest or at f = 0 are scaled by 0.8 per round', rounds: repairRounds, stations: repairRows.length, list: repairRows, stationPairsStillIntersecting: leftRows, intersectingPairsBeforeRepairAtFull: beforeRepair.atFull, consecutiveRingPairsCrossingBeforeRepair: beforeRepair.ringPairsCrossing }
  report.checks = {
    centrelineContinuous: { stations: N, largestStepMm: mm(maxStep), ok: maxStep < 2.5 * STEP, note: 'steps inside one run; stations are closer together at tight bends' },
    lumenSurfaceSelfIntersections: { note: 'whole canal in one mesh together with the specimen’s own lumina it meets; triangle pairs', atFull: stateCounts.full, atRest: stateCounts.rest, atEmpty: stateCounts.empty },
    consecutiveRingPairsCrossing: ringCross,
    lumenInsideWall: { state: 'f = 1', verticesTested: insideN + outsideN, inside: insideN, outside: outsideN, outsideList: outsideRows, smallestClearanceMm: mm(minClear), clearanceOverWall: { median: Math.round(median(clearRatio) * 100) / 100, p05: Math.round((clearRatio.slice().sort((x, y) => x - y)[Math.floor(clearRatio.length * 0.05)] ?? NaN) * 100) / 100 } },
    outerSurfacesUnchanged: { parts: items.length, unchanged: wallsUnchanged, note: 'the wall parts are read and never written; hashes of their vertex buffers before and after are equal' },
    teardropLoopsAtHairpins: loops, stationsMovedToRelaxKinks: kinksRelaxed, crowdedStationsDropped: stationsDropped, stationPairsWhoseCentresWerePushedApart: centresPushedApart, stationsClampedIntoTheirWall: clampedToWall, guideStationsInsideABoundingPart: guideInsideBound,
    filling: { rule: 'position(f) = stored + (f − rest)·D; f = 1 is the largest lumen the unmoving wall allows, f = 0 the tabled collapsed calibre', steps: fillingSteps, groups: fillingRows, allMonotone: fillingRows.every((r) => r.monotone) },
  }

  const context: BuildResult['context'] = items.map((it) => ({ id: it.part, mesh: it.mesh, role: groups[it.group]!.mode === 'real' ? ('real' as const) : ('wall' as const) }))
  for (const b of [...head.oralBounds, ...head.pharynxBounds]) if (!context.some((c) => c.id === b.id)) context.push({ id: b.id, mesh: b.mesh, role: 'bound' })

  // 8. 其余器官 / the other organs
  const organs: Record<string, unknown>[] = []
  const organ = async (rx: RegExp, system: string, seg: string, lumenId: string, name: string, fma: string, mode: 'sac' | 'duct'): Promise<void> => {
    const part = findPart(rx, system)
    if (!part) {
      organs.push({ organ: rx.source, result: 'no such part in this body' })
      return
    }
    const mesh = await meshOf(part.id)
    const rest = restFilling(walls, seg)
    const res = organLumen(mesh, segmentTable(walls, seg), mode, rest.filling)
    const row: Record<string, unknown> = { wall: part.id, wallName: part.name, lumen: lumenId, name, fma, fmaLabel: fmaNames?.label.get(fma) ?? null, ...res.report }
    organs.push(row)
    if (res.mesh) {
      const nv = res.mesh.positions.length / 3
      const t = segmentTable(walls, seg)
      parts.push({
        id: lumenId, name, fma, group: seg, system: system as 'urinary' | 'reproductive', mesh: res.mesh, centres: res.centres!, volumeCm3: res.volume! * 1e6, provenance: 'curated', walls: [part.id],
        composition: [{ what: { zh: `由 ${part.id} 的外表面内缩 ${mm(t.wall)} mm 得到（文献或假设的壁厚，不是扫描）`, en: `outer surface of ${part.id} offset inward by ${mm(t.wall)} mm (literature or assumed wall thickness, not scanned)` }, provenance: 'curated', source: 'soma (derived)', vertices: nv }],
        filling: { rest: rest.filling, displacement: res.displacement! }, constructed: new Uint8Array(nv), origin: new Uint8Array(nv), restState: rest,
      })
      context.push({ id: part.id, mesh, role: 'wall' })
    }
  }
  await organ(/^Urinary bladder$/, 'urinary', 'bladder', 'LUMEN_urinary_bladder', 'Cavity of urinary bladder', 'FMA15924', 'sac')
  await organ(/^Left ureter$/, 'urinary', 'ureter', 'LUMEN_ureter_L', 'Lumen of left ureter', 'FMA17610', 'duct')
  await organ(/^Right ureter$/, 'urinary', 'ureter', 'LUMEN_ureter_R', 'Lumen of right ureter', 'FMA17609', 'duct')
  if (body === 'male') {
    report.urethra = await maleUrethra(data.parts, meshOf, context)
    await organ(/^Left deferent duct$/, 'reproductive', 'vas_deferens', 'LUMEN_deferent_duct_L', 'Lumen of left deferent duct', 'FMA19273', 'duct')
    await organ(/^Right deferent duct$/, 'reproductive', 'vas_deferens', 'LUMEN_deferent_duct_R', 'Lumen of right deferent duct', 'FMA19272', 'duct')
    await organ(/^Left seminal vesicle$/, 'reproductive', 'seminal_vesicle', 'LUMEN_seminal_vesicle_L', 'Lumen of left seminal vesicle', 'FMA19401', 'duct')
    await organ(/^Right seminal vesicle$/, 'reproductive', 'seminal_vesicle', 'LUMEN_seminal_vesicle_R', 'Lumen of right seminal vesicle', 'FMA19400', 'duct')
  } else {
    report.urethra = await femaleUrethra(data.parts, meshOf)
    await organ(/^Left uterine tube$/, 'reproductive', 'uterine_tube', 'LUMEN_uterine_tube_L', 'Lumen of left uterine tube', 'FMA18467', 'duct')
    await organ(/^Right uterine tube$/, 'reproductive', 'uterine_tube', 'LUMEN_uterine_tube_R', 'Lumen of right uterine tube', 'FMA18466', 'duct')
    if (partById.has(UTEROVAGINAL_ID)) report.uterovaginal = await splitUterovaginal(await meshOf(UTEROVAGINAL_ID), parts, context)
  }
  report.organs = organs
  // 所有的腔放在一起再查一遍自交（包括标本自己的腔） / every lumen together checked once more for intersections (the specimen's own lumina included)
  {
    const list: { id: string; mesh: Mesh }[] = [...parts.map((q) => ({ id: q.id, mesh: q.mesh })), ...context.filter((c) => c.role === 'real').map((c) => ({ id: c.id, mesh: c.mesh }))]
    const merged = mergeParts(list.map((q) => q.mesh))
    const owner: string[] = []
    for (const q of list) for (let t = 0; t < q.mesh.indices.length / 3; t++) owner.push(q.id)
    const pairs: number[] = []
    const count = selfIntersections(merged, 1e9, pairs)
    const by: Record<string, number> = {}
    for (let q = 0; q < pairs.length; q += 2) {
      const key = [owner[pairs[q]!]!, owner[pairs[q + 1]!]!].sort().join(' × ')
      by[key] = (by[key] ?? 0) + 1
    }
    report.allLumina = { state: 'as stored (resting filling)', parts: list.length, triangles: merged.indices.length / 3, intersectingTrianglePairs: count, byPartPair: by }
  }
  // 源数据的发现：消化道各壁部件互相重叠（一个部件的顶点落在另一个部件里，取最深的一个到对方表面的距离）
  // a finding about the source: the wall parts of the canal overlap each other (vertices of one part inside another; the depth is the largest distance of such a vertex from the other surface)
  {
    const rows: { a: string; b: string; depthMm: number; vertices: number; consecutive: boolean }[] = []
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const A = items[i]!.inventoryBox, B = items[j]!.inventoryBox
      if (A[0]! > B[3]! || B[0]! > A[3]! || A[1]! > B[4]! || B[1]! > A[4]! || A[2]! > B[5]! || B[2]! > A[5]!) continue
      let depth = 0, verts = 0
      for (const [x, y] of [[i, j], [j, i]] as const) {
        const m = items[x]!.mesh, o = items[y]!.mesh, st = new SolidTester(o)
        for (let v = 0; v < m.positions.length; v += 3) if (st.contains(m.positions[v]!, m.positions[v + 1]!, m.positions[v + 2]!)) (verts++, (depth = Math.max(depth, distanceToMesh(o, [m.positions[v]!, m.positions[v + 1]!, m.positions[v + 2]!]))))
      }
      if (verts) rows.push({ a: items[i]!.part, b: items[j]!.part, depthMm: mm(depth), vertices: verts, consecutive: j === i + 1 })
    }
    const stat = (r: typeof rows): Record<string, unknown> => {
      const d = r.map((x) => x.depthMm).sort((p, q) => p - q)
      return { pairs: r.length, medianDepthMm: d.length ? d[d.length >> 1] : null, maxDepthMm: d.length ? d[d.length - 1] : null, deeperThan2mm: d.filter((x) => x > 2).length, deeperThan5mm: d.filter((x) => x > 5).length }
    }
    report.sourceWallOverlaps = { note: 'scanned or warped wall parts as they are in this body; nothing is moved. The lumina give way instead (overlapShrink).', consecutive: stat(rows.filter((r) => r.consecutive)), nonConsecutive: stat(rows.filter((r) => !r.consecutive)), list: rows.sort((p, q) => q.depthMm - p.depthMm) }
  }
  // 胃沿轴的外径（等值线到质心的平均距离的两倍） / outer diameter of the stomach along its axis (twice the mean distance of each level set from its centroid)
  {
    const st = items.find((it) => groups[it.group]!.key === 'stomach')!
    const sA = arcLengths(st.axis.points)
    report.stomachProfile = { part: st.part, axisMm: mm(sA[sA.length - 1]!), direction: 'from the blind (fundic) end to the pylorus', outerDiameterMmAlongAxis: Array.from(st.axis.radius, (x, i) => [mm(sA[i]!), mm(2 * x)]).slice(1, -1) }
  }
  report.proposedParts = parts.map((q) => ({ id: q.id, name: q.name, fma: q.fma, fmaLabel: fmaNames?.label.get(q.fma) ?? null, tissue: 'space', provenance: q.provenance, triangles: q.mesh.indices.length / 3, volumeCm3: Math.round(q.volumeCm3 * 10) / 10, walls: q.walls.length > 3 ? `${q.walls.length} parts` : q.walls, system: q.system, fillingRest: q.filling.rest, composition: q.composition.map((c) => `${c.provenance}:${c.vertices}`) }))
  return { report, parts, context, path: { centre: C, kind: Uint8Array.from(kind), radius: meanR, dir, inner, part: partOf, group: grp } }
}

function mergeParts(meshes: Mesh[]): Mesh {
  const nv = meshes.reduce((s, m) => s + m.positions.length, 0)
  const ni = meshes.reduce((s, m) => s + m.indices.length, 0)
  const positions = new Float32Array(nv), indices = new Uint32Array(ni)
  let vo = 0, io = 0
  for (const m of meshes) {
    positions.set(m.positions, vo)
    for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k]! + vo / 3
    vo += m.positions.length
    io += m.indices.length
  }
  return { positions, indices }
}

// ── 单个器官的腔 / the lumen of a single organ ───────────────────────────────────────────────────────

export interface OrganLumen {
  /** 静止充盈度下的面 / the surface at the resting filling */
  mesh: Mesh | null
  centres?: Float32Array
  /** 充盈位移：位置(f) = 存下来的位置 + (f − rest)·D / filling displacement: position(f) = stored + (f − rest)·D */
  displacement?: Float32Array
  volume?: number
  report: Record<string, unknown>
}

/**
 * 一个封闭器官的腔：沿它自己的中心线取截面、内缩壁厚，两端各缩进一个壁厚并封口。
 * 'duct'（细管）：内径另以表里的充盈口径为上限；外径的中位数不足 2 × 壁厚 + 塌陷口径时不建腔，只报数。
 * 得到的是 f = 1 的面（壁不动，所以这是最大的）；f = 0 时每站按比例缩到表里的塌陷口径；返回的网格在 f = rest。
 * The lumen of one closed organ: cross-sections along its own centreline, offset inward by the wall,
 * pulled in by one wall thickness at either end and closed. 'duct' (a thin tube): the inner calibre is
 * also capped at the tabled distended calibre; when the median outer diameter is below 2 × wall +
 * collapsed calibre no lumen is built and only the numbers are reported. The result is the surface at
 * f = 1 (the wall does not move, so this is the largest); at f = 0 every station is scaled to the
 * tabled collapsed calibre; the mesh returned stands at f = rest.
 */
export function organLumen(mesh: Mesh, t: SegmentTable, mode: 'sac' | 'duct', rest = 0, sides = SIDES): OrganLumen {
  const SLIT = 0.0003
  let axis: Axis
  try {
    axis = shellAxis(mesh, { step: mode === 'duct' ? 0.003 : 0.004, smooth: mode === 'sac' ? 12 : 2 })
  } catch (e) {
    return { mesh: null, report: { result: 'no lumen modelled', reason: (e as Error).message } }
  }
  const r = Array.from(axis.radius).slice(1, -1)
  const outerD = 2 * median(r)
  const need = 2 * t.wall + t.collapsed
  const base = { outerDiameterMm: { median: mm(outerD), min: mm(2 * Math.min(...r)), max: mm(2 * Math.max(...r)) }, centrelineMm: mm(axisLength(axis)), wallMm: mm(t.wall), tabledCalibreMm: [mm(t.collapsed), mm(t.distended)], neededOuterDiameterMm: mm(need), wallAssumed: t.wallAssumed, calibreAssumed: t.calibreAssumed }
  if (mode === 'duct' && outerD < need) return { mesh: null, report: { ...base, result: 'no lumen modelled', reason: 'median outer diameter is below 2 × wall + collapsed calibre' } }
  const step = mode === 'duct' ? Math.max(0.0015, Math.min(0.004, outerD)) : 0.003
  const full = resamplePolyline(axis.points, step)
  const s = arcLengths(full)
  const L = s[s.length - 1]!
  const inset = Math.min(L * 0.2, t.wall + 0.0005)
  const keep: number[] = []
  for (let i = 0; i < s.length; i++) if (s[i]! >= inset && s[i]! <= L - inset) keep.push(i)
  if (keep.length < 3) return { mesh: null, report: { ...base, result: 'no lumen modelled', reason: 'too short for its wall' } }
  const centre = new Float64Array(keep.length * 3)
  keep.forEach((i, q) => centre.set(P3(full, i), 3 * q))
  const tester = new SolidTester(mesh)
  // 中心线上落在壁外的站（细管的急弯处，平滑和取样把线拉到了外面）：沿横截面里最近进入壁的方向挪到壁的中间
  // centreline stations that fell outside the wall (tight bends of a thin duct, where smoothing and sampling pulled the line out): moved to the middle of the wall along the direction in the cross-section that enters it soonest
  let centresMoved = 0
  {
    const probe = sampleRings(null, centre, sides)
    for (let i = 0; i < probe.stations; i++) {
      const o = P3(centre, i)
      if (tester.contains(o[0], o[1], o[2])) continue
      let best = Infinity, bd: V3 | null = null, through = 0
      for (let k = 0; k < sides; k++) {
        const d = P3(probe.dir, i * sides + k)
        const h = rayNearest(mesh, o, d).distance
        if (!(h < best)) continue
        const x = rayNearest(mesh, vec.add(o, vec.mul(d, h + 1e-5)), d).distance
        if (!Number.isFinite(x)) continue
        ;(best = h), (bd = d), (through = x)
      }
      if (bd && best < 0.01) (centre.set(vec.add(o, vec.mul(bd, best + through / 2)), 3 * i), centresMoved++)
    }
  }
  const rings = sampleRings(mesh, centre, sides)
  const n = rings.stations
  let centresOutside = 0
  for (let i = 0; i < n; i++) {
    const vals = Array.from(rings.outer.subarray(i * sides, (i + 1) * sides)).filter(Number.isFinite)
    const med = vals.length ? median(vals) : t.wall
    // 中心不在壁里的站（凹的截面）收成缝 / a station whose centre is outside the wall (a concave section) collapses to a slit
    const out = !tester.contains(centre[3 * i]!, centre[3 * i + 1]!, centre[3 * i + 2]!)
    if (out) centresOutside++
    for (let k = 0; k < sides; k++) if (out || !Number.isFinite(rings.outer[i * sides + k]!)) rings.outer[i * sides + k] = out ? 0 : med
  }
  const off = offsetInward(rings.outer, rings.cos, n, sides, { wall: t.wall, slit: SLIT })
  const r1 = off.inner
  let capped = 0
  if (mode === 'duct') for (let i = 0; i < n; i++) {
    let hit = false
    for (let k = 0; k < sides; k++) if (r1[i * sides + k]! > t.distended / 2) (r1[i * sides + k] = t.distended / 2), (hit = true)
    if (hit) capped++
  }
  for (let i = 0; i < r1.length; i++) r1[i] = Math.max(Math.min(SLIT, rings.outer[i]! * 0.5 || SLIT), r1[i]!)
  const limited = limitByPlanes(r1, centre, rings.dir, sides, { floor: SLIT }).limited
  // 每个顶点都要在壁里：不在的沿射线退回 / every vertex must be inside the wall: one that is not is pulled back along its ray
  let pulled = 0
  for (let i = 0; i < n; i++) for (let k = 0; k < sides; k++) {
    const at = (rho: number): boolean => tester.contains(centre[3 * i]! + rho * rings.dir[3 * (i * sides + k)]!, centre[3 * i + 1]! + rho * rings.dir[3 * (i * sides + k) + 1]!, centre[3 * i + 2]! + rho * rings.dir[3 * (i * sides + k) + 2]!)
    let rho = r1[i * sides + k]!
    let tries = 0
    while (rho > SLIT && !at(rho) && tries++ < 8) rho *= 0.6
    if (rho < r1[i * sides + k]!) (r1[i * sides + k] = Math.max(SLIT, rho)), pulled++
  }
  const r0 = new Float64Array(r1.length)
  const mk = (rad: Float64Array): Mesh => capRings(ringsToMesh(centre, rings.dir, rad, n, sides), centre, n, sides, true, true)
  const at = (f: number): Float64Array => Float64Array.from(r1, (x, i) => r0[i]! + f * (x - r0[i]!))
  let rounds = 0, selfX = 0
  for (; rounds < 40; rounds++) {
    const cal = ringCalibre(r1, n, sides)
    for (let i = 0; i < n; i++) {
      const f = cal[i]! > t.collapsed ? t.collapsed / cal[i]! : 1
      for (let k = 0; k < sides; k++) r0[i * sides + k] = Math.min(r1[i * sides + k]!, Math.max(SLIT, r1[i * sides + k]! * f))
    }
    const bad = new Set<number>()
    selfX = 0
    for (const f of [1, rest, 0]) {
      const pairs: number[] = []
      selfX += selfIntersections(mk(at(f)), 1e6, pairs)
      for (const tr of pairs) if (tr < 2 * sides * (n - 1)) (bad.add(Math.floor(tr / (2 * sides))), bad.add(Math.min(n - 1, Math.floor(tr / (2 * sides)) + 1)))
        else bad.add(tr < 2 * sides * (n - 1) + sides ? 0 : n - 1)
    }
    if (!selfX) break
    for (const i of bad) for (let k = 0; k < sides; k++) r1[i * sides + k] = Math.max(SLIT, r1[i * sides + k]! * 0.8)
  }
  const closed = mk(at(rest))
  const fullMesh = mk(r1)
  const nv = closed.positions.length / 3
  const centres = new Float32Array(nv * 3)
  const displacement = new Float32Array(nv * 3)
  for (let v = 0; v < nv; v++) {
    centres.set(P3(centre, v < n * sides ? Math.floor(v / sides) : v === n * sides ? 0 : n - 1), 3 * v)
    if (v < n * sides) for (let q = 0; q < 3; q++) displacement[3 * v + q] = (r1[v]! - r0[v]!) * rings.dir[3 * v + q]!
  }
  const cal = ringCalibre(r1, n, sides)
  const calRest = ringCalibre(at(rest), n, sides)
  let inside = 0, minClear = Infinity
  for (let v = 0; v < n * sides; v++) {
    const q = P3(fullMesh.positions, v)
    if (tester.contains(q[0], q[1], q[2])) inside++
    minClear = Math.min(minClear, distanceToMesh(mesh, q))
  }
  const vols = [0, 0.25, 0.5, 0.75, 1].map((f) => ringVolume(centre, rings.dir, at(f), n, sides))
  const volume = ringVolume(centre, rings.dir, at(rest), n, sides)
  const mean = (x: ArrayLike<number>): number => Array.from(x).reduce((a, b) => a + b, 0) / x.length
  const checks = { selfIntersectionsAtFullRestEmpty: selfX, repairRounds: rounds, insideWallAtFull: { vertices: n * sides, inside, smallestClearanceMm: mm(minClear) }, stationsMovedBackIntoWall: centresMoved, stationsWithCentreOutsideWall: centresOutside, verticesPulledBackIntoWall: pulled, collapsedStations: off.collapsedStations, stations: n }
  // 推出的面没通过检查（还有自交，或有顶点不在壁内）就不给腔，只报数
  // a derived surface that fails its checks (still self-intersecting, or a vertex outside the wall) is not offered; only the numbers are reported
  if (selfX > 0 || inside < n * sides) return { mesh: null, report: { ...base, result: 'no lumen modelled', reason: 'the derived surface failed its checks', ...checks } }
  return {
    mesh: closed, centres, displacement, volume,
    report: {
      ...base, result: 'lumen modelled', triangles: closed.indices.length / 3, volumeCm3: { rest: Math.round(volume * 1e8) / 100, atF: vols.map((v) => Math.round(v * 1e8) / 100), monotone: vols.every((v, q) => q === 0 || v >= vols[q - 1]! - 1e-12) }, wallVolumeCm3: Math.round((signedVolume(mesh) - vols[4]!) * 1e8) / 100,
      calibreMm: { full: { mean: mm(mean(cal)), min: mm(Math.min(...cal)), max: mm(Math.max(...cal)) }, rest: { mean: mm(mean(calRest)) } }, restFilling: rest, stationsCappedAtDistendedCalibre: capped, stationsLimitedAtBends: limited, ...checks,
    },
  }
}

// ── 尿道 / the urethra ───────────────────────────────────────────────────────────────────────────────

/**
 * 男性：名为 Urethra 的部件是一条 1.6–2.1 mm 粗的实心线，本身就是腔那么粗，所以把它当作静止状态的尿道腔，不另建。
 * 这里沿它的中心线每 2 mm 查一次它在哪个部件里（膀胱、前列腺、尿道海绵体、阴茎海绵体），把各段报出来。
 * Male: the part named Urethra is a solid thread 1.6–2.1 mm thick, itself the size of a lumen, so it is
 * taken as the urethral lumen at rest and no other is built. Its centreline is tested every 2 mm for
 * the part it lies in (bladder, prostate, corpus spongiosum, corpus cavernosum) and the stretches reported.
 */
async function maleUrethra(all: Part[], meshOf: (id: string) => Promise<Mesh>, context: BuildResult['context']): Promise<Record<string, unknown>> {
  const by = (rx: RegExp): Part | undefined => all.find((q) => rx.test(q.name))
  const u = by(/^Urethra$/)
  if (!u) return { result: 'no part named Urethra' }
  const mesh = await meshOf(u.id)
  context.push({ id: u.id, mesh, role: 'real' })
  let axis = shellAxis(mesh, { step: 0.003, smooth: 2 })
  if (axisPoint(axis, 0)[1] < axisPoint(axis, axisCount(axis) - 1)[1]) axis = reverseAxis(axis)
  const pts = resamplePolyline(axis.points, 0.002)
  const s = arcLengths(pts)
  const r = Array.from(axis.radius).slice(1, -1)
  const around: [string, RegExp][] = [['bladder', /^Urinary bladder$/], ['prostate', /^Prostate$/], ['corpus spongiosum', /^Corpus spongiosum of penis$/], ['corpus cavernosum', /^Corpus cavernosum of penis$/]]
  const hosts: { key: string; id: string; mesh: Mesh; solid: SolidTester }[] = []
  for (const [key, rx] of around) {
    const p = by(rx)
    if (!p) continue
    const m = await meshOf(p.id)
    hosts.push({ key, id: p.id, mesh: m, solid: new SolidTester(m) })
    if (key !== 'bladder') context.push({ id: p.id, mesh: m, role: 'bound' })
  }
  const stretches: { fromMm: number; toMm: number; inside: string; farthestFromProstateOrSpongiosumMm?: number }[] = []
  for (let i = 0; i < pts.length / 3; i++) {
    const q = P3(pts, i)
    const inn = hosts.filter((h) => h.solid.contains(q[0], q[1], q[2])).map((h) => h.key).join(' + ') || 'none of them'
    const last = stretches[stretches.length - 1]
    if (last && last.inside === inn) last.toMm = mm(s[i]!)
    else stretches.push({ fromMm: mm(s[i]!), toMm: mm(s[i]!), inside: inn })
    if (inn === 'none of them') {
      const d = Math.min(...hosts.filter((h) => h.key === 'prostate' || h.key === 'corpus spongiosum').map((h) => distanceToMesh(h.mesh, q)))
      const cur = stretches[stretches.length - 1]!
      cur.farthestFromProstateOrSpongiosumMm = Math.max(cur.farthestFromProstateOrSpongiosumMm ?? 0, mm(d))
    }
  }
  return {
    part: u.id, name: u.name, fma: u.fma, closedSolid: topology(mesh).watertight, lengthMm: mm(axisLength(axis)), volumeMm3: Math.round(signedVolume(mesh) * 1e9),
    diameterMm: { min: mm(2 * Math.min(...r)), median: mm(2 * median(r)), max: mm(2 * Math.max(...r)) },
    decision: 'FJ3148 is lumen-sized (1.6–2.1 mm): far below the voiding calibre of 6 mm or more at the bladder outlet (Manoliu 1982, abstract) and too thin to hold a wall on either side. It is taken as the urethral lumen at rest; no LUMEN_urethra is derived from it and no filling field is given, since this body has no urethral wall part to bound a wider lumen.',
    restingCalibreSource: 'none found: the searches made returned no measured resting calibre; the tabled collapsed calibre stays an assumption',
    courseFromBladderEnd: stretches,
    hosts: hosts.map((h) => h.id),
  }
}

/**
 * 女性：标本有“尿道黏膜下层”，没有腔部件。这个壳的上段是薄壁的管，里面有一个孔；这里量出孔和实心段各有多长。
 * Female: the specimen has a "submucous layer of urethra" and no lumen part. The upper stretch of that
 * shell is a thin-walled tube with a bore; the lengths of the bore and of the solid stretch are measured here.
 */
async function femaleUrethra(all: Part[], meshOf: (id: string) => Promise<Mesh>): Promise<Record<string, unknown>> {
  const p = all.find((q) => /^Submucous layer of female urethra$/.test(q.name))
  if (!p) return { result: 'no submucous layer part' }
  const mesh = await meshOf(p.id)
  const axis = shellAxis(mesh, { step: 0.003, smooth: 2 })
  const solid = new SolidTester(mesh)
  const f = transportFrames(axis.points)
  const n = axisCount(axis)
  const bore: { yMm: number; boreRadiusMm: [number, number] }[] = []
  const ys: number[] = []
  let solidStations = 0
  for (let i = 1; i < n - 1; i++) {
    const o = axisPoint(axis, i)
    ys.push(o[1])
    if (solid.contains(o[0], o[1], o[2])) {
      solidStations++
      continue
    }
    // 截面中心在实体之外而四周都有壁：孔 / the centre of the section is outside the solid with wall all round it: the bore
    const ds: number[] = []
    for (let k = 0; k < 16; k++) {
      const a = (Math.PI * k) / 8
      const d: V3 = [0, 1, 2].map((q) => Math.cos(a) * f.u[3 * i + q]! + Math.sin(a) * f.v[3 * i + q]!) as V3
      const h = rayNearest(mesh, o, d).distance
      if (Number.isFinite(h)) ds.push(h)
    }
    if (ds.length === 16) bore.push({ yMm: mm(o[1]), boreRadiusMm: [mm(Math.min(...ds)), mm(Math.max(...ds))] })
  }
  const by = bore.map((b) => b.yMm)
  return {
    part: p.id, name: p.name, closedSolid: topology(mesh).watertight, extentYMm: [mm(Math.min(...ys)), mm(Math.max(...ys))],
    bore: bore.length ? { fromYMm: Math.min(...by), toYMm: Math.max(...by), lengthMm: Math.round((Math.max(...by) - Math.min(...by)) * 10) / 10, radiusMm: [Math.min(...bore.map((b) => b.boreRadiusMm[0])), Math.max(...bore.map((b) => b.boreRadiusMm[1]))], stations: bore.length } : null,
    solidStations,
    missing: [
      'a lumen part: the specimen names none for the urethra',
      'a lumen in the lower stretch: below the bore the shell is solid down to the external orifice',
      'the mucosa and any wall part named urethra: only the submucous layer and the sphincter muscles are present',
      'a checked join between the bore’s upper opening and the cavity of the bladder (the bladder comes from another dataset)',
    ],
    whatCouldBeDone: 'the bore is real specimen surface and could be offered as the lumen of the upper urethra by keeping the triangles of the shell that face it; that was not done here',
  }
}

// ── 女性标本的子宫与阴道腔 / the specimen's uterine and vaginal lumen ────────────────────────────────

/**
 * 把标本的“子宫与阴道腔”沿它自己的中心线分成宫腔、宫颈管、阴道腔三片：顶点不动，每个三角形按它在标量场上的位置
 * 归到一片，不切三角形、不加盖。内口 = 外口以上两个隆起之间半径最小处；外口 = 从宫底起半径第一次超过全长最大半径一半之处。
 * Split the specimen's "uterine and vaginal lumen" along its own centreline into uterine cavity,
 * cervical canal and vaginal lumen: vertices are not moved, each triangle goes to one piece by its
 * place in the scalar field, no triangle is cut and no cap is added. Internal os = the narrowest
 * station between the two bulges above the external os; external os = the first station from the
 * fundus whose radius exceeds half the largest radius of the whole lumen.
 */
async function splitUterovaginal(mesh: Mesh, parts: LumenPartOut[], context: BuildResult['context']): Promise<Record<string, unknown>> {
  let axis = shellAxis(mesh, { step: 0.004 })
  // 宫底在上 / the fundus is the upper end
  if (axisPoint(axis, 0)[1] < axisPoint(axis, axisCount(axis) - 1)[1]) axis = reverseAxis(axis)
  const n = axisCount(axis)
  const s = arcLengths(axis.points)
  const r = axis.radius
  // 外口：从宫底起第一处半径超过全长最大半径一半的地方（宫颈管到阴道的突然变宽）
  // external os: the first station from the fundus whose radius exceeds half the largest radius of the whole lumen (the abrupt widening from cervical canal to vagina)
  let ext = -1
  const rMax = Math.max(...Array.from(r))
  for (let i = 4; i < n - 3; i++) if (r[i]! > 0.5 * rMax) {
    ext = i
    break
  }
  if (ext < 0) return { split: false, reason: 'no abrupt widening found along the lumen; kept whole' }
  // 内口：外口之前的两个隆起之间的最窄处 / internal os: the narrowest station between the two bulges before the external os
  let peak1 = 1
  for (let i = 1; i < Math.floor(ext / 2); i++) if (r[i]! > r[peak1]!) peak1 = i
  let peak2 = ext - 1
  for (let i = Math.floor(ext / 2); i < ext; i++) if (r[i]! > r[peak2]!) peak2 = i
  let int = peak1
  for (let i = peak1; i <= peak2; i++) if (r[i]! < r[int]!) int = i
  if (!(int > peak1 && int < peak2)) return { split: false, reason: 'no narrowing between two bulges above the external os; kept whole' }
  const tInt = axis.stationT[int]!, tExt = (axis.stationT[ext - 1]! + axis.stationT[ext]!) / 2
  const pieces: number[][] = [[], [], []]
  for (let tr = 0; tr < mesh.indices.length; tr += 3) {
    const tv = (axis.vertexT[mesh.indices[tr]!]! + axis.vertexT[mesh.indices[tr + 1]!]! + axis.vertexT[mesh.indices[tr + 2]!]!) / 3
    pieces[tv < tInt ? 0 : tv < tExt ? 1 : 2]!.push(mesh.indices[tr]!, mesh.indices[tr + 1]!, mesh.indices[tr + 2]!)
  }
  const defs = [
    { id: 'WU_uterine_cavity', name: 'Cavity of uterus', fma: 'FMA17745', seg: 'uterine_cavity' },
    { id: 'WU_cervical_canal', name: 'Lumen of uterine cervix', fma: 'FMA302971', seg: 'cervical_canal' },
    { id: 'WU_vaginal_lumen', name: 'Lumen of vagina', fma: 'FMA19982', seg: 'vagina' },
  ]
  const walls = loadWalls()
  const out: Record<string, unknown>[] = []
  const bounds = [0, int, ext, n - 1]
  for (let q = 0; q < 3; q++) {
    const used = new Map<number, number>()
    const pos: number[] = [], idx: number[] = [], ctr: number[] = []
    for (const v of pieces[q]!) {
      if (!used.has(v)) {
        used.set(v, pos.length / 3)
        pos.push(mesh.positions[3 * v]!, mesh.positions[3 * v + 1]!, mesh.positions[3 * v + 2]!)
        // 该顶点的中心线点：标量场值最近的站 / the centreline point of the vertex: the station with the nearest field value
        let b = 0
        for (let i = 0; i < n; i++) if (Math.abs(axis.stationT[i]! - axis.vertexT[v]!) < Math.abs(axis.stationT[b]! - axis.vertexT[v]!)) b = i
        ctr.push(...axisPoint(axis, b))
      }
      idx.push(used.get(v)!)
    }
    const m: Mesh = { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
    const rr = Array.from(r.subarray(bounds[q]!, bounds[q + 1]! + 1)).filter((x) => x > 0)
    const t = segmentTable(walls, defs[q]!.seg)
    const restCal = 2 * (rr.reduce((a, b) => a + b, 0) / Math.max(1, rr.length))
    const lengthMm = mm(s[bounds[q + 1]!]! - s[bounds[q]!]!)
    out.push({ ...defs[q], triangles: idx.length / 3, lengthMm, meanDiameterMm: mm(restCal), maxWidthMm: mm(2 * Math.max(...Array.from(axis.rmax.subarray(bounds[q]!, bounds[q + 1]! + 1)))), open: true })
    void t
    void restCal
    // 标本自己的腔面：不给充盈位移（没有检查过它的壁能让它涨到哪里），静止状态就是扫描到的状态
    // the specimen's own lumen surface: no filling displacement (how far its wall would let it distend was not checked); the resting state is the scanned state
    parts.push({
      id: defs[q]!.id, name: defs[q]!.name, fma: defs[q]!.fma, group: defs[q]!.seg, system: 'reproductive', mesh: m, centres: Float32Array.from(ctr), volumeCm3: NaN, provenance: 'curated', walls: [],
      composition: [{ what: { zh: '标本自己的腔面（Wu 等 2015），顶点未动，只按中心线分片', en: 'the specimen’s own lumen surface (Wu et al. 2015), vertices untouched, only split along its centreline' }, provenance: 'curated', source: 'Wu et al. 2015 pelvic floor', vertices: pos.length / 3 }],
      filling: { rest: 0, displacement: new Float32Array(pos.length) }, constructed: new Uint8Array(pos.length / 3), origin: new Uint8Array(pos.length / 3).fill(3), restState: { filling: 0, state: 'as scanned', assumption: false, source: 'Wu et al. 2015 pelvic floor' },
    })
  }
  void context
  return {
    split: true, method: 'triangles assigned by the level-set field of the lumen’s own centreline; no vertex moved, no triangle cut, pieces are open where they meet',
    internalOs: { atMm: mm3(axisPoint(axis, int)), fromFundusMm: mm(s[int]!), radiusMm: mm(r[int]!) },
    externalOs: { atMm: mm3(axisPoint(axis, ext)), fromFundusMm: mm(s[ext]!), radiusBeforeMm: mm(r[ext - 1]!), radiusAfterMm: mm(r[ext]!) },
    pieces: out, wholeVolumeCm3: Math.round(signedVolume(mesh) * 1e7) / 10,
  }
}

// ── 口端的开口规格 / the oral opening ────────────────────────────────────────────────────────────────

/** 读开口后的皮肤包的清单和 OBJ（只读），给出唇裂和口腔袋的位置与大小。 / Reads the opened skin package (manifest and OBJ, read-only) and gives the place and size of the lip aperture and the oral pouch. */
export function oralOpening(body: 'male' | 'female', canalStart: V3): Record<string, unknown> {
  const dir = join(ROOT, 'data/raw/bodyshape/out', `${body}-skin-open`)
  const manifestPath = join(dir, 'manifest.json'), objPath = join(dir, 'skin.obj')
  if (!existsSync(manifestPath) || !existsSync(objPath)) return { found: false, note: 'opened skin package not present; nothing read' }
  const man = JSON.parse(readFileSync(manifestPath, 'utf8')) as { face: { margins: { upperLip: number[]; lowerLip: number[] }; constructionAids: { oralPouch: { upper: number[]; lower: number[]; seam?: number[]; rows?: number; columns?: number } } } }
  const verts: number[] = []
  for (const line of readFileSync(objPath, 'utf8').split('\n')) if (line.startsWith('v ')) {
    const f = line.split(/\s+/)
    verts.push(Number(f[1]), Number(f[2]), Number(f[3]))
  }
  const box = (ids: number[]): { min: V3; max: V3; c: V3 } => {
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity], c: V3 = [0, 0, 0]
    for (const v of ids) for (let q = 0; q < 3; q++) {
      const x = verts[3 * v + q]!
      lo[q] = Math.min(lo[q]!, x)
      hi[q] = Math.max(hi[q]!, x)
      c[q] = c[q]! + x / ids.length
    }
    return { min: lo, max: hi, c }
  }
  const lips = box([...man.face.margins.upperLip, ...man.face.margins.lowerLip])
  const pouchIds = [...man.face.constructionAids.oralPouch.upper, ...man.face.constructionAids.oralPouch.lower]
  const pouch = box(pouchIds)
  // 口腔袋最深的一圈：z 在最小值 2 mm 之内的顶点 / the deepest ring of the pouch: vertices within 2 mm of its smallest z
  const deep = box(pouchIds.filter((v) => verts[3 * v + 2]! < pouch.min[2] + 0.002))
  return {
    found: true, frame: 'metres in the package, reported here in mm; Y up, +Z anterior, +X left',
    lipAperture: { centreMm: mm3(lips.c), widthMm: mm(lips.max[0] - lips.min[0]), heightMm: mm(lips.max[1] - lips.min[1]), vertices: man.face.margins.upperLip.length + man.face.margins.lowerLip.length },
    oralPouch: { vertices: pouchIds.length, rows: man.face.constructionAids.oralPouch.rows ?? null, columns: man.face.constructionAids.oralPouch.columns ?? null, bboxMinMm: mm3(pouch.min), bboxMaxMm: mm3(pouch.max), depthMm: mm(pouch.max[2] - pouch.min[2]) },
    pouchBackWall: { centreMm: mm3(deep.c), widthMm: mm(deep.max[0] - deep.min[0]), heightMm: mm(deep.max[1] - deep.min[1]) },
    canalStartMm: mm3(canalStart), canalStartToLipApertureMm: mm(vec.dist(canalStart, lips.c)), canalStartToPouchBackWallMm: mm(vec.dist(canalStart, deep.c)),
  }
}

// ── 渲染 / renders ───────────────────────────────────────────────────────────────────────────────────

const COLOURS: Record<string, Rgb> = { derived: [40, 150, 160], constructed: [225, 40, 150], bounded: [70, 90, 220], real: [70, 170, 70], wall: [200, 196, 188], bound: [215, 200, 150], organ: [235, 150, 40] }

/**
 * 渲染。颜色：青 = 由壁推出；洋红 = 构造；蓝 = 以真实部件为界（口、咽）；绿 = 标本自己的腔；橙 = 泌尿生殖器官的腔；
 * 灰 = 壁，米色 = 口咽周围定界的部件。`-full` 是 f = 1（壁所允许的最大），`-rest` 是存下来的静止状态。
 * Renders. Colours: teal = derived from a wall; magenta = construction; blue = bounded by real parts
 * (mouth, pharynx); green = the specimen's own lumen; orange = lumina of urinary and genital organs;
 * grey = walls, beige = the parts bounding mouth and pharynx. `-full` is f = 1 (the largest the wall
 * allows), `-rest` the stored resting state.
 */
function renderAll(res: BuildResult, outDir: string): string[] {
  const files: string[] = []
  const item = (q: LumenPartOut, f: number | null): RenderItem => {
    const nv = q.mesh.positions.length / 3
    const vc = new Uint8Array(nv * 3)
    const base = q.system === 'digestive' ? COLOURS.derived! : COLOURS.organ!
    for (let v = 0; v < nv; v++) vc.set(q.origin[v] === 1 ? COLOURS.constructed! : q.origin[v] === 2 ? COLOURS.bounded! : q.origin[v] === 3 ? COLOURS.real! : base, 3 * v)
    const positions = f === null ? q.mesh.positions : Float32Array.from(q.mesh.positions, (x, i) => x + (f - q.filling.rest) * q.filling.displacement[i]!)
    return { positions, indices: q.mesh.indices, color: base, vertexColors: vc }
  }
  const ctx = (role: string, colour: Rgb): RenderItem[] => res.context.filter((c) => c.role === role).map((c) => ({ positions: c.mesh.positions, indices: c.mesh.indices, color: colour }))
  const realItems = ctx('real', COLOURS.real!), wallItems = ctx('wall', COLOURS.wall!), boundItems = ctx('bound', COLOURS.bound!)
  const full = [...res.parts.map((q) => item(q, 1)), ...realItems], rest = [...res.parts.map((q) => item(q, null)), ...realItems]
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity]
  for (const it of full) for (let i = 0; i < it.positions.length; i += 3) for (let q = 0; q < 3; q++) (lo[q] = Math.min(lo[q]!, it.positions[i + q]!)), (hi[q] = Math.max(hi[q]!, it.positions[i + q]!))
  const c: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const view = (yaw: number, half: number, centre: V3 = c, w = 520, h = 1100, pitch = 0, slab?: [number, number]): View => ({ yaw, pitch, center: centre, halfHeight: half, width: w, height: h, slab })
  const half = (hi[1] - lo[1]) / 2 + 0.02
  const save = (name: string, images: ReturnType<typeof render>[], columns: number): void => {
    sheet(images, columns).save(join(outDir, name))
    files.push(name)
  }
  save('canal-full.png', [0, 90, 180, -90].map((yaw) => render(full, view(yaw, half))), 4)
  save('canal-rest.png', [0, 90, 180, -90].map((yaw) => render(rest, view(yaw, half))), 4)
  // 腹部近景 / the abdomen closer
  const abd: V3 = [c[0], lo[1] + (hi[1] - lo[1]) * 0.33, c[2]]
  save('abdomen.png', [render(full, view(0, 0.2, abd, 900, 900)), render(full, view(90, 0.2, abd, 900, 900)), render(rest, view(0, 0.2, abd, 900, 900))], 3)
  // 口与咽：左侧观、正中矢状薄片（连同定界的部件）、前面观 / mouth and pharynx: from the left, a midsagittal slab (with the bounding parts) and from the front
  const top: V3 = [res.path.centre[0]!, hi[1] - 0.075, c[2] + 0.02]
  top[2] = (res.path.centre[2]! + res.path.centre[2]! - 0.1) / 2
  const headLumen = full.slice(0, 3)
  save('mouth-pharynx.png', [
    render(headLumen, view(90, 0.085, top, 760, 760)),
    render([...boundItems, ...headLumen], view(90, 0.085, top, 760, 760, 0, [-0.0015, 0.0015]), [20, 20, 24]),
    render(headLumen, view(0, 0.085, top, 760, 760)),
    render([...boundItems, ...headLumen], view(0, 0.06, [top[0], top[1] + 0.01, top[2]], 760, 760, 90, [-0.0015, 0.0015]), [20, 20, 24]),
  ], 2)
  const bottom: V3 = [c[0], lo[1] + 0.08, c[2]]
  save('pelvis.png', [render(full, view(90, 0.11, bottom, 700, 700)), render(full, view(0, 0.11, bottom, 700, 700)), render([...wallItems, ...boundItems.filter(() => false), ...full], view(90, 0.11, bottom, 700, 700, 0, [-0.0015, 0.0015]), [20, 20, 24])], 3)
  // 断面：壁（灰）和腔，水平薄片，从上往下看 / sections: wall (grey) and lumen, thin axial slabs seen from above
  const levels = [0.8, 0.62, 0.5, 0.42, 0.36, 0.28, 0.22, 0.1].map((f) => lo[1] + (hi[1] - lo[1]) * f)
  save('sections-axial-full.png', levels.map((y) => render([...wallItems, ...full], view(0, 0.12, [c[0], y, c[2]], 640, 640, 90, [-0.0012, 0.0012]), [20, 20, 24])), 4)
  save('sections-axial-rest.png', levels.map((y) => render([...wallItems, ...rest], view(0, 0.12, [c[0], y, c[2]], 640, 640, 90, [-0.0012, 0.0012]), [20, 20, 24])), 4)
  save('sections-midplanes.png', [render([...wallItems, ...boundItems, ...full], view(90, half, c, 520, 1100, 0, [-0.0015, 0.0015]), [20, 20, 24]), render([...wallItems, ...full], view(0, half, c, 520, 1100, 0, [-0.0015, 0.0015]), [20, 20, 24])], 2)
  return files
}

// ── 命令行 / command line ────────────────────────────────────────────────────────────────────────────

export async function runLumenCli(argv: string[]): Promise<void> {
  const body = argv[0]
  const o = argv.indexOf('--out')
  if ((body !== 'male' && body !== 'female') || o < 0 || !argv[o + 1]) {
    console.error('usage: bun tools/pipeline/lumen.ts <male|female> --out <scratch dir>')
    process.exit(2)
  }
  const outDir = join(argv[o + 1]!, body)
  if (/[\\/]public[\\/]/.test(join(process.cwd(), outDir))) throw new Error('refusing to write under public/')
  mkdirSync(outDir, { recursive: true })
  const res = await buildLumen(body)
  ;(res.report.openings as Record<string, unknown>).oral = oralOpening(body, P3(res.path.centre, 0))
  await writeSystemGlb(join(outDir, 'lumen.glb'), 'lumen', '#2896a0', res.parts.map((q) => ({ id: q.id, positions: q.mesh.positions, normals: computeNormals(q.mesh), indices: q.mesh.indices })))
  // 充盈位移场，按 GLB 顶点次序（与构建里要写的那份相同，见 lumenStage.ts） / the filling field in GLB vertex order (the same as a build would write, see lumenStage.ts)
  const { fillingSidecar, lumenCautions } = await import('./lumenStage.ts')
  const side = await fillingSidecar(res.parts.map((q) => ({ id: q.id, mesh: q.mesh, filling: { rest: q.filling.rest, displacement: q.filling.displacement, restState: q.restState } })))
  writeFileSync(join(outDir, 'filling.bin'), side.bin)
  res.report.filling = { ...side.index, file: 'filling.bin' }
  res.report.cautions = lumenCautions(body, res.report, [])
  writeFileSync(join(outDir, 'centreline.json'), JSON.stringify({ points: Array.from(res.path.centre, (x) => Math.round(x * 1e5) / 1e5), kind: Array.from(res.path.kind), kinds: KIND_NAME, radius: Array.from(res.path.radius, (x) => Math.round(x * 1e5) / 1e5) }))
  res.report.renders = renderAll(res, outDir)
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(res.report, null, 1))
  const canal = res.report.canal as { totalCentrelineMm: number; constructedShare: number }
  console.log(`${body}: canal ${canal.totalCentrelineMm} mm, constructed share ${canal.constructedShare}; ${res.parts.length} lumen parts → ${outDir}`)
}
