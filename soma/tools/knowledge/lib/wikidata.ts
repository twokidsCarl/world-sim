// Everything we take from Wikidata (CC0). Property ids were verified against the live
// endpoint on 2026-10-11 (label + description of each property; see PROPS below).
import { chunk, sparql, type FetchOptions, type Row } from './sparql.ts'
import type { RelationKind } from '../../../src/anatomy/types.ts'

/** Verified: P1402 "Foundational Model of Anatomy ID" — values are bare digits, no "FMA" prefix. */
export const P_FMA = 'P1402'
/** Verified: P1323 "Terminologia Anatomica 98 ID", P3982 "TA98 Latin term", P1554 "UBERON ID". */
export const P_TA98 = 'P1323'
export const P_TA98_LATIN = 'P3982'
export const P_UBERON = 'P1554'

/** Verified relation properties (id -> English label on Wikidata). */
export const RELATION_PROPS: Record<string, { kind: RelationKind; label: string }> = {
  P3490: { kind: 'origin', label: 'muscle origin' },
  P3491: { kind: 'insertion', label: 'muscle insertion' },
  P3189: { kind: 'innervatedBy', label: 'innervated by' },
  P2286: { kind: 'arterialSupply', label: 'arterial supply' },
  P2289: { kind: 'venousDrainage', label: 'venous drainage' },
  P2288: { kind: 'lymphaticDrainage', label: 'lymphatic drainage' },
  P2789: { kind: 'connectsWith', label: 'connects with' },
  P2329: { kind: 'antagonist', label: 'antagonist muscle' },
}

/** Verified: P3190 "innervates" — "anatomical structures innervated by this nerve". Used only as the sourced inverse of P3189. */
export const P_INNERVATES = 'P3190'

export const LABEL_LANGS = ['en', 'la', 'ja', 'zh-cn', 'zh-hans', 'zh-sg', 'zh-my', 'zh', 'zh-hant', 'zh-tw', 'zh-hk', 'zh-mo']

export interface FmaItem {
  qid: string
  fma: string
  en?: string
}

const values = (ids: string[]) => ids.map((q) => `wd:${q}`).join(' ')

/** Every Wikidata item that carries an FMA id, with its English label (about 79k rows). */
export async function fetchAllFmaItems(opts: FetchOptions): Promise<FmaItem[]> {
  const out: FmaItem[] = []
  for (const d of '123456789') {
    const rows = await sparql(
      'fma-items',
      `SELECT ?item ?f ?en WHERE {
  ?item wdt:${P_FMA} ?f . FILTER(STRSTARTS(?f, "${d}"))
  OPTIONAL { ?item rdfs:label ?en . FILTER(LANG(?en) = "en") }
}`,
      opts,
    )
    for (const r of rows) if (/^\d+$/.test(r.f!)) out.push({ qid: r.item!, fma: `FMA${r.f}`, en: r.en })
  }
  return out
}

export type Labels = Record<string, string>

/** Labels in the languages we care about, for a set of items. */
export async function fetchLabels(qids: string[], opts: FetchOptions): Promise<Map<string, Labels>> {
  const out = new Map<string, Labels>()
  const langs = LABEL_LANGS.map((l) => `"${l}"`).join(', ')
  for (const batch of chunk([...new Set(qids)].sort(), 300)) {
    const rows = await sparql(
      'labels',
      `SELECT ?item ?l WHERE {
  VALUES ?item { ${values(batch)} }
  ?item rdfs:label ?l . FILTER(LANG(?l) IN (${langs}))
}`,
      opts,
    )
    for (const r of rows) {
      const m = out.get(r.item!) ?? out.set(r.item!, {}).get(r.item!)!
      m[r.lLang!] = r.l!
    }
  }
  return out
}

export interface ItemExtras {
  ta98: string[]
  ta98Latin: string[]
  uberon: string[]
  /** P279 superclasses (used to find the species-neutral twin of a "human X" item). */
  superclasses: string[]
}

export async function fetchExtras(qids: string[], opts: FetchOptions): Promise<Map<string, ItemExtras>> {
  const out = new Map<string, ItemExtras>()
  const get = (q: string) => out.get(q) ?? out.set(q, { ta98: [], ta98Latin: [], uberon: [], superclasses: [] }).get(q)!
  for (const batch of chunk([...new Set(qids)].sort(), 300)) {
    const rows = await sparql(
      'extras',
      `SELECT ?item ?p ?v WHERE {
  VALUES ?item { ${values(batch)} }
  VALUES ?p { wdt:${P_TA98} wdt:${P_TA98_LATIN} wdt:${P_UBERON} wdt:P279 }
  ?item ?p ?v .
}`,
      opts,
    )
    for (const r of rows) {
      const e = get(r.item!)
      const v = r.v!
      if (r.p === P_TA98) e.ta98.push(v)
      else if (r.p === P_TA98_LATIN) e.ta98Latin.push(v)
      else if (r.p === P_UBERON) e.uberon.push(v)
      else if (r.p === 'P279' && /^Q\d+$/.test(v)) e.superclasses.push(v)
    }
  }
  for (const e of out.values()) for (const k of ['ta98', 'ta98Latin', 'uberon', 'superclasses'] as const) e[k].sort()
  return out
}

export interface Statement {
  subject: string
  prop: string
  object: string
}

/**
 * Relation statements. The seven anatomy-specific properties are small enough to take whole;
 * P2789 "connects with" is dominated by transport/geography, so it is fetched per subject.
 */
export async function fetchStatements(connectSubjects: string[], opts: FetchOptions): Promise<Statement[]> {
  const out: Statement[] = []
  const push = (rows: Row[]) => {
    for (const r of rows) if (/^Q\d+$/.test(r.o!) && /^Q\d+$/.test(r.s!)) out.push({ subject: r.s!, prop: r.p!, object: r.o! })
  }
  for (const p of Object.keys(RELATION_PROPS)) {
    if (p === 'P2789') continue
    push(await sparql('statements', `SELECT ?s ?p ?o WHERE { VALUES ?p { wdt:${p} } ?s ?p ?o . }`, opts))
  }
  // P3190 "innervates" (verified live): the same fact as P3189, stated on the nerve item.
  push(await sparql('statements', `SELECT ?s ?p ?o WHERE { VALUES ?p { wdt:${P_INNERVATES} } ?s ?p ?o . }`, opts))
  for (const batch of chunk([...new Set(connectSubjects)].sort(), 300)) {
    push(
      await sparql(
        'statements',
        `SELECT ?s ?p ?o WHERE { VALUES ?s { ${values(batch)} } VALUES ?p { wdt:P2789 } ?s ?p ?o . }`,
        opts,
      ),
    )
  }
  out.sort((a, b) => (a.subject + a.prop + a.object < b.subject + b.prop + b.object ? -1 : 1))
  return out
}

/** Sanity check used by `run.ts --verify-props`: the live label of every property we rely on. */
export async function fetchPropertyLabels(opts: FetchOptions): Promise<Record<string, string>> {
  const ids = [P_FMA, P_TA98, P_TA98_LATIN, P_UBERON, P_INNERVATES, ...Object.keys(RELATION_PROPS)]
  const rows = await sparql(
    'props',
    `SELECT ?p ?l WHERE { VALUES ?p { ${values(ids)} } ?p rdfs:label ?l . FILTER(LANG(?l) = "en") }`,
    opts,
  )
  return Object.fromEntries(rows.map((r) => [r.p!, r.l!]))
}

/** Non-English labels (la, ja, zh variants) of every FMA-carrying item, keyed by QID. */
export async function fetchAllFmaLabels(opts: FetchOptions): Promise<Map<string, Labels>> {
  const out = new Map<string, Labels>()
  const langs = LABEL_LANGS.filter((l) => l !== 'en')
    .map((l) => `"${l}"`)
    .join(', ')
  for (const d of '123456789') {
    const rows = await sparql(
      'fma-labels',
      `SELECT ?item ?l WHERE {
  ?item wdt:${P_FMA} ?f . FILTER(STRSTARTS(?f, "${d}"))
  ?item rdfs:label ?l . FILTER(LANG(?l) IN (${langs}))
}`,
      opts,
    )
    for (const r of rows) {
      const m = out.get(r.item!) ?? out.set(r.item!, {}).get(r.item!)!
      m[r.lLang!] = r.l!
    }
  }
  return out
}
