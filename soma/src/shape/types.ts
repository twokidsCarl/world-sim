// 体型控制的数据契约：离线工具（tools/rig/shape-build.ts）写出，运行时读取。
// Data contract of the body-shape controls: written offline (tools/rig/shape-build.ts), read by the runtime.
//
//   /anatomy/<body>/shape.json   ShapeData
//   /anatomy/<body>/shape.bin    皮肤位移场与“跟随皮肤”的数据，小端 / skin displacement fields and skin-follower data, little endian
//
// 求值顺序（都在静止空间里做，然后才是蒙皮）/ order of evaluation (all in rest space, before skinning):
//   1. 体型位移：皮肤顶点 += m(bmi)·fat（逐顶点限幅）；跟随皮肤的部件顶点 += follow·(最近皮肤顶点的位移)
//      shape displacement: skin vertex += m(bmi)·fat (clamped per vertex); follower vertex += follow·(displacement of its nearest skin vertex)
//   2. 面部表情等其它静止空间的位移 / other rest-space displacements such as facial expression
//   3. 关节的节段缩放（体型）与关节转动（姿势），即 tools/rig/pose.ts 的 jointFrames：先按权重线性混合各关节的
//      仿射缩放，再做蒙皮
//      per-joint segment scales (shape) and joint rotations (pose), i.e. jointFrames of tools/rig/pose.ts:
//      the joints' affine scales are blended linearly by the skin weights, then the vertex is skinned

export type ShapeControlId = 'stature' | 'bmi' | 'legLength' | 'centralBuild'

export interface ShapeControl {
  id: ShapeControlId
  name: { zh: string; en: string }
  unit: string
  /** 模型本身的取值范围。 The range of the model itself. */
  min: number
  max: number
  /** 这副身体原样（不作任何改变）时的值。 The value at which the body is exactly as built. */
  default: number
  /** 这副身体上可用的范围（已按深部结构是否穿出皮肤收窄），以及原因。 The range usable on this body (narrowed where deep parts would come through the skin), and why. */
  valid: { min: number; max: number; why: { zh: string; en: string } }
}

/**
 * 一个比例因子（肢段长度、宽度或围度），是控制量的函数：
 *   factor = (stature / default.stature)^stature · exp(legLength·(LL − default.LL) + centralBuild·(CB − default.CB))
 * 默认控制值下恒为 1。
 * One proportion factor (a segment length, breadth or girth) as a function of the controls; it is 1 at the default controls.
 */
export interface ShapeFactor {
  id: string
  name: { zh: string; en: string }
  kind: 'length' | 'breadth' | 'girth'
  exponents: { stature: number; legLength: number; centralBuild: number }
}

/** 关节缩放中的一项：scale ×= 1 + gain·(factor − 1)。 One term of a joint scale: scale ×= 1 + gain·(factor − 1). */
export interface ShapeTerm {
  factor: string
  gain: number
}

/** 一个关节的节段缩放：along 沿节段长轴（关节中心 → tail），across 在横截面内。 The segment scale of one joint: `along` its segment axis (joint centre → tail), `across` in the cross-section. */
export interface ShapeJointScale {
  joint: string
  along: ShapeTerm[]
  across: ShapeTerm[]
}

/** 皮肤的胖瘦位移场（已传到发布的皮肤顶点上，顶点顺序同 GLB）。 The fatness displacement field of the skin, transferred to the shipped skin vertices (GLB vertex order). */
export interface ShapeSkinField {
  part: string
  vertexCount: number
  /** shape.bin 中的偏移：vertexCount × 3 个 float32，每 BMI 单位的位移（米）。 Offset in shape.bin: vertexCount × 3 float32, displacement per field unit (metres). */
  fatOffset: number
  /** shape.bin 中的偏移：vertexCount 个 float32，位移大小的上限（米）。 Offset in shape.bin: vertexCount float32, the cap on the displacement length (metres). */
  limitOffset: number
  /** 目标 BMI → 场的倍数 m（线性插值，表外取端点值）。 Target BMI → field multiplier m (linear interpolation, clamped to the ends of the table). */
  bmiToUnits: [number, number][]
}

/** 跟随皮肤位移的部件（皮下脂肪、浅层血管神经、毛发、指甲等）。 A part that follows the skin displacement (subcutaneous fat, superficial vessels and nerves, hair, nails …). */
export interface ShapeFollower {
  part: string
  vertexCount: number
  /** shape.bin 中的偏移：vertexCount 个 uint32，每个顶点最近的皮肤顶点下标。 Offset in shape.bin: vertexCount uint32, the nearest skin vertex of every vertex. */
  skinIndexOffset: number
  /** shape.bin 中的偏移：vertexCount 个 uint8，跟随份额 × 255。 Offset in shape.bin: vertexCount uint8, the share followed × 255. */
  followOffset: number
}

export interface ShapeData {
  schema: 1
  body: 'male' | 'female'
  controls: ShapeControl[]
  factors: ShapeFactor[]
  joints: ShapeJointScale[]
  skin: ShapeSkinField
  followers: ShapeFollower[]
  /** 各类部件遵循的规则，供显示。 The rule each kind of part follows, for display. */
  rules: { zh: string; en: string }[]
  /** 模型不成立或未建模的地方。 Where the model does not hold or is not modelled. */
  cautions: { zh: string; en: string }[]
  sources: { name: string; url: string; license: string }[]
}

export type ShapeControls = Partial<Record<ShapeControlId, number>>
