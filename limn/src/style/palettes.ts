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

export const ROLES: Role[] = ['soluble', 'membrane', 'nucleic', 'nucleic-binding', 'focus', 'extracellular', 'ligand', 'glycan', 'ion']

export const ROLE_LABEL: Record<Role, string> = {
  soluble: '可溶蛋白',
  membrane: '膜与膜蛋白',
  nucleic: '核酸',
  'nucleic-binding': '核酸结合蛋白',
  focus: '焦点（病毒等）',
  extracellular: '胞外分子',
  ligand: '配体',
  glycan: '糖链',
  ion: '离子',
}

/** Base hue in OKLCh degrees, and how far entities of the same role may spread. */
export const ROLE_HUE: Record<Role, { h: number; spread: number; C: number; L: number }> = {
  soluble: { h: 258, spread: 34, C: 1.0, L: 0 },
  membrane: { h: 142, spread: 22, C: 1.0, L: 0 },
  nucleic: { h: 88, spread: 14, C: 1.0, L: 0.04 },
  'nucleic-binding': { h: 58, spread: 16, C: 1.0, L: 0 },
  focus: { h: 338, spread: 30, C: 1.0, L: 0 },
  extracellular: { h: 78, spread: 16, C: 0.5, L: 0.02 },
  ligand: { h: 328, spread: 0, C: 1.6, L: -0.08 },
  glycan: { h: 110, spread: 0, C: 0.45, L: 0.06 },
  ion: { h: 250, spread: 0, C: 0.15, L: -0.15 },
}

export interface Tone {
  /** lightness of the foreground wash */
  L: number
  /** chroma of non-carbon atoms; carbons are `carbonDrop` less */
  C: number
  carbonDrop: number
  carbonLift: number
}

/** Molecule pictures: bright on white. Sampled: L 0.75-0.84, C up to 0.20. */
export const TONE_MOLECULE: Tone = { L: 0.8, C: 0.165, carbonDrop: 0.036, carbonLift: 0.012 }
/** Landscapes: greyer and a little darker. Sampled: L about 0.72, C about 0.11. */
export const TONE_LANDSCAPE: Tone = { L: 0.73, C: 0.115, carbonDrop: 0.0, carbonLift: 0.0 }
