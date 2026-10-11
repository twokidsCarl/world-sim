// GPU 蒙皮：关节 / 肌肉数据纹理，以及所有材质共用的顶点位置节点。
// GPU skinning: the joint / muscle data textures and the vertex position node every material shares.
//
// 做法 / Approach
//   · 每个顶点带 4 个关节下标（uint16，归一化属性，着色器里乘回 65535）和 4 个权重（uint8 归一化）。
//     刚体部件的顶点全部指向同一个关节，权重 1；这样两条渲染路径、所有部件只用同一段着色器。
//     Each vertex carries four joint indices (uint16 as a normalized attribute, scaled back by
//     65535 in the shader) and four weights (normalized uint8). Rigid parts point every vertex at
//     one joint with weight 1, so both render paths and all parts share a single shader.
//   · 关节变换放在一张 RGBA32F 数据纹理里（每关节一行），只在姿势变化时更新。
//     Joint transforms live in one RGBA32F data texture (a row per joint), updated only when the pose changes.
//   · 混合用对偶四元数，与 tools/rig/pose.ts 的 skin(…, 'dqs') 同一公式；体型缩放先在静止空间线性混合。
//     Blending is dual-quaternion, the same formula as skin(…, 'dqs') in tools/rig/pose.ts; shape
//     scales are blended linearly in rest space first.
//   · 肌肉体积修正（tapered）在蒙皮之后做：`aThin` 属性为负数时表示 −(作用线下标 + 1)。
//     The muscle volume correction (tapered) follows skinning: a negative `aThin` attribute means −(line index + 1).
//   · 静止姿势下不使用这些节点：材质换回原来的位置节点，渲染结果与未摆姿势的路径逐位相同、没有额外开销。
//     At rest none of this is used: materials switch back to the original position node, so the
//     output is bit-for-bit the unposed path at no extra cost.

import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three/webgpu'
import { Fn, If, attribute, cameraPosition, cross, dot, float, int, ivec2, length, normalLocal, positionLocal, select, textureLoad, uniform, vec3, vec4 } from 'three/tsl'
import { JOINT_TEXELS, MUSCLE_TEXELS } from '../anatomy/rig.ts'

/** `aThin` 的取值：≥ 0 为可加粗的管半径；这个值表示"不加粗"；负数表示肌肉作用线。 */
/** `aThin` values: ≥ 0 a boostable tube radius; this value means "never boosted"; negative = a muscle line. */
export const NOT_BOOSTED = 1000
/** 加粗后的神经最多增粗这么多（米）/ Thickened nerves never grow by more than this (metres). */
const BOOST_MAX = 0.004
/** 这个半径（米）的神经恰好得到设定的最小宽度；更细的少一些，更粗的多一些。 */
/** A nerve of this radius (m) gets exactly the configured minimum; thinner ones less, thicker more. */
const BOOST_FULL_RADIUS = 0.0011
const BOOST_MIN_WEIGHT = 0.4
const BOOST_MAX_WEIGHT = 1.3

export type SkinningMode = 'off' | 'pose' | 'pose+shape'

function dataTexture(texels: number, rows: number): DataTexture {
  const t = new DataTexture(new Float32Array(texels * rows * 4), texels, rows, RGBAFormat, FloatType)
  t.minFilter = t.magFilter = NearestFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

/** 着色器读取的姿势数据 / The pose data the shaders read. */
export class SkinningData {
  readonly joints: DataTexture
  readonly muscles: DataTexture
  /** 加粗神经：每米距离保证的世界半径；0 为关闭 / Nerve aid: world radius guaranteed per metre of distance; 0 = off. */
  readonly boost = uniform(0)

  constructor(jointRows: number, muscleRows: number) {
    this.joints = dataTexture(JOINT_TEXELS, Math.max(1, jointRows))
    this.muscles = dataTexture(MUSCLE_TEXELS, Math.max(1, muscleRows))
  }

  /** 写入打包好的数据（长度必须与纹理一致）/ Write packed data (lengths must match the textures). */
  update(joints: Float32Array, muscles: Float32Array): void {
    ;(this.joints.image.data as Float32Array).set(joints)
    ;(this.muscles.image.data as Float32Array).set(muscles)
    this.joints.needsUpdate = true
    this.muscles.needsUpdate = true
  }

  dispose(): void {
    this.joints.dispose()
    this.muscles.dispose()
  }
}

// TSL 的类型定义跟不上这种逐分量的写法，节点在本文件内按 any 处理
// TSL's typings do not follow this component-wise style, so nodes are `any` inside this file
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

/** 神经加粗量（沿法线）；`thin` 为负或 NOT_BOOSTED 时为 0 / Nerve thickening along the normal; zero for negative or NOT_BOOSTED `thin`. */
function boostGrow(data: { boost: N }, position: N, thin: N): N {
  const t = select(thin.lessThan(0), float(NOT_BOOSTED), thin)
  // 保证的屏幕半径随管径变化，主干比细支更醒目
  // the guaranteed on-screen radius scales with calibre, so trunks read stronger than twigs
  const weight = t.div(BOOST_FULL_RADIUS).clamp(BOOST_MIN_WEIGHT, BOOST_MAX_WEIGHT)
  return position.sub(cameraPosition).length().mul(data.boost).mul(weight).sub(t).clamp(0, BOOST_MAX)
}

/**
 * 顶点位置节点。`hasThin`：几何是否带 `aThin` 属性（体表图图层没有）。
 * The vertex position node. `hasThin`: whether the geometry has the `aThin` attribute (the skin
 * map layer does not).
 */
export function positionNodeFor(data: SkinningData, mode: SkinningMode, hasThin = true): N {
  if (mode === 'off') {
    if (!hasThin) return positionLocal
    return (positionLocal as N).add((normalLocal as N).mul(boostGrow(data, positionLocal, attribute('aThin', 'float'))))
  }
  const withShape = mode === 'pose+shape'
  return Fn(() => {
    // 归一化的 uint16 → 整数行号 / normalized uint16 → integer row
    const idxF: N = (attribute('skinIndex', 'vec4') as N).mul(65535).add(0.5)
    const rows = [int(idxF.x), int(idxF.y), int(idxF.z), int(idxF.w)]
    const wv: N = attribute('skinWeight', 'vec4')
    const weights = [wv.x, wv.y, wv.z, wv.w]
    const texel = (col: number, row: N): N => textureLoad(data.joints, (ivec2 as N)(int(col), row))

    const rest: N = (vec3 as N)(positionLocal).toVar()
    if (withShape) {
      // 体型：先在静止空间按权重线性混合各关节的仿射变换
      // shape: blend the joints' affine transforms linearly in rest space first
      const acc: N = (vec3 as N)(0).toVar()
      const p1: N = (vec4 as N)(rest, 1)
      for (let k = 0; k < 4; k++) {
        const r = rows[k]!
        acc.addAssign((vec3 as N)(dot(texel(2, r), p1), dot(texel(3, r), p1), dot(texel(4, r), p1)).mul(weights[k]!))
      }
      rest.assign(acc)
    }

    // 对偶四元数混合；每个四元数取与第一个影响同半球的符号
    // dual-quaternion blend; every quaternion takes the sign of the first influence's hemisphere
    const q0 = texel(0, rows[0]!)
    const real: N = (vec4 as N)(0).toVar()
    const dual: N = (vec4 as N)(0).toVar()
    for (let k = 0; k < 4; k++) {
      const q = texel(0, rows[k]!)
      const s = weights[k]!.mul(select((dot(q, q0) as N).lessThan(0), float(-1), float(1)))
      real.addAssign(q.mul(s))
      dual.addAssign(texel(1, rows[k]!).mul(s))
    }
    const inv: N = float(1).div(length(real))
    const q: N = real.mul(inv).toVar()
    const d: N = dual.mul(inv).toVar()
    const rotate = (v: N): N => v.add((cross(q.xyz, (cross(q.xyz, v) as N).add(v.mul(q.w))) as N).mul(2))
    const translation = q.w.mul(d.xyz).sub(d.w.mul(q.xyz)).add(cross(q.xyz, d.xyz)).mul(2)
    const pos: N = (vec3 as N)(rotate(rest).add(translation)).toVar()
    const normal: N = (vec3 as N)(rotate(normalLocal)).toVar()

    if (hasThin) {
      const thin: N = attribute('aThin', 'float')
      // 肌肉体积修正：垂直于作用线的偏移乘以 s(τ) = 1 + k·4τ(1−τ)
      // muscle volume correction: the offset perpendicular to the line is scaled by s(τ) = 1 + k·4τ(1−τ)
      If(thin.lessThan(-0.5), () => {
        const line = int(thin.negate().sub(0.5))
        const m0: N = textureLoad(data.muscles, (ivec2 as N)(int(0), line))
        const m1: N = textureLoad(data.muscles, (ivec2 as N)(int(1), line))
        const rel = pos.sub(m0.xyz)
        const t: N = dot(rel, m1.xyz)
        const tau: N = t.mul(m0.w).clamp(0, 1)
        const s: N = float(1).add(m1.w.mul(4).mul(tau).mul(float(1).sub(tau)))
        const foot = m1.xyz.mul(t)
        pos.assign(m0.xyz.add(foot).add(rel.sub(foot).mul(s)))
      })
      ;(normalLocal as N).assign(normal)
      return pos.add(normal.mul(boostGrow(data, pos, thin)))
    }
    ;(normalLocal as N).assign(normal)
    return pos
  })()
}
