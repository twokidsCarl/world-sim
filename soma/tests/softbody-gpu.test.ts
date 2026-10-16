// GPU 软组织求解器（src/softbody/gpu/）在没有 GPU 的地方能查的部分：内核数学由 CPU 镜像检查（按 CPU 的顺序走时与 CPU
// 参考逐结点一致；按颜色走时与 CPU 的差在给定容差内），着色合法，WGSL 与镜像的入口和布局对得上，press() 的生成器写法
// 不改变 CPU 的结果；真 GPU 的对照由 tools/softbody/gpu-check.ts 在无头 Chrome 里跑，写进 gpu-report.json，这里检查报告里的
// 数在容差之内。
// What can be checked of the GPU soft-tissue solver (src/softbody/gpu/) without a GPU: the kernel mathematics through
// the CPU mirror (run in the CPU's order it equals the CPU reference node for node; run by colour it stays within the
// stated tolerance of it), valid colourings, WGSL and mirror agreeing on entry points and layout, and press() as a
// generator leaving the CPU result unchanged. The real GPU comparison is run in headless Chrome by
// tools/softbody/gpu-check.ts and written to gpu-report.json; here the report's numbers are checked against the tolerance.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENTRY_POINTS, STORAGE_BUFFERS, WGSL } from '../src/softbody/gpu/kernels.ts'
import { buildPlan, colourItems, contactPlan, pointPlan } from '../src/softbody/gpu/plan.ts'
import { MirrorSolver } from '../src/softbody/gpu/stepper.ts'
import { type PressDomain, type PressSolver, press, pressAsync } from '../src/softbody/press.ts'
import type { SoftSolver } from '../src/softbody/solver.ts'
import { block, blockDomain } from '../tools/softbody/numerics.ts'

const DT = 1 / 60

/** 悬臂方块：ν = 0.49，带 Maxwell 支路、应变硬化和沿 x 的纤维 / a cantilever block: ν = 0.49, with a Maxwell branch, strain stiffening and a fibre along x */
function cantilever(): SoftSolver {
  const T = 24 * 4 * 4 * 6
  const fibre = new Float32Array(T * 3)
  for (let e = 0; e < T; e++) fibre[e * 3] = 1
  const extra = { branchModulus: new Float32Array(T).fill(3000), branchTau: new Float32Array(T).fill(0.3), stiffening: new Float32Array(T).fill(5), fibre, fibreModulus: new Float32Array(T).fill(4000) }
  return block([24, 4, 4], 0.01, 20e3, 0.49, 1000, (x) => x < 1e-6, { gravity: [0, -0.5, 0], substeps: 20, damping: 8 }, extra).solver
}

/** 自由结点上的最大差和参考的最大位移（米）/ the largest difference over free nodes and the reference's largest displacement (m) */
function gap(a: ArrayLike<number>, b: SoftSolver): { max: number; rms: number; ref: number } {
  let m = 0, s = 0, r = 0, n = 0
  for (let i = 0; i < b.nodeCount; i++) {
    if (b.isPinned(i)) continue
    const d = Math.hypot(a[i * 3]! - b.x[i * 3]!, a[i * 3 + 1]! - b.x[i * 3 + 1]!, a[i * 3 + 2]! - b.x[i * 3 + 2]!)
    m = Math.max(m, d)
    s += d * d
    r = Math.max(r, Math.hypot(b.x[i * 3]! - b.ref[i * 3]!, b.x[i * 3 + 1]! - b.ref[i * 3 + 1]!, b.x[i * 3 + 2]! - b.ref[i * 3 + 2]!))
    n++
  }
  return { max: m, rms: Math.sqrt(s / n), ref: r }
}

describe('colouring', () => {
  it('no two constraints of one colour share a node, and every constraint has one colour', () => {
    const s = cantilever(), p = buildPlan(s)
    const check = (sched: { order: Uint32Array; colourStart: Uint32Array }, nodesOf: (i: number) => number[], items: number): void => {
      expect([...sched.order].sort((a, b) => a - b)).toEqual(Array.from({ length: items }, (_, i) => i))
      for (let c = 0; c + 1 < sched.colourStart.length; c++) {
        const seen = new Set<number>()
        for (let q = sched.colourStart[c]!; q < sched.colourStart[c + 1]!; q++) for (const n of nodesOf(sched.order[q]!)) {
          expect(seen.has(n)).toBe(false)
          seen.add(n)
        }
      }
    }
    check(p.tetSched, (t) => [...p.tetNodes.subarray(t * 4, t * 4 + 4)], p.tetCount)
    check(p.volSched, (n) => [...p.nbr.subarray(p.nbrStart[n]!, p.nbrStart[n + 1]!)], p.nodeCount)
    // BCC 格子里每个结点有 24 个四面体，所以至少 24 种颜色；DSATUR 不应比这多太多 / 24 tetrahedra meet at a BCC node, so 24 colours at least; DSATUR should not need many more
    expect(p.tetSched.colourStart.length - 1).toBeLessThanOrEqual(32)
    expect(colourItems(4, 3, (i, o) => o.push(i, i + 1), true).colourStart.length).toBe(4)
  })

  it('point constraints are grouped by tetrahedron, groups of one colour share no node, and a group keeps anchors before probe before planes', () => {
    const { d } = blockDomain(0.003, 0.036, 0.012, 0.005, 2000)
    const s = d.solver as SoftSolver
    const a = pointPlan(s, d.samples.points), b = pointPlan(s, d.samples.points)
    const cp = contactPlan(s.nodeCount, [{ plan: a, kind: 1, shape: 0 }, { plan: b, kind: 4, shape: 1 }])
    expect(cp.count).toBe(a.count * 2)
    for (let c = 0; c + 1 < cp.colourStart.length; c++) {
      const seen = new Set<number>()
      for (let g = cp.colourStart[c]!; g < cp.colourStart[c + 1]!; g++) {
        const first = cp.order[cp.groupStart[g]!]!, nodes = new Set(cp.nodes.subarray(first * 4, first * 4 + 4))
        let last = -1
        for (let q = cp.groupStart[g]!; q < cp.groupStart[g + 1]!; q++) {
          const i = cp.order[q]!
          for (const n of cp.nodes.subarray(i * 4, i * 4 + 4)) expect(nodes.has(n)).toBe(true)
          expect(i).toBeGreaterThan(last)
          last = i
        }
        for (const n of nodes) {
          expect(seen.has(n)).toBe(false)
          seen.add(n)
        }
      }
    }
  })
})

describe('kernel mathematics through the CPU mirror', () => {
  it('run one constraint at a time in the CPU order, the kernels are the CPU reference (cantilever, 100 frames, within 1e-9 mm)', () => {
    const cpu = cantilever(), seq = new MirrorSolver(cantilever(), { sequential: true })
    for (let f = 0; f < 100; f++) (cpu.step(DT), seq.step(DT))
    const g = gap(seq.x, cpu)
    expect(g.ref).toBeGreaterThan(0.04)
    expect(g.max).toBeLessThan(1e-12)
    expect(Math.abs(seq.maxSpeed() - cpu.maxSpeed())).toBeLessThan(1e-9)
  })

  it('a press through the mirror in the CPU order gives the CPU press exactly (sphere on a block, force control)', { timeout: 240_000 }, () => {
    const a = blockDomain(0.003, 0.036, 0.012, 0.005, 2000).d, b = blockDomain(0.003, 0.036, 0.012, 0.005, 2000).d
    const rc = press(a, { kind: 'sphere', radiusMm: 5 }, { depthMm: 2 })
    const m = new MirrorSolver(b.solver, { sequential: true })
    const rm = press({ ...b, solver: m } as PressDomain<PressSolver>, { kind: 'sphere', radiusMm: 5 }, { depthMm: 2 })
    expect(rm.forceN).toBe(rc.forceN)
    expect(rm.contactAreaMm2).toBe(rc.contactAreaMm2)
    expect(rm.peakPressureKPa).toBe(rc.peakPressureKPa)
    expect(rm.frames).toBe(rc.frames)
  })

  it('by colour (the GPU order) the cantilever settles within 0.3 % of the CPU sag, also with f32 storage', { timeout: 240_000 }, () => {
    const cpu = cantilever(), col = new MirrorSolver(cantilever()), c32 = new MirrorSolver(cantilever(), { f32: true })
    for (let f = 0; f < 400; f++) (cpu.step(DT), col.step(DT), c32.step(DT))
    const g = gap(col.x, cpu), g32 = gap(c32.x, cpu)
    expect(g.max / g.ref).toBeLessThan(0.003)
    expect(g32.max / g.ref).toBeLessThan(0.003)
    expect(c32.maxSpeed()).toBeLessThan(1e-4)
  })

  it('by colour, a sphere held at 3 mm in a block: reaction within 3 % and node positions RMS within 3 % of the dent', { timeout: 240_000 }, () => {
    const a = blockDomain(0.003, 0.036, 0.012, 0.005, 2000).d, b = blockDomain(0.003, 0.036, 0.012, 0.005, 2000).d
    const cpu = a.solver as SoftSolver, col = new MirrorSolver(b.solver as SoftSolver)
    const R = 0.005, depth = 0.003, ramp = Math.ceil(depth / (0.15 * a.cell))
    for (const s of [cpu, col]) s.probe = { shape: { kind: 'sphere', center: [0, 0, 0], radius: R }, points: a.samples.points }
    for (let f = 1; f <= 200; f++) {
      const z = Math.min(depth, (f * depth) / ramp) - R
      for (const s of [cpu, col]) {
        for (let k = 0; k < 3; k++) s.probe!.shape.center[k] = a.site[k]! + a.inward[k]! * z
        s.step(DT)
      }
    }
    const fc = cpu.probeForce[1], fg = col.probeForce[1]
    expect(fc).toBeGreaterThan(0.05)
    expect(Math.abs(fg / fc - 1)).toBeLessThan(0.03)
    const g = gap(col.x, cpu)
    expect(g.rms / g.ref).toBeLessThan(0.03)
  })
})

describe('press() as a generator', () => {
  it('the asynchronous driver gives the synchronous result on the CPU solver', { timeout: 240_000 }, async () => {
    const a = blockDomain(0.003, 0.036, 0.012, 0.005, 2000).d, b = blockDomain(0.003, 0.036, 0.012, 0.005, 2000).d
    const r1 = press(a, { kind: 'sphere', radiusMm: 5 }, { forceN: 0.05 })
    const r2 = await pressAsync(b, { kind: 'sphere', radiusMm: 5 }, { forceN: 0.05 })
    expect({ ...r2, strainAtDepth: 0 }).toEqual({ ...r1, strainAtDepth: 0 })
  })
})

describe('WGSL kernels', () => {
  it('declare the entry points the solver dispatches, within the default limit of 8 storage buffers', () => {
    for (const e of ENTRY_POINTS) expect(WGSL).toMatch(new RegExp(`fn ${e}\\(`))
    const storage = WGSL.match(/var<storage,/g)!.length
    expect(storage).toBe(STORAGE_BUFFERS)
    expect(storage).toBeLessThanOrEqual(8)
    // 镜像的每个内核在 WGSL 里都有对应 / every mirror kernel has its WGSL counterpart
    for (const k of ['kin(', 'grads(', 'applyTet(']) expect(WGSL).toContain(k)
  })
})

// 真 GPU 的对照（无头 Chrome，tools/softbody/gpu-check.ts）写下的报告：数在容差之内
// The report of the real GPU comparison (headless Chrome, tools/softbody/gpu-check.ts): its numbers are within tolerance
describe('the GPU comparison report', () => {
  const file = resolve(__dirname, '../data/curated/softbody/gpu-report.json')
  it.skipIf(!existsSync(file))('GPU against CPU on the fixed cases is within the stated tolerance', () => {
    const r = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
    const tol = r.tolerance
    expect(tol).toBeTruthy()
    // 方块自重：最后一帧 / the block under gravity: last frame
    const bg = r.blockGravity.checkpoints.at(-1)
    expect(bg.gpuVsCpu.maxMm / bg.gpuVsCpu.refMaxMm).toBeLessThan(tol.blockGravityMaxRel)
    expect(bg.gpuVsMirror.maxMm / bg.gpuVsMirror.refMaxMm).toBeLessThan(tol.gpuVsMirrorMaxRel)
    // 保持深度的球压头：力和位置 / spheres held at a depth: force and positions
    for (const k of ['blockHeld', 'forearmHeld']) {
      const last = r[k].rows.at(-1)
      expect(Math.abs(last.forceN.gpu / last.forceN.cpu - 1)).toBeLessThan(tol.heldForceRel)
      expect(last.positions.rmsMm / last.positions.refMaxMm).toBeLessThan(tol.heldRmsRel)
    }
    // 全身仰卧：走到平衡后皮肤位移的平均和最大 / whole-body supine: mean and largest skin displacement at equilibrium
    const p = r.posture
    expect(Math.abs(p.skin.gpu.meanMm / p.skin.cpu.meanMm - 1)).toBeLessThan(tol.postureSkinRel)
    expect(Math.abs(p.skin.gpu.maxMm / p.skin.cpu.maxMm - 1)).toBeLessThan(tol.postureSkinRel)
    expect(p.settledPositions.rmsMm / p.settledPositions.refMaxMm).toBeLessThan(tol.postureRmsRel)
  })
})
