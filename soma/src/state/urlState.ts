// 把视图状态编码进 URL 查询参数、再解码回来。纯函数，不碰 store 和 DOM。
// Encoding the view state into URL query parameters and back. Pure: no store, no DOM.
//
// 参数表（都可省略；省略 = 默认值）/ Parameter table (all optional; absent = default)
//
//   body   male | female | fixture | stress      人体 / which body
//   embed  1                                      嵌入模式：只有舞台和必要控件 / embed mode: stage and essential controls only
//   tab    d | t | p                              左侧面板：显示 / 结构树 / 姿势 / left panel: display / tree / pose
//   sys    ske,ner:60,…                           可见的系统，可带不透明度百分数；未列出的隐藏
//                                                 visible systems, each optionally with an opacity percent; unlisted ones are hidden
//                                                 代码 / codes: int mus ske cv ner res dig uri rep end lym oth
//   peel   2                                      剥离层数 / peel depth
//   iso    FMA7088,FJ1234                         隔离显示：部件 id 或概念 id（概念展开为其下全部部件）
//                                                 isolate: part ids and/or concept ids (a concept expands to all its parts)
//   hide   …                                      隐藏：同上 / hidden: same form
//   sel    FMA9611  |  FJ3259,FJ3260              选择：单个概念 id，或若干部件 id / selection: one concept id, or part ids
//   adj    1                                      显示相邻结构 / adjacent-structures mode
//   focus  1                                      加载后对准所选（或隔离、可见）结构 / frame the selection (or isolated / visible parts) on load
//   cam    px,py,pz,tx,ty,tz                      相机位置与目标，米，毫米精度 / camera position and target, metres, millimetre precision
//   cut    a620 | c500f | s250                    剖切：轴 (a 横断 / c 冠状 / s 矢状) + 位置千分比 + 可选 f 翻转
//                                                 section: axis (a axial / c coronal / s sagittal) + position per mille + optional f = flip
//   xp     40                                     爆炸视图百分数 / explode percent
//   pose   squat  |  elbow_L.0:90,elbow_R.0:90    姿势：预设 id，或 关节.自由度:角度（度，相对静止姿势）
//                                                 pose: a preset id, or joint.dof:degrees (relative to rest)
//   breath 1                                      呼吸演示 / breathing demonstration
//   map    d | n                                  体表图：皮节 / 皮神经分布区 / skin map: dermatomes / nerve territories
//   reg    14,15                                  体表图中高亮的区域下标 / highlighted region indices of the map
//   see    1                                      体表图下皮肤半透明（露出其下的神经）/ skin drawn see-through under a skin map (to reveal the nerve beneath)
//   src    1                                      按来源着色 / colour by source
//   cmp    ske                                    对照视图及其系统 / compare view and its system
//
// 其他参数（renderer、scene 等开发用参数）原样保留。未知或无效的值被忽略并给出警告。
// Other parameters (dev ones such as renderer, scene) pass through untouched. Unknown or
// invalid values are ignored with a warning.

import type { SystemId } from '../anatomy/types.ts'
import type { SectionAxis } from './display.ts'

export const SYSTEM_CODES: Record<SystemId, string> = {
  integumentary: 'int',
  muscular: 'mus',
  skeletal: 'ske',
  cardiovascular: 'cv',
  nervous: 'ner',
  respiratory: 'res',
  digestive: 'dig',
  urinary: 'uri',
  reproductive: 'rep',
  endocrine: 'end',
  lymphatic: 'lym',
  other: 'oth',
}
const CODE_TO_SYSTEM = new Map(Object.entries(SYSTEM_CODES).map(([id, code]) => [code, id as SystemId]))

const TABS = { d: 'display', t: 'tree', p: 'pose' } as const
const AXES: Record<string, SectionAxis> = { a: 'axial', c: 'coronal', s: 'sagittal' }
const MAPS = { d: 'dermatome', n: 'cutaneousNerve' } as const
const BODIES = new Set(['male', 'female', 'fixture', 'stress'])
/** 本模块负责的参数名；其余的原样保留 / Parameter names owned here; all others pass through. */
export const URL_KEYS = ['body', 'embed', 'tab', 'sys', 'peel', 'iso', 'hide', 'sel', 'adj', 'focus', 'cam', 'cut', 'xp', 'pose', 'breath', 'map', 'reg', 'see', 'src', 'cmp'] as const
/** 超过这个数量的部件 id 不写进 URL / Part id lists longer than this are not written to the URL. */
export const MAX_URL_IDS = 60
export const MAX_URL_DOFS = 40

export interface UrlState {
  body?: string
  embed?: boolean
  tab?: 'display' | 'tree' | 'pose'
  /** 给出时：列出的系统可见（带不透明度），其余隐藏 / When given: listed systems are visible (with opacity), the rest hidden. */
  sys?: { id: SystemId; opacity: number }[]
  peel?: number
  iso?: string[]
  hide?: string[]
  sel?: string[]
  adj?: boolean
  focus?: boolean
  cam?: { p: [number, number, number]; t: [number, number, number] }
  cut?: { axis: SectionAxis; position: number; flip: boolean }
  xp?: number
  pose?: { preset: string } | { angles: Record<string, number[]> }
  breath?: boolean
  map?: 'dermatome' | 'cutaneousNerve'
  reg?: number[]
  see?: boolean
  src?: boolean
  cmp?: SystemId
}

export interface ParsedUrl {
  state: UrlState
  warnings: string[]
  /** 不归本模块管的参数，按原顺序 / Parameters not owned here, in their original order. */
  passthrough: [string, string][]
}

const ID_TOKEN = /^[A-Za-z0-9_.\-]+$/
const flag = (v: string): boolean | null => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : null)

function tokens(v: string, max: number, warn: (m: string) => void, key: string): string[] | undefined {
  const list = v.split(',').map((x) => x.trim()).filter(Boolean)
  const good = list.filter((x) => ID_TOKEN.test(x))
  if (good.length !== list.length) warn(`${key}: 忽略了无效的 id / ignored malformed ids`)
  if (good.length > max) warn(`${key}: 只取前 ${max} 个 / only the first ${max} are used`)
  return good.length ? good.slice(0, max) : undefined
}

/** 解析查询字符串；任何无效的值都只产生警告 / Parse a query string; anything invalid only produces a warning. */
export function parseUrl(search: string): ParsedUrl {
  const state: UrlState = {}
  const warnings: string[] = []
  const passthrough: [string, string][] = []
  const warn = (m: string): void => void warnings.push(m)
  const owned = new Set<string>(URL_KEYS)
  for (const [key, value] of new URLSearchParams(search)) {
    if (!owned.has(key)) {
      passthrough.push([key, value])
      continue
    }
    switch (key) {
      case 'body':
        if (BODIES.has(value)) state.body = value
        else warn(`body: 未知的人体 "${value}" / unknown body`)
        break
      case 'embed':
      case 'adj':
      case 'focus':
      case 'breath':
      case 'see':
      case 'src': {
        const f = flag(value)
        if (f === null) warn(`${key}: 应为 1 或 0 / expected 1 or 0`)
        else if (f) state[key] = true
        break
      }
      case 'tab': {
        const t = TABS[value as keyof typeof TABS]
        if (t) state.tab = t
        else warn(`tab: 未知的面板 "${value}" / unknown tab`)
        break
      }
      case 'sys': {
        const out: { id: SystemId; opacity: number }[] = []
        for (const item of value.split(',').filter(Boolean)) {
          const [code, pct] = item.split(':')
          const id = CODE_TO_SYSTEM.get(code ?? '')
          const opacity = pct === undefined ? 100 : Number(pct)
          if (!id || !Number.isFinite(opacity) || opacity < 0 || opacity > 100) warn(`sys: 忽略 "${item}" / ignored`)
          else if (!out.some((x) => x.id === id)) out.push({ id, opacity: Math.round(opacity) / 100 })
        }
        if (out.length || value === '') state.sys = out
        break
      }
      case 'peel':
      case 'xp': {
        const n = Number(value)
        if (!Number.isFinite(n) || n < 0 || (key === 'xp' && n > 100) || (key === 'peel' && (n > 50 || !Number.isInteger(n)))) warn(`${key}: 无效的数值 "${value}" / invalid number`)
        else if (key === 'peel') state.peel = n
        else state.xp = n / 100
        break
      }
      case 'iso':
      case 'hide':
      case 'sel': {
        const t = tokens(value, key === 'sel' ? MAX_URL_IDS : 200, warn, key)
        if (t) state[key] = t
        break
      }
      case 'cam': {
        const n = value.split(',').map(Number)
        if (n.length !== 6 || n.some((x) => !Number.isFinite(x) || Math.abs(x) > 100)) warn('cam: 需要 6 个数 / expected six numbers')
        else if (Math.hypot(n[0]! - n[3]!, n[1]! - n[4]!, n[2]! - n[5]!) < 1e-3) warn('cam: 相机与目标重合 / camera and target coincide')
        else state.cam = { p: [n[0]!, n[1]!, n[2]!], t: [n[3]!, n[4]!, n[5]!] }
        break
      }
      case 'cut': {
        const m = /^([acs])(\d{1,4})(f?)$/.exec(value)
        const pos = m ? Number(m[2]) : NaN
        if (!m || pos > 1000) warn(`cut: 无法解析 "${value}" / cannot parse`)
        else state.cut = { axis: AXES[m[1]!]!, position: pos / 1000, flip: m[3] === 'f' }
        break
      }
      case 'pose': {
        if (/^[A-Za-z][A-Za-z0-9]*$/.test(value)) {
          state.pose = { preset: value }
          break
        }
        const angles: Record<string, number[]> = {}
        let bad = false
        let count = 0
        for (const item of value.split(',').filter(Boolean)) {
          const m = /^([A-Za-z0-9_]+)\.(\d):(-?\d+(?:\.\d+)?)$/.exec(item)
          if (!m || count >= MAX_URL_DOFS) {
            bad = true
            continue
          }
          const a = (angles[m[1]!] ??= [])
          const k = Number(m[2])
          while (a.length <= k) a.push(0)
          a[k] = (Number(m[3]) * Math.PI) / 180
          count++
        }
        if (bad) warn('pose: 忽略了无法解析的项 / ignored entries that could not be parsed')
        if (count) state.pose = { angles }
        break
      }
      case 'map': {
        const m = MAPS[value as keyof typeof MAPS]
        if (m) state.map = m
        else warn(`map: 未知的体表图 "${value}" / unknown map`)
        break
      }
      case 'reg': {
        const n = value.split(',').filter(Boolean).map(Number)
        if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 254)) warn('reg: 无效的区域下标 / invalid region index')
        else if (n.length) state.reg = [...new Set(n)].slice(0, 60)
        break
      }
      case 'cmp': {
        const id = CODE_TO_SYSTEM.get(value)
        if (id) state.cmp = id
        else warn(`cmp: 未知的系统 "${value}" / unknown system`)
        break
      }
    }
  }
  if (state.reg && !state.map) {
    warn('reg: 需要同时给出 map / needs map')
    delete state.reg
  }
  return { state, warnings, passthrough }
}

const r3 = (v: number): string => String(Math.round(v * 1000) / 1000)

/** 生成规范的查询字符串（不含 "?"；空状态得到空串）/ The canonical query string (no "?"; empty for an empty state). */
export function formatUrl(state: UrlState, passthrough: readonly [string, string][] = []): string {
  const out: [string, string][] = []
  const put = (k: string, v: string): void => void out.push([k, v])
  if (state.body && state.body !== 'male') put('body', state.body)
  if (state.embed) put('embed', '1')
  if (state.tab && state.tab !== 'display') put('tab', state.tab[0]!)
  if (state.sys) put('sys', state.sys.map((s) => SYSTEM_CODES[s.id] + (Math.round(s.opacity * 100) === 100 ? '' : `:${Math.round(s.opacity * 100)}`)).join(','))
  if (state.peel) put('peel', String(state.peel))
  if (state.iso?.length) put('iso', state.iso.join(','))
  if (state.hide?.length) put('hide', state.hide.join(','))
  if (state.sel?.length) put('sel', state.sel.join(','))
  if (state.adj) put('adj', '1')
  if (state.focus) put('focus', '1')
  if (state.cam) put('cam', [...state.cam.p, ...state.cam.t].map(r3).join(','))
  if (state.cut) put('cut', `${state.cut.axis[0]}${Math.round(state.cut.position * 1000)}${state.cut.flip ? 'f' : ''}`)
  if (state.xp) put('xp', String(Math.round(state.xp * 100)))
  if (state.pose) {
    if ('preset' in state.pose) put('pose', state.pose.preset)
    else {
      const items: string[] = []
      for (const [joint, a] of Object.entries(state.pose.angles)) {
        a.forEach((v, k) => {
          const d = Math.round(((v * 180) / Math.PI) * 10) / 10
          if (d !== 0) items.push(`${joint}.${k}:${d}`)
        })
      }
      if (items.length) put('pose', items.join(','))
    }
  }
  if (state.breath) put('breath', '1')
  if (state.map) put('map', state.map === 'dermatome' ? 'd' : 'n')
  if (state.map && state.reg?.length) put('reg', state.reg.join(','))
  if (state.map && state.see) put('see', '1')
  if (state.src) put('src', '1')
  if (state.cmp) put('cmp', SYSTEM_CODES[state.cmp])
  // 逗号、冒号在查询串里是安全的，不转义更易读 / commas and colons are safe in a query and read better unescaped
  return [...out, ...passthrough].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C/g, ',').replace(/%3A/g, ':')}`).join('&')
}

/** 姿势中非零的自由度个数 / Number of non-zero dofs in a pose. */
export function poseDofCount(pose: Record<string, number[]>): number {
  let n = 0
  for (const a of Object.values(pose)) for (const v of a) if (Math.abs(v) > 8.7e-4) n++
  return n
}
