// 发色：按黑色素（真黑素、褐黑素）浓度算纤维的吸收系数，再换成着色器用的"底色"。
// 吸收系数按 Chiang 等 2016 的做法：σa = C_eu·σ_eu + C_pheo·σ_pheo，每单位浓度的 σ 取 pbrt 第 4 版"毛发散射"一节的数
// （见 data/curated/hair/hair.json）。σa 以纤维半径为长度单位。
// 底色 C = exp(−4σa)：Karis 2016 的透射项写成 C^(½·√(1−h²a²)/cosθd)，这样正好等于沿纤维内路径 2√(1−h²a²)/cosθd 的吸收。
// Hair colour: the fibre's absorption coefficient from the melanin concentrations (eumelanin, pheomelanin), turned into
// the "base colour" the shader uses. Absorption follows Chiang et al. 2016: σa = C_eu·σ_eu + C_pheo·σ_pheo, with the σ per
// unit concentration from pbrt 4th ed., "Scattering from Hair" (see data/curated/hair/hair.json). σa is per fibre radius.
// Base colour C = exp(−4σa): Karis 2016 writes the transmission as C^(½·√(1−h²a²)/cosθd), which then equals the
// absorption along the in-fibre path 2√(1−h²a²)/cosθd.

export type HairColour = 'black' | 'darkbrown' | 'brown' | 'blonde' | 'red' | 'grey'

export const HAIR_COLOURS: HairColour[] = ['black', 'darkbrown', 'brown', 'blonde', 'red', 'grey']

/** 每单位浓度的吸收（RGB）/ absorption per unit concentration (RGB) */
export const EUMELANIN: [number, number, number] = [0.419, 0.697, 1.37]
export const PHEOMELANIN: [number, number, number] = [0.187, 0.4, 1.05]
/** 无色素纤维（白发）的吸收：角蛋白略带黄（本项目的假设）/ absorption of an unpigmented (white) fibre: keratin, slightly yellow (this project's assumption) */
export const UNPIGMENTED: [number, number, number] = [0.02, 0.035, 0.07]

export interface MelaninMix {
  eumelanin: number
  pheomelanin: number
  /** 无色素纤维的比例（灰白发）/ share of unpigmented fibres (greying) */
  white: number
}

/**
 * 预设。黑、棕、金的真黑素浓度 8、1.3、0.3 取自 pbrt；深棕（3）、红（真黑素 0.1、褐黑素 2）、灰（六成白发）是本项目的假设。
 * Presets. Eumelanin 8, 1.3, 0.3 for black, brown, blonde are pbrt's; dark brown (3), red (eumelanin 0.1, pheomelanin 2) and grey
 * (six in ten fibres white) are this project's assumptions.
 */
export const MELANIN: Record<HairColour, MelaninMix> = {
  black: { eumelanin: 8, pheomelanin: 0, white: 0 },
  darkbrown: { eumelanin: 3, pheomelanin: 0, white: 0 },
  brown: { eumelanin: 1.3, pheomelanin: 0, white: 0 },
  blonde: { eumelanin: 0.3, pheomelanin: 0, white: 0 },
  red: { eumelanin: 0.1, pheomelanin: 2, white: 0 },
  grey: { eumelanin: 1.3, pheomelanin: 0, white: 0.6 },
}

export const DEFAULT_HAIR_COLOUR: HairColour = 'darkbrown'

export function isHairColour(v: string): v is HairColour {
  return (HAIR_COLOURS as string[]).includes(v)
}

/** 吸收系数 σa（每纤维半径）/ absorption coefficient σa (per fibre radius) */
export function sigmaA(m: { eumelanin: number; pheomelanin: number }): [number, number, number] {
  return [0, 1, 2].map((k) => m.eumelanin * EUMELANIN[k]! + m.pheomelanin * PHEOMELANIN[k]!) as [number, number, number]
}

/** 着色器的底色 C = exp(−4σa) / the shader's base colour C = exp(−4σa) */
export function baseColour(sigma: [number, number, number]): [number, number, number] {
  return sigma.map((s) => Math.exp(-4 * s)) as [number, number, number]
}

/** 多次散射的反照率 exp(−2.6·√σa)（材质的漫射项用它；系数按观感定）/ multiple-scattering albedo exp(−2.6·√σa) (the material's diffuse term uses it; the factor is set by eye) */
export function albedo(sigma: [number, number, number]): [number, number, number] {
  return sigma.map((s) => Math.exp(-2.6 * Math.sqrt(s))) as [number, number, number]
}

/** 界面上的色块：多次散射的反照率 / the swatch in the UI: the multiple-scattering albedo */
export function swatch(c: HairColour): string {
  const m = MELANIN[c]
  const pig = albedo(sigmaA(m))
  const white = albedo(UNPIGMENTED)
  const rgb = pig.map((v, k) => v * (1 - m.white) + white[k]! * m.white)
  // 线性 → sRGB / linear → sRGB
  const enc = (v: number): number => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055))
  return `#${rgb.map((v) => enc(Math.min(1, v)).toString(16).padStart(2, '0')).join('')}`
}

export const HAIR_COLOUR_LABEL: Record<HairColour, { zh: string; en: string }> = {
  black: { zh: '黑', en: 'Black' },
  darkbrown: { zh: '深棕', en: 'Dark brown' },
  brown: { zh: '棕', en: 'Brown' },
  blonde: { zh: '金', en: 'Blonde' },
  red: { zh: '红', en: 'Red' },
  grey: { zh: '灰白', en: 'Grey' },
}
