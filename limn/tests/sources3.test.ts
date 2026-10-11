// 第三轮新增的数据源：预测复合物、整理的复合物配比、神经元检索、用户提供的拷贝数表、PDB 格式
// Sources added in round 3: predicted complexes, curated stoichiometry, neuron search, a user-supplied copy-number table, the PDB format
import { describe, expect, it } from 'vitest'
import { copiesPerComplex, readComplexPortal, readStoichiometry } from '../server/sources/complexes'
import { copiesToMicromolar, parseCopyTable } from '../server/sources/copies'
import { readHits, searchUrl } from '../server/sources/neuromorpho'
import { MIN_IPTM, readComplexes } from '../server/sources/uniprot'
import { parsePdb } from '../src/mol/pdb'

describe('predicted complexes', () => {
  const list = [
    { modelEntityId: 'AF-0000000211046780', complexPredictionAccuracy_ipTM: 0.92, latestVersion: 1, complexName: 'HBA1-HBB', complexComposition: [{ identifier: 'P69905', stoichiometry: 1 }, { identifier: 'P68873', stoichiometry: 1 }] },
    { modelEntityId: 'AF-0000000000000001', complexPredictionAccuracy_ipTM: 0.18, complexComposition: [{ identifier: 'P69905', stoichiometry: 1 }, { identifier: 'Q9NWU1', stoichiometry: 1 }] },
    { modelEntityId: 'AF-0000000065932364', complexPredictionAccuracy_ipTM: 0.93, latestVersion: 2, complexComposition: [{ identifier: 'P69905', stoichiometry: 2 }] },
    { modelEntityId: 'not-an-id', complexPredictionAccuracy_ipTM: 0.99 },
  ]
  it('keeps confident interfaces only, most confident first, with where to download them', () => {
    const out = readComplexes(list)
    expect(out.map((c) => c.id)).toEqual(['AF-0000000065932364', 'AF-0000000211046780'])
    expect(out[0]).toMatchObject({ iptm: 0.93, parts: [{ accession: 'P69905', copies: 2 }], url: 'https://alphafold.ebi.ac.uk/files/AF-0000000065932364-model_v2.bcif' })
    expect(MIN_IPTM).toBe(0.6)
    expect(readComplexes(list, 0.1).length).toBe(3)
    expect(readComplexes(null as any)).toEqual([])
  })
})

describe('curated stoichiometry', () => {
  const json = { elements: [
    { complexAC: 'CPX-2113', complexName: 'GroEL-GroES complex', organismName: 'Escherichia coli (strain K12); 83333', interactors: [{ identifier: 'P0A6F9', stochiometry: 'minValue: 7, maxValue: 7' }, { identifier: 'P0A6F5', stochiometry: 'minValue: 14, maxValue: 14' }, { identifier: 'CHEBI:30616', stochiometry: 'minValue: 7, maxValue: 7' }] },
    { complexAC: 'CPX-9', complexName: 'Other', organismName: 'x', interactors: [{ identifier: 'P0A6F5', stochiometry: 'minValue: 1, maxValue: 2' }, { identifier: 'P12345' }, { identifier: 'Q99999' }] },
  ] }
  it('reads subunit copies, proteins only', () => {
    expect(readStoichiometry('minValue: 14, maxValue: 14')).toBe(14)
    expect(readStoichiometry('minValue: 1, maxValue: 2')).toBeNull()
    expect(readStoichiometry(undefined)).toBeNull()
    const c = readComplexPortal(json)
    expect(c[0]).toEqual({ id: 'CPX-2113', name: 'GroEL-GroES complex', organism: 'Escherichia coli (strain K12)', subunits: { P0A6F9: 7, P0A6F5: 14 } })
  })
  it('picks the complex that matches what the structure contains', () => {
    const found = readComplexPortal(json)
    // 一个只有 GroEL 的结构：与 GroEL-GroES 复合物共有一种蛋白，占两种里的一半 / a structure of GroEL alone shares one of that complex's two proteins
    expect(copiesPerComplex(found, 'P0A6F5', { P0A6F5: 14 })).toMatchObject({ copies: 14, complex: { id: 'CPX-2113' } })
    expect(copiesPerComplex(found, 'P99999', { P99999: 2 })).toBeNull()
    expect(copiesPerComplex([], 'P0A6F5', { P0A6F5: 14 })).toBeNull()
  })
})

describe('neuron search', () => {
  it('builds a query from whatever conditions are given, and strips what does not belong in one', () => {
    expect(searchUrl({ species: 'mouse', cellType: 'Purkinje' })).toBe('https://neuromorpho.org/api/neuron/select?q=species%3Amouse&fq=cell_type%3APurkinje&size=20&sort=neuron_id,asc')
    expect(searchUrl({ region: 'neo"cortex&x=1' })).toBe('https://neuromorpho.org/api/neuron/select?q=brain_region%3Aneocortexx1&size=20&sort=neuron_id,asc')
    expect(searchUrl({})).toBeNull()
    expect(searchUrl({ species: '!!!' })).toBeNull()
  })
  it('reads hits with the paper to cite', () => {
    const r = readHits({ page: { totalElements: 861 }, _embedded: { neuronResources: [{ neuron_name: 'P-1', archive: 'Dusart', species: 'mouse', brain_region: ['cerebellum', 'Purkinje layer'], cell_type: ['Purkinje'], domain: 'Dendrites, Soma, No Axon', reference_doi: ['10.1523/x'] }, { archive: 'no name' }] } })
    expect(r.total).toBe(861)
    expect(r.hits).toEqual([{ name: 'P-1', archive: 'Dusart', species: 'mouse', region: 'cerebellum, Purkinje layer', cellType: 'Purkinje', domain: 'Dendrites, Soma, No Axon', doi: '10.1523/x' }])
    expect(readHits(null)).toEqual({ total: 0, hits: [] })
  })
})

describe('a copy-number table supplied by the user', () => {
  it('reads genes, copies, a label and the volume', () => {
    const t = parseCopyTable('# my table from the paper\n# volume_um3: 0.37\nSyt1\t15000\nSNAP25, 26 000\nbad\tx\n\nVamp2;70000\n')
    expect(t.label).toBe('my table from the paper')
    expect(t.volume).toBe(0.37)
    expect([...t.copies]).toEqual([['syt1', 15000], ['snap25', 26000], ['vamp2', 70000]])
  })
  it('turns copies in a volume into a concentration', () => {
    // 1 立方微米里 602 个分子是 1 µM / 602 molecules in one cubic micron is 1 µM
    expect(copiesToMicromolar(602.2, 1)).toBeCloseTo(1, 3)
    expect(copiesToMicromolar(15000, 0.37)).toBeCloseTo(67.3, 0)
  })
})

describe('PDB format', () => {
  const pdb = [
    'MODEL     1',
    'ATOM      1  N   MET A   1      34.844  15.789  10.320  1.00 32.81           N  ',
    'ATOM      2  CA  MET A   1      34.094  16.547  11.320  1.00 32.81           C  ',
    'ATOM      3  HA  MET A   1      34.000  16.000  11.000  1.00 32.81           H  ',
    'ATOM      4  CA  GLY A   2      30.000  16.000  12.000  1.00 91.50           C  ',
    'ATOM      5  CA  GLY B   1      20.000  16.000  12.000  1.00 80.00           C  ',
    'ENDMDL',
    'ATOM      6  CA  GLY A   1       0.000   0.000   0.000  1.00 99.00           C  ',
  ].join('\n')
  it('reads heavy atoms of the first model, with chains, residue numbers and confidence', () => {
    const m = parsePdb(pdb, 'x')
    expect(m.atomCount).toBe(4)
    expect(m.chains.map((c) => [c.asymId, c.count])).toEqual([['A', 3], ['B', 1]])
    expect(Array.from(m.pos.subarray(3, 6))).toEqual([34.09400177001953, 16.547000885009766, 11.319999694824219])
    expect(Array.from(m.isTrace)).toEqual([0, 1, 1, 1])
    expect(Array.from(m.residue)).toEqual([1, 1, 2, 1])
    expect(Array.from(m.confidence!)).toEqual([32.810001373291016, 32.810001373291016, 91.5, 80])
  })
  it('drops low-confidence atoms when asked, and refuses an empty file', () => {
    expect(parsePdb(pdb, 'x', 50).atomCount).toBe(2)
    expect(() => parsePdb('HEADER', 'x')).toThrow()
  })
})
