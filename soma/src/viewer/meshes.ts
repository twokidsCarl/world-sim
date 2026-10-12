// 合块（第 9 轮）：每个系统另有一个"块"网格，用同一套顶点缓冲和一个合并的索引缓冲，一次绘制画出该系统里
// 所有"不透明、没有爆炸位移"的部件；这些部件自己的网格此时不画。逐部件的颜色和"是否归块画"放在一张
// 数据纹理里，按顶点属性 aPart 查；不归块画的部件的顶点在顶点着色器里收成一个点。半透明、被爆炸移开的
// 部件仍旧逐个绘制（需要按深度排序 / 各自的平移）。这样默认视图的绘制次数从三千多降到几十。
// Chunks (round 9): each system also has one "chunk" mesh over the same vertex buffers and one
// merged index buffer, which draws every part of that system that is opaque and not moved by the
// explode view in a single draw; those parts' own meshes are then not drawn. Per-part colour and
// "drawn by the chunk" live in a data texture looked up by the vertex attribute aPart; vertices of
// parts the chunk does not draw collapse to a point in the vertex shader. See-through and exploded
// parts are still drawn one by one (they need depth sorting / their own translation). The default
// view goes from over three thousand draws to a few dozen.
//
// 回退的场景表示：每个部件一个网格，用于 WebGL2 后端。合批路径从一个大索引缓冲里发出几千次子绘制，Chrome 的 WebGL2（ANGLE on Metal）会随“子绘制数 × 索引缓冲大小”变慢（2000 个部件时 385 毫秒一帧），所以 WebGL2 下每个部件单独绘制、各有自己的小索引缓冲；顶点缓冲仍然共享，颜色来自逐对象 uniform，材质与合批路径相同。
// Fallback scene representation: one Mesh per part, used on the WebGL2 backend.
//
// The batched path (batches.ts) issues thousands of sub-draws out of ONE large index buffer.
// On WebGPU that is ideal, but Chrome's WebGL2 (ANGLE on Metal) gets slower with
// (number of sub-draws × index-buffer size): measured 385 ms/frame at 2,000 parts and a lost
// context at 3,179. So on WebGL2 each part is its own draw with its own small index buffer;
// vertex buffers are still shared, colour comes from a per-object uniform, and the three
// materials are the same ones the batched path uses.

import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  Mesh,
  NearestFilter,
  RGBAFormat,
  Sphere,
  Vector3,
  Vector4,
  type Camera,
  type Object3D,
} from 'three/webgpu'
import { attribute, float, int, ivec2, textureLoad, userData, varying, vec4 } from 'three/tsl'
import { DoubleSide, FrontSide } from 'three/webgpu'
import { MODE_BLEND, MODE_HIDDEN, MODE_OPAQUE, makePartMaterials, type BakedPart, type PartBuffers, type PartMaterialSet, type PartRenderer } from './batches.ts'
import { NOT_BOOSTED, type SkinningData, type SkinningMode } from './skinning.ts'


/** 部件状态纹理的宽度与行数（容量 = 两者之积）/ Width and rows of the part-state texture (capacity = their product). */
const STATE_W = 1024
const STATE_ROWS = 8

interface Entry {
  baked: BakedPart
  boost: number
  bbox: readonly number[]
  centroid: readonly number[]
}

export class PartMeshes implements PartRenderer {
  readonly objects: Object3D[] = []
  private readonly materials: PartMaterialSet
  private pending: Entry[] = []
  private meshes: Mesh[] = []
  private tints: Mesh[] = []
  private readonly centers: number[] = []
  private readonly mode: number[] = []
  private capped = false
  readonly geometryVersion = 0
  private readonly fwd = new Vector3()
  private readonly cam = new Vector3()

  readonly skinning: SkinningData
  private readonly ranges: { vertexStart: number; vertexCount: number }[] = []

  /** 每个部件一个纹素：rgb 颜色，a = 1 表示由块绘制 / One texel per part: rgb colour, a = 1 when the chunk draws it. */
  private readonly state: DataTexture
  private readonly stateData: Float32Array
  private readonly chunkMaterials: PartMaterialSet
  private readonly chunks: Mesh[] = []
  private readonly moved: boolean[] = []
  /** 关掉合块（?chunks=0，对照测量用）/ Chunks switched off (?chunks=0, for before/after measurements). */
  private readonly chunked: boolean

  constructor(skinning: SkinningData, chunked = true) {
    this.skinning = skinning
    this.chunked = chunked
    this.materials = makePartMaterials(skinning, userData('rgba', 'vec4'))
    this.stateData = new Float32Array(STATE_W * STATE_ROWS * 4)
    this.state = new DataTexture(this.stateData, STATE_W, STATE_ROWS, RGBAFormat, FloatType)
    this.state.minFilter = this.state.magFilter = NearestFilter
    this.state.generateMipmaps = false
    this.state.needsUpdate = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const N = (x: unknown): any => x
    const id = N(attribute('aPart', 'float')).add(0.5)
    const row = id.div(STATE_W).floor()
    const texel = varying(N(textureLoad)(this.state, N(ivec2)(int(id.sub(row.mul(STATE_W))), int(row))))
    this.chunkMaterials = makePartMaterials(skinning, N(vec4)(N(texel).rgb, float(1)), (node) => N(node).mul(N(texel).a))
  }

  get size(): number {
    return this.pending.length + this.meshes.length
  }

  get isCapped(): boolean {
    return this.capped
  }

  add(baked: BakedPart, boostRadius: number | null, bbox: readonly number[], centroid: readonly number[]): number {
    this.pending.push({ baked, boost: boostRadius ?? NOT_BOOSTED, bbox, centroid })
    return this.meshes.length + this.pending.length - 1
  }

  /**
   * 把上次调用之后加入的部件的顶点拼进共享缓冲（每个系统一套），并创建它们的网格。
   * Concatenate the vertices of the parts added since the last call into shared buffers
   * (one set per loaded system) and create their meshes.
   */
  finish(): void {
    if (this.pending.length === 0) return
    let vertices = 0
    for (const e of this.pending) vertices += e.baked.geometry.getAttribute('position').count
    const position = new BufferAttribute(new Float32Array(vertices * 3), 3)
    const normal = new BufferAttribute(new Float32Array(vertices * 3), 3)
    const thin = new BufferAttribute(new Float32Array(vertices), 1)
    // 蒙皮属性先占位，绑定数据加载后再填 / skin attributes are reserved now and filled in when the rig loads
    const skinIndex = new BufferAttribute(new Uint16Array(vertices * 4), 4, true)
    const skinWeight = new BufferAttribute(new Uint8Array(vertices * 4), 4, true)
    const partId = new BufferAttribute(new Float32Array(this.chunked ? vertices : 0), 1)
    let indices = 0
    for (const e of this.pending) indices += e.baked.geometry.index!.count
    const merged = new Uint32Array(this.chunked ? indices : 0)
    let io = 0
    let vo = 0
    for (const e of this.pending) {
      const g = e.baked.geometry
      const count = g.getAttribute('position').count
      ;(position.array as Float32Array).set(g.getAttribute('position').array, vo * 3)
      ;(normal.array as Float32Array).set(g.getAttribute('normal').array, vo * 3)
      ;(thin.array as Float32Array).fill(e.boost, vo, vo + count)
      const src = g.index!.array
      const index = new Uint32Array(src.length)
      for (let i = 0; i < src.length; i++) index[i] = src[i]! + vo
      if (this.chunked) {
        merged.set(index, io)
        io += index.length
        ;(partId.array as Float32Array).fill(this.meshes.length, vo, vo + count)
      }
      this.ranges.push({ vertexStart: vo, vertexCount: count })
      vo += count

      const geometry = new BufferGeometry()
      geometry.setAttribute('position', position)
      geometry.setAttribute('normal', normal)
      geometry.setAttribute('aThin', thin)
      geometry.setAttribute('skinIndex', skinIndex)
      geometry.setAttribute('skinWeight', skinWeight)
      geometry.setIndex(new BufferAttribute(index, 1))
      // 包围盒取自数据文件：自己算的话每个部件都要扫一遍整个共享缓冲
      // bounds from the data file: computing them would scan the whole shared buffer per part
      const b = e.bbox
      geometry.boundingBox = new Box3(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]))
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new Sphere())
      geometry.boundingSphere.radius += 0.005 // room for thickened nerves

      const mesh = new Mesh(geometry, this.materials.solid)
      mesh.matrixAutoUpdate = false
      mesh.visible = false
      mesh.userData.rgba = new Vector4(1, 1, 1, 1)
      mesh.userData.sortZ = 0
      // 选中的透视着色是独立的网格，不挂在部件网格下：部件交给块绘制时自己的网格是隐藏的
      // the selection tint is a separate mesh, not a child: the part's own mesh is hidden while the chunk draws it
      const tint = new Mesh(geometry, this.materials.tint)
      tint.matrixAutoUpdate = false
      tint.visible = false
      tint.renderOrder = 2
      this.objects.push(tint)
      this.moved.push(false)
      this.meshes.push(mesh)
      this.tints.push(tint)
      this.centers.push(e.centroid[0]!, e.centroid[1]!, e.centroid[2]!)
      this.mode.push(MODE_HIDDEN)
      this.objects.push(mesh)
    }
    this.pending = []
    if (this.chunked && merged.length > 0) {
      if (this.meshes.length > STATE_W * STATE_ROWS) throw new Error('too many parts for the part-state texture')
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', position)
      geometry.setAttribute('normal', normal)
      geometry.setAttribute('aThin', thin)
      geometry.setAttribute('skinIndex', skinIndex)
      geometry.setAttribute('skinWeight', skinWeight)
      geometry.setAttribute('aPart', partId)
      geometry.setIndex(new BufferAttribute(merged, 1))
      const chunk = new Mesh(geometry, this.chunkMaterials.solid)
      chunk.matrixAutoUpdate = false
      // 块里的部件各自可见与否由着色器决定，包围盒没有意义 / which of its parts show is decided in the shader, so bounds mean nothing
      chunk.frustumCulled = false
      this.chunks.push(chunk)
      this.objects.push(chunk)
    }
  }

  pickGeometry(id: number): BufferGeometry {
    const g = this.meshes[id]!.geometry
    const out = new BufferGeometry()
    out.setAttribute('position', g.getAttribute('position'))
    out.setIndex(g.index)
    return out
  }

  setState(id: number, mode: number, r: number, g: number, b: number, a: number): void {
    const mesh = this.meshes[id]!
    this.mode[id] = mode
    // 不透明且没有被爆炸移开的部件交给块绘制 / an opaque part not moved by the explode view is drawn by its chunk
    const inChunk = this.chunked && mode === MODE_OPAQUE && !this.moved[id]
    const t = id * 4
    const d = this.stateData
    const flag = inChunk ? 1 : 0
    if (d[t] !== r || d[t + 1] !== g || d[t + 2] !== b || d[t + 3] !== flag) {
      d[t] = r
      d[t + 1] = g
      d[t + 2] = b
      d[t + 3] = flag
      this.state.needsUpdate = true
    }
    mesh.visible = mode !== MODE_HIDDEN && !inChunk
    if (mode === MODE_HIDDEN) return
    const material = mode === MODE_OPAQUE ? this.materials.solid : this.materials.blended
    if (mesh.material !== material) mesh.material = material
    ;(mesh.userData.rgba as Vector4).set(r, g, b, mode === MODE_OPAQUE ? 1 : a)
  }

  setXray(id: number, on: boolean): void {
    this.tints[id]!.visible = on
  }

  setOffset(id: number, x: number, y: number, z: number, cx: number, cy: number, cz: number): void {
    const mesh = this.meshes[id]!
    mesh.matrix.makeTranslation(x, y, z)
    mesh.matrixWorldNeedsUpdate = true
    const tint = this.tints[id]!
    tint.matrix.copy(mesh.matrix)
    tint.matrixWorldNeedsUpdate = true
    const moved = x !== 0 || y !== 0 || z !== 0
    if (moved !== this.moved[id]) {
      // 被移开的部件回到逐个绘制；颜色原样保留 / a moved part goes back to its own draw; the colour is kept
      this.moved[id] = moved
      const t = id * 4
      const rgba = mesh.userData.rgba as Vector4
      if (this.mode[id] === MODE_OPAQUE) this.setState(id, MODE_OPAQUE, this.stateData[t]!, this.stateData[t + 1]!, this.stateData[t + 2]!, rgba.w)
    }
    this.centers[id * 3] = cx
    this.centers[id * 3 + 1] = cy
    this.centers[id * 3 + 2] = cz
  }

  setCapped(on: boolean): void {
    if (this.capped === on) return
    this.capped = on
    for (const m of [this.materials.solid, this.chunkMaterials.solid]) {
      m.side = on ? DoubleSide : FrontSide
      m.needsUpdate = true
    }
  }

  setBoost(radiusPerMetre: number): void {
    this.materials.data.boost.value = radiusPerMetre
  }

  partBuffers(id: number): PartBuffers {
    const g = this.meshes[id]!.geometry
    const r = this.ranges[id]!
    const v0 = r.vertexStart
    const v1 = v0 + r.vertexCount
    return {
      position: (g.getAttribute('position').array as Float32Array).subarray(v0 * 3, v1 * 3),
      normal: (g.getAttribute('normal').array as Float32Array).subarray(v0 * 3, v1 * 3),
      skinIndex: (g.getAttribute('skinIndex').array as Uint16Array).subarray(v0 * 4, v1 * 4),
      skinWeight: (g.getAttribute('skinWeight').array as Uint8Array).subarray(v0 * 4, v1 * 4),
      aux: (g.getAttribute('aThin').array as Float32Array).subarray(v0, v1),
      index: g.index!.array as Uint32Array,
      indexBase: v0,
    }
  }

  markPositions(id: number): void {
    const r = this.ranges[id]!
    for (const name of ['position', 'normal']) {
      const a = this.meshes[id]!.geometry.getAttribute(name) as BufferAttribute
      a.addUpdateRange(r.vertexStart * 3, r.vertexCount * 3)
      a.needsUpdate = true
    }
  }

  flushSkinAttributes(): void {
    const seen = new Set<unknown>()
    for (const m of this.meshes) {
      for (const name of ['skinIndex', 'skinWeight', 'aThin']) {
        const a = m.geometry.getAttribute(name) as BufferAttribute
        if (!seen.has(a)) {
          seen.add(a)
          a.needsUpdate = true
        }
      }
    }
  }

  setSkinning(mode: SkinningMode): void {
    this.materials.setSkinning(mode)
    this.chunkMaterials.setSkinning(mode)
    // 摆姿势后数据文件里的包围盒不再可信：不做视锥裁剪
    // the data file's bounds are wrong once posed: no frustum culling
    for (const m of this.meshes) m.frustumCulled = mode === 'off'
  }

  /** 每个混合部件质心的观察深度，供渲染器的透明排序读取。 */
  /** View depth of each blended part's centroid, read by the renderer's transparent sort. */
  beforeRender(camera: Camera): void {
    this.cam.setFromMatrixPosition(camera.matrixWorld)
    this.fwd.set(0, 0, -1).transformDirection(camera.matrixWorld)
    const c = this.centers
    for (let i = 0; i < this.meshes.length; i++) {
      if (this.mode[i] !== MODE_BLEND) continue
      this.meshes[i]!.userData.sortZ =
        (c[i * 3]! - this.cam.x) * this.fwd.x + (c[i * 3 + 1]! - this.cam.y) * this.fwd.y + (c[i * 3 + 2]! - this.cam.z) * this.fwd.z
    }
  }

  dispose(): void {
    // 顶点属性按系统共享；逐个释放几何，最后一个使用者释放后才真正释放
    // vertex attributes are shared per system; disposing each geometry releases them once all users are gone
    for (const m of this.meshes) m.geometry.dispose()
    for (const c of this.chunks) c.geometry.dispose()
    this.state.dispose()
    for (const m of [this.chunkMaterials.solid, this.chunkMaterials.blended, this.chunkMaterials.tint]) m.dispose()
    this.materials.solid.dispose()
    this.materials.blended.dispose()
    this.materials.tint.dispose()
  }
}

/** 逐网格路径的透明排序：按部件质心深度从后往前。 */
/** Transparent sort for the per-mesh path: back to front by part centroid depth. */
export function centroidTransparentSort(
  a: { renderOrder: number; object: Object3D; id: number },
  b: { renderOrder: number; object: Object3D; id: number },
): number {
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder
  const za = (a.object.userData.sortZ as number | undefined) ?? 0
  const zb = (b.object.userData.sortZ as number | undefined) ?? 0
  return zb - za || a.id - b.id
}
