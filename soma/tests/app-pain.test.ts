// 疼痛反应：表情位移对照参考实现（tools/face/model.ts）、时间过程、深链接参数和 store 流程。
// Pain response: face displacement against the reference (tools/face/model.ts), the time course,
// the deep-link parameters and the store flows.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { activations, deform, displacement, envelope, painAUs } from '../tools/face/model.ts'
import { AnatomyGraph } from '../src/anatomy/graph.ts'
import type { AnatomyData, Part } from '../src/anatomy/types.ts'
import type { FaceData } from '../src/face/types.ts'
import { STIMULUS_SECONDS, mouthAUs, painFrame, resetPainController, startSilentEpisode } from '../src/pain/controller.ts'
import { cleanAUs, displacePart, indexFace, maxAUs, sameAUs } from '../src/pain/face.ts'
import { setFaceLoader, setRigLoader, useApp } from '../src/state/store.ts'
import { resetUrlSync, restoreFromUrl, snapshot } from '../src/state/urlSync.ts'
import { formatUrl, parseUrl } from '../src/state/urlState.ts'
import { faceCamera } from '../src/ui/PainPanel.tsx'

const note = { zh: '测试', en: 'test' }
const sourced = { source: null, note }

/** 一份很小的表情数据：两个部件、三个通道、三个 AU。 A tiny face data set: two parts, three channels, three AUs. */
function tinyFace(): { data: FaceData; bin: Uint8Array } {
  const fields: { part: string; idx: number[]; vec: number[][]; scale: number }[] = [
    { part: 'skin', idx: [0, 2, 5], vec: [[100, -200, 300], [32767, 0, 0], [0, -32767, 1000]], scale: 0.008 },
    { part: 'skin', idx: [2, 3], vec: [[0, 5000, 0], [-1000, 1000, 1000]], scale: 0.004 },
    { part: 'muscle', idx: [1], vec: [[0, 0, 32767]], scale: 0.002 },
    { part: 'skin', idx: [5, 7], vec: [[500, 500, 500], [0, 0, -32767]], scale: 0.003 },
  ]
  const bytes: number[] = []
  const offsets: number[] = []
  for (const f of fields) {
    while (bytes.length % 4) bytes.push(0)
    offsets.push(bytes.length)
    const buf = new ArrayBuffer(f.idx.length * 10)
    const dv = new DataView(buf)
    f.idx.forEach((v, i) => dv.setUint32(i * 4, v, true))
    f.vec.forEach((v, i) => v.forEach((c, k) => dv.setInt16(f.idx.length * 4 + i * 6 + k * 2, c, true)))
    bytes.push(...new Uint8Array(buf))
  }
  const field = (i: number) => ({ part: fields[i]!.part, offset: offsets[i]!, count: fields[i]!.idx.length, scale: fields[i]!.scale })
  const line = { origin: [0, 0, 0] as [number, number, number], insertion: [0, 0, 0] as [number, number, number], originOnSkin: [0, 0, 0] as [number, number, number], insertionOnSkin: [0, 0, 0] as [number, number, number] }
  const channel = (id: string, f: ReturnType<typeof field>[]) => ({ id, muscle: id, name: note, kind: 'linear' as const, side: 'M' as const, parts: [], line, basis: 'geometry' as const, excursion: 0.008, fields: f })
  const data: FaceData = {
    schema: 1,
    body: 'male',
    note,
    skin: 'skin',
    inputs: {},
    binBytes: bytes.length,
    parts: [{ part: 'skin', vertexCount: 8, entries: 7 }, { part: 'muscle', vertexCount: 3, entries: 1 }],
    channels: [channel('brow', [field(0), field(2)]), channel('lid', [field(1)]), channel('lip', [field(3)])],
    aus: [
      { id: 'AU4', name: { zh: '皱眉', en: 'Brow lowerer' }, channels: { brow: 1 }, basis: sourced },
      { id: 'AU43', name: { zh: '闭眼', en: 'Eyes closed' }, channels: { lid: 1, brow: 0.2 }, basis: sourced },
      { id: 'AU26', name: { zh: '下颌下降', en: 'Jaw drop' }, channels: { lip: 0.5 }, jaw: 0.3, basis: sourced },
      { id: 'AU27', name: { zh: '张大口', en: 'Mouth stretch' }, channels: { lip: 1 }, jaw: 0.5, basis: sourced },
    ],
    pain: {
      pspi: { terms: ['AU4', 'AU43'], binary: ['AU43'], max: 6, basis: sourced },
      keyframes: [{ level: 0, aus: {} }, { level: 10, aus: { AU4: 5, AU43: 4, AU26: 2 } }],
      mapping: sourced,
      timing: { latency: 0.3, onset: 0.6, offset: 1.5, basis: sourced },
    },
    jaw: { joint: 'tmj', dof: 0, max: 0.45, closers: [], openers: [] },
    bounds: { channel: 0.008, total: 0.02 },
    landmarks: { midX: 0.001, stomionY: { skin: 1.45, deep: null }, eyes: [{ side: 'L', globe: [0.03, 1.52, 0.15], radius: 0.012, fissure: null }, { side: 'R', globe: [-0.03, 1.52, 0.15], radius: 0.012, fissure: null }] },
    sources: [],
    cautions: [note],
  }
  return { data, bin: new Uint8Array(bytes) }
}

describe('face displacement against the reference', () => {
  const { data, bin } = tinyFace()
  const face = indexFace(data, bin)
  const rest = new Float32Array(24).map((_, i) => Math.sin(i) * 0.1)

  it.each([
    ['one AU', { AU4: 5 }],
    ['overlapping AUs clamp the channel', { AU4: 5, AU43: 5 }],
    ['partial intensities', { AU4: 1.5, AU43: 3, AU27: 2 }],
    ['nothing', {}],
  ])('%s', (_name, aus) => {
    const act = activations(data, aus)
    const out = new Float32Array(24)
    const any = displacePart(face, 'skin', rest, act.channels, out)
    expect(any).toBe(Object.keys(aus).length > 0)
    // 与参考实现的差别只在浮点舍入的顺序上：1 纳米以内 / differs from the reference only in the order of float rounding: within a nanometre
    const close = (a: Float32Array, b: Float32Array): number => a.reduce((w, v, i) => Math.max(w, Math.abs(v - b[i]!)), 0)
    expect(close(out, deform(data.channels, bin, 'skin', rest, act.channels))).toBeLessThan(1e-9)
    const m = new Float32Array(9)
    displacePart(face, 'muscle', new Float32Array(9), act.channels, m)
    expect(close(m, displacement(data.channels, bin, 'muscle', 3, act.channels))).toBeLessThan(1e-9)
  })

  it('leaves the rest array alone and an unlisted part unchanged', () => {
    const copy = new Float32Array(rest)
    const out = new Float32Array(24)
    displacePart(face, 'skin', rest, { brow: 1, lid: 1, lip: 1 }, out)
    expect([...rest]).toEqual([...copy])
    expect(displacePart(face, 'elsewhere', rest, { brow: 1 }, out)).toBe(false)
    expect([...out]).toEqual([...rest])
  })

  it('rejects data whose files do not agree', () => {
    expect(() => indexFace(data, bin.slice(0, 20))).toThrow(/face\.bin/)
    const wrong = structuredClone(data)
    wrong.parts[0]!.vertexCount = 3
    expect(() => indexFace(wrong, bin)).toThrow(/越界|out of range/)
    const unlisted = structuredClone(data)
    unlisted.parts.pop()
    expect(() => indexFace(unlisted, bin)).toThrow(/未列出|unlisted/)
    expect(() => indexFace({} as FaceData, bin)).toThrow(/FaceData/)
  })

  it('AU helpers', () => {
    expect(cleanAUs({ AU9: 7, AU4: 0, AU43: -1, AU6: 2 })).toEqual({ AU6: 2, AU9: 5 })
    expect(maxAUs({ AU4: 1, AU6: 3 }, { AU4: 2, AU7: 1 })).toEqual({ AU4: 2, AU6: 3, AU7: 1 })
    expect(sameAUs({ AU4: 1 }, { AU4: 1.001 })).toBe(true)
    expect(sameAUs({ AU4: 1 }, { AU4: 1.01 })).toBe(false)
    expect(sameAUs({}, { AU4: 0.5 })).toBe(false)
    expect(mouthAUs(0)).toEqual({})
    expect(mouthAUs(0.5)).toEqual({ AU26: 2.5, AU27: 0 })
    expect(mouthAUs(1).AU27).toBeCloseTo(5)
  })

  it('frames the face from its landmarks', () => {
    const c = faceCamera(data)
    expect(c.t[0]).toBeCloseTo(0.001)
    expect(c.t[1]).toBeCloseTo((1.52 + 1.45) / 2)
    expect(c.p[2] - c.t[2]).toBeCloseTo(0.52)
  })
})

const part = (id: string): Part => ({ id, fma: `F${id}`, name: id, system: 'integumentary', tissue: 'skin', depth: 0, side: 'M', provenance: 'scanned', bbox: [0, 0, 0, 1, 1, 1], centroid: [0, 0, 0], triangles: 1, adjacent: [] })
const body: AnatomyData = {
  schema: 1, body: 'male', sources: [],
  systems: [
    { id: 'integumentary', name: { en: 'I', zh: 'I' }, color: '#fa8', glb: 'i.glb', partCount: 1 },
    { id: 'muscular', name: { en: 'M', zh: 'M' }, color: '#a00', glb: 'm.glb', partCount: 1 },
    { id: 'skeletal', name: { en: 'S', zh: 'S' }, color: '#eee', glb: 's.glb', partCount: 0 },
  ],
  layers: [{ name: { en: 'a', zh: 'a' } }], parts: [part('skin'), { ...part('muscle'), system: 'muscular', tissue: 'muscle' }],
  trees: { isa: [{ id: 'R', name: 'R', parent: null, parts: ['skin', 'muscle'] }], partOf: [] },
}
const S = () => useApp.getState()

describe('time course and store flows', () => {
  beforeEach(() => {
    resetUrlSync()
    resetPainController()
    const { data, bin } = tinyFace()
    setFaceLoader(async () => indexFace(data, bin))
    setRigLoader(async () => ({ ok: false, reason: 'missing', message: '' }))
    useApp.setState({ graph: null, embed: false, pain: { level: 5, onset: 'sudden', hold: false, muted: false, always: false }, aus: {}, skinOpaque: false, leftTab: 'display' })
    S().init(new AnatomyGraph(body), 'male')
  })

  it('loads the face data lazily, when the panel opens', async () => {
    expect(S().faceStatus).toBe('idle')
    S().setLeftTab('pain')
    expect(S().faceStatus).toBe('loading')
    await S().ensureFace()
    expect(S().faceStatus).toBe('ready')
  })

  it('reports a body without face data or with a foreign skin part', async () => {
    setFaceLoader(async () => null)
    await S().ensureFace()
    expect(S().faceStatus).toBe('missing')
    S().init(new AnatomyGraph(body), 'male')
    const { data, bin } = tinyFace()
    setFaceLoader(async () => indexFace({ ...data, skin: 'nope' }, bin))
    await S().ensureFace()
    expect(S().faceStatus).toBe('error')
    S().rejectFace('x')
    expect([S().face, S().faceMessage]).toEqual([null, 'x'])
  })

  it('nothing happens without face data; hold slews the expression in and out', async () => {
    expect(painFrame(0)).toEqual({ aus: {}, animating: false, airflow: 0 })
    await S().ensureFace()
    S().setPain({ level: 10, hold: true })
    let f = painFrame(1000)
    f = painFrame(1100)
    expect(f.animating).toBe(true)
    expect(f.aus.AU4!).toBeGreaterThan(0)
    expect(f.aus.AU4!).toBeLessThan(5)
    for (let t = 1200; t <= 2500; t += 100) f = painFrame(t)
    expect(f).toMatchObject({ aus: { AU4: 5, AU43: 4, AU26: 2 }, animating: false })
    S().setPain({ hold: false })
    for (let t = 2600; t <= 5000; t += 100) f = painFrame(t)
    expect(f).toEqual({ aus: {}, animating: false, airflow: 0 })
  })

  it('a triggered episode follows the reference envelope and then ends', async () => {
    const face = (await S().ensureFace())!
    const timing = face.data.pain.timing
    startSilentEpisode(10_000, 8, STIMULUS_SECONDS.sustained)
    expect(painFrame(10_000 + 100).aus).toEqual({}) // 潜伏期内 / within the latency
    const at = painFrame(10_000 + 2000)
    const env = envelope(timing, 2, STIMULUS_SECONDS.sustained)
    expect(env).toBeCloseTo(1)
    expect(at.aus.AU4).toBeCloseTo(painAUs(face.data.pain, 8).AU4! * env)
    const fading = painFrame(10_000 + (STIMULUS_SECONDS.sustained + timing.latency + 0.5) * 1000)
    expect(fading.aus.AU4!).toBeLessThan(at.aus.AU4!)
    expect(fading.animating).toBe(true)
    const done = painFrame(10_000 + (STIMULUS_SECONDS.sustained + timing.latency + timing.offset + 1) * 1000)
    expect(done).toEqual({ aus: {}, animating: false, airflow: 0 })
  })

  it('manual AUs combine with the pain expression by maximum', async () => {
    await S().ensureFace()
    S().setAU('AU4', 2)
    S().setAU('AU27', 9)
    expect(S().aus).toEqual({ AU4: 2, AU27: 5 })
    expect(painFrame(0).aus).toEqual({ AU27: 5, AU4: 2 })
    S().setAU('AU4', 0)
    expect(S().aus).toEqual({ AU27: 5 })
    S().clearAUs()
    expect(S().aus).toEqual({})
  })

  it('the two preset views, and muted by default in embed mode', () => {
    S().setFaceView('muscle')
    expect([S().systems.muscular!.visible, S().systems.skeletal!.visible, S().systems.integumentary!.visible, S().skinOpaque]).toEqual([true, true, false, false])
    S().setFaceView('skin')
    expect([S().systems.muscular!.visible, S().systems.integumentary!.visible, S().skinOpaque]).toEqual([false, true, true])
    expect(S().pain.muted).toBe(false)
    useApp.setState({ embed: true })
    S().init(new AnatomyGraph(body), 'male')
    expect(S().pain.muted).toBe(true)
  })

  it('deep links: pain, au, skin and the pain tab round-trip and restore without any sound', async () => {
    for (const q of ['pain=7', 'au=4:3,43:5', 'pain=6.5&au=26:2.5&skin=1', 'tab=n&pain=3']) {
      const p = parseUrl(q)
      expect(p.warnings).toEqual([])
      expect(formatUrl(p.state)).toBe(q)
    }
    expect(parseUrl('pain=11').warnings.join()).toMatch(/pain/)
    expect(parseUrl('pain=').warnings.join()).toMatch(/pain/)
    expect(parseUrl('au=4:9,x:1,43:2').warnings.join()).toMatch(/au/)
    expect(parseUrl('au=4:9,x:1,43:2').state.au).toEqual({ AU43: 2 })

    const warnings = await restoreFromUrl(parseUrl('tab=n&pain=7&au=43:5,99:2&skin=1').state)
    expect(warnings.join(' ')).toMatch(/AU99/)
    expect(S().pain).toMatchObject({ level: 7, hold: true })
    expect(S().aus).toEqual({ AU43: 5 })
    expect([S().skinOpaque, S().leftTab, S().faceStatus]).toEqual([true, 'pain', 'ready'])
    expect(S().voiceStatus).toBe('idle') // 没有手势就不加载、不播放声音 / no gesture: the sound is neither loaded nor played
    expect(formatUrl(snapshot(S()))).toBe('tab=n&pain=7&au=43:5&skin=1')
    S().setPain({ hold: false })
    expect(formatUrl(snapshot(S()))).toBe('tab=n&au=43:5&skin=1')
  })
})

// 真实数据（缺失时跳过）：皮肤上的位移与参考实现逐项相同
// The real data (skipped when absent): displacement on the skin identical to the reference
describe.each(['male', 'female'])('real face data: %s', (name) => {
  const dir = resolve(__dirname, `../public/anatomy/${name}`)
  it.skipIf(!existsSync(resolve(dir, 'face.bin')))('matches the reference on the skin and the deep parts at several pain levels', () => {
    const data = JSON.parse(readFileSync(resolve(dir, 'face.json'), 'utf8')) as FaceData
    const raw = readFileSync(resolve(dir, 'face.bin'))
    const bin = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    const face = indexFace(data, bin)
    expect(face.fields.size).toBe(data.parts.filter((p) => p.entries > 0).length)
    let moved = 0
    for (const level of [3, 7, 10]) {
      const act = activations(data, painAUs(data.pain, level))
      for (const p of [data.parts[0]!, ...data.parts.slice(1).filter((_, i) => i % 9 === 0)]) {
        const rest = new Float32Array(p.vertexCount * 3)
        const out = new Float32Array(rest.length)
        displacePart(face, p.part, rest, act.channels, out)
        const ref = displacement(data.channels, bin, p.part, p.vertexCount, act.channels)
        let worst = 0
        for (let i = 0; i < out.length; i++) {
          worst = Math.max(worst, Math.abs(out[i]! - ref[i]!))
          if (out[i] !== 0) moved++
        }
        // 两边都是 float32 累加，只是求和次序不同；位移分量到 16–32 mm 时一个 ulp 是 1.86e-9 m，容差取两个 ulp。
        // Both sides accumulate in float32 in a different order; at components of 16–32 mm one ulp is 1.86e-9 m, so the tolerance is two ulps.
        expect(worst).toBeLessThan(4e-9)
      }
    }
    expect(moved).toBeGreaterThan(1000)
    expect(() => faceCamera(data)).not.toThrow()
  })
})
