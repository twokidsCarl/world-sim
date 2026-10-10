// Joins BodyParts3D concepts with what Wikidata knows about them.
import { ancestors, descendants, loadConcepts, loadDataset, loadElementConcepts, loadTree, type Bp3dConcept, type Dataset, type Tree } from './bp3d.ts'
import { loadT2S } from './hanzi.ts'
import type { FetchOptions } from './sparql.ts'
import {
  fetchAllFmaItems, fetchAllFmaLabels, fetchExtras, fetchItemsByUberon, fetchLabels, fetchStatements,
  type FmaItem, type ItemExtras, type Labels, type Statement,
} from './wikidata.ts'

export interface ZhLabel {
  text: string
  /** Label language on Wikidata the text was taken from. */
  lang: string
  /** True when the label had to be converted from Traditional characters. */
  converted: boolean
}

export interface Model {
  concepts: Map<string, Bp3dConcept>
  elementConcepts: Set<string>
  dataset: Dataset
  elementStats: { files: number; fromHeader: number; fromFallback: number; unresolved: number }
  isa: Tree
  /** Concepts that are muscles or named parts of muscles in the BodyParts3D is-a tree. */
  muscleLike: Set<string>
  /** FMA id -> Wikidata items carrying it. */
  itemsByFma: Map<string, FmaItem[]>
  fmaByItem: Map<string, string[]>
  /** The item we attach to a BodyParts3D concept (best-labelled, then lowest QID). */
  primaryItem: Map<string, string>
  labels: Map<string, Labels>
  extras: Map<string, ItemExtras>
  /** FMA item ("human heart") -> species-neutral item without an FMA id ("heart"). */
  twinOf: Map<string, string>
  /** Reverse of twinOf. */
  twinFor: Map<string, string>
  statements: Statement[]
  /** lower-case English name -> FMA ids (BodyParts3D names, Wikidata labels, twin labels). */
  fmaByName: Map<string, Set<string>>
  t2s: (s: string) => string
  zhOf(qid: string): ZhLabel | undefined
  enOf(qid: string): string | undefined
  rejectedZh: Map<string, string>
  /**
   * For a lateralised concept, the FMA id(s) of its unlateralised class according to Wikidata:
   * the single FMA-bearing P279 superclass of its item ("left temporalis" -> "temporal muscle").
   * Catches cases where the English names differ too much for a name match.
   */
  unsidedOf(fma: string): string[]
  /** Concept ids ("UBERON_...") whose Wikidata item was found through the UBERON ID property. */
  viaUberon: Set<string>
}

const ZH_PRIORITY = ['zh-cn', 'zh-hans', 'zh-sg', 'zh-my', 'zh', 'zh-hant', 'zh-tw', 'zh-hk', 'zh-mo']
const qnum = (q: string) => Number(q.slice(1))

export const SIDE_RE = /\b(left|right)\b/
export function sideOf(name: string): 'left' | 'right' | undefined {
  const m = name.toLowerCase().match(/\b(left|right)\b/g)
  return m && m.length === 1 ? (m[0] as 'left' | 'right') : undefined
}
/**
 * Ids of the form "<base>_L" / "<base>_R": a side-qualified derivative that the dataset mints for
 * a lateralised part of a concept that has no sided class of its own (FMA, UBERON or synthetic).
 */
export function sidedDerivative(id: string): { base: string; side: 'left' | 'right' } | undefined {
  const m = /^(.+)_([LR])$/.exec(id)
  return m ? { base: m[1]!, side: m[2] === 'L' ? 'left' : 'right' } : undefined
}
/** Side of a concept: from a derivative id when it has one, else from its English name. */
export const sideOfConcept = (id: string, en: string) => sidedDerivative(id)?.side ?? sideOf(en)
export const stripSide = (name: string) => name.toLowerCase().replace(SIDE_RE, '').replace(/\s+/g, ' ').trim()

const TYPE_WORDS: [RegExp, RegExp][] = [
  [/\b(nerve|nerves)$/i, /神经/],
  [/\b(artery|arteries)$/i, /动脉|干|弓|支/],
  [/\b(vein|veins)$/i, /静脉/],
  [/\bmuscle$/i, /肌|筋/],
  [/\bligament$/i, /韧带|带/],
]
/** Cheap type check: an English "... nerve" must not be labelled as an artery, and so on. */
export function plausible(en: string | undefined, zh: string): boolean {
  if (!en) return true
  for (const [enRe, zhRe] of TYPE_WORDS) if (enRe.test(en) && !zhRe.test(zh)) return false
  return true
}

export async function buildModel(opts: FetchOptions): Promise<Model> {
  const concepts = loadConcepts()
  const el = loadElementConcepts()
  const isa = loadTree('isa')

  // Scope = BodyParts3D 4.0 lists ∪ whatever the generated datasets contain.
  const dataset = loadDataset()
  for (const [fma, en] of dataset.names) {
    if (!concepts.has(fma)) concepts.set(fma, { fma, en, inIsa: false, inPartOf: false, datasetOnly: true })
  }
  for (const [child, parent] of dataset.isaEdges) {
    const ps = isa.parents.get(child) ?? isa.parents.set(child, []).get(child)!
    if (ps.includes(parent)) continue
    ps.push(parent)
    ;(isa.children.get(parent) ?? isa.children.set(parent, []).get(parent)!).push(child)
  }
  for (const fmas of dataset.partFmas.values()) for (const f of fmas) el.concepts.add(f)
  const muscleLike = new Set<string>()
  for (const root of ['FMA5022', 'FMA85453', 'FMA10474']) {
    // muscle organ, head of muscle organ, zone of muscle organ
    for (const d of descendants(isa, root)) muscleLike.add(d)
  }

  const allItems = await fetchAllFmaItems(opts)
  const labels = await fetchAllFmaLabels(opts)
  const itemsByFma = new Map<string, FmaItem[]>()
  const fmaByItem = new Map<string, string[]>()
  const enByItem = new Map<string, string>()
  for (const it of allItems) {
    ;(itemsByFma.get(it.fma) ?? itemsByFma.set(it.fma, []).get(it.fma)!).push(it)
    ;(fmaByItem.get(it.qid) ?? fmaByItem.set(it.qid, []).get(it.qid)!).push(it.fma)
    if (it.en) enByItem.set(it.qid, it.en)
  }
  for (const v of fmaByItem.values()) v.sort()

  // Concepts with a synthetic "UBERON_<digits>" id are linked through Wikidata's UBERON ID.
  const viaUberon = new Set<string>()
  const uberonIds = [...new Set([...concepts.keys()].map((id) => /^(UBERON_\d+)(_[LR])?$/.exec(id)?.[1]).filter((x): x is string => !!x))]
  if (uberonIds.length) {
    const found = await fetchItemsByUberon(uberonIds.map((id) => id.slice(7)), opts)
    for (const f of found) {
      const id = `UBERON_${f.uberon}`
      ;(itemsByFma.get(id) ?? itemsByFma.set(id, []).get(id)!).push({ qid: f.qid, fma: id, en: f.en })
      const ids = fmaByItem.get(f.qid) ?? fmaByItem.set(f.qid, []).get(f.qid)!
      if (!ids.includes(id)) ids.push(id)
      if (f.en && !enByItem.has(f.qid)) enByItem.set(f.qid, f.en)
      viaUberon.add(id)
    }
    for (const [q, l] of await fetchLabels(found.map((f) => f.qid), opts)) labels.set(q, { ...l, ...labels.get(q) })
  }

  const t2s = await loadT2S(opts)

  const enOf = (qid: string) => enByItem.get(qid) ?? labels.get(qid)?.en
  /** Wikidata zh labels whose structure type contradicts the English label (e.g. a nerve labelled 动脉). */
  const rejectedZh = new Map<string, string>()
  const zhOf = (qid: string): ZhLabel | undefined => {
    const l = labels.get(qid)
    if (!l) return undefined
    for (const lang of ZH_PRIORITY) {
      const raw = l[lang]
      if (!raw) continue
      // drop parenthesised Latin/English glosses; reject labels that are not Chinese at all
      const cleaned = raw.replace(/\s*[(（][\x20-\x7e]*[)）]\s*/g, '').trim()
      if (!/[\u3400-\u9fff\u{20000}-\u{2ffff}]/u.test(cleaned) || /[\u3040-\u30ff]/.test(cleaned)) continue
      const text = t2s(cleaned)
      if (text && !plausible(enOf(qid), text)) {
        rejectedZh.set(qid, `${enOf(qid)} = ${text}`)
        return undefined
      }
      if (text) return { text, lang, converted: text !== cleaned }
    }
    return undefined
  }
  // Items of BodyParts3D concepts, plus every "human X" FMA item (candidates for a generic twin).
  const bpItems = [...concepts.keys()].flatMap((f) => (itemsByFma.get(f) ?? []).map((i) => i.qid))
  const humanItems = allItems.filter((i) => /^human /i.test(i.en ?? '')).map((i) => i.qid)
  const extras = await fetchExtras([...bpItems, ...humanItems], opts)

  const statements = await fetchStatements(bpItems, opts)

  // Labels for items that have no FMA id: statement endpoints and candidate twins.
  const extraLabelIds = new Set<string>()
  for (const s of statements) for (const q of [s.subject, s.object]) if (!fmaByItem.has(q)) extraLabelIds.add(q)
  for (const q of humanItems) for (const sup of extras.get(q)?.superclasses ?? []) if (!fmaByItem.has(sup)) extraLabelIds.add(sup)
  for (const [q, l] of await fetchLabels([...extraLabelIds], opts)) labels.set(q, { ...l, ...labels.get(q) })

  // Twin rule (strict): FMA item labelled "human [musculus] X" whose P279 superclass has no FMA id
  // and is labelled exactly "X" (or "X muscle").
  const twinOf = new Map<string, string>()
  const twinFor = new Map<string, string>()
  for (const q of humanItems) {
    const en = enByItem.get(q)!.toLowerCase()
    const bare = en.replace(/^human (musculus )?/, '')
    for (const sup of extras.get(q)?.superclasses ?? []) {
      if (fmaByItem.has(sup)) continue
      const supEn = labels.get(sup)?.en?.toLowerCase()
      if (supEn && (supEn === bare || supEn === `${bare} muscle`) && !twinFor.has(sup)) {
        twinOf.set(q, sup)
        twinFor.set(sup, q)
        break
      }
    }
  }

  const primaryItem = new Map<string, string>()
  for (const fma of concepts.keys()) {
    const cands = itemsByFma.get(fma)
    if (!cands?.length) continue
    const score = (q: string) => (zhOf(q) ? 2 : 0) + (labels.has(q) ? 1 : 0)
    const best = [...cands].sort((a, b) => score(b.qid) - score(a.qid) || qnum(a.qid) - qnum(b.qid))[0]!
    primaryItem.set(fma, best.qid)
  }

  const fmaByName = new Map<string, Set<string>>()
  const addName = (name: string | undefined, fma: string) => {
    if (!name) return
    const k = name.toLowerCase().replace(/\s+/g, ' ').trim()
    ;(fmaByName.get(k) ?? fmaByName.set(k, new Set()).get(k)!).add(fma)
  }
  for (const c of concepts.values()) addName(c.en, c.fma)
  for (const it of allItems) {
    addName(it.en, it.fma)
    // FMA says "deltoid", Wikidata says "deltoid muscle" / "musculus deltoideus"
    const short = it.en?.replace(/ muscle$/i, '')
    if (short && short !== it.en && !short.includes(' of ')) addName(short, it.fma)
  }
  for (const [q, twin] of twinOf) for (const f of fmaByItem.get(q) ?? []) addName(labels.get(twin)?.en, f)

  const unsidedOf = (fma: string): string[] => {
    const c = concepts.get(fma)
    const q = primaryItem.get(fma)
    if (!c || !q || !sideOf(c.en)) return []
    const sups = (extras.get(q)?.superclasses ?? []).filter((s) => fmaByItem.has(s))
    if (sups.length !== 1 || sideOf(enOf(sups[0]!) ?? '')) return []
    return fmaByItem.get(sups[0]!)!.filter((f) => f !== fma)
  }

  return {
    unsidedOf, viaUberon,
    concepts, elementConcepts: el.concepts, dataset,
    elementStats: { files: el.fromHeader + el.fromFallback + el.unresolved, fromHeader: el.fromHeader, fromFallback: el.fromFallback, unresolved: el.unresolved },
    isa, muscleLike, itemsByFma, fmaByItem, primaryItem, labels, extras, twinOf, twinFor, statements, fmaByName, t2s, zhOf, enOf, rejectedZh,
  }
}

export { ancestors }
