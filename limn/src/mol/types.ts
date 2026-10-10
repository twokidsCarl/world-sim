export type EntityKind = 'protein' | 'dna' | 'rna' | 'glycan' | 'ligand' | 'ion' | 'lipid' | 'water'

export interface Entity {
  id: string
  description: string
  kind: EntityKind
}

export interface Chain {
  /** label_asym_id: unique per chain instance in the file */
  asymId: string
  authAsymId: string
  entity: number
  start: number
  count: number
}

/** One row of an assembly: these chains, copied by each of these operators. */
export interface AssemblyGroup {
  chains: number[]
  /** column-major 4x4 */
  operators: Float32Array[]
}

export interface Assembly {
  id: string
  groups: AssemblyGroup[]
}

export const enum El {
  C = 0,
  N = 1,
  O = 2,
  S = 3,
  P = 4,
  Other = 5,
}

/** A parsed structure: heavy atoms of the first model, waters removed. */
export interface Molecule {
  id: string
  title: string
  atomCount: number
  /** x, y, z in Å */
  pos: Float32Array
  element: Uint8Array
  chainOf: Uint32Array
  /** 1 for backbone trace atoms: protein Cα and nucleic acid P */
  isTrace: Uint8Array
  /** residue number within its chain, used only to find residue-level outlines */
  residue: Int32Array
  chains: Chain[]
  entities: Entity[]
  /** assemblies[0] is always the asymmetric unit as deposited */
  assemblies: Assembly[]
}

export const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
