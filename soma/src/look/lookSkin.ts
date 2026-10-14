// 写实皮肤层：一块盖住整张皮肤的覆盖网格，带 MHR 的 UV，用写实材质画。
// 它跟其他覆盖层一样经 Viewer.addFollower 跟随皮肤（体型、表情、软组织偏移、蒙皮、爆炸位移）。
// 口腔袋的三角形不在里面：口腔袋另有自己的暗色画法。
// The lifelike skin layer: an overlay mesh over the whole skin, carrying MHR's UVs, drawn with the
// lifelike material. Like the other overlays it follows the skin through Viewer.addFollower (shape,
// expression, soft-tissue offset, skinning, explode offset). The oral pouch triangles are left out:
// the pouch has a dark look of its own.

import { BufferAttribute } from 'three/webgpu'
import type { SkinGeometry } from '../viewer/skinLayer.ts'
import { SkinPatch } from '../viewer/skinPatch.ts'
import { positionNodeFor, type SkinningData, type SkinningMode } from '../viewer/skinning.ts'
import type { LoadedSkinUv } from './load.ts'
import { makeSkinMaterial, type SkinLook } from './skinMaterial.ts'

export class LookSkin {
  readonly patch: SkinPatch
  private readonly material: ReturnType<typeof makeSkinMaterial>

  /** `dropVertices`：碰到这些皮肤顶点的三角形不画（口腔袋）/ `dropVertices`: triangles touching these skin vertices are not drawn (the oral pouch) */
  constructor(
    source: SkinGeometry,
    readonly uv: LoadedSkinUv,
    look: SkinLook,
    private readonly skinning: SkinningData,
    dropVertices: ArrayLike<number> | null = null,
  ) {
    this.material = makeSkinMaterial(look)
    // 与皮肤共面：往相机方向偏一点压住它，但让皱纹层（−1/−2）和疼痛分布层（−2/−4）仍在上面
    // coplanar with the skin: biased towards the camera to sit over it, while the wrinkle layer (−1/−2) and the pain map (−2/−4) still sit above
    this.material.polygonOffset = true
    this.material.polygonOffsetFactor = -1
    this.material.polygonOffsetUnits = -1
    let index = uv.index
    if (dropVertices?.length) {
      const drop = new Uint8Array(uv.data.skinVertexCount)
      for (let i = 0; i < dropVertices.length; i++) drop[dropVertices[i]!] = 1
      const kept: number[] = []
      for (let t = 0; t < uv.index.length; t += 3) {
        const a = uv.index[t]!, b = uv.index[t + 1]!, c = uv.index[t + 2]!
        if (!drop[uv.skinVertex[a]!] && !drop[uv.skinVertex[b]!] && !drop[uv.skinVertex[c]!]) kept.push(a, b, c)
      }
      index = Uint32Array.from(kept)
    }
    this.patch = new SkinPatch(source, null, this.material, undefined, { vertices: uv.skinVertex, index })
    this.patch.mesh.geometry.setAttribute('uv', new BufferAttribute(uv.uv, 2))
    this.patch.mesh.renderOrder = 0
    this.patch.mesh.name = 'lifelike-skin'
    this.setSkinning('off')
  }

  /** UV 网格是否与这张皮肤对得上（按顶点数；皮肤的三角形可能已经拆出了口腔袋）/ Whether the UV mesh fits this skin (by vertex count; the skin's triangles may already have the pouch split off). */
  static fits(source: SkinGeometry, uv: LoadedSkinUv): boolean {
    return uv.data.skinVertexCount * 3 === source.position.length
  }

  /** 每个皮肤顶点取一个 UV（接缝处取第一个副本）；皱纹层等按皮肤顶点索引的覆盖层用 / One UV per skin vertex (the first copy at a seam); for overlays indexed by skin vertex, such as the wrinkle layer. */
  static uvPerSkinVertex(uv: LoadedSkinUv): Float32Array {
    const out = new Float32Array(uv.data.skinVertexCount * 2).fill(-1)
    for (let i = uv.skinVertex.length - 1; i >= 0; i--) {
      const s = uv.skinVertex[i]!
      out[s * 2] = uv.uv[i * 2]!
      out[s * 2 + 1] = uv.uv[i * 2 + 1]!
    }
    return out
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
