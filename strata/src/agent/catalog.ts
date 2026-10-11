// 给外面的 Agent 的四份数据：底座的旋钮、派生量、引导实验、理论参照。
// 全部由源码里已有的定义生成（scripts/agent.ts 写成 agent/*.json），不另外手抄。
// The four datasets offered to outside agents: knobs, derived quantities, guided
// experiments and reference values. All are generated from definitions already in the
// source (scripts/agent.ts writes them to agent/*.json); nothing is copied by hand.

import { defaults, type Knob } from '../core/params'
import type { Frame, Substrate } from '../core/substrate'
import { SCENARIOS } from '../scenarios'
import { SUBSTRATES } from '../substrates'
import { ENGLISH, LEVEL_EN, TAG_EN } from './english'
import { references, type Reference } from './references'

export interface Card {
  id: string
  title: { zh: string; en: string }
  url: string
}

function english(substrate: string) {
  const e = ENGLISH[substrate]
  if (!e) throw new Error(`src/agent/english.ts 里没有底座 ${substrate} / no English names for substrate ${substrate}`)
  return e
}

function knobRecord(s: Substrate<Frame>, k: Knob) {
  const names = english(s.id).knobs[k.id]
  if (!names) throw new Error(`src/agent/english.ts 里没有旋钮 ${s.id}.${k.id} / no English name for knob ${s.id}.${k.id}`)
  const [labelEn, optionsEn] = names
  if (k.options && optionsEn?.length !== k.options.length) {
    throw new Error(`旋钮 ${s.id}.${k.id} 的选项英文名数目不对 / wrong number of English option names for knob ${s.id}.${k.id}`)
  }
  return {
    id: `${s.id}.${k.id}`,
    substrate: s.id,
    name: k.id,
    label: k.label,
    label_en: labelEn,
    tag: k.tag,
    tag_en: TAG_EN[k.tag],
    min: k.min,
    max: k.max,
    step: k.step,
    default: k.default,
    rebuild: k.rebuild,
    ...(k.options ? { options: k.options.map((o, i) => ({ value: o.value, label: o.label, label_en: optionsEn![i]! })) } : {}),
    ...(k.note ? { note: k.note } : {}),
    ...(k.breaks ? { breaks: k.breaks } : {}),
    shown_by_default: k.when ? k.when(defaults(s.knobs)) : true,
    url: `/?substrate=${s.id}&${k.id}=${k.default}`,
  }
}

function quantityRecords(s: Substrate<Frame>) {
  const e = english(s.id)
  const p = defaults(s.knobs)
  const quantities = s.quantities.map((q) => {
    const labelEn = e.quantities[q.id]
    if (!labelEn) throw new Error(`src/agent/english.ts 里没有派生量 ${s.id}.${q.id} / no English name for quantity ${s.id}.${q.id}`)
    return {
      id: `${s.id}.${q.id}`,
      substrate: s.id,
      name: q.id,
      kind: q.kind as string,
      level: q.level,
      level_en: LEVEL_EN[q.level],
      label: q.label,
      label_en: labelEn,
      ...(q.xLabel ? { x_label: q.xLabel } : {}),
      has_theory: Boolean(q.theory),
      ...(q.theoryLabel ? { theory_note: q.theoryLabel } : {}),
      ...(q.tolerance ? { tolerance: q.tolerance } : {}),
      shown_by_default: q.when ? q.when(p) : true,
    }
  })
  const analyses = (s.analyses ?? []).map((a) => {
    const labelEn = e.analyses?.[a.id]
    if (!labelEn) throw new Error(`src/agent/english.ts 里没有分析 ${s.id}.${a.id} / no English name for analysis ${s.id}.${a.id}`)
    return {
      id: `${s.id}.${a.id}`,
      substrate: s.id,
      name: a.id,
      kind: 'analysis',
      level: a.level,
      level_en: LEVEL_EN[a.level],
      label: a.label,
      label_en: labelEn,
      source_quantity: `${s.id}.${a.source}`,
      min_samples: a.minSamples,
      has_theory: false,
      shown_by_default: a.when ? a.when(p) : true,
    }
  })
  return [...quantities, ...analyses]
}

function scenarioRecords(cards: Card[]) {
  return SCENARIOS.map((sc) => {
    const card = cards.find((c) => c.id === sc.id)
    if (!card) throw new Error(`sim.json 里没有引导实验 ${sc.id} 的卡片 / no card in sim.json for scenario ${sc.id}`)
    return {
      id: sc.id,
      substrate: sc.substrate,
      title: sc.title,
      title_en: card.title.en,
      url: `/?scenario=${sc.id}`,
      total_run: sc.steps.reduce((sum, step) => sum + step.run, 0),
      steps: sc.steps,
    }
  })
}

// 与其余几份数据一样，中文和英文各占一个字段，方便按字段搜索。
// As in the other datasets, Chinese and English each get a field of their own, so both can be searched.
function referenceRecord({ title, measured, ...rest }: Reference) {
  return {
    ...rest,
    title: title.zh,
    title_en: title.en,
    ...(measured ? { measured: measured.zh, measured_en: measured.en } : {}),
  }
}

export interface Catalog {
  substrates: { id: string; label: string; label_en: string; blurb: string; blurb_en: string; step_unit: string; step_unit_en: string; url: string }[]
  knobs: ReturnType<typeof knobRecord>[]
  quantities: ReturnType<typeof quantityRecords>
  scenarios: ReturnType<typeof scenarioRecords>
  references: ReturnType<typeof referenceRecord>[]
}

export function catalog(cards: Card[]): Catalog {
  return {
    substrates: SUBSTRATES.map((s) => {
      const e = english(s.id)
      return {
        id: s.id,
        label: s.label,
        label_en: e.label,
        blurb: s.blurb,
        blurb_en: e.blurb,
        step_unit: s.stepLabel,
        step_unit_en: e.step,
        url: `/?substrate=${s.id}`,
      }
    }),
    knobs: SUBSTRATES.flatMap((s) => s.knobs.map((k) => knobRecord(s, k))),
    quantities: SUBSTRATES.flatMap(quantityRecords),
    scenarios: scenarioRecords(cards),
    references: references().map(referenceRecord),
  }
}

/** 写进文件的文本：固定的缩进，末尾一个换行。 / The text written to a file: fixed indentation and one trailing newline. */
export const serialise = (value: unknown): string => JSON.stringify(value, null, 1) + '\n'
