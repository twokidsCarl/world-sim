// "腔"显示的纯逻辑：充盈位移、顶点圈与中心线、体积、漫游路径、地址参数；后半部分用男性的真实数据核对。
// The pure logic of the lumina display: filling displacement, rings and centrelines, volume, the fly-through
// path and the URL parameters; the second half checks them against the male body's real data.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AnatomyData } from '../src/anatomy/types.ts'
import {
  ORIGIN_BOUNDED,
  ORIGIN_CONSTRUCTION,
  ORIGIN_DERIVED,
  ORIGIN_MIXED,
  applyFilling,
  boundaryLoops,
  buildCanalPath,
  closedVolume,
  formatLumenParams,
  isZeroDisplacement,
  originOf,
  parseLumenParams,
  partFilling,
  pathPoint,
  radiusAt,
  ringStations,
  ringsOf,
  segmentAt,
  segmentKey,
  type FillingEntry,
  type PathSegmentInput,
  widenRings,
  type V3,
} from '../src/lumen/core.ts'
import { extractLumenPath, type LumenPathFile } from '../tools/lumenview/extract.ts'
import { readGlbParts, type RawMesh } from '../tools/skinmaps/io.ts'

/** 沿 +y 的一段管：rings 圈、每圈 sides 个顶点；可以把两端各用一个极点封上 / A tube along +y: `rings` rings of `sides` vertices; either end can be closed by a pole. */
function tube(rings: number, sides: number, radius: (k: number) => number, opts: { poleStart?: boolean; poleEnd?: boolean; spacing?: number } = {}): { position: Float32Array; index: Uint32Array } {
  const h = opts.spacing ?? 0.01
  const pos: number[] = []
  const idx: number[] = []
  for (let k = 0; k < rings; k++) {
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2
      pos.push(Math.cos(a) * radius(k), k * h, Math.sin(a) * radius(k))
    }
  }
  for (let k = 0; k + 1 < rings; k++) {
    for (let j = 0; j < sides; j++) {
      const a = k * sides + j, b = k * sides + ((j + 1) % sides), c = a + sides, d = b + sides
      // 法线朝外 / outward normals
      idx.push(a, c, b, b, c, d)
    }
  }
  if (opts.poleStart) {
    const p = pos.length / 3
    pos.push(0, -h, 0)
    for (let j = 0; j < sides; j++) idx.push(p, j, (j + 1) % sides)
  }
  if (opts.poleEnd) {
    const p = pos.length / 3
    const o = (rings - 1) * sides
    pos.push(0, rings * h, 0)
    for (let j = 0; j < sides; j++) idx.push(p, o + ((j + 1) % sides), o + j)
  }
  return { position: Float32Array.from(pos), index: Uint32Array.from(idx) }
}

/** 把顶点打乱（模拟写 GLB 时的重排）/ Shuffle the vertices (as writing a GLB reorders them). */
function shuffled(mesh: { position: Float32Array; index: Uint32Array }): { position: Float32Array; index: Uint32Array } {
  const n = mesh.position.length / 3
  const to = Array.from({ length: n }, (_, i) => (i * 5 + 3) % n)
  const position = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) position[to[i]! * 3 + c] = mesh.position[i * 3 + c]!
  return { position, index: mesh.index.map((v) => to[v]!) }
}

describe('filling', () => {
  it('maps the global control to each part by its rest filling', () => {
    expect(partFilling(0, 0)).toBe(0)
    expect(partFilling(0.5, 0)).toBe(0.5)
    expect(partFilling(1, 0)).toBe(1)
    // 静止时就满的部件不随全局量变 / a part full at rest does not follow the global control
    expect(partFilling(0, 1)).toBe(1)
    expect(partFilling(0.3, 1)).toBe(1)
    expect(partFilling(0.5, 0.2)).toBeCloseTo(0.6, 12)
    // 个别部件自己的值优先，并夹在 0–1 之间 / a per-part value wins and is clamped to 0–1
    expect(partFilling(0.9, 1, 0.25)).toBe(0.25)
    expect(partFilling(0, 0, 3)).toBe(1)
  })

  it('applies position(f) = base + (f − rest)·D and returns the base at f = rest', () => {
    const base = Float32Array.from([1, 2, 3, 4, 5, 6])
    const d = Float32Array.from([0.5, 0, -1, 0, 2, 0])
    const out = new Float32Array(6)
    expect([...applyFilling(base, d, 0.25, 0.25, out)]).toEqual([...base])
    expect([...applyFilling(base, d, 1, 0, out)]).toEqual([1.5, 2, 2, 4, 7, 6])
    // rest = 1 的部件往回收 / a part whose rest is 1 is drawn in
    expect([...applyFilling(base, d, 0, 1, out)]).toEqual([0.5, 2, 4, 4, 3, 6])
    expect(isZeroDisplacement(new Float32Array(9))).toBe(true)
    expect(isZeroDisplacement(d)).toBe(false)
  })
})

describe('rings, centreline and volume of a tube', () => {
  it('orders the vertices of an open tube into rings whatever the vertex order', () => {
    const m = shuffled(tube(9, 16, () => 0.01))
    expect(boundaryLoops(m.index, 144).map((l) => l.length)).toEqual([16, 16])
    const r = ringsOf(m.index, 144)!
    expect(r.rings.length).toBe(9)
    expect(r.poleStart).toBeNull()
    expect(r.poleEnd).toBeNull()
    const st = ringStations(r.rings, m.position)
    // 质心在轴上，间隔 10 毫米，半径 10 毫米；两种走向都可以 / centroids on the axis, 10 mm apart, radius 10 mm; either direction
    const ys = st.map((s) => s.c[1])
    const dir = Math.sign(ys[1]! - ys[0]!)
    for (let k = 0; k < st.length; k++) {
      expect(st[k]!.c[0]).toBeCloseTo(0, 6)
      expect(st[k]!.c[2]).toBeCloseTo(0, 6)
      expect(st[k]!.r).toBeCloseTo(0.01, 6)
      if (k > 0) expect((ys[k]! - ys[k - 1]!) * dir).toBeCloseTo(0.01, 6)
    }
  })

  it('finds the pole of a blind end and starts a doubly closed tube at a pole', () => {
    const sac = shuffled(tube(6, 16, () => 0.01, { poleEnd: true }))
    const a = ringsOf(sac.index, 97)!
    expect(a.rings.length).toBe(6)
    expect(a.poleStart).toBeNull()
    expect(a.poleEnd).not.toBeNull()
    const closed = shuffled(tube(6, 16, () => 0.01, { poleStart: true, poleEnd: true }))
    const b = ringsOf(closed.index, 98)!
    expect(b.rings.length).toBe(6)
    expect(b.poleStart).not.toBeNull()
    expect(b.poleEnd).not.toBeNull()
  })

  it('refuses a mesh that is not rings (a tetrahedron, a tube with a missing triangle)', () => {
    expect(ringsOf(Uint32Array.from([0, 1, 2, 0, 3, 1, 1, 3, 2, 2, 3, 0]), 4)).toBeNull()
    const m = tube(5, 16, () => 0.01)
    expect(ringsOf(m.index.slice(3), 80)).toBeNull()
  })

  it('closes an open tube with fans at its end rings to get the volume', () => {
    const r = 0.01, len = 0.08
    const m = shuffled(tube(9, 16, () => r))
    const v = closedVolume(m.position, m.index)
    expect(v.openLoops).toBe(2)
    // 内接十六边形柱：面积 = ½·n·r²·sin(2π/n) / the inscribed 16-gon prism
    const exact = 0.5 * 16 * r * r * Math.sin((2 * Math.PI) / 16) * len
    expect(v.volume / exact).toBeCloseTo(1, 5)
    // 封闭的网格不需要补 / a closed mesh needs no caps
    const c = tube(9, 16, () => r, { poleStart: true, poleEnd: true })
    const vc = closedVolume(c.position, c.index)
    expect(vc.openLoops).toBe(0)
    expect(vc.volume).toBeGreaterThan(exact)
    // 不依赖坐标原点 / independent of where the origin is
    const moved = m.position.map((x, i) => x + [3, -2, 5][i % 3]!)
    expect(closedVolume(moved, m.index).volume / exact).toBeCloseTo(1, 3)
  })
})

describe('the widening used by the fly-through', () => {
  it('pushes only the vertices nearer the ring centre than the minimum out to it', () => {
    // 中间细到 1 毫米的管 / a tube pinched to 1 mm in the middle
    const m = tube(5, 16, (k) => (k === 2 ? 0.001 : 0.006))
    const before = Float32Array.from(m.position)
    const r = ringsOf(m.index, 80)!
    const moved = widenRings(m.position, r.rings, 0.003)
    expect(moved).toBe(16)
    const st = ringStations(r.rings, m.position)
    expect(Math.min(...st.map((s) => s.rMin))).toBeCloseTo(0.003, 6)
    // 够宽的圈一点不动，圈心也不动 / rings wide enough are untouched and no centre moves
    for (let v = 0; v < 80; v++) if (v < 32 || v >= 48) for (let c = 0; c < 3; c++) expect(m.position[v * 3 + c]).toBe(before[v * 3 + c])
    for (const s of st) expect(Math.hypot(s.c[0], s.c[2])).toBeLessThan(1e-6)
  })
})

describe('origin of a lumen part from its composition', () => {
  const what = (en: string): { en: string } => ({ en })
  it('classes whole parts and calls a sizeable share of construction mixed', () => {
    expect(originOf([{ provenance: 'curated', vertices: 1120, what: what('outer surface of 1 wall part(s) offset inward by 1.6 mm') }]).kind).toBe(ORIGIN_DERIVED)
    expect(originOf([{ provenance: 'construction', vertices: 160 }]).kind).toBe(ORIGIN_CONSTRUCTION)
    expect(originOf([{ provenance: 'curated', vertices: 848, what: what('outer surface …') }, { provenance: 'construction', vertices: 1 }]).kind).toBe(ORIGIN_DERIVED)
    const oral = originOf([{ provenance: 'curated', vertices: 5228, what: what('bounded by the surfaces of the real parts around it') }, { provenance: 'construction', vertices: 1066 }])
    expect(oral.kind).toBe(ORIGIN_MIXED)
    expect(oral.constructionShare).toBeCloseTo(1066 / 6294, 6)
    expect(originOf([{ provenance: 'curated', vertices: 990, what: what('bounded by the surfaces …') }, { provenance: 'construction', vertices: 10 }]).kind).toBe(ORIGIN_BOUNDED)
    expect(originOf(undefined).kind).toBe(ORIGIN_DERIVED)
  })
})

describe('the fly-through path', () => {
  const line = (from: V3, to: V3, n: number, r: number) => Array.from({ length: n }, (_, k) => ({ c: [0, 1, 2].map((a) => from[a]! + ((to[a]! - from[a]!) * k) / (n - 1)) as V3, r, rMin: r }))

  it('orients tubes by the previous exit, enters a sac from the side and skips its blind end', () => {
    const inputs: PathSegmentInput[] = [
      { id: 'guide', guide: [[0, 0.1, 0], [0, 0.05, 0]] },
      // 给反了的管：末端离上一段出口近 / a tube given backwards: its last station is nearer the previous exit
      { id: 'tube', stations: line([0, -0.1, 0], [0, 0.04, 0], 15, 0.004) },
      // 囊：盲端在 x = −0.03，出口在 x = +0.07，管从 x = 0 处侧面进来 / a sac: blind end at x = −0.03, outlet at x = +0.07, entered from the side at x = 0
      { id: 'sac', stations: line([0.07, -0.12, 0], [-0.03, -0.12, 0], 11, 0.02), poleEnd: true },
    ]
    const path = buildCanalPath(inputs, 0.001)!
    expect(path.segments.map((s) => s.id)).toEqual(['guide', 'tube', 'sac'])
    // 0.05 的引导线 + 0.01 的空隙 + 0.14 的管 + 0.02 的侧向进入 + 囊里从 x = 0 到 0.07
    // 0.05 of guide + a 0.01 gap + 0.14 of tube + 0.02 across into the sac + the sac from x = 0 to 0.07
    expect(path.length).toBeCloseTo(0.05 + 0.01 + 0.14 + 0.02 + 0.07, 6)
    expect(path.segments[1]!.bridged).toBeCloseTo(0.01, 6)
    expect(path.segments[2]!.bridged).toBeCloseTo(0.02, 6)
    const end = pathPoint(path, path.length)
    expect(end[0]).toBeCloseTo(0.07, 5)
    // 盲端（x < 0）不在路径上 / the blind end (x < 0) is not on the path
    for (let i = 0; i < path.seg.length; i++) expect(path.points[i * 3]!).toBeGreaterThan(-1e-6)
    expect(segmentAt(path, 0.02)).toBe(0)
    expect(segmentAt(path, 0.1)).toBe(1)
    expect(segmentAt(path, path.length)).toBe(2)
    // 段的起止首尾相接 / segment ranges tile the path
    expect(path.segments[0]!.start).toBe(0)
    for (let k = 1; k < 3; k++) expect(path.segments[k]!.start).toBeCloseTo(path.segments[k - 1]!.end, 9)
    expect(path.segments[2]!.end).toBeCloseTo(path.length, 9)
    expect(radiusAt(path, 0.02)).toBe(0)
    expect(radiusAt(path, 0.12)).toBeCloseTo(0.004, 6)
    expect(buildCanalPath([{ id: 'empty' }])).toBeNull()
  })
})

describe('URL parameters lumen / fill / fly', () => {
  it('parses and formats them', () => {
    const a = parseLumenParams('?lumen=1&fill=0.5,LUMEN_stomach:1&fly=esophagus')
    expect(a.warnings).toEqual([])
    expect(a.params).toEqual({ mode: true, canal: false, fill: 0.5, overrides: { LUMEN_stomach: 1 }, fly: { at: 'esophagus' } })
    expect(formatLumenParams(a.params)).toEqual({ lumen: '1', fill: '0.5,LUMEN_stomach:1', fly: 'esophagus' })
    expect(parseLumenParams('?fly=420').params.fly).toEqual({ at: 420 })
    expect(parseLumenParams('?fly=1').params.fly).toEqual({ at: 0 })
    expect(parseLumenParams('?fill=LUMEN_stomach:0.25').params).toMatchObject({ fill: 0, overrides: { LUMEN_stomach: 0.25 } })
    expect(parseLumenParams('').params).toEqual({ mode: false, canal: false, fill: 0, overrides: {}, fly: null })
    const c = parseLumenParams('?lumen=canal').params
    expect(c).toMatchObject({ mode: true, canal: true })
    expect(formatLumenParams(c).lumen).toBe('canal')
    expect(formatLumenParams(parseLumenParams('').params)).toEqual({ lumen: null, fill: null, fly: null })
  })

  it('ignores invalid values with a warning', () => {
    const b = parseLumenParams('?lumen=yes&fill=2,x:-1,0.3&fly=a/b')
    expect(b.params).toEqual({ mode: false, canal: false, fill: 0.3, overrides: {}, fly: null })
    expect(b.warnings.length).toBe(4)
  })

  it('derives short segment keys from the part names', () => {
    expect(segmentKey('Lumen of esophagus')).toBe('esophagus')
    expect(segmentKey('Cavity of stomach')).toBe('stomach')
    expect(segmentKey('Oral cavity proper')).toBe('oral_cavity')
    expect(segmentKey('Lumen of ascending colon')).toBe('ascending_colon')
  })
})

// ------------------------------------------------------------ 真实数据 / the real data

const DIR = process.env.SOMA_MALE_DIR ?? join(import.meta.dirname, '../public/anatomy/male')
const HAS = existsSync(join(DIR, 'lumen-filling.json')) && existsSync(join(DIR, 'pipeline-report.json'))

describe.skipIf(!HAS)('the male body: lumen data as the viewer uses it', () => {
  let entries: FillingEntry[] = []
  let bin = new Float32Array(0)
  let meshes = new Map<string, RawMesh>()
  let report: { lumen: { canal: { groups: { lumen: string; centrelineMm: number; volumeCm3: { rest: number; full: number } }[] }; organs: { lumen: string; volumeCm3: { atF: number[] } }[] } }
  let sidecar: LumenPathFile
  let data: AnatomyData
  const filled = (id: string, f: number): Float32Array => {
    const e = entries.find((x) => x.part === id)!
    const d = bin.subarray(e.offset / 4, e.offset / 4 + e.vertices * 3)
    return applyFilling(meshes.get(id)!.positions, d, f, e.rest, new Float32Array(e.vertices * 3))
  }

  beforeAll(async () => {
    data = JSON.parse(readFileSync(join(DIR, 'anatomy.json'), 'utf8')) as AnatomyData
    entries = (JSON.parse(readFileSync(join(DIR, 'lumen-filling.json'), 'utf8')) as { parts: FillingEntry[] }).parts
    const raw = readFileSync(join(DIR, 'lumen-filling.bin'))
    bin = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
    report = JSON.parse(readFileSync(join(DIR, 'pipeline-report.json'), 'utf8'))
    sidecar = extractLumenPath('male', report as never)!
    const ids = new Set(entries.map((e) => e.part))
    for (const sys of new Set(data.parts.filter((p) => ids.has(p.id)).map((p) => p.system))) {
      for (const [id, m] of await readGlbParts(join(DIR, `${sys}.glb`), ids)) meshes.set(id, m)
    }
  })

  it('finds every lumen part by tissue and filling entry, with matching vertex counts', () => {
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      const part = data.parts.find((p) => p.id === e.part)
      expect(part?.tissue, e.part).toBe('space')
      expect(meshes.get(e.part)!.positions.length, e.part).toBe(e.vertices * 3)
    }
  })

  it('the committed lumen-path.json is what the extraction gives now', () => {
    const file = join(DIR, 'lumen-path.json')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(sidecar) + '\n')
    expect(sidecar.canal.length).toBe(12)
    // 引导线只给没有顶点圈的两段 / guide lines only for the two segments without rings
    expect(Object.keys(sidecar.guides)).toEqual(sidecar.canal.slice(0, 2))
    for (const [lumen, walls] of Object.entries(sidecar.walls)) for (const w of walls) expect(data.parts.some((p) => p.id === w), `${lumen} wall ${w}`).toBe(true)
  })

  it('splits every canal segment but mouth and pharynx into rings of 16', () => {
    for (const id of sidecar.canal) {
      const m = meshes.get(id)!
      const r = ringsOf(m.indices, m.positions.length / 3)
      if (sidecar.guides[id]) expect(r, id).toBeNull()
      else {
        expect(r, id).not.toBeNull()
        for (const ring of r!.rings) expect(ring.length, id).toBe(16)
      }
    }
  })

  it('reproduces the report’s stomach and bladder volumes from the filling data', () => {
    const stomach = report.lumen.canal.groups.find((g) => g.lumen === 'LUMEN_stomach')!
    const m = meshes.get('LUMEN_stomach')!
    const rest = closedVolume(filled('LUMEN_stomach', 0), m.indices).volume * 1e6
    const full = closedVolume(filled('LUMEN_stomach', 1), m.indices).volume * 1e6
    // 封口的做法和量化不同，允许一成 / the caps and the quantisation differ, so within a tenth
    expect(rest / stomach.volumeCm3.rest).toBeGreaterThan(0.85)
    expect(rest / stomach.volumeCm3.rest).toBeLessThan(1.15)
    expect(full / stomach.volumeCm3.full).toBeGreaterThan(0.95)
    expect(full / stomach.volumeCm3.full).toBeLessThan(1.05)
    const bladder = report.lumen.organs.find((o) => o.lumen === 'LUMEN_urinary_bladder')!
    const b = meshes.get('LUMEN_urinary_bladder')!
    ;[0, 0.25, 0.5, 0.75, 1].forEach((f, k) => {
      const v = closedVolume(filled('LUMEN_urinary_bladder', f), b.indices).volume * 1e6
      expect(v / bladder.volumeCm3.atF[k]!, `f = ${f}`).toBeGreaterThan(0.9)
      expect(v / bladder.volumeCm3.atF[k]!, `f = ${f}`).toBeLessThan(1.1)
    })
  })

  it('builds one path from mouth to anus whose segment lengths agree with the report', () => {
    const inputs: PathSegmentInput[] = sidecar.canal.map((id) => {
      const guide = sidecar.guides[id]
      if (guide) return { id, guide: guide.map((p) => [p[0] / 1000, p[1] / 1000, p[2] / 1000] as V3) }
      const m = meshes.get(id)!
      const r = ringsOf(m.indices, m.positions.length / 3)!
      return { id, stations: ringStations(r.rings, m.positions), poleStart: r.poleStart !== null, poleEnd: r.poleEnd !== null }
    })
    const path = buildCanalPath(inputs)!
    expect(path.segments.map((s) => s.id)).toEqual(sidecar.canal)
    // 从口（高、靠前）到肛门（低、靠后）/ from the mouth (high, anterior) to the anus (low, posterior)
    expect(path.points[1]!).toBeGreaterThan(1.4)
    expect(path.points[path.points.length - 2]!).toBeLessThan(0.8)
    // 报告的总长把两个囊的盲端也算在内，这里不走盲端，所以略短 / the report counts the blind ends of the two sacs, which the path skips, so it is a little shorter
    expect(path.length).toBeGreaterThan(3.0)
    expect(path.length).toBeLessThan(3.5)
    for (const g of report.lumen.canal.groups) {
      const s = path.segments.find((x) => x.id === g.lumen)!
      const mm = (s.end - s.start - s.bridged) * 1000
      // 有顶点圈、两端开口的各段应与报告的中心线长度相近 / ringed segments open at both ends should match the report's centreline length
      if (['LUMEN_esophagus', 'LUMEN_duodenum', 'LUMEN_jejunum', 'LUMEN_ileum', 'LUMEN_transverse_colon', 'LUMEN_descending_colon', 'LUMEN_rectum'].includes(g.lumen)) {
        expect(mm / g.centrelineMm, g.lumen).toBeGreaterThan(0.93)
        expect(mm / g.centrelineMm, g.lumen).toBeLessThan(1.07)
      }
    }
    // 相邻两段之间直接连过去的长度：都不到 60 毫米 / what is bridged between consecutive segments stays under 60 mm each
    for (const s of path.segments) expect(s.bridged, s.id).toBeLessThan(0.06)
  })
})
