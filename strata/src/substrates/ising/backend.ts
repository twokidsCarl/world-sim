import type { Params } from '../../core/params'
import type { Frame, RunBackend } from '../../core/substrate'
import type { GpuContext } from '../../gpu/device'
import { PassTimer } from '../../gpu/timing'
import code from './ising.wgsl?raw'
import {
  binderCumulant,
  blockSpins,
  createIsing,
  latticeSums,
  pyramidLevels,
  sweep,
  thresholds,
  transitionCounts,
  LOCAL_STATES,
  type IsingState,
  type LatticeSums,
} from './ref'

export interface IsingLevel {
  size: number
  /** 每个自旋的磁化强度，带符号。 / Magnetisation per spin, signed. */
  m: number
  /** 最近邻乘积的平均值 ⟨s s'⟩。 / Mean nearest-neighbour product ⟨s s'⟩. */
  nn: number
  /** 对角近邻乘积的平均值。 / Mean diagonal-neighbour product. */
  nnn: number
}

export interface IsingFrame extends Frame {
  T: number
  /**
   * levels[0] 是被模拟的晶格；其后每一级都是前一级按 2×2 多数规则粗粒化的结果。
   * levels[0] is the simulated lattice; each next one is a 2×2 majority-rule coarsening.
   */
  levels: IsingLevel[]
  /**
   * 磁化强度的 Binder 累积量，取自参数上次改变以来的所有帧。
   * Binder cumulant of the magnetisation, from every frame since the parameters last changed.
   */
  binder: number
  /**
   * 各层局部状态在一次扫描前后的转移计数（每层 10 × 10），自参数上次改动起累计；只在被请求时给出。
   * 粗的层格点很少，单次扫描的计数不足以估计转移概率，所以必须累计。
   * Per-level counts of local-state transitions across one sweep (10 × 10 each), accumulated since
   * the parameters last changed; present only when requested. Coarse levels have few sites, and one
   * sweep's counts are too few to estimate transition probabilities, hence the accumulation.
   */
  transitions?: Float64Array[]
}

export interface IsingBackend extends RunBackend<IsingFrame> {
  readonly L: number
}

/**
 * 自上次参数改变以来已归约各帧的 m² 与 m⁴ 累加和。
 * Running sums of m² and m⁴ over the frames reduced since the last parameter change.
 */
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

/** 各层转移计数的累计 / Running totals of the per-level transition counts */
class Tally {
  private totals: Float64Array[] = []

  reset(): void {
    this.totals = []
  }

  add(counts: Float64Array[]): Float64Array[] {
    counts.forEach((c, k) => {
      const t = (this.totals[k] ??= new Float64Array(c.length))
      for (let i = 0; i < c.length; i++) t[i]! += c[i]!
    })
    return this.totals.map((t) => t.slice())
  }
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
  private moments = new Moments()
  private tally = new Tally()

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
    this.moments.reset()
    this.tally.reset()
  }

  step(n: number): void {
    sweep(this.state, this.thr, n)
  }

  /** 当前晶格及其各级粗粒化，最细的在前。 / The current lattice and its coarsenings, finest first. */
  pyramid(): Uint8Array[] {
    const out = [this.state.spins]
    let size = this.L
    for (let k = 1; k < pyramidLevels(this.L); k++) {
      out.push(blockSpins(out[k - 1]!, size, this.state.seed, k))
      size >>= 1
    }
    return out
  }

  reduce(ids: readonly string[] = []): IsingFrame {
    // 有效信息需要一次扫描前后的两个状态，所以这里会让模拟前进一次扫描。
    // Effective information needs the state before and after one sweep, so this advances
    // the simulation by one sweep.
    let transitions: Float64Array[] | undefined
    if (ids.includes('transitions')) {
      const before = this.pyramid().map((spins) => spins.slice())
      sweep(this.state, this.thr, 1)
      transitions = this.tally.add(this.pyramid().map((spins, k) => transitionCounts(before[k]!, spins, this.L >> k)))
    }
    const levels = this.pyramid().map((spins, k) => toLevel(this.L >> k, latticeSums(spins, this.L >> k)))
    return { step: this.stepCount, T: this.p.T, levels, binder: this.moments.add(levels[0]!.m), transitions }
  }

  dispose(): void {}
}

type Entry = 'metropolis' | 'bump' | 'block' | 'reduceRows' | 'clearTpm' | 'transitions'

export class IsingGpuBackend implements IsingBackend {
  readonly kind = 'gpu'
  readonly L: number
  readonly levels: number
  stepCount = 0
  /** 自旋缓冲区，最细的在前；渲染器读取它们。 / Spin buffers, finest first; the renderer reads these. */
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
  private prev: GPUBuffer[] = []
  private tpm: GPUBuffer[] = []
  private clearTpmGroups: GPUBindGroup[] = []
  private transitionGroups: GPUBindGroup[] = []
  private inFlight = 0
  private disposed = false
  private timer: PassTimer
  private moments = new Moments()
  private tally = new Tally()
  private epoch = 0

  constructor(gpu: GpuContext, p: Params, seed: number) {
    this.device = gpu.device
    this.timer = new PassTimer(gpu.device)
    this.p = { ...p }
    this.L = 1 << p.L
    this.levels = pyramidLevels(this.L)
    const device = this.device
    const module = device.createShaderModule({ code })
    for (const entry of ['metropolis', 'bump', 'block', 'reduceRows', 'clearTpm', 'transitions'] as Entry[]) {
      this.pipelines[entry] = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: entry } })
    }
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    const uniforms: GPUBuffer[] = []
    for (let k = 0; k < this.levels; k++) {
      const size = this.L >> k
      this.spins.push(device.createBuffer({ size: size * size * 4, usage: storage }))
      this.partial.push(device.createBuffer({ size: size * 16, usage: storage }))
      this.prev.push(device.createBuffer({ size: size * size * 4, usage: storage }))
      this.tpm.push(device.createBuffer({ size: LOCAL_STATES * LOCAL_STATES * 4, usage: storage }))
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
      this.clearTpmGroups.push(group('clearTpm', [[7, this.tpm[k]!]]))
      this.transitionGroups.push(
        group('transitions', [
          [0, uniforms[k]!],
          [1, this.spins[k]!],
          [6, this.prev[k]!],
          [7, this.tpm[k]!],
        ]),
      )
    }
    this.setParams(p)
  }

  setParams(p: Params): void {
    this.p = { ...p }
    this.device.queue.writeBuffer(this.thr, 0, thresholds(p.T, p.j2, p.h))
    this.moments.reset()
    this.tally.reset()
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
    this.encodeSweeps(pass, n)
    pass.end()
    this.timer.resolve(encoder)
    this.submit(encoder)
    this.timer.collect()
    this.stepCount += n
  }

  /** n 次扫描：每次四个子格 / n sweeps of four sublattice passes each */
  private encodeSweeps(pass: GPUComputePassEncoder, n: number): void {
    const groups = Math.ceil(this.L / 16)
    for (let i = 0; i < 4 * n; i++) {
      pass.setPipeline(this.pipelines.metropolis)
      pass.setBindGroup(0, this.metropolisGroup)
      pass.dispatchWorkgroups(groups, groups)
      pass.setPipeline(this.pipelines.bump)
      pass.setBindGroup(0, this.bumpGroup)
      pass.dispatchWorkgroups(1)
    }
  }

  get gpuStepMs(): number | null {
    return this.timer.ms
  }

  /**
   * 把各粗粒化层级更新到与被模拟的晶格一致。
   * Bring the coarse levels up to date with the simulated lattice.
   */
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

  async reduce(ids: readonly string[] = []): Promise<IsingFrame> {
    const wantTransitions = ids.includes('transitions')
    const T = this.p.T
    const epoch = this.epoch
    const encoder = this.device.createCommandEncoder()
    this.encodePyramid(encoder)
    if (wantTransitions) {
      // 留下各层扫描之前的样子，前进一次扫描，再把金字塔更新到新状态。
      // Keep every level as it was, advance one sweep, and bring the pyramid up to date again.
      for (let k = 0; k < this.levels; k++) {
        encoder.copyBufferToBuffer(this.spins[k]!, 0, this.prev[k]!, 0, (this.L >> k) ** 2 * 4)
      }
      const sweep = encoder.beginComputePass()
      this.encodeSweeps(sweep, 1)
      sweep.end()
      this.stepCount += 1
      this.encodePyramid(encoder)
      const count = encoder.beginComputePass()
      for (let k = 0; k < this.levels; k++) {
        count.setPipeline(this.pipelines.clearTpm)
        count.setBindGroup(0, this.clearTpmGroups[k]!)
        count.dispatchWorkgroups(2)
        count.setPipeline(this.pipelines.transitions)
        count.setBindGroup(0, this.transitionGroups[k]!)
        const groups = Math.ceil((this.L >> k) / 16)
        count.dispatchWorkgroups(groups, groups)
      }
      count.end()
    }
    const step = this.stepCount
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipelines.reduceRows)
    for (let k = 0; k < this.levels; k++) {
      pass.setBindGroup(0, this.reduceGroups[k]!)
      pass.dispatchWorkgroups(Math.ceil((this.L >> k) / 64))
    }
    pass.end()
    let bytes = 0
    for (let k = 0; k < this.levels; k++) bytes += (this.L >> k) * 16
    const tpmBytes = LOCAL_STATES * LOCAL_STATES * 4
    const staging = this.device.createBuffer({
      size: bytes + (wantTransitions ? this.levels * tpmBytes : 0),
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    let offset = 0
    for (let k = 0; k < this.levels; k++) {
      encoder.copyBufferToBuffer(this.partial[k]!, 0, staging, offset, (this.L >> k) * 16)
      offset += (this.L >> k) * 16
    }
    if (wantTransitions) {
      for (let k = 0; k < this.levels; k++) encoder.copyBufferToBuffer(this.tpm[k]!, 0, staging, bytes + k * tpmBytes, tpmBytes)
    }
    this.submit(encoder)
    await staging.mapAsync(GPUMapMode.READ)
    const mapped = staging.getMappedRange()
    const rows = new Int32Array(mapped, 0, bytes / 4)
    const fresh = wantTransitions
      ? Array.from({ length: this.levels }, (_, k) =>
          Float64Array.from(new Uint32Array(mapped, bytes + k * tpmBytes, LOCAL_STATES * LOCAL_STATES)),
        )
      : undefined
    const transitions = fresh && epoch === this.epoch ? this.tally.add(fresh) : fresh
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
    // 参数改变之前提交的帧不得计入新的平均。
    // A frame submitted before the parameters changed must not enter the new average.
    const binder = epoch === this.epoch ? this.moments.add(levels[0]!.m) : NaN
    return { step, T, levels, binder, transitions }
  }

  /**
   * 完整回读被模拟的晶格，仅供交叉校验工具使用。
   * Full readback of the simulated lattice, for the cross-check harness only.
   */
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
    for (const b of [...this.spins, ...this.partial, ...this.prev, ...this.tpm, this.thr]) b.destroy()
  }
}
