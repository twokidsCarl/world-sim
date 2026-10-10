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
  { key: 'fascia', name: { en: 'Fascia', zh: '筋膜' } },
  { key: 'muscle-superficial', name: { en: 'Superficial muscles', zh: '浅层肌' } },
  { key: 'muscle-deep', name: { en: 'Deep muscles', zh: '深层肌' } },
  { key: 'neurovascular', name: { en: 'Vessels and nerves', zh: '血管与神经' } },
  { key: 'viscera', name: { en: 'Organs', zh: '内脏器官' } },
  { key: 'joints', name: { en: 'Cartilage and ligaments', zh: '软骨与韧带' } },
  { key: 'skeleton', name: { en: 'Skeleton', zh: '骨骼' } },
]

export const SUPERFICIAL_EXPOSURE = 0.15
/** metres */
export const EXPOSURE_MAX_DISTANCE = 0.06

const layer = (key: string): number => {
  const i = LAYERS.findIndex((l) => l.key === key)
  if (i < 0) throw new Error(`unknown layer ${key}`)
  return i
}

/** Does this part take part in the superficial/deep split? */
export function usesExposure(system: SystemId, tissue: TissueId): boolean {
  return system === 'muscular' && tissue !== 'fascia'
}

/**
 * @param exposure exposed surface fraction for parts where `usesExposure` is true
 */
export function depthOf(system: SystemId, tissue: TissueId, exposure = 0): number {
  if (system === 'integumentary') return tissue === 'skin' ? layer('skin') : layer('fascia')
  if (system === 'muscular') {
    if (tissue === 'fascia') return layer('fascia')
    return exposure >= SUPERFICIAL_EXPOSURE ? layer('muscle-superficial') : layer('muscle-deep')
  }
  if (system === 'skeletal') {
    return tissue === 'bone' || tissue === 'tooth' ? layer('skeleton') : layer('joints')
  }
  if (tissue === 'tooth' || tissue === 'bone') return layer('skeleton')
  // heart, great vessels' cavities and other organ tissue are viscera even inside the
  // cardiovascular / nervous systems; only the conduits themselves form the neurovascular layer
  if (tissue === 'artery' || tissue === 'vein' || tissue === 'nerve') return layer('neurovascular')
  if (tissue === 'fat') return layer('fascia')
  return layer('viscera')
}
