// 软组织物理的位移着色层：皮肤按每个顶点相对站立的位移上色（颜色由 src/softbody/protocol.ts 的 displacementColors 给出），
// 跟着皮肤摆姿势。与疼痛分布层（stimVisuals.ts 的 PainOverlay）同一种做法：一块覆盖整张皮肤的 SkinPatch。
// The displacement colour layer of the soft-tissue physics: the skin coloured by each vertex's displacement relative to
// standing (colours from displacementColors in src/softbody/protocol.ts), posed with the skin. Built like the pain-map
// layer (PainOverlay in stimVisuals.ts): one SkinPatch covering the whole skin.

import { MeshBasicNodeMaterial } from 'three/webgpu'
import { attribute, varying } from 'three/tsl'
import type { SkinGeometry } from './skinLayer.ts'
import { SkinPatch } from './skinPatch.ts'
import { positionNodeFor, type SkinningData, type SkinningMode } from './skinning.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export class DisplacementOverlay {
  readonly patch: SkinPatch
  readonly material: MeshBasicNodeMaterial

  constructor(
    source: SkinGeometry,
    private readonly skinning: SkinningData,
  ) {
    const c: N = varying(attribute('aDisp', 'vec4'))
    this.material = new MeshBasicNodeMaterial()
    this.material.colorNode = c.xyz
    this.material.opacityNode = c.w
    this.material.transparent = true
    this.material.depthWrite = false
    this.material.polygonOffset = true
    this.material.polygonOffsetFactor = -2
    this.material.polygonOffsetUnits = -4
    this.patch = new SkinPatch(source, null, this.material)
    this.patch.mesh.renderOrder = 2
    this.setSkinning('off')
  }

  /** `rgba`：每个皮肤顶点四个数（0–1）；null 为隐藏 / `rgba`: four numbers (0–1) per skin vertex; null hides the layer. */
  setColors(rgba: Float32Array | null): void {
    this.patch.mesh.visible = !!rgba
    if (!rgba) return
    // 色带按 sRGB 给出（与界面上的图例一致），着色器里是线性值 / the ramp is given in sRGB (as the legend in the UI), the shader works in linear values
    const lin = new Float32Array(rgba.length)
    for (let i = 0; i < rgba.length; i++) {
      const c = rgba[i]!
      lin[i] = i % 4 === 3 ? c : c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    this.patch.setAttribute('aDisp', lin, 4)
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
