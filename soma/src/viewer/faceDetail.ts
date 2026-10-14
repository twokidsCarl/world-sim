// 皱纹细节层：只盖住面部的一块皮肤，在片元阶段按动作单元的强度混合几层法线贴图。
// The wrinkle detail layer: a patch over the face only, blending a few normal-map layers by action-unit
// intensity in the fragment stage.
//
// 做法 / How
//   · 面部那些带 UV 的顶点另成一块网格（SkinPatch），跟着皮肤变形；只在皮肤画成不透明、且至少一层的权重
//     不为零时才画，画在皮肤同一位置上（多边形偏移让它压住下面的皮肤）。权重全为零时这块网格不可见，没有开销。
//     The face vertices that carry a UV form a mesh of their own (SkinPatch) that deforms with the skin. It is
//     drawn only while the skin is opaque and at least one layer weight is non-zero, in the skin's place
//     (polygon offset puts it over the skin underneath). With all weights zero it is invisible and costs nothing.
//   · 公式与 tools/face/detail.ts 的 compositeNormal 相同：每层手动双线性取四个纹素，逐纹素换成斜率
//     g = n.xy / max(n.z, 0.05)（|n| < 0.006 记为 0），按权重相加，n = normalize(g.x, g.y, 1)。
//     The formula is compositeNormal of tools/face/detail.ts: four texels per layer, bilinear by hand, each
//     turned into a slope g = n.xy / max(n.z, 0.05) (|n| < 0.006 counts as 0), summed by weight,
//     n = normalize(g.x, g.y, 1).
//   · 切线空间在片元里由导数得到：T 是切平面内 u 增大的方向（由视空间位置和 UV 的屏幕导数算出），B = N × T，
//     N 是位移和蒙皮之后的几何法线。这样不需要逐顶点切线，两个后端、任何姿势下都成立。
//     The tangent frame comes from derivatives in the fragment: T is the direction of increasing u in the
//     tangent plane (from the screen derivatives of view position and UV), B = N × T, and N is the geometric
//     normal after displacement and skinning. No per-vertex tangents; holds on both backends and in any pose.

import { Color, DataTexture, MeshStandardNodeMaterial, NearestFilter, RGBAFormat, UnsignedByteType } from 'three/webgpu'
import { Fn, If, abs, attribute, cross, dFdx, dFdy, dot, float, floor, int, ivec2, max, min, normalView, positionView, select, sign, textureLoad, uniform, varying, vec2, vec3, vec4 } from 'three/tsl'
import type { LoadedDetail } from '../pain/detail.ts'
import { makeSkinMaterial, type SkinLook } from '../look/skinMaterial.ts'
import type { SkinGeometry } from './skinLayer.ts'
import { SkinPatch } from './skinPatch.ts'
import { positionNodeFor, type SkinningData, type SkinningMode } from './skinning.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

/** 验证用的输出：正常着色 / 输出 UV / 输出合成的切线空间法线 / Output for verification: shaded / the UV / the composite tangent-space normal. */
export type DetailDebug = 'off' | 'uv' | 'normal'

export class FaceDetailLayer {
  readonly patch: SkinPatch
  private readonly material: MeshStandardNodeMaterial
  private readonly atlas: DataTexture
  private readonly weights: { value: number }[]
  private readonly color = uniform(new Color(0xffffff))
  private active = false
  /** 合成后的视空间法线；写实材质也用它 / the composite view-space normal; the lifelike material uses it too */
  private readonly viewNormal: N
  /** 写实模式下换上的材质（与写实皮肤同一套参数）/ the material swapped in for the lifelike mode (same parameters as the lifelike skin) */
  private lookMaterial: ReturnType<typeof makeSkinMaterial> | null = null
  private skinningMode: SkinningMode = 'off'

  constructor(
    source: SkinGeometry,
    readonly detail: LoadedDetail,
    private readonly skinning: SkinningData,
  ) {
    const { data, atlas } = detail
    this.atlas = new DataTexture(atlas.data, atlas.width, atlas.height, RGBAFormat, UnsignedByteType)
    // 线性数据，逐纹素读取（双线性在着色器里自己做，与参考实现逐项一致）
    // linear data read texel by texel (the bilinear blend is done in the shader, term for term as the reference)
    this.atlas.minFilter = this.atlas.magFilter = NearestFilter
    this.atlas.generateMipmaps = false
    this.atlas.flipY = false
    this.atlas.needsUpdate = true
    const weights = data.layers.map(() => uniform(0))
    this.weights = weights as unknown as { value: number }[]

    const T = data.atlas.tile
    const uv: N = varying(attribute('detailUv', 'vec2'))
    const tangentNormal: N = Fn(() => {
      const fx: N = (uv.x as N).clamp(0, 1).mul(T - 1)
      const fy: N = float(1).sub((uv.y as N).clamp(0, 1)).mul(T - 1)
      const x0: N = min(float(T - 2), floor(fx))
      const y0: N = min(float(T - 2), floor(fy))
      const tx: N = fx.sub(x0)
      const ty: N = fy.sub(y0)
      const g: N = (vec2 as N)(0).toVar()
      const slope = (col: number, row: number, dx: number, dy: number): N => {
        const t: N = (textureLoad as N)(this.atlas, (ivec2 as N)(int(x0.add(col * T + dx + 0.5)), int(y0.add(row * T + dy + 0.5))))
        // 8 位值 → n = byte / 127.5 − 1 / 8-bit value → n = byte / 127.5 − 1
        const n: N = t.rgb.mul(255 / 127.5).sub(1)
        const nz: N = max(float(0.05), n.z)
        return (vec2 as N)(select((abs(n.x) as N).lessThan(0.006), float(0), n.x.div(nz)), select((abs(n.y) as N).lessThan(0.006), float(0), n.y.div(nz)))
      }
      data.layers.forEach((layer, l) => {
        const w: N = weights[l]!
        If(w.greaterThan(0), () => {
          const [col, row] = layer.tile
          const top: N = slope(col, row, 0, 0).mul(float(1).sub(tx)).add(slope(col, row, 1, 0).mul(tx))
          const bottom: N = slope(col, row, 0, 1).mul(float(1).sub(tx)).add(slope(col, row, 1, 1).mul(tx))
          g.addAssign(top.mul(float(1).sub(ty)).add(bottom.mul(ty)).mul(w))
        })
      })
      return (vec3 as N)(g, 1).normalize()
    })()

    const viewNormal: N = Fn(() => {
      const nrm: N = normalView
      const p: N = positionView
      const dp1: N = dFdx(p), dp2: N = dFdy(p)
      const du1: N = dFdx(uv), du2: N = dFdy(uv)
      // ∂p/∂u ∝ (dp1·dv2 − dp2·dv1)，符号由 UV 雅可比行列式定（翻转的三角形也得到"u 增大的方向"）
      // ∂p/∂u ∝ (dp1·dv2 − dp2·dv1), signed by the UV Jacobian (so flipped triangles still give "increasing u")
      const det: N = du1.x.mul(du2.y).sub(du2.x.mul(du1.y))
      const raw: N = dp1.mul(du2.y).sub(dp2.mul(du1.y)).mul(sign(det))
      const inPlane: N = raw.sub(nrm.mul(dot(nrm, raw)))
      const len: N = inPlane.length()
      const n: N = tangentNormal
      const out: N = (vec3 as N)(nrm).toVar()
      // UV 退化（行列式为零）的像素保持几何法线 / pixels where the UV is degenerate keep the geometric normal
      If(len.greaterThan(1e-12), () => {
        const t: N = inPlane.div(len)
        const b: N = cross(nrm, t)
        out.assign(t.mul(n.x).add(b.mul(n.y)).add(nrm.mul(n.z)).normalize())
      })
      return out
    })()

    this.material = new MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 })
    this.material.colorNode = this.color as N
    this.material.normalNode = viewNormal
    this.viewNormal = viewNormal
    // 与皮肤共面：往相机方向偏一点，压住下面的皮肤 / coplanar with the skin: biased towards the camera to sit over it
    this.material.polygonOffset = true
    this.material.polygonOffsetFactor = -1
    this.material.polygonOffsetUnits = -2
    // 验证用：直接输出 UV 或合成的切线空间法线（不受光照）
    // for verification: output the UV or the composite tangent-space normal directly (unlit)
    this.debugNodes = { uv: (vec3 as N)(uv, 0), normal: tangentNormal }
    this.patch = new SkinPatch(source, detail.vertices, this.material)
    this.patch.setAttribute('detailUv', detail.uv, 2)
    this.patch.mesh.renderOrder = 0
    this.setSkinning('off')
  }

  private readonly debugNodes: { uv: N; normal: N }
  private debugMode: DetailDebug = 'off'

  /** 细节数据是否与这张皮肤网格对得上 / Whether the detail data fits this skin mesh. */
  static fits(source: SkinGeometry, detail: LoadedDetail): boolean {
    return detail.data.vertexCount * 3 === source.position.length
  }

  /** 设各层权重；返回这一层现在是否要画 / Set the layer weights; returns whether the layer should be drawn now. */
  setWeights(w: readonly number[]): boolean {
    let any = false
    this.weights.forEach((u, i) => {
      u.value = w[i] ?? 0
      if (u.value > 0) any = true
    })
    this.active = any
    return any
  }

  get hasWeight(): boolean {
    return this.active
  }

  setColor(c: Color): void {
    ;(this.color.value as Color).copy(c)
  }

  setSkinning(mode: SkinningMode): void {
    this.skinningMode = mode
    for (const m of [this.material, this.lookMaterial]) {
      if (!m) continue
      m.positionNode = positionNodeFor(this.skinning, mode, false) as typeof m.positionNode
      m.needsUpdate = true
    }
  }

  /**
   * 写实模式：用写实皮肤的材质画（皱纹法线不变），`uv` 是每个皮肤顶点的写实 UV；null 换回原来的材质。
   * Lifelike mode: draw with the lifelike skin material (same wrinkle normal); `uv` is the lifelike UV per
   * skin vertex. null switches back to the plain material.
   */
  useLook(look: SkinLook | null, uv: Float32Array | null): void {
    if (look && uv) {
      if (!this.lookMaterial) {
        const m = makeSkinMaterial(look, { normalNode: this.viewNormal })
        m.polygonOffset = true
        m.polygonOffsetFactor = -1
        m.polygonOffsetUnits = -2
        this.lookMaterial = m
        this.patch.setAttribute('uv', uv, 2)
        // 与写实皮肤层同一份静止姿势，三平面细节在两层上对得上 / the same rest pose as the lifelike layer, so the triplanar detail matches across both
        if (look.rest) {
          this.patch.setAttribute('restPosition', look.rest.position, 3)
          this.patch.setAttribute('restNormal', look.rest.normal, 3)
        }
        this.setSkinning(this.skinningMode)
      }
      this.patch.mesh.material = this.lookMaterial
    } else {
      this.patch.mesh.material = this.material
    }
  }

  /** 验证用：切换输出 / Verification: switch the output. */
  setDebug(mode: DetailDebug): void {
    if (mode === this.debugMode) return
    this.debugMode = mode
    this.material.outputNode = mode === 'off' ? null : (vec4 as N)(this.debugNodes[mode], 1)
    this.material.needsUpdate = true
  }

  dispose(): void {
    this.patch.dispose()
    this.material.dispose()
    this.lookMaterial?.dispose()
    this.atlas.dispose()
  }
}
