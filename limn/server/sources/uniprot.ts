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
}

/** AlphaFold DB model for a UniProt accession, or null if there is none. */
export async function alphafold(accession: string): Promise<Prediction | null> {
  const res = await fetch(`https://alphafold.ebi.ac.uk/api/prediction/${accession}`, { headers: UA })
  if (!res.ok) return null
  const json = (await res.json()) as any[]
  const m = json[0]
  if (!m?.bcifUrl && !m?.cifUrl) return null
  const confident = (m.fractionPlddtConfident ?? 0) + (m.fractionPlddtVeryHigh ?? 0)
  return { accession, url: m.bcifUrl ?? m.cifUrl, confident }
}
