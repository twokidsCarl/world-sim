// 刺激工具的纯逻辑：各种刺激的默认值和滑块范围、界面设置 → 模型的 Stimulus、体表上的命名部位、
// 以及 `stim=` 地址参数的读写。不依赖 DOM 和 three.js（tests/app-stimulus.test.ts）。
// Pure logic of the stimulus tool: defaults and slider ranges per kind, UI settings → the model's
// Stimulus, named sites on the body, and reading / writing the `stim=` URL parameter. No DOM, no
// three.js (tests/app-stimulus.test.ts).
//
// 地址参数 / URL parameter
//   stim=<kind>,<magnitude>,<seconds>[,x<count>/<hz>][,held][,<heat reading>]@<site>
//   kind       pinprick | pressure | pinch | heat | cold
//   magnitude  针刺用毫牛，钝压和捏夹用牛，热和冷用摄氏度 / mN for pinprick, N for pressure and pinch, °C for heat and cold
//   x10/1      重复 10 次，1 Hz / ten applications at 1 Hz
//   held       刺激物（或肢体）被固定，退缩不能结束刺激 / the stimulus (or the limb) is held: a withdrawal does not end it
//   site       命名部位加侧别，如 forearm_L（列表见 SITES）；或静止姿势、默认体型下的坐标，毫米："p-182,1034,28"
//              （加载时取最近的皮肤顶点，所以皮肤重建后仍然有效）。
//              a named site with its side, e.g. forearm_L (list: SITES); or a position in the rest pose and
//              default shape in millimetres, "p-182,1034,28" (resolved to the nearest skin vertex at load,
//              so it survives a rebuild of the skin).
//   例 / e.g.  stim=heat,48,8@forearm_L    stim=cold,4,60,held@palm_L    stim=pinprick,256,0.5,x10/1@handback_R

import { nearestSkinVertex, type PainBody, type PainOptions, type SideLR, type Stimulus, type StimulusKind } from '../painmodel/index.ts'
import { segmentTip, territoryCentre } from '../../tools/pain/scenarios.ts'

export type HeatAnchor = NonNullable<PainOptions['heatAnchor']>
export const HEAT_ANCHORS: { id: HeatAnchor; zh: string; en: string }[] = [
  { id: 'painScale', zh: '疼痛量表（默认，2.2 /°C）', en: 'pain scale (default, 2.2 per °C)' },
  { id: 'toleranceRamp', zh: '耐受斜坡（1.43 /°C）', en: 'tolerance ramp (1.43 per °C)' },
  { id: 'noSensationRescaled', zh: '感觉量表重标（1.03 /°C）', en: 'sensation scale, rescaled (1.03 per °C)' },
  { id: 'noSensation', zh: '感觉量表（0.82 /°C）', en: 'sensation scale (0.82 per °C)' },
]

export interface KindSpec {
  id: StimulusKind
  zh: string
  en: string
  /** 界面和地址里量值的单位 / unit of the magnitude in the UI and the URL */
  unit: 'mN' | 'N' | '°C'
  min: number
  max: number
  step: number
  default: number
  /** 默认时长与时长滑块的上限，秒 / default duration and the top of the duration slider, seconds */
  duration: number
  durationMax: number
  /** 接触面积，平方毫米（针刺不用）/ contact area, mm² (unused for pinprick) */
  areaMm2?: number
  /** 滑块范围的来历 / where the slider range comes from */
  range: { zh: string; en: string }
}

// 默认值和范围取自 src/painmodel/INTEGRATION.txt 第 5 节（出处里测试设备的范围）
// Defaults and ranges are those of section 5 of src/painmodel/INTEGRATION.txt (the ranges of the sources' test devices)
export const KINDS: KindSpec[] = [
  { id: 'pinprick', zh: '针刺', en: 'Pinprick', unit: 'mN', min: 8, max: 512, step: 8, default: 128, duration: 2, durationMax: 10, range: { zh: 'DFNS 针刺刺激器的范围', en: 'range of the DFNS pinprick stimulators' } },
  { id: 'pressure', zh: '钝压', en: 'Pressure', unit: 'N', min: 0, max: 200, step: 5, default: 50, duration: 3, durationMax: 30, areaMm2: 100, range: { zh: '1 cm² 探头，0–2000 kPa', en: '1 cm² probe, 0–2000 kPa' } },
  { id: 'pinch', zh: '捏夹', en: 'Pinch', unit: 'N', min: 0, max: 40, step: 1, default: 15, duration: 1, durationMax: 30, areaMm2: 25, range: { zh: '25 mm² 夹面', en: '25 mm² jaws' } },
  { id: 'heat', zh: '热', en: 'Heat', unit: '°C', min: 32, max: 50, step: 0.5, default: 46, duration: 5, durationMax: 30, areaMm2: 256, range: { zh: '接触式热刺激器的上限 50 °C', en: 'contact thermode cut-off at 50 °C' } },
  { id: 'cold', zh: '冷', en: 'Cold', unit: '°C', min: 0, max: 32, step: 0.5, default: 8, duration: 10, durationMax: 120, areaMm2: 900, range: { zh: '设备下限 0 °C', en: 'device cut-off at 0 °C' } },
]

export const kindSpec = (kind: StimulusKind): KindSpec => KINDS.find((k) => k.id === kind)!

export interface StimSettings {
  kind: StimulusKind
  /** 以该种刺激的界面单位计 / in the kind's UI unit */
  magnitude: number
  duration: number
  repeat: { count: number; hz: number } | null
  /** 刺激物或肢体被固定：退缩不能结束刺激 / the stimulus or the limb is held: a withdrawal does not end it */
  held: boolean
  heatAnchor: HeatAnchor
}

export function defaultSettings(kind: StimulusKind = 'pinprick'): StimSettings {
  const k = kindSpec(kind)
  return { kind, magnitude: k.default, duration: k.duration, repeat: null, held: false, heatAnchor: 'painScale' }
}

/** 换一种刺激：量值和时长换成那一种的默认值，其余保留 / Switch kind: magnitude and duration take that kind's defaults, the rest is kept. */
export function withKind(s: StimSettings, kind: StimulusKind): StimSettings {
  const k = kindSpec(kind)
  return { ...s, kind, magnitude: k.default, duration: k.duration }
}

/** 压强，千帕（针刺、热、冷没有）/ Pressure in kPa (none for pinprick, heat, cold). */
export function pressureKPa(s: Pick<StimSettings, 'kind' | 'magnitude'>): number | null {
  const k = kindSpec(s.kind)
  return (s.kind === 'pressure' || s.kind === 'pinch') && k.areaMm2 ? (s.magnitude / k.areaMm2) * 1000 : null
}

export interface ResolvedSite {
  vertex: number
  position: [number, number, number]
}

/**
 * 由软组织物理算出的接触（src/softbody/）：到达的力和接触面积。疼痛输入模型的压强 = 力 ÷ 面积，所以把这两个数放进
 * 刺激的 forceN、areaMm2（模型已有的输入），模型拿到的就是物理算出的平均接触压强，取代名义上"1 cm² 探头上的力"。
 * A contact computed by the soft-tissue physics (src/softbody/): the force reached and the contact area. The pain input
 * model takes pressure = force ÷ area, so putting these two into the stimulus's forceN and areaMm2 (inputs the model
 * already has) hands it the physics' mean contact pressure in place of the nominal "force on a 1 cm² probe".
 */
export interface Contact {
  forceN: number
  areaMm2: number
  meanPressureKPa: number
  peakPressureKPa: number
  depthMm: number
}

/** 界面设置 + 部位 → 模型的刺激（对象不可变，模型按对象缓存）/ UI settings + site → the model's stimulus (immutable: the model caches per object). */
export function buildStimulus(s: StimSettings, site: ResolvedSite, skinPart: string, duration = s.duration, contact: Contact | null = null): Stimulus {
  const k = kindSpec(s.kind)
  const out: Stimulus = { kind: s.kind, site: { part: skinPart, position: site.position, vertex: site.vertex }, duration }
  if (k.unit === 'mN') out.forceN = s.magnitude / 1000
  else if (k.unit === 'N') out.forceN = s.magnitude
  else out.temperatureC = s.magnitude
  if (k.areaMm2 && s.kind !== 'pinprick') out.areaMm2 = k.areaMm2
  if (contact && s.kind === 'pressure') {
    out.forceN = contact.forceN
    out.areaMm2 = contact.areaMm2
    out.site.depthMm = contact.depthMm
  }
  if (s.repeat && s.repeat.count > 1) out.repeat = { count: s.repeat.count, hz: s.repeat.hz }
  if (s.held) out.withdrawalEndsStimulus = false
  return out
}

// ---------------------------------------------------------------- 命名部位 / named sites

export interface NamedSite {
  id: string
  zh: string
  en: string
  /** 按解剖关系在这副身体上找到该部位（不写死顶点下标）/ Finds the site on this body by anatomy (no hard-coded vertex index). */
  find(body: PainBody, side: SideLR): ResolvedSite
}

const territory = (id: string, name: string, zh: string, en: string): NamedSite => ({ id, zh, en, find: (b, s) => territoryCentre(b, name, s) })

export const SITES: NamedSite[] = [
  {
    id: 'fingertip',
    zh: '示指尖',
    en: 'index fingertip',
    // 有绑定时取示指远节的末端；没有时退到正中神经分布区的中心 / with a rig, the end of the index finger's distal segment; without one, the centre of the median territory
    find: (b, s) => (b.joints?.some((j) => j.id === `dip2_${s}`) ? segmentTip(b, `dip2_${s}`) : territoryCentre(b, 'median', s)),
  },
  territory('palm', 'median', '手掌（正中神经区）', 'palm (median territory)'),
  territory('handback', 'superficialRadial', '手背（桡神经浅支区）', 'back of the hand (superficial radial)'),
  territory('forearm', 'lateralAntebrachial', '前臂外侧', 'lateral forearm'),
  territory('cheek', 'infraorbital', '面颊（眶下神经区）', 'cheek (infraorbital)'),
  territory('shin', 'saphenous', '小腿内侧（隐神经区）', 'medial leg (saphenous)'),
  territory('sole', 'medialPlantar', '足底内侧', 'medial sole'),
]

export type SiteRef = { name: string; side: SideLR } | { mm: [number, number, number] }

export function formatSite(site: SiteRef): string {
  return 'name' in site ? `${site.name}_${site.side}` : `p${site.mm.map((v) => Math.round(v)).join(',')}`
}

export function parseSite(text: string): SiteRef | null {
  const named = /^([a-z]+)_([LR])$/.exec(text)
  if (named) return SITES.some((s) => s.id === named[1]) ? { name: named[1]!, side: named[2] as SideLR } : null
  const m = /^p(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(text)
  return m ? { mm: [Number(m[1]), Number(m[2]), Number(m[3])] } : null
}

/** 把地址里的部位落到这副身体的皮肤上；找不到时抛出带说明的错误 / Resolve a URL site on this body's skin; throws a descriptive error when it cannot. */
export function resolveSite(body: PainBody, site: SiteRef): ResolvedSite {
  if ('name' in site) {
    const s = SITES.find((x) => x.id === site.name)
    if (!s) throw new Error(`没有名为 ${site.name} 的部位 / no site named ${site.name}`)
    return s.find(body, site.side)
  }
  const p: [number, number, number] = [site.mm[0] / 1000, site.mm[1] / 1000, site.mm[2] / 1000]
  const vertex = nearestSkinVertex(body.skin.positions, p)
  if (vertex < 0) throw new Error('皮肤没有顶点 / the skin has no vertices')
  const q = body.skin.positions
  const position: [number, number, number] = [q[vertex * 3]!, q[vertex * 3 + 1]!, q[vertex * 3 + 2]!]
  // 离皮肤超过 3 厘米的坐标多半是给另一副身体的 / a position more than 3 cm off the skin was most likely meant for another body
  if (Math.hypot(position[0] - p[0], position[1] - p[1], position[2] - p[2]) > 0.03) throw new Error('这个坐标离皮肤超过 3 厘米 / that position is more than 3 cm from the skin')
  return { vertex, position }
}

/** 点击得到的部位写进地址时用坐标（毫米）/ A clicked site goes into the URL as a position (millimetres). */
export function siteRefOf(site: ResolvedSite): SiteRef {
  return { mm: [site.position[0] * 1000, site.position[1] * 1000, site.position[2] * 1000] }
}

// ---------------------------------------------------------------- 地址参数 / URL parameter

export interface StimParam {
  settings: StimSettings
  site: SiteRef
}

const num = (v: number): string => String(Math.round(v * 1000) / 1000)

export function formatStimParam(p: StimParam): string {
  const s = p.settings
  const parts = [s.kind, num(s.magnitude), num(s.duration)]
  if (s.repeat && s.repeat.count > 1) parts.push(`x${Math.round(s.repeat.count)}/${num(s.repeat.hz)}`)
  if (s.held) parts.push('held')
  if (s.kind === 'heat' && s.heatAnchor !== 'painScale') parts.push(s.heatAnchor)
  return `${parts.join(',')}@${formatSite(p.site)}`
}

/** 解析 `stim=`；写得不对时返回 null（由调用方报告）/ Parse `stim=`; null when malformed (the caller reports it). */
export function parseStimParam(text: string): StimParam | null {
  const at = text.indexOf('@')
  if (at < 0) return null
  const site = parseSite(text.slice(at + 1))
  const f = text.slice(0, at).split(',')
  const kind = KINDS.find((k) => k.id === f[0])
  const magnitude = Number(f[1]), duration = Number(f[2])
  if (!site || !kind || f.length < 3 || !Number.isFinite(magnitude) || !Number.isFinite(duration) || duration <= 0) return null
  const settings: StimSettings = { ...defaultSettings(kind.id), magnitude, duration: Math.min(duration, 600) }
  for (const token of f.slice(3)) {
    const r = /^x(\d+)\/(\d+(?:\.\d+)?)$/.exec(token)
    if (r) settings.repeat = { count: Math.min(60, Math.max(1, Number(r[1]))), hz: Math.min(10, Math.max(0.05, Number(r[2]))) }
    else if (token === 'held') settings.held = true
    else if (HEAT_ANCHORS.some((a) => a.id === token)) settings.heatAnchor = token as HeatAnchor
    else return null
  }
  return { settings, site }
}
