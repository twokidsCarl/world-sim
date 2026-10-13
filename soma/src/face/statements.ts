// 表情面板和嵌入控件都要显示的声明文字：单独成文件，这样面板本身可以按需加载。
// The statements shown by both the Expression panel and the embed controls: a file of their own, so that the panel itself can
// be loaded on demand.

/** 这个面板是什么、不是什么（界面上必须明说）。 What this panel is and is not (must be stated in the UI). */
export const EXPRESSION_STATEMENT: { zh: string; en: string }[] = [
  {
    zh: '情绪表情是按已发表的原型摆出的面部动作组合，用于教学；被模拟的身体没有情绪，也没有主观体验。',
    en: 'An emotion expression here is a combination of facial actions set from published prototypes, for teaching; the simulated body has no emotions and no subjective experience.',
  },
  {
    zh: '每种情绪用到哪些动作单元取自 Du、Tao、Martinez 2014；各动作单元的强度是本项目的假设。口形的方法取自 JALI（Edwards 等 2016）；视位表里的数值是假设。',
    en: 'Which action units make up each emotion is from Du, Tao & Martinez 2014; the intensity of each unit is an assumption of this project. The method for mouth shapes is from JALI (Edwards et al. 2016); the numbers in the viseme table are assumptions.',
  },
]

/** 由音频得到的口形有多可靠（界面上必须明说）。 How far mouth shapes from audio can be trusted (must be stated in the UI). */
export const SPEECH_STATEMENT = {
  zh: '由声音推出的口形只是近似：开口度较可靠，圆唇一般，闭唇较弱（只当作一般的闭合，分不出部位）；唇齿音（f、v 的下唇碰上齿）检测不出来。这里没有语音合成，文件只在本页内解码，不会上传。',
  en: 'Mouth shapes derived from sound are approximate: opening is fairly reliable, rounding moderate, lip closure weak (treated as a generic closure of unknown place); labiodental shapes (lower lip to upper teeth, f and v) are not detected. There is no speech synthesis, and the file is decoded in this page only and never uploaded.',
}
