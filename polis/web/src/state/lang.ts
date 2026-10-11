// 界面语言。只管界面文字和语料；场景里的人名、谣言的说法和心里话保持中文原文。
// The interface language. It covers interface text and the corpus only; people's names, the wordings of the rumour and
// characters' thoughts stay in the original Chinese.
export type Lang = 'zh' | 'en'

let current: Lang = 'zh'

export const getLang = (): Lang => current
export const setLang = (lang: Lang): void => {
  current = lang
}

/** 按当前语言取一句话 / Pick a string by the current language */
export const tr = (zh: string, en: string): string => (current === 'en' ? en : zh)

/** 数据里的字段：有英文就用英文，没有就退回中文 / A field from the data: its English when there is one, otherwise the Chinese */
export const loc = (zh: string, en?: string | null): string => (current === 'en' && en ? en : zh)
