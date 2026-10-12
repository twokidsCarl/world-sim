// 精编表（data/curated/pain/）的类型化读取。每个数字都带出处或“假设”标记，见各 JSON 的 _doc。
// Typed access to the curated tables (data/curated/pain/). Every number carries a source or an
// "assumption" flag; see the _doc of each JSON.

import autonomicJson from '../../data/curated/pain/autonomic.json'
import nociceptionJson from '../../data/curated/pain/nociception.json'
import reflexJson from '../../data/curated/pain/reflex.json'
import regionsJson from '../../data/curated/pain/regions.json'
import sourcesJson from '../../data/curated/pain/sources.json'
import type { Bilingual, SourceRef, StimulusKind } from './types.ts'

/** 表里的一个量 / One quantity of a table. */
export interface Quantity<T = number> {
  value: T
  unit?: string
  source?: string | string[]
  assumption?: boolean
  derived?: boolean
  note?: Bilingual
}

export interface Modality {
  name: Bilingual
  quantity: 'force' | 'pressure' | 'temperature'
  unit: string
  receptors: Bilingual
  receptorSource: string
  probe?: { areaMm2?: Quantity; tipDiameterMm?: Quantity }
  threshold?: Quantity
  thresholdFactor?: Quantity
  defaultAreaMm2?: Quantity
  response: { form: 'log2' | 'ratio' | 'linear'; gain: Quantity; exponent?: Quantity }
  firstPainShare: Quantity
}

export interface NociceptionTable {
  scale: { max: Quantity }
  fibres: Record<'Adelta' | 'C', { name: Bilingual; role: Bilingual; velocity: Quantity; velocityRange: Quantity<[number, number]> }>
  modalities: Record<StimulusKind, Modality>
  temporal: {
    centralDelay: Quantity
    firstPain: { rise: Quantity; decay: Quantity; adaptTo: Quantity; adaptTime: Quantity }
    secondPain: { rise: Quantity; decay: Quantity; reportedDelay: Quantity<[number, number]> }
    temporalSummation: { minHz: Quantity; plateauStimuli: Quantity; referenceForce: Quantity; gain: { hand: Quantity; other: Quantity } }
  }
}

type SiteValue = Quantity | { male: Quantity; female: Quantity }

export interface ThresholdTable {
  unit: string
  sites: Record<string, SiteValue>
  fallback: { assumption: boolean; note: Bilingual; map: Record<string, string>; special?: { regions: string[]; note: Bilingual } }
}

export interface RegionsTable {
  regions: Record<string, { name: Bilingual; limb: 'upper' | 'lower' | null }>
  territoryRegion: Record<string, string>
  refinements: { region: string; whenNearestJoint?: string; whenDermatome?: string[]; use: string; note: Bilingual }[]
  thresholds: {
    heat: ThresholdTable
    cold: ThresholdTable
    pressure: ThresholdTable
    pinprick: { factors: { assumption: boolean; note: Bilingual; map: Record<string, number> } }
  }
  innervation: {
    note: Bilingual
    sites: Record<string, { quantity: Bilingual; unit: string; all: Quantity; male: Quantity; female: Quantity }>
    qualitative: { regions: string[]; source: string; note: Bilingual }[]
  }
}

export interface ReflexTargetDef {
  joint: string
  dof: string
  degrees: Quantity
}

export interface ReflexPattern {
  name: Bilingual
  source: string
  efferentJoint: string
  targets: ReflexTargetDef[]
  variants: { whenTerritory: string[]; name: Bilingual; source: string; replace: ReflexTargetDef }[]
}

export interface ReflexTable {
  threshold: Quantity
  motorVelocity: Quantity
  spinalDelay: Quantity
  electromechanicalDelay: Quantity
  pose: { rise: Quantity; hold: Quantity; release: Quantity; minFraction: Quantity }
  reference: Record<'lower' | 'upper', { latency: Quantity & { sd: number }; window: Quantity<[number, number]> }>
  patterns: Record<'lower' | 'upper', ReflexPattern>
}

export type AutonomicSignId = 'heartRate' | 'systolic' | 'diastolic' | 'respiratoryRate' | 'pupil' | 'skinConductance'

export interface AutonomicSign {
  name: Bilingual
  unit: string
  baseline: Quantity
  effect: Quantity
  mode: 'percent' | 'absolute'
  referenceIntensity: Quantity
  latency: Quantity
  rise: Quantity
  fall: Quantity
}

export interface AutonomicTable {
  signs: Record<AutonomicSignId, AutonomicSign>
}

export const NOCICEPTION = nociceptionJson as unknown as NociceptionTable
export const REGIONS = regionsJson as unknown as RegionsTable
export const REFLEX = reflexJson as unknown as ReflexTable
export const AUTONOMIC = autonomicJson as unknown as AutonomicTable
export const SOURCES: readonly SourceRef[] = (sourcesJson as unknown as { sources: SourceRef[] }).sources

export const AUTONOMIC_SIGNS: readonly AutonomicSignId[] = ['heartRate', 'systolic', 'diastolic', 'respiratoryRate', 'pupil', 'skinConductance']

const SOURCE_BY_ID = new Map(SOURCES.map((s) => [s.id, s]))

/** 按 id 取出处；未知的 id 被忽略 / Sources by id; unknown ids are dropped. */
export function sourcesById(ids: Iterable<string>): SourceRef[] {
  const out: SourceRef[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const s = SOURCE_BY_ID.get(id)
    if (s && !seen.has(id)) {
      seen.add(id)
      out.push(s)
    }
  }
  return out
}

/** 一个量的出处 id 列表 / The source ids of a quantity. */
export function sourceIds(q: { source?: string | string[] }): string[] {
  return q.source === undefined ? [] : Array.isArray(q.source) ? q.source : [q.source]
}

export interface SiteThreshold {
  value: number
  unit: string
  /** 取值的部位 / The site the value belongs to. */
  site: string
  /** 是否借用了别的部位的值（假设）/ Whether another site's value was borrowed (an assumption). */
  borrowed: boolean
  quantity: Quantity
  borrowNote: Bilingual | null
}

/**
 * 某部位的阈值：先找该部位，再按 fallback 借用；有分性别的值时取该体型的性别。
 * Threshold of a region: its own value, else the fallback site's; the body's sex where values
 * are given by sex.
 */
export function siteThreshold(table: ThresholdTable, region: string, sex: 'male' | 'female'): SiteThreshold {
  let site = region
  let borrowed = false
  if (!(site in table.sites)) {
    const next = table.fallback.map[site]
    if (!next || !(next in table.sites)) throw new Error(`painmodel: 部位 ${region} 没有阈值也没有借用规则 / no threshold or fallback for region ${region}`)
    site = next
    borrowed = true
  }
  const entry = table.sites[site]!
  const quantity = 'value' in entry ? entry : entry[sex]
  let borrowNote: Bilingual | null = null
  if (borrowed) {
    const sp = table.fallback.special
    const extra = sp && sp.regions.includes(region) ? sp.note : null
    borrowNote = extra ? { zh: table.fallback.note.zh + extra.zh, en: `${table.fallback.note.en} ${extra.en}` } : table.fallback.note
  }
  return { value: quantity.value, unit: table.unit, site, borrowed, quantity, borrowNote }
}
