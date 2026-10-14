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
  /**
   * 一个部件由来源不同的几片拼成时（目前只有皮肤：拟合的体表、移植片、构造出来的接缝和内缘），逐片说明。
   * 各片的顶点数之和等于该部件的顶点数。缺省表示整个部件只有 `provenance` / `source` 一种来历。
   * When one part is assembled from pieces of different origin (so far only the skin: fitted surface,
   * grafts, constructed blend rings and rims), one entry per piece. The vertex counts sum to the
   * part's vertex count. Absent = the whole part has the single origin given by `provenance` / `source`.
   */
  composition?: PartPiece[]
}

/** 部件里来历相同的一片 / One piece of a part with a single origin. */
export interface PartPiece {
  what: { zh: string; en: string }
  /** `construction`：为衔接或开口而构造的几何，不是解剖数据 / geometry built to join or open pieces; not anatomical data. */
  provenance: Provenance | 'construction'
  /** `SourceInfo.name`；构造出来的片没有来源（null）/ null for constructed pieces. */
  source: string | null
  vertices: number
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
 * 肌肉路径上的经过点：静止姿势下的位置（米，身体坐标系）和它随之运动的关节。
 * A via point on a muscle's path: its rest position (metres, body frame) and the joint it moves with.
 */
export interface MuscleVia {
  point: Vec3
  joint: string
  /**
   * 缠绕条件（可选）。有它时这个点代表骨面（如股骨髁后面）上的一点，只在需要时才用：在垂直于 axis 的平面里，
   * 路径在这一段的直线与“从 centre 经过这个点的射线”相交处若比这个点更靠近 centre（即直线会穿进骨里），路径改经这个点；
   * 否则直线从骨外经过，这个点不起作用。几个缠绕点按压入最深者先加入，与列出的顺序无关。centre 和 axis 都是静止姿势下的值，
   * 随 `joint` 运动。点在刚起作用时贴着直线，因此路径随姿势连续变化，不会像“屈膝超过某个角度才生效”那样跳变
   * （见 tools/rig/musclepath.ts）。缺省 = 这个点总在路径上。
   * Wrapping condition (optional). With it the point stands for a point on a bone surface (e.g. behind the femoral
   * condyles) and is used only when needed: in the plane perpendicular to `axis`, when the path's straight line in
   * that stretch meets the ray from `centre` through this point nearer to `centre` than the point (that is, the line
   * would pass into the bone), the path goes through this point instead; otherwise the line passes outside the bone and
   * the point does nothing. Several wrapping points are added deepest first, whatever order they are listed in.
   * `centre` and `axis` are rest-pose values that move with `joint`. A point that has just come into use lies on the
   * line, so the path changes continuously with the pose instead of jumping as an "only beyond X degrees of knee
   * flexion" rule would (see tools/rig/musclepath.ts). Absent = the point is always on the path.
   */
  wrap?: { centre: Vec3; axis: Vec3 }
}

/**
 * A muscle's line of action, used to keep its volume when its length changes:
 * the runtime measures the current distance between the two ends and scales the
 * cross-section about the line by sqrt(restLength / length).
 * 有经过点时，作用线是 起点 → 各经过点 → 止点 的折线：长度取折线长度，肌肉网格随折线变形（见 tools/rig/musclepath.ts）。
 * With via points the line of action is the polyline origin → via points → insertion: its length is the length of
 * the polyline, and the muscle mesh is deformed to follow it (see tools/rig/musclepath.ts).
 */
export interface MuscleLine {
  part: string
  /** Rest-pose end points, metres, and the joints they move with. */
  origin: { point: Vec3; joint: string }
  insertion: { point: Vec3; joint: string }
  /**
   * 经过点，按从起点到止点的顺序；缺省或为空 = 直线（与没有这个字段之前完全相同）。
   * Via points in order from origin to insertion; absent or empty = the straight line (exactly as before this field existed).
   */
  via?: MuscleVia[]
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
