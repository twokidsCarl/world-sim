// LibriSpeech 示例包上的基准：同一段真人录音，口形"按音素"（对齐的音素 → 视位 → 协同发音）和"按音频分析"（mouthTrack）
// 各走一遍，比较下颌角的时间序列，并在每个双唇音（P B M）的中点量两种方式下的唇间隙。数值写回清单，随仓库附带，
// 以后改了 mouthTrack 或视位表，重跑就能看出变好还是变坏。
// A benchmark on the LibriSpeech example pack: the same real recording drives the mouth "by phoneme" (aligned phones → visemes →
// co-articulation) and "by audio analysis" (mouthTrack); the jaw-angle time series of the two are compared, and at the middle of
// every bilabial (P B M) the lip gap is measured in both modes. The numbers are written back into the manifest and ship with the
// repository, so a later change to mouthTrack or the viseme table shows, on re-running, whether it got better or worse.
//
// 口径 / Definitions
//   · 每秒 100 帧，帧 i 是时刻 i / 100 秒；两条路线的口形和应用里完全一样：按音素 = trackPose（说话的缺省风格"正常"），
//     按音频 = 从第 0 帧起逐帧的 mouthFrameToChannels（与 FeatureStepper 相同）。
//     100 frames a second, frame i at i / 100 s; both routes give exactly the app's shapes: by phoneme = trackPose (speech's default
//     style, "normal"), by audio = mouthFrameToChannels frame by frame from frame 0 (as FeatureStepper does).
//   · 下颌角的相关：Pearson r，全部帧、只算说话的帧（非停顿音之内）；再在 ±150 ms 内找相关最大的时滞（正值 = 按音频的晚）。
//     两条路线的幅度标定不同（按音频不受风格开关影响），所以看相关，平均值只作参考。
//     Jaw-angle correlation: Pearson r over all frames and over speech frames only (inside non-pause phones); then the lag within
//     ±150 ms that maximises it (positive = the audio route is later). The two routes are scaled differently (the audio route ignores
//     the style switch), hence the correlation; the means are for reference only.
//   · 唇间隙：男性人体，CPU 参考实现（形变通道 + 蒙皮），blendFace 合成后上下唇缘竖直距离在中间 60% 上的最大绝对值，毫米；
//     ≤ 0.3 mm 算合上（与 tests/app-speech.test.ts 的阈值相同）。
//     Lip gap: the male body, the CPU reference (deformation channels + skinning), after blendFace, the largest absolute vertical
//     distance between the upper and lower lip margins over the middle 60 %, in millimetres; ≤ 0.3 mm counts as sealed (the
//     threshold of tests/app-speech.test.ts).

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rig } from '../../src/anatomy/types.ts'
import type { FaceData, FaceOpenings } from '../../src/face/types.ts'
import { phonemeTrack, trackIndex, trackPose } from '../../src/face/visemeTrack.ts'
import { mouthTrack } from '../../src/voice/mouth.ts'
import type { PhonemesEn, TtsPhone, VisemesZh } from '../../src/voice/tts.ts'
import { SPEECH_STYLES, blendFace, deform, mouthFrameToChannels, type MouthPose, type MouthState } from '../../tools/face/model.ts'
import { readBody } from '../rig/io.ts'
import { Poser } from '../rig/pose.ts'
import { ROOT } from './corpus.ts'
import { decodeWav } from './wav.ts'

export const BILABIALS = ['P', 'B', 'M']
/** 唇间隙不超过它算合上，毫米 / a lip gap at most this counts as sealed, mm. */
export const SEALED_MM = 0.3
const MAX_LAG = 15

export interface DriveSeries {
  /** 每帧的口形：按音素、按音频 / the shape of every frame: by phoneme, by audio. */
  phone: MouthPose[]
  audio: MouthPose[]
  /** 这一帧是否在说话（非停顿音之内）/ whether the frame lies inside a non-pause phone. */
  speech: boolean[]
}

/** 一段的两条路线，逐帧 / both routes of one clip, frame by frame. */
export function driveSeries(face: FaceData, tables: { en: PhonemesEn; zh: VisemesZh }, clip: { phonemes: TtsPhone[]; durationS: number }, pcm: Float32Array, rate: number): DriveSeries {
  const track = phonemeTrack(clip.phonemes, 'en', tables, face.visemes!, clip.durationS)
  const frames = mouthTrack(pcm, rate)
  const n = Math.min(frames.length, Math.floor(clip.durationS * 100))
  const phone: MouthPose[] = [], audio: MouthPose[] = [], speech: boolean[] = []
  let st: MouthState | undefined
  for (let i = 0; i < n; i++) {
    const r = mouthFrameToChannels(face, frames[i]!, st)
    st = r.state
    audio.push(r.pose)
    phone.push(trackPose(face, track, trackIndex(track, i / 100), SPEECH_STYLES.normal)!)
    const t = i / 100
    speech.push(clip.phonemes.some((p) => p.phone !== 'sil' && t >= p.t0 && t < p.t1))
  }
  return { phone, audio, speech }
}

export function pearson(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 2) return NaN
  let ma = 0, mb = 0
  for (let i = 0; i < n; i++) (ma += a[i]!), (mb += b[i]!)
  ma /= n
  mb /= n
  let sab = 0, saa = 0, sbb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma, y = b[i]! - mb
    sab += x * y
    saa += x * x
    sbb += y * y
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000
const deg = (rad: number): number => (rad * 180) / Math.PI

/** 不用网格的那部分数值（测试里重算核对）/ The numbers that need no mesh (recomputed in the tests). */
export function jawStats(s: DriveSeries): { jawR: number; jawRSpeech: number; bestLagMs: number; jawRBestLag: number; jawMeanDeg: { phone: number; audio: number } } {
  const p = s.phone.map((x) => x.jaw), a = s.audio.map((x) => x.jaw)
  const ps = p.filter((_, i) => s.speech[i]), as = a.filter((_, i) => s.speech[i])
  let best = { lag: 0, r: pearson(p, a) }
  for (let lag = -MAX_LAG; lag <= MAX_LAG; lag++) {
    // 按音频晚 lag 帧：拿按音素的第 i 帧对按音频的第 i + lag 帧 / the audio route later by `lag` frames: phone frame i against audio frame i + lag
    const pp: number[] = [], aa: number[] = []
    for (let i = 0; i < p.length; i++) if (i + lag >= 0 && i + lag < a.length) (pp.push(p[i]!), aa.push(a[i + lag]!))
    const r = pearson(pp, aa)
    if (r > best.r + 1e-12) best = { lag, r }
  }
  const mean = (v: number[]): number => v.reduce((x, y) => x + y, 0) / Math.max(1, v.length)
  return { jawR: r3(pearson(p, a)), jawRSpeech: r3(pearson(ps, as)), bestLagMs: best.lag * 10, jawRBestLag: r3(best.r), jawMeanDeg: { phone: r3(deg(mean(ps))), audio: r3(deg(mean(as))) } }
}

/** 双唇音中点所在的帧 / the frame at the middle of every bilabial. */
export function bilabialFrames(phonemes: readonly TtsPhone[], n: number): { phone: string; t: number; frame: number }[] {
  return phonemes.filter((p) => BILABIALS.includes(p.phone)).map((p) => ({ phone: p.phone, t: r3((p.t0 + p.t1) / 2), frame: Math.min(n - 1, Math.round(((p.t0 + p.t1) / 2) * 100)) }))
}

interface ManifestClip {
  file: string
  durationS: number
  phonemes: TtsPhone[]
  bench?: unknown
}

export async function runBench(outDir: string): Promise<void> {
  const DIR = join(ROOT, 'public/anatomy/male')
  const json = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T
  const face = json<FaceData>(join(DIR, 'face.json'))
  const O = json<FaceOpenings>(join(DIR, 'face/openings.json'))
  const rig = json<Rig>(join(DIR, 'rig.json'))
  const rigBin = new Uint8Array(readFileSync(join(DIR, 'rig.bin')))
  const bin = new Uint8Array(readFileSync(join(DIR, 'face.bin')))
  const tables = { en: json<PhonemesEn>(join(ROOT, 'data/curated/face/phonemes-en.json')), zh: json<VisemesZh>(join(ROOT, 'data/curated/face/visemes-zh.json')) }
  const body = await readBody(DIR)
  const rest = body.meshes.get(face.skin)!.positions
  const lipGap = (pose: MouthPose): number => {
    const out = blendFace(face, { speech: pose, speaking: 1 })
    const p = out.jaw > 0 ? { [face.jaw.joint]: Array.from({ length: face.jaw.dof + 1 }, (_, k) => (k === face.jaw.dof ? out.jaw : 0)) } : {}
    const pos = new Poser(rig, rigBin, p).part(face.skin, deform(face.channels, bin, face.skin, rest, out.channels), 'dqs', false)
    const g = O.margins.upperLip.map((u, i) => pos[u * 3 + 1]! - pos[O.margins.lowerLip[i]! * 3 + 1]!)
    return Math.max(...g.slice(Math.round(g.length * 0.2), Math.round(g.length * 0.8)).map(Math.abs)) * 1000
  }
  const path = join(outDir, 'manifest.json')
  const manifest = json<{ clips: ManifestClip[]; benchmark?: unknown } & Record<string, unknown>>(path)
  const all = { phoneGap: [] as number[], audioGap: [] as number[], jawR: [] as number[], jawRSpeech: [] as number[], jawRBestLag: [] as number[], lags: [] as number[] }
  for (const c of manifest.clips) {
    const wav = decodeWav(new Uint8Array(readFileSync(join(outDir, c.file))))
    const s = driveSeries(face, tables, c, wav.samples, wav.sampleRate)
    const jaw = jawStats(s)
    const bil = bilabialFrames(c.phonemes, s.phone.length).map((b) => {
      const gp = lipGap(s.phone[b.frame]!), ga = lipGap(s.audio[b.frame]!)
      all.phoneGap.push(gp)
      all.audioGap.push(ga)
      return { phone: b.phone, t: b.t, closure: { phone: r3(s.phone[b.frame]!.closure), audio: r3(s.audio[b.frame]!.closure) }, gapMm: { phone: r3(gp), audio: r3(ga) } }
    })
    all.jawR.push(jaw.jawR)
    all.jawRSpeech.push(jaw.jawRSpeech)
    all.jawRBestLag.push(jaw.jawRBestLag)
    all.lags.push(jaw.bestLagMs)
    const sealed = (k: 'phone' | 'audio'): number => bil.filter((b) => b.gapMm[k] <= SEALED_MM).length
    c.bench = { frames: s.phone.length, ...jaw, bilabials: bil, sealed: { phone: sealed('phone'), audio: sealed('audio'), of: bil.length } }
    console.log(`${c.file.padEnd(28)} jaw r ${jaw.jawR.toFixed(3)} (speech ${jaw.jawRSpeech.toFixed(3)}; best ${jaw.jawRBestLag.toFixed(3)} at ${jaw.bestLagMs} ms)  mean jaw ${jaw.jawMeanDeg.phone.toFixed(2)}° / ${jaw.jawMeanDeg.audio.toFixed(2)}°  sealed bilabials ${sealed('phone')}/${bil.length} by phoneme, ${sealed('audio')}/${bil.length} by audio`)
  }
  const mean = (v: number[]): number => r3(v.reduce((x, y) => x + y, 0) / v.length)
  const median = (v: number[]): number => {
    const s = [...v].sort((x, y) => x - y)
    return r3(s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2)
  }
  const n = all.phoneGap.length
  manifest.benchmark = {
    method: {
      zh: '由 bun tools/voice/librispeech-demo.ts bench 写入（见 tools/voice/librispeech-bench.ts）。男性人体；按音素用说话的缺省风格"正常"。jawR：两种方式下颌角（每秒 100 帧）的 Pearson 相关，全部帧；jawRSpeech：只算说话的帧；bestLagMs / jawRBestLag：±150 ms 内相关最大的时滞（正值 = 按音频的晚）和那时的相关。唇间隙：每个双唇音（P B M）中点那一帧，blendFace 合成后上下唇缘在中间 60% 上的最大竖直距离（毫米，CPU 参考实现），≤ 0.3 mm 算合上。时间线是自动对齐，不是人工标注。',
      en: 'Written by bun tools/voice/librispeech-demo.ts bench (see tools/voice/librispeech-bench.ts). Male body; by phoneme uses speech\'s default style, "normal". jawR: Pearson correlation of the jaw angle of the two modes (100 frames a second) over all frames; jawRSpeech: over speech frames only; bestLagMs / jawRBestLag: the lag within ±150 ms with the highest correlation (positive = the audio route is later) and that correlation. Lip gap: at the middle frame of every bilabial (P B M), the largest vertical distance between the upper and lower lip margins over the middle 60 % after blendFace (mm, CPU reference); ≤ 0.3 mm counts as sealed. The timelines are automatic alignments, not hand labels.',
    },
    body: 'male',
    style: 'normal',
    clips: manifest.clips.length,
    jawR: { mean: mean(all.jawR), min: r3(Math.min(...all.jawR)), max: r3(Math.max(...all.jawR)) },
    jawRSpeech: { mean: mean(all.jawRSpeech), min: r3(Math.min(...all.jawRSpeech)), max: r3(Math.max(...all.jawRSpeech)) },
    jawRBestLag: { mean: mean(all.jawRBestLag), lagMsMedian: median(all.lags) },
    bilabials: {
      n,
      sealed: { phone: all.phoneGap.filter((g) => g <= SEALED_MM).length, audio: all.audioGap.filter((g) => g <= SEALED_MM).length },
      gapMm: { phone: { median: median(all.phoneGap), max: r3(Math.max(...all.phoneGap)) }, audio: { median: median(all.audioGap), max: r3(Math.max(...all.audioGap)) } },
    },
  }
  // benchmark 放在 clips 前面 / benchmark goes before clips
  const { clips, ...head } = manifest
  writeFileSync(path, `${JSON.stringify({ ...head, clips }, null, 1)}\n`)
  console.log(JSON.stringify(manifest.benchmark, null, 1).replace(/"method": \{[\s\S]*?\n \},\n/, ''))
}
