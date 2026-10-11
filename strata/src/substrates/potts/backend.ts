import type { Params } from '../../core/params'
import type { Frame, RunBackend } from '../../core/substrate'
import type { GpuContext } from '../../gpu/device'
import { PassTimer } from '../../gpu/timing'
import { pottsTc } from '../../theory/potts'
import type { LatticeSlice } from '../ising/backend'
import { binderCumulant, pyramidLevels } from '../ising/ref'
import code from './potts.wgsl?raw'
import {
  MAX_Q,
  blockStates,
  createPotts,
  latticeSums,
  orderParameter,
  sweep,
  thresholds,
  type PottsState,
  type PottsSums,
} from './ref'

export interface PottsLevel {
  size: number
  /** 序参量 (q ρ_max − 1) / (q − 1)。 / Order parameter (q ρ_max − 1) / (q − 1). */
  order: number
  /** 两端同态的最近邻键所占的比例。 / Fraction of nearest-neighbour bonds joining like states. */
  like: number
}

export interface PottsFrame extends Frame {
  T: number
  q: number
  /**
   * levels[0] 是被模拟的晶格；其后每一级都是前一级按 2×2 相对多数粗粒化的结果。
   * levels[0] is the simulated lattice; each next one is a 2×2 plurality coarsening.
   */
  levels: PottsLevel[]
  /** 被模拟的晶格上各状态所占的比例，长度 q。 / Fraction of sites in each state on the simulated lattice, length q. */
  fractions: number[]
  /**
   * 序参量的 Binder 累积量，取自参数上次改变以来的所有帧。
   * Binder cumulant of the order parameter, from every frame since the parameters last changed.
   */
  binder: number
}

export interface PottsBackend extends RunBackend<PottsFrame> {
  readonly L: number
  readonly q: number
}

/** 旋钮给的是 T / Tc(q)。 / The knob gives T / Tc(q). */
const temperature = (p: Params) => p.tau! * pottsTc(p.q!)

const toLevel = (size: number, q: number, sums: PottsSums): PottsLevel => ({
  size,
  order: orderParameter(sums.counts, q),
  like: sums.bonds / (2 * size * size),
})

const toFractions = (size: number, q: number, sums: PottsSums) => sums.counts.slice(0, q).map((c) => c / (size * size))

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

export class PottsCpuBackend implements PottsBackend {
  readonly kind = 'cpu'
  state: PottsState
  private thr: Uint32Array
  private p: Params
  private moments = new Moments()

  constructor(p: Params, seed: number) {
    this.p = { ...p }
    // CPU 上边长最多 256。 / At most 256 on a side on the CPU.
    this.state = createPotts(Math.min(1 << p.L!, 256), p.q!, seed, p.start === 1)
    this.thr = thresholds(temperature(p))
  }

  get L(): number {
    return this.state.L
  }

  get q(): number {
    return this.state.q
  }

  get stepCount(): number {
    return this.state.pass >> 1
  }

  setParams(p: Params): void {
    this.p = { ...p }
    this.thr = thresholds(temperature(p))
    this.moments.reset()
  }

  step(n: number): void {
    sweep(this.state, this.thr, n)
  }

  private pyramid(): Uint8Array[] {
    const out = [this.state.spins]
    let size = this.L
    for (let k = 1; k < pyramidLevels(this.L); k++) {
      out.push(blockStates(out[k - 1]!, size, this.state.seed, k))
      size >>= 1
    }
    return out
  }

  slices(): LatticeSlice[] {
    return this.pyramid().map((cells, k) => ({ size: this.L >> k, cells }))
  }

  reduce(): PottsFrame {
    const sums = this.pyramid().map((spins, k) => latticeSums(spins, this.L >> k))
    const levels = sums.map((s, k) => toLevel(this.L >> k, this.q, s))
    return {
      step: this.stepCount,
      T: temperature(this.p),
      q: this.q,
      levels,
      fractions: toFractions(this.L, this.q, sums[0]!),
      binder: this.moments.add(levels[0]!.order),
    }
  }

  dispose(): void {}
}

type Entry = 'metropolis' | 'bump' | 'block' | 'reduceRows'
const ROW_BYTES = 48

export class PottsGpuBackend implements PottsBackend {
  readonly kind = 'gpu'
  readonly L: number
  readonly q: number
  readonly levels: number
  readonly maxStepsPerFrame: number
  stepCount = 0
  /** 各层的状态缓冲，最细的在前。 / State buffers, finest first. */
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
    this.L = 1 << p.L!
    this.q = p.q!
    // 小晶格一帧可以多扫几次：临界点附近的弛豫要几万次扫描。
    // Small lattices can afford more sweeps per frame: relaxation near the transition takes tens of thousands.
    this.maxStepsPerFrame = this.L <= 256 ? 64 : 8
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
      this.partial.push(device.createBuffer({ size: size * ROW_BYTES, usage: storage }))
      const u = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      device.queue.writeBuffer(u, 0, new Uint32Array([size, seed >>> 0, k, this.q]))
      uniforms.push(u)
    }
    device.queue.writeBuffer(this.spins[0]!, 0, Uint32Array.from(createPotts(this.L, this.q, seed, p.start === 1).spins))
    this.thr = device.createBuffer({ size: 32, usage: storage })
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
    const table = new Uint32Array(8)
    table.set(thresholds(temperature(p)))
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
      pass.dispatchWorkgroups(g, g)
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
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8))
    }
    pass.end()
  }

  latticeViews(): { buffer: GPUBuffer; size: number }[] {
    return this.spins.map((buffer, k) => ({ buffer, size: this.L >> k }))
  }

  async reduce(): Promise<PottsFrame> {
    const step = this.stepCount
    const T = temperature(this.p)
    const epoch = this.epoch
    const encoder = this.device.createCommandEncoder()
    this.encodePyramid(encoder)
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipelines.reduceRows)
    for (let k = 0; k < this.levels; k++) {
      pass.setBindGroup(0, this.reduceGroups[k]!)
      pass.dispatchWorkgroups(Math.ceil((this.L >> k) / 16))
    }
    pass.end()
    let bytes = 0
    for (let k = 0; k < this.levels; k++) bytes += (this.L >> k) * ROW_BYTES
    const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    let offset = 0
    for (let k = 0; k < this.levels; k++) {
      encoder.copyBufferToBuffer(this.partial[k]!, 0, staging, offset, (this.L >> k) * ROW_BYTES)
      offset += (this.L >> k) * ROW_BYTES
    }
    this.submit(encoder)
    await staging.mapAsync(GPUMapMode.READ)
    const rows = new Uint32Array(staging.getMappedRange())
    const all: PottsSums[] = []
    let row = 0
    for (let k = 0; k < this.levels; k++) {
      const sums: PottsSums = { counts: new Array<number>(MAX_Q).fill(0), bonds: 0 }
      for (let y = 0; y < this.L >> k; y++, row++) {
        for (let s = 0; s < MAX_Q; s++) sums.counts[s]! += rows[12 * row + s]!
        sums.bonds += rows[12 * row + 8]!
      }
      all.push(sums)
    }
    staging.unmap()
    staging.destroy()
    const levels = all.map((s, k) => toLevel(this.L >> k, this.q, s))
    const binder = epoch === this.epoch ? this.moments.add(levels[0]!.order) : NaN
    return { step, T, q: this.q, levels, fractions: toFractions(this.L, this.q, all[0]!), binder }
  }

  /** 完整回读被模拟的晶格，仅供交叉校验工具使用。 / Full readback of the simulated lattice, for the cross-check harness only. */
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
