// 乳房的体模：半球形的乳房组织贴在刚性胸壁上，重力从俯卧（背离胸壁）换到仰卧（指向胸壁），量乳头和组织的位移。
// 不读任何人体数据（女性身体正在重建，这里只用几何体），用来把"网格、底面边界条件、乳房大小、材料"几个因素分开。
// A breast phantom: a hemisphere of breast tissue on a rigid chest wall; gravity goes from prone (away from the wall)
// to supine (towards it) and the displacement of the nipple and of the tissue is measured. No body data is read (the
// female body is being rebuilt; this is geometry only); it separates mesh, base boundary condition, breast size and
// material.
//
//   bun tools/softbody/phantom.ts

import { boxKuhn } from '../../src/softbody/lattice.ts'
import { type PointSet, SoftSolver, lame } from '../../src/softbody/solver.ts'

export interface PhantomCase {
  /** 乳房体积，毫升 / breast volume, mL */
  volumeMl: number
  cell: number
  /** 'bonded' = 底面结点钉住；'sliding' = 底面留在胸壁平面上、可无摩擦地滑动（上限），中心一小片钉住防止整体漂走 / 'bonded' = base nodes pinned; 'sliding' = the base stays on the wall plane and slides on it without friction (an upper bound), a small central patch pinned so the whole does not drift */
  base: 'bonded' | 'sliding'
  /** 剪切模量，帕 / shear modulus, Pa */
  shear: number
  /** 重力与胸壁法线的夹角（0 = 正对胸壁），度；仰卧时乳房向外侧倒就是这个角度不为零 / angle between gravity and the wall normal (0 = straight at the wall), degrees: the breast falling sideways in the supine position is this angle */
  tiltDeg?: number
}

export interface PhantomResult {
  nippleMm: number
  meanTissueMm: number
  volumeRatio: number
  tets: number
  frames: number
}

export function phantom(c: PhantomCase): PhantomResult {
  const r = Math.cbrt((3 * c.volumeMl * 1e-6) / (2 * Math.PI))
  const n = Math.ceil((2 * r) / c.cell) + 1, nz = Math.ceil(r / c.cell) + 1
  const m = boxKuhn([n, nz, n], c.cell)
  // 坐标：x、z 在胸壁平面内，y 垂直于胸壁（y = 0 是胸壁）/ frame: x and z in the wall plane, y normal to it (y = 0 is the wall)
  const half = (n * c.cell) / 2
  const keep: number[] = []
  for (let e = 0; e < m.tets.length / 4; e++) {
    let cx = 0, cy = 0, cz = 0
    for (let k = 0; k < 4; k++) {
      const i = m.tets[e * 4 + k]! * 3
      cx += m.nodes[i]! / 4
      cy += m.nodes[i + 1]! / 4
      cz += m.nodes[i + 2]! / 4
    }
    if (Math.hypot(cx - half, cy, cz - half) < r) keep.push(e)
  }
  const tets = new Uint32Array(keep.length * 4)
  keep.forEach((e, k) => tets.set(m.tets.subarray(e * 4, e * 4 + 4), k * 4))
  const used = new Uint8Array(m.nodes.length / 3)
  for (const i of tets) used[i] = 1
  const T = keep.length, N = m.nodes.length / 3
  const E = 2 * c.shear * 1.49, { mu, lambda } = lame(E, 0.49)
  const pinned = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    if (!used[i]) pinned[i] = 1
    else if (m.nodes[i * 3 + 1]! < 1e-9 && (c.base === 'bonded' || Math.hypot(m.nodes[i * 3]! - half, m.nodes[i * 3 + 2]! - half) < 0.25 * r)) pinned[i] = 1
  }
  const s = new SoftSolver({ nodes: m.nodes, tets, mu: new Float32Array(T).fill(mu), lambda: new Float32Array(T).fill(lambda), density: new Float32Array(T).fill(1000), pinned }, { gravity: [0, 9.81, 0], substeps: 16, damping: 6 })
  if (c.base === 'sliding') {
    const tet: number[] = [], bary: number[] = []
    const seen = new Set<number>()
    for (let e = 0; e < T; e++) for (let k = 0; k < 4; k++) {
      const i = tets[e * 4 + k]!
      if (seen.has(i) || pinned[i] || m.nodes[i * 3 + 1]! > 1e-9) continue
      seen.add(i)
      tet.push(e)
      bary.push(...[0, 1, 2, 3].map((q) => (q === k ? 1 : 0)))
    }
    const points: PointSet = { tet: Uint32Array.from(tet), bary: Float32Array.from(bary) }
    // 两张方向相反的平面 = 双侧约束：底面留在胸壁上，只能在面内无摩擦地滑动 / two opposite planes = a bilateral constraint: the base stays on the wall and slides in its plane without friction
    s.planes = [{ n: [0, 1, 0], d: 0, points }, { n: [0, -1, 0], d: 0, points }]
  }
  // 乳头：穹顶最高处的结点 / the nipple: the node at the top of the dome
  let nip = -1, top = -1
  for (let i = 0; i < N; i++) if (used[i] && Math.hypot(m.nodes[i * 3]! - half, m.nodes[i * 3 + 2]! - half) < c.cell && m.nodes[i * 3 + 1]! > top) (top = m.nodes[i * 3 + 1]!), (nip = i)
  const t = ((c.tiltDeg ?? 0) * Math.PI) / 180
  let frames = s.settle(1 / 60, 2e-5, 3000)
  const prone = Float64Array.from(s.x)
  s.gravity = [9.81 * Math.sin(t), -9.81 * Math.cos(t), 0]
  frames += s.settle(1 / 60, 2e-5, 3000)
  let sum = 0, cnt = 0
  for (let i = 0; i < N; i++) if (used[i] && !pinned[i]) (sum += Math.hypot(s.x[i * 3]! - prone[i * 3]!, s.x[i * 3 + 1]! - prone[i * 3 + 1]!, s.x[i * 3 + 2]! - prone[i * 3 + 2]!)), cnt++
  const nippleMm = Math.hypot(s.x[nip * 3]! - prone[nip * 3]!, s.x[nip * 3 + 1]! - prone[nip * 3 + 1]!, s.x[nip * 3 + 2]! - prone[nip * 3 + 2]!) * 1000
  return { nippleMm: Math.round(nippleMm * 10) / 10, meanTissueMm: Math.round((sum / cnt) * 1e4) / 10, volumeRatio: Math.round((s.volume() / s.referenceVolume()) * 1e4) / 1e4, tets: T, frames }
}

if (import.meta.main) {
  const base: PhantomCase = { volumeMl: 262, cell: 0.014, base: 'bonded', shear: 357.1 }
  const cases: [string, Partial<PhantomCase>][] = [
    ['as the phase-2 model: 262 mL, 14 mm, bonded', {}],
    ['cell 10 mm', { cell: 0.01 }],
    ['cell 7 mm', { cell: 0.007 }],
    ['cell 5 mm', { cell: 0.005 }],
    ['softest published shear 166.6 Pa', { shear: 166.6 }],
    ['sliding base (frictionless wall)', { base: 'sliding' }],
    ['supine gravity tilted 45° (falls sideways)', { tiltDeg: 45 }],
    ['sliding + tilted 45°', { base: 'sliding', tiltDeg: 45 }],
    ['sliding, cell 7 mm', { base: 'sliding', cell: 0.007 }],
    ['600 mL', { volumeMl: 600 }],
    ['600 mL, tilted 45°', { volumeMl: 600, tiltDeg: 45 }],
    ['600 mL, sliding, tilted 45°', { volumeMl: 600, base: 'sliding', tiltDeg: 45 }],
    ['600 mL, sliding, tilted 45°, 166.6 Pa', { volumeMl: 600, base: 'sliding', tiltDeg: 45, shear: 166.6 }],
  ]
  for (const [label, c] of cases) {
    const t0 = performance.now()
    const res = phantom({ ...base, ...c })
    console.log(label.padEnd(48), JSON.stringify(res), `${((performance.now() - t0) / 1000).toFixed(1)} s`)
  }
}
