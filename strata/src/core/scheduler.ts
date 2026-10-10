// Pull-based evaluation: only quantities with at least one subscriber are computed,
// and only the reducers those quantities need are requested from the backend.

import type { Params } from './params'
import type { QuantityDef, Sample } from './quantity'
import type { Backend } from './substrate'

type Listener = (s: Sample) => void

export class Scheduler<F extends { step: number; time?: number }> {
  epoch = 0
  private byId = new Map<string, QuantityDef<F>>()
  private listeners = new Map<string, Set<Listener>>()
  /** Called with every frame that is delivered, before the quantities computed from it. */
  onFrame: ((frame: F) => void) | null = null

  constructor(quantities: QuantityDef<F>[]) {
    for (const q of quantities) this.byId.set(q.id, q)
  }

  subscribe(id: string, fn: Listener): () => void {
    if (!this.byId.has(id)) throw new Error(`unknown quantity: ${id}`)
    let set = this.listeners.get(id)
    if (!set) this.listeners.set(id, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
      if (set.size === 0) this.listeners.delete(id)
    }
  }

  /** Reducers needed by the currently subscribed quantities. */
  activeReducers(): string[] {
    const ids = new Set<string>()
    for (const id of this.listeners.keys()) for (const r of this.byId.get(id)!.reducers) ids.add(r)
    return [...ids]
  }

  async tick(backend: Backend<F>, p: Params): Promise<void> {
    if (this.listeners.size === 0) return
    const epoch = this.epoch
    const frame = await backend.reduce(this.activeReducers())
    if (epoch !== this.epoch) return
    this.onFrame?.(frame)
    for (const [id, set] of this.listeners) {
      const q = this.byId.get(id)!
      const sample: Sample = {
        step: frame.step,
        time: frame.time ?? frame.step,
        epoch,
        value: q.compute(frame, p),
        theory: q.theory ? q.theory(frame, p) : null,
      }
      for (const fn of set) fn(sample)
    }
  }
}
