// Data contract shared by the offline pipelines (tools/) and the runtime (src/).
// Changing anything here means changing both sides.
//
// Files served under /anatomy:
//   /anatomy/<body>/anatomy.json     AnatomyData
//   /anatomy/<body>/<system>.glb     one GLB per system; every part is one node + one mesh
//                                    whose node name is the Part.id. Positions are in metres,
//                                    Y up, anterior +Z, the body's left at +X. Normals included.
//                                    EXT_meshopt_compression + KHR_mesh_quantization.
//   /anatomy/<body>/nerves.json       NervePath[]  (optional) centrelines of nerve parts
//   /anatomy/<body>/skinmaps.json     SkinMaps     (optional) dermatomes and cutaneous nerve
//   /anatomy/<body>/skinmaps.bin      territories painted on the skin, one byte per skin vertex
//   /anatomy/<body>/rig.json          Rig          (optional) joints and how every part follows them
//   /anatomy/<body>/rig.bin           per-vertex joint influences referenced by rig.json
//   /anatomy/<body>/rig-report.json   fit residuals and validation numbers of the rig (not read by the UI)
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
  /** `SourceInfo.name` of the dataset this part's geometry came from. Absent = the first source. */
  source?: string
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
  /**
   * Part ids attached directly to this concept (not to any child). In the partOf tree the same
   * part may be listed under more than one concept (e.g. a limb region and a system branch).
   */
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
  /** What a user should not trust in this body, most important first. Shown in the UI. */
  cautions?: { zh: string; en: string }[]
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

/** Centreline of a nerve part, in the same frame as the meshes. Used by the innervation model. */
export interface NervePath {
  /** Part.id of the nerve. */
  part: string
  /** One polyline per branch. `points` is flat xyz in metres; `radius` has one value per point. */
  branches: { points: number[]; radius: number[] }[]
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
  /** Inverse of innervatedBy, stated on the nerve: the structures this nerve supplies. */
  | 'innervates'
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

/** A partition of the skin surface into named regions (dermatomes, cutaneous nerve territories). */
export interface SkinMap {
  id: 'dermatome' | 'cutaneousNerve'
  name: { zh: string; en: string }
  regions: {
    name: { zh: string; en: string }
    /** Concept id of the spinal nerve or cutaneous nerve supplying the region, when it is in the trees. */
    concept?: string
    /** Display colour, hex. */
    color: string
  }[]
  /**
   * Byte offset into skinmaps.bin of `vertexCount` uint8 region indices (255 = unassigned),
   * in the vertex order of the skin part's mesh as decoded from its GLB.
   */
  offset: number
  /** How the map was made, in one or two sentences, for display. */
  method: { zh: string; en: string }
  sources: { name: string; url: string; license: string }[]
  status: ReviewStatus
}

export interface SkinMaps {
  /** Part.id of the skin part the maps are painted on. */
  part: string
  vertexCount: number
  maps: SkinMap[]
}

/** One rotational degree of freedom of a joint, about one of the joint's local axes. */
export interface JointDof {
  /** Index into Joint.axes. */
  axis: 0 | 1 | 2
  /** Movement at positive / negative angles, e.g. flexion / extension. */
  name: { zh: string; en: string }
  /**
   * 活动范围，弧度，相对于静止姿势（即存储的网格所在的姿势，不一定是解剖学姿势）。
   * Range of motion in radians relative to the rest pose (the pose the stored meshes are in,
   * which is not necessarily the anatomical position).
   */
  min: number
  max: number
  /** 解剖学零位对应的角度 / The dof angle at the anatomical zero position. */
  neutral?: number
  /** false 表示该范围是估计值，没有出处 / false when the range is an estimate without a source. */
  sourced?: boolean
  /**
   * 耦合：有效角度 = 自身角度 + ratio × 驱动关节的该自由度（如髌骨随膝关节）。
   * Coupling: effective angle = own angle + ratio × the driver joint's dof (e.g. patella with the knee).
   */
  driver?: { joint: string; dof: number; ratio: number }
  source: { name: string; url: string; license: string }
}

export interface Joint {
  id: string
  name: { zh: string; en: string }
  parent: string | null
  /** Centre of rotation in the rest pose, metres, body frame. */
  center: Vec3
  /**
   * 节段远端在静止姿势下的位置；center → tail 给出节段轴和长度，体型缩放沿这条轴进行。
   * Distal end of the segment in the rest pose; center → tail gives the segment axis and length
   * along which body-shape scaling acts.
   */
  tail?: Vec3
  /**
   * 静止姿势下关节坐标系的单位轴（身体坐标系）。两两正交，但不保证右手系：
   * 符号的选取使同名运动在左右两侧都为正。
   * Unit axes of the joint frame in the rest pose (body frame). Orthonormal but not necessarily
   * right-handed: signs are chosen so that the named movement is positive on both sides.
   */
  axes: [Vec3, Vec3, Vec3]
  /**
   * 关节的旋转 = 按 dofs 顺序、绕静止姿势下的轴的各旋转之积，第一个自由度固定在近端。
   * The joint rotation is the product of rotations about the rest-pose axes in `dofs` order,
   * the first dof being fixed to the proximal segment.
   */
  dofs: JointDof[]
  /** How the centre and axes were obtained, for display. */
  basis: { zh: string; en: string }
}

/**
 * A muscle's line of action, used to keep its volume when its length changes:
 * the runtime measures the current distance between the two ends and scales the
 * cross-section about the line by sqrt(restLength / length).
 */
export interface MuscleLine {
  part: string
  /** Rest-pose end points, metres, and the joints they move with. */
  origin: { point: Vec3; joint: string }
  insertion: { point: Vec3; joint: string }
  /**
   * 横截面缩放 = (静止长度 / 当前长度)^(gain / 2)；缺省为 1。按肌肉标定。
   * Cross-section scale = (restLength / length)^(gain / 2); defaults to 1. Calibrated per muscle.
   */
  gain?: number
}

/**
 * 体型缩放：每个关节的节段沿轴向和横截面方向的缩放；子节段被带到新位置，但自身不缩放。
 * Body-shape scaling: per joint, scale of its segment along the axis and in cross-section;
 * child segments are carried to their new position but are not scaled themselves.
 */
export type JointScales = Record<string, { along?: number; across?: number }>

export interface RigBinding {
  part: string
  /** The part moves rigidly with this joint (bones). Mutually exclusive with `offset`. */
  joint?: string
  /**
   * Byte offset into rig.bin of this part's per-vertex influences, in the vertex order of the
   * part's mesh as decoded from its GLB: for each vertex 4 x uint16 joint indices (into
   * Rig.joints) followed by 4 x uint8 weights that sum to 255.
   */
  offset?: number
  vertexCount?: number
}

/** A scalar control of body shape, applied at runtime on top of the pose. */
export interface ShapeParam {
  id: string
  name: { zh: string; en: string }
  unit: string
  min: number
  max: number
  /** Value at which the body is exactly the stored meshes. */
  rest: number
}

export interface Rig {
  joints: Joint[]
  bindings: RigBinding[]
  muscles: MuscleLine[]
  /** Reserved for the body-shape model; empty until that is defined. */
  shape?: ShapeParam[]
  /** What the rig does not model, for display. */
  cautions: { zh: string; en: string }[]
}
