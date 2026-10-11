// 旋钮的元数据。tag 标明该旋钮属于哪一类假设，界面据此对控件分组，
// 并告诉用户改动它是否会改变宏观行为。
// Knob metadata. The tag says what kind of assumption a knob is, which the UI uses to
// group controls and to tell the user whether changing it can alter macroscopic behaviour.

export type Tag = 'class' | 'value' | 'state' | 'numerical' | 'toy'

export const TAG_LABEL: Record<Tag, string> = {
  class: '改变普适类',
  value: '仅改变数值',
  state: '状态变量',
  numerical: '数值方法',
  toy: '玩具规则',
}

export type Params = Record<string, number>

export interface Knob {
  id: string
  label: string
  tag: Tag
  min: number
  max: number
  step: number
  default: number
  /**
   * 改动后需要重建什么：无需重建、重建派生表，或重建整个状态。
   * What must be rebuilt when this changes: nothing, derived tables, or the whole state.
   */
  rebuild: 'none' | 'table' | 'state'
  note?: string
  /**
   * 该旋钮一旦偏离默认值就不再成立的守恒律。
   * Conservation laws that stop holding once this knob leaves its default.
   */
  breaks?: string
  /**
   * 离散选项；提供时该旋钮显示为分段控件。
   * Discrete choices; when present the knob renders as a segmented control.
   */
  options?: { value: number; label: string }[]
  /** 仅当此条件成立时才显示该旋钮。 / Hide the knob unless this holds. */
  when?: (p: Params) => boolean
}

export function defaults(knobs: Knob[]): Params {
  const p: Params = {}
  for (const k of knobs) p[k.id] = k.default
  return p
}
