import { describe, expect, it } from 'vitest'
import type { Mesh } from '../tools/pipeline/geometry.ts'
import { applyRigid, buildDeformation, fitRigid, icp, InsideTester, PointIndex, rotationAngle, surfaceDistance, surfacePoints, voxelSubsample, type Rigid } from '../tools/pipeline/register.ts'

function box(min: [number, number, number], max: [number, number, number]): Mesh {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1])
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7])
  return { positions, indices }
}

// deterministic pseudo-random numbers
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}
const cloud = (n: number, seed: number, scale = 1) => {
  const r = rng(seed)
  return Float32Array.from({ length: n * 3 }, () => (r() - 0.5) * scale)
}
const rotZ = (a: number, t: [number, number, number]): Rigid => ({ r: [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1], t })

describe('PointIndex', () => {
  it('finds the same k nearest neighbours as brute force, inside and outside the grid', () => {
    const pts = cloud(500, 1)
    const index = new PointIndex(pts, 0.1)
    const idx = new Int32Array(5)
    const d2 = new Float64Array(5)
    const r = rng(2)
    for (let q = 0; q < 50; q++) {
      const x = (r() - 0.5) * 2
      const y = (r() - 0.5) * 2
      const z = (r() - 0.5) * 2
      const n = index.nearest(x, y, z, 5, idx, d2)
      expect(n).toBe(5)
      const brute = Array.from({ length: 500 }, (_, i) => (pts[3 * i]! - x) ** 2 + (pts[3 * i + 1]! - y) ** 2 + (pts[3 * i + 2]! - z) ** 2).sort((a, b) => a - b)
      for (let j = 0; j < 5; j++) expect(d2[j]!).toBeCloseTo(brute[j]!, 9)
    }
  })
  it('honours maxDistance', () => {
    const index = new PointIndex(new Float32Array([0, 0, 0, 1, 0, 0]), 0.5)
    expect(index.distance(0.1, 0, 0)).toBeCloseTo(0.1)
    expect(index.distance(5, 0, 0, 1)).toBe(Infinity)
    expect(index.distance(5, 0, 0)).toBeCloseTo(4)
  })
})

describe('fitRigid', () => {
  it('recovers a rotation and translation exactly', () => {
    const from = cloud(40, 3)
    const truth = rotZ(0.6, [0.3, -0.2, 1.5])
    const fit = fitRigid(from, applyRigid(truth, from))
    for (let i = 0; i < 9; i++) expect(fit.r[i]!).toBeCloseTo(truth.r[i]!, 5)
    for (let i = 0; i < 3; i++) expect(fit.t[i]!).toBeCloseTo(truth.t[i]!, 5)
    expect(rotationAngle(fit)).toBeCloseTo(0.6, 5)
  })
  it('never returns a reflection', () => {
    const from = cloud(30, 4)
    const mirrored = Float32Array.from(from, (v, i) => (i % 3 === 0 ? -v : v))
    const { r } = fitRigid(from, mirrored)
    const det = r[0]! * (r[4]! * r[8]! - r[5]! * r[7]!) - r[1]! * (r[3]! * r[8]! - r[5]! * r[6]!) + r[2]! * (r[3]! * r[7]! - r[4]! * r[6]!)
    expect(det).toBeCloseTo(1, 5)
  })
})

describe('icp', () => {
  it('aligns a shifted, slightly rotated surface without known correspondences', () => {
    const mesh = box([0, 0, 0], [0.3, 0.1, 0.05])
    const target = surfacePoints(mesh, 0.004)
    const source = surfacePoints(mesh, 0.0057) // different sampling: no point-to-point pairs
    const truth = rotZ(0.08, [0.02, -0.015, 0.01])
    const inverse = fitRigid(applyRigid(truth, source), source)
    const moved = applyRigid(inverse, source) // source displaced by truth⁻¹
    const res = icp(moved, new PointIndex(target, 0.01))
    const back = applyRigid(res.transform, moved)
    let worst = 0
    for (let i = 0; i < source.length; i++) worst = Math.max(worst, Math.abs(back[i]! - source[i]!))
    expect(worst).toBeLessThan(0.002)
    expect(res.rms).toBeLessThan(0.003)
  })
})

describe('buildDeformation', () => {
  it('reproduces a uniform shift everywhere, including far from the anchors', () => {
    const from = cloud(200, 5)
    const to = Float32Array.from(from, (v, i) => v + [0.01, -0.02, 0.03][i % 3]!)
    const def = buildDeformation(from, to, { minSigma: 0.05 })
    for (const p of [[0, 0, 0], [0.4, 0.1, -0.3], [30, -20, 10]] as const) {
      const d = def.displacementAt(p[0], p[1], p[2])
      expect(d[0]).toBeCloseTo(0.01, 6)
      expect(d[1]).toBeCloseTo(-0.02, 6)
      expect(d[2]).toBeCloseTo(0.03, 6)
    }
  })
  it('blends smoothly between two regions that moved differently and stays within their range', () => {
    // anchors on two slabs: x<0 moves +1 cm in y, x>0.2 does not move
    const pts: number[] = []
    const dst: number[] = []
    for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) {
      pts.push(-0.1 + 0.005 * i, 0.01 * j, 0)
      dst.push(-0.1 + 0.005 * i, 0.01 * j + 0.01, 0)
      pts.push(0.2 + 0.005 * i, 0.01 * j, 0)
      dst.push(0.2 + 0.005 * i, 0.01 * j, 0)
    }
    const def = buildDeformation(Float32Array.from(pts), Float32Array.from(dst), { minSigma: 0.02, k: 32 })
    expect(def.displacementAt(-0.05, 0.1, 0)[1]).toBeCloseTo(0.01, 4)
    expect(def.displacementAt(0.25, 0.1, 0)[1]).toBeCloseTo(0, 4)
    let prev = Infinity
    for (let x = 0; x <= 0.2001; x += 0.01) {
      const d = def.displacementAt(x, 0.1, 0)[1]
      expect(d).toBeGreaterThanOrEqual(-1e-9)
      expect(d).toBeLessThanOrEqual(0.01 + 1e-9)
      expect(d).toBeLessThanOrEqual(prev + 1e-9) // monotone from the moved slab to the still one
      prev = d
    }
    const out = def.apply(new Float32Array([-0.05, 0.1, 0]))
    expect(out[1]!).toBeCloseTo(0.11, 4)
  })
  it('rejects mismatched or empty anchors', () => {
    expect(() => buildDeformation(new Float32Array(3), new Float32Array(6))).toThrow()
    expect(() => buildDeformation(new Float32Array(0), new Float32Array(0))).toThrow()
  })
})

describe('surfaceDistance / voxelSubsample', () => {
  it('measures the gap between two parallel faces', () => {
    const a = surfacePoints(box([0, 0, 0], [1, 1, 0.001]), 0.05)
    const b = surfacePoints(box([0, 0, 0.1], [1, 1, 0.101]), 0.02)
    const s = surfaceDistance(a, new PointIndex(b, 0.05))
    expect(s.median).toBeGreaterThan(0.098)
    expect(s.median).toBeLessThan(0.105)
  })
  it('keeps about one point per voxel', () => {
    const pts = cloud(5000, 7)
    const keep = voxelSubsample(pts, 0.25)
    expect(keep.length).toBeGreaterThan(30)
    expect(keep.length).toBeLessThanOrEqual(4 ** 3 + 61)
  })
})

describe('InsideTester', () => {
  it('classifies points against a closed box', () => {
    const t = new InsideTester(box([0, 0, 0], [2, 3, 4]))
    expect(t.contains(1, 1.5, 2)).toBe(true)
    expect(t.contains(0.01, 2.99, 3.99)).toBe(true)
    expect(t.contains(1, 3.5, 2)).toBe(false)
    expect(t.contains(1, -0.5, 2)).toBe(false)
    expect(t.contains(2.5, 1, 1)).toBe(false)
    expect(t.fractionInside(new Float32Array([1, 1, 1, 5, 5, 5, 0.5, 0.5, 0.5, -1, 0, 0]))).toBe(0.5)
  })
  it('handles a concave shape (two boxes joined into an L is approximated by parity)', () => {
    // hollow shell: outer box with an inner box of reversed role → points in the cavity are outside
    const outer = box([0, 0, 0], [4, 4, 4])
    const inner = box([1, 1, 1], [3, 3, 3])
    const positions = new Float32Array([...outer.positions, ...inner.positions])
    const indices = new Uint32Array([...outer.indices, ...Array.from(inner.indices, (i) => i + 8)])
    const t = new InsideTester({ positions, indices })
    expect(t.contains(0.5, 2, 2.1)).toBe(true)
    expect(t.contains(2.1, 2, 2.2)).toBe(false)
    expect(t.contains(2.1, 3.5, 2.2)).toBe(true)
  })
})
