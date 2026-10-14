// 肌肉路径（起点 → 经过点 → 止点），以及有经过点的肌肉网格的变形。纯函数，不依赖 three.js；前端经 pose.ts 原样导入。
// Muscle paths (origin → via points → insertion), and the deformation of the mesh of a muscle with via points. Pure
// functions without three.js; the frontend imports them unchanged through pose.ts.
//
// 路径：经过点随各自的关节运动；带缠绕条件（MuscleVia.wrap）的点只在直线会穿进骨里时才用（见 src/anatomy/types.ts）。
// 路径用于长度、力臂和肌肉活动。
// The path: via points move with their joints; a point with a wrapping condition (MuscleVia.wrap) is used only when
// the straight line would pass into the bone (see src/anatomy/types.ts). The path gives lengths, moment arms and muscle
// activity.
//
// 网格（有 MuscleLine.viaPush 时）/ the mesh (with MuscleLine.viaPush)
//   · 横截面蒙皮：每个顶点的参数 s 是它在起止点直线上的投影比例（按 1/VIA_S_STEPS 量化）；沿 s 取 VIA_SAMPLES 个样本，
//     每个样本的影响是附近顶点影响的平均（三角核，半宽一个样本间距）；顶点取两侧样本影响的线性插值。同一横截面的顶点
//     于是随同一个变换运动，屈膝时横截面不再被对偶四元数混合剪切折叠。
//     Cross-section skinning: a vertex's parameter s is the fraction of its projection onto the straight line between the
//     ends (quantised to 1/VIA_S_STEPS); VIA_SAMPLES samples are taken along s, each with the mean influences of the
//     vertices near it (triangular kernel, half-width one sample spacing), and a vertex takes the linear interpolation
//     of the influences of the samples either side. The vertices of a cross-section then move with one transform, and
//     knee flexion no longer shears and folds the cross-section through dual-quaternion blending.
//     两端 VIA_ANCHOR 之内，样本的影响渐渐移给附着端的关节：附着处随骨刚性运动，不随平均权重滑离骨面。
//     投影落在两端之外的顶点（网格比作用线长，如股肌远端延续成髌腱）在 VIA_BEYOND 之内渐渐换回它自己的权重（普通蒙皮）：
//     否则它们的 s 都被夹成 0 或 1，整段随端点的关节刚性运动，伸出骨外成为悬空的细条。
//     Within VIA_ANCHOR of either end the samples' influence passes gradually to the joint of that attachment: the
//     attachment moves rigidly with its bone instead of sliding off it with the averaged weights. Vertices projecting
//     beyond either end (a mesh longer than its line, such as the vasti running on into the patellar tendon) pass back
//     to their own weights (plain skinning) within VIA_BEYOND: otherwise their s would all be clamped to 0 or 1 and the
//     whole piece would move rigidly with the end's joint, sticking out of the bone as a free-hanging strip.
//   · 推出骨面：每个样本一个平移，取自构建时烘焙的表（tools/rig/viapush.ts），顶点按 s 在两侧样本间线性插值。
//     Push out of the bone: one translation per sample, read from the table baked when the rig is built
//     (tools/rig/viapush.ts); a vertex interpolates linearly in s between the samples either side.
//   · 体积修正仍相对起止点的直线（tools/rig/pose.ts 的 straightLine），在推出之前做。
//     The volume correction stays about the straight line between the ends (straightLine in tools/rig/pose.ts) and
//     comes before the push.
//   · 没有 viaPush 的作用线完全不走这里：网格与以前逐位相同。
//     Lines without viaPush never come here: their meshes are bit for bit what they were.

import type { MuscleLine, MuscleVia, MuscleViaPush } from '../../src/anatomy/types.ts'
import { type M3, type V3, type Xf, XF_ID, cross, dot, m3apply, norm, sub, xfApply } from './math.ts'

/** 沿 s 的横截面样本数 / Cross-section samples along s. */
export const VIA_SAMPLES = 24
/**
 * 附着处随骨的长度（米）：样本离一端不到这么远时，影响逐渐移给该端的关节，附着处不随平均权重滑离骨面。
 * How far (m) from an attachment the mesh is carried by the bone: a sample nearer an end than this hands its influence
 * gradually to that end's joint, so the attachment does not slide off the bone with the averaged weights.
 */
export const VIA_ANCHOR = 0.02
/**
 * 端点之外换回普通蒙皮的长度（米）：投影落在端点之外这么远的顶点完全按它自己的权重。
 * How far (m) beyond an end a vertex has passed back entirely to its own weights (plain skinning).
 */
export const VIA_BEYOND = 0.02
/**
 * 推出量在两端的过渡长度（米）：离一端不到这么远的样本，推出量按距离渐减，端点处为 0（附着处贴着骨，不推）。
 * The fade length of the push at either end (m): nearer an end than this the push fades with the distance, and it is 0
 * at the end (an attachment lies on its bone and is not pushed).
 */
export const VIA_END = 0.02
/** 这三个长度都是本项目的取值（用 tools/rig/via-check.ts 的门槛和渲染选出），不是测量值。 These three lengths are this project's choices (picked against the gate of tools/rig/via-check.ts and the renders), not measurements. */

/** 参数 s 处推出量所占的份额：两端为 0，VIA_END 之内线性增到 1 / The share of the push at parameter s: 0 at the ends, rising linearly to 1 within VIA_END. */
export const viaShare = (s: number, length: number): number => (length > 0 ? Math.min(1, Math.max(0, (Math.min(s, 1 - s) * length) / VIA_END)) : 0)
/** 顶点参数 s 的量化步数（着色器从 aThin 精确解出同一个值）/ Quantisation steps of the vertex parameter s (the shader decodes exactly the same value from aThin). */
export const VIA_S_STEPS = 1024

/** 作用线是否让网格按横截面蒙皮并推出骨面 / Whether a line makes its mesh skin by cross-section and push out of the bone. */
export const hasViaPush = (line: MuscleLine): boolean => !!line.viaPush && !!line.via && line.via.length > 0 && line.viaPush.samples === VIA_SAMPLES

/** 顶点参数 s：静止顶点投到起止点直线上的比例，夹在 [0, 1] 并量化 / The vertex parameter s: the fraction of the rest vertex's projection onto the straight line between the ends, clamped to [0, 1] and quantised. */
export function viaParams(line: MuscleLine, rest: ArrayLike<number>, beyond?: Float32Array): Float32Array {
  const O = line.origin.point as V3, I = line.insertion.point as V3
  const d = sub(I, O)
  const l2 = dot(d, d)
  const n = Math.floor(rest.length / 3)
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = l2 > 0 ? ((rest[i * 3]! - O[0]) * d[0] + (rest[i * 3 + 1]! - O[1]) * d[1] + (rest[i * 3 + 2]! - O[2]) * d[2]) / l2 : 0
    s[i] = Math.round(Math.min(1, Math.max(0, t)) * VIA_S_STEPS) / VIA_S_STEPS
    // 投影落在端点之外多远（米）/ how far (m) beyond an end the projection falls
    if (beyond) beyond[i] = Math.max(0, -t, t - 1) * Math.sqrt(l2)
  }
  return s
}

/** 关节 → 权重的累计，取最大的 4 个，量化为和为 255 的整数，写成 rig.bin 的格式 / Joint → weight sums: the 4 largest, quantised to integers summing to 255, written in rig.bin layout. */
function writeTop4(m: Map<number, number>, out: Uint8Array, o: number): void {
  const top = [...m.entries()].filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4)
  if (!top.length) return
  const tot = top.reduce((t, e) => t + e[1], 0)
  const w = top.map((e) => Math.round((e[1] / tot) * 255))
  w[0] = w[0]! + 255 - w.reduce((t, x) => t + x, 0)
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength)
  for (let q = 0; q < 4; q++) {
    dv.setUint16(o + q * 2, top[q]?.[0] ?? top[0]![0], true)
    out[o + 8 + q] = top[q] ? w[q]! : 0
  }
}

/**
 * 横截面的影响：样本的影响（VIA_SAMPLES × 12 字节）和顶点的影响（n × 12 字节），都是 rig.bin 的格式。
 * `influence(i, q)` 给出顶点 i 第 q 个影响的 [关节下标, 权重 0–255]。附近没有顶点的样本借用最近的有顶点的样本（距离相同时取近起点那一个）。
 * `anchor`：起点、止点的关节下标和起止点直线的长度（米），两端各 VIA_ANCHOR 之内的样本渐渐改随该端的关节。
 * `beyond`：每个顶点的投影落在端点之外多远（米，见 viaParams）；在 VIA_BEYOND 之内渐渐换回自己的权重。
 * The cross-section influences: the samples' (VIA_SAMPLES × 12 bytes) and the vertices' (n × 12 bytes), both in
 * rig.bin layout. `influence(i, q)` gives vertex i's q-th influence as [joint index, weight 0–255]. A sample with no
 * vertex near it borrows from the nearest sample that has some (the one nearer the origin on a tie). `anchor`: the
 * joint indices of origin and insertion and the length (m) of the straight line between them; within VIA_ANCHOR of
 * either end the samples pass over gradually to that end's joint. `beyond`: how far (m) beyond an end each vertex
 * projects (see viaParams); within VIA_BEYOND it passes back gradually to its own weights.
 */
export function sectionInfluences(s: Float32Array, influence: (i: number, q: number) => [number, number], anchor: { origin: number; insertion: number; length: number }, beyond?: Float32Array): { samples: Uint8Array; vertices: Uint8Array } {
  const K = VIA_SAMPLES
  const acc: Map<number, number>[] = Array.from({ length: K }, () => new Map())
  for (let i = 0; i < s.length; i++) {
    const f = s[i]! * (K - 1)
    for (let k = Math.max(0, Math.ceil(f - 1)); k <= Math.min(K - 1, Math.floor(f + 1)); k++) {
      const wk = 1 - Math.abs(f - k)
      if (!(wk > 0)) continue
      const m = acc[k]!
      for (let q = 0; q < 4; q++) {
        const [j, w] = influence(i, q)
        if (w > 0) m.set(j, (m.get(j) ?? 0) + wk * w)
      }
    }
  }
  const filled = acc.map((m) => m.size > 0)
  for (let k = 0; k < K; k++) {
    if (filled[k]) continue
    for (let d = 1; d < K; d++) {
      const j = k - d >= 0 && filled[k - d] ? k - d : k + d < K && filled[k + d] ? k + d : -1
      if (j >= 0) {
        acc[k] = new Map(acc[j]!)
        break
      }
    }
  }
  // 附着处：样本离较近的一端不到 VIA_ANCHOR 时，影响按 g = 1 − 距离 / VIA_ANCHOR 移给该端的关节（端点处 g = 1，随骨刚性运动）
  // at the attachments: a sample nearer than VIA_ANCHOR to its nearer end hands g = 1 − distance / VIA_ANCHOR of its influence to that end's joint (g = 1 at the end, which then moves rigidly with its bone)
  if (anchor.length > 0) {
    for (let k = 0; k < K; k++) {
      const t = k / (K - 1), g = 1 - (Math.min(t, 1 - t) * anchor.length) / VIA_ANCHOR
      if (!(g > 0)) continue
      const m = acc[k]!, tot = [...m.values()].reduce((x, y) => x + y, 0)
      for (const [j, w] of m) m.set(j, w * (1 - g))
      const j = t < 0.5 ? anchor.origin : anchor.insertion
      m.set(j, (m.get(j) ?? 0) + g * (tot > 0 ? tot : 255))
    }
  }
  const samples = new Uint8Array(K * 12)
  for (let k = 0; k < K; k++) writeTop4(acc[k]!, samples, k * 12)
  const sdv = new DataView(samples.buffer)
  const vertices = new Uint8Array(s.length * 12)
  for (let i = 0; i < s.length; i++) {
    const f = s[i]! * (K - 1), k = Math.min(K - 2, Math.floor(f)), a = f - k
    // 端点之外：在 VIA_BEYOND 之内换回自己的权重 / beyond an end: back to the vertex's own weights within VIA_BEYOND
    const g = (beyond ? Math.min(1, Math.max(0, 1 - beyond[i]! / VIA_BEYOND)) : 1)
    const m = new Map<number, number>()
    for (const [kk, wk] of [[k, (1 - a) * g], [k + 1, a * g]] as const) {
      if (!(wk > 0)) continue
      for (let q = 0; q < 4; q++) {
        const w = samples[kk * 12 + 8 + q]!
        if (w > 0) {
          const j = sdv.getUint16(kk * 12 + q * 2, true)
          m.set(j, (m.get(j) ?? 0) + wk * w)
        }
      }
    }
    // 混入顶点自己的权重 / the vertex's own weights mixed in
    if (g < 1) {
      for (let q = 0; q < 4; q++) {
        const [j, w] = influence(i, q)
        if (w > 0) m.set(j, (m.get(j) ?? 0) + (1 - g) * w)
      }
    }
    writeTop4(m, vertices, i * 12)
  }
  return { samples, vertices }
}

/**
 * 当前姿势下各样本的平移（VIA_SAMPLES × 3，米）：按角度在表的两行之间线性插值，再用 `frame` 关节的转动转到当前姿势。
 * 角度在表的范围之外时取两端；角度为 0 时恰为 0。
 * The translation of every sample in the current pose (VIA_SAMPLES × 3, metres): interpolated linearly between two
 * rows of the table by the angle, then turned into the current pose by the rotation of the `frame` joint. An angle
 * outside the table takes its ends; at angle 0 the result is exactly 0.
 */
export function viaPushAt(push: MuscleViaPush, angle: number, rot: M3): Float64Array {
  const K = VIA_SAMPLES
  const D = new Float64Array(K * 3)
  const rows = Math.floor(push.d.length / (K * 3))
  if (rows < 1) return D
  const step = (push.stepDeg * Math.PI) / 180
  const f = Number.isFinite(angle) && step > 0 ? Math.min(rows - 1, Math.max(0, angle / step)) : 0
  const i0 = Math.min(Math.max(0, rows - 2), Math.floor(f)), a = rows > 1 ? f - i0 : 0
  const o0 = i0 * K * 3, o1 = Math.min(rows - 1, i0 + 1) * K * 3
  const d = push.d
  for (let k = 0; k < K; k++) {
    const x = d[o0 + k * 3]! + (d[o1 + k * 3]! - d[o0 + k * 3]!) * a
    const y = d[o0 + k * 3 + 1]! + (d[o1 + k * 3 + 1]! - d[o0 + k * 3 + 1]!) * a
    const z = d[o0 + k * 3 + 2]! + (d[o1 + k * 3 + 2]! - d[o0 + k * 3 + 2]!) * a
    D[k * 3] = rot[0] * x + rot[1] * y + rot[2] * z
    D[k * 3 + 1] = rot[3] * x + rot[4] * y + rot[5] * z
    D[k * 3 + 2] = rot[6] * x + rot[7] * y + rot[8] * z
  }
  return D
}

/** 把各样本的平移按 s 插值加到顶点上（原地）。与着色器同一公式 / Add the samples' translations, interpolated by s, to the vertices (in place). The shader's formula. */
export function applyViaPush(posed: Float32Array, s: Float32Array, D: Float64Array): void {
  const K = VIA_SAMPLES
  for (let i = 0; i < s.length; i++) {
    const f = s[i]! * (K - 1), k = Math.min(K - 2, Math.floor(f)), a = f - k
    const o = k * 3
    posed[i * 3] = posed[i * 3]! + D[o]! + (D[o + 3]! - D[o]!) * a
    posed[i * 3 + 1] = posed[i * 3 + 1]! + D[o + 1]! + (D[o + 4]! - D[o + 1]!) * a
    posed[i * 3 + 2] = posed[i * 3 + 2]! + D[o + 2]! + (D[o + 5]! - D[o + 2]!) * a
  }
}

/** 缠绕点从“随直线滑动”过渡到“固定在骨上”所需的压入深度（米）/ How deep (m) the line must press in before a wrapping point stops sliding with it and stays put on the bone. */
export const WRAP_SETTLE = 0.005
/** 交点离线段端点多近（米）时缠绕点开始退回直线 / How near (m) the crossing must come to an end of the segment before a wrapping point starts sliding back onto the line. */
export const WRAP_END = 0.01

export const hasVia = (line: MuscleLine): boolean => !!line.via && line.via.length > 0

type XfOf = (joint: string) => Xf

/** 由关节变换数组和下标表得到按关节 id 取变换的函数 / A by-id transform lookup from the transform array and the index map. */
export const xfLookup = (xfs: readonly Xf[], jointIndex: ReadonlyMap<string, number>): XfOf => (joint) => xfs[jointIndex.get(joint) ?? -1] ?? XF_ID

/**
 * 缠绕点是否起作用，起作用时返回它的有效位置。A：路径上前一点，B：后面第一个无条件点，P：该点，c / n：轴上一点和轴向（都已变换）。
 * Whether a wrapping point is in use, and its effective position if so. A: previous point of the path, B: next
 * unconditional point, P: the point, c / n: a point on the axis and its direction (all transformed).
 */
export function wrapPoint(A: V3, B: V3, P: V3, c: V3, n: V3): V3 | null {
  return wrapTest(A, B, P, c, n)?.point ?? null
}

/** 同 wrapPoint，另给出直线压进去的深度（米）/ As wrapPoint, also giving how deep (m) the line presses in. */
export function wrapTest(A: V3, B: V3, P: V3, c: V3, n: V3): { point: V3; depth: number } | null {
  // 投到垂直于轴的平面，以轴心为原点 / project onto the plane perpendicular to the axis, the axis at the origin
  const flat = (v: V3): V3 => {
    const k = dot(v, n)
    return [v[0] - n[0] * k, v[1] - n[1] * k, v[2] - n[2] * k]
  }
  const a = flat(sub(A, c)), b = flat(sub(B, c)), p = flat(sub(P, c))
  const r = Math.hypot(p[0], p[1], p[2])
  if (!(r > 1e-9)) return null
  const e: V3 = [p[0] / r, p[1] / r, p[2] / r]
  const u = sub(b, a)
  // 直线 a + t·u 与从轴心经过 P 的射线 λ·e 的交点 / where the line a + t·u meets the ray λ·e from the axis through P
  const cr = (x: V3, y: V3): number => dot(n, cross(x, y))
  const den = cr(u, e)
  if (!(Math.abs(den) > 1e-12)) return null
  const t = -cr(a, e) / den
  if (!(t > 0 && t < 1)) return null
  const lambda = (a[0] + u[0] * t) * e[0] + (a[1] + u[1] * t) * e[1] + (a[2] + u[2] * t) * e[2]
  // 交点比 P 离轴更近（含在轴的另一侧穿过）= 直线在 P 这一侧穿进骨里；交点必须落在 A、B 之间（上面的 t）
  // the crossing nearer the axis than P (or beyond the axis) = the line passes into the bone on P's side; the crossing must lie between A and B (t above)
  if (!(lambda < r)) return null
  // 刚起作用时，沿轴向的坐标取直线在交点处的值，使路径连续；直线压进去 WRAP_SETTLE 以上后用这个点自己的坐标（肌腱不再随直线左右滑动）
  // when the point has just come into use its coordinate along the axis is the line's at the crossing, so the path is continuous; once the line is pressed in by WRAP_SETTLE or more the point keeps its own coordinate (the tendon no longer slides sideways with the line)
  const Q: V3 = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]
  const k = dot(sub(Q, P), n) * Math.max(0, 1 - (r - lambda) / WRAP_SETTLE)
  const S: V3 = [P[0] + n[0] * k, P[1] + n[1] * k, P[2] + n[2] * k]
  // 交点离线段端点不到 WRAP_END 时，这个点逐渐退回直线上：端点从骨的另一侧越过时路径也不跳
  // within WRAP_END of either end of the segment the point slides back onto the line, so the path does not jump when an end passes the bone on its far side
  const beta = Math.min(1, (Math.min(t, 1 - t) * Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2])) / WRAP_END)
  return { point: [Q[0] + (S[0] - Q[0]) * beta, Q[1] + (S[1] - Q[1]) * beta, Q[2] + (S[2] - Q[2]) * beta], depth: (r - lambda) * beta }
}

/**
 * 当前姿势下路径上实际经过的点：起点、起作用的经过点、止点。没有经过点时就是两端。
 * The points the path actually passes in the current pose: origin, the via points in use, insertion. Without via
 * points just the two ends.
 */
export function musclePath(line: MuscleLine, xfOf: XfOf): V3[] {
  const O = xfApply(xfOf(line.origin.joint), line.origin.point as V3)
  const I = xfApply(xfOf(line.insertion.joint), line.insertion.point as V3)
  const via: MuscleVia[] = line.via ?? []
  if (!via.length) return [O, I]
  // 无条件的点把路径分成几段；每段之间的缠绕点按“压得最深的先放”逐个插入它所切过的那一小段，直到没有点被压进去。
  // 这样结果与缠绕点的列出顺序无关，点的加入和退出都发生在压入深度为 0 处，路径随姿势连续变化。
  // The unconditional points split the path into stretches; within each, the wrapping points are inserted one at a time,
  // deepest penetration first, into the piece of the stretch they cut, until none is pressed in. The result then does not
  // depend on the order in which the wrapping points are listed, and points enter and leave at zero depth, so the path
  // changes continuously with the pose.
  const out: V3[] = [O]
  let pending: { P: V3; c: V3; n: V3 }[] = []
  const flush = (B: V3): void => {
    const chain: V3[] = [out[out.length - 1]!, B]
    const used = new Set<number>()
    for (;;) {
      let best: { i: number; at: number; point: V3; depth: number } | null = null
      pending.forEach((w, i) => {
        if (used.has(i)) return
        for (let k = 0; k + 1 < chain.length; k++) {
          const hit = wrapTest(chain[k]!, chain[k + 1]!, w.P, w.c, w.n)
          if (hit && hit.depth > 0 && (!best || hit.depth > best.depth)) best = { i, at: k + 1, point: hit.point, depth: hit.depth }
        }
      })
      if (!best) break
      const b = best as { i: number; at: number; point: V3 }
      used.add(b.i)
      chain.splice(b.at, 0, b.point)
    }
    for (let k = 1; k < chain.length - 1; k++) out.push(chain[k]!)
    pending = []
  }
  for (const v of via) {
    const m = xfOf(v.joint)
    const P = xfApply(m, v.point as V3)
    if (!v.wrap) {
      flush(P)
      out.push(P)
      continue
    }
    pending.push({ P, c: xfApply(m, v.wrap.centre as V3), n: norm(m3apply(m.r, v.wrap.axis as V3)) })
  }
  flush(I)
  out.push(I)
  return out
}

/** 折线长度 / Length of a polyline. */
export function polylineLength(pts: readonly V3[]): number {
  let L = 0
  for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1], pts[k]![2] - pts[k - 1]![2])
  return L
}

/** 点投到折线上最近处的弧长比例 / Arc-length fraction of the nearest point of a polyline. */
export function projectOnPolyline(pts: readonly V3[], p: V3): number {
  const total = polylineLength(pts)
  if (!(total > 1e-12)) return 0
  let best = Infinity, at = 0, run = 0
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!, b = pts[k]!
    const d = sub(b, a)
    const l2 = dot(d, d)
    const t = l2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, a), d) / l2)) : 0
    const q: V3 = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t]
    const e = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
    if (e < best) (best = e), (at = run + t * Math.sqrt(l2))
    run += Math.sqrt(l2)
  }
  return at / total
}
