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

export const ACCENT = '#3ec7d6'
/** `aThin` value for vertices that must never be thickened. */
const NOT_BOOSTED = 1000
/** Thickened nerves never grow by more than this (metres), however far the camera is. */
const BOOST_MAX = 0.004
/** A nerve of this radius (m) gets exactly the configured minimum; thinner ones get less, thicker more. */
const BOOST_FULL_RADIUS = 0.0011
const BOOST_MIN_WEIGHT = 0.4
const BOOST_MAX_WEIGHT = 1.3

export interface BakedPart {
  geometry: BufferGeometry
  /** Surface area (m²) and enclosed volume (m³) of the baked mesh. */
  area: number
  volume: number
  /** Equivalent tube radius, metres (see `tubeRadius`). */
  radius: number
}

/**
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

/** What the viewer needs from whichever scene representation is in use. */
export interface PartRenderer {
  /** Objects to put in the scene (under the clipping group). */
  readonly objects: Object3D[]
  readonly size: number
  readonly isCapped: boolean
  /** Changes whenever the shared buffers are reallocated (BVHs built on them are then stale). */
  readonly geometryVersion: number
  add(baked: BakedPart, boostRadius: number | null, bbox: readonly number[], centroid: readonly number[]): number
  /** Called after each group of `add` calls (once per loaded system). */
  finish(): void
  /** A geometry holding just this part's triangles in world space (for a BVH). */
  pickGeometry(id: number): BufferGeometry
  setState(id: number, mode: number, r: number, g: number, b: number, a: number): void
  setXray(id: number, on: boolean): void
  setOffset(id: number, x: number, y: number, z: number, cx: number, cy: number, cz: number): void
  setCapped(on: boolean): void
  setBoost(radiusPerMetre: number): void
  /** Hook run just before each render. */
  beforeRender(camera: Camera): void
  dispose(): void
}

export interface PartMaterialSet {
  solid: MeshStandardNodeMaterial
  blended: MeshStandardNodeMaterial
  tint: MeshBasicNodeMaterial
  /** Radius (m) a boosted nerve gains per metre of camera distance; 0 = off. */
  boost: { value: number }
}

/**
 * The three materials every part is drawn with. `colorNode` supplies the per-part RGBA when
 * it does not come from the batch (the per-mesh fallback passes a userData node).
 */
export function makePartMaterials(colorNode: unknown = null): PartMaterialSet {
  const boost = uniform(0)
  const thin = attribute('aThin', 'float')
  // the guaranteed on-screen radius scales with calibre, so trunks read stronger than twigs
  const weight = thin.div(BOOST_FULL_RADIUS).clamp(BOOST_MIN_WEIGHT, BOOST_MAX_WEIGHT)
  const grow = positionLocal.sub(cameraPosition).length().mul(boost).mul(weight).sub(thin).clamp(0, BOOST_MAX)
  const boosted = positionLocal.add(normalLocal.mul(grow))

  const solid = new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0 })
  // Section caps: with a section plane on, this material is double-sided and back faces are
  // written as a flat, unlit, darkened surface colour, so a cut reads as filled.
  solid.outputNode = select(frontFacing, output, vec4(diffuseColor.rgb.mul(0.72), output.a))
  solid.positionNode = boosted

  const blended = new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0 })
  blended.transparent = true
  blended.depthWrite = false
  blended.positionNode = boosted

  const tint = new MeshBasicNodeMaterial({ color: new Color(ACCENT) })
  tint.transparent = true
  tint.opacity = 0.26
  tint.depthTest = false
  tint.depthWrite = false
  tint.positionNode = boosted

  if (colorNode) {
    solid.colorNode = colorNode as typeof solid.colorNode
    blended.colorNode = colorNode as typeof blended.colorNode
  }
  return { solid, blended, tint, boost }
}

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
  private readonly ranges: { indexStart: number; indexCount: number }[] = []
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

  constructor(maxParts: number, vertexCount: number, indexCount: number) {
    const n = Math.max(1, maxParts)
    this.maxVertices = Math.max(3, vertexCount)
    this.maxIndices = Math.max(3, indexCount)
    const { solid, blended, tint } = (this.materials = makePartMaterials())

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
   * Add a part. `boostRadius` is its tube radius when it should be thickened by the nerve
   * aid, or null. Returns the instance id (the same in all three batches).
   */
  add(baked: BakedPart, boostRadius: number | null, _bbox?: readonly number[], _centroid?: readonly number[]): number {
    const g = baked.geometry
    const thin = new Float32Array(g.getAttribute('position').count).fill(boostRadius ?? NOT_BOOSTED)
    g.setAttribute('aThin', new BufferAttribute(thin, 1))
    const nv = thin.length
    const ni = g.index!.count
    if (this.usedVertices + nv > this.maxVertices || this.usedIndices + ni > this.maxIndices) {
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
    const r = this.opaque.getGeometryRangeAt(gid) as { indexStart: number; indexCount: number }
    this.ranges[id] = { indexStart: r.indexStart, indexCount: r.indexCount }
    this.opaque.setColorAt(id, this.rgba.set(1, 1, 1, 1))
    this.blend.setColorAt(id, this.rgba)
    this.opaque.setVisibleAt(id, false)
    this.blend.setVisibleAt(id, false)
    this.xray.setVisibleAt(id, false)
    this.count++
    return id
  }

  /**
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

  /** Fill of the shared buffers, for diagnostics. */
  usage(): { vertices: number; maxVertices: number; indices: number; maxIndices: number; grown: number } {
    return { vertices: this.usedVertices, maxVertices: this.maxVertices, indices: this.usedIndices, maxIndices: this.maxIndices, grown: this.geometryVersion }
  }

  beforeRender(): void {}

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

  /** `radiusPerMetre`: world radius a nerve is guaranteed per metre of distance (0 = off). */
  setBoost(radiusPerMetre: number): void {
    this.materials.boost.value = radiusPerMetre
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
