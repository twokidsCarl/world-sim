/**
 * 逐残基的注释：结构域、活性位点和结合位点（UniProt），以及每个位置上氨基酸替换的平均致病性预测
 * （AlphaMissense，经 AlphaFold DB）。PDB 结构的残基号经 PDBe SIFTS 对应到 UniProt 的位置。
 * 全部是运行时查询并缓存，不入库。
 *
 * Per-residue annotation: domains, active sites and binding sites (UniProt), and the mean
 * predicted pathogenicity of amino-acid substitutions at each position (AlphaMissense, via the
 * AlphaFold DB). Residue numbers of a PDB structure are mapped to UniProt positions through PDBe
 * SIFTS. Everything is looked up at run time and cached; none of it is in the repository.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stateDir } from '../structures'

const UA = { 'User-Agent': 'limn/0.1 (molecular illustration; local research tool)' }

export interface Feature {
  /** domain: 结构域或功能区；active: 活性位点；binding: 结合位点；site: 其他标注位点 / domain or functional region; active site; binding site; other annotated site */
  kind: 'domain' | 'active' | 'binding' | 'site'
  name: string
  /** UniProt 序列上的起止位置（含两端）/ first and last position in the UniProt sequence, inclusive */
  start: number
  end: number
}

export interface ProteinAnnotation {
  accession: string
  name: string
  features: Feature[]
  /** 每个位置上 19 种替换的 AlphaMissense 致病性均值（0-1），下标 = 位置 - 1；没有则为 null / mean AlphaMissense pathogenicity (0-1) of the 19 substitutions at each position, index = position - 1; null when unavailable */
  pathogenicity: number[] | null
}

export interface Annotation {
  /** label_asym_id → 这条链是哪个蛋白、链上的残基号怎样对应到 UniProt 位置 / label_asym_id -> which protein the chain is, and how its residue numbers map to UniProt positions */
  chains: Record<string, { accession: string; segments: { from: number; to: number; unp: number }[] }>
  proteins: Record<string, ProteinAnnotation>
}

const getJson = async (url: string): Promise<any | null> => {
  const res = await fetch(url, { headers: UA }).catch(() => null)
  return res && res.ok ? res.json().catch(() => null) : null
}

/** 把 UniProt 的特征表整理成我们用的四类 / reduce UniProt's feature table to the four kinds used here */
export function readFeatures(entry: any): Feature[] {
  const out: Feature[] = []
  for (const f of entry?.features ?? []) {
    const start = f.location?.start?.value, end = f.location?.end?.value
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue
    const ligand = f.ligand?.name ? String(f.ligand.name) : ''
    const name = String(f.description || ligand || f.type)
    switch (f.type) {
      case 'Domain': case 'DNA binding': case 'Zinc finger': case 'Repeat':
        out.push({ kind: 'domain', name: f.type === 'Domain' ? name : `${f.type}${f.description ? ': ' + f.description : ''}`, start, end })
        break
      case 'Active site': out.push({ kind: 'active', name, start, end }); break
      case 'Binding site': out.push({ kind: 'binding', name: ligand || name, start, end }); break
      case 'Site': out.push({ kind: 'site', name, start, end }); break
    }
  }
  return out
}

/** AlphaMissense 的替换表（M1A,0.4065,Amb …）→ 每个位置的均值 / AlphaMissense's substitution table (M1A,0.4065,Amb ...) -> the mean at each position */
export function meanPathogenicity(csv: string): number[] {
  const sum: number[] = [], n: number[] = []
  for (const line of csv.split('\n')) {
    const m = /^[A-Z](\d+)[A-Z],([\d.]+)/.exec(line)
    if (!m) continue
    const i = Number(m[1]) - 1
    sum[i] = (sum[i] ?? 0) + Number(m[2])
    n[i] = (n[i] ?? 0) + 1
  }
  return Array.from({ length: sum.length }, (_, i) => (n[i] ? +(sum[i]! / n[i]!).toFixed(3) : 0))
}

async function protein(accession: string): Promise<ProteinAnnotation | null> {
  const entry = await getJson(`https://rest.uniprot.org/uniprotkb/${accession}.json?fields=protein_name,ft_domain,ft_dna_bind,ft_zn_fing,ft_repeat,ft_act_site,ft_binding,ft_site`)
  if (!entry) return null
  const name = entry.proteinDescription?.recommendedName?.fullName?.value ?? entry.proteinDescription?.submissionNames?.[0]?.fullName?.value ?? accession
  let pathogenicity: number[] | null = null
  const af = await getJson(`https://alphafold.ebi.ac.uk/api/prediction/${accession}`)
  const amUrl = Array.isArray(af) ? af[0]?.amAnnotationsUrl : null
  if (typeof amUrl === 'string' && amUrl.startsWith('https://alphafold.ebi.ac.uk/')) {
    const res = await fetch(amUrl, { headers: UA }).catch(() => null)
    if (res?.ok) {
      const mean = meanPathogenicity(await res.text())
      if (mean.length) pathogenicity = mean
    }
  }
  return { accession, name, features: readFeatures(entry), pathogenicity }
}

/**
 * 一个结构的注释。`id` 是 PDB 编号，或 "AF-<UniProt 编号>"（预测模型的残基号就是 UniProt 位置）。
 * Annotation for a structure. `id` is a PDB id, or "AF-<UniProt accession>" (a predicted model's
 * residue numbers are UniProt positions already).
 */
export async function annotate(id: string): Promise<Annotation | null> {
  const key = id.toUpperCase()
  const dir = join(stateDir(), 'annotations')
  const path = join(dir, `${key}.json`)
  const have = await readFile(path, 'utf8').catch(() => '')
  if (have) return JSON.parse(have) as Annotation

  const out: Annotation = { chains: {}, proteins: {} }
  const af = /^AF-([A-Z0-9]{6,10})/.exec(key)
  if (af) {
    out.chains['A'] = { accession: af[1]!, segments: [{ from: 1, to: 100000, unp: 1 }] }
  } else if (/^[0-9][A-Z0-9]{3}$/.test(key)) {
    const sifts = await getJson(`https://www.ebi.ac.uk/pdbe/api/mappings/uniprot_segments/${key.toLowerCase()}`)
    for (const [accession, v] of Object.entries<any>(sifts?.[key.toLowerCase()]?.UniProt ?? {})) {
      for (const m of v.mappings ?? []) {
        const asym = String(m.struct_asym_id), from = m.start?.residue_number, to = m.end?.residue_number
        if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(m.unp_start)) continue
        // 一条链可以由几段拼成；嵌合体里一条链还可能对应不止一个蛋白，这里只取先出现的那个
        // a chain may be covered in several segments; in a chimera one chain can map to more than one protein, and only the first is kept
        const c = (out.chains[asym] ??= { accession, segments: [] })
        if (c.accession === accession) c.segments.push({ from, to, unp: m.unp_start })
      }
    }
  } else return null

  for (const accession of new Set(Object.values(out.chains).map((c) => c.accession)).values()) {
    const p = await protein(accession)
    if (p) out.proteins[accession] = p
  }
  if (Object.keys(out.proteins).length === 0) return null
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(out))
  return out
}
