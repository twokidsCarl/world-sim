// "说一句话"背后的纯逻辑：分组的协同发音、音素轨迹、口形三个来源的优先级、风格、下颌从别处张开时的合唇、
// 深链接参数 say / style、示范片段清单，以及 sim.json 里说话卡片指向的片段。
// The pure logic behind "say something": grouped co-articulation, the phoneme track, the precedence of the three mouth sources,
// styles, sealing the lips when the jaw is opened from elsewhere, the deep-link parameters say / style, the demo-clip manifest,
// and the clips the speech cards of sim.json point at.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SPEECH_STYLES, blendFace, coarticulate, deform, expressionAUs, visemeAUs, type Activations, type VisemeSegment } from '../tools/face/model.ts'
import { stale } from '../tools/face/run.ts'
import { type Body, readBody } from '../tools/rig/io.ts'
import { Poser } from '../tools/rig/pose.ts'
import { AnatomyGraph } from '../src/anatomy/graph.ts'
import type { AnatomyData, Part, Rig } from '../src/anatomy/types.ts'
import { FaceDriver, composeFace, faceFrame, resetFaceDriver } from '../src/face/driver.ts'
import { DEMO_PACKS, lastSaySample, loadTimeline, packFromManifest, resetSay, sayNow, seekSay, stopSay } from '../src/face/say.ts'
import type { FaceData, FaceOpenings } from '../src/face/types.ts'
import { coarticulateGroups, phonemeTrack, resolveConstraints, resolveStyle, spokenAt, trackIndex, trackPose } from '../src/face/visemeTrack.ts'
import { resetPainController } from '../src/pain/controller.ts'
import { indexFace } from '../src/pain/face.ts'
import { setFaceLoader, setRigLoader, useApp } from '../src/state/store.ts'
import { resetUrlSync, restoreFromUrl, snapshot } from '../src/state/urlSync.ts'
import { formatUrl, parseUrl } from '../src/state/urlState.ts'
import { phonemesToVisemeGroups, phonemesToVisemeSegments, type PhonemesEn, type TtsPhone, type TtsWord, type VisemesZh } from '../src/voice/tts.ts'

const ROOT = resolve(__dirname, '..')
const MM = 1e-3
const json = <T>(p: string): T => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')) as T
const tables = { en: json<PhonemesEn>('data/curated/face/phonemes-en.json'), zh: json<VisemesZh>('data/curated/face/visemes-zh.json') }
const facePath = resolve(ROOT, 'public/anatomy/male/face.json')
const present = existsSync(facePath)
const face = present ? json<FaceData>('public/anatomy/male/face.json') : (null as unknown as FaceData)
interface ManifestClip { file: string; lang: 'en' | 'zh'; text: string; durationS: number; phonemes: TtsPhone[]; words: TtsWord[] }
const manifest = json<{ licence: string; clips: ManifestClip[] }>('public/voice/tts-demo/manifest.json')
const maxDiff = (a: Record<string, number>, b: Record<string, number>): number => [...new Set([...Object.keys(a), ...Object.keys(b)])].reduce((w, k) => Math.max(w, Math.abs((a[k] ?? 0) - (b[k] ?? 0))), 0)
const seg = (viseme: string, start: number, end: number): VisemeSegment => ({ viseme, start, end })

describe.skipIf(!present)('grouped co-articulation', () => {
  const V = face?.visemes!

  it('is coarticulate itself for one group, and the per-frame maximum of the groups otherwise', () => {
    const a = [seg('PBM', 0.2, 0.3), seg('AA', 0.3, 0.5)], b = [seg('FV', 0.5, 0.6), seg('IY', 0.6, 0.8)]
    const range = { fps: 100, t0: 0, t1: 1 }
    expect(coarticulateGroups([a], V, range)).toEqual(coarticulate(a, V, range))
    expect(coarticulateGroups([], V, range)).toEqual(coarticulate([], V, range))
    // 没有跨组的规则起作用时，分组与不分组结果相同 / where no rule reaches across the groups, grouped and ungrouped agree
    const whole = coarticulate([...a, ...b], V, range), grouped = coarticulateGroups([a, b], V, range)
    expect(grouped.frames.length).toBe(whole.frames.length)
    grouped.frames.forEach((f, i) => {
      expect(maxDiff(f.lips, whole.frames[i]!.lips)).toBeLessThan(1e-12)
      expect(maxDiff(f.jaw, whole.frames[i]!.jaw)).toBeLessThan(1e-12)
      expect(f.closure).toBeCloseTo(whole.frames[i]!.closure, 12)
      expect(f.dental).toBeCloseTo(whole.frames[i]!.dental, 12)
    })
    // 缺省的时间范围和 coarticulate 的一样 / the default time range is that of coarticulate
    expect(coarticulateGroups([a, b], V).t0).toBeCloseTo(coarticulate([...a, ...b], V).t0, 12)
    expect(coarticulateGroups([a, b], V).frames.length).toBe(coarticulate([...a, ...b], V).frames.length)
  })

  it('keeps a lip-heavy viseme from taking over the lips of the next group', () => {
    // 老师 lao · shi：UW（ao 的收尾）不该盖过下一个音节的 sh / the UW ending ao must not take over the sh of the next syllable
    const lao = [seg('L', 0.2, 0.25), seg('AA', 0.25, 0.34), seg('UW', 0.34, 0.4)], shi = [seg('ZHCHSH', 0.4, 0.5), seg('ER', 0.5, 0.65)]
    const range = { fps: 100, t0: 0, t1: 1 }
    const whole = coarticulate([...lao, ...shi], V, range), grouped = coarticulateGroups([lao, shi], V, range)
    // 不分组：sh 的唇形被 UW 取代 / ungrouped: the lips of sh are replaced by UW
    expect(whole.frames[48]!.lips.ZHCHSH ?? 0).toBe(0)
    expect(whole.frames[48]!.lips.UW).toBeCloseTo(1, 9)
    // 分组：sh 有自己的唇形，UW 只是按自己的消退时间淡出 / grouped: sh has its own lips and UW merely decays over its own offset
    expect(grouped.frames[48]!.lips.ZHCHSH).toBeCloseTo(1, 9)
    expect(grouped.frames[48]!.lips.UW ?? 0).toBeLessThan(1)
    expect(grouped.frames[56]!.lips.UW ?? 0).toBe(0)
    // 下颌和舌不受分组影响 / jaw and tongue are unaffected by the grouping
    grouped.frames.forEach((f, i) => expect(maxDiff(f.jaw, whole.frames[i]!.jaw)).toBeLessThan(1e-12))
  })
})

describe.skipIf(!present)('the demo timelines', () => {
  const V = face?.visemes!
  const ids = V?.visemes.map((v) => v.id) ?? []
  const heavy = new Set(V?.visemes.filter((v) => (v.classes as string[]).includes('lipHeavy')).map((v) => v.id))
  const mean = (x: number[]): number => x.reduce((a, b) => a + b, 0) / Math.max(1, x.length)

  it('every clip gives a track of its own length in which bilabials close and labiodentals touch', () => {
    expect(manifest.clips.length).toBe(12)
    for (const c of manifest.clips) {
      const track = phonemeTrack(c.phonemes, c.lang, tables, V, c.durationS)
      expect(track.t0).toBe(0)
      expect(track.frames.length, c.file).toBe(Math.round(c.durationS * 100) + 1)
      // 每个音都映射得到 / every sound maps to something
      const spoken = c.phonemes.filter((p) => p.phone !== 'sil')
      for (const p of spoken) expect(phonemesToVisemeSegments([p], c.lang, tables, { available: ids }).length, `${c.file} ${p.phone}`).toBeGreaterThan(0)
      for (const p of spoken) {
        const mid = track.frames[trackIndex(track, (p.t0 + p.t1) / 2)]!
        const first = phonemesToVisemeSegments([p], c.lang, tables, { available: ids })[0]!.viseme
        if (first === 'PBM') expect(mid.closure, `${c.file} ${p.phone} @${p.t0}`).toBeGreaterThan(0.99)
        if (first === 'FV') expect(mid.dental, `${c.file} ${p.phone} @${p.t0}`).toBeGreaterThan(0.99)
      }
      // 开头和结尾的停顿里口形是静止的 / the mouth is at rest in the leading and trailing pause
      expect(trackPose(face, track, 0)).toMatchObject({ jaw: 0, closure: 0, dental: 0 })
    }
  })

  it('Mandarin: zh ch sh r are rounded only next to a rounded vowel of their own syllable', () => {
    const report: string[] = []
    let own = 0, other = 0
    for (const c of manifest.clips.filter((x) => x.lang === 'zh')) {
      const track = phonemeTrack(c.phonemes, 'zh', tables, V, c.durationS)
      const au18 = (p: TtsPhone): number[] => {
        const out: number[] = []
        for (let t = p.t0; t < p.t1 - 1e-9; t += 0.01) out.push(trackPose(face, track, trackIndex(track, t))!.aus.AU18 ?? 0)
        return out
      }
      c.phonemes.forEach((p, i) => {
        if (p.part !== 'initial' || !['zh', 'ch', 'sh', 'r'].includes(p.phone)) return
        const fin = c.phonemes[i + 1]!
        const rounded = phonemesToVisemeSegments([fin], 'zh', tables, { available: ids }).some((s) => heavy.has(s.viseme))
        const onInitial = au18(p), onFinal = au18(fin)
        report.push(`${c.file} ${p.phone}+${fin.phone} own-syllable rounding ${rounded}: AU18 on the initial mean ${mean(onInitial).toFixed(2)} end ${onInitial[onInitial.length - 1]!.toFixed(2)}, on the final mean ${mean(onFinal).toFixed(2)}`)
        if (rounded) {
          own++
          // 本音节的圆唇元音提前盖到声母上（唇化）/ the syllable's own rounded vowel arrives early on the initial (labialisation)
          expect(onInitial[onInitial.length - 1]!, `${c.file} ${p.phone}+${fin.phone}`).toBeGreaterThan(2.5)
        } else {
          other++
          // 只剩前一个音节的圆唇按 150 ms 自然消退的尾巴：不到圆唇元音（AU18 3.5）的四成，并且在往下走
          // only the tail of the previous syllable's rounding is left, decaying over its natural 150 ms: under four tenths of a rounded vowel (AU18 3.5) and falling
          expect(mean(onInitial), `${c.file} ${p.phone}+${fin.phone}`).toBeLessThan(1.4)
          expect(onInitial[onInitial.length - 1]!, `${c.file} ${p.phone}+${fin.phone}`).toBeLessThanOrEqual(onInitial[0]! + 0.1)
          // 舌尖元音 iii 自己不圆唇、也不再和声母并成一段 / the apical vowel iii is unrounded itself and no longer merges with its initial
          if (fin.phone === 'iii') expect(phonemesToVisemeGroups([p, fin], 'zh', tables, { available: ids })[0]!.map((s) => s.viseme)).toEqual(['ZHCHSH', 'ER'])
        }
      })
    }
    expect(own).toBeGreaterThanOrEqual(3)
    expect(other).toBeGreaterThanOrEqual(5)
    if (process.env.FACE_STATS) console.log(report.join('\n'))
  })

  it('吃水: ch + iii + sh no longer merge, and 吃 is not rounded by 水', () => {
    const c = manifest.clips.find((x) => x.file === 'zh-05.wav')!
    const i = c.phonemes.findIndex((p, k) => p.phone === 'ch' && c.phonemes[k + 1]?.phone === 'iii' && c.phonemes[k + 2]?.phone === 'sh')
    expect(i).toBeGreaterThan(0)
    const [ch, iii, sh, uei] = c.phonemes.slice(i, i + 4) as [TtsPhone, TtsPhone, TtsPhone, TtsPhone]
    expect(phonemesToVisemeGroups([ch, iii, sh, uei], 'zh', tables, { available: ids }).map((g) => g.map((s) => s.viseme))).toEqual([['ZHCHSH', 'ER'], ['ZHCHSH', 'W', 'EH', 'IY']])
    const track = phonemeTrack(c.phonemes, 'zh', tables, V, c.durationS)
    const at = (t: number): number => trackPose(face, track, trackIndex(track, t))!.aus.AU18 ?? 0
    // 吃 的声母中点不圆；水 的声母到末尾已经圆了 / unrounded at the middle of the initial of 吃; rounded by the end of the initial of 水
    expect(at((ch.t0 + ch.t1) / 2)).toBeLessThan(0.1)
    expect(at(sh.t1 - 0.01)).toBeGreaterThan(2.5)
    // 改表之前（声母、iii、下一个声母同一个视位，整句一组）这里是满的圆唇 / before the table change (initial, iii and the next initial sharing a viseme, one group for the utterance) this was fully rounded
    const merged = coarticulate([seg('ZHCHSH', ch.t0, sh.t1), seg('W', uei.t0, uei.t0 + 0.045), seg('EH', uei.t0 + 0.045, uei.t1)], V, { fps: 100, t0: 0, t1: c.durationS })
    expect(visemeAUs(face, merged.frames[trackIndex(merged, (ch.t0 + ch.t1) / 2 + 0.03)]!).aus.AU18 ?? 0).toBeGreaterThan(2.5)
  })

  it('lets the larger of closure and dental win where a bilabial touches a labiodental', () => {
    // 只有一个约束时不变 / a constraint on its own is unchanged
    expect(resolveConstraints(0.7, 0)).toEqual({ closure: 0.7, dental: 0 })
    expect(resolveConstraints(0, 0.4)).toEqual({ closure: 0, dental: 0.4 })
    expect(resolveConstraints(0, 0)).toEqual({ closure: 0, dental: 0 })
    // 各自的时段里（自己是 1，对方在升或降）是完整的约束；正好相等时各一半
    // complete during its own segment (itself at 1, the other rising or falling); half each at an exact tie
    expect(resolveConstraints(1, 0.9).closure).toBeGreaterThan(0.999)
    expect(resolveConstraints(1, 0.9).dental).toBeLessThan(0.001)
    expect(resolveConstraints(0.9, 1).dental).toBeGreaterThan(0.999)
    expect(resolveConstraints(1, 1)).toEqual({ closure: 0.5, dental: 0.5 })
    // five more：V 紧接 M。原始的轨迹在 M 的中点两个约束都接近 1 / "five more": V runs into M; in the raw track both constraints are near 1 at the middle of M
    const c = manifest.clips.find((x) => x.file === 'en-01.wav')!
    const i = c.phonemes.findIndex((p, k) => p.phone === 'M' && c.phonemes[k - 1]?.phone === 'V')
    const m = c.phonemes[i]!, v = c.phonemes[i - 1]!
    const track = phonemeTrack(c.phonemes, 'en', tables, V, c.durationS)
    const raw = track.frames[trackIndex(track, (m.t0 + m.t1) / 2)]!
    expect(raw.closure).toBeGreaterThan(0.99)
    expect(raw.dental).toBeGreaterThan(0.9)
    const onM = trackPose(face, track, trackIndex(track, (m.t0 + m.t1) / 2))!, onV = trackPose(face, track, trackIndex(track, (v.t0 + v.t1) / 2))!
    expect(onM.closure).toBeGreaterThan(0.98)
    expect(onM.dental).toBeLessThan(0.02)
    expect(onM.channels.lip_dental ?? 0).toBeLessThan(0.02)
    expect(onV.dental).toBeGreaterThan(0.98)
    expect(onV.closure).toBeLessThan(0.02)
  })

  it('takes the funnel (AU22) of a lip-heavy neighbour off a sealed bilabial and keeps the pucker', () => {
    // top shelf：P 后面是 SH（AU22 3），协同发音把它带到 P 上 / "top shelf": P is followed by SH (AU22 3), which co-articulation carries onto P
    const c = manifest.clips.find((x) => x.file === 'en-04.wav')!
    const i = c.phonemes.findIndex((p, k) => p.phone === 'P' && c.phonemes[k + 1]?.phone === 'SH')
    const p = c.phonemes[i]!, sh = c.phonemes[i + 1]!
    const track = phonemeTrack(c.phonemes, 'en', tables, V, c.durationS)
    const raw = visemeAUs(face, track.frames[trackIndex(track, (p.t0 + p.t1) / 2)]!)
    expect(raw.aus.AU22 ?? 0).toBeGreaterThan(1)
    const onP = trackPose(face, track, trackIndex(track, (p.t0 + p.t1) / 2))!
    expect(onP.closure).toBeGreaterThan(0.99)
    expect(onP.aus.AU22 ?? 0).toBeLessThan(0.05)
    // 闭唇按 120 ms 消退，漏斗形随之回来：到 SH 的末尾已经回来大半 / the closure decays over 120 ms and the funnel returns with it: most of it is back by the end of SH
    expect(trackPose(face, track, trackIndex(track, sh.t1 - 0.01))!.aus.AU22).toBeGreaterThan(1.5)
    // 不 bu：合着唇撮圆，AU18 留着 / 不 bu: rounded with the lips sealed, AU18 stays
    const zh = manifest.clips.find((x) => x.file === 'zh-01.wav')!
    const k = zh.phonemes.findIndex((x, j) => x.phone === 'b' && zh.phonemes[j + 1]?.phone === 'u')
    const b = zh.phonemes[k]!
    const zhTrack = phonemeTrack(zh.phonemes, 'zh', tables, V, zh.durationS)
    const onB = trackPose(face, zhTrack, trackIndex(zhTrack, b.t1 - 0.01))!
    expect(onB.closure).toBeGreaterThan(0.99)
    expect(onB.aus.AU18 ?? 0).toBeGreaterThan(1)
  })

  it('names the word and sound at a time', () => {
    const c = manifest.clips.find((x) => x.file === 'zh-03.wav')!
    const x = c.phonemes.find((p) => p.phone === 'x')!
    const now = spokenAt(c.phonemes, c.words, (x.t0 + x.t1) / 2)
    expect(now.phone).toBe(x)
    expect(now.word?.text).toBe('小朋友')
    expect(spokenAt(c.phonemes, c.words, 0.01)).toMatchObject({ phone: null, word: null, wordIndex: -1 })
    expect(spokenAt(c.phonemes, c.words, 99)).toMatchObject({ phone: null, word: null })
  })
})

describe.skipIf(!present)('mouth sources and styles in the driver', () => {
  it('ranks phoneme track > audio analysis > held viseme', () => {
    const phoneme = visemeAUs(face, { FV: 1 }), audio = visemeAUs(face, { AA: 1 })
    const settings = { expr: null, viseme: 'PBM' }
    const ref = (speech: typeof phoneme): Activations => composeFace(face, { pain: {}, emotion: {}, speech, speaking: 1 }).channels
    const all = new FaceDriver().step(face, 0.016, settings, {}, audio, { phoneme })
    expect(all.channels).toEqual(ref(phoneme))
    expect((all.channels.lip_dental ?? 0) + (all.channels.lip_dental_closed ?? 0)).toBeCloseTo(1, 9)
    expect(all.channels.lip_seal ?? 0).toBe(0)
    expect(all.animating).toBe(true)
    const noPhoneme = new FaceDriver().step(face, 0.016, settings, {}, audio, { phoneme: null })
    expect(noPhoneme.channels).toEqual(ref(audio))
    expect(noPhoneme.channels.lip_dental ?? 0).toBe(0)
    // 两个播放的来源都没有时才轮到保持的视位 / the held viseme has its turn only when neither played source is there
    const d = new FaceDriver()
    let held = d.step(face, 0.5, settings, {}, null)
    held = d.step(face, 0.5, settings, {}, null)
    expect(held.channels).toEqual(ref(visemeAUs(face, { PBM: 1 })))
    expect(held.channels.lip_seal ?? 0).toBeGreaterThan(0)
  })

  it('a phoneme pose still composes with emotion and pain by the blend rule, and fades out when the track ends', () => {
    const d = new FaceDriver()
    const emotion = expressionAUs(face.expressions, 'surprised', 1), pain = { AU4: 3 }
    const phoneme = visemeAUs(face, { PBM: 1 })
    const settings = { expr: { id: 'surprised', strength: 1 }, viseme: null }
    let out = d.step(face, 1, settings, pain, null, { phoneme })
    out = d.step(face, 1, settings, pain, null, { phoneme })
    const ref = blendFace(face, { speech: phoneme, speaking: 1, emotion, pain })
    expect(maxDiff(out.channels, ref.channels)).toBeLessThan(1e-12)
    expect(out.jaw).toBeCloseTo(ref.jaw, 12)
    // 上半脸不受说话影响 / the upper face is untouched by speech
    expect(out.aus.AU4).toBe(3)
    const offset = face.visemes!.timing.offset
    const fading = d.step(face, offset / 2, settings, pain, null, { phoneme: null })
    expect(fading.animating).toBe(true)
    expect(fading.channels.lip_seal ?? 0).toBeGreaterThan(0)
    const done = d.step(face, offset, settings, pain, null, {})
    expect(maxDiff(done.channels, blendFace(face, { emotion, pain }).channels)).toBeLessThan(1e-12)
  })

  it('held visemes default to the clear style and speech to the normal one', () => {
    expect(resolveStyle(null, 'viseme')).toBe(SPEECH_STYLES.clear)
    expect(resolveStyle(null, 'speech')).toBe(SPEECH_STYLES.normal)
    for (const use of ['viseme', 'speech'] as const) {
      expect(resolveStyle('normal', use)).toBe(SPEECH_STYLES.normal)
      expect(resolveStyle('clear', use)).toBe(SPEECH_STYLES.clear)
    }
    const d = new FaceDriver()
    const hold = (visemeStyle?: { jaw: number; lip: number }): number => {
      d.reset()
      d.step(face, 1, { expr: null, viseme: 'AA', visemeStyle }, {}, null)
      return d.step(face, 1, { expr: null, viseme: 'AA', visemeStyle }, {}, null).jaw
    }
    expect(hold()).toBeCloseTo(0.118 * face.jaw.max, 9)
    expect(hold(SPEECH_STYLES.clear)).toBeCloseTo(0.5 * face.jaw.max, 9)
    // 夸张风格下各口形的下颌分得开；正常风格下开口元音之外都挤在一两毫米里 / the clear style separates the jaws of the shapes; in the normal style everything but the open vowels sits within a millimetre or two
    const jaws = (style: { jaw: number; lip: number }): number[] => ['IY', 'EH', 'AA', 'OW'].map((id) => visemeAUs(face, { [id]: 1 }, style).jaw / face.jaw.max)
    expect(Math.max(...jaws(SPEECH_STYLES.clear)) - Math.min(...jaws(SPEECH_STYLES.clear))).toBeGreaterThan(0.3)
    expect(Math.max(...jaws(SPEECH_STYLES.normal)) - Math.min(...jaws(SPEECH_STYLES.normal))).toBeLessThan(0.1)
  })

  it('passes the jaw opened from elsewhere on to the blend rule', () => {
    const speech = visemeAUs(face, { PBM: 1 })
    const base = 0.2 * face.jaw.max
    const out = new FaceDriver().step(face, 0.016, { expr: null, viseme: null }, {}, null, { phoneme: speech, baseJaw: base })
    const ref = blendFace(face, { speech, speaking: 1, baseJaw: base })
    expect(out.channels).toEqual(ref.channels)
    expect(out.jaw).toBeCloseTo(ref.jaw, 12)
    const refJaw = face.channels.find((c) => c.id === 'lip_seal')!.refJaw!
    expect(out.channels.lip_seal).toBeCloseTo(Math.min(1, (base + out.jaw) / refJaw), 9)
    expect(out.channels.mouth_corner).toBeCloseTo((base + out.jaw) / face.jaw.max, 9)
    // 不告诉它，闭唇的激活就只按说话自己的下颌角算 / untold, the seal is computed for the jaw angle of speech alone
    const blind = new FaceDriver().step(face, 0.016, { expr: null, viseme: null }, {}, null, { phoneme: speech })
    expect(blind.channels.lip_seal!).toBeLessThan(out.channels.lip_seal! - 0.2)
    // 只有表情、没有说话时也按总角 / with an expression only and no speech the total is used too
    const expr = composeFace(face, { pain: {}, emotion: { AU26: 3 }, speech: null, speaking: 0, baseJaw: base })
    expect(expr.channels.mouth_corner).toBeCloseTo((base + expr.jaw) / face.jaw.max, 9)
  })
})

// 姿势面板把下颌张到 0.2 × 最大角时说双唇音：按 CPU 参考实现（位移 + 蒙皮）量唇间隙
// A bilabial spoken with the pose panel's jaw at 0.2 × its maximum: the lip gap measured with the CPU reference (displacement + skinning)
for (const bodyId of ['male', 'female']) {
  const DIR = join(ROOT, 'public', 'anatomy', bodyId)
  const has = existsSync(join(DIR, 'face.json')) && existsSync(join(DIR, 'face', 'openings.json')) && existsSync(join(DIR, 'rig.json'))
  const fresh = has && stale(DIR).length === 0
  describe.skipIf(!fresh)(`a bilabial with the jaw opened from the pose panel (${bodyId})`, () => {
    const f = (has ? JSON.parse(readFileSync(join(DIR, 'face.json'), 'utf8')) : {}) as FaceData
    const bin = has ? new Uint8Array(readFileSync(join(DIR, 'face.bin'))) : new Uint8Array(0)
    const O = (has ? JSON.parse(readFileSync(join(DIR, 'face', 'openings.json'), 'utf8')) : {}) as FaceOpenings
    const rig = (has ? JSON.parse(readFileSync(join(DIR, 'rig.json'), 'utf8')) : {}) as Rig
    const rigBin = has ? new Uint8Array(readFileSync(join(DIR, 'rig.bin'))) : new Uint8Array(0)
    let body: Body
    let rest: Float32Array
    beforeAll(async () => {
      body = await readBody(DIR)
      rest = body.meshes.get(f.skin)!.positions
    }, 120_000)
    const posed = (channels: Activations, jaw: number): Float32Array => {
      const pose = jaw > 0 ? { [f.jaw.joint]: Array.from({ length: f.jaw.dof + 1 }, (_, k) => (k === f.jaw.dof ? jaw : 0)) } : {}
      return new Poser(rig, rigBin, pose).part(f.skin, deform(f.channels, bin, f.skin, rest, channels), 'dqs', false)
    }
    const gaps = (pos: Float32Array): number[] => O.margins.upperLip.map((u, i) => pos[u * 3 + 1]! - pos[O.margins.lowerLip[i]! * 3 + 1]!)

    it('the lips meet (gap ≤ 0.3 mm) at PBM with the pose jaw at 0.2 × max, in both styles and inside a phoneme track', () => {
      const base = 0.2 * f.jaw.max
      const report: string[] = []
      const middle = (g: number[]): number => Math.max(...g.slice(Math.round(g.length * 0.2), Math.round(g.length * 0.8)).map(Math.abs)) / MM
      for (const [name, style] of Object.entries(SPEECH_STYLES)) {
        const d = new FaceDriver()
        const out = d.step(f, 0.016, { expr: null, viseme: null }, {}, null, { phoneme: visemeAUs(f, { PBM: 1 }, style), baseJaw: base })
        const g = middle(gaps(posed(out.channels, base + out.jaw)))
        report.push(`${bodyId} ${name}: jaw ${(base + out.jaw).toFixed(4)} rad, lip_seal ${out.channels.lip_seal!.toFixed(3)}, largest gap over the middle 60% ${g.toFixed(3)} mm`)
        expect(g, name).toBeLessThanOrEqual(0.3)
        // 不传 baseJaw（改动之前）唇合不上 / without baseJaw (as before this change) the lips do not meet
        const blind = new FaceDriver().step(f, 0.016, { expr: null, viseme: null }, {}, null, { phoneme: visemeAUs(f, { PBM: 1 }, style) })
        const open = gaps(posed(blind.channels, base + blind.jaw))
        expect(open[open.length >> 1]! / MM, name).toBeGreaterThan(2)
      }
      if (process.env.FACE_STATS) console.log(report.join('\n'))
    })

    it('every bilabial of the twelve demo timelines seals at its middle, with the jaw closed and opened from the pose panel', () => {
      const worst = { 0: 0, 0.2: 0 } as Record<number, number>
      let n = 0
      for (const c of manifest.clips) {
        const track = phonemeTrack(c.phonemes, c.lang, tables, f.visemes!, c.durationS)
        for (const p of c.phonemes.filter((x) => ['P', 'B', 'M', 'p', 'b', 'm'].includes(x.phone) && x.part !== 'final')) {
          const pose = trackPose(f, track, trackIndex(track, (p.t0 + p.t1) / 2))!
          expect(pose.closure, `${c.file} ${p.phone} @${p.t0}`).toBeGreaterThan(0.98)
          for (const fraction of [0, 0.2]) {
            const base = fraction * f.jaw.max
            const out = composeFace(f, { pain: {}, emotion: {}, speech: pose, speaking: 1, baseJaw: base })
            const all = gaps(posed(out.channels, base + out.jaw))
            const g = Math.max(...all.slice(Math.round(all.length * 0.2), Math.round(all.length * 0.8)).map(Math.abs)) / MM
            worst[fraction] = Math.max(worst[fraction]!, g)
            expect(g, `${c.file} ${p.phone} @${p.t0} base ${fraction}`).toBeLessThanOrEqual(0.3)
          }
          n++
        }
      }
      expect(n).toBeGreaterThanOrEqual(40)
      if (process.env.FACE_STATS) console.log(`${bodyId}: ${n} bilabials; largest gap over the middle 60% at the segment middle: ${worst[0]!.toFixed(3)} mm (jaw closed), ${worst[0.2]!.toFixed(3)} mm (pose jaw 0.2 × max)`)
    }, 300_000)
  })
}

describe('deep-link parameters say and style', () => {
  it('round-trips', () => {
    for (const q of ['say=zh-03', 'say=en-01&style=clear', 'style=normal', 'tab=e&expr=happy&vis=YU&say=zh-04&style=clear&skin=1', 'vis=ZHCHSH', 'vis=JQX&style=normal']) {
      const p = parseUrl(q)
      expect(p.warnings, q).toEqual([])
      expect(formatUrl(p.state), q).toBe(q)
    }
    expect(parseUrl('say=zh-03').state.say).toBe('zh-03')
    expect(parseUrl('style=clear').state.style).toBe('clear')
  })

  it('refuses free text and unknown styles, with a warning naming the parameter', () => {
    for (const q of ['say=', 'say=hello%20world', 'say=%E4%BD%A0%E5%A5%BD', 'say=a.b', `say=${'x'.repeat(65)}`]) {
      const p = parseUrl(q)
      expect(p.state.say, q).toBeUndefined()
      expect(p.warnings.join(), q).toMatch(/say/)
    }
    for (const q of ['style=', 'style=loud', 'style=1.5']) {
      const p = parseUrl(q)
      expect(p.state.style, q).toBeUndefined()
      expect(p.warnings.join(), q).toMatch(/style/)
    }
  })
})

describe('demo packs', () => {
  it('reads the shipped manifest into 12 clips with ids from the file names', () => {
    expect(DEMO_PACKS).toContain('voice/tts-demo/manifest.json')
    const pack = packFromManifest('voice/tts-demo/manifest.json', manifest, '/')
    expect(pack.clips.map((c) => c.id)).toEqual(['en-01', 'en-02', 'en-03', 'en-04', 'en-05', 'en-06', 'zh-01', 'zh-02', 'zh-03', 'zh-04', 'zh-05', 'zh-06'])
    expect(pack.clips[8]).toMatchObject({ url: '/voice/tts-demo/zh-03.wav', lang: 'zh', text: '小朋友们在学校里学习写字、唱歌。', model: { name: 'Kokoro-82M-v1.1-zh', licence: 'Apache-2.0' } })
    expect(pack.licence).toMatch(/machine-generated/)
    for (const c of pack.clips) expect(existsSync(resolve(ROOT, 'public', c.url.slice(1))), c.url).toBe(true)
  })

  it('takes a second pack of the same shape (recorded voices have no model) and skips broken entries', () => {
    const other = { licence: 'CC BY 4.0', clips: [{ file: 'spk1-0001.flac', lang: 'en', voice: 'spk1', text: 'Hello.', durationS: 1, phonemes: [{ t0: 0, t1: 1, phone: 'AA', symbol: 'a', word: 0 }], words: [{ t0: 0, t1: 1, text: 'Hello' }] }, { file: 'no-timeline.wav', lang: 'en', durationS: 1 }, { file: 'x.wav', lang: 'fr', durationS: 1, phonemes: [] }, null] }
    const pack = packFromManifest('voice/real/manifest.json', other)
    expect(pack.clips.length).toBe(1)
    expect(pack.clips[0]).toMatchObject({ id: 'spk1-0001', url: 'voice/real/spk1-0001.flac', model: null, pack: 'voice/real/manifest.json' })
    expect(packFromManifest('a/b.json', null).clips).toEqual([])
    expect(packFromManifest('a/b.json', { clips: 'nope' }).clips).toEqual([])
  })

  it('every speech card of sim.json points at a shipped clip and carries no text', () => {
    const sim = json<{ cards: { id: string; url: string }[] }>('sim.json')
    const ids = new Set(packFromManifest('voice/tts-demo/manifest.json', manifest).clips.map((c) => c.id))
    const cards = sim.cards.filter((c) => /[?&]say=/.test(c.url))
    expect(cards.length).toBeGreaterThanOrEqual(3)
    for (const c of cards) {
      const p = parseUrl(c.url.slice(c.url.indexOf('?')))
      expect(p.warnings, c.id).toEqual([])
      expect(ids.has(p.state.say!), c.id).toBe(true)
      expect(formatUrl(p.state), c.id).toBe(c.url.slice(c.url.indexOf('?') + 1))
    }
    expect(cards.some((c) => parseUrl(c.url.slice(2)).state.say!.startsWith('en-'))).toBe(true)
    expect(cards.some((c) => parseUrl(c.url.slice(2)).state.say!.startsWith('zh-'))).toBe(true)
    expect(cards.some((c) => parseUrl(c.url.slice(2)).state.style === 'clear')).toBe(true)
  })
})

const part = (id: string): Part => ({ id, fma: `F${id}`, name: id, system: 'integumentary', tissue: 'skin', depth: 0, side: 'M', provenance: 'scanned', bbox: [0, 0, 0, 1, 1, 1], centroid: [0, 0, 0], triangles: 1, adjacent: [] })
const S = () => useApp.getState()

describe.skipIf(!present)('the say module on the page clock', () => {
  const clip = manifest.clips.find((c) => c.file === 'zh-04.wav')!
  beforeEach(() => {
    resetUrlSync()
    resetPainController()
    resetFaceDriver()
    resetSay()
    const lite: FaceData = { ...face, parts: [{ part: face.skin, vertexCount: 1, entries: 0 }], channels: face.channels.map((c) => ({ ...c, fields: [] })) }
    setFaceLoader(async () => indexFace(lite, new Uint8Array(0)))
    setRigLoader(async () => ({ ok: false, reason: 'missing', message: '' }))
    const body: AnatomyData = {
      schema: 1, body: 'male', sources: [],
      systems: [{ id: 'integumentary', name: { en: 'I', zh: 'I' }, color: '#fa8', glb: 'i.glb', partCount: 1 }],
      layers: [{ name: { en: 'a', zh: 'a' } }], parts: [part(face.skin)],
      trees: { isa: [{ id: 'R', name: 'R', parent: null, parts: [face.skin] }], partOf: [] },
    }
    useApp.setState({ graph: null, embed: false, pain: { level: 5, onset: 'sudden', hold: false, muted: false, always: false }, aus: {}, expr: null, viseme: null, speechStyle: null, skinOpaque: false, leftTab: 'display' })
    useApp.setState((s) => ({ say: { ...s.say, status: 'idle', clip: null, source: null, mode: 'phonemes', text: '' } }))
    S().init(new AnatomyGraph(body), 'male')
  })

  it('the frame the viewer asks for is the track frame at the playhead, blended with the expression', async () => {
    await S().ensureFace()
    const data = S().face!.data
    loadTimeline({ id: 'zh-04', ...clip }, tables)
    S().setExpr({ id: 'happy', strength: 1 })
    // ü 的中点（雨 yu3）/ the middle of a ü (雨 yu3)
    const yu = clip.phonemes.find((p) => p.phone === 'v')!
    const t = (yu.t0 + yu.t1) / 2
    seekSay(t)
    expect(S().say).toMatchObject({ status: 'playing', sound: false })
    let f = faceFrame(1000)
    for (let now = 1016; now < 3000; now += 16) f = faceFrame(now)
    const sample = lastSaySample()!
    expect(sample.kind).toBe('phonemes')
    expect(sample.t).toBeCloseTo(t, 2)
    const track = phonemeTrack(clip.phonemes, 'zh', tables, data.visemes!, clip.durationS)
    expect(sample.index).toBe(trackIndex(track, sample.t))
    expect(track.frames[sample.index]!.lips.YU).toBeGreaterThan(0.9)
    const pose = trackPose(data, track, sample.index, SPEECH_STYLES.normal)!
    const ref = blendFace(data, { speech: pose, speaking: 1, emotion: expressionAUs(data.expressions, 'happy', 1) })
    expect(maxDiff(f.channels, ref.channels)).toBeLessThan(1e-9)
    expect(f.jaw).toBeCloseTo(ref.jaw, 9)
    expect(f.animating).toBe(true)
    expect(sayNow()?.phone?.phone).toBe('v')
    // 风格开关换成夸张：同一帧，口形更大 / the style switch on clear: the same frame, a larger shape
    S().setSpeechStyle('clear')
    const clear = faceFrame(3016)
    expect(maxDiff(clear.channels, blendFace(data, { speech: trackPose(data, track, sample.index, SPEECH_STYLES.clear)!, speaking: 1, emotion: expressionAUs(data.expressions, 'happy', 1) }).channels)).toBeLessThan(1e-9)
    // 说话时保持的视位不起作用；停了之后才轮到它 / a held viseme does nothing while speaking and has its turn once that stops
    S().setSpeechStyle(null)
    S().setViseme('PBM')
    expect(faceFrame(3032).channels.lip_seal ?? 0).toBeLessThan(0.05)
    stopSay()
    expect(S().say.status).toBe('ready')
    let held = faceFrame(3048)
    for (let now = 3064; now < 5000; now += 16) held = faceFrame(now)
    expect(held.channels.lip_seal ?? 0).toBeGreaterThan(0.05)
  })

  it('past the end the playback is over and the mouth returns to rest', async () => {
    await S().ensureFace()
    loadTimeline({ id: 'zh-04', ...clip }, tables)
    seekSay(clip.durationS + 0.5)
    let f = faceFrame(1000)
    for (let now = 1016; now < 2000; now += 16) f = faceFrame(now)
    expect(S().say.status).toBe('ready')
    expect(f).toMatchObject({ channels: {}, jaw: 0, animating: false })
  })

  it('only a demo clip is written to the URL, never synthesized text', () => {
    useApp.setState((s) => ({ say: { ...s.say, status: 'ready', source: 'demo', clip: 'zh-03', text: '小朋友们' }, speechStyle: 'clear' }))
    expect(formatUrl(snapshot(S()))).toBe('say=zh-03&style=clear')
    useApp.setState((s) => ({ say: { ...s.say, source: 'tts', clip: null, text: 'a private sentence' }, speechStyle: null }))
    const q = formatUrl(snapshot(S()))
    expect(q).toBe('')
    expect(q).not.toMatch(/private|say/)
  })

  it('restores style and the new viseme ids from a link', async () => {
    const warnings = await restoreFromUrl(parseUrl('vis=yu&style=normal').state)
    expect(warnings).toEqual([])
    expect([S().viseme, S().speechStyle]).toEqual(['YU', 'normal'])
    expect(formatUrl(snapshot(S()))).toBe('vis=YU&style=normal')
  })
})
