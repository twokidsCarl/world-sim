// 一个量（quantity）是对微观状态的一种导出描述，位于层级阶梯的某一层。
// 它由约化器（reducer）的输出算出，并可附带理论预言，由界面叠加在测量值上。
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

/**
 * 规则网格上的标量场，按行主序存储，y 为行。
 * A scalar field on a regular grid, row-major with y as the row.
 */
export interface Field {
  nx: number
  ny: number
  data: ArrayLike<number>
  /** 网格所覆盖区域的宽高比。 / Width over height of the region the grid covers. */
  aspect: number
  /** 有正有负的场：以 0 为中心用发散色图 / A signed field: drawn with a diverging colour map centred on 0 */
  signed?: boolean
}

export type Value = number | Curve | Field

export const isField = (v: Value | null): v is Field => v !== null && typeof v !== 'number' && 'data' in v
export const isCurve = (v: Value | null): v is Curve => v !== null && typeof v !== 'number' && 'y' in v

export interface QuantityDef<F> {
  id: string
  level: LevelId
  label: string
  kind: 'scalar' | 'curve' | 'field'
  /**
   * 曲线和场做滑动平均时每个新样本的权重；默认 0.1。
   * Weight of each new sample in the running average of curves and fields; 0.1 by default.
   */
  smooth?: number
  /** 曲线的绘制方式；默认为柱状。 / How a curve is drawn; bars by default. */
  mark?: 'bars' | 'line'
  /** 该量需要帧中提供的约化器输出。 / Reducer outputs this quantity needs in the frame. */
  reducers: string[]
  xLabel?: string
  compute(frame: F, p: Params): Value
  /**
   * 理论预言；没有适用理论时为 null。
   * Prediction from theory, or null where no theory applies.
   */
  theory?(frame: F, p: Params): Value | null
  theoryLabel?: string
  /**
   * 同一个量在选区内的取值；没有选区时返回 null。
   * The same quantity restricted to the selected region; null when no region is set.
   */
  regional?(frame: F, p: Params): Value | null
  /**
   * 测量与理论何时算作相符：对标量，|value - theory| <= abs + rel * |theory|；
   * 对曲线，绝对差之和相对于理论值之和须不超过 rel。
   * When measurement and theory count as agreeing: |value - theory| <= abs + rel * |theory|
   * for scalars; for curves, the summed absolute difference relative to the summed theory
   * must be within rel.
   */
  tolerance?: { abs?: number; rel?: number }
  /** 仅当此条件成立时才显示该量。 / Hide the quantity unless this holds. */
  when?: (p: Params) => boolean
  /**
   * 保留该量的时间序列（曲线，或把标量当作单点曲线），供分析使用。
   * Keep the time series of this quantity (a curve, or a scalar as a one-point curve) so analyses can use it.
   */
  record?: boolean
  /**
   * 横轴是到粒子的距离：鼠标悬停时在舞台上画出对应半径的圆。
   * The x axis is a distance from a particle: hovering draws a circle of that radius on the stage.
   */
  hoverRadius?: boolean
  /**
   * 在当前参数下该量的理论不再适用的原因；仍适用时为 null。
   * A reason the quantity's theory no longer applies under these parameters, or null.
   */
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
  /**
   * 每当参数改变就加一；使用方丢弃更早纪元（epoch）的样本。
   * Incremented whenever parameters change; consumers drop samples from older epochs.
   */
  epoch: number
  value: Value
  theory: Value | null
  /** 选区内的取值 / The value inside the selected region */
  regional: Value | null
}

/**
 * 曲线量的时间序列记录：y[k] 是 t[k] 时刻的曲线。
 * The recorded time series of a curve quantity: y[k] is the curve at time t[k].
 */
export interface History {
  t: number[]
  x: ArrayLike<number>
  y: Float64Array[]
}

export interface AnalysisResult {
  /**
   * 用一行文字给出的结论，例如拟合得到的方程。
   * The finding in one line, e.g. a fitted equation.
   */
  headline: string
  detail?: string
  curve?: Curve
  theory?: Curve
  xLabel?: string
  theoryLabel?: string
  /**
   * 结论是否与理论相符（仅当该分析有对应理论时）。
   * Whether the finding matches its theory, where the analysis has one.
   */
  agree?: boolean
}

/** 对某一个量的历史记录所做的计算。 / A computation over the recorded history of one quantity. */
export interface AnalysisDef {
  id: string
  level: LevelId
  label: string
  /** 所读取的被记录量的 id。 / Id of the recorded quantity this reads. */
  source: string
  /** 运行前至少需要的快照数。 / Fewest snapshots needed before running. */
  minSamples: number
  when?: (p: Params) => boolean
  /**
   * 计算时要用到最新值的其他标量；播放场景时会保持对它们的计算。
   * Other scalars whose latest value the computation uses; kept computed while a scenario plays.
   */
  needs?: string[]
  /**
   * `latest` 返回某个标量量的最新值（如果它正在被计算）。
   * `latest` returns the most recent value of a scalar quantity, if it is being computed.
   */
  compute(
    h: History,
    p: Params,
    latest: (id: string) => number | undefined,
    /** 其他被记录的量的历史，若有。 / The recorded history of another quantity, if any. */
    history?: (id: string) => History | undefined,
  ): AnalysisResult | null
}
