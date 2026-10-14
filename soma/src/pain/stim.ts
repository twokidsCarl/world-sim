// 刺激 → 反应的运行时：为当前人体建一个 PainBody，把一次刺激交给疼痛输入模型（src/painmodel/），
// 然后在一个会随页面隐藏而暂停的时钟上逐帧取样，喂给表情、发声、反射姿势、体表图层、神经通路和监护条。
// 这是疼痛生理与行为的计算模型，用于教学：被模拟的身体没有主观体验。
// Runtime of stimulus → response: builds a PainBody for the current body, hands one stimulus to the
// pain input model (src/painmodel/), then samples it every frame on a clock that pauses while the page is
// hidden, feeding the face, the voice, the reflex pose, the skin layer, the nerve pathway and the monitor.
// A computational model of pain physiology and behaviour for teaching: the simulated body has no
// subjective experience.

import type { NervePath, SystemId } from '../anatomy/types.ts'
import { fetchJson } from '../anatomy/load.ts'
import { painMapWeights, prepareStimulus, type InnervationTable, type PainBody, type PainEvaluation, type PainSample } from '../painmodel/index.ts'
import { useApp } from '../state/store.ts'
import { primeVoice, setExternalPainLevel, vocalise } from './controller.ts'
import { buildStimulus, kindSpec, resolveSite, type Contact, type ResolvedSite, type SiteRef, type StimSettings } from './stimulus.ts'

/** 主视图提供的两样东西：静止皮肤的顶点，以及按需加载系统 / What the main viewer provides: the rest skin's vertices, and loading systems on demand. */
export interface StimHost {
  skinRest(): { part: string; positions: Float32Array } | null
  request(systems: SystemId[]): Promise<void>
}

let host: StimHost | null = null
let hostWaiters: ((h: StimHost) => void)[] = []
export function registerStimHost(h: StimHost | null): void {
  host = h
  if (h) {
    for (const w of hostWaiters) w(h)
    hostWaiters = []
  }
}

/** 视图是单独加载的代码块，链接里的刺激可能比它先到：等它一会儿 / The viewer is a separately loaded chunk and a linked stimulus can arrive first: wait for it a while. */
function whenHost(): Promise<StimHost> {
  if (host) return Promise.resolve(host)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('视图还没有准备好 / the viewer is not ready')), 30000)
    hostWaiters.push((h) => {
      clearTimeout(timer)
      resolve(h)
    })
  })
}

/** 当前这一次刺激（给界面看的那部分放在 store 里）/ The stimulus in progress (what the UI needs lives in the store). */
export interface ActiveStim {
  nonce: number
  e: PainEvaluation
  settings: StimSettings
  site: ResolvedSite
  /** 地址里怎么写这个部位 / how the site is written in the URL */
  siteRef: SiteRef
  /** 按住施加：松手前刺激不结束 / applied by pressing: it lasts until release */
  holding: boolean
  /** 开始时把相机对准通路（预设部位和链接用；点击施加时不动相机）/ frame the pathway when it starts (preset sites and links; a click leaves the camera alone) */
  frame: boolean
  /** 整个时间过程的强度曲线（给图用）/ the intensity over the whole course, for the plot */
  curve: { t: number[]; intensity: number[] }
  baseline: PainSample
  weights: Float32Array
  /** 钝压的接触来自软组织物理时给出（否则用名义的 1 cm² 探头）/ set when a pressure stimulus takes its contact from the soft-tissue physics (otherwise the nominal 1 cm² probe) */
  contact: Contact | null
}

/**
 * 钝压的接触由谁给：软组织物理（src/softbody/client.ts）注册一个函数；它返回 null 时用名义值。
 * 函数可能要算几秒到几十秒（在 Web Worker 里），算出的接触随后进入疼痛模型。
 * Who supplies a pressure stimulus's contact: the soft-tissue physics (src/softbody/client.ts) registers a function; when
 * it returns null the nominal value is used. It may take seconds to tens of seconds (in a Web Worker); the contact it
 * finds then goes into the pain model.
 */
export type ContactProvider = (site: ResolvedSite, settings: StimSettings) => Promise<Contact | null> | null
let contactProvider: ContactProvider | null = null
export function registerContactProvider(fn: ContactProvider | null): void {
  contactProvider = fn
}

/** 每帧给视图的数据 / What the viewer gets every frame. */
export interface StimFrame {
  stim: ActiveStim
  t: number
  sample: PainSample
  /** 时间还在走 / the clock is still running */
  running: boolean
}

let body: { graph: unknown; promise: Promise<PainBody> } | null = null
let active: ActiveStim | null = null
let t = 0
let last = 0
let voiced = false
let published = 0
let nonce = 0
/** 验证用：时钟停在拨到的那一刻 / For verification: the clock stays where it was set. */
let frozen = false

async function innervationOf(name: string): Promise<InnervationTable> {
  // 两个表在 git 里（data/curated/skinmaps/），按体型动态引入 / the two tables are in git (data/curated/skinmaps/), imported per body on demand
  const m = name === 'female' ? await import('../../data/curated/skinmaps/innervation.female.json') : await import('../../data/curated/skinmaps/innervation.male.json')
  return m.default as unknown as InnervationTable
}

/** 当前人体的 PainBody（建一次，按 graph 缓存）；缺数据时抛出带说明的错误 / The PainBody of the current body (built once per graph); throws a descriptive error when data is missing. */
export function ensurePainBody(): Promise<PainBody> {
  const app = useApp.getState()
  const graph = app.graph
  if (!graph) return Promise.reject(new Error('人体还没有加载 / no body loaded yet'))
  if (body?.graph === graph) return body.promise
  const name = graph.data.body
  const promise = (async (): Promise<PainBody> => {
    if (name !== 'male' && name !== 'female') throw new Error('疼痛模型只支持男性和女性人体 / the pain model supports the male and female bodies only')
    const host = await whenHost()
    const base = `${import.meta.env.BASE_URL}anatomy/${app.dataset}/`
    const [skinMaps, rig, innervation, nerves] = await Promise.all([
      app.ensureSkinMaps(),
      app.ensureRig(),
      innervationOf(name),
      fetchJson<NervePath[]>(`${base}nerves.json`),
      host.request(['integumentary']),
    ])
    if (!skinMaps) throw new Error('这副人体没有体表图，无法定位刺激 / this body has no skin maps, so a stimulus cannot be located')
    const skin = host.skinRest()
    if (!skin || skin.part !== skinMaps.part) throw new Error('皮肤还没有加载 / the skin is not loaded')
    if (skin.positions.length !== skinMaps.vertexCount * 3) throw new Error('体表图与皮肤网格不符，需要重新生成 / the skin maps do not match the skin mesh and must be rebuilt')
    return {
      body: name,
      skin,
      skinMaps: skinMaps as unknown as PainBody['skinMaps'],
      innervation,
      nerves: nerves ?? [],
      parts: graph.parts as unknown as PainBody['parts'],
      // 没有绑定时没有反射姿势，其余照常 / without a rig there is no reflex pose; everything else works
      joints: rig?.rig.joints,
    }
  })()
  body = { graph, promise }
  promise.catch(() => {
    if (body?.promise === promise) body = null
  })
  return promise
}

function start(e: PainEvaluation, settings: StimSettings, site: ResolvedSite, siteRef: SiteRef, pb: PainBody, holding: boolean, keepClock: boolean, frame = false, contact: Contact | null = null): void {
  const n = 160
  const curve = { t: [] as number[], intensity: [] as number[] }
  const span = Math.max(e.horizon, 0.5)
  // 时间取平方间隔：开头几百毫秒变化最快，点密一些 / quadratic spacing in time: the first few hundred ms change fastest and get more points
  for (let i = 0; i <= n; i++) {
    const x = span * (i / n) ** 2
    curve.t.push(x)
    curve.intensity.push(e.sample(x).intensity)
  }
  active = { nonce: keepClock && active ? active.nonce : ++nonce, e, settings, site, siteRef, holding, frame, curve, baseline: e.sample(-1), weights: painMapWeights(pb, e.at(0).map), contact }
  if (!keepClock) {
    t = 0
    frozen = false
    voiced = false
  }
  published = 0
  useApp.setState({ stim: active, stimStatus: 'ready', stimMessage: '', stimNow: { t, sample: e.sample(t), running: true } })
}

/**
 * 在皮肤的一点施加刺激。应当在用户手势里调用（声音需要）。`hold`：按住施加，时长到松手为止。
 * Apply the stimulus at a point of the skin. Call it inside a user gesture (sound needs one). `hold`:
 * applied by pressing; it lasts until release.
 */
export async function applyStimulus(site: ResolvedSite | SiteRef, opts: { gesture?: boolean; hold?: boolean; settings?: StimSettings; frame?: boolean } = {}): Promise<boolean> {
  if (opts.gesture) primeVoice()
  const app = useApp.getState()
  const settings = opts.settings ?? app.stimSettings
  useApp.setState({ stimStatus: 'loading', stimMessage: '' })
  try {
    const pb = await ensurePainBody()
    if (useApp.getState().graph !== app.graph) return false
    const resolved = 'vertex' in site ? site : resolveSite(pb, site)
    const siteRef: SiteRef = 'vertex' in site ? { mm: [site.position[0] * 1000, site.position[1] * 1000, site.position[2] * 1000] } : site
    // 钝压：有软组织物理时先算接触（几秒到几十秒），疼痛模型用算出的压强；这时不支持"按住施加"（算完之前可能已经松手）
    // pressure: with the soft-tissue physics the contact is computed first (seconds to tens of seconds) and the pain model takes
    // that pressure; "press and hold" is not offered then (the hand may be lifted before the solve ends)
    const pending = settings.kind === 'pressure' ? contactProvider?.(resolved, settings) ?? null : null
    const contact = pending ? await pending : null
    if (pending && !contact) {
      // 物理那边放弃了（换了部位、换了人体）：不施加 / the physics side gave up (another site, another body): nothing applied
      useApp.setState({ stimStatus: 'idle' })
      return false
    }
    if (useApp.getState().graph !== app.graph) return false
    const hold = !!opts.hold && !contact
    const duration = hold ? kindSpec(settings.kind).durationMax : settings.duration
    const e = prepareStimulus(pb, buildStimulus(settings, resolved, pb.skin.part, duration, contact), { heatAnchor: settings.heatAnchor })
    // 皮肤得看得见：疼痛分布层画在它上面 / the skin has to be visible: the pain layer is drawn on it
    if (!(useApp.getState().systems.integumentary?.visible ?? true)) useApp.getState().setSystemVisible('integumentary', true)
    start(e, settings, resolved, siteRef, pb, hold, false, !!opts.frame, contact)
    // 表情、张口和神经都要用到 / the face, the jaw and the nerves are all needed
    void app.ensureFace()
    void host?.request(['nervous'])
    return true
  } catch (err) {
    console.warn('[soma] stimulus failed', err)
    useApp.setState({ stimStatus: 'error', stimMessage: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/** 松手：按住施加的刺激在此刻结束（同一个时钟继续走）/ Release: a pressed stimulus ends now (the same clock carries on). */
export async function releaseStimulus(): Promise<void> {
  const a = active
  if (!a || !a.holding) return
  const pb = await ensurePainBody()
  if (active !== a) return
  const settings = { ...a.settings, duration: Math.max(0.2, Math.round(t * 100) / 100), repeat: null }
  const e = prepareStimulus(pb, buildStimulus(settings, a.site, pb.skin.part, settings.duration, a.contact), { heatAnchor: settings.heatAnchor })
  start(e, settings, a.site, a.siteRef, pb, false, true, false, a.contact)
}

/** 把同一个刺激再放一遍（部位不变，用当前的设置）/ Play the stimulus again at the same site with the current settings. */
export function replayStimulus(gesture = true): Promise<boolean> {
  return active ? applyStimulus(active.site, { gesture }) : Promise.resolve(false)
}

export function clearStimulus(): void {
  active = null
  setExternalPainLevel(0)
  useApp.setState({ stim: null, stimNow: null, stimStatus: 'idle', stimMessage: '' })
}

/**
 * 每帧调用一次（主视图）：推进时钟并取样。页面隐藏时没有帧，时钟也就停着；单帧最多前进 0.1 秒。
 * Called once per frame (main viewer): advances the clock and samples. No frames while the page is
 * hidden, so the clock stands still; one frame advances at most 0.1 s.
 */
export function stimFrame(now: number): StimFrame | null {
  const a = active
  if (!a) {
    last = now
    return null
  }
  if (useApp.getState().stim !== a) {
    // 换了人体或被清掉 / the body changed or it was cleared
    active = null
    setExternalPainLevel(0)
    return null
  }
  const end = a.holding ? Infinity : a.e.horizon
  const running = t < end
  if (running && !frozen) t = Math.min(end, t + Math.min(0.1, Math.max(0, (now - last) / 1000)))
  last = now
  const sample = a.e.sample(t)
  setExternalPainLevel(sample.intensity)
  if (!voiced && a.e.peak.intensity > 0 && t >= a.e.output.startAt) {
    voiced = true
    void vocalise(a.e.output.level, a.e.output.onset)
  }
  // 给界面的数每秒更新约 8 次；视图自己每帧取 / the UI's numbers update about 8 times a second; the viewer samples every frame
  if (now - published > 120 || !running) {
    if (running || published !== -1) useApp.setState({ stimNow: { t, sample, running } })
    published = running ? now : -1
  }
  return { stim: a, t, sample, running }
}

/** 验证和测试用：直接把时钟拨到某一刻 / For verification and tests: set the clock directly. */
export function seekStimulus(seconds: number, freeze = false): void {
  t = seconds
  frozen = freeze
  published = 0
}

export function stimClock(): number {
  return t
}

/** 测试用 / For tests. */
export function resetStim(): void {
  active = null
  body = null
  t = 0
  last = 0
  voiced = false
  published = 0
}
