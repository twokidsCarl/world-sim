// WebGPU 上的软组织求解器：着色的 Gauss–Seidel（plan.ts 文件头），内核在 kernels.ts，CPU 镜像在 mirror.ts。
// 用法与 SoftSolver 在 press() 和体位循环里一样（stepper.ts 的 StepSolver），只是 step() 只排队，读结果前要 await sync()。
// The soft-tissue solver on WebGPU: coloured Gauss–Seidel (header of plan.ts), kernels in kernels.ts, CPU mirror in
// mirror.ts. Used as SoftSolver is in press() and the posture loop (StepSolver of stepper.ts), except that step() only
// queues and results need an `await sync()` before they are read.

import type { SoftSolver } from '../solver.ts'
import { DYN_STRIDE, ENTRY_POINTS, GLOBALS_BYTES, MAX_SHAPES, STORAGE_BUFFERS, WGSL, WORKGROUP } from './kernels.ts'
import { CAP_STRIDE } from './plan.ts'
import { ColouredBase, type Contacts, type PlanOptions } from './stepper.ts'

// WebGPU 规范里的常数（TypeScript 的 DOM 库只有类型，没有这几个全局量）/ constants of the WebGPU specification (the TypeScript DOM library has the types but not these globals)
const BU = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 } as const
const COMPUTE_STAGE = 0x4
const MAP_READ_MODE = 0x1

let devicePromise: Promise<GPUDevice | null> | null = null
let deviceError: string | null = null

/**
 * 这个线程（主线程或 worker）的 GPU 设备；没有 WebGPU、适配器的限额不够或申请失败时为 null（原因见 gpuUnavailableReason）。
 * The GPU device of this thread (main thread or worker); null without WebGPU, when the adapter's limits are too small or
 * the request fails (the reason is in gpuUnavailableReason).
 */
export function gpuDevice(): Promise<GPUDevice | null> {
  devicePromise ??= (async () => {
    const gpu = (globalThis.navigator as Navigator | undefined)?.gpu
    if (!gpu) {
      deviceError = '没有 WebGPU / no WebGPU'
      return null
    }
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) {
      deviceError = '没有 GPU 适配器 / no GPU adapter'
      return null
    }
    if (adapter.limits.maxStorageBuffersPerShaderStage < STORAGE_BUFFERS) {
      deviceError = `适配器每个着色器只给 ${adapter.limits.maxStorageBuffersPerShaderStage} 个存储缓冲区，要 ${STORAGE_BUFFERS} 个 / the adapter allows ${adapter.limits.maxStorageBuffersPerShaderStage} storage buffers per shader, ${STORAGE_BUFFERS} are needed`
      return null
    }
    try {
      const device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } })
      void device.lost.then((info) => {
        deviceError = `GPU 设备丢失 / GPU device lost: ${info.message}`
        devicePromise = null
      })
      return device
    } catch (err) {
      deviceError = `申请 GPU 设备失败 / requesting the GPU device failed: ${err instanceof Error ? err.message : String(err)}`
      return null
    }
  })()
  return devicePromise
}

export function gpuUnavailableReason(): string | null {
  return deviceError
}

/**
 * 先编译着色器和管线（worker 起来时调用，不等它）：第一次按压就不必等编译（本机上第一次约 3 s，之后由浏览器缓存）。
 * Compiles the shader and pipelines ahead (called when the worker starts, not awaited), so the first press does not
 * wait for compilation (about 3 s the first time on this machine; the browser caches it afterwards).
 */
export function warmGpu(device: GPUDevice): void {
  void pipelines(device).catch(() => {})
}

const pipelineCache = new WeakMap<GPUDevice, Promise<{ layout: GPUBindGroupLayout; pipes: Record<(typeof ENTRY_POINTS)[number], GPUComputePipeline> }>>()

function pipelines(device: GPUDevice): Promise<{ layout: GPUBindGroupLayout; pipes: Record<(typeof ENTRY_POINTS)[number], GPUComputePipeline> }> {
  let p = pipelineCache.get(device)
  if (!p) {
    p = (async () => {
      const entries: GPUBindGroupLayoutEntry[] = [
        { binding: 0, visibility: COMPUTE_STAGE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: COMPUTE_STAGE, buffer: { type: 'uniform', hasDynamicOffset: true } },
      ]
      // topo、tetD、nodeS、st、sc、ptT、ptF（kernels.ts 的绑定 2–8）/ topo, tetD, nodeS, st, sc, ptT, ptF (bindings 2–8 of kernels.ts)
      const kinds: GPUBufferBindingType[] = ['read-only-storage', 'read-only-storage', 'read-only-storage', 'storage', 'storage', 'read-only-storage', 'storage']
      kinds.forEach((type, k) => entries.push({ binding: 2 + k, visibility: COMPUTE_STAGE, buffer: { type } }))
      const layout = device.createBindGroupLayout({ entries })
      const module = device.createShaderModule({ code: WGSL })
      const info = await module.getCompilationInfo()
      const errs = info.messages.filter((m) => m.type === 'error')
      if (errs.length) throw new Error(`softbody gpu: WGSL: ${errs.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; ')}`)
      const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] })
      const pipes = {} as Record<(typeof ENTRY_POINTS)[number], GPUComputePipeline>
      await Promise.all(ENTRY_POINTS.map(async (e) => (pipes[e] = await device.createComputePipelineAsync({ layout: pl, compute: { module, entryPoint: e } }))))
      return { layout, pipes }
    })()
    pipelineCache.set(device, p)
  }
  return p
}

/** 一次派发：动态 uniform 的项和线程数 / one dispatch: its dynamic uniform entry and thread count */
interface Disp {
  entry: number
  count: number
}

/**
 * GPU 求解器。由一个配置好的 CPU 求解器建（材料、子步、阻尼、锚点、胶囊都取自它）；参考构形必须静止。
 * The GPU solver. Built from a configured CPU solver (materials, substeps, damping, anchors and capsules all come from
 * it); the reference must be static.
 */
export class GpuSolver extends ColouredBase {
  private readonly device: GPUDevice
  private layout!: GPUBindGroupLayout
  private pipes!: Record<(typeof ENTRY_POINTS)[number], GPUComputePipeline>
  private readonly buf: Record<'G' | 'D' | 'topo' | 'tetD' | 'nodeS' | 'st' | 'sc', GPUBuffer>
  private pts: { T: GPUBuffer | null; F: GPUBuffer | null; count: number; c: Contacts | null; disp: Disp[] } | null = null
  private bind: GPUBindGroup | null = null
  private tetDisp: Disp[] = []
  private volDisp: Disp[] = []
  private staging: GPUBuffer | null = null
  private readonly globals = new ArrayBuffer(GLOBALS_BYTES)
  private readonly offs: { oRS: number; oRE: number; oSL: number; oNS: number; oNB: number; oCS: number; oTO: number; oVO: number; oCap: number; oTN: number; oTC: number; oSP: number; oVS: number; oVL: number }
  /** 速度归约的工作组数 / workgroups of the speed reduction */
  private readonly groups: number
  private speed = Infinity
  private pending = 0
  private frameN = 1
  private contactsDirty = true
  private accDirty = true
  /** 自上次 sync 以来排进去的帧 / frames queued since the last sync */
  get queued(): number {
    return this.pending
  }

  static async create(cpu: SoftSolver, o: PlanOptions & { device?: GPUDevice } = {}): Promise<GpuSolver> {
    const device = o.device ?? (await gpuDevice())
    if (!device) throw new Error(`softbody gpu: ${gpuUnavailableReason() ?? 'no device'}`)
    const s = new GpuSolver(cpu, device, o)
    const p = await pipelines(device)
    s.layout = p.layout
    s.pipes = p.pipes
    return s
  }

  private constructor(cpu: SoftSolver, device: GPUDevice, o: PlanOptions) {
    super(cpu, o)
    this.device = device
    const p = this.plan, N = p.nodeCount, Ta = p.tetCount
    const make = (data: ArrayBufferView | number, usage: number): GPUBuffer => {
      const size = Math.max(16, Math.ceil((typeof data === 'number' ? data : data.byteLength) / 16) * 16)
      const b = device.createBuffer({ size, usage: usage | BU.COPY_DST | BU.COPY_SRC, mappedAtCreation: typeof data !== 'number' })
      if (typeof data !== 'number') {
        new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        b.unmap()
      }
      return b
    }
    const S = BU.STORAGE
    // topo：各段首尾相接 / topo: the sections end to end
    const parts = [p.ringStart, p.ringEntry, p.ringSlots, p.nbrStart, p.nbr, p.capStart, p.tetSched.order, p.volSched.order, p.tetNodes, p.vlStart, p.vl]
    const at: number[] = []
    let len = 0
    for (const a of parts) (at.push(len), (len += a.length))
    const topo = new Uint32Array(len)
    parts.forEach((a, k) => topo.set(a, at[k]))
    const C = p.capStart[N]!
    this.groups = Math.ceil(N / WORKGROUP)
    this.offs = { oRS: at[0]!, oRE: at[1]!, oSL: at[2]!, oNS: at[3]!, oNB: at[4]!, oCS: at[5]!, oTO: at[6]!, oVO: at[7]!, oCap: 3 * N, oTN: at[8]!, oTC: 3 * N, oSP: 3 * N + 4 * Ta, oVS: at[9]!, oVL: at[10]! }
    const tetD = new Float32Array(Ta * 36)
    for (let t = 0; t < Ta; t++) {
      const o = t * 36
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        tetD[o + r * 4 + c] = p.tetB[t * 9 + r * 3 + c]!
        tetD[o + 12 + r * 4 + c] = p.tetE0[t * 9 + r * 3 + c]!
      }
      for (let j = 0; j < 8; j++) tetD[o + 24 + j] = p.tetPar[t * 8 + j]!
      for (let r = 0; r < 3; r++) tetD[o + 32 + r] = p.tetFib[t * 4 + r]!
    }
    const nodeS = new Float32Array((3 * N + 2 * C) * 4)
    for (let i = 0; i < N; i++) {
      nodeS[i * 4] = p.w[i]!
      nodeS[i * 4 + 1] = p.K[i]!
      nodeS[i * 4 + 2] = p.V[i]!
      if (cpu.pinOffset) for (let r = 0; r < 3; r++) nodeS[(2 * N + i) * 4 + r] = cpu.pinOffset[i * 3 + r]!
    }
    for (let e = 0; e < C; e++) {
      const q = e * CAP_STRIDE, o = (3 * N + 2 * e) * 4
      nodeS.set([p.capData[q]!, p.capData[q + 1]!, p.capData[q + 2]!, p.capData[q + 6]!, p.capData[q + 3]!, p.capData[q + 4]!, p.capData[q + 5]!, p.capData[q + 7]!], o)
    }
    const st = new Float32Array((3 * N + 4 * Ta + this.groups) * 4)
    for (let i = 0; i < N; i++) for (let r = 0; r < 3; r++) {
      st[i * 4 + r] = cpu.x[i * 3 + r]! - cpu.ref[i * 3 + r]!
      st[(N + i) * 4 + r] = cpu.v[i * 3 + r]!
    }
    const q = cpu.internals()
    const sc = new Float32Array(N + 6 * Ta)
    sc.set(q.nodalMultiplier)
    if (q.viscous) for (let t = 0; t < Ta; t++) for (let j = 0; j < 6; j++) sc[N + t * 6 + j] = q.viscous[p.tetId[t]! * 6 + j]!
    this.buf = {
      G: make(GLOBALS_BYTES, BU.UNIFORM),
      D: make(DYN_STRIDE, BU.UNIFORM),
      topo: make(topo, S),
      tetD: make(tetD, S),
      nodeS: make(nodeS, S),
      st: make(st, S),
      sc: make(sc, S),
    }
  }

  /** 接触点变了：重建点缓冲区和动态 uniform / the contact points changed: point buffers and the dynamic uniform are rebuilt */
  protected override contactsChanged(): void {
    super.contactsChanged()
    this.contactsDirty = true
  }

  private rebuildContacts(): void {
    this.contactsDirty = false
    const p = this.plan, dev = this.device
    const c = this.contacts()
    if (c && c.sets.length > MAX_SHAPES) throw new Error(`softbody gpu: 最多 ${MAX_SHAPES} 个压头和支撑面 / at most ${MAX_SHAPES} probes and planes`)
    // ptT = 各点 4 个结点 | 各点的种类和形状 | order | groupStart | 各点 8 个 f32（重心、base 和 1/k）的位
    // ptT = the four nodes of each point | each point's kind and shape | order | groupStart | the bits of 8 f32 per point (barycentric, base and 1/k)
    const cp = c?.plan, m = cp?.count ?? 0
    const oKS = m * 4, oOrder = oKS + m, oGroup = oOrder + m, oPD = oGroup + (cp ? cp.groupStart.length : 0)
    if (this.pts) (this.pts.T?.destroy(), this.pts.F?.destroy())
    let T: GPUBuffer | null = null, F: GPUBuffer | null = null
    const mk = (size: number): GPUBuffer => dev.createBuffer({ size: Math.max(16, Math.ceil(size / 16) * 16), usage: BU.STORAGE | BU.COPY_DST | BU.COPY_SRC })
    if (cp) {
      const data = new Uint32Array(oPD + m * 8), fl = new Float32Array(data.buffer)
      data.set(cp.nodes, 0)
      for (let i = 0; i < m; i++) data[oKS + i] = cp.kind[i]! | (cp.shape[i]! << 8)
      data.set(cp.order, oOrder)
      data.set(cp.groupStart, oGroup)
      for (let i = 0; i < m; i++) {
        for (let k = 0; k < 4; k++) fl[oPD + i * 8 + k] = cp.bary[i * 4 + k]!
        for (let k = 0; k < 3; k++) fl[oPD + i * 8 + 4 + k] = cp.base[i * 4 + k]!
        fl[oPD + i * 8 + 7] = cp.invK[i]!
      }
      T = mk(data.byteLength)
      dev.queue.writeBuffer(T, 0, data)
      F = mk(m * 16)
    }
    // 动态 uniform：第 0 项给不看它的内核；然后四面体的颜色、体积的颜色、点组的颜色 / dynamic uniform: entry 0 for kernels that ignore it; then tet colours, volume colours, point-group colours
    const entries: number[][] = [[0, 0, 0, 0, 0, 0, 0, 0]]
    const disp = (start: number, cnt: number, rest: number[] = [0, 0, 0, 0, 0, 0]): Disp => {
      entries.push([start, cnt, ...rest])
      return { entry: entries.length - 1, count: cnt }
    }
    const tc = p.tetSched.colourStart, vc = p.volSched.colourStart
    this.tetDisp = []
    for (let k = 0; k + 1 < tc.length; k++) this.tetDisp.push(disp(tc[k]!, tc[k + 1]! - tc[k]!))
    this.volDisp = []
    if (p.nodal) for (let k = 0; k + 1 < vc.length; k++) this.volDisp.push(disp(vc[k]!, vc[k + 1]! - vc[k]!))
    const pd: Disp[] = []
    if (cp) for (let k = 0; k + 1 < cp.colourStart.length; k++) pd.push(disp(cp.colourStart[k]!, cp.colourStart[k + 1]! - cp.colourStart[k]!, [oKS, 0, 0, oOrder, oGroup, oPD]))
    const dyn = new Uint32Array(entries.length * (DYN_STRIDE / 4))
    entries.forEach((e, k) => dyn.set(e, k * (DYN_STRIDE / 4)))
    this.buf.D.destroy()
    this.buf.D = dev.createBuffer({ size: dyn.byteLength, usage: BU.UNIFORM | BU.COPY_DST })
    dev.queue.writeBuffer(this.buf.D, 0, dyn)
    this.pts = { T, F, count: m, c, disp: pd }
    // 没有点约束时绑两块占位的缓冲区（同一块不能既只读又可写地绑两次）/ without point constraints two placeholder buffers are bound (one buffer cannot be bound both read-only and writable)
    this.placeholder ??= [mk(16), mk(16)]
    const b = this.buf
    const res = [b.G, b.D, b.topo, b.tetD, b.nodeS, b.st, b.sc, T ?? this.placeholder[0], F ?? this.placeholder[1]]
    this.bind = dev.createBindGroup({ layout: this.layout, entries: res.map((buffer, k) => (k === 1 ? { binding: k, resource: { buffer, size: 32 } } : { binding: k, resource: { buffer } })) })
    this.staging?.destroy()
    this.staging = null
  }

  private placeholder: [GPUBuffer, GPUBuffer] | null = null

  /** 每帧的 uniform：子步长、阻尼、各形状 / the per-frame uniform: substep, damping, shapes */
  private writeGlobals(h: number): void {
    const p = this.plan, u = new Uint32Array(this.globals), f = new Float32Array(this.globals)
    const o = this.offs
    u.set([p.nodeCount, p.tetCount, p.nodal ? 1 : 0, o.oRS, o.oRE, o.oSL, o.oNS, o.oNB, o.oCS, o.oTO, o.oVO, o.oCap])
    f[12] = h
    f[13] = 1 / (h * h)
    f[14] = Math.exp(-p.damping * h)
    f[15] = p.volumeCap
    u.set([o.oTN, o.oTC, o.oSP, o.oVS, o.oVL, 0, 0, 0], 16)
    const c = this.pts!.c
    if (c) this.shapes(c).forEach((sh, k) => {
      const b = 24 + k * 12
      f.set([sh.c[0], sh.c[1], sh.c[2], 0, sh.a[0], sh.a[1], sh.a[2], 0], b)
      u[b + 8] = sh.kind
      f[b + 9] = sh.radius
    })
    this.device.queue.writeBuffer(this.buf.G, 0, this.globals)
  }

  step(dt: number): void {
    const r = this.refresh()
    if (r.gravity) this.accDirty = true
    if (this.contactsDirty || !this.bind) this.rebuildContacts()
    const p = this.plan, N = p.nodeCount, dev = this.device
    if (this.accDirty) {
      const acc = this.accel()
      dev.queue.writeBuffer(this.buf.nodeS, N * 16, Float32Array.from(acc))
      this.accDirty = false
    }
    const n = this.substeps, h = dt / n
    this.writeGlobals(h)
    const enc = dev.createCommandEncoder()
    if (this.pts!.F) enc.clearBuffer(this.pts!.F)
    const pass = enc.beginComputePass()
    const bg = this.bind!, P = this.pipes
    let cur: GPUComputePipeline | null = null
    const run = (pipe: GPUComputePipeline, d: Disp, perGroup = false): void => {
      if (!d.count) return
      if (pipe !== cur) pass.setPipeline((cur = pipe))
      pass.setBindGroup(0, bg, [d.entry * DYN_STRIDE])
      pass.dispatchWorkgroups(perGroup ? d.count : Math.ceil(d.count / WORKGROUP))
    }
    const allT: Disp = { entry: 0, count: p.tetCount }, allN: Disp = { entry: 0, count: N }
    for (let k = 0; k < n; k++) {
      if (p.nodal) run(P.pressure, allT)
      run(P.predict, allN)
      for (const d of this.tetDisp) run(P.tet, d)
      for (const d of this.volDisp) run(P.volume, d, true)
      for (const d of this.pts!.disp) run(P.points, d)
      run(P.finish, allN)
    }
    pass.end()
    dev.queue.submit([enc.finish()])
    this.pending++
    this.frameN = n
  }

  /** 剖析（tools/softbody/gpu-check.ts profile）：只派发某一组内核 reps 次，返回每次的毫秒 / profiling (tools/softbody/gpu-check.ts profile): dispatches one kernel group reps times, returns ms per repetition */
  async profileGroup(group: string, reps: number): Promise<number> {
    if (this.contactsDirty || !this.bind) this.rebuildContacts()
    this.writeGlobals(1 / 60 / this.substeps)
    const P = this.pipes, p = this.plan
    await this.device.queue.onSubmittedWorkDone()
    const t0 = performance.now()
    const enc = this.device.createCommandEncoder()
    const pass = enc.beginComputePass()
    let cur: GPUComputePipeline | null = null
    const run = (pipe: GPUComputePipeline, d: Disp, perGroup = false): void => {
      if (!d.count) return
      if (pipe !== cur) pass.setPipeline((cur = pipe))
      pass.setBindGroup(0, this.bind!, [d.entry * DYN_STRIDE])
      pass.dispatchWorkgroups(perGroup ? d.count : Math.ceil(d.count / WORKGROUP))
    }
    for (let k = 0; k < reps; k++) {
      if (group === 'pressure') run(P.pressure, { entry: 0, count: p.tetCount })
      if (group === 'predict') run(P.predict, { entry: 0, count: p.nodeCount })
      if (group === 'finish') run(P.finish, { entry: 0, count: p.nodeCount })
      if (group === 'tet') for (const d of this.tetDisp) run(P.tet, d)
      if (group === 'volume') for (const d of this.volDisp) run(P.volume, d, true)
      if (group === 'points') for (const d of this.pts!.disp) run(P.points, d)
    }
    pass.end()
    this.device.queue.submit([enc.finish()])
    await this.device.queue.onSubmittedWorkDone()
    return (performance.now() - t0) / reps
  }

  /**
   * 等排进去的帧算完，读回位置（positions 为 false 时不读）、接触力和最大速度。
   * Waits for the queued frames and reads back positions (skipped when `positions` is false), contact forces and the
   * largest speed.
   */
  async sync(o: { positions?: boolean } = {}): Promise<void> {
    if (!this.bind) this.rebuildContacts()
    const p = this.plan, N = p.nodeCount, dev = this.device
    const pos = o.positions !== false
    const fBytes = this.pts!.count * 16, sBytes = this.groups * 16
    const need = sBytes + fBytes + (pos ? N * 16 : 0)
    if (!this.staging || this.staging.size < need) {
      this.staging?.destroy()
      this.staging = dev.createBuffer({ size: Math.ceil((sBytes + fBytes + N * 16) / 16) * 16, usage: BU.MAP_READ | BU.COPY_DST })
    }
    const enc = dev.createCommandEncoder()
    const pass = enc.beginComputePass()
    pass.setPipeline(this.pipes.speed)
    pass.setBindGroup(0, this.bind!, [0])
    pass.dispatchWorkgroups(this.groups)
    pass.end()
    enc.copyBufferToBuffer(this.buf.st, this.offs.oSP * 16, this.staging, 0, sBytes)
    if (fBytes) enc.copyBufferToBuffer(this.pts!.F!, 0, this.staging, sBytes, fBytes)
    if (pos) enc.copyBufferToBuffer(this.buf.st, 0, this.staging, sBytes + fBytes, N * 16)
    dev.queue.submit([enc.finish()])
    await this.staging.mapAsync(MAP_READ_MODE, 0, need)
    const data = this.staging.getMappedRange(0, need)
    const sp = new Float32Array(data, 0, this.groups * 4)
    let m = 0
    for (let k = 0; k < this.groups; k++) m = Math.max(m, sp[k * 4]!)
    this.speed = Math.sqrt(m)
    if (fBytes) {
      const F = new Float32Array(data, sBytes, this.pts!.count * 4)
      const m = this.pts!.count, f = new Float32Array(m), fv = new Float32Array(m * 4)
      for (let i = 0; i < m; i++) {
        fv[i * 4] = F[i * 4]!
        fv[i * 4 + 1] = F[i * 4 + 1]!
        fv[i * 4 + 2] = F[i * 4 + 2]!
        f[i] = F[i * 4 + 3]!
      }
      this.finishForces(this.pts!.c, f, fv, this.frameN)
    }
    if (pos) {
      const u = new Float32Array(data, sBytes + fBytes, N * 4)
      for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) this.x[i * 3 + c] = this.ref[i * 3 + c]! + u[i * 4 + c]!
    }
    this.staging.unmap()
    this.pending = 0
  }

  reset(): void {
    const p = this.plan, N = p.nodeCount
    this.device.queue.writeBuffer(this.buf.st, 0, new Float32Array(3 * N * 4))
    this.device.queue.writeBuffer(this.buf.sc, 0, new Float32Array(N + 6 * p.tetCount))
    this.x.set(this.ref)
    this.speed = 0
  }

  maxSpeed(): number {
    return this.speed
  }

  /** 释放 GPU 缓冲区 / releases the GPU buffers */
  destroy(): void {
    for (const b of Object.values(this.buf)) b.destroy()
    if (this.pts) (this.pts.T?.destroy(), this.pts.F?.destroy())
    this.placeholder?.forEach((b) => b.destroy())
    this.staging?.destroy()
  }
}
