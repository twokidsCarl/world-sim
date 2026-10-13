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
import { cleanAUs } from '../pain/face.ts'
import { useApp } from '../state/store.ts'
import { sayFrame, setSayPaused } from './say.ts'
import { setSpeechPaused, speechFrame } from './speech.ts'
import type { FaceData } from './types.ts'
import { resolveStyle } from './visemeTrack.ts'

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

/** 测试用：清掉模块内的状态 / For tests: clear the module's state. */
export function resetFaceDriver(): void {
  driver.reset()
  lastNow = 0
  cache = null
}
