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

//
// ── 第二阶段加的四样东西 / Four things added in phase 2 ────────────────────────────────────────
// 1. 体积锁死：线性四面体每个单元一条体积约束，BCC 格子里每个结点平均摊到 6 条，而结点只有 3 个自由度，ν → 0.5 时
//    整个网格被锁住。这里把体积约束从"每个四面体"换成"每个结点"（Bonet & Burton 1998 的平均结点压强）：
//        J̄_n = Σ_{e∋n} V_e·J_e / Σ_{e∋n} V_e,   Ψ_vol = Σ_n K_n/2·(J̄_n − 1)²,   K_n = Σ_{e∋n} V_e·λ_e / 4
//    均匀变形时与逐单元的能量相同；约束数从 6N 降到 N。`volumeBlend` 可以留一小部分 λ 在逐单元约束上，
//    压住结点平均带来的棋盘格压强模态。
//    Volumetric locking: linear tetrahedra carry one volume constraint each, six per node in a BCC lattice against
//    three degrees of freedom, so the mesh locks as ν → 0.5. The volume constraint is moved from every tetrahedron
//    to every node (the average nodal pressure of Bonet & Burton 1998, formula above): the same energy for a uniform
//    deformation, N constraints instead of 6N. `volumeBlend` may leave a small share of λ on per-tetrahedron
//    constraints to hold down the checkerboard pressure mode that nodal averaging allows.
// 2. 压强是跨子步保留的未知量：每个子步开始时先把上一步的压强当作力施加，再做一遍 Gauss–Seidel 修正
//        Δλ_n = −(C_n + α̃_n·λ_n) / (Σ w‖∇C_n‖² + α̃_n),   λ_n ← λ_n + Δλ_n
//    不动点处 Δλ_n = 0，即 λ_n = −C_n/α̃_n：压强正好是本构给出的值，与子步长、求解顺序、松弛因子都无关。
//    （每个子步把 λ 清零的做法，在 h²·w‖∇C‖² ≫ α 时稳态偏软，第一阶段的压入力随子步数变三倍就是这个原因。）
//    The pressure is an unknown kept across substeps: a substep first applies the previous pressure as a force and
//    then corrects it by one Gauss–Seidel sweep (formula above). At the fixed point Δλ_n = 0, i.e. λ_n = −C_n/α̃_n:
//    the pressure is exactly the constitutive one whatever the step, the order of the sweep or the relaxation.
//    (Resetting λ every substep is too soft at steady state once h²·w‖∇C‖² ≫ α; that is why the indentation force
//    of phase 1 changed threefold with the number of substeps.)
// 3. 应变硬化：Ψ_dev = μ/2·c + μ·κ/4·c²，c = C_D²（不可压时 c = I₁ − 3，即 Yeoh 的二阶项，C₂₀ = μκ/4）。
//    约束形式不变，柔度除以 (1 + κ·c)。
//    Strain stiffening: Ψ_dev = μ/2·c + μ·κ/4·c² with c = C_D² (c = I₁ − 3 when incompressible, so this is the
//    second-order Yeoh term, C₂₀ = μκ/4). The constraint keeps its form; its compliance is divided by (1 + κ·c).
// 4. 粘弹性：每个四面体一个 Maxwell 支路（Prony 级数里最快的一项），内变量是参考构形里的粘性应变 E_v（偏量）：
//        Ψ_v = G₁·‖dev E − E_v‖²,   Ė_v = (dev E − E_v)/τ,   E = (FᵀF − I)/2
//    静止和长时间保持时这一项为零（长期响应就是上面的超弹性）；快速运动时组织按 μ + G₁ 响应。
//    Viscoelasticity: one Maxwell branch per tetrahedron (the fastest term of the Prony series) whose internal
//    variable is the viscous strain E_v (deviatoric) in the reference frame (formulas above). The branch vanishes at
//    rest and in a long hold (the long-term response is the hyperelastic one above); in fast motion tissue answers
//    with μ + G₁.

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
  /** 半球头的圆杆：`center` 是半球的球心，杆身从球心向 −axis 延伸 / a rod with a hemispherical tip: `center` is the centre of the hemisphere and the shaft runs from it along −axis */
  | { kind: 'rod'; center: Vec3; axis: Vec3; radius: number }

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
  /** 每个锚点的刚度，N/m；省略或 Infinity = 硬约束 / stiffness of every anchor, N/m; omitted or Infinity = a hard constraint */
  anchorStiffness?: ArrayLike<number>
  /** 每个四面体的应变硬化系数 κ（无量纲，见文件头第 3 条）/ per tetrahedron strain-stiffening coefficient κ (dimensionless, header item 3) */
  stiffening?: ArrayLike<number>
  /** 每个四面体的 Maxwell 支路：模量 G₁（帕）和松弛时间 τ（秒）；G₁ = 0 表示没有 / per tetrahedron Maxwell branch: modulus G₁ (Pa) and relaxation time τ (s); G₁ = 0 = none */
  branchModulus?: ArrayLike<number>
  branchTau?: ArrayLike<number>
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
  /** 体积约束放在哪里：'node'（缺省，不锁死）或 'tet'（第一阶段的做法，留作对照）/ where the volume constraint lives: 'node' (default, no locking) or 'tet' (phase 1, kept for comparison) */
  volume?: 'node' | 'tet'
  /** 'node' 时留在逐单元约束上的 λ 的比例（0–1）/ with 'node', the share of λ left on per-tetrahedron constraints (0–1) */
  volumeBlend?: number
  /**
   * 结点体积约束的"刚度比" h²·w‖∇C‖²·K 的上限。保留的压强相当于滞后一步的力，这个比值太大时不稳定；超过上限的结点
   * 把体积模量降到上限（等效泊松比变小，结果仍是一个确定的本构的精确不动点）。
   * Upper bound of the "stiffness ratio" h²·w‖∇C‖²·K of a nodal volume constraint. A kept pressure acts like a force
   * one step late, which is unstable when this ratio is large; a node above the bound has its bulk modulus lowered
   * to it (a smaller effective Poisson ratio; the result is still the exact fixed point of a definite material).
   */
  volumeCap?: number
  /**
   * 被蒙皮压坏的参考四面体怎么办。'drop'（缺省）：刚度按 q_e 折减到零（r 在 [0.5, 2] 之外线性过渡，r ≤ 0.25 或 ≥ 4 为零），
   * 姿势保持不动时修正位移回到零；代价是一整层都坏掉时组织会与骨脱开。'rest'：换成随骨转动的静止形状（repairReference），
   * 不会脱开，但在弯着的关节处会留下几厘米的静态修正位移（全身算例里髋屈 40° 时皮肤上 98 mm），所以不是缺省。
   * What to do with reference tetrahedra wrecked by skinning. 'drop' (default): stiffness is scaled by q_e down to
   * zero (linear outside r ∈ [0.5, 2], zero for r ≤ 0.25 or ≥ 4) and the corrective displacement returns to zero in a
   * held pose; the price is that tissue comes off the bone where a whole layer is wrecked. 'rest': replaced by the
   * rest shape turned with the bone (repairReference); nothing comes off, but a bent joint keeps centimetres of static
   * corrective displacement (98 mm on the skin at 40° of hip flexion in the whole-body case), hence not the default.
   */
  referenceRepair?: 'drop' | 'rest'
  /** 'gs' = Gauss–Seidel（缺省）；'jacobi' = 同时求解再合并（GPU 的做法，见 solveJacobi）/ 'gs' = Gauss–Seidel (default); 'jacobi' = solve all at once, then merge (the GPU scheme, see solveJacobi) */
  mode?: 'gs' | 'jacobi'
  /** Jacobi 的松弛因子 / relaxation factor of the Jacobi mode */
  relaxation?: number
}

/**
 * 单元体积比的下限（应变极限）：近不可压的组织里 J 本来就在 1 附近，只有被压头压到底或数值出问题时才会碰到。
 * 没有它，不带对数项的能量在 J = 0 处是有限的，压头可以把单元压穿。数值是假设。
 * Floor of the element volume ratio (a strain limit): in nearly incompressible tissue J stays near 1 anyway, so it
 * is reached only when a probe bottoms out or the numerics go wrong. Without it the energy (no logarithmic term) is
 * finite at J = 0 and a probe can push through an element. The value is an assumption.
 */
export const J_MIN = 0.3

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
  /** 运动学结点相对参考构形的给定位移（扁平 xyz，米）；弹性参考不变，所以这是真正的位移边界条件。null = 没有 / prescribed displacement of kinematic nodes relative to the reference (flat xyz, metres); the elastic reference stays, so this is a true displacement boundary condition. null = none */
  pinOffset: Float64Array | null = null
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
  volumeMode: 'node' | 'tet'
  volumeBlend: number
  volumeCap: number
  referenceRepair: 'drop' | 'rest'
  mode: 'gs' | 'jacobi'
  relaxation: number
  /** 结点的"压强乘子" P_n = λ_n/h²，焦耳；压强 = −P_n / V_n / 结点体积系数 / the nodal multiplier P_n = λ_n/h², joules (kept across substeps) */
  readonly nodalMultiplier: Float64Array
  /** 每个结点周围参与求解的四面体（CSR）/ the solved tetrahedra around every node (CSR) */
  private readonly ringStart: Uint32Array
  private readonly ringTets: Uint32Array
  /** Σ_{e∋n} V_e 和 K_n = Σ V_e·λ_e/4 / Σ_{e∋n} V_e and K_n = Σ V_e·λ_e/4 */
  private readonly ringVolume: Float64Array
  /** Σ_{e∋n} V_e（静止笼子）/ Σ_{e∋n} V_e (cage at rest) */
  private readonly ringRest: Float64Array
  private readonly ringK: Float64Array
  /** V_e·det B_e：J_e·V_e = kdet_e·det Ds_e / V_e·det B_e, so that J_e·V_e = kdet_e·det Ds_e */
  private readonly kdet: Float64Array
  private readonly gacc: Float64Array
  private readonly qual: Float64Array
  private readonly invMass0: Float64Array
  private readonly fint: Float64Array
  private readonly stamp: Int32Array
  private readonly touched: Int32Array
  private readonly kappa: Float64Array | null
  private readonly branchG: Float64Array | null
  private readonly branchTau: Float64Array | null
  /** Maxwell 支路的粘性应变（对称偏量，6 个分量：xx yy zz xy xz yz）/ viscous strain of the Maxwell branch (symmetric deviatoric, six components: xx yy zz xy xz yz) */
  readonly viscous: Float64Array | null
  private readonly anchorK: Float64Array | null
  /** Jacobi 模式的累加器 / accumulators of the Jacobi mode */
  private jdx: Float64Array | null = null
  private jcount: Float64Array | null = null

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
    this.volumeMode = opts.volume ?? 'node'
    this.volumeBlend = opts.volumeBlend ?? 0
    this.volumeCap = opts.volumeCap ?? 2
    this.referenceRepair = opts.referenceRepair ?? 'drop'
    this.mode = opts.mode ?? 'gs'
    this.relaxation = opts.relaxation ?? 1
    let any = false
    if (input.stiffening) for (let e = 0; e < t; e++) if (input.stiffening[e]! > 0) any = true
    this.kappa = any ? Float64Array.from(input.stiffening!) : null
    any = false
    if (input.branchModulus && input.branchTau) for (let e = 0; e < t; e++) if (input.branchModulus[e]! > 0) any = true
    this.branchG = any ? Float64Array.from(input.branchModulus!) : null
    this.branchTau = any ? Float64Array.from(input.branchTau!) : null
    this.viscous = any ? new Float64Array(t * 6) : null
    this.anchorK = this.anchors && input.anchorStiffness ? Float64Array.from(input.anchorStiffness) : null
    // 结点周围的四面体 / the tetrahedra around every node
    this.ringStart = new Uint32Array(n + 1)
    for (let k = 0; k < this.active.length; k++) for (let c = 0; c < 4; c++) this.ringStart[this.tets[this.active[k]! * 4 + c]! + 1]!++
    for (let i = 0; i < n; i++) this.ringStart[i + 1] = this.ringStart[i + 1]! + this.ringStart[i]!
    this.ringTets = new Uint32Array(this.active.length * 4)
    const fillAt = Uint32Array.from(this.ringStart.subarray(0, n))
    this.ringVolume = new Float64Array(n)
    for (let k = 0; k < this.active.length; k++) {
      const e = this.active[k]!
      for (let c = 0; c < 4; c++) {
        const i = this.tets[e * 4 + c]!
        this.ringTets[fillAt[i]!++] = e
        this.ringVolume[i] = this.ringVolume[i]! + this.restVolume[e]!
      }
    }
    this.ringK = new Float64Array(n)
    this.ringRest = Float64Array.from(this.ringVolume)
    this.kdet = new Float64Array(t)
    this.nodalMultiplier = new Float64Array(n)
    this.gacc = new Float64Array(n * 3)
    this.qual = new Float64Array(t).fill(1)
    this.invMass0 = Float64Array.from(this.invMass)
    this.fint = new Float64Array(n * 3)
    this.stamp = new Int32Array(n).fill(-1)
    this.touched = new Int32Array(256)
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
    this.nodalMultiplier.fill(0)
    this.viscous?.fill(0)
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
    this.repairReference()
    const f0 = this.fibre0, f = this.fibre
    if (!f0 || !f) {
      this.prepareVolume()
      return
    }
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
    this.prepareVolume()
  }

  /**
   * 被蒙皮压坏的参考四面体换成"随骨转动的静止形状"。参考体积与静止体积之比 r 在 [0.5, 2] 之内的不动；
   * r ≤ 0.25 或 r ≥ 4（含翻转）的完全换掉；之间按 q 线性混合边矩阵：Dm = q·Dm(ref) + (1 − q)·R·Dm(rest)，
   * R 取该四面体第一个结点随骨架的转动（`rotations`，没有则为单位阵）。能量对转动不变，所以 R 只需大致正确。
   * 这样坏掉的四面体不再从求解里消失（那会把组织从骨上切下来），而是把自己拉回没被压扁的形状。
   * Reference tetrahedra wrecked by skinning are replaced by "the rest shape turned with the bone". Those whose
   * ratio r of reference to rest volume lies in [0.5, 2] are left alone; those with r ≤ 0.25 or r ≥ 4 (inverted
   * included) are replaced outright; in between the edge matrices are blended linearly by q:
   * Dm = q·Dm(ref) + (1 − q)·R·Dm(rest), with R the rotation of the tetrahedron's first node with the skeleton
   * (`rotations`; identity without). The energy is invariant under rotation, so R need only be roughly right. A
   * wrecked tetrahedron thus stays in the solve (dropping it would cut tissue off the bone) and pulls itself back
   * towards its uncrushed shape.
   */
  private repairReference(): void {
    if (this.referenceRepair !== 'rest') return
    const B = this.B, T = this.tets, ref = this.ref, rest = this.rest, R = this.rotations
    const m = new Float64Array(9)
    for (let k = 0; k < this.active.length; k++) {
      const e = this.active[k]!, o = e * 9
      const db = det3(B[o]!, B[o + 1]!, B[o + 2]!, B[o + 3]!, B[o + 4]!, B[o + 5]!, B[o + 6]!, B[o + 7]!, B[o + 8]!)
      const r = db > 0 && Number.isFinite(db) ? 1 / (6 * db * this.restVolume[e]!) : 0
      if (r >= 0.5 && r <= 2) continue
      const q = r < 0.5 ? Math.min(1, Math.max(0, (r - 0.25) / 0.25)) : Math.min(1, Math.max(0, (4 - r) / 2))
      const a = T[e * 4]! * 3
      const ro = R ? T[e * 4]! * 9 : -1
      for (let c = 0; c < 3; c++) {
        const n = T[e * 4 + c + 1]! * 3
        const ex = rest[n]! - rest[a]!, ey = rest[n + 1]! - rest[a + 1]!, ez = rest[n + 2]! - rest[a + 2]!
        for (let row = 0; row < 3; row++) {
          const turned = ro >= 0 ? R![ro + row * 3]! * ex + R![ro + row * 3 + 1]! * ey + R![ro + row * 3 + 2]! * ez : row === 0 ? ex : row === 1 ? ey : ez
          m[row * 3 + c] = q * (ref[n + row]! - ref[a + row]!) + (1 - q) * turned
        }
      }
      const c00 = m[4]! * m[8]! - m[5]! * m[7]!, c01 = m[5]! * m[6]! - m[3]! * m[8]!, c02 = m[3]! * m[7]! - m[4]! * m[6]!
      const det = m[0]! * c00 + m[1]! * c01 + m[2]! * c02
      const inv = Math.abs(det) > 1e-30 ? 1 / det : 0
      B[o] = c00 * inv; B[o + 1] = (m[2]! * m[7]! - m[1]! * m[8]!) * inv; B[o + 2] = (m[1]! * m[5]! - m[2]! * m[4]!) * inv
      B[o + 3] = c01 * inv; B[o + 4] = (m[0]! * m[8]! - m[2]! * m[6]!) * inv; B[o + 5] = (m[2]! * m[3]! - m[0]! * m[5]!) * inv
      B[o + 6] = c02 * inv; B[o + 7] = (m[1]! * m[6]! - m[0]! * m[7]!) * inv; B[o + 8] = (m[0]! * m[3]! - m[1]! * m[4]!) * inv
    }
  }

  /**
   * 每帧一次：四面体的"参考质量" q_e、结点周围的参考体积和体积刚度。
   * 蒙皮会把关节附近的笼子四面体压扁甚至翻转（髋屈 40° 时全身约有 200 个翻转、100 个体积不到四分之一），拿这样的
   * 形状当弹性参考是没有意义的：repairReference 已经把它们换成随骨转动的静止形状。这里的 q_e 只是保险：参考体积与
   * 静止体积之比仍然离谱（< 0.2 或 > 5）的四面体不参与求解；周围四面体全都失效的自由结点这一帧改为运动学结点。
   * 结点的体积比用参考体积加权：J̄_n = Σ q_e·vol_e(x) / Σ q_e·vol_e(ref)，退化的四面体对两边的贡献都趋于零。
   * Once per frame: the "reference quality" q_e of every tetrahedron, and the reference volume and bulk stiffness
   * around every node. Skinning flattens or even inverts cage tetrahedra near a joint (at 40° of hip flexion about 200
   * are inverted and 100 keep under a quarter of their volume), and such a shape is meaningless as an elastic
   * reference: repairReference has already replaced them by the rest shape turned with the bone. q_e here is a
   * safeguard only: a tetrahedron whose ratio of reference to rest volume is still absurd (< 0.2 or > 5) is left out
   * of the solve, and a free node whose tetrahedra have all failed becomes kinematic for the frame. The nodal volume
   * ratio is weighted by reference volume: J̄_n = Σ q_e·vol_e(x) / Σ q_e·vol_e(ref), so a degenerate tetrahedron
   * contributes next to nothing to either sum.
   */
  private prepareVolume(): void {
    const B = this.B, T = this.tets, q = this.qual, sup = this.gacc
    this.ringK.fill(0)
    this.ringVolume.fill(0)
    sup.fill(0, 0, this.nodeCount)
    for (let k = 0; k < this.active.length; k++) {
      const e = this.active[k]!, o = e * 9
      const db = det3(B[o]!, B[o + 1]!, B[o + 2]!, B[o + 3]!, B[o + 4]!, B[o + 5]!, B[o + 6]!, B[o + 7]!, B[o + 8]!)
      const vref = db > 0 && Number.isFinite(db) ? 1 / (6 * db) : 0
      const r = vref / this.restVolume[e]!
      // repairReference 之后 r 都在合理范围内，q_e 只在数值意外时才小于 1 / after repairReference r is always sane; q_e drops below 1 only on a numerical accident
      const qe = this.referenceRepair === 'rest' ? (r < 0.2 || r > 5 ? 0 : 1) : r < 0.5 ? Math.min(1, Math.max(0, (r - 0.25) / 0.25)) : r > 2 ? Math.min(1, Math.max(0, (4 - r) / 2)) : 1
      q[e] = qe
      this.kdet[e] = qe / 6
      const kk = (this.restVolume[e]! * this.lam[e]! * this.actScale[e]! * qe) / 4
      for (let c = 0; c < 4; c++) {
        const i = T[e * 4 + c]!
        this.ringK[i] = this.ringK[i]! + kk
        this.ringVolume[i] = this.ringVolume[i]! + qe * vref
        sup[i] = sup[i]! + qe
      }
    }
    for (let i = 0; i < this.nodeCount; i++) {
      const has = this.ringStart[i + 1]! > this.ringStart[i]!
      this.invMass[i] = has && sup[i]! < 0.25 ? 0 : this.invMass0[i]!
      // 周围的参考体积塌到静止时的十分之一以下：这个结点不设体积约束 / reference volume round the node collapsed below a tenth of its rest value: no volume constraint here
      if (this.ringVolume[i]! < 0.1 * this.ringRest[i]!) {
        this.ringVolume[i] = 0
        this.nodalMultiplier[i] = 0
      }
    }
    sup.fill(0, 0, this.nodeCount)
  }

  /** 四面体的约束 C_D、C_H、C_f，一遍 Gauss–Seidel（公式见文件头）。 The constraints C_D, C_H, C_f of every tetrahedron, one Gauss–Seidel sweep (formulas in the header). */
  private solveTets(h: number): void {
    const T = this.tets, x = this.x, w = this.invMass, B = this.B, V = this.restVolume
    // Jacobi：读 x、写累加器，分母用"分摊后的质量"；Gauss–Seidel：两者都是 x 和真实的逆质量
    // Jacobi: reads x and writes the accumulator, denominators use the "split" masses; Gauss–Seidel: both are x and the true inverse masses
    const jac = this.mode === 'jacobi'
    const wsol = jac ? this.jcount! : w, out = jac ? this.jdx! : x
    const share = this.volumeMode === 'tet' ? 1 : this.volumeBlend
    const kap = this.kappa, bG = this.branchG, bT = this.branchTau, Ev = this.viscous
    const ih2 = 1 / (h * h)
    const fib = this.fibre, fk = this.fibreK
    const act = this.active
    for (let k = 0; k < act.length; k++) {
      const e = act[k]!
      const i0 = T[e * 4]!, i1 = T[e * 4 + 1]!, i2 = T[e * 4 + 2]!, i3 = T[e * 4 + 3]!
      const a = i0 * 3, b = i1 * 3, c = i2 * 3, d = i3 * 3
      const w0 = w[i0]!, w1 = w[i1]!, w2 = w[i2]!, w3 = w[i3]!
      const m0 = wsol[i0]!, m1 = wsol[i1]!, m2 = wsol[i2]!, m3 = wsol[i3]!
      const o = e * 9
      const b00 = B[o]!, b01 = B[o + 1]!, b02 = B[o + 2]!, b10 = B[o + 3]!, b11 = B[o + 4]!, b12 = B[o + 5]!, b20 = B[o + 6]!, b21 = B[o + 7]!, b22 = B[o + 8]!
      const vol = V[e]!
      // 激活时 μ 和 λ 乘同一个倍数：泊松比不变，体积照样守恒 / activation scales μ and λ alike: the Poisson ratio stays and volume is kept as before
      const qe = this.qual[e]!
      if (qe === 0) continue
      const mu = this.mu[e]! * this.actScale[e]! * qe, la = this.lam[e]! * this.actScale[e]! * share * qe
      const g1m = bG ? bG[e]! * qe : 0
      let jPrev = 1
      for (let pass = 0; pass < 3; pass++) {
        // 结点体积模式下，逐单元这一遍只在单元快被压扁时才需要（体积下限）/ with nodal volume constraints the per-tetrahedron pass is needed only when the element is nearly crushed (the volume floor)
        if (pass === 1 && !(la > 0) && jPrev > 0.5) continue
        if (pass === 2 && !(g1m > 0)) break
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
          jPrev = J
          // C_D：P = F + (J − 2)·cof F，"C²" = I_C + J² − 4J
          c2 = f00 * f00 + f01 * f01 + f02 * f02 + f10 * f10 + f11 * f11 + f12 * f12 + f20 * f20 + f21 * f21 + f22 * f22 + J * J - 4 * J
          if (!(c2 > 0)) continue
          const q = J - 2
          p00 = f00 + q * h00; p01 = f01 + q * h01; p02 = f02 + q * h02
          p10 = f10 + q * h10; p11 = f11 + q * h11; p12 = f12 + q * h12
          p20 = f20 + q * h20; p21 = f21 + q * h21; p22 = f22 + q * h22
          comp = (c2 * ih2) / (mu * (kap ? 1 + kap[e]! * c2 : 1) * vol)
        } else if (pass === 1) {
          // C_H = J − 1：P = cof F；写成同一个更新式时 "C²" 换成 C、柔度项是 α̃
          // C_H = J − 1: P = cof F; in the same update form "C²" becomes C and the compliance term α̃
          if (J < J_MIN) {
            // 体积下限：硬的单边约束 J ≥ J_MIN，单元不会被压穿或翻转 / the volume floor: a hard unilateral constraint J ≥ J_MIN, so no element is crushed through or inverted
            c2 = J - J_MIN
            comp = 0
          } else if (la > 0) {
            c2 = J - 1
            if (c2 === 0) continue
            comp = ih2 / (la * vol)
          } else continue
          p00 = h00; p01 = h01; p02 = h02
          p10 = h10; p11 = h11; p12 = h12
          p20 = h20; p21 = h21; p22 = h22
        } else {
          // Maxwell 支路：Q = dev E − E_v，"C²" = Q:Q，P = F·Q，柔度 1/(2·G₁·V)
          // the Maxwell branch: Q = dev E − E_v, "C²" = Q:Q, P = F·Q, compliance 1/(2·G₁·V)
          const e00 = 0.5 * (f00 * f00 + f10 * f10 + f20 * f20 - 1), e11 = 0.5 * (f01 * f01 + f11 * f11 + f21 * f21 - 1), e22 = 0.5 * (f02 * f02 + f12 * f12 + f22 * f22 - 1)
          const e01 = 0.5 * (f00 * f01 + f10 * f11 + f20 * f21), e02 = 0.5 * (f00 * f02 + f10 * f12 + f20 * f22), e12 = 0.5 * (f01 * f02 + f11 * f12 + f21 * f22)
          const tr = (e00 + e11 + e22) / 3, o6 = e * 6
          const q00 = e00 - tr - Ev![o6]!, q11 = e11 - tr - Ev![o6 + 1]!, q22 = e22 - tr - Ev![o6 + 2]!, q01 = e01 - Ev![o6 + 3]!, q02 = e02 - Ev![o6 + 4]!, q12 = e12 - Ev![o6 + 5]!
          // 粘性应变向当前应变松弛（用求解前的应变，滞后一个子步）/ the viscous strain relaxes towards the present strain (taken before the solve: one substep late)
          const kr = 1 - Math.exp(-h / bT![e]!)
          Ev![o6] = Ev![o6]! + kr * q00; Ev![o6 + 1] = Ev![o6 + 1]! + kr * q11; Ev![o6 + 2] = Ev![o6 + 2]! + kr * q22
          Ev![o6 + 3] = Ev![o6 + 3]! + kr * q01; Ev![o6 + 4] = Ev![o6 + 4]! + kr * q02; Ev![o6 + 5] = Ev![o6 + 5]! + kr * q12
          c2 = q00 * q00 + q11 * q11 + q22 * q22 + 2 * (q01 * q01 + q02 * q02 + q12 * q12)
          if (!(c2 > 1e-24)) continue
          p00 = f00 * q00 + f01 * q01 + f02 * q02; p01 = f00 * q01 + f01 * q11 + f02 * q12; p02 = f00 * q02 + f01 * q12 + f02 * q22
          p10 = f10 * q00 + f11 * q01 + f12 * q02; p11 = f10 * q01 + f11 * q11 + f12 * q12; p12 = f10 * q02 + f11 * q12 + f12 * q22
          p20 = f20 * q00 + f21 * q01 + f22 * q02; p21 = f20 * q01 + f21 * q11 + f22 * q12; p22 = f20 * q02 + f21 * q12 + f22 * q22
          comp = (c2 * ih2) / (2 * g1m * vol)
        }
        // 结点 k 的梯度 = P·(B 的第 k−1 行)ᵀ / gradient of node k = P·(row k−1 of B)ᵀ
        const g1x = p00 * b00 + p01 * b01 + p02 * b02, g1y = p10 * b00 + p11 * b01 + p12 * b02, g1z = p20 * b00 + p21 * b01 + p22 * b02
        const g2x = p00 * b10 + p01 * b11 + p02 * b12, g2y = p10 * b10 + p11 * b11 + p12 * b12, g2z = p20 * b10 + p21 * b11 + p22 * b12
        const g3x = p00 * b20 + p01 * b21 + p02 * b22, g3y = p10 * b20 + p11 * b21 + p12 * b22, g3z = p20 * b20 + p21 * b21 + p22 * b22
        const g0x = -g1x - g2x - g3x, g0y = -g1y - g2y - g3y, g0z = -g1z - g2z - g3z
        const den = m0 * (g0x * g0x + g0y * g0y + g0z * g0z) + m1 * (g1x * g1x + g1y * g1y + g1z * g1z) + m2 * (g2x * g2x + g2y * g2y + g2z * g2z) + m3 * (g3x * g3x + g3y * g3y + g3z * g3z) + comp
        if (!(den > 1e-300)) continue
        const l = -c2 / den
        out[a] = out[a]! + w0 * l * g0x
        out[a + 1] = out[a + 1]! + w0 * l * g0y
        out[a + 2] = out[a + 2]! + w0 * l * g0z
        out[b] = out[b]! + w1 * l * g1x
        out[b + 1] = out[b + 1]! + w1 * l * g1y
        out[b + 2] = out[b + 2]! + w1 * l * g1z
        out[c] = out[c]! + w2 * l * g2x
        out[c + 1] = out[c + 1]! + w2 * l * g2y
        out[c + 2] = out[c + 2]! + w2 * l * g2z
        out[d] = out[d]! + w3 * l * g3x
        out[d + 1] = out[d + 1]! + w3 * l * g3y
        out[d + 2] = out[d + 2]! + w3 * l * g3z
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
            const ws = m0 * s0 * s0 + m1 * s1 * s1 + m2 * s2 * s2 + m3 * s3 * s3
            const dl = -(len - 1) / (ws + ih2 / (fk[e]! * this.actScale[e]! * qe * vol))
            out[a] = out[a]! + w0 * s0 * dl * ux
            out[a + 1] = out[a + 1]! + w0 * s0 * dl * uy
            out[a + 2] = out[a + 2]! + w0 * s0 * dl * uz
            out[b] = out[b]! + w1 * s1 * dl * ux
            out[b + 1] = out[b + 1]! + w1 * s1 * dl * uy
            out[b + 2] = out[b + 2]! + w1 * s1 * dl * uz
            out[c] = out[c]! + w2 * s2 * dl * ux
            out[c + 1] = out[c + 1]! + w2 * s2 * dl * uy
            out[c + 2] = out[c + 2]! + w2 * s2 * dl * uz
            out[d] = out[d]! + w3 * s3 * dl * ux
            out[d + 1] = out[d + 1]! + w3 * s3 * dl * uy
            out[d + 2] = out[d + 2]! + w3 * s3 * dl * uz
          }
        }
      }
    }
  }

  /**
   * 结点体积约束，一遍（文件头第 1、2 条）。C_n = Σ_e kdet_e·det Ds_e / V_n − 1，乘子跨子步保留。
   * The nodal volume constraints, one sweep (header items 1 and 2). C_n = Σ_e kdet_e·det Ds_e / V_n − 1; the
   * multipliers are kept across substeps.
   */
  private solveVolumes(h: number): void {
    if (this.volumeMode !== 'node' || this.volumeBlend >= 1) return
    const T = this.tets, x = this.x, w = this.invMass, g = this.gacc, st = this.stamp, tl = this.touched
    const jac = this.mode === 'jacobi'
    const wsol = jac ? this.jcount! : w, out = jac ? this.jdx! : x
    const h2 = h * h, ih2 = 1 / h2, share = 1 - this.volumeBlend, relax = jac ? this.relaxation : 1
    const P = this.nodalMultiplier, rs = this.ringStart, rt = this.ringTets, kd = this.kdet
    const cap = this.volumeCap
    for (let n = 0; n < this.nodeCount; n++) {
      const from = rs[n]!, to = rs[n + 1]!
      const K = this.ringK[n]! * share
      if (from === to || !(K > 0) || !(this.ringVolume[n]! > 1e-15)) continue
      let S = 0, cnt = 0
      for (let q = from; q < to; q++) {
        const e = rt[q]!, k = kd[e]!
        const i0 = T[e * 4]!, i1 = T[e * 4 + 1]!, i2 = T[e * 4 + 2]!, i3 = T[e * 4 + 3]!
        const a = i0 * 3, b = i1 * 3, c = i2 * 3, d = i3 * 3
        const ax = x[a]!, ay = x[a + 1]!, az = x[a + 2]!
        const ux = x[b]! - ax, uy = x[b + 1]! - ay, uz = x[b + 2]! - az
        const vx = x[c]! - ax, vy = x[c + 1]! - ay, vz = x[c + 2]! - az
        const qx = x[d]! - ax, qy = x[d + 1]! - ay, qz = x[d + 2]! - az
        // ∂det/∂x₁ = v×q, ∂det/∂x₂ = q×u, ∂det/∂x₃ = u×v
        const c1x = (vy * qz - vz * qy) * k, c1y = (vz * qx - vx * qz) * k, c1z = (vx * qy - vy * qx) * k
        const c2x = (qy * uz - qz * uy) * k, c2y = (qz * ux - qx * uz) * k, c2z = (qx * uy - qy * ux) * k
        const c3x = (uy * vz - uz * vy) * k, c3y = (uz * vx - ux * vz) * k, c3z = (ux * vy - uy * vx) * k
        S += ux * c1x + uy * c1y + uz * c1z
        if (st[i0] !== n) { st[i0] = n; tl[cnt++] = i0; g[a] = g[a + 1] = g[a + 2] = 0 }
        if (st[i1] !== n) { st[i1] = n; tl[cnt++] = i1; g[b] = g[b + 1] = g[b + 2] = 0 }
        if (st[i2] !== n) { st[i2] = n; tl[cnt++] = i2; g[c] = g[c + 1] = g[c + 2] = 0 }
        if (st[i3] !== n) { st[i3] = n; tl[cnt++] = i3; g[d] = g[d + 1] = g[d + 2] = 0 }
        g[b] = g[b]! + c1x; g[b + 1] = g[b + 1]! + c1y; g[b + 2] = g[b + 2]! + c1z
        g[c] = g[c]! + c2x; g[c + 1] = g[c + 1]! + c2y; g[c + 2] = g[c + 2]! + c2z
        g[d] = g[d]! + c3x; g[d + 1] = g[d + 1]! + c3y; g[d + 2] = g[d + 2]! + c3z
        g[a] = g[a]! - c1x - c2x - c3x; g[a + 1] = g[a + 1]! - c1y - c2y - c3y; g[a + 2] = g[a + 2]! - c1z - c2z - c3z
      }
      const iv = 1 / this.ringVolume[n]!
      let A = 0
      for (let k = 0; k < cnt; k++) {
        const i = tl[k]!, o = i * 3
        A += wsol[i]! * (g[o]! * g[o]! + g[o + 1]! * g[o + 1]! + g[o + 2]! * g[o + 2]!)
      }
      A *= iv * iv
      if (!(A > 0)) continue
      // 步长分辨不了的体积刚度按 A/cap 封顶（见 volumeCap）/ bulk stiffness the step cannot resolve is capped at A/cap (see volumeCap)
      const alpha = Math.max(ih2 / K, A / cap)
      const dl = (-(S * iv - 1 + alpha * P[n]! * h2) / (A + alpha)) * relax
      // 压强不超过体积模量的 1.5 倍（单元翻转时 C 可以到 −1 以下，不让乘子无限增长）
      // the pressure never exceeds 1.5 × the bulk modulus (C can fall below −1 when elements invert; the multiplier must not grow without bound)
      const lim = 1.5 * K
      let pn = P[n]! + dl * ih2
      if (pn > lim) pn = lim
      else if (pn < -lim) pn = -lim
      const dq = (pn - P[n]!) * h2
      P[n] = pn
      const sc = dq * iv
      for (let k = 0; k < cnt; k++) {
        const i = tl[k]!, o = i * 3, f = w[i]! * sc
        out[o] = out[o]! + f * g[o]!
        out[o + 1] = out[o + 1]! + f * g[o + 1]!
        out[o + 2] = out[o + 2]! + f * g[o + 2]!
      }
    }
  }

  /** 上一步的结点压强作为力，写入 fint（牛）。 The nodal pressures of the previous step as forces, into fint (newtons). */
  private pressureForces(): boolean {
    if (this.volumeMode !== 'node' || this.volumeBlend >= 1) return false
    const T = this.tets, x = this.x, f = this.fint, P = this.nodalMultiplier, V = this.ringVolume, kd = this.kdet
    f.fill(0)
    for (let m = 0; m < this.active.length; m++) {
      const e = this.active[m]!
      const i0 = T[e * 4]!, i1 = T[e * 4 + 1]!, i2 = T[e * 4 + 2]!, i3 = T[e * 4 + 3]!
      if (kd[e] === 0) continue
      const k = ((V[i0]! > 1e-15 ? P[i0]! / V[i0]! : 0) + (V[i1]! > 1e-15 ? P[i1]! / V[i1]! : 0) + (V[i2]! > 1e-15 ? P[i2]! / V[i2]! : 0) + (V[i3]! > 1e-15 ? P[i3]! / V[i3]! : 0)) * kd[e]!
      if (k === 0) continue
      const a = i0 * 3, b = i1 * 3, c = i2 * 3, d = i3 * 3
      const ax = x[a]!, ay = x[a + 1]!, az = x[a + 2]!
      const ux = x[b]! - ax, uy = x[b + 1]! - ay, uz = x[b + 2]! - az
      const vx = x[c]! - ax, vy = x[c + 1]! - ay, vz = x[c + 2]! - az
      const qx = x[d]! - ax, qy = x[d + 1]! - ay, qz = x[d + 2]! - az
      const c1x = (vy * qz - vz * qy) * k, c1y = (vz * qx - vx * qz) * k, c1z = (vx * qy - vy * qx) * k
      const c2x = (qy * uz - qz * uy) * k, c2y = (qz * ux - qx * uz) * k, c2z = (qx * uy - qy * ux) * k
      const c3x = (uy * vz - uz * vy) * k, c3y = (uz * vx - ux * vz) * k, c3z = (ux * vy - uy * vx) * k
      f[b] = f[b]! + c1x; f[b + 1] = f[b + 1]! + c1y; f[b + 2] = f[b + 2]! + c1z
      f[c] = f[c]! + c2x; f[c + 1] = f[c + 1]! + c2y; f[c + 2] = f[c + 2]! + c2z
      f[d] = f[d]! + c3x; f[d + 1] = f[d + 1]! + c3y; f[d + 2] = f[d + 2]! + c3z
      f[a] = f[a]! - c1x - c2x - c3x; f[a + 1] = f[a + 1]! - c1y - c2y - c3y; f[a + 2] = f[a + 2]! - c1z - c2z - c3z
    }
    return true
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
  private pushPoint(set: PointSet, i: number, nx: number, ny: number, nz: number, c: number, alpha = 0): number {
    const e = set.tet[i]! * 4
    let ws = 0
    for (let k = 0; k < 4; k++) {
      const bk = set.bary[i * 4 + k]!
      ws += this.invMass[this.tets[e + k]!]! * bk * bk
    }
    if (!(ws > 0)) return 0
    const dl = c / (ws + alpha)
    for (let k = 0; k < 4; k++) {
      const n = this.tets[e + k]!, s = this.invMass[n]! * set.bary[i * 4 + k]! * dl
      this.x[n * 3] = this.x[n * 3]! + s * nx
      this.x[n * 3 + 1] = this.x[n * 3 + 1]! + s * ny
      this.x[n * 3 + 2] = this.x[n * 3 + 2]! + s * nz
    }
    return dl
  }

  private solveAnchors(tau: number, h: number): void {
    const set = this.anchors
    if (!set) return
    const K = this.anchorK, ih2 = 1 / (h * h)
    const q = [0, 0, 0], r0 = [0, 0, 0], r1 = [0, 0, 0]
    for (let i = 0; i < set.tet.length; i++) {
      this.pointAt(set, i, this.x, q)
      this.pointAt(set, i, this.refPrev, r0)
      this.pointAt(set, i, this.ref, r1)
      const cx = r0[0]! + (r1[0]! - r0[0]!) * tau - q[0]!, cy = r0[1]! + (r1[1]! - r0[1]!) * tau - q[1]!, cz = r0[2]! + (r1[2]! - r0[2]!) * tau - q[2]!
      const l = Math.hypot(cx, cy, cz)
      // 有限刚度的锚点：柔度 1/k / an anchor of finite stiffness: compliance 1/k
      const k = K ? K[i]! : Infinity
      if (l > 0 && k > 0) this.pushPoint(set, i, cx / l, cy / l, cz / l, l, Number.isFinite(k) ? ih2 / k : 0)
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
        if (s.kind === 'rod' && rx * s.axis[0] + ry * s.axis[1] + rz * s.axis[2] < 0) {
          // 球心之后是杆身：沿径向推到杆的表面 / behind the centre lies the shaft: pushed radially to its surface
          const along = rx * s.axis[0] + ry * s.axis[1] + rz * s.axis[2]
          if (along < -6 * s.radius) continue
          const ox = rx - along * s.axis[0], oy = ry - along * s.axis[1], oz = rz - along * s.axis[2]
          const l = Math.hypot(ox, oy, oz)
          if (l >= s.radius || l < 1e-12) continue
          c = s.radius - l
          nx = ox / l
          ny = oy / l
          nz = oz / l
        } else if (s.kind === 'sphere' || s.kind === 'rod') {
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

  /**
   * Jacobi 模式的"质量分摊"（Tonge 等 2012）：结点 i 参与 n_i 条约束，每条约束把它看成质量 m_i/n_i 的一份，
   * 各自求解后把位置改变量相加。约束软（α̃ ≫ w‖∇C‖²）时与逐条施力完全相同；约束硬时每条都偏保守，不会过冲。
   * "Mass splitting" for the Jacobi mode (Tonge et al. 2012): node i takes part in n_i constraints, each of which
   * sees it as a piece of mass m_i/n_i; all are solved independently and the position changes summed. For a soft
   * constraint (α̃ ≫ w‖∇C‖²) this equals applying its force; for a stiff one each solve is conservative, so nothing overshoots.
   */
  private prepareJacobi(): void {
    if (this.jdx) return
    const N = this.nodeCount, T = this.tets
    this.jdx = new Float64Array(N * 3)
    const cnt = new Float64Array(N)
    const perTet = 1 + (this.volumeMode === 'tet' || this.volumeBlend > 0 ? 1 : 0) + (this.branchG ? 1 : 0) + (this.fibreK ? 1 : 0)
    const nodal = this.volumeMode === 'node' && this.volumeBlend < 1
    const seen = new Int32Array(N).fill(-1)
    for (let i = 0; i < N; i++) {
      const from = this.ringStart[i]!, to = this.ringStart[i + 1]!
      let c = (to - from) * perTet
      if (nodal) for (let q = from; q < to; q++) for (let k = 0; k < 4; k++) {
        // 结点 i 出现在它每个邻居（含自己）的体积约束里 / node i appears in the volume constraint of every neighbour (itself included)
        const j = T[this.ringTets[q]! * 4 + k]!
        if (seen[j] !== i) (seen[j] = i), c++
      }
      cnt[i] = Math.max(1, c) * this.invMass[i]!
    }
    this.jcount = cnt
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
    const fint = this.fint, off = this.pinOffset
    const jac = this.mode === 'jacobi'
    if (jac) this.prepareJacobi()
    for (let s = 1; s <= n; s++) {
      const tau = s / n
      const warm = this.pressureForces()
      for (let i = 0; i < N; i++) {
        const o = i * 3
        p[o] = x[o]!
        p[o + 1] = x[o + 1]!
        p[o + 2] = x[o + 2]!
        if (w[i] === 0) {
          x[o] = r0[o]! + (ref[o]! - r0[o]!) * tau
          x[o + 1] = r0[o + 1]! + (ref[o + 1]! - r0[o + 1]!) * tau
          x[o + 2] = r0[o + 2]! + (ref[o + 2]! - r0[o + 2]!) * tau
          if (off) {
            x[o] = x[o]! + off[o]!
            x[o + 1] = x[o + 1]! + off[o + 1]!
            x[o + 2] = x[o + 2]! + off[o + 2]!
          }
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
        const fx = warm ? this.force[o]! + fint[o]! : this.force[o]!, fy = warm ? this.force[o + 1]! + fint[o + 1]! : this.force[o + 1]!, fz = warm ? this.force[o + 2]! + fint[o + 2]! : this.force[o + 2]!
        const vx = ux + (v[o]! - ux) * keep + h * (ax + fx * w[i]!)
        const vy = uy + (v[o + 1]! - uy) * keep + h * (ay + fy * w[i]!)
        const vz = uz + (v[o + 2]! - uz) * keep + h * (az + fz * w[i]!)
        x[o] = x[o]! + h * vx
        x[o + 1] = x[o + 1]! + h * vy
        x[o + 2] = x[o + 2]! + h * vz
      }
      if (jac) this.jdx!.fill(0)
      this.solveTets(h)
      this.solveVolumes(h)
      if (jac) {
        const d = this.jdx!
        for (let i = 0; i < N * 3; i++) x[i] = x[i]! + d[i]!
      }
      this.solveAnchors(tau, h)
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
    const nodalS = new Float64Array(this.nodeCount)
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
      const mu = this.mu[e]! * this.actScale[e]! * this.qual[e]!, la = this.lam[e]! * this.actScale[e]! * this.qual[e]!
      const c2 = i1 + J * J - 4 * J, share = this.volumeMode === 'tet' ? 1 : this.volumeBlend
      el += this.restVolume[e]! * (0.5 * mu * c2 * (1 + 0.5 * (this.kappa ? this.kappa[e]! : 0) * c2) + 0.5 * la * share * (J - 1) * (J - 1))
      if (this.branchG && this.branchG[e]! > 0) {
        // Maxwell 支路里存着的能量 G₁·V·‖dev E − E_v‖² / energy stored in the Maxwell branch
        const E = [0, 0, 0, 0, 0, 0]
        const ij = [[0, 0], [1, 1], [2, 2], [0, 1], [0, 2], [1, 2]]
        ij.forEach(([r, q], k) => (E[k] = 0.5 * (F[r!]! * F[q!]! + F[3 + r!]! * F[3 + q!]! + F[6 + r!]! * F[6 + q!]! - (r === q ? 1 : 0))))
        const tr = (E[0]! + E[1]! + E[2]!) / 3
        let qq = 0
        for (let k = 0; k < 6; k++) {
          const dq = E[k]! - (k < 3 ? tr : 0) - this.viscous![e * 6 + k]!
          qq += (k < 3 ? 1 : 2) * dq * dq
        }
        el += this.restVolume[e]! * this.branchG[e]! * this.qual[e]! * qq
      }
      if (share < 1) for (let k = 0; k < 4; k++) nodalS[T[e * 4 + k]!] = nodalS[T[e * 4 + k]!]! + this.kdet[e]! * det3(D[0]!, D[1]!, D[2]!, D[3]!, D[4]!, D[5]!, D[6]!, D[7]!, D[8]!)
    }
    if (this.volumeMode === 'node' && this.volumeBlend < 1) for (let i = 0; i < this.nodeCount; i++) {
      if (!(this.ringVolume[i]! > 1e-15)) continue
      const c = nodalS[i]! / this.ringVolume[i]! - 1
      el += 0.5 * this.ringK[i]! * (1 - this.volumeBlend) * c * c
    }
    return { kinetic: kin, elastic: el, potential: pot, total: kin + el + pot }
  }
}

/** E、ν → 线性剪切模量 μ 和 Lamé λ。 E, ν → linear shear modulus μ and Lamé λ. */
export function lame(young: number, poisson: number): { mu: number; lambda: number } {
  return { mu: young / (2 * (1 + poisson)), lambda: (young * poisson) / ((1 + poisson) * (1 - 2 * poisson)) }
}
