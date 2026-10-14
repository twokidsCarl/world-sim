// 发片的材质：Karis 2016《Physically Based Hair Shading in Unreal》的 Marschner 式三瓣近似（R、TT、TRT），按论文和公开的
// 文字说明重新实现（没有用 Epic 的代码）；纤维颜色由黑色素浓度算（见 colour.ts）；多次散射用 Karis 的近似（包裹的
// Kajiya 漫射 × √C）。透明用"覆盖率转多重采样覆盖"（alpha-to-coverage）：深度照常写入，不需要排序，WebGPU 和 WebGL2 一样。
// The hair-card material: the Marschner-style three-lobe approximation (R, TT, TRT) of Karis 2016, "Physically Based
// Hair Shading in Unreal", reimplemented from the paper and public written descriptions (no Epic code); the fibre colour
// comes from melanin concentrations (see colour.ts); multiple scattering uses Karis's approximation (a wrapped Kajiya
// diffuse × √C). Transparency is alpha-to-coverage: depth is written as usual, nothing needs sorting, on WebGPU and
// WebGL2 alike.
//
// 每瓣 / per lobe（θ 纵向角、φ 方位角、θd 半差角；s = sinθL + sinθV / θ longitudinal, φ azimuthal, θd half difference; s = sinθL + sinθV）
//   M_p = g(β_p, s − α_p)，g 为高斯；α_R = −2α、α_TT = α、α_TRT = 4α，α = 0.035 弧度（≈ 2°，毛鳞片倾角）；
//         β_R = r²·√2·cos(φ/2)、β_TT = r²/2、β_TRT = 2r²，r 为粗糙度
//   M_p = g(β_p, s − α_p), g a Gaussian; α_R = −2α, α_TT = α, α_TRT = 4α with α = 0.035 rad (≈ 2°, cuticle tilt);
//         β_R = r²·√2·cos(φ/2), β_TT = r²/2, β_TRT = 2r², r the roughness
//   R:   N = ¼·cos(φ/2)，F = F(√(½ + ½·L·V))
//   TT:  η' = 1.19/cosθd + 0.36·cosθd，a = 1/η'，h = cos(φ/2)·(1 + a(0.6 − 0.8cosφ))，
//        F = (1 − F(cosθd·√(1 − h²)))²，T = C^(½·√(1 − h²a²)/cosθd)，N = exp(−3.65cosφ − 3.98)
//   TRT: F = (1 − f)²·f，f = F(½cosθd)，T = C^(0.8/cosθd)，N = exp(17cosφ − 16.78)
//   F 为 Schlick 近似，F0 = ((1.55 − 1)/(1.55 + 1))²（纤维折射率 1.55）/ F is Schlick's with F0 = ((1.55 − 1)/(1.55 + 1))² (fibre index 1.55)

import { DoubleSide, LightingModel, MeshLambertNodeMaterial, MeshStandardNodeMaterial, type PhysicalLightingModel, type Texture } from 'three/webgpu'
import { abs, asin, attribute, clamp, cos, cross, dFdx, dFdy, dot, exp, float, fract, inverseSqrt, length, log2, max, mix, normalFlat, normalViewGeometry, normalize, positionViewDirection, pow, select, sin, smoothstep, sqrt, texture, uniform, uv, vec3, vec4 } from 'three/tsl'
import { EUMELANIN, type HairColour, MELANIN, PHEOMELANIN, UNPIGMENTED } from './colour.ts'

// TSL 的类型定义跟不上这种写法，节点在本文件内按 any 处理 / TSL's typings do not follow this style, so nodes are `any` here
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

const F0 = ((1.55 - 1) / (1.55 + 1)) ** 2
/** 毛鳞片倾角（弧度）/ cuticle tilt (radians) */
const SHIFT = 0.035

/** 所有发片材质共用的可调参数 / tunable parameters shared by every hair material */
export class HairLook {
  readonly eumelanin = uniform(MELANIN.darkbrown.eumelanin)
  readonly pheomelanin = uniform(0)
  /** 无色素纤维的比例 / share of unpigmented fibres */
  readonly white = uniform(0)
  colour: HairColour = 'darkbrown'

  set(c: HairColour): boolean {
    if (c === this.colour) return false
    this.colour = c
    const m = MELANIN[c]
    this.eumelanin.value = m.eumelanin
    this.pheomelanin.value = m.pheomelanin
    this.white.value = m.white
    return true
  }
}

export interface HairMaterialOptions {
  /** 粗糙度（纵向）/ roughness (longitudinal) */
  roughness: number
  /** 多次散射项的权重 / weight of the multiple-scattering term */
  scatter: number
  /** 发根处的自遮挡（0 无 … 1 全黑）/ self-shadowing at the root (0 none … 1 black) */
  rootShadow: number
  /** 色素倍数（睫毛通常比头发深）/ pigment factor (lashes are usually darker than scalp hair) */
  pigment: number
  /** 根端淡入的长度（根→梢的比例，0 = 不淡入）/ length of the root fade-in (fraction root → tip, 0 = none) */
  rootFade: number
  /** 内层（贴头皮的层）暗多少（0–1）/ how much darker the inner layers are (0–1) */
  layerShadow: number
  /** 发梢最后 20% 淡出的程度（0 不淡出 … 1 淡到无）：梢软一些，层与层的边不成硬线 / how much the last 20 % fades out (0 none … 1 to nothing): softer tips, so layer ends do not form hard lines */
  tipFade: number
}

interface HairInputs {
  T: N
  C: N
  albedo: N
  ao: N
  rough: N
  /** 每根发丝的毛鳞片倾角（弧度）/ per-strand cuticle tilt (radians) */
  shift: N
  scatter: N
}

const gauss = (B: N, x: N): N => exp(x.mul(x).mul(-0.5).div(B.mul(B))).div(B.mul(Math.sqrt(2 * Math.PI)))
const schlick = (c: N): N => float(F0).add(float(1 - F0).mul(pow(float(1).sub(clamp(c, 0, 1)), 5)))

/** 一盏光的高光部分（R + TT + TRT），不含光的颜色 / the specular part for one light (R + TT + TRT), without the light's colour */
function karis(T: N, L: N, V: N, C: N, rough: N, shift: N): N {
  const sinL: N = clamp(dot(L, T), -1, 1)
  const sinV: N = clamp(dot(V, T), -1, 1)
  const cosThetaD: N = max(cos(abs(asin(sinV).sub(asin(sinL))).mul(0.5)), 0.05)
  const Lp: N = L.sub(T.mul(sinL)), Vp: N = V.sub(T.mul(sinV))
  const cosPhi: N = dot(Lp, Vp).mul(inverseSqrt(dot(Lp, Lp).mul(dot(Vp, Vp)).add(1e-4)))
  const cosHalfPhi: N = sqrt(clamp(cosPhi.mul(0.5).add(0.5), 0, 1))
  const a: N = float(1).div(float(1.19).div(cosThetaD).add(cosThetaD.mul(0.36)))
  const beta: N = rough.mul(rough)
  const s: N = sinL.add(sinV)
  // R
  const mR = gauss(max(beta.mul(Math.SQRT2).mul(cosHalfPhi), 0.002), s.add(shift.mul(2)))
  const R: N = mR.mul(cosHalfPhi.mul(0.25)).mul(schlick(sqrt(clamp(dot(L, V).mul(0.5).add(0.5), 0, 1))))
  // TT
  const mTT = gauss(beta.mul(0.5), s.sub(shift))
  const h: N = cosHalfPhi.mul(a.mul(float(0.6).sub(cosPhi.mul(0.8))).add(1))
  const fTT: N = schlick(cosThetaD.mul(sqrt(clamp(float(1).sub(h.mul(h)), 0, 1))))
  const tTT: N = pow(C, vec3(float(0.5).mul(sqrt(clamp(float(1).sub(h.mul(a).mul(h.mul(a))), 0, 1))).div(cosThetaD)))
  const TT: N = tTT.mul(mTT.mul(exp(cosPhi.mul(-3.65).sub(3.98))).mul(float(1).sub(fTT).mul(float(1).sub(fTT))))
  // TRT
  const mTRT = gauss(beta.mul(2), s.sub(shift.mul(4)))
  const f: N = schlick(cosThetaD.mul(0.5))
  const tTRT: N = pow(C, vec3(float(0.8).div(cosThetaD)))
  const TRT: N = tTRT.mul(mTRT.mul(exp(cosPhi.mul(17).sub(16.78))).mul(float(1).sub(f).mul(float(1).sub(f)).mul(f)))
  return TT.add(TRT).add(R)
}

/** Karis 的多次散射近似：包裹的 Kajiya 漫射 × 反照率（Karis 用 √C）/ Karis's multiple-scattering approximation: a wrapped Kajiya diffuse × albedo (Karis uses √C) */
function scatterTerm(T: N, L: N, V: N, albedo: N): N {
  const fake: N = normalize(V.sub(T.mul(dot(V, T))))
  const kajiya: N = float(1).sub(abs(dot(T, L)))
  const wrap: N = clamp(dot(fake, L).add(0.3).div(1.3), 0, 1)
  return albedo.mul(mix(wrap, kajiya, 0.33).mul(1 / Math.PI))
}

class HairLightingModel extends LightingModel {
  constructor(private readonly i: HairInputs) {
    super()
  }

  direct({ lightDirection, lightColor, reflectedLight }: { lightDirection: N; lightColor: N; reflectedLight: N }): void {
    const V: N = positionViewDirection
    const spec = karis(this.i.T, lightDirection, V, this.i.C, this.i.rough, this.i.shift)
    reflectedLight.directSpecular.addAssign(lightColor.mul(spec).mul(this.i.ao))
    reflectedLight.directDiffuse.addAssign(lightColor.mul(scatterTerm(this.i.T, lightDirection, V, this.i.albedo)).mul(this.i.scatter).mul(this.i.ao))
  }

  indirect(builder: N): void {
    const { irradiance, iblIrradiance, radiance, reflectedLight } = builder.context
    const albedo: N = this.i.albedo
    reflectedLight.indirectDiffuse.addAssign(irradiance.add(iblIrradiance).mul(albedo).mul(1 / Math.PI).mul(this.i.ao))
    // 环境的反射只取一小份：R 瓣在掠射以外很弱 / only a small share of environment reflection: the R lobe is weak away from grazing
    reflectedLight.indirectSpecular.addAssign(radiance.mul(0.035).mul(this.i.ao))
  }
}

class HairNodeMaterial extends MeshStandardNodeMaterial {
  constructor(private readonly inputs: HairInputs) {
    super()
  }

  // 基类的类型要求物理光照模型；这里换成毛发的（运行时只要是 LightingModel 就行）
  // the base class's typing asks for the physical lighting model; the hair model replaces it (at run time any LightingModel works)
  override setupLightingModel(): PhysicalLightingModel {
    return new HairLightingModel(this.inputs) as unknown as PhysicalLightingModel
  }
}

/**
 * 做一个发片材质。atlas.a = RGBA（覆盖率、根→梢、随机数、深度，后三项预乘覆盖率），atlas.b = 偏角（预乘）。
 * Make a hair-card material. atlas.a = RGBA (coverage, root → tip, random, depth; the last three premultiplied by
 * coverage), atlas.b = angle (premultiplied).
 */
export function makeHairMaterial(look: HairLook, atlasA: Texture, atlasB: Texture, size: number, o: HairMaterialOptions): MeshStandardNodeMaterial {
  const coord: N = uv()
  const A: N = texture(atlasA, coord)
  const cov: N = A.r
  const inv: N = float(1).div(max(cov, 1 / 255))
  const rootTip: N = clamp(A.g.mul(inv), 0, 1)
  const id: N = clamp(A.b.mul(inv), 0, 1)
  const depth: N = clamp(A.a.mul(inv), 0, 1)
  const angle: N = clamp(texture(atlasB, coord).r.mul(inv), 0, 1).sub(0.5).mul(Math.PI)
  const layer: N = attribute('aLayer', 'float')
  const cardRandom: N = attribute('aRandom', 'float')

  // 发丝走向：几何"法线"属性里存的是发片中心线的走向（蒙皮时与法线一样旋转），再按贴图里每根发丝的偏角在发片平面内转一下
  // strand direction: the geometry's "normal" attribute holds the card centre line's direction (rotated by skinning like a normal), then turned within the card plane by each strand's angle from the atlas
  const T0: N = normalize(normalViewGeometry)
  const side: N = normalize(cross(normalFlat, T0))
  const T: N = normalize(T0.mul(cos(angle)).add(side.mul(sin(angle)))).toVar('hairTangent')

  const { C, albedo } = fibreColour(look, o, id, cardRandom)

  // 遮挡：贴图深度（靠里的发丝暗）、层（贴头皮的暗）、发根（靠近头皮的一段暗）
  // occlusion: atlas depth (inner strands darker), layer (those against the scalp darker), root (the stretch near the scalp darker)
  const ao: N = mix(float(0.45), float(1), smoothstep(0.15, 0.85, depth))
    .mul(mix(float(1 - o.layerShadow), float(1), layer))
    .mul(mix(float(1 - o.rootShadow), float(1), smoothstep(0, 0.3, rootTip)))
    .toVar('hairAo')

  const m = hairMaterial(T, C, albedo, ao, id, o)
  // 覆盖率：多级纹理越远平均得越淡，按层级补回一点，远处的头发不会变稀 / coverage: mips average it thinner with distance; a little is added back per level so distant hair does not thin out
  const texel: N = coord.mul(size)
  const lod: N = max(log2(max(length(dFdx(texel)), length(dFdy(texel)))), 0)
  // 发片的根端淡入，免得每张发片的起点成一条硬边 / the card's root end fades in, so each card's start does not show as a hard edge
  const rootFade: N = o.rootFade > 0 ? smoothstep(0, o.rootFade, rootTip) : float(1)
  const tipFade: N = o.tipFade > 0 ? float(1).sub(smoothstep(0.8, 1, rootTip).mul(o.tipFade)) : float(1)
  m.opacityNode = clamp(cov.mul(lod.mul(0.35).add(1)).mul(rootFade).mul(tipFade), 0, 1) as N
  m.alphaTest = 0.2
  return m
}

/** 纤维颜色和多次散射的反照率（发片、发丝共用）/ fibre colour and multiple-scattering albedo (shared by cards and strands) */
export function fibreColour(look: HairLook, o: HairMaterialOptions, id: N, cardRandom: N): { C: N; albedo: N } {
  // 纤维颜色：每根发丝的真黑素浓度有 ±30% 的差别，每张发片再有 ±10%；灰白发按比例混入无色素纤维
  // fibre colour: eumelanin varies ±30 % between strands and ±10 % between cards; grey hair mixes in unpigmented fibres by share
  const eu: N = look.eumelanin.mul(o.pigment).mul(id.mul(0.6).add(0.7)).mul(cardRandom.mul(0.2).add(0.9))
  const v3 = (c: readonly number[]): N => (vec3 as N)(c[0], c[1], c[2])
  const sigma: N = v3(EUMELANIN).mul(eu).add(v3(PHEOMELANIN).mul(look.pheomelanin.mul(o.pigment)))
  const whiteFibre: N = fract(id.mul(13.7).add(cardRandom.mul(3.1))).lessThan(look.white)
  const sig: N = select(whiteFibre, v3(UNPIGMENTED), sigma).toVar('hairSigma')
  const C: N = exp(sig.mul(-4)).toVar('hairColour')
  // 多次散射的反照率：exp(−2.6·√σa)。√ 的形式随 Chiang 等 2016 的颜色↔吸收换算；系数 2.6 是本项目按观感定的（让棕色预设看起来是棕色）
  // multiple-scattering albedo: exp(−2.6·√σa). The √ form follows Chiang et al. 2016's colour ↔ absorption mapping; the factor 2.6 is this project's, set by eye (so the brown preset reads as brown)
  const albedo: N = exp(sqrt(sig).mul(-2.6)).toVar('hairAlbedo')
  return { C, albedo }
}

/**
 * 发片、发丝共用的材质外壳：Karis 光照模型、每根发丝的倾角和粗糙度、Karis 的假法线、alpha-to-coverage。
 * The material shell shared by cards and strands: the Karis lighting model, per-strand tilt and roughness, Karis's fake
 * normal, alpha-to-coverage.
 */
export function hairMaterial(T: N, C: N, albedo: N, ao: N, id: N, o: HairMaterialOptions): MeshStandardNodeMaterial {
  // 每根发丝的毛鳞片倾角在 2°±1.5° 之间（pbrt：一般 2–4°），粗糙度也各差 ±15%：高光不再是一条整齐的亮带（"湿"的观感主要来自它）
  // per-strand cuticle tilt within 2° ± 1.5° (pbrt: generally 2–4°) and roughness ±15 %: the highlight is no longer one tidy bright band (the main source of the "wet" look)
  const shift: N = float(SHIFT).add(id.sub(0.5).mul(0.05))
  const rough: N = float(o.roughness).mul(fract(id.mul(7.3)).mul(0.3).add(0.85))
  const m = new HairNodeMaterial({ T, C, albedo, ao, rough, shift, scatter: float(o.scatter) })
  // 环境光照用的"法线"：垂直于发丝、朝向相机（Karis 的假法线）/ the "normal" for ambient light: perpendicular to the strand, facing the camera (Karis's fake normal)
  m.normalNode = normalize(positionViewDirection.sub(T.mul(dot(positionViewDirection, T)))) as N
  m.roughnessNode = float(0.55) as N
  m.metalness = 0
  m.colorNode = (vec4 as N)(albedo, 1)
  m.alphaToCoverage = true
  m.transparent = false
  m.side = DoubleSide
  return m
}

/**
 * 头皮底色的材质：头发下面的头皮画成深一些、带发色（游戏里常用的做法），按离头皮边界的距离淡入，免得发片之间露出亮的皮肤。
 * The scalp-tint material: the scalp under the hair drawn darker and hair-coloured (a common game technique), faded in by
 * the distance from the scalp border, so bright skin does not show between the cards.
 */
export function makeScalpTintMaterial(look: HairLook): MeshLambertNodeMaterial {
  const v3 = (c: readonly number[]): N => (vec3 as N)(c[0], c[1], c[2])
  const sigma: N = v3(EUMELANIN).mul(look.eumelanin).add(v3(PHEOMELANIN).mul(look.pheomelanin))
  const pig: N = exp(sqrt(sigma).mul(-2.6))
  const white: N = exp(sqrt(v3(UNPIGMENTED)).mul(-2.6))
  const colour: N = mix(pig, white, look.white).mul(0.75)
  // 只有漫射（朗伯）：头皮在头发下面，不该有高光 / diffuse only (Lambert): the scalp lies under the hair and should have no highlight
  const m = new MeshLambertNodeMaterial()
  m.colorNode = colour
  // 头皮里 5 毫米处到满，边界外 1.5 毫米处为零 / full 5 mm inside the scalp, zero 1.5 mm outside its border
  m.opacityNode = smoothstep(-1.5, 5, attribute('aScalp', 'float')).mul(0.92) as N
  m.transparent = true
  m.depthWrite = false
  // 盖在写实皮肤（−1/−1）和皱纹层（−1/−2）之上 / over the lifelike skin (−1/−1) and the wrinkle layer (−1/−2)
  m.polygonOffset = true
  m.polygonOffsetFactor = -2
  m.polygonOffsetUnits = -6
  return m
}
