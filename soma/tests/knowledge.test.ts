// Checks the checked-in knowledge layer (data/curated/knowledge) against the data contract.
// Regenerate with `bun tools/knowledge/run.ts`.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NameEntry, Relation, RelationKind } from '../src/anatomy/types'

const root = resolve(__dirname, '..')
const read = <T>(rel: string) => JSON.parse(readFileSync(resolve(root, rel), 'utf8')) as T

const names = read<Record<string, NameEntry>>('data/curated/knowledge/names.json')
const relations = read<Relation[]>('data/curated/knowledge/relations.json')

const FMA = /^FMA[1-9]\d*$/
const QID = /^Q[1-9]\d*$/
const KINDS: RelationKind[] = ['origin', 'insertion', 'innervatedBy', 'arterialSupply', 'venousDrainage', 'lymphaticDrainage', 'connectsWith', 'antagonist']
const ZH_SOURCES = ['wikidata', 'wikidata:hant-converted', 'wikidata:generic-twin', 'derived:laterality', 'machine-translation', 'machine-translation:override']
const NAME_KEYS = ['zh', 'la', 'ja', 'wikidata', 'zhSource', 'status']
const hasHan = (s: string) => /[㐀-鿿\u{20000}-\u{2ffff}]/u.test(s)

/** Concept ids of BodyParts3D, when the raw lists are present (data/raw is not checked in). */
function bp3dConcepts(): Set<string> | undefined {
  const out = new Set<string>()
  for (const f of ['isa_parts_list.txt', 'partof_parts_list.txt']) {
    const p = resolve(root, 'data/raw/bodyparts3d', f)
    if (!existsSync(p)) return undefined
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/).slice(1)) {
      const id = line.split('\t')[0]
      if (id) out.add(id)
    }
  }
  return out
}

describe('names.json', () => {
  const entries = Object.entries(names)

  it('is keyed by FMA ids and has only contract fields', () => {
    expect(entries.length).toBeGreaterThan(3000)
    for (const [fma, e] of entries) {
      expect(fma).toMatch(FMA)
      for (const k of Object.keys(e)) expect(NAME_KEYS, `${fma}.${k}`).toContain(k)
      for (const k of ['zh', 'la', 'ja', 'wikidata', 'zhSource'] as const) {
        if (e[k] !== undefined) expect(typeof e[k] === 'string' && e[k]!.trim() === e[k] && e[k] !== '', `${fma}.${k}`).toBe(true)
      }
      if (e.wikidata !== undefined) expect(e.wikidata, fma).toMatch(QID)
    }
  })

  it('marks everything unreviewed', () => {
    for (const [fma, e] of entries) expect(e.status, fma).toBe('unreviewed')
  })

  it('records where every zh name came from, with a known source value', () => {
    for (const [fma, e] of entries) {
      expect(e.zh !== undefined, `${fma} zh/zhSource pairing`).toBe(e.zhSource !== undefined)
      if (e.zhSource !== undefined) expect(ZH_SOURCES, `${fma}: ${e.zhSource}`).toContain(e.zhSource)
    }
  })

  it('does not label a name as coming from Wikidata without a Wikidata item', () => {
    for (const [fma, e] of entries) if (e.zhSource?.startsWith('wikidata')) expect(e.wikidata, fma).toMatch(QID)
  })

  it('has zh names written in Chinese characters, Latin names in Latin letters', () => {
    for (const [fma, e] of entries) {
      if (e.zh) {
        expect(hasHan(e.zh), `${fma} zh=${e.zh}`).toBe(true)
        expect(/[぀-ヿ]/.test(e.zh), `${fma} zh has kana: ${e.zh}`).toBe(false)
      }
      if (e.la) expect(e.la, fma).toMatch(/^[A-Za-zæœÆŒ0-9 ,-]+$/)
    }
  })

  it('lateralised names carry the matching 左/右', () => {
    for (const [fma, e] of entries) {
      if (e.zhSource !== 'derived:laterality') continue
      expect(/^[左右]/.test(e.zh!), `${fma} ${e.zh}`).toBe(true)
    }
  })

  it('covers every BodyParts3D concept', () => {
    const concepts = bp3dConcepts()
    if (!concepts) return // raw data not present in this checkout
    expect(Object.keys(names).sort()).toEqual([...concepts].sort())
    for (const fma of concepts) expect(names[fma]!.zh, fma).toBeTruthy()
  })

  // Spot checks verified by hand against wikidata.org on 2026-10-11.
  it('spot checks: heart, femur, right femur, aorta', () => {
    // FMA7088 -> Q2419844 "human heart" (no zh label); zh comes from its superclass Q1072 "heart" = 心脏
    expect(names.FMA7088).toMatchObject({ wikidata: 'Q2419844', zh: '心脏', zhSource: 'wikidata:generic-twin', ja: '心臓' })
    // FMA9611 -> Q176503 "femur": zh-cn 股骨, la "Os femoris"
    expect(names.FMA9611).toMatchObject({ wikidata: 'Q176503', zh: '股骨', zhSource: 'wikidata', la: 'Os femoris', ja: '大腿骨' })
    // FMA24474 -> Q66516001 "right femur": English label only, so 右 + femur
    expect(names.FMA24474).toMatchObject({ wikidata: 'Q66516001', zh: '右股骨', zhSource: 'derived:laterality' })
    expect(names.FMA3734).toMatchObject({ wikidata: 'Q101004', zh: '主动脉', zhSource: 'wikidata' })
  })

  it('spot checks: generated names are labelled as generated', () => {
    expect(names.FMA37687).toMatchObject({ zh: '左肱二头肌长头', zhSource: 'machine-translation' }) // long head of left biceps brachii
    expect(names.FMA52748?.zhSource).toBe('machine-translation:override') // mandible: Wikidata says 上颚
    expect(names.FMA52748?.zh).toBe('下颌骨')
  })
})

describe('relations.json', () => {
  it('matches the Relation contract', () => {
    expect(relations.length).toBeGreaterThan(1000)
    for (const [i, r] of relations.entries()) {
      const at = `relation #${i} (${r.subject} ${r.kind})`
      expect(Object.keys(r).filter((k) => !['subject', 'kind', 'object', 'objectLabel', 'source', 'status'].includes(k)), at).toEqual([])
      expect(r.subject, at).toMatch(FMA)
      expect(KINDS, at).toContain(r.kind)
      if (r.object !== undefined) expect(r.object, at).toMatch(FMA)
      expect(r.status, at).toBe('unreviewed')
    }
  })

  it('never has an empty object label', () => {
    for (const [i, r] of relations.entries()) {
      expect(typeof r.objectLabel?.en === 'string' && r.objectLabel.en.trim() !== '', `relation #${i} en`).toBe(true)
      if (r.objectLabel.zh !== undefined) expect(hasHan(r.objectLabel.zh), `relation #${i} zh=${r.objectLabel.zh}`).toBe(true)
      expect(Object.keys(r.objectLabel).filter((k) => k !== 'en' && k !== 'zh'), `relation #${i}`).toEqual([])
    }
  })

  it('cites a source with a URL and a licence on every relation', () => {
    for (const [i, r] of relations.entries()) {
      const at = `relation #${i}`
      expect(r.source.name.trim(), at).not.toBe('')
      if (r.source.name.startsWith('Wikidata')) {
        expect(r.source.url, at).toMatch(/^https:\/\/www\.wikidata\.org\/wiki\/Q\d+#P\d+$/)
        expect(r.source.license, at).toBe('CC0 1.0')
      } else {
        expect(r.source.name, at).toMatch(/^Wikipedia "/)
        expect(r.source.url, at).toMatch(/^https:\/\/en\.wikipedia\.org\/w\/index\.php\?title=[^&]+&oldid=\d+$/)
        expect(r.source.license, at).toBe('CC BY-SA 4.0')
      }
    }
  })

  it('keeps propagated statements distinguishable from direct ones', () => {
    const direct = relations.filter((r) => r.source.name === 'Wikidata')
    const propagated = relations.filter((r) => r.source.name.startsWith('Wikidata (propagated'))
    expect(direct.length).toBeGreaterThan(500)
    expect(propagated.length).toBeGreaterThan(500)
    for (const r of propagated) expect(r.source.name).toMatch(/from (whole muscle )?FMA\d+ "/)
  })

  it('only has subjects that are named, and no self-references or duplicates', () => {
    const seen = new Set<string>()
    for (const r of relations) {
      expect(names[r.subject], r.subject).toBeDefined()
      expect(r.object, `${r.subject} ${r.kind}`).not.toBe(r.subject)
      const key = `${r.subject}|${r.kind}|${r.object ?? r.objectLabel.en}`
      expect(seen.has(key), key).toBe(false)
      seen.add(key)
    }
  })

  const find = (subject: string, kind: RelationKind) => relations.filter((r) => r.subject === subject && r.kind === kind)

  // Spot checks verified by hand against wikidata.org on 2026-10-11.
  it('spot check: biceps brachii is innervated by the musculocutaneous nerve', () => {
    // Q201363 "biceps brachii" P3189 -> Q1758126 "musculocutaneous nerve" (FMA37064). BodyParts3D has
    // only the heads, so the statement arrives on FMA37683 "long head of biceps brachii" by propagation.
    const nerve = find('FMA37683', 'innervatedBy')
    expect(nerve).toHaveLength(1)
    expect(nerve[0]).toMatchObject({ object: 'FMA37064', objectLabel: { en: 'musculocutaneous nerve' } })
    expect(nerve[0]!.source.url).toBe('https://www.wikidata.org/wiki/Q201363#P3189')
    expect(nerve[0]!.source.name).toContain('propagated from whole muscle FMA37670')
    // and on the lateralised head
    expect(find('FMA37687', 'innervatedBy').map((r) => r.object)).toEqual(['FMA37064'])
  })

  it('spot check: the long head keeps its own origin, not the whole muscle’s', () => {
    // Q28792036 "long head of the biceps brachii" P3490 -> supraglenoid tubercle (FMA23263), glenoid labrum (FMA23290)
    const origin = find('FMA37683', 'origin')
    expect(origin.map((r) => r.object).sort()).toEqual(['FMA23263', 'FMA23290'])
    for (const r of origin) expect(r.source.name).toBe('Wikidata')
  })

  it('spot check: heart blood supply and femur articulations', () => {
    // Q2419844 "human heart" / Q1072 "heart" P2286 -> right coronary artery (FMA50039), left coronary artery (FMA50040)
    const supply = find('FMA7088', 'arterialSupply').map((r) => r.object)
    expect(supply).toContain('FMA50039')
    expect(supply).toContain('FMA50040')
    // Q176503 "femur" P2789 -> tibia (FMA24476), patella (FMA24485)
    const femur = find('FMA9611', 'connectsWith').map((r) => r.object)
    expect(femur).toContain('FMA24476')
    expect(femur).toContain('FMA24485')
    // left femur inherits it with the objects moved to the same side: left tibia is FMA24478
    const left = find('FMA24475', 'connectsWith')
    expect(left.map((r) => r.object)).toContain('FMA24478')
    expect(left.find((r) => r.object === 'FMA24478')!.source.name).toContain('propagated via BodyParts3D is-a from FMA9611')
  })

  it('does not keep muscle-only statements on non-muscles', () => {
    // Wikidata has "femur — muscle origin → gastrocnemius" (inverted use of P3490); it must not survive.
    expect(find('FMA9611', 'origin')).toEqual([])
    expect(find('FMA9611', 'insertion')).toEqual([])
  })
})

describe('published copies', () => {
  it('public/anatomy/knowledge matches data/curated/knowledge', () => {
    for (const f of ['names.json', 'relations.json']) {
      const pub = resolve(root, 'public/anatomy/knowledge', f)
      if (!existsSync(pub)) continue // public/anatomy is gitignored; present after a run
      expect(readFileSync(pub, 'utf8')).toBe(readFileSync(resolve(root, 'data/curated/knowledge', f), 'utf8'))
    }
  })
})
