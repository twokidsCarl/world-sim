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

// Concept ids: FMA ids, or synthetic ids the dataset uses where FMA has no class.
const ID = /^(FMA[1-9]\d*|[A-Z][A-Z0-9]*_[A-Za-z0-9_]+)$/
const QID = /^Q[1-9]\d*$/
const KINDS: RelationKind[] = ['origin', 'insertion', 'innervatedBy', 'innervates', 'arterialSupply', 'venousDrainage', 'lymphaticDrainage', 'connectsWith', 'antagonist']
const ZH_SOURCES = ['wikidata', 'wikidata:hant-converted', 'wikidata:via-uberon-id', 'wikidata:generic-twin', 'derived:laterality', 'lexicon:mainland-over-wikidata', 'machine-translation', 'machine-translation:override']
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

  it('is keyed by concept ids and has only contract fields', () => {
    expect(entries.length).toBeGreaterThan(3000)
    for (const [fma, e] of entries) {
      expect(fma).toMatch(ID)
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

  it('covers every BodyParts3D 4.0 concept', () => {
    const concepts = bp3dConcepts()
    if (!concepts) return // raw data not present in this checkout
    for (const fma of concepts) expect(names[fma]?.zh, fma).toBeTruthy()
  })

  // The dataset, not the BodyParts3D 4.0 lists, defines what must be named: the geometry pipeline
  // also imports structures from other sources.
  it.each(['male', 'female'])('names every part and tree concept of the %s anatomy.json in zh', (body) => {
    const file = resolve(root, 'public/anatomy', body, 'anatomy.json')
    if (!existsSync(file)) return // generated file, absent until the geometry pipeline has run
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      parts: { id: string; fma: string; name: string }[]
      trees: Record<'isa' | 'partOf', { id: string; name: string }[]>
    }
    const missing: string[] = []
    for (const p of data.parts) {
      const e = names[p.fma]
      if (!e?.zh || !e.zhSource || !hasHan(e.zh)) missing.push(`${p.id} ${p.fma} ${p.name}`)
    }
    expect(missing, 'parts without a zh name').toEqual([])
    const unnamedConcepts = [...data.trees.isa, ...data.trees.partOf].filter((c) => !names[c.id]?.zh).map((c) => `${c.id} ${c.name}`)
    expect(unnamedConcepts, 'tree concepts without a zh name').toEqual([])
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

  it('mainland wording wins over regional Wikidata labels, and says so', () => {
    // Wikidata: 总颈动脉, 棘上肌, 食道, 骶棘韧带 (wrong ligament), 总腓骨神经
    expect(names.FMA3939).toMatchObject({ zh: '颈总动脉', zhSource: 'lexicon:mainland-over-wikidata', wikidata: 'Q214275' })
    expect(names.FMA9629).toMatchObject({ zh: '冈上肌', zhSource: 'lexicon:mainland-over-wikidata' })
    expect(names.FMA7131).toMatchObject({ zh: '食管', zhSource: 'lexicon:mainland-over-wikidata' })
    expect(names.FMA21479).toMatchObject({ zh: '骶结节韧带', zhSource: 'lexicon:mainland-over-wikidata' })
    expect(names.FMA45358).toMatchObject({ zh: '左腓总神经', zhSource: 'lexicon:mainland-over-wikidata' })
    // where Wikidata already has the mainland term it stays the source
    expect(names.FMA14385).toMatchObject({ zh: '正中神经', zhSource: 'wikidata' })
    expect(names.FMA37068).toMatchObject({ zh: '左正中神经', zhSource: 'derived:laterality' })
    const regional = ['总颈动脉', '内颈动脉', '棘上肌', '棘下肌', '食道', '内翼肌', '上唇举肌', '鼻锥肌', '外展小指肌', '颜面神经', '总腓骨神经', '末梢神经', '副甲状腺']
    for (const [id, e] of entries) for (const bad of regional) expect(e.zh?.includes(bad) ?? false, `${id} ${e.zh}`).toBe(false)
  })

  it('names concepts with synthetic (non-FMA) ids; only UBERON ids may carry a Wikidata link', () => {
    const synthetic = entries.filter(([id]) => !/^FMA\d+$/.test(id))
    for (const [id, e] of synthetic) {
      expect(e.zh && hasHan(e.zh), id).toBe(true)
      if (/^UBERON_\d+$/.test(id)) {
        // resolved through Wikidata's UBERON ID property (P1554) when an item exists
        if (e.wikidata) expect(['wikidata:via-uberon-id', 'derived:laterality', 'lexicon:mainland-over-wikidata', 'machine-translation', 'machine-translation:override'], id).toContain(e.zhSource)
        else expect(e.zhSource, id).toBe('machine-translation')
      } else {
        expect(e.wikidata, id).toBeUndefined()
        expect(e.zhSource, id).toBe('machine-translation')
      }
    }
    for (const [id, e] of entries) if (e.zhSource === 'wikidata:via-uberon-id') expect(id).toMatch(/^UBERON_\d+$/)
    if (names.ZAC_recurrent_thenar_branch_of_median_nerve_L) {
      expect(names.ZAC_recurrent_thenar_branch_of_median_nerve_L.zh).toBe('左正中神经返支（鱼际支）')
      expect(names.ZAC_scapholunate_interosseous_ligament_R?.zh).toBe('右舟月骨间韧带')
    }
  })

  it('female reproductive system and breast use mainland terms', () => {
    if (!names.UBERON_0000002) return // female dataset not part of this build
    // UBERON:0000002 -> Q666412 "cervix" on Wikidata (P1554), which also carries FMA17740
    expect(names.UBERON_0000002).toMatchObject({ zh: '子宫颈', wikidata: 'Q666412' })
    expect(names.UBERON_0009853?.zh).toBe('子宫体')
    expect(names.UBERON_0000996?.zh).toBe('阴道')
    expect(names.UBERON_0012332?.zh).toBe('子宫阔韧带')
    expect(names.FMA17561?.zh).toBe('子宫底')
    expect(names.FMA18306?.zh).toBe('输卵管峡部')
    expect(names.FMA55422?.zh).toBe('卵巢固有韧带')
    expect(names.FMA19823?.zh).toBe('右卵巢悬韧带')
    expect(names.FMA14729?.zh).toBe('膀胱子宫陷凹')
    expect(names.HRAC_cornua?.zh).toBe('子宫角')
    // ids shared by a left and a right part are named without a side
    expect(names.UBERON_0018140?.zh).toBe('乳腺叶')
    expect(names.FMA58088?.zh).toBe('输乳窦')
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
      expect(r.subject, at).toMatch(ID)
      expect(KINDS, at).toContain(r.kind)
      if (r.object !== undefined) expect(r.object, at).toMatch(ID)
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
    for (const r of propagated) expect(r.source.name).toMatch(/from (whole muscle |whole organ )?FMA\d+ "/)
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
    // on the lateralised head the object is the same-side nerve, which the dataset has as a part:
    // FMA37066 "left musculocutaneous nerve"
    const left = find('FMA37687', 'innervatedBy')
    expect(left.map((r) => r.object)).toEqual(['FMA37066'])
    expect(left[0]!.source.name).toContain("object lateralised to the subject's side")
    expect(names.FMA37066?.zh).toBe('左肌皮神经')
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

  describe('innervates (nerve -> structure)', () => {
    const INVERSE = 'inverse of a statement made on the innervated structure'
    const all = relations.filter((r) => r.kind === 'innervates')
    const innervatedBy = new Map<string, Relation[]>()
    for (const r of relations) if (r.kind === 'innervatedBy') innervatedBy.set(r.subject, [...(innervatedBy.get(r.subject) ?? []), r])
    const targets = (nerve: string) => find(nerve, 'innervates').map((r) => r.object)

    it('exists both as direct Wikidata statements and as mirrors, told apart by source.name', () => {
      const mirrored = all.filter((r) => r.source.name.includes(INVERSE) || r.source.name.includes('re-attached to the nerve'))
      expect(all.length - mirrored.length).toBeGreaterThan(300)
      expect(mirrored.length).toBeGreaterThan(100)
      for (const r of all) if (!mirrored.includes(r) && r.source.name.startsWith('Wikidata')) expect(r.source.url).toMatch(/#P3190$/)
    })

    it('symmetry: every mirrored relation has its innervatedBy counterpart with the same source', () => {
      for (const r of all) {
        const name = r.source.name
        if (!name.includes(INVERSE) && !name.includes('re-attached to the nerve')) continue
        expect(r.object, `${r.subject} innervates`).toBeDefined()
        const back = (innervatedBy.get(r.object!) ?? []).filter((b) => b.source.url === r.source.url && name.startsWith(b.source.name))
        expect(back.length, `${r.subject} innervates ${r.object}`).toBeGreaterThan(0)
        if (name.includes('names a branch of this nerve')) {
          // the original names a branch ("... branch of femoral nerve"), quoted in the note
          expect(back.some((b) => name.endsWith(`"${b.objectLabel.en}"`)), name).toBe(true)
        } else {
          expect(back.some((b) => b.object === r.subject), `${r.subject} innervates ${r.object}`).toBe(true)
        }
      }
    })

    it('has no duplicate nerve/structure pair', () => {
      const seen = new Set<string>()
      for (const r of all) {
        const key = `${r.subject}|${r.object ?? r.objectLabel.en}`
        expect(seen.has(key), key).toBe(false)
        seen.add(key)
      }
    })

    // Spot checks verified by hand against wikidata.org (P3190 on the nerve / P3189 on the muscle).
    it('spot check: median nerve -> pronator teres, flexor carpi radialis', () => {
      // Q1364876 "median nerve" P3190 -> pronator teres muscle (FMA38450), flexor carpi radialis muscle (FMA38459)
      expect(targets('FMA14385')).toEqual(expect.arrayContaining(['FMA38450', 'FMA38459']))
      // left median nerve (FMA37068) lists the left muscles: left flexor carpi radialis, humeral head of left pronator teres
      expect(targets('FMA37068')).toEqual(expect.arrayContaining(['FMA38461', 'FMA38561']))
      expect(targets('FMA37068')).not.toContain('FMA38459')
    })

    it('spot check: musculocutaneous nerve -> heads of biceps brachii (mirrored, qualifiers kept)', () => {
      // left musculocutaneous nerve FMA37066 -> short / long head of left biceps brachii
      const heads = find('FMA37066', 'innervates').filter((r) => r.object === 'FMA37685' || r.object === 'FMA37687')
      expect(heads).toHaveLength(2)
      for (const r of heads) {
        expect(r.source.name).toContain('propagated from whole muscle FMA37670')
        expect(r.source.name).toContain(INVERSE)
        expect(r.source.url).toBe('https://www.wikidata.org/wiki/Q201363#P3189')
      }
    })

    it('spot check: femoral nerve -> quadriceps parts, axillary nerve -> deltoid parts', () => {
      // left femoral nerve FMA16500 -> left rectus femoris, vastus lateralis, medialis, intermedius
      expect(targets('FMA16500')).toEqual(expect.arrayContaining(['FMA38929', 'FMA38931', 'FMA38933', 'FMA38935']))
      const rectus = find('FMA16500', 'innervates').find((r) => r.object === 'FMA38929')!
      expect(rectus.source.name).toContain('names a branch of this nerve: "rectus femoris branch of femoral nerve"')
      // left axillary nerve FMA37074 -> clavicular, acromial and spinal parts of left deltoid
      expect(targets('FMA37074')).toEqual(expect.arrayContaining(['FMA34681', 'FMA34683', 'FMA34685']))
      // right axillary nerve lists right-side parts only
      expect(targets('FMA37073')).toEqual(expect.arrayContaining(['FMA34680', 'FMA34682', 'FMA34684']))
      expect(targets('FMA37073')).not.toContain('FMA34681')
    })
  })

  it('spot check: parts of the uterus inherit its blood supply, and the ovary has its own', () => {
    if (!names.UBERON_0009853) return // female dataset not part of this build
    // Q9612 "uterus" P2286 -> uterine artery (FMA18829), ovarian artery; P2289 -> uterine vein (FMA18896).
    // The dataset has no "uterus" concept, so its body and fundus receive them, labelled as such.
    for (const part of ['UBERON_0009853', 'FMA17561']) {
      const supply = find(part, 'arterialSupply')
      expect(supply.map((r) => r.object)).toContain('FMA18829')
      expect(supply[0]!.source.name).toContain('propagated from whole organ FMA17558 "uterus"')
      expect(find(part, 'venousDrainage').map((r) => r.object)).toContain('FMA18896')
    }
    // Q9631 "ovary" P2286 -> ovarian artery (FMA14761), stated on the ovary itself
    expect(find('FMA7209', 'arterialSupply').map((r) => r.object)).toContain('FMA14761')
    // cervix: reached through its UBERON id; Wikidata says vaginal artery (FMA18832)
    expect(find('UBERON_0000002', 'arterialSupply').map((r) => r.object)).toContain('FMA18832')
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
