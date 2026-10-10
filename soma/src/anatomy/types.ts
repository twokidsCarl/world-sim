// Data contract shared by the offline pipelines (tools/) and the runtime (src/).
// Changing anything here means changing both sides.
//
// Files served under /anatomy:
//   /anatomy/<body>/anatomy.json     AnatomyData
//   /anatomy/<body>/<system>.glb     one GLB per system; every part is one node + one mesh
//                                    whose node name is the Part.id. Positions are in metres,
//                                    Y up, anterior +Z, the body's left at +X. Normals included.
//                                    EXT_meshopt_compression + KHR_mesh_quantization.
//   /anatomy/knowledge/names.json    Record<fmaId, NameEntry>      (optional, shared by bodies)
//   /anatomy/knowledge/relations.json Relation[]                   (optional, shared by bodies)

export type BodyId = 'male' | 'female'

export type SystemId =
  | 'integumentary'
  | 'muscular'
  | 'skeletal'
  | 'cardiovascular'
  | 'nervous'
  | 'respiratory'
  | 'digestive'
  | 'urinary'
  | 'reproductive'
  | 'endocrine'
  | 'lymphatic'
  | 'other'

export type TissueId =
  | 'skin'
  | 'fat'
  | 'fascia'
  | 'muscle'
  | 'tendon'
  | 'ligament'
  | 'cartilage'
  | 'bone'
  | 'tooth'
  | 'artery'
  | 'vein'
  | 'heart'
  | 'nerve'
  | 'brain'
  | 'organ'
  | 'gland'
  | 'space'
  | 'other'

/** Where a part's geometry comes from. */
export type Provenance = 'scanned' | 'warped' | 'curated'

export type Side = 'L' | 'R' | 'M'

export type Vec3 = [number, number, number]

export interface Part {
  /** Stable id, unique within a body. For BodyParts3D this is the element file id (e.g. "FJ1252"). */
  id: string
  /** FMA concept id of this part itself, e.g. "FMA59763". */
  fma: string
  /** English name from the source data. Other languages come from the knowledge layer by FMA id. */
  name: string
  system: SystemId
  tissue: TissueId
  /** Peel order: 0 is the most superficial layer; higher is deeper. */
  depth: number
  side: Side
  provenance: Provenance
  /** Axis-aligned bounds in metres: [minX, minY, minZ, maxX, maxY, maxZ]. */
  bbox: [number, number, number, number, number, number]
  /** Area-weighted surface centroid in metres. */
  centroid: Vec3
  /** Volume in cm³ as reported by the source, when available. */
  volume?: number
  triangles: number
  /** Ids of parts whose surfaces lie within the adjacency threshold. Symmetric. */
  adjacent: string[]
}

/** A node of one of the ontology trees. Parts of a concept = its own `parts` plus all descendants'. */
export interface Concept {
  /** FMA concept id. */
  id: string
  name: string
  parent: string | null
  /** Part ids attached directly to this concept (not to any child). */
  parts: string[]
}

export interface SystemDef {
  id: SystemId
  name: { en: string; zh: string }
  /** Default display colour, hex. */
  color: string
  /** GLB path relative to the anatomy.json, or null when the body has no parts in this system. */
  glb: string | null
  partCount: number
}

export interface SourceInfo {
  name: string
  url: string
  license: string
  attribution: string
}

export interface AnatomyData {
  schema: 1
  body: BodyId
  sources: SourceInfo[]
  systems: SystemDef[]
  /** Peel layers, superficial to deep; Part.depth indexes into this. */
  layers: { name: { en: string; zh: string } }[]
  parts: Part[]
  trees: {
    /** Classification hierarchy; covers every part. */
    isa: Concept[]
    /** Structural hierarchy; may cover only a subset of parts. */
    partOf: Concept[]
  }
}

export type ReviewStatus = 'unreviewed' | 'reviewed'

export interface NameEntry {
  zh?: string
  la?: string
  ja?: string
  /** Wikidata item id, e.g. "Q9368". */
  wikidata?: string
  /** Where the zh name came from. */
  zhSource?: string
  status: ReviewStatus
}

export type RelationKind =
  | 'origin'
  | 'insertion'
  | 'innervatedBy'
  | 'arterialSupply'
  | 'venousDrainage'
  | 'lymphaticDrainage'
  | 'connectsWith'
  | 'antagonist'

export interface Relation {
  /** FMA id of the structure the statement is about. */
  subject: string
  kind: RelationKind
  /** FMA id of the target structure when it could be resolved. */
  object?: string
  /** Human-readable target, always present. */
  objectLabel: { en: string; zh?: string }
  source: { name: string; url: string; license: string }
  status: ReviewStatus
}
