// 求解器数值性质的解析算例：体积锁死、压入的网格与子步收敛、Jacobi 与 Gauss–Seidel 的对照。不读任何人体数据。
// Analytic cases for the numerics of the solver: volumetric locking, convergence of an indentation in cell size and
// substeps, Jacobi against Gauss–Seidel. No body data is read.
//
//   bun tools/softbody/numerics.ts [locking|punch|jacobi|all]
//
// 用到的闭式解 / Closed forms used
//   · 悬臂梁自重下的端部挠度（Euler–Bernoulli）：δ = w·L⁴/(8·E·I) = 3·ρ·g·L⁴/(2·E·h²)，与 ν 无关。
//     Tip deflection of a cantilever under its own weight (Euler–Bernoulli), independent of ν.
//   · 刚性平头圆柱压头压在弹性半空间上：F = 2·E·a·δ/(1 − ν²)（Sneddon 1965）；有限厚度 h 的粘结层：
//     F = 2·a·E·δ·κ(ν, a/h)/(1 − ν²)（Hayes 等 1972；公式取自 Lu 等 2012 的式 (1)，doi 10.1155/2012/323848，
//     CC BY 3.0，本项目打开过；Hayes 原文的 κ 表没有打开，所以这里只用 a/h 小、κ → 1 的情形，κ 自己由细网格算出）。
//     A rigid flat-ended cylinder on an elastic half-space: F = 2·E·a·δ/(1 − ν²) (Sneddon 1965); on a bonded layer of
//     finite thickness h: F = 2·a·E·δ·κ(ν, a/h)/(1 − ν²) (Hayes et al. 1972; the formula is taken from Eq. (1) of
//     Lu et al. 2012, doi 10.1155/2012/323848, CC BY 3.0, which this project opened; the κ table of Hayes' paper was
//     not opened, so only the case of small a/h with κ → 1 is used here, and κ itself is computed on a fine mesh).

import { boxKuhn } from '../../src/softbody/lattice.ts'
import { type PressDomain, massScale } from '../../src/softbody/press.ts'
import { type PointSet, type SolverOptions, SoftSolver, lame } from '../../src/softbody/solver.ts'

export interface Block {
  nodes: Float32Array
  tets: Uint32Array
  solver: SoftSolver
  n: [number, number, number]
  cell: number
}

export function block(n: [number, number, number], cell: number, young: number, nu: number, density: number, pin: (x: number, y: number, z: number) => boolean, opts: SolverOptions, extra: Record<string, unknown> = {}): Block {
  const m = boxKuhn(n, cell)
  const T = m.tets.length / 4, N = m.nodes.length / 3
  const { mu, lambda } = lame(young, nu)
  const pinned = new Uint8Array(N)
  for (let i = 0; i < N; i++) pinned[i] = pin(m.nodes[i * 3]!, m.nodes[i * 3 + 1]!, m.nodes[i * 3 + 2]!) ? 1 : 0
  const solver = new SoftSolver({ nodes: m.nodes, tets: m.tets, mu: new Float32Array(T).fill(mu), lambda: new Float32Array(T).fill(lambda), density: new Float32Array(T).fill(density), pinned, ...extra }, opts)
  return { ...m, solver, n, cell }
}

/** Kuhn 盒子顶面（y = 顶）上的采样点及其嵌入 / sample points on the top face (y = top) of a Kuhn box, with their embedding */
export function topSamples(b: Block, centre: [number, number], radius: number, spacing: number): { points: PointSet; area: number; xz: Float32Array } {
  const [nx, ny, nz] = b.n, c = b.cell
  const top = ny * c
  const tet: number[] = [], bary: number[] = [], xz: number[] = []
  const w = [0, 0, 0, 0]
  const k = Math.ceil(radius / spacing)
  for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) {
    const x = centre[0] + (i + 0.5) * spacing, z = centre[1] + (j + 0.5) * spacing
    if (Math.hypot(x - centre[0], z - centre[1]) > radius) continue
    // 方块之外的点不要（重心坐标会外推）/ points outside the block are dropped (their barycentric coordinates would extrapolate)
    if (x < 0 || z < 0 || x > nx * c || z > nz * c) continue
    const ci = Math.min(nx - 1, Math.max(0, Math.floor(x / c))), ck = Math.min(nz - 1, Math.max(0, Math.floor(z / c)))
    const cellIndex = ci + nx * (ny - 1 + ny * ck)
    let best = -1, bw = -Infinity
    for (let q = 0; q < 6; q++) {
      const e = cellIndex * 6 + q
      const w4 = baryOf(b.nodes, b.tets, e, x, top, z)
      const lo = Math.min(...w4)
      if (lo > bw) (bw = lo), (best = e), w.splice(0, 4, ...w4)
    }
    tet.push(best)
    bary.push(...w)
    xz.push(x, z)
  }
  return { points: { tet: Uint32Array.from(tet), bary: Float32Array.from(bary) }, area: spacing * spacing, xz: Float32Array.from(xz) }
}

/** Kuhn 盒子里任意点的嵌入（盒外的点 inside = 0）/ embedding of arbitrary points in a Kuhn box (inside = 0 outside it) */
export function kuhnEmbed(b: Block, positions: ArrayLike<number>): PointSet & { inside: Uint8Array } {
  const [nx, ny, nz] = b.n, c = b.cell, m = positions.length / 3
  const tet = new Uint32Array(m), bary = new Float32Array(m * 4), inside = new Uint8Array(m)
  for (let i = 0; i < m; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!
    const e = 1e-9
    if (x < -e || y < -e || z < -e || x > nx * c + e || y > ny * c + e || z > nz * c + e) continue
    const ci = Math.min(nx - 1, Math.max(0, Math.floor(x / c))), cj = Math.min(ny - 1, Math.max(0, Math.floor(y / c))), ck = Math.min(nz - 1, Math.max(0, Math.floor(z / c)))
    const cellIndex = ci + nx * (cj + ny * ck)
    let bw = -Infinity
    for (let q = 0; q < 6; q++) {
      const w4 = baryOf(b.nodes, b.tets, cellIndex * 6 + q, x, y, z)
      const lo = Math.min(...w4)
      if (lo > bw) (bw = lo), (tet[i] = cellIndex * 6 + q), bary.set(w4, i * 4)
    }
    inside[i] = 1
  }
  return { tet, bary, inside }
}

function baryOf(nodes: ArrayLike<number>, tets: Uint32Array, e: number, x: number, y: number, z: number): [number, number, number, number] {
  const a = tets[e * 4]! * 3, b = tets[e * 4 + 1]! * 3, c = tets[e * 4 + 2]! * 3, d = tets[e * 4 + 3]! * 3
  const m = [nodes[b]! - nodes[a]!, nodes[c]! - nodes[a]!, nodes[d]! - nodes[a]!, nodes[b + 1]! - nodes[a + 1]!, nodes[c + 1]! - nodes[a + 1]!, nodes[d + 1]! - nodes[a + 1]!, nodes[b + 2]! - nodes[a + 2]!, nodes[c + 2]! - nodes[a + 2]!, nodes[d + 2]! - nodes[a + 2]!]
  const det = m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)
  const px = x - nodes[a]!, py = y - nodes[a + 1]!, pz = z - nodes[a + 2]!
  const b1 = (px * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (py * m[8]! - m[5]! * pz) + m[2]! * (py * m[7]! - m[4]! * pz)) / det
  const b2 = (m[0]! * (py * m[8]! - m[5]! * pz) - px * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * pz - py * m[6]!)) / det
  const b3 = (m[0]! * (m[4]! * pz - py * m[7]!) - m[1]! * (m[3]! * pz - py * m[6]!) + px * (m[3]! * m[7]! - m[4]! * m[6]!)) / det
  return [1 - b1 - b2 - b3, b1, b2, b3]
}

/** 悬臂梁（沿 x，根部 x = 0 钉住，截面 h × h）自重下的端部挠度与梁理论之比。 Tip deflection of a cantilever (along x, clamped at x = 0, section h × h) under its own weight, over beam theory. */
export function cantilever(nAcross: number, nu: number, volume: 'node' | 'tet', substeps = 20, blend = 0, cap = 2, mode: 'gs' | 'jacobi' = 'gs', maxFrames = 3000): { ratio: number; frames: number } {
  const E = 20e3, rho = 1000, g = 0.5
  const h = 0.04, L = 0.24, cell = h / nAcross
  const n: [number, number, number] = [Math.round(L / cell), nAcross, nAcross]
  const b = block(n, cell, E, nu, rho, (x) => x < 1e-6, { gravity: [0, -g, 0], substeps, damping: 8, volume, volumeBlend: blend, volumeCap: cap, mode })
  const frames = b.solver.settle(1 / 60, 2e-6, maxFrames)
  let sum = 0, c = 0
  for (let i = 0; i < b.nodes.length / 3; i++) if (Math.abs(b.nodes[i * 3]! - L) < 1e-6) (sum += b.solver.x[i * 3 + 1]! - b.nodes[i * 3 + 1]!), c++
  return { ratio: -sum / c / ((1.5 * rho * g * L ** 4) / (E * h * h)), frames }
}

export interface PunchResult {
  /** F ÷ 半空间解 2·E·a·δ/(1 − ν²) / F over the half-space solution */
  ratio: number
  forceN: number
  frames: number
  msPerFrame: number
  nodes: number
  /** 每帧结束时的力，牛 / the force at the end of every frame, N */
  history: number[]
}

/**
 * 平头压头压在一块底面粘结的方块上（边长 size，厚 depth，压头半径 a，压入 δ）。侧面自由。
 * A flat punch on a block bonded at its base (side `size`, thickness `depth`, punch radius a, indentation δ). Free sides.
 */
export function punch(cell: number, o: { nu?: number; substeps?: number; volume?: 'node' | 'tet'; mode?: 'gs' | 'jacobi'; relaxation?: number; a?: number; depth?: number; size?: number; delta?: number; maxFrames?: number; blend?: number; damping?: number } = {}): PunchResult {
  const E = 6e3, nu = o.nu ?? 0.49, a = o.a ?? 0.012, size = o.size ?? 0.096, depth = o.depth ?? 0.072, delta = o.delta ?? 0.001
  const n: [number, number, number] = [Math.round(size / cell), Math.round(depth / cell), Math.round(size / cell)]
  const b = block(n, cell, E, nu, 1000, (_x, y) => y < 1e-6, { gravity: [0, 0, 0], substeps: o.substeps ?? 16, damping: o.damping ?? 12, volume: o.volume ?? 'node', volumeBlend: o.blend ?? 0, mode: o.mode ?? 'gs', relaxation: o.relaxation ?? 1 })
  const top = n[1] * cell, mid = (n[0] * cell) / 2
  const s = topSamples(b, [mid, mid], a * 1.3, Math.min(0.002, cell / 3))
  b.solver.probe = { shape: { kind: 'flat', center: [mid, top - delta, mid], axis: [0, -1, 0], radius: a }, points: s.points }
  const t0 = performance.now()
  let prev = -1, f = 0, frames = 0
  const history: number[] = []
  for (frames = 1; frames <= (o.maxFrames ?? 1500); frames++) {
    b.solver.step(1 / 60)
    f = b.solver.probeForce[1]
    history.push(f)
    // 每 30 帧比较一次：变化不到万分之五才算稳定 / compared every 30 frames: steady once the change is below 5e-4
    if (frames % 30 === 0) {
      if (Math.abs(f - prev) < 5e-4 * Math.abs(f)) break
      prev = f
    }
  }
  return { ratio: f / ((2 * E * a * delta) / (1 - nu * nu)), forceN: f, frames, msPerFrame: (performance.now() - t0) / frames, nodes: b.nodes.length / 3, history }
}

/** 第一次进入并此后一直留在最终值 ±tol 之内的帧号 / the first frame from which the force stays within ±tol of its final value */
export function framesToWithin(history: number[], tol = 0.02): number {
  const last = history[history.length - 1]!
  let k = history.length
  while (k > 0 && Math.abs(history[k - 1]! / last - 1) < tol) k--
  return k + 1
}

/** 一块底面粘结的方块上的按压求解域（press() 的解析算例用）/ a pressing domain on a block bonded at its base (for analytic cases of press()) */
export function blockDomain(cell: number, size: number, depth: number, a: number, young = 6e3, extra: Record<string, unknown> = {}): { d: PressDomain; young: number; nu: number; nodes: number } {
  const nu = 0.49, substeps = 8, h = 1 / 60 / substeps
  const n: [number, number, number] = [Math.round(size / cell), Math.round(depth / cell), Math.round(size / cell)]
  const scale = massScale(lame(young, nu).lambda, 1000, cell, h, 1.5)
  const b = block(n, cell, young, nu, 1000 * scale, (_x, y) => y < 1e-9, { gravity: [0, 0, 0], substeps, damping: 15 / Math.sqrt(scale) }, extra)
  const mid = (n[0] * cell) / 2, top = n[1] * cell
  const s = topSamples(b, [mid, mid], 1.6 * a + cell, Math.min(cell / 3, a / 6))
  const m = s.xz.length / 2
  const positions = new Float32Array(m * 3)
  for (let i = 0; i < m; i++) positions.set([s.xz[i * 2]!, top, s.xz[i * 2 + 1]!], i * 3)
  return { d: { solver: b.solver, cell, site: [mid, top, mid], inward: [0, -1, 0], samples: { points: s.points, area: new Float32Array(m).fill(s.area), positions }, embed: (p) => kuhnEmbed(b, p), thickness: depth }, young, nu, nodes: b.nodes.length / 3 }
}

if (import.meta.main) {
  const which = process.argv[2] ?? 'all'
  const r = (x: number): number => Math.round(x * 1000) / 1000
  if (which === 'locking' || which === 'all') {
    for (const nAcross of [2, 4]) for (const nu of [0.3, 0.49, 0.499]) for (const volume of ['tet', 'node'] as const) {
      const c = cantilever(nAcross, nu, volume)
      console.log(`cantilever cells-across=${nAcross} nu=${nu} volume=${volume}: deflection/beam-theory=${r(c.ratio)} frames=${c.frames}`)
    }
  }
  if (which === 'punch' || which === 'all') {
    for (const volume of ['tet', 'node'] as const) for (const cell of [0.012, 0.008, 0.006]) for (const substeps of [8, 16, 32]) {
      const p = punch(cell, { volume, substeps })
      console.log(`punch volume=${volume} cell=${cell * 1000}mm substeps=${substeps}: F/half-space=${r(p.ratio)} frames=${p.frames} ms/frame=${r(p.msPerFrame)} nodes=${p.nodes}`)
    }
  }
  if (which === 'jacobi' || which === 'all') {
    const ref = punch(0.008, { substeps: 16 })
    console.log(`gs reference: ${r(ref.ratio)} in ${ref.frames} frames`)
    for (const substeps of [16, 32, 64]) {
      const p = punch(0.008, { substeps, mode: 'jacobi' })
      console.log(`jacobi substeps=${substeps}: F/half-space=${r(p.ratio)} frames=${p.frames} ms/frame=${r(p.msPerFrame)}`)
    }
  }
}
