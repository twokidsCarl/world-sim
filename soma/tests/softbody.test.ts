// 软组织求解器（src/softbody/）的解析算例：不读任何生成的数据，几秒钟跑完。
// Analytic cases for the soft-tissue solver (src/softbody/): no generated data is read, and they run in seconds.

import { describe, expect, it } from 'vitest'
import { decodeSoft, embedPoints, encodeSoft } from '../src/softbody/body.ts'
import { barycentric, boxKuhn, boxLattice, locateSlot } from '../src/softbody/lattice.ts'
import { solveZeroGravityRest } from '../src/softbody/rest.ts'
import { type PointSet, type SolverOptions, SoftSolver, lame } from '../src/softbody/solver.ts'

const E = 10e3, RHO = 1000

function bar(n: [number, number, number], cell: number, nu: number, opts: SolverOptions, pin?: (x: number, y: number, z: number) => boolean, extra: Record<string, unknown> = {}) {
  const m = boxKuhn(n, cell)
  const T = m.tets.length / 4, N = m.nodes.length / 3
  const { mu, lambda } = lame(E, nu)
  const pinned = new Uint8Array(N)
  if (pin) for (let i = 0; i < N; i++) pinned[i] = pin(m.nodes[i * 3]!, m.nodes[i * 3 + 1]!, m.nodes[i * 3 + 2]!) ? 1 : 0
  const s = new SoftSolver({ nodes: m.nodes, tets: m.tets, mu: new Float32Array(T).fill(mu), lambda: new Float32Array(T).fill(lambda), density: new Float32Array(T).fill(RHO), pinned, ...extra }, opts)
  /** 平面 axis = v 上各结点某个坐标的平均 / mean of a coordinate over the nodes of the plane axis = v */
  const mean = (axis: number, v: number, of = axis): number => {
    let sum = 0, c = 0
    for (let i = 0; i < N; i++) if (Math.abs(m.nodes[i * 3 + axis]! - v) < 1e-6) (sum += s.x[i * 3 + of]!), c++
    return sum / c
  }
  return { m, s, N, T, mean }
}

/** 在 y = yv 的端面上施加均布面力（按三角形面积分到结点）/ a uniform traction on the end face y = yv (shared out to nodes by triangle area) */
function traction(m: { nodes: Float32Array; tets: Uint32Array }, s: SoftSolver, yv: number, sigma: number, cell: number): void {
  for (let t = 0; t < m.tets.length; t += 4) {
    const on = [m.tets[t]!, m.tets[t + 1]!, m.tets[t + 2]!, m.tets[t + 3]!].filter((i) => Math.abs(m.nodes[i * 3 + 1]! - yv) < 1e-6)
    if (on.length === 3) for (const i of on) s.force[i * 3 + 1] = s.force[i * 3 + 1]! + (sigma * cell * cell) / 6
  }
}

describe('BCC lattice', () => {
  it('locates every point in a tetrahedron that contains it', () => {
    const { lattice, mesh } = boxLattice([0.06, 0.06, 0.06], 0.02)
    const slotTet = new Map<number, number>()
    mesh.slots.forEach((sl, i) => slotTet.set(sl, i))
    const b = [0, 0, 0, 0]
    let seed = 7
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let k = 0; k < 500; k++) {
      const x = 0.012 + 0.036 * rnd(), y = 0.012 + 0.036 * rnd(), z = 0.012 + 0.036 * rnd()
      const t = slotTet.get(locateSlot(lattice, x, y, z))
      expect(t).toBeDefined()
      barycentric(mesh.nodes, mesh.tets[t! * 4]!, mesh.tets[t! * 4 + 1]!, mesh.tets[t! * 4 + 2]!, mesh.tets[t! * 4 + 3]!, x, y, z, b)
      expect(Math.min(...b)).toBeGreaterThan(-1e-5)
    }
    // 所有四面体全等：体积都是 cell³/12 / all tetrahedra are congruent: every volume is cell³/12
    const s = new SoftSolver({ nodes: mesh.nodes, tets: mesh.tets, mu: new Float32Array(mesh.tets.length / 4).fill(1), lambda: new Float32Array(mesh.tets.length / 4).fill(1), density: new Float32Array(mesh.tets.length / 4).fill(1), pinned: new Uint8Array(mesh.nodes.length / 3) })
    for (const v of s.restVolume) expect(v).toBeCloseTo(0.02 ** 3 / 12, 12)
  })
})

describe('XPBD solver, analytic cases', () => {
  it('keeps the rest shape exactly, whatever the step and stiffness', () => {
    for (const [young, sub, dt] of [[1e4, 1, 0.05], [1e7, 1, 0.05], [1e4, 20, 1 / 60]] as const) {
      const { mu, lambda } = lame(young, 0.49)
      const m = boxKuhn([2, 2, 2], 0.02)
      const T = m.tets.length / 4
      const s = new SoftSolver({ nodes: m.nodes, tets: m.tets, mu: new Float32Array(T).fill(mu), lambda: new Float32Array(T).fill(lambda), density: new Float32Array(T).fill(RHO), pinned: new Uint8Array(m.nodes.length / 3) }, { gravity: [0, 0, 0], substeps: sub })
      const x0 = Float64Array.from(s.x)
      for (let i = 0; i < 40; i++) s.step(dt)
      let d = 0
      for (let i = 0; i < x0.length; i++) d = Math.max(d, Math.abs(s.x[i]! - x0[i]!))
      // 结点坐标是 float32：静止构形只精确到 1e-9 m / node coordinates are float32, so the rest configuration is exact to 1e-9 m only
      expect(d).toBeLessThan(1e-7)
    }
  })

  it('reproduces the Young modulus and Poisson ratio in uniaxial tension (within 4 %)', () => {
    for (const nu of [0.3, 0.49]) {
      const n: [number, number, number] = [2, 6, 2], cell = 0.02
      const { m, s, mean } = bar(n, cell, nu, { gravity: [0, 0, 0], substeps: 20, damping: 30 })
      const L = n[1] * cell, sigma = 0.02 * E
      traction(m, s, 0, -sigma, cell)
      traction(m, s, L, sigma, cell)
      s.settle(1 / 60, 1e-6, 600)
      const strain = (mean(1, L) - mean(1, 0) - L) / L
      const lateral = (mean(0, n[0] * cell) - mean(0, 0) - n[0] * cell) / (n[0] * cell)
      expect(sigma / strain / E).toBeGreaterThan(0.96)
      expect(sigma / strain / E).toBeLessThan(1.04)
      expect(-lateral / strain).toBeCloseTo(nu, 1)
    }
  })

  it('preserves volume when nearly incompressible (2 % stretch changes volume by < 0.1 %)', () => {
    const n: [number, number, number] = [2, 6, 2], cell = 0.02
    const { m, s } = bar(n, cell, 0.49, { gravity: [0, 0, 0], substeps: 20, damping: 30 })
    traction(m, s, 0, -0.02 * E, cell)
    traction(m, s, n[1] * cell, 0.02 * E, cell)
    s.settle(1 / 60, 1e-6, 600)
    // 线弹性的体应变 = (1 − 2ν)·ε = 0.04 % / the linear volumetric strain is (1 − 2ν)·ε = 0.04 %
    expect(Math.abs(s.volume() / s.referenceVolume() - 1)).toBeLessThan(1e-3)
  })

  it('a hanging bar sags by ρgL²/2E (within 5 %)', () => {
    const n: [number, number, number] = [2, 8, 2], cell = 0.0125, L = n[1] * cell
    const { s, mean } = bar(n, cell, 0.3, { gravity: [0, -9.81, 0], substeps: 20, damping: 20 }, (_x, y) => Math.abs(y - L) < 1e-6)
    s.settle(1 / 60, 1e-6, 800)
    const sag = -mean(1, 0), exact = (RHO * 9.81 * L * L) / (2 * E)
    expect(sag / exact).toBeGreaterThan(0.95)
    expect(sag / exact).toBeLessThan(1.05)
  })

  it('is deterministic', () => {
    const run = (): Float64Array => {
      const { s } = bar([2, 5, 2], 0.02, 0.45, { gravity: [3, -9.81, 1], substeps: 8, damping: 2 }, (_x, y) => y > 0.099)
      for (let i = 0; i < 60; i++) s.step(1 / 60)
      return s.x
    }
    expect(Array.from(run())).toEqual(Array.from(run()))
  })

  it('loses energy monotonically under damping once released', () => {
    const { s } = bar([2, 6, 2], 0.02, 0.45, { gravity: [0, -9.81, 0], substeps: 20, damping: 8 }, (_x, y) => y > 0.119)
    // 先在侧向重力下弯到平衡，再把重力转回竖直 / bend to equilibrium under sideways gravity first, then turn gravity back to vertical
    s.gravity = [6, -9.81, 0]
    s.settle(1 / 60, 1e-5, 600)
    s.gravity = [0, -9.81, 0]
    const e: number[] = []
    for (let f = 0; f < 120; f++) {
      s.step(1 / 60)
      if (f % 10 === 9) e.push(s.energy().total)
    }
    for (let i = 1; i < e.length; i++) expect(e[i]!).toBeLessThanOrEqual(e[i - 1]! + 1e-9)
    expect(e[e.length - 1]! - e[0]!).toBeLessThan(0)
  })

  it('zero-gravity reference: the loaded shape is recovered to < 0.1 mm, and the pre-stress alternative moves nothing', () => {
    const n: [number, number, number] = [2, 8, 2], cell = 0.0125, L = n[1] * cell
    const { m, s, N } = bar(n, cell, 0.45, { gravity: [0, -9.81, 0], substeps: 20, damping: 25, prestressGravity: null }, (_x, y) => Math.abs(y - L) < 1e-6)
    const res = solveZeroGravityRest(s, m.nodes, { tolerance: 5e-5, speedTolerance: 1e-6, maxFrames: 600 })
    expect(res.converged).toBe(true)
    expect(res.residuals[res.residuals.length - 1]!).toBeLessThan(1e-4)
    // 无重力形状比受重力的形状短：自由端在上方 / the unloaded shape is shorter than the loaded one: its free end lies higher
    let lift = 0
    for (let i = 0; i < N; i++) if (m.nodes[i * 3 + 1]! < 1e-6) lift = Math.max(lift, res.rest[i * 3 + 1]!)
    expect(lift).toBeGreaterThan(0.003)
    // 往返：以反解的形状为参考，在重力下回到发布的形状 / round trip: from the solved reference, gravity brings back the shipped shape
    const again = bar(n, cell, 0.45, { gravity: [0, -9.81, 0], substeps: 20, damping: 25, prestressGravity: null }, (_x, y) => Math.abs(y - L) < 1e-6)
    again.s.setReference(res.rest, true)
    again.s.settle(1 / 60, 1e-6, 800)
    let worst = 0
    for (let i = 0; i < N * 3; i++) worst = Math.max(worst, Math.abs(again.s.x[i]! - m.nodes[i]!))
    expect(worst).toBeLessThan(1e-4)
    // 预应力做法：站立时净体力为零 / the pre-stress way: zero net body force while standing
    const pre = bar(n, cell, 0.45, { gravity: [0, -9.81, 0], substeps: 10, prestressGravity: [0, -9.81, 0] }, (_x, y) => Math.abs(y - L) < 1e-6)
    for (let f = 0; f < 60; f++) pre.s.step(1 / 60)
    for (let i = 0; i < N * 3; i++) expect(Math.abs(pre.s.x[i]! - m.nodes[i]!)).toBeLessThan(1e-7)
  })

  it('muscle activation shortens the block along the fibre and widens it, volume kept (± 2 %)', () => {
    const n: [number, number, number] = [2, 6, 2], cell = 0.02
    const T = n[0] * n[1] * n[2] * 6
    const fibre = new Float32Array(T * 3)
    for (let e = 0; e < T; e++) fibre[e * 3 + 1] = 1
    const { s, mean } = bar(n, cell, 0.49, { gravity: [0, 0, 0], substeps: 20, damping: 30, activeStrain: 0.3 }, undefined, { fibre, fibreModulus: new Float32Array(T).fill(2 * E), muscle: new Int32Array(T), activeStiffening: new Float32Array(T).fill(3) })
    s.setActivation(new Float32Array([1]))
    s.settle(1 / 60, 1e-6, 900)
    const len = (mean(1, n[1] * cell) - mean(1, 0)) / (n[1] * cell), wid = (mean(0, n[0] * cell) - mean(0, 0)) / (n[0] * cell)
    expect(len).toBeCloseTo(0.7, 2)
    expect(wid).toBeCloseTo(1 / Math.sqrt(0.7), 2)
    expect(Math.abs(s.volume() / s.referenceVolume() - 1)).toBeLessThan(0.02)
  })

  it('lags behind a sudden move of its pinned nodes and comes back to zero displacement', () => {
    const n: [number, number, number] = [2, 6, 2], cell = 0.02, L = n[1] * cell
    const { m, s, N } = bar(n, cell, 0.45, { gravity: [0, 0, 0], substeps: 20, damping: 6 }, (_x, y) => Math.abs(y - L) < 1e-6)
    s.setReference(m.nodes)
    for (let f = 0; f < 5; f++) s.step(1 / 60)
    // 参考构形整体平移 3 cm（骨架动了）/ the reference is translated by 3 cm as a whole (the skeleton moved)
    const moved = Float32Array.from(m.nodes, (v, i) => (i % 3 === 0 ? v + 0.03 : v))
    s.setReference(moved)
    s.step(1 / 60)
    const lagOf = (): number => {
      let w = 0
      for (let i = 0; i < N * 3; i++) w = Math.max(w, Math.abs(s.x[i]! - s.ref[i]!))
      return w
    }
    expect(lagOf()).toBeGreaterThan(0.005)
    for (let f = 0; f < 600; f++) s.step(1 / 60)
    expect(lagOf()).toBeLessThan(1e-6)
  })

  it('a flat probe meets a growing reaction; force control reaches its target', () => {
    const n: [number, number, number] = [6, 3, 6], cell = 0.01
    const { m, s, N } = bar(n, cell, 0.45, { gravity: [0, 0, 0], substeps: 20, damping: 20 }, (_x, y) => y < 1e-6)
    // 顶面的结点作为接触点 / the nodes of the top face as contact points
    const top: number[] = []
    for (let i = 0; i < N; i++) if (Math.abs(m.nodes[i * 3 + 1]! - 0.03) < 1e-6) top.push(i)
    const points: PointSet = { tet: new Uint32Array(top.length), bary: new Float32Array(top.length * 4) }
    top.forEach((node, k) => {
      for (let t = 0; t < m.tets.length; t++) if (m.tets[t] === node) {
        points.tet[k] = t >> 2
        points.bary[k * 4 + (t & 3)] = 1
        break
      }
    })
    const forces: number[] = []
    for (const depth of [0.001, 0.002, 0.003]) {
      s.probe = { shape: { kind: 'flat', center: [0.03, 0.03 - depth, 0.03], axis: [0, -1, 0], radius: 0.012 }, points }
      s.settle(1 / 60, 1e-6, 400)
      forces.push(s.probeForce[1])
    }
    // 反力向上（+y），随深度增大 / the reaction points up (+y) and grows with depth
    expect(forces[0]!).toBeGreaterThan(0)
    expect(forces[1]!).toBeGreaterThan(forces[0]! * 1.5)
    expect(forces[2]!).toBeGreaterThan(forces[1]! * 1.2)
    const target = forces[1]!
    s.probe = { shape: { kind: 'flat', center: [0.03, 0.0305, 0.03], axis: [0, -1, 0], radius: 0.012 }, points, control: { target, admittance: 0.02, axis: [0, -1, 0] } }
    for (let f = 0; f < 900; f++) s.step(1 / 60)
    expect(s.probeForce[1] / target).toBeCloseTo(1, 1)
    expect(0.03 - s.probe.shape.center[1]).toBeCloseTo(0.002, 3)
  })
})

describe('soft.json / soft.bin', () => {
  it('round-trips and embeds points through the lattice', () => {
    const { lattice, mesh } = boxLattice([0.06, 0.06, 0.06], 0.02)
    const N = mesh.nodes.length / 3, T = mesh.tets.length / 4
    const rest0 = Float32Array.from(mesh.nodes, (v, i) => v + (i % 3 === 1 ? 0.001 : 0))
    const anchors: PointSet = { tet: new Uint32Array([3]), bary: new Float32Array([0.1, 0.2, 0.3, 0.4]) }
    const { json, bin } = encodeSoft({ schema: 1, body: 'male', inputs: {}, lattice, gravity: [0, -9.81, 0], joints: ['root'], materials: [{ id: 'fat', name: { zh: '脂肪', en: 'fat' }, young: 2000, poisson: 0.49, density: 920 }], skin: { part: 'skin', thickness: 0.001, material: 0 }, muscles: [], capsules: [], cautions: [] }, {
      nodes: mesh.nodes, tets: mesh.tets, tetSlot: mesh.slots, tetMaterial: new Uint8Array(T), tetFill: new Uint8Array(T).fill(255), tetSkin: new Uint8Array(T), tetMuscle: new Uint16Array(T).fill(0xffff), nodePin: new Int16Array(N).fill(-1), nodeInfluence: new Uint8Array(N * 12), anchors, rest0, embedded: [{ part: 'skin', points: anchors }],
    })
    const soft = decodeSoft(JSON.parse(JSON.stringify(json)), bin)
    expect(Array.from(soft.tets)).toEqual(Array.from(mesh.tets))
    expect(soft.rest0![1]! - soft.nodes[1]!).toBeCloseTo(0.001, 5)
    expect(soft.anchors.bary[3]!).toBeCloseTo(0.4, 4)
    expect(soft.embedded.get('skin')!.tet[0]).toBe(3)
    const e = embedPoints(lattice, soft.slotTet, soft.nodes, soft.tets, [0.03, 0.031, 0.029, 5, 5, 5])
    expect(Array.from(e.inside)).toEqual([1, 0])
    let x = 0
    for (let k = 0; k < 4; k++) x += e.bary[k]! * soft.nodes[soft.tets[e.tet[0]! * 4 + k]! * 3]!
    expect(x).toBeCloseTo(0.03, 6)
  })
})
