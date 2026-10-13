// 腔的纯函数在合成的管上的测试；不读任何生成的数据。
// Tests of the pure lumen functions on synthetic tubes; no generated data is read.

import { describe, expect, it } from 'vitest'
import { buildTube, mergeMeshes } from '../tools/pipeline/tube.ts'
import {
  applyFilling, arcLengths, axisEnds, axisLength, capRings, centrelineClashes, distanceToMesh, fillingField, limitByCurvature, offsetInward, orderChain, orientChain,
  ringCalibre, ringsToMesh, ringVolume, sampleRings, selfIntersections, shellAxis, sphincterNarrowing, vec, type ChainPiece, type V3,
} from '../tools/pipeline/lumen.ts'
import { numberedOrder } from '../tools/pipeline/lumenBuild.ts'

/** 四分之一圆弧（半径 R）上的折线 / a polyline on a quarter circle of radius R */
function arc(R: number, n: number, from = 0, to = Math.PI / 2): Float32Array {
  const p = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const a = from + ((to - from) * i) / (n - 1)
    p[3 * i] = R * Math.cos(a)
    p[3 * i + 1] = R * Math.sin(a)
  }
  return p
}
const tube = (points: Float32Array, r: number, sides = 24) => buildTube({ points, radius: new Float32Array(points.length / 3).fill(r) }, sides)!

describe('shellAxis', () => {
  it('finds the centreline, length and radius of a bent closed tube', () => {
    const R = 0.1, r = 0.01
    const axis = shellAxis(tube(arc(R, 60), r), { step: 0.004, smooth: 6 })
    expect(axisLength(axis)).toBeGreaterThan(0.95 * (Math.PI / 2) * R)
    // 沿网格边的距离不是真正的测地距离，质心折线略有摆动：在这根管上长度偏长约 5%
    // distances along mesh edges are not true geodesics and the centroid polyline wobbles a little: about 5% long on this tube
    expect(axisLength(axis)).toBeLessThan(1.08 * (Math.PI / 2) * R)
    const [a, b] = axisEnds(axis)
    const ends = [[R, 0, 0], [0, R, 0]] as V3[]
    expect(Math.min(vec.dist(a, ends[0]!) + vec.dist(b, ends[1]!), vec.dist(a, ends[1]!) + vec.dist(b, ends[0]!))).toBeLessThan(2.2 * r) // 端点是表面上的顶点，离端面中心至多一个半径 / an end is a surface vertex, up to one radius from the centre of the end face
    const mid = Array.from(axis.radius).slice(4, -4)
    for (const x of mid) expect(Math.abs(x - r)).toBeLessThan(0.0015)
    // 中段的点在圆弧上 / interior points lie on the arc
    for (let i = 4; i < axis.points.length / 3 - 4; i++) expect(Math.abs(Math.hypot(axis.points[3 * i]!, axis.points[3 * i + 1]!) - R)).toBeLessThan(0.003)
  })
})

describe('orderChain and orientChain', () => {
  // 一条螺旋线切成 12 段，每段只给两端 / a helix cut into 12 pieces, each known by its two ends
  const at = (u: number): V3 => [0.05 * Math.cos(u), 0.05 * Math.sin(u), 0.01 * u]
  const pieces: ChainPiece[] = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, ends: [at(i * 0.5), at(i * 0.5 + 0.45)] as [V3, V3] }))
  it('recovers the order of shuffled, randomly flipped pieces from end proximity', () => {
    const shuffled = [7, 2, 11, 0, 5, 9, 3, 1, 10, 4, 8, 6].map((k, j) => ({ id: pieces[k]!.id, ends: (j % 2 ? [pieces[k]!.ends[1], pieces[k]!.ends[0]] : pieces[k]!.ends) as [V3, V3] }))
    const chain = orderChain(shuffled, at(0))
    expect(chain.map((l) => l.id)).toEqual(pieces.map((p) => p.id))
    for (const l of chain.slice(1)) expect(l.gap).toBeLessThan(0.004)
    // 被翻转过的片应当报告为 reversed / pieces given flipped are reported as reversed
    expect(chain.find((l) => l.id === 'p2')!.reversed).toBe(true)
    expect(chain.find((l) => l.id === 'p7')!.reversed).toBe(false)
  })
  it('orients pieces of a known order', () => {
    const flipped = pieces.map((p, i) => ({ id: p.id, ends: (i % 3 === 1 ? [p.ends[1], p.ends[0]] : p.ends) as [V3, V3] }))
    const chain = orientChain(flipped, at(0))
    expect(chain.map((l) => l.reversed)).toEqual(pieces.map((_, i) => i % 3 === 1))
    expect(chain[0]!.gap).toBeCloseTo(0, 6)
  })
  it('maps a running number to string-sorted ids', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `X${String(i).padStart(2, '0')}`)
    // 字符串排序：1 10 11 12 2 3 … 9 / string order: 1 10 11 12 2 3 … 9
    expect(numberedOrder(ids).slice(0, 4)).toEqual(['X00', 'X04', 'X05', 'X06'])
    expect(numberedOrder(ids)[9]).toBe('X01')
  })
})

describe('offsetInward', () => {
  const R = 0.1, r = 0.012, wall = 0.003, sides = 16
  const outerMesh = tube(arc(R, 80), r, 32)
  const centre = Float64Array.from(arc(R, 30, 0.15, Math.PI / 2 - 0.15))
  const rings = sampleRings(outerMesh, centre, sides)
  it('samples the outer radius of a tube', () => {
    for (const o of rings.outer) expect(Math.abs(o - r)).toBeLessThan(0.0008)
  })
  it('leaves a wall of the tabled thickness and never self-intersects', () => {
    const off = offsetInward(rings.outer, rings.cos, rings.stations, sides, { wall, slit: 0.0005 })
    expect(off.collapsedStations).toBe(0)
    const inner = ringsToMesh(centre, rings.dir, off.inner, rings.stations, sides)
    for (let v = 0; v < inner.positions.length; v += 3) {
      const d = distanceToMesh(outerMesh, [inner.positions[v]!, inner.positions[v + 1]!, inner.positions[v + 2]!])
      expect(d).toBeGreaterThan(wall * 0.85)
      expect(d).toBeLessThan(wall * 1.3)
    }
    expect(selfIntersections(inner)).toBe(0)
    expect(selfIntersections(capRings(inner, centre, rings.stations, sides, true, true))).toBe(0)
    const cal = ringCalibre(off.inner, rings.stations, sides)
    for (const c of cal) expect(Math.abs(c - 2 * (r - wall))).toBeLessThan(0.002)
    // 体积 ≈ 截面积 × 长度 / volume ≈ area × length
    const L = arcLengths(centre).at(-1)!
    expect(ringVolume(centre, rings.dir, off.inner, rings.stations, sides)).toBeGreaterThan(0.85 * Math.PI * (r - wall) ** 2 * L)
  })
  it('collapses to a slit where the organ is narrower than twice the wall, and records it', () => {
    const off = offsetInward(rings.outer, rings.cos, rings.stations, sides, { wall: 0.013, slit: 0.0005 })
    expect(off.collapsedStations).toBe(rings.stations)
    for (let i = 0; i < off.inner.length; i++) {
      expect(off.inner[i]!).toBeGreaterThan(0)
      expect(off.inner[i]!).toBeLessThanOrEqual(0.0005)
      expect(off.inner[i]!).toBeLessThan(rings.outer[i]!)
    }
    expect(selfIntersections(ringsToMesh(centre, rings.dir, off.inner, rings.stations, sides))).toBe(0)
  })
  it('limits the radius at a bend tighter than the tube', () => {
    const tight = Float64Array.from(arc(0.004, 20, 0, Math.PI))
    const rad = new Float64Array(20 * sides).fill(0.01)
    expect(limitByCurvature(rad, tight, sides, 0.9)).toBeGreaterThan(10)
    expect(Math.max(...rad.subarray(5 * sides, 15 * sides))).toBeLessThanOrEqual(0.9 * 0.004 + 1e-6)
  })
})

describe('sphincterNarrowing', () => {
  it('narrows smoothly inside its window only', () => {
    const n = 41, sides = 8
    const s = Float64Array.from({ length: n }, (_, i) => i * 0.002)
    const radius = new Float64Array(n * sides).fill(0.01)
    const { radius: out, weight } = sphincterNarrowing(radius, s, sides, 0.04, 0.02, 0.2)
    expect(out[20 * sides]!).toBeCloseTo(0.002, 6)
    expect(weight[20]).toBeCloseTo(1, 6)
    for (const i of [0, 10, 14, 26, 40]) expect(out[i * sides]!).toBeCloseTo(0.01, 9)
    // 单调：越靠近中心越窄 / monotone: narrower toward the centre
    for (let i = 15; i < 20; i++) expect(out[(i + 1) * sides]!).toBeLessThan(out[i * sides]!)
    for (let i = 20; i < 25; i++) expect(out[(i + 1) * sides]!).toBeGreaterThan(out[i * sides]!)
    // 不改输入；下限不会把本来更窄的地方撑开 / the input is untouched; the floor never widens what was narrower
    expect(radius[20 * sides]).toBe(0.01)
    const thin = new Float64Array(n * sides).fill(0.0004)
    expect(sphincterNarrowing(thin, s, sides, 0.04, 0.02, 0, 0.001).radius[20 * sides]!).toBeCloseTo(0.0004, 9)
    expect(sphincterNarrowing(radius, s, sides, 0.04, 0.02, 0, 0.001).radius[20 * sides]!).toBeCloseTo(0.001, 9)
  })
})

describe('filling', () => {
  it('is linear in f, equals the stored geometry at rest and reaches the tabled calibres', () => {
    const n = 10, sides = 12
    const centre = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) centre[3 * i + 2] = i * 0.003
    const rings = sampleRings(null, centre, sides)
    const mesh = ringsToMesh(centre, rings.dir, new Float64Array(n * sides).fill(0.006), n, sides)
    const centres = new Float32Array(mesh.positions.length)
    for (let v = 0; v < n * sides; v++) centres.set(centre.subarray(3 * Math.floor(v / sides), 3 * Math.floor(v / sides) + 3), 3 * v)
    const field = fillingField(mesh.positions, centres, 0.012, 0.004, 0.02)
    expect(field.rest).toBeCloseTo(0.5, 6)
    expect(Array.from(applyFilling(mesh.positions, field, field.rest))).toEqual(Array.from(mesh.positions))
    const rOf = (p: Float32Array) => Math.hypot(p[0]!, p[1]!)
    expect(2 * rOf(applyFilling(mesh.positions, field, 0))).toBeCloseTo(0.004, 5)
    expect(2 * rOf(applyFilling(mesh.positions, field, 1))).toBeCloseTo(0.02, 5)
  })
})

describe('self-intersection checks', () => {
  it('finds two tubes that cross and a centreline that runs into itself', () => {
    const a = tube(Float32Array.from([-0.05, 0, 0, 0.05, 0, 0]), 0.01, 12)
    const b = tube(Float32Array.from([0, -0.05, 0.004, 0, 0.05, 0.004]), 0.01, 12)
    expect(selfIntersections(a)).toBe(0)
    expect(selfIntersections(mergeMeshes([a, b]))).toBeGreaterThan(0)
    // 一条折回来与自己相交的中心线 / a centreline that comes back across itself
    const pts: number[] = []
    for (let i = 0; i <= 40; i++) pts.push(i * 0.005, 0, 0)
    for (let i = 0; i <= 40; i++) pts.push(0.1, -0.1 + i * 0.005, 0.002)
    const rad = new Float64Array(pts.length / 3).fill(0.005)
    expect(centrelineClashes(pts, rad).pairs).toBeGreaterThan(0)
    expect(centrelineClashes(pts.slice(0, 41 * 3), rad.subarray(0, 41)).pairs).toBe(0)
  })
})
