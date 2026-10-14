// 三维视图：渲染器、相机、部件几何、拾取，以及把 store 状态映射到场景。WebGPU 下部件合批绘制，WebGL2 下每个部件一个网格；按需渲染。
// The 3D view: renderer, camera, part meshes, picking, and the mirror from store state to
// scene state. One Mesh per part, shared materials; rendering is on demand.

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  MeshBasicNodeMaterial,
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
import { CONSTRUCTION_COLOR, TISSUE_COLOR, TISSUE_OPACITY, partLook, provenanceColor } from '../anatomy/labels.ts'
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
import { ActivityLayer } from './activityLayer.ts'
import { useActivity } from '../activity/state.ts'
import { probeSkinnedPositions } from './skinProbe.ts'
import { SkinningData, positionNodeFor, type SkinningMode } from './skinning.ts'
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
  writeMuscleThin,
  type LoadedRig,
  type Pose,
  type Scales,
} from '../anatomy/rig.ts'
import { clampPose, mergePoses } from '../../tools/rig/pose.ts'
import { addBlink, addLidGaze, applyLidDrop, faceFrame, lidDropActive, lidGains, lidGazeChannels, setFacePaused } from '../face/driver.ts'
import { displacePart, sameAUs, type AUs, type Activations, type LoadedFace } from '../pain/face.ts'
import { Shaper } from '../../tools/rig/shape.ts'
import { shapeIsDefault, type LoadedShape, type ShapeControls } from '../anatomy/shape.ts'
import { SkinLayer, type SkinGeometry } from './skinLayer.ts'
import { FaceDetailLayer, type DetailDebug } from './faceDetail.ts'
import { SkinPatch } from './skinPatch.ts'
import { DentPatch, type DentPatchData } from './dentPatch.ts'
import { DisplacementOverlay } from './dispOverlay.ts'
import { fetchJson } from '../anatomy/load.ts'
import type { FaceOpenings } from '../face/types.ts'
import { PAIN_COLORS, PainOverlay, PathVisuals, bindPath, boundPositions, resamplePolyline, type PathBinding } from './stimVisuals.ts'
import { applyStimulus, registerStimHost, releaseStimulus, stimFrame, type ActiveStim, type StimFrame } from '../pain/stim.ts'
import { registerSoftHost } from '../softbody/host.ts'
import type { ResolvedSite } from '../pain/stimulus.ts'
import { layerWeights, type LoadedDetail } from '../pain/detail.ts'
import { LumenLayer } from './lumenLayer.ts'
import { ORIGIN_BOUNDED, ORIGIN_CONSTRUCTION, ORIGIN_MIXED, applyFilling, buildCanalPath, pathPoint, radiusAt, ringStations, ringsOf, segmentAt, widenRings, type CanalPath, type PathSegmentInput, type RingMesh, type V3 } from '../lumen/core.ts'
import { LUMEN_COLOR } from '../lumen/colors.ts'
import { isTrackpadScroll } from './wheel.ts'
import { LookSkin } from '../look/lookSkin.ts'
import { LookEnvironment } from '../look/environment.ts'
import { SkinLook } from '../look/skinMaterial.ts'
import type { LoadedSkinUv } from '../look/load.ts'
import { EyeLook, LookEyes } from '../look/eyes.ts'
import { fitEye, type EyeFit, type M3 } from '../look/eyesFit.ts'
import { pupilTarget } from '../look/eyesLife.ts'
import { HairLayer } from '../hair/layer.ts'
import { ClothLayer } from '../cloth/layer.ts'
import type { LoadedCloth } from '../cloth/load.ts'
import { FLY_MIN_FILL, FLY_MIN_RADIUS, FLY_SPEED, displacementOf, ensureLumenData, fillingOf, lumenCandidates, registerLumenGeometry, reportFly, segmentIds, showCanal, useLumen, type LumenData, type LumenState } from '../lumen/state.ts'

const LEGACY_SORT = typeof location !== 'undefined' && new URLSearchParams(location.search).get('sort') === 'origin'
const GHOST_RGB = new Color('#8d99a6')
const GHOST_OPACITY = 0.07
/** 比这更透明的部件不可拾取（指针穿过它们）。 */
/** Parts drawn more transparent than this are not pickable (the pointer passes through). */
const PICK_OPACITY = 0.4
const ACCENT_RGB = new Color(ACCENT)
const PATH_RGB = new Color(PAIN_COLORS.path)
/** 口腔袋的颜色：近黑、不受光，读作"空腔"而不是组织 / The oral pouch's colour: near black and unlit, reading as a cavity rather than tissue. */
const POUCH_COLOR = '#120a0c'
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

/** 跟随皮肤的覆盖层（皱纹层、疼痛分布层、写实皮肤、毛发……）/ An overlay that follows the skin (wrinkles, pain map, lifelike skin, hair …). */
interface Follower {
  patch: Pick<SkinPatch, 'setPositions' | 'setInfluences' | 'setOffset'> & { mesh: Object3D }
  setSkinning(mode: SkinningMode): void
  dispose(): void
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
  | 'skinHide'
  | 'skinOpaque'
  | 'look'
  | 'tone'
  | 'iris'
  | 'gaze'
  | 'blink'
  | 'skinUv'
  | 'hairStyle'
  | 'hairColor'
  | 'wear'
  | 'clothes'
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
  /** 个别部件自己的不透明度（角膜、前房），见 labels.ts 的 PART_LOOK / A few parts' own opacity (cornea, anterior chamber); see PART_LOOK in labels.ts. */
  private lookOpacity: (number | undefined)[] = []
  /** 眉毛部件：皮肤画成不透明时它们也画成不透明 / The eyebrow parts: drawn opaque whenever the skin is. */
  private brows: ReadonlySet<string> = new Set()
  /** 已加载的各系统 GLB 的字节哈希（文件名 → sha256 前 16 位）/ Byte hashes of the system GLBs loaded so far (file name → first 16 hex of sha256). */
  private glbHashes = new Map<string, string>()
  /** 贴在皮肤本体上、跟着它变形的覆盖网格（皱纹细节、疼痛分布）/ Overlay meshes on the skin proper that deform with it (wrinkle detail, pain map). */
  private followers: Follower[] = []
  /** 写实模式的毛发层（src/hair/）；它替代的外壳在写实模式下藏起来 / the lifelike hair layer (src/hair/); the shells it replaces are hidden in lifelike mode */
  private hair: HairLayer | null = null
  private hairCovers = ''
  private hairDirty = false
  private hideWithHair: { from: ReadonlySet<string>; covers: string; set: ReadonlySet<string> } | null = null
  private detailLayer: FaceDetailLayer | null = null
  // —— 皮肤的开口 / the skin's openings ——
  private openings: FaceOpenings | null = null
  private openingsLoad: { token: number; promise: Promise<FaceOpenings | null> } | null = null
  private pouchTriangles: Uint32Array | null = null
  private pouch: { patch: SkinPatch; material: MeshBasicNodeMaterial; setSkinning(mode: SkinningMode): void; dispose(): void } | null = null
  private hideFrom: readonly string[] | null = null
  private hideSet: ReadonlySet<string> = new Set()
  private throughShown = false
  private cornerApplied = 0
  private cornerOf: { face: unknown; id: string | null } = { face: null, id: null }
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
  /** 写实皮肤层、它的参数和光照环境（见 src/look/）/ the lifelike skin layer, its parameters and lighting environment (see src/look/) */
  private lookSkin: LookSkin | null = null
  private appliedSkinUv: LoadedSkinUv | null = null
  /** 穿着的衣服（静止预览，见 src/cloth/layer.ts）/ the garments worn (static preview, see src/cloth/layer.ts) */
  private clothLayers = new Map<LoadedCloth, ClothLayer | null>()
  private readonly skinLook = new SkinLook()
  private lookEnv!: LookEnvironment
  private lookWanted = true
  /** 每个皮肤顶点的写实 UV（给皱纹层），按 appliedSkinUv 缓存 / the lifelike UV per skin vertex (for the wrinkle layer), cached for appliedSkinUv */
  private lookUvPerSkin: Float32Array | null = null
  /** 写实的眼（src/look/eyes.ts）、扫描眼球部件的下标（写实的眼显示时藏起来）/ the lifelike eyes (src/look/eyes.ts) and the scanned eyeball parts (hidden while they show) */
  private lookEyes: LookEyes | null = null
  private readonly eyeLook = new EyeLook()
  private eyeParts: { L: number[]; R: number[]; sclera: number[] } = { L: [], R: [], sclera: [] }
  private eyesDirty = false
  private eyesT = 0
  private lidGainCache: { face: LoadedFace; gains: Record<string, number> } | null = null
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
  /** 软组织物理给主皮肤的静止空间位移（null = 没有）/ the rest-space displacement the soft-tissue physics gives the main skin (null = none) */
  private softOffset: Float32Array | null = null
  /** 同样的位移，给其他部件（按部件下标）/ the same kind of displacement for other parts (by part index) */
  private softParts = new Map<number, Float32Array>()
  /** 按压凹陷的细分显示网格（src/viewer/dentPatch.ts）/ the subdivided display mesh of a press's dent (src/viewer/dentPatch.ts) */
  private dentPatch: DentPatch | null = null
  /** 软组织物理的位移着色层 / the soft-tissue physics' displacement colour layer */
  private dispOverlay: DisplacementOverlay | null = null
  private dispOn = false
  private dentData: DentPatchData | null = null
  private dentShown = false
  private faceAUs: AUs = {}
  /** 已应用到顶点上的通道激活 / The channel activations applied to the vertices. */
  private faceChannels: Activations = {}
  private faceJaw = 0
  private faceForce = false
  private poseDirty = false
  private jawApplied = 0
  private prewarmVersion = -1
  private prewarmNext = 0
  private skinLayerPart = -1
  // —— 腔（见 syncLumen / stepLumen / stepFly）/ the lumina (see syncLumen / stepLumen / stepFly) ——
  /** 默认藏起来的腔部件（有充盈数据的那些；数据没到之前按"组织为 space 且带 composition"）/ Lumen parts hidden by default (those with filling data; before it arrives, "tissue space with a composition"). */
  private lumenHide = new Set<number>()
  /** "腔"模式下画成腔的全部部件，和它们的壁 / Every part drawn as a lumen in the lumina mode, and their walls. */
  private lumenAll = new Set<number>()
  private lumenWalls = new Set<number>()
  private lumenColor = new Map<number, Color>()
  private lumenData: LumenData | null = null
  private lumenRequested = false
  private lumenLayer: LumenLayer | null = null
  private lumenLayerStale = false
  private lumenLayerOn = false
  private lumenRings = new Map<number, RingMesh | null>()
  /** 已写进顶点缓冲的充盈状态（每个部件一个键）/ The filling state written into the vertex buffers (a key per part). */
  private lumenApplied = new Map<number, string>()
  private lumenVersion = 0
  private lumenDirty = false
  private lumenPrev: LumenState | null = null
  private lumenWallsOn = false
  private unsubLumen: (() => void) | null = null
  private fly: {
    path: CanalPath | null
    key: string
    s: number
    lastT: number
    seekNonce: number
    started: boolean
    reported: number
    up: Vector3
    saved: { position: Vector3; target: Vector3; fov: number; near: number; far: number }
  } | null = null

  /** 关节纹理最多容纳的行数（关节数 + 1）和肌肉作用线数 / Capacity of the joint texture (joints + 1) and of the muscle texture. */
  private static readonly MAX_JOINT_ROWS = 512
  private static readonly MAX_MUSCLES = 1024
  readonly skinning = new SkinningData(Viewer.MAX_JOINT_ROWS, Viewer.MAX_MUSCLES)
  private poseRt: PoseRuntime | null = null
  /** 肌肉活动层（只在主视图上）及其对 store 的订阅 / The muscle-activity layer (main view only) and its store subscription. */
  private activityLayer: ActivityLayer | null = null
  private unsubActivity: (() => void) | null = null
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
      // 软组织物理（src/softbody/client.ts）：静止几何和皮肤上的位移 / soft-tissue physics (src/softbody/client.ts): rest geometry and the skin's displacement
      registerSoftHost({
        skin: () => {
          const i = this.mainSkinIndex()
          const g = i >= 0 ? this.skinGeometry.get(i) : undefined
          if (!g) return null
          // 口腔袋的三角形放回去：笼子的"体内"判断要完整的皮肤 / the oral pouch's triangles go back in: the cage's inside test needs the whole skin
          const indices = this.pouchTriangles ? Uint32Array.from([...g.index, ...this.pouchTriangles]) : g.index
          return { part: this.mainSkin!, positions: g.position, indices }
        },
        restGeometry: (partId) => this.restGeometry(partId),
        setSkinOffset: (offset, dent, parts) => this.setSkinOffset(offset, dent ?? null, parts ?? null),
        setSkinColors: (rgba) => this.setSkinColors(rgba),
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
    const fill = new HemisphereLight(0xf2f5fa, 0x4a443e, 1.25)
    this.scene.add(fill)
    this.lookEnv = new LookEnvironment(this.renderer, this.scene, fill)
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
    // 先于相机控制器：触控板双指滑动改为平移（嵌入模式下排在 onEmbedWheel 之后，未激活时被它拦下）
    // ahead of the camera controls: a two-finger trackpad swipe pans (in embed mode it comes after onEmbedWheel, which stops it while inactive)
    if (this.embed) {
      el.addEventListener('wheel', this.onEmbedWheel, { capture: true })
      el.addEventListener('wheel', this.onTrackpadWheel, { capture: true, passive: false })
      el.addEventListener('focus', this.onEmbedFocus)
      el.addEventListener('blur', this.onEmbedBlur)
    } else el.addEventListener('wheel', this.onTrackpadWheel, { capture: true, passive: false })
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
      // 腔的状态在它自己的 store 里；位置等高频的报告不触发同步 / the lumina have a store of their own; high-rate reports (position…) do not trigger a sync
      this.unsubLumen = useLumen.subscribe((a, b) => {
        if (a.mode !== b.mode || a.fill !== b.fill || a.overrides !== b.overrides || a.fly !== b.fly || a.data !== b.data || a.seek !== b.seek) {
          this.syncNeeded = true
          this.dirty = true
        }
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
    if (this.source === useApp.getState) setFacePaused(now)
    if (now) {
      cancelAnimationFrame(this.raf)
      this.pausedAt = performance.now()
      return
    }
    const dt = performance.now() - this.pausedAt
    if (this.tween) this.tween.t0 += dt
    if (this.poseTween) this.poseTween.t0 += dt
    this.breathT0 += dt
    if (this.fly) this.fly.lastT = 0
    this.lastFrameT = 0
    this.dirty = true
    this.raf = requestAnimationFrame(this.tick)
  }

  private onEmbedWheel = (e: WheelEvent): void => {
    // 未激活且没按修饰键：不交给相机控制器，也不阻止默认行为，页面照常滚动
    // not activated and no modifier: keep it from the camera controls and let the page scroll
    if (document.activeElement !== this.renderer.domElement && !e.ctrlKey && !e.metaKey) e.stopImmediatePropagation()
  }
  private onTrackpadWheel = (e: WheelEvent): void => {
    // 捏合（带 ctrlKey）和鼠标滚轮照旧交给控制器缩放；触控板的双指滑动平移，内容跟着手指走
    // a pinch (ctrlKey set) and a mouse wheel still go to the controls and zoom; a two-finger trackpad swipe pans, the content following the fingers
    if (e.ctrlKey || !isTrackpadScroll(e)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    this.tween = null
    this.controls.pan(-e.deltaX, -e.deltaY)
    this.reportCameraSoon()
  }
  private panSettle: ReturnType<typeof setTimeout> | null = null
  private reportCameraSoon(): void {
    // 滑动没有 end 事件：停下 200 ms 后记一次相机 / a swipe has no end event: record the camera once it has stopped for 200 ms
    if (this.panSettle) clearTimeout(this.panSettle)
    this.panSettle = setTimeout(() => {
      this.panSettle = null
      this.reportCamera()
    }, 200)
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
    this.dentPatch?.dispose()
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
    el.removeEventListener('wheel', this.onTrackpadWheel, { capture: true })
    if (this.panSettle) clearTimeout(this.panSettle)
    el.removeEventListener('focus', this.onEmbedFocus)
    el.removeEventListener('blur', this.onEmbedBlur)
    this.controls.dispose()
    this.batches?.dispose()
    this.skinLayer?.dispose()
    this.gizmo.dispose()
    this.skinning.dispose()
    this.unsubActivity?.()
    this.activityLayer?.dispose()
    this.unsubLumen?.()
    this.lumenLayer?.dispose()
    this.renderer.dispose()
    el.remove()
  }

  // ------------------------------------------------------------ 几何加载 / geometry loading

  private allocate(): void {
    this.mainSkin = this.graph.mainSkinId()
    this.lookOpacity = this.graph.parts.map((p) => partLook(p.name)?.opacity)
    this.brows = new Set(this.graph.parts.filter((p) => p.system === 'integumentary' && /eyebrow/i.test(p.name)).map((p) => p.id))
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
    this.openings = null
    this.openingsLoad = null
    this.pouchTriangles = null
    this.pouch = null
    this.throughShown = false
    this.detailLayer = null
    this.lookSkin = null
    this.hair = null
    this.hairCovers = ''
    this.appliedSkinUv = null
    this.lookUvPerSkin = null
    this.lookEyes = null
    this.eyeParts = { L: [], R: [], sclera: [] }
    this.clothLayers = new Map()
    this.painOverlay = null
    this.dispOverlay = null
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
    this.faceChannels = {}
    this.faceJaw = 0
    if (this.lumenLayer) {
      this.root.remove(this.lumenLayer.mesh)
      this.lumenLayer.dispose()
      this.lumenLayer = null
    }
    this.lumenLayerOn = false
    this.lumenData = null
    this.lumenRequested = false
    this.lumenRings = new Map()
    this.lumenApplied = new Map()
    this.lumenColor = new Map()
    this.lumenWalls = new Set()
    this.lumenAll = new Set()
    this.lumenPrev = null
    this.lumenDirty = true
    // 数据没到之前：组织为 space 且带 composition 的部件先按腔处理（默认藏起来）
    // before the data arrives, parts with tissue `space` and a `composition` are treated as lumina (hidden by default)
    this.lumenHide = new Set(lumenCandidates(this.graph).map((id) => this.graph.indexOf(id)))
    if (this.fly) this.endFly()
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
          // 皮肤的开口说明要赶在皮肤入场之前到 / the description of the skin's openings must be here before the skin goes in
          const openings = sys.id === 'integumentary' ? await this.openingsOf(token) : null
          if (this.disposed || token !== this.bodyToken) return
          if (hash) this.glbHashes.set(sys.glb!, hash)
          const baked = this.bake(gltf.scene)
          const fresh: number[] = []
          for (const [i, b] of baked) {
            if (this.inst[i]! >= 0) continue
            const part = graph.parts[i]!
            if (part.tissue === 'skin') {
              // 皮肤本体带口腔袋时：袋的三角形从皮肤里拿出来另画（深色、不可拾取、不上体表图），皮肤只留其余的
              // when the skin proper carries an oral pouch, its triangles are taken out to be drawn apart (dark, unpickable, off the maps); the skin keeps the rest
              if (part.id === this.mainSkin && openings) this.splitPouch(b.geometry, openings)
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
          this.lumenLayerStale = true
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
    // 透过皮肤开口看到的牙、舌、眼球所在的系统 / the systems holding the teeth, tongue and eyeballs seen through the skin's openings
    for (const id of this.throughOpenings(s) ?? []) add(id)
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

    const lumen = this.source === useApp.getState ? this.syncLumen(s) : null
    const displayChanged =
      !p ||
      this.lumenDirty ||
      p.section.enabled !== s.section.enabled ||
      p.explode !== s.explode ||
      p.systems !== s.systems ||
      p.peel !== s.peel ||
      p.hidden !== s.hidden ||
      p.isolated !== s.isolated ||
      p.adjacentMode !== s.adjacentMode ||
      p.provenanceHidden !== s.provenanceHidden ||
      p.colorMode !== s.colorMode ||
      this.stimDirty ||
      this.eyesDirty ||
      p.skinHide !== s.skinHide ||
      p.peel !== s.peel ||
      p.skinOpaque !== s.skinOpaque ||
      p.look !== s.look ||
      p.skinUv !== s.skinUv ||
      this.hairDirty ||
      p.wear !== s.wear ||
      p.clothes !== s.clothes ||
      skinDrawnOpaque(p, this.mainSkin) !== skinDrawnOpaque(s, this.mainSkin) ||
      p.selection !== s.selection
    this.stimDirty = false
    this.lumenDirty = false
    this.eyesDirty = false
    this.hairDirty = false
    const explodeChanged =
      !p ||
      p.explode !== s.explode ||
      p.explodeSelectionOnly !== s.explodeSelectionOnly ||
      (s.explodeSelectionOnly && s.explode > 0 && p.selection !== s.selection)
    const sectionChanged = !p || p.section !== s.section
    const hoverChanged = !p || p.hover !== s.hover
    const boostChanged = !p || p.nerveBoost !== s.nerveBoost
    this.syncDetail(s)
    this.syncLook(s)
    this.syncEyes(s)
    // 发型、发色变了：只告诉毛发层 / hair style or colour changed: only the hair layer needs telling
    if (this.hair && (!p || p.hairStyle !== s.hairStyle || p.hairColor !== s.hairColor)) this.syncHair(this.lookShowing())
    this.syncClothes(s)
    // 写实外观：皮肤画成不透明时才去取 UV 网格 / lifelike look: the UV mesh is fetched only once the skin is drawn opaque
    if (this.source === useApp.getState && s.look && !s.skinUv && skinDrawnOpaque(s, this.mainSkin)) void useApp.getState().ensureSkinUv()
    // 皮肤不透明时要藏哪些部件，写在管线报告里：第一次用到时去取 / which parts to hide under an opaque skin is in the pipeline report: fetched on first use
    if (this.source === useApp.getState && s.skinHide === undefined && skinDrawnOpaque(s, this.mainSkin)) useApp.getState().ensureSkinReport()
    // 有真实口裂的皮肤：下颌一张开就需要表情数据里的口角通道（哪怕没开过"疼痛"页）
    // a skin with a real oral fissure needs the face data's mouth-corner channel as soon as the jaw opens (even if the Pain tab was never opened)
    if (this.source === useApp.getState && this.openings && !s.face && s.pose.tmj?.some((x) => x !== 0)) void useApp.getState().ensureFace()
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
    if (!displayChanged && skinChanged) this.updatePouch(s)

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
          unfitted: skinDrawnOpaque(s, this.mainSkin) ? this.withHairCovers(this.hideWithOpaqueSkin(s)) : null,
          forced: this.throughOpenings(s),
        },
        this.display,
      )
      this.hideScannedEyes(s)
      this.applyLumenDisplay(s, lumen)
      for (let i = 0; i < parts.length; i++) this.applyPart(i, parts[i]!, s)
      this.updateLumenLayer(s)
      this.updateDetail()
      this.updatePouch(s)
    } else if (hoverChanged) {
      for (const id of [p?.hover, s.hover]) {
        if (!id) continue
        const i = this.graph.indexOf(id)
        if (i >= 0) this.applyPart(i, this.graph.parts[i]!, s)
      }
      this.updateLumenLayer(s)
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
    // 肌肉活动层：只在主视图上；模式、重力或负荷变了就重算一次 / the muscle-activity layer: main view only; recomputed when mode, gravity or load change
    this.activityLayer?.dispose()
    this.activityLayer = null
    if (this.source === useApp.getState) {
      this.activityLayer = new ActivityLayer(this.graph, rig, this.baseUrl, Viewer.MAX_MUSCLES, () => (this.poseDirty = true))
      this.unsubActivity ??= useActivity.subscribe((a, b) => {
        if (a.mode !== b.mode || a.gravity !== b.gravity || a.load !== b.load) this.poseDirty = true
      })
    }
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
      // 有经过点的肌肉按静止几何写横截面权重 / muscles with via points get cross-section weights from their rest geometry
      writeInfluences(rig, parts[i]!.id, n, b.skinIndex, b.skinWeight, 0, b.position)
      // 肌肉部件：aThin 记作 −(作用线下标 + 1)（有经过点时另含顶点参数 s），着色器据此做体积修正和推出骨面
      // muscle parts: aThin holds −(line index + 1) (with via points also the vertex parameter s), which the shader uses for the volume correction and the push out of the bone
      writeMuscleThin(rig, parts[i]!.id, n, b.aux, 0, b.position)
    }
    batches.flushSkinAttributes()
    this.lumenLayerStale = true
    this.syncNeeded = true
    for (const f of this.followers) this.applyRigToFollower(f.patch)
  }

  /** 皮肤本体在 graph.parts 里的下标；没有几何时为 -1 / Index of the skin proper in graph.parts; -1 without geometry. */
  private mainSkinIndex(): number {
    const i = this.mainSkin ? this.graph.indexOf(this.mainSkin) : -1
    return i >= 0 && this.inst[i]! >= 0 && this.skinGeometry.has(i) ? i : -1
  }

  private applyRigToFollower(patch: Follower['patch']): void {
    const rig = this.appliedRig
    const i = this.mainSkinIndex()
    if (!rig || i < 0 || !this.batches) return
    const b = this.batches.partBuffers(this.inst[i]!)
    patch.setInfluences(b.skinIndex, b.skinWeight)
  }

  /** 把一块覆盖网格挂到皮肤上：当前的位置、绑定、蒙皮方式和爆炸位移都跟上 / Attach an overlay to the skin: current positions, rig, skinning mode and explode offset all follow. */
  private addFollower(f: Follower): void {
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

  private removeFollower(f: Follower): void {
    this.followers = this.followers.filter((x) => x !== f)
    this.root.remove(f.patch.mesh)
    f.dispose()
  }

  /** 表情数据里口角通道的 id（kind 为 corner）；没有则为 null / The id of the mouth-corner channel in the face data (kind corner); null when it has none. */
  private cornerChannel(face: { data: { channels: { id: string; kind: string }[] } }): string | null {
    if (this.cornerOf.face !== face) this.cornerOf = { face, id: face.data.channels.find((c) => c.kind === 'corner')?.id ?? null }
    return this.cornerOf.id
  }

  /** 这副人体皮肤的开口说明（face/openings.json）；没有时为 null。每副人体只取一次。 */
  /** The description of this body's skin openings (face/openings.json); null when it has none. Fetched once per body. */
  private openingsOf(token: number): Promise<FaceOpenings | null> {
    if (!this.openingsLoad || this.openingsLoad.token !== token) {
      const promise = fetchJson<FaceOpenings>(new URL('face/openings.json', new URL(this.baseUrl, location.href)).href)
        .catch(() => null)
        .then((o) => {
          if (token !== this.bodyToken) return null
          const ok = !!o && o.schema === 1 && o.skin === this.mainSkin && !!o.oralPouch && Array.isArray(o.oralPouch.upper)
          this.openings = ok ? o : null
          return this.openings
        })
      this.openingsLoad = { token, promise }
    }
    return this.openingsLoad.promise
  }

  /**
   * 把口腔袋的三角形从皮肤几何的索引里拿出来（顶点不动，顶点顺序是绑定、体型、体表图的依据）。
   * 凡是用到袋顶点（上半、下半、缝）的三角形都算袋的；睑缘内卷留在皮肤里，按皮肤画。
   * Take the oral pouch's triangles out of the skin geometry's index (vertices stay: their order is what the rig,
   * the shape and the maps go by). Any triangle using a pouch vertex (upper, lower, seam) counts as pouch; the lid
   * rims stay in the skin and are drawn as skin.
   */
  private splitPouch(geometry: BufferGeometry, o: FaceOpenings): void {
    const count = geometry.getAttribute('position').count
    if (o.vertexCount !== count) {
      console.warn(`[soma] openings.json is for ${o.vertexCount} skin vertices, the skin has ${count}: ignored`)
      this.openings = null
      return
    }
    const pouch = new Uint8Array(count)
    for (const v of [...o.oralPouch.upper, ...o.oralPouch.lower, ...o.oralPouch.seam]) if (v < count) pouch[v] = 1
    const src = geometry.index!.array
    const keep: number[] = [], out: number[] = []
    for (let t = 0; t + 2 < src.length; t += 3) {
      const a = src[t]!, b = src[t + 1]!, c = src[t + 2]!
      if (pouch[a] || pouch[b] || pouch[c]) out.push(a, b, c)
      else keep.push(a, b, c)
    }
    geometry.setIndex(new BufferAttribute(Uint32Array.from(keep), 1))
    this.pouchTriangles = Uint32Array.from(out)
  }

  /** 口腔袋：深色、不受光、不透明的一块，只在皮肤画成不透明时画（皮肤透明时它只会挡住牙和舌）。 */
  /** The oral pouch: a dark, unlit, opaque piece, drawn only while the skin is drawn opaque (under a see-through skin it would just hide teeth and tongue). */
  private syncPouch(): void {
    const i = this.mainSkinIndex()
    if (this.pouch || !this.pouchTriangles || i < 0) return
    const material = new MeshBasicNodeMaterial({ color: POUCH_COLOR })
    const patch = new SkinPatch(this.skinGeometry.get(i)!, null, material, this.pouchTriangles)
    this.pouch = {
      patch,
      material,
      setSkinning: (mode) => {
        material.positionNode = positionNodeFor(this.skinning, mode, false) as typeof material.positionNode
        material.needsUpdate = true
      },
      dispose: () => {
        patch.dispose()
        material.dispose()
      },
    }
    this.addFollower(this.pouch)
  }

  /** 口腔袋的可见性和颜色 / The pouch's visibility and colour. */
  private updatePouch(s: ViewState): void {
    this.updateDent()
    this.syncPouch()
    const p = this.pouch
    if (!p) return
    const i = this.mainSkinIndex()
    // 皮肤画成不透明：不透明开关 / 被选中，或者体表图图层在画它（未透视）
    // the skin is drawn opaque: by the switch or a selection, or the skin-map layer is drawing it (not see-through)
    const show = i >= 0 && this.display[i] === NORMAL && (i === this.skinIndex ? this.skinPickable : this.solid[i] === 1)
    // 按来源着色时用"构造物"的颜色：它不是解剖 / in colour-by-source mode it takes the construction colour: it is not anatomy
    p.material.color.set(s.colorMode === 'source' ? CONSTRUCTION_COLOR : POUCH_COLOR)
    if (p.patch.mesh.visible !== show) {
      p.patch.mesh.visible = show
      this.dirty = true
    }
  }

  /** 开口与口腔袋的状态（验证用）/ State of the openings and the pouch (verification). */
  openingsState(): { openings: boolean; pouchTriangles: number; pouchVisible: boolean; through: number; hide: string[] } {
    return {
      openings: !!this.openings,
      pouchTriangles: this.pouchTriangles ? this.pouchTriangles.length / 3 : 0,
      pouchVisible: !!this.pouch?.patch.mesh.visible,
      through: this.graph.throughOpeningParts().size,
      hide: [...this.hideWithOpaqueSkin(this.source())],
    }
  }

  /** 皮肤不透明时要藏起来的部件：管线报告给了清单就用它，否则按名称（头发、眉毛、阴毛）。 */
  /** Parts hidden while the skin is opaque: the pipeline report's list when it gives one, else by name (hair, eyebrows, pubic hair). */
  private hideWithOpaqueSkin(s: ViewState): ReadonlySet<string> {
    if (Array.isArray(s.skinHide)) {
      if (s.skinHide !== this.hideFrom) {
        this.hideFrom = s.skinHide
        this.hideSet = new Set(s.skinHide)
      }
      return this.hideSet
    }
    return this.graph.unfittedAppendages()
  }

  /** 皮肤带真实开口并且此刻画成不透明（没有被剥掉、隔离掉）：透过开口看到的深部部件要画出来 */
  /** The skin has real openings and is drawn opaque right now (not peeled or isolated away): the deep parts seen through them are to be drawn. */
  private throughOpenings(s: ViewState): ReadonlySet<string> | null {
    if (!this.openings || !skinDrawnOpaque(s, this.mainSkin) || s.isolated) return null
    const skin = this.mainSkin ? this.graph.part(this.mainSkin) : undefined
    if (!skin || !(s.systems[skin.system]?.visible ?? true) || skin.depth < s.peel || s.hidden.has(skin.id)) return null
    return this.graph.throughOpeningParts()
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

  /** 写实皮肤层：UV 数据到了（或换了）就重建；可见性由 updateLook 管 / The lifelike skin layer: rebuilt when its UV data arrive or change; visibility is updateLook's job. */
  private syncLook(s: ViewState): void {
    this.lookWanted = s.look
    if (this.skinLook.setTone(s.tone)) this.dirty = true
    if (s.skinUv === this.appliedSkinUv && (this.lookSkin || !s.skinUv)) return
    const i = this.mainSkinIndex()
    if (s.skinUv && i < 0) return // 皮肤还没加载，下次再来 / the skin is not loaded yet; try again later
    if (this.lookSkin) {
      this.removeFollower(this.lookSkin)
      this.lookSkin = null
    }
    this.appliedSkinUv = s.skinUv
    this.lookUvPerSkin = null
    if (!s.skinUv) return
    const geo = this.skinGeometry.get(i)!
    if (s.skinUv.data.skin !== this.mainSkin || !LookSkin.fits(geo, s.skinUv)) {
      console.warn(`[soma] lifelike skin rejected: it is for ${s.skinUv.data.skin} with ${s.skinUv.data.skinVertexCount} vertices, the skin ${this.mainSkin} has ${geo.position.length / 3}`)
      return
    }
    this.lookSkin = new LookSkin(geo, s.skinUv, this.skinLook, this.skinning, this.pouchTriangles)
    this.addFollower(this.lookSkin)
    this.updateDetail()
  }

  /**
   * 写实的眼：写实外观要了、皮肤开口和扫描的巩膜都到了，就按扫描的巩膜和角膜拟合出两只眼并挂到皮肤上（泪液线是皮肤的跟随层）。
   * The lifelike eyes: once the lifelike look is wanted and the skin openings and the scanned sclerae have arrived, two eyes are
   * fitted to the scanned sclera and cornea and attached to the skin (the tear line is a skin follower).
   */
  private syncEyes(s: ViewState): void {
    if (this.eyeLook.setIris(s.iris)) this.dirty = true
    const i = this.mainSkinIndex()
    if (!this.lookEyes && s.look && this.lookSkin && this.openings && i >= 0 && this.batches) {
      const parts = this.graph.parts
      const named = /^(left|right) (sclera|cornea|iris|lens|choroid|vitreous body)$|^optic part of (left|right) retina$|^anterior chamber of (left|right) eyeball$/i
      const eyeParts: { L: number[]; R: number[]; sclera: number[] } = { L: [], R: [], sclera: [] }
      const fits: EyeFit[] = []
      for (const side of ['L', 'R'] as const) {
        const own = parts.map((p, k) => ({ p, k })).filter(({ p }) => p.side === side && named.test(p.name))
        eyeParts[side] = own.map(({ k }) => k)
        const sclera = own.find(({ p }) => /sclera$/i.test(p.name))
        const cornea = own.find(({ p }) => /cornea$/i.test(p.name))
        if (!sclera || this.inst[sclera.k]! < 0) return // 巩膜还没加载，下次再来 / the sclera is not loaded yet; try again later
        const pos = this.batches.partBuffers(this.inst[sclera.k]!).position.slice()
        const cpos = cornea && this.inst[cornea.k]! >= 0 ? this.batches.partBuffers(this.inst[cornea.k]!).position.slice() : null
        fits.push(fitEye(side, pos, cpos))
        eyeParts.sclera.push(sclera.k)
      }
      this.eyeParts = eyeParts
      const eyes = new LookEyes(fits, this.eyeLook, this.skinning, this.skinGeometry.get(i)!, this.openings)
      this.lookEyes = eyes
      this.root.add(eyes.group)
      if (eyes.follower) this.addFollower(eyes.follower)
      else eyes.setSkinning(this.skinMode)
      this.eyesDirty = true
      this.syncNeeded = true
    }
    // 睑随注视要用表情数据 / the lid coupling needs the face data
    if (this.source === useApp.getState && this.lookEyes?.visible && !s.face) void useApp.getState().ensureFace()
  }

  /** 哪一侧有扫描的眼球部件被选中：那一侧画解剖部件、不画写实的眼 / Which sides have a scanned eyeball part selected: that side shows the anatomical parts, not the lifelike eye. */
  private eyeSidesSelected(s: ViewState): { L: boolean; R: boolean } {
    const sel = s.selection.set
    const parts = this.graph.parts
    return { L: this.eyeParts.L.some((k) => sel.has(parts[k]!.id)), R: this.eyeParts.R.some((k) => sel.has(parts[k]!.id)) }
  }

  /** 写实的眼要显示时，扫描的眼球部件不画（选中的那一侧除外）；它们仍在结构树里 / While the lifelike eyes show, the scanned eyeball parts are not drawn (except on a selected side); they stay in the tree. */
  private hideScannedEyes(s: ViewState): void {
    const i = this.mainSkinIndex()
    if (!this.lookEyes || !s.look || !this.lookSkin || i < 0 || i === this.skinIndex || this.display[i] !== NORMAL || !skinDrawnOpaque(s, this.mainSkin)) return
    const sel = this.eyeSidesSelected(s)
    for (const side of ['L', 'R'] as const) {
      if (sel[side]) continue
      for (const k of this.eyeParts[side]) this.display[k] = HIDDEN
    }
  }

  /** 推进注视（看相机或固定角度）；转动时重画 / Advance the gaze (camera or fixed angles); redraw while it turns. */
  private stepEyes(t: number): void {
    const eyes = this.lookEyes
    if (!eyes?.visible) {
      this.eyesT = 0
      return
    }
    const dt = this.eyesT ? Math.min(0.1, Math.max(0, (t - this.eyesT) / 1000)) : 0
    this.eyesT = t
    let skull: { rigid: M3; t: [number, number, number] } | null = null
    const k = this.eyeParts.sclera[0]
    if (this.skinMode !== 'off' && this.poseRt && this.batches && k !== undefined && this.inst[k]! >= 0) {
      // 头骨关节的行：取扫描巩膜第一个顶点的绑定 / the skull joint's row: the binding of the scanned sclera's first vertex
      const row = this.batches.partBuffers(this.inst[k]!).skinIndex[0]!
      eyes.setJointRow(row)
      const rigid = this.poseRt.frames.rigid[row], full = this.poseRt.frames.xfs[row]
      if (rigid && full) skull = { rigid: rigid.r as M3, t: full.t as [number, number, number] }
    }
    const s = this.source()
    // 眨眼和微扫视（blink=0 时没有）/ blinks and microsaccades (none with blink=0)
    const micro = eyes.advance(dt, s.blink)
    // 瞳孔：主视图按疼痛模型的瞳孔输出（刺激时）或持续的疼痛强度 / the pupil: in the main view, the pain model's pupil output (during a stimulus) or the sustained pain level
    const p = this.source === useApp.getState ? pupilTarget(useApp.getState()) : null
    const pupil = p ? eyes.life.stepPupil(p.direct ? 0 : dt, p.target) : eyes.life.stepPupil(dt, this.eyeLook.baseline)
    if (Math.abs(pupil - (this.eyeLook.pupil.value as number)) > 1e-7) {
      this.eyeLook.setPupil(pupil)
      this.dirty = true
    }
    const c = this.camera.position
    if (eyes.step(dt, [c.x, c.y, c.z], s.gaze, skull, micro)) this.dirty = true
  }

  /** 睑随注视：各眼此刻的垂直注视角（取到 0.5°，免得相机一动就重算皮肤）/ Lid coupling: each eye's current vertical gaze (to 0.5°, so the skin is not recomputed on every camera nudge). */
  private lidGaze(): { side: 'L' | 'R'; pitch: number; pupilDistance: number }[] | null {
    const eyes = this.lookEyes
    if (!eyes?.visible) return null
    return eyes.angles().map((a) => ({ side: a.side, pitch: Math.round(a.pitch * 2) / 2, pupilDistance: eyes.pupilDistance(a.side) }))
  }

  /** 睑通道的标定（每单位激活睑缘中点的竖直移动），按表情数据缓存 / The lid channels' calibration (vertical mid-margin travel per unit activation), cached per face data. */
  private lidGainsFor(face: LoadedFace): Record<string, number> {
    if (this.lidGainCache?.face === face) return this.lidGainCache.gains
    const i = this.mainSkinIndex()
    let gains: Record<string, number> = {}
    if (i >= 0 && this.openings && this.lookEyes && this.batches && this.mainSkin) {
      const rest = this.origOf(i, this.batches.partBuffers(this.inst[i]!)).position
      gains = lidGains(face, this.mainSkin, this.openings.margins, rest, this.lookEyes.eyes.map((e) => ({ side: e.fit.side, x: e.fit.centre[0] })))
    }
    this.lidGainCache = { face, gains }
    return gains
  }

  /** 写实的眼的状态（验证用）/ State of the lifelike eyes (verification). */
  eyesState(): { built: boolean; visible: boolean; fits: EyeFit[]; angles: { side: string; yaw: number; pitch: number }[] } {
    const e = this.lookEyes
    return { built: !!e, visible: !!e?.visible, fits: e ? e.eyes.map((x) => x.fit) : [], angles: e ? e.angles() : [] }
  }

  /**
   * 衣服：为已加载的衣服建预览层；穿着、皮肤没被剥掉 / 藏起 / 隔离时才显示（衣服是最外一层，剥层先剥它）。
   * Clothes: a preview layer for every loaded garment; shown while worn and the skin is not peeled, hidden or
   * isolated away (clothes are the outermost layer and peel first).
   */
  private syncClothes(s: ViewState): void {
    const i = this.mainSkinIndex()
    if (i < 0) return
    for (const c of s.clothes) {
      if (this.clothLayers.has(c)) continue
      const geo = this.skinGeometry.get(i)!
      if (c.data.skin !== this.mainSkin || !ClothLayer.fits(geo, c)) {
        console.warn(`[soma] garment ${c.data.garment} rejected: it is for ${c.data.skin} with ${c.data.skinVertexCount} vertices`)
        this.clothLayers.set(c, null)
        continue
      }
      const layer = new ClothLayer(geo, c, this.skinning)
      this.clothLayers.set(c, layer)
      this.addFollower(layer)
    }
    const skin = this.mainSkin ? this.graph.part(this.mainSkin) : undefined
    const skinShown = !!skin && (s.systems[skin.system]?.visible ?? true) && s.peel <= 0 && !s.hidden.has(skin.id) && !s.isolated
    for (const [c, layer] of this.clothLayers) {
      if (!layer) continue
      const show = skinShown && s.wear.includes(c.data.garment) && s.clothes.includes(c)
      if (layer.patch.mesh.visible !== show) {
        layer.patch.mesh.visible = show
        this.dirty = true
      }
    }
  }

  /** 写实外观是否正在显示：要了写实、有数据、皮肤画成不透明（不是体表图）/ Whether the lifelike look is showing: wanted, with data, and the skin drawn opaque (not as a skin map). */
  private lookShowing(): boolean {
    const i = this.mainSkinIndex()
    return !!this.lookSkin && this.lookWanted && i >= 0 && i !== this.skinIndex && this.display[i] === NORMAL && this.solid[i] === 1
  }

  /** 写实皮肤层、光照环境和皱纹层的材质跟着 lookShowing() 走 / The lifelike layer, the lighting environment and the wrinkle layer's material follow lookShowing(). */
  private updateLook(): void {
    const show = this.lookShowing()
    if (this.lookSkin && this.lookSkin.patch.mesh.visible !== show) {
      this.lookSkin.patch.mesh.visible = show
      this.dirty = true
    }
    if (this.lookEnv.set(show)) this.dirty = true
    if (this.lookEyes) {
      const sel = this.eyeSidesSelected(this.source())
      if (this.lookEyes.setVisible(show, { L: !sel.L, R: !sel.R })) this.dirty = true
    }
    if (show && !this.lookUvPerSkin && this.appliedSkinUv) this.lookUvPerSkin = LookSkin.uvPerSkinVertex(this.appliedSkinUv)
    this.detailLayer?.useLook(show ? this.skinLook : null, show ? this.lookUvPerSkin : null)
    this.syncHair(show)
  }

  /** 毛发层：写实外观第一次显示时才建（数据随后才取）/ The hair layer: built the first time the lifelike look shows (its data are fetched after that). */
  private syncHair(show: boolean): void {
    if (!show && !this.hair) return
    const i = this.mainSkinIndex()
    if (i < 0) return
    const s = this.source()
    if (!this.hair) {
      const base = new URL('hair/', new URL(this.baseUrl, location.href)).href
      this.hair = new HairLayer(base, this.skinGeometry.get(i)!, this.skinning, () => this.hairChanged(), this.backend === 'webgpu')
      this.addFollower(this.hair)
    }
    this.hair.set({ show, style: s.hairStyle, colour: s.hairColor })
  }

  /** 毛发层有变化：重画；它替代的外壳变了就重算显示 / The hair layer changed: redraw; if the shells it replaces changed, recompute the display. */
  private hairChanged(): void {
    this.dirty = true
    const covers = this.hair?.covers().join() ?? ''
    if (covers !== this.hairCovers) {
      this.hairCovers = covers
      this.hairDirty = true
      this.syncNeeded = true
    }
  }

  /** 皮肤不透明时藏的部件，加上毛发正在替代的外壳 / The parts hidden under an opaque skin, plus the shells the hair currently replaces. */
  private withHairCovers(set: ReadonlySet<string>): ReadonlySet<string> {
    if (!this.hairCovers) return set
    const h = this.hideWithHair
    if (h && h.from === set && h.covers === this.hairCovers) return h.set
    const out = new Set([...set, ...this.hairCovers.split(',')])
    this.hideWithHair = { from: set, covers: this.hairCovers, set: out }
    return out
  }

  /** 毛发层的状态（验证用）/ State of the hair layer (verification). */
  hairState(): ReturnType<HairLayer['info']> | null {
    return this.hair?.info() ?? null
  }

  /** 按当前表情设各层权重；只有皮肤画成不透明（且不是体表图）时才显示 / Set the layer weights from the current expression; shown only while the skin is drawn opaque (and not as a skin map). */
  private updateDetail(): void {
    this.updateLook()
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
    this.updateDent()
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
    this.updateDent()
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
        this.updateDent()
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
          // 静止时只有皮肤可能被体型 / 表情改写 / at rest only the skin can have been rewritten by shape or expression
          const p = posed ? posed.positions(i) : i === skin ? batches.partBuffers(this.inst[i]!).position : null
          return p && i === skin ? this.undent(p) : p
        },
        this.pathBuf,
      )
      pv.setLine(this.pathBuf)
    }
    pv.setMarkers(this.stimMarkers.fast, this.stimMarkers.slow, this.camera)
  }

  /**
   * 按压凹陷的细分网格显示着时，它盖住的皮肤顶点为显示向里收了（可达 3 cm）；通路和部位标记绑在这些顶点上，
   * 所以这里把它们放回凹陷的表面。静止时精确；摆姿势时修正量按静止空间加上，没有随骨转动（近似）。
   * While a press's subdivided dent mesh is shown, the skin vertices it covers are drawn inward (by up to 3 cm); the
   * pathway and the site marker are bound to those vertices, so here they are put back on the dented surface. Exact at
   * rest; in a pose the correction is added in rest space without turning with the bones (an approximation).
   */
  private undent(p: Float32Array): Float32Array {
    const d = this.dentShown ? this.dentData : null
    const soft = this.softOffset
    if (!d || !soft || soft.length !== p.length) return p
    const out = p.slice()
    for (let k = 0; k < d.hidden.length; k++) for (let r = 0; r < 3; r++) {
      const q = d.hidden[k]! * 3 + r
      out[q] = out[q]! + soft[q]! - d.hideOffsets[k * 3 + r]!
    }
    return out
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
    // 显示肌肉活动时，静止姿势也走蒙皮分支（站着不动小腿也在用力，肌腹要能变粗）
    // with muscle activity shown, the rest pose takes the skinning branch too (standing still loads the calf, whose belly must be able to thicken)
    const activity = rt ? this.activityLayer : null
    const active = !!rt && (!poseIsRest(pose) || !scalesAreIdentity(this.poseScales) || !!activity?.wanted())
    if (rt && active) {
      const d = rt.set(pose, this.poseScales)
      this.skinning.update(d.joints, d.muscles, d.via)
      this.prewarmNext = 0
    }
    if (rt && activity) {
      const changed = activity.update(pose, rt.frames)
      this.skinning.updateBulge(activity.bulge)
      if (changed.length) {
        const s = this.source()
        for (const i of changed) this.applyPart(i, this.graph.parts[i]!, s)
      }
      // 求解没收敛：下一帧接着算 / the solve did not converge: continue on the next frame
      if (activity.pending) this.poseDirty = true
    }
    // 对照窗格的相机由主视图带着走，自己不再跟一次 / the compare pane's camera is driven by the main view and does not follow a second time
    if (rt && this.poseScales !== this.framedScales && this.source === useApp.getState) this.followShape(rt)
    const mode: SkinningMode = !active ? 'off' : scalesAreIdentity(this.poseScales) ? 'pose' : 'pose+shape'
    if (mode !== this.skinMode) {
      this.skinMode = mode
      this.batches?.setSkinning(mode)
      this.skinLayer?.setSkinning(mode)
      this.lumenLayer?.setSkinning(mode)
      for (const f of this.followers) f.setSkinning(mode)
      this.dentPatch?.setSkinning(mode)
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

  /**
   * 姿势面板（含过渡中的值）和退缩反射给下颌的张开角，弧度，不含表情和说话加上去的那部分；没有绑定时为 0。
   * The jaw opening that the pose panel (its value in transition included) and the withdrawal reflex give, radians, without the
   * part added by expression and speech; 0 without a rig.
   */
  private jawBase(face: LoadedFace): number {
    const rt = this.poseRt
    if (!rt) return 0
    const { joint, dof, max } = face.data.jaw
    let v = this.poseTarget[joint]?.[dof] ?? 0
    if (this.poseTween) {
      const k = Math.min(1, (performance.now() - this.poseTween.t0) / this.poseTween.ms)
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
      const from = this.poseTween.from[joint]?.[dof] ?? 0, to = this.poseTween.to[joint]?.[dof] ?? 0
      v = from + (to - from) * e
    }
    if (this.reflexKey !== '{}') v += this.reflexPose[joint]?.[dof] ?? 0
    return Math.min(max, Math.max(0, v))
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
      this.faceChannels = {}
      this.faceJaw = 0
      this.faceForce = true
    }
    if (this.stepShape(s)) this.faceForce = true
    const face = this.appliedFace
    if (!batches) return false
    // 疼痛、情绪、说话合成后的通道激活和下颌角（src/face/driver.ts）；对照窗格用它自己那副身体的数据
    // channel activations and jaw angle with pain, emotion and speech composed (src/face/driver.ts); a compare pane uses its own body's data
    // 下颌已经被姿势面板或反射张开多少：闭唇的口形按总的下颌角合唇（见 blendFace 的 baseJaw）
    // how far the pose panel or a reflex has already opened the jaw: a lip closure seals for the total jaw angle (baseJaw of blendFace)
    const frame = faceFrame(t, face?.data ?? null, face ? this.jawBase(face) : 0)
    const act = { channels: { ...frame.channels }, jaw: frame.jaw }
    // 口角通道（皮肤有真实口裂时才有）：激活 = 下颌张开角 ÷ 最大角，不管下颌是怎么张开的
    // （表情、发声、姿势面板、反射）；否则只靠关节张口时口裂两端是竖直的，嘴成了方的。
    // the mouth-corner channel (present when the skin has a real oral fissure): activation = jaw opening ÷ its
    // maximum, however the jaw came to open (expression, voice, pose panel, reflex); otherwise, opened by the
    // joint alone, the fissure has vertical ends and the mouth goes square.
    const corner = face ? this.cornerChannel(face) : null
    let cornerNow = 0
    if (face && corner) {
      const { joint, dof, max } = face.data.jaw
      const shown = Math.max(this.displayPose[joint]?.[dof] ?? 0, (this.poseTarget[joint]?.[dof] ?? 0) + act.jaw)
      cornerNow = Math.min(1, Math.max(0, shown / Math.max(1e-6, max)))
      if (cornerNow > 0) act.channels[corner] = Math.max(act.channels[corner] ?? 0, cornerNow)
    }
    // 写实的眼转动时，上下睑跟着垂直注视走（src/face/driver.ts 的 lidGazeChannels）/ while the lifelike eyes turn, the lids follow vertical gaze (lidGazeChannels of src/face/driver.ts)
    const lids = face ? this.lidGaze() : null
    if (face && lids) addLidGaze(act.channels, lidGazeChannels(face.data, lids, this.lidGainsFor(face)))
    // 自发眨眼：与表情的闭眼通道逐项取较大者 / spontaneous blinks: merged with the expression's lid-closing channels by maximum
    if (face && lids && this.lookEyes) addBlink(act.channels, face.data, this.lookEyes.blink)
    // "差不多相同"不能挡住最后一步：表情已经完全放松而上次应用的还剩一点点时，必须真的归零，
    // 否则顶点留着亚微米的位移、姿势模式也回不到静止
    // "near enough" must not swallow the last step: when the expression has fully relaxed but a trace is
    // still applied, it has to go to exactly zero, or sub-micron displacements linger and the posed mode never ends
    const settled = (Object.keys(act.channels).length > 0 || Object.keys(this.faceChannels).length === 0) && (act.jaw > 0 || this.faceJaw === 0)
    // 通道激活 0–1：差 4e-4 相当于 AU 强度差 2e-3 / channel activations are 0–1: 4e-4 there is what 2e-3 is on an AU intensity
    if (!this.faceForce && this.restDirty.size === 0 && settled && sameAUs(act.channels, this.faceChannels, 4e-4) && Math.abs(act.jaw - this.faceJaw) < 1e-4 && Math.abs(cornerNow - this.cornerApplied) < 1e-3) {
      // 通道已经封顶而 AU 还在走（例如强度超过通道饱和点）：皱纹层的权重仍要跟上
      // channels can be saturated while the AUs still move (an intensity beyond a channel's ceiling): the wrinkle weights still follow
      if (!sameAUs(frame.aus, this.faceAUs, 1e-4)) {
        this.faceAUs = frame.aus
        this.updateDetail()
        this.dirty = true
      }
      return frame.animating
    }
    this.faceForce = false
    this.faceAUs = frame.aus
    this.faceChannels = act.channels
    const todo = new Set(this.restDirty)
    this.restDirty.clear()
    const part0 = this.followers.length ? this.mainSkinIndex() : -1
    const activeParts = new Set<number>()
    if (face) {
      for (const [partId, fields] of face.fields) {
        const i = this.graph.indexOf(partId)
        if (i < 0 || this.inst[i]! < 0) continue
        const active = fields.some((f) => (act.channels[f.channel] ?? 0) > 0) || lidDropActive(fields, act.channels)
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
      if (facing) {
        displacePart(face!, partId, base, act.channels, buf.position)
        // 下睑随向下注视下移：反过来用的下睑场（src/face/driver.ts 的 applyLidDrop）/ the lower lid dropping with down-gaze: the lower-lid field run backwards (applyLidDrop of src/face/driver.ts)
        applyLidDrop(face!, partId, act.channels, buf.position)
      }
      else buf.position.set(base)
      if (facing) this.faceDisplaced.add(i)
      else this.faceDisplaced.delete(i)
      // 软组织物理的位移（按压的凹陷、体位的下垂）叠在体型和表情之上 / the soft-tissue displacement (a press's dent, a posture's sag) on top of shape and expression
      const own = i === this.mainSkinIndex() ? this.softOffset : this.softParts.get(i) ?? null
      const soft = own && own.length === buf.position.length ? own : null
      if (soft) for (let k = 0; k < soft.length; k++) buf.position[k] = buf.position[k]! + soft[k]!
      // 凹陷的细分网格显示着：它盖住的皮肤顶点改用它给的位移（向里收）/ the dent's subdivided mesh is shown: the skin vertices it covers take its displacement instead (drawn inward)
      const dent = soft && soft === this.softOffset && this.dentShown ? this.dentData : null
      if (dent) for (let k = 0; k < dent.hidden.length; k++) for (let r = 0; r < 3; r++) buf.position[dent.hidden[k]! * 3 + r] = buf.position[dent.hidden[k]! * 3 + r]! - soft![dent.hidden[k]! * 3 + r]! + dent.hideOffsets[k * 3 + r]!
      const displaced = facing || this.shaped.has(i) || !!soft
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
    this.cornerApplied = cornerNow
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
  faceState(): { aus: AUs; channels: Activations; jaw: number; parts: number; loaded: boolean } {
    return { aus: this.faceAUs, channels: this.faceChannels, jaw: this.faceJaw, parts: this.faceDisplaced.size, loaded: !!this.appliedFace }
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
  /** 部件的原始静止几何（未经体型、表情改写）和部件内的下标；没有几何时为 null / A part's original rest geometry (before shape or expression rewrote it) with part-local indices; null without geometry. */
  restGeometry(partId: string): { positions: Float32Array; indices: Uint32Array } | null {
    const i = this.graph.indexOf(partId)
    const id = i >= 0 ? this.inst[i]! : -1
    if (id < 0 || !this.batches) return null
    const buf = this.batches.partBuffers(id)
    const indices = new Uint32Array(buf.index.length)
    for (let k = 0; k < indices.length; k++) indices[k] = buf.index[k]! - buf.indexBase
    return { positions: new Float32Array(this.restOrig.get(i)?.position ?? buf.position), indices }
  }

  /** 软组织物理：主皮肤的静止空间位移（米，按顶点；null 清除）/ Soft-tissue physics: the main skin's rest-space displacement (metres, per vertex; null clears). */
  setSkinOffset(offset: Float32Array | null, dent: DentPatchData | null = null, parts: ReadonlyMap<string, Float32Array> | null = null): void {
    if (!offset && !this.softOffset && !dent && !this.dentData && !parts?.size && !this.softParts.size) return
    this.softOffset = offset
    this.dentData = offset ? dent : null
    // 其他部件（皮肤的其他片、皮下脂肪）：旧的和新的都要重写 / other parts (other skin pieces, subcutaneous fat): old and new ones are rewritten
    for (const k of this.softParts.keys()) this.restDirty.add(k)
    this.softParts.clear()
    for (const [id, o] of parts ?? []) {
      const k = this.graph.indexOf(id)
      if (k < 0) continue
      this.softParts.set(k, o)
      this.restDirty.add(k)
    }
    const i = this.mainSkinIndex()
    if (i >= 0) this.restDirty.add(i)
    if (this.dentData && i >= 0 && this.batches) {
      if (!this.dentPatch) {
        this.dentPatch = new DentPatch(this.skinning, this.baseColor[i]!.clone())
        this.dentPatch.setSkinning(this.skinMode)
        this.root.add(this.dentPatch.group)
      }
      const b = this.batches.partBuffers(this.inst[i]!)
      this.dentPatch.set(this.dentData, b.skinIndex, b.skinWeight)
      this.dentPatch.setInfluences(this.dentData, b.skinIndex, b.skinWeight)
    }
    this.updateDent()
    this.dirty = true
  }

  /** 软组织物理：主皮肤按位移着色（每个顶点 rgba；null 关闭）/ Soft-tissue physics: colours the main skin by displacement (rgba per vertex; null turns it off). */
  setSkinColors(rgba: Float32Array | null): void {
    const i = this.mainSkinIndex()
    const fits = !!rgba && i >= 0 && rgba.length * 3 === this.skinGeometry.get(i)!.position.length * 4
    if (!this.dispOverlay && fits) {
      this.dispOverlay = new DisplacementOverlay(this.skinGeometry.get(i)!, this.skinning)
      this.addFollower(this.dispOverlay)
    }
    this.dispOverlay?.setColors(fits ? rgba : null)
    this.dispOn = fits
    this.updateDent()
    this.dirty = true
  }

  /** 凹陷网格的可见性：有数据、皮肤显示着并且不透明（与口腔袋同一条规则）/ The dent mesh's visibility: data present and the skin shown and opaque (the oral pouch's rule). */
  private updateDent(): void {
    const i = this.mainSkinIndex()
    const show = !!this.dentData && !!this.dentPatch && i >= 0 && this.display[i] === NORMAL && (i === this.skinIndex ? this.skinPickable : this.solid[i] === 1)
    if (this.dentPatch && i >= 0) this.dentPatch.setOffset(this.offsets[i * 3]!, this.offsets[i * 3 + 1]!, this.offsets[i * 3 + 2]!)
    // 位移着色层只在皮肤显示着时画 / the displacement colour layer is drawn only while the skin is shown
    if (this.dispOverlay) this.dispOverlay.patch.mesh.visible = this.dispOn && i >= 0 && this.display[i] === NORMAL
    // 疼痛分布层在它盖住的地方由它接着画 / where it covers the skin, it carries the pain-map layer on
    if (this.dentPatch && this.dentData) this.dentPatch.setOverlay(this.painOverlay?.patch.mesh.visible ? this.painOverlay.material : null, this.painOverlay?.weights ?? null, this.dentData)
    if (show === this.dentShown) return
    this.dentShown = show
    if (this.dentPatch) this.dentPatch.group.visible = show
    if (i >= 0) this.restDirty.add(i)
    this.dirty = true
  }

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
          : (partLook(part.name)?.color ?? TISSUE_COLOR[part.tissue] ?? systemColor.get(part.system) ?? '#9aa3ad')
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
    let opacity = (this.lookOpacity[i] ?? TISSUE_OPACITY[part.tissue] ?? 1) * (s.systems[part.system]?.opacity ?? 1)
    if (s.colorMode === 'source' && TISSUE_OPACITY[part.tissue] !== undefined) opacity = Math.min(1, opacity * 1.6)
    // 看表情时把皮肤画成不透明 / the skin is drawn opaque to read the expression
    if (s.skinOpaque && part.id === this.mainSkin) opacity = 1
    // 眉毛跟着皮肤：它只比皮肤高出零点几毫米，按皮肤组织的默认透明度（0.14）画在不透明的皮肤上就几乎看不见
    // the eyebrows follow the skin: they stand only a fraction of a millimetre proud of it, and at the skin tissue's default opacity (0.14) over an opaque skin they all but vanish
    if (s.skinOpaque && this.brows.has(part.id)) opacity = 1
    // 冲动沿神经传上去的那一小段时间里，皮肤让开 / while the volley travels up the nerve, the skin steps aside
    if (this.stimSee && part.id === this.mainSkin) opacity = Math.min(opacity, 0.22)
    // 腔：用它自己的颜色画成不透明（它只在该看的时候才显示）；"腔"模式下壁画成半透明，剖切时除外（切口本身就露出腔）
    // a lumen is drawn opaque in its own colour (it only shows when it is meant to be looked at); in the lumina mode walls go see-through, except under a section (the cut shows the lumen anyway)
    const lumenColor = this.lumenColor.get(i)
    if (lumenColor && (this.lumenHide.has(i) || this.lumenWallsOn)) opacity = 1
    else if (this.lumenWallsOn && this.lumenWalls.has(i) && !s.section.enabled) opacity = Math.min(opacity, LUMEN_COLOR.wallOpacity)
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
    if (d === NORMAL && this.lumenLayerOn && this.lumenLayer?.has(i)) {
      // "腔"图层来画；部件自己的几何仍用于拾取 / the lumina layer draws it; the part's own geometry still serves picking
      batches.setState(id, MODE_HIDDEN, 0, 0, 0, 0)
      const c = this.tmpColor.copy(lumenColor ?? this.baseColor[i]!)
      if (selected) c.lerp(ACCENT_RGB, 0.6)
      else if (s.hover === part.id) c.lerp(WHITE, 0.32)
      this.lumenLayer.setColor(i, c.r, c.g, c.b)
      this.solid[i] = 0
    } else if (d === HIDDEN) {
      batches.setState(id, MODE_HIDDEN, 0, 0, 0, 0)
    } else if (d === GHOST) {
      batches.setState(id, MODE_BLEND, GHOST_RGB.r, GHOST_RGB.g, GHOST_RGB.b, GHOST_OPACITY)
    } else {
      // 肌肉活动的颜色取代肌肉的底色；选中、悬停的提示照常叠在上面 / the muscle-activity colour replaces the muscle's base colour; selection and hover tints go on top as usual
      const c = this.tmpColor.copy(this.activityLayer?.tint.get(i) ?? (lumenColor && (this.lumenHide.has(i) || this.lumenWallsOn) ? lumenColor : this.baseColor[i]!))
      if (selected) c.lerp(ACCENT_RGB, 0.6)
      else if (inPath) c.lerp(PATH_RGB, 0.8)
      else if (s.hover === part.id) c.lerp(WHITE, 0.32)
      batches.setState(id, opacity >= 0.999 ? MODE_OPAQUE : MODE_BLEND, c.r, c.g, c.b, opacity)
    }
    // 被选中的部件还会透过遮挡物画一层淡淡的颜色
    // selected parts also get a faint tint drawn through whatever covers them
    batches.setXray(id, d !== HIDDEN && ((selected && s.selection.ids.length <= XRAY_MAX) || inPath))
  }

  // ------------------------------------------------------------ 腔 / lumina

  /**
   * 把"腔"的状态同步到场景：按需取数据，定出哪些部件是腔、哪些是壁，状态变了就让显示重算。只在主视图上。
   * Mirror the lumina state into the scene: fetch the data when needed, settle which parts are lumina and
   * which are walls, and have the display recomputed when the state changed. Main view only.
   */
  private syncLumen(s: ViewState): LumenState {
    const L = useLumen.getState()
    const p = this.lumenPrev
    this.lumenPrev = L
    if (!p || p.mode !== L.mode || !p.fly !== !L.fly || p.data !== L.data) this.lumenDirty = true
    // 数据：打开模式、漫游、动过充盈，或者有腔部件要显示（被选中、被隔离、系统调成半透明）时才取
    // the data is fetched once the mode or the fly-through is on, the filling was touched, or a lumen part is to be shown (selected, isolated, its system made see-through)
    if (!this.lumenRequested) {
      let want = L.mode || !!L.fly || L.fill > 0 || Object.keys(L.overrides).length > 0 || this.lumenHide.size === 0
      if (!want) for (const i of this.lumenHide) if (this.lumenShownByUser(i, s)) want = true
      if (want) {
        this.lumenRequested = true
        const token = this.bodyToken
        void ensureLumenData(this.graph, useApp.getState().dataset, this.baseUrl).then((data) => {
          if (this.disposed || token !== this.bodyToken) return
          this.setLumenData(data)
        })
      }
    }
    const wallsOn = L.mode || !!L.fly
    if (wallsOn && this.lumenLayerStale) this.lumenDirty = true
    if (wallsOn !== this.lumenWallsOn) {
      this.lumenWallsOn = wallsOn
      this.lumenDirty = true
    }
    return L
  }

  private setLumenData(data: LumenData | null): void {
    this.lumenData = data
    const idx = (id: string): number => this.graph.indexOf(id)
    this.lumenWalls = new Set()
    this.lumenAll = new Set()
    this.lumenColor = new Map()
    if (data) {
      this.lumenHide = new Set(data.derived.map(idx).filter((i) => i >= 0))
      for (const id of [...data.derived, ...data.real]) {
        const i = idx(id)
        if (i < 0) continue
        this.lumenAll.add(i)
        const kind = data.origin.get(id)?.kind
        this.lumenColor.set(i, new Color(kind === ORIGIN_CONSTRUCTION ? LUMEN_COLOR.construction : kind === ORIGIN_MIXED ? LUMEN_COLOR.mixed : kind === ORIGIN_BOUNDED ? LUMEN_COLOR.bounded : LUMEN_COLOR.derived))
      }
      for (const id of data.walls) if (idx(id) >= 0) this.lumenWalls.add(idx(id))
      if (!data.path && data.real.length) {
        // 没有壁的清单（女性现在如此）：腔所在系统里的器官都当作壁 / no wall list (the female at present): the organs of the lumina's systems count as walls
        const systems = new Set(data.real.map((id) => this.graph.part(id)!.system))
        this.graph.parts.forEach((part, i) => {
          if (systems.has(part.system) && part.tissue === 'organ') this.lumenWalls.add(i)
        })
      }
    }
    this.lumenApplied = new Map()
    this.lumenLayerStale = true
    this.lumenDirty = true
    this.syncNeeded = true
    this.dirty = true
    // 链接要求"只看消化道"：数据到了才知道是哪些部件 / a link asked for the canal alone: which parts that is, is known only now
    if (data && useLumen.getState().canalPending) showCanal(this.graph, data)
  }

  /** 用户自己要看这个腔：选中了它、隔离了它，或者把它所在的系统调成了半透明 / The user asked to see this lumen: selected it, isolated it, or made its system see-through. */
  private lumenShownByUser(i: number, s: ViewState): boolean {
    const part = this.graph.parts[i]!
    if (s.selection.set.has(part.id) || s.isolated?.has(part.id)) return true
    return !s.isolated && (s.systems[part.system]?.opacity ?? 1) < 0.999
  }

  /**
   * 腔的默认可见性：壁不透明时它在壁里面，画了也看不见，只添绘制量和深度冲突，所以藏起来；打开"腔"模式、
   * 把系统调成半透明、或者选中 / 隔离它时才显示。在 computeDisplay 之后调用。
   * Default visibility of the lumina: inside an opaque wall a lumen cannot be seen and only adds draws and
   * depth fighting, so it is hidden; it shows with the lumina mode on, with its system made see-through, or
   * when selected or isolated. Called after computeDisplay.
   */
  private applyLumenDisplay(s: ViewState, L: LumenState | null): void {
    const on = !!L && (L.mode || !!L.fly)
    for (const i of this.lumenHide) {
      if (this.display[i] === HIDDEN || on) continue
      if (!this.lumenShownByUser(i, s)) this.display[i] = HIDDEN
    }
    // 漫游时不画壁：从腔里面本来就看不到壁，而每片器官的网格两端是封住的，封盖会像隔膜一样横在腔里
    // no walls in the fly-through: from inside the lumen they cannot be seen anyway, and every organ piece is a mesh closed at both ends, whose caps would lie across the lumen like septa
    if (L?.fly) for (const i of this.lumenWalls) if (!s.selection.set.has(this.graph.parts[i]!.id)) this.display[i] = HIDDEN
  }

  /** "腔"图层的有无和内容：模式开着、没有爆炸位移时由它来画腔 / Whether the lumina layer is in use and what it draws: with the mode on and no explode offsets it draws the lumina. */
  private updateLumenLayer(s: ViewState): void {
    const batches = this.batches
    const want = this.lumenWallsOn && !!this.lumenData && !!batches && s.explode === 0 && this.source === useApp.getState
    if (want && batches && (!this.lumenLayer || this.lumenLayerStale)) {
      this.lumenLayerStale = false
      const parts = [...this.lumenAll].filter((i) => this.inst[i]! >= 0).sort((a, b) => a - b)
      if (!this.lumenLayer || this.lumenLayer.parts.join(',') !== parts.join(',') || this.appliedRig) {
        if (this.lumenLayer) {
          this.root.remove(this.lumenLayer.mesh)
          this.lumenLayer.dispose()
        }
        this.lumenLayer = parts.length ? new LumenLayer(this.skinning, parts.map((i) => ({ part: i, buffers: batches.partBuffers(this.inst[i]!) }))) : null
        if (this.lumenLayer) {
          this.lumenLayer.setSkinning(this.skinMode)
          this.root.add(this.lumenLayer.mesh)
        }
      }
    }
    const on = want && !!this.lumenLayer
    if (on !== this.lumenLayerOn) {
      // 交接：腔部件改由图层（或改回由部件自己）来画 / hand-over: the lumen parts go to the layer (or back to their own draws)
      this.lumenLayerOn = on
      for (const i of this.lumenAll) this.applyPart(i, this.graph.parts[i]!, s)
    } else if (on) for (const i of this.lumenLayer!.parts) if (this.display[i] === NORMAL) this.applyPart(i, this.graph.parts[i]!, s)
    this.lumenLayer?.setShown(on ? this.lumenLayer.parts.filter((i) => this.display[i] === NORMAL) : [])
    this.dirty = true
  }

  /** 腔部件的顶点圈（按连接关系分出来，缓存）；不是成圈结构时为 null / A lumen part's rings (from connectivity, cached); null when it is not built of rings. */
  private ringsFor(i: number, buf: PartBuffers): RingMesh | null {
    let r = this.lumenRings.get(i)
    if (r === undefined) this.lumenRings.set(i, (r = ringsOf(buf.index, buf.position.length / 3, buf.indexBase)))
    return r
  }

  /**
   * 充盈：position(f) = GLB 位置 + (f − rest)·D，在蒙皮之前写进顶点缓冲，所以和姿势叠加。改写过的部件重算
   * 法线（按面积加权，和表情那条路一样）和包围盒，建在旧几何上的拾取结构作废。漫游时消化道各段的充盈度
   * 不低于 FLY_MIN_FILL，仍然太窄的圈再撑开到 FLY_MIN_RADIUS（只为看得见）。
   * Filling: position(f) = GLB position + (f − rest)·D, written into the vertex buffers before skinning, so
   * it composes with poses. Rewritten parts get recomputed normals (area-weighted, as on the expression path)
   * and bounds, and pick structures on the old geometry are dropped. In the fly-through the canal's segments
   * are filled to at least FLY_MIN_FILL, and rings still too narrow are widened to FLY_MIN_RADIUS (only so
   * that they can be seen).
   */
  private stepLumen(): void {
    const data = this.lumenData
    const batches = this.batches
    if (!data || !batches || data.entries.size === 0) return
    const L = useLumen.getState()
    const canal = L.fly && data.path ? new Set(data.path.canal) : null
    let changed = false
    for (const [partId, entry] of data.entries) {
      const i = this.graph.indexOf(partId)
      const id = i >= 0 ? this.inst[i]! : -1
      if (id < 0) continue
      const buf = batches.partBuffers(id)
      if (buf.position.length !== entry.vertices * 3) {
        if (!this.lumenApplied.has(i)) {
          console.warn(`[soma] lumen filling ignored: ${partId} has ${buf.position.length / 3} vertices, lumen-filling.json says ${entry.vertices}`)
          this.lumenApplied.set(i, 'mismatch')
        }
        continue
      }
      const widen = !!canal?.has(partId)
      const f = widen ? Math.max(fillingOf(L, entry), FLY_MIN_FILL) : fillingOf(L, entry)
      const key = `${f}:${widen ? 1 : 0}`
      if (this.lumenApplied.get(i) === key) continue
      const first = !this.lumenApplied.has(i)
      this.lumenApplied.set(i, key)
      const orig = this.origOf(i, buf)
      if (first) registerLumenGeometry(partId, orig.position, Uint32Array.from(buf.index, (v) => v - buf.indexBase))
      const rings = widen ? this.ringsFor(i, buf) : null
      if (f === entry.rest && !rings) {
        if (first) continue
        buf.position.set(orig.position)
        buf.normal.set(orig.normal)
        this.boxOverride.delete(i)
      } else {
        applyFilling(orig.position, displacementOf(data, partId)!, f, entry.rest, buf.position)
        if (rings) widenRings(buf.position, rings.rings, FLY_MIN_RADIUS)
        recomputeNormals(buf.position, buf.index, buf.indexBase, buf.normal)
        this.boxOverride.set(i, boundsOf(buf.position))
      }
      batches.markPositions(id)
      this.lumenLayer?.setPositions(i, buf.position, buf.normal)
      if (this.bvh[i]) {
        this.bvh[i] = null
        this.bvhBuilt = Math.max(0, this.bvhBuilt - 1)
      }
      changed = true
    }
    if (changed) {
      this.poseRt?.invalidate()
      this.restVersion++
      this.lumenVersion++
      this.prewarmNext = 0
      this.dirty = true
    }
  }

  /** 漫游路径：各段的圈心连起来（摆了姿势就用变形后的顶点），口腔和咽用引导线 / The fly-through path: ring centres of every segment joined (posed vertices when posed), guide lines for mouth and pharynx. */
  private buildFlyPath(): CanalPath | null {
    const data = this.lumenData
    const batches = this.batches
    if (!data?.path || !batches) return null
    const inputs: PathSegmentInput[] = []
    for (const partId of data.path.canal) {
      const i = this.graph.indexOf(partId)
      const id = i >= 0 ? this.inst[i]! : -1
      if (id < 0) return null // 几何还没到齐 / geometry not all here yet
      const buf = batches.partBuffers(id)
      const posed = this.posed && this.poseRt ? this.poseRt.positions(i) : null
      const position = posed ?? buf.position
      const guide = data.path.guides[partId]
      if (guide) {
        // 引导线在静止空间里；摆了姿势时，每个点跟着离它最近的那个顶点走
        // the guide is in rest space; when posed each point moves with the vertex nearest to it
        inputs.push({
          id: partId,
          guide: guide.map((g) => {
            const q: V3 = [g[0] / 1000, g[1] / 1000, g[2] / 1000]
            if (!posed) return q
            let best = Infinity
            let at = 0
            for (let v = 0; v < buf.position.length; v += 3) {
              const d = (buf.position[v]! - q[0]) ** 2 + (buf.position[v + 1]! - q[1]) ** 2 + (buf.position[v + 2]! - q[2]) ** 2
              if (d < best) {
                best = d
                at = v
              }
            }
            return [q[0] + posed[at]! - buf.position[at]!, q[1] + posed[at + 1]! - buf.position[at + 1]!, q[2] + posed[at + 2]! - buf.position[at + 2]!]
          }),
        })
        continue
      }
      const rings = this.ringsFor(i, buf)
      if (!rings) continue
      inputs.push({ id: partId, stations: ringStations(rings.rings, position), poleStart: rings.poleStart !== null, poleEnd: rings.poleEnd !== null })
    }
    return buildCanalPath(inputs)
  }

  private endFly(): void {
    const fly = this.fly
    if (!fly) return
    this.fly = null
    this.camera.fov = fly.saved.fov
    this.camera.near = fly.saved.near
    this.camera.far = fly.saved.far
    this.camera.up.set(0, 1, 0)
    this.camera.updateProjectionMatrix()
    this.camera.position.copy(fly.saved.position)
    this.controls.target.copy(fly.saved.target)
    this.controls.enabled = true
    this.controls.update()
    this.dirty = true
  }

  /**
   * 内镜漫游：相机沿消化道的中心线在腔里面走，朝前看。视角 80°、近平面 0.4 毫米（食管只有约 4 毫米宽）。
   * 位置取前后各 2 毫米的平均、视线指向前方 8 毫米处，所以拐角被抹圆了一些。
   * The fly-through: the camera travels inside the lumen along the canal's centreline, looking forward.
   * Field of view 80°, near plane 0.4 mm (the oesophagus is only about 4 mm wide). The position averages
   * 2 mm either side and the view aims 8 mm ahead, which rounds the corners a little.
   */
  private stepFly(t: number): void {
    const L = useLumen.getState()
    if (!L.fly || !this.lumenData?.path) {
      if (this.fly) this.endFly()
      return
    }
    if (!this.fly) {
      this.tween = null
      this.fly = {
        path: null,
        key: '',
        s: 0,
        lastT: 0,
        seekNonce: L.seek.nonce,
        started: false,
        reported: 0,
        up: new Vector3(0, 0, 1),
        saved: { position: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov, near: this.camera.near, far: this.camera.far },
      }
      this.controls.enabled = false
      this.camera.fov = 80
      this.camera.near = 0.0004
      this.camera.far = 4
      this.camera.updateProjectionMatrix()
    }
    const fly = this.fly
    const key = `${this.lumenVersion}:${this.posed && this.poseRt ? this.poseRt.version : -1}:${this.attachedObjects}`
    if (key !== fly.key || !fly.path) {
      const length = fly.path?.length
      fly.key = key
      fly.path = this.buildFlyPath()
      this.dirty = true
      // 路径变长或变短时（充盈改了圈心）按比例留在原处 / when the path changes length (filling moves ring centres) keep the place proportionally
      if (fly.path && length) fly.s *= fly.path.length / length
    }
    const path = fly.path
    if (!path) return
    const segId = (k: number): string => path.segments[k]!.id
    if (!fly.started) {
      fly.started = true
      const at = L.flyStart
      if (typeof at === 'number') fly.s = at / 1000
      else if (at) {
        const id = segmentIds(this.graph, this.lumenData).get(at.toLowerCase().replace(/^oesophagus$/, 'esophagus')) ?? at
        const seg = path.segments.find((x) => x.id === id)
        if (seg) fly.s = seg.start + seg.bridged
        else console.warn(`[soma] URL: fly: 没有这一段 / no such segment "${at}"`)
      }
    }
    if (L.seek.nonce !== fly.seekNonce) {
      fly.seekNonce = L.seek.nonce
      if (L.seek.s >= 0) fly.s = L.seek.s
      else fly.started = false
      this.dirty = true
      if (!fly.started) return
    }
    const dt = fly.lastT ? Math.min(0.1, (t - fly.lastT) / 1000) : 0
    fly.lastT = t
    const dir = L.fly.reverse ? -1 : 1
    let ended = false
    if (L.fly.playing) {
      fly.s += dir * FLY_SPEED * L.fly.speed * dt
      if (fly.s >= path.length || fly.s <= 0) ended = true
      this.dirty = true
    }
    fly.s = Math.min(path.length, Math.max(0, fly.s))
    const a: V3 = [0, 0, 0], b: V3 = [0, 0, 0], c: V3 = [0, 0, 0]
    pathPoint(path, fly.s - 0.002, a)
    pathPoint(path, fly.s, b)
    pathPoint(path, fly.s + 0.002, c)
    const pos = this.camera.position.set((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3)
    // 朝行进方向看；快到头时用身后的一点定方向 / look the way of travel; near the end the direction comes from a point behind
    const ahead = fly.s + dir * 0.008
    const view = new Vector3()
    if (ahead >= 0 && ahead <= path.length) {
      pathPoint(path, ahead, a)
      view.set(a[0] - pos.x, a[1] - pos.y, a[2] - pos.z)
    } else {
      pathPoint(path, fly.s - dir * 0.008, a)
      view.set(pos.x - a[0], pos.y - a[1], pos.z - a[2])
    }
    if (view.lengthSq() < 1e-12) view.set(0, -1, 0)
    view.normalize()
    // "上"沿路径平移：去掉沿视线的分量；退化时换一个垂直方向 / "up" is transported along the path: drop its component along the view; pick another perpendicular when degenerate
    fly.up.addScaledVector(view, -fly.up.dot(view))
    if (fly.up.lengthSq() < 1e-6) fly.up.set(Math.abs(view.z) < 0.9 ? 0 : 1, 0, Math.abs(view.z) < 0.9 ? 1 : 0).addScaledVector(view, -(Math.abs(view.z) < 0.9 ? view.z : view.x))
    fly.up.normalize()
    this.camera.up.copy(fly.up)
    this.camera.lookAt(pos.x + view.x, pos.y + view.y, pos.z + view.z)
    this.camera.updateMatrixWorld()
    this.tween = null
    // 位置每隔 120 毫秒报告一次（界面上的读数和进度条），到头时立即报告 / the position is reported every 120 ms (readout and scrubber), and at once at either end
    if (ended || t - fly.reported > 120) {
      const id = segId(segmentAt(path, fly.s))
      const radius = radiusAt(path, fly.s)
      if (ended || Math.abs(L.flyS - fly.s) > 1e-6 || L.flyTotal !== path.length || L.flySegment !== id || L.flyRadius !== radius) {
        fly.reported = t
        reportFly(fly.s, path.length, id, radius, ended)
      }
    }
  }

  /** 腔显示的现状（验证用）/ The state of the lumina display (verification). */
  lumenInfo(): { data: boolean; derived: number; real: number; walls: number; layer: boolean; layerParts: number; rewritten: number; fly: { s: number; length: number; segment: string; segments: { id: string; start: number; end: number; bridged: number }[] } | null } {
    const path = this.fly?.path
    return {
      data: !!this.lumenData,
      derived: this.lumenData?.derived.length ?? 0,
      real: this.lumenData?.real.length ?? 0,
      walls: this.lumenWalls.size,
      layer: this.lumenLayerOn,
      layerParts: this.lumenLayerOn && this.lumenLayer ? this.lumenLayer.parts.filter((i) => this.display[i] === NORMAL).length : 0,
      rewritten: [...this.lumenApplied.values()].filter((k) => k !== 'mismatch').length,
      fly: this.fly && path ? { s: this.fly.s, length: path.length, segment: path.segments[segmentAt(path, this.fly.s)]!.id, segments: path.segments } : null,
    }
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
      // "腔"图层是双面画的（漫游时从里面看），拾取也按双面 / the lumina layer is drawn double-sided (seen from inside in the fly-through), so it is picked double-sided too
      const both = (capped && this.solid[i]) || (this.lumenLayerOn && !!this.lumenLayer?.has(i))
      const h = this.bvhFor(i).raycastFirst(this.localRay, both ? DoubleSide : FrontSide, near, Math.min(far, best))
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
    // 漫游时相机由路径带着走，环绕控制器不参与 / in the fly-through the path drives the camera and the orbit controls stay out of it
    if (!this.fly) this.controls.update()
    if (this.syncNeeded) this.sync()
    if (this.source === useApp.getState) {
      this.stepLumen()
      this.stepFly(t)
    }
    // 刺激先取样：它给表情一个强度、给姿势一个反射增量 / the stimulus is sampled first: it gives the face a level and the pose a reflex increment
    const stimulating = this.source === useApp.getState ? this.stepStim(stimFrame(t)) : false
    this.stepEyes(t)
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
