/**
 * 把一个很大的 PDB 文件（上千万个原子的整病毒模拟）转成能画的大小。
 *
 * 文件在一个压缩包里，和更大的拓扑文件打在一起；只取压缩包开头到这个文件为止的一段。
 * 这么大的 PDB，原子编号和残基编号早就溢出了，不能用来分分子；能用的是第 73–76 列的“段名”：
 * 同一个段名的一串原子是一条蛋白链、一棵糖链或一片脂质。链的字母（第 22 列）说明它是哪种蛋白，
 * 对照表由目录条目给出。只留重原子；原子数在预算之内时一个原子一个球，不做合并。
 *
 * Turn a very large PDB file (a whole-virion simulation of over ten million atoms) into something
 * small enough to draw.
 *
 * The file sits in an archive together with a still larger topology; only the part of the
 * archive up to the end of this file is fetched. In a PDB this large the atom and residue numbers
 * overflowed long ago and cannot be used to tell molecules apart. What can is the "segment name"
 * in columns 73-76: a run of atoms with one segment name is a protein chain, a glycan or a patch
 * of lipid. The chain letter (column 22) says which protein it is, by a table the catalogue entry
 * supplies. Heavy atoms only; when they fit the budget each atom is a sphere and nothing is merged.
 *
 * 单独运行 / to run on its own:
 *   bun server/tools/bigpdb.ts <目录条目编号 / catalogue id>
 */
import { MAGIC, decode, encode } from '../../src/mol/prepared'
import { cached } from '../structures'
import { gunzipped, tarMemberLines } from './gro'
import { packParts, type Part } from './pack'
import { preparedFile } from './prepared'

const AMINO = new Set('ALA ARG ASN ASP CYS GLN GLU GLY HIS HSD HSE HSP ILE LEU LYS MET PHE PRO SER THR TRP TYR VAL'.split(' '))

export interface BigPdbOptions {
  /** 链的字母 → 蛋白的名字 / chain letter → the protein's name */
  chains: Record<string, string>
  /** 脂质的残基名 / residue names of lipids */
  lipids: string[]
}

export interface BigPdbModel {
  atoms: number
  heavy: number
  parts: Part[]
}

/** 读 PDB 的各行，按段名分成部分 / read the lines of a PDB into parts by segment name */
export async function readBigPdb(lines: AsyncIterable<string>, opts: BigPdbOptions): Promise<BigPdbModel> {
  const lipids = new Set(opts.lipids)
  const model: BigPdbModel = { atoms: 0, heavy: 0, parts: [] }
  /** 每种脂质一个部分，里面每个段是一个“分子”（合并不跨段）/ one part per lipid, each segment in it a "molecule" (merging never crosses segments) */
  const lipidPart = new Map<string, Part>()
  let lastSeg = '\0', lastChain = '', lastLipidKey = ''
  let current: { xyz: number[] } | null = null
  let glycans = 0
  for await (const line of lines) {
    if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) continue
    model.atoms++
    // 原子名在第 13–16 列；氢的名字以 H 开头，或者一个数字后面跟 H / the atom name is in columns 13-16; a hydrogen's starts with H, or with a digit followed by H
    const name = line.slice(12, 16).trim()
    const c0 = name.charCodeAt(0)
    if (c0 === 72 || (c0 >= 48 && c0 <= 57 && name.charCodeAt(1) === 72)) continue
    const x = Number(line.slice(30, 38)), y = Number(line.slice(38, 46)), z = Number(line.slice(46, 54))
    if (!Number.isFinite(x + y + z)) throw new Error(`第 ${model.atoms} 个原子读不出坐标 / no coordinates could be read for atom ${model.atoms}`)
    const resname = line.slice(17, 21).trim(), chain = line.slice(21, 22), seg = line.slice(72, 76).trim()
    const lipidKey = lipids.has(resname) ? resname : ''
    if (seg !== lastSeg || chain !== lastChain || lipidKey !== lastLipidKey) {
      current = { xyz: [] }
      if (lipidKey) {
        if (!lipidPart.has(resname)) {
          lipidPart.set(resname, { name: resname, kind: resname, lipid: true, molecules: [] })
          model.parts.push(lipidPart.get(resname)!)
        }
        lipidPart.get(resname)!.molecules.push(current)
      } else if (AMINO.has(resname)) {
        const kind = opts.chains[chain] ?? `protein (chain ${chain})`
        model.parts.push({ name: `${kind} ${seg}`, kind, lipid: false, molecules: [current] })
      } else {
        model.parts.push({ name: `glycan ${++glycans}`, kind: 'glycan', lipid: false, molecules: [current] })
      }
      lastSeg = seg
      lastChain = chain
      lastLipidKey = lipidKey
    }
    current!.xyz.push(x, y, z)
    model.heavy++
  }
  if (model.heavy === 0) throw new Error('这个文件里没有读到原子 / no atoms were read from this file')
  return model
}

export interface BigPdbSource extends BigPdbOptions {
  url: string
  member: string
  head: number
  budget: number
}

/** 取压缩包的开头、找出那个 PDB、转换，返回要存下来的文件内容 / fetch the start of the archive, find the PDB, convert it, and return the file to keep */
export async function makeBigPdb(src: BigPdbSource): Promise<Uint8Array> {
  const raw = await cached(src.url, fetch, { head: src.head, maxBytes: 1_000_000_000 })
  const model = await readBigPdb(tarMemberLines(gunzipped(raw), src.member), src)
  const { header, spheres, ops } = packParts(model.parts, `${src.url}#${src.member}`, src.budget, 'atoms', 1, model.atoms)
  return encode(header, spheres, ops)
}

export const bigPdbKey = (src: BigPdbSource) => `${src.url}|${src.member}|${src.head}|${src.budget}|${JSON.stringify(src.chains)}|${src.lipids.join(',')}|${MAGIC}`

if (import.meta.main) {
  const catalog = (await import('../../data/catalog.json')).default
  const entry = (catalog.models as { id: string; source: { kind: string; format?: string } }[]).find((m) => m.id === process.argv[2] && m.source.format === 'pdb')
  if (!entry) {
    console.error('用法 / usage: bun server/tools/bigpdb.ts <catalogue id of a model whose source format is "pdb">')
    process.exit(1)
  }
  const src = entry.source as unknown as BigPdbSource
  const t0 = performance.now()
  const path = await preparedFile(bigPdbKey(src), () => makeBigPdb(src))
  const { header } = decode(new Uint8Array(await Bun.file(path).arrayBuffer()))
  const kinds = new Map<string, number>()
  for (const o of header.objects) kinds.set(o.kind ?? o.name, (kinds.get(o.kind ?? o.name) ?? 0) + 1)
  console.log(JSON.stringify({ path, seconds: Math.round((performance.now() - t0) / 1000), megabytes: Math.round(Bun.file(path).size / 1e6), ...header, objects: header.objects.length, kinds: Object.fromEntries(kinds) }, null, 1))
}
