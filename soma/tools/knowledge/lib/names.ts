// names.json：每个概念一条 NameEntry，并记录每个中文名的来源。
// names.json: one NameEntry per concept, with the origin of every zh name recorded.
import type { NameEntry } from '../../../src/anatomy/types.ts'
import { compareIds, type Bp3dConcept } from './bp3d.ts'
import { KEEP_WIKIDATA_LABEL, ZH_ID_OVERRIDES, ZH_OVERRIDES } from '../lexicon/overrides.ts'
import { sideOf, sidedDerivative, stripSide, type Model } from './model.ts'
import { createTranslator } from './translate.ts'

/** NameEntry.zhSource 可能出现的取值 / Values that may appear in NameEntry.zhSource. */
export const ZH_SOURCES = [
  'wikidata', // zh-cn / zh-hans / zh label of the concept's own Wikidata item, already Simplified
  'wikidata:hant-converted', // own item's label, converted from Traditional characters
  'wikidata:via-uberon-id', // label of the item found through Wikidata's UBERON ID (concept id "UBERON_...")
  'wikidata:generic-twin', // label of the species-neutral item ("heart") for a "human heart" item
  'derived:laterality', // 左/右 + the Wikidata zh label of the unlateralised concept
  'lexicon:mainland-over-wikidata', // exact lexicon term used instead of a differently worded Wikidata label
  'machine-translation', // tools/knowledge lexicon + rules; not from any source
  'machine-translation:override', // hand-written replacement for a Wikidata label judged wrong
  'reviewer', // 审核者在 review-signoffs.json 中给出的改正名称 / a corrected name given by a reviewer in review-signoffs.json
] as const

export interface NamesResult {
  names: Record<string, NameEntry>
  /**
   * 保留的 Wikidata 中文标签（词表逐段组合的结果与之不同），供审核者参考。
   * Wikidata zh labels kept although the lexicon composes the name differently, for a reviewer.
   */
  disagreements: { fma: string; en: string; wikidata: string; lexicon: string; zhSource: string }[]
  /**
   * 按“大陆用语优先”策略被词表整词词条替换掉的 Wikidata 标签。
   * Wikidata labels replaced by an exact lexicon term under the mainland-wording policy.
   */
  replaced: { id: string; en: string; wikidata: string; lexicon: string }[]
  /**
   * 每个概念的两种独立渲染，供交叉核对：纯词表译名，以及 Wikidata 标签（分侧概念为 左/右 + 基础标签）。
   * Two independent renderings per concept for cross-checking: the pure-lexicon translation and
   * the Wikidata label (for a lateralised concept, 左/右 + the base label).
   */
  evidence: Record<string, { lexicon?: string; wikidata?: string }>
}

const LATIN_ABBREVIATIONS: Record<string, string> = {
  'm.': 'musculus', 'mm.': 'musculi', 'a.': 'arteria', 'aa.': 'arteriae', 'v.': 'vena', 'vv.': 'venae',
  'n.': 'nervus', 'nn.': 'nervi', 'lig.': 'ligamentum', 'ligg.': 'ligamenta', 'r.': 'ramus', 'rr.': 'rami',
}

/**
 * 第一个看起来是纯拉丁文的候选（Wikidata 的 "la" 标签有时混入其他语言）。
 * First candidate that looks like plain Latin (Wikidata "la" labels sometimes hold other languages).
 */
export function pickLatin(candidates: (string | undefined | false | null)[]): string | undefined {
  for (const raw of candidates) {
    if (!raw) continue
    const s = raw
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .trim()
      .split(/\s+/)
      .map((w) => LATIN_ABBREVIATIONS[w.toLowerCase()] ?? w)
      .join(' ')
    if (!/^[A-Za-zæœÆŒ][A-Za-zæœÆŒ0-9 ,-]*$/.test(s) || /\b(o|de|des|la|le|del|the|of)\b/i.test(s)) continue
    return s[0]!.toUpperCase() + s.slice(1)
  }
  return undefined
}

export function buildNames(m: Model): NamesResult {
  /**
   * 带多个 FMA id 的条目只为英文标签相符的那个概念命名。
   * An item with several FMA ids names only the concept its English label matches.
   */
  const itemFits = (qid: string, fma: string) => {
    const fmas = m.fmaByItem.get(qid) ?? []
    if (fmas.length < 2) return true
    const label = m.enOf(qid)?.toLowerCase()
    const nameOf = (f: string) => m.concepts.get(f)?.en.toLowerCase()
    if (nameOf(fma) === label) return true
    return !fmas.some((f) => f !== fma && nameOf(f) === label)
  }

  /**
   * 某个 FMA id 的 Wikidata 中文名（先用自身条目，再用不分物种的孪生条目）。
   * A Wikidata-sourced zh for an FMA id (own item, then generic twin).
   */
  const wikidataZh = (fma: string): { zh: string; source: string } | undefined => {
    const items = m.itemsByFma.get(fma) ?? []
    const primary = m.primaryItem.get(fma)
    const ordered = primary ? [primary, ...items.map((i) => i.qid).filter((q) => q !== primary)] : items.map((i) => i.qid)
    for (const q of ordered) {
      const z = itemFits(q, fma) ? m.zhOf(q) : undefined
      if (z) return { zh: z.text, source: m.viaUberon.has(fma) ? 'wikidata:via-uberon-id' : z.converted ? 'wikidata:hant-converted' : 'wikidata' }
    }
    for (const q of ordered) {
      const twin = m.twinOf.get(q)
      const z = twin && m.zhOf(twin)
      if (z) return { zh: z.text, source: 'wikidata:generic-twin' }
    }
    return undefined
  }

  const overridden = (fma: string) => {
    const c = m.concepts.get(fma)
    return c ? ZH_OVERRIDES[c.en.toLowerCase()] : undefined
  }

  const wikidataZhByName = (en: string): string | undefined => {
    if (ZH_OVERRIDES[en]) return ZH_OVERRIDES[en]!.zh
    for (const fma of [...(m.fmaByName.get(en) ?? [])].sort()) {
      if (overridden(fma)) continue
      const z = wikidataZh(fma)
      if (z) return z.zh
    }
    return undefined
  }

  const translator = createTranslator(wikidataZhByName)
  const lexiconOnly = createTranslator()

  const names: Record<string, NameEntry> = {}
  const disagreements: NamesResult['disagreements'] = []
  const replaced: NamesResult['replaced'] = []
  const evidence: NamesResult['evidence'] = {}

  const nameConcept = (c: Bp3dConcept): NameEntry => {
    const entry: NameEntry = { status: 'unreviewed' }
    // 条目同时带有另一个 FMA id 且以那个概念命名时，不算作本概念的条目
    // an item that also carries another FMA id and is named after that other concept is not ours
    const primary = m.primaryItem.get(c.fma)
    const qid = primary && itemFits(primary, c.fma) ? primary : undefined
    if (qid) entry.wikidata = qid

    // 拉丁名：条目的拉丁文标签，否则用 TA98 拉丁术语（展开缩写）。
    // Latin: the item's Latin label, else its TA98 Latin term (abbreviations expanded).
    if (qid) {
      const twin = m.twinOf.get(qid)
      const la = pickLatin([m.labels.get(qid)?.la, ...(m.extras.get(qid)?.ta98Latin ?? []), twin && m.labels.get(twin)?.la])
      if (la) entry.la = la
    }

    // 日文名：BodyParts3D 自带的汉字名（取第一个），否则用 Wikidata 标签。
    // Japanese: BodyParts3D's own kanji name (first alternative), else the Wikidata label.
    const ja = c.ja?.split(/[;|]/)[0]?.trim() || (qid && m.labels.get(qid)?.ja)
    if (ja) entry.ja = ja

    const own = wikidataZh(c.fma)
    const override = overridden(c.fma)
    const side = sideOf(c.en)
    const bare = stripSide(c.en)
    const zhSide = side === 'left' ? '左' : '右'
    const keepWikidata = KEEP_WIKIDATA_LABEL.has(bare)
    /** 分侧概念对应的不分侧概念的 Wikidata 标签 / Wikidata label of the unlateralised concept, for a lateralised one. */
    const baseLabel = (): string | undefined => {
      if (!side || ZH_OVERRIDES[bare]) return undefined
      for (const fma of new Set([...[...(m.fmaByName.get(bare) ?? [])].sort(), ...m.unsidedOf(c.fma)])) {
        if (fma === c.fma || overridden(fma)) continue
        const z = wikidataZh(fma)
        if (z) return z.zh
      }
      return undefined
    }
    // 大陆用语优先：词表的整词词条优先于措辞不同的 Wikidata 标签。
    // Mainland wording policy: an exact lexicon term beats a differently worded Wikidata label.
    const lex = keepWikidata ? undefined : lexiconOnly.exact(c.en)

    if (ZH_ID_OVERRIDES[c.fma]) {
      entry.zh = ZH_ID_OVERRIDES[c.fma]!.zh
      entry.zhSource = 'machine-translation:override'
    } else if (override) {
      entry.zh = override.zh
      entry.zhSource = 'machine-translation:override'
    } else if (lex) {
      const base = own ? undefined : baseLabel()
      const wd = own?.zh ?? (base && zhSide + base)
      entry.zh = lex
      if (own && own.zh === lex) entry.zhSource = own.source
      else if (!own && wd === lex) entry.zhSource = 'derived:laterality'
      else if (wd) {
        entry.zhSource = 'lexicon:mainland-over-wikidata'
        replaced.push({ id: c.fma, en: c.en, wikidata: wd, lexicon: lex })
      } else entry.zhSource = 'machine-translation'
    } else if (own) {
      entry.zh = own.zh
      entry.zhSource = own.source
    } else {
      const base = baseLabel()
      if (base) {
        entry.zh = zhSide + base
        entry.zhSource = 'derived:laterality'
      } else {
        // 先用纯词表加规则；只有这样译不出时才借用子词的 Wikidata 标签
        // pure lexicon + rules first; Wikidata labels of sub-terms only for what that cannot reach
        const z = lexiconOnly.translate(c.en) ?? translator.translate(c.en)
        if (z) {
          entry.zh = z
          entry.zhSource = 'machine-translation'
        }
      }
    }

    {
      const bl = own ? undefined : baseLabel()
      const wdLabel = own?.zh ?? (bl && zhSide + bl)
      const lexLabel = lexiconOnly.translate(c.en)
      evidence[c.fma] = { ...(lexLabel ? { lexicon: lexLabel } : {}), ...(wdLabel ? { wikidata: wdLabel } : {}) }
    }
    if (entry.zhSource?.startsWith('wikidata') && entry.zh) {
      const mine = lexiconOnly.translate(c.en)
      if (mine && mine !== entry.zh) disagreements.push({ fma: c.fma, en: c.en, wikidata: entry.zh, lexicon: mine, zhSource: entry.zhSource })
    }
    return entry
  }

  for (const c of [...m.concepts.values()].sort((a, b) => compareIds(a.fma, b.fma))) {
    const d = sidedDerivative(c.fma)
    if (!d) {
      names[c.fma] = nameConcept(c)
      continue
    }
    // “<base>_L/_R”：先照常给基础概念命名，再只加一次侧别词。保留基础概念的 Wikidata 条目；
    // 基础名称来自 Wikidata 时 zhSource 为 derived:laterality，否则沿用基础名称自己的（生成）来源，
    // 这样生成的名称不会被当成有出处的。
    // "<base>_L/_R": name the base concept as usual, then add the side word exactly once.
    // The base's Wikidata item is kept; zhSource is derived:laterality when the base name is
    // Wikidata-sourced, otherwise the base's own (generated) source, so nothing generated is
    // presented as sourced.
    const base = names[d.base] ?? nameConcept(m.concepts.get(d.base) ?? { fma: d.base, en: stripSide(c.en), inIsa: false, inPartOf: false })
    const entry: NameEntry = { status: 'unreviewed' }
    if (base.wikidata) entry.wikidata = base.wikidata
    if (base.zh) {
      entry.zh = (d.side === 'left' ? '左' : '右') + base.zh
      entry.zhSource = base.zhSource?.startsWith('wikidata') ? 'derived:laterality' : base.zhSource
    }
    const mark = d.side === 'left' ? '左' : '右'
    const be = evidence[d.base] ?? {}
    evidence[c.fma] = { ...(be.lexicon ? { lexicon: mark + be.lexicon } : {}), ...(be.wikidata ? { wikidata: mark + be.wikidata } : {}) }
    names[c.fma] = entry
  }
  return { names, disagreements, replaced, evidence }
}
