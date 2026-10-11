// 介观模型：两种文件方言、粗粒度小球、实例表和模型目录
// Mesoscale models: the two file dialects, coarse spheres, the instance table and the catalogue
import { describe, expect, it } from 'vitest'
import catalog from '../data/catalog.json'
import { coarsen } from '../src/mol/coarse'
import { rng } from '../src/landscape/pack'
import { parseCif } from '../src/mol/load'
import { assemblyAtPicks, assemblyAtPoints, parsePicks, readPicks } from '../src/mol/points'
import { buildItem, placedAtomCount } from '../src/scene/build'
import { defaultColoring } from '../src/style/assign'
import { ROLES, TONE_LANDSCAPE } from '../src/style/palettes'

const ATOM_COLS = ['group_PDB', 'id', 'type_symbol', 'label_atom_id', 'label_comp_id', 'label_asym_id', 'label_entity_id', 'label_seq_id', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'auth_asym_id', 'pdbx_PDB_model_num']

function loop(category: string, cols: string[], rows: (string | number)[][]): string {
  return ['loop_', ...cols.map((c) => `_${category}.${c}`), ...rows.map((r) => r.join(' ')), '#'].join('\n')
}

const OPER_COLS = ['id', 'matrix[1][1]', 'matrix[1][2]', 'matrix[1][3]', 'matrix[2][1]', 'matrix[2][2]', 'matrix[2][3]', 'matrix[3][1]', 'matrix[3][2]', 'matrix[3][3]', 'vector[1]', 'vector[2]', 'vector[3]']
const shift = (id: number, x: number) => [id, 1, 0, 0, 0, 1, 0, 0, 0, 1, x, 0, 0]

/** `n` 个残基的一条蛋白链，每个残基 N、CA 两个原子 / a protein chain of `n` residues, atoms N and CA each */
function protein(start: number, n: number, label: string, auth: string, model: number, entity = 1): (string | number)[][] {
  const rows: (string | number)[][] = []
  for (let r = 0; r < n; r++) {
    rows.push(['ATOM', start + r * 2, 'N', 'N', 'ALA', label, entity, r + 1, r * 3.8, 0, model * 10, auth, model])
    rows.push(['ATOM', start + r * 2 + 1, 'C', 'CA', 'ALA', label, entity, r + 1, r * 3.8 + 1, 1, model * 10, auth, model])
  }
  return rows
}

function lipid(start: number, n: number, label: string, auth: string, model: number, comp = 'PCH', entity = 1): (string | number)[][] {
  return Array.from({ length: n }, (_, i) => ['HETATM', start + i, 'C', 'C' + i, comp, label, entity, 1, i, 5, model * 10, auth, model])
}

// PetWorld：对象按模型分开，链名在模型之间重复，算符用区间
// PetWorld: objects are separate models, chain names repeat between models, operators are ranges
const PETWORLD = [
  'data_TEST',
  loop('pdbx_model', ['name', 'instances'], [['Spike', 3], ['Core', 2]]),
  loop('pdbx_struct_assembly', ['id', 'details'], [[1, 'instanced_assembly'], [2, 'x']]),
  loop('pdbx_struct_assembly_gen', ['assembly_id', 'oper_expression', 'asym_id_list', 'PDB_model_num'], [[1, '(1-3)', 'A,B', 1], [1, '(4-5)', 'A', 2]]),
  loop('pdbx_struct_oper_list', OPER_COLS, [1, 2, 3, 4, 5].map((i) => shift(i, i * 100))),
  loop('entity', ['id', 'pdbx_description'], [[1, 'Unknown'], [2, 'Unknown']]),
  loop('atom_site', ATOM_COLS, [...lipid(1, 20, 'MEM1', 'A', 1), ...protein(21, 30, 'P1', 'B', 1), ...protein(81, 25, 'P1', 'A', 2)]),
].join('\n')

// cellPACK：标准的组装体表，但每个算符一行，实体没有类型
// cellPACK: standard assembly tables, but one row per operator and entities without a type
const CELLPACK = [
  'data_TEST',
  loop('entity', ['id', 'pdbx_description'], [[1, 'root.v.membrane.outer_membrane'], [2, 'root.v.interior.proteins.CA'], [3, 'root.v.interior.fibers.gRNA']]),
  loop('pdbx_struct_assembly', ['id', 'details'], [[1, 'cellPACK'], [2, 'x']]),
  loop('pdbx_struct_assembly_gen', ['assembly_id', 'oper_expression', 'asym_id_list'], [[1, '(1)', 'L1,L2'], [1, '(2)', 'L1'], [1, '(3)', 'P'], [1, '(4)', 'P'], [1, '(5)', 'R'], [1, '(6)', 'R']]),
  loop('pdbx_struct_oper_list', OPER_COLS, [1, 2, 3, 4, 5, 6].map((i) => shift(i, i * 100))),
  loop('atom_site', ATOM_COLS, [
    ...lipid(1, 12, 'L1', 'L1', 1, 'LIP', 1),
    ...lipid(13, 12, 'L2', 'L2', 1, 'LIP', 1),
    ...protein(25, 30, 'P', 'P', 1, 2),
    ...Array.from({ length: 50 }, (_, i) => ['ATOM', 85 + i, 'P', 'P', 'A', 'R', 3, i + 1, i * 6, 9, 0, 'R', 1]),
  ]),
].join('\n')

describe('PetWorld 方言 / PetWorld dialect', () => {
  it('reads every model and keys chains by model and author chain', async () => {
    const m = await parseCif(PETWORLD, 'pw')
    expect(m.chains.map((c) => [c.model, c.authAsymId, c.count])).toEqual([[1, 'A', 20], [1, 'B', 60], [2, 'A', 50]])
    expect(m.entities.map((e) => [e.description, e.kind])).toEqual([['Spike lipids', 'lipid'], ['Spike', 'protein'], ['Core', 'protein']])
    const asm = m.assemblies.find((a) => a.id === '1')!
    expect(asm.groups.map((g) => [g.chains, g.operators.length])).toEqual([[[0, 1], 3], [[2], 2]])
    expect(placedAtomCount(m, '1')).toBe(80 * 3 + 50 * 2)
  })
})

describe('cellPACK 方言 / cellPACK dialect', () => {
  it('infers what each entity is from its residues', async () => {
    const m = await parseCif(CELLPACK, 'cp')
    expect(m.entities.map((e) => e.kind)).toEqual(['lipid', 'protein', 'rna'])
  })

  it('merges rows that draw the same atoms and gives each kind the right outline', async () => {
    const m = await parseCif(CELLPACK, 'cp')
    const item = buildItem(m, defaultColoring(m), TONE_LANDSCAPE, { assembly: '1', molecule: 0, perCopy: true })
    // 脂质按单条链：L1 两个拷贝、L2 一个；蛋白两个；RNA 两个
    // lipids by single chain: two copies of L1 and one of L2; two proteins; two RNA segments
    expect(item.instances.count).toBe(7)
    expect(item.draws.map((d) => [d.start, d.count, d.opCount])).toEqual([[0, 12, 2], [12, 12, 1], [24, 60, 2], [84, 50, 2]])
    const mol = (o: number) => item.instances.ids[o * 2 + 1]!
    const flag = (o: number) => item.instances.data[o * 16 + 15]!
    // 膜是一片：所有脂质共用编号 0 / the membrane is one sheet: every lipid shares id 0
    expect([mol(0), mol(1), mol(2)]).toEqual([0, 0, 0])
    // 每个蛋白拷贝是一个分子 / each protein copy is a molecule of its own
    expect(mol(3)).not.toBe(mol(4))
    // 纤维的片段共用一个编号，并标记为细丝 / segments of a fibre share one id and are flagged as strands
    expect(mol(5)).toBe(mol(6))
    expect([flag(3), flag(5)]).toEqual([1, 2])
    // 实例的中心随算符移动 / an instance's centre moves with its operator
    expect(item.instances.data[4 * 16 + 12]! - item.instances.data[3 * 16 + 12]!).toBeCloseTo(100)
  })
})

describe('粗粒度 / coarse models', () => {
  it('reads an integrative model made of spheres, first model only', async () => {
    const cif = [
      'data_TEST',
      loop('entity', ['id', 'type', 'pdbx_description'], [[1, 'polymer', 'Nup84']]),
      loop('ihm_sphere_obj_site', ['id', 'entity_id', 'seq_id_begin', 'seq_id_end', 'asym_id', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'object_radius', 'rmsf', 'model_id'],
        [[1, 1, 1, 10, 'A', 0, 0, 0, 8.5, 0, 1], [2, 1, 11, 20, 'A', 12, 0, 0, 8.5, 0, 1], [3, 1, 1, 10, 'A', 0, 0, 50, 8.5, 0, 2]]),
    ].join('\n')
    const m = await parseCif(cif, 'ihm')
    expect(m.atomCount).toBe(2)
    expect(Array.from(m.radius!)).toEqual([8.5, 8.5])
    expect(m.entities[0]!.description).toBe('Nup84')
  })

  it('keeps one sphere per residue and thins lipids', async () => {
    const m = await parseCif(PETWORLD, 'pw')
    const c = coarsen(m)
    // 20 个脂质原子留 1-2 个；蛋白每个残基一个 / 20 lipid atoms leave one or two; proteins one per residue
    expect(c.chains.map((ch) => ch.count)).toEqual([1, 30, 25])
    expect(c.radius!.every((r) => r > 3)).toBe(true)
    expect(c.assemblies).toBe(m.assemblies)
    expect(placedAtomCount(c, '1')).toBe(31 * 3 + 25 * 2)
  })
})

describe('模型目录 / the catalogue', () => {
  it('states provenance and licence for every model, and only points at data', () => {
    const ids = new Set<string>()
    for (const m of catalog.models) {
      expect(ids.has(m.id)).toBe(false)
      ids.add(m.id)
      for (const k of ['title', 'titleEn', 'caption', 'licence', 'attribution', 'citation', 'link'] as const) expect(m[k], `${m.id}.${k}`).toBeTruthy()
      expect(['measured', 'curated', 'predicted', 'estimated']).toContain(m.tier)
      if (m.source.kind === 'pdb') expect(m.source.id).toMatch(/^[0-9][A-Z0-9]{3}$/)
      else expect(m.source.url).toMatch(/^https:\/\//)
      for (const [pattern, role] of (m as { roles?: string[][] }).roles ?? []) {
        expect(() => new RegExp(pattern!)).not.toThrow()
        expect(ROLES as string[]).toContain(role)
      }
    }
  })
})

// 实测的粒子位置 / measured particle positions
describe('particle picks', () => {
  const ndjson = [
    '{"type": "orientedPoint", "location": {"x": 10, "y": 20, "z": 30}, "xyz_rotation_matrix": [[1,0,0],[0,1,0],[0,0,1]]}',
    '',
    'not json',
    '{"type": "orientedPoint", "location": {"x": 1.5, "y": 0, "z": -2}}',
    '{"type": "point"}',
  ].join('\n')

  it('reads positions in voxels and returns Å', () => {
    expect(Array.from(parsePicks(ndjson, 2))).toEqual([20, 40, 60, 3, 0, -4])
  })

  it('puts the centre of the molecule at every position, whatever the orientation', async () => {
    const m = await parseCif(PETWORLD, 'pw')
    const pts = parsePicks(ndjson, 2)
    const asm = assemblyAtPoints(m, 'asym', pts, rng(3))
    m.assemblies.push(asm)
    expect(placedAtomCount(m, 'picks')).toBe(m.atomCount * 2)
    // 分子自己的中心 / the molecule's own centre
    const c = [0, 0, 0]
    for (let i = 0; i < m.atomCount; i++) for (let k = 0; k < 3; k++) c[k]! += m.pos[i * 3 + k]! / m.atomCount
    const ops = asm.groups[0]!.operators
    expect(ops.length).toBe(2)
    ops.forEach((op, i) => {
      const moved = [0, 1, 2].map((k) => op[k]! * c[0]! + op[4 + k]! * c[1]! + op[8 + k]! * c[2]! + op[12 + k]!)
      // 采样估计的中心与精确中心差不了几 Å / the sampled centre is within a few Å of the exact one
      for (let k = 0; k < 3; k++) expect(Math.abs(moved[k]! - pts[i * 3 + k]!)).toBeLessThan(6)
      // 旋转矩阵是正交的、行列式为 1 / the rotation is orthonormal with determinant 1
      const det = op[0]! * (op[5]! * op[10]! - op[6]! * op[9]!) - op[4]! * (op[1]! * op[10]! - op[2]! * op[9]!) + op[8]! * (op[1]! * op[6]! - op[2]! * op[5]!)
      expect(det).toBeCloseTo(1, 5)
    })
    // 两个拷贝的朝向不同 / the two copies are turned differently
    expect(ops[0]![0]).not.toBeCloseTo(ops[1]![0]!, 3)
  })
})

// 实测的朝向 / measured orientations
describe('oriented picks', () => {
  const line = (x: number, m: number[][]) => JSON.stringify({ type: 'orientedPoint', location: { x, y: 0, z: 0 }, xyz_rotation_matrix: m })
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  // 绕 z 转 90 度：x -> y / a quarter turn about z: x goes to y
  const Rz = [[0, -1, 0], [1, 0, 0], [0, 0, 1]]

  it('reads the matrices, and reports none when any is missing', () => {
    const r = readPicks([line(1, I), line(2, Rz)].join('\n'), 10)
    expect(Array.from(r.points)).toEqual([10, 0, 0, 20, 0, 0])
    expect(Array.from(r.rotations!.subarray(9))).toEqual([0, -1, 0, 1, 0, 0, 0, 0, 1])
    expect(readPicks([line(1, I), '{"type":"point","location":{"x":1,"y":2,"z":3}}'].join('\n'), 1).rotations).toBeNull()
  })

  it('puts a point of the model at x + R (Q (p - c) + k)', async () => {
    const m = await parseCif(PETWORLD, 'pw')
    const { points, rotations } = readPicks([line(100, I), line(200, Rz)].join('\n'), 1)
    const fit = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], centre: [5, 6, 7] as [number, number, number], shift: [10, 0, 0] as [number, number, number], mirrored: false }
    const ops = assemblyAtPicks(m, 'asym', points, rotations!, fit).groups[0]!.operators
    const at = (op: Float32Array, p: number[]) => [0, 1, 2].map((k) => op[k]! * p[0]! + op[4 + k]! * p[1]! + op[8 + k]! * p[2]! + op[12 + k]!)
    // 参考点加 (1,0,0)：第一个粒子不转，落在 100 + 1 + 10 / the reference point plus (1,0,0): the first particle is not turned, so it lands at 100 + 1 + 10
    expect(at(ops[0]!, [6, 6, 7])).toEqual([111, 0, 0])
    // 第二个粒子把 x 转到 y / the second particle turns x into y
    const b = at(ops[1]!, [6, 6, 7])
    expect(b[0]).toBeCloseTo(200)
    expect(b[1]).toBeCloseTo(11)
  })

  it('flips the scene, not the molecule, when the tomogram is mirrored', async () => {
    const m = await parseCif(PETWORLD, 'pw')
    const { points, rotations } = readPicks(line(100, Rz), 1)
    const fit = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], centre: [0, 0, 0] as [number, number, number], shift: [0, 0, 0] as [number, number, number], mirrored: true }
    const op = assemblyAtPicks(m, 'asym', points, rotations!, fit).groups[0]!.operators[0]!
    // 位置沿 x 翻转 / the position is flipped along x
    expect(op[12]).toBe(-100)
    // 变换仍是正常的旋转（行列式 +1），所以分子的手性没变 / the transform is still a proper rotation (determinant +1), so the molecule keeps its hand
    const det = op[0]! * (op[5]! * op[10]! - op[6]! * op[9]!) - op[4]! * (op[1]! * op[10]! - op[2]! * op[9]!) + op[8]! * (op[1]! * op[6]! - op[2]! * op[5]!)
    expect(det).toBeCloseTo(1, 6)
  })

  it('has a fit for the ribosome entry of the catalogue, with an orthonormal rotation', () => {
    const fit = (catalog.models.find((x) => x.id === 'mycoplasma-ribosomes-in-situ') as { points: { fit: { rotation: number[]; mirrored: boolean } } }).points.fit
    const q = fit.rotation
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(q[i * 3]! * q[j * 3]! + q[i * 3 + 1]! * q[j * 3 + 1]! + q[i * 3 + 2]! * q[j * 3 + 2]!).toBeCloseTo(i === j ? 1 : 0, 3)
  })
})
