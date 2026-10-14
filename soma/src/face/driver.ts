// 面部的总驱动：疼痛、情绪、说话三路输入合成一组通道激活和一个下颌角，查看器每帧只问这一处。
// The face driver: pain, emotion and speech are composed into one set of channel activations and one jaw angle;
// the viewer asks this one place every frame.
//
// 合成规则不在这里：全部交给 tools/face/model.ts 的 blendFace（情绪和疼痛在 AU 上取较大者；上半脸只来自这组 AU；
// 说话时表情的下半脸减弱，再与口形在通道上取较大者；下颌取较大者；闭唇优先；下颌从别处张开时按总角合唇）。
// 这里只负责取输入、定口形三个来源的优先级、做时间上的过渡。
// The blend rule is not here: it is blendFace of tools/face/model.ts (emotion and pain merge by maximum on AUs; the upper face
// comes from that set alone; while speaking the expression's lower face is attenuated and combined with the mouth shape by
// maximum per channel; the jaw is the larger; lip closures win, also for a jaw opened from elsewhere). This file only gathers the
// inputs, ranks the three sources of the mouth shape and eases them in time.
//
// 这是行为（表情、口形）的计算模型，用于教学；情绪原型的强度是本项目的假设，视位的数值一部分按实测标定、其余是假设
// （见 data/curated/face/visemes.json 的 calibration）。
// This is a computational model of behaviour (expression, mouth shape) for teaching; the intensities of the emotion prototypes
// are assumptions of this project, and the viseme numbers are partly calibrated against measurements and otherwise assumptions
// (see `calibration` in data/curated/face/visemes.json).

import { UPPER_FACE_AUS, blendFace, expressionAUs, mergeAUs, visemeAUs, type AUs, type Activations, type MouthPose, type SpeechStyle } from '../../tools/face/model.ts'
import { painFrame, setPainPaused } from '../pain/controller.ts'
import { cleanAUs, type LoadedFace } from '../pain/face.ts'
import { useApp } from '../state/store.ts'
import { sayFrame, setSayPaused } from './say.ts'
import { setSpeechPaused, speechFrame } from './speech.ts'
import type { FaceData } from './types.ts'
import { resolveStyle } from './visemeTrack.ts'
import { lidTravel } from '../look/eyesFit.ts'

/** 情绪表情从无到满强度的过渡时间，秒（假设）/ Seconds for an emotion to go from nothing to full strength (an assumption). */
export const EMOTION_SECONDS = 0.35
/** 没有视位表时口形的起止时间，秒 / Onset and offset of a mouth shape when there is no viseme table, seconds. */
const DEFAULT_VISEME_SECONDS = 0.12

export interface FaceInputs {
  /** 疼痛（含手动设定的 AU 和疼痛发声的张口）/ pain (with the manually set AUs and the mouth opening of a pain vocalisation). */
  pain: AUs
  emotion: AUs
  /** 说话的口形；没有时为 null / the mouth shape of speech; null without one. */
  speech: MouthPose | null
  /** 说话的程度 0–1 / how much is being spoken, 0–1. */
  speaking: number
  /** 下颌已经被别处（姿势面板、反射）张开的角度，弧度；缺省 0 / the angle by which the jaw is already opened from elsewhere (pose panel, a reflex), radians; 0 by default. */
  baseJaw?: number
}

export interface FaceOutput {
  /** 此刻显示的 AU 强度（皱纹层和读数用）：情绪与疼痛取较大者，说话时下半脸按合成规则减弱，再并上口形的唇部 AU。 */
  /** The AU intensities shown now (for the wrinkle layer and readouts): emotion and pain by maximum, the lower face attenuated while speaking as the blend rule says, plus the lip AUs of the mouth shape. */
  aus: AUs
  channels: Activations
  /** 下颌张开角，弧度：在 baseJaw 之上还要加的那一部分 / jaw opening, radians: the part to be added on top of baseJaw. */
  jaw: number
}

/** 一步到位的合成（纯函数）：通道和下颌来自 blendFace。 The composition in one step (pure): channels and jaw come from blendFace. */
export function composeFace(face: Pick<FaceData, 'aus' | 'jaw' | 'channels'>, input: FaceInputs): FaceOutput {
  const speech = input.speech && input.speaking > 0 ? input.speech : null
  const s = speech ? Math.min(1, Math.max(0, input.speaking)) : 0
  const { channels, jaw } = blendFace(face, { pain: input.pain, emotion: input.emotion, speech, speaking: s, baseJaw: input.baseJaw ?? 0 })
  const shown: AUs = {}
  for (const [id, v] of Object.entries(mergeAUs(input.emotion, input.pain))) shown[id] = UPPER_FACE_AUS.includes(id) ? v : v * (1 - 0.6 * s)
  const lips: AUs = {}
  if (speech) for (const [id, v] of Object.entries(speech.aus)) lips[id] = v * s
  return { aus: cleanAUs(mergeAUs(shown, lips)), channels, jaw }
}

/** 把 now 向 target 推进至多 step（逐项）；返回是否已经到位。 Moves `now` towards `target` by at most `step` per entry; returns whether it has arrived. */
export function slew(now: Record<string, number>, target: Record<string, number>, step: number): boolean {
  let done = true
  for (const id of new Set([...Object.keys(now), ...Object.keys(target)])) {
    const a = now[id] ?? 0, b = target[id] ?? 0
    const v = Math.abs(b - a) <= step ? b : a + Math.sign(b - a) * step
    if (v !== b) done = false
    if (v === 0) delete now[id]
    else now[id] = v
  }
  return done
}

export interface FaceSettings {
  expr: { id: string; strength: number } | null
  viseme: string | null
  /** 保持的视位用的风格；缺省是视位表的正常风格 / the style of the held viseme; the table's normal style by default. */
  visemeStyle?: SpeechStyle
}

/** 口形的三个来源之外的输入 / inputs besides the three sources of the mouth shape. */
export interface StepOptions {
  /** 由音素时间线得到的口形（正在播放时）：优先于由音频分析得到的 / the mouth shape from a phoneme timeline (while it plays): takes precedence over the one from audio analysis. */
  phoneme?: MouthPose | null
  /** 下颌已经被别处张开的角度，弧度 / the angle by which the jaw is already opened from elsewhere, radians. */
  baseJaw?: number
}

/**
 * 带时间过渡的驱动：情绪的 AU 逐渐趋向所设的原型；保持的视位按视位表的起止时间淡入淡出，换视位时交叉过渡；
 * 口形的来源消失后，最后一个口形按同样的时间淡出。不碰 store、不碰时钟，测试可以直接推进它。
 * The driver with easing in time: the emotion's AUs move gradually towards the set prototype; a held viseme fades in and out
 * with the viseme table's onset and offset and cross-fades when changed; once the source of the mouth shape is gone the last
 * shape fades out over the same time. No store and no clock in here, so tests can step it directly.
 */
export class FaceDriver {
  private emotion: AUs = {}
  private visemes: Record<string, number> = {}
  private speaking = 0
  private lastPose: MouthPose | null = null

  reset(): void {
    this.emotion = {}
    this.visemes = {}
    this.speaking = 0
    this.lastPose = null
  }

  /**
   * 推进 dt 秒并给出这一帧。口形的来源有三个，优先级从高到低：由音素时间线得到的（opts.phoneme）、由音频分析得到的（audio）、
   * 保持的视位。前两个在播放时才有。
   * Advance by dt seconds and return this frame. The mouth shape has three sources, in falling precedence: the one from a
   * phoneme timeline (opts.phoneme), the one from audio analysis (`audio`) and the held viseme. The first two exist only while
   * something plays.
   */
  step(face: FaceData, dt: number, settings: FaceSettings, pain: AUs, audio: MouthPose | null, opts: StepOptions = {}): FaceOutput & { animating: boolean } {
    const target = settings.expr ? expressionAUs(face.expressions, settings.expr.id, settings.expr.strength) : {}
    let settled = slew(this.emotion, target, (dt * 5) / EMOTION_SECONDS)
    const timing = face.visemes?.timing
    const known = settings.viseme && face.visemes?.visemes.some((v) => v.id === settings.viseme) ? settings.viseme : null
    const rise = dt / Math.max(1e-3, timing?.onset ?? DEFAULT_VISEME_SECONDS)
    if (!slew(this.visemes, known ? { [known]: 1 } : {}, rise)) settled = false
    const sum = Object.values(this.visemes).reduce((a, b) => a + b, 0)
    const played = opts.phoneme ?? audio
    let pose: MouthPose | null = played
    let want = played ? 1 : 0
    if (!pose && sum > 0) {
      // 权重归一：过渡中的两个视位按比例混合，幅度另由 speaking 给 / weights normalised: two visemes in transition mix in proportion, the amplitude is carried by `speaking`
      const w: Record<string, number> = {}
      for (const [id, v] of Object.entries(this.visemes)) w[id] = v / sum
      pose = visemeAUs(face, w, settings.visemeStyle)
      want = Math.min(1, sum)
    }
    if (pose) {
      this.lastPose = pose
      // 视位自己已经在淡入淡出；播放的口形一开始就是满幅（音素轨迹自己有起止，音频有响度门）
      // a viseme fades by itself; a played shape is at full amplitude from the start (a phoneme track has its own onsets and offsets, audio its loudness gate)
      this.speaking = want
    } else if (this.speaking > 0) {
      this.speaking = Math.max(0, this.speaking - dt / Math.max(1e-3, timing?.offset ?? DEFAULT_VISEME_SECONDS))
      pose = this.lastPose
      if (this.speaking > 0) settled = false
      else this.lastPose = null
    }
    const out = composeFace(face, { pain, emotion: this.emotion, speech: this.speaking > 0 ? pose : null, speaking: this.speaking, baseJaw: opts.baseJaw })
    return { ...out, animating: !settled || !!played }
  }
}

export interface FaceFrame extends FaceOutput {
  /** 是否还在变化（需要继续逐帧更新）/ Whether it is still changing (keep updating every frame). */
  animating: boolean
  /** 疼痛发声的气流（−1 吸气 … 1 呼气）/ Airflow of a pain vocalisation (−1 in … 1 out). */
  airflow: number
}

const driver = new FaceDriver()
let lastNow = 0
let cache: { now: number; face: FaceData; baseJaw: number; frame: FaceFrame } | null = null
const NONE: FaceFrame = { aus: {}, channels: {}, jaw: 0, animating: false, airflow: 0 }

/**
 * 当前这一帧的面部：查看器（主窗格和对照窗格）每帧调用。同一时刻、同一份数据只算一次。
 * baseJaw 是下颌已经被姿势面板或反射张开的角度（弧度）：闭唇和口角按总的下颌角来算，返回的 jaw 是还要加上去的部分。
 * The face of this frame: called by the viewers (main and compare pane) every frame. Computed once per time stamp and data set.
 * `baseJaw` is the angle (radians) by which the pose panel or a reflex has already opened the jaw: lip seal and corner shaping
 * are computed for the total jaw angle, and the returned `jaw` is the part still to be added.
 */
export function faceFrame(now: number, face: FaceData | null | undefined = useApp.getState().face?.data, baseJaw = 0): FaceFrame {
  if (!face) return NONE
  if (cache && cache.now === now && cache.face === face && cache.baseJaw === baseJaw) return cache.frame
  const s = useApp.getState()
  const pain = painFrame(now)
  // 对照窗格用另一副身体的数据再问一次：时间不重复推进 / the compare pane asks again with the other body's data: time is not advanced twice
  const dt = cache && cache.now === now ? 0 : lastNow ? Math.min(0.1, Math.max(0, (now - lastNow) / 1000)) : 0
  lastNow = now
  // 口形的来源，优先级从高到低：音素时间线、音频分析、保持的视位 / the sources of the mouth shape in falling precedence: phoneme timeline, audio analysis, held viseme
  const say = sayFrame(face)
  const audio = say?.kind === 'audio' ? say.pose : (speechFrame(face)?.pose ?? null)
  const out = driver.step(face, dt, { expr: s.expr, viseme: s.viseme, visemeStyle: resolveStyle(s.speechStyle, 'viseme') }, pain.aus, audio, { phoneme: say?.kind === 'phonemes' ? say.pose : null, baseJaw })
  const frame: FaceFrame = { aus: out.aus, channels: out.channels, jaw: out.jaw, animating: out.animating || pain.animating || useApp.getState().say.status === 'playing', airflow: pain.airflow }
  cache = { now, face, baseJaw, frame }
  return frame
}

/** 页面隐藏时暂停声音与计时（疼痛发声和说话的音频）/ Suspend sound and timing while the page is hidden (pain voice and speech audio). */
export function setFacePaused(paused: boolean): void {
  setPainPaused(paused)
  setSpeechPaused(paused)
  setSayPaused(paused)
  if (!paused) lastNow = 0
}

/**
 * 睑随垂直注视（写实的眼转动时）：每只眼的上下睑缘该移动多少由 lidTravel 给出（Mastropietro 等 2009），换成睑的通道激活——
 * 上睑上移用上睑提肌通道，下移用眼轮匝肌睑部（上睑）通道，下睑上移用眼轮匝肌睑部（下睑）通道；激活 = 移动量 ÷ 通道的行程。
 * 表情数据里没有降下睑的通道：下睑下移用反过来的"睑部（下睑）"位移场，记在伪通道 `drop:<通道 id>` 上（见 applyLidDrop）。
 * 返回要加到通道上的量（与表情的激活相加；真通道最多到 1，伪通道最多到 LID_DROP_MAX）。
 * Lids following vertical gaze (while the lifelike eyes turn): lidTravel (Mastropietro et al. 2009) gives how far each eye's
 * upper and lower margins should move, turned into lid-channel activations — the upper lid up through the levator palpebrae
 * channel, down through the orbicularis oculi palpebral (upper lid) channel, the lower lid up through the palpebral (lower lid)
 * channel; activation = travel ÷ the channel's excursion. The expression data have no channel that lowers the lower lid: it is lowered
 * by the palpebral (lower lid) field run backwards, recorded on the pseudo-channel `drop:<channel id>` (see applyLidDrop). Returns
 * the amounts to add to the channels (summed with the expression's activations; real channels capped at 1, pseudo-channels at
 * LID_DROP_MAX).
 */
export function lidGazeChannels(face: Pick<FaceData, 'channels'>, eyes: readonly { side: 'L' | 'R'; pitch: number; pupilDistance: number }[], gains: Readonly<Record<string, number>> = {}): Activations {
  const out: Activations = {}
  const channel = (muscle: string, side: string) => face.channels.find((c) => c.muscle === muscle && c.side === side && c.excursion > 0)
  // 每单位激活睑缘中点实际移动多少米：有标定（lidGains）就用它，否则用通道声明的行程 / how far the mid-margin really moves per unit activation, metres: the calibration (lidGains) when there is one, else the channel's declared excursion
  const gain = (c: { id: string; excursion: number }): number => gains[c.id] ?? c.excursion
  for (const e of eyes) {
    const { upper, lower } = lidTravel(e.pitch, e.pupilDistance)
    const mm = 1000
    const lift = upper > 0 ? channel('levator_palpebrae', e.side) : channel('orbicularis_oculi_palpebral_upper', e.side)
    if (lift && Math.abs(upper) > 1e-3) out[lift.id] = Math.min(1, Math.abs(upper) / (gain(lift) * mm))
    const low = channel('orbicularis_oculi_palpebral_lower', e.side)
    if (low && lower > 1e-3) out[low.id] = Math.min(1, lower / (gain(low) * mm))
    if (low && lower < -1e-3) out[LID_DROP + low.id] = Math.min(LID_DROP_MAX, -lower / (gain(low) * mm))
  }
  return out
}

/**
 * 标定睑的通道：激活为 1 时，睑缘上离眼球心水平位置最近的那个皮肤顶点竖直移动多少米（取它在通道位移场里的 y 分量）。
 * 通道声明的"行程"是沿肌肉作用线量的，到睑缘中点的竖直移动往往小一些（男性下睑约 2.1 mm 对 2.7 mm），所以按这个换算。
 * Calibrate the lid channels: at activation 1, how far (metres, vertically) the skin vertex of the lid margin nearest the eye
 * centre's horizontal position moves (the y component of its displacement in the channel's field). A channel's declared
 * "excursion" is measured along the muscle's line, and the vertical travel at mid-margin is often less (about 2.1 mm against
 * 2.7 mm for the male lower lid), so this is the conversion used.
 */
export function lidGains(face: LoadedFace, skin: string, margins: Readonly<Record<string, readonly number[]>>, rest: ArrayLike<number>, centres: readonly { side: 'L' | 'R'; x: number }[]): Record<string, number> {
  const out: Record<string, number> = {}
  const fields = face.fields.get(skin) ?? []
  for (const { side, x } of centres) {
    for (const [muscle, chain] of [['levator_palpebrae', 'upper'], ['orbicularis_oculi_palpebral_upper', 'upper'], ['orbicularis_oculi_palpebral_lower', 'lower']] as const) {
      const ch = face.data.channels.find((c) => c.muscle === muscle && c.side === side)
      const list = margins[`${chain}Lid${side}`]
      const field = ch && fields.find((f) => f.channel === ch.id)
      if (!ch || !list?.length || !field) continue
      const v = list.reduce((b, k) => (Math.abs(rest[k * 3]! - x) < Math.abs(rest[b * 3]! - x) ? k : b), list[0]!)
      const i = field.index.indexOf(v)
      const dy = i >= 0 ? Math.abs(field.delta[i * 3 + 1]!) : 0
      // 太小（场在那里几乎没有）就不标定，退回行程 / too small (the field barely reaches it): no calibration, the excursion is used
      if (dy > 0.2 * ch.excursion) out[ch.id] = dy
    }
  }
  return out
}

/** 伪通道的前缀：`drop:<通道 id>` = 把那个通道的位移场反过来用 / prefix of the pseudo-channels: `drop:<channel id>` = that channel's field run backwards */
export const LID_DROP = 'drop:'
/**
 * 反过来用时最多到多少：下睑在 −30° 要下移约 3.3 mm，而"睑部（下睑）"通道在睑缘中点每单位只移动 1.3–2.1 mm，所以允许到 2
 * （把场外推到两倍，假设）。
 * How far the reversed field may go: the lower lid must drop about 3.3 mm at −30° while the palpebral (lower lid) channel moves
 * the mid-margin only 1.3–2.1 mm per unit, so up to 2 is allowed (the field extrapolated to twice its size; an assumption).
 */
export const LID_DROP_MAX = 2

/** 把睑随注视的量加到通道激活上（就地修改）/ Add the lid coupling to channel activations (in place). */
export function addLidGaze(channels: Activations, extra: Activations): Activations {
  for (const [id, v] of Object.entries(extra)) channels[id] = Math.min(id.startsWith(LID_DROP) ? LID_DROP_MAX : 1, (channels[id] ?? 0) + v)
  return channels
}

/** 某个部件上有没有正在起作用的伪通道 / whether a pseudo-channel acts on any of these fields */
export function lidDropActive(fields: readonly { channel: string }[], channels: Activations): boolean {
  return fields.some((f) => (channels[LID_DROP + f.channel] ?? 0) > 0)
}

/**
 * 在 displacePart 之后把伪通道 `drop:<id>` 的位移减掉：out −= a · D_id。只用表情数据里已有的场，不改 face.json / face.bin。
 * After displacePart, subtract the pseudo-channels `drop:<id>`: out −= a · D_id. Uses only fields already in the face data;
 * face.json / face.bin stay as they are.
 */
export function applyLidDrop(face: LoadedFace, part: string, channels: Activations, out: Float32Array): boolean {
  let any = false
  for (const f of face.fields.get(part) ?? []) {
    const a = Math.min(LID_DROP_MAX, Math.max(0, channels[LID_DROP + f.channel] ?? 0))
    if (a === 0) continue
    any = true
    const { index, delta } = f
    for (let i = 0; i < index.length; i++) {
      const v = index[i]! * 3
      out[v] = out[v]! - a * delta[i * 3]!
      out[v + 1] = out[v + 1]! - a * delta[i * 3 + 1]!
      out[v + 2] = out[v + 2]! - a * delta[i * 3 + 2]!
    }
  }
  return any
}

/**
 * 眨眼：闭合程度 b（0–1）按 AU43（闭眼）在表情数据里的通道权重换成通道激活，与已有的激活逐项取较大者——这样眨眼和表情
 * （包括 AU43 / AU45 自己）叠在一起时不会超过完全闭合。表情数据里没有 AU45（眨眼），所以用 AU43 的通道。
 * A blink: closure b (0–1) is turned into channel activations by AU43's (eyes closed) channel weights in the face data and
 * merged with the existing activations by maximum — so a blink on top of an expression (AU43 / AU45 included) never goes past
 * full closure. The face data have no AU45 (blink), so AU43's channels are used.
 */
export function addBlink(channels: Activations, face: Pick<FaceData, 'aus'>, b: number): Activations {
  if (!(b > 0)) return channels
  const au = face.aus.find((a) => a.id === 'AU43')
  if (!au) return channels
  for (const [id, w] of Object.entries(au.channels)) channels[id] = Math.max(channels[id] ?? 0, Math.min(1, b * w))
  return channels
}

/** 测试用：清掉模块内的状态 / For tests: clear the module's state. */
export function resetFaceDriver(): void {
  driver.reset()
  lastNow = 0
  cache = null
}
