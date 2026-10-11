import type { Params } from '../../core/params'
import type { Frame, RunBackend } from '../../core/substrate'
import type { GpuContext } from '../../gpu/device'
import { PassTimer } from '../../gpu/timing'
import code from './gravity.wgsl?raw'
import {
  boundVirial,
  gravityScalars,
  leapfrog,
  plummerSphere,
  radialCounts,
  uniformSphere,
  type BoundSums,
  type GravityState,
} from './ref'

export const RADIAL_BINS = 48
export const RADIAL_MAX = 4
const CPU_MAX_N = 1024
const CHUNK = 256

export interface GravityFrame extends Frame {
  time: number
  n: number
  ke: number
  pe: number
  momentum: number
  boundFraction: number
  /**
   * 束缚天体的 2K / |W|；见 GravityScalars.virialBound。
   * 2K / |W| of the bound bodies; see GravityScalars.virialBound.
   */
  virialBound: number
  /**
   * 束缚残余体的中心，各径向量都从这里量起。
   * Centre of the bound remnant, which radial quantities are measured from.
   */
  centre: [number, number, number]
  /**
   * (E - E0) / |E0|，其中 E0 为初始状态的能量。
   * (E - E0) / |E0|, where E0 is the energy of the initial state.
   */
  drift: number
  /**
   * 以 `centre` 为中心、宽度为 RADIAL_MAX / RADIAL_BINS 的各径向壳层内的天体数。
   * Bodies per radial shell of width RADIAL_MAX / RADIAL_BINS about `centre`.
   */
  radial: Float64Array
}

export interface GravityBackend extends RunBackend<GravityFrame> {
  readonly n: number
  /**
   * 最近一次归约得到的束缚残余体中心；视图跟随它。
   * Centre of the bound remnant as of the last reduction; the view follows it.
   */
  readonly centre: [number, number, number]
}

function initialState(p: Params, seed: number, n: number): GravityState {
  return p.initial === 1 ? plummerSphere(n, p.eps!, seed) : uniformSphere(n, p.virial0!, p.eps!, seed)
}

export class GravityCpuBackend implements GravityBackend {
  readonly kind = 'cpu'
  state: GravityState
  centre: [number, number, number] = [0, 0, 0]
  private p: Params
  private time = 0
  private e0: number

  constructor(p: Params, seed: number) {
    this.p = { ...p }
    this.state = initialState(p, seed, Math.min(1 << p.n!, CPU_MAX_N))
    const sc = gravityScalars(this.state)
    this.e0 = sc.ke + sc.pe
  }

  get n(): number {
    return this.state.n
  }

  get stepCount(): number {
    return this.state.step
  }

  setParams(p: Params): void {
    this.p = { ...p }
  }

  step(n: number): void {
    leapfrog(this.state, this.p.eps!, this.p.dt!, n)
    this.time += n * this.p.dt!
  }

  reduce(): GravityFrame {
    const sc = gravityScalars(this.state)
    this.centre = sc.centre
    return {
      step: this.state.step,
      time: this.time,
      n: this.n,
      ke: sc.ke,
      pe: sc.pe,
      momentum: sc.momentum,
      boundFraction: sc.boundFraction,
      virialBound: sc.virialBound,
      centre: sc.centre,
      drift: (sc.ke + sc.pe - this.e0) / Math.abs(this.e0),
      radial: radialCounts(this.state, RADIAL_BINS, RADIAL_MAX, sc.centre),
    }
  }

  dispose(): void {}
}

type Entry = 'accel' | 'kickDrift' | 'kick' | 'reduceChunks' | 'clearHist' | 'radialHist'

const ENTRY_BINDINGS: Record<Entry, number[]> = {
  accel: [0, 1, 3],
  kickDrift: [0, 1, 2, 3],
  kick: [0, 2, 3],
  reduceChunks: [0, 1, 2, 3, 4],
  clearHist: [0, 5],
  radialHist: [0, 1, 5],
}

export class GravityGpuBackend implements GravityBackend {
  readonly kind = 'gpu'
  readonly n: number
  /**
   * 直接求和的开销随 n 平方增长，所以引擎不能在一帧内批量执行很多步。
   * Direct summation is quadratic in n, so the engine must not batch many steps per frame.
   */
  readonly maxStepsPerFrame: number
  stepCount = 0
  centre: [number, number, number] = [0, 0, 0]
  /** 位置（xyz）和质量（w），供渲染器使用。 / Positions (xyz) and mass (w), for the renderer. */
  readonly pos: GPUBuffer

  private device: GPUDevice
  private p: Params
  private time = 0
  private chunks: number
  private buffers: GPUBuffer[] = []
  private pipelines = {} as Record<Entry, GPUComputePipeline>
  private groups = {} as Record<Entry, GPUBindGroup>
  private inFlight = 0
  private e0: number
  private disposed = false
  private timer: PassTimer

  constructor(gpu: GpuContext, p: Params, seed: number) {
    this.device = gpu.device
    this.timer = new PassTimer(gpu.device)
    this.p = { ...p }
    const init = initialState(p, seed, 1 << p.n!)
    this.n = init.n
    this.maxStepsPerFrame = this.n > 8192 ? 1 : this.n > 4096 ? 2 : 4
    this.chunks = Math.ceil(this.n / CHUNK)
    const sc = gravityScalars(init)
    this.e0 = sc.ke + sc.pe

    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    const sizes = [48, this.n * 16, this.n * 16, this.n * 16, this.chunks * 80, RADIAL_BINS * 4]
    this.buffers = sizes.map((size, i) =>
      this.device.createBuffer({ size, usage: i === 0 ? GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST : storage }),
    )
    this.pos = this.buffers[1]!
    const pos = new Float32Array(this.n * 4)
    const vel = new Float32Array(this.n * 4)
    const acc = new Float32Array(this.n * 4)
    for (let i = 0; i < this.n; i++) {
      for (let d = 0; d < 3; d++) {
        pos[4 * i + d] = init.pos[3 * i + d]!
        vel[4 * i + d] = init.vel[3 * i + d]!
        acc[4 * i + d] = init.acc[3 * i + d]!
      }
      pos[4 * i + 3] = init.mass[i]!
      acc[4 * i + 3] = init.phi[i]!
    }
    this.device.queue.writeBuffer(this.buffers[1]!, 0, pos)
    this.device.queue.writeBuffer(this.buffers[2]!, 0, vel)
    this.device.queue.writeBuffer(this.buffers[3]!, 0, acc)
    this.writeParams()

    const module = this.device.createShaderModule({ code })
    for (const entry of Object.keys(ENTRY_BINDINGS) as Entry[]) {
      this.pipelines[entry] = this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: entry } })
      this.groups[entry] = this.device.createBindGroup({
        layout: this.pipelines[entry].getBindGroupLayout(0),
        entries: ENTRY_BINDINGS[entry].map((binding) => ({ binding, resource: { buffer: this.buffers[binding]! } })),
      })
    }
  }

  private writeParams(): void {
    const data = new ArrayBuffer(48)
    new Uint32Array(data, 0, 4).set([this.n, CHUNK, RADIAL_BINS, 0])
    new Float32Array(data, 16, 8).set([this.p.dt!, this.p.eps! * this.p.eps!, RADIAL_MAX, 0, ...this.centre, 0])
    this.device.queue.writeBuffer(this.buffers[0]!, 0, data)
  }

  setParams(p: Params): void {
    this.p = { ...p }
    this.writeParams()
  }

  private dispatch(pass: GPUComputePassEncoder, entry: Entry, count: number, groupSize: number): void {
    pass.setPipeline(this.pipelines[entry])
    pass.setBindGroup(0, this.groups[entry])
    pass.dispatchWorkgroups(Math.ceil(count / groupSize))
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
      this.dispatch(pass, 'kickDrift', this.n, 256)
      this.dispatch(pass, 'accel', this.n, 64)
      this.dispatch(pass, 'kick', this.n, 256)
    }
    pass.end()
    this.timer.resolve(encoder)
    this.submit(encoder)
    this.timer.collect()
    this.stepCount += n
    this.time += n * this.p.dt!
  }

  async reduce(): Promise<GravityFrame> {
    const step = this.stepCount
    const time = this.time
    const partialBytes = this.chunks * 80
    const staging = this.device.createBuffer({
      size: partialBytes + RADIAL_BINS * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    this.dispatch(pass, 'clearHist', RADIAL_BINS, 256)
    this.dispatch(pass, 'radialHist', this.n, 256)
    this.dispatch(pass, 'reduceChunks', this.chunks, 64)
    pass.end()
    encoder.copyBufferToBuffer(this.buffers[4]!, 0, staging, 0, partialBytes)
    encoder.copyBufferToBuffer(this.buffers[5]!, 0, staging, partialBytes, RADIAL_BINS * 4)
    this.submit(encoder)
    await staging.mapAsync(GPUMapMode.READ)
    const raw = staging.getMappedRange()
    const partial = new Float32Array(raw, 0, this.chunks * 20)
    let ke = 0
    let pe = 0
    const p = [0, 0, 0]
    const b: BoundSums = { count: 0, mass: 0, ke: 0, mv: [0, 0, 0], ma: [0, 0, 0], mxa: 0 }
    let deepest = Infinity
    const centre: [number, number, number] = [0, 0, 0]
    for (let c = 0; c < this.chunks; c++) {
      const o = 20 * c
      ke += partial[o]!
      pe += partial[o + 1]!
      b.ke += partial[o + 2]!
      b.mxa += partial[o + 3]!
      b.count += partial[o + 7]!
      b.mass += partial[o + 11]!
      for (let d = 0; d < 3; d++) {
        p[d]! += partial[o + 4 + d]!
        b.mv[d]! += partial[o + 8 + d]!
        b.ma[d]! += partial[o + 12 + d]!
      }
      if (partial[o + 19]! < deepest) {
        deepest = partial[o + 19]!
        for (let d = 0; d < 3; d++) centre[d] = partial[o + 16 + d]!
      }
    }
    const radial = Float64Array.from(new Uint32Array(raw, partialBytes, RADIAL_BINS))
    staging.unmap()
    staging.destroy()
    // 本帧的壳层是绕上一个中心量度的；下一帧改用这个中心。
    // The shells of this frame were measured about the previous centre; the next uses this one.
    const measuredFrom = this.centre
    this.centre = centre
    this.writeParams()
    return {
      step,
      time,
      n: this.n,
      ke,
      pe,
      momentum: Math.hypot(...(p as [number, number, number])),
      boundFraction: b.count / this.n,
      virialBound: boundVirial(b, centre),
      centre: measuredFrom,
      drift: (ke + pe - this.e0) / Math.abs(this.e0),
      radial,
    }
  }

  /**
   * 完整回读加速度和引力势，仅供交叉校验工具使用。
   * Full readback of accelerations and potentials, for the cross-check harness only.
   */
  async readAccelerations(): Promise<Float32Array> {
    const bytes = this.n * 16
    const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const encoder = this.device.createCommandEncoder()
    encoder.copyBufferToBuffer(this.buffers[3]!, 0, staging, 0, bytes)
    this.device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const out = new Float32Array(staging.getMappedRange().slice(0))
    staging.destroy()
    return out
  }

  get gpuStepMs(): number | null {
    return this.timer.ms
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
