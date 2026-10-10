// A quantity is one derived description of the micro state, placed on a level of the
// ladder. It is computed from reducer outputs, and may carry a theory prediction that
// the UI overlays on the measurement.

import type { Params } from './params'

export type LevelId = 'micro' | 'kinetic' | 'thermo' | 'hydro' | 'structure' | 'meta'

export const LEVELS: { id: LevelId; label: string }[] = [
  { id: 'micro', label: '微观' },
  { id: 'kinetic', label: '动理' },
  { id: 'thermo', label: '热力学' },
  { id: 'hydro', label: '流体' },
  { id: 'structure', label: '结构' },
  { id: 'meta', label: '元' },
]

export interface Curve {
  x: ArrayLike<number>
  y: ArrayLike<number>
}

export type Value = number | Curve

export interface QuantityDef<F> {
  id: string
  level: LevelId
  label: string
  kind: 'scalar' | 'curve'
  /** How a curve is drawn; bars by default. */
  mark?: 'bars' | 'line'
  /** Reducer outputs this quantity needs in the frame. */
  reducers: string[]
  xLabel?: string
  compute(frame: F, p: Params): Value
  /** Prediction from theory, or null where no theory applies. */
  theory?(frame: F, p: Params): Value | null
  theoryLabel?: string
}

export interface Sample {
  step: number
  /** Incremented whenever parameters change; consumers drop samples from older epochs. */
  epoch: number
  value: Value
  theory: Value | null
}
