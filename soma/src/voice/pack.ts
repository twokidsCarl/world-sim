// 录音包的数据契约（清单的格式）。本文件是代码（MIT），不含任何录音；
// 录音包本身在 public/voice/vivae-pain/，整体按 CC BY-NC 4.0 授权，是可以整个删掉的独立目录。
// The data contract of the sound pack (the manifest format). This file is code (MIT) and contains no
// recording; the pack itself lives in public/voice/vivae-pain/, is licensed CC BY-NC 4.0 as a whole,
// and is a separate directory that can be deleted outright.

import type { VocalisationType } from './types.ts'

export type PackLevel = 'low' | 'moderate' | 'strong' | 'peak'
export const PACK_LEVELS: readonly PackLevel[] = ['low', 'moderate', 'strong', 'peak']
export const PACK_FRAME_RATE = 100

export interface PackClip {
  file: string
  // 语料文件名里的强度等级和说话人编号 / intensity level and speaker label as given by the corpus file name
  level: PackLevel
  speaker: string
  durationS: number
  // 以下是对这条录音的分析 / analysis of this recording
  f0MeanHz: number | null
  levelDb: number
  hnrDb: number | null
  type: Exclude<VocalisationType, 'none'>
  // 每秒 100 帧的轨迹，第 i 帧对应时刻 i / 100 秒 / tracks at 100 frames per second, frame i at time i / 100 s
  tracks: {
    // 帧电平，dB 相对满刻度，取整 / frame level in dB re full scale, rounded
    levelDb: number[]
    // 基频（Hz，取整），0 = 无声 / F0 (Hz, rounded), 0 = unvoiced
    f0: number[]
    // 有声标志，每帧一个字符 '0' 或 '1' / voiced flag, one character '0' or '1' per frame
    voiced: string
    // 张口度估计，百分数 0–100（方法见清单里的 mouthMethod）/ mouth-opening estimate in percent, 0–100 (method in the manifest's mouthMethod)
    mouth: number[]
  }
}

export interface PackManifest {
  _doc: { zh: string; en: string }
  licence: string
  licenceUrl: string
  source: { title: string; creators: string[]; doi: string; url: string; citation: string }
  changes: { zh: string; en: string }
  mouthMethod: { zh: string; en: string }
  typeMethod: { zh: string; en: string }
  sampleRate: number
  frameRate: number
  clips: PackClip[]
}
