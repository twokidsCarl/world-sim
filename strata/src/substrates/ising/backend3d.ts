import type { Params } from '../../core/params'
import type { GpuContext } from '../../gpu/device'
import { PassTimer } from '../../gpu/timing'
import type { IsingBackend, IsingFrame, IsingLevel, LatticeSlice } from './backend'
import code from './ising3d.wgsl?raw'
import { binderCumulant } from './ref'
import {
  blockSpins3d,
  createIsing3d,
  latticeSums3d,
  pyramidLevels3d,
  sweep3d,
  thresholds3d,
  type Ising3dState,
} from './ref3d'

const toLevel = (size: number, sums: { s: number; nn: number }): IsingLevel => {
  const n = size ** 3
  return { size, m: sums.s / n, nn: sums.nn / (3 * n), nnn: 0 }
}

/** m² 与 m⁴ 的累计，参数改动时清零。 / Running sums of m² and m⁴, cleared when the parameters change. */
class Moments {
  private m2 = 0
  private m4 = 0
  private samples = 0

  reset(): void {
    this.m2 = this.m4 = this.samples = 0
  }

  add(m: number): number {
    this.m2 += m * m
    this.m4 += m ** 4
    this.samples++
    return binderCumulant(this.m2, this.m4, this.samples)
  }
}

export class Ising3dCpuBackend implements IsingBackend {
  readonly kind = 'cpu'
  readonly dim = 3
  state: Ising3dState
  private thr: Uint32Array
  private p: Params
  private moments = new Moments()

  constructor(p: Params, seed: number) {
    this.p = { ...p }
    // CPU 上边长最多 32（三万多个自旋）。 / At most 32 on a side on the CPU (some thirty thousand spins).
    this.state = createIsing3d(Math.min(1 << p.L3!, 32), seed)
    this.thr = thresholds3d(p.T!, p.h!)
  }

  get L(): number {
    return this.state.L
  }

  get stepCount(): number {
    return this.state.pass >> 1
  }

  setParams(p: Params): void {
    this.p = { ...p }
    this.thr = thresholds3d(p.T!, p.h!)
    this.moments.reset()
  }

  step(n: number): void {
    sweep3d(this.state, this.thr, n)
  }

  private pyramid(): Uint8Array[] {
    const out = [this.state.spins]
    let size = this.L
    for (let k = 1; k < pyramidLevels3d(this.L); k++) {
      out.push(blockSpins3d(out[k - 1]!, size, this.state.seed, k))
      size >>= 1
    }
    return out
  }

  /** 各层正中间的一个 z 截面。 / The middle z slice of each level. */
  slices(): LatticeSlice[] {
    return this.pyramid().map((spins, k) => {
      const size = this.L >> k
      const start = (size >> 1) * size * size
      return { size, cells: spins.subarray(start, start + size * size) }
    })
  }

  reduce(): IsingFrame {
    const levels = this.pyramid().map((spins, k) => toLevel(this.L >> k, latticeSums3d(spins, this.L >> k)))
    return { step: this.stepCount, T: this.p.T!, dim: 3, levels, binder: this.moments.add(levels[0]!.m) }
  }

  dispose(): void {}
}

type Entry = 'metropolis' | 'bump' | 'block' | 'reduceLayers'

export class Ising3dGpuBackend implements IsingBackend {
  readonly kind = 'gpu'
  readonly dim = 3
  readonly L: number
  readonly levels: number
  stepCount = 0
  /** 各层的自旋缓冲，最细的在前。 / Spin buffers, finest first. */
  readonly spins: GPUBuffer[] = []

  private device: GPUDevice
  private p: Params
  private pipelines = {} as Record<Entry, GPUComputePipeline>
  private partial: GPUBuffer[] = []
  private thr: GPUBuffer
  private metropolisGroup: GPUBindGroup
  private bumpGroup: GPUBindGroup
  private blockGroups: GPUBindGroup[] = []
  private reduceGroups: GPUBindGroup[] = []
  private inFlight = 0
  private disposed = false
  private timer: PassTimer
  private moments = new Moments()
  private epoch = 0

  constructor(gpu: GpuContext, p: Params, seed: number) {
    this.device = gpu.device
    this.timer = new PassTimer(gpu.device)
    this.p = { ...p }
    this.L = 1 << p.L3!
    this.levels = pyramidLevels3d(this.L)
    const device = this.device
    const module = device.createShaderModule({ code })
    for (const entry of ['metropolis', 'bump', 'block', 'reduceLayers'] as Entry[]) {
      this.pipelines[entry] = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: entry } })
    }
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    const uniforms: GPUBuffer[] = []
    for (let k = 0; k < this.levels; k++) {
      const size = this.L >> k
      this.spins.push(device.createBuffer({ size: size ** 3 * 4, usage: storage }))
      this.partial.push(device.createBuffer({ size: size * 16, usage: storage }))
      const u = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(u, 0, new Uint32Array([size, seed >>> 0, k, 0]))
      uniforms.push(u)
    }
    device.queue.writeBuffer(this.spins[0]!, 0, Uint32Array.from(createIsing3d(this.L, seed).spins))
    this.thr = device.createBuffer({ size: 64, usage: storage })
    const counter = device.createBuffer({ size: 16, usage: storage })
    const group = (entry: Entry, entries: [number, GPUBuffer][]) =>
      device.createBindGroup({
        layout: this.pipelines[entry].getBindGroupLayout(0),
        entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
      })
    this.metropolisGroup = group('metropolis', [
      [0, uniforms[0]!],
      [1, this.spins[0]!],
      [2, this.thr],
      [3, counter],
    ])
    this.bumpGroup = group('bump', [[3, counter]])
    for (let k = 0; k < this.levels; k++) {
      if (k > 0) {
        this.blockGroups.push(
          group('block', [
            [0, uniforms[k]!],
            [1, this.spins[k - 1]!],
            [4, this.spins[k]!],
          ]),
        )
      }
      this.reduceGroups.push(
        group('reduceLayers', [
          [0, uniforms[k]!],
          [1, this.spins[k]!],
          [5, this.partial[k]!],
        ]),
      )
    }
    this.setParams(p)
  }

  setParams(p: Params): void {
    this.p = { ...p }
    const table = new Uint32Array(16)
    table.set(thresholds3d(p.T!, p.h!))
    this.device.queue.writeBuffer(this.thr, 0, table)
    this.moments.reset()
    this.epoch++
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
    const g = Math.ceil(this.L / 8)
    for (let i = 0; i < 2 * n; i++) {
      pass.setPipeline(this.pipelines.metropolis)
      pass.setBindGroup(0, this.metropolisGroup)
      pass.dispatchWorkgroups(g, g, Math.ceil(this.L / 4))
      pass.setPipeline(this.pipelines.bump)
      pass.setBindGroup(0, this.bumpGroup)
      pass.dispatchWorkgroups(1)
    }
    pass.end()
    this.timer.resolve(encoder)
    this.submit(encoder)
    this.timer.collect()
    this.stepCount += n
  }

  get gpuStepMs(): number | null {
    return this.timer.ms
  }

  /** 把各粗粒化层级更新到与被模拟的晶格一致。 / Bring the coarse levels up to date with the simulated lattice. */
  encodePyramid(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipelines.block)
    for (let k = 1; k < this.levels; k++) {
      const size = this.L >> k
      pass.setBindGroup(0, this.blockGroups[k - 1]!)
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), Math.ceil(size / 4))
    }
    pass.end()
  }

  /** 各层正中间的 z 截面在缓冲里的位置。 / Where the middle z slice of each level sits in its buffer. */
  latticeViews(): { buffer: GPUBuffer; size: number; offset: number }[] {
    return this.spins.map((buffer, k) => {
      const size = this.L >> k
      return { buffer, size, offset: (size >> 1) * size * size }
    })
  }

  async reduce(): Promise<IsingFrame> {
    const step = this.stepCount
    const T = this.p.T!
    const epoch = this.epoch
    const encoder = this.device.createCommandEncoder()
    this.encodePyramid(encoder)
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipelines.reduceLayers)
    for (let k = 0; k < this.levels; k++) {
      pass.setBindGroup(0, this.reduceGroups[k]!)
      pass.dispatchWorkgroups(Math.ceil((this.L >> k) / 16))
    }
    pass.end()
    let bytes = 0
    for (let k = 0; k < this.levels; k++) bytes += (this.L >> k) * 16
    const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    let offset = 0
    for (let k = 0; k < this.levels; k++) {
      encoder.copyBufferToBuffer(this.partial[k]!, 0, staging, offset, (this.L >> k) * 16)
      offset += (this.L >> k) * 16
    }
    this.submit(encoder)
    await staging.mapAsync(GPUMapMode.READ)
    const rows = new Int32Array(staging.getMappedRange())
    const levels: IsingLevel[] = []
    let row = 0
    for (let k = 0; k < this.levels; k++) {
      const size = this.L >> k
      const sums = { s: 0, nn: 0 }
      for (let z = 0; z < size; z++, row++) {
        sums.s += rows[4 * row]!
        sums.nn += rows[4 * row + 1]!
      }
      levels.push(toLevel(size, sums))
    }
    staging.unmap()
    staging.destroy()
    const binder = epoch === this.epoch ? this.moments.add(levels[0]!.m) : NaN
    return { step, T, dim: 3, levels, binder }
  }

  /** 完整回读被模拟的晶格，仅供交叉校验工具使用。 / Full readback of the simulated lattice, for the cross-check harness only. */
  async readSpins(): Promise<Uint32Array> {
    const bytes = this.L ** 3 * 4
    const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const encoder = this.device.createCommandEncoder()
    encoder.copyBufferToBuffer(this.spins[0]!, 0, staging, 0, bytes)
    this.device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const out = new Uint32Array(staging.getMappedRange().slice(0))
    staging.destroy()
    return out
  }

  idle(): Promise<void> {
    return this.device.queue.onSubmittedWorkDone()
  }

  dispose(): void {
    this.disposed = true
    this.timer.destroy()
    for (const b of [...this.spins, ...this.partial, this.thr]) b.destroy()
  }
}
