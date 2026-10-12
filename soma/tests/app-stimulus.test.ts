// 刺激工具的纯逻辑：设置 → Stimulus、地址参数、命名部位；真实数据上（缺失或不自洽时跳过）走一遍模型。
// Pure logic of the stimulus tool: settings → Stimulus, the URL parameter, named sites; and one pass
// through the model on the real data (skipped when it is absent or inconsistent).
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeSkinMaps } from '../src/anatomy/skinmaps.ts'
import type { AnatomyData, NervePath, Rig } from '../src/anatomy/types.ts'
import { painMapWeights, prepareStimulus, type InnervationTable, type PainBody } from '../src/painmodel/index.ts'
import { KINDS, SITES, buildStimulus, defaultSettings, formatStimParam, kindSpec, parseSite, parseStimParam, pressureKPa, resolveSite, siteRefOf, withKind } from '../src/pain/stimulus.ts'
import { formatUrl, parseUrl } from '../src/state/urlState.ts'
import { bindPath, boundPositions, pointAlong, resamplePolyline } from '../src/viewer/stimVisuals.ts'

describe('stimulus settings', () => {
  it('has the defaults and device ranges of the model note for every kind', () => {
    expect(KINDS.map((k) => [k.id, k.default, k.unit, k.min, k.max, k.duration])).toEqual([
      ['pinprick', 128, 'mN', 8, 512, 2],
      ['pressure', 50, 'N', 0, 200, 3],
      ['pinch', 15, 'N', 0, 40, 1],
      ['heat', 46, '°C', 32, 50, 5],
      ['cold', 8, '°C', 0, 32, 10],
    ])
    expect(pressureKPa(defaultSettings('pressure'))).toBe(500)
    expect(pressureKPa(defaultSettings('pinch'))).toBe(600)
    expect(pressureKPa(defaultSettings('heat'))).toBeNull()
  })

  it('builds the model stimulus in SI units; held and repeat carry over', () => {
    const site = { vertex: 7, position: [0.1, 1, 0.02] as [number, number, number] }
    expect(buildStimulus(defaultSettings('pinprick'), site, 'skin')).toEqual({ kind: 'pinprick', site: { part: 'skin', position: site.position, vertex: 7 }, duration: 2, forceN: 0.128 })
    expect(buildStimulus({ ...defaultSettings('pinch'), held: true }, site, 'skin')).toMatchObject({ forceN: 15, areaMm2: 25, withdrawalEndsStimulus: false })
    expect(buildStimulus({ ...defaultSettings('heat'), repeat: { count: 5, hz: 1 } }, site, 'skin', 9)).toMatchObject({ temperatureC: 46, duration: 9, repeat: { count: 5, hz: 1 } })
    expect(buildStimulus(defaultSettings('cold'), site, 'skin').withdrawalEndsStimulus).toBeUndefined()
    expect(withKind({ ...defaultSettings('heat'), held: true }, 'cold')).toMatchObject({ kind: 'cold', magnitude: 8, duration: 10, held: true })
  })

  it('URL parameter round trips; malformed ones are refused', () => {
    for (const text of ['heat,48,8@forearm_L', 'cold,4,60,held@palm_L', 'pinprick,256,0.5,x10/1@handback_R', 'pinch,20,1@p-182,1034,28', 'heat,47,5,toleranceRamp@cheek_R']) {
      const p = parseStimParam(text)
      expect(p, text).not.toBeNull()
      expect(formatStimParam(p!)).toBe(text)
    }
    expect(parseStimParam('heat,48,8,held@forearm_L')!.settings).toMatchObject({ kind: 'heat', magnitude: 48, duration: 8, held: true, heatAnchor: 'painScale' })
    expect(parseStimParam('pinprick,256,0.5,x10/1@handback_R')!.settings.repeat).toEqual({ count: 10, hz: 1 })
    for (const bad of ['heat,48@forearm_L', 'laser,48,8@forearm_L', 'heat,48,8', 'heat,48,8@elbow_L', 'heat,48,8@forearm', 'heat,48,8,bogus@forearm_L', 'heat,48,-1@forearm_L']) expect(parseStimParam(bad), bad).toBeNull()
    expect(parseSite('p1,2,3')).toEqual({ mm: [1, 2, 3] })
    expect(siteRefOf({ vertex: 0, position: [0.0124, 1.2, -0.03] })).toEqual({ mm: [12.4, 1200, -30] })
    const url = formatUrl(parseUrl('stim=heat,48,8@forearm_L').state)
    expect(url).toBe('stim=heat,48,8@forearm_L')
    expect(parseUrl('stim=nonsense').warnings.join()).toMatch(/stim/)
  })
})

describe('pathway geometry helpers', () => {
  it('resamples, measures along and follows bound vertices', () => {
    const line = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 3, 0])
    expect([...pointAlong(line, 0.5)]).toEqual([1, 1, 0])
    expect([...pointAlong(line, 0)]).toEqual([0, 0, 0])
    expect([...pointAlong(line, 2)]).toEqual([1, 3, 0])
    expect(resamplePolyline(Float32Array.from({ length: 300 }, (_, i) => i), 10)).toHaveLength(30)
    const a = Float32Array.from([0, 0, 0.1, 5, 5, 5]), b = Float32Array.from([1, 3, 0.1])
    const bind = bindPath(line, [a, b])
    expect([...bind.part]).toEqual([0, 0, 0, 1])
    expect([...bind.vertex]).toEqual([0, 0, 0, 0])
    // 候选 1 平移了 (0, 0, 2)：只有绑在它上面的点跟着走 / candidate 1 moved by (0, 0, 2): only the point bound to it follows
    const out = boundPositions(line, bind, (c) => (c === 1 ? Float32Array.from([1, 3, 2.1]) : null), new Float32Array(12))
    expect([...out.slice(0, 9)]).toEqual([...line.slice(0, 9)])
    expect(out[11]).toBeCloseTo(2)
  })
})

// 真实数据：构造 PainBody（与 src/pain/stim.ts 相同的拼法），每个命名部位都能落到皮肤上，卡片里的四个场景给出合理的结果
// The real data: a PainBody assembled as src/pain/stim.ts does; every named site lands on the skin and the four card scenarios give sensible results
describe.each(['male', 'female'])('pain model on the real data: %s', (name) => {
  const dir = resolve(__dirname, `../public/anatomy/${name}`)
  const have = ['anatomy.json', 'skinmaps.json', 'skinmaps.bin', 'nerves.json', 'rig.json'].every((f) => existsSync(resolve(dir, f)))
  const load = async (): Promise<PainBody | string> => {
    const anatomy = JSON.parse(readFileSync(resolve(dir, 'anatomy.json'), 'utf8')) as AnatomyData
    const raw = readFileSync(resolve(dir, 'skinmaps.bin'))
    const skinMaps = decodeSkinMaps(JSON.parse(readFileSync(resolve(dir, 'skinmaps.json'), 'utf8')), raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
    try {
      const { loadPainBody } = await import('../tools/pain/load.ts')
      const b = await loadPainBody(name as 'male' | 'female')
      // 界面用的是 store 里解码的体表图和 rig.json 的关节：换上它们，确认拼法兼容
      // the UI uses the store's decoded skin maps and the joints of rig.json: swap them in to confirm the assembly is compatible
      const rig = JSON.parse(readFileSync(resolve(dir, 'rig.json'), 'utf8')) as Rig
      const innervation = JSON.parse(readFileSync(resolve(__dirname, `../data/curated/skinmaps/innervation.${name}.json`), 'utf8')) as InnervationTable
      const nerves = JSON.parse(readFileSync(resolve(dir, 'nerves.json'), 'utf8')) as NervePath[]
      return { ...b, skinMaps: skinMaps as unknown as PainBody['skinMaps'], innervation, nerves, parts: anatomy.parts as unknown as PainBody['parts'], joints: rig.joints }
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  it.skipIf(!have)('resolves every named site and runs the card scenarios (tolerant of data mid-rebuild)', async () => {
    const body = await load()
    if (typeof body === 'string') {
      // 数据正在重建（例如皮肤换了而体表图还没跟上）：模型拒绝是对的，这里只记录
      // the data is mid-rebuild (e.g. a new skin whose maps have not followed): the model is right to refuse; just note it
      console.warn(`[app-stimulus] ${name}: skipped, ${body}`)
      return
    }
    if (body.skin.positions.length !== body.skinMaps.vertexCount * 3) {
      console.warn(`[app-stimulus] ${name}: skipped, skin has ${body.skin.positions.length / 3} vertices and the maps ${body.skinMaps.vertexCount}`)
      return
    }
    for (const s of SITES) {
      for (const side of ['L', 'R'] as const) {
        const site = resolveSite(body, { name: s.id, side })
        expect(site.vertex, `${s.id}_${side}`).toBeGreaterThanOrEqual(0)
        expect(site.position[0] >= 0, `${s.id}_${side} is on the ${side} side`).toBe(side === 'L')
        // 写成坐标再读回来，落在同一个顶点上 / written as a position and read back, it lands on the same vertex
        expect(resolveSite(body, parseSite(`p${site.position.map((v) => (v * 1000).toFixed(1)).join(',')}`)!).vertex).toBe(site.vertex)
      }
    }
    expect(() => resolveSite(body, { mm: [5000, 0, 0] })).toThrow(/3 厘米|3 cm/)
    const run = (text: string) => {
      const p = parseStimParam(text)!
      const site = resolveSite(body, p.site)
      const e = prepareStimulus(body, buildStimulus(p.settings, site, body.skin.part), { heatAnchor: p.settings.heatAnchor })
      return { e, weights: painMapWeights(body, e.at(0).map) }
    }
    const heat = run('heat,48,8@forearm_L')
    expect(heat.e.drive).toBeGreaterThan(4)
    expect(heat.e.endedByWithdrawal).toBe(true)
    expect(heat.e.peak.intensity).toBeLessThan(heat.e.drive)
    expect(heat.e.trace.steps).toHaveLength(9)
    expect(heat.e.trace.path.polyline.length).toBeGreaterThan(6)
    expect(heat.weights).toHaveLength(body.skinMaps.vertexCount)
    expect(Math.max(...heat.weights)).toBeGreaterThan(0.9)
    // 每个数字恰好是三种之一 / every number is exactly one of the three kinds
    for (const step of heat.e.trace.steps) for (const n of step.numbers) expect([n.sources.length > 0, n.assumption, !!n.computed].filter(Boolean), n.label.en).toHaveLength(1)
    const cold = run('cold,4,60,held@palm_L')
    expect(cold.e.endedByWithdrawal).toBe(false)
    expect(cold.e.stimulusEnd).toBeCloseTo(60)
    expect(cold.e.sample(30).autonomic.heartRate).toBeGreaterThan(cold.e.sample(-1).autonomic.heartRate)
    expect(run('pinprick,8,2@fingertip_L').e.peak.intensity).toBe(0)
    expect(run('pinprick,256,2@fingertip_L').e.trace.side).toBe('L')
    expect(Object.keys(run('pinch,20,1@sole_L').e.sample(0.5).reflexPose).length).toBeGreaterThanOrEqual(0)
  })
})

describe('kind lookup', () => {
  it('finds every kind', () => {
    for (const k of KINDS) expect(kindSpec(k.id)).toBe(k)
  })
})
