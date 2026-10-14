// 入口 / Entry point:
//   bun tools/voice/librispeech-demo.ts fetch    下载 LibriSpeech dev-clean 和它的对齐（只放在 data/raw/librispeech/，不入库）
//                                                download LibriSpeech dev-clean and its alignments (into data/raw/librispeech/ only, not committed)
//   bun tools/voice/librispeech-demo.ts build    选段、转成 24 kHz 单声道 WAV、写出 public/voice/librispeech-demo/
//                                                select the clips, convert them to 24 kHz mono WAV, write public/voice/librispeech-demo/
//   bun tools/voice/librispeech-demo.ts bench    两种带动方式的对比数值，写回清单（见 librispeech-bench.ts）
//                                                the numbers comparing the two drive modes, written back into the manifest (see librispeech-bench.ts)
//
// 数据（两个来源都打开核对过许可页）/ Data (the licence page of both sources was opened and checked):
//   LibriSpeech ASR corpus, https://www.openslr.org/12/ — CC BY 4.0（Panayotov, Chen, Povey & Khudanpur 2015, ICASSP）。
//     录音来自 LibriVox 的公有领域有声书。/ The recordings come from LibriVox's public-domain audiobooks.
//   LibriSpeech Alignments, Loren Lugosch, Zenodo record 2619474, https://zenodo.org/records/2619474 — CC BY 4.0。
//     Montreal Forced Aligner 自动生成，不是人工标注。/ Generated automatically by the Montreal Forced Aligner, not hand labels.
// 对齐的 zip 有 623 MB（全部子集），这里用 HTTP Range 只取 dev-clean 那一段（约 3.7 MB）和中央目录（约 33 MB），逐个核对 CRC-32。
// The alignment zip is 623 MB (every subset); HTTP Range requests fetch only the dev-clean stretch (about 3.7 MB) and the central
// directory (about 33 MB), and every member's CRC-32 is checked.
//
// 需要 ffmpeg（只用来把 FLAC 无损解码成 16 位 PCM；重采样用本项目的 src/voice/resample.ts，结果不随 ffmpeg 版本变）。
// Needs ffmpeg (only to decode FLAC losslessly to 16-bit PCM; resampling uses this project's src/voice/resample.ts, so the result does
// not depend on the ffmpeg version).

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { resample } from '../../src/voice/resample.ts'
import { ROOT } from './corpus.ts'
import { alignmentToTimeline, bookTitles, chapterBooks, coverage, isPause, parseTextGrid, speakerSex, speechSpan, REQUIRED, type RequiredClass } from './librispeech.ts'
import { encodeWav } from './wav.ts'

export const RAW = join(ROOT, 'data/raw/librispeech')
export const CORPUS = join(RAW, 'dev-clean-x/LibriSpeech')
export const GRIDS = join(RAW, 'alignments')
export const OUT = join(ROOT, 'public/voice/librispeech-demo')
const SUBSET = 'dev-clean'
const CORPUS_URL = 'https://openslr.trmal.net/resources/12/dev-clean.tar.gz'
const ALIGN_URL = 'https://zenodo.org/api/records/2619474/files/librispeech_alignments.zip/content'

/** 输出采样率：与 tts-demo 相同 / output sample rate: the same as tts-demo. */
export const RATE = 24000
/** 剪掉首尾静音后两端各留的余量，秒 / the margin kept at either end after trimming silence, seconds. */
const PAD = 0.25
/** 剪后时长的范围，秒（总量要在约 2 MB 内：24 kHz 16 位约 47 kB/s）/ the trimmed duration range, seconds (the total stays near 2 MB: 24 kHz 16-bit is about 47 kB/s). */
const MIN_S = 3, MAX_S = 4.5
/** 男女各几段 / clips per sex. */
const PER_SEX = 5
/** 非停顿音的最长时长，秒；更长的多半是对齐出了错 / longest non-pause phone, seconds; anything longer is likely an alignment error. */
const MAX_PHONE_S = 0.4
/**
 * 内容不中性的词：含这些词的句子不选（选完后又逐句读过一遍）。
 * Words that make content not neutral: sentences containing them are not chosen (the chosen ones were also read one by one afterwards).
 */
const AVOID = new Set('blood bloody dead death die died dies dying kill killed killing murder murdered corpse grave war wars gun guns sword swords knife slave slaves god lord jesus christ hell damn devil sin sins pray prayer church drunk whisky wine naked beat beaten hang hanged hate fear afraid scream wound wounded battle battles regiment regiments army soldier soldiers enemy'.split(' '))
/**
 * 选出后逐句读过、因内容而排除的句子（写明原因，可复现）。
 * Sentences excluded by hand after reading them, with the reason (kept here so the selection is reproducible).
 */
const EXCLUDE: Record<string, string> = {
  '251-118436-0022': '临终的场景 / a death-bed scene (the following sentences of the chapter)',
  '1673-143397-0009': '宗教机构 / a religious institution',
}

/** 转写是全大写的：改成句首大写，并把下面这些词（人名、地名和 I）写回大写开头。/ The transcripts are upper case: sentence case, with these words (names, places and I) capitalised again. */
const PROPER = new Set(['i', "i'm", "i'd", "i'll", "i've", 'ann', 'george', 'egypt', 'carrie', 'texas', 'oz'])
export function displayCase(words: readonly string[]): string[] {
  return words.map((w, i) => {
    const lower = w.toLowerCase()
    return i === 0 || PROPER.has(lower) ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
  })
}

// —— 下载 / Download ——

async function rangeGet(url: string, a: number, b: number): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Range: `bytes=${a}-${b - 1}` } })
    if (res.status === 206) {
      const out = new Uint8Array(await res.arrayBuffer())
      if (out.length === b - a) return out
    }
    if (attempt >= 4) throw new Error(`Range ${a}-${b} of ${url}: HTTP ${res.status}`)
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
  }
}

/** CRC-32（IEEE），用来核对 zip 成员 / CRC-32 (IEEE), to check zip members. */
function crc32(bytes: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]!
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

async function fetchAlignments(): Promise<void> {
  mkdirSync(GRIDS, { recursive: true })
  const head = await fetch(ALIGN_URL, { method: 'HEAD' })
  const size = Number(head.headers.get('content-length'))
  if (!(size > 0)) throw new Error('对齐 zip 的大小未知 / the size of the alignment zip is unknown')
  const tail = await rangeGet(ALIGN_URL, size - 65557, size)
  const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('找不到 zip 的目录尾 / no end-of-central-directory record')
  const cdSize = tv.getUint32(eocd + 12, true), cdOff = tv.getUint32(eocd + 16, true)
  const cd = await rangeGet(ALIGN_URL, cdOff, cdOff + cdSize)
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
  const members: { name: string; method: number; crc: number; csize: number; size: number; off: number }[] = []
  for (let p = 0; p + 46 <= cd.length && cv.getUint32(p, true) === 0x02014b50; ) {
    const nl = cv.getUint16(p + 28, true), el = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true)
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nl))
    if (name.startsWith(`${SUBSET}/`) && name.endsWith('.TextGrid')) members.push({ name, method: cv.getUint16(p + 10, true), crc: cv.getUint32(p + 16, true), csize: cv.getUint32(p + 20, true), size: cv.getUint32(p + 24, true), off: cv.getUint32(p + 42, true) })
    p += 46 + nl + el + cl
  }
  if (!members.length) throw new Error(`zip 里没有 ${SUBSET} / no ${SUBSET} in the zip`)
  // 一次取下这一段（本地头之后的名字和扩展字段长度不定，多取 1 kB）/ fetch the whole stretch at once (local headers vary in length; 1 kB extra)
  const lo = Math.min(...members.map((m) => m.off)), hi = Math.max(...members.map((m) => m.off + 30 + m.name.length + m.csize + 1024))
  const span = await rangeGet(ALIGN_URL, lo, Math.min(hi, size))
  const sv = new DataView(span.buffer, span.byteOffset, span.byteLength)
  for (const m of members) {
    const at = m.off - lo
    if (sv.getUint32(at, true) !== 0x04034b50) throw new Error(`${m.name}: 本地头不对 / bad local header`)
    const start = at + 30 + sv.getUint16(at + 26, true) + sv.getUint16(at + 28, true)
    const raw = span.subarray(start, start + m.csize)
    const data = m.method === 0 ? raw : m.method === 8 ? new Uint8Array(inflateRawSync(raw)) : null
    if (!data || data.length !== m.size || crc32(data) !== m.crc) throw new Error(`${m.name}: 解压或校验失败 / inflate or CRC check failed`)
    writeFileSync(join(GRIDS, m.name.split('/').pop()!), data)
  }
  console.log(`alignments: ${members.length} TextGrid files of ${SUBSET} → ${GRIDS}`)
}

async function fetchCorpus(): Promise<void> {
  if (existsSync(join(CORPUS, 'SPEAKERS.TXT'))) return
  mkdirSync(RAW, { recursive: true })
  const tar = join(RAW, `${SUBSET}.tar.gz`)
  if (!existsSync(tar)) {
    const res = await fetch(CORPUS_URL)
    if (!res.ok) throw new Error(`${CORPUS_URL}: HTTP ${res.status}`)
    await Bun.write(tar, res)
  }
  mkdirSync(join(RAW, 'dev-clean-x'), { recursive: true })
  const p = Bun.spawnSync(['tar', '-xzf', tar, '-C', join(RAW, 'dev-clean-x')])
  if (p.exitCode !== 0) throw new Error(`tar: ${p.stderr.toString()}`)
}

// —— 选段 / Selection ——

export interface Candidate {
  utt: string
  speaker: string
  chapter: string
  sex: 'female' | 'male'
  transcript: string
  offset: number
  durationS: number
  coverage: Record<RequiredClass, number>
  score: number
}

function candidates(): Candidate[] {
  const sex = speakerSex(readFileSync(join(CORPUS, 'SPEAKERS.TXT'), 'utf8'))
  const out: Candidate[] = []
  const base = join(CORPUS, SUBSET)
  for (const speaker of readdirSync(base).sort()) {
    for (const chapter of readdirSync(join(base, speaker)).sort()) {
      const trans = readFileSync(join(base, speaker, chapter, `${speaker}-${chapter}.trans.txt`), 'utf8')
      for (const line of trans.split('\n').filter(Boolean)) {
        const utt = line.slice(0, line.indexOf(' ')), transcript = line.slice(line.indexOf(' ') + 1).trim()
        const gridPath = join(GRIDS, `${utt}.TextGrid`)
        if (!existsSync(gridPath) || EXCLUDE[utt]) continue
        const words = transcript.toLowerCase().split(/\s+/)
        if (words.some((w) => AVOID.has(w.replace(/'s$/, '')))) continue
        const grid = parseTextGrid(readFileSync(gridPath, 'utf8'))
        // 对齐不完整的不要：有 spn（说出但不认识的音）或 <unk> / incomplete alignments are skipped: spn (spoken noise) or <unk>
        if (grid.phones.some((p) => p.text === 'spn') || grid.words.some((w) => w.text === '<unk>')) continue
        if (grid.words.filter((w) => !isPause(w.text)).map((w) => w.text).join(' ') !== words.join(' ')) continue
        if (grid.phones.some((p) => !isPause(p.text) && p.t1 - p.t0 > MAX_PHONE_S)) continue
        const span = speechSpan(grid.phones)
        if (!span) continue
        const total = grid.phones[grid.phones.length - 1]!.t1
        const offset = Math.round(Math.max(0, span.t0 - PAD) * 100) / 100
        const end = Math.round(Math.min(total, span.t1 + PAD) * 100) / 100
        const durationS = Math.round((end - offset) * 100) / 100
        if (durationS < MIN_S || durationS > MAX_S) continue
        const tl = alignmentToTimeline(grid, offset, durationS)
        const cov = coverage(tl.phonemes)
        if (Object.values(cov).some((n) => n === 0)) continue
        // 双唇音和唇齿音越多越好（基准要量它们），其次是圆唇和开口元音 / the more bilabials and labiodentals the better (the benchmark measures them), then rounded and open vowels
        const score = Math.min(cov.bilabial, 4) * 2 + Math.min(cov.labiodental, 3) * 2 + Math.min(cov.rounded, 3) + Math.min(cov.open, 3)
        const s = sex.get(speaker)
        if (s) out.push({ utt, speaker, chapter, sex: s, transcript, offset, durationS, coverage: cov, score })
      }
    }
  }
  return out
}

/** 每位说话人最多一段；男女各 PER_SEX 段，按得分、再按 id 排序 / at most one clip per speaker; PER_SEX of each sex, by score and then id. */
export function choose(list: readonly Candidate[]): Candidate[] {
  const best = new Map<string, Candidate>()
  const order = (a: Candidate, b: Candidate): number => b.score - a.score || a.durationS - b.durationS || (a.utt < b.utt ? -1 : 1)
  for (const c of [...list].sort(order)) if (!best.has(c.speaker)) best.set(c.speaker, c)
  const pick = (s: 'female' | 'male'): Candidate[] => [...best.values()].filter((c) => c.sex === s).sort(order).slice(0, PER_SEX)
  return [...pick('female'), ...pick('male')].sort((a, b) => (a.utt < b.utt ? -1 : 1))
}

// —— 生成 / Build ——

function decodeFlac(path: string): Float32Array {
  const p = Bun.spawnSync(['ffmpeg', '-v', 'error', '-i', path, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'])
  if (p.exitCode !== 0) throw new Error(`ffmpeg: ${p.stderr.toString()}`)
  const b = p.stdout
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out = new Float32Array(b.byteLength >> 1)
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true) / 32768
  return out
}

export const clipId = (utt: string): string => `ls-${utt}`

function build(): void {
  const all = candidates()
  const chosen = choose(all)
  console.log(`${all.length} candidates; chosen ${chosen.length}`)
  const books = chapterBooks(readFileSync(join(CORPUS, 'CHAPTERS.TXT'), 'utf8'))
  const titles = bookTitles(readFileSync(join(CORPUS, 'BOOKS.TXT'), 'utf8'))
  mkdirSync(OUT, { recursive: true })
  // 上一次选中、这次没选中的声音删掉 / audio chosen last time but not this time is removed
  for (const f of readdirSync(OUT)) if (/^ls-.*\.wav$/.test(f)) rmSync(join(OUT, f))
  const clips = chosen.map((c) => {
    const pcm16 = decodeFlac(join(CORPUS, SUBSET, c.speaker, c.chapter, `${c.utt}.flac`))
    const pcm = resample(pcm16, 16000, RATE)
    const a = Math.round(c.offset * RATE), n = Math.round(c.durationS * RATE)
    const cut = pcm.slice(a, a + n)
    // 对齐的终点可能比录音略长几毫秒：时长以真正剪下的样本为准 / the alignment can end a few ms past the recording: the duration is that of the samples actually cut
    const durationS = Math.round((cut.length / RATE) * 1000) / 1000
    let peak = 0
    for (const v of cut) peak = Math.max(peak, Math.abs(v))
    // 重采样可能让个别样本略超 ±1；只在那时整体缩小，否则电平不动 / resampling can push a sample slightly past ±1; only then is the whole clip scaled down, otherwise the level is untouched
    if (peak > 0.999) for (let i = 0; i < cut.length; i++) cut[i] = (cut[i]! * 0.999) / peak
    const wav = encodeWav(cut, RATE)
    const file = `${clipId(c.utt)}.wav`
    writeFileSync(join(OUT, file), wav)
    const tl = alignmentToTimeline(parseTextGrid(readFileSync(join(GRIDS, `${c.utt}.TextGrid`), 'utf8')), c.offset, durationS)
    const book = books.get(c.chapter)
    return {
      file,
      lang: 'en',
      voice: `LibriSpeech ${c.speaker}`,
      text: displayCase(c.transcript.split(' ')).join(' '),
      sampleRate: RATE,
      durationS,
      bytes: wav.length,
      sha256: createHash('sha256').update(wav).digest('hex'),
      source: {
        corpus: 'LibriSpeech',
        subset: SUBSET,
        speaker: c.speaker,
        sex: c.sex,
        chapter: c.chapter,
        utterance: c.utt,
        transcript: c.transcript,
        book: book ? titles.get(book.bookId) ?? book.project : '',
        gutenbergId: book?.bookId ?? '',
        offsetS: c.offset,
        alignment: 'Montreal Forced Aligner (Lugosch 2019, Zenodo 2619474); automatic, not hand-checked',
      },
      coverage: c.coverage,
      phonemes: tl.phonemes,
      words: tl.words.map((w, i) => ({ ...w, text: displayCase(tl.words.map((x) => x.text))[i]! })),
    }
  })
  const manifest = {
    _doc: {
      zh: '真人朗读的示例片段：LibriSpeech dev-clean 里的 10 句（男女各 5 位说话人，每人一句），24 kHz、单声道、16 位，带音素时间线（格式与 /api/tts 和 tts-demo 相同）。时间线来自 Montreal Forced Aligner 的自动对齐（Lugosch 2019），不是人工标注。text 是 LibriSpeech 的转写（大写改成句首大写，没有标点）。source.offsetS 是剪掉开头静音的秒数。coverage 是每段里双唇音（P B M）、唇齿音（F V）、圆唇音（UW OW W）和开口元音（AA AE AO）的个数。benchmark 和各段的 bench 由 bun tools/voice/librispeech-demo.ts bench 写入：两种带动方式（按音素、按音频分析）的下颌角相关和双唇音处的唇间隙。',
      en: 'Real read-speech example clips: 10 utterances from LibriSpeech dev-clean (5 female and 5 male speakers, one each), 24 kHz, mono, 16-bit, with a phoneme timeline (the format of /api/tts and tts-demo). The timelines come from automatic Montreal Forced Aligner alignments (Lugosch 2019), not hand labels. `text` is the LibriSpeech transcript (upper case turned into sentence case, no punctuation). source.offsetS is the leading silence trimmed off, in seconds. `coverage` counts the bilabials (P B M), labiodentals (F V), rounded sounds (UW OW W) and open vowels (AA AE AO) in each clip. `benchmark` and each clip\'s `bench` are written by bun tools/voice/librispeech-demo.ts bench: the jaw-angle correlation of the two drive modes (by phoneme, by audio analysis) and the lip gap at bilabials.',
    },
    generatedBy: { command: 'bun tools/voice/librispeech-demo.ts fetch && bun tools/voice/librispeech-demo.ts build && bun tools/voice/librispeech-demo.ts bench' },
    licence: 'CC BY 4.0 — LibriSpeech (Panayotov, Chen, Povey & Khudanpur 2015; recordings from LibriVox, public domain) and LibriSpeech Alignments (Lugosch 2019, automatic MFA alignments); see LICENSE and ATTRIBUTION.md',
    selection: {
      subset: SUBSET,
      durationS: [MIN_S, MAX_S],
      perSex: PER_SEX,
      required: REQUIRED,
      rules: {
        zh: '每段至少各有一个双唇音、唇齿音、圆唇音和开口元音；没有 spn 和 <unk>；对齐的词与转写一致；没有长于 0.4 秒的非停顿音；剪掉首尾静音（各留 0.25 秒）后 3–4.5 秒；排除含暴力、宗教等词的句子；每位说话人最多一句；按双唇音和唇齿音的个数排序。',
        en: 'Every clip has at least one bilabial, labiodental, rounded sound and open vowel; no spn or <unk>; the aligned words match the transcript; no non-pause phone longer than 0.4 s; 3–4.5 s after trimming silence at both ends (0.25 s kept); sentences with words of violence, religion and the like are left out; one sentence per speaker at most; ranked by the number of bilabials and labiodentals.',
      },
    },
    clips,
  }
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`)
  writeFileSync(join(OUT, 'ATTRIBUTION.md'), attribution(clips))
  writeFileSync(join(OUT, 'LICENSE'), LICENSE)
  const bytes = clips.reduce((s, c) => s + c.bytes, 0)
  for (const c of clips) console.log(`${c.file}  ${c.source.sex.padEnd(6)} ${c.durationS.toFixed(2)} s  ${JSON.stringify(c.coverage)}  ${c.text}`)
  console.log(`audio total ${(bytes / 1048576).toFixed(2)} MB`)
}

const LICENSE = `本目录的声音和时间线按知识共享 署名 4.0 国际 许可协议（CC BY 4.0）提供。
The audio and timelines in this directory are provided under the Creative Commons Attribution 4.0 International licence (CC BY 4.0).
https://creativecommons.org/licenses/by/4.0/   法律文本 / legal code: https://creativecommons.org/licenses/by/4.0/legalcode

声音 / Audio
  LibriSpeech ASR corpus (c) 2014 Vassil Panayotov, CC BY 4.0, https://www.openslr.org/12/
  Panayotov, V., Chen, G., Povey, D., & Khudanpur, S. (2015). LibriSpeech: an ASR corpus based on public domain audio books. ICASSP 2015.
  LibriSpeech 的录音来自 LibriVox 的有声书，LibriVox 的录音属于公有领域。
  LibriSpeech is based on LibriVox audiobooks; LibriVox recordings are in the public domain.

音素时间线 / Phoneme timelines
  LibriSpeech Alignments, Loren Lugosch, Zenodo record 2619474, CC BY 4.0, https://zenodo.org/records/2619474
  用 Montreal Forced Aligner 自动生成，不是人工标注。/ Generated automatically with the Montreal Forced Aligner; not hand labels.

本项目做的改动 / Changes made by this project
  FLAC 解码，16 kHz 重采样到 24 kHz（汉宁窗 sinc 内插），剪掉首尾静音（各留 0.25 秒），存成 16 位单声道 WAV；
  对齐的时间减去剪掉的部分，换成 soma 的时间线格式（去掉重音数字，停顿合并为 sil）。
  FLAC decoded, resampled from 16 kHz to 24 kHz (Hann-windowed sinc), leading and trailing silence trimmed (0.25 s kept at each end),
  stored as 16-bit mono WAV; alignment times shifted by the trimmed amount and converted to soma's timeline format (stress digits
  moved out, pauses merged into sil).
  生成命令 / Generated by: bun tools/voice/librispeech-demo.ts fetch && bun tools/voice/librispeech-demo.ts build

不附加其他限制。按 CC BY 4.0 使用时请保留上面的署名和 ATTRIBUTION.md 里逐段的来源。
No further restriction is added. When using them under CC BY 4.0 keep the credits above and the per-clip sources in ATTRIBUTION.md.
`

interface BuiltClip {
  file: string
  durationS: number
  source: { speaker: string; sex: string; chapter: string; utterance: string; transcript: string; book: string; gutenbergId: string }
}

function attribution(clips: BuiltClip[]): string {
  const zhSex = (s: string): string => (s === 'female' ? '女' : '男')
  const rows = (lang: 'zh' | 'en'): string =>
    clips
      .map((c) =>
        lang === 'zh'
          ? `- \`${c.file}\` — 说话人 ${c.source.speaker}（${zhSex(c.source.sex)}），章节 ${c.source.chapter}，语句 ${c.source.utterance}，${c.durationS.toFixed(2)} 秒；书：*${c.source.book}*（古登堡 #${c.source.gutenbergId}）；转写：“${c.source.transcript}”`
          : `- \`${c.file}\` — speaker ${c.source.speaker} (${c.source.sex}), chapter ${c.source.chapter}, utterance ${c.source.utterance}, ${c.durationS.toFixed(2)} s; book: *${c.source.book}* (Gutenberg #${c.source.gutenbergId}); transcript: “${c.source.transcript}”`,
      )
      .join('\n')
  return `# LibriSpeech 示例片段的来源 / Sources of the LibriSpeech example clips

## 中文

这个目录里的 ${clips.length} 段声音是真人朗读的录音，取自 **LibriSpeech** 语料库的 dev-clean 子集（Panayotov, Chen, Povey & Khudanpur 2015，“LibriSpeech: an ASR corpus based on public domain audio books”，ICASSP 2015；https://www.openslr.org/12/ ，CC BY 4.0）。LibriSpeech 的录音来自 **LibriVox** 志愿者朗读的有声书，LibriVox 的录音属于公有领域。说话人只用 LibriSpeech 的编号标识，不写朗读者的名字。

每段的音素时间线来自 **LibriSpeech Alignments**（Loren Lugosch，Zenodo 2619474，https://zenodo.org/records/2619474 ，CC BY 4.0），是 Montreal Forced Aligner 的**自动对齐，不是人工标注**；边界没有逐个人工核对过。相关论文：Lugosch, Ravanelli, Ignoto, Tomar & Bengio (2019), Interspeech；McAuliffe, Socolof, Mihuc, Wagner & Sonderegger (2017), Interspeech。

本项目的改动：FLAC 解码、16 kHz 重采样到 24 kHz、剪掉首尾静音（各留 0.25 秒）、存成 16 位单声道 WAV；时间线减去剪掉的时长并换成 soma 的格式。性别取自 LibriSpeech 的 SPEAKERS.TXT。生成方法见 \`soma/tools/voice/librispeech-demo.ts\`。

${rows('zh')}

## English

The ${clips.length} clips in this directory are recordings of real people reading aloud, taken from the dev-clean subset of the **LibriSpeech** corpus (Panayotov, Chen, Povey & Khudanpur 2015, “LibriSpeech: an ASR corpus based on public domain audio books”, ICASSP 2015; https://www.openslr.org/12/, CC BY 4.0). LibriSpeech is built from audiobooks read by **LibriVox** volunteers; LibriVox recordings are in the public domain. Speakers are identified by their LibriSpeech number only; readers' names are not given.

Each clip's phoneme timeline comes from **LibriSpeech Alignments** (Loren Lugosch, Zenodo 2619474, https://zenodo.org/records/2619474, CC BY 4.0): **automatic Montreal Forced Aligner alignments, not hand labels**; the boundaries have not been checked by hand. Papers: Lugosch, Ravanelli, Ignoto, Tomar & Bengio (2019), Interspeech; McAuliffe, Socolof, Mihuc, Wagner & Sonderegger (2017), Interspeech.

Changes made by this project: FLAC decoded, resampled from 16 kHz to 24 kHz, leading and trailing silence trimmed (0.25 s kept at each end), stored as 16-bit mono WAV; the timelines shifted by the trimmed time and converted to soma's format. Sex is taken from LibriSpeech's SPEAKERS.TXT. See \`soma/tools/voice/librispeech-demo.ts\` for how they were made.

${rows('en')}
`
}

if (import.meta.main) {
  const cmd = process.argv[2]
  if (cmd === 'fetch') {
    await fetchCorpus()
    await fetchAlignments()
  } else if (cmd === 'build') build()
  else if (cmd === 'bench') {
    const { runBench } = await import('./librispeech-bench.ts')
    await runBench(OUT)
  } else {
    console.error('usage: bun tools/voice/librispeech-demo.ts fetch | build | bench')
    process.exit(1)
  }
}
