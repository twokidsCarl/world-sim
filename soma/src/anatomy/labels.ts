// 契约里各个枚举的显示用文字和颜色。
// Display labels and colours for the contract's enums.

import type { Provenance, RelationKind, Side, TissueId } from './types.ts'

export const TISSUE_LABEL: Record<TissueId, { zh: string; en: string }> = {
  skin: { zh: '皮肤', en: 'Skin' },
  fat: { zh: '脂肪', en: 'Fat' },
  fascia: { zh: '筋膜', en: 'Fascia' },
  muscle: { zh: '肌肉', en: 'Muscle' },
  tendon: { zh: '肌腱', en: 'Tendon' },
  ligament: { zh: '韧带', en: 'Ligament' },
  cartilage: { zh: '软骨', en: 'Cartilage' },
  bone: { zh: '骨', en: 'Bone' },
  tooth: { zh: '牙', en: 'Tooth' },
  artery: { zh: '动脉', en: 'Artery' },
  vein: { zh: '静脉', en: 'Vein' },
  heart: { zh: '心脏', en: 'Heart' },
  nerve: { zh: '神经', en: 'Nerve' },
  brain: { zh: '脑', en: 'Brain' },
  organ: { zh: '器官', en: 'Organ' },
  gland: { zh: '腺体', en: 'Gland' },
  space: { zh: '腔隙', en: 'Space' },
  other: { zh: '其他', en: 'Other' },
}

/** 柔和、可读的组织颜色；null 表示用所在系统的颜色。 */
/** Muted, readable tissue colours. null = use the system's colour. */
export const TISSUE_COLOR: Record<TissueId, string | null> = {
  skin: '#dcb59b',
  fat: '#e2cf86',
  fascia: '#d5d0c4',
  muscle: '#ad5248',
  tendon: '#dcd3c0',
  ligament: '#cfc8b2',
  cartilage: '#b4cfd3',
  bone: '#e4dcc8',
  tooth: '#f1eee6',
  artery: '#c2343b',
  vein: '#3f62a8',
  heart: '#a9433f',
  nerve: '#dfbf4a',
  brain: '#d8b4a9',
  organ: null,
  gland: '#c39a70',
  space: '#8fa3b5',
  other: null,
}

/** 默认画成半透明的组织，这样能看见里面。 */
/** Tissues drawn see-through by default so the inside is visible. */
export const TISSUE_OPACITY: Partial<Record<TissueId, number>> = {
  skin: 0.14,
  fat: 0.2,
  fascia: 0.25,
  space: 0.2,
}

export const TISSUE_ROUGHNESS: Partial<Record<TissueId, number>> = {
  bone: 0.8,
  tooth: 0.35,
  artery: 0.42,
  vein: 0.42,
  nerve: 0.6,
  muscle: 0.58,
  cartilage: 0.5,
}

export const SIDE_LABEL: Record<Side, { zh: string; en: string }> = {
  L: { zh: '左侧', en: 'Left' },
  R: { zh: '右侧', en: 'Right' },
  M: { zh: '正中 / 不分侧', en: 'Midline / unpaired' },
}

export const PROVENANCE_LABEL: Record<Provenance, { zh: string; en: string; hint: string }> = {
  scanned: { zh: '扫描重建', en: 'Scanned', hint: '由真人断层影像分割、重建得到的实测形状。' },
  warped: { zh: '配准变形', en: 'Warped', hint: '取自另一数据集，经配准变形对齐到本人体；位置和形状为推算，非实测。' },
  curated: { zh: '人工建模', en: 'Curated', hint: '由建模师参照解剖图谱手工绘制；形状和走行为示意，非实测。' },
}

/**
 * 个别部件的外观（按英文名）：眼球前部和口内几样东西按系统色画出来不像样（眼属于神经系统，会是黄的），
 * 而它们现在能透过皮肤的开口直接看到。颜色是示意，不是测量值。
 * The look of a few parts (by English name): the front of the eye and the things in the mouth do not read
 * right in their system colour (the eye belongs to the nervous system and would be yellow), and they are now
 * seen directly through the skin's openings. The colours are illustrative, not measured.
 */
export const PART_LOOK: { match: RegExp; color: string; opacity?: number }[] = [
  { match: /\bsclera$/i, color: '#efece4' },
  { match: /\biris$/i, color: '#5a4030' },
  { match: /\blens$/i, color: '#14110f' },
  { match: /\bcornea$/i, color: '#dfe6ea', opacity: 0.07 },
  { match: /^anterior chamber/i, color: '#cfd8dc', opacity: 0.06 },
  { match: /^gingiva/i, color: '#d98a8a' },
  { match: /^tongue$/i, color: '#c96f6f' },
  // 眉毛：不给颜色的话与皮肤同色，贴在皮肤上分不出来 / eyebrows: without a colour of their own they take the skin's and cannot be told from it
  { match: /^eyebrow$/i, color: '#4a382c' },
]

export function partLook(name: string): { color: string; opacity?: number } | undefined {
  return PART_LOOK.find((x) => x.match.test(name))
}

/** 构造物：为衔接或开口而造的几何（过渡环、口腔袋、睑缘内卷），不是解剖数据 / Construction: geometry built to join or open pieces (blend rings, oral pouch, lid rims); not anatomical data. */
export const CONSTRUCTION_LABEL = { zh: '构造物', en: 'Construction', hint: '为把几片皮肤接起来、或把眼和口做成真正的开口而构造的几何；不是扫描数据，也不是解剖结构。' }
/** 构造物用的颜色：与三种解剖来源的色相都不同 / The colour of construction: a hue apart from the three anatomical provenances. */
export const CONSTRUCTION_COLOR = '#d04fa0'

/**
 * 按来源着色时的颜色：每种来源一个色相，同一来源有多个数据集时再分深浅。绿 = 实测，琥珀 = 推算，蓝 / 紫 = 手绘。
 * Colours for the "colour by source" mode: one hue per provenance, a second shade when
 * several datasets share a provenance. Green = measured, amber = inferred, blue/violet = drawn.
 */
const PROVENANCE_COLORS: Record<Provenance, string[]> = {
  scanned: ['#86b89c', '#5f9f8f'],
  warped: ['#e0a13c', '#d07a3a'],
  curated: ['#6f9be8', '#a884e0', '#5fb8d8'],
}

export function provenanceColor(provenance: Provenance, sourceOrdinal = 0): string {
  const shades = PROVENANCE_COLORS[provenance] ?? ['#9aa3ad']
  return shades[Math.min(sourceOrdinal, shades.length - 1)]!
}

export const RELATION_LABEL: Record<RelationKind, { zh: string; en: string }> = {
  origin: { zh: '起点', en: 'Origin' },
  insertion: { zh: '止点', en: 'Insertion' },
  innervatedBy: { zh: '神经支配', en: 'Innervated by' },
  innervates: { zh: '支配', en: 'Innervates' },
  arterialSupply: { zh: '动脉供应', en: 'Arterial supply' },
  venousDrainage: { zh: '静脉回流', en: 'Venous drainage' },
  lymphaticDrainage: { zh: '淋巴回流', en: 'Lymphatic drainage' },
  connectsWith: { zh: '连接', en: 'Connects with' },
  antagonist: { zh: '拮抗肌', en: 'Antagonist' },
}
