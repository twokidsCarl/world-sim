// 对该 FMA 概念而言错误的 Wikidata 中文标签（其实是别的结构、乱码或不是中文），在此手工替换。
// 以 BodyParts3D 的英文名为键。这些条目的 zhSource 为 "machine-translation:override"：没有出处，也未经审核。
// 仅仅是地区性或口语化的标签不在这里处理，而由“大陆用语优先”策略用词表词条替换（见 names.ts）。
//
// Wikidata zh labels that are wrong for the FMA concept (label of a different structure, garbled,
// or not Chinese), replaced by hand. Keyed by the BodyParts3D English name.
// Entries get zhSource "machine-translation:override": they are NOT sourced, and unreviewed.
// Merely regional or colloquial labels are not handled here; the mainland-wording policy replaces
// them with exact lexicon terms (see names.ts).
export const ZH_OVERRIDES: Record<string, { zh: string; reason: string }> = {
  'mitral valve': { zh: '二尖瓣', reason: 'Wikidata label 二瓣膜 is garbled' },
  vertebra: { zh: '椎骨', reason: 'Wikidata label 椎骨切迹 means vertebral notch' },
  'suprarenal vein': { zh: '肾上腺静脉', reason: 'Wikidata label 右肾上腺静脉 is the right-side vessel only' },
  'common iliac vein': { zh: '髂总静脉', reason: 'Wikidata label 肠骨的静脉 is not an anatomical term' },
  'urinary bladder': { zh: '膀胱', reason: 'Wikidata label 膀胱悬垂体 is a different structure' },
  'bony pelvis': { zh: '骨盆', reason: 'Wikidata label 髋骨 means hip bone' },
  'internal pudendal vein': { zh: '阴部内静脉', reason: 'Wikidata label 前庭球静脉 is the vein of the vestibular bulb' },
  'muscle of posterior compartment of leg': { zh: '小腿后群肌', reason: 'Wikidata label 小腿肚 is the colloquial word for calf' },
  'lower limb': { zh: '下肢', reason: 'Wikidata label 人类腿部 means human leg' },
  'flexor hallucis longus': { zh: '踇长屈肌', reason: 'Wikidata label 足部屈肌 is generic (flexor of foot)' },
  'flexor digitorum brevis': { zh: '趾短屈肌', reason: 'Wikidata label 伸趾短肌 names an extensor' },
  'extensor hallucis brevis': { zh: '踇短伸肌', reason: 'Wikidata label 伸拇短肌 names the thumb muscle' },
  'superficial palmar arterial arch': { zh: '掌浅弓', reason: 'Wikidata label 浅掌枝 is not the arch' },
  'plantar arch': { zh: '足底弓', reason: 'Wikidata label 掌动脉弓 means palmar arterial arch' },
  'anatomical lobe': { zh: '叶', reason: 'Wikidata label 乳叶 means lobe of breast' },
  digastric: { zh: '二腹肌', reason: 'Wikidata label 二腹肌前腹 is the anterior belly only' },
  mylohyoid: { zh: '下颌舌骨肌', reason: 'Wikidata label 颏舌肌 is genioglossus' },
  'transverse arytenoid': { zh: '杓横肌', reason: 'Wikidata label 杓肌 is the unspecific arytenoid muscle' },
  'lateral rectus': { zh: '外直肌', reason: 'Wikidata label 眼直肌 is generic (rectus of eye)' },
  'superior oblique': { zh: '上斜肌', reason: 'Wikidata label 眼斜肌 is generic (oblique of eye)' },
  'rectus capitis posterior minor': { zh: '头后小直肌', reason: 'Wikidata label 小后头直筋 is Japanese' },
  mandible: { zh: '下颌骨', reason: 'Wikidata label 上颚 means upper jaw / palate' },
  'external ear': { zh: '外耳', reason: 'Wikidata label 动耳肌 is the auricular muscle' },
  lip: { zh: '唇', reason: 'Wikidata label 唇结节 is the labial tubercle' },
  'pharyngeal raphe': { zh: '咽缝', reason: 'Wikidata label 咽裂 means pharyngeal cleft' },
  'cingulate gyrus': { zh: '扣带回', reason: 'Wikidata label 扣带皮层 is the cingulate cortex' },
  'stria terminalis': { zh: '终纹', reason: 'Wikidata label 终纹床核 is the bed nucleus of the stria terminalis' },
  'tentorium cerebelli': { zh: '小脑幕', reason: 'Wikidata label 小脑疝 means cerebellar herniation' },
  spinalis: { zh: '棘肌', reason: 'Wikidata label 脊柱胸肌 is not an anatomical term' },
  'nasolacrimal duct': { zh: '鼻泪管', reason: 'Wikidata label 泪器 is the lacrimal apparatus' },
  'alimentary system': { zh: '消化系统', reason: 'Wikidata label 排遗系统 means excretory system' },
  'integumentary system': { zh: '皮肤系统', reason: 'Wikidata label 表皮系统 means epidermal system' },
  integument: { zh: '体被', reason: 'Wikidata label 覆盖物 is the generic word for a covering' },
  temporoparietalis: { zh: '颞顶肌', reason: 'Wikidata label 颞肌 is temporalis' },
  neurocranium: { zh: '脑颅', reason: 'Wikidata label 脑壳 is colloquial for skull' },
}

/**
 * 这些英文名的 Wikidata 中文标签本身就是可接受的大陆用法，尽管词表里为构词保留了更短的形式
 * （作名称用 心脏，构词用 心：心室/心壁）。对它们保留 Wikidata 标签；其余情况下词表的整词词条优先。
 * 以不带侧别的英文名为键。
 *
 * English names whose Wikidata zh label is acceptable mainland usage even though the lexicon
 * holds a shorter form for use inside compounds (心脏 as a name, 心 in 心室/心壁). For these the
 * Wikidata label is kept; everywhere else an exact lexicon entry wins (mainland wording policy).
 * Keyed by the unlateralised English name.
 */
export const KEEP_WIKIDATA_LABEL = new Set<string>([
  'heart', // 心脏 (lexicon: 心)
  'liver', // 肝脏 (肝)
  'head', // 头部 (头)
  'mouth', // 口腔 (口)
  'rib', // 肋骨 (肋)
  'muscle organ', // 肌肉 (肌)
  'hair', // 毛发 (毛)
  'duct', // 导管 (管)
  'parenchyma', // 实质组织 (实质)
  'neuraxis', // 中枢神经系统 (神经轴)
])

/**
 * 按概念 id 固定的名称，用于英文标签本身有歧义的类。
 * zhSource 为 "machine-translation:override"；与其他内容一样未经审核。
 *
 * Names fixed per concept id, for classes whose English label is ambiguous on its own.
 * zhSource "machine-translation:override"; unreviewed like everything else.
 */
export const ZH_ID_OVERRIDES: Record<string, { zh: string; reason: string }> = {
  FMA40005: { zh: '腕尺侧副韧带', reason: 'FMA label is the bare "ulnar collateral ligament"; the class is the wrist ligament (Wikidata: Ligamentum collaterale carpi ulnare)' },
  FMA20273: { zh: '肛尾韧带', reason: 'the dataset part is the anococcygeal ligament; FMA also labels the class "anococcygeal body" (肛尾体)' },
  FMA38869: { zh: '肘关节尺侧副韧带', reason: 'ulnar collateral ligament of the elbow joint; kept distinct from the wrist ligament FMA40005' },
  // 宫颈管：机器翻译给出“子宫颈腔”，通常的中文术语是“子宫颈管”（也常写作“宫颈管”） / cervical canal: the machine translation gave 子宫颈腔; the usual Chinese term is 子宫颈管 (宫颈管 is also common)
  FMA302971: { zh: '子宫颈管', reason: 'cervical canal: the machine translation 子宫颈腔 is not the usual term; 子宫颈管 (also written 宫颈管) is' },
}
