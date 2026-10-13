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
    zh: '每种情绪用到哪些动作单元取自 Du、Tao、Martinez 2014；各动作单元的强度是本项目的假设。口形的方法取自 JALI（Edwards 等 2016）；视位表里正常朗读的下颌开度按实测的发音数据标定，唇的强度、夸张风格和普通话专用的口形是假设。',
    en: 'Which action units make up each emotion is from Du, Tao & Martinez 2014; the intensity of each unit is an assumption of this project. The method for mouth shapes is from JALI (Edwards et al. 2016); in the viseme table the jaw openings of normal read speech are calibrated against measured articulation, while lip intensities, the exaggerated style and the Mandarin-only shapes are assumptions.',
  },
]

/** 由音频得到的口形有多可靠（界面上必须明说）。 How far mouth shapes from audio can be trusted (must be stated in the UI). */
export const SPEECH_STATEMENT = {
  zh: '由声音推出的口形只是近似：开口度较可靠，圆唇一般，闭唇较弱（只当作一般的闭合，分不出部位）；唇齿音（f、v 的下唇碰上齿）检测不出来。文件只在本页内解码，不会上传。',
  en: 'Mouth shapes derived from sound are approximate: opening is fairly reliable, rounding moderate, lip closure weak (treated as a generic closure of unknown place); labiodental shapes (lower lip to upper teeth, f and v) are not detected. The file is decoded in this page only and never uploaded.',
}

/** "说一句话"里声音和口形的来历（界面上必须明说）。 Where the audio and the mouth shapes of "say something" come from (must be stated in the UI). */
export const SAY_STATEMENT = {
  zh: '这里的声音是机器合成的，不是真人的录音。口形由合成器给出的音素时间线决定（每个音对应一个口形，再按 JALI 的习惯做协同发音），不是从声音里猜的；模拟人并没有在说话，也不理解这些话。',
  en: 'The audio here is machine-synthesized, not a recording of a person. The mouth shapes are set by the phoneme timeline that comes with the audio (one shape per sound, co-articulated by the JALI habits), not guessed from the sound; the simulated body is not speaking and understands none of it.',
}

/** 视位表的数值哪些是量的、哪些是假设（界面上必须明说）。 Which numbers of the viseme table are measured and which assumed (must be stated in the UI). */
export const VISEME_STATEMENT = {
  zh: '正常风格的下颌开度按电磁发音仪实测的切牙开度均值标定（三位英语说话人；其中两位来自 MOCHA-TIMIT，该语料只许研究和教育使用，这里只用了本项目算出的汇总量），部分舌位取自实测的线圈高度。唇的强度、夸张风格的全部数值、普通话专用的五个口形（ü、卷舌、龈腭、儿、h）都是假设。',
  en: 'The jaw openings of the normal style are calibrated against mean incisor openings measured by electromagnetic articulography (three English speakers; two are from MOCHA-TIMIT, a corpus licensed for research and education only, of which only aggregates computed by this project are used), and some tongue weights come from measured coil heights. Lip intensities, every number of the exaggerated style and the five Mandarin-only shapes (ü, retroflex, alveolo-palatal, er, h) are assumptions.',
}
