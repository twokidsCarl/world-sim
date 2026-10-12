// 减少绘制调用：每个部件都在三个共用同一套顶点 / 索引缓冲的 BatchedMesh 里——不透明批、混合批和透视着色批。部件按状态在对应的批里显示，颜色写入该批的逐实例颜色；几何已烘焙到世界坐标。
// Draw-call reduction: every part lives in three BatchedMesh objects that share ONE set of
// vertex/index buffers — an opaque batch, a blended batch and a see-through "x-ray" batch.
// A part is shown by making its instance visible in the batch that matches its state and
// writing its RGBA into that batch's per-instance colour, so the whole body is three render
// objects (one pipeline + one bind group each) however many parts are visible.
//
// Geometry is baked to world space (float positions/normals, node transform applied) so the
// instance matrix is just the explode translation, transparency can be sorted by true part
// centroid, and the same buffers serve CPU picking (see `pickGeometry`).

import {
  BatchedMesh,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  FrontSide,
  Matrix3,
  Matrix4,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Vector3,
  Vector4,
  type Camera,
  type Mesh,
  type Object3D,
} from 'three/webgpu'
import { attribute, cameraPosition, diffuseColor, frontFacing, normalLocal, output, positionLocal, select, uniform, vec4 } from 'three/tsl'
import { tubeRadius } from '../state/display.ts'
import { NOT_BOOSTED, SkinningData, positionNodeFor, type SkinningMode } from './skinning.ts'

export const ACCENT = '#3ec7d6'
export interface BakedPart {
  geometry: BufferGeometry
  /** 烘焙后网格的表面积（平方米）和包围体积（立方米）。 */
  /** Surface area (m²) and enclosed volume (m³) of the baked mesh. */
  area: number
  volume: number
  /** 等效管半径，米（见 `tubeRadius`）。 */
  /** Equivalent tube radius, metres (see `tubeRadius`). */
  radius: number
}

/**
 * 把一个部件的各个网格合并成一个带索引、世界坐标、浮点的几何。量化、归一化和交错存储的源属性都能处理（一律经 getX/Y/Z 读取）。
 * Merge a part's meshes into one indexed, world-space, float geometry. Handles quantized,
 * normalized and interleaved source attributes (everything goes through getX/Y/Z).
 */
export function bakePart(meshes: Mesh[]): BakedPart {
  let vertexCount = 0
  let indexCount = 0
  for (const m of meshes) {
    const pos = m.geometry.getAttribute('position')
    vertexCount += pos.count
    indexCount += m.geometry.index ? m.geometry.index.count : pos.count
  }
  const position = new Float32Array(vertexCount * 3)
  const normal = new Float32Array(vertexCount * 3)
  const index = new Uint32Array(indexCount)
  const v = new Vector3()
  const nm = new Matrix3()
  let vo = 0
  let io = 0
  for (const m of meshes) {
    const g = m.geometry
    const pos = g.getAttribute('position')
    const nor = g.getAttribute('normal') as typeof pos | undefined
    nm.getNormalMatrix(m.matrixWorld)
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m.matrixWorld)
      position[(vo + i) * 3] = v.x
      position[(vo + i) * 3 + 1] = v.y
      position[(vo + i) * 3 + 2] = v.z
      if (nor) {
        v.set(nor.getX(i), nor.getY(i), nor.getZ(i)).applyMatrix3(nm).normalize()
        normal[(vo + i) * 3] = v.x
        normal[(vo + i) * 3 + 1] = v.y
        normal[(vo + i) * 3 + 2] = v.z
      }
    }
    const flipped = m.matrixWorld.determinant() < 0
    const src = g.index
    const n = src ? src.count : pos.count
    for (let i = 0; i < n; i += 3) {
      const a = (src ? src.getX(i) : i) + vo
      const b = (src ? src.getX(i + 1) : i + 1) + vo
      const c = (src ? src.getX(i + 2) : i + 2) + vo
      index[io + i] = a
      index[io + i + 1] = flipped ? c : b
      index[io + i + 2] = flipped ? b : c
    }
    vo += pos.count
    io += n
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(position, 3))
  geometry.setAttribute('normal', new BufferAttribute(normal, 3))
  geometry.setIndex(new BufferAttribute(index, 1))
  if (!meshes.every((m) => m.geometry.getAttribute('normal'))) geometry.computeVertexNormals()

  // 面积与有符号体积，以第一个顶点为原点，使体积求和的数值更稳定
  // area and signed volume, about the first vertex to keep the volume sum well conditioned
  let area = 0
  let volume = 0
  const ox = position[0] ?? 0
  const oy = position[1] ?? 0
  const oz = position[2] ?? 0
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i]! * 3
    const b = index[i + 1]! * 3
    const c = index[i + 2]! * 3
    const ax = position[a]! - ox, ay = position[a + 1]! - oy, az = position[a + 2]! - oz
    const bx = position[b]! - ox, by = position[b + 1]! - oy, bz = position[b + 2]! - oz
    const cx = position[c]! - ox, cy = position[c + 1]! - oy, cz = position[c + 2]! - oz
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const wx = cx - ax, wy = cy - ay, wz = cz - az
    const nx = uy * wz - uz * wy
    const ny = uz * wx - ux * wz
    const nz = ux * wy - uy * wx
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
  }
  return { geometry, area, volume: Math.abs(volume), radius: tubeRadius(volume, area) }
}

export const MODE_HIDDEN = 0
export const MODE_OPAQUE = 1
export const MODE_BLEND = 2

/** 无论用哪种场景表示，查看器需要的接口。 */
/** What the viewer needs from whichever scene representation is in use. */
export interface PartRenderer {
  /** 要放进场景（裁剪组之下）的对象。 */
  /** Objects to put in the scene (under the clipping group). */
  readonly objects: Object3D[]
  readonly size: number
  readonly isCapped: boolean
  /** 共享缓冲重新分配时变化（建在其上的 BVH 随即失效）。 */
  /** Changes whenever the shared buffers are reallocated (BVHs built on them are then stale). */
  readonly geometryVersion: number
  add(baked: BakedPart, boostRadius: number | null, bbox: readonly number[], centroid: readonly number[]): number
  /** 每一组 `add` 之后调用（每加载完一个系统一次）。 */
  /** Called after each group of `add` calls (once per loaded system). */
  finish(): void
  /** 只含该部件三角形的世界坐标几何（用于建 BVH）。 */
  /** A geometry holding just this part's triangles in world space (for a BVH). */
  pickGeometry(id: number): BufferGeometry
  setState(id: number, mode: number, r: number, g: number, b: number, a: number): void
  setXray(id: number, on: boolean): void
  setOffset(id: number, x: number, y: number, z: number, cx: number, cy: number, cz: number): void
  setCapped(on: boolean): void
  setBoost(radiusPerMetre: number): void
  /** 每次渲染前调用的钩子。 */
  /** Hook run just before each render. */
  beforeRender(camera: Camera): void
  /**
   * 某个部件在共享缓冲中的数据（每次调用现取，扩容后旧视图会失效）。`indexBase` 是索引值相对
   * 该部件第一个顶点的偏移。
   * A part's slices of the shared buffers (taken fresh on each call: growth invalidates old
   * views). `indexBase` is what to subtract from index values to get part-local vertex numbers.
   */
  partBuffers(id: number): PartBuffers
  /** 改写了某个部件的静止位置之后调用，只上传那一段 / Call after rewriting a part's rest positions; uploads just that range. */
  markPositions(id: number): void
  /** 写入蒙皮属性之后调用，把改动上传 / Call after writing skin attributes, to upload them. */
  flushSkinAttributes(): void
  setSkinning(mode: SkinningMode): void
  /** 姿势数据（关节 / 肌肉纹理）/ The pose data (joint / muscle textures). */
  readonly skinning: SkinningData
  dispose(): void
}

export interface PartBuffers {
  position: Float32Array
  normal: Float32Array
  skinIndex: Uint16Array
  skinWeight: Uint8Array
  aux: Float32Array
  index: Uint32Array | Uint16Array
  indexBase: number
}

export interface PartMaterialSet {
  solid: MeshStandardNodeMaterial
  blended: MeshStandardNodeMaterial
  tint: MeshBasicNodeMaterial
  /** 姿势数据与神经加粗量 / Pose data and the nerve-aid amount. */
  data: SkinningData
  /** 切换顶点位置节点：静止 / 摆姿势 / 摆姿势加体型 / Switch the vertex position node: rest / posed / posed with shape. */
  setSkinning(mode: SkinningMode): void
}

/**
 * 每个部件都用的三种材质。`colorNode`：颜色不来自批次时由它提供（逐网格回退路径传入 userData 节点）。
 * The three materials every part is drawn with. `colorNode` supplies the per-part RGBA when
 * it does not come from the batch (the per-mesh fallback passes a userData node).
 */
export function makePartMaterials(data: SkinningData, colorNode: unknown = null, wrapPosition: ((node: unknown) => unknown) | null = null): PartMaterialSet {
  const solid = new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0 })
  // 剖切面：开启剖切时此材质为双面，背面写成不受光的压暗纯色，切口看起来是实心的
  // Section caps: with a section plane on, this material is double-sided and back faces are
  // written as a flat, unlit, darkened surface colour, so a cut reads as filled.
  solid.outputNode = select(frontFacing, output, vec4(diffuseColor.rgb.mul(0.72), output.a))

  const blended = new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0 })
  blended.transparent = true
  blended.depthWrite = false

  const tint = new MeshBasicNodeMaterial({ color: new Color(ACCENT) })
  tint.transparent = true
  tint.opacity = 0.26
  tint.depthTest = false
  tint.depthWrite = false

  if (colorNode) {
    solid.colorNode = colorNode as typeof solid.colorNode
    blended.colorNode = colorNode as typeof blended.colorNode
  }
  let current: SkinningMode | null = null
  const setSkinning = (mode: SkinningMode): void => {
    if (mode === current) return
    current = mode
    // wrapPosition：合块绘制时用它把不归这一块画的部件的顶点收成一个点
    // wrapPosition: the chunked draw uses it to collapse the vertices of parts it does not draw
    const base = positionNodeFor(data, mode)
    const node = wrapPosition ? wrapPosition(base) : base
    for (const m of [solid, blended, tint]) {
      m.positionNode = node as typeof m.positionNode
      m.needsUpdate = true
    }
  }
  setSkinning('off')
  return { solid, blended, tint, data, setSkinning }
}

/** 几个批次共用一份几何所依赖的 BatchedMesh 私有状态。 */
/** The parts of BatchedMesh's private state that sharing one geometry between batches relies on. */
interface BatchInternals {
  _geometryInfo: unknown[]
  _geometryCount: number
  _geometryInitialized: boolean
}

interface SortItem {
  z: number
  index: number
}

export class PartBatches implements PartRenderer {
  readonly opaque: BatchedMesh
  readonly blend: BatchedMesh
  readonly xray: BatchedMesh
  readonly objects: Object3D[]
  private readonly materials: PartMaterialSet
  private readonly mode: Uint8Array
  private readonly xrayOn: Uint8Array
  private readonly ranges: { indexStart: number; indexCount: number; vertexStart: number; vertexCount: number }[] = []
  private readonly sortCenters: Float32Array
  private count = 0
  private capped = false
  private maxVertices: number
  private maxIndices: number
  private usedVertices = 0
  private usedIndices = 0
  geometryVersion = 0
  private readonly m4 = new Matrix4()
  private readonly rgba = new Vector4()

  readonly skinning: SkinningData

  constructor(maxParts: number, vertexCount: number, indexCount: number, skinning: SkinningData) {
    const n = Math.max(1, maxParts)
    this.skinning = skinning
    this.maxVertices = Math.max(3, vertexCount)
    this.maxIndices = Math.max(3, indexCount)
    const { solid, blended, tint } = (this.materials = makePartMaterials(skinning))

    this.opaque = new BatchedMesh(n, Math.max(3, vertexCount), Math.max(3, indexCount), solid)
    this.blend = new BatchedMesh(n, Math.max(3, vertexCount), Math.max(3, indexCount), blended)
    this.xray = new BatchedMesh(n, Math.max(3, vertexCount), Math.max(3, indexCount), tint)
    this.opaque.sortObjects = false // a tile-based GPU gains nothing from front-to-back order
    this.xray.sortObjects = false
    this.xray.perObjectFrustumCulled = false
    this.blend.renderOrder = 1
    this.xray.renderOrder = 2
    for (const b of [this.opaque, this.blend, this.xray]) {
      b.frustumCulled = false // per-instance culling still applies; whole-batch bounds go stale when exploded
      b.matrixAutoUpdate = false
    }
    this.objects = [this.opaque, this.blend, this.xray]
    this.mode = new Uint8Array(n)
    this.xrayOn = new Uint8Array(n)
    this.sortCenters = new Float32Array(n * 3)

    // 按部件质心从后往前（不是按网格原点或包围球中心）
    // back-to-front by part centroid (not by mesh origin or bounding-sphere centre)
    const cam = new Vector3()
    const fwd = new Vector3()
    this.blend.setCustomSort((items, camera: Camera) => {
      const list = items as unknown as SortItem[]
      cam.setFromMatrixPosition(camera.matrixWorld)
      fwd.set(0, 0, -1).transformDirection(camera.matrixWorld)
      const c = this.sortCenters
      for (const item of list) {
        const k = item.index * 3
        item.z = (c[k]! - cam.x) * fwd.x + (c[k + 1]! - cam.y) * fwd.y + (c[k + 2]! - cam.z) * fwd.z
      }
      list.sort((a, b) => b.z - a.z)
    })
  }

  /**
   * 添加一个部件。`boostRadius`：需要神经加粗时为其管半径，否则为 null。返回实例 id（三个批次中相同）。
   * Add a part. `boostRadius` is its tube radius when it should be thickened by the nerve
   * aid, or null. Returns the instance id (the same in all three batches).
   */
  add(baked: BakedPart, boostRadius: number | null, _bbox?: readonly number[], _centroid?: readonly number[]): number {
    const g = baked.geometry
    const thin = new Float32Array(g.getAttribute('position').count).fill(boostRadius ?? NOT_BOOSTED)
    g.setAttribute('aThin', new BufferAttribute(thin, 1))
    const nv = thin.length
    // 蒙皮属性先占位（指向 0 号关节、权重 0），绑定数据加载后再填
    // skin attributes are reserved up front and filled in when the rig is loaded
    g.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(nv * 4), 4, true))
    g.setAttribute('skinWeight', new BufferAttribute(new Uint8Array(nv * 4), 4, true))
    const ni = g.index!.count
    if (this.usedVertices + nv > this.maxVertices || this.usedIndices + ni > this.maxIndices) {
      // 顶点数的估计对这个人体偏小：留出余量重新分配
      // the vertex estimate was too small for this body: reallocate with headroom
      this.maxVertices = Math.max(this.usedVertices + nv, Math.ceil(this.maxVertices * 1.3))
      this.maxIndices = Math.max(this.usedIndices + ni, this.maxIndices)
      if (this.count > 0) {
        this.opaque.setGeometrySize(this.maxVertices, this.maxIndices)
        this.shareGeometry()
        this.geometryVersion++
      } else {
        const o = this.opaque as unknown as { _maxVertexCount: number; _maxIndexCount: number }
        o._maxVertexCount = this.maxVertices
        o._maxIndexCount = this.maxIndices
      }
    }
    this.usedVertices += nv
    this.usedIndices += ni
    const gid = this.opaque.addGeometry(g)
    if (this.count === 0) this.shareGeometry()
    for (const b of [this.blend, this.xray]) (b as unknown as BatchInternals)._geometryCount = gid + 1
    const id = this.opaque.addInstance(gid)
    const id2 = this.blend.addInstance(gid)
    const id3 = this.xray.addInstance(gid)
    if (id !== gid || id2 !== id || id3 !== id) throw new Error('soma: batch instance ids diverged')
    const r = this.opaque.getGeometryRangeAt(gid) as { indexStart: number; indexCount: number; vertexStart: number; vertexCount: number }
    this.ranges[id] = { indexStart: r.indexStart, indexCount: r.indexCount, vertexStart: r.vertexStart, vertexCount: r.vertexCount }
    this.opaque.setColorAt(id, this.rgba.set(1, 1, 1, 1))
    this.blend.setColorAt(id, this.rgba)
    this.opaque.setVisibleAt(id, false)
    this.blend.setVisibleAt(id, false)
    this.xray.setVisibleAt(id, false)
    this.count++
    return id
  }

  /**
   * 让混合批和透视批指向不透明批的几何，这样顶点和索引缓冲在 GPU 上只有一份。依赖 three r186 中 BatchedMesh 的内部字段；实例 id 一旦不一致，`add` 会直接报错。
   * Point the blend and x-ray batches at the opaque batch's geometry so the vertex and
   * index buffers exist once on the GPU. Relies on three r186 BatchedMesh internals
   * (`_geometryInfo`, `_geometryCount`, `_geometryInitialized`); `add` fails loudly if the
   * resulting instance ids ever disagree.
   */
  private shareGeometry(): void {
    const src = this.opaque as unknown as BatchInternals
    for (const b of [this.blend, this.xray]) {
      if (b.geometry !== this.opaque.geometry) b.geometry.dispose()
      b.geometry = this.opaque.geometry
      const dst = b as unknown as BatchInternals
      dst._geometryInfo = src._geometryInfo
      dst._geometryInitialized = true
    }
  }

  get size(): number {
    return this.count
  }

  finish(): void {}

  partBuffers(id: number): PartBuffers {
    const r = this.ranges[id]!
    const g = this.opaque.geometry
    const v0 = r.vertexStart
    const v1 = v0 + r.vertexCount
    const index = g.index!.array as Uint32Array | Uint16Array
    return {
      position: (g.getAttribute('position').array as Float32Array).subarray(v0 * 3, v1 * 3),
      normal: (g.getAttribute('normal').array as Float32Array).subarray(v0 * 3, v1 * 3),
      skinIndex: (g.getAttribute('skinIndex').array as Uint16Array).subarray(v0 * 4, v1 * 4),
      skinWeight: (g.getAttribute('skinWeight').array as Uint8Array).subarray(v0 * 4, v1 * 4),
      aux: (g.getAttribute('aThin').array as Float32Array).subarray(v0, v1),
      index: index.subarray(r.indexStart, r.indexStart + r.indexCount),
      indexBase: v0,
    }
  }

  markPositions(id: number): void {
    const r = this.ranges[id]!
    // 位置和法线一起上传（改了位置的部件法线也会重算）/ positions and normals go up together (a rewritten part has its normals recomputed too)
    for (const name of ['position', 'normal']) {
      const a = this.opaque.geometry.getAttribute(name) as BufferAttribute
      a.addUpdateRange(r.vertexStart * 3, r.vertexCount * 3)
      a.needsUpdate = true
    }
  }

  flushSkinAttributes(): void {
    const g = this.opaque.geometry
    for (const name of ['skinIndex', 'skinWeight', 'aThin']) {
      const a = g.getAttribute(name) as BufferAttribute | undefined
      if (a) a.needsUpdate = true
    }
  }

  setSkinning(mode: SkinningMode): void {
    this.materials.setSkinning(mode)
    // 摆姿势后静止包围球不再可信：整批都画（逐实例裁剪关闭）
    // rest bounding spheres are wrong once posed: draw everything (per-instance culling off)
    this.opaque.perObjectFrustumCulled = mode === 'off'
    this.blend.perObjectFrustumCulled = mode === 'off'
    // 关掉逐实例裁剪后，BatchedMesh 只在可见性变化时才重排绘制列表；不强制一次的话，
    // 列表会停在"上一次裁剪后的样子"（例如从面部特写开始摆姿势，拉远后身体其余部分不画）
    // with per-instance culling off, BatchedMesh rebuilds its draw list only when visibility changes;
    // unless forced once, the list stays as last culled (e.g. posing starts at a face close-up and
    // the rest of the body is missing after zooming out)
    for (const b of [this.opaque, this.blend]) (b as unknown as { _visibilityChanged: boolean })._visibilityChanged = true
  }

  /** 共享缓冲的占用情况，供诊断。 */
  /** Fill of the shared buffers, for diagnostics. */
  usage(): { vertices: number; maxVertices: number; indices: number; maxIndices: number; grown: number } {
    return { vertices: this.usedVertices, maxVertices: this.maxVertices, indices: this.usedIndices, maxIndices: this.maxIndices, grown: this.geometryVersion }
  }

  beforeRender(): void {}

  /** 建在共享缓冲之上、只含该部件三角形的几何（用于建 BVH）。 */
  /** A geometry over the shared buffers holding just this part's triangles (for a BVH). */
  pickGeometry(id: number): BufferGeometry {
    const r = this.ranges[id]!
    const shared = this.opaque.geometry
    const g = new BufferGeometry()
    g.setAttribute('position', shared.getAttribute('position'))
    const all = shared.index!.array as Uint32Array | Uint16Array
    g.setIndex(new BufferAttribute(all.subarray(r.indexStart, r.indexStart + r.indexCount), 1))
    return g
  }

  setState(id: number, mode: number, r: number, g: number, b: number, a: number): void {
    if (this.mode[id] !== mode) {
      this.opaque.setVisibleAt(id, mode === MODE_OPAQUE)
      this.blend.setVisibleAt(id, mode === MODE_BLEND)
      this.mode[id] = mode
    }
    if (mode === MODE_OPAQUE) this.opaque.setColorAt(id, this.rgba.set(r, g, b, 1))
    else if (mode === MODE_BLEND) this.blend.setColorAt(id, this.rgba.set(r, g, b, a))
  }

  setXray(id: number, on: boolean): void {
    if (!!this.xrayOn[id] === on) return
    this.xrayOn[id] = on ? 1 : 0
    this.xray.setVisibleAt(id, on)
  }

  /** 爆炸位移，以及用于给混合部件排序的质心（已加位移）。 */
  /** Explode translation, and the centroid (already translated) used to sort blended parts. */
  setOffset(id: number, x: number, y: number, z: number, cx: number, cy: number, cz: number): void {
    this.m4.makeTranslation(x, y, z)
    this.opaque.setMatrixAt(id, this.m4)
    this.blend.setMatrixAt(id, this.m4)
    this.xray.setMatrixAt(id, this.m4)
    this.sortCenters[id * 3] = cx
    this.sortCenters[id * 3 + 1] = cy
    this.sortCenters[id * 3 + 2] = cz
  }

  setCapped(on: boolean): void {
    if (this.capped === on) return
    this.capped = on
    const m = this.opaque.material as MeshStandardNodeMaterial
    m.side = on ? DoubleSide : FrontSide
    m.needsUpdate = true
  }

  get isCapped(): boolean {
    return this.capped
  }

  /** `radiusPerMetre`：每米距离上保证给神经的世界半径（0 为关闭）。 */
  /** `radiusPerMetre`: world radius a nerve is guaranteed per metre of distance (0 = off). */
  setBoost(radiusPerMetre: number): void {
    this.materials.data.boost.value = radiusPerMetre
  }

  dispose(): void {
    const geometry = this.opaque.geometry
    for (const b of [this.opaque, this.blend, this.xray]) {
      ;(b.material as MeshStandardNodeMaterial).dispose()
      b.geometry = new BufferGeometry() // so each batch's dispose() frees only its own textures
      b.dispose()
    }
    geometry.dispose()
  }
}
