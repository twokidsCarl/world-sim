// 体型控制：取值与限幅、URL 参数、store 流程；真实数据上对照参考实现（tools/rig/shape.ts）。
// Body-shape controls: values and clamping, the URL parameter, the store flows; the real data
// against the reference (tools/rig/shape.ts).
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Shaper, jointScales, resolveControls } from '../tools/rig/shape.ts'
import { AnatomyGraph } from '../src/anatomy/graph.ts'
import { checkShape, clampControl, formatShapeParam, mapShapeControls, nonDefaultControls, parseShapeParam, shapeIsDefault, shapeScales } from '../src/anatomy/shape.ts'
import type { AnatomyData, Part } from '../src/anatomy/types.ts'
import type { ShapeData } from '../src/shape/types.ts'
import { HIDDEN, NORMAL, computeDisplay, skinDrawnOpaque } from '../src/state/display.ts'
import { setRigLoader, setShapeLoader, useApp } from '../src/state/store.ts'
import { resetUrlSync, restoreFromUrl, snapshot } from '../src/state/urlSync.ts'
import { formatUrl, parseUrl } from '../src/state/urlState.ts'

const why = { zh: '下限：再低肌肉会穿出皮肤', en: 'lower limit: muscle would come through the skin' }
const name = { zh: '测试', en: 'test' }

/** 一份很小的体型数据：3 个皮肤顶点、1 个跟随部件、2 个关节。 A tiny shape data set: 3 skin vertices, 1 follower, 2 joints. */
function tinyShape(): { data: ShapeData; bin: Uint8Array } {
  const buf = new ArrayBuffer(3 * 12 + 3 * 4 + 2 * 4 + 2)
  const dv = new DataView(buf)
  ;[[0.001, 0, 0], [0, 0.002, 0], [0, 0, 0.004]].forEach((v, i) => v.forEach((c, k) => dv.setFloat32(i * 12 + k * 4, c, true)))
  ;[0.01, 0.01, 0.006].forEach((v, i) => dv.setFloat32(36 + i * 4, v, true))
  dv.setUint32(48, 2, true)
  dv.setUint32(52, 0, true)
  dv.setUint8(56, 255)
  dv.setUint8(57, 128)
  const control = (id: ShapeData['controls'][number]['id'], unit: string, min: number, max: number, def: number, vmin = min, vmax = max) => ({ id, name, unit, min, max, default: def, valid: { min: vmin, max: vmax, why } })
  const data: ShapeData = {
    schema: 1,
    body: 'male',
    controls: [control('stature', 'm', 1.4, 2, 1.72), control('bmi', 'kg/m2', 16, 40, 23.5, 21.5), control('legLength', 'sd', -3, 2, -1), control('centralBuild', 'sd', -2, 2, 0)],
    factors: [
      { id: 'leg', name, kind: 'length', exponents: { stature: 1.1, legLength: 0.03, centralBuild: 0 } },
      { id: 'girth', name, kind: 'girth', exponents: { stature: 0.9, legLength: 0, centralBuild: 0.02 } },
    ],
    joints: [
      { joint: 'hip_L', along: [{ factor: 'leg', gain: 1 }], across: [{ factor: 'girth', gain: 0.5 }] },
      { joint: 'root', along: [{ factor: 'girth', gain: 1 }], across: [{ factor: 'girth', gain: 1 }] },
    ],
    skin: { part: 'skin', vertexCount: 3, fatOffset: 0, limitOffset: 36, bmiToUnits: [[21.5, -2], [23.5, 0], [40, 16.5]] },
    followers: [{ part: 'fat', vertexCount: 2, skinIndexOffset: 48, followOffset: 56 }],
    rules: [name],
    cautions: [name],
    sources: [],
  }
  return { data, bin: new Uint8Array(buf) }
}

describe('shape helpers', () => {
  const { data, bin } = tinyShape()

  it('clamps to the range valid on this body, not the model range, and says which end was hit', () => {
    const bmi = data.controls[1]!
    expect(clampControl(bmi, 18)).toEqual({ value: 21.5, limited: 'min' })
    expect(clampControl(bmi, 99)).toEqual({ value: 40, limited: 'max' })
    expect(clampControl(bmi, 30)).toEqual({ value: 30, limited: null })
  })

  it('knows the default shape and gives joint scales only away from it', () => {
    expect(shapeIsDefault(data, {})).toBe(true)
    expect(shapeIsDefault(data, { bmi: 23.5 })).toBe(true)
    expect(shapeIsDefault(data, { bmi: 30 })).toBe(false)
    expect(shapeScales(data, {})).toBeNull()
    expect(shapeScales(data, { bmi: 30 })).toBeNull() // BMI 只动皮肤，不动关节 / BMI moves the skin, not the joints
    const s = shapeScales(data, { stature: 1.9 })!
    expect(s).toEqual(jointScales(data, { stature: 1.9 }))
    expect(s.hip_L!.along!).toBeGreaterThan(1.1)
    expect(nonDefaultControls(data, { stature: 1.72, bmi: 30, legLength: -1 })).toEqual({ bmi: 30 })
  })

  it('URL parameter: letters h b l c, round trip, bad items reported', () => {
    expect(parseShapeParam('h1.80,b28,l0,c-0.5')).toEqual({ controls: { stature: 1.8, bmi: 28, legLength: 0, centralBuild: -0.5 }, bad: false })
    expect(formatShapeParam({ centralBuild: -0.5, stature: 1.8, bmi: 28, legLength: 0 })).toBe('h1.8,b28,l0,c-0.5')
    expect(parseShapeParam('h1.8,x3,b,bq')).toEqual({ controls: { stature: 1.8 }, bad: true })
    expect(formatUrl(parseUrl('shape=h1.8,b28').state)).toBe('shape=h1.8,b28')
    expect(parseUrl('shape=zz').warnings.join()).toMatch(/shape/)
    expect(parseUrl('shape=zz').state.shape).toBeUndefined()
  })

  it('carries controls over to the other body as offsets from its own defaults, clamped there', () => {
    const other = tinyShape()
    other.data.controls[0] = { ...other.data.controls[0]!, default: 1.6 }
    other.data.controls[1] = { ...other.data.controls[1]!, default: 22, valid: { ...other.data.controls[1]!.valid, min: 18, max: 30 } }
    const main = checkShape(data, bin), o = checkShape(other.data, other.bin)
    const m = mapShapeControls(main, { stature: 1.82, bmi: 33.5 }, o)
    expect(m.stature).toBeCloseTo(1.7) // +10 cm on both / +10 cm on both
    expect(m.bmi).toBe(30) // +10 会到 32，这副身体只到 30 / +10 would be 32; this body stops at 30
    expect(mapShapeControls(main, {}, o)).toEqual({})
    expect(mapShapeControls(null, { stature: 1.9 }, o)).toEqual({})
  })

  it('rejects files that do not agree', () => {
    expect(checkShape(data, bin).data).toBe(data)
    expect(() => checkShape(data, bin.slice(0, 40))).toThrow(/shape\.bin/)
    expect(() => checkShape({ ...data, followers: [{ ...data.followers[0]!, vertexCount: 9 }] }, bin)).toThrow(/跟随|follower/)
    expect(() => checkShape({} as ShapeData, bin)).toThrow(/ShapeData/)
  })

  it('the reference displaces the skin (capped) and its followers by their share', () => {
    const sh = new Shaper(data, bin, { bmi: 40 })
    const skin = sh.shapedRest('skin', new Float32Array(9))
    expect(skin[0]).toBeCloseTo(0.01) // 16.5 × 1 mm，限幅 10 mm / 16.5 × 1 mm capped at 10 mm
    expect(skin[8]).toBeCloseTo(0.006)
    const fat = sh.shapedRest('fat', new Float32Array(6))
    expect(fat[2]).toBeCloseTo(0.006) // 完全跟随皮肤顶点 2 / follows skin vertex 2 fully
    expect(fat[3]).toBeCloseTo(0.01 * (128 / 255))
    expect(new Shaper(data, bin, { bmi: 10 }).shapedRest('skin', new Float32Array(9))[0]).toBeCloseTo(-0.002) // 截到可用下限 21.5 / clamped to the valid minimum 21.5
  })
})

const part = (id: string): Part => ({ id, fma: `F${id}`, name: id, system: 'integumentary', tissue: 'skin', depth: 0, side: 'M', provenance: 'scanned', bbox: [0, 0, 0, 1, 1, 1], centroid: [0, 0, 0], triangles: id === 'skin' ? 9 : 1, adjacent: [] })
const body: AnatomyData = {
  schema: 1, body: 'male', sources: [],
  systems: [{ id: 'integumentary', name: { en: 'I', zh: 'I' }, color: '#fa8', glb: 'i.glb', partCount: 3 }],
  layers: [{ name: { en: 'a', zh: 'a' } }], parts: [part('hair'), part('skin'), part('fat')],
  trees: { isa: [{ id: 'R', name: 'R', parent: null, parts: ['hair', 'skin', 'fat'] }], partOf: [] },
}
const S = () => useApp.getState()

describe('store: shape flows', () => {
  beforeEach(() => {
    resetUrlSync()
    const { data, bin } = tinyShape()
    setShapeLoader(async () => checkShape(data, bin))
    setRigLoader(async () => ({ ok: false, reason: 'missing', message: '' }))
    useApp.setState({ graph: null, embed: false, leftTab: 'display', shapeControls: {}, jointScales: null })
    S().init(new AnatomyGraph(body), 'male')
  })

  it('loads lazily; sets, clamps (showing which limit) and resets', async () => {
    expect(S().shapeStatus).toBe('idle')
    await S().ensureShape()
    expect(S().shapeStatus).toBe('ready')
    S().setShapeControl('stature', 1.9)
    expect(S().shapeControls).toEqual({ stature: 1.9 })
    expect(S().jointScales!.hip_L!.along!).toBeGreaterThan(1.1)
    expect(S().shapeLimit).toBeNull()
    S().setShapeControl('bmi', 18)
    expect(S().shapeControls.bmi).toBe(21.5)
    expect(S().shapeLimit).toEqual({ id: 'bmi', side: 'min' })
    S().setShapeControl('bmi', 23.5) // 回到默认值：从记录里去掉 / back at the default: dropped from the record
    expect(S().shapeControls).toEqual({ stature: 1.9 })
    S().resetShape()
    expect([S().shapeControls, S().jointScales, S().shapeLimit]).toEqual([{}, null, null])
  })

  it('controls that arrive before the data are clamped and applied once it loads', async () => {
    const out = await restoreFromUrl(parseUrl('shape=h1.9,b10').state)
    expect(out.join(' ')).toMatch(/bmi=10/)
    expect(S().shapeControls).toEqual({ stature: 1.9, bmi: 21.5 })
    expect(S().jointScales).not.toBeNull()
    expect(formatUrl(snapshot(S()))).toBe('shape=h1.9,b21.5')
  })

  it('reports a body without shape data; a body switch goes back to as-built', async () => {
    setShapeLoader(async () => null)
    await S().ensureShape()
    expect(S().shapeStatus).toBe('missing')
    S().init(new AnatomyGraph(body), 'male')
    const { data, bin } = tinyShape()
    setShapeLoader(async () => checkShape(data, bin))
    await S().ensureShape()
    S().setShapeControl('stature', 1.5)
    S().init(new AnatomyGraph({ ...body, body: 'female' }), 'female')
    expect([S().shape, S().shapeControls, S().jointScales]).toEqual([null, {}, null])
  })

  it('hair meshes are hidden whenever the skin is drawn opaque, but stay selectable from the tree', () => {
    const g = new AnatomyGraph(body)
    expect([...g.unfittedAppendages()]).toEqual(['hair'])
    const input = () => ({ systems: S().systems, peel: 0, hidden: S().hidden, isolated: null, adjacentMode: false, selected: S().selection.set, unfitted: skinDrawnOpaque(S(), g.mainSkinId()) ? g.unfittedAppendages() : null })
    expect([...computeDisplay(g, input())]).toEqual([NORMAL, NORMAL, NORMAL])
    S().setFaceView('skin')
    expect(S().skinOpaque).toBe(true)
    expect([...computeDisplay(g, input())]).toEqual([HIDDEN, NORMAL, NORMAL])
    S().selectParts(['hair'])
    expect([...computeDisplay(g, input())]).toEqual([NORMAL, NORMAL, NORMAL])
    S().clearSelection()
    S().setSkinOpaque(false)
    expect(skinDrawnOpaque(S(), 'skin')).toBe(false)
    expect(skinDrawnOpaque({ ...S(), skinMapMode: 'dermatome' }, 'skin')).toBe(true)
    expect(skinDrawnOpaque({ ...S(), skinMapMode: 'dermatome', skinSeeThrough: true }, 'skin')).toBe(false)
  })
})

// 真实数据（缺失时跳过）：文件自洽，默认体型不产生位移和缩放，参考实现在极值处也成立
// The real data (skipped when absent): the files agree, the default shape gives no displacement or scale, the reference holds at the extremes
describe.each(['male', 'female'])('real shape data: %s', (bodyName) => {
  const dir = resolve(__dirname, `../public/anatomy/${bodyName}`)
  it.skipIf(!existsSync(resolve(dir, 'shape.bin')))('is consistent and neutral at the defaults', () => {
    const data = JSON.parse(readFileSync(resolve(dir, 'shape.json'), 'utf8')) as ShapeData
    const raw = readFileSync(resolve(dir, 'shape.bin'))
    const shape = checkShape(data, new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
    expect(data.controls.map((c) => c.id).sort()).toEqual(['bmi', 'centralBuild', 'legLength', 'stature'])
    for (const c of data.controls) {
      expect(c.valid.min).toBeGreaterThanOrEqual(c.min)
      expect(c.valid.max).toBeLessThanOrEqual(c.max)
      expect(c.default).toBeGreaterThanOrEqual(c.valid.min)
      expect(c.valid.why.zh.length * c.valid.why.en.length).toBeGreaterThan(0)
    }
    expect(shapeScales(data, {})).toBeNull()
    const rest = new Float32Array(data.skin.vertexCount * 3)
    expect(new Shaper(data, shape.bin, {}).shapedRest(data.skin.part, rest).every((v) => Math.abs(v) < 1e-7)).toBe(true)
    const fat = new Shaper(data, shape.bin, { bmi: 40 }).shapedRest(data.skin.part, rest)
    expect(Math.max(...fat.map(Math.abs))).toBeGreaterThan(0.01)
    expect(resolveControls(data, { bmi: 0 }).bmi).toBe(data.controls.find((c) => c.id === 'bmi')!.valid.min)
    expect(Object.keys(shapeScales(data, { stature: 1.9, legLength: 1 })!).length).toBeGreaterThan(50)
  })
})
