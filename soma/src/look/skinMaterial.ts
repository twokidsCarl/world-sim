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
//   · 颜色数据没到或坏了：表退成 1×1 的均匀肤色，部位贴图退成"倍数 1"，没有细节。
//     Without (or with broken) colour data the table falls back to a 1×1 uniform skin tone, the region map to "multiplier 1", and there is no detail.
// 微细起伏 / micro-relief
//   · 不用 UV 的三平面映射：在静止姿势的位置（属性 restPosition、restNormal，随网格一起变形）上按三个轴面取可平铺的高度贴图
//     （面部毛孔、身体的细毛孔与皮沟、皮嵴，tools/look/micro.ts），所以 UV 折叠的移植片也没问题。部位决定幅度和类型（细节贴图）。
//     Triplanar mapping without UVs: a tileable height map (facial pores, the body's fine pores and furrows, ridges;
//     tools/look/micro.ts) is read on the three axis planes at the rest-pose position (attributes restPosition,
//     restNormal, which deform with the mesh), so grafts with folded UVs are fine. The region sets amplitude and type (the detail map).
//   · 高度的梯度在静止空间里算出，按屏幕导数链式求出 dH/dx、dH/dy，再用 Mikkelsen 2010 的无参数化凹凸法改法线，
//     任何姿势、两个后端都成立，并能叠在皱纹层的法线上。一个像素盖住的皮肤超过细节尺寸时逐渐淡出，免得闪烁。
//     The height gradient is formed in rest space, turned into dH/dx and dH/dy through the screen derivatives, and the
//     normal is bent with Mikkelsen's 2010 bump mapping of unparametrised surfaces; this holds in any pose, on both
//     backends, and stacks on the wrinkle layer's normal. Detail fades out once one pixel covers more skin than its size, so it does not shimmer.
// 镜面 / specular
//   · 两个镜面瓣：粗糙度 ×0.75 的占 0.85，×1.30 的占 0.15（UE 次表面配置的缺省值，只借它的做法）；第二瓣用 three 的清漆层实现。
//     Two specular lobes: roughness ×0.75 with weight 0.85 and ×1.30 with weight 0.15 (the defaults of UE's subsurface
//     profile, borrowed as a technique only); the second lobe is three's clearcoat layer.
//   · 毛孔和皮沟里的镜面和环境光按深度遮掉一部分（腔体遮蔽）；绒光随底色着色，深肤色不再蒙一层灰白。
//     Specular and ambient light are partly occluded inside pores and furrows by depth (cavity); the sheen is tinted
//     by the albedo, so deep tones no longer wear a grey veil.
// 次表面 / subsurface
//   · 透光由厚度贴图给（离线射线求出），光程红、绿、蓝依次变短（红光穿透几毫米，Bashkatov 等 2005）；只有薄处透红光。
//     Transmission comes from the thickness map (ray cast offline), with path lengths shortening from red to green
//     to blue (red light penetrates a few millimetres, Bashkatov et al. 2005); only thin parts let red light through.
//   · 直射漫反射用预积分表（Penner 和 Borshukov 2011，见 skinLighting.ts）。
//     Direct diffuse uses the pre-integrated table (Penner & Borshukov 2011; see skinLighting.ts).

import { ClampToEdgeWrapping, Color, DataTexture, DataUtils, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, type Material, NoColorSpace, RepeatWrapping, RGBAFormat, UnsignedByteType, Vector3 } from 'three/webgpu'
import { abs, attribute, clamp, cross, dFdx, dFdy, dot, exp, exp2, float, length, log, max, mix, normalView, positionView, pow, sign, smoothstep, sqrt, texture, uniform, uv, varying, vec2, vec3 } from 'three/tsl'
import type { LoadedSkinColour } from './load.ts'
import { SkinNodeMaterial } from './skinLighting.ts'
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

function regionTexture(data: Uint8Array, w: number, h: number, repeat = false): DataTexture {
  const t = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType)
  t.colorSpace = NoColorSpace
  t.magFilter = LinearFilter
  t.minFilter = w > 1 ? LinearMipmapLinearFilter : LinearFilter
  t.wrapS = t.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping
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

/** 几个写实皮肤材质共用的贴图槽：换数据时把所有节点的贴图一起换掉 / Texture slots shared by every lifelike skin material: new data swap the texture of every node at once. */
type Slot = 'lut' | 'lutLip' | 'regions' | 'detail' | 'micro' | 'preint' | 'pads'

const halfOf = (v: number[]): Uint16Array => new Uint16Array(v.map((x) => DataUtils.toHalfFloat(x)))

function fallbackTexture(slot: Slot): DataTexture {
  switch (slot) {
    case 'lut':
    case 'lutLip': {
      const c = new Color(FALLBACK_ALBEDO)
      return lutTexture(halfOf([c.r, c.g, c.b, 1]), 1)
    }
    case 'regions':
      return regionTexture(new Uint8Array([128, 128, 0, 128]), 1, 1)
    case 'detail':
      // 没有起伏、最厚、平 / no relief, thickest, flat
      return regionTexture(new Uint8Array([0, 0, 255, 1]), 1, 1)
    case 'micro':
      return regionTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, true)
    case 'pads':
      return regionTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
    case 'preint':
      return lutTexture(halfOf([0, 0, 0, 1]), 1)
  }
}

/** 几个写实皮肤材质共用的可调参数和贴图 / Tunable parameters and maps shared by every lifelike skin material. */
export class SkinLook {
  /** 粗糙度的比例：0.5 = 按部位贴图；缺省 0.7（整体乘 1.4：三的粗糙度 r 对应 GGX α = r²，Weyrich 等 2006 测得面部的 Torrance–Sparrow 粗糙度约 0.3–0.5，按 α 折算后粗糙度在 0.55–0.7）/ roughness scale: 0.5 = as the region map says; default 0.7 (×1.4 overall: three maps roughness r to GGX α = r², and Weyrich et al. 2006 measured facial Torrance–Sparrow roughness of about 0.3–0.5, which as α gives roughness 0.55–0.7) */
  readonly roughness = uniform(0.7)
  /** 透光强度 / transmission strength */
  readonly scatterStrength = uniform(1.6)
  /** 透光的特征光程（毫米，红绿蓝）：红光在皮肤里的穿透深度是几毫米的量级（Bashkatov 等 2005），绿、蓝短得多；具体数是假设
   * characteristic transmission lengths (mm, RGB): red light penetrates skin by a few millimetres (Bashkatov et al. 2005), green and blue far less; the exact values are assumed */
  readonly transmitMm = uniform(new Vector3(4.0, 1.2, 0.6))
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
  /** 细节贴图的编码 / encoding of the detail map */
  readonly reliefMax = uniform(1.5)
  readonly thicknessMaxMm = uniform(40)
  /** 微细起伏的总强度（1 = 标定值，0 = 关）/ overall micro-relief strength (1 = as designed, 0 = off) */
  readonly microStrength = uniform(1)
  /** 腔体遮蔽的强度 / cavity occlusion strength */
  readonly cavityStrength = uniform(0.6)
  /** 指腹贴图里距离的上限（毫米）/ the distance limit in the pad map (mm) */
  readonly padRhoMaxMm = uniform(10)
  /** 预积分漫反射：1 开 0 关（没有表时为 0）/ pre-integrated diffuse: 1 on, 0 off (0 without a table) */
  readonly preintOn = uniform(0)
  /** 静止姿势下每个皮肤顶点的位置和法线（三平面映射用），由写实皮肤层第一次建立时记下
   * rest-pose position and normal per skin vertex (for the triplanar mapping), taken when the lifelike skin layer is first built */
  rest: { position: Float32Array; normal: Float32Array } | null = null
  private readonly textures: Record<Slot, DataTexture>
  private readonly nodes: Record<Slot, N[]> = { lut: [], lutLip: [], regions: [], detail: [], micro: [], preint: [], pads: [] }
  private readonly materials = new Set<Material>()
  private colour: LoadedSkinColour | null = null
  private tone: number | null = null

  constructor() {
    this.textures = { lut: fallbackTexture('lut'), lutLip: fallbackTexture('lutLip'), regions: fallbackTexture('regions'), detail: fallbackTexture('detail'), micro: fallbackTexture('micro'), preint: fallbackTexture('preint'), pads: fallbackTexture('pads') }
  }

  /** 现在用的颜色数据 / the colour data in use */
  get data(): LoadedSkinColour | null {
    return this.colour
  }

  /** 记下静止姿势（按皮肤顶点）/ Record the rest pose (per skin vertex). */
  setRest(position: ArrayLike<number>, normal: ArrayLike<number>): void {
    this.rest = { position: Float32Array.from(position), normal: Float32Array.from(normal) }
  }

  /** 换上一个人体的颜色数据（null 退回均匀肤色）/ Use a body's colour data (null falls back to the uniform tone). */
  setColour(colour: LoadedSkinColour | null): void {
    if (colour === this.colour) return
    this.colour = colour
    const old = { ...this.textures }
    const next: Record<Slot, DataTexture> = { lut: fallbackTexture('lut'), lutLip: fallbackTexture('lutLip'), regions: fallbackTexture('regions'), detail: fallbackTexture('detail'), micro: fallbackTexture('micro'), preint: fallbackTexture('preint'), pads: fallbackTexture('pads') }
    if (colour) {
      const d = colour.data
      next.lut.dispose()
      next.regions.dispose()
      next.lut = lutTexture(colour.lut, d.lut.size)
      next.lutLip.dispose()
      // 没有唇红表时唇红也用皮肤的表 / without a vermilion table the vermilion uses the skin's
      next.lutLip = lutTexture(colour.lutLip ?? colour.lut, d.lut.size)
      next.regions = regionTexture(colour.regions.data, colour.regions.width, colour.regions.height)
      this.cmMax.value = d.lut.cmMax
      this.chdMax.value = d.lut.chdMax
      this.lutSize.value = d.lut.size
      this.logScale.value = d.regions.logScale
      this.bloodChd.value = d.tone.bloodChd
      this.palmLnCm.value = Math.log(d.regions.palmMelanin)
      const ref = lookupLut(colour.lut, d.lut.size, d.lut.cmMax, d.lut.chdMax, toneMelanin(d.tone.default, d.tone.cmMax), d.tone.bloodChd)
      ;(this.albedoRef.value as Color).setRGB(...ref)
      if (colour.detail && d.detail) {
        next.detail.dispose()
        next.detail = regionTexture(colour.detail.data, colour.detail.width, colour.detail.height)
        this.reliefMax.value = d.detail.reliefMax
        this.thicknessMaxMm.value = d.detail.thicknessMaxMm
      }
      if (colour.pads && d.pads) {
        next.pads.dispose()
        next.pads = regionTexture(colour.pads.data, colour.pads.width, colour.pads.height)
        this.padRhoMaxMm.value = d.pads.rhoMaxMm
      }
      if (colour.micro) {
        next.micro.dispose()
        next.micro = regionTexture(colour.micro.data, colour.micro.width, colour.micro.height, true)
      }
      if (colour.preint && d.preintegrated) {
        next.preint.dispose()
        next.preint = new DataTexture(colour.preint, d.preintegrated.width, d.preintegrated.height, RGBAFormat, HalfFloatType)
        Object.assign(next.preint, { colorSpace: NoColorSpace, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false, flipY: false, needsUpdate: true })
        next.preint.wrapS = next.preint.wrapT = ClampToEdgeWrapping
      }
    } else {
      this.lutSize.value = 1
      ;(this.albedoRef.value as Color).set(FALLBACK_ALBEDO)
    }
    this.preintOn.value = colour?.preint ? 1 : 0
    for (const k of Object.keys(next) as Slot[]) {
      this.textures[k] = next[k]
      for (const n of this.nodes[k]) n.value = next[k]
      old[k].dispose()
    }
    for (const m of this.materials) m.needsUpdate = true
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

  /** 着色器节点：某个贴图槽在 at 处的值 / shader node: a slot's texture at `at` */
  sample(slot: Slot, at: N): N {
    const n: N = texture(this.textures[slot], at)
    this.nodes[slot].push(n)
    return n
  }

  track(m: Material): void {
    this.materials.add(m)
    m.addEventListener('dispose', () => this.materials.delete(m))
  }

  dispose(): void {
    for (const t of Object.values(this.textures)) t.dispose()
  }
}

export interface SkinMaterialOptions {
  /** 视空间法线（例如皱纹层的合成法线）；不给就用几何法线 / view-space normal (e.g. the wrinkle layer's composite); geometric normal when absent */
  normalNode?: N
}

/** 微细起伏贴图一块代表的皮肤（米）和像素数 / the skin one micro-relief tile stands for (m) and its pixels */
const TILE_M = 0.01
const MICRO_PX = 512
/** 每层高度 ±1 对应的起伏（米）：面部毛孔、身体纹理、皮嵴、大尺度的皮沟（视觉上定的，假设）
 * relief (m) of height ±1 per layer: facial pores, body texture, ridges, large-scale furrows (set by eye; assumed) */
const AMP = { pores: 60e-6, body: 14e-6, ridges: 40e-6, macro: 25e-6, pads: 25e-6 }
/** 大尺度皮沟用身体纹理放大的倍数 / scale-up of the body texture used for the large-scale furrows */
const MACRO_SCALE = 3.7
/** 指腹涡状嵴的嵴距（毫米），与平铺的皮嵴相同 / ridge spacing of the finger-pad whorls (mm), the same as the tiled ridges */
const PAD_RIDGE_MM = 0.45
/** 双瓣镜面（UE 次表面配置的缺省值）/ dual-lobe specular (the defaults of UE's subsurface profile) */
const LOBE = { rough0: 0.75, rough1: 1.3, mix: 0.85 }

export function makeSkinMaterial(look: SkinLook, opts: SkinMaterialOptions = {}): SkinNodeMaterial {
  const m = new SkinNodeMaterial()
  const reg: N = look.sample('regions', uv())
  const det: N = look.sample('detail', uv())
  const melMul: N = exp2(reg.r.mul(255).sub(128).div(look.logScale))
  const bloodMul: N = exp2(reg.g.mul(255).sub(128).div(look.logScale))
  // B = 128 + 127·(手足掌 − 唇红) / B = 128 + 127·(palmoplantar − vermilion)
  const bSigned: N = reg.b.mul(255).sub(128).div(127)
  const palmW: N = clamp(bSigned, 0, 1)
  const lipW: N = clamp(bSigned.negate(), 0, 1)
  // 手足掌：黑色素在对数空间里拉向固定值 / palms and soles: melanin pulled to a fixed value in log space
  const lnCm: N = log(max((look.toneCm as N).mul(melMul), float(1e-6)))
  const cm: N = exp(mix(lnCm, look.palmLnCm, palmW))
  const chd: N = (look.bloodChd as N).mul(bloodMul)
  const n1: N = (look.lutSize as N).sub(1)
  const at: N = (vec2 as N)(sqrt(clamp(cm.div(look.cmMax), 0, 1)).mul(n1).add(0.5), sqrt(clamp(chd.div(look.chdMax), 0, 1)).mul(n1).add(0.5)).div(look.lutSize)
  // 唇红用自己的表（更薄的等效表皮）/ the vermilion uses its own table (a thinner effective epidermis)
  const albedo: N = mix(look.sample('lut', at).rgb, look.sample('lutLip', at).rgb, lipW)

  // ── 三平面微细起伏 / triplanar micro-relief ──
  const rest: N = varying(attribute('restPosition', 'vec3'))
  const restN: N = (varying(attribute('restNormal', 'vec3')) as N).normalize()
  const wAxis: N = pow(abs(restN), vec3(4))
  const w: N = wAxis.div(wAxis.x.add(wAxis.y).add(wAxis.z).add(1e-6))
  const t: N = det.g
  const wFace: N = clamp(float(1).sub(abs(t.mul(2).sub(1))), 0, 1)
  const wBody: N = clamp(float(1).sub(t.mul(2)), 0, 1)
  const wRidge: N = clamp(t.mul(2).sub(1), 0, 1)
  const amp: N = det.r.mul(look.reliefMax).mul(look.microStrength)
  // 一个像素盖住的静止空间长度：细节到了亚像素就淡出 / rest-space length one pixel covers: detail fades out once it is sub-pixel
  const dRx: N = dFdx(rest), dRy: N = dFdy(rest)
  const foot: N = max(length(dRx), length(dRy))
  const fadeFine: N = float(1).sub(smoothstep(1.2e-4, 5e-4, foot))
  const fadeMacro: N = float(1).sub(smoothstep(6e-4, 2.5e-3, foot))
  // 各层的权重（无量纲，腔体用）和以米计的幅度 / per-layer weights (unitless, for the cavity) and amplitudes in metres
  // 指腹：按到涡心的距离画一圈圈的嵴（tools/look/skin_regions.py 的指腹贴图），平铺的皮嵴在那里让位
  // finger pads: rings of ridges by the distance to the whorl core (the pad map of tools/look/skin_regions.py); the tiled ridges give way there
  const pad: N = look.sample('pads', uv())
  const padW: N = pad.g
  const kn: N = (vec3 as N)(wFace, wBody.add(wFace.mul(0.15)), wRidge.mul(float(1).sub(padW))).mul(amp).mul(fadeFine)
  const km: N = kn.mul((vec3 as N)(AMP.pores, AMP.body, AMP.ridges))
  const e = 1 / MICRO_PX
  const q: N = rest.div(TILE_M)
  // 一个轴面：在 (cu, cv) 取三次，得到高度和对 cu、cv 的导数（每块贴图为单位）/ one plane: three taps at (cu, cv) give the heights and their derivatives in cu, cv (per tile)
  const plane = (cu: N, cv: N, k: N): { h: N; hv: N; du: N; dv: N } => {
    const h0: N = look.sample('micro', (vec2 as N)(cu, cv)).rgb.mul(255 / 127).sub(128 / 127)
    const hu: N = look.sample('micro', (vec2 as N)(cu.add(e), cv)).rgb.mul(255 / 127).sub(128 / 127)
    const hv: N = look.sample('micro', (vec2 as N)(cu, cv.add(e))).rgb.mul(255 / 127).sub(128 / 127)
    return { h: dot(h0, k), hv: h0, du: dot(hu.sub(h0), k).div(e), dv: dot(hv.sub(h0), k).div(e) }
  }
  const tri = (qq: N, k: N, scale: number): { grad: N; h: N; hv: N } => {
    const px = plane(qq.y, qq.z, k), py = plane(qq.x, qq.z, k), pz = plane(qq.x, qq.y, k)
    const gx: N = (vec3 as N)(0, px.du, px.dv).mul(w.x)
    const gy: N = (vec3 as N)(py.du, 0, py.dv).mul(w.y)
    const gz: N = (vec3 as N)(pz.du, pz.dv, 0).mul(w.z)
    return { grad: gx.add(gy).add(gz).div(TILE_M * scale), h: px.h.mul(w.x).add(py.h.mul(w.y)).add(pz.h.mul(w.z)), hv: px.hv.mul(w.x).add(py.hv.mul(w.y)).add(pz.hv.mul(w.z)) }
  }
  const fine = tri(q, km, 1)
  // 大尺度皮沟只在身体类型的皮肤上（面部的大皱纹由皱纹层管）/ large-scale furrows only on body-type skin (the face's large wrinkles belong to the wrinkle layer)
  const macro = tri(q.div(MACRO_SCALE), (vec3 as N)(0, amp.mul(wBody).mul(fadeMacro).mul(AMP.macro), 0), MACRO_SCALE)
  const grad: N = fine.grad.add(macro.grad)
  // Mikkelsen 2010：由高度的屏幕导数改法线 / Mikkelsen 2010: bend the normal by the screen derivatives of the height
  const nBase: N = ((opts.normalNode ?? normalView) as N).normalize()
  const sx: N = dFdx(positionView), sy: N = dFdy(positionView)
  // 涡状嵴的相位：距离 / 嵴距，再用平铺皮嵴的高度扰动一点，出现分叉和断头 / whorl phase: distance / ridge spacing, perturbed a little by the tiled ridge height so bifurcations and ends appear
  // 导数按解析式：d cos(2πφ) = −2π sin(2πφ) dφ，dφ 取平滑的距离项的屏幕导数，避免 2×2 像素块
  // the derivative analytically: d cos(2πφ) = −2π sin(2πφ) dφ, with dφ the screen derivative of the smooth distance term, which avoids 2×2 pixel blocks
  const rhoPhase: N = pad.r.mul(look.padRhoMaxMm).div(PAD_RIDGE_MM)
  const phase: N = rhoPhase.add(fine.hv.z.mul(0.3))
  const slope: N = phase.mul(2 * Math.PI).sin().mul(-2 * Math.PI)
  const kPad: N = padW.mul(amp).mul(fadeFine).mul(AMP.pads)
  const dHx: N = dot(grad, dRx).add(kPad.mul(slope).mul(dFdx(rhoPhase))), dHy: N = dot(grad, dRy).add(kPad.mul(slope).mul(dFdy(rhoPhase)))
  const r1: N = cross(sy, nBase), r2: N = cross(nBase, sx)
  const fDet: N = dot(sx, r1)
  const surfGrad: N = sign(fDet).mul(r1.mul(dHx).add(r2.mul(dHy)))
  const nOut: N = abs(fDet).mul(nBase).sub(surfGrad).normalize()
  // 腔体：毛孔和皮沟越深遮得越多 / cavity: the deeper the pore or furrow, the more it occludes
  const hUnit: N = dot(vec3(1), kn).greaterThan(1e-4).select(fine.h.div(max(dot(vec3(1), kn), 1e-4)), float(0))
  const cavity: N = float(1).sub((look.cavityStrength as N).mul(clamp(hUnit.negate(), 0, 1)).mul(clamp(dot(vec3(1), kn), 0, 1)))

  m.colorNode = albedo
  const rough: N = reg.a.mul((look.roughness as N).mul(2))
  m.roughnessNode = clamp(rough.mul(LOBE.rough0), 0.05, 1)
  m.specularIntensityNode = cavity.mul(LOBE.mix)
  // 第二瓣：清漆层，F0 0.04 → 0.028 按 0.7 折算 / the second lobe: the clearcoat, F0 0.04 → 0.028 scaled by 0.7
  m.clearcoatNode = cavity.mul((1 - LOBE.mix) * 0.7)
  m.clearcoatRoughnessNode = clamp(rough.mul(LOBE.rough1), 0.05, 1)
  m.clearcoatNormalNode = nOut
  m.normalNode = nOut
  m.aoNode = mix(float(1), cavity, 0.5)
  m.metalness = 0
  m.ior = 1.4
  m.sheenNode = albedo.mul(0.35)
  m.sheenRoughness = 0.8
  // 透光 / transmission
  const thickMm: N = det.b.mul(det.b).mul(look.thicknessMaxMm)
  const T: N = exp((vec3 as N)(thickMm).negate().div(look.transmitMm))
  m.thicknessColorNode = T.mul(look.scatterStrength as N).mul(albedo.div(max(look.albedoRef as N, vec3(1e-3))))
  m.thicknessDistortionNode = float(0.2)
  m.thicknessAmbientNode = float(0.0)
  m.thicknessAttenuationNode = float(0.8)
  m.thicknessPowerNode = float(3.0)
  m.thicknessScaleNode = float(4.0)
  m.skinExtras = { preint: (p: N) => look.sample('preint', p), curvature: det.a, width: 128, height: 32, on: look.preintOn }
  look.track(m)
  return m
}
