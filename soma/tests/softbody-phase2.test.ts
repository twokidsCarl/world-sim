// 软组织求解器第二阶段各机制的解析算例：体积锁死、压强跨子步保留、应变硬化、Maxwell 支路、退化的参考构形、
// Jacobi 模式、按压接口。不读任何生成的数据。
// Analytic cases for the mechanisms of phase 2 of the soft-tissue solver: volumetric locking, pressure kept across
// substeps, strain stiffening, the Maxwell branch, degenerate references, the Jacobi mode, the pressing interface.
// No generated data is read.

import { describe, expect, it } from 'vitest'
import { anchorStiffness } from '../src/softbody/body.ts'
import { press } from '../src/softbody/press.ts'
import { lame } from '../src/softbody/solver.ts'
import { block, blockDomain, cantilever, punch } from '../tools/softbody/numerics.ts'

describe('volumetric locking', () => {
  it('per-tetrahedron volume constraints lock a bending beam at ν = 0.49; nodal ones do not', () => {
    const tet = cantilever(2, 0.49, 'tet').ratio, node = cantilever(2, 0.49, 'node').ratio, soft = cantilever(2, 0.3, 'node').ratio
    // 梁理论的挠度与 ν 无关：结点约束下 ν = 0.49 应接近 ν = 0.3（同一张粗网格），逐单元约束下只剩三分之一
    // beam theory has no ν in the deflection: with nodal constraints ν = 0.49 stays close to ν = 0.3 (same coarse mesh), with per-tetrahedron ones a third is left
    expect(tet / soft).toBeLessThan(0.4)
    expect(node / soft).toBeGreaterThan(0.75)
    expect(node).toBeLessThan(1.05)
  })

  it('finer cells bring the nearly incompressible beam towards beam theory', () => {
    const coarse = cantilever(2, 0.49, 'node').ratio, fine = cantilever(4, 0.49, 'node').ratio
    expect(fine).toBeGreaterThan(coarse)
    expect(fine).toBeGreaterThan(0.7)
    expect(fine).toBeLessThan(1.05)
  })
})

describe('indentation numerics', () => {
  it('the force of a flat punch does not depend on the number of substeps (kept pressure): 16 against 32 within 5 %', () => {
    const a = punch(0.012, { substeps: 16, size: 0.072, depth: 0.048 }).forceN, b = punch(0.012, { substeps: 32, size: 0.072, depth: 0.048 }).forceN
    expect(Math.abs(a / b - 1)).toBeLessThan(0.05)
  })

  it('the Jacobi mode (mass splitting) reaches the Gauss–Seidel answer with four times the substeps (within 5 %), and is too soft with the same number', () => {
    const gs = cantilever(2, 0.49, 'node', 20).ratio
    const same = cantilever(2, 0.49, 'node', 20, 0, 2, 'jacobi').ratio, more = cantilever(2, 0.49, 'node', 80, 0, 2, 'jacobi').ratio
    expect(Math.abs(more / gs - 1)).toBeLessThan(0.05)
    expect(same / gs).toBeGreaterThan(1.2)
  })
})

describe('press()', () => {
  it('flat punch on a thick block: force near the half-space solution 2·E·a·δ/(1 − ν²), cell 6 mm against 4 mm within 10 %', () => {
    const a = 0.012, delta = 1
    const res = [0.006, 0.004].map((cell) => {
      const { d, young, nu } = blockDomain(cell, 0.072, 0.048, a)
      const r = press(d, { kind: 'flat', radiusMm: a * 1000 }, { depthMm: delta })
      return { r, ratio: r.forceN / ((2 * young * a * delta * 1e-3) / (1 - nu * nu)) }
    })
    // 厚度有限（a/h = 0.25）、底面粘结：力比半空间解大，Hayes 的 κ > 1 / finite thickness (a/h = 0.25) with a bonded base: more force than the half-space, Hayes' κ > 1
    for (const { ratio } of res) {
      expect(ratio).toBeGreaterThan(1)
      expect(ratio).toBeLessThan(1.45)
    }
    expect(Math.abs(res[0]!.ratio / res[1]!.ratio - 1)).toBeLessThan(0.1)
    const r = res[1]!.r
    expect(r.valid).toBe(true)
    // 接触面积 ≈ π·a²，平均压强 = 力 ÷ 面积 / contact area ≈ π·a², mean pressure = force ÷ area
    expect(r.contactAreaMm2 / (Math.PI * 144)).toBeGreaterThan(0.8)
    expect(r.contactAreaMm2 / (Math.PI * 144)).toBeLessThan(1.1)
    expect(r.meanPressureKPa).toBeCloseTo(r.forceN / r.contactAreaMm2 * 1000, 1)
    // 平头压头：压强在边缘高、中心低（半空间解里中心 = 平均值的一半）/ a flat punch: pressure is high at the edge and low at the centre (half the mean in the half-space solution)
    expect(r.pressureProfile[0]!.kPa).toBeLessThan(r.meanPressureKPa)
    expect(r.peakPressureKPa).toBeGreaterThan(r.meanPressureKPa)
    // 近不可压时压头正下方几乎是刚性地下沉，应变的峰值在约一个半径深处，再往下衰减；应变沿深度的积分 = 表面位移
    // nearly incompressible material sinks almost rigidly right under the punch, the strain peaks about one radius deep and decays below; the strain integrates to the surface displacement
    expect(r.strainAtDepth(12)).toBeGreaterThan(r.strainAtDepth(2))
    expect(r.strainAtDepth(12)).toBeGreaterThan(r.strainAtDepth(40))
    let integral = 0
    for (let z = 1; z < 48; z += 2) integral += r.strainAtDepth(z) * 2
    expect(integral / delta).toBeGreaterThan(0.8)
    expect(integral / delta).toBeLessThan(1.15)
  })

  it('force control reaches the target, and a force far outside the validated range comes back flagged, not refused', () => {
    const { d } = blockDomain(0.004, 0.048, 0.032, 0.008)
    const first = press(d, { kind: 'flat', radiusMm: 8 }, { depthMm: 1 })
    d.solver.reset()
    const back = press(d, { kind: 'flat', radiusMm: 8 }, { forceN: first.forceN })
    expect(back.forceN / first.forceN).toBeCloseTo(1, 1)
    expect(back.depthMm).toBeCloseTo(1, 0)
    // 疼痛工具的缺省刺激：50 N 压在 100 mm² 上（半径 5.64 mm）/ the pain tool's default stimulus: 50 N on 100 mm² (radius 5.64 mm)
    const small = blockDomain(0.002, 0.024, 0.016, 0.00564, 6e3, { stiffening: new Float32Array(12 * 8 * 12 * 6).fill(8) })
    const hard = press(small.d, { kind: 'flat', radiusMm: 5.64 }, { forceN: 50 }, { maxFrames: 150 })
    expect(Number.isFinite(hard.forceN)).toBe(true)
    expect(hard.depthMm).toBeGreaterThan(1)
    expect(hard.depthMm).toBeLessThan(16)
    expect(hard.forceN).toBeGreaterThan(0.5)
    expect(hard.valid).toBe(false)
    expect(hard.flags.length).toBeGreaterThan(0)
  })
})

describe('nonlinear and rate-dependent material', () => {
  it('strain stiffening follows σ = μ·(1 + κ·(λ² + 2/λ − 3))·(λ − 1/λ²) in uniaxial tension (within 6 %)', () => {
    const E = 10e3, nu = 0.49, kappa = 8, cell = 0.02
    const n: [number, number, number] = [2, 6, 2]
    const T = n[0] * n[1] * n[2] * 6
    const b = block(n, cell, E, nu, 1000, () => false, { gravity: [0, 0, 0], substeps: 20, damping: 30 }, { stiffening: new Float32Array(T).fill(kappa) })
    const L = n[1] * cell, mu = lame(E, nu).mu
    const lam = 1.2, sigma = mu * (1 + kappa * (lam * lam + 2 / lam - 3)) * (lam - 1 / (lam * lam))
    // 名义应力（按参考面积）加在两端 / nominal traction (per reference area) on both ends
    for (let t = 0; t < b.tets.length; t += 4) for (const [yv, sign] of [[0, -1], [L, 1]] as const) {
      const on = [b.tets[t]!, b.tets[t + 1]!, b.tets[t + 2]!, b.tets[t + 3]!].filter((i) => Math.abs(b.nodes[i * 3 + 1]! - yv) < 1e-6)
      if (on.length === 3) for (const i of on) b.solver.force[i * 3 + 1] = b.solver.force[i * 3 + 1]! + (sign * sigma * cell * cell) / 6
    }
    b.solver.settle(1 / 60, 1e-6, 900)
    const mean = (yv: number): number => {
      let s = 0, c = 0
      for (let i = 0; i < b.nodes.length / 3; i++) if (Math.abs(b.nodes[i * 3 + 1]! - yv) < 1e-6) (s += b.solver.x[i * 3 + 1]!), c++
      return s / c
    }
    const stretch = (mean(L) - mean(0)) / L
    expect((stretch - 1) / (lam - 1)).toBeGreaterThan(0.94)
    expect((stretch - 1) / (lam - 1)).toBeLessThan(1.06)
    // 没有硬化时同样的力拉得长得多 / without stiffening the same traction stretches much further
    expect(lam - 1).toBeLessThan(0.7 * (sigma / E))
  })

  it('a Maxwell branch makes the fast response stiffer by 1 + ratio and relaxes to the long-term one', () => {
    const E = 10e3, nu = 0.49, cell = 0.02, ratio = 3, tau = 0.4
    const n: [number, number, number] = [2, 6, 2]
    const T = n[0] * n[1] * n[2] * 6
    const b = block(n, cell, E, nu, 1000, () => false, { gravity: [0, 0, 0], substeps: 20, damping: 60 }, { branchModulus: new Float32Array(T).fill(ratio * lame(E, nu).mu), branchTau: new Float32Array(T).fill(tau) })
    const L = n[1] * cell, sigma = 0.02 * E
    for (let t = 0; t < b.tets.length; t += 4) for (const [yv, sign] of [[0, -1], [L, 1]] as const) {
      const on = [b.tets[t]!, b.tets[t + 1]!, b.tets[t + 2]!, b.tets[t + 3]!].filter((i) => Math.abs(b.nodes[i * 3 + 1]! - yv) < 1e-6)
      if (on.length === 3) for (const i of on) b.solver.force[i * 3 + 1] = b.solver.force[i * 3 + 1]! + (sign * sigma * cell * cell) / 6
    }
    const strain = (): number => {
      let lo = 0, hi = 0, c = 0
      for (let i = 0; i < b.nodes.length / 3; i++) {
        if (Math.abs(b.nodes[i * 3 + 1]!) < 1e-6) (lo += b.solver.x[i * 3 + 1]!), c++
        if (Math.abs(b.nodes[i * 3 + 1]! - L) < 1e-6) hi += b.solver.x[i * 3 + 1]!
      }
      return ((hi - lo) / c - L) / L
    }
    const final = sigma / E
    // 0.1 s：远小于 τ，支路还没松弛，应变 ≈ 最终值 ÷ (1 + ratio) / at 0.1 s, well before τ, the branch has not relaxed: strain ≈ final ÷ (1 + ratio)
    for (let f = 0; f < 6; f++) b.solver.step(1 / 60)
    expect(strain() / final).toBeGreaterThan(0.15)
    expect(strain() / final).toBeLessThan(0.45)
    for (let f = 0; f < 600; f++) b.solver.step(1 / 60)
    expect(strain() / final).toBeGreaterThan(0.93)
    expect(strain() / final).toBeLessThan(1.05)
  })

  it('with referenceRepair set to rest, a reference crushed by skinning falls back to the rest shape instead of blowing up', () => {
    const cell = 0.02
    const b = block([3, 3, 3], cell, 5e3, 0.49, 1000, (_x, y) => y < 1e-9, { gravity: [0, -9.81, 0], substeps: 10, damping: 5, referenceRepair: 'rest' })
    const N = b.nodes.length / 3
    // 中间一层结点被"蒙皮"压到下面一层的位置之下：那一层的四面体翻转 / the middle layer of nodes is "skinned" below the layer under it: its tetrahedra invert
    const ref = Float32Array.from(b.nodes)
    for (let i = 0; i < N; i++) if (Math.abs(b.nodes[i * 3 + 1]! - 2 * cell) < 1e-6) ref[i * 3 + 1] = 0.5 * cell
    b.solver.setReference(b.nodes)
    b.solver.step(1 / 60)
    for (let f = 0; f < 120; f++) {
      b.solver.setReference(f < 5 ? Float32Array.from(b.nodes, (v, k) => v + ((ref[k]! - v) * (f + 1)) / 5) : ref)
      b.solver.step(1 / 60)
    }
    // 被压坏的那一层用静止形状当参考：结点留在静止位置附近（重力下垂几毫米），没有东西飞走
    // the wrecked layer takes its rest shape as reference: nodes stay near their rest positions (a few millimetres of sag under gravity) and nothing flies off
    let worst = 0
    for (let i = 0; i < N; i++) if (!b.solver.isPinned(i) && Math.abs(b.nodes[i * 3 + 1]! - 2 * cell) > 1e-6) worst = Math.max(worst, Math.hypot(b.solver.x[i * 3]! - b.nodes[i * 3]!, b.solver.x[i * 3 + 1]! - b.nodes[i * 3 + 1]!, b.solver.x[i * 3 + 2]! - b.nodes[i * 3 + 2]!))
    expect(Number.isFinite(worst)).toBe(true)
    expect(worst).toBeLessThan(0.02)
  })
})

describe('anchors', () => {
  it('anchor stiffness vanishes with the bone share, grows without bound towards 1 and scales with the cell', () => {
    expect(anchorStiffness(2300, 0.027, 0)).toBe(0)
    expect(anchorStiffness(2300, 0.027, 0.05)).toBeLessThan(anchorStiffness(2300, 0.027, 0.5))
    expect(anchorStiffness(2300, 0.027, 0.5) / (2300 * 0.027)).toBeGreaterThan(3)
    expect(anchorStiffness(2300, 0.054, 0.3)).toBeCloseTo(2 * anchorStiffness(2300, 0.027, 0.3), 6)
  })
})
