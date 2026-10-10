// Owns the running backend and the frame loop. React components read from it inside
// frame callbacks, so nothing here triggers a React render per frame.

import { defaults, type Params } from '../core/params'
import { agreement, type Agreement, type Curve, type Sample } from '../core/quantity'
import { Scheduler } from '../core/scheduler'
import type { Frame, RunBackend, Substrate } from '../core/substrate'
import { getGpu, type GpuContext } from '../gpu/device'
import { SUBSTRATES } from '../substrates'

const HISTORY = 400
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
  /** Exponential time average of the measurement. */
  y: Float64Array
  theory: Curve | null
}

export class Engine {
  substrate: Substrate<Frame> = SUBSTRATES[0]!
  params: Params = defaults(this.substrate.knobs)
  backend: RunBackend<Frame>
  gpu: GpuContext | null = null
  running = true
  /** Set when the last frame reported that the backend could not represent the state. */
  overflow = false
  readonly scalars = new Map<string, ScalarTrace>()
  readonly curves = new Map<string, CurveTrace>()
  /** Whether each watched quantity currently matches its theory. */
  readonly agreements = new Map<string, Agreement>()
  /** View options that do not affect the simulation, e.g. how particles are coloured. */
  view: Record<string, number> = { colour: 0 }
  private scheduler!: Scheduler<Frame>
  private frameListeners = new Set<() => void>()
  private changeListeners = new Set<() => void>()
  private seed = 1
  private frame = 0
  private msPerStep = 1
  private raf = 0
  private reducing = false
  private initialised = false

  constructor() {
    this.backend = this.substrate.create(this.params, this.seed, null)
    this.newScheduler()
  }

  private newScheduler(): void {
    this.scheduler = new Scheduler<Frame>(this.substrate.quantities)
    this.scheduler.onFrame = (f) => (this.overflow = f.overflow === true)
  }

  /** Acquire the GPU device and switch to the GPU backend where one is available. */
  async init(): Promise<void> {
    if (this.initialised) return
    this.initialised = true
    this.gpu = await getGpu()
    if (this.gpu) this.setParam('backend', 1)
  }

  /** Called after parameters, the backend or the substrate change. */
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

  reset(): void {
    this.seed++
    this.rebuild()
  }

  private rebuild(): void {
    this.backend.dispose()
    this.backend = this.substrate.create(this.params, this.seed, this.gpu)
    // The step counter restarts, so earlier scalar history no longer shares an x axis.
    this.scalars.clear()
    this.agreements.clear()
    this.overflow = false
    this.msPerStep = 1
    this.invalidate()
    for (const fn of this.changeListeners) fn()
  }

  /** Start a new epoch: samples in flight are dropped and curve averages restart. */
  private invalidate(): void {
    this.scheduler.epoch++
    this.curves.clear()
  }

  /** Keep a quantity computed while the returned function has not been called. */
  watch(id: string): () => void {
    return this.scheduler.subscribe(id, (s) => this.record(id, s))
  }

  private record(id: string, s: Sample): void {
    const q = this.substrate.quantities.find((d) => d.id === id)!
    // A voided conservation law has no theory to agree with.
    this.agreements.set(id, q.voided?.(this.params) ? 'none' : agreement(q as never, s.value, s.theory))
    if (typeof s.value === 'number') {
      let t = this.scalars.get(id)
      if (!t) this.scalars.set(id, (t = { step: [], value: [], theory: [] }))
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
    const prev = this.curves.get(id)
    const theory = s.theory !== null && typeof s.theory !== 'number' ? s.theory : null
    if (!prev || prev.y.length !== s.value.y.length) {
      this.curves.set(id, { x: s.value.x, y: Float64Array.from(s.value.y), theory })
      return
    }
    for (let i = 0; i < prev.y.length; i++) prev.y[i] = 0.9 * prev.y[i]! + 0.1 * s.value.y[i]!
    prev.x = s.value.x
    prev.theory = theory
  }

  onFrame(fn: () => void): () => void {
    this.frameListeners.add(fn)
    return () => this.frameListeners.delete(fn)
  }

  /**
   * Advance one display frame: step the simulation, start a reduction on schedule, notify
   * views. The returned promise resolves when that reduction has been delivered.
   */
  frameOnce(): Promise<void> {
    let reduced: Promise<void> = Promise.resolve()
    if (this.running) {
      const n = Math.max(1, Math.min(MAX_SUBSTEPS, Math.floor(STEP_BUDGET_MS / this.msPerStep)))
      const t0 = performance.now()
      this.backend.step(n)
      this.msPerStep = 0.9 * this.msPerStep + (0.1 * (performance.now() - t0)) / n
      if (this.frame++ % REDUCE_EVERY === 0 && !this.reducing) {
        this.reducing = true
        reduced = this.scheduler.tick(this.backend, this.params).finally(() => (this.reducing = false))
      }
    }
    for (const fn of this.frameListeners) fn()
    return reduced
  }

  start(): void {
    const tick = () => {
      void this.frameOnce()
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

// Dev-only handle for driving and inspecting the engine from the browser console.
if (import.meta.env.DEV) (globalThis as { __strata?: Engine }).__strata = engine
