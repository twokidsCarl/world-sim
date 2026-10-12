// 疼痛输入模型：刺激 → 皮肤顶点 → 皮节和皮神经 → 传导 → 强度时间过程、退缩反射、自主体征、体表图和解释数据。
// The pain input model: stimulus → skin vertex → dermatome and cutaneous nerve → conduction →
// intensity time course, withdrawal reflex, autonomic signs, skin map and explanation data.
//
// 这是疼痛生理与行为的计算模型，用于教学：被模拟的身体没有主观体验。所有参数在
// data/curated/pain/，每个数字都注明出处或标为假设。纯函数、确定性、不依赖 DOM。
// This is a computational model of pain physiology and behaviour for teaching: the simulated
// body has no subjective experience. Every parameter lives in data/curated/pain/, each number
// with its source or flagged as an assumption. Pure, deterministic, no DOM.

import type { Joint, Vec3 } from '../anatomy/types.ts'
import { buildNerveIndex, nervePath, type NerveIndex } from './path.ts'
import { AUTONOMIC, AUTONOMIC_SIGNS, NOCICEPTION, REFLEX, REGIONS, siteThreshold, sourceIds, sourcesById, type AutonomicSignId, type Quantity, type SiteThreshold } from './tables.ts'
import type {
  AutonomicState,
  Bilingual,
  PainBody,
  PainMap,
  PainResult,
  PainSample,
  PainSkinMap,
  PainTrace,
  ReflexResult,
  ReflexTarget,
  SideLR,
  SkinRegionHit,
  Stimulus,
  TraceNumber,
  TraceStep,
} from './types.ts'

/** 体表图里“未分配”的区域值 / The "unassigned" region value of a skin map. */
const UNASSIGNED = 255
/** 自主体征的采样间隔，秒 / Sampling step of the autonomic signs, seconds. */
const GRID_DT = 0.02
/** 画接触区的最小半径，米（显示用，不是生理参数）/ Smallest radius drawn for the contact area, metres (a display value, not physiology). */
const MIN_DRAW_RADIUS = 0.005
/** 热、冷刺激没给面积时画的半径，米（显示用）/ Radius drawn for heat and cold without an area, metres (display). */
const THERMAL_DRAW_RADIUS = 0.015

export const DISCLAIMER: Bilingual = {
  zh: '这是疼痛生理与行为的计算模型，用于教学：被模拟的身体没有主观体验。数值来自健康成人的群体平均或是本项目的假设，不能用于临床判断。',
  en: 'A computational model of pain physiology and behaviour for teaching: the simulated body has no subjective experience. The numbers are group averages of healthy adults or assumptions of this project and are not for clinical use.',
}

interface BodyIndex {
  nerve: NerveIndex
  partName: Map<string, string>
  dermatome: PainSkinMap
  territory: PainSkinMap
  jointById: Map<string, Joint>
}

const bodyIndex = new WeakMap<PainBody, BodyIndex>()

function indexOf(body: PainBody): BodyIndex {
  let ix = bodyIndex.get(body)
  if (ix) return ix
  const dermatome = body.skinMaps.maps.find((m) => m.id === 'dermatome')
  const territory = body.skinMaps.maps.find((m) => m.id === 'cutaneousNerve')
  if (!dermatome || !territory) throw new Error('painmodel: 缺少皮节图或皮神经分布区图 / the dermatome or the cutaneous nerve map is missing')
  if (dermatome.regions.length !== body.innervation.dermatomes.length || territory.regions.length !== body.innervation.cutaneous.length) {
    throw new Error('painmodel: 体表图与 innervation 表的区域数不一致，两者需要一起重新生成 / skin maps and innervation table disagree on region counts; regenerate them together')
  }
  if (body.skin.positions.length !== body.skinMaps.vertexCount * 3) {
    throw new Error(`painmodel: 皮肤顶点数 ${body.skin.positions.length / 3} 与体表图的 ${body.skinMaps.vertexCount} 不一致 / skin vertex count does not match the skin maps`)
  }
  ix = {
    nerve: buildNerveIndex(body.nerves, body.parts),
    partName: new Map(body.parts.map((p) => [p.id, p.name])),
    dermatome,
    territory,
    jointById: new Map((body.joints ?? []).map((j) => [j.id, j])),
  }
  bodyIndex.set(body, ix)
  return ix
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

/** 身体的左侧在 +X / The body's left is at +X. */
export function sideOf(position: Vec3): SideLR {
  return position[0] >= 0 ? 'L' : 'R'
}

/**
 * 离某点最近的皮肤顶点；accept 用来只在满足条件的顶点中找。
 * The skin vertex nearest a point; `accept` restricts the search.
 */
export function nearestSkinVertex(positions: ArrayLike<number>, p: Vec3, accept?: (vertex: number) => boolean): number {
  let best = -1
  let bd = Infinity
  const n = Math.floor(positions.length / 3)
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3]! - p[0]
    const dy = positions[i * 3 + 1]! - p[1]
    const dz = positions[i * 3 + 2]! - p[2]
    const d = dx * dx + dy * dy + dz * dz
    if (d < bd && (!accept || accept(i))) {
      bd = d
      best = i
    }
  }
  return best
}

function pointSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
  const len2 = ab[0]! * ab[0]! + ab[1]! * ab[1]! + ab[2]! * ab[2]!
  const t = len2 > 0 ? clamp((ap[0]! * ab[0]! + ap[1]! * ab[1]! + ap[2]! * ab[2]!) / len2, 0, 1) : 0
  return Math.hypot(ap[0]! - ab[0]! * t, ap[1]! - ab[1]! * t, ap[2]! - ab[2]! * t)
}

/** 离某点最近的骨段所属的关节 / The joint whose segment (centre → tail) lies nearest a point. */
function nearestJoint(joints: readonly Joint[], p: Vec3): Joint | null {
  let best: Joint | null = null
  let bd = Infinity
  for (const j of joints) {
    const d = pointSegment(p, j.center, j.tail ?? j.center)
    if (d < bd) {
      bd = d
      best = j
    }
  }
  return best
}

interface Located {
  vertex: number
  position: Vec3
  side: SideLR
  dermatome: SkinRegionHit | null
  territory: SkinRegionHit | null
  region: string
}

function hit(map: PainSkinMap, region: number, key: string): SkinRegionHit {
  return { map: map.id, region, key, name: map.regions[region]!.name }
}

/**
 * 刺激点 → 皮肤顶点、侧别、皮节、皮神经分布区、部位。顶点未分配区域时取同侧最近的已分配顶点。
 * Stimulus point → skin vertex, side, dermatome, cutaneous territory, region. A vertex without
 * a region takes that of the nearest assigned vertex of the same side.
 */
export function locate(body: PainBody, stimulus: Stimulus): Located {
  const ix = indexOf(body)
  const pos = body.skin.positions
  const p = stimulus.site.position
  const n = body.skinMaps.vertexCount
  let vertex = stimulus.site.vertex
  if (vertex === undefined || !Number.isInteger(vertex) || vertex < 0 || vertex >= n) vertex = nearestSkinVertex(pos, p)
  const vp: Vec3 = [pos[vertex * 3]!, pos[vertex * 3 + 1]!, pos[vertex * 3 + 2]!]
  const side = sideOf(Math.abs(p[0]) > 1e-6 ? p : vp)
  const sameSide = (v: number) => (pos[v * 3]! >= 0) === (side === 'L')
  const regionAt = (map: PainSkinMap): number => {
    const r = map.data[vertex!] ?? UNASSIGNED
    if (r !== UNASSIGNED) return r
    const v = nearestSkinVertex(pos, vp, (i) => (map.data[i] ?? UNASSIGNED) !== UNASSIGNED && sameSide(i))
    return v < 0 ? UNASSIGNED : map.data[v]!
  }
  const d = regionAt(ix.dermatome)
  const t = regionAt(ix.territory)
  const dermatome = d === UNASSIGNED ? null : hit(ix.dermatome, d, body.innervation.dermatomes[d]!.dermatome)
  const territory = t === UNASSIGNED ? null : hit(ix.territory, t, body.innervation.cutaneous[t]!.territory)
  let region = (territory && REGIONS.territoryRegion[territory.key]) ?? 'chest'
  for (const rule of REGIONS.refinements) {
    if (rule.region !== region) continue
    if (rule.whenDermatome && dermatome && rule.whenDermatome.includes(dermatome.key)) region = rule.use
    else if (rule.whenNearestJoint && body.joints?.length) {
      const j = nearestJoint(body.joints, vp)
      if (j && new RegExp(rule.whenNearestJoint).test(j.id)) region = rule.use
    }
  }
  return { vertex, position: vp, side, dermatome, territory, region }
}

interface Drive {
  magnitude: number
  unit: string
  threshold: SiteThreshold
  /** 阈值上乘的系数及其来源 / Multiplier applied to the threshold, with its origin. */
  factor: { value: number; quantity: { assumption?: boolean; note?: Bilingual } } | null
  drive: number
}

function need(x: number | undefined, what: string, kind: string): number {
  if (x === undefined || !Number.isFinite(x)) throw new Error(`painmodel: ${kind} 刺激需要 ${what} / a ${kind} stimulus needs ${what}`)
  return x
}

/**
 * 刺激–反应函数：物理量和部位 → 强度 0–10（阈值以下为 0）。
 * The stimulus-response function: physical magnitude and site → intensity 0–10 (0 below threshold).
 */
export function stimulusDrive(stimulus: Stimulus, region: string, sex: 'male' | 'female'): Drive {
  const m = NOCICEPTION.modalities[stimulus.kind]
  const max = NOCICEPTION.scale.max.value
  const gain = m.response.gain.value
  const exponent = m.response.exponent?.value ?? 1
  if (stimulus.kind === 'pinprick') {
    const force = need(stimulus.forceN, 'forceN', 'pinprick') * 1000
    const f = REGIONS.thresholds.pinprick.factors
    const factor = f.map[region] ?? 1
    const base = m.threshold!
    const threshold: SiteThreshold = { value: base.value * factor, unit: m.unit, site: region, borrowed: false, quantity: base, borrowNote: null }
    const drive = force > threshold.value ? gain * Math.log2(force / threshold.value) : 0
    return { magnitude: force, unit: m.unit, threshold, factor: { value: factor, quantity: f }, drive: clamp(drive, 0, max) }
  }
  if (stimulus.kind === 'pressure' || stimulus.kind === 'pinch') {
    const force = need(stimulus.forceN, 'forceN', stimulus.kind)
    const area = stimulus.areaMm2 ?? m.defaultAreaMm2?.value ?? NOCICEPTION.modalities.pressure.probe!.areaMm2!.value
    if (!(area > 0)) throw new Error('painmodel: 接触面积必须为正 / the contact area must be positive')
    // N / mm² = MPa；× 1000 = kPa
    const pressure = (force / area) * 1000
    const site = siteThreshold(REGIONS.thresholds.pressure, region, sex)
    const factor = m.thresholdFactor ? { value: m.thresholdFactor.value, quantity: m.thresholdFactor } : null
    const threshold = { ...site, value: site.value * (factor?.value ?? 1) }
    const drive = pressure > threshold.value ? gain * Math.pow(pressure / threshold.value - 1, exponent) : 0
    return { magnitude: pressure, unit: m.unit, threshold, factor, drive: clamp(drive, 0, max) }
  }
  const temperature = need(stimulus.temperatureC, 'temperatureC', stimulus.kind)
  const threshold = siteThreshold(REGIONS.thresholds[stimulus.kind], region, sex)
  const over = stimulus.kind === 'heat' ? temperature - threshold.value : threshold.value - temperature
  const drive = over > 0 ? gain * Math.pow(over, exponent) : 0
  return { magnitude: temperature, unit: m.unit, threshold, factor: null, drive: clamp(drive, 0, max) }
}

interface Pulse {
  start: number
  duration: number
  drive: number
}

function pulses(stimulus: Stimulus, drive: number, region: string): { list: Pulse[]; summation: number } {
  const t0 = stimulus.onset ?? 0
  const duration = Math.max(0, stimulus.duration)
  const count = Math.max(1, Math.floor(stimulus.repeat?.count ?? 1))
  const hz = stimulus.repeat?.hz ?? 0
  const ts = NOCICEPTION.temporal.temporalSummation
  const sums = count > 1 && hz >= ts.minHz.value && drive > 0
  const gain = region === 'hand' || region === 'fingertip' ? ts.gain.hand.value : ts.gain.other.value
  const list: Pulse[] = []
  let summation = 0
  for (let k = 0; k < count; k++) {
    // 时间总和：逐次增加，约 plateauStimuli 次后到平台 / temporal summation: grows per stimulus up to a plateau
    const add = sums ? gain * Math.min(1, k / Math.max(1, ts.plateauStimuli.value - 1)) : 0
    summation = Math.max(summation, add)
    list.push({ start: t0 + (count > 1 && hz > 0 ? k / hz : 0), duration, drive: Math.min(NOCICEPTION.scale.max.value, drive + add) })
  }
  return { list, summation }
}

/** 快成分的适应水平（1 → adaptTo）/ Adaptation level of the fast component (1 → adaptTo). */
function adaptLevel(x: number): number {
  const p = NOCICEPTION.temporal.firstPain
  return p.adaptTo.value + (1 - p.adaptTo.value) * Math.exp(-Math.max(0, x) / p.adaptTime.value)
}

/** 快成分的形状（0–1）：快升、适应、刺激结束后消退 / Shape of the fast component (0–1): quick rise, adaptation, decay after the stimulus. */
function fastShape(tau: number, d: number): number {
  if (tau < 0) return 0
  const p = NOCICEPTION.temporal.firstPain
  const at = (x: number) => (1 - Math.exp(-x / p.rise.value)) * adaptLevel(x)
  return tau <= d ? at(tau) : at(d) * Math.exp(-(tau - d) / p.decay.value)
}

/** 慢成分的形状（0–1）/ Shape of the slow component (0–1). */
function slowShape(tau: number, d: number): number {
  if (tau < 0) return 0
  const p = NOCICEPTION.temporal.secondPain
  const at = (x: number) => 1 - Math.exp(-x / p.rise.value)
  return tau <= d ? at(tau) : at(d) * Math.exp(-(tau - d) / p.decay.value)
}

/**
 * 一次刺激在时刻 t 的两个成分（占该次强度的比例）。慢成分补上快成分因适应而让出的部分，
 * 所以持续刺激时两者之和趋于 1，任何时刻都不超过 1。
 * The two components of one application at time t (as fractions of its intensity). The slow
 * component takes over what the fast one gives up by adapting, so under a sustained stimulus
 * the sum tends to 1 and never exceeds it.
 */
function pulseShape(t: number, start: number, d: number, share: number, firstAt: number, secondAt: number): { first: number; second: number } {
  const tauA = t - start - firstAt
  const first = share * fastShape(tauA, d)
  const second = (1 - share * adaptLevel(Math.min(tauA, d))) * slowShape(t - start - secondAt, d)
  return { first, second }
}

function num(label: Bilingual, q: Quantity<number | [number, number]>, value: number | [number, number] = q.value, unit: string = q.unit ?? ''): TraceNumber {
  return { label, value, unit, sources: sourceIds(q), assumption: q.assumption === true, ...(q.note ? { note: q.note } : {}) }
}

function computed(label: Bilingual, value: number, unit: string, note?: Bilingual): TraceNumber {
  return { label, value, unit, sources: [], assumption: false, computed: true, ...(note ? { note } : {}) }
}

export interface PainEvaluation {
  readonly stimulus: Stimulus
  /** 刺激–反应函数给出的强度 0–10 / Intensity 0–10 from the stimulus-response function. */
  readonly drive: number
  /** 强度时间过程的峰值及其时刻 / Peak of the intensity time course and when it occurs. */
  readonly peak: { intensity: number; t: number }
  /** 最后一次刺激结束的时刻，秒 / When the last application ends, seconds. */
  readonly stimulusEnd: number
  /** 此后各输出都已回到基线附近，秒 / After this every output is back near baseline, seconds. */
  readonly horizon: number
  readonly reflex: ReflexResult
  readonly trace: PainTrace
  readonly map: PainMap
  /**
   * 给现有输出端（src/pain/controller.ts）的建议：强度和起病方式。
   * Suggestion for the existing output side (src/pain/controller.ts): level and onset.
   */
  readonly output: { level: number; onset: 'sudden' | 'sustained'; startAt: number }
  /** 时刻 t 的数值（强度、反射姿势、自主体征）/ The numbers at time t (intensity, reflex pose, autonomic signs). */
  sample(t: number): PainSample
  /** 时刻 t 的全部输出 / Everything at time t. */
  at(t: number): PainResult
}

/**
 * 准备一次刺激的全部计算；之后可在任意时刻取值。同样的输入给出同样的输出。
 * Prepare everything for one stimulus; values can then be read at any time. The same input
 * always gives the same output.
 */
export function prepareStimulus(body: PainBody, stimulus: Stimulus): PainEvaluation {
  const ix = indexOf(body)
  const loc = locate(body, stimulus)
  const modality = NOCICEPTION.modalities[stimulus.kind]
  const d = stimulusDrive(stimulus, loc.region, body.body)
  const regionDef = REGIONS.regions[loc.region]!
  const derm = loc.dermatome ? body.innervation.dermatomes[loc.dermatome.region]! : null
  const terr = loc.territory ? body.innervation.cutaneous[loc.territory.region]! : null

  // ---- 外周通路 / peripheral pathway
  const terminal = terr?.nerveParts[loc.side] ?? []
  const chainParts = terr ? terr.chain.flatMap((c) => c.parts[loc.side] ?? []) : []
  // 前根是运动根，不属于感觉通路 / the anterior root is motor and not part of the sensory pathway
  const roots = (derm ? derm.parts[loc.side] : []).filter((r) => !/anterior root/i.test(r.name))
  const sensory = sensoryRoots(roots.length ? roots : (terr?.rootParts[loc.side] ?? []).map((id) => ({ id, name: ix.partName.get(id) ?? id })))
  const path = nervePath(ix.nerve, loc.position, terminal, [...chainParts, ...sensory.chain], sensory.end)
  const vA = NOCICEPTION.fibres.Adelta.velocity.value
  const vC = NOCICEPTION.fibres.C.velocity.value
  const central = NOCICEPTION.temporal.centralDelay.value
  const latency = { adelta: path.lengthM / vA, c: path.lengthM / vC, firstPain: path.lengthM / vA + central, secondPain: path.lengthM / vC + central }

  // ---- 强度的时间过程 / intensity time course
  const { list, summation } = pulses(stimulus, d.drive, loc.region)
  const t0 = stimulus.onset ?? 0
  const stimulusEnd = list[list.length - 1]!.start + list[list.length - 1]!.duration
  const wA = modality.firstPainShare.value
  const max = NOCICEPTION.scale.max.value
  // 重复刺激时取总强度最大的那一次；时间总和已经体现在逐次增加的强度里
  // with repeated applications the one with the largest total counts; temporal summation is already in the growing drive
  const components = (t: number): { first: number; second: number; intensity: number } => {
    let first = 0
    let second = 0
    for (const p of list) {
      if (p.drive <= 0) continue
      const s = pulseShape(t, p.start, p.duration, wA, latency.firstPain, latency.secondPain)
      if (p.drive * (s.first + s.second) > first + second) {
        first = p.drive * s.first
        second = p.drive * s.second
      }
    }
    return { first, second, intensity: Math.min(max, first + second) }
  }

  // ---- 退缩反射 / withdrawal reflex
  const reflex = decideReflex(body, ix, loc, d.drive, path.lengthM, path.end, t0, stimulusEnd, terr?.territory ?? null)
  const poseAt = (t: number): Record<string, number[]> => {
    const out: Record<string, number[]> = {}
    if (!reflex.withdraws || reflex.movementLatency === null || reflex.releaseAt === null) return out
    const start = t0 + reflex.movementLatency
    if (t <= start) return out
    const rise = (x: number) => 1 - Math.exp(-(x - start) / REFLEX.pose.rise.value)
    const env = t <= reflex.releaseAt ? rise(t) : rise(reflex.releaseAt) * Math.exp(-(t - reflex.releaseAt) / REFLEX.pose.release.value)
    if (env < 1e-4) return out
    for (const target of reflex.targets) {
      const joint = ix.jointById.get(target.joint)!
      const a = (out[target.joint] ??= joint.dofs.map(() => 0))
      a[target.dof] = clamp(target.angle * env, target.min, target.max)
    }
    return out
  }

  // ---- 自主体征：对强度做一阶滤波 / autonomic signs: first-order filters of the intensity
  const slowest = Math.max(...AUTONOMIC_SIGNS.map((id) => AUTONOMIC.signs[id].fall.value + AUTONOMIC.signs[id].latency.value))
  const horizon = stimulusEnd + latency.secondPain + 5 * slowest
  const steps = Math.ceil((horizon - t0) / GRID_DT) + 1
  const drive = new Float32Array(steps)
  let peak = { intensity: 0, t: t0 }
  for (let i = 0; i < steps; i++) {
    const t = t0 + i * GRID_DT
    const v = components(t).intensity
    drive[i] = v
    if (v > peak.intensity + 1e-9) peak = { intensity: v, t }
  }
  const filtered = {} as Record<AutonomicSignId, Float32Array>
  for (const id of AUTONOMIC_SIGNS) {
    const s = AUTONOMIC.signs[id]
    const lag = Math.round(s.latency.value / GRID_DT)
    const kUp = 1 - Math.exp(-GRID_DT / s.rise.value)
    const kDown = 1 - Math.exp(-GRID_DT / s.fall.value)
    const out = new Float32Array(steps)
    let x = 0
    for (let i = 0; i < steps; i++) {
      const u = i >= lag ? drive[i - lag]! : 0
      x += (u - x) * (u > x ? kUp : kDown)
      out[i] = x
    }
    filtered[id] = out
  }
  const signAt = (id: AutonomicSignId, t: number): number => {
    const s = AUTONOMIC.signs[id]
    const f = (t - t0) / GRID_DT
    let x = 0
    if (f > 0) {
      const a = filtered[id]
      const i = Math.min(steps - 1, Math.floor(f))
      const j = Math.min(steps - 1, i + 1)
      x = a[i]! + (a[j]! - a[i]!) * Math.min(1, f - i)
    }
    const k = x / s.referenceIntensity.value
    return s.mode === 'percent' ? s.baseline.value * (1 + (s.effect.value / 100) * k) : s.baseline.value + s.effect.value * k
  }
  const autonomicAt = (t: number): AutonomicState => ({
    heartRate: signAt('heartRate', t),
    systolic: signAt('systolic', t),
    diastolic: signAt('diastolic', t),
    respiratoryRate: signAt('respiratoryRate', t),
    pupil: signAt('pupil', t),
    skinConductance: signAt('skinConductance', t),
  })

  // ---- 体表图 / skin map
  const map = buildMap(body, stimulus, loc)

  // ---- 解释数据 / explanation data
  const nerves: { name: string; parts: string[] }[] = []
  if (terr) {
    if (terminal.length) nerves.push({ name: loc.territory!.name.en, parts: [...terminal] })
    for (const c of terr.chain) if (c.parts[loc.side]?.length) nerves.push({ name: c.name, parts: [...c.parts[loc.side]] })
  }
  const segments = derm?.segments ?? terr?.segments ?? []
  const trace = buildTrace({ body, stimulus, loc, d, modality, regionName: regionDef.name, nerves, roots, segments, territorySegments: terr?.segments ?? [], path, latency, reflex, summation, wA, peak })

  const sample = (t: number): PainSample => {
    const c = components(t)
    return { t, intensity: c.intensity, firstPain: c.first, secondPain: c.second, reflexPose: poseAt(t), autonomic: autonomicAt(t) }
  }
  const evaluation: PainEvaluation = {
    stimulus,
    drive: d.drive,
    peak,
    stimulusEnd,
    horizon,
    reflex,
    trace,
    map,
    output: { level: Math.round(peak.intensity * 10) / 10, onset: stimulusEnd - t0 >= 2 ? 'sustained' : 'sudden', startAt: t0 + latency.firstPain },
    sample,
    at: (t) => ({ ...sample(t), reflex, trace, map }),
  }
  return evaluation
}

/**
 * 皮节的部件里哪些是感觉通路的终点。脊神经：后根（没有则神经节）；前根是运动根，不走。
 * 颅神经（没有“根”部件）：最后列出的主干是终点，其余分支算作上级神经链。
 * Which of a dermatome's parts end the sensory path. Spinal nerves: the posterior root (else the
 * ganglion); the anterior root is motor and is left out. Cranial nerves (no "root" parts): the
 * trunk listed last is the end and the other divisions count as parent chain.
 */
function sensoryRoots(parts: readonly { id: string; name: string }[]): { chain: string[]; end: string[] } {
  const rootLike = parts.filter((p) => /root|ganglion/i.test(p.name) && !/anterior root/i.test(p.name))
  if (rootLike.length) {
    const posterior = rootLike.filter((p) => /posterior root/i.test(p.name))
    const end = posterior.length ? posterior : rootLike
    return { chain: rootLike.filter((p) => !end.includes(p)).map((p) => p.id), end: end.map((p) => p.id) }
  }
  const sensible = parts.filter((p) => !/anterior root/i.test(p.name))
  return sensible.length ? { chain: sensible.slice(0, -1).map((p) => p.id), end: [sensible[sensible.length - 1]!.id] } : { chain: [], end: [] }
}

const memo = new WeakMap<PainBody, WeakMap<Stimulus, PainEvaluation>>()

/**
 * evaluateStimulus(身体数据, 刺激, t) → 该时刻的强度、反射、自主体征，以及解释数据和体表图。
 * 同一个刺激对象的准备工作只做一次（刺激对象当作不可变的）。
 * evaluateStimulus(body data, stimulus, t) → intensity, reflex and autonomic signs at that time,
 * with the explanation data and the skin map. The preparation for one stimulus object is done
 * once (treat stimulus objects as immutable).
 */
export function evaluateStimulus(body: PainBody, stimulus: Stimulus, t: number): PainResult {
  let perBody = memo.get(body)
  if (!perBody) memo.set(body, (perBody = new WeakMap()))
  let e = perBody.get(stimulus)
  if (!e) perBody.set(stimulus, (e = prepareStimulus(body, stimulus)))
  return e.at(t)
}

function decideReflex(body: PainBody, ix: BodyIndex, loc: Located, drive: number, lengthM: number, rootEnd: Vec3, t0: number, stimulusEnd: number, territory: string | null): ReflexResult {
  const limb = REGIONS.regions[loc.region]!.limb
  const none = (reason: Bilingual): ReflexResult => ({ withdraws: false, reason, limb, side: loc.side, pattern: null, emgLatency: null, movementLatency: null, amplitude: 0, targets: [], releaseAt: null })
  if (!limb) return none({ zh: '刺激不在肢体上：本模型只模拟肢体的屈肌退缩，躯干和头部的躲避动作没有模拟。', en: 'The stimulus is not on a limb: only the flexor withdrawal of the limbs is modelled, not the recoil of trunk or head.' })
  const thr = REFLEX.threshold.value
  if (drive < thr) return none({ zh: `强度 ${drive.toFixed(1)} 低于退缩阈 ${thr}（假设值）。`, en: `Intensity ${drive.toFixed(1)} is below the withdrawal threshold of ${thr} (an assumed value).` })
  const pattern = REFLEX.patterns[limb]
  const max = NOCICEPTION.scale.max.value
  const amplitude = REFLEX.pose.minFraction.value + (1 - REFLEX.pose.minFraction.value) * clamp((drive - thr) / (max - thr), 0, 1)
  const id = (template: string) => template.replace('{S}', loc.side)
  const defs = pattern.targets.map((t) => ({ ...t }))
  let name = pattern.name
  for (const v of pattern.variants) {
    if (territory && v.whenTerritory.includes(territory)) {
      const k = defs.findIndex((t) => t.joint === v.replace.joint && t.dof === v.replace.dof)
      if (k >= 0) defs[k] = { ...v.replace }
      name = { zh: `${pattern.name.zh}；${v.name.zh}`, en: `${pattern.name.en}; ${v.name.en}` }
    }
  }
  const targets: ReflexTarget[] = []
  for (const def of defs) {
    const joint = ix.jointById.get(id(def.joint))
    if (!joint) continue
    const dof = joint.dofs.findIndex((x) => new RegExp(def.dof, 'i').test(x.name.en))
    if (dof < 0) continue
    targets.push({ joint: joint.id, dof, angle: ((def.degrees.value * Math.PI) / 180) * amplitude, min: joint.dofs[dof]!.min, max: joint.dofs[dof]!.max, movement: joint.dofs[dof]!.name })
  }
  // 传出：神经根到主要屈肌所跨关节的直线距离（近似）/ efferent: straight line from the root to the joint the main flexors cross (an approximation)
  const eff = ix.jointById.get(id(pattern.efferentJoint))
  const efferentM = eff ? Math.hypot(eff.center[0] - rootEnd[0], eff.center[1] - rootEnd[1], eff.center[2] - rootEnd[2]) : lengthM / 2
  const emgLatency = lengthM / NOCICEPTION.fibres.Adelta.velocity.value + REFLEX.spinalDelay.value + efferentM / REFLEX.motorVelocity.value
  const movementLatency = emgLatency + REFLEX.electromechanicalDelay.value
  return {
    withdraws: true,
    reason: { zh: `强度 ${drive.toFixed(1)} 达到退缩阈 ${thr}（假设值）。`, en: `Intensity ${drive.toFixed(1)} reaches the withdrawal threshold of ${thr} (an assumed value).` },
    limb,
    side: loc.side,
    pattern: name,
    emgLatency,
    movementLatency,
    amplitude,
    targets,
    releaseAt: Math.max(stimulusEnd, t0 + movementLatency) + REFLEX.pose.hold.value,
  }
}

function buildMap(body: PainBody, stimulus: Stimulus, loc: Located): PainMap {
  const pos = body.skin.positions
  const n = body.skinMaps.vertexCount
  const thermal = stimulus.kind === 'heat' || stimulus.kind === 'cold'
  const area = stimulus.areaMm2 ?? (stimulus.kind === 'pinch' ? NOCICEPTION.modalities.pinch.defaultAreaMm2!.value : stimulus.kind === 'pressure' ? NOCICEPTION.modalities.pressure.probe!.areaMm2!.value : undefined)
  const contact = area !== undefined && stimulus.kind !== 'pinprick' ? Math.sqrt(area / Math.PI) / 1000 : thermal ? THERMAL_DRAW_RADIUS : 0
  const radius = Math.max(MIN_DRAW_RADIUS, contact)
  const vertices: number[] = []
  const weights: number[] = []
  const c = loc.position
  for (let i = 0; i < n; i++) {
    const dist = Math.hypot(pos[i * 3]! - c[0], pos[i * 3 + 1]! - c[1], pos[i * 3 + 2]! - c[2])
    if (i === loc.vertex || dist < radius) {
      vertices.push(i)
      weights.push(i === loc.vertex ? 1 : 1 - dist / radius)
    }
  }
  return { skinPart: body.skin.part, vertexCount: n, vertex: loc.vertex, radiusM: radius, focus: { vertices, weights }, dermatome: loc.dermatome, territory: loc.territory }
}

/**
 * 每个皮肤顶点一个 0–1 的值，供体表图层显示：接触区最亮，其所在的皮神经分布区和皮节按给定的亮度
 * 作为背景。背景亮度是显示用的值，不代表那里的疼痛强度。
 * One value 0–1 per skin vertex for a skin layer: the contact area brightest, its cutaneous
 * territory and dermatome behind it at the given levels. The background levels are display
 * values and do not stand for a pain intensity there.
 */
export function painMapWeights(body: PainBody, map: PainMap, levels: { territory?: number; dermatome?: number } = {}): Float32Array {
  const ix = indexOf(body)
  const out = new Float32Array(map.vertexCount)
  const lt = levels.territory ?? 0.35
  const ld = levels.dermatome ?? 0.2
  const pos = body.skin.positions
  const left = (pos[map.vertex * 3] ?? 0) >= 0
  for (let i = 0; i < map.vertexCount; i++) {
    // 只标刺激所在的一侧 / only the stimulated side is marked
    if ((pos[i * 3]! >= 0) !== left) continue
    let w = 0
    if (map.dermatome && ix.dermatome.data[i] === map.dermatome.region) w = ld
    if (map.territory && ix.territory.data[i] === map.territory.region) w = Math.max(w, lt)
    out[i] = w
  }
  map.focus.vertices.forEach((v, k) => {
    out[v] = Math.max(out[v]!, lt + (1 - lt) * map.focus.weights[k]!)
  })
  return out
}

interface TraceInput {
  body: PainBody
  stimulus: Stimulus
  loc: Located
  d: Drive
  modality: (typeof NOCICEPTION.modalities)[Stimulus['kind']]
  regionName: Bilingual
  nerves: { name: string; parts: string[] }[]
  roots: { id: string; name: string }[]
  segments: string[]
  territorySegments: string[]
  path: ReturnType<typeof nervePath>
  latency: { adelta: number; c: number; firstPain: number; secondPain: number }
  reflex: ReflexResult
  summation: number
  wA: number
  peak: { intensity: number; t: number }
}

function buildTrace(x: TraceInput): PainTrace {
  const { stimulus, loc, d, modality, path, latency, reflex } = x
  const used = new Set<string>()
  const caveats: Bilingual[] = []
  const keep = (n: TraceNumber): TraceNumber => {
    n.sources.forEach((s) => used.add(s))
    return n
  }
  const fib = NOCICEPTION.fibres
  const temporal = NOCICEPTION.temporal
  const steps: TraceStep[] = []

  // 1 刺激与阈值 / stimulus and threshold
  const thrNumbers: TraceNumber[] = [
    keep(computed({ zh: '刺激量', en: 'Stimulus magnitude' }, d.magnitude, d.unit)),
    keep(num({ zh: `痛阈（${d.threshold.site}）`, en: `Pain threshold (${d.threshold.site})` }, d.threshold.quantity, d.threshold.value, d.unit)),
    keep(num({ zh: '阈上增益', en: 'Supra-threshold gain' }, modality.response.gain)),
  ]
  if (modality.response.exponent) thrNumbers.push(keep(num({ zh: '指数', en: 'Exponent' }, modality.response.exponent)))
  if (d.factor && d.factor.value !== 1) thrNumbers.push(keep({ label: { zh: '部位系数', en: 'Regional multiplier' }, value: d.factor.value, unit: '×', sources: [], assumption: d.factor.quantity.assumption === true, ...(d.factor.quantity.note ? { note: d.factor.quantity.note } : {}) }))
  if (x.summation > 0) thrNumbers.push(keep(num({ zh: '时间总和的增量（平台）', en: 'Temporal summation increment (plateau)' }, loc.region === 'hand' || loc.region === 'fingertip' ? temporal.temporalSummation.gain.hand : temporal.temporalSummation.gain.other)))
  thrNumbers.push(keep(computed({ zh: '强度（刺激–反应函数）', en: 'Intensity (stimulus-response function)' }, d.drive, 'NRS')))
  if (d.threshold.borrowed && d.threshold.borrowNote) caveats.push({ zh: `${x.regionName.zh}没有测量的阈值，借用了“${d.threshold.site}”的值。${d.threshold.borrowNote.zh}`, en: `No threshold was measured for the ${x.regionName.en.toLowerCase()}; the value of '${d.threshold.site}' is borrowed. ${d.threshold.borrowNote.en}` })
  steps.push({
    id: 'stimulus',
    title: { zh: '刺激与阈值', en: 'Stimulus and threshold' },
    text: {
      zh: `${modality.name.zh}，${d.magnitude.toFixed(1)} ${d.unit}，作用于${x.regionName.zh}（${loc.side === 'L' ? '左' : '右'}）。该处痛阈 ${d.threshold.value.toFixed(1)} ${d.unit}；${d.drive > 0 ? `超过阈值，强度 ${d.drive.toFixed(1)}/10` : '未达到阈值，不引起疼痛反应'}。`,
      en: `${modality.name.en}, ${d.magnitude.toFixed(1)} ${d.unit}, on the ${x.regionName.en.toLowerCase()} (${loc.side === 'L' ? 'left' : 'right'}). Pain threshold there ${d.threshold.value.toFixed(1)} ${d.unit}; ${d.drive > 0 ? `above threshold, intensity ${d.drive.toFixed(1)} out of 10` : 'below threshold, no pain response'}.`,
    },
    numbers: thrNumbers,
    parts: stimulus.site.part ? [stimulus.site.part] : [x.body.skin.part],
  })

  // 2 感受器与纤维 / receptors and fibres
  used.add(modality.receptorSource)
  steps.push({
    id: 'receptor',
    title: { zh: '感受器与纤维', en: 'Receptors and fibres' },
    text: {
      zh: `${modality.receptors.zh}。${fib.Adelta.name.zh}：${fib.Adelta.role.zh}；${fib.C.name.zh}：${fib.C.role.zh}。`,
      en: `${modality.receptors.en}. ${fib.Adelta.name.en}: ${fib.Adelta.role.en.toLowerCase()}; ${fib.C.name.en}: ${fib.C.role.en.toLowerCase()}.`,
    },
    numbers: [
      keep(num({ zh: 'Aδ 传导速度', en: 'Aδ conduction velocity' }, fib.Adelta.velocity)),
      keep(num({ zh: 'Aδ 速度范围', en: 'Aδ velocity range' }, fib.Adelta.velocityRange)),
      keep(num({ zh: 'C 传导速度', en: 'C conduction velocity' }, fib.C.velocity)),
      keep(num({ zh: 'C 速度范围', en: 'C velocity range' }, fib.C.velocityRange)),
      keep(num({ zh: '快成分所占比例', en: 'Share of the fast component' }, modality.firstPainShare)),
    ],
    parts: [],
  })

  // 3 部位的神经分布密度（仅说明）/ innervation density of the site (explanation only)
  const dens = REGIONS.innervation.sites[loc.region]
  const siteNumbers: TraceNumber[] = []
  const siteNotes: Bilingual[] = [REGIONS.innervation.note]
  if (dens) siteNumbers.push(keep(num(dens.quantity, dens[x.body.body], dens[x.body.body].value, dens.unit)))
  for (const q of REGIONS.innervation.qualitative) {
    if (q.regions.includes(loc.region)) {
      used.add(q.source)
      siteNotes.push(q.note)
    }
  }
  steps.push({
    id: 'site',
    title: { zh: '部位', en: 'Site' },
    text: { zh: siteNotes.map((n) => n.zh).join(' '), en: siteNotes.map((n) => n.en).join(' ') },
    numbers: siteNumbers,
    parts: [],
  })

  // 4 皮神经 / cutaneous nerve
  const nerveParts = x.nerves.flatMap((n) => n.parts)
  steps.push({
    id: 'nerve',
    title: { zh: '皮神经', en: 'Cutaneous nerve' },
    text: loc.territory
      ? {
          zh: `该点在“${loc.territory.name.zh}”的分布区内${x.nerves.length ? `；通路：${x.nerves.map((n) => n.name).join(' → ')}` : '；本模型里这条神经没有单独的几何'}。`,
          en: `The point lies in the territory of the ${loc.territory.name.en}${x.nerves.length ? `; pathway: ${x.nerves.map((n) => n.name).join(' → ')}` : '; this nerve has no geometry of its own in the model'}.`,
        }
      : { zh: '该点不在任何皮神经分布区内。', en: 'The point lies in no cutaneous nerve territory.' },
    numbers: [],
    parts: nerveParts,
  })

  // 5 节段 / segment
  const mismatch = x.segments.length > 0 && x.territorySegments.length > 0 && !x.segments.some((s) => x.territorySegments.includes(s))
  if (mismatch) caveats.push({ zh: `皮节图给出 ${x.segments.join('、')}，而这条皮神经的教科书节段是 ${x.territorySegments.join('、')}：两张图是分别构造的，在边界处会不一致。`, en: `The dermatome map gives ${x.segments.join(', ')} while the textbook root value of this nerve is ${x.territorySegments.join(', ')}: the two maps are constructed separately and disagree near boundaries.` })
  steps.push({
    id: 'segment',
    title: { zh: '脊髓节段', en: 'Spinal segment' },
    text: loc.dermatome
      ? { zh: `皮节 ${loc.dermatome.name.zh}；经后根进入 ${x.segments.join('、')} 节段${x.territorySegments.length ? `（该皮神经的节段来源：${x.territorySegments.join('、')}）` : ''}。`, en: `Dermatome ${loc.dermatome.name.en}; enters through the posterior root at ${x.segments.join(', ')}${x.territorySegments.length ? ` (root value of the nerve: ${x.territorySegments.join(', ')})` : ''}.` }
      : { zh: '该点不在任何皮节内。', en: 'The point lies in no dermatome.' },
    numbers: [],
    parts: x.roots.map((r) => r.id),
  })

  // 6 传导 / conduction
  if (path.method === 'straight') caveats.push({ zh: '这条通路没有可用的神经中心线，路径长度取刺激点到神经根的直线距离，是下限。', en: 'No nerve centreline is available for this pathway; the path length is the straight line from the stimulus to the root, a lower bound.' })
  else if (path.bridgedM > 0.02) caveats.push({ zh: `路径中有 ${(path.bridgedM * 100).toFixed(0)} cm 是跨越模型里没有建出的神经段（如神经丛）的直线。`, en: `${(path.bridgedM * 100).toFixed(0)} cm of the path are straight bridges across stretches the model has no centreline for (such as a plexus).` })
  steps.push({
    id: 'conduction',
    title: { zh: '传导', en: 'Conduction' },
    text: {
      zh: `从皮肤到神经根约 ${(path.lengthM * 100).toFixed(0)} cm：Aδ 纤维 ${(latency.adelta * 1000).toFixed(0)} ms 到达，C 纤维 ${latency.c.toFixed(2)} s 到达。`,
      en: `About ${(path.lengthM * 100).toFixed(0)} cm from skin to root: Aδ fibres arrive after ${(latency.adelta * 1000).toFixed(0)} ms, C fibres after ${latency.c.toFixed(2)} s.`,
    },
    numbers: [
      keep(computed({ zh: '路径长度', en: 'Path length' }, path.lengthM, 'm', { zh: path.method === 'centreline' ? '沿 nerves.json 的中心线量得' : '直线距离（下限）', en: path.method === 'centreline' ? 'Measured along the centrelines of nerves.json' : 'Straight-line distance (a lower bound)' })),
      keep(computed({ zh: '其中直线跨越', en: 'Of which bridged in a straight line' }, path.bridgedM, 'm')),
      keep(computed({ zh: 'Aδ 到达脊髓', en: 'Aδ arrival at the cord' }, latency.adelta, 's')),
      keep(computed({ zh: 'C 到达脊髓', en: 'C arrival at the cord' }, latency.c, 's')),
    ],
    parts: path.parts,
  })

  // 7 感知的时间过程 / time course
  steps.push({
    id: 'perception',
    title: { zh: '强度的时间过程', en: 'Time course of intensity' },
    text: {
      zh: `第一痛约在 ${(latency.firstPain * 1000).toFixed(0)} ms 开始，第二痛约在 ${latency.secondPain.toFixed(2)} s 开始；峰值 ${x.peak.intensity.toFixed(1)}/10。这是模型输出的强度，不是感受。`,
      en: `First pain begins at about ${(latency.firstPain * 1000).toFixed(0)} ms and second pain at about ${latency.secondPain.toFixed(2)} s; peak ${x.peak.intensity.toFixed(1)} out of 10. This is the intensity the model outputs, not an experience.`,
    },
    numbers: [
      keep(num({ zh: '中枢延迟', en: 'Central delay' }, temporal.centralDelay)),
      keep(computed({ zh: '第一痛开始', en: 'Onset of first pain' }, latency.firstPain, 's')),
      keep(computed({ zh: '第二痛开始', en: 'Onset of second pain' }, latency.secondPain, 's')),
      keep(num({ zh: '文献所述第二痛的延迟（手、前臂）', en: 'Reported delay of second pain (hand, forearm)' }, temporal.secondPain.reportedDelay)),
      keep(num({ zh: '快成分上升时间常数', en: 'Fast component rise' }, temporal.firstPain.rise)),
      keep(num({ zh: '快成分消退时间常数', en: 'Fast component decay' }, temporal.firstPain.decay)),
      keep(num({ zh: '快成分适应到', en: 'Fast component adapts to' }, temporal.firstPain.adaptTo)),
      keep(num({ zh: '适应时间常数', en: 'Adaptation time constant' }, temporal.firstPain.adaptTime)),
      keep(num({ zh: '慢成分上升时间常数', en: 'Slow component rise' }, temporal.secondPain.rise)),
      keep(num({ zh: '慢成分消退时间常数', en: 'Slow component decay' }, temporal.secondPain.decay)),
      keep(computed({ zh: '峰值强度', en: 'Peak intensity' }, x.peak.intensity, 'NRS')),
    ],
    parts: [],
  })

  // 8 反射 / reflex
  const reflexNumbers: TraceNumber[] = [keep(num({ zh: '退缩阈', en: 'Withdrawal threshold' }, REFLEX.threshold))]
  if (reflex.withdraws && reflex.limb) {
    const ref = REFLEX.reference[reflex.limb]
    used.add(REFLEX.patterns[reflex.limb].source)
    reflexNumbers.push(
      keep(computed({ zh: '肌电潜伏期（模型）', en: 'EMG latency (model)' }, reflex.emgLatency!, 's', { zh: 'Aδ 传入时间 + 脊髓延迟 + 传出时间', en: 'Aδ afferent time + spinal delay + efferent time' })),
      keep(num({ zh: '实测的反射潜伏期（对照）', en: 'Measured reflex latency (for comparison)' }, ref.latency)),
      keep(num({ zh: '反射的时间窗', en: 'Reflex window' }, ref.window)),
      keep(num({ zh: '运动神经传导速度', en: 'Motor conduction velocity' }, REFLEX.motorVelocity)),
      keep(num({ zh: '脊髓延迟', en: 'Spinal delay' }, REFLEX.spinalDelay)),
      keep(num({ zh: '电–机械延迟', en: 'Electromechanical delay' }, REFLEX.electromechanicalDelay)),
      keep(computed({ zh: '开始移动', en: 'Movement onset' }, reflex.movementLatency!, 's')),
      keep(computed({ zh: '幅度（占满幅）', en: 'Amplitude (fraction of full)' }, reflex.amplitude, '')),
    )
    caveats.push({ zh: '退缩之后刺激并没有被移开：模型不计算肢体离开刺激物，强度仍按原定的刺激时长计算。', en: 'Withdrawal does not remove the stimulus: the model does not compute the limb leaving the stimulating object, and the intensity still follows the stated duration.' })
  }
  steps.push({
    id: 'reflex',
    title: { zh: '退缩反射', en: 'Withdrawal reflex' },
    text: reflex.withdraws && reflex.pattern ? { zh: `${reflex.reason.zh}${reflex.pattern.zh}。关节角度是假设值。`, en: `${reflex.reason.en} ${reflex.pattern.en}. The joint angles are assumed values.` } : reflex.reason,
    numbers: reflexNumbers,
    parts: [],
  })

  // 9 自主体征 / autonomic signs
  const autoNumbers: TraceNumber[] = []
  for (const id of AUTONOMIC_SIGNS) {
    const s = AUTONOMIC.signs[id]
    autoNumbers.push(
      keep(num({ zh: `${s.name.zh}：基线`, en: `${s.name.en}: baseline` }, s.baseline)),
      keep(num({ zh: `${s.name.zh}：参考强度下的变化`, en: `${s.name.en}: change at the reference intensity` }, s.effect)),
      keep(num({ zh: `${s.name.zh}：参考强度`, en: `${s.name.en}: reference intensity` }, s.referenceIntensity)),
    )
  }
  steps.push({
    id: 'autonomic',
    title: { zh: '自主体征', en: 'Autonomic signs' },
    text: {
      zh: '心率、血压、呼吸、瞳孔和皮肤电导随强度变化，各有自己的时间常数（多为假设）。效应量来自冷加压等实验的群体平均；个体差异很大。',
      en: 'Heart rate, blood pressure, breathing, pupil and skin conductance follow the intensity, each with its own time constants (mostly assumed). Effect sizes are group averages from cold pressor and similar experiments; individuals differ widely.',
    },
    numbers: autoNumbers,
    parts: [],
  })

  if (stimulus.site.depthMm !== undefined && stimulus.site.depthMm > 0) caveats.push({ zh: '刺激的深度已记录，但没有参与计算：只模拟了皮肤的刺激。', en: 'The depth of the stimulus is recorded but not used: only stimulation of the skin is modelled.' })
  if (stimulus.kind === 'pinprick' && stimulus.areaMm2 !== undefined) caveats.push({ zh: '针刺的阈值只对 0.2 mm 平头探头成立，没有按给出的接触面积换算。', en: 'The pinprick threshold holds for the 0.2 mm flat-tip probe only and was not rescaled to the given contact area.' })
  caveats.push({ zh: '皮节和皮神经分布区是构造的教学用图，未经临床医师审校；相邻区域的重叠没有表示。', en: 'The dermatome and cutaneous nerve maps are constructed teaching maps, unreviewed by a clinician; overlap between neighbouring areas is not represented.' })

  const highlightParts = [...new Set([...nerveParts, ...x.roots.map((r) => r.id)])]
  return {
    disclaimer: DISCLAIMER,
    kind: stimulus.kind,
    side: loc.side,
    region: { id: loc.region, name: x.regionName },
    magnitude: { value: d.magnitude, unit: d.unit },
    threshold: { value: d.threshold.value, unit: d.unit, site: d.threshold.site, borrowed: d.threshold.borrowed },
    drive: d.drive,
    dermatome: loc.dermatome,
    territory: loc.territory,
    segments: x.segments,
    nerves: x.nerves,
    roots: x.roots,
    path,
    latency,
    steps,
    highlightParts,
    sources: sourcesById(used),
    caveats,
  }
}
