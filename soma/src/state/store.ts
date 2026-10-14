// 应用状态。查看器订阅这个 store 并把它映射到场景；React 组件通过 `useApp` 读取。
// Application state. The viewer subscribes to this store and mirrors it into the scene;
// React components read it through `useApp`.

import { create } from 'zustand'
import { mapPartsBetween, type AnatomyGraph, type TreeKind } from '../anatomy/graph.ts'
import { clampControl, loadShape, shapeScales, type LoadedShape, type ShapeControlId, type ShapeControls } from '../anatomy/shape.ts'
import { loadRig, posePresets, poseIsRest, withDof, type LoadedRig, type Pose, type Scales } from '../anatomy/rig.ts'
import type { PainSample } from '../painmodel/index.ts'
import type { ActiveStim } from '../pain/stim.ts'
import type { DemoRecording } from '../face/say.ts'
import { defaultSettings, kindSpec, withKind, type StimSettings } from '../pain/stimulus.ts'
import { fetchJson } from '../anatomy/load.ts'
import { loadDetail, type LoadedDetail } from '../pain/detail.ts'
import { type LoadedSkinUv, loadSkinUv } from '../look/load.ts'
import { DEFAULT_IRIS, type GazeSetting, type IrisName } from '../look/types.ts'
import type { HairStyle } from '../look/types.ts'
import { DEFAULT_HAIR_COLOUR, type HairColour } from '../hair/colour.ts'
import { loadFace, type AUs, type LoadedFace } from '../pain/face.ts'
import { loadSkinMaps, regionParts, regionsForParts, type LoadedSkinMaps, type SkinMapId } from '../anatomy/skinmaps.ts'
import type { Provenance, SystemId } from '../anatomy/types.ts'
import type { SectionState, SystemState } from './display.ts'

export interface Selection {
  /** 所选部件的 id，顺序稳定。 */
  /** Selected part ids, in a stable order. */
  ids: readonly string[]
  set: ReadonlySet<string>
  /** 选择来自某个概念（结构树、搜索、路径）时设置。 */
  /** Set when the selection came from choosing a concept (tree, search, breadcrumb). */
  concept: { tree: TreeKind; id: string } | null
}

export const EMPTY_SELECTION: Selection = { ids: [], set: new Set(), concept: null }

export type LeftTab = 'display' | 'tree' | 'pose' | 'pain' | 'expr'

/** 保持的情绪表情：FaceExpression.id 和强度 0–1 / The held emotion expression: a FaceExpression.id and a strength 0–1. */
export interface ExprSetting {
  id: string
  strength: number
}

/** "由音频带动口形"的状态；音频本身和口形轨迹在 src/face/speech.ts 里 / State of "speak from audio"; the audio and its mouth track live in src/face/speech.ts. */
export interface SpeechStatus {
  status: 'idle' | 'analysing' | 'ready' | 'playing' | 'error'
  name: string
  durationS: number
  message: string
}

/**
 * "说一句话"（由音素带动口形）的状态；声音、时间线和时钟在 src/face/say.ts 里。合成用的文字不放在这里之外的任何地方，也不进 URL。
 * State of "say something" (phoneme-driven speech); the audio, the timeline and the clock live in src/face/say.ts. Text typed
 * for synthesis goes nowhere else and never into the URL.
 */
export interface SayStatus {
  status: 'idle' | 'loading' | 'ready' | 'playing' | 'error'
  /** 示范片段的 id（写进 URL 的 say=）；合成的话为 null / the id of a demo clip (written to the URL as say=); null for synthesized text. */
  clip: string | null
  source: 'demo' | 'tts' | null
  text: string
  lang: 'en' | 'zh' | null
  voice: string
  durationS: number
  /** 这次播放有没有声音：false = 浏览器没允许出声，口形按时钟走 / whether this playback is audible: false = the browser did not allow sound and the mouth runs on the clock. */
  sound: boolean
  /** 口形由什么带动：音素时间线（准确），或对同一段声音做的分析（近似）/ what drives the mouth: the phoneme timeline (accurate) or an analysis of the same audio (approximate). */
  mode: 'phonemes' | 'audio'
  /** 出错时后端或页面给的信息，原样显示 / the message of the backend or the page on an error, shown verbatim. */
  message: string
  warnings: { word: string; note: string }[]
  /** 合成这段声音的模型；真人录音时为 null / the model that synthesized the audio; null for a recorded voice. */
  model: { name: string; version: string; licence: string } | null
  /** 真人录音的出处（语料库里的编号、书名、时间线怎么来的）；机器合成的为 null / where a recording comes from (its numbers in the corpus, the book, how the timeline was made); null when machine-synthesized. */
  recording: DemoRecording | null
  /** 片段所在的包的许可说明 / the licence statement of the clip's pack. */
  licence: string
}

/** 疼痛反应的设定：强度 0–10、起病方式、是否保持、是否静音。 */
/** Settings of the pain response: intensity 0–10, onset, whether held, whether muted. */
export interface PainSettings {
  level: number
  onset: 'sudden' | 'sustained'
  hold: boolean
  muted: boolean
  /** 每次触发都出声（跳过模型里"这一次不出声"的概率）/ Vocalise on every trigger (skip the model's chance of staying silent). */
  always: boolean
}

/** 'tissue'：按组织着色；'source'：按几何来源着色。 */
/** 'tissue': anatomical colours; 'source': colour by where the geometry came from. */
export type ColorMode = 'tissue' | 'source'

export interface LoadState {
  phase: 'loading' | 'ready' | 'error'
  /** 0 到 1 */
  /** 0..1 */
  progress: number
  message: string
  /** 几何已到达的系统（用于逐系统的加载状态）。 */
  /** Systems whose geometry has arrived (for the per-system loading status). */
  loaded: readonly SystemId[]
  /** 已下载 / 预计的几何字节数（预计值未知时为 0）/ Geometry bytes received / expected (0 when the total is unknown). */
  bytes?: number
  bytesTotal?: number
}

/** 按人体记录其注意事项已读。存储可能不可用。 */
/** Remembers, per body, that its caution list has been read. Storage may be unavailable. */
export function cautionsSeenKey(dataset: string, count: number): string {
  return `soma.cautions.${dataset}.${count}`
}

function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // 隐私模式或存储被禁用：下次再显示一次即可
    // private mode / blocked storage: the list simply shows again next time
  }
}

export interface AppState {
  load: LoadState
  /** 实际使用的数据集目录（"male"、"fixture" 等）。 */
  /** Dataset directory actually in use ("male", "fixture", …). */
  dataset: string
  /** 用户请求的数据集；应用加载后 `dataset` 随之更新。 */
  /** Dataset the user asked for; the app loads it and then `dataset` follows. */
  requestedBody: string
  cautionsOpen: boolean
  /** 嵌入模式（?embed=1）：只有舞台和必要控件，不弹对话框 / Embed mode (?embed=1): stage and essential controls only, no dialogs. */
  embed: boolean
  /** 当前姿势来自哪个预设（之后改过任何角度则为 null）/ The preset the pose came from (null once any angle was changed). */
  posePreset: string | null
  /** 递增以请求查看器把相机放到给定的位置和目标 / Bumped to ask the viewer to put the camera at a position and target. */
  cameraRequest: { nonce: number; p: [number, number, number]; t: [number, number, number] } | null
  /** 与另一人体并排对照，限定一个系统。 */
  /** Side-by-side comparison with the other body, restricted to one system. */
  compare: { system: SystemId } | null
  systemsBeforeCompare: Partial<Record<SystemId, SystemState>> | null
  /** 可关闭横幅中显示的非致命提示（回退、缺文件）。 */
  /** Non-fatal notices shown in a dismissible banner (fallbacks, missing files). */
  notices: string[]
  graph: AnatomyGraph | null

  systems: Partial<Record<SystemId, SystemState>>
  peel: number
  hidden: ReadonlySet<string>
  isolated: ReadonlySet<string> | null
  adjacentMode: boolean
  colorMode: ColorMode
  provenanceHidden: ReadonlySet<Provenance>
  /** 神经至少按固定的屏幕宽度绘制，全身视图下也能看见。 */
  /** Draw nerves at a minimum on-screen width so they can be seen at body scale. */
  nerveBoost: boolean
  /** 体表图：关闭，或显示哪一张 / Skin map: off, or which one is shown. */
  skinMapMode: 'off' | SkinMapId
  /** 当前人体的体表图；首次使用时才加载 / This body's skin maps, loaded on first use. */
  skinMaps: LoadedSkinMaps | null
  skinMapsStatus: 'idle' | 'loading' | 'ready' | 'missing' | 'error'
  /** 当前体表图中高亮的区域索引 / Highlighted region indices in the active map. */
  skinRegions: readonly number[]
  skinHover: number | null
  /** 皮肤半透明以露出其下的支配神经 / Skin drawn see-through to reveal the supplying nerve. */
  skinSeeThrough: boolean
  /** 当前人体的骨架绑定；首次打开"姿势"面板时才加载 / This body's rig, loaded when the Pose panel is first used. */
  rig: LoadedRig | null
  rigStatus: 'idle' | 'loading' | 'ready' | 'missing' | 'stale' | 'error'
  rigMessage: string
  rigProgress: number
  /** 目标姿势：关节 id → 各自由度的角度（弧度，相对静止姿势）/ Target pose: joint id → angle per dof (radians from rest). */
  pose: Pose
  /** 递增表示"过渡到当前姿势"（约 0.6 秒），否则立即应用 / Bumped to ask for a ~0.6 s transition to `pose`; otherwise it applies at once. */
  poseAnimate: number
  poseMirror: boolean
  breathing: boolean
  /** 正在操作的关节（显示操纵环和关节信息）/ The joint being manipulated (gizmo and joint info). */
  poseJoint: string | null
  jointScales: Scales | null
  /** 当前人体的体型数据；首次使用体型控制时才加载 / This body's shape data, loaded when the shape controls are first used. */
  shape: LoadedShape | null
  shapeStatus: 'idle' | 'loading' | 'ready' | 'missing' | 'error'
  shapeMessage: string
  /** 体型控制量；缺省的取该人体的默认值（身体保持原样）/ Shape control values; a missing one is the body's default (as built). */
  shapeControls: ShapeControls
  /** 最近一次被可用范围截断的控制量（界面据此显示原因）/ The control last cut by its valid range (the UI shows why). */
  shapeLimit: { id: ShapeControlId; side: 'min' | 'max' } | null
  /** 当前人体的面部表情数据；首次使用"疼痛反应"时才加载 / This body's facial expression data, loaded when the pain response is first used. */
  face: LoadedFace | null
  /**
   * 皮肤不透明时要隐藏的部件，取自这副人体的 display.json（管线写的一个小文件）的 hideWithOpaqueSkin：
   * undefined = 还没读；null = 这副人体没有这个文件（改用按名称的规则：头发、眉毛、阴毛）；数组 = 文件给的清单。
   * Parts to hide while the skin is opaque, from hideWithOpaqueSkin of this body's display.json (a small file the
   * pipeline writes): undefined = not read yet; null = this body has no such file (the name rule applies instead:
   * hair, eyebrows, pubic hair); an array = the list the file gives.
   */
  skinHide: readonly string[] | null | undefined
  /** 皱纹细节层（面部 UV + 法线图集）；皮肤画成不透明时才去取 / The wrinkle detail layer (face UV + normal atlas); fetched only once the skin is drawn opaque. */
  faceDetail: LoadedDetail | null
  /** 写实皮肤的 UV 网格；皮肤画成不透明、要写实外观时才去取 / The lifelike skin's UV mesh; fetched only once the skin is drawn opaque with the lifelike look on. */
  skinUv: LoadedSkinUv | null
  faceStatus: 'idle' | 'loading' | 'ready' | 'missing' | 'error'
  faceMessage: string
  pain: PainSettings
  /** 手动设定的 AU 强度（0–5），与疼痛表情逐项取较大者 / Manually set AU intensities (0–5), combined with the pain expression by maximum. */
  aus: AUs
  /** 保持的情绪表情（与疼痛、手动 AU 逐项取较大者）；null = 没有 / The held emotion expression (combined with pain and manual AUs by maximum); null = none. */
  expr: ExprSetting | null
  /** 保持的视位（一个口形）的 id；null = 没有 / The id of the held viseme (one mouth shape); null = none. */
  viseme: string | null
  speech: SpeechStatus
  say: SayStatus
  /**
   * 说话的风格：'normal' 正常朗读（按实测标定），'clear' 夸张；null = 缺省（保持的口形用夸张，说话用正常）。
   * The style of speech: 'normal' read speech (calibrated against measurements), 'clear' exaggerated; null = the default
   * (clear for held shapes, normal for speech).
   */
  speechStyle: 'normal' | 'clear' | null
  /** "标定对照"对话框 / The "Calibration" dialog. */
  calibrationOpen: boolean
  /** 每触发一次加一（让查看器开始逐帧更新）/ Bumped on every trigger (so the viewer starts updating every frame). */
  painNonce: number
  /** 刺激工具的设置；armed 时点（或按住）皮肤就施加刺激，而不是选中 / The stimulus tool's settings; while armed, a click (or press) on the skin applies it instead of selecting. */
  stimSettings: StimSettings
  stimArmed: boolean
  /** 正在进行（或刚结束）的一次刺激及其模型结果；由 src/pain/stim.ts 写入 / The stimulus in progress (or just finished) with the model's result; written by src/pain/stim.ts. */
  stim: ActiveStim | null
  stimNow: { t: number; sample: PainSample; running: boolean } | null
  stimStatus: 'idle' | 'loading' | 'ready' | 'error'
  stimMessage: string
  voiceStatus: 'idle' | 'loading' | 'ready' | 'synthetic'
  voiceProgress: number
  lastVoice: { source: 'recorded' | 'synthetic' | 'none'; type: string; probability: number } | null
  /** 把皮肤画成不透明（看表情时用）/ Draw the skin opaque (for reading the expression). */
  skinOpaque: boolean
  /** 不透明的皮肤用写实外观（缺省）；false 用解剖配色 / An opaque skin takes the lifelike look (default); false = the anatomical colours. */
  look: boolean
  /** 写实皮肤的色调 0–100（黑色素，见 src/look/skinMaterial.ts）；null = 数据的缺省值 / Lifelike skin tone 0–100 (melanin, see src/look/skinMaterial.ts); null = the data's default. */
  tone: number | null
  /** 写实的眼：虹膜颜色和注视（见 src/look/eyes.ts）/ The lifelike eyes: iris colour and gaze (see src/look/eyes.ts). */
  iris: IrisName
  gaze: GazeSetting
  /** 写实的眼自发眨眼、有微扫视（缺省）；false 静止（截图、测试用）/ The lifelike eyes blink and make microsaccades (default); false = still (for screenshots, tests). */
  blink: boolean
  /** 写实模式的发型；null = 这副人体的默认（见 hair.json 的 defaultStyle：男短、女长）/ The lifelike hair style; null = this body's default (defaultStyle in hair.json: short for the male, long for the female). */
  hairStyle: HairStyle | null
  /** 写实模式的发色 / The lifelike hair colour. */
  hairColor: HairColour
  selection: Selection
  hover: string | null
  explode: number
  explodeSelectionOnly: boolean
  section: SectionState
  /** 递增以请求查看器对准 `ids`（或所选结构，或全部可见结构）。 */
  /** Bumped to ask the viewer to frame `ids` (or the selection, or everything visible). */
  focusRequest: { nonce: number; ids: readonly string[] | null }
  /** 递增以请求查看器回到初始视角。 */
  /** Bumped to ask the viewer to return to the home view. */
  homeRequest: number

  leftTab: LeftTab
  treeTab: TreeKind
  expanded: Record<TreeKind, ReadonlySet<string>>
  /** 结构树要滚动到的概念；nonce 使同一概念可重复定位。 */
  /** Concept the tree should scroll to; nonce makes repeated reveals of one concept work. */
  reveal: { tree: TreeKind; id: string; nonce: number } | null
  leftOpen: boolean
  rightOpen: boolean
  aboutOpen: boolean

  setLoad(load: Partial<LoadState>): void
  addNotice(text: string): void
  dismissNotices(): void
  init(graph: AnatomyGraph, dataset: string): void
  /** 切换到另一人体，保留所选结构、开关和视角。 */
  /** Switch to another body, carrying over selection, toggles and the camera. */
  switchBody(body: string): void
  setCautionsOpen(open: boolean): void
  /** 关闭注意事项并记录该人体的列表已读。 */
  /** Close the caution list and remember that this body's list has been read. */
  dismissCautions(): void
  setCompare(system: SystemId | null): void

  selectParts(ids: readonly string[], opts?: { additive?: boolean }): void
  selectConcept(tree: TreeKind, id: string, opts?: { reveal?: boolean }): void
  selectFma(fma: string): boolean
  clearSelection(): void
  setHover(id: string | null): void

  setSystemVisible(id: SystemId, visible: boolean): void
  setSystemOpacity(id: SystemId, opacity: number): void
  soloSystem(id: SystemId): void
  setPeel(depth: number): void
  hideParts(ids: Iterable<string>): void
  showParts(ids: Iterable<string>): void
  hideSelection(): void
  isolateSelection(): void
  clearIsolation(): void
  setAdjacentMode(on: boolean): void
  setColorMode(mode: ColorMode): void
  setProvenanceVisible(p: Provenance, visible: boolean): void
  setNerveBoost(on: boolean): void
  /** 加载当前人体的表情数据（已加载则直接返回）/ Load this body's expression data (no-op when loaded). */
  ensureFace(): Promise<LoadedFace | null>
  ensureFaceDetail(): Promise<LoadedDetail | null>
  /** 取写实皮肤的 UV 网格（已取过则直接返回）/ Fetch the lifelike skin's UV mesh (no-op once tried). */
  ensureSkinUv(): Promise<LoadedSkinUv | null>
  setLook(on: boolean): void
  setTone(tone: number | null): void
  setIris(iris: IrisName): void
  setGaze(gaze: GazeSetting): void
  setBlink(on: boolean): void
  setHairStyle(style: HairStyle | null): void
  setHairColor(colour: HairColour): void
  ensureSkinReport(): void
  setStimSettings(patch: Partial<StimSettings>): void
  setStimArmed(on: boolean): void
  rejectFace(message: string): void
  setPain(patch: Partial<PainSettings>): void
  setAU(id: string, intensity: number): void
  clearAUs(): void
  /** 设定（或用 null 清除）情绪表情；强度限制在 0–1 / Set (or clear with null) the emotion expression; the strength is kept within 0–1. */
  setExpr(expr: ExprSetting | null): void
  /** 保持（或用 null 松开）一个视位 / Hold (or release with null) a viseme. */
  setViseme(id: string | null): void
  setSpeechStyle(style: 'normal' | 'clear' | null): void
  setCalibrationOpen(open: boolean): void
  setSkinOpaque(on: boolean): void
  /** 看表情的两种预设视图：肌肉（缺省，表情读得清）或不透明皮肤 / The two preset views for reading the expression: muscles (default, reads clearly) or opaque skin. */
  setFaceView(view: 'muscle' | 'skin'): void
  /** 加载当前人体的绑定（已加载则直接返回）/ Load this body's rig (no-op when loaded). */
  ensureRig(): Promise<LoadedRig | null>
  /** 查看器发现绑定与网格不符时调用 / Called by the viewer when the rig does not match the meshes. */
  rejectRig(message: string): void
  setPose(pose: Pose, opts?: { animate?: boolean }): void
  setDof(joint: string, dof: number, angle: number): void
  applyPosePreset(id: string): void
  resetPose(): void
  setPoseMirror(on: boolean): void
  setBreathing(on: boolean): void
  selectJoint(id: string | null): void
  /** 加载当前人体的体型数据（已加载则直接返回）/ Load this body's shape data (no-op when loaded). */
  ensureShape(): Promise<LoadedShape | null>
  rejectShape(message: string): void
  /** 设定一个体型控制量；超出该人体可用范围的值会被截断 / Set one shape control; values outside the body's valid range are cut. */
  setShapeControl(id: ShapeControlId, value: number): void
  resetShape(): void
  /** 打开 / 关闭体表图；首次打开时加载数据 / Turn a skin map on or off; loads the data on first use. */
  setSkinMapMode(mode: 'off' | SkinMapId): void
  /** 加载当前人体的体表图（已加载则直接返回）/ Load this body's skin maps (no-op when loaded). */
  ensureSkinMaps(): Promise<LoadedSkinMaps | null>
  selectSkinRegions(regions: readonly number[], opts?: { additive?: boolean }): void
  setSkinHover(region: number | null): void
  setSkinSeeThrough(on: boolean): void
  /** 选中区域的支配神经并让皮肤半透明 / Select a region's supplying nerve and make the skin see-through. */
  showRegionNerve(region: number): boolean
  /** 反向：为所选神经打开对应体表图并高亮其分布区；返回高亮的区域数。 */
  /** Reverse: turn on the map that has regions for the selected nerve and highlight them; returns how many. */
  showSkinForSelection(): Promise<number>
  showAll(): void
  setExplode(amount: number): void
  setExplodeSelectionOnly(on: boolean): void
  setSection(patch: Partial<SectionState>): void
  requestFocus(ids?: readonly string[] | null): void
  requestHome(): void

  setLeftTab(tab: LeftTab): void
  setTreeTab(tab: TreeKind): void
  toggleExpanded(tree: TreeKind, id: string): void
  revealConcept(tree: TreeKind, id: string): void
  setLeftOpen(open: boolean): void
  setRightOpen(open: boolean): void
  setAboutOpen(open: boolean): void
}

/**
 * display.json 里皮肤不透明时要隐藏的部件：只留这副人体里确实有的；文件没有或不合规时为 null（改用按名称的规则）。
 * The parts display.json lists as hidden under an opaque skin: only those this body really has; null when the file is absent or
 * malformed (the name rule applies instead).
 */
export function hideListFrom(display: unknown, has: (id: string) => boolean): string[] | null {
  const list = (display as { hideWithOpaqueSkin?: unknown } | null)?.hideWithOpaqueSkin
  if (!Array.isArray(list)) return null
  return list.filter((id): id is string => typeof id === 'string' && has(id))
}

function makeSelection(ids: readonly string[], concept: Selection['concept'] = null): Selection {
  const set = new Set(ids)
  return set.size === 0 ? EMPTY_SELECTION : { ids: [...set], set, concept }
}

/** 恰好只有 `id` 这一个系统可见时为真。 */
/** True when exactly one system is visible and it is `id`. */
export function isSolo(systems: Partial<Record<SystemId, SystemState>>, id: SystemId): boolean {
  let n = 0
  for (const s of Object.values(systems)) if (s.visible) n++
  return n === 1 && !!systems[id]?.visible
}

let pendingFace: { graph: AnatomyGraph; promise: Promise<LoadedFace | null> } | null = null
let detailLoader = (dataset: string) => loadDetail(`${import.meta.env.BASE_URL}anatomy/${dataset}/`)
let detailTried: AnatomyGraph | null = null
let skinUvTried: AnatomyGraph | null = null
let pendingSkinUv: Promise<LoadedSkinUv | null> = Promise.resolve(null)
let reportTried: AnatomyGraph | null = null
let pendingDetail: Promise<LoadedDetail | null> = Promise.resolve(null)
/** 测试用：替换细节层的加载方式 / For tests: replace how the detail layer is loaded. */
export function setDetailLoader(loader: typeof detailLoader): void {
  detailLoader = loader
  detailTried = null
}
let faceLoader = (dataset: string) => loadFace(`${import.meta.env.BASE_URL}anatomy/${dataset}/`)

/** 测试用：替换表情数据的加载方式 / For tests: replace how the face data is fetched. */
export function setFaceLoader(loader: typeof faceLoader): void {
  faceLoader = loader
  pendingFace = null
}

let pendingShape: { graph: AnatomyGraph; promise: Promise<LoadedShape | null> } | null = null
let shapeLoader = (dataset: string) => loadShape(`${import.meta.env.BASE_URL}anatomy/${dataset}/`)

/** 测试用：替换体型数据的加载方式 / For tests: replace how the shape data is fetched. */
export function setShapeLoader(loader: typeof shapeLoader): void {
  shapeLoader = loader
  pendingShape = null
}

let pendingRig: { graph: AnatomyGraph; promise: Promise<LoadedRig | null> } | null = null
let rigLoader = (dataset: string, onProgress: (f: number) => void) => loadRig(`${import.meta.env.BASE_URL}anatomy/${dataset}/`, onProgress)

/** 测试用：替换绑定的加载方式 / For tests: replace how the rig is fetched. */
export function setRigLoader(loader: typeof rigLoader): void {
  rigLoader = loader
  pendingRig = null
}

let pendingSkinMaps: { graph: AnatomyGraph; promise: Promise<LoadedSkinMaps | null> } | null = null
let skinMapLoader: (dataset: string) => Promise<LoadedSkinMaps | null> = (dataset) =>
  loadSkinMaps(`${import.meta.env.BASE_URL}anatomy/${dataset}/`)

/** 测试用：替换体表图的加载方式 / For tests: replace how skin maps are fetched. */
export function setSkinMapLoader(loader: (dataset: string) => Promise<LoadedSkinMaps | null>): void {
  skinMapLoader = loader
  pendingSkinMaps = null
}

export const useApp = create<AppState>()((set, get) => ({
  load: { phase: 'loading', progress: 0, message: '', loaded: [] },
  dataset: '',
  requestedBody: '',
  cautionsOpen: false,
  embed: false,
  posePreset: null,
  cameraRequest: null,
  compare: null,
  systemsBeforeCompare: null,
  notices: [],
  graph: null,

  systems: {},
  peel: 0,
  hidden: new Set(),
  isolated: null,
  adjacentMode: false,
  colorMode: 'tissue',
  provenanceHidden: new Set(),
  nerveBoost: true,
  face: null,
  skinHide: undefined,
  faceDetail: null,
  skinUv: null,
  faceStatus: 'idle',
  faceMessage: '',
  pain: { level: 5, onset: 'sudden', hold: false, muted: false, always: false },
  aus: {},
  expr: null,
  viseme: null,
  speech: { status: 'idle', name: '', durationS: 0, message: '' },
  say: { status: 'idle', clip: null, source: null, text: '', lang: null, voice: '', durationS: 0, sound: false, mode: 'phonemes', message: '', warnings: [], model: null, recording: null, licence: '' },
  speechStyle: null,
  calibrationOpen: false,
  painNonce: 0,
  stimSettings: defaultSettings(),
  stimArmed: false,
  stim: null,
  stimNow: null,
  stimStatus: 'idle',
  stimMessage: '',
  voiceStatus: 'idle',
  voiceProgress: 0,
  lastVoice: null,
  skinOpaque: false,
  look: true,
  tone: null,
  iris: DEFAULT_IRIS,
  gaze: 'camera',
  blink: true,
  hairStyle: null,
  hairColor: DEFAULT_HAIR_COLOUR,
  rig: null,
  rigStatus: 'idle',
  rigMessage: '',
  rigProgress: 0,
  pose: {},
  poseAnimate: 0,
  poseMirror: true,
  breathing: false,
  poseJoint: null,
  jointScales: null,
  shape: null,
  shapeStatus: 'idle',
  shapeMessage: '',
  shapeControls: {},
  shapeLimit: null,
  skinMapMode: 'off',
  skinMaps: null,
  skinMapsStatus: 'idle',
  skinRegions: [],
  skinHover: null,
  skinSeeThrough: false,
  selection: EMPTY_SELECTION,
  hover: null,
  explode: 0,
  explodeSelectionOnly: false,
  section: { enabled: false, axis: 'axial', position: 0.6, flip: false },
  focusRequest: { nonce: 0, ids: null },
  homeRequest: 0,

  leftTab: 'display',
  treeTab: 'isa',
  expanded: { isa: new Set(), partOf: new Set() },
  reveal: null,
  leftOpen: false,
  rightOpen: false,
  aboutOpen: false,

  setLoad: (load) => set((s) => ({ load: { ...s.load, ...load } })),
  addNotice: (text) => set((s) => (s.notices.includes(text) ? s : { notices: [...s.notices, text] })),
  dismissNotices: () => set({ notices: [] }),

  init: (graph, dataset) => {
    const prev = get()
    const from = prev.graph
    // 切换人体时保留用户的设置；首次加载从干净状态开始
    // switching bodies keeps what the user set up; a first load starts clean
    const carry = !!from && from !== graph
    const systems: Partial<Record<SystemId, SystemState>> = {}
    for (const sys of graph.data.systems) {
      systems[sys.id] = (carry && prev.systemsBeforeCompare?.[sys.id]) || (carry && prev.systems[sys.id]) || { visible: true, opacity: 1 }
    }
    // 展开每棵树的第一层，免得面板只有一行折叠项
    // open the first level of each tree so the panel is not a single collapsed row
    const expanded = {
      isa: new Set(graph.roots('isa').map((c) => c.id)),
      partOf: new Set(graph.roots('partOf').map((c) => c.id)),
    }
    let selection = EMPTY_SELECTION
    let hidden = new Set<string>()
    let isolated: Set<string> | null = null
    if (carry && from) {
      const c = prev.selection.concept
      if (c && graph.concept(c.tree, c.id)) {
        const ids = graph.descendantParts(c.tree, c.id)
        selection = ids.length ? makeSelection(ids, c) : { ids: [], set: new Set(), concept: c }
      } else {
        selection = makeSelection(mapPartsBetween(from, graph, prev.selection.ids))
      }
      hidden = new Set(mapPartsBetween(from, graph, prev.hidden))
      if (prev.isolated) {
        const mapped = mapPartsBetween(from, graph, prev.isolated)
        isolated = mapped.length ? new Set(mapped) : null
      }
    }
    const cautions = graph.cautions.length
    set({
      graph,
      dataset,
      requestedBody: prev.requestedBody || dataset,
      systems,
      expanded,
      peel: carry ? Math.min(prev.peel, Math.max(0, graph.data.layers.length - 1)) : 0,
      hidden,
      isolated,
      adjacentMode: carry ? prev.adjacentMode : false,
      provenanceHidden: carry ? prev.provenanceHidden : new Set(),
      selection,
      hover: null,
      compare: null,
      systemsBeforeCompare: null,
      // 嵌入模式下不弹对话框（改为舞台角落的一行提示）/ no dialog in embed mode (a one-line notice on the stage instead)
      cautionsOpen: !prev.embed && cautions > 0 && storageGet(cautionsSeenKey(dataset, cautions)) === null,
      // 体表图属于具体人体：换人体后重新加载，区域索引不沿用
      // skin maps belong to one body: reload after a switch, region indices do not carry over
      skinMaps: null,
      skinMapsStatus: 'idle',
      skinRegions: [],
      skinHover: null,
      skinSeeThrough: false,
      // 绑定属于具体人体；姿势按关节 id 记录，换人体后沿用（新绑定里没有的关节被忽略）
      // the rig belongs to one body; the pose is kept by joint id across a switch (joints the new rig lacks are ignored)
      rig: null,
      rigStatus: 'idle',
      rigMessage: '',
      rigProgress: 0,
      face: null,
      skinHide: undefined,
      faceDetail: null,
      skinUv: null,
      faceStatus: 'idle',
      stim: null,
      stimNow: null,
      stimStatus: 'idle',
      stimMessage: '',
      faceMessage: '',
      // 嵌入模式默认静音：没有用户手势不出声 / muted by default in embed mode: no sound without a user gesture
      pain: { ...prev.pain, muted: prev.embed ? true : prev.pain.muted },
      poseJoint: null,
      jointScales: null,
      // 体型的默认值因人体而异：换人体后回到原样 / shape defaults differ between bodies: back to as-built after a switch
      shape: null,
      shapeStatus: 'idle',
      shapeMessage: '',
      shapeControls: {},
      shapeLimit: null,
    })
    if (get().skinMapMode !== 'off') void get().ensureSkinMaps()
    if (get().leftTab === 'pose' || !poseIsRest(get().pose) || get().breathing) void get().ensureRig()
    if (get().leftTab === 'pose') void get().ensureShape()
    if (get().leftTab === 'pain' || get().leftTab === 'expr' || get().pain.hold || Object.keys(get().aus).length > 0 || get().expr || get().viseme || get().say.status === 'playing') void get().ensureFace()
    // 表情和口形要张口时靠下颌关节 / an expression or mouth shape that opens the mouth needs the jaw joint
    if (get().expr || get().viseme || get().say.status === 'playing') void get().ensureRig()
  },

  switchBody: (body) => {
    if (body === get().requestedBody) return
    set({ requestedBody: body })
  },

  setCautionsOpen: (cautionsOpen) => set({ cautionsOpen }),
  dismissCautions: () => {
    const { graph, dataset } = get()
    if (graph?.cautions.length) storageSet(cautionsSeenKey(dataset, graph.cautions.length), '1')
    set({ cautionsOpen: false })
  },

  setCompare: (system) =>
    set((s) => {
      const base = s.systemsBeforeCompare ?? s.systems
      if (system === null) return { compare: null, systems: base, systemsBeforeCompare: null }
      const systems: Partial<Record<SystemId, SystemState>> = {}
      for (const [k, v] of Object.entries(base) as [SystemId, SystemState][]) systems[k] = { ...v, visible: k === system }
      return { compare: { system }, systems, systemsBeforeCompare: base, isolated: null }
    }),

  selectParts: (ids, opts) => {
    const { graph, selection } = get()
    if (!graph) return
    const valid = ids.filter((id) => graph.part(id))
    if (opts?.additive) {
      const next = new Set(selection.set)
      for (const id of valid) {
        if (next.has(id) && valid.length === 1) next.delete(id)
        else next.add(id)
      }
      set({ selection: makeSelection([...next]) })
    } else {
      set({ selection: makeSelection(valid) })
    }
  },

  selectConcept: (tree, id, opts) => {
    const { graph } = get()
    if (!graph || !graph.concept(tree, id)) return
    const ids = graph.descendantParts(tree, id)
    set({
      selection: ids.length ? makeSelection(ids, { tree, id }) : { ids: [], set: new Set(), concept: { tree, id } },
    })
    if (opts?.reveal) get().revealConcept(tree, id)
  },

  selectFma: (fma) => {
    const { graph } = get()
    if (!graph) return false
    const direct = graph.partsByFma(fma)
    if (direct.length) {
      get().selectParts(direct.map((p) => p.id))
      return true
    }
    for (const tree of ['isa', 'partOf'] as const) {
      if (graph.partCount(tree, fma) > 0) {
        get().selectConcept(tree, fma)
        return true
      }
    }
    return false
  },

  clearSelection: () => set({ selection: EMPTY_SELECTION, skinRegions: [], skinSeeThrough: false }),
  setHover: (id) => {
    if (get().hover !== id) set({ hover: id })
  },

  setSystemVisible: (id, visible) =>
    set((s) => ({ systems: { ...s.systems, [id]: { opacity: s.systems[id]?.opacity ?? 1, visible } } })),
  setSystemOpacity: (id, opacity) =>
    set((s) => ({
      systems: { ...s.systems, [id]: { visible: s.systems[id]?.visible ?? true, opacity: Math.min(1, Math.max(0, opacity)) } },
    })),
  soloSystem: (id) =>
    set((s) => {
      const restore = isSolo(s.systems, id)
      const systems: Partial<Record<SystemId, SystemState>> = {}
      for (const [k, v] of Object.entries(s.systems) as [SystemId, SystemState][]) {
        systems[k] = { ...v, visible: restore || k === id }
      }
      return { systems }
    }),
  setPeel: (depth) => set({ peel: Math.max(0, Math.round(depth)) }),

  hideParts: (ids) =>
    set((s) => {
      const hidden = new Set(s.hidden)
      for (const id of ids) hidden.add(id)
      return { hidden }
    }),
  showParts: (ids) =>
    set((s) => {
      const hidden = new Set(s.hidden)
      for (const id of ids) hidden.delete(id)
      return { hidden }
    }),
  hideSelection: () => {
    const { selection } = get()
    if (!selection.ids.length) return
    get().hideParts(selection.ids)
    // 被选中的部件总会绘制，所以隐藏时必须同时取消选择
    // a selected part is always drawn, so hiding has to drop the selection too
    set((s) => ({
      selection: EMPTY_SELECTION,
      isolated: s.isolated ? new Set([...s.isolated].filter((id) => !selection.set.has(id))) : null,
    }))
  },
  isolateSelection: () => {
    const { selection } = get()
    if (selection.ids.length) set({ isolated: new Set(selection.ids) })
  },
  clearIsolation: () => set({ isolated: null }),
  setAdjacentMode: (on) => set({ adjacentMode: on }),
  setColorMode: (colorMode) => set({ colorMode }),
  setProvenanceVisible: (p, visible) =>
    set((s) => {
      const next = new Set(s.provenanceHidden)
      if (visible) next.delete(p)
      else next.add(p)
      return { provenanceHidden: next }
    }),
  setNerveBoost: (nerveBoost) => set({ nerveBoost }),

  ensureFace: async () => {
    const { face, faceStatus, graph, dataset } = get()
    if (face || !graph) return face
    if (faceStatus === 'missing' || faceStatus === 'error') return null
    if (pendingFace && pendingFace.graph === graph) return pendingFace.promise
    set({ faceStatus: 'loading', faceMessage: '' })
    const promise = faceLoader(dataset)
      .then((loaded) => {
        if (get().graph !== graph) return null // 已换人体 / the body changed meanwhile
        if (loaded && !graph.part(loaded.data.skin)) throw new Error(`表情数据指向的皮肤部件 ${loaded.data.skin} 不在此人体中 / skin part ${loaded.data.skin} is not in this body`)
        set({ face: loaded, faceStatus: loaded ? 'ready' : 'missing' })
        if (loaded && get().skinOpaque) void get().ensureFaceDetail()
        return loaded
      })
      .catch((err: unknown) => {
        console.warn('[soma] face data failed to load', err)
        if (get().graph === graph) set({ faceStatus: 'error', faceMessage: err instanceof Error ? err.message : String(err) })
        return null
      })
      .finally(() => {
        if (pendingFace?.graph === graph) pendingFace = null
      })
    pendingFace = { graph, promise }
    return promise
  },
  ensureSkinReport: () => {
    const { graph, dataset, skinHide } = get()
    if (!graph || skinHide !== undefined || reportTried === graph) return
    reportTried = graph
    // display.json 只有一千字节左右；同样的清单也在 pipeline-report.json 里，但那个文件有一兆多
    // display.json is about a kilobyte; the same list is in pipeline-report.json too, but that file is over a megabyte
    void fetchJson<unknown>(`${import.meta.env.BASE_URL}anatomy/${dataset}/display.json`)
      .catch(() => null)
      .then((display) => {
        if (get().graph !== graph) return
        set({ skinHide: hideListFrom(display, (id) => !!graph.part(id)) })
      })
  },
  ensureFaceDetail: async () => {
    const { faceDetail, graph, dataset } = get()
    if (faceDetail || !graph) return faceDetail
    if (detailTried === graph) return pendingDetail
    detailTried = graph
    pendingDetail = detailLoader(dataset)
      .then((loaded) => {
        if (get().graph !== graph) return null
        set({ faceDetail: loaded })
        return loaded
      })
      .catch((err: unknown) => {
        // 细节层是锦上添花：没有或坏了就不画，不影响别的 / the detail layer is an extra: absent or broken, it is simply not drawn
        console.warn('[soma] face detail failed to load', err)
        return null
      })
    return pendingDetail
  },
  ensureSkinUv: async () => {
    const { skinUv, graph, dataset } = get()
    if (skinUv || !graph) return skinUv
    if (skinUvTried === graph) return pendingSkinUv
    skinUvTried = graph
    pendingSkinUv = loadSkinUv(dataset)
      .then((loaded) => {
        if (get().graph !== graph) return null
        if (loaded) set({ skinUv: loaded })
        return loaded
      })
      .catch((err: unknown) => {
        // 写实外观是附加的：没有或坏了就照旧用解剖配色 / the lifelike look is an extra: absent or broken, the anatomical colours stay
        console.warn('[soma] lifelike skin failed to load', err)
        return null
      })
    return pendingSkinUv
  },
  setLook: (look) => set({ look }),
  setTone: (tone) => set({ tone: tone === null ? null : Math.min(100, Math.max(0, Math.round(tone))) }),
  setIris: (iris) => set({ iris }),
  setGaze: (gaze) => set({ gaze }),
  setBlink: (blink) => set({ blink }),
  setHairStyle: (hairStyle) => set({ hairStyle }),
  setHairColor: (hairColor) => set({ hairColor }),
  rejectFace: (message) => set({ face: null, faceStatus: 'error', faceMessage: message }),
  setStimSettings: (patch) =>
    set((s) => {
      // 换种类时量值和时长换成那一种的默认值 / switching kind resets magnitude and duration to that kind's defaults
      const base = patch.kind && patch.kind !== s.stimSettings.kind ? withKind(s.stimSettings, patch.kind) : s.stimSettings
      const next = { ...base, ...patch }
      const k = kindSpec(next.kind)
      next.magnitude = Math.min(k.max, Math.max(k.min, next.magnitude))
      next.duration = Math.min(Math.max(k.durationMax, 0.1), Math.max(0.1, next.duration))
      return { stimSettings: next }
    }),
  setStimArmed: (stimArmed) => set({ stimArmed }),
  setPain: (patch) => {
    set((s) => ({ pain: { ...s.pain, ...patch, level: Math.min(10, Math.max(0, patch.level ?? s.pain.level)) } }))
    if (get().pain.hold) {
      void get().ensureFace()
      void get().ensureRig() // 张口要靠下颌关节 / the jaw joint is what opens the mouth
    }
  },
  setAU: (id, intensity) => {
    set((s) => {
      const aus = { ...s.aus }
      const v = Math.min(5, Math.max(0, intensity))
      if (v > 0) aus[id] = v
      else delete aus[id]
      return { aus }
    })
    void get().ensureFace()
    if (/^AU2[67]$/.test(id)) void get().ensureRig()
  },
  clearAUs: () => set({ aus: {} }),
  setExpr: (expr) => {
    set({ expr: expr && expr.id ? { id: expr.id, strength: Math.min(1, Math.max(0, expr.strength)) } : null })
    if (get().expr) {
      void get().ensureFace()
      void get().ensureRig() // 惊讶等表情要张口 / expressions such as surprise open the mouth
    }
  },
  setViseme: (viseme) => {
    set({ viseme: viseme || null })
    if (viseme) {
      void get().ensureFace()
      void get().ensureRig()
    }
  },
  setSpeechStyle: (speechStyle) => set({ speechStyle: speechStyle === 'normal' || speechStyle === 'clear' ? speechStyle : null }),
  setCalibrationOpen: (calibrationOpen) => set({ calibrationOpen }),
  setSkinOpaque: (skinOpaque) => {
    set({ skinOpaque })
    if (skinOpaque && get().face) void get().ensureFaceDetail()
  },
  setFaceView: (view) => {
    set((s) => {
      const systems: Partial<Record<SystemId, SystemState>> = {}
      const show: SystemId[] = view === 'muscle' ? ['muscular', 'skeletal'] : ['integumentary']
      for (const [k, v] of Object.entries(s.systems) as [SystemId, SystemState][]) systems[k] = { ...v, visible: show.includes(k) }
      return { systems, skinOpaque: view === 'skin', isolated: null, peel: 0, skinMapMode: 'off' }
    })
    if (view === 'skin' && get().face) void get().ensureFaceDetail()
  },

  ensureRig: async () => {
    const { rig, rigStatus, graph, dataset } = get()
    if (rig || !graph) return rig
    if (rigStatus === 'missing' || rigStatus === 'stale' || rigStatus === 'error') return null
    if (pendingRig && pendingRig.graph === graph) return pendingRig.promise
    set({ rigStatus: 'loading', rigProgress: 0, rigMessage: '' })
    const promise = rigLoader(dataset, (f) => {
      if (get().graph === graph) set({ rigProgress: f })
    })
      .then((res) => {
        if (get().graph !== graph) return null // 已换人体 / the body changed meanwhile
        if (!res.ok) {
          set({ rigStatus: res.reason, rigMessage: res.message })
          return null
        }
        set({ rig: res.rig, rigStatus: 'ready', rigProgress: 1 })
        return res.rig
      })
      .catch((err: unknown) => {
        console.warn('[soma] rig failed to load', err)
        if (get().graph === graph) set({ rigStatus: 'error', rigMessage: err instanceof Error ? err.message : String(err) })
        return null
      })
      .finally(() => {
        if (pendingRig?.graph === graph) pendingRig = null
      })
    pendingRig = { graph, promise }
    return promise
  },
  rejectRig: (message) => set({ rig: null, rigStatus: 'stale', rigMessage: message, poseJoint: null, breathing: false }),

  setPose: (pose, opts) => set((s) => ({ pose, posePreset: null, poseAnimate: opts?.animate ? s.poseAnimate + 1 : s.poseAnimate })),
  setDof: (joint, dof, angle) => {
    const { rig, pose, poseMirror } = get()
    if (rig) set({ pose: withDof(rig.rig.joints, pose, joint, dof, angle, poseMirror), posePreset: null })
  },
  applyPosePreset: (id) => {
    const { rig } = get()
    const preset = rig ? posePresets(rig.rig.joints).find((p) => p.id === id) : undefined
    if (preset) {
      get().setPose(preset.pose, { animate: true })
      set({ posePreset: id === 'rest' ? null : id })
    }
  },
  resetPose: () => set((s) => ({ pose: {}, posePreset: null, poseAnimate: s.poseAnimate + 1, breathing: false })),
  setPoseMirror: (poseMirror) => set({ poseMirror }),
  setBreathing: (breathing) => {
    set({ breathing })
    if (breathing) void get().ensureRig()
  },
  selectJoint: (id) => {
    const { rig, graph } = get()
    if (!id || !rig || !graph) {
      set({ poseJoint: null })
      return
    }
    // 高亮这个关节直接带动的骨（刚性绑定在它上面的部件）
    // highlight the bones this joint moves directly (parts rigidly bound to it)
    const ids = rig.rig.bindings.filter((b) => b.joint === id && graph.part(b.part)).map((b) => b.part)
    set({ poseJoint: id, selection: makeSelection(ids) })
  },
  ensureShape: async () => {
    const { shape, shapeStatus, graph, dataset } = get()
    if (shape || !graph) return shape
    if (shapeStatus === 'missing' || shapeStatus === 'error') return null
    if (pendingShape && pendingShape.graph === graph) return pendingShape.promise
    set({ shapeStatus: 'loading', shapeMessage: '' })
    const promise = shapeLoader(dataset)
      .then((loaded) => {
        if (get().graph !== graph) return null // 已换人体 / the body changed meanwhile
        if (loaded && !graph.part(loaded.data.skin.part)) throw new Error(`体型数据指向的皮肤部件 ${loaded.data.skin.part} 不在此人体中 / skin part ${loaded.data.skin.part} is not in this body`)
        set({ shape: loaded, shapeStatus: loaded ? 'ready' : 'missing' })
        // 控制量可能先于数据到达（深链接）：数据到了再算关节缩放
        // controls can arrive before the data (deep links): the joint scales are computed once it is here
        if (loaded) {
          const jointScales = shapeScales(loaded.data, get().shapeControls)
          set({ jointScales })
          if (jointScales) void get().ensureRig()
        }
        return loaded
      })
      .catch((err: unknown) => {
        console.warn('[soma] shape data failed to load', err)
        if (get().graph === graph) set({ shapeStatus: 'error', shapeMessage: err instanceof Error ? err.message : String(err) })
        return null
      })
      .finally(() => {
        if (pendingShape?.graph === graph) pendingShape = null
      })
    pendingShape = { graph, promise }
    return promise
  },
  rejectShape: (message) => set({ shape: null, shapeStatus: 'error', shapeMessage: message, jointScales: null }),
  setShapeControl: (id, value) => {
    const { shape } = get()
    const control = shape?.data.controls.find((c) => c.id === id)
    if (!shape || !control) {
      // 数据还没到：先记下，加载后再限幅 / data not here yet: remember it, clamp after loading
      set((s) => ({ shapeControls: { ...s.shapeControls, [id]: value } }))
      void get().ensureShape()
      return
    }
    const c = clampControl(control, value)
    const shapeControls = { ...get().shapeControls, [id]: c.value }
    if (Math.abs(c.value - control.default) < 1e-9) delete shapeControls[id]
    const jointScales = shapeScales(shape.data, shapeControls)
    set({ shapeControls, shapeLimit: c.limited ? { id, side: c.limited } : null, jointScales })
    // 身高和比例靠关节缩放实现，需要绑定；只改 BMI 不需要（省下十几 MB 的下载）
    // stature and proportions act through joint scales, which need the rig; BMI alone does not (saving a download of over ten MB)
    if (jointScales) void get().ensureRig()
  },
  resetShape: () => set({ shapeControls: {}, shapeLimit: null, jointScales: null }),

  setSkinMapMode: (mode) => {
    if (get().skinMapMode === mode) return
    set({ skinMapMode: mode, skinRegions: [], skinHover: null, skinSeeThrough: false })
    if (mode !== 'off') void get().ensureSkinMaps()
  },

  ensureSkinMaps: async () => {
    const { skinMaps, skinMapsStatus, graph, dataset } = get()
    if (skinMaps || !graph) return skinMaps
    if (skinMapsStatus === 'missing' || skinMapsStatus === 'error') return null
    if (pendingSkinMaps && pendingSkinMaps.graph === graph) return pendingSkinMaps.promise
    set({ skinMapsStatus: 'loading' })
    const promise = skinMapLoader(dataset)
      .then((maps) => {
        if (get().graph !== graph) return null // 已换人体 / the body changed meanwhile
        if (maps && !graph.part(maps.part)) throw new Error(`体表图指向的皮肤部件 ${maps.part} 不在此人体中 / skin part ${maps.part} is not in this body`)
        set({ skinMaps: maps, skinMapsStatus: maps ? 'ready' : 'missing' })
        return maps
      })
      .catch((err: unknown) => {
        console.warn('[soma] skin maps failed to load', err)
        if (get().graph === graph) set({ skinMapsStatus: 'error' })
        return null
      })
      .finally(() => {
        if (pendingSkinMaps?.graph === graph) pendingSkinMaps = null
      })
    pendingSkinMaps = { graph, promise }
    return promise
  },

  selectSkinRegions: (regions, opts) =>
    set((s) => {
      let next: number[]
      if (opts?.additive) {
        const cur = new Set(s.skinRegions)
        for (const r of regions) {
          if (cur.has(r) && regions.length === 1) cur.delete(r)
          else cur.add(r)
        }
        next = [...cur]
      } else next = [...new Set(regions)]
      // 点选区域即离开"显示支配神经"状态，并清除结构选择
      // picking a region leaves the "show nerve" state and drops the part selection
      return { skinRegions: next, skinSeeThrough: false, selection: opts?.additive ? s.selection : EMPTY_SELECTION }
    }),
  setSkinHover: (skinHover) => {
    if (get().skinHover !== skinHover) set({ skinHover })
  },
  setSkinSeeThrough: (skinSeeThrough) => set({ skinSeeThrough }),

  showRegionNerve: (region) => {
    const { graph, skinMaps, skinMapMode } = get()
    const map = skinMaps?.maps.find((m) => m.id === skinMapMode)
    if (!graph || !map) return false
    const ids = regionParts(graph, map, region)
    if (ids.length === 0) return false
    set({ selection: makeSelection(ids), skinRegions: [region], skinSeeThrough: true })
    return true
  },

  showSkinForSelection: async () => {
    const maps = await get().ensureSkinMaps()
    const { graph, selection, skinMapMode } = get()
    if (!maps || !graph || selection.ids.length === 0) return 0
    const refs = regionsForParts(graph, maps, selection.ids)
    if (refs.length === 0) return 0
    // 优先保持当前打开的那张图 / prefer the map that is already on
    const map = refs.some((r) => r.map === skinMapMode) ? (skinMapMode as SkinMapId) : refs[0]!.map
    const regions = refs.filter((r) => r.map === map).map((r) => r.region)
    set({ skinMapMode: map, skinRegions: regions, skinSeeThrough: false, skinHover: null })
    return regions.length
  },
  showAll: () =>
    set((s) => {
      const systems: Partial<Record<SystemId, SystemState>> = {}
      for (const [k, v] of Object.entries(s.systems) as [SystemId, SystemState][]) systems[k] = { ...v, visible: true }
      return { systems, hidden: new Set(), isolated: null, adjacentMode: false, peel: 0, provenanceHidden: new Set() }
    }),

  setExplode: (amount) => set({ explode: Math.min(1, Math.max(0, amount)) }),
  setExplodeSelectionOnly: (on) => set({ explodeSelectionOnly: on }),
  setSection: (patch) => set((s) => ({ section: { ...s.section, ...patch } })),
  requestFocus: (ids = null) => set((s) => ({ focusRequest: { nonce: s.focusRequest.nonce + 1, ids } })),
  requestHome: () => set((s) => ({ homeRequest: s.homeRequest + 1 })),

  setLeftTab: (leftTab) => {
    set({ leftTab })
    if (leftTab === 'pose') {
      void get().ensureRig()
      void get().ensureShape()
    }
    if (leftTab === 'pain' || leftTab === 'expr') void get().ensureFace()
  },
  setTreeTab: (treeTab) => set({ treeTab }),
  toggleExpanded: (tree, id) =>
    set((s) => {
      const next = new Set(s.expanded[tree])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { expanded: { ...s.expanded, [tree]: next } }
    }),
  revealConcept: (tree, id) => {
    const { graph } = get()
    if (!graph?.concept(tree, id)) return
    set((s) => {
      const next = new Set(s.expanded[tree])
      for (const a of graph.ancestors(tree, id)) next.add(a.id)
      return {
        expanded: { ...s.expanded, [tree]: next },
        treeTab: tree,
        leftTab: 'tree',
        reveal: { tree, id, nonce: (s.reveal?.nonce ?? 0) + 1 },
      }
    })
  },
  setLeftOpen: (leftOpen) => set({ leftOpen }),
  setRightOpen: (rightOpen) => set({ rightOpen }),
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
}))
