// LibriSpeech 真人朗读示例包：清单和署名完整、对齐 → 时间线 → 视位轨迹、深链接参数 drive、sim.json 的卡片、
// 商业构建保留这个包，以及清单里两种带动方式的基准数值能重算出来。
// The LibriSpeech real read-speech example pack: manifest and attribution are complete, alignment → timeline → viseme track, the
// deep-link parameter drive, the cards in sim.json, the commercial build keeps the pack, and the benchmark numbers in the manifest
// can be recomputed.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEMO_PACKS, packFromManifest } from '../src/face/say.ts'
import type { FaceData } from '../src/face/types.ts'
import { phonemeTrack, trackIndex, trackPose } from '../src/face/visemeTrack.ts'
import { useApp } from '../src/state/store.ts'
import { formatUrl, parseUrl } from '../src/state/urlState.ts'
import { resetUrlSync, snapshot } from '../src/state/urlSync.ts'
import { phonemesToVisemeSegments, type PhonemesEn, type TtsPhone, type TtsWord, type VisemesZh } from '../src/voice/tts.ts'
import { decodeWav } from '../src/voice/wav.ts'
import { bilabialFrames, driveSeries, jawStats } from '../tools/voice/librispeech-bench.ts'
import { alignmentToTimeline, coverage, parseTextGrid, REQUIRED, speakerSex, speechSpan } from '../tools/voice/librispeech.ts'
import { buildRemovals } from '../tools/build/removals.ts'

const ROOT = resolve(__dirname, '..')
const PACK = 'voice/librispeech-demo'
const DIR = resolve(ROOT, 'public', PACK)
const json = <T>(p: string): T => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')) as T

interface Clip {
  file: string
  lang: 'en'
  voice: string
  text: string
  sampleRate: number
  durationS: number
  bytes: number
  sha256: string
  source: Record<string, unknown> & { speaker: string; sex: string; chapter: string; utterance: string; transcript: string; book: string; offsetS: number }
  coverage: Record<string, number>
  phonemes: TtsPhone[]
  words: TtsWord[]
  bench?: ReturnType<typeof jawStats> & { frames: number; bilabials: { phone: string; t: number; closure: { phone: number; audio: number }; gapMm: { phone: number; audio: number } }[]; sealed: { phone: number; audio: number; of: number } }
}
const manifest = json<{ licence: string; benchmark: { bilabials: { n: number; sealed: { phone: number; audio: number } }; jawR: { mean: number } }; clips: Clip[] }>(`public/${PACK}/manifest.json`)
const tables = { en: json<PhonemesEn>('data/curated/face/phonemes-en.json'), zh: json<VisemesZh>('data/curated/face/visemes-zh.json') }
const facePath = resolve(ROOT, 'public/anatomy/male/face.json')
const present = existsSync(facePath)
const face = present ? json<FaceData>('public/anatomy/male/face.json') : (null as unknown as FaceData)

describe('the LibriSpeech example pack: manifest, audio and attribution', () => {
  it('has 8–12 clips of 3–8 s, half female and half male, one per speaker, within about 2 MB', () => {
    const n = manifest.clips.length
    expect(n).toBeGreaterThanOrEqual(8)
    expect(n).toBeLessThanOrEqual(12)
    expect(manifest.clips.filter((c) => c.source.sex === 'female').length).toBe(n / 2)
    expect(manifest.clips.filter((c) => c.source.sex === 'male').length).toBe(n / 2)
    expect(new Set(manifest.clips.map((c) => c.source.speaker)).size).toBe(n)
    for (const c of manifest.clips) expect(c.durationS >= 3 && c.durationS <= 8, c.file).toBe(true)
    const total = manifest.clips.reduce((s, c) => s + statSync(resolve(DIR, c.file)).size, 0) + statSync(resolve(DIR, 'manifest.json')).size
    expect(total).toBeLessThan(2.2 * 1048576)
  })

  it('every clip has its audio (24 kHz mono WAV, size and sha256 as listed) and a timeline covering it', () => {
    for (const c of manifest.clips) {
      expect(c.file).toBe(`ls-${c.source.utterance}.wav`)
      const bytes = new Uint8Array(readFileSync(resolve(DIR, c.file)))
      expect(bytes.length, c.file).toBe(c.bytes)
      expect(createHash('sha256').update(bytes).digest('hex'), c.file).toBe(c.sha256)
      const wav = decodeWav(bytes)
      expect(wav.sampleRate).toBe(24000)
      expect(c.sampleRate).toBe(24000)
      expect(Math.abs(wav.samples.length / 24000 - c.durationS), c.file).toBeLessThan(1 / 24000 + 1e-9)
      // 时间线从 0 到 durationS，首尾相接；每个音都在映射表里 / the timeline runs from 0 to durationS without gaps; every sound is in the mapping table
      expect(c.phonemes[0]!.t0).toBe(0)
      expect(c.phonemes[c.phonemes.length - 1]!.t1).toBeCloseTo(c.durationS, 6)
      c.phonemes.forEach((p, i) => {
        expect(p.t1, `${c.file} #${i}`).toBeGreaterThan(p.t0)
        if (i) expect(p.t0, `${c.file} #${i}`).toBeCloseTo(c.phonemes[i - 1]!.t1, 6)
        if (p.phone !== 'sil') expect(tables.en.phones[p.phone], `${c.file} ${p.phone}`).toBeDefined()
        if (p.word !== null) expect(c.words[p.word], `${c.file} #${i}`).toBeDefined()
      })
      expect(c.words.map((w) => w.text.toLowerCase()).join(' ')).toBe(c.source.transcript.toLowerCase())
      expect(c.text.toLowerCase()).toBe(c.source.transcript.toLowerCase())
      // 选段条件：四类音各至少一个 / the selection criteria: at least one of each of the four classes
      const cov = coverage(c.phonemes)
      expect(cov).toEqual(c.coverage)
      for (const k of Object.keys(REQUIRED)) expect(cov[k as keyof typeof cov], `${c.file} ${k}`).toBeGreaterThan(0)
    }
  })

  it('credits every clip in ATTRIBUTION.md (Chinese, then English) and states the licence; no reader names', () => {
    const att = readFileSync(resolve(DIR, 'ATTRIBUTION.md'), 'utf8')
    const zh = att.indexOf('## 中文'), en = att.indexOf('## English')
    expect(zh).toBeGreaterThan(0)
    expect(en).toBeGreaterThan(zh)
    for (const part of [att.slice(zh, en), att.slice(en)]) {
      for (const c of manifest.clips) for (const s of [c.file, c.source.speaker, c.source.chapter, c.source.utterance, c.source.book, c.source.transcript]) expect(part, `${c.file}: ${s}`).toContain(s)
      expect(part).toMatch(/Panayotov, Chen, Povey & Khudanpur 2015/)
      expect(part).toMatch(/LibriVox/)
      expect(part).toMatch(/Lugosch/)
      expect(part).toMatch(/CC BY 4\.0/)
    }
    expect(att).toMatch(/自动对齐，不是人工标注/)
    expect(att).toMatch(/automatic Montreal Forced Aligner alignments, not hand labels/)
    expect(readFileSync(resolve(DIR, 'LICENSE'), 'utf8')).toMatch(/creativecommons\.org\/licenses\/by\/4\.0/)
    expect(manifest.licence).toMatch(/^CC BY 4\.0/)
    // 清单只有编号，没有朗读者的名字一栏 / the manifest has numbers only, no reader-name field
    for (const c of manifest.clips) for (const k of Object.keys(c.source)) expect(['name', 'reader', 'readerName'].includes(k), k).toBe(false)
  })

  it('is one of the demo packs, read as recordings (no model, with their source)', () => {
    expect(DEMO_PACKS).toContain(`${PACK}/manifest.json`)
    const pack = packFromManifest(`${PACK}/manifest.json`, manifest, '/')
    expect(pack.clips.length).toBe(manifest.clips.length)
    for (const c of pack.clips) {
      expect(c.model).toBeNull()
      expect(c.recording).toMatchObject({ corpus: 'LibriSpeech' })
      expect(c.recording!.alignment).toMatch(/automatic/)
      expect(existsSync(resolve(ROOT, 'public', c.url.slice(1))), c.url).toBe(true)
    }
    // tts-demo 的片段仍是机器合成的 / the tts-demo clips are still machine-synthesized
    const tts = packFromManifest('voice/tts-demo/manifest.json', json('public/voice/tts-demo/manifest.json'))
    expect(tts.clips.every((c) => c.model && !c.recording)).toBe(true)
  })
})

describe('alignment → timeline', () => {
  const grid = `File type = "ooTextFile"
Object class = "TextGrid"

xmin = 0.0
xmax = 1.2
tiers? <exists>
size = 2
item []:
	item [1]:
		class = "IntervalTier"
		name = "words"
		xmin = 0.0
		xmax = 1.2
		intervals: size = 3
			intervals [1]:
				xmin = 0.0
				xmax = 0.3
				text = ""
			intervals [2]:
				xmin = 0.3
				xmax = 0.9
				text = "move"
			intervals [3]:
				xmin = 0.9
				xmax = 1.2
				text = ""
	item [2]:
		class = "IntervalTier"
		name = "phones"
		xmin = 0.0
		xmax = 1.2
		intervals: size = 6
			intervals [1]:
				xmin = 0.0
				xmax = 0.2
				text = "sil"
			intervals [2]:
				xmin = 0.2
				xmax = 0.3
				text = ""
			intervals [3]:
				xmin = 0.3
				xmax = 0.45
				text = "M"
			intervals [4]:
				xmin = 0.45
				xmax = 0.7
				text = "UW1"
			intervals [5]:
				xmin = 0.7
				xmax = 0.9
				text = "V"
			intervals [6]:
				xmin = 0.9
				xmax = 1.2
				text = "sp"
`
  it('reads both tiers, strips stress digits into `stress`, merges pauses and shifts by the trimmed offset', () => {
    const g = parseTextGrid(grid)
    expect(g.words.map((w) => w.text)).toEqual(['', 'move', ''])
    expect(g.phones.map((p) => p.text)).toEqual(['sil', '', 'M', 'UW1', 'V', 'sp'])
    expect(speechSpan(g.phones)).toEqual({ t0: 0.3, t1: 0.9 })
    const tl = alignmentToTimeline(g, 0.1, 1)
    expect(tl.words).toEqual([{ t0: 0.2, t1: 0.8, text: 'move' }])
    expect(tl.phonemes).toEqual([
      { t0: 0, t1: 0.2, phone: 'sil', symbol: 'sil', word: null },
      { t0: 0.2, t1: 0.35, phone: 'M', symbol: 'M', word: 0, stress: null },
      { t0: 0.35, t1: 0.6, phone: 'UW', symbol: 'UW1', word: 0, stress: 1 },
      { t0: 0.6, t1: 0.8, phone: 'V', symbol: 'V', word: 0, stress: null },
      { t0: 0.8, t1: 1, phone: 'sil', symbol: 'sp', word: null },
    ])
    expect(() => alignmentToTimeline({ words: [], phones: [{ t0: 0, t1: 1, text: 'Q9' }] }, 0, 1)).toThrow(/unrecognised/)
  })

  it('reads the sex of a speaker and never the name column', () => {
    const m = speakerSex('; comment\n;ID  |SEX| SUBSET |MINUTES| NAME\n14   | F | train-clean-360  | 25.03 | Someone\n17   | M | dev-clean | 8.0 | Another\n')
    expect([...m]).toEqual([['14', 'female'], ['17', 'male']])
  })

  it.skipIf(!present)('every clip gives a track in which bilabials close and labiodentals touch, at rest at both ends', () => {
    const V = face.visemes!
    const ids = V.visemes.map((v) => v.id)
    for (const c of manifest.clips) {
      const track = phonemeTrack(c.phonemes, 'en', tables, V, c.durationS)
      expect(track.frames.length, c.file).toBe(Math.round(c.durationS * 100) + 1)
      for (const p of c.phonemes.filter((x) => x.phone !== 'sil')) {
        const first = phonemesToVisemeSegments([p], 'en', tables, { available: ids })[0]!.viseme
        const mid = track.frames[trackIndex(track, (p.t0 + p.t1) / 2)]!
        if (first === 'PBM') expect(mid.closure, `${c.file} ${p.phone} @${p.t0}`).toBeGreaterThan(0.99)
        if (first === 'FV') expect(mid.dental, `${c.file} ${p.phone} @${p.t0}`).toBeGreaterThan(0.99)
      }
      expect(trackPose(face, track, 0), c.file).toMatchObject({ jaw: 0, closure: 0, dental: 0 })
    }
  })
})

describe('the deep-link parameter drive', () => {
  beforeEach(() => resetUrlSync())

  it('round-trips with say; phone is the default and is not written', () => {
    for (const q of ['say=ls-6241-61946-0017&drive=audio', 'sys=int&say=ls-6241-61946-0017&drive=audio&style=clear&skin=1', 'embed=1&say=en-01&drive=audio']) {
      const p = parseUrl(q)
      expect(p.warnings, q).toEqual([])
      expect(formatUrl(p.state), q).toBe(q)
    }
    expect(parseUrl('say=ls-1&drive=phone').state).toEqual({ say: 'ls-1', drive: 'phone' })
    expect(formatUrl(parseUrl('say=ls-1&drive=phone').state)).toBe('say=ls-1')
  })

  it('refuses other values and drive without say, naming the parameter', () => {
    for (const q of ['say=ls-1&drive=', 'say=ls-1&drive=phonemes', 'say=ls-1&drive=1', 'drive=audio']) {
      const p = parseUrl(q)
      expect(p.state.drive, q).toBeUndefined()
      expect(p.warnings.join(), q).toMatch(/drive/)
    }
  })

  it('is written for a demo clip played by audio, and never for synthesized text', () => {
    useApp.setState((s) => ({ say: { ...s.say, status: 'ready', source: 'demo', clip: 'ls-6241-61946-0017', mode: 'audio' }, speechStyle: null }))
    expect(formatUrl(snapshot(useApp.getState()))).toBe('say=ls-6241-61946-0017&drive=audio')
    useApp.setState((s) => ({ say: { ...s.say, mode: 'phonemes' } }))
    expect(formatUrl(snapshot(useApp.getState()))).toBe('say=ls-6241-61946-0017')
    useApp.setState((s) => ({ say: { ...s.say, source: 'tts', clip: null, mode: 'audio' } }))
    expect(formatUrl(snapshot(useApp.getState()))).toBe('')
    useApp.setState((s) => ({ say: { ...s.say, status: 'idle', source: null, mode: 'phonemes' } }))
  })

  it('sim.json has a card per drive mode on the same recorded clip', () => {
    const sim = json<{ cards: { id: string; title: { zh: string; en: string }; hint: { zh: string; en: string }; url: string }[] }>('sim.json')
    const ids = new Set(manifest.clips.map((c) => c.file.replace(/\.wav$/, '')))
    const cards = sim.cards.filter((c) => /[?&]say=ls-/.test(c.url))
    expect(cards.length).toBe(2)
    const states = cards.map((c) => parseUrl(c.url.slice(c.url.indexOf('?'))))
    for (const [i, p] of states.entries()) {
      expect(p.warnings, cards[i]!.id).toEqual([])
      expect(ids.has(p.state.say!), cards[i]!.id).toBe(true)
      expect(formatUrl(p.state), cards[i]!.id).toBe(cards[i]!.url.slice(cards[i]!.url.indexOf('?') + 1))
      for (const k of ['title', 'hint'] as const) expect(cards[i]![k].zh && cards[i]![k].en, `${cards[i]!.id} ${k}`).toBeTruthy()
    }
    expect(states[0]!.state.say).toBe(states[1]!.state.say)
    expect(states.map((p) => p.state.drive ?? 'phone').sort()).toEqual(['audio', 'phone'])
  })
})

describe('the commercial build', () => {
  it('removes the non-commercial VIVAE pack only and keeps the LibriSpeech and TTS packs', () => {
    const commercial = buildRemovals(true), normal = buildRemovals(false)
    expect(commercial).toContain('voice/vivae-pain')
    expect(normal).not.toContain('voice/vivae-pain')
    for (const removed of commercial) {
      for (const kept of ['voice/librispeech-demo', 'voice/tts-demo']) expect(kept === removed || kept.startsWith(`${removed}/`) || removed.startsWith(`${kept}/`), `${removed} vs ${kept}`).toBe(false)
      for (const m of DEMO_PACKS) expect(m.startsWith(`${removed}/`), `${m} is removed by ${removed}`).toBe(false)
    }
  })
})

describe.skipIf(!present)('the benchmark in the manifest', () => {
  it('recomputes the jaw-angle comparison of the two drive modes exactly, clip by clip', () => {
    for (const c of manifest.clips) {
      const wav = decodeWav(new Uint8Array(readFileSync(resolve(DIR, c.file))))
      const s = driveSeries(face, tables, c, wav.samples, wav.sampleRate)
      expect(c.bench, c.file).toBeDefined()
      expect(s.phone.length).toBe(c.bench!.frames)
      const { jawR, jawRSpeech, bestLagMs, jawRBestLag, jawMeanDeg } = c.bench!
      expect(jawStats(s), c.file).toEqual({ jawR, jawRSpeech, bestLagMs, jawRBestLag, jawMeanDeg })
      // 按音素：每个双唇音的中点闭唇（网格上的唇间隙由 bench 命令量，这里核对它记下的数）
      // by phoneme: every bilabial is sealed at its middle (the lip gap on the mesh is measured by the bench command; its record is checked here)
      const frames = bilabialFrames(c.phonemes, s.phone.length)
      expect(c.bench!.bilabials.length).toBe(frames.length)
      frames.forEach((b, i) => {
        expect(s.phone[b.frame]!.closure, `${c.file} ${b.phone} @${b.t}`).toBeGreaterThan(0.98)
        expect(c.bench!.bilabials[i]!.closure.phone).toBeCloseTo(s.phone[b.frame]!.closure, 3)
        expect(c.bench!.bilabials[i]!.closure.audio).toBeCloseTo(s.audio[b.frame]!.closure, 3)
      })
    }
    expect(manifest.benchmark.bilabials.n).toBe(manifest.clips.reduce((n, c) => n + c.bench!.bilabials.length, 0))
  })
})
