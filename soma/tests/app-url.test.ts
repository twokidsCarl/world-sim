// 深链接：查询参数的编解码往返，以及在示例数据上逐类恢复状态。
// Deep links: round trips of the query codec, and restoring each kind of state on the fixture.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { AnatomyGraph } from '../src/anatomy/graph.ts'
import { indexRig } from '../src/anatomy/rig.ts'
import { decodeSkinMaps } from '../src/anatomy/skinmaps.ts'
import type { AnatomyData, NameEntry, Relation, Rig, SkinMaps } from '../src/anatomy/types.ts'
import { setRigLoader, setSkinMapLoader, useApp } from '../src/state/store.ts'
import { resetUrlSync, resolveTokens, restoreFromUrl, setUrlCamera, snapshot } from '../src/state/urlSync.ts'
import { formatUrl, parseUrl, type UrlState } from '../src/state/urlState.ts'

describe('query codec', () => {
  const roundTrip = (q: string): string => formatUrl(parseUrl(q).state, parseUrl(q).passthrough)

  it.each([
    'sys=ske,ner:60',
    'peel=3',
    'iso=FMA7088,FJ3645&focus=1',
    'hide=FJ1,FJ2&sel=FMA9611&adj=1',
    'cam=0.5,1.25,2,0,1,0.1',
    'cut=a770',
    'cut=c500f',
    'xp=40',
    'pose=squat&breath=1',
    'pose=elbow_L.0:90,elbow_R.0:90,gh_L.1:-12.5',
    'map=n&reg=35,36&see=1',
    'src=1&cmp=ske',
    'body=female&embed=1&tab=p',
    'sys=ske&renderer=webgl&scene=meshes',
  ])('round-trips %s', (q) => {
    expect(roundTrip(q)).toBe(q)
    expect(parseUrl(q).warnings).toEqual([])
  })

  it('writes defaults as nothing and keeps a stable parameter order', () => {
    expect(formatUrl({ body: 'male', tab: 'display', peel: 0, xp: 0 })).toBe('')
    expect(formatUrl({ src: true, body: 'female', sys: [{ id: 'skeletal', opacity: 1 }], embed: true })).toBe('body=female&embed=1&sys=ske&src=1')
    expect(roundTrip('src=1&body=female&sys=ske')).toBe('body=female&sys=ske&src=1')
  })

  it('decodes values into state', () => {
    const s = parseUrl('?sys=ske,ner:60&cut=s250f&pose=elbow_L.0:90&cam=1,2,3,0,1,0&map=d&reg=3').state
    expect(s.sys).toEqual([{ id: 'skeletal', opacity: 1 }, { id: 'nervous', opacity: 0.6 }])
    expect(s.cut).toEqual({ axis: 'sagittal', position: 0.25, flip: true })
    expect((s.pose as { angles: Record<string, number[]> }).angles.elbow_L![0]).toBeCloseTo(Math.PI / 2)
    expect(s.cam).toEqual({ p: [1, 2, 3], t: [0, 1, 0] })
    expect([s.map, s.reg]).toEqual(['dermatome', [3]])
    expect(parseUrl('sys=').state.sys).toEqual([]) // 空列表 = 全部隐藏 / an empty list hides everything
  })

  it.each([
    ['body=martian', /body/],
    ['sys=ske,zzz,ner:900', /sys/],
    ['peel=-1', /peel/],
    ['peel=1.5', /peel/],
    ['xp=400', /xp/],
    ['cam=1,2,3', /cam/],
    ['cam=1,1,1,1,1,1', /cam/],
    ['cut=q10', /cut/],
    ['cut=a5000', /cut/],
    ['tab=x', /tab/],
    ['map=z', /map/],
    ['reg=3', /reg/],
    ['map=d&reg=a,b', /reg/],
    ['cmp=nope', /cmp/],
    ['embed=maybe', /embed/],
    ['sel=a b,<script>', /sel/],
    ['pose=elbow_L:90', /pose/],
  ])('ignores %s with a warning and never throws', (q, re) => {
    const r = parseUrl(q)
    expect(r.warnings.join(' ')).toMatch(re)
    expect(() => formatUrl(r.state)).not.toThrow()
  })

  it('keeps what is valid when part of a value is bad', () => {
    expect(parseUrl('sys=ske,zzz').state.sys).toEqual([{ id: 'skeletal', opacity: 1 }])
    expect(parseUrl('pose=elbow_L.0:90,garbage').state.pose).toEqual({ angles: { elbow_L: [Math.PI / 2] } })
    expect(parseUrl('%E0%A4%A=1&sys=ske').state.sys).toBeDefined()
  })
})

const dir = resolve(__dirname, '../public/anatomy/fixture')
describe.skipIf(!existsSync(resolve(dir, 'rig.json')))('restoring state on the fixture', () => {
  const read = <T>(f: string): T => JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as T
  const data = read<AnatomyData>('anatomy.json')
  const graph = () => new AnatomyGraph(data, read<Record<string, NameEntry>>('knowledge/names.json'), read<Relation[]>('knowledge/relations.json'))
  const id = (name: string): string => data.parts.find((p) => p.name === name)!.id
  const S = () => useApp.getState()
  const restore = async (q: string): Promise<{ warnings: string[]; state: UrlState }> => {
    const parsed = parseUrl(q)
    return { warnings: [...parsed.warnings, ...(await restoreFromUrl(parsed.state))], state: parsed.state }
  }
  /** 恢复之后再编码，应当得到同一个查询串 / encoding after a restore must give the same query back */
  const again = (): string => formatUrl(snapshot(S()))

  beforeEach(() => {
    resetUrlSync()
    setRigLoader(async () => {
      const raw = readFileSync(resolve(dir, 'rig.bin'))
      return { ok: true, rig: indexRig(read<Rig>('rig.json'), new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)) }
    })
    setSkinMapLoader(async () => {
      const raw = readFileSync(resolve(dir, 'skinmaps.bin'))
      return decodeSkinMaps(read<SkinMaps>('skinmaps.json'), raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    })
    // graph 置空：让 init 当作首次加载，不沿用上一个测试的状态
    // graph cleared so init treats this as a first load and carries nothing over from the previous test
    useApp.setState({ graph: null, pose: {}, posePreset: null, breathing: false, leftTab: 'display', skinMapMode: 'off', colorMode: 'tissue', explode: 0, embed: false, cameraRequest: null })
    S().setSection({ enabled: false, axis: 'axial', position: 0.6, flip: false })
    S().init(graph(), 'fixture')
    S().clearSelection()
    S().showAll()
  })

  it('systems and opacity', async () => {
    const { warnings } = await restore('body=fixture&sys=ske,ner:60')
    expect(warnings).toEqual([])
    expect(S().systems.skeletal).toEqual({ visible: true, opacity: 1 })
    expect(S().systems.nervous).toEqual({ visible: true, opacity: 0.6 })
    expect(S().systems.muscular!.visible).toBe(false)
    expect(again()).toBe('body=fixture&sys=ske,ner:60')
  })

  it('peel (clamped to the layers the body has) and explode', async () => {
    await restore('body=fixture&peel=2&xp=40')
    expect([S().peel, S().explode]).toEqual([2, 0.4])
    expect(again()).toBe('body=fixture&peel=2&xp=40')
    await restore('peel=40')
    expect(S().peel).toBe(data.layers.length - 1)
  })

  it('selection by part ids and by one concept id', async () => {
    await restore(`body=fixture&sel=${id('Left femur')},${id('Heart')}`)
    expect([...S().selection.ids].sort()).toEqual([id('Left femur'), id('Heart')].sort())
    expect(again()).toBe(`body=fixture&sel=${id('Left femur')},${id('Heart')}`)
    const femur = data.trees.isa.find((c) => c.name === 'Femur')!.id
    await restore(`body=fixture&sel=${femur}`)
    expect(S().selection.concept).toEqual({ tree: 'isa', id: femur })
    expect(S().selection.ids).toHaveLength(2)
    expect(again()).toBe(`body=fixture&sel=${femur}`)
  })

  it('isolate and hide by concept or part, written back in the form they came in', async () => {
    const femur = data.trees.isa.find((c) => c.name === 'Femur')!.id
    const q = `body=fixture&iso=${femur},${id('Heart')}&hide=${id('Skin')}`
    const { warnings } = await restore(q)
    expect(warnings).toEqual([])
    expect([...S().isolated!].sort()).toEqual([id('Left femur'), id('Right femur'), id('Heart')].sort())
    expect([...S().hidden]).toEqual([id('Skin')])
    expect(again()).toBe(q)
    // 改动之后不再沿用原来的标记，改写成部件 id / once changed, the original tokens are dropped for part ids
    S().isolateSelection()
    useApp.setState({ isolated: new Set([id('Heart')]) })
    expect(again()).toBe(`body=fixture&iso=${id('Heart')}&hide=${id('Skin')}`)
  })

  it('reports ids that are not in this body and carries on', async () => {
    const { warnings } = await restore(`body=fixture&sel=NOPE123&iso=ALSO_NOPE,${id('Heart')}`)
    expect(warnings.join(' ')).toMatch(/NOPE123/)
    expect(warnings.join(' ')).toMatch(/ALSO_NOPE/)
    expect(S().selection.ids).toEqual([])
    expect([...S().isolated!]).toEqual([id('Heart')])
    expect(resolveTokens(graph(), ['x']).unknown).toEqual(['x'])
  })

  it('section plane, colour by source, adjacent mode, left tab', async () => {
    const q = 'body=fixture&tab=t&adj=1&cut=c400f&src=1'
    await restore(q)
    expect(S().section).toEqual({ enabled: true, axis: 'coronal', position: 0.4, flip: true })
    expect([S().colorMode, S().adjacentMode, S().leftTab]).toEqual(['source', true, 'tree'])
    expect(again()).toBe(q)
  })

  it('camera: restored as a request to the viewer, written back once known', async () => {
    await restore('body=fixture&cam=0.5,1.25,2,0,1,0.1')
    expect(S().cameraRequest).toMatchObject({ p: [0.5, 1.25, 2], t: [0, 1, 0.1] })
    expect(again()).toBe('body=fixture&cam=0.5,1.25,2,0,1,0.1')
    setUrlCamera({ p: [1.23456, 0, 0], t: [0, 0, 0] })
    expect(again()).toBe('body=fixture&cam=1.235,0,0,0,0,0')
    setUrlCamera(undefined)
    expect(again()).toBe('body=fixture')
  })

  it('focus: frames the selection, and stays in the URL until the camera is reported', async () => {
    const n = S().focusRequest.nonce
    await restore(`body=fixture&sel=${id('Heart')}&focus=1`)
    expect(S().focusRequest.nonce).toBe(n + 1)
    expect(again()).toBe(`body=fixture&sel=${id('Heart')}&focus=1`)
    setUrlCamera({ p: [0, 1, 1], t: [0, 1, 0] })
    expect(again()).toBe(`body=fixture&sel=${id('Heart')}&cam=0,1,1,0,1,0`)
  })

  it('pose preset, explicit joint angles (clamped) and breathing load the rig by themselves', async () => {
    const { warnings } = await restore('body=fixture&pose=elbow90&breath=1')
    expect(warnings).toEqual([])
    expect(S().rigStatus).toBe('ready')
    expect(S().posePreset).toBe('elbow90')
    expect(S().breathing).toBe(true)
    expect(again()).toBe('body=fixture&pose=elbow90&breath=1')
    await restore('body=fixture&pose=elbow_L.0:45,gh_L.1:999')
    expect(S().posePreset).toBeNull()
    expect(S().pose.elbow_L![0]).toBeCloseTo(Math.PI / 4)
    expect(S().pose.gh_L![1]).toBeCloseTo(2.6) // 夹到活动范围 / clamped to the range of motion
    expect(again()).toMatch(/^body=fixture&pose=elbow_L\.0:45,gh_L\.1:149(\.\d)?&breath=1$/)
    const bad = await restore('body=fixture&pose=moonwalk')
    expect(bad.warnings.join(' ')).toMatch(/moonwalk/)
    const badJoint = await restore('body=fixture&pose=tail.0:30')
    expect(badJoint.warnings.join(' ')).toMatch(/tail/)
  })

  it('skin map, highlighted regions, see-through skin and a selected nerve together', async () => {
    const nerve = id('Left ulnar nerve')
    const q = `body=fixture&sel=${nerve}&map=n&reg=0&see=1`
    const { warnings } = await restore(q)
    expect(warnings).toEqual([])
    expect([S().skinMapMode, S().skinRegions, S().skinSeeThrough]).toEqual(['cutaneousNerve', [0], true])
    expect(S().selection.ids).toEqual([nerve])
    expect(again()).toBe(q)
    const out = await restore('body=fixture&map=d&reg=99')
    expect(out.warnings.join(' ')).toMatch(/reg/)
    expect(S().skinRegions).toEqual([])
  })

  it('compare view remembers the toggles from before it', async () => {
    await restore('body=fixture&sys=ske,mus&cmp=ske')
    expect(S().compare).toEqual({ system: 'skeletal' })
    // 系统按人体数据里的顺序写出 / systems are written in the body's own order
    expect(again()).toBe('body=fixture&sys=mus,ske&cmp=ske')
    const none = await restore('body=fixture&cmp=lym')
    expect(none.warnings.join(' ')).toMatch(/cmp/)
  })

  it('embed mode never opens the cautions dialog', () => {
    useApp.setState({ embed: true })
    S().init(graph(), 'fixture')
    expect(graph().cautions.length).toBeGreaterThan(0)
    expect(S().cautionsOpen).toBe(false)
    expect(formatUrl(snapshot(S()))).toBe('body=fixture&embed=1')
  })
})
