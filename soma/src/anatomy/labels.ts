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
  scanned: { zh: '扫描数据', en: 'Scanned', hint: '几何来自原始数据集的分割结果' },
  warped: { zh: '配准变形', en: 'Warped', hint: '几何由其他来源配准、变形或镜像得到' },
  curated: { zh: '人工整理', en: 'Curated', hint: '几何经人工建模或修订' },
}

export const RELATION_LABEL: Record<RelationKind, { zh: string; en: string }> = {
  origin: { zh: '起点', en: 'Origin' },
  insertion: { zh: '止点', en: 'Insertion' },
  innervatedBy: { zh: '神经支配', en: 'Innervation' },
  arterialSupply: { zh: '动脉供应', en: 'Arterial supply' },
  venousDrainage: { zh: '静脉回流', en: 'Venous drainage' },
  lymphaticDrainage: { zh: '淋巴回流', en: 'Lymphatic drainage' },
  connectsWith: { zh: '连接', en: 'Connects with' },
  antagonist: { zh: '拮抗肌', en: 'Antagonist' },
}
