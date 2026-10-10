import { CIF, type CifBlock, type CifCategory } from 'molstar/lib/mol-io/reader/cif'
import { mul4, parseOperExpression } from './assembly'
import { El, IDENTITY, type Assembly, type Chain, type Entity, type EntityKind, type Molecule } from './types'

const WATER = new Set(['HOH', 'DOD', 'WAT'])
const LIPID = new Set(['POV', 'PCW', 'CLR', 'PLM', 'OLC', 'LHG', 'CDL', 'PEE', 'PGV', 'Y01', 'LMT', 'POPC'])

function elementOf(sym: string): El {
  switch (sym.toUpperCase()) {
    case 'C': return El.C
    case 'N': return El.N
    case 'O': return El.O
    case 'S': case 'SE': return El.S
    case 'P': return El.P
    default: return El.Other
  }
}

function col(cat: CifCategory, name: string) {
  const f = cat.getField(name)
  if (!f) throw new Error(`mmCIF 缺少字段 ${cat.name}.${name}`)
  return f
}

function entityKinds(block: CifBlock): Map<string, Entity> {
  const out = new Map<string, Entity>()
  const polyType = new Map<string, string>()
  const poly = block.categories['entity_poly']
  if (poly) {
    const id = col(poly, 'entity_id'), type = col(poly, 'type')
    for (let i = 0; i < poly.rowCount; i++) polyType.set(id.str(i), type.str(i).toLowerCase())
  }
  const ent = block.categories['entity']
  if (!ent) return out
  const id = col(ent, 'id'), type = col(ent, 'type')
  const desc = ent.getField('pdbx_description')
  for (let i = 0; i < ent.rowCount; i++) {
    const t = type.str(i).toLowerCase()
    let kind: EntityKind = 'ligand'
    if (t === 'water') kind = 'water'
    else if (t === 'branched') kind = 'glycan'
    else if (t === 'polymer') {
      const p = polyType.get(id.str(i)) ?? ''
      if (p.includes('ribonucleotide') && !p.includes('deoxy')) kind = 'rna'
      else if (p.includes('nucleotide')) kind = 'dna'
      else kind = 'protein'
    }
    out.set(id.str(i), { id: id.str(i), description: desc ? desc.str(i) : '', kind })
  }
  return out
}

function readAssemblies(block: CifBlock, chains: Chain[]): Assembly[] {
  const au: Assembly = { id: 'asym', groups: [{ chains: chains.map((_, i) => i), operators: [IDENTITY] }] }
  const gen = block.categories['pdbx_struct_assembly_gen']
  const ops = block.categories['pdbx_struct_oper_list']
  if (!gen || !ops) return [au]

  const opById = new Map<string, Float32Array>()
  const opId = col(ops, 'id')
  for (let i = 0; i < ops.rowCount; i++) {
    const m = new Float32Array(16)
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) m[c * 4 + r] = col(ops, `matrix[${r + 1}][${c + 1}]`).float(i)
      m[12 + r] = col(ops, `vector[${r + 1}]`).float(i)
    }
    m[15] = 1
    opById.set(opId.str(i), m)
  }

  const byAsym = new Map<string, number[]>()
  chains.forEach((c, i) => {
    const l = byAsym.get(c.asymId)
    if (l) l.push(i)
    else byAsym.set(c.asymId, [i])
  })

  const order: string[] = []
  const byId = new Map<string, Assembly>()
  const aid = col(gen, 'assembly_id'), expr = col(gen, 'oper_expression'), asyms = col(gen, 'asym_id_list')
  for (let i = 0; i < gen.rowCount; i++) {
    const id = aid.str(i)
    let a = byId.get(id)
    if (!a) {
      a = { id, groups: [] }
      byId.set(id, a)
      order.push(id)
    }
    const operators: Float32Array[] = []
    for (const seq of parseOperExpression(expr.str(i))) {
      let m: Float32Array = IDENTITY
      for (const oid of seq) {
        const o = opById.get(oid)
        if (!o) throw new Error(`组装体 ${id} 引用了不存在的对称算符 ${oid}`)
        m = mul4(m, o)
      }
      operators.push(m)
    }
    const idx: number[] = []
    for (const s of asyms.str(i).split(',')) idx.push(...(byAsym.get(s.trim()) ?? []))
    // Waters are dropped at load, so a row may end up with no chains.
    if (idx.length && operators.length) a.groups.push({ chains: idx, operators })
  }
  return [au, ...order.map((id) => byId.get(id)!).filter((a) => a.groups.length)]
}

export async function parseCif(data: Uint8Array | string, id: string): Promise<Molecule> {
  const parsed = await (typeof data === 'string' ? CIF.parseText(data) : CIF.parseBinary(data)).run()
  if (parsed.isError) throw new Error(`无法解析 ${id}: ${parsed.message}`)
  const block = parsed.result.blocks[0]
  if (!block) throw new Error(`${id} 里没有数据块`)
  const site = block.categories['atom_site']
  if (!site || site.rowCount === 0) throw new Error(`${id} 没有原子坐标`)

  const entityInfo = entityKinds(block)
  const n = site.rowCount
  const x = col(site, 'Cartn_x').toFloatArray(), y = col(site, 'Cartn_y').toFloatArray(), z = col(site, 'Cartn_z').toFloatArray()
  const sym = col(site, 'type_symbol'), comp = col(site, 'label_comp_id'), asym = col(site, 'label_asym_id')
  const ent = col(site, 'label_entity_id'), seq = col(site, 'label_seq_id'), aseq = site.getField('auth_seq_id')
  const aasym = site.getField('auth_asym_id'), alt = site.getField('label_alt_id'), model = site.getField('pdbx_PDB_model_num')
  const firstModel = model ? model.int(0) : 1

  const pos = new Float32Array(n * 3), element = new Uint8Array(n), chainOf = new Uint32Array(n), residue = new Int32Array(n)
  const chains: Chain[] = []
  const entities: Entity[] = []
  const entityIndex = new Map<string, number>()
  let count = 0
  let cur: Chain | undefined
  let firstAlt = ''
  for (let i = 0; i < n; i++) {
    if (model && model.int(i) !== firstModel) break
    const s = sym.str(i)
    if (s === 'H' || s === 'D') continue
    const c = comp.str(i)
    if (WATER.has(c)) continue
    if (alt) {
      // Keep one conformer: the first alternate label seen in the file.
      const a = alt.str(i)
      if (a) {
        if (!firstAlt) firstAlt = a
        if (a !== firstAlt) continue
      }
    }
    const asymId = asym.str(i)
    if (!cur || cur.asymId !== asymId) {
      const eid = ent.str(i)
      let ei = entityIndex.get(eid)
      if (ei === undefined) {
        const info = entityInfo.get(eid) ?? { id: eid, description: '', kind: 'ligand' as EntityKind }
        ei = entities.length
        entities.push({ ...info })
        entityIndex.set(eid, ei)
      }
      cur = { asymId, authAsymId: aasym ? aasym.str(i) : asymId, entity: ei, start: count, count: 0 }
      chains.push(cur)
    }
    pos[count * 3] = x[i]!
    pos[count * 3 + 1] = y[i]!
    pos[count * 3 + 2] = z[i]!
    element[count] = elementOf(s)
    chainOf[count] = chains.length - 1
    residue[count] = seq.valueKind(i) === 0 ? seq.int(i) : aseq ? aseq.int(i) : 0
    cur.count++
    count++
  }
  if (count === 0) throw new Error(`${id} 去掉水和氢之后没有原子`)

  // Refine non-polymer kinds from what the chain actually contains.
  for (const ch of chains) {
    const e = entities[ch.entity]!
    if (e.kind !== 'ligand') continue
    const row = findRow(site, asym, ch.asymId)
    const name = row >= 0 ? comp.str(row) : ''
    if (LIPID.has(name)) e.kind = 'lipid'
    else if (ch.count === 1) e.kind = 'ion'
  }

  const title = block.categories['struct']?.getField('title')?.str(0) ?? ''
  return {
    id: id.toUpperCase(),
    title,
    atomCount: count,
    pos: pos.slice(0, count * 3),
    element: element.slice(0, count),
    chainOf: chainOf.slice(0, count),
    residue: residue.slice(0, count),
    chains,
    entities,
    assemblies: readAssemblies(block, chains),
  }
}

function findRow(site: CifCategory, asym: ReturnType<typeof col>, id: string): number {
  for (let i = 0; i < site.rowCount; i++) if (asym.str(i) === id) return i
  return -1
}

export type Source = { kind: 'pdb'; id: string } | { kind: 'url'; url: string; id: string }

export async function loadMolecule(src: Source): Promise<Molecule> {
  const url = src.kind === 'pdb' ? `https://models.rcsb.org/${src.id.toLowerCase()}.bcif` : src.url
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载 ${src.id} 失败（HTTP ${res.status}）`)
  const buf = new Uint8Array(await res.arrayBuffer())
  // BinaryCIF is MessagePack; text CIF starts with "data_".
  const isText = buf[0] === 0x64 && buf[1] === 0x61 && buf[2] === 0x74 && buf[3] === 0x61
  return parseCif(isText ? new TextDecoder().decode(buf) : buf, src.id)
}
