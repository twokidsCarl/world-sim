// 肩带姿势校正的第二部分：骨动了以后，软组织怎么跟。
//   1. 骨：锁骨、肩胛骨各按自己的刚体变换；肱骨及其以远各骨整体平移（上肢下垂的方向不变）。
//   2. 附着在骨上的部件（肌、腱、韧带、软骨）：按它所附着的那几组骨来放——贴着某组骨的顶点完全随该组骨
//      刚体运动，只在跨骨的肌腹中按到各组骨的距离混合（与 jointFit.ts 的关节局部拟合同一思路）。
//      只附着在一组骨上的部件就是纯刚体运动（整条上肢的肌因此原样平移）。
//   3. 不附着在骨上的部件（血管、神经、淋巴结、筋膜、皮肤）：随由第 1、2 步的表面锚点建立的平滑位移场
//      （register.ts 的核回归）；位移场在整条上肢内恰好等于平移。
//   4. 神经：中心线过位移场后再做一次“推出骨外”的清理并重建管状网格（importZa.ts 的 warpNerveLines）。
// 之后是一组数值检查（关节对合、肩胛–胸廓间距、附着点、骨内比例、折叠、对称），写进管线报告。
// Second half of the shoulder girdle correction: how the soft tissue follows once the bones moved.
//   1. Bones: clavicle and scapula by their own rigid transforms; the humerus and everything distal
//      is translated as one block (the hanging direction of the limb does not change).
//   2. Parts attached to bone (muscle, tendon, ligament, cartilage): placed by the bone groups they
//      attach to — a vertex lying on one group moves rigidly with it, and only the bellies that span
//      between bones blend by distance to each group (the idea of the joint-local fit in jointFit.ts).
//      A part attached to one group alone moves rigidly (so the muscles of the whole limb are translated as they are).
//   3. Parts not attached to bone (vessels, nerves, lymph nodes, fasciae, skin): a smooth displacement
//      field built from surface anchors of steps 1 and 2 (the kernel regression of register.ts); inside
//      the limb the field equals the translation exactly.
//   4. Nerves: centrelines go through the field, then one more out-of-bone clean-up and the tubes are
//      rebuilt (warpNerveLines of importZa.ts).
// Then a set of numeric checks (joint congruency, scapulothoracic stand-off, attachments, share inside
// bone, folding, symmetry) for the pipeline report.

import type { SystemId, TissueId } from '../../src/anatomy/types.ts'
import { measure, type Mesh } from './geometry.ts'
import { SurfaceField, type ExistingPart } from './import3.ts'
import { buildTube, mergeMeshes } from './tube.ts'
import { canalFor, NERVE_BUILD_DEFAULTS, pathStats, warpNerveLines } from './importZa.ts'
import { InsideTester, PointIndex, surfacePoints, thinPoints, voxelSubsample } from './register.ts'
import {
  applyT, applyToPoints, contactZone, GIRDLE_SOLVE_DEFAULTS, girdleAngles, girdleLandmarks, IDENTITY_T, invertT, limbJointCentres, RESTING_POSTURE, RESTING_POSTURE_SOURCE, rotationAngleOf, solveGirdle, thoraxFrame, thoraxLandmarks,
  type GirdleAngles, type GirdleLandmarks, type GirdlePose, type GirdleSolveOptions, type RigidT, type V3,
} from './shoulder.ts'
import type { Polyline } from './tube.ts'

export interface TissuePart {
  id: string
  fma: string
  name: string
  tissue: TissueId
  system: SystemId
  mesh: Mesh
  bbox: readonly number[]
  centrelines?: Polyline[]
}

/** 一个部件在校正中的去向 / what the correction did to one part */
export interface CarriedPart {
  mesh: Mesh
  centrelines?: Polyline[]
  /** rigid = 源几何的纯刚体变换；deformed = 非刚性形变 / rigid = a pure rigid transform of the source geometry; deformed = changed non-rigidly */
  motion: 'rigid' | 'deformed'
  via: 'bone' | 'attachment' | 'field' | 'nerve'
  /** 刚体运动时所随的骨组 / the bone group followed, for rigid motion */
  group?: string
}

export interface ShoulderOptions {
  /** 盂肱关节（肱骨头球心）间距的目标与下限（米）；从目标起每次减 `step` 直到约束满足 / target and floor of the glenohumeral (head centre) separation (m); stepped down from the target by `step` until the constraints hold */
  targetSeparation: number
  minSeparation: number
  step: number
  /** 可接受的姿势：肩胛–胸廓间距变化的均方根上限（米） / acceptance: largest RMS change of the scapulothoracic stand-off (m) */
  maxStandOffRms: number
  /** 可接受的姿势：锁骨角越过文献均值不得超过这么多个标准差 / acceptance: the clavicle angles may pass the literature mean by at most this many SDs */
  maxPastMeanSd: number
  solve: GirdleSolveOptions
  /** 形变作用范围：被移动的骨的包围盒向外这么远（米） / reach of the deformation: this far beyond the bbox of the moved bones (m) */
  reach: number
  /** 部件表面距某组骨在此距离以内算附着（米） / a part is attached to a bone group within this distance (m) */
  attachDistance: number
  /** 表中的肩带肌离它该附着的骨最远可以有这么远（米） / a listed girdle muscle may stay this far from a bone it is listed for (m) */
  listedAttachDistance: number
  /** 混合权重 1/(d + blendOffset)^blendPower；小于 saturate 的权重归零、大于 1 − saturate 的归一 / blend weights 1/(d + blendOffset)^blendPower; weights below `saturate` become 0, above 1 − saturate become 1 */
  blendOffset: number
  blendPower: number
  saturate: number
  /** 附着点的转动作用到多远：rigidNear 以内完整，到 rigidFar 处收到零（米） / how far a site's rotation reaches: in full within rigidNear, none from rigidFar on (m) */
  rigidNear: number
  rigidFar: number
  /** 同时附着于上肢的部件：肩胛骨、锁骨的作用在离其附着点这两个距离之间收到零（米） / for parts that also attach to the limb: the pull of scapula and clavicle fades to zero between these two distances from their sites (m) */
  girdleReach: [number, number]
  /** 位移与恒等（或与上肢平移）相差不超过此值的部件按未动（或纯平移）处理（米） / a part whose displacement differs from none (or from the limb's translation) by at most this is left alone (or translated exactly) (m) */
  rigidTolerance: number
  /** 随位移场走的部件，最大位移不超过此值时不动它（米）：远离肩带的血管、神经不因零点几毫米的牵连而改标 / a part carried by the field is left alone when its largest displacement is at most this (m): vessels and nerves far from the girdle are not relabelled for a few tenths of a millimetre of drag */
  fieldDeadband: number
  /** 沿肱骨轴、肱骨头中心以远这两个距离之间，上肢与躯干逐渐分开（米） / between these two distances beyond the head centre along the humeral axis the limb separates from the trunk (m) */
  armSeparation: [number, number]
  /** 细薄结构取位移平均的遍数 / passes of displacement averaging for thin structures */
  thinPasses: number
  /** 细薄结构取位移平均的半径（米） / radius over which a thin structure averages its displacement (m) */
  thinRadius: number
  /** 位移场的参数（见 GapField） / parameters of the displacement field (see GapField) */
  field: GapFieldOptions
  /** 进度输出 / progress output */
  log?: (message: string) => void
}

export const SHOULDER_DEFAULTS: ShoulderOptions = {
  targetSeparation: 0.35,
  minSeparation: 0.325,
  step: 0.001,
  maxStandOffRms: 0.0025,
  maxPastMeanSd: 0.5,
  solve: GIRDLE_SOLVE_DEFAULTS,
  reach: 0.1,
  attachDistance: 0.0025,
  listedAttachDistance: 0.02,
  blendOffset: 0.005,
  blendPower: 2,
  saturate: 0.03,
  rigidNear: 0.02,
  rigidFar: 0.06,
  girdleReach: [0.03, 0.08],
  rigidTolerance: 0.00025,
  fieldDeadband: 0.001,
  armSeparation: [0.04, 0.07],
  thinPasses: 2,
  thinRadius: 0.005,
  field: { epsilon: 0.002, power: 3, sharpPower: 6, radiusFactor: 4, radiusOffset: 0.004, maxRadius: 0.1, switchRadius: 0.04, coarseSpacing: 0.01, maxDistance: 0.08 },
}

const ATTACHED_TISSUES: ReadonlySet<TissueId> = new Set<TissueId>(['muscle', 'tendon', 'ligament'])
type GroupKind = 'static' | 'clavicle' | 'scapula' | 'arm'
/**
 * 肩带肌的附着（按解剖学；第一条匹配的规则生效）：肌名 → 它附着于哪几类骨（躯干骨、锁骨、肩胛骨、上肢骨）。
 * 仅凭“表面贴近”来判断附着在这里不可靠：仰卧扫描里肋间肌、竖脊肌、前锯肌都贴着肩胛骨或锁骨而并不附着于它，
 * 斜方肌中部离棘突又有 3 mm 的空隙。所以表中的肌只认表中的骨，附着面取它离该骨最近的那一片；
 * 表外的肌不会附着于锁骨或肩胛骨（肩胛骨是在它们上面滑动的）。
 * Attachments of the girdle muscles (by anatomy; the first matching rule applies): muscle name → the
 * kinds of bone it attaches to (trunk, clavicle, scapula, upper limb). Surface proximity alone is not
 * a reliable sign of attachment here: in the supine scan the intercostals, erector spinae and serratus
 * anterior lie against the scapula or clavicle without attaching to it, and the middle trapezius
 * stays 3 mm clear of the spinous processes. So a listed muscle attaches to its listed bones only,
 * at the patch of its surface nearest to each; an unlisted muscle never attaches to the clavicle or
 * the scapula (the scapula glides over it).
 */
export const GIRDLE_MUSCLE_ATTACHMENTS: [RegExp, GroupKind[]][] = [
  [/clavicular part of .*deltoid/i, ['clavicle', 'arm']],
  [/deltoid/i, ['scapula', 'arm']],
  [/clavicular part of .*pectoralis major/i, ['clavicle', 'arm']],
  [/pectoralis major/i, ['static', 'arm']],
  [/pectoralis minor/i, ['static', 'scapula']],
  [/serratus anterior/i, ['static', 'scapula']],
  [/subclavius/i, ['static', 'clavicle']],
  [/supraspinatus|infraspinatus|subscapularis|teres (major|minor)|coracobrachialis|biceps brachii|long head of .*triceps brachii/i, ['scapula', 'arm']],
  [/descending part of .*trapezius/i, ['static', 'clavicle', 'scapula']],
  [/trapezius/i, ['static', 'scapula']],
  [/levator scapulae|rhomboid/i, ['static', 'scapula']],
  [/omohyoid/i, ['static', 'scapula']],
  [/sternocleidomastoid|sternohyoid/i, ['static', 'clavicle']],
  [/latissimus dorsi/i, ['static', 'arm']],
]
/** 皮肌：不附着于肩带，随皮肤（位移场）走 / cutaneous muscles: not attached to the girdle, they go with the skin (the field) */
const CUTANEOUS_MUSCLES = /platysma/i
const kindOf = (groupKey: string): GroupKind => (groupKey === 'static' ? 'static' : (groupKey.split('_')[0] as GroupKind))
/**
 * 躯干和颈部的器官（以及头发）不随肩带动：它们留在原位，并作为位移为零的锚点。淋巴结除外（它们随周围组织走）。
 * Organs of the trunk and neck (and the hair of the head) do not follow the girdle: they stay, and serve as anchors of zero
 * displacement. Lymph nodes are the exception (they go with the tissue around them).
 */
const isFixedOrgan = (p: TissuePart) => (['organ', 'heart', 'gland', 'brain', 'space', 'tooth'].includes(p.tissue) && !/\bnodes?\b/i.test(p.name)) || (p.tissue === 'skin' && /\bhair of head\b/i.test(p.name)) || (p.tissue === 'cartilage' && !/costal cartilage/i.test(p.name) && p.system !== 'skeletal')
const SIDES = [['Left', 'L', 1], ['Right', 'R', -1]] as const
const r1 = (v: number) => Math.round(v * 10) / 10
const r2 = (v: number) => Math.round(v * 100) / 100
const mm1 = (v: number) => r1(v * 1000)
const quant = (s: number[], p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? NaN
const overlaps = (a: readonly number[], b: readonly number[], pad = 0) => !(a[0]! > b[3]! + pad || a[3]! < b[0]! - pad || a[1]! > b[4]! + pad || a[4]! < b[1]! - pad || a[2]! > b[5]! + pad || a[5]! < b[2]! - pad)
const bboxOfPoints = (p: ArrayLike<number>): number[] => {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    if (p[i + k]! < b[k]!) b[k] = p[i + k]!
    if (p[i + k]! > b[k + 3]!) b[k + 3] = p[i + k]!
  }
  return b
}
const concat = (list: Float32Array[]): Float32Array => {
  const out = new Float32Array(list.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of list) {
    out.set(a, o)
    o += a.length
  }
  return out
}

/**
 * 由锚点位移做反距离加权插值的位移场：u(x) = Σ wᵢ uᵢ / Σ wᵢ，wᵢ = 1 / (dᵢ² + ε²)²，
 * 只取 x 周围半径 R = c·(到最近锚点的距离 + r₀) 以内的锚点，权重在 R 处平滑收到零。
 * 与固定带宽的高斯核不同，它的过渡宽度随空隙大小而变：贴着某个表面的组织几乎完全随该表面走，
 * 两个表面之间的空隙里位移在整个空隙宽度上过渡（腋窝的脂肪、血管、淋巴结），不会在空隙中间突然切换。
 * Displacement field by inverse-distance weighting of anchor displacements: u(x) = Σ wᵢ uᵢ / Σ wᵢ with
 * wᵢ = 1 / (dᵢ² + ε²)², over the anchors within R = c·(distance to the nearest anchor + r₀) of x, the
 * weights tapering smoothly to zero at R. Unlike a Gaussian kernel of fixed width its transition is as
 * wide as the gap: tissue lying on a surface follows that surface almost entirely, and in a gap
 * between two surfaces the displacement changes over the whole width of the gap (the fat, vessels and
 * nodes of the axilla) instead of switching in the middle of it.
 */
export class GapField {
  private readonly sets: { points: Float32Array; disp: Float32Array; cell: number; grid: Map<number, number[]>; index: PointIndex }[]
  readonly anchors: number
  /**
   * @param sharpen 可选：某点处把幂从 power 提到 sharpPower 的程度（0…1） / optional: how far the power is raised from `power` towards `sharpPower` at a point (0…1)
   */
  constructor(from: Float32Array, to: Float32Array, private readonly o: GapFieldOptions, private readonly sharpen?: (x: number, y: number, z: number) => number) {
    this.anchors = from.length / 3
    const build = (pts: Float32Array, disp: Float32Array, cell: number) => {
      const grid = new Map<number, number[]>()
      for (let i = 0; i < pts.length / 3; i++) {
        const k = GapField.key(Math.floor(pts[3 * i]! / cell), Math.floor(pts[3 * i + 1]! / cell), Math.floor(pts[3 * i + 2]! / cell))
        let l = grid.get(k)
        if (!l) grid.set(k, (l = []))
        l.push(i)
      }
      return { points: pts, disp, cell, grid, index: new PointIndex(pts, cell) }
    }
    const disp = new Float32Array(from.length)
    for (let i = 0; i < from.length; i++) disp[i] = to[i]! - from[i]!
    // 粗一级的锚点集：大半径查询时用，免得一次查询扫过上万个锚点 / a coarser anchor set for wide queries, so that one query does not sweep tens of thousands of anchors
    const keep = voxelSubsample(from, o.coarseSpacing)
    const cf = new Float32Array(keep.length * 3)
    const cd = new Float32Array(keep.length * 3)
    keep.forEach((i, j) => {
      for (let k = 0; k < 3; k++) {
        cf[3 * j + k] = from[3 * i + k]!
        cd[3 * j + k] = disp[3 * i + k]!
      }
    })
    this.sets = [build(from, disp, 0.012), build(cf, cd, 0.03)]
  }
  private static key(i: number, j: number, k: number): number {
    return (i + 512) * 1048576 + (j + 512) * 1024 + (k + 512)
  }
  private sum(set: number, x: number, y: number, z: number, R: number, half: number, acc: Float64Array): void {
    const s = this.sets[set]!
    const c = s.cell
    const e2 = this.o.epsilon * this.o.epsilon
    const R2 = R * R
    let w = 0
    let ux = 0
    let uy = 0
    let uz = 0
    for (let i = Math.floor((x - R) / c); i <= Math.floor((x + R) / c); i++) for (let j = Math.floor((y - R) / c); j <= Math.floor((y + R) / c); j++) for (let k = Math.floor((z - R) / c); k <= Math.floor((z + R) / c); k++) {
      const l = s.grid.get(GapField.key(i, j, k))
      if (!l) continue
      for (const a of l) {
        const dx = s.points[3 * a]! - x
        const dy = s.points[3 * a + 1]! - y
        const dz = s.points[3 * a + 2]! - z
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 >= R2) continue
        const taper = 1 - d2 / R2
        const wi = (taper * taper) / (d2 + e2) ** half
        w += wi
        ux += wi * s.disp[3 * a]!
        uy += wi * s.disp[3 * a + 1]!
        uz += wi * s.disp[3 * a + 2]!
      }
    }
    acc[0] = w
    acc[1] = ux
    acc[2] = uy
    acc[3] = uz
  }
  private readonly a0 = new Float64Array(4)
  private readonly a1 = new Float64Array(4)
  displacementAt(x: number, y: number, z: number): [number, number, number] {
    const o = this.o
    const dmin = this.sets[0]!.index.distance(x, y, z, o.maxDistance)
    // 离所有锚点都远：没有可跟随的东西 / far from every anchor: nothing to follow
    if (!Number.isFinite(dmin)) return [0, 0, 0]
    const R = Math.min(o.maxRadius, o.radiusFactor * (dmin + o.radiusOffset))
    const half = (o.power + (this.sharpen ? this.sharpen(x, y, z) * (o.sharpPower - o.power) : 0)) / 2
    // 小半径用细锚点，大半径用粗锚点，中间平滑过渡 / fine anchors for small radii, coarse ones for large, blended in between
    const t = R <= o.switchRadius * 0.85 ? 0 : R >= o.switchRadius * 1.15 ? 1 : (R - o.switchRadius * 0.85) / (o.switchRadius * 0.3)
    let ux = 0
    let uy = 0
    let uz = 0
    if (t < 1) {
      this.sum(0, x, y, z, R, half, this.a0)
      if (this.a0[0]! > 0) {
        ux += ((1 - t) * this.a0[1]!) / this.a0[0]!
        uy += ((1 - t) * this.a0[2]!) / this.a0[0]!
        uz += ((1 - t) * this.a0[3]!) / this.a0[0]!
      }
    }
    if (t > 0) {
      this.sum(1, x, y, z, R, half, this.a1)
      if (this.a1[0]! > 0) {
        ux += (t * this.a1[1]!) / this.a1[0]!
        uy += (t * this.a1[2]!) / this.a1[0]!
        uz += (t * this.a1[3]!) / this.a1[0]!
      }
    }
    return [ux, uy, uz]
  }
}

export interface GapFieldOptions {
  /** 权重 1/(d² + ε²)^(power/2) 中的 ε（米）和幂 / the ε (m) and the power of the weight 1/(d² + ε²)^(power/2) */
  epsilon: number
  power: number
  /** `sharpen` 为 1 处所用的幂 / the power used where `sharpen` is 1 */
  sharpPower: number
  /** 查询半径 R = radiusFactor·(到最近锚点的距离 + radiusOffset)，不超过 maxRadius（米） / query radius R = radiusFactor·(distance to the nearest anchor + radiusOffset), at most maxRadius (m) */
  radiusFactor: number
  radiusOffset: number
  maxRadius: number
  /** 半径超过此值改用粗锚点（间距 coarseSpacing） / beyond this radius the coarse anchors (coarseSpacing apart) are used */
  switchRadius: number
  coarseSpacing: number
  /** 离最近锚点超过此距离的点不动（米） / points further than this from the nearest anchor are not moved (m) */
  maxDistance: number
}

interface Group {
  key: string
  T: RigidT
  /** 该组骨表面的采样点（静息位） / surface samples of the group's bones (resting posture) */
  index: PointIndex
  bbox: number[]
}

export interface ShoulderResult {
  /** 发生变化的部件：id → 新几何 / the parts that changed: id → new geometry */
  moved: Map<string, CarriedPart>
  report: Record<string, unknown>
}

/**
 * 对整个人体做肩带姿势校正。`parts` 是静息位（扫描原样）的全部部件；返回发生变化的部件和报告。
 * 找不到所需的骨时返回 null。
 * Runs the shoulder girdle correction over the whole body. `parts` is every part in the as-scanned
 * posture; returns the parts that changed and the report. Null when a bone it needs is missing.
 */
export function correctShoulderGirdle(parts: TissuePart[], opts: ShoulderOptions = SHOULDER_DEFAULTS): ShoulderResult | null {
  const t0 = performance.now()
  const log = (m: string) => opts.log?.(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${m}`)
  const bone = (name: string) => parts.find((p) => p.tissue === 'bone' && p.name === name)
  const manubrium = bone('Manubrium')
  const xiphoid = bone('Xiphoid process')
  const c7 = bone('Seventh cervical vertebra')
  const t8 = bone('Eighth thoracic vertebra')
  const sideBones = SIDES.map(([S]) => ({ clavicle: bone(`${S} clavicle`), scapula: bone(`${S} scapula`), humerus: bone(`${S} humerus`) }))
  if (!manubrium || !xiphoid || !c7 || !t8 || sideBones.some((b) => !b.clavicle || !b.scapula || !b.humerus)) return null

  // ── 运动学 / kinematics ────────────────────────────────────────────────────────────────────
  const tl = thoraxLandmarks(manubrium.mesh, xiphoid.mesh, c7.mesh, t8.mesh)
  const frame = thoraxFrame(tl)
  const lms = SIDES.map(([, , lat], i) => girdleLandmarks(lat, sideBones[i]!.clavicle!.mesh, sideBones[i]!.scapula!.mesh, sideBones[i]!.humerus!.mesh, manubrium.mesh))
  const midX = (lms[0]!.sc[0] + lms[1]!.sc[0]) / 2
  // 胸壁：肋、肋间肌、胸椎 / the chest wall: ribs, intercostal muscles, thoracic vertebrae
  const wallParts = parts.filter((p) => (p.tissue === 'bone' && / rib$|thoracic vertebra$/i.test(p.name)) || (p.tissue === 'muscle' && /intercostal muscle$/i.test(p.name)))
  const wall = new PointIndex(concat(wallParts.map((p) => thinPoints(surfacePoints(p.mesh, 0.002), 0.002))), 0.006)
  const ribParts = parts.filter((p) => p.tissue === 'bone' && / rib$/i.test(p.name))
  const ribs = new PointIndex(concat(ribParts.map((p) => thinPoints(surfacePoints(p.mesh, 0.003), 0.003))), 0.01)
  const costal = SIDES.map((_, i) => {
    const sp = thinPoints(surfacePoints(sideBones[i]!.scapula!.mesh, 0.003), 0.006)
    const pts: number[] = []
    const d: number[] = []
    for (let k = 0; k < sp.length; k += 3) {
      const dist = wall.distance(sp[k]!, sp[k + 1]!, sp[k + 2]!, 0.2)
      if (dist < 0.03) {
        pts.push(sp[k]!, sp[k + 1]!, sp[k + 2]!)
        d.push(dist)
      }
    }
    return { points: Float32Array.from(pts), standOff: Float64Array.from(d) }
  })
  const before = SIDES.map(([, , lat], i) => girdleAngles(frame, lat, lms[i]!))
  const sep0 = lms[0]!.gh[0] - lms[1]!.gh[0]
  const keys = Object.keys(RESTING_POSTURE) as (keyof GirdleAngles)[]
  const z = (k: keyof GirdleAngles, v: number) => (v - RESTING_POSTURE[k].mean) / RESTING_POSTURE[k].sd
  const gapStats = (pts: Float32Array, index: PointIndex) => {
    const d: number[] = []
    for (let k = 0; k < pts.length; k += 3) d.push(index.distance(pts[k]!, pts[k + 1]!, pts[k + 2]!, 0.3))
    d.sort((a, b) => a - b)
    return { minMm: mm1(d[0]!), p2Mm: mm1(quant(d, 0.02)), p10Mm: mm1(quant(d, 0.1)), medianMm: mm1(quant(d, 0.5)) }
  }
  // 约束是否满足：间距变化不大、不比静息时更贴近肋骨、锁骨不矫枉过正
  // do the constraints hold: the stand-off barely changes, nothing is closer to the ribs than at rest, the clavicle is not over-corrected
  const acceptable = (pose: GirdlePose, i: number): string | null => {
    if (pose.standOff.rmsMm > opts.maxStandOffRms * 1000) return `scapulothoracic stand-off changes by ${r2(pose.standOff.rmsMm)} mm RMS (limit ${opts.maxStandOffRms * 1000})`
    const g0 = gapStats(costal[i]!.points, wall)
    const g1 = gapStats(applyToPoints(pose.scapula, costal[i]!.points), wall)
    if (g1.minMm < g0.minMm - 0.05 || g1.p10Mm < g0.p10Mm - 0.05) return `scapula closer to the chest wall than at rest (min ${g0.minMm} → ${g1.minMm} mm, p10 ${g0.p10Mm} → ${g1.p10Mm} mm)`
    for (const k of ['clavicleRetraction', 'clavicleElevation'] as const) {
      const z0 = z(k, before[i]![k])
      const z1 = z(k, pose.angles[k])
      if (Math.sign(z1) !== Math.sign(z0) && Math.abs(z1) > opts.maxPastMeanSd) return `${k} passes the resting mean by ${r2(Math.abs(z1))} SD (limit ${opts.maxPastMeanSd})`
    }
    return null
  }
  const solveAt = (sep: number) => solveGirdle(SIDES.map(([, , lat], i) => ({ lat, lm: lms[i]!, frame, costal: costal[i]!.points, standOff: costal[i]!.standOff, thorax: wall, ghLateral: sep / 2, midX })), opts.solve)
  const tried: { separationMm: number; accepted: boolean; reason: string | null; standOffRmsMm: number[] }[] = []
  const cache = new Map<number, GirdlePose[] | null>()
  /** 试一个间距（按 `step` 的整数倍）；满足约束则返回两侧姿势 / tries one separation (a whole multiple of `step`); returns both poses when the constraints hold */
  const attempt = (steps: number): GirdlePose[] | null => {
    if (cache.has(steps)) return cache.get(steps)!
    const sep = steps * opts.step
    const cand = solveAt(sep)
    const reasons = cand.map((p, i) => acceptable(p, i))
    const ok = reasons.every((r) => r === null)
    tried.push({ separationMm: mm1(sep), accepted: ok, reason: reasons.find((r) => r !== null) ?? null, standOffRmsMm: cand.map((p) => r2(p.standOff.rmsMm)) })
    cache.set(steps, ok ? cand : null)
    return ok ? cand : null
  }
  // 最大的可接受间距：先试目标，再在下限与目标之间二分（间距越大约束越难满足）
  // the largest acceptable separation: the target first, then bisection between the floor and the target (constraints get harder as the separation grows)
  let hi = Math.round(opts.targetSeparation / opts.step)
  let lo = Math.round(Math.max(opts.minSeparation, sep0) / opts.step)
  let poses = attempt(hi)
  if (!poses) {
    poses = attempt(lo)
    while (poses && hi - lo > 1) {
      const mid = (lo + hi) >> 1
      const m = attempt(mid)
      if (m) {
        lo = mid
        poses = m
      } else hi = mid
    }
  }
  tried.sort((a, b) => a.separationMm - b.separationMm)
  // 不设外移目标时姿势自己落在哪里（只受文献姿势和各约束支配） / where the posture settles without a lateral target (literature posture and constraints only)
  const free = solveGirdle(SIDES.map(([, , lat], i) => ({ lat, lm: lms[i]!, frame, costal: costal[i]!.points, standOff: costal[i]!.standOff, thorax: wall, ghLateral: 0, midX })), { ...opts.solve, sigmaGh: 1e6 })
  const kinematics: Record<string, unknown> = {
    restingPostureReference: { ...RESTING_POSTURE_SOURCE, meanAndSdDeg: Object.fromEntries(keys.map((k) => [k, [RESTING_POSTURE[k].mean, r1(RESTING_POSTURE[k].sd)]])) },
    thoraxLandmarksM: Object.fromEntries(Object.entries(tl).map(([k, v]) => [k, (v as V3).map((x) => Number(x.toFixed(4)))])),
    glenohumeralSeparationMm: { before: mm1(sep0), target: mm1(opts.targetSeparation), withoutLateralTarget: mm1(free[0]!.lm.gh[0] - free[1]!.lm.gh[0]) },
    targetsTried: tried,
  }
  if (!poses) return { moved: new Map(), report: { applied: false, reason: `no separation between ${opts.minSeparation * 1000} and ${opts.targetSeparation * 1000} mm satisfies the constraints`, ...kinematics } }
  const sep1 = poses[0]!.lm.gh[0] - poses[1]!.lm.gh[0]
  ;(kinematics.glenohumeralSeparationMm as Record<string, number>).after = mm1(sep1)

  log(`solved: ${mm1(sep0)} → ${mm1(sep1)} mm`)
  // ── 1. 骨组 / bone groups ──────────────────────────────────────────────────────────────────
  const boneT = new Map<string, { T: RigidT; group: string }>()
  const groups: Group[] = []
  const armCounts: number[] = []
  const movedBoxes: number[][] = []
  SIDES.forEach(([S, s, lat], i) => {
    const b = sideBones[i]!
    const pose = poses![i]!
    const arm = parts.filter((p) => p.tissue === 'bone' && new RegExp(`\\b${S.toLowerCase()}\\b`, 'i').test(p.name) && p !== b.clavicle && p !== b.scapula && lat * (lat > 0 ? p.bbox[0]! : p.bbox[3]!) > 0.12 && p.bbox[4]! > 0.55)
    armCounts.push(arm.length)
    for (const [key, T, list] of [[`clavicle_${s}`, pose.clavicle, [b.clavicle!]], [`scapula_${s}`, pose.scapula, [b.scapula!]], [`arm_${s}`, pose.arm, arm]] as [string, RigidT, TissuePart[]][]) {
      const pts = concat(list.map((p) => thinPoints(surfacePoints(p.mesh, 0.002), 0.002)))
      groups.push({ key, T, index: new PointIndex(pts, 0.006), bbox: bboxOfPoints(pts) })
      for (const p of list) boneT.set(p.id, { T, group: key })
      movedBoxes.push(bboxOfPoints(pts), bboxOfPoints(applyToPoints(T, pts)))
    }
  })
  const region = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const b of movedBoxes) for (let k = 0; k < 3; k++) {
    region[k] = Math.min(region[k]!, b[k]! - opts.reach)
    region[k + 3] = Math.max(region[k + 3]!, b[k + 3]! + opts.reach)
  }
  // 不动的骨：其余所有骨，加上肋软骨 / the bones that stay: all others, plus the costal cartilages
  const isStaticHard = (p: TissuePart) => (p.tissue === 'bone' && !boneT.has(p.id)) || (p.tissue === 'cartilage' && /costal cartilage/i.test(p.name))
  const staticParts = parts.filter((p) => isStaticHard(p) && overlaps(p.bbox, region, 0.25))
  {
    const pts = concat(staticParts.map((p) => thinPoints(surfacePoints(p.mesh, 0.0025), 0.0025)))
    groups.unshift({ key: 'static', T: IDENTITY_T, index: new PointIndex(pts, 0.006), bbox: bboxOfPoints(pts) })
  }
  const staticIds = new Set(staticParts.map((p) => p.id))

  const moved = new Map<string, CarriedPart>()
  for (const p of parts) {
    const b = boneT.get(p.id)
    if (b) moved.set(p.id, { mesh: { positions: applyToPoints(b.T, p.mesh.positions), indices: p.mesh.indices }, motion: 'rigid', via: 'bone', group: b.group })
  }

  // ── 2. 附着在骨上的部件 / parts attached to bone ───────────────────────────────────────────
  /** 一个附着部件的映射：把它表面上或附近的点从静息位搬到校正后 / the map of one attached part: carries points on or near its surface from rest to the corrected posture */
  interface Attached { part: TissuePart; groups: number[]; apply: (pts: Float32Array) => Float32Array; motion: 'none' | 'rigid' | 'deformed'; sites: PointIndex[] }
  const attached: Attached[] = []
  const attachmentRows: { id: string; name: string; groups: string[]; motion: string }[] = []
  /**
   * 按到各组“附着面”的距离混合各组的运动。附着面 = 部件自身表面上贴着该组骨的那部分，
   * 所以贴骨的地方完全随骨，肌腹按它离两端附着面的远近过渡；从别的骨旁边经过而不附着的地方不受那块骨影响。
   * 两点细节：
   *   · 上肢是一个筋膜室：对上肢骨组用的是到骨本身的距离，肱三头肌长头、肱二头肌这类起自肩胛骨的肌，
   *     肌腹在臂内就随臂走，只有近端的腱在腋窝里改变方向；
   *     （肩胛骨、锁骨的作用在离其附着点 3–8 cm 之间收到零）；
   *   · 某组骨对一个顶点的作用 = 最近附着点的位移，附着点附近（rigidNear 以内）再加上该骨的转动，
   *     远处只取平移——不把肩胛骨的转动外推到十几厘米外的肌腹上。
   * Blends the groups' motions by distance to each group's attachment site. A site is the part of the
   * part's own surface that lies on the group's bones, so tissue on a bone follows it entirely, a
   * belly passes from one site to the other, and a bone that is merely passed is ignored. Two details:
   *   · the limb is a fascial compartment: for the limb's bones the distance is to the bones themselves,
   *     so the bellies of muscles arising from the scapula (long head of triceps, biceps) go with the
   *     arm once they are in it, and only their proximal tendons re-angle in the axilla (the pull of
   *     the scapula and clavicle fades to zero between 3 and 8 cm from their sites);
   *   · a group acts on a vertex through the displacement of the nearest site point, with the bone's
   *     rotation added near the site (within rigidNear) and translation only far from it — the
   *     scapula's rotation is not extrapolated to a belly ten centimetres away.
   */
  const NI = new Int32Array(1)
  const ND = new Float64Array(1)
  const blend = (gs: number[], sites: PointIndex[]) => (pts: Float32Array): { out: Float32Array; pure: Int8Array } => {
    const out = new Float32Array(pts.length)
    const pure = new Int8Array(pts.length / 3).fill(-1)
    const w = new Float64Array(gs.length)
    const u = new Float64Array(3 * gs.length)
    const hasArm = gs.some((g) => groups[g]!.key.startsWith('arm_'))
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i]!
      const y = pts[i + 1]!
      const zc = pts[i + 2]!
      let sum = 0
      for (let a = 0; a < gs.length; a++) {
        const g = groups[gs[a]!]!
        let d: number
        if (g.key.startsWith('arm_')) {
          d = g.index.distance(x, y, zc)
          u[3 * a] = g.T.t[0]
          u[3 * a + 1] = g.T.t[1]
          u[3 * a + 2] = g.T.t[2]
        } else {
          sites[a]!.nearest(x, y, zc, 1, NI, ND)
          d = Math.sqrt(ND[0]!)
          if (gs[a] === 0) u[3 * a] = u[3 * a + 1] = u[3 * a + 2] = 0
          else {
            const sp = sites[a]!.points
            const qx = sp[3 * NI[0]!]!
            const qy = sp[3 * NI[0]! + 1]!
            const qz = sp[3 * NI[0]! + 2]!
            const T = g.T
            // ρ：附着点附近为 1（完整刚体运动），到 rigidFar 处收到 0（只剩附着点的平移）
            // ρ: 1 near the site (the full rigid motion), 0 from rigidFar on (the site point's translation only)
            const rho = d <= opts.rigidNear ? 1 : d >= opts.rigidFar ? 0 : (opts.rigidFar - d) / (opts.rigidFar - opts.rigidNear)
            const px = qx + rho * (x - qx)
            const py = qy + rho * (y - qy)
            const pz = qz + rho * (zc - qz)
            u[3 * a] = T.r[0]! * px + T.r[1]! * py + T.r[2]! * pz + T.t[0] - px
            u[3 * a + 1] = T.r[3]! * px + T.r[4]! * py + T.r[5]! * pz + T.t[1] - py
            u[3 * a + 2] = T.r[6]! * px + T.r[7]! * py + T.r[8]! * pz + T.t[2] - pz
          }
        }
        w[a] = 1 / (d + opts.blendOffset) ** opts.blendPower
        // 进了上肢的肌腹不再受肩胛骨、锁骨牵连：它们的作用在离附着点 girdleReach[0]…[1] 之间收到零
        // a belly that has entered the limb is no longer drawn by the scapula or clavicle: their pull fades to zero between girdleReach[0] and [1] from the site
        if (hasArm && gs[a] !== 0 && !g.key.startsWith('arm_')) {
          const t = d <= opts.girdleReach[0] ? 1 : d >= opts.girdleReach[1] ? 0 : (opts.girdleReach[1] - d) / (opts.girdleReach[1] - opts.girdleReach[0])
          w[a] = w[a]! * t * t * (3 - 2 * t)
        }
        sum += w[a]!
      }
      let sum2 = 0
      for (let a = 0; a < gs.length; a++) {
        const v = w[a]! / sum
        w[a] = v <= opts.saturate ? 0 : v >= 1 - opts.saturate ? 1 : (v - opts.saturate) / (1 - 2 * opts.saturate)
        sum2 += w[a]!
      }
      let ox = x
      let oy = y
      let oz = zc
      for (let a = 0; a < gs.length; a++) {
        const v = w[a]! / sum2
        if (!v) continue
        if (v === 1) pure[i / 3] = gs[a]!
        ox += v * u[3 * a]!
        oy += v * u[3 * a + 1]!
        oz += v * u[3 * a + 2]!
      }
      out[i] = ox
      out[i + 1] = oy
      out[i + 2] = oz
    }
    return { out, pure }
  }
  const unattached: TissuePart[] = []
  for (const p of parts) {
    if (boneT.has(p.id) || staticIds.has(p.id) || p.tissue === 'bone') continue
    if (!overlaps(p.bbox, region) || isFixedOrgan(p) || !ATTACHED_TISSUES.has(p.tissue)) continue
    if (p.tissue === 'muscle' && CUTANEOUS_MUSCLES.test(p.name)) {
      unattached.push(p)
      continue
    }
    const v = p.mesh.positions
    const surface = thinPoints(surfacePoints(p.mesh, 0.002), 0.0015)
    const otherSide = /\bleft\b/i.test(p.name) ? '_R' : /\bright\b/i.test(p.name) ? '_L' : null
    const listed = p.tissue === 'muscle' ? GIRDLE_MUSCLE_ATTACHMENTS.find(([re]) => re.test(p.name))?.[1] : undefined
    const gs: number[] = []
    const sites: PointIndex[] = []
    const dist = new Float32Array(surface.length / 3)
    groups.forEach((g, gi) => {
      const kind = kindOf(g.key)
      if (p.tissue === 'muscle' && (listed ? !listed.includes(kind) : kind === 'clavicle' || kind === 'scapula')) return
      // 分侧的肌只附着于同侧的肩带和上肢 / a sided muscle attaches to the girdle and limb of its own side only
      if (p.tissue === 'muscle' && otherSide && g.key.endsWith(otherSide)) return
      const reach = listed ? opts.listedAttachDistance : opts.attachDistance
      if (!overlaps(p.bbox, g.bbox, reach)) return
      let min = Infinity
      for (let i = 0; i < surface.length; i += 3) {
        const d = g.index.distance(surface[i]!, surface[i + 1]!, surface[i + 2]!, reach + opts.attachDistance)
        dist[i / 3] = d
        if (d < min) min = d
      }
      // 表中的肌：附着面 = 离该骨最近处起 attachDistance 以内的那一片；其余部件：贴骨（attachDistance 以内）的那一片
      // a listed muscle: the site is the patch within attachDistance of its closest approach to the bone; other parts: the patch on the bone (within attachDistance)
      const limit = listed ? (min <= reach ? min + opts.attachDistance : -1) : opts.attachDistance
      const site: number[] = []
      for (let i = 0; i < surface.length; i += 3) if (dist[i / 3]! <= limit) site.push(surface[i]!, surface[i + 1]!, surface[i + 2]!)
      if (site.length / 3 < 6) return
      gs.push(gi)
      sites.push(new PointIndex(Float32Array.from(site), 0.006))
    })
    if (!gs.length) {
      unattached.push(p)
      continue
    }
    if (gs.length === 1) {
      const g = groups[gs[0]!]!
      const motion = gs[0] === 0 ? 'none' : 'rigid'
      attached.push({ part: p, groups: gs, sites, apply: (pts) => (motion === 'none' ? pts : applyToPoints(g.T, pts)), motion })
      if (motion === 'rigid') moved.set(p.id, { mesh: { positions: applyToPoints(g.T, v), indices: p.mesh.indices }, motion: 'rigid', via: 'attachment', group: g.key })
      attachmentRows.push({ id: p.id, name: p.name, groups: [g.key], motion })
      continue
    }
    const f = blend(gs, sites)
    const res = f(v)
    // 所有顶点都完全随同一组骨：就是刚体运动 / every vertex fully follows one and the same group: a rigid motion
    // （锁骨、肩胛骨组在远离附着点处不是完整的刚体运动，所以只认不动和随上肢平移这两种）
    // (for the clavicle and scapula groups the motion is not fully rigid away from the site, so only "at rest" and "translated with the limb" count)
    const all = res.pure.every((g) => g === res.pure[0]) ? res.pure[0]! : -1
    const only = all === 0 || (all > 0 && groups[all]!.key.startsWith('arm_')) ? all : -1
    const motion = only === 0 ? 'none' : only > 0 ? 'rigid' : 'deformed'
    attached.push({ part: p, groups: gs, sites, apply: (pts) => (motion === 'none' ? pts : motion === 'rigid' ? applyToPoints(groups[only]!.T, pts) : f(pts).out), motion })
    if (motion === 'rigid') moved.set(p.id, { mesh: { positions: applyToPoints(groups[only]!.T, v), indices: p.mesh.indices }, motion: 'rigid', via: 'attachment', group: groups[only]!.key })
    else if (motion === 'deformed') moved.set(p.id, { mesh: { positions: res.out, indices: p.mesh.indices }, motion: 'deformed', via: 'attachment' })
    attachmentRows.push({ id: p.id, name: p.name, groups: gs.map((g) => groups[g]!.key), motion })
  }
  log(`attachments: ${attached.length} parts`)

  // ── 3. 位移场 / the displacement field ─────────────────────────────────────────────────────
  // 锚点：骨和第 2 步各部件的表面采样点及其位移。场的形式见 GapField。
  // Anchors: surface samples of the bones and of the parts of step 2 with their displacements. The form of the field is in GapField.
  const from: Float32Array[] = []
  const to: Float32Array[] = []
  const anchorIds = new Set<string>()
  for (const p of parts) {
    if (p.tissue !== 'bone' && !staticIds.has(p.id)) continue
    if (!overlaps(p.bbox, region, 0.25)) continue
    const a = thinPoints(surfacePoints(p.mesh, 0.004), 0.004)
    from.push(a)
    to.push(boneT.has(p.id) ? applyToPoints(boneT.get(p.id)!.T, a) : a)
    anchorIds.add(p.id)
  }
  for (const a of attached) {
    const pts = thinPoints(surfacePoints(a.part.mesh, 0.004), 0.004)
    from.push(pts)
    to.push(a.apply(pts))
    anchorIds.add(a.part.id)
  }
  // 场的作用范围：被移动的锚点的包围盒再向外 6 cm；范围边界附近的锚点因此都是不动的
  // the field's reach: the bbox of the anchors that move, plus 6 cm; anchors near its boundary are therefore all at rest
  const fregion = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  from.forEach((f, j) => {
    const t = to[j]!
    if (t === f) return
    for (let i = 0; i < f.length; i += 3) {
      if (Math.abs(t[i]! - f[i]!) + Math.abs(t[i + 1]! - f[i + 1]!) + Math.abs(t[i + 2]! - f[i + 2]!) < 1e-5) continue
      for (let k = 0; k < 3; k++) {
        if (f[i + k]! - 0.06 < fregion[k]!) fregion[k] = f[i + k]! - 0.06
        if (f[i + k]! + 0.06 > fregion[k + 3]!) fregion[k + 3] = f[i + k]! + 0.06
      }
    }
  })
  // 不动的锚点：范围内的躯干器官，以及没有进入第 2 步的肌、韧带 / anchors at rest: trunk organs within reach, and muscles and ligaments that did not enter step 2
  const unattachedIds = new Set(unattached.map((p) => p.id))
  const fieldParts: TissuePart[] = []
  for (const p of parts) {
    if (anchorIds.has(p.id) || p.tissue === 'bone' || !overlaps(p.bbox, fregion, 0.06)) continue
    if (isFixedOrgan(p) || (ATTACHED_TISSUES.has(p.tissue) && !unattachedIds.has(p.id))) {
      const pts = thinPoints(surfacePoints(p.mesh, 0.006), 0.006)
      from.push(pts)
      to.push(pts)
    } else if (overlaps(p.bbox, fregion)) fieldParts.push(p)
  }
  const anchorsFrom = concat(from)
  const anchorsTo = concat(to)
  // 腋窝以远，上肢与躯干是两个分开的节段（本模型的旧皮肤把上臂和躯干连在了一起，但里面并不相连）：
  // 沿肱骨轴在肱骨头中心以远 armSeparation[0]…[1] 之间把幂逐渐提高，使那里的组织只随离它最近的结构走，
  // 上臂的组织不被 2–3 cm 外的胸壁拖住，手旁的大腿也不被手带动。
  // Distal to the axilla the limb and the trunk are separate segments (this model's old skin joins the
  // upper arm to the trunk, but nothing inside does): along the humeral axis, between armSeparation[0]
  // and [1] beyond the head centre, the power is raised so that tissue follows only what is nearest to
  // it — the arm is not held back by the chest wall 2–3 cm away, nor the thigh drawn along by the hand.
  const axes = SIDES.map((_, i) => {
    const g = lms[i]!.gh
    const hb = bboxOfPoints(sideBones[i]!.humerus!.mesh.positions)
    const e: V3 = [(hb[0]! + hb[3]!) / 2, hb[1]!, (hb[2]! + hb[5]!) / 2]
    const l = Math.hypot(e[0] - g[0], e[1] - g[1], e[2] - g[2])
    return { g, d: [(e[0] - g[0]) / l, (e[1] - g[1]) / l, (e[2] - g[2]) / l] as V3 }
  })
  const sharpen = (x: number, y: number, zc: number): number => {
    let k = 0
    for (const a of axes) {
      const px = x - a.g[0]
      const py = y - a.g[1]
      const pz = zc - a.g[2]
      const sAx = px * a.d[0] + py * a.d[1] + pz * a.d[2]
      if (sAx <= opts.armSeparation[0]) continue
      const rho = Math.hypot(px - sAx * a.d[0], py - sAx * a.d[1], pz - sAx * a.d[2])
      if (rho > 0.2) continue
      const t = Math.min(1, (sAx - opts.armSeparation[0]) / (opts.armSeparation[1] - opts.armSeparation[0]))
      // 径向上在 15–20 cm 之间收回，免得幂在空间里突变 / faded out radially between 15 and 20 cm so that the power does not jump in space
      k = Math.max(k, t * t * (3 - 2 * t) * Math.min(1, (0.2 - rho) / 0.05))
    }
    return k
  }
  const def = new GapField(anchorsFrom, anchorsTo, opts.field, sharpen)
  const inRegion = (x: number, y: number, zc: number) => x >= fregion[0]! && x <= fregion[3]! && y >= fregion[1]! && y <= fregion[4]! && zc >= fregion[2]! && zc <= fregion[5]!
  const field = {
    anchors: def.anchors,
    displacementAt: (x: number, y: number, zc: number): [number, number, number] => (inRegion(x, y, zc) ? def.displacementAt(x, y, zc) : [0, 0, 0]),
    apply(pts: Float32Array): Float32Array {
      const out = Float32Array.from(pts)
      for (let i = 0; i < pts.length; i += 3) {
        if (!inRegion(pts[i]!, pts[i + 1]!, pts[i + 2]!)) continue
        const d = def.displacementAt(pts[i]!, pts[i + 1]!, pts[i + 2]!)
        out[i] = pts[i]! + d[0]
        out[i + 1] = pts[i + 1]! + d[1]
        out[i + 2] = pts[i + 2]! + d[2]
      }
      return out
    },
  }
  // 场在作用范围边界上应当为零：取边界 1 cm 以内的锚点处的场值 / the field must vanish on the boundary of its reach: its value at the anchors within 1 cm of the boundary
  let boundaryMax = 0
  for (let i = 0; i < anchorsFrom.length; i += 3) {
    const x = anchorsFrom[i]!
    const y = anchorsFrom[i + 1]!
    const zc = anchorsFrom[i + 2]!
    if (!inRegion(x, y, zc)) continue
    const edge = Math.min(x - fregion[0]!, fregion[3]! - x, y - fregion[1]!, fregion[4]! - y, zc - fregion[2]!, fregion[5]! - zc)
    if (edge > 0.01) continue
    const d = def.displacementAt(x, y, zc)
    boundaryMax = Math.max(boundaryMax, Math.hypot(d[0], d[1], d[2]))
  }
  const armGroups = groups.filter((g) => g.key.startsWith('arm_'))
  const nerves: TissuePart[] = []
  /** 按位移把部件归为未动、纯平移或形变 / sorts a part by its displacement into untouched, pure translation or deformed */
  const classify = (src: Float32Array, out: Float32Array): { motion: 'none' | 'rigid' | 'deformed'; group?: Group } => {
    let dev0 = 0
    const devArm = armGroups.map(() => 0)
    for (let i = 0; i < src.length; i += 3) {
      const dx = out[i]! - src[i]!
      const dy = out[i + 1]! - src[i + 1]!
      const dz = out[i + 2]! - src[i + 2]!
      dev0 = Math.max(dev0, Math.hypot(dx, dy, dz))
      armGroups.forEach((g, a) => {
        devArm[a] = Math.max(devArm[a]!, Math.hypot(dx - g.T.t[0], dy - g.T.t[1], dz - g.T.t[2]))
      })
    }
    if (dev0 <= opts.fieldDeadband) return { motion: 'none' }
    const a = devArm.findIndex((d) => d <= opts.rigidTolerance)
    return a >= 0 ? { motion: 'rigid', group: armGroups[a]! } : { motion: 'deformed' }
  }
  // 细薄的结构（血管、筋膜、皮肌、神经节）夹在相互滑动的两层之间时，位移在它自己的粗细范围内就可能相差几毫米，
  // 直接套用位移场会把管壁或筋膜的两面拧翻。所以它们的每个顶点取本部件 thinRadius 以内各顶点位移的平均：
  // 一段血管的横截面、一片筋膜的两面整体移动。淋巴结不变形：每个结节（连通分量）按其顶点位移的平均整体平移。
  // A thin structure (vessel, fascia, cutaneous muscle, ganglion) caught between two layers that slide on
  // each other can see the displacement change by millimetres across its own thickness; applying the
  // field vertex by vertex would turn a vessel wall or the two faces of a fascia inside out. So each of
  // their vertices takes the mean displacement of the part's own vertices within thinRadius: a vessel's
  // cross-section, or both faces of a fascia, move as one. Lymph nodes do not deform: every node (a
  // connected component) is translated whole by the mean displacement of its vertices.
  const isNodes = (p: TissuePart) => p.system === 'lymphatic' && /\bnodes?\b/i.test(p.name)
  const isThin = (p: TissuePart) => p.tissue === 'artery' || p.tissue === 'vein' || p.tissue === 'fascia' || p.tissue === 'nerve' || p.tissue === 'muscle' || p.tissue === 'ligament' || p.tissue === 'tendon'
  const thinIds = new Set<string>()
  const carry = (p: TissuePart): Float32Array => {
    const src = p.mesh.positions
    const out = field.apply(src)
    const nv = src.length / 3
    if (isNodes(p)) {
      // 连通分量（并查集） / connected components (union-find)
      const parent = Int32Array.from({ length: nv }, (_, i) => i)
      const find = (a: number): number => {
        while (parent[a] !== a) {
          parent[a] = parent[parent[a]!]!
          a = parent[a]!
        }
        return a
      }
      const idx = p.mesh.indices
      for (let t = 0; t < idx.length; t += 3) for (const [a, b] of [[idx[t]!, idx[t + 1]!], [idx[t + 1]!, idx[t + 2]!]] as const) {
        const ra = find(a)
        const rb = find(b)
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
      }
      const sum = new Float64Array(4 * nv)
      for (let i = 0; i < nv; i++) {
        const r = find(i)
        for (let k = 0; k < 3; k++) sum[4 * r + k] = sum[4 * r + k]! + out[3 * i + k]! - src[3 * i + k]!
        sum[4 * r + 3] = sum[4 * r + 3]! + 1
      }
      for (let i = 0; i < nv; i++) {
        const r = find(i)
        for (let k = 0; k < 3; k++) out[3 * i + k] = src[3 * i + k]! + sum[4 * r + k]! / sum[4 * r + 3]!
      }
      thinIds.add(p.id)
    } else if (isThin(p)) {
      // 在抽稀到 1.5 mm 的顶点集上求平均（原始网格很密，取固定个数的近邻盖不满 thinRadius）
      // averaged over the vertices thinned to 1.5 mm (the source meshes are dense: a fixed number of nearest vertices would not span thinRadius)
      const keep = voxelSubsample(src, 0.0015)
      const kp = new Float32Array(keep.length * 3)
      let ku = new Float32Array(keep.length * 3)
      keep.forEach((i, j) => {
        for (let k = 0; k < 3; k++) {
          kp[3 * j + k] = src[3 * i + k]!
          ku[3 * j + k] = out[3 * i + k]! - src[3 * i + k]!
        }
      })
      const index = new PointIndex(kp, opts.thinRadius)
      const K = 96
      const I = new Int32Array(K)
      const D = new Float64Array(K)
      const gather = (x: number, y: number, zc: number, u: Float32Array, o: Float32Array, at: number) => {
        const n = index.nearest(x, y, zc, K, I, D, opts.thinRadius)
        let ux = 0
        let uy = 0
        let uz = 0
        for (let j = 0; j < n; j++) {
          const q = 3 * I[j]!
          ux += u[q]!
          uy += u[q + 1]!
          uz += u[q + 2]!
        }
        o[at] = ux / n
        o[at + 1] = uy / n
        o[at + 2] = uz / n
      }
      for (let pass = 1; pass < opts.thinPasses; pass++) {
        const next = new Float32Array(ku.length)
        for (let j = 0; j < keep.length; j++) gather(kp[3 * j]!, kp[3 * j + 1]!, kp[3 * j + 2]!, ku, next, 3 * j)
        ku = next
      }
      const sm = new Float32Array(src.length)
      for (let i = 0; i < nv; i++) {
        gather(src[3 * i]!, src[3 * i + 1]!, src[3 * i + 2]!, ku, sm, 3 * i)
        for (let k = 0; k < 3; k++) sm[3 * i + k] = sm[3 * i + k]! + src[3 * i + k]!
      }
      thinIds.add(p.id)
      return sm
    }
    return out
  }
  for (const p of fieldParts) {
    if (p.centrelines && p.centrelines.length) {
      // 神经：先看中心线动了多少 / nerves: judged by how far their centrelines move
      const src = concat(p.centrelines.map((l) => l.points))
      const c = classify(src, field.apply(src))
      if (c.motion === 'none') continue
      if (c.motion === 'deformed') nerves.push(p)
      else moved.set(p.id, { mesh: { positions: applyToPoints(c.group!.T, p.mesh.positions), indices: p.mesh.indices }, centrelines: p.centrelines.map((l) => ({ points: applyToPoints(c.group!.T, l.points), radius: l.radius })), motion: 'rigid', via: 'field', group: c.group!.key })
      continue
    }
    const out = carry(p)
    const c = classify(p.mesh.positions, out)
    if (c.motion === 'none') {
      thinIds.delete(p.id)
      continue
    }
    moved.set(p.id, { mesh: { positions: c.motion === 'rigid' ? applyToPoints(c.group!.T, p.mesh.positions) : out, indices: p.mesh.indices }, motion: c.motion, via: 'field', ...(c.group ? { group: c.group.key } : {}) })
  }

  log(`field applied to ${fieldParts.length} parts (${def.anchors} anchors)`)
  // ── 4. 神经 / nerves ───────────────────────────────────────────────────────────────────────
  // 校正后的实体（骨、软骨、肌）作为碰撞对象；只做“推出骨外”，不再动肌内的走行（那在导入时已清理过）
  // the corrected solids (bone, cartilage, muscle) are what the nerves collide with; only the out-of-bone
  // clean-up runs, courses inside muscle are left as the import clean-up made them
  const posedMesh = (p: TissuePart) => moved.get(p.id)?.mesh ?? p.mesh
  const solids = parts.filter((p) => (p.tissue === 'bone' || p.tissue === 'cartilage' || p.tissue === 'muscle') && (overlaps(p.bbox, region) || overlaps(p.bbox, fregion)))
  const existing = (mesh: (p: TissuePart) => Mesh): ExistingPart[] => solids.map((p) => ({ id: p.id, fma: p.fma, name: p.name, mesh: mesh(p), stats: measure(mesh(p)), system: p.system, tissue: p.tissue }))
  log('surface fields for the nerve clean-up')
  const restField = new SurfaceField(existing((p) => p.mesh))
  const posedField = new SurfaceField(existing(posedMesh))
  const nerveRows: Record<string, unknown>[] = []
  let nLen = 0
  let boneRest = 0
  let boneField = 0
  let bonePosed = 0
  let muscleRest = 0
  let musclePosed = 0
  // 每条分支：折线顶点过位移场（上肢内的顶点因此恰好平移）；只有过场后进了骨的分支才加密、推出骨外并重新简化。
  // Per branch: the polyline's vertices go through the field (inside the limb they are therefore translated
  // exactly); only a branch that ends up in bone is densified, slid out of it and simplified again.
  for (const p of nerves) {
    const canal = canalFor(p.name)
    const rest = pathStats(p.centrelines!, restField, canal)
    const through = p.centrelines!.map((l) => ({ points: field.apply(l.points), radius: l.radius }))
    const afterField = pathStats(through, posedField, canal)
    let pushed = 0
    const branches = through.map((l, bi) => {
      if (l.points.length < 6 || pathStats([l], posedField, canal).inBone <= 0) return l
      const w = warpNerveLines([p.centrelines![bi]!], field, posedField, { ...NERVE_BUILD_DEFAULTS, maxMusclePush: 0, canal })
      pushed += w.pushed
      return w.branches[0] ?? l
    })
    const tubes: Mesh[] = []
    for (const b of branches) {
      let maxR = 0
      for (const r of b.radius) if (r > maxR) maxR = r
      const tube = buildTube(b, NERVE_BUILD_DEFAULTS.sidesByRadius.find(([r]) => maxR < r)?.[1] ?? NERVE_BUILD_DEFAULTS.sides)
      if (tube) tubes.push(tube)
    }
    if (!tubes.length) continue
    const after = pushed ? pathStats(branches, posedField, canal) : afterField
    moved.set(p.id, { mesh: mergeMeshes(tubes), centrelines: branches, motion: 'deformed', via: 'nerve' })
    nLen += rest.length
    boneRest += rest.inBone * rest.length
    boneField += afterField.inBone * afterField.length
    bonePosed += after.inBone * after.length
    muscleRest += rest.deepInMuscle * rest.length
    musclePosed += after.deepInMuscle * after.length
    nerveRows.push({ id: p.id, name: p.name, lengthMm: mm1(rest.length), inBone: [Number(rest.inBone.toFixed(4)), Number(afterField.inBone.toFixed(4)), Number(after.inBone.toFixed(4))], deepInMuscle: [Number(rest.deepInMuscle.toFixed(4)), Number(after.deepInMuscle.toFixed(4))], pointsPushed: pushed })
  }

  log(`${nerveRows.length} nerves rebuilt`)
  // ── 检查 / checks ──────────────────────────────────────────────────────────────────────────
  const meshOf = (p: TissuePart | undefined, posed: boolean) => (posed ? posedMesh(p!) : p!.mesh)
  const contact = (a: TissuePart, b: TissuePart, posed: boolean) => {
    const c = contactZone(surfacePoints(meshOf(a, posed), 0.001), new PointIndex(surfacePoints(meshOf(b, posed), 0.001), 0.004))
    return { minMm: r2(c.min * 1000), medianMm: r2(c.median * 1000), points: c.points.length / 3 }
  }
  const insideAny = (pts: Float32Array, testers: { bbox: readonly number[]; t: InsideTester }[]) => {
    let n = 0
    for (let i = 0; i < pts.length; i += 3) {
      for (const s of testers) {
        if (pts[i]! < s.bbox[0]! || pts[i]! > s.bbox[3]! || pts[i + 1]! < s.bbox[1]! || pts[i + 1]! > s.bbox[4]! || pts[i + 2]! < s.bbox[2]! || pts[i + 2]! > s.bbox[5]!) continue
        if (s.t.contains(pts[i]!, pts[i + 1]!, pts[i + 2]!)) {
          n++
          break
        }
      }
    }
    return n
  }
  const hard = parts.filter((p) => (p.tissue === 'bone' || (p.tissue === 'cartilage' && staticIds.has(p.id))) && (overlaps(p.bbox, region) || overlaps(p.bbox, fregion)))
  const testers = (posed: boolean) => hard.map((p) => {
    const m = meshOf(p, posed)
    return { id: p.id, bbox: bboxOfPoints(m.positions), t: new InsideTester(m) }
  })
  const hardRest = testers(false)
  const hardPosed = testers(true)
  const wallRibs = (posed: boolean) => (posed ? hardPosed : hardRest).filter((_, i) => / rib$/i.test(hard[i]!.name))
  const firstRib = (S: string) => bone(`${S} first rib`)
  const sidesReport: Record<string, unknown> = {}
  const transforms: Record<string, unknown> = {}
  const jointCentres: Record<string, number[]> = {}
  const pelvis = parts.filter((p) => p.tissue === 'bone' && /hip bone$/i.test(p.name))
  const pelvisCentre: V3 = [0, 0, 0]
  for (const p of pelvis) {
    const b = p.bbox
    for (let k = 0; k < 3; k++) pelvisCentre[k] = pelvisCentre[k]! + (b[k]! + b[k + 3]!) / 2 / pelvis.length
  }
  SIDES.forEach(([S, s, lat], i) => {
    const b = sideBones[i]!
    const pose = poses![i]!
    const scapPts = thinPoints(surfacePoints(b.scapula!.mesh, 0.004), 0.004)
    const scapPosed = applyToPoints(pose.scapula, scapPts)
    // 肱骨干方向：近端 25–75 % 之间两段质心的连线 / humeral shaft direction: line between the centroids of two slabs within 25–75 % of its length
    const shaft = (m: Mesh): V3 => {
      const bb = bboxOfPoints(m.positions)
      const slab = (f0: number, f1: number): V3 => {
        const c: V3 = [0, 0, 0]
        let n = 0
        for (let k = 0; k < m.positions.length; k += 3) {
          const f = (m.positions[k + 1]! - bb[1]!) / (bb[4]! - bb[1]!)
          if (f < f0 || f > f1) continue
          c[0] += m.positions[k]!
          c[1] += m.positions[k + 1]!
          c[2] += m.positions[k + 2]!
          n++
        }
        return [c[0] / n, c[1] / n, c[2] / n]
      }
      const a = slab(0.65, 0.75)
      const d = slab(0.25, 0.35)
      const l = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2])
      return [(d[0] - a[0]) / l, (d[1] - a[1]) / l, (d[2] - a[2]) / l]
    }
    const sh0 = shaft(b.humerus!.mesh)
    const sh1 = shaft(posedMesh(b.humerus!))
    const hb0 = bboxOfPoints(b.humerus!.mesh.positions)
    const elbow0: V3 = [(hb0[0]! + hb0[3]!) / 2, hb0[1]!, (hb0[2]! + hb0[5]!) / 2]
    const elbow1 = applyT(pose.arm, elbow0)
    const rel = (e: V3) => [mm1(lat * (e[0] - pelvisCentre[0])), mm1(e[1] - pelvisCentre[1]), mm1(e[2] - pelvisCentre[2])]
    const fr = firstRib(S)
    sidesReport[S.toLowerCase()] = {
      anglesDeg: Object.fromEntries(keys.map((k) => [k, { before: r1(before[i]![k]), after: r1(pose.angles[k]), sdFromRestingMean: [r2(z(k, before[i]![k])), r2(z(k, pose.angles[k]))] }])),
      clavicleLengthMm: mm1(Math.hypot(lms[i]!.ac[0] - lms[i]!.sc[0], lms[i]!.ac[1] - lms[i]!.sc[1], lms[i]!.ac[2] - lms[i]!.sc[2])),
      sternoclavicularRotationDeg: r1(pose.scRotationDeg),
      acromioclavicularRotationDeg: r1(pose.acRotationDeg),
      glenohumeralRotationDeg: r1((rotationAngleOf(pose.scapula.r) * 180) / Math.PI),
      humeralHeadCentreMovedMm: pose.arm.t.map(mm1),
      humeralHeadRadiusMm: mm1(lms[i]!.ghRadius),
      solver: { iterations: pose.iterations, cost: r2(pose.cost) },
      scapulothoracic: {
        standOffChangeMm: { rms: r2(pose.standOff.rmsMm), maxCloser: r2(pose.standOff.maxCloserMm), maxFurther: r2(pose.standOff.maxFurtherMm) },
        costalSurfaceToChestWall: { before: gapStats(costal[i]!.points, wall), after: gapStats(applyToPoints(pose.scapula, costal[i]!.points), wall) },
        wholeScapulaToRibs: { before: gapStats(scapPts, ribs), after: gapStats(scapPosed, ribs) },
        scapulaSurfaceInsideRibs: { before: insideAny(scapPts, wallRibs(false)) / (scapPts.length / 3), after: insideAny(scapPosed, wallRibs(true)) / (scapPts.length / 3) },
      },
      jointGaps: {
        glenohumeral: { before: contact(b.humerus!, b.scapula!, false), after: contact(b.humerus!, b.scapula!, true) },
        acromioclavicular: { before: contact(b.clavicle!, b.scapula!, false), after: contact(b.clavicle!, b.scapula!, true) },
        sternoclavicular: { before: contact(b.clavicle!, manubrium, false), after: contact(b.clavicle!, manubrium, true) },
        ...(fr ? { clavicleToFirstRib: { before: contact(b.clavicle!, fr, false), after: contact(b.clavicle!, fr, true) } } : {}),
      },
      arm: {
        bones: armCounts[i],
        shaftDirection: { before: sh0.map((v) => Number(v.toFixed(4))), after: sh1.map((v) => Number(v.toFixed(4))), changeDeg: r2((Math.acos(Math.min(1, sh0[0] * sh1[0] + sh0[1] * sh1[1] + sh0[2] * sh1[2])) * 180) / Math.PI) },
        elbowRelativeToPelvisMm: { before: rel(elbow0), after: rel(elbow1), note: 'lateral, up, forwards; elbow = centre of the distal end of the humerus, pelvis = centre of the hip bones' },
      },
    }
    for (const [key, T] of [[`clavicle_${s}`, pose.clavicle], [`scapula_${s}`, pose.scapula], [`arm_${s}`, pose.arm]] as [string, RigidT][]) {
      const inv = invertT(T)
      transforms[key] = { rotation: T.r.map((v) => Number(v.toFixed(8))), translationM: T.t.map((v) => Number(v.toFixed(7))), inverse: { rotation: inv.r.map((v) => Number(v.toFixed(8))), translationM: inv.t.map((v) => Number(v.toFixed(7))) } }
    }
    // 其余大关节（校正后的位置） / the other large joints (positions after the correction)
    const limb = limbJointCentres(lat, { femur: bone(`${S} femur`)?.mesh, talus: bone(`${S} talus`)?.mesh, humerus: posedMesh(b.humerus!), capitate: bone(`${S} capitate`) ? posedMesh(bone(`${S} capitate`)!) : undefined })
    for (const [k, v] of Object.entries(limb)) jointCentres[`${k}_${s}`] = (v as V3).map((x) => Number(x.toFixed(5)))
    jointCentres[`sternoclavicular_${s}`] = pose.lm.sc.map((v) => Number(v.toFixed(5)))
    jointCentres[`acromioclavicular_${s}`] = pose.lm.ac.map((v) => Number(v.toFixed(5)))
    jointCentres[`glenohumeral_${s}`] = pose.lm.gh.map((v) => Number(v.toFixed(5)))
  })

  log('joint and scapulothoracic checks')
  // 附着点：每个跨骨部件在它所附着的每组骨上，校正前后贴骨的顶点数与最近距离
  // attachments: for every attached part and each bone group it attaches to, the vertices on the bone and the closest approach, before and after
  const posedGroupIndex = groups.map((g) => (g.key === 'static' ? g.index : new PointIndex(applyToPoints(g.T, g.index.points), 0.006)))
  let attachWorstGap = { id: '', name: '', group: '', mm: 0 }
  let attachLost = 0
  let attachChecked = 0
  const attachRows: Record<string, unknown>[] = []
  for (const a of attached) {
    if (a.motion !== 'deformed') continue
    const v0 = a.part.mesh.positions
    const v1 = moved.get(a.part.id)!.mesh.positions
    const row: Record<string, unknown> = { id: a.part.id, name: a.part.name }
    for (const gi of a.groups) {
      let min0 = Infinity
      let min1 = Infinity
      for (let i = 0; i < v0.length; i += 3) {
        const d0 = groups[gi]!.index.distance(v0[i]!, v0[i + 1]!, v0[i + 2]!, 0.05)
        const d1 = posedGroupIndex[gi]!.distance(v1[i]!, v1[i + 1]!, v1[i + 2]!, 0.05)
        if (d0 < min0) min0 = d0
        if (d1 < min1) min1 = d1
      }
      attachChecked++
      // 附着端离开了骨：最近距离比校正前大 1 mm 以上 / an attachment end has left its bone: the closest approach grew by more than 1 mm
      if (min1 > min0 + 0.001) attachLost++
      if ((min1 - min0) * 1000 > attachWorstGap.mm) attachWorstGap = { id: a.part.id, name: a.part.name, group: groups[gi]!.key, mm: r2((min1 - min0) * 1000) }
      row[groups[gi]!.key] = { closestMm: [r2(min0 * 1000), r2(min1 * 1000)] }
    }
    attachRows.push(row)
  }

  log('attachment checks')
  // 骨内比例：区域内软组织表面采样点落在骨（及肋软骨）内的比例，校正前后
  // share inside bone: surface samples of the region's soft parts that lie inside bone (and costal cartilage), before and after
  let in0 = 0
  let in1 = 0
  let inN = 0
  const insideRows: { id: string; name: string; before: number; after: number; samples: number }[] = []
  // 折叠：在每个形变部件自己的顶点处取其映射的雅可比行列式（≤ 0 即空间被翻折）。
  // 不用“三角形法线是否反向”来判断：肩胛骨在胸壁上滑动处是很强的剪切，法线会转过 90° 以上而并没有折叠。
  // Folding: the Jacobian determinant of each deformed part's own map at its vertices (≤ 0 = space
  // folded). Reversed triangle normals are not used as the test: where the scapula glides on the chest
  // wall the shear is strong enough to turn a normal by more than 90° without any fold.
  const mapDets: number[] = []
  const foldRows: { id: string; name: string; via: string; samples: number; nonPositive: number; min: number }[] = []
  const attachedById = new Map(attached.map((a) => [a.part.id, a]))
  const detsOf = (f: (pts: Float32Array) => Float32Array, v: Float32Array, stride: number): number[] => {
    const h = 0.001
    const q: number[] = []
    for (let i = 0; i < v.length; i += 3 * stride) for (const [dx, dy, dz] of [[h, 0, 0], [-h, 0, 0], [0, h, 0], [0, -h, 0], [0, 0, h], [0, 0, -h]] as const) q.push(v[i]! + dx, v[i + 1]! + dy, v[i + 2]! + dz)
    const o = f(Float32Array.from(q))
    const out: number[] = []
    for (let i = 0; i < o.length; i += 18) {
      const c = (k: number, a: number) => (o[i + 6 * k + a]! - o[i + 6 * k + 3 + a]!) / (2 * h)
      // 第 k 列 = 对第 k 个坐标的偏导 / column k = the partial derivative in coordinate k
      const F = [c(0, 0), c(1, 0), c(2, 0), c(0, 1), c(1, 1), c(2, 1), c(0, 2), c(1, 2), c(2, 2)]
      out.push(F[0]! * (F[4]! * F[8]! - F[5]! * F[7]!) - F[1]! * (F[3]! * F[8]! - F[5]! * F[6]!) + F[2]! * (F[3]! * F[7]! - F[4]! * F[6]!))
    }
    return out
  }
  let thinTriangles = 0
  let thinFlipped = 0
  const thinRows: { id: string; name: string; triangles: number; reversed: number }[] = []
  const triNormal = (q: Float32Array, a: number, b: number, c: number): V3 => {
    const ux = q[3 * b]! - q[3 * a]!
    const uy = q[3 * b + 1]! - q[3 * a + 1]!
    const uz = q[3 * b + 2]! - q[3 * a + 2]!
    const vx = q[3 * c]! - q[3 * a]!
    const vy = q[3 * c + 1]! - q[3 * a + 1]!
    const vz = q[3 * c + 2]! - q[3 * a + 2]!
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
  }
  const counts = { rigid: 0, deformed: 0 }
  const byVia: Record<string, number> = {}
  const byTissue: Record<string, { rigid: number; deformed: number }> = {}
  for (const p of parts) {
    const m = moved.get(p.id)
    if (!m) continue
    counts[m.motion]++
    byVia[`${m.via}/${m.motion}`] = (byVia[`${m.via}/${m.motion}`] ?? 0) + 1
    const t = (byTissue[p.tissue] ??= { rigid: 0, deformed: 0 })
    t[m.motion]++
    if (p.tissue === 'bone') continue
    if (m.motion === 'deformed' && thinIds.has(p.id)) {
      // 细薄结构：数法线反向的三角形（它的每个截面是整体移动的，法线反向就是管壁翻了面或折了死弯）
      // thin structures: triangles whose normal reverses (their cross-sections move as one, so a reversed normal is a wall turned inside out or a kink)
      const idx = p.mesh.indices
      let bad = 0
      for (let t3 = 0; t3 < idx.length; t3 += 3) {
        const n0 = triNormal(p.mesh.positions, idx[t3]!, idx[t3 + 1]!, idx[t3 + 2]!)
        const n1 = triNormal(m.mesh.positions, idx[t3]!, idx[t3 + 1]!, idx[t3 + 2]!)
        if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < 0) bad++
      }
      thinTriangles += idx.length / 3
      thinFlipped += bad
      if (bad) thinRows.push({ id: p.id, name: p.name, triangles: idx.length / 3, reversed: bad })
    } else if (m.motion === 'deformed' && m.via !== 'nerve') {
      const nv = p.mesh.positions.length / 3
      const f = m.via === 'attachment' ? attachedById.get(p.id)!.apply : field.apply
      const d = detsOf(f, p.mesh.positions, Math.max(1, Math.floor(nv / 300)))
      let min = Infinity
      let bad = 0
      for (const x of d) {
        mapDets.push(x)
        if (x < min) min = x
        if (x <= 0) bad++
      }
      if (bad) foldRows.push({ id: p.id, name: p.name, via: m.via, samples: d.length, nonPositive: bad, min: Number(min.toFixed(3)) })
    }
    if (p.tissue === 'skin' || m.via === 'nerve') continue
    const s0 = thinPoints(surfacePoints(p.mesh, 0.003), 0.003)
    const s1 = thinPoints(surfacePoints(m.mesh, 0.003), 0.003)
    const a = insideAny(s0, hardRest)
    const b = insideAny(s1, hardPosed)
    in0 += a
    in1 += b
    inN += s0.length / 3
    insideRows.push({ id: p.id, name: p.name, before: Number((a / Math.max(1, s0.length / 3)).toFixed(4)), after: Number((b / Math.max(1, s1.length / 3)).toFixed(4)), samples: s0.length / 3 })
  }
  mapDets.sort((a, b) => a - b)
  foldRows.sort((a, b) => b.nonPositive - a.nonPositive || (a.id < b.id ? -1 : 1))
  insideRows.sort((a, b) => b.after - b.before - (a.after - a.before) || (a.id < b.id ? -1 : 1))

  log('attachment and inside-bone checks')
  // 位移场的雅可比行列式：在锚点附近的网格上取样 / Jacobian determinant of the field, sampled on a grid near the anchors
  const anchorIndex = new PointIndex(anchorsFrom, 0.02)
  const dets: number[] = []
  const foldsAt: V3[] = []
  {
    const h = 0.002
    const step = 0.01
    for (let x = fregion[0]!; x <= fregion[3]!; x += step) for (let y = fregion[1]!; y <= fregion[4]!; y += step) for (let zc = fregion[2]!; zc <= fregion[5]!; zc += step) {
      if (anchorIndex.distance(x, y, zc, 0.03) > 0.03) continue
      const J: number[] = []
      for (const [dx, dy, dz] of [[h, 0, 0], [0, h, 0], [0, 0, h]] as const) {
        const a = def.displacementAt(x + dx, y + dy, zc + dz)
        const b = def.displacementAt(x - dx, y - dy, zc - dz)
        J.push((a[0] - b[0]) / (2 * h), (a[1] - b[1]) / (2 * h), (a[2] - b[2]) / (2 * h))
      }
      // J 的三列是对 x、y、z 的偏导；F = I + ∇u / the three triples are the partial derivatives in x, y, z; F = I + ∇u
      const F = [1 + J[0]!, J[3]!, J[6]!, J[1]!, 1 + J[4]!, J[7]!, J[2]!, J[5]!, 1 + J[8]!]
      const det = F[0]! * (F[4]! * F[8]! - F[5]! * F[7]!) - F[1]! * (F[3]! * F[8]! - F[5]! * F[6]!) + F[2]! * (F[3]! * F[7]! - F[4]! * F[6]!)
      dets.push(Math.abs(det - 1) > 1e-9 ? det : 1)
      if (det <= 0) foldsAt.push([x, y, zc])
    }
  }
  dets.sort((a, b) => a - b)
  // 折叠点按高度（5 cm 一档）和左右统计 / folded samples counted by height (5 cm bands) and side
  const foldLevels: Record<string, number> = {}
  for (const f of foldsAt) {
    const k = `${f[0] >= midX ? 'L' : 'R'} y ${(Math.floor(f[1] / 0.05) * 0.05).toFixed(2)}–${(Math.floor(f[1] / 0.05) * 0.05 + 0.05).toFixed(2)}`
    foldLevels[k] = (foldLevels[k] ?? 0) + 1
  }

  log('jacobian')
  // 左右对称：把右侧镜像到左侧后比较 / left-right symmetry: the right side mirrored onto the left
  const mirror = (v: V3): V3 => [2 * midX - v[0], v[1], v[2]]
  const symmetry = {
    glenohumeralCentreMm: mm1(Math.hypot(...(poses[0]!.lm.gh.map((v, k) => v - mirror(poses![1]!.lm.gh)[k]!) as V3))),
    acromioclavicularCentreMm: mm1(Math.hypot(...(poses[0]!.lm.ac.map((v, k) => v - mirror(poses![1]!.lm.ac)[k]!) as V3))),
    humeralHeadDisplacementMm: mm1(Math.hypot(poses[0]!.arm.t[0] + poses[1]!.arm.t[0], poses[0]!.arm.t[1] - poses[1]!.arm.t[1], poses[0]!.arm.t[2] - poses[1]!.arm.t[2])),
    anglesDeg: Object.fromEntries(keys.map((k) => [k, r1(Math.abs(poses![0]!.angles[k] - poses![1]!.angles[k]))])),
    beforeGlenohumeralCentreMm: mm1(Math.hypot(...(lms[0]!.gh.map((v, k) => v - mirror(lms[1]!.gh)[k]!) as V3))),
  }

  const report: Record<string, unknown> = {
    applied: true,
    method: 'closed-chain solve per side (clavicle about the sternoclavicular centre, scapula about the acromioclavicular centre gliding on the chest wall, limb translated with the humeral head centre); soft tissue by bone-group attachment blending and a kernel displacement field',
    ...kinematics,
    sides: sidesReport,
    transforms: { note: 'x ↦ rotation·x + translation (row-major, metres, runtime frame); `inverse` takes the corrected posture back to the as-scanned one. arm_* applies to the humerus and every bone distal to it.', ...transforms },
    jointCentresM: { note: 'after the correction; sternoclavicular and acromioclavicular = centres of the contact zones, glenohumeral = centre of the sphere fitted to the humeral head, the others by the simple definitions of limbJointCentres (shoulder.ts); rig.json, once rebuilt on this geometry, has the exact centres and axes', ...jointCentres },
    symmetry,
    field: {
      anchors: def.anchors, options: opts.field, regionM: fregion.map((v) => Number(v.toFixed(3))), largestDisplacementNearBoundaryMm: r2(boundaryMax * 1000),
      jacobian: { samples: dets.length, min: Number((dets[0] ?? 1).toFixed(3)), p1: Number(quant(dets, 0.01).toFixed(3)), median: Number(quant(dets, 0.5).toFixed(3)), p99: Number(quant(dets, 0.99).toFixed(3)), max: Number((dets[dets.length - 1] ?? 1).toFixed(3)), nonPositive: dets.filter((d) => d <= 0).length, nonPositiveByLevel: foldLevels },
    },
    parts: {
      moved: moved.size, ...counts, byVia, byTissue,
      attached: { parts: attached.length, untouched: attached.filter((a) => a.motion === 'none').length, rigid: attached.filter((a) => a.motion === 'rigid').length, deformed: attached.filter((a) => a.motion === 'deformed').length },
      mapJacobianAtVertices: { samples: mapDets.length, min: Number((mapDets[0] ?? 1).toFixed(3)), p1: Number(quant(mapDets, 0.01).toFixed(3)), median: Number(quant(mapDets, 0.5).toFixed(3)), p99: Number(quant(mapDets, 0.99).toFixed(3)), nonPositive: mapDets.filter((d) => d <= 0).length, partsWithFolds: foldRows },
      thinStructures: { parts: thinIds.size, triangles: thinTriangles, reversedTriangles: thinFlipped, partsWithReversedTriangles: thinRows.sort((a, b) => b.reversed - a.reversed || (a.id < b.id ? -1 : 1)) },
    },
    attachments: { note: 'closest approach of every deformed attached part to each bone group it attaches to, before and after (mm)', checked: attachChecked, movedOffBoneByMoreThan1Mm: attachLost, largestIncrease: attachWorstGap, perPart: attachRows },
    insideBone: { samples: inN, before: Number((in0 / Math.max(1, inN)).toFixed(5)), after: Number((in1 / Math.max(1, inN)).toFixed(5)), largestIncreases: insideRows.slice(0, 12), largestDecreases: insideRows.slice(-6).reverse() },
    nerves: {
      rebuilt: nerveRows.length, lengthM: Number(nLen.toFixed(2)),
      inBone: { before: Number((boneRest / Math.max(1e-9, nLen)).toFixed(5)), afterField: Number((boneField / Math.max(1e-9, nLen)).toFixed(5)), afterCleanUp: Number((bonePosed / Math.max(1e-9, nLen)).toFixed(5)) },
      deepInMuscle: { before: Number((muscleRest / Math.max(1e-9, nLen)).toFixed(5)), after: Number((musclePosed / Math.max(1e-9, nLen)).toFixed(5)) },
      perNerve: nerveRows,
    },
    partMotion: attachmentRows,
  }
  return { moved, report }
}

export type { GirdleLandmarks }
