// names.json: one NameEntry per BodyParts3D concept, with the origin of every zh name recorded.
import type { NameEntry } from '../../../src/anatomy/types.ts'
import { ZH_OVERRIDES } from '../lexicon/overrides.ts'
import { sideOf, stripSide, type Model } from './model.ts'
import { createTranslator } from './translate.ts'

/** Values that may appear in NameEntry.zhSource. */
export const ZH_SOURCES = [
  'wikidata', // zh-cn / zh-hans / zh label of the concept's own Wikidata item, already Simplified
  'wikidata:hant-converted', // own item's label, converted from Traditional characters
  'wikidata:generic-twin', // label of the species-neutral item ("heart") for a "human heart" item
  'derived:laterality', // 左/右 + the Wikidata zh label of the unlateralised concept
  'machine-translation', // tools/knowledge lexicon + rules; not from any source
  'machine-translation:override', // hand-written replacement for a Wikidata label judged wrong
] as const

export interface NamesResult {
  names: Record<string, NameEntry>
  /** Wikidata zh labels that differ from the lexicon's own rendering, for a reviewer. */
  disagreements: { fma: string; en: string; wikidata: string; lexicon: string; zhSource: string }[]
}

const LATIN_ABBREVIATIONS: Record<string, string> = {
  'm.': 'musculus', 'mm.': 'musculi', 'a.': 'arteria', 'aa.': 'arteriae', 'v.': 'vena', 'vv.': 'venae',
  'n.': 'nervus', 'nn.': 'nervi', 'lig.': 'ligamentum', 'ligg.': 'ligamenta', 'r.': 'ramus', 'rr.': 'rami',
}

/** First candidate that looks like plain Latin (Wikidata "la" labels sometimes hold other languages). */
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
  /** An item with several FMA ids names only the concept its English label matches. */
  const itemFits = (qid: string, fma: string) => {
    const fmas = m.fmaByItem.get(qid) ?? []
    if (fmas.length < 2) return true
    const label = m.enOf(qid)?.toLowerCase()
    const nameOf = (f: string) => m.concepts.get(f)?.en.toLowerCase()
    if (nameOf(fma) === label) return true
    return !fmas.some((f) => f !== fma && nameOf(f) === label)
  }

  /** A Wikidata-sourced zh for an FMA id (own item, then generic twin). */
  const wikidataZh = (fma: string): { zh: string; source: string } | undefined => {
    const items = m.itemsByFma.get(fma) ?? []
    const primary = m.primaryItem.get(fma)
    const ordered = primary ? [primary, ...items.map((i) => i.qid).filter((q) => q !== primary)] : items.map((i) => i.qid)
    for (const q of ordered) {
      const z = itemFits(q, fma) ? m.zhOf(q) : undefined
      if (z) return { zh: z.text, source: z.converted ? 'wikidata:hant-converted' : 'wikidata' }
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

  for (const c of [...m.concepts.values()].sort((a, b) => Number(a.fma.slice(3)) - Number(b.fma.slice(3)))) {
    const entry: NameEntry = { status: 'unreviewed' }
    // an item that also carries another FMA id and is named after that other concept is not ours
    const primary = m.primaryItem.get(c.fma)
    const qid = primary && itemFits(primary, c.fma) ? primary : undefined
    if (qid) entry.wikidata = qid

    // Latin: the item's Latin label, else its TA98 Latin term (abbreviations expanded).
    if (qid) {
      const twin = m.twinOf.get(qid)
      const la = pickLatin([m.labels.get(qid)?.la, ...(m.extras.get(qid)?.ta98Latin ?? []), twin && m.labels.get(twin)?.la])
      if (la) entry.la = la
    }

    // Japanese: BodyParts3D's own kanji name (first alternative), else the Wikidata label.
    const ja = c.ja?.split(/[;|]/)[0]?.trim() || (qid && m.labels.get(qid)?.ja)
    if (ja) entry.ja = ja

    const own = wikidataZh(c.fma)
    const override = overridden(c.fma)
    if (override) {
      entry.zh = override.zh
      entry.zhSource = 'machine-translation:override'
    } else if (own) {
      entry.zh = own.zh
      entry.zhSource = own.source
    } else {
      const side = sideOf(c.en)
      let done = false
      if (side) {
        // (a) inherit from the unlateralised concept when Wikidata names it
        const base = stripSide(c.en)
        // an overridden base is not Wikidata-sourced: leave it to the translator below
        for (const fma of ZH_OVERRIDES[base] ? [] : [...new Set([...[...(m.fmaByName.get(base) ?? [])].sort(), ...m.unsidedOf(c.fma)])]) {
          if (fma === c.fma || overridden(fma)) continue
          const z = wikidataZh(fma)
          if (z) {
            entry.zh = (side === 'left' ? '左' : '右') + z.zh
            entry.zhSource = 'derived:laterality'
            done = true
            break
          }
        }
      }
      if (!done) {
        const z = translator.translate(c.en)
        if (z) {
          entry.zh = z
          entry.zhSource = 'machine-translation'
        }
      }
    }

    if (entry.zhSource?.startsWith('wikidata') && entry.zh) {
      const mine = lexiconOnly.translate(c.en)
      if (mine && mine !== entry.zh) disagreements.push({ fma: c.fma, en: c.en, wikidata: entry.zh, lexicon: mine, zhSource: entry.zhSource })
    }
    names[c.fma] = entry
  }
  return { names, disagreements }
}
