// 腔这一步在一副合成的小人体上的测试，以及弯处、互让几条规则的测试；不读任何生成的数据。
// Tests of the lumen stage on a small synthetic body, and of the bend and give-way rules; no generated data is read.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Part } from '../src/anatomy/types.ts'
import { computeNormals, measure, type Mesh } from '../tools/pipeline/geometry.ts'
import { glbVertexOrder, POSITION_BITS, positionStep, writeSystemGlb } from '../tools/pipeline/glb.ts'
import { buildTube, mergeMeshes } from '../tools/pipeline/tube.ts'
import { readGlbParts } from '../tools/skinmaps/io.ts'
import { arcBridge, curvatureRadius, limitByPlanes, relaxKinks, ringPlaneCrossings, ringsToMesh, sampleRings, selfIntersections, separateRings, teardropBridge } from '../tools/pipeline/lumen.ts'
import { expandRetiredLumenIds, fillingSidecar, lumenStage } from '../tools/pipeline/lumenStage.ts'

const line = (pts: number[][], n = 24): Float32Array => {
  // 折线按段均匀加密 / a polyline densified evenly along its segments
  const out: number[] = []
  for (let s = 0; s + 1 < pts.length; s++) for (let i = s === 0 ? 0 : 1; i <= n; i++) for (let q = 0; q < 3; q++) out.push(pts[s]![q]! + ((pts[s + 1]![q]! - pts[s]![q]!) * i) / n)
  return Float32Array.from(out)
}
const tube = (pts: number[][], r: number): Mesh => {
  const p = line(pts)
  return buildTube({ points: p, radius: new Float32Array(p.length / 3).fill(r) }, 20)!
}

/** 一副只有消化道、舌和唇的小人体（男性的部件号） / a small body with only an alimentary canal, a tongue and lips (male part ids) */
function syntheticBody(): { parts: Part[]; meshes: Map<string, Mesh> } {
  const z = 0.1
  const defs: [string, string, Mesh][] = [
    ['FJ2563', 'Esophagus', tube([[0, 1.3, z], [0, 1.13, z]], 0.008)],
    ['FJ2564', 'Stomach', tube([[0.05, 1.11, z], [0.01, 1.07, z], [-0.03, 1.03, z]], 0.025)],
    ['FJ2573', 'Duodenum', tube([[-0.05, 1.01, z], [-0.05, 0.95, z]], 0.01)],
    ['FJ2600', 'Proximal part of jejunum', tube([[-0.045, 0.93, z], [0.03, 0.93, z]], 0.009)],
    ['FJ2601', 'Proximal part of jejunum', tube([[0.05, 0.92, z], [0.05, 0.86, z]], 0.009)],
    ['FJ2610', 'Proximal part of ileum', tube([[0.04, 0.84, z], [-0.03, 0.84, z]], 0.009)],
    ['FJ2611', 'Proximal part of ileum', tube([[-0.04, 0.83, z], [-0.04, 0.795, z]], 0.009)],
    ['FJ2599', 'Ileocecal junction', tube([[-0.045, 0.78, z], [-0.064, 0.775, z]], 0.007)],
    ['FJ2566', 'Ascending colon', tube([[-0.09, 0.74, z], [-0.09, 0.98, z]], 0.02)],
    ['FJ2572', 'Transverse colon', tube([[-0.07, 1.0, 0.16], [0.07, 1.0, 0.16]], 0.018)],
    ['FJ2567', 'Descending colon', tube([[0.09, 0.98, z], [0.09, 0.77, z]], 0.015)],
    ['FJ2571', 'Rectum', tube([[0.07, 0.74, 0.09], [0.01, 0.7, 0.07]], 0.015)],
    ['FJ2761', 'Tongue', tube([[0, 1.36, 0.1], [0, 1.36, 0.15]], 0.012)],
    ['FJ2814_upper', 'Upper lip', tube([[-0.02, 1.378, 0.18], [0.02, 1.378, 0.18]], 0.004)],
    ['FJ2814_lower', 'Lower lip', tube([[-0.02, 1.366, 0.18], [0.02, 1.366, 0.18]], 0.004)],
  ]
  const meshes = new Map<string, Mesh>()
  const parts: Part[] = defs.map(([id, name, mesh]) => {
    meshes.set(id, mesh)
    const st = measure(mesh)
    return { id, name, fma: 'FMA0', system: 'digestive', tissue: 'organ', depth: 6, side: 'M', provenance: 'scanned', bbox: st.bbox as Part['bbox'], centroid: st.centroid as Part['centroid'], triangles: mesh.indices.length / 3, adjacent: [] }
  })
  return { parts, meshes }
}

describe('lumenStage on a synthetic body', async () => {
  const body = syntheticBody()
  const res = await lumenStage('male', { parts: body.parts, mesh: (id) => body.meshes.get(id), defaultSource: 'synthetic' }, { fmaLabel: (id) => `label of ${id}` })
  const ids = res.parts.map((p) => p.id)
  it('returns one space part per segment with a composition that covers every vertex', () => {
    for (const id of ['LUMEN_oral_cavity', 'LUMEN_pharynx', 'LUMEN_esophagus', 'LUMEN_stomach', 'LUMEN_duodenum', 'LUMEN_jejunum', 'LUMEN_ileum', 'LUMEN_ascending_colon', 'LUMEN_transverse_colon', 'LUMEN_descending_colon', 'LUMEN_rectum']) expect(ids).toContain(id)
    for (const p of res.parts) {
      expect(p.tissue).toBe('space')
      expect(p.provenance).toBe('curated')
      expect(p.fmaLabel).toBe(`label of ${p.fma}`)
      expect(p.composition.reduce((s, c) => s + c.vertices, 0)).toBe(p.mesh.positions.length / 3)
      expect(p.filling.displacement.length).toBe(p.mesh.positions.length)
      for (const c of p.composition) expect(c.provenance === 'construction' ? c.source : typeof c.source).toBe(c.provenance === 'construction' ? null : 'string')
    }
    // 胃的腔绝大部分由壁推出；口腔没有壁，全是构造或以真实部件为界 / the stomach lumen is almost all derived from its wall; the oral cavity has no wall and is construction or bounded by real parts
    const stomach = res.parts.find((p) => p.id === 'LUMEN_stomach')!
    expect(stomach.composition.find((c) => c.provenance === 'curated')!.vertices).toBeGreaterThan(0.8 * (stomach.mesh.positions.length / 3))
    expect(res.parts.find((p) => p.id === 'LUMEN_oral_cavity')!.composition.every((c) => !/offset inward/.test(c.what.en))).toBe(true)
  })
  it('does not self-intersect at any filling, stays inside the walls and grows with filling', () => {
    const checks = res.report.checks as { lumenSurfaceSelfIntersections: { atFull: number; atRest: number; atEmpty: number }; consecutiveRingPairsCrossing: number; lumenInsideWall: { outside: number; verticesTested: number }; filling: { allMonotone: boolean } }
    expect(checks.lumenSurfaceSelfIntersections).toMatchObject({ atFull: 0, atRest: 0, atEmpty: 0 })
    expect(checks.consecutiveRingPairsCrossing).toBe(0)
    expect(checks.lumenInsideWall.verticesTested).toBeGreaterThan(1000)
    expect(checks.lumenInsideWall.outside).toBe(0)
    expect(checks.filling.allMonotone).toBe(true)
    expect(selfIntersections(mergeMeshes(res.parts.map((p) => p.mesh)), 10)).toBe(0)
    // 充盈到头也不自交 / nor at full filling
    const full = res.parts.map((p) => ({ positions: Float32Array.from(p.mesh.positions, (x, i) => x + (1 - p.filling.rest) * p.filling.displacement[i]!), indices: p.mesh.indices }))
    expect(selfIntersections(mergeMeshes(full), 10)).toBe(0)
    // 食管和胃静止时塌陷（f = 0），升结肠静止时是张开的（f = 1） / oesophagus and stomach rest collapsed (f = 0), the ascending colon open (f = 1)
    expect(res.parts.find((p) => p.id === 'LUMEN_stomach')!.filling.rest).toBe(0)
    expect(res.parts.find((p) => p.id === 'LUMEN_ascending_colon')!.filling.rest).toBe(1)
  })
  it('writes cautions in both languages, each zh under 260 characters', () => {
    expect(res.cautions.length).toBeGreaterThanOrEqual(4)
    for (const c of res.cautions) {
      expect(c.zh.length).toBeGreaterThan(20)
      expect(c.zh.length).toBeLessThan(260)
      expect(c.en.length).toBeGreaterThan(40)
    }
    expect(res.cautions.some((c) => /constructed|construction/.test(c.en))).toBe(true)
    expect(res.cautions.some((c) => /assum/.test(c.en))).toBe(true)
  })
  it('puts the filling field in the vertex order of the written GLB', async () => {
    const side = await fillingSidecar(res.parts)
    const dir = mkdtempSync(join(tmpdir(), 'lumen-test-'))
    try {
      const path = join(dir, 'lumen.glb')
      await writeSystemGlb(path, 'digestive', '#2896a0', res.parts.map((p) => ({ id: p.id, positions: p.mesh.positions, normals: computeNormals(p.mesh), indices: p.mesh.indices })))
      const back = await readGlbParts(path)
      const field = new Float32Array(side.bin.buffer, side.bin.byteOffset, side.bin.byteLength / 4)
      for (const row of side.index.parts) {
        const p = res.parts.find((q) => q.id === row.part)!
        const g = back.get(row.part)!
        expect(g.positions.length / 3).toBe(row.vertices)
        const order = await glbVertexOrder(p.mesh.indices)
        const step = positionStep(p.mesh.positions, POSITION_BITS)
        for (let v = 0; v < p.mesh.positions.length / 3; v += 7) {
          const at = order.remap[v]!
          // GLB 里第 at 个顶点就是输入的第 v 个顶点（差不超过量化步长），位移场的第 at 项就是它的位移
          // vertex `at` of the GLB is input vertex v (to within the quantisation step) and entry `at` of the field is its displacement
          for (let q = 0; q < 3; q++) {
            expect(Math.abs(g.positions[3 * at + q]! - p.mesh.positions[3 * v + q]!)).toBeLessThan(step + 1e-5)
            expect(field[row.offset / 4 + 3 * at + q]).toBe(p.filling.displacement[3 * v + q])
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('expands retired ids', () => {
    const retired = new Map([['WU_uterine_and_vaginal_lumen', ['WU_uterine_cavity', 'WU_cervical_canal', 'WU_vaginal_lumen']]])
    expect(expandRetiredLumenIds(['a', 'WU_uterine_and_vaginal_lumen', 'b'], retired)).toEqual(['a', 'WU_uterine_cavity', 'WU_cervical_canal', 'WU_vaginal_lumen', 'b'])
    expect(res.retired.size).toBe(0)
  })
}, 120000)

describe('bends', () => {
  const sides = 16
  it('arcBridge keeps the radius of curvature near g / (2 sin(θ/2)) instead of cutting the corner', () => {
    // 两个端点相距 20 mm，方向相反：半圆，半径 10 mm / end points 20 mm apart with opposite directions: a semicircle of radius 10 mm
    const b = arcBridge([0, 0, 0], [0, 1, 0], [0.02, 0, 0], [0, -1, 0], 0.002)
    const R = Array.from(curvatureRadius(b)).filter(Number.isFinite)
    expect(Math.min(...R)).toBeGreaterThan(0.007)
    let top = 0
    for (let i = 1; i < b.length; i += 3) top = Math.max(top, b[i]!)
    expect(top).toBeGreaterThan(0.008)
  })
  it('teardropBridge turns back between two points that all but coincide without a tight corner', () => {
    const R = 0.003
    const b = teardropBridge([0, 0, 0], [0, 1, 0], [0.001, 0, 0], [0, -1, 0], R, 0.0012)
    const n = b.length / 3
    expect(Math.hypot(b[0]!, b[1]!, b[2]!)).toBeLessThan(1e-9)
    expect(Math.hypot(b[3 * n - 3]! - 0.001, b[3 * n - 2]!, b[3 * n - 1]!)).toBeLessThan(1e-9)
    // 环上（去掉两头各三个点）曲率半径不小于 R 的八成 / on the loop (three points off either end) the radius of curvature is at least four fifths of R
    const rc = Array.from(curvatureRadius(b)).slice(3, -3)
    expect(Math.min(...rc)).toBeGreaterThan(0.8 * R)
  })
  it('limitByPlanes cuts only the inside of a bend and leaves no ring crossing its neighbour', () => {
    const Rb = 0.006, n = 30
    const centre = new Float64Array(n * 3)
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * i) / (n - 1)
      centre[3 * i] = Rb * Math.cos(a)
      centre[3 * i + 1] = Rb * Math.sin(a)
    }
    const rings = sampleRings(null, centre, sides)
    const radius = new Float64Array(n * sides).fill(0.01)
    expect(ringPlaneCrossings(centre, rings.dir, radius, sides)).toBeGreaterThan(0)
    const res = limitByPlanes(radius, centre, rings.dir, sides)
    expect(res.limited).toBeGreaterThan(20)
    expect(ringPlaneCrossings(centre, rings.dir, radius, sides)).toBe(0)
    expect(selfIntersections(ringsToMesh(centre, rings.dir, radius, n, sides))).toBe(0)
    // 弯的外侧没有动，内侧不超过曲率半径 / the outside of the bend is untouched, the inside no more than the radius of curvature
    const mid = 15
    let outer = 0, inner = Infinity
    for (let k = 0; k < sides; k++) {
      const d = [rings.dir[3 * (mid * sides + k)]!, rings.dir[3 * (mid * sides + k) + 1]!]
      const toCentre = -(d[0]! * centre[3 * mid]! + d[1]! * centre[3 * mid + 1]!) / Rb
      if (toCentre < -0.9) outer = Math.max(outer, radius[mid * sides + k]!)
      if (toCentre > 0.9) inner = Math.min(inner, radius[mid * sides + k]!)
    }
    expect(outer).toBeCloseTo(0.01, 9)
    expect(inner).toBeLessThan(Rb)
  })
  it('relaxKinks removes a sharp corner and keeps the ends', () => {
    const pts = Float64Array.from([0, 0, 0, 0.003, 0, 0, 0.006, 0, 0, 0.004, 0.002, 0, 0.001, 0.004, 0, -0.002, 0.006, 0])
    expect(relaxKinks(pts, 45)).toBeGreaterThan(0)
    expect(Array.from(pts.subarray(0, 3))).toEqual([0, 0, 0])
    for (let i = 1; i < 5; i++) {
      const u = [pts[3 * i]! - pts[3 * i - 3]!, pts[3 * i + 1]! - pts[3 * i - 2]!], v = [pts[3 * i + 3]! - pts[3 * i]!, pts[3 * i + 4]! - pts[3 * i + 1]!]
      const cos = (u[0]! * v[0]! + u[1]! * v[1]!) / (Math.hypot(...u) * Math.hypot(...v))
      expect(cos).toBeGreaterThan(Math.cos((46 * Math.PI) / 180))
    }
  })
})

describe('separateRings', () => {
  it('makes two overlapping parallel tubes give way about equally and leaves distant ones alone', () => {
    const sides = 16, n = 20, r = 0.006
    const centre = new Float64Array(2 * n * 3)
    for (let i = 0; i < n; i++) {
      centre.set([i * 0.003, 0, 0], 3 * i)
      centre.set([i * 0.003, 0.008, 0], 3 * (n + i))
    }
    const a = sampleRings(null, centre.subarray(0, 3 * n), sides), b = sampleRings(null, centre.subarray(3 * n), sides)
    const dir = Float64Array.from([...a.dir, ...b.dir])
    const radius = new Float64Array(2 * n * sides).fill(r)
    const mesh = (rad: Float64Array): Mesh => mergeMeshes([ringsToMesh(centre.subarray(0, 3 * n), a.dir, rad.subarray(0, n * sides), n, sides), ringsToMesh(centre.subarray(3 * n), b.dir, rad.subarray(n * sides), n, sides)])
    expect(selfIntersections(mesh(radius))).toBeGreaterThan(0)
    const res = separateRings(radius, centre, dir, sides, { covered: (i, j) => i < n === j < n, sep: 0.001 })
    expect(res.remaining).toBe(0)
    expect(selfIntersections(mesh(radius))).toBe(0)
    // 两根管各让出的量大致相同（逐对处理，不完全对称），重叠 4 mm 加 1 mm 的隔，每边约 2.5 mm / both tubes give about the same (pairs are treated one after another, so not exactly): 4 mm of overlap plus the 1 mm septum, about 2.5 mm each
    expect(Math.abs(res.gave[5]! - res.gave[n + 5]!)).toBeLessThan(0.0004)
    expect(res.gave[5]!).toBeGreaterThan(0.002)
    expect(res.gave[5]!).toBeLessThan(0.0035)
    expect(res.partner[5]).toBeGreaterThanOrEqual(n)
    // 背对另一根管的那一侧没有动 / the side facing away from the other tube is untouched
    expect(Math.max(...radius.subarray(5 * sides, 6 * sides))).toBeCloseTo(r, 9)
    const far = new Float64Array(2 * n * sides).fill(0.003)
    expect(Math.max(...separateRings(far, centre, dir, sides, { covered: (i, j) => i < n === j < n }).gave)).toBe(0)
  })
})
