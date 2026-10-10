// The 3D view: renderer, camera, part meshes, picking, and the mirror from store state to
// scene state. One Mesh per part, shared materials; rendering is on demand.

import {
  Box3,
  ClippingGroup,
  Color,
  DirectionalLight,
  HemisphereLight,
  Matrix4,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGPURenderer,
  type BufferGeometry,
  type Intersection,
  type Material,
} from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { MeshBVH } from 'three-mesh-bvh'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import type { Part, SystemId } from '../anatomy/types.ts'
import {
  GHOST,
  HIDDEN,
  NORMAL,
  clipRay,
  computeDisplay,
  computeExplode,
  sectionPlane,
  type PlaneEq,
} from '../state/display.ts'
import { useApp, type AppState } from '../state/store.ts'
import { PICK_OPACITY, PartMaterials, type Variant } from './materials.ts'

interface PartEntry {
  meshes: Mesh[]
  /** World matrix of each mesh as authored (before explode). */
  base: Matrix4[]
  bvh: (MeshBVH | null)[]
  /** See-through selection tint, one child per mesh; created on first use. */
  xray: Mesh[] | null
}

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
  private readonly materials: PartMaterials
  private readonly entries: (PartEntry | null)[]
  private display: Uint8Array
  private offsets: Float32Array
  private pickable: Uint8Array
  private planeEq: PlaneEq | null = null

  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()
  private readonly hits: Intersection[] = []

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

  private bvhQueue: [number, number][] = []
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

    this.materials = new PartMaterials(graph.data.systems)
    const n = graph.parts.length
    this.entries = new Array<PartEntry | null>(n).fill(null)
    this.display = new Uint8Array(n)
    this.offsets = new Float32Array(n * 3)
    this.pickable = new Uint8Array(n)

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
    ;(this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true
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
    for (const e of this.entries) if (e) for (const m of e.meshes) m.geometry.dispose()
    this.materials.dispose()
    this.renderer.dispose()
    el.remove()
  }

  // ------------------------------------------------------------ geometry loading

  /**
   * Load every system's GLB. Systems appear as they arrive; a missing or broken file is
   * reported and skipped. Returns human-readable problems (empty when all went well).
   */
  async loadSystems(onProgress: (done: number, total: number) => void): Promise<string[]> {
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    const systems = this.graph.data.systems.filter((s) => s.glb)
    const problems: string[] = []
    let done = 0
    onProgress(0, systems.length)
    await Promise.all(
      systems.map(async (sys) => {
        try {
          const gltf = await loader.loadAsync(new URL(sys.glb!, new URL(this.baseUrl, location.href)).href)
          if (this.disposed) return
          const attached = this.attach(gltf.scene)
          const expected = this.graph.partsBySystem(sys.id).length
          if (attached < expected) {
            problems.push(`${sys.name.zh}：${expected - attached}/${expected} 个结构在 ${sys.glb} 中没有几何`)
          }
        } catch (err) {
          console.warn(`[soma] failed to load ${sys.glb}`, err)
          problems.push(`${sys.name.zh}：无法加载 ${sys.glb}`)
        }
        onProgress(++done, systems.length)
      }),
    )
    return problems
  }

  /** Move a loaded GLB's meshes under the root, keyed by part id. Returns parts attached. */
  private attach(gltfScene: Object3D): number {
    gltfScene.updateMatrixWorld(true)
    const found: { mesh: Mesh; index: number }[] = []
    gltfScene.traverse((o) => {
      const mesh = o as Mesh
      if (!mesh.isMesh) return
      // the part id is the name of the mesh's node, or of an ancestor when a mesh with
      // several primitives was split into children by the loader
      let cur: Object3D | null = mesh
      while (cur) {
        const name = (cur.userData.name as string | undefined) ?? cur.name
        const index = this.graph.indexOf(name)
        if (index >= 0) {
          found.push({ mesh, index })
          return
        }
        cur = cur.parent
      }
    })
    const before = new Set<number>()
    for (const { mesh, index } of found) {
      const old = mesh.material as Material | Material[]
      for (const m of Array.isArray(old) ? old : [old]) m.dispose()
      const base = mesh.matrixWorld.clone()
      mesh.removeFromParent()
      mesh.matrixAutoUpdate = false
      mesh.matrix.copy(base)
      mesh.userData.part = index
      let e = this.entries[index]
      if (!e) {
        e = { meshes: [], base: [], bvh: [], xray: null }
        this.entries[index] = e
        before.add(index)
      }
      e.meshes.push(mesh)
      e.base.push(base)
      e.bvh.push(null)
      this.bvhQueue.push([index, e.meshes.length - 1])
      this.bvhTotal++
      this.root.add(mesh)
    }
    this.forceFull = true // the new meshes must pick up the current state
    this.syncNeeded = true
    return before.size
  }

  hasGeometry(partIndex: number): boolean {
    return !!this.entries[partIndex]
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
      p.selection !== s.selection
    const explodeChanged =
      !p ||
      p.explode !== s.explode ||
      p.explodeSelectionOnly !== s.explodeSelectionOnly ||
      (s.explodeSelectionOnly && s.explode > 0 && p.selection !== s.selection)
    const sectionChanged = !p || p.section !== s.section
    const hoverChanged = !p || p.hover !== s.hover
    if (!displayChanged && !explodeChanged && !sectionChanged && !hoverChanged) {
      if (wantHome) this.home(true)
      if (wantFocus) this.focus(s.focusRequest.ids)
      return
    }
    this.dirty = true

    if (sectionChanged) {
      const sec = s.section
      this.planeEq = sec.enabled ? sectionPlane(this.graph.bodyBounds, sec) : null
      if (this.planeEq) {
        this.plane.normal.set(...this.planeEq.normal)
        this.plane.constant = this.planeEq.constant
      }
      this.root.enabled = sec.enabled
      this.materials.setCapped(sec.enabled)
    }

    if (explodeChanged) {
      computeExplode(this.graph, s.explode, s.explodeSelectionOnly ? s.selection.set : null, this.offsets)
      for (let i = 0; i < this.entries.length; i++) {
        const e = this.entries[i]
        if (!e) continue
        for (let k = 0; k < e.meshes.length; k++) {
          const m = e.meshes[k]!
          const b = e.base[k]!.elements
          const el = m.matrix.elements
          el[12] = b[12]! + this.offsets[i * 3]!
          el[13] = b[13]! + this.offsets[i * 3 + 1]!
          el[14] = b[14]! + this.offsets[i * 3 + 2]!
          m.matrixWorldNeedsUpdate = true
        }
      }
    }

    if (displayChanged) {
      for (const sys of this.graph.data.systems) {
        this.materials.setSystemOpacity(sys.id, s.systems[sys.id]?.opacity ?? 1)
      }
      computeDisplay(
        this.graph,
        {
          systems: s.systems,
          peel: s.peel,
          hidden: s.hidden,
          isolated: s.isolated,
          adjacentMode: s.adjacentMode,
          selected: s.selection.set,
        },
        this.display,
      )
      const parts = this.graph.parts
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

  private applyPart(i: number, part: Part, s: AppState): void {
    const e = this.entries[i]
    const d = this.display[i]!
    const selected = s.selection.set.has(part.id)
    this.pickable[i] =
      e && d === NORMAL && (selected || this.materials.effectiveOpacity(part.system, part.tissue) >= PICK_OPACITY) ? 1 : 0
    if (!e) return
    let material: Material
    if (d === GHOST) material = this.materials.ghost
    else {
      const variant: Variant = selected ? 'selected' : s.hover === part.id ? 'hover' : 'base'
      material = this.materials.get(part.system, part.tissue, variant)
    }
    for (const m of e.meshes) {
      m.visible = d !== HIDDEN
      if (m.material !== material) m.material = material
    }
    // selected parts also get a faint tint drawn through whatever covers them
    const xray = selected && s.selection.ids.length <= XRAY_MAX
    if (xray && !e.xray) {
      e.xray = e.meshes.map((m) => {
        const x = new Mesh(m.geometry, this.materials.xray)
        x.renderOrder = 10
        x.matrixAutoUpdate = false
        m.add(x)
        return x
      })
    }
    if (e.xray) for (const x of e.xray) x.visible = xray
  }

  // ------------------------------------------------------------ picking

  /** Part under the given client coordinates, or null. Honours visibility and the section plane. */
  pick(clientX: number, clientY: number): string | null {
    if (this.syncNeeded) this.sync()
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.camera.updateMatrixWorld()
    this.raycaster.setFromCamera(this.ndc, this.camera)
    const ray = this.raycaster.ray
    const o = ray.origin
    const d = ray.direction
    let near = 0
    let far = Infinity
    if (this.planeEq) {
      const span = clipRay([o.x, o.y, o.z], [d.x, d.y, d.z], this.planeEq)
      if (!span) return null
      ;[near, far] = span
    }
    this.raycaster.near = near
    this.raycaster.far = far

    // broad phase: ray vs each pickable part's (exploded) bounding box
    const parts = this.graph.parts
    const cand: number[] = []
    const candT: number[] = []
    const pad = 0.002
    for (let i = 0; i < parts.length; i++) {
      if (!this.pickable[i]) continue
      const b = parts[i]!.bbox
      const ox = this.offsets[i * 3]!
      const oy = this.offsets[i * 3 + 1]!
      const oz = this.offsets[i * 3 + 2]!
      let t0 = near
      let t1 = far
      let hit = true
      for (let a = 0; a < 3 && hit; a++) {
        const off = a === 0 ? ox : a === 1 ? oy : oz
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
    for (const k of order) {
      if (candT[k]! > best) break
      const i = cand[k]!
      const e = this.entries[i]!
      for (let m = 0; m < e.meshes.length; m++) {
        const mesh = e.meshes[m]!
        mesh.updateMatrixWorld()
        this.hits.length = 0
        this.bvhFor(e, m).raycastObject3D(mesh, this.raycaster, this.hits)
        const h = this.hits[0]
        if (h && h.distance < best) {
          best = h.distance
          bestPart = i
        }
      }
    }
    return bestPart >= 0 ? parts[bestPart]!.id : null
  }

  private bvhFor(e: PartEntry, m: number): MeshBVH {
    let bvh = e.bvh[m]
    if (!bvh) {
      // indirect: leave the index buffer alone (it is already on the GPU, in cache order)
      bvh = new MeshBVH(e.meshes[m]!.geometry as BufferGeometry, { indirect: true })
      e.bvh[m] = bvh
      this.bvhBuilt++
    }
    return bvh
  }

  /** Build pending BVHs for up to `budgetMs`; called from idle frames. */
  private buildBvhs(budgetMs: number): void {
    const t0 = performance.now()
    while (this.bvhQueue.length && performance.now() - t0 < budgetMs) {
      const [i, m] = this.bvhQueue.pop()!
      const e = this.entries[i]
      if (e && !e.bvh[m]) this.bvhFor(e, m)
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
    this.dirty = true
  }

  // ------------------------------------------------------------ pointer input

  private onContextMenu = (e: Event): void => e.preventDefault()

  private onPointerDown = (e: PointerEvent): void => {
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
      meshes: this.root.children.length,
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
        for (let i = 0; i < this.display.length; i++) if (this.display[i] !== HIDDEN && this.entries[i]) visible++
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
    for (let i = 0; i < this.display.length; i++) if (this.display[i] !== HIDDEN && this.entries[i]) visible++
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
  displayOf(partId: string): { state: 'hidden' | 'normal' | 'ghost'; pickable: boolean; hasGeometry: boolean; material: string } | null {
    const i = this.graph.indexOf(partId)
    if (i < 0) return null
    if (this.syncNeeded) this.sync()
    const d = this.display[i]
    const e = this.entries[i]
    return {
      state: d === HIDDEN ? 'hidden' : d === GHOST ? 'ghost' : 'normal',
      pickable: !!this.pickable[i],
      hasGeometry: !!e,
      material: e ? ((e.meshes[0]!.material as Material).name || 'ghost') : '',
    }
  }

  systemsLoaded(): SystemId[] {
    const seen = new Set<SystemId>()
    this.graph.parts.forEach((p, i) => {
      if (this.entries[i]) seen.add(p.system)
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
