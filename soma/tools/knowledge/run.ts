// Knowledge layer build: names.json + relations.json for the anatomy browser.
//
//   bun tools/knowledge/run.ts            regenerate from the on-disk cache (fetches only what is missing)
//   bun tools/knowledge/run.ts --refresh  re-query Wikidata / Wikipedia and overwrite the cache
//   bun tools/knowledge/run.ts --offline  fail instead of touching the network
//
// Inputs : data/raw/bodyparts3d/*  (read-only), tools/knowledge/lexicon/*
// Cache  : data/raw/knowledge/**   (gitignored raw responses)
// Outputs: data/curated/knowledge/{names,relations,report,muscle-gaps}.json
//          public/anatomy/knowledge/{names,relations}.json (copies)
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { NameEntry, Relation, RelationKind } from '../../src/anatomy/types.ts'
import { buildModel, sideOf, stripSide } from './lib/model.ts'
import { buildNames } from './lib/names.ts'
import { CURATED_DIR, PUBLIC_DIR } from './lib/paths.ts'
import { buildRelations, MAX_ISA_FANOUT, type BuiltRelation, type Via } from './lib/relations.ts'
import { stats } from './lib/sparql.ts'
import { fetchPropertyLabels, P_FMA, P_TA98, P_TA98_LATIN, P_UBERON, RELATION_PROPS } from './lib/wikidata.ts'
import { buildWikipediaFill } from './lib/wikipedia.ts'

const opts = { refresh: process.argv.includes('--refresh'), offline: process.argv.includes('--offline') }

const KINDS: RelationKind[] = ['origin', 'insertion', 'innervatedBy', 'arterialSupply', 'venousDrainage', 'lymphaticDrainage', 'connectsWith', 'antagonist']
const pct = (n: number, d: number) => `${n}/${d} (${d ? ((100 * n) / d).toFixed(1) : '0'}%)`

function linesJson(entries: [string, unknown][] | unknown[], isObject: boolean): string {
  if (isObject) {
    const rows = (entries as [string, unknown][]).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    return `{\n${rows.join(',\n')}\n}\n`
  }
  return `[\n${(entries as unknown[]).map((v) => JSON.stringify(v)).join(',\n')}\n]\n`
}

async function main() {
  // 1. property ids are checked against the live labels (cached) so a silent re-purposing is caught
  const propLabels = await fetchPropertyLabels(opts)
  const expected: Record<string, string> = {
    [P_FMA]: 'Foundational Model of Anatomy ID', [P_TA98]: 'Terminologia Anatomica 98 ID',
    [P_TA98_LATIN]: 'TA98 Latin term', [P_UBERON]: 'UBERON ID',
    ...Object.fromEntries(Object.entries(RELATION_PROPS).map(([p, d]) => [p, d.label])),
  }
  for (const [p, label] of Object.entries(expected)) {
    if (propLabels[p] !== label) throw new Error(`Wikidata property ${p} is labelled "${propLabels[p]}", expected "${label}"`)
  }

  const m = await buildModel(opts)
  const { names, disagreements } = buildNames(m)
  const wd = buildRelations(m, names)
  const wp = await buildWikipediaFill(m, names, wd.relations, opts)
  const built: BuiltRelation[] = [...wd.relations, ...wp.relations]
  const subjectOrder = new Map([...m.concepts.keys()].map((f) => [f, Number(f.slice(3))]))
  built.sort((a, b) => subjectOrder.get(a.subject)! - subjectOrder.get(b.subject)! || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind))
  const relations: Relation[] = built.map(({ via: _via, ...r }) => r)

  // ---- coverage -------------------------------------------------------------------------
  const scopes = { allConcepts: [...m.concepts.keys()], elementConcepts: [...m.elementConcepts].filter((f) => m.concepts.has(f)) }
  const coverage: Record<string, unknown> = {}
  for (const [scope, ids] of Object.entries(scopes)) {
    const set = new Set(ids)
    const e = ids.map((f) => names[f]!)
    const bySource: Record<string, number> = {}
    for (const x of e) bySource[x.zhSource ?? 'none'] = (bySource[x.zhSource ?? 'none'] ?? 0) + 1
    const rel = built.filter((r) => set.has(r.subject))
    const kinds: Record<string, Record<string, number>> = {}
    for (const k of KINDS) {
      const of = rel.filter((r) => r.kind === k)
      const row: Record<string, number> = { total: of.length, direct: 0, 'is-a': 0, laterality: 0, whole: 0, wikipedia: 0 }
      for (const r of of) row[r.via]!++
      row.subjects = new Set(of.map((r) => r.subject)).size
      row.objectHasFma = of.filter((r) => r.object).length
      row.objectInBodyParts3D = of.filter((r) => r.object && m.concepts.has(r.object)).length
      row.objectIsElement = of.filter((r) => r.object && m.elementConcepts.has(r.object)).length
      kinds[k] = row
    }
    const wdZh = e.filter((x) => x.zhSource?.startsWith('wikidata')).length
    coverage[scope] = {
      concepts: ids.length,
      wikidataMatch: pct(e.filter((x) => x.wikidata).length, ids.length),
      zhFromWikidataOwnItem: pct(wdZh, ids.length),
      zhAny: pct(e.filter((x) => x.zh).length, ids.length),
      la: pct(e.filter((x) => x.la).length, ids.length),
      ja: pct(e.filter((x) => x.ja).length, ids.length),
      zhBySource: bySource,
      relations: {
        total: rel.length,
        subjectsWithAnyRelation: pct(new Set(rel.map((r) => r.subject)).size, ids.length),
        objectHasFma: pct(rel.filter((r) => r.object).length, rel.length),
        objectInBodyParts3D: pct(rel.filter((r) => r.object && m.concepts.has(r.object)).length, rel.length),
        objectLabelHasZh: pct(rel.filter((r) => r.objectLabel.zh).length, rel.length),
        byKind: kinds,
      },
    }
  }

  // ---- muscle gap list ------------------------------------------------------------------
  const NEED: RelationKind[] = ['origin', 'insertion', 'innervatedBy']
  const bySubject = new Map<string, BuiltRelation[]>()
  for (const r of built) (bySubject.get(r.subject) ?? bySubject.set(r.subject, []).get(r.subject)!).push(r)
  const wholeRe = /^(?:.+ )?(?:head|part|belly) of (.+)$/
  const muscles = scopes.elementConcepts.filter((f) => m.muscleLike.has(f))
  const groups = new Map<string, { name: string; fma: string[]; missing: RelationKind[]; wholeMuscleOnly: RelationKind[]; wholeMuscle?: string }>()
  let complete = 0
  for (const f of muscles) {
    const rels = bySubject.get(f) ?? []
    const missing = NEED.filter((k) => !rels.some((r) => r.kind === k))
    const wholeOnly = (['origin', 'insertion'] as RelationKind[]).filter((k) => rels.some((r) => r.kind === k) && rels.filter((r) => r.kind === k).every((r) => r.via === 'whole'))
    if (!missing.length && !wholeOnly.length) {
      complete++
      continue
    }
    const name = stripSide(m.concepts.get(f)!.en)
    const g = groups.get(name) ?? { name, fma: [], missing, wholeMuscleOnly: wholeOnly, wholeMuscle: wholeRe.exec(name)?.[1] }
    g.fma.push(f)
    groups.set(name, g)
  }
  const gapList = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
  const gaps = {
    note: 'Element-level muscles (and named muscle parts) of BodyParts3D that lack an origin, insertion or innervation after the Wikidata and Wikipedia passes. "wholeMuscleOnly" kinds exist only as statements about the whole muscle and still need a part-specific source. Candidates: OpenStax Anatomy & Physiology (CC BY 4.0), Gray\'s Anatomy 1918 (public domain), Wikipedia (CC BY-SA 4.0).',
    muscleElementConcepts: muscles.length,
    complete,
    withGaps: muscles.length - complete,
    unlateralisedGroups: gapList.length,
    missingCounts: Object.fromEntries(NEED.map((k) => [k, gapList.filter((g) => g.missing.includes(k)).reduce((n, g) => n + g.fma.length, 0)])),
    muscles: gapList,
  }

  const report = {
    note: 'Generated by tools/knowledge/run.ts. Every zh name and every relation is unreviewed.',
    wikidataProperties: propLabels,
    fmaIdFormatOnWikidata: 'bare digits (format constraint [1-9][0-9]{3,5}); "FMA" is prepended here',
    twins: [...m.twinOf].filter(([q]) => (m.fmaByItem.get(q) ?? []).some((f) => m.concepts.has(f))).map(([q, t]) => ({ item: q, en: m.enOf(q), twin: t, twinEn: m.enOf(t) })),
    elementConcepts: { ...m.elementStats, distinctConcepts: m.elementConcepts.size },
    propagation: { maxIsaFanout: MAX_ISA_FANOUT, dropped: wd.dropped, droppedExamples: wd.droppedExamples },
    coverage,
    wikipedia: wp.report,
    muscleGaps: { muscleElementConcepts: gaps.muscleElementConcepts, complete: gaps.complete, withGaps: gaps.withGaps, unlateralisedGroups: gaps.unlateralisedGroups, missingCounts: gaps.missingCounts },
    zhRejectedWikidataLabels: { note: 'Wikidata zh labels discarded because their structure type contradicts the English label.', items: [...m.rejectedZh.values()].sort() },
    zhWikidataVsLexicon: {
      note: 'Wikidata zh labels kept as-is although the project lexicon renders the term differently (often regional or colloquial wording). For a reviewer.',
      count: disagreements.length,
      items: disagreements,
    },
  }

  mkdirSync(CURATED_DIR, { recursive: true })
  mkdirSync(PUBLIC_DIR, { recursive: true })
  const namesText = linesJson(Object.entries(names) as [string, NameEntry][], true)
  const relText = linesJson(relations, false)
  writeFileSync(resolve(CURATED_DIR, 'names.json'), namesText)
  writeFileSync(resolve(CURATED_DIR, 'relations.json'), relText)
  writeFileSync(resolve(CURATED_DIR, 'report.json'), `${JSON.stringify(report, null, 1)}\n`)
  writeFileSync(resolve(CURATED_DIR, 'muscle-gaps.json'), `${JSON.stringify(gaps, null, 1)}\n`)
  writeFileSync(resolve(PUBLIC_DIR, 'names.json'), namesText)
  writeFileSync(resolve(PUBLIC_DIR, 'relations.json'), relText)

  const viaCount: Record<string, number> = {}
  for (const r of built) viaCount[r.via as Via] = (viaCount[r.via] ?? 0) + 1
  console.log(`names: ${Object.keys(names).length}  relations: ${relations.length}`, viaCount)
  console.log(`muscle gaps: ${gaps.withGaps}/${gaps.muscleElementConcepts} element muscles in ${gaps.unlateralisedGroups} groups`)
  console.log(`cache hits: ${stats.cacheHits}  network requests: ${stats.networkRequests}`)
  console.log(`wrote ${CURATED_DIR} and ${PUBLIC_DIR}`)
}

await main()
