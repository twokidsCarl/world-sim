import type { GpuContext } from '../gpu/device'
import type { Knob, Params } from './params'
import type { AnalysisDef, QuantityDef } from './quantity'

export interface Frame {
  step: number
  /** 模拟时间（当它与步数不同时）。 / Simulated time, where it differs from the step count. */
  time?: number
  /**
   * 后端无法如实表示该状态（例如邻居表已满）。
   * The backend could not represent the state faithfully (for example a full neighbour table).
   */
  overflow?: boolean
}

/**
 * 一个正在运行的模拟。F 是其约化器所填充的帧类型。
 * One running simulation. F is the frame type its reducers fill in.
 */
export interface Backend<F> {
  step(n: number): void
  /**
   * 应用那些其旋钮无需重建状态的参数。
   * Apply parameters whose knobs do not require rebuilding the state.
   */
  setParams(p: Params): void
  /** 对当前状态计算所请求的约化器。 / Compute the requested reducers for the current state. */
  reduce(ids: readonly string[]): F | Promise<F>
  dispose(): void
}

export interface RunBackend<F extends Frame> extends Backend<F> {
  readonly kind: 'cpu' | 'gpu'
  readonly stepCount: number
  /**
   * 每个显示帧内模拟步数的上限，用于单步开销较大的后端。
   * Cap on simulation steps per display frame, for backends whose step is expensive.
   */
  readonly maxStepsPerFrame?: number
  /**
   * 上一批步进所用的 GPU 时间，单位毫秒（后端能够测量时）。
   * GPU time of the last step batch in milliseconds, where the backend can measure it.
   */
  readonly gpuStepMs?: number | null
  /**
   * 以该后端特有的方式扰动系统（对粒子体系：激发一个声波）。
   * Disturb the system in the backend's characteristic way (for particles: launch a sound wave).
   */
  perturb?(amplitude: number): void
  /**
   * 反转时间方向（动力学允许时）。
   * Reverse the direction of time, where the dynamics allow it.
   */
  reverse?(): void
}

export interface Substrate<F extends Frame> {
  id: string
  label: string
  /** 显示在标题下方的一句话。 / One sentence shown under the title. */
  blurb: string
  /** 时间序列 x 轴的单位名称。 / Name of the unit on the x axis of time series. */
  stepLabel: string
  knobs: Knob[]
  quantities: QuantityDef<F>[]
  /**
   * 分析作用于某个量的历史记录，而不是单独的一帧。
   * Analyses run on the recorded history of a quantity rather than on single frames.
   */
  analyses?: AnalysisDef[]
  /**
   * 当 `backend` 旋钮选中 GPU 且设备可用时，使用 GPU 后端。
   * Uses the GPU backend when the `backend` knob selects it and a device is available.
   */
  create(p: Params, seed: number, gpu: GpuContext | null): RunBackend<F>
}
