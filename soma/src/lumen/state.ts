// "腔"显示的界面状态和数据：模式、充盈、漫游，以及 lumen-filling / lumen-path 的加载。独立的小 store，不放进主 store。
// UI state and data of the lumina display: mode, filling, fly-through, and the loading of lumen-filling /
// lumen-path. A small store of its own, kept out of the main store.
//
// 地址参数 / URL parameters（见 README 的参数表 / see the table in the README）
//   lumen  1                         打开"腔"显示   the lumina display
//   fill   0.5 | 0.5,<部件>:1         全局充盈控制量，和个别部件自己的充盈度   the global filling control and per-part fillings
//   fly    <段名|部件 id> | <毫米>     内镜漫游：从某一段开始播放，或停在某个距离   fly-through: play from a segment, or hold at a distance
// 它们不在 urlState.ts 的参数表里，按"其他参数原样保留"的规则走：这里解析，并通过 urlSync 的 setPassthroughParam 写回。
// They are not in urlState.ts's table and travel as "other parameters pass through": parsed here and written
// back through setPassthroughParam of urlSync.

import { create } from 'zustand'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import { useApp } from '../state/store.ts'
import { fetchJson } from '../anatomy/load.ts'
import {
  ORIGIN_BOUNDED,
  ORIGIN_DERIVED,
  applyFilling,
  clamp01,
  closedVolume,
  formatLumenParams,
  isZeroDisplacement,
  originOf,
  parseLumenParams,
  partFilling,
  segmentKey,
  type FillingEntry,
  type OriginSummary,
  type V3,
} from './core.ts'

/** tools/lumenview/extract.ts 写出的文件 / the file written by tools/lumenview/extract.ts */
export interface LumenPathFile {
  schema: number
  canal: string[]
  walls: Record<string, string[]>
  guides: Record<string, V3[]>
  sphincters?: { id: string; atMm: V3 }[]
}

export interface LumenData {
  body: string
  entries: Map<string, FillingEntry>
  bin: Float32Array
  /** 没有 lumen-path.json 时为 null：没有漫游，壁按"同系统的器官"处理 / null without lumen-path.json: no fly-through, and walls fall back to "organs of the same system" */
  path: LumenPathFile | null
  /** 所有腔的壁部件 / the wall parts of all lumina */
  walls: ReadonlySet<string>
  /** 这副人体里的腔：推导出来的（有充盈数据）和标本自己的（没有）/ this body's lumina: derived (with filling data) and the specimen's own (without) */
  derived: readonly string[]
  real: readonly string[]
  origin: ReadonlyMap<string, OriginSummary>
}

/** 漫游的默认速度（米每秒）和可选的倍率 / Default fly-through speed (metres per second) and the multipliers offered. */
export const FLY_SPEED = 0.03
export const FLY_SPEEDS = [0.5, 1, 2, 4]
/**
 * 漫游时的两条规则（界面和 README 里都写明）：消化道各段的充盈度至少取这个值（全局，不是只在相机附近）；
 * 仍然窄于这个半径的地方按圈心撑开到这个半径（只为看得见）。
 * The two rules of the fly-through (stated in the UI and the README): every segment of the canal is filled
 * to at least this much (globally, not just near the camera); and what is still narrower than this radius is
 * widened about its ring centres to this radius (only so that it can be seen).
 */
export const FLY_MIN_FILL = 0.5
export const FLY_MIN_RADIUS = 0.003

export type LumenStatus = 'idle' | 'loading' | 'ready' | 'none' | 'error'

export interface LumenState {
  mode: boolean
  /** 链接要求"只看消化道"，数据到了之后执行一次 / the link asked for the canal alone; carried out once when the data is there */
  canalPending: boolean
  fill: number
  overrides: Record<string, number>
  /** 漫游：null 为关 / the fly-through: null = off */
  fly: { playing: boolean; speed: number; reverse: boolean } | null
  /** 漫游从哪里开始（段名、部件 id 或毫米数），由查看器取走 / where the fly-through starts (segment key, part id or millimetres); consumed by the viewer */
  flyStart: string | number | null
  /** 查看器报告的当前位置（米）、全长和所在的段 / reported by the viewer: position (metres), total length and the segment it is in */
  flyS: number
  flyTotal: number
  flySegment: string | null
  flyRadius: number
  seek: { nonce: number; s: number }
  status: LumenStatus
  message: string
  data: LumenData | null
  /** 查看器登记了新的腔几何时加一（体积读数据此重算）/ bumped when the viewer registers lumen geometry (volume readouts recompute on it) */
  geometryTick: number
  setMode(on: boolean): void
  setFill(g: number): void
  setOverride(part: string, f: number | null): void
  startFly(at?: string | number): void
  stopFly(): void
  setFly(patch: Partial<{ playing: boolean; speed: number; reverse: boolean }>): void
  seekFly(s: number): void
}

let writeParam: ((key: string, value: string | null) => void) | null = null
/** 由界面注册：把一个参数写回地址栏 / Registered by the UI: writes one parameter back to the address bar. */
export function registerLumenUrlWriter(fn: (key: string, value: string | null) => void): void {
  writeParam = fn
}

const initial = parseLumenParams(typeof location === 'undefined' ? '' : location.search)
if (typeof console !== 'undefined') for (const w of initial.warnings) console.warn(`[soma] URL: ${w}`)

function writeUrl(s: LumenState): void {
  if (!writeParam) return
  // 播放时写起点（链接打开后从那里播），停住时写当前的毫米数 / while playing the start is written (a link plays from there); when held, the millimetres reached
  const fly = s.fly ? { at: s.fly.playing && s.flyStart !== null ? s.flyStart : Math.round(s.flyS * 1000) } : null
  // 主 store 里隔离的还是"只看消化道"设的那一组时，写 lumen=canal / lumen=canal while the main store still isolates the set the canal view put there
  const canal = s.canalPending || (canalSet !== null && useApp.getState().isolated === canalSet)
  const out = formatLumenParams({ mode: s.mode, canal, fill: s.fill, overrides: s.overrides, fly })
  writeParam('lumen', out.lumen)
  writeParam('fill', out.fill)
  writeParam('fly', out.fly)
}

let canalSet: ReadonlySet<string> | null = null

export const useLumen = create<LumenState>((set, get) => ({
  mode: initial.params.mode,
  canalPending: initial.params.canal,
  fill: initial.params.fill,
  overrides: initial.params.overrides,
  // 链接里是毫米数：停在那里；是段名：从那里播放 / a number of millimetres in the link holds there; a segment name plays from it
  fly: initial.params.fly ? { playing: typeof initial.params.fly.at !== 'number' || initial.params.fly.at === 0, speed: 1, reverse: false } : null,
  flyStart: initial.params.fly ? initial.params.fly.at : null,
  flyS: typeof initial.params.fly?.at === 'number' ? initial.params.fly.at / 1000 : 0,
  flyTotal: 0,
  flySegment: null,
  flyRadius: 0,
  seek: { nonce: 0, s: 0 },
  status: 'idle',
  message: '',
  data: null,
  geometryTick: 0,
  setMode: (mode) => {
    set(mode ? { mode } : { mode, fly: null, flyStart: null })
    writeUrl(get())
  },
  setFill: (g) => {
    set({ fill: clamp01(g) })
    writeUrl(get())
  },
  setOverride: (part, f) => {
    const overrides = { ...get().overrides }
    if (f === null) delete overrides[part]
    else overrides[part] = clamp01(f)
    set({ overrides })
    writeUrl(get())
  },
  startFly: (at = 0) => {
    // 数据已经到了而这副人体没有路径（女性现在如此）：不进漫游 / the data is here and this body has no path (the female at present): no fly-through
    const st = get()
    if ((st.data && !st.data.path) || st.status === 'error') return
    set((s) => ({ mode: true, fly: { playing: true, speed: s.fly?.speed ?? 1, reverse: false }, flyStart: at, seek: { nonce: s.seek.nonce + 1, s: -1 } }))
    writeUrl(get())
  },
  stopFly: () => {
    set({ fly: null, flyStart: null })
    writeUrl(get())
  },
  setFly: (patch) => {
    const fly = get().fly
    if (!fly) return
    set({ fly: { ...fly, ...patch } })
    writeUrl(get())
  },
  seekFly: (s) => {
    set((st) => ({ seek: { nonce: st.seek.nonce + 1, s }, flyS: s }))
    writeUrl(get())
  },
}))

/** 查看器每隔一会儿报告漫游的位置；到头时停下 / The viewer reports the fly-through position now and then; it stops at either end. */
export function reportFly(s: number, total: number, segment: string | null, radius: number, ended: boolean): void {
  const st = useLumen.getState()
  if (!st.fly) return
  const patch: Partial<LumenState> = { flyS: s, flyTotal: total, flySegment: segment, flyRadius: radius }
  if (ended && st.fly.playing) patch.fly = { ...st.fly, playing: false }
  useLumen.setState(patch)
  if (ended) writeUrl(useLumen.getState())
}

/** 消化道：各段的腔和它们的壁（没有 lumen-path.json 时取消化系统里的腔和壁）/ The alimentary canal: its lumina and their walls (digestive lumina and walls when there is no lumen-path.json). */
export function canalParts(graph: AnatomyGraph, data: LumenData): string[] {
  const lumina = data.path?.canal.filter((id) => data.entries.has(id)) ?? [...data.derived, ...data.real].filter((id) => graph.part(id)?.system === 'digestive')
  const walls = data.path ? lumina.flatMap((id) => data.path!.walls[id] ?? []) : [...data.walls].filter((id) => graph.part(id)?.system === 'digestive')
  return [...new Set([...lumina, ...walls])].filter((id) => !!graph.part(id))
}

/** 一键"只看消化道"：打开模式，隔离消化道的腔和壁，相机对准 / One click "alimentary canal": mode on, the canal's lumina and walls isolated, camera framed. */
export function showCanal(graph: AnatomyGraph, data: LumenData, opts: { focus?: boolean } = {}): boolean {
  const ids = canalParts(graph, data)
  useLumen.setState({ canalPending: false })
  if (ids.length === 0) return false
  canalSet = new Set(ids)
  useApp.setState({ isolated: canalSet })
  useLumen.getState().setMode(true)
  if (opts.focus ?? true) useApp.getState().requestFocus(ids)
  return true
}

/** 现在是不是"只看消化道" / Whether the canal view is what is isolated now. */
export function canalShown(isolated: ReadonlySet<string> | null): boolean {
  return canalSet !== null && isolated === canalSet
}

/** 把地址栏的三个参数按当前状态写一遍（界面装好写回函数之后调用）/ Write the three parameters for the current state (called once the UI has registered the writer). */
export function syncLumenUrl(): void {
  writeUrl(useLumen.getState())
}

// ------------------------------------------------------------ 数据 / data

/** 这副人体里可能有充盈数据的腔：组织是 space 且带 composition / Lumina of this body that may have filling data: tissue `space` with a `composition`. */
export function lumenCandidates(graph: AnatomyGraph): string[] {
  return graph.parts.filter((p) => p.tissue === 'space' && !!p.composition?.length).map((p) => p.id)
}

/** 标本自己的腔：组织是 space、名字里有 lumen、没有充盈数据（女性的直肠腔、子宫阴道腔）/ The specimen's own lumina: tissue `space`, "lumen" in the name, no filling data (the female's rectal and uterovaginal lumina). */
export function realLumina(graph: AnatomyGraph, entries: ReadonlyMap<string, FillingEntry> | null): string[] {
  return graph.parts.filter((p) => p.tissue === 'space' && /\blumen\b/i.test(p.name) && !entries?.has(p.id)).map((p) => p.id)
}

let loading: { body: string; promise: Promise<LumenData | null> } | null = null

/**
 * 取这副人体的腔数据。没有候选部件的人体（女性现在如此）不发请求，直接得到只含"标本自己的腔"的结果。
 * Fetch this body's lumen data. A body with no candidate parts (the female at present) makes no request and
 * gets a result holding only the specimen's own lumina.
 */
export function ensureLumenData(graph: AnatomyGraph, body: string, baseUrl: string): Promise<LumenData | null> {
  const st = useLumen.getState()
  if (st.data?.body === body) return Promise.resolve(st.data)
  if (loading?.body === body) return loading.promise
  const finish = (data: LumenData | null, status: LumenStatus, message = ''): LumenData | null => {
    if (loading?.body === body) loading = null
    geometry.clear()
    // 没有路径就没有漫游（链接里带了 fly 也一样）/ no path, no fly-through (even when a link asked for one)
    useLumen.setState(data?.path ? { data, status, message } : { data, status, message, fly: null, flyStart: null })
    writeUrl(useLumen.getState())
    return data
  }
  const candidates = lumenCandidates(graph)
  const origin = new Map<string, OriginSummary>()
  if (candidates.length === 0) {
    const real = realLumina(graph, null)
    for (const id of real) origin.set(id, { kind: ORIGIN_BOUNDED, constructionShare: 0 })
    return Promise.resolve(finish({ body, entries: new Map(), bin: new Float32Array(0), path: null, walls: new Set(), derived: [], real, origin }, 'none'))
  }
  useLumen.setState({ status: 'loading', message: '' })
  const promise = (async (): Promise<LumenData | null> => {
    try {
      const index = await fetchJson<{ file: string; parts: FillingEntry[] }>(`${baseUrl}lumen-filling.json`)
      if (!index?.parts?.length) throw new Error('lumen-filling.json is missing or empty')
      const res = await fetch(`${baseUrl}${index.file}`)
      if (!res.ok) throw new Error(`${res.status} ${index.file}`)
      const bin = new Float32Array(await res.arrayBuffer())
      const path = await fetchJson<LumenPathFile>(`${baseUrl}lumen-path.json`)
      const entries = new Map<string, FillingEntry>()
      for (const e of index.parts) {
        // 只认这副人体里组织为 space 的部件，且数据要在文件范围内 / only parts of this body with tissue `space`, and only data inside the file
        const part = graph.part(e.part)
        if (part?.tissue !== 'space' || e.offset % 4 !== 0 || e.offset / 4 + e.vertices * 3 > bin.length) continue
        entries.set(e.part, e)
        origin.set(e.part, originOf(part.composition))
      }
      const real = realLumina(graph, entries)
      for (const id of real) origin.set(id, { kind: ORIGIN_BOUNDED, constructionShare: 0 })
      const walls = new Set<string>()
      for (const [lumen, ids] of Object.entries(path?.walls ?? {})) if (entries.has(lumen)) for (const id of ids) if (graph.part(id)) walls.add(id)
      if (!path) {
        // 没有壁的清单：同系统里的器官都当作壁 / no wall list: every organ of the same system counts as a wall
        const systems = new Set([...entries.keys()].map((id) => graph.part(id)!.system))
        for (const p of graph.parts) if (systems.has(p.system) && p.tissue === 'organ') walls.add(p.id)
      }
      return finish({ body, entries, bin, path: path ?? null, walls, derived: [...entries.keys()], real, origin }, 'ready')
    } catch (err) {
      console.warn('[soma] lumen data unavailable', err)
      return finish(null, 'error', err instanceof Error ? err.message : String(err))
    }
  })()
  loading = { body, promise }
  return promise
}

/** 某个部件的位移（bin 里的一段）/ A part's displacement (a slice of the bin). */
export function displacementOf(data: LumenData, part: string): Float32Array | null {
  const e = data.entries.get(part)
  return e ? data.bin.subarray(e.offset / 4, e.offset / 4 + e.vertices * 3) : null
}

/** 某个部件此刻的充盈度（不含漫游的下限）/ A part's filling right now (without the fly-through's floor). */
export function fillingOf(s: Pick<LumenState, 'fill' | 'overrides'>, entry: FillingEntry): number {
  return partFilling(s.fill, entry.rest, s.overrides[entry.part])
}

// 查看器把腔部件的静止几何登记在这里，面板据此算体积（不必经过查看器）
// the viewer registers the lumen parts' rest geometry here, so panels can compute volumes without going through it
const geometry = new Map<string, { base: Float32Array; index: Uint32Array }>()

export function registerLumenGeometry(part: string, base: Float32Array, index: Uint32Array): void {
  geometry.set(part, { base, index })
  useLumen.setState((s) => ({ geometryTick: s.geometryTick + 1 }))
}

export interface LumenVolume {
  /** 立方厘米 / cm³ */
  now: number
  rest: number
  full: number
  empty: number
  /** 两端开口、靠虚拟封口算出来的 / open-ended, computed with virtual caps */
  capped: boolean
  /** 这个部件没有位移（充盈对它不起作用）/ this part has no displacement (filling does nothing to it) */
  fixed: boolean
}

/** 某个腔在给定充盈度下的体积；几何还没加载时为 null / A lumen's volume at a given filling; null before its geometry is loaded. */
export function lumenVolume(data: LumenData, part: string, f: number): LumenVolume | null {
  const g = geometry.get(part)
  const e = data.entries.get(part)
  const d = displacementOf(data, part)
  if (!g || !e || !d || g.base.length !== d.length) return null
  const tmp = new Float32Array(g.base.length)
  const at = (x: number): { volume: number; openLoops: number } => closedVolume(applyFilling(g.base, d, x, e.rest, tmp), g.index)
  const now = at(f)
  return { now: now.volume * 1e6, rest: at(e.rest).volume * 1e6, full: at(1).volume * 1e6, empty: at(0).volume * 1e6, capped: now.openLoops > 0, fixed: isZeroDisplacement(d) }
}

/** 段的短名 → 部件 id（按这副人体的部件名）/ Segment key → part id (from this body's part names). */
export function segmentIds(graph: AnatomyGraph, data: LumenData): Map<string, string> {
  const out = new Map<string, string>()
  for (const id of data.path?.canal ?? []) {
    const p = graph.part(id)
    if (p) out.set(segmentKey(p.name), id)
  }
  return out
}

export { ORIGIN_DERIVED }
