// 摆姿势的 CPU 参考实现：关节角 → 各关节的刚体变换 → 任意部件变形后的顶点位置。
// CPU reference implementation of posing: joint angles → rigid transform of every joint →
// deformed vertex positions of any part.
//
// 运行时（GPU 蒙皮）应与此处的结果一致；tools/rig 的验证和 tests/rig*.test.ts 都以它为准。
// 只依赖 math.ts 和数据契约，前端可以直接导入。
// The runtime (GPU skinning) should reproduce these results; the validation in tools/rig and
// tests/rig*.test.ts use this file as ground truth. It depends only on math.ts and the data
// contract, so the frontend can import it as is.
//
// 约定 / Conventions
//   · 关节的局部转动 = 按 dofs 数组的顺序依次绕 axes[dof.axis] 转动的乘积：
//       R = R(axes[d0.axis], θ0) · R(axes[d1.axis], θ1) · R(axes[d2.axis], θ2)
//     其中各轴都取静止姿势下的方向。也就是说第一个自由度的轴固定在近端骨上，最后一个自由度的轴
//     随远端骨转动（与 ISB / Grood–Suntay 的关节坐标系顺序相同）。
//     A joint's local rotation is the product of the rotations about axes[dof.axis] in the order of
//     the dofs array, every axis taken in its rest-pose direction. The first dof's axis is thus
//     fixed to the proximal bone and the last one turns with the distal bone (the order of the
//     ISB / Grood–Suntay joint coordinate systems).
//   · 蒙皮矩阵（静止 → 当前）：M_j = M_parent ∘ (绕 center_j 转 R_j)。
//     Skinning transform (rest → posed): M_j = M_parent ∘ (R_j about center_j).
//   · 被带动的自由度（driver）：有效角 = 自身角 + ratio × 驱动自由度的有效角。
//     A driven dof: effective angle = own angle + ratio × effective angle of the driver dof.
//   · 体型：可选的逐关节节段缩放（沿节段长轴 / 横截面），见 jointFrames。
//     Body shape: an optional per-joint segment scale (along the segment axis / in cross-section), see jointFrames.
//   · rig.bin：每个顶点 12 字节，小端：4 × uint16 关节下标（指向 Rig.joints），随后 4 × uint8 权重（和为 255）。
//     rig.bin: 12 bytes per vertex, little-endian: 4 × uint16 joint indices (into Rig.joints) then
//     4 × uint8 weights summing to 255.

import type { Joint, JointDof, MuscleLine, Rig, RigBinding } from '../../src/anatomy/types.ts'
import { type DualQuat, type M3, type V3, type Xf, M3_ID, XF_ID, axisAngle, dqFromXf, m3mul, norm, rotateAbout, sub, xfApply, xfFromDq, xfMul } from './math.ts'

/** 关节 id → 各自由度的角度（弧度，相对静止姿势）。缺省为 0。 Joint id → angle per dof (radians, relative to rest). Missing = 0. */
export type Pose = Record<string, number[]>

/** 契约之外、由本工具提出的扩展字段。 Extension fields proposed by this tool, not yet in the contract. */
export type DofWithDriver = JointDof & { driver?: { joint: string; dof: number; ratio: number } }

/** 提议的扩展：横截面缩放 = (restLength / length)^(gain / 2)。 Proposed extension: cross-section scale = (restLength / length)^(gain / 2). */
export type MuscleLineExt = MuscleLine & { gain?: number }

export const BYTES_PER_VERTEX = 12

/** 各自由度的有效角（含耦合）。 Effective angle of every dof, couplings included. */
export function effectiveAngles(joints: Joint[], pose: Pose): number[][] {
  const index = new Map(joints.map((j, i) => [j.id, i]))
  const out: (number[] | null)[] = joints.map(() => null)
  const visit = (i: number, depth: number): number[] => {
    const done = out[i]
    if (done) return done
    if (depth > joints.length) throw new Error('rig: cyclic dof drivers')
    const j = joints[i]!
    const own = pose[j.id] ?? []
    const res = (j.dofs as DofWithDriver[]).map((d, k) => {
      let a = own[k] ?? 0
      if (d.driver) {
        const di = index.get(d.driver.joint)
        if (di !== undefined) a += d.driver.ratio * (visit(di, depth + 1)[d.driver.dof] ?? 0)
      }
      return a
    })
    out[i] = res
    return res
  }
  return joints.map((_, i) => visit(i, 0))
}

/** 关节的局部转动矩阵。 Local rotation of a joint for the given dof angles. */
export function localRotation(joint: Joint, angles: number[]): M3 {
  let r: M3 = M3_ID
  joint.dofs.forEach((d, k) => {
    const a = angles[k] ?? 0
    if (a !== 0) r = m3mul(r, axisAngle(joint.axes[d.axis] as V3, a))
  })
  return r
}

/**
 * 节段缩放（体型）：along 沿该关节所带节段的长轴（关节中心 → tail），across 在横截面内。缺省为 1。
 * 缩放不向下传递形状：子关节只是被带到新的位置（父节段变长，子关节随之远移），自身不变形。
 * Segment scale (body shape): `along` the long axis of the segment the joint moves (joint centre →
 * tail), `across` in its cross-section. Default 1. A scale is not inherited as shape: child joints
 * are merely carried to their new place (a longer parent segment moves them away) and keep their
 * own form.
 */
export interface SegmentScale {
  along?: number
  across?: number
}
export type Scales = Record<string, SegmentScale>

/** 节段长轴（单位向量）：中心指向 tail；没有 tail 时取 axes[2]。 Unit long axis of a joint's segment: centre towards `tail`; axes[2] when there is no tail. */
export function segmentAxis(joint: Joint): V3 {
  const t = (joint as Joint & { tail?: V3 }).tail
  if (t) {
    const d = sub(t, joint.center as V3)
    const l = Math.hypot(d[0], d[1], d[2])
    if (l > 1e-6) return [d[0] / l, d[1] / l, d[2] / l]
  }
  return norm(joint.axes[2] as V3)
}

export interface JointFrames {
  /** 完整的蒙皮变换（静止 → 当前）= rigid ∘ shape；有缩放时不是刚体变换。 Full skinning transform (rest → posed) = rigid ∘ shape; not rigid when scaled. */
  xfs: Xf[]
  /** 姿势部分（刚体）：绕缩放后的关节中心转动。 The pose part (rigid): rotations about the scaled joint centres. */
  rigid: Xf[]
  /** 体型部分（仿射）：静止空间里各节段的缩放和平移；没有缩放时为 null。 The shape part (affine): scale and shift of each segment in rest space; null when nothing is scaled. */
  shape: Xf[] | null
}

/**
 * 每个关节的变换，分成“体型”（仿射）和“姿势”（刚体）两部分。
 *   体型：c′_j = c′_p + S_p·(c_j − c_p)，A_j(x) = c′_j + S_j·(x − c_j)，S_j = across·I + (along − across)·a·aᵀ
 *   姿势：P_j = P_p ∘ (绕 c′_j 转 R_j)
 *   蒙皮：M_j = P_j ∘ A_j。对偶四元数混合时，先按权重线性混合 A_j，再混合 P_j。
 * The transform of every joint, split into shape (affine) and pose (rigid):
 *   shape: c′_j = c′_p + S_p·(c_j − c_p), A_j(x) = c′_j + S_j·(x − c_j), S_j = across·I + (along − across)·a·aᵀ
 *   pose:  P_j = P_p ∘ (R_j about c′_j)
 *   skin:  M_j = P_j ∘ A_j. With dual quaternions the A_j are blended linearly first, then the P_j.
 */
export function jointFrames(joints: Joint[], pose: Pose, scales?: Scales): JointFrames {
  const index = new Map(joints.map((j, i) => [j.id, i]))
  const angles = effectiveAngles(joints, pose)
  const scaled = !!scales && Object.values(scales).some((s) => (s.along ?? 1) !== 1 || (s.across ?? 1) !== 1)
  const S: M3[] = joints.map((j) => {
    const sc = scales?.[j.id]
    const al = sc?.along ?? 1, ac = sc?.across ?? 1
    if (!scaled || (al === 1 && ac === 1)) return M3_ID
    const a = segmentAxis(j), k = al - ac
    return [ac + k * a[0] * a[0], k * a[0] * a[1], k * a[0] * a[2], k * a[1] * a[0], ac + k * a[1] * a[1], k * a[1] * a[2], k * a[2] * a[0], k * a[2] * a[1], ac + k * a[2] * a[2]]
  })
  const centre: (V3 | null)[] = joints.map(() => null)
  const rigid: (Xf | null)[] = joints.map(() => null)
  const visit = (i: number, depth: number): Xf => {
    const done = rigid[i]
    if (done) return done
    if (depth > joints.length) throw new Error('rig: the joints do not form a tree')
    const j = joints[i]!
    const pi = j.parent === null ? undefined : index.get(j.parent)
    const parent = pi === undefined ? null : visit(pi, depth + 1)
    let c = j.center as V3
    if (scaled && pi !== undefined) {
      const pc = joints[pi]!.center as V3, d = sub(c, pc), sp = S[pi]!
      const q = centre[pi]!
      c = [q[0] + sp[0] * d[0] + sp[1] * d[1] + sp[2] * d[2], q[1] + sp[3] * d[0] + sp[4] * d[1] + sp[5] * d[2], q[2] + sp[6] * d[0] + sp[7] * d[1] + sp[8] * d[2]]
    }
    centre[i] = c
    const local = rotateAbout(localRotation(j, angles[i]!), c)
    const xf = parent ? xfMul(parent, local) : local
    rigid[i] = xf
    return xf
  }
  const P = joints.map((_, i) => visit(i, 0))
  if (!scaled) return { xfs: P, rigid: P, shape: null }
  const A: Xf[] = joints.map((j, i) => {
    const c = j.center as V3, s = S[i]!, q = centre[i]!
    return { r: s, t: [q[0] - (s[0] * c[0] + s[1] * c[1] + s[2] * c[2]), q[1] - (s[3] * c[0] + s[4] * c[1] + s[5] * c[2]), q[2] - (s[6] * c[0] + s[7] * c[1] + s[8] * c[2])] }
  })
  return { xfs: P.map((p, i) => xfMul(p, A[i]!)), rigid: P, shape: A }
}

/** 每个关节的蒙皮变换（静止 → 当前），与 joints 下标对应。 Skinning transform (rest → posed) of every joint, index-aligned with `joints`. */
export function jointTransforms(joints: Joint[], pose: Pose, scales?: Scales): Xf[] {
  return jointFrames(joints, pose, scales).xfs
}

/** 把姿势限制在各自由度的活动范围之内。 Clamps a pose to the range of every dof. */
export function clampPose(joints: Joint[], pose: Pose): Pose {
  const out: Pose = {}
  for (const j of joints) {
    const a = pose[j.id]
    if (a) out[j.id] = j.dofs.map((d, k) => Math.min(d.max, Math.max(d.min, a[k] ?? 0)))
  }
  return out
}

export type BlendMode = 'lbs' | 'dqs'

/**
 * 按逐顶点权重蒙皮。`influences` 是 rig.bin 中该部件的那一段（或整个文件加 offset）。
 * Skins vertices by per-vertex influences. `bin` is rig.bin; `offset` the part's byte offset in it.
 *   lbs: 线性混合 / linear blend skinning
 *   dqs: 对偶四元数混合（扭转处不塌陷） / dual-quaternion blending (no collapse where the limb twists)
 */
export function skin(rest: Float32Array, bin: Uint8Array, offset: number, xfs: Xf[], mode: BlendMode = 'dqs', dqs?: DualQuat[], shape?: Xf[] | null): Float32Array {
  const n = rest.length / 3
  const out = new Float32Array(rest.length)
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const dq = mode === 'dqs' ? (dqs ?? xfs.map(dqFromXf)) : null
  const b = [0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < n; i++) {
    const o = offset + i * BYTES_PER_VERTEX
    let x = rest[i * 3]!, y = rest[i * 3 + 1]!, z = rest[i * 3 + 2]!
    if (dq && shape) {
      // 有体型缩放：先在静止空间按权重线性混合各关节的仿射变换，再做对偶四元数混合
      // with shape scales: blend the joints' affine shape transforms linearly in rest space first, then the dual quaternions
      let sx = 0, sy = 0, sz = 0
      for (let k = 0; k < 4; k++) {
        const w = bin[o + 8 + k]!
        if (w === 0) continue
        const m = shape[dv.getUint16(o + k * 2, true)]!
        const r = m.r, s = w / 255
        sx += s * (r[0] * x + r[1] * y + r[2] * z + m.t[0])
        sy += s * (r[3] * x + r[4] * y + r[5] * z + m.t[1])
        sz += s * (r[6] * x + r[7] * y + r[8] * z + m.t[2])
      }
      ;(x = sx), (y = sy), (z = sz)
    }
    if (dq) {
      b.fill(0)
      let first: DualQuat | null = null
      for (let k = 0; k < 4; k++) {
        const w = bin[o + 8 + k]!
        if (w === 0) continue
        const q = dq[dv.getUint16(o + k * 2, true)]!
        if (!first) first = q
        // 取与第一个影响同半球的四元数 / keep every quaternion in the hemisphere of the first influence
        const s = (q[0] * first[0] + q[1] * first[1] + q[2] * first[2] + q[3] * first[3] < 0 ? -w : w) / 255
        for (let c = 0; c < 8; c++) b[c] = b[c]! + s * q[c]!
      }
      // 归一化后直接作用于点 / normalise and apply to the point
      const m = xfFromDq(b)
      const r = m.r
      out[i * 3] = r[0] * x + r[1] * y + r[2] * z + m.t[0]
      out[i * 3 + 1] = r[3] * x + r[4] * y + r[5] * z + m.t[1]
      out[i * 3 + 2] = r[6] * x + r[7] * y + r[8] * z + m.t[2]
    } else {
      let ox = 0, oy = 0, oz = 0
      for (let k = 0; k < 4; k++) {
        const w = bin[o + 8 + k]!
        if (w === 0) continue
        const m = xfs[dv.getUint16(o + k * 2, true)]!
        const r = m.r, s = w / 255
        ox += s * (r[0] * x + r[1] * y + r[2] * z + m.t[0])
        oy += s * (r[3] * x + r[4] * y + r[5] * z + m.t[1])
        oz += s * (r[6] * x + r[7] * y + r[8] * z + m.t[2])
      }
      out[i * 3] = ox
      out[i * 3 + 1] = oy
      out[i * 3 + 2] = oz
    }
  }
  return out
}

/** 刚体部件：所有顶点跟随同一个关节。 Rigid part: every vertex follows one joint. */
export function transformRigid(rest: Float32Array, xf: Xf): Float32Array {
  const out = new Float32Array(rest.length)
  const r = xf.r, t = xf.t
  for (let i = 0; i < rest.length; i += 3) {
    const x = rest[i]!, y = rest[i + 1]!, z = rest[i + 2]!
    out[i] = r[0] * x + r[1] * y + r[2] * z + t[0]
    out[i + 1] = r[3] * x + r[4] * y + r[5] * z + t[1]
    out[i + 2] = r[6] * x + r[7] * y + r[8] * z + t[2]
  }
  return out
}

export type VolumeMode =
  /** 契约所述：沿整条作用线，横截面统一缩放 sqrt(restLength / length)。 As the contract states: the whole cross-section scaled by sqrt(restLength / length). */
  | 'uniform'
  /** 提议：缩放量在两端渐变为 1（附着点不动），中段加大以保持同样的体积。 Proposed: the scale fades to 1 at both ends (attachments stay put) and is larger mid-belly so that the same volume is kept. */
  | 'tapered'

export interface VolumeOptions {
  mode?: VolumeMode
  /** 横截面缩放的上下限，防止极端姿势下爆炸。 Bounds of the cross-section scale, against blow-up in extreme poses. */
  minScale?: number
  maxScale?: number
}

/** 肌肉作用线当前长度与静止长度。 Current and rest length of a muscle's line of action. */
export function muscleLength(line: MuscleLine, xfs: Xf[], jointIndex: Map<string, number>): { rest: number; length: number; origin: V3; insertion: V3 } {
  const o0 = line.origin.point as V3, i0 = line.insertion.point as V3
  const o = xfApply(xfs[jointIndex.get(line.origin.joint)!] ?? XF_ID, o0)
  const i = xfApply(xfs[jointIndex.get(line.insertion.joint)!] ?? XF_ID, i0)
  const d0 = sub(i0, o0), d = sub(i, o)
  return { rest: Math.hypot(d0[0], d0[1], d0[2]), length: Math.hypot(d[0], d[1], d[2]), origin: o, insertion: i }
}

/**
 * 肌肉体积保持：蒙皮之后，把顶点相对作用线（起点 → 止点）的垂直偏移按比例缩放。原地修改。
 * Muscle volume preservation: after skinning, scale every vertex's offset from the line of action
 * (origin → insertion). Modifies `posed` in place and returns the mid-belly scale applied.
 */
export function correctMuscleVolume(posed: Float32Array, line: MuscleLine, xfs: Xf[], jointIndex: Map<string, number>, opts: VolumeOptions = {}): number {
  const { rest, length, origin } = muscleLength(line, xfs, jointIndex)
  if (!(rest > 1e-6) || !(length > 1e-6)) return 1
  const lo = opts.minScale ?? 0.75, hi = opts.maxScale ?? 1.4
  // gain（提议的扩展字段）：该肌肉的网格体积实际随作用线长度变化的程度，构建时标定；缺省为 1
  // gain (proposed extension field): how far this muscle's mesh volume actually follows the length of its line, calibrated at build time; 1 when absent
  const gain = (line as MuscleLineExt).gain ?? 1
  const ratio = Math.min(hi * hi, Math.max(lo * lo, (rest / length) ** gain))
  if (Math.abs(ratio - 1) < 1e-6) return 1
  const ins = xfApply(xfs[jointIndex.get(line.insertion.joint)!] ?? XF_ID, line.insertion.point as V3)
  const d = norm(sub(ins, origin))
  const tapered = (opts.mode ?? 'uniform') === 'tapered'
  // tapered: s(τ) = 1 + k·4τ(1−τ)，取 k 使 ∫₀¹ s² dτ = rest / length
  // tapered: s(τ) = 1 + k·4τ(1−τ), with k such that ∫₀¹ s² dτ = rest / length
  const k = tapered ? (-4 / 3 + Math.sqrt(Math.max(0, 16 / 9 - (32 / 15) * (1 - ratio)))) / (16 / 15) : 0
  const s0 = Math.sqrt(ratio)
  for (let i = 0; i < posed.length; i += 3) {
    const px = posed[i]! - origin[0], py = posed[i + 1]! - origin[1], pz = posed[i + 2]! - origin[2]
    const t = px * d[0] + py * d[1] + pz * d[2]
    let s = s0
    if (tapered) {
      const tau = Math.min(1, Math.max(0, t / length))
      s = 1 + k * 4 * tau * (1 - tau)
    }
    const fx = d[0] * t, fy = d[1] * t, fz = d[2] * t
    posed[i] = origin[0] + fx + s * (px - fx)
    posed[i + 1] = origin[1] + fy + s * (py - fy)
    posed[i + 2] = origin[2] + fz + s * (pz - fz)
  }
  return tapered ? 1 + k : s0
}

/** 姿势求值器：一次算好所有关节变换，然后逐部件变形。 A posed rig: joint transforms computed once, then parts deformed on demand. */
export class Poser {
  /** 完整变换（含体型缩放）。 Full transforms (shape scales included). */
  readonly xfs: Xf[]
  /** 姿势部分的对偶四元数。 Dual quaternions of the pose part. */
  readonly dqs: DualQuat[]
  /** 体型部分（没有缩放时为 null）。 The shape part (null when nothing is scaled). */
  readonly shape: Xf[] | null
  readonly jointIndex: Map<string, number>
  private readonly bindingOf: Map<string, RigBinding>
  private readonly lineOf: Map<string, MuscleLine>

  constructor(readonly rig: Rig, readonly bin: Uint8Array, pose: Pose, scales?: Scales) {
    const f = jointFrames(rig.joints, pose, scales)
    this.xfs = f.xfs
    this.shape = f.shape
    this.dqs = f.rigid.map(dqFromXf)
    this.jointIndex = new Map(rig.joints.map((j, i) => [j.id, i]))
    this.bindingOf = new Map(rig.bindings.map((b) => [b.part, b]))
    this.lineOf = new Map(rig.muscles.map((m) => [m.part, m]))
  }

  /** 关节在当前姿势下的中心。 Centre of a joint in the current pose. */
  jointCenter(id: string): V3 {
    const i = this.jointIndex.get(id)!
    return xfApply(this.xfs[i]!, this.rig.joints[i]!.center as V3)
  }

  /**
   * 部件变形后的顶点位置。`rest` 是该部件从 GLB 解码出的顶点（米）。
   * Deformed positions of a part. `rest` are the part's vertices as decoded from its GLB (metres).
   */
  part(partId: string, rest: Float32Array, mode: BlendMode = 'dqs', volume: VolumeOptions | false = { mode: 'uniform' }): Float32Array {
    const b = this.bindingOf.get(partId)
    if (!b) return Float32Array.from(rest)
    let out: Float32Array
    if (b.joint !== undefined) out = transformRigid(rest, this.xfs[this.jointIndex.get(b.joint)!] ?? XF_ID)
    else out = skin(rest, this.bin, b.offset!, this.xfs, mode, this.dqs, this.shape)
    const line = this.lineOf.get(partId)
    if (line && volume) correctMuscleVolume(out, line, this.xfs, this.jointIndex, volume)
    return out
  }
}

/**
 * 肩肱节律的辅助函数：把“上臂相对躯干”的抬高角分配到盂肱关节和肩带（约 2 : 1，Ludewig 等 2009）。
 * 返回要并入姿势的关节角；side 为 'L' 或 'R'。plane：0 = 冠状面外展，1 = 矢状面前屈。
 * Scapulohumeral rhythm helper: splits an elevation of the arm against the trunk between the
 * glenohumeral joint and the shoulder girdle (about 2 : 1, Ludewig et al. 2009). Returns joint
 * angles to merge into a pose. plane: 0 = abduction in the frontal plane, 1 = flexion in the sagittal plane.
 */
export function shoulderElevation(side: 'L' | 'R', angle: number, plane: 0 | 1 = 0, girdleShare = 1 / 3): Pose {
  const girdle = angle * girdleShare
  const gh = angle - girdle
  // 肩带部分：肩胛骨上回旋为主，锁骨上提、后缩按 Ludewig 等测得的比例（39° 上回旋对应 6° 上提、16° 后缩）。
  // 他们测得的锁骨后旋（31°）不加在锁骨上，而是作为肩胛骨后倾（21°）加在肩锁关节：锁骨绕自身长轴
  // 转动在外观上看不出来，却会把贴着锁骨的皮肤和肌肉拧起来。
  // Girdle part: mostly upward rotation of the scapula; clavicular elevation and retraction in the
  // proportions measured by Ludewig et al. (6° and 16° per 39° of upward rotation). Their posterior
  // rotation of the clavicle (31°) is not put on the clavicle but, as posterior tilt of the scapula
  // (21°), on the acromioclavicular joint: a clavicle turning about its own long axis looks the
  // same, yet it would wring the skin and muscles lying on it.
  const k = girdle / 39
  return {
    [`gh_${side}`]: plane === 0 ? [0, gh, 0] : [gh, 0, 0],
    [`ac_${side}`]: [girdle - 6 * k, 0, 21 * k],
    [`sc_${side}`]: [-16 * k * (plane === 0 ? 1 : 0.3), 6 * k, 0],
  }
}

/** 把若干姿势合并（同一关节的角度相加）。 Merges poses (angles of the same joint add). */
export function mergePoses(...poses: Pose[]): Pose {
  const out: Pose = {}
  for (const p of poses) {
    for (const [id, a] of Object.entries(p)) {
      const cur = out[id] ?? []
      const n = Math.max(cur.length, a.length)
      out[id] = Array.from({ length: n }, (_, k) => (cur[k] ?? 0) + (a[k] ?? 0))
    }
  }
  return out
}
