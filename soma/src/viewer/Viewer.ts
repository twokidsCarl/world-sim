// 三维视图：渲染器、相机、部件几何、拾取，以及把 store 状态映射到场景。WebGPU 下部件合批绘制，WebGL2 下每个部件一个网格；按需渲染。
// The 3D view: renderer, camera, part meshes, picking, and the mirror from store state to
// scene state. One Mesh per part, shared materials; rendering is on demand.

import {
  Box3,
  ClippingGroup,
  Color,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  HemisphereLight,
  Line3,
  Object3D,
  PerspectiveCamera,
  Plane,
  Ray,
  Raycaster,
  FloatType,
  RGBAFormat,
  RenderTarget,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGPURenderer,
  type Mesh,
} from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { MeshBVH } from 'three-mesh-bvh'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import { TISSUE_COLOR, TISSUE_OPACITY, provenanceColor } from '../anatomy/labels.ts'
import type { Part, SystemId } from '../anatomy/types.ts'
import {
  GHOST,
  HIDDEN,
  NORMAL,
  THIN_RADIUS,
  clipRay,
  computeDisplay,
  skinDrawnOpaque,
  computeExplode,
  sectionPlane,
  type PlaneEq,
} from '../state/display.ts'
import { useApp, type AppState } from '../state/store.ts'
import { ACCENT, MODE_BLEND, MODE_HIDDEN, MODE_OPAQUE, PartBatches, bakePart, type BakedPart, type PartBuffers, type PartRenderer } from './batches.ts'
import { PartMeshes, centroidTransparentSort } from './meshes.ts'
import { JointGizmo } from './gizmo.ts'
import { PoseRuntime } from './posing.ts'
import { probeSkinnedPositions } from './skinProbe.ts'
import { SkinningData, type SkinningMode } from './skinning.ts'
import {
  breathingPose,
  dofAxisWorld,
  RIG_STALE_MESSAGE,
  sha256Prefix,
  staleInputs,
  jointFrames,
  lerpPose,
  poseIsRest,
  scalesAreIdentity,
  validateRig,
  writeInfluences,
  type LoadedRig,
  type Pose,
  type Scales,
} from '../anatomy/rig.ts'
import { clampPose, mergePoses } from '../../tools/rig/pose.ts'
import { painFrame, setPainPaused } from '../pain/controller.ts'
import { activations, displacePart, sameAUs, type AUs, type LoadedFace } from '../pain/face.ts'
import { Shaper } from '../../tools/rig/shape.ts'
import { shapeIsDefault, type LoadedShape, type ShapeControls } from '../anatomy/shape.ts'
import { SkinLayer, type SkinGeometry } from './skinLayer.ts'
import { FaceDetailLayer, type DetailDebug } from './faceDetail.ts'
import type { SkinPatch } from './skinPatch.ts'
import { PAIN_COLORS, PainOverlay, PathVisuals, bindPath, boundPositions, resamplePolyline, type PathBinding } from './stimVisuals.ts'
import { applyStimulus, registerStimHost, releaseStimulus, stimFrame, type ActiveStim, type StimFrame } from '../pain/stim.ts'
import type { ResolvedSite } from '../pain/stimulus.ts'
import { layerWeights, type LoadedDetail } from '../pain/detail.ts'

const LEGACY_SORT = typeof location !== 'undefined' && new URLSearchParams(location.search).get('sort') === 'origin'
const GHOST_RGB = new Color('#8d99a6')
const GHOST_OPACITY = 0.07
/** 比这更透明的部件不可拾取（指针穿过它们）。 */
/** Parts drawn more transparent than this are not pickable (the pointer passes through). */
const PICK_OPACITY = 0.4
const ACCENT_RGB = new Color(ACCENT)
const PATH_RGB = new Color(PAIN_COLORS.path)
/** 刺激工具：按住这么久（不移动）就算"按住施加" / Stimulus tool: a press held this long without moving applies by pressing. */
const HOLD_MS = 380
const WHITE = new Color(0xffffff)
/** 开启加粗时神经被加粗到的屏幕半径（CSS 像素）。 */
/** On-screen radius (CSS px) nerves are thickened to when the aid is on. */
const NERVE_MIN_RADIUS_PX = 0.75
/** 细小部件在距指针多远（CSS 像素）以内仍会被拾取。 */
/** How far from the pointer (CSS px) a thin part is still picked. */
const THIN_PICK_PX = { mouse: 5, touch: 12 }
/** 细小部件可以位于其视线上最近表面之后这么远（米）仍被选中（神经常半埋在表面里）。 */
/** A thin part may sit this far (m) behind the nearest surface on its own line of sight and still win (nerves lie half-embedded). */
const THIN_DEPTH_SLACK = 0.004

export type { BakedPart }

export interface ViewerStats {
  backend: 'webgpu' | 'webgl2'
  /** 每秒 requestAnimationFrame 次数（页面实际得到的刷新率）。 */
  /** requestAnimationFrame ticks per second (display rate the page is getting). */
  tickFps: number
  /** 最近一秒实际渲染的帧数（空闲时为 0：按需渲染）。 */
  /** Frames actually rendered in the last second (0 when idle: rendering is on demand). */
  renderedFps: number
  /** 最近一秒 renderer.render() 在主线程的平均耗时，毫秒。 */
  /** Mean main-thread time of renderer.render() over the last second, ms. */
  renderCpuMs: number
  drawCalls: number
  triangles: number
  /** 有几何的部件数。 */
  /** Parts that have geometry. */
  meshes: number
  bvhBuilt: number
  bvhTotal: number
  /** 渲染循环是否暂停（页面隐藏或滚出视口）及累计 tick 数 / Whether the loop is paused (page hidden or scrolled out of view) and ticks so far. */
  paused: boolean
  ticks: number
  /** 已加载几何的系统 / Systems whose geometry is loaded. */
  systems: SystemId[]
}

export interface BenchResult {
  backend: 'webgpu' | 'webgl2'
  seconds: number
  frames: number
  fps: number
  frameMsAvg: number
  frameMsP95: number
  frameMsMax: number
  renderCpuMsAvg: number
  drawCalls: number
  triangles: number
  visibleParts: number
  pixelRatio: number
  size: [number, number]
}

/** 所选部件超过这个数量时不再绘制透视色（它会使绘制调用翻倍）。 */
/** Above this many selected parts the see-through tint is skipped (it doubles their draw calls). */
const XRAY_MAX = 300
/** 场景所映射的那部分应用状态。对照窗格提供自己的一份。 */
/** The slice of app state the scene mirrors. A compare pane supplies its own. */
export type ViewState = Pick<
  AppState,
  | 'systems'
  | 'peel'
  | 'hidden'
  | 'isolated'
  | 'adjacentMode'
  | 'provenanceHidden'
  | 'colorMode'
  | 'selection'
  | 'hover'
  | 'explode'
  | 'explodeSelectionOnly'
  | 'section'
  | 'nerveBoost'
  | 'focusRequest'
  | 'homeRequest'
  | 'skinMapMode'
  | 'skinMaps'
  | 'skinRegions'
  | 'skinHover'
  | 'skinSeeThrough'
  | 'rig'
  | 'pose'
  | 'poseAnimate'
  | 'breathing'
  | 'poseJoint'
  | 'jointScales'
  | 'leftTab'
  | 'cameraRequest'
  | 'face'
  | 'faceDetail'
  | 'skinOpaque'
  | 'shape'
  | 'shapeControls'
>

export interface ViewerOptions {
  forceWebGL?: boolean
  /** 显示状态的来源；默认是应用 store。 */
  /** Where display state comes from; defaults to the app store. */
  state?: () => ViewState
  /**
   * 嵌入在别的页面里：滚轮只在画布获得焦点（点过一下）或按住 Ctrl / ⌘ 时缩放，否则让页面照常滚动；
   * 触摸时未激活前竖向滑动留给页面。
   * Embedded in another page: the wheel zooms only once the canvas has focus (after a click) or
   * with Ctrl / ⌘ held, otherwise the page scrolls as usual; before activation a vertical touch
   * swipe is left to the page.
   */
  embed?: boolean
  /** false：只能环绕，不悬停、不选择（对照窗格）。 */
  /** false: orbit only — no hover, no selection (compare pane). */
  interactive?: boolean
}

export interface CameraPose {
  /** 相机相对环绕目标的位置。 */
  /** Camera position relative to the orbit target. */
  offset: [number, number, number]
  /** 环绕目标相对查看器锚点的位置（见 `setAnchor`）。 */
  /** Orbit target relative to the viewer's anchor (see `setAnchor`). */
  target: [number, number, number]
}

export interface LoadProgress {
  /** 已请求的系统中已结束（成功或失败）的个数与总数 / Finished (loaded or failed) and total among the requested systems. */
  done: number
  total: number
  /** 已下载 / 预计的字节数 / Bytes received / expected. */
  bytes: number
  bytesTotal: number
  /** 这一批请求中遇到的问题 / Problems met so far. */
  problems: string[]
  /** 几何已到达的系统，按到达顺序。 */
  /** Systems whose geometry has arrived, in arrival order. */
  loaded: SystemId[]
}

const TAP_MAX_MOVE = 6
const TAP_MAX_MS = 450
const DOUBLE_TAP_MS = 350

export class Viewer {
  readonly renderer: WebGPURenderer
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(35, 1, 0.005, 60)
  readonly controls: OrbitControls
  backend: 'webgpu' | 'webgl2' = 'webgl2'
  /** 鼠标在画布上悬停时以客户区坐标调用，离开时传 null。 */
  /** Called with client coordinates while the mouse hovers the canvas, and null when it leaves. */
  onPointer: ((xy: { x: number; y: number } | null) => void) | null = null

  private readonly root = new ClippingGroup()
  private readonly plane = new Plane(new Vector3(0, -1, 0), 0)
  private batches: PartRenderer | null = null
  /** 'batched'（WebGPU）或 'meshes'（WebGL2 回退）；原因见 meshes.ts。 */
  /** 'batched' (WebGPU) or 'meshes' (WebGL2 fallback); see meshes.ts for why. */
  scenePath: 'batched' | 'meshes' = 'batched'
  /** 每个部件的批次实例 id（与 graph.parts 同序），没有几何时为 -1。 */
  /** Batch instance id per part (indexed like graph.parts), -1 when the part has no geometry. */
  private inst: Int32Array
  private bvh: (MeshBVH | null)[]
  /** 每个部件的等效管半径，米（未知为 0）。 */
  /** Equivalent tube radius per part, metres (0 when unknown). */
  private radius: Float32Array
  /** 细到需要容差拾取的部件。 */
  /** Parts thin enough to get tolerant picking. */
  private thinParts: number[] = []
  private baseColor: Color[]
  private display: Uint8Array
  private offsets: Float32Array
  private pickable: Uint8Array
  /** 部件当前以不透明方式绘制时为 1（剖切时显示其填充的背面）。 */
  /** 1 when the part is currently drawn opaque (so a section shows its filled back faces). */
  private solid: Uint8Array
  private planeEq: PlaneEq | null = null
  /** 皮肤类部件烘焙后的几何，供体表图图层使用 / Baked geometry of skin parts, kept for the skin map layer. */
  private skinGeometry = new Map<number, SkinGeometry>()
  private skinLayer: SkinLayer | null = null
  /** 体表图所在皮肤部件的索引；-1 表示当前没有显示体表图 / Index of the mapped skin part; -1 when no map is shown. */
  private skinIndex = -1
  private skinPickable = false
  private lastFace = -1
  private posedApplied = false
  /** 已应用到顶点缓冲的表情数据，以及被它改写的部件的原始静止位置 / The face data applied to the vertex buffers, and the original rest positions of the parts it rewrote. */
  private appliedFace: LoadedFace | null = null
  private mainSkin: string | null = null
  /** 已加载的各系统 GLB 的字节哈希（文件名 → sha256 前 16 位）/ Byte hashes of the system GLBs loaded so far (file name → first 16 hex of sha256). */
  private glbHashes = new Map<string, string>()
  /** 贴在皮肤本体上、跟着它变形的覆盖网格（皱纹细节、疼痛分布）/ Overlay meshes on the skin proper that deform with it (wrinkle detail, pain map). */
  private followers: { patch: SkinPatch; setSkinning(mode: SkinningMode): void; dispose(): void }[] = []
  private detailLayer: FaceDetailLayer | null = null
  // —— 刺激的可视化（见 stepStim）/ the stimulus visuals (see stepStim) ——
  private stimEval: unknown = null
  private framedStim: unknown = null
  private restVersion = 0
  private stimParts: ReadonlySet<string> = new Set()
  private stimDirty = false
  private stimSee = false
  private painOverlay: PainOverlay | null = null
  private pathVisuals: PathVisuals | null = null
  private pathRest: Float32Array | null = null
  private pathBinding: PathBinding | null = null
  private pathCandidates: number[] = []
  private pathBuf = new Float32Array(0)
  private pathVersion = -1
  private reflexPose: Pose = {}
  private reflexKey = '{}'
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private holdActive = false
  private appliedDetail: LoadedDetail | null = null
  private readonly detailWeights: number[] = []
  /** 被改写过静止几何的部件：原始的位置与法线 / Parts whose rest geometry was rewritten: their original positions and normals. */
  private restOrig = new Map<number, { position: Float32Array; normal: Float32Array }>()
  /** 施加体型位移之后、表情位移之前的静止位置 / Rest positions after the shape displacement, before the face displacement. */
  private shaped = new Map<number, Float32Array>()
  private appliedShape: LoadedShape | null = null
  private appliedControls: ShapeControls | null = null
  private shapeForce = false
  /** 这些部件的缓冲需要按当前体型与表情重写 / Parts whose buffers must be rewritten for the current shape and expression. */
  private restDirty = new Set<number>()
  /** 被改写的部件当前的包围盒（拾取的粗筛用）/ Current bounds of rewritten parts (for the pick broad phase). */
  private boxOverride = new Map<number, [number, number, number, number, number, number]>()
  private faceDisplaced = new Set<number>()
  private faceAUs: AUs = {}
  private faceJaw = 0
  private faceForce = false
  private poseDirty = false
  private jawApplied = 0
  private prewarmVersion = -1
  private prewarmNext = 0
  private skinLayerPart = -1

  /** 关节纹理最多容纳的行数（关节数 + 1）和肌肉作用线数 / Capacity of the joint texture (joints + 1) and of the muscle texture. */
  private static readonly MAX_JOINT_ROWS = 512
  private static readonly MAX_MUSCLES = 1024
  readonly skinning = new SkinningData(Viewer.MAX_JOINT_ROWS, Viewer.MAX_MUSCLES)
  private poseRt: PoseRuntime | null = null
  /** 已写入顶点属性的绑定（与 store 中的不同则需重新写入）/ The rig whose influences are in the vertex attributes. */
  private appliedRig: LoadedRig | null = null
  private loadComplete = false
  /** 各系统几何的加载状态；没有条目表示还没请求 / Load state of each system's geometry; no entry = not requested yet. */
  private systemLoad = new Map<SystemId, 'pending' | 'loaded' | 'failed'>()
  private systemBytes = new Map<SystemId, { loaded: number; total: number }>()
  private loadedOrder: SystemId[] = []
  private loadProblems: string[] = []
  private attachedObjects = 0
  /** 为真时按显示状态自动加载需要的系统（主视图）；对照窗格自己指定 / When true, systems are fetched as the display state needs them (main view); the compare pane names its own. */
  autoLoad = false
  /** 加载进度回调 / Load progress callback. */
  onLoad: ((p: LoadProgress) => void) | null = null
  /** 用户动过相机之后（或 URL 设过相机）报告位置与目标；复位时报告 undefined。 */
  /** Reports position and target once the user has moved the camera (or a URL set it); undefined after a reset. */
  onCameraSettled: ((cam: { p: [number, number, number]; t: [number, number, number] } | undefined) => void) | null = null
  private cameraNonce = 0
  private readonly embed: boolean
  /** 暂停的原因（页面隐藏、滚出视口）；非空时渲染循环停止 / Why the loop is paused (page hidden, scrolled out of view); non-empty = stopped. */
  private readonly pauseReasons = new Set<string>()
  private pausedAt = 0
  private tickCount = 0
  private intersection: IntersectionObserver | null = null
  /** 屏幕上实际显示的姿势（过渡动画中的中间值）/ The pose actually on screen (mid-transition values included). */
  private displayPose: Pose = {}
  private poseTween: { from: Pose; to: Pose; t0: number; ms: number } | null = null
  private poseTarget: Pose = {}
  private poseScales: Scales | null = null
  /** 相机已经跟到的那套缩放、此刻的身体包围盒（null = 原样），以及"相机来自链接，下一次只记不动" */
  /** The scales the camera has followed, the body bounds right now (null = as built), and "the camera came from a link: record next time, do not move". */
  private framedScales: Scales | null = null
  private frameBounds: [number, number, number, number, number, number] | null = null
  private framePending = false
  private breathing = false
  private breathT0 = 0
  /** 当前是否处于摆姿势状态（着色器走蒙皮分支）/ Whether the scene is currently posed (shaders on the skinning branch). */
  private posed = false
  private skinMode: SkinningMode = 'off'
  private readonly gizmo = new JointGizmo()
  private gizmoJoint: string | null = null
  private gizmoDrag: { dof: number; last: { x: number; y: number }; angle: number; id: number } | null = null

  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()
  private readonly localRay = new Ray()
  private lastPointerType: 'mouse' | 'touch' = 'mouse'

  private raf = 0
  private dirty = true
  private syncNeeded = true
  private prev: ViewState | null = null
  private graph: AnatomyGraph
  private baseUrl: string
  /** setBody 时递增，使上一个人体的加载不再改动场景。 */
  /** Bumped by setBody so loads of a previous body stop touching the scene. */
  private bodyToken = 0
  private bvhVersion = 0
  private readonly source: () => ViewState
  /** 对照窗格用：姿势 / 体型 / 表情数据被拒绝时的回调 / For the compare pane: called when rig / shape / face data is refused. */
  onReject: ((kind: 'rig' | 'shape' | 'face', message: string) => void) | null = null
  private readonly interactive: boolean
  private readonly anchor = new Vector3()
  private applyingPose = false
  /** 相机移动时调用（通过 setPose 应用姿态时不调用）。 */
  /** Called when the camera moves (not when a pose is applied through setPose). */
  onCamera: ((pose: CameraPose) => void) | null = null
  private forceFull = false
  private focusNonce = 0
  private homeNonce = 0
  private unsubscribe: (() => void) | null = null
  private resizeObserver: ResizeObserver | null = null
  private disposed = false
  private continuous = false

  private hoverXY: { x: number; y: number } | null = null
  private down: { x: number; y: number; t: number; id: number } | null = null
  private lastTap: { x: number; y: number; t: number } | null = null
  private pointers = new Set<number>()

  private tween: {
    t0: number
    ms: number
    fromPos: Vector3
    toPos: Vector3
    fromTarget: Vector3
    toTarget: Vector3
  } | null = null

  private bvhQueue: number[] = []
  private bvhBuilt = 0
  private bvhTotal = 0

  // 滚动统计
  // rolling stats
  private statT = 0
  private statTicks = 0
  private statFrames = 0
  private statRenderMs = 0
  private stat = { tickFps: 0, renderedFps: 0, renderCpuMs: 0 }
  private frameLog: number[] | null = null
  private renderLog: number[] | null = null
  private lastFrameT = 0

  constructor(
    private readonly container: HTMLElement,
    graph: AnatomyGraph,
    baseUrl: string,
    opts: ViewerOptions = {},
  ) {
    this.graph = graph
    this.baseUrl = baseUrl
    this.source = opts.state ?? useApp.getState
    if (this.source === useApp.getState) {
      registerStimHost({
        skinRest: () => {
          const i = this.mainSkinIndex()
          return i >= 0 ? { part: this.mainSkin!, positions: this.skinGeometry.get(i)!.position } : null
        },
        request: (systems) => this.requestSystems(systems),
      })
    }
    this.interactive = opts.interactive ?? true
    this.embed = opts.embed ?? false
    this.renderer = new WebGPURenderer({ antialias: true, forceWebGL: opts.forceWebGL ?? false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setClearColor(new Color('#15181d'), 1)
    this.renderer.info.autoReset = false // reset per frame by hand so counts are per-frame
    const canvas = this.renderer.domElement
    canvas.className = 'viewer-canvas'
    container.appendChild(canvas)

    this.inst = new Int32Array(0)
    this.bvh = []
    this.radius = new Float32Array(0)
    this.baseColor = []
    this.display = new Uint8Array(0)
    this.offsets = new Float32Array(0)
    this.pickable = new Uint8Array(0)
    this.solid = new Uint8Array(0)
    this.allocate()

    // 光照：柔和的天空 / 地面补光，加一盏随相机移动的主光，这样无论模型怎么转，朝向观察者的表面总是被照亮
    // lighting: soft sky/ground fill plus a key light that travels with the camera, so the
    // surface facing the viewer is always lit however the model is turned
    this.scene.add(new HemisphereLight(0xf2f5fa, 0x4a443e, 1.25))
    const key = new DirectionalLight(0xfff6ea, 2.3)
    key.position.set(-0.35, 0.55, 1)
    const keyTarget = new Object3D()
    keyTarget.position.set(0, 0, -1)
    this.camera.add(key, keyTarget)
    key.target = keyTarget
    const rim = new DirectionalLight(0xdfe8ff, 0.7)
    rim.position.set(0.6, 1.2, -1.5)
    this.scene.add(rim, this.camera, this.root, this.gizmo.group)
    this.root.clippingPlanes = [this.plane]
    this.root.enabled = false

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.14
    this.controls.zoomToCursor = true
    this.controls.minDistance = 0.03
    this.controls.maxDistance = 9
    this.controls.addEventListener('change', () => {
      this.dirty = true
      if (!this.applyingPose) this.onCamera?.(this.getPose())
    })
    this.controls.addEventListener('start', () => {
      this.tween = null
    })
    this.controls.addEventListener('end', () => this.reportCamera())
    if (this.embed) {
      canvas.tabIndex = 0
      canvas.style.touchAction = 'pan-y'
    }
    this.home(false)
  }

  async init(): Promise<void> {
    await this.renderer.init()
    const b = this.renderer.backend as { isWebGPUBackend?: boolean }
    this.backend = b.isWebGPUBackend ? 'webgpu' : 'webgl2'

    this.resize()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(this.container)

    const el = this.renderer.domElement
    el.addEventListener('pointerdown', this.onGizmoDown, { capture: true })
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointercancel', this.onPointerCancel)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerleave', this.onPointerLeave)
    el.addEventListener('contextmenu', this.onContextMenu)
    if (this.embed) {
      el.addEventListener('wheel', this.onEmbedWheel, { capture: true })
      el.addEventListener('focus', this.onEmbedFocus)
      el.addEventListener('blur', this.onEmbedBlur)
    }
    document.addEventListener('visibilitychange', this.onVisibility)
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersection = new IntersectionObserver((entries) => {
        for (const e of entries) this.setPaused('offscreen', !e.isIntersecting)
      })
      this.intersection.observe(el)
    }
    if (document.visibilityState === 'hidden') this.pauseReasons.add('hidden')

    if (this.source === useApp.getState) {
      this.unsubscribe = useApp.subscribe(() => {
        this.syncNeeded = true
      })
    }
    if (this.pauseReasons.size === 0) this.raf = requestAnimationFrame(this.tick)
    else this.pausedAt = performance.now()
  }

  private onVisibility = (): void => this.setPaused('hidden', document.visibilityState === 'hidden')

  /**
   * 暂停 / 恢复渲染循环（连同姿势与呼吸动画、空闲时的 BVH 预构建）。恢复时把各动画的起始时刻
   * 顺延暂停的时长，所以动画不会跳。
   * Pause / resume the render loop (with pose and breathing animation and the idle BVH
   * pre-builds). On resume every animation's start time is shifted by the paused duration, so
   * nothing jumps.
   */
  setPaused(reason: string, on: boolean): void {
    const was = this.pauseReasons.size > 0
    if (on) this.pauseReasons.add(reason)
    else this.pauseReasons.delete(reason)
    const now = this.pauseReasons.size > 0
    if (was === now || this.disposed) return
    if (this.source === useApp.getState) setPainPaused(now)
    if (now) {
      cancelAnimationFrame(this.raf)
      this.pausedAt = performance.now()
      return
    }
    const dt = performance.now() - this.pausedAt
    if (this.tween) this.tween.t0 += dt
    if (this.poseTween) this.poseTween.t0 += dt
    this.breathT0 += dt
    this.lastFrameT = 0
    this.dirty = true
    this.raf = requestAnimationFrame(this.tick)
  }

  private onEmbedWheel = (e: WheelEvent): void => {
    // 未激活且没按修饰键：不交给相机控制器，也不阻止默认行为，页面照常滚动
    // not activated and no modifier: keep it from the camera controls and let the page scroll
    if (document.activeElement !== this.renderer.domElement && !e.ctrlKey && !e.metaKey) e.stopImmediatePropagation()
  }
  private onEmbedFocus = (): void => {
    this.renderer.domElement.style.touchAction = 'none'
  }
  private onEmbedBlur = (): void => {
    this.renderer.domElement.style.touchAction = 'pan-y'
  }

  private reportCamera(): void {
    const p = this.camera.position
    const t = this.controls.target
    this.onCameraSettled?.({ p: [p.x, p.y, p.z], t: [t.x, t.y, t.z] })
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.intersection?.disconnect()
    this.unsubscribe?.()
    this.resizeObserver?.disconnect()
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this.onGizmoDown, { capture: true })
    this.onGizmoUp({ pointerId: this.gizmoDrag?.id ?? -1 } as PointerEvent)
    el.removeEventListener('pointerdown', this.onPointerDown)
    el.removeEventListener('pointerup', this.onPointerUp)
    el.removeEventListener('pointercancel', this.onPointerCancel)
    el.removeEventListener('pointermove', this.onPointerMove)
    el.removeEventListener('pointerleave', this.onPointerLeave)
    el.removeEventListener('contextmenu', this.onContextMenu)
    el.removeEventListener('wheel', this.onEmbedWheel, { capture: true })
    el.removeEventListener('focus', this.onEmbedFocus)
    el.removeEventListener('blur', this.onEmbedBlur)
    this.controls.dispose()
    this.batches?.dispose()
    this.skinLayer?.dispose()
    this.gizmo.dispose()
    this.skinning.dispose()
    this.renderer.dispose()
    el.remove()
  }

  // ------------------------------------------------------------ 几何加载 / geometry loading

  private allocate(): void {
    this.mainSkin = this.graph.mainSkinId()
    const n = this.graph.parts.length
    this.inst = new Int32Array(n).fill(-1)
    this.bvh = new Array<MeshBVH | null>(n).fill(null)
    this.radius = new Float32Array(n)
    this.baseColor = this.graph.parts.map(() => new Color())
    this.display = new Uint8Array(n)
    this.offsets = new Float32Array(n * 3)
    this.pickable = new Uint8Array(n)
    this.solid = new Uint8Array(n)
    this.thinParts = []
    this.bvhQueue = []
    this.bvhBuilt = 0
    this.bvhTotal = 0
    this.skinGeometry = new Map()
    if (this.skinLayer) {
      this.root.remove(this.skinLayer.mesh)
      this.skinLayer.dispose()
      this.skinLayer = null
    }
    this.skinIndex = -1
    this.skinPickable = false
    for (const f of this.followers) {
      this.root.remove(f.patch.mesh)
      f.dispose()
    }
    this.followers = []
    this.glbHashes = new Map()
    this.detailLayer = null
    this.painOverlay = null
    this.clearStim()
    this.appliedDetail = null
    this.poseRt = null
    this.appliedRig = null
    this.loadComplete = false
    this.systemLoad = new Map()
    this.systemBytes = new Map()
    this.loadedOrder = []
    this.loadProblems = []
    this.attachedObjects = 0
    this.poseTween = null
    this.displayPose = {}
    this.posed = false
    this.skinMode = 'off'
    this.gizmo.clear()
    this.gizmoDrag = null
    this.appliedFace = null
    this.restOrig = new Map()
    this.shaped = new Map()
    this.appliedShape = null
    this.appliedControls = null
    this.restDirty = new Set()
    this.boxOverride = new Map()
    this.faceDisplaced = new Set()
    this.faceAUs = {}
    this.faceJaw = 0
  }

  /**
   * 替换显示的人体：释放旧人体的 GPU 缓冲和 BVH，保留渲染器、相机和控制器。之后调用 `loadSystems`。
   * Replace the body on show: frees the old body's GPU buffers and BVHs and keeps the
   * renderer, camera and controls. Follow with `loadSystems`.
   */
  setBody(graph: AnatomyGraph, baseUrl: string, opts: { keepCamera?: boolean } = {}): void {
    this.bodyToken++
    this.framedScales = null
    this.frameBounds = null
    this.framePending = false
    if (this.batches) {
      this.root.remove(...this.batches.objects)
      this.batches.dispose()
      this.batches = null
    }
    this.graph = graph
    this.baseUrl = baseUrl
    this.allocate()
    this.hoverXY = null
    this.forceFull = true
    this.syncNeeded = true
    this.dirty = true
    if (!opts.keepCamera) this.home(false)
  }

  /** 场景表示（合批或逐网格），按整个人体的规模一次建好；各系统的几何之后陆续填入。 */
  /** The scene representation (batched or per-mesh), sized once for the whole body; systems are filled in as they arrive. */
  private ensureRenderer(): PartRenderer {
    if (this.batches) return this.batches
    // 索引数可由数据文件得知；顶点数未知，所以先用估计值，某个人体需要更多时批次会扩容。
    // The index count is known from the data file; the vertex count is not, so it starts
    // from an estimate and the batch grows if a body needs more.
    let triangles = 0
    for (const p of this.graph.parts) triangles += p.triangles
    const forced = new URLSearchParams(location.search).get('scene')
    this.scenePath = forced === 'batched' || forced === 'meshes' ? forced : this.backend === 'webgpu' ? 'batched' : 'meshes'
    const batches: PartRenderer =
      this.scenePath === 'batched'
        ? new PartBatches(this.graph.parts.length, Math.ceil(triangles * 0.62) + 2000, triangles * 3 + 3000, this.skinning)
        : new PartMeshes(this.skinning, new URLSearchParams(location.search).get('chunks') !== '0')
    if (this.scenePath === 'meshes') this.renderer.setTransparentSort(centroidTransparentSort as never)
    this.batches = batches
    this.updateBoost()
    return batches
  }

  private emitLoad(): void {
    let done = 0
    let bytes = 0
    let bytesTotal = 0
    for (const st of this.systemLoad.values()) if (st !== 'pending') done++
    for (const b of this.systemBytes.values()) {
      bytes += b.loaded
      bytesTotal += b.total
    }
    this.onLoad?.({ done, total: this.systemLoad.size, loaded: [...this.loadedOrder], bytes, bytesTotal, problems: [...this.loadProblems] })
  }

  /** 是否有系统正在加载 / Whether any system is still loading. */
  get loading(): boolean {
    for (const st of this.systemLoad.values()) if (st === 'pending') return true
    return false
  }

  /**
   * 加载给定系统中尚未请求过的那些。每个系统的文件一到就显示；缺失或损坏的文件会被记录并跳过。
   * Fetch those of the given systems that were not requested yet. Each appears as soon as its
   * file has arrived; a missing or broken file is recorded and skipped.
   */
  requestSystems(ids: Iterable<SystemId>): Promise<void> {
    const token = this.bodyToken
    const graph = this.graph
    const wanted = [...ids].map((id) => graph.data.systems.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s && !!s.glb && !this.systemLoad.has(s.id))
    if (wanted.length === 0) return Promise.resolve()
    const batches = this.ensureRenderer()
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    for (const sys of wanted) this.systemLoad.set(sys.id, 'pending')
    this.loadComplete = false
    this.emitLoad()
    return Promise.all(
      wanted.map(async (sys) => {
        try {
          // 自己取字节（而不是交给加载器去取）：要拿它们的哈希去核对绑定和体型数据是不是为这份几何生成的
          // the bytes are fetched here (rather than by the loader) so that their hash can tell whether the rig and the shape data were built for this geometry
          const url = new URL(sys.glb!, new URL(this.baseUrl, location.href)).href
          const bytes = await fetchBytes(url, (loaded, total) => {
            if (token !== this.bodyToken) return
            this.systemBytes.set(sys.id, { loaded, total: total || loaded })
            this.emitLoad()
          })
          const hash = await sha256Prefix(bytes)
          const gltf = await loader.parseAsync(bytes, url.slice(0, url.lastIndexOf('/') + 1))
          if (this.disposed || token !== this.bodyToken) return
          if (hash) this.glbHashes.set(sys.glb!, hash)
          const baked = this.bake(gltf.scene)
          const fresh: number[] = []
          for (const [i, b] of baked) {
            if (this.inst[i]! >= 0) continue
            const part = graph.parts[i]!
            if (part.tissue === 'skin') {
              // 体表图按 GLB 解码的顶点顺序索引皮肤，这里保留一份
              // skin maps index the skin in GLB decode order, so keep a copy of it
              this.skinGeometry.set(i, {
                position: new Float32Array(b.geometry.getAttribute('position').array),
                normal: new Float32Array(b.geometry.getAttribute('normal').array),
                index: new Uint32Array(b.geometry.index!.array),
              })
            }
            this.radius[i] = b.radius
            if (b.radius > 0 && b.radius < THIN_RADIUS) this.thinParts.push(i)
            this.inst[i] = batches.add(b, part.tissue === 'nerve' ? b.radius : null, part.bbox, part.centroid)
            this.bvhQueue.push(i)
            this.bvhTotal++
            fresh.push(i)
          }
          batches.finish()
          for (const b of baked.values()) b.geometry.dispose()
          const objects = batches.objects
          if (objects.length > this.attachedObjects) this.root.add(...objects.slice(this.attachedObjects))
          this.attachedObjects = objects.length
          this.systemLoad.set(sys.id, 'loaded')
          this.loadedOrder.push(sys.id)
          // 绑定已经写入时，后到的部件补写它们的影响（先核对这个 GLB 是不是绑定生成时的那一份）
          // with a rig already applied, late parts get their influences now (after checking this GLB is the one the rig was built from)
          if (this.appliedRig && this.poseRt && !this.rigIsStale(this.appliedRig)) this.writeRigParts(this.appliedRig, fresh)
          this.shapeForce = true
          this.faceForce = true // 新到的部件也要套上当前的表情 / parts that just arrived take the current expression too
          this.forceFull = true
          this.syncNeeded = true
          const expected = graph.partsBySystem(sys.id).length
          if (baked.size < expected) this.loadProblems.push(`${sys.name.zh}：${expected - baked.size}/${expected} 个结构在 ${sys.glb} 中没有几何`)
        } catch (err) {
          if (this.disposed || token !== this.bodyToken) return
          console.warn(`[soma] failed to load ${sys.glb}`, err)
          this.systemLoad.set(sys.id, 'failed')
          this.loadProblems.push(`${sys.name.zh}：无法加载 ${sys.glb}`)
        }
        if (token !== this.bodyToken) return
        if (!this.loading) {
          this.loadComplete = true
          this.syncNeeded = true
        }
        this.emitLoad()
      }),
    ).then(() => undefined)
  }

  /**
   * 加载各系统的 GLB（全部，或仅 `only`），返回遇到的问题。对照窗格和测试用；主视图由显示状态驱动加载。
   * Load the systems' GLBs (all, or just `only`) and return the problems met. Used by the
   * compare pane and tests; the main view loads as its display state requires.
   */
  async loadSystems(onProgress: (p: LoadProgress) => void, only?: readonly SystemId[]): Promise<string[]> {
    this.onLoad = onProgress
    await this.requestSystems(only ?? this.graph.data.systems.map((s) => s.id))
    if (!this.loading) {
      this.loadComplete = true
      this.syncNeeded = true
    }
    return [...this.loadProblems]
  }

  /**
   * 当前显示状态需要哪些系统的几何：隔离时只要被隔离部件所在的系统，否则是可见的系统；
   * 再加上被选中、相邻模式涉及的部件以及体表图所在皮肤的系统。
   * Which systems' geometry the display state needs: under isolation only the systems of the
   * isolated parts, otherwise the visible systems; plus those of selected parts, of the adjacent
   * focus, and of the skin a skin map is painted on.
   */
  private neededSystems(s: ViewState): Set<SystemId> {
    const need = new Set<SystemId>()
    const add = (id: string): void => {
      const p = this.graph.part(id)
      if (p) need.add(p.system)
    }
    if (s.isolated) for (const id of s.isolated) add(id)
    else for (const sys of this.graph.data.systems) if (s.systems[sys.id]?.visible ?? true) need.add(sys.id)
    for (const id of s.selection.ids) add(id)
    if (s.adjacentMode) for (const id of s.selection.ids) for (const a of this.graph.part(id)?.adjacent ?? []) add(a)
    if (s.skinMapMode !== 'off' && s.skinMaps) add(s.skinMaps.part)
    for (const id of this.stimParts) add(id)
    return need
  }

  /** 烘焙一个已加载 GLB 中的部件，按部件索引存放。 */
  /** Bake the parts found in one loaded GLB, keyed by part index. */
  private bake(gltfScene: Object3D): Map<number, BakedPart> {
    gltfScene.updateMatrixWorld(true)
    const byPart = new Map<number, Mesh[]>()
    gltfScene.traverse((o) => {
      const mesh = o as Mesh
      if (!mesh.isMesh) return
      // 部件 id 是网格节点的名字；当含多个图元的网格被加载器拆成子节点时，取其祖先的名字
      // the part id is the name of the mesh's node, or of an ancestor when a mesh with
      // several primitives was split into children by the loader
      let cur: Object3D | null = mesh
      while (cur) {
        const index = this.graph.indexOf((cur.userData.name as string | undefined) ?? cur.name)
        if (index >= 0) {
          const list = byPart.get(index)
          if (list) list.push(mesh)
          else byPart.set(index, [mesh])
          return
        }
        cur = cur.parent
      }
    })
    const out = new Map<number, BakedPart>()
    for (const [index, meshes] of byPart) {
      out.set(index, bakePart(meshes))
      for (const m of meshes) {
        m.geometry.dispose()
        const mats = m.material
        for (const mat of Array.isArray(mats) ? mats : [mats]) mat.dispose()
      }
    }
    return out
  }

  /** 查看器显示的已不是 `graph`（或已销毁）时为真。 */
  /** True once this viewer shows a different body than `graph` (or is disposed). */
  isStale(graph: AnatomyGraph): boolean {
    return this.disposed || this.graph !== graph
  }

  hasGeometry(partIndex: number): boolean {
    return (this.inst[partIndex] ?? -1) >= 0
  }

  /** 由网格测得的部件等效管半径，米（0 表示没有几何）。 */
  /** Equivalent tube radius of a part in metres, as measured from its mesh (0 = no geometry). */
  radiusOf(partId: string): number {
    const i = this.graph.indexOf(partId)
    return i < 0 ? 0 : this.radius[i]!
  }

  private updateBoost(): void {
    const on = this.source().nerveBoost
    const h = Math.max(1, this.container.clientHeight)
    // 每米距离上一个 CSS 像素对应的世界尺寸，乘以想要的像素半径
    // world size of one CSS pixel per metre of distance, times the wanted pixel radius
    const perMetre = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / h
    this.batches?.setBoost(on ? perMetre * NERVE_MIN_RADIUS_PX : 0)
  }

  // ------------------------------------------------------------ 状态 → 场景 / state → scene

  /** 通知使用自有状态来源的查看器：状态变了。 */
  /** Tell a viewer with its own state source that the state changed. */
  invalidateState(): void {
    this.syncNeeded = true
  }

  private sync(): void {
    const s = this.source()
    const p = this.forceFull ? null : this.prev
    this.prev = s
    this.forceFull = false
    this.syncNeeded = false
    if (this.autoLoad) void this.requestSystems(this.neededSystems(s))
    if (s.cameraRequest && s.cameraRequest.nonce !== this.cameraNonce) {
      this.cameraNonce = s.cameraRequest.nonce
      this.tween = null
      this.camera.position.set(...s.cameraRequest.p)
      this.controls.target.set(...s.cameraRequest.t)
      // 链接里的相机是对着链接里的体型存的 / a linked camera was saved for the linked shape
      this.framePending = s.jointScales ? s.jointScales !== this.framedScales : Object.keys(s.shapeControls).some((k) => k !== 'bmi')
      this.controls.update()
      this.dirty = true
    }
    const wantFocus = s.focusRequest.nonce !== this.focusNonce
    const wantHome = s.homeRequest !== this.homeNonce
    this.focusNonce = s.focusRequest.nonce
    this.homeNonce = s.homeRequest

    const displayChanged =
      !p ||
      p.systems !== s.systems ||
      p.peel !== s.peel ||
      p.hidden !== s.hidden ||
      p.isolated !== s.isolated ||
      p.adjacentMode !== s.adjacentMode ||
      p.provenanceHidden !== s.provenanceHidden ||
      p.colorMode !== s.colorMode ||
      this.stimDirty ||
      p.skinOpaque !== s.skinOpaque ||
      skinDrawnOpaque(p, this.mainSkin) !== skinDrawnOpaque(s, this.mainSkin) ||
      p.selection !== s.selection
    this.stimDirty = false
    const explodeChanged =
      !p ||
      p.explode !== s.explode ||
      p.explodeSelectionOnly !== s.explodeSelectionOnly ||
      (s.explodeSelectionOnly && s.explode > 0 && p.selection !== s.selection)
    const sectionChanged = !p || p.section !== s.section
    const hoverChanged = !p || p.hover !== s.hover
    const boostChanged = !p || p.nerveBoost !== s.nerveBoost
    this.syncDetail(s)
    this.syncPose(s, p)
    // 摆姿势时不做爆炸视图（部件各自平移会与关节运动冲突）
    // no explode while posed (per-part translation would fight the joint motion)
    const explodeAmount = this.posed ? 0 : s.explode
    const posedFlipped = this.posedApplied !== this.posed
    this.posedApplied = this.posed
    const explodeNow = explodeChanged || posedFlipped
    const skinChanged =
      !p ||
      p.skinMapMode !== s.skinMapMode ||
      p.skinMaps !== s.skinMaps ||
      p.skinRegions !== s.skinRegions ||
      p.skinHover !== s.skinHover ||
      p.skinSeeThrough !== s.skinSeeThrough
    if (!displayChanged && !explodeNow && !sectionChanged && !hoverChanged && !boostChanged && !skinChanged) {
      if (wantHome) this.home(true)
      if (wantFocus) this.focus(s.focusRequest.ids)
      return
    }
    this.dirty = true
    const batches = this.batches
    if (boostChanged) this.updateBoost()

    if (sectionChanged) {
      const sec = s.section
      this.planeEq = sec.enabled ? sectionPlane(this.graph.bodyBounds, sec) : null
      if (this.planeEq) {
        this.plane.normal.set(...this.planeEq.normal)
        this.plane.constant = this.planeEq.constant
      }
      this.root.enabled = sec.enabled
      batches?.setCapped(sec.enabled)
      this.skinLayer?.setCapped(sec.enabled)
    }

    const parts = this.graph.parts
    if (explodeNow) {
      computeExplode(this.graph, explodeAmount, s.explodeSelectionOnly ? s.selection.set : null, this.offsets)
      if (batches) {
        for (let i = 0; i < parts.length; i++) {
          const id = this.inst[i]!
          if (id < 0) continue
          const c = parts[i]!.centroid
          const x = this.offsets[i * 3]!
          const y = this.offsets[i * 3 + 1]!
          const z = this.offsets[i * 3 + 2]!
          batches.setOffset(id, x, y, z, c[0] + x, c[1] + y, c[2] + z)
          if (this.followers.length && parts[i]!.id === this.mainSkin) for (const f of this.followers) f.patch.setOffset(x, y, z)
          if (LEGACY_SORT) {
            // 仅用于验证：按未合批版本的方式排序，即按网格原点（包围盒的一角）
            // verification only: sort the way the unbatched build did, by the mesh origin (a bbox corner)
            const bb = parts[i]!.bbox
            batches.setOffset(id, x, y, z, bb[0] + x, bb[1] + y, bb[2] + z)
          }
        }
      }
    }

    // 体表图图层先于部件状态更新：皮肤部件是否交给图层绘制取决于它
    // the skin layer is settled before part states: it decides whether the skin part hands over to it
    const skinIndexBefore = this.skinIndex
    if (skinChanged || explodeNow || sectionChanged) this.updateSkinLayer(s)
    if (!displayChanged && this.skinIndex !== skinIndexBefore) {
      for (const i of [skinIndexBefore, this.skinIndex]) if (i >= 0) this.applyPart(i, parts[i]!, s)
    } else if (!displayChanged && skinChanged && this.skinIndex >= 0) this.applyPart(this.skinIndex, parts[this.skinIndex]!, s)

    if (displayChanged) {
      if (!p || p.colorMode !== s.colorMode) this.computeBaseColors(s)
      computeDisplay(
        this.graph,
        {
          systems: s.systems,
          peel: s.peel,
          hidden: s.hidden,
          provenanceHidden: s.provenanceHidden,
          isolated: s.isolated,
          adjacentMode: s.adjacentMode,
          // 通路上的部件像被选中一样总是显示 / parts on the pathway are always shown, like selected ones
          selected: this.stimParts.size ? new Set([...s.selection.set, ...this.stimParts]) : s.selection.set,
          unfitted: skinDrawnOpaque(s, this.mainSkin) ? this.graph.unfittedAppendages() : null,
        },
        this.display,
      )
      for (let i = 0; i < parts.length; i++) this.applyPart(i, parts[i]!, s)
      this.updateDetail()
    } else if (hoverChanged) {
      for (const id of [p?.hover, s.hover]) {
        if (!id) continue
        const i = this.graph.indexOf(id)
        if (i >= 0) this.applyPart(i, this.graph.parts[i]!, s)
      }
    }
    // 相机请求放在最后，这样能用上刚应用的显示状态和爆炸位移
    // camera requests last, so they see the display state and explode offsets just applied
    if (wantHome) this.home(true)
    if (wantFocus) this.focus(s.focusRequest.ids)
  }

  // ------------------------------------------------------------ 姿势 / posing

  /** 把 store 里的绑定、目标姿势、体型和呼吸开关同步到查看器 / Mirror rig, target pose, shape and breathing from the store. */
  private syncPose(s: ViewState, p: ViewState | null): void {
    let rigChanged = false
    if (this.loadComplete && s.rig !== this.appliedRig) {
      this.applyRig(s.rig)
      rigChanged = true
    }
    if (!p || rigChanged || s.pose !== p.pose || s.jointScales !== p.jointScales) {
      this.poseScales = s.jointScales
      if (p && !rigChanged && s.poseAnimate !== p.poseAnimate && this.poseRt) {
        this.poseTween = { from: this.poseTween ? this.displayPose : this.poseTarget, to: s.pose, t0: performance.now(), ms: 600 }
      } else this.poseTween = null
      this.poseTarget = s.pose
      this.poseDirty = true
    }
    const breathing = s.breathing && !!this.poseRt
    if (breathing !== this.breathing) {
      this.breathing = breathing
      this.breathT0 = performance.now()
      this.poseDirty = true
    }
    this.gizmoJoint = s.leftTab === 'pose' && this.poseRt ? s.poseJoint : null
    if (!this.gizmoJoint) this.gizmo.clear()
  }

  /**
   * 把绑定写进顶点属性。与已加载网格不符的绑定被拒绝（store 里标记为"此人体暂不能摆姿势"）。
   * Write a rig into the vertex attributes. A rig that does not match the loaded meshes is
   * rejected (the store then marks posing unavailable for this body).
   */
  private applyRig(rig: LoadedRig | null): void {
    this.appliedRig = rig
    this.poseRt = null
    const batches = this.batches
    if (!rig || !batches) {
      this.setDisplayPose({})
      return
    }
    if (this.rigIsStale(rig)) return
    const parts = this.graph.parts
    const count = (id: string): number | undefined => {
      const i = this.graph.indexOf(id)
      return i >= 0 && this.inst[i]! >= 0 ? batches.partBuffers(this.inst[i]!).position.length / 3 : undefined
    }
    const problems = validateRig(rig, count)
    if (rig.rig.joints.length + 1 > Viewer.MAX_JOINT_ROWS || rig.rig.muscles.length > Viewer.MAX_MUSCLES) {
      problems.push('绑定的关节或肌肉作用线数量超出查看器上限 / the rig has more joints or muscle lines than the viewer supports')
    }
    if (problems.length) {
      console.warn('[soma] rig rejected', problems)
      this.appliedRig = null
      this.reject('rig', problems.slice(0, 3).join('；'))
      return
    }
    this.writeRigParts(rig, parts.map((_, i) => i))
    this.poseRt = new PoseRuntime(rig, (i) => (this.inst[i]! >= 0 ? { id: parts[i]!.id, buffers: batches.partBuffers(this.inst[i]!) } : null))
    this.applyRigToSkinLayer()
    this.poseDirty = true
  }

  /** 绑定记录的 GLB 哈希与已加载的对不上：拒绝它（store 里标为过期）/ The GLB hashes the rig recorded do not match what is loaded: refuse it (the store marks it stale). */
  private rigIsStale(rig: LoadedRig): boolean {
    const stale = staleInputs(rig.report?.inputs, this.glbHashes)
    if (stale.length === 0) return false
    console.warn('[soma] rig rejected: built from other geometry', stale)
    this.appliedRig = null
    this.poseRt = null
    this.setDisplayPose({})
    this.reject('rig', `${RIG_STALE_MESSAGE}（${stale.join('、')}）`)
    return true
  }

  /** 把绑定写进给定部件的顶点属性 / Write the rig into the vertex attributes of the given parts. */
  private writeRigParts(rig: LoadedRig, indices: readonly number[]): void {
    const batches = this.batches
    if (!batches) return
    const parts = this.graph.parts
    for (const i of indices) {
      const id = this.inst[i]!
      if (id < 0) continue
      const b = batches.partBuffers(id)
      const n = b.position.length / 3
      const binding = rig.bindingOf.get(parts[i]!.id)
      if (binding && binding.joint === undefined && binding.vertexCount !== n) {
        // 后到的系统与绑定不符：整套绑定作废 / a late system does not match the rig: the whole rig is refused
        console.warn(`[soma] rig rejected: ${parts[i]!.id} has ${n} vertices, the binding ${binding.vertexCount}`)
        this.appliedRig = null
        this.poseRt = null
        this.reject('rig', `部件 ${parts[i]!.id} 的绑定与网格不符 / the binding of ${parts[i]!.id} does not match its mesh`)
        return
      }
      writeInfluences(rig, parts[i]!.id, n, b.skinIndex, b.skinWeight, 0)
      const line = rig.muscleOf.get(parts[i]!.id)
      // 肌肉部件：aThin 记作 −(作用线下标 + 1)，着色器据此做体积修正
      // muscle parts: aThin holds −(line index + 1), which the shader uses for the volume correction
      if (line !== undefined) b.aux.fill(-(line + 1))
    }
    batches.flushSkinAttributes()
    for (const f of this.followers) this.applyRigToFollower(f.patch)
  }

  /** 皮肤本体在 graph.parts 里的下标；没有几何时为 -1 / Index of the skin proper in graph.parts; -1 without geometry. */
  private mainSkinIndex(): number {
    const i = this.mainSkin ? this.graph.indexOf(this.mainSkin) : -1
    return i >= 0 && this.inst[i]! >= 0 && this.skinGeometry.has(i) ? i : -1
  }

  private applyRigToFollower(patch: SkinPatch): void {
    const rig = this.appliedRig
    const i = this.mainSkinIndex()
    if (!rig || i < 0 || !this.batches) return
    const b = this.batches.partBuffers(this.inst[i]!)
    patch.setInfluences(b.skinIndex, b.skinWeight)
  }

  /** 把一块覆盖网格挂到皮肤上：当前的位置、绑定、蒙皮方式和爆炸位移都跟上 / Attach an overlay to the skin: current positions, rig, skinning mode and explode offset all follow. */
  private addFollower(f: { patch: SkinPatch; setSkinning(mode: SkinningMode): void; dispose(): void }): void {
    const i = this.mainSkinIndex()
    if (i < 0 || !this.batches) return
    const b = this.batches.partBuffers(this.inst[i]!)
    f.patch.setPositions(b.position, b.normal)
    this.applyRigToFollower(f.patch)
    f.setSkinning(this.skinMode)
    f.patch.setOffset(this.offsets[i * 3]!, this.offsets[i * 3 + 1]!, this.offsets[i * 3 + 2]!)
    this.followers.push(f)
    this.root.add(f.patch.mesh)
  }

  private removeFollower(f: { patch: SkinPatch; dispose(): void }): void {
    this.followers = this.followers.filter((x) => x !== f)
    this.root.remove(f.patch.mesh)
    f.dispose()
  }

  /** 皱纹细节层：数据到了（或换了）就重建；权重和可见性另由 updateDetail 管 / The wrinkle detail layer: rebuilt when its data arrives or changes; weights and visibility are updateDetail's job. */
  private syncDetail(s: ViewState): void {
    if (s.faceDetail === this.appliedDetail && (this.detailLayer || !s.faceDetail)) return
    const i = this.mainSkinIndex()
    if (s.faceDetail && i < 0) return // 皮肤还没加载，下次再来 / the skin is not loaded yet; try again later
    if (this.detailLayer) {
      this.removeFollower(this.detailLayer)
      this.detailLayer = null
    }
    this.appliedDetail = s.faceDetail
    if (!s.faceDetail) return
    const geo = this.skinGeometry.get(i)!
    if (s.faceDetail.data.skin !== this.mainSkin || !FaceDetailLayer.fits(geo, s.faceDetail)) {
      // 细节数据是为另一版皮肤生成的：不画 / the detail data was built for another skin: not drawn
      console.warn(`[soma] face detail rejected: it is for ${s.faceDetail.data.skin} with ${s.faceDetail.data.vertexCount} vertices, the skin ${this.mainSkin} has ${geo.position.length / 3}`)
      return
    }
    this.detailLayer = new FaceDetailLayer(geo, s.faceDetail, this.skinning)
    this.detailLayer.setColor(this.baseColor[i]!)
    this.addFollower(this.detailLayer)
    this.updateDetail()
  }

  /** 按当前表情设各层权重；只有皮肤画成不透明（且不是体表图）时才显示 / Set the layer weights from the current expression; shown only while the skin is drawn opaque (and not as a skin map). */
  private updateDetail(): void {
    const d = this.detailLayer
    if (!d) return
    const any = d.setWeights(layerWeights(d.detail.data, this.faceAUs, this.detailWeights))
    const i = this.mainSkinIndex()
    const show = any && i >= 0 && i !== this.skinIndex && this.display[i] === NORMAL && this.solid[i] === 1
    if (d.patch.mesh.visible !== show) {
      d.patch.mesh.visible = show
      this.dirty = true
    }
  }

  /**
   * 验证用：只画细节层，用当前相机渲染到浮点目标，读回每个像素的 UV 和着色器合成的切线空间法线。
   * alpha 为 0 的像素没有被细节层盖住。
   * Verification: draw the detail layer alone with the current camera into a float target and read back,
   * per pixel, the UV and the tangent-space normal the shader composed. Pixels with alpha 0 are not covered.
   */
  async probeDetail(size = 256): Promise<{ size: number; uv: Float32Array; normal: Float32Array } | null> {
    const d = this.detailLayer
    if (!d) return null
    const mesh = d.patch.mesh
    const wasVisible = mesh.visible
    const scene = new Scene()
    scene.add(mesh)
    mesh.visible = true
    const target = new RenderTarget(size, size, { type: FloatType, format: RGBAFormat, depthBuffer: true, samples: 0 })
    const previous = this.renderer.getRenderTarget()
    const clear = this.renderer.getClearColor(new Color())
    const alpha = this.renderer.getClearAlpha()
    const out: Float32Array[] = []
    const aspect = this.camera.aspect
    this.camera.aspect = 1
    this.camera.updateProjectionMatrix()
    try {
      for (const mode of ['uv', 'normal'] as DetailDebug[]) {
        d.setDebug(mode)
        this.renderer.setRenderTarget(target)
        this.renderer.setClearColor(0x000000, 0)
        this.renderer.render(scene, this.camera)
        out.push(new Float32Array((await this.renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size)) as Float32Array))
      }
    } finally {
      d.setDebug('off')
      this.renderer.setRenderTarget(previous)
      this.renderer.setClearColor(clear, alpha)
      this.camera.aspect = aspect
      this.camera.updateProjectionMatrix()
      this.root.add(mesh)
      mesh.visible = wasVisible
      target.dispose()
      this.dirty = true
    }
    return { size, uv: out[0]!, normal: out[1]! }
  }

  // ------------------------------------------------------------ 刺激 / stimulus

  /**
   * 指针下的皮肤点，换回静止空间：命中三角形的三个顶点按重心坐标在"静止姿势、默认体型"的皮肤上插值。
   * 摆了姿势、改了体型或做着表情时都成立（命中在变形后的几何上求，位置在静止网格上取）。
   * 皮肤半透明时也能点中（刺激工具只认皮肤）。没有点中皮肤时为 null。
   * The skin point under the pointer, mapped back to rest space: the hit triangle's three vertices
   * interpolated by the barycentric coordinates on the skin in the rest pose and default shape. Holds while
   * posed, reshaped or mid-expression (the hit is found on the deformed geometry, the position taken on the
   * rest mesh). Works on a see-through skin too (the stimulus tool only looks at the skin). Null off the skin.
   */
  skinHit(clientX: number, clientY: number): (ResolvedSite & { triangle: [number, number, number]; barycentric: [number, number, number] }) | null {
    if (this.syncNeeded) this.sync()
    const i = this.mainSkinIndex()
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (i < 0 || !this.batches || rect.width === 0 || this.display[i] !== NORMAL) return null
    this.camera.updateMatrixWorld()
    this.lastFace = -1
    const h = this.cast(clientX, clientY, rect, [i], true)
    if (!h || this.lastFace < 0) return null
    const buf = this.batches.partBuffers(this.inst[i]!)
    const f = this.lastFace * 3
    const tri: [number, number, number] = [buf.index[f]! - buf.indexBase, buf.index[f + 1]! - buf.indexBase, buf.index[f + 2]! - buf.indexBase]
    // 命中点在求交所用的那份几何（摆姿势后的，或当前静止的）上的重心坐标
    // barycentric coordinates of the hit on the geometry the ray was cast against (posed, or the current rest)
    const cur = (this.posed && this.poseRt ? this.poseRt.positions(i) : null) ?? buf.position
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction
    const hx = o.x + d.x * h.distance - this.offsets[i * 3]!, hy = o.y + d.y * h.distance - this.offsets[i * 3 + 1]!, hz = o.z + d.z * h.distance - this.offsets[i * 3 + 2]!
    const [a, b, c] = tri
    const e1 = [cur[b * 3]! - cur[a * 3]!, cur[b * 3 + 1]! - cur[a * 3 + 1]!, cur[b * 3 + 2]! - cur[a * 3 + 2]!]
    const e2 = [cur[c * 3]! - cur[a * 3]!, cur[c * 3 + 1]! - cur[a * 3 + 1]!, cur[c * 3 + 2]! - cur[a * 3 + 2]!]
    const hp = [hx - cur[a * 3]!, hy - cur[a * 3 + 1]!, hz - cur[a * 3 + 2]!]
    const d11 = e1[0]! * e1[0]! + e1[1]! * e1[1]! + e1[2]! * e1[2]!, d12 = e1[0]! * e2[0]! + e1[1]! * e2[1]! + e1[2]! * e2[2]!, d22 = e2[0]! * e2[0]! + e2[1]! * e2[1]! + e2[2]! * e2[2]!
    const p1 = hp[0]! * e1[0]! + hp[1]! * e1[1]! + hp[2]! * e1[2]!, p2 = hp[0]! * e2[0]! + hp[1]! * e2[1]! + hp[2]! * e2[2]!
    const det = d11 * d22 - d12 * d12
    let v = det > 0 ? (d22 * p1 - d12 * p2) / det : 0, w = det > 0 ? (d11 * p2 - d12 * p1) / det : 0
    v = Math.min(1, Math.max(0, v))
    w = Math.min(1 - v, Math.max(0, w))
    const bary: [number, number, number] = [1 - v - w, v, w]
    const rest = this.skinGeometry.get(i)!.position
    const position: [number, number, number] = [0, 0, 0]
    for (let k = 0; k < 3; k++) for (let x = 0; x < 3; x++) position[x] = position[x]! + bary[k]! * rest[tri[k]! * 3 + x]!
    const vertex = tri[bary[0] >= bary[1] && bary[0] >= bary[2] ? 0 : bary[1] >= bary[2] ? 1 : 2]!
    return { vertex, position, triangle: tri, barycentric: bary }
  }

  private clearStim(): void {
    if (this.stimParts.size) {
      this.stimParts = new Set()
      this.stimDirty = true
      this.syncNeeded = true
    }
    this.stimEval = null
    this.painOverlay?.setWeights(null)
    this.pathVisuals?.clear()
    this.pathRest = null
    this.pathBinding = null
    if (this.reflexKey !== '{}') {
      this.reflexKey = '{}'
      this.reflexPose = {}
      this.poseDirty = true
    }
    if (this.stimSee) {
      this.stimSee = false
      this.restyleSkin()
    }
    this.dirty = true
  }

  /** 皮肤本体的显示状态变了（透视开关）：只重画它 / The skin proper's look changed (the see-through switch): restyle just that part. */
  private restyleSkin(): void {
    const i = this.mainSkinIndex()
    if (i >= 0) this.applyPart(i, this.graph.parts[i]!, this.source())
    this.updateDetail()
    this.dirty = true
  }

  private beginStim(a: ActiveStim): void {
    this.stimEval = a.e
    const trace = a.e.trace
    this.stimParts = new Set([...trace.highlightParts, ...trace.path.parts].filter((id) => this.graph.part(id)))
    this.stimDirty = true
    this.syncNeeded = true
    const i = this.mainSkinIndex()
    if (!this.painOverlay && i >= 0) {
      this.painOverlay = new PainOverlay(this.skinGeometry.get(i)!, this.skinning)
      this.addFollower(this.painOverlay)
    }
    this.painOverlay?.setWeights(i >= 0 && a.weights.length * 3 === this.skinGeometry.get(i)!.position.length ? a.weights : null)
    if (!this.pathVisuals) {
      this.pathVisuals = new PathVisuals()
      this.scene.add(this.pathVisuals.group)
    }
    this.pathRest = resamplePolyline(trace.path.polyline, 320)
    this.bindStimPath(a)
    if (a.frame && a.e !== this.framedStim && this.pathRest.length >= 3) {
      // 预设部位或链接：把通路和头部（看表情）一起放进画面，视线方向不变
      // a preset site or a link: bring the pathway and the head (for the expression) into view, keeping the view direction
      const box = new Box3()
      for (let k = 0; k < this.pathRest.length; k += 3) box.expandByPoint(this.tmpV.set(this.pathRest[k]!, this.pathRest[k + 1]!, this.pathRest[k + 2]!))
      const b = this.frameBounds ?? this.graph.bodyBounds
      box.expandByPoint(this.tmpV.set((b[0] + b[3]) / 2, b[4] - 0.08, (b[2] + b[5]) / 2))
      box.expandByScalar(0.06)
      this.frame(box, this.camera.position.clone().sub(this.controls.target).normalize(), true)
    }
    this.framedStim = a.e
  }

  /** 通路上已经有几何的部件（神经系统可能还在加载）/ Parts of the pathway that have geometry by now (the nervous system may still be loading). */
  private stimCandidates(): number[] {
    const out: number[] = []
    for (const id of this.stimParts) {
      const i = this.graph.indexOf(id)
      if (i >= 0 && this.inst[i]! >= 0) out.push(i)
    }
    const skin = this.mainSkinIndex()
    if (skin >= 0) out.push(skin)
    return out
  }

  private bindStimPath(a: ActiveStim): void {
    const batches = this.batches
    if (!this.pathRest || !batches) return
    this.pathCandidates = this.stimCandidates()
    const skin = this.mainSkinIndex()
    // 绑定在静止空间里做：神经用缓冲里的静止位置，皮肤用默认体型的那一份
    // binding happens in rest space: nerves from the buffers' rest positions, the skin from its default-shape copy
    const rest = this.pathCandidates.map((i) => (i === skin ? this.skinGeometry.get(i)!.position : batches.partBuffers(this.inst[i]!).position))
    this.pathBinding = bindPath(this.pathRest, rest)
    const c = this.pathCandidates.indexOf(skin)
    if (c >= 0 && this.pathBinding.part.length) {
      // 第一个点就是刺激点：钉在皮肤上 / the first point is the stimulus site: pinned to the skin
      const v = a.site.vertex
      this.pathBinding.part[0] = c
      this.pathBinding.vertex[0] = v
      for (let k = 0; k < 3; k++) this.pathBinding.offset[k] = this.pathRest[k]! - rest[c]![v * 3 + k]!
    }
    this.pathVersion = -1
  }

  /**
   * 每帧：把刺激模型此刻的取样变成画面——疼痛分布层的亮度、通路和两个标记、退缩反射的姿势增量、
   * 冲动上传期间让皮肤透视。返回是否还在变化。
   * Every frame: turns the stimulus model's current sample into the picture — the brightness of the pain map
   * layer, the pathway and its two markers, the pose increments of the withdrawal reflex, and the skin
   * stepping aside while the volley travels. Returns whether it is still changing.
   */
  private stepStim(f: StimFrame | null): boolean {
    if (!f) {
      if (this.stimEval) this.clearStim()
      return false
    }
    const a = f.stim
    if (a.e !== this.stimEval) this.beginStim(a)
    else if (this.pathRest && this.stimCandidates().length !== this.pathCandidates.length) {
      // 神经的几何刚到：重新绑定，并补上疼痛分布层 / nerve geometry just arrived: rebind, and create the pain layer if it was missing
      this.beginStim(a)
    }
    if (this.painOverlay) {
      this.painOverlay.setIntensity(f.sample.intensity)
      // 皮肤被隐藏时这一层也不画 / the layer is not drawn while the skin is hidden
      const i = this.mainSkinIndex()
      const show = i >= 0 && this.display[i] === NORMAL && a.weights.length * 3 === this.skinGeometry.get(i)!.position.length
      if (this.painOverlay.patch.mesh.visible !== show) {
        this.painOverlay.patch.mesh.visible = show
        this.dirty = true
      }
    }
    const lat = a.e.trace.latency
    const see = f.running && a.e.peak.intensity > 0 && f.t < Math.max(lat.c, lat.secondPain) + 1
    if (see !== this.stimSee) {
      this.stimSee = see
      this.restyleSkin()
    }
    const key = JSON.stringify(f.sample.reflexPose)
    if (key !== this.reflexKey) {
      this.reflexKey = key
      this.reflexPose = f.sample.reflexPose
      this.poseDirty = true
    }
    this.stimMarkers = this.markerFractions(a, f.t)
    if (f.running) this.dirty = true
    return f.running
  }

  private stimMarkers: { fast: number | null; slow: number | null } = { fast: null, slow: null }

  /** 两个标记沿通路的位置：Aδ 在 latency.adelta 到达，C 在 latency.c 到达；重复刺激时每次重新出发 */
  /** Where the two markers are along the pathway: Aδ arrives at latency.adelta, C at latency.c; with repeats each application starts them again. */
  private markerFractions(a: ActiveStim, t: number): { fast: number | null; slow: number | null } {
    if (a.e.peak.intensity <= 0 || t < 0) return { fast: null, slow: null }
    const lat = a.e.trace.latency
    const rep = a.e.stimulus.repeat
    let tk = t
    if (rep && rep.count > 1 && rep.hz > 0) tk = t - Math.min(rep.count - 1, Math.floor(t * rep.hz)) / rep.hz
    const at = (latency: number): number | null => (tk <= latency + 0.6 ? Math.min(1, tk / Math.max(1e-3, latency)) : null)
    return { fast: at(lat.adelta), slow: at(lat.c) }
  }

  /** 姿势算完之后：把通路折线和标记放到此刻的位置 / After the pose is settled: put the pathway line and markers where they are now. */
  private placeStimPath(): void {
    const pv = this.pathVisuals
    if (!pv || !this.pathRest || !this.pathBinding || !this.stimEval || !this.batches) return
    const batches = this.batches
    const skin = this.mainSkinIndex()
    const version = this.posed && this.poseRt ? this.poseRt.version : -2 - this.restVersion
    if (version !== this.pathVersion || this.pathBuf.length !== this.pathRest.length) {
      this.pathVersion = version
      if (this.pathBuf.length !== this.pathRest.length) this.pathBuf = new Float32Array(this.pathRest.length)
      const posed = this.posed ? this.poseRt : null
      boundPositions(
        this.pathRest,
        this.pathBinding,
        (c) => {
          const i = this.pathCandidates[c]!
          if (posed) return posed.positions(i)
          // 静止时只有皮肤可能被体型 / 表情改写 / at rest only the skin can have been rewritten by shape or expression
          return i === skin ? batches.partBuffers(this.inst[i]!).position : null
        },
        this.pathBuf,
      )
      pv.setLine(this.pathBuf)
    }
    pv.setMarkers(this.stimMarkers.fast, this.stimMarkers.slow, this.camera)
  }

  /** 刺激可视化的状态（验证用）/ State of the stimulus visuals (verification). */
  stimState(): { parts: number; overlay: boolean; see: boolean; pathPoints: number; candidates: number; markers: { fast: number | null; slow: number | null }; reflexJoints: string[]; line: number[] } {
    const p = this.pathVisuals?.points ?? new Float32Array(0)
    return {
      parts: this.stimParts.size,
      overlay: !!this.painOverlay?.patch.mesh.visible,
      see: this.stimSee,
      pathPoints: this.pathRest ? this.pathRest.length / 3 : 0,
      candidates: this.pathCandidates.length,
      markers: this.stimMarkers,
      reflexJoints: Object.keys(this.reflexPose),
      line: p.length >= 6 ? [p[0]!, p[1]!, p[2]!, p[p.length - 3]!, p[p.length - 2]!, p[p.length - 1]!] : [],
    }
  }

  /** 细节层的状态（验证用）/ State of the detail layer (verification). */
  detailState(): { loaded: boolean; visible: boolean; weights: number[]; triangles: number; vertices: number } {
    const d = this.detailLayer
    return { loaded: !!d, visible: !!d?.patch.mesh.visible, weights: [...this.detailWeights], triangles: d?.patch.triangleCount ?? 0, vertices: d?.patch.vertices.length ?? 0 }
  }

  private applyRigToSkinLayer(): void {
    const rig = this.appliedRig
    const part = this.skinLayerPart
    const geo = part >= 0 ? this.skinGeometry.get(part) : undefined
    if (!rig || !this.skinLayer || !geo) return
    const n = geo.position.length / 3
    const index = new Uint16Array(n * 4)
    const weight = new Uint8Array(n * 4)
    writeInfluences(rig, this.graph.parts[part]!.id, n, index, weight, 0)
    this.skinLayer.setInfluences(index, weight)
  }

  /**
   * 身高或比例变了：让相机跟着身体走——视线方向不变，注视点和距离按身体包围盒的新旧比例换算，
   * 这样身体在画面里的位置和大小保持不变（长高不会顶出画面）。
   * Stature or proportions changed: the camera follows the body. The view direction stays; target
   * and distance are remapped by the old and new body bounds, so the body keeps its place and
   * size on screen (growing taller does not push the head out of view).
   */
  private followShape(rt: PoseRuntime): void {
    this.framedScales = this.poseScales
    const before = this.frameBounds ?? this.graph.bodyBounds
    const b = this.graph.bodyBounds
    const after: [number, number, number, number, number, number] = [b[0], b[1], b[2], b[3], b[4], b[5]]
    if (!scalesAreIdentity(this.poseScales)) {
      // 用关节中心的点云估计：静止姿势下各轴的范围从旧到新的线性变换，套到身体包围盒上
      // estimated from the cloud of joint centres: the per-axis linear map of its extent at rest, old to new, applied to the body bounds
      const joints = rt.rig.rig.joints
      const xfs = jointFrames(joints, {}, this.poseScales ?? undefined).xfs
      const lo0 = [Infinity, Infinity, Infinity], hi0 = [-Infinity, -Infinity, -Infinity], lo1 = [Infinity, Infinity, Infinity], hi1 = [-Infinity, -Infinity, -Infinity]
      joints.forEach((j, k) => {
        const m = xfs[k]
        if (!m) return
        const c = j.center
        const q = [m.r[0] * c[0] + m.r[1] * c[1] + m.r[2] * c[2] + m.t[0], m.r[3] * c[0] + m.r[4] * c[1] + m.r[5] * c[2] + m.t[1], m.r[6] * c[0] + m.r[7] * c[1] + m.r[8] * c[2] + m.t[2]]
        for (let a = 0; a < 3; a++) {
          lo0[a] = Math.min(lo0[a]!, c[a]!)
          hi0[a] = Math.max(hi0[a]!, c[a]!)
          lo1[a] = Math.min(lo1[a]!, q[a]!)
          hi1[a] = Math.max(hi1[a]!, q[a]!)
        }
      })
      for (let a = 0; a < 3; a++) {
        const span = hi0[a]! - lo0[a]!
        if (!(span > 1e-6)) continue
        const k = (hi1[a]! - lo1[a]!) / span
        after[a] = lo1[a]! + (b[a]! - lo0[a]!) * k
        after[a + 3] = lo1[a]! + (b[a + 3]! - lo0[a]!) * k
      }
    }
    this.frameBounds = after
    if (this.framePending) {
      // 相机来自链接，本来就是对着这个体型存的：只记下包围盒，不动相机
      // the camera came from a link and was saved for this very shape: record the bounds, leave the camera
      this.framePending = false
      return
    }
    const h0 = before[4] - before[1], h1 = after[4] - after[1]
    if (!(h0 > 1e-6) || !(h1 > 1e-6)) return
    const k = h1 / h0
    const t = this.controls.target
    const view = this.camera.position.clone().sub(t).multiplyScalar(k)
    t.set(
      (after[0] + after[3]) / 2 + (t.x - (before[0] + before[3]) / 2) * k,
      (after[1] + after[4]) / 2 + (t.y - (before[1] + before[4]) / 2) * k,
      (after[2] + after[5]) / 2 + (t.z - (before[2] + before[5]) / 2) * k,
    )
    this.camera.position.copy(t).add(view)
    this.tween = null
    this.controls.update()
    this.dirty = true
  }

  /** 应用一个要显示的姿势：更新关节 / 肌肉纹理，并在静止与摆姿势之间切换着色器分支。 */
  /** Apply a pose for display: update the joint / muscle textures and switch shader branch between rest and posed. */
  private setDisplayPose(pose: Pose): void {
    this.displayPose = pose
    const rt = this.poseRt
    const active = !!rt && (!poseIsRest(pose) || !scalesAreIdentity(this.poseScales))
    if (rt && active) {
      const d = rt.set(pose, this.poseScales)
      this.skinning.update(d.joints, d.muscles)
      this.prewarmNext = 0
    }
    // 对照窗格的相机由主视图带着走，自己不再跟一次 / the compare pane's camera is driven by the main view and does not follow a second time
    if (rt && this.poseScales !== this.framedScales && this.source === useApp.getState) this.followShape(rt)
    const mode: SkinningMode = !active ? 'off' : scalesAreIdentity(this.poseScales) ? 'pose' : 'pose+shape'
    if (mode !== this.skinMode) {
      this.skinMode = mode
      this.batches?.setSkinning(mode)
      this.skinLayer?.setSkinning(mode)
      for (const f of this.followers) f.setSkinning(mode)
    }
    if (this.posed !== active) {
      this.posed = active
      this.syncNeeded = true // 爆炸位移与可拾取几何随之切换 / explode offsets and pick geometry follow
    }
    this.dirty = true
  }

  /** 推进姿势过渡与呼吸动画；返回这一帧是否改了姿势 / Advance the pose transition and breathing; true when the pose changed this frame. */
  private stepPose(t: number): boolean {
    if (!this.poseRt) {
      if (this.poseDirty) {
        this.poseDirty = false
        this.setDisplayPose({})
      }
      return false
    }
    let pose = this.poseTarget
    let changed = this.poseDirty
    this.poseDirty = false
    if (this.poseTween) {
      const k = Math.min(1, (performance.now() - this.poseTween.t0) / this.poseTween.ms)
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
      pose = lerpPose(this.poseTween.from, this.poseTween.to, e)
      if (k >= 1) {
        pose = this.poseTween.to
        this.poseTween = null
      }
      changed = true
    }
    if (this.breathing) {
      // 4 秒一个周期，在呼气末与深吸气之间往返 / a 4 s cycle between end-expiration and deep inspiration
      const phase = 0.5 - 0.5 * Math.cos(((t - this.breathT0) / 4000) * Math.PI * 2)
      pose = mergePoses(pose, breathingPose(this.poseRt.rig.rig.joints, phase))
      changed = true
    }
    const jaw = this.jawPose()
    if (jaw) pose = mergePoses(pose, jaw)
    // 退缩反射：模型给的是静止姿势上的增量，逐自由度加到当前姿势上，再按活动范围截断
    // the withdrawal reflex: the model gives increments on the rest pose; added per dof to the current pose, then clamped to the ranges
    if (this.reflexKey !== '{}') pose = clampPose(this.poseRt.rig.rig.joints, mergePoses(pose, this.reflexPose))
    if (this.faceJaw !== this.jawApplied) {
      this.jawApplied = this.faceJaw
      changed = true
    }
    if (changed) this.setDisplayPose(pose)
    return changed
  }

  /** 表情给出的下颌张开角，写成姿势的形式（没有绑定或没有张口时为 null）。 */
  /** The jaw opening the expression asks for, as a pose (null without a rig or when the mouth is shut). */
  private jawPose(): Pose | null {
    const face = this.appliedFace
    const rt = this.poseRt
    if (!face || !rt || this.faceJaw <= 0) return null
    const { joint, dof } = face.data.jaw
    const j = rt.rig.rig.joints[rt.rig.jointIndex.get(joint) ?? -1]
    const d = j?.dofs[dof]
    if (!j || !d) return null
    const base = this.poseTarget[joint]?.[dof] ?? 0
    // 加在已有角度上，但不超过该自由度的活动范围 / added to the angle already there, within the dof's range
    const add = Math.min(d.max, Math.max(d.min, base + this.faceJaw)) - base
    return { [joint]: j.dofs.map((_, k) => (k === dof ? add : 0)) }
  }

  /** 数据与网格不符：主视图记到 store 里；对照窗格交给它的回调 / Data that does not match the meshes: the main view records it in the store; the compare pane hands it to its callback. */
  private reject(kind: 'rig' | 'shape' | 'face', message: string): void {
    if (this.source !== useApp.getState) return this.onReject?.(kind, message)
    const app = useApp.getState()
    if (kind === 'rig') app.rejectRig(message)
    else if (kind === 'shape') app.rejectShape(message)
    else app.rejectFace(message)
  }

  /** 第一次改写某个部件之前，留下它原始的位置与法线 / Keep a part's original positions and normals before first rewriting it. */
  private origOf(i: number, buf: PartBuffers): { position: Float32Array; normal: Float32Array } {
    let o = this.restOrig.get(i)
    if (!o) this.restOrig.set(i, (o = { position: new Float32Array(buf.position), normal: new Float32Array(buf.normal) }))
    return o
  }

  /**
   * 体型：控制量变化时，算出皮肤和"跟随皮肤"的部件在静止空间里的位移（参考实现 Shaper），缓存下来。
   * 关节的节段缩放另由蒙皮路径施加（store 的 jointScales）。返回是否有变化。
   * Body shape: when the controls change, compute the rest-space displacement of the skin and of
   * the parts that follow it (the reference Shaper) and cache it. The joints' segment scales are
   * applied separately by the skinning path (the store's jointScales). Returns whether anything changed.
   */
  private stepShape(s: ViewState): boolean {
    if (s.shape === this.appliedShape && s.shapeControls === this.appliedControls && !this.shapeForce) return false
    this.appliedShape = s.shape
    this.appliedControls = s.shapeControls
    this.shapeForce = false
    const batches = this.batches
    if (!batches) return false
    const active = !!s.shape && !shapeIsDefault(s.shape.data, s.shapeControls)
    for (const i of this.shaped.keys()) this.restDirty.add(i)
    this.shaped.clear()
    // 只有 BMI 会移动静止空间里的顶点；身高和比例只走关节缩放，此时不必改写几何（也就保留原有法线）
    // only BMI moves rest-space vertices; stature and proportions go through the joint scales alone, so the geometry (and its authored normals) is left as it is
    const staleShape = s.shape ? staleInputs(s.shape.inputs, this.glbHashes) : []
    if (staleShape.length) {
      console.warn('[soma] shape data rejected: built from other geometry', staleShape)
      this.reject('shape', `体型数据是为旧版人体数据生成的，需要重新生成 / the shape data was built from an older version of the body and must be rebuilt（${staleShape.join('、')}）`)
      return true
    }
    const shaper = active && s.shape ? new Shaper(s.shape.data, s.shape.bin, s.shapeControls) : null
    if (shaper && s.shape && shaper.skin.some((x) => x !== 0)) {
      const targets = [{ part: s.shape.data.skin.part, vertexCount: s.shape.data.skin.vertexCount }, ...s.shape.data.followers]
      for (const t of targets) {
        const i = this.graph.indexOf(t.part)
        const id = i >= 0 ? this.inst[i]! : -1
        if (id < 0) continue
        const buf = batches.partBuffers(id)
        if (buf.position.length !== t.vertexCount * 3) {
          // 顶点数对不上：体型数据是为另一版几何生成的 / vertex counts differ: the shape data was built for other geometry
          console.warn(`[soma] shape data rejected: ${t.part} has ${buf.position.length / 3} vertices, shape.json says ${t.vertexCount}`)
          this.shaped.clear()
          this.reject('shape', `体型数据与部件 ${t.part} 的网格不符，需要重新生成 / the shape data does not match the mesh of ${t.part} and must be rebuilt`)
          return true
        }
        this.shaped.set(i, shaper.shapedRest(t.part, this.origOf(i, buf).position))
        this.restDirty.add(i)
      }
    }
    return true
  }

  /**
   * 静止空间的位移：体型（已缓存）之上叠加面部表情，写回顶点缓冲并只上传改动的那几段；
   * 之后才是蒙皮。被改写的部件重算法线和包围盒，建在旧几何上的拾取结构作废。返回表情是否还在变化。
   * Rest-space displacement: the facial expression on top of the (cached) shape, written back to
   * the vertex buffers with only the changed ranges uploaded; skinning comes after. Rewritten
   * parts get new normals and bounds, and pick structures built on the old geometry are dropped.
   * Returns whether the expression is still changing.
   */
  private stepFace(t: number): boolean {
    const s = this.source()
    const batches = this.batches
    if (s.face !== this.appliedFace) {
      // 换了（或没有了）表情数据：受它影响的部件都要重写 / the face data changed (or went away): everything it touched is rewritten
      for (const i of this.faceDisplaced) this.restDirty.add(i)
      this.faceDisplaced.clear()
      this.appliedFace = s.face
      this.faceAUs = {}
      this.faceJaw = 0
      this.faceForce = true
    }
    if (this.stepShape(s)) this.faceForce = true
    const face = this.appliedFace
    if (!batches) return false
    const frame = face ? painFrame(t) : { aus: {}, animating: false, airflow: 0 }
    // "差不多相同"不能挡住最后一步：表情已经完全放松而上次应用的还剩一点点时，必须真的归零，
    // 否则顶点留着亚微米的位移、姿势模式也回不到静止
    // "near enough" must not swallow the last step: when the expression has fully relaxed but a trace is
    // still applied, it has to go to exactly zero, or sub-micron displacements linger and the posed mode never ends
    const settled = Object.keys(frame.aus).length > 0 || Object.keys(this.faceAUs).length === 0
    if (!this.faceForce && this.restDirty.size === 0 && settled && sameAUs(frame.aus, this.faceAUs)) return frame.animating
    this.faceForce = false
    this.faceAUs = frame.aus
    const act = face ? activations(face.data, frame.aus) : { channels: {}, jaw: 0 }
    const todo = new Set(this.restDirty)
    this.restDirty.clear()
    const part0 = this.followers.length ? this.mainSkinIndex() : -1
    const activeParts = new Set<number>()
    if (face) {
      for (const [partId, fields] of face.fields) {
        const i = this.graph.indexOf(partId)
        if (i < 0 || this.inst[i]! < 0) continue
        const active = fields.some((f) => (act.channels[f.channel] ?? 0) > 0)
        if (active) activeParts.add(i)
        if (active || this.faceDisplaced.has(i)) todo.add(i)
      }
    }
    for (const i of todo) {
      const id = this.inst[i]!
      if (id < 0) continue
      const partId = this.graph.parts[i]!.id
      const buf = batches.partBuffers(id)
      if (face && activeParts.has(i) && buf.position.length !== face.vertexCount.get(partId)! * 3) {
        // 顶点数对不上：表情数据是为另一版几何生成的 / vertex counts differ: the face data was built for other geometry
        console.warn(`[soma] face data rejected: ${partId} has ${buf.position.length / 3} vertices, face.json says ${face.vertexCount.get(partId)}`)
        this.reject('face', `表情数据与部件 ${partId} 的网格不符，需要重新生成 / the face data does not match the mesh of ${partId} and must be rebuilt`)
        return false
      }
      const orig = this.origOf(i, buf)
      const base = this.shaped.get(i) ?? orig.position
      const facing = !!face && activeParts.has(i)
      if (facing) displacePart(face!, partId, base, act.channels, buf.position)
      else buf.position.set(base)
      if (facing) this.faceDisplaced.add(i)
      else this.faceDisplaced.delete(i)
      const displaced = facing || this.shaped.has(i)
      if (displaced) {
        // 位移改变了曲面的朝向：重算法线，明暗才对 / the displacement turns the surface: recompute normals so shading is right
        recomputeNormals(buf.position, buf.index, buf.indexBase, buf.normal)
        this.boxOverride.set(i, boundsOf(buf.position))
      } else {
        buf.normal.set(orig.normal)
        this.boxOverride.delete(i)
      }
      batches.markPositions(id)
      // 建在旧几何上的 BVH 作废，下次拾取时按新几何重建 / the BVH on the old geometry is dropped and rebuilt on the next pick
      if (this.bvh[i]) {
        this.bvh[i] = null
        this.bvhBuilt = Math.max(0, this.bvhBuilt - 1)
      }
      if (i === this.skinLayerPart && this.skinLayer && this.skinIndex >= 0) this.skinLayer.setPositions(buf.position)
      if (this.followers.length && part0 === i) for (const f of this.followers) f.patch.setPositions(buf.position, buf.normal)
    }
    this.faceJaw = act.jaw
    this.updateDetail()
    if (todo.size) {
      // 静止几何变了：按旧几何算出的拾取缓存作废 / the rest geometry changed: pick caches computed from the old one are stale
      this.poseRt?.invalidate()
      this.restVersion++
      this.prewarmNext = 0
      this.dirty = true
    }
    return frame.animating || todo.size > 0
  }

  /** 当前体型位移涉及的部件数（验证用）/ Number of parts the current shape displacement touches (verification). */
  shapeState(): { parts: number; rewritten: number } {
    return { parts: this.shaped.size, rewritten: this.restOrig.size }
  }

  /** 当前应用的 AU 强度与下颌角（验证用）/ The AU intensities and jaw angle currently applied (verification). */
  faceState(): { aus: AUs; jaw: number; parts: number; loaded: boolean } {
    return { aus: this.faceAUs, jaw: this.faceJaw, parts: this.faceDisplaced.size, loaded: !!this.appliedFace }
  }

  private updateGizmo(): void {
    const rt = this.poseRt
    const id = this.gizmoJoint
    if (!rt || !id) return
    const joint = rt.rig.rig.joints[rt.rig.jointIndex.get(id) ?? -1]
    if (!joint) return this.gizmo.clear()
    const frames = this.posed ? rt.frames : jointFrames(rt.rig.rig.joints, this.displayPose)
    const dofs: { axis: [number, number, number] }[] = []
    let center: [number, number, number] | null = null
    joint.dofs.forEach((_, k) => {
      const a = dofAxisWorld(rt.rig, frames, this.displayPose, id, k)
      if (a) {
        dofs.push({ axis: a.axis })
        center = a.center
      }
    })
    if (!center) return this.gizmo.clear()
    this.gizmo.update(center, dofs, this.camera, Math.max(1, this.container.clientHeight))
  }

  /**
   * 空闲帧里预先算好可见部件的变形顶点，这样姿势停下后不久，拾取用的包围盒就都是精确的。
   * In idle frames, pre-compute the posed vertices of visible parts so that shortly after a
   * pose settles every pick uses exact bounds.
   */
  private prewarmPosed(budgetMs: number): void {
    const rt = this.poseRt
    if (!rt || this.prewarmVersion === rt.version) return
    const t0 = performance.now()
    const n = this.graph.parts.length
    while (this.prewarmNext < n && performance.now() - t0 < budgetMs) {
      const i = this.prewarmNext++
      if (this.inst[i]! >= 0 && this.pickable[i] && !rt.has(i)) rt.positions(i)
    }
    if (this.prewarmNext >= n) {
      this.prewarmVersion = rt.version
      this.prewarmNext = 0
    }
  }

  /** GPU 着色器算出的顶点位置（验证用）/ Vertex positions as computed by the GPU shader (verification). */
  async probePositions(partId: string, vertexIds: readonly number[]): Promise<Float32Array | null> {
    if (this.syncNeeded) this.sync()
    const i = this.graph.indexOf(partId)
    if (i < 0 || this.inst[i]! < 0 || !this.batches) return null
    return probeSkinnedPositions(this.renderer, this.skinning, this.skinMode, this.batches.partBuffers(this.inst[i]!), vertexIds)
  }

  /** CPU 参考实现在当前姿势下的顶点位置；静止时为 null（验证用）。 */
  /** The CPU reference's vertex positions in the current pose; null at rest (verification). */
  referencePositions(partId: string): Float32Array | null {
    const i = this.graph.indexOf(partId)
    return i >= 0 && this.posed && this.poseRt ? this.poseRt.positions(i) : null
  }

  /** 当前蒙皮方式与显示的姿势（验证用）/ Current skinning mode and displayed pose (verification). */
  poseState(): { mode: SkinningMode; posed: boolean; pose: Pose; rig: boolean } {
    return { mode: this.skinMode, posed: this.posed, pose: this.displayPose, rig: !!this.poseRt }
  }

  /** 体型挂钩：逐关节的节段缩放（null 为不缩放）。正式的体型控件以后接到这里。 */
  /** Body-shape hook: per-joint segment scales (null = none). The real shape controls will plug in here. */
  setJointScales(scales: Scales | null): void {
    useApp.setState({ jointScales: scales })
  }

  /**
   * 按状态显示或隐藏体表图图层。打开体表图时皮肤层强制可见（不受剥离、系统开关影响）。
   * Show or hide the skin map layer from state. A map that is on forces the skin layer
   * visible (peel and system toggles do not apply to it).
   */
  private updateSkinLayer(s: ViewState): void {
    const map = s.skinMapMode === 'off' ? undefined : s.skinMaps?.maps.find((m) => m.id === s.skinMapMode)
    const index = map && s.skinMaps ? this.graph.indexOf(s.skinMaps.part) : -1
    const geo = index >= 0 ? this.skinGeometry.get(index) : undefined
    if (!map || !s.skinMaps || index < 0 || !geo || this.inst[index]! < 0) {
      this.skinLayer?.update(null)
      this.skinIndex = -1
      this.skinPickable = false
      return
    }
    if (!this.skinLayer) {
      this.skinLayer = new SkinLayer(geo, this.skinning)
      this.skinLayerPart = index
      this.applyRigToSkinLayer()
      this.skinLayer.setSkinning(this.skinMode)
      this.skinLayer.setCapped(this.batches?.isCapped ?? false)
      this.root.add(this.skinLayer.mesh)
    }
    if (!this.skinLayer.fits(s.skinMaps.vertexCount)) {
      // 体表图与皮肤网格的顶点数不符：不画，以免颜色错位
      // the map does not match the skin mesh: do not draw it rather than paint it misaligned
      console.warn(`[soma] skin map has ${s.skinMaps.vertexCount} vertices but the skin mesh has ${geo.position.length / 3}`)
      this.skinLayer.update(null)
      this.skinIndex = -1
      this.skinPickable = false
      return
    }
    this.skinLayer.update({ map, selected: s.skinRegions, hover: s.skinHover, seeThrough: s.skinSeeThrough })
    this.skinLayer.setOffset(this.offsets[index * 3]!, this.offsets[index * 3 + 1]!, this.offsets[index * 3 + 2]!)
    this.skinIndex = index
    this.skinPickable = !s.skinSeeThrough
  }

  /** 体表图是否已显示在皮肤上（验证用）/ Whether a skin map is currently drawn (verification). */
  skinMapShown(): boolean {
    return this.skinIndex >= 0
  }

  /** 悬停 / 选中着色之前每个部件的颜色。 */
  /** Colour each part is drawn with before hover / selection tinting. */
  private computeBaseColors(s: ViewState): void {
    const systemColor = new Map<SystemId, string>(this.graph.data.systems.map((x) => [x.id, x.color]))
    this.graph.parts.forEach((part, i) => {
      const hex =
        s.colorMode === 'source'
          ? provenanceColor(part.provenance, this.graph.sourceOrdinal(part))
          : (TISSUE_COLOR[part.tissue] ?? systemColor.get(part.system) ?? '#9aa3ad')
      this.baseColor[i]!.set(hex)
    })
  }

  private readonly tmpColor = new Color()

  private applyPart(i: number, part: Part, s: ViewState): void {
    const id = this.inst[i]!
    const d = this.display[i]!
    const selected = s.selection.set.has(part.id)
    // 组织默认值 × 系统滑块；按来源着色时把半透明组织稍微提亮，以便看清颜色
    // tissue default × the system's slider; in colour-by-source mode see-through tissues are
    // lifted a little so their colour can be read
    let opacity = (TISSUE_OPACITY[part.tissue] ?? 1) * (s.systems[part.system]?.opacity ?? 1)
    if (s.colorMode === 'source' && TISSUE_OPACITY[part.tissue] !== undefined) opacity = Math.min(1, opacity * 1.6)
    // 看表情时把皮肤画成不透明 / the skin is drawn opaque to read the expression
    if (s.skinOpaque && part.id === this.mainSkin) opacity = 1
    // 冲动沿神经传上去的那一小段时间里，皮肤让开 / while the volley travels up the nerve, the skin steps aside
    if (this.stimSee && part.id === this.mainSkin) opacity = Math.min(opacity, 0.22)
    const inPath = this.stimParts.has(part.id)
    if (selected || inPath) opacity = 1 // a selected part is shown solid so it can be found
    this.pickable[i] = id >= 0 && d === NORMAL && opacity >= PICK_OPACITY ? 1 : 0
    this.solid[i] = d === NORMAL && opacity >= 0.999 ? 1 : 0
    const batches = this.batches
    if (id < 0 || !batches) return
    if (i === this.skinIndex) {
      // 体表图打开时，皮肤由图层绘制并可点选（半透明时让位给其下的结构）
      // with a skin map on, the layer draws the skin and it is pickable (not while see-through)
      batches.setState(id, MODE_HIDDEN, 0, 0, 0, 0)
      batches.setXray(id, false)
      this.pickable[i] = this.skinPickable ? 1 : 0
      this.solid[i] = this.skinPickable ? 1 : 0
      return
    }
    if (d === HIDDEN) {
      batches.setState(id, MODE_HIDDEN, 0, 0, 0, 0)
    } else if (d === GHOST) {
      batches.setState(id, MODE_BLEND, GHOST_RGB.r, GHOST_RGB.g, GHOST_RGB.b, GHOST_OPACITY)
    } else {
      const c = this.tmpColor.copy(this.baseColor[i]!)
      if (selected) c.lerp(ACCENT_RGB, 0.6)
      else if (inPath) c.lerp(PATH_RGB, 0.8)
      else if (s.hover === part.id) c.lerp(WHITE, 0.32)
      batches.setState(id, opacity >= 0.999 ? MODE_OPAQUE : MODE_BLEND, c.r, c.g, c.b, opacity)
    }
    // 被选中的部件还会透过遮挡物画一层淡淡的颜色
    // selected parts also get a faint tint drawn through whatever covers them
    batches.setXray(id, d !== HIDDEN && ((selected && s.selection.ids.length <= XRAY_MAX) || inPath))
  }

  // ------------------------------------------------------------ 拾取 / picking

  /**
   * 给定客户区坐标下的部件，没有则为 null。遵循可见性与剖切面。细小部件（神经、小血管）只要没有被指针下的表面挡住，就在 `tolerancePx` 像素内被拾取；传 0 为精确拾取。
   * Part under the given client coordinates, or null. Honours visibility and the section
   * plane. Thin parts (nerves, small vessels) are picked within `tolerancePx` of the
   * pointer when they are not hidden behind the surface under it; pass 0 for an exact pick.
   */
  pick(clientX: number, clientY: number, tolerancePx: number = THIN_PICK_PX[this.lastPointerType]): string | null {
    if (this.syncNeeded) this.sync()
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    this.camera.updateMatrixWorld()
    const parts = this.graph.parts
    const exact = this.cast(clientX, clientY, rect, null)
    if (tolerancePx <= 0 || this.thinParts.length === 0) return exact ? parts[exact.part]!.id : null
    if (exact && this.radius[exact.part]! < THIN_RADIUS && this.radius[exact.part]! > 0) return parts[exact.part]!.id

    // 表面经过指针容差范围内的细小部件，按屏幕距离由近到远
    // thin parts whose surface passes within the tolerance of the pointer, nearest on screen first
    const near = this.nearThin(clientX, clientY, rect, tolerancePx)
    for (let k = 0; k < near.length && k < 4; k++) {
      const c = near[k]!
      // 它必须是它经过指针处实际可见的东西，而不是被旁边结构挡住的
      // it must be what is actually visible where it passes the pointer, not something behind a neighbour
      this.tmpV.copy(c.point).project(this.camera)
      const cx = rect.left + ((this.tmpV.x + 1) / 2) * rect.width
      const cy = rect.top + ((1 - this.tmpV.y) / 2) * rect.height
      const front = this.cast(cx, cy, rect, null)
      if (!front || front.part === c.part || front.distance >= c.distance - THIN_DEPTH_SLACK) return parts[c.part]!.id
    }
    return exact ? parts[exact.part]!.id : null
  }

  private readonly tmpV = new Vector3()
  private readonly tmpBox = new Box3()
  private readonly tmpSeg = new Line3()
  private readonly tmpOnTri = new Vector3()
  private readonly tmpOnSeg = new Vector3()

  /**
   * 表面与过某像素的射线在屏幕上相距不超过 `tolerancePx` 的可拾取细小部件，按该屏幕距离排序。这里量的是射线到网格的真实距离（BVH shapecast），所以半个像素宽的神经不会从采样点之间漏掉。
   * Thin pickable parts whose surface comes within `tolerancePx` (on screen) of the ray
   * through a pixel, sorted by that on-screen distance. This measures the true distance from
   * the ray to the mesh (BVH shapecast), so a nerve half a pixel wide cannot slip between samples.
   */
  private nearThin(clientX: number, clientY: number, rect: DOMRect, tolerancePx: number): { part: number; px: number; distance: number; point: Vector3 }[] {
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.camera)
    const o = this.raycaster.ray.origin.clone()
    const d = this.raycaster.ray.direction.clone()
    let near = 0
    let far = 50
    if (this.planeEq) {
      const span = clipRay([o.x, o.y, o.z], [d.x, d.y, d.z], this.planeEq)
      if (!span) return []
      near = span[0]
      far = Math.min(far, span[1])
    }
    // 距相机一米处一个 CSS 像素对应的世界尺寸
    // world size of one CSS pixel at one metre from the camera
    const perMetre = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / rect.height
    const parts = this.graph.parts
    const out: { part: number; px: number; distance: number; point: Vector3 }[] = []
    const ray = this.localRay
    for (const i of this.thinParts) {
      if (!this.pickable[i]) continue
      const b = this.boxOf(i)
      const ox = this.offsets[i * 3]!
      const oy = this.offsets[i * 3 + 1]!
      const oz = this.offsets[i * 3 + 2]!
      // 粗筛：射线对部件包围盒，包围盒按其远端处的容差放大
      // broad phase: the ray against the part's box grown by the tolerance at the box's far side
      const cxm = (b[0] + b[3]) / 2 + ox - o.x
      const cym = (b[1] + b[4]) / 2 + oy - o.y
      const czm = (b[2] + b[5]) / 2 + oz - o.z
      const reach = Math.hypot(cxm, cym, czm) + Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2
      const pad = tolerancePx * perMetre * reach + 0.001
      this.tmpBox.min.set(b[0] + ox - pad, b[1] + oy - pad, b[2] + oz - pad)
      this.tmpBox.max.set(b[3] + ox + pad, b[4] + oy + pad, b[5] + oz + pad)
      if (!this.raycaster.ray.intersectsBox(this.tmpBox)) continue

      // 精确阶段，在部件自身坐标系中进行（世界坐标减去爆炸位移）
      // exact phase in the part's frame (world minus its explode offset)
      ray.origin.set(o.x - ox, o.y - oy, o.z - oz)
      ray.direction.copy(d)
      const t1 = Math.min(far, reach + pad)
      if (t1 <= near) continue
      this.tmpSeg.start.copy(ray.origin).addScaledVector(d, near)
      this.tmpSeg.end.copy(ray.origin).addScaledVector(d, t1)
      let bestPx = tolerancePx
      let bestDist = 0
      let found = false
      const point = new Vector3()
      this.bvhFor(i).shapecast({
        intersectsBounds: (box) => {
          const grow = bestPx * perMetre * reach
          this.tmpBox.copy(box).expandByScalar(grow)
          return ray.intersectsBox(this.tmpBox)
        },
        intersectsTriangle: (tri) => {
          const gap = tri.closestPointToSegment(this.tmpSeg, this.tmpOnTri, this.tmpOnSeg)
          const along = this.tmpOnSeg.distanceTo(ray.origin)
          const px = gap / (perMetre * Math.max(along, 1e-4))
          if (px < bestPx) {
            bestPx = px
            bestDist = this.tmpOnTri.distanceTo(ray.origin)
            point.copy(this.tmpOnTri)
            found = true
          }
          return false
        },
      })
      if (found) out.push({ part: i, px: bestPx, distance: bestDist, point: point.set(point.x + ox, point.y + oy, point.z + oz) })
    }
    return out.sort((x, y) => x.px - y.px || x.distance - y.distance)
  }

  /**
   * 指针下的部件；若命中的是带体表图的皮肤，同时给出区域索引。
   * The part under the pointer; when it is the mapped skin, also the region index.
   */
  pickDetail(clientX: number, clientY: number, tolerancePx?: number): { id: string; region: number | null } | null {
    const id = this.pick(clientX, clientY, tolerancePx)
    if (!id) return null
    if (this.skinIndex < 0 || this.graph.indexOf(id) !== this.skinIndex || !this.skinLayer) return { id, region: null }
    // 重新对皮肤做一次精确投射以取得命中的三角形 / cast again on the skin alone for the hit triangle
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.lastFace = -1
    const h = this.cast(clientX, clientY, rect, [this.skinIndex])
    return { id, region: h && this.lastFace >= 0 ? this.skinLayer.regionOfFace(this.lastFace) : null }
  }

  /** 某像素下的精确命中及其到相机的距离（调试 / 验证）。 */
  /** Exact hit under a pixel with its distance from the camera (debug / verification). */
  probe(clientX: number, clientY: number): { id: string; distance: number } | null {
    if (this.syncNeeded) this.sync()
    this.camera.updateMatrixWorld()
    const h = this.cast(clientX, clientY, this.renderer.domElement.getBoundingClientRect(), null)
    return h ? { id: this.graph.parts[h.part]!.id, distance: h.distance } : null
  }

  /** 让相机立即跳到对准目标（验证用；平时是渐变过去）。 */
  /** Jump the camera to its focus target immediately (verification; normally it tweens). */
  focusNow(ids: readonly string[] | null = null): void {
    if (this.syncNeeded) this.sync()
    this.focus(ids)
    if (this.tween) {
      this.camera.position.copy(this.tween.toPos)
      this.controls.target.copy(this.tween.toTarget)
      this.tween = null
      this.controls.update()
    }
    this.camera.updateMatrixWorld()
  }

  /** 过某像素的射线上最近的命中，范围为 `only`（部件索引）或全部可拾取部件。 */
  /** Nearest hit along the ray through a pixel, among `only` (part indices) or all pickable parts. */
  private cast(clientX: number, clientY: number, rect: DOMRect, only: readonly number[] | null, force = false): { part: number; distance: number } | null {
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.camera)
    const o = this.raycaster.ray.origin
    const d = this.raycaster.ray.direction
    let near = 0
    let far = Infinity
    if (this.planeEq) {
      const span = clipRay([o.x, o.y, o.z], [d.x, d.y, d.z], this.planeEq)
      if (!span) return null
      ;[near, far] = span
    }

    // 粗筛：射线对每个候选部件（爆炸后）的包围盒
    // broad phase: ray vs each candidate's (exploded) bounding box
    const parts = this.graph.parts
    const cand: number[] = []
    const candT: number[] = []
    const pad = 0.002
    const n = only ? only.length : parts.length
    for (let k = 0; k < n; k++) {
      const i = only ? only[k]! : k
      if (!this.pickable[i] && !force) continue
      const b = this.boxOf(i)
      let t0 = near
      let t1 = far
      let hit = true
      for (let a = 0; a < 3 && hit; a++) {
        const off = this.offsets[i * 3 + a]!
        const oa = a === 0 ? o.x : a === 1 ? o.y : o.z
        const da = a === 0 ? d.x : a === 1 ? d.y : d.z
        const lo = b[a]! + off - pad
        const hi = b[a + 3]! + off + pad
        if (Math.abs(da) < 1e-12) {
          if (oa < lo || oa > hi) hit = false
        } else {
          let ta = (lo - oa) / da
          let tb = (hi - oa) / da
          if (ta > tb) [ta, tb] = [tb, ta]
          if (ta > t0) t0 = ta
          if (tb < t1) t1 = tb
          if (t0 > t1) hit = false
        }
      }
      if (hit) {
        cand.push(i)
        candT.push(t0)
      }
    }
    const order = cand.map((_, k) => k).sort((x, y) => candT[x]! - candT[y]!)

    let best = Infinity
    let bestPart = -1
    const capped = this.batches?.isCapped ?? false
    for (const k of order) {
      if (candT[k]! > best) break
      const i = cand[k]!
      // 几何已烘焙到世界坐标，所以部件坐标系只差一个爆炸位移
      // geometry is baked in world space, so the part's frame is just the explode translation
      this.localRay.origin.set(o.x - this.offsets[i * 3]!, o.y - this.offsets[i * 3 + 1]!, o.z - this.offsets[i * 3 + 2]!)
      this.localRay.direction.copy(d)
      // 剖切时，不透明部件的背面会被绘制（填充的切面），因此可拾取
      // with a section on, an opaque part's back faces are drawn (the filled cut), so they are pickable
      const h = this.bvhFor(i).raycastFirst(this.localRay, capped && this.solid[i] ? DoubleSide : FrontSide, near, Math.min(far, best))
      if (h && h.distance < best) {
        best = h.distance
        bestPart = i
        this.lastFace = h.faceIndex ?? -1
      }
    }
    return bestPart >= 0 ? { part: bestPart, distance: best } : null
  }

  /** 部件的包围盒：摆姿势时用保守的变形后包围盒 / A part's bounds: the conservative posed box while posed. */
  private boxOf(i: number): [number, number, number, number, number, number] {
    const rest = this.boxOverride.get(i) ?? this.graph.parts[i]!.bbox
    return this.posed && this.poseRt ? this.poseRt.box(i, rest) : rest
  }

  private bvhFor(i: number): MeshBVH {
    if (this.posed && this.poseRt) {
      // 摆姿势时在变形后的几何上拾取（按需计算并缓存）
      // while posed, pick on the deformed geometry (computed on demand and cached)
      const posed = this.poseRt.bvh(i)
      if (posed) return posed
    }
    const version = this.batches!.geometryVersion
    if (version !== this.bvhVersion) {
      // 共享缓冲被重新分配了（批次扩容）：所有 BVH 都指向旧缓冲
      // the shared buffers were reallocated (the batch grew): every BVH points at the old ones
      this.bvhVersion = version
      this.bvh.fill(null)
      this.bvhBuilt = 0
      this.bvhQueue = []
      for (let k = 0; k < this.inst.length; k++) if (this.inst[k]! >= 0) this.bvhQueue.push(k)
    }
    let bvh = this.bvh[i]
    if (!bvh) {
      // indirect：索引缓冲是批次自己的（已在 GPU 上），不能重排
      // indirect: the index buffer is the batch's own (already on the GPU) and must not be reordered
      bvh = new MeshBVH(this.batches!.pickGeometry(this.inst[i]!), { indirect: true })
      this.bvh[i] = bvh
      this.bvhBuilt++
    }
    return bvh
  }

  /** 在 `budgetMs` 毫秒内构建待建的 BVH；在空闲帧调用。 */
  /** Build pending BVHs for up to `budgetMs`; called from idle frames. */
  private buildBvhs(budgetMs: number): void {
    const t0 = performance.now()
    while (this.bvhQueue.length && performance.now() - t0 < budgetMs) {
      const i = this.bvhQueue.pop()!
      if (!this.bvh[i]) this.bvhFor(i)
    }
  }

  // ------------------------------------------------------------ 相机 / camera

  private boundsOf(ids: readonly string[] | null): Box3 | null {
    const box = new Box3()
    const parts = this.graph.parts
    const add = (i: number) => {
      const b = this.boxOf(i)
      const ox = this.offsets[i * 3]!
      const oy = this.offsets[i * 3 + 1]!
      const oz = this.offsets[i * 3 + 2]!
      box.expandByPoint(new Vector3(b[0] + ox, b[1] + oy, b[2] + oz))
      box.expandByPoint(new Vector3(b[3] + ox, b[4] + oy, b[5] + oz))
    }
    if (ids) {
      for (const id of ids) {
        const i = this.graph.indexOf(id)
        if (i >= 0) add(i)
      }
    } else {
      for (let i = 0; i < parts.length; i++) if (this.display[i] === NORMAL) add(i)
      if (box.isEmpty()) for (let i = 0; i < parts.length; i++) add(i)
    }
    return box.isEmpty() ? null : box
  }

  private frame(box: Box3, dir: Vector3, animate: boolean): void {
    const sphere = box.getBoundingSphere(new Sphere())
    const r = Math.max(sphere.radius, 0.01)
    const vfov = (this.camera.fov * Math.PI) / 180
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect)
    const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 1.08
    const toTarget = sphere.center.clone()
    const toPos = toTarget.clone().addScaledVector(dir, dist)
    if (animate) {
      this.tween = {
        t0: performance.now(),
        ms: 420,
        fromPos: this.camera.position.clone(),
        toPos,
        fromTarget: this.controls.target.clone(),
        toTarget,
      }
    } else {
      this.tween = null
      this.camera.position.copy(toPos)
      this.controls.target.copy(toTarget)
      this.controls.update()
    }
    this.dirty = true
  }

  /** 对准给定部件，或所选结构，或全部可见结构。保持观察方向。 */
  /** Frame the given parts, or the selection, or everything visible. Keeps the view direction. */
  focus(ids: readonly string[] | null = null): void {
    const sel = this.source().selection.ids
    const box = this.boundsOf(ids ?? (sel.length ? sel : null))
    if (!box) return
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    this.frame(box, dir, true)
  }

  /** 正面全身视角。 */
  /** Whole body from the front. */
  home(animate: boolean): void {
    this.onCameraSettled?.(undefined)
    const b = this.frameBounds ?? this.graph.bodyBounds
    const box = new Box3(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]))
    this.frame(box, new Vector3(0, 0.08, 1).normalize(), animate)
  }

  /** 联动相机姿态所相对的点（例如所显示系统的中心）。 */
  /** Point the linked-camera pose is expressed relative to (e.g. the shown system's centre). */
  setAnchor(x: number, y: number, z: number): void {
    this.anchor.set(x, y, z)
  }

  getPose(): CameraPose {
    const t = this.controls.target
    const p = this.camera.position
    return { offset: [p.x - t.x, p.y - t.y, p.z - t.z], target: [t.x - this.anchor.x, t.y - this.anchor.y, t.z - this.anchor.z] }
  }

  /** 应用来自联动查看器的姿态，不回传。 */
  /** Apply a pose from a linked viewer without echoing it back. */
  setPose(pose: CameraPose): void {
    this.tween = null
    this.applyingPose = true
    this.controls.target.set(this.anchor.x + pose.target[0], this.anchor.y + pose.target[1], this.anchor.z + pose.target[2])
    this.camera.position.set(this.controls.target.x + pose.offset[0], this.controls.target.y + pose.offset[1], this.controls.target.z + pose.offset[2])
    this.camera.lookAt(this.controls.target)
    this.controls.update()
    this.applyingPose = false
    this.dirty = true
  }

  /** 渲染器的资源计数，用于检查泄漏。 */
  /** Counts from the renderer, for leak checks. */
  memory(): { geometries: number; attributes: number; textures: number; programs: number } {
    const m = this.renderer.info.memory as unknown as Record<string, number>
    return { geometries: m.geometries ?? 0, attributes: (m.attributes ?? 0) + (m.indexAttributes ?? 0), textures: m.textures ?? 0, programs: m.programs ?? 0 }
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.updateBoost()
    this.dirty = true
  }

  // ------------------------------------------------------------ 指针输入 / pointer input

  private onContextMenu = (e: Event): void => e.preventDefault()

  private onPointerDown = (e: PointerEvent): void => {
    // 嵌入模式：点一下画布即激活（之后滚轮缩放、触摸完全交给模型）
    // embed mode: a press on the canvas activates it (wheel zoom and full touch control from then on)
    if (this.embed) this.renderer.domElement.focus({ preventScroll: true })
    this.lastPointerType = e.pointerType === 'mouse' ? 'mouse' : 'touch'
    this.pointers.add(e.pointerId)
    this.onPointer?.(null)
    this.down =
      this.pointers.size === 1 && e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null
    this.hoverXY = null
    this.cancelHold()
    if (this.down && this.interactive && useApp.getState().stimArmed) {
      // 刺激工具：按住不动一会儿 = 按住施加，松手才结束 / stimulus tool: a press held still for a moment applies by pressing, until release
      const d = this.down
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null
        if (this.down !== d || this.pointers.size !== 1) return
        const site = this.skinHit(d.x, d.y)
        if (!site) return
        this.holdActive = true
        // 按住期间相机不转（OrbitControls 仍然记着这根手指，松手后一切照旧）
        // the camera does not turn while pressing (OrbitControls still tracks the finger; all is as before after release)
        this.controls.enableRotate = false
        this.controls.enablePan = false
        void applyStimulus(site, { gesture: true, hold: true })
      }, HOLD_MS)
    }
  }

  private cancelHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = null
  }

  private endHold(): boolean {
    this.cancelHold()
    if (!this.holdActive) return false
    this.holdActive = false
    this.controls.enableRotate = true
    this.controls.enablePan = true
    void releaseStimulus()
    return true
  }

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId)
    const d = this.down
    this.down = null
    if (this.endHold()) return
    if (!d || d.id !== e.pointerId || !this.interactive) return
    const now = performance.now()
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_MAX_MOVE || now - d.t > TAP_MAX_MS) return
    const app = useApp.getState()
    if (this.syncNeeded) this.sync()
    if (app.stimArmed) {
      // 刺激工具开着：点皮肤就是施加刺激，不改选择 / with the stimulus tool on, a click on the skin applies the stimulus and leaves the selection alone
      const site = this.skinHit(e.clientX, e.clientY)
      if (site) void applyStimulus(site, { gesture: true })
      return
    }
    const hit = this.pickDetail(e.clientX, e.clientY)
    const id = hit?.id ?? null
    const additive = e.ctrlKey || e.metaKey || e.shiftKey
    const last = this.lastTap
    const isDouble = !!last && now - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 24
    this.lastTap = isDouble ? null : { x: e.clientX, y: e.clientY, t: now }
    if (isDouble) {
      // 体表图区域上的双击不改选择 / a double tap on a skin map region leaves the selection alone
      if (id && hit?.region == null) {
        if (!app.selection.set.has(id)) app.selectParts([id])
        app.requestFocus()
      }
      return
    }
    const joint = id && app.leftTab === 'pose' && !additive ? app.rig?.bindingOf.get(id)?.joint : undefined
    if (hit && hit.region !== null) app.selectSkinRegions([hit.region], { additive })
    // "姿势"面板打开时，点骨即选中带动它的关节 / with the Pose panel open, clicking a bone selects the joint that moves it
    else if (joint) app.selectJoint(joint)
    else if (id) app.selectParts([id], { additive })
    else if (!additive) app.clearSelection()
  }

  /** 捕获阶段：按在操纵环上时接管这次拖动，不让相机控制器收到 / Capture phase: a press on a gizmo ring takes the drag away from the camera controls. */
  private onGizmoDown = (e: PointerEvent): void => {
    if (!this.interactive || e.button !== 0 || !this.gizmoJoint) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const dof = this.gizmo.hit(e.clientX, e.clientY, this.camera, rect)
    if (dof < 0) return
    e.stopImmediatePropagation()
    e.preventDefault()
    const angle = useApp.getState().pose[this.gizmoJoint]?.[dof] ?? 0
    this.gizmoDrag = { dof, last: { x: e.clientX, y: e.clientY }, angle, id: e.pointerId }
    window.addEventListener('pointermove', this.onGizmoMove)
    window.addEventListener('pointerup', this.onGizmoUp)
    window.addEventListener('pointercancel', this.onGizmoUp)
  }

  private onGizmoMove = (e: PointerEvent): void => {
    const g = this.gizmoDrag
    const joint = this.gizmoJoint
    if (!g || !joint || e.pointerId !== g.id) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const to = { x: e.clientX, y: e.clientY }
    g.angle += this.gizmo.dragDelta(g.dof, g.last, to, this.camera, rect)
    g.last = to
    // setDof 会把角度限制在活动范围内；这里也夹住累计值，免得越过极限后要拖回很远
    // setDof clamps to the range of motion; clamp the running value too so a drag past the limit does not need unwinding
    const d = this.poseRt?.rig.rig.joints[this.poseRt.rig.jointIndex.get(joint) ?? -1]?.dofs[g.dof]
    if (d) g.angle = Math.min(d.max, Math.max(d.min, g.angle))
    useApp.getState().setDof(joint, g.dof, g.angle)
  }

  private onGizmoUp = (e: PointerEvent): void => {
    if (this.gizmoDrag && e.pointerId !== this.gizmoDrag.id) return
    this.gizmoDrag = null
    window.removeEventListener('pointermove', this.onGizmoMove)
    window.removeEventListener('pointerup', this.onGizmoUp)
    window.removeEventListener('pointercancel', this.onGizmoUp)
  }

  private onPointerCancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId)
    this.down = null
    this.endHold()
  }

  private onPointerMove = (e: PointerEvent): void => {
    // 手指动了就不是"按住施加"，而是在转相机 / once the finger moves it is an orbit, not a press-to-apply
    if (this.holdTimer && this.down && e.pointerId === this.down.id && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > TAP_MAX_MOVE) this.cancelHold()
    if (e.pointerType !== 'mouse' || e.buttons !== 0 || !this.interactive) return
    this.lastPointerType = 'mouse'
    this.hoverXY = { x: e.clientX, y: e.clientY }
    this.onPointer?.({ x: e.clientX, y: e.clientY })
  }

  private onPointerLeave = (): void => {
    this.hoverXY = null
    this.onPointer?.(null)
    if (this.interactive) {
      useApp.getState().setHover(null)
      useApp.getState().setSkinHover(null)
    }
  }

  // ------------------------------------------------------------ 主循环 / loop

  private tick = (t: number): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.tick)
    this.tickCount++

    if (this.tween) {
      const k = Math.min(1, (t - this.tween.t0) / this.tween.ms)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      this.camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, e)
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e)
      if (k >= 1) {
        this.tween = null
        this.reportCamera()
      }
      this.dirty = true
    }
    this.controls.update()
    if (this.syncNeeded) this.sync()
    // 刺激先取样：它给表情一个强度、给姿势一个反射增量 / the stimulus is sampled first: it gives the face a level and the pose a reflex increment
    const stimulating = this.source === useApp.getState ? this.stepStim(stimFrame(t)) : false
    const facing = this.stepFace(t)
    const posing = this.stepPose(t) || facing || stimulating
    if (this.stimEval) this.placeStimPath()
    if (this.gizmoJoint) this.updateGizmo()

    // 姿势在动时不做悬停拾取（每帧都要重算变形后的几何）
    // no hover picking while the pose is moving (posed geometry would be recomputed every frame)
    if (posing) this.hoverXY = null
    if (this.hoverXY && !this.dirty) {
      const { x, y } = this.hoverXY
      this.hoverXY = null
      if (this.syncNeeded) this.sync()
      const hit = this.pickDetail(x, y)
      useApp.getState().setHover(hit?.id ?? null)
      useApp.getState().setSkinHover(hit?.region ?? null)
    }
    if (this.syncNeeded) this.sync()

    this.statTicks++
    if (this.dirty || this.continuous) {
      this.dirty = false
      const r0 = performance.now()
      this.renderer.info.reset()
      this.batches?.beforeRender(this.camera)
      this.renderer.render(this.scene, this.camera)
      const dt = performance.now() - r0
      this.statFrames++
      this.statRenderMs += dt
      if (this.frameLog && this.renderLog) {
        if (this.lastFrameT) this.frameLog.push(t - this.lastFrameT)
        this.renderLog.push(dt)
      }
      this.lastFrameT = t
    } else {
      this.lastFrameT = 0
      if (this.posed && this.poseRt) this.prewarmPosed(6)
      else if (this.bvhQueue.length) this.buildBvhs(5)
    }

    if (t - this.statT >= 1000) {
      const secs = (t - this.statT) / 1000
      this.stat = {
        tickFps: this.statTicks / secs,
        renderedFps: this.statFrames / secs,
        renderCpuMs: this.statFrames ? this.statRenderMs / this.statFrames : 0,
      }
      this.statT = t
      this.statTicks = this.statFrames = this.statRenderMs = 0
    }
  }

  /** 请求在下一帧重绘。 */
  /** Ask for a redraw on the next frame. */
  invalidate(): void {
    this.dirty = true
  }

  // ------------------------------------------------------------ 调试与验证 / debug / verification

  stats(): ViewerStats {
    const info = this.renderer.info.render as { drawCalls: number; triangles: number }
    return {
      backend: this.backend,
      tickFps: round(this.stat.tickFps),
      renderedFps: round(this.stat.renderedFps),
      renderCpuMs: round(this.stat.renderCpuMs),
      drawCalls: info.drawCalls,
      triangles: info.triangles,
      meshes: this.batches?.size ?? 0,
      bvhBuilt: this.bvhBuilt,
      bvhTotal: this.bvhTotal,
      paused: this.pauseReasons.size > 0,
      ticks: this.tickCount,
      systems: [...this.loadedOrder],
    }
  }

  /** 在 `seconds` 秒内每帧都渲染并让相机环绕，报告帧时间。 */
  /** Render every frame for `seconds` while orbiting the camera, and report frame times. */
  bench(seconds = 3): Promise<BenchResult> {
    return new Promise((resolve) => {
      this.frameLog = []
      this.renderLog = []
      this.lastFrameT = 0
      this.continuous = true
      const t0 = performance.now()
      const spin = () => {
        if (performance.now() - t0 < seconds * 1000 && !this.disposed) {
          const off = this.camera.position.clone().sub(this.controls.target)
          off.applyAxisAngle(new Vector3(0, 1, 0), 0.01)
          this.camera.position.copy(this.controls.target).add(off)
          requestAnimationFrame(spin)
          return
        }
        this.continuous = false
        const frames = (this.frameLog ?? []).slice().sort((a, b) => a - b)
        const renders = this.renderLog ?? []
        this.frameLog = this.renderLog = null
        const avg = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length)
        const info = this.renderer.info.render as { drawCalls: number; triangles: number }
        const size = this.renderer.getSize(new Vector2())
        let visible = 0
        for (let i = 0; i < this.display.length; i++) if (this.display[i] !== HIDDEN && this.inst[i]! >= 0) visible++
        resolve({
          backend: this.backend,
          seconds,
          frames: frames.length,
          fps: round(avg ? 1000 / avg : 0),
          frameMsAvg: round(avg),
          frameMsP95: round(frames[Math.floor(frames.length * 0.95)] ?? 0),
          frameMsMax: round(frames[frames.length - 1] ?? 0),
          renderCpuMsAvg: round(renders.reduce((a, b) => a + b, 0) / Math.max(1, renders.length)),
          drawCalls: info.drawCalls,
          triangles: info.triangles,
          visibleParts: visible,
          pixelRatio: this.renderer.getPixelRatio(),
          size: [size.x, size.y],
        })
      }
      requestAnimationFrame(spin)
    })
  }

  /**
   * 不依赖 requestAnimationFrame 的吞吐量基准（浏览器会在隐藏或被遮挡的窗口中对它限速）：一边环绕一边连续渲染 `frames` 帧，每帧等 GPU 完成。报告每帧毫秒数，不受垂直同步限制。
   * Throughput benchmark that does not depend on requestAnimationFrame (which browsers
   * throttle in hidden or occluded windows): render `frames` frames back to back while
   * orbiting, waiting for the GPU to finish each one. Reports ms per frame, un-vsynced.
   */
  async benchSync(frames = 120): Promise<{ backend: string; frames: number; msPerFrame: number; msP95: number; fpsUncapped: number; renderCpuMsAvg: number; visibleParts: number; drawCalls: number; triangles: number; size: [number, number] }> {
    if (this.syncNeeded) this.sync()
    const backend = this.renderer.backend as unknown as { device?: GPUDeviceLike; gl?: { finish(): void } }
    const gpuDone = async () => {
      if (backend.device) await backend.device.queue.onSubmittedWorkDone()
      else backend.gl?.finish()
    }
    const axis = new Vector3(0, 1, 0)
    const step = () => {
      const off = this.camera.position.clone().sub(this.controls.target).applyAxisAngle(axis, 0.02)
      this.camera.position.copy(this.controls.target).add(off)
      this.camera.lookAt(this.controls.target)
    }
    for (let i = 0; i < 5; i++) {
      step()
      this.renderer.render(this.scene, this.camera)
      await gpuDone()
    }
    const times: number[] = []
    let cpu = 0
    for (let i = 0; i < frames; i++) {
      step()
      const t0 = performance.now()
      this.renderer.info.reset()
      this.batches?.beforeRender(this.camera)
      this.renderer.render(this.scene, this.camera)
      cpu += performance.now() - t0
      await gpuDone()
      times.push(performance.now() - t0)
    }
    const info = { ...(this.renderer.info.render as { drawCalls: number; triangles: number }) }
    this.dirty = true
    const sorted = times.slice().sort((a, b) => a - b)
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    const size = this.renderer.getDrawingBufferSize(new Vector2())
    let visible = 0
    for (let i = 0; i < this.display.length; i++) if (this.display[i] !== HIDDEN && this.inst[i]! >= 0) visible++
    return {
      backend: this.backend,
      frames,
      msPerFrame: round(avg),
      msP95: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      fpsUncapped: round(1000 / avg),
      renderCpuMsAvg: round(cpu / frames),
      visibleParts: visible,
      drawCalls: info.drawCalls,
      triangles: info.triangles,
      size: [size.x, size.y],
    }
  }

  /** 部件（爆炸后）质心的客户区坐标，用于从控制台驱动拾取。 */
  /** Client coordinates of a part's (exploded) centroid — for driving picks from the console. */
  screenOf(partId: string): { x: number; y: number } | null {
    const i = this.graph.indexOf(partId)
    if (i < 0) return null
    const c = this.graph.parts[i]!.centroid
    const v = new Vector3(c[0] + this.offsets[i * 3]!, c[1] + this.offsets[i * 3 + 1]!, c[2] + this.offsets[i * 3 + 2]!)
    this.camera.updateMatrixWorld()
    v.project(this.camera)
    const rect = this.renderer.domElement.getBoundingClientRect()
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height }
  }

  /** 场景中某部件当前的显示状态。 */
  /** Display state of a part as the scene currently has it. */
  displayOf(partId: string): { state: 'hidden' | 'normal' | 'ghost'; pickable: boolean; hasGeometry: boolean; thin: boolean; radiusMm: number } | null {
    const i = this.graph.indexOf(partId)
    if (i < 0) return null
    if (this.syncNeeded) this.sync()
    const d = this.display[i]
    const r = this.radius[i]!
    return {
      state: d === HIDDEN ? 'hidden' : d === GHOST ? 'ghost' : 'normal',
      pickable: !!this.pickable[i],
      hasGeometry: this.inst[i]! >= 0,
      thin: r > 0 && r < THIN_RADIUS,
      radiusMm: Math.round(r * 1e5) / 100,
    }
  }

  systemsLoaded(): SystemId[] {
    const seen = new Set<SystemId>()
    this.graph.parts.forEach((p, i) => {
      if (this.inst[i]! >= 0) seen.add(p.system)
    })
    return [...seen]
  }
}

interface GPUDeviceLike {
  queue: { onSubmittedWorkDone(): Promise<void> }
}

function round(v: number): number {
  return Math.round(v * 100) / 100
}

/** 按面积加权重算一个部件的顶点法线（索引值减去 base 得到部件内的顶点号）。 */
/** Recompute a part's vertex normals, area-weighted (index values minus `base` are part-local vertex numbers). */
function recomputeNormals(position: Float32Array, index: ArrayLike<number>, base: number, normal: Float32Array): void {
  normal.fill(0)
  for (let t = 0; t < index.length; t += 3) {
    const a = (index[t]! - base) * 3
    const b = (index[t + 1]! - base) * 3
    const c = (index[t + 2]! - base) * 3
    const ux = position[b]! - position[a]!, uy = position[b + 1]! - position[a + 1]!, uz = position[b + 2]! - position[a + 2]!
    const vx = position[c]! - position[a]!, vy = position[c + 1]! - position[a + 1]!, vz = position[c + 2]! - position[a + 2]!
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    for (const o of [a, b, c]) {
      normal[o] = normal[o]! + nx
      normal[o + 1] = normal[o + 1]! + ny
      normal[o + 2] = normal[o + 2]! + nz
    }
  }
  for (let i = 0; i < normal.length; i += 3) {
    const l = Math.hypot(normal[i]!, normal[i + 1]!, normal[i + 2]!) || 1
    normal[i] = normal[i]! / l
    normal[i + 1] = normal[i + 1]! / l
    normal[i + 2] = normal[i + 2]! / l
  }
}

function boundsOf(position: Float32Array): [number, number, number, number, number, number] {
  const b: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < position.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const v = position[i + c]!
      if (v < b[c]!) b[c] = v
      if (v > b[c + 3]!) b[c + 3] = v
    }
  }
  return b
}

/** 取一个文件的全部字节，边取边报告进度 / Fetch all bytes of a file, reporting progress on the way. */
async function fetchBytes(url: string, onProgress: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body) {
    const all = await res.arrayBuffer()
    onProgress(all.byteLength, all.byteLength)
    return all
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    onProgress(loaded, total)
  }
  const out = new Uint8Array(loaded)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out.buffer
}
