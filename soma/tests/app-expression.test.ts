// 表情面板背后的纯逻辑：深链接参数 expr / vis、面部驱动与参考实现（tools/face/model.ts 的 blendFace）的接线、
// 时间上的过渡、store 流程、display.json 的隐藏清单，以及标定对照表的摘要。
// The pure logic behind the Expression panel: the deep-link parameters expr / vis, the wiring of the face driver to the
// reference (blendFace of tools/face/model.ts), the easing in time, the store flows, the hide list of display.json, and the
// summaries of the calibration tables.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { SPEECH_STYLES, activations, blendFace, expressionAUs, mouthFrameToChannels, painAUs, visemeAUs, type MouthPose } from '../tools/face/model.ts'
import { AnatomyGraph } from '../src/anatomy/graph.ts'
import type { AnatomyData, Part } from '../src/anatomy/types.ts'
import { countRows, disagreement, hasBodies, largestDisagreements, rowLabel, rowValues, rowsFor, type CalibrationTable } from '../src/calibration/summary.ts'
import { EMOTION_SECONDS, FaceDriver, composeFace, faceFrame, resetFaceDriver, slew } from '../src/face/driver.ts'
import type { FaceData } from '../src/face/types.ts'
import { resetPainController } from '../src/pain/controller.ts'
import { indexFace } from '../src/pain/face.ts'
import { hideListFrom, setFaceLoader, setRigLoader, useApp } from '../src/state/store.ts'
import { resetUrlSync, restoreFromUrl, snapshot } from '../src/state/urlSync.ts'
import { formatUrl, parseUrl } from '../src/state/urlState.ts'
import { groupExpressions } from '../src/ui/ExpressionPanel.tsx'

const ROOT = resolve(__dirname, '..')
const facePath = (body: string): string => resolve(ROOT, `public/anatomy/${body}/face.json`)
const loadFace = (body: string): FaceData => JSON.parse(readFileSync(facePath(body), 'utf8')) as FaceData
const maxDiff = (a: Record<string, number>, b: Record<string, number>): number => [...new Set([...Object.keys(a), ...Object.keys(b)])].reduce((w, k) => Math.max(w, Math.abs((a[k] ?? 0) - (b[k] ?? 0))), 0)

describe('deep-link parameters expr and vis', () => {
  it('round-trips and keeps au= as it was', () => {
    for (const q of ['expr=happy', 'expr=fearful:0.6', 'vis=PBM', 'tab=e&expr=sadly_angry:0.35&vis=AA', 'pain=7&au=4:3,43:5&expr=happy&vis=UW&skin=1', 'au=12:2.5']) {
      const p = parseUrl(q)
      expect(p.warnings).toEqual([])
      expect(formatUrl(p.state)).toBe(q)
    }
    expect(parseUrl('expr=happy').state.expr).toEqual({ id: 'happy', strength: 1 })
    expect(parseUrl('expr=happy:1').state.expr).toEqual({ id: 'happy', strength: 1 })
    expect(formatUrl(parseUrl('expr=happy:1').state)).toBe('expr=happy')
    expect(parseUrl('expr=fearful:0.6').state.expr).toEqual({ id: 'fearful', strength: 0.6 })
    expect(parseUrl('tab=e').state.tab).toBe('expr')
    expect(parseUrl('au=4:3&expr=angry').state.au).toEqual({ AU4: 3 })
  })

  it('ignores what it cannot parse, with a warning naming the parameter', () => {
    for (const q of ['expr=happy:2', 'expr=:0.5', 'expr=happy:x', 'expr=1happy', 'expr=']) {
      const p = parseUrl(q)
      expect(p.state.expr).toBeUndefined()
      expect(p.warnings.join()).toMatch(/expr/)
    }
    for (const q of ['vis=', 'vis=P B', 'vis=1']) {
      const p = parseUrl(q)
      expect(p.state.vis).toBeUndefined()
      expect(p.warnings.join()).toMatch(/vis/)
    }
    // 强度 0 就是没有表情，不算错 / a strength of 0 is no expression, not an error
    expect(parseUrl('expr=happy:0')).toMatchObject({ state: {}, warnings: [] })
  })
})

describe('slew', () => {
  it('moves by at most the step, lands exactly and drops zeros', () => {
    const now: Record<string, number> = { a: 1 }
    expect(slew(now, { b: 1 }, 0.4)).toBe(false)
    expect(now.a).toBeCloseTo(0.6)
    expect(now.b).toBeCloseTo(0.4)
    slew(now, { b: 1 }, 0.4)
    expect(slew(now, { b: 1 }, 0.4)).toBe(true)
    expect(now).toEqual({ b: 1 })
  })
})

describe.each(['male', 'female'])('face driver on the real data: %s', (body) => {
  const present = existsSync(facePath(body))
  const face = present ? loadFace(body) : (null as unknown as FaceData)
  const none: MouthPose | null = null

  it.skipIf(!present)('has the 21 expressions (6 basic, 15 compound) and 22 visemes the panel lists', () => {
    const g = groupExpressions(face.expressions ?? [])
    expect(g.basic.map((e) => e.id).sort()).toEqual(['angry', 'disgusted', 'fearful', 'happy', 'sad', 'surprised'])
    expect(g.compound.length).toBe(15)
    expect(face.visemes?.visemes.length).toBe(22)
    // 英语 17 个，加普通话专用的 5 个 / 17 for English plus the 5 Mandarin-only ones
    for (const id of ['YU', 'ZHCHSH', 'JQX', 'ER', 'HX']) expect(face.visemes?.visemes.some((v) => v.id === id), id).toBe(true)
    expect(face.channels.some((c) => c.id === 'tongue_retroflex')).toBe(true)
    expect(face.aus.length).toBe(25)
  })

  it.skipIf(!present)('pain alone is exactly what the pain path gave before: activations of the pain AUs', () => {
    for (const level of [0, 3, 7, 10]) {
      const pain = painAUs(face.pain, level)
      const out = composeFace(face, { pain, emotion: {}, speech: none, speaking: 0 })
      const ref = activations(face, pain)
      expect(out.channels).toEqual(ref.channels)
      expect(out.jaw).toBe(ref.jaw)
      expect(maxDiff(out.aus, pain)).toBeLessThan(1e-9)
    }
  })

  it.skipIf(!present)('emotion and pain merge by maximum on AUs, as blendFace does', () => {
    const emotion = expressionAUs(face.expressions, 'happy', 0.8), pain = painAUs(face.pain, 6)
    const out = composeFace(face, { pain, emotion, speech: none, speaking: 0 })
    expect(out.channels).toEqual(blendFace(face, { emotion, pain }).channels)
    for (const id of new Set([...Object.keys(emotion), ...Object.keys(pain)])) expect(out.aus[id] ?? 0).toBeCloseTo(Math.max(emotion[id] ?? 0, pain[id] ?? 0), 9)
  })

  it.skipIf(!present)('a bilabial closes the lips under an open-mouthed expression and leaves the upper face alone', () => {
    const emotion = expressionAUs(face.expressions, 'surprised', 1)
    const speech = visemeAUs(face, { PBM: 1 })
    const out = composeFace(face, { pain: {}, emotion, speech, speaking: 1 })
    const ref = blendFace(face, { emotion, speech, speaking: 1 })
    expect(out.channels).toEqual(ref.channels)
    expect(out.jaw).toBe(ref.jaw)
    expect(out.channels.lip_seal ?? 0).toBeGreaterThan(0)
    const alone = composeFace(face, { pain: {}, emotion, speech: none, speaking: 0 })
    // 上半脸的通道（额肌、提上睑肌）不因说话而变 / upper-face channels (frontalis, levator palpebrae) do not change with speech
    for (const id of Object.keys(alone.channels).filter((c) => /^(frontalis|levator_palpebrae|corrugator|procerus)/.test(c))) expect(out.channels[id]).toBe(alone.channels[id])
    // 说话时表情的下颌不超过它单独时的 / while speaking the jaw is no wider than under the expression alone
    expect(out.jaw).toBeLessThanOrEqual(alone.jaw)
    // speaking 为 0 时口形不起作用 / with speaking at 0 the mouth shape has no effect
    expect(composeFace(face, { pain: {}, emotion, speech, speaking: 0 }).channels).toEqual(alone.channels)
  })

  it.skipIf(!present)('an open vowel opens the jaw and a bilabial nearly shuts it; tongue and lip channels are driven', () => {
    const aa = composeFace(face, { pain: {}, emotion: {}, speech: visemeAUs(face, { AA: 1 }), speaking: 1 })
    const pbm = composeFace(face, { pain: {}, emotion: {}, speech: visemeAUs(face, { PBM: 1 }), speaking: 1 })
    // 缺省风格是按实测标定的朗读开度：AA 的切牙开度约 5 mm（校准前是 0.253 × jaw.max）。毫米数由 face-mouth 测试按每副身体检查；
    // 这里的比例按身体自己的切牙下降量换算（visemeJawForBody）：男性 0.118 × jaw.max ≈ 0.0597 rad；
    // 女性的下颌体较短（2026-10-14 新头），同样 5 mm 需要 0.1298 × jaw.max ≈ 0.0657 rad。
    // the default style is the calibrated opening of read speech: about 5 mm at the incisors for AA (0.253 × jaw.max before calibration).
    // The millimetres are checked per body by the face-mouth test; the fraction here is converted with the body's own incisor drop
    // (visemeJawForBody): male 0.118 × jaw.max ≈ 0.0597 rad; the female's mandibular body is shorter (new head, 2026-10-14),
    // so the same 5 mm needs 0.1298 × jaw.max ≈ 0.0657 rad.
    const aaJaw = face.visemes!.visemes.find((v) => v.id === 'AA')!.jaw
    if (body === 'male') expect(aaJaw).toBe(0.118)
    expect(aaJaw).toBeGreaterThan(0.118 * 0.9)
    expect(aaJaw).toBeLessThan(0.118 * 1.15)
    expect(aa.jaw).toBeCloseTo(aaJaw * face.jaw.max, 9)
    expect(aa.jaw).toBeGreaterThan(0.055)
    expect(aa.jaw).toBeLessThan(body === 'male' ? 0.065 : 0.07)
    // 夸张风格还是原来的大口形；1 和 2 之间线性过渡 / the clear style keeps the old wide shape; styles between 1 and 2 interpolate linearly
    const clear = composeFace(face, { pain: {}, emotion: {}, speech: visemeAUs(face, { AA: 1 }, SPEECH_STYLES.clear), speaking: 1 })
    expect(clear.jaw).toBeGreaterThan(0.2)
    expect(clear.jaw).toBeCloseTo(0.5 * face.jaw.max, 9)
    expect(visemeAUs(face, { AA: 1 }, { jaw: 1.5, lip: 1.5 }).jaw).toBeCloseTo((aa.jaw + clear.jaw) / 2, 9)
    expect(pbm.jaw).toBeLessThan(0.05)
    expect(pbm.channels.lip_seal ?? 0).toBeGreaterThan(0)
    expect(aa.channels.lip_seal ?? 0).toBe(0)
    expect(aa.channels.mouth_corner).toBeCloseTo(aa.jaw / face.jaw.max, 9)
    const kinds = new Map(face.channels.map((c) => [c.id, c.kind]))
    const l = composeFace(face, { pain: {}, emotion: {}, speech: visemeAUs(face, { L: 1 }), speaking: 1 })
    expect(Object.keys(l.channels).some((id) => kinds.get(id) === 'tongue')).toBe(true)
    const fv = composeFace(face, { pain: {}, emotion: {}, speech: visemeAUs(face, { FV: 1 }), speaking: 1 })
    // 唇齿的两个参考通道按下颌角混合，合起来正好是 1（标定后的 FV 下颌角小于 lip_dental 的 refJaw）
    // the two reference channels of the labiodental are mixed by the jaw angle and add up to exactly 1 (the calibrated jaw of FV is below lip_dental's refJaw)
    const k = Math.min(1, fv.jaw / face.channels.find((c) => c.id === 'lip_dental')!.refJaw!)
    expect(fv.channels.lip_dental).toBeCloseTo(k, 9)
    expect((fv.channels.lip_dental ?? 0) + (fv.channels.lip_dental_closed ?? 0)).toBeCloseTo(1, 9)
    // 舌的位移场在舌这个部件上，不在皮肤上 / the tongue's field is on the tongue part, not on the skin
    for (const c of face.channels.filter((x) => x.kind === 'tongue')) expect(c.fields.every((f) => f.part !== face.skin)).toBe(true)
  })

  it.skipIf(!present)('eases an emotion in over EMOTION_SECONDS and out again', () => {
    const d = new FaceDriver()
    const settings = { expr: { id: 'angry', strength: 1 }, viseme: null }
    const target = composeFace(face, { pain: {}, emotion: expressionAUs(face.expressions, 'angry', 1), speech: none, speaking: 0 })
    const first = d.step(face, EMOTION_SECONDS / 4, settings, {}, null)
    expect(first.animating).toBe(true)
    expect(first.aus.AU4).toBeCloseTo(1.25, 6)
    let out = first
    for (let i = 0; i < 4; i++) out = d.step(face, EMOTION_SECONDS / 4, settings, {}, null)
    expect(out.animating).toBe(false)
    expect(out.channels).toEqual(target.channels)
    for (let i = 0; i < 5; i++) out = d.step(face, EMOTION_SECONDS / 4, { expr: null, viseme: null }, {}, null)
    expect(out).toMatchObject({ aus: {}, channels: {}, jaw: 0, animating: false })
  })

  it.skipIf(!present)('holds a viseme, cross-fades to another and fades out on release', () => {
    const d = new FaceDriver()
    const onset = face.visemes!.timing.onset
    const hold = (id: string | null, n: number): ReturnType<FaceDriver['step']> => {
      let o = d.step(face, onset / 4, { expr: null, viseme: id }, {}, null)
      for (let i = 1; i < n; i++) o = d.step(face, onset / 4, { expr: null, viseme: id }, {}, null)
      return o
    }
    const pbm = hold('PBM', 5)
    expect(pbm.animating).toBe(false)
    expect(pbm.channels).toEqual(composeFace(face, { pain: {}, emotion: {}, speech: visemeAUs(face, { PBM: 1 }), speaking: 1 }).channels)
    // 换成开口音：过渡中下颌单调张开 / to the open vowel: the jaw opens monotonically on the way
    let last = pbm.jaw
    for (let i = 0; i < 5; i++) {
      const o = hold('AA', 1)
      expect(o.jaw).toBeGreaterThanOrEqual(last - 1e-12)
      last = o.jaw
    }
    expect(last).toBeCloseTo(visemeAUs(face, { AA: 1 }).jaw, 9)
    const gone = hold(null, 6)
    expect(gone).toMatchObject({ channels: {}, jaw: 0, animating: false })
    // 不认识的视位不起作用 / an unknown viseme does nothing
    expect(hold('nope', 3)).toMatchObject({ channels: {}, jaw: 0 })
  })

  it.skipIf(!present)('a mouth shape from audio takes precedence over a held viseme and equals the reference', () => {
    const d = new FaceDriver()
    const frame = { t: 0.5, open: 0.9, round: 0.2, closure: 0, dental: 0, tongue: { low: 0.9, front: 0, back: 0.1, tip: 0 }, voiced: true, level: 0.2, confidence: { open: 0.7, round: 0.35, closure: 0.5, dental: 0.1, tongue: 0.5 } }
    const audio = mouthFrameToChannels(face, frame)
    const out = d.step(face, 0.016, { expr: null, viseme: 'PBM' }, {}, audio.pose)
    expect(out.animating).toBe(true)
    expect(out.channels).toEqual(blendFace(face, { speech: audio.pose, speaking: 1 }).channels)
    expect(out.jaw).toBeCloseTo(audio.jaw, 12)
    expect(out.channels.lip_seal ?? 0).toBe(0)
  })
})

const part = (id: string): Part => ({ id, fma: `F${id}`, name: id, system: 'integumentary', tissue: 'skin', depth: 0, side: 'M', provenance: 'scanned', bbox: [0, 0, 0, 1, 1, 1], centroid: [0, 0, 0], triangles: 1, adjacent: [] })
const S = () => useApp.getState()

describe.skipIf(!existsSync(facePath('male')))('store flows and URL restore', () => {
  const data = existsSync(facePath('male')) ? loadFace('male') : (null as unknown as FaceData)
  beforeEach(() => {
    resetUrlSync()
    resetPainController()
    resetFaceDriver()
    // 只要 AU、表情和视位表，不要位移场 / only the AUs, expressions and visemes are needed, not the displacement fields
    const lite: FaceData = { ...data, parts: [{ part: data.skin, vertexCount: 1, entries: 0 }], channels: data.channels.map((c) => ({ ...c, fields: [] })) }
    setFaceLoader(async () => indexFace(lite, new Uint8Array(0)))
    setRigLoader(async () => ({ ok: false, reason: 'missing', message: '' }))
    const body: AnatomyData = {
      schema: 1, body: 'male', sources: [],
      systems: [{ id: 'integumentary', name: { en: 'I', zh: 'I' }, color: '#fa8', glb: 'i.glb', partCount: 1 }],
      layers: [{ name: { en: 'a', zh: 'a' } }], parts: [part(data.skin)],
      trees: { isa: [{ id: 'R', name: 'R', parent: null, parts: [data.skin] }], partOf: [] },
    }
    useApp.setState({ graph: null, embed: false, pain: { level: 5, onset: 'sudden', hold: false, muted: false, always: false }, aus: {}, expr: null, viseme: null, skinOpaque: false, leftTab: 'display' })
    S().init(new AnatomyGraph(body), 'male')
  })

  it('restores expr, vis and au from a link, without sound, and writes them back', async () => {
    const warnings = await restoreFromUrl(parseUrl('tab=e&au=4:3&expr=Fearful:0.6&vis=pbm&skin=1').state)
    expect(warnings).toEqual([])
    expect(S().expr).toEqual({ id: 'fearful', strength: 0.6 })
    expect(S().viseme).toBe('PBM')
    expect(S().aus).toEqual({ AU4: 3 })
    expect([S().leftTab, S().faceStatus, S().voiceStatus, S().speech.status]).toEqual(['expr', 'ready', 'idle', 'idle'])
    expect(formatUrl(snapshot(S()))).toBe('tab=e&au=4:3&expr=fearful:0.6&vis=PBM&skin=1')
    S().setExpr(null)
    S().setViseme(null)
    expect(formatUrl(snapshot(S()))).toBe('tab=e&au=4:3&skin=1')
  })

  it('warns about an unknown expression or viseme and names what exists', async () => {
    const warnings = await restoreFromUrl(parseUrl('expr=bored&vis=XYZ').state)
    expect(warnings.join(' ')).toMatch(/bored/)
    expect(warnings.join(' ')).toMatch(/happy/)
    expect(warnings.join(' ')).toMatch(/XYZ/)
    expect(warnings.join(' ')).toMatch(/PBM/)
    expect([S().expr, S().viseme]).toEqual([null, null])
  })

  it('clamps the strength and loads the face data when an expression is set', async () => {
    S().setExpr({ id: 'happy', strength: 3 })
    expect(S().expr).toEqual({ id: 'happy', strength: 1 })
    expect(S().faceStatus).toBe('loading')
    await S().ensureFace()
    S().setExpr({ id: 'happy', strength: -1 })
    expect(S().expr).toEqual({ id: 'happy', strength: 0 })
    expect(snapshot(S()).expr).toBeUndefined()
  })

  it('the frame the viewer asks for composes the held pain, the manual AUs and the expression', async () => {
    await S().ensureFace()
    S().setExpr({ id: 'happy', strength: 1 })
    S().setAU('AU4', 2)
    const face = S().face!.data
    let f = faceFrame(1000)
    for (let t = 1016; t < 3000; t += 16) f = faceFrame(t)
    const ref = blendFace(face, { emotion: expressionAUs(face.expressions, 'happy', 1), pain: { AU4: 2 } })
    expect(maxDiff(f.channels, ref.channels)).toBeLessThan(1e-9)
    expect(f.animating).toBe(false)
    // 同一时刻再问一次（对照窗格）不推进时间 / asking again at the same instant (the compare pane) does not advance time
    expect(faceFrame(2984 + 16 - 16)).toBe(f)
    expect(faceFrame(5000, null)).toMatchObject({ channels: {}, jaw: 0 })
  })
})

describe('display.json hide list', () => {
  it('keeps only the parts this body has; null when the file is absent or malformed', () => {
    const has = (id: string): boolean => id !== 'gone'
    expect(hideListFrom({ hideWithOpaqueSkin: ['a', 'gone', 'b', 3] }, has)).toEqual(['a', 'b'])
    expect(hideListFrom({ hideWithOpaqueSkin: [] }, has)).toEqual([])
    expect(hideListFrom(null, has)).toBeNull()
    expect(hideListFrom({}, has)).toBeNull()
    expect(hideListFrom({ hideWithOpaqueSkin: 'a' }, has)).toBeNull()
  })

  it.each(['male', 'female'])('the %s display.json lists parts of that body only', (body) => {
    const dir = resolve(ROOT, `public/anatomy/${body}`)
    if (!existsSync(resolve(dir, 'display.json'))) return
    const ids = new Set((JSON.parse(readFileSync(resolve(dir, 'anatomy.json'), 'utf8')) as AnatomyData).parts.map((p) => p.id))
    const display = JSON.parse(readFileSync(resolve(dir, 'display.json'), 'utf8')) as { hideWithOpaqueSkin: string[] }
    const list = hideListFrom(display, (id) => ids.has(id))!
    expect(list.length).toBe(display.hideWithOpaqueSkin.length)
    expect(list.length).toBeGreaterThan(0)
  })
})

describe('calibration summaries', () => {
  const rows = [
    { body: 'male', muscle: 'Left biceps', movement: 'elbow flexion', diffMm: -30, toleranceMm: 10, ourArmMm: 10, refArmMm: 40, verdict: 'outside' },
    { body: 'female', muscle: 'Left biceps', movement: 'elbow flexion', diffMm: 4, toleranceMm: 10, ourArmMm: 44, refArmMm: 40, verdict: 'within' },
    { body: 'male', muscle: 'Right soleus', movement: 'ankle', diffMm: 12, toleranceMm: 10, ourArmMm: 52, refArmMm: 40, verdict: 'outside' },
    { body: 'female', muscle: 'x', end: 'origin', diffMm: null, toleranceMm: 25, ours: null, ref: null, verdict: 'not comparable' },
  ]
  it('filters by body, counts verdicts and ranks by disagreement in units of the tolerance', () => {
    const t = { rows }
    expect(hasBodies(t)).toBe(true)
    expect(countRows(rowsFor(t, 'all'))).toEqual({ rows: 4, within: 1, outside: 2, notComparable: 1, unjudged: 0 })
    expect(countRows(rowsFor(t, 'male'))).toEqual({ rows: 2, within: 0, outside: 2, notComparable: 0, unjudged: 0 })
    expect(disagreement(rows[0]!)).toBeCloseTo(3)
    expect(disagreement(rows[3]!)).toBeNull()
    expect(largestDisagreements(rows, 5).map((r) => r.muscle)).toEqual(['Left biceps', 'Right soleus'])
    expect(rowLabel(rows[0]!)).toBe('Left biceps · elbow flexion')
    expect(rowValues(rows[0]!)).toEqual({ ours: '10 mm', ref: '40 mm', diff: '-30 mm', tolerance: '10 mm' })
  })

  it('reads ratios, bands and tables without a verdict', () => {
    expect(disagreement({ ratio: 0.25, toleranceFactor: 2 })).toBeCloseTo(2)
    expect(disagreement({ ratio: 4, toleranceFactor: 2 })).toBeCloseTo(2)
    expect(disagreement({ oursMl: 130, refLowMl: 80, refHighMl: 120 })).toBeCloseTo(1.5)
    expect(rowValues({ oursMl: 130, refCentralMl: 100, refLowMl: 80, refHighMl: 120, diffMl: 30 })).toEqual({ ours: '130 mL', ref: '100 mL', diff: '30 mL', tolerance: '80–120 mL' })
    const loose = [{ muscle: 'a', diffMm: -6 }, { muscle: 'b', diffMm: 2 }]
    expect(countRows(loose).unjudged).toBe(2)
    expect(largestDisagreements(loose, 1)[0]!.muscle).toBe('a')
    // 不分人体的表：按人体筛选时整张保留 / a table not split by body is kept whole under a body filter
    expect(rowsFor({ rows: [{ entry: 'hip.flexion', verdict: 'within' }] }, 'female').length).toBe(1)
  })

  const dir = resolve(ROOT, 'data/curated/calibration')
  it.skipIf(!existsSync(dir))('every shipped table has what the view shows: titles, tolerance, references with licence and URL, rows', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const t = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as CalibrationTable
      expect(t.title.zh && t.title.en && t.tolerance.zh && t.tolerance.en && t.method.en, f).toBeTruthy()
      expect(t.references.length, f).toBeGreaterThan(0)
      for (const r of t.references) expect(r.name && r.version && r.licence && /^https?:\/\//.test(r.url), `${f} ${r.id}`).toBeTruthy()
      const c = countRows(t.rows)
      expect(c.within + c.outside + c.notComparable + c.unjudged).toBe(t.rows.length)
      // 判定只有这三种（或没有）/ verdicts are these three only (or absent)
      expect(c.unjudged === 0 || c.unjudged === t.rows.length, f).toBe(true)
      for (const r of largestDisagreements(t.rows, 5)) expect(rowLabel(r).length, f).toBeGreaterThan(0)
    }
  })
})
