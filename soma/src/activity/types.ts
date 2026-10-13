// "肌肉活动"的数据契约：离线工具（tools/activity/）写 public/anatomy/<body>/activity.json，运行时（src/activity/）读。
// Data contract of the "muscle activity" display: the offline tool (tools/activity/) writes
// public/anatomy/<body>/activity.json and the runtime (src/activity/) reads it.
//
// 两层内容，可信程度不同 / Two layers of different standing:
//   第一层（几何，可靠）：每条肌肉的作用线在当前姿势下相对静止姿势、相对解剖学零位的长度变化。
//   Layer 1 (geometry, reliable): the length of every muscle's line of action in the current pose,
//   relative to rest and to the anatomical zero.
//   第二层（估计）：要抵抗重力保持这个姿势，哪些肌肉必须用力——静力优化的结果，到处都标为估计。
//   Layer 2 (an estimate): which muscles must be active to hold the pose against gravity, by static
//   optimisation; labelled as an estimate wherever it is shown.
//
// 这些类型有意不放进 src/anatomy/types.ts（那是协调者维护的契约）；提议并入的内容见本文件末尾。
// These types are deliberately kept out of src/anatomy/types.ts (the coordinator's contract);
// what is proposed for it is listed at the end of this file.

import type { BodyId, Vec3 } from '../anatomy/types.ts'

export interface Bilingual {
  zh: string
  en: string
}

/** 静止姿势下的一个点，以及带动它的关节 / A rest-pose point and the joint it moves with. */
export interface AnchoredPoint {
  point: Vec3
  joint: string
}

/** 一个质量节段：跟随某个关节的质量和质心（静止姿势，米）/ One mass segment: mass and centre of mass (rest pose, metres) moving with a joint. */
export interface MassSegment {
  joint: string
  kg: number
  com: Vec3
}

/**
 * 肌肉可靠性标记（静态部分，离线写入）。运行时还会按姿势加上 `near`（作用线贴近关节中心）和 `flip`（力臂变号）。
 * Reliability flags of a muscle (the static ones, written offline). The runtime adds the pose-dependent
 * `near` (line close to a joint centre) and `flip` (moment arm changed sign).
 *   wrap    解剖上绕过骨或关节的肌肉，直线作用线在大角度下不可靠 / anatomically wraps round bone or a joint; a straight line is unreliable at large angles
 *   arm     我们的作用线力臂与参照模型不符（标定表里超出容差）/ our line's moment arm disagrees with the reference models (outside tolerance in the calibration tables)
 *   fibre   纤维长度用的是默认比例（假设）/ fibre length from the default ratio (an assumption)
 *   via     路径加了经过点（如经髌骨），不是绑定里的直线 / the path has a via point (e.g. through the patella), not the rig's straight line
 *   volume  肌肉网格不封闭或体积可疑，PCSA 不可靠 / muscle mesh not closed or of doubtful volume; PCSA unreliable
 *   noload  不参与负荷估计（面部、咽、肋间等），fmaxN 为 0，只显示长度变化 / left out of the load estimate (facial, pharyngeal, intercostal …): fmaxN is 0, only its length change is shown
 */
export type MuscleFlag = 'wrap' | 'arm' | 'fibre' | 'via' | 'volume' | 'noload'

export interface ActivityMuscle {
  /** Part.id。 */
  part: string
  /** 英文名（来自 anatomy.json，便于测试和调试；界面的中英文名从知识层取）/ English name (from anatomy.json, for tests and debugging; the UI takes names from the knowledge layer). */
  name: string
  /** 在 rig.muscles 中的下标（用于驱动肌腹变粗）/ Index into rig.muscles (drives the belly thickening). */
  line: number
  /** 作用路径：起点、可选的经过点、止点 / Path of action: origin, optional via points, insertion. */
  path: AnchoredPoint[]
  /** 肌肉网格体积，cm³ / Muscle mesh volume, cm³. */
  volumeCm3: number
  /** 纤维长度，米，及其来历 / Fibre length in metres and where it comes from. */
  fibreM: number
  fibreBasis: string
  /** 生理横截面积 cm² = 体积 / 纤维长度 / Physiological cross-sectional area, cm² = volume / fibre length. */
  pcsaCm2: number
  /** 最大等长力，牛 = PCSA × 比张力 / Maximum isometric force, N = PCSA × specific tension. */
  fmaxN: number
  flags: MuscleFlag[]
  /** 标记的理由（给界面的提示）/ Why it is flagged (for the UI tooltip). */
  why?: Bilingual[]
}

export interface ContactPoint extends AnchoredPoint {
  side: 'L' | 'R'
  kind: 'heel' | 'ball'
}

export interface ActivitySource {
  id: string
  name: string
  url: string
  licence: string
  opened: string
}

export interface ActivityData {
  schema: 1
  body: BodyId
  /** 生成时各输入的哈希（与 rig-report.json 同一种记法）；离线检查是否过期用 / Hashes of the inputs (recorded as in rig-report.json); for the offline staleness check. */
  inputs: Record<string, string>
  /** 所依据的绑定的签名（见 rigSignature）；运行时核对，不符即认为过期 / Signature of the rig it was built for (see rigSignature); checked at run time, a mismatch means stale. */
  rigSignature: string
  mass: {
    /** 默认体型下的体重 = BMI × 身高²（体型模型的默认值）/ Body mass at the default shape = BMI × stature² (defaults of the shape model). */
    bodyKg: number
    statureM: number
    bmi: number
    /** 由几何和密度直接算出的体重，归一化之前 / Mass computed from geometry and densities before normalising. */
    computedKg: number
    segments: MassSegment[]
  }
  muscles: ActivityMuscle[]
  /** 没有可用作用线的肌肉部件 / Muscle parts without a usable line. */
  excluded: { part: string; name: string; why: string }[]
  /** 足底接触点（站立时地面反力作用处）/ Sole contact points (where the ground reaction acts when standing). */
  contacts: ContactPoint[]
  /** 手上的外加负荷作用点 / Where a load held in the hand acts. */
  hands: { L?: AnchoredPoint; R?: AnchoredPoint }
  /** 不参与力矩平衡的关节（肋、髌骨……），其反力由被动结构承担 / Joints left out of the torque balance (ribs, patella …); passive structures carry them. */
  lockedJoints: string[]
  /**
   * 一起平衡的关节组（腰椎、胸椎、颈椎）：同一根轴上的自由度合成一行，肌肉只需平衡这一段的平均力矩。
   * Joints balanced together (lumbar, thoracic, cervical spine): the dofs about the same axis form one row and the
   * muscles need only balance the mean torque over the stretch.
   */
  dofGroups: { id: string; name: Bilingual; joints: string[] }[]
  params: {
    /** 比张力 N/cm² / Specific tension, N/cm². */
    specificTensionNcm2: number
    g: number
    /** 备用执行器的惩罚系数 κ（相对该自由度的肌肉能力）/ Reserve penalty κ (relative to the dof's muscle capacity). */
    reservePenalty: number
    /** 自由度离极限多近（弧度）时，推向极限的力矩算作被动结构承担 / How near a limit (radians) a dof must be for torque pushing into it to count as passive. */
    limitTolerance: number
    /** 接触判定：比最低点高出不超过这么多（米）的足底点算着地 / Contact: sole points no higher than this (m) above the lowest one bear load. */
    contactTolerance: number
    /** 作用线离所跨关节中心小于这个距离（米）时标为不可靠 / A line passing a spanned joint centre closer than this (m) is flagged. */
    nearCentre: number
    /** 满激活时肌腹最多增粗的比例 / Largest belly thickening at full display activation, as a fraction. */
    bulgeMax: number
    /** 颜色和增粗用的激活度上限（达到它即为满色）/ Activation at which colour and bulge saturate. */
    displayFull: number
  }
  sources: ActivitySource[]
  cautions: Bilingual[]
}

export type GravityMode = 'stand' | 'supine' | 'prone'
export type ActivityMode = 'off' | 'len' | 'load'

/** 手持负荷：千克，哪只手（B = 两手各持这么多）/ A load held in the hand: kilograms and which hand (B = that much in each). */
export interface HandLoad {
  kg: number
  side: 'L' | 'R' | 'B'
}

// ---------------------------------------------------------------------------------------------
// 提议并入 src/anatomy/types.ts 的内容（本代理没有改那个文件）
// Proposed additions to src/anatomy/types.ts (this agent did not edit that file):
//
//   · 文件清单里加两行 / two lines in the file list:
//       /anatomy/<body>/activity.json   ActivityData  (optional) masses, muscle strengths and paths for the muscle-activity display
//   · `MuscleLine.via?: { point: Vec3; joint: string }[]`：作用线的经过点。现在股直肌的直线从髂骨直接连到胫骨，
//     不经过髌骨，膝关节力臂符号是反的；本功能在 activity.json 里自己加了经过点。绑定若采纳，体积修正和标定也会受益。
//     Via points of a line of action. The rig's rectus femoris runs straight from ilium to tibia and misses the
//     patella, so its knee moment arm has the wrong sign; this feature adds the via point in activity.json. Adopting
//     it in the rig would help the volume correction and the calibration too.
//   · `Joint.mass?: { kg: number; com: Vec3 }`：节段质量和质心，软组织物理也用得上。
//     Segment mass and centre of mass per joint; the soft-tissue physics could use them as well.
