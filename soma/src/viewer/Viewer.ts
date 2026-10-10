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
  computeExplode,
  sectionPlane,
  type PlaneEq,
} from '../state/display.ts'
import { useApp, type AppState } from '../state/store.ts'
import { ACCENT, MODE_BLEND, MODE_HIDDEN, MODE_OPAQUE, PartBatches, bakePart, type BakedPart, type PartRenderer } from './batches.ts'
import { PartMeshes, centroidTransparentSort } from './meshes.ts'

const GHOST_RGB = new Color('#8d99a6')
const GHOST_OPACITY = 0.07
/** Parts drawn more transparent than this are not pickable (the pointer passes through). */
const PICK_OPACITY = 0.4
const ACCENT_RGB = new Color(ACCENT)
const WHITE = new Color(0xffffff)
/** On-screen radius (CSS px) nerves are thickened to when the aid is on. */
const NERVE_MIN_RADIUS_PX = 0.75
/** How far from the pointer (CSS px) a thin part is still picked. */
const THIN_PICK_PX = { mouse: 5, touch: 12 }
/** A thin part may sit this far (m) behind the nearest surface on its own line of sight and still win (nerves lie half-embedded). */
const THIN_DEPTH_SLACK = 0.004

export type { BakedPart }

export interface ViewerStats {
  backend: 'webgpu' | 'webgl2'
  /** requestAnimationFrame ticks per second (display rate the page is getting). */
  tickFps: number
  /** Frames actually rendered in the last second (0 when idle: rendering is on demand). */
  renderedFps: number
  /** Mean main-thread time of renderer.render() over the last second, ms. */
  renderCpuMs: number
  drawCalls: number
  triangles: number
  /** Parts that have geometry. */
  meshes: number
  bvhBuilt: number
  bvhTotal: number
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

/** Above this many selected parts the see-through tint is skipped (it doubles their draw calls). */
const XRAY_MAX = 300
const TAP_MAX_MOVE = 6
const TAP_MAX_MS = 450
const DOUBLE_TAP_MS = 350

export class Viewer {
  readonly renderer: WebGPURenderer
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(35, 1, 0.005, 60)
  readonly controls: OrbitControls
  backend: 'webgpu' | 'webgl2' = 'webgl2'
  /** Called with client coordinates while the mouse hovers the canvas, and null when it leaves. */
  onPointer: ((xy: { x: number; y: number } | null) => void) | null = null

  private readonly root = new ClippingGroup()
  private readonly plane = new Plane(new Vector3(0, -1, 0), 0)
  private batches: PartRenderer | null = null
  /** 'batched' (WebGPU) or 'meshes' (WebGL2 fallback); see meshes.ts for why. */
  scenePath: 'batched' | 'meshes' = 'batched'
  /** Batch instance id per part (indexed like graph.parts), -1 when the part has no geometry. */
  private readonly inst: Int32Array
  private readonly bvh: (MeshBVH | null)[]
  /** Equivalent tube radius per part, metres (0 when unknown). */
  private readonly radius: Float32Array
  /** Parts thin enough to get tolerant picking. */
  private thinParts: number[] = []
  private readonly baseColor: Color[]
  private display: Uint8Array
  private offsets: Float32Array
  private pickable: Uint8Array
  /** 1 when the part is currently drawn opaque (so a section shows its filled back faces). */
  private solid: Uint8Array
  private planeEq: PlaneEq | null = null

  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()
  private readonly localRay = new Ray()
  private lastPointerType: 'mouse' | 'touch' = 'mouse'

  private raf = 0
  private dirty = true
  private syncNeeded = true
  private prev: AppState | null = null
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
    private readonly graph: AnatomyGraph,
    private readonly baseUrl: string,
    opts: { forceWebGL?: boolean } = {},
  ) {
    this.renderer = new WebGPURenderer({ antialias: true, forceWebGL: opts.forceWebGL ?? false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setClearColor(new Color('#15181d'), 1)
    this.renderer.info.autoReset = false // reset per frame by hand so counts are per-frame
    const canvas = this.renderer.domElement
    canvas.className = 'viewer-canvas'
    container.appendChild(canvas)

    const n = graph.parts.length
    this.inst = new Int32Array(n).fill(-1)
    this.bvh = new Array<MeshBVH | null>(n).fill(null)
    this.radius = new Float32Array(n)
    this.baseColor = graph.parts.map(() => new Color())
    this.display = new Uint8Array(n)
    this.offsets = new Float32Array(n * 3)
    this.pickable = new Uint8Array(n)
    this.solid = new Uint8Array(n)

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
    this.scene.add(rim, this.camera, this.root)
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
    })
    this.controls.addEventListener('start', () => {
      this.tween = null
    })
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
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointercancel', this.onPointerCancel)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerleave', this.onPointerLeave)
    el.addEventListener('contextmenu', this.onContextMenu)

    this.unsubscribe = useApp.subscribe(() => {
      this.syncNeeded = true
    })
    this.raf = requestAnimationFrame(this.tick)
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.unsubscribe?.()
    this.resizeObserver?.disconnect()
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this.onPointerDown)
    el.removeEventListener('pointerup', this.onPointerUp)
    el.removeEventListener('pointercancel', this.onPointerCancel)
    el.removeEventListener('pointermove', this.onPointerMove)
    el.removeEventListener('pointerleave', this.onPointerLeave)
    el.removeEventListener('contextmenu', this.onContextMenu)
    this.controls.dispose()
    this.batches?.dispose()
    this.renderer.dispose()
    el.remove()
  }

  // ------------------------------------------------------------ geometry loading

  /**
   * Load every system's GLB, bake each part to world space and build the batches. Nothing
   * is drawn until all files are in (the batches need their final buffer sizes); a missing
   * or broken file is reported and skipped. Returns human-readable problems.
   */
  async loadSystems(onProgress: (done: number, total: number) => void): Promise<string[]> {
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    const systems = this.graph.data.systems.filter((s) => s.glb)
    const problems: string[] = []
    const baked = new Array<BakedPart | undefined>(this.graph.parts.length)
    let done = 0
    onProgress(0, systems.length)
    await Promise.all(
      systems.map(async (sys) => {
        try {
          const gltf = await loader.loadAsync(new URL(sys.glb!, new URL(this.baseUrl, location.href)).href)
          if (this.disposed) return
          const got = this.bake(gltf.scene, baked)
          const expected = this.graph.partsBySystem(sys.id).length
          if (got < expected) problems.push(`${sys.name.zh}：${expected - got}/${expected} 个结构在 ${sys.glb} 中没有几何`)
        } catch (err) {
          console.warn(`[soma] failed to load ${sys.glb}`, err)
          problems.push(`${sys.name.zh}：无法加载 ${sys.glb}`)
        }
        onProgress(++done, systems.length)
      }),
    )
    if (!this.disposed) this.build(baked)
    return problems
  }

  /** Bake the parts found in one loaded GLB into `out`. Returns how many parts it held. */
  private bake(gltfScene: Object3D, out: (BakedPart | undefined)[]): number {
    gltfScene.updateMatrixWorld(true)
    const byPart = new Map<number, Mesh[]>()
    gltfScene.traverse((o) => {
      const mesh = o as Mesh
      if (!mesh.isMesh) return
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
    let added = 0
    for (const [index, meshes] of byPart) {
      if (!out[index]) added++
      out[index] = bakePart(meshes)
      for (const m of meshes) {
        m.geometry.dispose()
        const mats = m.material
        for (const mat of Array.isArray(mats) ? mats : [mats]) mat.dispose()
      }
    }
    return added
  }

  private build(baked: (BakedPart | undefined)[]): void {
    let vertices = 0
    let indices = 0
    let count = 0
    for (const b of baked) {
      if (!b) continue
      count++
      vertices += b.geometry.getAttribute('position').count
      indices += b.geometry.index!.count
    }
    const forced = new URLSearchParams(location.search).get('scene')
    this.scenePath = forced === 'batched' || forced === 'meshes' ? forced : this.backend === 'webgpu' ? 'batched' : 'meshes'
    const batches: PartRenderer = this.scenePath === 'batched' ? new PartBatches(count, vertices, indices) : new PartMeshes()
    if (this.scenePath === 'meshes') this.renderer.setTransparentSort(centroidTransparentSort as never)
    const parts = this.graph.parts
    this.thinParts = []
    for (let i = 0; i < parts.length; i++) {
      const b = baked[i]
      if (!b) continue
      const part = parts[i]!
      this.radius[i] = b.radius
      if (b.radius > 0 && b.radius < THIN_RADIUS) this.thinParts.push(i)
      this.inst[i] = batches.add(b, part.tissue === 'nerve' ? b.radius : null, part.bbox, part.centroid)
      this.bvhQueue.push(i)
    }
    batches.finish()
    for (const b of baked) b?.geometry.dispose()
    this.bvhTotal = count
    this.batches = batches
    this.root.add(...batches.objects)
    this.updateBoost()
    this.forceFull = true
    this.syncNeeded = true
  }

  hasGeometry(partIndex: number): boolean {
    return (this.inst[partIndex] ?? -1) >= 0
  }

  /** Equivalent tube radius of a part in metres, as measured from its mesh (0 = no geometry). */
  radiusOf(partId: string): number {
    const i = this.graph.indexOf(partId)
    return i < 0 ? 0 : this.radius[i]!
  }

  private updateBoost(): void {
    const on = useApp.getState().nerveBoost
    const h = Math.max(1, this.container.clientHeight)
    // world size of one CSS pixel per metre of distance, times the wanted pixel radius
    const perMetre = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / h
    this.batches?.setBoost(on ? perMetre * NERVE_MIN_RADIUS_PX : 0)
  }

  // ------------------------------------------------------------ state → scene

  private sync(): void {
    const s = useApp.getState()
    const p = this.forceFull ? null : this.prev
    this.prev = s
    this.forceFull = false
    this.syncNeeded = false
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
      p.selection !== s.selection
    const explodeChanged =
      !p ||
      p.explode !== s.explode ||
      p.explodeSelectionOnly !== s.explodeSelectionOnly ||
      (s.explodeSelectionOnly && s.explode > 0 && p.selection !== s.selection)
    const sectionChanged = !p || p.section !== s.section
    const hoverChanged = !p || p.hover !== s.hover
    const boostChanged = !p || p.nerveBoost !== s.nerveBoost
    if (!displayChanged && !explodeChanged && !sectionChanged && !hoverChanged && !boostChanged) {
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
    }

    const parts = this.graph.parts
    if (explodeChanged) {
      computeExplode(this.graph, s.explode, s.explodeSelectionOnly ? s.selection.set : null, this.offsets)
      if (batches) {
        for (let i = 0; i < parts.length; i++) {
          const id = this.inst[i]!
          if (id < 0) continue
          const c = parts[i]!.centroid
          const x = this.offsets[i * 3]!
          const y = this.offsets[i * 3 + 1]!
          const z = this.offsets[i * 3 + 2]!
          batches.setOffset(id, x, y, z, c[0] + x, c[1] + y, c[2] + z)
        }
      }
    }

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
          selected: s.selection.set,
        },
        this.display,
      )
      for (let i = 0; i < parts.length; i++) this.applyPart(i, parts[i]!, s)
    } else if (hoverChanged) {
      for (const id of [p?.hover, s.hover]) {
        if (!id) continue
        const i = this.graph.indexOf(id)
        if (i >= 0) this.applyPart(i, this.graph.parts[i]!, s)
      }
    }
    // camera requests last, so they see the display state and explode offsets just applied
    if (wantHome) this.home(true)
    if (wantFocus) this.focus(s.focusRequest.ids)
  }

  /** Colour each part is drawn with before hover / selection tinting. */
  private computeBaseColors(s: AppState): void {
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

  private applyPart(i: number, part: Part, s: AppState): void {
    const id = this.inst[i]!
    const d = this.display[i]!
    const selected = s.selection.set.has(part.id)
    // tissue default × the system's slider; in colour-by-source mode see-through tissues are
    // lifted a little so their colour can be read
    let opacity = (TISSUE_OPACITY[part.tissue] ?? 1) * (s.systems[part.system]?.opacity ?? 1)
    if (s.colorMode === 'source' && TISSUE_OPACITY[part.tissue] !== undefined) opacity = Math.min(1, opacity * 1.6)
    if (selected) opacity = 1 // a selected part is shown solid so it can be found
    this.pickable[i] = id >= 0 && d === NORMAL && opacity >= PICK_OPACITY ? 1 : 0
    this.solid[i] = d === NORMAL && opacity >= 0.999 ? 1 : 0
    const batches = this.batches
    if (id < 0 || !batches) return
    if (d === HIDDEN) {
      batches.setState(id, MODE_HIDDEN, 0, 0, 0, 0)
    } else if (d === GHOST) {
      batches.setState(id, MODE_BLEND, GHOST_RGB.r, GHOST_RGB.g, GHOST_RGB.b, GHOST_OPACITY)
    } else {
      const c = this.tmpColor.copy(this.baseColor[i]!)
      if (selected) c.lerp(ACCENT_RGB, 0.6)
      else if (s.hover === part.id) c.lerp(WHITE, 0.32)
      batches.setState(id, opacity >= 0.999 ? MODE_OPAQUE : MODE_BLEND, c.r, c.g, c.b, opacity)
    }
    // selected parts also get a faint tint drawn through whatever covers them
    batches.setXray(id, d !== HIDDEN && selected && s.selection.ids.length <= XRAY_MAX)
  }

  // ------------------------------------------------------------ picking

  /**
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

    // thin parts whose surface passes within the tolerance of the pointer, nearest on screen first
    const near = this.nearThin(clientX, clientY, rect, tolerancePx)
    for (let k = 0; k < near.length && k < 4; k++) {
      const c = near[k]!
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
    // world size of one CSS pixel at one metre from the camera
    const perMetre = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / rect.height
    const parts = this.graph.parts
    const out: { part: number; px: number; distance: number; point: Vector3 }[] = []
    const ray = this.localRay
    for (const i of this.thinParts) {
      if (!this.pickable[i]) continue
      const b = parts[i]!.bbox
      const ox = this.offsets[i * 3]!
      const oy = this.offsets[i * 3 + 1]!
      const oz = this.offsets[i * 3 + 2]!
      // broad phase: the ray against the part's box grown by the tolerance at the box's far side
      const cxm = (b[0] + b[3]) / 2 + ox - o.x
      const cym = (b[1] + b[4]) / 2 + oy - o.y
      const czm = (b[2] + b[5]) / 2 + oz - o.z
      const reach = Math.hypot(cxm, cym, czm) + Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2
      const pad = tolerancePx * perMetre * reach + 0.001
      this.tmpBox.min.set(b[0] + ox - pad, b[1] + oy - pad, b[2] + oz - pad)
      this.tmpBox.max.set(b[3] + ox + pad, b[4] + oy + pad, b[5] + oz + pad)
      if (!this.raycaster.ray.intersectsBox(this.tmpBox)) continue

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

  /** Exact hit under a pixel with its distance from the camera (debug / verification). */
  probe(clientX: number, clientY: number): { id: string; distance: number } | null {
    if (this.syncNeeded) this.sync()
    this.camera.updateMatrixWorld()
    const h = this.cast(clientX, clientY, this.renderer.domElement.getBoundingClientRect(), null)
    return h ? { id: this.graph.parts[h.part]!.id, distance: h.distance } : null
  }

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

  /** Nearest hit along the ray through a pixel, among `only` (part indices) or all pickable parts. */
  private cast(clientX: number, clientY: number, rect: DOMRect, only: readonly number[] | null): { part: number; distance: number } | null {
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

    // broad phase: ray vs each candidate's (exploded) bounding box
    const parts = this.graph.parts
    const cand: number[] = []
    const candT: number[] = []
    const pad = 0.002
    const n = only ? only.length : parts.length
    for (let k = 0; k < n; k++) {
      const i = only ? only[k]! : k
      if (!this.pickable[i]) continue
      const b = parts[i]!.bbox
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
      // geometry is baked in world space, so the part's frame is just the explode translation
      this.localRay.origin.set(o.x - this.offsets[i * 3]!, o.y - this.offsets[i * 3 + 1]!, o.z - this.offsets[i * 3 + 2]!)
      this.localRay.direction.copy(d)
      // with a section on, an opaque part's back faces are drawn (the filled cut), so they are pickable
      const h = this.bvhFor(i).raycastFirst(this.localRay, capped && this.solid[i] ? DoubleSide : FrontSide, near, Math.min(far, best))
      if (h && h.distance < best) {
        best = h.distance
        bestPart = i
      }
    }
    return bestPart >= 0 ? { part: bestPart, distance: best } : null
  }

  private bvhFor(i: number): MeshBVH {
    let bvh = this.bvh[i]
    if (!bvh) {
      // indirect: the index buffer is the batch's own (already on the GPU) and must not be reordered
      bvh = new MeshBVH(this.batches!.pickGeometry(this.inst[i]!), { indirect: true })
      this.bvh[i] = bvh
      this.bvhBuilt++
    }
    return bvh
  }

  /** Build pending BVHs for up to `budgetMs`; called from idle frames. */
  private buildBvhs(budgetMs: number): void {
    const t0 = performance.now()
    while (this.bvhQueue.length && performance.now() - t0 < budgetMs) {
      const i = this.bvhQueue.pop()!
      if (!this.bvh[i]) this.bvhFor(i)
    }
  }

  // ------------------------------------------------------------ camera

  private boundsOf(ids: readonly string[] | null): Box3 | null {
    const box = new Box3()
    const parts = this.graph.parts
    const add = (i: number) => {
      const b = parts[i]!.bbox
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

  /** Frame the given parts, or the selection, or everything visible. Keeps the view direction. */
  focus(ids: readonly string[] | null = null): void {
    const sel = useApp.getState().selection.ids
    const box = this.boundsOf(ids ?? (sel.length ? sel : null))
    if (!box) return
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    this.frame(box, dir, true)
  }

  /** Whole body from the front. */
  home(animate: boolean): void {
    const b = this.graph.bodyBounds
    const box = new Box3(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]))
    this.frame(box, new Vector3(0, 0.08, 1).normalize(), animate)
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

  // ------------------------------------------------------------ pointer input

  private onContextMenu = (e: Event): void => e.preventDefault()

  private onPointerDown = (e: PointerEvent): void => {
    this.lastPointerType = e.pointerType === 'mouse' ? 'mouse' : 'touch'
    this.pointers.add(e.pointerId)
    this.onPointer?.(null)
    this.down =
      this.pointers.size === 1 && e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null
    this.hoverXY = null
  }

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId)
    const d = this.down
    this.down = null
    if (!d || d.id !== e.pointerId) return
    const now = performance.now()
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_MAX_MOVE || now - d.t > TAP_MAX_MS) return
    const app = useApp.getState()
    if (this.syncNeeded) this.sync()
    const id = this.pick(e.clientX, e.clientY)
    const additive = e.ctrlKey || e.metaKey || e.shiftKey
    const last = this.lastTap
    const isDouble = !!last && now - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 24
    this.lastTap = isDouble ? null : { x: e.clientX, y: e.clientY, t: now }
    if (isDouble) {
      if (id) {
        if (!app.selection.set.has(id)) app.selectParts([id])
        app.requestFocus()
      }
      return
    }
    if (id) app.selectParts([id], { additive })
    else if (!additive) app.clearSelection()
  }

  private onPointerCancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId)
    this.down = null
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' || e.buttons !== 0) return
    this.lastPointerType = 'mouse'
    this.hoverXY = { x: e.clientX, y: e.clientY }
    this.onPointer?.({ x: e.clientX, y: e.clientY })
  }

  private onPointerLeave = (): void => {
    this.hoverXY = null
    this.onPointer?.(null)
    useApp.getState().setHover(null)
  }

  // ------------------------------------------------------------ loop

  private tick = (t: number): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.tick)

    if (this.tween) {
      const k = Math.min(1, (t - this.tween.t0) / this.tween.ms)
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
      this.camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, e)
      this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e)
      if (k >= 1) this.tween = null
      this.dirty = true
    }
    this.controls.update()

    if (this.hoverXY && !this.dirty) {
      const { x, y } = this.hoverXY
      this.hoverXY = null
      if (this.syncNeeded) this.sync()
      useApp.getState().setHover(this.pick(x, y))
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
      if (this.bvhQueue.length) this.buildBvhs(5)
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

  /** Ask for a redraw on the next frame. */
  invalidate(): void {
    this.dirty = true
  }

  // ------------------------------------------------------------ debug / verification

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
    }
  }

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
