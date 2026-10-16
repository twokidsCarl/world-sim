// 着色 Gauss–Seidel 求解器的外壳：GPU 版（gpu.ts）和 CPU 镜像（下面的 MirrorSolver）共用的部分。对外的样子与 SoftSolver 在
// press() 和体位循环里用到的那几样相同（x、ref、probe、planes、probeForce…），所以 press() 不必知道底下是哪一个。
// The shell of the coloured Gauss–Seidel solvers: what the GPU version (gpu.ts) and the CPU mirror (MirrorSolver below) share. Outwardly
// it looks like the parts of SoftSolver that press() and the posture loop use (x, ref, probe, planes, probeForce…), so
// press() need not know which one is underneath.
//
// 同步 / Synchronisation
//   GPU 的 step() 只把一帧排进队列，不等它算完；x、probeForce 这些只在 sync() 之后才是新的。press() 在要读它们的
//   地方让出（pressSteps 的 yield），体位每隔几帧读一次最大速度。镜像是同步的，sync() 什么也不做。
//   The GPU's step() only queues a frame and does not wait for it; x, probeForce and the like are current only after
//   sync(). press() yields where it reads them (the yields of pressSteps), and the posture reads the largest speed every
//   few frames. The mirror is synchronous and its sync() does nothing.

import type { Plane, PointSet, Probe, SoftSolver, Vec3 } from '../solver.ts'
import { type MirrorState, type PointOut, SHAPE, type ShapeParams, newPointOut, newState, shapeOf, substep, work } from './mirror.ts'
import { type ContactPlan, type GpuPlan, type PointPlan, accelerations, buildPlan, contactPlan, planePlan, probePlan } from './plan.ts'

/** press() 和体位循环要的求解器 / The solver press() and the posture loop need */
export interface StepSolver {
  readonly nodeCount: number
  readonly tets: Uint32Array
  readonly x: Float64Array
  readonly ref: Float64Array
  probe: Probe | null
  planes: Plane[]
  readonly probeForce: Vec3
  probePointForce: Float32Array
  planeForce: number[]
  substeps: number
  gravity: Vec3
  step(dt: number): void
  reset(): void
  pointPosition(set: PointSet, i: number, out: number[]): void
  maxSpeed(): number
  /** GPU：等排进去的帧算完，读回 x（positions 为 false 时不读）、接触力和最大速度；CPU 不用 / GPU: waits for the queued frames and reads back x (not when positions is false), the contact forces and the largest speed; the CPU needs none */
  sync?(o?: { positions?: boolean }): Promise<void>
}

export interface PlanOptions {
  /** 每个约束一种颜色、按 CPU 的顺序（只为检查内核的数学；GPU 上会很慢）/ a colour per constraint in the CPU's order (only for checking the kernels' mathematics; very slow on a GPU) */
  sequential?: boolean
}

/** 一组接触点：计划、形状来源 / A contact set: its plan and where its shape comes from */
export interface ContactSet {
  plan: PointPlan
  probe: Probe | null
  plane: Plane | null
}

/** 合并后的点约束和它们的形状（形状编号 0 = 压头或第一个支撑面…）/ the merged point constraints and their shapes (shape index 0 = the probe or the first plane…) */
export interface Contacts {
  plan: ContactPlan
  /** 与 plan.sets 对齐：锚点（若有）、压头（若有）、各支撑面 / aligned with plan.sets: anchors (if any), probe (if any), the planes */
  sources: ('anchors' | 'probe' | 'plane')[]
  sets: ContactSet[]
}

export abstract class ColouredBase implements StepSolver {
  readonly nodeCount: number
  readonly tets: Uint32Array
  readonly x: Float64Array
  readonly ref: Float64Array
  readonly plan: GpuPlan
  readonly probeForce: Vec3 = [0, 0, 0]
  probePointForce: Float32Array = new Float32Array(0)
  planeForce: number[] = []
  planes: Plane[] = []
  substeps: number
  gravity: Vec3
  protected probeSet: ContactSet | null = null
  protected planeSets: ContactSet[] = []
  private probeNow: Probe | null = null
  private planesNow: Plane[] | null = null
  private gravityNow: Vec3 | null = null

  constructor(readonly cpu: SoftSolver, o: PlanOptions = {}) {
    this.plan = buildPlan(cpu, o)
    this.nodeCount = cpu.nodeCount
    this.tets = cpu.tets
    this.ref = Float64Array.from(cpu.ref)
    this.x = Float64Array.from(cpu.x)
    this.substeps = cpu.substeps
    this.gravity = [...cpu.gravity]
  }

  get probe(): Probe | null {
    return this.probeNow
  }

  set probe(p: Probe | null) {
    if (p?.control) throw new Error('softbody gpu: 力控压头（导纳）没有 GPU 内核；press() 用的是深度控制 / no GPU kernel for a force-controlled probe (admittance); press() uses depth control')
    this.probeNow = p
    this.probeSet = p ? { plan: probePlan(this.cpu, this.plan, p), probe: p, plane: null } : null
    this.probePointForce = new Float32Array(p ? p.points.tet.length : 0)
    this.contactsChanged()
  }

  /** 每帧开始时：支撑面或重力变了就重建 / at the start of every frame: rebuilt when the planes or gravity changed */
  protected refresh(): { gravity: boolean; planes: boolean } {
    let planes = false, gravity = false
    if (this.planesNow !== this.planes || this.planeSets.length !== this.planes.length) {
      this.planesNow = this.planes
      this.planeSets = this.planes.map((pl) => ({ plan: planePlan(this.cpu, pl), probe: null, plane: pl }))
      this.planeForce = this.planes.map(() => 0)
      this.contactsChanged()
      planes = true
    }
    const g = this.gravity
    if (!this.gravityNow || g[0] !== this.gravityNow[0] || g[1] !== this.gravityNow[1] || g[2] !== this.gravityNow[2]) {
      this.gravityNow = [...g]
      this.cpu.gravity = [...g]
      gravity = true
    }
    return { gravity, planes }
  }

  /** 每个结点的加速度项（重力 − 预应力 + 外力·w）/ the per-node acceleration term (gravity − pre-stress + force·w) */
  protected accel(): Float64Array {
    return accelerations(this.cpu, this.plan.w)
  }

  protected shape(c: ContactSet): ShapeParams {
    return shapeOf(c.probe, c.plane, this.plan.origin)
  }

  protected contactsChanged(): void {
    this.contactsNow = null
  }

  private contactsNow: Contacts | null = null

  /** 合并后的点约束（锚点、压头、支撑面变了就重建）/ the merged point constraints (rebuilt when anchors, probe or planes change) */
  protected contacts(): Contacts | null {
    if (this.contactsNow) return this.contactsNow
    const sets: { plan: PointPlan; kind: number; shape: number }[] = [], sources: Contacts['sources'] = [], cs: ContactSet[] = []
    let shape = 0
    if (this.plan.anchors) (sets.push({ plan: this.plan.anchors, kind: SHAPE.anchor, shape: 0 }), sources.push('anchors'))
    if (this.probeSet) (sets.push({ plan: this.probeSet.plan, kind: this.shape(this.probeSet).kind, shape: shape++ }), sources.push('probe'), cs.push(this.probeSet))
    for (const c of this.planeSets) (sets.push({ plan: c.plan, kind: SHAPE.plane, shape: shape++ }), sources.push('plane'), cs.push(c))
    if (!sets.length) return null
    this.contactsNow = { plan: contactPlan(this.nodeCount, sets, this.plan.sequential), sources, sets: cs }
    return this.contactsNow
  }

  /** 各形状的参数（每帧取，压头会动）/ the parameters of each shape (taken every frame: the probe moves) */
  protected shapes(c: Contacts): ShapeParams[] {
    return c.sets.map((q) => this.shape(q))
  }

  pointPosition(set: PointSet, i: number, out: number[]): void {
    const e = set.tet[i]! * 4
    let px = 0, py = 0, pz = 0
    for (let k = 0; k < 4; k++) {
      const n = this.tets[e + k]! * 3, b = set.bary[i * 4 + k]!
      px += b * this.x[n]!
      py += b * this.x[n + 1]!
      pz += b * this.x[n + 2]!
    }
    out[0] = px
    out[1] = py
    out[2] = pz
  }

  /** 由每点在一帧里累计的力（合并后的编号）算出 probeForce、probePointForce、planeForce / probeForce, probePointForce and planeForce from the per-point forces accumulated over a frame (merged numbering) */
  protected finishForces(c: Contacts | null, f: ArrayLike<number>, fv: ArrayLike<number>, n: number): void {
    this.probeForce[0] = this.probeForce[1] = this.probeForce[2] = 0
    const planes: number[] = []
    if (c) c.sources.forEach((src, k) => {
      const { offset, count } = c.plan.sets[k]!
      if (src === 'probe') {
        let fx = 0, fy = 0, fz = 0
        for (let i = 0; i < count; i++) {
          this.probePointForce[i] = f[offset + i]! / n
          fx += fv[(offset + i) * 4]!
          fy += fv[(offset + i) * 4 + 1]!
          fz += fv[(offset + i) * 4 + 2]!
        }
        this.probeForce[0] = fx / n
        this.probeForce[1] = fy / n
        this.probeForce[2] = fz / n
      } else if (src === 'plane') {
        let s = 0
        for (let i = 0; i < count; i++) s += f[offset + i]!
        planes.push(s / n)
      }
    })
    this.planeForce = planes
  }

  abstract step(dt: number): void
  abstract reset(): void
  abstract maxSpeed(): number
}

/**
 * CPU 镜像：同样的计划、同样的内核数学（mirror.ts），同步执行。`f32` = 状态存成 f32（与 GPU 的缓冲区一样舍入）。
 * The CPU mirror: the same plan and the same kernel mathematics (mirror.ts), run synchronously. `f32` = state stored
 * as f32 (rounded like the GPU's buffers).
 */
export class MirrorSolver extends ColouredBase {
  readonly state: MirrorState
  private readonly w = work()
  private out: PointOut | null = null
  private outFor: Contacts | null = null
  private readonly f32: boolean
  private first = true

  constructor(cpu: SoftSolver, o: PlanOptions & { f32?: boolean } = {}) {
    super(cpu, o)
    this.f32 = !!o.f32
    const p = this.plan, s = (this.state = newState(p, this.f32))
    const q = cpu.internals()
    for (let i = 0; i < p.nodeCount; i++) for (let r = 0; r < 3; r++) {
      s.u[i * 4 + r] = cpu.x[i * 3 + r]! - cpu.ref[i * 3 + r]!
      s.v[i * 4 + r] = cpu.v[i * 3 + r]!
      s.pin[i * 4 + r] = cpu.pinOffset ? cpu.pinOffset[i * 3 + r]! : 0
    }
    s.P.set(q.nodalMultiplier)
    if (q.viscous) for (let t = 0; t < p.tetCount; t++) for (let j = 0; j < 6; j++) s.ev[t * 6 + j] = q.viscous[p.tetId[t]! * 6 + j]!
  }

  step(dt: number): void {
    const r = this.refresh()
    const p = this.plan, s = this.state
    if (r.gravity || this.first) s.acc.set(this.accel())
    this.first = false
    const c = this.contacts()
    if (c !== this.outFor) (this.out = c ? newPointOut(c.plan.count, this.f32) : null), (this.outFor = c)
    const n = this.substeps, h = dt / n, st = { h, keep: Math.exp(-p.damping * h) }
    if (this.out) (this.out.f.fill(0), this.out.fv.fill(0))
    const contacts = c && this.out ? { set: c.plan, out: this.out, shapes: this.shapes(c) } : null
    for (let k = 0; k < n; k++) substep(p, s, st, contacts, this.w)
    this.finishForces(c, this.out?.f ?? [], this.out?.fv ?? [], n)
    for (let i = 0; i < p.nodeCount; i++) for (let k = 0; k < 3; k++) this.x[i * 3 + k] = this.ref[i * 3 + k]! + s.u[i * 4 + k]!
  }

  reset(): void {
    const s = this.state
    s.u.fill(0)
    s.v.fill(0)
    s.P.fill(0)
    s.ev.fill(0)
    this.x.set(this.ref)
  }

  maxSpeed(): number {
    let m = 0
    const v = this.state.v, w = this.plan.w
    for (let i = 0; i < this.nodeCount; i++) {
      if (w[i] === 0) continue
      const q = v[i * 4]! * v[i * 4]! + v[i * 4 + 1]! * v[i * 4 + 1]! + v[i * 4 + 2]! * v[i * 4 + 2]!
      if (q > m) m = q
    }
    return Math.sqrt(m)
  }
}
