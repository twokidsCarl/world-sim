import type { Role } from '../style/palettes'

/** Where a structure's coordinates come from, and how far they can be trusted. */
export interface SourceRef {
  /** PDB id (e.g. "6VXX") or "AF-<UniProt accession>" for an AlphaFold model */
  id: string
  kind: 'pdb' | 'alphafold'
  /** download URL for AlphaFold models; PDB entries are fetched by id */
  url?: string
  title: string
  method: string
  resolution: number | null
  year: number | null
}

export interface EntitySpec {
  entityId: string
  role: Role
  /** short display name */
  name: string
  description: string
  organism: string
}

/** One structure in the picture. A mechanism is several panels side by side. */
export interface PanelSpec {
  label: string
  source: SourceRef
  assembly: string
  entities: EntitySpec[]
  /** why this structure was chosen, in the resolver's words */
  reason: string
}

export interface SceneSpec {
  topic: string
  kind: 'molecule' | 'complex' | 'virus' | 'gene' | 'mechanism' | 'landscape'
  title: string
  caption: string
  panels: PanelSpec[]
  /** things a reader should know: what is predicted, modelled or left out */
  notes: string[]
}
