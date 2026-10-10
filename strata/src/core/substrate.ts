import type { GpuContext } from '../gpu/device'
import type { Knob, Params } from './params'
import type { QuantityDef } from './quantity'

export interface Frame {
  step: number
  /** The backend could not represent the state faithfully (for example a full neighbour table). */
  overflow?: boolean
}

/** One running simulation. F is the frame type its reducers fill in. */
export interface Backend<F> {
  step(n: number): void
  /** Apply parameters whose knobs do not require rebuilding the state. */
  setParams(p: Params): void
  /** Compute the requested reducers for the current state. */
  reduce(ids: readonly string[]): F | Promise<F>
  dispose(): void
}

export interface RunBackend<F extends Frame> extends Backend<F> {
  readonly kind: 'cpu' | 'gpu'
  readonly stepCount: number
  /** Cap on simulation steps per display frame, for backends whose step is expensive. */
  readonly maxStepsPerFrame?: number
}

export interface Substrate<F extends Frame> {
  id: string
  label: string
  /** One sentence shown under the title. */
  blurb: string
  /** Name of the unit on the x axis of time series. */
  stepLabel: string
  knobs: Knob[]
  quantities: QuantityDef<F>[]
  /** Uses the GPU backend when the `backend` knob selects it and a device is available. */
  create(p: Params, seed: number, gpu: GpuContext | null): RunBackend<F>
}
