// 把视图状态编码进 URL 查询参数、再解码回来。纯函数，不碰 store 和 DOM。
// Encoding the view state into URL query parameters and back. Pure: no store, no DOM.
//
// 参数表（都可省略；省略 = 默认值）/ Parameter table (all optional; absent = default)
//
//   body   male | female | fixture | stress      人体 / which body
//   embed  1                                      嵌入模式：只有舞台和必要控件 / embed mode: stage and essential controls only
//   tab    d | t | p | n | e                      左侧面板：显示 / 结构树 / 姿势 / 疼痛反应 / 表情 / left panel: display / tree / pose / pain response / expression
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
//   pain   7                                      疼痛反应：保持在该强度（0–10）的表情；不会自动出声
//                                                 pain response: the expression held at this intensity (0–10); never plays sound by itself
//   au     4:3,43:5                               手动设定的 FACS 动作单元强度（AU 编号:0–5）/ manually set FACS action units (AU number:0–5)
//   expr   happy | fearful:0.6                    情绪表情（face.json 的 expressions 里的 id）及强度 0–1（省略为 1）；与 pain、au 逐项取较大者
//                                                 an emotion expression (an id from `expressions` in face.json) with a strength 0–1 (1 when omitted);
//                                                 combined with pain and au by maximum
//   vis    PBM                                    保持一个视位（face.json 的 visemes 里的 id）：一个口形 / hold one viseme (an id from `visemes` in face.json): a mouth shape
//   say    zh-03                                  说一句示范片段（public/voice/ 下各包清单里的片段 id）：口形按音素时间线走。没有用户手势时
//                                                 无声地播，界面上有"声音"按钮。合成用的自由文字不进 URL。
//                                                 say a demo clip (a clip id from the pack manifests under public/voice/): the mouth follows
//                                                 the phoneme timeline. Without a user gesture it plays silently and the UI shows a "sound"
//                                                 button. Free text for synthesis never goes into the URL.
//   drive  phone | audio                          示范片段的口形由什么带动：phone 按音素时间线（缺省，准确），audio 按对同一段声音的分析
//                                                 （近似）。要和 say 一起给。/ what drives the mouth of the demo clip: phone = the phoneme
//                                                 timeline (default, accurate), audio = an analysis of the same audio (approximate). Needs say.
//   style  normal | clear                         说话的风格：normal 正常朗读（按实测标定），clear 夸张。省略时保持的口形用 clear、说话用 normal
//                                                 the style of speech: normal = read speech (calibrated), clear = exaggerated. When omitted,
//                                                 held shapes use clear and speech uses normal
//   skin   1                                      皮肤画成不透明（看表情）/ skin drawn opaque (to read the expression)
//   look   0                                      不透明皮肤不用写实外观，改回解剖配色（缺省是写实）
//                                                 an opaque skin without the lifelike look, in the anatomical colours (lifelike is the default)
//   tone   0–100                                  写实皮肤的色调（黑色素；只写不在缺省值的）/ the lifelike skin tone (melanin; written only when not the default)
//   shape  h1.80,b28,l0,c0                        体型：h 身高（米）、b BMI、l 腿长比例（SD）、c 躯干体格（SD）；只写不在默认值的项，
//                                                 超出该人体可用范围的值会被截断
//                                                 body shape: h stature (m), b BMI, l leg length (SD), c central build (SD); only non-default
//                                                 items are written, and values outside the body's valid range are cut
//   stim   heat,48,8@forearm_L                    施加一个刺激并播放反应：种类,量值,秒数[,x次数/频率][,held][,热斜率取法]@部位。
//                                                 量值：针刺毫牛，钝压 / 捏夹牛，热 / 冷摄氏度。部位是命名部位加侧别（fingertip palm handback
//                                                 forearm cheek shin sole + _L/_R），或静止姿势下的坐标（毫米）p-182,1034,28。详见 src/pain/stimulus.ts。
//                                                 applies one stimulus and plays the response: kind,magnitude,seconds[,xCount/Hz][,held]
//                                                 [,heat reading]@site. Magnitude: mN for pinprick, N for pressure / pinch, °C for heat / cold.
//                                                 A site is a named site with its side (list above) or a rest-pose position in mm,
//                                                 p-182,1034,28. See src/pain/stimulus.ts.
//   phys   1 | sphere,5,1N@forearm_L             软组织物理（男性；src/softbody/client.ts 解析，按"其他参数"保留）：1 打开体位求解，
//                                                 或一次按压 压头,半径毫米,目标(1N | 4.5mm)@部位（部位写法同 stim）
//                                                 soft-tissue physics (male; parsed by src/softbody/client.ts, kept as an "other parameter"):
//                                                 1 turns the posture solve on, or one press probe,radius mm,target (1N | 4.5mm)@site (sites as in stim)
//   grav   supine | prone | left | right          体位；省略为站立。肌肉活动显示（src/activity/state.ts）和软组织物理共用，同样按"其他参数"保留
//                                                 the posture; standing when omitted. Shared by the muscle-activity display (src/activity/state.ts)
//                                                 and the soft-tissue physics, likewise kept as an "other parameter"
//   src    1                                      按来源着色 / colour by source
//   cmp    ske                                    对照视图及其系统 / compare view and its system
//
// 其他参数（renderer、scene 等开发用参数）原样保留。未知或无效的值被忽略并给出警告。
// Other parameters (dev ones such as renderer, scene) pass through untouched. Unknown or
// invalid values are ignored with a warning.

import type { SystemId } from '../anatomy/types.ts'
import { formatShapeParam, parseShapeParam, type ShapeControls } from '../anatomy/shape.ts'
import { formatStimParam, parseStimParam, type StimParam } from '../pain/stimulus.ts'
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

const TABS = { d: 'display', t: 'tree', p: 'pose', n: 'pain', e: 'expr' } as const
const TAB_CODES = { display: 'd', tree: 't', pose: 'p', pain: 'n', expr: 'e' } as const
const AXES: Record<string, SectionAxis> = { a: 'axial', c: 'coronal', s: 'sagittal' }
const MAPS = { d: 'dermatome', n: 'cutaneousNerve' } as const
const BODIES = new Set(['male', 'female', 'fixture', 'stress'])
/** 本模块负责的参数名；其余的原样保留 / Parameter names owned here; all others pass through. */
export const URL_KEYS = ['body', 'embed', 'tab', 'sys', 'peel', 'iso', 'hide', 'sel', 'adj', 'focus', 'cam', 'cut', 'xp', 'pose', 'breath', 'map', 'reg', 'see', 'pain', 'au', 'expr', 'vis', 'say', 'drive', 'style', 'skin', 'look', 'tone', 'shape', 'stim', 'src', 'cmp'] as const
/** 超过这个数量的部件 id 不写进 URL / Part id lists longer than this are not written to the URL. */
export const MAX_URL_IDS = 60
export const MAX_URL_DOFS = 40

export interface UrlState {
  body?: string
  embed?: boolean
  tab?: 'display' | 'tree' | 'pose' | 'pain' | 'expr'
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
  /** 保持的疼痛强度 0–10 / held pain intensity, 0–10. */
  pain?: number
  /** AU id（如 "AU4"）→ 强度 0–5 / AU id (e.g. "AU4") → intensity 0–5. */
  au?: Record<string, number>
  /** 情绪表情的 id 和强度 0–1 / an emotion expression's id and strength 0–1. */
  expr?: { id: string; strength: number }
  /** 保持的视位的 id / the id of the held viseme. */
  vis?: string
  /** 示范片段的 id / the id of a demo clip. */
  say?: string
  /** 示范片段的口形由什么带动 / what drives the demo clip's mouth. */
  drive?: 'phone' | 'audio'
  /** 说话的风格 / the style of speech. */
  style?: 'normal' | 'clear'
  skin?: boolean
  /** false：不透明皮肤用解剖配色；缺省（写实）不写 / false: an opaque skin in the anatomical colours; the default (lifelike) is not written */
  look?: boolean
  /** 写实皮肤的色调 0–100 / the lifelike skin tone 0–100 */
  tone?: number
  /** 体型控制量（未限幅）/ shape controls (not yet clamped). */
  shape?: ShapeControls
  /** 一个刺激及其部位 / one stimulus and its site */
  stim?: StimParam
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
      case 'skin':
      case 'src': {
        const f = flag(value)
        if (f === null) warn(`${key}: 应为 1 或 0 / expected 1 or 0`)
        else if (f) state[key] = true
        break
      }
      case 'look': {
        const f = flag(value)
        if (f === null) warn(`${key}: 应为 1 或 0 / expected 1 or 0`)
        else if (!f) state.look = false
        break
      }
      case 'tone': {
        const t = Number(value)
        if (value === '' || !Number.isFinite(t) || t < 0 || t > 100) warn(`${key}: 应为 0–100 的数 / expected a number from 0 to 100`)
        else state.tone = Math.round(t)
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
      case 'pain': {
        const n = Number(value)
        if (value === '' || !Number.isFinite(n) || n < 0 || n > 10) warn(`pain: 应为 0–10 的数 "${value}" / expected a number from 0 to 10`)
        else state.pain = Math.round(n * 10) / 10
        break
      }
      case 'au': {
        const au: Record<string, number> = {}
        let bad = false
        for (const item of value.split(',').filter(Boolean)) {
          const m = /^(\d{1,2}):(\d+(?:\.\d+)?)$/.exec(item)
          const v = m ? Number(m[2]) : NaN
          if (!m || v < 0 || v > 5) bad = true
          else if (v > 0) au[`AU${Number(m[1])}`] = Math.round(v * 10) / 10
        }
        if (bad) warn('au: 忽略了无法解析的项（形式为 编号:0–5）/ ignored entries that could not be parsed (form number:0–5)')
        if (Object.keys(au).length) state.au = au
        break
      }
      case 'expr': {
        const m = /^([A-Za-z][A-Za-z0-9_]*)(?::(\d+(?:\.\d+)?))?$/.exec(value)
        const k = m && m[2] !== undefined ? Number(m[2]) : 1
        if (!m || k > 1) warn(`expr: 无法解析 "${value}"（形式为 表情id 或 表情id:0–1）/ could not be parsed (form id or id:0–1)`)
        else if (k > 0) state.expr = { id: m[1]!, strength: Math.round(k * 100) / 100 }
        break
      }
      case 'vis': {
        if (/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) state.vis = value
        else warn(`vis: 无法解析 "${value}"（应为视位 id）/ could not be parsed (expected a viseme id)`)
        break
      }
      case 'say': {
        if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) state.say = value
        else warn(`say: 无法解析 "${value.slice(0, 40)}"（应为示范片段的 id，如 zh-03；自由文字不放进 URL）/ could not be parsed (expected a demo clip id such as zh-03; free text is not carried in the URL)`)
        break
      }
      case 'drive': {
        if (value === 'phone' || value === 'audio') state.drive = value
        else warn(`drive: 应为 phone 或 audio "${value.slice(0, 40)}" / expected phone or audio`)
        break
      }
      case 'style': {
        if (value === 'normal' || value === 'clear') state.style = value
        else warn(`style: 应为 normal 或 clear "${value.slice(0, 40)}" / expected normal or clear`)
        break
      }
      case 'stim': {
        const r = parseStimParam(value)
        if (r) state.stim = r
        else warn('stim: 无法解析（形式为 heat,48,8@forearm_L）/ could not be parsed (form heat,48,8@forearm_L)')
        break
      }
      case 'shape': {
        const r = parseShapeParam(value)
        if (r.bad) warn('shape: 忽略了无法解析的项（形式为 h1.80,b28,l0,c0）/ ignored entries that could not be parsed (form h1.80,b28,l0,c0)')
        if (Object.keys(r.controls).length) state.shape = r.controls
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
  if (state.drive && !state.say) {
    warn('drive: 需要同时给出 say / needs say')
    delete state.drive
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
  if (state.tab && state.tab !== 'display') put('tab', TAB_CODES[state.tab])
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
  if (state.pain !== undefined && state.pain > 0) put('pain', String(Math.round(state.pain * 10) / 10))
  if (state.au) {
    const items = Object.entries(state.au)
      .filter(([id, v]) => /^AU\d+$/.test(id) && v > 0)
      .sort((a, b) => Number(a[0].slice(2)) - Number(b[0].slice(2)))
      .map(([id, v]) => `${id.slice(2)}:${Math.round(v * 10) / 10}`)
    if (items.length) put('au', items.join(','))
  }
  if (state.expr && state.expr.strength > 0) put('expr', state.expr.id + (Math.round(state.expr.strength * 100) === 100 ? '' : `:${Math.round(state.expr.strength * 100) / 100}`))
  if (state.vis) put('vis', state.vis)
  if (state.say) put('say', state.say)
  // 缺省的 phone 不写 / the default, phone, is not written
  if (state.say && state.drive === 'audio') put('drive', 'audio')
  if (state.style) put('style', state.style)
  if (state.skin) put('skin', '1')
  if (state.look === false) put('look', '0')
  if (state.tone !== undefined) put('tone', String(Math.round(state.tone)))
  if (state.shape && Object.keys(state.shape).length) put('shape', formatShapeParam(state.shape))
  if (state.stim) put('stim', formatStimParam(state.stim))
  if (state.src) put('src', '1')
  if (state.cmp) put('cmp', SYSTEM_CODES[state.cmp])
  // 逗号、冒号在查询串里是安全的，不转义更易读 / commas and colons are safe in a query and read better unescaped
  return [...out, ...passthrough].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%40/g, '@').replace(/%2F/g, '/')}`).join('&')
}

/** 姿势中非零的自由度个数 / Number of non-zero dofs in a pose. */
export function poseDofCount(pose: Record<string, number[]>): number {
  let n = 0
  for (const a of Object.values(pose)) for (const v of a) if (Math.abs(v) > 8.7e-4) n++
  return n
}
