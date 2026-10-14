// 静止预览：穿好的衣服按“最近皮肤三角形”绑定跟着皮肤走（体型改变静止位置，蒙皮跟随姿势）。
// 这一步还没有运行时的布料模拟：摆姿势时衣服只是大致跟着身体。
// The static preview: a dressed garment follows the skin through its nearest-skin-triangle binding (the
// body shape moves its rest position, skinning follows the pose). There is no runtime cloth simulation
// yet: in a pose the garment only roughly follows the body.

import { Color, DoubleSide, MeshStandardNodeMaterial } from 'three/webgpu'
import type { SkinGeometry } from '../viewer/skinLayer.ts'
import { SkinPatch } from '../viewer/skinPatch.ts'
import { positionNodeFor, type SkinningData, type SkinningMode } from '../viewer/skinning.ts'
import type { GarmentId, LoadedCloth } from './load.ts'

/** 预览用的颜色（假定值，不是面料的测量颜色）/ Preview colours (assumed, not measured fabric colours). */
export const CLOTH_COLORS: Record<GarmentId, string> = {
  tee: '#e8e4dc',
  pants: '#3b4a63',
  skirt: '#6b4a5a',
  'compression-top': '#2b2f36',
  'sports-bra': '#2f5f73',
  tights: '#23262b',
}

/**
 * 每个衣服顶点：绑定三角形里重心坐标最大的那个皮肤顶点（借它的蒙皮影响）。
 * Each garment vertex: the skin vertex of its bound triangle with the largest barycentric (its skinning influences are borrowed).
 */
function dominantVertex(c: LoadedCloth): Uint32Array {
  const n = c.data.vertexCount
  const out = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    const b1 = c.bindBary[i * 2]!, b2 = c.bindBary[i * 2 + 1]!, b0 = 1 - b1 - b2
    const k = b0 >= b1 && b0 >= b2 ? 0 : b1 >= b2 ? 1 : 2
    out[i] = c.bindVert[i * 3 + k]!
  }
  return out
}

/** 绑定 → 位置的 SkinPatch：皮肤静止位置变了，衣服按绑定重建 / A SkinPatch whose positions come from the binding: when the skin's rest positions change the garment is rebuilt from it. */
class ClothPatch extends SkinPatch {
  private cloth: LoadedCloth | null = null
  /** 每个顶点绑定三角形的三个皮肤顶点 / the three skin vertices of each vertex's bound triangle */
  private corners: Uint32Array | null = null
  private lift = 0

  constructor(source: SkinGeometry, cloth: LoadedCloth, material: MeshStandardNodeMaterial) {
    super(source, null, material, undefined, { vertices: dominantVertex(cloth), index: cloth.index })
    this.cloth = cloth
    this.corners = cloth.bindVert
    this.lift = 0.5 * (cloth.data.fabric.thickness || 0) + 0.001
    this.setPositions(source.position, source.normal)
  }

  override setPositions(position: ArrayLike<number>, normal: ArrayLike<number>): void {
    // 基类构造时会先调一次，那时绑定还没设好 / the base constructor calls this once before the binding is set
    if (!this.cloth || !this.corners) {
      super.setPositions(position, normal)
      return
    }
    const c = this.cloth, I = this.corners
    const geo = this.mesh.geometry
    const pos = geo.getAttribute('position').array as Float32Array
    const nor = geo.getAttribute('normal').array as Float32Array
    const n = c.data.vertexCount
    const outward = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const a = I[i * 3]! * 3, b = I[i * 3 + 1]! * 3, d = I[i * 3 + 2]! * 3
      const b1 = c.bindBary[i * 2]!, b2 = c.bindBary[i * 2 + 1]!, b0 = 1 - b1 - b2
      const e1x = position[b]! - position[a]!, e1y = position[b + 1]! - position[a + 1]!, e1z = position[b + 2]! - position[a + 2]!
      const e2x = position[d]! - position[a]!, e2y = position[d + 1]! - position[a + 1]!, e2z = position[d + 2]! - position[a + 2]!
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
      const l = Math.hypot(nx, ny, nz) || 1
      nx /= l
      ny /= l
      nz /= l
      // 渲染时再往外移半个面料厚度加 1 mm：碰撞只管顶点，粗布网格的三角形中间可能贴到皮肤的细小起伏
      // drawn half a fabric thickness plus 1 mm further out: collisions handle vertices only, and between them the
      // coarse cloth triangles can touch small bumps of the skin
      const h = c.bindOffset[i]! + this.lift
      for (let k = 0; k < 3; k++) {
        const nk = k === 0 ? nx : k === 1 ? ny : nz
        pos[i * 3 + k] = b0 * position[a + k]! + b1 * position[b + k]! + b2 * position[d + k]! + h * nk
      }
      outward[i * 3] = nx
      outward[i * 3 + 1] = ny
      outward[i * 3 + 2] = nz
    }
    // 法线：衣服自己的面法线累加，再翻到与皮肤外法线同侧（各裁片的三角形朝向不一定一致）
    // normals: the garment's own face normals summed, then turned to the skin's outward side (panels need not share a winding)
    nor.fill(0)
    const ix = c.index
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t]! * 3, b = ix[t + 1]! * 3, d = ix[t + 2]! * 3
      const ux = pos[b]! - pos[a]!, uy = pos[b + 1]! - pos[a + 1]!, uz = pos[b + 2]! - pos[a + 2]!
      const vx = pos[d]! - pos[a]!, vy = pos[d + 1]! - pos[a + 1]!, vz = pos[d + 2]! - pos[a + 2]!
      const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
      // 先按第一个角的外向对齐，免得相邻三角形相互抵消 / aligned to the first corner's outward side first, so neighbours do not cancel
      const s = fx * outward[a]! + fy * outward[a + 1]! + fz * outward[a + 2]! >= 0 ? 1 : -1
      for (const q of [a, b, d]) {
        nor[q] = nor[q]! + s * fx
        nor[q + 1] = nor[q + 1]! + s * fy
        nor[q + 2] = nor[q + 2]! + s * fz
      }
    }
    for (let i = 0; i < n; i++) {
      const l = Math.hypot(nor[i * 3]!, nor[i * 3 + 1]!, nor[i * 3 + 2]!) || 1
      nor[i * 3] = nor[i * 3]! / l
      nor[i * 3 + 1] = nor[i * 3 + 1]! / l
      nor[i * 3 + 2] = nor[i * 3 + 2]! / l
    }
    geo.getAttribute('position').needsUpdate = true
    geo.getAttribute('normal').needsUpdate = true
    geo.computeBoundingSphere()
  }
}

/** 一件衣服的预览层（Viewer 的跟随者）/ The preview layer of one garment (a Viewer follower). */
export class ClothLayer {
  readonly patch: SkinPatch
  readonly material: MeshStandardNodeMaterial

  constructor(source: SkinGeometry, readonly cloth: LoadedCloth, private readonly skinning: SkinningData) {
    this.material = new MeshStandardNodeMaterial({ color: new Color(CLOTH_COLORS[cloth.data.garment] ?? '#cccccc'), roughness: 0.92, metalness: 0, side: DoubleSide })
    this.patch = new ClothPatch(source, cloth, this.material)
    this.patch.mesh.name = `cloth:${cloth.data.garment}`
    this.patch.mesh.renderOrder = 2
    this.setSkinning('off')
  }

  /** 这份数据是否属于这张皮肤 / Whether this data belongs to this skin. */
  static fits(source: SkinGeometry, cloth: LoadedCloth): boolean {
    return cloth.data.skinVertexCount * 3 === source.position.length
  }

  setSkinning(mode: SkinningMode): void {
    this.material.positionNode = positionNodeFor(this.skinning, mode, false) as typeof this.material.positionNode
    this.material.needsUpdate = true
  }

  dispose(): void {
    this.patch.dispose()
    this.material.dispose()
  }
}
