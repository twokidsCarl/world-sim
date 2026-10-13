// 上肢外展：把腋窝打开。
// BodyParts3D 是仰卧成像，两臂贴在身侧：肱骨上段的臂肌与躯干肌之间没有空隙，皮肤无从通过。
// 站立的解剖学姿势里上肢是略为外展的。这里在肩带校正之后，把每侧的游离上肢（肱骨及其以远的一切）
// 绕肱骨头球心、绕前后轴（冠状面内）转一个角度；两侧同角度，角度取“刚好让出腋窝”的最小值（见 chooseAngle）。
//   1. 骨：上肢各骨整体转动；肩胛骨、锁骨不动（外展起始的 30° 内肩胛骨的参与很小且因人而异，见 SCAPULOHUMERAL_NOTE）。
//   2. 附着在骨上的部件（肌、腱、韧带）：只附着于上肢骨的整体随转；只附着于躯干骨的不动；跨盂肱关节的
//      （三角肌、胸大肌、背阔肌、大圆肌、肩袖各肌、喙肱肌、肱二头肌、肱三头肌长头、关节囊与韧带）
//      按到两端附着面的距离取一个 0…1 的权重 w，每个顶点绕同一轴转 w·θ——混合的是转角而不是位移，
//      所以 w 为常数的地方是严格的刚体运动，不会缩短。
//   3. 不附着在骨上的部件（腋血管、臂丛、淋巴结、筋膜、旧皮肤）：w 取自一个标量场，
//      该场由第 1、2 步的表面锚点按间隙自适应的反距离加权插值得到（shoulderTissue.ts 的 GapField）。
//      细薄结构在自身粗细范围内把 w 取平均（横截面整体转动），淋巴结逐个整体转动。
//   4. 神经：中心线过同一映射，进了骨的分支再推出骨外，然后重建管状网格。
// 之后是一组数值检查（臂–躯干间隙、盂肱关节间隙、跨关节肌的长度和体积、折叠、附着点、骨内比例），写进管线报告。
//
// Abduction of the upper limbs: opening the axilla.
// BodyParts3D was imaged supine with the arms against the sides: along the upper humerus the arm
// muscles and the trunk muscles touch, and no skin can pass between them. In the standing anatomical
// posture the limbs are slightly abducted. After the shoulder girdle correction, each free limb
// (the humerus and everything distal to it) is turned here about the centre of the humeral head,
// about the antero-posterior axis (in the coronal plane); the same angle on both sides, the smallest
// that gives a real axilla (see chooseAngle).
//   1. Bones: the bones of the limb turn as one block; scapula and clavicle stay (in the first 30° of
//      abduction the scapula contributes little and inconsistently, see SCAPULOHUMERAL_NOTE).
//   2. Parts attached to bone (muscle, tendon, ligament): attached to limb bones only — turned whole;
//      to trunk bones only — left alone; crossing the glenohumeral joint (deltoid, pectoralis major,
//      latissimus dorsi, teres major, the rotator cuff, coracobrachialis, biceps, long head of triceps,
//      capsule and ligaments) — a weight w in 0…1 from the distances to the two attachment sites, and
//      every vertex turns by w·θ about the same axis. It is the angle that is blended, not the
//      displacement, so wherever w is constant the motion is exactly rigid and nothing shortens.
//   3. Parts not attached to bone (axillary vessels, brachial plexus, lymph nodes, fasciae, the old
//      skin): w comes from a scalar field interpolated from the surface anchors of steps 1 and 2 by
//      gap-adaptive inverse-distance weighting (GapField of shoulderTissue.ts). Thin structures
//      average w over their own thickness (a cross-section turns as one); lymph nodes turn one by one.
//   4. Nerves: centrelines go through the same map, branches that end up in bone are slid out of it,
//      and the tubes are rebuilt.
// Then a set of numeric checks (arm–trunk gap, glenohumeral gap, length and volume of the crossing
// muscles, folding, attachments, share inside bone) for the pipeline report.

import type { TissueId } from '../../src/anatomy/types.ts'
import { FAT_DEEP_TISSUES } from './fat.ts'
import { measure, type Mesh } from './geometry.ts'
import { SurfaceField, type ExistingPart } from './import3.ts'
import { canalFor, NERVE_BUILD_DEFAULTS, pathStats, warpNerveLines } from './importZa.ts'
import { InsideTester, PointIndex, surfacePoints, thinPoints, voxelSubsample } from './register.ts'
import { contactZone, girdleLandmarks, limbJointCentres, type V3 } from './shoulder.ts'
import { GapField, GIRDLE_MUSCLE_ATTACHMENTS, SHOULDER_DEFAULTS, type CarriedPart, type GapFieldOptions, type TissuePart } from './shoulderTissue.ts'
import { SurfaceDistance } from './skinPackage.ts'
import { buildTube, mergeMeshes, type Polyline } from './tube.ts'

export interface AbductionOptions {
  /** 外展角（度）；'auto' = 按几何取满足间隙要求的最小角 / abduction angle (degrees); 'auto' = the smallest angle that meets the gap requirement, from geometry */
  angleDeg: number | 'auto'
  /**
   * 钉住的外展角（度），只在 angleDeg 为 'auto' 时起作用：自动判据照样算、照样写进报告，但实际用这个角。
   * 用途：自动判据按 angleStep 取整，输入稍有变化就可能跳一档；而皮肤包是按某一个角的骨架拟合的，不能跟着跳。
   * 钉住的角必须仍满足间隙要求，否则构建报错（不悄悄用一个不够的角）。
   * A pinned abduction angle (degrees), effective only while angleDeg is 'auto': the automatic criterion is still
   * evaluated and reported, but this angle is the one used. Why: the automatic choice is stepped by angleStep and can
   * jump a step on a small change of the input, while a skin package is fitted to the skeleton at one angle and
   * cannot follow. The pinned angle must still meet the gap requirement; otherwise the build fails (an insufficient
   * angle is never used silently).
   */
  pinned?: { angleDeg: number; reason: { zh: string; en: string } }
  /** 自动取角：臂与躯干深部结构之间至少要有这么宽（米）= 2 ×（皮肤 + 皮下脂肪） / auto: the arm and trunk deep parts must be at least this far apart (m) = 2 × (skin + subcutaneous fat) */
  minGap: number
  /** 自动取角：从肱骨长度的这个比例处起往远端都要满足（0 = 肱骨头中心，1 = 肘） / auto: required from this fraction of the humerus downwards (0 = head centre, 1 = elbow) */
  fromFraction: number
  /** 自动取角：点采样的距离可能偏大这么多（米），加在 minGap 上 / auto: distances between point samples may read this much high (m); added to minGap */
  samplingAllowance: number
  /** 自动取角：腋襞肌的间隙从其肱骨止点远端再往下这么多档（每档为肱骨长的 5%）起要求 / auto: the gap to the fold muscles is required from this many bands (5% of the humerus each) below the distal end of their insertions */
  foldBandsBelowInsertion: number
  /** 自动取角：扫描的步长和上限（度） / auto: step and upper bound of the scan (degrees) */
  angleStep: number
  maxAngle: number
  /** 形变作用范围：上肢骨的包围盒向外这么远（米） / reach of the deformation: this far beyond the bbox of the limb bones (m) */
  reach: number
  /** 部件表面距某组骨在此距离以内算附着（米） / a part is attached to a bone group within this distance (m) */
  attachDistance: number
  /** 表中的肩带肌离它该附着的骨最远可以有这么远（米） / a listed girdle muscle may stay this far from a bone it is listed for (m) */
  listedAttachDistance: number
  /** 混合权重 1/(d + blendOffset)^blendPower；归一后小于 saturate 的归零、大于 1 − saturate 的归一 / blend weights 1/(d + blendOffset)^blendPower; after normalising, below `saturate` becomes 0 and above 1 − saturate becomes 1 */
  blendOffset: number
  blendPower: number
  saturate: number
  /** 肌腹在躯干上的跨关节肌：止点处肱骨的转动作用到多远——rigidNear 以内完整，到 rigidFar 处收到零（米） / crossing muscles with their belly on the trunk: how far the humerus' rotation reaches from the insertion — in full within rigidNear, none from rigidFar on (m) */
  rigidNear: number
  rigidFar: number
  /** 肌腹在臂内的肌：躯干端附着点的作用在离它这两个距离之间收到零（米） / muscles whose belly lies in the arm: the pull of the trunk-side site fades to zero between these two distances from it (m) */
  girdleReach: [number, number]
  /** 沿肱骨轴、肱骨头中心以远这两个距离之间，上肢与躯干逐渐分开（米） / between these two distances beyond the head centre along the humeral axis the limb separates from the trunk (m) */
  armSeparation: [number, number]
  /** 细薄结构取权重平均的遍数和半径（米） / passes and radius (m) of the weight averaging for thin structures */
  thinPasses: number
  thinRadius: number
  field: GapFieldOptions
  /**
   * 每侧游离上肢的骨（部件 id）；不给则按男性构建的规则取（名称带左/右、在体侧 12 cm 以外、高于 0.55 m 的骨，锁骨和肩胛骨除外）。
   * 别的身体（如女性构建）应当自己给出。
   * The bones of each free limb (part ids); when absent they are taken by the male build's rule (bones
   * named left/right, more than 12 cm from the midline and above 0.55 m, clavicle and scapula
   * excepted). Another body (the female build) should give its own.
   */
  limbBoneIds?: { L: string[]; R: string[] }
  /** 肱骨头球心（肩带校正的报告里有）；不给则重新拟合 / centres of the humeral heads (the shoulder report has them); fitted again when absent */
  headCentres?: { L: V3; R: V3 }
  log?: (message: string) => void
}

export const ABDUCTION_DEFAULTS: AbductionOptions = {
  angleDeg: 'auto',
  minGap: 0.012,
  fromFraction: 0.25,
  samplingAllowance: 0.001,
  foldBandsBelowInsertion: 2,
  angleStep: 0.5,
  maxAngle: 25,
  reach: 0.1,
  attachDistance: SHOULDER_DEFAULTS.attachDistance,
  listedAttachDistance: SHOULDER_DEFAULTS.listedAttachDistance,
  blendOffset: SHOULDER_DEFAULTS.blendOffset,
  blendPower: SHOULDER_DEFAULTS.blendPower,
  saturate: SHOULDER_DEFAULTS.saturate,
  rigidNear: SHOULDER_DEFAULTS.rigidNear,
  rigidFar: SHOULDER_DEFAULTS.rigidFar,
  girdleReach: SHOULDER_DEFAULTS.girdleReach,
  armSeparation: SHOULDER_DEFAULTS.armSeparation,
  thinPasses: SHOULDER_DEFAULTS.thinPasses,
  thinRadius: SHOULDER_DEFAULTS.thinRadius,
  field: SHOULDER_DEFAULTS.field,
}

/**
 * 肩胛骨不动是一个建模上的选择，不是引自文献的结论：外展只有几度，这里不给肩胛骨加耦合的上回旋。
 * 常见的说法是肩肱节律（盂肱 : 肩胛胸壁 ≈ 2 : 1）在外展起始的约 30° 内并不成立、肩胛骨此时动得很少
 * （通常归于 Inman、Saunders 与 Abbott 1944），但本次工作没有打开任何出处核对，所以标为未核实。
 * Leaving the scapula where it is is a modelling choice, not a finding taken from the literature: the
 * abduction is a few degrees and no coupled upward rotation is given to the scapula. It is commonly
 * said that scapulohumeral rhythm (glenohumeral : scapulothoracic ≈ 2 : 1) does not hold in about the
 * first 30° of abduction, where the scapula moves little (usually attributed to Inman, Saunders and
 * Abbott 1944), but no source was opened and checked during this work, so it is marked unverified.
 */
export const SCAPULOHUMERAL_NOTE = {
  statement: 'modelling choice: scapula and clavicle are kept fixed, with no coupled scapular upward rotation, for an abduction of a few degrees',
  source: 'none opened; the usual attribution for "little scapular motion in the first 30° of abduction" is Inman VT, Saunders JB, Abbott LC, J Bone Joint Surg 1944;26:1–30, cited here from memory only',
  verified: false,
}

const ATTACHED_TISSUES: ReadonlySet<TissueId> = new Set<TissueId>(['muscle', 'tendon', 'ligament'])
const CUTANEOUS_MUSCLES = /platysma/i
/**
 * 肌腹在臂的筋膜室内的跨关节肌：权重按到上肢骨本身的距离算（肌腹随臂走，只有近端的腱在腋窝里改变方向）。
 * 其余跨关节肌（胸大肌、背阔肌、大圆肌、肩袖）的肌腹在躯干或肩胛骨上：按到肱骨上的止点面的距离算。
 * Crossing muscles whose belly lies in the fascial compartment of the arm: the weight goes by the
 * distance to the limb bones themselves (the belly rides with the arm, only the proximal tendon
 * re-angles in the axilla). The other crossing muscles (pectoralis major, latissimus dorsi, teres
 * major, the cuff) have their belly on the trunk or the scapula: by the distance to their insertion
 * site on the humerus.
 */
const BELLY_IN_ARM = /deltoid|biceps brachii|triceps brachii|coracobrachialis/i
/** 同 shoulderTissue.ts：躯干和颈部的器官不动 / as in shoulderTissue.ts: organs of the trunk and neck stay */
const isFixedOrgan = (p: TissuePart) => (['organ', 'heart', 'gland', 'brain', 'space', 'tooth'].includes(p.tissue) && !/\bnodes?\b/i.test(p.name)) || (p.tissue === 'skin' && /\bhair of head\b/i.test(p.name)) || (p.tissue === 'cartilage' && !/costal cartilage/i.test(p.name) && p.system !== 'skeletal')
const SIDES = [['Left', 'L', 1], ['Right', 'R', -1]] as const
const r1 = (v: number) => Math.round(v * 10) / 10
const r2 = (v: number) => Math.round(v * 100) / 100
const r4 = (v: number) => Math.round(v * 1e4) / 1e4
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
 * 把点绕过 `c`、平行于 Z（前后）轴的轴线转 `angle` 弧度；正角使 c 下方的点向 +X 移动。
 * Turns points by `angle` radians about the line through `c` parallel to the Z (antero-posterior)
 * axis; a positive angle moves a point below c towards +X.
 */
export function rotateAboutZ(pts: ArrayLike<number>, c: V3, angle: number): Float32Array {
  const out = new Float32Array(pts.length)
  const cs = Math.cos(angle)
  const sn = Math.sin(angle)
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i]! - c[0]
    const y = pts[i + 1]! - c[1]
    out[i] = c[0] + cs * x - sn * y
    out[i + 1] = c[1] + sn * x + cs * y
    out[i + 2] = pts[i + 2]!
  }
  return out
}

/** 外展一侧上肢的刚体变换（行主序旋转 + 平移），与肩带报告的 transforms 同格式 / the rigid transform of one abducted limb (row-major rotation + translation), in the format of the shoulder report's transforms */
export function abductionTransform(c: V3, angle: number): { rotation: number[]; translationM: number[] } {
  const cs = Math.cos(angle)
  const sn = Math.sin(angle)
  return { rotation: [cs, -sn, 0, sn, cs, 0, 0, 0, 1], translationM: [c[0] - cs * c[0] + sn * c[1], c[1] - sn * c[0] - cs * c[1], 0] }
}

interface SideGeom {
  S: 'Left' | 'Right'
  s: 'L' | 'R'
  lat: 1 | -1
  gh: V3
  elbow: V3
  axis: V3
  length: number
  humerus: TissuePart
  scapula: TissuePart
  armBones: TissuePart[]
  armIndex: PointIndex
  armBox: number[]
}

export interface AbductionResult {
  moved: Map<string, CarriedPart>
  report: Record<string, unknown>
}

/** 每个点两个权重：[左臂, 右臂] / two weights per point: [left limb, right limb] */
type Weights = (pts: Float32Array) => Float32Array

/**
 * 对整个人体做上肢外展。`parts` 是肩带校正之后的全部部件；返回发生变化的部件和报告。找不到所需的骨时返回 null。
 * Abducts the upper limbs of the whole body. `parts` is every part after the shoulder girdle
 * correction; returns the parts that changed and the report. Null when a bone it needs is missing.
 */
export function abductArms(parts: TissuePart[], opts: AbductionOptions = ABDUCTION_DEFAULTS): AbductionResult | null {
  const t0 = performance.now()
  const log = (m: string) => opts.log?.(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${m}`)
  const bone = (name: string) => parts.find((p) => p.tissue === 'bone' && p.name === name)
  const manubrium = bone('Manubrium')
  const sat = (v: number) => (v <= opts.saturate ? 0 : v >= 1 - opts.saturate ? 1 : (v - opts.saturate) / (1 - 2 * opts.saturate))

  // ── 运动学 / kinematics ────────────────────────────────────────────────────────────────────
  const sides: SideGeom[] = []
  for (const [S, s, lat] of SIDES) {
    const clavicle = bone(`${S} clavicle`)
    const scapula = bone(`${S} scapula`)
    const humerus = bone(`${S} humerus`)
    if (!scapula || !humerus || (!opts.headCentres && (!clavicle || !manubrium))) return null
    const gh = opts.headCentres?.[s] ?? girdleLandmarks(lat, clavicle!.mesh, scapula.mesh, humerus.mesh, manubrium!.mesh).gh
    const elbow = limbJointCentres(lat, { humerus: humerus.mesh }).elbow!
    const length = Math.hypot(elbow[0] - gh[0], elbow[1] - gh[1], elbow[2] - gh[2])
    const axis: V3 = [(elbow[0] - gh[0]) / length, (elbow[1] - gh[1]) / length, (elbow[2] - gh[2]) / length]
    // 上肢骨：与肩带校正同一条规则 / the limb bones: the rule of the shoulder correction
    const given = opts.limbBoneIds ? new Set(opts.limbBoneIds[s]) : null
    const armBones = given ? parts.filter((p) => p.tissue === 'bone' && given.has(p.id)) : parts.filter((p) => p.tissue === 'bone' && new RegExp(`\\b${S.toLowerCase()}\\b`, 'i').test(p.name) && p !== clavicle && p !== scapula && lat * (lat > 0 ? p.bbox[0]! : p.bbox[3]!) > 0.12 && p.bbox[4]! > 0.55)
    if (!armBones.includes(humerus)) return null
    const pts = concat(armBones.map((p) => thinPoints(surfacePoints(p.mesh, 0.002), 0.002)))
    sides.push({ S, s, lat, gh: [gh[0], gh[1], gh[2]], elbow, axis, length, humerus, scapula, armBones, armIndex: new PointIndex(pts, 0.006), armBox: bboxOfPoints(pts) })
  }
  const armBoneSide = new Map<string, number>()
  sides.forEach((sd, i) => sd.armBones.forEach((p) => armBoneSide.set(p.id, i)))
  const fractionOf = (sd: SideGeom, x: number, y: number, z: number) => ((x - sd.gh[0]) * sd.axis[0] + (y - sd.gh[1]) * sd.axis[1] + (z - sd.gh[2]) * sd.axis[2]) / sd.length

  // 作用范围（按可能的最大角度取） / the region of action (taken for the largest angle that may be chosen)
  const maxRad = ((opts.angleDeg === 'auto' ? opts.maxAngle : Math.max(opts.maxAngle, opts.angleDeg)) * Math.PI) / 180
  const region = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const sd of sides) {
    for (const b of [sd.armBox, bboxOfPoints(rotateAboutZ(sd.armIndex.points, sd.gh, sd.lat * maxRad))]) for (let k = 0; k < 3; k++) {
      region[k] = Math.min(region[k]!, b[k]! - opts.reach)
      region[k + 3] = Math.max(region[k + 3]!, b[k + 3]! + opts.reach)
    }
  }
  // 不动的骨：其余所有骨，加上肋软骨 / the bones that stay: all others, plus the costal cartilages
  const isStaticHard = (p: TissuePart) => (p.tissue === 'bone' && !armBoneSide.has(p.id)) || (p.tissue === 'cartilage' && /costal cartilage/i.test(p.name))
  const staticParts = parts.filter((p) => isStaticHard(p) && overlaps(p.bbox, region, 0.1))
  const staticIds = new Set(staticParts.map((p) => p.id))
  const staticPts = concat(staticParts.map((p) => thinPoints(surfacePoints(p.mesh, 0.0025), 0.0025)))
  const staticIndex = new PointIndex(staticPts, 0.006)
  const staticBox = bboxOfPoints(staticPts)

  // ── 附着 / attachments ─────────────────────────────────────────────────────────────────────
  // kind：arm = 整体随某侧上肢；rest = 不动；cross = 跨关节（有权重函数）
  // kind: arm = whole with one limb; rest = stays; cross = crosses the joint (has a weight function)
  interface Attached {
    part: TissuePart
    kind: 'arm' | 'rest' | 'cross'
    side: number
    /** 跨关节部件：混合权重（0 = 随躯干侧，1 = 随上肢） / crossing parts: the blend weight (0 = with the trunk side, 1 = with the limb) */
    weight?: (pts: Float32Array) => Float32Array
    /** 跨关节部件：上肢转过 `rad` 时点的去向 / crossing parts: where points go when the limb turns by `rad` */
    map?: (pts: Float32Array, rad: number) => Float32Array
    inArm?: boolean
    armSite?: Float32Array
    restSite?: Float32Array
    rule?: string
  }
  const attached: Attached[] = []
  const unattached: TissuePart[] = []
  const NI = new Int32Array(1)
  const ND = new Float64Array(1)
  for (const p of parts) {
    if (p.tissue === 'bone' || staticIds.has(p.id) || !ATTACHED_TISSUES.has(p.tissue) || isFixedOrgan(p) || !overlaps(p.bbox, region)) continue
    if (p.tissue === 'muscle' && CUTANEOUS_MUSCLES.test(p.name)) {
      unattached.push(p)
      continue
    }
    const listed = p.tissue === 'muscle' ? GIRDLE_MUSCLE_ATTACHMENTS.find(([re]) => re.test(p.name))?.[1] : undefined
    const surface = thinPoints(surfacePoints(p.mesh, 0.002), 0.0015)
    const dist = new Float32Array(surface.length / 3)
    const siteOn = (index: PointIndex, box: number[], isListed: boolean): Float32Array | null => {
      const reach = isListed ? opts.listedAttachDistance : opts.attachDistance
      if (!overlaps(p.bbox, box, reach)) return null
      let min = Infinity
      for (let i = 0; i < surface.length; i += 3) {
        const d = index.distance(surface[i]!, surface[i + 1]!, surface[i + 2]!, reach + opts.attachDistance)
        dist[i / 3] = d
        if (d < min) min = d
      }
      const limit = isListed ? (min <= reach ? min + opts.attachDistance : -1) : opts.attachDistance
      const site: number[] = []
      for (let i = 0; i < surface.length; i += 3) if (dist[i / 3]! <= limit) site.push(surface[i]!, surface[i + 1]!, surface[i + 2]!)
      return site.length / 3 >= 6 ? Float32Array.from(site) : null
    }
    // 表中的肌：表里有 arm 才可能附着于上肢，有其他任何一类才可能附着于躯干侧；分侧的肌只认同侧上肢
    // a listed muscle may attach to the limb only if its row has `arm`, and to the trunk side only if it has any other kind; a sided muscle knows the limb of its own side only
    const own = /\bleft\b/i.test(p.name) ? 0 : /\bright\b/i.test(p.name) ? 1 : -1
    let side = -1
    let armSite: Float32Array | null = null
    if (!listed || listed.includes('arm')) {
      for (let i = 0; i < sides.length && !armSite; i++) {
        if (p.tissue === 'muscle' && own >= 0 && own !== i) continue
        armSite = siteOn(sides[i]!.armIndex, sides[i]!.armBox, !!listed)
        if (armSite) side = i
      }
    }
    const restSite = !listed || listed.some((k) => k !== 'arm') ? siteOn(staticIndex, staticBox, !!listed) : null
    if (!armSite && !restSite) {
      unattached.push(p)
      continue
    }
    if (!armSite) {
      attached.push({ part: p, kind: 'rest', side: -1 })
      continue
    }
    if (!restSite) {
      attached.push({ part: p, kind: 'arm', side })
      continue
    }
    const sd = sides[side]!
    const inArm = p.tissue === 'muscle' && BELLY_IN_ARM.test(p.name)
    const aIdx = new PointIndex(armSite, 0.006)
    const rIdx = new PointIndex(restSite, 0.006)
    // 两种跨关节部件，两种运动模型：
    //   肌腹在臂内的（三角肌、肱二头肌、肱三头肌长头、喙肱肌）：权重 w 按到上肢骨本身和到躯干端附着面的距离取（平方反比），
    //     顶点绕肱骨头中心转 w·θ——肌腹随臂整体转动；
    //   肌腹在躯干或肩胛骨上的（胸大肌、背阔肌、大圆肌、肩袖、关节囊和韧带）：把它看作起点到止点之间拉直的纤维，
    //     止点随肱骨走、起点不动，中间按到两端附着面的距离线性过渡：顶点位移 = w·(止点面上最近点的位移)，
    //     止点附近（rigidNear 以内）再带上肱骨的转动，远处只取平移——不把肱骨的转动外推到十几厘米外躯干上的肌腹
    //     （与肩带校正对肩胛骨的处理相同）。
    // Two kinds of crossing part, two motion models:
    //   belly in the arm (deltoid, biceps, long head of triceps, coracobrachialis): the weight w from the
    //     distances to the limb bones themselves and to the trunk-side site (inverse square), and the
    //     vertex turns by w·θ about the head centre — the belly turns whole with the arm;
    //   belly on the trunk or the scapula (pectoralis major, latissimus dorsi, teres major, the cuff,
    //     capsule and ligaments): taken as taut fibres from origin to insertion, the insertion going with
    //     the humerus and the origin staying, linear in between by the distances to the two sites: the
    //     vertex is displaced by w·(displacement of the nearest point of the insertion site), with the
    //     humerus' rotation added near the insertion (within rigidNear) and translation only far from
    //     it — the humerus' rotation is not extrapolated to a belly on the trunk ten centimetres away
    //     (as the shoulder correction does for the scapula).
    const NJ = new Int32Array(1)
    const weight = (pts: Float32Array): Float32Array => {
      const w = new Float32Array(pts.length / 3)
      for (let i = 0; i < pts.length; i += 3) {
        const da = inArm ? sd.armIndex.distance(pts[i]!, pts[i + 1]!, pts[i + 2]!) : (aIdx.nearest(pts[i]!, pts[i + 1]!, pts[i + 2]!, 1, NI, ND), Math.sqrt(ND[0]!))
        rIdx.nearest(pts[i]!, pts[i + 1]!, pts[i + 2]!, 1, NI, ND)
        const dr = Math.sqrt(ND[0]!)
        if (!inArm) {
          w[i / 3] = sat((dr + opts.blendOffset) / (da + dr + 2 * opts.blendOffset))
          continue
        }
        const wa = 1 / (da + opts.blendOffset) ** opts.blendPower
        const t = dr <= opts.girdleReach[0] ? 1 : dr >= opts.girdleReach[1] ? 0 : (opts.girdleReach[1] - dr) / (opts.girdleReach[1] - opts.girdleReach[0])
        const wr = (t * t * (3 - 2 * t)) / (dr + opts.blendOffset) ** opts.blendPower
        w[i / 3] = sat(wa / (wa + wr))
      }
      return w
    }
    const map = (pts: Float32Array, rad: number): Float32Array => {
      const w = weight(pts)
      const out = Float32Array.from(pts)
      const a = sd.lat * rad
      const c = sd.gh
      for (let i = 0; i < pts.length; i += 3) {
        const wi = w[i / 3]!
        if (!wi) continue
        if (inArm) {
          const cs = Math.cos(a * wi)
          const sn = Math.sin(a * wi)
          const x = pts[i]! - c[0]
          const y = pts[i + 1]! - c[1]
          out[i] = c[0] + cs * x - sn * y
          out[i + 1] = c[1] + sn * x + cs * y
          continue
        }
        aIdx.nearest(pts[i]!, pts[i + 1]!, pts[i + 2]!, 1, NJ, ND)
        const d = Math.sqrt(ND[0]!)
        const rho = d <= opts.rigidNear ? 1 : d >= opts.rigidFar ? 0 : (opts.rigidFar - d) / (opts.rigidFar - opts.rigidNear)
        const qx = armSite![3 * NJ[0]!]!
        const qy = armSite![3 * NJ[0]! + 1]!
        const px = qx + rho * (pts[i]! - qx) - c[0]
        const py = qy + rho * (pts[i + 1]! - qy) - c[1]
        const cs = Math.cos(a)
        const sn = Math.sin(a)
        out[i] = pts[i]! + wi * (cs * px - sn * py - px)
        out[i + 1] = pts[i + 1]! + wi * (sn * px + cs * py - py)
      }
      return out
    }
    attached.push({ part: p, kind: 'cross', side, weight, map, inArm, armSite, restSite, rule: inArm ? 'belly in the arm: turns by a share of the angle, by distance to the limb bones' : 'belly on the trunk: displaced by a share of the insertion\'s displacement, linear between the two sites' })
  }
  // 一个“跨关节”部件若所有顶点的权重都是 0 或都是 1，就按不动或整体随转处理
  // a "crossing" part whose vertices all have weight 0, or all 1, is treated as staying or as turning whole
  const vertexW = new Map<string, Float32Array>()
  for (const a of attached) {
    if (a.kind !== 'cross') continue
    const w = a.weight!(a.part.mesh.positions)
    let lo = Infinity
    let hi = -Infinity
    for (const v of w) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (hi === 0) a.kind = 'rest'
    else if (lo === 1 && a.inArm) a.kind = 'arm'
    else vertexW.set(a.part.id, w)
  }
  log(`attachments: ${attached.filter((a) => a.kind === 'arm').length} parts with a limb, ${attached.filter((a) => a.kind === 'cross').length} crossing, ${attached.filter((a) => a.kind === 'rest').length} at rest, ${unattached.length} unattached`)

  /** 点按各自的权重绕两侧的轴转动，满权重时转 `full` 弧度：先左臂的轴，后右臂的轴（一个点通常只有一个权重非零） / turns points by their own weights about the two limbs' axes, by `full` radians at weight 1: the left limb's axis first, then the right one's (a point normally has one non-zero weight) */
  const turnBy = (pts: Float32Array, w: Float32Array, full: number): Float32Array => {
    const out = Float32Array.from(pts)
    for (let i = 0; i < pts.length / 3; i++) {
      for (let s = 0; s < 2; s++) {
        const ws = w[2 * i + s]!
        if (!ws) continue
        const c = sides[s]!.gh
        const a = sides[s]!.lat * full * ws
        const cs = Math.cos(a)
        const sn = Math.sin(a)
        const x = out[3 * i]! - c[0]
        const y = out[3 * i + 1]! - c[1]
        out[3 * i] = c[0] + cs * x - sn * y
        out[3 * i + 1] = c[1] + sn * x + cs * y
      }
    }
    return out
  }

  // ── 取角 / choosing the angle ──────────────────────────────────────────────────────────────
  // 臂侧：随上肢整体转动的深部结构（骨、只附着于上肢骨的肌和腱，以及肌腹在臂内的跨关节肌中权重为 1 的那部分）的表面点。
  // 对侧有两种：
  //   wall  不动的深部结构（胸壁、腹壁、骨盆、大腿）；
  //   folds 肌腹在躯干或肩胛骨上的跨关节肌（胸大肌、背阔肌、大圆肌、肩袖）——它们构成腋前、后襞，
  //         在肱骨上的止点以近必然与臂相接，所以只从止点远端再往下一档起才要求间隙。
  // 每个候选角度下，folds 一侧按各自的权重转过去再量（权重与角度无关）。
  // The arm side: surface points of the deep parts that turn whole with the limb (bones, muscles and
  // tendons attached to limb bones only, and of the crossing muscles whose belly lies in the arm the
  // part with weight 1). Two opposite sides:
  //   wall   the deep parts that stay (chest wall, abdominal wall, pelvis, thigh);
  //   folds  the crossing muscles whose belly lies on the trunk or the scapula (pectoralis major,
  //          latissimus dorsi, teres major, the cuff) — they are the axillary folds and necessarily
  //          meet the arm proximal to their insertion on the humerus, so a gap is required of them
  //          only from one band below the distal end of those insertions.
  // For every candidate angle the folds are turned by their own weights before measuring (the weights do not depend on the angle).
  const deep = (p: TissuePart) => FAT_DEEP_TISSUES.has(p.tissue) && p.system !== 'integumentary'
  const inArmCross = attached.filter((a) => a.kind === 'cross' && deep(a.part) && a.inArm)
  const foldCross = attached.filter((a) => a.kind === 'cross' && deep(a.part) && !a.inArm)
  const armDeep: Float32Array[] = sides.map((_, i) => {
    const list = [...sides[i]!.armBones, ...attached.filter((a) => a.kind === 'arm' && a.side === i && deep(a.part)).map((a) => a.part)].map((p) => thinPoints(surfacePoints(p.mesh, 0.003), 0.003))
    for (const a of inArmCross) {
      if (a.side !== i) continue
      const s = thinPoints(surfacePoints(a.part.mesh, 0.003), 0.003)
      const w = a.weight!(s)
      const keep: number[] = []
      for (let k = 0; k < w.length; k++) if (w[k] === 1) keep.push(s[3 * k]!, s[3 * k + 1]!, s[3 * k + 2]!)
      list.push(Float32Array.from(keep))
    }
    return concat(list)
  })
  // 不动的深部结构：不动的骨和肋软骨、只附着于躯干侧的肌和腱、躯干的器官（随标量场走的淋巴结等不算在任何一侧）
  // the deep parts that stay: the bones and costal cartilages at rest, muscles and tendons attached on the trunk side only, the organs of the trunk (lymph nodes and whatever else follows the scalar field count on neither side)
  const restIds = new Set<string>(attached.filter((a) => a.kind === 'rest').map((a) => a.part.id))
  const trunkDeepParts = parts.filter((p) => deep(p) && overlaps(p.bbox, region) && (staticIds.has(p.id) || restIds.has(p.id) || isFixedOrgan(p)))
  const trunkChunks = trunkDeepParts.map((p) => thinPoints(surfacePoints(p.mesh, 0.0015), 0.0015))
  const trunkDeep = new PointIndex(concat(trunkChunks), 0.006)
  const trunkOwner = new Uint16Array(trunkDeep.count)
  {
    let o = 0
    trunkChunks.forEach((c, i) => {
      trunkOwner.fill(i, o, o + c.length / 3)
      o += c.length / 3
    })
  }
  const foldPts = foldCross.map((a) => thinPoints(surfacePoints(a.part.mesh, 0.0015), 0.0015))
  const BINS: [string, number, number][] = []
  for (let f = 0; f < 0.9999; f += 0.05) BINS.push([`${Math.round(f * 100)}–${Math.round(f * 100) + 5}%`, Math.round(f * 100) / 100, Math.round(f * 100) / 100 + 0.05])
  BINS.push(['forearm', 1, 1.75], ['hand', 1.75, Infinity])
  const binOf = (f: number) => BINS.findIndex(([, a, b]) => f >= a && f < b)
  const armBin = sides.map((sd, i) => {
    const a = armDeep[i]!
    const out = new Int8Array(a.length / 3)
    for (let k = 0; k < a.length; k += 3) out[k / 3] = binOf(fractionOf(sd, a[k]!, a[k + 1]!, a[k + 2]!))
    return out
  })
  // 腋襞肌在肱骨上的止点最远到哪里（两侧取较远者），向上取到档的边界；襞的间隙从再下一档起要求
  // how far down the humerus the fold muscles insert (the further of the two sides), rounded up to a band edge; the fold gap is required from one band below that
  let insertionEnd = 0
  const insertionRows: { name: string; fraction: [number, number] }[] = []
  for (const a of foldCross) {
    let lo = Infinity
    let hi = -Infinity
    for (let k = 0; k < a.armSite!.length; k += 3) {
      const f = fractionOf(sides[a.side]!, a.armSite![k]!, a.armSite![k + 1]!, a.armSite![k + 2]!)
      if (f < lo) lo = f
      if (f > hi) hi = f
    }
    insertionRows.push({ name: a.part.name, fraction: [r2(lo), r2(hi)] })
    if (hi > insertionEnd) insertionEnd = hi
  }
  const firstBin = BINS.findIndex(([, a]) => a >= opts.fromFraction - 1e-9)
  const firstFoldBin = Math.max(firstBin, BINS.findIndex(([, a]) => a >= insertionEnd - 1e-9) + opts.foldBandsBelowInsertion)
  const GAP_REACH = 0.025
  /** 每档最小间隙（毫米），整条上肢转过 `rad` 之后；[左, 右] / smallest gap per band (mm) after the limb turned by `rad`; [left, right] */
  const gapsAt = (rad: number, nearest?: string[][], nearestFold?: string[][]): { wall: number[]; folds: number[] }[] => sides.map((sd, i) => {
    const q = rotateAboutZ(armDeep[i]!, sd.gh, sd.lat * rad)
    const own = foldCross.map((f, j) => [f, j] as const).filter(([f]) => f.side === i)
    const chunks = own.map(([f, j]) => f.map!(foldPts[j]!, rad))
    const folds = new PointIndex(concat(chunks), 0.006)
    const foldOwner = new Uint16Array(folds.count)
    {
      let o = 0
      chunks.forEach((c, k) => {
        foldOwner.fill(k, o, o + c.length / 3)
        o += c.length / 3
      })
    }
    const whoFold = BINS.map(() => -1)
    const a = BINS.map(() => GAP_REACH)
    const b = BINS.map(() => GAP_REACH)
    const who = BINS.map(() => -1)
    for (let k = 0; k < q.length; k += 3) {
      const bin = armBin[i]![k / 3]!
      if (bin < 0) continue
      if (trunkDeep.nearest(q[k]!, q[k + 1]!, q[k + 2]!, 1, NI, ND, a[bin]!) && Math.sqrt(ND[0]!) < a[bin]!) {
        a[bin] = Math.sqrt(ND[0]!)
        who[bin] = trunkOwner[NI[0]!]!
      }
      if (folds.nearest(q[k]!, q[k + 1]!, q[k + 2]!, 1, NI, ND, b[bin]!) && Math.sqrt(ND[0]!) < b[bin]!) {
        b[bin] = Math.sqrt(ND[0]!)
        whoFold[bin] = foldOwner[NI[0]!]!
      }
    }
    if (nearest) nearest[i] = who.map((w) => (w < 0 ? '' : trunkDeepParts[w]!.name))
    if (nearestFold) nearestFold[i] = whoFold.map((w) => (w < 0 ? '' : own[w]![0].part.name))
    return { wall: a.map((v) => mm1(v)), folds: b.map((v) => mm1(v)) }
  })
  const worstFrom = (g: { wall: number[]; folds: number[] }[]) => Math.min(...g.map((row) => Math.min(...row.wall.slice(firstBin), ...row.folds.slice(firstFoldBin))))
  const curve: { angleDeg: number; left: { wall: number[]; folds: number[] }; right: { wall: number[]; folds: number[] }; worstRequiredMm: number }[] = []
  const evalAt = (a: number): number => {
    const done = curve.find((c) => Math.abs(c.angleDeg - a) < 1e-9)
    if (done) return done.worstRequiredMm
    const g = gapsAt((a * Math.PI) / 180)
    const worst = worstFrom(g)
    curve.push({ angleDeg: r2(a), left: g[0]!, right: g[1]!, worstRequiredMm: worst })
    return worst
  }
  // 点采样的距离最多偏大约 1 mm，取角时把这 1 mm 加在要求上
  // distances between point samples read up to about 1 mm high; that millimetre is added to the requirement when the angle is chosen
  const need = (opts.minGap + opts.samplingAllowance) * 1000
  let chosenDeg = typeof opts.angleDeg === 'number' ? opts.angleDeg : NaN
  if (typeof opts.angleDeg !== 'number') {
    // 先按整度数找到第一个满足的角，再在它与前一个整度数之间按 angleStep 细分（间隙随角度单调增大）
    // whole degrees first, up to the first that passes; then the steps of angleStep between it and the whole degree before (the gaps grow monotonically with the angle)
    for (let a = 0; a <= opts.maxAngle + 1e-9 && Number.isNaN(chosenDeg); a += 1) if (evalAt(a) >= need) chosenDeg = a
    if (!Number.isNaN(chosenDeg) && chosenDeg > 0) {
      for (let b = chosenDeg - 1 + opts.angleStep; b < chosenDeg - 1e-9; b += opts.angleStep) {
        if (evalAt(b) >= need) {
          chosenDeg = b
          break
        }
      }
    }
  } else evalAt(opts.angleDeg)
  // 钉住的角：自动判据的结果留作记录，实际用钉住的角；它必须满足同一个间隙要求
  // a pinned angle: the automatic result is kept for the record and the pinned angle is used; it must meet the same gap requirement
  const pin = typeof opts.angleDeg !== 'number' ? opts.pinned : undefined
  const automaticDeg = chosenDeg
  let gapAtPinnedMm = NaN
  if (pin) {
    gapAtPinnedMm = evalAt(pin.angleDeg)
    if (!(gapAtPinnedMm >= need)) throw new Error(`arm abduction: the pinned angle of ${pin.angleDeg}° no longer meets the gap requirement (worst required gap ${gapAtPinnedMm} mm, needed ${need} mm; the automatic criterion would choose ${Number.isNaN(automaticDeg) ? 'no angle' : `${automaticDeg}°`}). The inputs have changed: re-fit the skin package to another angle and change the pinned angle, do not lower the requirement.`)
    chosenDeg = pin.angleDeg
  }
  // 报告用的曲线：整度数，到 15° 或所取角度之上 4° / the curve for the report: whole degrees, up to 15° or 4° beyond the chosen angle
  if (!Number.isNaN(chosenDeg)) for (let a = 0; a <= Math.max(15, Math.ceil(chosenDeg) + 4) + 1e-9; a += 1) evalAt(a)
  curve.sort((x, y) => x.angleDeg - y.angleDeg)
  // 各角度下，腋襞肌从哪一档起离臂够远（该档及其以远各档都 ≥ minGap） / per angle, the band from which the fold muscles are clear of the arm (that band and every band distal to it ≥ minGap)
  const clearFrom = (row: { folds: number[] }): string => {
    let k = BINS.length
    while (k > 0 && row.folds[k - 1]! >= opts.minGap * 1000) k--
    return k < BINS.length ? BINS[k]![0] : '-'
  }
  const foldsClearFrom = curve.map((c) => ({ angleDeg: c.angleDeg, left: clearFrom(c.left), right: clearFrom(c.right) }))
  const requirement = { minGapMm: opts.minGap * 1000, wallFromBand: BINS[firstBin]![0], foldsFromBand: BINS[firstFoldBin]![0], foldInsertionsEndAtFraction: r2(insertionEnd), foldInsertions: insertionRows }
  if (Number.isNaN(chosenDeg)) return { moved: new Map(), report: { applied: false, reason: `no angle up to ${opts.maxAngle}° opens a gap of ${opts.minGap * 1000} mm`, requirement, gapCurve: { bands: BINS.map(([n]) => n), curve } } }
  const theta = (chosenDeg * Math.PI) / 180
  const limitedBy: string[][] = [[], []]
  const foldLimitedBy: string[][] = [[], []]
  gapsAt(theta, limitedBy, foldLimitedBy)
  log(`angle ${chosenDeg}° (${pin ? `pinned; the automatic criterion would choose ${automaticDeg}°` : opts.angleDeg === 'auto' ? 'smallest that meets the gap requirement' : 'given'})`)

  // ── 映射 / the map ─────────────────────────────────────────────────────────────────────────
  const turn = (pts: Float32Array, w: Float32Array): Float32Array => turnBy(pts, w, theta)
  const whole = (pts: ArrayLike<number>, side: number) => rotateAboutZ(pts, sides[side]!.gh, sides[side]!.lat * theta)
  const twoSided = (w: Float32Array, side: number): Float32Array => {
    const out = new Float32Array(2 * w.length)
    for (let i = 0; i < w.length; i++) out[2 * i + side] = w[i]!
    return out
  }
  const mapsOf = new Map<string, (pts: Float32Array) => Float32Array>()
  const moved = new Map<string, CarriedPart>()
  for (const [id, side] of armBoneSide) {
    const p = parts.find((x) => x.id === id)!
    moved.set(id, { mesh: { positions: whole(p.mesh.positions, side), indices: p.mesh.indices }, motion: 'rigid', via: 'bone', group: `arm_${sides[side]!.s}` })
  }
  for (const a of attached) {
    const p = a.part
    if (a.kind === 'arm') moved.set(p.id, { mesh: { positions: whole(p.mesh.positions, a.side), indices: p.mesh.indices }, motion: 'rigid', via: 'attachment', group: `arm_${sides[a.side]!.s}` })
    else if (a.kind === 'cross') {
      const f = (pts: Float32Array) => a.map!(pts, theta)
      mapsOf.set(p.id, f)
      moved.set(p.id, { mesh: { positions: f(p.mesh.positions), indices: p.mesh.indices }, motion: 'deformed', via: 'attachment' })
    }
  }

  // ── 标量场 / the scalar field ──────────────────────────────────────────────────────────────
  // 锚点 = 骨和附着部件的表面采样点，各带自己的权重。GapField 插值的是位移向量：这里把两侧的权重放进
  // 位移的 x、y 分量里借它来插值（z 不用），取回后再做归零/归一。
  // Anchors = surface samples of the bones and of the attached parts, each with its weight. GapField
  // interpolates displacement vectors: the two limbs' weights are carried in the x and y components
  // of that "displacement" (z unused), and saturated again when read back.
  /**
   * 一个点的位移相当于绕该侧肱骨头中心转了满角度的几分之几（0…1）：位移的切向分量 ÷ 到轴的距离 ÷ θ。
   * 肌腹在躯干上的跨关节肌是按位移而不是按转角混合的，给标量场当锚点时用这个等效份额。
   * The share (0…1) of the full angle that a point's displacement amounts to about that side's head
   * centre: tangential component of the displacement ÷ distance from the axis ÷ θ. Crossing muscles
   * with their belly on the trunk are blended by displacement, not by angle; as anchors of the scalar
   * field they carry this equivalent share.
   */
  const angleShare = (src: Float32Array, dst: Float32Array, side: number): Float32Array => {
    const c = sides[side]!.gh
    const full = sides[side]!.lat * theta
    const w = new Float32Array(src.length / 3)
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i]! - c[0]
      const y = src[i + 1]! - c[1]
      const r2 = x * x + y * y
      if (r2 < 1e-8 || !full) continue
      const al = (x * (dst[i + 1]! - src[i + 1]!) - y * (dst[i]! - src[i]!)) / r2
      w[i / 3] = Math.max(0, Math.min(1, al / full))
    }
    return w
  }
  const from: Float32Array[] = []
  const wts: Float32Array[] = []
  const anchorIds = new Set<string>()
  const constant = (n: number, side: number): Float32Array => {
    const w = new Float32Array(2 * n)
    if (side >= 0) for (let i = 0; i < n; i++) w[2 * i + side] = 1
    return w
  }
  for (const p of parts) {
    if (p.tissue !== 'bone' && !staticIds.has(p.id)) continue
    if (!overlaps(p.bbox, region, 0.1)) continue
    const a = thinPoints(surfacePoints(p.mesh, 0.004), 0.004)
    from.push(a)
    wts.push(constant(a.length / 3, armBoneSide.get(p.id) ?? -1))
    anchorIds.add(p.id)
  }
  for (const a of attached) {
    const pts = thinPoints(surfacePoints(a.part.mesh, 0.004), 0.004)
    from.push(pts)
    wts.push(a.kind === 'cross' ? twoSided(a.inArm ? a.weight!(pts) : angleShare(pts, a.map!(pts, theta), a.side), a.side) : constant(pts.length / 3, a.kind === 'arm' ? a.side : -1))
    anchorIds.add(a.part.id)
  }
  // 场的作用范围：权重非零的锚点的包围盒再向外 maxRadius；边界上的点因此离任何转动的锚点都不近于查询半径
  // the field's reach: the bbox of the anchors with a non-zero weight plus maxRadius; a point on its boundary is thus no nearer than the query radius to any anchor that turns
  const fregion = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  from.forEach((f, j) => {
    const w = wts[j]!
    for (let i = 0; i < f.length / 3; i++) {
      if (!w[2 * i] && !w[2 * i + 1]) continue
      for (let k = 0; k < 3; k++) {
        if (f[3 * i + k]! - opts.field.maxRadius < fregion[k]!) fregion[k] = f[3 * i + k]! - opts.field.maxRadius
        if (f[3 * i + k]! + opts.field.maxRadius > fregion[k + 3]!) fregion[k + 3] = f[3 * i + k]! + opts.field.maxRadius
      }
    }
  })
  // 不动的锚点：范围内的躯干器官 / anchors at rest: trunk organs within reach
  const unattachedIds = new Set(unattached.map((p) => p.id))
  const fieldParts: TissuePart[] = []
  for (const p of parts) {
    if (anchorIds.has(p.id) || p.tissue === 'bone' || !overlaps(p.bbox, fregion, 0.06)) continue
    if (isFixedOrgan(p) || (ATTACHED_TISSUES.has(p.tissue) && !unattachedIds.has(p.id))) {
      const pts = thinPoints(surfacePoints(p.mesh, 0.006), 0.006)
      from.push(pts)
      wts.push(constant(pts.length / 3, -1))
    } else if (overlaps(p.bbox, fregion)) fieldParts.push(p)
  }
  const anchorsFrom = concat(from)
  const anchorsW = concat(wts)
  const anchorsTo = Float32Array.from(anchorsFrom)
  for (let i = 0; i < anchorsFrom.length / 3; i++) {
    anchorsTo[3 * i] = anchorsFrom[3 * i]! + anchorsW[2 * i]!
    anchorsTo[3 * i + 1] = anchorsFrom[3 * i + 1]! + anchorsW[2 * i + 1]!
  }
  // 腋窝以远，上肢与躯干是两个分开的节段：沿肱骨轴在肱骨头中心以远 armSeparation[0]…[1] 之间把幂逐渐提高，
  // 使那里的组织只随离它最近的结构走（同 shoulderTissue.ts）。
  // Distal to the axilla the limb and the trunk are separate segments: along the humeral axis, between
  // armSeparation[0] and [1] beyond the head centre, the power is raised so that tissue follows only
  // what is nearest to it (as in shoulderTissue.ts).
  const sharpen = (x: number, y: number, zc: number): number => {
    let k = 0
    for (const sd of sides) {
      const px = x - sd.gh[0]
      const py = y - sd.gh[1]
      const pz = zc - sd.gh[2]
      const sAx = px * sd.axis[0] + py * sd.axis[1] + pz * sd.axis[2]
      if (sAx <= opts.armSeparation[0]) continue
      const rho = Math.hypot(px - sAx * sd.axis[0], py - sAx * sd.axis[1], pz - sAx * sd.axis[2])
      if (rho > 0.2) continue
      const t = Math.min(1, (sAx - opts.armSeparation[0]) / (opts.armSeparation[1] - opts.armSeparation[0]))
      k = Math.max(k, t * t * (3 - 2 * t) * Math.min(1, (0.2 - rho) / 0.05))
    }
    return k
  }
  const gap = new GapField(anchorsFrom, anchorsTo, opts.field, sharpen)
  const inRegion = (x: number, y: number, zc: number) => x >= fregion[0]! && x <= fregion[3]! && y >= fregion[1]! && y <= fregion[4]! && zc >= fregion[2]! && zc <= fregion[5]!
  const fieldW: Weights = (pts) => {
    const w = new Float32Array((pts.length / 3) * 2)
    for (let i = 0; i < pts.length; i += 3) {
      if (!inRegion(pts[i]!, pts[i + 1]!, pts[i + 2]!)) continue
      const d = gap.displacementAt(pts[i]!, pts[i + 1]!, pts[i + 2]!)
      w[(i / 3) * 2] = sat(d[0])
      w[(i / 3) * 2 + 1] = sat(d[1])
    }
    return w
  }
  const fieldMap = (pts: Float32Array) => turn(pts, fieldW(pts))
  // 场在作用范围边界上应当为零 / the field must vanish on the boundary of its reach
  let boundaryMax = 0
  for (let i = 0; i < anchorsFrom.length; i += 3) {
    const x = anchorsFrom[i]!
    const y = anchorsFrom[i + 1]!
    const zc = anchorsFrom[i + 2]!
    if (!inRegion(x, y, zc)) continue
    const edge = Math.min(x - fregion[0]!, fregion[3]! - x, y - fregion[1]!, fregion[4]! - y, zc - fregion[2]!, fregion[5]! - zc)
    if (edge > 0.01) continue
    const d = gap.displacementAt(x, y, zc)
    boundaryMax = Math.max(boundaryMax, sat(d[0]), sat(d[1]))
  }

  // 细薄结构：权重在本部件 thinRadius 以内取平均（横截面整体转动）；淋巴结：每个结节取平均（整体转动）
  // thin structures: the weight is averaged over the part's own vertices within thinRadius (a cross-section turns as one); lymph nodes: averaged per node (each turns whole)
  const isNodes = (p: TissuePart) => p.system === 'lymphatic' && /\bnodes?\b/i.test(p.name)
  const isThin = (p: TissuePart) => p.tissue === 'artery' || p.tissue === 'vein' || p.tissue === 'fascia' || p.tissue === 'nerve' || p.tissue === 'muscle' || p.tissue === 'ligament' || p.tissue === 'tendon'
  const thinIds = new Set<string>()
  const carriedW = (p: TissuePart): Float32Array => {
    const src = p.mesh.positions
    const w = fieldW(src)
    const nv = src.length / 3
    if (isNodes(p)) {
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
      const sum = new Float64Array(3 * nv)
      for (let i = 0; i < nv; i++) {
        const r = find(i)
        sum[3 * r] = sum[3 * r]! + w[2 * i]!
        sum[3 * r + 1] = sum[3 * r + 1]! + w[2 * i + 1]!
        sum[3 * r + 2] = sum[3 * r + 2]! + 1
      }
      for (let i = 0; i < nv; i++) {
        const r = find(i)
        w[2 * i] = sum[3 * r]! / sum[3 * r + 2]!
        w[2 * i + 1] = sum[3 * r + 1]! / sum[3 * r + 2]!
      }
      thinIds.add(p.id)
      return w
    }
    if (!isThin(p)) return w
    const keep = voxelSubsample(src, 0.0015)
    const kp = new Float32Array(keep.length * 3)
    let kw = new Float32Array(keep.length * 2)
    keep.forEach((i, j) => {
      for (let k = 0; k < 3; k++) kp[3 * j + k] = src[3 * i + k]!
      kw[2 * j] = w[2 * i]!
      kw[2 * j + 1] = w[2 * i + 1]!
    })
    const index = new PointIndex(kp, opts.thinRadius)
    const K = 96
    const I = new Int32Array(K)
    const D = new Float64Array(K)
    const gather = (x: number, y: number, zc: number, u: Float32Array, o: Float32Array, at: number) => {
      const n = index.nearest(x, y, zc, K, I, D, opts.thinRadius)
      let a = 0
      let b = 0
      for (let j = 0; j < n; j++) {
        a += u[2 * I[j]!]!
        b += u[2 * I[j]! + 1]!
      }
      o[at] = n ? a / n : 0
      o[at + 1] = n ? b / n : 0
    }
    for (let pass = 1; pass < opts.thinPasses; pass++) {
      const next = new Float32Array(kw.length)
      for (let j = 0; j < keep.length; j++) gather(kp[3 * j]!, kp[3 * j + 1]!, kp[3 * j + 2]!, kw, next, 2 * j)
      kw = next
    }
    const sm = new Float32Array(2 * nv)
    for (let i = 0; i < nv; i++) gather(src[3 * i]!, src[3 * i + 1]!, src[3 * i + 2]!, kw, sm, 2 * i)
    thinIds.add(p.id)
    return sm
  }
  /** 权重全为 0 → 不动；某一侧全为 1 → 整体随该侧上肢；否则形变 / all weights 0 → stays; all 1 on one side → whole with that limb; otherwise deformed */
  const classify = (w: Float32Array): { motion: 'none' | 'rigid' | 'deformed'; side: number } => {
    const lo = [Infinity, Infinity]
    const hi = [0, 0]
    for (let i = 0; i < w.length; i += 2) for (let s = 0; s < 2; s++) {
      if (w[i + s]! < lo[s]!) lo[s] = w[i + s]!
      if (w[i + s]! > hi[s]!) hi[s] = w[i + s]!
    }
    if (hi[0] === 0 && hi[1] === 0) return { motion: 'none', side: -1 }
    for (let s = 0; s < 2; s++) if (lo[s] === 1 && hi[1 - s] === 0) return { motion: 'rigid', side: s }
    return { motion: 'deformed', side: -1 }
  }
  // 随上肢走的结构：腋窝下缘（腋襞肌在肱骨上的止点远端）以远，正中神经、尺神经走在肱二头肌内侧沟里，贴着肱动脉；
  // 前臂内侧皮神经伴着贵要静脉。它们属于上肢，而不属于贴在臂旁的背阔肌。标量场在臂与背阔肌之间取了中间值，
  // 使它们在肱骨中段落后于臂几毫米。所以：一个不附着在骨上的部件（皮肤除外），如果它在肱骨长度 60–100% 之间、
  // 离上肢骨 7 cm 以内有顶点，并且这些顶点的权重全是 1（即它确实延续到臂的远段并随臂走），就认定它随该侧上肢走；
  // 它在腋窝下缘以远、离上肢骨 7 cm 以内的顶点权重取 1，过渡只留在腋窝之内（止点远端上下各 5% 的范围里从场值升到 1）。
  // Structures that travel with the limb: distal to the lower border of the axilla (the distal end of
  // the fold muscles' insertions on the humerus) the median and ulnar nerves run in the medial bicipital
  // groove beside the brachial artery, and the medial antebrachial cutaneous nerve beside the basilic
  // vein. They belong to the limb, not to the latissimus dorsi lying against the arm. The scalar field
  // takes an intermediate value between arm and latissimus and left them some millimetres behind the
  // arm at mid-humerus. So: a part not attached to bone (the skin excepted) that has vertices between
  // 60% and 100% of the humerus within 7 cm of a limb bone, all of them with weight 1 (it does continue
  // into the distal arm and goes with it), is taken to travel with that limb; its vertices distal to
  // the lower border of the axilla and within 7 cm of a limb bone get weight 1, and the blend is kept
  // inside the axilla (rising from the field's value to 1 over 5% of the humerus either side of the
  // distal end of the insertions).
  const TRAVEL_REACH = 0.07
  const travelFrom = insertionEnd - 0.05
  const travelFull = insertionEnd + 0.05
  const travellers: { id: string; name: string; side: string; verticesRaised: number; largestRise: number }[] = []
  const withLimb = (p: TissuePart, pts: Float32Array, w: Float32Array, record: boolean): Float32Array => {
    // 皮肤是一整张，淋巴结逐个整体转动：都不在此列 / the skin is one sheet and lymph nodes turn one by one: neither is touched here
    if (p.tissue === 'skin' || isNodes(p)) return w
    for (let sIdx = 0; sIdx < sides.length; sIdx++) {
      const sd = sides[sIdx]!
      let distal = 0
      let all = true
      const f = new Float32Array(pts.length / 3)
      const near = new Uint8Array(pts.length / 3)
      for (let i = 0; i < pts.length; i += 3) {
        const fr = fractionOf(sd, pts[i]!, pts[i + 1]!, pts[i + 2]!)
        f[i / 3] = fr
        if (fr < travelFrom) continue
        if (sd.armIndex.distance(pts[i]!, pts[i + 1]!, pts[i + 2]!, TRAVEL_REACH) > TRAVEL_REACH) continue
        near[i / 3] = 1
        if (fr >= 0.6 && fr <= 1) {
          distal++
          if (w[(i / 3) * 2 + sIdx]! < 1) all = false
        }
      }
      if (distal < 3 || !all) continue
      let raised = 0
      let rise = 0
      for (let i = 0; i < f.length; i++) {
        if (!near[i]) continue
        const t = Math.min(1, (f[i]! - travelFrom) / (travelFull - travelFrom))
        const r = t * t * (3 - 2 * t)
        const w0 = w[2 * i + sIdx]!
        const w1 = w0 + r * (1 - w0)
        if (w1 > w0) {
          raised++
          if (t >= 1 && 1 - w0 > rise) rise = 1 - w0
        }
        w[2 * i + sIdx] = w1
        w[2 * i + 1 - sIdx] = w[2 * i + 1 - sIdx]! * (1 - r)
      }
      if (record && raised) travellers.push({ id: p.id, name: p.name, side: sd.s, verticesRaised: raised, largestRise: r4(rise) })
    }
    return w
  }
  const nerveW = new Map<string, Weights>()
  const nerves: TissuePart[] = []
  for (const p of fieldParts) {
    if (p.centrelines && p.centrelines.length) {
      const all = concat(p.centrelines.map((l) => l.points))
      const c = classify(withLimb(p, all, fieldW(all), true))
      if (c.motion === 'none') continue
      if (c.motion === 'deformed') {
        nerves.push(p)
        nerveW.set(p.id, (pts) => withLimb(p, pts, fieldW(pts), false))
      }
      else moved.set(p.id, { mesh: { positions: whole(p.mesh.positions, c.side), indices: p.mesh.indices }, centrelines: p.centrelines.map((l) => ({ points: whole(l.points, c.side), radius: l.radius })), motion: 'rigid', via: 'field', group: `arm_${sides[c.side]!.s}` })
      continue
    }
    const w = withLimb(p, p.mesh.positions, carriedW(p), true)
    const c = classify(w)
    if (c.motion === 'none') {
      thinIds.delete(p.id)
      continue
    }
    if (c.motion === 'rigid') {
      thinIds.delete(p.id)
      moved.set(p.id, { mesh: { positions: whole(p.mesh.positions, c.side), indices: p.mesh.indices }, motion: 'rigid', via: 'field', group: `arm_${sides[c.side]!.s}` })
    } else moved.set(p.id, { mesh: { positions: turn(p.mesh.positions, w), indices: p.mesh.indices }, motion: 'deformed', via: 'field' })
  }
  // 形变的血管、筋膜等（非神经）：腋窝下缘以远、离上肢骨 5 cm 以内的顶点离“随上肢整体转动”的位置最多差多少
  // deformed vessels, fasciae and the like (not nerves): how far, at most, their vertices below the axilla and within 5 cm of a limb bone end up from where the rigid turn of the limb puts them
  const lagRows: { id: string; name: string; tissue: string; verticesBelowAxilla: number; largestLagBelowAxillaMm: number }[] = []
  for (const p of fieldParts) {
    const m = moved.get(p.id)
    if (!m || m.motion !== 'deformed' || m.via !== 'field' || p.tissue === 'skin') continue
    const v = p.mesh.positions
    let lag = 0
    let n = 0
    for (let i = 0; i < v.length; i += 3) {
      const side = sides.findIndex((sd) => fractionOf(sd, v[i]!, v[i + 1]!, v[i + 2]!) >= travelFull && sd.armIndex.distance(v[i]!, v[i + 1]!, v[i + 2]!, 0.05) <= 0.05)
      if (side < 0) continue
      const q = whole(v.subarray(i, i + 3), side)
      lag = Math.max(lag, Math.hypot(m.mesh.positions[i]! - q[0]!, m.mesh.positions[i + 1]! - q[1]!, m.mesh.positions[i + 2]! - q[2]!))
      n++
    }
    if (n) lagRows.push({ id: p.id, name: p.name, tissue: p.tissue, verticesBelowAxilla: n, largestLagBelowAxillaMm: r4(lag * 1000) })
  }
  lagRows.sort((a, b) => b.largestLagBelowAxillaMm - a.largestLagBelowAxillaMm || (a.id < b.id ? -1 : 1))
  log(`field applied to ${fieldParts.length} parts (${gap.anchors} anchors)`)

  // ── 神经 / nerves ──────────────────────────────────────────────────────────────────────────
  const posedMesh = (p: TissuePart) => moved.get(p.id)?.mesh ?? p.mesh
  const solids = parts.filter((p) => (p.tissue === 'bone' || p.tissue === 'cartilage' || p.tissue === 'muscle') && (overlaps(p.bbox, region) || overlaps(p.bbox, fregion)))
  const existing = (mesh: (p: TissuePart) => Mesh): ExistingPart[] => solids.map((p) => ({ id: p.id, fma: p.fma, name: p.name, mesh: mesh(p), stats: measure(mesh(p)), system: p.system, tissue: p.tissue }))
  const restField = new SurfaceField(existing((p) => p.mesh))
  const posedField = new SurfaceField(existing(posedMesh))
  const asDeformation = { anchors: gap.anchors, apply: fieldMap, displacementAt: (x: number, y: number, z: number): [number, number, number] => {
    const q = fieldMap(Float32Array.of(x, y, z))
    return [q[0]! - x, q[1]! - y, q[2]! - z]
  } }
  const nerveRows: Record<string, unknown>[] = []
  let nLen = 0
  let boneRest = 0
  let boneField = 0
  let bonePosed = 0
  let muscleRest = 0
  let musclePosed = 0
  for (const p of nerves) {
    const canal = canalFor(p.name)
    const rest = pathStats(p.centrelines!, restField, canal)
    // 随上肢走的神经：是否“随上肢走”按整条神经判定，然后逐点取权重
    // a nerve that travels with the limb: whether it does is decided on the whole nerve, the weights are then taken point by point
    const whole0 = concat(p.centrelines!.map((l) => l.points))
    const wAll = nerveW.get(p.id)!(whole0)
    let off = 0
    const through = p.centrelines!.map((l) => {
      const n = l.points.length / 3
      const q = { points: turn(l.points, wAll.subarray(2 * off, 2 * (off + n))), radius: l.radius }
      off += n
      return q
    })
    const afterField = pathStats(through, posedField, canal)
    let pushed = 0
    const branches = through.map((l, bi) => {
      if (l.points.length < 6 || pathStats([l], posedField, canal).inBone <= 0) return l
      // 加密后的点没有整条神经的上下文，这里按场值走（只有进了骨的分支才到这一步） / the densified points have no whole-nerve context and go by the field here (only a branch that ended up in bone gets this far)
      const w = warpNerveLines([p.centrelines![bi]!], asDeformation, posedField, { ...NERVE_BUILD_DEFAULTS, maxMusclePush: 0, canal })
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
    // 腋窝下缘以远（沿肱骨轴 ≥ 止点远端 + 5%）、离上肢骨 5 cm 以内的中心线点应当随上肢整体转动：量它们离“整体转动后的位置”最多差多少
    // centreline points below the axilla (along the humeral axis ≥ the distal end of the insertions + 5%) and within 5 cm of a limb bone should turn whole with the limb: how far, at most, they end up from where the rigid turn puts them
    let offLimb = 0
    let distal = 0
    p.centrelines!.forEach((l, bi) => {
      const b = branches[bi]
      if (!b || b.points.length !== l.points.length) return
      for (let i = 0; i < l.points.length; i += 3) {
        const side = sides.findIndex((sd) => {
          const f = fractionOf(sd, l.points[i]!, l.points[i + 1]!, l.points[i + 2]!)
          return f >= travelFull && sd.armIndex.distance(l.points[i]!, l.points[i + 1]!, l.points[i + 2]!, 0.05) <= 0.05
        })
        if (side < 0) continue
        const q = whole(l.points.subarray(i, i + 3), side)
        offLimb = Math.max(offLimb, Math.hypot(b.points[i]! - q[0]!, b.points[i + 1]! - q[1]!, b.points[i + 2]! - q[2]!))
        distal++
      }
    })
    nerveRows.push({ id: p.id, name: p.name, pointsBelowAxilla: distal, largestLagBelowAxillaMm: r4(offLimb * 1000), lengthMm: mm1(rest.length), lengthAfterMm: mm1(after.length), inBone: [r4(rest.inBone), r4(afterField.inBone), r4(after.inBone)], deepInMuscle: [r4(rest.deepInMuscle), r4(after.deepInMuscle)], pointsPushed: pushed })
  }
  log(`${nerveRows.length} nerves rebuilt`)

  // ── 检查 / checks ──────────────────────────────────────────────────────────────────────────
  // 臂–躯干间隙（最终几何，到三角形的精确距离）：wall、folds 两列的含义同取角一节。
  // Arm–trunk gap (final geometry, exact distances to the triangles): the columns wall and folds as in the section on choosing the angle.
  const wallSurface = new SurfaceDistance(mergeMeshes(trunkDeepParts.map((p) => p.mesh)))
  const gapTable = (posed: boolean) => sides.map((_, i) => {
    const folds = new SurfaceDistance(mergeMeshes(foldCross.filter((a) => a.side === i).map((a) => (posed ? posedMesh(a.part) : a.part.mesh))))
    const q = posed ? whole(armDeep[i]!, i) : armDeep[i]!
    const a = BINS.map(() => GAP_REACH)
    const b = BINS.map(() => GAP_REACH)
    for (let k = 0; k < q.length; k += 3) {
      const bin = armBin[i]![k / 3]!
      if (bin < 0) continue
      const dw = wallSurface.distance(q[k]!, q[k + 1]!, q[k + 2]!, a[bin]!)
      if (dw < a[bin]!) a[bin] = dw
      const df = folds.distance(q[k]!, q[k + 1]!, q[k + 2]!, b[bin]!)
      if (df < b[bin]!) b[bin] = df
    }
    return { wall: a.map(mm1), folds: b.map(mm1) }
  })
  const gapBefore = gapTable(false)
  const gapAfter = gapTable(true)
  log('gap tables')

  // 盂肱关节间隙 / glenohumeral joint gap
  const contact = (a: Mesh, b: Mesh) => {
    const c = contactZone(surfacePoints(a, 0.001), new PointIndex(surfacePoints(b, 0.001), 0.004))
    return { minMm: r2(c.min * 1000), medianMm: r2(c.median * 1000), points: c.points.length / 3 }
  }
  const sidesReport: Record<string, unknown> = {}
  const transforms: Record<string, unknown> = {}
  // 跨关节肌：体积、起止点间距、附着端离骨的最近距离，外展前后 / crossing muscles: volume, origin–insertion distance and closest approach of each end to its bone, before and after
  const posedArmIndex = sides.map((sd, i) => new PointIndex(whole(sd.armIndex.points, i), 0.006))
  const centroid = (p: Float32Array): V3 => {
    const c: V3 = [0, 0, 0]
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) c[k] = c[k]! + p[i + k]! / (p.length / 3)
    return c
  }
  const crossRows: Record<string, unknown>[] = []
  let attachChecked = 0
  let attachLost = 0
  let attachWorst = { id: '', name: '', end: '', mm: 0 }
  for (const a of attached) {
    if (a.kind !== 'cross') continue
    const p = a.part
    const f = mapsOf.get(p.id)!
    const v0 = p.mesh.positions
    const v1 = moved.get(p.id)!.mesh.positions
    const vol0 = Math.abs(measure(p.mesh).signedVolume)
    const vol1 = Math.abs(measure(moved.get(p.id)!.mesh).signedVolume)
    const o0 = centroid(a.restSite!)
    const i0 = centroid(a.armSite!)
    const o1 = centroid(f(a.restSite!))
    const i1 = centroid(f(a.armSite!))
    const len = (x: V3, y: V3) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
    const closest = (v: Float32Array, index: PointIndex) => {
      let min = Infinity
      for (let i = 0; i < v.length; i += 3) {
        const d = index.distance(v[i]!, v[i + 1]!, v[i + 2]!, 0.05)
        if (d < min) min = d
      }
      return min
    }
    const ends = { arm: [closest(v0, sides[a.side]!.armIndex), closest(v1, posedArmIndex[a.side]!)], trunk: [closest(v0, staticIndex), closest(v1, staticIndex)] }
    for (const [end, [d0, d1]] of Object.entries(ends) as [string, number[]][]) {
      attachChecked++
      if (d1! > d0! + 0.001) attachLost++
      if ((d1! - d0!) * 1000 > attachWorst.mm) attachWorst = { id: p.id, name: p.name, end, mm: r2((d1! - d0!) * 1000) }
    }
    const w = vertexW.get(p.id)!
    let full = 0
    let none = 0
    for (const x of w) {
      if (x === 1) full++
      else if (x === 0) none++
    }
    crossRows.push({
      id: p.id, name: p.name, tissue: p.tissue, side: sides[a.side]!.s, rule: a.rule,
      volumeMl: [r2(vol0 * 1e6), r2(vol1 * 1e6)], volumeChange: vol0 > 1e-9 ? r4(vol1 / vol0 - 1) : 0,
      originInsertionMm: [mm1(len(o0, i0)), mm1(len(o1, i1))], lengthChange: r4(len(o1, i1) / Math.max(1e-9, len(o0, i0)) - 1),
      closestToLimbBoneMm: ends.arm.map((d) => r2(d * 1000)), closestToTrunkBoneMm: ends.trunk.map((d) => r2(d * 1000)),
      verticesWithLimb: r4(full / w.length), verticesAtRest: r4(none / w.length),
    })
  }
  crossRows.sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : 1))

  // 骨内比例、折叠 / share inside bone, folding
  const hard = parts.filter((p) => (p.tissue === 'bone' || (p.tissue === 'cartilage' && staticIds.has(p.id))) && (overlaps(p.bbox, region) || overlaps(p.bbox, fregion)))
  const testers = (posed: boolean) => hard.map((p) => {
    const m = posed ? posedMesh(p) : p.mesh
    return { bbox: bboxOfPoints(m.positions), t: new InsideTester(m) }
  })
  const hardRest = testers(false)
  const hardPosed = testers(true)
  const insideAny = (pts: Float32Array, list: { bbox: readonly number[]; t: InsideTester }[]) => {
    let n = 0
    for (let i = 0; i < pts.length; i += 3) {
      for (const s of list) {
        if (pts[i]! < s.bbox[0]! || pts[i]! > s.bbox[3]! || pts[i + 1]! < s.bbox[1]! || pts[i + 1]! > s.bbox[4]! || pts[i + 2]! < s.bbox[2]! || pts[i + 2]! > s.bbox[5]!) continue
        if (s.t.contains(pts[i]!, pts[i + 1]!, pts[i + 2]!)) {
          n++
          break
        }
      }
    }
    return n
  }
  const detsOf = (f: (pts: Float32Array) => Float32Array, v: Float32Array, stride: number): number[] => {
    const h = 0.001
    const q: number[] = []
    for (let i = 0; i < v.length; i += 3 * stride) for (const [dx, dy, dz] of [[h, 0, 0], [-h, 0, 0], [0, h, 0], [0, -h, 0], [0, 0, h], [0, 0, -h]] as const) q.push(v[i]! + dx, v[i + 1]! + dy, v[i + 2]! + dz)
    const o = f(Float32Array.from(q))
    const out: number[] = []
    for (let i = 0; i < o.length; i += 18) {
      const c = (k: number, a: number) => (o[i + 6 * k + a]! - o[i + 6 * k + 3 + a]!) / (2 * h)
      const F = [c(0, 0), c(1, 0), c(2, 0), c(0, 1), c(1, 1), c(2, 1), c(0, 2), c(1, 2), c(2, 2)]
      out.push(F[0]! * (F[4]! * F[8]! - F[5]! * F[7]!) - F[1]! * (F[3]! * F[8]! - F[5]! * F[6]!) + F[2]! * (F[3]! * F[7]! - F[4]! * F[6]!))
    }
    return out
  }
  const triNormal = (q: Float32Array, a: number, b: number, c: number): V3 => {
    const ux = q[3 * b]! - q[3 * a]!
    const uy = q[3 * b + 1]! - q[3 * a + 1]!
    const uz = q[3 * b + 2]! - q[3 * a + 2]!
    const vx = q[3 * c]! - q[3 * a]!
    const vy = q[3 * c + 1]! - q[3 * a + 1]!
    const vz = q[3 * c + 2]! - q[3 * a + 2]!
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
  }
  let in0 = 0
  let in1 = 0
  let inN = 0
  const insideRows: { id: string; name: string; before: number; after: number; samples: number }[] = []
  const mapDets: number[] = []
  const foldRows: { id: string; name: string; via: string; samples: number; nonPositive: number; min: number }[] = []
  let thinTriangles = 0
  let thinFlipped = 0
  const thinRows: { id: string; name: string; triangles: number; reversed: number }[] = []
  const counts = { rigid: 0, deformed: 0 }
  const byVia: Record<string, number> = {}
  const byTissue: Record<string, { rigid: number; deformed: number }> = {}
  const deformedIds: string[] = []
  for (const p of parts) {
    const m = moved.get(p.id)
    if (!m) continue
    counts[m.motion]++
    byVia[`${m.via}/${m.motion}`] = (byVia[`${m.via}/${m.motion}`] ?? 0) + 1
    const t = (byTissue[p.tissue] ??= { rigid: 0, deformed: 0 })
    t[m.motion]++
    if (m.motion !== 'deformed') continue
    deformedIds.push(p.id)
    if (thinIds.has(p.id)) {
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
    } else if (m.via !== 'nerve') {
      const nv = p.mesh.positions.length / 3
      const d = detsOf(mapsOf.get(p.id) ?? fieldMap, p.mesh.positions, Math.max(1, Math.floor(nv / 300)))
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
    insideRows.push({ id: p.id, name: p.name, before: r4(a / Math.max(1, s0.length / 3)), after: r4(b / Math.max(1, s1.length / 3)), samples: s0.length / 3 })
  }
  mapDets.sort((a, b) => a - b)
  foldRows.sort((a, b) => b.nonPositive - a.nonPositive || (a.id < b.id ? -1 : 1))
  insideRows.sort((a, b) => b.after - b.before - (a.after - a.before) || (a.id < b.id ? -1 : 1))
  log('attachment, inside-bone and folding checks')

  // 场映射的雅可比行列式：在锚点附近的网格上取样 / Jacobian determinant of the field map, sampled on a grid near the anchors
  const anchorIndex = new PointIndex(anchorsFrom, 0.02)
  const dets: number[] = []
  const foldLevels: Record<string, number> = {}
  {
    const step = 0.01
    const q: number[] = []
    for (let x = fregion[0]!; x <= fregion[3]!; x += step) for (let y = fregion[1]!; y <= fregion[4]!; y += step) for (let zc = fregion[2]!; zc <= fregion[5]!; zc += step) {
      if (anchorIndex.distance(x, y, zc, 0.03) > 0.03) continue
      q.push(x, y, zc)
    }
    const pts = Float32Array.from(q)
    const d = detsOf(fieldMap, pts, 1)
    d.forEach((det, i) => {
      dets.push(det)
      if (det > 0) return
      const k = `${pts[3 * i]! >= 0 ? 'L' : 'R'} y ${(Math.floor(pts[3 * i + 1]! / 0.05) * 0.05).toFixed(2)}–${(Math.floor(pts[3 * i + 1]! / 0.05) * 0.05 + 0.05).toFixed(2)}`
      foldLevels[k] = (foldLevels[k] ?? 0) + 1
    })
  }
  dets.sort((a, b) => a - b)
  log('jacobian')

  sides.forEach((sd, i) => {
    const T = abductionTransform(sd.gh, sd.lat * theta)
    const inv = abductionTransform(sd.gh, -sd.lat * theta)
    transforms[`arm_${sd.s}`] = { rotation: T.rotation.map((v) => Number(v.toFixed(8))), translationM: T.translationM.map((v) => Number(v.toFixed(7))), inverse: { rotation: inv.rotation.map((v) => Number(v.toFixed(8))), translationM: inv.translationM.map((v) => Number(v.toFixed(7))) } }
    const elbow1 = Array.from(whole(sd.elbow, i))
    const capitate = bone(`${sd.S} capitate`)
    const wrist = (posed: boolean) => (capitate ? limbJointCentres(sd.lat, { capitate: posed ? posedMesh(capitate) : capitate.mesh }).wrist : undefined)
    sidesReport[sd.S.toLowerCase()] = {
      headCentreM: sd.gh.map((v) => Number(v.toFixed(5))),
      humerusLengthMm: mm1(sd.length),
      limbBones: sd.armBones.length,
      glenohumeralGap: { before: contact(sd.humerus.mesh, sd.scapula.mesh), after: contact(posedMesh(sd.humerus), sd.scapula.mesh) },
      elbowM: { before: sd.elbow.map((v) => Number(v.toFixed(5))), after: elbow1.map((v) => Number(v.toFixed(5))) },
      wristM: { before: wrist(false)?.map((v) => Number(v.toFixed(5))) ?? null, after: wrist(true)?.map((v) => Number(v.toFixed(5))) ?? null },
      gapMm: { before: gapBefore[i], after: gapAfter[i] },
    }
  })

  const report: Record<string, unknown> = {
    applied: true,
    method: 'each free upper limb turned rigidly about the centre of its humeral head, about the antero-posterior (Z) axis, i.e. abducted in the coronal plane; scapula and clavicle stay; soft tissue by a per-vertex share of the rotation angle (attachment sites for parts on bone, a gap-adaptive scalar field for the rest)',
    plane: 'coronal (rotation about the runtime Z axis): the anatomical position is defined in the coronal plane, and the antero-posterior position of the limb, set by the shoulder correction, is left as it is; elevation in the scapular plane would also carry the hand forwards',
    scapula: SCAPULOHUMERAL_NOTE,
    angleDeg: r2(chosenDeg),
    ...(pin ? { pinned: true, reason: pin.reason, automaticWouldChoose: r2(automaticDeg), gapAtPinnedAngleMm: gapAtPinnedMm, gapNeededMm: Math.round(need * 1000) / 1000 } : {}),
    angleChosen: opts.angleDeg === 'auto' ? `smallest multiple of ${opts.angleStep}° at which, on both sides, the deep parts turning with the limb are at least ${opts.minGap * 1000} mm from the deep parts that stay (from the band ${BINS[firstBin]![0]} of the humerus down to the fingertips) and from the muscles of the axillary folds (from the band ${BINS[firstFoldBin]![0]} down: ${opts.foldBandsBelowInsertion} bands below the band in which their insertions on the humerus end; proximal to that the folds meet the arm by anatomy); ${opts.samplingAllowance * 1000} mm is added to the requirement for the point sampling` : 'given',
    requirement,
    criterion: {
      rule: `arm ≥ ${opts.minGap * 1000} mm from the deep parts that stay from ${opts.fromFraction * 100}% of the humerus down, and ≥ ${opts.minGap * 1000} mm from the fold muscles from ${opts.foldBandsBelowInsertion} bands (5% of the humerus each) below the band in which their insertions end`,
      whyNotFromAQuarter: `a gap from ${opts.fromFraction * 100}% of the humerus cannot be had by abduction: latissimus dorsi, teres major and pectoralis major insert on the humerus down to ${Math.round(insertionEnd * 100)}% of its length and lie along the arm below that; the gap between them and the arm opens like a hinge at the distal end of the insertions, so the band just below it stays under ${opts.minGap * 1000} mm at any small angle (see gapCurve.foldsClearFrom: the level from which the folds are clear stops rising after the first degrees)`,
      anatomy: 'with the arm at the side the axillary folds lie along the arm and the medial arm skin touches the skin of the chest wall in a living person too; an axilla open from about mid-humerus is the anatomical resting state, and the chest wall itself was never the obstacle (see the wall columns)',
      decided: 'accepted by the project coordinator on review of the gap-vs-angle curve; the earlier target of 25% was withdrawn',
    },
    travelWithLimb: {
      note: `parts not attached to bone that continue into the distal arm with weight 1 are given weight 1 from the lower border of the axilla down (the field's value rising to 1 between ${Math.round(travelFrom * 100)}% and ${Math.round(travelFull * 100)}% of the humerus); largestRise is the largest weight deficit this removed below that level`,
      fromFraction: r2(travelFrom), fullFromFraction: r2(travelFull), parts: travellers.sort((a, b) => b.largestRise - a.largestRise || (a.id < b.id ? -1 : 1)),
      lagBelowAxilla: { note: 'deformed field-carried parts other than nerves: largest distance of their vertices below the axilla (and within 5 cm of a limb bone) from the rigid turn of the limb; nerves are in nerves.perNerve', parts: lagRows },
    },
    gapCurve: {
      note: `smallest distance (mm, capped at ${GAP_REACH * 1000}) from the deep parts that turn whole with the limb to (wall) the deep parts that stay and (folds) the crossing muscles whose belly lies on the trunk or scapula, turned by their own weights; by band along the humerus (head centre = 0, elbow = 1), then forearm and hand; point samples 3 mm (limb) and 1.5 mm (other side) apart, so values read up to about 1 mm high`,
      bands: BINS.map(([n]) => n), curve, foldsClearFrom,
    },
    gapBands: BINS.map(([n]) => n),
    wallGapLimitedBy: { note: 'the staying deep part nearest to the limb in each band, at the chosen angle', left: limitedBy[0], right: limitedBy[1] },
    foldGapLimitedBy: { note: 'the fold muscle nearest to the limb in each band, at the chosen angle', left: foldLimitedBy[0], right: foldLimitedBy[1] },
    sides: sidesReport,
    transforms: { note: 'x ↦ rotation·x + translation (row-major, metres, runtime frame), applied after the shoulder correction; `inverse` undoes the abduction. arm_* applies to the humerus and every bone distal to it.', ...transforms },
    field: {
      anchors: gap.anchors, options: opts.field, regionM: fregion.map((v) => Number(v.toFixed(3))), largestWeightNearBoundary: r4(boundaryMax),
      jacobian: { samples: dets.length, min: Number((dets[0] ?? 1).toFixed(3)), p1: Number(quant(dets, 0.01).toFixed(3)), median: Number(quant(dets, 0.5).toFixed(3)), p99: Number(quant(dets, 0.99).toFixed(3)), max: Number((dets[dets.length - 1] ?? 1).toFixed(3)), nonPositive: dets.filter((d) => d <= 0).length, nonPositiveByLevel: foldLevels },
    },
    parts: {
      moved: moved.size, ...counts, byVia, byTissue, deformedIds,
      attached: { parts: attached.length, atRest: attached.filter((a) => a.kind === 'rest').length, withLimb: attached.filter((a) => a.kind === 'arm').length, crossing: attached.filter((a) => a.kind === 'cross').length, unattached: unattached.length },
      mapJacobianAtVertices: { samples: mapDets.length, min: Number((mapDets[0] ?? 1).toFixed(3)), p1: Number(quant(mapDets, 0.01).toFixed(3)), median: Number(quant(mapDets, 0.5).toFixed(3)), p99: Number(quant(mapDets, 0.99).toFixed(3)), nonPositive: mapDets.filter((d) => d <= 0).length, partsWithFolds: foldRows },
      thinStructures: { parts: thinIds.size, triangles: thinTriangles, reversedTriangles: thinFlipped, partsWithReversedTriangles: thinRows.sort((a, b) => b.reversed - a.reversed || (a.id < b.id ? -1 : 1)) },
    },
    crossing: { note: 'parts attached to both a limb bone and a trunk-side bone (scapula and clavicle included); volume and origin–insertion distance (between the centroids of the two attachment sites) before and after', parts: crossRows },
    attachments: { note: 'closest approach of every crossing part to the limb bones and to the trunk-side bones, before and after', checked: attachChecked, movedOffBoneByMoreThan1Mm: attachLost, largestIncrease: attachWorst },
    insideBone: { samples: inN, before: Number((in0 / Math.max(1, inN)).toFixed(5)), after: Number((in1 / Math.max(1, inN)).toFixed(5)), largestIncreases: insideRows.slice(0, 12), largestDecreases: insideRows.slice(-6).reverse() },
    nerves: {
      rebuilt: nerveRows.length, lengthM: Number(nLen.toFixed(2)),
      inBone: { before: Number((boneRest / Math.max(1e-9, nLen)).toFixed(5)), afterField: Number((boneField / Math.max(1e-9, nLen)).toFixed(5)), afterCleanUp: Number((bonePosed / Math.max(1e-9, nLen)).toFixed(5)) },
      deepInMuscle: { before: Number((muscleRest / Math.max(1e-9, nLen)).toFixed(5)), after: Number((musclePosed / Math.max(1e-9, nLen)).toFixed(5)) },
      perNerve: nerveRows,
    },
  }
  return { moved, report }
}
