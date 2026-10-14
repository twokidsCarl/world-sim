// 按压凹陷的细分显示网格（数据来自 src/softbody/dentmesh.ts）：皮肤的颜色和蒙皮方式，跟着皮肤一起摆姿势。
// 只在皮肤画成不透明时显示（与口腔袋同一条规则）；显示时，被它盖住的皮肤顶点由视图向里收。
// The subdivided display mesh of a press's dent (data from src/softbody/dentmesh.ts): the skin's colour and skinning,
// posed together with the skin. Shown only while the skin is drawn opaque (the oral pouch's rule); while shown, the
// viewer draws the skin vertices it covers inward.

import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardNodeMaterial, type Material } from 'three/webgpu'
import { positionNodeFor, type SkinningData, type SkinningMode } from './skinning.ts'

export interface DentPatchData {
  /** 静止空间的位置（已含凹陷和体位位移），米 / rest-space positions (dent and posture displacement included), metres */
  position: Float32Array
  index: Uint32Array
  corners: Uint32Array
  weights: Float32Array
  /** 被盖住的皮肤顶点，以及显示时它们的位移（xyz）/ the skin vertices covered, and their displacement while shown (xyz) */
  hidden: Uint32Array
  hideOffsets: Float32Array
}

export class DentPatch {
  /** 皮肤色的网格和（有刺激时）疼痛分布层，放在一个组里 / the skin-coloured mesh and (during a stimulus) the pain-map layer, in one group */
  readonly group = new Group()
  readonly mesh: Mesh
  readonly material: MeshStandardNodeMaterial
  private overlay: Mesh | null = null
  private overlayKey: unknown = null
  private geometry: BufferGeometry
  private count = -1
  private mode: SkinningMode | null = null

  constructor(private readonly skinning: SkinningData, color: Color) {
    this.material = new MeshStandardNodeMaterial({ color, roughness: 0.6, metalness: 0 })
    this.geometry = new BufferGeometry()
    this.mesh = new Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.group.add(this.mesh)
    this.group.matrixAutoUpdate = false
    this.group.visible = false
  }

  /**
   * 疼痛分布层：被盖住的那几个皮肤三角形上的颜色由这里接着画（与 PainOverlay 共用材质，权重按角插值）。null 为不画。
   * The pain-map layer: the colours of the skin triangles it covers are carried on here (the PainOverlay's material, weights
   * interpolated from the corners). Null draws none.
   */
  setOverlay(material: Material | null, perSkin: Float32Array | null, d: Pick<DentPatchData, 'corners' | 'weights'>): void {
    if (!material || !perSkin) {
      if (this.overlay) this.overlay.visible = false
      return
    }
    if (!this.overlay || this.overlay.geometry !== this.geometry || this.overlay.material !== material) {
      if (this.overlay) this.group.remove(this.overlay)
      this.overlay = new Mesh(this.geometry, material)
      this.overlay.frustumCulled = false
      this.overlay.renderOrder = 3
      this.group.add(this.overlay)
      this.overlayKey = null
    }
    this.overlay.visible = true
    if (this.overlayKey === perSkin) return
    this.overlayKey = perSkin
    const a = new Float32Array(this.count)
    for (let v = 0; v < this.count; v++) for (let c = 0; c < 3; c++) a[v] = a[v]! + d.weights[v * 3 + c]! * (perSkin[d.corners[v * 3 + c]!] ?? 0)
    this.geometry.setAttribute('aPain', new BufferAttribute(a, 1))
  }

  /** 换数据：顶点数不变时只改位置 / New data: only the positions change while the vertex count stays. */
  set(d: DentPatchData, skinIndex: Uint16Array | null, skinWeight: Uint8Array | null): void {
    const n = d.position.length / 3
    if (n !== this.count) {
      this.geometry.dispose()
      this.geometry = new BufferGeometry()
      this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3))
      this.geometry.setAttribute('normal', new BufferAttribute(new Float32Array(n * 3), 3))
      this.geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(n * 4), 4, true))
      this.geometry.setAttribute('skinWeight', new BufferAttribute(new Uint8Array(n * 4), 4, true))
      this.geometry.setIndex(new BufferAttribute(d.index, 1))
      this.mesh.geometry = this.geometry
      this.overlayKey = null
      this.count = n
      if (skinIndex && skinWeight) this.setInfluences(d, skinIndex, skinWeight)
    }
    const pos = this.geometry.getAttribute('position') as BufferAttribute
    ;(pos.array as Float32Array).set(d.position)
    pos.needsUpdate = true
    const nor = this.geometry.getAttribute('normal') as BufferAttribute
    smoothNormals(d.position, d.index, nor.array as Float32Array)
    nor.needsUpdate = true
  }

  /** 蒙皮权重：三个角的影响按重心坐标合并，取最大的四个 / Skinning weights: the three corners' influences merged by barycentric weight, the four largest kept. */
  setInfluences(d: Pick<DentPatchData, 'corners' | 'weights'>, skinIndex: Uint16Array, skinWeight: Uint8Array): void {
    const ia = this.geometry.getAttribute('skinIndex') as BufferAttribute | undefined
    const wa = this.geometry.getAttribute('skinWeight') as BufferAttribute | undefined
    if (!ia || !wa) return
    const I = ia.array as Uint16Array, W = wa.array as Uint8Array
    const acc = new Map<number, number>()
    for (let v = 0; v < this.count; v++) {
      acc.clear()
      for (let c = 0; c < 3; c++) {
        const s = d.corners[v * 3 + c]!, w = d.weights[v * 3 + c]!
        if (!(w > 0)) continue
        for (let k = 0; k < 4; k++) {
          const wt = skinWeight[s * 4 + k]!
          if (wt) acc.set(skinIndex[s * 4 + k]!, (acc.get(skinIndex[s * 4 + k]!) ?? 0) + w * wt)
        }
      }
      const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      const sum = top.reduce((s, e) => s + e[1], 0) || 1
      let used = 0
      for (let k = 0; k < 4; k++) {
        const e = top[k]
        const b = !e ? 0 : k === top.length - 1 ? 255 - used : Math.round((e[1] / sum) * 255)
        used += b
        I[v * 4 + k] = e ? e[0] : 0
        W[v * 4 + k] = b
      }
    }
    ia.needsUpdate = true
    wa.needsUpdate = true
  }

  setSkinning(mode: SkinningMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.material.positionNode = positionNodeFor(this.skinning, mode, false) as typeof this.material.positionNode
    this.material.needsUpdate = true
  }

  setOffset(x: number, y: number, z: number): void {
    this.group.matrix.makeTranslation(x, y, z)
    this.group.matrixWorldNeedsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}

/** 面积加权的顶点法线 / area-weighted vertex normals */
function smoothNormals(p: Float32Array, idx: Uint32Array, out: Float32Array): void {
  out.fill(0)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    for (const q of [a, b, c]) (out[q] = out[q]! + nx), (out[q + 1] = out[q + 1]! + ny), (out[q + 2] = out[q + 2]! + nz)
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i]!, out[i + 1]!, out[i + 2]!) || 1
    out[i] = out[i]! / l
    out[i + 1] = out[i + 1]! / l
    out[i + 2] = out[i + 2]! / l
  }
}
