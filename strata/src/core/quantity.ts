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
  /**
   * When measurement and theory count as agreeing: |value - theory| <= abs + rel * |theory|
   * for scalars; for curves, the summed absolute difference relative to the summed theory
   * must be within rel.
   */
  tolerance?: { abs?: number; rel?: number }
  /** Hide the quantity unless this holds. */
  when?: (p: Params) => boolean
  /** A reason the quantity's theory no longer applies under these parameters, or null. */
  voided?: (p: Params) => string | null
}

export type Agreement = 'agree' | 'differ' | 'none'

export function agreement(q: QuantityDef<never>, value: Value, theory: Value | null): Agreement {
  if (theory === null || !q.tolerance) return 'none'
  const { abs = 0, rel = 0 } = q.tolerance
  if (typeof value === 'number' && typeof theory === 'number') {
    if (!Number.isFinite(theory)) return 'none'
    return Math.abs(value - theory) <= abs + rel * Math.abs(theory) ? 'agree' : 'differ'
  }
  if (typeof value === 'number' || typeof theory === 'number') return 'none'
  let diff = 0
  let total = 0
  const n = Math.min(value.y.length, theory.y.length)
  for (let i = 0; i < n; i++) {
    diff += Math.abs(value.y[i]! - theory.y[i]!)
    total += Math.abs(theory.y[i]!)
  }
  return total > 0 && diff / total <= rel ? 'agree' : 'differ'
}

export interface Sample {
  step: number
  /** Incremented whenever parameters change; consumers drop samples from older epochs. */
  epoch: number
  value: Value
  theory: Value | null
}
