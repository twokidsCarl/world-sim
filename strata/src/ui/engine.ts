// 持有正在运行的后端和帧循环。React 组件在帧回调里读取它，
// 因此这里的任何东西都不会在每一帧触发 React 渲染。
// Owns the running backend and the frame loop. React components read from it inside
// frame callbacks, so nothing here triggers a React render per frame.

import { defaults, type Params } from '../core/params'
import {
  agreement,
  isCurve,
  isField,
  type Agreement,
  type AnalysisResult,
  type Curve,
  type Field,
  type History,
  type Sample,
} from '../core/quantity'
import { Scheduler } from '../core/scheduler'
import type { Frame, RunBackend, Substrate } from '../core/substrate'
import { getGpu, type GpuContext } from '../gpu/device'
import { SUBSTRATES } from '../substrates'

const HISTORY = 400
/**
 * 每条记录曲线保留的快照数；存满后每隔一个丢弃一个，采样间隔加倍。
 * Snapshots kept per recorded curve; when full, every other one is dropped and the stride doubles.
 */
const RECORD_LIMIT = 240
const REDUCE_EVERY = 6
const STEP_BUDGET_MS = 8
const MAX_SUBSTEPS = 8

export interface ScalarTrace {
  step: number[]
  value: number[]
  theory: number[]
}

export interface CurveTrace {
  x: ArrayLike<number>
  /** 测量值的指数时间平均。 / Exponential time average of the measurement. */
  y: Float64Array
  theory: Curve | null
}

export interface PerfSummary {
  /**
   * 页面是否可见；隐藏的标签页其动画帧会被节流。
   * Whether the page was visible; a hidden tab has its animation frames throttled.
   */
  visible: boolean
  backend: 'cpu' | 'gpu'
  /** 最近 120 帧的每秒帧数。 / Frames per second over the last 120 frames. */
  fps: number
  /**
   * 帧间隔的中位数和第 95 百分位数，单位 ms。
   * Median and 95th-percentile interval between frames, ms.
   */
  frameMs: number
  frameMsP95: number
  /**
   * 每帧在引擎中花费的主线程时间，单位 ms。
   * Main-thread time spent in the engine per frame, ms.
   */
  mainMs: number
  /**
   * 每帧请求的模拟步数，以及每秒完成的步数。
   * Simulation steps requested per frame, and completed per second.
   */
  stepsPerFrame: number
  stepsPerSecond: number
  /**
   * 由 timestamp query 得到的一批步进的 GPU 耗时，单位 ms；不可用时为 null。
   * GPU time of one step batch from timestamp queries, ms; null when unavailable.
   */
  gpuStepMs: number | null
}

const PERF_FRAMES = 120

export class Engine {
  substrate: Substrate<Frame> = SUBSTRATES[0]!
  params: Params = defaults(this.substrate.knobs)
  backend: RunBackend<Frame>
  gpu: GpuContext | null = null
  running = true
  /**
   * 设置后，步进恰好停在后端的这个步数上（场景需要精确的步数）。
   * When set, stepping stops exactly at this backend step count (scenarios need exact counts).
   */
  stopAt: number | null = null
  /**
   * 舞台上框出的选区（盒子坐标），没有则为 null。
   * The region selected on the stage (box coordinates), or null.
   */
  region: [number, number, number, number] | null = null
  /**
   * 上一帧报告后端无法表示当前状态时置位。
   * Set when the last frame reported that the backend could not represent the state.
   */
  overflow = false
  readonly scalars = new Map<string, ScalarTrace>()
  readonly curves = new Map<string, CurveTrace>()
  /** 场量的运行平均。 / Running averages of field quantities. */
  readonly fields = new Map<string, Field & { data: Float64Array }>()
  /** 标记为 `record` 的曲线量的时间序列。 / Time series of the curve quantities marked `record`. */
  readonly histories = new Map<string, History & { stride: number; skipped: number }>()
  /**
   * 每个被监视的量当前是否与其理论吻合。
   * Whether each watched quantity currently matches its theory.
   */
  readonly agreements = new Map<string, Agreement>()
  /**
   * 不影响模拟的视图选项，例如粒子如何着色。
   * View options that do not affect the simulation, e.g. how particles are coloured.
   */
  view: Record<string, number> = { colour: 0 }
  private scheduler!: Scheduler<Frame>
  private frameListeners = new Set<() => void>()
  private changeListeners = new Set<() => void>()
  private seed = 1
  private frame = 0
  private msPerStep = 1
  private raf = 0
  private frameTimes = new Float64Array(PERF_FRAMES)
  private frameSteps = new Float64Array(PERF_FRAMES)
  private frameIndex = 0
  private lastFrameAt = 0
  private mainMs = 0
  private lastN = 0
  private reducing = false
  private ready: Promise<void> | null = null

  constructor() {
    this.backend = this.substrate.create(this.params, this.seed, null)
    this.newScheduler()
  }

  private newScheduler(): void {
    this.scheduler = new Scheduler<Frame>(this.substrate.quantities)
    this.scheduler.onFrame = (f) => (this.overflow = f.overflow === true)
  }

  /**
   * 获取 GPU 设备，并在可用时切换到 GPU 后端。可以重复调用；
   * 每次调用返回同一个 promise。
   * Acquire the GPU device and switch to the GPU backend where one is available. Safe to
   * call repeatedly; every call returns the same promise.
   */
  init(): Promise<void> {
    this.ready ??= getGpu().then((gpu) => {
      this.gpu = gpu
      if (gpu) this.setParam('backend', 1)
    })
    return this.ready
  }

  /**
   * 在参数、后端或底座改变之后调用。
   * Called after parameters, the backend or the substrate change.
   */
  onChange(fn: () => void): () => void {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  setSubstrate(id: string): void {
    const next = SUBSTRATES.find((s) => s.id === id)
    if (!next || next === this.substrate) return
    this.substrate = next
    this.params = { ...defaults(next.knobs), backend: this.gpu ? 1 : 0 }
    this.newScheduler()
    this.rebuild()
  }

  setParam(id: string, value: number): void {
    const knob = this.substrate.knobs.find((k) => k.id === id)
    if (!knob) throw new Error(`unknown knob: ${id}`)
    this.params = { ...this.params, [id]: value }
    if (knob.rebuild === 'state') this.rebuild()
    else {
      this.backend.setParams(this.params)
      this.invalidate()
      for (const fn of this.changeListeners) fn()
    }
  }

  /**
   * 扰动系统（发出一个声波），并从此刻起重新开始记录历史。
   * Disturb the system (launch a sound wave) and restart the recorded histories from this moment.
   */
  perturb(amplitude: number): void {
    if (!this.backend.perturb) return
    this.backend.perturb(amplitude)
    this.histories.clear()
  }

  /** 给整个系统一个沿 x 的整体速度 / Give the whole system a bulk velocity along x */
  push(velocity: number): void {
    this.backend.push?.(velocity)
  }

  /**
   * 对目前已记录的历史运行该底座的某一项分析。
   * Run one of the substrate's analyses on the history recorded so far.
   */
  runAnalysis(id: string): AnalysisResult | null {
    const a = this.substrate.analyses?.find((d) => d.id === id)
    const h = a && this.histories.get(a.source)
    if (!a || !h || h.t.length < a.minSamples) return null
    try {
      return a.compute(h, this.params, (q) => this.scalars.get(q)?.value.at(-1))
    } catch {
      // 退化数据上的奇异拟合不是值得上报的错误。
      // A singular fit on degenerate data is not an error worth surfacing.
      return null
    }
  }

  /**
   * 反转时间方向（如果正在运行的后端支持）。
   * Reverse the direction of time, if the running backend can.
   */
  reverse(): void {
    this.backend.reverse?.()
  }

  get canReverse(): boolean {
    return typeof this.backend.reverse === 'function'
  }

  reset(): void {
    this.seed++
    this.rebuild()
  }

  private rebuild(): void {
    this.backend.dispose()
    this.backend = this.substrate.create(this.params, this.seed, this.gpu)
    // 步数计数器重新开始，因此之前的标量历史不再共用同一条 x 轴。
    // The step counter restarts, so earlier scalar history no longer shares an x axis.
    this.scalars.clear()
    this.region = null
    this.stopAt = null
    this.agreements.clear()
    this.overflow = false
    this.msPerStep = 1
    this.invalidate()
    for (const fn of this.changeListeners) fn()
  }

  /**
   * 开启新一轮（epoch）：在途的采样被丢弃，曲线平均重新开始。
   * Start a new epoch: samples in flight are dropped and curve averages restart.
   */
  private invalidate(): void {
    this.scheduler.epoch++
    this.curves.clear()
    this.fields.clear()
    this.histories.clear()
  }

  /**
   * 在返回的函数被调用之前，保持对某个量的计算。
   * Keep a quantity computed while the returned function has not been called.
   */
  watch(id: string): () => void {
    // 上一个底座的视图可能还会多挂载一次渲染；忽略它。
    // A view from the previous substrate may still be mounted for one render; ignore it.
    if (!this.substrate.quantities.some((q) => q.id === id)) return () => {}
    return this.scheduler.subscribe(id, (s) => this.record(id, s))
  }

  private record(id: string, s: Sample): void {
    const q = this.substrate.quantities.find((d) => d.id === id)!
    // 已作废的守恒律没有理论可供对照。 / A voided conservation law has no theory to agree with.
    this.agreements.set(id, q.voided?.(this.params) ? 'none' : agreement(q as never, s.value, s.theory))
    if (typeof s.value === 'number') {
      let t = this.scalars.get(id)
      if (!t) this.scalars.set(id, (t = { step: [], value: [], theory: [] }))
      if (q.record) this.remember(id, s.time, { x: [0], y: [s.value] })
      this.recordRegional(id, s)
      t.step.push(s.step)
      t.value.push(s.value)
      t.theory.push(typeof s.theory === 'number' ? s.theory : NaN)
      if (t.step.length > HISTORY) {
        t.step.shift()
        t.value.shift()
        t.theory.shift()
      }
      return
    }
    const weight = q.smooth ?? 0.1
    if (isField(s.value)) {
      const prev = this.fields.get(id)
      if (!prev || prev.data.length !== s.value.data.length) {
        this.fields.set(id, { ...s.value, data: Float64Array.from(s.value.data) })
      } else {
        for (let i = 0; i < prev.data.length; i++) prev.data[i] = (1 - weight) * prev.data[i]! + weight * s.value.data[i]!
      }
      return
    }
    if (!isCurve(s.value)) return
    this.recordRegional(id, s)
    if (q.record) this.remember(id, s.time, s.value)
    const prev = this.curves.get(id)
    const theory = isCurve(s.theory) ? s.theory : null
    if (!prev || prev.y.length !== s.value.y.length) {
      this.curves.set(id, { x: s.value.x, y: Float64Array.from(s.value.y), theory })
    } else {
      for (let i = 0; i < prev.y.length; i++) prev.y[i] = (1 - weight) * prev.y[i]! + weight * s.value.y[i]!
      prev.x = s.value.x
      prev.theory = theory
    }
    // 曲线是否吻合按其运行平均判断，而不是按单个有噪声的采样。
    // Agreement of a curve is judged on its running average, not on one noisy sample.
    const averaged = this.curves.get(id)!
    this.agreements.set(id, q.voided?.(this.params) ? 'none' : agreement(q as never, averaged, theory))
  }

  /**
   * 选区内的取值记在以 "@region" 结尾的同名条目里，与全体的那条并排画出。
   * The value inside the region is kept under the same id with "@region" appended, and
   * drawn beside the whole-system one.
   */
  private recordRegional(id: string, s: Sample): void {
    const key = `${id}@region`
    if (s.regional === null) {
      this.scalars.delete(key)
      this.curves.delete(key)
      return
    }
    if (typeof s.regional === 'number') {
      let t = this.scalars.get(key)
      if (!t) this.scalars.set(key, (t = { step: [], value: [], theory: [] }))
      t.step.push(s.step)
      t.value.push(s.regional)
      t.theory.push(NaN)
      if (t.step.length > HISTORY) {
        t.step.shift()
        t.value.shift()
        t.theory.shift()
      }
    } else if (isCurve(s.regional)) {
      const prev = this.curves.get(key)
      if (!prev || prev.y.length !== s.regional.y.length) {
        this.curves.set(key, { x: s.regional.x, y: Float64Array.from(s.regional.y), theory: null })
      } else {
        for (let i = 0; i < prev.y.length; i++) prev.y[i] = 0.9 * prev.y[i]! + 0.1 * s.regional.y[i]!
        prev.x = s.regional.x
      }
    }
  }

  /** 设置或清除选区。 / Set or clear the selected region. */
  setRegion(region: [number, number, number, number] | null): void {
    this.region = region
    for (const key of [...this.scalars.keys(), ...this.curves.keys()]) {
      if (key.endsWith('@region')) {
        this.scalars.delete(key)
        this.curves.delete(key)
      }
    }
    for (const fn of this.changeListeners) fn()
  }

  private remember(id: string, time: number, curve: Curve): void {
    let h = this.histories.get(id)
    if (!h) this.histories.set(id, (h = { t: [], x: curve.x, y: [], stride: 1, skipped: 0 }))
    if (++h.skipped < h.stride) return
    h.skipped = 0
    h.t.push(time)
    h.y.push(Float64Array.from(curve.y))
    if (h.t.length >= RECORD_LIMIT) {
      h.t = h.t.filter((_, i) => i % 2 === 0)
      h.y = h.y.filter((_, i) => i % 2 === 0)
      h.stride *= 2
    }
  }

  onFrame(fn: () => void): () => void {
    this.frameListeners.add(fn)
    return () => this.frameListeners.delete(fn)
  }

  /**
   * 推进一个显示帧：步进模拟，按计划启动一次归约，通知各视图。
   * 返回的 promise 在该次归约送达后 resolve。
   * Advance one display frame: step the simulation, start a reduction on schedule, notify
   * views. The returned promise resolves when that reduction has been delivered.
   */
  frameOnce(): Promise<void> {
    let reduced: Promise<void> = Promise.resolve()
    if (this.running) {
      const cap = this.backend.maxStepsPerFrame ?? MAX_SUBSTEPS
      let n = Math.max(1, Math.min(cap, Math.floor(STEP_BUDGET_MS / this.msPerStep)))
      if (this.stopAt !== null) n = Math.max(0, Math.min(n, this.stopAt - this.backend.stepCount))
      this.lastN = n
      if (n > 0) {
        const t0 = performance.now()
        this.backend.step(n)
        this.msPerStep = 0.9 * this.msPerStep + (0.1 * (performance.now() - t0)) / n
      }
      if (this.frame++ % REDUCE_EVERY === 0 && !this.reducing) {
        this.reducing = true
        reduced = this.scheduler.tick(this.backend, this.params, this.region).finally(() => (this.reducing = false))
      }
    }
    for (const fn of this.frameListeners) fn()
    return reduced
  }

  /** 最近 120 个动画帧的帧节奏。 / Frame pacing over the last 120 animation frames. */
  perf(): PerfSummary {
    const count = Math.min(this.frameIndex, PERF_FRAMES)
    const times = Array.from(this.frameTimes.subarray(0, count)).sort((a, b) => a - b)
    const total = times.reduce((a, b) => a + b, 0)
    let steps = 0
    for (let i = 0; i < count; i++) steps += this.frameSteps[i]!
    return {
      visible: document.visibilityState === 'visible',
      backend: this.backend.kind,
      fps: total > 0 ? (1000 * count) / total : 0,
      frameMs: times[Math.floor(count / 2)] ?? 0,
      frameMsP95: times[Math.floor(count * 0.95)] ?? 0,
      mainMs: this.mainMs,
      stepsPerFrame: this.lastN,
      stepsPerSecond: total > 0 ? (1000 * steps) / total : 0,
      gpuStepMs: this.backend.gpuStepMs ?? null,
    }
  }

  start(): void {
    const tick = () => {
      const now = performance.now()
      const before = this.backend.stepCount
      void this.frameOnce()
      if (this.lastFrameAt > 0) {
        const slot = this.frameIndex++ % PERF_FRAMES
        this.frameTimes[slot] = now - this.lastFrameAt
        this.frameSteps[slot] = this.backend.stepCount - before
      }
      this.lastFrameAt = now
      this.mainMs = 0.9 * this.mainMs + 0.1 * (performance.now() - now)
      this.raf = requestAnimationFrame(tick)
    }
    cancelAnimationFrame(this.raf)
    this.raf = requestAnimationFrame(tick)
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
  }
}

export const engine = new Engine()

// 仅用于开发的句柄，供在浏览器控制台中驱动和检查引擎。
// Dev-only handle for driving and inspecting the engine from the browser console.
if (import.meta.env.DEV) (globalThis as { __strata?: Engine }).__strata = engine
