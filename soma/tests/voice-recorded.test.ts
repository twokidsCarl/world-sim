// 基于录音的发声：变换函数、录音包的完整性、有包和没包两种情况下的行为。
// 需要录音包的测试在 public/voice/vivae-pain/ 不存在时跳过（比如商业构建删掉了它）。
// Recording-based vocalisation: the transformation, the integrity of the sound pack, and behaviour with
// and without the pack. Tests that need the pack are skipped when public/voice/vivae-pain/ is absent
// (for example removed from a commercial build).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadVoicePack, painVocalisation, PainVoice, renderPainVocalisation, transformClip, VARIATION, type PackManifest } from '../src/voice/index.ts'
import { measure } from '../tools/voice/analysis.ts'
import { ROOT } from '../tools/voice/corpus.ts'
import { loadLocalPack } from '../tools/voice/examples.ts'
import { distance, logMel } from '../tools/voice/metrics.ts'

const SR = 24000
const PACK_DIR = join(ROOT, 'public/voice/vivae-pain')
const hasPack = existsSync(join(PACK_DIR, 'manifest.json'))

// 带谐波的测试音，基频 f0，时长 seconds / a harmonic test tone with fundamental f0 lasting `seconds`
const tone = (f0: number, seconds: number) => {
  const x = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < x.length; i++) for (let h = 1; h <= 8; h++) x[i] = x[i]! + (0.2 / h) * Math.sin((2 * Math.PI * f0 * h * i) / SR + h)
  return x
}

describe('transformation of a clip', () => {
  const x = tone(300, 0.6)
  const track = new Array<number>(60).fill(300)

  it('returns the input when nothing is changed', () => {
    const y = transformClip(x, SR, track, 100, { pitchRatio: 1, timeRatio: 1 })
    expect(y.length).toBe(x.length)
    let err = 0
    for (let i = 500; i < x.length - 500; i++) err = Math.max(err, Math.abs(y[i]! - x[i]!))
    expect(err).toBeLessThan(0.01)
  })

  it('changes pitch and duration by the factors asked for', () => {
    for (const [pitch, time] of [[2 ** (1.5 / 12), 1], [2 ** (-1.5 / 12), 1], [1, 1.12], [1, 0.88], [0.6, 1]] as const) {
      const y = transformClip(x, SR, track, 100, { pitchRatio: pitch, timeRatio: time })
      expect(Math.abs(y.length / x.length - time)).toBeLessThan(0.01)
      expect(Math.abs(measure(y, SR).f0MeanHz / (300 * pitch) - 1)).toBeLessThan(0.03)
      expect(y.every((v) => Number.isFinite(v))).toBe(true)
    }
    // 没有变化时距离为零 / zero distance with no change
    expect(distance(logMel(x, SR), logMel(transformClip(x, SR, track, 100, { pitchRatio: 1, timeRatio: 1 }), SR)).mcdDb).toBeLessThan(0.05)
  })

  it('handles unvoiced input and scales formants', () => {
    let a = 7
    const noise = new Float32Array(SR / 2).map(() => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return (a / 4294967296 - 0.5) * 0.2 })
    const y = transformClip(noise, SR, new Array<number>(50).fill(0), 100, { pitchRatio: 1.1, timeRatio: 1.1, formantRatio: 0.853 })
    expect(Math.abs(y.length / noise.length - 1.1)).toBeLessThan(0.01)
    expect(y.every((v) => Number.isFinite(v))).toBe(true)
  })
})

describe('without the sound pack', () => {
  it('falls back to the parametric synthesizer', async () => {
    const voice = new PainVoice(null)
    expect(voice.hasRecordings).toBe(false)
    const input = { intensity: 7, onset: 'sudden', sex: 'female', seed: 3 } as const
    const v = voice.vocalise(input)
    expect(v.source).toBe('synthetic')
    expect(v).toEqual(painVocalisation(input))
    const r = renderPainVocalisation(v, 22050)!
    expect(r.sampleRate).toBe(22050)
    expect(r.pcm.length).toBeGreaterThan(1000)
    expect(renderPainVocalisation(painVocalisation({ ...input, intensity: 0 }))).toBeNull()
    // 目录不存在：取清单得到 404，或者请求直接失败 / directory absent: the manifest request gives 404, or the request fails outright
    expect(await loadVoicePack('/voice/vivae-pain/', (async () => new Response('', { status: 404 })) as unknown as typeof fetch)).toBeNull()
    expect(await loadVoicePack('/voice/vivae-pain/', (async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBeNull()
  })
})

describe.skipIf(!hasPack)('the sound pack', () => {
  const manifest = hasPack ? (JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8')) as PackManifest) : (null as unknown as PackManifest)

  it('holds exactly the pain clips, the manifest and the licence files', () => {
    const files = readdirSync(PACK_DIR).sort()
    const listed = manifest.clips.map((c) => c.file)
    expect(files).toEqual([...listed, 'ATTRIBUTION.txt', 'LICENSE.txt', 'manifest.json'].sort())
    expect(listed.length).toBe(185)
    expect(new Set(listed).size).toBe(185)
    for (const c of manifest.clips) {
      expect(c.file).toMatch(/^S\d+_pain_(low|moderate|strong|peak)_\d+\.wav$/)
      expect(c.file).toContain(`${c.speaker}_pain_${c.level}_`)
      const frames = c.tracks.f0.length
      expect(Math.abs(frames - c.durationS * 100)).toBeLessThan(1.5)
      expect(c.tracks.levelDb.length).toBe(frames)
      expect(c.tracks.mouth.length).toBe(frames)
      expect(c.tracks.voiced.length).toBe(frames)
      expect(c.tracks.mouth.every((m) => m >= 0 && m <= 100)).toBe(true)
    }
    // 仓库里要小：总共 15 MB 以下，单个文件远小于 50 MB / small in the repository: under 15 MB in total, every file far below 50 MB
    const sizes = files.map((f) => statSync(join(PACK_DIR, f)).size)
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThan(15e6)
    expect(Math.max(...sizes)).toBeLessThan(1e6)
  })

  it('carries its own non-commercial licence and attribution', () => {
    const licence = readFileSync(join(PACK_DIR, 'LICENSE.txt'), 'utf8')
    const attribution = readFileSync(join(PACK_DIR, 'ATTRIBUTION.txt'), 'utf8')
    for (const text of [licence, attribution]) {
      expect(text).toContain('CC BY-NC 4.0')
      expect(text).toContain('https://creativecommons.org/licenses/by-nc/4.0/')
      expect(text).toMatch(/NON-COMMERCIAL USE ONLY/)
      expect(text).toContain('仅限非商业使用')
      expect(text).toMatch(/must delete this directory/)
    }
    for (const needle of ['Holz', 'Larrouy-Maestri', 'Poeppel', '10.5281/zenodo.4066235', '10.1037/emo0001048', 'Changes made', '改动说明']) expect(attribution).toContain(needle)
    expect(manifest.licence).toBe('CC BY-NC 4.0')
    expect(JSON.stringify(manifest)).not.toMatch(/\/Users\/|@/)
  })

  it('can be loaded over fetch', async () => {
    const serve = (async (url: string) => {
      const path = join(PACK_DIR, url.replace('/voice/vivae-pain/', ''))
      return existsSync(path) ? new Response(new Uint8Array(readFileSync(path))) : new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const pack = await loadVoicePack('/voice/vivae-pain/', serve)
    expect(pack).not.toBeNull()
    expect(pack!.audio.size).toBe(185)
    expect(pack!.sampleRate).toBe(24000)
  }, 30000)
})

describe.skipIf(!hasPack)('recording-based voice', () => {
  const pack = hasPack ? loadLocalPack(PACK_DIR)! : null
  const levelOf = (file: string) => /_pain_([a-z]+)_/.exec(file)![1]!

  it('uses the recordings, deterministically, with a timeline that matches the audio', () => {
    const run = () => {
      const voice = new PainVoice(pack)
      return Array.from({ length: 24 }, (_, i) => voice.vocalise({ intensity: 2 + (i % 9), onset: i % 4 === 3 ? 'sustained' : 'sudden', sex: i % 5 === 4 ? 'male' : 'female', seed: 100 + i, vocalise: 'always' }))
    }
    const a = run()
    const b = run()
    a.forEach((v, i) => {
      expect(v.source).toBe('recorded')
      expect(v.type).not.toBe('none')
      const r = v.recorded!
      expect(r.sampleRate).toBe(24000)
      expect(Array.from(r.pcm.subarray(0, 4000))).toEqual(Array.from(b[i]!.recorded!.pcm.subarray(0, 4000)))
      expect(r.clips).toEqual(b[i]!.recorded!.clips)
      let peak = 0
      let finite = true
      for (let k = 0; k < r.pcm.length; k++) { if (!Number.isFinite(r.pcm[k]!)) finite = false; peak = Math.max(peak, Math.abs(r.pcm[k]!)) }
      expect(finite).toBe(true)
      expect(peak).toBeLessThanOrEqual(0.9501)
      expect(peak).toBeGreaterThan(1e-4)
      // 时间线和音频一样长（差不超过两帧），各事件首尾相接 / the timeline is as long as the audio (within two frames) and its events are contiguous
      const tl = v.timeline
      expect(Math.abs(tl.durationS - r.pcm.length / r.sampleRate)).toBeLessThan(0.02)
      expect(tl.mouth.length).toBe(Math.max(1, Math.ceil(tl.durationS * 100)))
      expect(tl.events[0]!.startS).toBe(0)
      for (let k = 1; k < tl.events.length; k++) expect(tl.events[k]!.startS).toBeCloseTo(tl.events[k - 1]!.endS, 6)
      expect(tl.events[tl.events.length - 1]!.endS).toBeCloseTo(tl.durationS, 2)
      for (let k = 0; k < tl.mouth.length; k++) {
        expect(tl.mouth[k]!).toBeGreaterThanOrEqual(0)
        expect(tl.mouth[k]!).toBeLessThanOrEqual(1)
        expect(tl.level[k]!).toBeLessThanOrEqual(1.0001)
        expect(Math.abs(tl.airflow[k]!)).toBeLessThanOrEqual(1.0001)
      }
      expect(renderPainVocalisation(v, 48000)!.pcm.length).toBe(Math.round((r.pcm.length * 48000) / 24000))
    })
  }, 60000)

  it('never repeats a recording back to back', () => {
    const voice = new PainVoice(pack)
    let previous: string[] = []
    for (let i = 0; i < 150; i++) {
      // 同一个强度连着要，最容易重复 / asking for the same intensity over and over is the easiest way to get repeats
      const v = voice.vocalise({ intensity: i < 75 ? 10 : 2.5, onset: 'sudden', sex: 'female', seed: i, vocalise: 'always' })
      const clips = v.recorded!.clips
      for (const c of clips) expect(previous).not.toContain(c)
      previous = clips
    }
    // 持续性的一串里也没有相邻重复 / no adjacent repeats within a sustained sequence either
    for (let i = 0; i < 20; i++) {
      const clips = voice.vocalise({ intensity: 10, onset: 'sustained', sex: 'female', seed: 500 + i, vocalise: 'always' }).recorded!.clips.filter((_, k) => k % 2 === 0)
      expect(new Set(clips).size).toBe(clips.length)
    }
  }, 60000)

  it('maps intensity onto the recorded levels and gets louder with it', () => {
    const voice = new PainVoice(pack)
    const levels = (intensity: number) => Array.from({ length: 40 }, (_, s) => levelOf(voice.vocalise({ intensity, onset: 'sudden', sex: 'female', seed: s, vocalise: 'always' }).recorded!.clips[0]!))
    expect(new Set(levels(10))).toEqual(new Set(['peak']))
    expect(new Set(levels(1.5))).toEqual(new Set(['low']))
    expect(new Set(levels(6))).toEqual(new Set(['moderate', 'strong']))
    const loud = (intensity: number) => {
      const v = Array.from({ length: 40 }, (_, s) => { const r = voice.vocalise({ intensity, onset: 'sudden', sex: 'female', seed: 900 + s, vocalise: 'always' }).recorded!; return measure(r.pcm, r.sampleRate).levelDb }).sort((x, y) => x - y)
      return v[20]!
    }
    const l = [2.5, 5, 7.5, 10].map(loud)
    for (let i = 1; i < 4; i++) expect(l[i]!).toBeGreaterThan(l[i - 1]!)
  }, 60000)

  it('keeps the silence rule and offers both male voices', () => {
    const voice = new PainVoice(pack)
    for (let seed = 0; seed < 50; seed++) {
      const v = voice.vocalise({ intensity: 1, onset: 'sudden', sex: 'female', seed })
      expect(v.type).toBe('none')
      expect(v.recorded).toBeUndefined()
      expect(renderPainVocalisation(v)).toBeNull()
    }
    expect(voice.vocalise({ intensity: 7, onset: 'sudden', sex: 'male', seed: 1, male: 'synthetic' }).source).toBe('synthetic')
    // 推出来的男声：平均基频明显低于同一批种子的女声 / the derived male voice: mean F0 clearly below the female voice for the same seeds
    const f0 = (sex: 'male' | 'female') => {
      const fresh = new PainVoice(pack)
      const v = Array.from({ length: 30 }, (_, s) => { const r = fresh.vocalise({ intensity: 7, onset: 'sudden', sex, seed: s, vocalise: 'always' }).recorded!; return measure(r.pcm, r.sampleRate).f0MeanHz }).filter(Number.isFinite).sort((x, y) => x - y)
      return v[v.length >> 1]!
    }
    const ratio = f0('male') / f0('female')
    expect(ratio).toBeGreaterThan(0.5)
    expect(ratio).toBeLessThan(0.8)
    expect(VARIATION.pitchSemitones).toBeLessThanOrEqual(2)
  }, 60000)
})
