import type { Params } from '../../core/params'
import type { GpuContext } from '../../gpu/device'
import type { MdBackend, MdFrame } from './backend-cpu'
import code from './gpu/md.wgsl?raw'
import { buildTable, tablePair, type PairTable, type PotentialSpec } from './potential'
import { initTriangular } from './ref/init'
import { rdfNormalise, type Hist } from './ref/reducers'
import { potentialSpec } from './schema'

const CHUNK = 256
const TABLE_K = 2048
const SPEED_BINS = 64
const RDF_BINS = 120
const RDF_OFFSET = 64
const MAX_CELL_SLOT = 192
const HIST_WORDS = 196
const THERMOSTAT_TAU = 0.5
const PARAM_BYTES = 80
/** Close-packed number density the cell capacity is sized for, per unit cell volume. */
const PACKING_DENSITY = 1.6

/** Bindings each entry point uses; auto layouts contain exactly these. */
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
} as const

type Entry = keyof typeof ENTRY_BINDINGS

export class MdGpuBackend implements MdBackend {
  readonly kind = 'gpu'
  readonly n: number
  readonly dim = 2 as const
  readonly box: Float64Array
  stepCount = 0
  spec: PotentialSpec
  /** Particle positions, for the renderer. */
  readonly pos: GPUBuffer
  /** Per particle: virial share, Re ψ6, Im ψ6, neighbour count. */
  readonly aux: GPUBuffer

  private device: GPUDevice
  private p: Params
  private time = 0
  private chunks: number
  private table!: PairTable
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
  private heat = 0
  private e0 = 0
  private rebaseEpoch = 1
  private rebasedAt = 0
  private disposed = false

  constructor(gpu: GpuContext, p: Params, seed: number) {
    this.device = gpu.device
    this.p = { ...p }
    this.lastT = p.temperature
    this.spec = potentialSpec(p)
    const init = initTriangular(
      { nx: p.nx, density: p.density, temperature: p.temperature, seed },
      tablePair(buildTable(this.spec, TABLE_K)),
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
    make(7, (TABLE_K + 1) * 8)
    make(8, this.chunks * 48)
    make(9, HIST_WORDS * 4)
    make(10, this.chunks * 4)

    const pos = new Float32Array(this.n * 4)
    const vel = new Float32Array(this.n * 4)
    for (let i = 0; i < this.n; i++) {
      pos[4 * i] = init.pos[2 * i]
      pos[4 * i + 1] = init.pos[2 * i + 1]
      vel[4 * i] = init.vel[2 * i]
      vel[4 * i + 1] = init.vel[2 * i + 1]
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

  private uploadTable(): void {
    const t = (this.table = buildTable(this.spec, TABLE_K))
    const data = new Float32Array((TABLE_K + 1) * 2)
    for (let i = 0; i <= TABLE_K; i++) {
      data[2 * i] = t.g[i]
      data[2 * i + 1] = t.u[i]
    }
    this.device.queue.writeBuffer(this.buffers[7]!, 0, data)
  }

  /** Size the cell grid for the current cutoff and rebuild the bind groups that reference it. */
  private configureGrid(): void {
    const rc = this.spec.rc
    let cellVolume = 1
    for (let d = 0; d < this.dim; d++) {
      this.nc[d] = Math.max(3, Math.floor(this.box[d] / rc))
      cellVolume *= this.box[d] / this.nc[d]!
    }
    if (this.box[0] / this.nc[0] < rc || this.box[1] / this.nc[1] < rc) {
      throw new Error('box is smaller than three cutoff radii; use the CPU backend')
    }
    this.cells = this.nc[0] * this.nc[1] * this.nc[2]
    this.cap = Math.ceil(PACKING_DENSITY * cellVolume) + 4

    // g(r) reaches as far as the stencil allows without wrapping onto itself.
    const cellSize = Math.min(this.box[0] / this.nc[0], this.box[1] / this.nc[1])
    const maxReach = Math.floor((Math.min(this.nc[0], this.nc[1]) - 1) / 2)
    this.rdfReach = Math.min(maxReach, Math.ceil(4 / cellSize))
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
    const tableChanged = JSON.stringify(spec) !== JSON.stringify(this.spec)
    if (!p.thermostat && p.temperature !== this.p.temperature) this.pendingKick = p.temperature
    this.p = { ...p }
    if (tableChanged) {
      const gridChanged = spec.rc !== this.spec.rc
      this.spec = spec
      this.uploadTable()
      if (gridChanged) this.configureGrid()
      this.recomputeForces()
    }
  }

  step(n: number): void {
    // Drop the frame rather than queue work faster than the GPU completes it.
    if (this.inFlight >= 2 || this.disposed) return
    const { dt, thermostat, temperature: target } = this.p
    let rescale = false
    if (this.pendingKick !== null) {
      this.lambda = Math.sqrt(this.pendingKick / Math.max(this.lastT, 1e-9))
      this.lastT = this.pendingKick
      this.pendingKick = null
      this.rebaseEpoch++
      rescale = true
    } else if (thermostat) {
      // Berendsen weak coupling over this batch, from the last temperature read back.
      const lambda2 = 1 + ((n * dt) / THERMOSTAT_TAU) * (target / Math.max(this.lastT, 1e-9) - 1)
      this.lambda = Math.sqrt(Math.min(Math.max(lambda2, 0.5), 2))
      rescale = true
    }
    this.writeParams(4 * Math.sqrt(this.lastT))
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    if (rescale) this.dispatch(pass, 'rescale', this.chunks, 64)
    for (let i = 0; i < n; i++) {
      this.dispatch(pass, 'kickDrift', this.n)
      this.encodeForces(pass)
      this.dispatch(pass, 'kick', this.n)
    }
    pass.end()
    this.submit(encoder)
    this.stepCount += n
    this.time += n * dt
    // The thermostat needs a current temperature even when no view is subscribed.
    if (thermostat && this.reducing === 0 && this.stepCount - this.lastReduceStep >= 48) void this.reduce([])
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
    this.lastReduceStep = step
    this.reducing++

    const partialBytes = this.chunks * 48
    const histBytes = HIST_WORDS * 4
    const heatBytes = this.chunks * 4
    const staging = this.device.createBuffer({
      size: partialBytes + histBytes + heatBytes,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    this.writeParams(vmax)
    const encoder = this.device.createCommandEncoder()
    let pass = encoder.beginComputePass()
    if (wantSpeed) this.dispatch(pass, 'speedHist', this.n)
    if (wantRdf) this.dispatch(pass, 'rdfHist', this.n)
    this.dispatch(pass, 'reduceChunks', this.chunks, 64)
    pass.end()
    encoder.copyBufferToBuffer(this.buffers[8]!, 0, staging, 0, partialBytes)
    encoder.copyBufferToBuffer(this.buffers[9]!, 0, staging, partialBytes, histBytes)
    encoder.copyBufferToBuffer(this.buffers[10]!, 0, staging, partialBytes + histBytes, heatBytes)
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

    // Chunk sums are f32; the totals are accumulated in f64.
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
    for (let c = 0; c < this.chunks; c++) {
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
      },
    }
    if (wantSpeed) frame.speedHist = speedDensity(hist, n, vmax)
    if (wantRdf) {
      const counts = Float64Array.from(hist.subarray(RDF_OFFSET, RDF_OFFSET + RDF_BINS))
      frame.rdf = rdfNormalise(counts, rdfMax, n, volume, this.dim)
    }
    staging.unmap()
    staging.destroy()
    return frame
  }

  /** Full state readback, for the cross-check harness only. */
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

  /** Overwrite positions and velocities (n * dim, f64) and recompute forces. Harness only. */
  writeState(pos: Float64Array, vel: Float64Array): void {
    const p = new Float32Array(this.n * 4)
    const v = new Float32Array(this.n * 4)
    for (let i = 0; i < this.n; i++) {
      for (let d = 0; d < this.dim; d++) {
        p[4 * i + d] = pos[i * this.dim + d]!
        v[4 * i + d] = vel[i * this.dim + d]!
      }
    }
    this.device.queue.writeBuffer(this.buffers[1]!, 0, p)
    this.device.queue.writeBuffer(this.buffers[2]!, 0, v)
    this.recomputeForces()
  }

  /** Resolves once all submitted work has finished. */
  idle(): Promise<void> {
    return this.device.queue.onSubmittedWorkDone()
  }

  dispose(): void {
    this.disposed = true
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
