// 数据里没有、按已知结构推断补上的部分 / parts absent from the data, filled in by inference from known structures
import { describe, expect, it } from 'vitest'
import { fibonacciSphere, frameToFrame, helicalLayer, layerOnSphere, principalAxis, rnpBundle, SEGMENTS, shell } from '../src/infer/influenza'
import { El, IDENTITY, type Molecule } from '../src/mol/types'

const mol = (pos: number[], operators: Float32Array[] = [IDENTITY]): Molecule => {
  const n = pos.length / 3
  return {
    id: 'x', title: 'x', atomCount: n, pos: new Float32Array(pos), element: new Uint8Array(n).fill(El.C), chainOf: new Uint32Array(n), isTrace: new Uint8Array(n), residue: new Int32Array(n).fill(1),
    chains: [{ asymId: 'A', authAsymId: 'A', entity: 0, start: 0, count: n, model: 1 }], entities: [{ id: '1', description: 'p', kind: 'protein' }],
    assemblies: [{ id: '1', groups: [{ chains: [0], operators }] }],
  }
}
const at = (m: Float32Array, p: number[]) => [m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!, m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!, m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!]

describe('inferred placement', () => {
  it('finds the long axis of a rod and its extent', () => {
    const pts: number[] = []
    for (let i = 0; i <= 100; i++) pts.push(5 + i * 0.6, 2 + i * 0.8, 1 + Math.sin(i) * 0.3)
    const a = principalAxis(pts)
    expect(Math.abs(a.axis[0] * 0.6 + a.axis[1] * 0.8)).toBeGreaterThan(0.999)
    expect(a.max - a.min).toBeGreaterThan(99)
    expect(a.max - a.min).toBeLessThan(101)
  })

  it('carries one frame onto another as a rigid motion', () => {
    const m = frameToFrame([1, 2, 3], [1, 0, 0], [0, 1, 0], [0, 0, 1], [10, 0, 0], [0, 1, 0], [-1, 0, 0], [0, 0, 1])
    expect(at(m, [1, 2, 3])).toEqual([10, 0, 0])
    // 局部的 x 方向变成 +y / the local x direction becomes +y
    expect(at(m, [2, 2, 3]).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([10, 1, 0])
    const det = m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) + m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!)
    expect(det).toBeCloseTo(1, 6)
  })

  it('measures area per copy and the outward direction from a helical arrangement', () => {
    // 半径 100、每转 20 个、每个升 2 的螺旋：每个拷贝的面积 = 2π·100·(60·2)/60 = 2π·100·2
    // a helix of radius 100 with 20 copies a turn rising 2 each: area per copy = 2π·100·(60·2)/60 = 2π·100·2
    const ops: Float32Array[] = []
    for (let k = 0; k < 60; k++) {
      const a = (k / 20) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a)
      ops.push(new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, k * 2, 1]))
    }
    // 单个拷贝在 x = 100 附近，沿 x 伸出一点 / the single copy sits near x = 100, reaching out a little along x
    const layer = helicalLayer(mol([98, 0, 0, 100, 0, 0, 102, 0, 0], ops), '1')
    expect(layer.radius).toBeCloseTo(100, 3)
    expect(layer.area / (2 * Math.PI * 100 * 2)).toBeCloseTo(1, 2)
    expect(layer.outward[0]).toBeGreaterThan(0.999)
    expect(Math.abs(layer.along[1])).toBeGreaterThan(0.999)
  })

  it('covers the inside of a sphere at that density, every copy facing out', () => {
    const layer = { area: 1000, origin: [0, 0, 0] as [number, number, number], outward: [1, 0, 0] as [number, number, number], along: [0, 1, 0] as [number, number, number], radius: 100 }
    const R = 300
    const ops = layerOnSphere(layer, [5, 6, 7], R)
    expect(ops.length).toBe(Math.round((4 * Math.PI * R * R) / 1000))
    for (const m of ops.filter((_, i) => i % 37 === 0)) {
      const c = at(m, [0, 0, 0]), tip = at(m, [1, 0, 0])
      const d = [c[0]! - 5, c[1]! - 6, c[2]! - 7]
      expect(Math.hypot(...d)).toBeCloseTo(R, 3)
      // “朝外”的方向沿半径 / the "outward" direction runs along the radius
      expect(((tip[0]! - c[0]!) * d[0]! + (tip[1]! - c[1]!) * d[1]! + (tip[2]! - c[2]!) * d[2]!) / R).toBeCloseTo(1, 5)
    }
    const pts = fibonacciSphere(500)
    expect(Math.abs(pts.reduce((s, p) => s + p[1], 0))).toBeLessThan(1e-9)
  })

  it('bundles eight parallel rods that stay inside the cavity, and says how much was cut', () => {
    // 一段长 400、半径约 70 的杆；聚合酶是个小球 / a stretch 400 long and about 70 in radius; the polymerase is a small blob
    const rod: number[] = []
    for (let i = 0; i <= 40; i++) for (let k = 0; k < 6; k++) rod.push(Math.cos(k) * 70, Math.sin(k) * 70, i * 10)
    const blob: number[] = []
    for (let i = 0; i < 30; i++) blob.push(Math.cos(i) * 40, Math.sin(i * 1.7) * 40, Math.sin(i) * 60)
    const cavity = 420
    const b = rnpBundle(mol(rod), mol(blob), [0, 0, 0], cavity, [0, 1, 0], 616)
    expect(b.rods.length).toBe(8)
    expect(b.polymerases.length).toBe(8)
    expect(b.rods.reduce((s, r) => s + r.wanted, 0)).toBe(SEGMENTS.reduce((s, nt) => s + Math.max(1, Math.round(nt / 616)), 0))
    expect(b.stretches.length).toBe(b.rods.reduce((s, r) => s + r.placed, 0))
    for (const r of b.rods) expect(r.placed).toBeLessThanOrEqual(r.wanted)
    // 每一段的两端都在空腔里；杆沿 y / both ends of every stretch are inside the cavity; rods run along y
    for (const m of b.stretches) {
      const a = at(m, [0, 0, 0]), z = at(m, [0, 0, 400])
      expect(Math.hypot(...a)).toBeLessThan(cavity)
      expect(Math.hypot(...z)).toBeLessThan(cavity)
      expect(Math.abs(z[1]! - a[1]!)).toBeCloseTo(400, 3)
    }
    // 聚合酶在各自的杆的上方 / each polymerase sits above its rod
    const tops = b.stretches.map((m) => Math.max(at(m, [0, 0, 0])[1]!, at(m, [0, 0, 400])[1]!))
    for (const m of b.polymerases) expect(at(m, [0, 0, 0])[1]!).toBeGreaterThan(Math.min(...tops))
  })

  it('finds the centre and inner radius of a membrane from its spheres', () => {
    const pos: number[] = []
    for (const p of fibonacciSphere(4000)) for (const r of [400, 420, 440]) pos.push(10 + p[0] * r, 20 + p[1] * r, 30 + p[2] * r)
    const s = shell(new Float32Array(pos), 0, pos.length / 3)
    expect(s.centre.map((v) => Math.round(v))).toEqual([10, 20, 30])
    expect(s.inner).toBeCloseTo(400, 0)
    expect(s.outer).toBeCloseTo(440, 0)
  })
})

describe('an orderly arrangement of membrane proteins', () => {
  it('lays sites in rings about the viewing direction, evenly spaced, the middle ring just behind the equator', async () => {
    const { ringSites } = await import('../src/infer/idealise')
    for (const n of [41, 120, 266]) {
      const sites = ringSites(n, [0, 0, 1])
      expect(sites.length).toBe(n)
      for (const s of sites) expect(Math.hypot(...s)).toBeCloseTo(1, 6)
      // 最近邻的间距处处相近 / nearest-neighbour spacing is about the same everywhere
      const nn = sites.map((a, i) => Math.min(...sites.map((b, j) => (i === j ? 9 : Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])))))
      const mean = nn.reduce((s, v) => s + v, 0) / nn.length
      expect(Math.min(...nn)).toBeGreaterThan(mean * 0.6)
      expect(Math.max(...nn)).toBeLessThan(mean * 1.5)
      // 赤道那一圈：z 略小于 0，所以沿赤道从正面剖开时它整圈都在切片里；圈上等间隔
      // the equatorial ring: z a little below 0, so a cut from the front along the equator keeps all of it; evenly spaced round the ring
      const ring = sites.filter((s) => Math.abs(s[2] + 0.02) < 0.01)
      expect(ring.length).toBeGreaterThan(8)
      for (const s of ring) expect(s[2]).toBeLessThan(0)
      const angles = ring.map((s) => Math.atan2(s[1], s[0])).sort((a, b) => a - b)
      const gaps = angles.map((a, i) => (i ? a - angles[i - 1]! : a + 2 * Math.PI - angles[angles.length - 1]!))
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-6)
    }
  })

  it('groups chains into complexes, copies a complex out, and stands it upright at every site', async () => {
    const { complexes, placeTemplate, subMolecule, templateOf, chainCentre } = await import('../src/infer/idealise')
    // 两个“三聚体”：各三条沿某个方向伸出的短链；一条落单的链
    // two "trimers" of three short chains each, reaching out along some direction; and one stray chain
    const pos: number[] = [], chains: Molecule['chains'] = []
    const chain = (base: number[], dir: number[]) => {
      const start = pos.length / 3
      for (let i = 0; i < 20; i++) pos.push(base[0]! + dir[0]! * i, base[1]! + dir[1]! * i, base[2]! + dir[2]! * i)
      chains.push({ asymId: `c${chains.length}`, authAsymId: 'A', entity: 0, start, count: 20, model: 1 })
    }
    // 第一个直立在 +x 方向的球面上（半径 100），第二个斜着 / the first stands upright on a sphere of radius 100 towards +x, the second leans
    for (const off of [[0, 0, 0], [0, 6, 0], [0, 0, 6]]) chain([100 + off[0]!, off[1]!, off[2]!], [1, 0, 0])
    for (const off of [[0, 0, 0], [6, 0, 0], [0, 0, 6]]) chain([off[0]!, 100 + off[1]!, off[2]!], [0.6, 0.8, 0])
    chain([-500, 0, 0], [0, 1, 0])
    const n = pos.length / 3
    const m: Molecule = {
      id: 'x', title: 'x', atomCount: n, pos: new Float32Array(pos), element: new Uint8Array(n).fill(El.C), chainOf: new Uint32Array(n), isTrace: new Uint8Array(n), residue: new Int32Array(n).fill(1),
      chains, entities: [{ id: '1', description: 'spike', kind: 'protein' }], assemblies: [{ id: '1', groups: [{ chains: chains.map((_, i) => i), operators: [IDENTITY] }] }],
    }
    const groups = complexes(m, [0, 1, 2, 3, 4, 5, 6], 3, 30)
    expect(groups.map((g) => g.slice().sort())).toEqual([[0, 1, 2], [3, 4, 5]])
    const t0 = templateOf(m, groups[0]!, [0, 0, 0]), t1 = templateOf(m, groups[1]!, [0, 0, 0])
    expect(t0.tilt).toBeLessThan(2)
    expect(t1.tilt).toBeGreaterThan(20)
    expect(t0.up[0]).toBeGreaterThan(0.99)
    const sub = subMolecule(m, groups[0]!, 's', 's')
    expect([sub.atomCount, sub.chains.length, sub.entities.length]).toEqual([60, 3, 1])
    expect(Array.from(sub.pos.subarray(0, 3))).toEqual([100, 0, 0])
    expect(chainCentre(sub, 1)[1]).toBeCloseTo(6, 4)
    // 放到 +z 和 −y 两个位置：质心到中心的距离不变，轴沿法线 / placed at +z and −y: the centroid keeps its distance from the centre and the axis runs along the normal
    const ops = placeTemplate(t0, [0, 0, 0], [[0, 0, 1], [0, -1, 0]])
    const c0 = at(ops[0]!, t0.origin), tip0 = at(ops[0]!, [t0.origin[0] + t0.up[0], t0.origin[1] + t0.up[1], t0.origin[2] + t0.up[2]])
    expect(Math.hypot(...c0)).toBeCloseTo(t0.distance, 3)
    expect(c0[2]! / t0.distance).toBeCloseTo(1, 5)
    expect(tip0[2]! - c0[2]!).toBeCloseTo(1, 5)
    expect(at(ops[1]!, t0.origin)[1]! / t0.distance).toBeCloseTo(-1, 5)
  })
})

describe('the course of an RNA strand', () => {
  it('follows the phosphorus atoms, lifted onto the rod surface, once per stretch', async () => {
    const { rnaPath } = await import('../src/infer/influenza')
    // 一根沿 z 的杆：蛋白的球在半径 40 处，RNA 的磷原子在半径 20 处绕着走
    // a rod along z: protein spheres at radius 40, and RNA phosphorus atoms winding at radius 20
    const pos: number[] = [], isTrace: number[] = []
    for (let i = 0; i < 400; i++) {
      pos.push(Math.cos(i) * 40, Math.sin(i) * 40, i)
      isTrace.push(0)
    }
    const p0 = pos.length / 3
    for (let i = 0; i < 60; i++) {
      pos.push(Math.cos(i * 0.2) * 20, Math.sin(i * 0.2) * 20, i * 6)
      isTrace.push(1)
    }
    const n = pos.length / 3
    const m: Molecule = {
      id: 'r', title: 'r', atomCount: n, pos: new Float32Array(pos), element: new Uint8Array(n).fill(El.C), chainOf: new Uint32Array(n), isTrace: new Uint8Array(isTrace), residue: new Int32Array(n).fill(1),
      chains: [{ asymId: 'A', authAsymId: 'A', entity: 0, start: 0, count: p0, model: 1 }, { asymId: 'R', authAsymId: 'R', entity: 1, start: p0, count: 60, model: 1 }],
      entities: [{ id: '1', description: 'NP', kind: 'protein' }, { id: '2', description: 'RNA', kind: 'rna' }], assemblies: [],
    }
    const shift = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1000, 0, 0, 1])
    const path = rnaPath(m, [IDENTITY, shift], 5)
    const per = Math.ceil(60 / 3)
    expect(path.pos.length / 3).toBe(per * 2)
    // 每一段内部相邻的点相连，两段之间不连 / neighbours are joined within a stretch, and the two stretches are not joined to each other
    expect(path.segments.length / 2).toBe((per - 1) * 2)
    expect(Array.from(path.segments).some((v, i) => i % 2 === 0 && v === per - 1)).toBe(false)
    // 推到了杆的表面附近（半径约 40），第二段平移了 1000 / lifted to about the rod's surface (radius about 40); the second stretch is shifted by 1000
    for (let i = 0; i < per; i++) {
      const r = Math.hypot(path.pos[i * 3]!, path.pos[i * 3 + 1]!)
      expect(r).toBeGreaterThan(36)
      expect(r).toBeLessThan(44)
      expect(path.pos[(per + i) * 3]! - path.pos[i * 3]!).toBeCloseTo(1000, 3)
    }
  })
})

describe('rods run up to the wall and are cut there', () => {
  it('stacks stretches along the whole chord, leaves room for the polymerase, and keeps only what is inside', async () => {
    const { rnpBundle, clipToCavity } = await import('../src/infer/influenza')
    const rod: number[] = []
    for (let i = 0; i <= 40; i++) for (let k = 0; k < 6; k++) rod.push(Math.cos(k) * 70, Math.sin(k) * 70, i * 10)
    const blob: number[] = []
    for (let i = 0; i < 30; i++) blob.push(Math.cos(i) * 40, Math.sin(i * 1.7) * 40, Math.sin(i) * 60)
    const cavity = 420
    const b = rnpBundle(mol(rod), mol(blob), [0, 0, 0], cavity, [0, 1, 0], 616, undefined, true)
    expect(b.tops!.length).toBe(b.stretches.length)
    // 填满时比只放完整的段要多 / more stretches than when only whole ones are placed
    expect(b.stretches.length).toBeGreaterThan(rnpBundle(mol(rod), mol(blob), [0, 0, 0], cavity, [0, 1, 0], 616).stretches.length)
    const { mol: clipped, kept } = clipToCavity(mol(rod), b.stretches, [0, 0, 0], cavity, [0, 1, 0], b.tops, 'r')
    expect(kept).toBeGreaterThan(0.3)
    expect(kept).toBeLessThan(1)
    let lowest = Infinity
    for (let i = 0; i < clipped.atomCount; i++) {
      const p = [clipped.pos[i * 3]!, clipped.pos[i * 3 + 1]!, clipped.pos[i * 3 + 2]!]
      expect(Math.hypot(...p)).toBeLessThanOrEqual(cavity + 1e-3)
      expect(p[1]!).toBeLessThanOrEqual(Math.max(...b.tops!) + 1e-3)
      lowest = Math.min(lowest, p[1]!)
    }
    // 中间那条杆一直伸到下面的内壁附近 / the middle rod reaches down to near the wall below
    expect(lowest).toBeLessThan(-cavity + 80)
    // 每一段下的每条链各成一条链 / every chain under every stretch is a chain of its own
    expect(new Set(clipped.chains.map((c) => c.asymId)).size).toBe(clipped.chains.length)
    expect(clipped.chains.reduce((s, c) => s + c.count, 0)).toBe(clipped.atomCount)
  })
})

describe('catalogue entries that infer or recolour', () => {
  it('carry valid patterns, plausible numbers and a source for every inferred count', async () => {
    const catalog = (await import('../data/catalog.json')).default as { models: { id: string; lining?: string; respike?: { pattern: string; count: number; source: string }; hues?: Record<string, number[]>; membrane?: number[] }[] }
    const { ROLES } = await import('../src/style/palettes')
    let respiked = 0
    for (const m of catalog.models) {
      if (m.lining) expect(() => new RegExp(m.lining!)).not.toThrow()
      if (m.respike) {
        respiked++
        expect(() => new RegExp(m.respike!.pattern)).not.toThrow()
        expect(m.respike.count).toBeGreaterThan(10)
        expect(m.respike.count).toBeLessThan(200)
        // 推断的数量必须写明出处 / an inferred number must name where it comes from
        expect(m.respike.source).toMatch(/doi:10\.\d+\//)
      }
      for (const [role, lch] of Object.entries(m.hues ?? {})) {
        expect(ROLES as string[], `${m.id}.${role}`).toContain(role)
        expect(lch.length).toBe(3)
        expect(lch[0]!).toBeGreaterThan(0.4)
        expect(lch[0]!).toBeLessThan(0.95)
      }
      if (m.membrane) expect(m.membrane.length).toBe(3)
    }
    expect(respiked).toBeGreaterThan(0)
  })
})
