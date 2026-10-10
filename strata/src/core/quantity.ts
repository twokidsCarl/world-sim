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

/** A scalar field on a regular grid, row-major with y as the row. */
export interface Field {
  nx: number
  ny: number
  data: ArrayLike<number>
  /** Width over height of the region the grid covers. */
  aspect: number
}

export type Value = number | Curve | Field

export const isField = (v: Value | null): v is Field => v !== null && typeof v !== 'number' && 'data' in v
export const isCurve = (v: Value | null): v is Curve => v !== null && typeof v !== 'number' && 'y' in v

export interface QuantityDef<F> {
  id: string
  level: LevelId
  label: string
  kind: 'scalar' | 'curve' | 'field'
  /** Weight of each new sample in the running average of curves and fields; 0.1 by default. */
  smooth?: number
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
  /** Keep the time series of this curve so analyses can use it. */
  record?: boolean
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
  if (!isCurve(value) || !isCurve(theory)) return 'none'
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
  time: number
  /** Incremented whenever parameters change; consumers drop samples from older epochs. */
  epoch: number
  value: Value
  theory: Value | null
}

/** The recorded time series of a curve quantity: y[k] is the curve at time t[k]. */
export interface History {
  t: number[]
  x: ArrayLike<number>
  y: Float64Array[]
}

export interface AnalysisResult {
  /** The finding in one line, e.g. a fitted equation. */
  headline: string
  detail?: string
  curve?: Curve
  theory?: Curve
  xLabel?: string
  theoryLabel?: string
}

/** A computation over the recorded history of one quantity. */
export interface AnalysisDef {
  id: string
  level: LevelId
  label: string
  /** Id of the recorded quantity this reads. */
  source: string
  /** Fewest snapshots needed before running. */
  minSamples: number
  when?: (p: Params) => boolean
  compute(h: History, p: Params): AnalysisResult | null
}
