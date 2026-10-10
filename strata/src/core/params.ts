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
  /** What must be rebuilt when this changes: nothing, derived tables, or the whole state. */
  rebuild: 'none' | 'table' | 'state'
  note?: string
  /** Discrete choices; when present the knob renders as a segmented control. */
  options?: { value: number; label: string }[]
  /** Hide the knob unless this holds. */
  when?: (p: Params) => boolean
}

export function defaults(knobs: Knob[]): Params {
  const p: Params = {}
  for (const k of knobs) p[k.id] = k.default
  return p
}
