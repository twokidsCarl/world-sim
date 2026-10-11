// 铰链轴的“功能性”精修：让凹侧关节面在整个活动范围内与凸侧关节面保持恒定间隙。
// Functional refinement of a hinge axis: the concave articular surface must keep a constant gap
// to the convex one over the whole range of motion.
//
// 几何拟合（球、回转面）只看静止姿势下的一小块关节面；在粗网格上方向并不稳定。这里把凹侧
// 关节面上的采样点绕候选轴转过活动范围，量它们到凸侧骨面的有符号间隙相对静止时的变化，
// 用 Nelder–Mead 在 4 个参数（轴方向 2 个、轴位置 2 个）上使其最小。
// The geometric fits (sphere, surface of revolution) only see a small articular patch in the rest
// pose and are unstable on coarse meshes. Here samples of the concave surface are swept about a
// candidate axis through the range of motion; the change of their signed gap to the convex bone
// relative to rest is minimised by Nelder–Mead over 4 parameters (2 for direction, 2 for position).

import type { Sample } from './fits.ts'
import type { Surface } from './geom.ts'
import { type V3, add, axisAngle, cross, dot, len, m3apply, mul, norm, rad, sub } from './math.ts'

export interface HingeInit {
  point: V3
  dir: V3
}

export interface HingeResult {
  point: V3
  dir: V3
  /** 优化后 / 优化前：间隙变化的均方根（米）。 RMS change of gap after / before refinement (metres). */
  rms: number
  rmsInit: number
  /** 轴方向改变的角度（弧度）与轴位置的移动（米）。 Change of direction (rad) and shift of the axis (m). */
  turned: number
  shifted: number
  samples: number
}

export interface HingeOptions {
  /** 活动范围（度），按 dir 的右手方向为正。 Sweep in degrees, positive by the right-hand rule about dir. */
  sweep: [number, number]
  /** 凹侧骨是近端骨（静止不动的一方）时为 true：此时反向转动采样点。 True when the concave bone is the proximal (stationary) one: the samples are then swept the other way. */
  invert?: boolean
  steps?: number
  maxSamples?: number
  /** 残差截断（米）。 Residual cap (metres). */
  cap?: number
  /** 正则：偏离初值 10° 相当于多大的间隙误差（米）。 Regulariser: gap error (m) that 10° away from the initial direction is worth. */
  dirWeight?: number
  /** 正则：轴移动 5 mm 相当于多大的间隙误差（米）。 Regulariser: gap error (m) that a 5 mm shift is worth. */
  posWeight?: number
  maxEvals?: number
  /** 轴位置的额外起点（米，垂直于轴的平面内）。 Extra starting offsets of the axis position (metres, in the plane perpendicular to the axis). */
  starts?: [number, number][]
}

/** 4 维 Nelder–Mead。 Nelder–Mead in a few dimensions. */
export function nelderMead(f: (x: number[]) => number, x0: number[], step: number[], maxEvals: number): { x: number[]; f: number; evals: number } {
  const n = x0.length
  const pts: { x: number[]; f: number }[] = [{ x: x0, f: f(x0) }]
  for (let i = 0; i < n; i++) {
    const x = [...x0]
    x[i] = x[i]! + step[i]!
    pts.push({ x, f: f(x) })
  }
  let evals = n + 1
  const comb = (a: number[], b: number[], t: number): number[] => a.map((v, i) => v + t * (b[i]! - v))
  while (evals < maxEvals) {
    pts.sort((a, b) => a.f - b.f)
    if (Math.abs(pts[n]!.f - pts[0]!.f) < 1e-12 * (1 + Math.abs(pts[0]!.f))) break
    const c = new Array<number>(n).fill(0)
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) c[k] = c[k]! + pts[i]!.x[k]! / n
    const worst = pts[n]!
    const xr = comb(c, worst.x, -1)
    const fr = f(xr)
    evals++
    if (fr < pts[0]!.f) {
      const xe = comb(c, worst.x, -2)
      const fe = f(xe)
      evals++
      pts[n] = fe < fr ? { x: xe, f: fe } : { x: xr, f: fr }
    } else if (fr < pts[n - 1]!.f) {
      pts[n] = { x: xr, f: fr }
    } else {
      const xc = comb(c, fr < worst.f ? xr : worst.x, 0.5)
      const fc = f(xc)
      evals++
      if (fc < Math.min(fr, worst.f)) pts[n] = { x: xc, f: fc }
      else {
        for (let i = 1; i <= n; i++) {
          const x = comb(pts[0]!.x, pts[i]!.x, 0.5)
          pts[i] = { x, f: f(x) }
          evals++
        }
      }
    }
  }
  pts.sort((a, b) => a.f - b.f)
  return { x: pts[0]!.x, f: pts[0]!.f, evals }
}

/**
 * 精修铰链轴。`concave` 是凹侧关节面的采样点，`convex` 是凸侧骨的表面。
 * Refines a hinge axis. `concave` are samples of the concave articular surface, `convex` the
 * surface of the convex bone.
 */
export function refineHinge(concave: Sample[], convex: Surface, init: HingeInit, opts: HingeOptions): HingeResult {
  const steps = opts.steps ?? 6, cap = opts.cap ?? 0.004
  const stride = Math.max(1, Math.ceil(concave.length / (opts.maxSamples ?? 110)))
  // 每个采样点：位置、静止时指向凸侧骨面的单位方向、静止间隙
  // per sample: position, unit direction to the convex surface at rest, rest gap
  const P: V3[] = [], N: V3[] = [], G: number[] = []
  for (let i = 0; i < concave.length; i += stride) {
    const p = concave[i]!.p
    const c = convex.closest(p, 0.02)
    if (!c || c.distance < 1e-6) continue
    P.push(p)
    N.push(mul(sub(c.point, p), 1 / c.distance))
    G.push(c.distance)
  }
  const d0 = norm(init.dir)
  const u = norm(cross(d0, Math.abs(d0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
  const v = cross(d0, u)
  const angles: number[] = []
  for (let k = 0; k <= steps; k++) {
    const a = rad(opts.sweep[0] + ((opts.sweep[1] - opts.sweep[0]) * k) / steps)
    if (Math.abs(a) > 1e-6) angles.push(opts.invert ? -a : a)
  }
  const wd = (opts.dirWeight ?? 0.0003) / rad(10), wp = (opts.posWeight ?? 0.0003) / 0.005
  const axisOf = (x: number[]): { point: V3; dir: V3 } => ({
    dir: norm(add(d0, add(mul(u, x[0]!), mul(v, x[1]!)))),
    point: add(init.point, add(mul(u, x[2]!), mul(v, x[3]!))),
  })
  const gapError = (x: number[]): number => {
    const { point, dir } = axisOf(x)
    let e = 0, n = 0
    for (const a of angles) {
      const R = axisAngle(dir, a)
      for (let i = 0; i < P.length; i++) {
        const p = add(point, m3apply(R, sub(P[i]!, point)))
        const nn = m3apply(R, N[i]!)
        const c = convex.closest(p, 0.03)
        const g = c ? dot(sub(c.point, p), nn) : 0.03
        const r = Math.min(cap, Math.abs(g - G[i]!))
        e += r * r
        n++
      }
    }
    return n ? e / n : 0
  }
  const cost = (x: number[]): number => gapError(x) + (wd * Math.hypot(x[0]!, x[1]!)) ** 2 + (wp * Math.hypot(x[2]!, x[3]!)) ** 2
  if (P.length < 8 || !angles.length) return { point: init.point, dir: d0, rms: 0, rmsInit: 0, turned: 0, shifted: 0, samples: P.length }
  const zero = [0, 0, 0, 0]
  let res = nelderMead(cost, zero, [0.08, 0.08, 0.002, 0.002], opts.maxEvals ?? 160)
  // 多起点：轴位置的初值不可靠时（如粗网格上的滑车中心），从若干偏移处重新出发，取最好的
  // multi-start: where the initial position is unreliable (e.g. a trochlear centre from a coarse mesh), restart from offsets and keep the best
  for (const [du, dv] of opts.starts ?? []) {
    const r = nelderMead(cost, [0, 0, du!, dv!], [0.08, 0.08, 0.002, 0.002], opts.maxEvals ?? 160)
    if (r.f < res.f) res = r
  }
  const best = axisOf(res.x)
  return {
    point: best.point,
    dir: best.dir,
    rms: Math.sqrt(gapError(res.x)),
    rmsInit: Math.sqrt(gapError(zero)),
    turned: Math.acos(Math.min(1, dot(best.dir, d0))),
    shifted: len(sub(best.point, init.point)),
    samples: P.length,
  }
}
