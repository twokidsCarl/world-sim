/** RCSB PDB search and metadata (CC0). Docs: search.rcsb.org, data.rcsb.org */

export interface EntityInfo {
  entityId: string
  kind: 'protein' | 'dna' | 'rna' | 'other-polymer' | 'ligand' | 'glycan'
  description: string
  organism: string
  chains: number
  length: number
  uniprot: string[]
}

export interface AssemblyInfo {
  id: string
  atoms: number
  chains: number
  symmetry: string
}

export interface EntryInfo {
  id: string
  title: string
  method: string
  /** Å; null for methods that report none */
  resolution: number | null
  year: number | null
  atoms: number
  assemblies: AssemblyInfo[]
  entities: EntityInfo[]
}

const UA = { 'User-Agent': 'limn/0.1 (molecular illustration; local research tool)' }

/** Full-text search, best matches first. Returns entry ids. */
export async function searchText(query: string, rows = 8): Promise<string[]> {
  const body = {
    query: { type: 'terminal', service: 'full_text', parameters: { value: query } },
    return_type: 'entry',
    request_options: { paginate: { start: 0, rows }, results_content_type: ['experimental'] },
  }
  const res = await fetch('https://search.rcsb.org/rcsbsearch/v2/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...UA },
    body: JSON.stringify(body),
  })
  if (res.status === 204) return []
  if (!res.ok) throw new Error(`RCSB 搜索失败（HTTP ${res.status}）`)
  const json = (await res.json()) as { result_set?: { identifier: string }[] }
  return (json.result_set ?? []).map((r) => r.identifier.toUpperCase())
}

const QUERY = `query($ids:[String!]!){entries(entry_ids:$ids){
  rcsb_id struct{title} exptl{method}
  rcsb_accession_info{initial_release_date}
  rcsb_entry_info{resolution_combined deposited_atom_count}
  assemblies{rcsb_assembly_container_identifiers{assembly_id}
    rcsb_assembly_info{atom_count polymer_entity_instance_count}
    rcsb_struct_symmetry{symbol kind}}
  polymer_entities{
    entity_poly{rcsb_entity_polymer_type rcsb_sample_sequence_length}
    rcsb_polymer_entity{pdbx_description}
    rcsb_entity_source_organism{ncbi_scientific_name}
    rcsb_polymer_entity_container_identifiers{entity_id asym_ids uniprot_ids}}
  nonpolymer_entities{
    rcsb_nonpolymer_entity_container_identifiers{entity_id asym_ids}
    nonpolymer_comp{chem_comp{id name}}}
  branched_entities{
    rcsb_branched_entity_container_identifiers{entity_id asym_ids}
    rcsb_branched_entity{pdbx_description}}
}}`

/** Metadata for up to a few dozen entries. Unknown ids are simply absent from the result. */
export async function entryInfo(ids: string[]): Promise<EntryInfo[]> {
  if (ids.length === 0) return []
  const res = await fetch('https://data.rcsb.org/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...UA },
    body: JSON.stringify({ query: QUERY, variables: { ids: ids.map((i) => i.toUpperCase()) } }),
  })
  if (!res.ok) throw new Error(`RCSB 数据接口失败（HTTP ${res.status}）`)
  const json = (await res.json()) as { data?: { entries?: any[] } }
  return (json.data?.entries ?? []).filter(Boolean).map(toInfo)
}

function toInfo(e: any): EntryInfo {
  const entities: EntityInfo[] = []
  for (const p of e.polymer_entities ?? []) {
    const type = String(p.entity_poly?.rcsb_entity_polymer_type ?? '')
    const ids = p.rcsb_polymer_entity_container_identifiers ?? {}
    entities.push({
      entityId: String(ids.entity_id),
      kind: type === 'Protein' ? 'protein' : type === 'DNA' ? 'dna' : type === 'RNA' ? 'rna' : 'other-polymer',
      description: p.rcsb_polymer_entity?.pdbx_description ?? '',
      organism: [...new Set((p.rcsb_entity_source_organism ?? []).map((o: any) => o.ncbi_scientific_name).filter(Boolean))].join(', '),
      chains: (ids.asym_ids ?? []).length,
      length: p.entity_poly?.rcsb_sample_sequence_length ?? 0,
      uniprot: ids.uniprot_ids ?? [],
    })
  }
  for (const n of e.nonpolymer_entities ?? []) {
    const ids = n.rcsb_nonpolymer_entity_container_identifiers ?? {}
    const comp = n.nonpolymer_comp?.chem_comp ?? {}
    entities.push({
      entityId: String(ids.entity_id), kind: 'ligand', description: `${comp.name ?? ''} (${comp.id ?? '?'})`.trim(),
      organism: '', chains: (ids.asym_ids ?? []).length, length: 0, uniprot: [],
    })
  }
  for (const b of e.branched_entities ?? []) {
    const ids = b.rcsb_branched_entity_container_identifiers ?? {}
    entities.push({
      entityId: String(ids.entity_id), kind: 'glycan', description: b.rcsb_branched_entity?.pdbx_description ?? 'glycan',
      organism: '', chains: (ids.asym_ids ?? []).length, length: 0, uniprot: [],
    })
  }
  entities.sort((a, b) => Number(a.entityId) - Number(b.entityId))
  const release = e.rcsb_accession_info?.initial_release_date
  return {
    id: String(e.rcsb_id).toUpperCase(),
    title: e.struct?.title ?? '',
    method: (e.exptl ?? []).map((x: any) => x.method).join(', '),
    resolution: e.rcsb_entry_info?.resolution_combined?.[0] ?? null,
    year: release ? Number(String(release).slice(0, 4)) : null,
    atoms: e.rcsb_entry_info?.deposited_atom_count ?? 0,
    assemblies: (e.assemblies ?? []).map((a: any) => ({
      id: String(a.rcsb_assembly_container_identifiers?.assembly_id),
      atoms: a.rcsb_assembly_info?.atom_count ?? 0,
      chains: a.rcsb_assembly_info?.polymer_entity_instance_count ?? 0,
      symmetry: (a.rcsb_struct_symmetry ?? []).filter((s: any) => s.kind === 'Global Symmetry').map((s: any) => s.symbol).join(',') || 'C1',
    })),
    entities,
  }
}
