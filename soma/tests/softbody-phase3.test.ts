// 软组织求解器第三阶段：Ogden 型脂肪、接触（球形压头、平板）、稳定性。不读任何生成的数据。
// Phase 3 of the soft-tissue solver: Ogden-type fat, contact (spherical probe, flat plate), stability. No generated
// data is read.

import { describe, expect, it } from 'vitest'
import { boxKuhn } from '../src/softbody/lattice.ts'
import { type PressDomain, press } from '../src/softbody/press.ts'
import { blockDomain } from '../tools/softbody/numerics.ts'
import { type PointSet, SoftSolver, ogdenEnergy } from '../src/softbody/solver.ts'

// Mihai 等 2015 表 4，瘦人脂肪 Ogden₄（帕）/ Mihai et al. 2015 Table 4, lean fat, Ogden₄ (Pa)
const FAT = { c: [2342, 4083, -418, -1337], m: [1, -1, 2, -2] }

/** 不可压单轴（λ 沿 y）的名义应力 dW/dλ，W = Σ C_p/(2m_p)·(λ^{2m} + 2λ^{−m} − 3) / nominal stress of incompressible uniaxial loading */
const nominal = (lam: number): number => FAT.c.reduce((s, c, k) => s + c * (lam ** (2 * FAT.m[k]! - 1) - lam ** (-FAT.m[k]! - 1)), 0)

/** 结点本身作为嵌入点（取含它的第一个四面体）/ nodes themselves as embedded points (in the first tetrahedron that has them) */
function nodePoints(nodes: ArrayLike<number>, tets: Uint32Array, keep: (i: number) => boolean): PointSet {
  const tet: number[] = [], bary: number[] = []
  const seen = new Set<number>()
  for (let e = 0; e < tets.length / 4; e++) for (let k = 0; k < 4; k++) {
    const i = tets[e * 4 + k]!
    if (seen.has(i) || !keep(i)) continue
    seen.add(i)
    tet.push(e)
    bary.push(...[0, 1, 2, 3].map((q) => (q === k ? 1 : 0)))
  }
  void nodes
  return { tet: Uint32Array.from(tet), bary: Float32Array.from(bary) }
}

const cof = (f: number[]): number[] => [f[4]! * f[8]! - f[5]! * f[7]!, f[5]! * f[6]! - f[3]! * f[8]!, f[3]! * f[7]! - f[4]! * f[6]!, f[2]! * f[7]! - f[1]! * f[8]!, f[0]! * f[8]! - f[2]! * f[6]!, f[1]! * f[6]! - f[0]! * f[7]!, f[1]! * f[5]! - f[2]! * f[4]!, f[2]! * f[3]! - f[0]! * f[5]!, f[0]! * f[4]! - f[1]! * f[3]!]
function psiOf(f: number[], out = new Float64Array(9)): number {
  const h = cof(f)
  const J = f[0]! * h[0]! + f[1]! * h[1]! + f[2]! * h[2]!
  return ogdenEnergy(f[0]!, f[1]!, f[2]!, f[3]!, f[4]!, f[5]!, f[6]!, f[7]!, f[8]!, J, h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, h[8]!, FAT.c, FAT.m, out)
}

describe('Ogden-type deviatoric energy', () => {
  it('its stress is the derivative of its energy, it vanishes at rest and under pure dilation, and μ₀ = Σ C_p·m_p', () => {
    const F = [1.1, 0.12, -0.05, 0.03, 0.86, 0.07, -0.08, 0.02, 1.04]
    const P = new Float64Array(9)
    psiOf(F, P)
    for (let i = 0; i < 9; i++) {
      const a = [...F], b = [...F]
      a[i] = a[i]! + 1e-6
      b[i] = b[i]! - 1e-6
      expect(Math.abs((psiOf(a) - psiOf(b)) / 2e-6 - P[i]!)).toBeLessThan(1e-3 * Math.max(1, Math.abs(P[i]!)))
    }
    expect(Math.abs(psiOf([1, 0, 0, 0, 1, 0, 0, 0, 1]))).toBeLessThan(1e-9)
    expect(Math.abs(psiOf([1.2, 0, 0, 0, 1.2, 0, 0, 0, 1.2]))).toBeLessThan(1e-6)
    // 小的简单剪切 γ：Ψ ≈ μ₀·γ²/2 / a small simple shear γ: Ψ ≈ μ₀·γ²/2
    const g = 1e-3, mu0 = FAT.c.reduce((s, c, k) => s + c * FAT.m[k]!, 0)
    expect(psiOf([1, g, 0, 0, 1, 0, 0, 0, 1]) / (0.5 * mu0 * g * g)).toBeCloseTo(1, 3)
  })

  it('a block squeezed between two frictionless plates follows the nominal stress of Mihai et al. (λ = 0.8 within 6 %), several times stiffer than at small strain', () => {
    const n: [number, number, number] = [3, 3, 3], cell = 0.01
    const m = boxKuhn(n, cell)
    const T = m.tets.length / 4, N = m.nodes.length / 3
    const s = new SoftSolver({ nodes: m.nodes, tets: m.tets, mu: new Float32Array(T), lambda: new Float32Array(T).fill(2e5), density: new Float32Array(T).fill(2e5), pinned: new Uint8Array(N), ogden: { terms: [FAT], material: new Int16Array(T), scale: new Float32Array(T).fill(1) } }, { gravity: [0, 0, 0], substeps: 20, damping: 30 })
    const L = n[1] * cell, lam = 0.8
    const face = (yv: number): PointSet => nodePoints(m.nodes, m.tets, (i) => Math.abs(m.nodes[i * 3 + 1]! - yv) < 1e-6)
    s.planes = [{ n: [0, 1, 0], d: 0, points: face(0) }, { n: [0, -1, 0], d: -L, points: face(L) }]
    // 上板分 200 帧压到 λ·L，再保持 / the top plate moves to λ·L over 200 frames, then holds
    for (let f = 0; f < 1200; f++) {
      s.planes[1]!.d = -L * (1 - (1 - lam) * Math.min(1, (f + 1) / 200))
      s.step(1 / 60)
    }
    const area = (n[0] * cell) * (n[2] * cell)
    const ratio = s.planeForce[1]! / (-nominal(lam) * area)
    expect(ratio).toBeGreaterThan(0.94)
    expect(ratio).toBeLessThan(1.06)
    // 两块板的力相等（平衡）/ the two plates carry equal forces (equilibrium)
    expect(Math.abs(s.planeForce[0]! / s.planeForce[1]! - 1)).toBeLessThan(0.01)
    // 割线模量：λ = 0.8 时是小应变 E₀ = 3μ₀ 的 4 倍以上 / secant modulus at λ = 0.8 is over four times the small-strain E₀ = 3μ₀
    expect(-nominal(lam) / (1 - lam) / (3 * 97)).toBeGreaterThan(4)
  })
})

/** 接触力分到结点上后按 x、z 象限求和（以压入点为中心）/ contact force gathered on nodes, summed by x–z quadrant (about the site) */
function quadrants(d: PressDomain): number[] {
  const q = [0, 0, 0, 0], pf = d.solver.probePointForce, pts = d.samples.points, s = d.solver
  for (let i = 0; i < pf.length; i++) for (let k = 0; k < 4; k++) {
    const node = s.tets[pts.tet[i]! * 4 + k]!, f = pts.bary[i * 4 + k]! * pf[i]!
    if (f === 0) continue
    const dx = s.ref[node * 3]! - d.site[0], dz = s.ref[node * 3 + 2]! - d.site[2]
    // 正好落在对称轴上的结点平分给两边 / nodes right on an axis of symmetry are split between both sides
    const wx = dx > 1e-9 ? [0, 1] : dx < -1e-9 ? [1, 0] : [0.5, 0.5], wz = dz > 1e-9 ? [0, 1] : dz < -1e-9 ? [1, 0] : [0.5, 0.5]
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) q[a * 2 + b] = q[a * 2 + b]! + f * wx[a]! * wz[b]!
  }
  return q
}

const cell = (r: { cellMm: number }): number => r.cellMm

describe('contact: spherical probe and flat plate', () => {
  it('a sphere pressed into a block: converges with the cell (3 mm against 2 mm within 10 %), force grows faster than depth, and the reaction is symmetric', () => {
    const R = 0.012
    const runs = [0.003, 0.002].map((cell) => {
      const { d } = blockDomain(cell, 0.036, 0.024, R)
      const r2 = press(d, { kind: 'sphere', radiusMm: R * 1000 }, { depthMm: 1.5 })
      const r3 = press(d, { kind: 'sphere', radiusMm: R * 1000 }, { depthMm: 3 })
      const q = quadrants(d)
      return { r2, r3, q, lateral: Math.hypot(d.solver.probeForce[0], d.solver.probeForce[2]) / Math.abs(d.solver.probeForce[1]) }
    })
    expect(Math.abs(runs[0]!.r3.forceN / runs[1]!.r3.forceN - 1)).toBeLessThan(0.1)
    for (const { r2, r3, q, lateral } of runs) {
      // 球：接触面随深度变大，力比深度增长得快（Hertz 的 3/2 次方附近）/ a sphere: the contact grows with depth, so force grows faster than depth (near Hertz's power 3/2)
      const exponent = Math.log(r3.forceN / r2.forceN) / Math.log(2)
      expect(exponent).toBeGreaterThan(1.25)
      expect(exponent).toBeLessThan(1.9)
      // 对称：侧向合力不到法向的 1%，四个象限的力相差不到 5% / symmetry: lateral force under 1 % of the normal one, the four quadrants within 5 %
      expect(lateral).toBeLessThan(0.01)
      const mean = q.reduce((a, b) => a + b, 0) / 4
      // Kuhn 剖分本身不镜像对称：3 mm 时差 6%，2 mm 时 3.5%，随单元变小 / the Kuhn split itself is not mirror-symmetric: 6 % at 3 mm, 3.5 % at 2 mm, shrinking with the cell
      for (const v of q) expect(Math.abs(v / mean - 1)).toBeLessThan(cell(r3) > 2.5 ? 0.08 : 0.05)
      // 输出：深度、力、峰值接触压强（大于平均压强：球下压强中间高）/ outputs: depth, force, peak contact pressure (above the mean: pressure under a sphere peaks in the middle)
      expect(r3.depthMm).toBeCloseTo(3, 5)
      expect(r3.peakPressureKPa).toBeGreaterThan(r3.meanPressureKPa)
      expect(Math.max(r3.pressureProfile[0]!.kPa, r3.pressureProfile[1]!.kPa)).toBeGreaterThan(r3.pressureProfile[4]!.kPa)
    }
  })

  it('a flat plate wider than the block: whole top face in contact, converges with the cell (6 mm against 4 mm within 10 %), symmetric', () => {
    const runs = [0.006, 0.004].map((cell) => {
      const { d } = blockDomain(cell, 0.048, 0.024, 0.03)
      const r = press(d, { kind: 'plate', radiusMm: 30 }, { depthMm: 1.5 })
      return { r, q: quadrants(d) }
    })
    expect(Math.abs(runs[0]!.r.forceN / runs[1]!.r.forceN - 1)).toBeLessThan(0.1)
    for (const { r, q } of runs) {
      expect(r.contactAreaMm2 / (48 * 48)).toBeGreaterThan(0.9)
      expect(r.contactAreaMm2 / (48 * 48)).toBeLessThan(1.05)
      expect(r.edgeCompensationMm).toBe(0)
      const mean = q.reduce((a, b) => a + b, 0) / 4
      for (const v of q) expect(Math.abs(v / mean - 1)).toBeLessThan(0.05)
    }
  })
})
