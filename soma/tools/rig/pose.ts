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
//     各部件的块之后是可选的姿势校正形（Rig.correctives，见 src/anatomy/types.ts 的 RigCorrective）。
//     rig.bin: 12 bytes per vertex, little-endian: 4 × uint16 joint indices (into Rig.joints) then
//     4 × uint8 weights summing to 255. After the parts' blocks come the optional pose-corrective shapes
//     (Rig.correctives, see RigCorrective in src/anatomy/types.ts).

import type { Joint, JointDof, MuscleLine, Rig, RigBinding, RigCorrective } from '../../src/anatomy/types.ts'
import { type DualQuat, type M3, type V3, type Xf, M3_ID, XF_ID, axisAngle, dqFromXf, m3mul, norm, rotateAbout, sub, xfApply, xfFromDq, xfMul } from './math.ts'
import { VIA_SAMPLES, applyViaPush, hasVia, hasViaPush, musclePath, polylineLength, sectionInfluences, viaParams, viaPushAt, xfLookup } from './musclepath.ts'

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
  /** 各自由度的有效角（含耦合），与 joints 下标对应。 Effective angle of every dof (couplings included), index-aligned with `joints`. */
  angles: number[][]
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
  if (!scaled) return { xfs: P, rigid: P, shape: null, angles }
  const A: Xf[] = joints.map((j, i) => {
    const c = j.center as V3, s = S[i]!, q = centre[i]!
    return { r: s, t: [q[0] - (s[0] * c[0] + s[1] * c[1] + s[2] * c[2]), q[1] - (s[3] * c[0] + s[4] * c[1] + s[5] * c[2]), q[2] - (s[6] * c[0] + s[7] * c[1] + s[8] * c[2])] }
  })
  return { xfs: P.map((p, i) => xfMul(p, A[i]!)), rigid: P, shape: A, angles }
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

/**
 * 一个顶点的对偶四元数混合变换（与 skin(…, 'dqs') 同一算法，不含体型）。校正形的构建用它把摆好姿势的位置换回静止空间。
 * The dual-quaternion blended transform of one vertex (the same arithmetic as skin(…, 'dqs'), without body shape). The
 * build of the corrective shapes uses it to take posed positions back to rest space.
 */
export function vertexBlend(bin: Uint8Array, offset: number, i: number, dqs: DualQuat[]): Xf {
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const o = offset + i * BYTES_PER_VERTEX
  const b = [0, 0, 0, 0, 0, 0, 0, 0]
  let first: DualQuat | null = null
  for (let k = 0; k < 4; k++) {
    const w = bin[o + 8 + k]!
    if (w === 0) continue
    const q = dqs[dv.getUint16(o + k * 2, true)]!
    if (!first) first = q
    const s = (q[0] * first[0] + q[1] * first[1] + q[2] * first[2] + q[3] * first[3] < 0 ? -w : w) / 255
    for (let c = 0; c < 8; c++) b[c] = b[c]! + s * q[c]!
  }
  return xfFromDq(b)
}

// ── 姿势校正形 / pose-corrective shapes ─────────────────────────────────────────────────────────

/**
 * 校正形各关键形状的权重：驱动角 a ≤ 0 时全为 0；0 < a < keys[0] 时第一个为 a / keys[0]；关键角之间线性；超过最后一个时最后一个为 1。
 * The weights of a corrective's key shapes: all 0 for a driver angle a ≤ 0; the first is a / keys[0] for 0 < a < keys[0];
 * linear between key angles; the last is 1 beyond the last key.
 */
export function correctiveWeights(keys: readonly number[], a: number): number[] {
  const w = keys.map(() => 0)
  if (!(a > 0) || !keys.length) return w
  if (a < keys[0]!) {
    w[0] = a / keys[0]!
    return w
  }
  for (let j = 0; j + 1 < keys.length; j++) {
    if (a < keys[j + 1]!) {
      const t = (a - keys[j]!) / (keys[j + 1]! - keys[j]!)
      w[j] = 1 - t
      w[j + 1] = t
      return w
    }
  }
  w[keys.length - 1] = 1
  return w
}

/** 解开的校正形数据（按 rig.bin 缓存）/ Decoded corrective data (cached per rig.bin). */
const correctiveCache = new WeakMap<Uint8Array, Map<RigCorrective, { index: Uint32Array; shapes: Float32Array[] }>>()

/** 读出一个校正形的顶点下标和各关键形状 / Reads a corrective's vertex indices and key shapes. */
export function correctiveData(c: RigCorrective, bin: Uint8Array): { index: Uint32Array; shapes: Float32Array[] } {
  let m = correctiveCache.get(bin)
  if (!m) correctiveCache.set(bin, (m = new Map()))
  const hit = m.get(c)
  if (hit) return hit
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const index = new Uint32Array(c.count)
  for (let k = 0; k < c.count; k++) index[k] = dv.getUint32(c.offset + k * 4, true)
  const shapes = c.keys.map((_, j) => {
    const a = new Float32Array(c.count * 3)
    const o = c.offset + c.count * 4 + j * c.count * 12
    for (let k = 0; k < c.count * 3; k++) a[k] = dv.getFloat32(o + k * 4, true)
    return a
  })
  const out = { index, shapes }
  m.set(c, out)
  return out
}

/**
 * 一个部件在给定有效角（jointFrames 的 angles）下的校正位移（静止空间，扁平 xyz，长度 = 顶点数 × 3）；没有起作用的校正形时为 null。
 * 静止姿势下所有驱动角为 0，于是返回 null：静止几何不被触动。
 * The corrective displacement of a part for the given effective angles (`angles` of jointFrames), rest space, flat xyz of
 * length vertex count × 3; null when no corrective is active. At rest every driver angle is 0, so null comes back and the
 * rest geometry is not touched.
 */
export function correctiveOffsets(rig: Rig, bin: Uint8Array, partId: string, vertexCount: number, angles: number[][], jointIndex: ReadonlyMap<string, number>): Float32Array | null {
  let out: Float32Array | null = null
  for (const c of rig.correctives ?? []) {
    if (c.part !== partId) continue
    const ji = jointIndex.get(c.joint)
    if (ji === undefined) continue
    const w = correctiveWeights(c.keys, angles[ji]?.[c.dof] ?? 0)
    if (w.every((x) => x === 0)) continue
    const { index, shapes } = correctiveData(c, bin)
    out ??= new Float32Array(vertexCount * 3)
    for (let j = 0; j < shapes.length; j++) {
      const wj = w[j]!
      if (wj === 0) continue
      const d = shapes[j]!
      for (let k = 0; k < index.length; k++) {
        const v = index[k]!
        if (v >= vertexCount) continue
        out[v * 3] = out[v * 3]! + wj * d[k * 3]!
        out[v * 3 + 1] = out[v * 3 + 1]! + wj * d[k * 3 + 1]!
        out[v * 3 + 2] = out[v * 3 + 2]! + wj * d[k * 3 + 2]!
      }
    }
  }
  return out
}

/**
 * 加了校正形的顶点的法线（静止空间）：按摆好姿势之后的形状算面积加权法线，再用各顶点自己的混合转动转回静止空间，
 * 这样着色器照常转动法线之后正好是摆好姿势的形状的法线。只改 mask 标出的顶点；index 是部件内的三角形下标，base 是它的偏移。
 * 校正形在静止空间里看是皱的，按静止空间的位置重算的法线不对；不重算、照用原来的法线，又与摆好姿势之后的形状不符。
 * Normals (rest space) of the vertices a corrective moves: area-weighted normals of the posed shape, turned back to rest space by
 * each vertex's own blended rotation, so that the shader's usual turn of the normal gives exactly the posed shape's normal. Only
 * the vertices marked in `mask` change; `index` holds triangle indices with offset `base`. The corrective looks crumpled in rest
 * space, so normals recomputed from rest positions are wrong, and the original normals do not match the posed shape either.
 */
export function correctedNormals(bin: Uint8Array, offset: number, rest: ArrayLike<number>, index: ArrayLike<number>, base: number, dqs: DualQuat[], mask: Uint8Array, normals: Float32Array): void {
  const n = mask.length
  const xf = new Map<number, Xf>()
  const posed = new Map<number, V3>()
  const at = (v: number): V3 => {
    let p = posed.get(v)
    if (!p) {
      const m = vertexBlend(bin, offset, v, dqs)
      xf.set(v, m)
      p = xfApply(m, [rest[v * 3]!, rest[v * 3 + 1]!, rest[v * 3 + 2]!])
      posed.set(v, p)
    }
    return p
  }
  const acc = new Float64Array(n * 3)
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t]! - base, b = index[t + 1]! - base, c = index[t + 2]! - base
    if (!(mask[a] || mask[b] || mask[c])) continue
    const A = at(a), B = at(b), C = at(c)
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    for (const q of [a, b, c]) {
      if (!mask[q]) continue
      acc[q * 3] = acc[q * 3]! + nx
      acc[q * 3 + 1] = acc[q * 3 + 1]! + ny
      acc[q * 3 + 2] = acc[q * 3 + 2]! + nz
    }
  }
  for (let v = 0; v < n; v++) {
    if (!mask[v]) continue
    const l = Math.hypot(acc[v * 3]!, acc[v * 3 + 1]!, acc[v * 3 + 2]!)
    const m = xf.get(v)
    if (!(l > 0) || !m) continue
    const x = acc[v * 3]! / l, y = acc[v * 3 + 1]! / l, z = acc[v * 3 + 2]! / l
    const r = m.r
    // Rᵀ·n
    normals[v * 3] = r[0] * x + r[3] * y + r[6] * z
    normals[v * 3 + 1] = r[1] * x + r[4] * y + r[7] * z
    normals[v * 3 + 2] = r[2] * x + r[5] * y + r[8] * z
  }
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

/**
 * 肌肉作用线当前长度与静止长度。有经过点时是折线（起点 → 起作用的经过点 → 止点）的长度，`path` 给出当前的折线。
 * Current and rest length of a muscle's line of action. With via points these are lengths of the polyline (origin →
 * the via points in use → insertion), and `path` gives the current polyline.
 */
export function muscleLength(line: MuscleLine, xfs: Xf[], jointIndex: Map<string, number>): { rest: number; length: number; origin: V3; insertion: V3; path?: V3[] } {
  const o0 = line.origin.point as V3, i0 = line.insertion.point as V3
  const o = xfApply(xfs[jointIndex.get(line.origin.joint)!] ?? XF_ID, o0)
  const i = xfApply(xfs[jointIndex.get(line.insertion.joint)!] ?? XF_ID, i0)
  if (hasVia(line)) {
    const path = musclePath(line, xfLookup(xfs, jointIndex))
    return { rest: polylineLength(musclePath(line, () => XF_ID)), length: polylineLength(path), origin: o, insertion: i, path }
  }
  const d0 = sub(i0, o0), d = sub(i, o)
  return { rest: Math.hypot(d0[0], d0[1], d0[2]), length: Math.hypot(d[0], d[1], d[2]), origin: o, insertion: i }
}

/**
 * 去掉经过点的作用线（起点到止点的直线）。体积修正只按它算（有经过点的肌肉也一样）。
 * The line of action without its via points (the straight line from origin to insertion). The volume correction uses
 * this only (for muscles with via points too).
 */
export function straightLine(line: MuscleLine): MuscleLine {
  if (!hasVia(line) && !line.viaPush) return line
  const { via: _via, viaPush: _push, ...rest } = line
  return rest
}

/** 一个部件对它的作用线的横截面准备数据：顶点参数 s 和横截面影响 / A part's cross-section preparation for its line: vertex parameters s and the cross-section influences. */
export interface ViaPrep {
  s: Float32Array
  /** 样本的影响（VIA_SAMPLES × 12 字节）/ The samples' influences (VIA_SAMPLES × 12 bytes). */
  samples: Uint8Array
  /** 顶点的横截面影响（n × 12 字节，rig.bin 的格式）/ The vertices' cross-section influences (n × 12 bytes, rig.bin layout). */
  vertices: Uint8Array
}

const viaCache = new WeakMap<object, { line: MuscleLine; bin: Uint8Array; offset: number; prep: ViaPrep }[]>()

/**
 * 有经过点（及 viaPush）的蒙皮部件的横截面准备数据，按静止几何的数组缓存；不适用时为 null（刚体部件、顶点数不符）。
 * 运行时（src/anatomy/rig.ts 写顶点属性）和这里的 CPU 参考用同一个函数，所以两边的 s 和权重逐位相同。
 * The cross-section preparation of a skinned part whose line has via points (and viaPush), cached by the rest-geometry
 * array; null when it does not apply (a rigid part, a vertex-count mismatch). The runtime (src/anatomy/rig.ts, writing
 * the vertex attributes) and the CPU reference here use this same function, so s and the weights are bit for bit the
 * same on both sides.
 */
export function viaPrepFor(line: MuscleLine, rest: ArrayLike<number>, bin: Uint8Array, binding: RigBinding | undefined, jointIndex: ReadonlyMap<string, number>): ViaPrep | null {
  if (!hasViaPush(line) || !binding || binding.joint !== undefined || binding.offset === undefined) return null
  const n = rest.length / 3
  if (binding.vertexCount !== undefined && binding.vertexCount !== n) return null
  if (binding.offset + n * BYTES_PER_VERTEX > bin.length) return null
  const key = rest as unknown as object
  const list = viaCache.get(key) ?? []
  const hit = list.find((e) => e.line === line && e.bin === bin && e.offset === binding.offset)
  if (hit) return hit.prep
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const o = binding.offset
  const beyond = new Float32Array(n)
  const s = viaParams(line, rest, beyond)
  const O = line.origin.point as V3, I = line.insertion.point as V3
  const anchor = { origin: jointIndex.get(line.origin.joint) ?? 0, insertion: jointIndex.get(line.insertion.joint) ?? 0, length: Math.hypot(I[0] - O[0], I[1] - O[1], I[2] - O[2]) }
  const { samples, vertices } = sectionInfluences(s, (i, q) => [dv.getUint16(o + i * BYTES_PER_VERTEX + q * 2, true), bin[o + i * BYTES_PER_VERTEX + 8 + q]!], anchor, beyond)
  const prep = { s, samples, vertices }
  list.push({ line, bin, offset: o, prep })
  viaCache.set(key, list)
  return prep
}

/**
 * 某条有 viaPush 的作用线在当前姿势下各样本的平移（VIA_SAMPLES × 3）。`angles`、`rigid` 来自 jointFrames。
 * The per-sample translation of a line with viaPush in the current pose (VIA_SAMPLES × 3). `angles` and `rigid` come
 * from jointFrames.
 */
export function viaPushFor(line: MuscleLine, angles: number[][], rigid: Xf[], jointIndex: Map<string, number>): Float64Array {
  const p = line.viaPush
  if (!p) return new Float64Array(VIA_SAMPLES * 3)
  const ji = jointIndex.get(p.joint), fi = jointIndex.get(p.frame)
  const angle = ji === undefined ? 0 : (angles[ji]?.[p.dof] ?? 0)
  return viaPushAt(p, angle, (fi === undefined ? XF_ID : (rigid[fi] ?? XF_ID)).r)
}

/**
 * 肌肉体积保持：蒙皮之后，把顶点相对作用线（起点 → 止点）的垂直偏移按比例缩放。原地修改。
 * Muscle volume preservation: after skinning, scale every vertex's offset from the line of action
 * (origin → insertion). Modifies `posed` in place and returns the mid-belly scale applied.
 */
export function correctMuscleVolume(posed: Float32Array, line: MuscleLine, xfs: Xf[], jointIndex: Map<string, number>, opts: VolumeOptions = {}): number {
  // 长度取起止点直线的（有经过点时也一样）/ lengths of the straight line between the ends (with via points too)
  const { rest, length, origin } = muscleLength(straightLine(line), xfs, jointIndex)
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
  /** 姿势部分（刚体）与各自由度的有效角。 The pose part (rigid) and the effective angle of every dof. */
  readonly rigid: Xf[]
  readonly angles: number[][]
  readonly jointIndex: Map<string, number>
  private readonly bindingOf: Map<string, RigBinding>
  private readonly lineOf: Map<string, MuscleLine>

  constructor(readonly rig: Rig, readonly bin: Uint8Array, pose: Pose, scales?: Scales) {
    const f = jointFrames(rig.joints, pose, scales)
    this.xfs = f.xfs
    this.shape = f.shape
    this.rigid = f.rigid
    this.angles = f.angles
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
   * 部件变形后的顶点位置。`rest` 是该部件从 GLB 解码出的顶点（米）。`correct`：是否加上姿势校正形（缺省加）。
   * Deformed positions of a part. `rest` are the part's vertices as decoded from its GLB (metres). `correct`: whether the
   * pose-corrective shapes are added (by default they are).
   */
  part(partId: string, rest: Float32Array, mode: BlendMode = 'dqs', volume: VolumeOptions | false = { mode: 'uniform' }, correct = true): Float32Array {
    const b = this.bindingOf.get(partId)
    if (!b) return Float32Array.from(rest)
    // 姿势校正形加在蒙皮之前（静止姿势下没有，静止几何逐位不变）；调用方已经把它加进 rest 时传 correct = false
    // pose-corrective shapes go on before skinning (none at rest, so the rest geometry is unchanged bit for bit); pass correct = false when the caller has already added them into `rest`
    if (correct && this.rig.correctives?.length) {
      const off = correctiveOffsets(this.rig, this.bin, partId, rest.length / 3, this.angles, this.jointIndex)
      if (off) {
        const r = new Float32Array(rest.length)
        for (let i = 0; i < r.length; i++) r[i] = rest[i]! + off[i]!
        rest = r
      }
    }
    const line = this.lineOf.get(partId)
    // 有经过点（及 viaPush）：按横截面蒙皮，体积修正，再推出骨面（tools/rig/musclepath.ts）
    // with via points (and viaPush): skinned by cross-section, volume-corrected, then pushed out of the bone (tools/rig/musclepath.ts)
    const prep = line ? viaPrepFor(line, rest, this.bin, b, this.jointIndex) : null
    if (line && prep) {
      const out = skin(rest, prep.vertices, 0, this.xfs, mode, this.dqs, this.shape)
      if (volume) correctMuscleVolume(out, line, this.xfs, this.jointIndex, volume)
      applyViaPush(out, prep.s, viaPushFor(line, this.angles, this.rigid, this.jointIndex))
      return out
    }
    let out: Float32Array
    if (b.joint !== undefined) out = transformRigid(rest, this.xfs[this.jointIndex.get(b.joint)!] ?? XF_ID)
    else out = skin(rest, this.bin, b.offset!, this.xfs, mode, this.dqs, this.shape)
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
 * 注意：这里只分配角度，三个关节角之和等于 angle，但上臂实际抬高多少取决于各关节轴的方向；
 * 要让上臂真正到达某个角度，用 armElevation。
 * Note: this only shares the angle out. The three joint angles sum to `angle`, but how far the arm
 * really rises depends on the directions of the joint axes; use armElevation to reach a stated angle.
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

/**
 * 把上臂抬到给定的“胸肱角”（弧度）：上臂长轴（盂肱关节中心 → 肘关节中心）与铅垂线的夹角，
 * 0 = 上臂垂直向下。plane：0 = 冠状面外展，1 = 矢状面前屈。肩带部分仍按 shoulderElevation 的节律给出；
 * 盂肱关节的屈伸、收展两个角由数值求解，使上臂在摆好之后恰好落在目标方向上。
 * 之所以要求解：shoulderElevation 只是把角度按比例分给三个关节，而肩锁、胸锁关节的轴并不与冠状面垂直，
 * 分给肩带的那一份只有一部分变成上臂的抬高（本模型两副身体上，开环的“外展 90°”实际只到 73° 和 79°）；
 * 静止姿势里上臂已有的外展（由关节几何量出，不必另外记录）也在这里一并扣除。
 * Raises the arm to a given thoracohumeral angle (radians): the angle between the long axis of the
 * upper arm (glenohumeral centre → elbow centre) and the vertical, 0 = hanging straight down.
 * plane: 0 = abduction in the frontal plane, 1 = flexion in the sagittal plane. The girdle moves by
 * the rhythm of shoulderElevation; the flexion and abduction angles of the glenohumeral joint are
 * then solved numerically so that the posed upper arm lies exactly along the target direction.
 * The solve is needed because shoulderElevation merely shares the angle out between three joints,
 * and the axes of the acromioclavicular and sternoclavicular joints are not perpendicular to the
 * frontal plane: only part of the girdle's share becomes elevation of the arm (on the two bodies
 * here the open-loop "abduction 90°" reached 73° and 79°). What the arm is already abducted by in
 * the rest pose is measured from the joint geometry and taken off here as well.
 */
export function armElevation(joints: Joint[], side: 'L' | 'R', angle: number, plane: 0 | 1 = 0, girdleShare = 1 / 3): Pose {
  const id = `gh_${side}`
  const gi = joints.findIndex((j) => j.id === id)
  const gh = joints[gi]
  const tail = gh && (gh as Joint & { tail?: V3 }).tail
  const kF = gh ? gh.dofs.findIndex((d) => d.axis === 0) : -1, kA = gh ? gh.dofs.findIndex((d) => d.axis === 1) : -1
  if (!gh || !tail || kF < 0 || kA < 0) return shoulderElevation(side, angle, plane, girdleShare)
  const m = side === 'L' ? 1 : -1
  const d0 = segmentAxis(gh)
  // 静止时上臂在该平面内已有的抬高 / what the arm is already raised by in this plane at rest
  const rest = plane === 0 ? Math.atan2(d0[0] * m, -d0[1]) : Math.atan2(d0[2], -d0[1])
  const base = shoulderElevation(side, angle - rest, plane, girdleShare)
  const target: V3 = plane === 0 ? [m * Math.sin(angle), -Math.cos(angle), 0] : [0, -Math.cos(angle), Math.sin(angle)]
  const x = gh.dofs.map(() => 0)
  x[plane === 0 ? kA : kF] = base[id]![1 - plane]!
  const miss = (f: number, a: number): V3 => {
    const g = x.slice()
    g[kF] = f
    g[kA] = a
    const xf = jointTransforms(joints, { ...base, [id]: g })[gi]!
    const d = norm(sub(xfApply(xf, tail), xfApply(xf, gh.center as V3)))
    return [d[0] - target[0], d[1] - target[1], d[2] - target[2]]
  }
  // 高斯–牛顿法：两个未知量（屈伸、收展），三个残差（方向之差）
  // Gauss–Newton: two unknowns (flexion, abduction), three residuals (difference of directions)
  const h = 1e-5
  for (let it = 0; it < 30; it++) {
    const r = miss(x[kF]!, x[kA]!)
    if (Math.hypot(r[0], r[1], r[2]) < 1e-9) break
    const rf = miss(x[kF]! + h, x[kA]!), ra = miss(x[kF]!, x[kA]! + h)
    const jf: V3 = [(rf[0] - r[0]) / h, (rf[1] - r[1]) / h, (rf[2] - r[2]) / h], ja: V3 = [(ra[0] - r[0]) / h, (ra[1] - r[1]) / h, (ra[2] - r[2]) / h]
    const dotv = (p: V3, q: V3): number => p[0] * q[0] + p[1] * q[1] + p[2] * q[2]
    // 阻尼正规方程 / damped normal equations
    const aff = dotv(jf, jf) + 1e-9, aaa = dotv(ja, ja) + 1e-9, afa = dotv(jf, ja), bf = -dotv(jf, r), ba = -dotv(ja, r)
    const det = aff * aaa - afa * afa
    if (Math.abs(det) < 1e-14) break
    let df = (bf * aaa - ba * afa) / det, da = (ba * aff - bf * afa) / det
    const step = Math.hypot(df, da)
    if (step > 0.5) {
      df *= 0.5 / step
      da *= 0.5 / step
    }
    x[kF] = x[kF]! + df
    x[kA] = x[kA]! + da
  }
  return { ...base, [id]: x }
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
