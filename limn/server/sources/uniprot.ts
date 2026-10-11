/** UniProt and PDBe SIFTS lookups: gene name -> protein -> best structures. */

export interface Protein {
  accession: string
  name: string
  gene: string
  organism: string
  length: number
}

const UA = { 'User-Agent': 'limn/0.1 (molecular illustration; local research tool)' }

/** Reviewed entries for a gene symbol, optionally in one organism (name or NCBI taxon id). */
export async function findProtein(gene: string, organism?: string): Promise<Protein[]> {
  let q = `(gene_exact:${JSON.stringify(gene)}) AND (reviewed:true)`
  if (organism) q += /^\d+$/.test(organism) ? ` AND (organism_id:${organism})` : ` AND (organism_name:${JSON.stringify(organism)})`
  const url = `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(q)}&fields=accession,gene_primary,protein_name,organism_name,length&format=json&size=5`
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`UniProt 查询失败（HTTP ${res.status}）`)
  const json = (await res.json()) as { results?: any[] }
  return (json.results ?? []).map((r) => ({
    accession: r.primaryAccession,
    name: r.proteinDescription?.recommendedName?.fullName?.value ?? r.proteinDescription?.submissionNames?.[0]?.fullName?.value ?? '',
    gene: r.genes?.[0]?.geneName?.value ?? gene,
    organism: r.organism?.scientificName ?? '',
    length: r.sequence?.length ?? 0,
  }))
}

export interface BestStructure {
  pdbId: string
  chain: string
  coverage: number
  resolution: number | null
  method: string
}

/** PDBe's ranking of the PDB chains that best cover a UniProt sequence. */
export async function bestStructures(accession: string, limit = 5): Promise<BestStructure[]> {
  const res = await fetch(`https://www.ebi.ac.uk/pdbe/api/mappings/best_structures/${accession}`, { headers: UA })
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`PDBe 查询失败（HTTP ${res.status}）`)
  const json = (await res.json()) as Record<string, any[]>
  const seen = new Set<string>()
  const out: BestStructure[] = []
  for (const r of json[accession] ?? []) {
    const id = String(r.pdb_id).toUpperCase()
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ pdbId: id, chain: r.chain_id, coverage: r.coverage, resolution: r.resolution ?? null, method: r.experimental_method ?? '' })
    if (out.length >= limit) break
  }
  return out
}

export interface Prediction {
  accession: string
  url: string
  /** share of residues with pLDDT of 70 or more */
  confident: number
  /** 模型来自哪里：AlphaFold 数据库，或 BFVD（病毒蛋白的预测库）/ where the model is from: the AlphaFold DB, or BFVD (a library of predicted viral proteins) */
  source: 'AlphaFold DB' | 'BFVD'
}

/**
 * 一个 UniProt 编号的预测模型：先查 AlphaFold 数据库；没有的话查 BFVD，它收录了 AlphaFold 数据库里缺的
 * 许多病毒蛋白（例如 HIV-1 的 Gag）。BFVD 只给平均置信度，这里用它粗略代替“可信残基的比例”。
 *
 * The predicted model for a UniProt accession: the AlphaFold DB first, then BFVD, which holds many
 * viral proteins the AlphaFold DB lacks (HIV-1 Gag, for one). BFVD gives only a mean confidence,
 * which stands in roughly for the share of confidently placed residues.
 */
export async function alphafold(accession: string): Promise<Prediction | null> {
  const res = await fetch(`https://alphafold.ebi.ac.uk/api/prediction/${accession}`, { headers: UA }).catch(() => null)
  if (res?.ok) {
    const json = (await res.json().catch(() => [])) as any[]
    const m = json[0]
    if (m?.bcifUrl || m?.cifUrl) return { accession, url: m.bcifUrl ?? m.cifUrl, confident: (m.fractionPlddtConfident ?? 0) + (m.fractionPlddtVeryHigh ?? 0), source: 'AlphaFold DB' }
  }
  // BFVD 的编号区分大小写，要大写 / BFVD accessions are case-sensitive and upper case
  const acc = accession.toUpperCase()
  const meta = await fetch(`https://bfvd.foldseek.com/api/${acc}`, { headers: UA }).catch(() => null)
  if (!meta?.ok) return null
  const rows = (await meta.json().catch(() => [])) as any[]
  const plddt = Number(rows[0]?.plddt)
  if (!Number.isFinite(plddt)) return null
  return { accession, url: `https://bfvd.steineggerlab.workers.dev/pdb/${acc}.pdb`, confident: Math.max(0, Math.min(1, (plddt - 50) / 40)), source: 'BFVD' }
}

export interface PredictedComplex {
  /** AlphaFold 数据库里的模型编号，如 AF-0000000211046780 / the model's id in the AlphaFold DB, e.g. AF-0000000211046780 */
  id: string
  name: string
  /** 界面预测的可信度（0-1）；低于约 0.6 的配对多半不可靠 / confidence of the predicted interface, 0-1; pairings under about 0.6 are mostly unreliable */
  iptm: number
  /** 各组分的 UniProt 编号和份数 / UniProt accession and copy number of each component */
  parts: { accession: string; copies: number }[]
  url: string
}

/** 界面可信度的下限 / the lowest interface confidence accepted */
export const MIN_IPTM = 0.6

/** 把 AlphaFold 数据库的复合物列表整理出来，丢掉界面不可信的，可信的在前 / reduce the AlphaFold DB's list of complexes, dropping unreliable interfaces, most confident first */
export function readComplexes(list: any[], minIptm = MIN_IPTM): PredictedComplex[] {
  const out: PredictedComplex[] = []
  for (const m of Array.isArray(list) ? list : []) {
    const iptm = Number(m?.complexPredictionAccuracy_ipTM)
    const id = String(m?.modelEntityId ?? '')
    if (!/^AF-\d{6,}$/.test(id) || !Number.isFinite(iptm) || iptm < minIptm) continue
    const parts = (m.complexComposition ?? [])
      .map((c: any) => ({ accession: String(c.identifier ?? c.uniprotAccession ?? ''), copies: Number(c.stoichiometry) || 1 }))
      .filter((c: { accession: string }) => c.accession)
    out.push({ id, name: String(m.complexName ?? m.uniprotDescription ?? id), iptm, parts, url: `https://alphafold.ebi.ac.uk/files/${id}-model_v${Number(m.latestVersion) || 1}.bcif` })
  }
  return out.sort((a, b) => b.iptm - a.iptm)
}

/** AlphaFold 数据库里含有某个蛋白的预测复合物 / predicted complexes in the AlphaFold DB that contain a protein */
export async function complexes(accession: string): Promise<PredictedComplex[]> {
  const res = await fetch(`https://alphafold.ebi.ac.uk/api/complex/${accession}`, { headers: UA }).catch(() => null)
  if (!res?.ok) return []
  return readComplexes((await res.json().catch(() => [])) as any[])
}
