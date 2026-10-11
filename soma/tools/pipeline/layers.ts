// 剥离层（Part.depth），由浅到深。只在此处定义一次。
//
// 顺序采用经典的解剖剥离顺序，而非严格的几何顺序：皮肤、筋膜、肌肉、神经血管结构、内脏、
// 关节、骨。注意骨骼排在最后，因此被骨包围的结构（脑、椎管内容物）所在的层比包围它们的骨
// 更浅；仅靠剥离永远无法显露它们。
//
// 肌肉系统的部件（肌、肌腱，以及与它们归在一起的韧带和缝）按几何分为浅层和深层，见
// `exposure.ts`：当部件表面至少有 SUPERFICIAL_EXPOSURE 的比例朝向皮肤、其间没有其他肌、骨、
// 软骨或器官遮挡，且皮肤距离不超过 EXPOSURE_MAX_DISTANCE 时，该部件为浅层。左右孪生件共用
// 同一判定（取这一对的平均暴露度）。紧贴皮肤之下的扁肌得分约为 0.5（它的外侧面），所以该
// 阈值大致相当于“外侧面有三分之一未被遮盖”。
//
// Peel layers (Part.depth), superficial to deep. Defined once, here.
//
// The order is the classical dissection order rather than a strict geometric one: skin, fascia,
// muscles, neurovascular structures, viscera, joints, bones. Note that the skeleton is last, so
// structures enclosed by bone (brain, spinal canal contents) sit in a shallower layer than the
// bone around them; peeling alone never exposes them.
//
// Muscular-system parts (muscles, tendons, the ligaments and raphes filed with them) are split
// into a superficial and a deep layer geometrically, see `exposure.ts`: a part is superficial
// when at least SUPERFICIAL_EXPOSURE of its surface looks at the skin with no other muscle, bone,
// cartilage or organ in between and the skin is at most EXPOSURE_MAX_DISTANCE away. Left/right
// twins share one verdict (the mean exposure of the pair). A flat muscle lying directly under
// the skin scores about 0.5 (its outer face), so the threshold is roughly "a third of the outer
// face is uncovered".

import type { SystemId, TissueId } from '../../src/anatomy/types.ts'

export const LAYERS: { key: string; name: { en: string; zh: string } }[] = [
  { key: 'skin', name: { en: 'Skin', zh: '皮肤' } },
  // 皮下脂肪：由几何推导的一层，位于皮肤与筋膜之间 / subcutaneous fat: a derived layer between skin and fascia
  { key: 'fat', name: { en: 'Subcutaneous fat', zh: '皮下脂肪' } },
  { key: 'fascia', name: { en: 'Fascia', zh: '筋膜' } },
  { key: 'muscle-superficial', name: { en: 'Superficial muscles', zh: '浅层肌' } },
  { key: 'muscle-deep', name: { en: 'Deep muscles', zh: '深层肌' } },
  { key: 'neurovascular', name: { en: 'Vessels and nerves', zh: '血管与神经' } },
  { key: 'viscera', name: { en: 'Organs', zh: '内脏器官' } },
  { key: 'joints', name: { en: 'Cartilage and ligaments', zh: '软骨与韧带' } },
  { key: 'skeleton', name: { en: 'Skeleton', zh: '骨骼' } },
]

export const SUPERFICIAL_EXPOSURE = 0.15
/** 米 / metres */
export const EXPOSURE_MAX_DISTANCE = 0.06

const layer = (key: string): number => {
  const i = LAYERS.findIndex((l) => l.key === key)
  if (i < 0) throw new Error(`unknown layer ${key}`)
  return i
}

/** 该部件是否参与浅层/深层划分？ / Does this part take part in the superficial/deep split? */
export function usesExposure(system: SystemId, tissue: TissueId): boolean {
  return system === 'muscular' && tissue !== 'fascia'
}

/**
 * @param exposure 对 `usesExposure` 为 true 的部件，其暴露的表面比例 /
 *   exposed surface fraction for parts where `usesExposure` is true
 */
export function depthOf(system: SystemId, tissue: TissueId, exposure = 0): number {
  if (system === 'integumentary') return tissue === 'skin' ? layer('skin') : tissue === 'fat' ? layer('fat') : layer('fascia')
  if (system === 'muscular') {
    if (tissue === 'fascia') return layer('fascia')
    return exposure >= SUPERFICIAL_EXPOSURE ? layer('muscle-superficial') : layer('muscle-deep')
  }
  if (system === 'skeletal') {
    return tissue === 'bone' || tissue === 'tooth' ? layer('skeleton') : layer('joints')
  }
  if (tissue === 'tooth' || tissue === 'bone') return layer('skeleton')
  // 心脏、大血管的腔以及其他器官组织，即使属于心血管/神经系统也算内脏；
  // 只有管道本身构成神经血管层
  // heart, great vessels' cavities and other organ tissue are viscera even inside the
  // cardiovascular / nervous systems; only the conduits themselves form the neurovascular layer
  if (tissue === 'artery' || tissue === 'vein' || tissue === 'nerve') return layer('neurovascular')
  if (tissue === 'fat') return layer('fascia')
  return layer('viscera')
}
