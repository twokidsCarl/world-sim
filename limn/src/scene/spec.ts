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

/** One kind of molecule in a crowded scene. `panel` indexes SceneSpec.panels. */
export interface Ingredient {
  panel: number
  /** above or below the membrane, or in it; scenes without a membrane use 'below' */
  compartment: 'above' | 'membrane' | 'below'
  /** how many copies the stated abundance gives in the scene's volume */
  copies: number
  /** the abundance the count came from, as the model stated it */
  abundance: string
  /** always shown at least once even if the abundance rounds to zero */
  feature: boolean
  /**
   * For membrane proteins: whether the structure crosses the membrane, or is
   * only the part that stands on one side of it (most structures of viral
   * spikes and receptors are such ectodomains).
   */
  anchor?: 'spans' | 'above' | 'below'
  /** which end of the chain is at the membrane, when known */
  terminus?: 'N' | 'C'
}

/** A slab of cell drawn in cross-section. Sizes in Å. */
export interface LandscapeSpec {
  width: number
  height: number
  depth: number
  membrane: boolean
  above: string
  below: string
  ingredients: Ingredient[]
}

export interface SceneSpec {
  topic: string
  kind: 'molecule' | 'complex' | 'virus' | 'gene' | 'mechanism' | 'landscape'
  title: string
  caption: string
  panels: PanelSpec[]
  /** things a reader should know: what is predicted, modelled or left out */
  notes: string[]
  /** present when kind is 'landscape' */
  landscape?: LandscapeSpec
}
