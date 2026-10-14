// 写实皮肤的材质：写实皮肤层和（写实模式下的）皱纹细节层共用同一套参数，两层着色一致，接缝处看不出来。
// The lifelike skin material: the lifelike skin layer and (in lifelike mode) the wrinkle detail layer share
// one set of parameters, so both shade alike and their border does not show.
//
// 现在的参数（都是假设，第一阶段会换成按数据标定的贴图）/ current parameters (all assumed; phase 1 replaces them by maps calibrated against data):
//   · 底色：一个均匀的肤色 / base colour: one uniform skin tone
//   · 菲涅尔：折射率 1.4，F0 ≈ 0.028（皮肤表面脂质层的常用值）/ Fresnel: IOR 1.4, F0 ≈ 0.028 (the usual value for skin's surface lipids)
//   · 粗糙度 0.5；微弱的绒光模拟毳毛 / roughness 0.5; a faint sheen stands in for vellus hair
//   · 次表面：three 的快速厚度近似（MeshSSSNodeMaterial），厚度取常数 / subsurface: three's fast thickness approximation (MeshSSSNodeMaterial) with a constant thickness

import { Color, MeshSSSNodeMaterial } from 'three/webgpu'
import { float, uniform, vec3 } from 'three/tsl'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

/** 几个写实皮肤材质共用的可调参数 / Tunable parameters shared by every lifelike skin material. */
export class SkinLook {
  /** 底色（线性）/ base colour (linear) */
  readonly albedo = uniform(new Color(0xd9a688))
  readonly roughness = uniform(0.5)
  /** 透光的颜色和强度：红光在真皮里走得最远 / colour and strength of light seen through thin skin: red travels furthest in the dermis */
  readonly scatter = uniform(new Color(0.85, 0.22, 0.12))
  readonly scatterStrength = uniform(0.35)
}

export interface SkinMaterialOptions {
  /** 视空间法线（例如皱纹层的合成法线）；不给就用几何法线 / view-space normal (e.g. the wrinkle layer's composite); geometric normal when absent */
  normalNode?: N
}

export function makeSkinMaterial(look: SkinLook, opts: SkinMaterialOptions = {}): MeshSSSNodeMaterial {
  const m = new MeshSSSNodeMaterial()
  m.colorNode = look.albedo as N
  m.roughnessNode = look.roughness as N
  m.metalness = 0
  m.ior = 1.4
  m.sheen = 0.25
  m.sheenRoughness = 0.8
  m.sheenColor = new Color(0.9, 0.75, 0.68)
  m.thicknessColorNode = (vec3 as N)(look.scatter).mul(look.scatterStrength as N)
  m.thicknessDistortionNode = float(0.15)
  m.thicknessAmbientNode = float(0.0)
  m.thicknessAttenuationNode = float(0.6)
  m.thicknessPowerNode = float(4.0)
  m.thicknessScaleNode = float(4.0)
  if (opts.normalNode) m.normalNode = opts.normalNode
  return m
}
