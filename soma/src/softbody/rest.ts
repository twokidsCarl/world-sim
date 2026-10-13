// 零重力参考形状的反解。
// The inverse solve for the zero-gravity reference shape.
//
// 问题：已知受重力 g₀ 时的平衡形状 X_g（发布的网格），求无应力的参考形状 X₀，使得从 X₀ 出发在 g₀ 下的静力解正好是 X_g。
// 做法：Sellier (2011) 的不动点迭代。记 φ(X₀) 为以 X₀ 为参考、在 g₀ 下的静力平衡位置，则
//     X₀ ← X₀ − relax·(φ(X₀) − X_g)
// 每一轮是一次正向静力求解（阻尼下的 XPBD 走到静止）。变形越大收敛越慢；重力使形状接近失稳时不收敛（会报告残差）。
// The problem: given the equilibrium X_g under gravity g₀ (the shipped mesh), find the stress-free reference X₀ whose
// static solution under g₀ is X_g. The method: the fixed-point iteration of Sellier (2011). With φ(X₀) the static
// equilibrium under g₀ for the reference X₀,
//     X₀ ← X₀ − relax·(φ(X₀) − X_g)
// Each round is one forward static solve (damped XPBD run to rest). Convergence slows as deformation grows, and fails
// when gravity brings the shape close to instability (the residual is reported).

import type { SoftSolver } from './solver.ts'

export interface RestOptions {
  /** 最多迭代轮数 / at most this many rounds */
  iterations?: number
  /** 残差（最大结点误差，米）低于它就停 / stop when the residual (largest node error, metres) is below this */
  tolerance?: number
  relax?: number
  /** 正向静力求解：帧长、静止判据、最多帧数 / the forward static solve: frame length, rest criterion, frame cap */
  dt?: number
  speedTolerance?: number
  maxFrames?: number
}

export interface RestResult {
  /** 无重力参考形状（扁平 xyz）/ the unloaded reference (flat xyz) */
  rest: Float64Array
  /** 每轮结束时的残差，米 / the residual after every round, metres */
  residuals: number[]
  converged: boolean
}

/**
 * 求 `solver` 的零重力参考形状。`solver` 应当已经设好重力（= g₀）、阻尼和 prestressGravity = null；`target` 是 X_g。
 * 返回后 solver 的参考构形是 X₀，状态是它在 g₀ 下的平衡（≈ X_g）。
 * Finds the zero-gravity reference of `solver`, which must already have its gravity (= g₀), damping and
 * prestressGravity = null; `target` is X_g. On return the solver's reference is X₀ and its state the equilibrium under
 * g₀ (≈ X_g).
 */
export function solveZeroGravityRest(solver: SoftSolver, target: ArrayLike<number>, opts: RestOptions = {}): RestResult {
  if (solver.prestressGravity) throw new Error('softbody: the inverse solve needs prestressGravity = null')
  const n = solver.nodeCount
  const rest = Float64Array.from(target)
  const residuals: number[] = []
  const tol = opts.tolerance ?? 1e-4, relax = opts.relax ?? 1
  let converged = false
  solver.setReference(rest, true)
  solver.reset()
  for (let it = 0; it < (opts.iterations ?? 12); it++) {
    // 从上一轮的平衡出发（保留位移），不必每次从头下垂 / start from the previous equilibrium (displacement kept) instead of sagging from scratch
    solver.setReference(rest, true)
    solver.v.fill(0)
    solver.settle(opts.dt ?? 1 / 60, opts.speedTolerance ?? 2e-5, opts.maxFrames ?? 3000)
    let worst = 0
    for (let i = 0; i < n; i++) {
      if (solver.isPinned(i)) continue
      const dx = solver.x[i * 3]! - target[i * 3]!, dy = solver.x[i * 3 + 1]! - target[i * 3 + 1]!, dz = solver.x[i * 3 + 2]! - target[i * 3 + 2]!
      worst = Math.max(worst, Math.hypot(dx, dy, dz))
      rest[i * 3] = rest[i * 3]! - relax * dx
      rest[i * 3 + 1] = rest[i * 3 + 1]! - relax * dy
      rest[i * 3 + 2] = rest[i * 3 + 2]! - relax * dz
    }
    residuals.push(worst)
    if (worst < tol) {
      converged = true
      // 这一轮的平衡是在更新之前的参考上得到的：撤回最后一次更新，返回值与残差对应
      // this round's equilibrium belongs to the reference before the update: undo the last update so that the result matches the residual
      for (let i = 0; i < n; i++) {
        if (solver.isPinned(i)) continue
        for (let k = 0; k < 3; k++) rest[i * 3 + k] = rest[i * 3 + k]! + relax * (solver.x[i * 3 + k]! - target[i * 3 + k]!)
      }
      break
    }
  }
  return { rest, residuals, converged }
}
