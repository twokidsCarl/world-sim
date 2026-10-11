// 校准数据与分析代码的测试。语料一侧的分析只在本机下载了语料时才跑。
// Tests of the calibration data and the analysis code. The corpus-side analysis runs only where the corpus has been downloaded.
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FITTED, VIVAE_LEVELS } from '../src/voice/index.ts'
import { DEFAULT_ANALYSIS, measure } from '../tools/voice/analysis.ts'
import { analyseCorpus, CALIBRATION_PATH, LEVELS, STAT_KEYS, VIVAE_DIR, type Calibration } from '../tools/voice/corpus.ts'
import { decodeWav, encodeWav } from '../tools/voice/wav.ts'

const SR = 44100
const tone = (hz: number, seconds: number, amp = 0.2, harmonics = 6) => {
  const x = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < x.length; i++) for (let h = 1; h <= harmonics; h++) x[i] = x[i]! + (amp / h) * Math.sin((2 * Math.PI * hz * h * i) / SR)
  return x
}

describe('acoustic analysis', () => {
  it('measures F0, duration and level of a harmonic tone', () => {
    for (const hz of [110, 220, 440, 880, 1500]) {
      const x = new Float32Array(SR)
      x.set(tone(hz, 0.5), Math.round(0.25 * SR))
      const m = measure(x, SR)
      expect(Math.abs(m.f0MeanHz / hz - 1)).toBeLessThan(0.02)
      expect(Math.abs(m.durationS - 0.5)).toBeLessThan(0.05)
      expect(m.voicedShare).toBeGreaterThan(0.85)
      expect(m.hnrDb).toBeGreaterThan(20)
      expect(m.nonlinearShare).toBeLessThan(0.05)
    }
  })

  it('reports noise as unvoiced and a period-doubled tone as subharmonic', () => {
    let a = 12345
    const noise = new Float32Array(SR / 2).map(() => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return (a / 4294967296 - 0.5) * 0.3 })
    expect(measure(noise, SR).voicedShare).toBeLessThan(0.1)
    // 每隔一个周期减弱：基频 400 Hz，带 200 Hz 的次谐波 / every other period weakened: F0 400 Hz with a subharmonic at 200 Hz
    const x = tone(400, 0.6, 0.2, 8)
    const period = SR / 400
    for (let i = 0; i < x.length; i++) if (Math.floor(i / period) % 2) x[i] = x[i]! * 0.75
    const m = measure(x, SR)
    expect(m.subShare).toBeGreaterThan(0.7)
    expect(Math.abs(m.f0MeanHz / 400 - 1)).toBeLessThan(0.05)
  })

  it('round-trips WAV', () => {
    const x = tone(300, 0.1)
    const w = decodeWav(encodeWav(x, SR))
    expect(w.sampleRate).toBe(SR)
    expect(w.samples.length).toBe(x.length)
    for (let i = 0; i < x.length; i += 97) expect(Math.abs(w.samples[i]! - x[i]!)).toBeLessThan(1e-4)
  })
})

describe('calibration.json', () => {
  const cal = JSON.parse(readFileSync(CALIBRATION_PATH, 'utf8')) as Calibration
  const text = readFileSync(CALIBRATION_PATH, 'utf8')

  it('holds aggregates only, with sources and bilingual notes', () => {
    expect(cal._doc.zh.length).toBeGreaterThan(20)
    expect(cal._doc.en.length).toBeGreaterThan(20)
    expect(cal.method.zh.length).toBeGreaterThan(20)
    expect(cal.analysisOptions).toEqual(DEFAULT_ANALYSIS)
    expect(JSON.stringify(cal.sources)).toContain('CC BY-NC 4.0')
    // 没有文件名、没有说话人编号、没有本机路径 / no file names, no speaker ids, no local paths
    expect(text).not.toMatch(/\.wav|S\d\d_|\/Users\/|@/)
    for (const lv of LEVELS) {
      const level = cal.vivae.levels[lv]
      expect(level.intensity).toBe(VIVAE_LEVELS[lv])
      expect(level.n).toBeGreaterThanOrEqual(30)
      expect(Object.keys(level.measures).sort()).toEqual([...STAT_KEYS].sort())
      for (const k of STAT_KEYS) {
        expect(Object.keys(level.measures[k]).sort()).toEqual(['mean', 'n', 'p10', 'p25', 'p50', 'p75', 'p90', 'sd'])
        expect(level.measures[k].n).toBeGreaterThanOrEqual(30)
      }
    }
  })

  it('shows level and median F0 rising with intensity in the corpus', () => {
    const at = (k: 'levelDb' | 'f0MeanHz') => LEVELS.map((lv) => cal.vivae.levels[lv].measures[k].p50)
    for (const k of ['levelDb', 'f0MeanHz'] as const) for (let i = 1; i < 4; i++) expect(at(k)[i]!).toBeGreaterThan(at(k)[i - 1]!)
  })

  it('fitted knots sit on the corpus levels', () => {
    expect(FITTED.intensity).toEqual(LEVELS.map((lv) => VIVAE_LEVELS[lv]))
    for (const key of Object.keys(FITTED) as (keyof typeof FITTED)[]) expect(FITTED[key].length).toBe(4)
  })
})

describe.skipIf(!existsSync(VIVAE_DIR))('corpus-side analysis (needs data/raw/voice/)', () => {
  it('reproduces the committed aggregates', () => {
    const cal = JSON.parse(readFileSync(CALIBRATION_PATH, 'utf8')) as Calibration
    expect(JSON.parse(JSON.stringify(analyseCorpus()))).toEqual(cal.vivae.levels)
  }, 60000)
})
