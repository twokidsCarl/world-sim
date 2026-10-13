// 肌肉活动模型：姿势 → 作用线长度变化（几何）→ 重力关节力矩 → 肌肉力臂 → 静力优化的激活度（估计）。
// 纯数据，不依赖 three.js 和界面；离线工具、测试和运行时共用。
// The muscle-activity model: pose → length change of the lines of action (geometry) → gravitational joint
// torques → muscle moment arms → activations by static optimisation (an estimate). Pure data, no three.js and
// no UI; shared by the offline tool, the tests and the runtime.
//
// 力学 / Mechanics
//   · 广义力用虚功写：自由度 d 上的外力广义力 Q_d = Σ F·∂p/∂θ_d，其中 ∂p/∂θ_d = a_d × (p − c_d)（p 在该关节的子树上时）。
//     对子树求和后 Q_d = a_d·(N − c_d × F)，N = Σ p × F，F = Σ F，一次自底向上的遍历即可。
//     Generalised forces by virtual work: at dof d the external forces give Q_d = Σ F·∂p/∂θ_d with
//     ∂p/∂θ_d = a_d × (p − c_d) for points on the joint's subtree. Summed over the subtree,
//     Q_d = a_d·(N − c_d × F) with N = Σ p × F and F = Σ F: one bottom-up pass over the tree.
//   · 肌肉力臂用肌腱位移法：r_id = −∂L_i/∂θ_d。路径长度对各点位置的导数是解析的，所以这里直接求导而不做差分；
//     tests/activity.test.ts 用 tools/rig/pose.ts 上的有限差分核对。
//     Muscle moment arms by tendon excursion: r_id = −∂L_i/∂θ_d. The derivative of a path length with respect to
//     its points is analytic, so it is evaluated directly rather than by differences; tests/activity.test.ts
//     checks it against finite differences on tools/rig/pose.ts.
//   · 被带动的自由度（髌骨随膝）：θ_d = 自身 + ratio·θ_driver，所以它的广义力和力臂按 ratio 并入驱动自由度。
//     A driven dof (patella with the knee): θ_d = own + ratio·θ_driver, so its generalised force and moment
//     arms are folded into the driver dof by the ratio.
//   · 平衡：Σ_i a_i·Fmax_i·r_id = τ_d = −Q_d。求 min Σ a_i²（见 solver.ts），肌肉给不出的部分作为残差报告。
//     Equilibrium: Σ_i a_i·Fmax_i·r_id = τ_d = −Q_d; minimise Σ a_i² (see solver.ts) and report what the
//     muscles cannot deliver as the residual.
//
// 支撑 / Support
//   站立：身体的重量由着地的足底点承担。地面反力竖直向上、合力等于体重，压力中心取支撑多边形内离重心投影最近的点，
//   按最小范数分到各接触点上。重心投影落在支撑面之外时姿势本身站不住，偏出的距离会报告出来。
//   卧位（仰卧 / 俯卧）：骨盆和没有被摆动过的肢体由床面托住，它们的关节不需要肌肉力矩；
//   只有被抬起来的那一串关节（自身或上游有关节离开静止角度）参与平衡。
//   Standing: body weight is carried by the sole points on the ground. The ground reaction is vertical and equal
//   to the weight; its centre of pressure is the point of the support polygon nearest the projection of the
//   centre of mass, shared between the contact points by minimum norm. When the projection falls outside the
//   support the posture cannot be held as such, and the distance is reported.
//   Lying (supine / prone): the pelvis and every limb that was not moved rest on the couch and need no muscle
//   torque; only chains that were lifted (a joint on the way from the pelvis is away from its rest angle) are
//   balanced.

import { axisAngle, m3mul, type M3, type V3, type Xf } from '../../tools/rig/math.ts'
import { effectiveAngles, jointFrames, type JointFrames, type Pose } from '../../tools/rig/pose.ts'
import type { Joint, MuscleLine } from '../anatomy/types.ts'
import { solveBounded, Workspace, type BoundedLsq, type SolveStats } from './solver.ts'
import type { ActivityData, AnchoredPoint, GravityMode, HandLoad } from './types.ts'

/** 运行时按姿势加上的标记位 / Pose-dependent flag bits added at run time. */
export const FLAG_NEAR = 1
export const FLAG_FLIP = 2

/** 自由度在平衡里的角色 / The role of a dof in the balance. */
export const enum DofStatus {
  /** 不是方程（被带动的自由度）/ not an equation (a driven dof) */
  None = 0,
  /** 由肌肉平衡 / balanced by muscles */
  Active = 1,
  /** 在活动范围的极限上，力矩推向极限：算被动结构承担 / at a limit with the torque pushing into it: carried passively */
  Limit = 2,
  /** 卧位时由床面托住 / resting on the couch when lying */
  Supported = 3,
  /** 不参与平衡的关节（肋等）/ a joint left out of the balance (ribs …) */
  Locked = 4,
  /** 根关节（骨盆）：这里的"力矩"是整体平衡的残差 / the root (pelvis): its "torque" is the residual of whole-body balance */
  Root = 5,
  /** 没有肌肉跨过这个自由度 / no muscle spans this dof */
  NoMuscle = 6,
}

export interface DofInfo {
  joint: number
  k: number
  /** 驱动它的自由度（全局下标）或 −1 / The global index of its driver dof, or −1. */
  driver: number
  ratio: number
}

/**
 * 平衡方程的一行：一个自由度，或一组按同样方式一起转动的自由度（如五个腰椎关节的屈伸）。成组时只要求肌肉平衡这一段脊柱上的
 * 平均力矩（各节各转 δθ/n 的虚功），节与节之间怎么分担留给椎间盘和韧带。
 * One row of the balance: a single dof, or a group of dofs that turn together in the same way (flexion of the five
 * lumbar joints, say). For a group the muscles are only asked to balance the mean torque over that stretch of the
 * spine (the virtual work of each level turning by δθ/n); how the levels share it is left to discs and ligaments.
 */
export interface BalanceUnit {
  /** 成员自由度（全局下标）；单个自由度时只有一个 / Member dofs (global indices); one for a single dof. */
  dofs: number[]
  /** 成组时的组 id 和名称 / Group id and name when it is a group. */
  group?: { id: string; name: { zh: string; en: string } }
}

export interface EvalOptions {
  gravity?: GravityMode
  load?: HandLoad | null
  /** 当前体重（千克）；缺省用数据里的默认体重 / Current body mass in kg; the data's default when absent. */
  bodyKg?: number
  /** 只算几何层（长度），不求解 / Geometry only (lengths), no solve. */
  lengthsOnly?: boolean
  /** 不用上一次的解做初值（测试确定性用）/ Do not start from the previous solution (for determinism tests). */
  cold?: boolean
  /**
   * 这一次最多做几轮活动集迭代。拖动滑块时给一个小的数（每轮约 0.2 ms），没收敛的部分留给下一次从当前解接着做；
   * 结果里的 stats.converged 说明是否已收敛。缺省做到收敛为止。
   * The most active-set rounds to run this time. While a slider is dragged a small number is given (a round costs
   * about 0.2 ms) and what did not converge is continued from the current solution next time; stats.converged in
   * the result says whether it has. By default it runs to convergence.
   */
  maxOuter?: number
}

export interface Balance {
  /** 着地的脚 / Feet on the ground. */
  feet: ('L' | 'R')[]
  /** 着地的接触点数 / Number of contact points bearing load. */
  contacts: number
  /** 重心投影到压力中心的水平距离（米）；0 表示落在支撑面内 / Horizontal distance from the projection of the centre of mass to the centre of pressure (m); 0 = inside the support. */
  offsetM: number
  /** 偏出的方向在身体坐标系里的水平分量（+Z 向前，+X 向左）/ Direction of the offset in the body frame (+Z anterior, +X left). */
  offsetDir: [number, number]
  weightN: number
  com: V3
}

export interface ActivityResult {
  version: number
  gravity: GravityMode
  /** 是否算了第二层 / Whether layer 2 was computed. */
  solved: boolean
  /** 每条肌肉（下标同 ActivityModel.muscles）/ Per muscle (indexed as ActivityModel.muscles). */
  length: Float32Array
  /** 相对静止姿势、相对解剖学零位的长度变化（比值 − 1）/ Length change relative to rest and to the anatomical zero (ratio − 1). */
  dRest: Float32Array
  dNeutral: Float32Array
  activation: Float32Array
  flags: Uint8Array
  /** 每个平衡单元（下标同 ActivityModel.units）/ Per balance unit (indexed as ActivityModel.units). */
  required: Float32Array
  delivered: Float32Array
  residual: Float32Array
  status: Uint8Array
  balance: Balance | null
  /** 活动自由度上残差绝对值之和与要求力矩绝对值之和 / Sum of |residual| and of |required| over the active dofs. */
  residualSum: number
  requiredSum: number
  stats: SolveStats | null
  ms: number
}

interface ModelMuscle {
  part: string
  name: string
  line: number
  fmax: number
  /** 路径点（静止位置）与所在关节下标 / Path points (rest) and their joints. */
  pts: Float64Array
  ptJoint: Int32Array
  rest: number
  neutral: number
  /** 影响长度的自由度（全局下标）及每个自由度带动哪些点（位掩码）/ Dofs that change the length (global) and which points each moves (bit mask). */
  dofs: Int32Array
  mask: Int32Array
  /** 解剖学零位下各自由度的力臂（判断变号用）/ Moment arms at the anatomical zero (to detect a sign change). */
  arm0: Float32Array
  /** 所跨的关节（判断是否贴近关节中心）/ Joints spanned (for the near-centre test). */
  spans: Int32Array
}

const cross = (a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number, out: Float64Array, oo: number): void => {
  const x = a[ao + 1]! * b[bo + 2]! - a[ao + 2]! * b[bo + 1]!
  const y = a[ao + 2]! * b[bo]! - a[ao]! * b[bo + 2]!
  const z = a[ao]! * b[bo + 1]! - a[ao + 1]! * b[bo]!
  out[oo] = x
  out[oo + 1] = y
  out[oo + 2] = z
}

/** 重力方向（身体坐标系，单位向量）：站立向下（−Y），仰卧向后（−Z），俯卧向前（+Z）。 */
/** Gravity direction in the body frame (unit): down (−Y) standing, posterior (−Z) supine, anterior (+Z) prone. */
export function gravityDirection(mode: GravityMode): V3 {
  return mode === 'supine' ? [0, 0, -1] : mode === 'prone' ? [0, 0, 1] : [0, -1, 0]
}

/**
 * 绑定的签名：关节（id、父、中心、轴、自由度）和肌肉作用线的 FNV-1a 哈希，数值取到 0.01 mm。activity.json 记下它所依据的
 * 绑定的签名，运行时比对；绑定重新生成之后不一致，就要求重新生成 activity.json。
 * Signature of a rig: an FNV-1a hash of the joints (id, parent, centre, axes, dofs) and the muscle lines, numbers
 * to 0.01 mm. activity.json records the signature of the rig it was built for and the runtime compares; after a
 * rig rebuild they differ and activity.json must be regenerated.
 */
export function rigSignature(rig: { joints: Joint[]; muscles: MuscleLine[] }): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
      h2 = Math.imul(h2 ^ (c + 0x9e37), 0x85ebca6b) >>> 0
    }
  }
  const num = (v: number): string => String(Math.round(v * 1e5))
  for (const j of rig.joints) {
    feed(`${j.id}|${j.parent ?? ''}|${j.center.map(num).join(',')}|${j.axes.map((a) => a.map(num).join(',')).join(';')}|`)
    for (const d of j.dofs) feed(`${d.axis},${num(d.min)},${num(d.max)},${num(d.neutral ?? 0)},${d.driver ? `${d.driver.joint}.${d.driver.dof}*${num(d.driver.ratio)}` : ''}|`)
  }
  for (const m of rig.muscles) feed(`${m.part}|${m.origin.joint}|${m.origin.point.map(num).join(',')}|${m.insertion.joint}|${m.insertion.point.map(num).join(',')}|`)
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/** 没有 activity.json 时只做第一层：用绑定里的作用线拼出一份最小的数据 / Without activity.json only layer 1 exists: a minimal data set made from the rig's lines. */
export function linesOnlyData(rig: { joints: Joint[]; muscles: MuscleLine[] }, names?: (part: string) => string): Pick<ActivityData, 'muscles'> {
  return {
    muscles: rig.muscles.map((m, i) => ({ part: m.part, name: names?.(m.part) ?? m.part, line: i, path: [m.origin, m.insertion], volumeCm3: 0, fibreM: 0, fibreBasis: '', pcsaCm2: 0, fmaxN: 0, flags: [] })),
  }
}

export class ActivityModel {
  readonly joints: Joint[]
  readonly jointIndex: Map<string, number>
  readonly parent: Int32Array
  /** 父在前的遍历顺序 / An order with parents before children. */
  readonly order: Int32Array
  private readonly tin: Int32Array
  private readonly tout: Int32Array
  readonly dofs: DofInfo[]
  readonly dofStart: Int32Array
  /** 平衡方程的各行，以及每个自由度属于哪一行、以多大的权重计入 / The rows of the balance, and which row every dof belongs to and with what weight. */
  readonly units: BalanceUnit[]
  readonly unitOf: Int32Array
  private readonly unitW: Float64Array
  private readonly reqDof: Float64Array
  readonly muscles: ModelMuscle[]
  /** 能否做第二层（有质量和肌力数据）/ Whether layer 2 is possible (mass and strength data present). */
  readonly full: boolean
  private readonly locked: Uint8Array
  private readonly segJoint: Int32Array
  private readonly segKg: Float64Array
  private readonly segCom: Float64Array
  private readonly bodyKg: number
  private readonly contacts: { joint: number; p: V3; side: 'L' | 'R' }[]
  private readonly hands: { L: { joint: number; p: V3 } | null; R: { joint: number; p: V3 } | null }
  private readonly prm: ActivityData['params']

  // 每次求值复用的缓冲 / buffers reused on every evaluation
  private readonly cw: Float64Array
  private readonly aw: Float64Array
  private readonly angles: Float64Array
  private readonly Fj: Float64Array
  private readonly Nj: Float64Array
  private readonly arms: Float32Array
  private readonly armStart: Int32Array
  private readonly ptsW: Float64Array
  private readonly grad: Float64Array
  private readonly tmp = new Float64Array(12)
  private readonly ws = new Workspace()
  private readonly x: Float64Array
  private readonly posed: Uint8Array
  private readonly rowOf: Int32Array
  private lsq: BoundedLsq | null = null
  private colMuscle = new Int32Array(0)
  private rowDof = new Int32Array(0)
  private version = 0
  readonly result: ActivityResult

  constructor(rig: { joints: Joint[] }, data: Pick<ActivityData, 'muscles'> & Partial<ActivityData>) {
    const joints = (this.joints = rig.joints)
    const nJ = joints.length
    this.jointIndex = new Map(joints.map((j, i) => [j.id, i]))
    this.parent = Int32Array.from(joints, (j) => (j.parent === null ? -1 : (this.jointIndex.get(j.parent) ?? -1)))
    // 欧拉遍历：tin/tout 用来 O(1) 判断"J 是否是 B 的祖先或自身"
    // Euler tour: tin/tout answer "is J an ancestor of B, or B itself" in O(1)
    const children: number[][] = joints.map(() => [])
    const roots: number[] = []
    this.parent.forEach((p, i) => (p < 0 ? roots.push(i) : children[p]!.push(i)))
    this.order = new Int32Array(nJ)
    this.tin = new Int32Array(nJ)
    this.tout = new Int32Array(nJ)
    let t = 0
    const stack: [number, number][] = roots.map((r) => [r, 0] as [number, number]).reverse()
    while (stack.length) {
      const top = stack[stack.length - 1]!
      const [j, c] = top
      if (c === 0) {
        this.order[t] = j
        this.tin[j] = t++
      }
      const ch = children[j]!
      if (c < ch.length) {
        top[1] = c + 1
        stack.push([ch[c]!, 0])
      } else {
        this.tout[j] = t
        stack.pop()
      }
    }
    // 自由度 / dofs
    this.dofStart = new Int32Array(nJ + 1)
    this.dofs = []
    joints.forEach((j, i) => {
      this.dofStart[i] = this.dofs.length
      j.dofs.forEach((_, k) => this.dofs.push({ joint: i, k, driver: -1, ratio: 0 }))
    })
    this.dofStart[nJ] = this.dofs.length
    for (const d of this.dofs) {
      const drv = joints[d.joint]!.dofs[d.k]!.driver
      if (!drv) continue
      const dj = this.jointIndex.get(drv.joint)
      if (dj === undefined || !joints[dj]!.dofs[drv.dof]) continue
      d.driver = this.dofStart[dj]! + drv.dof
      d.ratio = drv.ratio
    }
    const nD = this.dofs.length
    this.locked = new Uint8Array(nJ)
    for (const id of data.lockedJoints ?? []) {
      const i = this.jointIndex.get(id)
      if (i !== undefined) this.locked[i] = 1
    }

    this.full = !!data.mass && !!data.params
    this.prm = data.params ?? { specificTensionNcm2: 0, g: 9.81, reservePenalty: 1e4, limitTolerance: 0.05, contactTolerance: 0.012, nearCentre: 0.005, bulgeMax: 0.1, displayFull: 0.5 }
    // 平衡单元：先成组，其余的自由度各自一行，被带动的自由度并入驱动它的那一行
    // balance units: groups first, every other dof a row of its own, driven dofs folded into their driver's row
    this.units = []
    this.unitOf = new Int32Array(nD).fill(-1)
    this.unitW = new Float64Array(nD)
    this.reqDof = new Float64Array(nD)
    for (const g of data.dofGroups ?? []) {
      for (const axis of [0, 1, 2]) {
        const members: number[] = []
        for (const id of g.joints) {
          const j = this.jointIndex.get(id)
          if (j === undefined || this.locked[j]) continue
          joints[j]!.dofs.forEach((d, k) => {
            const gi = this.dofStart[j]! + k
            if (d.axis === axis && this.dofs[gi]!.driver < 0 && this.unitOf[gi]! < 0 && d.max - d.min > 1e-6) members.push(gi)
          })
        }
        if (members.length < 2) continue
        for (const d of members) {
          this.unitOf[d] = this.units.length
          this.unitW[d] = 1 / members.length
        }
        this.units.push({ dofs: members, group: { id: g.id, name: g.name } })
      }
    }
    for (let d = 0; d < nD; d++) {
      if (this.unitOf[d]! >= 0 || this.dofs[d]!.driver >= 0) continue
      this.unitOf[d] = this.units.length
      this.unitW[d] = 1
      this.units.push({ dofs: [d] })
    }
    for (let d = 0; d < nD; d++) {
      const info = this.dofs[d]!
      if (info.driver < 0) continue
      this.unitOf[d] = this.unitOf[info.driver]!
      this.unitW[d] = info.ratio * this.unitW[info.driver]!
    }
    const nU = this.units.length
    const segs = (data.mass?.segments ?? []).filter((s) => this.jointIndex.has(s.joint))
    this.segJoint = Int32Array.from(segs, (s) => this.jointIndex.get(s.joint)!)
    this.segKg = Float64Array.from(segs, (s) => s.kg)
    this.segCom = new Float64Array(segs.length * 3)
    segs.forEach((s, i) => this.segCom.set(s.com, i * 3))
    this.bodyKg = data.mass?.bodyKg ?? 0
    this.contacts = (data.contacts ?? []).filter((c) => this.jointIndex.has(c.joint)).map((c) => ({ joint: this.jointIndex.get(c.joint)!, p: c.point as V3, side: c.side }))
    const hand = (h: AnchoredPoint | undefined): { joint: number; p: V3 } | null => (h && this.jointIndex.has(h.joint) ? { joint: this.jointIndex.get(h.joint)!, p: h.point as V3 } : null)
    this.hands = { L: hand(data.hands?.L), R: hand(data.hands?.R) }

    // 肌肉：路径、受哪些自由度影响 / muscles: paths and the dofs that change their length
    this.muscles = []
    let armCount = 0, maxPts = 2
    for (const m of data.muscles) {
      const ptJoint = Int32Array.from(m.path, (p) => this.jointIndex.get(p.joint) ?? -1)
      if (m.path.length < 2 || m.path.length > 30 || ptJoint.some((j) => j < 0)) continue
      const pts = new Float64Array(m.path.length * 3)
      m.path.forEach((p, k) => pts.set(p.point, k * 3))
      const dofs: number[] = [], mask: number[] = []
      const spans = new Set<number>()
      for (let j = 0; j < nJ; j++) {
        if (this.dofStart[j + 1] === this.dofStart[j]) continue
        let bits = 0
        for (let k = 0; k < ptJoint.length; k++) if (this.isAncestor(j, ptJoint[k]!)) bits |= 1 << k
        // 一个点都不带、或者全部都带（整条肌肉刚体运动）的关节不改变长度
        // a joint that moves none of the points, or all of them (the whole muscle rigidly), does not change the length
        if (bits === 0 || bits === (1 << ptJoint.length) - 1) continue
        spans.add(j)
        for (let d = this.dofStart[j]!; d < this.dofStart[j + 1]!; d++) {
          dofs.push(d)
          mask.push(bits)
        }
      }
      this.muscles.push({ part: m.part, name: m.name, line: m.line, fmax: m.fmaxN, pts, ptJoint, rest: 0, neutral: 0, dofs: Int32Array.from(dofs), mask: Int32Array.from(mask), arm0: new Float32Array(dofs.length), spans: Int32Array.from(spans) })
      armCount += dofs.length
      maxPts = Math.max(maxPts, m.path.length)
    }
    const nM = this.muscles.length
    this.armStart = new Int32Array(nM + 1)
    this.muscles.forEach((m, i) => (this.armStart[i + 1] = this.armStart[i]! + m.dofs.length))
    this.arms = new Float32Array(armCount)
    this.ptsW = new Float64Array(maxPts * 3)
    this.grad = new Float64Array(maxPts * 3)
    this.cw = new Float64Array(nJ * 3)
    this.aw = new Float64Array(nD * 3)
    this.angles = new Float64Array(nD)
    this.Fj = new Float64Array(nJ * 3)
    this.Nj = new Float64Array(nJ * 3)
    this.x = new Float64Array(nM)
    this.posed = new Uint8Array(nJ)
    this.rowOf = new Int32Array(nU)
    this.result = {
      version: 0, gravity: 'stand', solved: false,
      length: new Float32Array(nM), dRest: new Float32Array(nM), dNeutral: new Float32Array(nM), activation: new Float32Array(nM), flags: new Uint8Array(nM),
      required: new Float32Array(nU), delivered: new Float32Array(nU), residual: new Float32Array(nU), status: new Uint8Array(nU),
      balance: null, residualSum: 0, requiredSum: 0, stats: null, ms: 0,
    }
    // 静止长度，解剖学零位下的长度和力臂 / rest lengths, and lengths and moment arms at the anatomical zero
    this.kinematics({}, jointFrames(joints, {}))
    this.muscles.forEach((m, i) => (m.rest = this.pathLength(i, null)))
    const neutral: Pose = {}
    for (const j of joints) if (j.dofs.some((d) => (d.neutral ?? 0) !== 0)) neutral[j.id] = j.dofs.map((d) => Math.min(d.max, Math.max(d.min, d.neutral ?? 0)))
    this.kinematics(neutral, jointFrames(joints, neutral))
    this.muscles.forEach((m, i) => {
      m.neutral = this.pathLength(i, this.arms.subarray(this.armStart[i]!, this.armStart[i + 1]!))
      m.arm0.set(this.arms.subarray(this.armStart[i]!, this.armStart[i + 1]!))
    })
  }

  /** J 是 B 的祖先或就是 B / J is an ancestor of B or B itself. */
  isAncestor(j: number, b: number): boolean {
    return this.tin[j]! <= this.tin[b]! && this.tin[b]! < this.tout[j]!
  }

  /** 某个关节自由度所在的平衡单元（没有则 −1）/ The balance unit of a joint dof (−1 when there is none). */
  unitIndex(joint: string, k: number): number {
    const d = this.dofIndex(joint, k)
    return d < 0 ? -1 : this.unitOf[d]!
  }

  dofIndex(joint: string, k: number): number {
    const j = this.jointIndex.get(joint)
    return j === undefined || k < 0 || k >= this.joints[j]!.dofs.length ? -1 : this.dofStart[j]! + k
  }

  /** 关节中心和各自由度轴在当前姿势下的世界坐标 / World joint centres and dof axes in the current pose. */
  private kinematics(pose: Pose, frames: JointFrames): void {
    const joints = this.joints
    const eff = effectiveAngles(joints, pose)
    const xfs = frames.xfs, rigid = frames.rigid
    for (let j = 0; j < joints.length; j++) {
      const J = joints[j]!
      const m = xfs[j]!
      const c = J.center
      this.cw[j * 3] = m.r[0] * c[0] + m.r[1] * c[1] + m.r[2] * c[2] + m.t[0]
      this.cw[j * 3 + 1] = m.r[3] * c[0] + m.r[4] * c[1] + m.r[5] * c[2] + m.t[1]
      this.cw[j * 3 + 2] = m.r[6] * c[0] + m.r[7] * c[1] + m.r[8] * c[2] + m.t[2]
      // 自由度 k 的轴随父关节和前 k 个自由度转动（见 Joint.dofs 的复合顺序）
      // the axis of dof k turns with the parent and the first k dofs (composition order as on Joint.dofs)
      const p = this.parent[j]!
      let r: M3 | null = p >= 0 ? rigid[p]!.r : null
      const a = eff[j]!
      for (let k = 0; k < J.dofs.length; k++) {
        const ax = J.axes[J.dofs[k]!.axis] as V3
        const o = (this.dofStart[j]! + k) * 3
        if (r) {
          this.aw[o] = r[0] * ax[0] + r[1] * ax[1] + r[2] * ax[2]
          this.aw[o + 1] = r[3] * ax[0] + r[4] * ax[1] + r[5] * ax[2]
          this.aw[o + 2] = r[6] * ax[0] + r[7] * ax[1] + r[8] * ax[2]
        } else {
          this.aw[o] = ax[0]
          this.aw[o + 1] = ax[1]
          this.aw[o + 2] = ax[2]
        }
        const ang = a[k] ?? 0
        this.angles[this.dofStart[j]! + k] = ang
        if (ang !== 0 && k + 1 < J.dofs.length) {
          const rot = axisAngle(ax, ang)
          r = r ? m3mul(r, rot) : rot
        }
      }
    }
    this.frames = xfs
  }
  private frames: Xf[] = []

  /** 第 i 条肌肉的路径长度；给出 `arms` 时同时写入各自由度的力臂（−∂L/∂θ）。 */
  /** Path length of muscle i; with `arms`, also writes the moment arm at each of its dofs (−∂L/∂θ). */
  private pathLength(i: number, arms: Float32Array | null): number {
    const m = this.muscles[i]!
    const n = m.ptJoint.length
    const w = this.ptsW, g = this.grad
    for (let k = 0; k < n; k++) {
      const x = this.frames[m.ptJoint[k]!]!
      const px = m.pts[k * 3]!, py = m.pts[k * 3 + 1]!, pz = m.pts[k * 3 + 2]!
      w[k * 3] = x.r[0] * px + x.r[1] * py + x.r[2] * pz + x.t[0]
      w[k * 3 + 1] = x.r[3] * px + x.r[4] * py + x.r[5] * pz + x.t[1]
      w[k * 3 + 2] = x.r[6] * px + x.r[7] * py + x.r[8] * pz + x.t[2]
      g[k * 3] = g[k * 3 + 1] = g[k * 3 + 2] = 0
    }
    let L = 0
    for (let k = 0; k + 1 < n; k++) {
      const dx = w[k * 3 + 3]! - w[k * 3]!, dy = w[k * 3 + 4]! - w[k * 3 + 1]!, dz = w[k * 3 + 5]! - w[k * 3 + 2]!
      const l = Math.hypot(dx, dy, dz)
      L += l
      if (l > 1e-9) {
        // ∂L/∂p_{k+1} += u，∂L/∂p_k −= u
        g[k * 3 + 3] = g[k * 3 + 3]! + dx / l
        g[k * 3 + 4] = g[k * 3 + 4]! + dy / l
        g[k * 3 + 5] = g[k * 3 + 5]! + dz / l
        g[k * 3] = g[k * 3]! - dx / l
        g[k * 3 + 1] = g[k * 3 + 1]! - dy / l
        g[k * 3 + 2] = g[k * 3 + 2]! - dz / l
      }
    }
    if (arms) {
      const tmp = this.tmp
      for (let q = 0; q < m.dofs.length; q++) {
        const d = m.dofs[q]!
        const j = this.dofs[d]!.joint
        const bits = m.mask[q]!
        let dL = 0
        for (let k = 0; k < n; k++) {
          if (!(bits & (1 << k))) continue
          tmp[0] = w[k * 3]! - this.cw[j * 3]!
          tmp[1] = w[k * 3 + 1]! - this.cw[j * 3 + 1]!
          tmp[2] = w[k * 3 + 2]! - this.cw[j * 3 + 2]!
          cross(this.aw, d * 3, tmp, 0, tmp, 3)
          dL += tmp[3]! * g[k * 3]! + tmp[4]! * g[k * 3 + 1]! + tmp[5]! * g[k * 3 + 2]!
        }
        arms[q] = -dL
      }
    }
    return L
  }

  /** 关节中心到第 i 条肌肉路径的最短距离（pathLength 之后调用）/ Shortest distance from a joint centre to the path of muscle i (call after pathLength). */
  private centreDistance(i: number, j: number): number {
    const n = this.muscles[i]!.ptJoint.length
    const w = this.ptsW
    const cx = this.cw[j * 3]!, cy = this.cw[j * 3 + 1]!, cz = this.cw[j * 3 + 2]!
    let best = Infinity
    for (let k = 0; k + 1 < n; k++) {
      const ax = w[k * 3]!, ay = w[k * 3 + 1]!, az = w[k * 3 + 2]!
      const dx = w[k * 3 + 3]! - ax, dy = w[k * 3 + 4]! - ay, dz = w[k * 3 + 5]! - az
      const l2 = dx * dx + dy * dy + dz * dz
      const s = l2 > 0 ? Math.min(1, Math.max(0, ((cx - ax) * dx + (cy - ay) * dy + (cz - az) * dz) / l2)) : 0
      best = Math.min(best, Math.hypot(ax + s * dx - cx, ay + s * dy - cy, az + s * dz - cz))
    }
    return best
  }

  private addForce(j: number, px: number, py: number, pz: number, fx: number, fy: number, fz: number): void {
    const F = this.Fj, N = this.Nj
    F[j * 3] = F[j * 3]! + fx
    F[j * 3 + 1] = F[j * 3 + 1]! + fy
    F[j * 3 + 2] = F[j * 3 + 2]! + fz
    N[j * 3] = N[j * 3]! + (py * fz - pz * fy)
    N[j * 3 + 1] = N[j * 3 + 1]! + (pz * fx - px * fz)
    N[j * 3 + 2] = N[j * 3 + 2]! + (px * fy - py * fx)
  }

  private world(j: number, p: ArrayLike<number>, o: number, out: Float64Array): void {
    const x = this.frames[j]!
    const px = p[o]!, py = p[o + 1]!, pz = p[o + 2]!
    out[0] = x.r[0] * px + x.r[1] * py + x.r[2] * pz + x.t[0]
    out[1] = x.r[3] * px + x.r[4] * py + x.r[5] * pz + x.t[1]
    out[2] = x.r[6] * px + x.r[7] * py + x.r[8] * pz + x.t[2]
  }

  /**
   * 对一个姿势求值。`frames` 可传入已算好的关节变换（查看器已经有了），否则在这里算。返回的结果对象是复用的。
   * Evaluate a pose. `frames` may carry joint transforms already computed (the viewer has them); otherwise they
   * are computed here. The returned result object is reused between calls.
   */
  evaluate(pose: Pose, frames?: JointFrames | null, opts: EvalOptions = {}): ActivityResult {
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0
    const res = this.result
    const nM = this.muscles.length, nD = this.dofs.length, nU = this.units.length
    this.kinematics(pose, frames ?? jointFrames(this.joints, pose))
    const gravity = opts.gravity ?? 'stand'
    const solve = this.full && !opts.lengthsOnly
    res.version = ++this.version
    res.gravity = gravity
    res.solved = solve
    // 第一层：长度；顺带算力臂和按姿势的标记 / layer 1: lengths; moment arms and pose-dependent flags on the way
    for (let i = 0; i < nM; i++) {
      const m = this.muscles[i]!
      const arms = this.arms.subarray(this.armStart[i]!, this.armStart[i + 1]!)
      const L = this.pathLength(i, arms)
      res.length[i] = L
      res.dRest[i] = m.rest > 1e-6 ? L / m.rest - 1 : 0
      res.dNeutral[i] = m.neutral > 1e-6 ? L / m.neutral - 1 : 0
      let f = 0
      for (let q = 0; q < m.spans.length; q++) if (this.centreDistance(i, m.spans[q]!) < this.prm.nearCentre) f |= FLAG_NEAR
      for (let q = 0; q < arms.length; q++) if (Math.abs(m.arm0[q]!) > 0.005 && Math.abs(arms[q]!) > 0.002 && Math.sign(arms[q]!) !== Math.sign(m.arm0[q]!)) f |= FLAG_FLIP
      res.flags[i] = f
    }
    if (!solve) {
      res.activation.fill(0)
      res.required.fill(0)
      res.delivered.fill(0)
      res.residual.fill(0)
      res.status.fill(0)
      res.balance = null
      res.stats = null
      res.residualSum = res.requiredSum = 0
      res.ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0
      return res
    }

    // 外力：各节段的重力、手上的负荷、站立时的地面反力 / external forces: segment weights, hand loads, ground reaction when standing
    const g = this.prm.g
    const dir = gravityDirection(gravity)
    const scale = opts.bodyKg && this.bodyKg > 0 ? opts.bodyKg / this.bodyKg : 1
    this.Fj.fill(0)
    this.Nj.fill(0)
    const p = this.tmp
    let W = 0, cx = 0, cy = 0, cz = 0
    for (let s = 0; s < this.segJoint.length; s++) {
      const w = this.segKg[s]! * scale * g
      this.world(this.segJoint[s]!, this.segCom, s * 3, p)
      this.addForce(this.segJoint[s]!, p[0]!, p[1]!, p[2]!, dir[0] * w, dir[1] * w, dir[2] * w)
      W += w
      cx += w * p[0]!
      cy += w * p[1]!
      cz += w * p[2]!
    }
    const load = opts.load && opts.load.kg > 0 ? opts.load : null
    if (load) {
      for (const side of ['L', 'R'] as const) {
        const h = this.hands[side]
        if (!h || (load.side !== 'B' && load.side !== side)) continue
        const w = load.kg * g
        this.world(h.joint, h.p, 0, p)
        this.addForce(h.joint, p[0]!, p[1]!, p[2]!, dir[0] * w, dir[1] * w, dir[2] * w)
        W += w
        cx += w * p[0]!
        cy += w * p[1]!
        cz += w * p[2]!
      }
    }
    if (W > 0) {
      cx /= W
      cy /= W
      cz /= W
    }
    res.balance = gravity === 'stand' ? this.groundReaction(W, [cx, cy, cz], dir) : null

    // 自底向上累加子树上的合力与合力矩 / accumulate the subtree force and moment bottom-up
    for (let q = this.order.length - 1; q >= 0; q--) {
      const j = this.order[q]!
      const par = this.parent[j]!
      if (par < 0) continue
      for (let c = 0; c < 3; c++) {
        this.Fj[par * 3 + c] = this.Fj[par * 3 + c]! + this.Fj[j * 3 + c]!
        this.Nj[par * 3 + c] = this.Nj[par * 3 + c]! + this.Nj[j * 3 + c]!
      }
    }
    // 要求的肌肉力矩 τ_d = −Q_d，Q_d = a_d·(N − c × F) / required muscle torque τ_d = −Q_d, Q_d = a_d·(N − c × F)
    const req = res.required
    req.fill(0)
    for (let d = 0; d < nD; d++) {
      const j = this.dofs[d]!.joint
      cross(this.cw, j * 3, this.Fj, j * 3, p, 0)
      const q = -(this.aw[d * 3]! * (this.Nj[j * 3]! - p[0]!) + this.aw[d * 3 + 1]! * (this.Nj[j * 3 + 1]! - p[1]!) + this.aw[d * 3 + 2]! * (this.Nj[j * 3 + 2]! - p[2]!))
      this.reqDof[d] = q
      req[this.unitOf[d]!] = req[this.unitOf[d]!]! + this.unitW[d]! * q
    }

    // 卧位：哪些关节被抬离了床面 / lying: which joints were lifted off the couch
    const lying = gravity !== 'stand'
    if (lying) {
      for (let q = 0; q < this.order.length; q++) {
        const j = this.order[q]!
        const par = this.parent[j]!
        let moved = par >= 0 && this.posed[par] === 1
        if (!moved && par >= 0) for (let d = this.dofStart[j]!; d < this.dofStart[j + 1]!; d++) if (Math.abs(this.angles[d]!) > 0.0175) moved = true
        this.posed[j] = moved ? 1 : 0
      }
    }
    // 每个自由度的角色，以及方程的行号 / the role of every dof and its row
    const status = res.status
    let rows = 0
    const tol = this.prm.limitTolerance
    for (let u = 0; u < nU; u++) {
      const unit = this.units[u]!
      const d = unit.dofs[0]!
      const info = this.dofs[d]!
      const dof = this.joints[info.joint]!.dofs[info.k]!
      this.rowOf[u] = -1
      res.delivered[u] = 0
      res.residual[u] = 0
      let st: DofStatus = DofStatus.Active
      if (unit.group) {
        // 成组的自由度：卧位时只要有一节被抬起就参与平衡；不做"到极限"的判断
        // a group: when lying it is balanced as soon as one level was lifted; no end-of-range test
        if (lying && !unit.dofs.some((e) => this.posed[this.dofs[e]!.joint])) st = DofStatus.Supported
      } else if (this.parent[info.joint]! < 0) st = DofStatus.Root
      else if (this.locked[info.joint] || dof.max - dof.min < 1e-6) st = DofStatus.Locked
      else if (lying && !this.posed[info.joint]) st = DofStatus.Supported
      else if ((this.angles[d]! <= dof.min + tol && req[u]! > 0) || (this.angles[d]! >= dof.max - tol && req[u]! < 0)) st = DofStatus.Limit
      status[u] = st
      if (st === DofStatus.Active) this.rowOf[u] = rows++
    }

    // 组装稀疏矩阵：列 = 肌肉，行 = 活动自由度 / assemble the sparse matrix: columns = muscles, rows = active dofs
    const nnzMax = this.arms.length
    let lsq = this.lsq
    if (!lsq || lsq.val.length < nnzMax) {
      lsq = this.lsq = { n: 0, m: 0, colStart: new Int32Array(nM + 1), row: new Int32Array(nnzMax), val: new Float64Array(nnzMax), cost: new Float64Array(nM).fill(1), upper: new Float64Array(nM).fill(1), weight: new Float64Array(nU), rhs: new Float64Array(nU) }
      this.colMuscle = new Int32Array(nM)
      this.rowDof = new Int32Array(nU)
    }
    const cap = lsq.weight
    cap.fill(0, 0, rows)
    let nnz = 0, cols = 0
    for (let i = 0; i < nM; i++) {
      const m = this.muscles[i]!
      if (!(m.fmax > 0)) continue
      const start = nnz
      const a0 = this.armStart[i]!
      for (let q = 0; q < m.dofs.length; q++) {
        const d = m.dofs[q]!
        const v = m.fmax * this.arms[a0 + q]! * this.unitW[d]!
        const r = this.rowOf[this.unitOf[d]!]!
        if (r < 0 || Math.abs(v) < 1e-9) continue
        let at = -1
        for (let e = start; e < nnz; e++) if (lsq.row[e] === r) at = e
        if (at >= 0) lsq.val[at] = lsq.val[at]! + v
        else {
          lsq.row[nnz] = r
          lsq.val[nnz++] = v
        }
      }
      if (nnz === start) continue
      for (let e = start; e < nnz; e++) cap[lsq.row[e]!] = cap[lsq.row[e]!]! + Math.abs(lsq.val[e]!)
      this.colMuscle[cols] = i
      lsq.colStart[cols++] = start
    }
    lsq.colStart[cols] = nnz
    lsq.n = cols
    lsq.m = rows
    const kappa = this.prm.reservePenalty
    for (let d = 0; d < nU; d++) {
      const r = this.rowOf[d]!
      if (r < 0) continue
      this.rowDof[r] = d
      lsq.rhs[r] = req[d]!
      if (cap[r]! <= 0) status[d] = DofStatus.NoMuscle
      const c = Math.max(cap[r]!, 0.01)
      lsq.weight[r] = kappa / (c * c)
    }
    const xs = this.xs.length >= cols ? this.xs : (this.xs = new Float64Array(nM))
    for (let c = 0; c < cols; c++) xs[c] = opts.cold ? 0 : this.x[this.colMuscle[c]!]!
    res.stats = solveBounded(lsq, xs, this.ws, { maxOuter: opts.maxOuter })
    this.x.fill(0)
    res.activation.fill(0)
    for (let c = 0; c < cols; c++) {
      const i = this.colMuscle[c]!
      this.x[i] = xs[c]!
      res.activation[i] = xs[c]!
    }
    let rs = 0, qs = 0
    for (let r = 0; r < rows; r++) {
      const d = this.rowDof[r]!
      res.residual[d] = this.ws.res[r]!
      res.delivered[d] = req[d]! - this.ws.res[r]!
      rs += Math.abs(this.ws.res[r]!)
      qs += Math.abs(req[d]!)
    }
    res.residualSum = rs
    res.requiredSum = qs
    res.ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0
    return res
  }
  private xs = new Float64Array(0)

  /**
   * 站立：找出着地的足底点，把等于体重的竖直反力分给它们，使压力中心尽量落在重心投影上。
   * Standing: find the sole points on the ground and share a vertical reaction equal to the weight between
   * them so that the centre of pressure lies as near the projection of the centre of mass as it can.
   */
  private groundReaction(W: number, com: V3, dir: V3): Balance | null {
    const n = this.contacts.length
    if (n === 0 || !(W > 0)) return null
    const P = new Float64Array(n * 3)
    const h = new Float64Array(n)
    const p = this.tmp
    let lowest = Infinity
    for (let k = 0; k < n; k++) {
      const c = this.contacts[k]!
      this.world(c.joint, c.p, 0, p)
      P.set([p[0]!, p[1]!, p[2]!], k * 3)
      // 高度 = 逆重力方向的坐标 / height = the coordinate against gravity
      h[k] = -(p[0]! * dir[0] + p[1]! * dir[1] + p[2]! * dir[2])
      lowest = Math.min(lowest, h[k]!)
    }
    // 一只脚算着地：它最低的点不比全身最低的点高出两倍容差；着地的脚上，离它自己最低点不超过容差的点受力
    // （两只脚各自判断：两条腿长度略有不同的人体不至于被算成单脚站立）
    // a foot is on the ground when its lowest point is within twice the tolerance of the lowest point overall; on such
    // a foot the points within the tolerance of its own lowest point bear load (each foot judged by itself, so that a
    // body whose legs differ slightly in length is not taken to stand on one foot)
    const tolC = this.prm.contactTolerance
    const footLow = { L: Infinity, R: Infinity }
    for (let k = 0; k < n; k++) footLow[this.contacts[k]!.side] = Math.min(footLow[this.contacts[k]!.side], h[k]!)
    const on: number[] = []
    for (let k = 0; k < n; k++) {
      const low = footLow[this.contacts[k]!.side]
      if (low <= lowest + 2 * tolC && h[k]! <= low + tolC) on.push(k)
    }
    // 水平面内的两个坐标（站立时即 X 和 Z）/ two horizontal coordinates (X and Z when standing)
    const e1: V3 = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]
    const dd = e1[0] * dir[0] + e1[1] * dir[1] + e1[2] * dir[2]
    const u: V3 = [e1[0] - dd * dir[0], e1[1] - dd * dir[1], e1[2] - dd * dir[2]]
    const ul = Math.hypot(u[0], u[1], u[2])
    u[0] /= ul
    u[1] /= ul
    u[2] /= ul
    const v: V3 = [dir[1] * u[2] - dir[2] * u[1], dir[2] * u[0] - dir[0] * u[2], dir[0] * u[1] - dir[1] * u[0]]
    const m = on.length
    const a = new Float64Array(m), b = new Float64Array(m)
    on.forEach((k, q) => {
      a[q] = P[k * 3]! * u[0] + P[k * 3 + 1]! * u[1] + P[k * 3 + 2]! * u[2]
      b[q] = P[k * 3]! * v[0] + P[k * 3 + 1]! * v[1] + P[k * 3 + 2]! * v[2]
    })
    const ca = com[0] * u[0] + com[1] * u[1] + com[2] * u[2], cb = com[0] * v[0] + com[1] * v[1] + com[2] * v[2]
    // 单纯形上的投影梯度：min |Σ w_k P_k − C|² + ε Σ w_k²（ε 使负荷在多个可行分配中取最均匀的）
    // projected gradient on the simplex: min |Σ w_k P_k − C|² + ε Σ w_k² (ε picks the most even of the feasible shares)
    const w = new Float64Array(m).fill(1 / m)
    const eps = 1e-4
    let lip = eps
    for (let q = 0; q < m; q++) lip += (a[q]! - ca) ** 2 + (b[q]! - cb) ** 2
    const step = 1 / lip
    const gq = new Float64Array(m), sorted = new Float64Array(m)
    for (let it = 0; it < 400; it++) {
      let ra = -ca, rb = -cb
      for (let q = 0; q < m; q++) {
        ra += w[q]! * a[q]!
        rb += w[q]! * b[q]!
      }
      let change = 0
      for (let q = 0; q < m; q++) gq[q] = w[q]! - step * (ra * a[q]! + rb * b[q]! + eps * w[q]!)
      // 投影到单纯形 / projection onto the simplex
      sorted.set(gq)
      sorted.sort()
      let css = 0, theta = 0
      for (let q = m - 1, cnt = 1; q >= 0; q--, cnt++) {
        css += sorted[q]!
        const tq = (css - 1) / cnt
        if (sorted[q]! - tq > 0) theta = tq
      }
      for (let q = 0; q < m; q++) {
        const nv = Math.max(0, gq[q]! - theta)
        change = Math.max(change, Math.abs(nv - w[q]!))
        w[q] = nv
      }
      if (change < 1e-9) break
    }
    let pa = 0, pb = 0
    const feet = new Set<'L' | 'R'>()
    on.forEach((k, q) => {
      pa += w[q]! * a[q]!
      pb += w[q]! * b[q]!
      if (w[q]! > 1e-6) feet.add(this.contacts[k]!.side)
      const f = w[q]! * W
      this.addForce(this.contacts[k]!.joint, P[k * 3]!, P[k * 3 + 1]!, P[k * 3 + 2]!, -dir[0] * f, -dir[1] * f, -dir[2] * f)
    })
    const off = Math.hypot(ca - pa, cb - pb)
    const ox = (ca - pa) * u[0] + (cb - pb) * v[0], oz = (ca - pa) * u[2] + (cb - pb) * v[2]
    return { feet: [...feet].sort(), contacts: on.length, offsetM: off < 1e-4 ? 0 : off, offsetDir: [ox, oz], weightN: W, com }
  }

  /** 最近一次求值里第 i 条肌肉在自由度 d 上的力臂（米；被带动的自由度已并入驱动自由度）。 */
  /** Moment arm (m) of muscle i at dof d in the last evaluation (driven dofs folded into their driver). */
  momentArm(i: number, d: number): number {
    const m = this.muscles[i]
    if (!m) return 0
    let r = 0
    for (let q = 0; q < m.dofs.length; q++) {
      const e = m.dofs[q]!
      const info = this.dofs[e]!
      if (e === d && info.driver < 0) r += this.arms[this.armStart[i]! + q]!
      else if (info.driver === d) r += info.ratio * this.arms[this.armStart[i]! + q]!
    }
    return r
  }

  /** 最近一次求值里第 i 条肌肉对各平衡单元的力矩贡献（N·m），按绝对值从大到小。 */
  /** Torque contributions (N·m) of muscle i to the balance units in the last evaluation, largest first. */
  contributions(i: number, limit = 3): { unit: number; nm: number }[] {
    const m = this.muscles[i]
    const a = this.result.activation[i] ?? 0
    if (!m || !(a > 0)) return []
    const by = new Map<number, number>()
    for (let q = 0; q < m.dofs.length; q++) {
      const d: number = m.dofs[q]!
      const u: number = this.unitOf[d]!
      if (this.result.status[u] !== DofStatus.Active) continue
      by.set(u, (by.get(u) ?? 0) + a * m.fmax * this.arms[this.armStart[i]! + q]! * this.unitW[d]!)
    }
    return [...by].map(([unit, nm]) => ({ unit, nm })).sort((p, q) => Math.abs(q.nm) - Math.abs(p.nm)).slice(0, limit)
  }
}
