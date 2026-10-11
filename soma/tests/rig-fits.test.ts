// 骨架绑定的拟合与数值工具的单元测试（合成数据）。
// Unit tests of the rig's fits and numeric helpers, on synthetic data.

import { describe, expect, it } from 'vitest'
import { quantise, weld } from '../tools/rig/bind.ts'
import { type Sample, fitRevolutionAxis, fitSphere, fitSphereRobust, pca } from '../tools/rig/fits.ts'
import { Surface, meshVolume } from '../tools/rig/geom.ts'
import { nelderMead, refineHinge } from '../tools/rig/hinge.ts'
import { type V3, axisAngle, cross, dot, eigSym, m3apply, norm, solve, sub } from '../tools/rig/math.ts'
import { OsimModel, naturalSpline, parseXml, wrapCylinder } from '../tools/rig/opensim.ts'

/** 确定性的伪随机数。 Deterministic pseudo-random numbers. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

/** 经纬球网格。 A latitude-longitude sphere mesh. */
function sphereMesh(c: V3, r: number, n = 24): { positions: Float32Array; indices: Uint32Array } {
  const pos: number[] = [], idx: number[] = []
  for (let i = 0; i <= n; i++) {
    const th = (Math.PI * i) / n
    for (let j = 0; j < 2 * n; j++) {
      const ph = (Math.PI * j) / n
      pos.push(c[0] + r * Math.sin(th) * Math.cos(ph), c[1] + r * Math.cos(th), c[2] + r * Math.sin(th) * Math.sin(ph))
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < 2 * n; j++) {
      const a = i * 2 * n + j, b = i * 2 * n + ((j + 1) % (2 * n)), d = a + 2 * n, e = b + 2 * n
      idx.push(a, b, d, b, e, d)
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }
}

/** 圆柱侧面的一段（绕 axis，角度范围 a0…a1）。 A patch of a cylinder's side about `axis`, over the angles a0…a1. */
function cylinderPatch(point: V3, axis: V3, r: number, len: number, a0: number, a1: number, inward = false): { mesh: { positions: Float32Array; indices: Uint32Array }; samples: Sample[] } {
  const d = norm(axis)
  const u = norm(cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(d, u)
  const na = 40, nl = 10
  const pos: number[] = [], idx: number[] = [], samples: Sample[] = []
  for (let i = 0; i <= na; i++) {
    const a = a0 + ((a1 - a0) * i) / na
    for (let k = 0; k <= nl; k++) {
      const t = (k / nl - 0.5) * len
      const n: V3 = [Math.cos(a) * u[0] + Math.sin(a) * v[0], Math.cos(a) * u[1] + Math.sin(a) * v[1], Math.cos(a) * u[2] + Math.sin(a) * v[2]]
      const p: V3 = [point[0] + d[0] * t + r * n[0], point[1] + d[1] * t + r * n[1], point[2] + d[2] * t + r * n[2]]
      pos.push(...p)
      samples.push({ p, n: inward ? [-n[0], -n[1], -n[2]] : n, w: 1 })
    }
  }
  for (let i = 0; i < na; i++) for (let k = 0; k < nl; k++) {
    const a = i * (nl + 1) + k, b = a + 1, c = a + nl + 1, e = c + 1
    idx.push(a, b, c, b, e, c)
  }
  return { mesh: { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) }, samples }
}

describe('linear algebra', () => {
  it('solves a linear system and diagonalises a symmetric matrix', () => {
    const x = solve([2, 1, 0, 1, 3, 1, 0, 1, 4], [3, 5, 5], 3)!
    expect(x[0]).toBeCloseTo(1, 9)
    expect(x[1]).toBeCloseTo(1, 9)
    expect(x[2]).toBeCloseTo(1, 9)
    const e = eigSym([2, 0, 0, 0, 5, 0, 0, 0, 3], 3)
    expect(e.values.map((v) => Math.round(v))).toEqual([2, 3, 5])
    expect(Math.abs(e.vectors[2]![1]!)).toBeCloseTo(1, 9)
  })
})

describe('sphere fit', () => {
  it('recovers centre and radius from a noisy cap', () => {
    const r = rng(7)
    const c: V3 = [0.087, 0.811, 0.079]
    const samples: Sample[] = []
    for (let i = 0; i < 800; i++) {
      // 只取上半个球帽，像股骨头露在髋臼外的部分 / a cap only, like the part of a femoral head a socket covers
      const th = r() * 1.1, ph = r() * 2 * Math.PI
      const n: V3 = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]
      const rr = 0.0226 + (r() - 0.5) * 0.0004
      samples.push({ p: [c[0] + rr * n[0], c[1] + rr * n[1], c[2] + rr * n[2]], n, w: 1 })
    }
    const f = fitSphere(samples)!
    expect(Math.hypot(f.center[0] - c[0], f.center[1] - c[1], f.center[2] - c[2])).toBeLessThan(0.0002)
    expect(Math.abs(f.radius - 0.0226)).toBeLessThan(0.0002)
    expect(f.rms).toBeLessThan(0.0002)
  })

  it('ignores samples off the sphere when fitted robustly', () => {
    const r = rng(11)
    const samples: Sample[] = []
    for (let i = 0; i < 600; i++) {
      const th = r() * 1.2, ph = r() * 2 * Math.PI
      const n: V3 = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]
      samples.push({ p: [0.02 * n[0], 0.02 * n[1], 0.02 * n[2]], n, w: 1 })
    }
    // 颈部：不在球面上的点 / a neck: points off the sphere
    for (let i = 0; i < 120; i++) samples.push({ p: [0.012 * Math.cos(i), -0.02 - r() * 0.02, 0.012 * Math.sin(i)], n: [1, 0, 0], w: 1 })
    const plain = fitSphere(samples)!
    const robust = fitSphereRobust(samples)!
    expect(Math.hypot(...plain.center)).toBeGreaterThan(0.001)
    expect(Math.hypot(...robust.fit.center)).toBeLessThan(0.4 * Math.hypot(...plain.center))
    expect(Math.abs(robust.fit.radius - 0.02)).toBeLessThan(0.001)
  })
})

describe('axis fits', () => {
  it('finds the axis of a surface of revolution from points and normals', () => {
    const axis = norm([0.9, 0.3, -0.2] as V3)
    const { samples } = cylinderPatch([0.21, 1.045, 0.07], axis, 0.011, 0.03, 0.2, 3.4)
    const f = fitRevolutionAxis(samples)!
    expect(Math.abs(dot(f.dir, axis))).toBeGreaterThan(0.9999)
    const off = cross(sub(f.point, [0.21, 1.045, 0.07]), axis)
    expect(Math.hypot(...off)).toBeLessThan(1e-5)
    expect(f.radius).toBeCloseTo(0.011, 5)
  })

  it('principal axes come out in order of spread', () => {
    const r = rng(3)
    const pts: V3[] = []
    for (let i = 0; i < 500; i++) pts.push([r() * 0.3, r() * 0.03, r() * 0.01])
    const p = pca(pts)
    expect(Math.abs(p.axes[0][0])).toBeGreaterThan(0.99)
    expect(Math.abs(p.axes[2][2])).toBeGreaterThan(0.99)
    expect(p.sigma[0]).toBeGreaterThan(p.sigma[1])
  })

  it('Nelder–Mead minimises a quadratic', () => {
    const res = nelderMead((x) => (x[0]! - 1) ** 2 + 3 * (x[1]! + 2) ** 2, [0, 0], [0.5, 0.5], 400)
    expect(res.x[0]).toBeCloseTo(1, 3)
    expect(res.x[1]).toBeCloseTo(-2, 3)
  })

  it('refines a hinge axis so that a concave shell keeps its gap to a convex cylinder', () => {
    // 凸侧：半径 10 mm 的圆柱；凹侧：同轴、半径 11.5 mm 的半个壳。初值偏 8° 且偏移 2 mm。
    // convex side: a cylinder of radius 10 mm; concave side: a coaxial half shell of radius 11.5 mm. The start is 8° and 2 mm off.
    const axis = norm([1, 0.1, 0.05] as V3)
    const c: V3 = [0, 0, 0]
    const convex = new Surface(cylinderPatch(c, axis, 0.01, 0.04, 0, 2 * Math.PI).mesh)
    const shell = cylinderPatch(c, axis, 0.0115, 0.02, -0.9, 0.9, true).samples
    const tilt = m3apply(axisAngle(norm(cross(axis, [0, 1, 0])), 8 * (Math.PI / 180)), axis)
    const start = { point: [0, 0.0015, 0.0014] as V3, dir: tilt }
    const res = refineHinge(shell, convex, start, { sweep: [0, 110], maxEvals: 400, dirWeight: 0, posWeight: 0 })
    expect(res.rmsInit).toBeGreaterThan(0.0005)
    expect(res.rms).toBeLessThan(0.25 * res.rmsInit)
    expect(Math.acos(Math.min(1, Math.abs(dot(res.dir, axis)))) * (180 / Math.PI)).toBeLessThan(2.5)
  })
})

describe('surfaces', () => {
  it('measures distance, containment and volume of a closed mesh', () => {
    const s = new Surface(sphereMesh([0.1, 0.2, 0.3], 0.05))
    expect(s.distance(0.1, 0.2, 0.4)).toBeCloseTo(0.05, 3)
    expect(s.contains(0.1, 0.2, 0.33)).toBe(true)
    expect(s.contains(0.1, 0.2, 0.36)).toBe(false)
    expect(s.crossings([0.1, 0.2, 0.1], [0.1, 0.2, 0.5])).toBe(2)
    const v = Math.abs(meshVolume(s.positions, s.indices))
    expect(v).toBeGreaterThan(0.97 * ((4 / 3) * Math.PI * 0.05 ** 3))
    expect(v).toBeLessThan((4 / 3) * Math.PI * 0.05 ** 3)
    const area = s.samples(0.004).reduce((a, x) => a + x.w, 0)
    expect(area).toBeGreaterThan(0.97 * 4 * Math.PI * 0.05 ** 2)
    expect(area).toBeLessThan(4 * Math.PI * 0.05 ** 2)
  })
})

describe('weights', () => {
  it('quantises to four influences that sum to 255', () => {
    const idx = new Uint16Array(4), w = new Uint8Array(4)
    quantise([0.5, 0.25, 0.125, 0.0625, 0.0625], [10, 11, 12, 13, 14], idx, w, 0)
    expect(w[0]! + w[1]! + w[2]! + w[3]!).toBe(255)
    expect(Array.from(idx)).toEqual([10, 11, 12, 13])
    expect(w[0]).toBeGreaterThan(w[1]!)
    quantise([0, 1, 0], [3, 7, 9], idx, w, 0)
    expect(Array.from(w)).toEqual([255, 0, 0, 0])
    expect(idx[0]).toBe(7)
  })

  it('welds duplicated vertices and keeps their adjacency', () => {
    const m = weld(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), Uint32Array.from([0, 1, 2, 3, 4, 5]))
    expect(m.n).toBe(4)
    expect(m.map[1]).toBe(m.map[3])
    expect(m.adjStart[m.n]).toBe(10)
  })
})

describe('OpenSim reader', () => {
  it('parses XML and evaluates a natural cubic spline through its knots', () => {
    const x = parseXml('<?xml version="1.0"?><A><!-- c --><B name="b1"><v>1 2 3</v></B><C/></A>')
    expect(x.children[0]!.tag).toBe('A')
    expect(x.children[0]!.children[0]!.name).toBe('b1')
    expect(x.children[0]!.children[0]!.children[0]!.text.trim()).toBe('1 2 3')
    const f = naturalSpline([0, 1, 2, 3], [0, 1, 4, 9])
    expect(f(1)).toBeCloseTo(1, 9)
    expect(f(2)).toBeCloseTo(4, 9)
    expect(f(1.5)).toBeGreaterThan(1.8)
    expect(f(1.5)).toBeLessThan(2.6)
  })

  it('wraps a path around a cylinder by the shortest way', () => {
    // 两点分居圆柱两侧，直线穿过轴心：最短路径 = 两条切线 + 一段弧
    // two points on opposite sides, the straight line through the axis: two tangents plus an arc
    const r = 0.02, d = 0.05
    const w = wrapCylinder([-d, 0, 0], [d, 0, 0], r)!
    const tangent = Math.sqrt(d * d - r * r), arc = Math.PI - 2 * Math.acos(r / d)
    expect(w.length).toBeCloseTo(2 * tangent + r * arc, 9)
    expect(wrapCylinder([-d, 0.03, 0], [d, 0.03, 0], r)).toBeNull()
  })

  it('computes a path length through a pin joint with a conditional point', () => {
    const osim = `<OpenSimDocument Version="40000"><Model name="m"><credits>test</credits>
      <BodySet><objects><Body name="a"/><Body name="b"/></objects></BodySet>
      <JointSet><objects>
        <WeldJoint name="g"><socket_parent_frame>ground_offset</socket_parent_frame><socket_child_frame>a_offset</socket_child_frame>
          <frames><PhysicalOffsetFrame name="ground_offset"><socket_parent>/ground</socket_parent><translation>0 0 0</translation><orientation>0 0 0</orientation></PhysicalOffsetFrame>
          <PhysicalOffsetFrame name="a_offset"><socket_parent>/bodyset/a</socket_parent><translation>0 0 0</translation><orientation>0 0 0</orientation></PhysicalOffsetFrame></frames></WeldJoint>
        <PinJoint name="k"><socket_parent_frame>a_offset</socket_parent_frame><socket_child_frame>b_offset</socket_child_frame>
          <coordinates><Coordinate name="q"><default_value>0</default_value></Coordinate></coordinates>
          <frames><PhysicalOffsetFrame name="a_offset"><socket_parent>/bodyset/a</socket_parent><translation>0 -0.4 0</translation><orientation>0 0 0</orientation></PhysicalOffsetFrame>
          <PhysicalOffsetFrame name="b_offset"><socket_parent>/bodyset/b</socket_parent><translation>0 0 0</translation><orientation>0 0 0</orientation></PhysicalOffsetFrame></frames></PinJoint>
      </objects></JointSet>
      <ForceSet><objects><Thelen2003Muscle name="mus"><GeometryPath><PathPointSet><objects>
        <PathPoint name="p1"><socket_parent_frame>/bodyset/a</socket_parent_frame><location>0.03 -0.1 0</location></PathPoint>
        <ConditionalPathPoint name="p2"><socket_parent_frame>/bodyset/a</socket_parent_frame><location>0.04 -0.4 0</location><range>1 3</range><socket_coordinate>/jointset/k/q</socket_coordinate></ConditionalPathPoint>
        <PathPoint name="p3"><socket_parent_frame>/bodyset/b</socket_parent_frame><location>0.03 -0.1 0</location></PathPoint>
      </objects></PathPointSet></GeometryPath></Thelen2003Muscle></objects></ForceSet></Model></OpenSimDocument>`
    const m = new OsimModel(osim)
    expect(m.coordinates).toEqual(['q'])
    expect(m.length('mus', { q: 0 })).toBeCloseTo(0.4, 9)
    // 关节转 90°：b 上的点 (0.03, −0.1) 转到 (0.1, 0.03)，再加上关节位置 (0, −0.4)
    // joint at 90°: the point (0.03, −0.1) of b turns to (0.1, 0.03), offset by the joint at (0, −0.4)
    const viaOff = Math.hypot(0.1 - 0.03, -0.37 + 0.1)
    expect(m.length('mus', { q: 0.5 })).toBeLessThan(0.4)
    const viaOn = Math.hypot(0.04 - 0.03, -0.4 + 0.1) + Math.hypot(0.1 - 0.04, -0.37 + 0.4)
    expect(m.length('mus', { q: Math.PI / 2 })).toBeCloseTo(viaOn, 6)
    expect(viaOn).toBeGreaterThan(viaOff)
  })
})

describe('external skin weights', () => {
  it('maps another skeleton onto this rig, sending helper joints to their parent', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { loadExternalWeights } = await import('../tools/rig/external.ts')
    const dir = mkdtempSync(join(tmpdir(), 'rig-ext-'))
    try {
      // 外部骨架：root → upleg → (twist 辅助骨, lowleg)；ball 映射到本骨架没有的 id
      // the other skeleton: root → upleg → (a twist helper, lowleg); "ball" maps to an id this rig does not have
      writeFileSync(join(dir, 'joints.json'), JSON.stringify({
        names: ['root', 'upleg', 'upleg_twist', 'lowleg', 'ball'],
        parents: [-1, 0, 1, 1, 3],
        mapping: [{ anatomical: 'pelvis' }, { anatomical: 'hip_L' }, { anatomical: null }, { anatomical: 'knee_L' }, { anatomical: 'mtp_L' }],
      }))
      const rec: [number, number, number][] = [[0, 1, 0.5], [0, 2, 0.5], [1, 3, 0.25], [1, 4, 0.75], [2, 0, 2]]
      const buf = new Uint8Array(rec.length * 12)
      const dv = new DataView(buf.buffer)
      rec.forEach(([v, j, w], i) => {
        dv.setUint32(i * 12, v, true)
        dv.setUint32(i * 12 + 4, j, true)
        dv.setFloat32(i * 12 + 8, w, true)
      })
      writeFileSync(join(dir, 'weights.bin'), buf)
      const w = loadExternalWeights(dir, ['pelvis', 'hip_L', 'knee_L'])!
      expect(w.vertexCount).toBe(3)
      // 顶点 0：髋 0.5 + 扭转骨 0.5 → 全部归髋 / vertex 0: hip 0.5 + twist helper 0.5 → all on the hip
      expect([...w.rows[0]!]).toEqual([[1, 1]])
      // 顶点 1：膝 0.25 + ball 0.75（id 不认识，归父关节即膝）/ vertex 1: knee 0.25 + ball 0.75 (unknown id → its parent, the knee)
      expect([...w.rows[1]!]).toEqual([[2, 1]])
      // 顶点 2：权重归一化 / vertex 2: weights are normalised
      expect([...w.rows[2]!]).toEqual([[0, 1]])
      expect(w.notes.some((n) => n.includes('mtp_L'))).toBe(true)
      expect(w.mapped.find((m) => m.external === 'upleg_twist')).toEqual({ external: 'upleg_twist', joint: 'hip_L', how: 'parent' })
      expect(loadExternalWeights(join(dir, 'absent'), ['pelvis'])).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
