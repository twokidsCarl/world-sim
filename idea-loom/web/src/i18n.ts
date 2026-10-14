// 界面的中英切换。两种语言的文字都写在用到它的地方：t('想法池', 'Idea pool')。
// 这个文件不依赖 React 和全局状态；钩子 useT / useLang 在 state/store.ts 里。
// The Chinese/English switch of the UI. Both strings sit at the call site:
// t('想法池', 'Idea pool'). This file depends on neither React nor the store; the
// hooks useT / useLang live in state/store.ts.
export type Lang = 'zh' | 'en'
export type T = (zh: string, en: string) => string

const KEY = 'idea-loom:lang'

// 给纯函数用：按语言二选一。 / For pure functions: choose one of the two by language.
export function tr(lang: Lang, zh: string, en: string): string {
  return lang === 'en' ? en : zh
}

// 取双语数据字段：英文是空的就退回中文。
// Pick a bilingual data field: fall back to the Chinese when the English is empty.
export function pick(lang: Lang, zh: string | null | undefined, en: string | null | undefined): string {
  return lang === 'en' && en && en.trim() ? en : (zh ?? '')
}

// 英文的"数 + 名词"：plural(1, 'idea') 是 "1 idea"，plural(3, 'idea') 是 "3 ideas"。
// English "count + noun": plural(1, 'idea') is "1 idea", plural(3, 'idea') is "3 ideas".
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

// 默认语言：存过就用存的；否则浏览器不是中文就用英文。
// The default language: the saved one if any; otherwise English unless the browser is Chinese.
export function detectLang(saved: string | null | undefined, browser: string | null | undefined): Lang {
  if (saved === 'zh' || saved === 'en') return saved
  return browser && !browser.toLowerCase().startsWith('zh') ? 'en' : 'zh'
}

export function initialLang(): Lang {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(KEY)
  } catch {
    /* 没有 localStorage 也能用 / works without localStorage */
  }
  return detectLang(saved, typeof navigator === 'undefined' ? null : navigator.language)
}

// 当前语言的一份副本，给 React 之外的代码用（接口报错、操作轨迹）。全局状态改语言时同步过来。
// A copy of the current language for code outside React (API errors, the action trail).
// The store keeps it in step when the language changes.
let current: Lang = initialLang()

export const currentLang = (): Lang => current

export function applyLang(lang: Lang, remember = true) {
  current = lang
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
  if (!remember) return
  try {
    localStorage.setItem(KEY, lang)
  } catch {
    /* 同上 / as above */
  }
}

// 后端只给了中文的标签，这里按代码配上英文；没有配到的就用后端给的。
// Labels the backend sends in Chinese only get their English here, keyed by the
// underlying code; anything not listed falls back to the server's label.
const EN = {
  status: { draft: 'Candidate', pool: 'In pool', building: 'Building', built: 'Built', merged: 'Merged', discarded: 'Discarded' },
  event: {
    created: 'Created', edited: 'Rewritten', moved: 'Moved', status: 'Status changed', merged_into: 'Merged',
    discarded: 'Discarded', restored: 'Restored', noted: 'Note', translated: 'Translated',
  },
  by: { import: 'Import', human: 'Manual', assistant: 'Assistant', generator: 'Model', 'claude-code': 'Claude Code', review: 'Review' },
  edge: {
    refined_from: 'refined from', fused_from: 'fused from', split_from: 'split from', inspired_by: 'inspired by',
    merged_into: 'merged into', mentions: 'mentions',
  },
  op: { generate: 'Generate', refine: 'Refine', fuse: 'Fuse', classify: 'Classify', dedupe: 'Find duplicates', assistant: 'Assistant proposal' },
  proposalKind: { idea: 'New idea', rewrite: 'Rewrite', position: 'Move', merge: 'Merge' },
  wishKind: { unclear: 'Unclear UI', missing: 'Missing feature', broken: 'Broken', structure: 'Pool structure should change', other: 'Other' },
  wishStatus: { open: 'Open', accepted: 'Accepted', done: 'Done', declined: 'Declined', withdrawn: 'Withdrawn' },
  wishEvent: {
    recorded: 'Recorded', seen: 'Seen again', edited: 'Rewritten', withdrawn: 'Withdrawn', restored: 'Restored',
    status: 'Status changed', noted: 'Note', linked: 'Linked', claimed: 'Planning started', released: 'Released',
  },
  wishBy: { assistant: 'Assistant', human: 'You', review: 'Review', 'claude-code': 'Claude Code' },
  taskStatus: {
    todo: 'To start', planning: 'Planning', plan_ready: 'Plan awaiting approval', running: 'In progress',
    merged: 'Merged', failed: 'Failed', cancelled: 'Cancelled',
  },
  phase: {
    planning: 'Planning', plan_ready: 'Plan awaiting approval', running: 'Running', testing: 'Testing',
    pr: 'Opening PR, waiting for merge', merged: 'Merged', failed: 'Failed', cancelled: 'Cancelled', declined: 'Declined',
  },
} satisfies Record<string, Record<string, string>>

export type LabelGroup = keyof typeof EN

// label('en', 'status', 'pool', '在池') 是 "In pool"；中文界面原样返回后端的标签。
// label('en', 'status', 'pool', '在池') is "In pool"; the Chinese UI returns the server's label unchanged.
export function label(lang: Lang, group: LabelGroup, code: string | null | undefined, serverLabel: string | null | undefined): string {
  const fallback = serverLabel ?? code ?? ''
  if (lang !== 'en' || !code) return fallback
  return (EN[group] as Record<string, string>)[code] ?? fallback
}
