// 疼痛模型的精编表（data/curated/pain/）：每个数字都要有出处或标明是假设，出处要完整，文字要中英双语。
// The curated tables of the pain model (data/curated/pain/): every number has a source or is
// flagged as an assumption, sources are complete, and text is in Chinese and English.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOCICEPTION, REFLEX, REGIONS, SOURCES, responseGain, siteThreshold } from '../src/painmodel/index.ts'

const DIR = join(import.meta.dirname, '../data/curated/pain')
const TABLES = ['nociception.json', 'regions.json', 'reflex.json', 'autonomic.json']
const read = (f: string): unknown => JSON.parse(readFileSync(join(DIR, f), 'utf8'))
const sourceIds = new Set(SOURCES.map((s) => s.id))

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const bilingual = (x: unknown): boolean => isObj(x) && typeof x.zh === 'string' && x.zh.length > 0 && typeof x.en === 'string' && x.en.length > 0

interface Finding {
  path: string
  problem: string
}

/**
 * 遍历一张表：每个数字向上找最近的带 source 或 assumption 的对象。
 * Walk a table: every number looks upwards for the nearest object carrying `source` or `assumption`.
 */
function audit(node: unknown, path: string, owner: Obj | null, out: Finding[], stats: { sourced: number; assumed: number }): void {
  if (typeof node === 'number') {
    if (!owner) out.push({ path, problem: 'a number without a source or an assumption flag' })
    else if (owner.assumption === true) stats.assumed++
    else stats.sourced++
    return
  }
  if (Array.isArray(node)) {
    node.forEach((x, i) => audit(x, `${path}[${i}]`, owner, out, stats))
    return
  }
  if (!isObj(node)) return
  let next = owner
  if ('source' in node || 'assumption' in node) {
    next = node
    if (node.assumption === true) {
      if ('source' in node) out.push({ path, problem: 'both an assumption and a source' })
      if (!bilingual(node.note)) out.push({ path, problem: 'an assumption without a bilingual note saying why' })
    } else {
      const ids = Array.isArray(node.source) ? node.source : [node.source]
      if (ids.length === 0) out.push({ path, problem: 'an empty source list' })
      for (const id of ids) if (typeof id !== 'string' || !sourceIds.has(id)) out.push({ path, problem: `unknown source ${String(id)}` })
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'note' || k === 'name' || k === 'role' || k === 'receptors' || k === 'quantity' || k === '_doc') && isObj(v) && !bilingual(v)) out.push({ path: `${path}.${k}`, problem: 'text that is not in both Chinese and English' })
    audit(v, `${path}.${k}`, next, out, stats)
  }
}

describe('pain tables: sourcing', () => {
  it.each(TABLES)('%s: every number has a source or is labelled an assumption', (file) => {
    const findings: Finding[] = []
    const stats = { sourced: 0, assumed: 0 }
    audit(read(file), file, null, findings, stats)
    expect(findings).toEqual([])
    expect(stats.sourced + stats.assumed).toBeGreaterThan(0)
  })

  it('every source id used by a table exists and every source is complete', () => {
    for (const s of SOURCES) {
      expect(s.id, 'id').toMatch(/^[a-zA-Z0-9]+$/)
      expect(s.citation.length, `${s.id} citation`).toBeGreaterThan(20)
      expect(s.url, `${s.id} url`).toMatch(/^https:\/\//)
      expect(s.license.length, `${s.id} licence`).toBeGreaterThan(3)
      expect(s.opened.length, `${s.id} how it was opened`).toBeGreaterThan(10)
      expect(bilingual(s.supports), `${s.id} supports`).toBe(true)
      if (s.doi) expect(s.doi, `${s.id} doi`).toMatch(/^10\.\d{4,9}\/\S+$/)
    }
    expect(new Set(SOURCES.map((s) => s.id)).size).toBe(SOURCES.length)
    // 各模态的 receptorSource、反射模式的 source 也要在表里 / receptorSource and pattern sources must exist too
    for (const m of Object.values(NOCICEPTION.modalities)) expect(sourceIds.has(m.receptorSource), m.receptorSource).toBe(true)
    for (const p of Object.values(REFLEX.patterns)) expect(sourceIds.has(p.source), p.source).toBe(true)
  })

  it('every source is cited by at least one table', () => {
    const text = TABLES.map((f) => readFileSync(join(DIR, f), 'utf8')).join('\n')
    for (const s of SOURCES) expect(text.includes(`"${s.id}"`) || text.includes(s.id), `${s.id} is never used`).toBe(true)
  })

  it('every table says that the simulated body has no subjective experience', () => {
    for (const f of [...TABLES, 'sources.json']) {
      const doc = (read(f) as { _doc?: { zh: string; en: string } })._doc
      expect(doc?.en, f).toMatch(/no subjective experience/)
      expect(doc?.zh, f).toMatch(/没有主观体验/)
    }
  })

  it('contains no e-mail address and no absolute local path', () => {
    for (const f of readdirSync(DIR)) {
      const text = readFileSync(join(DIR, f), 'utf8')
      expect(text, f).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)
      expect(text, f).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\\\/)
    }
  })
})

describe('pain tables: coverage', () => {
  const cutaneous = JSON.parse(readFileSync(join(import.meta.dirname, '../data/curated/skinmaps/cutaneous.json'), 'utf8')) as { regions: { key: string }[] }

  it('assigns every cutaneous territory of the skin maps to a known region', () => {
    for (const r of cutaneous.regions) {
      const region = REGIONS.territoryRegion[r.key]
      expect(region, `territory ${r.key}`).toBeDefined()
      expect(REGIONS.regions[region!], `region ${region} of ${r.key}`).toBeDefined()
    }
    for (const rule of REGIONS.refinements) {
      expect(REGIONS.regions[rule.region], rule.region).toBeDefined()
      expect(REGIONS.regions[rule.use], rule.use).toBeDefined()
    }
  })

  it('resolves a heat, cold and pressure threshold for every region and both sexes', () => {
    for (const region of Object.keys(REGIONS.regions)) {
      for (const sex of ['male', 'female'] as const) {
        const heat = siteThreshold(REGIONS.thresholds.heat, region, sex)
        const cold = siteThreshold(REGIONS.thresholds.cold, region, sex)
        const pressure = siteThreshold(REGIONS.thresholds.pressure, region, sex)
        // 热痛阈高于皮肤基线温度，冷痛阈低于它 / heat threshold above the skin baseline, cold threshold below it
        expect(heat.value, `${region} heat`).toBeGreaterThan(35)
        expect(heat.value, `${region} heat`).toBeLessThan(50)
        expect(cold.value, `${region} cold`).toBeGreaterThan(0)
        expect(cold.value, `${region} cold`).toBeLessThan(30)
        expect(pressure.value, `${region} pressure`).toBeGreaterThan(100)
        expect(pressure.value, `${region} pressure`).toBeLessThan(1200)
        // 借用别处的值时必须有说明 / a borrowed value must come with its note
        for (const t of [heat, cold, pressure]) expect(t.borrowed ? t.borrowNote !== null : t.borrowNote === null, `${region} ${t.site}`).toBe(true)
      }
    }
    expect(() => siteThreshold(REGIONS.thresholds.heat, 'nowhere', 'male')).toThrow()
  })

  it('gives every modality a supra-threshold gain, and heat its documented alternatives', () => {
    for (const [kind, m] of Object.entries(NOCICEPTION.modalities)) {
      const g = responseGain(m)
      expect(g.quantity.value, kind).toBeGreaterThan(0)
      expect(g.anchor === null, kind).toBe(kind !== 'heat')
    }
    const r = NOCICEPTION.modalities.heat.response
    expect(Object.keys(r.anchors!).sort()).toEqual(['noSensation', 'noSensationRescaled', 'painScale', 'toleranceRamp'])
    expect(r.anchors![r.defaultAnchor!]).toBeDefined()
    expect(r.anchorNote!.zh.length).toBeGreaterThan(20)
    expect(r.anchorNote!.en.length).toBeGreaterThan(20)
    // 每种取法都写明出处实际测了什么 / every reading states what its source actually measured
    for (const [id, q] of Object.entries(r.anchors!)) {
      expect(q.source, id).toBeDefined()
      expect(q.note!.en, id).toMatch(/^Measured|^Derived/)
      expect(responseGain(NOCICEPTION.modalities.heat, id).quantity).toBe(q)
    }
    expect(() => responseGain(NOCICEPTION.modalities.heat, 'nonsense')).toThrow()
    // 逃离时间是假设 / the escape time is an assumption
    expect(REFLEX.escape.assumption).toBe(true)
    expect(REFLEX.escape.value).toBeGreaterThan(0)
  })

  it('keeps the fibre velocities inside their sourced ranges and Aδ faster than C', () => {
    const { Adelta, C } = NOCICEPTION.fibres
    expect(Adelta.velocity.value).toBeGreaterThanOrEqual(Adelta.velocityRange.value[0])
    expect(Adelta.velocity.value).toBeLessThanOrEqual(Adelta.velocityRange.value[1])
    expect(C.velocity.value).toBeGreaterThanOrEqual(C.velocityRange.value[0])
    expect(C.velocity.value).toBeLessThanOrEqual(C.velocityRange.value[1])
    expect(Adelta.velocity.value).toBeGreaterThan(C.velocity.value)
  })
})
