// 软组织的 XPBD 求解器：CPU 参考实现。纯函数式的数据（类型化数组），没有依赖，同样的输入给出同样的输出。
// The XPBD solver for soft tissue: the CPU reference. Plain typed arrays, no dependencies, the same input gives the same output.
//
// ── 本构 / Constitutive model ────────────────────────────────────────────────────────────────
// 能量是 Smith 等 2018 的"稳定 neo-Hookean"不带对数项的那一种（Macklin & Müller 2021 用的也是它），减去静止时的常数：
// The energy is the "stable neo-Hookean" of Smith et al. 2018 without the logarithmic term (the one Macklin & Müller
// 2021 use as well), minus its constant at rest:
//     Ψ = μ/2·(I_C − 3) + λ′/2·(J − γ)² − μ²/(2λ′),   I_C = tr(FᵀF), J = det F, γ = 1 + μ/λ′, λ′ = λ + μ
// 在 F = I 附近线性化得 Ψ ≈ μ·ε:ε + λ/2·(tr ε)²：μ、λ 就是线弹性的 Lamé 常数，由 E、ν 换算
// （μ = E / (2(1+ν))，λ = Eν / ((1+ν)(1−2ν))）。参数因此是物理量，不是调出来的刚度。
// Linearised about F = I this is Ψ ≈ μ·ε:ε + λ/2·(tr ε)²: μ and λ are the Lamé constants of linear elasticity, from
// E and ν (μ = E / (2(1+ν)), λ = Eν / ((1+ν)(1−2ν))). Parameters are therefore physical quantities, not tuned stiffnesses.
//
// 为什么选这个能量：F 翻转（J < 0）时能量和梯度仍然有定义，压得很深也不会出 NaN。
// Why this energy: energy and gradient stay defined when F inverts (J < 0), so a deep press cannot produce NaN.
//
// 约束形式——同一个能量，换一种拆法（恒等变形，不是近似）：
// The constraints: the same energy, split differently (an identity, not an approximation):
//     Ψ = μ/2·C_D² + λ/2·C_H²,    C_D² = I_C + J² − 4J,    C_H = J − 1
//     C_D 柔度 compliance 1/(μ·V)，C_H 柔度 compliance 1/(λ·V)
//   · 两条约束在静止时都为零；C_D² = t²(t−1)²(t²+2t+3) + (I_C − 3J^{2/3}) ≥ 0（t = J^{1/3}，J > 0 时），所以开方有定义。
//     线性化 C_D² ≈ 2·ε:ε：C_D 管形状，C_H 管体积；近不可压时 λ 很大，C_H 接近硬约束，XPBD 正擅长这个。
//   · C_D 用"能量约束"的写法求解，不必开方：Δx_i = −w_i·g_i·C_D² / (Σ_j w_j‖g_j‖² + C_D²/(μ·V·h²))，
//     g_i = ∂(C_D²/2)/∂x_i，∂(C_D²/2)/∂F = F + (J − 2)·cof F。步长小时这是弹性力的显式积分（力精确）；
//     步长大时是把 C_D 投影到零的一步，静止形状对任何步长和刚度都是精确的不动点。
//   · 肌肉另加纤维约束 C_f = ‖F·d‖ − 1，柔度 1/(k_f·V)：沿纤维比横向多出 k_f 的模量。
//   · both constraints vanish at rest; C_D² = t²(t−1)²(t²+2t+3) + (I_C − 3J^{2/3}) ≥ 0 (t = J^{1/3}, for J > 0), so the
//     root exists. Linearised, C_D² ≈ 2·ε:ε: C_D governs shape and C_H volume; near incompressibility λ is large and
//     C_H approaches a hard constraint, which is what XPBD is good at.
//   · C_D is solved as an "energy constraint", without the root (formula above, g_i = ∂(C_D²/2)/∂x_i,
//     ∂(C_D²/2)/∂F = F + (J − 2)·cof F). With a small step this is the explicit integration of the elastic force (the
//     force is exact); with a large step it is a projection of C_D to zero, and the rest shape is an exact fixed point
//     for any step and stiffness.
//   · muscles get a fibre constraint C_f = ‖F·d‖ − 1 with compliance 1/(k_f·V): an extra modulus k_f along the fibre.
// 没有直接采用 Macklin & Müller 的拆法（C_D = ‖F‖、C_H = J − γ）：那里 C_D 在静止时不为零（= √3），步长大或材料硬时
// 每一步都想把四面体压到零。本项目两种都试过：那种拆法在 h²·μ·V·w‖∇C‖² ≳ 1 时发散；把整个 Ψ 当成一条能量约束
// 则在近不可压时收敛很差（软硬两种模态混在一条约束里）。
// The split of Macklin & Müller (C_D = ‖F‖, C_H = J − γ) was not adopted as is: there C_D is not zero at rest (= √3),
// so with a long step or a stiff material every step tries to shrink the tetrahedron to nothing. Both were tried here:
// that split diverged once h²·μ·V·w‖∇C‖² ≳ 1, and the whole Ψ as a single energy constraint converged poorly near
// incompressibility (stiff and soft modes mixed in one constraint).
//
// ── 时间积分 / Time integration ──────────────────────────────────────────────────────────────
// 小步长 XPBD（Macklin 等 2019）：一帧分成 n 个子步，每个子步只做一遍 Gauss–Seidel。每个子步里 λ 从零开始，
// 所以约束的作用等价于一个隐式的弹性力；稳态时位置不再变化，力平衡成立。
// Small-step XPBD (Macklin et al. 2019): a frame is cut into n substeps with a single Gauss–Seidel sweep each. λ starts
// at zero in every substep, so a constraint acts as an implicit elastic force; at steady state positions stop changing
// and the forces balance.
//
// ── 参考构形随骨架移动 / The reference configuration moves with the skeleton ────────────────────
// 弹性的参考构形不是静止姿势的笼子，而是**此刻蒙皮后的笼子** `ref`（每帧由调用者给出）：F = Ds(x)·Dm(ref)⁻¹。
// 位置 x 和速度 v 是世界坐标里的真实状态，有惯性。于是：
//   · 姿势静止、没有外载时 x = ref 是精确的平衡，修正位移 x − ref 恒为零，不会漂移；
//   · 姿势快速变化时，被钉住的结点立刻跟到 ref，自由结点因惯性落后，弹性力再把它们拉回去——这就是滞后和抖动；
//   · 蒙皮本身引起的变形（关节处的弯折）不产生弹性应力，物理不与蒙皮对抗，只在它上面加修正。
// 阻尼作用在相对于参考构形速度的那部分速度上，所以跟着骨架的整体运动不被阻尼。
// The elastic reference is not the rest-pose cage but **the cage as skinned right now**, `ref` (given by the caller every
// frame): F = Ds(x)·Dm(ref)⁻¹. Position x and velocity v are the true world-space state and have inertia. Hence:
//   · with a static pose and no extra load x = ref is an exact equilibrium, the corrective displacement x − ref stays
//     zero and nothing drifts;
//   · in a fast pose change the pinned nodes follow ref at once, free nodes lag by inertia and elastic forces pull them
//     back: that is the lag and the jiggle;
//   · deformation due to skinning itself (the bend at a joint) produces no elastic stress: the physics does not fight
//     the skinning, it only adds a correction on top.
// Damping acts on the velocity relative to the reference's velocity, so moving along with the skeleton is not damped.
//
// ── 重力 / Gravity ───────────────────────────────────────────────────────────────────────────
// 发布的网格已经是站立、受重力时的平衡形状。两种做法，都在这里：
//   · 预应力（缺省）：每个结点的体力取 m·(g − R·g₀)，g₀ 是建模时的重力，R 是该结点随骨架的转动。站立静止时
//     体力恰好为零，一毫米也不动；换姿势时只施加重力的**变化量**。这相当于把站立时的重力应力当作已经存在的
//     预应力，并假设刚度不因它改变——应变小的地方成立，乳房这类大变形处是近似。
//   · 零重力参考形状（rest.ts 的反解）：参考构形换成反解出来的无重力形状，体力是完整的 m·g。
// The shipped meshes already are the standing, gravity-loaded equilibrium. Two ways, both here:
//   · pre-stress (default): the body force of a node is m·(g − R·g₀), g₀ being gravity at modelling time and R the
//     node's rotation with the skeleton. Standing still the body force is exactly zero and nothing moves; a change of
//     posture applies only the **change** of gravity. This treats the standing gravity stress as an existing pre-stress
//     and assumes it does not alter the stiffness: true where strains are small, an approximation for the breast.
//   · zero-gravity reference (the inverse solve in rest.ts): the reference is the unloaded shape and the body force is
//     the full m·g.

export type Vec3 = [number, number, number]

export interface PointSet {
  /** 每个点所在的四面体 / the tetrahedron of every point */
  tet: Uint32Array
  /** 每个点 4 个重心坐标 / four barycentric coordinates per point */
  bary: Float32Array
}

export type ProbeShape =
  /** 球形压头 / spherical indenter */
  | { kind: 'sphere'; center: Vec3; radius: number }
  /** 平头圆柱压头：`center` 是端面中心，`axis` 是压入方向（单位向量）/ flat-ended cylinder: `center` is the centre of the end face, `axis` the unit direction of pressing */
  | { kind: 'flat'; center: Vec3; axis: Vec3; radius: number }

export interface Probe {
  shape: ProbeShape
  /** 可能接触的表面点（嵌在笼子里的皮肤顶点）/ the surface points that may touch (skin vertices embedded in the cage) */
  points: PointSet
  /**
   * 力控：压头沿 `axis` 以导纳方式移动，速度 = admittance·(target − 当前反力)，稳态时反力等于 target（牛顿）。
   * 省略则为位移控制：调用者自己移动 shape.center。
   * Force control: the probe moves along `axis` by admittance, velocity = admittance·(target − present reaction); at
   * steady state the reaction equals target (newtons). Omitted = displacement control: the caller moves shape.center.
   */
  control?: { target: number; admittance: number; axis: Vec3 }
}

export interface Plane {
  /** 单位法线，指向允许的一侧 / unit normal, pointing to the allowed side */
  n: Vec3
  /** n·p ≥ d */
  d: number
  points: PointSet
}

export interface Capsule {
  a: Vec3
  b: Vec3
  radius: number
}

export interface SolverInput {
  /** 发布时的笼子结点（静止姿势），扁平 xyz，米 / the cage nodes as shipped (rest pose), flat xyz, metres */
  nodes: ArrayLike<number>
  tets: Uint32Array
  /** 每个四面体的线性剪切模量 μ 和 Lamé λ，帕 / per tetrahedron linear shear modulus μ and Lamé λ, Pa */
  mu: ArrayLike<number>
  lambda: ArrayLike<number>
  /** 每个四面体的密度，kg/m³ / per tetrahedron density */
  density: ArrayLike<number>
  /** 每个结点：非零 = 运动学结点（钉在骨上），跟随参考构形 / per node: non-zero = kinematic (pinned to bone), follows the reference */
  pinned: ArrayLike<number>
  /** 每个四面体的纤维方向（静止姿势，单位向量；全零 = 没有）/ per tetrahedron fibre direction (rest pose, unit; all zero = none) */
  fibre?: ArrayLike<number>
  /** 每个四面体沿纤维方向额外的模量，帕 / per tetrahedron extra modulus along the fibre, Pa */
  fibreModulus?: ArrayLike<number>
  /** 每个四面体属于哪条肌肉（激活量数组的下标），−1 = 无 / per tetrahedron the muscle it belongs to (index into the activations), −1 = none */
  muscle?: ArrayLike<number>
  /** 每个四面体：激活量为 1 时 μ 乘以这个倍数 / per tetrahedron: μ is multiplied by this at activation 1 */
  activeStiffening?: ArrayLike<number>
  /** 嵌入式锚点：四面体内的一点跟随参考构形（骨穿过、但没有结点落在骨内的四面体）/ embedded anchors: a point inside a tetrahedron follows the reference (tetrahedra crossed by bone without a node inside it) */
  anchors?: PointSet
}

export interface SolverOptions {
  /** 每帧的子步数 / substeps per frame */
  substeps?: number
  /** 重力加速度，m/s² / gravity, m/s² */
  gravity?: Vec3
  /** 预应力所抵消的建模时重力；null = 不用预应力（参考构形是无重力形状）/ modelling-time gravity cancelled by the pre-stress; null = none (the reference is the unloaded shape) */
  prestressGravity?: Vec3 | null
  /** 相对速度的衰减率，1/s / decay rate of the relative velocity, 1/s */
  damping?: number
  /** 激活量为 1 时纤维方向静止长度缩短的比例（假设）/ fraction by which the rest length along the fibre shortens at activation 1 (an assumption) */
  activeStrain?: number
}

const det3 = (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number): number => a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)

export class SoftSolver {
  readonly nodeCount: number
  readonly tetCount: number
  readonly tets: Uint32Array
  /** 世界坐标里的位置和速度 / world-space positions and velocities */
  readonly x: Float64Array
  readonly v: Float64Array
  /** 弹性参考构形（此刻蒙皮后的笼子）/ the elastic reference (the cage as skinned now) */
  readonly ref: Float64Array
  /** 结点质量，kg；运动学结点的逆质量为零 / node masses, kg; kinematic nodes have zero inverse mass */
  readonly mass: Float64Array
  readonly invMass: Float64Array
  /** 四面体的静止体积（发布时的笼子），m³ / rest volume of every tetrahedron (cage as shipped), m³ */
  readonly restVolume: Float64Array
  /** 外加的结点力，牛（调用者可写）/ external nodal forces, N (the caller may write) */
  readonly force: Float64Array
  /** 每个结点随骨架的转动（行主序 3×3），用于预应力；null = 单位阵 / per-node rotation with the skeleton (row-major 3×3), for the pre-stress; null = identity */
  rotations: Float32Array | Float64Array | null = null
  gravity: Vec3
  prestressGravity: Vec3 | null
  substeps: number
  damping: number
  activeStrain: number
  probe: Probe | null = null
  planes: Plane[] = []
  /** 骨的胶囊代理及各自要检查的结点 / capsule proxies of bones with the nodes each one checks */
  capsules: { capsule: Capsule; nodes: Uint32Array }[] = []
  /** 上一帧里压头受到的平均反力，牛 / mean reaction on the probe over the last frame, N */
  readonly probeForce: Vec3 = [0, 0, 0]
  /** 上一帧里各接触点的平均法向力，牛（与 probe.points 对应）/ mean normal force of every contact point over the last frame, N (aligned with probe.points) */
  probePointForce: Float32Array = new Float32Array(0)
  /** 上一帧里各支撑面受到的平均法向力，牛 / mean normal force on every plane over the last frame, N */
  planeForce: number[] = []

  private readonly p: Float64Array
  private readonly refPrev: Float64Array
  private readonly rest: Float64Array
  private readonly mu: Float64Array
  private readonly lam: Float64Array
  private readonly B0: Float64Array
  private readonly B: Float64Array
  private readonly fibre0: Float64Array | null
  private readonly fibre: Float64Array | null
  private readonly fibreK: Float64Array | null
  private readonly muscle: Int32Array | null
  private readonly stiffen: Float64Array | null
  private readonly active: Uint32Array
  private readonly anchors: PointSet | null
  private readonly actScale: Float64Array
  private activation: Float32Array | null = null
  private dirty = true
  private started = false
  private readonly pinned: Uint8Array

  constructor(input: SolverInput, opts: SolverOptions = {}) {
    const n = (this.nodeCount = input.nodes.length / 3)
    const t = (this.tetCount = input.tets.length / 4)
    this.tets = input.tets
    this.rest = Float64Array.from(input.nodes)
    this.x = Float64Array.from(input.nodes)
    this.ref = Float64Array.from(input.nodes)
    this.refPrev = Float64Array.from(input.nodes)
    this.p = new Float64Array(n * 3)
    this.v = new Float64Array(n * 3)
    this.force = new Float64Array(n * 3)
    this.mass = new Float64Array(n)
    this.invMass = new Float64Array(n)
    this.restVolume = new Float64Array(t)
    this.mu = Float64Array.from(input.mu)
    this.lam = Float64Array.from(input.lambda)
    this.B0 = new Float64Array(t * 9)
    this.B = new Float64Array(t * 9)
    this.actScale = new Float64Array(t).fill(1)
    this.pinned = Uint8Array.from(input.pinned, (q) => (q ? 1 : 0))
    this.gravity = opts.gravity ?? [0, -9.81, 0]
    this.prestressGravity = opts.prestressGravity === undefined ? null : opts.prestressGravity
    this.substeps = opts.substeps ?? 10
    this.damping = opts.damping ?? 0
    this.activeStrain = opts.activeStrain ?? 0.3
    this.anchors = input.anchors && input.anchors.tet.length ? input.anchors : null
    this.inverseRest(this.rest, this.B0)
    const live: number[] = []
    for (let e = 0; e < t; e++) {
      const a = this.tets[e * 4]!, b = this.tets[e * 4 + 1]!, c = this.tets[e * 4 + 2]!, d = this.tets[e * 4 + 3]!
      const r = this.rest
      const vol = det3(r[b * 3]! - r[a * 3]!, r[c * 3]! - r[a * 3]!, r[d * 3]! - r[a * 3]!, r[b * 3 + 1]! - r[a * 3 + 1]!, r[c * 3 + 1]! - r[a * 3 + 1]!, r[d * 3 + 1]! - r[a * 3 + 1]!, r[b * 3 + 2]! - r[a * 3 + 2]!, r[c * 3 + 2]! - r[a * 3 + 2]!, r[d * 3 + 2]! - r[a * 3 + 2]!) / 6
      if (!(vol > 0)) throw new Error(`softbody: tetrahedron ${e} has non-positive volume ${vol}`)
      this.restVolume[e] = vol
      const m = (input.density[e]! * vol) / 4
      this.mass[a] = this.mass[a]! + m
      this.mass[b] = this.mass[b]! + m
      this.mass[c] = this.mass[c]! + m
      this.mass[d] = this.mass[d]! + m
      // 四个结点都是运动学结点、或没有刚度的四面体不参与求解 / tetrahedra with four kinematic nodes or no stiffness are not solved
      if (this.mu[e]! > 0 && !(this.pinned[a] && this.pinned[b] && this.pinned[c] && this.pinned[d])) live.push(e)
    }
    this.active = Uint32Array.from(live)
    for (let i = 0; i < n; i++) this.invMass[i] = this.pinned[i] || !(this.mass[i]! > 0) ? 0 : 1 / this.mass[i]!
    let anyFibre = false
    if (input.fibre) for (let i = 0; i < input.fibre.length; i++) if (input.fibre[i] !== 0) anyFibre = true
    this.fibre0 = anyFibre ? Float64Array.from(input.fibre!) : null
    this.fibre = anyFibre ? Float64Array.from(input.fibre!) : null
    this.fibreK = anyFibre && input.fibreModulus ? Float64Array.from(input.fibreModulus) : null
    this.muscle = input.muscle ? Int32Array.from(input.muscle) : null
    this.stiffen = input.activeStiffening ? Float64Array.from(input.activeStiffening) : null
  }

  /** 是否为运动学结点 / whether a node is kinematic */
  isPinned(i: number): boolean {
    return this.pinned[i] === 1
  }

  /** Dm⁻¹（行主序）写入 out；Dm 的列是 x1−x0、x2−x0、x3−x0。 Dm⁻¹ (row-major) into out; the columns of Dm are x1−x0, x2−x0, x3−x0. */
  private inverseRest(pos: Float64Array, out: Float64Array): void {
    const T = this.tets
    for (let e = 0; e < this.tetCount; e++) {
      const a = T[e * 4]! * 3, b = T[e * 4 + 1]! * 3, c = T[e * 4 + 2]! * 3, d = T[e * 4 + 3]! * 3
      const m00 = pos[b]! - pos[a]!, m01 = pos[c]! - pos[a]!, m02 = pos[d]! - pos[a]!
      const m10 = pos[b + 1]! - pos[a + 1]!, m11 = pos[c + 1]! - pos[a + 1]!, m12 = pos[d + 1]! - pos[a + 1]!
      const m20 = pos[b + 2]! - pos[a + 2]!, m21 = pos[c + 2]! - pos[a + 2]!, m22 = pos[d + 2]! - pos[a + 2]!
      const c00 = m11 * m22 - m12 * m21, c01 = m12 * m20 - m10 * m22, c02 = m10 * m21 - m11 * m20
      const det = m00 * c00 + m01 * c01 + m02 * c02
      const inv = Math.abs(det) > 1e-30 ? 1 / det : 0
      const o = e * 9
      out[o] = c00 * inv
      out[o + 1] = (m02 * m21 - m01 * m22) * inv
      out[o + 2] = (m01 * m12 - m02 * m11) * inv
      out[o + 3] = c01 * inv
      out[o + 4] = (m00 * m22 - m02 * m20) * inv
      out[o + 5] = (m02 * m10 - m00 * m12) * inv
      out[o + 6] = c02 * inv
      out[o + 7] = (m01 * m20 - m00 * m21) * inv
      out[o + 8] = (m00 * m11 - m01 * m10) * inv
    }
  }

  /**
   * 给出这一帧结束时的参考构形（蒙皮后的笼子，或它的无重力形状）。运动学结点在子步里从上一帧的参考线性走到这里。
   * 第一次调用（或 teleport = true）时不产生速度：状态直接放到参考构形上。
   * Gives the reference at the end of this frame (the skinned cage, or its unloaded shape). Kinematic nodes travel
   * linearly from the previous reference to this one over the substeps. The first call (or teleport = true) creates no
   * velocity: the state is put on the reference.
   */
  setReference(ref: ArrayLike<number>, teleport = false): void {
    if (ref.length !== this.ref.length) throw new Error(`softbody: reference has ${ref.length / 3} nodes, the cage has ${this.nodeCount}`)
    if (!this.started || teleport) {
      // 保留相对于参考构形的位移 / keep the displacement relative to the reference
      for (let i = 0; i < ref.length; i++) {
        const u = this.started ? this.x[i]! - this.ref[i]! : 0
        this.ref[i] = ref[i]!
        this.refPrev[i] = ref[i]!
        this.x[i] = ref[i]! + u
      }
      this.started = true
    } else {
      this.ref.set(ref as ArrayLike<number>)
    }
    this.dirty = true
  }

  /** 每条肌肉的激活量 0–1（下标与 SolverInput.muscle 一致）/ activation 0–1 of every muscle (indexed as SolverInput.muscle) */
  setActivation(act: Float32Array | null): void {
    this.activation = act
    this.dirty = true
  }

  /** 把状态放回参考构形，速度清零 / puts the state back on the reference with zero velocity */
  reset(): void {
    this.x.set(this.ref)
    this.refPrev.set(this.ref)
    this.v.fill(0)
  }

  /**
   * 由参考构形和激活量更新每个四面体的 B = Dm(ref)⁻¹·A⁻¹。
   * 肌肉激活 = 静止形状沿纤维缩短到 a = 1 − activeStrain·激活量，横向放大 1/√a（体积不变）：
   *     A = a·ddᵀ + (I − ddᵀ)/√a,   A⁻¹ = √a·I + (1/a − √a)·ddᵀ,   弹性变形 F_e = F·A⁻¹
   * Updates B = Dm(ref)⁻¹·A⁻¹ of every tetrahedron from the reference and the activations.
   * Muscle activation = the rest shape shortens along the fibre to a = 1 − activeStrain·activation and widens by 1/√a
   * across it (volume kept); the elastic deformation is F_e = F·A⁻¹.
   */
  private prepare(): void {
    if (!this.dirty) return
    this.dirty = false
    this.inverseRest(this.ref, this.B)
    const f0 = this.fibre0, f = this.fibre
    if (!f0 || !f) return
    const T = this.tets, r = this.ref, B0 = this.B0, B = this.B
    for (let e = 0; e < this.tetCount; e++) {
      const dx = f0[e * 3]!, dy = f0[e * 3 + 1]!, dz = f0[e * 3 + 2]!
      if (dx === 0 && dy === 0 && dz === 0) continue
      // 纤维方向随参考构形转动：d = F_ref·d₀，F_ref = Dm(ref)·Dm(rest)⁻¹
      // the fibre direction turns with the reference: d = F_ref·d₀, F_ref = Dm(ref)·Dm(rest)⁻¹
      const a = T[e * 4]! * 3, b = T[e * 4 + 1]! * 3, c = T[e * 4 + 2]! * 3, d = T[e * 4 + 3]! * 3
      const o = e * 9
      const q0 = B0[o]! * dx + B0[o + 1]! * dy + B0[o + 2]! * dz
      const q1 = B0[o + 3]! * dx + B0[o + 4]! * dy + B0[o + 5]! * dz
      const q2 = B0[o + 6]! * dx + B0[o + 7]! * dy + B0[o + 8]! * dz
      let fx = (r[b]! - r[a]!) * q0 + (r[c]! - r[a]!) * q1 + (r[d]! - r[a]!) * q2
      let fy = (r[b + 1]! - r[a + 1]!) * q0 + (r[c + 1]! - r[a + 1]!) * q1 + (r[d + 1]! - r[a + 1]!) * q2
      let fz = (r[b + 2]! - r[a + 2]!) * q0 + (r[c + 2]! - r[a + 2]!) * q1 + (r[d + 2]! - r[a + 2]!) * q2
      const l = Math.hypot(fx, fy, fz) || 1
      fx /= l
      fy /= l
      fz /= l
      f[e * 3] = fx
      f[e * 3 + 1] = fy
      f[e * 3 + 2] = fz
      const mi = this.muscle ? this.muscle[e]! : -1
      const act = mi >= 0 && this.activation ? Math.min(1, Math.max(0, this.activation[mi] ?? 0)) : 0
      this.actScale[e] = 1 + act * ((this.stiffen ? this.stiffen[e]! : 1) - 1)
      if (act === 0) continue
      const s = 1 - this.activeStrain * act
      const k0 = Math.sqrt(s), k1 = 1 / s - k0
      // B ← B·A⁻¹ = k0·B + k1·(B·d)·dᵀ
      for (let row = 0; row < 3; row++) {
        const bd = B[o + row * 3]! * fx + B[o + row * 3 + 1]! * fy + B[o + row * 3 + 2]! * fz
        B[o + row * 3] = k0 * B[o + row * 3]! + k1 * bd * fx
        B[o + row * 3 + 1] = k0 * B[o + row * 3 + 1]! + k1 * bd * fy
        B[o + row * 3 + 2] = k0 * B[o + row * 3 + 2]! + k1 * bd * fz
      }
    }
  }

  /** 四面体的约束 C_D、C_H、C_f，一遍 Gauss–Seidel（公式见文件头）。 The constraints C_D, C_H, C_f of every tetrahedron, one Gauss–Seidel sweep (formulas in the header). */
  private solveTets(h: number): void {
    const T = this.tets, x = this.x, w = this.invMass, B = this.B, V = this.restVolume
    const ih2 = 1 / (h * h)
    const fib = this.fibre, fk = this.fibreK
    const act = this.active
    for (let k = 0; k < act.length; k++) {
      const e = act[k]!
      const i0 = T[e * 4]!, i1 = T[e * 4 + 1]!, i2 = T[e * 4 + 2]!, i3 = T[e * 4 + 3]!
      const a = i0 * 3, b = i1 * 3, c = i2 * 3, d = i3 * 3
      const w0 = w[i0]!, w1 = w[i1]!, w2 = w[i2]!, w3 = w[i3]!
      const o = e * 9
      const b00 = B[o]!, b01 = B[o + 1]!, b02 = B[o + 2]!, b10 = B[o + 3]!, b11 = B[o + 4]!, b12 = B[o + 5]!, b20 = B[o + 6]!, b21 = B[o + 7]!, b22 = B[o + 8]!
      const vol = V[e]!
      // 激活时 μ 和 λ 乘同一个倍数：泊松比不变，体积照样守恒 / activation scales μ and λ alike: the Poisson ratio stays and volume is kept as before
      const mu = this.mu[e]! * this.actScale[e]!, la = this.lam[e]! * this.actScale[e]!
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1 && !(la > 0)) break
        const d00 = x[b]! - x[a]!, d01 = x[c]! - x[a]!, d02 = x[d]! - x[a]!
        const d10 = x[b + 1]! - x[a + 1]!, d11 = x[c + 1]! - x[a + 1]!, d12 = x[d + 1]! - x[a + 1]!
        const d20 = x[b + 2]! - x[a + 2]!, d21 = x[c + 2]! - x[a + 2]!, d22 = x[d + 2]! - x[a + 2]!
        // F = Ds·B
        const f00 = d00 * b00 + d01 * b10 + d02 * b20, f01 = d00 * b01 + d01 * b11 + d02 * b21, f02 = d00 * b02 + d01 * b12 + d02 * b22
        const f10 = d10 * b00 + d11 * b10 + d12 * b20, f11 = d10 * b01 + d11 * b11 + d12 * b21, f12 = d10 * b02 + d11 * b12 + d12 * b22
        const f20 = d20 * b00 + d21 * b10 + d22 * b20, f21 = d20 * b01 + d21 * b11 + d22 * b21, f22 = d20 * b02 + d21 * b12 + d22 * b22
        // ∂J/∂F = cof F
        const h00 = f11 * f22 - f12 * f21, h01 = f12 * f20 - f10 * f22, h02 = f10 * f21 - f11 * f20
        const h10 = f02 * f21 - f01 * f22, h11 = f00 * f22 - f02 * f20, h12 = f01 * f20 - f00 * f21
        const h20 = f01 * f12 - f02 * f11, h21 = f02 * f10 - f00 * f12, h22 = f00 * f11 - f01 * f10
        const J = f00 * h00 + f01 * h01 + f02 * h02
        let p00: number, p01: number, p02: number, p10: number, p11: number, p12: number, p20: number, p21: number, p22: number
        let c2: number, comp: number
        if (pass === 0) {
          // C_D：P = F + (J − 2)·cof F，"C²" = I_C + J² − 4J
          c2 = f00 * f00 + f01 * f01 + f02 * f02 + f10 * f10 + f11 * f11 + f12 * f12 + f20 * f20 + f21 * f21 + f22 * f22 + J * J - 4 * J
          if (!(c2 > 0)) continue
          const q = J - 2
          p00 = f00 + q * h00; p01 = f01 + q * h01; p02 = f02 + q * h02
          p10 = f10 + q * h10; p11 = f11 + q * h11; p12 = f12 + q * h12
          p20 = f20 + q * h20; p21 = f21 + q * h21; p22 = f22 + q * h22
          comp = (c2 * ih2) / (mu * vol)
        } else {
          // C_H = J − 1：P = cof F；写成同一个更新式时 "C²" 换成 C、柔度项是 α̃
          // C_H = J − 1: P = cof F; in the same update form "C²" becomes C and the compliance term α̃
          c2 = J - 1
          if (c2 === 0) continue
          p00 = h00; p01 = h01; p02 = h02
          p10 = h10; p11 = h11; p12 = h12
          p20 = h20; p21 = h21; p22 = h22
          comp = ih2 / (la * vol)
        }
        // 结点 k 的梯度 = P·(B 的第 k−1 行)ᵀ / gradient of node k = P·(row k−1 of B)ᵀ
        const g1x = p00 * b00 + p01 * b01 + p02 * b02, g1y = p10 * b00 + p11 * b01 + p12 * b02, g1z = p20 * b00 + p21 * b01 + p22 * b02
        const g2x = p00 * b10 + p01 * b11 + p02 * b12, g2y = p10 * b10 + p11 * b11 + p12 * b12, g2z = p20 * b10 + p21 * b11 + p22 * b12
        const g3x = p00 * b20 + p01 * b21 + p02 * b22, g3y = p10 * b20 + p11 * b21 + p12 * b22, g3z = p20 * b20 + p21 * b21 + p22 * b22
        const g0x = -g1x - g2x - g3x, g0y = -g1y - g2y - g3y, g0z = -g1z - g2z - g3z
        const den = w0 * (g0x * g0x + g0y * g0y + g0z * g0z) + w1 * (g1x * g1x + g1y * g1y + g1z * g1z) + w2 * (g2x * g2x + g2y * g2y + g2z * g2z) + w3 * (g3x * g3x + g3y * g3y + g3z * g3z) + comp
        if (!(den > 1e-300)) continue
        const l = -c2 / den
        x[a] = x[a]! + w0 * l * g0x
        x[a + 1] = x[a + 1]! + w0 * l * g0y
        x[a + 2] = x[a + 2]! + w0 * l * g0z
        x[b] = x[b]! + w1 * l * g1x
        x[b + 1] = x[b + 1]! + w1 * l * g1y
        x[b + 2] = x[b + 2]! + w1 * l * g1z
        x[c] = x[c]! + w2 * l * g2x
        x[c + 1] = x[c + 1]! + w2 * l * g2y
        x[c + 2] = x[c + 2]! + w2 * l * g2z
        x[d] = x[d]! + w3 * l * g3x
        x[d + 1] = x[d + 1]! + w3 * l * g3y
        x[d + 2] = x[d + 2]! + w3 * l * g3z
      }
      // 纤维约束 C_f = ‖F·d‖ − 1 / the fibre constraint
      if (fib && fk && fk[e]! > 0) {
        const dx = fib[e * 3]!, dy = fib[e * 3 + 1]!, dz = fib[e * 3 + 2]!
        if (dx !== 0 || dy !== 0 || dz !== 0) {
          // s_k = (B 的第 k 行)·d，F·d = Ds·s / s_k = (row k of B)·d, F·d = Ds·s
          const s1 = b00 * dx + b01 * dy + b02 * dz, s2 = b10 * dx + b11 * dy + b12 * dz, s3 = b20 * dx + b21 * dy + b22 * dz
          let ux = (x[b]! - x[a]!) * s1 + (x[c]! - x[a]!) * s2 + (x[d]! - x[a]!) * s3
          let uy = (x[b + 1]! - x[a + 1]!) * s1 + (x[c + 1]! - x[a + 1]!) * s2 + (x[d + 1]! - x[a + 1]!) * s3
          let uz = (x[b + 2]! - x[a + 2]!) * s1 + (x[c + 2]! - x[a + 2]!) * s2 + (x[d + 2]! - x[a + 2]!) * s3
          const len = Math.hypot(ux, uy, uz)
          if (len > 1e-12) {
            ux /= len
            uy /= len
            uz /= len
            const s0 = -s1 - s2 - s3
            const ws = w0 * s0 * s0 + w1 * s1 * s1 + w2 * s2 * s2 + w3 * s3 * s3
            const dl = -(len - 1) / (ws + ih2 / (fk[e]! * this.actScale[e]! * vol))
            x[a] = x[a]! + w0 * s0 * dl * ux
            x[a + 1] = x[a + 1]! + w0 * s0 * dl * uy
            x[a + 2] = x[a + 2]! + w0 * s0 * dl * uz
            x[b] = x[b]! + w1 * s1 * dl * ux
            x[b + 1] = x[b + 1]! + w1 * s1 * dl * uy
            x[b + 2] = x[b + 2]! + w1 * s1 * dl * uz
            x[c] = x[c]! + w2 * s2 * dl * ux
            x[c + 1] = x[c + 1]! + w2 * s2 * dl * uy
            x[c + 2] = x[c + 2]! + w2 * s2 * dl * uz
            x[d] = x[d]! + w3 * s3 * dl * ux
            x[d + 1] = x[d + 1]! + w3 * s3 * dl * uy
            x[d + 2] = x[d + 2]! + w3 * s3 * dl * uz
          }
        }
      }
    }
  }

  /** 嵌入点此刻的位置 / the present position of an embedded point */
  pointPosition(set: PointSet, i: number, out: number[]): void {
    this.pointAt(set, i, this.x, out)
  }

  /** 嵌入点的位置 Σ bₖ·xₖ / position of an embedded point, Σ bₖ·xₖ */
  private pointAt(set: PointSet, i: number, pos: Float64Array, out: number[]): void {
    const e = set.tet[i]! * 4
    let px = 0, py = 0, pz = 0
    for (let k = 0; k < 4; k++) {
      const n = this.tets[e + k]! * 3, bk = set.bary[i * 4 + k]!
      px += bk * pos[n]!
      py += bk * pos[n + 1]!
      pz += bk * pos[n + 2]!
    }
    out[0] = px
    out[1] = py
    out[2] = pz
  }

  /** 把嵌入点沿 (nx,ny,nz) 移动 c（按逆质量和重心坐标分给四个结点）；返回 Δλ。 Moves an embedded point by c along (nx,ny,nz), shared out to its four nodes by inverse mass and barycentric weight; returns Δλ. */
  private pushPoint(set: PointSet, i: number, nx: number, ny: number, nz: number, c: number): number {
    const e = set.tet[i]! * 4
    let ws = 0
    for (let k = 0; k < 4; k++) {
      const bk = set.bary[i * 4 + k]!
      ws += this.invMass[this.tets[e + k]!]! * bk * bk
    }
    if (!(ws > 0)) return 0
    const dl = c / ws
    for (let k = 0; k < 4; k++) {
      const n = this.tets[e + k]!, s = this.invMass[n]! * set.bary[i * 4 + k]! * dl
      this.x[n * 3] = this.x[n * 3]! + s * nx
      this.x[n * 3 + 1] = this.x[n * 3 + 1]! + s * ny
      this.x[n * 3 + 2] = this.x[n * 3 + 2]! + s * nz
    }
    return dl
  }

  private solveAnchors(tau: number): void {
    const set = this.anchors
    if (!set) return
    const q = [0, 0, 0], r0 = [0, 0, 0], r1 = [0, 0, 0]
    for (let i = 0; i < set.tet.length; i++) {
      this.pointAt(set, i, this.x, q)
      this.pointAt(set, i, this.refPrev, r0)
      this.pointAt(set, i, this.ref, r1)
      const cx = r0[0]! + (r1[0]! - r0[0]!) * tau - q[0]!, cy = r0[1]! + (r1[1]! - r0[1]!) * tau - q[1]!, cz = r0[2]! + (r1[2]! - r0[2]!) * tau - q[2]!
      const l = Math.hypot(cx, cy, cz)
      if (l > 0) this.pushPoint(set, i, cx / l, cy / l, cz / l, l)
    }
  }

  /** 压头、支撑面、骨的胶囊；都是无摩擦的单边约束。 Probe, support planes, bone capsules: all frictionless unilateral constraints. */
  private solveContacts(h: number, acc: { probe: number[]; planes: number[] }): void {
    const q = [0, 0, 0]
    const ih2 = 1 / (h * h)
    const pr = this.probe
    if (pr) {
      const s = pr.shape, set = pr.points
      let fx = 0, fy = 0, fz = 0
      for (let i = 0; i < set.tet.length; i++) {
        this.pointAt(set, i, this.x, q)
        let c = 0, nx = 0, ny = 0, nz = 0
        const rx = q[0]! - s.center[0], ry = q[1]! - s.center[1], rz = q[2]! - s.center[2]
        if (s.kind === 'sphere') {
          const l = Math.hypot(rx, ry, rz)
          if (l >= s.radius || l < 1e-12) continue
          c = s.radius - l
          nx = rx / l
          ny = ry / l
          nz = rz / l
        } else {
          // 圆柱体占据端面之后的一侧（along < 0）；只处理端面，不处理侧壁
          // the cylinder occupies the side behind its end face (along < 0); only the end face is handled, not the side wall
          const along = rx * s.axis[0] + ry * s.axis[1] + rz * s.axis[2]
          if (along >= 0 || along < -4 * s.radius) continue
          const ox = rx - along * s.axis[0], oy = ry - along * s.axis[1], oz = rz - along * s.axis[2]
          if (ox * ox + oy * oy + oz * oz >= s.radius * s.radius) continue
          c = -along
          nx = s.axis[0]
          ny = s.axis[1]
          nz = s.axis[2]
        }
        const f = this.pushPoint(set, i, nx, ny, nz, c) * ih2
        this.probePointForce[i] = this.probePointForce[i]! + f
        fx -= f * nx
        fy -= f * ny
        fz -= f * nz
      }
      acc.probe[0] = acc.probe[0]! + fx
      acc.probe[1] = acc.probe[1]! + fy
      acc.probe[2] = acc.probe[2]! + fz
      if (pr.control) {
        // 导纳控制：反力沿 −axis，取其大小 / admittance control: the reaction points along −axis; take its magnitude
        const a = pr.control.axis
        const fn = -(fx * a[0] + fy * a[1] + fz * a[2])
        const step = h * pr.control.admittance * (pr.control.target - fn)
        s.center[0] += a[0] * step
        s.center[1] += a[1] * step
        s.center[2] += a[2] * step
      }
    }
    for (let p = 0; p < this.planes.length; p++) {
      const pl = this.planes[p]!
      let f = 0
      for (let i = 0; i < pl.points.tet.length; i++) {
        this.pointAt(pl.points, i, this.x, q)
        const c = pl.d - (q[0]! * pl.n[0] + q[1]! * pl.n[1] + q[2]! * pl.n[2])
        if (c > 0) f += this.pushPoint(pl.points, i, pl.n[0], pl.n[1], pl.n[2], c) * ih2
      }
      acc.planes[p] = (acc.planes[p] ?? 0) + f
    }
    const x = this.x
    for (const cp of this.capsules) {
      const { a, b, radius } = cp.capsule
      const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2]
      const l2 = abx * abx + aby * aby + abz * abz || 1
      for (let k = 0; k < cp.nodes.length; k++) {
        const n = cp.nodes[k]! * 3
        const px = x[n]! - a[0], py = x[n + 1]! - a[1], pz = x[n + 2]! - a[2]
        const t = Math.min(1, Math.max(0, (px * abx + py * aby + pz * abz) / l2))
        const rx = px - t * abx, ry = py - t * aby, rz = pz - t * abz
        const dist = Math.hypot(rx, ry, rz)
        // 有效半径不超过该结点在参考构形（此刻蒙皮后的笼子）里到轴线的距离：没有外载时胶囊从不起作用，
        // 静止的姿势下不会凭空产生位移。
        // The effective radius never exceeds the node's distance from the axis in the reference (the cage as skinned
        // now): without a load a capsule is never active, so a static pose gets no displacement out of nothing.
        const qx = this.ref[n]! - a[0], qy = this.ref[n + 1]! - a[1], qz = this.ref[n + 2]! - a[2]
        const tr = Math.min(1, Math.max(0, (qx * abx + qy * aby + qz * abz) / l2))
        const lim = Math.min(radius, 0.999 * Math.hypot(qx - tr * abx, qy - tr * aby, qz - tr * abz))
        if (dist >= lim || dist < 1e-9) continue
        const s = (lim - dist) / dist
        x[n] = x[n]! + rx * s
        x[n + 1] = x[n + 1]! + ry * s
        x[n + 2] = x[n + 2]! + rz * s
      }
    }
  }

  /** 给一个骨的胶囊登记要检查的自由结点（静止时在 radius + margin 之内的）。 Registers the free nodes a bone capsule checks (those within radius + margin at rest). */
  addCapsule(capsule: Capsule, margin = 0.03): void {
    const nodes: number[] = []
    const { a, b, radius } = capsule
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2]
    const l2 = abx * abx + aby * aby + abz * abz || 1
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.invMass[i] === 0) continue
      const px = this.ref[i * 3]! - a[0], py = this.ref[i * 3 + 1]! - a[1], pz = this.ref[i * 3 + 2]! - a[2]
      const t = Math.min(1, Math.max(0, (px * abx + py * aby + pz * abz) / l2))
      const dist = Math.hypot(px - t * abx, py - t * aby, pz - t * abz)
      if (dist > radius + margin) continue
      nodes.push(i)
    }
    this.capsules.push({ capsule, nodes: Uint32Array.from(nodes) })
  }

  /** 前进一帧（dt 秒）。 Advances one frame (dt seconds). */
  step(dt: number): void {
    this.prepare()
    const n = this.substeps, h = dt / n
    const N = this.nodeCount
    const x = this.x, v = this.v, p = this.p, ref = this.ref, r0 = this.refPrev, w = this.invMass
    const keep = Math.exp(-this.damping * h)
    const g = this.gravity, g0 = this.prestressGravity, R = this.rotations
    const acc = { probe: [0, 0, 0], planes: this.planes.map(() => 0) }
    if (this.probe && this.probePointForce.length !== this.probe.points.tet.length) this.probePointForce = new Float32Array(this.probe.points.tet.length)
    this.probePointForce.fill(0)
    for (let s = 1; s <= n; s++) {
      const tau = s / n
      for (let i = 0; i < N; i++) {
        const o = i * 3
        p[o] = x[o]!
        p[o + 1] = x[o + 1]!
        p[o + 2] = x[o + 2]!
        if (w[i] === 0) {
          x[o] = r0[o]! + (ref[o]! - r0[o]!) * tau
          x[o + 1] = r0[o + 1]! + (ref[o + 1]! - r0[o + 1]!) * tau
          x[o + 2] = r0[o + 2]! + (ref[o + 2]! - r0[o + 2]!) * tau
          continue
        }
        let ax = g[0], ay = g[1], az = g[2]
        if (g0) {
          if (R) {
            const q = i * 9
            ax -= R[q]! * g0[0] + R[q + 1]! * g0[1] + R[q + 2]! * g0[2]
            ay -= R[q + 3]! * g0[0] + R[q + 4]! * g0[1] + R[q + 5]! * g0[2]
            az -= R[q + 6]! * g0[0] + R[q + 7]! * g0[1] + R[q + 8]! * g0[2]
          } else {
            ax -= g0[0]
            ay -= g0[1]
            az -= g0[2]
          }
        }
        // 相对于参考构形速度的那部分才被阻尼 / only the velocity relative to the reference's is damped
        const ux = (ref[o]! - r0[o]!) / dt, uy = (ref[o + 1]! - r0[o + 1]!) / dt, uz = (ref[o + 2]! - r0[o + 2]!) / dt
        const vx = ux + (v[o]! - ux) * keep + h * (ax + this.force[o]! * w[i]!)
        const vy = uy + (v[o + 1]! - uy) * keep + h * (ay + this.force[o + 1]! * w[i]!)
        const vz = uz + (v[o + 2]! - uz) * keep + h * (az + this.force[o + 2]! * w[i]!)
        x[o] = x[o]! + h * vx
        x[o + 1] = x[o + 1]! + h * vy
        x[o + 2] = x[o + 2]! + h * vz
      }
      this.solveTets(h)
      this.solveAnchors(tau)
      this.solveContacts(h, acc)
      const ih = 1 / h
      for (let i = 0; i < N * 3; i++) v[i] = (x[i]! - p[i]!) * ih
    }
    r0.set(ref)
    this.probeForce[0] = acc.probe[0]! / n
    this.probeForce[1] = acc.probe[1]! / n
    this.probeForce[2] = acc.probe[2]! / n
    for (let i = 0; i < this.probePointForce.length; i++) this.probePointForce[i] = this.probePointForce[i]! / n
    this.planeForce = acc.planes.map((f) => f / n)
  }

  /** 反复前进直到最大速度低于 tol（m/s）；返回用掉的帧数。静力问题用它。 Steps until the largest speed is below tol (m/s); returns the frames used. For static problems. */
  settle(dt: number, tol = 1e-5, maxFrames = 4000, minFrames = 10): number {
    for (let f = 1; f <= maxFrames; f++) {
      this.step(dt)
      if (f >= minFrames && this.maxSpeed() < tol) return f
    }
    return maxFrames
  }

  maxSpeed(): number {
    let m = 0
    const v = this.v
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.invMass[i] === 0) continue
      const s = v[i * 3]! * v[i * 3]! + v[i * 3 + 1]! * v[i * 3 + 1]! + v[i * 3 + 2]! * v[i * 3 + 2]!
      if (s > m) m = s
    }
    return Math.sqrt(m)
  }

  /** 四面体当前体积之和（可按子集）/ sum of current tetrahedron volumes (optionally of a subset) */
  volume(of?: (tet: number) => boolean, pos: Float64Array = this.x): number {
    let s = 0
    const T = this.tets
    for (let e = 0; e < this.tetCount; e++) {
      if (of && !of(e)) continue
      const a = T[e * 4]! * 3, b = T[e * 4 + 1]! * 3, c = T[e * 4 + 2]! * 3, d = T[e * 4 + 3]! * 3
      s += det3(pos[b]! - pos[a]!, pos[c]! - pos[a]!, pos[d]! - pos[a]!, pos[b + 1]! - pos[a + 1]!, pos[c + 1]! - pos[a + 1]!, pos[d + 1]! - pos[a + 1]!, pos[b + 2]! - pos[a + 2]!, pos[c + 2]! - pos[a + 2]!, pos[d + 2]! - pos[a + 2]!) / 6
    }
    return s
  }

  /** 参考构形的体积（同样的子集）/ volume of the reference (same subset) */
  referenceVolume(of?: (tet: number) => boolean): number {
    return this.volume(of, this.ref)
  }

  /**
   * 能量，焦耳：动能（相对于静止的世界）、弹性能 Σ V·Ψ（不含纤维项）、重力势能（相对于参考构形；预应力模式下用净体力）。
   * Energies in joules: kinetic (against the world at rest), elastic Σ V·Ψ (without the fibre term), gravitational potential (relative
   * to the reference; with pre-stress, of the net body force).
   */
  energy(): { kinetic: number; elastic: number; potential: number; total: number } {
    this.prepare()
    let kin = 0, pot = 0, el = 0
    const x = this.x, v = this.v, T = this.tets, B = this.B
    const g = this.gravity, g0 = this.prestressGravity, R = this.rotations
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.invMass[i] === 0) continue
      const m = this.mass[i]!, o = i * 3
      kin += 0.5 * m * (v[o]! * v[o]! + v[o + 1]! * v[o + 1]! + v[o + 2]! * v[o + 2]!)
      let ax = g[0], ay = g[1], az = g[2]
      if (g0) {
        const q = i * 9
        ax -= R ? R[q]! * g0[0] + R[q + 1]! * g0[1] + R[q + 2]! * g0[2] : g0[0]
        ay -= R ? R[q + 3]! * g0[0] + R[q + 4]! * g0[1] + R[q + 5]! * g0[2] : g0[1]
        az -= R ? R[q + 6]! * g0[0] + R[q + 7]! * g0[1] + R[q + 8]! * g0[2] : g0[2]
      }
      pot -= m * (ax * (x[o]! - this.ref[o]!) + ay * (x[o + 1]! - this.ref[o + 1]!) + az * (x[o + 2]! - this.ref[o + 2]!))
    }
    for (let k = 0; k < this.active.length; k++) {
      const e = this.active[k]!
      const a = T[e * 4]! * 3, b = T[e * 4 + 1]! * 3, c = T[e * 4 + 2]! * 3, d = T[e * 4 + 3]! * 3
      const o = e * 9
      const D = [x[b]! - x[a]!, x[c]! - x[a]!, x[d]! - x[a]!, x[b + 1]! - x[a + 1]!, x[c + 1]! - x[a + 1]!, x[d + 1]! - x[a + 1]!, x[b + 2]! - x[a + 2]!, x[c + 2]! - x[a + 2]!, x[d + 2]! - x[a + 2]!]
      const F: number[] = []
      for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) F.push(D[r * 3]! * B[o + q]! + D[r * 3 + 1]! * B[o + 3 + q]! + D[r * 3 + 2]! * B[o + 6 + q]!)
      const i1 = F.reduce((s, f) => s + f * f, 0)
      const J = det3(F[0]!, F[1]!, F[2]!, F[3]!, F[4]!, F[5]!, F[6]!, F[7]!, F[8]!)
      const mu = this.mu[e]! * this.actScale[e]!, la = this.lam[e]! * this.actScale[e]!
      el += this.restVolume[e]! * (0.5 * mu * (i1 + J * J - 4 * J) + 0.5 * la * (J - 1) * (J - 1))
    }
    return { kinetic: kin, elastic: el, potential: pot, total: kin + el + pot }
  }
}

/** E、ν → 线性剪切模量 μ 和 Lamé λ。 E, ν → linear shear modulus μ and Lamé λ. */
export function lame(young: number, poisson: number): { mu: number; lambda: number } {
  return { mu: young / (2 * (1 + poisson)), lambda: (young * poisson) / ((1 + poisson) * (1 - 2 * poisson)) }
}
