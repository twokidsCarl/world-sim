// 从声音估计口型（mouthTrack）：用参数合成器造出已知共振峰和张口度的声音，看能不能测回来。
// Mouth features from audio (mouthTrack): sounds with known formants and mouth opening are made with
// the parametric synthesizer and the analysis has to recover them.
import { describe, expect, it } from 'vitest'
import { formants, mouthTrack, renderVocalisation, type MouthFrame, type Segment, type VocalisationParams, type Vowel } from '../src/voice/index.ts'

const SR = 44100
const voiced = (vowel: Vowel, f0: number, durationS: number, mouth: { t: number; v: number }[]): Segment => ({ kind: 'voiced', durationS, f0: [{ t: 0, v: f0 }, { t: 1, v: f0 * 0.92 }], amp: [{ t: 0, v: 0.3 }, { t: 0.1, v: 1 }, { t: 0.9, v: 1 }, { t: 1, v: 0.3 }], mouth, vowel, relDb: 0, openQuotient: 0.6, tiltDb: 6, jitter: 0.005, shimmer: 0.02, noiseDb: -40, noiseDirect: 0, flutterSt: 0.05, nonlinear: [] })
const render = (segments: Segment[], vocalTractCm = 17) => renderVocalisation({ sex: 'male', vocalTractCm, levelDb: -20, seed: 1, segments } satisfies VocalisationParams, SR).pcm
const mean = (frames: MouthFrame[], k: (f: MouthFrame) => number) => frames.reduce((s, f) => s + k(f), 0) / frames.length

describe('mouthTrack on synthetic vowels', () => {
  const cases = ([[17, 120], [14.5, 210]] as const).flatMap(([vt, f0]) => (['i', 'e', 'a', 'o', 'u'] as Vowel[]).map((v) => ({ vt, v, frames: mouthTrack(render([voiced(v, f0, 0.5, [{ t: 0, v: 0.5 }])], vt), SR).slice(15, 40) })))

  it('recovers the formants within 15 %', () => {
    for (const c of cases) {
      const truth = formants(c.vt, c.v, 0.5).freq
      expect(Math.abs(mean(c.frames, (f) => f.f1) / truth[0]! - 1)).toBeLessThan(0.15)
      expect(Math.abs(mean(c.frames, (f) => f.f2) / truth[1]! - 1)).toBeLessThan(0.15)
    }
  })

  it('orders openness a > e > i and a > o > u, with a open and i, u nearly closed', () => {
    for (const vt of [17, 14.5]) {
      const open = Object.fromEntries(cases.filter((c) => c.vt === vt).map((c) => [c.v, mean(c.frames, (f) => f.open)])) as Record<Vowel, number>
      expect(open.a).toBeGreaterThan(open.e)
      expect(open.e).toBeGreaterThan(open.i)
      expect(open.a).toBeGreaterThan(open.o)
      expect(open.o).toBeGreaterThan(open.u)
      expect(open.a).toBeGreaterThan(0.8)
      expect(open.i).toBeLessThan(0.25)
      expect(open.u).toBeLessThan(0.3)
    }
  })

  it('reads rounding from low F2: o and u rounded, i and e spread, a neither', () => {
    for (const c of cases) {
      const round = mean(c.frames, (f) => f.round)
      if (c.v === 'o' || c.v === 'u') expect(round).toBeGreaterThan(0.4)
      if (c.v === 'i' || c.v === 'e') expect(round).toBeLessThan(-0.4)
      if (c.v === 'a') expect(Math.abs(round)).toBeLessThan(0.45)
      expect(mean(c.frames, (f) => (f.voiced ? 1 : 0))).toBeGreaterThan(0.9)
    }
  })

  it('follows a mouth that opens during the vowel', () => {
    const frames = mouthTrack(render([voiced('a', 120, 0.8, [{ t: 0, v: 0.1 }, { t: 1, v: 0.9 }])]), SR)
    expect(mean(frames.slice(55, 75), (f) => f.open)).toBeGreaterThan(mean(frames.slice(8, 28), (f) => f.open) + 0.2)
  })
})

describe('mouthTrack on closures and silence', () => {
  it('detects the closures of a synthetic a-b-a-b-a sequence', () => {
    // 嘴在元音末尾合上、停 80 毫秒、再张开：共振峰向下走，像双唇塞音
    // the mouth closes at the end of each vowel, stays shut for 80 ms and opens again: the formants move down, as for a bilabial stop
    const shut = [{ t: 0, v: 0.05 }, { t: 0.25, v: 0.8 }, { t: 0.75, v: 0.8 }, { t: 1, v: 0.05 }]
    const pcm = render([voiced('a', 120, 0.3, shut), { kind: 'pause', durationS: 0.08 }, voiced('a', 120, 0.3, shut), { kind: 'pause', durationS: 0.08 }, voiced('a', 120, 0.3, shut)])
    const frames = mouthTrack(pcm, SR)
    for (const [a, b] of [[0.31, 0.37], [0.69, 0.75]] as const) {
      const gap = frames.filter((f) => f.t >= a && f.t <= b)
      expect(gap.every((f) => f.closure >= 0.5)).toBe(true)
      expect(gap.every((f) => f.open < 0.2)).toBe(true)
    }
    for (const t of [0.15, 0.53, 0.91]) {
      const f = frames[Math.round(t * 100)]!
      expect(f.closure).toBe(0)
      expect(f.open).toBeGreaterThan(0.6)
    }
  })

  it('gives a closed, neutral mouth for silence and for an empty input', () => {
    const frames = mouthTrack(new Float32Array(SR), SR)
    expect(frames.length).toBe(100)
    for (const f of frames) {
      expect(f.open).toBe(0)
      expect(f.round).toBe(0)
      expect(f.closure).toBe(0)
      expect(f.dental).toBe(0)
      expect(f.voiced).toBe(false)
      expect(f.level).toBe(0)
    }
    expect(mouthTrack(new Float32Array(0), SR)).toEqual([])
    // 声音前后的静音同样是闭口 / silence before and after a sound is closed as well
    const padded = new Float32Array(SR * 2)
    padded.set(render([voiced('a', 120, 0.5, [{ t: 0, v: 0.6 }])]), SR / 2)
    const fr = mouthTrack(padded, SR)
    expect(fr[20]!.open).toBe(0)
    expect(fr[180]!.open).toBe(0)
    expect(fr[75]!.open).toBeGreaterThan(0.5)
  })
})

describe('mouthTrack in general', () => {
  it('is deterministic, finite, in range and at 100 frames per second for any sample rate', () => {
    let a = 99
    const noise = new Float32Array(16000).map(() => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return (a / 4294967296 - 0.5) * 0.4 })
    for (const [pcm, sr] of [[render([voiced('e', 300, 0.6, [{ t: 0, v: 0.5 }])], 14.5), SR], [noise, 16000], [new Float32Array(8000).fill(0.5), 8000]] as const) {
      const one = mouthTrack(pcm, sr)
      expect(one).toEqual(mouthTrack(pcm, sr))
      expect(one.length).toBe(Math.ceil((pcm.length / sr) * 100))
      one.forEach((f, i) => {
        expect(f.t).toBeCloseTo(i / 100, 9)
        for (const v of [f.open, f.closure, f.dental, f.level, f.tongue.low, f.tongue.front, f.tongue.back, f.tongue.tip, ...Object.values(f.confidence)]) {
          expect(Number.isFinite(v)).toBe(true)
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(1)
        }
        expect(Math.abs(f.round)).toBeLessThanOrEqual(1)
      })
    }
  })

  it('runs well inside real time', () => {
    const pcm = render([voiced('a', 150, 2, [{ t: 0, v: 0.3 }, { t: 0.5, v: 0.9 }, { t: 1, v: 0.2 }])])
    mouthTrack(pcm, SR)
    const t0 = performance.now()
    mouthTrack(pcm, SR)
    // 这台机器上测得每秒音频约 20–35 毫秒；门限留得很宽 / about 20–35 ms per second of audio on this machine; the bound is generous
    expect((performance.now() - t0) / (pcm.length / SR)).toBeLessThan(400)
  })
})
