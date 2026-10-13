// 语音合成的前端一侧（src/voice/tts.ts）：音素 → 视位的映射表和纯函数，不需要后端。
// The browser side of speech synthesis (src/voice/tts.ts): the phoneme → viseme tables and the pure mapping; no backend needed.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { coarticulate } from '../tools/face/model.ts'
import type { FaceVisemes } from '../src/face/types.ts'
import { encodeWav } from '../src/voice/wav.ts'
import { phonemesToVisemeSegments, synthesize, ttsAvailable, TtsError, type PhonemesEn, type TtsPhone, type VisemesZh } from '../src/voice/tts.ts'

const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../data/curated/face/${name}`, import.meta.url), 'utf8')) as T
const visemes = load<FaceVisemes>('visemes.json')
const en = load<PhonemesEn>('phonemes-en.json')
const zh = load<VisemesZh & { missingShapes: { id: string; nearest: string }[]; sources: { id: string }[] }>('visemes-zh.json')
const ids = new Set(visemes.visemes.map((v) => v.id))
const tables = { en, zh }

const ARPABET = 'AA AE AH AO AW AY B CH D DH EH ER EY F G HH IH IY JH K L M N NG OW OY P R S SH T TH UH UW V W Y Z ZH'.split(' ')
// 后端会给出的全部音（soma/server/soma_tts/phones.py）/ every phone the backend can emit (soma/server/soma_tts/phones.py)
const BACKEND_EN = [...ARPABET, 'AX', 'IX', 'DX']
const INITIALS = 'b p m f d t n l g k h j q x zh ch sh r z c s'.split(' ')
const FINALS = 'a o e ie ai ei ao ou an en ang eng er i u v ii iii ve ia ian iang iao in ing iong iou ong ua uai uan uang uei uen ueng uo van vn'.split(' ')

describe('phoneme → viseme tables', () => {
  it('English: every ARPAbet phone and every phone the backend emits has a viseme that exists', () => {
    for (const p of BACKEND_EN) {
      const entry = en.phones[p]
      expect(entry, p).toBeDefined()
      expect(ids.has(entry!.viseme), p).toBe(true)
      for (const s of entry!.sequence ?? []) expect(ids.has(s.viseme), p).toBe(true)
    }
  })

  it('English: the 39 standard phones repeat the grouping of visemes.json (no second table)', () => {
    const group = new Map(visemes.visemes.flatMap((v) => v.phonemes.map((p) => [p.toUpperCase(), v.id] as const)))
    for (const p of ARPABET) expect(en.phones[p]!.viseme, p).toBe(group.get(p))
    // 双元音的序列从它在视位表里的口形开始 / a diphthong's sequence starts from its shape in the viseme table
    for (const [p, e] of Object.entries(en.phones)) if (e.sequence) expect(e.sequence[0]!.viseme, p).toBe(e.viseme)
  })

  it('Mandarin: the 21 initials, all finals and erhua are covered with existing visemes', () => {
    expect(Object.keys(zh.initials).sort()).toEqual([...INITIALS].sort())
    expect(Object.keys(zh.finals).sort()).toEqual([...FINALS].sort())
    expect(zh.erhua.r).toBeDefined()
    const sources = new Set(zh.sources.map((s) => s.id))
    const missing = new Set(zh.missingShapes.map((m) => m.id))
    for (const [key, e] of [...Object.entries(zh.initials), ...Object.entries(zh.finals), ...Object.entries(zh.erhua)] as [string, { sequence: { viseme: string; at: number; prefer?: string }[]; source?: string; assumption?: boolean }][]) {
      expect(e.sequence.length, key).toBeGreaterThan(0)
      expect(e.sequence[0]!.at, key).toBe(0)
      e.sequence.forEach((s, i) => {
        expect(ids.has(s.viseme), `${key}: ${s.viseme}`).toBe(true)
        if (i > 0) expect(s.at, key).toBeGreaterThan(e.sequence[i - 1]!.at)
        expect(s.at, key).toBeLessThan(1)
        if (s.prefer) expect(missing.has(s.prefer), `${key}: ${s.prefer}`).toBe(true)
      })
      // 每一条要么有出处，要么标成假设 / every entry has a source or is marked an assumption
      expect(e.assumption === true || (e.source !== undefined && sources.has(e.source)), key).toBe(true)
    }
  })

  it('Mandarin: ü is told apart from u, and retroflex and alveolo-palatal initials name the shape they lack', () => {
    for (const f of ['v', 've', 'van', 'vn']) expect(zh.finals[f]!.sequence[0]!.prefer, f).toBe('YU')
    expect(zh.finals.u!.sequence[0]!.prefer).toBeUndefined()
    for (const i of ['zh', 'ch', 'sh', 'r']) expect(zh.initials[i]!.sequence[0]!.prefer, i).toBe('ZHCHSH')
    for (const i of ['j', 'q', 'x']) expect(zh.initials[i]!.sequence[0]!.prefer, i).toBe('JQX')
    // 鼻音韵尾：-n 收在舌尖，-ng 收在舌根 / nasal codas: -n ends on the tongue tip, -ng on the tongue back
    for (const [f, e] of Object.entries(zh.finals)) {
      const last = e.sequence[e.sequence.length - 1]!.viseme
      if (f.endsWith('ng')) expect(last, f).toBe('KG')
      else if (f.endsWith('n')) expect(last, f).toBe('TDN')
    }
  })
})

const phone = (t0: number, t1: number, p: string, extra: Partial<TtsPhone> = {}): TtsPhone => ({ t0, t1, phone: p, symbol: p, word: 0, ...extra })

describe('phonemesToVisemeSegments', () => {
  it('English: pauses are dropped, diphthongs are split, stress sets the power', () => {
    // "buy five": B AY1 F AY1 V
    const timeline = [phone(0, 0.3, 'sil', { word: null }), phone(0.3, 0.4, 'B', { stress: null }), phone(0.4, 0.6, 'AY', { stress: 1 }), phone(0.6, 0.7, 'F', { stress: null }), phone(0.7, 0.9, 'AX', { stress: 0 }), phone(0.9, 1.2, 'sil', { word: null })]
    const segs = phonemesToVisemeSegments(timeline, 'en', tables)
    expect(segs.map((s) => s.viseme)).toEqual(['PBM', 'AA', 'IY', 'FV', 'AX'])
    expect(segs[0]).toMatchObject({ start: 0.3, end: 0.4, power: 1 })
    expect(segs[1]!.start).toBeCloseTo(0.4)
    expect(segs[1]!.end).toBeCloseTo(0.52)
    expect(segs[2]!.start).toBeCloseTo(0.52)
    expect(segs[2]!.end).toBeCloseTo(0.6)
    expect(segs[4]!.power).toBe(en.power.byStress['0'])
    // 每个音的时间被它的视位铺满，不重叠 / each sound's time is tiled by its visemes without overlap
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.start).toBeGreaterThanOrEqual(segs[i - 1]!.end - 1e-9)
  })

  it('Mandarin: initial, final with coda, erhua and neutral tone', () => {
    // 绿 lü4 · 院儿 yuanr4 · 的 de5
    const timeline = [phone(0, 0.1, 'l', { part: 'initial', tone: null }), phone(0.1, 0.3, 'v', { part: 'final', tone: 4 }), phone(0.3, 0.5, 'van', { part: 'final', tone: 4 }), phone(0.5, 0.6, 'r', { part: 'erhua', tone: 4 }), phone(0.6, 0.65, 'd', { part: 'initial', tone: null }), phone(0.65, 0.75, 'e', { part: 'final', tone: 5 })]
    const segs = phonemesToVisemeSegments(timeline, 'zh', tables)
    expect(segs.map((s) => s.viseme)).toEqual(['L', 'UW', 'UW', 'EH', 'TDN', 'R', 'TDN', 'AX'])
    expect(segs[segs.length - 1]!.power).toBe(zh.power.byTone['5'])
    // 面部数据里有了 YU 就用它；r 作声母和作儿化是两条 / with YU in the face data it is used; r as an initial and as erhua are two entries
    const withYu = phonemesToVisemeSegments(timeline, 'zh', tables, { available: ['YU'] })
    expect(withYu.map((s) => s.viseme).slice(0, 3)).toEqual(['L', 'YU', 'YU'])
    expect(phonemesToVisemeSegments([phone(0, 0.1, 'r', { part: 'initial', tone: null })], 'zh', tables, { available: ['ER', 'ZHCHSH'] })[0]!.viseme).toBe('ZHCHSH')
  })

  it('unknown phones and missing tables yield nothing instead of throwing', () => {
    expect(phonemesToVisemeSegments([phone(0, 0.1, '?'), phone(0.1, 0.1, 'B')], 'en', tables)).toEqual([])
    expect(phonemesToVisemeSegments([phone(0, 0.1, 'B')], 'en', {})).toEqual([])
  })

  it('feeds coarticulate: a bilabial closes the lips and a labiodental touches the teeth at the right times', () => {
    const timeline = [phone(0.2, 0.3, 'M', { stress: null }), phone(0.3, 0.5, 'AA', { stress: 1 }), phone(0.5, 0.6, 'F', { stress: null }), phone(0.6, 0.8, 'IY', { stress: 0 })]
    const track = coarticulate(phonemesToVisemeSegments(timeline, 'en', tables), visemes, { fps: 100, t0: 0, t1: 1 })
    const at = (t: number) => track.frames[Math.round(t * 100)]!
    expect(at(0.25).closure).toBeGreaterThan(0.9)
    expect(at(0.4).closure).toBeLessThan(0.1)
    expect(at(0.55).dental).toBeGreaterThan(0.9)
    expect(at(0.4).jaw.AA ?? 0).toBeGreaterThan(0.5)
  })
})

describe('the HTTP client', () => {
  const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('ttsAvailable never throws and needs the right service', async () => {
    expect(await ttsAvailable({ fetch: async () => { throw new Error('offline') } })).toBe(false)
    expect(await ttsAvailable({ fetch: async () => new Response('<!doctype html>', { status: 200 }) })).toBe(false)
    expect(await ttsAvailable({ fetch: reply({ ok: true, service: 'something-else' }) })).toBe(false)
    const health = { ok: true, service: 'soma-tts', languages: { en: { status: 'loading' }, zh: { status: 'missing' } } }
    expect(await ttsAvailable({ fetch: reply(health) })).toBe(true)
    expect(await ttsAvailable({ fetch: reply(health), lang: 'zh' })).toBe(false)
    // 超时也只是 false / a timeout is just false
    const hang = (_: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    expect(await ttsAvailable({ fetch: hang, timeoutMs: 20 })).toBe(false)
  })

  it('synthesize decodes the audio and reports refusals with field and allowed', async () => {
    const pcm = new Float32Array(2400).map((_, i) => 0.5 * Math.sin(i / 10))
    const audio = Buffer.from(encodeWav(pcm, 24000)).toString('base64')
    const body = { sampleRate: 24000, durationS: 0.1, lang: 'en', voice: 'af_heart', audio, phonemes: [phone(0, 0.1, 'AA', { stress: 1 })], words: [{ t0: 0, t1: 0.1, text: 'ah' }], warnings: [], model: { name: 'Kokoro-82M', version: 'v1.0', licence: 'Apache-2.0' } }
    const result = await synthesize({ text: 'ah', lang: 'en' }, { fetch: reply(body) })
    expect(result.sampleRate).toBe(24000)
    expect(result.pcm.length).toBe(2400)
    expect(result.pcm[100]!).toBeCloseTo(pcm[100]!, 3)
    expect(result.model.licence).toBe('Apache-2.0')
    const refused = synthesize({ text: 'x', lang: 'en', speed: 9 }, { fetch: reply({ detail: 'speed: must be a number from 0.5 to 2', field: 'speed', allowed: { minimum: 0.5, maximum: 2 } }, 422) })
    await expect(refused).rejects.toBeInstanceOf(TtsError)
    await expect(refused).rejects.toMatchObject({ status: 422, field: 'speed' })
  })
})
