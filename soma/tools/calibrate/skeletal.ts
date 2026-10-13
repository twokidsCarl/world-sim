// 肌骨参照：OpenSim 全身模型（Rajagopal 等 2016）和 MyoFullBody（MuJoCo）。
// Musculoskeletal references: the OpenSim full-body model (Rajagopal et al. 2016) and MyoFullBody (MuJoCo).
//
// 写出的表 / tables written
//   muscle-curves-opensim.json   力臂、长度变化：我们 vs Rajagopal2016（由路径点直接算，圆柱缠绕为近似）
//   muscle-curves-myo.json       同上，对 MyoFullBody（由 MuJoCo 求值，缠绕是精确的）
//   muscle-attachments-myo.json  作用线两端 vs MyoFullBody 肌腱两端（按节段归一化）
//   segments.json                节段长度比例、关节轴与节段长轴的夹角
//   rom.json                     rom.json 的活动范围 vs 两个模型的关节限位
//   instrument-check.json        同一来源的两个模型（Rajagopal → MyoLeg）用两种求值方法得到的差，用来估计量具本身的误差
// moment arms and excursions against each model, attachment sites, segment proportions and joint axes, ranges of motion,
// and a check of the instrument itself (the same model family evaluated two ways).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BodyId } from '../../src/anatomy/types.ts'
import { type V3, add, deg, dist, dot, len, mul, norm, rad, sub } from '../rig/math.ts'
import { OsimModel, parseXml, type XmlNode } from '../rig/opensim.ts'
import { BODIES, type Bilingual, type OurCoord, type Ours, type Table, type Verdict, anatRange, center, coordLabel, coordPose, coordRange, count, loadOurs, muscleCurve, r1, r2, r3, writeTable } from './ours.ts'
import { RAW, REFS, ROOT, refInfo } from './refs.ts'

// ── 对应关系 / mappings ──────────────────────────────────────────────────────────────────────

/** 我们的肌肉（右侧的英文名）↔ 参照模型里的肌束名（两个模型的下肢同名）。 Our muscle (English name, right side) ↔ fascicle names in the reference models (the two share the leg names). */
export const MUSCLE_MAP: [string, string[]][] = [
  ['Right rectus femoris', ['recfem_r']], ['Right vastus lateralis', ['vaslat_r']], ['Right vastus medialis', ['vasmed_r']], ['Right vastus intermedius', ['vasint_r']],
  ['Long head of right biceps femoris', ['bflh_r']], ['Short head of right biceps femoris', ['bfsh_r']], ['Right semitendinosus', ['semiten_r']], ['Right semimembranosus', ['semimem_r']],
  ['Medial head of right gastrocnemius', ['gasmed_r']], ['Lateral head of right gastrocnemius', ['gaslat_r']], ['Right soleus', ['soleus_r']],
  ['Right tibialis anterior', ['tibant_r']], ['Right tibialis posterior', ['tibpost_r']],
  ['Right gluteus maximus', ['glmax1_r', 'glmax2_r', 'glmax3_r']], ['Right gluteus medius', ['glmed1_r', 'glmed2_r', 'glmed3_r']], ['Right gluteus minimus', ['glmin1_r', 'glmin2_r', 'glmin3_r']],
  ['Right iliacus', ['iliacus_r']], ['Right psoas major', ['psoas_r']],
  ['Right adductor brevis', ['addbrev_r']], ['Right adductor longus', ['addlong_r']], ['Right adductor magnus', ['addmagDist_r', 'addmagIsch_r', 'addmagMid_r', 'addmagProx_r']],
  ['Right gracilis', ['grac_r']], ['Right sartorius', ['sart_r']], ['Right tensor fasciae latae', ['tfl_r']], ['Right piriformis', ['piri_r']],
  ['Right extensor digitorum longus', ['edl_r']], ['Right extensor hallucis longus', ['ehl_r']], ['Right flexor digitorum longus', ['fdl_r']], ['Right flexor hallucis longus', ['fhl_r']],
  ['Right fibularis brevis', ['perbrev_r']], ['Right fibularis longus', ['perlong_r']],
  // 上肢（只有 MyoArm，源自 MoBL 模型）/ upper limb (MyoArm only, derived from the MoBL model)
  ['Clavicular part of right deltoid', ['DELT1']], ['Acromial part of right deltoid', ['DELT2']], ['Spinal part of right deltoid', ['DELT3']],
  ['Right supraspinatus', ['SUPSP']], ['Right infraspinatus muscle', ['INFSP']], ['Right subscapularis', ['SUBSC']], ['Right teres minor', ['TMIN']], ['Right teres major', ['TMAJ']],
  ['Clavicular part of right pectoralis major', ['PECM1']], ['Sternocostal part of right pectoralis major', ['PECM2']], ['Abdominal part of right pectoralis major', ['PECM3']],
  ['Right latissimus dorsi', ['LAT1', 'LAT2', 'LAT3']], ['Right coracobrachialis', ['CORB']],
  ['Long head of right triceps brachii', ['TRIlong']], ['Lateral head of right triceps brachii', ['TRIlat']], ['Medial head of right triceps brachii', ['TRImed']], ['Right anconeus', ['ANC']],
  ['Long head of right biceps brachii', ['BIClong']], ['Short head of right biceps brachii', ['BICshort']], ['Right brachialis', ['BRA']], ['Right brachioradialis', ['BRD']],
  ['Right supinator', ['SUP']], ['Humeral head of right pronator teres', ['PT']], ['Right pronator quadratus', ['PQ']],
  ['Right extensor carpi radialis longus', ['ECRL']], ['Right extensor carpi radialis brevis', ['ECRB']], ['Right extensor carpi ulnaris', ['ECU']],
  ['Right flexor carpi radialis', ['FCR']], ['Humeral head of right flexor carpi ulnaris', ['FCU']], ['Right palmaris longus', ['PL']],
  ['Right flexor digitorum superficialis', ['FDS2', 'FDS3', 'FDS4', 'FDS5']], ['Right flexor digitorum profundus', ['FDP2', 'FDP3', 'FDP4', 'FDP5']],
  ['Right extensor digitorum', ['EDC2', 'EDC3', 'EDC4', 'EDC5']], ['Right extensor digiti minimi', ['EDM']], ['Right extensor indicis', ['EIP']],
  ['Right extensor pollicis longus', ['EPL']], ['Right extensor pollicis brevis', ['EPB']], ['Right flexor pollicis longus', ['FPL']], ['Right abductor pollicis longus', ['APL']], ['Right opponens pollicis', ['OP']],
  // 躯干（只有 MyoTorso，源自 SimTK 的腰椎模型；按前缀取全部肌束）/ trunk (MyoTorso only, derived from the SimTK lumbar spine model; all fascicles of a prefix)
  ['Right rectus abdominis', ['rect_abd_r']], ['Right external oblique', ['EO*_r']], ['Right internal oblique', ['IO*_r']],
  ['Right quadratus lumborum', ['QL_*_r']], ['Right iliocostalis lumborum', ['IL_*_r']], ['Right longissimus thoracis', ['LTp*_r']], ['Right multifidus', ['MF_*_r']],
]

interface CoordDef {
  /** 参照里的坐标名（右侧）/ the reference coordinate (right side). */
  ref: string
  group: 'leg' | 'arm' | 'hand' | 'trunk'
  /** 我们的解剖学角度 = gain × 参照角度（符号由参照里一块主动肌的缩短方向核对过）/ our anatomical angle = gain × reference angle (sign checked against the shortening of an agonist in the reference). */
  gain: number
  ours: OurCoord
  movement: string
}

const dof = (joint: string, axis: number): OurCoord => ({ kind: 'dof', joint, axis })
const FINGERS: CoordDef[] = [2, 3, 4, 5].flatMap((n) => [
  { ref: `mcp${n}_flexion_r`, group: 'hand' as const, gain: 1, ours: dof(`mcp${n}_R`, 0), movement: `MCP ${n} flexion` },
  { ref: `pm${n}_flexion_r`, group: 'hand' as const, gain: 1, ours: dof(`pip${n}_R`, 0), movement: `PIP ${n} flexion` },
  { ref: `md${n}_flexion_r`, group: 'hand' as const, gain: 1, ours: dof(`dip${n}_R`, 0), movement: `DIP ${n} flexion` },
])
export const COORDS: CoordDef[] = [
  { ref: 'hip_flexion_r', group: 'leg', gain: 1, ours: dof('hip_R', 0), movement: 'hip flexion' },
  { ref: 'hip_adduction_r', group: 'leg', gain: -1, ours: dof('hip_R', 1), movement: 'hip abduction' },
  { ref: 'hip_rotation_r', group: 'leg', gain: 1, ours: dof('hip_R', 2), movement: 'hip internal rotation' },
  { ref: 'knee_angle_r', group: 'leg', gain: 1, ours: dof('knee_R', 0), movement: 'knee flexion' },
  { ref: 'ankle_angle_r', group: 'leg', gain: 1, ours: dof('ankle_R', 0), movement: 'ankle dorsiflexion' },
  { ref: 'subtalar_angle_r', group: 'leg', gain: 1, ours: dof('subtalar_R', 0), movement: 'subtalar inversion' },
  { ref: 'shoulder_elv_r', group: 'arm', gain: 1, ours: { kind: 'elevation', side: 'R', plane: 0 }, movement: 'arm abduction (thoracohumeral)' },
  { ref: 'shoulder_elv_r@elv_angle=90', group: 'arm', gain: 1, ours: { kind: 'elevation', side: 'R', plane: 1 }, movement: 'arm flexion (thoracohumeral)' },
  { ref: 'shoulder_rot_r', group: 'arm', gain: 1, ours: dof('gh_R', 2), movement: 'shoulder internal rotation' },
  { ref: 'elbow_flexion_r', group: 'arm', gain: 1, ours: dof('elbow_R', 0), movement: 'elbow flexion' },
  { ref: 'pro_sup_r', group: 'arm', gain: 1, ours: dof('radioulnar_R', 2), movement: 'forearm pronation' },
  { ref: 'flexion_r', group: 'arm', gain: 1, ours: dof('wrist_R', 0), movement: 'wrist flexion' },
  { ref: 'deviation_r', group: 'arm', gain: -1, ours: dof('wrist_R', 1), movement: 'wrist ulnar deviation' },
  ...FINGERS,
  { ref: 'mp_flexion_r', group: 'hand', gain: -1, ours: dof('mcp1_R', 0), movement: 'thumb MCP flexion' },
  { ref: 'ip_flexion_r', group: 'hand', gain: -1, ours: dof('ip1_R', 0), movement: 'thumb IP flexion' },
  // 躯干：gain 的大小在读入参照后换成“胸廓相对骶骨实际转了多少 / 主坐标”/ trunk: the magnitude of gain is replaced on load by (thorax-versus-sacrum rotation / master coordinate)
  { ref: 'flex_extension', group: 'trunk', gain: -1, ours: { kind: 'lumbar', axis: 0 }, movement: 'lumbar flexion' },
  { ref: 'lat_bending', group: 'trunk', gain: -1, ours: { kind: 'lumbar', axis: 1 }, movement: 'lumbar bending to the left' },
  { ref: 'axial_rotation', group: 'trunk', gain: 1, ours: { kind: 'lumbar', axis: 2 }, movement: 'lumbar rotation to the left' },
]

type Side = 'R' | 'L'
const toLeftName = (s: string): string => s.replace(/\bright\b/g, 'left').replace(/\bRight\b/g, 'Left')
const toLeftCoord = (c: OurCoord): OurCoord => (c.kind === 'dof' ? { ...c, joint: c.joint.replace(/_R$/, '_L') } : c.kind === 'elevation' ? { ...c, side: 'L' } : c)

// ── 参照模型的统一接口 / one interface over the reference models ───────────────────────────────

interface RefModel {
  key: 'opensim' | 'myo'
  /** 展开通配并换到指定一侧；没有的肌束被丢掉 / expands wildcards and switches side; missing fascicles are dropped. */
  names(patterns: string[], side: Side): string[]
  coordName(ref: string, side: Side): string
  /** 参照坐标的范围（度）/ range of the reference coordinate, degrees. */
  range(coord: string): [number, number] | null
  /** 各肌束长度变化的平均（毫米，相对 angles[0]）；全都不随该坐标变化时为 null / mean length change of the fascicles (mm, relative to angles[0]); null when none changes with the coordinate. */
  delta(names: string[], coord: string, anglesDeg: number[]): number[] | null
  /** 关节中心（规范坐标系：x 向左、y 向上、z 向前，米）/ joint centre in the canonical frame (x left, y up, z anterior, metres). */
  centre(what: string, side: Side): V3 | null
  trunkGain?: Record<string, number>
}

const interp = (xs: number[], ys: number[], x: number): number => {
  if (x <= xs[0]!) return ys[0]!
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]!) return ys[i - 1]! + ((ys[i]! - ys[i - 1]!) * (x - xs[i - 1]!)) / (xs[i]! - xs[i - 1]!)
  return ys[ys.length - 1]!
}

// MyoFullBody：读 tools/calibrate/myo_dump.py 的输出 / MyoFullBody: reads the output of tools/calibrate/myo_dump.py
export interface MyoDump {
  myoSim: string
  mujoco: string
  counts: Record<string, number>
  joints: { name: string; type: number; body: string; limited: boolean; rangeDeg: [number, number]; anchor: V3; axis: V3; dependent: boolean }[]
  bodies: { name: string; parent: string; pos: V3 }[]
  trunk: Record<string, { anglesDeg: number[]; thoraxVsSacrumDeg: number[] }>
  tendons: { name: string; restLength: number; origin: { site: string; body: string; pos: V3 }; insertion: { site: string; body: string; pos: V3 }; sites: number; wraps: number }[]
  curves: { tendon: string; joint: string; anglesDeg: number[]; lengthMm: number[] }[]
}

export const MYO_DUMP = join(RAW, 'myo-sim-derived', 'myofullbody.json')
export const OSIM_FILE = join(RAW, REFS.rajagopal.id, 'Rajagopal2016.osim')

/** MuJoCo 世界系（x 向左、y 向后、z 向上）→ 规范系 / MuJoCo world (x left, y posterior, z up) → canonical. */
const myoCanon = (p: V3): V3 => [p[0], p[2], -p[1]]
/** OpenSim 地面系（x 向前、y 向上、z 向右）→ 规范系 / OpenSim ground (x anterior, y up, z right) → canonical. */
const osimCanon = (p: V3): V3 => [-p[2], p[1], p[0]]

const MYO_CENTRE: Record<string, string> = { hip: 'hip_flexion_r', knee: 'knee_angle_r', ankle: 'ankle_angle_r', mtp: 'mtp_angle_r', gh: 'shoulder_elv_r', elbow: 'elbow_flexion_r', wrist: 'flexion_r', mcp3: 'mcp3_flexion_r', pip3: 'pm3_flexion_r', l5s1: 'flex_extension', sc: 'sternoclavicular_r2_r' }

export function loadMyo(): { model: RefModel; dump: MyoDump } {
  const dump = JSON.parse(readFileSync(MYO_DUMP, 'utf8')) as MyoDump
  const tendon = new Set(dump.tendons.map((t) => t.name))
  const joint = new Map(dump.joints.map((j) => [j.name, j]))
  const curve = new Map(dump.curves.map((c) => [`${c.tendon}|${c.joint}`, c]))
  const sided = (n: string, side: Side): string | null => {
    const cands = side === 'R' ? [n] : [n.replace(/_r$/, '_l'), `${n}_l`, `${n}_left`]
    return cands.map((c) => `${c}_tendon`).find((c) => tendon.has(c) && (side === 'R' || c !== `${n}_tendon`)) ?? null
  }
  const coordName = (ref: string, side: Side): string => {
    if (side === 'R' || ['flex_extension', 'lat_bending', 'axial_rotation'].includes(ref)) return ref
    const [base, cond] = ref.split('@') as [string, string | undefined]
    const l = base.endsWith('_r') ? base.replace(/_r$/, '_l') : `${base}_l`
    return cond ? `${l}@${cond}` : l
  }
  const trunkGain: Record<string, number> = {}
  for (const [k, v] of Object.entries(dump.trunk)) trunkGain[k] = v.thoraxVsSacrumDeg[v.anglesDeg.length - 1]! / Math.abs(v.anglesDeg[v.anglesDeg.length - 1]!)
  const model: RefModel = {
    key: 'myo',
    trunkGain,
    names(patterns, side) {
      const out: string[] = []
      for (const p of patterns) {
        if (p.includes('*')) {
          const re = new RegExp(`^${p.replace(/[.]/g, '\\.').replace('*', '.*')}_tendon$`)
          for (const t of dump.tendons) if (re.test(t.name)) {
            const s = side === 'R' ? t.name : t.name.replace(/_r_tendon$/, '_l_tendon')
            if (tendon.has(s)) out.push(s)
          }
        } else {
          const s = sided(p, side)
          if (s) out.push(s)
        }
      }
      return out
    },
    coordName,
    range(coord) {
      const j = joint.get(coord.split('@')[0]!)
      return j ? j.rangeDeg : null
    },
    delta(names, coord, angles) {
      let any = false
      const out = angles.map(() => 0)
      for (const n of names) {
        const c = curve.get(`${n}|${coord}`)
        if (!c) continue
        any = true
        const l0 = interp(c.anglesDeg, c.lengthMm, angles[0]!)
        angles.forEach((a, i) => (out[i] = out[i]! + (interp(c.anglesDeg, c.lengthMm, a) - l0) / names.length))
      }
      return any ? out : null
    },
    centre(what, side) {
      const n = MYO_CENTRE[what]
      const j = n ? joint.get(side === 'R' ? n : n.replace(/_r(_r)?$/, (m) => m.replace(/r/g, 'l'))) : undefined
      return j ? myoCanon(j.anchor) : null
    },
  }
  return { model, dump }
}

const OSIM_CENTRE: Record<string, string> = { hip: 'femur_r', knee: 'tibia_r', ankle: 'talus_r', mtp: 'toes_r', gh: 'humerus_r', elbow: 'ulna_r', wrist: 'hand_r' }

const xmlText = (n: XmlNode, tag: string): string => (n.children.find((c) => c.tag === tag)?.text ?? '').trim()
function* walk(n: XmlNode): Generator<XmlNode> {
  yield n
  for (const c of n.children) yield* walk(c)
}

/** .osim 里各坐标的范围（度）、是否锁定 / range (degrees) and locked flag of every coordinate in an .osim. */
export function osimCoordinates(src: string): Map<string, { rangeDeg: [number, number]; locked: boolean }> {
  const out = new Map<string, { rangeDeg: [number, number]; locked: boolean }>()
  for (const n of walk(parseXml(src))) {
    if (n.tag !== 'Coordinate' || !n.name) continue
    const r = xmlText(n, 'range').split(/\s+/).map(Number)
    if (r.length === 2) out.set(n.name, { rangeDeg: [deg(r[0]!), deg(r[1]!)], locked: xmlText(n, 'locked') === 'true' })
  }
  return out
}

export function loadOsim(): { model: RefModel; osim: OsimModel; coords: Map<string, { rangeDeg: [number, number]; locked: boolean }> } {
  const src = readFileSync(OSIM_FILE, 'utf8')
  const osim = new OsimModel(src)
  const coords = osimCoordinates(src)
  // 线性的坐标耦合（髌骨随膝）：tools/rig/opensim.ts 不处理约束，这里把从动坐标补进 q
  // linear coordinate couplers (patella with the knee): tools/rig/opensim.ts does not handle constraints, so the dependent coordinate is added to q here
  const couplers: { dep: string; indep: string; k: number; b: number }[] = []
  for (const n of walk(parseXml(src))) {
    if (n.tag !== 'CoordinateCouplerConstraint') continue
    const lin = [...walk(n)].find((c) => c.tag === 'LinearFunction')
    const co = lin ? xmlText(lin, 'coefficients').split(/\s+/).map(Number) : null
    if (co) couplers.push({ dep: xmlText(n, 'dependent_coordinate_name'), indep: xmlText(n, 'independent_coordinate_names'), k: co[0] ?? 1, b: co[1] ?? 0 })
  }
  const q = (coord: string, degrees: number): Record<string, number> => {
    const out: Record<string, number> = { [coord]: rad(degrees) }
    for (const c of couplers) if (c.indep === coord) out[c.dep] = c.k * rad(degrees) + c.b
    return out
  }
  const side = (n: string, s: Side): string => (s === 'R' ? n : n.replace(/_r$/, '_l'))
  const rest = osim.bodyTransforms({})
  const model: RefModel = {
    key: 'opensim',
    names: (patterns, s) => patterns.filter((p) => !p.includes('*')).map((p) => side(p, s)).filter((p) => osim.muscles.has(p)),
    coordName: (ref, s) => side(ref, s),
    range: (coord) => coords.get(coord)?.rangeDeg ?? null,
    delta(names, coord, angles) {
      if (!coords.has(coord)) return null
      const out = angles.map(() => 0)
      for (const n of names) {
        const l0 = osim.length(n, q(coord, angles[0]!))
        angles.forEach((a, i) => (out[i] = out[i]! + (1000 * (osim.length(n, q(coord, a)) - l0)) / names.length))
      }
      return Math.max(...out) - Math.min(...out) < 0.2 ? null : out
    },
    centre(what, s) {
      const b = OSIM_CENTRE[what]
      const xf = b ? rest.get(side(b, s)) : undefined
      return xf ? osimCanon(xf.t as V3) : null
    },
  }
  return { model, osim, coords }
}

// ── 我们的关节中心 / our joint centres ───────────────────────────────────────────────────────

const OUR_CENTRE: Record<string, string> = { hip: 'hip_R', knee: 'knee_R', ankle: 'ankle_R', mtp: 'mtp2_R', gh: 'gh_R', elbow: 'elbow_R', wrist: 'wrist_R', mcp3: 'mcp3_R', pip3: 'pip3_R', l5s1: 'L5', sc: 'sc_R' }
const ourCentre = (o: Ours, what: string, side: Side): V3 | null => {
  const id = OUR_CENTRE[what]!
  const j = o.joint.get(side === 'R' ? id : id.replace(/_R$/, '_L'))
  return j ? (j.center as V3) : null
}

type Centre = (what: string, side: Side) => V3 | null
const segLen = (c: Centre, a: string, b: string, side: Side): number | null => {
  const p = c(a, side), q = c(b, side)
  return p && q ? dist(p, q) : null
}
/** 用来把参照缩放到我们身材的长度（米）/ the length used to scale the reference to our body, metres. */
function groupLength(c: Centre, group: CoordDef['group'], side: Side): number | null {
  const sum = (...pairs: [string, string][]): number | null => {
    let s = 0
    for (const [a, b] of pairs) {
      const l = segLen(c, a, b, side)
      if (l === null) return null
      s += l
    }
    return s
  }
  if (group === 'leg') return sum(['hip', 'knee'], ['knee', 'ankle'])
  if (group === 'arm') return sum(['gh', 'elbow'], ['elbow', 'wrist'])
  if (group === 'hand') return sum(['wrist', 'mcp3'], ['mcp3', 'pip3'])
  const a = c('l5s1', 'R'), b = c('sc', 'R')
  return a && b ? Math.abs(b[1] - a[1]) : null
}

// ── 力臂与长度变化 / moment arms and excursions ──────────────────────────────────────────────

export interface CurveRow {
  body: BodyId
  side: Side
  muscle: string
  parts: string[]
  reference: string[]
  movement: string
  refCoordinate: string
  ourCoordinate: string
  /** 扫过的范围：我们的解剖学角度（度），是我们的范围与参照范围的交集 / the sweep in our anatomical angle (degrees): our range ∩ the reference's. */
  sweepDeg: [number, number]
  /** 参照的长度按这个比例缩放到我们的节段长度 / the reference lengths were scaled by this ratio to our segment lengths. */
  scale: number
  /** 平均力臂（毫米）：正 = 该运动使肌肉缩短 / mean moment arm (mm): positive = the movement shortens the muscle. */
  refArmMm: number
  ourArmMm: number
  ourLineArmMm: number | null
  diffMm: number
  toleranceMm: number
  /** 两条长度变化曲线的相关系数 / correlation of the two length-change curves. */
  shapeR: number
  verdict: Verdict
  /** 不在容差内时的类型 / the kind of disagreement when outside. */
  kind?: 'opposite sign' | 'too small' | 'too large'
  note?: string
}

const N = 9
const corr = (x: number[], y: number[]): number => {
  const mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < x.length; i++) (sxy += (x[i]! - mx) * (y[i]! - my)), (sxx += (x[i]! - mx) ** 2), (syy += (y[i]! - my) ** 2)
  return sxx > 1e-9 && syy > 1e-9 ? sxy / Math.sqrt(sxx * syy) : 0
}

/** 容差：max(8 mm, 参照力臂的 35%) / tolerance: max(8 mm, 35 % of the reference arm). */
export const armTolerance = (refArm: number): number => Math.max(8, 0.35 * Math.abs(refArm))

export function judgeArm(ours: number, ref: number): { verdict: Verdict; kind?: CurveRow['kind'] } {
  const tol = armTolerance(ref)
  if (Math.abs(ours - ref) <= tol) return { verdict: 'within' }
  if (ours * ref < 0) return { verdict: 'outside', kind: 'opposite sign' }
  return { verdict: 'outside', kind: Math.abs(ours) < Math.abs(ref) ? 'too small' : 'too large' }
}

function curveRows(o: Ours, ref: RefModel): CurveRow[] {
  const rows: CurveRow[] = []
  for (const side of ['R', 'L'] as Side[]) {
    for (const [nameR, patterns] of MUSCLE_MAP) {
      const name = side === 'R' ? nameR : toLeftName(nameR)
      const parts = o.byName.get(name)?.filter((p) => p.tissue === 'muscle' && o.body.meshes.has(p.id)) ?? []
      const refNames = ref.names(patterns, side)
      if (!parts.length || !refNames.length) continue
      for (const cd of COORDS) {
        const coord = ref.coordName(cd.ref, side)
        const refRange = ref.range(coord)
        const ours = side === 'R' ? cd.ours : toLeftCoord(cd.ours)
        const ourRange = coordRange(o, ours)
        if (!refRange || !ourRange) continue
        const gain = cd.group === 'trunk' && ref.trunkGain ? Math.sign(cd.gain) * (ref.trunkGain[cd.ref] ?? 1) : cd.gain
        const mapped = [refRange[0] * gain, refRange[1] * gain].sort((a, b) => a - b)
        const lo = Math.max(ourRange[0], mapped[0]!), hi = Math.min(ourRange[1], mapped[1]!)
        if (hi - lo < 10) continue
        const angles = Array.from({ length: N }, (_, i) => lo + ((hi - lo) * i) / (N - 1))
        const refDelta = ref.delta(refNames, coord, angles.map((a) => a / gain))
        if (!refDelta) continue
        const rc = (w: string, s: Side): V3 | null => ref.centre(w, s)
        const lOurs = groupLength((w, s) => ourCentre(o, w, s), cd.group, side), lRef = groupLength(rc, cd.group, side) ?? groupLength(rc, cd.group, 'R')
        const scale = lOurs && lRef ? lOurs / lRef : 1
        const mine = muscleCurve(o, parts, angles.map((a) => coordPose(o, ours, a)))
        const span = rad(hi - lo)
        const arm = (l: number[]): number => -(l[N - 1]! - l[0]!) / span
        const refArm = arm(refDelta) * scale, ourArm = arm(mine.mesh)
        // 参照里几乎不随该坐标变化、我们这边也是：不列 / negligible in the reference and in ours: not listed
        if (Math.abs(refArm) < 2 && Math.abs(ourArm) < 2) continue
        const j = judgeArm(ourArm, refArm)
        rows.push({
          body: o.id, side, muscle: name, parts: parts.map((p) => p.id), reference: refNames.map((n) => n.replace(/_tendon$/, '')), movement: cd.movement,
          refCoordinate: coord, ourCoordinate: coordLabel(ours), sweepDeg: [r1(lo), r1(hi)], scale: r3(scale),
          refArmMm: r1(refArm), ourArmMm: r1(ourArm), ourLineArmMm: mine.line ? r1(arm(mine.line)) : null,
          diffMm: r1(ourArm - refArm), toleranceMm: r1(armTolerance(refArm)), shapeR: r2(corr(refDelta, mine.mesh.map((x) => x - mine.mesh[0]!))), ...j,
        })
      }
    }
  }
  return rows
}

const ARM_METHOD: Bilingual = {
  zh: '对每一对（肌肉，坐标）：其余关节在解剖学零位，把该坐标在“我们的活动范围 ∩ 参照的范围”内分 9 点扫过，两边各得一条长度—角度曲线。平均力臂 = −(末长 − 初长) / 扫过的弧度，正值表示这个运动使肌肉缩短。我们的长度取变形后肌肉网格的中心线（14 段质心连线，带作用线的肌肉以作用线两端收尾），ourLineArmMm 是只用作用线（起止点直线）得到的值。参照的长度按节段长度之比缩放到我们的身材（下肢：股骨+胫骨；上肢：肱骨+前臂；手：腕到 MCP3 到 PIP3；躯干：L5/S1 到胸锁关节的高度）。多个肌束的参照取平均。上臂抬高用胸肱角（含肩带节律），腰部运动按范围分到五个腰椎关节，参照的躯干主坐标先换算成胸廓相对骶骨的实际转角。',
  en: 'For every (muscle, coordinate) pair: with the other joints at the anatomical zero, the coordinate is swept in 9 steps over the intersection of our range of motion and the reference range, giving one length-versus-angle curve on each side. Mean moment arm = −(final length − initial length) / swept angle in radians; positive means the movement shortens the muscle. Our length is the centreline of the deformed muscle mesh (centroids of 14 slices, closed by the ends of the line of action where the rig has one); ourLineArmMm is the value from the line of action alone (straight, origin to insertion). Reference lengths are scaled to our body by a ratio of segment lengths (leg: femur + tibia; arm: humerus + forearm; hand: wrist to MCP3 to PIP3; trunk: height from L5/S1 to the sternoclavicular joint). The reference value is the mean over fascicles. Arm elevation is thoracohumeral (girdle rhythm included); lumbar movements are spread over our five lumbar joints by their ranges, and the reference trunk master coordinate is first converted into the actual rotation of the thorax against the sacrum.',
}
const ARM_TOLERANCE: Bilingual = {
  zh: '|我们 − 参照| ≤ max(8 mm, 参照力臂的 35%) 记为 within。这个容差是本项目定的：参照本身是由少数标本和 MRI 做成的通用模型，不是人群分布；8 mm 约为网格中心线法的分辨率。超出时再分：符号相反（opposite sign）、偏小（too small）、偏大（too large）。',
  en: '|ours − reference| ≤ max(8 mm, 35 % of the reference arm) counts as within. The tolerance is this project\'s choice: the reference is itself a generic model built from a few specimens and MRI, not a population distribution, and 8 mm is about the resolution of the mesh-centreline method. Outside it the row is classed as opposite sign, too small or too large.',
}

function curveSummary(rows: CurveRow[]): Record<string, number | string> {
  return {
    rows: rows.length, within: count(rows, (r) => r.verdict === 'within'), outside: count(rows, (r) => r.verdict === 'outside'),
    oppositeSign: count(rows, (r) => r.kind === 'opposite sign'), tooSmall: count(rows, (r) => r.kind === 'too small'), tooLarge: count(rows, (r) => r.kind === 'too large'),
    male: count(rows, (r) => r.body === 'male'), female: count(rows, (r) => r.body === 'female'),
    musclesCompared: new Set(rows.map((r) => r.muscle.replace(/\bLeft\b/, 'Right').replace(/\bleft\b/, 'right'))).size,
  }
}

// ── 附着点 / attachment sites ────────────────────────────────────────────────────────────────

type Segment = 'pelvis' | 'thigh' | 'shank' | 'foot' | 'girdle' | 'upperarm' | 'forearm' | 'hand' | 'trunk'

export function ourSegment(joint: string): Segment {
  if (/^(pelvis|si_)/.test(joint)) return 'pelvis'
  if (/^(hip|patella)_/.test(joint)) return 'thigh'
  if (/^knee_/.test(joint)) return 'shank'
  if (/^(ankle|subtalar|mtp|tip|tpip|tdip)/.test(joint)) return 'foot'
  if (/^(sc|ac)_/.test(joint)) return 'girdle'
  if (/^gh_/.test(joint)) return 'upperarm'
  if (/^(elbow|radioulnar)_/.test(joint)) return 'forearm'
  if (/^(wrist|cmc|mcp|pip|dip|ip)\d?_/.test(joint)) return 'hand'
  return 'trunk'
}
export function myoSegment(body: string): Segment {
  if (/^(pelvis|sacrum)/.test(body)) return 'pelvis'
  if (/^(femur|patella)/.test(body)) return 'thigh'
  if (/^tibia/.test(body)) return 'shank'
  if (/^(talus|calcn|toes)/.test(body)) return 'foot'
  if (/^(clav|scap)/.test(body)) return 'girdle'
  if (/^hum/.test(body)) return 'upperarm'
  if (/^(ulna|radius)/.test(body)) return 'forearm'
  if (/^(lumbar|torso|Abdomen|chest|head|neck|cervical|Arm_attachment|Full Body|world)/.test(body)) return 'trunk'
  return 'hand'
}

const LONG: Partial<Record<Segment, [string, string]>> = { thigh: ['hip', 'knee'], shank: ['knee', 'ankle'], foot: ['ankle', 'mtp'], upperarm: ['gh', 'elbow'], forearm: ['elbow', 'wrist'], hand: ['wrist', 'mcp3'] }

/** 点在节段坐标里的归一化位置。长节段：[沿轴的分数, 离轴距离/长度]；其余：以节段原点为原点、按特征长度归一化的三维坐标。 A point's normalised position in a segment. Long segments: [fraction along the axis, radial distance / length]; others: 3D offset from the segment origin over its characteristic length. */
function segCoords(c: Centre, seg: Segment, side: Side, p: V3): { coords: number[]; scale: number } | null {
  const ends = LONG[seg]
  if (ends) {
    const a = c(ends[0], side), b = c(ends[1], side)
    if (!a || !b) return null
    const L = dist(a, b), u = norm(sub(b, a)), d = sub(p, a)
    const t = dot(d, u)
    return { coords: [t / L, len(sub(d, mul(u, t))) / L], scale: L }
  }
  let origin: V3 | null, scale: number | null
  if (seg === 'pelvis') {
    const r = c('hip', 'R'), l = c('hip', 'L')
    origin = r && l ? mul(add(r, l), 0.5) : null
    scale = r && l ? dist(r, l) : null
  } else if (seg === 'girdle') {
    origin = c('gh', side)
    scale = segLen(c, 'gh', 'elbow', side)
  } else {
    origin = c('l5s1', 'R')
    scale = groupLength(c, 'trunk', 'R')
  }
  if (!origin || !scale) return null
  const d = sub(p, origin)
  return { coords: [d[0] / scale, d[1] / scale, d[2] / scale], scale }
}

export interface AttachmentRow {
  body: BodyId
  side: Side
  muscle: string
  part: string
  reference: string[]
  end: 'origin' | 'insertion'
  ourJoint: string
  ourSegment: Segment
  refSegment: Segment
  /** 归一化坐标（见 method）/ normalised coordinates (see method). */
  ours: number[] | null
  ref: number[] | null
  /** 换算到我们身材的距离（毫米）/ the distance at our body size, mm. */
  diffMm: number | null
  toleranceMm: number
  verdict: Verdict
  note?: string
}

const ATTACH_TOL = 25

function attachmentRows(o: Ours, dump: MyoDump, ref: RefModel): AttachmentRow[] {
  const rows: AttachmentRow[] = []
  const tendon = new Map(dump.tendons.map((t) => [t.name, t]))
  const oc: Centre = (w, s) => ourCentre(o, w, s), rc: Centre = (w, s) => ref.centre(w, s)
  for (const side of ['R', 'L'] as Side[]) {
    for (const [nameR, patterns] of MUSCLE_MAP) {
      const name = side === 'R' ? nameR : toLeftName(nameR)
      const refNames = ref.names(patterns, side)
      if (!refNames.length) continue
      for (const part of o.byName.get(name) ?? []) {
        const line = o.lineOf.get(part.id)
        if (!line) continue
        // 参照里肌腱的走向可能与我们相反（MyoArm 的肩部肌肉从肱骨一端写起）：两端所在节段对调后才吻合时，把参照的两端对调
        // a reference tendon may run the other way (MyoArm writes its shoulder muscles from the humeral end): when the segments only match after swapping, the reference ends are swapped
        const major = (e: 'origin' | 'insertion'): Segment => {
          const sg = refNames.map((n) => myoSegment(tendon.get(n)![e].body))
          return [...new Set(sg)].sort((x, y) => count(sg, (v) => v === y) - count(sg, (v) => v === x))[0]!
        }
        const oS = ourSegment(line.origin.joint), iS = ourSegment(line.insertion.joint)
        const swapped = !(major('origin') === oS && major('insertion') === iS) && major('origin') === iS && major('insertion') === oS && oS !== iS
        for (const end of ['origin', 'insertion'] as const) {
          const ourSeg = ourSegment(line[end].joint)
          // 参照：各肌束该端所在节段取多数，位置取平均 / reference: the majority segment of the fascicles' ends, positions averaged
          const refEnd = swapped ? (end === 'origin' ? 'insertion' : 'origin') : end
          const ends = refNames.map((n) => tendon.get(n)![refEnd])
          const segs = ends.map((e) => myoSegment(e.body))
          const refSeg = major(refEnd)
          const base = { body: o.id, side, muscle: name, part: part.id, reference: refNames.map((n) => n.replace(/_tendon$/, '')), end, ourJoint: line[end].joint, ourSegment: ourSeg, refSegment: refSeg, toleranceMm: ATTACH_TOL }
          if (ourSeg !== refSeg) {
            rows.push({ ...base, ours: null, ref: null, diffMm: null, verdict: 'not comparable', note: 'the end rides a different segment in the two models' })
            continue
          }
          const mine = segCoords(oc, ourSeg, side, line[end].point as V3)
          const same = ends.filter((_, i) => segs[i] === refSeg).map((e) => segCoords(rc, refSeg, side, myoCanon(e.pos)))
          if (!mine || same.some((s) => !s)) {
            rows.push({ ...base, ours: null, ref: null, diffMm: null, verdict: 'not comparable', note: 'segment frame not available in one model' })
            continue
          }
          const refC = mine.coords.map((_, k) => same.reduce((s, x) => s + x!.coords[k]!, 0) / same.length)
          const d = Math.hypot(...mine.coords.map((v, k) => v - refC[k]!)) * mine.scale * 1000
          rows.push({ ...base, ours: mine.coords.map(r3), ref: refC.map(r3), diffMm: r1(d), verdict: d <= ATTACH_TOL ? 'within' : 'outside', ...(swapped ? { note: 'reference tendon runs the other way; its ends were swapped' } : {}) })
        }
      }
    }
  }
  return rows
}

// ── 节段比例与关节轴 / segment proportions and joint axes ─────────────────────────────────────

export interface ProportionRow {
  body: BodyId
  quantity: string
  reference: 'opensim' | 'myo'
  ours: number
  ref: number
  /** 相对差（比例）或角度差（度）/ relative difference (ratios) or difference in degrees (angles). */
  diff: number
  unit: 'ratio' | 'deg'
  tolerance: number
  verdict: Verdict
  mapping: string
}

const RATIOS: [string, [string, string], [string, string]][] = [
  ['tibia / femur (knee→ankle over hip→knee)', ['knee', 'ankle'], ['hip', 'knee']],
  ['humerus / femur (GH→elbow over hip→knee)', ['gh', 'elbow'], ['hip', 'knee']],
  ['forearm / humerus (elbow→wrist over GH→elbow)', ['elbow', 'wrist'], ['gh', 'elbow']],
  ['foot / tibia (ankle→MTP over knee→ankle)', ['ankle', 'mtp'], ['knee', 'ankle']],
  ['metacarpus / forearm (wrist→MCP3 over elbow→wrist)', ['wrist', 'mcp3'], ['elbow', 'wrist']],
  ['proximal phalanx 3 / metacarpus (MCP3→PIP3 over wrist→MCP3)', ['mcp3', 'pip3'], ['wrist', 'mcp3']],
]
const AXES: [string, string, number, [string, string], string][] = [
  ['knee flexion axis vs femur axis', 'knee_R', 0, ['hip', 'knee'], 'knee_angle_r'],
  ['ankle axis vs tibia axis', 'ankle_R', 0, ['knee', 'ankle'], 'ankle_angle_r'],
  ['subtalar axis vs tibia axis', 'subtalar_R', 0, ['knee', 'ankle'], 'subtalar_angle_r'],
  ['elbow flexion axis vs humerus axis', 'elbow_R', 0, ['gh', 'elbow'], 'elbow_flexion_r'],
  ['elbow flexion axis vs forearm axis', 'elbow_R', 0, ['elbow', 'wrist'], 'elbow_flexion_r'],
  ['forearm rotation axis vs forearm axis', 'radioulnar_R', 2, ['elbow', 'wrist'], 'pro_sup_r'],
  ['wrist flexion axis vs forearm axis', 'wrist_R', 0, ['elbow', 'wrist'], 'flexion_r'],
]
const acute = (a: V3, b: V3): number => deg(Math.acos(Math.min(1, Math.abs(dot(norm(a), norm(b))))))

function proportionRows(o: Ours, refs: { model: RefModel; dump?: MyoDump }[]): ProportionRow[] {
  const rows: ProportionRow[] = []
  const oc: Centre = (w, s) => ourCentre(o, w, s)
  for (const { model, dump } of refs) {
    const rc: Centre = (w, s) => model.centre(w, s)
    const ratio = (c: Centre, num: [string, string], den: [string, string], s: Side): number | null => {
      const a = segLen(c, num[0], num[1], s), b = segLen(c, den[0], den[1], s)
      return a && b ? a / b : null
    }
    const push = (quantity: string, ours: number | null, ref: number | null, unit: 'ratio' | 'deg', mapping: string): void => {
      if (ours === null || ref === null) return
      const diff = unit === 'ratio' ? ours / ref - 1 : ours - ref
      const tolerance = unit === 'ratio' ? 0.1 : 10
      rows.push({ body: o.id, quantity, reference: model.key, ours: r3(ours), ref: r3(ref), diff: unit === 'ratio' ? r3(diff) : r1(diff), unit, tolerance, verdict: Math.abs(diff) <= tolerance ? 'within' : 'outside', mapping })
    }
    for (const side of ['R', 'L'] as Side[]) {
      for (const [q, num, den] of RATIOS) push(`${q}, ${side}`, ratio(oc, num, den, side), ratio(rc, num, den, side) ?? ratio(rc, num, den, 'R'), 'ratio', `joint centres ${[...num, ...den].map((w) => OUR_CENTRE[w]).join(', ')} ↔ ${model.key === 'myo' ? [...num, ...den].map((w) => MYO_CENTRE[w]).join(', ') : [...num, ...den].map((w) => OSIM_CENTRE[w]).join(', ')}`)
    }
    const hw = (c: Centre): number | null => {
      const r = c('hip', 'R'), l = c('hip', 'L'), f = segLen(c, 'hip', 'knee', 'R')
      return r && l && f ? dist(r, l) / f : null
    }
    push('inter-hip distance / femur', hw(oc), hw(rc), 'ratio', 'hip_R, hip_L, knee_R')
    const sw = (c: Centre): number | null => {
      const r = c('gh', 'R'), l = c('gh', 'L'), f = segLen(c, 'gh', 'elbow', 'R')
      return r && l && f ? dist(r, l) / f : null
    }
    push('inter-glenohumeral distance / humerus', sw(oc), sw(rc), 'ratio', 'gh_R, gh_L, elbow_R')
    if (!dump) continue
    // 关节轴与节段长轴的夹角（只有 MuJoCo 的导出里有世界系的轴）/ angle between joint axis and segment long axis (only the MuJoCo dump has world-frame axes)
    const mj = new Map(dump.joints.map((j) => [j.name, j]))
    for (const side of ['R', 'L'] as Side[]) {
      for (const [q, joint, axis, seg, refJoint] of AXES) {
        const j = o.joint.get(side === 'R' ? joint : joint.replace(/_R$/, '_L'))
        const a = oc(seg[0], side), b = oc(seg[1], side)
        const rj = mj.get(side === 'R' ? refJoint : refJoint.replace(/_r$/, '_l')) ?? mj.get(refJoint)
        const ra = rc(seg[0], side) ?? rc(seg[0], 'R'), rb = rc(seg[1], side) ?? rc(seg[1], 'R')
        if (!j || !a || !b || !rj || !ra || !rb) continue
        push(`${q}, ${side}`, acute(j.axes[axis] as V3, sub(b, a)), acute(myoCanon(rj.axis), sub(rb, ra)), 'deg', `${j.id}.axes[${axis}] ↔ ${rj.name}`)
      }
    }
  }
  return rows
}

// ── 活动范围 / range of motion ───────────────────────────────────────────────────────────────

export interface RomRow {
  entry: string
  direction: 'positive' | 'negative'
  movement: string
  /** rom.json 的值（度）及其来源、状态 / the value in rom.json (degrees), its source and status. */
  ours: number
  ourSource: string
  ourStatus: string
  reference: 'opensim' | 'myo'
  refCoordinate: string
  ref: number
  diffDeg: number
  toleranceDeg: 10
  verdict: Verdict
  note?: string
}

/** rom.json 的条目 ↔ 参照坐标；sign = 条目的正方向对应参照的正（+1）还是负（−1）方向。 rom.json entry ↔ reference coordinate; sign says whether the entry's positive direction is the reference's positive (+1) or negative (−1). */
export const ROM_MAP: { entry: string; myo?: string; osim?: string; sign: number; names: [string, string]; note?: string }[] = [
  { entry: 'hip.flexion', myo: 'hip_flexion_r', osim: 'hip_flexion_r', sign: 1, names: ['hip flexion', 'hip extension'] },
  { entry: 'hip.abduction', myo: 'hip_adduction_r', osim: 'hip_adduction_r', sign: -1, names: ['hip abduction', 'hip adduction'] },
  { entry: 'hip.rotation', myo: 'hip_rotation_r', osim: 'hip_rotation_r', sign: 1, names: ['hip internal rotation', 'hip external rotation'] },
  { entry: 'knee.flexion', myo: 'knee_angle_r', osim: 'knee_angle_r', sign: 1, names: ['knee flexion', 'knee extension'] },
  { entry: 'ankle.dorsiflexion', myo: 'ankle_angle_r', osim: 'ankle_angle_r', sign: 1, names: ['ankle dorsiflexion', 'ankle plantar flexion'] },
  { entry: 'subtalar.inversion', myo: 'subtalar_angle_r', osim: 'subtalar_angle_r', sign: 1, names: ['subtalar inversion', 'subtalar eversion'] },
  { entry: 'shoulder.abduction', myo: 'shoulder_elv_r', osim: 'arm_add_r', sign: 1, names: ['shoulder abduction', 'shoulder adduction'], note: 'MyoArm: shoulder_elv is elevation in any plane, 0…180°, no adduction past neutral. OpenSim arm_add: positive = adduction, so its sign is reversed.' },
  { entry: 'shoulder.flexion', osim: 'arm_flex_r', sign: 1, names: ['shoulder flexion', 'shoulder extension'] },
  { entry: 'shoulder.rotation', myo: 'shoulder_rot_r', osim: 'arm_rot_r', sign: 1, names: ['shoulder internal rotation', 'shoulder external rotation'] },
  { entry: 'elbow.flexion', myo: 'elbow_flexion_r', osim: 'elbow_flex_r', sign: 1, names: ['elbow flexion', 'elbow extension'] },
  { entry: 'forearm.pronation', myo: 'pro_sup_r', osim: 'pro_sup_r', sign: 1, names: ['forearm pronation', 'forearm supination'], note: 'OpenSim pro_sup runs 0…90° from full supination, not from the neutral forearm: not comparable per direction; only its total span is.' },
  { entry: 'wrist.flexion', myo: 'flexion_r', osim: 'wrist_flex_r', sign: 1, names: ['wrist flexion', 'wrist extension'] },
  { entry: 'wrist.ulnarDeviation', myo: 'deviation_r', osim: 'wrist_dev_r', sign: -1, names: ['wrist ulnar deviation', 'wrist radial deviation'], note: 'Sign of the reference deviation coordinate checked in MyoArm (extensor carpi ulnaris lengthens with positive values); assumed the same for OpenSim wrist_dev.' },
  { entry: 'thumb.mcp.flexion', myo: 'mp_flexion_r', sign: -1, names: ['thumb MCP flexion', 'thumb MCP extension'] },
  { entry: 'thumb.ip.flexion', myo: 'ip_flexion_r', sign: -1, names: ['thumb IP flexion', 'thumb IP extension'] },
  { entry: 'finger.mcp.flexion', myo: 'mcp2_flexion_r', sign: 1, names: ['finger MCP flexion', 'finger MCP extension'] },
  { entry: 'finger.mcp.deviation', myo: 'mcp2_abduction_r', sign: -1, names: ['finger MCP ulnar deviation', 'finger MCP radial deviation'] },
  { entry: 'finger.pip.flexion', myo: 'pm2_flexion_r', sign: 1, names: ['finger PIP flexion', 'finger PIP extension'] },
  { entry: 'finger.dip.flexion', myo: 'md2_flexion_r', sign: 1, names: ['finger DIP flexion', 'finger DIP extension'] },
  { entry: 'hallux.mtp.extension', myo: 'mtp_angle_r', osim: 'mtp_angle_r', sign: -1, names: ['toe MTP extension', 'toe MTP flexion'], note: 'The references have one joint for all toes.' },
]

interface RomFile {
  entries: Record<string, { positive: number; negative: number; source: string; status: string }>
}

function romRows(dump: MyoDump | null, osim: Map<string, { rangeDeg: [number, number]; locked: boolean }> | null): RomRow[] {
  const rom = JSON.parse(readFileSync(join(ROOT, 'data', 'curated', 'rig', 'rom.json'), 'utf8')) as RomFile
  const rows: RomRow[] = []
  const mj = dump ? new Map(dump.joints.map((j) => [j.name, j.rangeDeg])) : null
  const add1 = (m: (typeof ROM_MAP)[number], reference: 'opensim' | 'myo', coord: string, range: [number, number], extra?: string): void => {
    const e = rom.entries[m.entry]
    if (!e) return
    // osim 的 arm_add：正 = 内收 / OpenSim arm_add: positive = adduction
    const sign = reference === 'opensim' && coord === 'arm_add_r' ? -1 : m.sign
    const pos = sign > 0 ? range[1] : -range[0], neg = sign > 0 ? -range[0] : range[1]
    const skip = reference === 'opensim' && coord === 'pro_sup_r'
    for (const [direction, ours, ref, movement] of [['positive', e.positive, pos, m.names[0]], ['negative', e.negative, neg, m.names[1]]] as const) {
      const d = ours - ref
      rows.push({ entry: m.entry, direction, movement, ours, ourSource: e.source, ourStatus: e.status, reference, refCoordinate: coord, ref: r1(ref), diffDeg: r1(d), toleranceDeg: 10, verdict: skip ? 'not comparable' : Math.abs(d) <= 10 ? 'within' : 'outside', note: [m.note, extra].filter(Boolean).join(' ') || undefined })
    }
  }
  for (const m of ROM_MAP) {
    if (mj && m.myo && mj.has(m.myo)) add1(m, 'myo', m.myo, mj.get(m.myo)!)
    if (osim && m.osim && osim.has(m.osim)) add1(m, 'opensim', m.osim, osim.get(m.osim)!.rangeDeg, osim.get(m.osim)!.locked ? 'Locked by default in the OpenSim model; the range is still declared.' : undefined)
  }
  // 腰部：我们五个腰椎关节范围之和 vs 参照里胸廓相对骶骨的总转角 / lumbar: the sum of our five lumbar joints vs the reference's total thorax-versus-sacrum rotation
  if (dump) {
    for (const [k, axisName, coord, sign, names] of [['flexion', 'flexion', 'flex_extension', -1, ['lumbar flexion (L1–S1 total)', 'lumbar extension (L1–S1 total)']], ['lateral', 'lateral', 'lat_bending', -1, ['lumbar bending left (total)', 'lumbar bending right (total)']], ['rotation', 'rotation', 'axial_rotation', 1, ['lumbar rotation left (total)', 'lumbar rotation right (total)']]] as const) {
      const lv = ['L5-S1', 'L4-L5', 'L3-L4', 'L2-L3', 'L1-L2'].map((l) => rom.entries[`spine.${l}.${axisName}`]).filter(Boolean)
      const t = dump.trunk[coord]
      if (lv.length !== 5 || !t) continue
      const refPos = sign > 0 ? t.thoraxVsSacrumDeg[t.anglesDeg.length - 1]! : t.thoraxVsSacrumDeg[0]!, refNeg = sign > 0 ? t.thoraxVsSacrumDeg[0]! : t.thoraxVsSacrumDeg[t.anglesDeg.length - 1]!
      for (const [direction, ours, ref, movement] of [['positive', lv.reduce((s, e) => s + e!.positive, 0), refPos, names[0]], ['negative', lv.reduce((s, e) => s + e!.negative, 0), refNeg, names[1]]] as const) {
        const d = ours - ref
        rows.push({ entry: `spine.L1…S1.${k} (sum of five)`, direction, movement, ours: r1(ours), ourSource: 'cheng / none', ourStatus: 'mixed', reference: 'myo', refCoordinate: `${coord} (thorax vs sacrum at the end of its range, couplings included)`, ref: r1(ref), diffDeg: r1(d), toleranceDeg: 10, verdict: Math.abs(d) <= 10 ? 'within' : 'outside', note: 'MyoTorso limits are those of a simulation model (the master coordinate range times its couplings), not a measured range of motion.' })
      }
    }
  }
  return rows
}

// ── 量具自检 / instrument check ──────────────────────────────────────────────────────────────

interface CheckRow {
  muscle: string
  coordinate: string
  sweepDeg: [number, number]
  opensimPathPointsArmMm: number
  myoMujocoArmMm: number
  diffMm: number
}

function instrumentRows(osim: RefModel, myo: RefModel): CheckRow[] {
  const rows: CheckRow[] = []
  for (const [, patterns] of MUSCLE_MAP) {
    const a = osim.names(patterns, 'R'), b = myo.names(patterns, 'R')
    if (!a.length || !b.length) continue
    for (const cd of COORDS.filter((c) => c.group === 'leg')) {
      const ra = osim.range(cd.ref), rb = myo.range(cd.ref)
      if (!ra || !rb) continue
      const lo = Math.max(ra[0], rb[0]), hi = Math.min(ra[1], rb[1])
      const angles = Array.from({ length: N }, (_, i) => lo + ((hi - lo) * i) / (N - 1))
      const da = osim.delta(a, cd.ref, angles), db = myo.delta(b, cd.ref, angles)
      if (!da || !db) continue
      const arm = (l: number[]): number => -(l[N - 1]! - l[0]!) / rad(hi - lo)
      rows.push({ muscle: a.join('+'), coordinate: cd.ref, sweepDeg: [r1(lo), r1(hi)], opensimPathPointsArmMm: r1(arm(da)), myoMujocoArmMm: r1(arm(db)), diffMm: r1(arm(da) - arm(db)) })
    }
  }
  return rows
}

/** 供测试用：重算一副身体对一个参照的力臂表（需要 data/raw/calibration 下的参照）。 For tests: recomputes the moment-arm rows of one body against one reference (needs the reference under data/raw/calibration). */
export async function computeCurveRows(body: BodyId, ref: 'opensim' | 'myo'): Promise<CurveRow[]> {
  return curveRows(await loadOurs(body), ref === 'myo' ? loadMyo().model : loadOsim().model)
}

// ── 入口 / entry ─────────────────────────────────────────────────────────────────────────────

export const skeletalAvailable = (): { osim: boolean; myo: boolean } => ({ osim: existsSync(OSIM_FILE), myo: existsSync(MYO_DUMP) })

const SCOPE_NOTE: Bilingual = {
  zh: '参照是“量具”不是真值：两个模型都是由少数尸体标本和 MRI 做成的通用成年人模型，肌肉是带途经点和缠绕面的折线。MyoLeg 源自 Rajagopal 模型、MyoArm 源自 MoBL 上肢模型、MyoTorso 源自 SimTK 的腰椎模型，所以下肢的两张表并不独立。我们这一侧，变形后网格的中心线会低估绕过关节的肌肉的长度变化（蒙皮把肌肉沿骨拉伸，不绕行）；表里的差别首先说明“这块肌肉的形状随关节变化得不像参照”，不一定是附着点错了。',
  en: 'The references are instruments, not ground truth: both are generic adult models built from a few cadaver specimens and MRI, with muscles as polylines through via points and over wrap surfaces. MyoLeg derives from the Rajagopal model, MyoArm from the MoBL upper-extremity model and MyoTorso from the SimTK lumbar spine model, so the two leg tables are not independent. On our side, the centreline of a skinned mesh under-reads the length change of a muscle that wraps round a joint (skinning stretches the muscle along the bone and does not wrap); a disagreement first says that the muscle\'s shape does not follow the joint as the reference does, not necessarily that an attachment is wrong.',
}

export async function runSkeletal(log: (m: string) => void): Promise<void> {
  const have = skeletalAvailable()
  if (!have.osim && !have.myo) {
    log('skeletal: no reference under data/raw/calibration (run tools/calibrate/fetch.ts and myo_dump.py); tables left as they are')
    return
  }
  const ours = await Promise.all(BODIES.map(loadOurs))
  const ourState = Object.fromEntries(ours.map((o) => [o.id, o.state]))
  const osim = have.osim ? loadOsim() : null, myo = have.myo ? loadMyo() : null
  const myoRef = { ...refInfo(REFS.myosim), version: `${REFS.myosim.version}; evaluated with the PyPI package myo-sim ${myo?.dump.myoSim ?? '?'} (model "myofullbody": ${myo?.dump.counts.joints ?? '?'} joints, ${myo?.dump.counts.actuators ?? '?'} muscle actuators) in MuJoCo ${myo?.dump.mujoco ?? '?'}` }
  if (osim) {
    const rows = ours.flatMap((o) => curveRows(o, osim.model))
    rows.sort((a, b) => Math.abs(b.diffMm) / b.toleranceMm - Math.abs(a.diffMm) / a.toleranceMm)
    writeTable<CurveRow>({
      schema: 1, id: 'muscle-curves-opensim', title: { zh: '肌肉力臂：我们的模型 vs OpenSim 全身模型（Rajagopal 2016）', en: 'Muscle moment arms: our model vs the OpenSim full-body model (Rajagopal 2016)' },
      method: ARM_METHOD, tolerance: ARM_TOLERANCE, references: [refInfo(REFS.rajagopal)], ourState,
      notes: [SCOPE_NOTE, { zh: '参照的长度由 .osim 的路径点直接算（tools/rig/opensim.ts），没有运行 OpenSim：圆柱缠绕按“无限长圆柱、只缠切入最深的一段”近似，不处理象限限制。这个近似的误差见 instrument-check.json。该模型只有下肢肌肉（每侧 40 条），上肢和躯干是力矩驱动的。', en: 'Reference lengths are computed straight from the path points of the .osim (tools/rig/opensim.ts) without running OpenSim: cylinder wraps are approximated (infinite cylinder, only the most deeply cut segment wraps, no quadrant constraint). The error of that approximation is in instrument-check.json. The model has leg muscles only (40 a side); its arms and trunk are torque-driven.' }],
      summary: curveSummary(rows), rows,
    })
    log(`muscle-curves-opensim: ${rows.length} rows`)
  }
  if (myo) {
    const rows = ours.flatMap((o) => curveRows(o, myo.model))
    rows.sort((a, b) => Math.abs(b.diffMm) / b.toleranceMm - Math.abs(a.diffMm) / a.toleranceMm)
    writeTable<CurveRow>({
      schema: 1, id: 'muscle-curves-myo', title: { zh: '肌肉力臂：我们的模型 vs MyoFullBody（MuJoCo）', en: 'Muscle moment arms: our model vs MyoFullBody (MuJoCo)' },
      method: ARM_METHOD, tolerance: ARM_TOLERANCE, references: [myoRef], ourState,
      notes: [SCOPE_NOTE, { zh: '参照的长度由 MuJoCo 求值（tools/calibrate/myo_dump.py）：逐个独立关节扫过它的范围，从动关节按模型里的等式约束（多项式耦合）跟随，缠绕由 MuJoCo 计算。', en: 'Reference lengths are evaluated by MuJoCo (tools/calibrate/myo_dump.py): each independent joint is swept over its range, dependent joints follow the model\'s equality constraints (polynomial couplings), and wrapping is computed by MuJoCo.' }],
      summary: curveSummary(rows), rows,
    })
    log(`muscle-curves-myo: ${rows.length} rows`)
    const att = ours.flatMap((o) => attachmentRows(o, myo.dump, myo.model))
    att.sort((a, b) => (b.diffMm ?? -1) - (a.diffMm ?? -1))
    writeTable<AttachmentRow>({
      schema: 1, id: 'muscle-attachments-myo', title: { zh: '肌肉附着点：作用线两端 vs MyoFullBody 肌腱两端', en: 'Muscle attachment sites: ends of our lines of action vs the tendon ends of MyoFullBody' },
      method: {
        zh: '只比带作用线的肌肉。每一端先看它随哪个节段运动（我们：作用线端点绑定的关节；参照：肌腱第一个/最后一个 site 所在的骨）；节段不同记为 not comparable。节段相同时，把点换成节段内的归一化坐标再比：长节段（大腿、小腿、足、上臂、前臂、手）用 [沿近端关节中心→远端关节中心的分数, 离轴距离/节段长度]（不含绕轴的方位角）；骨盆用以两髋中点为原点、按两髋间距归一化的三维坐标；肩带以盂肱关节中心为原点、按肱骨长度归一化；躯干以 L5/S1 为原点、按 L5/S1 到胸锁关节的高度归一化。差值乘以我们的节段长度得到毫米。参照的多个肌束取该端位置的平均。',
        en: 'Only muscles with a line of action. For each end, first the segment it moves with (ours: the joint the end is bound to; reference: the body of the first / last tendon site); different segments give "not comparable". On the same segment the point is expressed in normalised segment coordinates: for long segments (thigh, shank, foot, upper arm, forearm, hand) [fraction along proximal→distal joint centre, radial distance / segment length] (the azimuth about the axis is not compared); for the pelvis a 3D offset from the mid-point of the hips over the inter-hip distance; for the shoulder girdle from the glenohumeral centre over the humerus length; for the trunk from L5/S1 over the height from L5/S1 to the sternoclavicular joint. The difference times our segment length gives millimetres. Several reference fascicles are averaged at that end.',
      },
      tolerance: { zh: '25 mm。附着区本身有几厘米宽，参照的端点是“等效点”，我们的端点是附着区的质心；这个数是本项目定的。', en: '25 mm. Attachment areas are centimetres wide, the reference ends are effective points and ours are centroids of an attachment area; the figure is this project\'s choice.' },
      references: [myoRef], ourState, notes: [SCOPE_NOTE],
      summary: { rows: att.length, within: count(att, (r) => r.verdict === 'within'), outside: count(att, (r) => r.verdict === 'outside'), notComparable: count(att, (r) => r.verdict === 'not comparable') },
      rows: att,
    })
    log(`muscle-attachments-myo: ${att.length} rows`)
  }
  const refs = [...(osim ? [{ model: osim.model }] : []), ...(myo ? [{ model: myo.model, dump: myo.dump }] : [])]
  const prop = ours.flatMap((o) => proportionRows(o, refs))
  writeTable<ProportionRow>({
    schema: 1, id: 'segments', title: { zh: '节段比例与关节轴', en: 'Segment proportions and joint axes' },
    method: { zh: '节段长度取相邻关节中心的距离，只比长度之比（两个模型的身高不同）。关节轴比的是“轴与节段长轴的锐角”，这个量不依赖两个模型各自的坐标系和静止姿势。', en: 'Segment lengths are distances between neighbouring joint centres, and only ratios of lengths are compared (the models differ in stature). For joint axes the acute angle between the axis and the segment\'s long axis is compared, a quantity independent of either model\'s frame and rest pose.' },
    tolerance: { zh: '比例：相对差 ≤ 10%；角度：≤ 10°。本项目定的；人群中节段比例的变异系数约 4–6%（未打开出处，属回忆）。', en: 'Ratios: relative difference ≤ 10 %; angles: ≤ 10°. This project\'s choice; the coefficient of variation of segment proportions in a population is roughly 4–6 % (a recollection, no source opened).' },
    references: [...(osim ? [refInfo(REFS.rajagopal)] : []), ...(myo ? [myoRef] : [])], ourState,
    notes: [{ zh: 'MyoFullBody 的左臂是右臂的镜像，所以左侧的行不是独立的参照。我们的 mtp 取第 2 跖趾关节，参照只有一个趾关节。', en: 'MyoFullBody\'s left arm is a mirror of its right, so the left-side rows are not independent references. Our "mtp" is the second metatarsophalangeal joint; the references have a single toe joint.' }],
    summary: { rows: prop.length, within: count(prop, (r) => r.verdict === 'within'), outside: count(prop, (r) => r.verdict === 'outside') }, rows: prop,
  })
  log(`segments: ${prop.length} rows`)
  const rom = romRows(myo?.dump ?? null, osim?.coords ?? null)
  writeTable<RomRow>({
    schema: 1, id: 'rom', title: { zh: '活动范围：rom.json vs 两个模型的关节限位', en: 'Range of motion: rom.json vs the joint limits of the two models' },
    method: { zh: '逐个条目、逐个方向，把 data/curated/rig/rom.json 的数与参照坐标的上下限并排（都自解剖学零位起算）。参照坐标的正方向由 MuJoCo 里一块主动肌是否缩短核对过。', en: 'Entry by entry and direction by direction, the number in data/curated/rig/rom.json beside the limit of the reference coordinate (both from the anatomical zero). The positive direction of each reference coordinate was checked by whether an agonist shortens in MuJoCo.' },
    tolerance: { zh: '相差超过 10° 记为 outside（任务给定）。注意：模型的关节限位是为仿真设的，不是测得的正常活动范围；rom.json 里 sourced 的条目有测量来源，出现分歧时应先信 rom.json。', en: 'A difference above 10° is "outside" (as specified for this task). Note that a model\'s joint limits are set for simulation and are not measured normal ranges; where they disagree with a `sourced` entry of rom.json, rom.json has the measurement behind it.' },
    references: [...(osim ? [refInfo(REFS.rajagopal)] : []), ...(myo ? [myoRef] : [])], ourState: {},
    notes: [{ zh: '没有比的条目：骨盆朝向、髌骨、膝旋转、胸锁/肩锁关节（MyoArm 里它们是肩抬高的从动关节，没有独立范围）、拇指腕掌关节（两个模型的轴定义不同）、足趾趾间关节、颞下颌关节、颈椎和胸椎各节、肋骨：两个参照里没有对应的独立坐标。', en: 'Entries not compared: pelvis orientation, patella, knee rotation, sternoclavicular and acromioclavicular joints (dependent on shoulder elevation in MyoArm, with no range of their own), thumb carpometacarpal joint (the axes are defined differently), toe interphalangeal joints, temporomandibular joint, cervical and thoracic levels, ribs: neither reference has a matching independent coordinate.' }],
    summary: { rows: rom.length, within: count(rom, (r) => r.verdict === 'within'), outside: count(rom, (r) => r.verdict === 'outside'), notComparable: count(rom, (r) => r.verdict === 'not comparable') }, rows: rom,
  })
  log(`rom: ${rom.length} rows`)
  if (osim && myo) {
    const chk = instrumentRows(osim.model, myo.model)
    chk.sort((a, b) => Math.abs(b.diffMm) - Math.abs(a.diffMm))
    const abs = chk.map((r) => Math.abs(r.diffMm)).sort((a, b) => a - b)
    writeTable<CheckRow>({
      schema: 1, id: 'instrument-check', title: { zh: '量具自检：同一族模型的两种求值', en: 'Instrument check: one model family evaluated two ways' },
      method: { zh: 'MyoLeg 是由 Rajagopal 模型转换来的。这里对右下肢每条肌肉、每个坐标，比较“由 .osim 路径点近似算出的平均力臂”和“MuJoCo 对 MyoLeg 求出的平均力臂”。差别来自三处：我们对 OpenSim 缠绕的近似、MyoLeg 转换时的手工改动（它的说明里列了去掉和改换的缠绕面）、以及膝关节耦合的多项式近似。它给出“量具”本身的误差量级。', en: 'MyoLeg was converted from the Rajagopal model. For every right-leg muscle and coordinate this compares the mean moment arm computed approximately from the .osim path points with the one MuJoCo gives for MyoLeg. The differences have three origins: our approximation of OpenSim wrapping, the manual changes made in the MyoLeg conversion (its README lists the wrap surfaces removed or replaced), and the polynomial approximation of the knee coupling. It gives the size of the instrument\'s own error.' },
      tolerance: { zh: '不作判定；用来读其余各表。', en: 'No verdict; it is for reading the other tables.' },
      references: [refInfo(REFS.rajagopal), myoRef], ourState: {}, notes: [],
      summary: { rows: chk.length, medianAbsDiffMm: abs[abs.length >> 1] ?? 0, p90AbsDiffMm: abs[Math.floor(abs.length * 0.9)] ?? 0, maxAbsDiffMm: abs[abs.length - 1] ?? 0 }, rows: chk,
    })
    log(`instrument-check: ${chk.length} rows`)
  }
}
