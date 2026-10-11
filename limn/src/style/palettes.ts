/**
 * Colour roles and the hue each one draws from. The five sectors are
 * Goodsell's own grouping; the lightness and chroma levels were measured
 * from his images (docs/style-guide.md, research/out/stats.json).
 */
export type Role =
  | 'soluble' // cytoplasmic and other soluble proteins
  | 'membrane' // membrane proteins, lipids
  | 'nucleic' // DNA and RNA
  | 'nucleic-binding' // polymerases, histones, ribosomal proteins, Cas9...
  | 'focus' // the subject: viral proteins, the molecule the picture is about
  | 'extracellular' // antibodies, plasma proteins, matrix
  | 'ligand' // drugs, cofactors, substrates
  | 'glycan'
  | 'ion'

/** 角色的显示名在 src/i18n.ts（`roleLabel`），跟随界面语言 / the display names of the roles are in src/i18n.ts (`roleLabel`) and follow the interface language */
export const ROLES: Role[] = ['soluble', 'membrane', 'nucleic', 'nucleic-binding', 'focus', 'extracellular', 'ligand', 'glycan', 'ion']

/** Base hue in OKLCh degrees, and how far entities of the same role may spread. */
export const ROLE_HUE: Record<Role, { h: number; spread: number; C: number; L: number }> = {
  soluble: { h: 258, spread: 34, C: 1.0, L: 0 },
  membrane: { h: 142, spread: 22, C: 1.0, L: 0 },
  nucleic: { h: 88, spread: 14, C: 1.0, L: 0.04 },
  'nucleic-binding': { h: 58, spread: 16, C: 1.0, L: 0 },
  // 主角：紫到品红。量他的流感、新冠、寨卡：h 290–336，彩度 0.09–0.16
  // the subject: violet to magenta. Measured on his influenza, coronavirus and Zika paintings: h 290–336, chroma 0.09–0.16
  focus: { h: 312, spread: 20, C: 1.0, L: 0 },
  extracellular: { h: 78, spread: 16, C: 0.5, L: 0.02 },
  ligand: { h: 328, spread: 0, C: 1.6, L: -0.08 },
  // 糖链画成它所在蛋白的同色浅一号（Goodsell 把它们画成蛋白外缘的小瓣），不再是灰绿的点
  // glycans are a lighter shade of the hue of the protein they sit on (Goodsell paints them as small lobes on its rim), no longer grey-green dots
  glycan: { h: 318, spread: 0, C: 0.55, L: 0.09 },
  ion: { h: 250, spread: 0, C: 0.15, L: -0.15 },
}

export interface Tone {
  /** lightness of the foreground wash */
  L: number
  /** chroma of non-carbon atoms; carbons are `carbonDrop` less */
  C: number
  carbonDrop: number
  carbonLift: number
  /**
   * 同一种分子的相邻拷贝之间色相错开的步长（度），缺省 9。全景里取小一些：9 度时五条链跨出 36 度，
   * 整片像拼布；Goodsell 的同种分子几乎是一个颜色，只靠线和明暗分开。
   * The hue step in degrees between neighbouring copies of one kind of molecule, 9 by default.
   * Smaller in landscapes: at 9, five chains span 36 degrees and read as patchwork, whereas in
   * Goodsell's paintings copies of one molecule are nearly one colour, told apart by line and tone.
   */
  hueStep?: number
}

/** Molecule pictures: bright on white. Sampled: L 0.75-0.84, C up to 0.20. */
export const TONE_MOLECULE: Tone = { L: 0.8, C: 0.165, carbonDrop: 0.036, carbonLift: 0.012 }
/** Landscapes: greyer and a little darker. Sampled: L about 0.72, C about 0.11. */
export const TONE_LANDSCAPE: Tone = { L: 0.76, C: 0.125, carbonDrop: 0.0, carbonLift: 0.0, hueStep: 3 }
