import { describe, expect, it } from 'vitest'
import { parseOutput } from '../server/llm'
import neuroTable from '../data/neuro.json'
import { matchArticles, matchNeuro } from '../server/motm'
import { resolveTopic, type Deps } from '../server/resolve'
import type { EntryInfo } from '../server/sources/rcsb'

const entry = (id: string, over: Partial<EntryInfo> = {}): EntryInfo => ({
  id, title: `${id} title`, method: 'X-RAY DIFFRACTION', resolution: 2, year: 2020, atoms: 5000,
  assemblies: [{ id: '1', atoms: 5000, chains: 2, symmetry: 'C2' }],
  entities: [
    { entityId: '1', kind: 'protein', description: 'Enzyme', organism: 'Homo sapiens', chains: 2, length: 300, uniprot: ['P00001'] },
    { entityId: '2', kind: 'dna', description: 'DNA', organism: '', chains: 1, length: 20, uniprot: [] },
  ],
  ...over,
})

/** 按脚本作答的模型，以及只认识三个条目的数据库 / A model that answers from a script, and databases that know three entries. */
function fakeDeps(choice: unknown, over: Partial<Deps> = {}): { deps: Deps; prompts: string[]; schemas: any[] } {
  const prompts: string[] = [], schemas: any[] = []
  const known = new Map([['1AAA', entry('1AAA')], ['2BBB', entry('2BBB')], ['3CCC', entry('3CCC')]])
  const deps: Deps = {
    ask: (async (o: any) => {
      prompts.push(o.prompt)
      schemas.push(o.schema)
      if (prompts.length === 1) {
        return { kind: 'complex', name_en: 'test enzyme', genes: [], steps: [{ label: 'the enzyme on DNA', queries: ['enzyme DNA complex'], suggested_pdb_ids: ['3CCC', '9ZZZ'] }] }
      }
      return choice
    }) as Deps['ask'],
    searchText: async () => ['1AAA', '2BBB'],
    entryInfo: async (ids) => ids.map((i) => known.get(i)).filter((x): x is EntryInfo => !!x),
    findProtein: async () => [],
    bestStructures: async () => [],
    alphafold: async () => null,
    abundances: async () => null, curatedComplexes: async () => [], copyTable: async () => null,
    ...over,
  }
  return { deps, prompts, schemas }
}

const goodChoice = {
  title: 'T', caption: 'C', notes: [],
  panels: [{ label: 'L', source_id: '2BBB', assembly_id: '1', reason: 'r', entities: [{ entity_id: '1', role: 'focus', name: 'Enzyme' }, { entity_id: '2', role: 'nucleic', name: 'DNA' }] }],
}

describe('resolveTopic', () => {
  it('offers the model only ids the databases confirmed', async () => {
    const { deps, schemas, prompts } = fakeDeps(goodChoice)
    const spec = await resolveTopic('test', deps)
    const allowed = schemas[1].properties.panels.items.properties.source_id.enum as string[]
    expect(allowed.sort()).toEqual(['1AAA', '2BBB', '3CCC'])
    expect(prompts[1]).not.toContain('9ZZZ') // 回忆出来了，但 RCSB 不认识它 / recalled, but RCSB does not know it
    expect(spec.panels[0]!.source.id).toBe('2BBB')
    expect(spec.panels[0]!.entities.map((e) => e.role)).toEqual(['focus', 'nucleic'])
  })

  it('refuses a chosen id that was not a candidate', async () => {
    const { deps } = fakeDeps({ ...goodChoice, panels: [{ ...goodChoice.panels[0], source_id: '7XYZ' }] })
    await expect(resolveTopic('test', deps)).rejects.toThrow(/没能从候选结构中选出/)
  })

  it('repairs an unknown assembly, unknown roles and missing entities', async () => {
    const { deps } = fakeDeps({
      ...goodChoice,
      panels: [{ label: '', source_id: '1AAA', assembly_id: '42', reason: '', entities: [{ entity_id: '1', role: 'sparkly', name: '' }] }],
    })
    const p = (await resolveTopic('test', deps)).panels[0]!
    expect(p.assembly).toBe('1')
    expect(p.entities.map((e) => [e.entityId, e.role])).toEqual([['1', 'soluble'], ['2', 'nucleic']])
    expect(p.label).toBe('1AAA title')
  })

  it('says so when nothing is found', async () => {
    const { deps } = fakeDeps(goodChoice, { searchText: async () => [], entryInfo: async () => [] })
    await expect(resolveTopic('test', deps)).rejects.toThrow(/没有找到/)
  })

  it('carries on when one lookup fails', async () => {
    const { deps } = fakeDeps(goodChoice, {
      searchText: async () => {
        throw new Error('search is down')
      },
    })
    // 3CCC 是回忆出来的，并得到 data API 的确认，所以它仍是候选
    // 3CCC was recalled and is confirmed by the data API, so it is still a candidate
    const spec = await resolveTopic('test', fakeDeps({ ...goodChoice, panels: [{ ...goodChoice.panels[0], source_id: '3CCC' }] }, { searchText: deps.searchText }).deps)
    expect(spec.panels[0]!.source.id).toBe('3CCC')
  })

  it('offers an AlphaFold model only when experiments cover the protein poorly, and labels it', async () => {
    const af = {
      findProtein: async () => [{ accession: 'P12345', name: 'Mystery protein', gene: 'MYST', organism: 'Homo sapiens', length: 400 }],
      alphafold: async () => ({ accession: 'P12345', url: 'https://example.org/AF-P12345.bcif', confident: 0.8, source: 'AlphaFold DB' as const }),
    }
    const withGene = (deps: Deps): Deps => ({
      ...deps,
      ask: (async (o: any) => {
        const r: any = await deps.ask(o)
        return r.kind ? { ...r, genes: [{ symbol: 'MYST', organism: 'Homo sapiens' }] } : r
      }) as Deps['ask'],
    })
    const predicted = { ...goodChoice, panels: [{ label: 'L', source_id: 'AF-P12345', assembly_id: 'asym', reason: 'r', entities: [{ entity_id: '1', role: 'focus', name: 'M' }] }] }

    const poor = fakeDeps(predicted, { ...af, bestStructures: async () => [{ pdbId: '1AAA', chain: 'A', coverage: 0.2, resolution: 2, method: 'X-ray' }] })
    const spec = await resolveTopic('test', withGene(poor.deps))
    expect(spec.panels[0]!.source.kind).toBe('alphafold')
    expect(spec.notes).toContainEqual({ key: 'note.alphafoldPanel', params: { id: 'AF-P12345' } })

    const good = fakeDeps(goodChoice, { ...af, bestStructures: async () => [{ pdbId: '1AAA', chain: 'A', coverage: 0.95, resolution: 2, method: 'X-ray' }] })
    await resolveTopic('test', withGene(good.deps))
    expect(good.schemas[1].properties.panels.items.properties.source_id.enum).not.toContain('AF-P12345')
  })
})

describe('matchArticles', () => {
  it('finds curated articles by title', () => {
    expect(matchArticles(['hemoglobin oxygen transport']).map((a) => a.title)).toContain('Hemoglobin')
    expect(matchArticles(['SARS-CoV-2 spike glycoprotein']).some((a) => a.pdb.includes('6VXX'))).toBe(true)
  })
  it('does not match on a shared common word', () => {
    expect(matchArticles(['a protein complex of the human virus'])).toEqual([])
  })
})

// 现成的整体模型 / ready-made whole models
describe('resolveTopic with the catalogue', () => {
  const intent = (whole_model: string) => ({ kind: 'virus', name_en: 'SARS-CoV-2 virion', genes: [], steps: [{ label: 'x', queries: ['q'], suggested_pdb_ids: [] }], whole_model })

  it('hands back a catalogue id and looks nothing else up', async () => {
    const { deps, prompts, schemas } = fakeDeps(goodChoice)
    const spec = await resolveTopic('新冠病毒', { ...deps, ask: (async (o: any) => (prompts.push(o.prompt), schemas.push(o.schema), intent('sars-cov-2-virion'))) as Deps['ask'] })
    expect(spec.catalog).toBe('sars-cov-2-virion')
    expect(spec.kind).toBe('model')
    expect(prompts.length).toBe(1)
    // 模型只能在目录里的 id 中选 / the model can only choose among ids in the catalogue
    expect(schemas[0].properties.whole_model.enum).toContain('sars-cov-2-virion')
    expect(schemas[0].properties.whole_model.enum).toContain('')
  })

  it('ignores an id that is not in the catalogue', async () => {
    const { deps } = fakeDeps(goodChoice)
    let n = 0
    const spec = await resolveTopic('x', { ...deps, ask: (async () => (n++ === 0 ? intent('made-up-model') : goodChoice)) as Deps['ask'] })
    expect(spec.catalog).toBeUndefined()
    expect(spec.panels[0]!.source.id).toBe('2BBB')
  })
})

describe('parseOutput', () => {
  const schema = { required: ['a'] }
  it('reads structured_output', () => {
    expect(parseOutput(JSON.stringify({ type: 'result', structured_output: { a: 1 } }), schema)).toEqual({ a: 1 })
  })
  it('reads the last result of an event list and fenced JSON in the text', () => {
    const out = JSON.stringify([{ type: 'system' }, { type: 'result', result: 'here:\n```json\n{"a": 2}\n```' }])
    expect(parseOutput(out, schema)).toEqual({ a: 2 })
  })
  it('rejects errors, non-JSON and missing fields', () => {
    expect(() => parseOutput(JSON.stringify({ is_error: true, result: 'rate limited' }), schema)).toThrow(/rate limited/)
    expect(() => parseOutput('not json', schema)).toThrow()
    expect(() => parseOutput(JSON.stringify({ structured_output: { b: 1 } }), schema)).toThrow(/缺少字段/)
  })
})

// 神经相关的地标结构 / landmark structures of the nervous system
describe('neuroscience landmarks', () => {
  it('lists each structure once, with a name in both languages', () => {
    const ids = neuroTable.groups.flatMap((g) => g.entries.map((e) => e.id))
    expect(new Set(ids).size).toBe(ids.length)
    for (const g of neuroTable.groups) for (const e of g.entries) {
      expect(e.id).toMatch(/^[0-9][A-Z0-9]{3}$/)
      expect(e.title.length).toBeGreaterThan(2)
      expect(e.titleEn.length).toBeGreaterThan(3)
    }
  })

  it('offers a landmark when the query names it, and nothing for an unrelated query', () => {
    expect(matchNeuro(['AMPA glutamate receptor rat']).map((x) => x.id)).toContain('3KG2')
    expect(matchNeuro(['voltage-gated sodium channel Nav1.7 pain'])[0]!.id).toBe('6J8J')
    expect(matchNeuro(['tubulin dimer']).map((x) => x.id)).toContain('1JFF')
    expect(matchNeuro(['haemoglobin oxygen transport'])).toEqual([])
    // 只碰上一个泛泛的词不算 / one generic word in common is not enough
    expect(matchNeuro(['calcium binding protein']).map((x) => x.id)).not.toContain('5GJV')
  })
})
