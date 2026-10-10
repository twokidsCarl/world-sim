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
