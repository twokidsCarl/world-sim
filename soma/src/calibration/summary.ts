// 标定对照表（data/curated/calibration/*.json）的读法：按人体筛选、数出容差内外、挑出差得最多的几行。纯函数。
// Reading the calibration tables (data/curated/calibration/*.json): filter by body, count rows within and outside
// tolerance, pick the rows that disagree most. Pure functions.
//
// 这些表是把外部的开放模型和已发表的统计当作量具，在两边算同一个量再相减；不是临床人员的审核。
// The tables use open external models and published statistics as measuring instruments: the same quantity is computed on
// both sides and subtracted. This is not validation by a clinician.

export interface Bilingual {
  zh: string
  en: string
}

export interface CalibrationReference {
  id: string
  name: string
  version: string
  url: string
  licence: string
  clause?: string
  opened?: string
}

/** 表里的一行：各表的列不同，这里只约定共有的两个 / One row: the columns differ between tables; only the two shared ones are fixed here. */
export interface CalibrationRow {
  body?: string
  verdict?: string
  [key: string]: unknown
}

export interface CalibrationTable {
  schema: number
  id: string
  title: Bilingual
  method: Bilingual
  tolerance: Bilingual
  references: CalibrationReference[]
  notes?: Bilingual[]
  summary?: Record<string, unknown>
  rows: CalibrationRow[]
}

export type BodyFilter = 'all' | 'male' | 'female'

export interface Counts {
  rows: number
  within: number
  outside: number
  notComparable: number
  /** 没有判定的行（量具自检那张表整张都是）/ rows with no verdict (the whole instrument-check table). */
  unjudged: number
}

/** 这张表是否按人体分行 / Whether the table's rows are split by body. */
export function hasBodies(table: Pick<CalibrationTable, 'rows'>): boolean {
  return table.rows.some((r) => r.body === 'male' || r.body === 'female')
}

/** 按人体筛选；不分人体的行（活动范围、面部控制的覆盖）总是保留 / Filter by body; rows that belong to no body (range of motion, facial control coverage) are always kept. */
export function rowsFor(table: Pick<CalibrationTable, 'rows'>, body: BodyFilter): CalibrationRow[] {
  if (body === 'all') return table.rows
  return table.rows.filter((r) => r.body === undefined || r.body === body)
}

export function countRows(rows: readonly CalibrationRow[]): Counts {
  const c: Counts = { rows: rows.length, within: 0, outside: 0, notComparable: 0, unjudged: 0 }
  for (const r of rows) {
    if (r.verdict === 'within') c.within++
    else if (r.verdict === 'outside') c.outside++
    else if (r.verdict === 'not comparable') c.notComparable++
    else c.unjudged++
  }
  return c
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * 一行差了多少，以它自己的容差为单位（1 = 正好在容差边上）；没有可比的数时为 null。各表的列不同，按列名识别：
 *   diffMm / toleranceMm、diffDeg / toleranceDeg、diff / tolerance；ratio / toleranceFactor（比值，取对数的大小）；
 *   ours 与 [refLow, refHigh] 区间（器官体积、肱骨角度：超出区间的量 ÷ 区间半宽）；没有容差的表（量具自检）用 |diffMm|。
 * How far one row is off, in units of its own tolerance (1 = exactly at the tolerance); null when the row has no comparable
 * number. The columns differ between tables and are recognised by name: diffMm / toleranceMm, diffDeg / toleranceDeg,
 * diff / tolerance; ratio / toleranceFactor (a ratio, by the size of its logarithm); ours against a [refLow, refHigh] band
 * (organ volumes, humeral angles: the excess over the band ÷ half its width); a table with no tolerance (instrument check)
 * uses |diffMm|.
 */
export function disagreement(row: CalibrationRow): number | null {
  for (const [d, t] of [['diffMm', 'toleranceMm'], ['diffDeg', 'toleranceDeg'], ['diff', 'tolerance']] as const) {
    const dv = num(row[d]), tv = num(row[t])
    if (dv !== null && tv !== null && tv > 0) return Math.abs(dv) / tv
  }
  const ratio = num(row.ratio), factor = num(row.toleranceFactor)
  if (ratio !== null && factor !== null && ratio > 0 && factor > 1) return Math.abs(Math.log(ratio)) / Math.log(factor)
  for (const unit of ['Ml', 'Deg']) {
    const ours = num(row[`ours${unit}`]), lo = num(row[`refLow${unit}`]), hi = num(row[`refHigh${unit}`])
    if (ours !== null && lo !== null && hi !== null && hi > lo) {
      const half = (hi - lo) / 2
      return Math.abs(ours - (lo + hi) / 2) / half
    }
  }
  const only = num(row.diffMm)
  return only !== null ? Math.abs(only) : null
}

/** 差得最多的 n 行：先看判定为 outside 的，按 disagreement 从大到小；没有数的排在后面。 The n rows that disagree most: those judged outside first, by disagreement descending; rows without a number come last. */
export function largestDisagreements(rows: readonly CalibrationRow[], n: number): CalibrationRow[] {
  const judged = rows.some((r) => r.verdict !== undefined)
  const pool = judged ? rows.filter((r) => r.verdict === 'outside') : [...rows]
  return pool
    .map((row) => ({ row, d: disagreement(row) }))
    .sort((a, b) => (b.d ?? -1) - (a.d ?? -1))
    .slice(0, n)
    .map((x) => x.row)
}

const LABEL_KEYS = ['muscle', 'end', 'movement', 'entry', 'direction', 'quantity', 'organ', 'au', 'region', 'item', 'coordinate', 'kind'] as const

/** 一行说的是什么（不含人体，人体另有一列）/ What a row is about (without the body, which has its own column). */
export function rowLabel(row: CalibrationRow): string {
  const parts: string[] = []
  const name = row.name as Bilingual | undefined
  if (name && typeof name === 'object' && typeof name.zh === 'string') parts.push(`${name.zh} ${name.en}`)
  for (const k of LABEL_KEYS) {
    const v = row[k]
    if (typeof v !== 'string' || !v) continue
    // 器官有双语名时不再重复英文的 organ / with a bilingual organ name the plain English `organ` is not repeated
    if (k === 'organ' && parts.length) continue
    // "entry" 和 "movement" 说的是同一件事时只留一个 / only one of "entry" and "movement" when they say the same
    if (k === 'movement' && typeof row.entry === 'string') continue
    parts.push(v)
  }
  const side = row.side
  if ((side === 'L' || side === 'R') && !parts.some((p) => /\b(left|right)\b/i.test(p) || /, [LR]$/.test(p))) parts.push(side)
  return parts.join(' · ')
}

const fmt = (v: number): string => String(Math.abs(v) >= 100 ? Math.round(v) : Math.abs(v) >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 1000) / 1000)
const vec = (v: unknown): string | null => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number') ? `(${(v as number[]).map((x) => x.toFixed(3)).join(', ')})` : null)

export interface RowValues {
  ours: string
  ref: string
  diff: string
  tolerance: string
}

/** 一行的四个数，带单位，供表格显示；没有的为 "–"。 The four numbers of a row with their units, for display; "–" where absent. */
export function rowValues(row: CalibrationRow): RowValues {
  const pick = (cands: [string, string][]): string => {
    for (const [key, unit] of cands) {
      const n = num(row[key])
      if (n !== null) return `${fmt(n)}${unit}`
      const v = vec(row[key])
      if (v) return `${v}${unit}`
    }
    return '–'
  }
  const unit = typeof row.unit === 'string' && row.unit !== 'ratio' ? ` ${row.unit}` : ''
  // "ours" / "ref" 在不同的表里单位不同：有 diffDeg 的是度，有 diffMm 的是米制坐标 / plain "ours" / "ref" differ by table: degrees where there is a diffDeg, metric coordinates where there is a diffMm
  const plain = 'diffDeg' in row || 'toleranceDeg' in row ? '°' : 'toleranceMm' in row ? ' m' : unit
  const band = (u: string): string => {
    const lo = num(row[`refLow${u}`]), hi = num(row[`refHigh${u}`])
    return lo !== null && hi !== null ? `${fmt(lo)}–${fmt(hi)}${u === 'Ml' ? ' mL' : '°'}` : '–'
  }
  let tolerance = pick([['toleranceMm', ' mm'], ['toleranceDeg', '°'], ['tolerance', unit]])
  if (tolerance === '–' && num(row.toleranceFactor) !== null) tolerance = `×/÷ ${fmt(num(row.toleranceFactor)!)}`
  if (tolerance === '–') tolerance = 'oursMl' in row ? band('Ml') : 'oursDeg' in row ? band('Deg') : '–'
  let diff = pick([['diffMm', ' mm'], ['diffDeg', '°'], ['diff', unit], ['diffMl', ' mL']])
  if (diff === '–' && num(row.ratio) !== null) diff = `× ${fmt(num(row.ratio)!)}`
  return {
    ours: pick([['ourArmMm', ' mm'], ['oursMm', ' mm'], ['oursMl', ' mL'], ['oursDeg', '°'], ['opensimPathPointsArmMm', ' mm'], ['ours', plain]]),
    ref: pick([['refArmMm', ' mm'], ['refMm', ' mm'], ['refCentralMl', ' mL'], ['refCentralDeg', '°'], ['myoMujocoArmMm', ' mm'], ['ref', plain]]),
    diff,
    tolerance,
  }
}

/** 一行附带的说明（字符串或双语）/ The note attached to a row (a string or bilingual). */
export function rowNote(row: CalibrationRow): Bilingual | null {
  const n = row.note
  if (typeof n === 'string' && n) return { zh: n, en: n }
  if (n && typeof n === 'object' && typeof (n as Bilingual).zh === 'string') return n as Bilingual
  if (typeof row.coverage === 'string') return { zh: `覆盖：${row.coverage}`, en: `coverage: ${row.coverage}` }
  return null
}
