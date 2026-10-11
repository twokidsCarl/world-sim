// 骨架绑定（rig）的运行时数据：加载与校验、姿势工具、以及送入着色器的纹理打包。纯数据，不依赖 three.js。
// Runtime side of the rig: loading and validation, pose utilities, and packing of the textures
// the shaders read. Pure data, no three.js.
//
// 关节变换本身不在这里重新实现：直接使用 tools/rig/pose.ts 的 CPU 参考实现（jointFrames 等），
// 这样 GPU 蒙皮与参考实现只可能在"混合与应用"这一步上有差别。
// Joint transforms are not re-implemented here: the CPU reference in tools/rig/pose.ts
// (jointFrames and friends) is used as is, so GPU skinning can differ from the reference only
// in the blend-and-apply step.

import { dqFromXf, type V3, type Xf } from '../../tools/rig/math.ts'
import { clampPose, jointFrames, muscleLength, type JointFrames, type Pose, type Scales } from '../../tools/rig/pose.ts'
import { standardPostures } from '../../tools/rig/postures.ts'
import { fetchJson } from './load.ts'
import type { Joint, MuscleLine, Rig, RigBinding } from './types.ts'

export type { Pose, Scales }
export { jointFrames }

/** rig.bin 中每个顶点的字节数 / Bytes per vertex in rig.bin. */
export const RIG_BYTES_PER_VERTEX = 12
/** 关节纹理每行的纹素数（RGBA32F）/ Texels per joint row (RGBA32F). */
export const JOINT_TEXELS = 8
/** 肌肉纹理每行的纹素数 / Texels per muscle row. */
export const MUSCLE_TEXELS = 2
/** 与参考实现一致的横截面缩放上下限 / Cross-section scale bounds, as in the reference. */
const VOLUME_MIN = 0.75
const VOLUME_MAX = 1.4

export interface RigReport {
  inputs?: Record<string, string>
  joints?: { id: string; fits?: { what: string; rmsMm?: number; samples?: number }[] }[]
}

export interface LoadedRig {
  rig: Rig
  bin: Uint8Array
  report: RigReport | null
  jointIndex: Map<string, number>
  bindingOf: Map<string, RigBinding>
  /** 部件 id → 肌肉作用线在 rig.muscles 中的下标 / Part id → index of its line in rig.muscles. */
  muscleOf: Map<string, number>
}

export function indexRig(rig: Rig, bin: Uint8Array, report: RigReport | null = null): LoadedRig {
  return {
    rig,
    bin,
    report,
    jointIndex: new Map(rig.joints.map((j, i) => [j.id, i])),
    bindingOf: new Map(rig.bindings.map((b) => [b.part, b])),
    muscleOf: new Map(rig.muscles.map((m, i) => [m.part, i])),
  }
}

/**
 * 检查绑定是否与已加载的部件相符；返回问题列表（空 = 可用）。`vertexCount` 给出部件解码后的顶点数，
 * 没有几何的部件返回 undefined。
 * Check the rig against the loaded parts; returns problems (empty = usable). `vertexCount` gives
 * a part's decoded vertex count, undefined for parts without geometry.
 */
export function validateRig(r: LoadedRig, vertexCount: (partId: string) => number | undefined): string[] {
  const problems: string[] = []
  const nJ = r.rig.joints.length
  if (nJ === 0) problems.push('绑定中没有关节 / the rig has no joints')
  for (const j of r.rig.joints) {
    if (j.parent !== null && !r.jointIndex.has(j.parent)) problems.push(`关节 ${j.id} 的父关节 ${j.parent} 不存在 / unknown parent joint`)
  }
  let bad = 0
  for (const b of r.rig.bindings) {
    const n = vertexCount(b.part)
    if (n === undefined) continue
    if (b.joint !== undefined) {
      if (!r.jointIndex.has(b.joint)) bad++
      continue
    }
    if (b.offset === undefined || b.vertexCount !== n || b.offset + n * RIG_BYTES_PER_VERTEX > r.bin.length) {
      if (bad < 3) problems.push(`部件 ${b.part}：绑定有 ${b.vertexCount ?? '?'} 个顶点，网格有 ${n} 个 / binding has ${b.vertexCount ?? '?'} vertices, the mesh has ${n}`)
      bad++
    }
  }
  if (bad > 0) problems.push(`${bad} 个部件的绑定与网格不符（绑定是为另一版几何生成的）/ ${bad} bindings do not match the meshes (the rig was built for other geometry)`)
  for (const m of r.rig.muscles) {
    if (!r.jointIndex.has(m.origin.joint) || !r.jointIndex.has(m.insertion.joint)) {
      problems.push(`肌肉作用线 ${m.part} 指向未知关节 / muscle line refers to an unknown joint`)
      break
    }
  }
  return problems
}

async function sha256Prefix(bytes: ArrayBuffer): Promise<string | null> {
  try {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null // 非安全上下文没有 crypto.subtle / no crypto.subtle outside a secure context
  }
}

export type RigLoadResult = { ok: true; rig: LoadedRig } | { ok: false; reason: 'missing' | 'stale' | 'error'; message: string }

/**
 * 读取某个人体的绑定。rig-report.json 记录了生成时各输入文件的哈希；anatomy.json 的哈希对不上时，
 * 认为绑定已过期（"此人体暂不能摆姿势"）。
 * Fetch a body's rig. rig-report.json records a hash of every input it was built from; when
 * the hash of anatomy.json no longer matches, the rig is stale ("posing unavailable for this body").
 */
export async function loadRig(baseUrl: string, onProgress?: (fraction: number) => void): Promise<RigLoadResult> {
  const rig = await fetchJson<Rig>(`${baseUrl}rig.json`)
  if (!rig || !Array.isArray(rig.joints) || !Array.isArray(rig.bindings)) return { ok: false, reason: 'missing', message: '此人体没有绑定数据 / this body has no rig' }
  const report = await fetchJson<RigReport>(`${baseUrl}rig-report.json`)
  const want = report?.inputs?.['anatomy.json']
  if (want) {
    const res = await fetch(`${baseUrl}anatomy.json`)
    const have = res.ok ? await sha256Prefix(await res.arrayBuffer()) : null
    if (have && have !== want) {
      return { ok: false, reason: 'stale', message: '绑定是为旧版人体数据生成的，需要重新生成 / the rig was built from an older anatomy.json and must be rebuilt' }
    }
  }
  const res = await fetch(`${baseUrl}rig.bin`)
  if (!res.ok) return { ok: false, reason: 'missing', message: '缺少 rig.bin / rig.bin is missing' }
  const total = Number(res.headers.get('content-length')) || 0
  let bin: Uint8Array
  if (res.body && total > 0 && onProgress) {
    bin = new Uint8Array(total)
    const reader = res.body.getReader()
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (got + value.length > bin.length) {
        const grown = new Uint8Array(got + value.length)
        grown.set(bin.subarray(0, got))
        bin = grown
      }
      bin.set(value, got)
      got += value.length
      onProgress(Math.min(1, got / total))
    }
    if (got !== bin.length) bin = bin.slice(0, got)
  } else bin = new Uint8Array(await res.arrayBuffer())
  onProgress?.(1)
  return { ok: true, rig: indexRig(rig, bin, report) }
}

// ---------------------------------------------------------------- 姿势工具 / pose utilities

/** 姿势是否就是静止姿势（所有角度为 0）/ Whether a pose is the rest pose (every angle zero). */
export function poseIsRest(pose: Pose): boolean {
  for (const a of Object.values(pose)) for (const v of a) if (Math.abs(v) > 1e-9) return false
  return true
}

export function scalesAreIdentity(scales: Scales | null | undefined): boolean {
  if (!scales) return true
  for (const s of Object.values(scales)) if ((s.along ?? 1) !== 1 || (s.across ?? 1) !== 1) return false
  return true
}

/** 在关节角空间内插值两个姿势 / Interpolate two poses in joint-angle space. */
export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const out: Pose = {}
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id] ?? []
    const y = b[id] ?? []
    out[id] = Array.from({ length: Math.max(x.length, y.length) }, (_, k) => (x[k] ?? 0) + ((y[k] ?? 0) - (x[k] ?? 0)) * t)
  }
  return out
}

/** 解剖学姿势：每个自由度取其 `neutral` 角 / Anatomical position: every dof at its `neutral` angle. */
export function anatomicalPose(joints: readonly Joint[]): Pose {
  const out: Pose = {}
  for (const j of joints) {
    if (j.dofs.some((d) => (d.neutral ?? 0) !== 0)) out[j.id] = j.dofs.map((d) => Math.min(d.max, Math.max(d.min, d.neutral ?? 0)))
  }
  return out
}

/** 对侧关节的 id（"_L" ↔ "_R"），没有则为 null / The opposite-side joint id, or null. */
export function mirrorJointId(id: string): string | null {
  if (id.endsWith('_L')) return `${id.slice(0, -2)}_R`
  if (id.endsWith('_R')) return `${id.slice(0, -2)}_L`
  return null
}

/**
 * 把某个自由度设为给定角度（限制在活动范围内）；mirror 为真时对侧同名关节取相同的角度
 * （关节轴的符号已经使同名运动在两侧同号）。
 * Set one dof (clamped to its range); with `mirror` the same-named joint on the other side gets
 * the same angle (axis signs already make the named movement positive on both sides).
 */
export function withDof(joints: readonly Joint[], pose: Pose, jointId: string, dof: number, angle: number, mirror = false): Pose {
  const out: Pose = { ...pose }
  const ids = [jointId]
  const other = mirror ? mirrorJointId(jointId) : null
  if (other) ids.push(other)
  for (const id of ids) {
    const j = joints.find((x) => x.id === id)
    const d = j?.dofs[dof]
    if (!j || !d) continue
    const a = j.dofs.map((_, k) => out[id]?.[k] ?? 0)
    a[dof] = Math.min(d.max, Math.max(d.min, angle))
    out[id] = a
  }
  return out
}

export interface PosePreset {
  id: string
  name: { zh: string; en: string }
  pose: Pose
}

/**
 * 预设姿势：静止、解剖学姿势，以及绑定验证用的那组标准姿势（tools/rig/postures.ts）。
 * Presets: rest, the anatomical position, and the standard postures the rig was validated with
 * (tools/rig/postures.ts).
 */
export function posePresets(joints: Joint[]): PosePreset[] {
  const out: PosePreset[] = [
    { id: 'rest', name: { zh: '静止（模型原始姿势）', en: 'Rest (as modelled)' }, pose: {} },
    { id: 'anatomical', name: { zh: '解剖学姿势', en: 'Anatomical position' }, pose: anatomicalPose(joints) },
  ]
  for (const p of standardPostures(joints)) {
    if (p.id === 'rest') continue
    out.push({ id: p.id, name: p.name, pose: clampPose(joints, p.pose) })
  }
  return out
}

export type JointGroupId = 'spine' | 'ribs' | 'jaw' | 'shoulder' | 'arm' | 'hand' | 'leg' | 'foot'

export const JOINT_GROUPS: { id: JointGroupId; zh: string; en: string }[] = [
  { id: 'spine', zh: '脊柱与骨盆', en: 'Spine and pelvis' },
  { id: 'jaw', zh: '下颌', en: 'Jaw' },
  { id: 'ribs', zh: '肋骨 / 呼吸', en: 'Ribs / breathing' },
  { id: 'shoulder', zh: '肩带', en: 'Shoulder girdle' },
  { id: 'arm', zh: '上肢', en: 'Arm' },
  { id: 'hand', zh: '手', en: 'Hand' },
  { id: 'leg', zh: '髋与下肢', en: 'Hip and leg' },
  { id: 'foot', zh: '足', en: 'Foot' },
]

/** 按关节 id 的命名归入界面分组 / Sort a joint into a UI group by its id. */
export function jointGroup(id: string): JointGroupId {
  const base = id.replace(/_[LR]$/, '')
  if (/^rib\d+$/.test(base)) return 'ribs'
  if (base === 'tmj') return 'jaw'
  if (/^(sc|ac)$/.test(base)) return 'shoulder'
  if (/^(gh|elbow|radioulnar|wrist)$/.test(base)) return 'arm'
  if (/^(cmc|mcp|pip|dip|ip)\d*$/.test(base)) return 'hand'
  if (/^(hip|knee|patella)$/.test(base)) return 'leg'
  if (/^(ankle|subtalar|mtp|tip|tpip|tdip)\d*$/.test(base)) return 'foot'
  return 'spine'
}

/** 肋骨关节（呼吸演示用）/ The rib joints (for the breathing demonstration). */
export function ribJoints(joints: readonly Joint[]): Joint[] {
  return joints.filter((j) => /^rib\d+_[LR]$/.test(j.id) && j.dofs.length > 0)
}

/** 呼吸相位 0…1（0 = 呼气末，1 = 深吸气）下的肋骨姿势 / Rib pose at breathing phase 0…1. */
export function breathingPose(joints: readonly Joint[], phase: number): Pose {
  const out: Pose = {}
  for (const j of ribJoints(joints)) out[j.id] = [Math.max(0, j.dofs[0]!.max) * phase]
  return out
}

/** 自由度 k 在当前姿势下的世界方向（见 Joint.dofs 的复合顺序）与关节中心。 */
/** World direction of dof k in the current pose (composition order as on Joint.dofs) and the joint centre. */
export function dofAxisWorld(rig: LoadedRig, frames: JointFrames, pose: Pose, jointId: string, dof: number): { axis: V3; center: V3 } | null {
  const i = rig.jointIndex.get(jointId)
  const j = i === undefined ? undefined : rig.rig.joints[i]
  if (i === undefined || !j || !j.dofs[dof]) return null
  // 轴随"之前的自由度"和父关节转动：用只含前 k 个自由度的姿势求该关节的刚体变换
  // the axis turns with the earlier dofs and the parent: take the joint's transform with only the first k dofs applied
  const partial: Pose = { ...pose, [jointId]: j.dofs.map((_, k) => (k < dof ? (pose[jointId]?.[k] ?? 0) : 0)) }
  const m = jointFrames(rig.rig.joints, partial).rigid[i]!
  const a = j.axes[j.dofs[dof]!.axis] as V3
  const r = m.r
  const axis: V3 = [r[0] * a[0] + r[1] * a[1] + r[2] * a[2], r[3] * a[0] + r[4] * a[1] + r[5] * a[2], r[6] * a[0] + r[7] * a[1] + r[8] * a[2]]
  const c = j.center as V3
  const full = frames.xfs[i]!
  const center: V3 = [
    full.r[0] * c[0] + full.r[1] * c[1] + full.r[2] * c[2] + full.t[0],
    full.r[3] * c[0] + full.r[4] * c[1] + full.r[5] * c[2] + full.t[1],
    full.r[6] * c[0] + full.r[7] * c[1] + full.r[8] * c[2] + full.t[2],
  ]
  return { axis, center }
}

// ---------------------------------------------------------------- 着色器数据 / shader data

/**
 * 关节纹理：每个关节一行，外加末尾一行单位变换（未绑定的顶点指向它）。每行 8 个 RGBA 纹素：
 *   0: 姿势部分的对偶四元数实部 (x, y, z, w)   1: 对偶部 (x, y, z, w)
 *   2–4: 体型部分仿射矩阵的三行 (r0 r1 r2 t)     5–7: 未用
 * Joint texture: one row per joint plus a final identity row (unbound vertices point at it).
 * Eight RGBA texels per row:
 *   0: real part of the pose dual quaternion (x, y, z, w)   1: dual part (x, y, z, w)
 *   2–4: the three rows of the shape affine (r0 r1 r2 t)    5–7: unused
 */
export function packJoints(frames: JointFrames, out?: Float32Array): Float32Array {
  const n = frames.rigid.length
  const stride = JOINT_TEXELS * 4
  const data = out && out.length === (n + 1) * stride ? out : new Float32Array((n + 1) * stride)
  for (let i = 0; i <= n; i++) {
    const o = i * stride
    const dq = i < n ? dqFromXf(frames.rigid[i]!) : [1, 0, 0, 0, 0, 0, 0, 0]
    // 参考实现的四元数是 (w, x, y, z)，纹理里存成 (x, y, z, w)
    // the reference keeps quaternions as (w, x, y, z); the texture stores (x, y, z, w)
    data[o] = dq[1]!
    data[o + 1] = dq[2]!
    data[o + 2] = dq[3]!
    data[o + 3] = dq[0]!
    data[o + 4] = dq[5]!
    data[o + 5] = dq[6]!
    data[o + 6] = dq[7]!
    data[o + 7] = dq[4]!
    const a: Xf | undefined = i < n ? frames.shape?.[i] : undefined
    const r = a?.r ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]
    const t = a?.t ?? [0, 0, 0]
    for (let row = 0; row < 3; row++) {
      data[o + 8 + row * 4] = r[row * 3]!
      data[o + 9 + row * 4] = r[row * 3 + 1]!
      data[o + 10 + row * 4] = r[row * 3 + 2]!
      data[o + 11 + row * 4] = t[row]!
    }
  }
  return data
}

/**
 * 肌肉体积修正的系数（"tapered" 模式，与参考实现的公式相同）：s(τ) = 1 + k·4τ(1−τ)。
 * The coefficient of the muscle volume correction ("tapered" mode, same formula as the
 * reference): s(τ) = 1 + k·4τ(1−τ).
 */
export function taperCoefficient(rest: number, length: number, gain: number): number {
  if (!(rest > 1e-6) || !(length > 1e-6)) return 0
  const ratio = Math.min(VOLUME_MAX * VOLUME_MAX, Math.max(VOLUME_MIN * VOLUME_MIN, (rest / length) ** gain))
  if (Math.abs(ratio - 1) < 1e-6) return 0
  return (-4 / 3 + Math.sqrt(Math.max(0, 16 / 9 - (32 / 15) * (1 - ratio)))) / (16 / 15)
}

/**
 * 肌肉纹理：每条作用线一行，2 个纹素：(起点 xyz, 1/当前长度)、(单位方向 xyz, k)。k = 0 表示不修正。
 * Muscle texture: one row per line, two texels: (posed origin xyz, 1 / current length),
 * (unit direction xyz, k). k = 0 means no correction.
 */
export function packMuscles(r: LoadedRig, frames: JointFrames, out?: Float32Array): Float32Array {
  const lines: MuscleLine[] = r.rig.muscles
  const rows = Math.max(1, lines.length)
  const data = out && out.length === rows * MUSCLE_TEXELS * 4 ? out : new Float32Array(rows * MUSCLE_TEXELS * 4)
  data.fill(0)
  lines.forEach((line, i) => {
    const m = muscleLength(line, frames.xfs, r.jointIndex)
    const o = i * 8
    const len = m.length > 1e-6 ? m.length : 1
    data[o] = m.origin[0]
    data[o + 1] = m.origin[1]
    data[o + 2] = m.origin[2]
    data[o + 3] = 1 / len
    data[o + 4] = (m.insertion[0] - m.origin[0]) / len
    data[o + 5] = (m.insertion[1] - m.origin[1]) / len
    data[o + 6] = (m.insertion[2] - m.origin[2]) / len
    data[o + 7] = taperCoefficient(m.rest, m.length, line.gain ?? 1)
  })
  return data
}

/**
 * 着色器里那段运算的 CPU 镜像：从打包好的纹理数据计算一个顶点。只用于测试打包约定和公式，
 * 运行时不调用（真正的对照是无头浏览器里从 GPU 读回的结果）。
 * A CPU mirror of what the shader computes, from the packed texture data, for one vertex. Used
 * only to test the packing convention and the formulas (the real check is a GPU read-back in a
 * headless browser).
 */
export function skinLikeShader(
  p: ArrayLike<number>,
  joints: ArrayLike<number>,
  weights: ArrayLike<number>,
  jointData: Float32Array,
  withShape: boolean,
  muscle?: { data: Float32Array; line: number },
): [number, number, number] {
  const f = Math.fround
  const stride = JOINT_TEXELS * 4
  let x = p[0]!, y = p[1]!, z = p[2]!
  if (withShape) {
    let sx = 0, sy = 0, sz = 0
    for (let k = 0; k < 4; k++) {
      const o = joints[k]! * stride + 8
      const w = weights[k]!
      sx += w * (jointData[o]! * x + jointData[o + 1]! * y + jointData[o + 2]! * z + jointData[o + 3]!)
      sy += w * (jointData[o + 4]! * x + jointData[o + 5]! * y + jointData[o + 6]! * z + jointData[o + 7]!)
      sz += w * (jointData[o + 8]! * x + jointData[o + 9]! * y + jointData[o + 10]! * z + jointData[o + 11]!)
    }
    ;(x = sx), (y = sy), (z = sz)
  }
  const b = [0, 0, 0, 0, 0, 0, 0, 0]
  const o0 = joints[0]! * stride
  for (let k = 0; k < 4; k++) {
    const o = joints[k]! * stride
    let dot = 0
    for (let c = 0; c < 4; c++) dot += jointData[o + c]! * jointData[o0 + c]!
    const s = dot < 0 ? -weights[k]! : weights[k]!
    for (let c = 0; c < 8; c++) b[c] = b[c]! + s * jointData[o + c]!
  }
  const n = Math.hypot(b[0]!, b[1]!, b[2]!, b[3]!)
  const qx = b[0]! / n, qy = b[1]! / n, qz = b[2]! / n, qw = b[3]! / n
  const dx = b[4]! / n, dy = b[5]! / n, dz = b[6]! / n, dw = b[7]! / n
  // 用四元数旋转向量 / rotate a vector by the quaternion: v' = v + 2·q.xyz × (q.xyz × v + q.w·v)
  const cx = qy * z - qz * y + qw * x, cy = qz * x - qx * z + qw * y, cz = qx * y - qy * x + qw * z
  let ox = x + 2 * (qy * cz - qz * cy), oy = y + 2 * (qz * cx - qx * cz), oz = z + 2 * (qx * cy - qy * cx)
  // 平移部分 / the translation: t = 2·(q.w·d.xyz − d.w·q.xyz + q.xyz × d.xyz)
  ox += 2 * (qw * dx - dw * qx + (qy * dz - qz * dy))
  oy += 2 * (qw * dy - dw * qy + (qz * dx - qx * dz))
  oz += 2 * (qw * dz - dw * qz + (qx * dy - qy * dx))
  if (muscle) {
    const m = muscle.data, o = muscle.line * 8
    const k = m[o + 7]!
    const px = ox - m[o]!, py = oy - m[o + 1]!, pz = oz - m[o + 2]!
    const t = px * m[o + 4]! + py * m[o + 5]! + pz * m[o + 6]!
    const tau = Math.min(1, Math.max(0, t * m[o + 3]!))
    const s = 1 + k * 4 * tau * (1 - tau)
    const fx = m[o + 4]! * t, fy = m[o + 5]! * t, fz = m[o + 6]! * t
    ox = m[o]! + fx + s * (px - fx)
    oy = m[o + 1]! + fy + s * (py - fy)
    oz = m[o + 2]! + fz + s * (pz - fz)
  }
  return [f(ox), f(oy), f(oz)]
}

/**
 * 一个部件各顶点的影响：rig.bin 中的一段（蒙皮部件），或全部指向同一关节（刚体部件），
 * 没有绑定时指向单位行。写成着色器属性的形式：4 × uint16 下标、4 × uint8 权重。
 * A part's per-vertex influences: its block of rig.bin (skinned), one joint for every vertex
 * (rigid), or the identity row when unbound; written as the shader attributes, 4 × uint16
 * indices and 4 × uint8 weights.
 */
export function writeInfluences(r: LoadedRig, partId: string, vertexCount: number, index: Uint16Array, weight: Uint8Array, at: number): void {
  const b = r.bindingOf.get(partId)
  const identity = r.rig.joints.length
  if (b && b.joint === undefined && b.offset !== undefined && b.vertexCount === vertexCount) {
    const dv = new DataView(r.bin.buffer, r.bin.byteOffset, r.bin.byteLength)
    for (let i = 0; i < vertexCount; i++) {
      const o = b.offset + i * RIG_BYTES_PER_VERTEX
      const d = (at + i) * 4
      for (let k = 0; k < 4; k++) {
        const w = r.bin[o + 8 + k]!
        // 权重为 0 的影响改指向第一个影响的关节，这样着色器里不必判断
        // zero-weight influences are pointed at the first influence's joint, so the shader needs no test
        index[d + k] = w === 0 ? dv.getUint16(o, true) : dv.getUint16(o + k * 2, true)
        weight[d + k] = w
      }
    }
    return
  }
  const j = b?.joint !== undefined ? (r.jointIndex.get(b.joint) ?? identity) : identity
  for (let i = 0; i < vertexCount; i++) {
    const d = (at + i) * 4
    index[d] = index[d + 1] = index[d + 2] = index[d + 3] = j
    weight[d] = 255
    weight[d + 1] = weight[d + 2] = weight[d + 3] = 0
  }
}

/** 影响某个部件的关节下标（去重）/ The distinct joints influencing a part. */
export function partJoints(r: LoadedRig, partId: string, vertexCount: number): number[] {
  const b = r.bindingOf.get(partId)
  if (!b) return []
  if (b.joint !== undefined) {
    const j = r.jointIndex.get(b.joint)
    return j === undefined ? [] : [j]
  }
  if (b.offset === undefined || b.vertexCount !== vertexCount) return []
  const seen = new Set<number>()
  const dv = new DataView(r.bin.buffer, r.bin.byteOffset, r.bin.byteLength)
  for (let i = 0; i < vertexCount; i++) {
    const o = b.offset + i * RIG_BYTES_PER_VERTEX
    for (let k = 0; k < 4; k++) if (r.bin[o + 8 + k]! > 0) seen.add(dv.getUint16(o + k * 2, true))
  }
  return [...seen]
}

/**
 * 近似的摆姿势后包围盒：静止包围盒的八个角分别经每个影响关节变换后的并集，再外扩一点。
 * 对线性混合是严格包含的；对偶四元数混合的顶点可能略微越出，所以只在精确包围盒算出之前使用。
 * An approximate posed bounding box: the union of the rest box's eight corners under every
 * influencing joint's transform, padded a little. It strictly contains any linear blend; a
 * dual-quaternion blend can stray slightly outside, so it is used only until exact bounds exist.
 */
export function posedBox(bbox: ArrayLike<number>, joints: readonly number[], xfs: readonly Xf[], pad = 0.02): [number, number, number, number, number, number] {
  if (joints.length === 0) return [bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!, bbox[4]!, bbox[5]!]
  const out: [number, number, number, number, number, number] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const j of joints) {
    const m = xfs[j]
    if (!m) continue
    for (let c = 0; c < 8; c++) {
      const x = bbox[c & 1 ? 3 : 0]!, y = bbox[c & 2 ? 4 : 1]!, z = bbox[c & 4 ? 5 : 2]!
      const px = m.r[0] * x + m.r[1] * y + m.r[2] * z + m.t[0]
      const py = m.r[3] * x + m.r[4] * y + m.r[5] * z + m.t[1]
      const pz = m.r[6] * x + m.r[7] * y + m.r[8] * z + m.t[2]
      if (px < out[0]) out[0] = px
      if (py < out[1]) out[1] = py
      if (pz < out[2]) out[2] = pz
      if (px > out[3]) out[3] = px
      if (py > out[4]) out[4] = py
      if (pz > out[5]) out[5] = pz
    }
  }
  return [out[0] - pad, out[1] - pad, out[2] - pad, out[3] + pad, out[4] + pad, out[5] + pad]
}
