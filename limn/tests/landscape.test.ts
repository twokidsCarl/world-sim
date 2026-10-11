import { describe, expect, it } from 'vitest'
import { packScene } from '../src/landscape/build'
import membraneTable from '../data/membranes.json'
import { parseLipid, parseSdf } from '../src/landscape/lipid'
import { rng } from '../src/landscape/pack'
import { IDENTITY, type Molecule } from '../src/mol/types'
import type { LandscapeSpec } from '../src/scene/spec'
import { BOX, resolveLandscape } from '../server/landscape'
import type { Deps } from '../server/resolve'
import { parseOpm } from '../server/sources/opm'
import { parsePaxdb, ppmToMicromolar } from '../server/sources/paxdb'
import { fitToMembrane } from '../src/landscape/orient'
import type { EntryInfo } from '../server/sources/rcsb'

const entry = (id: string, atoms: number): EntryInfo => ({
  id, title: id, method: 'X-RAY DIFFRACTION', resolution: 2, year: 2010, atoms,
  assemblies: [{ id: '1', atoms, chains: 1, symmetry: 'C1' }],
  entities: [{ entityId: '1', kind: 'protein', description: 'protein ' + id, organism: 'Escherichia coli', chains: 1, length: atoms / 8, uniprot: [] }],
})

function deps(recipe: any, picks: any): Deps {
  let call = 0
  const known = new Map([['1AAA', entry('1AAA', 3000)], ['2BBB', entry('2BBB', 6000)], ['3CCC', entry('3CCC', 150000)]])
  return {
    ask: (async () => (call++ === 0 ? recipe : picks)) as Deps['ask'],
    searchText: async (q) => (q === 'small' ? ['1AAA'] : q === 'medium' ? ['2BBB'] : q === 'big' ? ['3CCC'] : []),
    entryInfo: async (ids) => ids.map((i) => known.get(i)).filter((x): x is EntryInfo => !!x),
    findProtein: async () => [], bestStructures: async () => [], alphafold: async () => null, abundances: async () => null,
  }
}

const ing = (name: string, query: string, uM: number, over: any = {}) => ({
  name, compartment: 'below', concentration_uM: uM, per_square_micron: 0, feature: false, role: 'soluble', queries: [query], suggested_pdb_ids: [], ...over,
})
const recipe = (ingredients: any[], over: any = {}) => ({
  title: 't', caption: 'c', membrane: false, above: '', below: 'cytoplasm', density_above_g_per_L: 0, density_below_g_per_L: 300, notes: [], ingredients, ...over,
})
const pick = (...ids: string[]) => ({ picks: ids.map((id, i) => ({ ingredient: i, source_id: id, assembly_id: '1' })) })

describe('resolveLandscape', () => {
  it('scales ordinary ingredients so the mass drawn matches the stated density', async () => {
    const spec = await resolveLandscape('x', deps(recipe([ing('a', 'small', 100), ing('b', 'medium', 50)]), pick('1AAA', '2BBB')))
    const L = spec.landscape!
    const volume = BOX.width * BOX.height * BOX.depth
    const mass = L.ingredients.reduce((s, x) => s + x.copies * [3000, 6000][x.panel]! * 13.7, 0)
    const gPerL = mass / (volume * 6.022e-4)
    expect(gPerL).toBeGreaterThan(280)
    expect(gPerL).toBeLessThan(320)
    // 比例保持：100 µM 对 50 µM / proportions kept: 100 µM against 50 µM
    expect(L.ingredients[0]!.copies / L.ingredients[1]!.copies).toBeCloseTo(2, 0)
  })

  it('shows a featured molecule once without scaling it, and says the numbers are estimates', async () => {
    const spec = await resolveLandscape('x', deps(recipe([ing('rare', 'big', 0.01, { feature: true, role: 'focus' }), ing('a', 'small', 100)]), pick('3CCC', '1AAA')))
    expect(spec.landscape!.ingredients[0]).toMatchObject({ copies: 1, feature: true })
    expect(spec.notes.join(' ')).toMatch(/估计/)
    expect(spec.notes.join(' ')).toMatch(/随机排布/)
  })

  it('only accepts a structure found for that very ingredient', async () => {
    // 模型给成分 0 指定了一个为成分 1 找到的结构
    // the model assigns ingredient 0 a structure that was found for ingredient 1
    const spec = await resolveLandscape('x', deps(recipe([ing('a', 'small', 100), ing('b', 'medium', 50)]), pick('2BBB', '2BBB')))
    expect(spec.panels.map((p) => p.source.id)).toEqual(['2BBB'])
    expect(spec.notes.join(' ')).toContain('未能画出：a')
  })

  it('uses area, not volume, for membrane proteins', async () => {
    const r = recipe([ing('channel', 'medium', 0, { compartment: 'membrane', per_square_micron: 5000, role: 'membrane' }), ing('a', 'small', 100)], { membrane: true, above: 'outside', density_above_g_per_L: 0 })
    const spec = await resolveLandscape('x', deps(r, pick('2BBB', '1AAA')))
    const m = spec.landscape!.ingredients.find((x) => x.compartment === 'membrane')!
    expect(m.copies).toBe(Math.round(5000 * BOX.width * BOX.depth * 1e-8))
  })
})

// 实测丰度 / measured abundances
describe('PaxDb abundances', () => {
  const file = ['#name: Test organism - Whole organism (Integrated)', '#score: 20', '#gene_name\tstring_external_id\tabundance', 'tufA\t1.b1\t10000', 'gapA\t1.b2\t2000', 'gapA\t1.b2x\t500', 'bad\t1.b3\tNA', ''].join('\n')

  it('reads a dataset file', () => {
    const a = parsePaxdb(file, 1, 'WHOLE_ORGANISM')
    expect(a.name).toBe('Test organism - Whole organism (Integrated)')
    expect([...a.ppm]).toEqual([['tufa', 10000], ['gapa', 2000]])
  })

  it('turns ppm into a concentration', () => {
    // 300 g/L、平均 40 kDa：蛋白总浓度 7.5 mM，1 ppm 是 7.5 nM / at 300 g/L and 40 kDa mean: 7.5 mM of protein in all, so 1 ppm is 7.5 nM
    expect(ppmToMicromolar(1, 300)).toBeCloseTo(0.0075, 6)
    expect(ppmToMicromolar(10000, 300)).toBeCloseTo(75, 3)
  })

  it('replaces the estimate where a gene is found, and says which numbers are which', async () => {
    const d = deps(recipe([ing('EF-Tu', 'small', 1, { genes: ['tufA'] }), ing('other', 'medium', 1, { genes: ['notInPaxdb'] })], { organism_taxid: 1, tissue: 'WHOLE_ORGANISM' }), pick('1AAA', '2BBB'))
    const asked: [number, string][] = []
    const spec = await resolveLandscape('x', { ...d, abundances: async (taxid, tissue) => (asked.push([taxid, tissue ?? '']), parsePaxdb(file, taxid, 'WHOLE_ORGANISM')) })
    expect(asked).toEqual([[1, 'WHOLE_ORGANISM']])
    const [a, b] = spec.landscape!.ingredients
    expect(a!.tier).toBe('curated')
    expect(a!.abundance).toMatch(/PaxDb.*tufA.*10,000 ppm/)
    expect(b!.tier).toBe('estimated')
    // 75 µM 对 1 µM：实测值把比例从 1:1 改成了 75:1 / 75 µM against 1 µM: the measured value turns a 1:1 ratio into 75:1
    expect(a!.copies / b!.copies).toBeGreaterThan(40)
    expect(spec.notes.join(' ')).toMatch(/1 种成分的丰度取自 PaxDb/)
  })

  it('divides a homo-oligomer\'s abundance by its number of chains', async () => {
    const known = entry('1AAA', 3000)
    known.assemblies = [{ id: '1', atoms: 12000, chains: 4, symmetry: 'D2' }]
    const d = deps(recipe([ing('GAPDH', 'small', 1, { genes: ['gapA'] })], { organism_taxid: 1, tissue: 'WHOLE_ORGANISM' }), pick('1AAA'))
    const spec = await resolveLandscape('x', { ...d, entryInfo: async () => [known], abundances: async (t) => parsePaxdb(file, t, 'WHOLE_ORGANISM') })
    // 2000 ppm 的单体，四聚体是 500 ppm，即 3.75 µM / 2,000 ppm of monomer is 500 ppm of tetramer, 3.75 µM
    expect(spec.landscape!.ingredients[0]!.abundance).toMatch(/约 3\.8 μM/)
  })
})

/** 由 `n` 个点组成的一条链，团成凹凸不平的球，充当蛋白质 / A chain of `n` points in a lumpy ball, standing in for a protein. */
function fakeProtein(id: string, n: number, size: number, seed: number): Molecule {
  const r = rng(seed)
  const pos = new Float32Array(n * 3)
  for (let i = 0; i < n * 3; i++) pos[i] = (r() - 0.5) * size
  return {
    id, title: id, atomCount: n, pos, element: new Uint8Array(n), chainOf: new Uint32Array(n), isTrace: new Uint8Array(n), residue: new Int32Array(n),
    chains: [{ asymId: 'A', authAsymId: 'A', entity: 0, start: 0, count: n, model: 1 }],
    entities: [{ id: '1', description: id, kind: 'protein' }],
    assemblies: [{ id: 'asym', groups: [{ chains: [0], operators: [IDENTITY] }] }],
  }
}

const centreOf = (m: Float32Array, mol: Molecule) => {
  let c = [0, 0, 0]
  for (let i = 0; i < mol.atomCount; i++) for (let a = 0; a < 3; a++) c[a]! += mol.pos[i * 3 + a]! / mol.atomCount
  return [0, 1, 2].map((a) => m[a]! * c[0]! + m[4 + a]! * c[1]! + m[8 + a]! * c[2]! + m[12 + a]!)
}

describe('packScene', () => {
  const lipid = parseSdf(['POV', '', '', '  3  0  0  0  0  0  0  0  0  0999 V2000',
    '    0.0000   12.0000    0.0000 P   0  0', '    0.0000    0.0000    0.0000 C   0  0', '    0.0000  -12.0000    0.0000 C   0  0', 'M  END'].join('\n'), 'POV')
  const spec: LandscapeSpec = {
    width: 400, height: 400, depth: 120, membrane: true, above: 'out', below: 'in',
    ingredients: [
      { panel: 0, compartment: 'above', copies: 12, abundance: '', feature: false },
      { panel: 1, compartment: 'below', copies: 12, abundance: '', feature: false },
      { panel: 2, compartment: 'membrane', copies: 2, abundance: '', feature: true },
    ],
  }
  const mols = [fakeProtein('OUT', 600, 40, 1), fakeProtein('IN', 600, 40, 2), fakeProtein('MEM', 900, 50, 3)]
  const packed = packScene(mols.map((mol) => ({ mol, assembly: 'asym' })), spec, lipid, 5)

  it('keeps each kind of molecule on its own side of the membrane', () => {
    expect(packed.places[0]!.length).toBeGreaterThan(6)
    for (const m of packed.places[0]!) expect(centreOf(m, mols[0]!)[1]!).toBeGreaterThan(20)
    for (const m of packed.places[1]!) expect(centreOf(m, mols[1]!)[1]!).toBeLessThan(-20)
    for (const m of packed.places[2]!) expect(Math.abs(centreOf(m, mols[2]!)[1]!)).toBeLessThan(1)
  })

  it('lays two leaflets of lipid, heads outward, leaving room for membrane proteins', () => {
    const placed = packed.lipids.flatMap((l) => l.places)
    expect(placed.length).toBeGreaterThan(500)
    let up = 0, down = 0
    for (const m of placed) {
      // 磷原子（第一个原子）是头部 / the phosphorus (first atom) is the head
      const headY = m[1]! * 0 + m[5]! * 12 + m[13]!
      const tailY = m[1]! * 0 + m[5]! * -12 + m[13]!
      expect(Math.abs(headY)).toBeGreaterThan(Math.abs(tailY))
      headY > 0 ? up++ : down++
    }
    expect(Math.abs(up - down)).toBeLessThan(0.1 * placed.length)
    // 比同样大小的裸膜能容纳的脂质少
    // fewer lipids than a bare membrane of this size would hold
    const bare = packScene(mols.map((mol) => ({ mol, assembly: 'asym' })), { ...spec, ingredients: spec.ingredients.slice(0, 2) }, lipid, 5)
    expect(placed.length).toBeLessThan(bare.lipids.flatMap((l) => l.places).length)
  })

  it('keeps every molecule behind the cut face', () => {
    packed.places.forEach((list, p) => list.forEach((m) => expect(centreOf(m, mols[p]!)[2]!).toBeLessThan(0)))
  })
})

describe('membrane proteins that are only an ectodomain', () => {
  // 沿 x 的一根杆：N 端在 x = 0，C 端在 x = 80
  // a rod along x: N-terminus at x = 0, C-terminus at x = 80
  const n = 80
  const rod: Molecule = {
    ...fakeProtein('ROD', n, 1, 1),
    pos: new Float32Array(Array.from({ length: n }, (_, i) => [i, Math.sin(i) * 3, Math.cos(i) * 3]).flat()),
    isTrace: new Uint8Array(n).fill(1),
    residue: new Int32Array(Array.from({ length: n }, (_, i) => i + 1)),
  }
  const scene = (anchor: 'above' | 'below', terminus: 'N' | 'C'): LandscapeSpec => ({
    width: 300, height: 400, depth: 120, membrane: true, above: 'out', below: 'in',
    ingredients: [{ panel: 0, compartment: 'membrane', copies: 3, abundance: '', feature: true, anchor, terminus }],
  })
  const at = (m: Float32Array, i: number) => m[1]! * rod.pos[i * 3]! + m[5]! * rod.pos[i * 3 + 1]! + m[9]! * rod.pos[i * 3 + 2]! + m[13]!

  it('stands on the stated face with the stated end of the chain at the membrane', () => {
    for (const [anchor, terminus] of [['above', 'C'], ['above', 'N'], ['below', 'C'], ['below', 'N']] as const) {
      const packed = packScene([{ mol: rod, assembly: 'asym' }], scene(anchor, terminus), null, 3)
      expect(packed.places[0]!.length).toBe(3)
      for (const m of packed.places[0]!) {
        const near = at(m, terminus === 'N' ? 0 : n - 1), far = at(m, terminus === 'N' ? n - 1 : 0)
        const side = anchor === 'above' ? 1 : -1
        // 整个分子都在膜外，在正确的一侧……
        // the whole molecule is outside the membrane, on the right side...
        expect(near * side).toBeGreaterThan(15)
        // ……并且被锚定的一端是离膜更近的那端
        // ...and the anchored end is the one nearer the membrane
        expect(Math.abs(near)).toBeLessThan(Math.abs(far))
        expect(Math.abs(near)).toBeLessThan(40)
      }
    }
  })
})

// 膜内取向 / orientation in the membrane
describe('OPM orientation', () => {
  /** 沿 z 的一根“螺旋”，n 个残基 / a "helix" along z with n residues */
  const helix = (n: number): Molecule => {
    const pos = new Float32Array(n * 3)
    const authResidue = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      pos.set([Math.cos(i * 1.7) * 2.3 + i * 0.05, Math.sin(i * 1.7) * 2.3, i * 1.5 - (n * 1.5) / 2], i * 3)
      authResidue[i] = 101 + i
    }
    return {
      id: 'TM', title: 'TM', atomCount: n, pos, element: new Uint8Array(n), chainOf: new Uint32Array(n), isTrace: new Uint8Array(n).fill(1), residue: Int32Array.from({ length: n }, (_, i) => i + 1), authResidue,
      chains: [{ asymId: 'A', authAsymId: 'X', entity: 0, start: 0, count: n, model: 1 }],
      entities: [{ id: '1', description: 'TM', kind: 'protein' }],
      assemblies: [{ id: 'asym', groups: [{ chains: [0], operators: [IDENTITY] }] }],
    }
  }
  /** 把分子转一下、挪一下，写成 OPM 那样的 PDB 文件 / turn and move the molecule and write it out as an OPM-style PDB file */
  const opmFile = (mol: Molecule, half: number, chain = 'X') => {
    const lines = [`REMARK      1/2 of bilayer thickness:   ${half.toFixed(1)}`]
    for (let i = 0; i < mol.atomCount; i++) {
      // 绕 x 轴转 90 度（z -> y），再平移 / rotate 90 degrees about x (z -> y), then translate
      const x = mol.pos[i * 3]! + 7, y = -mol.pos[i * 3 + 2]! + 3, z = mol.pos[i * 3 + 1]! - 4
      const f = (v: number) => v.toFixed(3).padStart(8)
      lines.push(`ATOM  ${String(i + 1).padStart(5)}  CA  ALA ${chain}${String(mol.authResidue![i]).padStart(4)}    ${f(x)}${f(y)}${f(z)}  1.00  0.00           C`)
    }
    return lines.join('\n')
  }

  it('reads the half-thickness and the Cα positions, keyed by author chain and residue number', () => {
    const o = parseOpm(opmFile(helix(30), 15.4), '1abc')!
    expect(o.half).toBe(15.4)
    expect(o.keys[0]).toBe('X:101')
    expect(o.keys.length).toBe(30)
    expect(parseOpm('HEADER nothing here', '1abc')).toBeNull()
  })

  it('recovers the rigid motion exactly, using author numbering', () => {
    const mol = helix(30)
    const fit = fitToMembrane(mol, parseOpm(opmFile(mol, 15.4), '1abc')!)!
    expect(fit.matched).toBe(30)
    expect(fit.rmsd).toBeLessThan(0.01)
    // 原来沿 z 的轴，在膜坐标系里沿 -y / the axis that ran along z runs along -y in the membrane frame
    const m = fit.matrix
    expect([m[8]!, m[9]!, m[10]!].map((v) => Math.round(v))).toEqual([0, -1, 0])
  })

  it('refuses when chain names do not correspond', () => {
    const mol = helix(30)
    expect(fitToMembrane(mol, parseOpm(opmFile(mol, 15.4, 'Q'), '1abc')!)).toBeNull()
  })

  it('stands an oriented protein with its outer end on the outer side', () => {
    // 分子的 +z 端在膜坐标系里也是 +z（外侧）/ the molecule's +z end is +z (outside) in the membrane frame too
    const mol = helix(40)
    const fit = { matrix: IDENTITY, half: 15, matched: 40, rmsd: 0 }
    const scene = (outer: 'above' | 'below'): LandscapeSpec => ({ width: 300, height: 300, depth: 100, membrane: true, outer, above: '', below: '', ingredients: [{ panel: 0, compartment: 'membrane', copies: 3, abundance: '', feature: false }] })
    for (const outer of ['above', 'below'] as const) {
      const packed = packScene([{ mol, assembly: 'asym', membrane: fit }], scene(outer), null, 1)
      expect(packed.places[0]!.length).toBe(3)
      for (const m of packed.places[0]!) {
        const top = [0, 0, 30], y = m[1]! * top[0]! + m[5]! * top[1]! + m[9]! * top[2]! + m[13]!
        expect(outer === 'above' ? y : -y).toBeCloseTo(30, 3)
      }
    }
  })
})

// 脂质：尾链的摆法和按组成混排 / lipids: how tails are posed, and mixing to a composition
describe('lipids', () => {
  /** 一个示意的双链脂质：头基朝 +y，两条 9 个碳的尾链分别朝 +x 和 -x 伸出去（像数据库里的理想构象）/ a schematic two-chained lipid: head towards +y, two nine-carbon tails stretched towards +x and -x, like a database ideal conformer */
  const sdf = () => {
    const atoms: [string, number, number, number][] = [['N', 0, 4.5, 0], ['P', 0, 3, 0], ['O', 0, 1.5, 0], ['C', 0, 0, 0], ['O', 1.4, 0, 0], ['O', -1.4, 0, 0]]
    const bonds: [number, number][] = [[1, 2], [2, 3], [3, 4], [4, 5], [4, 6]]
    for (const [side, anchor] of [[1, 5], [-1, 6]] as const) {
      let prev: number = anchor
      for (let k = 1; k <= 9; k++) {
        atoms.push(['C', side * (1.4 + k * 1.5), 0, 0])
        bonds.push([prev, atoms.length])
        prev = atoms.length
      }
    }
    const f = (v: number) => v.toFixed(4).padStart(10)
    return ['L', '', '', `${String(atoms.length).padStart(3)}${String(bonds.length).padStart(3)}  0  0  0  0  0  0  0  0999 V2000`,
      ...atoms.map(([el, x, y, z]) => `${f(x)}${f(y)}${f(z)} ${el.padEnd(3)} 0  0`), ...bonds.map(([a, b]) => `${String(a).padStart(3)}${String(b).padStart(3)}  1  0`), 'M  END'].join('\n')
  }

  it('turns both tails away from the head without changing any bond length', () => {
    const before = parseSdf(sdf(), 'L')
    const { mol, tails } = parseLipid(sdf(), 'L')
    expect(tails).toBe(2)
    const y = (i: number) => mol.pos[i * 3 + 1]!
    // 两条尾链的末端（第 15 和第 24 个原子）都到了头基的另一侧 / both tail tips (atoms 15 and 24) are now on the far side from the head
    expect(y(14)).toBeLessThan(-10)
    expect(y(23)).toBeLessThan(-10)
    expect(y(0)).toBeCloseTo(4.5, 5)
    const d = (m: typeof mol, a: number, b: number) => Math.hypot(m.pos[a * 3]! - m.pos[b * 3]!, m.pos[a * 3 + 1]! - m.pos[b * 3 + 1]!, m.pos[a * 3 + 2]! - m.pos[b * 3 + 2]!)
    const bonds: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [3, 5], [4, 6], [5, 15]]
    for (let k = 6; k < 14; k++) bonds.push([k, k + 1] as [number, number])
    for (let k = 15; k < 23; k++) bonds.push([k, k + 1] as [number, number])
    for (const [a, b] of bonds) expect(d(mol, a, b)).toBeCloseTo(d(before, a, b), 4)
    // 两条尾链并排，相距几 Å / the two tails lie side by side, a few Å apart
    expect(d(mol, 14, 23)).toBeLessThan(9)
    expect(d(mol, 14, 23)).toBeGreaterThan(3)
  })

  it('leaves a molecule with no tails alone', () => {
    const ring = ['S', '', '', '  3  3  0  0  0  0  0  0  0  0999 V2000', '    0.0000    0.0000    0.0000 C   0  0', '    1.5000    0.0000    0.0000 C   0  0', '    0.7500    1.3000    0.0000 O   0  0', '  1  2  1  0', '  2  3  1  0', '  1  3  1  0', 'M  END'].join('\n')
    const { mol, tails } = parseLipid(ring, 'S')
    expect(tails).toBe(0)
    expect(Array.from(mol.pos)).toEqual(Array.from(parseSdf(ring, 'S').pos))
  })

  it('mixes each leaflet to its own composition, with the outer leaflet on the outer side', () => {
    const a = parseLipid(sdf(), 'A').mol, b = parseLipid(sdf(), 'B').mol
    const set = { outer: [{ cls: 'A', mol: a, fraction: 1, tails: 2 }], inner: [{ cls: 'A', mol: a, fraction: 0.25, tails: 2 }, { cls: 'B', mol: b, fraction: 0.75, tails: 2 }] }
    const scene = (outer: 'above' | 'below'): LandscapeSpec => ({ width: 500, height: 300, depth: 200, membrane: true, outer, above: '', below: '', ingredients: [] })
    for (const outer of ['above', 'below'] as const) {
      const packed = packScene([], scene(outer), set, 2)
      const of = (m: Molecule) => packed.lipids.find((l) => l.mol === m)!.places
      const side = (m: Float32Array) => (m[13]! > 0 ? 'above' : 'below')
      // B 只在内叶 / B is in the inner leaflet only
      expect(of(b).every((m) => side(m) !== outer)).toBe(true)
      const innerA = of(a).filter((m) => side(m) !== outer).length
      const share = of(b).length / (of(b).length + innerA)
      expect(share).toBeGreaterThan(0.7)
      expect(share).toBeLessThan(0.8)
    }
  })

  it('has a source and known lipid classes for every membrane in the table', () => {
    for (const m of membraneTable.membranes) {
      expect(m.citation).toMatch(/doi:10\./)
      expect(m.basis.length).toBeGreaterThan(20)
      expect(m.basisEn.length).toBeGreaterThan(20)
      for (const leaflet of [m.outer, m.inner]) {
        const sum = (Object.values(leaflet) as (number | undefined)[]).reduce<number>((s, v) => s + (v ?? 0), 0)
        expect(sum).toBeGreaterThan(94)
        expect(sum).toBeLessThan(103)
        for (const cls of Object.keys(leaflet)) expect(Object.keys(membraneTable.lipids)).toContain(cls)
      }
    }
  })
})
