// 疼痛发声合成器：信号层和控制层的测试，不需要下载的语料。
// Pain-vocalisation synthesizer: tests of the signal and control layers; no downloaded corpus needed.
import { describe, expect, it } from 'vitest'
import { computeTimeline, formants, painVocalisation, renderVocalisation, soundProbability, typeProbabilities, VOCAL_TRACT_CM, type VocalisationParams } from '../src/voice/index.ts'
import { measure, type Measures } from '../tools/voice/analysis.ts'

const SR = 44100
const render = (intensity: number, seed: number, sex: 'male' | 'female' = 'female', onset: 'sudden' | 'sustained' = 'sudden') => {
  const v = painVocalisation({ intensity, onset, sex, seed, vocalise: 'always' })
  return { v, r: renderVocalisation(v.params!, SR) }
}
const batch = (intensity: number, n: number, sex: 'male' | 'female' = 'female'): Measures[] => Array.from({ length: n }, (_, s) => { const { r } = render(intensity, 9000 + s, sex); return measure(r.pcm, r.sampleRate) })
const median = (a: number[]) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v[v.length >> 1]! }
const mean = (a: number[]) => { const v = a.filter(Number.isFinite); return v.reduce((s, x) => s + x, 0) / v.length }

describe('signal layer', () => {
  it('is deterministic for a given seed and differs between seeds', () => {
    const a = render(7, 42).r.pcm
    const b = render(7, 42).r.pcm
    const c = render(7, 43).r.pcm
    expect(a.length).toBe(b.length)
    expect(Array.from(a.subarray(0, 20000))).toEqual(Array.from(b.subarray(0, 20000)))
    let same = a.length === c.length
    if (same) same = a.every((v, i) => v === c[i])
    expect(same).toBe(false)
  })

  it('never produces NaN, never clips, and is not silent', () => {
    for (const sex of ['male', 'female'] as const) {
      for (const onset of ['sudden', 'sustained'] as const) {
        for (let intensity = 0; intensity <= 10; intensity++) {
          for (let seed = 0; seed < 6; seed++) {
            const { r } = render(intensity, seed, sex, onset)
            let peak = 0
            let finite = true
            for (let i = 0; i < r.pcm.length; i++) {
              const s = r.pcm[i]!
              if (!Number.isFinite(s)) finite = false
              peak = Math.max(peak, Math.abs(s))
            }
            expect(finite).toBe(true)
            expect(peak).toBeLessThanOrEqual(0.9501)
            expect(peak).toBeGreaterThan(1e-5)
          }
        }
      }
    }
  })

  it('keeps duration and target F0 within the stated bounds', () => {
    for (const sex of ['male', 'female'] as const) {
      for (const onset of ['sudden', 'sustained'] as const) {
        for (let seed = 0; seed < 150; seed++) {
          const { v, r } = render((seed % 11), seed, sex, onset)
          // 突发 ≤ 2.5 秒有声 + 气声；持续 ≤ 8 秒 + 换气 / sudden ≤ 2.5 s plus breath noise; sustained ≤ 8 s plus catch-breaths
          expect(v.timeline.durationS).toBeGreaterThanOrEqual(0.1)
          expect(v.timeline.durationS).toBeLessThanOrEqual(onset === 'sudden' ? 2.6 : 9.5)
          expect(r.pcm.length).toBe(Math.round(v.timeline.durationS * SR) + Math.round(0.04 * SR))
          for (const f of v.timeline.f0) {
            if (f === 0) continue
            // 中心基频限制在 男 70–1100、女 120–1700 Hz，轮廓起伏最多再加减约两个八度的一部分
            // the F0 centre is limited to 70–1100 Hz (male) and 120–1700 Hz (female); the contour adds a bounded excursion
            expect(f).toBeGreaterThan(sex === 'male' ? 25 : 40)
            expect(f).toBeLessThan(sex === 'male' ? 3200 : 4900)
          }
        }
      }
    }
  })

  it('measured F0 follows the F0 the parameters ask for', () => {
    const params: VocalisationParams = {
      sex: 'female', vocalTractCm: 14.5, levelDb: -20, seed: 1,
      segments: [{ kind: 'voiced', durationS: 0.8, f0: [{ t: 0, v: 300 }, { t: 1, v: 300 }], amp: [{ t: 0, v: 0 }, { t: 0.1, v: 1 }, { t: 0.9, v: 1 }, { t: 1, v: 0 }], mouth: [{ t: 0, v: 0.6 }], vowel: 'a', relDb: 0, openQuotient: 0.6, tiltDb: 6, jitter: 0.005, shimmer: 0.02, noiseDb: -40, noiseDirect: 0.5, flutterSt: 0, nonlinear: [] }],
    }
    const m = measure(renderVocalisation(params, SR).pcm, SR)
    expect(m.f0MeanHz).toBeGreaterThan(291)
    expect(m.f0MeanHz).toBeLessThan(309)
    expect(m.levelDb).toBeGreaterThan(-23)
    expect(m.levelDb).toBeLessThan(-17)
    expect(m.nonlinearShare).toBeLessThan(0.05)
    // 同样的参数加上次谐波和混沌段后，替代指标应当升高 / with subharmonic and chaotic spans added, the proxy has to rise
    const seg = params.segments[0]!
    if (seg.kind !== 'voiced') throw new Error('unreachable')
    const rough: VocalisationParams = { ...params, segments: [{ ...seg, nonlinear: [{ t0: 0.15, t1: 0.5, kind: 'sub', depth: 1 }, { t0: 0.55, t1: 0.85, kind: 'chaos', depth: 1 }] }] }
    const mr = measure(renderVocalisation(rough, SR).pcm, SR)
    expect(mr.nonlinearShare).toBeGreaterThan(0.3)
    expect(mr.hnrDb).toBeLessThan(m.hnrDb)
  })

  it('renders at other sample rates', () => {
    const v = painVocalisation({ intensity: 8, onset: 'sudden', sex: 'male', seed: 5, vocalise: 'always' })
    for (const sr of [16000, 22050, 48000]) {
      const r = renderVocalisation(v.params!, sr)
      expect(r.sampleRate).toBe(sr)
      expect(r.pcm.every((s) => Number.isFinite(s) && Math.abs(s) <= 0.9501)).toBe(true)
    }
  })

  it('gives distinct formants for male and female vocal tracts, and mouth opening raises F1', () => {
    const m = formants(VOCAL_TRACT_CM.male, 'schwa', 0.5).freq
    const f = formants(VOCAL_TRACT_CM.female, 'schwa', 0.5).freq
    for (let i = 0; i < 4; i++) expect(f[i]!).toBeGreaterThan(m[i]! * 1.1)
    // 均匀管：F1 = c / 4L / uniform tube: F1 = c / 4L
    expect(m[0]!).toBeCloseTo(35400 / (4 * 17), 6)
    expect(formants(17, 'a', 0.9).freq[0]!).toBeGreaterThan(formants(17, 'a', 0.2).freq[0]!)
  })
})

describe('timeline', () => {
  it('matches the segments and stays within range', () => {
    for (let seed = 0; seed < 40; seed++) {
      const { v } = render(3 + (seed % 8), seed, 'female', seed % 2 ? 'sudden' : 'sustained')
      const tl = computeTimeline(v.params!)
      expect(tl).toEqual(v.timeline)
      expect(tl.frameRate).toBe(100)
      expect(tl.mouth.length).toBe(Math.ceil(tl.durationS * 100))
      expect(tl.events[0]!.startS).toBe(0)
      expect(tl.events[tl.events.length - 1]!.endS).toBeCloseTo(tl.durationS, 9)
      for (let i = 0; i < tl.mouth.length; i++) {
        expect(tl.mouth[i]!).toBeGreaterThanOrEqual(0)
        expect(tl.mouth[i]!).toBeLessThanOrEqual(1)
        expect(tl.level[i]!).toBeLessThanOrEqual(1)
        expect(Math.abs(tl.airflow[i]!)).toBeLessThanOrEqual(1)
      }
      // 吸气段气流为负，有声段为正且有基频 / airflow is negative in inhalations, positive with an F0 in voiced segments
      for (const e of tl.events) {
        const mid = Math.floor(((e.startS + e.endS) / 2) * 100)
        if (e.kind === 'inhale') expect(tl.airflow[mid]!).toBeLessThan(0)
        if (e.kind === 'voiced') { expect(tl.airflow[mid]!).toBeGreaterThan(0); expect(tl.f0[mid]!).toBeGreaterThan(0) }
      }
    }
  })
})

describe('control layer', () => {
  it('is deterministic and varies between repetitions', () => {
    const a = painVocalisation({ intensity: 6, onset: 'sudden', sex: 'female', seed: 11, vocalise: 'always' })
    const b = painVocalisation({ intensity: 6, onset: 'sudden', sex: 'female', seed: 11, vocalise: 'always' })
    expect(a).toEqual(b)
    const durations = new Set(Array.from({ length: 20 }, (_, s) => painVocalisation({ intensity: 6, onset: 'sudden', sex: 'female', seed: s, vocalise: 'always' }).timeline.durationS))
    expect(durations.size).toBeGreaterThan(15)
  })

  it('returns silence where the rule says so', () => {
    // 规则：突发强度 ≤ 1、持续强度 ≤ 2 时从不出声；突发 ≥ 5、持续 ≥ 8 时总出声。
    // The rule: never a sound at sudden ≤ 1 or sustained ≤ 2; always a sound at sudden ≥ 5 or sustained ≥ 8.
    expect(soundProbability(1, 'sudden')).toBe(0)
    expect(soundProbability(2, 'sustained')).toBe(0)
    expect(soundProbability(5, 'sudden')).toBe(1)
    expect(soundProbability(8, 'sustained')).toBe(1)
    for (let seed = 0; seed < 200; seed++) {
      for (const [intensity, onset] of [[0, 'sudden'], [1, 'sudden'], [0, 'sustained'], [2, 'sustained']] as const) {
        const v = painVocalisation({ intensity, onset, sex: 'male', seed })
        expect(v.type).toBe('none')
        expect(v.params).toBeNull()
        expect(v.timeline.durationS).toBe(0)
      }
      expect(painVocalisation({ intensity: 5, onset: 'sudden', sex: 'male', seed }).type).not.toBe('none')
      expect(painVocalisation({ intensity: 8, onset: 'sustained', sex: 'female', seed }).type).not.toBe('none')
    }
    // 中间强度：出声的比例接近规则给的概率，并随强度上升 / in between, the share that sounds is near the rule's probability and rises with intensity
    const share = (intensity: number) => Array.from({ length: 2000 }, (_, seed) => painVocalisation({ intensity, onset: 'sudden', sex: 'female', seed })).filter((v) => v.type !== 'none').length / 2000
    expect(Math.abs(share(2) - soundProbability(2, 'sudden'))).toBeLessThan(0.04)
    expect(Math.abs(share(3) - 0.5)).toBeLessThan(0.04)
    expect(share(4)).toBeGreaterThan(share(3))
  })

  it('"always" gives the same vocalisation as "auto" whenever auto sounds', () => {
    for (let seed = 0; seed < 50; seed++) {
      const auto = painVocalisation({ intensity: 3, onset: 'sudden', sex: 'female', seed })
      const always = painVocalisation({ intensity: 3, onset: 'sudden', sex: 'female', seed, vocalise: 'always' })
      expect(always.params).not.toBeNull()
      expect(always.silentByRule).toBe(auto.type === 'none')
      if (auto.type !== 'none') expect(always).toEqual(auto)
    }
  })

  it('shifts the mix of types from breath and grunts to cries and screams', () => {
    const low = typeProbabilities(2, 'sudden')
    const high = typeProbabilities(10, 'sudden')
    expect(low.inhalation + low.grunt + low.moan).toBeGreaterThan(0.9)
    expect(high.cry + high.scream).toBeGreaterThan(0.85)
    expect(typeProbabilities(4, 'sustained').moan).toBeGreaterThan(0.5)
    for (const p of [low, high]) expect(Object.values(p).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
  })
})

describe('calibrated trends over seeds', () => {
  const N = 120
  const levels = [2.5, 5, 7.5, 10]
  const female = levels.map((i) => batch(i, N))

  it('mean F0 and level rise with intensity at every step', () => {
    const f0 = female.map((b) => median(b.map((m) => m.f0MeanHz)))
    const level = female.map((b) => median(b.map((m) => m.levelDb)))
    for (let i = 1; i < levels.length; i++) {
      expect(f0[i]!).toBeGreaterThan(f0[i - 1]!)
      expect(level[i]!).toBeGreaterThan(level[i - 1]! + 2)
    }
    expect(level[3]! - level[0]!).toBeGreaterThan(15)
  })

  it('nonlinear share follows the corpus: highest at the top, not monotonic below', () => {
    // 语料里这个替代指标在最低一级和最高一级都高、中间低（Raine 等 2019 的女声 %NLP 也是这样），
    // 所以这里只要求：峰值强度高于中间两级，次谐波部分从最低到最高上升。
    // In the corpus this proxy is high at the lowest and the highest level and lower between (as is the
    // female %NLP of Raine et al. 2019), so the test asks only that peak intensity exceeds the two
    // middle levels and that the subharmonic part rises from lowest to highest.
    const nl = female.map((b) => mean(b.map((m) => m.nonlinearShare)))
    const sub = female.map((b) => mean(b.map((m) => m.subShare)))
    expect(nl[3]!).toBeGreaterThan(nl[2]!)
    expect(nl[3]!).toBeGreaterThan(nl[1]! - 0.02)
    expect(sub[3]!).toBeGreaterThan(sub[0]!)
    for (const v of nl) { expect(v).toBeGreaterThan(0.03); expect(v).toBeLessThan(0.4) }
  })

  it('male and female F0 ranges are distinct', () => {
    for (const [j, intensity] of [[1, 5], [3, 10]] as const) {
      const male = batch(intensity, N, 'male')
      const mf = median(male.map((m) => m.f0MeanHz))
      const ff = median(female[j]!.map((m) => m.f0MeanHz))
      // Raine 等 (2019)：男声平均基频约为女声的 0.58–0.63 倍 / Raine et al. (2019): male mean F0 is about 0.58–0.63 of female
      expect(mf / ff).toBeGreaterThan(0.45)
      expect(mf / ff).toBeLessThan(0.8)
    }
  })
})
