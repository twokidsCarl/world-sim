// 交叉核对：用第二个公开来源独立检验名称和关系。只记录一致 / 不一致 / 无第二来源，从不改写数据。
// 名称：Wikidata 中文标签、中文维基百科条目标题（经站间链接）。
// 关系：英文维基百科 {{Infobox muscle}} 的字段、Z-Anatomy 附着面所在的骨。
//
// Cross-checks: test names and relations against a second, independently published open source.
// Only agreement / disagreement / "no second source" is recorded; nothing is ever rewritten.
// Names: the Wikidata zh label and the Chinese Wikipedia article title (via sitelinks).
// Relations: fields of English Wikipedia's {{Infobox muscle}}, and the bone a Z-Anatomy
// attachment patch lies on.
import { existsSync, readFileSync } from 'node:fs'
import type { NameEntry } from '../../../src/anatomy/types.ts'
import { ZANATOMY_REJECTS } from '../lexicon/zanatomy-rejects.ts'
import { loadTree } from './bp3d.ts'
import { sideOfConcept, sidedDerivative, stripSide, type Model } from './model.ts'
import { ZANATOMY_ATTACHMENTS } from './paths.ts'
import type { BuiltRelation } from './relations.ts'
import { cachedGet, chunk, sparql, type FetchOptions } from './sparql.ts'
import { cleanWikitext, parseMuscleInfobox } from './wikipedia.ts'

export type Agreement = 'agree' | 'disagree' | 'none'

export interface NameCheck {
  result: Agreement
  /** 与最终名称不同来源的公开渲染 / open renderings from sources other than the name's own origin */
  wikidata?: string
  zhwiki?: string
  /** 项目词表的渲染（不是公开来源，仅作参考）/ the project lexicon's rendering (not an open source; context only) */
  lexicon?: string
  /** 不分侧结构在英文维基百科有条目：粗略表示“常教的结构” / the unsided structure has an enwiki article: a rough "commonly taught" signal */
  enwiki?: string
}

export interface RelationCheck {
  result: Agreement
  /** 用于核对的来源和它所说的内容 / which source was compared and what it says */
  against?: string
  theirValue?: string
}

export interface Sitelinks { en?: string; zh?: string }

/** 不分侧的基础概念（若在数据集中）/ the unsided base concept, when the dataset has one */
export function baseConceptOf(m: Model, id: string): string | undefined {
  const c = m.concepts.get(id)
  if (!c) return undefined
  const d = sidedDerivative(id)
  if (d) return m.concepts.has(d.base) ? d.base : undefined
  if (!sideOfConcept(id, c.en)) return undefined
  for (const f of m.unsidedOf(id)) if (m.concepts.has(f)) return f
  const hits = [...(m.fmaByName.get(stripSide(c.en)) ?? [])].filter((f) => f !== id && m.concepts.has(f))
  return hits.length === 1 ? hits[0] : undefined
}

/** 概念对应条目（及孪生条目）的英文 / 中文维基百科标题。enwiki / zhwiki titles of the concepts' items (and twins). */
export async function fetchSitelinks(m: Model, opts: FetchOptions): Promise<Map<string, Sitelinks>> {
  const qids = new Set<string>()
  for (const id of m.concepts.keys()) {
    for (const it of m.itemsByFma.get(id) ?? []) {
      qids.add(it.qid)
      const twin = m.twinOf.get(it.qid)
      if (twin) qids.add(twin)
    }
    for (const f of m.unsidedOf(id)) for (const it of m.itemsByFma.get(f) ?? []) qids.add(it.qid)
  }
  const out = new Map<string, Sitelinks>()
  for (const batch of chunk([...qids].sort(), 100)) {
    const rows = await sparql(
      'sitelinks-en-zh',
      `SELECT ?item ?site ?title WHERE {
  VALUES ?item { ${batch.map((q) => `wd:${q}`).join(' ')} }
  VALUES ?site { <https://en.wikipedia.org/> <https://zh.wikipedia.org/> }
  ?article schema:about ?item ; schema:isPartOf ?site ; schema:name ?title .
}`,
      opts,
    )
    for (const r of rows) {
      const e = out.get(r.item!) ?? out.set(r.item!, {}).get(r.item!)!
      if (r.site!.includes('zh.wikipedia')) e.zh = r.title
      else e.en = r.title
    }
  }
  return out
}

const stripDisambiguation = (s: string) => s.replace(/\s*[(（][^)）]*[)）]\s*$/, '').trim()

export function checkNames(
  m: Model, names: Record<string, NameEntry>, evidence: Record<string, { lexicon?: string; wikidata?: string }>, sitelinks: Map<string, Sitelinks>,
): Map<string, NameCheck> {
  const linksOf = (id: string): Sitelinks => {
    const out: Sitelinks = {}
    for (const it of m.itemsByFma.get(id) ?? []) {
      for (const q of [it.qid, m.twinOf.get(it.qid)]) {
        const l = q ? sitelinks.get(q) : undefined
        if (l?.zh && !out.zh) out.zh = l.zh
        if (l?.en && !out.en) out.en = l.en
      }
    }
    return out
  }
  const out = new Map<string, NameCheck>()
  for (const [id, entry] of Object.entries(names)) {
    const c = m.concepts.get(id)
    if (!c || !entry.zh) continue
    const side = sideOfConcept(id, c.en)
    const mark = side === 'left' ? '左' : side === 'right' ? '右' : ''
    const base = baseConceptOf(m, id) ?? [...m.unsidedOf(id)][0]
    const own = linksOf(id)
    const baseLinks = base ? linksOf(base) : {}
    const zhTitle = own.zh ? m.t2s(stripDisambiguation(own.zh)) : baseLinks.zh ? mark + m.t2s(stripDisambiguation(baseLinks.zh)) : undefined
    const ev = evidence[id] ?? {}
    const check: NameCheck = { result: 'none' }
    if (ev.lexicon) check.lexicon = ev.lexicon
    const en = own.en ?? baseLinks.en
    if (en) check.enwiki = en
    // 名称自己的来源不能再当第二来源 / a name's own origin cannot serve as its second source
    const fromWikidata = entry.zhSource === 'wikidata' || entry.zhSource === 'wikidata:hant-converted' || entry.zhSource === 'wikidata:generic-twin' || entry.zhSource === 'wikidata:via-uberon-id' || entry.zhSource === 'derived:laterality'
    const others: string[] = []
    if (ev.wikidata) {
      check.wikidata = ev.wikidata
      if (!fromWikidata) others.push(ev.wikidata)
    }
    if (zhTitle) {
      check.zhwiki = zhTitle
      others.push(zhTitle)
    }
    if (others.length) check.result = others.includes(entry.zh) ? 'agree' : 'disagree'
    out.set(id, check)
  }
  return out
}

// ---- 关系 / relations --------------------------------------------------------------------------

const INFOBOX_FIELD: Record<string, string> = { origin: 'origin', insertion: 'insertion', innervatedBy: 'nerve', arterialSupply: 'blood', antagonist: 'antagonist' }
const PART_RE = /^(?:.+ )?(?:head|part|belly) of (.+)$/

interface Infobox { title: string; fields: Record<string, string> }

/** 数据集中所有肌（不分侧名称）对应的英文维基百科信息框。Infoboxes for every muscle of the dataset, by unsided name. */
export async function fetchMuscleInfoboxes(m: Model, sitelinks: Map<string, Sitelinks>, opts: FetchOptions): Promise<Map<string, Infobox>> {
  const titleByName = new Map<string, string>()
  for (const id of m.muscleLike) {
    const c = m.concepts.get(id)
    if (!c) continue
    const bare = stripSide(c.en).replace(/ muscle$/, '')
    for (const name of [bare, PART_RE.exec(bare)?.[1]]) {
      if (!name || titleByName.has(name)) continue
      const fmas = new Set([...(m.fmaByName.get(name) ?? []), ...(name === bare ? m.unsidedOf(id) : [])])
      for (const f of fmas) {
        for (const it of m.itemsByFma.get(f) ?? []) {
          const t = sitelinks.get(it.qid)?.en ?? (m.twinOf.get(it.qid) && sitelinks.get(m.twinOf.get(it.qid)!)?.en)
          if (t && !titleByName.has(name)) titleByName.set(name, t)
        }
      }
    }
  }
  const pages = new Map<string, string>()
  for (const batch of chunk([...new Set(titleByName.values())].sort(), 20)) {
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=ids%7Ccontent&rvslots=main&format=json&formatversion=2&titles=${batch.map(encodeURIComponent).join('%7C')}`
    const json = JSON.parse(await cachedGet('wikipedia', url, opts)) as {
      query: { pages: { title: string; revisions?: { slots: { main: { content: string } } }[] }[] }
    }
    for (const p of json.query.pages) if (p.revisions?.[0]) pages.set(p.title, p.revisions[0].slots.main.content)
  }
  const out = new Map<string, Infobox>()
  for (const [name, title] of titleByName) {
    const text = pages.get(title)
    const box = text && parseMuscleInfobox(text)
    if (!box) continue
    const fields: Record<string, string> = {}
    for (const f of new Set(Object.values(INFOBOX_FIELD))) {
      const cleaned = box[f] && cleanWikitext(box[f]!)
      if (cleaned) fields[f] = [cleaned.text, ...cleaned.links].join(' | ').toLowerCase()
    }
    out.set(name, { title, fields })
  }
  return out
}

/** 每块肌、每种附着所在骨的集合（Z-Anatomy，已剔除被否决的面片）。Bones per muscle and kind from Z-Anatomy patches (rejected ones removed). */
function zanatomyBones(m: Model): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  if (!existsSync(ZANATOMY_ATTACHMENTS)) return out
  const patches = (JSON.parse(readFileSync(ZANATOMY_ATTACHMENTS, 'utf8')) as {
    attachments: { muscle: string; kind: string; muscleFma: string | null; onBone: boolean; bones: { name: string; fma: string | null; share: number }[] }[]
  }).attachments
  for (const p of patches) {
    if (!p.muscleFma || !p.onBone) continue
    const muscle = p.muscle.toLowerCase().replace(/[()]/g, '').trim()
    const bones = p.bones.filter((b) => b.share >= 0.25 && b.fma)
    if (ZANATOMY_REJECTS.some((r) => r.muscle === muscle && r.kind === p.kind && (!r.bone || bones.some((b) => b.name.toLowerCase().includes(r.bone!))))) continue
    const k = `${p.muscleFma}|${p.kind}`
    const s = out.get(k) ?? out.set(k, new Set()).get(k)!
    for (const b of bones) if (m.concepts.has(b.fma!)) s.add(b.fma!)
  }
  return out
}

const GENERIC_WORDS = new Set(['of', 'and', 'to', 'nerve', 'nerves', 'muscle', 'muscles', 'artery', 'arteries', 'branch', 'branches', 'set', 'bone'])
const core = (label: string) => stripSide(label).replace(/ (muscle|muscles)$/, '').replace(/^set of /, '').trim()

export function checkRelations(m: Model, relations: BuiltRelation[], infoboxes: Map<string, Infobox>): RelationCheck[] {
  const zBones = zanatomyBones(m)
  const partOf = loadTree('partof')
  for (const [child, parent] of m.dataset.partOfEdges) {
    const ps = partOf.parents.get(child) ?? partOf.parents.set(child, []).get(child)!
    if (!ps.includes(parent)) ps.push(parent)
  }
  const wholes = (id: string): Set<string> => {
    const seen = new Set<string>([id])
    const stack = [id]
    while (stack.length) {
      const n = stack.pop()!
      for (const p of [...(partOf.parents.get(n) ?? []), ...(m.isa.parents.get(n) ?? [])]) if (!seen.has(p)) { seen.add(p); stack.push(p) }
    }
    return seen
  }
  const infoboxFor = (conceptId: string): Infobox | undefined => {
    const c = m.concepts.get(conceptId)
    if (!c) return undefined
    const bare = stripSide(c.en).replace(/ muscle$/, '')
    return infoboxes.get(bare) ?? (PART_RE.exec(bare)?.[1] ? infoboxes.get(PART_RE.exec(bare)![1]!) : undefined)
  }

  return relations.map((r): RelationCheck => {
    const fromWikipedia = r.source.name.startsWith('Wikipedia')
    const fromZ = r.source.name.startsWith('Z-Anatomy')
    // innervates：到被支配的肌的信息框里查神经 / innervates: look the nerve up in the innervated muscle's infobox
    const muscleId = r.kind === 'innervates' ? r.object : r.subject
    const field = r.kind === 'innervates' ? 'nerve' : INFOBOX_FIELD[r.kind]
    const otherLabel = r.kind === 'innervates' ? m.concepts.get(r.subject)?.en ?? '' : r.objectLabel.en

    // (1) Z-Anatomy 的骨 对 Wikidata 的附着点 / Z-Anatomy bone versus a Wikidata attachment
    if (!fromZ && (r.kind === 'origin' || r.kind === 'insertion') && r.object && m.concepts.has(r.object)) {
      const bones = zBones.get(`${r.subject}|${r.kind}`)
      if (bones?.size) {
        const w = wholes(r.object)
        if ([...bones].some((b) => w.has(b))) return { result: 'agree', against: 'Z-Anatomy attachment patch (bone)', theirValue: [...bones].map((b) => m.concepts.get(b)!.en).join('; ') }
      }
    }
    // (2) 英文维基百科信息框 / the enwiki infobox (not for relations that came from it)
    if (!fromWikipedia && field && muscleId) {
      const box = infoboxFor(muscleId)
      const text = box?.fields[field]
      if (box && text) {
        // 宽松匹配：去掉连字符、冠词和泛称后，目标名的实词都出现在信息框文字里即算一致。
        // 这是文字层面的比较：“不一致”只表示信息框没有用同样的词提到它，不等于有错。
        // Loose match: after dropping hyphens, articles and generic words, every content word of the
        // target must occur in the infobox text. This is a wording comparison: "disagree" means the
        // infobox does not mention the target in the same words, not that the statement is wrong.
        const norm = (x: string) => x.toLowerCase().replace(/-/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim()
        const hay = norm(text)
        const words = norm(core(otherLabel)).split(' ').filter((w) => w.length > 2 && !GENERIC_WORDS.has(w))
        const hit = words.length > 0 && words.every((w) => hay.includes(w))
        return { result: hit ? 'agree' : 'disagree', against: `Wikipedia "${box.title}" infobox, field ${field}`, theirValue: text.split(' | ')[0]!.slice(0, 160) }
      }
    }
    return { result: 'none' }
  })
}
