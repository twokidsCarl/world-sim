// 写实的眼：写实模式下画在扫描眼球位置上的一对构造的眼（来源"构造物"，为显示而造，不是解剖数据），能注视。
// The lifelike eyes: a pair of constructed eyes drawn where the scanned eyeballs are while the lifelike mode shows
// (provenance "construction": built for display, not anatomical data), able to gaze.
//
// 做法（技术参照 Epic 公开文档里眼的着色模型——虹膜遮罩、虹膜深度、角膜折射——和 MetaHuman 的"眼部遮蔽"、泪液层；
// 只借鉴做法，没有用它们的任何资源）/ How (technique after Epic's public documentation of the eye shading model — iris mask,
// iris depth, corneal refraction — and MetaHuman's "eye occlusion" and tear layer; the technique only, none of their assets):
//   · 每只眼一张网格：巩膜球加一个半径 7.8 mm 的角膜球冠，几千个三角形。尺寸与来源见 eyesFit.ts。
//     One mesh per eye: a scleral sphere with a 7.8 mm corneal cap, a few thousand triangles. Dimensions and sources in eyesFit.ts.
//   · 虹膜不是几何：片元里把视线在角膜表面按折射率 1.376 折射，与略向前隆起的虹膜面求交，在交点上程序化地画虹膜
//     纹理（放射状纤维、隐窝、卷缩轮、瞳孔缘）和瞳孔。这样从侧面看虹膜也在角膜后面，位置随视角正确地移动。
//     The iris is not geometry: in the fragment the view ray is refracted at the corneal surface with index 1.376 and met
//     with the slightly forward-bowed iris surface, where the iris (radial fibres, crypts, collarette, pupillary ruff) and the
//     pupil are drawn procedurally. Seen from the side the iris thus stays behind the cornea and shifts correctly with the view.
//   · 眼部遮蔽：睑缘在眼球上投下的阴影。它不是另一层壳（角膜会随注视转出壳外），而是在同一个片元里按头部坐标算：
//     睑缘内卷（lidRims）此刻的位置每次表情变化时取一次，按水平位置分箱写进一张小数据纹理，片元离上下睑缘越近越暗。
//     Eye occlusion: the shadow the lids cast on the eyeball. It is not a separate shell (the cornea would turn out of it with
//     the gaze) but computed in the same fragment in the head frame: the current positions of the lid rims (lidRims) are read
//     whenever the expression changes, binned by horizontal position into a small data texture, and the closer a fragment is
//     to the upper or lower lid margin the darker it gets.
//   · 泪液线：沿睑缘内卷的边、贴在眼球上的一条窄带，半透明、很光滑；它是皮肤的跟随层（Viewer.addFollower），表情变了跟着走。
//     内眦处的泪阜只是巩膜上的一点粉色提示。
//     The tear line: a narrow band on the eyeball along the edge of the lid rims, translucent and very smooth; it is a follower
//     of the skin (Viewer.addFollower) and moves with the expression. The caruncle at the medial canthus is only a pink hint on the sclera.
//   · 注视：眼在静止空间里绕拟合的球心转（统一变量里的旋转矩阵），再按头骨关节蒙皮，所以跟着头部姿势走、与下颌和表情无关。
//     Gaze: the eye turns about the fitted centre in rest space (a rotation matrix in a uniform), then is skinned by the skull
//     joint, so it follows the head pose and does not care about the jaw or the expression.

import { BufferAttribute, BufferGeometry, Color, DataTexture, DoubleSide, FloatType, Group, Matrix3, Mesh, MeshPhysicalNodeMaterial, MeshSSSNodeMaterial, NearestFilter, RGBAFormat, Vector3 } from 'three/webgpu'
import { Fn, abs, attribute, cameraPosition, clamp, cross, dot, float, floor, int, ivec2, length, max, min, mix, mx_noise_float, mx_worley_noise_float, normalLocal, normalize, positionGeometry, positionLocal, positionWorld, refract, select, smoothstep, textureLoad, uniform, varying, vec3, vec4 } from 'three/tsl'
import type { FaceOpenings } from '../face/types.ts'
import type { SkinGeometry } from '../viewer/skinLayer.ts'
import { SkinPatch } from '../viewer/skinPatch.ts'
import { positionNodeFor, type SkinningData, type SkinningMode } from '../viewer/skinning.ts'
import { EYE, eyeAngles, eyeBasis, eyeShape, fixedTarget, gazeRotation, m3apply, type EyeFit, type EyeShape, type EyeSide, type M3, type V3 } from './eyesFit.ts'
import { DEFAULT_IRIS, type GazeSetting, type IrisName } from './types.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

const MM = 0.001

/**
 * 虹膜颜色（sRGB）：inner 是瞳孔周围（卷缩轮以内），outer 是外周。这些颜色是假设：按 Wikimedia Commons 上的眼部照片
 * 目测选定，分类参照常用的照片分级（蓝 / 灰 / 绿 / 榛 / 棕；Franssen 等 2008, J Optom）。蓝、绿眼并没有蓝色或绿色色素，
 * 是基质里的散射加上少量黑色素（Wikipedia "Eye color"）；这里只是画出看上去的颜色。
 * Iris colours (sRGB): `inner` is round the pupil (inside the collarette), `outer` the periphery. These colours are
 * assumptions, picked by eye against eye photographs on Wikimedia Commons, with the categories of the usual photographic
 * grading (blue / grey / green / hazel / brown; Franssen et al. 2008, J Optom). Blue and green eyes hold no blue or green
 * pigment — it is scattering in the stroma with little melanin (Wikipedia "Eye color"); only the apparent colour is drawn here.
 */
export const IRIS_COLOURS: Record<IrisName, { inner: string; outer: string }> = {
  brown: { inner: '#6b4426', outer: '#4a2e1a' },
  dark: { inner: '#3a2416', outer: '#24160e' },
  hazel: { inner: '#8a6330', outer: '#5f6a3c' },
  green: { inner: '#8f7c3e', outer: '#4f7150' },
  blue: { inner: '#9aaab4', outer: '#4c6f95' },
  grey: { inner: '#a3a8a6', outer: '#6c777e' },
}

/** 巩膜和血管的颜色（sRGB，假设）/ colours of the sclera and its vessels (sRGB, assumptions) */
const SCLERA = '#e6ded3'
const VESSEL = '#b0453c'
const CARUNCLE = '#d48a86'
const PUPIL = '#050404'

/** sRGB 颜色 → 线性的常量节点 / an sRGB colour → a linear constant node */
function lin(hex: string): N {
  const c = new Color(hex)
  return vec3(c.r, c.g, c.b)
}

/** 遮蔽数据纹理的分箱数 / bins of the occlusion data texture */
const BINS = 24
/** 网格的分段：角膜、角膜缘到赤道、赤道到后极；经线 / mesh segments: cornea, limbus to equator, equator to the back pole; meridians */
const RINGS = { cornea: 14, front: 16, back: 6, around: 48 }
/**
 * 泪液线贴在表面之上多高、在上 / 下睑处向睑裂里伸多宽（米；假设：下睑泪河高约 0.2–0.3 mm，这里略宽一些，好看得见）。
 * How far above the surface the tear line sits and how far it reaches into the fissure at the upper / lower lid (metres;
 * assumptions: the lower tear meniscus is about 0.2–0.3 mm high; a little wider here so it can be seen).
 */
const TEAR_LIFT = 0.06 * MM
const TEAR_WIDTH = { upper: 0.3 * MM, lower: 0.55 * MM }
/** 注视过渡的时间常数（秒；假设）/ time constant of the gaze transition (seconds; an assumption) */
const GAZE_TAU = 0.05

/** 两只眼共用的可调参数 / Tunable parameters shared by both eyes. */
export class EyeLook {
  readonly irisInner = uniform(new Color())
  readonly irisOuter = uniform(new Color())
  /** 瞳孔直径（米）/ pupil diameter (metres) */
  readonly pupil = uniform(EYE.pupilDefault)
  iris: IrisName = DEFAULT_IRIS

  constructor() {
    this.setIris(DEFAULT_IRIS)
  }

  setIris(name: IrisName): boolean {
    const c = IRIS_COLOURS[name] ?? IRIS_COLOURS[DEFAULT_IRIS]
    const changed = name !== this.iris
    this.iris = name
    ;(this.irisInner.value as Color).setStyle(c.inner)
    ;(this.irisOuter.value as Color).setStyle(c.outer)
    return changed
  }

  /** 瞳孔直径（米），限在 2–8 mm / pupil diameter (metres), kept within 2–8 mm */
  setPupil(d: number): void {
    this.pupil.value = Math.min(EYE.pupilRange[1], Math.max(EYE.pupilRange[0], d))
  }
}

/** 一只眼的网格：局部坐标属性 aEye（x 水平、y 竖直、z 光轴，米）/ The mesh of one eye, with the eye-local attribute aEye (x horizontal, y vertical, z the axis, metres). */
export function buildEyeGeometry(fit: EyeFit, shape: EyeShape): BufferGeometry {
  const { e1, e2, a } = eyeBasis(fit.axis)
  const thetas: number[] = []
  for (let i = 0; i <= RINGS.cornea; i++) thetas.push((shape.thetaLimbus * i) / RINGS.cornea)
  for (let i = 1; i <= RINGS.front; i++) thetas.push(shape.thetaLimbus + ((Math.PI / 2 - shape.thetaLimbus) * i) / RINGS.front)
  for (let i = 1; i <= RINGS.back; i++) thetas.push(Math.PI / 2 + ((Math.PI / 2) * i) / RINGS.back)
  const nr = thetas.length, na = RINGS.around
  // 极点各一个顶点，其余每圈 na 个 / one vertex at each pole, na on every other ring
  const count = 2 + (nr - 2) * na
  const pos = new Float32Array(count * 3)
  const nor = new Float32Array(count * 3)
  const loc = new Float32Array(count * 3)
  const put = (k: number, l: V3, n: V3): void => {
    loc.set(l, k * 3)
    for (let j = 0; j < 3; j++) {
      pos[k * 3 + j] = fit.centre[j]! + e1[j]! * l[0] + e2[j]! * l[1] + a[j]! * l[2]
      nor[k * 3 + j] = e1[j]! * n[0] + e2[j]! * n[1] + a[j]! * n[2]
    }
  }
  const local = (theta: number, phi: number): { l: V3; n: V3 } => {
    const s = Math.sin(theta), c = Math.cos(theta)
    const r = theta < shape.thetaLimbus ? shape.zCornea * c + Math.sqrt(Math.max(0, shape.corneaRadius ** 2 - (shape.zCornea * s) ** 2)) : shape.radius
    const l: V3 = [r * s * Math.cos(phi), r * s * Math.sin(phi), r * c]
    const n: V3 = theta < shape.thetaLimbus ? [l[0] / shape.corneaRadius, l[1] / shape.corneaRadius, (l[2] - shape.zCornea) / shape.corneaRadius] : [l[0] / r, l[1] / r, l[2] / r]
    return { l, n }
  }
  put(0, [0, 0, shape.apex], [0, 0, 1])
  for (let i = 1; i < nr - 1; i++) {
    for (let j = 0; j < na; j++) {
      const { l, n } = local(thetas[i]!, (2 * Math.PI * j) / na)
      put(1 + (i - 1) * na + j, l, n)
    }
  }
  put(count - 1, [0, 0, -shape.radius], [0, 0, -1])
  const index: number[] = []
  const ring = (i: number, j: number): number => 1 + (i - 1) * na + (j % na)
  for (let j = 0; j < na; j++) index.push(0, ring(1, j), ring(1, j + 1))
  for (let i = 1; i < nr - 2; i++) {
    for (let j = 0; j < na; j++) {
      const a0 = ring(i, j), a1 = ring(i, j + 1), b0 = ring(i + 1, j), b1 = ring(i + 1, j + 1)
      index.push(a0, b0, b1, a0, b1, a1)
    }
  }
  for (let j = 0; j < na; j++) index.push(ring(nr - 2, j), count - 1, ring(nr - 2, j + 1))
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('normal', new BufferAttribute(nor, 3))
  g.setAttribute('aEye', new BufferAttribute(loc, 3))
  g.setIndex(new BufferAttribute(Uint32Array.from(index), 1))
  return g
}

/** 一只眼：网格、材质和它的统一变量 / One eye: mesh, material and its uniforms. */
class Eye {
  readonly mesh: Mesh
  readonly material: MeshSSSNodeMaterial
  readonly shape: EyeShape
  readonly basis: { e1: V3; e2: V3; a: V3 }
  /** 静止空间里的注视旋转 / the gaze rotation in rest space */
  private readonly gaze = uniform(new Matrix3())
  /** 世界方向 → 眼的局部坐标 / world direction → eye-local frame */
  private readonly toEye = uniform(new Matrix3())
  private readonly centreU: N
  /** 头骨关节所在的行（浮点存放）/ the skull joint's row (stored as a float) */
  readonly jointRow = uniform(0)
  /** 睑缘分箱：x 的范围；纹理里每箱 (上睑 y, 下睑 y) / lid-margin bins: the x range; per bin (upper lid y, lower lid y) in the texture */
  readonly margins: DataTexture
  private readonly marginX = uniform(new Vector3(-0.01, 0.01, 0))
  private readonly caruncle = uniform(new Vector3(0, 0, 0))
  /** 有没有睑缘数据（没有就不画遮蔽）/ whether lid-margin data exist (no occlusion without them) */
  private readonly hasMargins = uniform(0)
  /** 当前角度（度）/ current angles (degrees) */
  yaw = 0
  pitch = 0

  constructor(
    readonly fit: EyeFit,
    private readonly look: EyeLook,
    private readonly skinning: SkinningData,
  ) {
    this.shape = eyeShape(fit.radius)
    this.basis = eyeBasis(fit.axis)
    this.centreU = uniform(new Vector3(...fit.centre))
    this.margins = new DataTexture(new Float32Array(BINS * 4), BINS, 1, RGBAFormat, FloatType)
    this.margins.minFilter = this.margins.magFilter = NearestFilter
    this.margins.generateMipmaps = false
    this.margins.needsUpdate = true
    this.material = this.makeMaterial()
    this.mesh = new Mesh(buildEyeGeometry(fit, this.shape), this.material)
    this.mesh.name = `lifelike-eye-${fit.side}`
    this.mesh.matrixAutoUpdate = false
    this.mesh.frustumCulled = false
    // 不参与拾取：拾取走解剖部件的 BVH / not pickable: picking goes through the anatomical parts' BVHs
    this.mesh.raycast = () => {}
    this.setSkinning('off')
    this.setGaze(0, 0, null)
  }

  private makeMaterial(): MeshSSSNodeMaterial {
    const m = new MeshSSSNodeMaterial()
    const sh = this.shape
    const look = this.look
    const local: N = varying(attribute('aEye', 'vec3'))
    // 注视转过之后、蒙皮之前，相对球心的头部坐标（遮蔽和泪阜用）/ head-frame position relative to the centre after the gaze turn, before skinning (for occlusion and the caruncle)
    const rel: N = varying((this.gaze as N).mul((positionGeometry as N).sub(this.centreU)))

    const rl = float(sh.limbus)
    const rho: N = length(local.xy)
    const isCornea: N = local.z.greaterThan(sh.zLimbus)
    // 解析的表面法线（眼的局部坐标）/ the analytic surface normal (eye-local frame)
    const nC: N = normalize(local.sub(vec3(0, 0, sh.zCornea)))
    const view: N = normalize((this.toEye as N).mul((cameraPosition as N).sub(positionWorld)))
    // 视线在角膜表面折射，与虹膜面（中央向前隆起 irisCone）求交：先按平面求一次，再按交点处的高度修正一次
    // the view ray refracts at the corneal surface and meets the iris surface (bowed forward by irisCone at the centre): once against the plane, then once more at the height found there
    const t: N = refract(view.negate(), nC, 1 / EYE.corneaIor)
    const tz: N = min(t.z, float(-1e-4))
    const zIris = (r: N): N => float(sh.zIris).add(float(EYE.irisCone).mul(float(1).sub(clamp(r.div(rl), 0, 1))))
    const h0: N = local.add(t.mul(float(sh.zIris).sub(local.z).div(tz)))
    const h: N = local.add(t.mul(zIris(length(h0.xy)).sub(local.z).div(tz))).xy
    const r: N = length(h)
    const rp: N = (look.pupil as N).mul(0.5)

    // —— 虹膜 / the iris ——
    const iris = Fn(() => {
      const u: N = clamp(r.sub(rp).div(rl.sub(rp)), 0, 1)
      const dir: N = h.div(max(r, float(1e-6)))
      const base: N = mix((look.irisInner as N), (look.irisOuter as N), smoothstep(0.12, 0.7, u))
      // 放射状纤维：角向变化快、径向慢（用单位圆上的坐标，没有接缝）/ radial fibres: fast around, slow outwards (unit-circle coordinates, no seam)
      const f1: N = mx_noise_float(vec3(dir.x.mul(34), dir.y.mul(34), u.mul(2.2)))
      const f2: N = mx_noise_float(vec3(dir.x.mul(90), dir.y.mul(90), u.mul(5.0).add(7.0)))
      const col: N = base.mul(float(0.66).add(f1.mul(0.42)).add(f2.mul(0.24))).toVar()
      // 亮的小梁：纤维里较亮的那些 / light trabeculae: the brighter of the fibres
      col.mulAssign(float(1).add(smoothstep(0.35, 0.95, f1).mul(0.35)))
      // 卷缩轮：瞳孔周围约三分之一处一圈起伏的亮带 / the collarette: a wavy light band about a third of the way out
      const uc: N = float(0.33).add(mx_noise_float(vec3(dir.x.mul(6), dir.y.mul(6), 3.0)).mul(0.05))
      const band: N = float(1).sub(smoothstep(0.0, 0.06, abs(u.sub(uc))))
      col.assign(mix(col, (look.irisInner as N).mul(1.45), band.mul(0.45)))
      // 隐窝：中周部的暗洞 / crypts: dark pits in the mid-periphery
      // 在极坐标里取，隐窝沿径向拉长 / taken in polar terms, so the crypts are drawn out radially
      const w: N = mx_worley_noise_float(vec3(dir.x.mul(9.0), dir.y.mul(9.0), u.mul(3.2)))
      const zone: N = smoothstep(0.26, 0.38, u).mul(float(1).sub(smoothstep(0.7, 0.86, u)))
      col.mulAssign(float(1).sub(float(1).sub(smoothstep(0.12, 0.42, w)).mul(zone).mul(0.8)))
      // 外周的收缩沟：几圈细的暗环 / contraction furrows in the periphery: a few thin dark rings
      const furrow: N = abs(mx_noise_float(vec3(dir.x.mul(3.0), dir.y.mul(3.0), u.mul(14.0))))
      col.mulAssign(float(1).sub(float(1).sub(smoothstep(0.0, 0.08, furrow)).mul(smoothstep(0.62, 0.8, u)).mul(0.35)))
      // 瞳孔缘的色素襞和外周的暗环 / the pupillary ruff and the dark outer rim
      col.assign(mix(col, vec3(0.03, 0.02, 0.015), float(1).sub(smoothstep(0.0, 0.07, u)).mul(0.85)))
      col.mulAssign(float(1).sub(smoothstep(0.72, 1.0, u).mul(0.75)))
      // 瞳孔 / the pupil
      const pupil: N = smoothstep(rp.sub(0.06 * MM), rp.add(0.06 * MM), r)
      // 越过角膜缘的视线：落在角膜缘的暗环上 / a ray beyond the limbus lands on the dark limbal ring
      const beyond: N = smoothstep(rl.sub(0.15 * MM), rl.add(0.1 * MM), r)
      return mix(mix(lin(PUPIL), col, pupil), (look.irisOuter as N).mul(0.25), beyond)
    })()

    // —— 巩膜 / the sclera ——
    const sclera = Fn(() => {
      const p: N = local.div(MM)
      const ridge: N = float(1).sub(abs(mx_noise_float(p.mul(0.55))))
      const fine: N = float(1).sub(abs(mx_noise_float(p.mul(1.4).add(11.0))))
      const vessel: N = ridge.pow(16).add(fine.pow(22).mul(0.7))
      // 血管多在内外眦一侧、离角膜缘远处 / vessels gather towards the canthi, away from the limbus
      const side: N = smoothstep(0.25, 0.85, abs(local.x).div(max(rho, float(1e-6))))
      const far: N = smoothstep(sh.limbus + 1.0 * MM, sh.limbus + 6.0 * MM, rho)
      const col: N = mix(lin(SCLERA), lin(VESSEL), clamp(vessel.mul(side).mul(far).mul(0.8), 0, 1)).toVar()
      // 外周略带黄粉（结膜和巩膜外层）/ a faint yellow-pink towards the periphery (conjunctiva and episclera)
      col.mulAssign(mix(vec3(1), vec3(1.0, 0.9, 0.86), far.mul(side).mul(0.8)))
      // 泪阜的提示 / a hint of the caruncle
      const car: N = float(1).sub(smoothstep(1.0 * MM, 3.0 * MM, length(rel.sub(this.caruncle))))
      return mix(col, lin(CARUNCLE), car.mul(0.75))
    })()

    // 角膜缘：虹膜到巩膜的过渡，外面一圈淡淡的灰影 / the limbus: iris to sclera, with a faint grey shadow just outside
    const irisMask: N = select(isCornea, float(1), float(0)).mul(float(1).sub(smoothstep(rl.sub(0.2 * MM), rl.add(0.25 * MM), rho)))
    const limbalShade: N = float(1).sub(float(1).sub(smoothstep(0.0, 1.1 * MM, rho.sub(rl))).mul(0.5))
    const colour: N = mix(sclera.mul(limbalShade), iris, irisMask)

    // —— 眼部遮蔽：离睑缘越近越暗 / eye occlusion: darker the closer to a lid margin ——
    const occlusion = Fn(() => {
      const x0: N = (this.marginX as N).x
      const x1: N = (this.marginX as N).y
      const fx: N = clamp(rel.x.sub(x0).div(max(x1.sub(x0), float(1e-6))), 0, 1).mul(BINS - 1)
      const i0: N = int(floor(fx))
      const i1: N = int(min(floor(fx).add(1), float(BINS - 1)))
      const a0: N = textureLoad(this.margins, ivec2(i0, int(0)))
      const a1: N = textureLoad(this.margins, ivec2(i1, int(0)))
      const m: N = mix(a0, a1, fx.sub(floor(fx)))
      const du: N = m.x.sub(rel.y)
      const dl: N = rel.y.sub(m.y)
      const dx: N = min(rel.x.sub(x0), x1.sub(rel.x))
      const occ: N = float(1)
        .sub(float(1).sub(smoothstep(-0.3 * MM, 3.5 * MM, du)).mul(0.78))
        .mul(float(1).sub(float(1).sub(smoothstep(-0.2 * MM, 1.5 * MM, dl)).mul(0.5)))
        .mul(float(1).sub(float(1).sub(smoothstep(0.0, 3.0 * MM, dx)).mul(0.55)))
      return mix(float(1), clamp(occ, 0.15, 1), this.hasMargins)
    })()

    m.colorNode = colour.mul(occlusion)
    m.aoNode = occlusion
    // 泪膜让整个眼表都很光滑；角膜最光滑 / the tear film makes the whole surface smooth; the cornea smoothest
    m.roughnessNode = mix(float(0.16), float(0.04), irisMask)
    // 镜面也被睑缘挡掉一部分，但不全挡（照片里高光一直到睑缘）/ the lids also take part of the specular, not all of it (in photos highlights reach the lid margin)
    m.specularIntensityNode = mix(float(0.45), float(1), occlusion)
    m.metalness = 0
    m.ior = EYE.corneaIor
    // 巩膜微弱的透光（偏红）/ a faint red-leaning translucency of the sclera
    m.thicknessColorNode = vec3(0.6, 0.28, 0.22).mul(float(0.12).mul(float(1).sub(irisMask)))
    m.thicknessDistortionNode = float(0.2)
    m.thicknessAmbientNode = float(0.0)
    m.thicknessAttenuationNode = float(0.5)
    m.thicknessPowerNode = float(3.0)
    m.thicknessScaleNode = float(2.0)
    return m
  }

  /** 顶点位置：绕球心转注视角，再按头骨关节做刚体蒙皮（与 skinning.ts 同一公式）/ Vertex position: the gaze turn about the centre, then rigid skinning by the skull joint (the formula of skinning.ts). */
  setSkinning(mode: SkinningMode): void {
    const data = this.skinning
    const gaze: N = this.gaze
    const centre: N = this.centreU
    const row: N = this.jointRow
    this.material.positionNode = Fn(() => {
      const rest: N = (centre as N).add(gaze.mul((positionLocal as N).sub(centre))).toVar()
      const n: N = gaze.mul(normalLocal).toVar()
      if (mode === 'off') {
        ;(normalLocal as N).assign(n)
        return rest
      }
      const r: N = int(row.add(0.5))
      const texel = (col: number): N => textureLoad(data.joints, (ivec2 as N)(int(col), r))
      if (mode === 'pose+shape') {
        const p1: N = vec4(rest, 1)
        rest.assign(vec3(dot(texel(2), p1), dot(texel(3), p1), dot(texel(4), p1)))
      }
      const q: N = texel(0).toVar()
      const d: N = texel(1).toVar()
      const rotate = (v: N): N => v.add((cross(q.xyz, (cross(q.xyz, v) as N).add(v.mul(q.w))) as N).mul(2))
      const translation: N = q.w.mul(d.xyz).sub(d.w.mul(q.xyz)).add(cross(q.xyz, d.xyz)).mul(2)
      ;(normalLocal as N).assign(rotate(n))
      return rotate(rest).add(translation)
    })() as typeof this.material.positionNode
    this.material.needsUpdate = true
  }

  /**
   * 设注视角（度）和头骨此刻的转动（行主序；null = 静止）。toEye = Bᵀ·Gᵀ·Sᵀ 把世界方向换到眼的局部坐标。
   * Set the gaze angles (degrees) and the skull's current rotation (row-major; null = at rest). toEye = Bᵀ·Gᵀ·Sᵀ takes
   * world directions into the eye-local frame.
   */
  setGaze(yaw: number, pitch: number, skull: M3 | null): void {
    this.yaw = yaw
    this.pitch = pitch
    const g = gazeRotation(yaw, pitch, this.fit.axis)
    ;(this.gaze.value as Matrix3).set(...g)
    const { e1, e2, a } = this.basis
    const s = skull ?? ([1, 0, 0, 0, 1, 0, 0, 0, 1] as M3)
    // 眼的局部轴转到世界：w = S·G·b；toEye 的各行就是这三个向量 / the local axes in the world: w = S·G·b; the rows of toEye are these three vectors
    const w = [e1, e2, a].map((b) => m3apply(s, m3apply(g, b)))
    ;(this.toEye.value as Matrix3).set(w[0]![0], w[0]![1], w[0]![2], w[1]![0], w[1]![1], w[1]![2], w[2]![0], w[2]![1], w[2]![2])
  }

  /** 写入睑缘分箱（头部坐标，相对球心，米）/ Write the lid-margin bins (head frame, relative to the centre, metres). */
  setMargins(x0: number, x1: number, upper: Float32Array, lower: Float32Array, caruncle: V3 | null): void {
    const d = this.margins.image.data as Float32Array
    for (let i = 0; i < BINS; i++) {
      d[i * 4] = upper[i]!
      d[i * 4 + 1] = lower[i]!
    }
    this.margins.needsUpdate = true
    ;(this.marginX.value as Vector3).set(x0, x1, 0)
    if (caruncle) (this.caruncle.value as Vector3).set(...caruncle)
    this.hasMargins.value = 1
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.margins.dispose()
  }
}

/** 一条睑缘：沿睑缘（从内眦到外眦）的睑缘内卷顶点 / One lid margin: the lid-rim vertices along it (medial to lateral canthus). */
interface LidCurve {
  side: EyeSide
  upper: boolean
  /** 皮肤顶点下标 / skin vertex indices */
  vertices: number[]
}

/** 从开口数据取出四条睑缘（睑缘顶点换成跟随它的内卷顶点）/ The four lid margins from the openings data (margin vertices replaced by the rim vertices following them). */
export function lidCurves(openings: FaceOpenings): LidCurve[] {
  const rimOf = new Map<number, number>()
  for (const rim of openings.lidRims) rim.of.forEach((m, i) => rimOf.set(m, rim.vertices[i]!))
  const out: LidCurve[] = []
  for (const side of ['L', 'R'] as const) {
    for (const upper of [true, false]) {
      const list = openings.margins[`${upper ? 'upper' : 'lower'}Lid${side}`]
      if (Array.isArray(list) && list.length >= 2) out.push({ side, upper, vertices: list.map((v) => rimOf.get(v) ?? v) })
    }
  }
  return out
}

/**
 * 泪液线：皮肤的跟随层。每个睑缘内卷顶点有两个副本：外缘一个贴在内卷的边上，内缘一个向睑裂里伸 TEAR_WIDTH；两者都抬到眼球表面
 * 之上 TEAR_LIFT。皮肤的静止位置一变（表情、体型），就在 CPU 上重排这些副本，并把睑缘交给眼去算遮蔽。
 * The tear line: a follower of the skin. Every lid-rim vertex has two copies: the outer one on the rim's edge, the inner one
 * reaching TEAR_WIDTH into the fissure; both lifted TEAR_LIFT above the eye surface. Whenever the skin's rest positions change
 * (expression, shape) the copies are laid out again on the CPU and the margins are handed to the eyes for the occlusion.
 */
class TearLine extends SkinPatch {
  private layout: { curves: LidCurve[]; eyes: Map<EyeSide, Eye> } | null = null
  /** 爆炸位移也交给眼 / the explode offset is passed on to the eyes too */
  onOffset: ((x: number, y: number, z: number) => void) | null = null

  override setOffset(x: number, y: number, z: number): void {
    super.setOffset(x, y, z)
    this.onOffset?.(x, y, z)
  }

  constructor(source: SkinGeometry, curves: LidCurve[], eyes: Map<EyeSide, Eye>, material: MeshPhysicalNodeMaterial) {
    const vertices: number[] = []
    const index: number[] = []
    const alpha: number[] = []
    for (const c of curves) {
      const base = vertices.length
      for (const v of c.vertices) {
        vertices.push(v, v)
        alpha.push(1, 0)
      }
      for (let k = 0; k + 1 < c.vertices.length; k++) {
        const o0 = base + k * 2, i0 = o0 + 1, o1 = o0 + 2, i1 = o0 + 3
        index.push(o0, i0, i1, o0, i1, o1)
      }
    }
    super(source, null, material, undefined, { vertices: Uint32Array.from(vertices), index: Uint32Array.from(index) })
    this.mesh.geometry.setAttribute('aTear', new BufferAttribute(Float32Array.from(alpha), 1))
    this.layout = { curves, eyes }
    this.setPositions(source.position, source.normal)
  }

  override setPositions(position: ArrayLike<number>, normal: ArrayLike<number>): void {
    super.setPositions(position, normal)
    if (!this.layout) return // 基类构造时还没有布局 / no layout yet while the base class constructs
    const attr = this.mesh.geometry.getAttribute('position') as BufferAttribute
    const p = attr.array as Float32Array
    const nAttr = this.mesh.geometry.getAttribute('normal') as BufferAttribute
    const nrm = nAttr.array as Float32Array
    const { curves, eyes } = this.layout
    let k = 0
    const bySide = new Map<EyeSide, { upper: V3[]; lower: V3[] }>()
    for (const c of curves) {
      const eye = eyes.get(c.side)
      const pts: V3[] = c.vertices.map((v) => [position[v * 3]!, position[v * 3 + 1]!, position[v * 3 + 2]!])
      if (!eye) {
        k += c.vertices.length * 2
        continue
      }
      const C = eye.fit.centre
      const R = eye.shape.radius + TEAR_LIFT
      const width = c.upper ? TEAR_WIDTH.upper : TEAR_WIDTH.lower
      // 睑裂中心：这条睑缘两端（内外眦）的中点 / the fissure centre: midpoint of this margin's two ends (the canthi)
      const ends = [pts[0]!, pts[pts.length - 1]!]
      const mid: V3 = [(ends[0]![0] + ends[1]![0]) / 2, (ends[0]![1] + ends[1]![1]) / 2, (ends[0]![2] + ends[1]![2]) / 2]
      // 半径 r 处、q 方向上的点 / the point in the direction of q at radius r
      const along = (q: V3, r: number): V3 => {
        const d: V3 = [q[0] - C[0], q[1] - C[1], q[2] - C[2]]
        const l = Math.hypot(d[0], d[1], d[2]) || 1
        return [C[0] + (d[0] * r) / l, C[1] + (d[1] * r) / l, C[2] + (d[2] * r) / l]
      }
      const rel: V3[] = []
      for (const q of pts) {
        // 外缘在内卷的边上（它可能比眼球表面略高），内缘落在眼球表面：一条从睑缘斜到眼球上的窄带，就是泪河的样子
        // the outer edge on the rim's edge (which may stand a little above the eye surface), the inner edge on the eye surface: a narrow band sloping from the lid onto the globe, the shape of the tear meniscus
        const outer = along(q, Math.max(R, Math.hypot(q[0] - C[0], q[1] - C[1], q[2] - C[2]) + TEAR_LIFT))
        // 向睑裂中心的竖直方向伸进去（两端收窄到零）/ reach in vertically towards the fissure centre (tapering to nothing at the ends)
        const dy = mid[1] - outer[1]
        const reach = Math.min(width, Math.abs(dy)) * Math.sign(dy || (c.upper ? -1 : 1))
        const inner = along([outer[0], outer[1] + reach, outer[2]], R)
        p.set(outer, k * 3)
        p.set(inner, (k + 1) * 3)
        // 法线取眼球表面的（径向）：泪膜的高光跟眼球连成一片 / normals are the eye surface's (radial): the tear film's highlight joins the globe's
        for (const [j, x] of [[k, outer], [k + 1, inner]] as const) {
          const l = Math.hypot(x[0] - C[0], x[1] - C[1], x[2] - C[2]) || 1
          nrm.set([(x[0] - C[0]) / l, (x[1] - C[1]) / l, (x[2] - C[2]) / l], j * 3)
        }
        k += 2
        rel.push([q[0] - C[0], q[1] - C[1], q[2] - C[2]])
      }
      const entry = bySide.get(c.side) ?? { upper: [], lower: [] }
      ;(c.upper ? entry.upper : entry.lower).push(...rel)
      bySide.set(c.side, entry)
    }
    attr.needsUpdate = true
    nAttr.needsUpdate = true
    for (const [side, m] of bySide) {
      const eye = eyes.get(side)
      if (eye && m.upper.length >= 2 && m.lower.length >= 2) setEyeMargins(eye, m.upper, m.lower)
    }
  }
}

/** 按 x 分箱的上下睑缘高度（头部坐标，相对球心）；内眦一端作为泪阜的位置 / Upper and lower margin heights binned by x (head frame, relative to the centre); the medial end serves as the caruncle. */
function setEyeMargins(eye: Eye, upper: V3[], lower: V3[]): void {
  const all = [...upper, ...lower]
  const x0 = Math.min(...all.map((q) => q[0]))
  const x1 = Math.max(...all.map((q) => q[0]))
  const at = (curve: V3[], x: number): number => {
    const s = [...curve].sort((a, b) => a[0] - b[0])
    if (x <= s[0]![0]) return s[0]![1]
    for (let i = 1; i < s.length; i++) {
      if (x <= s[i]![0]) {
        const a = s[i - 1]!, b = s[i]!
        const t = (x - a[0]) / Math.max(1e-9, b[0] - a[0])
        return a[1] + (b[1] - a[1]) * t
      }
    }
    return s[s.length - 1]![1]
  }
  const up = new Float32Array(BINS), lo = new Float32Array(BINS)
  for (let i = 0; i < BINS; i++) {
    const x = x0 + ((x1 - x0) * i) / (BINS - 1)
    up[i] = at(upper, x)
    lo[i] = at(lower, x)
  }
  // 内眦：离正中线近的那一端；左眼（+x）在 x 小的一端 / the medial canthus: the end nearer the midline; for the left eye (+x) the small-x end
  const medial = upper[0]!
  const R = eye.shape.radius
  const l = Math.hypot(medial[0], medial[1], medial[2]) || 1
  eye.setMargins(x0, x1, up, lo, [(medial[0] * R) / l, (medial[1] * R) / l, (medial[2] * R) / l])
}

/** 一对写实的眼和泪液线 / The pair of lifelike eyes and the tear line. */
export class LookEyes {
  readonly group = new Group()
  readonly eyes: Eye[]
  private readonly bySide = new Map<EyeSide, Eye>()
  private readonly tearMaterial: MeshPhysicalNodeMaterial
  readonly tear: TearLine | null
  /** 交给 Viewer.addFollower 的对象 / the object handed to Viewer.addFollower */
  readonly follower: { patch: SkinPatch; setSkinning(mode: SkinningMode): void; dispose(): void } | null
  private shown = false
  private target: { yaw: number; pitch: number }[] = []

  constructor(
    fits: EyeFit[],
    look: EyeLook,
    private readonly skinning: SkinningData,
    skin: SkinGeometry | null,
    openings: FaceOpenings | null,
  ) {
    this.group.name = 'lifelike-eyes'
    this.eyes = fits.map((f) => new Eye(f, look, skinning))
    for (const e of this.eyes) {
      this.bySide.set(e.fit.side, e)
      this.group.add(e.mesh)
    }
    this.group.visible = false
    this.target = this.eyes.map(() => ({ yaw: 0, pitch: 0 }))
    this.tearMaterial = new MeshPhysicalNodeMaterial()
    this.tearMaterial.transparent = true
    // 上下睑的带子绕向相反：两面都画 / the upper and lower bands wind opposite ways: draw both faces
    this.tearMaterial.side = DoubleSide
    this.tearMaterial.depthWrite = false
    this.tearMaterial.colorNode = lin('#f3e6e2')
    this.tearMaterial.opacityNode = (attribute('aTear', 'float') as N).mul(0.55)
    this.tearMaterial.roughness = 0.03
    this.tearMaterial.metalness = 0
    this.tearMaterial.ior = 1.336
    this.tearMaterial.polygonOffset = true
    this.tearMaterial.polygonOffsetFactor = -2
    this.tearMaterial.polygonOffsetUnits = -2
    const curves = openings ? lidCurves(openings) : []
    this.tear = skin && curves.length ? new TearLine(skin, curves, this.bySide, this.tearMaterial) : null
    if (this.tear) {
      this.tear.mesh.name = 'lifelike-tear-line'
      this.tear.mesh.renderOrder = 2
      this.tear.mesh.raycast = () => {}
    }
    const tear = this.tear
    if (tear) tear.onOffset = (x, y, z) => this.setOffset(x, y, z)
    this.follower = tear
      ? {
          patch: tear,
          setSkinning: (mode) => this.setSkinning(mode),
          dispose: () => this.dispose(),
        }
      : null
  }

  get visible(): boolean {
    return this.shown
  }

  /** 显示或隐藏；`sides` 给出各侧是否画（某侧扫描的眼球部件被选中时那一侧不画）/ Show or hide; `sides` says whether each side is drawn (a side is not drawn while its scanned eyeball parts are selected). */
  setVisible(on: boolean, sides: { L: boolean; R: boolean } = { L: true, R: true }): boolean {
    let changed = on !== this.shown
    this.shown = on
    this.group.visible = on
    for (const e of this.eyes) {
      const v = on && sides[e.fit.side]
      if (e.mesh.visible !== v) changed = true
      e.mesh.visible = v
    }
    if (this.tear && this.tear.mesh.visible !== on) {
      this.tear.mesh.visible = on
      changed = true
    }
    return changed
  }

  setSkinning(mode: SkinningMode): void {
    for (const e of this.eyes) e.setSkinning(mode)
    if (this.tear) {
      this.tearMaterial.positionNode = positionNodeFor(this.skinning, mode, false) as typeof this.tearMaterial.positionNode
      this.tearMaterial.needsUpdate = true
    }
  }

  /** 爆炸位移：眼跟着皮肤走（由泪液线的 setOffset 转来）/ explode offset: the eyes go with the skin (forwarded from the tear line's setOffset) */
  private offset: V3 = [0, 0, 0]
  setOffset(x: number, y: number, z: number): void {
    this.offset = [x, y, z]
    for (const e of this.eyes) {
      e.mesh.matrix.makeTranslation(x, y, z)
      e.mesh.matrixWorldNeedsUpdate = true
    }
  }

  /** 头骨关节所在的行（蒙皮纹理）/ the skull joint's row (in the skinning texture) */
  setJointRow(row: number): void {
    for (const e of this.eyes) e.jointRow.value = row
  }

  /**
   * 推进一帧：算出目标角度（看相机或固定角度，集合并限幅），向它过渡，更新各眼的统一变量。返回是否有变化。
   * `camera` 是世界坐标；`skull` 是头骨关节此刻的变换（静止 → 当前，null = 静止），`offset` 是爆炸位移。
   * Advance one frame: work out the target angles (camera or fixed; converged and clamped), ease towards them and update each
   * eye's uniforms. Returns whether anything changed. `camera` is in world coordinates; `skull` is the skull joint's current
   * transform (rest → now; null = at rest), `offset` the explode offset.
   */
  step(dt: number, camera: V3, gaze: GazeSetting, skull: { rigid: M3; t: V3 } | null): boolean {
    const offset = this.offset
    const centres = this.eyes.map((e) => e.fit.centre)
    let target: V3
    if (gaze === 'camera') {
      // 相机换到头部静止坐标：先减爆炸位移，再用头骨变换的逆 / the camera into the head rest frame: minus the explode offset, then the skull transform's inverse
      const c: V3 = [camera[0] - offset[0], camera[1] - offset[1], camera[2] - offset[2]]
      if (skull) {
        // x = r·p + t 的逆（r 带体型缩放时用转置近似）/ the inverse of x = r·p + t (the transpose as an approximation when r carries a shape scale)
        const d: V3 = [c[0] - skull.t[0], c[1] - skull.t[1], c[2] - skull.t[2]]
        const m = skull.rigid
        target = [m[0] * d[0] + m[3] * d[1] + m[6] * d[2], m[1] * d[0] + m[4] * d[1] + m[7] * d[2], m[2] * d[0] + m[5] * d[1] + m[8] * d[2]]
      } else target = c
    } else target = fixedTarget(centres, gaze.yaw, gaze.pitch)
    this.target = eyeAngles(centres, target)
    const k = dt > 0 ? 1 - Math.exp(-dt / GAZE_TAU) : 1
    let changed = false
    this.eyes.forEach((e, i) => {
      const t = this.target[i]!
      let yaw = e.yaw + (t.yaw - e.yaw) * k
      let pitch = e.pitch + (t.pitch - e.pitch) * k
      if (Math.abs(t.yaw - yaw) < 0.02) yaw = t.yaw
      if (Math.abs(t.pitch - pitch) < 0.02) pitch = t.pitch
      if (yaw !== e.yaw || pitch !== e.pitch) changed = true
      // 头骨的转动可能变了（姿势）：每帧都写，代价只是两个矩阵 / the skull's rotation may have changed (pose): written every frame, costing two matrices
      e.setGaze(yaw, pitch, skull ? skull.rigid : null)
    })
    return changed
  }

  /** 当前各眼的注视角（度）/ each eye's current gaze angles (degrees) */
  angles(): { side: EyeSide; yaw: number; pitch: number; target: { yaw: number; pitch: number } }[] {
    return this.eyes.map((e, i) => ({ side: e.fit.side, yaw: e.yaw, pitch: e.pitch, target: this.target[i] ?? { yaw: 0, pitch: 0 } }))
  }

  /** 瞳孔中心到转动中心的距离（米）：睑随注视的量用它 / distance of the pupil centre from the centre of rotation (metres): used for the lid coupling */
  pupilDistance(side: EyeSide): number {
    return (this.bySide.get(side) ?? this.eyes[0]!).shape.pupilDistance
  }

  dispose(): void {
    for (const e of this.eyes) e.dispose()
    this.group.removeFromParent()
    this.tear?.dispose()
    this.tearMaterial.dispose()
  }
}
