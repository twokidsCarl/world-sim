// 布料求解器：XPBD（扩展的基于位置的动力学），小步长（Macklin 等 2019，“Small Steps in Physics Simulation”）。
// 纯 TypeScript，不碰 DOM：离线穿衣（bun）和以后的运行时（Web Worker）用同一份代码。给定同样的输入，结果逐位相同。
// The cloth solver: XPBD (extended position-based dynamics) with small steps (Macklin et al. 2019,
// "Small Steps in Physics Simulation"). Pure TypeScript with no DOM: offline dressing (bun) and the
// later runtime (a Web Worker) share this code. The same input gives bit-identical results.
//
// 约束 / Constraints
//   · 各向异性拉伸 / 剪切：每个三角形的变形梯度 F = [f_u f_v]（u = 纬向 / 横列，v = 经向 / 纵行，
//     由裁片坐标给出）。三个约束 |f_u| − 1、|f_v| − 1、f_u·f_v，能量 ½·k·A·C²，k 是膜刚度（N/m），
//     柔度 α = 1 / (k·A)。
//     Anisotropic stretch / shear: per triangle the deformation gradient F = [f_u f_v] (u = weft /
//     course, v = warp / wale, from the pattern coordinates). Three constraints |f_u| − 1, |f_v| − 1
//     and f_u·f_v, energy ½·k·A·C², k the membrane stiffness (N/m), compliance α = 1 / (k·A).
//   · 弯曲：等距弯曲模型（Bergou 等 2006，“A Quadratic Bending Model for Inextensible Surfaces”）。
//     每条内边一个四点模板，h = Σ K_i x_i 是离散平均曲率向量，能量 ½·(B / (A₀ + A₁))·|h|²（Bergou 的 3/(A₀ + A₁)
//     对应的是另一种平均曲率的约定：按它算，均匀弯成圆筒的布片弯曲能是板理论 ½·B·κ²·A 的 2.8 倍，见 tests/cloth-solver.test.ts），
//     B 是弯曲刚度（N·m）；静止形状是平的裁片。h 对位置是线性的，三个分量共用一个分母。
//     Bending: the isometric bending model (Bergou et al. 2006). One four-point stencil per interior
//     edge, h = Σ K_i x_i the discrete mean-curvature vector, energy ½·(B / (A₀ + A₁))·|h|² (Bergou's 3/(A₀ + A₁)
//     belongs to another convention for mean curvature: with it a sheet bent evenly into a cylinder had 2.8 times the
//     plate-theory energy ½·B·κ²·A, see tests/cloth-solver.test.ts), B the
//     bending rigidity (N·m); the rest shape is the flat panel. h is linear in the positions, so its
//     three components share one denominator.
//   · 缝合：成对顶点的距离约束，目标长度可以逐步收到 0（“缝起来”）。
//     Stitches: distance constraints between vertex pairs; the target length can shrink to 0 ("sewing").
//   · 长程附着（Kim 等 2012，“Long Range Attachments”）：顶点到锚点的距离不超过给定值（单边）。
//     Long-range attachments (Kim et al. 2012): a vertex stays within a given distance of its anchor (unilateral).
//   · 碰撞：外部碰撞体（见 collider.ts）和布料自碰撞（见 selfcollide.ts）。
//     Collisions: external colliders (see collider.ts) and cloth self-collision (see selfcollide.ts).

import { SelfCollision } from './selfcollide.ts'

/** 三维长度（比 Math.hypot 快得多，热循环里用）/ A 3-D length (much faster than Math.hypot; used in hot loops). */
function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z)
}

/** 求解器用的面料力学参数（国际单位制）/ The fabric mechanics the solver uses (SI units). */
export interface FabricMechanics {
  /** 面密度 kg/m² / Areal density kg/m². */
  density: number
  /** 经向（v）拉伸膜刚度 N/m / Warp (v) membrane stiffness N/m. */
  stretchWarp: number
  /** 纬向（u）拉伸膜刚度 N/m / Weft (u) membrane stiffness N/m. */
  stretchWeft: number
  /** 面内剪切刚度 N/m（每弧度剪切角）/ In-plane shear stiffness N/m (per radian of shear angle). */
  shear: number
  /** 弯曲刚度 N·m（单位宽度的弯矩 / 曲率）/ Bending rigidity N·m (moment per width per curvature). */
  bending: number
  /** 厚度 m：碰撞时与皮肤保持的距离、渲染偏移 / Thickness m: kept from the skin in collisions, render offset. */
  thickness: number
  /** 与皮肤的库仑摩擦系数 / Coulomb friction coefficient against the skin. */
  friction: number
}

export interface ClothSetup {
  /** 起始位置（米）/ Initial positions (metres), n × 3. */
  positions: ArrayLike<number>
  /** 裁片坐标（米），u = 纬向，v = 经向 / Pattern coordinates (metres), u = weft, v = warp; n × 2. */
  uv: ArrayLike<number>
  triangles: ArrayLike<number>
  /** 每个顶点所在的裁片 / The panel each vertex belongs to. */
  panel?: ArrayLike<number>
  /** 缝合顶点对 / Stitched vertex pairs, flat. */
  stitches?: ArrayLike<number>
  /**
   * 每个三角形角的裁片坐标（三角形数 × 3 × 2）；给了就不用 uv。缝线两边焊成一个顶点后，这个顶点在两片里的裁片坐标不同，
   * 只能按角给。
   * Pattern coordinates per triangle corner (triangles × 3 × 2); when given, `uv` is not used. Once the two sides of a
   * seam are welded into one vertex, that vertex has different pattern coordinates in its two panels, so they can only
   * be given per corner.
   */
  cornerUv?: ArrayLike<number>
  fabric: FabricMechanics
}

export interface Collider {
  /**
   * 把落在表面以内（含 margin）的粒子推出去，并施加摩擦。`prev` 是本子步开始时的位置。
   * Push particles within `margin` of the surface back out and apply friction. `prev` holds the
   * positions at the start of this substep.
   */
  resolve(x: Float64Array, prev: Float64Array, w: Float64Array, margin: number, friction: number): void
}

export interface StepOptions {
  /** 重力 m/s² / Gravity m/s². */
  gravity: [number, number, number]
  /** 每帧子步数 / Substeps per frame. */
  substeps: number
  /** 速度阻尼（1/s）/ Velocity damping (1/s). */
  damping: number
  /** 速度上限（m/s），防止穿透；缺省不限 / Speed limit (m/s) against tunnelling; none by default. */
  maxSpeed?: number
  /** 每个子步里约束迭代几遍（缺省 1，小步长的做法）/ Constraint iterations per substep (default 1, as small steps prescribe). */
  iterations?: number
}

export const DEFAULT_STEP: StepOptions = { gravity: [0, -9.81, 0], substeps: 20, damping: 0.5 }

/** 三角形面积（二维）/ Area of a 2-D triangle. */
function area2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return 0.5 * ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))
}

/** 两向量夹角的余切 / Cotangent of the angle between two vectors (2-D). */
function cot2(ax: number, ay: number, bx: number, by: number): number {
  const c = ax * bx + ay * by
  const s = Math.abs(ax * by - ay * bx)
  return c / Math.max(s, 1e-12)
}

export class ClothSolver {
  readonly n: number
  readonly x: Float64Array
  readonly v: Float64Array
  readonly prev: Float64Array
  /** 逆质量（0 = 固定）/ Inverse mass (0 = pinned). */
  readonly w: Float64Array
  readonly mass: Float64Array
  readonly uv: Float64Array
  readonly tri: Uint32Array
  readonly panel: Int32Array
  fabric: FabricMechanics

  // 三角形：f_u = Σ a_k x_k，f_v = Σ b_k x_k / triangles: f_u = Σ a_k x_k, f_v = Σ b_k x_k
  private readonly triA: Float64Array
  private readonly triB: Float64Array
  readonly triArea: Float64Array

  // 弯曲模板 / bending stencils
  readonly hinge: Uint32Array
  private readonly hingeK: Float64Array
  /** 每个模板的 A₀ + A₁ / A₀ + A₁ of each stencil. */
  private readonly hingeArea: Float64Array

  // 缝合 / stitches
  stitches: Uint32Array
  /** 缝合目标长度（米），所有缝合对共用 / Stitch target length (metres), shared by all pairs. */
  stitchLength = 0
  /** 每对缝合各自的目标长度（给了就不用 stitchLength）/ A target length per pair (overrides stitchLength when set). */
  stitchRest: Float64Array | null = null
  /** 缝合柔度（m/N）/ Stitch compliance (m/N). */
  stitchCompliance = 1e-7

  // 长程附着：顶点、锚点、最大距离 / long-range attachments: vertex, anchor, maximum distance
  tetherV = new Uint32Array(0)
  tetherA = new Uint32Array(0)
  tetherL = new Float64Array(0)

  // 固定到目标位置的顶点（例如测试里夹住的边）/ vertices held at a target position (e.g. clamped edges in tests)
  pinTarget: Float64Array | null = null

  colliders: Collider[] = []
  /** 与碰撞体保持的距离（米），缺省为面料厚度 / Distance kept from colliders (m); defaults to the fabric thickness. */
  collisionMargin: number
  self: SelfCollision | null = null

  /** 是否解各类约束（穿衣的不同阶段会关掉一些）/ Whether each constraint kind is solved (dressing phases turn some off). */
  enable = { stretch: true, bend: true, stitch: true, tether: true, collide: true, self: true }
  /** 拉伸刚度倍率（穿衣初期放软）/ Stretch stiffness multiplier (softened early in dressing). */
  stretchScale = 1
  frame = 0

  constructor(setup: ClothSetup) {
    const n = setup.positions.length / 3
    this.n = n
    this.fabric = { ...setup.fabric }
    this.collisionMargin = setup.fabric.thickness
    this.x = Float64Array.from(setup.positions)
    this.prev = Float64Array.from(setup.positions)
    this.v = new Float64Array(n * 3)
    this.uv = Float64Array.from(setup.uv)
    this.tri = Uint32Array.from(setup.triangles)
    this.panel = setup.panel ? Int32Array.from(setup.panel) : new Int32Array(n)
    this.stitches = Uint32Array.from(setup.stitches ?? [])
    const nt = this.tri.length / 3
    this.triA = new Float64Array(nt * 3)
    this.triB = new Float64Array(nt * 3)
    this.triArea = new Float64Array(nt)
    this.mass = new Float64Array(n)
    const uv = this.uv
    const cu = setup.cornerUv ?? null
    // 三角形 t 第 k 个角的裁片坐标 / pattern coordinates of corner k of triangle t
    const cuv = (t: number, k: number, c: 0 | 1): number => (cu ? cu[(t * 3 + k) * 2 + c]! : uv[this.tri[t * 3 + k]! * 2 + c]!)
    for (let t = 0; t < nt; t++) {
      const i0 = this.tri[t * 3]!, i1 = this.tri[t * 3 + 1]!, i2 = this.tri[t * 3 + 2]!
      const u0 = cuv(t, 0, 0), v0 = cuv(t, 0, 1)
      const du1 = cuv(t, 1, 0) - u0, dv1 = cuv(t, 1, 1) - v0
      const du2 = cuv(t, 2, 0) - u0, dv2 = cuv(t, 2, 1) - v0
      // Dm = [[du1 du2],[dv1 dv2]]，F = Ds · Dm⁻¹ / F = Ds · Dm⁻¹
      const det = du1 * dv2 - du2 * dv1
      const inv = 1 / det
      // Dm⁻¹ = [[dv2, -du2], [-dv1, du1]] / det
      const m00 = dv2 * inv, m01 = -du2 * inv, m10 = -dv1 * inv, m11 = du1 * inv
      // f_u = (x1−x0)·m00 + (x2−x0)·m10；f_v = (x1−x0)·m01 + (x2−x0)·m11
      this.triA[t * 3 + 1] = m00
      this.triA[t * 3 + 2] = m10
      this.triA[t * 3] = -m00 - m10
      this.triB[t * 3 + 1] = m01
      this.triB[t * 3 + 2] = m11
      this.triB[t * 3] = -m01 - m11
      const a = Math.abs(det) / 2
      this.triArea[t] = a
      const m = (a * this.fabric.density) / 3
      this.mass[i0] = this.mass[i0]! + m
      this.mass[i1] = this.mass[i1]! + m
      this.mass[i2] = this.mass[i2]! + m
    }
    this.w = new Float64Array(n)
    for (let i = 0; i < n; i++) this.w[i] = this.mass[i]! > 0 ? 1 / this.mass[i]! : 0

    // 内边 → 两个三角形 / interior edge → its two triangles
    const edgeTri = new Map<number, number>()
    const hinges: number[] = []
    const ks: number[] = []
    const areas: number[] = []
    for (let t = 0; t < nt; t++) {
      for (let k = 0; k < 3; k++) {
        const a = this.tri[t * 3 + k]!, b = this.tri[t * 3 + ((k + 1) % 3)]!
        const key = a < b ? a * n + b : b * n + a
        const other = edgeTri.get(key)
        if (other === undefined) {
          edgeTri.set(key, t * 3 + k)
          continue
        }
        const t2 = Math.floor(other / 3)
        const c = this.tri[t * 3 + ((k + 2) % 3)]!
        let d = -1
        for (let q = 0; q < 3; q++) {
          const v = this.tri[t2 * 3 + q]!
          if (v !== a && v !== b) d = v
        }
        if (d < 0) continue
        // 模板 (x0, x1) 为公共边，x2、x3 为对顶点；余切按各自三角形的裁片坐标（静止为平面；焊起来的缝两边各用各的）
        // stencil: (x0, x1) the shared edge, x2 and x3 the opposite vertices; cotangents from each triangle's own pattern
        // coordinates (flat at rest; across a welded seam each side uses its own)
        const p = (tt: number, v: number): [number, number] => {
          for (let q = 0; q < 3; q++) if (this.tri[tt * 3 + q] === v) return [cuv(tt, q, 0), cuv(tt, q, 1)]
          return [0, 0]
        }
        const [x0, y0] = p(t, a), [x1, y1] = p(t, b), [x2, y2] = p(t, c)
        const [z0, w0] = p(t2, a), [z1, w1] = p(t2, b), [x3, y3] = p(t2, d)
        const c01 = cot2(x1 - x0, y1 - y0, x2 - x0, y2 - y0)
        const c02 = cot2(z1 - z0, w1 - w0, x3 - z0, y3 - w0)
        const c03 = cot2(x0 - x1, y0 - y1, x2 - x1, y2 - y1)
        const c04 = cot2(z0 - z1, w0 - w1, x3 - z1, y3 - w1)
        hinges.push(a, b, c, d)
        ks.push(c03 + c04, c01 + c02, -c01 - c03, -c02 - c04)
        const A0 = Math.abs(area2(x0, y0, x1, y1, x2, y2)), A1 = Math.abs(area2(z0, w0, z1, w1, x3, y3))
        areas.push(A0 + A1)
      }
    }
    this.hinge = Uint32Array.from(hinges)
    this.hingeK = Float64Array.from(ks)
    this.hingeArea = Float64Array.from(areas)
  }

  /** 固定顶点 i（逆质量 0），可选目标位置 / Pin vertex i (inverse mass 0), optionally at a target. */
  pin(i: number, target?: [number, number, number]): void {
    this.w[i] = 0
    if (target) {
      if (!this.pinTarget) this.pinTarget = new Float64Array(this.n * 3).fill(NaN)
      this.pinTarget[i * 3] = target[0]
      this.pinTarget[i * 3 + 1] = target[1]
      this.pinTarget[i * 3 + 2] = target[2]
      this.x[i * 3] = target[0]
      this.x[i * 3 + 1] = target[1]
      this.x[i * 3 + 2] = target[2]
    }
  }

  setTethers(v: ArrayLike<number>, anchor: ArrayLike<number>, length: ArrayLike<number>): void {
    this.tetherV = Uint32Array.from(v)
    this.tetherA = Uint32Array.from(anchor)
    this.tetherL = Float64Array.from(length)
  }

  /** 推进一帧（dt 秒，分成 substeps 个子步）/ Advance one frame (dt seconds in `substeps` substeps). */
  step(dt: number, opt: StepOptions = DEFAULT_STEP): void {
    const h = dt / opt.substeps
    const { x, v, prev, w } = this
    const n = this.n
    const [gx, gy, gz] = opt.gravity
    const keep = Math.max(0, 1 - opt.damping * h)
    const vmax = opt.maxSpeed ?? Infinity
    for (let s = 0; s < opt.substeps; s++) {
      for (let i = 0; i < n; i++) {
        const k = i * 3
        prev[k] = x[k]!
        prev[k + 1] = x[k + 1]!
        prev[k + 2] = x[k + 2]!
        if (w[i] === 0) continue
        v[k] = v[k]! + gx * h
        v[k + 1] = v[k + 1]! + gy * h
        v[k + 2] = v[k + 2]! + gz * h
        x[k] = x[k]! + v[k]! * h
        x[k + 1] = x[k + 1]! + v[k + 1]! * h
        x[k + 2] = x[k + 2]! + v[k + 2]! * h
      }
      const h2 = h * h
      for (let it = 0; it < (opt.iterations ?? 1); it++) {
        if (this.enable.stretch) this.solveStretch(h2)
        if (this.enable.bend && this.fabric.bending > 0) this.solveBending(h2)
        if (this.enable.stitch && this.stitches.length) this.solveStitches(h2)
        if (this.enable.tether && this.tetherV.length) this.solveTethers()
        if (this.pinTarget) this.solvePins()
        if (this.enable.collide) for (const c of this.colliders) c.resolve(x, prev, w, this.collisionMargin, this.fabric.friction)
        if (this.enable.self && this.self) this.self.solve(x, prev, w)
      }
      const ih = 1 / h
      for (let i = 0; i < n; i++) {
        const k = i * 3
        if (w[i] === 0) {
          v[k] = v[k + 1] = v[k + 2] = 0
          continue
        }
        v[k] = (x[k]! - prev[k]!) * ih * keep
        v[k + 1] = (x[k + 1]! - prev[k + 1]!) * ih * keep
        v[k + 2] = (x[k + 2]! - prev[k + 2]!) * ih * keep
        const sp = len3(v[k]!, v[k + 1]!, v[k + 2]!)
        if (sp > vmax) {
          const c = vmax / sp
          v[k] = v[k]! * c
          v[k + 1] = v[k + 1]! * c
          v[k + 2] = v[k + 2]! * c
        }
      }
    }
    this.frame++
  }

  private solveStretch(h2: number): void {
    const { x, w, tri, triA, triB, triArea } = this
    const nt = tri.length / 3
    const ku = this.fabric.stretchWeft * this.stretchScale, kv = this.fabric.stretchWarp * this.stretchScale, ks = this.fabric.shear * this.stretchScale
    const fu = [0, 0, 0], fv = [0, 0, 0]
    const idx = [0, 0, 0]
    for (let t = 0; t < nt; t++) {
      idx[0] = tri[t * 3]!
      idx[1] = tri[t * 3 + 1]!
      idx[2] = tri[t * 3 + 2]!
      const A = triArea[t]!
      for (let pass = 0; pass < 3; pass++) {
        fu[0] = fu[1] = fu[2] = fv[0] = fv[1] = fv[2] = 0
        for (let q = 0; q < 3; q++) {
          const p = idx[q]! * 3, a = triA[t * 3 + q]!, b = triB[t * 3 + q]!
          fu[0] += a * x[p]!
          fu[1] += a * x[p + 1]!
          fu[2] += a * x[p + 2]!
          fv[0] += b * x[p]!
          fv[1] += b * x[p + 1]!
          fv[2] += b * x[p + 2]!
        }
        let C: number, k: number
        // 梯度 ∇_q C = g_q · dir（dir 是三维向量，g_q 是标量系数）/ gradient ∇_q C = g_q · dir
        let dx: number, dy: number, dz: number
        let ex = 0, ey = 0, ez = 0
        let useTwo = false
        if (pass < 2) {
          const f = pass === 0 ? fu : fv
          const L = len3(f[0]!, f[1]!, f[2]!)
          if (L < 1e-12) continue
          C = L - 1
          dx = f[0]! / L
          dy = f[1]! / L
          dz = f[2]! / L
          k = pass === 0 ? ku : kv
        } else {
          // 剪切：C = f_u·f_v，∇_q C = a_q f_v + b_q f_u / shear: C = f_u·f_v, ∇_q C = a_q f_v + b_q f_u
          C = fu[0]! * fv[0]! + fu[1]! * fv[1]! + fu[2]! * fv[2]!
          dx = fv[0]!
          dy = fv[1]!
          dz = fv[2]!
          ex = fu[0]!
          ey = fu[1]!
          ez = fu[2]!
          useTwo = true
          k = ks
        }
        if (k <= 0) continue
        const alpha = 1 / (k * A * h2)
        let denom = alpha
        for (let q = 0; q < 3; q++) {
          const wq = w[idx[q]!]!
          if (wq === 0) continue
          let gx: number, gy: number, gz: number
          if (useTwo) {
            const a = triA[t * 3 + q]!, b = triB[t * 3 + q]!
            gx = a * dx + b * ex
            gy = a * dy + b * ey
            gz = a * dz + b * ez
          } else {
            const g = pass === 0 ? triA[t * 3 + q]! : triB[t * 3 + q]!
            gx = g * dx
            gy = g * dy
            gz = g * dz
          }
          denom += wq * (gx * gx + gy * gy + gz * gz)
        }
        if (denom <= 0) continue
        const dl = -C / denom
        for (let q = 0; q < 3; q++) {
          const i = idx[q]!, wq = w[i]!
          if (wq === 0) continue
          let gx: number, gy: number, gz: number
          if (useTwo) {
            const a = triA[t * 3 + q]!, b = triB[t * 3 + q]!
            gx = a * dx + b * ex
            gy = a * dy + b * ey
            gz = a * dz + b * ez
          } else {
            const g = pass === 0 ? triA[t * 3 + q]! : triB[t * 3 + q]!
            gx = g * dx
            gy = g * dy
            gz = g * dz
          }
          const p = i * 3
          x[p] = x[p]! + wq * dl * gx
          x[p + 1] = x[p + 1]! + wq * dl * gy
          x[p + 2] = x[p + 2]! + wq * dl * gz
        }
      }
    }
  }

  private solveBending(h2: number): void {
    const { x, w, hinge, hingeK, hingeArea } = this
    const B = this.fabric.bending
    const nh = hinge.length / 4
    for (let e = 0; e < nh; e++) {
      let hx = 0, hy = 0, hz = 0, denom = 0
      for (let q = 0; q < 4; q++) {
        const i = hinge[e * 4 + q]!, K = hingeK[e * 4 + q]!
        hx += K * x[i * 3]!
        hy += K * x[i * 3 + 1]!
        hz += K * x[i * 3 + 2]!
        denom += w[i]! * K * K
      }
      // 刚度 B / (A₀ + A₁) = B / hingeArea；柔度取倒数 / stiffness B / (A₀ + A₁) = B / hingeArea; compliance is its inverse
      const alpha = hingeArea[e]! / (B * h2)
      denom += alpha
      if (denom <= 0) continue
      const s = -1 / denom
      for (let q = 0; q < 4; q++) {
        const i = hinge[e * 4 + q]!, wq = w[i]!
        if (wq === 0) continue
        const c = s * wq * hingeK[e * 4 + q]!
        x[i * 3] = x[i * 3]! + c * hx
        x[i * 3 + 1] = x[i * 3 + 1]! + c * hy
        x[i * 3 + 2] = x[i * 3 + 2]! + c * hz
      }
    }
  }

  private solveStitches(h2: number): void {
    const { x, w, stitches } = this
    const alpha = this.stitchCompliance / h2
    const rest = this.stitchRest
    for (let s = 0; s < stitches.length; s += 2) {
      const a = stitches[s]!, b = stitches[s + 1]!
      const L0 = rest ? rest[s >> 1]! : this.stitchLength
      const wa = w[a]!, wb = w[b]!
      const ws = wa + wb
      if (ws === 0) continue
      const dx = x[a * 3]! - x[b * 3]!, dy = x[a * 3 + 1]! - x[b * 3 + 1]!, dz = x[a * 3 + 2]! - x[b * 3 + 2]!
      const L = len3(dx, dy, dz)
      if (L <= L0 || L < 1e-12) continue
      const dl = -(L - L0) / (ws + alpha)
      const nx = dx / L, ny = dy / L, nz = dz / L
      x[a * 3] = x[a * 3]! + wa * dl * nx
      x[a * 3 + 1] = x[a * 3 + 1]! + wa * dl * ny
      x[a * 3 + 2] = x[a * 3 + 2]! + wa * dl * nz
      x[b * 3] = x[b * 3]! - wb * dl * nx
      x[b * 3 + 1] = x[b * 3 + 1]! - wb * dl * ny
      x[b * 3 + 2] = x[b * 3 + 2]! - wb * dl * nz
    }
  }

  private solveTethers(): void {
    const { x, w, tetherV, tetherA, tetherL } = this
    for (let t = 0; t < tetherV.length; t++) {
      const i = tetherV[t]!, a = tetherA[t]!
      if (w[i] === 0) continue
      const dx = x[i * 3]! - x[a * 3]!, dy = x[i * 3 + 1]! - x[a * 3 + 1]!, dz = x[i * 3 + 2]! - x[a * 3 + 2]!
      const L = len3(dx, dy, dz)
      const max = tetherL[t]!
      if (L <= max) continue
      const s = (L - max) / L
      x[i * 3] = x[i * 3]! - dx * s
      x[i * 3 + 1] = x[i * 3 + 1]! - dy * s
      x[i * 3 + 2] = x[i * 3 + 2]! - dz * s
    }
  }

  private solvePins(): void {
    const t = this.pinTarget!
    for (let i = 0; i < this.n; i++) {
      if (Number.isNaN(t[i * 3]!)) continue
      this.x[i * 3] = t[i * 3]!
      this.x[i * 3 + 1] = t[i * 3 + 1]!
      this.x[i * 3 + 2] = t[i * 3 + 2]!
    }
  }

  /**
   * 能量（焦耳）：动能、重力势能（相对 y = 0）、拉伸 / 剪切、弯曲。验证用。
   * Energy (joules): kinetic, gravitational (relative to y = 0), stretch / shear and bending. For checks.
   */
  energy(gravity = 9.81): { kinetic: number; potential: number; stretch: number; bend: number; total: number } {
    const { x, v, mass, tri, triA, triB, triArea, hinge, hingeK, hingeArea } = this
    let kinetic = 0, potential = 0, stretch = 0, bend = 0
    for (let i = 0; i < this.n; i++) {
      if (this.w[i] === 0) continue
      kinetic += 0.5 * mass[i]! * (v[i * 3]! ** 2 + v[i * 3 + 1]! ** 2 + v[i * 3 + 2]! ** 2)
      potential += mass[i]! * gravity * x[i * 3 + 1]!
    }
    const f = this.fabric
    for (let t = 0; t < tri.length / 3; t++) {
      const fu = [0, 0, 0], fv = [0, 0, 0]
      for (let q = 0; q < 3; q++) {
        const p = tri[t * 3 + q]! * 3
        for (let d = 0; d < 3; d++) {
          fu[d] = fu[d]! + triA[t * 3 + q]! * x[p + d]!
          fv[d] = fv[d]! + triB[t * 3 + q]! * x[p + d]!
        }
      }
      const cu = len3(fu[0]!, fu[1]!, fu[2]!) - 1, cv = len3(fv[0]!, fv[1]!, fv[2]!) - 1
      const cs = fu[0]! * fv[0]! + fu[1]! * fv[1]! + fu[2]! * fv[2]!
      stretch += 0.5 * triArea[t]! * (f.stretchWeft * cu * cu + f.stretchWarp * cv * cv + f.shear * cs * cs)
    }
    for (let e = 0; e < hinge.length / 4; e++) {
      let hx = 0, hy = 0, hz = 0
      for (let q = 0; q < 4; q++) {
        const i = hinge[e * 4 + q]!, K = hingeK[e * 4 + q]!
        hx += K * x[i * 3]!
        hy += K * x[i * 3 + 1]!
        hz += K * x[i * 3 + 2]!
      }
      bend += (0.5 * f.bending * (hx * hx + hy * hy + hz * hz)) / hingeArea[e]!
    }
    return { kinetic, potential, stretch, bend, total: kinetic + potential + stretch + bend }
  }

  /** 每个三角形的经、纬向应变（|f| − 1）/ Warp and weft strain (|f| − 1) of every triangle. */
  strains(): { weft: Float64Array; warp: Float64Array } {
    const { x, tri, triA, triB } = this
    const nt = tri.length / 3
    const weft = new Float64Array(nt), warp = new Float64Array(nt)
    for (let t = 0; t < nt; t++) {
      let ux = 0, uy = 0, uz = 0, vx = 0, vy = 0, vz = 0
      for (let q = 0; q < 3; q++) {
        const p = tri[t * 3 + q]! * 3, a = triA[t * 3 + q]!, b = triB[t * 3 + q]!
        ux += a * x[p]!
        uy += a * x[p + 1]!
        uz += a * x[p + 2]!
        vx += b * x[p]!
        vy += b * x[p + 1]!
        vz += b * x[p + 2]!
      }
      weft[t] = len3(ux, uy, uz) - 1
      warp[t] = len3(vx, vy, vz) - 1
    }
    return { weft, warp }
  }

  /** 缝合对之间的最大距离（米）/ The largest distance between stitched pairs (metres). */
  maxStitchGap(): number {
    let m = 0
    const { x, stitches } = this
    for (let s = 0; s < stitches.length; s += 2) {
      const a = stitches[s]! * 3, b = stitches[s + 1]! * 3
      m = Math.max(m, len3(x[a]! - x[b]!, x[a + 1]! - x[b + 1]!, x[a + 2]! - x[b + 2]!))
    }
    return m
  }
}
