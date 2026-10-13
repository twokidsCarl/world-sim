// 标准姿势：用解剖学角度（度）描述，换算成相对模型静止姿势的关节角。验证与测试共用。
// Standard postures, stated in anatomical angles (degrees) and converted to joint angles relative
// to the model's rest pose. Shared by the validation and the tests.

import type { Joint, JointDof } from '../../src/anatomy/types.ts'
import { type Pose, armElevation, mergePoses } from './pose.ts'

type DofExt = JointDof & { neutral?: number }

export interface Posture {
  id: string
  name: { zh: string; en: string }
  pose: Pose
  /** 该姿势主要活动的关节（用于骨–骨检查）。 Joints mainly moved (for the bone-to-bone checks). */
  focus: string[]
  /** 特写视图：中心取这些关节在当前姿势下的平均位置。 Close-up view centred on these joints as posed. */
  closeUp?: { joints: string[]; halfHeight: number; yaw: number }
  /** 因超出活动范围而被截断的设定。 Settings that had to be clamped to the range of motion. */
  clamped: string[]
}

const rad = (d: number): number => (d * Math.PI) / 180

export class PoseBuilder {
  private readonly byId: Map<string, Joint>
  readonly pose: Pose = {}
  /** 因超出活动范围而被截断的设定。 Settings that were clamped to the range of motion. */
  readonly clamped: string[] = []

  constructor(readonly joints: Joint[]) {
    this.byId = new Map(joints.map((j) => [j.id, j]))
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** 按轴号找自由度（0 = 屈伸，1 = 收展/侧屈，2 = 旋转）。 The dof on a given axis (0 = flexion, 1 = ab/adduction or lateral bending, 2 = rotation). */
  dof(id: string, axis: number): { joint: Joint; k: number; d: DofExt } | null {
    const joint = this.byId.get(id)
    if (!joint) return null
    const k = joint.dofs.findIndex((d) => d.axis === axis)
    return k < 0 ? null : { joint, k, d: joint.dofs[k]! }
  }

  /** 把某自由度设为给定的解剖学角度（度；0 = 解剖学零位）。 Sets a dof to an anatomical angle (degrees; 0 = anatomical zero position). */
  anat(id: string, axis: number, degrees: number): this {
    const f = this.dof(id, axis)
    if (!f) return this
    return this.rel(id, axis, rad(degrees) + (f.d.neutral ?? 0), true)
  }

  /** 把某自由度设为相对静止姿势的角度（弧度）。 Sets a dof to an angle relative to the rest pose (radians). */
  rel(id: string, axis: number, angle: number, absolute = true): this {
    const f = this.dof(id, axis)
    if (!f) return this
    const a = (this.pose[id] ??= f.joint.dofs.map(() => 0))
    let v = absolute ? angle : a[f.k]! + angle
    if (v < f.d.min - 1e-9 || v > f.d.max + 1e-9) {
      this.clamped.push(`${id}[${f.k}] ${Math.round((v * 180) / Math.PI)}° → ${Math.round((Math.min(f.d.max, Math.max(f.d.min, v)) * 180) / Math.PI)}°`)
      v = Math.min(f.d.max, Math.max(f.d.min, v))
    }
    a[f.k] = v
    return this
  }

  /** 把总角度（度）按各节段活动范围的比例分配到一串关节上。 Spreads a total angle (degrees) over a chain of joints in proportion to each one's range. */
  spread(ids: string[], axis: number, totalDeg: number): this {
    const fs = ids.map((id) => this.dof(id, axis)).filter((f): f is NonNullable<typeof f> => !!f)
    const lim = (f: (typeof fs)[number]): number => (totalDeg >= 0 ? f.d.max : -f.d.min)
    const sum = fs.reduce((s, f) => s + lim(f), 0)
    if (sum <= 0) return this
    const share = Math.min(1, rad(Math.abs(totalDeg)) / sum)
    if (rad(Math.abs(totalDeg)) > sum + 1e-9) this.clamped.push(`spread over ${ids[0]}…${ids[ids.length - 1]}: ${totalDeg}° exceeds the summed range ${Math.round((sum * 180) / Math.PI)}°`)
    for (const f of fs) this.rel(f.joint.id, axis, Math.sign(totalDeg) * share * lim(f))
    return this
  }

  merge(p: Pose): this {
    const m = mergePoses(this.pose, p)
    for (const [k, v] of Object.entries(m)) this.pose[k] = v
    return this
  }
}

export const LUMBAR = ['L5', 'L4', 'L3', 'L2', 'L1']
export const THORACIC = ['T12', 'T11', 'T10', 'T9', 'T8', 'T7', 'T6', 'T5', 'T4', 'T3', 'T2', 'T1']
export const CERVICAL = ['C7', 'C6', 'C5', 'C4', 'C3', 'C2', 'C1', 'skull']

/** 上臂相对躯干抬高到给定角度（含肩肱节律）。 Arm raised against the trunk to the given angle (with scapulohumeral rhythm). */
function raiseArm(b: PoseBuilder, side: 'L' | 'R', degrees: number, plane: 0 | 1): void {
  const id = `gh_${side}`
  if (!b.has(id)) return
  // 闭环：解出盂肱关节角，使上臂长轴与铅垂线的夹角恰为给定值（静止时已有的外展在其中扣除）
  // closed loop: the glenohumeral angles are solved so that the upper arm ends at exactly the stated
  // angle from the vertical (what it is already abducted by at rest is taken off inside)
  const p = armElevation(b.joints, side, rad(degrees), plane)
  const gh = p[id]!
  delete p[id]
  b.merge(p)
  // 盂肱关节角经 rel 设定，超出活动范围时照常截断并记录 / set through rel so that the range of motion still clamps and reports
  b.dof(id, 0) && b.rel(id, 0, gh[b.dof(id, 0)!.k]!)
  b.dof(id, 1) && b.rel(id, 1, gh[b.dof(id, 1)!.k]!)
}

export function standardPostures(joints: Joint[]): Posture[] {
  const out: Posture[] = []
  const make = (id: string, zh: string, en: string, focus: string[], build: (b: PoseBuilder) => void, closeUp?: Posture['closeUp']): void => {
    const b = new PoseBuilder(joints)
    build(b)
    out.push({ id, name: { zh, en }, pose: b.pose, focus: focus.filter((j) => b.has(j)), closeUp, clamped: b.clamped })
  }
  const both = (f: (s: 'L' | 'R') => void): void => (['L', 'R'] as const).forEach(f)
  make('rest', '静止姿势', 'rest pose', [], () => {})
  make('elbow90', '屈肘 90°', 'elbow flexion 90°', ['elbow_L', 'radioulnar_L'], (b) => both((s) => b.anat(`elbow_${s}`, 0, 90)), { joints: ['elbow_L'], halfHeight: 0.2, yaw: 70 })
  make('elbow140', '屈肘 140°', 'elbow flexion 140°', ['elbow_L', 'radioulnar_L'], (b) => both((s) => b.anat(`elbow_${s}`, 0, 140)), { joints: ['elbow_L'], halfHeight: 0.2, yaw: 70 })
  make('pronation', '前臂旋前（屈肘 90°）', 'forearm pronation (elbow at 90°)', ['radioulnar_L', 'wrist_L'], (b) => both((s) => b.anat(`elbow_${s}`, 0, 90).anat(`radioulnar_${s}`, 2, 75)), { joints: ['elbow_L', 'wrist_L'], halfHeight: 0.2, yaw: 40 })
  make('supination', '前臂旋后（屈肘 90°）', 'forearm supination (elbow at 90°)', ['radioulnar_L', 'wrist_L'], (b) => both((s) => b.anat(`elbow_${s}`, 0, 90).anat(`radioulnar_${s}`, 2, -85)), { joints: ['elbow_L', 'wrist_L'], halfHeight: 0.2, yaw: 40 })
  make('shoulderAbd90', '肩外展 90°', 'shoulder abduction 90°', ['gh_L', 'ac_L', 'sc_L'], (b) => both((s) => raiseArm(b, s, 90, 0)), { joints: ['gh_L'], halfHeight: 0.25, yaw: 0 })
  make('shoulderFlex160', '肩前屈 160°', 'shoulder flexion 160°', ['gh_L', 'ac_L', 'sc_L'], (b) => both((s) => raiseArm(b, s, 160, 1)), { joints: ['gh_L'], halfHeight: 0.3, yaw: 60 })
  make('hipFlex90', '屈髋 90°（左）', 'hip flexion 90° (left)', ['hip_L'], (b) => b.anat('hip_L', 0, 90), { joints: ['hip_L'], halfHeight: 0.3, yaw: 70 })
  make('knee90', '屈膝 90°（左）', 'knee flexion 90° (left)', ['knee_L', 'patella_L'], (b) => b.anat('knee_L', 0, 90), { joints: ['knee_L'], halfHeight: 0.22, yaw: 80 })
  make('knee135', '屈膝 135°（左）', 'knee flexion 135° (left)', ['knee_L', 'patella_L'], (b) => b.anat('knee_L', 0, 135), { joints: ['knee_L'], halfHeight: 0.22, yaw: 80 })
  make('ankleDorsi', '踝背屈 12°', 'ankle dorsiflexion 12°', ['ankle_L', 'subtalar_L'], (b) => both((s) => b.anat(`ankle_${s}`, 0, 12)), { joints: ['ankle_L'], halfHeight: 0.15, yaw: 80 })
  make('anklePlantar', '踝跖屈 50°', 'ankle plantar flexion 50°', ['ankle_L', 'subtalar_L'], (b) => both((s) => b.anat(`ankle_${s}`, 0, -50)), { joints: ['ankle_L'], halfHeight: 0.15, yaw: 80 })
  make('fist', '握拳', 'full fist', ['mcp2_L', 'pip2_L', 'dip2_L', 'mcp3_L', 'pip3_L', 'dip3_L', 'mcp5_L', 'pip5_L', 'ip1_L'], (b) =>
    both((s) => {
      for (const d of [2, 3, 4, 5]) b.anat(`mcp${d}_${s}`, 0, 85).anat(`pip${d}_${s}`, 0, 100).anat(`dip${d}_${s}`, 0, 65)
      b.rel(`cmc1_${s}`, 0, rad(25)).rel(`cmc1_${s}`, 1, rad(25)).anat(`mcp1_${s}`, 0, 45).anat(`ip1_${s}`, 0, 60)
    }), { joints: ['mcp3_L'], halfHeight: 0.09, yaw: 60 })
  make('neckRot60', '颈部左旋 60°', 'cervical rotation 60° to the left', ['C1', 'skull', 'C4'], (b) => b.spread(CERVICAL, 2, 60), { joints: ['C4'], halfHeight: 0.2, yaw: 0 })
  make('trunkFlex60', '躯干前屈 60°', 'trunk forward flexion 60°', ['L4', 'L2', 'T12', 'T8'], (b) => b.spread([...LUMBAR, ...THORACIC], 0, 60), { joints: ['L1'], halfHeight: 0.45, yaw: 80 })
  make('squat', '深蹲', 'deep squat', ['hip_L', 'knee_L', 'patella_L', 'ankle_L'], (b) => {
    both((s) => b.anat(`hip_${s}`, 0, 115).anat(`knee_${s}`, 0, 135).anat(`ankle_${s}`, 0, 12))
    b.spread(LUMBAR, 0, 25)
  }, { joints: ['knee_L', 'hip_L'], halfHeight: 0.4, yaw: 80 })
  make('sitting', '坐姿', 'sitting', ['hip_L', 'knee_L', 'patella_L'], (b) => both((s) => b.anat(`hip_${s}`, 0, 90).anat(`knee_${s}`, 0, 90)), { joints: ['knee_L', 'hip_L'], halfHeight: 0.4, yaw: 80 })
  make('inspiration', '深吸气（各肋上提到极限）', 'deep inspiration (every rib raised to its limit)', ['rib5_L', 'rib8_L'], (b) => {
    for (const j of joints) if (/^rib\d+_[LR]$/.test(j.id)) b.rel(j.id, 0, j.dofs[0]!.max)
  }, { joints: ['T7'], halfHeight: 0.25, yaw: 30 })
  return out
}
