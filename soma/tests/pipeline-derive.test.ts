// 派生几何（体素包络、surface nets）的单元测试。
// Unit tests for derived geometry (voxel envelopes, surface nets).
import { describe, expect, it } from 'vitest'
import { capHoles, envelopeOf, smoothMesh, surfaceNets } from '../tools/pipeline/derive.ts'
import { measure, type Mesh } from '../tools/pipeline/geometry.ts'
import { deriveFat, fatRegionOfBone, isFatPart } from '../tools/pipeline/fat.ts'
import { InsideTester, surfacePoints } from '../tools/pipeline/register.ts'

function box(min: [number, number, number], max: [number, number, number]): Mesh {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1])
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7])
  return { positions, indices }
}

// 每条边恰好被两个三角形共用即为封闭流形 / closed manifold: every edge is shared by exactly two triangles
function openOrNonManifoldEdges(m: Mesh): number {
  const count = new Map<number, number>()
  const nv = m.positions.length / 3
  for (let t = 0; t < m.indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = m.indices[t + k]!
    const b = m.indices[t + ((k + 1) % 3)]!
    const key = Math.min(a, b) * nv + Math.max(a, b)
    count.set(key, (count.get(key) ?? 0) + 1)
  }
  let bad = 0
  for (const c of count.values()) if (c !== 2) bad++
  return bad
}

describe('surfaceNets', () => {
  it('extracts a closed sphere with outward-facing triangles', () => {
    const n = 24
    const values = new Float32Array(n * n * n)
    const c = (n - 1) / 2
    const r = 8
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      values[i + n * (j + n * k)] = r - Math.hypot(i - c, j - c, k - c) // > 0 inside
    }
    const mesh = surfaceNets(values, [n, n, n], 0)
    expect(openOrNonManifoldEdges(mesh)).toBe(0)
    const s = measure(mesh)
    const exact = (4 / 3) * Math.PI * r ** 3
    expect(s.signedVolume).toBeGreaterThan(0) // 体积为正说明朝外 / positive volume means outward winding
    expect(Math.abs(s.signedVolume - exact) / exact).toBeLessThan(0.03)
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const d = Math.hypot(mesh.positions[i]! - c, mesh.positions[i + 1]! - c, mesh.positions[i + 2]! - c)
      expect(Math.abs(d - r)).toBeLessThan(0.5)
    }
  })

  it('returns an empty mesh when the surface does not cross the grid', () => {
    const mesh = surfaceNets(new Float32Array(27).fill(1), [3, 3, 3], 0.5)
    expect(mesh.indices.length).toBe(0)
  })
})

describe('envelopeOf', () => {
  const solids = [box([0, 0, 0], [0.04, 0.03, 0.02]), box([0.03, 0.01, 0.005], [0.07, 0.02, 0.015])]

  it('encloses the union of the solids at about the requested distance', () => {
    const offset = 0.004
    const voxel = 0.001
    const env = envelopeOf(solids, { voxel, offset, smooth: 2 })
    expect(openOrNonManifoldEdges(env)).toBe(0)
    const tester = new InsideTester(env, 64)
    // 原实体的全部顶点都在包络内 / every vertex of the solids is inside the envelope
    for (const s of solids) for (let i = 0; i < s.positions.length; i += 3) {
      expect(tester.contains(s.positions[i]!, s.positions[i + 1]!, s.positions[i + 2]!)).toBe(true)
    }
    // 包络顶点到并集的距离约等于 offset / envelope vertices lie about `offset` from the union
    const dist = (x: number, y: number, z: number) => Math.min(...solids.map((s) => {
      const p = s.positions
      const dx = Math.max(p[0]! - x, 0, x - p[18]!)
      const dy = Math.max(p[1]! - y, 0, y - p[19]!)
      const dz = Math.max(p[2]! - z, 0, z - p[20]!)
      return Math.hypot(dx, dy, dz)
    }))
    const d: number[] = []
    for (let i = 0; i < env.positions.length; i += 3) d.push(dist(env.positions[i]!, env.positions[i + 1]!, env.positions[i + 2]!))
    d.sort((a, b) => a - b)
    expect(d[Math.floor(d.length / 2)]!).toBeGreaterThan(offset - 1.5 * voxel)
    expect(d[Math.floor(d.length / 2)]!).toBeLessThan(offset + 1.5 * voxel)
    expect(d[d.length - 1]!).toBeLessThan(offset + 3 * voxel)
  })

  it('is deterministic', () => {
    const a = envelopeOf(solids, { voxel: 0.002, offset: 0.004 })
    const b = envelopeOf(solids, { voxel: 0.002, offset: 0.004 })
    expect(Buffer.from(a.positions.buffer).equals(Buffer.from(b.positions.buffer))).toBe(true)
    expect(Buffer.from(a.indices.buffer).equals(Buffer.from(b.indices.buffer))).toBe(true)
  })
})

describe('smoothMesh', () => {
  it('shrinks a closed surface slightly and keeps its topology', () => {
    const env = envelopeOf([box([0, 0, 0], [0.02, 0.02, 0.02])], { voxel: 0.002, offset: 0.002, smooth: 0 })
    const before = measure(env).signedVolume
    const tris = env.indices.length
    smoothMesh(env, 3)
    expect(env.indices.length).toBe(tris)
    expect(measure(env).signedVolume).toBeLessThan(before)
    expect(measure(env).signedVolume).toBeGreaterThan(0.8 * before)
  })
})

describe('deriveFat', () => {
  // 10 cm 立方体“皮肤”，内有 6 cm 立方体“肌肉”，四周 2 cm 的间隙即脂肪
  // a 10 cm cube of "skin" round a 6 cm cube of "muscle": the 2 cm gap all round is the fat
  const skin = box([0, 0, 0], [0.1, 0.1, 0.1])
  const muscle = box([0.02, 0.02, 0.02], [0.08, 0.08, 0.08])
  const boneA = surfacePoints(box([0.06, 0.04, 0.04], [0.07, 0.06, 0.06]), 0.004)
  const boneB = surfacePoints(box([0.03, 0.04, 0.04], [0.04, 0.06, 0.06]), 0.004)
  const run = () => deriveFat(skin, [muscle], [{ region: 'a', bonePoints: boneA }, { region: 'b', bonePoints: boneB }], { voxel: 0.002, closing: 0.004, maxDepth: 0.03, smooth: 1 })

  it('fills the gap between the skin and the deep solids and splits it by nearest bone', () => {
    const res = run()
    expect(res.bodyVolume * 1e6).toBeGreaterThan(850)
    expect(res.bodyVolume * 1e6).toBeLessThan(1000)
    expect(res.regions.map((r) => r.region)).toEqual(['a', 'b'])
    const total = res.regions.reduce((s, r) => s + r.volume, 0) * 1e6
    // 精确间隙为 1000 − 216 = 784 ml；体素化的皮肤和深部界面各占去一层
    // the exact gap is 1000 − 216 = 784 ml; the voxelised skin and the deep interface each take a layer
    expect(total).toBeGreaterThan(550)
    expect(total).toBeLessThan(784)
    const a = res.regions[0]!
    const b = res.regions[1]!
    expect(Math.abs(a.volume - b.volume) / a.volume).toBeLessThan(0.1)
    for (const r of res.regions) {
      expect(r.thickness.median).toBeGreaterThan(0.012)
      expect(r.thickness.median).toBeLessThanOrEqual(0.022)
      expect(r.skinCovered).toBeGreaterThan(0.95)
      expect(measure(r.mesh).signedVolume).toBeGreaterThan(0)
      // 网格在皮肤之内、不进入肌肉内部 / the mesh stays inside the skin and out of the muscle's interior
      let outside = 0
      let deepInside = 0
      for (let v = 0; v < r.mesh.positions.length / 3; v++) {
        const p = [0, 1, 2].map((k) => r.mesh.positions[3 * v + k]!)
        if (p.some((x) => x <= 0 || x >= 0.1)) outside++
        if (p.every((x) => x > 0.024 && x < 0.076)) deepInside++
      }
      expect(outside).toBe(0)
      expect(deepInside).toBe(0)
    }
    // 区域 a 在 +X 一侧 / region a is on the +X side
    expect(measure(a.mesh).centroid[0]).toBeGreaterThan(measure(b.mesh).centroid[0])
  })

  it('is deterministic', () => {
    const x = run()
    const y = run()
    for (let i = 0; i < x.regions.length; i++) {
      expect(Buffer.from(x.regions[i]!.mesh.positions.buffer).equals(Buffer.from(y.regions[i]!.mesh.positions.buffer))).toBe(true)
    }
  })

  it('names regions from bones and recognises fat part ids', () => {
    expect(fatRegionOfBone('Left humerus')).toBe('upper_limb_L')
    expect(fatRegionOfBone('Distal phalanx of right little toe')).toBe('lower_limb_R')
    expect(fatRegionOfBone('Navicular bone of left foot')).toBe('lower_limb_L')
    expect(fatRegionOfBone('Left scaphoid')).toBe('upper_limb_L')
    expect(fatRegionOfBone('Fifth cervical vertebra')).toBe('neck')
    expect(fatRegionOfBone('Mandible')).toBe('head')
    expect(fatRegionOfBone('Left nasal bone')).toBe('head')
    expect(fatRegionOfBone('Left scapula')).toBe('trunk')
    expect(fatRegionOfBone('Right hip bone')).toBe('trunk')
    expect(fatRegionOfBone('Sacrum')).toBe('trunk')
    expect(isFatPart('SOMA_fat_trunk')).toBe(true)
    expect(isFatPart('W_SOMA_fat_head')).toBe(true)
    expect(isFatPart('SOMA_pericardium')).toBe(false)
  })
})

describe('capHoles', () => {
  it('closes an open tube with consistently wound caps', () => {
    // 去掉盒子的两个端面（z = 0 和 z = 1），得到两端开口的方管
    // drop the two end faces of a box (z = 0 and z = 1): a square tube open at both ends
    const full = box([0, 0, 0], [0.01, 0.02, 0.05])
    const open: Mesh = { positions: full.positions, indices: full.indices.slice(12) }
    expect(openOrNonManifoldEdges(open)).toBe(8)
    const { mesh, holes } = capHoles(open)
    expect(holes).toBe(2)
    expect(openOrNonManifoldEdges(mesh)).toBe(0)
    expect(mesh.indices.length / 3).toBe(open.indices.length / 3 + 8)
    expect(measure(mesh).signedVolume).toBeCloseTo(measure(full).signedVolume, 10)
  })

  it('leaves a closed mesh alone', () => {
    const full = box([0, 0, 0], [1, 1, 1])
    const { mesh, holes } = capHoles(full)
    expect(holes).toBe(0)
    expect(mesh.indices.length).toBe(full.indices.length)
  })
})
