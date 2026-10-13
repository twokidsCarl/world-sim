// 面部表情的 CPU 参考实现：疼痛强度 → AU 强度 → 通道激活 → 逐顶点位移。
// CPU reference implementation of the facial expression: pain intensity → AU intensities →
// channel activations → per-vertex displacements.
//
// 运行时（GPU 顶点阶段或 CPU 累加）应与这里的结果一致；tests/face*.test.ts 以它为准。
// 只依赖数据契约（src/face/types.ts），前端可以直接导入。
// The runtime (a GPU vertex stage or a CPU accumulation) should reproduce these results;
// tests/face*.test.ts use this file as ground truth. It depends only on the data contract
// (src/face/types.ts), so the frontend can import it as is.
//
// 这是疼痛行为的计算模型，用于教学；模拟人并没有主观感受。
// This is a computational model of pain behaviour for teaching; the simulated body has no
// subjective experience.
//
// 约定 / Conventions
//   · AU 强度 0–5（FACS 的 A–E）；通道激活 a_c = clamp(Σ_k w_kc · I_k / 5, 0, 1)。
//     AU intensities 0–5 (FACS A–E); channel activation a_c = clamp(Σ_k w_kc · I_k / 5, 0, 1).
//   · 位移在静止空间里相加，先于蒙皮：p′ = p + Σ_c a_c · D_c[v]；然后照常用 rig 蒙皮。
//     Displacements add in rest space, before skinning: p′ = p + Σ_c a_c · D_c[v]; then skin with the rig as usual.
//   · 下颌：角度 = clamp(Σ_k jaw_k · I_k / 5, 0, jaw.max)，加到 rig 的 jaw.joint 的第 jaw.dof 个自由度上。
//     Jaw: angle = clamp(Σ_k jaw_k · I_k / 5, 0, jaw.max), added to dof jaw.dof of the rig joint jaw.joint.
//   · face.bin 的一个场：count × uint32 顶点下标，随后 count × 3 × int16；位移 = 分量 × scale / 32767（米）。
//     A field in face.bin: count × uint32 vertex indices, then count × 3 × int16; displacement = component × scale / 32767 (metres).

import type { MouthFrame } from '../../src/voice/mouth.ts'
import type { FaceChannel, FaceData, FaceExpression, FaceField, FaceViseme, FaceVisemes, MouthFeatureFrame, PainModel, TonguePose } from '../../src/face/types.ts'

/** AU id → 强度（0–5）。缺省为 0。 AU id → intensity (0–5). Missing = 0. */
export type AUs = Record<string, number>
/** 通道 id → 激活（0–1）。缺省为 0。 Channel id → activation (0–1). Missing = 0. */
export type Activations = Record<string, number>

export const AU_MAX = 5
/** int16 分量的满量程 / full scale of the int16 components. */
export const Q = 32767

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const smooth = (t: number): number => {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

/** 疼痛强度（0–10）下各 AU 的强度：关键帧之间线性插值。 AU intensities at a pain level (0–10): linear between keyframes. */
export function painAUs(pain: PainModel, level: number): AUs {
  const kf = pain.keyframes
  if (kf.length === 0) return {}
  const l = clamp(level, kf[0]!.level, kf[kf.length - 1]!.level)
  let i = 0
  while (i < kf.length - 2 && l > kf[i + 1]!.level) i++
  const a = kf[i]!, b = kf[Math.min(i + 1, kf.length - 1)]!
  const t = b.level > a.level ? clamp((l - a.level) / (b.level - a.level), 0, 1) : 0
  const out: AUs = {}
  for (const id of new Set([...Object.keys(a.aus), ...Object.keys(b.aus)])) {
    const v = (a.aus[id] ?? 0) * (1 - t) + (b.aus[id] ?? 0) * t
    if (v !== 0) out[id] = v
  }
  return out
}

/**
 * Prkachin–Solomon 疼痛强度：AU4 + max(AU6, AU7) + max(AU9, AU10) + AU43。
 * `continuous` 为 false（缺省）时 `binary` 里的 AU 取 0 或 1（强度 ≥ 2.5 记 1）；为 true 时取 强度 / 5。
 * Prkachin–Solomon Pain Intensity: AU4 + max(AU6, AU7) + max(AU9, AU10) + AU43. With `continuous`
 * false (default) the AUs listed in `binary` count 0 or 1 (1 at intensity ≥ 2.5); with true they count intensity / 5.
 */
export function pspi(pain: PainModel, aus: AUs, continuous = false): number {
  const value = (id: string): number => {
    const v = clamp(aus[id] ?? 0, 0, AU_MAX)
    if (!pain.pspi.binary.includes(id)) return v
    return continuous ? v / AU_MAX : v >= AU_MAX / 2 ? 1 : 0
  }
  let s = 0
  for (const term of pain.pspi.terms) s += typeof term === 'string' ? value(term) : Math.max(...term.map(value))
  return s
}

/**
 * 时间包络（0–1）：刺激在 t = 0 开始、持续 `duration` 秒。latency 之后在 onset 内平滑升到 1，
 * 刺激结束后在 offset 内平滑回落。乘到疼痛强度或 AU 强度上。
 * Time envelope (0–1) for a stimulus starting at t = 0 and lasting `duration` seconds: after
 * `latency` it rises smoothly to 1 within `onset`, and falls back within `offset` once the
 * stimulus has ended. Multiply the pain level or the AU intensities by it.
 */
export function envelope(timing: PainModel['timing'], t: number, duration: number): number {
  const up = smooth((t - timing.latency) / Math.max(1e-6, timing.onset))
  // 短于起始时间的刺激达不到峰值 / a stimulus shorter than the onset never reaches the apex
  const peak = smooth((Math.max(0, duration)) / Math.max(1e-6, timing.onset))
  const end = duration + timing.latency
  if (t <= end) return up
  return Math.min(up, peak) * (1 - smooth((t - end) / Math.max(1e-6, timing.offset)))
}

/** AU 强度 → 通道激活和下颌张开角（弧度）。 AU intensities → channel activations and jaw opening (radians). */
export function activations(face: Pick<FaceData, 'aus' | 'jaw'>, aus: AUs): { channels: Activations; jaw: number } {
  const channels: Activations = {}
  let jaw = 0
  for (const au of face.aus) {
    const k = clamp(aus[au.id] ?? 0, 0, AU_MAX) / AU_MAX
    if (k === 0) continue
    for (const [id, w] of Object.entries(au.channels)) channels[id] = (channels[id] ?? 0) + w * k
    jaw += (au.jaw ?? 0) * k
  }
  for (const id of Object.keys(channels)) channels[id] = clamp(channels[id]!, 0, 1)
  return { channels, jaw: clamp(jaw, 0, face.jaw.max) }
}

/** 读出一个场：顶点下标和位移（米）。 Decodes one field: vertex indices and displacements in metres. */
export function readField(bin: Uint8Array, field: FaceField): { index: Uint32Array; delta: Float32Array } {
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  const index = new Uint32Array(field.count), delta = new Float32Array(field.count * 3)
  const k = field.scale / Q
  let o = field.offset
  for (let i = 0; i < field.count; i++, o += 4) index[i] = dv.getUint32(o, true)
  for (let i = 0; i < field.count * 3; i++, o += 2) delta[i] = dv.getInt16(o, true) * k
  return { index, delta }
}

/**
 * 一个部件在给定激活下的逐顶点位移（米，静止空间），长度 3 × vertexCount。
 * Per-vertex displacement of one part for the given activations (metres, rest space), length 3 × vertexCount.
 */
export function displacement(channels: FaceChannel[], bin: Uint8Array, part: string, vertexCount: number, act: Activations): Float32Array {
  const out = new Float32Array(vertexCount * 3)
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
  for (const ch of channels) {
    const a = clamp(act[ch.id] ?? 0, 0, 1)
    if (a === 0) continue
    for (const f of ch.fields) {
      if (f.part !== part) continue
      const k = (a * f.scale) / Q
      const vo = f.offset + f.count * 4
      for (let i = 0; i < f.count; i++) {
        const v = dv.getUint32(f.offset + i * 4, true) * 3
        out[v] = out[v]! + dv.getInt16(vo + i * 6, true) * k
        out[v + 1] = out[v + 1]! + dv.getInt16(vo + i * 6 + 2, true) * k
        out[v + 2] = out[v + 2]! + dv.getInt16(vo + i * 6 + 4, true) * k
      }
    }
  }
  return out
}

/** 静止顶点 + 位移；之后再交给 rig 蒙皮。 Rest vertices plus displacement; hand the result to the rig for skinning. */
export function deform(channels: FaceChannel[], bin: Uint8Array, part: string, rest: Float32Array, act: Activations): Float32Array {
  const d = displacement(channels, bin, part, rest.length / 3, act)
  for (let i = 0; i < d.length; i++) d[i] = d[i]! + rest[i]!
  return d
}

/** 一步到位：疼痛强度 → 激活和下颌角。 In one step: pain level → activations and jaw angle. */
export function painExpression(face: Pick<FaceData, 'aus' | 'jaw' | 'pain'>, level: number): { aus: AUs; channels: Activations; jaw: number; pspi: number } {
  const aus = painAUs(face.pain, level)
  return { aus, ...activations(face, aus), pspi: pspi(face.pain, aus) }
}

/**
 * 表情原型在给定强度（0–1）下各 AU 的强度：原型强度 × strength。找不到该表情时返回空。
 * 可以把几组 AU 用 mergeAUs 合并（同一 AU 取较大者），例如表情和疼痛。
 * AU intensities of an expression prototype at a strength (0–1): prototype intensity × strength. Empty when the expression is
 * unknown. Several AU sets can be merged with mergeAUs (the larger value of a shared AU wins), e.g. an expression and pain.
 */
export function expressionAUs(expressions: FaceExpression[] | undefined, id: string, strength = 1): AUs {
  const e = expressions?.find((x) => x.id === id)
  const k = clamp(strength, 0, 1)
  const out: AUs = {}
  if (!e || k === 0) return out
  for (const [au, v] of Object.entries(e.aus)) out[au] = clamp(v * k, 0, AU_MAX)
  return out
}

/** 合并几组 AU：同一 AU 取最大值。 Merges AU sets: the largest value of each AU. */
export function mergeAUs(...sets: AUs[]): AUs {
  const out: AUs = {}
  for (const s of sets) for (const [au, v] of Object.entries(s)) out[au] = Math.max(out[au] ?? 0, v)
  return out
}

// —— 说话：视位、协同发音、原始声学特征 / Speech: visemes, co-articulation, raw audio features ——
//
// 方法取自 JALI（Edwards 等 2016，见 sources.json 的 jali2016）：口形 = 静止 + JA ·（下颌 + 舌）+ LI · 唇的动作单元；
// 闭唇（双唇音）和下唇碰上齿（唇齿音）是必须满足的约束，不随 JA、LI 缩放。数值都在 data/curated/face/visemes.json，
// 除标明出处的以外都是假设。两条路线——命名的视位、原始声学特征——都先得到一个 MouthPose，再由 mouthChannels
// 变成同一组通道。
// Method from JALI (Edwards et al. 2016; jali2016 in sources.json): mouth shape = rest + JA · (jaw + tongue) + LI · lip action
// units; lip closure (bilabials) and lower lip to upper teeth (labiodentals) are constraints that must be met and are not scaled
// by JA or LI. All numbers live in data/curated/face/visemes.json and are assumptions unless a source is given. Both routes —
// named visemes and raw audio features — first produce a MouthPose, which mouthChannels turns into the same set of channels.


/** 一个口形：唇的 AU、两个约束、下颌角（弧度）和舌。 One mouth shape: lip AUs, the two constraints, jaw angle (radians) and tongue. */
export interface MouthPose {
  aus: AUs
  /** 双唇闭合 0–1 / bilabial closure 0–1. */
  closure: number
  /** 下唇贴上切牙 0–1 / lower lip to the upper incisors 0–1. */
  dental: number
  /** 下颌张开角，弧度 / jaw opening, radians. */
  jaw: number
  tongue: TonguePose
}

/** 把唇分开的 AU：闭唇时按 (1 − closure) 减弱 / the AUs that part the lips: attenuated by (1 − closure) while the lips are sealed. */
const PARTING = ['AU25', 'AU16', 'AU10']

type FaceForMouth = Pick<FaceData, 'aus' | 'jaw' | 'channels'>

/**
 * MouthPose → 通道激活和下颌角。规则：
 *   · 唇的 AU 照常经 activations；把唇分开的 AU 先乘 (1 − closure)。
 *   · mouth_corner = 下颌角 / jaw.max（口角成形通道的约定）。
 *   · lip_seal = closure × 下颌角 / refJaw（不超过 1）：通道在 refJaw 处求解，对小角度近似线性，所以下颌开多少就抵消多少。
 *     下颌角超过 refJaw 时唇合不上（激活封顶为 1）。
 *   · lip_dental = dental；下颌角大于它的 refJaw 时，多出来的部分再用 lip_seal 抵消。
 *   · 舌：tongue_tip_up / tongue_front_up / tongue_back_up / tongue_low = 各自的权重。
 * MouthPose → channel activations and jaw angle. Rules: lip AUs go through `activations` as usual, the lip-parting ones first
 * multiplied by (1 − closure); mouth_corner = jaw angle / jaw.max (the contract of the corner-shaping channel);
 * lip_seal = closure × jaw angle / refJaw (at most 1) — the channel is solved at refJaw and is nearly linear for small angles, so it
 * undoes exactly as much as the jaw has opened, and beyond refJaw the lips cannot meet (the activation saturates at 1);
 * lip_dental = dental, and where the jaw is wider than its refJaw the excess is undone with lip_seal as well; the tongue channels
 * take their weights.
 *
 * baseJaw（可选，缺省 0）：下颌已经被别处张开的角度（姿势面板、反射），弧度。口角成形、闭唇和唇齿都按总的下颌角
 * （baseJaw + 这里算出的张开角，不超过上限）来算；返回的 jaw 仍然只是这里要加上去的那一部分，totalJaw 是总角。
 * 闭唇能合上的范围是总角 ≤ lip_seal 的 refJaw；超过后激活封顶为 1，唇合不上。
 * 唇齿：有两个参考通道时（lip_dental 在 refJaw 处求解，lip_dental_closed 在闭颌处求解），总角在 0 到 refJaw 之间按角度线性混合，
 * 两端都正好到位；超过 refJaw 的部分用 lip_seal 抵消，直到 lip_seal 也到 1（总角 = 两个 refJaw 之和）为止。
 * baseJaw (optional, default 0): the angle by which the jaw is already opened from elsewhere (pose panel, a reflex), radians.
 * Corner shaping, seal and dental are all computed for the total jaw angle (baseJaw + the opening computed here, up to the limit);
 * the returned `jaw` is still only the part to be added here, and `totalJaw` is the total. The lips can seal while the total is
 * ≤ lip_seal's refJaw; beyond it the activation saturates at 1 and they cannot meet. Dental: with both reference channels
 * (lip_dental solved at refJaw, lip_dental_closed solved with the jaw closed) the two are mixed linearly in the angle between 0 and
 * refJaw, landing exactly at both ends; what exceeds refJaw is undone with lip_seal until that too reaches 1 (total = the sum of
 * both refJaw values).
 */
export function mouthChannels(face: FaceForMouth, pose: MouthPose, baseJaw = 0): { channels: Activations; jaw: number; totalJaw: number } {
  const closure = clamp(pose.closure, 0, 1), dental = clamp(pose.dental, 0, 1)
  const aus: AUs = {}
  for (const [id, v] of Object.entries(pose.aus)) aus[id] = PARTING.includes(id) ? v * (1 - closure) : v
  const a = activations(face, aus)
  const base = clamp(baseJaw, 0, face.jaw.max)
  const jaw = clamp(pose.jaw + a.jaw + base, 0, face.jaw.max)
  const channels = a.channels
  const ch = (id: string): FaceChannel | undefined => face.channels.find((c) => c.id === id)
  const set = (id: string, v: number): void => {
    if (v > 0 && ch(id)) channels[id] = clamp(Math.max(channels[id] ?? 0, v), 0, 1)
  }
  if (face.jaw.max > 0) set('mouth_corner', jaw / face.jaw.max)
  const seal = ch('lip_seal'), dent = ch('lip_dental')
  let sealA = seal?.refJaw ? (closure * jaw) / seal.refJaw : 0
  if (dent?.refJaw) {
    const closed = ch('lip_dental_closed')
    const k = closed ? clamp(jaw / dent.refJaw, 0, 1) : 1
    set('lip_dental', dental * k)
    set('lip_dental_closed', dental * (1 - k))
    if (seal?.refJaw) sealA += (dental * Math.max(0, jaw - dent.refJaw)) / seal.refJaw
  }
  set('lip_seal', sealA)
  set('tongue_tip_up', pose.tongue.tip)
  set('tongue_front_up', pose.tongue.front)
  set('tongue_back_up', pose.tongue.back)
  set('tongue_low', pose.tongue.low)
  return { channels, jaw: jaw - base, totalJaw: jaw }
}

/** 视位权重：一组权重，或唇和下颌（含舌）各一组（协同发音的输出）。 Viseme weights: one set, or one for the lips and one for jaw and tongue (the output of co-articulation). */
export type VisemeWeights = Record<string, number> | { lips: Record<string, number>; jaw: Record<string, number>; closure?: number; dental?: number }

/**
 * 视位权重 → 口形和通道。权重之和大于 1 时归一；不足 1 的部分是静止。style 是 JALI 的两个轴：jaw 乘下颌和舌，lip 乘唇的 AU
 *（缺省都是 1）；闭唇和唇齿这两个约束不缩放。
 * Viseme weights → mouth shape and channels. Weights summing to more than 1 are normalised; what is short of 1 is rest. `style` holds
 * JALI's two axes: `jaw` multiplies jaw and tongue, `lip` the lip AUs (both default to 1); the closure and dental constraints are not scaled.
 */
export function visemeAUs(face: FaceForMouth & Pick<FaceData, 'visemes'>, weights: VisemeWeights, style: { jaw?: number; lip?: number } = {}): MouthPose & { channels: Activations } {
  const table = face.visemes?.visemes ?? []
  const split = typeof (weights as { lips?: unknown }).lips === 'object'
  const lipsW = (split ? (weights as { lips: Record<string, number> }).lips : weights) as Record<string, number>
  const jawW = (split ? (weights as { jaw: Record<string, number> }).jaw : weights) as Record<string, number>
  const norm = (w: Record<string, number>): [FaceViseme, number][] => {
    const list = table.map((v) => [v, Math.max(0, w[v.id] ?? 0)] as [FaceViseme, number]).filter(([, x]) => x > 0)
    const sum = list.reduce((s, [, x]) => s + x, 0)
    return sum > 1 ? list.map(([v, x]) => [v, x / sum]) : list
  }
  const JA = style.jaw ?? 1, LI = style.lip ?? 1
  const pose: MouthPose = { aus: {}, closure: 0, dental: 0, jaw: 0, tongue: { tip: 0, front: 0, back: 0, low: 0 } }
  for (const [v, w] of norm(lipsW)) {
    for (const [au, x] of Object.entries(v.aus)) pose.aus[au] = clamp((pose.aus[au] ?? 0) + x * w * LI, 0, AU_MAX)
    pose.closure += v.closure * w
    pose.dental += v.dental * w
  }
  for (const [v, w] of norm(jawW)) {
    pose.jaw += v.jaw * face.jaw.max * w * JA
    for (const k of ['tip', 'front', 'back', 'low'] as const) pose.tongue[k] = clamp(pose.tongue[k] + v.tongue[k] * w * JA, 0, 1)
  }
  if (split) {
    const s = weights as { closure?: number; dental?: number }
    if (s.closure !== undefined) pose.closure = s.closure
    if (s.dental !== undefined) pose.dental = s.dental
  }
  pose.closure = clamp(pose.closure, 0, 1)
  pose.dental = clamp(pose.dental, 0, 1)
  pose.jaw = clamp(pose.jaw, 0, face.jaw.max)
  return { ...pose, channels: mouthChannels(face, pose).channels }
}

/** 时间线上的一段：一个视位从 start 到 end（秒）。power 是幅度（缺省 1；JALI 用重音决定）。 One stretch of the timeline: a viseme from start to end (seconds). `power` is its amplitude (default 1; JALI sets it from stress). */
export interface VisemeSegment {
  viseme: string
  start: number
  end: number
  power?: number
}

export interface VisemeTrack {
  fps: number
  t0: number
  /** 每帧：唇的视位权重、下颌和舌的视位权重、两个约束 / per frame: viseme weights for the lips, for jaw and tongue, and the two constraints. */
  frames: { lips: Record<string, number>; jaw: Record<string, number>; closure: number; dental: number }[]
}

/**
 * 协同发音：视位时间线 → 每帧的视位权重。纯函数。实现的是 JALI 第 4.2 节的习惯（括号里是原文的编号）：
 *   (1) 相邻的相同视位并成一个；
 *   (2) lipHeavy 的视位提前开始、推迟结束：唇形的起止扩到前一段的开始和后一段的结束，起始 / 消退用 lipHeavyOnset / Offset；
 *   (3) 它取代不是双唇音 / 唇齿音的邻居的唇形；(4) 邻居是双唇音 / 唇齿音时两者同时发（邻居的唇形保留，约束照常满足）；
 *   (5)(8) tongueOnly 的视位不影响唇：它那段时间的唇形由后一段提前给出，后面没有（或是停顿）时由前一段延续；
 *   (6)(7) 短于 shortSeconds 且两边没有塞音 / 鼻音的塞音 / 鼻音不影响下颌（咝音除外）；
 *   (9) 其余照原样发。每个视位在其起点前 onset 秒开始平滑升起，在终点后 offset 秒内平滑消退。
 * 闭唇和唇齿两个约束单独成轨，不参加归一，所以即使与别的视位重叠也保证闭上。没有实现：重音决定幅度（用 power 传入）、
 * 塞音 / 鼻音收窄下颌的专门处理（由视位本身的下颌开度体现）、“向词内看”的词边界（这里只看相邻的段）。
 * Co-articulation: a viseme timeline → per-frame viseme weights. A pure function. It implements the habits of JALI section 4.2
 * (the paper's numbering in brackets): (1) adjacent identical visemes merge; (2) lip-heavy visemes start early and end late — their
 * lip shape spans from the start of the previous segment to the end of the next, with lipHeavyOnset / Offset; (3) they replace the
 * lip shape of neighbours that are not bilabial / labiodental; (4) with bilabial / labiodental neighbours both sound together (the
 * neighbour keeps its lip shape and its constraint is met as usual); (5)(8) tongue-only visemes do not affect the lips — during them
 * the lips take the shape of the following segment early, or keep that of the preceding one when nothing (or a pause) follows;
 * (6)(7) an obstruent / nasal shorter than shortSeconds with no obstruent / nasal neighbour does not affect the jaw (sibilants
 * excepted); (9) everything else is articulated as it is. Each viseme rises smoothly from `onset` seconds before its start and decays
 * within `offset` seconds after its end. The closure and dental constraints are tracks of their own and are not normalised, so the
 * lips do close even when visemes overlap. Not implemented: amplitude from stress (pass `power`), the special narrowing of the jaw
 * for obstruents / nasals (carried by each viseme's own jaw value), and word boundaries for "looking into the word" (only adjacent
 * segments are considered here).
 */
export function coarticulate(timeline: VisemeSegment[], visemes: FaceVisemes, opts: { fps?: number; t0?: number; t1?: number } = {}): VisemeTrack {
  const fps = opts.fps ?? 100
  const byId = new Map(visemes.visemes.map((v) => [v.id, v]))
  const T = visemes.timing
  const is = (v: FaceViseme | undefined, c: string): boolean => !!v && (v.classes as string[]).includes(c)
  // (1)
  const segs: { v: FaceViseme; start: number; end: number; power: number; lips: [number, number] | null; jaw: [number, number] | null }[] = []
  for (const s of [...timeline].filter((x) => x.end > x.start && byId.has(x.viseme)).sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = segs[segs.length - 1]
    if (last && last.v.id === s.viseme && s.start - last.end < 1e-3) (last.end = Math.max(last.end, s.end)), (last.power = Math.max(last.power, s.power ?? 1))
    else segs.push({ v: byId.get(s.viseme)!, start: s.start, end: s.end, power: s.power ?? 1, lips: null, jaw: null })
  }
  for (const s of segs) (s.lips = [s.start, s.end]), (s.jaw = [s.start, s.end])
  const adjacent = (a: number, b: number): boolean => a >= 0 && b < segs.length && segs[b]!.start - segs[a]!.end < 0.05 && !is(segs[a]!.v, 'pause') && !is(segs[b]!.v, 'pause')
  // (5)(8)
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    if (!is(s.v, 'tongueOnly')) continue
    s.lips = null
    let j = i + 1
    while (j < segs.length && adjacent(j - 1, j) && is(segs[j]!.v, 'tongueOnly')) j++
    if (j < segs.length && adjacent(j - 1, j) && segs[j]!.lips) segs[j]!.lips![0] = Math.min(segs[j]!.lips![0], s.start)
    else {
      let k = i - 1
      while (k >= 0 && adjacent(k, k + 1) && is(segs[k]!.v, 'tongueOnly')) k--
      if (k >= 0 && adjacent(k, k + 1) && segs[k]!.lips) segs[k]!.lips![1] = Math.max(segs[k]!.lips![1], s.end)
    }
  }
  // (2)(3)(4)
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    if (!is(s.v, 'lipHeavy') || !s.lips) continue
    for (const j of [i - 1, i + 1]) {
      if (!(j < i ? adjacent(j, i) : adjacent(i, j))) continue
      const n = segs[j]!
      if (j < i) s.lips[0] = Math.min(s.lips[0], n.start)
      else s.lips[1] = Math.max(s.lips[1], n.end)
      if (!is(n.v, 'bilabial') && !is(n.v, 'labiodental') && !is(n.v, 'lipHeavy')) n.lips = null
    }
  }
  // (6)(7)
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    const stop = (v: FaceViseme): boolean => is(v, 'obstruent') || is(v, 'nasal')
    if (!stop(s.v) || is(s.v, 'sibilant') || s.end - s.start >= T.shortSeconds) continue
    const similar = (i > 0 && adjacent(i - 1, i) && stop(segs[i - 1]!.v)) || (i + 1 < segs.length && adjacent(i, i + 1) && stop(segs[i + 1]!.v))
    if (!similar) s.jaw = null
  }
  const curve = (t: number, a: number, b: number, on: number, off: number): number => (t < a ? smooth((t - (a - on)) / Math.max(1e-6, on)) : t <= b ? 1 : 1 - smooth((t - b) / Math.max(1e-6, off)))
  const t0 = opts.t0 ?? (segs.length ? segs[0]!.start - T.lipHeavyOnset : 0), t1 = opts.t1 ?? (segs.length ? Math.max(...segs.map((s) => s.end)) + T.lipHeavyOffset : 0)
  const frames: VisemeTrack['frames'] = []
  const n = Math.max(0, Math.round((t1 - t0) * fps)) + 1
  for (let f = 0; f < n; f++) {
    const t = t0 + f / fps
    const lips: Record<string, number> = {}, jaw: Record<string, number> = {}
    let closure = 0, dental = 0
    for (const s of segs) {
      const heavy = is(s.v, 'lipHeavy'), on = heavy ? T.lipHeavyOnset : T.onset, off = heavy ? T.lipHeavyOffset : T.offset
      if (s.lips) {
        const w = curve(t, s.lips[0], s.lips[1], on, off) * s.power
        if (w > 1e-4) lips[s.v.id] = Math.max(lips[s.v.id] ?? 0, w)
      }
      if (s.jaw) {
        const w = curve(t, s.jaw[0], s.jaw[1], T.onset, T.offset) * s.power
        if (w > 1e-4) jaw[s.v.id] = Math.max(jaw[s.v.id] ?? 0, w)
      }
      // 约束按视位自己的时段取，不受幅度影响 / the constraints follow the viseme's own span, whatever its amplitude
      if (s.v.closure > 0 || s.v.dental > 0) {
        const w = curve(t, s.start, s.end, T.onset, T.offset)
        closure = Math.max(closure, w * s.v.closure)
        dental = Math.max(dental, w * s.v.dental)
      }
    }
    frames.push({ lips, jaw, closure, dental })
  }
  return { fps, t0, frames }
}

// 声音一侧的帧类型（src/voice/mouth.ts 的 MouthFrame）必须能直接传进来；下面这一行在两边的类型不再相容时让编译失败。
// The audio side's frame type (MouthFrame of src/voice/mouth.ts) must be accepted as it is; the line below fails the build once the two types stop being compatible.
export type { MouthFrame }
const _mouthFrameIsCompatible: MouthFrame extends MouthFeatureFrame ? true : never = true
void _mouthFrameIsCompatible

/** 原始特征路线的平滑状态 / the smoothed state of the raw-feature route. */
export interface MouthState {
  t: number
  open: number
  round: number
  closure: number
  tip: number
  front: number
  back: number
}

/**
 * 原始声学特征的一帧 → 口形和通道（与视位路线驱动同一组通道）。纯函数：上一帧的状态由调用者传回来。规则：
 *   · 每个特征的幅度乘以 min(1, 置信度 / confidenceRef)（没有置信度时按 1）；open、round、舌再乘响度门 smooth(level / levelFloor)。
 *   · open → 下颌张开 open × openJaw × jaw.max，并按 open 给 AU25（唇随下颌分开）；tongue.low 不单独用，等于 open。
 *   · round > 0 混入 roundViseme 的唇形，round < 0 混入 spreadViseme 的（圆唇与舌后缩在声学上分不开，置信度低，幅度自然减小）。
 *   · closure ≥ closureThreshold 视为“有闭合、部位不明”：做成一般的闭唇（lip_seal），幅度 = 置信度比例；低于阈值不闭。
 *   · tongue.tip 携带咝音：混入 sibilantViseme 的唇形，并把下颌收到 (1 − 0.8 × tip)（牙几乎合上）。
 *   · dental 不使用（该特征不可靠）；唇齿口形只能经命名的视位得到。
 *   · 时间上做一阶平滑，时间常数 smoothSeconds：x ← x + (目标 − x) × (1 − exp(−dt / τ))。
 * One frame of raw audio features → mouth shape and channels (the same channels as the viseme route). A pure function: the caller
 * passes the previous state back in. Rules: every feature's amplitude is multiplied by min(1, confidence / confidenceRef) (1 when no
 * confidence is given), and open, round and tongue also by the loudness gate smooth(level / levelFloor); open → a jaw opening of
 * open × openJaw × jaw.max, with AU25 following (the lips part with the jaw), tongue.low being the same thing as open; round > 0 blends
 * in the lip shape of roundViseme and round < 0 that of spreadViseme (rounding cannot be told from tongue backing acoustically, so its
 * confidence is low and its amplitude shrinks accordingly); closure ≥ closureThreshold counts as "a closure of unknown place" and
 * becomes a generic lip seal with amplitude = the confidence ratio, nothing below the threshold; tongue.tip carries sibilance — it
 * blends in the lip shape of sibilantViseme and narrows the jaw to (1 − 0.8 × tip) (teeth nearly together); `dental` is not used
 * (the feature is unreliable), so labiodental shapes are available through named visemes only; a one-pole smoothing in time with
 * time constant smoothSeconds: x ← x + (target − x) × (1 − exp(−dt / τ)).
 */
export function mouthFrameToChannels(face: FaceForMouth & Pick<FaceData, 'visemes'>, frame: MouthFeatureFrame, prev?: MouthState): { state: MouthState; pose: MouthPose; channels: Activations; jaw: number } {
  const cfg = face.visemes?.features
  const table = face.visemes?.visemes ?? []
  const P = cfg ?? { openJaw: 0.45, roundViseme: '', spreadViseme: '', sibilantViseme: '', closureThreshold: 0.5, confidenceRef: 0.6, smoothSeconds: 0.05, levelFloor: 0.03 }
  const conf = (k: 'open' | 'round' | 'closure' | 'tongue'): number => clamp((frame.confidence?.[k] ?? 1) / Math.max(1e-6, P.confidenceRef), 0, 1)
  const gate = smooth(frame.level / Math.max(1e-6, P.levelFloor))
  const target = {
    open: clamp(frame.open, 0, 1) * conf('open') * gate,
    round: clamp(frame.round, -1, 1) * conf('round') * gate,
    closure: frame.closure >= P.closureThreshold ? conf('closure') : 0,
    tip: clamp(frame.tongue.tip, 0, 1) * conf('tongue') * gate,
    front: clamp(frame.tongue.front, 0, 1) * conf('tongue') * gate,
    back: clamp(frame.tongue.back, 0, 1) * conf('tongue') * gate,
  }
  const dt = prev ? frame.t - prev.t : Infinity
  const k = prev && dt > 0 && dt < 0.5 ? 1 - Math.exp(-dt / Math.max(1e-6, P.smoothSeconds)) : 1
  const mix = (key: keyof typeof target): number => (prev ? prev[key] + (target[key] - prev[key]) * k : target[key])
  const state: MouthState = { t: frame.t, open: mix('open'), round: mix('round'), closure: mix('closure'), tip: mix('tip'), front: mix('front'), back: mix('back') }
  const aus: AUs = {}
  const addShape = (id: string, w: number): void => {
    const v = table.find((x) => x.id === id)
    if (!v || w <= 0) return
    for (const [au, x] of Object.entries(v.aus)) aus[au] = clamp((aus[au] ?? 0) + x * w, 0, AU_MAX)
  }
  addShape(P.roundViseme, Math.max(0, state.round))
  addShape(P.spreadViseme, Math.max(0, -state.round))
  addShape(P.sibilantViseme, state.tip)
  aus.AU25 = Math.max(aus.AU25 ?? 0, 3 * clamp(state.open * 4, 0, 1))
  const pose: MouthPose = { aus, closure: clamp(state.closure, 0, 1), dental: 0, jaw: state.open * P.openJaw * face.jaw.max * (1 - 0.8 * state.tip), tongue: { tip: state.tip, front: state.front, back: state.back, low: state.open } }
  return { state, pose, ...mouthChannels(face, pose) }
}

// —— 说话、情绪、疼痛的合成 / Blending speech, emotion and pain ——

/** 只动上半脸的 AU / the AUs of the upper face only. */
export const UPPER_FACE_AUS = ['AU1', 'AU2', 'AU4', 'AU5', 'AU6', 'AU7', 'AU9', 'AU43']

/**
 * 合成规则（本项目定的）：
 *   1. 情绪和疼痛先在 AU 上取较大者（mergeAUs）。
 *   2. 上半脸（UPPER_FACE_AUS）完全来自这组 AU：说话不动眉和眼。
 *   3. 下半脸：说话时（speaking 0–1）这组 AU 里的下半脸部分乘以 (1 − 0.6 × speaking)，然后与说话的口形在“通道”上取较大者
 *     （同一块肌肉不叠加两次）；下颌角也取较大者。
 *   4. 说话的约束优先：闭唇时把唇分开的通道（降下唇肌、提上唇肌）乘 (1 − closure)，lip_seal 按合成后的下颌角重新算，
 *     所以带着张口的表情（疼痛、惊讶）说 p b m 时唇仍然合上（下颌角不超过 lip_seal 的 refJaw 时）。
 * The blend rule (this project's choice): 1. emotion and pain are merged on AUs, the larger winning (mergeAUs). 2. The upper face
 * (UPPER_FACE_AUS) comes from that set alone: speech does not move brows or eyes. 3. Lower face: while speaking (`speaking` 0–1) the
 * lower-face part of that set is multiplied by (1 − 0.6 × speaking) and then combined with the speech shape by taking the larger
 * value per CHANNEL (a muscle is never driven twice); the jaw angle is the larger too. 4. The constraints of speech win: with the
 * lips sealed, the channels that part them (depressor labii inferioris, levator labii superioris) are multiplied by (1 − closure)
 * and lip_seal is recomputed for the blended jaw angle, so p b m still close the lips under an open-mouthed expression (pain,
 * surprise) as long as the jaw stays within lip_seal's refJaw.
 *   5. baseJaw（可选，缺省 0）：下颌已经被别处（姿势面板、反射）张开的角度。返回的 jaw 是在它之上还要加的角度
 *     （baseJaw + jaw 不超过上限）；mouth_corner、lip_seal、lip_dental 按总角计算，所以下颌从别处张开时双唇音仍然合上
 *     （总角不超过 lip_seal 的 refJaw 时）。
 * 5. baseJaw (optional, default 0): the angle by which the jaw is already opened from elsewhere (pose panel, a reflex). The returned
 * `jaw` is what is to be added on top of it (baseJaw + jaw stays within the limit); mouth_corner, lip_seal and lip_dental are computed
 * for the total, so a bilabial still closes with a jaw opened from elsewhere (while the total stays within lip_seal's refJaw).
 */
export function blendFace(face: FaceForMouth, input: { speech?: MouthPose | null; speaking?: number; emotion?: AUs; pain?: AUs; baseJaw?: number }): { channels: Activations; jaw: number } {
  const expr = mergeAUs(input.emotion ?? {}, input.pain ?? {})
  const s = input.speech ? clamp(input.speaking ?? 1, 0, 1) : 0
  const scaled: AUs = {}
  for (const [id, v] of Object.entries(expr)) scaled[id] = UPPER_FACE_AUS.includes(id) ? v : v * (1 - 0.6 * s)
  const e = activations(face, scaled)
  const base = clamp(input.baseJaw ?? 0, 0, face.jaw.max)
  if (!input.speech || s === 0) {
    if (base === 0) return e
    // 只有表情：下颌的增量不超过剩余的范围，口角成形按总角 / expression only: the jaw increment stays within what is left of the range, and corner shaping follows the total
    const jawE = Math.min(e.jaw, face.jaw.max - base)
    const channels = { ...e.channels }
    if (face.jaw.max > 0 && face.channels.some((c) => c.id === 'mouth_corner')) channels.mouth_corner = clamp(Math.max(channels.mouth_corner ?? 0, (base + jawE) / face.jaw.max), 0, 1)
    return { channels, jaw: jawE }
  }
  const closure = clamp(input.speech.closure, 0, 1) * s
  const jaw = Math.max(e.jaw, input.speech.jaw * s)
  const sp = mouthChannels(face, { ...input.speech, closure, dental: input.speech.dental * s, jaw }, base)
  const channels: Activations = {}
  for (const id of new Set([...Object.keys(e.channels), ...Object.keys(sp.channels)])) {
    const parting = /^(depressor_labii_inferioris|lls)(_|$)/.test(id)
    const fromExpr = (e.channels[id] ?? 0) * (parting ? 1 - closure : 1)
    channels[id] = clamp(Math.max(fromExpr, (sp.channels[id] ?? 0) * (id.startsWith('lip_') || id === 'mouth_corner' ? 1 : s)), 0, 1)
  }
  return { channels, jaw: sp.jaw }
}
