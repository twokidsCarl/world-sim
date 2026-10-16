// GPU 对照页面（在无头 Chrome 里跑，由 tools/softbody/gpu-check.ts 打开）：同一个页面里用同样的输入跑 CPU 参考
// （SoftSolver）、CPU 镜像（MirrorSolver）和 GPU（GpuSolver），比较结点位置和按压的结果，并计时。
// The GPU comparison page (runs in headless Chrome, opened by tools/softbody/gpu-check.ts): on one page and from the
// same inputs it runs the CPU reference (SoftSolver), the CPU mirror (MirrorSolver) and the GPU (GpuSolver), compares
// node positions and press results, and times them.

import MATERIALS_JSON from '../../data/curated/softbody/materials.json'
import { SoftBody, decodeSoft } from '../../src/softbody/body.ts'
import { setPosture } from '../../src/softbody/engine.ts'
import { GpuSolver, gpuDevice, gpuUnavailableReason } from '../../src/softbody/gpu/gpu.ts'
import { MirrorSolver, type StepSolver } from '../../src/softbody/gpu/stepper.ts'
import type { MaterialsFile } from '../../src/softbody/materials.ts'
import { type PressDomain, type PressProbe, type PressRequest, type PressResult, press, pressAsync } from '../../src/softbody/press.ts'
import type { Posture } from '../../src/softbody/protocol.ts'
import { siteDomain } from '../../src/softbody/site.ts'
import type { SoftSolver, Vec3 } from '../../src/softbody/solver.ts'
import type { SoftData } from '../../src/softbody/types.ts'
import { block, blockDomain } from './numerics.ts'

const MATERIALS = MATERIALS_JSON as unknown as MaterialsFile
const DT = 1 / 60

export interface Diff {
  maxMm: number
  rmsMm: number
  /** 参考的最大位移（相对参考构形），毫米 / the reference's largest displacement (from the reference configuration), mm */
  refMaxMm: number
  nodes: number
}

/** 两组结点位置之差（只看自由结点）/ the difference of two sets of node positions (free nodes only) */
export function diff(a: ArrayLike<number>, b: ArrayLike<number>, ref: ArrayLike<number>, free?: (i: number) => boolean): Diff {
  let m = 0, s = 0, um = 0, n = 0
  for (let i = 0; i < a.length / 3; i++) {
    if (free && !free(i)) continue
    const d = Math.hypot(a[i * 3]! - b[i * 3]!, a[i * 3 + 1]! - b[i * 3 + 1]!, a[i * 3 + 2]! - b[i * 3 + 2]!)
    m = Math.max(m, d)
    s += d * d
    um = Math.max(um, Math.hypot(b[i * 3]! - ref[i * 3]!, b[i * 3 + 1]! - ref[i * 3 + 1]!, b[i * 3 + 2]! - ref[i * 3 + 2]!))
    n++
  }
  const r = (x: number): number => Math.round(x * 1e7) / 1e4
  return { maxMm: r(m), rmsMm: r(Math.sqrt(s / Math.max(1, n))), refMaxMm: r(um), nodes: n }
}

async function frames(s: StepSolver, n: number, every = 10): Promise<number> {
  const t0 = performance.now()
  for (let f = 1; f <= n; f++) {
    s.step(DT)
    if (s.sync && (f % every === 0 || f === n)) await s.sync()
  }
  return performance.now() - t0
}

const summary = (r: PressResult): Record<string, unknown> => ({ depthMm: r.depthMm, forceN: r.forceN, meanPressureKPa: r.meanPressureKPa, peakPressureKPa: r.peakPressureKPa, contactAreaMm2: r.contactAreaMm2, peakStrain: r.peakStrain, frames: r.frames, stoppedBy: r.stoppedBy, flags: r.flags })

/** 方块在自重下（悬臂，ν = 0.49，带 Maxwell 支路和应变硬化）/ a block under its own weight (cantilever, ν = 0.49, with a Maxwell branch and strain stiffening) */
async function blockGravity(n = 400): Promise<Record<string, unknown>> {
  const T = 24 * 4 * 4 * 6
  const extra = { branchModulus: new Float32Array(T).fill(3000), branchTau: new Float32Array(T).fill(0.3), stiffening: new Float32Array(T).fill(5) }
  const mk = (): SoftSolver => block([24, 4, 4], 0.01, 20e3, 0.49, 1000, (x) => x < 1e-6, { gravity: [0, -0.5, 0], substeps: 20, damping: 8 }, extra).solver
  const cpu = mk(), mirror = new MirrorSolver(mk()), gpu = await GpuSolver.create(mk())
  const free = (i: number): boolean => !cpu.isPinned(i)
  const out: Record<string, unknown> = { nodes: cpu.nodeCount, tets: cpu.tetCount, substeps: cpu.substeps, colours: { tets: gpu.plan.tetSched.colourStart.length - 1, volumes: gpu.plan.volSched.colourStart.length - 1 } }
  const checkpoints: Record<string, unknown>[] = []
  let done = 0
  for (const at of [1, 10, 100, n]) {
    const k = at - done
    const tc = performance.now()
    for (let f = 0; f < k; f++) cpu.step(DT)
    const cpuMs = performance.now() - tc
    for (let f = 0; f < k; f++) mirror.step(DT)
    const gpuMs = await frames(gpu, k, k)
    done = at
    checkpoints.push({ frame: at, gpuVsCpu: diff(gpu.x, cpu.x, cpu.ref, free), gpuVsMirror: diff(gpu.x, mirror.x, cpu.ref, free), mirrorVsCpu: diff(mirror.x, cpu.x, cpu.ref, free), speed: { cpu: cpu.maxSpeed(), gpu: gpu.maxSpeed() }, msPerFrame: { cpu: cpuMs / k, gpu: gpuMs / k } })
  }
  out.checkpoints = checkpoints
  gpu.destroy()
  return out
}

/** 方块上的球压头（press()，力控 0.3 N 和深度控 3 mm）/ a sphere pressed into a block (press(), force control 0.3 N and depth control 3 mm) */
async function blockSphere(): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  for (const req of [{ forceN: 0.3 }, { depthMm: 3 }] as PressRequest[]) {
    const probe: PressProbe = { kind: 'sphere', radiusMm: 5 }
    const a = blockDomain(0.003, 0.036, 0.012, 0.005, 2000), b = blockDomain(0.003, 0.036, 0.012, 0.005, 2000)
    const tc = performance.now()
    const rc = press(a.d, probe, req)
    const cpuMs = performance.now() - tc
    const g = await GpuSolver.create(b.d.solver)
    const dg: PressDomain<GpuSolver> = { ...b.d, solver: g }
    const tg = performance.now()
    const rg = await pressAsync(dg, probe, req)
    const gpuMs = performance.now() - tg
    rows.push({ request: req, cpu: summary(rc), gpu: summary(rg), positions: diff(g.x, a.d.solver.x, a.d.solver.ref, (i) => !a.d.solver.isPinned(i)), ms: { cpu: Math.round(cpuMs), gpu: Math.round(gpuMs) }, msPerFrame: { cpu: cpuMs / rc.frames, gpu: gpuMs / rg.frames }, nodes: a.nodes })
    g.destroy()
  }
  return rows
}

/**
 * 压头压到固定深度并保持 n 帧（press() 的爬坡方式：每帧最多 0.15 个单元），比较结点位置、反力和接触点的力。
 * The probe is taken to a fixed depth and held for n frames (press()'s ramp: at most 0.15 of a cell per frame); node
 * positions, the reaction and the contact-point forces are compared.
 */
async function held(mk: () => PressDomain, probe: PressProbe, depthMm: number, n: number): Promise<Record<string, unknown>> {
  const a = mk(), b = mk()
  const g = await GpuSolver.create(b.solver)
  const R = probe.radiusMm * 1e-3, depth = depthMm * 1e-3
  const shape = (d: PressDomain): Vec3 => [d.site[0] + d.inward[0] * (depth - R), d.site[1] + d.inward[1] * (depth - R), d.site[2] + d.inward[2] * (depth - R)]
  for (const [d, s] of [[a, a.solver], [b, g]] as const) s.probe = { shape: { kind: 'sphere', center: shape(d), radius: R }, points: d.samples.points }
  const ramp = Math.ceil(depth / (0.15 * a.cell))
  const at = (f: number, d: PressDomain): Vec3 => {
    const z = Math.min(depth, (f * depth) / ramp) - R
    return [d.site[0] + d.inward[0] * z, d.site[1] + d.inward[1] * z, d.site[2] + d.inward[2] * z]
  }
  const force = (s: { probeForce: Vec3 }, d: PressDomain): number => -(s.probeForce[0] * d.inward[0] + s.probeForce[1] * d.inward[1] + s.probeForce[2] * d.inward[2])
  const rows: Record<string, unknown>[] = []
  let tc = 0, tg = 0
  for (let f = 1; f <= n; f++) {
    a.solver.probe!.shape.center.splice(0, 3, ...at(f, a))
    g.probe!.shape.center.splice(0, 3, ...at(f, b))
    let t0 = performance.now()
    a.solver.step(DT)
    tc += performance.now() - t0
    t0 = performance.now()
    g.step(DT)
    const row = [ramp, 2 * ramp, 100, n].includes(f)
    if (f % 10 === 0 || f === n || row) await g.sync()
    tg += performance.now() - t0
    if (row) {
      let pc = 0, pg = 0, pd = 0
      for (let i = 0; i < a.solver.probePointForce.length; i++) {
        pc += a.solver.probePointForce[i]!
        pg += g.probePointForce[i]!
        pd += Math.abs(a.solver.probePointForce[i]! - g.probePointForce[i]!)
      }
      rows.push({ frame: f, positions: diff(g.x, a.solver.x, a.solver.ref, (i) => !a.solver.isPinned(i)), forceN: { cpu: Math.round(force(a.solver, a) * 1e4) / 1e4, gpu: Math.round(force(g, b) * 1e4) / 1e4 }, pointForceSum: { cpu: pc, gpu: pg, absDiff: pd } })
    }
  }
  g.destroy()
  return { depthMm, frames: n, rows, msPerFrame: { cpu: tc / n, gpu: tg / n }, nodes: a.solver.nodeCount }
}

async function fetchBin(name: string): Promise<ArrayBuffer> {
  const r = await fetch(`/__gpu/${name}`)
  if (!r.ok) throw new Error(`gpu-check: ${name}: ${r.status}`)
  return r.arrayBuffer()
}

/** 卡片上的平头压头（前臂中段，半径 13 mm，深度控制 4.5 mm）/ the card's flat punch (mid-forearm, radius 13 mm, depth control 4.5 mm) */
async function flat(): Promise<Record<string, unknown>> {
  const meta = (await (await fetch('/__gpu/flat.json')).json()) as { soft: SoftData; site: Vec3; outward: Vec3; radius: number; depth: number }
  const bin = new Uint8Array(await fetchBin('flat.bin'))
  const skinP = new Float32Array(await fetchBin('skin-positions.bin')), skinI = new Uint32Array(await fetchBin('skin-indices.bin'))
  const mk = (): PressDomain => siteDomain(MATERIALS, decodeSoft(meta.soft, bin), { positions: skinP, indices: skinI }, meta.site, meta.outward, meta.radius).domain
  const probe: PressProbe = { kind: 'flat', radiusMm: meta.radius * 1000 }, req = { depthMm: meta.depth }
  const a = mk(), b = mk()
  const tc = performance.now()
  const rc = press(a, probe, req)
  const cpuMs = performance.now() - tc
  const g = await GpuSolver.create(b.solver)
  // 计时：排队（step）和等待（sync）各用了多少 / timing: how long queueing (step) and waiting (sync) took
  const t = { step: 0, sync: 0, steps: 0, syncs: 0 }
  const step0 = g.step.bind(g), sync0 = g.sync.bind(g)
  g.step = (dt: number): void => { const q = performance.now(); step0(dt); t.step += performance.now() - q; t.steps++ }
  g.sync = async (o?: { positions?: boolean }): Promise<void> => { const q = performance.now(); await sync0(o); t.sync += performance.now() - q; t.syncs++ }
  const tg = performance.now()
  const rg = await pressAsync({ ...b, solver: g }, probe, req)
  const gpuMs = performance.now() - tg
  ;(rg as unknown as { split: unknown }).split = t
  const cp = (g as unknown as { pts: { disp: unknown[]; count: number } | null }).pts
  const out = { cpu: summary(rc), gpu: summary(rg), split: (rg as unknown as { split: unknown }).split, positions: diff(g.x, a.solver.x, a.solver.ref, (i) => !a.solver.isPinned(i)), ms: { cpu: Math.round(cpuMs), gpu: Math.round(gpuMs) }, msPerFrame: { cpu: cpuMs / rc.frames, gpu: gpuMs / rg.frames }, nodes: a.solver.nodeCount, tets: a.solver.tetCount, colours: { tets: g.plan.tetSched.colourStart.length - 1, volumes: g.plan.volSched.colourStart.length - 1, points: cp?.disp.length ?? 0, samples: a.samples.points.tet.length } }
  g.destroy()
  return out
}

/** 方块上的球压到 3 mm 并保持 / a sphere held at 3 mm in a block */
async function blockHeld(n = 400): Promise<Record<string, unknown>> {
  return held(() => blockDomain(0.003, 0.036, 0.012, 0.005, 2000).d, { kind: 'sphere', radiusMm: 5 }, 3, n)
}

/** 前臂上的球压到验证时的深度 5.23 mm 并保持 / the sphere on the forearm held at the validated depth of 5.23 mm */
async function forearmHeld(n = 600): Promise<Record<string, unknown>> {
  const meta = (await (await fetch('/__gpu/forearm.json')).json()) as { soft: SoftData; site: Vec3; outward: Vec3; radius: number; force: number }
  const bin = new Uint8Array(await fetchBin('forearm.bin'))
  const skinP = new Float32Array(await fetchBin('skin-positions.bin')), skinI = new Uint32Array(await fetchBin('skin-indices.bin'))
  return held(() => siteDomain(MATERIALS, decodeSoft(meta.soft, bin), { positions: skinP, indices: skinI }, meta.site, meta.outward, meta.radius).domain, { kind: 'sphere', radiusMm: meta.radius * 1000 }, 5.23, n)
}

/** 前臂上半径 5 mm 的球，1 N（界面那条路径的细笼子，由运行脚本建好送来）/ a 5 mm sphere at 1 N on the forearm (the fine cage of the UI path, built and sent by the runner) */
async function forearm(): Promise<Record<string, unknown>> {
  const meta = (await (await fetch('/__gpu/forearm.json')).json()) as { soft: SoftData; site: Vec3; outward: Vec3; radius: number; force: number }
  const bin = new Uint8Array(await fetchBin('forearm.bin'))
  const skinP = new Float32Array(await fetchBin('skin-positions.bin')), skinI = new Uint32Array(await fetchBin('skin-indices.bin'))
  const mk = (): PressDomain => siteDomain(MATERIALS, decodeSoft(meta.soft, bin), { positions: skinP, indices: skinI }, meta.site, meta.outward, meta.radius).domain
  const probe: PressProbe = { kind: 'sphere', radiusMm: meta.radius * 1000 }, req = { forceN: meta.force }
  const a = mk(), b = mk()
  const tc = performance.now()
  const rc = press(a, probe, req)
  const cpuMs = performance.now() - tc
  const g = await GpuSolver.create(b.solver)
  const tg = performance.now()
  const rg = await pressAsync({ ...b, solver: g }, probe, req)
  const gpuMs = performance.now() - tg
  const out = { cpu: summary(rc), gpu: summary(rg), positions: diff(g.x, a.solver.x, a.solver.ref, (i) => !a.solver.isPinned(i)), ms: { cpu: Math.round(cpuMs), gpu: Math.round(gpuMs) }, msPerFrame: { cpu: cpuMs / rc.frames, gpu: gpuMs / rg.frames }, nodes: a.solver.nodeCount, tets: a.solver.tetCount, colours: { tets: g.plan.tetSched.colourStart.length - 1, volumes: g.plan.volSched.colourStart.length - 1 } }
  g.destroy()
  return out
}

/**
 * 全身 27 mm 笼子的体位：CPU 与 GPU 各走 n 帧比较结点位置；然后 GPU 走到平衡（与界面同一判据），给出帧数和时间。
 * A posture on the whole-body 27 mm cage: CPU and GPU each run n frames and node positions are compared; then the GPU
 * runs to equilibrium (the UI's test) and the frames and time are given.
 */
async function posture(posture: Posture, n: number, cpuFull: boolean): Promise<Record<string, unknown>> {
  const meta = (await (await fetch('/__gpu/whole.json')).json()) as { soft: SoftData }
  const bin = new Uint8Array(await fetchBin('whole.bin'))
  const skinP = new Float32Array(await fetchBin('skin-positions.bin'))
  const mk = (): { sb: SoftBody; plane: ReturnType<typeof setPosture> } => {
    const soft = decodeSoft(meta.soft, bin)
    const sb = new SoftBody(soft, { damping: MATERIALS.damping.rate })
    const plane = setPosture(sb.solver, soft.embedded.get(soft.data.skin.part)!, posture, skinP)
    return { sb, plane }
  }
  const A = mk(), B = mk()
  const cpu = A.sb.solver
  const tb = performance.now()
  const g = await GpuSolver.create(B.sb.solver)
  g.planes = B.sb.solver.planes
  g.gravity = [...B.sb.solver.gravity]
  const buildMs = performance.now() - tb
  const free = (i: number): boolean => !cpu.isPinned(i)
  const tc = performance.now()
  for (let f = 0; f < n; f++) cpu.step(DT)
  const cpuMs = performance.now() - tc
  const tg = performance.now()
  for (let f = 1; f <= n; f++) {
    g.step(DT)
    if (f >= 30 && f % 5 === 0) await g.sync({ positions: false })
  }
  await g.sync()
  const gpuMs = performance.now() - tg
  const out: Record<string, unknown> = { posture, nodes: cpu.nodeCount, tets: cpu.tetCount, substeps: cpu.substeps, colours: { tets: g.plan.tetSched.colourStart.length - 1, volumes: g.plan.volSched.colourStart.length - 1, pointColours: (g as unknown as { pts: { disp: unknown[] } | null }).pts?.disp.length ?? 0 }, frames: n, positions: diff(g.x, cpu.x, cpu.ref, free), msPerFrame: { cpu: cpuMs / n, gpu: gpuMs / n }, gpuBuildMs: Math.round(buildMs), supportForceN: { cpu: cpu.planeForce[0] ?? null, gpu: g.planeForce[0] ?? null }, maxSpeed: { cpu: cpu.maxSpeed(), gpu: g.maxSpeed() } }
  // 走到平衡（与 engine.ts 同一判据）/ on to equilibrium (the test of engine.ts)
  const TOL = 2e-4, MAX = 2400
  const settle = async (s: { step(dt: number): void; maxSpeed(): number; sync?(o?: { positions?: boolean }): Promise<void> }, start: number): Promise<{ frames: number; ms: number; speed: number }> => {
    const t0 = performance.now()
    let f = start, speed = Infinity
    while (f < MAX) {
      s.step(DT)
      f++
      if (f >= 30 && f % 5 === 0) {
        if (s.sync) await s.sync({ positions: false })
        speed = s.maxSpeed()
        if (speed < TOL) break
      }
    }
    if (s.sync) await s.sync()
    return { frames: f, ms: performance.now() - t0, speed }
  }
  const gs = await settle(g, n)
  out.gpuSettled = { frames: gs.frames, ms: Math.round(gs.ms + gpuMs), speed: gs.speed }
  if (cpuFull) {
    const cs = await settle(cpu, n)
    out.cpuSettled = { frames: cs.frames, ms: Math.round(cs.ms + cpuMs), speed: cs.speed }
    out.settledPositions = diff(g.x, cpu.x, cpu.ref, free)
  }
  // 皮肤位移（界面显示的那个量）/ the skin displacement (what the UI shows)
  const soft = A.sb.soft, skin = soft.embedded.get(soft.data.skin.part)!
  const skinDisp = (x: Float64Array): Float64Array => {
    const o = new Float64Array(skin.tet.length * 3)
    for (let i = 0; i < skin.tet.length; i++) for (let k = 0; k < 4; k++) {
      const node = soft.tets[skin.tet[i]! * 4 + k]!, b = skin.bary[i * 4 + k]!
      for (let r = 0; r < 3; r++) o[i * 3 + r] = o[i * 3 + r]! + b * (x[node * 3 + r]! - soft.nodes[node * 3 + r]!)
    }
    return o
  }
  const dg = skinDisp(g.x), dc = skinDisp(cpu.x)
  const stats = (d: Float64Array): { meanMm: number; maxMm: number } => {
    let s = 0, m = 0
    for (let i = 0; i < d.length / 3; i++) {
      const v = Math.hypot(d[i * 3]!, d[i * 3 + 1]!, d[i * 3 + 2]!)
      s += v
      m = Math.max(m, v)
    }
    return { meanMm: Math.round((s / (d.length / 3)) * 1e5) / 100, maxMm: Math.round(m * 1e5) / 100 }
  }
  out.skin = { gpu: stats(dg), cpu: stats(dc), diff: diff(dg, dc, new Float64Array(dc.length)) }
  g.destroy()
  return out
}

async function info(): Promise<Record<string, unknown>> {
  const d = await gpuDevice()
  const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
  return { device: !!d, reason: gpuUnavailableReason(), adapter: a ? `${a.info.vendor} ${a.info.architecture}` : null, userAgent: navigator.userAgent }
}

;(window as unknown as { gpuCheck: unknown }).gpuCheck = { info, blockGravity, blockSphere, blockHeld, forearm, forearmHeld, flat, posture }

/** 计时：每批 k 帧，各批用时（毫秒/帧）/ timing: batches of k frames, ms per frame of each batch */
async function timing(n = 400, k = 10): Promise<number[]> {
  const T = 24 * 4 * 4 * 6
  const extra = { branchModulus: new Float32Array(T).fill(3000), branchTau: new Float32Array(T).fill(0.3), stiffening: new Float32Array(T).fill(5) }
  const g = await GpuSolver.create(block([24, 4, 4], 0.01, 20e3, 0.49, 1000, (x) => x < 1e-6, { gravity: [0, -0.5, 0], substeps: 20, damping: 8 }, extra).solver)
  const out: number[] = []
  for (let b = 0; b < n / k; b++) out.push(Math.round((await frames(g, k, k)) / k * 100) / 100)
  g.destroy()
  return out
}
;(window as unknown as { gpuTiming: unknown }).gpuTiming = timing

async function profile(): Promise<Record<string, unknown>> {
  const meta = (await (await fetch('/__gpu/whole.json')).json()) as { soft: SoftData }
  const bin = new Uint8Array(await fetchBin('whole.bin'))
  const skinP = new Float32Array(await fetchBin('skin-positions.bin'))
  const soft = decodeSoft(meta.soft, bin)
  const sb = new SoftBody(soft, { damping: MATERIALS.damping.rate })
  setPosture(sb.solver, soft.embedded.get(soft.data.skin.part)!, 'supine', skinP)
  const g = await GpuSolver.create(sb.solver)
  g.planes = sb.solver.planes
  g.gravity = [...sb.solver.gravity]
  for (let f = 0; f < 20; f++) g.step(DT)
  await g.sync()
  const out: Record<string, unknown> = { pointColours: (g as unknown as { pts: { disp: unknown[] } }).pts.disp.length }
  for (let rep = 0; rep < 3; rep++) {
    for (const grp of ['pressure', 'predict', 'finish', 'tet', 'volume', 'points']) out[grp + rep] = Math.round((await g.profileGroup(grp, 100)) * 1000) / 1000
    const t0 = performance.now()
    for (let f = 0; f < 50; f++) { g.step(DT); if (f % 5 === 4) await g.sync({ positions: false }) }
    out['frame' + rep] = (performance.now() - t0) / 50
  }
  return out
}
;(window as unknown as { gpuProfile: unknown }).gpuProfile = profile

/** 平头压头的剖析：压到 4.5 mm 后各组内核每个子步的毫秒 / profiling the flat punch: ms per substep of each kernel group at 4.5 mm */
async function flatProfile(): Promise<Record<string, unknown>> {
  const meta = (await (await fetch('/__gpu/flat.json')).json()) as { soft: SoftData; site: Vec3; outward: Vec3; radius: number; depth: number }
  const bin = new Uint8Array(await fetchBin('flat.bin'))
  const skinP = new Float32Array(await fetchBin('skin-positions.bin')), skinI = new Uint32Array(await fetchBin('skin-indices.bin'))
  const d = siteDomain(MATERIALS, decodeSoft(meta.soft, bin), { positions: skinP, indices: skinI }, meta.site, meta.outward, meta.radius).domain
  const g = await GpuSolver.create(d.solver)
  const z = 0.0045
  g.probe = { shape: { kind: 'flat', center: [d.site[0] + d.inward[0] * z, d.site[1] + d.inward[1] * z, d.site[2] + d.inward[2] * z], axis: [...d.inward], radius: meta.radius }, points: d.samples.points }
  for (let f = 0; f < 20; f++) g.step(DT)
  await g.sync()
  const out: Record<string, unknown> = {}
  for (const grp of ['pressure', 'predict', 'finish', 'tet', 'volume', 'points']) out[grp] = Math.round((await g.profileGroup(grp, 50)) * 1000) / 1000
  const t0 = performance.now()
  for (let f = 0; f < 30; f++) { g.step(DT); if (f % 10 === 9) await g.sync() }
  out.frame = (performance.now() - t0) / 30
  const t1 = performance.now()
  for (let f = 0; f < 30; f++) { g.step(DT); if (f % 10 === 9) await g.sync({ positions: false }) }
  out.frameNoPositions = (performance.now() - t1) / 30
  g.destroy()
  return out
}
;(window as unknown as { gpuFlatProfile: unknown }).gpuFlatProfile = flatProfile
