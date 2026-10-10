// Gap fill from English Wikipedia's {{Infobox muscle}} (CC BY-SA 4.0), for whole muscles that
// still lack an origin, insertion or innervation after the Wikidata pass.
//
// Rules, chosen so nothing is guessed:
//  - the article is the enwiki sitelink of the Wikidata item that carries the muscle's FMA id
//    (or of that item's species-neutral twin); no title search;
//  - named parts of muscles ("long head of ...") are skipped: the infobox describes the whole;
//  - one relation per infobox field, whose label is the field text with markup removed;
//  - the object FMA id is set only when the whole field is a single wikilink whose target is,
//    verbatim, the name of exactly one FMA concept;
//  - the source URL is the permalink of the revision that was read.
import type { NameEntry, RelationKind } from '../../../src/anatomy/types.ts'
import { stripSide, type Model } from './model.ts'
import type { BuiltRelation } from './relations.ts'
import { cachedGet, chunk, sparql, type FetchOptions } from './sparql.ts'

const FIELDS: Record<string, RelationKind> = { origin: 'origin', insertion: 'insertion', nerve: 'innervatedBy' }
const NEED: RelationKind[] = ['origin', 'insertion', 'innervatedBy']
const PART_RE = /^(?:.+ )?(?:head|part|belly) of (.+)$/

/** Top-level `| key = value` parameters of the first {{Infobox muscle ...}} in the wikitext. */
export function parseMuscleInfobox(wikitext: string): Record<string, string> | undefined {
  const start = wikitext.search(/\{\{\s*Infobox muscle/i)
  if (start < 0) return undefined
  let depth = 0
  let i = start
  const parts: string[] = []
  let cur = ''
  for (; i < wikitext.length; i++) {
    const two = wikitext.slice(i, i + 2)
    if (two === '{{' || two === '[[') {
      depth++
      cur += two
      i++
    } else if (two === '}}' || two === ']]') {
      depth--
      if (depth === 0) break
      cur += two
      i++
    } else if (wikitext[i] === '|' && depth === 1) {
      parts.push(cur)
      cur = ''
    } else cur += wikitext[i]
  }
  parts.push(cur)
  const out: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq < 0) continue
    out[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim()
  }
  return out
}

/** Markup-free text of an infobox value, plus the wikilink targets it contained. */
export function cleanWikitext(value: string): { text: string; links: string[] } | undefined {
  let s = value
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
  s = s.replace(/<br\s*\/?>/gi, '; ').replace(/<\/?[a-z][^>]*>/gi, '')
  // simple pass-through templates; anything else makes the value unusable
  s = s.replace(/\{\{\s*(?:nowrap|small|nobr)\s*\|([^{}]*)\}\}/gi, '$1')
  s = s.replace(/\{\{\s*(?:citation needed|cn|clarify|efn)[^{}]*\}\}/gi, '')
  if (/\{\{|\}\}/.test(s)) return undefined
  const links: string[] = []
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_all, target: string, shown?: string) => {
    links.push(target.split('#')[0]!.trim())
    return shown ?? target
  })
  s = s.replace(/'{2,}/g, '').replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '–')
  s = s.replace(/^\s*[*#]+\s*/gm, '').replace(/\s*\n+\s*/g, '; ').replace(/\s+/g, ' ').replace(/(; )+/g, '; ').replace(/^[;,\s]+|[;,\s]+$/g, '')
  if (!s || s.length > 240 || /[[\]|{}<>]/.test(s)) return undefined
  return { text: s, links }
}

export async function buildWikipediaFill(
  m: Model, names: Record<string, NameEntry>, existing: BuiltRelation[], opts: FetchOptions,
): Promise<{ relations: BuiltRelation[]; report: Record<string, unknown> }> {
  const has = new Set(existing.map((r) => `${r.subject}|${r.kind}`))

  // unlateralised whole muscles (element level) with something missing
  const groups = new Map<string, string[]>()
  for (const f of m.elementConcepts) {
    if (!m.muscleLike.has(f) || !m.concepts.has(f)) continue
    const name = stripSide(m.concepts.get(f)!.en)
    if (PART_RE.test(name)) continue
    if (NEED.every((k) => has.has(`${f}|${k}`))) continue
    ;(groups.get(name) ?? groups.set(name, []).get(name)!).push(f)
  }

  // group -> Wikidata items of the FMA concept that bears exactly this name
  const itemsOf = new Map<string, string[]>()
  for (const name of groups.keys()) {
    const qids: string[] = []
    for (const fma of m.fmaByName.get(name) ?? []) {
      for (const it of m.itemsByFma.get(fma) ?? []) {
        qids.push(it.qid)
        const twin = m.twinOf.get(it.qid)
        if (twin) qids.push(twin)
      }
    }
    if (qids.length) itemsOf.set(name, qids)
  }

  const titleOf = new Map<string, string>()
  for (const batch of chunk([...new Set([...itemsOf.values()].flat())].sort(), 200)) {
    const rows = await sparql(
      'sitelinks',
      `SELECT ?item ?title WHERE {
  VALUES ?item { ${batch.map((q) => `wd:${q}`).join(' ')} }
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title .
}`,
      opts,
    )
    for (const r of rows) titleOf.set(r.item!, r.title!)
  }

  interface Page { title: string; revid: number; content: string }
  const pages = new Map<string, Page>()
  const titles = [...new Set([...titleOf.values()])].sort()
  for (const batch of chunk(titles, 20)) {
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=ids%7Ccontent&rvslots=main&format=json&formatversion=2&titles=${batch.map(encodeURIComponent).join('%7C')}`
    const json = JSON.parse(await cachedGet('wikipedia', url, opts)) as {
      query: { pages: { title: string; missing?: boolean; revisions?: { revid: number; slots: { main: { content: string } } }[] }[] }
    }
    for (const p of json.query.pages) {
      const rev = p.revisions?.[0]
      if (rev) pages.set(p.title, { title: p.title, revid: rev.revid, content: rev.slots.main.content })
    }
  }

  const relations: BuiltRelation[] = []
  const report = { groupsWithGaps: groups.size, withWikidataItem: itemsOf.size, withArticle: 0, withInfobox: 0, relationsAdded: 0, objectsResolved: 0, articles: [] as string[], noArticle: [] as string[] }
  for (const [name, fmas] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const title = (itemsOf.get(name) ?? []).map((q) => titleOf.get(q)).find(Boolean)
    const page = title && pages.get(title)
    if (!page) {
      report.noArticle.push(name)
      continue
    }
    report.withArticle++
    const box = parseMuscleInfobox(page.content)
    if (!box) continue
    report.withInfobox++
    let used = false
    for (const [field, kind] of Object.entries(FIELDS)) {
      const raw = box[field]
      const cleaned = raw ? cleanWikitext(raw) : undefined
      if (!cleaned) continue
      let object: string | undefined
      if (cleaned.links.length === 1 && cleaned.links[0]!.toLowerCase() === cleaned.text.toLowerCase()) {
        const hits = [...(m.fmaByName.get(cleaned.text.toLowerCase()) ?? [])]
        if (hits.length === 1) object = hits[0]
      }
      for (const subject of fmas.sort()) {
        if (has.has(`${subject}|${kind}`)) continue
        const zh = object ? (m.concepts.has(object) ? names[object]?.zh : (m.itemsByFma.get(object) ?? []).map((i) => m.zhOf(i.qid)?.text).find(Boolean)) : undefined
        relations.push({
          subject,
          kind,
          ...(object ? { object } : {}),
          objectLabel: { en: cleaned.text, ...(zh ? { zh } : {}) },
          source: {
            name: `Wikipedia "${page.title}" (Infobox muscle, field ${field}; article about the unlateralised muscle "${name}")`,
            url: `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(page.title.replace(/ /g, '_'))}&oldid=${page.revid}`,
            license: 'CC BY-SA 4.0',
          },
          status: 'unreviewed',
          via: 'wikipedia',
        })
        report.relationsAdded++
        if (object) report.objectsResolved++
        used = true
      }
    }
    if (used) report.articles.push(page.title)
  }
  return { relations, report }
}
