// LibriSpeech 真人朗读示例包的纯逻辑：读 Montreal Forced Aligner 的 TextGrid、换成和 /api/tts 相同格式的音素时间线、
// 检查选段条件、读 LibriSpeech 的元数据表。不碰网络和文件，测试直接调用；下载和生成在 librispeech-demo.ts。
// The pure logic of the LibriSpeech real-voice example pack: read Montreal Forced Aligner TextGrids, turn them into a phoneme
// timeline in the format /api/tts returns, check the selection criteria, read LibriSpeech's metadata tables. No network and no
// files in here, so the tests call it directly; downloading and generating are in librispeech-demo.ts.

import type { TtsPhone, TtsWord } from '../../src/voice/tts.ts'

export interface Interval {
  t0: number
  t1: number
  text: string
}

/**
 * 读 Praat 长格式的 TextGrid，取出 words 和 phones 两层。
 * Read a Praat long-format TextGrid and take its `words` and `phones` tiers.
 */
export function parseTextGrid(text: string): { words: Interval[]; phones: Interval[] } {
  const tier = (name: string): Interval[] => {
    const at = text.indexOf(`name = "${name}"`)
    if (at < 0) throw new Error(`TextGrid 里没有 ${name} 层 / the TextGrid has no ${name} tier`)
    const next = text.indexOf('class = "IntervalTier"', at)
    const body = text.slice(at, next < 0 ? undefined : next)
    const out: Interval[] = []
    const re = /xmin = ([\d.]+)\s+xmax = ([\d.]+)\s+text = "([^"]*)"/g
    // 第一处 xmin/xmax 是层本身的范围，后面跟着 "intervals: size"，不带 text，正则不会匹配它
    // the first xmin/xmax is the tier's own range, followed by "intervals: size" with no text, so the pattern skips it
    for (let m = re.exec(body); m; m = re.exec(body)) out.push({ t0: Number(m[1]), t1: Number(m[2]), text: m[3]! })
    return out
  }
  return { words: tier('words'), phones: tier('phones') }
}

/** MFA 的停顿记号：空串、sil、sp / MFA's pause labels: empty, sil, sp. */
export const isPause = (label: string): boolean => label === '' || label === 'sil' || label === 'sp'

/** ARPAbet 元音（不带重音数字）/ ARPAbet vowels (without a stress digit). */
export const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW'])

/** 选段要求每段至少各有一个的四类音 / the four classes every clip must contain at least once. */
export const REQUIRED = {
  bilabial: ['P', 'B', 'M'],
  labiodental: ['F', 'V'],
  rounded: ['UW', 'OW', 'W'],
  open: ['AA', 'AE', 'AO'],
} as const satisfies Record<string, readonly string[]>
export type RequiredClass = keyof typeof REQUIRED

/** 每一类出现的次数 / how often each class occurs. */
export function coverage(phones: readonly { phone: string }[]): Record<RequiredClass, number> {
  const out = { bilabial: 0, labiodental: 0, rounded: 0, open: 0 }
  for (const p of phones) for (const k of Object.keys(REQUIRED) as RequiredClass[]) if ((REQUIRED[k] as readonly string[]).includes(p.phone)) out[k]++
  return out
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000

/**
 * 对齐 → 时间线（/api/tts 的格式）。时间减去 offset 并截到 [0, durationS]；相邻的停顿合成一个 sil；
 * phone 去掉重音数字（重音放进 stress），symbol 保留 MFA 的原始记号；word 是 words 里的下标（按音的中点落在哪个词里）。
 * An alignment → a timeline (the format of /api/tts). Times are shifted by −offset and cut to [0, durationS]; adjacent pauses merge
 * into one sil; `phone` loses its stress digit (the stress goes into `stress`) and `symbol` keeps MFA's original label; `word` is an
 * index into `words` (the word the phone's midpoint falls in).
 */
export function alignmentToTimeline(grid: { words: Interval[]; phones: Interval[] }, offset: number, durationS: number): { phonemes: TtsPhone[]; words: TtsWord[] } {
  const clip = (t: number): number => r3(Math.min(durationS, Math.max(0, t - offset)))
  const words: TtsWord[] = grid.words.filter((w) => !isPause(w.text) && clip(w.t1) > clip(w.t0)).map((w) => ({ t0: clip(w.t0), t1: clip(w.t1), text: w.text }))
  const phonemes: TtsPhone[] = []
  const pushPause = (t0: number, t1: number, symbol: string): void => {
    if (t1 <= t0) return
    const last = phonemes[phonemes.length - 1]
    if (last && last.phone === 'sil' && Math.abs(last.t1 - t0) < 1e-6) {
      last.t1 = t1
      return
    }
    phonemes.push({ t0, t1, phone: 'sil', symbol, word: null })
  }
  for (const p of grid.phones) {
    const t0 = clip(p.t0), t1 = clip(p.t1)
    if (t1 <= t0) continue
    if (isPause(p.text)) {
      pushPause(t0, t1, p.text)
      continue
    }
    const m = /^([A-Z]+)([0-2])?$/.exec(p.text)
    if (!m) throw new Error(`无法识别的音素记号 "${p.text}" / unrecognised phone label`)
    const mid = (t0 + t1) / 2
    const w = words.findIndex((x) => mid >= x.t0 && mid < x.t1)
    phonemes.push({ t0, t1, phone: m[1]!, symbol: p.text, word: w >= 0 ? w : null, stress: m[2] !== undefined && VOWELS.has(m[1]!) ? Number(m[2]) : null })
  }
  // 两端补齐，时间线覆盖 [0, durationS] / pad both ends so the timeline covers [0, durationS]
  const first = phonemes[0]
  if (!first || first.t0 > 0) phonemes.unshift({ t0: 0, t1: first ? first.t0 : r3(durationS), phone: 'sil', symbol: '', word: null })
  const last = phonemes[phonemes.length - 1]!
  if (last.t1 < r3(durationS)) pushPause(last.t1, r3(durationS), '')
  return { phonemes, words }
}

/** 说话的范围（第一个和最后一个非停顿音的起止）/ the span of speech (start of the first and end of the last non-pause phone). */
export function speechSpan(phones: readonly Interval[]): { t0: number; t1: number } | null {
  const spoken = phones.filter((p) => !isPause(p.text))
  return spoken.length ? { t0: spoken[0]!.t0, t1: spoken[spoken.length - 1]!.t1 } : null
}

/** LibriSpeech 用 | 分隔、以 ; 开头为注释的元数据表 / LibriSpeech's |-separated metadata tables with ;-comments. */
export function parseTable(text: string): string[][] {
  return text
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith(';'))
    .map((l) => l.split('|').map((x) => x.trim()))
}

/**
 * SPEAKERS.TXT → 说话人 id → 性别。故意不读姓名一栏：朗读者的名字不进仓库。
 * SPEAKERS.TXT → speaker id → sex. The name column is deliberately not read: readers' names stay out of the repository.
 */
export function speakerSex(text: string): Map<string, 'female' | 'male'> {
  const out = new Map<string, 'female' | 'male'>()
  for (const row of parseTable(text)) if (row[1] === 'F' || row[1] === 'M') out.set(row[0]!, row[1] === 'F' ? 'female' : 'male')
  return out
}

/** CHAPTERS.TXT → 章节 id → { 古登堡书号, LibriVox 项目名 } / chapter id → { Gutenberg book id, LibriVox project title }. */
export function chapterBooks(text: string): Map<string, { bookId: string; project: string }> {
  const out = new Map<string, { bookId: string; project: string }>()
  for (const row of parseTable(text)) if (row.length >= 8) out.set(row[0]!, { bookId: row[5]!, project: row.slice(7).join('|').trim() })
  return out
}

/** BOOKS.TXT → 古登堡书号 → 书名 / Gutenberg book id → title. */
export function bookTitles(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const row of parseTable(text)) if (row.length >= 2) out.set(row[0]!, row[1]!)
  return out
}
