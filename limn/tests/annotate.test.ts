// 逐残基注释与上色方式 / per-residue annotation and colour modes
import { describe, expect, it } from 'vitest'
import { meanPathogenicity, readFeatures } from '../server/sources/annotations'
import { IDENTITY, type Molecule } from '../src/mol/types'
import { sanitizeEdits } from '../src/refine/edits'
import { chainPainter, confidenceLch, domainLch, pathogenicityLch, PLAIN_LCH, SITE_LCH, unpPosition, type Annotation } from '../src/style/annotate'
import { atomColors, defaultColoring } from '../src/style/assign'

/** 一条 n 个残基的蛋白链，每个残基一个原子；第二条链是 DNA / a protein chain of n residues, one atom each; the second chain is DNA */
function mol(n: number): Molecule {
  const total = n + 4
  return {
    id: 'T', title: 'T', atomCount: total, pos: new Float32Array(total * 3), element: new Uint8Array(total).fill(1), chainOf: Uint32Array.from({ length: total }, (_, i) => (i < n ? 0 : 1)),
    isTrace: new Uint8Array(total), residue: Int32Array.from({ length: total }, (_, i) => (i < n ? i + 1 : i - n + 1)),
    confidence: Float32Array.from({ length: total }, (_, i) => (i < 2 ? 95 : i < 4 ? 80 : 60)),
    chains: [{ asymId: 'C', authAsymId: 'A', entity: 0, start: 0, count: n, model: 1 }, { asymId: 'D', authAsymId: 'B', entity: 1, start: n, count: 4, model: 1 }],
    entities: [{ id: '1', description: 'p', kind: 'protein' }, { id: '2', description: 'd', kind: 'dna' }],
    assemblies: [{ id: 'asym', groups: [{ chains: [0, 1], operators: [IDENTITY] }] }],
  }
}

// 链 C 的残基 1-10 对应 UniProt 的 94-103（像 p53 的 1TUP 那样）/ residues 1-10 of chain C are UniProt 94-103 (as in 1TUP for p53)
const ann: Annotation = {
  chains: { C: { accession: 'P1', segments: [{ from: 1, to: 10, unp: 94 }] } },
  proteins: {
    P1: {
      accession: 'P1', name: 'Test protein',
      features: [{ kind: 'domain', name: 'second', start: 99, end: 101 }, { kind: 'domain', name: 'first', start: 94, end: 96 }, { kind: 'binding', name: 'Zn(2+)', start: 97, end: 97 }, { kind: 'active', name: 'nucleophile', start: 97, end: 97 }],
      pathogenicity: Array.from({ length: 110 }, (_, i) => (i === 93 ? 0 : i === 94 ? 1 : 0.5)),
    },
  },
}

describe('server-side readers', () => {
  it('reduces UniProt features to four kinds and skips the rest', () => {
    const entry = { features: [
      { type: 'Domain', description: 'Kinase', location: { start: { value: 5 }, end: { value: 90 } } },
      { type: 'DNA binding', description: '', location: { start: { value: 102 }, end: { value: 292 } } },
      { type: 'Binding site', location: { start: { value: 176 }, end: { value: 176 } }, ligand: { name: 'Zn(2+)' } },
      { type: 'Active site', description: 'Proton acceptor', location: { start: { value: 35 }, end: { value: 35 } } },
      { type: 'Region', description: 'Disordered', location: { start: { value: 1 }, end: { value: 4 } } },
      { type: 'Site', description: 'x', location: { start: {}, end: {} } },
    ] }
    expect(readFeatures(entry)).toEqual([
      { kind: 'domain', name: 'Kinase', start: 5, end: 90 },
      { kind: 'domain', name: 'DNA binding', start: 102, end: 292 },
      { kind: 'binding', name: 'Zn(2+)', start: 176, end: 176 },
      { kind: 'active', name: 'Proton acceptor', start: 35, end: 35 },
    ])
  })

  it('averages AlphaMissense scores per position', () => {
    expect(meanPathogenicity('protein_variant,am_pathogenicity,am_class\nM1A,0.2,x\nM1C,0.4,x\nE3K,1,x\n')).toEqual([0.3, 0, 1])
  })
})

describe('colour modes', () => {
  it('maps a chain residue number to its UniProt position', () => {
    expect(unpPosition(ann, 'C', 1)).toBe(94)
    expect(unpPosition(ann, 'C', 10)).toBe(103)
    expect(unpPosition(ann, 'C', 11)).toBeNull()
    expect(unpPosition(ann, 'Z', 1)).toBeNull()
  })

  it('colours domains in sequence order and leaves the rest plain', () => {
    const paint = chainPainter('domains', mol(10), 0, ann)!
    expect(paint(0)).toEqual(domainLch(0)) // 94: "first"
    expect(paint(5)).toEqual(domainLch(1)) // 99: "second"
    expect(paint(3)).toEqual(PLAIN_LCH) // 97: in no domain
  })

  it('lets an active site win over a binding site at the same residue', () => {
    const paint = chainPainter('sites', mol(10), 0, ann)!
    expect(paint(3)).toEqual(SITE_LCH.active)
    expect(paint(0)).toEqual(PLAIN_LCH)
  })

  it('reads pathogenicity at the UniProt position, and confidence from the model', () => {
    const m = mol(10)
    const paint = chainPainter('pathogenicity', m, 0, ann)!
    expect(paint(0)).toEqual(pathogenicityLch(0))
    expect(paint(1)).toEqual(pathogenicityLch(1))
    expect(chainPainter('confidence', m, 0, null)!(0)).toEqual(confidenceLch(95))
    expect(chainPainter('confidence', { ...m, confidence: undefined }, 0, null)).toBeNull()
  })

  it('never repaints nucleic acid, and falls back to roles when there is no data', () => {
    const m = mol(10)
    expect(chainPainter('domains', m, 1, ann)).toBeNull()
    expect(chainPainter('domains', m, 0, null)).toBeNull()
    expect(chainPainter('role', m, 0, ann)).toBeNull()
    const base = defaultColoring(m)
    const byRole = atomColors(m, base)
    const byDomain = atomColors(m, { ...base, mode: 'domains' }, undefined, ann)
    // 蛋白变了，DNA 没变 / the protein changed, the DNA did not
    expect(Array.from(byDomain.subarray(0, 4))).not.toEqual(Array.from(byRole.subarray(0, 4)))
    expect(Array.from(byDomain.subarray(40))).toEqual(Array.from(byRole.subarray(40)))
    // 没有注释时，颜色和按角色完全一样 / without annotation, colours are exactly those by role
    expect(Array.from(atomColors(m, { ...base, mode: 'domains' }, undefined, null))).toEqual(Array.from(byRole))
  })

  it('accepts only known colour modes from a reviewer', () => {
    expect(sanitizeEdits([{ op: 'color_mode', mode: 'domains' }, { op: 'color_mode', mode: 'rainbow' }], [['1']])).toEqual([{ op: 'color_mode', mode: 'domains' }])
  })
})
