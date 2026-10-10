import type { Params } from '../../core/params'
import type { Frame, RunBackend } from '../../core/substrate'
import type { GpuContext } from '../../gpu/device'
import { PassTimer } from '../../gpu/timing'
import code from './ising.wgsl?raw'
import {
  blockSpins,
  createIsing,
  latticeSums,
  pyramidLevels,
  sweep,
  thresholds,
  type IsingState,
  type LatticeSums,
} from './ref'

export interface IsingLevel {
  size: number
  /** Magnetisation per spin, signed. */
  m: number
  /** Mean nearest-neighbour product ⟨s s'⟩. */
  nn: number
  /** Mean diagonal-neighbour product. */
  nnn: number
}

export interface IsingFrame extends Frame {
  T: number
  /** levels[0] is the simulated lattice; each next one is a 2×2 majority-rule coarsening. */
  levels: IsingLevel[]
}

export interface IsingBackend extends RunBackend<IsingFrame> {
  readonly L: number
}

function toLevel(size: number, sums: LatticeSums): IsingLevel {
  const n = size * size
  return { size, m: sums.s / n, nn: sums.nn / (2 * n), nnn: sums.nnn / (2 * n) }
}

export class IsingCpuBackend implements IsingBackend {
  readonly kind = 'cpu'
  state: IsingState
  private thr: Uint32Array
  private p: Params

  constructor(p: Params, seed: number) {
    this.p = { ...p }
    this.state = createIsing(1 << p.L, seed)
    this.thr = thresholds(p.T, p.j2, p.h)
  }

  get L(): number {
    return this.state.L
  }

  get stepCount(): number {
    return this.state.pass >> 2
  }

  setParams(p: Params): void {
    this.p = { ...p }
    this.thr = thresholds(p.T, p.j2, p.h)
  }

  step(n: number): void {
    sweep(this.state, this.thr, n)
  }

  /** The current lattice and its coarsenings, finest first. */
  pyramid(): Uint8Array[] {
    const out = [this.state.spins]
    let size = this.L
    for (let k = 1; k < pyramidLevels(this.L); k++) {
      out.push(blockSpins(out[k - 1]!, size, this.state.seed, k))
      size >>= 1
    }
    return out
  }

  reduce(): IsingFrame {
    const levels = this.pyramid().map((spins, k) => toLevel(this.L >> k, latticeSums(spins, this.L >> k)))
    return { step: this.stepCount, T: this.p.T, levels }
  }

  dispose(): void {}
}

type Entry = 'metropolis' | 'bump' | 'block' | 'reduceRows'

export class IsingGpuBackend implements IsingBackend {
  readonly kind = 'gpu'
  readonly L: number
  readonly levels: number
  stepCount = 0
  /** Spin buffers, finest first; the renderer reads these. */
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

  constructor(gpu: GpuContext, p: Params, seed: number) {
    this.device = gpu.device
    this.timer = new PassTimer(gpu.device)
    this.p = { ...p }
    this.L = 1 << p.L
    this.levels = pyramidLevels(this.L)
    const device = this.device
    const module = device.createShaderModule({ code })
    for (const entry of ['metropolis', 'bump', 'block', 'reduceRows'] as Entry[]) {
      this.pipelines[entry] = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: entry } })
    }
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    const uniforms: GPUBuffer[] = []
    for (let k = 0; k < this.levels; k++) {
      const size = this.L >> k
      this.spins.push(device.createBuffer({ size: size * size * 4, usage: storage }))
      this.partial.push(device.createBuffer({ size: size * 16, usage: storage }))
      const u = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(u, 0, new Uint32Array([size, seed >>> 0, k, 0]))
      uniforms.push(u)
    }
    device.queue.writeBuffer(this.spins[0]!, 0, Uint32Array.from(createIsing(this.L, seed).spins))
    this.thr = device.createBuffer({ size: 200, usage: storage })
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
        group('reduceRows', [
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
    this.device.queue.writeBuffer(this.thr, 0, thresholds(p.T, p.j2, p.h))
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
    const groups = Math.ceil(this.L / 16)
    for (let i = 0; i < 4 * n; i++) {
      pass.setPipeline(this.pipelines.metropolis)
      pass.setBindGroup(0, this.metropolisGroup)
      pass.dispatchWorkgroups(groups, groups)
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

  /** Bring the coarse levels up to date with the simulated lattice. */
  encodePyramid(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipelines.block)
    for (let k = 1; k < this.levels; k++) {
      const groups = Math.ceil((this.L >> k) / 16)
      pass.setBindGroup(0, this.blockGroups[k - 1]!)
      pass.dispatchWorkgroups(groups, groups)
    }
    pass.end()
  }

  async reduce(): Promise<IsingFrame> {
    const step = this.stepCount
    const T = this.p.T
    const encoder = this.device.createCommandEncoder()
    this.encodePyramid(encoder)
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipelines.reduceRows)
    for (let k = 0; k < this.levels; k++) {
      pass.setBindGroup(0, this.reduceGroups[k]!)
      pass.dispatchWorkgroups(Math.ceil((this.L >> k) / 64))
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
      const sums = { s: 0, nn: 0, nnn: 0 }
      for (let y = 0; y < size; y++, row++) {
        sums.s += rows[4 * row]!
        sums.nn += rows[4 * row + 1]!
        sums.nnn += rows[4 * row + 2]!
      }
      levels.push(toLevel(size, sums))
    }
    staging.unmap()
    staging.destroy()
    return { step, T, levels }
  }

  /** Full readback of the simulated lattice, for the cross-check harness only. */
  async readSpins(): Promise<Uint32Array> {
    const bytes = this.L * this.L * 4
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
