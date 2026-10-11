import type { Params } from '../../core/params'
import type { Frame, RunBackend } from '../../core/substrate'
import type { GpuContext } from '../../gpu/device'
import { PassTimer } from '../../gpu/timing'
import code from './mesh.wgsl?raw'
import { initMesh, meshScalars, step, type MeshScalars, type MeshState } from './ref'

export interface MeshFrame extends Frame, MeshScalars {
  time: number
  /** 相对于初始时刻的能量变化，除以当前的 K + |W|。 / Change in energy since the start, divided by the current K + |W|. */
  drift: number
  /** 初始时刻网格上密度涨落的均方根。 / Root-mean-square density contrast on the grid at the start. */
  sigma0: number
  /** 记下这些初值的时刻。 / The time at which these starting values were taken. */
  time0: number
  /** 初始时刻基频密度模的幅度。 / Amplitude of the fundamental density mode at the start. */
  mode0: number
  /** 网格每边的格点数。 / Grid points per side. */
  M: number
}

export interface MeshBackend extends RunBackend<MeshFrame> {
  readonly n: number
  readonly M: number
}

/** 首帧记下能量和幅度的初值，之后各帧相对它们来算。 / Remembers the first frame's energy and amplitudes, against which later frames are measured. */
class Baseline {
  private first: MeshScalars | null = null
  private time0 = 0

  frame(sc: MeshScalars, stepCount: number, time: number, M: number): MeshFrame {
    if (!this.first) {
      this.first = sc
      this.time0 = time
    }
    const scale = sc.ke + Math.abs(sc.pe)
    return {
      ...sc,
      step: stepCount,
      time,
      M,
      drift: scale > 0 ? (sc.ke + sc.pe - this.first.ke - this.first.pe) / scale : 0,
      sigma0: this.first.sigma,
      time0: this.time0,
      mode0: this.first.mode,
    }
  }
}

export class MeshCpuBackend implements MeshBackend {
  readonly kind = 'cpu'
  readonly maxStepsPerFrame = 1
  state: MeshState
  private p: Params
  private baseline = new Baseline()

  constructor(p: Params, seed: number) {
    this.p = { ...p }
    // CPU 上粒子和网格每边都最多 32。 / At most 32 per side on the CPU, for particles and grid alike.
    this.state = initMesh(Math.min(1 << p.side!, 32), Math.min(1 << p.grid!, 32), p.initial!, p.amplitude!, seed, p.G!)
  }

  get n(): number {
    return this.state.n
  }

  get M(): number {
    return this.state.M
  }

  get stepCount(): number {
    return this.state.step
  }

  setParams(p: Params): void {
    this.p = { ...p }
  }

  step(n: number): void {
    step(this.state, this.p.dt!, n)
  }

  reduce(): MeshFrame {
    return this.baseline.frame(meshScalars(this.state), this.state.step, this.state.time, this.M)
  }

  dispose(): void {}
}

type Entry =
  | 'kickDrift'
  | 'clearMass'
  | 'deposit'
  | 'toComplex'
  | 'fftStage'
  | 'greens'
  | 'gradient'
  | 'interpKick'
  | 'reduceParticles'
  | 'reduceCells'

/** 每个入口用到的绑定，供自动布局使用。 / The bindings each entry point uses, for the auto layouts. */
const ENTRY_BINDINGS: Record<Entry, number[]> = {
  kickDrift: [0, 1, 2, 3],
  clearMass: [0, 4],
  deposit: [0, 1, 4],
  toComplex: [0, 4, 6],
  fftStage: [0, 5, 6, 9],
  greens: [0, 5, 6],
  gradient: [0, 5, 7],
  interpKick: [0, 1, 2, 3, 7],
  reduceParticles: [0, 1, 2, 8],
  reduceCells: [0, 4, 7, 8],
}
const CHUNK = 1024

export class MeshGpuBackend implements MeshBackend {
  readonly kind = 'gpu'
  readonly n: number
  readonly M: number
  readonly maxStepsPerFrame: number
  stepCount = 0
  /** 位置（xyz），供渲染器使用。 / Positions (xyz), for the renderer. */
  readonly pos: GPUBuffer

  private device: GPUDevice
  private p: Params
  private time = 0
  private cells: number
  private particleChunks: number
  private cellChunks: number
  private pipelines = {} as Record<Entry, GPUComputePipeline>
  private fixed = {} as Record<Exclude<Entry, 'fftStage' | 'greens' | 'gradient'>, GPUBindGroup>
  /** 一次求力所用的 FFT 通道，按顺序；中间夹着格林函数那一步。 / The FFT passes of one force evaluation, in order, with the Green's function step between them. */
  private solve: { entry: Entry; group: GPUBindGroup }[] = []
  private buffers: GPUBuffer[] = []
  private inFlight = 0
  private disposed = false
  private timer: PassTimer
  private baseline = new Baseline()

  constructor(gpu: GpuContext, p: Params, seed: number) {
    this.device = gpu.device
    this.timer = new PassTimer(gpu.device)
    this.p = { ...p }
    const init = initMesh(1 << p.side!, 1 << p.grid!, p.initial!, p.amplitude!, seed, p.G!, false)
    this.n = init.n
    this.M = init.M
    this.cells = this.M ** 3
    this.particleChunks = Math.ceil(this.n / CHUNK)
    this.cellChunks = Math.ceil(this.cells / CHUNK)
    this.maxStepsPerFrame = this.cells > 64 ** 3 ? 2 : 4
    const device = this.device
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    const make = (size: number, usage = storage) => device.createBuffer({ size, usage })
    const uniform = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    // 0 参数；1–3 位置、速度、加速度；4 质量；5、6 两张复数网格；7 加速度与势；8 归约。
    // 0 parameters; 1–3 positions, velocities, accelerations; 4 mass; 5, 6 the two complex grids; 7 accelerations and potential; 8 reductions.
    this.buffers = [
      make(32, uniform),
      make(this.n * 16),
      make(this.n * 16),
      make(this.n * 16),
      make(this.cells * 4),
      make(this.cells * 8),
      make(this.cells * 8),
      make(this.cells * 16),
      make((2 * this.particleChunks + this.cellChunks) * 16),
    ]
    this.pos = this.buffers[1]!
    const pos = new Float32Array(this.n * 4)
    const vel = new Float32Array(this.n * 4)
    for (let i = 0; i < this.n; i++) {
      for (let d = 0; d < 3; d++) {
        pos[4 * i + d] = init.pos[3 * i + d]!
        vel[4 * i + d] = init.vel[3 * i + d]!
      }
    }
    device.queue.writeBuffer(this.buffers[1]!, 0, pos)
    device.queue.writeBuffer(this.buffers[2]!, 0, vel)

    const module = device.createShaderModule({ code })
    for (const entry of Object.keys(ENTRY_BINDINGS) as Entry[]) {
      this.pipelines[entry] = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: entry } })
    }
    // 绑定 5 是读、6 是写；src 和 dst 说明这一步从哪张复数网格读、往哪张写。
    // Binding 5 is read and 6 is written; src and dst say which complex grid a pass reads and which it writes.
    const group = (entry: Entry, src?: GPUBuffer, dst?: GPUBuffer, stage?: GPUBuffer) =>
      device.createBindGroup({
        layout: this.pipelines[entry].getBindGroupLayout(0),
        entries: ENTRY_BINDINGS[entry].map((binding) => ({
          binding,
          resource: { buffer: binding === 5 ? src! : binding === 6 ? dst! : binding === 9 ? stage! : this.buffers[binding]! },
        })),
      })
    const [A, B] = [this.buffers[5]!, this.buffers[6]!]
    for (const entry of ['kickDrift', 'clearMass', 'deposit', 'interpKick', 'reduceParticles', 'reduceCells'] as const) {
      this.fixed[entry] = group(entry)
    }
    this.fixed.toComplex = group('toComplex', undefined, A)
    // 复数网格在 A 与 B 之间来回倒腾：每一步读当前的那张，写另一张。
    // The complex grid ping-pongs between A and B: each pass reads the current one and writes the other.
    let current = A
    const other = () => (current === A ? B : A)
    const transform = (sign: number) => {
      for (let axis = 0; axis < 3; axis++) {
        for (let stride = 1; stride < this.M; stride *= 2) {
          const stage = make(16, uniform)
          const data = new ArrayBuffer(16)
          new Uint32Array(data, 0, 2).set([axis, stride])
          new Float32Array(data, 8, 1).set([sign])
          device.queue.writeBuffer(stage, 0, data)
          this.buffers.push(stage)
          this.solve.push({ entry: 'fftStage', group: group('fftStage', current, other(), stage) })
          current = other()
        }
      }
    }
    transform(-1)
    this.solve.push({ entry: 'greens', group: group('greens', current, other()) })
    current = other()
    transform(1)
    this.solve.push({ entry: 'gradient', group: group('gradient', current) })

    // 初始加速度：做一次求力，步长取 0 的“踢”只写入加速度。
    // Initial accelerations: one force evaluation, where a kick with zero step only stores the accelerations.
    this.writeParams(0)
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    this.encodeForces(pass)
    pass.end()
    this.submit(encoder)
    this.writeParams(p.dt!)
  }

  private writeParams(dt: number): void {
    const data = new ArrayBuffer(32)
    new Uint32Array(data, 0, 4).set([this.n, this.M, CHUNK, this.particleChunks])
    new Float32Array(data, 16, 4).set([dt, this.p.G!, 0, 0])
    this.device.queue.writeBuffer(this.buffers[0]!, 0, data)
  }

  private dispatch(pass: GPUComputePassEncoder, entry: Entry, group: GPUBindGroup, count: number, size = 256): void {
    pass.setPipeline(this.pipelines[entry])
    pass.setBindGroup(0, group)
    pass.dispatchWorkgroups(Math.ceil(count / size))
  }

  /** 分配、解泊松方程、求梯度、插值并踢半步。 / Deposit, solve Poisson's equation, take the gradient, interpolate and kick half a step. */
  private encodeForces(pass: GPUComputePassEncoder): void {
    this.dispatch(pass, 'clearMass', this.fixed.clearMass, this.cells)
    this.dispatch(pass, 'deposit', this.fixed.deposit, this.n)
    this.dispatch(pass, 'toComplex', this.fixed.toComplex, this.cells)
    for (const s of this.solve) this.dispatch(pass, s.entry, s.group, this.cells)
    this.dispatch(pass, 'interpKick', this.fixed.interpKick, this.n)
  }

  setParams(p: Params): void {
    this.p = { ...p }
    this.writeParams(p.dt!)
  }

  private submit(encoder: GPUCommandEncoder): void {
    this.device.queue.submit([encoder.finish()])
    this.inFlight++
    void this.device.queue.onSubmittedWorkDone().then(() => this.inFlight--)
  }

  step(n: number): void {
    if (this.inFlight >= 2 || this.disposed) return
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass(this.timer.descriptor())
    for (let i = 0; i < n; i++) {
      this.dispatch(pass, 'kickDrift', this.fixed.kickDrift, this.n)
      this.encodeForces(pass)
    }
    pass.end()
    this.timer.resolve(encoder)
    this.submit(encoder)
    this.timer.collect()
    this.stepCount += n
    this.time += n * this.p.dt!
  }

  get gpuStepMs(): number | null {
    return this.timer.ms
  }

  async reduce(): Promise<MeshFrame> {
    const stepCount = this.stepCount
    const time = this.time
    const bytes = (2 * this.particleChunks + this.cellChunks) * 16
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    this.dispatch(pass, 'reduceParticles', this.fixed.reduceParticles, this.particleChunks, 64)
    this.dispatch(pass, 'reduceCells', this.fixed.reduceCells, this.cellChunks, 64)
    pass.end()
    const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    encoder.copyBufferToBuffer(this.buffers[8]!, 0, staging, 0, bytes)
    this.submit(encoder)
    await staging.mapAsync(GPUMapMode.READ)
    const f = new Float32Array(staging.getMappedRange())
    let ke = 0
    let re = 0
    let im = 0
    const p = [0, 0, 0]
    for (let c = 0; c < this.particleChunks; c++) {
      ke += f[8 * c]!
      for (let d = 0; d < 3; d++) p[d]! += f[8 * c + 1 + d]!
      re += f[8 * c + 4]!
      im += f[8 * c + 5]!
    }
    let work = 0
    let square = 0
    let peak = -1
    for (let c = 0; c < this.cellChunks; c++) {
      const o = 8 * this.particleChunks + 4 * c
      work += f[o]!
      square += f[o + 1]!
      peak = Math.max(peak, f[o + 2]!)
    }
    staging.unmap()
    staging.destroy()
    return this.baseline.frame(
      {
        ke: ke / this.n,
        pe: (0.5 * work) / this.cells,
        momentum: Math.hypot(p[0]!, p[1]!, p[2]!) / this.n,
        mode: (2 * Math.hypot(re, im)) / this.n,
        sigma: Math.sqrt(square / this.cells),
        peak: peak + 1,
      },
      stepCount,
      time,
      this.M,
    )
  }

  /** 完整回读粒子状态，仅供交叉校验工具使用。 / Full readback of the particle state, for the cross-check harness only. */
  async readState(): Promise<{ pos: Float32Array; vel: Float32Array; acc: Float32Array }> {
    const bytes = this.n * 16
    const staging = this.device.createBuffer({ size: 3 * bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const encoder = this.device.createCommandEncoder()
    for (let b = 0; b < 3; b++) encoder.copyBufferToBuffer(this.buffers[b + 1]!, 0, staging, b * bytes, bytes)
    this.device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const all = new Float32Array(staging.getMappedRange().slice(0))
    staging.destroy()
    return { pos: all.subarray(0, this.n * 4), vel: all.subarray(this.n * 4, this.n * 8), acc: all.subarray(this.n * 8) }
  }

  idle(): Promise<void> {
    return this.device.queue.onSubmittedWorkDone()
  }

  dispose(): void {
    this.disposed = true
    this.timer.destroy()
    for (const b of this.buffers) b.destroy()
  }
}
