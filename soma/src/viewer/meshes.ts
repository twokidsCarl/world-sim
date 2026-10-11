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
  Mesh,
  Sphere,
  Vector3,
  Vector4,
  type Camera,
  type Object3D,
} from 'three/webgpu'
import { userData } from 'three/tsl'
import { DoubleSide, FrontSide } from 'three/webgpu'
import { MODE_BLEND, MODE_HIDDEN, MODE_OPAQUE, makePartMaterials, type BakedPart, type PartBuffers, type PartMaterialSet, type PartRenderer } from './batches.ts'
import { NOT_BOOSTED, type SkinningData, type SkinningMode } from './skinning.ts'


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

  constructor(skinning: SkinningData) {
    this.skinning = skinning
    this.materials = makePartMaterials(skinning, userData('rgba', 'vec4'))
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
      const tint = new Mesh(geometry, this.materials.tint)
      tint.matrixAutoUpdate = false
      tint.visible = false
      tint.renderOrder = 2
      mesh.add(tint)
      this.meshes.push(mesh)
      this.tints.push(tint)
      this.centers.push(e.centroid[0]!, e.centroid[1]!, e.centroid[2]!)
      this.mode.push(MODE_HIDDEN)
      this.objects.push(mesh)
    }
    this.pending = []
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
    mesh.visible = mode !== MODE_HIDDEN
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
    this.centers[id * 3] = cx
    this.centers[id * 3 + 1] = cy
    this.centers[id * 3 + 2] = cz
  }

  setCapped(on: boolean): void {
    if (this.capped === on) return
    this.capped = on
    this.materials.solid.side = on ? DoubleSide : FrontSide
    this.materials.solid.needsUpdate = true
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
      skinIndex: (g.getAttribute('skinIndex').array as Uint16Array).subarray(v0 * 4, v1 * 4),
      skinWeight: (g.getAttribute('skinWeight').array as Uint8Array).subarray(v0 * 4, v1 * 4),
      aux: (g.getAttribute('aThin').array as Float32Array).subarray(v0, v1),
      index: g.index!.array as Uint32Array,
      indexBase: v0,
    }
  }

  markPositions(id: number): void {
    const r = this.ranges[id]!
    const a = this.meshes[id]!.geometry.getAttribute('position') as BufferAttribute
    a.addUpdateRange(r.vertexStart * 3, r.vertexCount * 3)
    a.needsUpdate = true
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
