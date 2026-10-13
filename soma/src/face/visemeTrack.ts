// 由音素带动口形的纯逻辑：音素时间线 → 逐帧的视位权重 → 口形。不碰时钟、音频和 store，测试直接调用。
// The pure logic of phoneme-driven speech: a phoneme timeline → per-frame viseme weights → a mouth shape. No clock, audio or
// store in here, so tests call it directly.
//
// 协同发音的规则本身在 tools/face/model.ts 的 coarticulate（JALI 的习惯）；这里只加了一件事：按分组分别做，再逐帧取较大者。
// 普通话一个音节一组，所以圆唇的提前和延后不跨音节；英语整句一组，与直接调用 coarticulate 完全相同。
// The co-articulation rules themselves are `coarticulate` of tools/face/model.ts (the JALI habits); one thing is added here: it is
// run per group and the groups are merged by the per-frame maximum. Mandarin has one group per syllable, so anticipated and
// carried-over rounding stays inside its syllable; English is one group and equals a direct call of `coarticulate`.

import { SPEECH_STYLES, coarticulate, mouthChannels, visemeAUs, type Activations, type MouthPose, type SpeechStyle, type VisemeSegment, type VisemeTrack } from '../../tools/face/model.ts'
import { phonemesToVisemeGroups, type TtsLang, type TtsPhone, type TtsWord, type VisemeTables } from '../voice/tts.ts'
import type { FaceData, FaceVisemes } from './types.ts'

/** 界面上的风格设定：null = 缺省（保持的口形用夸张，说话用正常）/ The style setting of the UI: null = default (clear for held shapes, normal for speech). */
export type StyleSetting = 'normal' | 'clear' | null

/**
 * 设定 → 实际用的风格。保持的口形缺省用夸张（各口形才分得开），说话缺省用正常（按实测标定的朗读开度）。
 * A setting → the style really used. Held shapes default to clear (so that the shapes can be told apart) and speech to normal
 * (the read-speech openings calibrated against measurements).
 */
export function resolveStyle(setting: StyleSetting, use: 'viseme' | 'speech'): Readonly<Required<SpeechStyle>> {
  return SPEECH_STYLES[setting ?? (use === 'viseme' ? 'clear' : 'normal')]
}

/**
 * 分组的协同发音：每组各自经过 coarticulate（同一个时间范围和帧率），逐帧合并——唇和下颌的视位权重逐个取较大者，
 * 闭唇和唇齿两个约束取较大者。只有一组时就是 coarticulate 本身。
 * Grouped co-articulation: every group goes through `coarticulate` by itself (same time range and frame rate) and the results
 * are merged per frame — the larger weight per viseme for lips and for jaw, the larger of each constraint. With a single group
 * this is `coarticulate` itself.
 */
export function coarticulateGroups(groups: readonly VisemeSegment[][], visemes: FaceVisemes, opts: { fps?: number; t0?: number; t1?: number } = {}): VisemeTrack {
  const live = groups.filter((g) => g.length > 0)
  if (live.length <= 1) return coarticulate(live[0] ?? [], visemes, opts)
  const all = live.flat()
  const T = visemes.timing
  const range = { fps: opts.fps ?? 100, t0: opts.t0 ?? Math.min(...all.map((s) => s.start)) - T.lipHeavyOnset, t1: opts.t1 ?? Math.max(...all.map((s) => s.end)) + T.lipHeavyOffset }
  const tracks = live.map((g) => coarticulate(g, visemes, range))
  const frames: VisemeTrack['frames'] = tracks[0]!.frames.map((f) => ({ lips: { ...f.lips }, jaw: { ...f.jaw }, closure: f.closure, dental: f.dental }))
  for (const tr of tracks.slice(1)) {
    tr.frames.forEach((f, i) => {
      const out = frames[i]
      if (!out) return
      for (const [id, w] of Object.entries(f.lips)) out.lips[id] = Math.max(out.lips[id] ?? 0, w)
      for (const [id, w] of Object.entries(f.jaw)) out.jaw[id] = Math.max(out.jaw[id] ?? 0, w)
      out.closure = Math.max(out.closure, f.closure)
      out.dental = Math.max(out.dental, f.dental)
    })
  }
  return { fps: range.fps, t0: range.t0, frames }
}

/**
 * 一段话的视位轨迹：从 0 到 durationS，每秒 100 帧。面部数据里没有的视位用映射表里的 fallback。
 * The viseme track of one utterance: from 0 to durationS at 100 frames a second. Visemes the face data lacks are replaced by
 * the mapping table's `fallback`.
 */
export function phonemeTrack(phonemes: readonly TtsPhone[], lang: TtsLang, tables: VisemeTables, visemes: FaceVisemes, durationS: number): VisemeTrack {
  const groups = phonemesToVisemeGroups(phonemes, lang, tables, { available: visemes.visemes.map((v) => v.id) })
  return coarticulateGroups(groups, visemes, { fps: 100, t0: 0, t1: Math.max(0, durationS) })
}

/** 时刻 t（秒）落在轨迹的哪一帧；轨迹之外为 −1。 The frame of the track that time t (seconds) falls on; −1 outside it. */
export function trackIndex(track: VisemeTrack, t: number): number {
  const i = Math.round((t - track.t0) * track.fps)
  return i >= 0 && i < track.frames.length ? i : -1
}

/** 两个约束相争时过渡的陡度（见 resolveConstraints）/ how sharp the hand-over between the two constraints is (see resolveConstraints). */
const CONSTRAINT_SHARPNESS = 128

/**
 * 闭唇和唇齿两个约束不能同时满足（唇合着，下唇就不在上齿上）。协同发音把两条轨各自平滑地升降，双唇音紧挨着唇齿音时
 * （five more、books before、放不）两条会同时接近 1：照原样用，双唇音就合不上（实测唇间隙 0.6–2 mm）。这里让大的那个
 * 胜出：按 c^p / (c^p + d^p) 分配（p = 128），所以各自的时段里是完整的约束，只在交界前后约 10 ms 内交接；只有一个约束时不变。
 * The closure and dental constraints cannot both hold (with the lips sealed the lower lip is not at the upper teeth). Co-articulation
 * ramps the two tracks independently, so where a bilabial touches a labiodental (five more, books before, 放不) both approach 1
 * together; taken as they are, the bilabial does not close (a measured lip gap of 0.6–2 mm). Here the larger one wins: they are
 * weighted by c^p / (c^p + d^p) with p = 128, so each constraint is complete during its own segment and they hand over within about
 * 10 ms either side of the boundary; a constraint on its own is unchanged.
 */
export function resolveConstraints(closure: number, dental: number): { closure: number; dental: number } {
  if (!(closure > 0) || !(dental > 0)) return { closure: Math.max(0, closure), dental: Math.max(0, dental) }
  const c = Math.pow(closure, CONSTRAINT_SHARPNESS), d = Math.pow(dental, CONSTRAINT_SHARPNESS)
  const k = c + d > 0 ? c / (c + d) : 0.5
  return { closure: closure * k, dental: dental * (1 - k) }
}

/**
 * 闭唇时还要按 (1 − closure) 减弱的唇部 AU：AU22（唇成漏斗状外翻）每 1 级把合着的唇顶开约 1.1 mm（两副身体实测），
 * 而 lipHeavy 的邻居（sh、o）按协同发音会把它带到双唇音上（top shelf、cup on）。参考实现的 mouthChannels 只减弱 AU25、AU16、AU10。
 * 撮唇（AU18）不减：合着唇撮圆是真实的（不、木），对唇间隙的影响不到 0.1 mm。
 * The lip AUs that are also attenuated by (1 − closure) while the lips are sealed: AU22 (the lips funnelled and everted) pushes
 * sealed lips apart by about 1.1 mm per level (measured on both bodies), and a lip-heavy neighbour (sh, o) carries it onto a
 * bilabial through co-articulation (top shelf, cup on). mouthChannels of the reference attenuates AU25, AU16 and AU10 only.
 * The pucker (AU18) is kept: rounding with the lips sealed is real (as in 不, 木) and moves the lip gap by under 0.1 mm.
 */
const SEALED_OUT = ['AU22']

/**
 * 轨迹的一帧 → 口形（和通道）。两个约束先经 resolveConstraints；闭唇时 SEALED_OUT 里的 AU 按 (1 − closure) 减弱。
 * One frame of the track → a mouth shape (with channels). The two constraints go through resolveConstraints first, and while the
 * lips are sealed the AUs of SEALED_OUT are attenuated by (1 − closure).
 */
export function trackPose(face: Pick<FaceData, 'aus' | 'jaw' | 'channels' | 'visemes'>, track: VisemeTrack, index: number, style: SpeechStyle = {}): (MouthPose & { channels: Activations }) | null {
  const f = track.frames[index]
  if (!f) return null
  const { channels: _unused, ...pose } = visemeAUs(face, { lips: f.lips, jaw: f.jaw, ...resolveConstraints(f.closure, f.dental) }, style)
  if (pose.closure > 0) {
    const aus = { ...pose.aus }
    for (const id of SEALED_OUT) if (aus[id]) aus[id] = aus[id]! * (1 - pose.closure)
    pose.aus = aus
  }
  return { ...pose, channels: mouthChannels(face, pose).channels }
}

/** 时刻 t 正在说的音和词（界面显示用）；停顿时 phone 为 null。 The sound and word being spoken at time t (for display); `phone` is null in a pause. */
export function spokenAt(phonemes: readonly TtsPhone[], words: readonly TtsWord[], t: number): { phone: TtsPhone | null; word: TtsWord | null; wordIndex: number } {
  const phone = phonemes.find((p) => t >= p.t0 && t < p.t1 && p.phone !== 'sil') ?? null
  let wordIndex = words.findIndex((w) => t >= w.t0 && t < w.t1)
  if (wordIndex < 0 && phone && phone.word !== null && phone.word !== undefined && words[phone.word]) wordIndex = phone.word
  return { phone, word: wordIndex >= 0 ? words[wordIndex]! : null, wordIndex }
}
