// 超大的实例化模型：读取、粗化、打包 / very large instanced models: reading, coarsening, packing
import { describe, expect, it } from 'vitest'
import catalog from '../data/catalog.json'
import { decode, encode, preparedMolecule } from '../src/mol/prepared'
import { allowed } from '../server/structures'
import { atomsPerSphere, pack, readPetworld } from '../server/tools/petworld'

// 两种对象：一小块膜（一条脂质链，3 份拷贝）和一个蛋白（一条蛋白链加一条脂质链，2 份拷贝）
// two kinds of object: a patch of membrane (one lipid chain, 3 copies) and a protein (a protein chain and a lipid chain, 2 copies)
const atom = (n: number, el: string, asym: string, x: number, model: number) => `ATOM ${n} ${el} X . ALA ${asym} 1 1 ? ${x.toFixed(3)} 0.000 1.000 1.00 0.00 1 ALA A X ${model}`
const FILE = [
  '# a comment',
  'data_test',
  'loop_',
  '  _pdbx_model.name',
  '  _pdbx_model.instances',
  'patch  3',
  'ProtM  2',
  'loop_',
  '  _pdbx_struct_assembly_gen.assembly_id',
  '  _pdbx_struct_assembly_gen.oper_expression',
  '  _pdbx_struct_assembly_gen.asym_id_list',
  '  _pdbx_struct_assembly_gen.PDB_model_num',
  `1 '(1-3)' "A" 1`,
  `1 '(4-5)' "B,A" 2`,
  'loop_',
  '  _pdbx_struct_oper_list.id',
  ...[1, 2, 3].flatMap((r) => [1, 2, 3].map((c) => `  _pdbx_struct_oper_list.matrix[${r}][${c}]`)),
  ...[1, 2, 3].map((r) => `  _pdbx_struct_oper_list.vector[${r}]`),
  ...[1, 2, 3, 4].map((k) => `${k} 1 0 0 0 1 0 0 0 1 ${k * 100} 0 0`),
  // 最后一个：绕 z 轴转 90 度再平移 / the last: a quarter turn about z, then a shift
  '5 0 -1 0 1 0 0 0 0 1 7 8 9',
  'loop_',
  ...['group_PDB', 'id', 'type_symbol', 'label_atom_id', 'label_alt_id', 'label_comp_id', 'label_asym_id', 'label_entity_id', 'label_seq_id', 'pdbx_PDB_ins_code', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'occupancy', 'B_iso_or_equiv', 'auth_seq_id', 'auth_comp_id', 'auth_asym_id', 'auth_atom_id', 'pdbx_PDB_model_num'].map((c) => `  _atom_site.${c}`),
  ...Array.from({ length: 10 }, (_, i) => atom(i + 1, i % 2 ? 'H' : 'C', 'MEM1', i, 1)),
  ...Array.from({ length: 12 }, (_, i) => atom(i + 11, 'C', 'A', i, 2)),
  ...Array.from({ length: 4 }, (_, i) => atom(i + 23, 'C', 'MEM2', i + 20, 2)),
  'loop_',
  '  _struct_conn.id',
  'covale1 this line must never be read as an atom',
]
async function* lines() {
  for (const l of FILE) yield l
}

describe('instanced all-atom models', () => {
  it('reads objects, transforms and heavy atoms, and stops at the bond table', async () => {
    const { objects, ops } = await readPetworld(lines())
    expect(objects.map((o) => [o.name, o.instances, o.opStart, o.atoms])).toEqual([['patch', 3, 0, 10], ['ProtM', 2, 3, 16]])
    // 氢不留 / hydrogens are dropped
    expect(objects[0]!.chains.map((c) => [c.id, c.xyz.length / 3])).toEqual([['MEM1', 5]])
    expect(objects[1]!.chains.map((c) => [c.id, c.xyz.length / 3])).toEqual([['A', 12], ['MEM2', 4]])
    expect(ops.length).toBe(5 * 12)
    expect(Array.from(ops.subarray(48))).toEqual([0, -1, 0, 7, 1, 0, 0, 8, 0, 0, 1, 9])
  })

  it('picks the smallest atoms-per-sphere that fits the budget', async () => {
    const { objects } = await readPetworld(lines())
    // 不粗化：3×5 + 2×(12+4) = 47 个球 / uncoarsened: 3x5 + 2x(12+4) = 47 spheres
    expect(atomsPerSphere(objects, 47)).toBe(1)
    expect(atomsPerSphere(objects, 46)).toBe(2)
    // 每条链至少一个球：3×1 + 2×2 = 7 / at least one sphere per chain: 3x1 + 2x2 = 7
    expect(atomsPerSphere(objects, 7)).toBe(12)
    for (const budget of [10, 20, 30]) {
      const g = atomsPerSphere(objects, budget)
      const { header } = pack(objects, new Float32Array(60), 'x', budget)
      expect(header.spheresPlaced).toBeLessThanOrEqual(budget)
      expect(header.atomsPerSphere).toBe(g)
    }
  })

  it('merges neighbours along a chain into spheres at their centroid, and counts what was placed', async () => {
    const { objects, ops } = await readPetworld(lines())
    const { header, spheres } = pack(objects, ops, 'x', 20)
    expect(header.atomsPlaced).toBe(3 * 10 + 2 * 16)
    expect(header.heavyPlaced).toBe(3 * 5 + 2 * 16)
    const protein = header.objects[1]!.chains[0]!
    const g = header.atomsPerSphere
    expect(protein.count).toBe(Math.ceil(12 / g))
    // 蛋白链沿 x 从 0 到 11，球心的平均仍是 5.5 / the protein chain runs along x from 0 to 11, and its sphere centres still average 5.5
    let sx = 0
    for (let i = protein.start; i < protein.start + protein.count; i++) sx += spheres[i * 4]!
    expect(sx / protein.count).toBeCloseTo(5.5, 5)
    expect(header.objects[1]!.chains[1]!.lipid).toBe(true)
    expect(protein.lipid).toBe(false)
  })

  it('survives the file format and becomes a drawable structure with every copy in place', async () => {
    const { objects, ops } = await readPetworld(lines())
    const { header, spheres } = pack(objects, ops, 'x', 20)
    const back = decode(encode(header, spheres, ops))
    expect(back.header).toEqual(header)
    expect(Array.from(back.spheres)).toEqual(Array.from(spheres))
    expect(Array.from(back.ops)).toEqual(Array.from(ops))
    const { mol } = preparedMolecule(encode(header, spheres, ops), 'id', 'title')
    expect(mol.entities.map((e) => [e.description, e.kind])).toEqual([['membrane', 'lipid'], ['ProtM', 'protein']])
    // 两种对象里的脂质都归到膜这一个实体 / the lipids of both objects belong to the one membrane entity
    expect(mol.chains.map((c) => mol.entities[c.entity]!.description)).toEqual(['membrane', 'ProtM', 'membrane'])
    const groups = mol.assemblies[0]!.groups
    expect(groups.map((g) => g.operators.length)).toEqual([3, 2])
    // 最后一份拷贝：点 (1,0,0) 转到 (0,1,0) 再平移 / the last copy takes the point (1,0,0) to (0,1,0) and then shifts it
    const m = groups[1]!.operators[1]!
    expect([m[0]! + m[12]!, m[1]! + m[13]!, m[2]! + m[14]!]).toEqual([7, 9, 9])
    expect(() => decode(new Uint8Array(64))).toThrow()
  })

  it('has catalogue entries whose files the local service is allowed to fetch', () => {
    const prepared = catalog.models.filter((m) => m.source.kind === 'prepared')
    expect(prepared.length).toBeGreaterThan(0)
    for (const m of prepared) expect(allowed(m.source.url!)).toBe(true)
    // http 的例外只给这一个主机 / the http exception is for this one host only
    expect(allowed('http://models.rcsb.org/2hhb.bcif')).toBe(false)
    expect(allowed('http://download.yasara.org.evil.example/x')).toBe(false)
  })
})

describe('a Martini coordinate file inside an archive', () => {
  /** 一个只有名字、大小和内容的 tar 条目 / a tar entry with just a name, a size and its content */
  const entry = (name: string, content: string) => {
    const body = new TextEncoder().encode(content)
    const head = new Uint8Array(512)
    head.set(new TextEncoder().encode(name))
    head.set(new TextEncoder().encode(body.length.toString(8).padStart(11, '0') + '\0'), 124)
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512)
    padded.set(body)
    return [head, padded]
  }
  const bead = (resid: number, resname: string, n: number, x: number) => `${String(resid).padStart(5)}${resname.padEnd(5)}${'BB'.padStart(5)}${String(n).padStart(5)}${x.toFixed(3).padStart(8)}${(0).toFixed(3).padStart(8)}${(1).toFixed(3).padStart(8)}`
  // 两条蛋白链（3 个和 2 个残基，残基编号往回跳处分开），然后两个 POPC、一个 CHOL
  // two protein chains (3 and 2 residues, split where the residue number jumps back), then two POPC and one CHOL
  const beads = [
    bead(1, 'MET', 1, 0), bead(1, 'MET', 2, 0.1), bead(2, 'ALA', 3, 0.2), bead(3, 'LYS', 4, 0.3),
    bead(1, 'MET', 5, 5), bead(2, 'GLY', 6, 5.1),
    bead(3, 'POPC', 7, 10), bead(3, 'POPC', 8, 10.1), bead(3, 'POPC', 9, 10.2), bead(4, 'POPC', 10, 11),
    bead(5, 'CHOL', 11, 12),
  ]
  const GRO = ['a title', String(beads.length), ...beads, '   20.00000  20.00000  20.00000'].join('\n') + '\n'

  async function* chunked(parts: Uint8Array[], size: number) {
    const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
    let at = 0
    for (const p of parts) {
      all.set(p, at)
      at += p.length
    }
    for (let i = 0; i < all.length; i += size) yield all.subarray(i, Math.min(all.length, i + size))
  }

  it('finds the file in the archive whatever the chunking, and does not need what follows it', async () => {
    const { tarMemberLines } = await import('../server/tools/gro')
    // 后面跟着一个被截断的大文件 / followed by a large file that is cut off
    const cut = entry('big/trajectory.xtc', 'x'.repeat(5000)).map((p, i) => (i === 1 ? p.subarray(0, 700) : p))
    const parts = [...entry('dir/', ''), ...entry('dir/readme.txt', 'skip me\n'.repeat(100)), ...entry('dir/initial.gro', GRO), ...cut]
    for (const size of [7, 512, 513, 4096, 1 << 20]) {
      const lines: string[] = []
      for await (const l of tarMemberLines(chunked(parts, size), 'dir/initial.gro')) lines.push(l)
      expect(lines.join('\n') + '\n', `chunks of ${size}`).toBe(GRO)
    }
    await expect((async () => {
      for await (const _ of tarMemberLines(chunked(parts, 512), 'dir/missing.gro')) void _
    })()).rejects.toThrow(/missing\.gro/)
  })

  it('splits beads into protein chains and lipid molecules, in ångströms', async () => {
    const { readGro } = await import('../server/tools/gro')
    async function* lines() {
      for (const l of GRO.split('\n')) yield l
    }
    const m = await readGro(lines())
    expect(m.beads).toBe(11)
    expect(m.proteins.map((p) => [p.sequence, p.xyz.length / 3])).toEqual([['MAK', 4], ['MG', 2]])
    expect([...m.others.entries()].map(([k, v]) => [k, v.map((x) => x.xyz.length / 3)])).toEqual([['POPC', [3, 1]], ['CHOL', [1]]])
    // 纳米换成埃 / nanometres become ångströms
    expect(m.proteins[1]!.xyz.slice(0, 3)).toEqual([50, 0, 10])
    async function* short() {
      for (const l of GRO.split('\n').slice(0, 6)) yield l
    }
    await expect(readGro(short())).rejects.toThrow(/11/)
  })

  it('merges beads within a molecule only, and keeps lipid spheres large enough to close the membrane', async () => {
    const { readGro, packGro } = await import('../server/tools/gro')
    async function* lines() {
      for (const l of GRO.split('\n')) yield l
    }
    const m = await readGro(lines())
    const full = packGro(m, 'x', 100)
    expect(full.header.atomsPerSphere).toBe(1)
    expect(full.header.spheres).toBe(11)
    const half = packGro(m, 'x', 7)
    // 每 2 个珠子一个球，但不跨分子：4→2，2→1，3→2，1→1，1→1 / a sphere per 2 beads, never across molecules: 4→2, 2→1, 3→2, 1→1, 1→1
    expect(half.header.atomsPerSphere).toBe(2)
    expect(half.header.spheres).toBe(7)
    expect(half.header.unit).toBe('beads')
    expect(half.header.atomsPlaced).toBe(11)
    const lipid = half.header.objects.find((o) => o.name === 'POPC')!.chains[0]!
    expect(lipid.lipid).toBe(true)
    for (let i = lipid.start; i < lipid.start + lipid.count; i++) expect(half.spheres[i * 4 + 3]).toBeGreaterThanOrEqual(5)
    // 两条蛋白链是两种（长度不同），各自一个对象；脂质归到膜 / the two protein chains are two kinds (different lengths), an object each; lipids go to the membrane
    const { mol } = preparedMolecule(encode(half.header, half.spheres, half.ops), 'id', 'title')
    expect(mol.entities.map((e) => e.kind)).toEqual(['lipid', 'protein', 'protein'])
    expect(mol.assemblies[0]!.groups.length).toBe(4)
    // 并出来的球之间没有残基的分界可画 / there is no residue boundary to draw between merged spheres
    expect(new Set(mol.residue).size).toBe(1)
  })
})
