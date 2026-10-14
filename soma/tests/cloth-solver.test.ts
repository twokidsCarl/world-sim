// 布料求解器的物理检查（小型样例，几秒内跑完）。
// Physical checks of the cloth solver (small fixtures, done in seconds).
//
//   · 两边夹住的方布在重力下的垂度：与不可伸长悬链线的解析解比较。
//     Sag of a square hung between two clamped edges, against the analytic inextensible catenary.
//   · Peirce（1930）悬臂法：伸出长度为两倍弯曲长度 c = (B / w)^(1/3) 的布条，自由端下垂 41.5°。
//     Peirce's (1930) cantilever: a strip overhanging twice its bending length c = (B / w)^(1/3) droops by 41.5°.
//   · 能量：10 000 个子步内总能量不增加。
//     Energy: the total does not grow over 10,000 substeps.
//   · Cusick（1968）垂坠系数：30 cm 圆布放在 18 cm 圆盘上。
//     Cusick (1968) drape coefficient: a 30 cm circle on an 18 cm disc.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClothSolver, type FabricMechanics } from '../src/cloth/solver.ts'
import { DiscCollider } from '../src/cloth/collider.ts'
import { triangulatePolygon } from '../tools/cloth/triangulate.ts'

const FABRICS = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'curated', 'cloth', 'fabrics.json'), 'utf8')) as {
  fabrics: Record<string, { solver: FabricMechanics; drape?: { range: [number, number] } }>
}).fabrics

function polygonMesh(boundary: number[], h: number): { uv: Float64Array; tri: Uint32Array } {
  const t = triangulatePolygon(boundary, h)
  if (t.missing) throw new Error('triangulation lost boundary segments')
  return { uv: Float64Array.from(t.points), tri: t.triangles }
}

function rectangle(w: number, l: number, h: number): { uv: Float64Array; tri: Uint32Array } {
  const b: number[] = []
  const nw = Math.round(w / h), nl = Math.round(l / h)
  for (let i = 0; i < nl; i++) b.push((i * l) / nl, 0)
  for (let i = 0; i < nw; i++) b.push(l, (i * w) / nw)
  for (let i = 0; i < nl; i++) b.push(l - (i * l) / nl, w)
  for (let i = 0; i < nw; i++) b.push(0, w - (i * w) / nw)
  return polygonMesh(b, h)
}

function circle(r: number, h: number): { uv: Float64Array; tri: Uint32Array } {
  const n = Math.round((2 * Math.PI * r) / h)
  const b: number[] = []
  for (let i = 0; i < n; i++) b.push(r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n))
  return polygonMesh(b, h)
}

/** 平铺在 y = height 的水平面上（u → x，v → z）/ Laid flat in the plane y = height (u → x, v → z). */
function flat(uv: Float64Array, height: number): Float64Array {
  const n = uv.length / 2
  const p = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) {
    p[i * 3] = uv[i * 2]!
    p[i * 3 + 1] = height
    p[i * 3 + 2] = uv[i * 2 + 1]!
  }
  return p
}

const settle = (s: ClothSolver, frames: number, substeps = 20, damping = 2): void => {
  for (let f = 0; f < frames; f++) s.step(1 / 60, { gravity: [0, -9.81, 0], substeps, damping })
}

describe('cloth solver', () => {
  it('hangs a square between two clamped edges with the catenary sag', () => {
    // 0.3 m 见方的斜纹布，两条对边夹在相距 0.2 m 的两根横杆上（几乎不伸长；弯曲刚度调到可以忽略）
    // a 0.3 m square of twill, two opposite edges clamped on bars 0.2 m apart (nearly inextensible; bending made negligible)
    const L = 0.3, S = 0.2, h = 0.015
    const m = rectangle(L, L, h)
    const fabric = { ...FABRICS['cotton-twill']!.solver, bending: 1e-9 }
    const pos = flat(m.uv, 1)
    const n = m.uv.length / 2
    // 起始形状：一段正弦拱（避免平面内被压缩的布停在压缩态）/ start as a sine sag (a sheet compressed in its plane could stay compressed)
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (m.uv[i * 2]! * S) / L
      pos[i * 3 + 1] = 1 - 0.08 * Math.sin((Math.PI * m.uv[i * 2]!) / L)
    }
    const s = new ClothSolver({ positions: pos, uv: m.uv, triangles: m.tri, fabric })
    for (let i = 0; i < n; i++) {
      const u = m.uv[i * 2]!
      if (u < 1e-9) s.pin(i, [0, 1, m.uv[i * 2 + 1]!])
      if (u > L - 1e-9) s.pin(i, [S, 1, m.uv[i * 2 + 1]!])
    }
    settle(s, 300, 30, 4)
    let low = Infinity
    for (let i = 0; i < n; i++) low = Math.min(low, s.x[i * 3 + 1]!)
    // 解析解：L = 2a·sinh(S / 2a)，垂度 = a·(cosh(S / 2a) − 1) / analytic: L = 2a·sinh(S / 2a), sag = a·(cosh(S / 2a) − 1)
    let lo = 0.001, hi = 10
    for (let k = 0; k < 200; k++) {
      const a = (lo + hi) / 2
      if (2 * a * Math.sinh(S / (2 * a)) > L) lo = a
      else hi = a
    }
    const a = (lo + hi) / 2
    const sag = a * (Math.cosh(S / (2 * a)) - 1)
    const sim = 1 - low
    expect(Math.abs(sim - sag) / sag).toBeLessThan(0.04)
  })

  it('gives a sheet bent into a cylinder the plate bending energy', () => {
    // ½·B·κ²·A；有限的布片边缘没有弯曲模板，所以略低 / ½·B·κ²·A; a finite sheet has no stencils along its border, so slightly less
    const B = 1e-5, R = 0.1
    for (const along of ['u', 'v'] as const) {
      const m = rectangle(0.1, 0.1, 0.005)
      const n = m.uv.length / 2
      const pos = new Float64Array(n * 3)
      for (let i = 0; i < n; i++) {
        const a = along === 'u' ? m.uv[i * 2]! : m.uv[i * 2 + 1]!, o = along === 'u' ? m.uv[i * 2 + 1]! : m.uv[i * 2]!
        const X = R * Math.sin(a / R), Y = R * (1 - Math.cos(a / R))
        pos.set(along === 'u' ? [X, Y, o] : [o, Y, X], i * 3)
      }
      const s = new ClothSolver({ positions: pos, uv: m.uv, triangles: m.tri, fabric: { density: 0.1, stretchWarp: 1, stretchWeft: 1, shear: 1, bending: B, thickness: 0.001, friction: 0 } })
      const ratio = s.energy().bend / (0.5 * (B / (R * R)) * 0.01)
      expect(ratio, along).toBeGreaterThan(0.85)
      expect(ratio, along).toBeLessThan(1.02)
    }
  })

  it('droops a Peirce cantilever of twice the bending length by about 41.5°', () => {
    for (const id of ['cotton-twill', 'cotton-jersey']) {
      const f = FABRICS[id]!.solver
      // 弯曲长度 c = (B / (ρ g))^(1/3)；伸出 2c / bending length c = (B / (ρ g))^(1/3); overhang 2c
      const c = Math.cbrt(f.bending / (f.density * 9.81))
      const over = 2 * c, clamp = 0.02, w = 0.02, h = Math.min(0.004, over / 12)
      const m = rectangle(w, over + clamp, h)
      const s = new ClothSolver({ positions: flat(m.uv, 1), uv: m.uv, triangles: m.tri, fabric: f })
      const n = m.uv.length / 2
      for (let i = 0; i < n; i++) if (m.uv[i * 2]! <= clamp + 1e-9) s.pin(i)
      // 小步长要足够多，弯曲才收敛到给定的刚度 / enough small steps for the bending to converge to the given rigidity
      settle(s, 300, 200, 6)
      // 夹口到自由端中点的弦与水平的夹角 / angle between the horizontal and the chord from the clamp edge to the tip
      let tipX = 0, tipY = 0, k = 0
      for (let i = 0; i < n; i++) {
        if (m.uv[i * 2]! < over + clamp - 1e-9) continue
        tipX += s.x[i * 3]!
        tipY += s.x[i * 3 + 1]!
        k++
      }
      const angle = (Math.atan2(1 - tipY / k, tipX / k - clamp) * 180) / Math.PI
      // ±10°：窄条的边缘没有弯曲模板，等效刚度低约两成 / ±10°: the strip's edges have no stencils, so the effective rigidity is about a fifth lower
      expect(angle, id).toBeGreaterThan(41.5 - 10)
      expect(angle, id).toBeLessThan(41.5 + 10)
    }
  })

  it('does not gain energy over 10,000 substeps', () => {
    // 10 cm 方布（弹力针织：约束收敛得好，按真实刚度算的弹性能才有意义），一条边夹住，从偏离竖直 40° 处摆下
    // （已经绷直：从水平放开会在拉直时“猛拽”一下，任何布料模型都不守恒）
    // a 10 cm square of the elastane knit (its constraints converge well, so elastic energy at the true stiffness
    // is meaningful), clamped along one edge and let swing from 40° off the vertical (already hanging taut: a
    // release from horizontal ends in a snap that no cloth model conserves)
    const m = rectangle(0.1, 0.1, 0.01)
    const fabric = FABRICS['poly-elastane']!.solver
    const pos = flat(m.uv, 0)
    const tilt = (40 * Math.PI) / 180
    for (let i = 0; i < pos.length / 3; i++) {
      const u = m.uv[i * 2]!
      pos[i * 3] = u * Math.sin(tilt)
      pos[i * 3 + 1] = -u * Math.cos(tilt)
    }
    const s = new ClothSolver({ positions: pos, uv: m.uv, triangles: m.tri, fabric })
    const n = m.uv.length / 2
    for (let i = 0; i < n; i++) if (m.uv[i * 2]! < 1e-9) s.pin(i)
    // 能量尺度：布重 × 边长 / energy scale: the cloth's weight × its side
    const scale = fabric.density * 0.01 * 9.81 * 0.1
    const e0 = s.energy().total
    const energies: number[] = []
    const opt = { gravity: [0, -9.81, 0] as [number, number, number], substeps: 20, damping: 0 }
    for (let f = 0; f < 500; f++) {
      s.step(1 / 60, opt)
      energies.push(s.energy().total)
    }
    expect(Math.max(...energies)).toBeLessThanOrEqual(e0 + 0.02 * scale)
    // 后一半不再上升 / no rise over the second half
    expect(Math.max(...energies.slice(250))).toBeLessThanOrEqual(energies[249]! + 0.02 * scale)
    expect(energies[499]!).toBeLessThan(e0)
  })

  it('drapes a 30 cm circle over an 18 cm disc within the cited range', () => {
    const out: Record<string, number> = {}
    for (const [id, fab] of Object.entries(FABRICS)) {
      const m = circle(0.15, 0.01)
      // 极小的确定性扰动，让褶子能长出来 / a tiny deterministic perturbation so folds can form
      const pos = flat(m.uv, 0.0035)
      for (let i = 0; i < pos.length / 3; i++) pos[i * 3 + 1] = pos[i * 3 + 1]! + 1e-4 * Math.sin(5 * Math.atan2(pos[i * 3 + 2]!, pos[i * 3]!)) * Math.hypot(pos[i * 3]!, pos[i * 3 + 2]!)
      const s = new ClothSolver({ positions: pos, uv: m.uv, triangles: m.tri, fabric: fab.solver })
      s.colliders.push(new DiscCollider(0, 0, 0.09, 0, 0.05, 0.002))
      s.collisionMargin = fab.solver.thickness
      settle(s, 240, 60, 3)
      // 投影面积：把三角形在 xz 平面上栅格化 / shadow area: rasterise the triangles in the xz plane
      const R = 0.16, cell = 0.001, N = Math.ceil((2 * R) / cell)
      const grid = new Uint8Array(N * N)
      for (let t = 0; t < m.tri.length; t += 3) {
        const P = [0, 1, 2].map((k) => [s.x[m.tri[t + k]! * 3]!, s.x[m.tri[t + k]! * 3 + 2]!] as [number, number])
        const x0 = Math.floor((Math.min(...P.map((p) => p[0])) + R) / cell), x1 = Math.ceil((Math.max(...P.map((p) => p[0])) + R) / cell)
        const z0 = Math.floor((Math.min(...P.map((p) => p[1])) + R) / cell), z1 = Math.ceil((Math.max(...P.map((p) => p[1])) + R) / cell)
        for (let gx = Math.max(0, x0); gx <= Math.min(N - 1, x1); gx++) {
          for (let gz = Math.max(0, z0); gz <= Math.min(N - 1, z1); gz++) {
            const px = gx * cell - R + cell / 2, pz = gz * cell - R + cell / 2
            const d = (a: [number, number], b: [number, number]): number => (b[0] - a[0]) * (pz - a[1]) - (b[1] - a[1]) * (px - a[0])
            const d1 = d(P[0]!, P[1]!), d2 = d(P[1]!, P[2]!), d3 = d(P[2]!, P[0]!)
            if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) grid[gx * N + gz] = 1
          }
        }
      }
      const shadow = grid.reduce((a, v) => a + v, 0) * cell * cell
      const disc = Math.PI * 0.09 ** 2, specimen = Math.PI * 0.15 ** 2
      out[id] = (shadow - disc) / (specimen - disc)
      const range = fab.drape!.range
      expect(out[id], id).toBeGreaterThanOrEqual(range[0])
      expect(out[id], id).toBeLessThanOrEqual(range[1])
    }
    // 机织斜纹比针织更挺 / the woven twill is stiffer than the knits
    expect(out['cotton-twill']!).toBeGreaterThan(out['cotton-jersey']!)
    expect(out['cotton-twill']!).toBeGreaterThan(out['poly-elastane']!)
  })
})
