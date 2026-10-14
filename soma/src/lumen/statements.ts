// "腔"显示的声明：图例、面板和嵌入页都用这一份。
// The statements of the lumina display, shared by the legend, the panel and the embed.

import { FLY_MIN_FILL, FLY_MIN_RADIUS } from './state.ts'

export const LUMEN_STATEMENT = [
  { zh: '腔不是扫描出来的：由器官外表面向内缩一个文献（或假设）的壁厚推出来。', en: 'The lumina are not scanned: each is the organ’s outer surface moved inward by a wall thickness from the literature (or assumed).' },
  { zh: '构造的部分单独着色：从唇到牙的一段、腭帆、肛管末段，以及器官之间的衔接。', en: 'Construction is coloured apart: the stretch from lips to teeth, the velum, the end of the anal canal, and the joins between organs.' },
  { zh: '充盈只移动腔的表面，器官的壁不跟着动。', en: 'Filling moves the lumen surface only; the organ walls do not move with it.' },
] as const

export const LUMEN_FEMALE_NOTE = {
  zh: '这副人体还没有推导出来的腔，这里只显示标本自己的腔；它们没有充盈数据，也不能漫游。',
  en: 'The derived lumina are not built for this body yet; only the specimen’s own lumina are shown. They have no filling data and no fly-through.',
} as const

export const FLY_RULE = {
  zh: `漫游时消化道各段的充盈度至少取 ${FLY_MIN_FILL}（整条一起，不是只在相机附近）；仍窄于 ${FLY_MIN_RADIUS * 2000} 毫米的地方按圈心撑开到这个宽度，只为看得见，不是数据。段与段不相接处（咽到食管、食管入胃、回肠入升结肠）相机会离开腔走一小段。漫游时不画壁（各片器官网格两端的封盖会横在腔里）。`,
  en: `In the fly-through every segment of the canal is filled to at least ${FLY_MIN_FILL} (the whole canal, not just near the camera); what is still narrower than ${FLY_MIN_RADIUS * 2000} mm is widened about its ring centres to that width, only so that it can be seen — it is not data. Where segments do not meet (pharynx to oesophagus, oesophagus into stomach, ileum into ascending colon) the camera leaves the lumen for a short way. Walls are not drawn in the fly-through (the end caps of the organ pieces’ meshes would lie across the lumen).`,
} as const
