import type { Params } from '../../core/params'
import type { GpuContext } from '../../gpu/device'
import { PassTimer } from '../../gpu/timing'
import type { MdBackend, MdFrame } from './backend-cpu'
import code from './gpu/md.wgsl?raw'
import { speciesField, speciesTables, type PairTable, type PotentialSpec } from './potential'
import { initFcc, initTriangular } from './ref/init'
import {
  FIELD_G,
  MODE_COUNT,
  demixing,
  modeStride,
  rdfNormalise,
  type FieldSums,
  type Hist,
} from './ref/reducers'
import { boxAspect, fccCells, fieldKey, potentialSpec, strengthMatrix } from './schema'

const CHUNK = 256
const TABLE_K = 2048
const SPEED_BINS = 64
const RDF_BINS = 120
const RDF_OFFSET = 64
const MAX_CELL_SLOT = 192
const HIST_WORDS = 196
const THERMOSTAT_TAU = 0.5
const PARAM_BYTES = 112
const MODE_SLOTS = 2 + 4 * MODE_COUNT
const FIELD_WORDS = FIELD_G * FIELD_G * 5
const FIELD_V = 1024
const FIELD_V2 = 256
/**
 * 确定元胞容量时所依据的密堆积数密度，按单位元胞体积计。
 * Close-packed number density the cell capacity is sized for, per unit cell volume.
 */
const PACKING_DENSITY = 1.6

/**
 * 各入口点使用的绑定；自动布局恰好只包含这些。
 * Bindings each entry point uses; auto layouts contain exactly these.
 */
const ENTRY_BINDINGS = {
  kickDrift: [0, 1, 2, 3],
  kick: [0, 2, 3],
  clearCells: [0, 5],
  fillCells: [0, 1, 5, 6, 9],
  forces: [0, 1, 3, 4, 5, 6, 7],
  reduceChunks: [0, 2, 3, 4, 8],
  rescale: [0, 2, 10],
  clearHeat: [0, 10],
  clearHist: [9],
  speedHist: [0, 2, 9],
  rdfHist: [0, 1, 5, 6, 9],
  clearField: [11],
  fieldBin: [0, 1, 2, 11],
  densityModes: [0, 1, 12],
  mergeModes: [0, 12, 13],
  soundKick: [0, 1, 2],
} as const

type Entry = keyof typeof ENTRY_BINDINGS

export class MdGpuBackend implements MdBackend {
  readonly kind = 'gpu'
  readonly n: number
  readonly dim: 2 | 3
  readonly box: Float64Array
  stepCount = 0
  spec: PotentialSpec
  /** 粒子位置，供渲染器使用。 / Particle positions, for the renderer. */
  readonly pos: GPUBuffer
  /** 每粒子：位力份额、Re ψ6、Im ψ6、近邻数。 / Per particle: virial share, Re ψ6, Im ψ6, neighbour count. */
  readonly aux: GPUBuffer

  private device: GPUDevice
  private p: Params
  private time = 0
  private chunks: number
  private table!: PairTable
  private key: string
  private fractionB = 0
  private cells = 0
  private nc: [number, number, number] = [1, 1, 1]
  private cap = 0
  private rdfMax = 0
  private rdfReach = 1
  private buffers: Record<number, GPUBuffer> = {}
  private pipelines = {} as Record<Entry, GPUComputePipeline>
  private groups = {} as Record<Entry, GPUBindGroup>
  private inFlight = 0
  private reducing = 0
  private lastReduceStep = 0
  private lastT: number
  private lambda = 1
  private pendingKick: number | null = null
  private pendingReverse = false
  private pendingPerturb: number | null = null
  private heat = 0
  private e0 = 0
  private rebaseEpoch = 1
  private rebasedAt = 0
  private disposed = false
  private timer: PassTimer
  private seed = 0
  private batch = 0

  constructor(gpu: GpuContext, p: Params, seed: number) {
    this.device = gpu.device
    this.timer = new PassTimer(gpu.device)
    this.p = { ...p }
    this.lastT = p.temperature
    this.spec = potentialSpec(p)
    this.key = fieldKey(p)
    const field = speciesField(speciesTables(this.spec, strengthMatrix(p), TABLE_K))
    this.dim = p.dim === 3 ? 3 : 2
    const init =
      this.dim === 3
        ? initFcc(
            { cells: fccCells(p.nx!), density: p.density!, temperature: p.temperature!, seed, fractionB: p.fractionB },
            field,
          )
        : initTriangular(
            {
              nx: p.nx,
              density: p.density,
              temperature: p.temperature,
              seed,
              fractionB: p.fractionB,
              aspect: boxAspect(p),
              stripe: p.layoutB === 1,
            },
            field,
          )
    this.n = init.n
    this.box = init.box
    this.chunks = Math.ceil(this.n / CHUNK)

    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    const make = (binding: number, bytes: number, usage = storage) =>
      (this.buffers[binding] = this.device.createBuffer({ size: Math.max(16, bytes), usage }))
    make(0, PARAM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
    this.pos = make(1, this.n * 16)
    make(2, this.n * 16)
    make(3, this.n * 16)
    this.aux = make(4, this.n * 16)
    make(7, 4 * (TABLE_K + 1) * 8)
    make(8, this.chunks * 48)
    make(9, HIST_WORDS * 4)
    make(10, this.chunks * 4)
    make(11, FIELD_WORDS * 4)
    make(12, this.chunks * MODE_SLOTS * 4)
    make(13, MODE_SLOTS * 4)
    this.seed = seed

    const pos = new Float32Array(this.n * 4)
    const vel = new Float32Array(this.n * 4)
    for (let i = 0; i < this.n; i++) {
      for (let d = 0; d < this.dim; d++) {
        pos[4 * i + d] = init.pos[this.dim * i + d]
        vel[4 * i + d] = init.vel[this.dim * i + d]
      }
      pos[4 * i + 3] = init.species[i]
      this.fractionB += init.species[i] / this.n
    }
    this.device.queue.writeBuffer(this.buffers[1]!, 0, pos)
    this.device.queue.writeBuffer(this.buffers[2]!, 0, vel)

    const module = this.device.createShaderModule({ code })
    for (const entry of Object.keys(ENTRY_BINDINGS) as Entry[]) {
      this.pipelines[entry] = this.device.createComputePipeline({
        layout: 'auto',
        compute: { module, entryPoint: entry },
      })
    }
    this.uploadTable()
    this.configureGrid()
    this.recomputeForces()
  }

  /**
   * 为每个有序组分对上传一张表；单组分体系则重复使用它唯一的那张表。
   * Upload one table per ordered species pair; a one-component system repeats its only table.
   */
  private uploadTable(): void {
    const strength = strengthMatrix(this.p)
    const tables = speciesTables(this.spec, strength, TABLE_K)
    this.table = tables[0]![0]!
    const stride = (TABLE_K + 1) * 2
    const data = new Float32Array(4 * stride)
    for (let si = 0; si < 2; si++) {
      for (let sj = 0; sj < 2; sj++) {
        const t = tables[si]?.[sj] ?? this.table
        for (let i = 0; i <= TABLE_K; i++) {
          data[(si * 2 + sj) * stride + 2 * i] = t.g[i]
          data[(si * 2 + sj) * stride + 2 * i + 1] = t.u[i]
        }
      }
    }
    this.device.queue.writeBuffer(this.buffers[7]!, 0, data)
  }

  /**
   * 按当前截断半径确定元胞网格的尺寸，并重建引用它的绑定组。
   * Size the cell grid for the current cutoff and rebuild the bind groups that reference it.
   */
  private configureGrid(): void {
    const rc = this.spec.rc
    let cellVolume = 1
    for (let d = 0; d < this.dim; d++) {
      this.nc[d] = Math.max(3, Math.floor(this.box[d] / rc))
      cellVolume *= this.box[d] / this.nc[d]!
    }
    for (let d = 0; d < this.dim; d++) {
      if (this.box[d]! / this.nc[d]! < rc) throw new Error('box is smaller than three cutoff radii; use the CPU backend')
    }
    this.cells = this.nc[0] * this.nc[1] * this.nc[2]
    this.cap = Math.ceil(PACKING_DENSITY * cellVolume) + 4

    // g(r) 的范围取到模板所允许的最远处，以不绕回到自身为限。
    // g(r) reaches as far as the stencil allows without wrapping onto itself.
    let cellSize = Infinity
    let fewest = Infinity
    for (let d = 0; d < this.dim; d++) {
      cellSize = Math.min(cellSize, this.box[d]! / this.nc[d]!)
      fewest = Math.min(fewest, this.nc[d]!)
    }
    const maxReach = Math.floor((fewest - 1) / 2)
    // 三维下更宽的模板意味着每个粒子要访问 125 个元胞，所以 g(r) 只取到一个元胞的距离。
    // In 3D a wider stencil would visit 125 cells per particle, so g(r) stops at one cell.
    this.rdfReach = this.dim === 3 ? 1 : Math.min(maxReach, Math.ceil(4 / cellSize))
    this.rdfMax = Math.min(4, this.rdfReach * cellSize)

    this.buffers[5]?.destroy()
    this.buffers[6]?.destroy()
    const usage = GPUBufferUsage.STORAGE
    this.buffers[5] = this.device.createBuffer({ size: this.cells * 4, usage })
    this.buffers[6] = this.device.createBuffer({ size: this.cells * this.cap * 4, usage })
    for (const entry of Object.keys(ENTRY_BINDINGS) as Entry[]) {
      this.groups[entry] = this.device.createBindGroup({
        layout: this.pipelines[entry].getBindGroupLayout(0),
        entries: ENTRY_BINDINGS[entry].map((binding) => ({ binding, resource: { buffer: this.buffers[binding]! } })),
      })
    }
  }

  private writeParams(vmax: number): void {
    const data = new ArrayBuffer(PARAM_BYTES)
    const f = new Float32Array(data)
    const u = new Uint32Array(data)
    const t = this.table
    f.set([this.box[0], this.box[1], this.box[2], 0], 0)
    u.set([this.nc[0], this.nc[1], this.nc[2], this.cap], 4)
    u.set([this.n, this.dim, TABLE_K, CHUNK], 8)
    f.set([this.p.dt, t.rc2, t.r2min, t.k / (t.rc2 - t.r2min)], 12)
    f.set([vmax, this.rdfMax, this.lambda, this.rdfReach], 16)
    u.set([modeStride(this.box[0]!), modeStride(this.box[1]!), 0, 0], 24)
    const walls = this.p.walls === 1 && this.dim === 2
    f.set([walls ? this.p.drive! : 0, this.p.temperature!], 20)
    u.set([walls ? 1 : 0, (this.seed ^ Math.imul(++this.batch, 0x632be5ab)) >>> 0], 22)
    this.device.queue.writeBuffer(this.buffers[0]!, 0, data)
  }

  private dispatch(pass: GPUComputePassEncoder, entry: Entry, count: number, groupSize = 256): void {
    pass.setPipeline(this.pipelines[entry])
    pass.setBindGroup(0, this.groups[entry])
    pass.dispatchWorkgroups(Math.ceil(count / groupSize))
  }

  private encodeForces(pass: GPUComputePassEncoder): void {
    this.dispatch(pass, 'clearCells', this.cells)
    this.dispatch(pass, 'fillCells', this.n)
    this.dispatch(pass, 'forces', this.n)
  }

  private submit(encoder: GPUCommandEncoder): void {
    this.device.queue.submit([encoder.finish()])
    this.inFlight++
    void this.device.queue.onSubmittedWorkDone().then(() => this.inFlight--)
  }

  private recomputeForces(): void {
    this.writeParams(4 * Math.sqrt(this.lastT))
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    this.encodeForces(pass)
    pass.end()
    this.submit(encoder)
    this.rebaseEpoch++
  }

  setParams(p: Params): void {
    const spec = potentialSpec(p)
    const tableChanged = fieldKey(p) !== this.key
    if (!p.thermostat && p.temperature !== this.p.temperature) this.pendingKick = p.temperature
    this.p = { ...p }
    if (tableChanged) {
      const gridChanged = spec.rc !== this.spec.rc
      this.key = fieldKey(p)
      this.spec = spec
      this.uploadTable()
      if (gridChanged) this.configureGrid()
      this.recomputeForces()
    }
  }

  step(n: number): void {
    // 宁可丢弃这一帧，也不让任务排队的速度超过 GPU 完成的速度。
    // Drop the frame rather than queue work faster than the GPU completes it.
    if (this.inFlight >= 2 || this.disposed) return
    const { dt, thermostat, temperature: target } = this.p
    let rescale = false
    let soundKick = false
    if (this.pendingPerturb !== null) {
      // 内核从重标因子所用的同一个 uniform 槽位读取振幅。
      // The kernel reads its amplitude from the same uniform slot as the rescale factor.
      this.lambda = this.pendingPerturb
      this.pendingPerturb = null
      this.rebaseEpoch++
      soundKick = true
    } else if (this.pendingReverse) {
      // 把所有速度乘以 -1 即反转时间；这不增加动能。
      // Scaling every velocity by -1 reverses time; it adds no kinetic energy.
      this.pendingReverse = false
      this.lambda = -1
      rescale = true
    } else if (this.pendingKick !== null) {
      this.lambda = Math.sqrt(this.pendingKick / Math.max(this.lastT, 1e-9))
      this.lastT = this.pendingKick
      this.pendingKick = null
      this.rebaseEpoch++
      rescale = true
    } else if (thermostat) {
      // 对这一批步做 Berendsen 弱耦合，依据最近一次回读的温度。
      // Berendsen weak coupling over this batch, from the last temperature read back.
      const lambda2 = 1 + ((n * dt) / THERMOSTAT_TAU) * (target / Math.max(this.lastT, 1e-9) - 1)
      this.lambda = Math.sqrt(Math.min(Math.max(lambda2, 0.5), 2))
      rescale = true
    }
    this.writeParams(4 * Math.sqrt(this.lastT))
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass(this.timer.descriptor())
    if (rescale) this.dispatch(pass, 'rescale', this.chunks, 64)
    if (soundKick) this.dispatch(pass, 'soundKick', this.n)
    for (let i = 0; i < n; i++) {
      this.dispatch(pass, 'kickDrift', this.n)
      this.encodeForces(pass)
      this.dispatch(pass, 'kick', this.n)
    }
    pass.end()
    this.timer.resolve(encoder)
    this.submit(encoder)
    this.timer.collect()
    this.stepCount += n
    this.time += n * dt
    // 即使没有视图订阅，恒温器也需要当前的温度。
    // The thermostat needs a current temperature even when no view is subscribed.
    if (thermostat && this.reducing === 0 && this.stepCount - this.lastReduceStep >= 48) void this.reduce([])
  }

  /**
   * 沿 x 方向激发一个驻声波，速度振幅为给定值。
   * Launch a standing sound wave along x with the given velocity amplitude.
   */
  perturb(amplitude: number): void {
    this.pendingPerturb = amplitude
  }

  /**
   * 通过速度取反来反转时间；由于 f32 舍入，返回的路径只是近似的。
   * Reverse time by negating velocities; f32 rounding means the path back is only approximate.
   */
  reverse(): void {
    this.pendingReverse = true
  }

  async reduce(ids: readonly string[]): Promise<MdFrame> {
    const step = this.stepCount
    const time = this.time
    const spec = this.spec
    const epoch = this.rebaseEpoch
    const vmax = 4 * Math.sqrt(this.lastT)
    const rdfMax = this.rdfMax
    const wantSpeed = ids.includes('speedHist')
    const wantRdf = ids.includes('rdf')
    const wantField = ids.includes('field')
    const wantModes = ids.includes('modes')
    this.lastReduceStep = step
    this.reducing++

    const partialBytes = this.chunks * 48
    const histBytes = HIST_WORDS * 4
    const heatBytes = this.chunks * 4
    const fieldBytes = wantField ? FIELD_WORDS * 4 : 0
    const modeBytes = wantModes ? MODE_SLOTS * 4 : 0
    const staging = this.device.createBuffer({
      size: partialBytes + histBytes + heatBytes + fieldBytes + modeBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    this.writeParams(vmax)
    const encoder = this.device.createCommandEncoder()
    let pass = encoder.beginComputePass()
    if (wantSpeed) this.dispatch(pass, 'speedHist', this.n)
    if (wantRdf) this.dispatch(pass, 'rdfHist', this.n)
    if (wantField) {
      this.dispatch(pass, 'clearField', FIELD_WORDS)
      this.dispatch(pass, 'fieldBin', this.n)
    }
    if (wantModes) {
      this.dispatch(pass, 'densityModes', this.chunks, 64)
      this.dispatch(pass, 'mergeModes', MODE_SLOTS, 64)
    }
    this.dispatch(pass, 'reduceChunks', this.chunks, 64)
    pass.end()
    encoder.copyBufferToBuffer(this.buffers[8]!, 0, staging, 0, partialBytes)
    encoder.copyBufferToBuffer(this.buffers[9]!, 0, staging, partialBytes, histBytes)
    encoder.copyBufferToBuffer(this.buffers[10]!, 0, staging, partialBytes + histBytes, heatBytes)
    if (wantField) {
      encoder.copyBufferToBuffer(this.buffers[11]!, 0, staging, partialBytes + histBytes + heatBytes, fieldBytes)
    }
    if (wantModes) {
      encoder.copyBufferToBuffer(this.buffers[13]!, 0, staging, partialBytes + histBytes + heatBytes + fieldBytes, modeBytes)
    }
    pass = encoder.beginComputePass()
    this.dispatch(pass, 'clearHist', HIST_WORDS)
    this.dispatch(pass, 'clearHeat', this.chunks, 64)
    pass.end()
    this.submit(encoder)

    try {
      await staging.mapAsync(GPUMapMode.READ)
    } finally {
      this.reducing--
    }
    const raw = staging.getMappedRange()
    const partial = new Float32Array(raw, 0, this.chunks * 12)
    const hist = new Uint32Array(raw, partialBytes, HIST_WORDS)
    const heatPartial = new Float32Array(raw, partialBytes + histBytes, this.chunks)

    // 各块的和是 f32；总和用 f64 累加。 / Chunk sums are f32; the totals are accumulated in f64.
    let ke = 0
    let pe = 0
    let virial = 0
    let px = 0
    let py = 0
    let pz = 0
    let heat = 0
    let psiRe = 0
    let psiIm = 0
    let psiAbs = 0
    let bonds = 0
    let unlike = 0
    let neighbours = 0
    for (let c = 0; c < this.chunks; c++) {
      bonds += partial[12 * c + 3]!
      unlike += partial[12 * c + 11]!
      neighbours += partial[12 * c + 7]!
      ke += partial[12 * c]!
      pe += partial[12 * c + 1]!
      virial += partial[12 * c + 2]!
      px += partial[12 * c + 4]!
      py += partial[12 * c + 5]!
      pz += partial[12 * c + 6]!
      psiRe += partial[12 * c + 8]!
      psiIm += partial[12 * c + 9]!
      psiAbs += partial[12 * c + 10]!
      heat += heatPartial[c]!
    }
    const n = this.n
    const volume = this.box[0] * this.box[1] * this.box[2]
    const temperature = (2 * ke) / (this.dim * (n - 1))
    if (epoch > this.rebasedAt) {
      this.rebasedAt = epoch
      this.heat = 0
      this.e0 = ke + pe
    } else {
      this.heat += heat
    }
    if (epoch === this.rebaseEpoch) this.lastT = temperature

    const frame: MdFrame = {
      step,
      time,
      spec,
      box: this.box,
      drift: (ke + pe - this.heat - this.e0) / n,
      overflow: hist[MAX_CELL_SLOT]! > this.cap,
      scalars: {
        n,
        dim: this.dim,
        ke,
        pe,
        density: n / volume,
        temperature,
        pressure: (n * temperature + virial / this.dim) / volume,
        momentum: Math.hypot(px, py, pz) / n,
        psi6Local: psiAbs / n,
        psi6Global: Math.hypot(psiRe, psiIm) / n,
        coordination: neighbours / n,
        fractionB: this.fractionB,
        demix: demixing(this.fractionB, { total: bonds, unlike }),
      },
    }
    if (wantSpeed) frame.speedHist = speedDensity(hist, n, vmax)
    if (wantField) frame.field = fieldFromFixed(new Int32Array(raw, partialBytes + histBytes + heatBytes, FIELD_WORDS))
    if (wantModes) {
      frame.modes = {
        data: Float64Array.from(new Float32Array(raw, partialBytes + histBytes + heatBytes + fieldBytes, MODE_SLOTS)),
        strideX: modeStride(this.box[0]!),
        strideY: modeStride(this.box[1]!),
      }
    }
    if (wantRdf) {
      const counts = Float64Array.from(hist.subarray(RDF_OFFSET, RDF_OFFSET + RDF_BINS))
      frame.rdf = rdfNormalise(counts, rdfMax, n, volume, this.dim)
    }
    staging.unmap()
    staging.destroy()
    return frame
  }

  /** 完整回读状态，仅供交叉校验工具使用。 / Full state readback, for the cross-check harness only. */
  async readState(): Promise<{ pos: Float32Array; vel: Float32Array; force: Float32Array; aux: Float32Array }> {
    const bytes = this.n * 16
    const staging = this.device.createBuffer({ size: 4 * bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const encoder = this.device.createCommandEncoder()
    for (let b = 0; b < 4; b++) encoder.copyBufferToBuffer(this.buffers[b + 1]!, 0, staging, b * bytes, bytes)
    this.device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const all = new Float32Array(staging.getMappedRange().slice(0))
    staging.destroy()
    return {
      pos: all.subarray(0, this.n * 4),
      vel: all.subarray(this.n * 4, this.n * 8),
      force: all.subarray(this.n * 8, this.n * 12),
      aux: all.subarray(this.n * 12, this.n * 16),
    }
  }

  /**
   * 覆盖位置和速度（n * dim，f64）并重新计算受力。仅供校验工具使用。
   * Overwrite positions and velocities (n * dim, f64) and recompute forces. Harness only.
   */
  writeState(pos: Float64Array, vel: Float64Array, species?: Uint8Array): void {
    const p = new Float32Array(this.n * 4)
    const v = new Float32Array(this.n * 4)
    for (let i = 0; i < this.n; i++) {
      for (let d = 0; d < this.dim; d++) {
        p[4 * i + d] = pos[i * this.dim + d]!
        v[4 * i + d] = vel[i * this.dim + d]!
      }
      p[4 * i + 3] = species?.[i] ?? 0
    }
    this.device.queue.writeBuffer(this.buffers[1]!, 0, p)
    this.device.queue.writeBuffer(this.buffers[2]!, 0, v)
    this.recomputeForces()
  }

  get gpuStepMs(): number | null {
    return this.timer.ms
  }

  /** 在所有已提交的任务完成后 resolve。 / Resolves once all submitted work has finished. */
  idle(): Promise<void> {
    return this.device.queue.onSubmittedWorkDone()
  }

  dispose(): void {
    this.disposed = true
    this.timer.destroy()
    for (const b of Object.values(this.buffers)) b.destroy()
  }
}

function speedDensity(hist: Uint32Array, n: number, vmax: number): Hist {
  const w = vmax / SPEED_BINS
  const x = new Float64Array(SPEED_BINS)
  const y = new Float64Array(SPEED_BINS)
  for (let b = 0; b < SPEED_BINS; b++) {
    x[b] = (b + 0.5) * w
    y[b] = hist[b]! / (n * w)
  }
  return { x, y }
}

/**
 * 解码 fieldBin 内核写入的定点 i32 单元求和。
 * Decode the fixed-point i32 cell sums written by the fieldBin kernel.
 */
function fieldFromFixed(words: Int32Array): FieldSums {
  const cells = FIELD_G * FIELD_G
  const out: FieldSums = {
    g: FIELD_G,
    count: new Float64Array(cells),
    vx: new Float64Array(cells),
    vy: new Float64Array(cells),
    v2: new Float64Array(cells),
    countB: new Float64Array(cells),
  }
  for (let c = 0; c < cells; c++) {
    out.count[c] = words[5 * c]!
    out.vx[c] = words[5 * c + 1]! / FIELD_V
    out.vy[c] = words[5 * c + 2]! / FIELD_V
    out.v2[c] = words[5 * c + 3]! / FIELD_V2
    out.countB[c] = words[5 * c + 4]!
  }
  return out
}
