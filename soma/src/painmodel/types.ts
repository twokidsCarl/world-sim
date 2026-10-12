// 疼痛输入模型的类型：刺激、身体数据、输出。纯数据，不依赖 DOM 或 three.js。
// Types of the pain input model: stimulus, body data, outputs. Pure data, no DOM, no three.js.
//
// 这是疼痛生理与行为的计算模型，用于教学：被模拟的身体没有主观体验。
// This is a computational model of pain physiology and behaviour for teaching: the simulated
// body has no subjective experience.

import type { BodyId, Joint, NervePath, Vec3 } from '../anatomy/types.ts'

export type Bilingual = { zh: string; en: string }
export type SideLR = 'L' | 'R'

export type StimulusKind = 'pinprick' | 'pressure' | 'heat' | 'cold' | 'pinch'

export interface Stimulus {
  kind: StimulusKind
  site: {
    /** 被刺激的部件 id（现在只支持皮肤）/ Part.id that was stimulated (only the skin for now). */
    part?: string
    /**
     * 静止姿势、默认体型下的位置（米，与网格同一坐标系）。姿势或体型改变后，要把命中点换回静止网格。
     * Position in the rest pose and default shape (metres, the frame of the meshes). With a pose
     * or a body shape applied, the hit must be taken back to the rest mesh first.
     */
    position: Vec3
    /** 最近的皮肤顶点；给了就不再搜索 / Nearest skin vertex; skips the search when given. */
    vertex?: number
    /** 刺激的深度，毫米；只记录，尚未参与计算 / Depth of the stimulus, mm; recorded only, not yet modelled. */
    depthMm?: number
  }
  /** 力，牛顿（针刺、压力、捏夹）/ Force in newtons (pinprick, pressure, pinch). */
  forceN?: number
  /** 接触面积，平方毫米（压力、捏夹；热和冷只用于画图）/ Contact area, mm² (pressure, pinch; for heat and cold only the drawn area). */
  areaMm2?: number
  /** 接触面温度，摄氏度（热、冷）/ Temperature of the contact surface, °C (heat, cold). */
  temperatureC?: number
  /** 开始时刻，秒，缺省 0 / Onset, seconds; 0 by default. */
  onset?: number
  /** 每次刺激持续的时间，秒 / Duration of each application, seconds. */
  duration: number
  /** 重复刺激（时间总和）：次数和频率 / Repeated application (temporal summation): count and rate. */
  repeat?: { count: number; hz: number }
  /**
   * 肢体退缩后刺激是否随之结束。缺省为 true：刺激物是肢体可以躲开的（针、夹子、压头、冷热的接触物），
   * 肢体一离开，刺激就停，强度随即消退。刺激被固定在身上或肢体被固定时（如手浸在冷水里的冷加压试验、
   * 夹住不放的夹子）设为 false，强度按给定的时长计算。没有发生退缩时这一项不起作用。
   * Whether the stimulus ends when the limb withdraws. True by default: the stimulating object is
   * one the limb can escape from (a pin, a clamp, a probe, a hot or cold contact), so the stimulus
   * stops as the limb leaves it and the intensity then decays. Set it to false when the stimulus
   * is held on the body or the limb is held (a hand immersed for a cold pressor test, a clamp
   * left on); the intensity then follows the stated duration. It has no effect without a withdrawal.
   */
  withdrawalEndsStimulus?: boolean
}

/** 模型的可选项 / Options of the model. */
export interface PainOptions {
  /**
   * 热痛的“温度–评分”斜率取哪一种：painScale（默认）、noSensation、noSensationRescaled、toleranceRamp。
   * 各自的出处和实测内容见 data/curated/pain/nociception.json 的 heat.response.anchors。
   * Which reading of the heat temperature-rating slope to use: painScale (default), noSensation,
   * noSensationRescaled, toleranceRamp. What each source measured is in heat.response.anchors of
   * data/curated/pain/nociception.json.
   */
  heatAnchor?: 'painScale' | 'noSensation' | 'noSensationRescaled' | 'toleranceRamp'
}

/** data/curated/skinmaps/innervation.<body>.json 中用到的部分 / The part of innervation.<body>.json that is used. */
export interface InnervationTable {
  body: string
  skinPart: string
  dermatomes: {
    dermatome: string
    segments: string[]
    concept: string | null
    parts: Record<SideLR, { id: string; name: string }[]>
  }[]
  cutaneous: {
    territory: string
    basis: string
    concept: string | null
    nerveParts: Record<SideLR, string[]>
    chain: { name: string; parts: Record<SideLR, string[]>; gapMm?: Partial<Record<SideLR, number>> }[]
    segments: string[]
    segmentsSource?: string
    rootParts: Record<SideLR, string[]>
  }[]
}

/** 一张体表图；与 src/anatomy/skinmaps.ts 的 LoadedSkinMap 兼容 / One skin map; compatible with LoadedSkinMap. */
export interface PainSkinMap {
  id: 'dermatome' | 'cutaneousNerve'
  regions: { name: Bilingual; concept?: string }[]
  data: ArrayLike<number>
}

/**
 * 模型读取的身体数据，全部来自已有的文件格式；不含任何写死的顶点下标。
 * The body data the model reads, all in the existing file formats; no vertex index is hard-coded.
 */
export interface PainBody {
  body: BodyId
  skin: {
    /** 皮肤部件 id（skinmaps.json 的 part）/ Part.id of the skin (the `part` of skinmaps.json). */
    part: string
    /** 静止姿势下皮肤顶点的 xyz（米），GLB 解码后的顶点顺序 / Rest-pose skin vertices, flat xyz in metres, in GLB vertex order. */
    positions: ArrayLike<number>
  }
  skinMaps: { part: string; vertexCount: number; maps: PainSkinMap[] }
  innervation: InnervationTable
  nerves: NervePath[]
  /** anatomy.json 的部件（只用 id、name、centroid）/ Parts of anatomy.json (only id, name, centroid are used). */
  parts: { id: string; name: string; centroid: Vec3 }[]
  /** rig.json 的关节；没有时不给反射姿势，也不细分指尖 / Joints of rig.json; without them no reflex pose and no fingertip refinement. */
  joints?: Joint[]
}

/** 引用 sources.json 的一条出处 / One entry of sources.json. */
export interface SourceRef {
  id: string
  citation: string
  doi: string
  url: string
  license: string
  opened: string
  supports: Bilingual
}

/** 解释数据里的一个数：值、单位、出处或“假设” / One number of the explanation data: value, unit, source or "assumption". */
export interface TraceNumber {
  label: Bilingual
  value: number | [number, number]
  unit: string
  /** sources.json 的 id；空 = 由模型算出 / Ids of sources.json; empty = computed by the model. */
  sources: string[]
  /** 是否为本项目的假设 / Whether it is an assumption of this project. */
  assumption: boolean
  /** 是否由模型从几何或别的数算出 / Whether the model computed it from geometry or other numbers. */
  computed?: boolean
  note?: Bilingual
}

export interface NervePathResult {
  /** 沿神经到脊髓（或脑干）的长度，米 / Length along the nerves to the cord (or brainstem), metres. */
  lengthM: number
  /** centreline：沿 nerves.json 的中心线；straight：没有可用的中心线，取直线距离（下限）。 */
  /** centreline: along the centrelines of nerves.json; straight: none usable, straight-line distance (a lower bound). */
  method: 'centreline' | 'straight'
  /** 路径上跨越中心线之间空隙的直线段总长，米 / Total length of straight bridges across gaps between centrelines, metres. */
  bridgedM: number
  /** 皮肤刺激点到最近的神经中心线的距离，米（已计入 lengthM）/ From the skin point to the nearest centreline, metres (included in lengthM). */
  skinGapM: number
  /** 路径依次经过的部件 id，由远及近 / Part ids along the path, distal to proximal. */
  parts: string[]
  /** 路径折线，展平的 xyz（米），由皮肤到脊髓 / The path polyline, flat xyz in metres, skin to cord. */
  polyline: number[]
  /** 路径的终点（神经根最靠近中线的一点）/ End of the path (the most medial point of the root). */
  end: Vec3
}

export interface ReflexTarget {
  joint: string
  dof: number
  /** 相对静止姿势的目标角度增量，弧度（已按强度缩放，未按活动范围截断）。 */
  /** Target angle increment on the rest pose, radians (scaled by intensity, not yet clamped to the range). */
  angle: number
  /** 该自由度的活动范围，弧度 / Range of that dof, radians. */
  min: number
  max: number
  movement: Bilingual
}

export interface ReflexResult {
  /** 是否发生退缩 / Whether a withdrawal happens. */
  withdraws: boolean
  reason: Bilingual
  limb: 'upper' | 'lower' | null
  side: SideLR
  pattern: Bilingual | null
  /** 刺激开始到肌电开始，秒 / Stimulus onset to EMG onset, seconds. */
  emgLatency: number | null
  /** 刺激开始到肢体开始移动，秒 / Stimulus onset to movement onset, seconds. */
  movementLatency: number | null
  /** 满幅比例 0–1 / Fraction of full amplitude, 0–1. */
  amplitude: number
  targets: ReflexTarget[]
  /** 何时放松（开始回到原姿势），秒 / When the limb starts to return, seconds. */
  releaseAt: number | null
  /**
   * 肢体离开刺激物、刺激因此结束的时刻，秒；刺激没有因退缩而提前结束时为 null。
   * When the limb leaves the stimulating object and so ends the stimulus, seconds; null when the
   * withdrawal does not cut the stimulus short.
   */
  stimulusEndsAt: number | null
}

export interface AutonomicState {
  /** 心率，次/分 / Heart rate, beats/min. */
  heartRate: number
  /** 收缩压、舒张压，mmHg / Systolic and diastolic pressure, mmHg. */
  systolic: number
  diastolic: number
  /** 呼吸频率，次/分 / Respiratory rate, breaths/min. */
  respiratoryRate: number
  /** 瞳孔直径，毫米 / Pupil diameter, mm. */
  pupil: number
  /** 皮肤电导，μS / Skin conductance, μS. */
  skinConductance: number
}

export interface SkinRegionHit {
  map: 'dermatome' | 'cutaneousNerve'
  /** 区域下标（体表图的 regions）；255 = 未分配 / Region index into the map's regions; 255 = unassigned. */
  region: number
  /** innervation 表里的键：皮节名或分布区名 / Key in the innervation table: dermatome or territory name. */
  key: string
  name: Bilingual
}

export interface PainMap {
  skinPart: string
  vertexCount: number
  /** 刺激中心的皮肤顶点 / Skin vertex at the centre of the stimulus. */
  vertex: number
  /** 画接触区用的半径，米 / Radius used to draw the contact area, metres. */
  radiusM: number
  /** 接触区内的顶点及权重（中心 1，边缘 0）/ Vertices within the contact area with weights (1 at the centre, 0 at the edge). */
  focus: { vertices: number[]; weights: number[] }
  dermatome: SkinRegionHit | null
  territory: SkinRegionHit | null
}

export interface TraceStep {
  id: 'stimulus' | 'receptor' | 'site' | 'nerve' | 'segment' | 'conduction' | 'perception' | 'reflex' | 'autonomic'
  title: Bilingual
  text: Bilingual
  numbers: TraceNumber[]
  /** 这一步对应的部件，供高亮 / Parts this step refers to, for highlighting. */
  parts: string[]
}

export interface PainTrace {
  /** 模型的性质声明，界面应当显示 / What the model is; the UI should show it. */
  disclaimer: Bilingual
  kind: StimulusKind
  side: SideLR
  region: { id: string; name: Bilingual }
  /** 刺激量（力、压强或温度）与阈值 / The stimulus quantity (force, pressure or temperature) and its threshold. */
  magnitude: { value: number; unit: string }
  threshold: { value: number; unit: string; site: string; borrowed: boolean }
  /** 刺激–反应函数给出的强度 0–10 / Intensity 0–10 given by the stimulus-response function. */
  drive: number
  /** 热刺激所用的斜率取法；其他刺激为 null / The slope reading used for heat; null for other kinds. */
  heatAnchor: string | null
  dermatome: SkinRegionHit | null
  territory: SkinRegionHit | null
  /** 脊髓节段 / Spinal segments. */
  segments: string[]
  /** 皮神经及其上级神经链，由远及近 / The cutaneous nerve and its parent chain, distal to proximal. */
  nerves: { name: string; parts: string[] }[]
  /** 神经根、神经节部件 / Root and ganglion parts. */
  roots: { id: string; name: string }[]
  path: NervePathResult
  latency: { adelta: number; c: number; firstPain: number; secondPain: number }
  steps: TraceStep[]
  /** 全部要高亮的部件，由远及近 / Every part to highlight, distal to proximal. */
  highlightParts: string[]
  /** 用到的出处 / The sources used. */
  sources: SourceRef[]
  /** 没有模拟或只是近似的事项 / What is not modelled or only approximated. */
  caveats: Bilingual[]
}

export interface PainSample {
  t: number
  /** 疼痛强度 0–10 / Pain intensity 0–10. */
  intensity: number
  /** 快成分（第一痛）和慢成分（第二痛）/ Fast (first pain) and slow (second pain) components. */
  firstPain: number
  secondPain: number
  /** 反射姿势：关节 id → 各自由度的角度增量（弧度），已截断到活动范围；可直接与当前姿势相加。 */
  /** Reflex pose: joint id → angle increments per dof (radians), clamped to the range; add to the current pose. */
  reflexPose: Record<string, number[]>
  autonomic: AutonomicState
}

export interface PainResult extends PainSample {
  reflex: ReflexResult
  trace: PainTrace
  map: PainMap
}
