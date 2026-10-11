import { parsePdb } from './pdb'
import { CIF, type CifBlock, type CifCategory } from 'molstar/lib/mol-io/reader/cif'
import { mul4, parseOperExpression } from './assembly'
import { El, IDENTITY, type Assembly, type Chain, type Entity, type EntityKind, type Molecule } from './types'
import { t, noteError } from '../i18n'

const WATER = new Set(['HOH', 'DOD', 'WAT'])
const SUGAR = new Set(['NAG', 'NDG', 'MAN', 'BMA', 'FUC', 'FUL', 'GAL', 'GLA', 'GLC', 'BGC', 'SIA', 'XYP', 'A2G', 'NGA', 'BGL', 'AMA', 'AFU', 'BGA', 'ANE', 'AGA'])
const LIPID = new Set(['POV', 'PCW', 'CLR', 'PLM', 'OLC', 'LHG', 'CDL', 'PEE', 'PGV', 'Y01', 'LMT', 'POPC', 'PCH', 'LIP', 'CHL', 'POP', 'DPP', 'LBN', '6OU', 'D39', 'PGW', 'HWP', 'PEA', 'PSE', 'PTY', 'PSF'])
const RNA = new Set(['A', 'C', 'G', 'U', 'RA', 'RC', 'RG', 'RU', 'PSU', '5MC', 'OMG', 'OMC', 'OMU', 'H2U', '1MA', '7MG', '2MG', 'M2G', '5MU'])
const DNA = new Set(['DA', 'DC', 'DG', 'DT', 'DU', 'DI'])

/**
 * 没有 entity_poly 表时（介观模型常见），从链的第一个残基名猜它是什么。
 * Without an entity_poly table (common in mesoscale models), guess what a chain is from its first residue name.
 */
function kindFromResidue(name: string, atoms: number): EntityKind {
  if (LIPID.has(name)) return 'lipid'
  if (RNA.has(name)) return 'rna'
  if (DNA.has(name)) return 'dna'
  if (SUGAR.has(name)) return 'glycan'
  return atoms === 1 ? 'ion' : atoms < 12 ? 'ligand' : 'protein'
}

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
  if (!f) throw noteError('error.cif.field', { field: `${cat.name}.${name}` })
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
  const id = col(ent, 'id'), type = ent.getField('type')
  const desc = ent.getField('pdbx_description')
  for (let i = 0; i < ent.rowCount; i++) {
    const t = type ? type.str(i).toLowerCase() : 'polymer'
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
  const cols: ArrayLike<number>[] = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) cols[c * 4 + r] = col(ops, `matrix[${r + 1}][${c + 1}]`).toFloatArray()
    cols[12 + r] = col(ops, `vector[${r + 1}]`).toFloatArray()
  }
  for (let i = 0; i < ops.rowCount; i++) {
    const m = new Float32Array(16)
    for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14]) m[k] = cols[k]![i]!
    m[15] = 1
    opById.set(opId.str(i), m)
  }

  // 介观模型（PetWorld）的每一行只管一个模型里的链 / in PetWorld models each row addresses the chains of one model only
  const genModel = gen.getField('PDB_model_num')
  const byAsym = new Map<string, number[]>()
  chains.forEach((c, i) => {
    // 这类文件的链表用的是 auth_asym_id / these files list chains by auth_asym_id
    const key = genModel ? c.model + '|' + c.authAsymId : c.asymId
    const l = byAsym.get(key)
    if (l) l.push(i)
    else byAsym.set(key, [i])
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
        if (!o) throw noteError('error.assemblyOperator', { id, op: oid })
        m = mul4(m, o)
      }
      operators.push(m)
    }
    const idx: number[] = []
    for (const s of asyms.str(i).split(',')) idx.push(...(byAsym.get(genModel ? genModel.int(i) + '|' + s.trim() : s.trim()) ?? []))
    // 水在加载时已去掉，所以某一行可能最后一条链都不剩。
    // Waters are dropped at load, so a row may end up with no chains.
    if (idx.length && operators.length) a.groups.push({ chains: idx, operators })
  }
  return [au, ...order.map((id) => byId.get(id)!).filter((a) => a.groups.length)]
}

export interface ParseOptions {
  /**
   * 丢弃 B 因子低于此值的原子。AlphaFold 文件在这里存每个残基的置信度（pLDDT）；
   * 低于约 50 时链根本没有被定位，画出来是没有意义的环。
   * Drop atoms whose B-factor is below this. AlphaFold files store the
   * per-residue confidence (pLDDT) there; below about 50 the chain is not
   * placed at all and would draw as meaningless loops.
   */
  minConfidence?: number
}

export async function parseCif(data: Uint8Array | string, id: string, opts: ParseOptions = {}): Promise<Molecule> {
  const parsed = await (typeof data === 'string' ? CIF.parseText(data) : CIF.parseBinary(data)).run()
  if (parsed.isError) throw noteError('error.parse', { id, message: parsed.message })
  const block = parsed.result.blocks[0]
  if (!block) throw noteError('error.noBlock', { id })
  // 整合结构可以完全由粗粒度小球组成，没有原子 / an integrative structure may consist of coarse spheres only, with no atoms
  const beads = block.categories['ihm_sphere_obj_site']
  if (!block.categories['atom_site']?.rowCount && !beads?.rowCount) throw noteError('error.noCoordinates', { id })
  if (!block.categories['atom_site']?.rowCount) return parseBeads(block, id)
  const site = block.categories['atom_site']!

  const entityInfo = entityKinds(block)
  const hasPoly = !!block.categories['entity_poly']
  const n = site.rowCount
  const x = col(site, 'Cartn_x').toFloatArray(), y = col(site, 'Cartn_y').toFloatArray(), z = col(site, 'Cartn_z').toFloatArray()
  const atomName = site.getField('label_atom_id')
  const sym = col(site, 'type_symbol'), comp = col(site, 'label_comp_id'), asym = col(site, 'label_asym_id')
  const ent = col(site, 'label_entity_id'), seq = col(site, 'label_seq_id'), aseq = site.getField('auth_seq_id')
  const aasym = site.getField('auth_asym_id'), alt = site.getField('label_alt_id'), model = site.getField('pdbx_PDB_model_num')
  const firstModel = model ? model.int(0) : 1
  const bfac = opts.minConfidence !== undefined ? site.getField('B_iso_or_equiv') : undefined
  // PetWorld：每个模型是一种对象，名字在 pdbx_model 里；所有模型都要读
  // PetWorld: each model is one kind of object, named in pdbx_model; every model is read
  const objects = block.categories['pdbx_model']
  const allModels = !!model && !!block.categories['pdbx_struct_assembly_gen']?.getField('PDB_model_num')
  const objectName = objects && allModels ? col(objects, 'name') : undefined

  const isTrace = new Uint8Array(n)
  const pos = new Float32Array(n * 3), element = new Uint8Array(n), chainOf = new Uint32Array(n), residue = new Int32Array(n)
  const authResidue = aseq ? new Int32Array(n) : undefined
  const confidence = bfac ? new Float32Array(n) : undefined
  const chains: Chain[] = []
  const firstRow: number[] = []
  const entities: Entity[] = []
  const entityIndex = new Map<string, number>()
  let count = 0
  let cur: Chain | undefined
  let firstAlt = ''
  let curModel = firstModel
  for (let i = 0; i < n; i++) {
    if (model) {
      curModel = model.int(i)
      if (!allModels && curModel !== firstModel) break
    }
    const s = sym.str(i)
    if (s === 'H' || s === 'D') continue
    const c = comp.str(i)
    if (WATER.has(c)) continue
    if (bfac && bfac.float(i) < opts.minConfidence!) continue
    if (alt) {
      // 只保留一个构象：文件里最先出现的那个替代位置标签。
      // Keep one conformer: the first alternate label seen in the file.
      const a = alt.str(i)
      if (a) {
        if (!firstAlt) firstAlt = a
        if (a !== firstAlt) continue
      }
    }
    const asymId = asym.str(i)
    if (!cur || cur.asymId !== asymId || cur.model !== curModel || (objectName !== undefined && LIPID.has(c) !== (entities[cur.entity]!.kind === 'lipid'))) {
      // PetWorld 的一个对象常常自带一小块膜，所以脂质单独算一个实体
      // a PetWorld object often carries its own patch of membrane, so its lipids are an entity of their own
      const lipid = objectName !== undefined && LIPID.has(c)
      const eid = objectName ? 'm' + curModel + (lipid ? 'L' : '') : ent.str(i)
      let ei = entityIndex.get(eid)
      if (ei === undefined) {
        const info = objectName
          ? { id: eid, description: objectName.str(curModel - 1) + (lipid ? ' lipids' : ''), kind: (lipid ? 'lipid' : 'ligand') as EntityKind }
          : (entityInfo.get(eid) ?? { id: eid, description: '', kind: 'ligand' as EntityKind })
        ei = entities.length
        entities.push({ ...info })
        entityIndex.set(eid, ei)
      }
      cur = { asymId, authAsymId: aasym ? aasym.str(i) : asymId, entity: ei, start: count, count: 0, model: curModel }
      chains.push(cur)
      firstRow.push(i)
    }
    pos[count * 3] = x[i]!
    pos[count * 3 + 1] = y[i]!
    pos[count * 3 + 2] = z[i]!
    element[count] = elementOf(s)
    if (atomName && (s === 'C' || s === 'P')) {
      const nm = atomName.str(i)
      if (nm === 'CA' || nm === 'P') isTrace[count] = 1
    }
    chainOf[count] = chains.length - 1
    residue[count] = seq.valueKind(i) === 0 ? seq.int(i) : aseq && aseq.valueKind(i) === 0 ? aseq.int(i) : 0
    if (confidence) confidence[count] = bfac!.float(i)
    if (authResidue) authResidue[count] = aseq!.valueKind(i) === 0 ? aseq!.int(i) : residue[count]!
    cur.count++
    count++
  }
  if (count === 0) throw noteError('error.noAtomsLeft', { id })

  // 实体的种类：有 entity_poly 时只细分非聚合物；没有时按链的内容来定，一个实体取它最大的链
  // Kinds: with entity_poly only non-polymers are refined; without it the chain contents
  // decide, and an entity takes the kind of its largest chain
  const largest = new Map<number, number>()
  chains.forEach((ch, ci) => {
    const e = entities[ch.entity]!
    const name = comp.str(firstRow[ci]!)
    if (!hasPoly || objectName) {
      if (e.kind === 'lipid' && objectName) return
      if ((largest.get(ch.entity) ?? 0) < ch.count) {
        largest.set(ch.entity, ch.count)
        e.kind = kindFromResidue(name, ch.count)
      }
      return
    }
    if (e.kind !== 'ligand') return
    if (SUGAR.has(name)) e.kind = 'glycan'
    else if (LIPID.has(name)) e.kind = 'lipid'
    else if (ch.count === 1) e.kind = 'ion'
  })

  const title = block.categories['struct']?.getField('title')?.str(0) ?? ''
  return {
    id: id.toUpperCase(),
    title,
    atomCount: count,
    pos: pos.slice(0, count * 3),
    element: element.slice(0, count),
    chainOf: chainOf.slice(0, count),
    isTrace: isTrace.slice(0, count),
    residue: residue.slice(0, count),
    authResidue: authResidue?.slice(0, count),
    confidence: confidence?.slice(0, count),
    chains,
    entities,
    assemblies: readAssemblies(block, chains),
  }
}

/**
 * 只有粗粒度小球的整合结构（PDB-IHM）：每个球是一段残基，带自己的半径。只读第一个模型。
 * An integrative structure (PDB-IHM) made only of coarse spheres: each sphere is a stretch of
 * residues with its own radius. Only the first model is read.
 */
function parseBeads(block: CifBlock, id: string): Molecule {
  const cat = block.categories['ihm_sphere_obj_site']!
  const n = cat.rowCount
  const x = col(cat, 'Cartn_x').toFloatArray(), y = col(cat, 'Cartn_y').toFloatArray(), z = col(cat, 'Cartn_z').toFloatArray()
  const rad = col(cat, 'object_radius').toFloatArray()
  const asym = col(cat, 'asym_id'), ent = col(cat, 'entity_id'), seq = col(cat, 'seq_id_begin'), model = col(cat, 'model_id')
  const entityInfo = entityKinds(block)
  const first = model.int(0)
  const pos = new Float32Array(n * 3), radius = new Float32Array(n), residue = new Int32Array(n), chainOf = new Uint32Array(n)
  const chains: Chain[] = [], entities: Entity[] = []
  const entityIndex = new Map<string, number>()
  let count = 0
  let cur: Chain | undefined
  for (let i = 0; i < n; i++) {
    if (model.int(i) !== first) continue
    const asymId = asym.str(i)
    if (!cur || cur.asymId !== asymId) {
      const eid = ent.str(i)
      let ei = entityIndex.get(eid)
      if (ei === undefined) {
        ei = entities.length
        entities.push({ ...(entityInfo.get(eid) ?? { id: eid, description: '', kind: 'protein' as EntityKind }) })
        entityIndex.set(eid, ei)
      }
      cur = { asymId, authAsymId: asymId, entity: ei, start: count, count: 0, model: first }
      chains.push(cur)
    }
    pos[count * 3] = x[i]!
    pos[count * 3 + 1] = y[i]!
    pos[count * 3 + 2] = z[i]!
    radius[count] = rad[i]!
    residue[count] = seq.int(i)
    chainOf[count] = chains.length - 1
    cur.count++
    count++
  }
  return {
    id: id.toUpperCase(),
    title: block.categories['struct']?.getField('title')?.str(0) ?? '',
    atomCount: count,
    pos: pos.slice(0, count * 3),
    // 小球没有元素；按“非碳”处理，整条链一个颜色 / spheres have no element; treated as non-carbon so a chain is one colour
    element: new Uint8Array(count).fill(El.N),
    radius: radius.slice(0, count),
    chainOf: chainOf.slice(0, count),
    isTrace: new Uint8Array(count).fill(1),
    residue: residue.slice(0, count),
    chains,
    entities,
    assemblies: [{ id: 'asym', groups: [{ chains: chains.map((_, i) => i), operators: [IDENTITY] }] }],
  }
}

export type Source = { kind: 'pdb'; id: string } | { kind: 'url'; url: string; id: string; minConfidence?: number }

/**
 * 下载一个文件，边下边报告进度；gzip 的内容（按魔数判断）顺手解开。
 * Download a file, reporting progress as it arrives; gzipped content (detected by its magic
 * number) is unpacked on the way.
 */
export async function download(url: string, onProgress?: (received: number, total: number) => void): Promise<Uint8Array | null> {
  const res = await fetch(url)
  if (!res.ok || !res.body) return null
  const total = Number(res.headers.get('content-length') ?? 0)
  const chunks: Uint8Array[] = []
  let received = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onProgress?.(received, total)
  }
  let buf = new Uint8Array(received)
  let o = 0
  for (const c of chunks) {
    buf.set(c, o)
    o += c.length
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
  return buf
}

export async function loadMolecule(src: Source, onProgress?: (received: number, total: number) => void): Promise<Molecule> {
  // RCSB 的压缩版小三倍；没有时退回未压缩的 / RCSB's gzipped files are a third the size; fall back to the plain one
  const urls = src.kind === 'pdb' ? [`https://models.rcsb.org/${src.id.toLowerCase()}.bcif.gz`, `https://models.rcsb.org/${src.id.toLowerCase()}.bcif`] : [src.url]
  let buf: Uint8Array | null = null
  // 先走本地服务（它会把文件缓存在本机），不行再直接从原地址取
  // go through the local service first (it caches the file on this machine), then straight to the source
  for (const url of urls.flatMap((u) => [`/api/structure?url=${encodeURIComponent(u)}`, u])) {
    buf = await download(url, onProgress).catch(() => null)
    if (buf) break
  }
  if (!buf) throw noteError('error.fetchStructure', { id: src.id, host: new URL(urls[0]!).hostname })
  // BinaryCIF 是 MessagePack；文本 CIF 以 "data_" 开头。
  // BinaryCIF is MessagePack; text CIF starts with "data_".
  // PDB 格式的文本（BFVD 只提供这种）：以 MODEL、ATOM、HEADER 等记录开头
  // PDB-format text (all BFVD offers): it starts with a MODEL, ATOM, HEADER or similar record
  const head = new TextDecoder().decode(buf.subarray(0, 6))
  if (/^(MODEL|ATOM|HEADER|REMARK|TITLE|CRYST1)/.test(head)) return parsePdb(new TextDecoder().decode(buf), src.id, src.kind === 'url' ? src.minConfidence : undefined)
  const isText = buf[0] === 0x64 && buf[1] === 0x61 && buf[2] === 0x74 && buf[3] === 0x61
  return parseCif(isText ? new TextDecoder().decode(buf) : buf, src.id, { minConfidence: src.kind === 'url' ? src.minConfidence : undefined })
}
