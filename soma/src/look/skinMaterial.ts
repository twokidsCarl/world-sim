// 写实皮肤的材质：写实皮肤层和（写实模式下的）皱纹细节层共用同一套参数和贴图，两层着色一致，接缝处看不出来。
// The lifelike skin material: the lifelike skin layer and (in lifelike mode) the wrinkle detail layer share
// one set of parameters and maps, so both shade alike and their border does not show.
//
// 底色 / base colour
//   · 两层皮肤光谱模型的查找表：底色 = 表(Cm, Chd)。模型按 NIST 人体皮肤反射参考数据拟合（tools/look/skin_colour.py）。
//     A lookup table of a two-layer spectral skin model: albedo = table(Cm, Chd). The model is fitted to the
//     NIST reference data set of human skin reflectance (tools/look/skin_colour.py).
//   · Cm = 色调滑块的黑色素 × 部位贴图的倍数（手掌、足底在对数空间里拉向一个与肤色无关的值），Chd = 参照血量 × 部位倍数；
//     部位贴图用 MHR 的 UV（属性 uv）取（tools/look/skin_regions.py）。
//     Cm = the tone slider's melanin × the region map's multiplier (palms and soles pulled in log space to a value
//     independent of skin tone), Chd = the reference blood × the region multiplier; the region map is read with
//     MHR's UVs (attribute uv) (tools/look/skin_regions.py).
//   · 颜色数据没到或坏了：表退成 1×1 的均匀肤色，部位贴图退成"倍数 1"。
//     Without (or with broken) colour data the table falls back to a 1×1 uniform skin tone and the region map to "multiplier 1".
// 其余 / the rest
//   · 菲涅尔：折射率 1.4，F0 ≈ 0.028；粗糙度取部位贴图（唇 0.35，大部分 0.5）；微弱的绒光模拟毳毛
//     Fresnel: IOR 1.4, F0 ≈ 0.028; roughness from the region map (lips 0.35, most skin 0.5); a faint sheen stands in for vellus hair
//   · 次表面：three 的快速厚度近似（MeshSSSNodeMaterial），透光颜色随底色变暗（深肤色的黑色素也挡住透出的光）
//     subsurface: three's fast thickness approximation (MeshSSSNodeMaterial); the transmitted colour darkens with the albedo (melanin of deep skin also blocks the light coming through)

import { ClampToEdgeWrapping, Color, DataTexture, DataUtils, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, type Material, MeshSSSNodeMaterial, NoColorSpace, RGBAFormat, UnsignedByteType } from 'three/webgpu'
import { clamp, exp, exp2, float, log, max, mix, sqrt, texture, uniform, uv, vec2, vec3 } from 'three/tsl'
import type { LoadedSkinColour } from './load.ts'
import { DEFAULT_TONE } from './types.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

/** 没有颜色数据时的均匀底色（sRGB）/ the uniform albedo (sRGB) used without colour data */
const FALLBACK_ALBEDO = 0xd9a688

function lutTexture(data: Uint16Array, n: number): DataTexture {
  const t = new DataTexture(data, n, n, RGBAFormat, HalfFloatType)
  t.colorSpace = NoColorSpace
  t.minFilter = t.magFilter = LinearFilter
  t.wrapS = t.wrapT = ClampToEdgeWrapping
  t.generateMipmaps = false
  t.flipY = false
  t.needsUpdate = true
  return t
}

function regionTexture(data: Uint8Array, w: number, h: number): DataTexture {
  const t = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType)
  t.colorSpace = NoColorSpace
  t.magFilter = LinearFilter
  t.minFilter = w > 1 ? LinearMipmapLinearFilter : LinearFilter
  t.wrapS = t.wrapT = ClampToEdgeWrapping
  t.generateMipmaps = w > 1
  t.flipY = false
  t.needsUpdate = true
  return t
}

/** 半浮点表的双线性查找（与着色器相同的坐标）/ Bilinear lookup in the half-float table (the shader's coordinates). */
export function lookupLut(lut: Uint16Array, n: number, cmMax: number, chdMax: number, cm: number, chd: number): [number, number, number] {
  const x = Math.sqrt(Math.min(1, Math.max(0, cm / cmMax))) * (n - 1)
  const y = Math.sqrt(Math.min(1, Math.max(0, chd / chdMax))) * (n - 1)
  const x0 = Math.min(n - 2, Math.floor(x)), y0 = Math.min(n - 2, Math.floor(y))
  const tx = x - x0, ty = y - y0
  const at = (i: number, j: number, c: number): number => DataUtils.fromHalfFloat(lut[(j * n + i) * 4 + c]!)
  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    out[c] = at(x0, y0, c) * (1 - tx) * (1 - ty) + at(x0 + 1, y0, c) * tx * (1 - ty) + at(x0, y0 + 1, c) * (1 - tx) * ty + at(x0 + 1, y0 + 1, c) * tx * ty
  }
  return out
}

/** 色调（0–100）→ 黑色素体积分数 / tone (0–100) → melanin volume fraction */
export function toneMelanin(tone: number, cmMax: number): number {
  const t = Math.min(100, Math.max(0, tone)) / 100
  return cmMax * t * t
}

/** 几个写实皮肤材质共用的可调参数和贴图 / Tunable parameters and maps shared by every lifelike skin material. */
export class SkinLook {
  /** 粗糙度的比例：0.5 = 按部位贴图 / roughness scale: 0.5 = as the region map says */
  readonly roughness = uniform(0.5)
  /** 透光的颜色和强度：红光在真皮里走得最远 / colour and strength of light seen through thin skin: red travels furthest in the dermis */
  readonly scatter = uniform(new Color(0.85, 0.22, 0.12))
  readonly scatterStrength = uniform(0.35)
  /** 色调对应的黑色素 Cm、参照血量 Chd、手足掌的 ln Cm / the tone's melanin Cm, the reference blood Chd, ln Cm of palms and soles */
  readonly toneCm = uniform(0.0045)
  readonly bloodChd = uniform(0.031)
  readonly palmLnCm = uniform(Math.log(0.018))
  readonly cmMax = uniform(0.5)
  readonly chdMax = uniform(0.3)
  readonly lutSize = uniform(1)
  readonly logScale = uniform(32)
  /** 缺省色调的底色（线性）；透光颜色按它归一 / the albedo of the default tone (linear); the transmitted colour is normalised by it */
  readonly albedoRef = uniform(new Color(FALLBACK_ALBEDO))
  private lut: DataTexture
  private regions: DataTexture
  private readonly lutNodes: N[] = []
  private readonly regionNodes: N[] = []
  private readonly materials = new Set<Material>()
  private colour: LoadedSkinColour | null = null
  private tone: number | null = null

  constructor() {
    const c = new Color(FALLBACK_ALBEDO)
    this.lut = lutTexture(new Uint16Array([c.r, c.g, c.b, 1].map((v) => DataUtils.toHalfFloat(v))), 1)
    this.regions = regionTexture(new Uint8Array([128, 128, 0, 128]), 1, 1)
  }

  /** 现在用的颜色数据 / the colour data in use */
  get data(): LoadedSkinColour | null {
    return this.colour
  }

  /** 换上一个人体的颜色数据（null 退回均匀肤色）/ Use a body's colour data (null falls back to the uniform tone). */
  setColour(colour: LoadedSkinColour | null): void {
    if (colour === this.colour) return
    this.colour = colour
    const old = [this.lut, this.regions]
    if (colour) {
      const d = colour.data
      this.lut = lutTexture(colour.lut, d.lut.size)
      this.regions = regionTexture(colour.regions.data, colour.regions.width, colour.regions.height)
      this.cmMax.value = d.lut.cmMax
      this.chdMax.value = d.lut.chdMax
      this.lutSize.value = d.lut.size
      this.logScale.value = d.regions.logScale
      this.bloodChd.value = d.tone.bloodChd
      this.palmLnCm.value = Math.log(d.regions.palmMelanin)
      const ref = lookupLut(colour.lut, d.lut.size, d.lut.cmMax, d.lut.chdMax, toneMelanin(d.tone.default, d.tone.cmMax), d.tone.bloodChd)
      ;(this.albedoRef.value as Color).setRGB(...ref)
    } else {
      const c = new Color(FALLBACK_ALBEDO)
      this.lut = lutTexture(new Uint16Array([c.r, c.g, c.b, 1].map((v) => DataUtils.toHalfFloat(v))), 1)
      this.regions = regionTexture(new Uint8Array([128, 128, 0, 128]), 1, 1)
      this.lutSize.value = 1
      ;(this.albedoRef.value as Color).set(FALLBACK_ALBEDO)
    }
    for (const n of this.lutNodes) n.value = this.lut
    for (const n of this.regionNodes) n.value = this.regions
    for (const m of this.materials) m.needsUpdate = true
    for (const t of old) t.dispose()
    this.setTone(this.tone)
  }

  /** 色调 0–100；null = 数据的缺省值。返回是否有变化 / Tone 0–100; null = the data's default. Returns whether anything changed. */
  setTone(tone: number | null): boolean {
    this.tone = tone
    const d = this.colour?.data.tone
    const cm = toneMelanin(tone ?? d?.default ?? DEFAULT_TONE, d?.cmMax ?? 0.3126)
    if (cm === this.toneCm.value) return false
    this.toneCm.value = cm
    return true
  }

  /** 着色器节点：部位贴图（RGBA，0–1）/ shader node: the region map (RGBA, 0–1) */
  regionNode(): N {
    const n: N = texture(this.regions, uv())
    this.regionNodes.push(n)
    return n
  }

  /** 着色器节点：查找表 / shader node: the table */
  lutNode(at: N): N {
    const n: N = texture(this.lut, at)
    this.lutNodes.push(n)
    return n
  }

  track(m: Material): void {
    this.materials.add(m)
    m.addEventListener('dispose', () => this.materials.delete(m))
  }

  dispose(): void {
    this.lut.dispose()
    this.regions.dispose()
  }
}

export interface SkinMaterialOptions {
  /** 视空间法线（例如皱纹层的合成法线）；不给就用几何法线 / view-space normal (e.g. the wrinkle layer's composite); geometric normal when absent */
  normalNode?: N
}

export function makeSkinMaterial(look: SkinLook, opts: SkinMaterialOptions = {}): MeshSSSNodeMaterial {
  const m = new MeshSSSNodeMaterial()
  const reg: N = look.regionNode()
  const melMul: N = exp2(reg.r.mul(255).sub(128).div(look.logScale))
  const bloodMul: N = exp2(reg.g.mul(255).sub(128).div(look.logScale))
  // 手足掌：黑色素在对数空间里拉向固定值 / palms and soles: melanin pulled to a fixed value in log space
  const lnCm: N = log(max((look.toneCm as N).mul(melMul), float(1e-6)))
  const cm: N = exp(mix(lnCm, look.palmLnCm, reg.b))
  const chd: N = (look.bloodChd as N).mul(bloodMul)
  const n1: N = (look.lutSize as N).sub(1)
  const at: N = (vec2 as N)(sqrt(clamp(cm.div(look.cmMax), 0, 1)).mul(n1).add(0.5), sqrt(clamp(chd.div(look.chdMax), 0, 1)).mul(n1).add(0.5)).div(look.lutSize)
  const albedo: N = look.lutNode(at).rgb
  m.colorNode = albedo
  m.roughnessNode = reg.a.mul((look.roughness as N).mul(2))
  m.metalness = 0
  m.ior = 1.4
  m.sheen = 0.25
  m.sheenRoughness = 0.8
  m.sheenColor = new Color(0.9, 0.75, 0.68)
  m.thicknessColorNode = (vec3 as N)(look.scatter).mul(look.scatterStrength as N).mul(albedo.div(max(look.albedoRef as N, vec3(1e-3))))
  m.thicknessDistortionNode = float(0.15)
  m.thicknessAmbientNode = float(0.0)
  m.thicknessAttenuationNode = float(0.6)
  m.thicknessPowerNode = float(4.0)
  m.thicknessScaleNode = float(4.0)
  if (opts.normalNode) m.normalNode = opts.normalNode
  look.track(m)
  return m
}
