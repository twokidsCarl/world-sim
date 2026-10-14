// "腔"显示用的颜色：按来历分。与器官的系统色、三种解剖来源的颜色都错开。
// Colours of the lumina display, by origin. Kept apart from the organs' system colours and from the three
// anatomical provenance colours.

import { CONSTRUCTION_COLOR } from '../anatomy/labels.ts'

export const LUMEN_COLOR = {
  /** 由器官外表面内缩文献壁厚推出来的 / derived: the organ's outer surface moved inward by a literature wall thickness */
  derived: '#5b9bf0',
  /** 以真实部件的表面为界（口腔、咽），或标本自己的腔 / bounded by the surfaces of real parts (mouth, pharynx), or a specimen's own lumen */
  bounded: '#6fc7a6',
  /** 构造的 / construction */
  construction: CONSTRUCTION_COLOR,
  /** 一个部件里两者都有，数据没有逐顶点的标记 / both in one part, with no per-vertex marking in the data */
  mixed: '#b88fc4',
  /** "腔"模式下壁的不透明度 / opacity of the walls in the lumina mode */
  wallOpacity: 0.22,
} as const
