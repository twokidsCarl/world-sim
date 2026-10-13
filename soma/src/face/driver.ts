// 面部的总驱动：疼痛、情绪、说话三路输入合成一组通道激活和一个下颌角，查看器每帧只问这一处。
// The face driver: pain, emotion and speech are composed into one set of channel activations and one jaw angle;
// the viewer asks this one place every frame.
//
// 合成规则不在这里：全部交给 tools/face/model.ts 的 blendFace（情绪和疼痛在 AU 上取较大者；上半脸只来自这组 AU；
// 说话时表情的下半脸减弱，再与口形在通道上取较大者；下颌取较大者；闭唇优先）。这里只负责取输入、做时间上的过渡。
// The blend rule is not here: it is blendFace of tools/face/model.ts (emotion and pain merge by maximum on AUs; the upper face
// comes from that set alone; while speaking the expression's lower face is attenuated and combined with the mouth shape by
// maximum per channel; the jaw is the larger; lip closures win). This file only gathers the inputs and eases them in time.
//
// 这是行为（表情、口形）的计算模型，用于教学；情绪原型的强度和视位的数值都是本项目的假设。
// This is a computational model of behaviour (expression, mouth shape) for teaching; the intensities of the emotion prototypes
// and the viseme numbers are assumptions of this project.

import { UPPER_FACE_AUS, blendFace, expressionAUs, mergeAUs, visemeAUs, type AUs, type Activations, type MouthPose } from '../../tools/face/model.ts'
import { painFrame, setPainPaused } from '../pain/controller.ts'
import { cleanAUs } from '../pain/face.ts'
import { useApp } from '../state/store.ts'
import { setSpeechPaused, speechFrame } from './speech.ts'
import type { FaceData } from './types.ts'

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
}

export interface FaceOutput {
  /** 此刻显示的 AU 强度（皱纹层和读数用）：情绪与疼痛取较大者，说话时下半脸按合成规则减弱，再并上口形的唇部 AU。 */
  /** The AU intensities shown now (for the wrinkle layer and readouts): emotion and pain by maximum, the lower face attenuated while speaking as the blend rule says, plus the lip AUs of the mouth shape. */
  aus: AUs
  channels: Activations
  /** 下颌张开角，弧度 / jaw opening, radians. */
  jaw: number
}

/** 一步到位的合成（纯函数）：通道和下颌来自 blendFace。 The composition in one step (pure): channels and jaw come from blendFace. */
export function composeFace(face: Pick<FaceData, 'aus' | 'jaw' | 'channels'>, input: FaceInputs): FaceOutput {
  const speech = input.speech && input.speaking > 0 ? input.speech : null
  const s = speech ? Math.min(1, Math.max(0, input.speaking)) : 0
  const { channels, jaw } = blendFace(face, { pain: input.pain, emotion: input.emotion, speech, speaking: s })
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
   * 推进 dt 秒并给出这一帧。audio 是由音频得到的口形（正在播放时），优先于保持的视位。
   * Advance by dt seconds and return this frame. `audio` is the mouth shape from audio (while it plays) and takes precedence
   * over a held viseme.
   */
  step(face: FaceData, dt: number, settings: FaceSettings, pain: AUs, audio: MouthPose | null): FaceOutput & { animating: boolean } {
    const target = settings.expr ? expressionAUs(face.expressions, settings.expr.id, settings.expr.strength) : {}
    let settled = slew(this.emotion, target, (dt * 5) / EMOTION_SECONDS)
    const timing = face.visemes?.timing
    const known = settings.viseme && face.visemes?.visemes.some((v) => v.id === settings.viseme) ? settings.viseme : null
    const rise = dt / Math.max(1e-3, timing?.onset ?? DEFAULT_VISEME_SECONDS)
    if (!slew(this.visemes, known ? { [known]: 1 } : {}, rise)) settled = false
    const sum = Object.values(this.visemes).reduce((a, b) => a + b, 0)
    let pose: MouthPose | null = audio
    let want = audio ? 1 : 0
    if (!pose && sum > 0) {
      // 权重归一：过渡中的两个视位按比例混合，幅度另由 speaking 给 / weights normalised: two visemes in transition mix in proportion, the amplitude is carried by `speaking`
      const w: Record<string, number> = {}
      for (const [id, v] of Object.entries(this.visemes)) w[id] = v / sum
      pose = visemeAUs(face, w)
      want = Math.min(1, sum)
    }
    if (pose) {
      this.lastPose = pose
      // 视位自己已经在淡入淡出；音频一开始就是满幅（它自己有响度门）/ a viseme fades by itself; audio is at full amplitude from the start (it has its own loudness gate)
      this.speaking = want
    } else if (this.speaking > 0) {
      this.speaking = Math.max(0, this.speaking - dt / Math.max(1e-3, timing?.offset ?? DEFAULT_VISEME_SECONDS))
      pose = this.lastPose
      if (this.speaking > 0) settled = false
      else this.lastPose = null
    }
    const out = composeFace(face, { pain, emotion: this.emotion, speech: this.speaking > 0 ? pose : null, speaking: this.speaking })
    return { ...out, animating: !settled || !!audio }
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
let cache: { now: number; face: FaceData; frame: FaceFrame } | null = null
const NONE: FaceFrame = { aus: {}, channels: {}, jaw: 0, animating: false, airflow: 0 }

/**
 * 当前这一帧的面部：查看器（主窗格和对照窗格）每帧调用。同一时刻、同一份数据只算一次。
 * The face of this frame: called by the viewers (main and compare pane) every frame. Computed once per time stamp and data set.
 */
export function faceFrame(now: number, face: FaceData | null | undefined = useApp.getState().face?.data): FaceFrame {
  if (!face) return NONE
  if (cache && cache.now === now && cache.face === face) return cache.frame
  const s = useApp.getState()
  const pain = painFrame(now)
  // 对照窗格用另一副身体的数据再问一次：时间不重复推进 / the compare pane asks again with the other body's data: time is not advanced twice
  const dt = cache && cache.now === now ? 0 : lastNow ? Math.min(0.1, Math.max(0, (now - lastNow) / 1000)) : 0
  lastNow = now
  const audio = speechFrame(face)
  const out = driver.step(face, dt, { expr: s.expr, viseme: s.viseme }, pain.aus, audio?.pose ?? null)
  const frame: FaceFrame = { aus: out.aus, channels: out.channels, jaw: out.jaw, animating: out.animating || pain.animating, airflow: pain.airflow }
  cache = { now, face, frame }
  return frame
}

/** 页面隐藏时暂停声音与计时（疼痛发声和说话的音频）/ Suspend sound and timing while the page is hidden (pain voice and speech audio). */
export function setFacePaused(paused: boolean): void {
  setPainPaused(paused)
  setSpeechPaused(paused)
  if (!paused) lastNow = 0
}

/** 测试用：清掉模块内的状态 / For tests: clear the module's state. */
export function resetFaceDriver(): void {
  driver.reset()
  lastNow = 0
  cache = null
}
