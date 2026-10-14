// 衣服的名单与 wear= 参数的解析（纯函数，URL 模块也用）。
// The list of garments and parsing of the wear= parameter (pure; the URL module uses it too).

/** 可以穿的衣服（URL 里 wear= 的取值）/ The garments that can be worn (values of wear= in the URL). */
export const GARMENTS = ['tee', 'pants', 'skirt', 'compression-top', 'sports-bra', 'tights'] as const
export type GarmentId = (typeof GARMENTS)[number]

/** wear= 的值 → 衣服列表（未知的忽略，去重）/ A wear= value → the list of garments (unknown ones dropped, no repeats). */
export function parseWear(value: string): GarmentId[] {
  const out: GarmentId[] = []
  for (const v of value.split(',')) {
    const g = v.trim() as GarmentId
    if ((GARMENTS as readonly string[]).includes(g) && !out.includes(g)) out.push(g)
  }
  return out
}

/** 每副人体的成套穿法（界面上的选项）/ Each body's outfits (the options in the interface). */
export const OUTFITS: Record<string, { id: string; zh: string; en: string; wear: GarmentId[] }[]> = {
  male: [
    { id: 'everyday', zh: '日常：T 恤、长裤', en: 'Everyday: T-shirt, trousers', wear: ['tee', 'pants'] },
    { id: 'sport', zh: '运动：紧身上衣、紧身裤', en: 'Sport: compression top, tights', wear: ['compression-top', 'tights'] },
  ],
  female: [
    { id: 'everyday', zh: '日常：T 恤、长裤', en: 'Everyday: T-shirt, trousers', wear: ['tee', 'pants'] },
    { id: 'skirt', zh: '日常：T 恤、半身裙', en: 'Everyday: T-shirt, skirt', wear: ['tee', 'skirt'] },
    { id: 'sport', zh: '运动：运动内衣、紧身裤', en: 'Sport: sports bra, leggings', wear: ['sports-bra', 'tights'] },
  ],
}
