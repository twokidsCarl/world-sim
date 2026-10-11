// 入口：bun tools/voice/pack.ts
// 从本机的 VIVAE 语料（data/raw/voice/，不入库）重新生成录音包 public/voice/vivae-pain/：
// 只取文件名中情绪为 pain 的录音，重采样到 24 kHz、16 位单声道 WAV，另加逐条的分析和清单。
// 整个过程不调用外部编码器，同样的输入总是得到逐字节相同的输出。
// 录音包整体按 CC BY-NC 4.0 授权（仅限非商业使用），与本仓库的 CC BY-SA 解剖数据和 MIT 代码分开。
// Entry point: bun tools/voice/pack.ts
// Regenerates the sound pack public/voice/vivae-pain/ from the local VIVAE corpus (data/raw/voice/,
// not committed): only recordings whose file name gives the emotion as pain, resampled to 24 kHz
// 16-bit mono WAV, plus per-clip analysis and a manifest. No external encoder is involved, so the same
// input always yields byte-identical output. The pack as a whole is licensed CC BY-NC 4.0
// (non-commercial use only) and is kept apart from this repository's CC BY-SA anatomy data and MIT code.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACK_FRAME_RATE, type PackClip, type PackLevel, type PackManifest } from '../../src/voice/pack.ts'
import { resample } from '../../src/voice/resample.ts'
import { analyseFrames, DEFAULT_ANALYSIS, fft, measure } from './analysis.ts'
import { ROOT, VIVAE_DIR } from './corpus.ts'
import { decodeWav, encodeWav } from './wav.ts'

export const PACK_DIR = join(ROOT, 'public/voice/vivae-pain')
export const PACK_SAMPLE_RATE = 24000

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// 张口度的估计：500–2000 Hz 与 80–500 Hz 两个频带的能量比（dB）线性映到 0–1（−6 dB → 0，+18 dB → 1），
// 再乘以一个随帧电平开合的门（比全段最响一帧低 30 dB 时为 0，低 15 dB 以内为 1），五帧滑动平均。
// 道理：嘴张得大时第一共振峰高，500 Hz 以上的能量多；闭着嘴哼的时候能量集中在 500 Hz 以下。
// 这是启发式估计，没有用任何口型数据验证过。
// The mouth-opening estimate: the energy ratio (dB) between the bands 500–2000 Hz and 80–500 Hz mapped
// linearly to 0–1 (−6 dB → 0, +18 dB → 1), multiplied by a gate that follows the frame level (0 at
// 30 dB below the loudest frame, 1 within 15 dB of it), with a five-frame moving average. Rationale: a
// wide-open mouth raises the first formant and puts more energy above 500 Hz, while a closed-mouth hum
// keeps its energy below 500 Hz. It is a heuristic and was not validated against any articulation data.
function mouthTrack(x: Float32Array, sampleRate: number, frames: { t: number; rmsDb: number }[]): number[] {
  const size = 1024
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  let max = -Infinity
  for (const f of frames) max = Math.max(max, f.rmsDb)
  const raw = frames.map((f) => {
    const centre = Math.round(f.t * sampleRate)
    re.fill(0); im.fill(0)
    for (let i = 0; i < size; i++) re[i] = (x[centre - size / 2 + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size))
    fft(re, im)
    let lo = 1e-12
    let hi = 1e-12
    for (let k = 1; k < size / 2; k++) {
      const hz = (k * sampleRate) / size
      const p = re[k]! * re[k]! + im[k]! * im[k]!
      if (hz >= 80 && hz < 500) lo += p
      else if (hz >= 500 && hz < 2000) hi += p
    }
    const open = clamp((10 * Math.log10(hi / lo) + 6) / 24, 0, 1)
    const gate = clamp((f.rmsDb - (max - 30)) / 15, 0, 1)
    return gate * (0.2 + 0.8 * open)
  })
  return raw.map((_, i) => {
    let s = 0
    let c = 0
    for (let j = Math.max(0, i - 2); j <= Math.min(raw.length - 1, i + 2); j++) { s += raw[j]!; c++ }
    return s / c
  })
}

export function buildPack(sourceDir = VIVAE_DIR, outDir = PACK_DIR): PackManifest {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const clips: PackClip[] = []
  // 帧中心在 0.02 + 0.01·i 秒；清单里的轨迹以 0.01·j 秒为格点，所以向后挪两帧 / frame centres sit at 0.02 + 0.01·i s; manifest tracks use a grid of 0.01·j s, hence the shift by two frames
  const shift = Math.round((DEFAULT_ANALYSIS.frameS / 2) * PACK_FRAME_RATE)
  for (const name of readdirSync(sourceDir).sort()) {
    const m = /^(S\d+)_pain_(low|moderate|strong|peak)_\d+\.wav$/.exec(name)
    if (!m) continue
    const src = decodeWav(readFileSync(join(sourceDir, name)))
    const bytes = encodeWav(resample(src.samples, src.sampleRate, PACK_SAMPLE_RATE), PACK_SAMPLE_RATE)
    writeFileSync(join(outDir, name), bytes)
    // 分析的是包里实际存放的那份音频 / the analysis is done on the audio exactly as stored in the pack
    const pcm = decodeWav(bytes).samples
    const frames = analyseFrames(pcm, PACK_SAMPLE_RATE)
    const mouth = mouthTrack(pcm, PACK_SAMPLE_RATE, frames)
    const total = Math.ceil((pcm.length / PACK_SAMPLE_RATE) * PACK_FRAME_RATE)
    const at = (j: number) => clamp(j - shift, 0, frames.length - 1)
    const levelDb: number[] = []
    const f0: number[] = []
    const mouthOut: number[] = []
    let voiced = ''
    for (let j = 0; j < total; j++) {
      const f = frames[at(j)]
      levelDb.push(f ? Math.round(f.rmsDb) : -120)
      f0.push(f && f.voiced ? Math.round(f.f0) : 0)
      voiced += f && f.voiced ? '1' : '0'
      mouthOut.push(f ? Math.round(mouth[at(j)]! * 100) : 0)
    }
    const ms = measure(pcm, PACK_SAMPLE_RATE)
    const active = frames.map((f, i) => (f.active ? mouth[i]! : NaN)).filter(Number.isFinite)
    const meanOpen = active.reduce((s, v) => s + v, 0) / Math.max(1, active.length)
    const type: PackClip['type'] = ms.voicedShare < 0.3 ? 'inhalation' : ms.f0MedianHz >= 700 ? 'scream' : ms.durationS < 0.5 && ms.f0MedianHz < 450 ? 'grunt' : meanOpen < 0.35 ? 'moan' : 'cry'
    const round = (v: number, d: number) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null)
    clips.push({
      file: name,
      level: m[2] as PackLevel,
      speaker: m[1]!,
      durationS: Number((pcm.length / PACK_SAMPLE_RATE).toFixed(3)),
      f0MeanHz: round(ms.f0MeanHz, 1),
      levelDb: round(ms.levelDb, 1) ?? -120,
      hnrDb: round(ms.hnrDb, 1),
      type,
      tracks: { levelDb, f0, voiced, mouth: mouthOut },
    })
  }
  const manifest: PackManifest = {
    _doc: {
      zh: '由 bun tools/voice/pack.ts 生成。VIVAE 语料中 185 条「身体疼痛」发声的录音（表演出来的，不是真实疼痛时的录音）及其分析。仅限非商业使用（CC BY-NC 4.0）。本目录是独立的集合，不属于本仓库的 CC BY-SA 解剖数据集，也不属于 MIT 代码；用于商业用途的构建或部署必须删除本目录，应用会自动改用参数合成器。',
      en: 'Generated by bun tools/voice/pack.ts. The 185 recordings of "physical pain" vocalisations from the VIVAE corpus (acted, not recorded during real pain) with their analysis. Non-commercial use only (CC BY-NC 4.0). This directory is a separate collection: it is not part of this repository\'s CC BY-SA anatomy dataset nor of its MIT code; a build or deployment for commercial use must delete this directory, and the app then falls back to the parametric synthesizer.',
    },
    licence: 'CC BY-NC 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
    source: {
      title: 'The Variably Intense Vocalizations of Affect and Emotion Corpus (VIVAE)',
      creators: ['Natalie Holz', 'Pauline Larrouy-Maestri', 'David Poeppel'],
      doi: '10.5281/zenodo.4066235',
      url: 'https://zenodo.org/records/4066235',
      citation: 'Holz, N., Larrouy-Maestri, P., & Poeppel, D. (2022). The Variably Intense Vocalizations of Affect and Emotion (VIVAE) corpus prompts new perspective on nonspeech perception. Emotion, 22(1), 213–225. http://dx.doi.org/10.1037/emo0001048',
    },
    changes: {
      zh: '相对原语料的改动：只选取了 full set 中情绪为 pain 的 185 个文件；从 44.1 kHz 重采样到 24 kHz（16 位单声道 WAV，文件名不变）；加入了本清单里的逐条分析（时长、平均基频、电平、谐噪比、发声类型、每秒 100 帧的轨迹）。',
      en: 'Changes from the original corpus: only the 185 files of the full set whose emotion is pain were selected; they were resampled from 44.1 kHz to 24 kHz (16-bit mono WAV, file names unchanged); the per-clip analysis in this manifest was added (duration, mean F0, level, HNR, vocalisation type, tracks at 100 frames per second).',
    },
    mouthMethod: {
      zh: '张口度是启发式估计：500–2000 Hz 与 80–500 Hz 的能量比（−6 dB → 0，+18 dB → 1），乘以随帧电平开合的门，五帧滑动平均。没有用口型数据验证过。',
      en: 'Mouth opening is a heuristic estimate: the energy ratio between 500–2000 Hz and 80–500 Hz (−6 dB → 0, +18 dB → 1) times a gate that follows the frame level, with a five-frame moving average. Not validated against articulation data.',
    },
    typeMethod: {
      zh: '发声类型由规则给出，不是人工标注：有声帧不到 30% → inhalation（其实只是「以气声为主」，分不出吸气还是呼气）；基频中位数 ≥ 700 Hz → scream；短于 0.5 秒且基频中位数低于 450 Hz → grunt；平均张口度估计低于 0.35 → moan；其余 → cry。',
      en: 'The vocalisation type comes from rules, not from human labels: under 30 % voiced frames → inhalation (really just "breath-dominated"; inhaling and exhaling cannot be told apart); median F0 ≥ 700 Hz → scream; shorter than 0.5 s with median F0 below 450 Hz → grunt; mean mouth-opening estimate below 0.35 → moan; otherwise → cry.',
    },
    sampleRate: PACK_SAMPLE_RATE,
    frameRate: PACK_FRAME_RATE,
    clips,
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest) + '\n')
  writeFileSync(join(outDir, 'LICENSE.txt'), LICENSE_TEXT)
  writeFileSync(join(outDir, 'ATTRIBUTION.txt'), ATTRIBUTION_TEXT)
  return manifest
}

const LICENSE_TEXT = `Everything in this directory (the audio files and manifest.json, including the
per-clip analysis derived from the recordings) is licensed under the

    Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0)

Licence deed:  https://creativecommons.org/licenses/by-nc/4.0/
Legal code:    https://creativecommons.org/licenses/by-nc/4.0/legalcode

NON-COMMERCIAL USE ONLY. You may copy, redistribute and adapt this material for
non-commercial purposes, provided you give appropriate credit (see ATTRIBUTION.txt),
provide a link to the licence, and indicate if changes were made. You may not add
terms or technological measures that restrict others from doing anything the
licence permits.

The material is offered as-is, without warranties of any kind; see Section 5 of the
legal code (Disclaimer of Warranties and Limitation of Liability).

This directory is a separate collection. It is NOT part of the CC BY-SA 4.0 anatomy
dataset in this repository and NOT covered by the MIT licence of the code. A build or
deployment for commercial use must delete this directory; the application then falls
back to its parametric synthesizer.

本目录中的全部内容（音频文件和 manifest.json，包括由录音导出的逐条分析）按
知识共享 署名-非商业性使用 4.0 国际许可协议（CC BY-NC 4.0）授权，仅限非商业使用。
本目录是独立的集合，不属于本仓库的 CC BY-SA 4.0 解剖数据集，也不适用代码的 MIT 许可；
用于商业用途的构建或部署必须删除本目录，应用会改用参数合成器。
`

const ATTRIBUTION_TEXT = `VIVAE 疼痛发声录音包

仅限非商业使用（CC BY-NC 4.0）。本目录是独立的集合：不属于本仓库的 CC BY-SA 4.0 解剖数据集，
也不属于 MIT 代码。用于商业用途的构建或部署必须删除本目录，应用会自动改用参数合成器。

来源
  标题：The Variably Intense Vocalizations of Affect and Emotion Corpus (VIVAE)
  作者：Natalie Holz、Pauline Larrouy-Maestri、David Poeppel
  发布：Zenodo，2020，DOI 10.5281/zenodo.4066235，https://zenodo.org/records/4066235
  许可：Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)
        https://creativecommons.org/licenses/by-nc/4.0/
  语料页面要求的引用：
    Holz, N., Larrouy-Maestri, P., & Poeppel, D. (2022). The Variably Intense Vocalizations of
    Affect and Emotion (VIVAE) corpus prompts new perspective on nonspeech perception.
    Emotion, 22(1), 213–225. http://dx.doi.org/10.1037/emo0001048

改动说明（本目录的内容是经过修改的）
  1. 只选取了 full set 里文件名中情绪为 pain（身体疼痛）的 185 个文件，其余 900 个没有收入。
  2. 从 44.1 kHz 重采样到 24 kHz，仍是 16 位单声道 WAV；文件名保持语料原样
     （说话人_情绪_强度_编号）。没有裁剪、没有调整响度。
  3. 新增 manifest.json：逐条的时长、平均基频、电平、谐噪比、按规则判定的发声类型，
     以及每秒 100 帧的电平、基频、有声标志和张口度估计。这些分析不是原语料的一部分，
     出自本项目，未经专业人员审校。
  重新生成：bun tools/voice/pack.ts（需要先把语料下载到 data/raw/voice/）。

说明
  这些是按指令表演出来的发声，不是真实疼痛时的录音。本项目是用于教学的疼痛行为计算模型，
  被模拟的身体没有主观体验。原作者没有为本项目背书。材料按原样提供，不附带任何担保。

--------------------------------------------------------------------------------

VIVAE pain vocalisation sound pack

NON-COMMERCIAL USE ONLY (CC BY-NC 4.0). This directory is a separate collection: it is not
part of this repository's CC BY-SA 4.0 anatomy dataset and not part of its MIT-licensed code.
A build or deployment for commercial use must delete this directory; the application then
falls back to its parametric synthesizer.

Source
  Title:    The Variably Intense Vocalizations of Affect and Emotion Corpus (VIVAE)
  Creators: Natalie Holz, Pauline Larrouy-Maestri, David Poeppel
  Published: Zenodo, 2020, DOI 10.5281/zenodo.4066235, https://zenodo.org/records/4066235
  Licence:  Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)
            https://creativecommons.org/licenses/by-nc/4.0/
  Citation requested by the corpus record:
    Holz, N., Larrouy-Maestri, P., & Poeppel, D. (2022). The Variably Intense Vocalizations of
    Affect and Emotion (VIVAE) corpus prompts new perspective on nonspeech perception.
    Emotion, 22(1), 213–225. http://dx.doi.org/10.1037/emo0001048

Changes made (the contents of this directory are modified from the original)
  1. Selection: only the 185 files of the full set whose file name gives the emotion as pain
     (physical pain); the other 900 files are not included.
  2. Re-encoding: resampled from 44.1 kHz to 24 kHz, still 16-bit mono WAV; file names are
     kept as in the corpus (speaker_emotion_intensity_item). No trimming, no loudness change.
  3. Added manifest.json: per clip the duration, mean F0, level, harmonics-to-noise ratio, a
     rule-based vocalisation type, and tracks at 100 frames per second (level, F0, voiced flag,
     a mouth-opening estimate). This analysis is not part of the original corpus; it was made
     by this project and has not been reviewed by a specialist.
  To regenerate: bun tools/voice/pack.ts (after downloading the corpus into data/raw/voice/).

Notes
  These are vocalisations acted on instruction, not recordings made during real pain. This
  project is a computational model of pain behaviour for teaching; the simulated body has no
  subjective experience. The original authors do not endorse this project. The material is
  provided as-is, without warranties of any kind.
`

if (import.meta.main) {
  if (!existsSync(VIVAE_DIR)) throw new Error('VIVAE corpus not found under data/raw/voice/; download Zenodo record 4066235 first')
  const t0 = performance.now()
  const manifest = buildPack()
  const count = (k: string) => manifest.clips.filter((c) => c.level === k || c.type === k).length
  console.log(`wrote ${manifest.clips.length} clips to public/voice/vivae-pain/ in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  console.log(`levels: ${['low', 'moderate', 'strong', 'peak'].map((k) => `${k} ${count(k)}`).join(', ')}`)
  console.log(`types: ${['inhalation', 'grunt', 'moan', 'cry', 'scream'].map((k) => `${k} ${count(k)}`).join(', ')}`)
}
