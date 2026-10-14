// URL ↔ store：加载时按 URL 恢复状态，之后把状态的变化写回地址栏（不产生历史记录）。
// URL ↔ store: restore state from the URL on load, then write state changes back to the
// address bar (without adding history entries).

import { TREE_KINDS, type AnatomyGraph, type TreeKind } from '../anatomy/graph.ts'
import { posePresets } from '../anatomy/rig.ts'
import { loadDemoClip, playSay, setSayMode } from '../face/say.ts'
import { applyStimulus } from '../pain/stim.ts'
import { prepareSoftFromUrl, registerSoftUrlWriter, startSoftFromUrl } from '../softbody/client.ts'
import { nonDefaultControls } from '../anatomy/shape.ts'
import type { SystemId } from '../anatomy/types.ts'
import type { SystemState } from './display.ts'
import { DEFAULT_HAIR_COLOUR } from '../hair/colour.ts'
import { useApp, type AppState } from './store.ts'
import { MAX_URL_DOFS, MAX_URL_IDS, formatUrl, parseUrl, poseDofCount, type UrlState } from './urlState.ts'

export interface ResolvedTokens {
  ids: string[]
  /** 只有一个标记且它是概念时给出 / Set when there is exactly one token and it is a concept. */
  concept: { tree: TreeKind; id: string } | null
  unknown: string[]
}

/**
 * 把 URL 里的标记解析成部件：先当作部件 id，不是的话当作概念 id（展开为其下全部部件）。
 * Resolve URL tokens to parts: a part id first, else a concept id (expanded to all its parts).
 */
export function resolveTokens(graph: AnatomyGraph, tokens: readonly string[]): ResolvedTokens {
  const ids = new Set<string>()
  const unknown: string[] = []
  let concept: ResolvedTokens['concept'] = null
  for (const t of tokens) {
    if (graph.part(t)) {
      ids.add(t)
      continue
    }
    const tree = TREE_KINDS.find((k) => graph.concept(k, t) && graph.partCount(k, t) > 0) ?? TREE_KINDS.find((k) => graph.concept(k, t))
    if (!tree) {
      unknown.push(t)
      continue
    }
    for (const id of graph.descendantParts(tree, t)) ids.add(id)
    if (tokens.length === 1) concept = { tree, id: t }
  }
  return { ids: [...ids], concept, unknown }
}

/** 从 URL 恢复时记下的原始标记：只要集合没变，就原样写回（概念 id 比几百个部件 id 短得多）。 */
/** Tokens remembered from the URL: written back verbatim while the set is unchanged (a concept id is far shorter than hundreds of part ids). */
const hints: { iso?: { tokens: string[]; set: ReadonlySet<string> }; hide?: { tokens: string[]; set: ReadonlySet<string> }; focus?: boolean } = {}
let passthrough: [string, string][] = []
/** 相机：由查看器报告；只有用户动过或 URL 给过才写进 URL / Camera, reported by the viewer; written only once the user moved it or the URL set it. */
let camera: UrlState['cam'] | undefined

/**
 * 更新一个不归本模块管的参数（肌肉活动的 act / load / grav），并安排写回地址栏；value 为 null 时去掉它。
 * Update a parameter this module does not own (act / load / grav of the muscle-activity display) and schedule the
 * write-back; null removes it.
 */
export function setPassthroughParam(key: string, value: string | null): void {
  passthrough = passthrough.filter(([k]) => k !== key)
  if (value !== null) passthrough.push([key, value])
  schedule()
}

export function setUrlCamera(cam: UrlState['cam'] | undefined): void {
  camera = cam
  if (cam) hints.focus = false
  schedule()
}

/** 当前 store 状态对应的 URL 状态 / The URL state for the current store state. */
export function snapshot(s: AppState): UrlState {
  const out: UrlState = {}
  if (s.dataset) out.body = s.dataset
  if (s.embed) out.embed = true
  if (s.leftTab !== 'display') out.tab = s.leftTab
  const systems = s.systemsBeforeCompare ?? s.systems
  const entries = Object.entries(systems) as [SystemId, SystemState][]
  if (entries.some(([, v]) => !v.visible || Math.round(v.opacity * 100) !== 100)) {
    out.sys = entries.filter(([, v]) => v.visible).map(([id, v]) => ({ id, opacity: v.opacity }))
  }
  if (s.compare) out.cmp = s.compare.system
  if (s.peel > 0) out.peel = s.peel
  const idList = (set: ReadonlySet<string>, hint: typeof hints.iso): string[] | undefined => {
    if (hint && hint.set === set) return hint.tokens
    return set.size > 0 && set.size <= MAX_URL_IDS ? [...set] : undefined
  }
  if (s.isolated) out.iso = idList(s.isolated, hints.iso)
  if (s.hidden.size) out.hide = idList(s.hidden, hints.hide)
  if (s.selection.concept) out.sel = [s.selection.concept.id]
  else if (s.selection.ids.length > 0 && s.selection.ids.length <= MAX_URL_IDS) out.sel = [...s.selection.ids]
  if (s.adjacentMode) out.adj = true
  if (camera) out.cam = camera
  else if (hints.focus) out.focus = true
  if (s.section.enabled) out.cut = { axis: s.section.axis, position: s.section.position, flip: s.section.flip }
  if (s.explode > 0) out.xp = s.explode
  if (s.posePreset) out.pose = { preset: s.posePreset }
  else {
    const n = poseDofCount(s.pose)
    if (n > 0 && n <= MAX_URL_DOFS) out.pose = { angles: s.pose }
  }
  if (s.breathing) out.breath = true
  if (s.skinMapMode !== 'off') {
    out.map = s.skinMapMode
    if (s.skinRegions.length) out.reg = [...s.skinRegions]
    if (s.skinSeeThrough) out.see = true
  }
  if (s.pain.hold && s.pain.level > 0) out.pain = s.pain.level
  if (Object.keys(s.aus).length) out.au = { ...s.aus }
  if (s.expr && s.expr.strength > 0) out.expr = { ...s.expr }
  if (s.viseme) out.vis = s.viseme
  // 只有示范片段进 URL；合成用的文字不进（链接要短，也不该带着用户输入的话）
  // only a demo clip goes into the URL; text typed for synthesis does not (links stay short and carry nothing the user wrote)
  if (s.say.source === 'demo' && s.say.clip) {
    out.say = s.say.clip
    if (s.say.mode === 'audio') out.drive = 'audio'
  }
  if (s.speechStyle) out.style = s.speechStyle
  if (s.skinOpaque) out.skin = true
  if (!s.look) out.look = false
  if (s.tone !== null) out.tone = s.tone
  // 接触来自软组织物理的钝压由 phys= 记录（见 src/softbody/client.ts），不再写 stim= / a pressure whose contact came from the soft-tissue physics is recorded by phys= (see src/softbody/client.ts), not stim=
  if (s.stim && !s.stim.contact) out.stim = { settings: s.stim.settings, site: s.stim.siteRef }
  if (s.iris !== 'brown') out.iris = s.iris
  if (s.gaze !== 'camera') out.gaze = { ...s.gaze }
  if (!s.blink) out.blink = false
  if (s.hairStyle) out.hair = s.hairStyle
  if (s.hairColor !== DEFAULT_HAIR_COLOUR) out.hc = s.hairColor
  if (s.stim) out.stim = { settings: s.stim.settings, site: s.stim.siteRef }
  if (Object.keys(s.shapeControls).length) out.shape = s.shape ? nonDefaultControls(s.shape.data, s.shapeControls) : { ...s.shapeControls }
  if (s.colorMode === 'source') out.src = true
  return out
}

/**
 * 把解析好的 URL 状态应用到 store（人体已加载之后调用）。返回警告；任何一项无效都只是跳过。
 * Apply a parsed URL state to the store (call once the body is loaded). Returns warnings; an
 * invalid item is simply skipped.
 */
export async function restoreFromUrl(state: UrlState): Promise<string[]> {
  const warnings: string[] = []
  const app = useApp.getState()
  const graph = app.graph
  if (!graph) return ['没有已加载的人体 / no body is loaded']
  // 软组织物理的 phys= / grav=：先设好状态（链接里的钝压要用到），最后再开始 / phys= / grav= of the soft-tissue physics: state first (a linked pressure needs it), started at the end
  registerSoftUrlWriter(setPassthroughParam)
  const search = typeof location === 'undefined' ? '' : location.search
  warnings.push(...prepareSoftFromUrl(search))
  const resolve = (key: string, tokens: readonly string[]): ResolvedTokens => {
    const r = resolveTokens(graph, tokens)
    if (r.unknown.length) warnings.push(`${key}: 此人体中没有 ${r.unknown.slice(0, 5).join(', ')} / not in this body`)
    return r
  }

  if (state.sys) {
    const systems: Partial<Record<SystemId, SystemState>> = {}
    for (const sys of graph.data.systems) {
      const hit = state.sys.find((x) => x.id === sys.id)
      systems[sys.id] = { visible: !!hit, opacity: hit?.opacity ?? 1 }
    }
    const absent = state.sys.filter((x) => !graph.data.systems.some((sys) => sys.id === x.id))
    if (absent.length) warnings.push(`sys: 此人体没有 ${absent.map((x) => x.id).join(', ')} / not in this body`)
    useApp.setState({ systems })
  }
  if (state.peel !== undefined) app.setPeel(Math.min(state.peel, Math.max(0, graph.data.layers.length - 1)))
  if (state.hide) {
    const r = resolve('hide', state.hide)
    const set = new Set(r.ids)
    useApp.setState({ hidden: set })
    hints.hide = { tokens: [...state.hide], set }
  }
  if (state.iso) {
    const r = resolve('iso', state.iso)
    if (r.ids.length) {
      const set = new Set(r.ids)
      useApp.setState({ isolated: set })
      hints.iso = { tokens: [...state.iso], set }
    }
  }
  if (state.map) {
    app.setSkinMapMode(state.map)
    const maps = await useApp.getState().ensureSkinMaps()
    const map = maps?.maps.find((m) => m.id === state.map)
    if (!map) warnings.push('map: 此人体没有这张体表图 / this body lacks this skin map')
    else if (state.reg) {
      const ok = state.reg.filter((r) => r < map.regions.length)
      if (ok.length !== state.reg.length) warnings.push('reg: 忽略了越界的区域下标 / ignored out-of-range region indices')
      useApp.setState({ skinRegions: ok })
    }
  }
  if (state.sel) {
    const r = resolve('sel', state.sel)
    if (r.concept) useApp.getState().selectConcept(r.concept.tree, r.concept.id)
    else if (r.ids.length) {
      // selectParts 不会动体表图区域，区域高亮得以保留 / selectParts leaves skin map regions alone, so the highlight survives
      useApp.getState().selectParts(r.ids)
    }
  }
  if (state.see && state.map) useApp.getState().setSkinSeeThrough(true)
  if (state.adj) app.setAdjacentMode(true)
  if (state.cut) app.setSection({ enabled: true, ...state.cut })
  if (state.xp !== undefined) app.setExplode(state.xp)
  if (state.src) app.setColorMode('source')
  if (state.skin) app.setSkinOpaque(true)
  if (state.look === false) app.setLook(false)
  if (state.tone !== undefined) app.setTone(state.tone)
  if (state.iris) app.setIris(state.iris)
  if (state.gaze) app.setGaze(state.gaze)
  if (state.blink === false) app.setBlink(false)
  if (state.hair) app.setHairStyle(state.hair)
  if (state.hc) app.setHairColor(state.hc)
  if (state.pain !== undefined || state.au) {
    // 只恢复表情（保持在给定强度）；声音必须由用户手势触发，这里绝不出声
    // only the expression is restored (held at the given level); sound needs a user gesture and is never started here
    if (state.pain !== undefined) useApp.getState().setPain({ level: state.pain, hold: state.pain > 0 })
    const face = await useApp.getState().ensureFace()
    if (!face) warnings.push('pain: 此人体没有表情数据 / this body has no facial expression data')
    else if (state.au) {
      for (const [id, v] of Object.entries(state.au)) {
        if (face.data.aus.some((a) => a.id === id)) useApp.getState().setAU(id, v)
        else warnings.push(`au: 模型里没有 ${id} / the model has no ${id}`)
      }
    }
  }
  if (state.expr || state.vis) {
    // 表情和口形只靠数据，不出声：链接一打开就自己摆好 / an expression and a mouth shape need data only and make no sound: a link sets them up by itself
    const face = await useApp.getState().ensureFace()
    if (!face) warnings.push('expr: 此人体没有表情数据 / this body has no facial expression data')
    else {
      if (state.expr) {
        // id 不分大小写 / ids are matched without regard to case
        const e = face.data.expressions?.find((x) => x.id.toLowerCase() === state.expr!.id.toLowerCase())
        if (e) useApp.getState().setExpr({ id: e.id, strength: state.expr.strength })
        else warnings.push(`expr: 没有表情 "${state.expr.id}"（可用：${(face.data.expressions ?? []).map((e) => e.id).join(' ')}）/ no such expression`)
      }
      if (state.vis) {
        const v = face.data.visemes?.visemes.find((x) => x.id.toLowerCase() === state.vis!.toLowerCase())
        if (v) useApp.getState().setViseme(v.id)
        else warnings.push(`vis: 没有视位 "${state.vis}"（可用：${(face.data.visemes?.visemes ?? []).map((v) => v.id).join(' ')}）/ no such viseme`)
      }
    }
  }
  if (state.style) useApp.getState().setSpeechStyle(state.style)
  if (state.say) {
    // 链接里的示范片段：装好就自己开始。页面还没有过用户手势时浏览器不让出声，口形按页面时钟无声地走（嵌入时循环），
    // 界面上有一个"声音"按钮。
    // a demo clip from a link: it starts by itself once loaded. Before any user gesture the browser allows no sound, so the mouth
    // runs silently on the page clock (looping when embedded) and the UI offers a "sound" button.
    // 带动方式先设好，片段一开始就按它走 / the drive mode is set first, so the clip starts with it
    if (state.drive) setSayMode(state.drive === 'audio' ? 'audio' : 'phonemes')
    const face = await useApp.getState().ensureFace()
    if (!face) warnings.push('say: 此人体没有表情数据 / this body has no facial expression data')
    else if (!(await loadDemoClip(state.say))) warnings.push(`say: ${useApp.getState().say.message || '无法装入 / could not be loaded'}`)
    else void playSay({ sound: true, loop: !!state.embed })
  }
  if (state.tab) app.setLeftTab(state.tab)
  if (state.cmp) {
    if (graph.data.systems.some((x) => x.id === state.cmp && x.partCount > 0)) app.setCompare(state.cmp)
    else warnings.push('cmp: 此人体没有这个系统 / this body lacks that system')
  }
  if (state.shape) {
    const shape = await useApp.getState().ensureShape()
    if (!shape) warnings.push('shape: 此人体没有体型数据 / this body has no shape data')
    else {
      for (const [id, v] of Object.entries(state.shape)) {
        const c = shape.data.controls.find((x) => x.id === id)
        if (!c) continue
        if (v < c.valid.min - 1e-9 || v > c.valid.max + 1e-9) warnings.push(`shape: ${id}=${v} 超出此人体的可用范围 ${c.valid.min}…${c.valid.max}，已截断 / outside this body's valid range, clamped`)
        useApp.getState().setShapeControl(c.id, v)
      }
      useApp.setState({ shapeLimit: null })
    }
  }
  if (state.stim) {
    // 链接里的刺激：设好工具并自己开始（没有用户手势，所以没有声音）
    // a stimulus from a link: the tool is set and it starts by itself (no user gesture, hence no sound)
    useApp.setState({ stimSettings: state.stim.settings })
    const ok = await applyStimulus(state.stim.site, { settings: state.stim.settings, frame: !state.cam })
    if (!ok) warnings.push(`stim: ${useApp.getState().stimMessage || '无法施加 / could not be applied'}`)
    // 解释面板在"疼痛"页里 / the explanation lives in the Pain tab
    else if (!state.tab) useApp.getState().setLeftTab('pain')
  }
  if (state.pose || state.breath) {
    const rig = await useApp.getState().ensureRig()
    if (!rig) warnings.push('pose: 此人体暂不能摆姿势 / posing is unavailable for this body')
    else {
      if (state.pose && 'preset' in state.pose) {
        const id = state.pose.preset
        if (posePresets(rig.rig.joints).some((p) => p.id === id)) useApp.getState().applyPosePreset(id)
        else warnings.push(`pose: 没有预设 "${id}" / no such preset`)
      } else if (state.pose) {
        const pose: Record<string, number[]> = {}
        for (const [joint, a] of Object.entries(state.pose.angles)) {
          const j = rig.rig.joints.find((x) => x.id === joint)
          if (!j) {
            warnings.push(`pose: 没有关节 "${joint}" / no such joint`)
            continue
          }
          // 夹到活动范围内 / clamped to the range of motion
          pose[joint] = j.dofs.map((d, k) => Math.min(d.max, Math.max(d.min, a[k] ?? 0)))
        }
        useApp.getState().setPose(pose, { animate: true })
      }
      if (state.breath) useApp.getState().setBreathing(true)
    }
  }
  warnings.push(...(await startSoftFromUrl(search, { frame: !state.cam })))
  if (state.cam) {
    useApp.setState((s) => ({ cameraRequest: { nonce: (s.cameraRequest?.nonce ?? 0) + 1, p: state.cam!.p, t: state.cam!.t } }))
    camera = state.cam
  } else if (state.focus) {
    hints.focus = true
    const frame = (): void => {
      const s = useApp.getState()
      s.requestFocus(s.selection.ids.length ? null : s.isolated ? [...s.isolated] : null)
    }
    // 有姿势时等过渡结束再取景，这样对准的是摆好之后的位置
    // with a pose, frame after the transition so the camera aims at the posed position
    if (state.pose && typeof window !== 'undefined') setTimeout(frame, 900)
    else frame()
  }
  return warnings
}

let timer: ReturnType<typeof setTimeout> | null = null
let active = false

function schedule(): void {
  if (!active || typeof window === 'undefined') return
  if (timer) clearTimeout(timer)
  // 防抖：拖动滑块或相机时不逐帧改地址栏 / debounced: no per-frame address-bar updates while dragging
  timer = setTimeout(() => {
    timer = null
    const query = formatUrl(snapshot(useApp.getState()), passthrough)
    const url = `${location.pathname}${query ? `?${query}` : ''}${location.hash}`
    if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(null, '', url)
  }, 350)
}

/** 当前状态的完整链接（"复制链接"用）/ The full link for the current state (for "copy link"). */
export function currentLink(opts: { embed?: boolean } = {}): string {
  const state = snapshot(useApp.getState())
  if (opts.embed !== undefined) state.embed = opts.embed
  const query = formatUrl(state, passthrough)
  return `${location.origin}${location.pathname}${query ? `?${query}` : ''}`
}

/**
 * 读取地址栏：返回要恢复的状态，并开始把之后的变化写回去（在 `restoreFromUrl` 完成后调用 `begin`）。
 * Read the address bar: returns the state to restore; call `begin` once `restoreFromUrl` is
 * done to start writing later changes back.
 */
export function readLocation(): { state: UrlState; keys: string[]; begin: () => () => void } {
  const parsed = parseUrl(location.search)
  for (const w of parsed.warnings) console.warn(`[soma] URL: ${w}`)
  passthrough = parsed.passthrough
  return {
    state: parsed.state,
    keys: Object.keys(parsed.state),
    begin: () => {
      active = true
      const unsubscribe = useApp.subscribe((s, p) => {
        // 悬停等高频、与 URL 无关的变化不触发写回 / high-frequency changes the URL does not carry (hover…) do not trigger a write
        if (s.hover !== p.hover || s.skinHover !== p.skinHover || s.load !== p.load || s.rigProgress !== p.rigProgress || s.voiceProgress !== p.voiceProgress) return
        schedule()
      })
      schedule()
      return () => {
        active = false
        unsubscribe()
        if (timer) clearTimeout(timer)
      }
    },
  }
}

/** 测试用：清掉模块内记住的 URL 提示 / For tests: clear what the module remembers from a URL. */
export function resetUrlSync(): void {
  delete hints.iso
  delete hints.hide
  delete hints.focus
  camera = undefined
  passthrough = []
}
