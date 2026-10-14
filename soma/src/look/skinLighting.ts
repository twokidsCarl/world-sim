// 写实皮肤的光照模型：在 three 的基于物理的模型上加两项。
// The lifelike skin's lighting model: two terms added to three's physically based model.
//
//   · 透光（Barré-Brisebois 和 Bouchard 2011 的快速近似，与 three 的 MeshSSSNodeMaterial 相同的式子）：
//     材质的 thicknessColorNode 由厚度贴图给出，只有薄处（耳廓、指尖）透出红光。
//     Transmission (the fast approximation of Barré-Brisebois & Bouchard 2011, the same expression as three's
//     MeshSSSNodeMaterial): the material's thicknessColorNode comes from the thickness map, so only thin parts
//     (auricle, fingertips) let red light through.
//   · 预积分的漫反射（Penner 和 Borshukov 2011）：直射光的漫反射从朗伯 cos⁺θ 换成查找表 D(θ, 曲率)，
//     弯得厉害的地方明暗交界变软、偏红。实现方式是加上两者之差，three 的其余部分（菲涅尔、绒光）照旧。
//     Pre-integrated diffuse (Penner & Borshukov 2011): direct diffuse switches from Lambert's cos⁺θ to the table
//     D(θ, curvature), so the terminator softens and reddens where the surface bends sharply. It is added as the
//     difference between the two, so the rest of three's model (Fresnel, sheen) stays as it is.

import { MeshSSSNodeMaterial, PhysicalLightingModel } from 'three/webgpu'
import { BRDF_Lambert, diffuseContribution, float, normalView, positionViewDirection, vec2, vec3 } from 'three/tsl'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export interface SkinLightingExtras {
  /** 按表坐标取预积分表 / sample the pre-integrated table at table coordinates */
  preint: (at: N) => N
  /** 曲率坐标 v（0–1）/ the curvature coordinate v (0–1) */
  curvature: N
  /** 表的尺寸 / table size */
  width: number
  height: number
  /** 0 = 关（退回朗伯）/ 0 = off (back to Lambert) */
  on: N
}

class SkinLightingModel extends PhysicalLightingModel {
  constructor(
    clearcoat: boolean,
    sheen: boolean,
    iridescence: boolean,
    anisotropy: boolean,
    transmission: boolean,
    dispersion: boolean,
    private readonly useSSS: boolean,
    private readonly extras: SkinLightingExtras | null,
  ) {
    super(clearcoat, sheen, iridescence, anisotropy, transmission, dispersion)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  direct(input: any, builder: any): void {
    const { lightDirection, lightColor, reflectedLight } = input as { lightDirection: N; lightColor: N; reflectedLight: N }
    if (this.useSSS) {
      const m = builder.material as MeshSSSNodeMaterial & Record<string, N>
      const half: N = (lightDirection as N).add((normalView as N).mul(m.thicknessDistortionNode)).normalize()
      const dot: N = float((positionViewDirection as N).dot(half.negate()).saturate().pow(m.thicknessPowerNode).mul(m.thicknessScaleNode))
      const illu: N = (vec3 as N)(dot.add(m.thicknessAmbientNode).mul(m.thicknessColorNode))
      reflectedLight.directDiffuse.addAssign(illu.mul((m.thicknessAttenuationNode as N).mul(lightColor)))
    }
    super.direct(input, builder)
    const x = this.extras
    if (x) {
      const nl: N = (normalView as N).dot(lightDirection)
      const at: N = (vec2 as N)(nl.mul(0.5).add(0.5).mul(x.width - 1).add(0.5).div(x.width), (x.curvature as N).mul(x.height - 1).add(0.5).div(x.height))
      const pre: N = x.preint(at).rgb
      const lambert: N = (BRDF_Lambert as N)({ diffuseColor: diffuseContribution })
      reflectedLight.directDiffuse.addAssign(pre.sub(nl.clamp()).mul(lightColor).mul(lambert).mul(x.on))
    }
  }
}

/** 皮肤材质：three 的次表面材质换上上面的光照模型 / The skin material: three's subsurface material with the lighting model above. */
export class SkinNodeMaterial extends MeshSSSNodeMaterial {
  skinExtras: SkinLightingExtras | null = null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override setupLightingModel(): any {
    return new SkinLightingModel(this.useClearcoat, this.useSheen, this.useIridescence, this.useAnisotropy, this.useTransmission, this.useDispersion, this.useSSS, this.skinExtras)
  }
}
