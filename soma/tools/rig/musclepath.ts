// 肌肉路径（起点 → 经过点 → 止点）。纯函数，不依赖 three.js；前端经 pose.ts 原样导入。
// Muscle paths (origin → via points → insertion). Pure functions without three.js; the frontend imports them unchanged
// through pose.ts.
//
// 路径只用于长度、力臂和肌肉活动；肌肉网格不随路径变形（仍按蒙皮，体积修正仍相对起止点的直线），所以有经过点的肌肉
// 网格与没有经过点时逐位相同。随路径变形的网格做过（平移、横截面旋转、κ、按横截面蒙皮、向外推出骨面），用
// tools/rig/via-check.ts 量过，都比不上纯蒙皮的门槛（翻转、拉伸、骨面覆盖），见 README。
// The path is used for lengths, moment arms and muscle activity only; the muscle meshes do not deform along it (they
// keep their skinning, and the volume correction stays about the straight line between the ends), so the mesh of a
// muscle with via points is bit for bit the mesh without them. Meshes following the path were tried (translation,
// cross-section rotation, κ, skinning by cross-section, pushing out of the bone) and measured with
// tools/rig/via-check.ts; none met the gate set by plain skinning (inversions, stretch, bone coverage), see the README.
//
// 路径：经过点随各自的关节运动；带缠绕条件（MuscleVia.wrap）的点只在直线会穿进骨里时才用（见 src/anatomy/types.ts）。
// The path: via points move with their joints; a point with a wrapping condition (MuscleVia.wrap) is used only when
// the straight line would pass into the bone (see src/anatomy/types.ts).

import type { MuscleLine, MuscleVia } from '../../src/anatomy/types.ts'
import { type V3, type Xf, XF_ID, cross, dot, m3apply, norm, sub, xfApply } from './math.ts'

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
