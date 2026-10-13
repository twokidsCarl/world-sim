// 有已知答案的检验姿势：验证工具、测试和 sim.json 的卡片共用同一份定义。
// Sanity poses with known answers: one definition shared by the validation tool, the tests and the cards in sim.json.
//
// 每个姿势用解剖学角度写（PoseBuilder.anat），所以两副人体上是同一个姿势，而不是同一组相对静止姿势的角度。
// Every pose is stated in anatomical angles (PoseBuilder.anat), so it is the same posture on both bodies rather
// than the same angles relative to their different rest poses.

import type { Joint } from '../../src/anatomy/types.ts'
import type { GravityMode, HandLoad } from '../../src/activity/types.ts'
import type { Pose } from '../rig/pose.ts'
import { LUMBAR, PoseBuilder, THORACIC, standardPostures } from '../rig/postures.ts'

export interface SanityCase {
  id: string
  name: { zh: string; en: string }
  gravity: GravityMode
  load?: HandLoad
  pose: (joints: Joint[]) => Pose
  /** 应当用力的肌肉（名称的正则，取左侧），以及应当安静的 / Muscles expected to work (regex on names, left side) and to stay silent. */
  active: string[]
  silent: string[]
  /** 这些自由度上的要求力矩的符号（关节.自由度 → +1 / −1）/ Expected sign of the required torque at these dofs. */
  torque?: Record<string, 1 | -1>
  /** 已知答案的出处：这里都是教科书层面的功能解剖 / where the known answer comes from: textbook functional anatomy throughout */
  basis: { zh: string; en: string }
}

const preset = (id: string) => (joints: Joint[]): Pose => standardPostures(joints).find((p) => p.id === id)?.pose ?? {}
const both = (f: (s: 'L' | 'R') => void): void => (['L', 'R'] as const).forEach(f)

/**
 * 浅蹲：屈膝 60°，小腿前倾（踝背屈 12°），躯干前倾使重心落在足中部上方。骨盆是骨架的根，所以"整个人前倾"写成
 * 骨盆前倾 pelvisTilt 度，再由屈髋把大腿带回去：屈髋 = 屈膝 − 踝背屈 + 骨盆前倾 时足底是平的。
 * Shallow squat: knees flexed 60°, shanks inclined (ankles dorsiflexed 12°), trunk leaning so that the centre of
 * mass is over the midfoot. The pelvis is the root of the skeleton, so "the whole body leans" is written as an
 * anterior pelvic tilt of pelvisTilt degrees, with hip flexion bringing the thighs back: the soles are flat when
 * hip flexion = knee flexion − ankle dorsiflexion + pelvic tilt.
 */
export function squatPose(joints: Joint[], knee = 60, ankle = 12, pelvisTilt = 45): Pose {
  const b = new PoseBuilder(joints)
  b.anat('pelvis', 0, pelvisTilt)
  both((s) => b.anat(`hip_${s}`, 0, knee - ankle + pelvisTilt).anat(`knee_${s}`, 0, knee).anat(`ankle_${s}`, 0, ankle))
  return b.pose
}

/** 踮脚：踝跖屈、跖趾关节背伸同样的角度，脚趾仍平放在地上 / On tiptoe: ankles plantar-flexed and the toes extended by the same angle so that they stay flat on the ground. */
export function tiptoePose(joints: Joint[], degrees = 25): Pose {
  const b = new PoseBuilder(joints)
  both((s) => {
    b.anat(`ankle_${s}`, 0, -degrees)
    for (const d of [1, 2, 3, 4, 5]) b.rel(`mtp${d}_${s}`, 0, (degrees * Math.PI) / 180, false)
  })
  return b.pose
}

/** 以踝为轴整体前倾：骨盆（根）前倾，踝背屈同样的角度，足底仍是平的 / Leaning forward about the ankles: the pelvis (root) tilts and the ankles dorsiflex by the same angle, soles flat. */
export function leanPose(joints: Joint[], degrees = 6): Pose {
  const b = new PoseBuilder(joints)
  b.anat('pelvis', 0, degrees)
  both((s) => b.anat(`ankle_${s}`, 0, degrees))
  return b.pose
}

export function trunkFlexPose(joints: Joint[], degrees = 30): Pose {
  return new PoseBuilder(joints).spread([...LUMBAR, ...THORACIC], 0, degrees).pose
}

/** 上臂前屈举过头，再屈肘：前臂在肘的上方，重力要把肘压弯 / Arm raised overhead in flexion, elbow then bent: the forearm is above the elbow and gravity tends to fold it. */
export function overheadPose(joints: Joint[], elbow = 70): Pose {
  const b = new PoseBuilder(joints)
  b.merge(preset('shoulderFlex160')(joints))
  both((s) => b.anat(`elbow_${s}`, 0, elbow))
  return b.pose
}

export const SANITY_CASES: SanityCase[] = [
  {
    id: 'elbow90',
    name: { zh: '屈肘 90°，前臂水平', en: 'elbow flexed 90°, forearm horizontal' },
    gravity: 'stand',
    pose: preset('elbow90'),
    active: ['biceps brachii', 'brachialis', 'brachioradialis'],
    silent: ['triceps brachii'],
    torque: { 'elbow_L.0': 1 },
    basis: { zh: '重力使前臂下落（伸肘），由屈肘肌对抗', en: 'gravity drops the forearm (extends the elbow); the elbow flexors oppose it' },
  },
  {
    id: 'elbow90load',
    name: { zh: '屈肘 90°，手持 2 kg', en: 'elbow flexed 90° holding 2 kg' },
    gravity: 'stand',
    load: { kg: 2, side: 'B' },
    pose: preset('elbow90'),
    active: ['biceps brachii', 'brachialis', 'brachioradialis'],
    silent: ['triceps brachii'],
    torque: { 'elbow_L.0': 1 },
    basis: { zh: '同上，负荷更大，激活度应更高', en: 'as above with more load: activations must be higher' },
  },
  {
    id: 'overhead',
    name: { zh: '上臂举过头、屈肘 70°', en: 'arm overhead, elbow flexed 70°' },
    gravity: 'stand',
    pose: (j) => overheadPose(j),
    active: ['triceps brachii'],
    silent: ['biceps brachii', 'brachialis'],
    torque: { 'elbow_L.0': -1 },
    basis: { zh: '前臂在肘的上方，重力使肘屈曲，由伸肘肌对抗', en: 'the forearm is above the elbow, gravity flexes it and the elbow extensors oppose it' },
  },
  {
    id: 'abduction90',
    name: { zh: '肩外展 90°', en: 'arm abducted 90°' },
    gravity: 'stand',
    pose: preset('shoulderAbd90'),
    active: ['acromial part of .*deltoid', 'supraspinatus'],
    silent: ['latissimus dorsi', 'teres major'],
    torque: { 'gh_L.1': 1 },
    basis: { zh: '重力使上臂内收，由三角肌中束和冈上肌对抗', en: 'gravity adducts the arm; the middle deltoid and supraspinatus oppose it' },
  },
  {
    id: 'squat',
    name: { zh: '浅蹲（屈膝 60°）', en: 'shallow squat (knees 60°)' },
    gravity: 'stand',
    pose: (j) => squatPose(j),
    active: ['vastus lateralis', 'vastus medialis', 'vastus intermedius'],
    silent: ['short head of .*biceps femoris', 'popliteus'],
    torque: { 'knee_L.0': -1 },
    basis: {
      zh: '体重使膝屈曲，由股四头肌对抗；只跨膝关节的屈膝肌（股二头肌短头、腘肌）应当安静。躯干前倾时跨髋和膝的腘绳肌会作为伸髋肌一起用力，所以不把它们列为"应当安静"',
      en: 'body weight flexes the knees and the quadriceps oppose it; the knee flexors that span the knee alone (short head of biceps femoris, popliteus) must stay silent. With the trunk leaning forward the two-joint hamstrings work as hip extensors, so they are not listed as silent',
    },
  },
  {
    id: 'tiptoe',
    name: { zh: '踮脚站立', en: 'standing on tiptoe' },
    gravity: 'stand',
    pose: (j) => tiptoePose(j),
    active: ['soleus', 'gastrocnemius'],
    silent: ['tibialis anterior'],
    torque: { 'ankle_L.0': -1 },
    basis: { zh: '地面反力在前足，使踝背屈，由小腿三头肌对抗', en: 'the ground reaction under the forefoot dorsiflexes the ankle; the triceps surae opposes it' },
  },
  {
    id: 'lean',
    name: { zh: '以踝为轴前倾 6°', en: 'leaning forward 6° at the ankles' },
    gravity: 'stand',
    pose: (j) => leanPose(j),
    active: ['soleus', 'gastrocnemius'],
    silent: ['tibialis anterior'],
    torque: { 'ankle_L.0': -1 },
    basis: { zh: '重心移到踝的前方，由跖屈肌拉住', en: 'the centre of mass moves in front of the ankles and the plantar flexors hold it' },
  },
  {
    id: 'trunk30',
    name: { zh: '躯干前屈 30°', en: 'trunk flexed forward 30°' },
    gravity: 'stand',
    pose: (j) => trunkFlexPose(j),
    active: ['iliocostalis lumborum|longissimus thoracis'],
    silent: ['rectus abdominis'],
    torque: { 'L3.0': -1 },
    basis: { zh: '上身重量使脊柱前屈，由竖脊肌对抗', en: 'the weight of the upper body flexes the spine; the erector spinae opposes it' },
  },
  {
    id: 'slr',
    name: { zh: '仰卧直腿抬高 45°', en: 'supine straight leg raise 45°' },
    gravity: 'supine',
    pose: (j) => new PoseBuilder(j).anat('hip_L', 0, 45).pose,
    active: ['iliacus', 'psoas major', 'rectus femoris'],
    silent: ['gluteus maximus', 'long head of .*biceps femoris'],
    torque: { 'hip_L.0': 1 },
    basis: { zh: '重力使抬起的下肢下落（伸髋），由屈髋肌对抗', en: 'gravity drops the raised limb (extends the hip); the hip flexors oppose it' },
  },
]
