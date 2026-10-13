// 有界最小二乘：静力优化的求解器。纯数值，无依赖。
// Bounded least squares: the solver behind the static optimisation. Pure numerics, no dependencies.
//
// 问题 / Problem
//     minimise   Σ_i c_i·x_i²  +  Σ_j w_j·(τ_j − Σ_i A_ji·x_i)²        0 ≤ x_i ≤ u_i
//   x_i 是肌肉激活度，A_ji = Fmax_i · r_ij 是肌肉 i 满激活时在自由度 j 上的力矩（N·m），τ_j 是要求的力矩。
//   第二项就是"备用执行器"：自由度 j 上肌肉给不出的那部分（残差）以很大的权重 w_j 计入代价，
//   所以只有肌肉确实给不出时才会剩下，而剩下多少会报告出来。
//   x_i are activations, A_ji = Fmax_i · r_ij is the torque (N·m) muscle i gives at dof j when fully active and
//   τ_j the torque required. The second term is the reserve actuator: what the muscles do not deliver at dof j
//   (the residual) is charged at a large weight w_j, so a residual remains only where muscles really cannot
//   deliver, and its size is reported.
//
// 做法 / Method
//   目标函数严格凸（c_i > 0），解唯一。用活动集牛顿法：每一轮先按梯度的符号定出哪些变量是自由的（不在边界上，或梯度
//   指向可行域内），在自由变量上精确求解牛顿步，再沿这个方向做投影线搜索（越界的分量截到边界上）。
//   牛顿步不用迭代法：协同肌的列几乎平行，坐标下降在这种问题上收敛极慢；而 Hessian 是"对角 + 低秩"，
//   用 Woodbury 恒等式化成一个行数 × 行数的稠密方程组，Cholesky 一次解出。矩阵按列稀疏存储（一条肌肉只跨几个自由度）。
//   确定性：没有随机数，运算次序固定；迭代到投影梯度很小为止，所以热启动只影响用时，不影响结果（在容差内）。
//   The objective is strictly convex (c_i > 0), so the solution is unique. Solved by an active-set Newton method:
//   each round fixes which variables are free from the sign of the gradient (off the bounds, or the gradient
//   pointing inwards), takes the exact Newton step on the free ones, and runs a projected line search along it
//   (components leaving the box are clamped to the bound). The Newton step uses no iterative method: the columns
//   of synergists are nearly parallel, on which coordinate descent crawls, whereas the Hessian is diagonal plus
//   low rank, and the Woodbury identity turns the step into one dense rows × rows system solved by Cholesky. The
//   matrix is stored sparse by column (a muscle spans few dofs).
//   Deterministic: no random numbers and a fixed order of operations; it iterates until the projected gradient
//   is small, so a warm start changes the time taken, not the result (within tolerance).

export interface BoundedLsq {
  /** 变量数、方程数 / Number of variables and of rows. */
  n: number
  m: number
  /** 按列压缩存储 / Compressed sparse columns: entries of column i are at colStart[i] … colStart[i+1]. */
  colStart: Int32Array
  row: Int32Array
  val: Float64Array
  /** 每个变量的代价系数 c_i（> 0）和上界 u_i / Cost c_i (> 0) and upper bound u_i of every variable. */
  cost: Float64Array
  upper: Float64Array
  /** 每个方程的权重 w_j 和右端 τ_j / Weight w_j and right-hand side τ_j of every row. */
  weight: Float64Array
  rhs: Float64Array
}

export interface SolveStats {
  /** 外层迭代次数与求解的牛顿步数 / Outer iterations and Newton steps solved. */
  outer: number
  cg: number
  /** 结束时投影梯度的最大分量（相对量）/ Largest component of the projected gradient at the end (relative). */
  gradient: number
  converged: boolean
}

export class Workspace {
  g = new Float64Array(0)
  d = new Float64Array(0)
  z = new Float64Array(0)
  diag = new Float64Array(0)
  res = new Float64Array(0)
  tmp = new Float64Array(0)
  free = new Uint8Array(0)
  private mat = new Float64Array(0)
  /** m × m 的稠密工作矩阵 / A dense m × m work matrix. */
  dense(m: number): Float64Array {
    if (this.mat.length < m * m) this.mat = new Float64Array(m * m)
    return this.mat
  }
  ensure(n: number, m: number): void {
    if (this.g.length < n) {
      this.g = new Float64Array(n)
      this.d = new Float64Array(n)
      this.z = new Float64Array(n)
      this.diag = new Float64Array(n)
      this.free = new Uint8Array(n)
    }
    if (this.res.length < m) {
      this.res = new Float64Array(m)
      this.tmp = new Float64Array(m)
    }
  }
}

/** res_j = τ_j − Σ_i A_ji·x_i。 */
function residual(p: BoundedLsq, x: Float64Array, res: Float64Array): void {
  for (let j = 0; j < p.m; j++) res[j] = p.rhs[j]!
  for (let i = 0; i < p.n; i++) {
    const xi = x[i]!
    if (xi === 0) continue
    for (let k = p.colStart[i]!; k < p.colStart[i + 1]!; k++) res[p.row[k]!] = res[p.row[k]!]! - p.val[k]! * xi
  }
}

/** 目标函数值 / The objective. */
export function objective(p: BoundedLsq, x: Float64Array, res: Float64Array): number {
  residual(p, x, res)
  let q = 0
  for (let i = 0; i < p.n; i++) q += p.cost[i]! * x[i]! * x[i]!
  for (let j = 0; j < p.m; j++) q += p.weight[j]! * res[j]! * res[j]!
  return q
}

/** 半梯度 g_i = c_i·x_i − Σ_j w_j·A_ji·res_j（res 须已按 x 算好）/ Half the gradient (res must be current). */
function gradient(p: BoundedLsq, x: Float64Array, res: Float64Array, g: Float64Array): void {
  for (let i = 0; i < p.n; i++) {
    let s = p.cost[i]! * x[i]!
    for (let k = p.colStart[i]!; k < p.colStart[i + 1]!; k++) s -= p.weight[p.row[k]!]! * p.val[k]! * res[p.row[k]!]!
    g[i] = s
  }
}

/**
 * 求解。`x` 既是热启动的初值也是输出（会被截到边界内）；返回统计量，`res` 里留下残差 τ − A·x。
 * Solve. `x` is the warm start and the output (clamped into the bounds first); returns statistics and leaves
 * the residual τ − A·x in `ws.res`.
 */
export function solveBounded(p: BoundedLsq, x: Float64Array, ws: Workspace, opts: { tol?: number; maxOuter?: number } = {}): SolveStats {
  const { n, m } = p
  const tol = opts.tol ?? 1e-6
  const maxOuter = opts.maxOuter ?? 60
  ws.ensure(n, m)
  const { g, d, z, diag, res, tmp, free } = ws
  for (let i = 0; i < n; i++) x[i] = Math.min(p.upper[i]!, Math.max(0, x[i]!))
  // 雅可比预条件：H 的对角线 / Jacobi preconditioner: the diagonal of H
  let scale = 0
  for (let i = 0; i < n; i++) {
    let s = p.cost[i]!
    let b = 0
    for (let k = p.colStart[i]!; k < p.colStart[i + 1]!; k++) {
      s += p.weight[p.row[k]!]! * p.val[k]! * p.val[k]!
      b += p.weight[p.row[k]!]! * p.val[k]! * p.rhs[p.row[k]!]!
    }
    diag[i] = s
    // 梯度的量级：用无约束时单变量解的大小来归一化 / gradient scale: normalised by the size of the single-variable unconstrained solution
    scale = Math.max(scale, Math.abs(b) / s)
  }
  if (scale < 1e-12) scale = 1e-12
  const stats: SolveStats = { outer: 0, cg: 0, gradient: 0, converged: false }
  let q = objective(p, x, res)
  for (let outer = 0; outer < maxOuter; outer++) {
    stats.outer = outer + 1
    gradient(p, x, res, g)
    // 自由变量：不在边界上，或在边界上但梯度指向可行域内 / free: off the bounds, or on a bound with the gradient pointing inwards
    let pg = 0
    let nFree = 0
    for (let i = 0; i < n; i++) {
      const lo = x[i]! <= 0, hi = x[i]! >= p.upper[i]!
      const f = !((lo && g[i]! > 0) || (hi && g[i]! < 0))
      free[i] = f ? 1 : 0
      if (f) {
        nFree++
        // 以对角线归一化后的梯度即"这个变量想走多远" / the gradient over the diagonal is how far this variable wants to move
        pg = Math.max(pg, Math.abs(g[i]!) / diag[i]!)
      }
    }
    stats.gradient = pg / scale
    if (nFree === 0 || pg <= tol * scale) {
      stats.converged = true
      break
    }
    // 在自由变量上精确求解牛顿步 H_FF·d = −g_F。H = C + AᵀWA 是"对角 + 低秩"（秩不超过方程数 m，远小于变量数），
    // 用 Woodbury 恒等式化成一个 m × m 的稠密对称正定方程组：
    //     d = −C⁻¹g + C⁻¹Aᵀ·M⁻¹·A·C⁻¹g,   M = W⁻¹ + A·C⁻¹·Aᵀ   （都只取自由变量的列）
    // The exact Newton step H_FF·d = −g_F on the free variables. H = C + AᵀWA is diagonal plus low rank (rank at
    // most the number of rows m, far fewer than the variables); the Woodbury identity turns it into one dense
    // symmetric positive-definite m × m system (free columns only), as written above.
    const M = ws.dense(m)
    M.fill(0, 0, m * m)
    for (let j = 0; j < m; j++) {
      M[j * m + j] = 1 / p.weight[j]!
      tmp[j] = 0
    }
    for (let i = 0; i < n; i++) {
      if (!free[i]) continue
      const ci = 1 / p.cost[i]!
      const gi = g[i]! * ci
      for (let k = p.colStart[i]!; k < p.colStart[i + 1]!; k++) {
        const rk = p.row[k]!, vk = p.val[k]!
        tmp[rk] = tmp[rk]! + vk * gi
        const vc = vk * ci
        for (let l = p.colStart[i]!; l < p.colStart[i + 1]!; l++) M[rk * m + p.row[l]!] = M[rk * m + p.row[l]!]! + vc * p.val[l]!
      }
    }
    // Cholesky 分解 M = L·Lᵀ（下三角存在 M 里），再解 M·y = A·C⁻¹·g / Cholesky M = L·Lᵀ (L kept in M's lower triangle), then M·y = A·C⁻¹·g
    let ok = true
    for (let a = 0; a < m && ok; a++) {
      for (let b = 0; b <= a; b++) {
        let sum = M[a * m + b]!
        for (let k = 0; k < b; k++) sum -= M[a * m + k]! * M[b * m + k]!
        if (a === b) {
          if (!(sum > 0)) ok = false
          else M[a * m + a] = Math.sqrt(sum)
        } else M[a * m + b] = sum / M[b * m + b]!
      }
    }
    if (ok) {
      for (let a = 0; a < m; a++) {
        let sum = tmp[a]!
        for (let k = 0; k < a; k++) sum -= M[a * m + k]! * tmp[k]!
        tmp[a] = sum / M[a * m + a]!
      }
      for (let a = m - 1; a >= 0; a--) {
        let sum = tmp[a]!
        for (let k = a + 1; k < m; k++) sum -= M[k * m + a]! * tmp[k]!
        tmp[a] = sum / M[a * m + a]!
      }
    }
    for (let i = 0; i < n; i++) {
      if (!free[i]) {
        d[i] = 0
        continue
      }
      let sAy = 0
      if (ok) for (let k = p.colStart[i]!; k < p.colStart[i + 1]!; k++) sAy += p.val[k]! * tmp[p.row[k]!]!
      // 分解失败（数值上不该发生）时退回到按对角线缩放的梯度步 / if the factorisation fails (it should not) fall back to a diagonally scaled gradient step
      d[i] = ok ? (-g[i]! + sAy) / p.cost[i]! : -g[i]! / diag[i]!
    }
    stats.cg++
    // 投影线搜索：x ← clamp(x + α·d)，α 从 1 起折半，直到目标函数下降
    // projected line search: x ← clamp(x + α·d), α halved from 1 until the objective falls
    let alpha = 1
    let accepted = false
    for (let ls = 0; ls < 30; ls++) {
      for (let i = 0; i < n; i++) z[i] = free[i] ? Math.min(p.upper[i]!, Math.max(0, x[i]! + alpha * d[i]!)) : x[i]!
      const qn = objective(p, z, res)
      if (qn < q) {
        for (let i = 0; i < n; i++) x[i] = z[i]!
        q = qn
        accepted = true
        break
      }
      alpha *= 0.5
    }
    if (!accepted) {
      // 数值上已到极小 / numerically at the minimum
      residual(p, x, res)
      stats.converged = true
      break
    }
  }
  residual(p, x, res)
  return stats
}
